import fs from 'fs-extra';
import {createReadStream} from 'node:fs';
import {EOL} from 'node:os';
import {createInterface} from 'node:readline';

export const DEFAULT_SOURCE_READ_MAX_BYTES = 1_000_000;

export async function readTextFileUnderLimit(abs, {maxBytes = DEFAULT_SOURCE_READ_MAX_BYTES} = {}) {
    const stat = await fs.stat(abs);
    if(!stat.isFile()) {
        return {error: 'not_file', bytes: stat.size || 0};
    }
    if(Number.isFinite(maxBytes) && maxBytes > 0 && stat.size > maxBytes) {
        return {error: 'too_large', bytes: stat.size, maxBytes};
    }
    return {
        content: await fs.readFile(abs, 'utf8'),
        bytes: stat.size
    };
}

export async function readLineSlice(abs, {path, lineStart, lineEnd, maxLines, abortSignal} = {}) {
    throwIfAborted(abortSignal);
    const stat = await fs.stat(abs);
    if(stat.isDirectory()) {
        return {error: 'is_directory', path};
    }
    if(stat.size === 0) {
        return buildLineSliceResult({path, text: '', lineStart, lineEnd, maxLines});
    }

    const limit = normalizeMaxLines(maxLines);
    const start = Math.max(1, lineStart || 1);
    const requestedEnd = lineEnd || (start + limit - 1);
    const endLimit = Math.min(requestedEnd, start + limit - 1);
    const lines = [];
    let totalLines = 0;

    await scanTextFileLines(abs, {
        abortSignal,
        onLine(line, lineNumber) {
            totalLines = lineNumber;
            if(lineNumber >= start && lineNumber <= endLimit) {
                lines.push(line);
            }
        }
    });

    return buildLineSliceResult({path, lines, totalLines, lineStart: start, lineEnd: endLimit, maxLines: limit});
}

export function buildLineSliceResult({path, text, lines, totalLines, lineStart, lineEnd, maxLines}) {
    const allLines = lines || String(text || '').split(/\r?\n/);
    const lineCount = Number.isFinite(totalLines) ? totalLines : allLines.length;
    const limit = normalizeMaxLines(maxLines);
    const start = Math.max(1, lineStart || 1);
    const requestedEnd = lineEnd || (start + limit - 1);
    const endLimit = Math.min(lineCount, requestedEnd, start + limit - 1);
    const visible = lines ? allLines : allLines.slice(start - 1, endLimit);
    const end = visible.length > 0 ? start + visible.length - 1 : Math.min(Math.max(start - 1, 0), lineCount);
    const gutterWidth = String(Math.max(end, start)).length;
    const numbered = visible.map((line, i) => `${String(start + i).padStart(gutterWidth, ' ')}  ${line}`).join(EOL);

    return {
        path,
        totalLines: lineCount,
        lineStart: start,
        lineEnd: end,
        truncated: end < lineCount,
        content: numbered
    };
}

export async function scanTextFileLines(abs, {onLine, abortSignal} = {}) {
    throwIfAborted(abortSignal);
    const stream = createReadStream(abs, {encoding: 'utf8'});
    const onAbort = () => stream.destroy(abortError());
    abortSignal?.addEventListener?.('abort', onAbort, {once: true});
    let lineNumber = 0;

    try {
        const reader = createInterface({input: stream, crlfDelay: Infinity});
        for await (const line of reader) {
            throwIfAborted(abortSignal);
            lineNumber++;
            const keepGoing = await onLine?.(line, lineNumber);
            if(keepGoing === false) {
                break;
            }
        }
    } finally {
        abortSignal?.removeEventListener?.('abort', onAbort);
        stream.destroy();
    }

    return {totalLines: lineNumber};
}

export function throwIfAborted(signal) {
    if(!signal?.aborted) {
        return;
    }
    throw abortError();
}

function abortError() {
    const error = new Error('aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

function normalizeMaxLines(value) {
    return Math.max(1, Math.trunc(Number(value)) || 1);
}

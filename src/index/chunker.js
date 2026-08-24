import {EOL} from 'node:os';
import {config} from '../util/config.js';
import {isTreeSitterSupportedContext, syntaxChunksForText} from '../util/source-syntax.js';
import {isRepoArtifactPath, isRepoSupportingPath} from '../language-integrations/registry.js';

// Split a file's content into chunks suitable for embedding.
// Returns array of {lineStart, lineEnd, content}.
//
export const CHUNKER_VERSION = '2';
export const MAX_CHUNK_CHARS = 20000;
export const CHUNK_CHAR_OVERLAP = 400;

export async function chunkFile(content, context = {}) {
    const text = String(content || '');
    const lines = text.split(/\r?\n/);
    const {smallFileLines, windowLines, windowOverlap} = config.chunker;

    // Language support is a static corpus decision; parser availability is only
    // an enhancement. A supported source file must never disappear because
    // tree-sitter timed out, could not load, or declined an oversized input.
    // Supporting artifacts remain plain-text windowed as before.
    //
    if(!isTreeSitterSupportedContext(context)) {
        if(isRepoArtifactPath(context.path) || isRepoSupportingPath(context.path)) {
            return splitLargeChunks(windowTextLines(lines));
        }
        return [];
    }

    if(lines.length <= smallFileLines) {
        return splitLargeChunks([{
            lineStart: 1,
            lineEnd: lines.length,
            content: lines.join(EOL)
        }]);
    }

    const syntaxChunks = await syntaxChunksForText(text, context, {
        targetLines: windowLines,
        overlapLines: windowOverlap,
        maxChars: MAX_CHUNK_CHARS
    });
    if(syntaxChunks.length > 0) {
        return splitLargeChunks(syntaxChunks);
    }

    const chunks = [];
    const stride = Math.max(1, windowLines - windowOverlap);
    let cursor = 0;

    while(cursor < lines.length) {
        const startIdx = cursor;
        const endIdx = Math.min(lines.length, cursor + windowLines);
        chunks.push({
            lineStart: startIdx + 1,
            lineEnd: endIdx,
            content: lines.slice(startIdx, endIdx).join(EOL)
        });
        if(endIdx >= lines.length) {
            break;
        }
        cursor += stride;
    }

    return splitLargeChunks(chunks);
}

function windowTextLines(lines) {
    const {windowLines, windowOverlap} = config.chunker;
    if(lines.length <= config.chunker.smallFileLines) {
        return [{
            lineStart: 1,
            lineEnd: lines.length,
            content: lines.join(EOL)
        }];
    }
    const chunks = [];
    const stride = Math.max(1, windowLines - windowOverlap);
    let cursor = 0;
    while(cursor < lines.length) {
        const end = Math.min(lines.length, cursor + windowLines);
        chunks.push({
            lineStart: cursor + 1,
            lineEnd: end,
            content: lines.slice(cursor, end).join(EOL)
        });
        if(end >= lines.length) {
            break;
        }
        cursor += stride;
    }
    return chunks;
}

function splitLargeChunks(chunks) {
    const out = [];
    const stride = Math.max(1, MAX_CHUNK_CHARS - CHUNK_CHAR_OVERLAP);

    for(const chunk of chunks) {
        const content = String(chunk?.content || '');
        if(content.length <= MAX_CHUNK_CHARS) {
            out.push(chunk);
            continue;
        }

        out.push(...splitLargeChunkByLine(chunk, stride));
    }

    return out;
}

function splitLargeChunkByLine(chunk, stride) {
    const lines = String(chunk?.content || '').split(/\r?\n/);
    const out = [];
    let cursor = 0;

    while(cursor < lines.length) {
        const lineNo = chunk.lineStart + cursor;
        const firstLine = lines[cursor] || '';

        if(firstLine.length > MAX_CHUNK_CHARS) {
            for(let i = 0; i < firstLine.length; i += stride) {
                out.push({
                    lineStart: lineNo,
                    lineEnd: lineNo,
                    content: firstLine.slice(i, i + MAX_CHUNK_CHARS),
                    syntax: chunk.syntax || null
                });
                if(i + MAX_CHUNK_CHARS >= firstLine.length) {
                    break;
                }
            }
            cursor += 1;
            continue;
        }

        let end = cursor;
        let chars = 0;
        while(end < lines.length) {
            const line = lines[end] || '';
            const added = line.length + (end > cursor ? EOL.length : 0);
            if(end > cursor && chars + added > MAX_CHUNK_CHARS) {
                break;
            }
            chars += added;
            end += 1;
        }

        out.push({
            lineStart: chunk.lineStart + cursor,
            lineEnd: chunk.lineStart + end - 1,
            content: lines.slice(cursor, end).join(EOL),
            syntax: chunk.syntax || null
        });

        if(end >= lines.length) {
            break;
        }
        cursor = overlapStartIndex(lines, cursor, end);
    }

    return out;
}

function overlapStartIndex(lines, start, end) {
    if(CHUNK_CHAR_OVERLAP <= 0 || end <= start + 1) {
        return end;
    }
    let chars = 0;
    let index = end;
    while(index > start) {
        const line = lines[index - 1] || '';
        const added = line.length + (index < end ? EOL.length : 0);
        if(chars > 0 && chars + added > CHUNK_CHAR_OVERLAP) {
            break;
        }
        chars += added;
        index -= 1;
    }
    return Math.max(start + 1, Math.min(end, index));
}

import {Buffer} from 'node:buffer';
import {collectDependencyDocs, isVirtualDependencyPath} from '../index/dependency-docs.js';
import {createSourceCorpusPolicy} from '../index/source-corpus-policy.js';
import {normalizeSourcePath} from '../util/source-path.js';
import {decodeBase64UrlUtf8, sourcePathSchema} from '../util/input-schemas.js';
import {readTextFileUnderLimit} from '../util/source-read.js';

const DEFAULT_SOURCE_FILE_MAX_BYTES = 1_000_000;

export function createSourceFileService({targetRoot, indexExclude, repoIgnore, routeLogger, maxBytes = DEFAULT_SOURCE_FILE_MAX_BYTES}) {
    const sourcePolicy = createSourceCorpusPolicy({root: targetRoot, exclude: indexExclude, repoIgnore});
    const readPhysicalSource = (relPath, options = {}) => readSource(relPath, {
        targetRoot,
        sourcePolicy,
        repoIgnore,
        maxBytes: options.maxBytes || maxBytes
    });
    return {
        decodeSourcePathToken,
        readPhysicalSource,
        serveSourceFile: (c, relPath) => serveSourceFile(c, normalizeSourcePath(relPath), {
            readPhysicalSource,
            routeLogger,
            maxBytes
        })
    };
}

function decodeSourcePathToken(token) {
    return decodeBase64UrlUtf8(token);
}

async function serveSourceFile(c, relPath, {readPhysicalSource, routeLogger, maxBytes}) {
    const requestLog = routeLogger(c);
    if(!relPath) {
        requestLog.warn('source read missing path');
        return c.text('missing_path', 400);
    }
    const parsed = sourcePathSchema.safeParse(relPath);
    if(!parsed.success) {
        requestLog.warn({path: relPath}, 'source read rejected for path escape');
        return c.text('path_escape', 400);
    }
    relPath = parsed.data;

    try {
        const source = await readPhysicalSource(relPath, {maxBytes});
        if(source.error === 'path_escape') {
            requestLog.warn({path: relPath}, 'source read rejected for path escape');
            return c.text(source.error, 400);
        }
        if(source.error === 'path_excluded' || source.error === 'symlink_excluded') {
            requestLog.warn({path: relPath}, 'source read rejected by index exclude policy');
            return c.text(source.error, 403);
        }
        if(source.error === 'not_found' || source.error === 'not_file') {
            return c.text(source.error, 404);
        }
        if(source.error === 'too_large') {
            return c.text(`too_large:${source.maxBytes || maxBytes}`, 413);
        }
        if(source.error) {
            return c.text(source.error, 500);
        }
        requestLog.debug({path: relPath, bytes: source.bytes}, 'source file loaded');
        return c.body(source.content, 200, {
            'content-type': 'text/plain; charset=utf-8',
            'x-source-path': relPath,
            'x-source-bytes': String(source.bytes)
        });
    } catch(err) {
        requestLog.warn({path: relPath, err}, 'source file read failed');
        return c.text('read_failed', 500);
    }
}

async function readSource(relPath, {targetRoot, sourcePolicy, repoIgnore, maxBytes}) {
    const parsed = sourcePathSchema.safeParse(relPath);
    if(!parsed.success) {
        return {error: 'path_escape'};
    }
    relPath = parsed.data;

    if(isVirtualDependencyPath(relPath)) {
        return readVirtualDependencySource(relPath, {targetRoot, repoIgnore, maxBytes});
    }

    const checked = await sourcePolicy.checkPath(relPath);
    if(!checked.ok) {
        return {error: 'path_excluded'};
    }

    const physical = await sourcePolicy.resolvePhysicalPath(checked.path);
    if(!physical.ok) {
        return {error: physical.reason};
    }
    return readTextFileUnderLimit(physical.path, {maxBytes});
}

async function readVirtualDependencySource(relPath, {targetRoot, repoIgnore, maxBytes}) {
    const docs = await collectDependencyDocs({root: targetRoot, repoIgnore});
    const doc = docs.find((item) => item.path === relPath);
    if(!doc) {
        return {error: 'not_found'};
    }
    const content = String(doc.content || '');
    const bytes = Buffer.byteLength(content, 'utf8');
    if(Number.isFinite(maxBytes) && maxBytes > 0 && bytes > maxBytes) {
        return {error: 'too_large', bytes, maxBytes};
    }
    return {
        content,
        bytes
    };
}

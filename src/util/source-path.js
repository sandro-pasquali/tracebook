import fs from 'node:fs/promises';
import path from 'node:path';

export function normalizeSourcePath(value) {
    return String(value || '').trim().replace(/^\.\//, '').replace(/\\/g, '/');
}

export function resolveSafePath(root, relPath) {
    const resolvedRoot = path.resolve(root);
    const abs = path.resolve(resolvedRoot, relPath);
    const normRoot = resolvedRoot + path.sep;
    if(abs !== resolvedRoot && !abs.startsWith(normRoot)) {
        return null;
    }
    return abs;
}

// Build one canonical repository-path resolver and reuse it for every physical
// source access. resolveSafePath above prevents lexical `..` escapes, but the
// filesystem can redirect an apparently-contained path through a symlink. The
// index scanner already refuses to follow symlinks; source tools, previews, and
// incremental indexing must enforce the same boundary.
//
// The configured repository root itself may be reached through a symlink (a
// perfectly normal way to mount a checkout), so it is canonicalized once and
// trusted as the boundary. Symlinks *below* that root are rejected, including an
// intermediate directory symlink, before any caller opens the target.
//
export function createRepositoryPathResolver(root) {
    const lexicalRoot = path.resolve(root);
    let canonicalRootPromise = null;

    async function canonicalRoot() {
        canonicalRootPromise ||= fs.realpath(lexicalRoot);
        return canonicalRootPromise;
    }

    return async (relPath) => {
        const lexicalPath = resolveSafePath(lexicalRoot, relPath);
        if(!lexicalPath) {
            return {ok: false, reason: 'path_escape'};
        }

        const relative = path.relative(lexicalRoot, lexicalPath);
        const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
        let cursor = lexicalRoot;
        try {
            for(const segment of segments) {
                cursor = path.join(cursor, segment);
                const stat = await fs.lstat(cursor);
                if(stat.isSymbolicLink()) {
                    return {ok: false, reason: 'symlink_excluded'};
                }
            }

            const [resolvedRoot, resolvedPath] = await Promise.all([
                canonicalRoot(),
                fs.realpath(lexicalPath)
            ]);
            if(!pathContainedBy(resolvedRoot, resolvedPath)) {
                return {ok: false, reason: 'path_escape'};
            }
            return {ok: true, path: resolvedPath};
        } catch(err) {
            if(err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
                return {ok: false, reason: 'not_found'};
            }
            throw err;
        }
    };
}

function pathContainedBy(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

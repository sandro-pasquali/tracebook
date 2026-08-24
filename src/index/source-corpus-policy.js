import fg from 'fast-glob';
import {sourcePathExcludedByIntegration} from '../language-integrations/registry.js';
import {pathExcluded} from '../util/path-filter.js';
import {createRepoIgnore, normalizeRepoPath} from '../util/repo-ignore.js';
import {createRepositoryPathResolver} from '../util/source-path.js';
import {DEFAULT_INDEX_EXCLUDE, DEFAULT_INDEX_INCLUDE, effectiveIndexExclude} from './file-patterns.js';

export function createSourceCorpusPolicy({root, include = DEFAULT_INDEX_INCLUDE, exclude = DEFAULT_INDEX_EXCLUDE, repoIgnore = null} = {}) {
    if(!root) {
        throw new Error('createSourceCorpusPolicy requires {root}');
    }

    const includeGlob = Array.isArray(include) && include.length > 0 ? include : DEFAULT_INDEX_INCLUDE;
    const excludeGlob = effectiveIndexExclude(exclude || DEFAULT_INDEX_EXCLUDE);
    const ignore = repoIgnore || createRepoIgnore({root});
    const resolveRepositoryPath = createRepositoryPathResolver(root);

    function normalize(rel) {
        return normalizeRepoPath(rel);
    }

    function checkHardPath(rel, {isDirectory = false} = {}) {
        const normalized = normalize(rel);
        if(!normalized) {
            return {ok: false, reason: 'path_escape', path: String(rel || '')};
        }
        if(pathExcluded(normalized, excludeGlob)) {
            return {ok: false, reason: 'path_excluded', path: normalized};
        }
        if(sourcePathExcludedByIntegration(normalized, {isDirectory})) {
            return {ok: false, reason: 'source_type_excluded', path: normalized};
        }
        return {ok: true, path: normalized};
    }

    async function checkPath(rel, {isDirectory = false} = {}) {
        const checked = checkHardPath(rel, {isDirectory});
        if(!checked.ok) {
            return checked;
        }
        if(await ignore.isIgnored(checked.path, {isDirectory})) {
            return {ok: false, reason: 'repo_ignored', path: checked.path};
        }
        return checked;
    }

    async function filterVisiblePaths(paths, {sort = false} = {}) {
        const candidates = [];
        for(const rel of paths || []) {
            const checked = checkHardPath(rel);
            if(checked.ok) {
                candidates.push(checked.path);
            }
        }
        const visible = await ignore.filter(candidates);
        return sort ? visible.sort() : visible;
    }

    async function listIndexableFiles() {
        const entries = await fg(includeGlob, {
            cwd: root,
            ignore: excludeGlob,
            onlyFiles: true,
            followSymbolicLinks: false,
            dot: true
        });
        return filterVisiblePaths(entries, {sort: true});
    }

    function matchesWatchPath(rel) {
        return checkHardPath(rel).ok;
    }

    async function resolvePhysicalPath(rel) {
        const normalized = normalize(rel);
        return normalized ? resolveRepositoryPath(normalized) : {ok: false, reason: 'path_escape'};
    }

    return {
        includeGlob,
        excludeGlob,
        repoIgnore: ignore,
        normalize,
        checkHardPath,
        checkPath,
        filterVisiblePaths,
        listIndexableFiles,
        matchesWatchPath,
        resolvePhysicalPath
    };
}

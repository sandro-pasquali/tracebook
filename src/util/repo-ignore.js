import path from 'node:path';
import fg from 'fast-glob';
import fs from 'fs-extra';
import createIgnore from 'ignore';
import {DEFAULT_IGNORE_RULES} from '../index/default-ignore.js';

// Gitignore-syntax files honored when scanning a target repo. `.tracebookignore` is
// our own convention: it lets a user exclude folders from indexing without touching
// `.gitignore` (git) or `.ignore`/`.rgignore`/`.fdignore` (ripgrep/fd).
//
export const DEFAULT_REPO_IGNORE_FILES = ['.gitignore', '.ignore', '.rgignore', '.fdignore', '.tracebookignore'];

const GIT_INFO_EXCLUDE = '.git/info/exclude';
const VIRTUAL_SOURCE_PREFIXES = ['__dependencies__/'];

export function createRepoIgnore({root, ignoreFiles = DEFAULT_REPO_IGNORE_FILES, baseRules = DEFAULT_IGNORE_RULES} = {}) {
    if(!root) {
        throw new Error('createRepoIgnore requires {root}');
    }

    const resolvedRoot = path.resolve(root);
    const cache = new Map();
    let ruleSets = null;

    async function isIgnored(rel, {isDirectory = false} = {}) {
        const normalized = normalizeRepoPath(rel);
        if(!normalized || normalized === '.' || isVirtualSourcePath(normalized)) {
            return false;
        }

        const key = cacheKey(normalized, isDirectory);
        if(cache.has(key)) {
            return cache.get(key);
        }

        const ignored = matchesRuleSets(normalized, await getRuleSets(), {isDirectory});
        cache.set(key, ignored);
        return ignored;
    }

    async function filter(paths) {
        const sets = await getRuleSets();
        return (paths || []).filter((rel) => {
            const repoPath = normalizeRepoPath(rel);
            if(!repoPath || isVirtualSourcePath(repoPath)) {
                return false;
            }

            const key = cacheKey(repoPath, false);
            if(!cache.has(key)) {
                cache.set(key, matchesRuleSets(repoPath, sets));
            }
            return !cache.get(key);
        });
    }

    async function getRuleSets() {
        ruleSets ||= loadRuleSets(resolvedRoot, ignoreFiles, baseRules);
        return ruleSets;
    }

    function clear() {
        cache.clear();
        ruleSets = null;
    }

    return {isIgnored, filter, clear};
}

export function normalizeRepoPath(value) {
    const input = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if(!input || input.includes('\0')) {
        return null;
    }

    const normalized = path.posix.normalize(input).replace(/\/+$/, '');
    if(!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
        return normalized === '.' ? '.' : null;
    }
    return normalized;
}

async function loadRuleSets(root, ignoreFiles, baseRules = []) {
    const ignoreFileNames = Array.from(new Set(ignoreFiles.filter(Boolean)));
    const patterns = ignoreFileNames.map((name) => `**/${name}`);
    const files = patterns.length === 0
        ? []
        : await fg(patterns, {
            cwd: root,
            ignore: ['**/.git/**'],
            onlyFiles: true,
            followSymbolicLinks: false,
            dot: true
        });

    if(await fs.pathExists(path.join(root, GIT_INFO_EXCLUDE))) {
        files.push(GIT_INFO_EXCLUDE);
    }

    const sets = [];
    // Built-in default ignores are the lowest-precedence ruleset: a repo's own
    // ignore files (loaded after) — and their `!negation` rules — override them.
    //
    if(Array.isArray(baseRules) && baseRules.length > 0) {
        const baseMatcher = createIgnore();
        baseMatcher.add(baseRules);
        sets.push({base: '', matcher: baseMatcher});
    }
    for(const rel of files.sort(compareIgnoreFileOrder)) {
        const base = baseForIgnoreFile(rel);
        if(base && matchesRuleSets(base, sets, {isDirectory: true})) {
            continue;
        }

        const matcher = await readIgnoreMatcher(root, rel);
        if(matcher) {
            sets.push({base, matcher});
        }
    }
    return sets;
}

function baseForIgnoreFile(rel) {
    if(rel === GIT_INFO_EXCLUDE) {
        return '';
    }

    const dir = path.dirname(rel).replace(/\\/g, '/');
    return dir === '.' ? '' : dir;
}

async function readIgnoreMatcher(root, rel) {
    let text = '';
    try {
        text = await fs.readFile(path.join(root, rel), 'utf8');
    } catch {
        return null;
    }

    const matcher = createIgnore();
    try {
        matcher.add(text);
    } catch {
        return null;
    }
    return matcher;
}

function matchesRuleSets(rel, sets, {isDirectory = false} = {}) {
    let ignored = false;
    for(const {base, matcher} of sets) {
        const local = localPathForRuleSet(rel, base);
        if(!local) {
            continue;
        }

        const result = matcher.test(isDirectory ? `${local}/` : local);
        if(result.ignored) {
            ignored = true;
        } else if(result.unignored) {
            ignored = false;
        }
    }
    return ignored;
}

function localPathForRuleSet(rel, base) {
    if(!base) {
        return rel;
    }
    if(rel === base) {
        return '';
    }
    return rel.startsWith(`${base}/`) ? rel.slice(base.length + 1) : '';
}

function compareIgnoreFileOrder(a, b) {
    const depth = a.split('/').length - b.split('/').length;
    return depth || a.localeCompare(b);
}

function isVirtualSourcePath(rel) {
    return VIRTUAL_SOURCE_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function cacheKey(rel, isDirectory) {
    return `${isDirectory ? 'dir' : 'file'}:${rel}`;
}

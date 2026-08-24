// Lightweight path-vs-glob-pattern filter. Supports the small subset of
// patterns this project uses for INDEX_EXCLUDE: `prefix/**`, `**/segment/**`,
// `**/*.ext`, `*.ext`, and exact matches. Good enough that tools (grep,
// read_file) can respect the same rules the indexer uses, without pulling in
// micromatch.
//
export function pathExcluded(rel, patterns) {
    if(!Array.isArray(patterns) || patterns.length === 0) return false;
    const p = String(rel).replace(/^\.\//, '').replace(/\\/g, '/');
    for(const pat of patterns) {
        if(matches(p, pat)) return true;
    }
    return false;
}

function matches(path, pattern) {
    if(!pattern) return false;

    if(pattern === path) return true;

    if(pattern.startsWith('**/') && pattern.endsWith('/**') && !hasGlob(pattern.slice(3, -3))) {
        const seg = pattern.slice(3, -3);
        return path === seg || path.startsWith(seg + '/') || path.includes('/' + seg + '/') || path.endsWith('/' + seg);
    }
    if(pattern.endsWith('/**') && !hasGlob(pattern.slice(0, -3))) {
        const prefix = pattern.slice(0, -3);
        return path === prefix || path.startsWith(prefix + '/');
    }
    if(pattern.startsWith('**/') && !hasGlob(pattern.slice(3))) {
        const suffix = pattern.slice(3);
        return path === suffix || path.endsWith('/' + suffix);
    }
    if(pattern.startsWith('**/') && hasGlob(pattern.slice(3))) {
        return globLike(pattern).test(path) || globLike(pattern.slice(3)).test(path);
    }
    if(pattern.startsWith('*.')) {
        return path.endsWith(pattern.slice(1));
    }
    if(pattern.includes('*') || pattern.includes('?')) {
        return globLike(pattern).test(path);
    }

    return false;
}

function hasGlob(pattern) {
    return String(pattern).includes('*') || String(pattern).includes('?');
}

const globRegexCache = new Map();

function globLike(pattern) {
    const cached = globRegexCache.get(pattern);
    if(cached) {
        return cached;
    }
    const escaped = String(pattern)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0000/g, '.*');
    const regex = new RegExp(`^${escaped}$`);
    globRegexCache.set(pattern, regex);
    return regex;
}

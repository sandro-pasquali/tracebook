import {isRepoSupportingPath, repoProfilesForQuestion, resolveLanguageIntegration} from '../language-integrations/registry.js';

// Shared retrieval plumbing used by both the hybrid search tool
// (src/tools/search.js) and the planner evidence layer (src/planner/evidence.js,
// evidence-policy.js). These are the mechanically-identical helpers both sides had
// copied; the tuned scoring weights and the per-mechanism tokenizers deliberately
// stay in their own files. This module imports only from the language-integrations
// registry, so it sits below both mechanisms with no import cycle.
//

// Split an identifier into parts: break camelCase boundaries, then split on any
// non-alphanumeric run. With {lowerCase} the parts are lowercased — the index-time
// embedding text needs that, while query-side callers keep the original case.
//
export function splitIdentifier(value, {lowerCase = false} = {}) {
    const parts = String(value || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean);
    return lowerCase ? parts.map((part) => part.toLowerCase()) : parts;
}

// Collapse a path's language family into the two UI-surface buckets retrieval
// cares about: 'markup' (markup/template) and 'style' (css). Everything else is ''.
//
export function sourceFamilyForPath(path) {
    const family = resolveLanguageIntegration({path})?.family;
    if(family === 'markup' || family === 'template') {
        return 'markup';
    }
    if(family === 'css') {
        return 'style';
    }
    return '';
}

// Whether a path is supporting evidence (dependency docs or repo-supporting files
// like manifests/configs) rather than primary source.
//
export function isSupportingEvidencePath(path) {
    const p = String(path || '');
    if(p.startsWith('__dependencies__/')) {
        return true;
    }
    return isRepoSupportingPath(p);
}

// Generic first-seen deduplication by a caller-supplied key. Preserves input order.
//
export function dedupeBy(items, keyFn) {
    const seen = new Set();
    const out = [];
    for(const item of items || []) {
        const key = keyFn(item);
        if(seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(item);
    }
    return out;
}

// Two-phase path-diverse selection: first take one item per path in score order,
// then fill remaining slots with whatever is left.
//
export function selectPathDiverse(items, limit) {
    if(limit <= 0) {
        return [];
    }
    const selected = [];
    const seenPaths = new Set();
    for(const item of items) {
        if(seenPaths.has(item.path)) {
            continue;
        }
        selected.push(item);
        seenPaths.add(item.path);
        if(selected.length >= limit) {
            return selected;
        }
    }
    for(const item of items) {
        if(selected.includes(item)) {
            continue;
        }
        selected.push(item);
        if(selected.length >= limit) {
            break;
        }
    }
    return selected;
}

// Build the repo-profile context for a question: the matched profiles plus sets of
// their ids/families/categories/terms. The term normalizer and the order the term
// arrays are concatenated are both caller-controlled — search normalizes via
// normalizeSearchToken and its term order feeds an order-sensitive slice in
// graphSearchTerms, while the evidence layer lowercases and uses a different order.
//
export function buildRepoContext(question, {
    normalize = (term) => String(term || '').toLowerCase(),
    termOrder = ['matchedTerms', 'evidenceTerms', 'questionTerms']
} = {}) {
    const profiles = repoProfilesForQuestion(question);
    return {
        profiles,
        ids: new Set(profiles.map((profile) => profile.id)),
        families: new Set(profiles.map((profile) => profile.family).filter(Boolean)),
        categories: new Set(profiles.map((profile) => profile.category).filter(Boolean)),
        terms: new Set(profiles
            .flatMap((profile) => termOrder.flatMap((key) => profile[key] || []))
            .map(normalize)
            .filter(Boolean))
    };
}

// Clip text to a character budget on whole-line boundaries. Returns the clipped
// content and whether truncation occurred; callers derive their own line numbers
// from the result. A single first line that already exceeds the budget is hard-cut
// with an ellipsis.
//
export function clipToLineBudget(text, maxChars) {
    const value = String(text || '');
    const max = Math.max(0, Number(maxChars) || 0);
    if(!max || value.length <= max) {
        return {content: value, truncated: false};
    }

    const lines = value.split(/\r?\n/);
    const visible = [];
    let chars = 0;

    for(const line of lines) {
        const added = line.length + (visible.length > 0 ? 1 : 0);
        if(visible.length > 0 && chars + added > max) {
            break;
        }
        if(visible.length === 0 && added > max) {
            visible.push(`${line.slice(0, Math.max(0, max - 1))}…`);
            break;
        }
        visible.push(line);
        chars += added;
    }

    return {content: visible.join('\n'), truncated: true};
}

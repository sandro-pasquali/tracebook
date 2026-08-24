// Normalize a stored source-fingerprint map ({path: {hash, status}}) to a
// predictable shape, dropping malformed entries. Callers can supply a key
// normalizer (e.g. source-path normalization); entries whose key normalizes
// to a falsy value are dropped.
//
export function normalizeSourceFingerprints(value, {normalizeKey = null} = {}) {
    if(!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    const out = {};
    for(const [rawPath, entry] of Object.entries(value)) {
        const key = normalizeKey ? normalizeKey(rawPath) : String(rawPath || '').trim();
        if(!key || !entry || typeof entry !== 'object') {
            continue;
        }
        out[key] = {
            hash: String(entry.hash || '').trim() || null,
            status: String(entry.status || '').trim() || 'unknown'
        };
    }
    return out;
}

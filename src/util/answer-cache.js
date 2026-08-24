import crypto from 'node:crypto';
import {config} from './config.js';
import {compactReplayEvents} from './replay-events.js';

// Per-process hot cache of question → SSE event log for the answer.
// Lookups are keyed by sha1(question). On hit, replay the stored event stream
// directly — no LLM calls, no vector lookups, sub-second response.
//
// This is the in-memory tier above the disk-persisted trace store
// (`~/.tracebook/data/repos/<repo-hash>/traces/`). When this evicts an entry,
// the source-of-truth on disk is untouched, so the answer is recoverable via
// /api/traces/:id replay if needed.
//
export function createAnswerCache({ttlMs = config.answerCache.ttlMs, cap = config.answerCache.cap} = {}) {
    const entries = new Map();

    function keyFor(question) {
        return crypto.createHash('sha1').update(String(question || ''), 'utf8').digest('hex');
    }

    function isFresh(entry) {
        if(!entry) return false;
        if(ttlMs <= 0) return true;
        return Date.now() - entry.savedAt < ttlMs;
    }

    function get(question, {sourceRevision} = {}) {
        const key = keyFor(question);
        const entry = entries.get(key);
        if(!entry) return null;
        if(!isFresh(entry)) {
            entries.delete(key);
            return null;
        }
        if(!matchesSourceRevision(entry.sourceRevision, sourceRevision)) {
            entries.delete(key);
            return null;
        }
        // Bump recency.
        //
        entries.delete(key);
        entries.set(key, entry);
        return entry;
    }

    function set(question, events, {sourceRevision} = {}) {
        if(!question || !Array.isArray(events) || events.length === 0) {
            return;
        }
        // No revision means the index is mid-rebuild: the answer may be built on
        // partial evidence, and an entry saved against no revision could never be
        // served anyway (get() requires a current revision to match). Skip the
        // write rather than let a poisoned entry evict a live one.
        //
        if(normalizeRevision(sourceRevision) === null) {
            return;
        }
        const key = keyFor(question);
        if(entries.has(key)) {
            entries.delete(key);
        }
        entries.set(key, {events: compactReplayEvents(events), savedAt: Date.now(), sourceRevision: normalizeRevision(sourceRevision)});
        while(entries.size > cap) {
            const oldest = entries.keys().next().value;
            entries.delete(oldest);
        }
    }

    function snapshot() {
        return {size: entries.size, cap, ttlMs};
    }

    return {get, set, snapshot};
}

function matchesSourceRevision(savedRevision, currentRevision) {
    const current = normalizeRevision(currentRevision);
    if(current === null) {
        return false;
    }
    return normalizeRevision(savedRevision) === current;
}

function normalizeRevision(value) {
    const s = String(value ?? '').trim();
    return s ? s : null;
}

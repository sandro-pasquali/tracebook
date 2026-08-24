import crypto from 'node:crypto';
import {config} from '../util/config.js';

const TTL_MS = config.traces.ttlDays * 24 * 60 * 60 * 1000;

// Persist a completed Trace as a row in the trace index so future questions
// can find similar prior answers (the "learning loop"). One embedding per
// trace — combining the question with the first narrative item produces a
// compact, search-friendly summary.
//
export function createTraceIndexer({store, embedder}) {
    if(!store || !embedder) {
        throw new Error('createTraceIndexer requires {store, embedder}');
    }

    async function persistTrace({traceId, question, trace, timestamp} = {}) {
        if(!traceId || !question || !trace) {
            return null;
        }
        const narrative = Array.isArray(trace.narrative) ? trace.narrative : [];
        const components = Array.isArray(trace.components) ? trace.components : [];
        const summary = narrative[0] || trace.title || '';
        const componentKinds = components.map((c) => c?.type).filter(Boolean);

        const embedText = `${question}\n${summary}`;
        const [embedding] = await embedder.embed([embedText], {type: 'document'});

        const questionHash = crypto.createHash('sha1').update(question, 'utf8').digest('hex');
        const ts = timestamp || Date.now();

        await store.upsertTrace({
            traceId,
            questionHash,
            question,
            summary,
            componentKinds,
            timestamp: ts,
            embedding
        });

        return {traceId, questionHash, timestamp: ts};
    }

    // Look up traces relevant to a question. Caller passes the embedded query
    // (typically reusing the cached query embedding to avoid a fresh API call).
    //
    async function findSimilar({questionEmbedding, limit = 3}) {
        if(!questionEmbedding) {
            return [];
        }
        const minTimestamp = TTL_MS > 0 ? Date.now() - TTL_MS : 0;
        const rows = await store.searchTraces(questionEmbedding, limit, {minTimestamp});
        return rows;
    }

    // Convenience wrapper: embed the query, then findSimilar. Cheap when
    // the embedder has an LRU cache and the query has been embedded already.
    //
    async function findSimilarByQuery(query, {limit = 3} = {}) {
        if(!query) {
            return [];
        }
        const [embedding] = await embedder.embed([query], {type: 'query'});
        return findSimilar({questionEmbedding: embedding, limit});
    }

    async function prune() {
        if(TTL_MS <= 0) {
            return 0;
        }
        const cutoff = Date.now() - TTL_MS;
        return store.pruneTracesOlderThan(cutoff);
    }

    return {persistTrace, findSimilar, findSimilarByQuery, prune};
}

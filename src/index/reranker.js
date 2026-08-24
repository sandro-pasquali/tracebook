import '../util/models-dir.js';
import os from 'node:os';
import {AutoModelForSequenceClassification, AutoTokenizer} from '@huggingface/transformers';
import {config} from '../util/config.js';
import {resolveModelThreads} from '../util/model-threads.js';

// Local cross-encoder reranker. Scores (query, candidate-content) pairs with a
// small sequence-classification model and reorders the top-N candidates by true
// query↔code relevance — the lever aimed at ranking quality, where dense
// similarity + lexical fusion are weakest. Lazy single-load (like the embedder);
// only the top-N (default 20) candidates are scored, so per-query cost and memory
// stay bounded. Returns null when disabled so callers simply skip reranking.
//
export function createReranker({
    model,
    dtype = 'q8',
    candidates = 20,
    enabled = true,
    numThreads = config.rerank.numThreads,
    tokenizerLoader = (m, opts) => AutoTokenizer.from_pretrained(m, opts),
    modelLoader = (m, opts) => AutoModelForSequenceClassification.from_pretrained(m, opts),
    onProgress,
    log,
    onDegraded = null
} = {}) {
    if(!enabled || !model) {
        return null;
    }

    // Cap onnxruntime-node's intra-op thread pool the same way the embedder does, so
    // a query doesn't saturate every core (half cores, hard-capped at 8).
    //
    const threads = resolveModelThreads(numThreads, os.availableParallelism());

    let loadErrorLogged = false;
    let ready = null;
    async function load() {
        if(!ready) {
            ready = (async () => {
                const tokenizer = await tokenizerLoader(model, {progress_callback: onProgress});
                const sequenceModel = await modelLoader(model, {dtype, session_options: {intraOpNumThreads: threads}, progress_callback: onProgress});
                return {tokenizer, sequenceModel};
            })().catch((err) => {
                // Surface the real cause once (it was previously swallowed): a model
                // that fails to load here disables reranking silently. Reset so a
                // later call can retry. The caller (search) degrades gracefully.
                //
                ready = null;
                onDegraded?.({area: 'reranker', err});
                if(!loadErrorLogged) {
                    loadErrorLogged = true;
                    log?.warn?.({err, model, dtype}, 'reranker model failed to load; reranking disabled');
                }
                throw err;
            });
        }
        return ready;
    }

    // Reorder `rows` (already-ranked candidates) using the cross-encoder. Only the
    // first `candidates` are rescored. Rather than replacing the existing order
    // (which lets one mis-score drop a correct hit, and discards strong signals
    // like a file-name match), we BLEND: Reciprocal Rank Fusion of the incoming
    // order and the reranker order. An item that is strong in either ranking stays
    // high. Each row keeps its `score`/`similarity` (cosine) for downstream gating;
    // `rerankScore` is added for diagnostics.
    //
    async function rerank(queryText, rows) {
        const query = String(queryText || '');
        const top = Array.isArray(rows) ? rows.slice(0, candidates) : [];
        if(!query || top.length === 0) {
            return rows;
        }
        const {tokenizer, sequenceModel} = await load();
        const encoded = tokenizer(
            top.map(() => query),
            {text_pair: top.map((row) => String(row.content || '')), padding: true, truncation: true}
        );
        const {logits} = await sequenceModel(encoded);
        const scores = logits.tolist().map((row) => (Array.isArray(row) ? row[0] : row));

        const entries = top.map((row, originalRank) => ({row, originalRank, rerankScore: scores[originalRank]}));
        const rerankOrder = [...entries].sort((a, b) => b.rerankScore - a.rerankScore);
        const rerankRank = new Map(rerankOrder.map((entry, rank) => [entry, rank]));
        const K = 60;
        const fused = entries
            .map((entry) => ({
                ...entry.row,
                rerankScore: entry.rerankScore,
                fuse: (1 / (K + entry.originalRank + 1)) + (1 / (K + rerankRank.get(entry) + 1))
            }))
            .sort((a, b) => b.fuse - a.fuse);
        return [...fused, ...rows.slice(candidates)];
    }

    // Load the model (and JIT it with a tiny scoring pass) up front, so the first
    // real query doesn't pay the cold-load cost. Best-effort.
    //
    async function warmup() {
        try {
            await load();
            await rerank('warmup', [{path: 'warmup', content: 'warmup', lineStart: 1, lineEnd: 1}]);
        } catch {
            // A warm-up failure is non-fatal; rerank() retries lazily.
            //
        }
    }

    async function dispose() {
        if(!ready) {
            return;
        }
        const loaded = await ready.catch(() => null);
        ready = null;
        await loaded?.sequenceModel?.dispose?.();
        await loaded?.tokenizer?.dispose?.();
    }

    return {rerank, warmup, dispose};
}

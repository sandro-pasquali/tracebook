import {generateText} from 'ai';
import {runSearch} from '../../tools/search.js';
import {isSupportingEvidencePath} from '../../util/retrieval-core.js';
import {isSystemOverviewQuestion} from '../../util/retrieval-intent.js';
import {config} from '../../util/config.js';
import {resolveModel} from '../../util/model.js';
import {settleGovernorCall} from '../usage.js';
import {buildToolExchange} from './tool-message.js';
import {
    PREFETCH_LIMITS,
    buildEvidencePacket,
    buildEvidenceReadyEvent,
    summarizeToolInput,
    summarizeToolResult,
    withSharedEmbeddingTiming,
    wrapToolOutput
} from '../evidence.js';

// ───── Pre-fetch phase ─────
// Run a vector search synchronously before the LLM call and inject the result
// as a fake assistant tool-call + tool-result pair. The model often proceeds
// straight to read_file or synthesis instead of issuing the same search itself,
// saving one full LLM round-trip. In parallel, query the trace index for prior
// questions similar to this one so the learning loop can surface them.
//
// Yields the prefetch tool.call/result, optional HyDE timing, trace.similar, the
// prefetch timing checkpoint, and the prefetch-stage evidence.ready. Returns the
// computed prefetch state for the orchestrator to route on.
//
export async function* runPrefetch(ctx) {
    const {question, retrievalQuestion, tools, embedder, store, reranker, traceIndexer, precomputedSimilarTraces, corpusCoverage, governor, signal, timer, degraded} = ctx;

    const prefetchSpan = timer.span('prefetch');
    let prefetchResult = null;
    let similarTraces = [];
    const prefetchCallId = `prefetch_${Date.now().toString(36)}`;
    const prefetchLimit = PREFETCH_LIMITS.primary;
    const prefetchArgs = {query: retrievalQuestion, limit: prefetchLimit};
    try {
        yield {type: 'tool.call', tool: 'search_codebase', inputSummary: summarizeToolInput('search_codebase', prefetchArgs), prefetch: true};

        let queryEmbeddingDurationMs = 0;
        const queryEmbeddingPromise = (embedder && store)
            ? (async () => {
                const embeddingStart = Date.now();
                const embeds = await embedder.embed([retrievalQuestion], {type: 'query'});
                queryEmbeddingDurationMs = Date.now() - embeddingStart;
                return embeds[0];
            })()
            : Promise.resolve(null);

        const searchPromise = (embedder && store)
            ? queryEmbeddingPromise.then((embedding) => runSearch({
                queryText: retrievalQuestion,
                queryEmbedding: embedding,
                limit: prefetchLimit,
                embedder,
                store,
                includeSupport: true,
                supportLimit: PREFETCH_LIMITS.supportItems,
                reranker
            }))
            : tools?.search_codebase?.execute
                ? tools.search_codebase.execute(prefetchArgs, {})
                : Promise.resolve(null);

        const tracesPromise = Array.isArray(precomputedSimilarTraces)
            ? Promise.resolve(precomputedSimilarTraces)
            : traceIndexer
                ? queryEmbeddingPromise
                    .then((embedding) => embedding
                        ? traceIndexer.findSimilar({questionEmbedding: embedding, limit: 3})
                        : traceIndexer.findSimilarByQuery(retrievalQuestion, {limit: 3}))
                    .catch(() => [])
                : Promise.resolve([]);

        const [rawSearch, tracesOut] = await Promise.all([searchPromise, tracesPromise]);
        prefetchResult = withSharedEmbeddingTiming(rawSearch, queryEmbeddingDurationMs);
        similarTraces = Array.isArray(tracesOut) ? tracesOut : [];

        // HyDE is valuable when retrieval is weak, but it costs an extra LLM
        // call. Use the raw-query embedding first and only pay for HyDE when
        // the first pass did not produce a confident top match.
        //
        if(config.hyde.enabled && embedder && store && shouldAttemptHyde(prefetchResult)) {
            const hydeSpan = timer.span('hyde');
            const hydeText = await generateHypothetical({question: retrievalQuestion, signal, governor}).catch(() => null);
            const hydeMark = hydeSpan.end({hadText: !!hydeText});
            yield {
                type: 'timing.checkpoint',
                name: hydeMark.name,
                sinceStart: hydeMark.sinceStart,
                sinceLast: hydeMark.sinceLast,
                durationMs: hydeMark.durationMs,
                hadText: hydeMark.hadText
            };
            if(hydeText) {
                const hydeEmbeddingStart = Date.now();
                // HyDE produces a hypothetical answer (a pseudo-document), so embed it
                // on the document side to live in the same space as real chunks.
                //
                const [hydeEmbedding] = await embedder.embed([hydeText], {type: 'document'});
                const hydeEmbeddingMs = Date.now() - hydeEmbeddingStart;
                const hydeResult = withSharedEmbeddingTiming(await runSearch({
                    queryText: retrievalQuestion,
                    queryEmbedding: hydeEmbedding,
                    limit: prefetchLimit,
                    embedder,
                    store,
                    includeSupport: true,
                    supportLimit: PREFETCH_LIMITS.supportItems,
                    reranker
                }), hydeEmbeddingMs);
                prefetchResult = mergeSearchResults(prefetchResult, hydeResult, prefetchLimit);
            }
        }
        if(prefetchResult) {
            yield {
                type: 'tool.result',
                tool: 'search_codebase',
                summary: summarizeToolResult('search_codebase', prefetchResult),
                prefetch: true
            };
        }
        // Only surface past traces above the similarity floor — negative or
        // low-similarity matches add noise to the UI without helping the LLM.
        //
        const surfacedTraces = similarTraces.filter(
            (t) => typeof t.similarity === 'number' && t.similarity >= config.traces.similarMinSimilarity
        );
        if(surfacedTraces.length > 0) {
            yield {
                type: 'trace.similar',
                matches: surfacedTraces.map((t) => ({
                    traceId: t.traceId,
                    question: t.question,
                    summary: t.summary,
                    similarity: t.similarity === null ? null : Number(t.similarity.toFixed(4)),
                    componentKinds: t.componentKinds,
                    ageDays: t.timestamp > 0 ? Number(((Date.now() - t.timestamp) / 86400000).toFixed(1)) : null
                }))
            };
        }
    } catch(err) {
        // A client disconnect is not degradation — let it propagate so the run
        // stops. Anything else (store outage, dead embedder) degrades to a
        // prefetch-less run, but is counted and rate-limit-logged so it can
        // never masquerade as "no matches".
        //
        if(err?.name === 'AbortError' || signal?.aborted) {
            throw err;
        }
        degraded?.note({area: 'prefetch', err});
        prefetchResult = null;
    }
    const prefetchMark = prefetchSpan.end();
    yield {type: 'timing.checkpoint', name: prefetchMark.name, durationMs: prefetchMark.durationMs, sinceStart: prefetchMark.sinceStart, sinceLast: prefetchMark.sinceLast, similarTraceCount: similarTraces.length};

    const prefetchMessages = prefetchResult
        ? buildToolExchange({callId: prefetchCallId, input: prefetchArgs, output: wrapToolOutput(prefetchResult)})
        : [];

    const fastPath = isFastPathEligible({question, prefetchResult});
    const prefetchEvidencePacket = buildEvidencePacket({question: retrievalQuestion, displayQuestion: question, explorationMessages: prefetchMessages, corpusCoverage});
    if(prefetchEvidencePacket.items.length > 0) {
        yield buildEvidenceReadyEvent(prefetchEvidencePacket, {stage: 'prefetch'});
    }

    return {prefetchResult, similarTraces, prefetchMessages, fastPath, prefetchEvidencePacket};
}

// HyDE — Hypothetical Document Embedding. Generate a 1-sentence guess at the
// answer and embed THAT instead of the raw question. Code chunks read like
// declarative descriptions of what code does, so they match a hypothetical
// answer's vocabulary much more closely than they match a question's wording.
// Bounded by a timeout so a slow model never gates the request.
//
async function generateHypothetical({question, signal, governor}) {
    const reservation = governor ? await governor.beforeCall(80) : null;
    try {
        const racer = generateText({
            model: resolveModel(config.models.hyde),
            prompt: `Write a single short sentence (one line, under 25 words) that hypothesizes the answer to: "${question}". Describe the source you'd expect to find, in declarative form. Translate product terms into likely implementation evidence: UI may mean templates, styles, components, DOM events, handlers, network calls, routes, or server handlers; LLM may mean prompts, model calls, tool-call wiring, agents, or embeddings. No preamble, no "I would", just the sentence.`,
            maxOutputTokens: 80,
            temperature: 0.3,
            abortSignal: signal
        });
        let timeoutId;
        const timeout = new Promise((resolve) => {
            timeoutId = setTimeout(() => resolve(null), config.hyde.timeoutMs);
        });
        const result = await Promise.race([racer.then((r) => r), timeout]);
        clearTimeout(timeoutId);
        settleGovernorCall(governor, reservation, result?.usage);
        if(!result || !result.text) {
            return null;
        }
        return result.text.trim();
    } catch(err) {
        governor?.releaseCall?.(reservation);
        throw err;
    }
}

// Decide whether the pre-fetched evidence alone is sufficient to skip the
// exploration LLM call entirely. Conservative gate — only triggers on small
// questions with a strong, narrow set of matches. Whole-system overview
// questions are short but never narrow: skipping exploration also skips the
// coverage backstop's spine seeds, leaving the outline with three arbitrary
// chunks — they always take the deep path.
//
export function isFastPathEligible({question, prefetchResult}) {
    if(isSystemOverviewQuestion(question)) {
        return false;
    }
    if(!prefetchResult || !prefetchResult.results || prefetchResult.results.length === 0) {
        return false;
    }
    if(prefetchResult.results.length > config.fastPath.maxResults) {
        return false;
    }
    if(question.length > config.fastPath.maxQuestionLen) {
        return false;
    }
    const top = prefetchResult.results[0];
    if(!top || typeof top.similarity !== 'number') {
        return false;
    }
    return top.similarity >= config.fastPath.similarity;
}

function shouldAttemptHyde(prefetchResult) {
    const top = prefetchResult?.results?.[0];
    if(!top || typeof top.similarity !== 'number') {
        return true;
    }
    return top.similarity < config.hyde.minSimilarity;
}

function mergeSearchResults(primary, secondary, limit) {
    if(!secondary?.results?.length) {
        return primary;
    }
    if(!primary?.results?.length) {
        return {
            ...secondary,
            results: secondary.results.slice(0, limit),
            count: Math.min(secondary.results.length, limit)
        };
    }

    const seen = new Set();
    const results = [];
    for(const result of [...primary.results, ...secondary.results]) {
        const key = `${result.path}:${result.lineStart}-${result.lineEnd}`;
        if(seen.has(key)) {
            continue;
        }
        seen.add(key);
        results.push(result);
    }
    results.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    const support = results.filter((r) => isSupportingEvidencePath(r.path)).slice(0, PREFETCH_LIMITS.supportItems);
    const primaryRows = results.filter((r) => !support.includes(r)).slice(0, Math.max(0, limit - support.length));
    const limited = [...primaryRows, ...support].slice(0, limit);
    return {
        ...primary,
        count: limited.length,
        retrieval: mergeRetrievalDiagnostics(primary.retrieval, secondary.retrieval, limited.length),
        results: limited
    };
}

function mergeRetrievalDiagnostics(primary, secondary, results) {
    if(!primary && !secondary) {
        return null;
    }
    const modes = new Set([...(primary?.modes || []), ...(secondary?.modes || [])]);
    const timings = {};
    const counts = {};
    for(const retrieval of [primary, secondary]) {
        for(const [key, value] of Object.entries(retrieval?.timings || {})) {
            timings[key] = (Number(timings[key]) || 0) + (Number(value) || 0);
        }
        for(const [key, value] of Object.entries(retrieval?.counts || {})) {
            counts[key] = (Number(counts[key]) || 0) + (Number(value) || 0);
        }
    }
    counts.results = Number(results) || counts.results || 0;
    return {
        modes: [...modes],
        timings,
        counts,
        semantic: {
            threshold: primary?.semantic?.threshold ?? secondary?.semantic?.threshold ?? null,
            topSimilarity: maxFinite(
                primary?.semantic?.topSimilarity,
                secondary?.semantic?.topSimilarity,
            ),
            qualifiedTopSimilarity: maxFinite(
                primary?.semantic?.qualifiedTopSimilarity,
                secondary?.semantic?.qualifiedTopSimilarity,
            ),
        },
    };
}

function maxFinite(...values) {
    const finite = values.filter(
        (value) => typeof value === 'number' && Number.isFinite(value),
    );
    return finite.length > 0 ? Math.max(...finite) : null;
}

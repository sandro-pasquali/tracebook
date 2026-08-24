import {generateText} from 'ai';
import {runSearch} from '../../tools/search.js';
import {config} from '../../util/config.js';
import {resolveModel} from '../../util/model.js';
import {isSystemOverviewQuestion} from '../../util/retrieval-intent.js';
import {computeImportHubs, selectArchitectureSpine} from '../../index/graph-hubs.js';
import {settleGovernorCall} from '../usage.js';
import {buildEvidencePacket, buildEvidenceReadyEvent, wrapToolOutput} from '../evidence.js';
import {buildToolExchange} from './tool-message.js';

const MAX_STAGE_QUERIES = 6;
// Local code models need more than the HyDE 3s budget to emit the
// stage list; too short and the race always times out to a no-op.
//
const STAGE_EXTRACT_TIMEOUT_MS = 15_000;

// ───── Coverage phase ─────
// Compact the exploration transcript into an evidence packet, then — for deep
// questions only — run the completeness backstop: decompose the question into
// sub-area queries, search each, and fold the hits back into the packet so
// synthesis can ground every sub-area instead of asserting or flagging gaps.
//
// Yields evidence.compact + evidence.ready (and, when the backstop runs,
// coverage.done + a second evidence.ready). Returns {evidencePacket}.
//
export async function* runCoverage(ctx) {
    const {explorationMessages, retrievalQuestion, question, fastPath, classification, corpusCoverage, governor, signal, embedder, store, reranker, timer, degraded} = ctx;

    let messages = explorationMessages;
    let architectureHubs = [];
    let evidencePacket = buildEvidencePacket({question: retrievalQuestion, displayQuestion: question, explorationMessages: messages, corpusCoverage});
    const evidenceMark = timer.mark('evidence.compact', {items: evidencePacket.items.length});
    yield {type: 'timing.checkpoint', name: evidenceMark.name, sinceStart: evidenceMark.sinceStart, sinceLast: evidenceMark.sinceLast, items: evidenceMark.items};
    if(evidencePacket.items.length > 0) {
        yield buildEvidenceReadyEvent(evidencePacket, {stage: 'exploration'});
    }

    // Completeness backstop for deep questions (flows AND "how does X work in
    // detail"). The exploration model tends to satisfice — grounding the obvious
    // file and skipping collaborators it should have followed — even when
    // retrieval would surface each sub-area's file at rank 1. So we decompose the
    // question into sub-area queries, search each, and fold the hits into the
    // evidence packet, so synthesis can ground every sub-area instead of asserting
    // or flagging gaps. Gated by wantsCoverageBackstop to keep the extra call and
    // searches off narrow single-file lookups.
    //
    // The backstop is skipped outright — and its embed/search fan-out cut
    // short — once the client has disconnected: none of this work can reach a
    // closed stream, and the local embedder/searches cannot be cancelled once
    // started.
    //
    if(!fastPath && wantsCoverageBackstop(classification) && !signal?.aborted) {
        const stageQueries = mergeStageQueries([
            ...coverageSeedQueries({question, classification}),
            ...overviewSeedQueries({question, classification}),
            ...await extractStageQueries({question, governor, signal})
        ]);
        // Embed every stage query in one batched model call. The embedder serializes
        // its model runs, so N single-query embeds would run back-to-back as N batches
        // of one; batching keeps the searches parallel below while paying a single
        // embed pass. Each text still embeds independently, so the vectors are identical.
        //
        const stageEmbeddings = stageQueries.length > 0 && !signal?.aborted
            ? await embedder.embed(stageQueries, {type: 'query'})
            : [];
        const stageResults = await Promise.all(stageQueries.map(async (query, i) => {
            if(signal?.aborted || stageEmbeddings.length === 0) {
                return null;
            }
            try {
                return await runSearch({queryText: query, queryEmbedding: stageEmbeddings[i], limit: 3, embedder, store, includeSupport: false, reranker});
            } catch {
                return null;
            }
        }));
        const coverageMessages = [];
        for(let i = 0; i < stageResults.length; i++) {
            const result = stageResults[i];
            if(!result || !(result.results?.length > 0)) {
                continue;
            }
            const coverageCallId = `coverage_${i}`;
            coverageMessages.push(
                ...buildToolExchange({callId: coverageCallId, input: {query: stageQueries[i], limit: 3}, output: wrapToolOutput(result)})
            );
        }

        // Overview questions get the import-graph spine deterministically: the
        // most-imported files' head chunks enter evidence (they may never match
        // the semantically-empty query), and the hub list itself reaches the
        // outline as an explicit importance signal.
        //
        if(isSystemOverviewQuestion(question) && !signal?.aborted) {
            try {
                architectureHubs = selectArchitectureSpine(await computeImportHubs({store, limit: 12}), 5);
                const heads = (await Promise.all(architectureHubs.map((hub) => store.firstChunkForPath(hub.path)))).filter(Boolean);
                for(const [i, head] of heads.entries()) {
                    coverageMessages.push(...buildToolExchange({
                        callId: `hub_${i}`,
                        toolName: 'read_file',
                        input: {path: head.path, lineStart: head.lineStart, lineEnd: head.lineEnd},
                        output: wrapToolOutput({path: head.path, lineStart: head.lineStart, lineEnd: head.lineEnd, totalLines: head.lineEnd, content: head.content})
                    }));
                }
            } catch(err) {
                degraded?.note({area: 'graph_hubs', err});
                architectureHubs = [];
            }
        }
        const coverageMark = timer.mark('coverage.done', {stages: stageQueries.length, added: coverageMessages.length / 2});
        yield {type: 'timing.checkpoint', name: coverageMark.name, sinceStart: coverageMark.sinceStart, sinceLast: coverageMark.sinceLast, stages: coverageMark.stages, added: coverageMark.added};
        if(coverageMessages.length > 0) {
            messages = [...messages, ...coverageMessages];
            evidencePacket = buildEvidencePacket({question: retrievalQuestion, displayQuestion: question, explorationMessages: messages, architectureHubs, corpusCoverage});
            if(evidencePacket.items.length > 0) {
                yield buildEvidenceReadyEvent(evidencePacket, {stage: 'coverage'});
            }
        }
    }

    return {evidencePacket};
}

// A deep question gets the completeness backstop: flow/visual questions (the
// classifier marks these with a sequence_diagram answer shape) and behavioral
// explanations at feature/system scope both need evidence spanning several
// files. Narrow show_code/file lookups do NOT — this keeps the extra model call
// and searches off cheap questions.
//
export function wantsCoverageBackstop(classification) {
    if(!classification) {
        return false;
    }
    const shapes = Array.isArray(classification.preferredAnswerShapes) ? classification.preferredAnswerShapes : [];
    if(shapes.includes('sequence_diagram')) {
        return true;
    }
    return classification.intent === 'explain_behavior' && (classification.scope === 'feature' || classification.scope === 'system');
}

export function coverageSeedQueries({question, classification} = {}) {
    if(!isApiContractQuestion(question, classification)) {
        return [];
    }
    const queries = [
        'API route endpoint registration handler server',
        'request body query schema validation contract',
        'response stream SSE JSON event writer',
        'client fetch API caller usage frontend',
        'cache persistence save trace story storage'
    ];
    if(/\b(error|failure|fail|abort|cancel|not ready|invalid|validation)\b/i.test(String(question || ''))) {
        queries.push('API error invalid request abort failure response');
    }
    return queries;
}

// Whole-system overview questions name no stages, so the stage-extraction model
// invents arbitrary decompositions. Seed the generic architecture stages instead
// (entry -> orchestration -> data -> output -> wiring) so coverage walks the
// spine deterministically; the model's decomposition fills any leftover slots.
// Generic English only — no ecosystem terms belong in core.
//
export function overviewSeedQueries({question, classification} = {}) {
    if(classification?.scope !== 'system' || !isSystemOverviewQuestion(question)) {
        return [];
    }
    return [
        'application entry point startup initialization',
        'main orchestration core pipeline flow',
        'data storage persistence read write',
        'user-facing output response rendering',
        'configuration wiring setup'
    ];
}

// Parse the stage-extraction model output (one query per line) into clean query
// strings — stripping any leading bullets/numbering the model adds — capped at
// `max`. Pure and exported so it can be tested without a model call.
//
export function parseStageQueries(text, max = MAX_STAGE_QUERIES) {
    return String(text || '')
        .split(/\r?\n/)
        .map((line) => line.replace(/^[\s\-*\d.)]+/, '').trim())
        .filter(Boolean)
        .slice(0, max);
}

function mergeStageQueries(queries, max = MAX_STAGE_QUERIES) {
    const out = [];
    const seen = new Set();
    for(const query of queries || []) {
        const clean = String(query || '').trim();
        const key = clean.toLowerCase().replace(/\s+/g, ' ');
        if(!clean || seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(clean);
        if(out.length >= max) {
            break;
        }
    }
    return out;
}

function isApiContractQuestion(question, classification) {
    return classification?.domains?.includes('api') ||
        /\b(api|endpoint|route|request|response|sse|stream|streaming)\b/i.test(String(question || ''));
}

// Decompose a deep question — a flow ("prompt -> server -> search -> SSE") or a
// "how does X work in detail" — into one search query per distinct sub-area / file
// needed to answer it fully. The exploration model tends to satisfice: it grounds
// the obvious file and skips the collaborators it should have followed. So this
// lets the completeness backstop retrieve each sub-area deterministically,
// bypassing the model's early stop. Returns [] (skip) on any failure.
//
async function extractStageQueries({question, governor, signal}) {
    const reservation = governor ? await governor.beforeCall(120) : null;
    try {
        const racer = generateText({
            model: resolveModel(config.models.outline),
            prompt: `The question below asks how part of a codebase works. List the DISTINCT sub-areas, components, or files needed to answer it fully, and for EACH give one concise search query (5-10 words, using concrete implementation terms) to find the file that implements it. Output ONLY the queries, one per line, at most ${MAX_STAGE_QUERIES} lines, no numbering and no preamble.\n\nQuestion: ${question}`,
            maxOutputTokens: 200,
            temperature: 0.2,
            abortSignal: signal
        });
        let timeoutId;
        const timeout = new Promise((resolve) => {
            timeoutId = setTimeout(() => resolve(null), STAGE_EXTRACT_TIMEOUT_MS);
        });
        const result = await Promise.race([racer.then((r) => r), timeout]);
        clearTimeout(timeoutId);
        settleGovernorCall(governor, reservation, result?.usage);
        if(!result || !result.text) {
            return [];
        }
        return parseStageQueries(result.text);
    } catch {
        governor?.releaseCall?.(reservation);
        return [];
    }
}

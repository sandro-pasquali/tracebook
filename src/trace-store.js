import {compactReplayEvents} from './util/replay-events.js';
import {traceIdSchema} from './util/input-schemas.js';
import {SUMMARY_INDEX_FILE, createSummarySidecar} from './util/summary-sidecar.js';
import {createJsonIdStore} from './util/json-id-store.js';

// Persists a Trace as a JSON event log using unique-temp-file + rename for
// atomicity. The replay client walks the same events through the same outlet
// used in live render.
//
export function createTraceStore({root}) {
    if(!root) {
        throw new Error('createTraceStore requires {root}');
    }

    const items = createJsonIdStore({
        root,
        validateId: (id) => traceIdSchema.safeParse(id).success
    });

    const summaries = createSummarySidecar({
        root,
        listIds: list,
        loadItem: load,
        buildSummary,
        keyForSummary: (summary) => summary?.traceId
    });

    async function init() {
        await items.init();
    }

    async function save({traceId, question, startedAt, finishedAt, events, usage, model, trace, featureTrace, sourceRevision}) {
        const payload = {
            traceId,
            question,
            startedAt,
            finishedAt,
            durationMs: (finishedAt || Date.now()) - startedAt,
            usage: usage || null,
            model: model || null,
            sourceRevision: normalizeSourceRevision(sourceRevision),
            trace: trace || null,
            featureTrace: featureTrace || null,
            events: compactReplayEvents(events)
        };
        let file;
        try {
            file = await items.writeItem({id: traceId, payload});
        } catch(err) {
            throw err?.message === 'invalid_store_id' ? new Error('invalid_trace_id') : err;
        }
        await summaries.upsert(buildSummary(traceId, payload));
        return file;
    }

    async function load(traceId) {
        return items.readItem(traceId);
    }

    async function list() {
        return items.listIds({exclude: [SUMMARY_INDEX_FILE]});
    }

    // Summary listing reads a compact sidecar index instead of opening every
    // trace's full event log. The sidecar is kept current on save(); on read we
    // do a cheap directory scan (names only, no parse) and rebuild only if it
    // has drifted from the trace files on disk (migration, external writes).
    //
    async function listSummaries({limit = 50} = {}) {
        await init();
        return summaries.listSummaries({
            limit,
            sort: (a, b) => (b.finishedAt || b.startedAt || 0) - (a.finishedAt || a.startedAt || 0)
        });
    }

    return {init, save, load, list, listSummaries};
}

function buildSummary(traceId, saved) {
    const trace = saved.trace || {};
    const components = Array.isArray(trace.components) ? trace.components : [];
    const sourcePaths = [...new Set(components.flatMap((component) =>
        (component?.sourceRefs || []).map((ref) => ref?.path).filter(Boolean)
    ))].slice(0, 6);
    return {
        traceId,
        question: saved.question || '',
        title: trace.title || saved.featureTrace?.behavior || saved.question || traceId,
        startedAt: saved.startedAt || null,
        finishedAt: saved.finishedAt || null,
        durationMs: saved.durationMs || null,
        model: saved.model || null,
        componentKinds: components.map((c) => c?.type).filter(Boolean),
        sourcePaths
    };
}

function normalizeSourceRevision(value) {
    const s = String(value ?? '').trim();
    return s ? s : null;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {tool} from 'ai';
import {z} from 'zod';

const {setResolveOverrideForTest} = await import('../../src/util/model.js');
const {installMockModels, streamObjectModel, streamTextModel} = await import('../helpers/mock-models.js');

// Canned search result reused by prefetch and the exploration tool. similarity
// is below the fast-path floor (0.55) so exploration is not skipped, but the
// result still yields an evidence item.
//
function searchResult(results) {
    return {
        count: results.length,
        threshold: 0.2,
        retrieval: {modes: ['vector'], timings: {totalMs: 1}, counts: {results: results.length}},
        results
    };
}

const EVIDENCE = [{
    path: 'src/app.js',
    lineStart: 1,
    lineEnd: 5,
    similarity: 0.4,
    content: '1  function handle(req) {\n2    return route(req);\n3  }'
}];

function searchTool(result) {
    return {
        search_codebase: tool({
            description: 'Search the codebase.',
            inputSchema: z.object({query: z.string(), limit: z.number().optional()}),
            async execute() {
                return result;
            }
        })
    };
}

// A single component body carrying fields for EVERY component kind. The kind
// schemas are non-strict z.objects, so this validates against all of them — so
// no matter which kinds the outline/plan-augmentation produce, every component
// synthesizes successfully (and the visual-recovery path, which cannot be
// driven by a pull-based mock stream, is never triggered).
//
const SUPERSET_COMPONENT = {
    id: 'placeholder',
    sourceRefs: [{path: 'src/app.js', lineStart: 1, lineEnd: 5}],
    confidence: 0.8,
    reason: null,
    kind: 'grounded',
    summary: 'The entry point routes the incoming request to a handler.',
    detail: 'The function receives the request and forwards it to the router, which is the load-bearing step in this flow.',
    mermaid: 'sequenceDiagram\n  actor User\n  User->>App: request\n  App-->>User: response',
    caption: 'Request flow',
    diagramType: 'sequence',
    language: 'javascript',
    code: 'function handle(req) {\n  return route(req);\n}',
    callouts: [
        {line: 1, note: 'Receives the incoming request as the entry point.'},
        {line: 2, note: 'Forwards the request to the router for dispatch.'}
    ]
};

const OUTLINE = {
    title: 'How the app handles a request',
    narrative: ['The entry point receives the request.', 'It dispatches to a route handler.'],
    plan: [{
        id: 'cb-flow',
        kind: 'evidence_callout',
        intent: 'summarize how a request is handled',
        sourceRefHint: [{path: 'src/app.js', lineStart: 1, lineEnd: 5}]
    }]
};

const ANNOTATION = {
    summary: 'The handler receives a request and forwards it to the router.',
    callouts: [{line: 2, note: 'Forwards the request to the router for dispatch.'}]
};

async function collect(gen) {
    const events = [];
    for await (const event of gen) {
        events.push(event);
    }
    return events;
}

function fullFlowMocks() {
    return installMockModels({
        'ollama/test-exploration': streamTextModel([
            {tool: {name: 'search_codebase', input: {query: 'request handler', limit: 3}}},
            {text: 'done exploring'}
        ]),
        'ollama/test-outline': streamObjectModel(OUTLINE),
        'ollama/test-synthesis': streamObjectModel(SUPERSET_COMPONENT),
        'ollama/test-annotation': streamObjectModel(ANNOTATION)
    });
}

test('runPlanner drives prefetch -> exploration -> outline -> components to trace.complete', async (t) => {
    const restore = fullFlowMocks();
    t.after(() => {
        restore();
        setResolveOverrideForTest(null);
    });

    const {runPlanner} = await import('../../src/planner/index.js');
    // A short "prior_story"-scope question avoids the coverage backstop (whose
    // stage-query model call leaves a long dangling timeout), keeping the test
    // fast while still routing through full synthesis.
    //
    const events = await collect(runPlanner({
        question: 'How does login work',
        tools: searchTool(searchResult(EVIDENCE)),
        embedder: null,
        store: null,
        governor: null,
        traceIndexer: null,
        precomputedSimilarTraces: []
    }));

    const types = events.map((e) => e.type);
    assert.equal(types[0], 'trace.start');
    assert.ok(types.includes('tool.call'), 'a tool.call is emitted');
    assert.ok(events.some((e) => e.type === 'tool.call' && e.prefetch === true), 'prefetch tool.call');
    assert.ok(types.includes('evidence.ready'), 'evidence.ready emitted');

    const planIdx = types.indexOf('plan.ready');
    const firstPatchIdx = types.indexOf('component.patch');
    assert.ok(planIdx >= 0, 'plan.ready emitted');
    assert.ok(firstPatchIdx > planIdx, 'plan.ready precedes the first component.patch');

    assert.ok(events.some((e) => e.type === 'component.patch' && e.props?._final === true), 'a final component patch');

    const complete = events.at(-1);
    assert.equal(complete.type, 'trace.complete', 'last event is trace.complete');
    assert.equal(complete.synthesisMode, 'full');
    assert.ok(complete.trace && Array.isArray(complete.trace.components) && complete.trace.components.length >= 1);
    assert.ok(complete.featureTrace, 'carries a featureTrace');
    assert.equal(events.filter((e) => e.type === 'trace.error').length, 0, 'no trace.error on the happy path');
});

test('runPlanner takes the lean route when prefetch yields no evidence', async (t) => {
    const restore = installMockModels({
        // Exploration should never run on the lean route; map it anyway so an
        // accidental call is deterministic rather than a real network attempt.
        //
        'ollama/test-exploration': streamTextModel([{text: 'unused'}]),
        'ollama/test-outline': streamObjectModel(OUTLINE),
        'ollama/test-synthesis': streamObjectModel(SUPERSET_COMPONENT)
    });
    t.after(() => {
        restore();
        setResolveOverrideForTest(null);
    });

    const {runPlanner} = await import('../../src/planner/index.js');
    const events = await collect(runPlanner({
        question: 'Where is checkout?',
        tools: searchTool(searchResult([])),
        embedder: null,
        store: null,
        governor: null,
        traceIndexer: null,
        precomputedSimilarTraces: []
    }));

    assert.ok(events.some((e) => e.type === 'synthesis.start' && e.mode === 'lean'), 'lean synthesis.start');
    const complete = events.at(-1);
    assert.equal(complete.type, 'trace.complete');
    assert.equal(complete.synthesisMode, 'lean');
    // The lean route never runs the exploration/outline phases.
    //
    assert.equal(events.filter((e) => e.type === 'plan.ready').length, 0, 'no plan.ready on the lean route');
});

// A mid-stream model error (e.g. a flaky local model emitting a malformed tool
// call) must not kill the chapter. Exploration degrades to the evidence already
// gathered and the planner proceeds to synthesis, exactly as it does on a
// wall-clock timeout — surfacing an `exploration.degraded` checkpoint instead of
// a trace.error. A no-evidence prefetch short-circuits to the lean route before
// exploration ever runs (covered by the lean test above), so the degrade path
// always carries at least the prefetch evidence.
//
test('runPlanner degrades to a complete trace when the exploration stream errors', async (t) => {
    const restore = installMockModels({
        'ollama/test-exploration': streamTextModel([{error: 'boom'}]),
        'ollama/test-outline': streamObjectModel(OUTLINE),
        'ollama/test-synthesis': streamObjectModel(SUPERSET_COMPONENT),
        'ollama/test-annotation': streamObjectModel(ANNOTATION)
    });
    t.after(() => {
        restore();
        setResolveOverrideForTest(null);
    });

    const {runPlanner} = await import('../../src/planner/index.js');
    const events = await collect(runPlanner({
        question: 'How does login work',
        tools: searchTool(searchResult(EVIDENCE)),
        embedder: null,
        store: null,
        governor: null,
        traceIndexer: null,
        precomputedSimilarTraces: []
    }));

    assert.equal(events.filter((e) => e.type === 'trace.error').length, 0, 'a stream error degrades instead of emitting trace.error');
    assert.ok(events.some((e) => e.type === 'timing.checkpoint' && e.name === 'exploration.degraded'), 'an exploration.degraded checkpoint is emitted');
    const complete = events.at(-1);
    assert.equal(complete.type, 'trace.complete', 'the trace still completes after degrading');
    assert.equal(complete.synthesisMode, 'full', 'degraded exploration still drives full synthesis from the prefetch evidence');
});

// When the error lands AFTER a tool call already returned, the completed tool
// result must survive the degrade and reach synthesis alongside the prefetch
// evidence.
//
test('runPlanner preserves completed tool evidence when exploration errors mid-stream', async (t) => {
    const restore = installMockModels({
        'ollama/test-exploration': streamTextModel([
            {tool: {name: 'search_codebase', input: {query: 'request handler', limit: 3}}},
            {error: 'boom'}
        ]),
        'ollama/test-outline': streamObjectModel(OUTLINE),
        'ollama/test-synthesis': streamObjectModel(SUPERSET_COMPONENT),
        'ollama/test-annotation': streamObjectModel(ANNOTATION)
    });
    t.after(() => {
        restore();
        setResolveOverrideForTest(null);
    });

    const {runPlanner} = await import('../../src/planner/index.js');
    const events = await collect(runPlanner({
        question: 'How does login work',
        tools: searchTool(searchResult(EVIDENCE)),
        embedder: null,
        store: null,
        governor: null,
        traceIndexer: null,
        precomputedSimilarTraces: []
    }));

    assert.equal(events.filter((e) => e.type === 'trace.error').length, 0, 'no trace.error when exploration errors after partial progress');
    assert.ok(events.some((e) => e.type === 'timing.checkpoint' && e.name === 'exploration.degraded'), 'an exploration.degraded checkpoint is emitted');
    assert.ok(events.some((e) => e.type === 'tool.call' && e.prefetch !== true), 'the completed exploration tool.call is preserved');
    const complete = events.at(-1);
    assert.equal(complete.type, 'trace.complete', 'the trace completes with the partial evidence');
});

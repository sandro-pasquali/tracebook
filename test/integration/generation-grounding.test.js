import test from 'node:test';
import assert from 'node:assert/strict';
import {tool} from 'ai';
import {z} from 'zod';

// Drive the REAL planner generation+grounding path with an adversarial synthesis
// model, and assert the enforcement layer corrects what the model got wrong. This
// closes the gap left by planner-flow.test.js, whose SUPERSET_COMPONENT satisfies
// every schema and therefore never exercises grounding/reconciliation.
//
// The model deliberately over-reaches:
//   - an annotated_code_excerpt that cites a path NOT in evidence, with a bogus
//     line range — enforceGroundedAnnotatedCode must rewrite both to the real
//     evidence path/lines and keep the code verbatim from source.
//   - an evidence_callout labelled kind=gap while still carrying sourceRefs —
//     reconcileEvidenceCalloutKind must upgrade it (gap means "expected but
//     absent", which a sourced, confident callout is not).
const {setResolveOverrideForTest} = await import('../../src/util/model.js');
const {installMockModels, streamObjectModel, streamTextModel} = await import('../helpers/mock-models.js');

const EVIDENCE_PATH = 'src/handler.js';

// Line-numbered exactly the way read_file / search_codebase emit content
// (`${N}  ${source}`), so the grounding gutter-stripper recovers file lines.
//
const EVIDENCE_CONTENT = [
    '10  export function targetFn(req) {',
    '11    const route = pickRoute(req);',
    '12    return route.handle(req);',
    '13  }'
].join('\n');

// The verbatim source body (gutter removed) the excerpt should end up holding.
//
const EVIDENCE_BODY = [
    'export function targetFn(req) {',
    '  const route = pickRoute(req);',
    '  return route.handle(req);',
    '}'
].join('\n');

const SEARCH_RESULT = {
    count: 1,
    threshold: 0.2,
    retrieval: {modes: ['vector'], timings: {totalMs: 1}, counts: {results: 1}},
    results: [{
        path: EVIDENCE_PATH,
        lineStart: 10,
        lineEnd: 13,
        similarity: 0.42,
        content: EVIDENCE_CONTENT
    }]
};

function searchTool() {
    return {
        search_codebase: tool({
            description: 'Search the codebase.',
            inputSchema: z.object({query: z.string(), limit: z.number().optional()}),
            async execute() {
                return SEARCH_RESULT;
            }
        })
    };
}

// A two-item plan: one excerpt, one callout. Both sourceRefHints point at the
// real evidence so the per-item evidence slice carries EVIDENCE_CONTENT.
//
const OUTLINE = {
    title: 'How the request is dispatched',
    narrative: ['The entry function selects a route.', 'It forwards the request to the route handler.'],
    plan: [
        {
            id: 'excerpt',
            kind: 'annotated_code_excerpt',
            intent: 'show the dispatch function',
            sourceRefHint: [{path: EVIDENCE_PATH, lineStart: 10, lineEnd: 13}]
        },
        {
            id: 'callout',
            kind: 'evidence_callout',
            intent: 'summarize the dispatch step',
            sourceRefHint: [{path: EVIDENCE_PATH, lineStart: 10, lineEnd: 13}]
        }
    ]
};

// One adversarial body valid against BOTH per-kind schemas (the *Body schemas are
// non-strict, so the excerpt fields are ignored by the callout and vice-versa).
// It cites a path that is NOT in evidence and a line range far outside it.
//
const ADVERSARIAL = {
    id: 'placeholder',
    sourceRefs: [{path: 'src/totally-wrong.js', lineStart: 999, lineEnd: 1010}],
    confidence: 0.8,
    reason: null,
    // evidence_callout fields — gap despite being sourced + confident
    kind: 'gap',
    summary: 'The entry function dispatches the request to a route handler.',
    detail: 'The function picks a route for the incoming request and forwards it to that route. This dispatch is the load-bearing step in the flow.',
    // visual fields — plan augmentation can add a sequence diagram for request/API flows
    mermaid: 'sequenceDiagram\n  participant Client\n  participant App\n  Client->>App: request\n  App-->>Client: response',
    diagramType: 'sequence',
    // annotated_code_excerpt fields — code is verbatim source, refs are bogus
    caption: 'Request dispatch',
    language: 'javascript',
    code: EVIDENCE_BODY,
    callouts: [
        {line: 1, note: 'Entry point that receives the incoming request.'},
        {line: 2, note: 'Selects the route to dispatch this request to.'}
    ]
};

const ANNOTATION = {
    summary: 'The handler selects a route and forwards the request to it.',
    callouts: [{line: 2, note: 'Selects the route to dispatch this request to.'}]
};

async function collect(gen) {
    const events = [];
    for await (const event of gen) {
        events.push(event);
    }
    return events;
}

// A fake embedder so the deep-question coverage backstop (which embeds sub-area
// queries) actually RUNS instead of being skipped. store stays null, so the
// backstop's follow-up searches no-op — but the backstop code path executes, so
// this test is not quietly dodging it. The embedding values are irrelevant; the
// null store makes every backstop search return nothing.
//
function fakeEmbedder() {
    return {
        dims: 384,
        async embed(values) {
            return (Array.isArray(values) ? values : [values]).map(() => new Array(384).fill(0));
        },
        async dispose() {}
    };
}

test('grounding enforcement corrects an over-reaching model end-to-end', async (t) => {
    const restore = installMockModels({
        'ollama/test-exploration': streamTextModel([
            {tool: {name: 'search_codebase', input: {query: 'request dispatch', limit: 3}}},
            {text: 'done exploring'}
        ]),
        'ollama/test-outline': streamObjectModel(OUTLINE),
        'ollama/test-synthesis': streamObjectModel(ADVERSARIAL),
        'ollama/test-annotation': streamObjectModel(ANNOTATION)
    });
    t.after(() => {
        restore();
        setResolveOverrideForTest(null);
    });

    const {runPlanner} = await import('../../src/planner/index.js');
    // A DEEP question on purpose: explain_behavior at feature/system scope trips
    // the coverage backstop, so the full pipeline (prefetch -> exploration ->
    // coverage backstop -> outline -> components -> grounding) runs. The fake
    // embedder lets the backstop execute; the grounding invariant must hold with
    // that phase active, not only on a narrow question that skips it.
    //
    const events = await collect(runPlanner({
        question: 'How does the app handle an incoming request and route it through to a handler in detail?',
        tools: searchTool(),
        embedder: fakeEmbedder(),
        store: null,
        governor: null,
        traceIndexer: null,
        precomputedSimilarTraces: []
    }));

    const complete = events.at(-1);
    assert.equal(complete.type, 'trace.complete', 'planner reaches trace.complete');
    const components = complete.trace.components;
    assert.ok(Array.isArray(components) && components.length >= 1, 'trace carries components');

    const excerpts = components.filter((c) => c.type === 'annotated_code_excerpt');
    assert.ok(excerpts.length >= 1, 'an annotated_code_excerpt component was synthesized');
    for(const excerpt of excerpts) {
        // The bogus path/lines must have been rewritten to the real evidence.
        //
        assert.ok(Array.isArray(excerpt.sourceRefs) && excerpt.sourceRefs.length >= 1, 'excerpt has sourceRefs');
        for(const ref of excerpt.sourceRefs) {
            assert.equal(ref.path, EVIDENCE_PATH, 'sourceRef path rewritten to the evidence path');
            assert.ok(ref.lineStart >= 10 && ref.lineEnd <= 13, `sourceRef lines ${ref.lineStart}-${ref.lineEnd} fall inside the evidence range 10-13`);
        }
        // The excerpt code must be verbatim from the source body, never invented.
        //
        const codeLines = String(excerpt.code).split(/\r?\n/).filter((l) => l.trim() !== '');
        for(const line of codeLines) {
            assert.ok(EVIDENCE_BODY.includes(line.replace(/\s+$/, '')), `excerpt line is verbatim from evidence: ${JSON.stringify(line)}`);
        }
    }

    const callouts = components.filter((c) => c.type === 'evidence_callout');
    if(callouts.length >= 1) {
        for(const callout of callouts) {
            const sourced = Array.isArray(callout.sourceRefs) && callout.sourceRefs.length > 0;
            // A sourced, confident callout must not be labelled gap.
            //
            if(sourced) {
                assert.notEqual(callout.kind, 'gap', 'gap callout with sourceRefs was reconciled');
            }
        }
    }

    assert.equal(events.filter((e) => e.type === 'trace.error').length, 0, 'no trace.error on the grounding path');
});

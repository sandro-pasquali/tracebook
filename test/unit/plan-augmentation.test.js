import test from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../../src/util/config.js';
import {
    dedupeOverlappingPlanItems,
    ensureApiPlan,
    ensureNamedCodePlan,
    ensureOverviewPlan,
    ensureRequestedCodePlan,
    ensureRequestedVisualPlan,
    ensureSupportingActorPlan,
} from '../../src/planner/plan-augmentation.js';

test('ensureOverviewPlan deterministically builds a diagram plus a checkable architecture spine', () => {
    const updated = ensureOverviewPlan({
        outline: baseOutline(),
        question: 'How does this system work?',
        selectionQuestion: 'How does this system work?',
        classification: {scope: 'system'},
        evidencePacket: {
            architectureHubs: [
                {path: 'src/server/routes.js', wires: 12},
                {path: 'src/planner/runner.js', wires: 10},
                {path: 'src/index/store.js', wires: 8}
            ],
            items: [
                codeEvidence('src/server/routes.js', 10),
                codeEvidence('src/index/store.js', 20),
                codeEvidence('public/js/app.js', 30),
                codeEvidence('src/planner/runner.js', 40)
            ]
        }
    });

    assert.equal(updated.plan[0].id, 'architecture-spine');
    assert.equal(updated.plan[0].kind, 'mermaid_figure');
    const codePaths = updated.plan
        .filter((item) => item.kind === 'annotated_code_excerpt')
        .map((item) => item.sourceRefHint[0].path);
    assert.equal(codePaths.length, 3);
    assert.ok(codePaths.includes('src/server/routes.js'));
    assert.ok(codePaths.includes('src/index/store.js'));
    assert.ok(codePaths.includes('src/planner/runner.js'));
});

test('ensureRequestedVisualPlan inserts requested sequence diagram at the front', () => {
    const outline = baseOutline();
    const updated = ensureRequestedVisualPlan({
        outline,
        question: 'Show the API request flow as a sequence diagram',
        classification: {preferredAnswerShapes: ['sequence_diagram']},
        evidencePacket: {items: [codeEvidence('src/server.js', 10)]},
    });

    assert.equal(updated.plan.length, 2);
    assert.equal(updated.plan[0].kind, 'sequence_diagram');
    assert.equal(updated.plan[0].id, 'runtime-sequence');
    assert.deepEqual(updated.plan[0].sourceRefHint[0], {
        path: 'src/server.js',
        lineStart: 10,
        lineEnd: 17,
    });
});

test('ensureRequestedCodePlan inserts annotated code evidence without replacing protected visuals', () => {
    const outline = {
        ...baseOutline(),
        plan: [{
            id: 'runtime-sequence',
            kind: 'sequence_diagram',
            intent: 'Show the request flow.',
            sourceRefHint: [{path: 'src/server.js', lineStart: 1, lineEnd: 10}],
        }],
    };

    const updated = ensureRequestedCodePlan({
        outline,
        question: 'Show me the code for the checkout flow',
        classification: {preferredAnswerShapes: ['annotated_code_excerpt']},
        evidencePacket: {items: [codeEvidence('src/checkout.js', 20)]},
    });

    assert.deepEqual(updated.plan.map((item) => item.kind), ['sequence_diagram', 'annotated_code_excerpt']);
    assert.equal(updated.plan[1].id, 'code-checkout');
    assert.equal(updated.plan[1].sourceRefHint[0].path, 'src/checkout.js');
});

test('ensureRequestedCodePlan preserves markup and stylesheet layers for UI surface questions', () => {
    const updated = ensureRequestedCodePlan({
        outline: baseOutline(),
        question: 'Show the page layout HTML and CSS',
        classification: {preferredAnswerShapes: ['annotated_code_excerpt']},
        evidencePacket: {
            items: [
                jsEvidence('public/js/app.js', 40),
                htmlEvidence('public/index.html', 1),
                cssEvidence('public/styles.css', 20),
            ],
        },
    });

    const codePaths = updated.plan
        .filter((item) => item.kind === 'annotated_code_excerpt')
        .flatMap((item) => item.sourceRefHint.map((ref) => ref.path));

    assert.deepEqual(codePaths, ['public/index.html', 'public/styles.css']);
});

test('ensureRequestedCodePlan shows one excerpt per co-relevant file (evidence-driven)', () => {
    const updated = ensureRequestedCodePlan({
        outline: baseOutline(),
        question: 'how does checkout call payment',
        classification: {preferredAnswerShapes: ['annotated_code_excerpt']},
        evidencePacket: {
            items: [
                multiLineEvidence('src/checkout.js', 0.5, [
                    'export async function checkout(order) {',
                    '    const receipt = await payment(order);',
                    '    return receipt;',
                    '}',
                ]),
                multiLineEvidence('src/payment.js', 0.5, [
                    'export async function payment(order) {',
                    '    const charged = await chargeCheckout(order);',
                    '    return charged;',
                    '}',
                ]),
            ],
        },
    });

    const codePaths = updated.plan
        .filter((item) => item.kind === 'annotated_code_excerpt')
        .flatMap((item) => item.sourceRefHint.map((ref) => ref.path));
    assert.deepEqual([...codePaths].sort(), ['src/checkout.js', 'src/payment.js']);
});

test('ensureRequestedCodePlan shows a single excerpt when one file dominates', () => {
    const updated = ensureRequestedCodePlan({
        outline: baseOutline(),
        question: 'how does the system work end to end',
        classification: {preferredAnswerShapes: ['annotated_code_excerpt']},
        evidencePacket: {
            items: [
                multiLineEvidence('src/alpha.js', 0.6, [
                    'export function alpha() {',
                    '    const value = compute();',
                    '    return value;',
                    '}',
                ]),
                multiLineEvidence('src/beta.js', 0.2, [
                    'export function beta() {',
                    '    const other = helper();',
                    '    return other;',
                    '}',
                ]),
            ],
        },
    });

    const codePaths = updated.plan
        .filter((item) => item.kind === 'annotated_code_excerpt')
        .flatMap((item) => item.sourceRefHint.map((ref) => ref.path));
    assert.deepEqual(codePaths, ['src/alpha.js']);
});

test('ensureRequestedCodePlan honors an explicit request for much more code', () => {
    const updated = ensureRequestedCodePlan({
        outline: baseOutline(),
        question: 'show me much more code for this',
        classification: {preferredAnswerShapes: ['annotated_code_excerpt']},
        evidencePacket: {
            items: Array.from({length: 5}, (_, index) => multiLineEvidence(`src/file-${index}.js`, 0.5, [
                `export function fn${index}() {`,
                `    const value = compute(${index});`,
                '    return value;',
                '}',
            ])),
        },
    });

    const codeCount = updated.plan.filter((item) => item.kind === 'annotated_code_excerpt').length;
    assert.equal(codeCount, 4);
});

test('ensureRequestedCodePlan caps code excerpts at four even with many strong files', () => {
    const updated = ensureRequestedCodePlan({
        outline: baseOutline(),
        question: 'how do the widget parts connect',
        classification: {preferredAnswerShapes: ['annotated_code_excerpt']},
        evidencePacket: {
            items: Array.from({length: 6}, (_, index) => multiLineEvidence(`src/widget-${index}.js`, 0.5, [
                `export function widget${index}() {`,
                `    const value = connectWidget(${index});`,
                '    return value;',
                '}',
            ])),
        },
    });

    const codeCount = updated.plan.filter((item) => item.kind === 'annotated_code_excerpt').length;
    assert.equal(codeCount, 4);
});

test('ensureApiPlan repairs generic API answers around boundary facets', () => {
    const updated = ensureApiPlan({
        outline: baseOutline(),
        question: 'How does the API work, how is it implemented, and how is it used?',
        classification: {domains: ['api'], preferredAnswerShapes: ['sequence_diagram', 'annotated_code_excerpt']},
        evidencePacket: {
            items: [
                multiLineEvidence('src/server/ask-route.js', 0.6, [
                    'export function registerAskRoute(app) {',
                    '    app.post("/api/ask", withRequest({body: askRequestSchema}, async (c, {body}) => {',
                    '        return streamSSE(c, async (stream) => {',
                    '            await runPlanner(body);',
                    '        });',
                    '    }));',
                    '}',
                ]),
                multiLineEvidence('src/server/contracts.js', 0.5, [
                    'export const askRequestSchema = z.object({',
                    '    question: z.string(),',
                    '    storyContext: z.object({chapters: z.array(z.any())}),',
                    '});',
                    'export function withRequest(schema, handler) {',
                    '    return async (c) => handler(c, parseRequest(c, schema));',
                    '}',
                ]),
                multiLineEvidence('public/js/app/story-runner.js', 0.5, [
                    'export async function runStory(question) {',
                    '    const response = await fetch("/api/ask", {',
                    '        method: "POST",',
                    '        body: JSON.stringify({question}),',
                    '    });',
                    '    return response;',
                    '}',
                ]),
                multiLineEvidence('src/server/ask-route.js', 0.45, [
                    'return streamSSE(c, async (stream) => {',
                    '    await stream.writeSSE({event: "trace.start", data});',
                    '    await traces.save({traceId, events: collected});',
                    '    answerCache.set(question, collected);',
                    '});',
                ], 80),
            ],
        },
    });

    assert.equal(updated.plan[0].kind, 'sequence_diagram');
    assert.ok(updated.plan.some((item) => item.id === 'api-route-handler'));
    assert.ok(updated.plan.some((item) => item.id === 'api-request-contract'));
    assert.ok(updated.plan.some((item) => item.id === 'api-caller-usage'));
    assert.ok(updated.plan.some((item) => item.id === 'api-response-state'));
    assert.equal(updated.plan.length, config.trace.componentLimit);
});

test('ensureApiPlan follows the selected route to its endpoint-specific request schema', () => {
    const updated = ensureApiPlan({
        outline: baseOutline(),
        question: 'How does the API work?',
        classification: {domains: ['api'], preferredAnswerShapes: ['sequence_diagram']},
        evidencePacket: {
            items: [
                multiLineEvidence('src/server/ask-route.js', 0.7, [
                    'export function registerAskRoute(app) {',
                    '    app.post("/api/ask", withRequest(',
                    '        {query: emptyQuerySchema, body: askRequestSchema},',
                    '        async (c, {body}) => streamAnswer(c, body)',
                    '    ));',
                    '}',
                ], 10),
                multiLineEvidence('src/server/contracts.js', 0.95, [
                    'async function validateRequest(c, contract) {',
                    '    const request = {};',
                    '    const body = await c.req.json();',
                    '    const parsed = parsePart(body, contract.body);',
                    '    request.body = parsed.data;',
                    '    return request;',
                    '}',
                ], 120),
                multiLineEvidence('src/server/contracts.js', 0.25, [
                    'export const askRequestSchema = z.object({',
                    '    question: z.string().trim().min(1),',
                    '    storyContext: storyContext.default({chapters: []}),',
                    '    forceFresh: z.boolean().default(false),',
                    '}).strict();',
                ], 37),
            ],
        },
    });

    const contract = updated.plan.find((item) => item.id === 'api-request-contract');
    assert.deepEqual(contract.sourceRefHint, [{
        path: 'src/server/contracts.js',
        lineStart: 37,
        lineEnd: 41,
    }]);
    assert.match(contract.intent, /askRequestSchema/v);
});

test('ensureApiPlan surfaces missing caller evidence when usage is requested', () => {
    const updated = ensureApiPlan({
        outline: baseOutline(),
        question: 'How is this API implemented and used?',
        classification: {domains: ['api'], preferredAnswerShapes: ['sequence_diagram', 'annotated_code_excerpt']},
        evidencePacket: {
            items: [
                multiLineEvidence('src/server/routes.js', 0.6, [
                    'export function registerRoutes(app) {',
                    '    app.get("/api/status", withRequest({}, async (c) => c.json({ok: true})));',
                    '}',
                ]),
            ],
        },
    });

    const gap = updated.plan.find((item) => item.id === 'api-caller-gap');
    assert.equal(gap.kind, 'evidence_callout');
    assert.deepEqual(gap.sourceRefHint, []);
});

test('ensureNamedCodePlan adds source hints for named definitions', () => {
    const updated = ensureNamedCodePlan({
        outline: baseOutline(),
        question: 'Show me `createRuntime` in code',
        classification: {preferredAnswerShapes: ['annotated_code_excerpt']},
        evidencePacket: {
            items: [{
                tool: 'read_file',
                path: 'src/server.js',
                lineStart: 100,
                lineEnd: 106,
                content: [
                    '100  export async function createRuntime() {',
                    '101      const storage = await getStorage();',
                    '102      const tools = createTools();',
                    '103      return {storage, tools};',
                    '104  }',
                    '105  export function otherThing() {',
                    '106      return true;',
                ].join('\n'),
            }],
        },
    });

    const added = updated.plan.find((item) => item.id === 'code-create-runtime');
    assert.equal(added.kind, 'annotated_code_excerpt');
    assert.deepEqual(added.sourceRefHint, [{
        path: 'src/server.js',
        lineStart: 100,
        lineEnd: 124,
    }]);
});

test('ensureNamedCodePlan uses language integrations for non-JavaScript definitions', () => {
    const updated = ensureNamedCodePlan({
        outline: baseOutline(),
        question: 'Show me `load_user` in code',
        classification: {preferredAnswerShapes: ['annotated_code_excerpt']},
        evidencePacket: {
            items: [{
                tool: 'read_file',
                path: 'src/users.py',
                lineStart: 40,
                lineEnd: 46,
                content: [
                    '40  def load_user(user_id):',
                    '41      row = db.fetch(user_id)',
                    '42      if row is None:',
                    '43          raise LookupError(user_id)',
                    '44      return row',
                    '45  def other_user():',
                    '46      return None',
                ].join('\n'),
            }],
        },
    });

    const added = updated.plan.find((item) => item.id === 'code-load-user');
    assert.equal(added.kind, 'annotated_code_excerpt');
    assert.deepEqual(added.sourceRefHint, [{
        path: 'src/users.py',
        lineStart: 40,
        lineEnd: 64,
    }]);
});

test('ensureSupportingActorPlan adds dependency/config evidence without exceeding limit', () => {
    const outline = {
        title: 'Runtime',
        narrative: ['Runtime starts.'],
        plan: Array.from({length: config.trace.componentLimit}, (_, index) => ({
            id: `slot-${index}`,
            kind: 'evidence_callout',
            intent: `Explain slot ${index}.`,
            sourceRefHint: [{path: `src/file-${index}.js`, lineStart: 1, lineEnd: 2}],
        })),
    };

    const updated = ensureSupportingActorPlan({
        outline,
        question: 'Which dependency config controls runtime startup?',
        evidencePacket: {
            items: [
                {path: 'package.json', lineStart: 1, lineEnd: 20},
                {path: '__dependencies__/npm/vite.md', lineStart: 1, lineEnd: 5},
            ],
        },
    });

    assert.equal(updated.plan.length, config.trace.componentLimit);
    assert.equal(updated.plan.at(-1).id, 'supporting-actors');
    assert.deepEqual(updated.plan.at(-1).sourceRefHint.map((ref) => ref.path), [
        'package.json',
        '__dependencies__/npm/vite.md',
    ]);
});

test('ensureSupportingActorPlan does not add dependencies to ordinary behavior stories', () => {
    const outline = baseOutline();

    const updated = ensureSupportingActorPlan({
        outline,
        question: 'How does the checkout request flow work?',
        evidencePacket: {
            items: [
                {path: 'package.json', lineStart: 1, lineEnd: 20},
                {path: '__dependencies__/npm/vite.md', lineStart: 1, lineEnd: 5},
            ],
        },
    });

    assert.equal(updated, outline);
});

function baseOutline() {
    return {
        title: 'Runtime',
        narrative: ['Runtime starts.'],
        plan: [{
            id: 'overview',
            kind: 'evidence_callout',
            intent: 'Explain the implementation.',
            sourceRefHint: [{path: 'src/server.js', lineStart: 1, lineEnd: 5}],
        }],
    };
}

function multiLineEvidence(path, score, sourceLines, lineStart = 1) {
    return {
        tool: 'search_codebase',
        path,
        lineStart,
        lineEnd: lineStart + sourceLines.length - 1,
        score,
        content: sourceLines.map((line, index) => `${lineStart + index}  ${line}`).join('\n'),
    };
}

function codeEvidence(path, lineStart) {
    const lineEnd = lineStart + 7;
    return {
        tool: 'read_file',
        path,
        lineStart,
        lineEnd,
        content: [
            `${lineStart}  export async function checkout() {`,
            `${lineStart + 1}      const order = await loadOrder();`,
            `${lineStart + 2}      if(!order) {`,
            `${lineStart + 3}          throw new Error('missing order');`,
            `${lineStart + 4}      }`,
            `${lineStart + 5}      await saveOrder(order);`,
            `${lineStart + 6}      return order;`,
            `${lineStart + 7}  }`,
        ].join('\n'),
    };
}

function jsEvidence(path, lineStart) {
    return {
        tool: 'search_codebase',
        path,
        lineStart,
        lineEnd: lineStart + 4,
        content: [
            `${lineStart}  export function renderPage() {`,
            `${lineStart + 1}      const node = document.querySelector('#outlet');`,
            `${lineStart + 2}      node.textContent = 'ready';`,
            `${lineStart + 3}  }`,
        ].join('\n'),
    };
}

function htmlEvidence(path, lineStart) {
    return {
        tool: 'search_codebase',
        path,
        lineStart,
        lineEnd: lineStart + 5,
        content: [
            `${lineStart}  <main class="stage">`,
            `${lineStart + 1}      <section id="outlet" class="outlet"></section>`,
            `${lineStart + 2}      <form id="ask-form" class="ask"></form>`,
            `${lineStart + 3}  </main>`,
        ].join('\n'),
    };
}

function cssEvidence(path, lineStart) {
    return {
        tool: 'search_codebase',
        path,
        lineStart,
        lineEnd: lineStart + 5,
        content: [
            `${lineStart}  .stage {`,
            `${lineStart + 1}      display: grid;`,
            `${lineStart + 2}      gap: 16px;`,
            `${lineStart + 3}  }`,
        ].join('\n'),
    };
}

test('ensureApiPlan fires for plural phrasing without a classified api domain', () => {
    const updated = ensureApiPlan({
        outline: baseOutline(),
        question: 'Are there apis that handle story deletion?',
        classification: {domains: [], preferredAnswerShapes: []},
        evidencePacket: {
            items: [
                multiLineEvidence('src/server/story-routes.js', 0.6, [
                    'app.delete("/api/stories/:id", withRequest({params: idSchema}, async (c, {params}) => {',
                    '    const result = await stories.remove(params.id);',
                    '    if(!result.deleted) {',
                    '        return c.json({error: "not_found"}, 404);',
                    '    }',
                    '    return c.json({ok: true});',
                    '}));',
                ]),
            ],
        },
    });

    const handler = updated.plan.find((item) => item.id === 'api-route-handler');
    assert.ok(handler, 'plural "apis" should still trigger the api contract plan');
    assert.equal(handler.sourceRefHint[0].path, 'src/server/story-routes.js');
});

test('ensureApiPlan keeps facet slots on the question subject', () => {
    // The regenerated-trace failure shape: the response/state facet must not
    // drag in pattern-dense but off-subject streaming plumbing when the
    // on-subject route (already covered by the plan) satisfies the facet.
    //
    const outline = {
        ...baseOutline(),
        plan: [
            {
                id: 'api-endpoint-definition',
                kind: 'annotated_code_excerpt',
                intent: 'Show the deletion endpoint.',
                sourceRefHint: [{path: 'src/server/story-routes.js', lineStart: 62, lineEnd: 84}],
            },
            {
                id: 'client-delete-flow',
                kind: 'annotated_code_excerpt',
                intent: 'Show the client deletion call.',
                sourceRefHint: [{path: 'public/js/app/sessions-panel.js', lineStart: 214, lineEnd: 241}],
            },
        ],
    };

    const updated = ensureApiPlan({
        outline,
        question: 'Are there apis that handle story deletion?',
        classification: {domains: [], preferredAnswerShapes: []},
        evidencePacket: {
            items: [
                multiLineEvidence('src/server/story-routes.js', 0.6, [
                    'app.delete("/api/stories/:id", withRequest({params: idSchema}, async (c, {params}) => {',
                    '    const result = await storyStore.remove(params.id);',
                    '    if(!result.deleted) {',
                    '        return c.json({error: "not_found"}, 404);',
                    '    }',
                    '    return c.json({ok: true, storyId: result.storyId});',
                    '}));',
                ], 62),
                multiLineEvidence('public/js/app/sessions-panel.js', 0.58, [
                    'const res = await apiFetch("/api/stories/" + encodeURIComponent(storyId), {method: "DELETE"});',
                    'if(!res.ok) {',
                    '    throw new Error("story_delete_failed");',
                    '}',
                ], 214),
                multiLineEvidence('src/server/ask-route.js', 0.52, [
                    'return streamSSE(c, async (stream) => {',
                    '    await stream.writeSSE({event: "trace.start", data});',
                    '    await traces.save({traceId, events: collected});',
                    '    answerCache.set(question, collected);',
                    '    return c.json({ok: true});',
                    '});',
                ], 55),
            ],
        },
    });

    const offTopic = updated.plan.filter((item) =>
        (item.sourceRefHint || []).some((ref) => ref.path === 'src/server/ask-route.js'));
    assert.deepEqual(offTopic, [], 'no facet slot should cite the off-subject streaming route');
});

test('ensureApiPlan request-contract slot never cites a different endpoint file', () => {
    // A second route-registration file satisfying the validation patterns
    // demonstrates another feature's endpoint, not this route's contract.
    //
    const updated = ensureApiPlan({
        outline: baseOutline(),
        question: 'Are there apis that handle story deletion?',
        classification: {domains: [], preferredAnswerShapes: []},
        evidencePacket: {
            items: [
                multiLineEvidence('src/server/story-routes.js', 0.6, [
                    'app.delete("/api/stories/:id", withRequest({params: storyIdParamsSchema}, async (c, {params}) => {',
                    '    const result = await storyStore.remove(params.id);',
                    '    return c.json({ok: true, storyId: result.storyId});',
                    '}));',
                ], 62),
                multiLineEvidence('src/server/team-routes.js', 0.55, [
                    'app.get("/api/team/config", withRequest({query: emptyQuerySchema}, async (c) => {',
                    '    const parsed = teamConfigSaveSchema.safeParse(await c.req.json());',
                    '    if(!parsed.success) {',
                    '        return c.json({error: "invalid_payload"}, 400);',
                    '    }',
                    '    return c.json(parsed.data);',
                    '}));',
                ], 1),
                multiLineEvidence('src/server/contracts.js', 0.5, [
                    'export const storyIdParamsSchema = z.object({',
                    '    id: z.string().min(1),',
                    '});',
                    'export function withRequest(schema, handler) {',
                    '    return async (c) => handler(c, parseRequest(c, schema));',
                    '}',
                ], 1),
            ],
        },
    });

    const contract = updated.plan.find((item) => item.id === 'api-request-contract');
    if(contract) {
        assert.equal(contract.sourceRefHint[0].path, 'src/server/contracts.js');
    }
    const teamRefs = updated.plan.filter((item) =>
        (item.sourceRefHint || []).some((ref) => ref.path === 'src/server/team-routes.js'));
    assert.deepEqual(teamRefs, [], 'no slot should cite the unrelated endpoint file');
});

test('dedupeOverlappingPlanItems drops later excerpts stacked on the same lines', () => {
    const outline = {
        title: 'API flow',
        narrative: ['n'],
        plan: [
            {id: 'flow', kind: 'sequence_diagram', intent: 'diagram', sourceRefHint: [{path: 'src/server/ask-route.js', lineStart: 50, lineEnd: 120}]},
            {id: 'runtime-deps', kind: 'annotated_code_excerpt', intent: 'DI', sourceRefHint: [{path: 'src/server/ask-route.js', lineStart: 61, lineEnd: 120}]},
            {id: 'streaming', kind: 'annotated_code_excerpt', intent: 'streaming', sourceRefHint: [{path: 'src/server/ask-route.js', lineStart: 50, lineEnd: 108}]},
            {id: 'errors', kind: 'annotated_code_excerpt', intent: 'errors', sourceRefHint: [{path: 'src/server/ask-route.js', lineStart: 62, lineEnd: 77}]},
            {id: 'validation', kind: 'annotated_code_excerpt', intent: 'contracts', sourceRefHint: [{path: 'src/server/contracts.js', lineStart: 100, lineEnd: 133}]},
            {id: 'deep-tail', kind: 'annotated_code_excerpt', intent: 'persistence', sourceRefHint: [{path: 'src/server/ask-route.js', lineStart: 240, lineEnd: 299}]},
        ],
    };

    const deduped = dedupeOverlappingPlanItems(outline);

    assert.deepEqual(deduped.plan.map((item) => item.id), ['flow', 'runtime-deps', 'validation', 'deep-tail']);
});

test('dedupeOverlappingPlanItems keeps items without numeric hints untouched', () => {
    const outline = {
        title: 't',
        narrative: [],
        plan: [
            {id: 'a', kind: 'annotated_code_excerpt', intent: 'x', sourceRefHint: [{path: 'src/a.js'}]},
            {id: 'b', kind: 'annotated_code_excerpt', intent: 'y', sourceRefHint: [{path: 'src/a.js'}]},
            {id: 'c', kind: 'evidence_callout', intent: 'z', sourceRefHint: []},
        ],
    };

    const deduped = dedupeOverlappingPlanItems(outline);

    assert.equal(deduped.plan.length, 3);
});

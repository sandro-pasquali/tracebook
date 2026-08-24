import test from 'node:test';
import assert from 'node:assert/strict';
import {createTimer} from '../../src/util/timing.js';
import {synthesizeComponent} from '../../src/planner/synthesize-component.js';
import {lintMermaidSource} from '../../src/planner/visual-fallback.js';
import {setResolveOverrideForTest} from '../../src/util/model.js';
import {
    emptyLengthModel,
    installMockModels,
    lengthFinishObjectModel,
    streamObjectModel,
    streamThenGenerateObjectModel
} from '../helpers/mock-models.js';

// Collector channel: synthesizeComponent pushes events synchronously, so a
// plain array stands in for the async event-channel here.
//
function collector() {
    const events = [];
    return {events, push: (event) => events.push(event)};
}

function baseArgs(planItem, model, extra = {}) {
    return {
        planItem,
        index: 0,
        outline: {title: 'Test outline', narrative: ['step one']},
        evidenceMessage: 'Evidence slice.',
        evidenceItems: [],
        question: 'How does the thing work?',
        model,
        throttleMs: 0,
        maxTokens: 500,
        channel: collector(),
        timer: createTimer({label: 'test'}),
        governor: null,
        ...extra
    };
}

test('synthesizeComponent streams an evidence_callout and emits a final patch', async () => {
    const body = {
        id: 'cb-1',
        sourceRefs: [],
        confidence: 0.9,
        reason: null,
        kind: 'inferred',
        summary: 'The route validates the body before any work begins.',
        detail: 'Validation happens up front so malformed requests are rejected early. This keeps downstream code working on trusted input.'
    };
    const args = baseArgs({id: 'cb-1', kind: 'evidence_callout', intent: 'explain validation'}, streamObjectModel(body));
    const result = await synthesizeComponent(args);

    assert.equal(result.ok, true);
    assert.equal(result.component.type, 'evidence_callout');
    assert.equal(result.component.summary, body.summary);
    const finals = args.channel.events.filter((e) => e.type === 'component.patch' && e.props?._final === true);
    assert.equal(finals.length, 1, 'exactly one final patch');
    assert.equal(finals[0].id, 'cb-1');
});

test('synthesizeComponent reconciles a gap callout that still cites sources', async () => {
    const body = {
        id: 'cb-gap',
        sourceRefs: [{path: 'src/app.js', lineStart: 1, lineEnd: 4}],
        confidence: 0.8,
        reason: null,
        kind: 'gap',
        summary: 'Checkout is wired through the order service.',
        detail: 'The handler calls the order service which performs the charge. The flow is visible directly in the cited source.'
    };
    const args = baseArgs(
        {id: 'cb-gap', kind: 'evidence_callout', intent: 'explain checkout'},
        streamObjectModel(body),
        {evidenceItems: [{path: 'src/app.js', lineStart: 1, lineEnd: 10, content: 'const checkout = orderService.checkout;'}]}
    );
    const result = await synthesizeComponent(args);

    assert.equal(result.ok, true);
    assert.equal(result.component.kind, 'grounded');
    assert.equal(result.component.evidenceState, 'grounded');
});

test('synthesizeComponent falls back to a final gap callout for an unknown component kind', async () => {
    const args = baseArgs({id: 'unknown-1', kind: 'unknown_kind', intent: 'show unknown output'}, streamObjectModel({}));
    const result = await synthesizeComponent(args);

    assert.equal(result.ok, false);
    assert.equal(result.component.type, 'evidence_callout');
    assert.equal(result.component.kind, 'gap');
    assert.equal(result.error, 'unknown_component_kind:unknown_kind');
    const final = args.channel.events.find((event) => event.type === 'component.patch' && event.props?._final);
    assert.equal(final.componentType, 'evidence_callout');
    assert.equal(final.id, 'unknown-1');
});

test('synthesizeComponent identifies an empty length-limited response as output exhaustion', async () => {
    const args = baseArgs(
        {id: 'exhausted-1', kind: 'evidence_callout', intent: 'explain a route'},
        emptyLengthModel()
    );
    const result = await synthesizeComponent(args);

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Model exhausted the 500-token output budget without returning an answer.');
    assert.equal(result.component.gapReason, 'generation_failed');
    assert.match(result.component.detail, /without returning an answer/v);
    assert.doesNotMatch(result.component.detail, /JSON parsing failed/v);
    const end = args.channel.events.find((event) => event.type === 'timing.checkpoint' && event.name === 'component.exhausted-1.end');
    assert.equal(end.error, result.error);
});

test('synthesizeComponent retries an invalid non-visual body once with the same schema', async () => {
    const invalid = {
        id: 'retry-callout',
        source_ref: 'src/server.js:1-10',
        confidence: 0.8,
        summary: 'The route validates its input.'
    };
    const valid = {
        id: 'retry-callout',
        sourceRefs: [],
        confidence: 0.7,
        reason: null,
        kind: 'inferred',
        summary: 'The route validates its input.',
        detail: 'The request boundary checks input before dispatching downstream work.'
    };
    const args = baseArgs(
        {id: 'retry-callout', kind: 'evidence_callout', intent: 'explain validation'},
        streamThenGenerateObjectModel({streamObject: invalid, generatedObject: valid})
    );

    const result = await synthesizeComponent(args);

    assert.equal(result.ok, true);
    assert.equal(result.component.type, 'evidence_callout');
    assert.equal(result.component.recovered, true);
    assert.match(result.component.recoveryReason, /^schema_retry:/v);
    const retry = args.channel.events.find((event) => event.name === 'component.retry-callout.schema.retry');
    assert.equal(retry.ok, true);
});

test('synthesizeComponent refuses a schema-valid stream that finished by length', async () => {
    // The JSON closed before the budget cut, so the object parses — but the
    // content may be silently truncated (e.g. a mermaid string ending "J[K[").
    // The finish-reason gate must route it through recovery, never finalize it.
    //
    const truncated = {
        id: 'trunc-1',
        sourceRefs: [],
        confidence: 1,
        reason: null,
        kind: 'inferred',
        summary: 'Truncated mid-thought but syntactically val',
        detail: 'This body streamed fully as JSON while the model hit its output budget.'
    };
    const valid = {
        id: 'trunc-1',
        sourceRefs: [],
        confidence: 0.7,
        reason: null,
        kind: 'inferred',
        summary: 'The retry produced the complete explanation.',
        detail: 'The recovery call re-generated the component under the same schema.'
    };
    const args = baseArgs(
        {id: 'trunc-1', kind: 'evidence_callout', intent: 'explain truncation handling'},
        lengthFinishObjectModel({streamObject: truncated, generatedObject: valid})
    );

    const result = await synthesizeComponent(args);

    assert.equal(result.ok, true);
    assert.equal(result.component.recovered, true);
    assert.equal(result.component.summary, valid.summary);
    const finals = args.channel.events.filter((e) => e.type === 'component.patch' && e.props?._final === true);
    assert.equal(finals.length, 1, 'exactly one final patch');
    assert.equal(finals[0].props.summary, valid.summary, 'the truncated stream body must not ship');
});

test('synthesizeComponent emits a valid sequence_diagram', async () => {
    const body = {
        id: 'seq-1',
        sourceRefs: [{path: 'src/server.js', lineStart: 1, lineEnd: 20}],
        confidence: 0.7,
        reason: null,
        mermaid: 'sequenceDiagram\n  actor User\n  User->>Server: ask\n  Server-->>User: answer',
        caption: 'Request flow'
    };
    const args = baseArgs({id: 'seq-1', kind: 'sequence_diagram', intent: 'show the flow'}, streamObjectModel(body));
    const result = await synthesizeComponent(args);

    assert.equal(result.ok, true);
    assert.equal(result.component.type, 'sequence_diagram');
    assert.match(result.component.mermaid, /^sequenceDiagram\b/);
});

test('synthesizeComponent retries schema-valid Mermaid that fails structural lint', async () => {
    const invalid = {
        id: 'seq-retry',
        sourceRefs: [{path: 'src/server/story-routes.js', lineStart: 1, lineEnd: 30}],
        confidence: 0.8,
        reason: null,
        mermaid: [
            'sequenceDiagram',
            '    participant C as Client',
            '    participant A as API Server',
            '    C->>A: HTTP Request',
            '    alt Not Ready',
            '        A-->>C: 503 Service Unavailable',
            '    else Ready',
            '        A-->>C: 200 OK'
        ].join('\n'),
        caption: 'API request flow'
    };
    const valid = {
        ...invalid,
        mermaid: `${invalid.mermaid}\n    end`
    };
    const args = baseArgs(
        {id: 'seq-retry', kind: 'sequence_diagram', intent: 'show API readiness branching'},
        streamThenGenerateObjectModel({streamObject: invalid, generatedObject: valid})
    );

    const result = await synthesizeComponent(args);

    assert.equal(result.ok, true);
    assert.equal(result.component.type, 'sequence_diagram');
    assert.equal(result.component.recovered, true);
    assert.equal(lintMermaidSource(result.component.mermaid), '');
    const final = args.channel.events.find((event) => event.type === 'component.patch' && event.props?._final === true);
    assert.equal(final.componentType, 'sequence_diagram');
    assert.equal(lintMermaidSource(final.props.mermaid), '');
    assert.match(final.props.mermaid, /\n {4}end$/v);
});

test('synthesizeComponent fails a visual component when Mermaid retry remains invalid', async () => {
    const invalid = {
        id: 'seq-bad-retry',
        sourceRefs: [{path: 'src/server/story-routes.js', lineStart: 1, lineEnd: 30}],
        confidence: 0.8,
        reason: null,
        mermaid: [
            'sequenceDiagram',
            '    participant C as Client',
            '    participant A as API Server',
            '    C->>A: HTTP Request',
            '    alt Not Ready',
            '        A-->>C: 503 Service Unavailable',
            '    else Ready',
            '        A-->>C: 200 OK'
        ].join('\n'),
        caption: 'API request flow'
    };
    const args = baseArgs(
        {id: 'seq-bad-retry', kind: 'sequence_diagram', intent: 'show API readiness branching'},
        streamThenGenerateObjectModel({streamObject: invalid, generatedObject: invalid})
    );

    const result = await synthesizeComponent(args);

    assert.equal(result.ok, false);
    assert.equal(result.component.type, 'evidence_callout');
    assert.match(result.error, /^invalid_mermaid:/v);
    const final = args.channel.events.find((event) => event.type === 'component.patch' && event.props?._final === true);
    assert.equal(final.componentType, 'evidence_callout');
    assert.equal(final.props.kind, 'gap');
});

test('synthesizeComponent grounds an annotated_code_excerpt and runs house limits', async (t) => {
    // The component itself is the injected model; the annotation model
    // (resolveModel(config.models.annotation) === openai/gpt-4o-mini in tests)
    // is intercepted via the resolveModel seam.
    //
    const restore = installMockModels({
        'openai/gpt-4o-mini': streamObjectModel({
            summary: 'The handler reads the request body and dispatches the order.',
            callouts: [{line: 2, note: 'Reads the incoming request body before dispatching.'}]
        })
    });
    t.after(() => {
        restore();
        setResolveOverrideForTest(null);
    });

    const code = [
        'function checkout(req, res) {',
        '    const body = req.body;',
        '    const order = createOrder(body);',
        '    return res.json(order);',
        '}'
    ].join('\n');
    const body = {
        id: 'code-1',
        sourceRefs: [{path: 'src/routes/checkout.js', lineStart: 1, lineEnd: 5}],
        confidence: 0.9,
        reason: null,
        caption: 'Checkout handler',
        language: 'javascript',
        code,
        callouts: [
            {line: 2, note: 'Reads the request body.'},
            {line: 3, note: 'Creates the order.'},
            {line: 4, note: 'Returns the order as JSON.'}
        ]
    };
    const evidenceItems = [{
        tool: 'read_file',
        path: 'src/routes/checkout.js',
        lineStart: 1,
        lineEnd: 5,
        content: code
    }];
    const args = baseArgs(
        {id: 'code-1', kind: 'annotated_code_excerpt', intent: 'show the checkout handler'},
        streamObjectModel(body),
        {evidenceItems}
    );
    const result = await synthesizeComponent(args);

    assert.equal(result.ok, true);
    assert.equal(result.component.type, 'annotated_code_excerpt');
    assert.equal(typeof result.component.code, 'string');
    assert.ok(result.component.code.length > 0);
    assert.ok(Array.isArray(result.component.callouts) && result.component.callouts.length > 0);
});

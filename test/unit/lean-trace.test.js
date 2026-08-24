import test from 'node:test';
import assert from 'node:assert/strict';
import {createTimer} from '../../src/util/timing.js';
import {synthesizeLeanTrace} from '../../src/planner/lean-trace.js';

// Drive an async generator to completion, capturing both the yielded events and
// the generator's return value.
//
async function drain(gen) {
    const events = [];
    let step = await gen.next();
    while(!step.done) {
        events.push(step.value);
        step = await gen.next();
    }
    return {events, returnValue: step.value};
}

function run(args) {
    return drain(synthesizeLeanTrace({timer: createTimer({label: 'test'}), ...args}));
}

test('synthesizeLeanTrace builds a grounded trace from the top evidence item', async () => {
    const evidencePacket = {
        items: [{path: 'src/routes/checkout.js', lineStart: 10, lineEnd: 24, score: 0.8}]
    };
    const {events, returnValue} = await run({question: 'Where is checkout?', evidencePacket});

    const types = events.map((e) => e.type);
    assert.deepEqual(types.slice(0, 2), ['synthesis.start', 'timing.checkpoint']);
    assert.ok(types.includes('trace.title'));
    assert.ok(types.includes('narrative.patch'));

    const patch = events.find((e) => e.type === 'component.patch');
    assert.ok(patch, 'emits a component patch');
    assert.equal(patch.props._final, true);
    assert.equal(patch.props.type, 'evidence_callout');
    assert.equal(patch.props.kind, 'grounded');
    assert.deepEqual(patch.props.sourceRefs, [{path: 'src/routes/checkout.js', lineStart: 10, lineEnd: 24}]);

    assert.ok(returnValue?.trace);
    assert.equal(returnValue.trace.components.length, 1);
    assert.equal(returnValue.trace.components[0].kind, 'grounded');
    assert.ok(returnValue.trace.components[0].confidence >= 0.55 && returnValue.trace.components[0].confidence <= 0.95);
});

test('synthesizeLeanTrace emits a gap component when no evidence is found', async () => {
    const {events, returnValue} = await run({question: 'Anything?', evidencePacket: {items: []}});

    const patch = events.find((e) => e.type === 'component.patch');
    assert.equal(patch.props.kind, 'gap');
    assert.equal(patch.props.confidence, 0);
    assert.deepEqual(patch.props.sourceRefs, []);
    assert.equal(returnValue.trace.components[0].kind, 'gap');
});

test('synthesizeLeanTrace returns null when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const {returnValue} = await run({question: 'x', evidencePacket: {items: []}, signal: controller.signal});
    assert.equal(returnValue, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {computeDeltas, snapshot} from '../../src/planner/stream-events.js';

test('computeDeltas holds back in-progress narrative until final flush', () => {
    const previous = {title: null, narrative: [], components: []};
    const current = {
        title: 'Checkout Flow',
        narrative: ['The route receives the request.', 'The service stores the order.'],
        components: [],
    };

    assert.deepEqual(computeDeltas(previous, current), [
        {type: 'trace.title', title: 'Checkout Flow'},
        {
            type: 'narrative.patch',
            items: ['The route receives the request.'],
            startIndex: 0,
        },
    ]);
    assert.deepEqual(snapshot(current), {
        title: 'Checkout Flow',
        narrative: ['The route receives the request.'],
        components: [],
    });

    assert.deepEqual(computeDeltas(previous, current, {isFinal: true}), [
        {type: 'trace.title', title: 'Checkout Flow'},
        {
            type: 'narrative.patch',
            items: ['The route receives the request.', 'The service stores the order.'],
            startIndex: 0,
        },
    ]);
});

test('computeDeltas emits only renderable known component patches', () => {
    const previous = {title: null, narrative: [], components: []};
    const current = {
        title: null,
        narrative: [],
        components: [
            {
                type: 'evidence_callout',
                id: 'grounded',
                kind: 'grounded',
                summary: 'The source proves this behavior.',
                detail: 'The handler calls the service.',
                sourceRefs: [],
                confidence: 0.9,
                reason: null,
            },
            {
                type: 'evidence_callout',
                id: 'empty',
                kind: 'grounded',
                summary: '',
                detail: 'No summary means not renderable yet.',
                sourceRefs: [],
                confidence: 0.9,
                reason: null,
            },
            {
                type: 'unsupported_component',
                id: 'unknown',
                summary: 'Ignored.',
            },
        ],
    };

    assert.deepEqual(computeDeltas(previous, current), [{
        type: 'component.patch',
        index: 0,
        id: 'grounded',
        componentType: 'evidence_callout',
        props: current.components[0],
    }]);
});

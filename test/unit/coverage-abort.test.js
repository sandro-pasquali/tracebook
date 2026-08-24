import test from 'node:test';
import assert from 'node:assert/strict';
import {runCoverage} from '../../src/planner/phases/coverage.js';

function fakeTimer() {
    return {
        mark(name, extra = {}) {
            return {name, sinceStart: 0, sinceLast: 0, ...extra};
        }
    };
}

async function drain(generator) {
    const events = [];
    let step = await generator.next();
    while(!step.done) {
        events.push(step.value);
        step = await generator.next();
    }
    return {events, value: step.value};
}

test('coverage skips its backstop entirely when the client has already disconnected', async () => {
    const controller = new AbortController();
    controller.abort();
    const embedCalls = [];
    const {value} = await drain(runCoverage({
        explorationMessages: [],
        retrievalQuestion: 'How does the request flow work end to end?',
        question: 'How does the request flow work end to end?',
        fastPath: false,
        classification: {intent: 'explain_behavior', scope: 'system', preferredAnswerShapes: ['sequence_diagram']},
        corpusCoverage: null,
        governor: null,
        signal: controller.signal,
        embedder: {
            async embed(texts) {
                embedCalls.push(texts);
                return texts.map(() => [0, 0]);
            }
        },
        store: {},
        reranker: null,
        timer: fakeTimer()
    }));

    assert.equal(embedCalls.length, 0);
    assert.ok(value.evidencePacket);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {combineUsage, normalizeUsage, settleGovernorCall} from '../../src/planner/usage.js';

test('normalizeUsage accepts OpenAI-style and AI SDK-style usage shapes', () => {
    assert.deepEqual(normalizeUsage({
        promptTokens: 10,
        completionTokens: 4,
    }), {
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
    });

    assert.deepEqual(normalizeUsage({
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 12,
    }), {
        promptTokens: 7,
        completionTokens: 3,
        totalTokens: 12,
    });

    assert.deepEqual(normalizeUsage(null), {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
    });
});

test('combineUsage adds normalized token counts and preserves null when empty', () => {
    assert.equal(combineUsage(null, null), null);
    assert.deepEqual(combineUsage(
        {promptTokens: 10, completionTokens: 5},
        {inputTokens: 3, outputTokens: 2},
    ), {
        promptTokens: 13,
        completionTokens: 7,
        totalTokens: 20,
    });
});

test('settleGovernorCall records positive usage and releases missing usage', () => {
    const governor = fakeGovernor();
    const reservation = {id: 'call-a'};

    settleGovernorCall(governor, reservation, {inputTokens: 8, outputTokens: 2});
    assert.deepEqual(governor.afterCalls, [{tokens: 10, reservation}]);
    assert.deepEqual(governor.released, []);

    settleGovernorCall(governor, {id: 'call-b'}, null);
    assert.deepEqual(governor.released, [{id: 'call-b'}]);
});

function fakeGovernor() {
    return {
        afterCalls: [],
        released: [],
        afterCall(tokens, reservation) {
            this.afterCalls.push({tokens, reservation});
        },
        releaseCall(reservation) {
            this.released.push(reservation);
        },
    };
}

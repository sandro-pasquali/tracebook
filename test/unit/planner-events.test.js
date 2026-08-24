import test from 'node:test';
import assert from 'node:assert/strict';
import {
    sdkToolCallToPlannerEvent,
    sdkToolResultToPlannerArtifacts,
} from '../../src/planner/event-normalizer.js';

test('sdkToolCallToPlannerEvent converts SDK tool calls to canonical public events', () => {
    const event = sdkToolCallToPlannerEvent({
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'search_codebase',
        input: {query: 'checkout'},
    }, {
        summarizeInput(toolName, input) {
            return `${toolName}:${input.query}`;
        },
    });

    assert.deepEqual(event, {
        type: 'tool.call',
        tool: 'search_codebase',
        inputSummary: 'search_codebase:checkout',
    });
});

test('sdkToolResultToPlannerArtifacts converts SDK tool results and preserves tool messages', () => {
    const artifacts = sdkToolResultToPlannerArtifacts({
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'search_codebase',
        output: {count: 2},
    }, {
        startedAtMs: 100,
        now: () => 125,
        summarizeResult(toolName, output) {
            return `${toolName}:${output.count}`;
        },
        wrapOutput(output) {
            return {type: 'json', value: output};
        },
    });

    assert.deepEqual(artifacts, {
        event: {
            type: 'tool.result',
            tool: 'search_codebase',
            summary: 'search_codebase:2',
            durationMs: 25,
        },
        toolMessage: {
            role: 'tool',
            content: [{
                type: 'tool-result',
                toolCallId: 'call-1',
                toolName: 'search_codebase',
                output: {type: 'json', value: {count: 2}},
            }],
        },
        durationMs: 25,
    });
});

test('planner event normalizers ignore unrelated stream events', () => {
    assert.equal(sdkToolCallToPlannerEvent({type: 'text-delta'}), null);
    assert.equal(sdkToolResultToPlannerArtifacts({type: 'error', error: new Error('boom')}), null);
});

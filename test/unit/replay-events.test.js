import test from 'node:test';
import assert from 'node:assert/strict';
import {compactReplayEvents} from '../../src/util/replay-events.js';

test('compactReplayEvents keeps only replayable events and final component patch', () => {
    const compacted = compactReplayEvents([
        {
            type: 'trace.start', traceId: 'trc_a_123456', question: 'q', startedAt: 1,
        },
        {type: 'timing.checkpoint', name: 'ignored'},
        {
            type: 'component.patch',
            index: 0,
            id: 'code',
            componentType: 'annotated_code_excerpt',
            props: {caption: 'draft', transient: undefined},
        },
        {
            type: 'component.patch',
            index: 0,
            id: 'code',
            componentType: 'annotated_code_excerpt',
            props: {caption: 'final', transient: undefined},
        },
        {
            type: 'trace.complete', traceId: 'trc_a_123456', trace: {large: true}, featureTrace: {large: true},
        },
    ]);

    assert.equal(compacted.length, 3);
    assert.equal(compacted[1].props.caption, 'final');
    assert.equal('transient' in compacted[1].props, false);
    assert.equal('trace' in compacted[2], false);
    assert.equal('featureTrace' in compacted[2], false);
});

test('compactReplayEvents preserves public tool event order and strips internals', () => {
    const compacted = compactReplayEvents([
        {type: 'trace.start', traceId: 'trc_a_123456', question: 'q', startedAt: 1},
        {
            type: 'tool.call',
            tool: 'search_codebase',
            inputSummary: 'checkout',
            toolCallId: 'call-1',
            input: {query: 'checkout'},
        },
        {type: 'timing.checkpoint', name: 'tool.start'},
        {
            type: 'tool.result',
            tool: 'search_codebase',
            summary: '1 result',
            durationMs: 7,
            toolCallId: 'call-1',
            output: {count: 1},
        },
        {type: 'trace.error', code: 'boom', stage: 'exploration', message: 'failed', stack: 'hidden'},
    ]);

    assert.deepEqual(compacted.map((event) => event.type), [
        'trace.start',
        'tool.call',
        'tool.result',
        'trace.error',
    ]);
    assert.deepEqual(compacted[1], {
        type: 'tool.call',
        tool: 'search_codebase',
        inputSummary: 'checkout',
    });
    assert.deepEqual(compacted[2], {
        type: 'tool.result',
        tool: 'search_codebase',
        summary: '1 result',
        durationMs: 7,
    });
    assert.equal('stack' in compacted[3], false);
});

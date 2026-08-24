import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTraceError, classifyModelOutputError} from '../../src/planner/errors.js';

test('classifyModelOutputError distinguishes empty exhaustion from truncated output', () => {
    assert.deepEqual(classifyModelOutputError({
        finishReason: 'length',
        text: '',
        usage: {outputTokens: 2500}
    }, {maxOutputTokens: 2500}), {
        code: 'model_output_exhausted_before_answer',
        finishReason: 'length',
        outputTokens: 2500,
        maxOutputTokens: 2500,
        message: 'Model exhausted the 2500-token output budget without returning an answer.'
    });

    assert.equal(classifyModelOutputError({
        finishReason: 'length',
        text: '{"partial":'
    }, {maxOutputTokens: 900}).code, 'model_output_truncated');
    assert.equal(classifyModelOutputError({finishReason: 'stop', text: ''}), null);
});

test('buildTraceError surfaces output exhaustion instead of its downstream JSON error', () => {
    const err = new Error('JSON parsing failed: Unexpected end of JSON input');
    err.finishReason = 'length';
    err.text = '';
    err.usage = {outputTokens: 1500};

    const event = buildTraceError('outline_validation_failed', err, {
        stage: 'outline.validation',
        maxOutputTokens: 1500
    });

    assert.equal(event.message, 'Model exhausted the 1500-token output budget without returning an answer.');
    assert.equal(event.modelOutput.code, 'model_output_exhausted_before_answer');
    assert.match(event.error.message, /JSON parsing failed/v);
});

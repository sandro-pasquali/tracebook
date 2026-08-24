import assert from 'node:assert/strict';
import test from 'node:test';
import {z} from 'zod';
import {excerptSelectionSchema} from '../../src/planner/annotation-model.js';

test('excerpt selection schema is strict structured-output compatible', () => {
    const jsonSchema = z.toJSONSchema(excerptSelectionSchema);

    assert.deepEqual(Object.keys(jsonSchema.properties), ['rangeIndex']);
    assert.deepEqual(jsonSchema.required, ['rangeIndex']);
    assert.equal(jsonSchema.additionalProperties, false);
});

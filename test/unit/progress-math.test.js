import test from 'node:test';
import assert from 'node:assert/strict';
import {
    clampProgressRatio,
    indexingProgressMessage,
    indexingProgressRatio,
    isActiveIndexProgress,
    normalizeRevision,
    progressRatio
} from '../../src/server/progress-math.js';

test('progressRatio clamps to [0,1] and guards bad input', () => {
    assert.equal(progressRatio(0, 10), 0);
    assert.equal(progressRatio(5, 10), 0.5);
    assert.equal(progressRatio(10, 10), 1);
    assert.equal(progressRatio(20, 10), 1, 'over-total ratio clamps to 1');
    assert.equal(progressRatio(1, 0), 0, 'zero total is 0, not NaN/Infinity');
    assert.equal(progressRatio(Number.NaN, 10), 0);
    assert.equal(progressRatio(5, Number.POSITIVE_INFINITY), 0);
});

test('indexingProgressRatio maps file progress into the 0.14-0.94 span', () => {
    assert.equal(indexingProgressRatio(0, 135), 0.14, 'starts at the base');
    assert.equal(indexingProgressRatio(135, 135), 0.9400000000000001, 'ends at base+span');
    const mid = indexingProgressRatio(74, 135);
    assert.ok(mid > 0.14 && mid < 0.94, 'mid progress sits inside the span');
    assert.equal(indexingProgressRatio(0, 0), 0.14, 'empty repo holds at the base');
});

test('clampProgressRatio bounds values and rejects non-finite', () => {
    assert.equal(clampProgressRatio(-1), 0);
    assert.equal(clampProgressRatio(0.5), 0.5);
    assert.equal(clampProgressRatio(2), 1);
    assert.equal(clampProgressRatio(Number.NaN), 0);
});

test('isActiveIndexProgress detects only the *_start events', () => {
    assert.equal(isActiveIndexProgress({kind: 'source_start'}), true);
    assert.equal(isActiveIndexProgress({kind: 'dependency_start'}), true);
    assert.equal(isActiveIndexProgress({kind: 'source'}), false);
    assert.equal(isActiveIndexProgress({kind: 'embedding'}), false);
    assert.equal(isActiveIndexProgress(null), false);
});

test('indexingProgressMessage distinguishes dependency from source', () => {
    assert.match(indexingProgressMessage({kind: 'dependency_start'}), /dependency metadata/);
    assert.match(indexingProgressMessage({kind: 'source_start'}), /source files/);
    assert.match(indexingProgressMessage({}), /source files/, 'defaults to the source message');
});

test('normalizeRevision trims to a string or null', () => {
    assert.equal(normalizeRevision('  abc  '), 'abc');
    assert.equal(normalizeRevision(''), null);
    assert.equal(normalizeRevision('   '), null);
    assert.equal(normalizeRevision(null), null);
    assert.equal(normalizeRevision(undefined), null);
});

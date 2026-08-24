import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assignComponentEvidenceState,
    reconcileComponentSourceRefs,
    replaceUngroundedCodeWithGap
} from '../../src/planner/citation-provenance.js';

const evidence = [
    {path: './src/allowed.js', lineStart: 10, lineEnd: 30, content: 'allowed'},
    {path: 'src/other.js', lineStart: 40, lineEnd: 50, content: 'other'}
];

test('callout citations are restricted to the component evidence allowlist', () => {
    const component = {
        type: 'evidence_callout',
        kind: 'grounded',
        sourceRefs: [
            {path: 'src/unseen.js', lineStart: 1, lineEnd: 4},
            {path: 'src\\allowed.js', lineStart: 1, lineEnd: 100}
        ]
    };

    const result = reconcileComponentSourceRefs(component, evidence);

    assert.deepEqual(component.sourceRefs, [{path: 'src/allowed.js', lineStart: 10, lineEnd: 30}]);
    assert.equal(result.removed, 1);
});

test('diagram citations cannot escape the evidence allowlist or retrieved line range', () => {
    const component = {
        type: 'sequence_diagram',
        sourceRefs: [
            {path: '../outside.js', lineStart: 1, lineEnd: 2},
            {path: 'src/other.js', lineStart: 47, lineEnd: 99}
        ]
    };

    reconcileComponentSourceRefs(component, evidence);
    assignComponentEvidenceState(component);

    assert.deepEqual(component.sourceRefs, [{path: 'src/other.js', lineStart: 47, lineEnd: 50}]);
    assert.equal(component.evidenceState, 'inferred');
});

test('a same-path but non-overlapping model range is corrected to the retrieved evidence range', () => {
    const component = {
        type: 'evidence_callout',
        sourceRefs: [{path: 'src/allowed.js', lineStart: 1000, lineEnd: 1010}]
    };

    reconcileComponentSourceRefs(component, evidence);

    assert.deepEqual(component.sourceRefs, [{path: 'src/allowed.js', lineStart: 10, lineEnd: 30}]);
});

test('unverified annotated code is replaced by an explicit coverage gap', () => {
    const component = {
        id: 'invented-code',
        type: 'annotated_code_excerpt',
        caption: 'Invented source',
        code: 'doSomethingThatWasNeverRetrieved();',
        sourceRefs: [{path: 'src/invented.js', lineStart: 1, lineEnd: 1}]
    };

    reconcileComponentSourceRefs(component, evidence);
    const replaced = replaceUngroundedCodeWithGap(component, {id: 'invented-code', intent: 'show the implementation'});

    assert.equal(replaced, true);
    assert.equal(component.type, 'evidence_callout');
    assert.equal(component.kind, 'gap');
    assert.equal(component.gapReason, 'not_retrieved');
    assert.equal(component.evidenceState, 'coverage_gap');
    assert.doesNotMatch(component.detail, /doSomethingThatWasNeverRetrieved/v);
});

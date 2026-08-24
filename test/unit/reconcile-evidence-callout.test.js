import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileEvidenceCalloutKind} from '../../src/planner/synthesize-component.js';

function gapCallout(overrides = {}) {
    return {
        type: 'evidence_callout',
        kind: 'gap',
        sourceRefs: [{path: 'src/x.js', lineStart: 1, lineEnd: 10}],
        confidence: 0.9,
        summary: 's',
        detail: 'd',
        ...overrides
    };
}

test('gap with sourceRefs is reconciled to grounded without consulting model confidence', () => {
    const c = gapCallout({confidence: 0.9});
    reconcileEvidenceCalloutKind(c);
    assert.equal(c.kind, 'grounded');
});

test('gap with sourceRefs and low model confidence is still reconciled from evidence', () => {
    const c = gapCallout({confidence: 0.4});
    reconcileEvidenceCalloutKind(c);
    assert.equal(c.kind, 'grounded');
});

test('a genuine gap (no sourceRefs) is left as gap', () => {
    const c = gapCallout({sourceRefs: [], confidence: 0});
    reconcileEvidenceCalloutKind(c);
    assert.equal(c.kind, 'gap');
});

test('non-gap callouts are untouched', () => {
    const c = gapCallout({kind: 'grounded'});
    reconcileEvidenceCalloutKind(c);
    assert.equal(c.kind, 'grounded');
});

test('a grounded callout with no surviving sourceRefs is demoted to inferred', () => {
    const c = gapCallout({kind: 'grounded', sourceRefs: []});
    reconcileEvidenceCalloutKind(c);
    assert.equal(c.kind, 'inferred');
});

test('non-evidence_callout components are ignored', () => {
    const c = {type: 'annotated_code_excerpt', kind: 'gap', sourceRefs: [{path: 'a'}], confidence: 0.9};
    reconcileEvidenceCalloutKind(c);
    assert.equal(c.kind, 'gap');
});

test('a callout admitting the evidence lacks the target is coerced to gap', () => {
    const c = gapCallout({
        kind: 'inferred',
        summary: 'API endpoint patterns detected but the deletion endpoint is not shown',
        detail: 'The specific implementation of a story deletion endpoint is not shown in this evidence slice.',
        confidence: 0.8,
    });
    reconcileEvidenceCalloutKind(c);
    assert.equal(c.kind, 'gap');
});

test('a gap that cites refs while admitting absence stays a gap', () => {
    const c = gapCallout({
        detail: 'The evidence slice does not contain the actual handler definition.',
        confidence: 0.9,
    });
    reconcileEvidenceCalloutKind(c);
    assert.equal(c.kind, 'gap');
});

test('runtime behavior phrased with "not shown" is not mistaken for an evidence gap', () => {
    const c = gapCallout({
        kind: 'grounded',
        summary: 'Modal visibility',
        detail: 'The settings modal is not shown until the user clicks the gear icon.',
        confidence: 0.9,
    });
    reconcileEvidenceCalloutKind(c);
    assert.equal(c.kind, 'grounded');
});

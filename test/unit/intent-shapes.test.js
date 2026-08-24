import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyIntent} from '../../src/intent-classifier.js';

// Guards the intent→shape resolution. A question matching no scorer used to inherit
// INTENTS[0] (locate_source) shapes — callout-only — even though its resolved intent
// is explain_behavior, so dependency/setup questions never showed the wiring code.
// preferredAnswerShapes must be keyed on the RESOLVED intent.
//
const NO_CONTEXT = {chapters: [], sourcePaths: []};

test('a zero-score question is shaped from explain_behavior, so code excerpts are allowed', () => {
    const c = classifyIntent({question: 'what dependencies does the node server use to set up the server and routing?', storyContext: NO_CONTEXT});
    assert.equal(c.confidence, 0.35, 'this question matches no scorer (zero-score)');
    assert.equal(c.intent, 'explain_behavior', 'resolved intent is explain_behavior');
    assert.ok(c.preferredAnswerShapes.includes('annotated_code_excerpt'), 'shapes now allow a code excerpt');
});

test('a genuine locate_source question requires checkable source code', () => {
    const c = classifyIntent({question: 'where is the fuseByRrf function defined', storyContext: NO_CONTEXT});
    assert.equal(c.intent, 'locate_source');
    assert.deepEqual(c.preferredAnswerShapes, ['annotated_code_excerpt', 'evidence_callout']);
    assert.equal(c.allowsLean, false);
});

test('a scored behavior question is unchanged (full shape set)', () => {
    const c = classifyIntent({question: 'how does the server stream events back to the browser', storyContext: NO_CONTEXT});
    assert.ok(c.confidence > 0.35, 'scores > 0');
    assert.ok(c.preferredAnswerShapes.includes('annotated_code_excerpt'));
    assert.ok(c.preferredAnswerShapes.includes('evidence_callout'));
});

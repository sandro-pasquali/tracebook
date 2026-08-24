import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyIntent, formatIntentForPrompt} from '../../src/intent-classifier.js';
import {buildQuestionContext} from '../../src/planner/question-context.js';

test('classifyIntent recognizes visual API flow requests', () => {
    const classification = classifyIntent({
        question: 'Draw a sequence diagram for the API request and response flow',
    });

    assert.equal(classification.intent, 'explain_behavior');
    assert.equal(classification.scope, 'feature');
    assert.ok(classification.domains.includes('api'));
    assert.equal(classification.preferredAnswerShapes[0], 'sequence_diagram');
    assert.ok(classification.retrievalHints.some((hint) => hint.includes('API route endpoint')));
});

test('classifyIntent gives non-visual API questions an API boundary shape', () => {
    const classification = classifyIntent({
        question: 'How does the API work and how is it used?',
    });

    assert.equal(classification.intent, 'explain_behavior');
    assert.ok(classification.domains.includes('api'));
    assert.deepEqual(classification.preferredAnswerShapes.slice(0, 2), ['sequence_diagram', 'annotated_code_excerpt']);
});

test('classifyIntent recognizes direct code display requests', () => {
    const classification = classifyIntent({
        question: 'Show me the code for the checkout handler',
    });

    assert.equal(classification.intent, 'show_code');
    assert.equal(classification.scope, 'file');
    assert.equal(classification.preferredAnswerShapes[0], 'annotated_code_excerpt');
});

test('classifyIntent recognizes dependency and configuration questions', () => {
    const classification = classifyIntent({
        question: 'Which npm packages and config files control indexing?',
    });

    assert.ok(classification.retrievalHints.some((hint) => hint.includes('dependencies dependency')));
    assert.ok(classification.retrievalHints.some((hint) => hint.includes('database datastore')));
});

test('formatIntentForPrompt emits stable prompt fields', () => {
    const classification = classifyIntent({question: 'Compare the cache and trace replay behavior'});
    const formatted = formatIntentForPrompt(classification);

    assert.match(formatted, /## Comprehension intent/v);
    assert.match(formatted, /intent: compare/v);
    assert.match(formatted, /preferredAnswerShapes:/v);
});

test('buildQuestionContext retrieves on the raw question and keeps hints for exploration', () => {
    const question = 'How does the SSE API stream work?';
    const classification = classifyIntent({question});
    const context = buildQuestionContext({
        question,
        classification,
        storyContext: {chapters: [], sourcePaths: []},
    });

    // Retrieval embeds and lexically searches the raw question: the eval shows
    // hint-vocabulary expansion degrades recall everywhere and helps nowhere
    // (identifier queries unchanged), so the prefetch query stays clean.
    //
    assert.equal(context.answerQuestion, question);
    assert.equal(context.contextMessage, null);
    assert.equal(context.retrievalQuestion, question);
    assert.doesNotMatch(context.retrievalQuestion, /API route endpoint/v);

    // The expansion still frames the exploration model's task (not embedded or
    // searched), so it keeps the vocabulary guidance.
    //
    assert.match(context.explorationQuestion, /API route endpoint/v);
    assert.match(context.explorationQuestion, /stream event handler/v);
});

test('buildQuestionContext retells the prior story target for style follow-ups', () => {
    const classification = classifyIntent({
        question: 'Explain it visually',
        storyContext: {chapters: [{question: 'How does checkout work?'}]},
    });
    const context = buildQuestionContext({
        question: 'Explain it visually',
        classification,
        storyContext: {
            chapters: [{
                question: 'How does checkout work?',
                title: 'Checkout flow',
                narrative: ['The route validates the request.'],
                sourcePaths: ['src/checkout.js'],
            }],
            sourcePaths: ['src/server.js'],
        },
    });

    assert.match(context.answerQuestion, /^Retell the prior story/v);
    assert.match(context.retrievalQuestion, /How does checkout work/v);
    assert.match(context.contextMessage, /## Retelling target/v);
    assert.deepEqual(context.retellingTarget.sourcePaths, ['src/checkout.js', 'src/server.js']);
});

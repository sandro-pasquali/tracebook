import test from 'node:test';
import assert from 'node:assert/strict';
import {buildQuestionContext} from '../../src/planner/question-context.js';

// Guards the retrieval-query composition. A follow-up chapter must search for the
// CURRENT question's subject, not the previous chapter's topic — blending the prior
// chapter's natural-language question/title into the embedding demoted the file the
// new question was actually about (e.g. a "how does the server work" follow-up to a
// UI-flow chapter sank src/server.js from rank 1 to 5). The prior context still
// reaches the model via contextMessage; it just must not hijack file retrieval.
//
const STORY_CONTEXT = {
    chapters: [{question: 'PRIOR_QUESTION_TOKEN', title: 'PRIOR_TITLE_TOKEN', narrative: ['a prior step']}],
    sourcePaths: ['src/prior/anchor.js']
};

test('a substantive (non-retelling) follow-up searches the current question, not the prior topic', () => {
    const ctx = buildQuestionContext({
        question: 'How does the server work',
        storyContext: STORY_CONTEXT,
        classification: {isRetelling: false}
    });
    // The retrieval query is the current question + prior source paths only.
    //
    assert.match(ctx.retrievalQuestion, /How does the server work/);
    assert.match(ctx.retrievalQuestion, /src\/prior\/anchor\.js/);
    assert.doesNotMatch(ctx.retrievalQuestion, /PRIOR_QUESTION_TOKEN/, 'prior question must not pollute the retrieval embedding');
    assert.doesNotMatch(ctx.retrievalQuestion, /PRIOR_TITLE_TOKEN/, 'prior title must not pollute the retrieval embedding');

    // But the model still gets the prior chapter context for reasoning.
    //
    assert.match(ctx.contextMessage, /PRIOR_QUESTION_TOKEN/, 'prior context is still delivered via contextMessage');
});

test('a retelling follow-up still leans on the prior story content as its query', () => {
    const ctx = buildQuestionContext({
        question: 'explain it more simply',
        storyContext: STORY_CONTEXT,
        classification: {isRetelling: true}
    });
    // Retelling/style-only follow-ups have no subject of their own, so the prior
    // story content remains the retrieval query (unchanged behavior).
    //
    assert.match(ctx.retrievalQuestion, /PRIOR_QUESTION_TOKEN/, 'retelling keeps prior content as the query');
});

test('a single question with no story context is passed through unchanged', () => {
    const ctx = buildQuestionContext({
        question: 'where is fuseByRrf defined',
        storyContext: {chapters: [], sourcePaths: []},
        classification: {isRetelling: false}
    });
    assert.equal(ctx.retrievalQuestion, 'where is fuseByRrf defined');
    assert.equal(ctx.contextMessage, null);
});

test('an API follow-up drops prior source anchors from unrelated domains', () => {
    const ctx = buildQuestionContext({
        question: 'How does the API work and how is it used?',
        storyContext: {
            chapters: [{question: 'What does the repo do?', title: 'Indexing overview', narrative: ['It builds an index.']}],
            sourcePaths: [
                'src/index/store.js',
                'docs/indexing.md',
                'src/server/ask-route.js',
                'public/js/app/story-runner.js',
            ],
        },
        classification: {isRetelling: false, domains: ['api']},
    });

    assert.match(ctx.retrievalQuestion, /How does the API work/);
    assert.match(ctx.retrievalQuestion, /src\/server\/ask-route\.js/);
    assert.match(ctx.retrievalQuestion, /public\/js\/app\/story-runner\.js/);
    assert.doesNotMatch(ctx.retrievalQuestion, /src\/index\/store\.js/);
    assert.doesNotMatch(ctx.retrievalQuestion, /docs\/indexing\.md/);
});

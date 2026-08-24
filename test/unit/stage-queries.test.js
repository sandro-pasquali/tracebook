import test from 'node:test';
import assert from 'node:assert/strict';
import {coverageSeedQueries, parseStageQueries, wantsCoverageBackstop, componentSignature} from '../../src/planner/index.js';

test('parseStageQueries strips bullets/numbering and trims', () => {
    const text = '1. server route handler for ask endpoint\n- SSE streaming story blocks to browser\n* search the repository for code chunks';
    assert.deepEqual(parseStageQueries(text), [
        'server route handler for ask endpoint',
        'SSE streaming story blocks to browser',
        'search the repository for code chunks'
    ]);
});

test('parseStageQueries drops blank lines and caps the count', () => {
    const text = 'a\n\n  \nb\nc\nd\ne\nf';
    assert.deepEqual(parseStageQueries(text, 4), ['a', 'b', 'c', 'd']);
});

test('parseStageQueries handles empty/garbage input', () => {
    assert.deepEqual(parseStageQueries(''), []);
    assert.deepEqual(parseStageQueries(null), []);
    assert.deepEqual(parseStageQueries('   \n  '), []);
});

test('wantsCoverageBackstop fires for flows and deep behavioral questions, not narrow lookups', () => {
    // Flow/visual question (sequence_diagram answer shape).
    //
    assert.equal(wantsCoverageBackstop({preferredAnswerShapes: ['sequence_diagram']}), true);
    // "How does X work in detail" — explain_behavior at feature scope (the chapter-2 case).
    //
    assert.equal(wantsCoverageBackstop({intent: 'explain_behavior', scope: 'feature', preferredAnswerShapes: ['mermaid_figure']}), true);
    assert.equal(wantsCoverageBackstop({intent: 'explain_behavior', scope: 'system', preferredAnswerShapes: []}), true);
    // Narrow single-file lookup stays off the backstop.
    //
    assert.equal(wantsCoverageBackstop({intent: 'show_code', scope: 'file', preferredAnswerShapes: ['annotated_code_excerpt', 'mermaid_figure']}), false);
    assert.equal(wantsCoverageBackstop(null), false);
});

test('coverageSeedQueries adds reusable API boundary facets', () => {
    const queries = coverageSeedQueries({
        question: 'How does the API work and how is it used?',
        classification: {domains: ['api']},
    });

    assert.ok(queries.some((query) => query.includes('route endpoint registration')));
    assert.ok(queries.some((query) => query.includes('schema validation')));
    assert.ok(queries.some((query) => query.includes('client fetch')));
    assert.ok(queries.some((query) => query.includes('cache persistence')));
    assert.deepEqual(coverageSeedQueries({
        question: 'How does indexing work?',
        classification: {domains: ['data_storage']},
    }), []);
});

test('componentSignature keys by kind + source region so only same-kind same-region dupes collide', () => {
    const excerptA = {type: 'annotated_code_excerpt', sourceRefs: [{path: 'public/js/app/story-view.js', lineStart: 213, lineEnd: 272}]};
    const excerptB = {type: 'annotated_code_excerpt', sourceRefs: [{path: 'public/js/app/story-view.js', lineStart: 213, lineEnd: 272}]};
    const diagram = {type: 'sequence_diagram', sourceRefs: [{path: 'public/js/app/story-view.js', lineStart: 213, lineEnd: 272}]};

    // The chapter-2 duplicate: two excerpts of the same lines collide.
    //
    assert.equal(componentSignature(excerptA), componentSignature(excerptB));
    // A diagram on the same lines is a different visualization, not a duplicate.
    //
    assert.notEqual(componentSignature(excerptA), componentSignature(diagram));
    // No source region -> no signature (gap callouts never dedupe against each other).
    //
    assert.equal(componentSignature({type: 'evidence_callout', sourceRefs: []}), null);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyQueryShape, retrievalPolicyForShape} from '../../src/util/query-shape.js';

// The classifier must be language-agnostic: identifier conventions from every
// supported ecosystem (camelCase JS, snake_case Python/Rust, PascalCase Go/Java,
// SCREAMING_SNAKE configs) count as code-shaped, while plain product language —
// the non-engineer persona's phrasing — never does.
//

test('code-shaped tokens across language conventions classify as identifier', () => {
    const questions = [
        'where is fuseByRrf defined',
        'where is from_prefixed_env implemented',
        'where is HYDE_MIN_SIMILARITY configured',
        'where is SecureCookieSessionInterface defined',
        'where is ServeHTTP implemented',
        'where is the url_for helper function implemented',
        'how does src/flask/app.py dispatch requests',
        'where is store.searchByText() called from',
        'what does `wsgi_app` do'
    ];
    for(const question of questions) {
        assert.equal(classifyQueryShape(question), 'identifier', question);
    }
});

test('plain product language classifies as product', () => {
    const questions = [
        'how is a repeated question served from saved results instead of recomputing the response',
        'what keeps the search corpus current when files change on disk',
        'how does the framework clean up resources once a request is finished',
        'what happens when an unhandled error occurs while serving a request',
        'how are search results re-ordered by how well they answer the question',
        'how is each file summarized in plain language for non-engineers',
        'how is a large file divided into overlapping windows before embedding'
    ];
    for(const question of questions) {
        assert.equal(classifyQueryShape(question), 'product', question);
    }
});

test('tech-flavored product phrasing falls back to relational, never identifier — the conservative full-pipeline bucket', () => {
    const questions = [
        'how does a visitor stay signed in between page loads',
        'how are settings loaded from environment variables or a settings file'
    ];
    for(const question of questions) {
        assert.notEqual(classifyQueryShape(question), 'identifier', question);
    }
});

test('sentence punctuation and abbreviations are not code tokens', () => {
    const questions = [
        'how are files cleaned up, e.g. after a request finishes?',
        'what runs first, i.e. before anything is indexed?',
        'how do imports work vs. plain copies?'
    ];
    for(const question of questions) {
        assert.equal(classifyQueryShape(question), 'product', question);
    }
});

test('two registry technologies or an integration verb classify as relational', () => {
    assert.equal(classifyQueryShape('how do javascript and css work together to render the page'), 'relational');
    assert.equal(classifyQueryShape('how does the app integrate with python for scripting'), 'relational');
    // Package names the language registry cannot know — the verb phrase alone
    // must carry it (manifest demotion depends on the relational policy).
    //
    assert.equal(classifyQueryShape('how do hono and vite work together'), 'relational');
    assert.equal(classifyQueryShape('how does flask use itsdangerous to sign the session cookie'), 'relational');
});

test('a technology name alone is not an identifier token', () => {
    const shape = classifyQueryShape('how is python used in this project');
    assert.notEqual(shape, 'identifier');
});

test('empty and blank questions default to product', () => {
    assert.equal(classifyQueryShape(''), 'product');
    assert.equal(classifyQueryShape('   '), 'product');
    assert.equal(classifyQueryShape(null), 'product');
});

test('retrievalPolicyForShape only alters the product shape, per arm', () => {
    const full = {legs: {lexical: true, graph: true, domainBoost: true}, rerank: true};
    for(const shape of ['identifier', 'relational']) {
        for(const arm of ['production', 'no-domain-for-product', 'lexical-for-product', 'tiebreak-for-product']) {
            assert.deepEqual(retrievalPolicyForShape(shape, {arm}), full, `${shape}/${arm}`);
        }
    }
    assert.deepEqual(retrievalPolicyForShape('product'), full);
    assert.deepEqual(retrievalPolicyForShape('product', {arm: 'no-domain-for-product'}).legs.domainBoost, false);
    const lexical = retrievalPolicyForShape('product', {arm: 'lexical-for-product'});
    assert.equal(lexical.legs.domainBoost, false);
    assert.equal(lexical.rerank, false);
    assert.equal(retrievalPolicyForShape('product', {arm: 'tiebreak-for-product'}).legs.domainBoost, 'tiebreak');
    assert.throws(() => retrievalPolicyForShape('product', {arm: 'bogus'}), /unknown query-shape arm/);
});

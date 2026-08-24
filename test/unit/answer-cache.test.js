import test from 'node:test';
import assert from 'node:assert/strict';
import {createAnswerCache} from '../../src/util/answer-cache.js';

test('answer cache returns only matching source revisions', () => {
    const cache = createAnswerCache({ttlMs: 60_000, cap: 2});
    const events = [{type: 'trace.complete', traceId: 'trc_abc_123def'}];

    cache.set('How does caching work?', events, {sourceRevision: 'rev-a'});

    assert.equal(cache.get('How does caching work?', {sourceRevision: 'rev-a'}).events.length, 1);
    assert.equal(cache.get('How does caching work?', {sourceRevision: 'rev-b'}), null);
});

test('answer cache evicts least recently used entries at cap', () => {
    const cache = createAnswerCache({ttlMs: 60_000, cap: 2});
    const events = [{type: 'trace.title', title: 'ok'}];

    cache.set('a', events, {sourceRevision: 'rev'});
    cache.set('b', events, {sourceRevision: 'rev'});
    assert.ok(cache.get('a', {sourceRevision: 'rev'}));
    cache.set('c', events, {sourceRevision: 'rev'});

    assert.ok(cache.get('a', {sourceRevision: 'rev'}));
    assert.equal(cache.get('b', {sourceRevision: 'rev'}), null);
    assert.ok(cache.get('c', {sourceRevision: 'rev'}));
});

test('answer cache ttl 0 disables age expiration', () => {
    const cache = createAnswerCache({ttlMs: 0, cap: 2});
    cache.set('q', [{type: 'trace.title', title: 'cached'}], {sourceRevision: 'rev'});

    assert.ok(cache.get('q', {sourceRevision: 'rev'}));
});

test('answer cache refuses writes while the index has no source revision', () => {
    const cache = createAnswerCache({ttlMs: 60_000, cap: 2});
    const events = [{type: 'trace.title', title: 'mid-rebuild answer'}];

    // A null/missing revision means a full re-index is in flight: the answer
    // may be built on partial evidence and must not enter the cache (nor evict
    // a live entry).
    //
    cache.set('resident', events, {sourceRevision: 'rev'});
    cache.set('poisoned', events, {sourceRevision: null});
    cache.set('poisoned-too', events, {});

    assert.equal(cache.snapshot().size, 1);
    assert.ok(cache.get('resident', {sourceRevision: 'rev'}));
    assert.equal(cache.get('poisoned', {sourceRevision: 'rev'}), null);
});

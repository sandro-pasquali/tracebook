import test from 'node:test';
import assert from 'node:assert/strict';
import {createTraceIndexer} from '../../src/index/trace-indexer.js';

test('trace indexer persists completed traces with one embedded question summary', async () => {
    const embedder = fakeEmbedder([[0.1, 0.2]]);
    const store = fakeTraceStore();
    const traceIndexer = createTraceIndexer({store, embedder});

    const persisted = await traceIndexer.persistTrace({
        traceId: 'trc_test',
        question: 'How does checkout work?',
        timestamp: 123,
        trace: {
            title: 'Checkout flow',
            narrative: ['The route validates the request.'],
            components: [{type: 'evidence_callout'}, {type: 'sequence_diagram'}],
        },
    });

    assert.equal(persisted.traceId, 'trc_test');
    assert.equal(persisted.timestamp, 123);
    assert.equal(persisted.questionHash.length, 40);
    assert.deepEqual(embedder.calls, [['How does checkout work?\nThe route validates the request.']]);
    assert.deepEqual(store.upserted[0], {
        traceId: 'trc_test',
        questionHash: persisted.questionHash,
        question: 'How does checkout work?',
        summary: 'The route validates the request.',
        componentKinds: ['evidence_callout', 'sequence_diagram'],
        timestamp: 123,
        embedding: [0.1, 0.2],
    });
});

test('trace indexer lookup reuses provided embeddings and embeds query wrapper once', async () => {
    const embedder = fakeEmbedder([[0.4, 0.5]]);
    const store = fakeTraceStore([{trace_id: 'prior'}]);
    const traceIndexer = createTraceIndexer({store, embedder});

    assert.deepEqual(await traceIndexer.findSimilar({questionEmbedding: [0.2, 0.3], limit: 2}), [{trace_id: 'prior'}]);
    assert.deepEqual(embedder.calls, []);
    assert.deepEqual(store.searches[0].embedding, [0.2, 0.3]);
    assert.equal(store.searches[0].limit, 2);

    assert.deepEqual(await traceIndexer.findSimilarByQuery('checkout', {limit: 1}), [{trace_id: 'prior'}]);
    assert.deepEqual(embedder.calls, [['checkout']]);
    assert.deepEqual(store.searches[1].embedding, [0.4, 0.5]);
    assert.equal(store.searches[1].limit, 1);
});

test('trace indexer prune delegates to store with a TTL cutoff', async () => {
    const traceIndexer = createTraceIndexer({
        embedder: fakeEmbedder(),
        store: fakeTraceStore(),
    });

    assert.equal(await traceIndexer.prune(), 3);
});

function fakeEmbedder(vectors = [[0]]) {
    return {
        calls: [],
        async embed(values) {
            this.calls.push([...values]);
            return vectors;
        },
    };
}

function fakeTraceStore(searchRows = []) {
    return {
        upserted: [],
        searches: [],
        async upsertTrace(row) {
            this.upserted.push(row);
        },
        async searchTraces(embedding, limit, options) {
            this.searches.push({embedding, limit, options});
            return searchRows;
        },
        async pruneTracesOlderThan(cutoff) {
            assert.equal(typeof cutoff, 'number');
            return 3;
        },
    };
}

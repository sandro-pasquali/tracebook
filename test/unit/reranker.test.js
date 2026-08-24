import test from 'node:test';
import assert from 'node:assert/strict';
import {createReranker} from '../../src/index/reranker.js';

// The reranker model must cap onnxruntime-node's intra-op thread pool the same way
// the embedder does. Inject loader seams so no real model is loaded; capture the
// options handed to the sequence-classification model loader.
//
test('reranker passes a capped intraOpNumThreads to the model loader', async () => {
    let captured = null;
    const reranker = createReranker({
        model: 'fake/reranker',
        enabled: true,
        numThreads: 4,
        tokenizerLoader: async () => (queries, options) => ({input_ids: queries, options}),
        modelLoader: async (modelId, options) => {
            captured = options;
            return async () => ({logits: {tolist: () => [[0.9]]}});
        }
    });

    await reranker.rerank('query', [{path: 'a.js', content: 'x', lineStart: 1, lineEnd: 1}]);

    assert.ok(captured, 'model loader was invoked');
    assert.ok(captured.session_options, 'session_options must be passed');
    assert.equal(captured.session_options.intraOpNumThreads, 4, 'explicit 4 threads (under the cap of 8)');
});

test('reranker returns null when disabled or model missing', () => {
    assert.equal(createReranker({model: 'm', enabled: false}), null);
    assert.equal(createReranker({enabled: true}), null);
});

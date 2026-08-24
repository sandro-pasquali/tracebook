import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmbedder} from '../../src/index/embedder.js';
import {resolveModelThreads} from '../../src/util/model-threads.js';

test('resolveModelThreads uses half the cores, hard-capped at 8', () => {
    assert.equal(resolveModelThreads(0, 8), 4);
    assert.equal(resolveModelThreads(0, 15), 7);
    assert.equal(resolveModelThreads(0, 32), 8, 'half=16 is capped to 8');
    assert.equal(resolveModelThreads(0, 1), 1, 'never below 1');
    assert.equal(resolveModelThreads(2, 32), 2, 'explicit value wins under the cap');
    assert.equal(resolveModelThreads(12, 32), 8, 'explicit value is clamped to the cap');
});

test('local embedder caps onnx intra-op threads via session_options', async () => {
    let captured = null;
    const fakePipeline = async (task, model, options) => {
        captured = {task, model, options};
        return async (inputs) => ({tolist: () => inputs.map(() => [0, 0])});
    };
    const embedder = createEmbedder({
        model: 'some/local-model',
        dims: 2,
        numThreads: 4,
        queryPrefix: '',
        docPrefix: '',
        cacheCap: 0,
        pipelineFactory: fakePipeline,
    });

    await embedder.embed(['hello'], {type: 'document'});

    assert.equal(captured.task, 'feature-extraction');
    assert.ok(captured.options.session_options, 'session_options must be passed');
    assert.equal(captured.options.session_options.intraOpNumThreads, 4);
});

// The type-aware embed API applies the query vs document instruction prefix
// (empty for symmetric models, set for the asymmetric escalation rung). Uses the
// embedImpl test seam so no model is loaded.
//
test('embed applies query vs document prefixes by type', async () => {
    const seen = [];
    const embedder = createEmbedder({
        embedImpl: async (inputs) => {
            seen.push(...inputs);
            return inputs.map(() => [0, 0]);
        },
        queryPrefix: 'QUERY: ',
        docPrefix: 'DOC: ',
        dims: 2,
        cacheCap: 100
    });

    await embedder.embed(['validate session token'], {type: 'query'});
    await embedder.embed(['function validate(token) {}'], {type: 'document'});
    await embedder.embed(['defaults to document']);

    assert.ok(seen.includes('QUERY: validate session token'), JSON.stringify(seen));
    assert.ok(seen.includes('DOC: function validate(token) {}'), JSON.stringify(seen));
    assert.ok(seen.includes('DOC: defaults to document'), JSON.stringify(seen));
});

test('embed returns one vector per input and caches by prefixed value', async () => {
    let calls = 0;
    const embedder = createEmbedder({
        embedImpl: async (inputs) => {
            calls += inputs.length;
            return inputs.map(() => [1, 0]);
        },
        queryPrefix: '',
        docPrefix: '',
        dims: 2,
        cacheCap: 100
    });

    const first = await embedder.embed(['a', 'b'], {type: 'document'});
    assert.equal(first.length, 2);
    await embedder.embed(['a', 'b'], {type: 'document'});
    assert.equal(calls, 2, 'second identical call should be served from cache');
});

// The local model is a single ONNX session that must not be entered concurrently.
// indexAll runs files in parallel, so overlapping embed() calls must still feed
// the model one batch at a time.
//
test('concurrent embed calls never overlap an in-flight model run', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let resolveGate;
    const gate = new Promise((resolve) => {
        resolveGate = resolve;
    });
    let firstEntered;
    const firstEnteredPromise = new Promise((resolve) => {
        firstEntered = resolve;
    });

    const embedder = createEmbedder({
        embedImpl: async (inputs) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            firstEntered();
            // Hold the first batch open so a second call would overlap if it could.
            //
            await gate;
            inFlight--;
            return inputs.map(() => [0, 0]);
        },
        queryPrefix: '',
        docPrefix: '',
        dims: 2,
        cacheCap: 0
    });

    const first = embedder.embed(['x'], {type: 'document'});
    await firstEnteredPromise;
    const second = embedder.embed(['y'], {type: 'document'});
    resolveGate();
    await Promise.all([first, second]);

    assert.equal(maxInFlight, 1, 'model runs must be serialized');
});

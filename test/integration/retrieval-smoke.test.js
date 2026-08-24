import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../../src/index/store.js';
import {createIndexer} from '../../src/index/indexer.js';
import {runSearch} from '../../src/tools/search.js';

// Enforced (fast, deterministic, offline) END-TO-END retrieval gate. A handful
// of fixture files carry their answer in their *content* (a comment), NOT their
// filename, and the questions avoid path tokens — so runSearch must pick the
// right file out of several competitors via real content retrieval, not filename
// matching. If the retrieval pipeline (indexAll → FTS/vector → fusion → re-rank)
// breaks as a whole, this fails.
//
// Scope notes (kept honest): a stub embedder is used, so the dense leg returns
// all files equidistant — the FTS leg and the content re-rank are redundant here
// (either alone surfaces the target), so this is a broad pipeline gate, not a
// component-isolation test. Those are covered separately: FTS-searchable-through-
// indexAll in fts-search.test.js, FTS directly in store-lexical.test.js, the
// lexical leg and graph ranking in unit/search.test.js, and semantic-embedding
// quality in the manual benchmark test/eval/retrieval-eval.js.
//
function stubEmbedder(dims = 8) {
    const vector = Array.from({length: dims}, (_, i) => (i === 0 ? 1 : 0));
    return {
        dims,
        provider: 'stub',
        model: 'stub',
        async embed(items) {
            return items.map(() => Float32Array.from(vector));
        }
    };
}

const FIXTURES = {
    'src/auth.js': '// Validate the session token signature for an authenticated request.\nexport function validateAuthToken(token) { return verify(token); }\n',
    'src/billing.js': '// Charge a customer credit card through the payment gateway.\nexport function chargeCard(amount) { return gateway.charge(amount); }\n',
    'src/notify.js': '// Send a welcome email message to a newly registered user.\nexport function sendWelcome(user) { return mailer.deliver(user); }\n',
    'src/scheduler.js': '// Enqueue a delayed background job to run after a timeout.\nexport function schedule(job, delayMs) { return queue.push(job, delayMs); }\n',
    'src/geo.js': '// Compute the distance between two map coordinates with the haversine formula.\nexport function measure(a, b) { return haversine(a, b); }\n',
    'src/config.js': '// Read and validate environment variables on startup.\nexport function load() { return process.env; }\n'
};

const CASES = [
    {question: 'how is a session token signature validated for a request', expect: 'src/auth.js'},
    {question: 'where is a customer credit card charged through the payment gateway', expect: 'src/billing.js'},
    {question: 'how do we send a welcome email to a newly registered user', expect: 'src/notify.js'},
    {question: 'how is a delayed background job run after a timeout', expect: 'src/scheduler.js'},
    {question: 'how is the distance between two map coordinates computed', expect: 'src/geo.js'}
];

test('runSearch retrieves the right file by content among competitors (no filename leak)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-retrieval-smoke-'));
    const indexRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-retrieval-smoke-index-'));
    await fs.mkdir(path.join(root, 'src'), {recursive: true});
    for(const [rel, content] of Object.entries(FIXTURES)) {
        await fs.writeFile(path.join(root, rel), content);
    }

    const embedder = stubEmbedder(8);
    const store = await createStore({root: indexRoot, dims: embedder.dims});
    const indexer = createIndexer({root, include: ['**/*.js'], exclude: [], embedder, store});
    await indexer.indexAll();

    const limit = 3;
    for(const testCase of CASES) {
        const result = await runSearch({queryText: testCase.question, embedder, store, limit});
        const paths = result.results.map((row) => row.path);
        assert.ok(
            paths.slice(0, limit).includes(testCase.expect),
            `"${testCase.question}" → expected ${testCase.expect} in top ${limit}, got ${JSON.stringify(paths)}`
        );
    }

    await fs.rm(root, {recursive: true, force: true});
    await fs.rm(indexRoot, {recursive: true, force: true});
});

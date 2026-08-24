import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../../src/index/store.js';
import {createIndexer} from '../../src/index/indexer.js';
import {runSearch} from '../../src/tools/search.js';

// End-to-end coverage for the real LanceDB store driven through the indexer:
// index a tiny repo, then confirm BM25 full-text search is actually built and
// searchable — both directly (content + graph) and through runSearch — and that
// runSearch returns a numeric similarity (the planner's gating contract).
//
// NOTE: this does NOT by itself guard the optimize()-after-indexAll call.
// LanceDB 0.29 searches the unindexed tail in a row-count-dependent way (small
// tables need optimize(); larger ones happen to be searchable without it), so a
// real-store toggle test is unreliable. The *call* to store.optimize() from
// indexAll is guarded deterministically in test/integration/indexer.test.js, and
// that optimize() makes freshly-added graph rows searchable is covered in
// test/integration/store-lexical.test.js.
//
// A deterministic stub embedder is used because FTS needs no real vectors and it
// keeps the test fast and offline.
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

test('indexAll builds an FTS index that is searchable directly and via runSearch', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-fts-repo-'));
    const indexRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-fts-index-'));
    await fs.writeFile(path.join(root, 'widget-server.js'), [
        "import {Hono} from 'hono';",
        'const app = new Hono();',
        "app.get('/health', (c) => c.json({ok: true}));",
        "export function renderWidgetPanel() { return 'widget'; }",
        ''
    ].join('\n'));

    const embedder = stubEmbedder(8);
    const store = await createStore({root: indexRoot, dims: embedder.dims});
    const indexer = createIndexer({root, include: ['**/*.js'], exclude: [], embedder, store});

    await indexer.indexAll();

    // 1) Chunk-content FTS is searchable through the indexer (the optimize() guard).
    //
    const byContent = await store.searchByText('renderWidgetPanel', 5);
    assert.ok(
        byContent.some((row) => row.path === 'widget-server.js'),
        `searchByText found nothing — FTS index not searchable after indexAll: ${JSON.stringify(byContent)}`
    );

    // 2) Code-graph FTS is searchable too (route fact extracted during indexAll).
    //
    const byGraph = await store.searchGraphByText('/health', 5);
    assert.ok(
        byGraph.some((row) => row.kind === 'route' && row.target === '/health'),
        `searchGraphByText found no route fact: ${JSON.stringify(byGraph)}`
    );

    // 3) End-to-end runSearch returns the file and carries a numeric similarity,
    //    which the planner's fast-path/HyDE gating reads off results[].similarity.
    //
    const result = await runSearch({queryText: 'where is the widget panel rendered', embedder, store, limit: 5});
    const hit = result.results.find((row) => row.path === 'widget-server.js');
    assert.ok(hit, `runSearch did not return the indexed file: ${JSON.stringify(result.results.map((r) => r.path))}`);
    assert.equal(typeof hit.similarity, 'number');

    await fs.rm(root, {recursive: true, force: true});
    await fs.rm(indexRoot, {recursive: true, force: true});
});

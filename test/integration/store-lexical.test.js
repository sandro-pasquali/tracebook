import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../../src/index/store.js';

test('store lexical search uses indexed terms for source chunks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-store-lexical-'));
    const store = await createStore({root, dims: 2});

    await store.upsertFile('src/index/indexer.js', [{
        path: 'src/index/indexer.js',
        lineStart: 1,
        lineEnd: 4,
        content: 'export function createIndexer() {\n    return {indexAll, indexFile};\n}\n',
        embedding: [0, 0],
        contentHash: 'hash-a',
    }]);
    await store.optimize();

    const rows = await store.searchByText('createIndexer', 3);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, 'src/index/indexer.js');
    assert.match(rows[0].content, /createIndexer/);
});

test('store graph lexical search uses indexed terms for code graph rows', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-store-graph-lexical-'));
    const store = await createStore({root, dims: 2});

    await store.upsertFile('src/server.js', [{
        path: 'src/server.js',
        lineStart: 10,
        lineEnd: 20,
        content: "app.get('/api/health', async (c) => c.json({ok: true}));\n",
        embedding: [0, 0],
        contentHash: 'hash-b',
    }]);
    await store.upsertCodeGraph('src/server.js', [{
        lineStart: 10,
        lineEnd: 10,
        kind: 'route',
        name: 'GET /api/health',
        target: '/api/health',
        detail: 'declares an HTTP route',
        syntax: {engine: 'scanner'},
        contentHash: 'hash-b',
    }]);
    await store.optimize();

    const rows = await store.searchGraphByText('/api/health', 3);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'route');
    assert.equal(rows[0].target, '/api/health');
});

test('store text search tolerates empty, punctuation-only, and quoted queries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-store-fts-edge-'));
    const store = await createStore({root, dims: 2});

    await store.upsertFile('src/widget.js', [{
        path: 'src/widget.js',
        lineStart: 1,
        lineEnd: 2,
        content: 'export function renderWidget() { return true; }\n',
        embedding: [0, 0],
        contentHash: 'hash-c',
    }]);
    await store.optimize();

    // Empty / whitespace / punctuation-only queries return no matches, never throw.
    //
    assert.deepEqual(await store.searchByText('', 3), []);
    assert.deepEqual(await store.searchByText('   ', 3), []);
    assert.deepEqual(await store.searchByText('()', 3), []);

    // A double-quoted query (FTS phrase syntax) must not throw; quotes are
    // neutralized and the remaining terms still match.
    //
    const quoted = await store.searchByText('"renderWidget"', 3);
    assert.equal(quoted.length, 1);
    assert.equal(quoted[0].path, 'src/widget.js');
});

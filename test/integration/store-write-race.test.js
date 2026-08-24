import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createIndexer} from '../../src/index/indexer.js';
import {createStore} from '../../src/index/store.js';

function chunkRow(rel, content, hash) {
    return {
        path: rel,
        lineStart: 1,
        lineEnd: 3,
        content,
        embedding: [1, 0],
        contentHash: hash
    };
}

async function makeStore() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-store-race-'));
    return createStore({root, dims: 2});
}

test('applyBatch commits delete and re-add as one gated block', async () => {
    const store = await makeStore();
    await store.applyBatch({
        chunkRows: [chunkRow('src/app.js', 'const alphatoken = "old";', 'hash-old')]
    });

    // Kick off the rewrite without awaiting it, then search immediately. The
    // read gate must hold the search until the whole delete+add block commits,
    // so it sees the new rows — never the deleted-but-not-readded gap.
    //
    const commit = store.applyBatch({
        deletePaths: ['src/app.js'],
        chunkRows: [chunkRow('src/app.js', 'const alphatoken = "new";', 'hash-new')]
    });
    const rows = await store.searchByEmbedding([1, 0], 10);
    await commit;

    assert.equal(rows.length, 1);
    assert.match(rows[0].content, /new/);
    await store.close();
});

test('searches during repeated rewrite batches never observe a missing file', async () => {
    const store = await makeStore();
    await store.applyBatch({
        chunkRows: [chunkRow('src/hot.js', 'export const alphatoken = 0;', 'hash-0')]
    });

    for(let i = 1; i <= 10; i++) {
        const commit = store.applyBatch({
            deletePaths: ['src/hot.js'],
            chunkRows: [chunkRow('src/hot.js', `export const alphatoken = ${i};`, `hash-${i}`)]
        });
        const rows = await store.searchByText('alphatoken', 5);
        assert.ok(rows.length >= 1, `search at cycle ${i} observed the deleted gap`);
        await commit;
        assert.equal(await store.getContentHash('src/hot.js'), `hash-${i}`);
    }
    await store.close();
});

test('applyBatch covers graph rows and removal-only batches', async () => {
    const store = await makeStore();
    await store.applyBatch({
        chunkRows: [chunkRow('src/api.js', 'app.get("/health");', 'hash-a')],
        graphRows: [{
            path: 'src/api.js',
            lineStart: 1,
            lineEnd: 1,
            kind: 'route',
            name: 'GET /health',
            target: '/health',
            detail: 'declares an HTTP route',
            syntax: {engine: 'scanner'},
            contentHash: 'hash-a'
        }]
    });
    assert.equal(await store.count(), 1);
    assert.equal(await store.countCodeGraph(), 1);

    await store.applyBatch({deletePaths: ['src/api.js']});
    assert.equal(await store.count(), 0);
    assert.equal(await store.countCodeGraph(), 0);
    await store.close();
});

test('per-file and batched indexing land identical contents in a real store', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-parity-repo-'));
    await fs.mkdir(path.join(repoRoot, 'src'), {recursive: true});
    await fs.writeFile(path.join(repoRoot, 'src', 'app.js'), 'import {route} from "./route.js";\nexport function app() {\n    return route();\n}\n');
    await fs.writeFile(path.join(repoRoot, 'src', 'route.js'), 'export function route() {\n    return "ok";\n}\n');
    const embedder = {
        async embed(items) {
            return items.map((text) => [text.length % 7, 1]);
        }
    };

    async function indexedStore(run) {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-parity-store-'));
        const store = await createStore({root, dims: 2});
        const indexer = createIndexer({
            root: repoRoot,
            include: ['**/*.js'],
            exclude: [],
            embedder,
            store,
            indexDependencies: false
        });
        await run(indexer);
        return store;
    }

    const batchStore = await indexedStore((indexer) => indexer.indexAll());
    const singleStore = await indexedStore(async (indexer) => {
        await indexer.indexFile('src/app.js');
        await indexer.indexFile('src/route.js');
    });

    assert.deepEqual(await singleStore.knownPaths(), await batchStore.knownPaths());
    for(const rel of await batchStore.knownPaths()) {
        assert.equal(await singleStore.getContentHash(rel), await batchStore.getContentHash(rel));
    }
    assert.equal(await singleStore.count(), await batchStore.count());
    assert.equal(await singleStore.countCodeGraph(), await batchStore.countCodeGraph());
    await Promise.all([singleStore.close(), batchStore.close()]);
});

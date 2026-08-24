import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../../src/index/store.js';

const FINGERPRINT_A = {provider: 'local', model: 'model-a', dims: 2, dtype: 'fp32', docPrefix: ''};
const FINGERPRINT_B = {provider: 'local', model: 'model-b', dims: 2, dtype: 'q8', docPrefix: 'passage: '};

async function seededStore(root, {dims = 2, fingerprint = FINGERPRINT_A} = {}) {
    const store = await createStore({root, dims, fingerprint});
    await store.applyBatch({
        chunkRows: [{
            path: 'src/app.js',
            lineStart: 1,
            lineEnd: 2,
            content: 'export const app = 1;',
            embedding: Array.from({length: dims}, () => 0.5),
            contentHash: 'hash-a'
        }]
    });
    await store.upsertTrace({
        traceId: 'trc_meta_aaa111',
        questionHash: 'qh',
        question: 'How does app work?',
        summary: 'It works.',
        componentKinds: [],
        timestamp: Date.now(),
        embedding: Array.from({length: dims}, () => 0.5)
    });
    return store;
}

test('reopening a store with the same embedding configuration keeps its rows', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-store-meta-'));
    const first = await seededStore(root);
    await first.close();

    const reopened = await createStore({root, dims: 2, fingerprint: FINGERPRINT_A});
    assert.equal(await reopened.count(), 1);
    assert.equal(await reopened.countTraces(), 1);
    await reopened.close();
});

test('a changed embedding fingerprint rebuilds all tables and updates the meta', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-store-meta-'));
    const first = await seededStore(root);
    await first.close();

    const reopened = await createStore({root, dims: 2, fingerprint: FINGERPRINT_B});
    assert.equal(await reopened.count(), 0);
    assert.equal(await reopened.countTraces(), 0);
    assert.equal(await reopened.countCodeGraph(), 0);
    const meta = JSON.parse(await fs.readFile(path.join(root, 'store-meta.json'), 'utf8'));
    assert.deepEqual(meta.fingerprint, FINGERPRINT_B);

    // The rebuilt tables accept writes under the new configuration.
    //
    await reopened.applyBatch({
        chunkRows: [{
            path: 'src/app.js',
            lineStart: 1,
            lineEnd: 2,
            content: 'export const app = 2;',
            embedding: [0.1, 0.9],
            contentHash: 'hash-b'
        }]
    });
    assert.equal(await reopened.count(), 1);
    await reopened.close();
});

test('a store without meta is grandfathered instead of rebuilt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-store-meta-'));
    const first = await seededStore(root);
    await first.close();
    await fs.rm(path.join(root, 'store-meta.json'), {force: true});

    const reopened = await createStore({root, dims: 2, fingerprint: FINGERPRINT_A});
    assert.equal(await reopened.count(), 1);
    assert.equal(await reopened.countTraces(), 1);
    const meta = JSON.parse(await fs.readFile(path.join(root, 'store-meta.json'), 'utf8'));
    assert.equal(meta.dims, 2);
    await reopened.close();
});

test('a mismatched embedding width fails loud instead of an opaque write error', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-store-meta-'));
    const store = await createStore({root, dims: 2, fingerprint: FINGERPRINT_A});
    await assert.rejects(
        store.applyBatch({
            chunkRows: [{
                path: 'src/app.js',
                lineStart: 1,
                lineEnd: 2,
                content: 'export const app = 1;',
                embedding: [0.1, 0.2, 0.3],
                contentHash: 'hash-a'
            }]
        }),
        /embedding width 3 does not match index width 2/
    );
    await store.close();
});

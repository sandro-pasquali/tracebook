import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import {createJsonIdStore, writeJsonAtomic} from '../../src/util/json-id-store.js';

const VALID_ID = /^item_[a-z0-9]+$/;

async function makeStore() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-json-id-store-'));
    const store = createJsonIdStore({
        root,
        validateId: (id) => VALID_ID.test(id)
    });
    return {root, store};
}

test('writeJsonAtomic leaves no temp files behind on success', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-json-atomic-'));
    const file = path.join(root, 'out.json');
    await writeJsonAtomic({file, data: {ok: true}});
    assert.deepEqual(await fs.readJson(file), {ok: true});
    const leftovers = (await fs.readdir(root)).filter((name) => name.includes('.tmp'));
    assert.deepEqual(leftovers, []);
});

test('writeJsonAtomic cleans its temp file up when the write fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-json-atomic-'));
    const file = path.join(root, 'out.json');
    const circular = {};
    circular.self = circular;
    await assert.rejects(writeJsonAtomic({file, data: circular}));
    const leftovers = (await fs.readdir(root)).filter((name) => name.includes('.tmp'));
    assert.deepEqual(leftovers, []);
});

test('json id store round-trips items and rejects invalid ids', async () => {
    const {store} = await makeStore();
    await store.writeItem({id: 'item_one', payload: {value: 1}});
    assert.deepEqual(await store.readItem('item_one'), {value: 1});
    assert.equal(await store.readItem('missing id'), null);
    assert.equal(store.filePath('../escape'), null);
    assert.equal(store.filePath(''), null);
    await assert.rejects(store.writeItem({id: 'not valid', payload: {}}), /invalid_store_id/);
});

test('json id store lists ids, excluding requested files', async () => {
    const {root, store} = await makeStore();
    await store.writeItem({id: 'item_a', payload: {}});
    await store.writeItem({id: 'item_b', payload: {}});
    await fs.writeFile(path.join(root, '_summaries.json'), '{}');
    const ids = await store.listIds({exclude: ['_summaries.json']});
    assert.deepEqual(ids.sort(), ['item_a', 'item_b']);
});

test('json id store removes items and reports missing ones', async () => {
    const {store} = await makeStore();
    await store.writeItem({id: 'item_gone', payload: {}});
    assert.deepEqual(await store.removeItem('item_gone'), {deleted: true});
    assert.deepEqual(await store.removeItem('item_gone'), {deleted: false, reason: 'not_found'});
    assert.deepEqual(await store.removeItem('bad id'), {deleted: false, reason: 'invalid_id'});
});

test('concurrent saves of the same id never corrupt the file', async () => {
    const {root, store} = await makeStore();
    const writes = [];
    for(let i = 0; i < 20; i++) {
        writes.push(store.writeItem({id: 'item_hot', payload: {revision: i, padding: 'x'.repeat(2048)}}));
    }
    await Promise.all(writes);
    const saved = await store.readItem('item_hot');
    assert.equal(typeof saved.revision, 'number');
    assert.equal(saved.padding.length, 2048);
    const leftovers = (await fs.readdir(root)).filter((name) => name.includes('.tmp'));
    assert.deepEqual(leftovers, []);
});

test('a failed write does not wedge later writes on the chain', async () => {
    const {store} = await makeStore();
    const circular = {};
    circular.self = circular;
    await assert.rejects(store.writeItem({id: 'item_bad', payload: circular}));
    await store.writeItem({id: 'item_good', payload: {ok: true}});
    assert.deepEqual(await store.readItem('item_good'), {ok: true});
});

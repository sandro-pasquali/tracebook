import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SUMMARY_INDEX_FILE, createSummarySidecar, indexDrifted} from '../../src/util/summary-sidecar.js';

test('summary sidecar rebuilds drift, sorts listings, and removes entries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-summary-sidecar-'));
    const items = new Map([
        ['one', {title: 'One', updatedAt: 100}],
    ]);
    const sidecar = createSummarySidecar({
        root,
        listIds: async () => [...items.keys()],
        loadItem: async (id) => items.get(id),
        buildSummary: (id, item) => ({id, title: item.title, updatedAt: item.updatedAt}),
        keyForSummary: (summary) => summary?.id,
    });

    await sidecar.upsert({id: 'one', title: 'One', updatedAt: 100});
    items.set('two', {title: 'Two', updatedAt: 200});

    const driftHealed = await sidecar.listSummaries({
        sort: (a, b) => b.updatedAt - a.updatedAt,
    });
    assert.deepEqual(driftHealed.map((summary) => summary.id), ['two', 'one']);

    await fs.writeFile(path.join(root, SUMMARY_INDEX_FILE), '{bad json');
    const corruptHealed = await sidecar.listSummaries();
    assert.deepEqual(corruptHealed.map((summary) => summary.id).sort(), ['one', 'two']);

    await sidecar.remove('two');
    const index = JSON.parse(await fs.readFile(path.join(root, SUMMARY_INDEX_FILE), 'utf8'));
    assert.deepEqual(Object.keys(index), ['one']);
});

test('indexDrifted detects missing, extra, and absent summary keys', () => {
    assert.equal(indexDrifted(null, ['one']), true);
    assert.equal(indexDrifted({one: {}}, ['one']), false);
    assert.equal(indexDrifted({one: {}, two: {}}, ['one']), true);
    assert.equal(indexDrifted({one: {}}, ['one', 'two']), true);
});

import path from 'node:path';
import fs from 'fs-extra';
import {writeJsonAtomic} from './json-id-store.js';

export const SUMMARY_INDEX_FILE = '_summaries.json';

export function createSummarySidecar({root, listIds, loadItem, buildSummary, keyForSummary, fileName = SUMMARY_INDEX_FILE} = {}) {
    if(!root || typeof listIds !== 'function' || typeof loadItem !== 'function' || typeof buildSummary !== 'function' || typeof keyForSummary !== 'function') {
        throw new Error('createSummarySidecar requires {root, listIds, loadItem, buildSummary, keyForSummary}');
    }

    let writeChain = Promise.resolve();

    // Every index write — upsert, remove, and drift rebuild — runs on this
    // chain, so a read-triggered rebuild can never interleave with an
    // in-flight upsert's read-modify-write.
    //
    function enqueue(task) {
        const run = writeChain.then(task);
        writeChain = run.catch(() => {});
        return run;
    }

    async function listSummaries({limit = 50, sort} = {}) {
        const ids = await listIds();
        let index = await readIndex();
        if(indexDrifted(index, ids)) {
            index = await enqueue(() => rebuildIndexNow(ids));
        }
        const summaries = Object.values(index).filter(Boolean);
        if(typeof sort === 'function') {
            summaries.sort(sort);
        }
        return summaries.slice(0, limit);
    }

    async function readIndex() {
        try {
            const data = await fs.readJson(indexPath());
            if(data && typeof data === 'object' && !Array.isArray(data)) {
                return data;
            }
        } catch {
            // Missing or corrupt sidecars are rebuilt by listSummaries/upsert.
        }
        return null;
    }

    function writeIndex(index) {
        return writeJsonAtomic({file: indexPath(), data: index});
    }

    // Rebuild without enqueueing — callers already inside the write chain
    // (upsert) use this directly; everyone else goes through rebuildIndex.
    //
    async function rebuildIndexNow(ids = null) {
        const itemIds = ids || await listIds();
        const index = {};
        for(const id of itemIds) {
            try {
                const item = await loadItem(id);
                if(item) {
                    index[id] = buildSummary(id, item);
                }
            } catch {
                // Skip unreadable item files.
            }
        }
        await writeIndex(index);
        return index;
    }

    function rebuildIndex(ids = null) {
        return enqueue(() => rebuildIndexNow(ids));
    }

    function upsert(summary) {
        return enqueue(async () => {
            const key = keyForSummary(summary);
            if(!key) {
                return;
            }
            const index = (await readIndex()) || await rebuildIndexNow();
            index[key] = summary;
            await writeIndex(index);
        });
    }

    function remove(id) {
        return enqueue(async () => {
            const index = await readIndex();
            if(!index || !index[id]) {
                return;
            }
            delete index[id];
            await writeIndex(index);
        });
    }

    function indexPath() {
        return path.resolve(root, fileName);
    }

    return {
        fileName,
        indexPath,
        listSummaries,
        readIndex,
        rebuildIndex,
        remove,
        upsert
    };
}

export function indexDrifted(index, ids) {
    if(!index) {
        return true;
    }
    const keys = Object.keys(index);
    if(keys.length !== ids.length) {
        return true;
    }
    return ids.some((id) => !index[id]);
}

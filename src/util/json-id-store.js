import path from 'node:path';
import {randomUUID} from 'node:crypto';
import fs from 'fs-extra';

// Write JSON atomically: write a unique temp file next to the target, then
// rename over it. Unique temp names keep concurrent writers of the same
// target from consuming or unlinking each other's temp file; the rename
// itself is atomic, so readers always see a complete document.
//
export async function writeJsonAtomic({file, data}) {
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
        await fs.writeFile(tmp, JSON.stringify(data));
        await fs.rename(tmp, file);
    } catch(err) {
        await fs.remove(tmp).catch(() => {});
        throw err;
    }
}

// Shared persistence engine for the JSON-per-id stores (stories, traces,
// change briefs): one <id>.json per item under root, ids validated before
// any path is built, and mutations serialized on a per-store chain so
// concurrent writes cannot interleave.
//
export function createJsonIdStore({root, validateId}) {
    if(!root || typeof validateId !== 'function') {
        throw new Error('createJsonIdStore requires {root, validateId}');
    }

    let writeChain = Promise.resolve();

    // Serialize a mutation on this store's write chain. The chain never
    // rejects (failures propagate to the caller of the enqueued task only),
    // so one failed write cannot wedge later writes.
    //
    function enqueue(task) {
        const run = writeChain.then(task);
        writeChain = run.catch(() => {});
        return run;
    }

    async function init() {
        await fs.ensureDir(root);
    }

    // Resolve the absolute file path for an id, or null when the id fails
    // validation or would escape the store root.
    //
    function filePath(id) {
        const candidate = String(id || '').trim();
        if(!candidate || !validateId(candidate)) {
            return null;
        }
        const abs = path.resolve(root, `${candidate}.json`);
        const normRoot = path.resolve(root) + path.sep;
        return abs.startsWith(normRoot) ? abs : null;
    }

    async function writeItem({id, payload}) {
        const file = filePath(id);
        if(!file) {
            throw new Error('invalid_store_id');
        }
        await init();
        await enqueue(() => writeJsonAtomic({file, data: payload}));
        return file;
    }

    async function readItem(id) {
        const file = filePath(id);
        if(!file || !(await fs.pathExists(file))) {
            return null;
        }
        return fs.readJson(file);
    }

    async function listIds({exclude = []} = {}) {
        await init();
        const skip = new Set(exclude);
        const files = await fs.readdir(root);
        const ids = [];
        for(const file of files) {
            if(skip.has(file) || !file.endsWith('.json')) {
                continue;
            }
            ids.push(file.slice(0, -'.json'.length));
        }
        return ids;
    }

    async function removeItem(id) {
        const file = filePath(id);
        if(!file) {
            return {deleted: false, reason: 'invalid_id'};
        }
        if(!(await fs.pathExists(file))) {
            return {deleted: false, reason: 'not_found'};
        }
        await enqueue(() => fs.remove(file));
        return {deleted: true};
    }

    return {init, filePath, writeItem, readItem, listIds, removeItem, enqueue};
}

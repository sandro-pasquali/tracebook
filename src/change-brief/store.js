import {createJsonIdStore} from '../util/json-id-store.js';

const BRIEF_ID_PATTERN = /^brf_[a-z0-9]+_[a-z0-9]{6}$/;

export function createChangeBriefStore({root}) {
    if(!root) {
        throw new Error('createChangeBriefStore requires {root}');
    }

    const items = createJsonIdStore({
        root,
        validateId: (id) => BRIEF_ID_PATTERN.test(id)
    });

    async function init() {
        await items.init();
    }

    async function save(brief) {
        const briefId = brief?.briefId || createBriefId();
        const payload = {...brief, briefId};
        try {
            await items.writeItem({id: briefId, payload});
        } catch(err) {
            throw err?.message === 'invalid_store_id' ? new Error('invalid_change_brief_id') : err;
        }
        return payload;
    }

    async function load(briefId) {
        return items.readItem(briefId);
    }

    async function list() {
        const ids = await items.listIds();
        return ids.filter((id) => BRIEF_ID_PATTERN.test(id)).sort();
    }

    return {init, save, load, list};
}

export function createBriefId(now = Date.now()) {
    return `brf_${Math.max(0, Number(now) || 0).toString(36)}_${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}

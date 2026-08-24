import {storyIdSchema} from './util/input-schemas.js';
import {SUMMARY_INDEX_FILE, createSummarySidecar} from './util/summary-sidecar.js';
import {createJsonIdStore} from './util/json-id-store.js';
import {normalizeSourceFingerprints} from './util/source-fingerprints.js';

export function createStoryStore({root}) {
    if(!root) {
        throw new Error('createStoryStore requires {root}');
    }

    const items = createJsonIdStore({
        root,
        validateId: (id) => storyIdSchema.safeParse(id).success
    });

    const summaries = createSummarySidecar({
        root,
        listIds: list,
        loadItem: load,
        buildSummary,
        keyForSummary: (summary) => summary?.storyId
    });

    async function init() {
        await items.init();
    }

    async function save(story) {
        const storyId = normalizeStoryId(story?.storyId);
        if(!storyId) {
            throw new Error('invalid_story_id');
        }
        const now = Date.now();
        const payload = {
            storyId,
            title: story?.title || 'Untitled story',
            createdAt: story?.createdAt || now,
            updatedAt: now,
            chapters: Array.isArray(story?.chapters) ? story.chapters : [],
            sourcePaths: Array.isArray(story?.sourcePaths) ? story.sourcePaths : [],
            sourceFingerprints: normalizeSourceFingerprints(story?.sourceFingerprints)
        };
        await items.writeItem({id: storyId, payload});
        await summaries.upsert(buildSummary(storyId, payload));
        return payload;
    }

    async function load(storyId) {
        const normalized = normalizeStoryId(storyId, {allowMissing: false});
        if(!normalized) {
            return null;
        }
        return items.readItem(normalized);
    }

    async function listSummaries({limit = 50} = {}) {
        await init();
        return summaries.listSummaries({
            limit,
            sort: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
        });
    }

    async function list() {
        return items.listIds({exclude: [SUMMARY_INDEX_FILE]});
    }

    async function remove(storyId) {
        const normalized = normalizeStoryId(storyId, {allowMissing: false});
        if(!normalized) {
            return {deleted: false, reason: 'invalid_id'};
        }
        const result = await items.removeItem(normalized);
        if(!result.deleted) {
            return result;
        }
        await summaries.remove(normalized);
        return {deleted: true, storyId: normalized};
    }

    return {init, save, load, list, listSummaries, remove};

    function normalizeStoryId(value, {allowMissing = true} = {}) {
        const candidate = String(value || '').trim();
        if(!candidate) {
            if(allowMissing) {
                return `story_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
            }
            return null;
        }
        return storyIdSchema.safeParse(candidate).success ? candidate : null;
    }
}

function buildSummary(storyId, story) {
    const chapters = Array.isArray(story.chapters) ? story.chapters : [];
    return {
        storyId: story.storyId || storyId,
        title: story.title || chapters[0]?.title || chapters[0]?.question || 'Untitled story',
        createdAt: story.createdAt || null,
        updatedAt: story.updatedAt || null,
        chapterCount: chapters.length,
        lastQuestion: chapters.at(-1)?.question || '',
        sourcePaths: Array.isArray(story.sourcePaths) ? story.sourcePaths.slice(0, 6) : [],
        sourceFingerprints: normalizeSourceFingerprints(story.sourceFingerprints)
    };
}

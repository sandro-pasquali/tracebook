import {emptyQuerySchema, listQuerySchema, storyIdParamsSchema, storySaveRequestSchema, withRequest} from './contracts.js';
import {storySourceFingerprints, withStoryFreshness} from './story-utils.js';

// Storage readiness runs via the `ready` contract option — after request
// validation, before each handler.
//
export function registerStoryRoutes(app, {getStories, readSource, requireStorage, routeLogger}) {
    app.get('/api/stories', withRequest({query: listQuerySchema}, async (c, {query}) => {
        const requestLog = routeLogger(c);
        const {limit} = query;
        const storyStore = getStories(c);
        const items = await storyStore.listSummaries({limit});
        requestLog.debug({limit, count: items.length}, 'story summaries loaded');
        return c.json({stories: items});
    }, {routeLogger, ready: requireStorage}));

    app.get('/api/stories/:id', withRequest({
        params: storyIdParamsSchema,
        query: emptyQuerySchema
    }, async (c, {params}) => {
        const requestLog = routeLogger(c);
        const storyStore = getStories(c);
        const story = await storyStore.load(params.id);
        if(!story) {
            requestLog.warn({storyId: params.id}, 'story not found');
            return c.json({error: 'not_found'}, 404);
        }
        requestLog.debug({storyId: params.id, chapters: story.chapters?.length || 0}, 'story loaded');
        return c.json(await withStoryFreshness(story, {readSource: (sourcePath) => readSource(c, sourcePath)}));
    }, {
        routeLogger,
        ready: requireStorage,
        errorCodes: {params: 'invalid_story_id'}
    }));

    app.post('/api/stories', withRequest({query: emptyQuerySchema, body: storySaveRequestSchema}, async (c, {body: payload}) => {
        const requestLog = routeLogger(c);
        const storyStore = getStories(c);
        payload.sourceFingerprints = await storySourceFingerprints(payload.sourcePaths, {readSource: (sourcePath) => readSource(c, sourcePath)});
        const saved = await storyStore.save(payload);
        requestLog.info({
            storyId: saved.storyId,
            chapters: saved.chapters?.length || 0,
            sourcePaths: saved.sourcePaths?.length || 0
        }, 'story saved');
        return c.json(await withStoryFreshness(saved, {readSource: (sourcePath) => readSource(c, sourcePath)}));
    }, {
        routeLogger,
        ready: requireStorage,
        invalidJsonLog: 'invalid JSON while saving story',
        invalidLog: 'invalid story payload',
        errorCodes: {body: 'invalid_story_payload'}
    }));

    app.delete('/api/stories/:id', withRequest({
        params: storyIdParamsSchema,
        query: emptyQuerySchema
    }, async (c, {params}) => {
        const requestLog = routeLogger(c);
        const storyId = params.id;
        const storyStore = getStories(c);
        const result = await storyStore.remove(storyId);
        if(!result.deleted) {
            requestLog.warn({storyId}, 'story not found for deletion');
            return c.json({error: 'not_found'}, 404);
        }
        requestLog.info({storyId: result.storyId}, 'story deleted');
        return c.json({ok: true, storyId: result.storyId});
    }, {
        routeLogger,
        ready: requireStorage,
        errorCodes: {params: 'invalid_story_id'}
    }));
}

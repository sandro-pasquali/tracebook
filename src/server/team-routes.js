import {emptyQuerySchema, teamRepoIdParamsSchema, withRequest} from './contracts.js';
import {teamConfigSaveSchema} from './team-config-store.js';

export function registerTeamRoutes(app, {teamConfig, routeLogger}) {
    app.get('/api/team/config', withRequest({query: emptyQuerySchema}, async (c) => {
        const requestLog = routeLogger(c);
        const payload = await teamConfig.publicConfig();
        requestLog.debug({repos: payload.repos.length, exists: payload.exists}, 'team config loaded');
        return c.json(payload);
    }, {routeLogger}));

    app.post('/api/team/config', withRequest({query: emptyQuerySchema, body: teamConfigSaveSchema}, async (c, {body}) => {
        const requestLog = routeLogger(c);
        let payload;
        try {
            payload = await teamConfig.save(body);
        } catch(err) {
            if(isRuntimeConfigError(err)) {
                requestLog.warn({err}, 'team config rejected by runtime validation');
                return c.json({
                    error: 'invalid_runtime_config',
                    message: err?.message || 'Runtime configuration is invalid.'
                }, 400);
            }
            throw err;
        }
        requestLog.info({repos: payload.repos.length, configPath: payload.configPath}, 'team config saved');
        return c.json(payload);
    }, {
        routeLogger,
        invalidJsonLog: 'invalid JSON while saving team config',
        invalidLog: 'invalid team config payload',
        errorCodes: {body: 'invalid_team_config'}
    }));

    app.get('/api/team/repos', withRequest({query: emptyQuerySchema}, async (c) => {
        const payload = await teamConfig.publicConfig();
        return c.json({
            repos: payload.repos,
            defaultRepoId: payload.defaultRepoId
        });
    }, {routeLogger}));

    app.get('/api/team/defaults/advanced', withRequest({query: emptyQuerySchema}, async (c) => c.json({
        defaults: teamConfig.advancedDefaults()
    }), {routeLogger}));

    app.get('/api/team/repos/:id/check', withRequest({
        params: teamRepoIdParamsSchema,
        query: emptyQuerySchema
    }, async (c, {params}) => {
        const result = await teamConfig.checkRepo(params.id);
        return c.json(result, result.ok ? 200 : 400);
    }, {
        routeLogger,
        errorCodes: {params: 'invalid_repo_id'}
    }));
}

function isRuntimeConfigError(err) {
    return /Missing required provider credentials|RERANK_MODEL=|OS keychain credential store failed/u
        .test(String(err?.message || ''));
}

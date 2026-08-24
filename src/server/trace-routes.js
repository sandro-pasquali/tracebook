import {buildFeatureTrace, simulateFeatureTrace, verifyFeatureTrace} from '../feature-trace.js';
import {emptyQuerySchema, listQuerySchema, simulateTraceRequestSchema, traceIdParamsSchema, withRequest} from './contracts.js';

// Storage readiness runs via the `ready` contract option — after request
// validation, before each handler.
//
export function registerTraceRoutes(app, {getTraces, requireStorage, routeLogger}) {
    app.get('/api/traces', withRequest({query: listQuerySchema}, async (c, {query}) => {
        const requestLog = routeLogger(c);
        const {limit} = query;
        const traceStore = getTraces(c);
        const sessions = await traceStore.listSummaries({limit});
        requestLog.debug({limit, count: sessions.length}, 'trace summaries loaded');
        return c.json({sessions});
    }, {routeLogger, ready: requireStorage}));

    app.get('/api/traces/:id', withRequest({
        params: traceIdParamsSchema,
        query: emptyQuerySchema
    }, async (c, {params}) => {
        const requestLog = routeLogger(c);
        const {id} = params;
        const traceStore = getTraces(c);
        const trace = await traceStore.load(id);
        if(!trace) {
            requestLog.warn({traceId: id}, 'trace not found');
            return c.json({error: 'not_found'}, 404);
        }
        requestLog.debug({traceId: id}, 'trace loaded');
        return c.json(trace);
    }, {
        routeLogger,
        ready: requireStorage,
        errorCodes: {params: 'invalid_trace_id'}
    }));

    app.post('/api/traces/:id/simulate', withRequest({
        params: traceIdParamsSchema,
        query: emptyQuerySchema,
        body: simulateTraceRequestSchema
    }, async (c, {params, body}) => {
        const requestLog = routeLogger(c);
        const {id} = params;
        const {condition} = body;
        const traceStore = getTraces(c);
        const saved = await traceStore.load(id);
        if(!saved) {
            requestLog.warn({traceId: id}, 'trace not found for simulation');
            return c.json({error: 'not_found'}, 404);
        }
        const featureTrace = resolveFeatureTrace(saved);
        const simulation = simulateFeatureTrace({featureTrace, condition});
        if(simulation.error) {
            requestLog.warn({traceId: id, error: simulation.error}, 'trace simulation rejected');
            return c.json(simulation, 400);
        }
        requestLog.info({traceId: id, condition}, 'trace simulated');
        return c.json({traceId: id, simulation});
    }, {
        routeLogger,
        ready: requireStorage,
        invalidJsonLog: 'invalid JSON while simulating trace',
        invalidLog: 'invalid trace simulation request',
        errorCodes: {params: 'invalid_trace_id'}
    }));

    app.post('/api/traces/:id/verify', withRequest({
        params: traceIdParamsSchema,
        query: emptyQuerySchema
    }, async (c, {params}) => {
        const requestLog = routeLogger(c);
        const {id} = params;
        const traceStore = getTraces(c);
        const saved = await traceStore.load(id);
        if(!saved) {
            requestLog.warn({traceId: id}, 'trace not found for verification');
            return c.json({error: 'not_found'}, 404);
        }
        const featureTrace = resolveFeatureTrace(saved);
        const verification = verifyFeatureTrace({featureTrace});
        if(verification.error) {
            requestLog.warn({traceId: id, error: verification.error}, 'trace verification rejected');
            return c.json(verification, 400);
        }
        requestLog.info({traceId: id, checks: verification.checks?.length || 0}, 'trace verification generated');
        return c.json({traceId: id, verification});
    }, {
        routeLogger,
        ready: requireStorage,
        errorCodes: {params: 'invalid_trace_id'}
    }));
}

function resolveFeatureTrace(saved) {
    if(saved?.featureTrace) {
        return saved.featureTrace;
    }
    const complete = [...(saved?.events || [])].reverse().find((e) => e?.type === 'trace.complete');
    return complete?.featureTrace || buildFeatureTrace({
        question: saved?.question,
        trace: saved?.trace || complete?.trace,
        traceId: saved?.traceId,
        createdAt: saved?.finishedAt || Date.now()
    });
}

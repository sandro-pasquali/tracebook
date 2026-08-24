import {emptyQuerySchema, changeBriefRequestSchema, traceIdParamsSchema, withRequest} from './contracts.js';
import {generateChangeBrief} from '../change-brief/generator.js';

// Runtime readiness runs via the `ready` contract option — after request
// validation, before the handler.
//
export function registerChangeBriefRoutes(app, {getRuntime, getSourceRevision, requireRuntime, routeLogger}) {
    app.post('/api/traces/:id/change-brief', withRequest({
        params: traceIdParamsSchema,
        query: emptyQuerySchema,
        body: changeBriefRequestSchema
    }, async (c, {params, body}) => {
        const requestLog = routeLogger(c);
        const runtime = getRuntime(c);
        const savedTrace = await runtime.traces.load(params.id);
        if(!savedTrace) {
            requestLog.warn({traceId: params.id}, 'trace not found for change brief');
            return c.json({error: 'not_found'}, 404);
        }

        const brief = await generateChangeBrief({
            savedTrace,
            changeIntent: body.changeIntent,
            outputFormat: body.outputFormat,
            tools: runtime.tools,
            governor: runtime.governor,
            sourceRevision: getSourceRevision(c)
        });
        const saved = await runtime.briefs.save(brief);
        requestLog.info({traceId: params.id, briefId: saved.briefId, outputFormat: saved.outputFormat}, 'change brief generated');
        return c.json({brief: saved});
    }, {
        routeLogger,
        ready: requireRuntime,
        invalidJsonLog: 'invalid JSON while generating change brief',
        invalidLog: 'invalid change brief request',
        errorCodes: {params: 'invalid_trace_id'}
    }));

}

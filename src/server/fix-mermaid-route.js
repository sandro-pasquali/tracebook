import {generateObject} from 'ai';
import {z} from 'zod';
import {emptyQuerySchema, fixMermaidRequestSchema, withRequest} from './contracts.js';
import {resolveModel} from '../util/model.js';
import {buildMermaidRepairPrompt, buildMermaidRepairSystemPrompt, healMermaidSource} from '../planner/visual-fallback.js';

// One-shot model repair for Mermaid the browser parser rejected. The client is
// the only place that runs the real parser, so it drives this: it posts the
// broken source (plus the parser error) and gets back a corrected `mermaid`
// string, which it re-validates before swapping in.
//
const repairSchema = z.object({mermaid: z.string().min(1)});

export function registerFixMermaidRoute(app, {getModelSpec, routeLogger}) {
    app.post('/api/fix-mermaid', withRequest({
        query: emptyQuerySchema,
        body: fixMermaidRequestSchema
    }, async (c, {body}) => {
        const requestLog = routeLogger(c);
        try {
            const {object} = await generateObject({
                model: resolveModel(getModelSpec()),
                schema: repairSchema,
                schemaName: 'MermaidRepair',
                system: buildMermaidRepairSystemPrompt(),
                prompt: buildMermaidRepairPrompt({
                    source: body.mermaid,
                    diagramType: body.diagramType,
                    error: body.error
                }),
                maxOutputTokens: 2000,
                abortSignal: c.req.raw.signal
            });
            const mermaid = healMermaidSource(object.mermaid || '');
            requestLog.info({diagramType: body.diagramType || undefined}, 'mermaid repair generated');
            return c.json({mermaid});
        } catch(err) {
            requestLog.warn({err, diagramType: body.diagramType || undefined}, 'mermaid repair failed');
            return c.json({error: 'mermaid_repair_failed'}, 502);
        }
    }, {
        routeLogger,
        invalidJsonLog: 'invalid JSON while repairing mermaid',
        invalidLog: 'invalid mermaid repair request'
    }));
}

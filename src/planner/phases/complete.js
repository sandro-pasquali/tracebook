import {config} from '../../util/config.js';
import {modelIdOnly} from '../../util/model.js';
import {buildFeatureTrace} from '../../feature-trace.js';

// Build the terminal trace.complete event. Shared by the two lean exits and the
// full-synthesis exit, which previously each constructed an identical event
// inline (finishedAt, timing snapshot, featureTrace). The meta argument is the
// planner ctx (or any object carrying these fields).
//
export function buildTraceCompleteEvent({traceId, startedAt, timer, fastPath, question}, {trace, usage, model, synthesisMode}) {
    const finishedAt = Date.now();
    return {
        type: 'trace.complete',
        traceId,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        usage,
        model,
        explorationModel: modelIdOnly(config.models.exploration),
        timing: timer.snapshot(),
        fastPath,
        synthesisMode,
        trace,
        featureTrace: buildFeatureTrace({question, trace, traceId, createdAt: finishedAt})
    };
}

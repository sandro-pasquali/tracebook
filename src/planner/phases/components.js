import {createEventChannel} from '../../util/event-channel.js';
import {mapWithConcurrency} from '../../util/concurrency.js';
import {config} from '../../util/config.js';
import {resolveModel, modelIdOnly} from '../../util/model.js';
import {synthesizeComponent} from '../synthesize-component.js';
import {combineUsage} from '../usage.js';
import {evidenceForPlanItem, formatEvidenceMessage} from '../evidence.js';
import {buildTraceCompleteEvent} from './complete.js';

// ───── Component fan-out phase (synthesis 2b) ─────
// One streamObject call per plan item, synthesized with bounded concurrency
// (config.planner.componentConcurrency) since each component makes 2-3 sequential
// model calls and a single local model serves them serially — unbounded
// parallelism there only contends. Each component streams its progress through a
// shared channel; the loop below interleaves them into the SSE stream. A
// per-component wall-clock budget aborts a stalled stream so one stuck call can
// never hang the whole request.
//
// Yields the interleaved component.patch stream, synthesis.end, and the terminal
// full trace.complete.
//
export async function* runComponents(ctx) {
    const {outline, componentEvidencePacket, outlineUsage, explorationUsage, synthesisQuestion, signal, timer, governor} = ctx;

    const channel = createEventChannel();
    const synthesisModel = resolveModel(config.models.synthesis);
    const componentRun = mapWithConcurrency(
        outline.plan,
        config.planner.componentConcurrency,
        async (planItem, index) => {
            const componentEvidence = evidenceForPlanItem(componentEvidencePacket, planItem);
            const controller = new AbortController();
            const onParentAbort = () => controller.abort();
            if(signal) {
                if(signal.aborted) {
                    controller.abort();
                } else {
                    signal.addEventListener('abort', onParentAbort, {once: true});
                }
            }
            const wallTimer = setTimeout(() => controller.abort(), config.planner.componentWallMs);
            try {
                return await synthesizeComponent({
                    planItem,
                    index,
                    outline,
                    evidenceMessage: formatEvidenceMessage({
                        title: `Evidence slice for component "${planItem.id}"`,
                        question: synthesisQuestion,
                        items: componentEvidence
                    }),
                    evidenceItems: componentEvidence,
                    question: synthesisQuestion,
                    model: synthesisModel,
                    throttleMs: config.planner.componentThrottleMs,
                    maxTokens: config.planner.componentMaxTokens,
                    signal: controller.signal,
                    channel,
                    timer,
                    governor
                });
            } catch {
                // A component that throws or is aborted (per-component timeout or
                // client disconnect) is dropped; the rest of the trace completes.
                //
                return null;
            } finally {
                clearTimeout(wallTimer);
                signal?.removeEventListener?.('abort', onParentAbort);
            }
        }
    );
    componentRun.then(() => channel.close(), () => channel.close());

    for await (const event of channel) {
        if(signal?.aborted) break;
        yield event;
    }

    const componentResults = await componentRun;
    const components = [];
    let componentsUsage = null;
    // Drop duplicate components — same kind grounded on the same source region
    // (e.g. two annotated_code_excerpts of the same lines, which happens when the
    // evidence is thin) — keeping the higher-confidence one. Different kinds on the
    // same region (e.g. a diagram + a code excerpt) are not duplicates.
    //
    const bySignature = new Map();
    for(const r of componentResults) {
        if(r && r.usage) {
            componentsUsage = combineUsage(componentsUsage, r.usage);
        }
        const component = r && r.component;
        if(!component) {
            continue;
        }
        const signature = componentSignature(component);
        if(signature && bySignature.has(signature)) {
            const existing = bySignature.get(signature);
            if((component.confidence ?? 0) > (existing.component.confidence ?? 0)) {
                components[existing.index] = component;
                bySignature.set(signature, {component, index: existing.index});
            }
            continue;
        }
        components.push(component);
        if(signature) {
            bySignature.set(signature, {component, index: components.length - 1});
        }
    }
    const finalTrace = {
        title: outline.title,
        narrative: outline.narrative,
        components
    };
    const synthUsage = combineUsage(outlineUsage, componentsUsage);

    const synthesisEnd = timer.mark('synthesis.end', {tokens: synthUsage?.totalTokens || 0, components: components.length});
    yield {type: 'timing.checkpoint', name: synthesisEnd.name, sinceStart: synthesisEnd.sinceStart, sinceLast: synthesisEnd.sinceLast, tokens: synthesisEnd.tokens, components: synthesisEnd.components};

    yield buildTraceCompleteEvent(ctx, {
        trace: finalTrace,
        usage: combineUsage(explorationUsage, synthUsage),
        model: modelIdOnly(config.models.synthesis),
        synthesisMode: 'full'
    });
}

// Signature identifying a component by kind + its primary source region. Two
// components with the same signature are duplicates (same visualization of the
// same lines). Returns null when there is no source region to key on, so gap
// callouts without sourceRefs are never deduped against each other.
//
export function componentSignature(component) {
    const ref = Array.isArray(component?.sourceRefs) ? component.sourceRefs[0] : null;
    if(!ref || !ref.path) {
        return null;
    }
    return `${component.type}:${ref.path}:${ref.lineStart ?? ''}-${ref.lineEnd ?? ''}`;
}

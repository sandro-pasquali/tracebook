import {streamObject} from 'ai';
import {traceOutlineSchema} from '../../registry/schemas.js';
import {config} from '../../util/config.js';
import {resolveModel} from '../../util/model.js';
import {formatIntentForPrompt} from '../../intent-classifier.js';
import {buildOutlineSystemPrompt} from '../prompts.js';
import {buildTraceError} from '../errors.js';
import {computeDeltas, snapshot} from '../stream-events.js';
import {settleGovernorCall} from '../usage.js';
import {buildEvidenceReadyEvent, expandEvidenceForPlan} from '../evidence.js';
import {
    dedupeOverlappingPlanItems,
    ensureApiPlan,
    ensureNamedCodePlan,
    ensureOverviewPlan,
    ensureRequestedCodePlan,
    ensureRequestedVisualPlan,
    ensureSupportingActorPlan
} from '../plan-augmentation.js';
import {buildSimilarTracesMessage} from './similar-traces.js';

// ───── Outline phase (synthesis 2a) ─────
// A fast small model produces title + narrative + the plan of which components
// to render (no code, no callouts). Title and narrative stream to the client
// immediately. Then the plan is augmented (supporting actor / requested visual /
// requested code / named code) and the evidence packet expanded to cover the
// plan's source refs.
//
// Yields synthesis.start, the streamed title/narrative deltas, evidence-expansion
// events, and plan.ready. Returns {outline, componentEvidencePacket,
// outlineUsage}, or {halt: true} after yielding a trace.error.
//
export async function* runOutline(ctx) {
    const {classification, questionContext, evidencePacket, similarTraces, synthesisQuestion, question, tools, governor, signal, timer, throttleMs} = ctx;

    yield {type: 'synthesis.start', mode: 'full'};

    const outlineReservation = governor ? await governor.beforeCall(config.planner.outlineMaxTokens) : null;

    const synthesisStart = timer.mark('synthesis.start', {mode: 'full'});
    yield {type: 'timing.checkpoint', name: synthesisStart.name, sinceStart: synthesisStart.sinceStart, sinceLast: synthesisStart.sinceLast, mode: synthesisStart.mode};

    const synthesisLeadIn = [
        {role: 'user', content: formatIntentForPrompt(classification)}
    ];
    if(questionContext.contextMessage) {
        synthesisLeadIn.push({
            role: 'user',
            content: `${questionContext.contextMessage}\n\nUse this conversation context when interpreting the current question. If a retelling target is present, preserve that subject and use the follow-up only as the requested presentation style.`
        });
    }
    synthesisLeadIn.push({role: 'user', content: evidencePacket.outlineMessage});
    const synthesisSimilarMessage = buildSimilarTracesMessage(similarTraces);
    if(synthesisSimilarMessage) {
        synthesisLeadIn.push({
            role: 'user',
            content: `${synthesisSimilarMessage}\n\nKeep narrative tone and primitive choices consistent with these prior answers where the topic overlaps. Do not invent details from the prior traces — they are stylistic context only.`
        });
    }

    // 2a — Outline call. Fast small model produces title + narrative + plan
    // (no code, no callouts). Title and narrative stream to the client
    // immediately, so the user sees the answer take shape in seconds.
    //
    const outlineStart = timer.mark('outline.start');
    yield {type: 'timing.checkpoint', name: outlineStart.name, sinceStart: outlineStart.sinceStart, sinceLast: outlineStart.sinceLast};

    let outlineSynth;
    try {
        outlineSynth = streamObject({
            model: resolveModel(config.models.outline),
            schema: traceOutlineSchema,
            schemaName: 'TraceOutline',
            schemaDescription: 'Outline of a Trace: title, narrative, and the plan for which components to render.',
            system: buildOutlineSystemPrompt(),
            messages: [
                ...synthesisLeadIn,
                {role: 'user', content: `Produce the outline for: ${JSON.stringify(synthesisQuestion)}. Cite only paths that appeared in the evidence packet above. Choose 1–${config.trace.componentLimit} components in the plan; pick the ones that carry the most explanatory weight.`}
            ],
            maxOutputTokens: config.planner.outlineMaxTokens,
            abortSignal: signal
        });
    } catch(err) {
        governor?.releaseCall?.(outlineReservation);
        yield buildTraceError('outline_init_failed', err, {stage: 'outline.init'});
        return {halt: true};
    }

    let outlineFirstTokenSeen = false;
    let lastOutlineSnapshot = {title: null, narrative: [], components: []};
    let lastOutlineEmitAt = 0;
    let lastOutlinePartial = null;
    const OUTLINE_THROTTLE_MS = Math.min(throttleMs, 80);

    try {
        for await (const partial of outlineSynth.partialObjectStream) {
            if(signal?.aborted) break;
            if(!outlineFirstTokenSeen) {
                outlineFirstTokenSeen = true;
                const m = timer.mark('outline.firstToken');
                yield {type: 'timing.checkpoint', name: m.name, sinceStart: m.sinceStart, sinceLast: m.sinceLast};
            }
            lastOutlinePartial = partial;
            const now = Date.now();
            if(now - lastOutlineEmitAt < OUTLINE_THROTTLE_MS) {
                continue;
            }
            const events = computeDeltas(lastOutlineSnapshot, partial);
            for(const event of events) {
                yield event;
            }
            lastOutlineSnapshot = snapshot(partial);
            lastOutlineEmitAt = now;
        }
        if(lastOutlinePartial) {
            const events = computeDeltas(lastOutlineSnapshot, lastOutlinePartial, {isFinal: true});
            for(const event of events) {
                yield event;
            }
        }
    } catch(err) {
        governor?.releaseCall?.(outlineReservation);
        yield buildTraceError('outline_stream_failed', err, {stage: 'outline.stream'});
        return {halt: true};
    }

    let outline = null;
    try {
        outline = await outlineSynth.object;
    } catch(err) {
        governor?.releaseCall?.(outlineReservation);
        yield buildTraceError('outline_validation_failed', err, {
            stage: 'outline.validation',
            maxOutputTokens: config.planner.outlineMaxTokens
        });
        return {halt: true};
    }
    const outlineUsage = await outlineSynth.usage.catch(() => null);
    settleGovernorCall(governor, outlineReservation, outlineUsage);

    outline = dedupeOverlappingPlanItems(outline);
    outline = ensureSupportingActorPlan({outline, evidencePacket, question: synthesisQuestion});
    outline = ensureOverviewPlan({outline, evidencePacket, question, classification, selectionQuestion: synthesisQuestion});
    outline = ensureRequestedVisualPlan({outline, evidencePacket, question, classification, selectionQuestion: synthesisQuestion});
    outline = ensureApiPlan({outline, evidencePacket, question, classification, selectionQuestion: synthesisQuestion});
    outline = ensureRequestedCodePlan({outline, evidencePacket, question, classification, selectionQuestion: synthesisQuestion});

    const expansion = await expandEvidenceForPlan({packet: evidencePacket, outline, tools, question: synthesisQuestion, signal});
    let componentEvidencePacket = expansion.packet;
    for(const event of expansion.events) {
        yield event;
    }
    if(expansion.added > 0) {
        const expandMark = timer.mark('evidence.expand', {items: componentEvidencePacket.items.length, added: expansion.added});
        yield {
            type: 'timing.checkpoint',
            name: expandMark.name,
            sinceStart: expandMark.sinceStart,
            sinceLast: expandMark.sinceLast,
            items: expandMark.items,
            added: expandMark.added
        };
        yield buildEvidenceReadyEvent(componentEvidencePacket, {stage: 'component-expansion'});
    }
    outline = ensureNamedCodePlan({outline, evidencePacket: componentEvidencePacket, question, classification});
    const namedExpansion = await expandEvidenceForPlan({packet: componentEvidencePacket, outline, tools, question: synthesisQuestion, signal});
    componentEvidencePacket = namedExpansion.packet;
    for(const event of namedExpansion.events) {
        yield event;
    }
    if(namedExpansion.added > 0) {
        const expandMark = timer.mark('evidence.expand.named', {items: componentEvidencePacket.items.length, added: namedExpansion.added});
        yield {
            type: 'timing.checkpoint',
            name: expandMark.name,
            sinceStart: expandMark.sinceStart,
            sinceLast: expandMark.sinceLast,
            items: expandMark.items,
            added: expandMark.added
        };
        yield buildEvidenceReadyEvent(componentEvidencePacket, {stage: 'named-component-expansion'});
    }

    const outlineEnd = timer.mark('outline.end', {tokens: outlineUsage?.totalTokens || 0, planItems: outline.plan.length});
    yield {type: 'timing.checkpoint', name: outlineEnd.name, sinceStart: outlineEnd.sinceStart, sinceLast: outlineEnd.sinceLast, tokens: outlineEnd.tokens, planItems: outlineEnd.planItems};

    yield {type: 'plan.ready', plan: outline.plan};

    return {outline, componentEvidencePacket, outlineUsage};
}

import {generateObject, streamObject} from 'ai';
import {componentSchemaByKind} from '../registry/schemas.js';
import {childLogger} from '../util/logger.js';
import {combineUsage, isAbortError, settleGovernorCall} from './usage.js';
import {enforceGroundedAnnotatedCode, enforceHouseLimits} from './annotated-code-grounding.js';
import {
    buildComponentInstructions,
    buildComponentRetryInstructions,
    buildComponentSystemPrompt,
    schemaNameForKind
} from './prompts.js';
import {buildVisualRetryInstructions, firstMermaidLine, healMermaidSource, lintMermaidSource} from './visual-fallback.js';
import {isRenderable, isVisualComponent, normalizePartial, shouldStreamPartial} from './component-stream.js';
import {abortComponent, failComponent} from './component-fallback.js';
import {classifyModelOutputError} from './errors.js';
import {
    assignComponentEvidenceState,
    reconcileComponentSourceRefs,
    replaceUngroundedCodeWithGap
} from './citation-provenance.js';

const log = childLogger({module: 'component-synthesis'});

// Synthesize a single component. Streams partial component.patch events into
// the shared channel as the model produces JSON. On success resolves with the
// validated final component; on failure resolves with a `gap` evidence_callout
// substitute so the rest of the trace can still complete.
//
// `model` is a pre-resolved AI SDK model instance (the planner calls
// resolveModel once and reuses it across the fan-out).
//
export async function synthesizeComponent({
    planItem,
    index,
    outline,
    evidenceMessage,
    evidenceItems = [],
    question,
    model,
    throttleMs,
    maxTokens,
    signal,
    channel,
    timer,
    governor
}) {
    if(!planItem || !channel) {
        throw new Error('synthesizeComponent requires {planItem, channel}');
    }

    const dispatchMark = timer.mark(`component.${planItem.id}.dispatch`, {kind: planItem.kind});
    channel.push({
        type: 'timing.checkpoint',
        name: dispatchMark.name,
        sinceStart: dispatchMark.sinceStart,
        sinceLast: dispatchMark.sinceLast,
        kind: planItem.kind
    });

    const schema = componentSchemaByKind[planItem.kind];
    if(!schema) {
        return failComponent({planItem, index, channel, timer, message: `unknown_component_kind:${planItem.kind}`});
    }

    let synth;
    let synthReservation = null;
    try {
        synthReservation = governor ? await governor.beforeCall(maxTokens) : null;
        synth = streamObject({
            model,
            schema,
            schemaName: schemaNameForKind(planItem.kind),
            schemaDescription: `A ${planItem.kind} UI primitive contributing one part of the Trace.`,
            system: buildComponentSystemPrompt(planItem),
            messages: [
                {role: 'user', content: evidenceMessage || `No compact evidence was provided for: ${JSON.stringify(question)}.`},
                {role: 'user', content: buildComponentInstructions({planItem, outline})}
            ],
            maxOutputTokens: maxTokens,
            abortSignal: signal
        });
    } catch(err) {
        governor?.releaseCall?.(synthReservation);
        log.error({err, componentId: planItem.id, kind: planItem.kind}, 'component synthesis init failed');
        return failComponent({planItem, index, channel, timer, message: err?.message || 'component_init_failed'});
    }

    let firstTokenSeen = false;
    let lastEmitAt = 0;
    let lastJson = null;
    let lastPartial = null;
    const streamPartials = shouldStreamPartial(planItem.kind);

    // Stream-error, validation-error, and structural-Mermaid-error paths retry
    // visual components with the same inputs (only the reason differs), so route
    // them through one closure. failedPartial reads the latest streamed partial.
    //
    const tryRecoverVisual = (reason) => recoverVisualComponent({
        planItem,
        outline,
        evidenceMessage,
        question,
        model,
        maxTokens,
        signal,
        channel,
        timer,
        governor,
        reason,
        failedPartial: lastPartial
    });
    const tryRecoverSchema = (reason) => recoverSchemaComponent({
        planItem,
        outline,
        evidenceMessage,
        question,
        model,
        maxTokens,
        signal,
        channel,
        timer,
        governor,
        reason,
        failedPartial: lastPartial
    });

    try {
        for await (const partial of synth.partialObjectStream) {
            if(signal?.aborted) {
                governor?.releaseCall?.(synthReservation);
                return abortComponent({planItem, index, timer});
            }
            if(!firstTokenSeen) {
                firstTokenSeen = true;
                const m = timer.mark(`component.${planItem.id}.firstToken`);
                channel.push({type: 'timing.checkpoint', name: m.name, sinceStart: m.sinceStart, sinceLast: m.sinceLast});
            }
            lastPartial = partial;
            if(!streamPartials) {
                continue;
            }
            const now = Date.now();
            if(now - lastEmitAt < throttleMs) {
                continue;
            }
            const candidate = normalizePartial(partial, planItem);
            if(!isRenderable(candidate, planItem)) {
                continue;
            }
            const json = JSON.stringify(candidate);
            if(json === lastJson) {
                continue;
            }
            channel.push({
                type: 'component.patch',
                index,
                id: planItem.id,
                componentType: planItem.kind,
                props: candidate
            });
            lastJson = json;
            lastEmitAt = now;
        }
        if(streamPartials && lastPartial) {
            const candidate = normalizePartial(lastPartial, planItem);
            if(isRenderable(candidate, planItem)) {
                const json = JSON.stringify(candidate);
                if(json !== lastJson) {
                    channel.push({
                        type: 'component.patch',
                        index,
                        id: planItem.id,
                        componentType: planItem.kind,
                        props: candidate
                    });
                }
            }
        }
    } catch(err) {
        if(isAbortError(err) || signal?.aborted) {
            governor?.releaseCall?.(synthReservation);
            return abortComponent({planItem, index, timer});
        }
        governor?.releaseCall?.(synthReservation);
        synthReservation = null;
        log.error({err, componentId: planItem.id, kind: planItem.kind}, 'component synthesis stream failed');
        const recovered = isVisualComponent(planItem.kind)
            ? await tryRecoverVisual(err?.message || 'component_stream_failed')
            : await tryRecoverSchema(err?.message || 'component_stream_failed');
        if(recovered) {
            try {
                const annotationUsage = await postProcessComponent(recovered.component, {
                    planItem,
                    evidenceItems,
                    question,
                    signal,
                    channel,
                    timer,
                    governor
                });
                recovered.usage = combineUsage(recovered.usage, annotationUsage);
            } catch(postProcessError) {
                log.error({err: postProcessError, componentId: planItem.id, kind: planItem.kind}, 'recovered component post-processing failed');
                return failComponent({planItem, index, channel, timer, message: postProcessError?.message || 'component_postprocess_failed'});
            }
            const endMark = timer.mark(`component.${planItem.id}.end`, {ok: true, tokens: recovered.usage?.totalTokens || 0});
            channel.push({
                type: 'timing.checkpoint',
                name: endMark.name,
                sinceStart: endMark.sinceStart,
                sinceLast: endMark.sinceLast,
                ok: true,
                tokens: endMark.tokens
            });
            channel.push({
                type: 'component.patch',
                index,
                id: planItem.id,
                componentType: recovered.component.type,
                props: {...recovered.component, _final: true}
            });
            return {ok: true, component: recovered.component, usage: recovered.usage, index};
        }
        return failComponent({planItem, index, channel, timer, message: err?.message || 'component_stream_failed'});
    }

    let final = null;
    let usage = null;
    let finalFromStream = false;
    try {
        final = await synth.object;
        finalFromStream = true;
    } catch(err) {
        if(isAbortError(err) || signal?.aborted) {
            governor?.releaseCall?.(synthReservation);
            return abortComponent({planItem, index, timer});
        }
        governor?.releaseCall?.(synthReservation);
        synthReservation = null;
        const causeMsg = err?.cause?.message || '';
        const zodIssues = err?.cause?.errors || err?.cause?.issues || null;
        const modelOutput = classifyModelOutputError(err, {maxOutputTokens: maxTokens});
        const failureMessage = modelOutput?.message || err?.message || 'component_validation_failed';
        log.error({
            err,
            componentId: planItem.id,
            kind: planItem.kind,
            cause: causeMsg || undefined,
            zodIssues: zodIssues || undefined,
            modelOutput: modelOutput || undefined
        }, modelOutput ? 'component synthesis output budget exhausted' : 'component synthesis validation failed');
        if(lastPartial) {
            log.debug({
                componentId: planItem.id,
                partialKeys: Object.keys(lastPartial),
                callouts: lastPartial.callouts || null
            }, 'last invalid component partial');
        }
        if(isVisualComponent(planItem.kind)) {
            const recovered = await tryRecoverVisual(failureMessage);
            if(recovered) {
                final = recovered.component;
                usage = recovered.usage;
            } else {
                return failComponent({planItem, index, channel, timer, message: failureMessage});
            }
        } else {
            const recovered = await tryRecoverSchema(failureMessage);
            if(recovered) {
                final = recovered.component;
                usage = recovered.usage;
            } else {
                return failComponent({planItem, index, channel, timer, message: failureMessage});
            }
        }
    }

    // A schema-valid object can still be silently truncated: when the model
    // hits its output budget mid-value but the JSON happens to close,
    // synth.object resolves and no error path fires. Treat a 'length' finish
    // on the original stream as the validation failure it is and route it
    // through the same recovery. Recovered components skip this gate — their
    // finish reason belongs to the failed first attempt, not to them.
    //
    if(final && finalFromStream) {
        const finishReason = await Promise.resolve(synth.finishReason).then((value) => value, () => null);
        if(finishReason === 'length') {
            const reason = 'model output hit the token budget mid-component (finishReason: length) — the object may be truncated';
            log.warn({componentId: planItem.id, kind: planItem.kind, finishReason}, 'component stream finished by length; recovering');
            const streamUsage = await Promise.resolve(synth.usage).then((value) => value, () => null);
            const recovered = isVisualComponent(planItem.kind)
                ? await tryRecoverVisual(reason)
                : await tryRecoverSchema(reason);
            if(recovered) {
                final = recovered.component;
                usage = combineUsage(streamUsage, recovered.usage);
            } else {
                return failComponent({planItem, index, channel, timer, message: 'component_truncated:length'});
            }
        }
    }

    // A schema-valid component can still carry unparseable Mermaid (the model
    // may stop before closing an `alt` block). Gate it through the same
    // recovery used for stream/validation failures, so a broken figure never
    // reaches the client. If the retry still fails, the visual slot fails closed.
    //
    if(final && isVisualComponent(planItem.kind)) {
        const healed = healMermaidSource(final.mermaid);
        if(healed !== final.mermaid) {
            log.info({componentId: planItem.id, kind: planItem.kind}, 'mermaid stray "end" auto-healed before lint');
            final.mermaid = healed;
        }
        const mermaidIssue = lintMermaidSource(final.mermaid);
        if(mermaidIssue) {
            log.warn({componentId: planItem.id, kind: planItem.kind, mermaidIssue}, 'mermaid failed structural lint; recovering');
            const recovered = await tryRecoverVisual(`mermaid_syntax: ${mermaidIssue}`);
            if(recovered) {
                final = recovered.component;
                usage = combineUsage(usage, recovered.usage);
            } else {
                return failComponent({
                    planItem,
                    index,
                    channel,
                    timer,
                    message: `invalid_mermaid:${mermaidIssue}`
                });
            }
        }
    }

    if(final) {
        try {
            const annotationUsage = await postProcessComponent(final, {
                planItem,
                evidenceItems,
                question,
                signal,
                channel,
                timer,
                governor
            });
            if(annotationUsage) {
                final._annotationUsage = annotationUsage;
            }
        } catch(err) {
            governor?.releaseCall?.(synthReservation);
            log.error({err, componentId: planItem.id, kind: planItem.kind}, 'component post-processing failed');
            return failComponent({planItem, index, channel, timer, message: err?.message || 'component_postprocess_failed'});
        }
    }

    if(!usage) {
        try {
            usage = await synth.usage;
        } catch {
            usage = null;
        }
    }
    settleGovernorCall(governor, synthReservation, usage);
    if(final?._annotationUsage) {
        usage = combineUsage(usage, final._annotationUsage);
        delete final._annotationUsage;
    }

    const endMark = timer.mark(`component.${planItem.id}.end`, {ok: true, tokens: usage?.totalTokens || 0});
    channel.push({
        type: 'timing.checkpoint',
        name: endMark.name,
        sinceStart: endMark.sinceStart,
        sinceLast: endMark.sinceLast,
        ok: true,
        tokens: endMark.tokens
    });

    // Final flush of the validated component ensures the client sees the
    // canonical, schema-valid state even if mid-stream snapshots lacked
    // some optional fields. `_final: true` signals to renderers that no more
    // patches are coming, so they can distinguish "still streaming" from
    // "stream is over but content is unparseable" (e.g., bad Mermaid syntax).
    //
    channel.push({
        type: 'component.patch',
        index,
        id: planItem.id,
        componentType: final.type,
        props: {...final, _final: true}
    });

    return {ok: true, component: final, usage, index};
}

// Phrases that admit the expected evidence itself is absent from what the
// model saw. Deliberately contextual ("…in this evidence slice") so runtime
// behavior descriptions ("the modal is not shown until…") never match.
//
const ABSENCE_LANGUAGE = new RegExp([
    String.raw`\bnot (?:shown|present|included|visible|contained) in (?:this|the) (?:evidence|excerpt|slice|snippet|retrieved|provided)`,
    String.raw`\bevidence (?:slice |packet |set )?(?:does not|doesn't) (?:contain|show|include)`,
    String.raw`\b(?:does not|doesn't) (?:contain|show|include) the (?:actual|specific)`,
    String.raw`\bno (?:direct )?evidence (?:of|for|that)\b`,
    String.raw`\b(?:absent|missing) from the (?:evidence|retrieved|provided)`
].join('|'), 'i');

// An evidence_callout's kind must match its evidence. Two model mislabels are
// reconciled deterministically:
//   1. A callout whose own text admits the expected source is absent is a gap,
//      whatever the model labeled it — soft "inferred" labels would otherwise
//      hide coverage failures from the UI and the gap-rate eval.
//   2. A "gap" that cites sources without admitting absence is the opposite
//      mislabel: grounded when well-supported, inferred otherwise, so the UI
//      never shows a coverage-gap label over sourced content.
// Genuine gaps (no sourceRefs) are left untouched.
//
export function reconcileEvidenceCalloutKind(component) {
    if(component?.type !== 'evidence_callout') {
        return;
    }
    const admitsAbsence = ABSENCE_LANGUAGE.test(`${component.summary || ''}\n${component.detail || ''}`);
    if(admitsAbsence) {
        component.kind = 'gap';
        component.gapReason ||= 'not_retrieved';
        return;
    }
    const hasSourceRefs = Array.isArray(component.sourceRefs) && component.sourceRefs.length > 0;
    if(component.kind === 'grounded' && !hasSourceRefs) {
        component.kind = 'inferred';
        return;
    }
    if(component.kind !== 'gap') {
        return;
    }
    if(hasSourceRefs) {
        component.kind = 'grounded';
        delete component.gapReason;
    } else {
        component.gapReason ||= 'not_retrieved';
    }
}

async function postProcessComponent(component, {planItem, evidenceItems, question, signal, channel, timer, governor}) {
    component.id = planItem.id;
    component.type = planItem.kind;
    await enforceGroundedAnnotatedCode(component, planItem, evidenceItems, {question, signal, channel, timer, governor});
    const annotationUsage = await enforceHouseLimits(component, planItem, {question, signal, channel, timer, governor});
    reconcileComponentSourceRefs(component, evidenceItems);
    replaceUngroundedCodeWithGap(component, planItem);
    reconcileEvidenceCalloutKind(component);
    assignComponentEvidenceState(component);
    return annotationUsage;
}

async function recoverVisualComponent({
    planItem,
    outline,
    evidenceMessage,
    question,
    model,
    maxTokens,
    signal,
    channel,
    timer,
    governor,
    reason,
    failedPartial
}) {
    const retry = await retryVisualComponent({
        planItem,
        outline,
        evidenceMessage,
        question,
        model,
        maxTokens,
        signal,
        governor,
        reason,
        failedPartial
    });
    if(retry?.component) {
        const mark = timer.mark(`component.${planItem.id}.visual.retry`, {ok: true});
        channel.push({
            type: 'timing.checkpoint',
            name: mark.name,
            sinceStart: mark.sinceStart,
            sinceLast: mark.sinceLast,
            ok: true,
            reason
        });
        log.info({
            componentId: planItem.id,
            kind: planItem.kind,
            reason,
            firstLine: firstMermaidLine(retry.component.mermaid)
        }, 'visual component recovered by retry');
        return retry;
    }

    const mark = timer.mark(`component.${planItem.id}.visual.retry`, {ok: false, reason});
    channel.push({
        type: 'timing.checkpoint',
        name: mark.name,
        sinceStart: mark.sinceStart,
        sinceLast: mark.sinceLast,
        ok: false,
        reason
    });
    log.warn({
        componentId: planItem.id,
        kind: planItem.kind,
        reason
    }, 'visual component retry failed; no valid visual component emitted');
    return null;
}

async function retryVisualComponent({planItem, outline, evidenceMessage, question, model, maxTokens, signal, governor, reason, failedPartial}) {
    const schema = componentSchemaByKind[planItem.kind];
    let reservation = null;
    try {
        reservation = governor ? await governor.beforeCall(maxTokens) : null;
        const retry = await generateObject({
            model,
            schema,
            schemaName: schemaNameForKind(planItem.kind),
            schemaDescription: `A valid Mermaid-only retry for ${planItem.kind}.`,
            system: buildComponentSystemPrompt(planItem),
            messages: [
                {role: 'user', content: evidenceMessage || `No compact evidence was provided for: ${JSON.stringify(question)}.`},
                {role: 'user', content: buildComponentInstructions({planItem, outline})},
                {role: 'user', content: buildVisualRetryInstructions({planItem, reason, failedPartial})}
            ],
            maxOutputTokens: maxTokens,
            abortSignal: signal
        });
        const component = retry.object;
        component.id = planItem.id;
        component.type = planItem.kind;
        component.recovered = true;
        component.recoveryReason = `retry:${reason}`;
        const usage = retry.usage || null;
        settleGovernorCall(governor, reservation, usage);
        // The retry must clear the same structural bar; otherwise fall through
        // to an explicit failed component instead of emitting invalid Mermaid.
        // Heal first, so a retry that only trips the stray-`end` case still ships.
        //
        component.mermaid = healMermaidSource(component.mermaid);
        const retryIssue = lintMermaidSource(component.mermaid);
        if(retryIssue) {
            log.warn({componentId: planItem.id, kind: planItem.kind, retryIssue}, 'visual retry still failed mermaid lint');
            return null;
        }
        return {component, usage};
    } catch(err) {
        governor?.releaseCall?.(reservation);
        if(isAbortError(err) || signal?.aborted) {
            throw err;
        }
        log.warn({
            err,
            componentId: planItem.id,
            kind: planItem.kind,
            reason
        }, 'visual component retry failed');
        return null;
    }
}

async function recoverSchemaComponent({
    planItem,
    outline,
    evidenceMessage,
    question,
    model,
    maxTokens,
    signal,
    channel,
    timer,
    governor,
    reason,
    failedPartial
}) {
    const retry = await retrySchemaComponent({
        planItem,
        outline,
        evidenceMessage,
        question,
        model,
        maxTokens,
        signal,
        governor,
        reason,
        failedPartial
    });
    const mark = timer.mark(`component.${planItem.id}.schema.retry`, {ok: !!retry?.component, reason});
    channel.push({
        type: 'timing.checkpoint',
        name: mark.name,
        sinceStart: mark.sinceStart,
        sinceLast: mark.sinceLast,
        ok: mark.ok,
        reason
    });
    if(retry?.component) {
        log.info({componentId: planItem.id, kind: planItem.kind, reason}, 'component recovered by schema retry');
        return retry;
    }
    log.warn({componentId: planItem.id, kind: planItem.kind, reason}, 'component schema retry failed');
    return null;
}

async function retrySchemaComponent({planItem, outline, evidenceMessage, question, model, maxTokens, signal, governor, reason, failedPartial}) {
    const schema = componentSchemaByKind[planItem.kind];
    let reservation = null;
    try {
        reservation = governor ? await governor.beforeCall(maxTokens) : null;
        const retry = await generateObject({
            model,
            schema,
            schemaName: schemaNameForKind(planItem.kind),
            schemaDescription: `A corrected ${planItem.kind} component body.`,
            system: buildComponentSystemPrompt(planItem),
            messages: [
                {role: 'user', content: evidenceMessage || `No compact evidence was provided for: ${JSON.stringify(question)}.`},
                {role: 'user', content: buildComponentInstructions({planItem, outline})},
                {role: 'user', content: buildComponentRetryInstructions({planItem, reason, failedPartial})}
            ],
            maxOutputTokens: maxTokens,
            abortSignal: signal
        });
        const component = retry.object;
        component.id = planItem.id;
        component.type = planItem.kind;
        component.recovered = true;
        component.recoveryReason = `schema_retry:${reason}`;
        const usage = retry.usage || null;
        settleGovernorCall(governor, reservation, usage);
        return {component, usage};
    } catch(err) {
        governor?.releaseCall?.(reservation);
        if(isAbortError(err) || signal?.aborted) {
            throw err;
        }
        log.warn({err, componentId: planItem.id, kind: planItem.kind, reason}, 'component schema retry failed');
        return null;
    }
}

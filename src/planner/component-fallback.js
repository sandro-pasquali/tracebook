import {childLogger} from '../util/logger.js';

// Terminal outcomes for a single component synthesis: a `failComponent` that emits a
// renderable gap evidence_callout so the trace still has an artifact in this slot, and
// an `abortComponent` for the aborted-signal path. Extracted from synthesize-component.js.
//

const log = childLogger({module: 'component-synthesis'});

export function failComponent({planItem, index, channel, timer, message}) {
    const endMark = timer.mark(`component.${planItem.id}.end`, {ok: false, error: message});
    channel.push({
        type: 'timing.checkpoint',
        name: endMark.name,
        sinceStart: endMark.sinceStart,
        sinceLast: endMark.sinceLast,
        ok: false,
        error: message
    });
    // Fallback component: an evidence_callout with kind="gap" so the trace
    // still has a renderable artifact in this slot and the user sees an
    // honest signal that something didn't generate.
    //
    const fallback = {
        type: 'evidence_callout',
        id: planItem.id,
        sourceRefs: [],
        confidence: 0,
        kind: 'gap',
        evidenceState: 'generation_failure',
        gapReason: 'generation_failed',
        summary: `Could not generate ${planItem.kind} for "${planItem.intent}".`,
        detail: `Generation failed: ${message}. The plan called for this component but the model did not produce a valid output. Other components in this trace are unaffected.`
    };
    channel.push({
        type: 'component.patch',
        index,
        id: planItem.id,
        componentType: 'evidence_callout',
        props: {...fallback, _final: true}
    });
    return {ok: false, component: fallback, error: message, index};
}

export function abortComponent({planItem, index, timer}) {
    const endMark = timer.mark(`component.${planItem.id}.end`, {ok: false, error: 'aborted'});
    log.debug({
        componentId: planItem.id,
        kind: planItem.kind,
        index,
        sinceStart: endMark.sinceStart
    }, 'component synthesis aborted');
    return {ok: false, component: null, error: 'aborted', index};
}

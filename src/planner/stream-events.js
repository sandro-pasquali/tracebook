import {PRIMITIVE_TYPES} from '../registry/schemas.js';

// Compute deltas between two snapshots and yield SSE-ready events.
// Caller is responsible for updating `lastSnapshot` after consuming events.
// `isFinal` distinguishes mid-stream partials (last array element may still be
// in progress) from the final flush (everything has settled).
//
export function computeDeltas(previous, current, {isFinal = false} = {}) {
    const events = [];

    if(current.title && current.title !== previous.title) {
        events.push({type: 'trace.title', title: current.title});
    }

    const prevNarrative = Array.isArray(previous.narrative) ? previous.narrative : [];
    const currNarrative = Array.isArray(current.narrative) ? current.narrative : [];
    // Mid-stream the trailing narrative item is likely still being typed.
    // Only emit it once another item has appeared after it OR the stream is done.
    //
    const safeEnd = isFinal ? currNarrative.length : Math.max(0, currNarrative.length - 1);
    const newNarrative = currNarrative.slice(prevNarrative.length, safeEnd).filter((s) => typeof s === 'string' && s.length > 0);
    if(newNarrative.length > 0) {
        events.push({type: 'narrative.patch', items: newNarrative, startIndex: prevNarrative.length});
    }

    const prevComponents = Array.isArray(previous.components) ? previous.components : [];
    const currComponents = Array.isArray(current.components) ? current.components : [];

    for(let i = 0; i < currComponents.length; i++) {
        const candidate = currComponents[i];
        if(!candidate || typeof candidate !== 'object') {
            continue;
        }
        if(!candidate.type || !PRIMITIVE_TYPES.includes(candidate.type)) {
            continue;
        }
        if(!candidate.id) {
            continue;
        }
        if(!hasRenderableBody(candidate)) {
            continue;
        }

        const prev = prevComponents[i];
        const prevJson = prev ? JSON.stringify(prev) : null;
        const currJson = JSON.stringify(candidate);

        if(prevJson === currJson) {
            continue;
        }

        events.push({
            type: 'component.patch',
            index: i,
            id: candidate.id,
            componentType: candidate.type,
            props: candidate
        });
    }

    return events;
}

function hasRenderableBody(candidate) {
    if(candidate.type === 'annotated_code_excerpt') {
        return typeof candidate.code === 'string' && candidate.code.length > 0;
    }
    if(candidate.type === 'sequence_diagram' || candidate.type === 'mermaid_figure') {
        return typeof candidate.mermaid === 'string' && candidate.mermaid.length > 0;
    }
    if(candidate.type === 'evidence_callout') {
        return typeof candidate.summary === 'string' && candidate.summary.length > 0;
    }
    return false;
}

export function snapshot(partial, {isFinal = false} = {}) {
    const arr = Array.isArray(partial.narrative) ? partial.narrative : [];
    // Mirror the same hold-back rule used by computeDeltas, so the snapshot
    // records only what was actually emitted to the client.
    //
    const safeEnd = isFinal ? arr.length : Math.max(0, arr.length - 1);
    return {
        title: partial.title || null,
        narrative: arr.slice(0, safeEnd),
        components: Array.isArray(partial.components) ? partial.components.map((c) => (c ? {...c} : null)) : []
    };
}

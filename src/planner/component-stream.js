// Streaming predicates for component synthesis: whether a kind streams partials,
// how a partial is normalized into a renderable candidate, and whether that
// candidate has enough fields to render. Extracted from synthesize-component.js; pure.
//

const VISUAL_COMPONENT_KINDS = new Set(['sequence_diagram', 'mermaid_figure']);

export function isVisualComponent(kind) {
    return VISUAL_COMPONENT_KINDS.has(kind);
}

export function normalizePartial(partial, planItem) {
    if(!partial || typeof partial !== 'object') {
        return null;
    }
    return {
        type: planItem.kind,
        id: planItem.id,
        ...partial
    };
}

export function isRenderable(candidate, planItem) {
    if(!candidate) {
        return false;
    }
    if(planItem.kind === 'annotated_code_excerpt') {
        return typeof candidate.code === 'string' && candidate.code.length > 0;
    }
    if(planItem.kind === 'sequence_diagram' || planItem.kind === 'mermaid_figure') {
        return typeof candidate.mermaid === 'string' && candidate.mermaid.length > 0;
    }
    if(planItem.kind === 'evidence_callout') {
        return typeof candidate.summary === 'string' && candidate.summary.length > 0;
    }
    return false;
}

export function shouldStreamPartial(kind) {
    return kind === 'evidence_callout';
}

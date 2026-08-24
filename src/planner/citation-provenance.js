import {normalizeRepoPath} from '../util/repo-ignore.js';

export const EVIDENCE_STATES = Object.freeze({
    verifiedSource: 'verified_source',
    grounded: 'grounded',
    inferred: 'inferred',
    coverageGap: 'coverage_gap',
    generationFailure: 'generation_failure'
});

// Treat the evidence slice selected for a component as a hard citation
// allowlist. Models may copy a real repository path from a wider prompt, invent
// a nearby path, or cite lines outside the retrieved slice. None of those refs
// survive this boundary: paths are normalized, matched to the allowlist, and
// their line ranges are clamped to the selected evidence region.
//
export function reconcileComponentSourceRefs(component, evidenceItems = []) {
    if(!component || typeof component !== 'object') {
        return {kept: 0, removed: 0};
    }
    const allowlist = buildAllowlist(evidenceItems);
    const refs = Array.isArray(component.sourceRefs) ? component.sourceRefs : [];
    const reconciled = [];
    const seen = new Set();

    for(const ref of refs) {
        const normalizedPath = normalizeCitationPath(ref?.path);
        const candidates = normalizedPath ? allowlist.get(normalizedPath) || [] : [];
        if(candidates.length === 0) {
            continue;
        }
        const evidence = bestEvidenceRange(candidates, ref);
        const range = reconciledRange(ref, evidence);
        const key = `${normalizedPath}:${range.lineStart ?? ''}-${range.lineEnd ?? ''}`;
        if(seen.has(key)) {
            continue;
        }
        seen.add(key);
        reconciled.push({path: normalizedPath, ...range});
    }

    component.sourceRefs = reconciled;
    return {kept: reconciled.length, removed: Math.max(0, refs.length - reconciled.length)};
}

export function assignComponentEvidenceState(component) {
    if(!component || typeof component !== 'object') {
        return null;
    }
    const hasRefs = Array.isArray(component.sourceRefs) && component.sourceRefs.length > 0;
    let state;
    if(component.gapReason === 'generation_failed') {
        state = EVIDENCE_STATES.generationFailure;
    } else if(component.type === 'evidence_callout' && component.kind === 'gap') {
        state = EVIDENCE_STATES.coverageGap;
    } else if(component.type === 'annotated_code_excerpt' && hasRefs) {
        state = EVIDENCE_STATES.verifiedSource;
    } else if(component.type === 'evidence_callout' && component.kind === 'grounded' && hasRefs) {
        state = EVIDENCE_STATES.grounded;
    } else {
        // Diagrams express a synthesized relationship even when every node is
        // source-backed, so "inferred" is more accurate than implying the
        // diagram itself is a verbatim source observation.
        state = EVIDENCE_STATES.inferred;
    }
    component.evidenceState = state;
    return state;
}

export function replaceUngroundedCodeWithGap(component, planItem) {
    if(component?.type !== 'annotated_code_excerpt' || component.sourceRefs?.length > 0) {
        return false;
    }
    const id = component.id || planItem?.id || 'missing-source';
    const intent = planItem?.intent || component.caption || 'the requested code excerpt';
    for(const key of Object.keys(component)) {
        delete component[key];
    }
    Object.assign(component, {
        type: 'evidence_callout',
        id,
        sourceRefs: [],
        confidence: 0,
        reason: null,
        kind: 'gap',
        gapReason: 'not_retrieved',
        evidenceState: EVIDENCE_STATES.coverageGap,
        summary: 'The requested source excerpt was not available in this evidence slice.',
        detail: `The plan called for code that would ${intent}, but no retrieved source range could verify the excerpt. The unverified model output was removed instead of being shown as source.`
    });
    return true;
}

function buildAllowlist(evidenceItems) {
    const allowlist = new Map();
    for(const item of evidenceItems || []) {
        const normalizedPath = normalizeCitationPath(item?.path);
        if(!normalizedPath) {
            continue;
        }
        const rows = allowlist.get(normalizedPath) || [];
        rows.push({
            lineStart: positiveIntegerOrNull(item.lineStart),
            lineEnd: positiveIntegerOrNull(item.lineEnd)
        });
        allowlist.set(normalizedPath, rows);
    }
    return allowlist;
}

function normalizeCitationPath(value) {
    const normalized = normalizeRepoPath(value);
    return normalized && normalized !== '.' ? normalized : null;
}

function bestEvidenceRange(candidates, ref) {
    const refStart = positiveIntegerOrNull(ref?.lineStart);
    const refEnd = positiveIntegerOrNull(ref?.lineEnd) || refStart;
    if(refStart === null) {
        return candidates[0];
    }
    return [...candidates].sort((a, b) => {
        const overlapA = overlapSize(refStart, refEnd, a.lineStart, a.lineEnd);
        const overlapB = overlapSize(refStart, refEnd, b.lineStart, b.lineEnd);
        if(overlapA !== overlapB) {
            return overlapB - overlapA;
        }
        return rangeDistance(refStart, refEnd, a.lineStart, a.lineEnd) - rangeDistance(refStart, refEnd, b.lineStart, b.lineEnd);
    })[0];
}

function reconciledRange(ref, evidence) {
    const evidenceStart = positiveIntegerOrNull(evidence?.lineStart);
    const evidenceEnd = positiveIntegerOrNull(evidence?.lineEnd) || evidenceStart;
    if(evidenceStart === null) {
        return {lineStart: null, lineEnd: null};
    }
    let start = positiveIntegerOrNull(ref?.lineStart) || evidenceStart;
    let end = positiveIntegerOrNull(ref?.lineEnd) || start;
    if(end < start) {
        [start, end] = [end, start];
    }
    if(overlapSize(start, end, evidenceStart, evidenceEnd) === 0) {
        return {lineStart: evidenceStart, lineEnd: evidenceEnd};
    }
    start = Math.max(evidenceStart, Math.min(start, evidenceEnd));
    end = Math.max(start, Math.min(end, evidenceEnd));
    return {lineStart: start, lineEnd: end};
}

function positiveIntegerOrNull(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function overlapSize(aStart, aEnd, bStart, bEnd) {
    if(bStart === null) {
        return 0;
    }
    const end = bEnd || bStart;
    return Math.max(0, Math.min(aEnd, end) - Math.max(aStart, bStart) + 1);
}

function rangeDistance(aStart, aEnd, bStart, bEnd) {
    if(bStart === null) {
        return Number.MAX_SAFE_INTEGER;
    }
    const end = bEnd || bStart;
    if(aEnd < bStart) {
        return bStart - aEnd;
    }
    if(end < aStart) {
        return aStart - end;
    }
    return 0;
}

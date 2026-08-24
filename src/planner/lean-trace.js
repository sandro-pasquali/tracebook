export async function* synthesizeLeanTrace({question, evidencePacket, timer, signal}) {
    yield {type: 'synthesis.start', mode: 'lean'};

    const synthesisStart = timer.mark('synthesis.start', {mode: 'lean'});
    yield {type: 'timing.checkpoint', name: synthesisStart.name, sinceStart: synthesisStart.sinceStart, sinceLast: synthesisStart.sinceLast, mode: synthesisStart.mode};

    if(signal?.aborted) {
        return null;
    }

    const top = evidencePacket?.items?.[0] || null;
    const title = leanTitleFor(question, top);
    const narrative = top
        ? [`The closest source evidence is in ${top.path}${top.lineStart ? ` around lines ${top.lineStart}-${top.lineEnd}` : ''}.`]
        : ['No matching source evidence was found in the indexed codebase.'];
    const component = top ? {
        type: 'evidence_callout',
        id: 'direct-evidence',
        sourceRefs: [{
            path: top.path,
            lineStart: top.lineStart,
            lineEnd: top.lineEnd
        }],
        confidence: typeof top.score === 'number' ? Math.max(0.55, Math.min(0.95, top.score)) : 0.75,
        kind: 'grounded',
        evidenceState: 'grounded',
        summary: `Best match: ${top.path}`,
        detail: `The retrieved evidence points to ${top.path}${top.lineStart ? ` lines ${top.lineStart}-${top.lineEnd}` : ''}. Open the source reference for the exact implementation context.`
    } : {
        type: 'evidence_callout',
        id: 'missing-evidence',
        sourceRefs: [],
        confidence: 0,
        kind: 'gap',
        evidenceState: 'coverage_gap',
        gapReason: 'not_retrieved',
        summary: 'No source evidence found.',
        detail: 'The retrieval phase did not return a source snippet strong enough to answer this directly.'
    };
    const trace = {title, narrative, components: [component]};

    yield {type: 'trace.title', title};
    yield {type: 'narrative.patch', items: narrative, startIndex: 0};
    yield {
        type: 'component.patch',
        index: 0,
        id: component.id,
        componentType: component.type,
        props: {...component, _final: true}
    };

    const usage = null;
    const synthesisEnd = timer.mark('synthesis.end', {tokens: 0, components: trace.components.length, mode: 'lean'});
    yield {type: 'timing.checkpoint', name: synthesisEnd.name, sinceStart: synthesisEnd.sinceStart, sinceLast: synthesisEnd.sinceLast, tokens: synthesisEnd.tokens, components: synthesisEnd.components, mode: synthesisEnd.mode};

    return {trace, usage};
}

function leanTitleFor(question, evidence) {
    const q = String(question || '').slice(0, 60);
    return evidence?.path ? `Source match for "${q}"` : `No source match for "${q}"`;
}

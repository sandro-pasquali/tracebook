export function chooseSynthesisMode({question, evidencePacket, fastPath, classification}) {
    const q = String(question || '').trim();
    const evidenceCount = evidencePacket?.items?.length || 0;
    const intent = classification?.intent || 'explain_behavior';

    if(evidenceCount === 0) {
        return {mode: 'lean', reason: 'no_evidence'};
    }
    if(intent === 'locate_source' && classification?.preferredAnswerShapes?.includes('annotated_code_excerpt')) {
        return {mode: 'full', reason: 'identifier_requires_source'};
    }
    if(intent === 'locate_source' && classification?.allowsLean && q.length <= 140) {
        return {mode: 'lean', reason: 'intent_locate_source'};
    }
    if(fastPath && intent === 'locate_source' && q.length <= 100) {
        return {mode: 'lean', reason: 'fastpath_simple'};
    }
    return {mode: 'full', reason: `intent_${intent}`};
}

import {config} from '../../util/config.js';

// Build the user message that surfaces prior traces to the LLM as context.
// Only includes traces above the similarity floor — low-similarity hits would
// add noise without value. Used by both the exploration and outline lead-ins.
//
export function buildSimilarTracesMessage(traces) {
    const useful = (traces || []).filter((t) => typeof t.similarity === 'number' && t.similarity >= config.traces.similarMinSimilarity);
    if(useful.length === 0) {
        return '';
    }
    const lines = ['## System memory — similar prior questions'];
    lines.push('The system has answered questions like this before. You may use these as orientation, but always re-verify against the current code.');
    lines.push('');
    for(const t of useful.slice(0, 3)) {
        const kinds = (t.componentKinds || []).join(', ') || 'none';
        const age = t.ageDays !== null && t.ageDays !== undefined ? `${t.ageDays}d ago` : 'recent';
        lines.push(`- "${t.question}" (${age}, sim ${t.similarity.toFixed(2)})`);
        if(t.summary) {
            lines.push(`  summary: ${t.summary}`);
        }
        if(kinds) {
            lines.push(`  components used: ${kinds}`);
        }
    }
    return lines.join('\n');
}

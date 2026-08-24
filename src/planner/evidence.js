import {EOL} from 'node:os';
import {clipToLineBudget, dedupeBy, isSupportingEvidencePath} from '../util/retrieval-core.js';
import {roleForRepoSupportingPath} from '../language-integrations/registry.js';
import {isSubstantiveSourceLine} from '../util/source-syntax.js';
import {isSystemOverviewQuestion, wantsDependencyManifest, wantsSupportingEvidence} from '../util/retrieval-intent.js';
import {isAbortError} from './usage.js';
import {rankEvidenceItems, selectLayerDiverse, selectPathDiverse} from './evidence-policy.js';

export {EVIDENCE_STOPWORDS, questionSubjectScore, rankEvidenceItems, rankEvidenceItemsWithScores, selectLayerDiverse, selectPathDiverse, sourceLayerForEvidence} from './evidence-policy.js';

// Build a short, human-readable summary of a tool result for the Exploration rail.
// The full result is what the LLM consumes; this string is what the user sees.
//
export function summarizeToolResult(toolName, result) {
    if(!result || typeof result !== 'object') return '';
    if(result.error) return `error: ${result.error}`;

    if(toolName === 'search_codebase') {
        const n = result.count ?? (result.results?.length || 0);
        const paths = (result.results || []).map((r) => r.path).slice(0, 3);
        const retrieval = formatRetrievalSummary(result.retrieval);
        const suffix = retrieval ? ` · ${retrieval}` : '';
        return n === 0
            ? 'no matches'
            : `${n} matches${suffix}: ${paths.join(', ')}${n > paths.length ? ', …' : ''}`;
    }
    if(toolName === 'read_file') {
        const truncated = result.truncated ? ' (truncated)' : '';
        return `${result.path} lines ${result.lineStart}-${result.lineEnd} of ${result.totalLines}${truncated}`;
    }
    if(toolName === 'list_dir') {
        const truncated = result.truncated ? ' (truncated)' : '';
        return `${result.path}: ${result.count} entries${truncated}`;
    }
    if(toolName === 'grep') {
        return result.count === 0
            ? `no matches for "${result.pattern}"`
            : `${result.count} matches for "${result.pattern}"${result.truncated ? ' (truncated)' : ''}`;
    }
    return JSON.stringify(result).slice(0, 120);
}

export function summarizeToolInput(toolName, input) {
    if(!input || typeof input !== 'object') return '';
    if(toolName === 'search_codebase') return JSON.stringify(compactSearchSummary(input.query || ''));
    if(toolName === 'read_file') {
        const range = input.lineStart || input.lineEnd ? ` (${input.lineStart || 1}-${input.lineEnd || '?'})` : '';
        return `${input.path || ''}${range}`;
    }
    if(toolName === 'list_dir') return input.path || '.';
    if(toolName === 'grep') return JSON.stringify(input.pattern || '');
    return JSON.stringify(input).slice(0, 120);
}

function compactSearchSummary(query) {
    const firstLine = String(query || '').split('\n').find((line) => line.trim()) || '';
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

const EVIDENCE_LIMITS = {
    outlineItems: 8,
    componentItems: 4,
    snippetChars: 2200,
    readFileChars: 6000,
    grepLineChars: 160
};
export const PREFETCH_LIMITS = {
    primary: 8,
    supportItems: 3
};

export function buildEvidencePacket({question, explorationMessages, displayQuestion = question, architectureHubs = [], corpusCoverage = null}) {
    const items = extractEvidenceItems(explorationMessages);
    const outlineItems = selectOutlineEvidence(items, question, {hubPaths: architectureHubs.map((hub) => hub.path)});
    // The hub section gives the outline an explicit importance signal: for
    // overview-style questions the phrasing carries no ranking tokens, so
    // without this the model cannot tell load-bearing files from leaves.
    //
    const hubSection = architectureHubs.length > 0
        ? `${EOL}${EOL}## Architecture hubs (the files that wire the most project files together — the repo's spine)${EOL}${architectureHubs.map((hub) => `- ${hub.path} (wires together ${hub.wires} project files)`).join(EOL)}`
        : '';
    return {
        question: displayQuestion,
        retrievalQuestion: question,
        items,
        architectureHubs,
        corpusCoverage,
        retrieval: summarizeRetrievalFromMessages(explorationMessages),
        outlineMessage: formatEvidenceMessage({
            title: 'Evidence packet',
            question: displayQuestion,
            items: outlineItems,
            includeGuidance: true
        }) + hubSection
    };
}

export function buildEvidenceReadyEvent(packet, {stage = ''} = {}) {
    return {
        type: 'evidence.ready',
        stage,
        retrieval: {
            ...(packet?.retrieval || {}),
            coverage: packet?.corpusCoverage || null,
            stage
        },
        items: selectVisibleEvidence(packet?.items || [], packet?.retrievalQuestion || packet?.question || '').map((item) => ({
            path: item.path,
            lineStart: item.lineStart,
            lineEnd: item.lineEnd,
            role: evidenceRole(item.path) || 'source',
            tool: item.tool,
            score: item.score,
            truncated: item.truncated
        }))
    };
}

// evidence.ready is observability, not the outline prompt budget. Report every
// filtered item that was actually available to planning/components so the
// source rail and grounding eval do not incorrectly label a valid allowlisted
// citation as unseen merely because it fell below the outline's top-eight cap.
// The browser still applies its own compact display cap.
//
function selectVisibleEvidence(items, question) {
    const selected = selectOutlineEvidence(items, question);
    const seen = new Set(selected);
    const allowDependencies = wantsDependencyManifest(question);
    for(const item of rankEvidenceItems(items, question)) {
        if(seen.has(item)) {
            continue;
        }
        if(!allowDependencies && isDependencyEvidencePath(item.path)) {
            continue;
        }
        selected.push(item);
        seen.add(item);
    }
    return selected;
}

function summarizeRetrievalFromMessages(messages = []) {
    const searches = [];
    for(const message of messages) {
        const parts = Array.isArray(message?.content) ? message.content : [];
        for(const part of parts) {
            if(part?.type !== 'tool-result' || part.toolName !== 'search_codebase') {
                continue;
            }
            const result = unwrapToolOutput(part.output ?? part.result);
            if(result && typeof result === 'object') {
                searches.push(result);
            }
        }
    }
    if(searches.length === 0) {
        return {searches: 0, modes: [], totalMs: 0, results: 0};
    }
    const modes = new Set();
    let totalMs = 0;
    let results = 0;
    let vectorCandidates = 0;
    let graphRows = 0;
    let lexicalRows = 0;
    let supportRows = 0;
    for(const result of searches) {
        const retrieval = result.retrieval || {};
        for(const mode of retrieval.modes || []) {
            modes.add(mode);
        }
        totalMs += Number(retrieval.timings?.totalMs) || 0;
        results += Number(result.count) || Number(retrieval.counts?.results) || 0;
        vectorCandidates += Number(retrieval.counts?.vectorCandidates) || 0;
        graphRows += Number(retrieval.counts?.graphRows) || 0;
        lexicalRows += Number(retrieval.counts?.lexicalRows) || 0;
        supportRows += Number(retrieval.counts?.supportRows) || 0;
    }
    return {
        searches: searches.length,
        modes: [...modes],
        totalMs,
        results,
        vectorCandidates,
        graphRows,
        lexicalRows,
        supportRows
    };
}

export function withSharedEmbeddingTiming(result, embeddingMs) {
    if(!result || typeof result !== 'object' || !result.retrieval || !Number.isFinite(embeddingMs) || embeddingMs <= 0) {
        return result;
    }
    const retrieval = {
        ...result.retrieval,
        timings: {...(result.retrieval.timings || {})}
    };
    retrieval.timings.embeddingMs = embeddingMs;
    retrieval.timings.totalMs = (Number(retrieval.timings.totalMs) || 0) + embeddingMs;
    return {...result, retrieval};
}

function formatRetrievalSummary(retrieval) {
    if(!retrieval || typeof retrieval !== 'object') {
        return '';
    }
    const modes = Array.isArray(retrieval.modes) && retrieval.modes.length
        ? retrieval.modes.join('+')
        : '';
    const ms = Number(retrieval.timings?.totalMs);
    return [modes, Number.isFinite(ms) ? `${ms}ms` : ''].filter(Boolean).join(' ');
}

function selectOutlineEvidence(items, question = '', {hubPaths = []} = {}) {
    const limit = EVIDENCE_LIMITS.outlineItems;
    const ranked = rankEvidenceItems(items, question);
    // Overview questions open the supporting slots too: README/docs index with
    // a supporting role, and a system-overview outline that cannot see the
    // repo's own overview documentation narrates blind.
    //
    const allowSupport = wantsSupportingEvidence(question) || isSystemOverviewQuestion(question);
    const allowDependencies = wantsDependencyManifest(question);
    // Architecture-hub items get reserved slots: their head chunks carry no
    // retrieval score, so open ranking buries the spine under search hits.
    //
    const hubSet = new Set(hubPaths);
    const hubItems = ranked
        .filter((item) => hubSet.has(item.path))
        .slice(0, 5);
    const hubSelected = new Set(hubItems);
    // One ambient supporting slot stays open even for pure behavior questions:
    // a README or config file that ranked for the question is cheap context
    // worth surfacing. Dependency docs remain gated behind explicit dependency
    // phrasing (allowDependencies) either way.
    //
    const supportLimit = allowSupport ? 3 : 1;
    const supporting = ranked
        .filter((item) => !hubSelected.has(item) && isSupportingEvidencePath(item.path))
        .filter((item) => allowDependencies || !isDependencyEvidencePath(item.path))
        .slice(0, supportLimit);
    const primary = selectLayerDiverse(
        ranked.filter((item) => !hubSelected.has(item) && !hubSet.has(item.path) && !isSupportingEvidencePath(item.path)),
        Math.max(0, limit - supporting.length - hubItems.length)
    );
    const selected = [...hubItems, ...primary, ...supporting];
    if(selected.length >= limit) {
        return selected.slice(0, limit);
    }
    for(const item of ranked) {
        if(selected.includes(item)) continue;
        if(!allowSupport && isSupportingEvidencePath(item.path)) continue;
        if(!allowDependencies && isDependencyEvidencePath(item.path)) continue;
        selected.push(item);
        if(selected.length >= limit) break;
    }
    return selected;
}

function extractEvidenceItems(messages = []) {
    const items = [];
    for(const message of messages) {
        const parts = Array.isArray(message?.content) ? message.content : [];
        for(const part of parts) {
            if(part?.type !== 'tool-result') {
                continue;
            }
            items.push(...itemsFromToolResult(part.toolName, unwrapToolOutput(part.output ?? part.result)));
        }
    }
    return dedupeEvidenceItems(items);
}

function itemsFromToolResult(toolName, result) {
    if(!result || typeof result !== 'object' || result.error) {
        return [];
    }

    if(toolName === 'search_codebase') {
        return (result.results || []).map((r) => {
            const evidence = truncateLineNumberedEvidence(r.content || '', EVIDENCE_LIMITS.snippetChars, r.lineStart, r.lineEnd);
            return {
                tool: toolName,
                path: r.path,
                lineStart: evidence.lineStart,
                lineEnd: evidence.lineEnd,
                score: typeof r.similarity === 'number' ? r.similarity : null,
                content: evidence.content,
                truncated: !!r.truncated || evidence.truncated,
                relationship: r.relationship || null
            };
        }).filter((i) => i.path && i.content);
    }

    if(toolName === 'read_file') {
        const evidence = truncateLineNumberedEvidence(result.content || '', EVIDENCE_LIMITS.readFileChars, result.lineStart, result.lineEnd);
        return [{
            tool: toolName,
            path: result.path,
            lineStart: evidence.lineStart,
            lineEnd: evidence.lineEnd,
            score: null,
            content: evidence.content,
            truncated: !!result.truncated || evidence.truncated
        }].filter((i) => i.path && i.content);
    }

    if(toolName === 'grep') {
        return (result.matches || []).slice(0, 8).map((m) => {
            const evidence = truncateLineNumberedEvidence(`${m.line}  ${m.content || ''}`, EVIDENCE_LIMITS.grepLineChars, m.line, m.line);
            return {
                tool: toolName,
                path: m.path,
                lineStart: evidence.lineStart,
                lineEnd: evidence.lineEnd,
                score: null,
                content: evidence.content,
                truncated: evidence.truncated
            };
        }).filter((i) => i.path && i.content);
    }

    return [];
}

export function wrapToolOutput(output) {
    return {type: 'json', value: output ?? null};
}

function unwrapToolOutput(output) {
    if(output && typeof output === 'object' && 'type' in output && 'value' in output) {
        return output.value;
    }
    return output;
}

function dedupeEvidenceItems(items) {
    return dedupeBy(items, (item) => `${item.path}:${item.lineStart || ''}-${item.lineEnd || ''}:${item.content}`);
}

export function evidenceForPlanItem(packet, planItem) {
    const items = packet?.items || [];
    if(items.length === 0) {
        return [];
    }

    const hints = Array.isArray(planItem?.sourceRefHint) ? planItem.sourceRefHint : [];
    const kind = planItem?.kind || '';
    const pool = kind === 'annotated_code_excerpt'
        ? preferSubstantiveCodeEvidence(items)
        : items;
    const selectionQuestion = [packet?.retrievalQuestion || packet?.question || '', planItem?.intent || '']
        .filter(Boolean)
        .join('\n');
    if(hints.length === 0) {
        return selectComponentEvidence(pool, kind, selectionQuestion);
    }

    const scored = pool.map((item, index) => ({
        item,
        index,
        score: scoreEvidenceForHints(item, hints)
    }));
    // Hints fill at most all-but-one slot. The outline model picks hints from a
    // small evidence window and sometimes picks wrong; reserving one slot for
    // the top globally-ranked item means a bad hint can narrow a component's
    // evidence but never fully starve it of what the ranking considers the
    // strongest source for the question.
    //
    const hinted = scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((s) => s.item)
        .slice(0, Math.max(1, EVIDENCE_LIMITS.componentItems - 1));
    if(hinted.length === 0) {
        return selectComponentEvidence(pool, kind, selectionQuestion);
    }
    const selected = [...hinted];
    for(const item of selectComponentEvidence(pool, kind, selectionQuestion)) {
        if(selected.length >= EVIDENCE_LIMITS.componentItems) {
            break;
        }
        if(!selected.includes(item)) {
            selected.push(item);
        }
    }
    return selected;
}

export async function expandEvidenceForPlan({packet, outline, tools, question, signal}) {
    if(!packet || !Array.isArray(packet.items) || !outline || !Array.isArray(outline.plan) || typeof tools?.read_file?.execute !== 'function') {
        return {packet, events: [], added: 0};
    }
    if(signal?.aborted) {
        return {packet, events: [], added: 0};
    }

    const events = [];
    const additions = [];
    const seenReads = new Set();
    for(const planItem of outline.plan) {
        if(signal?.aborted) {
            break;
        }
        if(planItem?.kind !== 'annotated_code_excerpt') {
            continue;
        }
        const refs = Array.isArray(planItem.sourceRefHint) ? planItem.sourceRefHint : [];
        for(const ref of refs.slice(0, 2)) {
            if(signal?.aborted) {
                break;
            }
            if(!ref?.path || !shouldExpandSourceRef(packet.items, ref, planItem, question)) {
                continue;
            }
            const range = expandedReadRange(ref);
            const key = `${ref.path}:${range.lineStart}-${range.lineEnd}`;
            if(seenReads.has(key)) {
                continue;
            }
            seenReads.add(key);
            const startedAt = Date.now();
            const input = {path: ref.path, ...range};
            events.push({type: 'tool.call', tool: 'read_file', inputSummary: summarizeToolInput('read_file', input), expansion: true});
            let result;
            try {
                result = await tools.read_file.execute(input, {abortSignal: signal});
            } catch(err) {
                if(isAbortError(err) || signal?.aborted) {
                    return buildEvidenceExpansionResult({packet, events, additions});
                }
                result = {
                    error: 'read_failed',
                    path: ref.path,
                    message: err?.message || String(err)
                };
            }
            events.push({
                type: 'tool.result',
                tool: 'read_file',
                summary: summarizeToolResult('read_file', result),
                durationMs: Date.now() - startedAt,
                expansion: true
            });
            additions.push(...itemsFromToolResult('read_file', result));
        }
    }

    return buildEvidenceExpansionResult({packet, events, additions});
}

function buildEvidenceExpansionResult({packet, events, additions}) {
    if(additions.length === 0) {
        return {packet, events, added: 0};
    }
    return {
        packet: {
            ...packet,
            items: dedupeEvidenceItems([...additions, ...packet.items])
        },
        events,
        added: additions.length
    };
}

function shouldExpandSourceRef(items, ref, planItem, question) {
    if(isSupportingEvidencePath(ref.path)) {
        return false;
    }
    const existing = (items || []).filter((item) => item.path === ref.path);
    if(existing.length === 0) {
        return true;
    }
    if(existing.some((item) => item.tool === 'read_file' && coversRange(item, ref) && evidenceLineSpan(item) >= 45)) {
        return false;
    }
    const text = [question, planItem?.intent, planItem?.id].filter(Boolean).join(' ').toLowerCase();
    const wantsBehavior = /\b(flow|when|fires?|happens?|watch(?:er|ing)?|sync|event|listener|handler|callback|route|request|response|change|add|unlink|remove|index|reindex|behavior|process|pipeline|lifecycle|how|matters?)\b/.test(text);
    return wantsBehavior || existing.some((item) => item.truncated || evidenceLineSpan(item) < 35);
}

function coversRange(item, ref) {
    const itemStart = Number(item?.lineStart) || 1;
    const itemEnd = Number(item?.lineEnd) || itemStart;
    const refStart = Number(ref?.lineStart) || itemStart;
    const refEnd = Number(ref?.lineEnd) || refStart;
    return itemStart <= refStart && itemEnd >= refEnd;
}

export function evidenceLineSpan(item) {
    const start = Number(item?.lineStart) || 1;
    const end = Number(item?.lineEnd) || start;
    return Math.max(1, end - start + 1);
}

function expandedReadRange(ref) {
    const start = Math.max(1, (Number(ref.lineStart) || 1) - 10);
    const anchorEnd = Number(ref.lineEnd) || Number(ref.lineStart) || start;
    return {
        lineStart: start,
        lineEnd: anchorEnd + 170
    };
}

function selectComponentEvidence(items, kind, question = '') {
    const limit = EVIDENCE_LIMITS.componentItems;
    const ranked = rankEvidenceItems(items, question);
    if(kind === 'annotated_code_excerpt') {
        return selectPathDiverse(ranked, limit);
    }
    const allowDependencies = wantsDependencyManifest(question);
    const supporting = ranked
        .filter((item) => isSupportingEvidencePath(item.path))
        .filter((item) => allowDependencies || !isDependencyEvidencePath(item.path))
        .slice(0, wantsSupportingEvidence(question) ? 1 : 0);
    const primary = selectLayerDiverse(
        ranked.filter((item) => !isSupportingEvidencePath(item.path)),
        Math.max(0, limit - supporting.length)
    );
    const selected = [...primary, ...supporting];
    if(selected.length >= limit) {
        return selected.slice(0, limit);
    }
    for(const item of ranked) {
        if(selected.includes(item)) continue;
        if(!allowDependencies && isDependencyEvidencePath(item.path)) continue;
        selected.push(item);
        if(selected.length >= limit) break;
    }
    return selected;
}

function preferSubstantiveCodeEvidence(items) {
    const substantive = items.filter(isSubstantiveCodeEvidence);
    return substantive.length > 0 ? substantive : items;
}

export function isSubstantiveCodeEvidence(item) {
    const lines = String(item?.content || '').split('\n');
    const path = String(item?.path || '');
    const codeLines = lines
        .map(stripLineNumber)
        .filter((line) => isSubstantiveSourceLine(line, {path}));
    return codeLines.length >= 3;
}

export function stripLineNumber(line) {
    return String(line || '').replace(/^\s*\d+\s+[|:]?\s?/, '');
}

function scoreEvidenceForHints(item, hints) {
    let score = 0;
    for(const hint of hints) {
        if(!hint?.path || hint.path !== item.path) {
            continue;
        }
        score += 2;
        const hintStart = numberOrNull(hint.lineStart);
        const hintEnd = numberOrNull(hint.lineEnd);
        if(hintStart === null || hintEnd === null || item.lineStart === null || item.lineEnd === null) {
            score += 1;
            continue;
        }
        if(rangesOverlap(item.lineStart, item.lineEnd, hintStart, hintEnd)) {
            score += 3;
        }
    }
    return score;
}

export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart <= bEnd && bStart <= aEnd;
}

export function formatEvidenceMessage({title, question, items, includeGuidance = false}) {
    const lines = [`## ${title}`];
    lines.push(`Question: ${question}`);
    lines.push('');
    if(includeGuidance) {
        lines.push('Use only this evidence for source-grounded claims. Cite only listed paths and line ranges.');
        lines.push('For component sourceRefHint values, prefer the path and line ranges shown below.');
        lines.push('Use dependency, manifest, and config evidence only when it materially explains the requested behavior or runtime shape.');
        lines.push('');
    }
    if(!items || items.length === 0) {
        lines.push('No source evidence was found.');
        return lines.join(EOL);
    }
    items.forEach((item, i) => {
        const range = item.lineStart && item.lineEnd ? ` lines ${item.lineStart}-${item.lineEnd}` : '';
        const score = typeof item.score === 'number' ? ` similarity ${item.score.toFixed(4)}` : '';
        const truncated = item.truncated ? ' truncated' : '';
        const role = evidenceRole(item.path);
        const relation = formatEvidenceRelationship(item.relationship);
        lines.push(`### E${i + 1}: ${item.path}${range}`);
        lines.push(`source: ${item.tool}${score}${truncated}${role ? ` · ${role}` : ''}${relation ? ` · ${relation}` : ''}`);
        lines.push('```text');
        lines.push(item.content || '');
        lines.push('```');
        lines.push('');
    });
    return lines.join(EOL);
}

function formatEvidenceRelationship(relationship) {
    if(!relationship || typeof relationship !== 'object') {
        return '';
    }
    const parts = [
        relationship.kind,
        relationship.name,
        relationship.target ? `-> ${relationship.target}` : '',
        relationship.detail
    ].filter(Boolean);
    return parts.length ? `graph ${parts.join(' ')}` : '';
}

function evidenceRole(path) {
    const p = String(path || '');
    if(p.startsWith('__dependencies__/')) return 'dependency';
    const role = roleForRepoSupportingPath(p);
    if(role) return role;
    return '';
}

function isDependencyEvidencePath(path) {
    return String(path || '').startsWith('__dependencies__/');
}

function truncateLineNumberedEvidence(text, maxChars, fallbackStart, fallbackEnd) {
    const clipped = clipToLineBudget(text, maxChars);
    const range = visibleLineRange(clipped.content, fallbackStart, fallbackEnd);
    return {
        content: clipped.content,
        lineStart: range.lineStart,
        lineEnd: range.lineEnd,
        truncated: clipped.truncated
    };
}

function visibleLineRange(text, fallbackStart, fallbackEnd) {
    const lineNumbers = [];
    for(const line of String(text || '').split(/\r?\n/)) {
        const match = line.match(/^\s*(\d+)\s{2}/);
        if(match) {
            lineNumbers.push(Number(match[1]));
        }
    }
    if(lineNumbers.length > 0) {
        return {
            lineStart: lineNumbers[0],
            lineEnd: lineNumbers[lineNumbers.length - 1]
        };
    }
    const start = numberOrNull(fallbackStart) || 1;
    return {
        lineStart: start,
        lineEnd: numberOrNull(fallbackEnd) || start
    };
}

export function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

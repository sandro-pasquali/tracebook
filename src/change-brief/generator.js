import {generateObject} from 'ai';
import {config} from '../util/config.js';
import {resolveModel} from '../util/model.js';
import {buildFeatureTrace} from '../feature-trace.js';
import {reconcileComponentSourceRefs} from '../planner/citation-provenance.js';
import {settleGovernorCall} from '../planner/usage.js';
import {changeBriefDraftSchema, changeBriefOutputFormatSchema, sanitizeChangeBriefDraft} from './schema.js';
import {renderAgentPrompt} from './render.js';

const MAX_EVIDENCE_ITEMS = 12;
const MAX_MODEL_EVIDENCE_CHARS = 14_000;

export async function generateChangeBrief({
    savedTrace,
    changeIntent,
    outputFormat = 'llm_prompt',
    tools,
    governor = null,
    sourceRevision = null,
    model = resolveModel(config.models.outline),
    generate = generateObject,
    maxOutputTokens = Math.max(config.planner.outlineMaxTokens, 2200),
    now = Date.now
} = {}) {
    if(!savedTrace?.traceId) {
        throw new Error('generateChangeBrief requires a saved trace');
    }
    const intent = String(changeIntent || '').trim();
    if(!intent) {
        throw new Error('generateChangeBrief requires changeIntent');
    }
    const format = changeBriefOutputFormatSchema.parse(outputFormat);

    const featureTrace = resolveFeatureTrace(savedTrace);
    const evidence = await collectBriefEvidence({savedTrace, featureTrace, changeIntent: intent, tools});
    const candidateFiles = candidateFilesFromEvidence(evidence);
    const system = buildSystemPrompt();
    const prompt = buildUserPrompt({savedTrace, featureTrace, changeIntent: intent, evidence});
    const reservation = governor ? await governor.beforeCall(maxOutputTokens) : null;

    let result;
    try {
        result = await generate({
            model,
            schema: changeBriefDraftSchema,
            schemaName: 'ChangeBriefDraft',
            schemaDescription: 'A source-grounded implementation brief for an AI coding agent.',
            system,
            prompt,
            maxOutputTokens,
            temperature: 0.2
        });
    } catch(err) {
        governor?.releaseCall?.(reservation);
        throw err;
    }
    settleGovernorCall(governor, reservation, result?.usage);

    const draft = reconcileDraft({
        draft: sanitizeChangeBriefDraft(result.object),
        candidateFiles,
        evidence
    });
    const createdAt = now();
    const traceSourceRevision = normalizeRevision(savedTrace.sourceRevision);
    const currentRevision = normalizeRevision(sourceRevision);
    const freshness = traceSourceRevision && currentRevision
        ? (traceSourceRevision === currentRevision ? 'current' : 'stale')
        : 'unknown';
    const brief = {
        ...draft,
        briefId: '',
        traceId: savedTrace.traceId,
        createdAt,
        sourceRevision: currentRevision,
        traceSourceRevision,
        freshness,
        changeIntent: intent,
        outputFormat: format,
        agentPrompt: '',
        evidence: evidence.map((item) => ({
            path: item.path,
            lineStart: item.lineStart,
            lineEnd: item.lineEnd,
            reason: item.reason,
            confidence: item.confidence,
            content: item.content || ''
        })).slice(0, MAX_EVIDENCE_ITEMS)
    };
    brief.agentPrompt = renderAgentPrompt(brief, {outputFormat: format});
    return brief;
}

function resolveFeatureTrace(saved) {
    if(saved?.featureTrace) {
        return saved.featureTrace;
    }
    const complete = [...(saved?.events || [])].reverse().find((event) => event?.type === 'trace.complete');
    return complete?.featureTrace || buildFeatureTrace({
        question: saved?.question,
        trace: saved?.trace || complete?.trace,
        traceId: saved?.traceId,
        createdAt: saved?.finishedAt || Date.now()
    });
}

async function collectBriefEvidence({savedTrace, featureTrace, changeIntent, tools}) {
    const evidence = [];
    addTraceEvidence(evidence, savedTrace, featureTrace);

    if(tools?.search_codebase?.execute) {
        const query = [
            changeIntent,
            savedTrace.question,
            savedTrace.trace?.title,
            ...(savedTrace.trace?.narrative || []),
            'tests validation route service UI config schema'
        ].filter(Boolean).join('\n');
        const result = await tools.search_codebase.execute({query, limit: 8}, {});
        for(const row of result?.results || []) {
            if(!row?.path) {
                continue;
            }
            evidence.push({
                path: row.path,
                lineStart: numberOrNull(row.lineStart),
                lineEnd: numberOrNull(row.lineEnd),
                reason: row.relationship?.kind
                    ? `Retrieved via ${row.relationship.kind} evidence for the requested change.`
                    : 'Retrieved as source evidence for the requested change.',
                confidence: typeof row.similarity === 'number' && row.similarity >= 0.65 ? 'high' : 'medium',
                content: stripLinePrefixes(row.content || '').slice(0, 1800),
                source: 'search'
            });
        }
    }

    return dedupeEvidence(evidence).slice(0, MAX_EVIDENCE_ITEMS);
}

function addTraceEvidence(evidence, savedTrace, featureTrace) {
    for(const entry of featureTrace?.entrypoints || []) {
        if(!entry?.path) {
            continue;
        }
        evidence.push({
            path: entry.path,
            lineStart: numberOrNull(entry.lineStart),
            lineEnd: numberOrNull(entry.lineEnd),
            reason: `Feature trace entrypoint for ${entry.role || 'implementation'} behavior.`,
            confidence: 'high',
            content: '',
            source: 'featureTrace'
        });
    }
    for(const item of featureTrace?.evidence || []) {
        if(!item?.path) {
            continue;
        }
        evidence.push({
            path: item.path,
            lineStart: numberOrNull(item.lineStart),
            lineEnd: numberOrNull(item.lineEnd),
            reason: item.claim || 'Source cited by the completed trace.',
            confidence: 'high',
            content: '',
            source: 'featureTrace'
        });
    }
    for(const component of savedTrace?.trace?.components || []) {
        for(const ref of component?.sourceRefs || []) {
            if(!ref?.path) {
                continue;
            }
            evidence.push({
                path: ref.path,
                lineStart: numberOrNull(ref.lineStart),
                lineEnd: numberOrNull(ref.lineEnd),
                reason: component.summary || component.caption || component.reason || 'Source cited by the completed trace.',
                confidence: confidenceFromNumber(component.confidence),
                content: component.code || '',
                source: 'component'
            });
        }
    }
}

function candidateFilesFromEvidence(evidence) {
    const byPath = new Map();
    for(const item of evidence) {
        if(!item.path) {
            continue;
        }
        const current = byPath.get(item.path);
        const sourceRef = sourceRefFor(item);
        if(!current) {
            byPath.set(item.path, {
                path: item.path,
                role: roleForPath(item.path),
                reason: item.reason,
                confidence: item.confidence,
                sourceRefs: sourceRef ? [sourceRef] : []
            });
            continue;
        }
        current.confidence = strongerConfidence(current.confidence, item.confidence);
        if(sourceRef && !current.sourceRefs.some((ref) => ref.path === sourceRef.path && ref.lineStart === sourceRef.lineStart && ref.lineEnd === sourceRef.lineEnd)) {
            current.sourceRefs.push(sourceRef);
        }
    }
    return [...byPath.values()].slice(0, 8);
}

function reconcileDraft({draft, candidateFiles, evidence}) {
    const allowed = new Map(candidateFiles.map((file) => [file.path, file]));
    const files = [];
    for(const file of draft.likelyFiles || []) {
        const candidate = allowed.get(file.path);
        if(!candidate) {
            continue;
        }
        files.push({
            ...candidate,
            ...file,
            role: reconcileRole(file.role, candidate.role),
            confidence: strongerConfidence(candidate.confidence, file.confidence),
            sourceRefs: normalizeSourceRefs(file.sourceRefs, candidate.sourceRefs, candidate.sourceRefs)
        });
    }
    for(const candidate of candidateFiles) {
        if(files.some((file) => file.path === candidate.path)) {
            continue;
        }
        files.push(candidate);
        if(files.length >= 6) {
            break;
        }
    }

    const normalizedFiles = files.length > 0 ? files.slice(0, 8) : fallbackFiles(evidence);
    return {
        ...draft,
        likelyFiles: normalizedFiles,
        existingPatterns: normalizeEvidenceBackedItems(draft.existingPatterns, normalizedFiles, evidence),
        implementationConstraints: normalizeEvidenceBackedItems(draft.implementationConstraints, normalizedFiles, evidence),
        testPlan: normalizeEvidenceBackedItems(draft.testPlan, normalizedFiles, evidence),
        riskNotes: normalizeEvidenceBackedItems(draft.riskNotes, normalizedFiles, evidence)
    };
}

function fallbackFiles(evidence) {
    return candidateFilesFromEvidence(evidence).slice(0, 3);
}

function normalizeEvidenceBackedItems(items, files, evidence) {
    const fallbackRefs = files.flatMap((file) => file.sourceRefs || []).slice(0, 2);
    return (items || []).map((item) => ({
        text: item.text,
        sourceRefs: normalizeSourceRefs(item.sourceRefs, fallbackRefs, evidence).slice(0, 4)
    }));
}

function normalizeSourceRefs(refs, fallbackRefs = [], evidenceItems = []) {
    // Change Briefs share the same hard citation boundary as story components:
    // model-provided paths must exist in the collected evidence, and line ranges
    // are clamped to the evidence slice. Fallback refs are trusted candidates
    // derived from that same evidence and keep older/model-light drafts useful.
    //
    const holder = {sourceRefs: [...(refs || []), ...(fallbackRefs || [])]};
    reconcileComponentSourceRefs(holder, evidenceItems);
    return holder.sourceRefs.slice(0, 6);
}

function buildSystemPrompt() {
    return [
        'You create source-grounded implementation briefs for AI coding agents.',
        'Use only the source paths and evidence provided by the user message.',
        'Do not invent files, APIs, tests, schemas, or implementation details.',
        'When evidence is incomplete, put the uncertainty in openQuestions or riskNotes.',
        'Write for a product manager handing work to an engineer or coding agent: concise, concrete, and implementation-aware.',
        'likelyFiles must cite only provided paths and must explain why each file matters.'
    ].join(' ');
}

function buildUserPrompt({savedTrace, featureTrace, changeIntent, evidence}) {
    const lines = [];
    lines.push('## Requested change');
    lines.push(changeIntent);
    lines.push('');
    lines.push('## Completed trace');
    lines.push(`Trace id: ${savedTrace.traceId}`);
    lines.push(`Original question: ${savedTrace.question || ''}`);
    lines.push(`Title: ${savedTrace.trace?.title || featureTrace?.summary || ''}`);
    if(savedTrace.trace?.narrative?.length) {
        lines.push('Narrative:');
        for(const item of savedTrace.trace.narrative.slice(0, 8)) {
            lines.push(`- ${item}`);
        }
    }
    if(featureTrace?.changeRisks?.length) {
        lines.push('Existing source-backed risks:');
        for(const risk of featureTrace.changeRisks.slice(0, 6)) {
            lines.push(`- ${risk}`);
        }
    }
    if(featureTrace?.openQuestions?.length) {
        lines.push('Open questions from trace:');
        for(const question of featureTrace.openQuestions.slice(0, 6)) {
            lines.push(`- ${question}`);
        }
    }
    lines.push('');
    lines.push('## Source evidence available for the brief');
    let chars = 0;
    for(const item of evidence) {
        const ref = item.lineStart && item.lineEnd ? `${item.path}:${item.lineStart}-${item.lineEnd}` : item.path;
        const block = [
            `### ${ref}`,
            `role: ${roleForPath(item.path)}`,
            `confidence: ${item.confidence}`,
            `reason: ${item.reason}`,
            item.content ? `excerpt:\n${item.content}` : ''
        ].filter(Boolean).join('\n');
        if(chars + block.length > MAX_MODEL_EVIDENCE_CHARS) {
            break;
        }
        chars += block.length;
        lines.push(block);
        lines.push('');
    }
    lines.push('Create the ChangeBriefDraft JSON. Keep it source-grounded and practical.');
    return lines.join('\n');
}

function sourceRefFor(item) {
    if(!item?.path) {
        return null;
    }
    return {
        path: item.path,
        lineStart: numberOrNull(item.lineStart),
        lineEnd: numberOrNull(item.lineEnd)
    };
}

function confidenceFromNumber(value) {
    const n = Number(value);
    if(!Number.isFinite(n)) {
        return 'medium';
    }
    if(n >= 0.75) {
        return 'high';
    }
    if(n >= 0.45) {
        return 'medium';
    }
    return 'low';
}

function strongerConfidence(a, b) {
    const rank = {low: 1, medium: 2, high: 3};
    return (rank[b] || 0) > (rank[a] || 0) ? b : a;
}

function reconcileRole(modelRole, candidateRole) {
    if(!modelRole || modelRole === 'source') {
        return candidateRole || 'source';
    }
    return modelRole;
}

function roleForPath(path) {
    const p = String(path || '').toLowerCase();
    if(/(^|\/)(test|tests|spec|__tests__)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) return 'test';
    if(/public\/|client|frontend|\bui\b|view|component|template|page|app\.js/.test(p)) return 'ui';
    if(/package\.json|vite\.config|tsconfig|config|\.env|lock|manifest/.test(p)) return 'config';
    if(/store|database|\bdb\b|model|repository|schema|migration|cache/.test(p)) return 'data';
    if(/(^|\/)tools?\//.test(p) || /script|cli|build|lint/.test(p)) return 'tooling';
    if(/route|api|handler|controller|endpoint|middleware|(^|\/)server\.[cm]?[jt]s$/.test(p)) return 'route';
    if(/service|domain|usecase|worker|\bjob\b|lib\/|core\/|runtime|manager|generator|planner|indexer|retrieval/.test(p)) return 'service';
    return 'source';
}

function dedupeEvidence(evidence) {
    const seen = new Set();
    const out = [];
    for(const item of evidence) {
        const key = `${item.path}:${item.lineStart || ''}-${item.lineEnd || ''}:${item.reason}`;
        if(seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(item);
    }
    return out;
}

function stripLinePrefixes(content) {
    return String(content || '')
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*\d+\s+[|│]\s?/, '').replace(/^\s*\d+\s{2,}/, ''))
        .join('\n')
        .trim();
}

function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function normalizeRevision(value) {
    const text = String(value || '').trim();
    return text || null;
}

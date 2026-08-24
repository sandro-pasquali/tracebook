import {analyzeSourceLines} from '../../util/source-syntax.js';
import {isInteractiveMarkupValue} from '../../language-integrations/html/annotation.js';
import {MAX_CALLOUTS, MIN_CALLOUTS} from './limits.js';
import {isNonTeachingValue, isWeakNote} from './weak-notes.js';
import {
    annotationRoleForLine,
    calloutTargetScore,
    codeStoryForExcerpt,
    languageAnnotationForLine,
    teachingAnchorScore,
    COMMON_SOURCE_TOKENS
} from './scoring.js';

// Picking and writing the callouts attached to a rendered excerpt: ranking
// candidate lines, deduping by line and by semantic key, and generating
// fallback note text.
//

export async function defaultCalloutsForExcerpt(lines, context = {}) {
    context.story ||= codeStoryForExcerpt(lines, context);
    const analysis = await analyzeSourceLines(lines, context);
    return planCallouts({callouts: [], lines, analysis, context});
}

function rankedCalloutTargets(lines, analysis, {includeWeak = false, context = {}} = {}) {
    return lines
        .map((line, index) => ({
            line: index + 1,
            text: line,
            score: calloutTargetScore(line, analysis, index, context)
        }))
        .filter((candidate) => isSubstantiveAt(analysis, candidate.line - 1) && (includeWeak ? candidate.score > 0 : candidate.score >= 30))
        .sort((a, b) => b.score - a.score || a.line - b.line);
}

export function isSubstantiveAt(analysis, index) {
    return !!analysis?.lines?.[index]?.substantive;
}

export function planCallouts({callouts = [], lines = [], analysis = null, context = {}, preferProvided = false} = {}) {
    if(!Array.isArray(lines) || lines.length === 0) {
        return [];
    }
    const candidates = [];
    for(const callout of callouts) {
        const targetLine = preferProvided ? Number(callout.line) : nearestCalloutTargetLine(lines, callout.line, analysis, context);
        if(!targetLine) {
            continue;
        }
        addCalloutCandidate(candidates, {
            line: targetLine,
            source: lines[targetLine - 1],
            note: chooseCalloutNote({
                provided: normalizedCalloutNote(callout.note),
                generated: fallbackNoteForSourceLine(lines, targetLine, analysis, context),
                source: lines[targetLine - 1],
                preferProvided
            }),
            origin: 'provided',
            lines,
            analysis,
            context
        });
    }

    for(const target of rankedCalloutTargets(lines, analysis, {includeWeak: true, context})) {
        addCalloutCandidate(candidates, {
            line: target.line,
            source: target.text,
            note: fallbackNoteForSourceLine(lines, target.line, analysis, context),
            origin: 'generated',
            lines,
            analysis,
            context
        });
    }

    return selectCallouts(candidates, callouts.length, lines);
}

function addCalloutCandidate(candidates, input) {
    const line = Number(input.line);
    const note = normalizedCalloutNote(input.note);
    if(!Number.isFinite(line) || line < 1 || line > input.lines.length || !note || isWeakCalloutNote(note)) {
        return;
    }
    const source = String(input.source || '');
    candidates.push({
        line,
        note,
        source,
        context: input.context,
        origin: input.origin,
        score: calloutTargetScore(source, input.analysis, line - 1, input.context) +
            calloutNoteScore(note, source) +
            (input.origin === 'provided' ? 8 : 0)
    });
}

// Score at or above which a generated candidate counts as a real teaching
// anchor rather than an incidental line, and how many callouts an excerpt aims
// for when the model expressed no count of its own.
//
const STRONG_CANDIDATE_SCORE = 12;
const DEFAULT_TARGET_CALLOUTS = 3;

function selectCallouts(candidates, requestedCount, lines) {
    const lineCount = Array.isArray(lines) ? lines.length : 0;
    const byLine = new Map();
    for(const candidate of candidates) {
        const previous = byLine.get(candidate.line);
        if(!previous || candidate.score > previous.score) {
            byLine.set(candidate.line, candidate);
        }
    }

    const byNote = new Map();
    for(const candidate of byLine.values()) {
        const key = calloutSemanticKey(candidate, candidate.context);
        const previous = byNote.get(key);
        if(!previous || candidate.score > previous.score) {
            byNote.set(key, candidate);
        }
    }

    const unique = [...byNote.values()].sort((a, b) => b.score - a.score || a.line - b.line);
    if(unique.length === 0) {
        return fallbackCallouts();
    }
    // The strong candidates (model-provided, or scoring as real teaching
    // anchors) bound how many notes ship: a model request can narrow the
    // selection but never drag low-signal tails in to satisfy a count, and with
    // no request the strong set is the target, capped at the default aim so
    // incidental-but-scoring lines don't crowd an excerpt the model never asked
    // to annotate that densely. MIN_CALLOUTS is a floor of 1 — selection never
    // pads toward a quota; running short means the excerpt ships with fewer,
    // better notes. Every candidate here already passed the weak-note filter,
    // so the top of the score order is safe to take as-is.
    //
    const strongCount = unique.filter((candidate) => candidate.origin === 'provided' || candidate.score >= STRONG_CANDIDATE_SCORE).length;
    const requested = Number(requestedCount) || 0;
    const desired = requested > 0
        ? Math.min(requested, Math.max(strongCount, MIN_CALLOUTS))
        : Math.min(strongCount, DEFAULT_TARGET_CALLOUTS);
    const targetCount = Math.min(
        MAX_CALLOUTS,
        unique.length,
        Math.max(Math.min(MIN_CALLOUTS, lineCount), desired)
    );

    return unique
        .slice(0, targetCount)
        .sort((a, b) => a.line - b.line)
        .map(({line, note}) => ({line, note}));
}

// No candidates means no callouts. The excerpt still carries its summary and
// caption; a filler note that restates "this is evidence" teaches nothing and
// erodes trust in the notes that do.
//
function fallbackCallouts() {
    return [];
}

export function annotationCandidates({lines, analysis, context, existingCallouts}) {
    const byLine = new Map();
    const addCandidate = (lineNumber, scoreBoost = 0) => {
        if(!lineNumber || lineNumber < 1 || lineNumber > lines.length) {
            return;
        }
        const line = lines[lineNumber - 1];
        const code = String(line || '').trim();
        const annotation = languageAnnotationForLine({lines, lineNumber, analysis, context});
        if(!code || !isAnnotationWorthyLine(code, context, annotation)) {
            return;
        }
        const score = calloutTargetScore(line, analysis, lineNumber - 1, context) +
            teachingAnchorScore({lines, lineNumber, context}) +
            scoreBoost;
        const previous = byLine.get(lineNumber);
        if(!previous || score > previous.score) {
            byLine.set(lineNumber, {line: lineNumber, code, score});
        }
    };

    for(let index = 0; index < lines.length; index++) {
        if(isSubstantiveAt(analysis, index)) {
            addCandidate(index + 1);
        }
    }
    for(const callout of existingCallouts || []) {
        addCandidate(nearestCalloutTargetLine(lines, callout.line, analysis, context), 18);
    }

    return [...byLine.values()]
        .filter((candidate) => candidate.code)
        .sort((a, b) => b.score - a.score || a.line - b.line)
        .slice(0, Math.min(16, Math.max(MAX_CALLOUTS, lines.length)))
        .sort((a, b) => a.line - b.line)
        .map((candidate) => ({
            line: candidate.line,
            code: candidate.code.slice(0, 260),
            role: annotationRoleForLine(lines, candidate.line, context, analysis),
            facts: annotationFactsForLine(lines, candidate.line, analysis, context)
        }));
}

function annotationFactsForLine(lines, lineNumber, analysis, context) {
    return languageAnnotationForLine({lines, lineNumber, analysis, context}).facts.slice(0, 8);
}

function isAnnotationWorthyLine(trimmed, context = {}, annotation = null) {
    if(!trimmed || /^[{}()[\],;]+$/.test(trimmed)) {
        return false;
    }
    return (annotation || languageAnnotationForLine({
        lines: [trimmed],
        lineNumber: 1,
        analysis: null,
        context
    })).worthy !== false;
}

function chooseCalloutNote({provided, generated, source, preferProvided = false}) {
    const cleanGenerated = normalizedCalloutNote(generated);
    const cleanProvided = normalizedCalloutNote(provided);
    if(!cleanProvided || isWeakCalloutNote(cleanProvided)) {
        return cleanGenerated;
    }
    if(!cleanGenerated || isWeakCalloutNote(cleanGenerated)) {
        return cleanProvided;
    }
    if(preferProvided) {
        return cleanProvided;
    }
    const generatedScore = calloutNoteScore(cleanGenerated, source);
    const providedScore = calloutNoteScore(cleanProvided, source);
    return generatedScore > providedScore + 10 ? cleanGenerated : cleanProvided;
}

function nearestCalloutTargetLine(lines, lineNumber, analysis, context = {}) {
    const start = Math.max(0, Math.min(lines.length - 1, Number(lineNumber) - 1));
    const currentScore = calloutTargetScore(lines[start], analysis, start, context);
    if(isSubstantiveAt(analysis, start) && currentScore >= 30) {
        return start + 1;
    }
    const active = nearestLineMatching(lines, start, (line, index) =>
        isSubstantiveAt(analysis, index) && calloutTargetScore(line, analysis, index, context) >= 30
    );
    if(active) {
        return active;
    }
    return nearestSubstantiveLine(lines, lineNumber, analysis);
}

function nearestSubstantiveLine(lines, lineNumber, analysis) {
    if(!Array.isArray(lines) || lines.length === 0) {
        return null;
    }
    const start = Math.max(0, Math.min(lines.length - 1, Number(lineNumber) - 1));
    return nearestLineMatching(lines, start, (line, index) => isSubstantiveAt(analysis, index));
}

function nearestLineMatching(lines, start, predicate) {
    for(let radius = 0; radius < lines.length; radius++) {
        const below = start + radius;
        if(below < lines.length && predicate(lines[below], below)) {
            return below + 1;
        }
        const above = start - radius;
        if(radius > 0 && above >= 0 && predicate(lines[above], above)) {
            return above + 1;
        }
    }
    return null;
}

function normalizedCalloutNote(note) {
    return String(note || '').replace(/\s+/g, ' ').trim();
}

function isWeakCalloutNote(note) {
    return isWeakNote(normalizedCalloutNote(note));
}

function noteDedupeKey(note) {
    return normalizedCalloutNote(note).toLowerCase().replace(/[`'"]/g, '').replace(/\s+/g, ' ');
}

function calloutSemanticKey(candidate, context = {}) {
    const source = String(candidate?.source || '').trim();
    const integrationKey = languageAnnotationForLine({
        lines: [source],
        lineNumber: 1,
        analysis: null,
        context
    }).semanticKey;
    if(integrationKey) {
        return integrationKey;
    }
    return noteDedupeKey(candidate?.note);
}

function calloutNoteScore(note, line) {
    const text = normalizedCalloutNote(note);
    const source = String(line || '');
    let score = Math.min(20, text.length / 8);
    if(!text) return 0;
    if(isWeakCalloutNote(text)) score -= 40;
    for(const token of sourceTokens(source)) {
        if(text.toLowerCase().includes(token.toLowerCase())) {
            score += 8;
        }
    }
    if(/\b(imports?|creates?|sets?|reads?|writes?|returns?|registers?|appends?|parses?|executes?|stores?|filters?|maps?|validates?|guards?|opens?|connects?|loads?|renders?|indexes?|embeds?|queries?)\b/i.test(text)) {
        score += 8;
    }
    return score;
}

function sourceTokens(line) {
    const out = [];
    const text = String(line || '');
    for(const match of text.matchAll(/[A-Za-z_$][\w$]*|['"`]([^'"`]+)['"`]/g)) {
        const token = match[1] || match[0];
        if(token.length >= 3 && !COMMON_SOURCE_TOKENS.has(token.toLowerCase())) {
            out.push(token);
        }
    }
    return out.slice(0, 12);
}

function fallbackNoteForSourceLine(lines, lineNumber, analysis, context = {}) {
    const annotation = languageAnnotationForLine({lines, lineNumber, analysis, context});
    if(annotation.note) {
        return annotation.note;
    }
    const fact = annotation.facts[0];
    if(fact) {
        const note = noteForAnnotationFact(fact, context);
        if(note) {
            return note;
        }
    }
    // No teaching note exists for this line. Returning '' drops the candidate;
    // a "Keeps X visible…" filler is weak-note filtered anyway, so generating
    // it would only waste a selection slot.
    //
    return '';
}

function contextLabel(context = {}) {
    const text = [context.caption, context.intent]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    if(/\b(ui|dom|browser|screen|view|render|rendering)\b/.test(text)) return 'UI';
    if(/\b(style|css|appearance|layout|visual)\b/.test(text)) return 'rendering';
    if(/\b(route|api|request|response|stream)\b/.test(text)) return 'request';
    if(/\b(index|embedding|search|retrieval|vector)\b/.test(text)) return 'retrieval';
    if(/\b(error|exception|rejection|fallback)\b/.test(text)) return 'error-handling';
    return 'component';
}

// Only facts that genuinely teach something get a note; everything else returns
// '' so the candidate is dropped rather than shipped as filler. Restating
// structure ("runs inside X", "uses .add()") explains nothing a reader can act
// on — when no teaching note exists, fewer callouts is the correct outcome.
//
function noteForAnnotationFact(fact, context = {}) {
    const text = String(fact || '');
    const [, kind = '', value = ''] = text.match(/^([^:]+):\s*(.*)$/) || [];
    if(kind === 'inside' && value && !isNonTeachingValue(value)) {
        if(/\bonabort|\babort|cancel|disconnect|timeout/i.test(value)) {
            return `Runs inside ${value}, the cancellation boundary for this ${contextLabel(context)} flow.`;
        }
        return '';
    }
    if(kind === 'imports' && value) {
        return `Imports ${value}, which supplies functionality used by this excerpt.`;
    }
    if(kind === 'route' && value) {
        return `Handles ${value} — the HTTP entrypoint through which clients reach this code.`;
    }
    if(kind === 'markup' && value) {
        if(!isInteractiveMarkupValue(value)) {
            return '';
        }
        return `Creates the ${value} element the user interacts with in the rendered UI.`;
    }
    if(kind === 'style selector' && value) {
        return `Targets ${value} so the related UI region can be styled.`;
    }
    if(kind === 'style property' && value) {
        return `Sets ${value}, contributing to the rendered layout or appearance.`;
    }
    return '';
}


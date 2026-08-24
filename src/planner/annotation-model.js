import {generateObject} from 'ai';
import {EOL} from 'node:os';
import {z} from 'zod';
import {config} from '../util/config.js';
import {childLogger} from '../util/logger.js';
import {resolveModel} from '../util/model.js';
import {settleGovernorCall} from './usage.js';
import {isWeakNote} from './grounding/weak-notes.js';

const log = childLogger({module: 'annotation-model'});
// These shape what the prompt ASKS the model for (aim: 3-5 notes); the enforced
// floor lives in grounding/limits.js and is 1 — selection never pads to reach
// these numbers.
//
const MAX_CALLOUTS = 5;
const MIN_CALLOUTS = 3;

const annotationSchema = z.object({
    summary: z.string().min(12).max(320).describe('One sentence explaining the behavior this excerpt demonstrates as a whole.'),
    callouts: z.array(z.object({
        line: z.number().int().min(1),
        note: z.string().min(8).max(280)
    })).min(1).max(MAX_CALLOUTS)
});

export const excerptSelectionSchema = z.object({
    rangeIndex: z.number().int().min(0)
});

export async function chooseAnnotationExcerptRange({
    lines,
    context,
    ranges,
    signal,
    timer,
    channel,
    componentId,
    governor,
    selector
}) {
    if(signal?.aborted || !Array.isArray(lines) || !Array.isArray(ranges) || ranges.length === 0) {
        return {range: null, usage: null};
    }

    if(typeof selector === 'function') {
        const selected = await selector({lines, context, ranges});
        const range = sanitizeSelectedRange(selected, ranges);
        return {range, usage: null};
    }

    const span = timer?.span(`component.${componentId}.excerpt_selection`, {
        ranges: ranges.length
    });
    const reservation = governor ? await governor.beforeCall(Math.min(config.annotations.maxTokens, 500)) : null;
    try {
        const result = await generateObject({
            model: resolveModel(config.models.annotation),
            schema: excerptSelectionSchema,
            schemaName: 'CodeExcerptSelection',
            schemaDescription: 'Select the best contiguous code range for explaining the requested behavior.',
            system: buildExcerptSelectionSystemPrompt(),
            prompt: buildExcerptSelectionPrompt({lines, context, ranges}),
            maxOutputTokens: Math.min(config.annotations.maxTokens, 500),
            temperature: 0.1,
            abortSignal: signal
        });
        const range = sanitizeSelectedRange(result.object, ranges);
        emitAnnotationTiming({span, channel, ok: !!range, callouts: 0});
        settleGovernorCall(governor, reservation, result.usage);
        return {range, usage: result.usage || null};
    } catch(err) {
        governor?.releaseCall?.(reservation);
        log.debug({
            err,
            componentId,
            path: context?.path || ''
        }, 'excerpt selection model failed; using deterministic range');
        emitAnnotationTiming({span, channel, ok: false, callouts: 0});
        return {range: null, usage: null};
    }
}

export async function writeAnnotationCallouts({
    lines,
    context,
    candidates,
    signal,
    timer,
    channel,
    componentId,
    governor,
    writer
}) {
    if(signal?.aborted || !Array.isArray(candidates) || candidates.length === 0) {
        return {summary: '', callouts: [], usage: null};
    }

    const span = timer?.span(`component.${componentId}.annotations`, {
        candidates: candidates.length
    });
    const allowedLines = new Set(candidates.map((candidate) => candidate.line));
    if(typeof writer === 'function') {
        const output = await writer({lines, context, candidates});
        const callouts = sanitizeModelCallouts(output?.callouts || [], allowedLines);
        emitAnnotationTiming({span, channel, ok: callouts.length > 0, callouts: callouts.length});
        return {
            summary: sanitizeSummary(output?.summary),
            callouts,
            usage: null
        };
    }

    const reservation = governor ? await governor.beforeCall(config.annotations.maxTokens) : null;
    try {
        const result = await generateObject({
            model: resolveModel(config.models.annotation),
            schema: annotationSchema,
            schemaName: 'CodeAnnotationCallouts',
            schemaDescription: 'Line-level explanatory annotations for a displayed code excerpt.',
            system: buildAnnotationSystemPrompt(),
            prompt: buildAnnotationPrompt({lines, context, candidates}),
            maxOutputTokens: config.annotations.maxTokens,
            temperature: 0.2,
            abortSignal: signal
        });
        const callouts = sanitizeModelCallouts(result.object?.callouts || [], allowedLines);
        emitAnnotationTiming({span, channel, ok: true, callouts: callouts.length});
        settleGovernorCall(governor, reservation, result.usage);
        return {
            summary: sanitizeSummary(result.object?.summary),
            callouts,
            usage: result.usage || null
        };
    } catch(err) {
        governor?.releaseCall?.(reservation);
        log.debug({
            err,
            componentId,
            path: context?.path || ''
        }, 'annotation model failed; using deterministic callouts');
        emitAnnotationTiming({span, channel, ok: false, callouts: 0});
        return {summary: '', callouts: [], usage: null};
    }
}

function emitAnnotationTiming({span, channel, ok, callouts}) {
    const mark = span?.end({ok, callouts});
    if(!mark || !channel) {
        return;
    }
    channel.push({
        type: 'timing.checkpoint',
        name: mark.name,
        sinceStart: mark.sinceStart,
        sinceLast: mark.sinceLast,
        durationMs: mark.durationMs,
        ok: mark.ok,
        callouts: mark.callouts,
        candidates: mark.candidates
    });
}

function buildAnnotationSystemPrompt() {
    return [
        'You write concise literate-programming annotations for a displayed source excerpt.',
        'The reader is trying to understand machine-written code well enough to keep asking for changes.',
        'First identify the excerpt-level behavior: the entrypoint, data flow, control flow, side effects, and boundaries.',
        'Then attach annotations only to the candidate lines that best teach that behavior.',
        'Use only the provided code, excerpt story, and candidate facts.',
        'Prefer data flow, control flow, lifecycle boundaries, user-visible effects, failure handling, or integration points.',
        'Avoid single-line paraphrases such as "calls X", "stores Y", "defines a function", "checks a condition", or "returns the result".',
        'Do not start notes with "Highlights".',
        'Each note may be one or two compact sentences that connect the line to the surrounding behavior.',
        'The summary must describe the whole excerpt, not a single line.'
    ].join(EOL);
}

function buildExcerptSelectionSystemPrompt() {
    return [
        'You select the source span that will best teach a reader how code behaves.',
        'The reader wants to understand machine-written code well enough to ask for useful changes.',
        'Choose a contiguous range that shows the load-bearing behavior, not incidental setup, logging, scaffolding, or nearby code that only sounds related.',
        'Prefer spans with entrypoints, control flow, data flow, side effects, integration boundaries, lifecycle boundaries, and user-visible effects.',
        'Use only the provided code and candidate ranges. Return the rangeIndex only.'
    ].join(EOL);
}

function buildAnnotationPrompt({lines, context, candidates}) {
    return [
        `Question: ${context.question || ''}`,
        `Component intent: ${context.intent || ''}`,
        `Path: ${context.path || ''}`,
        `Language: ${context.language || ''}`,
        `Caption: ${context.caption || ''}`,
        '',
        'Excerpt story:',
        context.story || summarizeExcerptStory(lines, context),
        '',
        'The candidate lines were preselected by source analysis as likely structural anchors. You still choose only the ones that teach the reader the behavior.',
        '',
        'Excerpt with 1-based line numbers:',
        lineNumberedCode(lines),
        '',
        'Candidate annotation points:',
        JSON.stringify(candidates, null, 2),
        '',
        `Choose ${Math.min(MIN_CALLOUTS, candidates.length)}-${Math.min(MAX_CALLOUTS, candidates.length)} candidate lines that best explain the excerpt as a system walkthrough.`,
        'Also write summary: one sentence that describes what this excerpt does as a whole.',
        'Write notes that describe concrete behavior, data flow, side effects, lifecycle boundaries, or integration points with enough context to teach the idea.',
        'A good note answers "why does this line matter in this flow?" rather than "what does this line literally call?"',
        'Do not quote long code. Do not mention that a line is a candidate.'
    ].join(EOL);
}

function buildExcerptSelectionPrompt({lines, context, ranges}) {
    return [
        `Question: ${context.question || ''}`,
        `Component intent: ${context.intent || ''}`,
        `Path: ${context.path || ''}`,
        `Language: ${context.language || ''}`,
        `Caption: ${context.caption || ''}`,
        '',
        'Source with 1-based line numbers:',
        lineNumberedCode(lines),
        '',
        'Candidate ranges:',
        JSON.stringify(ranges.map((range, index) => ({
            rangeIndex: index,
            lineStart: range.lineStart,
            lineEnd: range.lineEnd,
            reason: range.reason || '',
            score: Number.isFinite(range.score) ? Number(range.score.toFixed(2)) : undefined
        })), null, 2),
        '',
        'Pick the range that best explains the requested behavior in this source file.'
    ].join(EOL);
}

function summarizeExcerptStory(lines, context = {}) {
    const text = `${context.question || ''}\n${context.intent || ''}\n${context.caption || ''}\n${lines.join('\n')}`.toLowerCase();
    const themes = [];
    if(/\b(stream|streaming|emit|publish|send|write|event)\b/.test(text)) {
        themes.push('This excerpt sends incremental updates instead of waiting for one final result.');
    }
    if(/\babort\b|cancel|disconnect|timeout/.test(text)) {
        themes.push('Cancellation is part of the lifecycle, so abandoned work can stop.');
    }
    if(/\basync iterator\b|\basync iterable\b|\byield\b/.test(text)) {
        themes.push('Async values are consumed as they are produced.');
    }
    if(/\bcache|cached|memo|replay|prior|history\b/.test(text)) {
        themes.push('Cached or prior state can be reused instead of recomputing the same work.');
    }
    if(/\bsave|persist|insert|update|upsert|write|record\b/.test(text)) {
        themes.push('Completed work is recorded so later steps can reuse or inspect it.');
    }
    return themes.length > 0
        ? themes.join(' ')
        : 'Read the excerpt as a small behavior: identify the entrypoint, the state it carries, the branch decisions, and the side effects.';
}

function lineNumberedCode(lines) {
    return lines.map((line, index) => `${index + 1}: ${line}`).join(EOL);
}

function sanitizeModelCallouts(callouts, allowedLines) {
    const out = [];
    const seenLines = new Set();
    const seenNotes = new Set();
    for(const callout of callouts || []) {
        const line = Number(callout?.line);
        const note = normalizeNote(callout?.note).slice(0, 280);
        const noteKey = note.toLowerCase().replace(/[`'"]/g, '').replace(/\s+/g, ' ');
        if(!Number.isFinite(line) || !allowedLines.has(line) || !note || isWeakNote(note)) {
            continue;
        }
        if(seenLines.has(line) || seenNotes.has(noteKey)) {
            continue;
        }
        seenLines.add(line);
        seenNotes.add(noteKey);
        out.push({line, note});
        if(out.length >= MAX_CALLOUTS) {
            break;
        }
    }
    return out;
}

function sanitizeSummary(summary) {
    const text = normalizeNote(summary).slice(0, 320);
    if(!text || isWeakNote(text)) {
        return '';
    }
    return text;
}

function sanitizeSelectedRange(value, ranges) {
    if(ranges.includes(value)) {
        return value;
    }
    const index = Number(value?.rangeIndex);
    if(!Number.isInteger(index) || index < 0 || index >= ranges.length) {
        return null;
    }
    return ranges[index];
}

function normalizeNote(note) {
    return String(note || '').replace(/\s+/g, ' ').trim();
}


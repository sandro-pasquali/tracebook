import {analyzeSourceLines} from '../util/source-syntax.js';
import {writeAnnotationCallouts} from './annotation-model.js';
import {MAX_CODE_LINES, TRUNCATION_WINDOW} from './grounding/limits.js';
import {codeStoryForExcerpt, isCleanStop} from './grounding/scoring.js';
import {
    desiredExcerptLineCount,
    selectPreferredExcerptRange,
    shouldKeepMatchingComponentCode,
    shouldUseRequestedRange
} from './grounding/excerpt-range.js';
import {annotationCandidates, defaultCalloutsForExcerpt, planCallouts} from './grounding/callouts.js';

// Hard-enforce annotated-code limits on validated components. The schema and
// prompt both ask for these, but the model regularly overshoots (50-line code
// blocks, 10+ callouts). Better to trim here than ship a wall of code.
//
// Truncation tries to:
//   1. land on a "clean stop" line (ends with `}`, `;`, `)`, or is blank)
//   2. preserve every callout that survived the hard ceiling — never cut
//      before the last callout's line, because that would orphan the
//      explanation.
//

export async function enforceGroundedAnnotatedCode(component, planItem, evidenceItems, context = {}) {
    if(planItem.kind !== 'annotated_code_excerpt' || typeof component.code !== 'string') {
        return;
    }
    const evidence = findEvidenceForComponent(component, evidenceItems);
    if(!evidence) {
        return;
    }

    const evidenceLines = strippedEvidenceLines(evidence);
    if(evidenceLines.length === 0) {
        return;
    }
    const evidenceText = normalizeForGrounding(evidenceLines.join('\n'));
    const strippedComponentCode = stripLineNumberGutter(component.code).stripped;
    const componentLines = strippedComponentCode.split(/\r?\n/).filter((line) => !line.endsWith('…'));
    const componentText = normalizeForGrounding(componentLines.join('\n'));
    const ref = firstMatchingRef(component, evidence.path);
    const evidenceStart = Number(evidence.lineStart) || 1;
    const evidenceEnd = Number(evidence.lineEnd) || (evidenceStart + evidenceLines.length - 1);
    const requestedStart = Number(ref?.lineStart) || evidenceStart;
    const requestedEnd = Number(ref?.lineEnd) || Math.min(evidenceEnd, requestedStart + 19);
    const requestedLineCount = requestedEnd >= requestedStart ? requestedEnd - requestedStart + 1 : 20;
    const hasRequestedRange = Number.isFinite(Number(ref?.lineStart)) && Number.isFinite(Number(ref?.lineEnd));
    const requestedFits = hasRequestedRange && requestedStart >= evidenceStart && requestedEnd <= evidenceEnd && requestedLineCount <= MAX_CODE_LINES;
    const matchOffset = findLineSequence(evidenceLines, componentLines);
    const calloutContext = componentContext(component, evidence.path, {
        question: context.question,
        intent: planItem.intent,
        signal: context.signal,
        timer: context.timer,
        channel: context.channel,
        governor: context.governor,
        excerptSelector: context.excerptSelector,
        annotationWriter: context.annotationWriter,
        componentId: planItem.id
    });
    calloutContext.story = codeStoryForExcerpt(evidenceLines, calloutContext);
    if(componentText && evidenceText.includes(componentText) && shouldKeepMatchingComponentCode({
        requestedLineCount,
        componentLines,
        context: calloutContext
    })) {
        if(matchOffset !== null) {
            const actualStart = evidenceStart + matchOffset;
            component.sourceRefs = [{
                path: evidence.path,
                lineStart: actualStart,
                lineEnd: actualStart + componentLines.length - 1
            }];
        }
        return;
    }

    const preferredRange = await selectPreferredExcerptRange({
        evidenceLines,
        evidenceStart,
        requestedStart,
        requestedEnd,
        requestedLineCount,
        targetedRanges: targetedReadRanges(evidenceItems, evidence),
        context: calloutContext
    });

    if(preferredRange) {
        await applyEvidenceSlice(component, evidence, evidenceLines, preferredRange.lineStart, preferredRange.lineEnd, calloutContext);
        return;
    }

    if(requestedFits && shouldUseRequestedRange({
        requestedStart,
        requestedEnd,
        requestedLineCount,
        evidenceStart,
        evidenceLineCount: evidenceLines.length,
        matchOffset,
        componentLines,
        context: calloutContext
    })) {
        await applyEvidenceSlice(component, evidence, evidenceLines, requestedStart, requestedEnd, calloutContext);
        return;
    }

    const offset = Math.max(0, Math.min(evidenceLines.length - 1, requestedStart - evidenceStart));
    const targetLineCount = desiredExcerptLineCount(calloutContext, requestedLineCount);
    const slice = evidenceLines.slice(offset, Math.min(evidenceLines.length, offset + targetLineCount));
    if(slice.length === 0) {
        return;
    }

    const actualStart = evidenceStart + offset;
    const actualEnd = actualStart + slice.length - 1;
    await applyEvidenceSlice(component, evidence, evidenceLines, actualStart, actualEnd, calloutContext);
}

async function applyEvidenceSlice(component, evidence, evidenceLines, lineStart, lineEnd, context) {
    const evidenceStart = Number(evidence.lineStart) || 1;
    const offset = Math.max(0, lineStart - evidenceStart);
    const count = Math.max(1, lineEnd - lineStart + 1);
    const slice = evidenceLines.slice(offset, Math.min(evidenceLines.length, offset + count));
    if(slice.length === 0) {
        return;
    }
    const actualStart = evidenceStart + offset;
    const actualEnd = actualStart + slice.length - 1;
    component.code = slice.join('\n');
    component.sourceRefs = [{
        path: evidence.path,
        lineStart: actualStart,
        lineEnd: actualEnd
    }];
    component.callouts = await defaultCalloutsForExcerpt(slice, context);
    component.reason = component.reason || 'The excerpt is taken directly from retrieved source evidence.';
}

// A narrow read_file is the exploration model having already answered "where
// is it" — it chose those lines deliberately. When such a range sits inside
// the broader evidence backing a component, surface it as an explicit excerpt
// candidate so the surrounding bulk does not bury it.
//
const TARGETED_READ_MAX_LINES = 40;

function targetedReadRanges(evidenceItems, evidence) {
    const evidenceStart = Number(evidence?.lineStart) || 1;
    const evidenceEnd = Number(evidence?.lineEnd) || evidenceStart;
    const out = [];
    for(const item of evidenceItems || []) {
        if(item === evidence || item?.tool !== 'read_file' || item?.path !== evidence?.path) {
            continue;
        }
        const lineStart = Number(item.lineStart) || 0;
        const lineEnd = Number(item.lineEnd) || 0;
        if(!lineStart || !lineEnd || lineEnd < lineStart || lineEnd - lineStart + 1 > TARGETED_READ_MAX_LINES) {
            continue;
        }
        if(lineStart < evidenceStart || lineEnd > evidenceEnd) {
            continue;
        }
        out.push({lineStart, lineEnd});
    }
    return out;
}

function findLineSequence(haystackLines, needleLines) {
    const needle = needleLines.map(normalizeLineForMatch);
    if(needle.length === 0 || needle.every((line) => line.trim() === '') || needle.length > haystackLines.length) {
        return null;
    }
    const haystack = haystackLines.map(normalizeLineForMatch);
    for(let i = 0; i <= haystack.length - needle.length; i++) {
        let matched = true;
        for(let j = 0; j < needle.length; j++) {
            if(haystack[i + j] !== needle[j]) {
                matched = false;
                break;
            }
        }
        if(matched) {
            return i;
        }
    }
    return null;
}

function normalizeLineForMatch(line) {
    return String(line || '').replace(/[ \t]+$/g, '');
}

function findEvidenceForComponent(component, evidenceItems = []) {
    if(!Array.isArray(evidenceItems) || evidenceItems.length === 0) {
        return null;
    }
    const refs = Array.isArray(component.sourceRefs) ? component.sourceRefs : [];
    for(const ref of refs) {
        const matches = evidenceItems.filter((item) =>
            item?.path === ref?.path &&
            rangesOverlap(
                Number(item.lineStart) || 1,
                Number(item.lineEnd) || Number.MAX_SAFE_INTEGER,
                Number(ref.lineStart) || 1,
                Number(ref.lineEnd) || Number.MAX_SAFE_INTEGER
            )
        );
        if(matches.length > 0) {
            return matches.sort(compareEvidenceCoverage)[0];
        }
    }
    for(const ref of refs) {
        const match = evidenceItems.find((item) => item?.path === ref?.path);
        if(match) {
            return match;
        }
    }
    return evidenceItems[0] || null;
}

function compareEvidenceCoverage(a, b) {
    const aSpan = evidenceSpan(a);
    const bSpan = evidenceSpan(b);
    const aRead = a?.tool === 'read_file' ? 1 : 0;
    const bRead = b?.tool === 'read_file' ? 1 : 0;
    return bRead - aRead || bSpan - aSpan || Number(a?.truncated) - Number(b?.truncated);
}

function evidenceSpan(item) {
    const start = Number(item?.lineStart) || 1;
    const end = Number(item?.lineEnd) || start;
    return Math.max(1, end - start + 1);
}

function firstMatchingRef(component, path) {
    const refs = Array.isArray(component.sourceRefs) ? component.sourceRefs : [];
    return refs.find((ref) => ref?.path === path) || refs[0] || null;
}

function strippedEvidenceLines(evidence) {
    const stripped = stripLineNumberGutter(String(evidence?.content || '')).stripped;
    return stripped.split(/\r?\n/).filter((line) => !line.endsWith('…'));
}

function normalizeForGrounding(code) {
    return String(code || '')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .trim();
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart <= bEnd && bStart <= aEnd;
}

function componentContext(component, fallbackPath = '', extras = {}) {
    const refs = Array.isArray(component?.sourceRefs) ? component.sourceRefs : [];
    return {
        language: component?.language || '',
        path: refs[0]?.path || fallbackPath || '',
        caption: component?.caption || '',
        question: extras.question || '',
        intent: extras.intent || '',
        signal: extras.signal,
        timer: extras.timer,
        channel: extras.channel,
        governor: extras.governor,
        excerptSelector: extras.excerptSelector,
        annotationWriter: extras.annotationWriter,
        componentId: extras.componentId
    };
}

export async function enforceHouseLimits(component, planItem, context = {}) {
    if(planItem.kind !== 'annotated_code_excerpt') {
        return null;
    }
    if(typeof component.code !== 'string') {
        return null;
    }

    // Tool evidence is line-numbered. Rendered excerpts use plain source, so
    // absolute file-line callouts are mapped into excerpt-relative positions.
    //
    const {stripped, firstLineNumber} = stripLineNumberGutter(component.code);
    component.code = trimTrailingBlankLines(stripped);
    let callouts = Array.isArray(component.callouts) ? component.callouts.slice() : [];
    const sourceRefStart = firstSourceRefLine(component, 'lineStart');
    const sourceRefEnd = firstSourceRefLine(component, 'lineEnd');
    const absoluteStart = firstLineNumber ?? sourceRefStart;
    const absoluteEnd = firstLineNumber !== null
        ? firstLineNumber + component.code.split(/\r?\n/).length - 1
        : sourceRefEnd;
    if(absoluteStart !== null) {
        callouts = callouts.map((c) => {
            if(!c || !Number.isFinite(c.line)) {
                return c;
            }
            if(c.line >= absoluteStart && (absoluteEnd === null || c.line <= absoluteEnd)) {
                return {...c, line: c.line - absoluteStart + 1};
            }
            return c;
        });
    }

    const lines = component.code.split(/\r?\n/);
    const calloutContext = componentContext(component, '', {
        question: context.question,
        intent: planItem.intent
    });
    calloutContext.story = codeStoryForExcerpt(lines, calloutContext);
    const analysis = await analyzeSourceLines(lines, calloutContext);

    callouts = callouts.filter(
        (c) => c && Number.isFinite(c.line) && c.line >= 1 && c.line <= Math.min(lines.length, MAX_CODE_LINES)
    );
    callouts = planCallouts({callouts, lines, analysis, context: calloutContext});

    let finalLines = lines;
    let finalAnalysis = analysis;
    if(lines.length > MAX_CODE_LINES) {
        const cutIndex = chooseCutIndex(lines, MAX_CODE_LINES, TRUNCATION_WINDOW, callouts);
        finalLines = lines.slice(0, cutIndex);
        component.code = finalLines.join('\n');
        finalAnalysis = sliceAnalysis(analysis, cutIndex);
        calloutContext.story = codeStoryForExcerpt(finalLines, calloutContext);
        callouts = callouts.filter((c) => c.line <= cutIndex);
        callouts = planCallouts({
            callouts,
            lines: finalLines,
            analysis: finalAnalysis,
            context: calloutContext
        });
    }

    const annotationResult = await writeAnnotationCallouts({
        lines: finalLines,
        context: calloutContext,
        candidates: annotationCandidates({
            lines: finalLines,
            analysis: finalAnalysis,
            context: calloutContext,
            existingCallouts: callouts
        }),
        signal: context.signal,
        timer: context.timer,
        channel: context.channel,
        componentId: planItem.id,
        governor: context.governor,
        writer: context.annotationWriter
    });
    if(annotationResult.callouts.length > 0) {
        callouts = planCallouts({
            callouts: annotationResult.callouts,
            lines: finalLines,
            analysis: finalAnalysis,
            context: calloutContext,
            preferProvided: true
        });
    }
    if(annotationResult.summary) {
        component.reason = annotationResult.summary;
    }

    alignDisplayedSourceRef(component, absoluteStart);
    component.callouts = callouts;
    return annotationResult.usage;
}

function firstSourceRefLine(component, key) {
    const refs = Array.isArray(component?.sourceRefs) ? component.sourceRefs : [];
    const value = Number(refs[0]?.[key]);
    return Number.isFinite(value) ? value : null;
}

function alignDisplayedSourceRef(component, absoluteStart) {
    if(absoluteStart === null || absoluteStart === undefined || !Array.isArray(component?.sourceRefs) || component.sourceRefs.length === 0) {
        return;
    }
    const lineCount = String(component.code || '').split(/\r?\n/).length;
    component.sourceRefs = [{
        ...component.sourceRefs[0],
        lineStart: absoluteStart,
        lineEnd: absoluteStart + Math.max(1, lineCount) - 1
    }];
}

function trimTrailingBlankLines(code) {
    return String(code || '').replace(/(?:\r?\n[ \t]*)+$/g, '');
}

function sliceAnalysis(analysis, lineCount) {
    if(!analysis || !Array.isArray(analysis.lines)) {
        return analysis;
    }
    return {
        ...analysis,
        lines: analysis.lines.slice(0, lineCount)
    };
}

// Detect and strip a line-number gutter from a `code` field. Tool outputs from
// read_file and search_codebase format each line as `${N}  ${source}` with
// 2+ spaces between the number and the source. If a strong majority of
// non-blank lines match that shape, strip the prefix and return the first
// file line number we saw; otherwise return the input unchanged.
//
function stripLineNumberGutter(code) {
    const lines = code.split(/\r?\n/);
    const GUTTER = /^(\s*\d+)( {2})(.*)$/;
    const sample = [];
    for(const line of lines) {
        if(line.trim() !== '') {
            sample.push(line);
        }
        if(sample.length >= 5) {
            break;
        }
    }
    if(sample.length === 0) {
        return {stripped: code, firstLineNumber: null};
    }
    let matched = 0;
    let firstLineNumber = null;
    for(const line of sample) {
        const m = GUTTER.exec(line);
        if(m) {
            matched++;
            if(firstLineNumber === null) {
                firstLineNumber = Number(m[1]);
            }
        }
    }
    if(matched / sample.length < 0.8) {
        return {stripped: code, firstLineNumber: null};
    }
    const strippedLines = lines.map((line) => {
        const m = GUTTER.exec(line);
        return m ? m[3] : line;
    });
    return {stripped: strippedLines.join('\n'), firstLineNumber};
}

// Pick a cut index at or before `target` that lands on a clean stop. The cut
// tries to keep surviving callouts, but never exceeds the hard excerpt limit.
//
function chooseCutIndex(lines, target, window, callouts) {
    const total = lines.length;
    const hardLimit = Math.min(total, target);
    const maxCalloutLine = callouts.length
        ? Math.min(hardLimit, Math.max(0, ...callouts.map((c) => c.line)))
        : 0;
    const earliest = Math.max(1, target - window, maxCalloutLine);
    const latest = hardLimit;
    if(earliest > latest) {
        return latest;
    }
    let best = -1;
    for(let i = earliest; i <= latest; i++) {
        if(isCleanStop(lines[i - 1] || '')) {
            best = i;
        }
    }
    return best > 0 ? best : latest;
}

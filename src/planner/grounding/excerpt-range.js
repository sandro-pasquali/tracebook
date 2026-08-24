import {analyzeSourceLines} from '../../util/source-syntax.js';
import {resolveLanguageIntegration} from '../../language-integrations/registry.js';
import {chooseAnnotationExcerptRange} from '../annotation-model.js';
import {MAX_CODE_LINES} from './limits.js';
import {
    behavioralAnchorScore,
    conceptAnchorScore,
    languageAnchorScore,
    scoreExcerptWindow,
    teachingAnchorScore,
    CALLOUT_TERM_STOPWORDS
} from './scoring.js';

// Choosing which slice of evidence to display: candidate-range generation,
// window scoring, symbol-boundary resolution, and the model-assisted pick.
//

export async function selectPreferredExcerptRange({
    evidenceLines,
    evidenceStart,
    requestedStart,
    requestedEnd,
    requestedLineCount,
    targetedRanges = [],
    context
}) {
    if(!shouldPreferBehavioralRange(context) || !Array.isArray(evidenceLines) || evidenceLines.length === 0) {
        return null;
    }
    const targetLineCount = desiredExcerptLineCount(context, requestedLineCount);
    const minimumLineCount = minimumExcerptLineCount(context, evidenceLines.length);
    const requestedOffset = Math.max(0, Math.min(evidenceLines.length - 1, requestedStart - evidenceStart));
    const analysis = await analyzeSourceLines(evidenceLines, context);
    const foundSymbolRange = symbolBoundsForContext(evidenceLines, context, analysis);
    // A context word such as "request" can resolve to a local variable rather
    // than the load-bearing function. Treat a symbol as useful bounds only
    // when the symbol itself can carry the minimum explanatory span.
    //
    const symbolRange = excerptRangeLineCount(foundSymbolRange) >= minimumCompleteSymbolLineCount(evidenceLines.length)
        ? foundSymbolRange
        : null;
    const requestedSymbolRange = enclosingSymbolBounds(analysis, requestedOffset, minimumLineCount, targetLineCount);
    if(evidenceLines.length <= targetLineCount) {
        const preferredSymbol = symbolRange || requestedSymbolRange;
        if(preferredSymbol && preferredSymbol.end - preferredSymbol.start < evidenceLines.length) {
            return {
                lineStart: evidenceStart + preferredSymbol.start,
                lineEnd: evidenceStart + preferredSymbol.end - 1
            };
        }
        return null;
    }

    const requestedLength = Math.max(1, Math.min(targetLineCount, requestedEnd - requestedStart + 1));
    const candidateRanges = candidateExcerptRanges({
        lines: evidenceLines,
        analysis,
        context,
        targetLineCount,
        minimumLineCount,
        requestedOffset,
        requestedLength,
        symbolRange,
        requestedSymbolRange,
        targetedOffsets: targetedRanges.map((range) => ({
            start: range.lineStart - evidenceStart,
            end: range.lineEnd - evidenceStart + 1
        }))
    });
    const modelChoice = await chooseAnnotationExcerptRange({
        lines: evidenceLines,
        context,
        ranges: candidateRanges,
        signal: context.signal,
        timer: context.timer,
        channel: context.channel,
        componentId: context.componentId,
        governor: context.governor,
        selector: context.excerptSelector
    });
    // Range selection is advisory. A model may prefer a real but incidental
    // line because it repeats the wording of the intent (for example,
    // `const request = {}` for request validation). Do not let that choice
    // bypass the same minimum teaching span enforced by the deterministic
    // fallback below.
    //
    if(modelChoice.range && excerptRangeLineCount(modelChoice.range) >= minimumLineCount) {
        return {
            lineStart: evidenceStart + modelChoice.range.start,
            lineEnd: evidenceStart + modelChoice.range.end - 1
        };
    }
    if(symbolRange && symbolRange.end - symbolRange.start <= targetLineCount) {
        return {
            lineStart: evidenceStart + symbolRange.start,
            lineEnd: evidenceStart + symbolRange.end - 1
        };
    }
    if(requestedSymbolRange) {
        return {
            lineStart: evidenceStart + requestedSymbolRange.start,
            lineEnd: evidenceStart + requestedSymbolRange.end - 1
        };
    }
    const current = scoreExcerptWindow(evidenceLines, analysis, requestedOffset, requestedLength, context);
    const best = bestExcerptWindow(evidenceLines, analysis, targetLineCount, context, symbolRange);
    const tinyBehavioralRequest = shouldPreferBehavioralRange(context) && requestedLength < 4;
    const minimumAnchorScore = tinyBehavioralRequest ? 30 : 45;
    if(!best || best.anchorScore < minimumAnchorScore || best.start === requestedOffset) {
        return null;
    }
    if(current.anchorScore >= 45 && best.score < current.score + 45) {
        return null;
    }
    if(current.anchorScore < 45 && best.score < current.score + 20) {
        return null;
    }

    return {
        lineStart: evidenceStart + best.start,
        lineEnd: evidenceStart + best.end - 1
    };
}

function candidateExcerptRanges({lines, analysis, context, targetLineCount, minimumLineCount, requestedOffset, requestedLength, symbolRange, requestedSymbolRange, targetedOffsets = []}) {
    const out = [];
    const add = (start, end, reason, score = 0) => {
        const boundedStart = Math.max(0, Math.min(lines.length - 1, Number(start) || 0));
        const boundedEnd = Math.max(boundedStart + 1, Math.min(lines.length, Number(end) || boundedStart + 1));
        if(boundedEnd - boundedStart < minimumLineCount) {
            return;
        }
        const key = `${boundedStart}:${boundedEnd}`;
        if(out.some((range) => `${range.start}:${range.end}` === key)) {
            return;
        }
        out.push({
            start: boundedStart,
            end: boundedEnd,
            lineStart: boundedStart + 1,
            lineEnd: boundedEnd,
            reason,
            score
        });
    };

    add(requestedOffset, Math.min(lines.length, requestedOffset + requestedLength), 'range requested by the component plan', 0);
    if(symbolRange) {
        add(symbolRange.start, symbolRange.end, 'complete symbol named by the component intent', 0);
    }
    if(requestedSymbolRange) {
        add(requestedSymbolRange.start, requestedSymbolRange.end, 'complete enclosing symbol around the requested source line', 60);
    }
    for(const targeted of targetedOffsets) {
        add(targeted.start, targeted.end, 'range the exploration model read directly while answering this question', 50);
    }

    const lower = Math.max(0, Number(symbolRange?.start) || 0);
    const upper = Math.min(lines.length, Number(symbolRange?.end) || lines.length);
    const available = Math.max(0, upper - lower);
    const length = Math.max(1, Math.min(targetLineCount, available || lines.length));
    const anchorCentered = lines
        .map((line, index) => ({
            index,
            score: teachingAnchorScore({lines, lineNumber: index + 1, context}) +
                conceptAnchorScore(String(line || '').trim(), context) +
                behavioralAnchorScore(line) +
                languageAnchorScore(line, context)
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index);
    for(const anchor of anchorCentered.slice(0, 10)) {
        const start = Math.max(lower, Math.min(Math.max(lower, upper - length), anchor.index - Math.floor(length / 2)));
        const end = Math.min(upper, start + length);
        if(out.some((existing) => rangeOverlapRatio(existing, {start, end}) > 0.6)) {
            continue;
        }
        add(start, end, 'window centered on a high-value behavioral anchor', anchor.score);
    }

    const scored = [];
    for(let start = lower; start <= upper - length; start++) {
        scored.push(scoreExcerptWindow(lines, analysis, start, length, context));
    }
    scored
        .sort((a, b) => b.score - a.score || b.anchorScore - a.anchorScore || a.start - b.start)
        .forEach((range) => {
            if(out.length >= 8) {
                return;
            }
            if(out.some((existing) => rangeOverlapRatio(existing, range) > 0.6)) {
                return;
            }
            add(range.start, range.end, 'high-scoring behavioral source window', range.score);
        });

    return out.slice(0, 8);
}

function rangeOverlapRatio(a, b) {
    const start = Math.max(Number(a.start) || 0, Number(b.start) || 0);
    const end = Math.min(Number(a.end) || 0, Number(b.end) || 0);
    const overlap = Math.max(0, end - start);
    const larger = Math.max(1, Math.max((Number(a.end) || 0) - (Number(a.start) || 0), (Number(b.end) || 0) - (Number(b.start) || 0)));
    return overlap / larger;
}

export function desiredExcerptLineCount(context = {}, requestedLineCount = 20) {
    const text = [context.question, context.intent, context.caption].filter(Boolean).join(' ').toLowerCase();
    if(/\b(much more code|more code|more source|more files|code displayed|flow|callback|handler|watcher|listener|route|stream|streaming|decode|decoding|yield|reader)\b/.test(text)) {
        return MAX_CODE_LINES;
    }
    return Math.max(10, Math.min(MAX_CODE_LINES, requestedLineCount < 10 ? 20 : requestedLineCount));
}

function shouldPreferBehavioralRange(context = {}) {
    const text = [context.question, context.intent, context.caption].filter(Boolean).join(' ').toLowerCase();
    return /\b(flow|when|fires?|happens?|watch(?:er|ing)?|sync|synchroni[sz]e|event|listener|handler|callback|route|request|response|change|add|unlink|remove|index|reindex|behavior|process|pipeline|lifecycle|how)\b/.test(text);
}

function bestExcerptWindow(lines, analysis, targetLineCount, context, bounds = null) {
    const lower = Math.max(0, Number(bounds?.start) || 0);
    const upper = Math.min(lines.length, Number(bounds?.end) || lines.length);
    const available = Math.max(0, upper - lower);
    if(available === 0) {
        return null;
    }
    const length = Math.max(1, Math.min(targetLineCount, available));
    let best = null;
    for(let start = lower; start <= upper - length; start++) {
        const scored = scoreExcerptWindow(lines, analysis, start, length, context);
        if(!best || scored.score > best.score || (scored.score === best.score && scored.anchorScore > best.anchorScore)) {
            best = scored;
        }
    }
    return best;
}

function symbolBoundsForContext(lines, context = {}, analysis = null) {
    const terms = contextIdentifierTerms(context);
    if(terms.size === 0) {
        return null;
    }
    const syntaxRange = symbolBoundsFromSyntax(analysis, terms);
    if(syntaxRange) {
        return syntaxRange;
    }
    return resolveLanguageIntegration(context)?.findSymbolRange({lines, terms, context}) || null;
}

function symbolBoundsFromSyntax(analysis, terms) {
    const symbols = Array.isArray(analysis?.symbols) ? analysis.symbols : [];
    for(const symbol of symbols) {
        const name = String(symbol?.name || '').toLowerCase();
        if(!name || !terms.has(name)) {
            continue;
        }
        const start = Number(symbol.lineStart) - 1;
        const end = Number(symbol.lineEnd);
        if(Number.isFinite(start) && Number.isFinite(end) && end > start) {
            return {start, end};
        }
    }
    return null;
}

function enclosingSymbolBounds(analysis, offset, minimumLineCount, targetLineCount) {
    const lineNumber = Number(offset) + 1;
    const candidates = (Array.isArray(analysis?.symbols) ? analysis.symbols : [])
        .map((symbol) => ({
            start: Number(symbol?.lineStart) - 1,
            end: Number(symbol?.lineEnd),
            kind: String(symbol?.kind || '')
        }))
        .filter((range) =>
            Number.isFinite(range.start) &&
            Number.isFinite(range.end) &&
            range.start < lineNumber &&
            range.end >= lineNumber &&
            range.end - range.start >= minimumLineCount &&
            range.end - range.start <= targetLineCount
        )
        // Prefer a function/method/class boundary over a same-sized lexical
        // declaration, then choose the smallest complete enclosing unit.
        .sort((a, b) =>
            enclosingSymbolKindRank(b.kind) - enclosingSymbolKindRank(a.kind) ||
            (a.end - a.start) - (b.end - b.start)
        );
    return candidates[0] ? {start: candidates[0].start, end: candidates[0].end} : null;
}

function enclosingSymbolKindRank(kind) {
    return /function|method|class|route|handler/i.test(kind) ? 1 : 0;
}

function contextIdentifierTerms(context = {}) {
    const text = [context.question, context.intent, context.caption].filter(Boolean).join(' ');
    const terms = new Set();
    for(const match of text.matchAll(/\b[A-Za-z_$][\w$]{2,}\b/g)) {
        const value = match[0];
        const lower = value.toLowerCase();
        if(CALLOUT_TERM_STOPWORDS.has(lower) || ['function', 'method', 'class', 'code', 'excerpt', 'show', 'display'].includes(lower)) {
            continue;
        }
        if(/[A-Z_$]/.test(value) || /\b(index|remove|watch|create|render|handle|load|save|sync|search|embed|chunk|route|file)\b/i.test(value)) {
            terms.add(lower);
        }
    }
    return terms;
}

// Below this span an excerpt teaches nothing on its own (a lone
// `const url = new URL(...)` line with a callout is noise); tiny ranges fall
// through to the window machinery, which expands toward
// desiredExcerptLineCount around the requested anchor.
//
const MIN_EXCERPT_LINES = 4;
const MIN_BEHAVIORAL_EXCERPT_LINES = 8;

function minimumExcerptLineCount(context = {}, availableLineCount = Number.MAX_SAFE_INTEGER) {
    const requestedMinimum = shouldPreferBehavioralRange(context)
        ? MIN_BEHAVIORAL_EXCERPT_LINES
        : MIN_EXCERPT_LINES;
    const available = Math.max(1, Number(availableLineCount) || requestedMinimum);
    return Math.min(requestedMinimum, available);
}

function minimumCompleteSymbolLineCount(availableLineCount) {
    const available = Math.max(1, Number(availableLineCount) || MIN_EXCERPT_LINES);
    return Math.min(MIN_EXCERPT_LINES, available);
}

function excerptRangeLineCount(range) {
    return Math.max(0, (Number(range?.end) || 0) - (Number(range?.start) || 0));
}

export function shouldUseRequestedRange({requestedStart, requestedEnd, requestedLineCount, evidenceStart, evidenceLineCount, matchOffset, componentLines, context = {}}) {
    if(Number(requestedLineCount) < minimumExcerptLineCount(context, evidenceLineCount)) {
        return false;
    }
    if(matchOffset === null || componentLines.length === 0) {
        return true;
    }
    const actualStart = evidenceStart + matchOffset;
    const actualEnd = actualStart + componentLines.length - 1;
    return requestedStart <= actualStart && requestedEnd >= actualEnd;
}

export function shouldKeepMatchingComponentCode({requestedLineCount, componentLines = [], context = {}}) {
    const minimumLineCount = minimumExcerptLineCount(context);
    if(Number(requestedLineCount) >= minimumLineCount && componentLines.length >= minimumLineCount) {
        return true;
    }
    if(shouldPreferBehavioralRange(context)) {
        return false;
    }
    return excerptBehaviorAnchorScore(componentLines, context) >= 30;
}

function excerptBehaviorAnchorScore(lines, context = {}) {
    return (Array.isArray(lines) ? lines : [])
        .map((line) => String(line || '').trim())
        .reduce((score, line) => score + behavioralAnchorScore(line) + conceptAnchorScore(line, context) + languageAnchorScore(line, context), 0);
}

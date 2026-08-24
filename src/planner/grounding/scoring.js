import {resolveLanguageIntegration} from '../../language-integrations/registry.js';

// Shared scoring + per-line annotation primitives for annotated-code grounding.
// This is the leaf layer: excerpt-range selection and callout selection both
// build on it, and it depends only on the language-integration registry.
//

export function scoreExcerptWindow(lines, analysis, start, length, context) {
    const end = Math.min(lines.length, start + length);
    const scores = [];
    let anchorScore = 0;
    for(let index = start; index < end; index++) {
        const line = lines[index];
        const anchor = behavioralAnchorScore(line) + languageAnchorScore(line, context);
        const teaching = teachingAnchorScore({lines, lineNumber: index + 1, context});
        anchorScore = Math.max(anchorScore, anchor + teaching);
        scores.push(Math.max(0, calloutTargetScore(line, analysis, index, context)) + anchor + teaching * 2);
    }
    const topScores = scores.sort((a, b) => b - a).slice(0, 8);
    const score = topScores.reduce((sum, value) => sum + value, 0) + anchorScore + cleanBoundaryScore(lines, start, end);
    return {start, end, score, anchorScore};
}

export function behavioralAnchorScore(line) {
    const trimmed = String(line || '').trim();
    if(!trimmed) {
        return 0;
    }
    let score = 0;
    if(/\b(await|return|throw|yield)\b/.test(trimmed)) score += 30;
    if(/\b(stream|send|emit|publish|subscribe|listen|event)\w*\s*\(/i.test(trimmed)) score += 35;
    if(/\b(abort|cancel|timeout|disconnect|close)\b/i.test(trimmed)) score += 40;
    if(/\.\s*on\s*\(/.test(trimmed)) score += 45;
    if(/\.(upsert|insert|delete|add|write|save|query|watch|close|emit|send|read|open|connect)\s*\(/.test(trimmed)) score += 35;
    if(/\b(onEvent|callback|handler|listener)\b/.test(trimmed)) score += 25;
    if(/\b(if|try|catch|switch|case)\b/.test(trimmed)) score += 8;
    if(/^(?:import\b|\/\/|\/\*|\*)/.test(trimmed)) score -= 25;
    return score;
}

function cleanBoundaryScore(lines, start, end) {
    let score = 0;
    if(start === 0 || String(lines[start - 1] || '').trim() === '' || /[{;}]\s*$/.test(String(lines[start - 1] || '').trim())) {
        score += 4;
    }
    if(end >= lines.length || isCleanStop(lines[end - 1] || '')) {
        score += 8;
    }
    return score;
}

export function languageAnchorScore(line, context = {}) {
    return resolveLanguageIntegration(context)?.anchorScore({
        line,
        trimmed: String(line || '').trim(),
        context
    }) || 0;
}

export function calloutTargetScore(line, analysis, index, context = {}) {
    const trimmed = String(line || '').trim();
    if(!trimmed) return 0;
    const annotation = languageAnnotationForLine({
        lines: [line],
        lineNumber: 1,
        analysis: sliceAnalysisLine(analysis, index),
        context
    });
    let score = 1;
    score += annotation.score;
    const types = analysis?.lines?.[index]?.nodeTypes || [];
    if(types.some((type) => /call_expression|return_statement|await_expression|assignment_expression|variable_declarator/.test(type))) score += 15;
    if(types.some((type) => /statement_block|object|pair/.test(type)) && /^[A-Za-z_$][\w$]*\s*:/.test(trimmed)) score -= 15;
    score += conceptAnchorScore(trimmed, context);
    score += questionRelevanceScore(line, context);
    return score;
}

function sliceAnalysisLine(analysis, index) {
    if(!analysis || !Array.isArray(analysis.lines)) {
        return analysis;
    }
    return {
        ...analysis,
        lines: [analysis.lines[index] || null]
    };
}

export function languageAnnotationForLine({lines, lineNumber, analysis, context = {}}) {
    const integration = resolveLanguageIntegration(context);
    if(!integration) {
        return {
            role: '',
            facts: [],
            note: '',
            score: 0,
            worthy: false,
            semanticKey: ''
        };
    }
    return integration.annotateLine({
        line: lines[lineNumber - 1],
        lines,
        lineNumber,
        analysis,
        context
    });
}

export function teachingAnchorScore({lines, lineNumber, context = {}}) {
    const trimmed = String(lines[lineNumber - 1] || '').trim();
    const role = annotationRoleForLine(lines, lineNumber, context);
    const contextText = [context.question, context.intent, context.caption]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    let score = 0;
    if(role === 'entrypoint') score += 45;
    if(role === 'stream lifecycle') score += /\b(stream|streaming|event|events|client|server|response|lifecycle)\b/.test(contextText) ? 70 : 35;
    if(role === 'event bridge') score += /\b(event|events|stream|streaming|producer|consumer|async|client)\b/.test(contextText) ? 75 : 35;
    if(role === 'cancellation') score += /\b(cancel|abort|disconnect|client|lifecycle|stream)\b/.test(contextText) ? 65 : 25;
    if(role === 'persistence') score += /\b(save|persist|history|memory|replay)\b/.test(contextText) ? 54 : 10;
    if(role === 'validation') score += /\b(valid|invalid|payload|json|body|input|error|failure|bad request)\b/.test(contextText) ? 44 : 5;
    if(role === 'error boundary') score += /\b(error|failure|fallback|exception|catch|invalid)\b/.test(contextText) ? 38 : 6;
    if(role === 'incidental logging') score -= 80;
    if(role === 'definition boundary') score += 25;
    if(role === 'call boundary') score += 25;
    if(role === 'iteration') score += /\b(iterate|loop|stream|sequence|each|event)\b/.test(contextText) ? 42 : 12;
    if(role === 'branch') score += /\b(branch|condition|case|choose|if|when|error)\b/.test(contextText) ? 35 : 8;
    if(role === 'output boundary') score += 22;
    if(/\bfor await\b/.test(trimmed)) score += 35;
    if(/\b(stream|send|emit|publish|subscribe|listen|event)\w*\s*\(/i.test(trimmed)) score += 30;
    return score;
}

export function annotationRoleForLine(lines, lineNumber, context = {}, analysis = null) {
    return languageAnnotationForLine({lines, lineNumber, analysis, context}).role || 'supporting statement';
}

export function conceptAnchorScore(trimmed, context = {}) {
    const text = [context.question, context.intent, context.caption]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    const line = String(trimmed || '');
    let score = 0;

    if(/\b(stream|send|emit|publish|subscribe|listen|event)\w*\s*\(/i.test(line)) {
        score += /\b(sse|stream|streaming|abort|cancel|disconnect|client)\b/.test(text) ? 80 : 45;
    }
    if(/\babort\b|\.abort\s*\(|\bcancel\b|\.cancel\s*\(/i.test(line)) {
        score += /\b(abort|cancel|disconnect|client|timeout)\b/.test(text) ? 70 : 30;
    }
    if(/\b(cache|memo|replay|prior|history)\w*|\.(get|set|has)\s*\(/i.test(line)) {
        score += /\b(cache|replay|memory|prior|similar)\b/.test(text) ? 55 : 10;
    }
    if(/\b(save|persist|insert|update|upsert|write|record)\w*\s*\(/i.test(line)) {
        score += /\b(save|persist|history|memory|replay|write)\b/.test(text) ? 58 : 24;
    }
    if(/\.(push|append|add)\s*\(/i.test(line)) {
        score += /\b(collect|cache|save|persist|event|stream|list|array)\b/.test(text) ? 40 : 12;
    }
    if(/\b(req|request|body|json|response|status)\b/i.test(line)) {
        score += /\b(request|response|json|api|route|error|invalid)\b/.test(text) ? 55 : 24;
    }
    if(annotationRoleForLine([line], 1, context) === 'incidental logging') {
        score += /\b(log|logging|diagnostic|debug|error|invalid|failure|warn)\b/.test(text) ? 22 : -70;
    }
    return score;
}

function questionRelevanceScore(line, context = {}) {
    const haystack = String(line || '').toLowerCase();
    let score = 0;
    let words = null;
    for(const term of relevanceTerms(context)) {
        if(haystack.includes(term)) {
            score += term.length > 5 ? 8 : 5;
            continue;
        }
        // Whole-word prefix bridging: code abbreviates what questions spell
        // out ("/admin" vs "administration"), so a line word (>= 4 chars) that
        // is a proper prefix of the term also counts.
        //
        if(term.length >= 6) {
            words ||= haystack.match(/[a-z][a-z0-9]{3,}/g) || [];
            if(words.some((word) => word.length < term.length && term.startsWith(word))) {
                score += 5;
            }
        }
    }
    return Math.min(score, 24);
}

function relevanceTerms(context = {}) {
    const text = [
        context.question,
        context.intent,
        context.caption,
        context.path
    ].filter(Boolean).join(' ');
    const raw = text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .match(/[A-Za-z_$][\w$-]{2,}/g) || [];
    const out = [];
    const seen = new Set();
    for(const value of raw) {
        const token = value.toLowerCase().replace(/^[-_]+|[-_]+$/g, '');
        if(token.length < 3 || CALLOUT_TERM_STOPWORDS.has(token) || seen.has(token)) {
            continue;
        }
        seen.add(token);
        out.push(token);
        if(out.length >= 32) {
            break;
        }
    }
    return out;
}

export function codeStoryForExcerpt(lines, context = {}) {
    const integrationStory = resolveLanguageIntegration(context)?.storyForExcerpt({lines, context});
    if(integrationStory) {
        return integrationStory;
    }
    const text = [
        context.question,
        context.intent,
        context.caption,
        ...(Array.isArray(lines) ? lines : [])
    ].filter(Boolean).join('\n').toLowerCase();
    const story = [];
    if(/\bstream|streaming|emit|send|publish|event\b/.test(text)) {
        story.push('The excerpt sends incremental data or events instead of waiting for one final result.');
    }
    if(/\babort\b|cancel|disconnect|timeout/.test(text)) {
        story.push('Cancellation is wired into the flow so abandoned work can stop.');
    }
    if(/\b(async|await|yield)\b/.test(text)) {
        story.push('Async iteration consumes produced values as they arrive.');
    }
    if(/\bcache|memo|replay|prior|history\b/.test(text)) {
        story.push('Cached or prior state can be reused instead of recomputing everything.');
    }
    if(/\bsave|persist|insert|update|upsert|write|record\b/.test(text)) {
        story.push('The flow records durable state after the important work completes.');
    }
    if(/\brequest|response|status|invalid\b/.test(text)) {
        story.push('Request validation happens before downstream work begins.');
    }
    return story.join(' ');
}

// A "clean stop" is a line we'd be happy to end an excerpt on: blank, or
// ending with a statement terminator, close-brace, close-paren, or HTML tag.
// Lines that end with `{`, `(`, `,`, `&&`, `=>` etc. are mid-expression.
//
export function isCleanStop(line) {
    const trimmed = line.trim();
    if(trimmed === '') {
        return true;
    }
    return /[};)>]$/.test(trimmed);
}

export const COMMON_SOURCE_TOKENS = new Set([
    'const', 'let', 'var', 'this', 'return', 'function', 'class', 'async', 'await',
    'true', 'false', 'null', 'undefined'
]);

export const CALLOUT_TERM_STOPWORDS = new Set([
    ...COMMON_SOURCE_TOKENS,
    'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'then', 'than',
    'what', 'when', 'where', 'which', 'who', 'why', 'how', 'does', 'work',
    'works', 'system', 'process', 'implementation', 'source', 'code', 'file',
    'component', 'excerpt', 'annotated', 'question'
]);

import {isSystemOverviewQuestion} from './util/retrieval-intent.js';

const INTENTS = [
    'locate_source',
    'show_code',
    'explain_behavior',
    'explain_role',
    'simulate_change',
    'verify_understanding',
    'compare',
    'plan_change'
];

const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'does',
    'for', 'from', 'how', 'i', 'in', 'into', 'is', 'it', 'me', 'of', 'on',
    'or', 'the', 'this', 'to', 'where', 'which', 'who', 'why', 'with'
]);

const DOMAIN_HINTS = [
    {
        name: 'api',
        test: /\b(apis?|endpoints?|routes?|requests?|responses?|sse|streams?|streaming|servers?)\b/i,
        terms: 'API route endpoint request response stream event handler server controller'
    },
    {
        name: 'llm',
        test: /\b(llm|llms|model|models|ai|agent|planner|prompt|prompts|tools?|tool-call|tool calls?)\b/i,
        terms: 'LLM model AI agent prompt tool call inference completion embedding reranking orchestration'
    },
    {
        name: 'memory',
        test: /\b(cache|memory|prior|similar|trace|traces|history|replay|remember)\b/i,
        terms: 'cache memory prior similar history replay persistence'
    },
    {
        name: 'data_storage',
        test: /\b(db|database|datastore|store|storage|orm|model|models|migration|schema|repository|repo|controller|dao|sql|query|queries|vector|embedding|embeddings|index|indexing|indexed|search|retrieval|chunk|chunking)\b/i,
        terms: 'database datastore storage repository controller ORM model migration schema SQL query vector embedding index indexing chunking retrieval store upsert table search'
    },
    {
        name: 'dependencies',
        test: /\b(dependencies|dependency|install|installs|package|packages|package manager|npm|pnpm|yarn|node_modules|typescript|tsconfig|python|pip|venv|virtualenv|requirements|pyproject|poetry|rust|cargo|crate|crates|configuration|config)\b/i,
        terms: 'dependencies dependency install package manager manifest package metadata repository exports types configuration lockfile registry source features'
    },
    {
        name: 'ui',
        test: /\b(ui|browser|frontend|component|components|render|screen|visual|visually|diagram|mermaid|html|css|react)\b/i,
        terms: 'frontend UI browser component renderer HTML CSS template stylesheet DOM event listener form input'
    },
    {
        name: 'source_code',
        test: /\b(code|source|html|css|javascript|typescript|jsx|tsx|markup|stylesheet|styles?|template|show me)\b/i,
        terms: 'source code language parser symbol definition call import markup stylesheet template selector DOM className'
    },
    {
        name: 'visual_explanation',
        test: /\b(visual|visually|visualize|picture|pictures|diagram|draw|map|like a child|5 year old|five year old)\b/i,
        terms: 'visual explanation mermaid_figure sequenceDiagram flowchart product story behavior flow'
    }
];

const VERB_HINTS = new Set([
    'add', 'ask', 'build', 'change', 'compare', 'connect', 'delete', 'draw',
    'explain', 'fail', 'fails', 'find', 'fit', 'fits', 'fix', 'implement',
    'load', 'modify', 'open', 'plan', 'read', 'relate', 'render', 'show',
    'simulate', 'stream', 'test', 'trace', 'verify', 'work', 'works'
]);

export function classifyIntent({question, storyContext} = {}) {
    const raw = String(question || '').trim();
    const lower = raw.toLowerCase();
    const tokens = tokenize(raw);
    const tokenSet = new Set(tokens);
    const linguistic = parseLinguisticSignals(raw);
    const domains = domainsFor(raw);
    const hasStoryContext = !!(storyContext?.chapters?.length || storyContext?.sourcePaths?.length);

    const scores = Object.fromEntries(INTENTS.map((intent) => [intent, 0]));
    const reasons = [];

    scoreLocate({lower, tokenSet, linguistic, scores, reasons});
    scoreShowCode({lower, tokenSet, linguistic, scores, reasons});
    scoreExplainBehavior({lower, tokenSet, linguistic, scores, reasons});
    scoreExplainRole({lower, tokenSet, linguistic, scores, reasons});
    scoreSimulate({lower, tokenSet, scores, reasons});
    scoreVerify({lower, tokenSet, scores, reasons});
    scoreCompare({lower, tokenSet, scores, reasons});
    scorePlanChange({lower, tokenSet, scores, reasons});

    if(hasStoryContext && isShortFollowUp(tokens)) {
        scores.explain_role += 1;
        scores.explain_behavior += 1;
        reasons.push('short contextual follow-up');
    }
    // A whole-system overview is an explain-behavior question even when its
    // phrasing carries code-ish tokens ("what happens end to end when I ask
    // about my code") that would otherwise score show_code/locate.
    //
    if(isSystemOverviewQuestion(lower)) {
        scores.explain_behavior += 5;
        reasons.push('whole-system overview phrasing');
    }
    if(isVisualRetelling(lower)) {
        scores.explain_behavior += 4;
        reasons.push('visual retelling request');
    }

    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [intent, score] = ranked[0];
    const runnerUp = ranked[1]?.[1] || 0;
    const confidence = score <= 0 ? 0.35 : Math.min(0.95, 0.45 + score * 0.08 + Math.max(0, score - runnerUp) * 0.04);
    const scope = inferScope({lower, tokenSet, linguistic, hasStoryContext});
    // Shape the answer from the RESOLVED intent, not the top-ranked one. When no
    // scorer fires (score 0) the ranked top is INTENTS[0] (locate_source), whose
    // shapes are callout-only — but the resolved intent below falls back to
    // explain_behavior. Keying shapes on `intent` instead left zero-score
    // questions (e.g. "what dependencies does the server use") answered in prose
    // only, never showing the wiring code.
    //
    const resolvedIntent = score > 0 ? intent : 'explain_behavior';
    const preferredAnswerShapes = answerShapesFor({intent: resolvedIntent, lower, tokenSet});
    const retrievalHints = retrievalHintsFor(raw);

    return {
        intent: resolvedIntent,
        scope,
        domains,
        needsContext: hasStoryContext || /\b(this|that|it|those|they|fit|fits|relate|related)\b/i.test(raw),
        isRetelling: isRetellingRequest(lower),
        allowsLean: false,
        preferredAnswerShapes,
        retrievalHints,
        terms: linguistic.terms.slice(0, 12),
        nouns: linguistic.nouns.slice(0, 8),
        verbs: linguistic.verbs.slice(0, 8),
        confidence: Number(confidence.toFixed(2)),
        reasons: reasons.slice(0, 6)
    };
}

export function formatIntentForPrompt(classification) {
    if(!classification) {
        return 'No intent classification was produced.';
    }
    return [
        '## Comprehension intent',
        `intent: ${classification.intent}`,
        `scope: ${classification.scope}`,
        classification.domains?.length ? `domains: ${classification.domains.join(', ')}` : null,
        `confidence: ${classification.confidence}`,
        `preferredAnswerShapes: ${classification.preferredAnswerShapes.join(', ')}`,
        `needsContext: ${classification.needsContext ? 'yes' : 'no'}`,
        `isRetelling: ${classification.isRetelling ? 'yes' : 'no'}`,
        classification.domains?.includes('api') ? 'answerContract: api_boundary' : null,
        classification.scope === 'system' && classification.intent === 'explain_behavior' ? 'answerContract: system_overview' : null,
        classification.reasons?.length ? `signals: ${classification.reasons.join('; ')}` : null
    ].filter(Boolean).join('\n');
}

function scoreLocate({lower, tokenSet, linguistic, scores, reasons}) {
    if(/^(which|what)\s+file\b/.test(lower) || /^where\s+(is|are)\b/.test(lower)) {
        scores.locate_source += 3;
        reasons.push('explicit source-location phrasing');
    }
    if(/\b(file|path|defined|defines|definition|located|live|lives|implemented|implementation|imported|exported)\b/.test(lower)) {
        scores.locate_source += 2;
        reasons.push('source-location terms');
    }
    if(tokenSet.has('find') || /^show me where\b/.test(lower)) {
        scores.locate_source += 2;
        reasons.push('find/show source request');
    }
    if(linguistic.nouns.some((n) => ['file', 'path', 'function', 'class', 'module', 'component'].includes(n))) {
        scores.locate_source += 1;
        reasons.push('source noun detected');
    }
    if(/\b(work|works|flow|fit|fits|role|why|how)\b/.test(lower)) {
        scores.locate_source -= 2;
    }
}

function scoreShowCode({lower, tokenSet, linguistic, scores, reasons}) {
    if(/\b(show|see|display|open|include)\b.*\b(code|source|html|css|markup|stylesheet|styles?|file|files)\b/.test(lower) ||
        /\b(show me the code|show me code|show the code)\b/.test(lower)) {
        scores.show_code += 5;
        reasons.push('explicit code-display phrasing');
    }
    if(/\b(html|css|javascript|typescript|jsx|tsx|react|markup|stylesheet|styles?)\b/.test(lower)) {
        scores.show_code += 3;
        scores.explain_behavior += 1;
        reasons.push('source language or UI framework terms');
    }
    if(/\b(index\.html|styles?\.css|\.jsx|\.tsx|\.ts|\.js|\.py|\.go|\.rs|\.java|\.php)\b/.test(lower)) {
        scores.show_code += 3;
        reasons.push('file extension detected');
    }
    if(tokenSet.has('source') || tokenSet.has('code')) {
        scores.show_code += 2;
        reasons.push('source/code token detected');
    }
    if(linguistic.nouns.some((n) => ['code', 'source', 'html', 'css', 'stylesheet', 'markup', 'component'].includes(n))) {
        scores.show_code += 1;
        reasons.push('code noun detected');
    }
    if(/\b(relationship|relate|related|connect|connected|how|why|work|works)\b/.test(lower)) {
        scores.explain_role += 2;
        scores.explain_behavior += 1;
    }
}

function scoreExplainBehavior({lower, tokenSet, linguistic, scores, reasons}) {
    if(/\b(how|work|works|walkthrough|walk through|flow|process|lifecycle|architecture|explain|trace)\b/.test(lower)) {
        scores.explain_behavior += 4;
        reasons.push('behavior explanation terms');
    }
    if(/\b(api|endpoint|route|request|response|stream|sse|auth|login|upload)\b/.test(lower)) {
        scores.explain_behavior += 2;
        reasons.push('behavior-bearing domain terms');
    }
    if(isVisualRetelling(lower)) {
        scores.explain_behavior += 3;
        reasons.push('visual explanation terms');
    }
    if(tokenSet.has('why')) {
        scores.explain_behavior += 2;
        reasons.push('asks why');
    }
    if(linguistic.verbs.some((v) => ['work', 'works', 'explain', 'walk', 'stream', 'process'].includes(v))) {
        scores.explain_behavior += 1;
        reasons.push('behavior verb detected');
    }
}

function scoreExplainRole({lower, tokenSet, linguistic, scores, reasons}) {
    if(/\b(fit|fits|role|part|relationship|relate|related|connect|connected|where.*fit|where.*come in)\b/.test(lower)) {
        scores.explain_role += 5;
        reasons.push('system-role phrasing');
    }
    if(/\b(llm|llms|model|models|planner|tools?|agent|cache|memory|index|retrieval)\b/.test(lower)) {
        scores.explain_role += 2;
        reasons.push('system-concept terms');
    }
    if(linguistic.verbs.some((v) => ['fit', 'fit in', 'relate', 'connect'].includes(v)) || tokenSet.has('role')) {
        scores.explain_role += 2;
        reasons.push('role verb detected');
    }
}

function scoreSimulate({lower, scores, reasons}) {
    if(/\b(what if|simulate|scenario|case|when .* fails|failure|fails|breaks|edge case|alternate|instead)\b/.test(lower)) {
        scores.simulate_change += 5;
        reasons.push('simulation phrasing');
    }
}

function scoreVerify({lower, scores, reasons}) {
    if(/\b(quiz|test me|verify|ready|understand|comprehension|check my understanding)\b/.test(lower)) {
        scores.verify_understanding += 5;
        reasons.push('verification phrasing');
    }
}

function scoreCompare({lower, scores, reasons}) {
    if(/\b(compare|versus|vs\.?|difference|different|same|tradeoff|better|worse)\b/.test(lower)) {
        scores.compare += 5;
        reasons.push('comparison phrasing');
    }
}

function scorePlanChange({lower, scores, reasons}) {
    if(/\b(change|modify|add|remove|build|implement|refactor|fix|ship|ask an llm|prompt)\b/.test(lower)) {
        scores.plan_change += 4;
        reasons.push('change-planning phrasing');
    }
    if(/\b(without breaking|risk|safe|impact|side effect)\b/.test(lower)) {
        scores.plan_change += 3;
        reasons.push('change-risk phrasing');
    }
}

function inferScope({lower, tokenSet, linguistic, hasStoryContext}) {
    // A whole-system overview is system scope by definition — checked first
    // because its phrasing often trips the file-scope tokens ("what happens end
    // to end when I ask about my code" is not a file question).
    //
    if(isSystemOverviewQuestion(lower)) {
        return 'system';
    }
    if(/\b(file|path|line|function|class|symbol|defined|definition|code|source|html|css|stylesheet|markup)\b/.test(lower)) {
        return 'file';
    }
    if(linguistic.nouns.some((n) => ['file', 'path', 'function', 'class', 'symbol'].includes(n))) {
        return 'file';
    }
    if(hasStoryContext || /\b(feature|behavior|flow|api|auth|user|product)\b/.test(lower)) {
        return 'feature';
    }
    if(/\b(system|architecture|service|services|llm|llms|model|models|planner|tools?|retrieval|codebase|repository|repo|whole|overall|big picture|end[- ]to[- ]end)\b/.test(lower)) {
        return 'system';
    }
    return tokenSet.size <= 4 ? 'prior_story' : 'feature';
}

function answerShapesFor({intent, lower}) {
    const visualShape = visualShapeFor(lower);
    const codeRequested = wantsCodeDisplay(lower);

    if(intent === 'locate_source') {
        return ['annotated_code_excerpt', 'evidence_callout'];
    }
    if(visualShape && codeRequested) {
        return [visualShape, 'annotated_code_excerpt', 'evidence_callout'];
    }
    if(visualShape) {
        return [visualShape, 'evidence_callout', 'annotated_code_excerpt'];
    }
    if(intent === 'show_code') {
        return ['annotated_code_excerpt', 'evidence_callout', 'mermaid_figure'];
    }
    if(intent === 'simulate_change') {
        return ['mermaid_figure', 'evidence_callout'];
    }
    if(intent === 'verify_understanding') {
        return ['evidence_callout'];
    }
    if(intent === 'compare') {
        return ['evidence_callout', 'mermaid_figure'];
    }
    if(intent === 'plan_change') {
        return ['evidence_callout', 'annotated_code_excerpt'];
    }
    if(/\b(ui|browser|frontend|screen|button|click|clicked|input|form|render|component)\b/.test(lower)) {
        return ['mermaid_figure', 'annotated_code_excerpt', 'evidence_callout'];
    }
    if(isApiDomainText(lower)) {
        return ['sequence_diagram', 'annotated_code_excerpt', 'evidence_callout'];
    }
    if(/\b(api|flow|process|stream|sse|lifecycle|relationship|fit|fits|role|visual|visualize|picture|pictures|diagram|draw|map)\b/.test(lower)) {
        return ['mermaid_figure', 'evidence_callout', 'annotated_code_excerpt'];
    }
    return ['evidence_callout', 'annotated_code_excerpt', 'mermaid_figure'];
}

function wantsCodeDisplay(lower) {
    return /\b(show|see|display|open|include|give)\b.*\b(code|source|html|css|markup|stylesheet|styles?|file|files)\b/.test(lower) ||
        /\b(show me the code|show me code|show the code|more code|much more code|code displayed)\b/.test(lower);
}

function visualShapeFor(lower) {
    if(!/\b(visual|visually|visualize|picture|pictures|diagram|draw|map|flowchart|flow|lifecycle|sequence)\b/.test(lower)) {
        return null;
    }
    if(/\b(sequence|request|response|api|endpoint|route|client|server|browser|frontend|backend|stream|streaming|sse|websocket|event)\b/.test(lower)) {
        return 'sequence_diagram';
    }
    return 'mermaid_figure';
}

function retrievalHintsFor(question) {
    return DOMAIN_HINTS
        .filter((hint) => hint.test.test(question))
        .map((hint) => hint.terms);
}

function domainsFor(question) {
    return DOMAIN_HINTS
        .filter((hint) => hint.test.test(question))
        .map((hint) => hint.name);
}

function isApiDomainText(lower) {
    return /\b(apis?|endpoints?|routes?|requests?|responses?|sse|streams?|streaming)\b/.test(lower) ||
        /\b(client|browser|frontend)\b.*\b(server|backend|handler)\b/.test(lower) ||
        /\b(server|backend|handler)\b.*\b(client|browser|frontend)\b/.test(lower);
}

function parseLinguisticSignals(text) {
    const terms = normalizeTerms(String(text || '').match(/[a-zA-Z_][a-zA-Z0-9_]{1,}/g) || []);
    const verbs = terms.filter((term) => VERB_HINTS.has(term) || /\b\w+(ing|ed)\b/.test(term));
    const nouns = terms.filter((term) => !STOPWORDS.has(term) && !VERB_HINTS.has(term));
    return {terms, nouns, verbs};
}

function normalizeTerms(items) {
    return (items || [])
        .map((item) => String(item || '').toLowerCase().replace(/[^a-z0-9_ ]+/g, '').trim())
        .filter(Boolean);
}

function tokenize(text) {
    return (String(text || '').toLowerCase().match(/[a-z_][a-z0-9_]{1,}/g) || [])
        .filter((token) => !STOPWORDS.has(token));
}

function isShortFollowUp(tokens) {
    return tokens.length > 0 && tokens.length <= 6;
}

function isVisualRetelling(lower) {
    return /\b(visual|visually|visualize|picture|pictures|diagram|draw|map)\b/.test(lower) ||
        /\b(5 year old|five year old|child|kid)\b/.test(lower);
}

function isRetellingRequest(lower) {
    return isVisualRetelling(lower) || /\b(explain it|give it|show it|make it simpler|simplify|i don't get it|dont get it)\b/.test(lower);
}

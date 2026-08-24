import {repoProfilesForQuestion} from '../language-integrations/registry.js';

// Retrieval-shape classification — which retrieval levers suit this question,
// distinct from the planner's answer-shape intents. Measured motivation
// (test/eval/baselines/*): the domain boost lifts identifier/relational queries
// but dents product-language queries on every repo and regime measured, so the
// search path applies it by shape instead of unconditionally.
//
// Shapes:
//   identifier — the question carries a code-shaped token (camelCase,
//                snake_case, SCREAMING_SNAKE, multi-hump PascalCase, dotted
//                member access, a path, or a file name). Exact-token levers
//                earn their keep here. Conventions cover the supported
//                languages, not one ecosystem: snake_case is Python/Rust/Ruby's
//                home turf as much as camelCase is JS's.
//   relational — "how do X and Y work together": two or more technologies from
//                the language-integrations registry, or one plus an explicit
//                integration verb. The wiring file is the answer; the full
//                pipeline (manifest demotion included) earns its keep.
//   product    — plain product language (the default). Strong semantic matches
//                must not be displaced by token-overlap nudges.
//
const CODE_TOKEN_PATTERNS = [
    /\b[a-z][a-z0-9]*[A-Z]\w*\b/g,
    /\b[A-Z][a-z0-9]+[A-Z]\w*\b/g,
    /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g,
    /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
    /\b\w+(?:\.\w+)+\(/g,
    /\b[\w.-]+\/[\w./-]+\b/g,
    /\b[\w-]+\.(?:[a-z]{1,4})\b/g,
    /`[^`\s]+`/g
];
const ABBREVIATION = /^(?:e\.g|i\.e|etc|vs)\.?$/i;
const INTEGRATION_VERBS = /\b(?:work(?:s|ing)? together|works? with|integrat\w*|connect\w*|wire[ds]?|wiring|talks? to|interacts? with|flow (?:from|between|through)|powered by|powers|uses? [\w-]+ to\b)/i;

export function classifyQueryShape(question) {
    const text = String(question || '');
    if(!text.trim()) {
        return 'product';
    }

    const matchedProfiles = repoProfilesForQuestion(text).filter((profile) => (profile.matchedTerms || []).length > 0);
    const techTerms = new Set(matchedProfiles.flatMap((profile) => profile.matchedTerms).map((term) => String(term).toLowerCase()));

    // A code-shaped token marks an identifier question — unless it is just a
    // technology name the registry knows ("TypeScript", "Node.js"), which is
    // product/relational vocabulary, not a symbol to look up.
    //
    const codeTokens = CODE_TOKEN_PATTERNS
        .flatMap((pattern) => text.match(pattern) || [])
        .map((token) => token.replaceAll('`', ''))
        .filter((token) => !ABBREVIATION.test(token))
        .filter((token) => !techTerms.has(token.toLowerCase()));
    if(codeTokens.length > 0) {
        return 'identifier';
    }

    // An explicit integration-verb phrase marks the question relational by
    // construction ("how do X and Y work together") even when X/Y are package
    // names the language registry cannot know. Relational is the conservative
    // bucket (full pipeline, today's behavior), so over-matching here can only
    // forgo the product-shape lift, never regress correctness.
    //
    if(matchedProfiles.length >= 2 || INTEGRATION_VERBS.test(text)) {
        return 'relational';
    }
    return 'product';
}

// Lever policy per shape. `arm` selects between the measured experiment arms;
// the default is the production policy. Returns {legs, rerank} for runSearch:
// rerank=false means the caller should not pass its reranker for this query.
//
//   production            — full pipeline for every shape (pre-experiment behavior)
//   no-domain-for-product — product shape drops the domain boost, keeps rerank
//   lexical-for-product   — product shape drops domain boost AND rerank (the
//                           cumulative ladder's product sweet spot)
//   tiebreak-for-product  — product shape keeps the domain boost but capped to
//                           an RRF tie-breaker (manifest demotion stays full)
//
const FULL = {legs: {lexical: true, graph: true, domainBoost: true}, rerank: true};

// The arm production search runs with (runSearch resolves it whenever a caller
// does not pass explicit legs). Changing this constant changes retrieval
// behavior product-wide — it is recorded in eval baseline conditions, so a flip
// forces a deliberate, condition-stamped baseline re-save.
//
// lexical-for-product shipped from the measured arms (enriched regime, both
// repos): the only arm that lifts product queries on BOTH repos — tracebook
// 0.56/0.37 -> 0.67/0.45 recall/MRR, flask MRR 0.58 -> 0.63 — with identifier
// and integration byte-identical everywhere. Domain boost AND rerank both dent
// product-language queries; neither lever is cut, they just sit out the shape
// they hurt. Tables: /tmp regenerable via --shape-arms; decision recorded in
// the baselines' conditions.queryShapeArm.
//
export const PRODUCTION_QUERY_SHAPE_ARM = 'lexical-for-product';

export function retrievalPolicyForShape(shape, {arm = 'production'} = {}) {
    if(shape !== 'product' || arm === 'production') {
        return FULL;
    }
    if(arm === 'no-domain-for-product') {
        return {legs: {lexical: true, graph: true, domainBoost: false}, rerank: true};
    }
    if(arm === 'lexical-for-product') {
        return {legs: {lexical: true, graph: true, domainBoost: false}, rerank: false};
    }
    if(arm === 'tiebreak-for-product') {
        return {legs: {lexical: true, graph: true, domainBoost: 'tiebreak'}, rerank: true};
    }
    throw new Error(`unknown query-shape arm: ${arm}`);
}

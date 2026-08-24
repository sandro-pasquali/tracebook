import {tool} from 'ai';
import {
    REPO_SUPPORT_QUERY_TERMS,
    isDependencyManifestPath,
    resolveLanguageIntegration,
    supportTermsForRepoQuestion
} from '../language-integrations/registry.js';
import {config} from '../util/config.js';
import {classifyQueryShape, PRODUCTION_QUERY_SHAPE_ARM, retrievalPolicyForShape} from '../util/query-shape.js';
import {isSystemOverviewQuestion, wantsDependencyManifest, wantsSupportingEvidence} from '../util/retrieval-intent.js';
import {buildRepoContext, clipToLineBudget, dedupeBy, isSupportingEvidencePath, sourceFamilyForPath, splitIdentifier} from '../util/retrieval-core.js';
import {parseToolInput, searchInputSchema} from './schemas.js';
import {expandImportNeighbors} from '../index/graph-hubs.js';

// Re-exported from the shared retrieval module for back-compat with callers that
// still import it from here.
//
export {isSupportingEvidencePath} from '../util/retrieval-core.js';

// Files that must never reach a result, by path: the secret-bearing .env (and
// its local variants) and the .env template. Enforced at the result boundary as
// defense-in-depth on top of index-time exclusion.
//
const ENV_FILE_PATTERN = /(^|\/)\.env(\.|$)/i;

function isExcludedResultPath(relPath) {
    return ENV_FILE_PATTERN.test(String(relPath || ''));
}

// How hard to demote a dependency manifest (package.json) when the query is not
// actually about dependencies/versions. Sized to sink a manifest below a wiring
// file that has even a single path hit (pathHits * 40) plus one fused base step,
// so genuine source/config wins, while leaving the manifest reachable via the
// capped support leg.
//
const MANIFEST_DEMOTION = 80;

// Small baseline for a query-relevant graph fact (route/definition/etc). Kept
// low so graph facts surface alongside the fused hits without displacing the
// top results that drive retrieval quality (see test/eval/retrieval-eval.js).
//
const GRAPH_BASE_SCORE = 3;

// runSearch — hybrid retrieval: native BM25 full-text (store.searchByText) +
// dense vector (store.searchByEmbedding), fused in-app with Reciprocal Rank
// Fusion (fuseByRrf), then re-ranked by domain signals (file-name match,
// UI-surface family, repo profile) and merged with graph-relation facts. RRF is
// computed in-app rather than via LanceDB's native reranker so the cosine
// `similarity` from the vector leg survives for the planner's fast-path/HyDE
// gating (the native fused query drops `_distance`). Exposed directly so the
// planner can pass a precomputed embedding (e.g., HyDE) and skip the duplicate
// embed step. Lexical matching always uses the natural-language query text — it
// isn't useful on a hypothetical-answer embedding.
//
export async function runSearch({queryText, queryEmbedding, limit, embedder, store, includeSupport = false, supportLimit = 2, reranker = null, legs = null, semanticThreshold = config.search.semanticThreshold}) {
    // Lever selection. Explicit `legs` are ablation toggles for the eval; when a
    // caller passes none (every production call site), the levers come from the
    // query's retrieval shape under the shipped arm — the measured policy that
    // keeps the domain boost where it earns its keep (identifier/relational) and
    // out of product-language queries when the arm says so.
    //
    let policyLegs = legs;
    let effectiveReranker = reranker;
    const queryShape = classifyQueryShape(queryText);
    if(!legs || Object.keys(legs).length === 0) {
        const policy = retrievalPolicyForShape(queryShape, {arm: PRODUCTION_QUERY_SHAPE_ARM});
        policyLegs = policy.legs;
        if(!policy.rerank) {
            effectiveReranker = null;
        }
    }
    const {lexical: useLexical = true, graph: useGraph = true, domainBoost: useDomainBoost = true} = policyLegs;
    const startedAt = Date.now();
    const k = limit ?? 6;
    // Overview questions need the support leg too: README/docs index with a
    // supporting role and are otherwise never retrieved for "how does this
    // system work" phrasing — the outline then narrates without the repo's own
    // overview documentation.
    //
    const supportQuery = wantsSupportingEvidence(queryText) || isSystemOverviewQuestion(queryText);
    const manifestSeeking = wantsDependencyManifest(queryText);
    const textSearch = createTextSearchCache(store);
    const retrieval = {
        modes: [],
        timings: {},
        counts: {}
    };
    let embedding = queryEmbedding;
    if(embedding) {
        retrieval.modes.push('embedding');
        retrieval.timings.embeddingMs = 0;
    } else {
        const embeddingStart = Date.now();
        embedding = (await embedder.embed([queryText], {type: 'query'}))[0];
        retrieval.modes.push('embedding');
        retrieval.timings.embeddingMs = Date.now() - embeddingStart;
    }
    const tokens = lexicalTokens(queryText).slice(0, supportQuery ? 18 : 8);
    const surfaceFamilies = surfaceFamiliesForQuery(queryText);
    const repoContext = repoContextForQuery(queryText);
    const candidateLimit = Math.max(k * 3, 18);

    // Two native retrieval legs: dense vector (cosine) and BM25 full-text.
    //
    const effectiveSemanticThreshold = normalizeSemanticThreshold(semanticThreshold);
    const semanticStart = Date.now();
    const rawSemantic = (await store.searchByEmbedding(embedding, candidateLimit))
        .map((row) => withRetrievalOrigin(row, 'vector'));
    const semantic = effectiveSemanticThreshold === null
        ? rawSemantic
        : rawSemantic.filter((row) => row.similarity !== null && row.similarity >= effectiveSemanticThreshold);
    retrieval.modes.push('vector');
    retrieval.timings.vectorMs = Date.now() - semanticStart;
    retrieval.counts.vectorCandidatesRaw = rawSemantic.length;
    retrieval.counts.vectorCandidates = semantic.length;
    retrieval.semantic = {
        threshold: effectiveSemanticThreshold,
        topSimilarity: rawSemantic[0]?.similarity ?? null,
        qualifiedTopSimilarity: semantic[0]?.similarity ?? null
    };

    let lexical = [];
    if(useLexical) {
        const lexicalStart = Date.now();
        lexical = (await store.searchByText(queryText, candidateLimit))
            .map((row) => withRetrievalOrigin(row, 'lexical'));
        retrieval.modes.push('lexical');
        retrieval.timings.lexicalMs = Date.now() - lexicalStart;
        retrieval.counts.lexicalRows = lexical.length;
    }

    // Fuse the two legs with Reciprocal Rank Fusion, then re-rank with the
    // domain-aware nudges (file-name match, UI-surface family, repo profile)
    // that survive the move off the hand-rolled lexical tables. Cosine
    // similarity is carried from the vector hit so the planner's fast-path and
    // HyDE gating still see a real [0,1] score.
    //
    const fused = fuseByRrf([semantic, lexical]);

    let graphRows = [];
    if(useGraph && tokens.length > 0) {
        const graphStart = Date.now();
        const graphLimit = Math.max(4, k);
        const [textGraphRows, structuralGraphRows] = await Promise.all([
            findGraphRelatedRows({queryText, tokens, store, limit: graphLimit, surfaceFamilies, repoContext}),
            queryShape === 'identifier'
                ? Promise.resolve([])
                : findStructuralGraphRows({store, seedRows: fused, limit: graphLimit})
        ]);
        graphRows = dedupeBy([...structuralGraphRows, ...textGraphRows], (row) => `${row.path}:${row.lineStart}-${row.lineEnd}`).slice(0, graphLimit);
        retrieval.modes.push('graph');
        retrieval.timings.graphMs = Date.now() - graphStart;
        retrieval.counts.graphRows = graphRows.length;
        retrieval.counts.structuralGraphRows = structuralGraphRows.length;
    }

    let support = [];
    if(includeSupport && supportQuery) {
        const supportStart = Date.now();
        support = (await findSupportingRows({queryText, tokens, textSearch, limit: supportLimit}))
            .map((row) => withRetrievalOrigin(row, 'support'));
        retrieval.modes.push('support');
        retrieval.timings.supportMs = Date.now() - supportStart;
        retrieval.counts.supportRows = support.length;
    }

    // Score fused candidates and graph facts on one scale and rank together, so
    // a query-relevant route/definition can outrank weak semantic noise while a
    // strong file-name/anchor match still wins. mergeAndDedup then enforces
    // path diversity in score order.
    //
    // domainBoost leg modes: true (full nudges), false (off), 'tiebreak' (positive
    // nudges capped below one fused-rank step so they only break RRF ties, while
    // the manifest demotion keeps its full negative weight — demotion is a
    // correctness rule, not a nudge).
    //
    const boost = (row) => {
        if(!useDomainBoost) {
            return 0;
        }
        const raw = domainBoost(row, tokens, surfaceFamilies, repoContext, manifestSeeking);
        if(useDomainBoost === 'tiebreak' && raw > 0) {
            return Math.min(raw / 100, 1.9);
        }
        return raw;
    };
    const scoredPrimary = fused.map((row, index) => {
        const rankScore = (fused.length - index) * 2 + boost(row);
        return {row: {...row, rankScore}, score: rankScore};
    });
    const scoredGraph = graphRows.map((row, index) => {
        const rankScore = GRAPH_BASE_SCORE + (graphRows.length - index) + boost(row);
        return {row: {...row, rankScore}, score: rankScore};
    });
    let ordered = [...scoredPrimary, ...scoredGraph]
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.row);

    // Optional final stage: a local cross-encoder rescoring the top candidates by
    // true query↔code relevance. Rows keep their cosine `similarity`; only order
    // changes. Skipped entirely when no reranker is supplied.
    //
    if(effectiveReranker) {
        const rerankStart = Date.now();
        try {
            ordered = await effectiveReranker.rerank(queryText, ordered);
            retrieval.modes.push('rerank');
            retrieval.timings.rerankMs = Date.now() - rerankStart;
        } catch {
            // A reranker failure must never empty retrieval (which would force a
            // lean, code-less answer). Keep the fused order — reranking is a
            // refinement, not a dependency.
            //
            retrieval.modes.push('rerank_failed');
        }
    }

    // Hard exclusion at the result boundary: a .env / .env.* file (secret-bearing
    // or template) must never reach a result, regardless of how it was retrieved.
    //
    ordered = ordered.filter((row) => !isExcludedResultPath(row?.path));
    support = support.filter((row) => !isExcludedResultPath(row?.path));

    const merged = mergeAndDedup(ordered, [], k, {support, supportLimit});
    retrieval.counts.results = merged.length;
    retrieval.counts.textQueries = textSearch.stats().queries;
    retrieval.timings.totalMs = Date.now() - startedAt;

    return {
        count: merged.length,
        threshold: effectiveSemanticThreshold,
        retrieval: normalizeRetrievalDiagnostics(retrieval),
        results: merged.map((r) => buildResult(r))
    };
}

function createTextSearchCache(store) {
    const cache = new Map();
    let queries = 0;

    async function search(term, limit) {
        const key = String(term || '').toLowerCase();
        const requested = Math.max(1, Number(limit) || 1);
        const cached = cache.get(key);
        if(cached && cached.limit >= requested) {
            return cached.rows.slice(0, requested);
        }
        const rows = await store.searchByText(term, requested);
        queries++;
        cache.set(key, {limit: requested, rows});
        return rows;
    }

    return {
        search,
        stats: () => ({queries})
    };
}

function normalizeRetrievalDiagnostics(retrieval) {
    return {
        modes: [...new Set(retrieval.modes)].filter(Boolean),
        timings: Object.fromEntries(Object.entries(retrieval.timings).map(([key, value]) => [key, Number(value) || 0])),
        counts: Object.fromEntries(Object.entries(retrieval.counts).map(([key, value]) => [key, Number(value) || 0])),
        semantic: {
            threshold: retrieval.semantic?.threshold ?? null,
            topSimilarity: finiteOrNull(retrieval.semantic?.topSimilarity),
            qualifiedTopSimilarity: finiteOrNull(retrieval.semantic?.qualifiedTopSimilarity)
        }
    };
}

function normalizeSemanticThreshold(value) {
    if(value === null || value === undefined || value === '') {
        return null;
    }
    const numeric = Number(value);
    if(!Number.isFinite(numeric)) {
        return null;
    }
    return Math.max(0, Math.min(1, numeric));
}

function finiteOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function withRetrievalOrigin(row, origin) {
    const origins = [...new Set([...(row?.origins || []), origin])];
    const similarity = origins.includes('vector')
        ? (typeof row?.similarity === 'number' ? row.similarity : distanceToSimilarity(row?.score))
        : null;
    return {
        ...row,
        similarity,
        origins
    };
}

const STOPWORDS = new Set([
    'the', 'and', 'how', 'why', 'what', 'where', 'when', 'who', 'does', 'work',
    'works', 'with', 'into', 'from', 'that', 'this', 'then', 'than', 'are',
    'for', 'you', 'about', 'fit', 'fits', 'implementation', 'algorithm',
    'system', 'process', 'deep', 'level', 'tell', 'everything', 'please',
    'explain', 'walkthrough', 'overview', 'fully'
]);

const SUPPORT_QUERY_TERMS = REPO_SUPPORT_QUERY_TERMS;

function lexicalTokens(queryText) {
    const raw = String(queryText || '').match(/[A-Za-z0-9_$@./-]{2,}/g) || [];
    const out = [];
    const seen = new Set();
    const add = (token) => {
        const normalized = normalizeSearchToken(token);
        if(STOPWORDS.has(normalized) || seen.has(normalized)) {
            return;
        }
        seen.add(normalized);
        out.push(token);
    };
    for(const token of raw) {
        add(token);
        for(const part of splitIdentifier(token)) {
            add(part);
        }
    }
    return out.sort((a, b) => lexicalPriority(b) - lexicalPriority(a));
}

function lexicalPriority(token) {
    const raw = String(token || '');
    const normalized = normalizeSearchToken(raw);
    if(!normalized) {
        return 0;
    }
    if(/[./@$-]/.test(raw) || /[a-z0-9][A-Z]/.test(raw) || /^[A-Z0-9_]{2,}$/.test(raw)) {
        return 5;
    }
    if(/^(runtime|store|indexer|watcher|embedder|index|file|stats|progress|chunker|chunk|vector|search|embedding|text|upsert|content|hash|dependency|manifest|config|package|cargo)$/.test(normalized)) {
        return 4;
    }
    if(/(index|embed|chunk|vector|database|store|retrieval|dependency|manifest|config|schema|query)/.test(normalized)) {
        return 2;
    }
    return 0;
}

function normalizeSearchToken(token) {
    return String(token || '')
        .toLowerCase()
        .replace(/^@/, '')
        .replace(/[^a-z0-9]+/g, '');
}

function surfaceFamiliesForQuery(queryText) {
    const q = String(queryText || '').toLowerCase();
    const families = new Set();
    if(/\b(html|markup|template|dom|document|page|screen|layout|visible|ui|frontend|browser)\b/.test(q)) {
        families.add('markup');
    }
    if(/\b(css|style|styles|stylesheet|selector|layout|appearance|theme|visual|color|spacing|responsive|animation)\b/.test(q)) {
        families.add('style');
    }
    return families;
}

function repoContextForQuery(queryText) {
    return buildRepoContext(queryText, {
        normalize: normalizeSearchToken,
        termOrder: ['matchedTerms', 'evidenceTerms', 'questionTerms']
    });
}

export function __retrievalSignalsForTest(queryText) {
    const tokens = lexicalTokens(queryText);
    const surfaceFamilies = surfaceFamiliesForQuery(queryText);
    const repoContext = repoContextForQuery(queryText);
    return {
        tokens,
        surfaceFamilies: [...surfaceFamilies].sort(),
        graphTerms: graphSearchTerms(queryText, tokens, repoContext),
        repoProfiles: repoContext.profiles.map((profile) => ({
            id: profile.id,
            family: profile.family,
            category: profile.category,
            matchedTerms: profile.matchedTerms
        }))
    };
}

// search_codebase(query, limit?) — hybrid semantic + lexical lookup.
// Returns ranked chunks with full content (when small enough) so the LLM
// usually does NOT need a follow-up read_file. The content field is line-prefixed
// so the model can cite exact line numbers without a second tool call.
//
export function createSearchTool({embedder, store, reranker = null}) {
    return tool({
        description: 'Search the codebase for chunks of source code semantically related to the query. Returns ranked file/line excerpts WITH INLINE CONTENT. Prefer this over read_file — only call read_file when a chunk is truncated or you need surrounding lines.',
        inputSchema: searchInputSchema,
        execute: async (input) => {
            const parsed = parseToolInput(searchInputSchema, input);
            if(!parsed.ok) {
                return parsed.response;
            }
            const {query, limit} = parsed.input;
            return runSearch({queryText: query, limit, embedder, store, includeSupport: true, reranker});
        }
    });
}

function buildResult(r) {
    const fullContent = r.content || '';
    const clipped = clipContentForResult(fullContent, r.lineStart, r.lineEnd, config.search.contentMax);
    const origins = [...new Set(r.origins || [])];
    const similarity = origins.includes('vector')
        ? (typeof r.similarity === 'number' ? r.similarity : distanceToSimilarity(r.score))
        : null;
    return {
        path: r.path,
        lineStart: r.lineStart,
        lineEnd: clipped.lineEnd,
        fullLineEnd: clipped.truncated ? r.lineEnd : undefined,
        similarity: similarity === null ? null : Number(similarity.toFixed(4)),
        origins,
        rrfScore: finiteOrNull(r.rrfScore),
        rankScore: finiteOrNull(r.rankScore),
        rerankScore: finiteOrNull(r.rerankScore),
        content: prefixWithLineNumbers(clipped.content, r.lineStart),
        truncated: clipped.truncated,
        relationship: r.graph ? {
            kind: r.graph.kind,
            name: r.graph.name,
            target: r.graph.target,
            detail: r.graph.detail,
            lineStart: r.graph.lineStart,
            lineEnd: r.graph.lineEnd
        } : null,
        hint: clipped.truncated ? `Truncated; call read_file('${r.path}', ${r.lineStart}, ${r.lineEnd}) for the full chunk.` : null
    };
}

function clipContentForResult(content, startLine, fullLineEnd, maxChars) {
    const clipped = clipToLineBudget(content, maxChars);
    if(!clipped.truncated) {
        return {
            content: clipped.content,
            lineEnd: Number(fullLineEnd) || lineEndForText(startLine, clipped.content),
            truncated: false
        };
    }
    return {
        content: clipped.content,
        lineEnd: (Number(startLine) || 1) + clipped.content.split(/\r?\n/).length - 1,
        truncated: true
    };
}

function lineEndForText(startLine, text) {
    if(!text) {
        return Number(startLine) || 1;
    }
    return (Number(startLine) || 1) + String(text).split(/\r?\n/).length - 1;
}

async function findGraphRelatedRows({queryText, tokens, store, limit, surfaceFamilies = new Set(), repoContext = null}) {
    if(typeof store.searchGraphByText !== 'function' || typeof store.chunksForGraphRows !== 'function') {
        return [];
    }
    const searchTokens = graphSearchTerms(queryText, tokens, repoContext);
    if(searchTokens.length === 0) {
        return [];
    }
    const bags = await Promise.all(searchTokens.map((token) => store.searchGraphByText(token, 10)));
    const graphRows = rankGraphRows(bags.flat(), searchTokens, surfaceFamilies, repoContext).slice(0, limit);
    const chunks = await store.chunksForGraphRows(graphRows, limit);
    return chunks.map((row, index) => withRetrievalOrigin({
        ...row,
        graphPriority: Math.max(0, limit - index),
        similarity: null
    }, 'graph'));
}

async function findStructuralGraphRows({store, seedRows, limit}) {
    if(typeof store?.firstChunkForPath !== 'function' || typeof store?.importEdges !== 'function' || typeof store?.knownPaths !== 'function') {
        return [];
    }
    const seedPaths = [...new Set((seedRows || []).map((row) => row?.path).filter(Boolean))].slice(0, 4);
    if(seedPaths.length === 0) {
        return [];
    }
    const neighbors = await expandImportNeighbors({store, seedPaths, limit});
    const heads = await Promise.all(neighbors.map(async (neighbor) => {
        const row = await store.firstChunkForPath(neighbor.path);
        if(!row) {
            return null;
        }
        const relation = neighbor.direction === 'imports'
            ? `${neighbor.relatedTo} imports this file`
            : `${neighbor.path} imports ${neighbor.relatedTo}`;
        return withRetrievalOrigin({
            ...row,
            similarity: null,
            graph: {
                kind: neighbor.direction,
                name: neighbor.path,
                target: neighbor.relatedTo,
                detail: relation,
                lineStart: row.lineStart,
                lineEnd: row.lineEnd
            }
        }, 'graph_structural');
    }));
    return heads.filter(Boolean);
}

// Query-intent buckets: each regex detects a surface family in the question and
// contributes its expansion terms. Compiled once at module load rather than per
// request.
//
const GRAPH_TERM_BUCKETS = [
    {match: /\b(ui|html|markup|dom|button|form|input|screen|page|component|css|style|selector|animation|layout|theme)\b/, terms: ['markup', 'style', 'ui', 'selector', 'css', 'html']},
    {match: /\b(route|endpoint|api|handler|server|request|response)\b/, terms: ['route', 'handler', 'get', 'post', 'put', 'delete']},
    {match: /\b(entrypoint|entry point|main|cli|command|start|startup|boot|server)\b/, terms: ['entrypoint', 'main', 'start', 'server']},
    {match: /\b(db|database|store|storage|query|schema|model|table|vector|embedding|index)\b/, terms: ['storage', 'query', 'table', 'vector', 'embedding', 'index']},
    {match: /\b(config|configuration|env|environment|setting|option)\b/, terms: ['configuration', 'config', 'env']},
    {match: /\b(dependency|dependencies|package|install|manifest|npm|pip|cargo|crate)\b/, terms: ['dependency', 'package', 'manifest', 'import']}
];

function graphSearchTerms(queryText, tokens, repoContext = null) {
    const q = String(queryText || '').toLowerCase();
    const out = new Set(tokens.map((t) => String(t || '').toLowerCase()).filter(Boolean));
    for(const bucket of GRAPH_TERM_BUCKETS) {
        if(bucket.match.test(q)) {
            bucket.terms.forEach((term) => out.add(term));
        }
    }
    for(const term of repoContext?.terms || []) {
        if(term.length >= 3) {
            out.add(term);
        }
    }
    return [...out].filter((term) => term.length >= 3).slice(0, 18);
}

function rankGraphRows(rows, tokens, surfaceFamilies = new Set(), repoContext = null) {
    const tokenSet = new Set(tokens.map((t) => t.toLowerCase()));
    return dedupeBy(rows, (row) => `${row.path}:${row.lineStart}-${row.lineEnd}:${row.kind}:${row.name}:${row.target}`)
        .map((row) => ({
            row,
            score: graphScore(row, tokenSet, surfaceFamilies, repoContext)
        }))
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.row);
}

function graphScore(row, tokens, surfaceFamilies = new Set(), repoContext = null) {
    const haystack = [
        row.path,
        row.kind,
        row.name,
        row.target,
        row.detail,
        row.syntax
    ].join('\n').toLowerCase();
    let score = 0;
    if(row.kind === 'definition') score += 3;
    if(row.kind === 'route' || row.kind === 'storage' || row.kind === 'entrypoint' || row.kind === 'dependency') score += 3;
    if(row.kind === 'markup' || row.kind === 'ui' || row.kind === 'style' || row.kind === 'style_rule') score += 2.5;
    if(row.kind === 'configuration' || row.kind === 'import') score += 2;
    score += surfaceFamilyScore(row, surfaceFamilies) * 5;
    score += repoProfileScore(row, repoContext) * 4;
    if(tokens.has(String(row.kind || '').toLowerCase())) {
        score += 4;
    }
    if(tokens.has('route') && row.kind === 'route') {
        score += 4;
    }
    if((tokens.has('selector') || tokens.has('style') || tokens.has('css')) && String(row.kind || '').startsWith('style')) {
        score += 4;
    }
    if((tokens.has('html') || tokens.has('markup') || tokens.has('ui')) && (row.kind === 'markup' || row.kind === 'ui')) {
        score += 4;
    }
    for(const token of tokens) {
        if(haystack.includes(token)) {
            score += token.length > 5 ? 2 : 1;
        }
    }
    return score;
}

async function findSupportingRows({queryText, tokens, textSearch, limit}) {
    const querySupportTokens = [...new Set([
        ...tokens,
        ...supportTermsForQuery(queryText)
    ])].slice(0, 18);
    const searchTokens = [...new Set([
        ...querySupportTokens,
        ...SUPPORT_QUERY_TERMS
    ])].slice(0, 18);
    const bags = await Promise.all(searchTokens.map((t) => textSearch.search(t, 8)));
    const candidates = bags
        .flat()
        .filter((row) => isSupportingEvidencePath(row.path));
    return rankSupportingRows(candidates, querySupportTokens).slice(0, limit);
}

function supportTermsForQuery(queryText) {
    return supportTermsForRepoQuestion(queryText);
}

function rankSupportingRows(rows, tokens) {
    const tokenSet = new Set(tokens.map((t) => t.toLowerCase()).filter(Boolean));
    return dedupeBy(rows, (row) => `${row.path}:${row.lineStart}-${row.lineEnd}`)
        .map((row) => ({
            row,
            score: supportingScore(row, tokenSet)
        }))
        .sort((a, b) => b.score - a.score)
        .map((item) => item.row);
}

function supportingScore(row, tokens) {
    const haystack = `${row.path}\n${row.content || ''}`.toLowerCase();
    let score = row.path?.startsWith('__dependencies__/') ? 3 : 1;
    for(const token of tokens) {
        if(token && haystack.includes(token)) {
            score += token.length > 5 ? 2 : 1;
        }
    }
    if(/\b(description|repository|installed version|packageManager|exports|types|moduleResolution|dependencies)\b/i.test(row.content || '')) {
        score += 2;
    }
    return score;
}

// Reciprocal Rank Fusion of ranked lists (vector, BM25). Each list contributes
// 1/(k + rank) to a row's score; the row variant that carries a cosine distance
// (the vector hit) is kept so downstream display/gating still has a similarity.
//
function fuseByRrf(lists, {k = 60} = {}) {
    const byKey = new Map();
    for(const list of lists) {
        for(let rank = 0; rank < list.length; rank++) {
            const row = list[rank];
            const key = rowKey(row);
            const entry = byKey.get(key) || {row, rrf: 0, origins: new Set()};
            entry.rrf += 1 / (k + rank + 1);
            for(const origin of row.origins || []) {
                entry.origins.add(origin);
            }
            if(!(entry.row.origins || []).includes('vector') && (row.origins || []).includes('vector')) {
                entry.row = row;
            }
            byKey.set(key, entry);
        }
    }
    return [...byKey.values()]
        .sort((a, b) => b.rrf - a.rrf)
        .map((entry) => ({
            ...entry.row,
            origins: [...entry.origins],
            rrfScore: entry.rrf
        }));
}

// Domain-aware boost applied on top of the fusion/graph baseline. Carries over
// the signals that used to live in the lexical tiers: UI-surface family,
// repo-profile match, and query-term matches in the file path (strong "this
// file is the answer" signal) or content. Query tokens already include split
// identifier parts, so matching is on parts; a path match outweighs content.
//
function domainBoost(row, tokens, surfaceFamilies = new Set(), repoContext = null, manifestSeeking = false) {
    let score = surfaceFamilyScore(row, surfaceFamilies) * 300;
    score += repoProfileScore(row, repoContext) * 120;
    const queryParts = new Set(tokens.map((t) => normalizeSearchToken(t)).filter((t) => t.length >= 2));
    const pathTerms = new Set(splitIdentifier(row?.path || '').map(normalizeSearchToken).filter(Boolean));
    const contentTerms = new Set(splitIdentifier(String(row?.content || '').slice(0, 4000)).map(normalizeSearchToken).filter(Boolean));
    let pathHits = 0;
    let contentHits = 0;
    for(const part of queryParts) {
        if(pathTerms.has(part)) {
            pathHits++;
        } else if(contentTerms.has(part)) {
            contentHits++;
        }
    }
    score += pathHits * 40 + contentHits * 3;

    // A dependency manifest only enumerates packages; for anything but a
    // manifest-seeking question it is supporting context, not primary evidence.
    // Demote it so genuine wiring/source files win, while the support leg can
    // still surface it as capped context.
    //
    if(!manifestSeeking && isDependencyManifestPath(row?.path || '')) {
        score -= MANIFEST_DEMOTION;
    }
    return score;
}

function surfaceFamilyScore(row, surfaceFamilies) {
    const family = sourceFamilyForPath(row?.path);
    if(!family || !surfaceFamilies.has(family)) {
        return 0;
    }
    return family === 'markup' || family === 'style' ? 1 : 0;
}

function repoProfileScore(row, repoContext) {
    if(!repoContext || repoContext.profiles.length === 0) {
        return 0;
    }
    const integration = resolveLanguageIntegration({path: row?.path || ''});
    let score = 0;
    if(integration?.id && repoContext.ids.has(integration.id)) {
        score += 1;
    }
    if(integration?.family && repoContext.families.has(integration.family)) {
        score += 0.5;
    }
    if(integration?.category && repoContext.categories.has(integration.category)) {
        score += 0.25;
    }
    const haystack = `${row?.path || ''}\n${String(row?.content || '').slice(0, 2000)}`.toLowerCase();
    let termHits = 0;
    for(const term of repoContext.terms) {
        if(term.length >= 3 && haystack.includes(term)) {
            termHits++;
        }
    }
    return score + Math.min(1, termHits * 0.2);
}

function prefixWithLineNumbers(text, startLine) {
    if(!text) return '';
    const lines = text.split(/\r?\n/);
    const endLine = startLine + lines.length - 1;
    const gutter = String(endLine).length;
    return lines.map((line, i) => `${String(startLine + i).padStart(gutter, ' ')}  ${line}`).join('\n');
}

function distanceToSimilarity(distance) {
    return typeof distance === 'number' ? 1 - distance : null;
}

function mergeAndDedup(a, b, limit, {support = [], supportLimit = 0} = {}) {
    const seen = new Set();
    const seenPaths = new Set();
    const selectedByKey = new Map();
    const out = [];
    const supportRows = support.slice(0, Math.max(0, Math.min(supportLimit, limit)));
    const primaryLimit = Math.max(0, limit - supportRows.length);
    // Collapse duplicate retrieval legs before applying the result cap. Without
    // this pass, a lower-ranked graph duplicate could sit beyond top-k and its
    // relationship signal would never be merged into the selected vector row.
    const primaryCandidates = collapseDuplicateRows([...a, ...b]);

    const addPrimaryRows = (requireNewPath) => {
        for(const row of primaryCandidates) {
            const key = rowKey(row);
            if(seen.has(key)) {
                mergeRowSignals(selectedByKey.get(key), row);
                continue;
            }
            if(requireNewPath && seenPaths.has(row.path)) {
                continue;
            }
            seen.add(key);
            seenPaths.add(row.path);
            out.push(row);
            selectedByKey.set(key, row);
            if(out.length >= primaryLimit) {
                return;
            }
        }
    };

    addPrimaryRows(true);
    if(out.length < primaryLimit) {
        addPrimaryRows(false);
    }

    for(const row of supportRows) {
        const key = rowKey(row);
        if(seen.has(key)) {
            mergeRowSignals(selectedByKey.get(key), row);
            continue;
        }
        seen.add(key);
        seenPaths.add(row.path);
        out.push(row);
        selectedByKey.set(key, row);
        if(out.length >= limit) {
            break;
        }
    }
    if(out.length < limit) {
        for(const row of primaryCandidates) {
            const key = rowKey(row);
            if(seen.has(key)) {
                mergeRowSignals(selectedByKey.get(key), row);
                continue;
            }
            seen.add(key);
            seenPaths.add(row.path);
            out.push(row);
            selectedByKey.set(key, row);
            if(out.length >= limit) {
                break;
            }
        }
    }
    return out;
}

function collapseDuplicateRows(rows) {
    const byKey = new Map();
    const out = [];
    for(const row of rows) {
        const key = rowKey(row);
        const existing = byKey.get(key);
        if(existing) {
            mergeRowSignals(existing, row);
            continue;
        }
        byKey.set(key, row);
        out.push(row);
    }
    return out;
}

function mergeRowSignals(selected, candidate) {
    if(!selected || !candidate) {
        return;
    }
    selected.origins = [...new Set([...(selected.origins || []), ...(candidate.origins || [])])];
    if(typeof selected.similarity !== 'number' && typeof candidate.similarity === 'number') {
        selected.similarity = candidate.similarity;
    }
    selected.graph ||= candidate.graph || null;
    selected.graphPriority = Math.max(Number(selected.graphPriority) || 0, Number(candidate.graphPriority) || 0) || undefined;
    selected.rrfScore = Math.max(Number(selected.rrfScore) || 0, Number(candidate.rrfScore) || 0) || undefined;
    selected.rankScore = Math.max(Number(selected.rankScore) || 0, Number(candidate.rankScore) || 0) || undefined;
}

function rowKey(row) {
    return `${row?.path || ''}:${row?.lineStart || ''}-${row?.lineEnd || ''}`;
}

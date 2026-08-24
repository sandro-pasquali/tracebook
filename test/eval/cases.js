import path from 'node:path';
import process from 'node:process';
import fs from 'fs-extra';

// Labeled retrieval/generation cases — the single source of truth shared by the
// retrieval eval (does search surface the expected file?) and the generation
// eval (does the final answer cite + ground in the expected file?).
//
// {question, expect: [paths], type}. A retrieval hit = any expected path in the
// top-K results; a generation citation hit = any expected path in a block's
// sourceRefs.
//
// Query types:
//   product     — plain product language, never names the file (PM/exec phrasing)
//   identifier  — an exact symbol / config token / rare literal (BM25's home turf)
//   leaky       — the file name appears in the query (contrast / regression guard)
//   integration — relational "how do X and Y work together"; the answer is the
//                 wiring/source file, never the dependency manifest listing them
//
export const CASES = [
    // ── product: plain product language, no file-name token ──
    {type: 'product', question: 'how is a repeated question served from saved results instead of recomputing the response', expect: ['src/util/answer-cache.js']},
    {type: 'product', question: 'what keeps the search corpus current when files change on disk', expect: ['src/index/watcher.js']},
    {type: 'product', question: 'what limits how many model tokens are spent per minute', expect: ['src/util/governor.js']},
    {type: 'product', question: 'how is a large file divided into overlapping windows before embedding', expect: ['src/index/chunker.js']},
    {type: 'product', question: 'where are code embeddings written to and queried from the vector database', expect: ['src/index/store.js']},
    {type: 'product', question: 'where is the actors, happy path, and behavior summary built for a question', expect: ['src/feature-trace.js']},
    {type: 'product', question: 'where is the hypothetical document embedding generated to improve weak search', expect: ['src/planner/index.js']},
    {type: 'product', question: 'what decides whether the user is asking to locate, explain, or simulate', expect: ['src/intent-classifier.js']},
    {type: 'product', question: 'how does the system turn raw text and code into numeric vectors for similarity search', expect: ['src/index/embedder.js']},
    {type: 'product', question: 'how are search results re-ordered by how well they answer the question', expect: ['src/index/reranker.js']},
    {type: 'product', question: 'how is each file summarized in plain language for non-engineers', expect: ['src/index/enrichment.js']},
    {type: 'product', question: 'how are completed investigations persisted to disk and replayed step by step', expect: ['src/trace-store.js']},
    {type: 'product', question: 'how are multi-step investigations saved and listed for later', expect: ['src/story-store.js']},
    {type: 'product', question: 'how does the system stream answer events to the browser over a live connection', expect: ['src/server.js']},
    {type: 'product', question: 'how does the system skip files the project has marked as not tracked', expect: ['src/util/repo-ignore.js']},
    {type: 'product', question: 'how are routes, definitions, and other code relationships extracted from source', expect: ['src/util/source-syntax.js']},
    {type: 'product', question: 'how is a file path kept from escaping outside the project directory', expect: ['src/util/source-path.js']},
    {type: 'product', question: 'where is the prompt that guides how the model explores the codebase', expect: ['src/planner/prompts.js']},

    // ── identifier: exact symbol / config token / rare literal ──
    {type: 'identifier', question: 'where is the fuseByRrf function defined', expect: ['src/tools/search.js']},
    {type: 'identifier', question: 'where is buildChunkFtsText implemented', expect: ['src/index/store.js']},
    {type: 'identifier', question: 'where is createReranker defined', expect: ['src/index/reranker.js']},
    {type: 'identifier', question: 'where is createEnricher defined', expect: ['src/index/enrichment.js']},
    {type: 'identifier', question: 'where is compactReplayEvents defined', expect: ['src/util/replay-events.js']},
    {type: 'identifier', question: 'where is extractSourceGraph implemented', expect: ['src/util/source-syntax.js']},
    {type: 'identifier', question: 'where is buildFeatureTrace defined', expect: ['src/feature-trace.js']},
    {type: 'identifier', question: 'where is the buildEmbeddingText function', expect: ['src/index/embedding-text.js']},
    {type: 'identifier', question: 'where is classifyIntent defined', expect: ['src/intent-classifier.js']},
    {type: 'identifier', question: 'where is resolveSafePath defined', expect: ['src/util/source-path.js']},
    {type: 'identifier', question: 'where is the RERANK_CANDIDATES setting read', expect: ['src/util/config.js']},
    {type: 'identifier', question: 'where is HYDE_MIN_SIMILARITY configured', expect: ['src/util/config.js']},
    {type: 'identifier', question: 'where is createGovernor defined', expect: ['src/util/governor.js']},
    {type: 'identifier', question: 'where is wantsSupportingEvidence defined', expect: ['src/util/retrieval-intent.js']},

    // ── leaky: file name token present in the query (contrast) ──
    {type: 'leaky', question: 'Where is the answer cache that replays repeated questions implemented?', expect: ['src/util/answer-cache.js']},
    {type: 'leaky', question: 'How does the file watcher keep the search index in sync with the filesystem?', expect: ['src/index/watcher.js']},
    {type: 'leaky', question: 'Where is the question intent classified into locate, show, explain, simulate?', expect: ['src/intent-classifier.js']},
    {type: 'leaky', question: 'Where is the token-per-minute budget governor that throttles model calls?', expect: ['src/util/governor.js']},
    {type: 'leaky', question: 'How is a source file split into overlapping chunks for indexing?', expect: ['src/index/chunker.js']},
    {type: 'leaky', question: 'Where are completed traces persisted to disk as event logs?', expect: ['src/trace-store.js']},
    {type: 'leaky', question: 'How are stories saved, summarized, and removed?', expect: ['src/story-store.js']},
    {type: 'leaky', question: 'Where is the LanceDB vector store and chunk embeddings table created?', expect: ['src/index/store.js']},
    {type: 'leaky', question: 'Where does the server stream SSE events for the ask endpoint?', expect: ['src/server.js']},
    {type: 'leaky', question: 'How are mermaid sequence diagrams rendered as a web component?', expect: ['public/js/components/sequence-diagram.js']},
    {type: 'leaky', question: 'Where is the feature trace behavior, actors, and happy path built?', expect: ['src/feature-trace.js']},

    // ── integration: relational "how do X and Y work together" ──
    {type: 'integration', question: 'how do hono and vite work together', expect: ['vite.config.js', 'src/server.js']},
    {type: 'integration', question: 'how does the dev server serve the browser app during development', expect: ['vite.config.js', 'src/server.js']},
    {type: 'integration', question: 'how is the app bundled for production', expect: ['vite.config.js']},
    {type: 'integration', question: 'how does the app connect to the openai api to generate answers', expect: ['src/util/model.js']},
    {type: 'integration', question: 'how does the app store and search vectors in lancedb', expect: ['src/index/store.js']},
    {type: 'integration', question: 'I need to see the entire flow from text input -> server -> mermaid rendering in chapter blocks', expect: ['public/js/components/sequence-diagram.js']}
];

// Whole-system overview cases — generation-eval ONLY, kept out of CASES so the
// retrieval baselines' casesHash stays untouched (the PROBE_CASES precedent).
// `expect` is the repo's SPINE: the entry point, the orchestrator, and the core
// processing layer. The spine metric = fraction of these the answer cites.
//
export const OVERVIEW_CASES = [
    {type: 'overview', question: 'How does this system work?', expect: ['src/server.js', 'src/planner/index.js', 'src/index/indexer.js']},
    {type: 'overview', question: 'Give me an overview of how this codebase works end to end', expect: ['src/server.js', 'src/planner/index.js', 'src/index/indexer.js']},
    {type: 'overview', question: 'What happens end to end when I ask a question about my code?', expect: ['src/server.js', 'src/planner/index.js']}
];

// Overview cases for an external repo: EVAL_OVERVIEW_CASES points at a JSON
// array shaped like OVERVIEW_CASES, labeled for the EVAL_REPO_ROOT repo.
//
export async function loadOverviewCases() {
    if(!process.env.EVAL_OVERVIEW_CASES) {
        return process.env.EVAL_REPO_ROOT ? [] : OVERVIEW_CASES;
    }
    const loaded = await fs.readJson(path.resolve(process.env.EVAL_OVERVIEW_CASES));
    if(!Array.isArray(loaded)) {
        throw new Error(`EVAL_OVERVIEW_CASES did not contain an array of cases`);
    }
    return loaded;
}

// Cases for a repo OTHER than this one: EVAL_CASES points at a JSON array of
// [{type, question, expect: [paths], manifest?, expectShapes?}] labeled for the
// EVAL_REPO_ROOT repo. Defaults to the dogfood cases above. Shared by both
// evals so a question added for one is measured by both.
//
export async function loadEvalCases() {
    if(!process.env.EVAL_CASES) {
        return CASES;
    }
    const loaded = await fs.readJson(path.resolve(process.env.EVAL_CASES));
    if(!Array.isArray(loaded) || loaded.length === 0) {
        throw new Error(`EVAL_CASES did not contain a non-empty array of cases`);
    }
    return loaded;
}

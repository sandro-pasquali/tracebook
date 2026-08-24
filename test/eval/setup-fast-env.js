import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveTracebookPaths} from '../../src/util/tracebook-paths.js';

// Eval setup for the FAST regime: every LLM role on a small local model and
// enrichment off, so a full generation pass is minutes, not hours. The gated
// properties (verbatim excerpts, grounding precision, evidence routing,
// weak/dup callout leaks) are pipeline properties, and rate metrics only ever
// compare against baselines recorded under the SAME conditions — the model is
// part of the baseline's conditions, so fast-profile runs gate against
// fast-profile baselines (repo name tracebook-fast), never against the
// production-model ones.
//
//   GEN_EVAL_PER_TYPE=2 node --import ./test/eval/setup-fast-env.js test/eval/generation-eval.js
//
// The model comes from the team's own configuration: the "Eval fast model"
// field on /admin writes models.evalFast into ~/.tracebook/tracebook.config.json, and this
// setup reads it from there. EVAL_FAST_MODEL overrides per run; the literal
// fallback mirrors the default in src/util/config.js and only applies when no
// config file exists yet.
//
const FAST_MODEL = process.env.EVAL_FAST_MODEL || configuredEvalFastModel() || 'ollama/qwen3:4b-instruct';

function configuredEvalFastModel() {
    try {
        const raw = fs.readFileSync(resolveTracebookPaths({configPathOverride: null}).configPath, 'utf8');
        return JSON.parse(raw)?.models?.evalFast || '';
    } catch {
        return '';
    }
}

globalThis.__TRACEBOOK_CONFIG_PATH__ ||= path.join(
    os.tmpdir(),
    `tracebook-eval-fast-home-${process.pid}`,
    'tracebook.config.json'
);

const evalConfig = {
    version: 1,
    defaultRepoId: 'tracebook',
    repos: [{
        id: 'tracebook',
        name: 'Tracebook',
        path: process.cwd(),
        description: 'Eval checkout.'
    }],
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    tpmBudget: 100_000,
    logging: {level: 'silent', pretty: false},
    models: {
        exploration: FAST_MODEL,
        synthesis: FAST_MODEL,
        outline: FAST_MODEL,
        hyde: FAST_MODEL,
        annotation: FAST_MODEL
    },
    embeddings: {
        model: 'Xenova/all-MiniLM-L6-v2',
        dims: 384,
        batch: 32,
        numThreads: 0,
        dtype: 'fp32',
        queryPrefix: '',
        docPrefix: '',
        cacheCap: 512
    },
    dependencyDocs: {enabled: true},
    enrichment: {
        enabled: false,
        model: FAST_MODEL,
        maxOutputTokens: 220,
        maxInputChars: 12_000,
        timeoutMs: 30_000,
        concurrency: 2
    },
    rerank: {
        enabled: true,
        model: 'Xenova/bge-reranker-base',
        dtype: 'q8',
        candidates: 20,
        numThreads: 0
    },
    hyde: {enabled: false, timeoutMs: 3000, minSimilarity: 0.3},
    search: {semanticThreshold: 0.2, contentMax: 2500},
    fastPath: {similarity: 0.55, maxResults: 3, maxQuestionLen: 120},
    planner: {
        throttleMs: 0,
        explorationMaxSteps: 6,
        explorationMaxTokens: 4000,
        explorationWallMs: 18_000,
        componentThrottleMs: 0,
        componentMaxTokens: 2500,
        outlineMaxTokens: 1500,
        componentConcurrency: 2,
        componentWallMs: 120_000
    },
    annotations: {maxTokens: 900},
    trace: {componentLimit: 6},
    chunker: {smallFileLines: 80, windowLines: 80, windowOverlap: 10},
    watcher: {debounceMs: 25, optimizeDebounceMs: 25},
    tools: {
        readFileMaxLines: 200,
        listDirMaxEntries: 100,
        grepMaxMatches: 30,
        grepMaxLineLen: 220,
        grepTimeoutMs: 4000
    },
    governor: {windowMs: 60_000, initialTokenGuess: 6000},
    answerCache: {cap: 50, ttlMs: 300_000},
    traces: {ttlDays: 30, similarMinSimilarity: 0.55, findLimit: 3}
};

if(!fs.existsSync(globalThis.__TRACEBOOK_CONFIG_PATH__)) {
    fs.mkdirSync(path.dirname(globalThis.__TRACEBOOK_CONFIG_PATH__), {recursive: true});
    fs.writeFileSync(globalThis.__TRACEBOOK_CONFIG_PATH__, JSON.stringify(evalConfig, null, 2));
}

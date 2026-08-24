import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Eval setup for the ENRICHMENT-ON regime. The config loader resolves
// keychain -> config file -> defaults and never reads process env, so the only
// way to flip enrichment for an eval run is a config file with it enabled.
// Identical to test/setup-env.js except: enrichment is on with the production
// local model, a timeout that tolerates local generation speed, and gentle
// concurrency for a single Ollama instance.
//
//   node --import ./test/eval/setup-enriched-env.js test/eval/retrieval-eval.js
//
globalThis.__TRACEBOOK_CONFIG_PATH__ ||= path.join(
    os.tmpdir(),
    `tracebook-eval-enriched-home-${process.pid}`,
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
        exploration: 'ollama/qwen3-coder:30b',
        synthesis: 'ollama/qwen3-coder:30b',
        outline: 'ollama/qwen3-coder:30b',
        hyde: 'ollama/qwen3-coder:30b',
        annotation: 'ollama/qwen3-coder:30b'
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
        enabled: true,
        model: 'ollama/qwen3-coder:30b',
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

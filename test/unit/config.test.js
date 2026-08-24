import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

test('config imports with test defaults', async () => {
    const {config, defaultConfigValues} = await import('../../src/util/config.js');

    const defaultGenerativeModel = 'ollama/qwen3-coder-next:latest';
    const defaults = defaultConfigValues();

    assert.equal(defaults.EXPLORATION_MODEL, defaultGenerativeModel);
    assert.equal(defaults.SYNTHESIS_MODEL, defaultGenerativeModel);
    assert.equal(defaults.OUTLINE_MODEL, defaultGenerativeModel);
    assert.equal(defaults.HYDE_MODEL, defaultGenerativeModel);
    assert.equal(defaults.ANNOTATION_MODEL, defaultGenerativeModel);
    assert.equal(config.trace.componentLimit, 6);
    assert.equal(config.annotations.maxTokens, 900);
    assert.equal(config.fastPath.similarity, 0.55);
    assert.equal(config.search.semanticThreshold, 0.2);
});

test('legacy inert search threshold does not become an active semantic gate', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tracebook-config-legacy-threshold-'));
    const configPath = path.join(root, 'tracebook.config.json');
    writeFileSync(configPath, JSON.stringify({search: {threshold: 0.99}}));

    try {
        const result = spawnConfig(configPath, [
            'import assert from "node:assert/strict";',
            'const {config} = await import("./src/util/config.js");',
            'assert.equal(config.search.semanticThreshold, 0.2);'
        ].join(' '));

        assert.equal(result.status, 0, result.stderr);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test('config rejects unsafe component limits', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tracebook-config-invalid-'));
    const configPath = path.join(root, 'tracebook.config.json');
    writeFileSync(configPath, JSON.stringify({trace: {componentLimit: 11}}));

    try {
        const result = spawnConfig(configPath, 'await import("./src/util/config.js");');

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /TRACE_COMPONENT_LIMIT/v);
        assert.match(result.stderr, /between 1 and 10/v);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test('config file values populate non-secret runtime settings without env overrides', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tracebook-config-file-'));
    const configPath = path.join(root, 'tracebook.config.json');
    writeFileSync(configPath, JSON.stringify(fullConfig({
        ollamaBaseUrl: 'http://127.0.0.1:15555',
        tpmBudget: 123_456,
        logging: {level: 'warn', pretty: false},
        models: {
            exploration: 'ollama/file-exploration',
            synthesis: 'ollama/file-synthesis',
            outline: 'ollama/file-outline',
            hyde: 'ollama/file-hyde',
            annotation: 'ollama/file-annotation'
        },
        embeddings: {
            model: 'ollama/file-embedder',
            dims: 1024,
            batch: 12,
            numThreads: 2,
            dtype: 'q8',
            queryPrefix: 'query: ',
            docPrefix: 'doc: ',
            cacheCap: 333
        },
        dependencyDocs: {enabled: false},
        enrichment: {
            enabled: true,
            model: 'ollama/file-enrichment',
            maxOutputTokens: 111,
            maxInputChars: 9000,
            timeoutMs: 2500,
            concurrency: 2
        },
        rerank: {
            enabled: true,
            model: 'Xenova/file-reranker',
            dtype: 'fp16',
            candidates: 17,
            numThreads: 3
        },
        hyde: {enabled: true, timeoutMs: 2100, minSimilarity: 0.27},
        search: {semanticThreshold: 0.12, contentMax: 1300},
        fastPath: {similarity: 0.73, maxResults: 5, maxQuestionLen: 155},
        planner: {
            throttleMs: 11,
            explorationMaxSteps: 5,
            explorationMaxTokens: 3500,
            explorationWallMs: 10_000,
            componentThrottleMs: 22,
            componentMaxTokens: 1700,
            outlineMaxTokens: 1000,
            componentConcurrency: 1,
            componentWallMs: 65_000
        },
        annotations: {maxTokens: 750},
        trace: {componentLimit: 4},
        chunker: {smallFileLines: 55, windowLines: 110, windowOverlap: 13},
        watcher: {debounceMs: 210, optimizeDebounceMs: 950},
        tools: {
            readFileMaxLines: 181,
            listDirMaxEntries: 91,
            grepMaxMatches: 23,
            grepMaxLineLen: 181,
            grepTimeoutMs: 2600
        },
        governor: {windowMs: 46_000, initialTokenGuess: 4600},
        answerCache: {cap: 45, ttlMs: 121_000},
        traces: {ttlDays: 15, similarMinSimilarity: 0.63, findLimit: 5}
    })));

    try {
        const result = spawnConfig(configPath, [
            'import assert from "node:assert/strict";',
            'const {config} = await import("./src/util/config.js");',
            'assert.equal(config.ollamaBaseUrl, "http://127.0.0.1:15555");',
            'assert.equal(config.tpmBudget, 123456);',
            'assert.equal(config.logging.level, "warn");',
            'assert.equal(config.logging.pretty, false);',
            'assert.equal(config.models.exploration, "ollama/file-exploration");',
            'assert.equal(config.models.synthesis, "ollama/file-synthesis");',
            'assert.equal(config.models.outline, "ollama/file-outline");',
            'assert.equal(config.models.hyde, "ollama/file-hyde");',
            'assert.equal(config.models.annotation, "ollama/file-annotation");',
            'assert.equal(config.embeddings.model, "ollama/file-embedder");',
            'assert.equal(config.embeddings.dims, 1024);',
            'assert.equal(config.embeddings.batch, 12);',
            'assert.equal(config.embeddings.numThreads, 2);',
            'assert.equal(config.embeddings.dtype, "q8");',
            'assert.equal(config.embeddings.queryPrefix, "query: ");',
            'assert.equal(config.embeddings.docPrefix, "doc: ");',
            'assert.equal(config.embeddings.cacheCap, 333);',
            'assert.equal(config.dependencyDocs.enabled, false);',
            'assert.equal(config.enrichment.enabled, true);',
            'assert.equal(config.enrichment.model, "ollama/file-enrichment");',
            'assert.equal(config.enrichment.maxOutputTokens, 111);',
            'assert.equal(config.enrichment.maxInputChars, 9000);',
            'assert.equal(config.enrichment.timeoutMs, 2500);',
            'assert.equal(config.enrichment.concurrency, 2);',
            'assert.equal(config.rerank.enabled, true);',
            'assert.equal(config.rerank.model, "Xenova/file-reranker");',
            'assert.equal(config.rerank.dtype, "fp16");',
            'assert.equal(config.rerank.candidates, 17);',
            'assert.equal(config.rerank.numThreads, 3);',
            'assert.equal(config.hyde.enabled, true);',
            'assert.equal(config.hyde.timeoutMs, 2100);',
            'assert.equal(config.hyde.minSimilarity, 0.27);',
            'assert.equal(config.search.semanticThreshold, 0.12);',
            'assert.equal(config.search.contentMax, 1300);',
            'assert.equal(config.fastPath.similarity, 0.73);',
            'assert.equal(config.fastPath.maxResults, 5);',
            'assert.equal(config.fastPath.maxQuestionLen, 155);',
            'assert.equal(config.planner.throttleMs, 11);',
            'assert.equal(config.planner.explorationMaxSteps, 5);',
            'assert.equal(config.planner.explorationMaxTokens, 3500);',
            'assert.equal(config.planner.explorationWallMs, 10000);',
            'assert.equal(config.planner.componentThrottleMs, 22);',
            'assert.equal(config.planner.componentMaxTokens, 1700);',
            'assert.equal(config.planner.outlineMaxTokens, 1000);',
            'assert.equal(config.planner.componentConcurrency, 1);',
            'assert.equal(config.planner.componentWallMs, 65000);',
            'assert.equal(config.annotations.maxTokens, 750);',
            'assert.equal(config.trace.componentLimit, 4);',
            'assert.equal(config.chunker.smallFileLines, 55);',
            'assert.equal(config.chunker.windowLines, 110);',
            'assert.equal(config.chunker.windowOverlap, 13);',
            'assert.equal(config.watcher.debounceMs, 210);',
            'assert.equal(config.watcher.optimizeDebounceMs, 950);',
            'assert.equal(config.tools.readFileMaxLines, 181);',
            'assert.equal(config.tools.listDirMaxEntries, 91);',
            'assert.equal(config.tools.grepMaxMatches, 23);',
            'assert.equal(config.tools.grepMaxLineLen, 181);',
            'assert.equal(config.tools.grepTimeoutMs, 2600);',
            'assert.equal(config.governor.windowMs, 46000);',
            'assert.equal(config.governor.initialTokenGuess, 4600);',
            'assert.equal(config.answerCache.cap, 45);',
            'assert.equal(config.answerCache.ttlMs, 121000);',
            'assert.equal(config.traces.ttlDays, 15);',
            'assert.equal(config.traces.similarMinSimilarity, 0.63);',
            'assert.equal(config.traces.findLimit, 5);'
        ].join(' '));

        assert.equal(result.status, 0, result.stderr);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test('config requires credentials only for configured model providers', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tracebook-config-provider-'));
    const configPath = path.join(root, 'tracebook.config.json');
    writeFileSync(configPath, JSON.stringify(fullConfig({
        models: {
            exploration: 'ollama/test-exploration',
            synthesis: 'ollama/test-synthesis',
            outline: 'ollama/test-outline',
            hyde: 'ollama/test-hyde',
            annotation: 'anthropic/claude-3-5-sonnet-20241022'
        },
        hyde: {enabled: false},
        enrichment: {enabled: false, model: 'ollama/test-enrichment'}
    })));

    try {
        const result = spawnConfig(configPath, [
            'const {config, assertRuntimeConfigReady} = await import("./src/util/config.js");',
            'assertRuntimeConfigReady(config);'
        ].join(' '));

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /ANTHROPIC_API_KEY/v);
        assert.doesNotMatch(result.stderr, /MISTRAL_API_KEY/v);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test('config does not require OpenAI credentials when no OpenAI model is configured', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tracebook-config-local-'));
    const configPath = path.join(root, 'tracebook.config.json');
    writeFileSync(configPath, JSON.stringify(fullConfig({
        models: {
            exploration: 'ollama/test-exploration',
            synthesis: 'ollama/test-synthesis',
            outline: 'ollama/test-outline',
            hyde: 'ollama/test-hyde',
            annotation: 'ollama/test-annotation'
        },
        hyde: {enabled: false},
        enrichment: {enabled: false, model: 'ollama/test-enrichment'}
    })));

    try {
        const result = spawnConfig(configPath, 'const {config, assertRuntimeConfigReady} = await import("./src/util/config.js"); assertRuntimeConfigReady(config);');

        assert.equal(result.status, 0, result.stderr);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

function spawnConfig(configPath, script) {
    return spawnSync(process.execPath, [
        '--input-type=module',
        '--eval',
        `globalThis.__TRACEBOOK_CONFIG_PATH__ = ${JSON.stringify(configPath)}; ${script}`
    ], {
        cwd: process.cwd(),
        encoding: 'utf8'
    });
}

function fullConfig(overrides = {}) {
    return {
        version: 1,
        defaultRepoId: 'tracebook',
        repos: [{id: 'tracebook', name: 'Tracebook', path: process.cwd(), description: 'Test checkout.'}],
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        tpmBudget: 100_000,
        logging: {level: 'silent', pretty: false},
        models: {
            exploration: 'ollama/test-exploration',
            synthesis: 'ollama/test-synthesis',
            outline: 'ollama/test-outline',
            hyde: 'ollama/test-hyde',
            annotation: 'ollama/test-annotation'
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
            model: 'ollama/test-enrichment',
            maxOutputTokens: 220,
            maxInputChars: 12_000,
            timeoutMs: 8000,
            concurrency: 4
        },
        rerank: {
            enabled: false,
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
        traces: {ttlDays: 30, similarMinSimilarity: 0.55, findLimit: 3},
        ...overrides
    };
}

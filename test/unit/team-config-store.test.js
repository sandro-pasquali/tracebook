import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import {Hono} from 'hono';
import {config as baseRuntimeConfig} from '../../src/util/config.js';
import {createMemoryCredentialStore} from '../../src/util/credential-store.js';
import {createTeamConfigStore} from '../../src/server/team-config-store.js';
import {registerTeamRoutes} from '../../src/server/team-routes.js';

const runtimeConfig = {
    ...baseRuntimeConfig,
    credentials: {
        openaiApiKey: '',
        anthropicApiKey: '',
        googleApiKey: '',
        mistralApiKey: ''
    }
};

function testCredentialStore() {
    const credentialStore = createMemoryCredentialStore();
    credentialStore.deleteCredentials();
    return credentialStore;
}

test('team config store writes repo config, masks credentials, and preserves existing secrets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-team-config-'));
    const repoA = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-team-repo-a-'));
    const repoB = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-team-repo-b-'));
    const configPath = path.join(root, 'tracebook.config.json');
    const credentialStore = testCredentialStore();
    let reloads = 0;
    let savedEvents = 0;
    const store = createTeamConfigStore({
        projectRoot: root,
        configPath,
        runtimeConfig,
        credentialStore,
        reloadConfig() {
            reloads += 1;
        },
        onSaved() {
            savedEvents += 1;
        }
    });

    const initial = await store.publicConfig();

    assert.equal(initial.exists, false);
    assert.equal(initial.repos[0].id, 'tracebook');
    assert.equal(initial.repos[0].path, root);

    const saved = await store.save({
        repos: [
            {name: 'Alpha Repo', path: repoA},
            {id: 'not a valid id', name: 'Alpha Repo', path: repoB, description: 'Second checkout'}
        ],
        defaultRepoId: 'alpha-repo',
        credentials: {openaiApiKey: 'sk-test'},
        tpmBudget: 123_000,
        logging: {level: 'info', pretty: false},
        models: {exploration: 'ollama/llama3.1'},
        embeddings: {
            dims: 768,
            batch: 16,
            numThreads: 2,
            dtype: 'q8',
            queryPrefix: 'query: ',
            docPrefix: 'doc: ',
            cacheCap: 128
        },
        dependencyDocs: {enabled: false},
        enrichment: {
            enabled: false,
            model: 'openai/enrichment-test',
            maxOutputTokens: 128,
            maxInputChars: 8000,
            timeoutMs: 2000,
            concurrency: 2
        },
        rerank: {
            enabled: false,
            model: 'Xenova/test-reranker',
            dtype: 'fp16',
            candidates: 12,
            numThreads: 3
        },
        hyde: {enabled: false, timeoutMs: 1500, minSimilarity: 0.25},
        search: {semanticThreshold: 0.22, contentMax: 1200},
        fastPath: {similarity: 0.66, maxResults: 4, maxQuestionLen: 160},
        planner: {
            throttleMs: 10,
            explorationMaxSteps: 4,
            explorationMaxTokens: 3000,
            explorationWallMs: 9000,
            componentThrottleMs: 20,
            componentMaxTokens: 1500,
            outlineMaxTokens: 900,
            componentConcurrency: 1,
            componentWallMs: 60_000
        },
        annotations: {maxTokens: 700},
        trace: {componentLimit: 5},
        chunker: {smallFileLines: 60, windowLines: 100, windowOverlap: 12},
        watcher: {debounceMs: 200, optimizeDebounceMs: 900},
        tools: {
            readFileMaxLines: 180,
            listDirMaxEntries: 90,
            grepMaxMatches: 22,
            grepMaxLineLen: 180,
            grepTimeoutMs: 2500
        },
        governor: {windowMs: 45_000, initialTokenGuess: 4500},
        answerCache: {cap: 44, ttlMs: 120_000},
        traces: {ttlDays: 14, similarMinSimilarity: 0.62, findLimit: 4}
    });

    assert.equal(saved.exists, true);
    assert.deepEqual(saved.repos.map((repo) => repo.id), ['alpha-repo', 'alpha-repo-2']);
    assert.equal(saved.defaultRepoId, 'alpha-repo');
    assert.equal(saved.credentials.openaiApiKey, true);
    assert.equal(saved.credentials.anthropicApiKey, false);
    assert.match(saved.credentialFingerprints.openaiApiKey, /^sha256:[a-f0-9]{12}$/u);
    assert.equal(saved.credentialFingerprints.anthropicApiKey, '');
    assert.equal(saved.tpmBudget, 123_000);
    assert.equal(saved.logging.level, 'info');
    assert.equal(saved.logging.pretty, false);
    assert.equal(saved.models.exploration, 'ollama/llama3.1');
    assert.equal(saved.models.synthesis, runtimeConfig.models.synthesis);
    assert.equal(saved.embeddings.dims, 768);
    assert.equal(saved.embeddings.batch, 16);
    assert.equal(saved.embeddings.queryPrefix, 'query: ');
    assert.equal(saved.dependencyDocs.enabled, false);
    assert.equal(saved.enrichment.enabled, false);
    assert.equal(saved.enrichment.concurrency, 2);
    assert.equal(saved.rerank.model, 'Xenova/test-reranker');
    assert.equal(saved.hyde.minSimilarity, 0.25);
    assert.equal(saved.search.semanticThreshold, 0.22);
    assert.equal(saved.fastPath.maxResults, 4);
    assert.equal(saved.planner.componentConcurrency, 1);
    assert.equal(saved.annotations.maxTokens, 700);
    assert.equal(saved.trace.componentLimit, 5);
    assert.equal(saved.chunker.windowLines, 100);
    assert.equal(saved.watcher.optimizeDebounceMs, 900);
    assert.equal(saved.tools.grepTimeoutMs, 2500);
    assert.equal(saved.governor.initialTokenGuess, 4500);
    assert.equal(saved.answerCache.ttlMs, 120_000);
    assert.equal(saved.traces.findLimit, 4);
    assert.equal(reloads, 1);
    assert.equal(savedEvents, 1);

    const raw = await fs.readJson(configPath);
    assert.equal(raw.credentials, undefined);
    assert.equal(raw.repos[1].description, 'Second checkout');
    assert.equal(raw.embeddings.dtype, 'q8');
    assert.equal(raw.planner.explorationMaxSteps, 4);
    assert.equal(raw.traces.similarMinSimilarity, 0.62);
    assert.equal(credentialStore.readCredentials().openaiApiKey, 'sk-test');

    await store.save({
        credentials: {openaiApiKey: ''},
        models: {synthesis: 'openai/next-synthesis'}
    });

    const preserved = await fs.readJson(configPath);
    assert.equal(preserved.credentials, undefined);
    assert.equal(credentialStore.readCredentials().openaiApiKey, 'sk-test');
    assert.equal(preserved.models.synthesis, 'openai/next-synthesis');
    assert.equal(reloads, 2);
    assert.equal(savedEvents, 2);

    const cleared = await store.save({
        clearCredentials: ['openaiApiKey'],
        models: {synthesis: 'ollama/next-synthesis'}
    });

    assert.equal(cleared.credentials.openaiApiKey, false);
    assert.equal(cleared.credentialFingerprints.openaiApiKey, '');
    assert.equal(credentialStore.readCredentials().openaiApiKey, '');
    assert.equal(reloads, 3);
    assert.equal(savedEvents, 3);

    const resolved = await store.resolveRepo('alpha-repo-2');
    const checked = await store.checkRepo('alpha-repo-2');

    assert.equal(resolved.path, repoB);
    assert.equal(checked.ok, true);
});

test('team routes expose public config and validate admin saves', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-team-routes-'));
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-team-routes-repo-'));
    const configPath = path.join(root, 'tracebook.config.json');
    const credentialStore = testCredentialStore();
    const store = createTeamConfigStore({
        projectRoot: root,
        configPath,
        runtimeConfig,
        credentialStore,
        reloadConfig() {}
    });
    const app = new Hono();

    registerTeamRoutes(app, {
        teamConfig: store,
        routeLogger() {
            return {
                debug() {},
                info() {}
            };
        }
    });

    const initialResponse = await app.request('/api/team/config');
    const initial = await initialResponse.json();

    assert.equal(initialResponse.status, 200);
    assert.equal(initial.exists, false);
    assert.equal(initial.repos.length, 1);

    const invalidResponse = await app.request('/api/team/config', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({repos: []})
    });
    const invalid = await invalidResponse.json();

    assert.equal(invalidResponse.status, 400);
    assert.equal(invalid.error, 'invalid_team_config');

    const saveResponse = await app.request('/api/team/config', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            repos: [{name: 'Route Repo', path: repoRoot}],
            credentials: {openaiApiKey: 'sk-openai-test', anthropicApiKey: 'sk-ant-test'},
            hyde: {enabled: false}
        })
    });
    const saved = await saveResponse.json();

    assert.equal(saveResponse.status, 200);
    assert.equal(saved.exists, true);
    assert.equal(saved.repos[0].id, 'route-repo');
    assert.equal(saved.credentials.openaiApiKey, true);
    assert.equal(saved.credentials.anthropicApiKey, true);
    assert.match(saved.credentialFingerprints.openaiApiKey, /^sha256:[a-f0-9]{12}$/u);
    assert.match(saved.credentialFingerprints.anthropicApiKey, /^sha256:[a-f0-9]{12}$/u);
    assert.equal(saved.hyde.enabled, false);
    assert.equal((await fs.readJson(configPath)).credentials, undefined);
    assert.equal(credentialStore.readCredentials().openaiApiKey, 'sk-openai-test');

    const reposResponse = await app.request('/api/team/repos');
    const repos = await reposResponse.json();

    assert.equal(reposResponse.status, 200);
    assert.deepEqual(repos.repos.map((repo) => repo.id), ['route-repo']);
    assert.equal(repos.defaultRepoId, 'route-repo');

    const defaultsResponse = await app.request('/api/team/defaults/advanced');
    const {defaults} = await defaultsResponse.json();

    assert.equal(defaultsResponse.status, 200);
    assert.equal(defaults.search.semanticThreshold, 0.2);
    assert.equal(defaults.rerank.model, 'Xenova/bge-reranker-base');
    assert.equal(defaults.enrichment.model, 'ollama/qwen3-coder-next:latest');
    assert.equal(defaults.enrichment.timeoutMs, 30000);
    assert.equal(defaults.planner.explorationMaxSteps, 6);
    assert.equal(defaults.tools.readFileMaxLines, 200);
    assert.equal(defaults.answerCache.cap, 50);
    assert.equal(defaults.credentials, undefined);
    assert.equal(defaults.repos, undefined);
    assert.equal(defaults.models, undefined);
    assert.equal(defaults.embeddings, undefined);
});

test('team routes reject saved configs whose enabled model roles need missing credentials', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-team-route-invalid-'));
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-team-route-invalid-repo-'));
    const store = createTeamConfigStore({
        projectRoot: root,
        configPath: path.join(root, 'tracebook.config.json'),
        runtimeConfig,
        credentialStore: testCredentialStore(),
        reloadConfig() {}
    });
    const app = new Hono();

    registerTeamRoutes(app, {
        teamConfig: store,
        routeLogger() {
            return {
                debug() {},
                info() {},
                warn() {}
            };
        }
    });

    const response = await app.request('/api/team/config', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            repos: [{name: 'Local Repo', path: repoRoot}],
            models: {
                exploration: 'ollama/qwen3-coder:30b',
                synthesis: 'ollama/qwen3-coder:30b',
                outline: 'ollama/qwen3-coder:30b',
                annotation: 'ollama/qwen3-coder:30b',
                hyde: 'ollama/qwen3-coder:30b'
            },
            credentials: {openaiApiKey: ''},
            hyde: {enabled: true},
            enrichment: {enabled: true, model: 'openai/gpt-4o-mini'}
        })
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, 'invalid_runtime_config');
    assert.match(body.message, /OPENAI_API_KEY/u);
    assert.match(body.message, /ENRICHMENT_MODEL=openai\/gpt-4o-mini/u);
});

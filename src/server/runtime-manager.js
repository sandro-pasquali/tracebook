import fs from 'fs-extra';
import {MODELS_DIR} from '../util/models-dir.js';
import {assertRuntimeConfigReady} from '../util/config.js';
import {getOllamaBaseUrl} from '../util/model.js';
import {ensureOllamaModels, requiredOllamaModels, requiredToolModels} from '../util/ollama-preflight.js';
import {createAnswerCache} from '../util/answer-cache.js';
import {createDegradedTracker} from '../util/degraded.js';
import {createEmbedder} from '../index/embedder.js';
import {createEnricher} from '../index/enrichment.js';
import {createGovernor} from '../util/governor.js';
import {createIndexer} from '../index/indexer.js';
import {createReranker} from '../index/reranker.js';
import {createStore} from '../index/store.js';
import {createTraceIndexer} from '../index/trace-indexer.js';
import {createWatcher} from '../index/watcher.js';
import {createStoryStore} from '../story-store.js';
import {createChangeBriefStore} from '../change-brief/store.js';
import {createTools} from '../tools/index.js';
import {createTraceStore} from '../trace-store.js';
import {clampProgressRatio, indexingProgressMessage, indexingProgressRatio, isActiveIndexProgress, normalizeRevision, progressRatio} from './progress-math.js';

const RUNTIME_KEY_PREFIX = 'tracebook.runtime';
const RUNTIME_PROGRESS_KEY_PREFIX = 'tracebook.runtime.progress';
const STORAGE_KEY_PREFIX = 'tracebook.storage';

const INITIAL_PROGRESS = {
    state: 'idle',
    stage: 'idle',
    message: 'Runtime has not started.',
    startedAt: null,
    finishedAt: null,
    filesProcessed: 0,
    totalFiles: 0,
    sourceFiles: 0,
    dependencyFiles: 0,
    progressRatio: 0
};

export function createRuntimeManager({config, targetRoot, traceRoot, storyRoot, changeBriefRoot, indexRoot, include, exclude, log, indexLog, instanceKey = 'default', createRuntimeImpl = null}) {
    const runtimeKey = Symbol.for(`${RUNTIME_KEY_PREFIX}.${instanceKey}`);
    const runtimeProgressKey = Symbol.for(`${RUNTIME_PROGRESS_KEY_PREFIX}.${instanceKey}`);
    const storageKey = Symbol.for(`${STORAGE_KEY_PREFIX}.${instanceKey}`);
    const legacyRuntimeKey = Symbol.for(RUNTIME_KEY_PREFIX);
    const legacyProgressKey = Symbol.for(RUNTIME_PROGRESS_KEY_PREFIX);
    const legacyStorageKey = Symbol.for(STORAGE_KEY_PREFIX);
    const services = {};
    const degraded = createDegradedTracker({log: indexLog});
    let runtimeResolved = null;
    let runtimeProgress = globalThis[runtimeProgressKey] || globalThis[legacyProgressKey] || {...INITIAL_PROGRESS};
    globalThis[runtimeProgressKey] = runtimeProgress;

    async function ensureRuntime() {
        if(hasRuntimeServices()) {
            return services;
        }
        const runtime = await getRuntime();
        Object.assign(services, runtime);
        if(!services.briefs) {
            const storage = await getStorage();
            services.briefs = storage.briefs;
            if(runtime && typeof runtime === 'object') {
                runtime.briefs = storage.briefs;
            }
        }
        return services;
    }

    async function ensureStorage() {
        if(services.traces && services.stories && services.briefs) {
            return services;
        }
        const storage = await getStorage();
        services.traces = storage.traces;
        services.stories = storage.stories;
        services.briefs = storage.briefs;
        return services;
    }

    function readyRuntime() {
        const current = runtimeGlobal();
        if(!current) {
            return null;
        }
        if(typeof current.then !== 'function') {
            return current;
        }
        return runtimeResolved;
    }

    function startRuntime() {
        return getRuntime();
    }

    function startIfIdle() {
        if(runtimeProgress.state === 'error') {
            return Promise.resolve(null);
        }
        if(runtimeProgress.state !== 'ready' && runtimeProgress.state !== 'initializing') {
            setRuntimeProgress({
                state: 'initializing',
                stage: 'starting',
                message: 'Starting the local code search index.',
                startedAt: Date.now(),
                finishedAt: null,
                error: null,
                filesProcessed: 0,
                totalFiles: 0,
                sourceFiles: 0,
                dependencyFiles: 0,
                progressRatio: 0.02
            });
        }
        return getRuntime();
    }

    function snapshot() {
        const now = Date.now();
        const totalFiles = Math.max(0, Number(runtimeProgress.totalFiles) || 0);
        const filesProcessed = Math.max(0, Number(runtimeProgress.filesProcessed) || 0);
        const explicitRatio = runtimeProgress.progressRatio;
        const hasExplicitRatio = typeof explicitRatio === 'number' && Number.isFinite(explicitRatio);
        return {
            ...runtimeProgress,
            filesProcessed,
            totalFiles,
            progressRatio: hasExplicitRatio
                ? clampProgressRatio(explicitRatio)
                : progressRatio(filesProcessed, totalFiles),
            sourceRevision: currentSourceRevision(),
            degraded: degraded.snapshot(),
            elapsedMs: runtimeProgress.startedAt ? (runtimeProgress.finishedAt || now) - runtimeProgress.startedAt : null
        };
    }

    // Client-facing variant of snapshot(): drops server-internal fields and
    // scrubs the absolute repository path out of human-readable messages
    // (replaced with the repo folder name, which stays actionable in the UI).
    //
    function snapshotForClient() {
        const {targetRoot: snapshotTargetRoot, ...snap} = snapshot();
        const absoluteRoot = String(snapshotTargetRoot || targetRoot || '');
        if(!absoluteRoot) {
            return snap;
        }
        const repoName = absoluteRoot.split('/').findLast(Boolean) || 'repository';
        for(const field of ['message', 'error']) {
            if(typeof snap[field] === 'string' && snap[field].includes(absoluteRoot)) {
                snap[field] = snap[field].split(absoluteRoot).join(repoName);
            }
        }
        return snap;
    }

    function current() {
        return services;
    }

    function currentSourceRevision() {
        return normalizeRevision(services.indexer?.sourceState?.().sourceRevision);
    }

    // Release the runtime and every resource it holds. The globals are cleared
    // synchronously so a concurrent request builds a fresh runtime immediately;
    // the old resources finish tearing down in the returned promise, which
    // callers can await (shutdown) or fire-and-forget (config save, HMR).
    //
    function dispose() {
        const runtime = runtimeGlobal();
        const teardown = runtime
            ? Promise.resolve(runtime)
                .then((ready) => disposeRuntimeServices(ready))
                .catch(() => {})
            : Promise.resolve();
        delete globalThis[runtimeKey];
        delete globalThis[runtimeProgressKey];
        delete globalThis[storageKey];
        runtimeResolved = null;
        runtimeProgress = {...INITIAL_PROGRESS};
        for(const key of Object.keys(services)) {
            delete services[key];
        }
        return teardown;
    }

    // Ordered teardown: the watcher stops producing new index work first, the
    // store close then drains its write chain and releases the LanceDB
    // connection, and finally the ONNX sessions free their thread pools.
    //
    async function disposeRuntimeServices(ready) {
        const steps = [
            ['watcher', () => ready?.watcher?.close?.()],
            ['store', () => ready?.store?.close?.()],
            ['embedder', () => ready?.embedder?.dispose?.()],
            ['reranker', () => ready?.reranker?.dispose?.()]
        ];
        for(const [service, step] of steps) {
            try {
                await step();
            } catch(err) {
                log.warn({err, service}, 'failed to dispose runtime service');
            }
        }
    }

    function hasRuntimeServices() {
        return services.governor &&
            services.traces &&
            services.stories &&
            services.briefs &&
            services.embedder &&
            services.store &&
            services.indexer &&
            services.traceIndexer &&
            services.answerCache &&
            services.tools;
    }

    function getStorage() {
        const current = storageGlobal();
        if(current) {
            return ensureStorageShape(current);
        }

        const created = createStorage().catch((err) => {
            delete globalThis[storageKey];
            throw err;
        });
        globalThis[storageKey] = created;
        return created;
    }

    async function ensureStorageShape(storage) {
        if(storage.briefs) {
            return storage;
        }
        const briefs = createChangeBriefStore({root: changeBriefRoot});
        await briefs.init();
        storage.briefs = briefs;
        return storage;
    }

    // After a failed init, further attempts are refused for the configured
    // backoff window so a persistent misconfiguration cannot trigger a full
    // re-init (model pulls, re-index) on every incoming request. An admin
    // config save clears the window via dispose().
    //
    function runtimeErrorBackoffRemainingMs() {
        if(runtimeProgress.state !== 'error' || !runtimeProgress.errorAt) {
            return 0;
        }
        const backoffMs = config.runtime?.retryBackoffMs ?? 30000;
        return Math.max(0, runtimeProgress.errorAt + backoffMs - Date.now());
    }

    function getRuntime() {
        const current = runtimeGlobal();
        if(current) {
            if(typeof current.then !== 'function') {
                adoptReadyRuntime(current);
            } else {
                current.then((ready) => adoptReadyRuntime(ready), () => {});
            }
            return current;
        }

        const backoffRemainingMs = runtimeErrorBackoffRemainingMs();
        if(backoffRemainingMs > 0) {
            const err = new Error(runtimeProgress.error || 'Runtime initialization failed.');
            err.code = 'runtime_init_backoff';
            err.retryInMs = backoffRemainingMs;
            return Promise.reject(err);
        }
        if(runtimeProgress.state === 'error') {
            setRuntimeProgress({
                state: 'initializing',
                stage: 'starting',
                message: 'Retrying runtime initialization.',
                startedAt: Date.now(),
                finishedAt: null,
                error: null,
                errorAt: null
            });
        }

        const created = (createRuntimeImpl || createRuntime)().catch((err) => {
            setRuntimeProgress({
                state: 'error',
                stage: 'error',
                message: err?.message || 'Runtime initialization failed.',
                error: err?.message || String(err),
                errorAt: Date.now(),
                finishedAt: Date.now()
            });
            delete globalThis[runtimeKey];
            runtimeResolved = null;
            throw err;
        });
        created.then((ready) => adoptReadyRuntime(ready), () => {});
        globalThis[runtimeKey] = created;
        return created;
    }

    function adoptReadyRuntime(runtime) {
        if(!runtime || runtimeResolved === runtime) {
            return;
        }
        Object.assign(services, runtime);
        runtimeResolved = runtime;
        setRuntimeProgress({
            state: 'ready',
            stage: 'ready',
            message: 'Code index ready.',
            finishedAt: Date.now(),
            progressRatio: 1,
            sourceRevision: currentSourceRevision(),
            indexFingerprint: runtime.indexer?.indexFingerprint || null
        });
    }

    async function createStorage() {
        const traces = createTraceStore({root: traceRoot});
        await traces.init();
        const stories = createStoryStore({root: storyRoot});
        await stories.init();
        const briefs = createChangeBriefStore({root: changeBriefRoot});
        await briefs.init();
        return {traces, stories, briefs};
    }

    // When any model uses the "ollama/" provider, make sure the Ollama daemon is
    // up and every required model is pulled before we try to use it. A failure
    // throws here and surfaces as a runtime error with actionable instructions,
    // rather than dying later at first inference. No-op for cloud/HF-only setups.
    //
    async function ensureLocalModels(startedAt) {
        const models = requiredOllamaModels(config);
        if(models.length === 0) {
            return;
        }
        setRuntimeProgress({
            state: 'initializing',
            stage: 'pulling_models',
            message: 'Preparing local models via Ollama...',
            startedAt,
            finishedAt: null,
            error: null,
            progressRatio: 0.03
        });
        await ensureOllamaModels({
            models,
            toolModels: requiredToolModels(config),
            baseUrl: getOllamaBaseUrl(),
            log: indexLog,
            onStatus: (message) => setRuntimeProgress({
                state: 'initializing',
                stage: 'pulling_models',
                message,
                progressRatio: 0.03
            })
        });
    }

    // Map transformers.js model-download progress to the runtime status line so the
    // splash reports HF model downloads (not just file indexing). Throttled.
    //
    function modelDownloadReporter({stage, label}) {
        let lastPct = -1;
        let lastEmit = 0;
        return (info) => {
            if(!info || info.status !== 'progress') {
                return;
            }
            const pct = Math.floor(Number(info.progress) || 0);
            const now = Date.now();
            if(pct === lastPct && now - lastEmit < 400) {
                return;
            }
            lastPct = pct;
            lastEmit = now;
            setRuntimeProgress({stage, message: `Downloading ${label} — ${pct}%`});
        };
    }

    async function assertTargetRoot() {
        let stat;
        try {
            stat = await fs.stat(targetRoot);
        } catch {
            throw new Error(`Configured repository does not exist: ${targetRoot}`);
        }
        if(!stat.isDirectory()) {
            throw new Error(`Configured repository is not a directory: ${targetRoot}`);
        }
    }

    async function createRuntime() {
        const startedAt = Date.now();
        assertRuntimeConfigReady(config);
        // Ensure the shared HuggingFace model cache exists (postinstall does this
        // too, but is skipped under --ignore-scripts / some CI). transformers.js
        // is already pointed here via util/models-dir.js.
        //
        await fs.ensureDir(MODELS_DIR);
        await ensureLocalModels(startedAt);
        await assertTargetRoot();
        const {governor, traces, stories, briefs} = await initializeRuntimeStorage(startedAt);
        const {embedder, store, indexer, indexStats} = await initializeRuntimeIndex();
        const watcher = startRuntimeWatcher({indexer});
        const traceIndexer = createRuntimeTraceIndexer({store, embedder});
        const answerCache = createAnswerCache();
        const reranker = createReranker({
            model: config.rerank.model,
            dtype: config.rerank.dtype,
            candidates: config.rerank.candidates,
            enabled: config.rerank.enabled,
            onProgress: modelDownloadReporter({stage: 'warming_models', label: config.rerank.model}),
            log: indexLog,
            onDegraded: degraded.note
        });
        const tools = createRuntimeTools({embedder, store, reranker});

        // Warm the models before reporting ready, so the first query does not pay
        // a cold model load. Best-effort: warm-up failure must not block runtime.
        setRuntimeProgress({
            state: 'initializing',
            stage: 'warming_models',
            message: 'Loading models...',
            progressRatio: 0.98
        });
        try {
            await embedder.warmup?.();
            await reranker?.warmup?.();
        } catch(err) {
            indexLog.warn({err}, 'model warm-up failed (non-fatal)');
        }

        markRuntimeReady({startedAt, indexStats});

        return {
            governor,
            traces,
            stories,
            briefs,
            embedder,
            store,
            indexer,
            watcher,
            traceIndexer,
            answerCache,
            tools,
            reranker,
            degraded
        };
    }

    async function initializeRuntimeStorage(startedAt) {
        setRuntimeProgress({
            state: 'initializing',
            stage: 'storage',
            message: 'Preparing local trace and story storage.',
            startedAt,
            finishedAt: null,
            error: null,
            filesProcessed: 0,
            totalFiles: 0,
            sourceFiles: 0,
            dependencyFiles: 0,
            progressRatio: 0.04
        });
        const governor = createGovernor({budget: config.tpmBudget});
        const storage = await getStorage();
        const traces = storage.traces;
        const stories = storage.stories;
        const briefs = storage.briefs;
        return {governor, traces, stories, briefs};
    }

    async function initializeRuntimeIndex() {
        setRuntimeProgress({
            state: 'initializing',
            stage: 'index_open',
            message: 'Opening the code search index.',
            progressRatio: 0.08
        });
        const embedder = createEmbedder({
            onProgress: modelDownloadReporter({stage: 'embedding_model', label: config.embeddings.model})
        });
        const store = await createStore({
            root: indexRoot,
            dims: embedder.dims,
            // Everything that changes the vectors an embedding setup produces.
            // A mismatch against the stored meta rebuilds the index instead of
            // failing mid-write or drifting the trace vector space.
            //
            fingerprint: {
                provider: embedder.provider,
                model: embedder.model,
                dims: embedder.dims,
                dtype: embedder.dtype,
                docPrefix: embedder.docPrefix
            },
            log: indexLog,
            onDegraded: degraded.note
        });
        const enricher = createEnricher({
            model: config.enrichment.model,
            enabled: config.enrichment.enabled,
            maxOutputTokens: config.enrichment.maxOutputTokens,
            maxInputChars: config.enrichment.maxInputChars,
            timeoutMs: config.enrichment.timeoutMs,
            onDegraded: degraded.note
        });
        const indexer = createIndexer({
            root: targetRoot,
            include,
            exclude,
            embedder,
            store,
            enricher,
            indexDependencies: config.dependencyDocs.enabled
        });

        await warmIndexingEmbedder(embedder);
        const indexStats = await indexRuntimeRepository({embedder, indexer});
        return {embedder, store, indexer, indexStats};
    }

    async function warmIndexingEmbedder(embedder) {
        setRuntimeProgress({
            state: 'initializing',
            stage: 'embedding_model',
            message: 'Loading the local embedding model.',
            progressRatio: 0.12
        });
        await embedder.warmup?.();
    }

    async function indexRuntimeRepository({embedder, indexer}) {
        indexLog.info({targetRoot, provider: embedder.provider, model: embedder.model}, 'indexing started');
        let lastProgressAt = 0;
        let filesProcessed = 0;
        let indexedFiles = 0;
        let skippedFiles = 0;
        let removedFiles = 0;
        setRuntimeProgress({
            state: 'initializing',
            stage: 'indexing',
            message: 'Indexing the repository for code search.',
            targetRoot,
            provider: embedder.provider,
            model: embedder.model,
            filesProcessed: 0,
            indexedFiles: 0,
            skippedFiles: 0,
            removedFiles: 0,
            totalFiles: 0,
            sourceFiles: 0,
            dependencyFiles: 0,
            lastPath: null,
            lastProgressAt: Date.now(),
            progressRatio: 0.14
        });
        const indexStats = await indexer.indexAll({
            onProgress: (ev) => {
                const now = Date.now();
                if(ev.kind === 'discovered') {
                    const discoveredTotal = Math.max(0, Number(ev.totalFiles) || 0);
                    setRuntimeProgress({
                        state: 'initializing',
                        stage: 'indexing',
                        message: 'Indexing the repository for code search.',
                        targetRoot,
                        provider: embedder.provider,
                        model: embedder.model,
                        filesProcessed: 0,
                        indexedFiles: 0,
                        skippedFiles: 0,
                        removedFiles: 0,
                        totalFiles: discoveredTotal,
                        sourceFiles: Math.max(0, Number(ev.sourceFiles ?? ev.files) || 0),
                        dependencyFiles: Math.max(0, Number(ev.dependencyFiles) || 0),
                        lastPath: null,
                        lastProgressAt: now,
                        progressRatio: indexingProgressRatio(0, discoveredTotal)
                    });
                    return;
                }
                if(ev.kind === 'enriching') {
                    const done = Math.max(0, Number(ev.done) || 0);
                    // The done:0 start event always flushes (clears the stale prepare
                    // frame); the rest throttle like every other phase.
                    //
                    if(done > 0 && now - lastProgressAt < 250) {
                        return;
                    }
                    lastProgressAt = now;
                    const total = Math.max(0, Number(ev.total) || 0);
                    setRuntimeProgress({
                        state: 'initializing',
                        stage: 'indexing',
                        message: total > 0
                            ? `Generating file descriptions (${done} / ${total}).`
                            : 'Generating file descriptions.',
                        lastPath: null,
                        lastProgressAt: now,
                        filesProcessed,
                        indexedFiles,
                        skippedFiles,
                        removedFiles,
                        totalFiles: runtimeProgress.totalFiles,
                        sourceFiles: runtimeProgress.sourceFiles,
                        dependencyFiles: runtimeProgress.dependencyFiles,
                        progressRatio: indexingProgressRatio(filesProcessed, runtimeProgress.totalFiles)
                    });
                    return;
                }
                if(ev.kind === 'embedding') {
                    if(now - lastProgressAt < 250) {
                        return;
                    }
                    lastProgressAt = now;
                    const total = Math.max(0, Number(ev.total) || 0);
                    const done = Math.max(0, Number(ev.done) || 0);
                    setRuntimeProgress({
                        state: 'initializing',
                        stage: 'indexing',
                        message: total > 0
                            ? `Embedding ${done} / ${total} chunks for code search.`
                            : 'Embedding chunks for code search.',
                        lastPath: null,
                        lastProgressAt: now,
                        filesProcessed,
                        indexedFiles,
                        skippedFiles,
                        removedFiles,
                        totalFiles: runtimeProgress.totalFiles,
                        sourceFiles: runtimeProgress.sourceFiles,
                        dependencyFiles: runtimeProgress.dependencyFiles,
                        progressRatio: indexingProgressRatio(filesProcessed, runtimeProgress.totalFiles)
                    });
                    return;
                }
                if(isActiveIndexProgress(ev)) {
                    if(now - lastProgressAt < 250) {
                        return;
                    }
                    lastProgressAt = now;
                    setRuntimeProgress({
                        state: 'initializing',
                        stage: 'indexing',
                        message: indexingProgressMessage(ev),
                        lastPath: ev.rel,
                        lastProgressAt: now,
                        filesProcessed,
                        indexedFiles,
                        skippedFiles,
                        removedFiles,
                        totalFiles: runtimeProgress.totalFiles,
                        sourceFiles: runtimeProgress.sourceFiles,
                        dependencyFiles: runtimeProgress.dependencyFiles,
                        progressRatio: indexingProgressRatio(filesProcessed, runtimeProgress.totalFiles)
                    });
                    return;
                }
                filesProcessed++;
                if(ev.indexed) {
                    indexedFiles++;
                } else if(ev.skipped) {
                    skippedFiles++;
                } else if(ev.removed) {
                    removedFiles++;
                }
                if(now - lastProgressAt < 250) {
                    return;
                }
                lastProgressAt = now;
                setRuntimeProgress({
                    state: 'initializing',
                    stage: 'indexing',
                    message: 'Indexing the repository for code search.',
                    lastPath: ev.rel,
                    lastProgressAt: now,
                    filesProcessed,
                    indexedFiles,
                    skippedFiles,
                    removedFiles,
                    totalFiles: runtimeProgress.totalFiles,
                    sourceFiles: runtimeProgress.sourceFiles,
                    dependencyFiles: runtimeProgress.dependencyFiles,
                    progressRatio: indexingProgressRatio(filesProcessed, runtimeProgress.totalFiles)
                });
            }
        });
        const totalFiles = indexStats.files + indexStats.dependencyFiles + indexStats.removedFiles;
        setRuntimeProgress({
            state: 'initializing',
            stage: 'watcher',
            message: 'Starting the file watcher.',
            filesProcessed: totalFiles,
            totalFiles,
            sourceFiles: indexStats.files,
            dependencyFiles: indexStats.dependencyFiles,
            progressRatio: 0.96,
            indexedFiles: indexStats.indexedFiles,
            skippedFiles: indexStats.skippedFiles,
            removedFiles: indexStats.removedFiles,
            chunksInStore: indexStats.chunksInStore,
            indexFingerprint: indexStats.indexFingerprint,
            durationMs: indexStats.durationMs
        });
        indexLog.info({
            targetRoot,
            provider: embedder.provider,
            model: embedder.model,
            totalChunksIndexed: indexStats.totalChunksIndexed,
            indexedFiles: indexStats.indexedFiles,
            skippedFiles: indexStats.skippedFiles,
            durationMs: indexStats.durationMs,
            chunksInStore: indexStats.chunksInStore
        }, 'indexing completed');

        return indexStats;
    }

    function startRuntimeWatcher({indexer}) {
        return createWatcher({
            root: targetRoot,
            include,
            exclude,
            indexer,
            onEvent: (ev) => {
                if(ev.kind === 'indexed' && ev.indexed) {
                    indexLog.info({path: ev.rel, chunks: ev.chunks}, 'file reindexed');
                } else if(ev.kind === 'removed') {
                    indexLog.info({path: ev.rel}, 'file removed from index');
                } else if(ev.kind === 'error') {
                    indexLog.error({path: ev.rel, err: ev}, 'watcher indexing error');
                }
            }
        });
    }

    function createRuntimeTraceIndexer({store, embedder}) {
        const traceIndexer = createTraceIndexer({store, embedder});
        traceIndexer.prune().catch((err) => indexLog.warn({err}, 'trace index prune failed'));
        return traceIndexer;
    }

    function createRuntimeTools({embedder, store, reranker}) {
        return createTools({
            embedder,
            store,
            reranker,
            root: targetRoot,
            include,
            exclude
        });
    }

    function markRuntimeReady({startedAt, indexStats}) {
        setRuntimeProgress({
            state: 'ready',
            stage: 'ready',
            message: 'Code index ready.',
            finishedAt: Date.now(),
            durationMs: Date.now() - startedAt,
            indexedFiles: indexStats.indexedFiles,
            skippedFiles: indexStats.skippedFiles,
            removedFiles: indexStats.removedFiles,
            chunksInStore: indexStats.chunksInStore,
            indexFingerprint: indexStats.indexFingerprint,
            filesProcessed: indexStats.files + indexStats.dependencyFiles + indexStats.removedFiles,
            totalFiles: indexStats.files + indexStats.dependencyFiles + indexStats.removedFiles,
            sourceFiles: indexStats.files,
            dependencyFiles: indexStats.dependencyFiles,
            corpusCoverage: indexStats.coverage,
            progressRatio: 1
        });
    }

    function setRuntimeProgress(update) {
        runtimeProgress = {
            ...runtimeProgress,
            ...update,
            updatedAt: Date.now()
        };
        globalThis[runtimeProgressKey] = runtimeProgress;
    }

    function runtimeGlobal() {
        return globalThis[runtimeKey] || globalThis[legacyRuntimeKey];
    }

    function storageGlobal() {
        return globalThis[storageKey] || globalThis[legacyStorageKey];
    }

    return {
        current,
        currentSourceRevision,
        dispose,
        ensureRuntime,
        ensureStorage,
        readyRuntime,
        snapshot,
        snapshotForClient,
        startIfIdle,
        startRuntime
    };
}

import {appConfigPath, config, reloadConfigFromDisk, tracebookPaths} from './util/config.js';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {serveStatic} from '@hono/node-server/serve-static';
import {streamSSE} from 'hono/streaming';
import {DEFAULT_INDEX_EXCLUDE, DEFAULT_INDEX_INCLUDE} from './index/file-patterns.js';
import {childLogger} from './util/logger.js';
import {createRepoIgnore} from './util/repo-ignore.js';
import {
    emptyQuerySchema,
    sourceFileTokenParamsSchema,
    withRequest
} from './server/contracts.js';
import {registerAskRoute} from './server/ask-route.js';
import {registerChangeBriefRoutes} from './server/change-brief-routes.js';
import {registerFixMermaidRoute} from './server/fix-mermaid-route.js';
import {createRuntimeManager} from './server/runtime-manager.js';
import {createSourceFileService} from './server/source-files.js';
import {registerStoryRoutes} from './server/story-routes.js';
import {createTeamConfigStore} from './server/team-config-store.js';
import {registerTeamRoutes} from './server/team-routes.js';
import {registerTraceRoutes} from './server/trace-routes.js';
import {enforceHttpBoundary} from './server/http-boundary.js';
import {STORY_ID_RE} from './util/input-schemas.js';

const here = import.meta.dirname;
const projectRoot = path.resolve(here, '..');
const log = childLogger({module: 'server'});
const indexLog = childLogger({module: 'indexer'});

const INDEX_INCLUDE = DEFAULT_INDEX_INCLUDE;
const INDEX_EXCLUDE = DEFAULT_INDEX_EXCLUDE;
const runtimeContexts = new Map();
const teamConfig = createTeamConfigStore({
    projectRoot,
    configPath: appConfigPath(),
    runtimeConfig: config,
    reloadConfig: reloadConfigFromDisk,
    onSaved: disposeRuntimeContexts
});

if(import.meta.hot) {
    import.meta.hot.dispose(() => {
        log.debug('preserving runtime across HMR reload');
    });
}

const app = new Hono();

app.use('*', enforceHttpBoundary);

app.use('*', async (c, next) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const requestLog = log.child({
        requestId,
        method: c.req.method,
        path: c.req.path
    });
    c.set('logger', requestLog);
    c.set('requestId', requestId);
    requestLog.debug('request started');
    try {
        await next();
    } catch(err) {
        requestLog.error({err, durationMs: Date.now() - startedAt}, 'request failed');
        throw err;
    } finally {
        requestLog.info({
            status: c.res?.status,
            durationMs: Date.now() - startedAt
        }, 'request completed');
    }
});

app.onError((err, c) => {
    const requestLog = c.get('logger') || log;
    requestLog.error({err}, 'unhandled route error');
    return c.json({error: 'server_error'}, 500);
});

registerTeamRoutes(app, {
    teamConfig,
    routeLogger
});

app.get('/api/health', withRequest({query: emptyQuerySchema}, async (c) => {
    const requestLog = routeLogger(c);
    const {runtime, repo} = await runtimeContext(c);
    const services = runtime.current();
    const snap = await services.indexer.snapshot();
    // Enrichment failures are swallowed per-file by design, so the health payload
    // is where a silently-failing enrichment model becomes visible.
    //
    if(snap.enrichment?.enabled && snap.enrichment.attempted > 0 && snap.enrichment.succeeded / snap.enrichment.attempted < 0.9) {
        requestLog.warn({enrichment: snap.enrichment}, 'enrichment coverage is low — the enrichment model may be failing silently');
    }
    requestLog.debug({
        indexedChunks: snap.chunksInStore,
        indexedFiles: snap.files,
        tpmBudget: config.tpmBudget
    }, 'health snapshot');
    return c.json({
        ok: true,
        repo,
        targetRoot: repo.path,
        indexedChunks: snap.chunksInStore,
        indexedFiles: snap.files,
        enrichment: snap.enrichment,
        lastIndexedAt: snap.lastIndexedAt,
        sourceRevision: snap.sourceRevision,
        indexFingerprint: snap.indexFingerprint,
        corpusCoverage: snap.coverage,
        tpmBudget: config.tpmBudget,
        governor: services.governor.snapshot()
    });
}, {routeLogger, ready: requireRuntime}));

app.get('/api/runtime/status', withRequest({query: emptyQuerySchema}, async (c) => {
    const setupRequired = await requireTeamSetup(c, {runtimeStatus: true});
    if(setupRequired) {
        return setupRequired;
    }
    const {runtime} = await runtimeContext(c);
    return c.json({runtime: clientRuntimeSnapshot(runtime)});
}, {routeLogger}));

app.post('/api/runtime/start', withRequest({query: emptyQuerySchema}, async (c) => {
    const requestLog = routeLogger(c);
    const setupRequired = await requireTeamSetup(c, {runtimeStatus: true});
    if(setupRequired) {
        return setupRequired;
    }
    const {runtime} = await runtimeContext(c);
    runtime.startIfIdle().catch((err) => requestLog.warn({err}, 'runtime warmup failed'));
    return c.json({runtime: clientRuntimeSnapshot(runtime)});
}, {routeLogger}));

app.get('/api/codebase', withRequest({query: emptyQuerySchema}, async (c) => {
    const requestLog = routeLogger(c);
    const {runtime, repo} = await runtimeContext(c);
    const files = await runtime.current().indexer.listFiles();
    requestLog.debug({fileCount: files.length}, 'codebase file list loaded');
    return c.json({root: repo.path, repo, count: files.length, files});
}, {routeLogger, ready: requireRuntime}));

app.get('/api/source-file/:token', withRequest({
    params: sourceFileTokenParamsSchema,
    query: emptyQuerySchema
}, async (c, {params}) => {
    const setupRequired = await requireTeamSetup(c);
    if(setupRequired) {
        return setupRequired;
    }
    const {sourceFiles} = await runtimeContext(c);
    const relPath = sourceFiles.decodeSourcePathToken(params.token);
    if(relPath === null) {
        return c.text('bad_source_token', 400);
    }
    return sourceFiles.serveSourceFile(c, relPath);
}, {
    routeLogger,
    invalidLog: 'invalid source file token',
    invalidRequestResponse: (c) => c.text('bad_source_token', 400)
}));

registerTraceRoutes(app, {
    getTraces: (c) => c.get('repoContext').runtime.current().traces,
    requireStorage,
    routeLogger
});

registerChangeBriefRoutes(app, {
    getRuntime: (c) => c.get('repoContext').runtime.current(),
    getSourceRevision: (c) => c.get('repoContext').runtime.currentSourceRevision(),
    requireRuntime,
    routeLogger
});

registerFixMermaidRoute(app, {
    getModelSpec: () => config.models.synthesis,
    routeLogger
});

registerStoryRoutes(app, {
    getStories: (c) => c.get('repoContext').runtime.current().stories,
    readSource: (c, sourcePath) => c.get('repoContext').sourceFiles.readPhysicalSource(sourcePath),
    requireStorage,
    routeLogger
});

registerAskRoute(app, {
    getRuntime: (c) => c.get('repoContext').runtime.current(),
    getSourceRevision: (c) => c.get('repoContext').runtime.currentSourceRevision(),
    requireRuntime,
    routeLogger
});

const staticRoot = import.meta.env?.PROD ? './dist' : './public';
if(import.meta.env?.PROD) {
    app.use('/assets/*', serveStatic({root: staticRoot}));
}
app.get('/', serveStatic({root: staticRoot}));
app.get('/index.html', serveStatic({root: staticRoot}));
app.get('/admin', serveStatic({root: staticRoot, path: 'index.html'}));
app.get('/repos', serveStatic({root: staticRoot, path: 'index.html'}));
app.get('/:storyId', async (c, next) => {
    if(!STORY_ID_RE.test(c.req.param('storyId'))) {
        return next();
    }
    return serveStatic({root: staticRoot, path: 'index.html'})(c, next);
});

if(import.meta.env?.PROD) {
    log.info({port: config.port, url: `http://localhost:${config.port}`}, 'server module loaded');
}

export default app;

async function requireTeamSetup(c, {runtimeStatus = false} = {}) {
    const current = await teamConfig.publicConfig();
    if(current.exists) {
        return null;
    }
    const payload = {
        error: 'setup_required',
        message: 'Open /admin to configure Tracebook before starting the runtime.',
        setupRequired: true
    };
    if(runtimeStatus) {
        return c.json({
            setupRequired: true,
            runtime: {
                state: 'error',
                stage: 'setup_required',
                message: payload.message,
                progressRatio: 0
            }
        });
    }
    return c.json(payload, 428);
}

async function requireRuntime(c) {
    const setupRequired = await requireTeamSetup(c);
    if(setupRequired) {
        return setupRequired;
    }
    const {runtime} = await runtimeContext(c);
    if(runtime.readyRuntime()) {
        try {
            await runtime.ensureRuntime();
            return null;
        } catch(err) {
            const requestLog = routeLogger(c);
            requestLog.error({err}, 'runtime wiring failed');
            return c.json({
                error: 'runtime_init_failed',
                message: 'The runtime failed to initialize. Check the server logs for details.',
                mode: 'runtime'
            }, 503);
        }
    }
    return runtimeNotReadyResponse(c);
}

async function requireStorage(c) {
    const setupRequired = await requireTeamSetup(c);
    if(setupRequired) {
        return setupRequired;
    }
    const requestLog = routeLogger(c);
    const {runtime} = await runtimeContext(c);
    try {
        await runtime.ensureStorage();
        return null;
    } catch(err) {
        requestLog.error({err}, 'storage initialization failed');
        return c.json({
            error: 'runtime_init_failed',
            message: 'Local storage failed to initialize. Check the server logs for details.',
            mode: 'storage'
        }, 503);
    }
}

function runtimeNotReadyResponse(c) {
    const {runtime} = c.get('repoContext');
    const snapshot = clientRuntimeSnapshot(runtime);
    if(c.req.path === '/api/ask') {
        return streamSSE(c, async (stream) => {
            await stream.writeSSE({
                event: 'runtime.indexing',
                data: JSON.stringify({type: 'runtime.indexing', runtime: snapshot})
            });
        });
    }
    return c.json({error: 'runtime_initializing', runtime: snapshot}, 503);
}

// Status payloads for the browser use the sanitized snapshot (no targetRoot,
// no absolute paths in messages). Feature-detected so test fakes that only
// implement snapshot() keep working.
//
function clientRuntimeSnapshot(runtime) {
    return typeof runtime.snapshotForClient === 'function'
        ? runtime.snapshotForClient()
        : runtime.snapshot();
}

function routeLogger(c) {
    return c.get('logger') || log;
}

async function runtimeContext(c) {
    const cached = c.get('repoContext');
    if(cached) {
        return cached;
    }
    const repoId = c.req.header('x-tracebook-repo') || '';
    const repo = await teamConfig.resolveRepo(repoId);
    if(!repo) {
        throw new Error('No Tracebook repository is configured. Open /admin to add one.');
    }
    const context = runtimeContextForRepo(repo);
    c.set('repoContext', context);
    return context;
}

function runtimeContextForRepo(repo) {
    const targetRoot = path.resolve(repo.path);
    const repoKey = createHash('sha256').update(targetRoot, 'utf8').digest('hex').slice(0, 16);
    const cacheKey = `${repo.id}:${repoKey}:${config.embeddings.model}:${config.embeddings.dims}`;
    const cached = runtimeContexts.get(cacheKey);
    if(cached) {
        return cached;
    }

    const repoDataRoot = path.resolve(tracebookPaths.reposRoot, repoKey);
    const traceRoot = path.resolve(repoDataRoot, 'traces');
    const storyRoot = path.resolve(repoDataRoot, 'stories');
    const changeBriefRoot = path.resolve(repoDataRoot, 'change-briefs');
    const embedSig = createHash('sha256')
        .update(`${config.embeddings.model}\n${config.embeddings.dims}`, 'utf8')
        .digest('hex')
        .slice(0, 12);
    const indexRoot = path.resolve(repoDataRoot, 'index', embedSig);
    const repoIgnore = createRepoIgnore({root: targetRoot});
    const sourceFiles = createSourceFileService({
        targetRoot,
        indexExclude: INDEX_EXCLUDE,
        repoIgnore,
        routeLogger
    });
    const runtime = createRuntimeManager({
        config,
        targetRoot,
        traceRoot,
        storyRoot,
        changeBriefRoot,
        indexRoot,
        include: INDEX_INCLUDE,
        exclude: INDEX_EXCLUDE,
        log,
        indexLog,
        instanceKey: repoKey
    });
    const context = {
        repo: {...repo, path: targetRoot},
        repoKey,
        sourceFiles,
        runtime
    };
    runtimeContexts.set(cacheKey, context);
    return context;
}

function disposeRuntimeContexts() {
    const teardowns = [];
    for(const context of runtimeContexts.values()) {
        teardowns.push(context.runtime.dispose());
    }
    runtimeContexts.clear();
    const settled = Promise.allSettled(teardowns).then((results) => {
        for(const result of results) {
            if(result.status === 'rejected') {
                log.warn({err: result.reason}, 'runtime teardown failed');
            }
        }
    });
    // Config-save callers fire and forget; shutdown awaits via disposeAllRuntimes.
    //
    settled.catch(() => {});
    return settled;
}

// Awaited by the shutdown handler so watchers, the LanceDB connection, and
// the ONNX sessions are released before the process exits.
//
export function disposeAllRuntimes() {
    return disposeRuntimeContexts();
}

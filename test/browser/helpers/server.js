import http from 'node:http';
import {Buffer} from 'node:buffer';
import path from 'node:path';
import {createHash} from 'node:crypto';
import fs from 'fs-extra';

// A canned HTTP server for the browser e2e suite. It serves the built client from
// dist/ and answers every /api/* call with deterministic fixtures — no LLM, no
// Ollama, no index. node:http (not Hono) is used so /api/ask can stream SSE and
// then destroy the socket mid-stream — the "connection dropped" case page.route
// cannot reproduce.
//
// /api/ask behaviour is keyed off the question text so a spec can pick a scenario:
//   default      -> a normal completing trace (one grounded callout)
//   BLOCKS        -> a trace with one of every block type
//   DROP          -> a couple of events, then the socket is destroyed mid-stream
//   ERROR         -> a server-sent trace.error event
//   INCOMPLETE    -> events then a clean close with no trace.complete/trace.error
//
const here = import.meta.dirname;
const distDir = path.resolve(here, '..', '..', '..', 'dist');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.map': 'application/json'
};
function sseFrame(type, data) {
    return `event: ${type}${'\n'}data: ${JSON.stringify({type, ...data})}${'\n\n'}`;
}

function calloutProps(id) {
    return {
        id,
        type: 'evidence_callout',
        kind: 'grounded',
        summary: 'Canned callout for the browser test.',
        detail: 'This evidence callout is fixture data; it never calls a model.',
        sourceRefs: [{path: 'src/server.js', lineStart: 1, lineEnd: 5}],
        confidence: 1,
        _final: true
    };
}

function normalTraceFrames(question) {
    return [
        sseFrame('trace.start', {traceId: 'trc_test', question, startedAt: 0}),
        sseFrame('trace.title', {title: question.slice(0, 48)}),
        sseFrame('narrative.patch', {startIndex: 0, items: ['A canned narrative step for the browser test.']}),
        sseFrame('component.patch', {index: 0, id: 'cb', componentType: 'evidence_callout', props: calloutProps('cb')}),
        sseFrame('trace.complete', {traceId: 'trc_test', durationMs: 1000, model: 'test', usage: null, timing: {}})
    ];
}

function changeBriefFixture(traceId, request = {}) {
    return {
        brief: {
            briefId: `brief_${traceId}`,
            traceId,
            title: 'Make the chapter behavior explicit',
            productGoal: request.changeIntent || 'Improve the selected chapter.',
            currentBehavior: 'The current behavior is grounded in the selected chapter trace.',
            likelyFiles: [{
                path: 'src/server.js',
                role: 'request handling',
                reason: 'The selected chapter cites this request boundary.',
                confidence: 'high'
            }],
            acceptanceCriteria: ['The requested behavior is visible in the chapter flow.'],
            riskNotes: [{text: 'Keep the existing response contract stable.'}],
            openQuestions: ['Should the change affect cached responses?'],
            agentPrompt: `Implement: ${request.changeIntent || 'the requested change'}`,
            outputFormat: request.outputFormat || 'llm_prompt',
            freshness: 'current'
        }
    };
}

// One trace carrying every block kind, so a spec can assert each renders.
//
function blocksTraceFrames(question) {
    return [
        sseFrame('trace.start', {traceId: 'trc_blocks', question, startedAt: 0}),
        sseFrame('trace.title', {title: 'Every block kind'}),
        sseFrame('component.patch', {
            index: 0,
            id: 'excerpt',
            componentType: 'annotated_code_excerpt',
            props: {
                id: 'excerpt',
                type: 'annotated_code_excerpt',
                caption: 'Server entry',
                language: 'javascript',
                code: 'const app = new Hono();\napp.get("/api/health", handler);',
                callouts: [{line: 1, note: 'Creates the Hono application instance.'}],
                sourceRefs: [{path: 'src/server.js', lineStart: 3, lineEnd: 4}],
                confidence: 1,
                _final: true
            }
        }),
        sseFrame('component.patch', {
            index: 1,
            id: 'diagram',
            componentType: 'sequence_diagram',
            props: {
                id: 'diagram',
                type: 'sequence_diagram',
                caption: 'Request flow',
                mermaid: 'sequenceDiagram\n  participant U as User\n  participant S as Server\n  U->>S: POST /api/ask\n  S-->>U: SSE events',
                sourceRefs: [{path: 'src/server/ask-route.js', lineStart: 9, lineEnd: 20}],
                confidence: 1,
                _final: true
            }
        }),
        sseFrame('component.patch', {index: 2, id: 'callout', componentType: 'evidence_callout', props: calloutProps('callout')}),
        sseFrame('trace.complete', {traceId: 'trc_blocks', durationMs: 1000, model: 'test', usage: null, timing: {}})
    ];
}

function chapterEvents(title) {
    return [
        {type: 'trace.start', traceId: `trc_${title}`, question: title, startedAt: 0},
        {type: 'trace.title', title},
        {type: 'narrative.patch', startIndex: 0, items: [`Replayed narrative for ${title}.`]},
        {type: 'component.patch', index: 0, id: 'cb', componentType: 'evidence_callout', props: calloutProps('cb')},
        {type: 'trace.complete', traceId: `trc_${title}`, durationMs: 10, model: 'test', usage: null, timing: {}}
    ];
}

function defaultStories() {
    return [
        {
            storyId: 'story_alpha',
            title: 'Alpha Story',
            createdAt: 1,
            updatedAt: 2,
            chapterCount: 1,
            lastQuestion: 'alpha question',
            sourcePaths: ['src/server.js'],
            chapters: [{question: 'alpha question', title: 'Alpha Story', traceId: 'trc_alpha', narrative: ['Alpha narrative.'], events: chapterEvents('Alpha Story')}]
        },
        {
            storyId: 'story_beta',
            title: 'Beta Story',
            createdAt: 3,
            updatedAt: 4,
            chapterCount: 1,
            lastQuestion: 'beta question',
            sourcePaths: ['src/index/store.js'],
            chapters: [{question: 'beta question', title: 'Beta Story', traceId: 'trc_beta', narrative: ['Beta narrative.'], events: chapterEvents('Beta Story')}]
        }
    ];
}

function defaultTeamConfig() {
    return {
        configPath: '/tmp/tracebook.config.json',
        exists: true,
        repos: [{id: 'tracebook', name: 'Tracebook', path: '/repo/tracebook', description: 'Dogfood'}],
        defaultRepoId: 'tracebook',
        credentials: {
            openaiApiKey: false,
            anthropicApiKey: false,
            googleApiKey: false,
            mistralApiKey: false
        },
        credentialFingerprints: {
            openaiApiKey: '',
            anthropicApiKey: '',
            googleApiKey: '',
            mistralApiKey: ''
        },
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        tpmBudget: 100_000,
        logging: {level: 'debug', pretty: true},
        models: {
            exploration: 'openai/gpt-4.1-mini',
            synthesis: 'openai/gpt-4.1-mini',
            outline: 'openai/gpt-4o-mini',
            hyde: 'openai/gpt-4o-mini',
            annotation: 'openai/gpt-4o-mini'
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
            model: 'ollama/qwen3-coder-next:latest',
            maxOutputTokens: 220,
            maxInputChars: 12_000,
            timeoutMs: 8000,
            concurrency: 4
        },
        rerank: {
            enabled: true,
            model: 'Xenova/bge-reranker-base',
            dtype: 'q8',
            candidates: 20,
            numThreads: 0
        },
        hyde: {enabled: true, timeoutMs: 3000, minSimilarity: 0.3},
        search: {semanticThreshold: 0.2, contentMax: 2500},
        fastPath: {similarity: 0.55, maxResults: 3, maxQuestionLen: 120},
        planner: {
            throttleMs: 220,
            explorationMaxSteps: 6,
            explorationMaxTokens: 4000,
            explorationWallMs: 18_000,
            componentThrottleMs: 120,
            componentMaxTokens: 2500,
            outlineMaxTokens: 1500,
            componentConcurrency: 2,
            componentWallMs: 120_000
        },
        annotations: {maxTokens: 900},
        trace: {componentLimit: 6},
        chunker: {smallFileLines: 80, windowLines: 80, windowOverlap: 10},
        watcher: {debounceMs: 250, optimizeDebounceMs: 1000},
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
}

function defaultAdvancedDefaults() {
    const config = defaultTeamConfig();
    return {
        search: config.search,
        fastPath: config.fastPath,
        rerank: {
            model: config.rerank.model,
            dtype: config.rerank.dtype,
            candidates: config.rerank.candidates,
            numThreads: config.rerank.numThreads
        },
        hyde: {
            timeoutMs: config.hyde.timeoutMs,
            minSimilarity: config.hyde.minSimilarity
        },
        enrichment: {
            model: config.enrichment.model,
            maxOutputTokens: config.enrichment.maxOutputTokens,
            maxInputChars: config.enrichment.maxInputChars,
            timeoutMs: config.enrichment.timeoutMs,
            concurrency: config.enrichment.concurrency
        },
        planner: config.planner,
        annotations: config.annotations,
        trace: config.trace,
        chunker: config.chunker,
        watcher: config.watcher,
        tools: config.tools,
        governor: config.governor,
        answerCache: config.answerCache,
        traces: config.traces
    };
}

async function readBody(req) {
    let raw = '';
    for await (const chunk of req) {
        raw += chunk;
    }
    try {
        return JSON.parse(raw || '{}');
    } catch {
        return {};
    }
}

function writeJson(res, payload, status = 200) {
    res.writeHead(status, {'content-type': MIME['.json']});
    res.end(JSON.stringify(payload));
}

function writeText(res, body, headers = {}) {
    res.writeHead(200, {'content-type': 'text/plain; charset=utf-8', ...headers});
    res.end(body);
}

async function handleAsk(req, res) {
    const {question = ''} = await readBody(req);
    res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive'});

    if(/drop/i.test(question)) {
        res.write(sseFrame('trace.start', {traceId: 'trc_drop', question, startedAt: 0}));
        res.write(sseFrame('synthesis.start', {mode: 'full'}));
        setTimeout(() => res.socket?.destroy(), 150);
        return;
    }
    if(/incomplete/i.test(question)) {
        res.write(sseFrame('trace.start', {traceId: 'trc_inc', question, startedAt: 0}));
        res.write(sseFrame('synthesis.start', {mode: 'full'}));
        // Hold the stream open briefly (so the blinker is observably on), then
        // close cleanly with no trace.complete / trace.error.
        //
        setTimeout(() => res.end(), 300);
        return;
    }
    if(/error/i.test(question)) {
        res.write(sseFrame('trace.start', {traceId: 'trc_err', question, startedAt: 0}));
        res.write(sseFrame('trace.error', {message: 'planner exploded for the test'}));
        res.end();
        return;
    }
    const frames = /blocks/i.test(question) ? blocksTraceFrames(question) : normalTraceFrames(question);
    for(const frame of frames) {
        res.write(frame);
    }
    res.end();
}

async function handleStatic(req, res) {
    const requested = (req.url || '/').split('?')[0];
    const relative = requested === '/' ? '/index.html' : requested;
    const filePath = path.join(distDir, relative);
    if(!filePath.startsWith(distDir)) {
        res.writeHead(403);
        res.end();
        return;
    }
    if(await fs.pathExists(filePath) && (await fs.stat(filePath)).isFile()) {
        res.writeHead(200, {'content-type': MIME[path.extname(filePath)] || 'application/octet-stream'});
        res.end(await fs.readFile(filePath));
        return;
    }
    res.writeHead(200, {'content-type': MIME['.html']});
    res.end(await fs.readFile(path.join(distDir, 'index.html')));
}

function createHandler(state) {
    return async (req, res) => {
        const url = (req.url || '/').split('?')[0];
        try {
            if(url.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers['x-tracebook-request'] !== '1') {
                writeJson(res, {error: 'missing_request_marker'}, 403);
                return;
            }
            // Test-only: reset mutable state so specs don't couple through it.
            //
            if(url === '/__test/reset') {
                state.stories = defaultStories();
                state.teamConfig = defaultTeamConfig();
                state.lastTeamConfigSave = null;
                writeJson(res, {ok: true});
                return;
            }
            if(url === '/__test/team-config-save') {
                writeJson(res, state.lastTeamConfigSave || {});
                return;
            }
            if(url === '/__test/clear-team-config') {
                state.teamConfig = {...defaultTeamConfig(), exists: false};
                state.lastTeamConfigSave = null;
                writeJson(res, {ok: true});
                return;
            }
            if(url === '/api/team/config' && req.method === 'GET') {
                writeJson(res, state.teamConfig);
                return;
            }
            if(url === '/api/team/config' && req.method === 'POST') {
                const body = await readBody(req);
                const credentials = {...state.teamConfig.credentials};
                const credentialFingerprints = {...state.teamConfig.credentialFingerprints};
                for(const field of body.clearCredentials || []) {
                    credentials[field] = false;
                    credentialFingerprints[field] = '';
                }
                for(const [field, value] of Object.entries(body.credentials || {})) {
                    if(value) {
                        credentials[field] = true;
                        credentialFingerprints[field] = fingerprint(value);
                    }
                }
                state.lastTeamConfigSave = body;
                state.teamConfig = {
                    ...state.teamConfig,
                    ...body,
                    exists: true,
                    credentials,
                    credentialFingerprints
                };
                writeJson(res, state.teamConfig);
                return;
            }
            if(url === '/api/team/repos') {
                writeJson(res, {
                    repos: state.teamConfig.repos,
                    defaultRepoId: state.teamConfig.defaultRepoId
                });
                return;
            }
            if(url === '/api/team/defaults/advanced') {
                writeJson(res, {defaults: defaultAdvancedDefaults()});
                return;
            }
            if(url === '/api/runtime/status') {
                writeJson(res, {runtime: {state: 'ready'}});
                return;
            }
            if(url === '/api/runtime/start' && req.method === 'POST') {
                writeJson(res, {runtime: {state: 'ready'}});
                return;
            }
            const sourceFileMatch = /^\/api\/source-file\/([^/]+)$/.exec(url);
            if(sourceFileMatch) {
                const sourcePath = Buffer.from(sourceFileMatch[1], 'base64url').toString('utf8');
                writeText(res, [
                    'import {Hono} from "hono";',
                    '',
                    'const app = new Hono();',
                    'app.get("/api/health", handler);',
                    'app.post("/api/ask", askHandler);'
                ].join('\n'), {
                    'x-source-path': sourcePath,
                    'x-source-bytes': '117'
                });
                return;
            }
            if(url === '/api/stories' && req.method === 'GET') {
                writeJson(res, {stories: state.stories});
                return;
            }
            if(url === '/api/stories' && req.method === 'POST') {
                const body = await readBody(req);
                writeJson(res, {...body, storyId: body.storyId || 'story_test'});
                return;
            }
            const storyMatch = /^\/api\/stories\/([^/]+)$/.exec(url);
            if(storyMatch) {
                const id = decodeURIComponent(storyMatch[1]);
                if(req.method === 'DELETE') {
                    const before = state.stories.length;
                    state.stories = state.stories.filter((s) => s.storyId !== id);
                    if(state.stories.length === before) {
                        writeJson(res, {error: 'not_found'}, 404);
                        return;
                    }
                    writeJson(res, {ok: true, storyId: id});
                    return;
                }
                const story = state.stories.find((s) => s.storyId === id);
                if(!story) {
                    writeJson(res, {error: 'not_found'}, 404);
                    return;
                }
                writeJson(res, story);
                return;
            }
            if(url === '/api/ask' && req.method === 'POST') {
                await handleAsk(req, res);
                return;
            }
            const changeBriefMatch = /^\/api\/traces\/([^/]+)\/change-brief$/.exec(url);
            if(changeBriefMatch && req.method === 'POST') {
                const request = await readBody(req);
                writeJson(res, changeBriefFixture(decodeURIComponent(changeBriefMatch[1]), request));
                return;
            }
            if(url.startsWith('/api/')) {
                writeJson(res, {});
                return;
            }
            await handleStatic(req, res);
        } catch {
            if(!res.headersSent) {
                res.writeHead(500);
            }
            res.end();
        }
    };
}

function fingerprint(value) {
    return `sha256:${createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`;
}

// Starts the canned server on an ephemeral port. Returns {url, close}.
//
export async function startTestServer() {
    if(!await fs.pathExists(path.join(distDir, 'index.html'))) {
        throw new Error('dist/index.html missing — run `yarn build:client` before the browser suite (the test:browser script does this).');
    }
    const state = {stories: defaultStories(), teamConfig: defaultTeamConfig(), lastTeamConfigSave: null};
    const server = http.createServer(createHandler(state));
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const {port} = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve) => {
            server.close(resolve);
        })
    };
}

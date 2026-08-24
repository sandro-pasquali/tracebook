import test from 'node:test';
import assert from 'node:assert/strict';
import {createAnswerCache} from '../../src/util/answer-cache.js';

const RUNTIME_KEY = Symbol.for('tracebook.runtime');
const STORAGE_KEY = Symbol.for('tracebook.storage');
const JSON_REQUEST_HEADERS = {
    'content-type': 'application/json',
    'x-tracebook-request': '1'
};

test('api ask streams a lean trace, saves it, and replays verbatim repeats from cache', async () => {
    const savedTraces = [];
    const runtime = fakeRuntime({
        traces: {
            async save(trace) {
                savedTraces.push(trace);
            },
            async load() {
                return null;
            },
        },
        answerCache: createAnswerCache({ttlMs: 60_000, cap: 10}),
    });
    globalThis[RUNTIME_KEY] = runtime;
    globalThis[STORAGE_KEY] = {traces: runtime.traces, stories: runtime.stories};

    try {
        const {default: app} = await import(`../../src/server.js?ask-cache=${Date.now()}`);

        const first = await app.request('/api/ask', askRequest('Where is the checkout route?'));
        const firstEvents = parseSse(await first.text());

        assert.equal(first.status, 200);
        assert.equal(first.headers.get('content-type'), 'text/event-stream');
        assert.ok(firstEvents.some((event) => event.type === 'trace.start'));
        assert.ok(firstEvents.some((event) => event.type === 'trace.complete'));
        assert.ok(firstEvents.some((event) => event.type === 'component.patch' && event.componentType === 'evidence_callout'));
        assert.equal(savedTraces.length, 1);
        assert.equal(savedTraces[0].sourceRevision, 'rev-test');

        const second = await app.request('/api/ask', askRequest('Where is the checkout route?'));
        const secondEvents = parseSse(await second.text());

        assert.equal(second.status, 200);
        assert.equal(secondEvents[0].type, 'trace.replay');
        assert.equal(secondEvents[0].source, 'cache');
        assert.ok(secondEvents.some((event) => event.type === 'trace.complete'));
        assert.equal(savedTraces.length, 1);
    } finally {
        delete globalThis[RUNTIME_KEY];
        delete globalThis[STORAGE_KEY];
    }
});

test('api ask uses a fresh high-similarity prior trace as context without replaying its answer', async () => {
    const savedTraces = [];
    let searches = 0;
    const priorEvents = [
        {type: 'trace.start', traceId: 'trc_prior_123abc', question: 'How does checkout work?', startedAt: 10},
        {type: 'trace.title', title: 'Prior Checkout Trace'},
        {type: 'trace.complete', traceId: 'trc_prior_123abc', startedAt: 10, finishedAt: 20, durationMs: 10},
    ];
    const runtime = fakeRuntime({
        traces: {
            async save(trace) {
                savedTraces.push(trace);
            },
            async load(traceId) {
                assert.equal(traceId, 'trc_prior_123abc');
                return {
                    traceId,
                    question: 'How does checkout work?',
                    sourceRevision: 'rev-test',
                    events: priorEvents,
                };
            },
        },
        traceIndexer: {
            async findSimilarByQuery(question, options) {
                assert.equal(question, 'Explain checkout behavior');
                assert.deepEqual(options, {limit: 3});
                return [{
                    traceId: 'trc_prior_123abc',
                    question: 'How does checkout work?',
                    summary: 'Prior summary',
                    componentKinds: ['evidence_callout'],
                    similarity: 0.91,
                    timestamp: Date.now() - 1000,
                }];
            },
            async persistTrace() {
                return null;
            },
        },
        answerCache: createAnswerCache({ttlMs: 60_000, cap: 10}),
        tools: {
            search_codebase: {
                async execute() {
                    searches += 1;
                    return {
                        count: 0,
                        threshold: 0.2,
                        retrieval: {
                            modes: ['test'],
                            timings: {},
                            counts: {results: 0},
                        },
                        results: [],
                    };
                },
            },
        },
    });
    globalThis[RUNTIME_KEY] = runtime;
    globalThis[STORAGE_KEY] = {traces: runtime.traces, stories: runtime.stories};

    try {
        const {default: app} = await import(`../../src/server.js?ask-paraphrase=${Date.now()}`);

        const response = await app.request('/api/ask', askRequest('Explain checkout behavior'));
        const events = parseSse(await response.text());

        assert.equal(response.status, 200);
        assert.ok(!events.some((event) => event.type === 'trace.replay'));
        assert.ok(events.some((event) => event.type === 'trace.similar' && event.matches[0]?.traceId === 'trc_prior_123abc'));
        assert.ok(events.some((event) => event.type === 'trace.start'));
        assert.ok(events.some((event) => event.type === 'trace.complete'));
        assert.ok(searches >= 1);
        assert.equal(savedTraces.length, 1);
    } finally {
        delete globalThis[RUNTIME_KEY];
        delete globalThis[STORAGE_KEY];
    }
});

test('api ask returns runtime.indexing without blocking while the index is still building', async () => {
    // A never-resolving promise models a runtime whose cold index is still in
    // flight: readyRuntime() must report not-ready and the request must not hang.
    //
    globalThis[RUNTIME_KEY] = new Promise(() => {});

    try {
        const {default: app} = await import(`../../src/server.js?ask-notready=${Date.now()}`);

        const response = await app.request('/api/ask', askRequest('Where is the checkout route?'));
        const events = parseSse(await response.text());

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'text/event-stream');
        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'runtime.indexing');
        assert.ok(events[0].runtime);

        const health = await app.request('/api/health');
        assert.equal(health.status, 503);
        assert.equal((await health.json()).error, 'runtime_initializing');
    } finally {
        delete globalThis[RUNTIME_KEY];
    }
});

test('api ask accepts a story context with over-budget generated text', async () => {
    // Round-tripped story context is server-generated; an over-budget bullet
    // must be clamped by the contract, never rejected — a saved story that
    // 400s its own follow-up asks is the regression this pins.
    //
    globalThis[RUNTIME_KEY] = new Promise(() => {});

    try {
        const {default: app} = await import(`../../src/server.js?ask-clamped-context=${Date.now()}`);

        const response = await app.request('/api/ask', {
            method: 'POST',
            headers: JSON_REQUEST_HEADERS,
            body: JSON.stringify({
                question: 'What about the watcher?',
                storyContext: {
                    chapters: [{
                        question: 'How does indexing work?',
                        title: 'Indexing',
                        narrative: [`A generated bullet far past every budget. ${'detail '.repeat(120)}`],
                        sourcePaths: []
                    }],
                    sourcePaths: []
                },
                forceFresh: false
            }),
        });

        assert.notEqual(response.status, 400, 'over-budget context must not reject');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'text/event-stream');
    } finally {
        delete globalThis[RUNTIME_KEY];
    }
});

test('api ask validates request body before runtime startup', async () => {
    globalThis[RUNTIME_KEY] = new Promise(() => {});

    try {
        const {default: app} = await import(`../../src/server.js?ask-invalid-contract=${Date.now()}`);

        const response = await app.request('/api/ask', {
            method: 'POST',
            headers: JSON_REQUEST_HEADERS,
            body: JSON.stringify({question: ''}),
        });
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.equal(body.error, 'invalid_request');
        assert.equal(body.part, 'body');
        assert.ok(body.issues.some((issue) => issue.path === 'question'));
    } finally {
        delete globalThis[RUNTIME_KEY];
    }
});

function fakeRuntime(overrides = {}) {
    const traceIndexer = overrides.traceIndexer || {
        async findSimilarByQuery() {
            return [];
        },
        async persistTrace() {
            return null;
        },
    };
    const tools = overrides.tools || {
        search_codebase: {
            async execute() {
                return {
                    count: 0,
                    threshold: 0.2,
                    retrieval: {
                        modes: ['test'],
                        timings: {},
                        counts: {results: 0},
                    },
                    results: [],
                };
            },
        },
    };
    return {
        governor: null,
        traces: overrides.traces,
        stories: overrides.stories || {},
        embedder: null,
        store: null,
        indexer: overrides.indexer || {
            sourceState() {
                return {sourceRevision: 'rev-test'};
            },
        },
        traceIndexer,
        answerCache: overrides.answerCache || createAnswerCache({ttlMs: 60_000, cap: 10}),
        tools,
    };
}

function askRequest(question) {
    return {
        method: 'POST',
        headers: JSON_REQUEST_HEADERS,
        body: JSON.stringify({question}),
    };
}

function parseSse(text) {
    return String(text || '')
        .split(/\n\n/)
        .map((frame) => frame.trim())
        .filter(Boolean)
        .map((frame) => {
            const data = frame
                .split(/\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
            return JSON.parse(data);
        });
}

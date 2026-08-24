import test from 'node:test';
import assert from 'node:assert/strict';
import {installMockModels, streamObjectModel} from '../helpers/mock-models.js';

const RUNTIME_KEY = Symbol.for('tracebook.runtime');
const STORAGE_KEY = Symbol.for('tracebook.storage');
const JSON_REQUEST_HEADERS = {
    'content-type': 'application/json',
    'x-tracebook-request': '1'
};

test('change brief route generates and stores a source-grounded brief', async () => {
    const restore = installMockModels({
        'ollama/test-outline': streamObjectModel({
            title: 'Add checkout refund request',
            productGoal: 'Let customers request a refund without issuing money automatically.',
            currentBehavior: 'Checkout currently flows through the checkout route.',
            likelyFiles: [{
                path: 'src/routes/checkout.js',
                role: 'route',
                reason: 'This route is the traced checkout entrypoint.',
                confidence: 'high'
            }],
            existingPatterns: [{text: 'Use the existing route boundary.', sourceRefs: []}],
            implementationConstraints: [{text: 'Do not issue refunds automatically.', sourceRefs: []}],
            acceptanceCriteria: ['A refund request can be submitted.'],
            testPlan: [{text: 'Add route tests for request validation.', sourceRefs: []}],
            openQuestions: [],
            riskNotes: [{text: 'Checkout is request-facing behavior.', sourceRefs: []}]
        })
    });
    const savedBriefs = [];
    const runtime = fakeRuntime({
        briefs: {
            async save(brief) {
                const saved = {...brief, briefId: 'brf_test_abc123'};
                savedBriefs.push(saved);
                return saved;
            }
        }
    });
    globalThis[RUNTIME_KEY] = runtime;
    globalThis[STORAGE_KEY] = {traces: runtime.traces, stories: runtime.stories, briefs: runtime.briefs};

    try {
        const {default: app} = await import(`../../src/server.js?change-brief=${Date.now()}`);
        const response = await app.request('/api/traces/trc_checkout_123abc/change-brief', {
            method: 'POST',
            headers: JSON_REQUEST_HEADERS,
            body: JSON.stringify({
                changeIntent: 'Add a refund request action after checkout.',
                outputFormat: 'llm_prompt'
            })
        });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.brief.briefId, 'brf_test_abc123');
        assert.equal(body.brief.traceId, 'trc_checkout_123abc');
        assert.equal(body.brief.freshness, 'current');
        assert.match(body.brief.agentPrompt, /Relevant files to inspect first/v);
        assert.equal(savedBriefs.length, 1);
    } finally {
        restore();
        delete globalThis[RUNTIME_KEY];
        delete globalThis[STORAGE_KEY];
    }
});

test('change brief route validates request payloads', async () => {
    globalThis[RUNTIME_KEY] = fakeRuntime();

    try {
        const {default: app} = await import(`../../src/server.js?change-brief-invalid=${Date.now()}`);
        const response = await app.request('/api/traces/trc_checkout_123abc/change-brief', {
            method: 'POST',
            headers: JSON_REQUEST_HEADERS,
            body: JSON.stringify({changeIntent: '', outputFormat: 'llm_prompt'})
        });
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.equal(body.error, 'invalid_request');
        assert.equal(body.part, 'body');
        assert.ok(body.issues.some((issue) => issue.path === 'changeIntent'));

        const legacyProfile = await app.request('/api/traces/trc_checkout_123abc/change-brief', {
            method: 'POST',
            headers: JSON_REQUEST_HEADERS,
            body: JSON.stringify({changeIntent: 'Add refunds.', profile: 'codex'})
        });
        assert.equal(legacyProfile.status, 400);

        const brandedIssue = await app.request('/api/traces/trc_checkout_123abc/change-brief', {
            method: 'POST',
            headers: JSON_REQUEST_HEADERS,
            body: JSON.stringify({changeIntent: 'Add refunds.', outputFormat: 'github_issue'})
        });
        assert.equal(brandedIssue.status, 400);
    } finally {
        delete globalThis[RUNTIME_KEY];
    }
});

function fakeRuntime(overrides = {}) {
    const traces = overrides.traces || {
        async load(traceId) {
            assert.equal(traceId, 'trc_checkout_123abc');
            return {
                traceId,
                question: 'How does checkout work?',
                sourceRevision: 'rev-test',
                trace: {
                    title: 'Checkout flow',
                    narrative: ['The checkout route handles the flow.'],
                    components: [{
                        type: 'evidence_callout',
                        id: 'route',
                        summary: 'Checkout route',
                        confidence: 0.9,
                        sourceRefs: [{path: 'src/routes/checkout.js', lineStart: 10, lineEnd: 30}]
                    }]
                },
                featureTrace: {
                    summary: 'Checkout flow',
                    entrypoints: [{path: 'src/routes/checkout.js', lineStart: 10, lineEnd: 30, role: 'request handling'}],
                    evidence: [{path: 'src/routes/checkout.js', lineStart: 10, lineEnd: 30, claim: 'Checkout route'}],
                    changeRisks: [],
                    openQuestions: []
                }
            };
        }
    };
    return {
        governor: null,
        traces,
        stories: {},
        briefs: overrides.briefs || {
            async save(brief) {
                return {...brief, briefId: 'brf_test_abc123'};
            }
        },
        embedder: null,
        store: null,
        indexer: {
            sourceState() {
                return {sourceRevision: 'rev-test'};
            }
        },
        traceIndexer: {
            async findSimilarByQuery() {
                return [];
            },
            async persistTrace() {
                return null;
            }
        },
        answerCache: {},
        tools: {
            search_codebase: {
                async execute() {
                    return {
                        results: [{
                            path: 'src/routes/checkout.js',
                            lineStart: 10,
                            lineEnd: 30,
                            similarity: 0.8,
                            content: '10  export function checkoutRoute() {}'
                        }]
                    };
                }
            }
        }
    };
}

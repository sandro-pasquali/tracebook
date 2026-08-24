import test from 'node:test';
import assert from 'node:assert/strict';
import {__retrievalSignalsForTest, runSearch} from '../../src/tools/search.js';

test('retrieval signal generation expands UI, graph, and repo-profile terms', () => {
    const signals = __retrievalSignalsForTest('Show the Rust crate HTML CSS layout for GET /health route');

    assert.deepEqual(signals.surfaceFamilies, ['markup', 'style']);
    assert.ok(signals.tokens.includes('/health'), signals.tokens.join(','));
    assert.ok(signals.graphTerms.includes('route'), signals.graphTerms.join(','));
    assert.ok(signals.graphTerms.includes('get'), signals.graphTerms.join(','));
    assert.ok(signals.graphTerms.includes('css'), signals.graphTerms.join(','));
    assert.ok(signals.repoProfiles.some((profile) => profile.id === 'rust'));
});

test('runSearch embeds the natural-language query once when no embedding is provided', async () => {
    const embedder = fakeEmbedder([[0.1, 0.2]]);
    const store = fakeStore();

    const result = await runSearch({
        queryText: 'checkout handler',
        limit: 1,
        embedder,
        store,
    });

    assert.deepEqual(embedder.calls, [['checkout handler']]);
    assert.deepEqual(store.embeddingQueries, [[0.1, 0.2]]);
    assert.equal(result.count, 1);
    assert.equal(result.results[0].path, 'src/checkout.js');
    assert.equal(result.retrieval.counts.vectorCandidates, 1);
});

test('runSearch reuses a precomputed embedding without calling the embedder', async () => {
    const embedder = fakeEmbedder();
    const store = fakeStore();
    const queryEmbedding = [0.4, 0.5];

    const result = await runSearch({
        queryText: 'checkout handler',
        queryEmbedding,
        limit: 1,
        embedder,
        store,
    });

    assert.deepEqual(embedder.calls, []);
    assert.deepEqual(store.embeddingQueries, [queryEmbedding]);
    assert.equal(result.retrieval.timings.embeddingMs, 0);
    assert.equal(result.results[0].path, 'src/checkout.js');
});

test('runSearch promotes exact technical anchors over generic semantic matches', async () => {
    const embedder = fakeEmbedder([[0.2, 0.3]]);
    const store = fakeStore({
        semanticRows: [{
            path: 'src/middleware.js',
            lineStart: 1,
            lineEnd: 4,
            content: 'app.use("*", async (c, next) => {\n    await next();\n});',
            score: 0.1,
        }],
        textRows: [
            {
                path: 'src/docs/annotation-helper.js',
                lineStart: 1,
                lineEnd: 3,
                content: 'const note = "OAuthCallback is an example string";',
                score: 0.2,
            },
            {
                path: 'src/server.js',
                lineStart: 20,
                lineEnd: 24,
                content: 'app.post("/api/oauth/callback", async (c) => {\n    return OAuthCallback(c);\n});',
                score: 0.2,
            },
        ],
        graphRows: [{
            path: 'src/middleware.js',
            lineStart: 1,
            lineEnd: 4,
            kind: 'route',
            name: 'GET /api/health',
            target: '/api/health',
            detail: 'declares a route',
        }],
    });

    const result = await runSearch({
        queryText: 'Explain POST /api/oauth/callback OAuthCallback flow',
        limit: 2,
        embedder,
        store,
    });

    assert.equal(result.results[0].path, 'src/server.js');
    assert.match(result.results[0].content, /OAuthCallback/v);
});

test('runSearch promotes markup and stylesheet files for UI surface questions', async () => {
    const embedder = fakeEmbedder([[0.3, 0.4]]);
    const store = fakeStore({
        semanticRows: [{
            path: 'src/docs/html-notes.js',
            lineStart: 1,
            lineEnd: 3,
            content: 'export const notes = "HTML CSS layout examples";',
            score: 0.05,
        }],
        textRows: [
            {
                path: 'src/docs/html-notes.js',
                lineStart: 1,
                lineEnd: 3,
                content: 'export const notes = "HTML CSS layout examples";',
                score: 0.2,
            },
            {
                path: 'public/index.html',
                lineStart: 1,
                lineEnd: 8,
                content: '<main class="stage">\n    <section id="outlet"></section>\n</main>',
                score: 0.2,
            },
            {
                path: 'src/docs/css-notes.js',
                lineStart: 1,
                lineEnd: 3,
                content: 'export const css = "style notes";',
                score: 0.2,
            },
            {
                path: 'public/styles.css',
                lineStart: 10,
                lineEnd: 16,
                content: '.stage {\n    display: grid;\n    gap: 16px;\n}',
                score: 0.2,
            },
        ],
    });

    const result = await runSearch({
        queryText: 'Show the page layout HTML and CSS',
        limit: 3,
        embedder,
        store,
    });

    const paths = result.results.map((row) => row.path);
    assert.ok(paths.includes('public/index.html'), paths);
    assert.ok(paths.includes('public/styles.css'), paths);
    assert.ok(paths.indexOf('public/index.html') < paths.indexOf('src/docs/html-notes.js'), paths);
});

test('runSearch boosts source from the integration matched by the question', async () => {
    const embedder = fakeEmbedder([[0.3, 0.4]]);
    const store = fakeStore({
        semanticRows: [
            {
                path: 'src/server.js',
                lineStart: 1,
                lineEnd: 4,
                content: 'export function checkout() { return true; }',
                score: 0.04,
            },
            {
                path: 'src/main.rs',
                lineStart: 1,
                lineEnd: 5,
                content: 'fn checkout() -> bool { true }',
                score: 0.08,
            },
        ],
    });

    const result = await runSearch({
        queryText: 'How does the Rust crate checkout function work?',
        limit: 2,
        embedder,
        store,
    });

    assert.equal(result.results[0].path, 'src/main.rs');
});

test('runSearch surfaces a result reachable only through the lexical (FTS) leg', async () => {
    const embedder = fakeEmbedder([[0.1, 0.2]]);
    const store = fakeStore({
        // The answer is NOT in the vector results — only the lexical leg can find it.
        //
        semanticRows: [{
            path: 'src/unrelated.js',
            lineStart: 1,
            lineEnd: 2,
            content: 'export const config = {};',
            score: 0.1,
        }],
        textRows: [{
            path: 'src/payments/refund.js',
            lineStart: 5,
            lineEnd: 9,
            content: 'export function processRefund() { return true; }',
            score: 0.2,
        }],
    });

    const result = await runSearch({
        queryText: 'where are refunds processed',
        limit: 3,
        embedder,
        store,
    });

    // If runSearch dropped or broke the lexical leg, this file could not appear.
    //
    assert.ok(
        result.results.some((row) => row.path === 'src/payments/refund.js'),
        JSON.stringify(result.results.map((r) => r.path))
    );
    // And the lexical leg is queried with the full natural-language question.
    //
    assert.ok(store.textQueries.includes('where are refunds processed'), JSON.stringify(store.textQueries));
});

test('runSearch ranks an integration route fact into top-k against competing semantic noise', async () => {
    const embedder = fakeEmbedder([[0.3, 0.4]]);
    const store = fakeStore({
        // A lure (go-notes) plus two unrelated semantic rows: with limit 3 and four
        // candidates, the graph route fact must actually out-rank a semantic row to
        // appear — so this fails if graph scoring is disabled, unlike a 2-candidate
        // /limit-2 setup where presence is guaranteed regardless of ranking.
        //
        semanticRows: [
            {path: 'src/docs/go-notes.js', lineStart: 1, lineEnd: 2, content: 'export const note = "Go route example";', score: 0.04},
            {path: 'src/alpha.js', lineStart: 1, lineEnd: 2, content: 'export const alpha = 1;', score: 0.05},
            {path: 'src/beta.js', lineStart: 1, lineEnd: 2, content: 'export const beta = 2;', score: 0.06},
        ],
        graphRows: [{
            path: 'cmd/server/main.go',
            lineStart: 10,
            lineEnd: 12,
            kind: 'route',
            name: 'GET /health',
            target: '/health',
            detail: 'registers a Go router handler',
        }],
    });

    const result = await runSearch({
        queryText: 'Explain the Go GET /health route',
        limit: 3,
        embedder,
        store,
    });

    // The non-JS file is reachable only via its graph route fact, and must rank
    // into the top 3 ahead of unrelated semantic rows.
    //
    assert.ok(
        result.results.some((row) => row.path === 'cmd/server/main.go'),
        JSON.stringify(result.results.map((r) => r.path))
    );
    const graphResult = result.results.find((row) => row.path === 'cmd/server/main.go');
    assert.equal(graphResult.similarity, null, 'graph rank must not impersonate cosine similarity');
    assert.ok(graphResult.origins.includes('graph'));
});

test('runSearch applies a semantic threshold only to the vector leg', async () => {
    const embedder = fakeEmbedder([[0.1, 0.2]]);
    const store = fakeStore({
        semanticRows: [{
            path: 'src/semantic-noise.js',
            lineStart: 1,
            lineEnd: 2,
            content: 'export const unrelated = true;',
            score: 0.7,
        }],
        textRows: [{
            path: 'src/payments/refund.js',
            lineStart: 5,
            lineEnd: 9,
            content: 'export function processRefund() { return true; }',
            score: 0.2,
        }],
    });

    const result = await runSearch({
        queryText: 'where are refunds processed',
        limit: 3,
        embedder,
        store,
        semanticThreshold: 0.45,
        legs: {lexical: true, graph: false, domainBoost: false},
    });

    assert.equal(result.threshold, 0.45);
    assert.equal(result.retrieval.counts.vectorCandidatesRaw, 1);
    assert.equal(result.retrieval.counts.vectorCandidates, 0);
    assert.deepEqual(result.results.map((row) => row.path), ['src/payments/refund.js']);
    assert.equal(result.results[0].similarity, null);
    assert.deepEqual(result.results[0].origins, ['lexical']);
});

test('runSearch preserves genuine vector confidence when graph retrieval finds the same chunk', async () => {
    const embedder = fakeEmbedder([[0.1, 0.2]]);
    const shared = {
        path: 'src/server.js',
        lineStart: 10,
        lineEnd: 12,
    };
    const store = fakeStore({
        semanticRows: [{
            ...shared,
            content: 'app.get("/health", handler);',
            score: 0.2,
        }],
        graphRows: [{
            ...shared,
            kind: 'route',
            name: 'GET /health',
            target: '/health',
            detail: 'declares a route',
        }],
    });

    const result = await runSearch({
        queryText: 'Explain GET /health route',
        // Force the duplicate graph/vector row through the top-k boundary; its
        // signals must be combined before truncation.
        limit: 1,
        embedder,
        store,
    });

    const row = result.results.find((item) => item.path === shared.path);
    assert.equal(row.similarity, 0.8);
    assert.ok(row.origins.includes('vector'));
    assert.ok(row.origins.includes('graph'));
});

test('runSearch applies an injected reranker to reorder results, preserving similarity', async () => {
    const embedder = fakeEmbedder([[0.1, 0.2]]);
    const store = fakeStore({
        semanticRows: [
            {path: 'src/a.js', lineStart: 1, lineEnd: 2, content: 'alpha', score: 0.1},
            {path: 'src/b.js', lineStart: 1, lineEnd: 2, content: 'beta', score: 0.2},
            {path: 'src/c.js', lineStart: 1, lineEnd: 2, content: 'gamma', score: 0.3},
        ],
    });
    // Promotes src/c.js to the front, so the effect is observable.
    //
    const reranker = {
        calls: [],
        async rerank(query, rows) {
            this.calls.push(query);
            const i = rows.findIndex((r) => r.path === 'src/c.js');
            if(i <= 0) {
                return rows;
            }
            const copy = rows.slice();
            const [target] = copy.splice(i, 1);
            return [target, ...copy];
        },
    };

    // Identifier-shaped query: the production shape policy only keeps the
    // reranker for identifier/relational shapes, and this test exercises the
    // reranker mechanism itself.
    //
    const without = await runSearch({queryText: 'where is unrelatedTerms defined', limit: 3, embedder, store});
    const reranked = await runSearch({queryText: 'where is unrelatedTerms defined', limit: 3, embedder, store, reranker});

    assert.notEqual(without.results[0].path, 'src/c.js');
    assert.equal(reranked.results[0].path, 'src/c.js');
    assert.equal(typeof reranked.results[0].similarity, 'number');
    assert.ok(reranker.calls.includes('where is unrelatedTerms defined'));
});

test('runSearch survives a throwing reranker, keeping fused results (never empties retrieval)', async () => {
    const embedder = fakeEmbedder([[0.1, 0.2]]);
    const store = fakeStore({
        semanticRows: [
            {path: 'src/a.js', lineStart: 1, lineEnd: 2, content: 'alpha', score: 0.1},
            {path: 'src/b.js', lineStart: 1, lineEnd: 2, content: 'beta', score: 0.2},
            {path: 'src/c.js', lineStart: 1, lineEnd: 2, content: 'gamma', score: 0.3},
        ],
    });
    const reranker = {
        async rerank() {
            throw new Error('cross-encoder exploded');
        },
    };

    const result = await runSearch({queryText: 'where is unrelatedTerms defined', limit: 3, embedder, store, reranker});

    assert.ok(result.results.length > 0);
    assert.ok(result.retrieval.modes.includes('rerank_failed'));
    assert.ok(!result.retrieval.modes.includes('rerank'));
});

test('runSearch demotes a dependency manifest below the real wiring file for a relational question', async () => {
    const embedder = fakeEmbedder([[0.1, 0.2]]);
    // package.json is intentionally returned FIRST by the vector leg, so the
    // demotion must overcome the base rank for the wiring file to win.
    //
    const store = fakeStore({
        semanticRows: [
            {path: 'package.json', lineStart: 1, lineEnd: 3, content: '{"dependencies":{"hono":"^4","vite":"^7"}}', score: 0.1},
            {path: 'vite.config.js', lineStart: 1, lineEnd: 5, content: "import devServer from '@hono/vite-dev-server';", score: 0.2},
        ],
    });

    const result = await runSearch({queryText: 'how do hono and vite work together', limit: 3, embedder, store});

    const wiringRank = result.results.findIndex((r) => r.path === 'vite.config.js');
    const manifestRank = result.results.findIndex((r) => r.path === 'package.json');
    assert.ok(wiringRank >= 0);
    assert.ok(manifestRank === -1 || wiringRank < manifestRank);
});

test('runSearch keeps the dependency manifest on top for a manifest-seeking question', async () => {
    const embedder = fakeEmbedder([[0.1, 0.2]]);
    const store = fakeStore({
        semanticRows: [
            {path: 'package.json', lineStart: 1, lineEnd: 3, content: '{"dependencies":{"hono":"^4","vite":"^7"}}', score: 0.1},
            {path: 'vite.config.js', lineStart: 1, lineEnd: 5, content: "import devServer from '@hono/vite-dev-server';", score: 0.2},
        ],
    });

    const result = await runSearch({queryText: 'what version of hono is installed in the dependencies', limit: 3, embedder, store});

    assert.equal(result.results[0].path, 'package.json');
});

test('runSearch never returns a .env or .env.example file', async () => {
    const embedder = fakeEmbedder([[0.1, 0.2]]);
    const store = fakeStore({
        semanticRows: [
            {path: '.env', lineStart: 1, lineEnd: 1, content: 'OPENAI_API_KEY=sk-secret', score: 0.05},
            {path: '.env.example', lineStart: 1, lineEnd: 1, content: 'OPENAI_API_KEY=', score: 0.1},
            {path: 'src/server.js', lineStart: 1, lineEnd: 2, content: 'export default app;', score: 0.2},
        ],
    });

    const result = await runSearch({queryText: 'where is the api key configured', limit: 5, embedder, store});

    const paths = new Set(result.results.map((r) => r.path));
    assert.ok(!paths.has('.env'));
    assert.ok(!paths.has('.env.example'));
    assert.ok(paths.has('src/server.js'));
});

test('runSearch legs.lexical=false disables the BM25 leg (ablation toggle)', async () => {
    const embedder = fakeEmbedder([[0.1, 0.2]]);
    const store = fakeStore({
        semanticRows: [{path: 'src/unrelated.js', lineStart: 1, lineEnd: 2, content: 'export const config = {};', score: 0.1}],
        textRows: [{path: 'src/payments/refund.js', lineStart: 5, lineEnd: 9, content: 'export function processRefund() { return true; }', score: 0.2}]
    });

    const withLexical = await runSearch({queryText: 'where are refunds processed', limit: 3, embedder, store});
    const noLexical = await runSearch({queryText: 'where are refunds processed', limit: 3, embedder, store, legs: {lexical: false}});

    assert.ok(withLexical.results.some((r) => r.path === 'src/payments/refund.js'), 'lexical-reachable row present by default');
    assert.ok(!noLexical.results.some((r) => r.path === 'src/payments/refund.js'), 'lexical-only row should vanish when the BM25 leg is off');
});

test('runSearch expands product questions through import neighbors but keeps identifier lookup precise', async () => {
    const embedder = fakeEmbedder([[0.1, 0.2], [0.1, 0.2]]);
    const seed = {
        path: 'src/checkout/service.js',
        lineStart: 1,
        lineEnd: 5,
        content: 'export async function processCheckout() { return repository.save(); }',
        score: 0.1
    };
    const repository = {
        path: 'src/checkout/repository.js',
        lineStart: 1,
        lineEnd: 4,
        content: 'export const repository = { save() {} };',
        score: 0.2
    };
    const store = {
        async searchByEmbedding() { return [seed]; },
        async searchByText() { return []; },
        async searchGraphByText() { return []; },
        async chunksForGraphRows() { return []; },
        async importEdges() { return [{path: seed.path, target: './repository.js'}]; },
        async knownPaths() { return [seed.path, repository.path]; },
        async firstChunkForPath(path) { return path === repository.path ? repository : null; }
    };

    const product = await runSearch({queryText: 'How does checkout processing work?', limit: 3, embedder, store});
    const identifier = await runSearch({queryText: 'where is processCheckout defined', limit: 3, embedder, store});

    const structural = product.results.find((row) => row.path === repository.path);
    assert.ok(structural, JSON.stringify(product.results.map((row) => row.path)));
    assert.ok(structural.origins.includes('graph_structural'));
    assert.equal(product.retrieval.counts.structuralGraphRows, 1);
    assert.ok(!identifier.results.some((row) => row.path === repository.path));
    assert.equal(identifier.retrieval.counts.structuralGraphRows, 0);
});

function fakeEmbedder(vectors = []) {
    return {
        calls: [],
        async embed(values) {
            this.calls.push([...values]);
            return vectors.length > 0 ? vectors : values.map(() => [0]);
        },
    };
}

function fakeStore({semanticRows, textRows, textRowsByTerm, graphRows} = {}) {
    return {
        embeddingQueries: [],
        textQueries: [],
        graphQueries: [],
        async searchByEmbedding(embedding) {
            this.embeddingQueries.push(embedding);
            return semanticRows ?? [{
                path: 'src/checkout.js',
                lineStart: 1,
                lineEnd: 3,
                content: 'export function checkout() {\n    return true;\n}',
                score: 0.1,
            }];
        },
        // runSearch now issues one BM25 query for the full natural-language
        // question, so a flat textRows list is returned for any query.
        //
        async searchByText(term) {
            this.textQueries.push(term);
            return textRows ?? textRowsByTerm?.get(term) ?? [];
        },
        async searchGraphByText(term) {
            this.graphQueries.push(term);
            return graphRows ?? [];
        },
        async chunksForGraphRows(rows) {
            return rows.map((row) => ({
                path: row.path,
                lineStart: row.lineStart,
                lineEnd: row.lineEnd,
                content: 'app.get("/api/health", (c) => c.json({ok: true}));',
                score: 0.2,
            }));
        },
    };
}

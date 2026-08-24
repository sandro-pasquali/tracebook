import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildEvidencePacket,
    buildEvidenceReadyEvent,
    evidenceForPlanItem,
    rankEvidenceItems,
    selectLayerDiverse,
    selectPathDiverse,
    wrapToolOutput,
} from '../../src/planner/evidence.js';

test('selectPathDiverse prefers unique paths before same-path fallbacks', () => {
    const first = {path: 'src/a.js', content: 'first'};
    const duplicatePath = {path: 'src/a.js', content: 'second'};
    const second = {path: 'src/b.js', content: 'third'};
    const third = {path: 'src/c.js', content: 'fourth'};
    const items = [first, duplicatePath, second, third];

    assert.deepEqual(selectPathDiverse(items, 0), []);
    assert.deepEqual(selectPathDiverse(items, 3), [first, second, third]);
    assert.deepEqual(selectPathDiverse(items, 4), [first, second, third, duplicatePath]);
});

test('selectLayerDiverse reserves evidence slots for distinct system layers', () => {
    const boundaryA = {path: 'src/server/routes.js'};
    const boundaryB = {path: 'src/server/admin-routes.js'};
    const data = {path: 'src/index/store.js'};
    const presentation = {path: 'public/js/app.js'};

    assert.deepEqual(selectLayerDiverse([boundaryA, boundaryB, data, presentation], 3), [
        boundaryA,
        data,
        presentation
    ]);
});

test('rankEvidenceItems preserves input order when scores tie', () => {
    const items = [
        {path: 'src/a.js', content: 'plain text'},
        {path: 'src/b.js', content: 'plain text'},
        {path: 'src/c.js', content: 'plain text'},
    ];

    assert.deepEqual(rankEvidenceItems(items, ''), items);
});

test('rankEvidenceItems boosts markup and stylesheet evidence for UI surface questions', () => {
    const ranked = rankEvidenceItems([
        {
            path: 'src/docs/html-helper.js',
            content: 'export const example = "HTML and CSS layout";',
        },
        {
            path: 'public/index.html',
            content: '<main class="stage"><section id="outlet"></section></main>',
        },
        {
            path: 'public/styles.css',
            content: '.stage { display: grid; gap: 16px; }',
        },
    ], 'How does the page layout HTML and CSS work?');

    assert.deepEqual(ranked.slice(0, 2).map((item) => item.path), [
        'public/index.html',
        'public/styles.css',
    ]);
});

test('rankEvidenceItems does not treat unsupported stylesheet dialects as indexed source families', () => {
    const ranked = rankEvidenceItems([
        {
            path: 'public/theme.scss',
            content: '.stage { color: red; }',
        },
        {
            path: 'public/styles.css',
            content: '.stage { color: blue; }',
        },
    ], 'How does the CSS style work?');

    assert.equal(ranked[0].path, 'public/styles.css');
});

test('rankEvidenceItems boosts evidence from the integration matched by the question', () => {
    const ranked = rankEvidenceItems([
        {
            path: 'src/server.js',
            content: 'export function checkout() { return true; }',
        },
        {
            path: 'src/main.rs',
            content: 'fn checkout() -> bool { true }',
        },
    ], 'How does the Rust crate checkout function work?');

    assert.equal(ranked[0].path, 'src/main.rs');
});

test('buildEvidencePacket extracts wrapped tool-result evidence and retrieval summary', () => {
    const searchResult = {
        count: 2,
        retrieval: {
            modes: ['embedding', 'vector'],
            timings: {totalMs: 12},
            counts: {
                results: 2,
                vectorCandidates: 4,
                graphRows: 1,
                lexicalRows: 0,
                supportRows: 0,
            },
        },
        results: [
            {
                path: 'src/tools/search.js',
                lineStart: 10,
                lineEnd: 11,
                similarity: 0.91,
                content: '10  export function runSearch() {\n11      return true;\n',
            },
            {
                path: 'src/tools/search.js',
                lineStart: 10,
                lineEnd: 11,
                similarity: 0.91,
                content: '10  export function runSearch() {\n11      return true;\n',
            },
        ],
    };

    const packet = buildEvidencePacket({
        question: 'How does search retrieval work?',
        explorationMessages: [{
            role: 'tool',
            content: [{
                type: 'tool-result',
                toolName: 'search_codebase',
                output: wrapToolOutput(searchResult),
            }],
        }],
    });

    assert.equal(packet.items.length, 1);
    assert.deepEqual(packet.retrieval, {
        searches: 1,
        modes: ['embedding', 'vector'],
        totalMs: 12,
        results: 2,
        vectorCandidates: 4,
        graphRows: 1,
        lexicalRows: 0,
        supportRows: 0,
    });
    assert.equal(packet.items[0].path, 'src/tools/search.js');
    assert.equal(packet.items[0].tool, 'search_codebase');
    assert.equal(packet.items[0].score, 0.91);
    assert.match(packet.outlineMessage, /Evidence packet/v);
});

test('evidence ready event carries corpus coverage separately from retrieved source items', () => {
    const coverage = {eligibleFiles: 8, indexedSourceFiles: 7, skippedFiles: 1, sourceRevision: 'rev-1'};
    const packet = buildEvidencePacket({
        question: 'Where is the entry point?',
        explorationMessages: [],
        corpusCoverage: coverage
    });

    const event = buildEvidenceReadyEvent(packet, {stage: 'prefetch'});

    assert.deepEqual(event.retrieval.coverage, coverage);
    assert.deepEqual(event.items, []);
});

test('evidence ready reports allowlisted evidence beyond the outline prompt budget', () => {
    const results = Array.from({length: 10}, (_, index) => ({
        path: `src/module-${index}.js`,
        lineStart: 1,
        lineEnd: 2,
        similarity: 0.9 - index / 100,
        content: `1  export const module${index} = true;`
    }));
    const packet = buildEvidencePacket({
        question: 'How do the modules work?',
        explorationMessages: [{
            role: 'tool',
            content: [{
                type: 'tool-result',
                toolName: 'search_codebase',
                output: wrapToolOutput({count: results.length, results})
            }]
        }]
    });

    const event = buildEvidenceReadyEvent(packet);

    assert.equal(event.items.length, 10);
});

test('buildEvidencePacket keeps dependency docs out of behavior outlines unless requested', () => {
    const searchResult = {
        count: 2,
        retrieval: {modes: ['lexical'], timings: {totalMs: 1}, counts: {results: 2}},
        results: [
            {
                path: 'src/server.js',
                lineStart: 20,
                lineEnd: 24,
                similarity: 0.8,
                content: '20  app.post("/api/oauth/callback", async (c) => {\n21      return handleOAuth(c);\n22  });',
            },
            {
                path: '__dependencies__/npm/vite.md',
                lineStart: 1,
                lineEnd: 8,
                similarity: 0.99,
                content: '1  # Dependency: vite\n2  Dev server and build tool.',
            },
        ],
    };
    const explorationMessages = [{
        role: 'tool',
        content: [{
            type: 'tool-result',
            toolName: 'search_codebase',
            output: wrapToolOutput(searchResult),
        }],
    }];

    const behaviorPacket = buildEvidencePacket({
        question: 'How does the OAuth callback request flow work?',
        explorationMessages,
    });
    const dependencyPacket = buildEvidencePacket({
        question: 'Which dependency or config powers the dev server?',
        explorationMessages,
    });

    assert.doesNotMatch(behaviorPacket.outlineMessage, /__dependencies__\/npm\/vite\.md/v);
    assert.match(dependencyPacket.outlineMessage, /__dependencies__\/npm\/vite\.md/v);
});

test('evidence ready event does not expose dependency docs for search flow questions', () => {
    const searchResult = {
        count: 3,
        retrieval: {modes: ['embedding'], timings: {totalMs: 1}, counts: {results: 3}},
        results: [
            {
                path: '__dependencies__/npm/lancedb__lancedb.md',
                lineStart: 1,
                lineEnd: 10,
                similarity: 0.99,
                content: '1  # Dependency: LanceDB\n2  Vector search package.',
            },
            {
                path: 'app/search-service.js',
                lineStart: 20,
                lineEnd: 30,
                similarity: 0.7,
                content: '20  export async function runSearch() {\n21      return store.search();\n22  }',
            },
            {
                path: 'server/routes.js',
                lineStart: 40,
                lineEnd: 55,
                similarity: 0.6,
                content: '40  app.post("/api/ask", async (c) => {\n41      return streamSSE(c, run);\n42  });',
            },
        ],
    };
    const explorationMessages = [{
        role: 'tool',
        content: [{
            type: 'tool-result',
            toolName: 'search_codebase',
            output: wrapToolOutput(searchResult),
        }],
    }];

    const packet = buildEvidencePacket({
        question: 'UI to server search flow via SSE',
        explorationMessages,
    });
    const event = buildEvidenceReadyEvent(packet, {stage: 'exploration'});

    // The api/server architecture boost ranks the route registration first for
    // a server/SSE question; the point under test is that the dependency doc
    // is excluded either way.
    //
    assert.deepEqual(event.items.map((item) => item.path), [
        'server/routes.js',
        'app/search-service.js',
    ]);
});

test('rankEvidenceItems folds plural and nominalized question tokens onto source forms', () => {
    const ranked = rankEvidenceItems([
        {path: 'src/notes/planning.js', content: 'export const planning = [];'},
        {path: 'src/server/item-routes.js', content: 'app.delete("/api/items/:id", handler);'},
    ], 'Are there apis that handle item deletion?');

    assert.equal(ranked[0].path, 'src/server/item-routes.js');
});

test('a deliberately read file outranks a keyword-dense search hit for the same question', () => {
    // The real failure shape: a heuristic file whose content is dense in the
    // question's vocabulary as string literals, versus the route file the
    // exploration model chose to read in full.
    //
    const readItem = {
        tool: 'read_file',
        path: 'src/server/story-routes.js',
        score: null,
        lineStart: 1,
        lineEnd: 30,
        content: 'app.delete("/api/stories/:id", async (c) => {\n    const result = await stories.remove(id);\n    return c.json({ok: true});\n});',
    };
    const keywordHit = {
        tool: 'search_codebase',
        path: 'src/planner/keywords.js',
        score: 0.55,
        lineStart: 1,
        lineEnd: 5,
        content: 'const terms = ["api", "endpoint", "route", "handler", "story"];',
    };

    const ranked = rankEvidenceItems([keywordHit, readItem], 'Are there apis that handle story deletion?');

    assert.equal(ranked[0].path, 'src/server/story-routes.js');
});

test('token scoring sees evidence content beyond the first 3000 characters', () => {
    const filler = 'x'.repeat(3500);
    const deep = {path: 'src/a.js', content: `${filler}\nstory not found for deletion`};
    const shallow = {path: 'src/b.js', content: filler};

    const ranked = rankEvidenceItems([shallow, deep], 'What happens on story deletion?');

    assert.equal(ranked[0].path, 'src/a.js');
});

test('evidenceForPlanItem blends top-ranked evidence past a wrong hint', () => {
    const question = 'Are there apis that handle story deletion?';
    const routeItem = {
        tool: 'read_file',
        path: 'src/server/story-routes.js',
        score: null,
        lineStart: 1,
        lineEnd: 30,
        content: 'app.delete("/api/stories/:id", async (c) => {\n    await stories.remove(id);\n    return c.json({ok: true});\n});',
    };
    const wrongHint = {
        tool: 'search_codebase',
        path: 'src/planner/keywords.js',
        score: 0.5,
        lineStart: 1,
        lineEnd: 5,
        content: 'const terms = ["api", "endpoint", "route"];',
    };
    const packet = {question, retrievalQuestion: question, items: [wrongHint, routeItem]};

    const selected = evidenceForPlanItem(packet, {
        id: 'api-endpoint-definition',
        kind: 'evidence_callout',
        sourceRefHint: [{path: 'src/planner/keywords.js', lineStart: 1, lineEnd: 5}],
    });

    assert.ok(selected.some((item) => item.path === 'src/planner/keywords.js'));
    assert.ok(selected.some((item) => item.path === 'src/server/story-routes.js'));
});

test('a behavior question keeps one ambient supporting slot but never dependency docs', () => {
    const searchResult = {
        count: 3,
        retrieval: {modes: ['embedding'], timings: {totalMs: 1}, counts: {results: 3}},
        results: [
            {
                path: 'src/cart/checkout.js',
                lineStart: 5,
                lineEnd: 18,
                similarity: 0.8,
                content: '5  export async function submitCheckout(order) {\n6      return post("/api/checkout", order);\n7  }',
            },
            {
                path: 'README.md',
                lineStart: 1,
                lineEnd: 10,
                similarity: 0.7,
                content: '1  # Shop\n2  Checkout flow posts orders to the server for processing.',
            },
            {
                path: '__dependencies__/npm/stripe.md',
                lineStart: 1,
                lineEnd: 6,
                similarity: 0.95,
                content: '1  # Dependency: stripe\n2  Payment processing client.',
            },
        ],
    };
    const packet = buildEvidencePacket({
        question: 'What happens when a customer submits checkout?',
        explorationMessages: [{
            role: 'tool',
            content: [{
                type: 'tool-result',
                toolName: 'search_codebase',
                output: wrapToolOutput(searchResult),
            }],
        }],
    });

    assert.match(packet.outlineMessage, /README\.md/v);
    assert.doesNotMatch(packet.outlineMessage, /__dependencies__\/npm\/stripe\.md/v);
});

test('whole-word prefix matching bridges code abbreviations to question vocabulary', () => {
    const ranked = rankEvidenceItems([
        {path: 'src/util/strings.js', content: 'export function pad(value) { return value.trim(); }'},
        {path: 'src/server.js', content: 'app.get("/admin", serveStatic({root: staticRoot, path: "index.html"}));'},
    ], 'How would I add a new administration panel that is linked to the existing ones?');

    assert.equal(ranked[0].path, 'src/server.js');

    const configRanked = rankEvidenceItems([
        {path: 'src/util/strings.js', content: 'export function pad(value) { return value.trim(); }'},
        {path: 'src/util/config.js', content: 'export const config = loadConfigFile(configPath);'},
    ], 'Where does the configuration get loaded?');

    assert.equal(configRanked[0].path, 'src/util/config.js');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyIntent, formatIntentForPrompt} from '../../src/intent-classifier.js';
import {rankEvidenceItems} from '../../src/planner/evidence-policy.js';
import {overviewSeedQueries} from '../../src/planner/phases/coverage.js';
import {isFastPathEligible} from '../../src/planner/phases/prefetch.js';
import {isSystemOverviewQuestion} from '../../src/util/retrieval-intent.js';

// Fix for system-overview questions: "How does this system work?" must reach
// scope=system, rank the repo's own documentation into the outline evidence,
// and seed the coverage backstop with the generic architecture spine — instead
// of sampling whatever subsystems retrieval happened to rank first.
//

test('isSystemOverviewQuestion truth table', () => {
    const yes = [
        'How does this system work?',
        'How does this codebase work?',
        'how does the whole project work',
        'Give me an overview of how this codebase works end to end',
        'what is the big picture architecture of this repo',
        'high level overview of the system',
        'What happens end to end when I ask a question about my code?'
    ];
    const no = [
        'how do hono and vite work together',
        'where is fuseByRrf defined',
        'how is a repeated question served from saved results instead of recomputing the response',
        'how does the file watcher keep the search index in sync',
        'what version of hono is installed',
        ''
    ];
    for(const q of yes) {
        assert.ok(isSystemOverviewQuestion(q), `should be overview: ${q}`);
    }
    for(const q of no) {
        assert.ok(!isSystemOverviewQuestion(q), `should NOT be overview: ${q}`);
    }
});

test('overview phrasings classify as system scope and emit the system_overview contract', () => {
    const questions = [
        'How does this system work?',
        'How does this codebase work?',
        'give me the big picture of this repository',
        // 'code' must not trip file scope when the question is an end-to-end walk.
        //
        'What happens end to end when I ask a question about my code?'
    ];
    for(const q of questions) {
        const c = classifyIntent({question: q});
        assert.equal(c.scope, 'system', q);
        assert.match(formatIntentForPrompt(c), /answerContract: system_overview/, q);
    }
});

test('feature questions are not flipped to system scope by the broadened regex', () => {
    for(const q of ['how does the app connect to the openai api to generate answers', 'how does the file watcher keep the search index in sync with the filesystem?']) {
        const c = classifyIntent({question: q});
        assert.notEqual(formatIntentForPrompt(c).includes('system_overview'), true, q);
    }
});

test('overview questions rank repo documentation above deep source; other questions are untouched', () => {
    const items = [
        {path: 'src/planner/grounding/callouts.js', content: 'export function planCallouts() {}', score: 0.5},
        {path: 'README.md', content: '# Tracebook\nTurns a local codebase into source-grounded product stories.', score: 0.45}
    ];
    const overviewRanked = rankEvidenceItems(items, 'How does this system work?');
    assert.equal(overviewRanked[0].path, 'README.md');

    const specificRanked = rankEvidenceItems(items, 'where are callout notes planned and selected');
    assert.equal(specificRanked[0].path, 'src/planner/grounding/callouts.js');
});

test('overview questions never take the fast path, even with strong narrow matches', () => {
    const prefetchResult = {results: [{path: 'src/server.js', similarity: 0.95}]};
    assert.equal(isFastPathEligible({question: 'How does this system work?', prefetchResult}), false);
    // A short, specific question with the same evidence still fast-paths.
    //
    assert.equal(isFastPathEligible({question: 'where is the server started', prefetchResult}), true);
});

test('computeImportHubs ranks orchestrators by project-local out-degree across resolution styles', async () => {
    const {computeImportHubs} = await import('../../src/index/graph-hubs.js');
    const store = {
        async importEdges() {
            return [
                {path: 'src/server.js', target: './planner/index.js'},
                {path: 'src/server.js', target: './index/indexer.js'},
                {path: 'src/server.js', target: './util/config.js'},
                {path: 'src/server.js', target: 'hono'},
                {path: 'src/planner/index.js', target: '../util/config.js'},
                {path: 'src/planner/index.js', target: './phases/outline.js'},
                {path: 'src/flask/cli.py', target: 'flask.app'},
                {path: 'src/util/leaf.js', target: '../util/config.js'}
            ];
        },
        async knownPaths() {
            return ['src/server.js', 'src/planner/index.js', 'src/index/indexer.js', 'src/util/config.js', 'src/planner/phases/outline.js', 'src/flask/app.py', 'src/flask/cli.py', 'src/util/leaf.js'];
        }
    };
    const hubs = await computeImportHubs({store, limit: 3});
    assert.equal(hubs[0].path, 'src/server.js');
    assert.equal(hubs[0].wires, 3);
    assert.equal(hubs[1].path, 'src/planner/index.js');
    // Python dotted module resolved by suffix: flask.app -> src/flask/app.py.
    //
    assert.ok(hubs.some((h) => h.path === 'src/flask/cli.py' && h.wires === 1));
});

test('expandImportNeighbors finds both callees and callers from retrieved seed files', async () => {
    const {expandImportNeighbors} = await import('../../src/index/graph-hubs.js');
    const store = {
        async importEdges() {
            return [
                {path: 'src/checkout/service.js', target: './repository.js'},
                {path: 'src/server/routes.js', target: '../checkout/service.js'}
            ];
        },
        async knownPaths() {
            return ['src/checkout/service.js', 'src/checkout/repository.js', 'src/server/routes.js'];
        }
    };

    const neighbors = await expandImportNeighbors({store, seedPaths: ['src/checkout/service.js'], limit: 4});

    assert.deepEqual(neighbors, [
        {path: 'src/checkout/repository.js', relatedTo: 'src/checkout/service.js', direction: 'imports'},
        {path: 'src/server/routes.js', relatedTo: 'src/checkout/service.js', direction: 'imported_by'}
    ]);
});

test('selectArchitectureSpine balances central hubs across architecture roles', async () => {
    const {selectArchitectureSpine} = await import('../../src/index/graph-hubs.js');
    const spine = selectArchitectureSpine([
        {path: 'src/server/runtime-manager.js', wires: 18},
        {path: 'public/js/app.js', wires: 16},
        {path: 'src/server.js', wires: 16},
        {path: 'src/planner/index.js', wires: 14},
        {path: 'src/planner/phases/outline.js', wires: 12},
        {path: 'src/index/indexer.js', wires: 10}
    ], 5);

    assert.deepEqual(spine.map((hub) => hub.path), [
        'src/server.js',
        'src/planner/index.js',
        'src/index/indexer.js',
        'public/js/app.js',
        'src/server/runtime-manager.js'
    ]);
});

test('overviewSeedQueries fires only for system-scope overview questions', () => {
    const overview = overviewSeedQueries({
        question: 'How does this system work?',
        classification: {scope: 'system'}
    });
    assert.ok(overview.length >= 4);
    assert.ok(overview.some((q) => /entry point/.test(q)));

    assert.deepEqual(overviewSeedQueries({question: 'How does this system work?', classification: {scope: 'feature'}}), []);
    assert.deepEqual(overviewSeedQueries({question: 'how does the watcher debounce work', classification: {scope: 'system'}}), []);
});

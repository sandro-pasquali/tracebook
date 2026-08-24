import test from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createIndexer} from '../../src/index/indexer.js';
import {createStore} from '../../src/index/store.js';

test('indexer sourceRevision is stable for unchanged content and changes after updates', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-'));
    await fs.writeFile(path.join(root, 'app.js'), 'export const value = 1;\n');
    const store = createMemoryStore();
    const indexer = createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0, 0, 0]);
            },
        },
        store,
    });

    const first = await indexer.indexAll();
    const same = await indexer.indexFile('app.js');
    await fs.writeFile(path.join(root, 'app.js'), 'export const value = 2;\n');
    const changed = await indexer.indexFile('app.js');
    const snapshot = await indexer.snapshot();

    assert.equal(typeof first.sourceRevision, 'string');
    assert.equal(first.coverage.eligibleFiles, 1);
    assert.equal(first.coverage.indexedSourceFiles, 1);
    assert.equal(first.coverage.skippedFiles, 0);
    assert.equal(first.coverage.sourceRevision, first.sourceRevision);
    assert.equal(first.coverage.policyLimitations.maximumFileBytes, 1_000_000);
    assert.equal(same.sourceRevision, first.sourceRevision);
    assert.notEqual(changed.sourceRevision, first.sourceRevision);
    assert.equal(snapshot.sourceRevision, changed.sourceRevision);
    assert.equal(snapshot.coverage.indexedSourceFiles, 1);
    assert.ok(snapshot.lastIndexedAt >= first.lastIndexedAt);
});

test('indexer source revision mirrors the store through add, change, and remove churn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-revision-'));
    await fs.mkdir(path.join(root, 'src'), {recursive: true});
    await fs.writeFile(path.join(root, 'a.js'), 'export const a = 1;\n');
    await fs.writeFile(path.join(root, 'b.js'), 'export const b = 1;\n');
    await fs.writeFile(path.join(root, 'src', 'c.js'), 'export const c = 1;\n');
    const store = createMemoryStore();
    const makeIndexer = () => createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0, 0, 0]);
            },
        },
        store,
    });
    const indexer = makeIndexer();

    // After every mutation the revision reported from the in-memory mirror must
    // equal a revision recomputed directly from the store, proving the mirror
    // never drifts from on-disk state.
    //
    async function assertMirrorsStore(reported) {
        assert.equal(reported, await revisionFromStore(store));
        return reported;
    }

    const seen = new Set();
    seen.add(await assertMirrorsStore((await indexer.indexAll()).sourceRevision));

    await fs.writeFile(path.join(root, 'b.js'), 'export const b = 2;\n');
    seen.add(await assertMirrorsStore((await indexer.indexFile('b.js')).sourceRevision));

    await fs.writeFile(path.join(root, 'd.js'), 'export const d = 1;\n');
    seen.add(await assertMirrorsStore((await indexer.indexFile('d.js')).sourceRevision));

    await fs.rm(path.join(root, 'a.js'));
    seen.add(await assertMirrorsStore((await indexer.indexFile('a.js')).sourceRevision));

    seen.add(await assertMirrorsStore((await indexer.removeFile('src/c.js')).sourceRevision));

    // Distinct content sets must yield distinct revisions.
    //
    assert.equal(seen.size, 5);

    // A fresh indexer over the already-populated store seeds its mirror from the
    // store on first use (the process-restart path).
    //
    await fs.writeFile(path.join(root, 'b.js'), 'export const b = 3;\n');
    const seeded = await makeIndexer().indexFile('b.js');
    await assertMirrorsStore(seeded.sourceRevision);
});

test('reindexing changed content leaves no stale or duplicate rows (skipDelete only when absent)', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-dedup-repo-'));
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-dedup-data-'));
    const store = await createStore({root: dataRoot, dims: 4});
    const indexer = createIndexer({
        root: repoRoot,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0, 0, 0, 0]);
            },
        },
        store,
    });

    await fs.writeFile(path.join(repoRoot, 'a.js'), 'export function alpha() {\n    return "OLD_TOKEN";\n}\n');
    const all = await indexer.indexAll();
    assert.equal(await store.count(), all.totalChunksIndexed, 'cold index row count matches chunks produced');

    // Change the file: the delete-then-add path must replace the rows, not append.
    //
    await fs.writeFile(path.join(repoRoot, 'a.js'), 'export function alpha() {\n    return "NEW_TOKEN_VALUE";\n}\n');
    const changed = await indexer.indexFile('a.js');
    assert.equal(changed.indexed, true);
    assert.equal(await store.count(), changed.chunks, 'changed file leaves only its own rows (no stale v1 rows)');
    assert.deepEqual(await store.knownPaths(), ['a.js']);

    // A brand-new file uses the skipDelete (insert-only) path and still lands.
    //
    await fs.writeFile(path.join(repoRoot, 'b.js'), 'export function beta() {\n    return 1;\n}\n');
    const added = await indexer.indexFile('b.js');
    assert.equal(added.indexed, true);
    assert.equal(await store.count(), changed.chunks + added.chunks);
    assert.deepEqual(await store.knownPaths(), ['a.js', 'b.js']);

    // Unchanged re-index is skipped and changes nothing.
    //
    const again = await indexer.indexFile('a.js');
    assert.equal(again.skipped, true);
    assert.equal(await store.count(), changed.chunks + added.chunks);
});

test('batched indexAll produces the same store contents as per-file indexing', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-equiv-repo-'));
    await fs.mkdir(path.join(repoRoot, 'src', 'svc'), {recursive: true});
    await fs.writeFile(path.join(repoRoot, 'app.js'), 'export function app() {\n    return route();\n}\n');
    await fs.writeFile(path.join(repoRoot, 'src', 'server.js'), 'export function route() {\n    return handle();\n}\n');
    await fs.writeFile(path.join(repoRoot, 'src', 'svc', 'order.js'), 'export function handle() {\n    return 42;\n}\n');

    const embedder = {
        async embed(items) {
            return items.map(() => [0, 0, 0, 0]);
        },
    };
    const newIndexer = async () => {
        const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-equiv-data-'));
        const store = await createStore({root: dataRoot, dims: 4});
        return {store, indexer: createIndexer({root: repoRoot, include: ['**/*.js'], exclude: [], embedder, store})};
    };

    const batched = await newIndexer();
    await batched.indexer.indexAll();

    const perFile = await newIndexer();
    for(const rel of await perFile.indexer.listFiles()) {
        await perFile.indexer.indexFile(rel);
    }
    await perFile.indexer.optimize();

    assert.deepEqual(await batched.store.knownPaths(), await perFile.store.knownPaths());
    assert.equal(await batched.store.count(), await perFile.store.count());
    assert.equal(await batched.store.countCodeGraph(), await perFile.store.countCodeGraph());
});

test('indexer exposes matching write result shape from single-file and batched plans', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-plan-shape-'));
    await fs.mkdir(path.join(repoRoot, 'src'), {recursive: true});
    await fs.writeFile(path.join(repoRoot, 'src', 'app.js'), [
        'export function app() {',
        '    return route();',
        '}',
    ].join('\n'));
    const embedder = {
        async embed(items) {
            return items.map(() => [0, 0, 0, 0]);
        },
    };

    const singleStore = createMemoryStore();
    const singleIndexer = createIndexer({
        root: repoRoot,
        include: ['**/*.js'],
        exclude: [],
        embedder,
        store: singleStore,
    });
    const single = await singleIndexer.indexFile('src/app.js');

    const batchStore = createMemoryStore();
    const batchIndexer = createIndexer({
        root: repoRoot,
        include: ['**/*.js'],
        exclude: [],
        embedder,
        store: batchStore,
    });
    const events = [];
    await batchIndexer.indexAll({onProgress: (event) => events.push(event)});
    const batch = events.find((event) => event.kind === 'source' && event.rel === 'src/app.js');

    assert.deepEqual(
        pickIndexResult(batch),
        pickIndexResult(single),
    );
});

test('batched indexAll assigns each chunk its own embedding (no cross-file mis-slicing)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-slice-'));
    const markers = ['MARKER_A', 'MARKER_B', 'MARKER_C', 'MARKER_D'];
    for(let i = 0; i < markers.length; i++) {
        await fs.writeFile(path.join(root, `f${i}.js`), `export const tag = "${markers[i]}";\n`);
    }
    const store = createMemoryStore();
    const indexer = createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        // Encode which marker the embed text contains into the vector. Embedding is
        // deferred and batched across files, so a slice-back bug would hand a file
        // another file's vector — which this assertion would catch.
        //
        embedder: {
            async embed(items) {
                return items.map((text) => markers.map((m) => (text.includes(m) ? 1 : 0)));
            },
        },
        store,
    });

    await indexer.indexAll();

    const byPath = new Map(store.rows().map((row) => [row.path, [...row.embedding]]));
    for(let i = 0; i < markers.length; i++) {
        const expected = markers.map((_, j) => (j === i ? 1 : 0));
        assert.deepEqual(byPath.get(`f${i}.js`), expected, `f${i}.js must carry its own marker embedding`);
    }
});

test('indexAll over a changed repo matches a fresh index (no stale rows from changed/removed files)', async () => {
    const embedder = {
        async embed(items) {
            return items.map(() => [0, 0, 0, 0]);
        },
    };
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-warm-repo-'));
    await fs.writeFile(path.join(repoRoot, 'a.js'), 'export const a = 1;\n');
    await fs.writeFile(path.join(repoRoot, 'b.js'), 'export const b = 1;\n');
    await fs.writeFile(path.join(repoRoot, 'c.js'), 'export const c = 1;\n');

    const warmData = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-warm-data-'));
    const warmStore = await createStore({root: warmData, dims: 4});
    const warm = createIndexer({root: repoRoot, include: ['**/*.js'], exclude: [], embedder, store: warmStore});
    await warm.indexAll();

    // Change a, add d, remove c — then re-index the same store.
    //
    await fs.writeFile(path.join(repoRoot, 'a.js'), 'export const a = 2;\nexport const a2 = 3;\n');
    await fs.writeFile(path.join(repoRoot, 'd.js'), 'export const d = 1;\n');
    await fs.rm(path.join(repoRoot, 'c.js'));
    const warmStats = await warm.indexAll();

    // A from-scratch index of the final repo state is the ground truth.
    //
    const freshData = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-fresh-data-'));
    const freshStore = await createStore({root: freshData, dims: 4});
    const fresh = createIndexer({root: repoRoot, include: ['**/*.js'], exclude: [], embedder, store: freshStore});
    const freshStats = await fresh.indexAll();

    assert.deepEqual(await warmStore.knownPaths(), ['a.js', 'b.js', 'd.js']);
    assert.deepEqual(await warmStore.knownPaths(), await freshStore.knownPaths());
    assert.equal(await warmStore.count(), await freshStore.count(), 'warm rebuild leaves no stale rows vs a fresh index');
    assert.equal(await warmStore.countCodeGraph(), await freshStore.countCodeGraph());
    assert.equal(warmStats.sourceRevision, freshStats.sourceRevision, 'same content yields the same revision regardless of history');
    assert.equal(warmStats.sourceRevision, await revisionFromStore(warmStore));
});

test('indexer default excludes keep test files out of the source corpus', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-excludes-'));
    await fs.mkdir(path.join(root, 'src', '__tests__'), {recursive: true});
    await fs.mkdir(path.join(root, 'node_modules', 'pkg'), {recursive: true});
    await fs.mkdir(path.join(root, 'dist'), {recursive: true});
    await fs.mkdir(path.join(root, 'coverage'), {recursive: true});
    await fs.mkdir(path.join(root, 'test', 'unit'), {recursive: true});
    await fs.writeFile(path.join(root, 'src', 'server.js'), 'export function handleRequest() {}\n');
    await fs.writeFile(path.join(root, 'src', '__tests__', 'server.test.js'), 'test("request", () => {});\n');
    await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'export const dependency = true;\n');
    await fs.writeFile(path.join(root, 'dist', 'bundle.js'), 'export const bundled = true;\n');
    await fs.writeFile(path.join(root, 'coverage', 'report.js'), 'export const covered = true;\n');
    await fs.writeFile(path.join(root, 'test', 'unit', 'server.test.js'), 'test("server", () => {});\n');
    const store = createMemoryStore();
    const indexer = createIndexer({
        root,
        include: ['**/*.js'],
        embedder: {
            async embed(items) {
                return items.map(() => [0]);
            },
        },
        store,
    });
    const events = [];

    await indexer.indexAll({onProgress: (event) => events.push(event)});

    assert.deepEqual(await store.knownPaths(), ['src/server.js']);
    assert.deepEqual(
        events.filter((event) => event.rel).map((event) => event.rel),
        ['src/server.js', 'src/server.js']
    );
});

test('indexer keeps shared docs while skipping unsupported source types', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-supported-'));
    await fs.writeFile(path.join(root, 'app.py'), 'def handle_request():\n    return True\n');
    await fs.writeFile(path.join(root, 'README.md'), 'implementation notes\n');
    await fs.writeFile(path.join(root, 'styles.scss'), '$color: red;\n.button { color: $color; }\n');
    const store = createMemoryStore();
    const indexer = createIndexer({
        root,
        include: ['**/*'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0]);
            },
        },
        store,
    });

    await indexer.indexAll();

    assert.deepEqual(await store.knownPaths(), ['README.md', 'app.py']);
});

test('indexer keeps supported source above the tree-sitter size limit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-large-source-'));
    const content = Array.from({length: 10_000}, (_, index) =>
        `export const value${index} = "${'x'.repeat(55)}";`,
    ).join('\n');
    assert.ok(content.length > 750_000);
    assert.ok(Buffer.byteLength(content, 'utf8') < 1_000_000);
    await fs.writeFile(path.join(root, 'large.js'), content);
    const store = createMemoryStore();
    const indexer = createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0]);
            },
        },
        store,
    });

    const stats = await indexer.indexAll();

    assert.equal(stats.indexedFiles, 1);
    assert.ok(stats.totalChunksIndexed > 0);
    assert.deepEqual(await store.knownPaths(), ['large.js']);
});

test('indexer excludes files and dependency manifests matched by repo ignore files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-ignore-'));
    await fs.mkdir(path.join(root, 'src'), {recursive: true});
    await fs.mkdir(path.join(root, 'ignored'), {recursive: true});
    await fs.writeFile(path.join(root, '.gitignore'), [
        'ignored/**',
        'package.json',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'src', 'server.js'), 'export function handleRequest() {}\n');
    await fs.writeFile(path.join(root, 'ignored', 'server.js'), 'export function ignoredRequest() {}\n');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({dependencies: {leftpad: '^1.0.0'}}));
    const store = createMemoryStore();
    const indexer = createIndexer({
        root,
        include: ['**/*.js', '**/package.json'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0]);
            },
        },
        store,
    });

    const stats = await indexer.indexAll();

    assert.equal(stats.files, 1);
    assert.equal(stats.dependencyFiles, 0);
    assert.deepEqual(await store.knownPaths(), ['src/server.js']);
});

test('a .tracebookignore can override a built-in default exclude, but not source-type gating', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-override-'));
    await fs.mkdir(path.join(root, 'data'), {recursive: true});
    await fs.writeFile(path.join(root, 'app.js'), 'export const a = 1;\n');
    await fs.writeFile(path.join(root, 'data', 'model.js'), 'export const m = 1;\n');
    await fs.writeFile(path.join(root, 'keep.spec.js'), 'export const k = 1;\n');
    await fs.writeFile(path.join(root, 'drop.spec.js'), 'export const d = 1;\n');
    await fs.writeFile(path.join(root, 'note.unknownext'), 'not a source type\n');
    // Re-include defaults (/data/ and *.spec.*) and try to force an unsupported type.
    //
    await fs.writeFile(path.join(root, '.tracebookignore'), [
        '!data/',
        '!data/**',
        '!keep.spec.js',
        '!note.unknownext',
    ].join('\n'));
    const store = createMemoryStore();
    const indexer = createIndexer({
        root,
        include: ['**/*.js', '**/*.unknownext'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0]);
            },
        },
        store,
    });

    await indexer.indexAll();
    const known = await store.knownPaths();

    assert.ok(known.includes('data/model.js'), 'negation re-includes a default-excluded dir');
    assert.ok(known.includes('keep.spec.js'), 'negation re-includes a default-excluded file');
    assert.ok(!known.includes('drop.spec.js'), 'a non-negated *.spec.* file stays excluded by default');
    assert.ok(!known.includes('note.unknownext'), 'source-type gating is NOT overridable by negation');
});

test('indexer honors a .tracebookignore file (folder exclude and glob negation)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-tbignore-'));
    await fs.mkdir(path.join(root, 'src'), {recursive: true});
    await fs.mkdir(path.join(root, 'build'), {recursive: true});
    await fs.writeFile(path.join(root, '.tracebookignore'), [
        'build/',
        '*.tmp.js',
        '!important.tmp.js',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'src', 'app.js'), 'export const a = 1;\n');
    await fs.writeFile(path.join(root, 'build', 'bundle.js'), 'export const b = 1;\n');
    await fs.writeFile(path.join(root, 'scratch.tmp.js'), 'export const c = 1;\n');
    await fs.writeFile(path.join(root, 'important.tmp.js'), 'export const d = 1;\n');
    const store = createMemoryStore();
    const indexer = createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0]);
            },
        },
        store,
    });

    await indexer.indexAll();

    // build/ folder excluded; scratch.tmp.js excluded by glob; important.tmp.js
    // re-included by the negation; src/app.js kept.
    //
    assert.deepEqual(await store.knownPaths(), ['important.tmp.js', 'src/app.js']);
});

test('indexAll reports discovered work before per-file progress', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-progress-'));
    await fs.writeFile(path.join(root, 'app.js'), 'export const value = 1;\n');
    const store = createMemoryStore();
    await store.upsertFile('stale.js', [{contentHash: 'stale-content'}]);
    const indexer = createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0]);
            },
        },
        store,
    });
    const events = [];

    const stats = await indexer.indexAll({onProgress: (event) => events.push(event)});

    assert.equal(stats.removedFiles, 1);
    assert.equal(events[0].kind, 'discovered');
    assert.equal(events[0].sourceFiles, 1);
    assert.equal(events[0].dependencyFiles, 0);
    assert.equal(events[0].removedFiles, 1);
    assert.equal(events[0].totalFiles, 2);
    // The batched flush after the per-file loop embeds the buffered chunks and
    // emits an 'embedding' progress event so the run doesn't appear frozen during
    // the embed.
    //
    assert.deepEqual(events.map((event) => event.kind), ['discovered', 'removed', 'source_start', 'source', 'embedding']);
});

test('indexer handles mixed repos with source, surface, config, docs, dependencies, and ignore rules', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-mixed-'));
    await fs.mkdir(path.join(root, 'src'), {recursive: true});
    await fs.mkdir(path.join(root, 'cmd', 'api'), {recursive: true});
    await fs.mkdir(path.join(root, 'public'), {recursive: true});
    await fs.mkdir(path.join(root, 'docs'), {recursive: true});
    await fs.mkdir(path.join(root, 'tests'), {recursive: true});
    await fs.mkdir(path.join(root, 'build'), {recursive: true});
    await fs.mkdir(path.join(root, 'ignored'), {recursive: true});
    await fs.mkdir(path.join(root, 'node_modules', 'pkg'), {recursive: true});

    await fs.writeFile(path.join(root, '.gitignore'), [
        'ignored/**',
        'build/**',
        '*.generated.py',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'README.md'), '# Mixed repo\n');
    await fs.writeFile(path.join(root, 'docs', 'architecture.md'), 'The API renders a browser surface.\n');
    await fs.writeFile(path.join(root, '.env.example'), 'API_TOKEN=\n');
    await fs.writeFile(path.join(root, 'requirements.txt'), 'fastapi==0.115.0\n');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({dependencies: {marked: '^12.0.0'}}));
    await fs.writeFile(path.join(root, 'src', 'server.py'), [
        'import os',
        '@app.get("/orders")',
        'def list_orders():',
        '    return os.environ.get("API_TOKEN")',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'cmd', 'api', 'main.go'), [
        'package main',
        'import "net/http"',
        'func main() {',
        '    http.HandleFunc("/health", health)',
        '}',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'public', 'index.html'), '<main id="app"><button>Ask</button></main>\n');
    await fs.writeFile(path.join(root, 'public', 'styles.css'), '#app { display: grid; }\n');
    await fs.writeFile(path.join(root, 'styles.scss'), '$gap: 8px;\n');
    await fs.writeFile(path.join(root, 'notes.txt'), 'not indexed\n');
    await fs.writeFile(path.join(root, 'tests', 'server.py'), 'def test_orders(): pass\n');
    await fs.writeFile(path.join(root, 'build', 'main.go'), 'package main\n');
    await fs.writeFile(path.join(root, 'ignored', 'server.py'), 'def ignored(): pass\n');
    await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'export const ignored = true;\n');
    await fs.writeFile(path.join(root, 'ignored.generated.py'), 'def generated(): pass\n');

    const store = createMemoryStore();
    const indexer = createIndexer({
        root,
        embedder: {
            async embed(items) {
                return items.map(() => [0]);
            },
        },
        store,
    });

    const stats = await indexer.indexAll();
    const physicalPaths = (await store.knownPaths()).filter((rel) => !rel.startsWith('__dependencies__/'));

    assert.deepEqual(physicalPaths, [
        'README.md',
        'cmd/api/main.go',
        'docs/architecture.md',
        'package.json',
        'public/index.html',
        'public/styles.css',
        'requirements.txt',
        'src/server.py',
    ]);
    assert.ok(stats.dependencyFiles > 0);
    assert.ok((await store.knownPaths()).some((rel) => rel.startsWith('__dependencies__/')));
    assert.ok(store.graphRows().some((row) => row.path === 'src/server.py' && row.kind === 'route' && row.name === 'GET /orders'));
    assert.ok(store.graphRows().some((row) => row.path === 'src/server.py' && row.kind === 'configuration' && row.name === 'API_TOKEN'));
    assert.ok(store.graphRows().some((row) => row.path === 'cmd/api/main.go' && row.kind === 'route' && row.name === 'HANDLE /health'));
});

test('dependency docs cover runtime deps but skip devDependencies', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-runtimedeps-'));
    await fs.writeFile(path.join(root, 'app.js'), 'export const a = 1;\n');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
        dependencies: {marked: '^12.0.0'},
        devDependencies: {xo: '^2.0.0', c8: '^11.0.0'}
    }));
    const store = createMemoryStore();
    await createIndexer({
        root,
        embedder: {
            async embed(items) {
                return items.map(() => [0]);
            },
        },
        store,
    }).indexAll();

    const deps = new Set((await store.knownPaths()).filter((p) => p.startsWith('__dependencies__/npm/')));
    assert.ok(deps.has('__dependencies__/npm/marked.md'), 'runtime dependency is documented');
    assert.ok(!deps.has('__dependencies__/npm/xo.md'), 'devDependency xo is skipped');
    assert.ok(!deps.has('__dependencies__/npm/c8.md'), 'devDependency c8 is skipped');
    assert.ok(deps.has('__dependencies__/npm/manifest.md'), 'manifest overview is still indexed');
});

test('indexDependencies:false skips dependency docs; default indexes them', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-nodeps-'));
    await fs.writeFile(path.join(root, 'app.js'), 'export const a = 1;\n');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({dependencies: {marked: '^12.0.0'}}));
    const embedder = {
        async embed(items) {
            return items.map(() => [0]);
        },
    };

    const onStore = createMemoryStore();
    const onStats = await createIndexer({root, embedder, store: onStore}).indexAll();
    assert.ok(onStats.dependencyFiles > 0, 'dependency docs indexed by default');
    assert.ok((await onStore.knownPaths()).some((p) => p.startsWith('__dependencies__/')));

    const offStore = createMemoryStore();
    const offStats = await createIndexer({root, embedder, store: offStore, indexDependencies: false}).indexAll();
    assert.equal(offStats.dependencyFiles, 0, 'no dependency files when disabled');
    assert.ok(!(await offStore.knownPaths()).some((p) => p.startsWith('__dependencies__/')), 'no virtual dependency docs when disabled');
    assert.ok((await offStore.knownPaths()).includes('package.json'), 'the manifest itself is still indexed');
});

test('indexer reindexes unchanged content when index fingerprint changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-fingerprint-'));
    await fs.writeFile(path.join(root, 'app.js'), 'export const value = 1;\n');
    const store = createMemoryStore();

    const firstIndexer = createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            provider: 'local',
            model: 'model-a',
            dims: 1,
            async embed(items) {
                return items.map(() => [0]);
            },
        },
        store,
    });
    const first = await firstIndexer.indexAll();

    const secondIndexer = createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            provider: 'local',
            model: 'model-b',
            dims: 1,
            async embed(items) {
                return items.map(() => [0]);
            },
        },
        store,
    });
    const changed = await secondIndexer.indexFile('app.js');

    assert.notEqual(secondIndexer.indexFingerprint, firstIndexer.indexFingerprint);
    assert.equal(changed.indexed, true);
    assert.notEqual(changed.sourceRevision, first.sourceRevision);
});

test('indexer reindexes when embedding dtype or doc prefix changes, but not for query prefix', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-dtype-fp-'));
    await fs.writeFile(path.join(root, 'app.js'), 'export const value = 1;\n');
    const store = createMemoryStore();
    const make = (attrs) => createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            provider: 'local',
            model: 'm',
            dims: 1,
            dtype: 'fp32',
            docPrefix: '',
            queryPrefix: '',
            async embed(items) {
                return items.map(() => [0]);
            },
            ...attrs
        },
        store,
    });

    const base = make({});
    await base.indexAll();

    // Changing dtype changes the stored vectors -> fingerprint changes -> reindex.
    //
    const q8 = make({dtype: 'q8'});
    const afterDtype = await q8.indexFile('app.js');
    assert.notEqual(q8.indexFingerprint, base.indexFingerprint);
    assert.equal(afterDtype.indexed, true);

    // Changing the document prefix changes the indexed text -> reindex.
    //
    const docp = make({dtype: 'q8', docPrefix: 'passage: '});
    const afterDoc = await docp.indexFile('app.js');
    assert.notEqual(docp.indexFingerprint, q8.indexFingerprint);
    assert.equal(afterDoc.indexed, true);

    // The query prefix only affects query-time vectors (never persisted), so it is
    // excluded from the fingerprint: changing it alone must NOT reindex.
    //
    const qp = make({dtype: 'q8', docPrefix: 'passage: ', queryPrefix: 'query: '});
    const afterQuery = await qp.indexFile('app.js');
    assert.equal(qp.indexFingerprint, docp.indexFingerprint);
    assert.equal(afterQuery.skipped, true);
});

test('indexAll calls store.optimize() so newly indexed FTS rows become searchable', async () => {
    // LanceDB does not reliably search rows added after an FTS index was built
    // until the table is optimized, so indexAll must call optimize(). This pins
    // that wiring deterministically (unlike a real-store toggle, which depends on
    // row count). store.optimize() making rows searchable is covered in
    // test/integration/store-lexical.test.js.
    //
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-optimize-'));
    await fs.writeFile(path.join(root, 'app.js'), 'export const value = 1;\n');
    const store = createMemoryStore();
    const indexer = createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0]);
            },
        },
        store,
    });

    await indexer.indexAll();

    assert.ok(store.optimizeCalls() >= 1, 'indexAll must call store.optimize()');
});

test('indexer removes paths and updates source revision for deleted files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-remove-'));
    await fs.writeFile(path.join(root, 'app.js'), 'export const value = 1;\n');
    const store = createMemoryStore();
    const indexer = createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0]);
            },
        },
        store,
    });

    const first = await indexer.indexAll();
    await fs.rm(path.join(root, 'app.js'));
    const removed = await indexer.indexFile('app.js');

    assert.equal(removed.removed, true);
    assert.notEqual(removed.sourceRevision, first.sourceRevision);
    assert.deepEqual(await store.knownPaths(), []);
});

test('incremental indexing removes a source file replaced by a symlink', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-symlink-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-symlink-outside-'));
    const sourcePath = path.join(root, 'app.js');
    const outsidePath = path.join(outside, 'outside.js');
    await fs.writeFile(sourcePath, 'export const value = 1;\n');
    await fs.writeFile(outsidePath, 'export const outside = true;\n');
    const store = createMemoryStore();
    const indexer = createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0]);
            },
        },
        store,
    });
    const first = await indexer.indexAll();
    await fs.rm(sourcePath);
    try {
        await fs.symlink(outsidePath, sourcePath, 'file');
    } catch(err) {
        if(err?.code === 'EPERM' || err?.code === 'EACCES') {
            t.skip(`symlinks unavailable: ${err.code}`);
            return;
        }
        throw err;
    }

    const rejected = await indexer.indexFile('app.js');

    assert.equal(rejected.indexed, false);
    assert.equal(rejected.skipped, true);
    assert.equal(rejected.reason, 'symlink_excluded');
    assert.notEqual(rejected.sourceRevision, first.sourceRevision);
    assert.deepEqual(await store.knownPaths(), []);
});

test('indexAll enriches files: description reaches the embedding text and the stored rows', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-enrich-'));
    await fs.writeFile(path.join(root, 'billing.js'), 'export function chargeCard(amount) { return amount; }\n');
    const store = createMemoryStore();
    const embedInputs = [];
    const enricher = {
        async describe(rel) {
            return `Charges a customer card (${rel}).`;
        }
    };
    const indexer = createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            async embed(items) {
                embedInputs.push(...items);
                return items.map(() => [0]);
            }
        },
        store,
        enricher
    });

    await indexer.indexAll();

    assert.ok(
        embedInputs.some((text) => text.includes('Purpose: Charges a customer card (billing.js).')),
        'description should be prepended to the embedding text'
    );
    assert.ok(
        store.rows().some((row) => row.description === 'Charges a customer card (billing.js).'),
        'description should be persisted on the chunk rows'
    );
});

test('indexAll runs enrichment at enrichConcurrency (decoupled from index concurrency) and every description lands', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-enrich-conc-'));
    const fileCount = 6;
    for(let i = 0; i < fileCount; i++) {
        await fs.writeFile(path.join(root, `mod${i}.js`), `export const value${i} = ${i};\n`);
    }
    const store = createMemoryStore();
    let inFlight = 0;
    let maxInFlight = 0;
    const enricher = {
        async describe(rel) {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            // Hold the slot briefly so concurrent calls actually overlap in time.
            //
            await new Promise((resolve) => {
                setTimeout(resolve, 10);
            });
            inFlight--;
            return `Describes ${rel}.`;
        }
    };
    const indexer = createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0]);
            }
        },
        store,
        enricher,
        enrichConcurrency: 3
    });

    const enrichEvents = [];
    await indexer.indexAll({
        onProgress: (ev) => {
            if(ev.kind === 'enriching') {
                enrichEvents.push(ev);
            }
        }
    });

    assert.equal(maxInFlight, 3, 'enrichment should run up to enrichConcurrency calls at once');
    const described = new Set(store.rows().map((row) => row.description));
    for(let i = 0; i < fileCount; i++) {
        assert.ok(described.has(`Describes mod${i}.js.`), `description for mod${i}.js should be stored`);
    }

    // The enrichment phase must report progress (it is otherwise silent for minutes
    // on a slow model): a leading done:0 event, then a monotonic climb to done:total.
    //
    assert.ok(enrichEvents.length >= 2, 'enrichment should emit progress events');
    assert.equal(enrichEvents[0].done, 0, 'first enriching event marks the phase start');
    assert.ok(enrichEvents.every((ev) => ev.total === fileCount), 'every enriching event carries the file total');
    let previousDone = -1;
    for(const ev of enrichEvents) {
        assert.ok(ev.done >= previousDone, 'enriching done counter is monotonic');
        previousDone = ev.done;
    }
    assert.equal(enrichEvents.at(-1).done, fileCount, 'final enriching event reaches the file total');
});

test('indexAll stats expose enrichment coverage so silent total failure is visible', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-enrich-cov-'));
    await fs.writeFile(path.join(root, 'a.js'), 'export const a = 1;\n');
    await fs.writeFile(path.join(root, 'b.js'), 'export const b = 2;\n');
    const store = createMemoryStore();
    // Mirrors the production enricher's failure contract: every error/timeout is
    // swallowed into '' and indexing still succeeds — coverage is the only signal.
    //
    const deadEnricher = {
        async describe() {
            return '';
        }
    };
    const indexer = createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0]);
            }
        },
        store,
        enricher: deadEnricher
    });

    const stats = await indexer.indexAll();

    assert.equal(stats.enrichment.enabled, true);
    assert.equal(stats.enrichment.attempted, 2);
    assert.equal(stats.enrichment.succeeded, 0);
});

test('enrichment coverage counts successes per run and accumulates in snapshot', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-enrich-snap-'));
    await fs.writeFile(path.join(root, 'a.js'), 'export const a = 1;\n');
    const store = createMemoryStore();
    const indexer = createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0]);
            }
        },
        store,
        enricher: {
            async describe(rel) {
                return `Describes ${rel}.`;
            }
        }
    });

    const first = await indexer.indexAll();
    assert.deepEqual(first.enrichment, {enabled: true, attempted: 1, succeeded: 1});

    // Warm re-run: nothing changed, nothing attempted — the per-run delta is zero
    // and must not trip any coverage check.
    //
    const warm = await indexer.indexAll();
    assert.deepEqual(warm.enrichment, {enabled: true, attempted: 0, succeeded: 0});

    await fs.writeFile(path.join(root, 'a.js'), 'export const a = 2;\n');
    await indexer.indexFile('a.js');
    const snap = await indexer.snapshot();
    assert.deepEqual(snap.enrichment, {enabled: true, attempted: 2, succeeded: 2});
});

test('indexAll stats report enrichment disabled when no enricher is configured', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-enrich-off-'));
    await fs.writeFile(path.join(root, 'a.js'), 'export const a = 1;\n');
    const store = createMemoryStore();
    const indexer = createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0]);
            }
        },
        store
    });

    const stats = await indexer.indexAll();
    assert.deepEqual(stats.enrichment, {enabled: false, attempted: 0, succeeded: 0});
});

// Recompute the source revision straight from the store, mirroring the original
// pre-optimization algorithm, so tests can prove the in-memory mirror matches.
//
function pickIndexResult(result) {
    return {
        indexed: result.indexed,
        chunks: result.chunks,
        graphFacts: result.graphFacts,
        skipped: result.skipped,
    };
}

async function revisionFromStore(store) {
    const paths = await store.knownPaths();
    const rows = await Promise.all(paths.map(async (rel) => `${rel}:${(await store.getContentHash(rel)) || ''}`));
    return crypto
        .createHash('sha256')
        .update(rows.sort().join('\n'), 'utf8')
        .digest('hex')
        .slice(0, 16);
}

function createMemoryStore() {
    const hashes = new Map();
    const rowsByPath = new Map();
    const graphRowsByPath = new Map();
    let optimizeCalls = 0;

    return {
        async optimize() {
            optimizeCalls++;
        },
        optimizeCalls() {
            return optimizeCalls;
        },
        async removePath(relPath) {
            hashes.delete(relPath);
            rowsByPath.delete(relPath);
            graphRowsByPath.delete(relPath);
        },
        async removePaths(paths) {
            for(const relPath of paths) {
                hashes.delete(relPath);
                rowsByPath.delete(relPath);
                graphRowsByPath.delete(relPath);
            }
        },
        async getContentHash(relPath) {
            return hashes.get(relPath) || null;
        },
        async getAllContentHashes() {
            return new Map(hashes);
        },
        async upsertFile(relPath, rows) {
            rowsByPath.set(relPath, rows);
            hashes.set(relPath, rows[0]?.contentHash || '');
        },
        async addChunkRows(rows) {
            for(const row of rows) {
                const list = rowsByPath.get(row.path) || [];
                list.push(row);
                rowsByPath.set(row.path, list);
                hashes.set(row.path, row.contentHash || '');
            }
        },
        async addGraphRows(rows) {
            for(const row of rows) {
                const list = graphRowsByPath.get(row.path) || [];
                list.push({...row, path: row.path});
                graphRowsByPath.set(row.path, list);
            }
        },
        rows() {
            return [...rowsByPath.values()].flat();
        },
        async upsertCodeGraph(relPath, rows) {
            graphRowsByPath.set(relPath, rows.map((row) => ({...row, path: row.path || relPath})));
        },
        async knownPaths() {
            return [...hashes.keys()].toSorted();
        },
        async count() {
            return [...rowsByPath.values()].reduce((sum, rows) => sum + rows.length, 0);
        },
        async countCodeGraph() {
            return [...graphRowsByPath.values()].reduce((sum, rows) => sum + rows.length, 0);
        },
        graphRows() {
            return [...graphRowsByPath.values()].flat();
        },
    };
}

test('indexAll invalidates the source revision for its whole duration', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-indexer-revision-window-'));
    await fs.writeFile(path.join(root, 'app.js'), 'export const value = 1;\n');
    const store = createMemoryStore();
    const indexer = createIndexer({
        root,
        include: ['**/*.js'],
        exclude: [],
        embedder: {
            async embed(items) {
                return items.map(() => [0, 0, 0]);
            },
        },
        store,
    });

    const first = await indexer.indexAll();
    assert.equal(typeof first.sourceRevision, 'string');

    // While a rebuild is in flight the revision must read as null (which
    // disables answer-cache reads and writes) and flag itself in sourceState.
    //
    const observed = [];
    await fs.writeFile(path.join(root, 'app.js'), 'export const value = 2;\n');
    const second = await indexer.indexAll({
        onProgress() {
            observed.push({
                revision: indexer.sourceState().sourceRevision,
                indexing: indexer.sourceState().indexingInProgress,
            });
        },
    });

    assert.ok(observed.length > 0);
    assert.ok(observed.every((o) => o.revision === null && o.indexing === true));
    assert.equal(typeof second.sourceRevision, 'string');
    assert.notEqual(second.sourceRevision, null);
    assert.equal(indexer.sourceState().indexingInProgress, false);
    assert.equal(indexer.sourceState().sourceRevision, second.sourceRevision);
});

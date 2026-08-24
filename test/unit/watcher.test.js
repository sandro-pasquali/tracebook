import test from 'node:test';
import assert from 'node:assert/strict';
import {createWatcher} from '../../src/index/watcher.js';

test('watcher coalesces rapid changes for one path', async () => {
    const fake = new FakeWatcher();
    const calls = [];
    const events = [];
    const watcher = createWatcher({
        root: '/repo',
        include: ['**/*.js'],
        exclude: ['data/**'],
        debounceMs: 5,
        watch: () => fake,
        indexer: {
            async indexFile(rel) {
                calls.push(['index', rel]);
                return {indexed: true, chunks: 1};
            },
        },
        onEvent(event) {
            events.push(event);
        },
    });

    fake.emit('add', 'src/app.js');
    fake.emit('change', 'src/app.js');
    await delay(20);
    await watcher.close();

    assert.deepEqual(calls, [['index', 'src/app.js']]);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'indexed');
});

test('watcher ignores excluded paths', async () => {
    const fake = new FakeWatcher();
    const calls = [];
    const watcher = createWatcher({
        root: '/repo',
        include: ['**/*.js'],
        exclude: ['data/**'],
        debounceMs: 5,
        watch: () => fake,
        indexer: {
            async indexFile(rel) {
                calls.push(['index', rel]);
                return {indexed: true};
            },
            async removeFile(rel) {
                calls.push(['remove', rel]);
                return {removed: true};
            },
        },
    });

    fake.emit('change', 'data/private.js');
    fake.emit('unlink', 'data/private.js');
    await delay(20);
    await watcher.close();

    assert.deepEqual(calls, []);
});

test('watcher reindexes when repo ignore policy files change', async () => {
    const fake = new FakeWatcher();
    const calls = [];
    const events = [];
    const watcher = createWatcher({
        root: '/repo',
        include: ['**/*.js'],
        exclude: [],
        debounceMs: 5,
        watch: () => fake,
        indexer: {
            invalidateIgnorePolicy() {
                calls.push(['invalidate']);
            },
            async indexAll() {
                calls.push(['indexAll']);
                return {indexedFiles: 1, removedFiles: 1};
            },
        },
        onEvent(event) {
            events.push(event);
        },
    });

    fake.emit('change', '.gitignore');
    await delay(20);
    await watcher.close();

    assert.deepEqual(calls, [['invalidate'], ['indexAll']]);
    assert.equal(events[0].kind, 'policy_reindexed');
    assert.equal(events[0].rel, '.gitignore');
});

test('watcher treats nested repo ignore files outside excluded roots as policy changes', async () => {
    const fake = new FakeWatcher();
    const calls = [];
    const watcher = createWatcher({
        root: '/repo',
        include: ['**/*.js'],
        exclude: ['data/**'],
        debounceMs: 5,
        watch: () => fake,
        indexer: {
            invalidateIgnorePolicy() {
                calls.push(['invalidate']);
            },
            async indexAll() {
                calls.push(['indexAll']);
                return {};
            },
        },
    });

    fake.emit('change', 'src/.gitignore');
    await delay(20);
    await watcher.close();

    assert.deepEqual(calls, [['invalidate'], ['indexAll']]);
});

test('watcher ignores repo ignore files under excluded roots', async () => {
    const fake = new FakeWatcher();
    const calls = [];
    const watcher = createWatcher({
        root: '/repo',
        include: ['**/*.js'],
        exclude: ['data/**'],
        debounceMs: 5,
        watch: () => fake,
        indexer: {
            invalidateIgnorePolicy() {
                calls.push(['invalidate']);
            },
            async indexAll() {
                calls.push(['indexAll']);
                return {};
            },
        },
    });

    fake.emit('change', 'data/.gitignore');
    await delay(20);
    await watcher.close();

    assert.deepEqual(calls, []);
});

test('watcher queues a second run instead of overlapping per-path work', async () => {
    const fake = new FakeWatcher();
    const calls = [];
    let releaseFirst;
    const firstRun = new Promise((resolve) => {
        releaseFirst = resolve;
    });
    const watcher = createWatcher({
        root: '/repo',
        include: ['**/*.js'],
        exclude: [],
        debounceMs: 5,
        watch: () => fake,
        indexer: {
            async indexFile(rel) {
                calls.push(['index', rel]);
                if(calls.length === 1) {
                    await firstRun;
                }
                return {indexed: true};
            },
        },
    });

    fake.emit('change', 'src/app.js');
    await delay(15);
    assert.deepEqual(calls, [['index', 'src/app.js']]);

    fake.emit('change', 'src/app.js');
    await delay(15);
    assert.deepEqual(calls, [['index', 'src/app.js']]);

    releaseFirst();
    await delay(20);
    await watcher.close();

    assert.deepEqual(calls, [
        ['index', 'src/app.js'],
        ['index', 'src/app.js'],
    ]);
});

class FakeWatcher {
    #handlers = new Map();

    on(event, handler) {
        this.#handlers.set(event, handler);
        return this;
    }

    emit(event, rel) {
        this.#handlers.get(event)?.(rel);
    }

    async close() {}
}

function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

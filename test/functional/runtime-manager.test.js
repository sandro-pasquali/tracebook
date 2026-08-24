import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createRuntimeManager} from '../../src/server/runtime-manager.js';

const silentLog = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
        return silentLog;
    }
};

function makeManager({createRuntimeImpl, retryBackoffMs = 50, targetRoot = os.tmpdir()}) {
    return createRuntimeManager({
        config: {runtime: {retryBackoffMs}},
        targetRoot,
        traceRoot: os.tmpdir(),
        storyRoot: os.tmpdir(),
        changeBriefRoot: os.tmpdir(),
        indexRoot: os.tmpdir(),
        include: [],
        exclude: [],
        log: silentLog,
        indexLog: silentLog,
        instanceKey: `test-${randomUUID()}`,
        createRuntimeImpl
    });
}

test('dispose tears down watcher, store, embedder, and reranker in order', async () => {
    const order = [];
    const fakeRuntime = {
        watcher: {close: async () => order.push('watcher')},
        store: {close: async () => order.push('store')},
        embedder: {dispose: async () => order.push('embedder')},
        reranker: {dispose: async () => order.push('reranker')}
    };
    const manager = makeManager({createRuntimeImpl: async () => fakeRuntime});

    await manager.startRuntime();
    assert.equal(manager.snapshot().state, 'ready');

    await manager.dispose();
    assert.deepEqual(order, ['watcher', 'store', 'embedder', 'reranker']);
    assert.equal(manager.snapshot().state, 'idle');
});

test('a failing dispose step does not block the remaining teardown', async () => {
    const order = [];
    const fakeRuntime = {
        watcher: {close: async () => order.push('watcher')},
        store: {
            close: async () => {
                throw new Error('close failed');
            }
        },
        embedder: {dispose: async () => order.push('embedder')},
        reranker: {dispose: async () => order.push('reranker')}
    };
    const manager = makeManager({createRuntimeImpl: async () => fakeRuntime});

    await manager.startRuntime();
    await manager.dispose();
    assert.deepEqual(order, ['watcher', 'embedder', 'reranker']);
});

test('a failed init backs off instead of re-initializing on every request', async () => {
    let attempts = 0;
    const manager = makeManager({
        createRuntimeImpl: async () => {
            attempts++;
            throw new Error('boom');
        },
        retryBackoffMs: 60
    });

    await assert.rejects(manager.startRuntime(), /boom/);
    assert.equal(attempts, 1);
    assert.equal(manager.snapshot().state, 'error');

    // Within the backoff window every start is refused without re-initializing.
    //
    await assert.rejects(manager.startRuntime(), (err) => err.code === 'runtime_init_backoff');
    await assert.rejects(manager.startRuntime(), (err) => err.code === 'runtime_init_backoff');
    assert.equal(attempts, 1);

    // After the window one retry is allowed, and a failure re-arms the backoff.
    //
    await new Promise((resolve) => {
        setTimeout(resolve, 80);
    });
    await assert.rejects(manager.startRuntime(), /boom/);
    assert.equal(attempts, 2);
    await assert.rejects(manager.startRuntime(), (err) => err.code === 'runtime_init_backoff');
    assert.equal(attempts, 2);
});

test('dispose clears the error backoff so a config save retries immediately', async () => {
    let attempts = 0;
    const manager = makeManager({
        createRuntimeImpl: async () => {
            attempts++;
            throw new Error('boom');
        },
        retryBackoffMs: 60000
    });

    await assert.rejects(manager.startRuntime(), /boom/);
    await assert.rejects(manager.startRuntime(), (err) => err.code === 'runtime_init_backoff');
    assert.equal(attempts, 1);

    await manager.dispose();
    await assert.rejects(manager.startRuntime(), /boom/);
    assert.equal(attempts, 2);
});

test('the client snapshot drops targetRoot and scrubs absolute paths from messages', async () => {
    const targetRoot = '/Users/example/projects/project-x';
    const manager = makeManager({
        targetRoot,
        createRuntimeImpl: async () => {
            throw new Error(`Configured repository does not exist: ${targetRoot}`);
        },
        retryBackoffMs: 60000
    });

    await assert.rejects(manager.startRuntime(), /does not exist/);

    const full = manager.snapshot();
    assert.match(full.error, /project-x/);

    const client = manager.snapshotForClient();
    assert.equal('targetRoot' in client, false);
    assert.equal(client.message.includes(targetRoot), false);
    assert.equal(client.error.includes(targetRoot), false);
    assert.match(client.error, /project-x/);
    assert.equal(typeof client.degraded, 'object');
});

test('startIfIdle does not restart an errored runtime', async () => {
    let attempts = 0;
    const manager = makeManager({
        createRuntimeImpl: async () => {
            attempts++;
            throw new Error('boom');
        },
        retryBackoffMs: 0
    });

    await assert.rejects(manager.startRuntime(), /boom/);
    assert.equal(await manager.startIfIdle(), null);
    assert.equal(attempts, 1);
});

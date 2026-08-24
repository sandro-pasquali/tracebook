import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from '../../src/server/bootstrap.js';

const silentLog = {
    debug() {},
    info() {},
    warn() {},
    error() {}
};

function makeFakes({env = {}} = {}) {
    const closed = [];
    const server = {
        close(callback) {
            closed.push(true);
            callback();
        },
        closeIdleConnections() {}
    };
    const serveCalls = [];
    const serveImpl = (options) => {
        serveCalls.push(options);
        return server;
    };
    const handlers = new Map();
    const processImpl = {
        env,
        exitCodes: [],
        exit(code) {
            processImpl.exitCodes.push(code);
        },
        on(name, handler) {
            const list = handlers.get(name) || [];
            list.push({handler, once: false});
            handlers.set(name, list);
        },
        once(name, handler) {
            const list = handlers.get(name) || [];
            list.push({handler, once: true});
            handlers.set(name, list);
        },
        emit(name, ...args) {
            const list = handlers.get(name) || [];
            handlers.set(name, list.filter((entry) => !entry.once));
            for(const entry of list) {
                entry.handler(...args);
            }
        }
    };
    return {server, serveImpl, serveCalls, processImpl, closed};
}

test('startServer binds loopback with the configured port and overrides via PORT', () => {
    const first = makeFakes();
    startServer({app: {fetch() {}}, serveImpl: first.serveImpl, processImpl: first.processImpl, logger: silentLog});
    assert.equal(first.serveCalls[0].hostname, '127.0.0.1');
    assert.ok(Number.isInteger(first.serveCalls[0].port));

    const second = makeFakes({env: {PORT: '4321'}});
    startServer({app: {fetch() {}}, serveImpl: second.serveImpl, processImpl: second.processImpl, logger: silentLog});
    assert.equal(second.serveCalls[0].port, 4321);
});

test('startServer accepts only loopback hostnames', () => {
    for(const hostname of ['localhost', '127.0.0.1', '::1', 'LOCALHOST']) {
        const fake = makeFakes();
        const started = startServer({
            app: {fetch() {}},
            hostname,
            serveImpl: fake.serveImpl,
            processImpl: fake.processImpl,
            logger: silentLog
        });

        assert.equal(started.hostname, hostname.toLowerCase());
        assert.equal(fake.serveCalls.length, 1);
    }

    const fromEnvironment = makeFakes({env: {HOST: '::1'}});
    const started = startServer({
        app: {fetch() {}},
        serveImpl: fromEnvironment.serveImpl,
        processImpl: fromEnvironment.processImpl,
        logger: silentLog
    });
    assert.equal(started.hostname, '::1');
});

test('startServer rejects non-loopback and malformed hosts before listening', () => {
    for(const hostname of ['', '0.0.0.0', '192.168.1.10', 'example.com', 'localhost.example.com', '[::1]']) {
        const fake = makeFakes({env: {HOST: hostname}});
        assert.throws(() => startServer({
            app: {fetch() {}},
            serveImpl: fake.serveImpl,
            processImpl: fake.processImpl,
            logger: silentLog
        }), /must bind to localhost/v);
        assert.equal(fake.serveCalls.length, 0);
    }
});

test('SIGTERM closes the server, disposes runtimes once, and exits cleanly', async () => {
    const {serveImpl, processImpl, closed} = makeFakes();
    let disposals = 0;
    startServer({
        app: {fetch() {}},
        serveImpl,
        processImpl,
        logger: silentLog,
        disposeRuntimes: async () => {
            disposals++;
        }
    });

    processImpl.emit('SIGTERM');
    processImpl.emit('SIGTERM');
    await new Promise((resolve) => {
        setImmediate(resolve);
    });

    assert.equal(closed.length, 1);
    assert.equal(disposals, 1);
    assert.deepEqual(processImpl.exitCodes, [0]);
});

test('a failing runtime disposal exits non-zero instead of hanging', async () => {
    const {serveImpl, processImpl} = makeFakes();
    startServer({
        app: {fetch() {}},
        serveImpl,
        processImpl,
        logger: silentLog,
        disposeRuntimes: async () => {
            throw new Error('dispose failed');
        }
    });

    processImpl.emit('SIGINT');
    await new Promise((resolve) => {
        setImmediate(resolve);
    });

    assert.deepEqual(processImpl.exitCodes, [1]);
});

test('unhandled rejections are logged without exiting; uncaught exceptions exit', () => {
    const {serveImpl, processImpl} = makeFakes();
    const errors = [];
    startServer({
        app: {fetch() {}},
        serveImpl,
        processImpl,
        logger: {...silentLog, error: (details) => errors.push(details)}
    });

    processImpl.emit('unhandledRejection', new Error('stray'));
    assert.equal(errors.length, 1);
    assert.deepEqual(processImpl.exitCodes, []);

    processImpl.emit('uncaughtException', new Error('fatal'));
    assert.equal(errors.length, 2);
    assert.deepEqual(processImpl.exitCodes, [1]);
});

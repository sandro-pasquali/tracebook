import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntimeStatus} from '../../public/js/app/runtime-status.js';

test('runtime status heartbeat keeps polling until the runtime is ready', async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = globalThis.window;
    const intervals = new Map();
    const clearedIntervals = [];
    const calls = [];
    let nextIntervalId = 1;
    const overlay = fakeIndexingOverlay();

    globalThis.window = {
        setInterval(callback, delay) {
            const id = nextIntervalId++;
            intervals.set(id, {callback, delay});
            return id;
        },
        clearInterval(id) {
            clearedIntervals.push(id);
            intervals.delete(id);
        },
    };
    globalThis.fetch = async (url, options) => {
        calls.push({
            url: String(url),
            method: options.method,
            marker: options.headers.get('x-tracebook-request')
        });
        return Response.json({
            runtime: calls.length === 1
                ? {state: 'initializing', stage: 'starting', progressRatio: 0.02}
                : {state: 'ready', stage: 'ready', progressRatio: 1},
        });
    };

    try {
        const status = createRuntimeStatus({
            input: fakeInput(),
            button: {disabled: false},
            setStatusCrumb() {},
            indexingOverlay: overlay,
        });

        status.init();
        await flushMicrotasks();

        assert.deepEqual(calls, [{
            url: '/api/runtime/start',
            method: 'POST',
            marker: '1'
        }]);
        assert.equal(intervals.size, 1);
        assert.equal(status.isReady(), false);

        const heartbeat = [...intervals.values()][0];
        assert.equal(heartbeat.delay, 800);
        heartbeat.callback();
        await flushMicrotasks();

        assert.deepEqual(calls, [
            {url: '/api/runtime/start', method: 'POST', marker: '1'},
            {url: '/api/runtime/status', method: 'GET', marker: '1'},
        ]);
        assert.equal(status.isReady(), true);
        assert.equal(overlay.visible, false);
        assert.equal(clearedIntervals.length, 1);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.window = originalWindow;
    }
});

function fakeIndexingOverlay() {
    return {
        visible: false,
        init() {
            this.visible = true;
            return true;
        },
        update() {},
        show() {
            this.visible = true;
        },
        hide() {
            this.visible = false;
        },
        handleKeydown() {
            return false;
        },
    };
}

function fakeInput() {
    const attributes = new Map([['placeholder', 'Ask']]);
    return {
        disabled: false,
        getAttribute(name) {
            return attributes.get(name) || '';
        },
        setAttribute(name, value) {
            attributes.set(name, value);
        },
        removeAttribute(name) {
            attributes.delete(name);
        },
    };
}

async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
}

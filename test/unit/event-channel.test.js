import test from 'node:test';
import assert from 'node:assert/strict';
import {createEventChannel} from '../../src/util/event-channel.js';

test('event channel delivers pushed events in order and ends on close', async () => {
    const channel = createEventChannel();
    channel.push({n: 1});
    channel.push({n: 2});
    channel.close();

    const seen = [];
    for await (const event of channel) {
        seen.push(event.n);
    }
    assert.deepEqual(seen, [1, 2]);
});

test('event channel overflow rejects the consumer instead of growing unbounded', async () => {
    const channel = createEventChannel({maxQueued: 5});
    for(let i = 0; i < 10; i++) {
        channel.push({n: i});
    }

    const seen = [];
    await assert.rejects(async () => {
        for await (const event of channel) {
            seen.push(event);
        }
    }, /event channel overflow/);
    assert.deepEqual(seen, []);

    // Producers become no-ops after failure; close is safe to call.
    //
    channel.push({n: 99});
    channel.close();
});

test('event channel fail rejects a waiting consumer', async () => {
    const channel = createEventChannel();
    const pending = channel[Symbol.asyncIterator]().next();
    channel.fail(new Error('stream torn down'));
    await assert.rejects(pending, /stream torn down/);
});

test('a pre-failed channel keeps rejecting subsequent reads', async () => {
    const channel = createEventChannel();
    channel.fail(new Error('gone'));
    const iterator = channel[Symbol.asyncIterator]();
    await assert.rejects(iterator.next(), /gone/);
    await assert.rejects(iterator.next(), /gone/);
});

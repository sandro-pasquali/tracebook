import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {createGovernor} from '../../src/util/governor.js';

test('governor reserves in-flight tokens before usage is observed', async () => {
    const governor = createGovernor({budget: 100, initialEstimate: 10});
    const first = await governor.beforeCall(80);
    let resolved = false;

    const pending = governor.beforeCall(30).then(reservation => {
        resolved = true;
        return reservation;
    });

    await sleep(100);
    assert.equal(resolved, false);

    governor.releaseCall(first);
    const second = await Promise.race([
        pending,
        sleep(1000).then(() => null),
    ]);

    assert.ok(second);
    governor.afterCall(25, second);
    assert.deepEqual(pickGovernorSnapshot(governor.snapshot()), {
        observed: 25,
        reserved: 0,
        inFlight: 0,
    });
});

test('governor releases failed calls without recording observed usage', async () => {
    const governor = createGovernor({budget: 100, initialEstimate: 10});
    const reservation = await governor.beforeCall(60);

    governor.releaseCall(reservation);

    assert.equal(governor.snapshot().used, 0);
    assert.equal(governor.snapshot().inFlight, 0);
});

function pickGovernorSnapshot(snapshot) {
    return {
        observed: snapshot.observed,
        reserved: snapshot.reserved,
        inFlight: snapshot.inFlight,
    };
}

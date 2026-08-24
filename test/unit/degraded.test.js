import test from 'node:test';
import assert from 'node:assert/strict';
import {createDegradedTracker} from '../../src/util/degraded.js';

test('degraded tracker counts failures per area', () => {
    const tracker = createDegradedTracker();
    tracker.note({area: 'prefetch', err: new Error('store down')});
    tracker.note({area: 'prefetch', err: new Error('store still down')});
    tracker.note({area: 'reranker', err: new Error('model missing')});

    const snapshot = tracker.snapshot();
    assert.equal(snapshot.prefetch.count, 2);
    assert.equal(snapshot.reranker.count, 1);
    assert.ok(snapshot.prefetch.lastAt > 0);
});

test('degraded tracker rate-limits logging per area', () => {
    const logged = [];
    const tracker = createDegradedTracker({
        log: {
            warn(details, message) {
                logged.push({details, message});
            }
        },
        logIntervalMs: 60_000
    });

    for(let i = 0; i < 5; i++) {
        tracker.note({area: 'enrichment', err: new Error(`failure ${i}`)});
    }
    tracker.note({area: 'graph_hubs', err: new Error('other area logs independently')});

    assert.equal(logged.filter((entry) => entry.details.area === 'enrichment').length, 1);
    assert.equal(logged.filter((entry) => entry.details.area === 'graph_hubs').length, 1);
    assert.equal(tracker.snapshot().enrichment.count, 5);
});

test('degraded tracker snapshot exposes counts only — no error messages', () => {
    const tracker = createDegradedTracker();
    tracker.note({area: 'prefetch', err: new Error('/Users/someone/secret/path failed')});
    const snapshot = tracker.snapshot();
    assert.deepEqual(Object.keys(snapshot.prefetch).sort(), ['count', 'lastAt']);
});

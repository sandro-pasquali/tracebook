// Single-producer-N-consumers async channel for merging events from multiple
// parallel async tasks into a single async-iterable stream. Used by the
// planner to interleave events from per-component synthesizers running in
// parallel into one SSE stream.
//
// Producers call push(event) any time; one consumer reads via for-await.
// Call close() when no more events will be pushed — the for-await loop ends.
//
// The queue is bounded as a safety valve, not a tuning knob: a consumer that
// stops draining while producers keep pushing would otherwise grow the queue
// without limit. On overflow the channel fails — the consumer's for-await
// throws (surfacing a visible error) instead of the process quietly growing.
//
export function createEventChannel({maxQueued = 10_000} = {}) {
    const queue = [];
    const waiters = [];
    let closed = false;
    let failure = null;

    function push(event) {
        if(closed) {
            return;
        }
        if(waiters.length > 0) {
            const waiter = waiters.shift();
            waiter.resolve({value: event, done: false});
            return;
        }
        queue.push(event);
        if(queue.length > maxQueued) {
            fail(new Error(`event channel overflow: more than ${maxQueued} events queued without a consumer`));
        }
    }

    function fail(err) {
        if(closed) {
            return;
        }
        closed = true;
        failure = err || new Error('event channel failed');
        queue.length = 0;
        while(waiters.length > 0) {
            const waiter = waiters.shift();
            waiter.reject(failure);
        }
    }

    function close() {
        if(closed) {
            return;
        }
        closed = true;
        while(waiters.length > 0) {
            const waiter = waiters.shift();
            waiter.resolve({value: undefined, done: true});
        }
    }

    function next() {
        if(queue.length > 0) {
            return Promise.resolve({value: queue.shift(), done: false});
        }
        if(failure) {
            return Promise.reject(failure);
        }
        if(closed) {
            return Promise.resolve({value: undefined, done: true});
        }
        return new Promise((resolve, reject) => {
            waiters.push({resolve, reject});
        });
    }

    return {
        push,
        close,
        fail,
        [Symbol.asyncIterator]() {
            return {next};
        }
    };
}

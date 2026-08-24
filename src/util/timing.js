// Lightweight per-request timer.
// Records named checkpoints with absolute timestamps, time-since-start, and
// time-since-last-mark. Callers can also open named spans for begin/end pairs.
// The planner converts each checkpoint into a `timing.checkpoint` SSE event so
// the client can build a flame-chart-style breakdown of the request.
//
export function createTimer({label = 'request'} = {}) {
    const startedAt = Date.now();
    const checkpoints = [];

    function mark(name, meta = {}) {
        const at = Date.now();
        const sinceStart = at - startedAt;
        const sinceLast = checkpoints.length > 0
            ? at - checkpoints[checkpoints.length - 1].at
            : sinceStart;
        const entry = {name, at, sinceStart, sinceLast, ...meta};
        checkpoints.push(entry);
        return entry;
    }

    function span(name, meta = {}) {
        const startAt = Date.now();
        return {
            end(endMeta = {}) {
                const endedAt = Date.now();
                const entry = {
                    name,
                    at: endedAt,
                    sinceStart: endedAt - startedAt,
                    sinceLast: endedAt - startAt,
                    durationMs: endedAt - startAt,
                    ...meta,
                    ...endMeta
                };
                checkpoints.push(entry);
                return entry;
            }
        };
    }

    function snapshot() {
        return {
            label,
            startedAt,
            elapsedMs: Date.now() - startedAt,
            checkpoints: checkpoints.slice()
        };
    }

    return {mark, span, snapshot, startedAt};
}

// Degraded-mode tracker: subsystems whose failures deliberately degrade to a
// thinner answer (prefetch, reranker, enrichment, graph hubs, store optimize)
// report here instead of vanishing into a silent catch. Counters surface in
// the runtime status payload so a dead model or broken index reads as
// "degraded", never as "no matches"; logging is rate-limited per area so a
// hot failure path cannot flood the log.
//
const DEGRADED_LOG_INTERVAL_MS = 60_000;

export function createDegradedTracker({log = null, logIntervalMs = DEGRADED_LOG_INTERVAL_MS} = {}) {
    const areas = new Map();

    function note({area, err = null}) {
        const key = String(area || 'unknown');
        const now = Date.now();
        const entry = areas.get(key) || {count: 0, firstAt: now, lastAt: now, lastLoggedAt: 0};
        entry.count++;
        entry.lastAt = now;
        if(log && (entry.lastLoggedAt === 0 || now - entry.lastLoggedAt >= logIntervalMs)) {
            entry.lastLoggedAt = now;
            log.warn({err, area: key, count: entry.count}, `degraded: ${key} failed — continuing without it`);
        }
        areas.set(key, entry);
    }

    function snapshot() {
        const out = {};
        for(const [area, entry] of areas) {
            out[area] = {count: entry.count, lastAt: entry.lastAt};
        }
        return out;
    }

    return {note, snapshot};
}

// Run `worker(item, index)` over `items` with at most `limit` executions in
// flight at once, returning the results in input order. A bounded pool of
// runners pulls from a shared cursor, so work starts as soon as a slot frees —
// no batch barriers. The worker is responsible for its own error handling; an
// uncaught throw rejects the whole run (callers that need per-item isolation
// should try/catch inside the worker).
//
export async function mapWithConcurrency(items, limit, worker) {
    const list = Array.isArray(items) ? items : [...items];
    const results = new Array(list.length);
    const size = Math.max(1, Math.min(limit, list.length || 1));
    let cursor = 0;
    async function runner() {
        while(cursor < list.length) {
            const index = cursor++;
            results[index] = await worker(list[index], index);
        }
    }
    const runners = [];
    for(let i = 0; i < size; i++) {
        runners.push(runner());
    }
    await Promise.all(runners);
    return results;
}

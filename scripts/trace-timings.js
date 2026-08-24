import fs from 'node:fs';
import path from 'node:path';
import {resolveTracebookPaths} from '../src/util/tracebook-paths.js';

const {reposRoot} = resolveTracebookPaths({configPathOverride: null});
const limitArg = Number(process.argv[2] || 30);
const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : 30;

if(!fs.existsSync(reposRoot)) {
    console.error(`Tracebook repository data not found: ${reposRoot}`);
    process.exit(1);
}

const traceDirs = fs.readdirSync(reposRoot, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(reposRoot, entry.name, 'traces'))
    .filter((traceDir) => fs.existsSync(traceDir));
const files = traceDirs
    .flatMap((traceDir) => fs.readdirSync(traceDir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => path.join(traceDir, file)))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, limit);

const rows = [];
for(const file of files) {
    try {
        const trace = JSON.parse(fs.readFileSync(file, 'utf8'));
        rows.push(toRow(trace));
    } catch(err) {
        rows.push({id: path.basename(file, '.json'), error: err?.message || 'parse_failed'});
    }
}

const valid = rows.filter((r) => !r.error && r.durationMs);
console.log(`Recent traces: ${valid.length}/${rows.length}`);
console.log('');
printStats('durationMs', valid.map((r) => r.durationMs));
printStats('tokens', valid.map((r) => r.tokens).filter(Boolean));
printStats('prefetchMs', valid.map((r) => r.prefetchMs).filter(Boolean));
printStats('explorationEndMs', valid.map((r) => r.explorationEndMs).filter(Boolean));
printStats('synthesisEndMs', valid.map((r) => r.synthesisEndMs).filter(Boolean));
console.log('');

const byMode = groupBy(valid, (r) => r.mode || 'unknown');
for(const [mode, modeRows] of Object.entries(byMode)) {
    console.log(`Mode: ${mode} (${modeRows.length})`);
    printStats('  durationMs', modeRows.map((r) => r.durationMs));
    printStats('  tokens', modeRows.map((r) => r.tokens).filter(Boolean));
}
console.log('');

console.table(valid.slice(0, 15).map((r) => ({
    id: r.id,
    mode: r.mode,
    durationMs: r.durationMs,
    tokens: r.tokens,
    prefetchMs: r.prefetchMs,
    explorationEndMs: r.explorationEndMs,
    routeMs: r.routeMs,
    routeStage: r.routeStage,
    synthesisEndMs: r.synthesisEndMs,
    timedOut: r.timedOut,
    degraded: r.degraded,
    question: r.question
})));

function toRow(trace) {
    const complete = [...(trace.events || [])].reverse().find((e) => e?.type === 'trace.complete') || {};
    const checkpoints = complete.timing?.checkpoints || [];
    const checkpoint = (name) => checkpoints.find((c) => c.name === name) || null;
    const prefetch = checkpoint('prefetch');
    const explorationEnd = checkpoint('exploration.end');
    const route = checkpoint('synthesis.route');
    const synthesisEnd = checkpoint('synthesis.end');
    const timeout = checkpoint('exploration.timeout');
    const degraded = checkpoint('exploration.degraded');

    return {
        id: trace.traceId,
        question: String(trace.question || '').slice(0, 60),
        mode: complete.synthesisMode || route?.mode || synthesisEnd?.mode || 'unknown',
        durationMs: complete.durationMs || trace.durationMs || null,
        tokens: complete.usage?.totalTokens || trace.usage?.totalTokens || null,
        prefetchMs: prefetch?.durationMs || null,
        explorationEndMs: explorationEnd?.sinceStart || null,
        routeMs: route?.sinceStart || null,
        routeStage: route?.stage || null,
        synthesisEndMs: synthesisEnd?.sinceStart || null,
        timedOut: !!timeout,
        degraded: !!degraded
    };
}

function printStats(label, values) {
    const stats = describe(values);
    if(!stats) {
        console.log(`${label}: n=0`);
        return;
    }
    console.log(`${label}: n=${stats.n} p50=${stats.p50} p75=${stats.p75} p90=${stats.p90} max=${stats.max}`);
}

function describe(values) {
    const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if(xs.length === 0) {
        return null;
    }
    const q = (p) => xs[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))];
    return {
        n: xs.length,
        p50: Math.round(q(0.5)),
        p75: Math.round(q(0.75)),
        p90: Math.round(q(0.9)),
        max: Math.round(xs[xs.length - 1])
    };
}

function groupBy(values, fn) {
    const out = {};
    for(const value of values) {
        const key = fn(value);
        if(!out[key]) {
            out[key] = [];
        }
        out[key].push(value);
    }
    return out;
}

import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'fs-extra';
import {execa} from 'execa';

// Shared eval reporting — turns a finished eval run into a committed JSON
// baseline and diffs later runs against it, so every retrieval/generation
// change is judged by tooling instead of terminal scrollback.
//
// A baseline records the CONDITIONS it was measured under (repo, case-file
// hash, K, embedding model/dims/prefixes, enrichment, rerank model). A compare
// against a baseline produced under different conditions fails loudly as
// "incomparable" rather than producing a bogus delta.
//
// Gating: only metrics from the production configuration are pass/fail (the
// +rerank ladder step for retrieval; per-type aggregates for generation), and
// only for types with n >= minN — small slices are reported as info, never
// gated, so noise on a 4-case type cannot fail a run.
//

// Metrics where a DROP is good (rates of failure modes). Everything else is
// higher-better. coPerExc is informational only — it has no natural direction.
//
const LOWER_BETTER = new Set(['gap', 'err', 'weakCallouts', 'dupCo']);
const INFO_ONLY = new Set(['n', 'coPerExc']);

// Refuses to measure an index whose enrichment silently failed. The enricher
// swallows every failure into '' (dead endpoint, cold model, timeouts), so an
// "enrichment ON" run can otherwise index nothing and produce bogus numbers
// stamped enrichment: true. Warm indexes attempt zero files — that's fine.
//
export function assertEnrichmentCoverage(stats) {
    const enrichment = stats?.enrichment;
    if(!enrichment?.enabled || !enrichment.attempted) {
        return;
    }
    const coverage = enrichment.succeeded / enrichment.attempted;
    if(coverage < 0.9) {
        throw new Error(`enrichment coverage ${enrichment.succeeded}/${enrichment.attempted} (${(coverage * 100).toFixed(0)}%) — the enrichment model is failing silently; fix it (is Ollama up?) or run the enrichment-off regime instead`);
    }
}

export function hashCases(cases) {
    const canonical = JSON.stringify(cases.map((c) => ({type: c.type, question: c.question, expect: c.expect})));
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export async function gitRev(root) {
    try {
        const {stdout} = await execa('git', ['rev-parse', '--short', 'HEAD'], {cwd: root});
        return stdout.trim();
    } catch {
        return 'unknown';
    }
}

export function baselineFile({baselinesDir, repoName, kind}) {
    return path.join(baselinesDir, repoName, `${kind}.json`);
}

export async function saveBaseline({file, conditions, metrics, projectRoot}) {
    const payload = {
        version: 1,
        savedAt: new Date().toISOString(),
        gitRev: await gitRev(projectRoot),
        conditions,
        metrics
    };
    await fs.ensureDir(path.dirname(file));
    await fs.writeJson(file, payload, {spaces: 4});
    return payload;
}

// Every eval run records its full payload under the eval cache (git-ignored
// AND outside the indexed corpus — never under committed/indexed paths), so
// refreshing a baseline is a file promotion, never a re-run. A full generation
// pass costs real model-hours; measuring the same code twice just to write a
// JSON file is never acceptable.
//
export function lastRunFile({cacheDir, repoName, kind}) {
    return path.join(cacheDir, 'last-runs', `${repoName}.${kind}.json`);
}

export async function promoteLastRun({cacheDir, baselinesDir, repoName, kind}) {
    const source = lastRunFile({cacheDir, repoName, kind});
    if(!await fs.pathExists(source)) {
        throw new Error(`no recorded ${kind} run for ${repoName} at ${source} — run that eval once first`);
    }
    const payload = await fs.readJson(source);
    const target = baselineFile({baselinesDir, repoName, kind});
    await fs.ensureDir(path.dirname(target));
    await fs.writeJson(target, payload, {spaces: 4});
    return {payload, target};
}

// Flattens {'+rerank': {product: {recall: 0.72}}} into rows keyed
// '+rerank.product.recall' so baseline and current align leaf-by-leaf.
//
function flatten(object, prefix = '', rows = new Map()) {
    for(const [key, value] of Object.entries(object || {})) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if(value !== null && typeof value === 'object') {
            flatten(value, fullKey, rows);
        } else if(typeof value === 'number') {
            rows.set(fullKey, value);
        }
    }
    return rows;
}

function leafName(key) {
    return key.split('.').at(-1);
}

// gatedKeys: predicate deciding whether a leaf participates in pass/fail (the
// caller knows which slice is the production configuration and which types
// have enough cases). Everything else is reported as info.
//
export async function compareToBaseline({file, conditions, metrics, tolerance, isGated}) {
    if(!await fs.pathExists(file)) {
        return {ok: false, incomparable: `no baseline at ${file} — run with --save-baseline first`, gated: [], info: []};
    }
    const baseline = await fs.readJson(file);
    const mismatches = conditionMismatches(baseline.conditions, conditions);
    if(mismatches.length > 0) {
        return {
            ok: false,
            incomparable: `baseline conditions differ (${mismatches.join('; ')}) — re-save the baseline if the change is intentional`,
            gated: [],
            info: []
        };
    }

    const baseRows = flatten(baseline.metrics);
    const currentRows = flatten(metrics);
    const gated = [];
    const info = [];
    for(const [key, current] of currentRows) {
        if(!baseRows.has(key)) {
            continue;
        }
        const base = baseRows.get(key);
        const leaf = leafName(key);
        const delta = current - base;
        if(INFO_ONLY.has(leaf) || !isGated(key)) {
            info.push({key, base, current, delta, status: 'info'});
            continue;
        }
        const allowed = effectiveTolerance(tolerance, key, currentRows);
        const regressed = LOWER_BETTER.has(leaf) ? delta > allowed : delta < -allowed;
        const improved = LOWER_BETTER.has(leaf) ? delta < -allowed : delta > allowed;
        gated.push({key, base, current, delta, status: regressed ? 'regressed' : (improved ? 'improved' : 'ok')});
    }
    const regressions = gated.filter((row) => row.status === 'regressed');
    return {ok: regressions.length === 0, incomparable: null, baseline, gated, info, regressions};
}

// A rate over n cases moves in steps of 1/n, so a fixed tolerance finer than
// one case gates on noise — the same comparison was observed to flip
// pass/fail across runs on an identical index when a single boundary case
// moved. The effective tolerance is therefore at least one case (plus margin)
// whenever the metric has a sibling case count; a two-case move always gates.
//
const NOISE_FLOOR_CASES = 1.25;

function effectiveTolerance(tolerance, key, currentRows) {
    const parent = key.split('.').slice(0, -1).join('.');
    const n = currentRows.get(parent ? `${parent}.n` : 'n');
    if(!Number.isFinite(n) || n <= 0) {
        return tolerance;
    }
    return Math.max(tolerance, NOISE_FLOOR_CASES / n);
}

function conditionMismatches(base, current) {
    const keys = new Set([...Object.keys(base || {}), ...Object.keys(current || {})]);
    const mismatches = [];
    for(const key of keys) {
        const a = JSON.stringify(base?.[key] ?? null);
        const b = JSON.stringify(current?.[key] ?? null);
        if(a !== b) {
            mismatches.push(`${key}: baseline=${a} current=${b}`);
        }
    }
    return mismatches;
}

export function printComparison({label, result, out = process.stdout}) {
    out.write(`\n${label} vs baseline\n`);
    if(result.incomparable) {
        out.write(`  INCOMPARABLE: ${result.incomparable}\n`);
        return;
    }
    out.write(`  baseline saved ${result.baseline.savedAt} @ ${result.baseline.gitRev}\n`);
    const moved = result.gated.filter((row) => row.status !== 'ok');
    const rows = moved.length > 0 ? moved : result.gated;
    if(moved.length === 0) {
        out.write(`  all ${result.gated.length} gated metrics within tolerance\n`);
        return;
    }
    for(const row of rows) {
        const arrow = row.delta >= 0 ? '+' : '';
        out.write(`  ${row.status === 'regressed' ? 'REGRESSED' : 'improved '} ${row.key.padEnd(36)} ${row.base.toFixed(2)} -> ${row.current.toFixed(2)} (${arrow}${row.delta.toFixed(2)})\n`);
    }
}

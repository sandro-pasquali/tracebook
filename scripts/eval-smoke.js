// Cheap behavior gate for routine changes — minutes, not hours:
//   1. retrieval matrix vs saved baselines for the NON-enriched entries
//      (tracebook, flask): local embeddings only, cache-warm, no LLM. The
//      enriched entries re-derive LLM descriptions whenever files changed and
//      belong to the long protocol, not a smoke.
//   2. stratified generation smoke on the FAST model profile
//      (setup-fast-env.js: small local model, enrichment off, own index
//      cache) that enforces the sample-size-independent invariants: a single
//      non-verbatim excerpt, errored trace, or leaked weak callout is a real
//      defect at any n, while small-n citation rates are noise and are NOT
//      gated here.
//
// Usage:
//   yarn eval:smoke
//   GEN_EVAL_PER_TYPE=3 yarn eval:smoke
//
// Full-rate comparison and baseline refresh stay with the long protocol:
//   node scripts/eval-matrix.js --compare [--generation]
//   node scripts/eval-matrix.js --promote [--generation]   # last run -> baseline, no re-run
//
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import process from 'node:process';

const projectRoot = path.resolve(import.meta.dirname, '..');
const PER_TYPE = Number(process.env.GEN_EVAL_PER_TYPE || 2);
const SMOKE_RETRIEVAL_REPOS = ['tracebook', 'flask'];

for(const repo of SMOKE_RETRIEVAL_REPOS) {
    process.stdout.write(`\n=== retrieval vs baseline: ${repo} ===\n`);
    const retrieval = spawnSync('node', ['scripts/eval-matrix.js', '--compare', '--repo', repo], {
        cwd: projectRoot,
        stdio: 'inherit',
        env: process.env
    });
    if(retrieval.status !== 0) {
        process.stderr.write(`\neval-smoke: retrieval comparison failed for ${repo} — see gated metrics above\n`);
        process.exit(1);
    }
}

process.stdout.write(`\n=== generation smoke (fast profile, ${PER_TYPE} cases per type, invariants only) ===\n`);
const generation = spawnSync('node', ['--import', './test/eval/setup-fast-env.js', 'test/eval/generation-eval.js'], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    env: {
        ...process.env,
        GEN_EVAL_PER_TYPE: String(PER_TYPE),
        EVAL_BASELINE_NAME: 'tracebook-fast',
        EVAL_INDEX_DIR: path.join(projectRoot, '.eval-cache', 'tracebook-fast')
    }
});
process.stdout.write(generation.stdout || '');
if(generation.status !== 0) {
    process.stderr.write('\neval-smoke: generation eval did not complete\n');
    process.exit(1);
}

const allRow = parseAllRow(generation.stdout);
if(!allRow) {
    process.stderr.write('\neval-smoke: could not find the "all" row in the generation quality table\n');
    process.exit(1);
}

const violations = [];
if(allRow.faith !== '-' && Number(allRow.faith) < 1) {
    violations.push(`excerpt-faith ${allRow.faith} < 1.00 — a displayed excerpt is not verbatim source`);
}
if(allRow.err !== '-' && Number(allRow.err) > 0) {
    violations.push(`err-rate ${allRow.err} > 0 — a case produced no trace`);
}
if(allRow.weak !== '-' && Number(allRow.weak) > 0) {
    violations.push(`weak-co ${allRow.weak} > 0 — a weak callout leaked past the production filter`);
}

if(violations.length > 0) {
    process.stderr.write('\neval-smoke: generation invariants violated:\n');
    for(const violation of violations) {
        process.stderr.write(`  - ${violation}\n`);
    }
    process.exit(1);
}

process.stdout.write('\neval-smoke: ok — retrieval within tolerance, generation invariants hold\n');

// The quality table prints fixed columns:
// type cite faith ground evid gap err shape weak dup co/excpt spine n
//
function parseAllRow(output) {
    const lines = String(output || '').split('\n');
    const headerIndex = lines.findIndex((line) => line.includes('generation quality by type'));
    if(headerIndex < 0) {
        return null;
    }
    const row = lines.slice(headerIndex).find((line) => /^all\s/.test(line.trim()));
    if(!row) {
        return null;
    }
    const cells = row.trim().split(/\s+/);
    if(cells.length < 9) {
        return null;
    }
    return {
        faith: cells[2],
        err: cells[6],
        weak: cells[8]
    };
}

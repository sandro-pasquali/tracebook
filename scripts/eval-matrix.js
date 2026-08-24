import path from 'node:path';
import process from 'node:process';
import fs from 'fs-extra';
import {execa} from 'execa';
import {promoteLastRun} from '../test/eval/report.js';

// Eval matrix runner — runs the retrieval (and optionally generation) eval over
// every repo in test/eval/matrix.json, so a retrieval/generation change is
// judged on repos it was NOT tuned on, not just the dogfood checkout.
//
//   node scripts/eval-matrix.js --save-baseline      # record current numbers
//   node scripts/eval-matrix.js --compare            # diff vs baselines, exit 1 on regression
//   node scripts/eval-matrix.js --compare --generation
//   node scripts/eval-matrix.js --compare --repo flask
//   node scripts/eval-matrix.js --promote [--generation] [--repo <name>]
//       # promote each entry's LAST RECORDED run to its baseline — a file
//       # copy, zero model time. Every --compare/--save run records itself
//       # under .eval-cache/last-runs/, so "compare, review, promote" never
//       # re-runs an eval just to write the baseline.
//
// Each entry gets a persistent index under .eval-cache/<name> (content-hash
// cache makes re-runs cheap; kept OUTSIDE data/ so clearing product data never
// destroys the enriched caches, whose LLM descriptions are non-deterministic to
// rebuild) and its own committed baseline under
// test/eval/baselines/<name>/. An entry's `setup` names the --import config for
// its regime: the default test config (enrichment off, free, runs anywhere) or
// setup-enriched-env.js (production enrichment regime — needs Ollama up when
// files have changed since the cached index). The generation eval needs real
// provider credentials and only runs when --generation is passed.
//
const projectRoot = path.resolve(import.meta.dirname, '..');
const matrixFile = path.join(projectRoot, 'test', 'eval', 'matrix.json');

const args = process.argv.slice(2);
const SAVE_BASELINE = args.includes('--save-baseline');
const COMPARE = args.includes('--compare');
const PROMOTE = args.includes('--promote');
const GENERATION = args.includes('--generation');
const repoFilter = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : null;

if([SAVE_BASELINE, COMPARE, PROMOTE].filter(Boolean).length > 1) {
    process.stderr.write(`pass only one of --save-baseline, --compare, --promote\n`);
    process.exit(1);
}

const modeFlag = SAVE_BASELINE ? '--save-baseline' : (COMPARE ? '--compare' : null);

async function runRepo(repo) {
    const root = path.resolve(projectRoot, repo.root);
    if(!await fs.pathExists(root)) {
        process.stdout.write(`\n[${repo.name}] SKIPPED — repo root not found: ${root}\n`);
        return {name: repo.name, skipped: true, ok: true};
    }
    const casesFile = repo.cases ? path.resolve(projectRoot, repo.cases) : null;
    if(casesFile && !await fs.pathExists(casesFile)) {
        process.stdout.write(`\n[${repo.name}] SKIPPED — cases file not found: ${casesFile}\n`);
        return {name: repo.name, skipped: true, ok: true};
    }

    const env = {
        ...process.env,
        EVAL_REPO_ROOT: root,
        EVAL_BASELINE_NAME: repo.name,
        EVAL_INDEX_DIR: path.join(projectRoot, '.eval-cache', repo.name)
    };
    if(casesFile) {
        env.EVAL_CASES = casesFile;
    }
    if(repo.overviewCases) {
        env.EVAL_OVERVIEW_CASES = path.resolve(projectRoot, repo.overviewCases);
    }

    const setup = repo.setup || './test/setup-env.js';
    const runs = [
        {label: 'retrieval', cmd: ['--import', setup, 'test/eval/retrieval-eval.js']}
    ];
    if(GENERATION) {
        runs.push({label: 'generation', cmd: ['test/eval/generation-eval.js']});
    }

    let ok = true;
    for(const run of runs) {
        const cmdArgs = modeFlag ? [...run.cmd, modeFlag] : run.cmd;
        process.stdout.write(`\n[${repo.name}] ${run.label} eval${modeFlag ? ` (${modeFlag})` : ''}\n`);
        try {
            await execa('node', cmdArgs, {cwd: projectRoot, env, stdio: 'inherit'});
        } catch {
            ok = false;
        }
    }
    return {name: repo.name, skipped: false, ok};
}

async function promoteRepo(repo) {
    const kinds = ['retrieval', ...(GENERATION ? ['generation'] : [])];
    let ok = true;
    for(const kind of kinds) {
        try {
            const {payload, target} = await promoteLastRun({
                cacheDir: path.join(projectRoot, '.eval-cache'),
                baselinesDir: path.join(projectRoot, 'test', 'eval', 'baselines'),
                repoName: repo.name,
                kind
            });
            process.stdout.write(`[${repo.name}] ${kind} baseline <- run recorded ${payload.savedAt} @ ${payload.gitRev} (${path.relative(projectRoot, target)})\n`);
        } catch(err) {
            process.stderr.write(`[${repo.name}] ${kind} promote failed: ${err?.message || err}\n`);
            ok = false;
        }
    }
    return {name: repo.name, skipped: false, ok};
}

async function main() {
    const matrix = await fs.readJson(matrixFile);
    const repos = repoFilter ? matrix.filter((r) => r.name === repoFilter) : matrix;
    if(repos.length === 0) {
        process.stderr.write(`no matrix entry named ${repoFilter}\n`);
        process.exit(1);
    }

    const results = [];
    for(const repo of repos) {
        results.push(PROMOTE ? await promoteRepo(repo) : await runRepo(repo));
    }

    process.stdout.write(`\nmatrix summary\n`);
    for(const result of results) {
        process.stdout.write(`  ${result.name.padEnd(12)} ${result.skipped ? 'skipped' : (result.ok ? 'ok' : 'FAILED')}\n`);
    }
    if(results.some((r) => !r.ok)) {
        process.exitCode = 1;
    }
}

main().catch((err) => {
    process.stderr.write(`eval matrix failed: ${err?.stack || err?.message || err}\n`);
    process.exitCode = 1;
});

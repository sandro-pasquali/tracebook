import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {createEmbedder} from '../../src/index/embedder.js';
import {createStore} from '../../src/index/store.js';
import {createIndexer} from '../../src/index/indexer.js';
import {createReranker} from '../../src/index/reranker.js';
import {createEnricher} from '../../src/index/enrichment.js';
import {DEFAULT_INDEX_EXCLUDE, DEFAULT_INDEX_INCLUDE} from '../../src/index/file-patterns.js';
import {runSearch} from '../../src/tools/search.js';
import {buildQuestionContext} from '../../src/planner/question-context.js';
import {config} from '../../src/util/config.js';
import {classifyQueryShape, PRODUCTION_QUERY_SHAPE_ARM, retrievalPolicyForShape} from '../../src/util/query-shape.js';
import {CASES, loadEvalCases} from './cases.js';
import {assertEnrichmentCoverage, baselineFile, compareToBaseline, hashCases, lastRunFile, printComparison, saveBaseline} from './report.js';

// Retrieval benchmark — per query TYPE and per retrieval LEVER, so we can decide
// what each leg earns its keep rather than overfit to a few cases.
//
//   node --import ./test/setup-env.js test/eval/retrieval-eval.js [k]
//   node --import ./test/eval/setup-enriched-env.js test/eval/retrieval-eval.js [k]   # enrichment ON
//
// NOTE: the config loader resolves keychain -> config file -> defaults and does
// NOT read process env — ENRICHMENT_ENABLED=true on the command line is a no-op.
// Use the setup-enriched-env import (or your real ~/.tracebook/tracebook.config.json) instead.
//
// Query types:
//   product    — plain product language, never names the file (PM/exec phrasing)
//   identifier — an exact symbol / config token / rare literal (BM25's home turf)
//   leaky      — the file name appears in the query (contrast / regression guard)
//
// Lever ladder (cumulative; enrichment is an index-time property, set separately):
//   vector  → +lexical(BM25) → +graph → +domainBoost(="hybrid") → +rerank(full)
// The incremental delta per step per type is the evidence: e.g. identifier cases
// should jump at +lexical (BM25 earning its keep); product cases should already be
// strong at vector when enrichment is on.
//
// EVAL_INDEX_DIR=<path> reuses a persistent index (content-hash cache → no
// re-enrich) so iteration after the first ~$0.05 enriched index is free.
//
// MEASURED SNAPSHOT (K=6, 48 cases, MiniLM + enrichment ON, reranker bge-base;
// with manifest demotion + .env exclusion):
//   recall@6                vector +lexical +graph +domain +rerank
//     product (18)           0.67    0.78    0.78    0.61    0.72
//     identifier (14)        0.50    0.79    0.79    1.00    1.00
//     leaky (11)             1.00    1.00    1.00    1.00    1.00
//     integration (5)        0.40    0.80    0.80    0.80    1.00
//     all (48)               0.67    0.83    0.83    0.83    0.90
//   MRR                     vector +lexical +graph +domain +rerank
//     product (18)           0.54    0.58    0.58    0.36    0.36
//     identifier (14)        0.31    0.50    0.50    0.79    0.88
//     leaky (11)             0.91    0.86    0.86    0.79    0.83
//     integration (5)        0.12    0.31    0.31    0.40    0.47
//     all (48)               0.51    0.59    0.59    0.59    0.63
// VERDICT (per lever, enrichment on):
//   - BM25 / domainBoost / rerank EARN THEIR KEEP — on identifier/exact-symbol
//     queries they take recall 0.50 -> 1.00 (MRR 0.31 -> 0.88).
//   - integration ("how do X and Y work together") needs the full pipeline: the
//     wiring file climbs to recall 1.00 at +rerank. The manifest demotion is what
//     keeps package.json from grabbing a top-K slot — e.g. for "how do hono and
//     vite work together" package.json sits at rank 5 at +lexical, then drops out
//     of the top-6 at +domain while vite.config.js holds rank 3 (see the
//     integration diagnostic printed below the tables).
//   - domain/rerank still modestly dent product MRR (a pre-existing trait: they
//     demote strong enriched-vector hits; the manifest demotion only touches
//     manifests, so it cannot lower a non-manifest answer).
//   - graph adds ~nothing here; enrichment lifts product/leaky vector strongly.
//   - Net: keep the full pipeline (best in aggregate: recall 0.90 / MRR 0.63),
//     since real users ask product, identifier, AND integration questions.
//

const here = import.meta.dirname;
const projectRoot = path.resolve(here, '..', '..');
const kArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const K = Math.max(1, Number(kArg || 6));
const RERANK_MODEL = process.env.RERANK_MODEL || 'Xenova/bge-reranker-base';

// --save-baseline persists this run's metrics under test/eval/baselines/<repo>/;
// --compare diffs against that file and exits non-zero on a gated regression.
// Gated = the production (+rerank) ladder step, per type with n >= GATE_MIN_N.
//
const SAVE_BASELINE = process.argv.includes('--save-baseline');
const COMPARE = process.argv.includes('--compare');
const SKIP_INDEX = process.argv.includes('--skip-index');
const BASELINES_DIR = path.join(here, 'baselines');
const GATE_MIN_N = 5;
const GATE_TOLERANCE = 0.05;

// CASES live in ./cases.js — the single source of truth shared with the
// generation eval, so a question added for one is measured by both.
//

const LADDER = [
    {name: 'vector', legs: {lexical: false, graph: false, domainBoost: false}, rerank: false},
    {name: '+lexical', legs: {lexical: true, graph: false, domainBoost: false}, rerank: false},
    {name: '+graph', legs: {lexical: true, graph: true, domainBoost: false}, rerank: false},
    {name: '+domain', legs: {lexical: true, graph: true, domainBoost: true}, rerank: false},
    {name: '+rerank', legs: {lexical: true, graph: true, domainBoost: true}, rerank: true}
];

// Leave-one-out ladder. The cumulative LADDER can hide interactions: "+graph = +0"
// might mask graph mattering ONCE rerank is on. LOO measures each lever's MARGINAL
// contribution with every OTHER lever present — the correct test before cutting a
// lever. `full` is the production pipeline; each `-x` row drops exactly one lever.
// A lever whose `full - (-x)` delta is ~0 is dead weight in the full pipeline.
//
const LOO = [
    {name: 'full', legs: {lexical: true, graph: true, domainBoost: true}, rerank: true},
    {name: '-lexical', legs: {lexical: false, graph: true, domainBoost: true}, rerank: true},
    {name: '-graph', legs: {lexical: true, graph: false, domainBoost: true}, rerank: true},
    {name: '-domain', legs: {lexical: true, graph: true, domainBoost: false}, rerank: true},
    {name: '-rerank', legs: {lexical: true, graph: true, domainBoost: true}, rerank: false}
];

// Compare retrieval with the RAW question vs the expandQueryVocabulary-EXPANDED
// query (what the planner's prefetch actually uses), full pipeline + rerank.
//
async function compareExpansion({embedder, store, reranker}) {
    const storyContext = {chapters: [], sourcePaths: []};
    const rawRanks = new Map();
    const hybridRanks = new Map();
    const expandedRanks = new Map();
    for(const testCase of CASES) {
        const expanded = buildQuestionContext({question: testCase.question, storyContext, classification: null}).retrievalQuestion;
        const [rawEmbedding] = await embedder.embed([testCase.question], {type: 'query'});
        const [expandedEmbedding] = await embedder.embed([expanded], {type: 'query'});
        // Three arms isolating the embedding query from the lexical query:
        //   raw      = embed(raw),      lexical(raw)
        //   hybrid   = embed(raw),      lexical(expanded)   <- the plan's proposed config
        //   expanded = embed(expanded), lexical(expanded)   <- current production
        //
        const arms = [
            [testCase.question, rawEmbedding, rawRanks],
            [expanded, rawEmbedding, hybridRanks],
            [expanded, expandedEmbedding, expandedRanks]
        ];
        for(const [queryText, queryEmbedding, ranks] of arms) {
            const embedding = Array.isArray(queryEmbedding) && queryEmbedding.length > 0 ? queryEmbedding : rawEmbedding;
            try {
                const result = await runSearch({queryText, queryEmbedding: embedding, limit: K, embedder, store, includeSupport: true, reranker});
                ranks.set(testCase.question, rankOfFirstHit(result.results, testCase.expect));
            } catch(err) {
                process.stderr.write(`search failed (${queryText.slice(0, 40)}...): ${err?.message}\n`);
                ranks.set(testCase.question, 0);
            }
        }
    }

    const types = ['all', 'product', 'identifier', 'leaky', 'integration'];
    process.stdout.write(`embed/lexical arms — full pipeline + rerank, K=${K}\n`);
    process.stdout.write('raw=embed(raw)+lex(raw)  hyb=embed(raw)+lex(exp)  exp=embed(exp)+lex(exp)\n\n');
    process.stdout.write(`${'type'.padEnd(12)}${'raw r@K'.padStart(9)}${'hyb r@K'.padStart(9)}${'exp r@K'.padStart(9)}${'raw MRR'.padStart(9)}${'hyb MRR'.padStart(9)}${'exp MRR'.padStart(9)}   n\n`);
    for(const type of types) {
        const cases = type === 'all' ? CASES : CASES.filter((c) => c.type === type);
        const r = score(cases, rawRanks);
        const h = score(cases, hybridRanks);
        const e = score(cases, expandedRanks);
        process.stdout.write(`${type.padEnd(12)}${r.recall.toFixed(2).padStart(9)}${h.recall.toFixed(2).padStart(9)}${e.recall.toFixed(2).padStart(9)}${r.mrr.toFixed(2).padStart(9)}${h.mrr.toFixed(2).padStart(9)}${e.mrr.toFixed(2).padStart(9)}   ${cases.length}\n`);
    }
}

// Shape-conditional lever arms (--shape-arms): classify each question's
// retrieval shape, then score every policy arm side by side. The decision table
// for making the domain boost shape-aware — the four baselines show it dents
// product queries on every repo/regime while earning its keep elsewhere.
//
const SHAPE_ARMS = ['production', 'no-domain-for-product', 'lexical-for-product', 'tiebreak-for-product'];
const SEMANTIC_THRESHOLD_ARMS = [null, 0.15, 0.2, 0.25, 0.45];

async function compareShapeArms({embedder, store, reranker, evalCases}) {
    const ranksByArm = new Map(SHAPE_ARMS.map((arm) => [arm, new Map()]));
    const shapeCounts = new Map();
    for(const testCase of evalCases) {
        const shape = classifyQueryShape(testCase.question);
        const key = `${testCase.type}/${shape}`;
        shapeCounts.set(key, (shapeCounts.get(key) || 0) + 1);
        const [queryEmbedding] = await embedder.embed([testCase.question], {type: 'query'});
        for(const arm of SHAPE_ARMS) {
            const policy = retrievalPolicyForShape(shape, {arm});
            const result = await runSearch({
                queryText: testCase.question,
                queryEmbedding,
                limit: K,
                embedder,
                store,
                includeSupport: true,
                legs: policy.legs,
                reranker: policy.rerank ? reranker : null
            });
            ranksByArm.get(arm).set(testCase.question, rankOfFirstHit(result.results, testCase.expect));
        }
    }

    const types = ['all', ...new Set(evalCases.map((c) => c.type))];
    const armHeader = SHAPE_ARMS.map((a) => a.replace('-for-product', '').padStart(12)).join('');
    process.stdout.write(`shape-conditional lever arms — K=${K}, cases=${evalCases.length} (arm suffix "-for-product" elided)\n\n`);
    for(const metric of ['recall', 'mrr']) {
        process.stdout.write(`${metric === 'recall' ? `recall@${K}` : 'MRR'} by type x arm\n`);
        process.stdout.write(`${'type'.padEnd(12)}${armHeader}   n\n`);
        for(const type of types) {
            const cases = type === 'all' ? evalCases : evalCases.filter((c) => c.type === type);
            const cells = SHAPE_ARMS.map((arm) => score(cases, ranksByArm.get(arm))[metric].toFixed(2).padStart(12)).join('');
            process.stdout.write(`${type.padEnd(12)}${cells}   ${cases.length}\n`);
        }
        process.stdout.write('\n');
    }
    process.stdout.write('classified shapes per case type (type/shape: n)\n');
    for(const [key, count] of [...shapeCounts.entries()].sort()) {
        process.stdout.write(`  ${key.padEnd(28)}${count}\n`);
    }
}

// A hybrid search result has no single score scale: cosine, BM25, graph, and
// cross-encoder ranks are deliberately fused. These arms therefore apply the
// configured threshold only to the dense-vector candidates while leaving exact
// lexical and graph evidence available. This is the decision table for whether
// SEARCH_SEMANTIC_THRESHOLD is safe to operate as a dense-candidate gate.
//
async function compareSemanticThresholdArms({embedder, store, reranker, evalCases}) {
    const ranksByArm = new Map(SEMANTIC_THRESHOLD_ARMS.map((threshold) => [thresholdLabel(threshold), new Map()]));
    const countsByArm = new Map(SEMANTIC_THRESHOLD_ARMS.map((threshold) => [thresholdLabel(threshold), {raw: 0, qualified: 0}]));
    for(const testCase of evalCases) {
        const [queryEmbedding] = await embedder.embed([testCase.question], {type: 'query'});
        for(const threshold of SEMANTIC_THRESHOLD_ARMS) {
            const label = thresholdLabel(threshold);
            const result = await runSearch({
                queryText: testCase.question,
                queryEmbedding,
                limit: K,
                embedder,
                store,
                includeSupport: true,
                reranker,
                semanticThreshold: threshold
            });
            ranksByArm.get(label).set(testCase.question, rankOfFirstHit(result.results, testCase.expect));
            const counts = countsByArm.get(label);
            counts.raw += result.retrieval.counts.vectorCandidatesRaw || 0;
            counts.qualified += result.retrieval.counts.vectorCandidates || 0;
        }
    }

    const labels = SEMANTIC_THRESHOLD_ARMS.map(thresholdLabel);
    const types = ['all', ...new Set(evalCases.map((c) => c.type))];
    const header = labels.map((label) => label.padStart(10)).join('');
    process.stdout.write(`semantic-vector threshold arms — production policy, K=${K}, cases=${evalCases.length}\n\n`);
    for(const metric of ['recall', 'mrr']) {
        process.stdout.write(`${metric === 'recall' ? `recall@${K}` : 'MRR'} by type x semantic threshold\n`);
        process.stdout.write(`${'type'.padEnd(12)}${header}   n\n`);
        for(const type of types) {
            const cases = type === 'all' ? evalCases : evalCases.filter((c) => c.type === type);
            const cells = labels.map((label) => score(cases, ranksByArm.get(label))[metric].toFixed(2).padStart(10)).join('');
            process.stdout.write(`${type.padEnd(12)}${cells}   ${cases.length}\n`);
        }
        process.stdout.write('\n');
    }
    process.stdout.write('vector candidates retained\n');
    for(const label of labels) {
        const counts = countsByArm.get(label);
        const share = counts.raw > 0 ? counts.qualified / counts.raw : 0;
        process.stdout.write(`  ${label.padEnd(8)} ${counts.qualified}/${counts.raw} (${(share * 100).toFixed(1)}%)\n`);
    }
}

function thresholdLabel(value) {
    return value === null ? 'off' : value.toFixed(2);
}

function rankOfFirstHit(results, expect) {
    for(let i = 0; i < results.length; i++) {
        if(expect.includes(results[i].path)) {
            return i + 1;
        }
    }
    return 0;
}

function rankOfPath(results, target) {
    for(let i = 0; i < results.length; i++) {
        if(results[i].path === target) {
            return i + 1;
        }
    }
    return 0;
}

function fmtRank(rank) {
    return (rank > 0 ? String(rank) : '-').padStart(9);
}

function score(cases, rankByQuestion) {
    let hits = 0;
    let rrSum = 0;
    for(const testCase of cases) {
        const rank = rankByQuestion.get(testCase.question) || 0;
        if(rank > 0) {
            hits++;
            rrSum += 1 / rank;
        }
    }
    const n = cases.length || 1;
    return {recall: hits / n, mrr: rrSum / n, n: cases.length};
}

async function main() {
    const persistent = process.env.EVAL_INDEX_DIR ? path.resolve(process.env.EVAL_INDEX_DIR) : null;
    const indexRoot = persistent || await fs.mkdtemp(path.join(os.tmpdir(), 'tb-eval-index-'));
    const targetRoot = process.env.EVAL_REPO_ROOT ? path.resolve(process.env.EVAL_REPO_ROOT) : projectRoot;
    const evalCases = await loadEvalCases();
    let embedder = null;
    let store = null;
    let reranker = null;

    try {
        embedder = createEmbedder();
        store = await createStore({root: indexRoot, dims: embedder.dims});
        const enricher = createEnricher({
            model: config.enrichment.model,
            enabled: config.enrichment.enabled,
            maxOutputTokens: config.enrichment.maxOutputTokens,
            maxInputChars: config.enrichment.maxInputChars,
            timeoutMs: config.enrichment.timeoutMs
        });
        const indexer = createIndexer({
            root: targetRoot,
            include: DEFAULT_INDEX_INCLUDE,
            exclude: DEFAULT_INDEX_EXCLUDE,
            embedder,
            store,
            enricher
        });

        const repoLabel = targetRoot === projectRoot ? 'dogfood repo' : targetRoot;
        if(SKIP_INDEX) {
            if(!persistent) {
                throw new Error('--skip-index requires EVAL_INDEX_DIR to identify an existing index');
            }
            process.stdout.write(`reusing ${repoLabel}${enricher ? ' (enrichment ON)' : ''} [persistent, index skipped]\n\n`);
        } else {
            process.stdout.write(`indexing ${repoLabel}${enricher ? ' (enrichment ON)' : ''}${persistent ? ' [persistent]' : ''}... `);
            const stats = await indexer.indexAll();
            process.stdout.write(`done (${stats.indexedFiles} files, ${stats.chunksInStore} chunks)\n\n`);
            assertEnrichmentCoverage(stats);
        }

        reranker = createReranker({model: RERANK_MODEL, dtype: 'q8', candidates: 20, enabled: true});

        if(process.argv.includes('--compare-expansion')) {
            await compareExpansion({embedder, store, reranker});
            return;
        }

        if(process.argv.includes('--shape-arms')) {
            await compareShapeArms({embedder, store, reranker, evalCases});
            return;
        }

        if(process.argv.includes('--threshold-arms')) {
            await compareSemanticThresholdArms({embedder, store, reranker, evalCases});
            return;
        }

        const ranks = new Map(LADDER.map((step) => [step.name, new Map()]));
        const manifestRanks = new Map(LADDER.map((step) => [step.name, new Map()]));
        const looRanks = new Map(LOO.map((step) => [step.name, new Map()]));
        // The production path: no explicit legs, so runSearch applies the shipped
        // shape-aware policy. This is the row the regression gate must guard —
        // the ladder isolates levers; `policy` measures what users actually get.
        //
        const policyRanks = new Map();

        for(const testCase of evalCases) {
            const [queryEmbedding] = await embedder.embed([testCase.question], {type: 'query'});
            const policyResult = await runSearch({
                queryText: testCase.question,
                queryEmbedding,
                limit: K,
                embedder,
                store,
                includeSupport: true,
                reranker
            });
            policyRanks.set(testCase.question, rankOfFirstHit(policyResult.results, testCase.expect));
            for(const step of [...LADDER, ...LOO]) {
                const target = LADDER.includes(step) ? ranks : looRanks;
                const result = await runSearch({
                    queryText: testCase.question,
                    queryEmbedding,
                    limit: K,
                    embedder,
                    store,
                    includeSupport: true,
                    legs: step.legs,
                    reranker: step.rerank ? reranker : null
                });
                target.get(step.name).set(testCase.question, rankOfFirstHit(result.results, testCase.expect));
                if(target === ranks) {
                    manifestRanks.get(step.name).set(testCase.question, rankOfPath(result.results, manifestPathFor(testCase)));
                }
            }
        }

        const types = ['all', 'product', 'identifier', 'leaky', 'integration'];
        const stepHeader = LADDER.map((s) => s.name.padStart(9)).join('');
        process.stdout.write(`enrichment: ${enricher ? 'ON' : 'off'}   K=${K}   cases=${evalCases.length}\n\n`);
        process.stdout.write(`recall@${K} by type x lever (cumulative)\n`);
        process.stdout.write(`${'type'.padEnd(11)}${stepHeader}   n\n`);
        for(const type of types) {
            const cases = type === 'all' ? evalCases : evalCases.filter((c) => c.type === type);
            const cells = LADDER.map((s) => score(cases, ranks.get(s.name)).recall.toFixed(2).padStart(9)).join('');
            process.stdout.write(`${type.padEnd(11)}${cells}   ${cases.length}\n`);
        }
        process.stdout.write(`\nMRR by type x lever (cumulative)\n`);
        process.stdout.write(`${'type'.padEnd(11)}${stepHeader}   n\n`);
        for(const type of types) {
            const cases = type === 'all' ? evalCases : evalCases.filter((c) => c.type === type);
            const cells = LADDER.map((s) => score(cases, ranks.get(s.name)).mrr.toFixed(2).padStart(9)).join('');
            process.stdout.write(`${type.padEnd(11)}${cells}   ${cases.length}\n`);
        }

        // Leave-one-out: each lever's MARGINAL value in the FULL pipeline. The
        // `Δ` rows are full minus the variant — a lever with Δ ≈ 0 (and no per-type
        // win) is not earning its keep and is a cut candidate. This is the decision
        // table; the cumulative ladder above can mask interactions.
        //
        const looHeader = LOO.map((s) => s.name.padStart(9)).join('');
        printLeaveOneOut({label: `recall@${K}`, metric: 'recall', types, evalCases, looRanks, looHeader});
        printLeaveOneOut({label: 'MRR', metric: 'mrr', types, evalCases, looRanks, looHeader});

        process.stdout.write(`\nproduction policy (shape-aware, arm=${PRODUCTION_QUERY_SHAPE_ARM}) — what runSearch does with no explicit legs\n`);
        process.stdout.write(`${'type'.padEnd(11)}${'recall'.padStart(9)}${'MRR'.padStart(9)}   n\n`);
        for(const type of types) {
            const cases = type === 'all' ? evalCases : evalCases.filter((c) => c.type === type);
            const s = score(cases, policyRanks);
            process.stdout.write(`${type.padEnd(11)}${s.recall.toFixed(2).padStart(9)}${s.mrr.toFixed(2).padStart(9)}   ${cases.length}\n`);
        }

        if(SAVE_BASELINE || COMPARE) {
            const repoName = process.env.EVAL_BASELINE_NAME || (targetRoot === projectRoot ? 'tracebook' : path.basename(targetRoot));
            const metrics = {
                ladder: collectStepMetrics({steps: LADDER, rankMaps: ranks, evalCases}),
                loo: collectStepMetrics({steps: LOO, rankMaps: looRanks, evalCases}),
                policy: collectStepMetrics({steps: [{name: 'production'}], rankMaps: new Map([['production', policyRanks]]), evalCases}).production
            };
            const conditions = {
                kind: 'retrieval',
                repo: repoName,
                k: K,
                caseCount: evalCases.length,
                casesHash: hashCases(evalCases),
                embeddings: {
                    model: config.embeddings.model,
                    dims: config.embeddings.dims,
                    dtype: config.embeddings.dtype,
                    queryPrefix: config.embeddings.queryPrefix,
                    docPrefix: config.embeddings.docPrefix
                },
                enrichment: {enabled: Boolean(enricher), model: enricher ? config.enrichment.model : null},
                rerankModel: RERANK_MODEL,
                queryShapeArm: PRODUCTION_QUERY_SHAPE_ARM
            };
            const file = baselineFile({baselinesDir: BASELINES_DIR, repoName, kind: 'retrieval'});
            // Always record the run so a later baseline refresh is a file
            // promotion (eval-matrix --promote) instead of a re-run.
            //
            await saveBaseline({
                file: lastRunFile({cacheDir: path.join(projectRoot, '.eval-cache'), repoName, kind: 'retrieval'}),
                conditions,
                metrics,
                projectRoot
            });
            if(SAVE_BASELINE) {
                await saveBaseline({file, conditions, metrics, projectRoot});
                process.stdout.write(`\nbaseline saved: ${path.relative(projectRoot, file)}\n`);
            } else {
                const result = await compareToBaseline({
                    file,
                    conditions,
                    metrics,
                    tolerance: GATE_TOLERANCE,
                    isGated: (key) => {
                        const [group, step, type] = key.split('.');
                        if(group === 'policy') {
                            return (metrics.policy[step]?.n || 0) >= GATE_MIN_N;
                        }
                        if(group !== 'ladder' || step !== '+rerank') {
                            return false;
                        }
                        return (metrics.ladder['+rerank'][type]?.n || 0) >= GATE_MIN_N;
                    }
                });
                printComparison({label: `retrieval (${repoName})`, result});
                if(!result.ok) {
                    process.exitCode = 1;
                }
            }
        }

        const integrationCases = evalCases.filter((c) => c.type === 'integration');
        if(integrationCases.length > 0) {
            process.stdout.write(`\nintegration diagnostic — rank of expected wiring file (W) vs package.json (P) per lever\n`);
            process.stdout.write(`${'question'.padEnd(52)}${stepHeader}\n`);
            for(const testCase of integrationCases) {
                const wired = LADDER.map((s) => fmtRank(ranks.get(s.name).get(testCase.question) || 0)).join('');
                const manifest = LADDER.map((s) => fmtRank(manifestRanks.get(s.name).get(testCase.question) || 0)).join('');
                process.stdout.write(`${`W ${testCase.question}`.slice(0, 52).padEnd(52)}${wired}\n`);
                process.stdout.write(`${`P (${manifestPathFor(testCase)})`.padEnd(52)}${manifest}\n`);
            }
        }
    } finally {
        await cleanup({reranker, embedder, store});
        if(!persistent) {
            await fs.remove(indexRoot);
        }
    }
}

main().catch((err) => {
    process.stderr.write(`retrieval eval failed: ${err?.stack || err?.message || err}\n`);
    process.exitCode = 1;
});

// Print one leave-one-out table (recall or MRR) plus a `Δ` row per non-`full`
// lever: full minus that variant = the lever's marginal contribution.
//
function printLeaveOneOut({label, metric, types, evalCases, looRanks, looHeader}) {
    process.stdout.write(`\n${label} leave-one-out (full pipeline minus one lever)\n`);
    process.stdout.write(`${'type'.padEnd(11)}${looHeader}   n\n`);
    for(const type of types) {
        const cases = type === 'all' ? evalCases : evalCases.filter((c) => c.type === type);
        const cells = LOO.map((s) => score(cases, looRanks.get(s.name))[metric].toFixed(2).padStart(9)).join('');
        process.stdout.write(`${type.padEnd(11)}${cells}   ${cases.length}\n`);
    }
    // Marginal value of each dropped lever, aggregate over all cases.
    //
    const fullScore = score(evalCases, looRanks.get('full'))[metric];
    const deltas = LOO.map((s) => {
        if(s.name === 'full') {
            return ''.padStart(9);
        }
        const delta = fullScore - score(evalCases, looRanks.get(s.name))[metric];
        return `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`.padStart(9);
    }).join('');
    process.stdout.write(`${'Δ all'.padEnd(11)}${deltas}   marginal value of each lever\n`);
}

// Integration cases name the manifest their wiring file must outrank. Cases
// without one default to the npm manifest (the dogfood repo's ecosystem);
// external case sets label their own (e.g. pyproject.toml for a Python repo).
//
function manifestPathFor(testCase) {
    return testCase.manifest || 'package.json';
}

function collectStepMetrics({steps, rankMaps, evalCases}) {
    const presentTypes = ['all', ...new Set(evalCases.map((c) => c.type))];
    const metrics = {};
    for(const step of steps) {
        metrics[step.name] = {};
        for(const type of presentTypes) {
            const cases = type === 'all' ? evalCases : evalCases.filter((c) => c.type === type);
            const scored = score(cases, rankMaps.get(step.name));
            metrics[step.name][type] = {
                recall: Number(scored.recall.toFixed(4)),
                mrr: Number(scored.mrr.toFixed(4)),
                n: cases.length
            };
        }
    }
    return metrics;
}

async function cleanup({reranker, embedder, store}) {
    await reranker?.dispose?.();
    await embedder?.dispose?.();
    await store?.close?.();
}

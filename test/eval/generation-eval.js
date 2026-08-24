import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {generateObject} from 'ai';
import {z} from 'zod';
import {createEmbedder} from '../../src/index/embedder.js';
import {createStore} from '../../src/index/store.js';
import {createIndexer} from '../../src/index/indexer.js';
import {createReranker} from '../../src/index/reranker.js';
import {createEnricher} from '../../src/index/enrichment.js';
import {DEFAULT_INDEX_EXCLUDE, DEFAULT_INDEX_INCLUDE} from '../../src/index/file-patterns.js';
import {createTools} from '../../src/tools/index.js';
import {runPlanner} from '../../src/planner/index.js';
import {resolveModel} from '../../src/util/model.js';
import {config} from '../../src/util/config.js';
import {isWeakNote} from '../../src/planner/grounding/weak-notes.js';
import {loadEvalCases, loadOverviewCases} from './cases.js';
import {assertEnrichmentCoverage, baselineFile, compareToBaseline, hashCases, lastRunFile, printComparison, saveBaseline} from './report.js';

// Generation / grounding benchmark — the answer to "are the retrieved chunks
// turned into chapter blocks IDEALLY?". The retrieval eval proves search surfaces
// the right file; this proves the LLM-built blocks actually CITE and GROUND in it.
//
//   node test/eval/generation-eval.js [limit]
//   GEN_EVAL_LIMIT=8 node test/eval/generation-eval.js        # cheap smoke
//   GEN_EVAL_JUDGE=true node test/eval/generation-eval.js     # + LLM faithfulness
//   EVAL_INDEX_DIR=<path> node test/eval/generation-eval.js   # reuse a warm index
//
// This runs the REAL planner with REAL models (exploration, outline, synthesis,
// annotation) and verifies every metric against source on disk — so it cannot be
// faked by mocking. It needs real provider credentials and is NOT part of
// `yarn verify` (cost + non-determinism), exactly like the retrieval eval.
//
// Metrics, grouped by query type:
//   cite@trace   — fraction of cases where a block cites an expected file (the true
//                  end-to-end signal: did the ANSWER, not just retrieval, surface it)
//   excerpt-faith— fraction of annotated_code_excerpt blocks whose code is verbatim
//                  present in the file it cites (hard grounding of code blocks)
//   ground-prec  — fraction of all sourceRefs whose cited path exists on disk
//   in-evidence  — fraction of all sourceRefs whose path appeared in the evidence
//                  the model was given (cited-from-evidence, not invented)
//   gap-rate     — fraction of blocks that are evidence_callout kind=gap (a high
//                  rate means synthesis is silently failing to ground)
//   err-rate     — fraction of cases that produced no trace (trace.error / no complete)
//   judge-supp   — (GEN_EVAL_JUDGE) fraction of evidence_callout claims an LLM judge
//                  rates as supported by the cited source
//
const here = import.meta.dirname;
const projectRoot = path.resolve(here, '..', '..');
// EVAL_REPO_ROOT runs the planner against a repo OTHER than this one, paired
// with EVAL_CASES labeled for it — the generalization arm of the eval matrix.
// Every disk check (indexing, tools, excerpt faithfulness) resolves against the
// target repo, not the dogfood checkout.
//
const targetRoot = process.env.EVAL_REPO_ROOT ? path.resolve(process.env.EVAL_REPO_ROOT) : projectRoot;
const limitArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const LIMIT = Number(process.env.GEN_EVAL_LIMIT || limitArg || 0) || 0;
const SAVE_BASELINE = process.argv.includes('--save-baseline');
const COMPARE = process.argv.includes('--compare');
const BASELINES_DIR = path.join(here, 'baselines');
const GATE_MIN_N = 10;
const GATE_TOLERANCE = 0.1;
// Pass/fail leaves for --compare; the rest (shape, judge, coPerExc, n) are
// reported as info. Direction (higher/lower-better) lives in report.js.
//
const GATED_LEAVES = new Set(['cite', 'faith', 'ground', 'evid', 'gap', 'err', 'weakCallouts']);
// GEN_EVAL_PER_TYPE=N keeps the first N cases of EACH type — a cheap stratified
// sample that still reads every query type, since CASES are grouped by type.
//
const PER_TYPE = Number(process.env.GEN_EVAL_PER_TYPE || 0);
const JUDGE = String(process.env.GEN_EVAL_JUDGE).toLowerCase() === 'true' || process.argv.includes('--judge');
// --probe runs the zero-score shape set instead of the shared CASES. These are
// dependency/setup/config questions that classify zero-score (no intent scorer
// matches), the only questions the #2 fix changes. Each expects a code excerpt of
// the wiring file, NOT the __dependencies__ doc. Kept here (not in cases.js) so the
// retrieval baseline is untouched.
//
const PROBE = process.argv.includes('--probe') || String(process.env.GEN_EVAL_PROBE).toLowerCase() === 'true';
const REASONING_PROBE = process.argv.includes('--reasoning-probe') || String(process.env.GEN_EVAL_REASONING_PROBE).toLowerCase() === 'true';
const OVERVIEW_PROBE = process.argv.includes('--overview-probe') || String(process.env.GEN_EVAL_OVERVIEW_PROBE).toLowerCase() === 'true';
const PROBE_CASES = [
    {type: 'setup', question: 'What dependencies does the node server use to set up the server and routing?', expect: ['src/server.js'], expectShapes: ['annotated_code_excerpt']},
    {type: 'setup', question: 'what library powers the http server?', expect: ['src/server.js'], expectShapes: ['annotated_code_excerpt']},
    {type: 'setup', question: 'what does the app use for static asset serving in production?', expect: ['src/server.js'], expectShapes: ['annotated_code_excerpt']},
    {type: 'setup', question: 'what packages does the indexer rely on for embeddings?', expect: ['src/index/embedder.js'], expectShapes: ['annotated_code_excerpt']},
    {type: 'setup', question: 'what powers the vector database layer?', expect: ['src/index/store.js'], expectShapes: ['annotated_code_excerpt']}
];

// Product-completeness probe: these are not simple location questions. They
// test whether the answer explains a mechanism, communicates product value,
// and recovers a decision/tradeoff from source comments. Kept opt-in so adding
// qualitative coverage does not silently rewrite the stable release baselines.
//
const REASONING_CASES = [
    {
        type: 'mechanism',
        question: 'How do semantic, lexical, and graph signals combine into the final code search results?',
        expect: ['src/tools/search.js'],
        expectShapes: ['mermaid_figure']
    },
    {
        type: 'product_value',
        question: 'What does Tracebook give a developer who needs to understand an unfamiliar codebase before changing it?',
        expect: ['README.md'],
        expectShapes: ['evidence_callout']
    },
    {
        type: 'decision',
        question: 'Why does full-repository indexing use cooperative async work instead of a worker-thread pool?',
        expect: ['src/index/indexer.js'],
        expectShapes: ['annotated_code_excerpt']
    },
    {
        type: 'decision',
        question: 'Why are reranking and domain boosts skipped for plain product-language searches?',
        expect: ['src/util/query-shape.js'],
        expectShapes: ['annotated_code_excerpt']
    }
];

function selectCases(allCases) {
    if(OVERVIEW_PROBE) {
        return [];
    }
    if(REASONING_PROBE) {
        return REASONING_CASES;
    }
    if(PROBE) {
        return PROBE_CASES;
    }
    if(PER_TYPE > 0) {
        const seen = new Map();
        return allCases.filter((c) => {
            const n = seen.get(c.type) || 0;
            seen.set(c.type, n + 1);
            return n < PER_TYPE;
        });
    }
    return allCases.slice(0, LIMIT || allCases.length);
}

// The block kind a well-formed answer SHOULD include for this query type. A case
// may override with its own `expectShapes`. Soft: product/integration are
// explanatory (a callout or diagram is fine); identifier asks "where is X" so a
// code excerpt of X is the natural shape.
//
const EXPECTED_SHAPE = {
    identifier: 'annotated_code_excerpt'
};

function expectedShapeFor(testCase) {
    return testCase.expectShapes?.[0] || EXPECTED_SHAPE[testCase.type] || null;
}

// weak-co is a LEAK GATE: it counts callouts matching the production weak-note
// predicate (imported from weak-notes.js — single source of truth). Production
// filters with the same predicate, so anything counted here shipped through a
// path that skipped or escaped filtering; the expected value is ~0 and it is
// gated. It deliberately cannot measure quality — that is dup-co's job below.
//
// dup-co is the INDEPENDENT template-ness measure: mask code-ish tokens in each
// note and report the share of notes whose masked form repeats within the run.
// Template factories (and LLM boilerplate) are repeated phrasings with one
// substituted token, so they collapse to identical masked forms. Production
// never sees this predicate, so the filter it audits cannot game it.
//
function maskNote(note) {
    return String(note || '')
        .replaceAll(/`[^`]*`/g, 'X')
        .replaceAll(/[\w$./()-]*(?:[A-Z_./()]|\d)[\w$./()-]*/g, 'X')
        .replaceAll(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function normalize(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

const fileCache = new Map();
async function fileText(relPath) {
    if(!relPath) {
        return null;
    }
    if(fileCache.has(relPath)) {
        return fileCache.get(relPath);
    }
    let text = null;
    try {
        const abs = path.resolve(targetRoot, relPath);
        if(abs.startsWith(targetRoot) && await fs.pathExists(abs)) {
            text = normalize(await fs.readFile(abs, 'utf8'));
        }
    } catch {
        text = null;
    }
    fileCache.set(relPath, text);
    return text;
}

function collectSourceRefs(components) {
    const refs = [];
    for(const component of components) {
        for(const ref of component.sourceRefs || []) {
            if(ref?.path) {
                refs.push(ref);
            }
        }
    }
    return refs;
}

async function runCase(testCase, deps) {
    const events = [];
    try {
        for await (const event of runPlanner({
            question: testCase.question,
            storyContext: {chapters: [], sourcePaths: []},
            tools: deps.tools,
            embedder: deps.embedder,
            store: deps.store,
            reranker: deps.reranker,
            governor: null,
            traceIndexer: null,
            precomputedSimilarTraces: []
        })) {
            events.push(event);
        }
    } catch(err) {
        process.stderr.write(`  case errored (${testCase.question.slice(0, 40)}...): ${err?.message}\n`);
    }
    const complete = [...events].reverse().find((e) => e.type === 'trace.complete');
    const evidencePaths = new Set();
    for(const event of events) {
        if(event.type === 'evidence.ready') {
            for(const item of event.items || []) {
                if(item?.path) {
                    evidencePaths.add(item.path);
                }
            }
        }
    }
    return {
        components: complete?.trace?.components || [],
        evidencePaths,
        errored: !complete
    };
}

// LLM judge: is the callout's claim supported by the source it cites? Default to
// "unsupported" on any doubt so the metric is conservative.
//
const VERDICT_SCHEMA = z.object({
    verdict: z.enum(['supported', 'unsupported', 'contradicted']),
    why: z.string()
});

async function judgeCallout(component) {
    const refs = component.sourceRefs || [];
    const slices = [];
    for(const ref of refs.slice(0, 3)) {
        const text = await fileText(ref.path);
        if(text) {
            slices.push(`# ${ref.path}\n${text.slice(0, 4000)}`);
        }
    }
    if(slices.length === 0) {
        return 'unsupported';
    }
    try {
        const {object} = await generateObject({
            model: resolveModel(config.models.outline),
            schema: VERDICT_SCHEMA,
            prompt: `You are grading whether a claim is supported by source code.\n\nCLAIM: ${component.summary}\nDETAIL: ${component.detail}\n\nSOURCE:\n${slices.join('\n\n')}\n\nRespond supported only if the source clearly backs the claim; contradicted if it conflicts; unsupported if the source does not establish it. Be strict.`,
            maxOutputTokens: 200
        });
        return object.verdict;
    } catch {
        return 'unsupported';
    }
}

// null (rendered as "-") when there's nothing to divide, so "no code excerpts to
// check" reads as N/A instead of a misleading 0.00.
//
function pct(n, d) {
    return d > 0 ? (n / d) : null;
}

async function main() {
    const persistent = process.env.EVAL_INDEX_DIR ? path.resolve(process.env.EVAL_INDEX_DIR) : null;
    const indexRoot = persistent || await fs.mkdtemp(path.join(os.tmpdir(), 'tb-gen-eval-'));
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
        process.stdout.write(`indexing ${repoLabel}${config.enrichment.enabled ? ' (enrichment ON)' : ''}${persistent ? ' [persistent]' : ''}... `);
        const stats = await indexer.indexAll();
        process.stdout.write(`done (${stats.indexedFiles} files, ${stats.chunksInStore} chunks)\n`);
        assertEnrichmentCoverage(stats);

        reranker = createReranker({
            model: config.rerank.model,
            dtype: 'q8',
            candidates: config.rerank.candidates,
            enabled: config.rerank.enabled
        });
        const tools = createTools({
            embedder,
            store,
            root: targetRoot,
            include: DEFAULT_INDEX_INCLUDE,
            exclude: DEFAULT_INDEX_EXCLUDE,
            reranker
        });

        // Overview cases ride along on every non-probe run: their spine metric
        // (fraction of the repo's entry/orchestration/core files the answer
        // cites) is the system-overview quality signal.
        //
        const cases = [...selectCases(await loadEvalCases()), ...(PROBE || REASONING_PROBE ? [] : await loadOverviewCases())];
        process.stdout.write(`running ${cases.length} cases through the full planner with real models${JUDGE ? ' + judge' : ''}...\n`);

        // Cases are independent; a small worker pool overlaps the model-bound
        // wall time (tool calls, embedding, annotation) without flooding a
        // single local Ollama instance. Results land at their case index so
        // aggregates stay order-stable; progress lines may interleave.
        //
        const concurrency = Math.max(1, Number(process.env.GEN_EVAL_CONCURRENCY || 2));
        const perCase = [];
        let nextCase = 0;
        const evaluateCase = async (testCase, i) => {
            const {components, evidencePaths, errored} = await runCase(testCase, {embedder, store, reranker, tools});

            const citedPaths = new Set(collectSourceRefs(components).map((r) => r.path));
            const citationHit = testCase.expect.some((p) => citedPaths.has(p));
            if(process.env.TB_EVAL_DEBUG) {
                process.stdout.write(`  DEBUG cited: ${[...citedPaths].join(', ')}\n  DEBUG evidence: ${[...evidencePaths].slice(0, 12).join(', ')}\n`);
            }
            const spine = testCase.type === 'overview'
                ? testCase.expect.filter((p) => citedPaths.has(p)).length / testCase.expect.length
                : null;

            const excerpts = components.filter((c) => c.type === 'annotated_code_excerpt');
            let faithfulExcerpts = 0;
            for(const excerpt of excerpts) {
                const refPath = excerpt.sourceRefs?.[0]?.path;
                const fileBody = await fileText(refPath);
                const code = normalize(excerpt.code);
                if(fileBody && code && fileBody.includes(code)) {
                    faithfulExcerpts++;
                }
            }

            const refs = collectSourceRefs(components);
            let refsOnDisk = 0;
            let refsInEvidence = 0;
            for(const ref of refs) {
                if(await fileText(ref.path)) {
                    refsOnDisk++;
                }
                if(evidencePaths.has(ref.path)) {
                    refsInEvidence++;
                }
            }

            const gaps = components.filter((c) => c.type === 'evidence_callout' && c.kind === 'gap');
            const expectedShape = expectedShapeFor(testCase);
            const shapeHit = expectedShape ? components.some((c) => c.type === expectedShape) : null;

            const allCallouts = excerpts.flatMap((c) => c.callouts || []);
            const weakCallouts = allCallouts.filter((co) => isWeakNote(co.note)).length;
            const maskedNotes = allCallouts.map((co) => maskNote(co.note));

            let judged = null;
            if(JUDGE) {
                const callouts = components.filter((c) => c.type === 'evidence_callout' && c.kind !== 'gap');
                let supported = 0;
                for(const callout of callouts) {
                    if(await judgeCallout(callout) === 'supported') {
                        supported++;
                    }
                }
                judged = {supported, total: callouts.length};
            }

            process.stdout.write(`  [${i + 1}/${cases.length}] ${testCase.type.padEnd(11)} ${citationHit ? 'cite✓' : 'cite✗'} ${errored ? '(errored)' : `${components.length} blocks`}\n`);
            return {
                type: testCase.type,
                errored,
                citationHit,
                components: components.length,
                excerpts: excerpts.length,
                faithfulExcerpts,
                refs: refs.length,
                refsOnDisk,
                refsInEvidence,
                gaps: gaps.length,
                callouts: allCallouts.length,
                weakCallouts,
                maskedNotes,
                spine,
                shapeHit,
                judged
            };
        };
        const worker = async () => {
            while(nextCase < cases.length) {
                const i = nextCase++;
                perCase[i] = await evaluateCase(cases[i], i);
            }
        };
        await Promise.all(Array.from({length: Math.min(concurrency, cases.length)}, () => worker()));

        report(perCase);

        if(SAVE_BASELINE || COMPARE) {
            const repoName = process.env.EVAL_BASELINE_NAME || (targetRoot === projectRoot ? 'tracebook' : path.basename(targetRoot));
            const metrics = collectMetrics(perCase);
            const conditions = {
                kind: 'generation',
                repo: repoName,
                caseCount: cases.length,
                casesHash: hashCases(cases),
                embeddings: {
                    model: config.embeddings.model,
                    dims: config.embeddings.dims,
                    dtype: config.embeddings.dtype,
                    queryPrefix: config.embeddings.queryPrefix,
                    docPrefix: config.embeddings.docPrefix
                },
                enrichment: {enabled: config.enrichment.enabled, model: config.enrichment.enabled ? config.enrichment.model : null},
                rerank: {enabled: config.rerank.enabled, model: config.rerank.model},
                models: config.models
            };
            const file = baselineFile({baselinesDir: BASELINES_DIR, repoName, kind: 'generation'});
            // Always record the run so a later baseline refresh is a file
            // promotion (eval-matrix --promote) instead of a re-run — a full
            // generation pass costs real model-hours.
            //
            await saveBaseline({
                file: lastRunFile({cacheDir: path.join(projectRoot, '.eval-cache'), repoName, kind: 'generation'}),
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
                        const [group, type, leaf] = key.split('.');
                        if(group !== 'types' || !GATED_LEAVES.has(leaf)) {
                            return false;
                        }
                        return (metrics.types[type]?.n || 0) >= GATE_MIN_N;
                    }
                });
                printComparison({label: `generation (${repoName})`, result});
                if(!result.ok) {
                    process.exitCode = 1;
                }
            }
        }
    } finally {
        await reranker?.dispose?.();
        await embedder?.dispose?.();
        await store?.close?.();
        if(!persistent) {
            await fs.remove(indexRoot);
        }
    }
}

// Share of callout notes whose masked form occurs more than once across the
// slice — see maskNote above.
//
function meanOf(rows, key) {
    const values = rows.map((r) => r[key]).filter((v) => typeof v === 'number');
    if(values.length === 0) {
        return null;
    }
    return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function dupShare(rows) {
    const allNotes = rows.flatMap((r) => r.maskedNotes || []);
    if(allNotes.length === 0) {
        return null;
    }
    const freq = new Map();
    for(const note of allNotes) {
        freq.set(note, (freq.get(note) || 0) + 1);
    }
    const duplicated = allNotes.filter((note) => freq.get(note) > 1).length;
    return duplicated / allNotes.length;
}

function aggregate(rows) {
    const sum = (key) => rows.reduce((acc, r) => acc + r[key], 0);
    const shapeRows = rows.filter((r) => r.shapeHit !== null);
    const judgedTotal = rows.reduce((acc, r) => acc + (r.judged?.total || 0), 0);
    const judgedSupported = rows.reduce((acc, r) => acc + (r.judged?.supported || 0), 0);
    return {
        n: rows.length,
        cite: pct(rows.filter((r) => r.citationHit).length, rows.length),
        faith: pct(sum('faithfulExcerpts'), sum('excerpts')),
        ground: pct(sum('refsOnDisk'), sum('refs')),
        evid: pct(sum('refsInEvidence'), sum('refs')),
        gap: pct(sum('gaps'), sum('components')),
        err: pct(rows.filter((r) => r.errored).length, rows.length),
        shape: shapeRows.length > 0 ? pct(shapeRows.filter((r) => r.shapeHit).length, shapeRows.length) : null,
        // callout quality: weak-co = leak gate (production predicate; expect ~0),
        // dup-co = independent template-ness (repeated masked phrasings), and mean
        // callouts per excerpt (enforced floor is 1 — fewer teaching notes beat
        // padded filler; watch this stays >= ~2 in aggregate).
        //
        weakCallouts: sum('excerpts') > 0 ? pct(sum('weakCallouts'), sum('callouts')) : null,
        dupCo: dupShare(rows),
        coPerExc: sum('excerpts') > 0 ? sum('callouts') / sum('excerpts') : null,
        // spine — overview cases only: mean fraction of the repo's expected
        // entry/orchestration/core files cited by the answer.
        //
        spine: meanOf(rows, 'spine'),
        judge: judgedTotal > 0 ? pct(judgedSupported, judgedTotal) : null
    };
}

// The structured twin of report(): per-type aggregates as a plain object for
// baseline persistence. Null aggregates (nothing to divide) are kept as null —
// the comparison layer only aligns numeric leaves.
//
function collectMetrics(perCase) {
    const presentTypes = ['all', ...new Set(perCase.map((r) => r.type))];
    const metrics = {types: {}};
    for(const type of presentTypes) {
        const rows = type === 'all' ? perCase : perCase.filter((r) => r.type === type);
        if(rows.length === 0) {
            continue;
        }
        const a = aggregate(rows);
        metrics.types[type] = {
            cite: round4(a.cite),
            faith: round4(a.faith),
            ground: round4(a.ground),
            evid: round4(a.evid),
            gap: round4(a.gap),
            err: round4(a.err),
            shape: round4(a.shape),
            weakCallouts: round4(a.weakCallouts),
            dupCo: round4(a.dupCo),
            coPerExc: round4(a.coPerExc),
            spine: round4(a.spine),
            judge: round4(a.judge),
            n: a.n
        };
    }
    return metrics;
}

function round4(value) {
    return value === null ? null : Number(value.toFixed(4));
}

function report(perCase) {
    const present = [...new Set(perCase.map((r) => r.type))];
    const types = ['all', ...present];
    const cell = (v) => (v === null ? '   -' : v.toFixed(2)).padStart(12);
    process.stdout.write(`\ngeneration quality by type${JUDGE ? ' (judge ON)' : ''}\n`);
    process.stdout.write(`${'type'.padEnd(12)}${'cite@trace'.padStart(12)}${'excpt-faith'.padStart(12)}${'ground-prec'.padStart(12)}${'in-evidence'.padStart(12)}${'gap-rate'.padStart(12)}${'err-rate'.padStart(12)}${'shape'.padStart(12)}${'weak-co'.padStart(12)}${'dup-co'.padStart(12)}${'co/excpt'.padStart(12)}${'spine'.padStart(12)}${JUDGE ? 'judge-supp'.padStart(12) : ''}   n\n`);
    for(const type of types) {
        const rows = type === 'all' ? perCase : perCase.filter((r) => r.type === type);
        if(rows.length === 0) {
            continue;
        }
        const a = aggregate(rows);
        process.stdout.write(`${type.padEnd(12)}${cell(a.cite)}${cell(a.faith)}${cell(a.ground)}${cell(a.evid)}${cell(a.gap)}${cell(a.err)}${cell(a.shape)}${cell(a.weakCallouts)}${cell(a.dupCo)}${cell(a.coPerExc)}${cell(a.spine)}${JUDGE ? cell(a.judge) : ''}   ${a.n}\n`);
    }
    process.stdout.write('\nlegend: cite@trace=answer cites expected file | excpt-faith=code verbatim in cited file | ground-prec=cited path exists | in-evidence=cited path was retrieved | gap-rate=blocks flagged as gaps | err-rate=cases with no trace | weak-co=callouts matching the production weak-note predicate (leak gate, expect ~0) | dup-co=callouts whose masked phrasing repeats (template-ness, independent of the filter) | co/excpt=mean callouts per excerpt | spine=overview cases: fraction of expected entry/orchestration/core files cited\n');
}

main().catch((err) => {
    process.stderr.write(`generation eval failed: ${err?.stack || err?.message || err}\n`);
    process.exitCode = 1;
});

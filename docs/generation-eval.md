# Generation Evaluation

Retrieval finding an expected file is only the first half of Tracebook's quality contract. Generation evaluation asks whether the real planner turns retrieved evidence into useful chapter components without inventing paths, citing unseen material, or altering displayed source.

The harness runs the production planner phases—prefetch, exploration, coverage, outline, component synthesis, annotation, and grounding enforcement—against labeled questions. It uses real configured models and checks the completed output against the repository on disk.

## Routine Commands

```sh
yarn eval:generation
yarn eval:generation:judge
yarn eval:generation:fast
yarn eval:smoke
```

- `yarn eval:generation` runs every labeled Tracebook case using the effective model configuration from `/admin` and credentials from the operating-system keychain.
- `yarn eval:generation:judge` adds an LLM judge over grounded/inferred evidence-callout claims. The deterministic source and provenance metrics still run.
- `yarn eval:generation:fast` assigns every generative role to the **Eval fast model** configured in `/admin`, disables enrichment and HyDE, and uses a persistent fast-profile index.
- `yarn eval:smoke` runs a stratified fast generation sample after the non-enriched retrieval baseline gate. It fails on any non-verbatim excerpt, errored case, or weak callout that escapes production filtering.

Focused product probes are also available:

```sh
yarn eval:generation:reasoning  # mechanism, product-value, and design-decision cases
yarn eval:generation:overview   # whole-repository architecture coverage
```

## Controlling Run Size

Full generation runs make multiple model calls per case and can be expensive or slow. Use a stratified or absolute sample while iterating:

```sh
GEN_EVAL_PER_TYPE=2 yarn eval:generation
GEN_EVAL_LIMIT=8 yarn eval:generation
GEN_EVAL_CONCURRENCY=1 yarn eval:generation
EVAL_INDEX_DIR=/absolute/path/to/cache yarn eval:generation
```

`GEN_EVAL_PER_TYPE` keeps the first N cases of every present question type; this is normally more informative than taking the first N cases overall. `EVAL_INDEX_DIR` preserves the index between runs. Model generation still runs again.

The normal generation command deliberately does not import `test/setup-env.js`: doing so would replace the user's model assignments with a test profile. The fast command uses its own explicit setup and reads only the admin's Eval fast model assignment before creating the temporary effective configuration.

## Metrics

Metrics are grouped by the labeled query types used by retrieval evaluation:

- `cite@trace`: fraction of cases where a completed component cites an expected file;
- `excpt-faith`: fraction of annotated excerpts whose displayed code is verbatim in the cited source;
- `ground-prec`: fraction of source references whose paths exist in the target repository;
- `in-evidence`: fraction of source references whose paths were present in the evidence supplied to synthesis;
- `gap-rate`: fraction of components that are explicit `evidence_callout` gaps;
- `err-rate`: fraction of cases that produce no completed trace;
- `shape`: whether cases with an expected presentation shape produced it;
- `weak-co`: share of callouts matching the production weak-note predicate, expected to remain zero after filtering;
- `dup-co`: share of callouts whose normalized phrasing repeats, an informational signal for templated explanations;
- `co/excpt`: mean annotation callouts per code excerpt;
- `spine`: for overview cases, the fraction of expected entry, orchestration, and core files cited; and
- `judge-supp`: with judging enabled, the fraction of evidence-callout claims rated supported by their cited source.

No single metric stands in for answer quality. `cite@trace` tests whether the expected implementation reached the answer; `in-evidence` tests citation provenance; `excpt-faith` tests the strongest verbatim-source invariant; and the callout metrics distinguish useful teaching notes from generic filler.

## Baselines and Cross-repository Runs

The matrix runner can add generation evaluation to every registered repository profile:

```sh
node scripts/eval-matrix.js --compare --generation
node scripts/eval-matrix.js --save-baseline --generation
node scripts/eval-matrix.js --promote --generation
node scripts/eval-matrix.js --compare --generation --repo tracebook
```

Every measured run records its complete payload under `.eval-cache/last-runs/`. Promotion copies the reviewed last run into the committed baseline; it never repeats an expensive generation run merely to save the same result.

Baseline conditions include the repository, case hash, embedding and enrichment configuration, reranker, and every assigned generative model. A comparison with different conditions is rejected as incomparable. Rate metrics participate in pass/fail only when their slice contains enough cases; shape and qualitative diagnostics remain visible without turning small samples into noisy gates.

External matrix entries use their own repository root and labeled case files, so source existence, excerpt fidelity, tools, and indexing all resolve against that repository rather than the Tracebook checkout.

## Deterministic Guards

Generation evaluation is intentionally separate from `yarn verify`: real model output is costly and non-deterministic. The normal test suite still protects the mechanical contracts with mocks and fixed fixtures, including citation provenance, component schemas, evidence policy, source-range clamping, fallback behavior, and `test/integration/generation-grounding.test.js` for verbatim excerpt repair.

Run generation evaluation before and after changes to planner phases, prompts, evidence construction, component schemas, grounding enforcement, annotation, visual repair, or story-output policy. The shared labeled cases live in `test/eval/cases.js`; see [Retrieval evaluation](retrieval-eval.md) for the upstream search measurements.

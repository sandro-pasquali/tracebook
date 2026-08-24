# Retrieval Evaluation

Retrieval quality is a prerequisite for grounded generation. If the expected source never enters the evidence packet, the planner cannot reliably explain or cite it later.

The retrieval evaluation indexes a labeled repository, runs known questions through the same hybrid search used by the planner, and records where the first expected file appears.

## Routine Commands

```sh
yarn eval:retrieval
yarn eval:retrieval:compare
```

`yarn eval:retrieval` measures the cumulative retrieval ladder, leave-one-out contribution of each retrieval leg, and the shipped query-shape policy. The package command uses the deterministic test configuration with local Hugging Face embeddings and enrichment disabled.

`yarn eval:retrieval:compare` compares three query treatments: the raw question for both vector and lexical search, raw vector plus expanded lexical search, and the expanded question for both. Use it when changing question-context or vocabulary expansion.

Targeted experiment flags can be run directly:

```sh
node --import ./test/setup-env.js test/eval/retrieval-eval.js --shape-arms
node --import ./test/setup-env.js test/eval/retrieval-eval.js --threshold-arms
```

The first compares the registered query-shape policies. The second measures semantic-vector thresholds while leaving lexical and graph evidence available.

## What Is Measured

Results are grouped by question type:

- `product` uses product language without naming implementation files.
- `identifier` names an exact symbol, configuration token, or rare literal.
- `leaky` includes a file or feature name and acts as a straightforward regression guard.
- `integration` asks how libraries or subsystems work together and expects their wiring source.

The primary metrics are:

- `recall@K`: the fraction of cases where any expected file appears in the first K results;
- `MRR`: the mean reciprocal rank of the first expected file, rewarding earlier placement; and
- `n`: the number of labeled cases in the slice.

The cumulative ladder reports vector search, then lexical BM25, graph facts, domain-aware ranking, and reranking. The leave-one-out table starts with the complete pipeline and removes one lever at a time, showing whether that lever still contributes when all others are present. A separate policy row measures the actual query-shape-dependent production path.

## Persistent Indexes and Enrichment

By default the direct evaluation creates a temporary index and removes it afterward. Reuse an index during repeated work with:

```sh
EVAL_INDEX_DIR=/absolute/path/to/cache yarn eval:retrieval
```

Content hashes make a warm index inexpensive. `--skip-index` may be used only with an existing `EVAL_INDEX_DIR` when the stored corpus is already known to match.

The product configuration loader does not read general environment overrides, so `ENRICHMENT_ENABLED=true` does not create an enrichment-on run. Use the explicit evaluation setup instead:

```sh
node --import ./test/eval/setup-enriched-env.js test/eval/retrieval-eval.js
```

That profile requires its configured Ollama enrichment model whenever files need descriptions. The harness rejects an enrichment-on measurement if fewer than 90 percent of attempted descriptions succeed, preventing a failed model from being reported as a valid enriched index.

## Baselines and Repository Matrix

The matrix runner evaluates the same retrieval system against the registered repository/case pairs in `test/eval/matrix.json`. Missing external repositories are reported as skipped.

```sh
yarn eval:baseline  # run the matrix and save current retrieval baselines
yarn eval:check     # compare the matrix against committed baselines
yarn eval:promote   # promote each last recorded run without rerunning it
yarn eval:smoke     # routine non-enriched retrieval gate plus fast generation invariants
```

Every run records its conditions and results under `.eval-cache/last-runs/`. A baseline includes the repository, labeled-case hash, K, embedding configuration, enrichment state, and reranker. Comparison fails as incomparable when those conditions differ instead of presenting a misleading delta.

Only production-policy slices with enough labeled cases participate in the regression gate. Smaller slices remain visible but informational, and tolerance accounts for the discrete movement of one case.

## When to Run It

Run retrieval evaluation before and after changes to:

- corpus and ignore policy;
- chunking or embedding text;
- embedding models, dimensions, dtype, or prefixes;
- lexical/vector fusion and query-shape policy;
- graph extraction or architectural-hub selection;
- reranking, HyDE, query expansion, or enrichment; and
- planner prefetch or coverage retrieval.

The labeled Tracebook cases live in `test/eval/cases.js`; external repositories provide their own case files through the matrix. See [Generation evaluation](generation-eval.md) for the downstream question: whether retrieved evidence becomes a faithful story.

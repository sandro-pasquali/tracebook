# Design and Purpose

Tracebook turns a local codebase into source-grounded product stories: readable explanations, diagrams, and annotated code that help someone understand existing behavior before asking an engineer or an AI system to change it.

Its working thesis is simple:

> The difficult part of changing unfamiliar software is not producing more code. It is building an accurate enough mental model to ask for the right change without breaking something important.

## Why Tracebook Exists

More software is now inherited, generated, and modified by people who did not write the original code. That group includes engineers joining a project, product managers preparing a change, designers tracing an interaction, support teams investigating behavior, and people using coding agents without wanting to read an entire repository first.

Conventional code search can locate a symbol. A general-purpose chat interface can produce a plausible explanation. Neither necessarily gives the user a durable, checkable account of how the product actually behaves.

Tracebook is designed to fill that gap. It treats understanding as a product in its own right: something that should be assembled from evidence, organized into a narrative, revisited later, and carried forward into implementation work.

## What the Product Is

Tracebook is not primarily a chatbot, an IDE, or a vector-search demo. It is a local investigation and reading environment for software.

A question becomes a chapter in a story. The chapter can contain four kinds of source-aware building blocks:

- annotated code excerpts that preserve the repository text verbatim
- sequence diagrams for interactions over time
- other Mermaid figures for structure, state, and flow
- evidence callouts that distinguish grounded findings, reasonable inferences, and coverage gaps

Stories can be continued with follow-up questions, saved, reopened, checked for stale source, regenerated, and converted into a change brief. The goal is not merely to answer once. It is to build a useful body of understanding around a behavior or proposed change.

## How It Works

At a high level, Tracebook moves through this pipeline:

```text
repository
  -> source and ignore policy
  -> syntax, chunks, relationships, and dependency context
  -> local hybrid index
  -> question intent and retrieval strategy
  -> bounded evidence packet
  -> exploration, coverage, outline, and story components
  -> citation and grounding enforcement
  -> streamed chapter in the browser
  -> saved story, feature trace, and change brief
```

The first run builds a repository-specific index. Later runs reuse that index, while a file watcher updates changed files and advances the repository revision. Indexes, traces, stories, and briefs are isolated per repository.

When a user asks a question, Tracebook first determines what kind of understanding is needed. A request to locate a named function should behave differently from a product-language question about a customer flow or a request for a whole-system overview. That classification shapes retrieval, coverage, and the kinds of visual components the answer should contain.

The answer then streams into the browser as it is built. The user sees the narrative and evidence develop incrementally rather than waiting for one opaque block of generated text.

The surrounding product flow is equally deliberate. An administrator defines the available repositories and model workloads, a reader chooses a repository, and Tracebook makes indexing readiness visible before accepting a question. The resulting chapter is a reading surface first: exploration activity recedes behind the explanation, while source references, full-file inspection, and follow-up questions remain close at hand.

## A Practical Knowledge Model of the Repository

Tracebook does not rely on embeddings alone. Its local index combines several complementary views of the codebase:

- source chunks with stable file and line ranges
- vector embeddings for semantic similarity
- full-text search for exact names and technical anchors
- parser-backed facts such as definitions, imports, routes, configuration access, storage operations, and entrypoints
- import relationships used to find callers, dependencies, and architectural hubs
- virtual documents describing runtime dependencies without indexing `node_modules`
- optional product-language descriptions of source files

Language integrations own the parsing, source policy, dependency metadata, and annotation semantics for their ecosystem. This gives Tracebook a useful source graph across many languages while keeping the graph tied to facts that can be traced back to files.

The result is a practical knowledge layer: richer than plain search, but still inspectable and subordinate to the repository itself.

## Source Grounding as a Product Contract

Language models are useful because they can connect scattered evidence and explain it in human terms. They are also probabilistic and can overreach. Tracebook is built around that tension.

The model-driven stages sit inside deterministic boundaries:

- request and generated-output shapes are validated strictly
- tools can only read the configured repository through path and corpus policies
- evidence is carried with explicit paths and line ranges
- generated citations are restricted to evidence the planner actually retrieved
- cited ranges are clamped back to the retrieved source boundaries
- annotated code is checked against source and replaced when it is not verbatim
- unsupported claims can become explicit gaps instead of being presented as facts
- saved answers are tied to source revisions and can be marked stale after files change

This is the central trust model: the language model may organize and explain the evidence, but it does not get to redefine what counts as evidence.

The interface follows the same rule. It uses qualitative states such as grounded, inferred, and coverage gap rather than presenting an artificial numeric confidence score as certainty. Source chips and full-file views let the reader move from an explanation back to the underlying material.

![A Tracebook evidence callout marked grounded in source with its cited range](images/product-walkthrough/08-evidence-callout.png)

*Evidence categories stay next to the claim and its source rather than disappearing into generation metadata.*

## Network Last, with Premier Models as an Option

Tracebook is designed around local ownership of project context and a network-last execution model. Network-last is an ordering principle, not a prohibition: use the user's machine for durable state and computation where it is effective, then use a network model deliberately for work where its capability justifies the cost and data boundary.

The canonical repository, search indexes, traces, stories, and configuration remain on the user's machine. Parsing, graph construction, index storage, search fusion, and evidence selection also happen there; embedding can run in-process or through the configured Ollama endpoint. This preserves data control, avoids per-request infrastructure cost, and takes advantage of the substantial compute and memory available on a modern local workstation—capacity that would be expensive to reserve continuously in the cloud. Provider credentials are stored in the operating-system keychain, not in the project configuration file.

Model-driven work operates on bounded working sets rather than an undifferentiated repository upload. A role configured with local Ollama uses the local model service. A role configured with an API provider receives the question, instructions, and selected evidence required for that operation; the provider does not become Tracebook's store or retrieval layer.

Network-last is not an offline-only claim. Initial dependency installation, missing Hugging Face weights, and Ollama model pulls can use the network, as can any explicitly hosted model role or non-loopback Ollama endpoint. The distinction is that those connections acquire or execute a configured capability; they do not replace the locally owned repository, index, planner, or product state.

Tracebook separates that work into roles:

- exploration searches and reads the repository
- outline turns evidence into a narrative and component plan
- synthesis produces the final story components
- annotation explains the load-bearing lines in code excerpts
- optional enrichment and hypothetical-document generation improve retrieval

Each role can use Ollama or a supported API provider. A user can run the whole system locally, mix local and hosted models, or use a premier API model for selected work without changing the planner or the product experience. The architecture and locally owned product state stay the same; only the execution of the configured role changes.

This is part of the broader design argument Tracebook demonstrates: network-last software should shape work around local models' strengths, constrain the amount of work each call must do, preserve partial progress, and allow stronger remote models to act as selective accelerators rather than becoming the foundation of the product.

## Stories Instead of Chat History

The browser experience is organized around chapters because understanding a codebase is cumulative. A follow-up question should inherit useful context without allowing the previous topic to distort retrieval for the new one.

Each story keeps its questions, narrative, rendered components, sources, and replayable events. The chapter navigator, source rail, saved-story library, direct URLs, and stale-source notices make the result feel closer to a living technical document than a message transcript.

Source inspection continues that document model. Opening a cited file expands the full source with the cited excerpt already highlighted. The reader can immediately copy that excerpt as a themed PNG, or select another range first. Tracebook renders the image locally in the browser rather than sending source to an external screenshot service.

Presentation themes adapt that document to different reading contexts—from an approachable daylight view to workbench, manuscript, boardroom, and forensic modes—while preserving the same evidence and interaction model underneath.

Once a reader understands the current behavior, a change brief turns that understanding into a structured handoff. It carries forward likely files, existing patterns, constraints, acceptance criteria, tests, risks, open questions, and source references. The output can be rendered as an LLM prompt, repository issue, or ticket without pretending that the proposed change has already been implemented.

## Failure Is Part of the Model

Local models can be slow, unavailable, or inconsistent. Indexes can be rebuilding. Retrieval may not find enough evidence. A generated diagram may not parse. Tracebook treats these as expected product states rather than one generic error.

Subsystems degrade independently where possible. Existing evidence can still produce a chapter when exploration fails. A component failure becomes a visible gap instead of erasing the rest of the answer. Diagram generation has validation and repair paths. Runtime startup and indexing expose progress instead of leaving the interface ambiguous.

This emphasis on graceful degradation is important for network-last software: useful partial work should survive whenever its evidence is still valid.

## How the Design Is Evaluated

Tracebook's evaluation suite measures the properties the product promises, not only whether a model returned text.

Retrieval evaluation measures recall and ranking across product-language, identifier, leaky, and integration questions. Generation evaluation checks whether final stories cite expected files, whether code excerpts are verbatim, whether citations came from retrieved evidence, how often the system admits gaps or fails, and whether annotations remain useful rather than formulaic.

These checks make source grounding, retrieval quality, and explanation quality observable parts of the engineering process.

For implementation details, continue with [Architecture](architecture.md), [Configuration](configuration.md), [Indexing](indexing.md), [Retrieval evaluation](retrieval-eval.md), and [Generation evaluation](generation-eval.md).

import crypto from 'node:crypto';
import {chunkFile} from './chunker.js';
import {collectDependencyDocs, isDependencyManifest, isVirtualDependencyPath} from './dependency-docs.js';
import {extractSourceGraph} from '../util/source-syntax.js';
import {config} from '../util/config.js';
import {DEFAULT_INDEX_EXCLUDE, DEFAULT_INDEX_INCLUDE} from './file-patterns.js';
import {createSourceCorpusPolicy} from './source-corpus-policy.js';
import {mapWithConcurrency} from '../util/concurrency.js';
import {buildEmbeddingText} from './embedding-text.js';
import {MAX_INDEX_FILE_BYTES, readIndexableText} from './readable-text.js';
import {buildIndexFingerprint} from './index-fingerprint.js';

// How many files indexAll processes at once. Concurrency overlaps each file's
// read/parse/chunk/store-write while the embedding model itself stays serialized
// inside the embedder, so this is a throughput knob, not a correctness one.
//
const INDEX_CONCURRENCY = 4;
// How many files' worth of prepared rows indexAll buffers before committing them
// as one batch (one delete + one chunk add + one graph add) and compacting. Larger
// batches mean fewer commits but more buffered rows in memory; 256 keeps commit
// count low while bounding peak memory.
//
const INDEX_BATCH_FILES = 256;
// How many chunks to embed per embedder call within a batch flush. A batch's
// chunks are embedded in sub-batches of this size so a large flush reports
// progress between calls instead of going dark during one long embed; 64 stays
// wide enough that throughput is unaffected. Sub-batching never changes the
// vectors (each text embeds independently), only how progress is surfaced.
//
const EMBED_PROGRESS_CHUNKS = 64;
const INDEX_HASH_NAMESPACE = 'semantic-index.source-locations';

// Orchestrates scanning, chunking, embedding, and upserting into the store.
// Uses per-file content hashes to skip re-embedding unchanged files (Merkle-style).
//
export function createIndexer({root, include, exclude, embedder, store, enricher = null, indexDependencies = true, enrichConcurrency}) {
    if(!root || !embedder || !store) {
        throw new Error('createIndexer requires {root, embedder, store}');
    }
    const includeGlob = include || DEFAULT_INDEX_INCLUDE;
    const excludeGlob = exclude || DEFAULT_INDEX_EXCLUDE;
    const indexFingerprint = buildIndexFingerprint({
        embedder,
        enrichment: {enabled: Boolean(enricher), model: config.enrichment.model}
    });
    const sourcePolicy = createSourceCorpusPolicy({root, include: includeGlob, exclude: excludeGlob});
    const repoIgnore = sourcePolicy.repoIgnore;
    // Concurrency for the model-service enrichment calls, independent of the
    // CPU-bound INDEX_CONCURRENCY used for parsing/chunking/embedding. Overridable
    // per indexer (a test seam); otherwise from config.
    //
    const enrichConcurrencyLimit = Math.max(1, enrichConcurrency || config.enrichment.concurrency || INDEX_CONCURRENCY);

    // Enrichment outcome counters (lifetime of this indexer). describe() swallows
    // every failure into '', so these counters are the only signal that enrichment
    // silently produced nothing (dead endpoint, cold model, timeouts). indexAll
    // reports per-run deltas; snapshot() reports the lifetime totals.
    //
    let enrichAttempted = 0;
    let enrichSucceeded = 0;

    function noteEnrichment(description) {
        enrichAttempted++;
        if(String(description || '').trim() !== '') {
            enrichSucceeded++;
        }
        return description;
    }

    let lastIndexedAt = null;
    let sourceRevision = null;
    let lastCoverage = null;
    let indexingInProgress = false;

    // In-memory mirror of {repo-relative path -> stored content hash}, the only
    // state the source-revision fingerprint depends on. Kept in sync at every
    // store mutation site so the fingerprint recomputes from memory instead of
    // re-reading every path's hash from the store on each single-file change.
    //
    const revisionHashes = new Map();
    let revisionSeeded = false;

    // Rebuild the mirror once from the store. The store is the source of truth,
    // and refreshSourceRevision only ever runs after its mutations have settled,
    // so a one-time seed is always consistent with on-disk state (e.g. when the
    // process restarts against an already-populated store and the first action is
    // an incremental indexFile rather than a full indexAll).
    //
    async function ensureRevisionSeed() {
        if(revisionSeeded) return;
        revisionHashes.clear();
        if(typeof store.getAllContentHashes === 'function') {
            // One table scan for every path's hash, instead of knownPaths() plus a
            // per-path getContentHash query.
            //
            const hashes = await store.getAllContentHashes();
            for(const [rel, hash] of hashes) {
                revisionHashes.set(rel, hash || '');
            }
        } else {
            const paths = await store.knownPaths();
            await Promise.all(paths.map(async (rel) => {
                revisionHashes.set(rel, (await store.getContentHash(rel)) || '');
            }));
        }
        revisionSeeded = true;
    }

    function noteIndexed(rel, hash) {
        revisionHashes.set(rel, hash || '');
    }

    function noteForgotten(rel) {
        revisionHashes.delete(rel);
    }

    // Every path-removal in the indexer flows through here so the revision mirror
    // drops the path in lockstep with the store.
    //
    async function forgetPath(rel) {
        await store.removePath(rel);
        noteForgotten(rel);
    }

    async function refreshSourceRevision() {
        lastIndexedAt = Date.now();
        if(typeof store.knownPaths !== 'function' || typeof store.getContentHash !== 'function') {
            sourceRevision = String(lastIndexedAt);
            return sourceRevision;
        }
        await ensureRevisionSeed();
        const rows = [...revisionHashes].map(([rel, hash]) => `${rel}:${hash || ''}`);
        sourceRevision = crypto
            .createHash('sha256')
            .update(rows.sort().join('\n'), 'utf8')
            .digest('hex')
            .slice(0, 16);
        return sourceRevision;
    }

    function hashContent(s) {
        return crypto.createHash('sha256').update(`${INDEX_HASH_NAMESPACE}\n${indexFingerprint}\n${s}`, 'utf8').digest('hex').slice(0, 16);
    }

    async function listFiles() {
        return sourcePolicy.listIndexableFiles();
    }

    // Index a single file by its repo-relative path.
    // Returns {indexed: boolean, chunks: number, skipped: boolean}.
    //
    async function indexFile(rel, {refreshDependencies = true, touchRevision = true} = {}) {
        const checked = await sourcePolicy.checkPath(rel);
        const sourcePath = checked.path || sourcePolicy.normalize(rel) || String(rel || '');
        if(!checked.ok) {
            await forgetPath(sourcePath);
            let dependencyStats = null;
            if(refreshDependencies && isDependencyManifest(sourcePath)) {
                dependencyStats = await indexDependencyDocs();
            }
            const sourceRevision = touchRevision ? await refreshSourceRevision() : currentSourceRevision();
            return {indexed: false, chunks: 0, skipped: true, reason: 'path_excluded', sourceRevision, dependencyStats};
        }

        rel = checked.path;
        const physical = await sourcePolicy.resolvePhysicalPath(rel);
        if(!physical.ok) {
            await forgetPath(rel);
            let dependencyStats = null;
            if(refreshDependencies && isDependencyManifest(rel)) {
                dependencyStats = await indexDependencyDocs();
            }
            const sourceRevision = touchRevision ? await refreshSourceRevision() : currentSourceRevision();
            if(physical.reason === 'not_found') {
                return {indexed: false, chunks: 0, skipped: false, removed: true, sourceRevision, dependencyStats};
            }
            return {indexed: false, chunks: 0, skipped: true, reason: physical.reason, sourceRevision, dependencyStats};
        }

        const text = await readIndexableText(physical.path);
        if(text.skipped) {
            await forgetPath(rel);
            let dependencyStats = null;
            if(refreshDependencies && isDependencyManifest(rel)) {
                dependencyStats = await indexDependencyDocs();
            }
            const sourceRevision = touchRevision ? await refreshSourceRevision() : currentSourceRevision();
            return {indexed: false, chunks: 0, skipped: true, reason: text.reason, sourceRevision, dependencyStats};
        }

        const res = await indexContent(rel, text.content);
        let dependencyStats = null;
        if(refreshDependencies && isDependencyManifest(rel)) {
            dependencyStats = await indexDependencyDocs();
        }
        if(touchRevision && (indexResultChanged(res) || dependencyStatsChanged(dependencyStats))) {
            return {...res, dependencyStats, sourceRevision: await refreshSourceRevision()};
        }
        return {...res, dependencyStats, sourceRevision: currentSourceRevision()};
    }

    async function removeFile(rel, {refreshDependencies = true, touchRevision = true} = {}) {
        await forgetPath(rel);
        let dependencyStats = null;
        if(refreshDependencies && isDependencyManifest(rel)) {
            dependencyStats = await indexDependencyDocs();
        }
        if(touchRevision) {
            await refreshSourceRevision();
        }
        return {indexed: false, chunks: 0, skipped: false, removed: true, dependencyStats, sourceRevision: currentSourceRevision()};
    }

    async function indexVirtualDoc(doc) {
        return indexContent(doc.path, doc.content);
    }

    // Pure-compute half of indexing: decide what the store should hold for this
    // file WITHOUT embedding or writing. Returns one of:
    //   {action: 'skip'}                  content unchanged
    //   {action: 'remove', skipDelete}    no indexable chunks
    //   {action: 'write', hash, skipDelete, chunks, graphFacts, graphRows,
    //    description, embedTexts, chunkMeta}
    // Embedding is deferred to the apply step (indexContent for one file, flushBatch
    // for a whole batch) so indexAll can embed many files' chunks in one model sweep.
    // The index produced is identical either way — same texts, same vectors.
    //
    async function prepareContent(rel, content) {
        const hash = hashContent(content);

        // When the revision mirror is seeded it holds the same content hash the
        // store would return, so the skip/reindex decision is identical without a
        // per-file table query. indexAll seeds it up front; the incremental path
        // falls back to a direct lookup until the mirror is warm.
        //
        const existing = revisionSeeded ? (revisionHashes.get(rel) || null) : await store.getContentHash(rel);
        if(existing && existing === hash) {
            return {action: 'skip'};
        }

        // A path the store has never seen needs no delete before its insert, which
        // saves a wasted commit per new file (the common case on a cold index).
        //
        const skipDelete = existing === null;

        const chunks = await chunkFile(content, {path: rel});
        if(chunks.length === 0) {
            return {action: 'remove', skipDelete};
        }
        const graphRows = await extractSourceGraph(content, {path: rel});
        const graph = graphRows.map((row) => ({...row, path: rel, contentHash: hash}));

        // The index-time product-language description (an LLM call, only for new/changed
        // files) and the embedding texts that fold it in are produced later: inline for
        // the single-file path (indexContent), or fanned out at enrichment concurrency in
        // applyPlans for the batched path. Keeping the network-bound describe() out of
        // this CPU-bound prepare step lets it overlap parsing/chunking instead of blocking
        // an INDEX_CONCURRENCY slot. chunkList feeds buildWritePieces once the description
        // is known; enrichSource is the (bounded) content the enricher reads.
        //
        const enrichSource = enricher ? String(content || '').slice(0, config.enrichment.maxInputChars) : '';
        return {action: 'write', hash, skipDelete, chunks: chunks.length, graphFacts: graphRows.length, graphRows: graph, chunkList: chunks, enrichSource};
    }

    // Build the embedding texts and stored chunk metadata for a write plan once its
    // enrichment description is known. Shared by indexContent (single file) and
    // applyPlans (batch) so both fold the description into the embedding text the same
    // way — the embedded text and vectors are identical regardless of which path ran.
    //
    function buildWritePieces(rel, chunkList, description) {
        const chunkMeta = chunkList.map((c) => ({lineStart: c.lineStart, lineEnd: c.lineEnd, content: c.content}));
        const embedTexts = chunkList.map((c) => buildEmbeddingText(rel, c, description));
        return {chunkMeta, embedTexts};
    }

    // Resolve the enrichment description for each write plan. describe() is a
    // network/model round-trip, so the batch runs them at enrichConcurrency (its own
    // knob, independent of the CPU-bound INDEX_CONCURRENCY) rather than one-per-prepare
    // worker. describe() swallows its own errors and returns '', so no plan can reject
    // the run. Returns '' for every plan when enrichment is disabled.
    //
    // Emits 'enriching' progress so this otherwise-silent phase (one model call per
    // file — minutes on a slow local model) reports liveness: a leading done:0 event
    // marks the phase start, then one per completed description.
    //
    async function describePlans(writes, onProgress) {
        if(!enricher || writes.length === 0) {
            return writes.map(() => '');
        }
        const total = writes.length;
        let done = 0;
        onProgress?.({kind: 'enriching', done: 0, total});
        return mapWithConcurrency(writes, enrichConcurrencyLimit, async (item) => {
            const description = noteEnrichment(await enricher.describe(item.rel, item.enrichSource));
            done++;
            onProgress?.({kind: 'enriching', done, total, rel: item.rel});
            return description;
        });
    }

    // Zip chunk metadata with the embeddings produced for its embedTexts into store
    // chunk rows.
    //
    function buildRows(rel, chunkMeta, description, hash, embeddings) {
        return chunkMeta.map((meta, i) => ({
            path: rel,
            lineStart: meta.lineStart,
            lineEnd: meta.lineEnd,
            content: meta.content,
            description,
            embedding: embeddings[i],
            contentHash: hash
        }));
    }

    // Embed a flat list of texts in sub-batches, emitting an 'embedding' progress
    // event after each so a large flush surfaces activity instead of appearing to
    // hang on one long ONNX call.
    //
    async function embedInBatches(texts, onProgress) {
        if(texts.length === 0) {
            return [];
        }
        const out = [];
        for(let start = 0; start < texts.length; start += EMBED_PROGRESS_CHUNKS) {
            const slice = texts.slice(start, start + EMBED_PROGRESS_CHUNKS);
            const embeddings = await embedder.embed(slice, {type: 'document'});
            out.push(...embeddings);
            if(onProgress) {
                onProgress({kind: 'embedding', done: out.length, total: texts.length});
            }
        }
        return out;
    }

    // Embed and commit a list of prepared plans as one batch: one delete + one
    // chunk add + one graph add, with the embedding sub-batched for progress.
    // Shared by the indexAll source flush and the dependency-doc pass so both get
    // batched embedding. The mirror is updated only after the commit so a failed
    // flush never marks its files as indexed.
    //
    async function applyPlans(plans, {onProgress} = {}) {
        if(plans.length === 0) {
            return;
        }
        const deletePaths = [];
        const writes = [];
        for(const item of plans) {
            if(!item.skipDelete) {
                deletePaths.push(item.rel);
            }
            if(item.action === 'write') {
                writes.push(item);
            }
        }

        // Enrich the whole batch at enrichment concurrency, then build each plan's
        // embedding texts (which fold the description in) and chunk metadata.
        //
        const descriptions = await describePlans(writes, onProgress);
        const allEmbedTexts = [];
        const pieces = writes.map((item, i) => {
            const built = buildWritePieces(item.rel, item.chunkList, descriptions[i]);
            allEmbedTexts.push(...built.embedTexts);
            return built;
        });

        const allEmbeddings = await embedInBatches(allEmbedTexts, onProgress);

        const chunkRows = [];
        const graphRows = [];
        let offset = 0;
        for(let i = 0; i < writes.length; i++) {
            const item = writes[i];
            const {chunkMeta} = pieces[i];
            const embeddings = allEmbeddings.slice(offset, offset + chunkMeta.length);
            offset += chunkMeta.length;
            chunkRows.push(...buildRows(item.rel, chunkMeta, descriptions[i], item.hash, embeddings));
            graphRows.push(...item.graphRows);
        }

        // One gated commit block for the whole batch: a concurrent search can
        // never observe the deleted-but-not-yet-readded state that the three
        // separate commits (remove, add chunks, add graph) used to expose. The
        // split calls remain only as a fallback for store fakes in tests.
        //
        if(typeof store.applyBatch === 'function') {
            await store.applyBatch({deletePaths, chunkRows, graphRows});
        } else {
            if(deletePaths.length > 0) {
                await store.removePaths(deletePaths);
            }
            if(chunkRows.length > 0) {
                await store.addChunkRows(chunkRows);
            }
            if(graphRows.length > 0) {
                await store.addGraphRows(graphRows);
            }
        }
        for(const item of plans) {
            if(item.action === 'write') {
                noteIndexed(item.rel, item.hash);
            } else {
                noteForgotten(item.rel);
            }
        }
    }

    // Map a prepareContent plan to the per-file stats result shape (mirrors the
    // returns in prepareFile), for callers that batch via applyPlans.
    //
    function planToResult(plan) {
        if(plan.action === 'skip') {
            return {indexed: false, chunks: 0, graphFacts: 0, skipped: true};
        }
        if(plan.action === 'remove') {
            return {indexed: false, chunks: 0, graphFacts: 0, skipped: false};
        }
        return {indexed: true, chunks: plan.chunks, graphFacts: plan.graphFacts, skipped: false};
    }

    async function indexContent(rel, content) {
        const plan = await prepareContent(rel, content);
        if(plan.action === 'skip') {
            return {indexed: false, chunks: 0, graphFacts: 0, skipped: true};
        }
        if(plan.action === 'remove') {
            if(!plan.skipDelete) {
                await forgetPath(rel);
            }
            return {indexed: false, chunks: 0, graphFacts: 0, skipped: false};
        }
        // Single file: the same enrich → build → embed → commit pipeline as the
        // batched path, as a one-plan batch. One code path, one commit block.
        //
        await applyPlans([{rel, ...plan}]);
        return {indexed: true, chunks: plan.chunks, graphFacts: plan.graphFacts, skipped: false};
    }

    // Read + prepare a repo-relative file for the batched indexAll path. Mirrors
    // indexFile's guard returns but performs no store writes: it returns a plan
    // ({action} + the per-file `res` used for progress/stats) for the flush to
    // commit in bulk.
    //
    async function prepareFile(rel) {
        const checked = await sourcePolicy.checkPath(rel);
        if(!checked.ok) {
            return {rel: checked.path || sourcePolicy.normalize(rel) || rel, action: 'remove', skipDelete: false, res: {indexed: false, chunks: 0, skipped: true, reason: checked.reason || 'path_excluded'}};
        }

        rel = checked.path;
        const physical = await sourcePolicy.resolvePhysicalPath(rel);
        if(!physical.ok) {
            const res = physical.reason === 'not_found'
                ? {indexed: false, chunks: 0, skipped: false, removed: true}
                : {indexed: false, chunks: 0, skipped: true, reason: physical.reason};
            return {rel, action: 'remove', skipDelete: false, res};
        }
        const text = await readIndexableText(physical.path);
        if(text.skipped) {
            return {rel, action: 'remove', skipDelete: false, res: {indexed: false, chunks: 0, skipped: true, reason: text.reason}};
        }
        const plan = await prepareContent(rel, text.content);
        if(plan.action === 'skip') {
            return {rel, action: 'skip', res: {indexed: false, chunks: 0, graphFacts: 0, skipped: true, reason: 'unchanged'}};
        }
        if(plan.action === 'remove') {
            return {rel, action: 'remove', skipDelete: plan.skipDelete, res: {indexed: false, chunks: 0, graphFacts: 0, skipped: true, reason: 'unsupported_type'}};
        }
        return {
            rel,
            action: 'write',
            hash: plan.hash,
            skipDelete: plan.skipDelete,
            graphRows: plan.graphRows,
            chunkList: plan.chunkList,
            enrichSource: plan.enrichSource,
            res: {indexed: true, chunks: plan.chunks, graphFacts: plan.graphFacts, skipped: false}
        };
    }

    async function indexDependencyDocs({docs, onProgress, apply} = {}) {
        // Dependency docs (virtual __dependencies__/ summaries of third-party
        // packages) are opt-out via DEPENDENCY_DOCS_ENABLED. When off, skip
        // collecting/indexing them; indexAll's stale-path pass drops any that a
        // prior run left behind.
        //
        if(!indexDependencies) {
            return {files: 0, indexedFiles: 0, skippedFiles: 0, removedFiles: 0, totalChunksIndexed: 0, totalGraphFactsIndexed: 0};
        }
        const dependencyDocs = docs || await collectDependencyDocs({root, repoIgnore});
        const live = new Set(dependencyDocs.map((doc) => doc.path));
        let indexedFiles = 0;
        let skippedFiles = 0;
        let removedFiles = 0;
        let totalChunks = 0;
        let totalGraphFacts = 0;
        if(typeof store.knownPaths === 'function') {
            const known = await store.knownPaths();
            for(const rel of known) {
                if(!isVirtualDependencyPath(rel) || live.has(rel)) continue;
                await forgetPath(rel);
                removedFiles++;
                if(onProgress) onProgress({kind: 'dependency_removed', rel, indexed: false, chunks: 0, skipped: false, removed: true, virtual: true});
            }
        }

        // When an `apply` committer is supplied (the indexAll bulk path), prepare
        // each doc without writing and commit them as one batched, sub-batch-embedded
        // flush — same path as source files. Without it (the incremental refresh from
        // indexFile), fall back to the per-doc write so single-file semantics are
        // unchanged.
        //
        const batch = [];
        for(const doc of dependencyDocs) {
            if(onProgress) onProgress({kind: 'dependency_start', rel: doc.path, virtual: true, active: true});
            let res;
            if(apply) {
                const plan = await prepareContent(doc.path, doc.content);
                res = planToResult(plan);
                if(plan.action === 'write' || plan.action === 'remove') {
                    batch.push({rel: doc.path, ...plan});
                }
            } else {
                res = await indexVirtualDoc(doc);
            }
            if(res.indexed) {
                indexedFiles++;
                totalChunks += res.chunks;
                totalGraphFacts += res.graphFacts || 0;
            } else if(res.skipped) {
                skippedFiles++;
            }
            if(onProgress) onProgress({kind: 'dependency', rel: doc.path, ...res, virtual: true});
        }
        if(apply) {
            await apply(batch);
        }

        return {
            files: dependencyDocs.length,
            indexedFiles,
            skippedFiles,
            removedFiles,
            totalChunksIndexed: totalChunks,
            totalGraphFactsIndexed: totalGraphFacts
        };
    }

    // Cold or warm full-repo index.
    //
    // The source revision is invalidated up front: a full rebuild deletes and
    // re-adds rows over an extended window, and answers computed against that
    // partial index must neither replay from the cache nor be cached. Cached
    // reads and writes key on the revision, so nulling it disables both until
    // refreshSourceRevision() publishes the post-rebuild revision at the end.
    //
    async function indexAll({onProgress} = {}) {
        indexingInProgress = true;
        sourceRevision = null;
        try {
            return await indexAllRun({onProgress});
        } finally {
            indexingInProgress = false;
        }
    }

    async function indexAllRun({onProgress}) {
        repoIgnore.clear();
        const started = Date.now();
        const enrichStartAttempted = enrichAttempted;
        const enrichStartSucceeded = enrichSucceeded;
        // Warm the revision mirror once so per-file indexContent reads the content
        // hash from memory instead of querying the store for every file.
        //
        if(typeof store.knownPaths === 'function' && typeof store.getContentHash === 'function') {
            await ensureRevisionSeed();
        }
        const [files, dependencyDocs] = await Promise.all([
            listFiles(),
            indexDependencies ? collectDependencyDocs({root, repoIgnore}) : Promise.resolve([])
        ]);
        const live = new Set([...files, ...dependencyDocs.map((doc) => doc.path)]);
        const known = typeof store.knownPaths === 'function' ? await store.knownPaths() : [];
        const stalePaths = known.filter((rel) => !live.has(rel));
        if(onProgress) {
            onProgress({
                kind: 'discovered',
                files: files.length,
                sourceFiles: files.length,
                dependencyFiles: dependencyDocs.length,
                removedFiles: stalePaths.length,
                totalFiles: files.length + dependencyDocs.length + stalePaths.length
            });
        }
        let removedFiles = 0;

        let indexedFiles = 0;
        let skippedFiles = 0;
        let totalChunks = 0;
        let totalGraphFacts = 0;
        const skipReasons = new Map();

        function noteSkipReason(reason) {
            const key = String(reason || 'unknown');
            skipReasons.set(key, (skipReasons.get(key) || 0) + 1);
        }

        for(const rel of stalePaths) {
            await forgetPath(rel);
            removedFiles++;
            if(onProgress) onProgress({kind: 'removed', rel, indexed: false, chunks: 0, skipped: false, removed: true});
        }

        // Buffer prepared plans and commit them in batches: one delete + one chunk
        // add + one graph add per batch, instead of those commits per file. Commit
        // count per batch is constant, which is what keeps indexAll ~linear.
        //
        const writeBatch = [];
        async function flushBatch() {
            if(writeBatch.length === 0) {
                return;
            }
            await applyPlans(writeBatch.splice(0), {onProgress});
        }

        // Cooperative async (overlapping I/O on the event loop), NOT a worker-thread
        // pool — deliberately. The heavy per-file work is native ONNX embedding (already
        // multi-threaded in onnxruntime-node and serialized to one in-flight call) and
        // web-tree-sitter parsing (WASM Parser/Tree objects aren't transferable or
        // thread-safe across worker_threads). So a pool like piscina would add
        // re-instantiation + structured-clone overhead, not parallelism. Revisit only if
        // profiling shows tree-sitter parsing dominating on very large repos.
        //
        await mapWithConcurrency(files, INDEX_CONCURRENCY, async (rel) => {
            if(onProgress) onProgress({kind: 'source_start', rel, active: true});
            let prepared;
            try {
                prepared = await prepareFile(rel);
            } catch(err) {
                noteSkipReason('read_failed');
                if(onProgress) onProgress({kind: 'error', rel, message: err?.message});
                return;
            }
            const res = prepared.res;
            if(res.indexed) {
                indexedFiles++;
                totalChunks += res.chunks;
                totalGraphFacts += res.graphFacts || 0;
            } else if(res.skipped) {
                skippedFiles++;
                noteSkipReason(res.reason);
            }
            if(onProgress) onProgress({kind: 'source', rel, ...res});

            if(prepared.action === 'write' || prepared.action === 'remove') {
                writeBatch.push(prepared);
                if(writeBatch.length >= INDEX_BATCH_FILES) {
                    await flushBatch();
                    await optimize();
                }
            }
        });
        await flushBatch();

        const dependencyStats = await indexDependencyDocs({
            docs: dependencyDocs,
            onProgress,
            apply: (plans) => applyPlans(plans, {onProgress})
        });
        indexedFiles += dependencyStats.indexedFiles;
        skippedFiles += dependencyStats.skippedFiles;
        removedFiles += dependencyStats.removedFiles;
        totalChunks += dependencyStats.totalChunksIndexed;
        totalGraphFacts += dependencyStats.totalGraphFactsIndexed || 0;

        await optimize();
        await refreshSourceRevision();
        const knownAfterIndex = typeof store.knownPaths === 'function' ? await store.knownPaths() : [];
        const indexedSourceFiles = knownAfterIndex.filter((rel) => !isVirtualDependencyPath(rel)).length;
        const skippedByReason = Object.fromEntries([...skipReasons]
            .filter(([reason]) => reason !== 'unchanged')
            .sort(([a], [b]) => a.localeCompare(b)));
        const coverageSkippedFiles = Object.values(skippedByReason).reduce((sum, count) => sum + count, 0);
        lastCoverage = {
            eligibleFiles: files.length,
            indexedSourceFiles,
            skippedFiles: coverageSkippedFiles,
            skippedByReason,
            unchangedFiles: skipReasons.get('unchanged') || 0,
            dependencyDocuments: dependencyStats.files,
            chunksInStore: await store.count(),
            enrichment: {
                enabled: Boolean(enricher),
                attempted: enrichAttempted,
                succeeded: enrichSucceeded,
                coverage: enrichAttempted > 0 ? Number((enrichSucceeded / enrichAttempted).toFixed(4)) : null
            },
            sourceRevision,
            indexFingerprint,
            policyLimitations: {
                maximumFileBytes: MAX_INDEX_FILE_BYTES,
                unsupportedTypesExcluded: true,
                ignoreRulesApplied: true,
                binaryFilesExcluded: true,
                dependencyDocsEnabled: indexDependencies
            }
        };
        const stats = {
            files: files.length,
            dependencyFiles: dependencyStats.files,
            indexedFiles,
            skippedFiles,
            removedFiles,
            totalChunksIndexed: totalChunks,
            totalGraphFactsIndexed: totalGraphFacts,
            chunksInStore: lastCoverage.chunksInStore,
            graphFactsInStore: typeof store.countCodeGraph === 'function' ? await store.countCodeGraph() : 0,
            enrichment: {
                enabled: Boolean(enricher),
                attempted: enrichAttempted - enrichStartAttempted,
                succeeded: enrichSucceeded - enrichStartSucceeded
            },
            durationMs: Date.now() - started,
            lastIndexedAt,
            sourceRevision,
            indexFingerprint,
            coverage: lastCoverage
        };
        return stats;
    }

    async function snapshot() {
        const files = await listFiles();
        const known = typeof store.knownPaths === 'function' ? await store.knownPaths() : [];
        const chunksInStore = await store.count();
        const coverage = lastCoverage ? {
            ...lastCoverage,
            eligibleFiles: files.length,
            indexedSourceFiles: known.filter((rel) => !isVirtualDependencyPath(rel)).length,
            dependencyDocuments: known.filter(isVirtualDependencyPath).length,
            chunksInStore,
            sourceRevision,
            indexFingerprint
        } : null;
        return {
            files: files.length,
            chunksInStore,
            graphFactsInStore: typeof store.countCodeGraph === 'function' ? await store.countCodeGraph() : 0,
            enrichment: {enabled: Boolean(enricher), attempted: enrichAttempted, succeeded: enrichSucceeded},
            lastIndexedAt,
            sourceRevision,
            indexingInProgress,
            indexFingerprint,
            coverage
        };
    }

    // Merge newly-written rows into the BM25 indexes (no-op if the store has no
    // full-text indexes). Run after bulk or incremental writes.
    //
    async function optimize() {
        if(typeof store.optimize === 'function') {
            await store.optimize();
        }
    }

    function currentSourceRevision() {
        return sourceRevision;
    }

    function sourceState() {
        return {
            sourceRevision: currentSourceRevision(),
            indexingInProgress,
            lastIndexedAt,
            indexFingerprint,
            coverage: lastCoverage ? {...lastCoverage, sourceRevision: currentSourceRevision()} : null
        };
    }

    function invalidateIgnorePolicy() {
        repoIgnore.clear();
    }

    return {indexFile, removeFile, indexAll, optimize, listFiles, snapshot, sourceState, invalidateIgnorePolicy, indexFingerprint};
}

function indexResultChanged(res) {
    if(!res) {
        return false;
    }
    if(res.indexed || res.removed) {
        return true;
    }
    if(res.skipped) {
        return Boolean(res.reason);
    }
    return res.indexed === false;
}

function dependencyStatsChanged(stats) {
    if(!stats) {
        return false;
    }
    return (stats.indexedFiles || 0) > 0 || (stats.removedFiles || 0) > 0;
}

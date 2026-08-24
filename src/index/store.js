import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import fs from 'fs-extra';
import {writeJsonAtomic} from '../util/json-id-store.js';

const TABLE_NAME = 'chunks';
const TRACE_TABLE_NAME = 'traces';
const CODE_GRAPH_TABLE_NAME = 'code_graph';
// Sidecar recording the embedding configuration the tables were built with.
// Vector width is fixed at table creation, so opening an existing store with
// a different embedding setup must rebuild rather than crash mid-index.
//
const STORE_META_FILE = 'store-meta.json';
// Columns carrying the BM25 full-text index. chunks.ftsText folds the file
// path (repeated, to keep file-name recall strong) in front of the content;
// code_graph.searchText already concatenates the graph fact fields.
//
const CHUNK_FTS_COLUMN = 'ftsText';
const GRAPH_FTS_COLUMN = 'searchText';
const PATH_BOOST_REPEAT = 3;
// How many paths a single delete predicate names. Batches larger than this
// split into several delete statements (still inside one write block) to keep
// the generated SQL predicate bounded.
//
const DELETE_PREDICATE_PATHS = 500;

// LanceDB-backed chunk store and trace store.
//
// chunks table: code embeddings indexed by file+line range.
//   { path, lineStart, lineEnd, content, embedding, contentHash }
//
// traces table: question + summary embeddings for completed traces.
// Used by the trace indexer to surface related prior answers.
// LanceDB folds unquoted identifiers to lowercase in WHERE clauses, so all
// trace columns use snake_case to keep queries simple.
//   { trace_id, question_hash, question, summary, component_kinds, timestamp, embedding }
//
// Both tables share the same LanceDB connection and embedding dimensionality.
//
export async function createStore({root, dims, fingerprint = null, log = null, onDegraded = null}) {
    if(!root) throw new Error('createStore requires {root}');
    if(!dims || dims <= 0) throw new Error('createStore requires {dims}');

    await fs.ensureDir(root);
    const db = await lancedb.connect(root);

    const seeds = {
        [TABLE_NAME]: {
            rows: [{
                path: '__seed__',
                lineStart: 0,
                lineEnd: 0,
                content: '',
                ftsText: '',
                description: '',
                embedding: Array.from({length: dims}, () => 0),
                contentHash: ''
            }],
            clear: `path = '__seed__'`
        },
        [TRACE_TABLE_NAME]: {
            rows: [{
                trace_id: '__seed__',
                question_hash: '',
                question: '',
                summary: '',
                component_kinds: '',
                timestamp: 0,
                embedding: Array.from({length: dims}, () => 0)
            }],
            clear: `trace_id = '__seed__'`
        },
        [CODE_GRAPH_TABLE_NAME]: {
            rows: [{
                path: '__seed__',
                lineStart: 0,
                lineEnd: 0,
                kind: '',
                name: '',
                target: '',
                detail: '',
                syntax: '',
                searchText: '',
                contentHash: ''
            }],
            clear: `path = '__seed__'`
        }
    };

    async function createSeeded(name) {
        const seed = seeds[name];
        const created = await db.createTable(name, seed.rows);
        await created.delete(seed.clear);
        return created;
    }

    async function openOrCreate(name) {
        try {
            return await db.openTable(name);
        } catch {
            return createSeeded(name);
        }
    }

    let table = await openOrCreate(TABLE_NAME);
    let traceTable = await openOrCreate(TRACE_TABLE_NAME);
    let codeGraphTable = await openOrCreate(CODE_GRAPH_TABLE_NAME);

    // Embedding-config guard: the tables' vector width is fixed at creation,
    // so a store built under a different embedding setup cannot be reused —
    // writes would fail with an opaque Arrow error and trace vectors would
    // silently live in a different vector space than live queries. On
    // mismatch, drop and recreate all three tables (source chunks re-index
    // from the repo; traces re-index as new asks complete).
    //
    const expectedMeta = {version: 1, dims, fingerprint: fingerprint || null};
    const storedMeta = await readStoreMeta(root);
    if(!storedMeta) {
        await writeStoreMeta(root, expectedMeta);
    } else if(storeMetaMismatch(storedMeta, expectedMeta)) {
        log?.warn?.({stored: storedMeta, expected: expectedMeta}, 'embedding configuration changed — rebuilding the code index');
        for(const name of [TABLE_NAME, TRACE_TABLE_NAME, CODE_GRAPH_TABLE_NAME]) {
            await db.dropTable(name);
        }
        table = await createSeeded(TABLE_NAME);
        traceTable = await createSeeded(TRACE_TABLE_NAME);
        codeGraphTable = await createSeeded(CODE_GRAPH_TABLE_NAME);
        await writeStoreMeta(root, expectedMeta);
    }

    // BM25 full-text indexes back the lexical and graph-term searches. Rows
    // added after creation are still searched (LanceDB flat-scans the
    // unindexed tail), so we only build the index once per column.
    //
    await ensureFtsIndex(table, CHUNK_FTS_COLUMN);
    await ensureFtsIndex(codeGraphTable, GRAPH_FTS_COLUMN);

    function escape(s) {
        return String(s).replace(/'/g, "''");
    }

    // LanceDB commits use optimistic concurrency, so concurrent add/delete on the
    // same table can conflict. The indexer runs files in parallel, so all chunk +
    // graph mutations are funneled through this chain to commit one at a time. The
    // expensive read/parse/chunk/embed work still overlaps; only the commits queue.
    //
    let writeChain = Promise.resolve();

    function withWrite(fn) {
        const run = writeChain.then(fn, fn);
        writeChain = run.then(() => undefined, () => undefined);
        return run;
    }

    // Reads wait out every write block enqueued before they arrived, so a
    // search can never observe the gap inside an in-flight delete+add pair
    // (e.g. mid-reindex, when a file's stale rows are gone but its replacements
    // have not committed yet). Reads never queue behind each other and never
    // extend the write chain, so search concurrency is unaffected.
    //
    function withRead(fn) {
        return writeChain.then(fn);
    }

    // ───── Code chunks ─────

    async function removePathImpl(path) {
        await table.delete(`path = '${escape(path)}'`);
        await codeGraphTable.delete(`path = '${escape(path)}'`);
    }

    async function removePath(path) {
        return withWrite(() => removePathImpl(path));
    }

    async function addChunks(rows) {
        if(!Array.isArray(rows) || rows.length === 0) return;
        const normalized = rows.map((r) => {
            const content = String(r.content || '');
            const path = String(r.path);
            const description = String(r.description || '');
            const embedding = Array.from(r.embedding);
            if(embedding.length !== dims) {
                throw new Error(`embedding width ${embedding.length} does not match index width ${dims} for ${path} — the embedding configuration changed; restart to rebuild the index`);
            }
            return {
                path,
                lineStart: r.lineStart | 0,
                lineEnd: r.lineEnd | 0,
                content,
                ftsText: buildChunkFtsText(path, content, description),
                description,
                embedding,
                contentHash: String(r.contentHash || '')
            };
        });
        await table.add(normalized);
    }

    // Add graph rows that each carry their own `path` (one table.add). Internal so
    // it can run inside an existing withWrite block.
    //
    async function addGraphImpl(rows) {
        if(!Array.isArray(rows) || rows.length === 0) {
            return;
        }
        const normalized = rows.map((row) => normalizeGraphWriteRow(row.path, row));
        await codeGraphTable.add(normalized);
    }

    // skipDelete is set by callers that know the path has no existing rows (e.g.
    // a cold index), letting the insert skip the wasted delete commit.
    //
    async function upsertFile(path, rows, {skipDelete = false} = {}) {
        return withWrite(async () => {
            if(!skipDelete) {
                await removePathImpl(path);
            }
            if(rows.length > 0) {
                await addChunks(rows);
            }
        });
    }

    async function upsertCodeGraph(path, rows, {skipDelete = false} = {}) {
        return withWrite(async () => {
            if(!skipDelete) {
                await codeGraphTable.delete(`path = '${escape(path)}'`);
            }
            if(!Array.isArray(rows) || rows.length === 0) {
                return;
            }
            await addGraphImpl(rows.map((row) => ({...row, path})));
        });
    }

    // Batched writes for full-index flushes: one commit each, covering rows from
    // many files at once. Rows carry their own `path`. Used by indexAll instead of
    // the per-file upsert* methods so commit count stays bounded as the repo grows.
    //
    async function removePaths(paths) {
        const list = (Array.isArray(paths) ? paths : []).filter(Boolean);
        if(list.length === 0) {
            return;
        }
        return withWrite(() => deletePathsImpl(list));
    }

    // Internal delete-by-paths, chunked to bound predicate size. Runs inside an
    // existing write block.
    //
    async function deletePathsImpl(paths) {
        for(let start = 0; start < paths.length; start += DELETE_PREDICATE_PATHS) {
            const slice = paths.slice(start, start + DELETE_PREDICATE_PATHS);
            const predicate = `path IN (${slice.map((p) => `'${escape(p)}'`).join(', ')})`;
            await table.delete(predicate);
            await codeGraphTable.delete(predicate);
        }
    }

    // Commit a whole index batch inside ONE write block: stale rows disappear
    // and their replacements land before any later-arriving gated read runs.
    // This is the canonical batch-commit path; the separate removePaths /
    // addChunkRows / addGraphRows calls remain for tests and back-compat but
    // expose the deleted-not-yet-readded window between commits.
    //
    async function applyBatch({deletePaths = [], chunkRows = [], graphRows = []} = {}) {
        const paths = (Array.isArray(deletePaths) ? deletePaths : []).filter(Boolean);
        const chunks = Array.isArray(chunkRows) ? chunkRows : [];
        const graphs = Array.isArray(graphRows) ? graphRows : [];
        if(paths.length === 0 && chunks.length === 0 && graphs.length === 0) {
            return;
        }
        return withWrite(async () => {
            await deletePathsImpl(paths);
            await addChunks(chunks);
            await addGraphImpl(graphs);
        });
    }

    async function addChunkRows(rows) {
        return withWrite(() => addChunks(rows));
    }

    async function addGraphRows(rows) {
        return withWrite(() => addGraphImpl(rows));
    }

    async function getContentHash(path) {
        const res = await withRead(() => table
            .query()
            .where(`path = '${escape(path)}'`)
            .limit(1)
            .select(['contentHash'])
            .toArray());
        if(!res || res.length === 0) return null;
        return res[0].contentHash || null;
    }

    // Bulk variant of getContentHash: one table scan returning {path -> contentHash}
    // for every stored chunk's owning file. The revision-mirror seed uses this
    // instead of a per-path getContentHash query so warming the mirror is a single
    // scan rather than N indexed lookups. Last row per path wins (all chunks of a
    // file share one contentHash, so the value is stable across a path's rows).
    //
    async function getAllContentHashes() {
        const rows = await withRead(() => table.query().select(['path', 'contentHash']).toArray());
        const map = new Map();
        for(const row of rows) {
            map.set(row.path, row.contentHash || '');
        }
        return map;
    }

    async function searchByEmbedding(vector, limit = 6) {
        const arr = Array.from(vector);
        const rows = await withRead(() => table
            .vectorSearch(arr)
            .distanceType('cosine')
            .limit(limit)
            .toArray());
        return rows.map(normalizeRow);
    }

    // BM25 full-text search over chunk content. Returns chunk rows directly
    // (the FTS index lives on the chunks table), ordered by relevance.
    //
    async function searchByText(text, limit = 6) {
        const query = String(text || '').trim();
        if(!query) return [];
        const rows = await withRead(() => ftsQuery(table, CHUNK_FTS_COLUMN, query, limit));
        return rows.map(normalizeRow);
    }

    async function searchGraphByText(text, limit = 12) {
        const query = String(text || '').trim();
        if(!query) return [];
        const rows = await withRead(() => ftsQuery(codeGraphTable, GRAPH_FTS_COLUMN, query, limit));
        return rows.map(normalizeGraphRow);
    }

    async function ftsQuery(targetTable, column, query, limit) {
        // The query is natural-language text, not FTS query syntax. Double quotes
        // are the one character Tantivy treats as an operator (phrase) that
        // rejects otherwise-valid input, so neutralize them. A query with no
        // alphanumeric token can't match — skip it rather than round-trip.
        //
        const cleaned = String(query || '').replace(/"/g, ' ').trim();
        if(!/[a-z0-9]/i.test(cleaned)) {
            return [];
        }
        try {
            return await targetTable.search(cleaned, 'fts', column).limit(limit).toArray();
        } catch(err) {
            // Swallow only FTS query-parse rejections (malformed user text). Surface
            // everything else — a missing or broken index must NOT read as "no
            // matches" (which would let the vector leg silently mask the failure).
            //
            if(/invalid user input/i.test(err?.message || '')) {
                return [];
            }
            throw err;
        }
    }

    // All import edges in the source graph — the raw material for import-graph
    // centrality (see src/index/graph-hubs.js). Targets are the specifiers as
    // written in source (relative paths, module names); resolution to repo
    // paths is the caller's job.
    //
    async function importEdges(limit = 20_000) {
        const rows = await withRead(() => codeGraphTable
            .query()
            .where(`kind = 'import'`)
            .select(['path', 'target'])
            .limit(limit)
            .toArray());
        return rows.map((r) => ({path: r.path, target: r.target}));
    }

    // The head chunk of a file (lowest lineStart) — enough context to introduce
    // an architecture hub as evidence without reading the file from disk.
    //
    async function firstChunkForPath(path) {
        const rows = await withRead(() => table
            .query()
            .where(`path = '${escape(path)}'`)
            .limit(8)
            .toArray());
        if(!rows || rows.length === 0) {
            return null;
        }
        rows.sort((a, b) => (Number(a.lineStart) || 0) - (Number(b.lineStart) || 0));
        return normalizeRow(rows[0]);
    }

    async function chunksForGraphRows(graphRows, limit = 6) {
        const out = [];
        const seen = new Set();
        const candidates = (graphRows || []).filter((graph) => graph?.path).slice(0, Math.max(limit, 1));
        const groups = await withRead(() => Promise.all(candidates.map((graph) => chunksForGraphRow(graph))));
        for(const rows of groups) {
            for(const row of rows) {
                const key = `${row.path}:${row.lineStart}-${row.lineEnd}`;
                if(seen.has(key)) continue;
                seen.add(key);
                out.push(row);
                if(out.length >= limit) break;
            }
            if(out.length >= limit) break;
        }
        return out;
    }

    async function chunksForGraphRow(graph) {
        const path = graph.path;
        const lineStart = Number(graph.lineStart) || 1;
        const lineEnd = Number(graph.lineEnd) || lineStart;
        let rows = await table
            .query()
            .where(`path = '${escape(path)}' AND lineStart <= ${lineEnd} AND lineEnd >= ${lineStart}`)
            .limit(2)
            .toArray();
        if(!rows || rows.length === 0) {
            rows = await table
                .query()
                .where(`path = '${escape(path)}'`)
                .limit(1)
                .toArray();
        }
        return rows.map((row) => ({
            ...normalizeRow(row),
            graph: {
                kind: graph.kind,
                name: graph.name,
                target: graph.target,
                detail: graph.detail,
                lineStart: graph.lineStart,
                lineEnd: graph.lineEnd
            }
        }));
    }

    // Merge newly-added rows into the BM25 indexes. LanceDB does not always
    // include rows added after an FTS index was built until the table is
    // optimized, so callers run this after bulk or incremental writes.
    //
    async function optimize() {
        return withWrite(async () => {
            try {
                await table.optimize();
                await codeGraphTable.optimize();
                // Build the path scalar index once rows exist (idempotent); the
                // optimize calls above fold any newly-added tail into it.
                //
                await ensureScalarIndex(table, 'path');
                await ensureScalarIndex(codeGraphTable, 'path');
            } catch(err) {
                // Best-effort: search still works on whatever is already indexed,
                // but a persistently failing optimize means the BM25 index stops
                // folding in new rows — count it instead of hiding it.
                //
                onDegraded?.({area: 'store_optimize', err});
            }
        });
    }

    async function count() {
        return withRead(() => table.countRows());
    }

    async function countCodeGraph() {
        return withRead(() => codeGraphTable.countRows());
    }

    async function knownPaths() {
        const rows = await withRead(() => table.query().select(['path']).toArray());
        return Array.from(new Set(rows.map((r) => r.path))).sort();
    }

    // ───── Trace index ─────

    async function upsertTrace({traceId, questionHash, question, summary, componentKinds, timestamp, embedding}) {
        if(!traceId || !embedding) {
            throw new Error('upsertTrace requires {traceId, embedding}');
        }
        // Serialized on the write chain so concurrent trace upserts cannot hit
        // LanceDB's optimistic-concurrency conflict against each other.
        //
        return withWrite(async () => {
            // Dedup: latest question per hash wins.
            //
            if(questionHash) {
                await traceTable.delete(`question_hash = '${escape(questionHash)}'`);
            }
            // Store time as Unix seconds. Milliseconds (Date.now()) exceed Int32
            // range, and LanceDB's JS bindings infer Int32 from small seed values.
            // Seconds fit until 2038 and are easy to reason about in queries.
            //
            const ts = toUnixSeconds(timestamp || Date.now());
            await traceTable.add([{
                trace_id: String(traceId),
                question_hash: String(questionHash || ''),
                question: String(question || ''),
                summary: String(summary || ''),
                component_kinds: JSON.stringify(Array.isArray(componentKinds) ? componentKinds : []),
                timestamp: ts,
                embedding: Array.from(embedding)
            }]);
        });
    }

    async function searchTraces(vector, limit = 3, {minTimestamp} = {}) {
        const arr = Array.from(vector);
        const rows = await withRead(() => {
            let q = traceTable.vectorSearch(arr).distanceType('cosine').limit(limit);
            if(typeof minTimestamp === 'number' && minTimestamp > 0) {
                q = q.where(`timestamp >= ${toUnixSeconds(minTimestamp)}`);
            }
            return q.toArray();
        });
        return rows.map(normalizeTraceRow);
    }

    async function pruneTracesOlderThan(cutoffMs) {
        if(!cutoffMs || cutoffMs <= 0) return 0;
        await withWrite(() => traceTable.delete(`timestamp < ${toUnixSeconds(cutoffMs)}`));
        return 1;
    }

    async function countTraces() {
        return withRead(() => traceTable.countRows());
    }

    async function close() {
        await writeChain;
        for(const item of [table, traceTable, codeGraphTable]) {
            if(item?.isOpen?.()) {
                item.close();
            }
        }
        if(db?.isOpen?.()) {
            db.close();
        }
    }

    return {
        removePath,
        removePaths,
        applyBatch,
        upsertFile,
        upsertCodeGraph,
        addChunkRows,
        addGraphRows,
        getContentHash,
        getAllContentHashes,
        searchByEmbedding,
        searchByText,
        searchGraphByText,
        chunksForGraphRows,
        importEdges,
        firstChunkForPath,
        optimize,
        count,
        countCodeGraph,
        knownPaths,
        upsertTrace,
        searchTraces,
        pruneTracesOlderThan,
        countTraces,
        close
    };
}

async function readStoreMeta(root) {
    try {
        const data = await fs.readJson(path.join(root, STORE_META_FILE));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch {
        return null;
    }
}

function writeStoreMeta(root, meta) {
    return writeJsonAtomic({file: path.join(root, STORE_META_FILE), data: meta});
}

// A store is reusable only when its vector width matches and, when both sides
// carry a fingerprint, the embedding configuration matches too. A missing
// fingerprint on either side (pre-guard stores, callers that pass none) falls
// back to the dims comparison alone rather than forcing a rebuild.
//
function storeMetaMismatch(stored, expected) {
    if(Number(stored.dims) !== Number(expected.dims)) {
        return true;
    }
    if(!stored.fingerprint || !expected.fingerprint) {
        return false;
    }
    return stableStringify(stored.fingerprint) !== stableStringify(expected.fingerprint);
}

function stableStringify(value) {
    if(!value || typeof value !== 'object' || Array.isArray(value)) {
        return JSON.stringify(value ?? null);
    }
    const sorted = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    return JSON.stringify(sorted);
}

function normalizeRow(r) {
    return {
        path: r.path,
        lineStart: Number(r.lineStart) || 0,
        lineEnd: Number(r.lineEnd) || 0,
        content: r.content || '',
        description: r.description || '',
        score: typeof r._distance === 'number' ? r._distance : null
    };
}

function normalizeGraphWriteRow(path, row) {
    const kind = String(row.kind || '');
    const name = String(row.name || '');
    const target = String(row.target || '');
    const detail = String(row.detail || '');
    const syntax = typeof row.syntax === 'string' ? row.syntax : JSON.stringify(row.syntax || {});
    const searchText = [
        path,
        kind,
        name,
        target,
        detail,
        syntax
    ].join('\n').toLowerCase();
    return {
        path: String(path),
        lineStart: Number(row.lineStart) || 1,
        lineEnd: Number(row.lineEnd) || Number(row.lineStart) || 1,
        kind,
        name,
        target,
        detail,
        syntax,
        searchText,
        contentHash: String(row.contentHash || '')
    };
}

function normalizeGraphRow(r) {
    return {
        path: r.path,
        lineStart: Number(r.lineStart) || 0,
        lineEnd: Number(r.lineEnd) || 0,
        kind: r.kind || '',
        name: r.name || '',
        target: r.target || '',
        detail: r.detail || '',
        syntax: r.syntax || '',
        contentHash: r.contentHash || ''
    };
}

// Full-text payload for a chunk: the file path (repeated so BM25 keeps strong
// file-name recall, mirroring the old path-weight bias) followed by the source.
//
function buildChunkFtsText(path, content, description = '') {
    const tokens = ftsPathTokens(path);
    const boosted = Array.from({length: PATH_BOOST_REPEAT}, () => tokens).join(' ');
    // The product-language description (when present) is repeated so BM25 weights
    // it — product-phrased questions should match it even when they never name
    // the file or use its code identifiers.
    //
    const desc = description ? `${description}\n${description}\n` : '';
    return `${desc}${path}\n${boosted}\n${content}`;
}

function ftsPathTokens(path) {
    return String(path || '')
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .join(' ');
}

// Build the BM25 index on a column once. Safe to call on every open — if an
// index already covers the column we leave it in place.
//
async function ensureFtsIndex(targetTable, column) {
    try {
        const indices = await targetTable.listIndices();
        const covered = indices.some((index) => (index.columns || []).includes(column));
        if(covered) {
            return;
        }
    } catch {
        // listIndices can throw on a brand-new table; fall through to create.
        //
    }
    try {
        await targetTable.createIndex(column, {config: lancedb.Index.fts()});
    } catch {
        // A concurrent creator may have won the race; ignore.
        //
    }
}

// A BTREE scalar index on `path` turns the per-file content-hash lookups and
// delete-by-path commits (full table scans otherwise) into indexed lookups. The
// index covers rows present when it is built/refreshed; optimize() folds in the
// tail added afterward.
//
async function ensureScalarIndex(targetTable, column) {
    try {
        const indices = await targetTable.listIndices();
        const covered = indices.some((index) => (index.columns || []).includes(column));
        if(covered) {
            return;
        }
    } catch {
        // listIndices can throw on a brand-new table; fall through to create.
        //
    }
    try {
        await targetTable.createIndex(column, {config: lancedb.Index.btree()});
    } catch {
        // A concurrent creator may have won the race, or this build predates rows
        // worth indexing; either way the table stays queryable via scan.
        //
    }
}

function normalizeTraceRow(r) {
    let componentKinds = [];
    try {
        componentKinds = r.component_kinds ? JSON.parse(r.component_kinds) : [];
    } catch {
        componentKinds = [];
    }
    return {
        traceId: r.trace_id,
        question: r.question || '',
        summary: r.summary || '',
        componentKinds,
        // Convert seconds back to ms so callers can use Date math directly.
        //
        timestamp: (Number(r.timestamp) || 0) * 1000,
        similarity: typeof r._distance === 'number' ? 1 - r._distance : null
    };
}

function toUnixSeconds(ms) {
    return Math.floor(Number(ms) / 1000);
}

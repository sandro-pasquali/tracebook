// Micro-benchmark for the indexing hot path. Generates a synthetic repo, runs a
// full indexAll, then times a series of single-file edits (the watch-mode path).
//
// It uses the real LanceDB store and chunker with a fast deterministic stand-in
// embedder, so it isolates pipeline overhead (scan, chunk, store writes, source
// revision tracking) from model latency.
//
// Run at two sizes to see the watch-mode win: per-edit time should stay roughly
// flat as the repo grows, because the source revision now recomputes from an
// in-memory mirror instead of re-reading every file's hash from the store.
//
//   node scripts/bench-index.js --files 500 --edits 50
//   node scripts/bench-index.js --files 4000 --edits 50
//
// Add --real to use the configured embedding model (createEmbedder, honoring .env)
// instead of the fast stand-in, so the `embed` stage timing reflects real model
// throughput. The model is warmed up before the timed indexAll.
//
//   node scripts/bench-index.js --real --files 500 --edits 20
//

import '../src/util/models-dir.js';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createStore} from '../src/index/store.js';
import {createIndexer} from '../src/index/indexer.js';
import {createEmbedder} from '../src/index/embedder.js';

const DIMS = 8;

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

function flag(name) {
    return process.argv.includes(`--${name}`);
}

// Wrap an embedder so each embed() call accumulates wall-clock into the meter.
//
function timeEmbedder(embedder, meter) {
    return {
        ...embedder,
        async embed(values, opts) {
            meter.embedCalls += 1;
            meter.embedItems += Array.isArray(values) ? values.length : 1;
            const s = performance.now();
            try {
                return await embedder.embed(values, opts);
            } finally {
                meter.embed += performance.now() - s;
            }
        }
    };
}

// Wrap the store so each call to the timed methods accumulates wall-clock into
// `meter`, letting the bench attribute indexAll time across hash lookups vs the
// upsert commits vs compaction.
//
function instrument(store, meter) {
    const timed = ['getContentHash', 'upsertFile', 'upsertCodeGraph', 'optimize', 'removePath'];
    const wrapped = Object.create(store);
    for(const name of timed) {
        if(typeof store[name] !== 'function') {
            continue;
        }
        wrapped[name] = async (...args) => {
            const s = performance.now();
            try {
                return await store[name](...args);
            } finally {
                meter[name] += performance.now() - s;
            }
        };
    }
    return wrapped;
}

function fakeEmbedder() {
    // Deterministic, dependency-free vectors; cost is negligible so the timings
    // reflect the surrounding pipeline rather than the model.
    //
    return {
        dims: DIMS,
        async embed(items) {
            return items.map((text) => {
                const vec = new Array(DIMS).fill(0);
                for(let i = 0; i < text.length; i++) {
                    vec[i % DIMS] += text.charCodeAt(i) % 17;
                }
                return vec;
            });
        }
    };
}

function fileBody(seed) {
    return [
        `export function handler_${seed}(input) {`,
        `    const total = input.items.reduce((sum, item) => sum + item.price, 0);`,
        `    return {ok: true, total, seed: ${seed}};`,
        `}`,
        ``
    ].join(os.EOL);
}

async function main() {
    const fileCount = arg('files', 500);
    const editCount = arg('edits', 50);

    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-bench-repo-'));
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-bench-data-'));

    for(let i = 0; i < fileCount; i++) {
        const dir = path.join(repoRoot, 'src', `mod_${i % 20}`);
        await fs.ensureDir(dir);
        await fs.writeFile(path.join(dir, `file_${i}.js`), fileBody(i));
    }

    const useReal = flag('real');
    const meter = {getContentHash: 0, upsertFile: 0, upsertCodeGraph: 0, optimize: 0, removePath: 0, embed: 0, embedCalls: 0, embedItems: 0};
    const baseEmbedder = useReal ? createEmbedder() : fakeEmbedder();
    if(useReal && typeof baseEmbedder.warmup === 'function') {
        process.stdout.write(`loading embedding model ${baseEmbedder.model}...${os.EOL}`);
        await baseEmbedder.warmup();
    }
    const embedder = timeEmbedder(baseEmbedder, meter);
    const store = instrument(await createStore({root: dataRoot, dims: baseEmbedder.dims}), meter);
    const indexer = createIndexer({
        root: repoRoot,
        include: ['**/*.js'],
        exclude: [],
        embedder,
        store
    });

    // Reset the embed meters after warmup so they reflect indexAll only.
    //
    meter.embed = 0;
    meter.embedCalls = 0;
    meter.embedItems = 0;
    const t0 = performance.now();
    const stats = await indexer.indexAll();
    const indexAllMs = performance.now() - t0;
    const embedDuringIndex = {ms: meter.embed, calls: meter.embedCalls, items: meter.embedItems};

    // Time single-file edits: rewrite a file, then reindex it. This exercises the
    // touchRevision path that runs on every save in watch mode.
    //
    const editTimes = [];
    for(let e = 0; e < editCount; e++) {
        const target = e % fileCount;
        const rel = path.join('src', `mod_${target % 20}`, `file_${target}.js`);
        await fs.writeFile(path.join(repoRoot, rel), fileBody(target) + `// edit ${e}${os.EOL}`);
        const s = performance.now();
        await indexer.indexFile(rel);
        editTimes.push(performance.now() - s);
    }

    editTimes.sort((a, b) => a - b);
    const sum = editTimes.reduce((a, b) => a + b, 0);
    const avg = sum / editTimes.length;
    const p50 = editTimes[Math.floor(editTimes.length * 0.5)];
    const p95 = editTimes[Math.floor(editTimes.length * 0.95)];

    const ms = (n) => `${n.toFixed(0)} ms`;
    process.stdout.write([
        ``,
        `embedder:        ${useReal ? baseEmbedder.model : 'fake'}`,
        `files indexed:   ${stats.indexedFiles}`,
        `indexAll:        ${indexAllMs.toFixed(0)} ms  (${(indexAllMs / Math.max(1, stats.indexedFiles)).toFixed(2)} ms/file)`,
        `  embed:           ${ms(embedDuringIndex.ms)}  (${embedDuringIndex.calls} calls, ${embedDuringIndex.items} items)`,
        `  getContentHash:  ${ms(meter.getContentHash)}`,
        `  upsertFile:      ${ms(meter.upsertFile)}`,
        `  upsertCodeGraph: ${ms(meter.upsertCodeGraph)}`,
        `  optimize:        ${ms(meter.optimize)}`,
        `single edit avg: ${avg.toFixed(2)} ms`,
        `single edit p50: ${p50.toFixed(2)} ms`,
        `single edit p95: ${p95.toFixed(2)} ms`,
        ``
    ].join(os.EOL));

    await fs.remove(repoRoot);
    await fs.remove(dataRoot);
}

main().catch((err) => {
    process.stderr.write(`${err?.stack || err}${os.EOL}`);
    process.exitCode = 1;
});

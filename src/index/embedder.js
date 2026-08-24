import '../util/models-dir.js';
import os from 'node:os';
import {pipeline} from '@huggingface/transformers';
import {embedMany} from 'ai';
import crypto from 'node:crypto';
import {config} from '../util/config.js';
import {getOllamaProvider} from '../util/model.js';
import {resolveModelThreads} from '../util/model-threads.js';

const LOCAL_PROVIDER = 'local';
const OLLAMA_PREFIX = 'ollama/';

export function createEmbedder({
    model = config.embeddings.model,
    cacheCap = config.embeddings.cacheCap,
    batch = config.embeddings.batch,
    dims = config.embeddings.dims,
    dtype = config.embeddings.dtype,
    numThreads = config.embeddings.numThreads,
    queryPrefix = config.embeddings.queryPrefix,
    docPrefix = config.embeddings.docPrefix,
    embedImpl: embedImplOverride,
    pipelineFactory,
    onProgress
} = {}) {
    // An "ollama/<id>" model runs through the local Ollama daemon; anything else
    // is a Hugging Face transformers model id (the default). Both are just values
    // of the embedding model setting — same selection model as the LLM specs.
    //
    const isOllama = model.toLowerCase().startsWith(OLLAMA_PREFIX);
    const provider = isOllama ? 'ollama' : LOCAL_PROVIDER;
    const modelId = isOllama ? model.slice(OLLAMA_PREFIX.length) : model;

    // embedImplOverride is a test seam (a function mapping inputs -> vectors) so
    // the prefix/cache plumbing can be exercised without loading a real model.
    //
    const embedImpl = embedImplOverride
        || (isOllama
            ? createOllamaEmbedImpl({model: modelId})
            : createLocalEmbedImpl({model: modelId, dtype, onProgress, threads: resolveModelThreads(numThreads, os.availableParallelism()), pipelineImpl: pipelineFactory}));
    const cache = new Map();

    // The local transformers.js model is a single ONNX session that must not be
    // entered concurrently. When indexAll runs files in parallel their embed()
    // calls overlap, so the actual model runs are chained through this promise so
    // only one batch executes at a time. Cache lookups still proceed concurrently;
    // only the misses queue here.
    //
    let embedChain = Promise.resolve();

    function runSerialized(fn) {
        const result = embedChain.then(fn, fn);
        embedChain = result.then(() => undefined, () => undefined);
        return result;
    }

    function cacheGet(key) {
        if(!cache.has(key)) {
            return null;
        }
        const value = cache.get(key);
        cache.delete(key);
        cache.set(key, value);
        return value;
    }

    function cacheSet(key, value) {
        if(cache.has(key)) {
            cache.delete(key);
        }
        cache.set(key, value);
        while(cache.size > cacheCap) {
            const oldest = cache.keys().next().value;
            cache.delete(oldest);
        }
    }

    function keyFor(value) {
        return crypto.createHash('sha1').update(`${provider}\n${model}\n${value}`, 'utf8').digest('hex');
    }

    // Asymmetric models (and the GGUF escalation rung) need different instruction
    // prefixes for the query side vs the indexed-document side. Prefixes are empty
    // for symmetric models (e.g. jina-v2-base-code), so this is a no-op there. The
    // prefix is folded into the cache key (it's part of the embedded string).
    //
    async function embed(values, {type = 'document'} = {}) {
        const prefix = type === 'query' ? queryPrefix : docPrefix;
        const rawInputs = Array.isArray(values) ? values : [values];
        const inputs = prefix ? rawInputs.map((value) => `${prefix}${value}`) : rawInputs;
        const out = new Array(inputs.length);
        const missIndexes = [];
        const missInputs = [];

        for(let i = 0; i < inputs.length; i++) {
            const k = keyFor(inputs[i]);
            const hit = cacheGet(k);
            if(hit) {
                out[i] = hit;
            } else {
                missIndexes.push(i);
                missInputs.push(inputs[i]);
            }
        }

        if(missInputs.length > 0) {
            await runSerialized(async () => {
                for(let i = 0; i < missInputs.length; i += batch) {
                    const slice = missInputs.slice(i, i + batch);
                    const vectors = await embedImpl(slice);
                    for(let j = 0; j < vectors.length; j++) {
                        const vec = Float32Array.from(vectors[j]);
                        const targetIndex = missIndexes[i + j];
                        out[targetIndex] = vec;
                        cacheSet(keyFor(missInputs[i + j]), vec);
                    }
                }
            });
        }

        return out;
    }

    function cacheStats() {
        return {size: cache.size, cap: cacheCap};
    }

    // Load the model up front (idempotent) so the first real embed isn't cold.
    //
    async function warmup() {
        await embed(['warmup'], {type: 'query'});
    }

    async function dispose() {
        await runSerialized(async () => {
            cache.clear();
            await embedImpl.dispose?.();
        });
    }

    return {
        embed,
        warmup,
        dispose,
        dims,
        provider,
        model,
        // Exposed so the index fingerprint can fold in everything that changes the
        // vectors produced for a given file: dtype (model precision) and docPrefix
        // (the instruction prefix on indexed text). queryPrefix is query-time only.
        //
        dtype,
        docPrefix,
        queryPrefix,
        cacheStats
    };
}

function createOllamaEmbedImpl({model}) {
    const embeddingModel = getOllamaProvider().textEmbeddingModel(model);
    return async (inputs) => {
        const {embeddings} = await embedMany({model: embeddingModel, values: inputs});
        return embeddings;
    };
}

function createLocalEmbedImpl({model, dtype = 'fp32', onProgress, threads, pipelineImpl = pipeline}) {
    let extractorPromise = null;
    async function extractor() {
        if(!extractorPromise) {
            // session_options caps onnxruntime-node's intra-op thread pool; without it
            // a single inference fans out across every physical core.
            //
            const options = {dtype, progress_callback: onProgress};
            if(threads > 0) {
                options.session_options = {intraOpNumThreads: threads};
            }
            extractorPromise = pipelineImpl('feature-extraction', model, options);
        }
        return extractorPromise;
    }

    const runInputs = async (inputs) => {
        const run = await extractor();
        const output = await run(inputs, {pooling: 'mean', normalize: true});
        return vectorsFromTensor(output, inputs.length);
    };
    runInputs.dispose = async () => {
        if(!extractorPromise) {
            return;
        }
        const run = await extractorPromise;
        await run?.dispose?.();
        extractorPromise = null;
    };
    return runInputs;
}

function vectorsFromTensor(output, count) {
    if(output && typeof output.tolist === 'function') {
        const list = output.tolist();
        if(Array.isArray(list?.[0])) {
            return list.map((v) => Float32Array.from(v));
        }
        if(Array.isArray(list)) {
            return [Float32Array.from(list)];
        }
    }

    const data = output?.data ? Array.from(output.data) : Array.from(output || []);
    const dims = Array.isArray(output?.dims) ? output.dims : [];
    const width = dims.length > 0 ? dims[dims.length - 1] : Math.floor(data.length / Math.max(1, count));
    const vectors = [];
    for(let i = 0; i < count; i++) {
        vectors.push(Float32Array.from(data.slice(i * width, (i + 1) * width)));
    }
    return vectors;
}

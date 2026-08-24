// Shared intra-op thread resolution for the local ONNX models (embedder, reranker).
// onnxruntime-node otherwise spawns one intra-op thread per physical core for each
// inference, which can saturate a big-core machine (and trip a power budget). We
// pass the resolved value as session_options.intraOpNumThreads at model load.
//
// Hard ceiling regardless of machine size or configured value.
//
export const MAX_MODEL_THREADS = 8;

// A positive configured value wins; otherwise default to half the available cores.
// Either way clamped to MAX_MODEL_THREADS and at least 1.
//
export function resolveModelThreads(configured, cores) {
    const base = configured > 0 ? configured : Math.max(1, Math.floor(cores / 2));
    return Math.min(MAX_MODEL_THREADS, base);
}

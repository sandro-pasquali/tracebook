import os from 'node:os';
import path from 'node:path';
import {env} from '@huggingface/transformers';

// Shared B&F HuggingFace model cache. The wider tool suite stores HuggingFace
// models under one directory; point transformers.js at it so a requested model
// resolves from this folder first and downloads only on a cache miss — never
// re-fetching what a sibling module already stored. Importing this module sets
// the cache directory as a side effect, so import it before any model load.
//
// Ollama is intentionally NOT part of this folder: it manages its own model
// store and caching. This is HuggingFace-only.
//
export const MODELS_DIR = path.join(os.homedir(), '.bandf', 'models');

// useFSCache stays on by default, so cache-hit reuse / download-on-miss is
// automatic once cacheDir points at the shared folder.
//
env.cacheDir = MODELS_DIR;

import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';

// Ensure the shared B&F HuggingFace models directory exists. The wider tool
// suite reads/writes this folder and every sibling module ensures it on install.
// Idempotent and non-fatal: a failure here must never break `yarn install` —
// the runtime ensures the directory again at startup.
//
const modelsDir = path.join(os.homedir(), '.bandf', 'models');

try {
    await fs.ensureDir(modelsDir);
    console.log(`bandf models dir ready: ${modelsDir}`);
} catch (error) {
    console.warn(`Could not create ${modelsDir}: ${error.message}`);
}

import fs from 'fs-extra';

// Reads a file for indexing, skipping anything that isn't an indexable text source:
// non-files, oversized files, and binaries (detected by NUL bytes / a high ratio of
// control characters in the first 4KB). Extracted from indexer.js.
//

export const MAX_INDEX_FILE_BYTES = 1_000_000;

export async function readIndexableText(abs) {
    const stat = await fs.stat(abs);
    if(!stat.isFile()) {
        return {skipped: true, reason: 'not_file'};
    }
    if(stat.size > MAX_INDEX_FILE_BYTES) {
        return {skipped: true, reason: 'too_large'};
    }

    const buffer = await fs.readFile(abs);
    if(looksBinary(buffer)) {
        return {skipped: true, reason: 'binary'};
    }
    return {skipped: false, content: buffer.toString('utf8')};
}

function looksBinary(buffer) {
    const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
    if(sample.includes(0)) {
        return true;
    }
    let suspicious = 0;
    for(const byte of sample) {
        if(byte === 9 || byte === 10 || byte === 13) {
            continue;
        }
        if(byte < 32 || byte === 127) {
            suspicious++;
        }
    }
    return sample.length > 0 && suspicious / sample.length > 0.08;
}

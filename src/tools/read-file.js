import {tool} from 'ai';
import {config} from '../util/config.js';
import {createSourceCorpusPolicy} from '../index/source-corpus-policy.js';
import {collectDependencyDocs, isVirtualDependencyPath} from '../index/dependency-docs.js';
import {buildLineSliceResult, readLineSlice, throwIfAborted} from '../util/source-read.js';
import {parseToolInput, readFileInputSchema} from './schemas.js';

// read_file(path, lineStart?, lineEnd?) — read a slice of a file from the indexed repo.
// Output is line-number-prefixed so the LLM can cite line ranges accurately.
//
export function createReadFileTool({root, exclude, repoIgnore}) {
    if(!root) throw new Error('createReadFileTool requires {root}');
    const sourcePolicy = createSourceCorpusPolicy({root, exclude, repoIgnore});
    const ignore = sourcePolicy.repoIgnore;

    return tool({
        description: 'Read a slice of a file from the indexed codebase, with line numbers prefixed. Use after search_codebase to inspect a promising match in full. Caps at 200 lines per call; chunk large files across multiple calls.',
        inputSchema: readFileInputSchema,
        execute: async (input, {abortSignal} = {}) => {
            const parsed = parseToolInput(readFileInputSchema, input);
            if(!parsed.ok) {
                return parsed.response;
            }
            const {path: relPath, lineStart, lineEnd} = parsed.input;
            throwIfAborted(abortSignal);
            if(isVirtualDependencyPath(relPath)) {
                return readVirtualDependencyDoc({root, repoIgnore: ignore, relPath, lineStart, lineEnd, abortSignal});
            }
            const checked = await sourcePolicy.checkPath(relPath);
            if(!checked.ok) {
                if(checked.reason === 'path_escape') {
                    return {error: 'path_escape', path: relPath};
                }
                return {error: 'path_excluded', path: checked.path || relPath, hint: exclusionHint(checked.reason)};
            }
            const physical = await sourcePolicy.resolvePhysicalPath(checked.path);
            throwIfAborted(abortSignal);
            if(!physical.ok) {
                return {error: physical.reason, path: checked.path};
            }

            return readLineSlice(physical.path, {
                path: checked.path,
                lineStart,
                lineEnd,
                maxLines: config.tools.readFileMaxLines,
                abortSignal
            });
        }
    });
}

function exclusionHint(reason) {
    if(reason === 'source_type_excluded') {
        return 'This path is not part of a supported source, config, surface, documentation, or dependency artifact corpus.';
    }
    if(reason === 'repo_ignored') {
        return 'This path is ignored by the repository ignore policy and is not part of the indexed codebase.';
    }
    return 'This path is not part of the indexed codebase. Use search_codebase or list_dir to find indexed files.';
}

async function readVirtualDependencyDoc({root, repoIgnore, relPath, lineStart, lineEnd, abortSignal}) {
    throwIfAborted(abortSignal);
    const docs = await collectDependencyDocs({root, repoIgnore});
    throwIfAborted(abortSignal);
    const doc = docs.find((item) => item.path === relPath);
    if(!doc) {
        return {error: 'not_found', path: relPath};
    }
    return buildLineSliceResult({
        path: relPath,
        text: doc.content,
        lineStart,
        lineEnd,
        maxLines: config.tools.readFileMaxLines
    });
}

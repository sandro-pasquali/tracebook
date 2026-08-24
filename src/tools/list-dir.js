import {tool} from 'ai';
import fs from 'fs-extra';
import {config} from '../util/config.js';
import {createSourceCorpusPolicy} from '../index/source-corpus-policy.js';
import {listDirInputSchema, parseToolInput} from './schemas.js';

// list_dir(path?) — list immediate children of a directory in the indexed repo.
// Respects the same exclude patterns as the indexer.
//
export function createListDirTool({root, exclude, repoIgnore}) {
    if(!root) throw new Error('createListDirTool requires {root}');
    const sourcePolicy = createSourceCorpusPolicy({root, exclude, repoIgnore});

    return tool({
        description: 'List immediate children (files and subdirectories) of a directory in the indexed codebase. Use to orient yourself in the repo structure before search/read.',
        inputSchema: listDirInputSchema,
        execute: async (input) => {
            const parsed = parseToolInput(listDirInputSchema, input);
            if(!parsed.ok) {
                return parsed.response;
            }
            const rel = parsed.input.path.replace(/\/+$/, '') || '.';
            const checked = await sourcePolicy.checkPath(rel, {isDirectory: true});
            if(!checked.ok) {
                if(checked.reason === 'path_escape') {
                    return {error: 'path_escape', path: rel};
                }
                return {error: 'path_excluded', path: checked.path || rel};
            }
            const physical = await sourcePolicy.resolvePhysicalPath(checked.path);
            if(!physical.ok) {
                return {error: physical.reason, path: checked.path};
            }

            const stat = await fs.stat(physical.path);
            if(!stat.isDirectory()) {
                return {error: 'not_a_directory', path: checked.path};
            }

            const entries = [];
            for(const entry of await fs.readdir(physical.path, {withFileTypes: true})) {
                if(entry.isSymbolicLink()) {
                    continue;
                }
                const relPath = checked.path === '.' ? entry.name : `${checked.path}/${entry.name}`;
                const entryCheck = await sourcePolicy.checkPath(relPath, {isDirectory: entry.isDirectory()});
                if(!entryCheck.ok) {
                    continue;
                }
                entries.push({
                    name: entry.name,
                    type: entry.isDirectory() ? 'dir' : 'file',
                    relPath: entryCheck.path
                });
            }

            const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
            const limited = sorted.slice(0, config.tools.listDirMaxEntries);

            return {
                path: checked.path,
                count: sorted.length,
                truncated: sorted.length > limited.length,
                entries: limited.map((entry) => ({
                    name: entry.name,
                    type: entry.type
                }))
            };
        }
    });
}

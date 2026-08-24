import {createSearchTool} from './search.js';
import {createReadFileTool} from './read-file.js';
import {createListDirTool} from './list-dir.js';
import {createGrepTool} from './grep.js';
import {createRepoIgnore} from '../util/repo-ignore.js';

// Bundle all retrieval tools for the planner's exploration phase.
//
export function createTools({embedder, store, root, include, exclude, reranker = null}) {
    const repoIgnore = createRepoIgnore({root});
    return {
        search_codebase: createSearchTool({embedder, store, reranker}),
        read_file: createReadFileTool({root, exclude, repoIgnore}),
        list_dir: createListDirTool({root, exclude, repoIgnore}),
        grep: createGrepTool({root, include, exclude, repoIgnore})
    };
}

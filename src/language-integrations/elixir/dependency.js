import path from 'node:path';
import {
    MAX_MANIFEST_FILES,
    dependencyLineDoc,
    findRepoFiles,
    readTextIfExists
} from '../dependency-core.js';
import {FUNCTIONAL_SOURCE_POLICY} from '../source-policies.js';

export const elixirDependency = {
    ecosystems: ['elixir', 'hex'],
    manifests: ['**/mix.exs', '**/mix.lock'],
    exclude: FUNCTIONAL_SOURCE_POLICY.exclude,
    collect: collectElixirDocs
};

async function collectElixirDocs(root, {repoIgnore, dependencyExclude = []} = {}) {
    const manifests = await findRepoFiles(root, ['**/mix.exs'], MAX_MANIFEST_FILES, repoIgnore, dependencyExclude);
    const docs = [];

    for(const manifestRel of manifests) {
        const text = await readTextIfExists(path.join(root, manifestRel), root);
        for(const dependency of parseMixDependencies(text)) {
            docs.push(dependencyLineDoc('hex', manifestRel, dependency.spec, dependency.group));
        }
    }

    return docs;
}

function parseMixDependencies(text) {
    const dependencies = [];
    const source = String(text || '');
    const depPattern = /\{\s*:([A-Za-z0-9_]+)\s*,\s*(?:"([^"]+)"|'([^']+)'|([^,\]}]+))/g;
    for(const match of source.matchAll(depPattern)) {
        const name = match[1];
        const version = (match[2] || match[3] || match[4] || '').trim();
        if(name) {
            dependencies.push({
                group: 'mix.deps',
                spec: [name, version].filter(Boolean).join(' ')
            });
        }
    }
    return dependencies;
}

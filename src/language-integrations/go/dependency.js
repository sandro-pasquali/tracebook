import path from 'node:path';
import {
    MAX_MANIFEST_FILES,
    dependencyLineDoc,
    findRepoFiles,
    readTextIfExists
} from '../dependency-core.js';
import {GO_SOURCE_POLICY} from '../source-policies.js';

export const goDependency = {
    ecosystems: ['go'],
    manifests: ['**/go.mod'],
    exclude: GO_SOURCE_POLICY.exclude,
    collect: collectGoDocs
};

async function collectGoDocs(root, {repoIgnore, dependencyExclude = []} = {}) {
    const manifests = await findRepoFiles(root, ['**/go.mod'], MAX_MANIFEST_FILES, repoIgnore, dependencyExclude);
    const docs = [];

    for(const manifestRel of manifests) {
        const text = await readTextIfExists(path.join(root, manifestRel), root);
        for(const dependency of parseGoModDependencies(text)) {
            docs.push(dependencyLineDoc('go', manifestRel, dependency.spec, dependency.group));
        }
    }

    return docs;
}

function parseGoModDependencies(text) {
    const dependencies = [];
    let blockGroup = '';

    for(const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.replace(/\/\/.*$/u, '').trim();
        if(!line) {
            continue;
        }

        const block = line.match(/^(require|replace|exclude)\s*\($/u);
        if(block) {
            blockGroup = block[1];
            continue;
        }

        if(line === ')') {
            blockGroup = '';
            continue;
        }

        const inline = line.match(/^(require|replace|exclude)\s+(.+)$/u);
        if(inline) {
            dependencies.push({group: inline[1], spec: inline[2].trim()});
            continue;
        }

        if(blockGroup) {
            dependencies.push({group: blockGroup, spec: line});
        }
    }

    return dependencies;
}

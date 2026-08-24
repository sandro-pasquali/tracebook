import path from 'node:path';
import {
    MAX_MANIFEST_FILES,
    dependencyLineDoc,
    findRepoFiles,
    isRuntimeDependencyGroup,
    readJson
} from '../dependency-core.js';
import {PHP_SOURCE_POLICY} from '../source-policies.js';

export const phpDependency = {
    ecosystems: ['php'],
    manifests: ['**/composer.json'],
    exclude: PHP_SOURCE_POLICY.exclude,
    collect: collectPhpDocs
};

async function collectPhpDocs(root, {repoIgnore, dependencyExclude = []} = {}) {
    const manifests = await findRepoFiles(root, ['**/composer.json'], MAX_MANIFEST_FILES, repoIgnore, dependencyExclude);
    const docs = [];

    for(const manifestRel of manifests) {
        const manifest = await readJson(path.join(root, manifestRel), root);
        if(!manifest || typeof manifest !== 'object') {
            continue;
        }

        for(const [group, dependencies] of phpDependencyGroups(manifest)) {
            if(!isRuntimeDependencyGroup(group)) {
                continue;
            }
            for(const [name, spec] of Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))) {
                docs.push(dependencyLineDoc('php', manifestRel, `${name} ${spec}`, group));
            }
        }
    }

    return docs;
}

function phpDependencyGroups(manifest) {
    return [
        ['require', manifest.require],
        ['require-dev', manifest['require-dev']],
        ['replace', manifest.replace],
        ['provide', manifest.provide]
    ].filter(([, dependencies]) => dependencies && typeof dependencies === 'object');
}

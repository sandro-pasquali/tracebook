import path from 'node:path';
import {
    MAX_MANIFEST_FILES,
    findRepoFiles,
    formatDependencyDoc,
    isRuntimeDependencyGroup,
    readTextIfExists,
    safeName,
    tomlInlineValue,
    tomlStringValue
} from '../dependency-core.js';
import {RUST_SOURCE_POLICY} from '../source-policies.js';

export const rustDependency = {
    ecosystems: ['rust'],
    manifests: ['**/Cargo.toml', '**/Cargo.lock'],
    exclude: RUST_SOURCE_POLICY.exclude,
    collect: collectRustDocs
};

async function collectRustDocs(root, {repoIgnore, dependencyExclude = []} = {}) {
    const manifests = await findRepoFiles(root, ['**/Cargo.toml'], MAX_MANIFEST_FILES, repoIgnore, dependencyExclude);
    const lockFiles = await findRepoFiles(root, ['**/Cargo.lock'], MAX_MANIFEST_FILES, repoIgnore, dependencyExclude);
    const lockedPackages = await collectLockedRustPackages(root, lockFiles);
    const docs = [];

    for(const manifestRel of manifests) {
        const text = await readTextIfExists(path.join(root, manifestRel), root);
        for(const dependency of extractCargoDependencies(text)) {
            if(!isRuntimeDependencyGroup(dependency.group)) {
                continue;
            }
            const installed = lockedPackages.get(dependency.name);
            docs.push({
                path: `__dependencies__/rust/${safeName(dependency.name)}.md`,
                content: formatDependencyDoc({
                    ecosystem: 'rust',
                    name: dependency.name,
                    spec: dependency.spec,
                    group: dependency.group,
                    manifest: manifestRel,
                    installed
                })
            });
        }
    }

    return docs;
}

function extractCargoDependencies(text) {
    const dependencies = [];
    let group = '';

    for(const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.replace(/\s+#.*$/u, '').trim();
        if(!line) {
            continue;
        }

        const section = line.match(/^\[([^\]]+)\]$/u);
        if(section) {
            group = cargoDependencyGroup(section[1]);
            continue;
        }

        if(!group) {
            continue;
        }

        const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u);
        if(match) {
            dependencies.push({
                name: match[1],
                spec: `${match[1]} = ${match[2].trim()}`,
                group
            });
        }
    }

    return dependencies;
}

function cargoDependencyGroup(section) {
    if(section === 'dependencies' || section === 'dev-dependencies' || section === 'build-dependencies') {
        return section;
    }
    const target = section.match(/^target\.[^.]+\.dependencies$/u);
    return target ? section : '';
}

async function collectLockedRustPackages(root, lockFiles) {
    const packages = new Map();

    for(const lockFile of lockFiles) {
        const text = await readTextIfExists(path.join(root, lockFile), root);
        for(const item of parseCargoLock(text)) {
            if(item.name && !packages.has(item.name)) {
                packages.set(item.name, {
                    version: item.version,
                    repository: item.source
                });
            }
        }
    }

    return packages;
}

function parseCargoLock(text) {
    const packages = [];
    for(const block of String(text || '').split('[[package]]').slice(1)) {
        const name = tomlStringValue(block, 'name');
        const version = tomlStringValue(block, 'version');
        const source = tomlStringValue(block, 'source') || tomlInlineValue(block, 'source');
        if(name) {
            packages.push({name, version, source});
        }
    }
    return packages;
}

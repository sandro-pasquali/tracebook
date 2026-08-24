import path from 'node:path';
import {
    MAX_MANIFEST_FILES,
    dependencyLineDoc,
    findRepoFiles,
    readJson,
    readTextIfExists
} from '../dependency-core.js';
import {C_LIKE_SOURCE_POLICY} from '../source-policies.js';

export const nativeDependency = {
    ecosystems: ['native', 'cmake', 'conan', 'vcpkg'],
    manifests: ['**/CMakeLists.txt', '**/vcpkg.json', '**/conanfile.txt', '**/conanfile.py'],
    exclude: C_LIKE_SOURCE_POLICY.exclude,
    collect: collectNativeDocs
};

async function collectNativeDocs(root, {repoIgnore, dependencyExclude = []} = {}) {
    const manifests = await findRepoFiles(root, nativeDependency.manifests, MAX_MANIFEST_FILES, repoIgnore, dependencyExclude);
    const docs = [];

    for(const manifestRel of manifests) {
        const dependencies = manifestRel.endsWith('vcpkg.json')
            ? await parseVcpkgDependencies(path.join(root, manifestRel), root)
            : parseNativeTextDependencies(await readTextIfExists(path.join(root, manifestRel), root), manifestRel);
        for(const dependency of dependencies) {
            docs.push(dependencyLineDoc('native', manifestRel, dependency.spec, dependency.group));
        }
    }

    return docs;
}

async function parseVcpkgDependencies(file, root) {
    const manifest = await readJson(file, root);
    const dependencies = Array.isArray(manifest?.dependencies) ? manifest.dependencies : [];
    return dependencies.map((entry) => {
        if(typeof entry === 'string') {
            return {group: 'vcpkg.dependencies', spec: entry};
        }
        return {group: 'vcpkg.dependencies', spec: [entry?.name, entry?.version].filter(Boolean).join(' ')};
    }).filter((item) => item.spec);
}

function parseNativeTextDependencies(text, manifestRel) {
    if(manifestRel.endsWith('CMakeLists.txt')) {
        return parseCmakeDependencies(text);
    }
    return parseConanDependencies(text);
}

function parseCmakeDependencies(text) {
    const dependencies = [];
    for(const match of String(text || '').matchAll(/\bfind_package\s*\(\s*([A-Za-z0-9_.:+-]+)/g)) {
        dependencies.push({group: 'cmake.find_package', spec: match[1]});
    }
    for(const match of String(text || '').matchAll(/\btarget_link_libraries\s*\(([^)]+)\)/g)) {
        const libs = match[1].split(/\s+/u)
            .map((item) => item.trim())
            .filter((item) => item && !CMAKE_LINK_KEYWORDS.has(item))
            .slice(1);
        for(const lib of libs) {
            dependencies.push({group: 'cmake.target_link_libraries', spec: lib});
        }
    }
    return dependencies;
}

function parseConanDependencies(text) {
    const dependencies = [];
    let inRequires = false;
    for(const rawLine of String(text || '').split(/\r?\n/u)) {
        const line = rawLine.trim();
        if(!line || line.startsWith('#')) {
            continue;
        }
        const section = line.match(/^\[([^\]]+)\]$/u);
        if(section) {
            inRequires = section[1] === 'requires';
            continue;
        }
        if(inRequires || /\brequires\s*=\s*/u.test(line)) {
            const match = line.match(/["']?([A-Za-z0-9_.+-]+\/[^"',\s\]]+)/u);
            if(match) {
                dependencies.push({group: 'conan.requires', spec: match[1]});
            }
        }
    }
    return dependencies;
}

const CMAKE_LINK_KEYWORDS = new Set(['PRIVATE', 'PUBLIC', 'INTERFACE', 'debug', 'optimized', 'general']);

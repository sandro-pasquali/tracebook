import path from 'node:path';
import {
    MAX_MANIFEST_FILES,
    dependencyLineDoc,
    findRepoFiles,
    readJson,
    readTextIfExists,
    xmlTag
} from '../dependency-core.js';
import {DOTNET_SOURCE_POLICY} from '../source-policies.js';

export const dotnetDependency = {
    ecosystems: ['dotnet', 'nuget'],
    manifests: ['**/*.csproj', '**/Directory.Packages.props', '**/packages.lock.json'],
    exclude: DOTNET_SOURCE_POLICY.exclude,
    collect: collectDotnetDocs
};

async function collectDotnetDocs(root, {repoIgnore, dependencyExclude = []} = {}) {
    const manifests = await findRepoFiles(
        root,
        dotnetDependency.manifests,
        MAX_MANIFEST_FILES,
        repoIgnore,
        dependencyExclude
    );
    const docs = [];

    for(const manifestRel of manifests) {
        const file = path.join(root, manifestRel);
        const dependencies = manifestRel.endsWith('packages.lock.json')
            ? await parsePackagesLock(file, root)
            : parseProjectDependencies(await readTextIfExists(file, root), manifestRel);
        for(const dependency of dependencies) {
            docs.push(dependencyLineDoc('nuget', manifestRel, dependency.spec, dependency.group));
        }
    }

    return docs;
}

function parseProjectDependencies(text, manifestRel) {
    const dependencies = [];
    const source = String(text || '');
    const packageReferencePattern = /<PackageReference\b([^>]*)\/>|<PackageReference\b([^>]*)>([\s\S]*?)<\/PackageReference>/g;
    for(const match of source.matchAll(packageReferencePattern)) {
        const attrs = match[1] || match[2] || '';
        const body = match[3] || '';
        const name = xmlAttribute(attrs, 'Include') || xmlAttribute(attrs, 'Update') || xmlTag(body, 'Include');
        const version = xmlAttribute(attrs, 'Version') || xmlTag(body, 'Version');
        if(name) {
            dependencies.push({
                group: 'PackageReference',
                spec: [name, version].filter(Boolean).join(' ')
            });
        }
    }

    const packageVersionPattern = /<PackageVersion\b([^>]*)\/>|<PackageVersion\b([^>]*)>([\s\S]*?)<\/PackageVersion>/g;
    for(const match of source.matchAll(packageVersionPattern)) {
        const attrs = match[1] || match[2] || '';
        const body = match[3] || '';
        const name = xmlAttribute(attrs, 'Include') || xmlAttribute(attrs, 'Update') || xmlTag(body, 'Include');
        const version = xmlAttribute(attrs, 'Version') || xmlTag(body, 'Version');
        if(name) {
            dependencies.push({
                group: manifestRel.endsWith('Directory.Packages.props') ? 'Directory.Packages.props' : 'PackageVersion',
                spec: [name, version].filter(Boolean).join(' ')
            });
        }
    }

    return dependencies;
}

async function parsePackagesLock(file, root) {
    const manifest = await readJson(file, root);
    const dependencies = [];
    const targets = manifest?.dependencies && typeof manifest.dependencies === 'object'
        ? manifest.dependencies
        : {};
    for(const [target, packages] of Object.entries(targets)) {
        if(!packages || typeof packages !== 'object') {
            continue;
        }
        for(const [name, info] of Object.entries(packages)) {
            if(!info || typeof info !== 'object') {
                continue;
            }
            dependencies.push({
                group: `packages.lock:${info.type || target}`,
                spec: [name, info.resolved || info.requested].filter(Boolean).join(' ')
            });
        }
    }
    return dependencies;
}

function xmlAttribute(attrs, name) {
    const match = String(attrs || '').match(new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`, 'u'))
        || String(attrs || '').match(new RegExp(`\\b${name}\\s*=\\s*'([^']+)'`, 'u'));
    return match ? match[1].trim() : '';
}

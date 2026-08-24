import path from 'node:path';
import {
    MAX_MANIFEST_FILES,
    README_NAMES,
    VIRTUAL_DEP_PREFIX,
    codeSpan,
    compactMarkdownLines,
    fencedBlock,
    findRepoFiles,
    formatDependencyDoc,
    inlineList,
    isRuntimeDependencyGroup,
    markdownTable,
    readFirstExisting,
    readJson,
    repositoryUrl,
    safeName,
    structuredBlock,
    uniqueStrings
} from '../dependency-core.js';
import {JAVASCRIPT_SOURCE_POLICY} from '../source-policies.js';

export const javascriptDependency = {
    ecosystems: ['npm'],
    manifests: ['**/package.json'],
    exclude: JAVASCRIPT_SOURCE_POLICY.exclude,
    collect: collectNpmDocs
};

async function collectNpmDocs(root, {repoIgnore, dependencyExclude = []} = {}) {
    const manifests = await findRepoFiles(root, ['**/package.json'], MAX_MANIFEST_FILES, repoIgnore, dependencyExclude);
    const docs = [];

    for(const manifestRel of manifests) {
        const manifestPath = path.join(root, manifestRel);
        const manifest = await readJson(manifestPath, root);
        if(!manifest || typeof manifest !== 'object') {
            continue;
        }

        docs.push({
            path: npmManifestDocPath(manifestRel, manifests.length),
            content: formatNpmManifestDoc(manifestRel, manifest)
        });

        for(const [group, dependencies] of npmDependencyGroups(manifest)) {
            if(!isRuntimeDependencyGroup(group)) {
                continue;
            }
            for(const [name, spec] of Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))) {
                const installed = await readInstalledNpmPackage(root, manifestRel, name);
                docs.push({
                    path: `${VIRTUAL_DEP_PREFIX}npm/${safeName(name)}.md`,
                    content: formatDependencyDoc({
                        ecosystem: 'npm',
                        name,
                        spec,
                        group,
                        manifest: manifestRel,
                        installed
                    })
                });
            }
        }
    }

    return docs;
}

function npmManifestDocPath(manifestRel, count) {
    if(count === 1 || manifestRel === 'package.json') {
        return `${VIRTUAL_DEP_PREFIX}npm/manifest.md`;
    }
    return `${VIRTUAL_DEP_PREFIX}npm/manifest-${safeName(manifestRel)}.md`;
}

function formatNpmManifestDoc(manifestRel, manifest) {
    const lines = [
        '# Dependency manifest: npm package.json',
        '',
        '## Project',
        '',
        ...markdownTable([
            ['Manifest', codeSpan(manifestRel)],
            ['Name', codeSpan(manifest.name)],
            ['Version', codeSpan(manifest.version)],
            ['Description', manifest.description],
            ['Package manager', codeSpan(manifest.packageManager)],
            ['Module type', codeSpan(manifest.type)],
            ['Workspaces', inlineList(manifest.workspaces)]
        ])
    ];

    const groupRows = npmDependencyGroups(manifest).map(([group, dependencies]) => [
        group,
        codeSpan(Object.keys(dependencies).length),
        inlineList(Object.keys(dependencies).sort())
    ]);
    if(groupRows.length > 0) {
        lines.push('', '## Declared Dependency Groups', '', ...dependencyGroupTable(groupRows));
    }

    lines.push(...structuredBlock('Engines', manifest.engines));
    lines.push(...structuredBlock('Package exports', manifest.exports));

    if(manifest.scripts && typeof manifest.scripts === 'object') {
        lines.push('', '## Scripts');
        for(const [name, command] of Object.entries(manifest.scripts).sort(([a], [b]) => a.localeCompare(b))) {
            lines.push('', `### ${name}`, '', ...fencedBlock('sh', command));
        }
    }

    return compactMarkdownLines(lines).join('\n');
}

function dependencyGroupTable(rows) {
    return [
        '| Group | Count | Packages |',
        '| --- | --- | --- |',
        ...rows.map(([group, count, packages]) => `| ${group} | ${count} | ${packages} |`)
    ];
}

function npmDependencyGroups(manifest) {
    return [
        ['dependencies', manifest.dependencies],
        ['devDependencies', manifest.devDependencies],
        ['peerDependencies', manifest.peerDependencies],
        ['optionalDependencies', manifest.optionalDependencies]
    ].filter(([, dependencies]) => dependencies && typeof dependencies === 'object');
}

async function readInstalledNpmPackage(root, manifestRel, name) {
    const manifestDir = path.dirname(manifestRel);
    const packageParts = name.split('/');
    const roots = uniqueStrings([
        path.join(root, manifestDir, 'node_modules', ...packageParts),
        path.join(root, 'node_modules', ...packageParts)
    ]);

    for(const packageRoot of roots) {
        const packageJson = await readJson(path.join(packageRoot, 'package.json'), root);
        if(!packageJson || typeof packageJson !== 'object') {
            continue;
        }

        return {
            version: packageJson.version,
            description: packageJson.description,
            keywords: packageJson.keywords,
            homepage: packageJson.homepage,
            repository: repositoryUrl(packageJson.repository),
            license: packageJson.license,
            main: packageJson.main,
            module: packageJson.module,
            types: packageJson.types || packageJson.typings,
            exports: packageJson.exports,
            bin: packageJson.bin,
            readme: await readFirstExisting(packageRoot, README_NAMES, root)
        };
    }

    return null;
}

import path from 'node:path';
import {
    MAX_MANIFEST_FILES,
    dependencyLineDoc,
    findRepoFiles,
    readTextIfExists,
    xmlTag
} from '../dependency-core.js';
import {JVM_SOURCE_POLICY} from '../source-policies.js';

export const javaDependency = {
    ecosystems: ['java', 'jvm'],
    manifests: ['**/pom.xml', '**/build.gradle', '**/build.gradle.kts', '**/settings.gradle', '**/build.sbt', '**/project/*.sbt'],
    exclude: JVM_SOURCE_POLICY.exclude,
    collect: collectJavaDocs
};

async function collectJavaDocs(root, {repoIgnore, dependencyExclude = []} = {}) {
    const manifests = await findRepoFiles(root, ['**/pom.xml', '**/build.gradle', '**/build.gradle.kts', '**/build.sbt', '**/project/*.sbt'], MAX_MANIFEST_FILES, repoIgnore, dependencyExclude);
    const docs = [];

    for(const manifestRel of manifests) {
        const text = await readTextIfExists(path.join(root, manifestRel), root);
        const dependencies = dependenciesForManifest(manifestRel, text);
        for(const dependency of dependencies) {
            docs.push(dependencyLineDoc('jvm', manifestRel, dependency.spec, dependency.group));
        }
    }

    return docs;
}

function dependenciesForManifest(manifestRel, text) {
    if(manifestRel.endsWith('pom.xml')) {
        return parseMavenDependencies(text);
    }
    if(manifestRel.endsWith('.sbt')) {
        return parseSbtDependencies(text);
    }
    return parseGradleDependencies(text);
}

function parseMavenDependencies(text) {
    const dependencies = [];
    for(const match of String(text || '').matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
        const block = match[1];
        const groupId = xmlTag(block, 'groupId');
        const artifactId = xmlTag(block, 'artifactId');
        if(!groupId || !artifactId) {
            continue;
        }

        const version = xmlTag(block, 'version');
        const scope = xmlTag(block, 'scope') || 'compile';
        dependencies.push({
            group: `maven:${scope}`,
            spec: [groupId, artifactId, version].filter(Boolean).join(':')
        });
    }
    return dependencies;
}

function parseGradleDependencies(text) {
    const dependencies = [];
    for(const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.replace(/\/\/.*$/u, '').trim();
        if(!line) {
            continue;
        }

        const stringNotation = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*\(?\s*['"]([^'"]+)['"]/u);
        if(stringNotation) {
            dependencies.push({
                group: `gradle:${stringNotation[1]}`,
                spec: stringNotation[2]
            });
            continue;
        }

        const mapNotation = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*\(?\s*(.+)$/u);
        if(mapNotation) {
            const spec = gradleMapDependencySpec(mapNotation[2]);
            if(spec) {
                dependencies.push({
                    group: `gradle:${mapNotation[1]}`,
                    spec
                });
            }
        }
    }

    return dependencies;
}

function gradleMapDependencySpec(text) {
    const parts = new Map();
    for(const match of String(text || '').matchAll(/([A-Za-z]+)\s*:\s*['"]([^'"]+)['"]/g)) {
        parts.set(match[1], match[2]);
    }

    const group = parts.get('group');
    const name = parts.get('name');
    if(!group || !name) {
        return '';
    }

    return [group, name, parts.get('version')].filter(Boolean).join(':');
}

function parseSbtDependencies(text) {
    const dependencies = [];
    const pattern = /"([^"]+)"\s+%%?\s+"([^"]+)"\s+%\s+"([^"]+)"/g;
    for(const match of String(text || '').matchAll(pattern)) {
        dependencies.push({
            group: 'sbt:libraryDependencies',
            spec: [match[1], match[2], match[3]].join(':')
        });
    }
    return dependencies;
}

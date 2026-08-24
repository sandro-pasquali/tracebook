import fs from 'fs-extra';
import path from 'node:path';
import {
    MAX_MANIFEST_FILES,
    dependencyNameFromSpec,
    findRepoFiles,
    formatDependencyDoc,
    isInsideRoot,
    isRuntimeDependencyGroup,
    readTextIfExists,
    safeName,
    splitKeywords,
    splitList
} from '../dependency-core.js';
import {PYTHON_SOURCE_POLICY} from '../source-policies.js';

export const pythonDependency = {
    ecosystems: ['python'],
    manifests: ['**/pyproject.toml', '**/requirements*.txt'],
    exclude: PYTHON_SOURCE_POLICY.exclude,
    collect: collectPythonDocs
};

const MAX_SITE_PACKAGES_ENTRIES = 5000;

async function collectPythonDocs(root, {repoIgnore, dependencyExclude = []} = {}) {
    const installed = await collectPythonInstalledMetadata(root);
    const docs = [];

    const pyprojects = await findRepoFiles(root, ['**/pyproject.toml'], MAX_MANIFEST_FILES, repoIgnore, dependencyExclude);
    for(const manifestRel of pyprojects) {
        const text = await readTextIfExists(path.join(root, manifestRel), root);
        for(const dependency of extractPyprojectDependencies(text)) {
            if(!isRuntimeDependencyGroup(dependency.group)) {
                continue;
            }
            docs.push(pythonDependencyDoc(manifestRel, dependency.spec, dependency.group, installed));
        }
    }

    const requirements = await findRepoFiles(root, ['**/requirements*.txt'], MAX_MANIFEST_FILES, repoIgnore, dependencyExclude);
    for(const manifestRel of requirements) {
        const text = await readTextIfExists(path.join(root, manifestRel), root);
        for(const line of String(text || '').split(/\r?\n/)) {
            const spec = cleanRequirementLine(line);
            if(spec) {
                docs.push(pythonDependencyDoc(manifestRel, spec, 'requirements', installed));
            }
        }
    }

    return docs;
}

function extractPyprojectDependencies(text) {
    const content = String(text || '');
    const dependencies = [];
    const projectSection = tomlSection(content, 'project');
    for(const spec of readTomlStringArray(projectSection, 'dependencies')) {
        dependencies.push({spec, group: 'project.dependencies'});
    }

    const optionalSection = tomlSection(content, 'project.optional-dependencies');
    for(const [group, specs] of readTomlArrayAssignments(optionalSection)) {
        for(const spec of specs) {
            dependencies.push({spec, group: `project.optional-dependencies.${group}`});
        }
    }

    const poetrySection = tomlSection(content, 'tool.poetry.dependencies');
    for(const [name, spec] of readTomlDependencyAssignments(poetrySection)) {
        if(name.toLowerCase() !== 'python') {
            dependencies.push({spec: `${name} ${spec}`.trim(), group: 'tool.poetry.dependencies'});
        }
    }

    const poetryDevSection = tomlSection(content, 'tool.poetry.group.dev.dependencies') || tomlSection(content, 'tool.poetry.dev-dependencies');
    for(const [name, spec] of readTomlDependencyAssignments(poetryDevSection)) {
        dependencies.push({spec: `${name} ${spec}`.trim(), group: 'tool.poetry.dev-dependencies'});
    }

    return dependencies;
}

function tomlSection(text, name) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(text || '').match(new RegExp(`^\\[${escapedName}\\]\\s*$([\\s\\S]*?)(?=^\\[[^\\]]+\\]\\s*$|(?![\\s\\S]))`, 'm'));
    return match ? match[1] : '';
}

function readTomlStringArray(section, key) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(section || '').match(new RegExp(`^${escapedKey}\\s*=\\s*\\[([\\s\\S]*?)]`, 'm'));
    return match ? quotedTomlStrings(match[1]) : [];
}

function readTomlArrayAssignments(section) {
    const assignments = [];
    const text = String(section || '');
    const pattern = /^([A-Za-z0-9_.-]+)\s*=\s*\[([\s\S]*?)]/gm;
    for(const match of text.matchAll(pattern)) {
        assignments.push([match[1], quotedTomlStrings(match[2])]);
    }
    return assignments;
}

function quotedTomlStrings(text) {
    return [...String(text || '').matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'/g)]
        .map((match) => (match[1] || match[2] || '').trim())
        .filter(Boolean);
}

function readTomlDependencyAssignments(section) {
    const dependencies = [];
    for(const rawLine of String(section || '').split(/\r?\n/)) {
        const line = rawLine.replace(/\s+#.*$/u, '').trim();
        const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/u);
        if(match) {
            dependencies.push([match[1], normalizeTomlDependencySpec(match[2])]);
        }
    }
    return dependencies;
}

function normalizeTomlDependencySpec(value) {
    const text = String(value || '').trim();
    const version = text.match(/version\s*=\s*"([^"]+)"/u) || text.match(/version\s*=\s*'([^']+)'/u);
    if(version) {
        return version[1];
    }
    const quoted = text.match(/^"([^"]+)"$/u) || text.match(/^'([^']+)'$/u);
    return quoted ? quoted[1] : text;
}

function cleanRequirementLine(line) {
    const trimmed = String(line || '').trim();
    if(!trimmed || trimmed.startsWith('#')) {
        return '';
    }
    if(trimmed.startsWith('-e ')) {
        return trimmed.slice(3).trim();
    }
    if(trimmed.startsWith('-') || trimmed.startsWith('--')) {
        return '';
    }
    return trimmed.replace(/\s+#.*$/u, '').trim();
}

function pythonDependencyDoc(manifest, spec, group, installedPackages) {
    const name = dependencyNameFromSpec(spec);
    const installed = installedPackages.get(normalizePythonName(name));
    return {
        path: `__dependencies__/python/${safeName(name)}.md`,
        content: formatDependencyDoc({
            ecosystem: 'python',
            name,
            spec,
            group,
            manifest,
            installed
        })
    };
}

async function collectPythonInstalledMetadata(root) {
    const sitePackages = await findPythonSitePackageDirs(root);
    const packages = new Map();

    for(const dir of sitePackages) {
        let entries = [];
        try {
            entries = await fs.readdir(dir, {withFileTypes: true});
        } catch {
            continue;
        }

        for(const entry of entries.slice(0, MAX_SITE_PACKAGES_ENTRIES)) {
            if(!entry.isDirectory() || !/[.-](?:dist|egg)-info$/u.test(entry.name)) {
                continue;
            }

            const metadataRoot = path.join(dir, entry.name);
            const metadataText = await readTextIfExists(path.join(metadataRoot, 'METADATA'), root)
                || await readTextIfExists(path.join(metadataRoot, 'PKG-INFO'), root);
            if(!metadataText) {
                continue;
            }

            const metadata = parsePythonMetadata(metadataText);
            const name = metadata.name || normalizeDistInfoName(entry.name);
            const key = normalizePythonName(name);
            if(key && !packages.has(key)) {
                packages.set(key, {...metadata, name});
            }
        }
    }

    return packages;
}

async function findPythonSitePackageDirs(root) {
    const candidates = [
        '.venv/lib',
        'venv/lib',
        'env/lib',
        '.venv/Lib',
        'venv/Lib',
        'env/Lib'
    ].map((rel) => path.join(root, rel));
    const dirs = [];

    for(const candidate of candidates) {
        await collectSitePackageDirs(root, candidate, dirs, 0);
    }

    return [...new Set(dirs)];
}

async function collectSitePackageDirs(root, dir, out, depth) {
    if(depth > 4 || !isInsideRoot(root, dir)) {
        return;
    }

    let stat;
    try {
        stat = await fs.stat(dir);
    } catch {
        return;
    }
    if(!stat.isDirectory()) {
        return;
    }

    const basename = path.basename(dir);
    if(basename === 'site-packages' || basename === 'dist-packages') {
        out.push(dir);
        return;
    }

    let entries = [];
    try {
        entries = await fs.readdir(dir, {withFileTypes: true});
    } catch {
        return;
    }

    for(const entry of entries.filter((item) => item.isDirectory()).slice(0, 200)) {
        if(entry.name === 'site-packages' || entry.name === 'dist-packages' || /^python\d/u.test(entry.name)) {
            await collectSitePackageDirs(root, path.join(dir, entry.name), out, depth + 1);
        }
    }
}

function parsePythonMetadata(text) {
    const fields = new Map();
    let currentKey = '';

    for(const line of String(text || '').split(/\r?\n/)) {
        if(/^\s/.test(line) && currentKey) {
            fields.set(currentKey, `${fields.get(currentKey)} ${line.trim()}`.trim());
            continue;
        }

        const match = line.match(/^([^:]+):\s*(.*)$/u);
        if(!match) {
            continue;
        }

        currentKey = match[1].toLowerCase();
        if(currentKey === 'requires-dist') {
            const values = fields.get(currentKey) || [];
            values.push(match[2]);
            fields.set(currentKey, values);
        } else if(!fields.has(currentKey)) {
            fields.set(currentKey, match[2]);
        }
    }

    return {
        name: fields.get('name'),
        version: fields.get('version'),
        description: fields.get('summary'),
        homepage: fields.get('home-page') || projectUrl(fields.get('project-url')),
        license: fields.get('license'),
        keywords: splitKeywords(fields.get('keywords')),
        requiresPython: fields.get('requires-python'),
        requiresDist: splitList((fields.get('requires-dist') || []).join('; '))
    };
}

function projectUrl(value) {
    const parts = String(value || '').split(',');
    return parts.length > 1 ? parts.slice(1).join(',').trim() : '';
}

function normalizePythonName(name) {
    return String(name || '').toLowerCase().replace(/[-_.]+/g, '-');
}

function normalizeDistInfoName(name) {
    return String(name || '').replace(/[.-](?:dist|egg)-info$/u, '').replace(/-\d.*$/u, '');
}

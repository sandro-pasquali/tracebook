import {integration as bash} from './bash/index.js';
import {integration as c} from './c/index.js';
import {integration as cpp} from './cpp/index.js';
import {integration as cSharp} from './c-sharp/index.js';
import {integration as css} from './css/index.js';
import {integration as elisp} from './elisp/index.js';
import {integration as elixir} from './elixir/index.js';
import {integration as go} from './go/index.js';
import {integration as html} from './html/index.js';
import {integration as java} from './java/index.js';
import {integration as javascript} from './javascript/index.js';
import {integration as json} from './json/index.js';
import {integration as kotlin} from './kotlin/index.js';
import {integration as lua} from './lua/index.js';
import {integration as objc} from './objc/index.js';
import {integration as ocaml} from './ocaml/index.js';
import {integration as php} from './php/index.js';
import {integration as python} from './python/index.js';
import {integration as rescript} from './rescript/index.js';
import {integration as rust} from './rust/index.js';
import {integration as scala} from './scala/index.js';
import {integration as solidity} from './solidity/index.js';
import {integration as systemrdl} from './systemrdl/index.js';
import {integration as tlaplus} from './tlaplus/index.js';
import {integration as toml} from './toml/index.js';
import {integration as tsx} from './tsx/index.js';
import {integration as typescript} from './typescript/index.js';
import {integration as yaml} from './yaml/index.js';
import {integration as zig} from './zig/index.js';
import {createLanguageIntegration} from './common.js';
import {SHARED_REPO_ARTIFACTS, SHARED_REPO_ARTIFACT_EXCLUDE} from './shared-artifacts.js';
import {pathExcluded} from '../util/path-filter.js';

const RAW_LANGUAGE_INTEGRATIONS = [
    bash,
    c,
    cpp,
    cSharp,
    css,
    elisp,
    elixir,
    go,
    html,
    java,
    javascript,
    json,
    kotlin,
    lua,
    objc,
    ocaml,
    php,
    python,
    rescript,
    rust,
    scala,
    solidity,
    systemrdl,
    tlaplus,
    toml,
    tsx,
    typescript,
    yaml,
    zig
];

export const LANGUAGE_INTEGRATIONS = Object.freeze(
    RAW_LANGUAGE_INTEGRATIONS.map((integration) => createLanguageIntegration(integration))
);

export const SUPPORTED_TREE_SITTER_GRAMMARS = new Set(LANGUAGE_INTEGRATIONS.map((integration) => integration.grammar));

const BY_ALIAS = new Map();
const BY_EXTENSION = new Map();
const BY_FILENAME = new Map();
const SOURCE_FILENAMES = new Set();

for(const integration of LANGUAGE_INTEGRATIONS) {
    for(const alias of integration.aliases || []) {
        BY_ALIAS.set(normalizeLanguage(alias), integration);
    }
    for(const extension of integration.extensions || []) {
        BY_EXTENSION.set(extension.toLowerCase(), integration);
    }
    for(const filename of integration.filenames || []) {
        BY_FILENAME.set(filename.toLowerCase(), integration);
        SOURCE_FILENAMES.add(filename);
    }
}

export const SUPPORTED_SOURCE_EXTENSIONS = [...BY_EXTENSION.keys()]
    .map((extension) => extension.replace(/^\./, ''))
    .sort();

export const SUPPORTED_SOURCE_FILENAMES = [...SOURCE_FILENAMES].sort();

export const DEFAULT_SUPPORTED_SOURCE_GLOB = `**/*.{${SUPPORTED_SOURCE_EXTENSIONS.join(',')}}`;

export const DEFAULT_SUPPORTED_FILENAME_GLOBS = SUPPORTED_SOURCE_FILENAMES.map((filename) => `**/${filename}`);

export const DEFAULT_SUPPORTED_SOURCE_GLOBS = uniqueStrings(
    LANGUAGE_INTEGRATIONS.flatMap((integration) => integration.source?.include || [])
);

export const DEFAULT_REPO_ARTIFACT_GLOBS = uniqueStrings(
    SHARED_REPO_ARTIFACTS.map((artifact) => artifact.glob)
);

export const DEFAULT_LANGUAGE_SOURCE_EXCLUDE = uniqueStrings(
    [
        ...LANGUAGE_INTEGRATIONS.flatMap((integration) => integration.source?.exclude || []),
        ...SHARED_REPO_ARTIFACT_EXCLUDE
    ]
);

export const DEPENDENCY_MANIFEST_GLOBS = uniqueStrings(
    LANGUAGE_INTEGRATIONS.flatMap((integration) => integration.dependency?.manifests || [])
);

export const DEPENDENCY_EXCLUDE_GLOBS = uniqueStrings(
    LANGUAGE_INTEGRATIONS.flatMap((integration) => integration.dependency?.exclude || [])
);

export const REPO_SUPPORTING_FILES = Object.freeze(
    [
        ...SHARED_REPO_ARTIFACTS.map((artifact) => ({
            ...artifact,
            integration: 'shared-artifact'
        })),
        ...DEPENDENCY_MANIFEST_GLOBS.map((glob) => ({
            glob,
            role: 'manifest',
            terms: uniqueStrings(['dependency', 'manifest', 'package', ...termsFromGlob(glob)]),
            integration: 'dependency-manifest'
        })),
        ...LANGUAGE_INTEGRATIONS.flatMap((integration) => (integration.repo?.supportingFiles || []).map((file) => ({
            ...file,
            integration: integration.id
        })))
    ]
);

export const REPO_SUPPORTING_FILE_GLOBS = uniqueStrings(
    REPO_SUPPORTING_FILES.map((file) => file.glob)
);

export const REPO_SUPPORT_QUERY_TERMS = uniqueStrings(
    [
        ...SHARED_REPO_ARTIFACTS.flatMap((artifact) => artifact.terms || []),
        'dependency',
        'dependencies',
        'manifest',
        'package',
        'config',
        'configuration',
        'installed',
        'version',
        'repository',
        'exports',
        'types',
        ...LANGUAGE_INTEGRATIONS.flatMap((integration) => [
            ...(integration.repo?.questionTerms || []),
            ...(integration.repo?.evidenceTerms || []),
            ...(integration.repo?.supportingFiles || []).flatMap((file) => file.terms || [])
        ])
    ]
);

export function resolveLanguageIntegration(context = {}) {
    const language = normalizeLanguage(context.language);
    if(language && BY_ALIAS.has(language)) {
        return BY_ALIAS.get(language);
    }

    const filePath = String(context.path || '');
    const filename = filePath.split(/[\\/]/).pop()?.toLowerCase() || '';
    if(filename && BY_FILENAME.has(filename)) {
        return BY_FILENAME.get(filename);
    }

    const extension = extensionFromPath(filePath);
    return extension ? BY_EXTENSION.get(extension) || null : null;
}

export function sourcePathExcludedByIntegration(relPath, {isDirectory = false} = {}) {
    const pathValue = normalizeRepoPath(relPath);
    if(!pathValue || pathValue === '.') {
        return false;
    }

    if(isDirectory) {
        return pathExcluded(pathValue, DEFAULT_LANGUAGE_SOURCE_EXCLUDE);
    }

    if(isRepoArtifactPath(pathValue) || isRepoSupportingPath(pathValue)) {
        return pathExcluded(pathValue, DEFAULT_LANGUAGE_SOURCE_EXCLUDE);
    }

    const integration = resolveLanguageIntegration({path: pathValue});
    if(!integration) {
        return true;
    }
    return pathExcluded(pathValue, integration.source?.exclude || []);
}

export function isSupportedSourcePath(relPath) {
    const pathValue = normalizeRepoPath(relPath);
    return Boolean(pathValue && resolveLanguageIntegration({path: pathValue}));
}

export function isRepoArtifactPath(relPath) {
    const pathValue = normalizeRepoPath(relPath);
    if(!pathValue) {
        return false;
    }
    return SHARED_REPO_ARTIFACTS.some((artifact) => pathExcluded(pathValue, [artifact.glob]));
}

export function isDependencyManifestPath(relPath) {
    const pathValue = normalizeRepoPath(relPath);
    if(!pathValue) {
        return false;
    }
    return DEPENDENCY_MANIFEST_GLOBS.some((glob) => pathExcluded(pathValue, [glob]));
}

export function isRepoSupportingPath(relPath) {
    const pathValue = normalizeRepoPath(relPath);
    if(!pathValue) {
        return false;
    }
    if(isDependencyManifestPath(pathValue) || isRepoArtifactPath(pathValue)) {
        return true;
    }
    const integration = resolveLanguageIntegration({path: pathValue});
    if(integration?.category === 'config') {
        return true;
    }
    return REPO_SUPPORTING_FILES.some((file) => pathExcluded(pathValue, [file.glob]));
}

export function roleForRepoSupportingPath(relPath) {
    const pathValue = normalizeRepoPath(relPath);
    if(!pathValue) {
        return '';
    }
    if(isDependencyManifestPath(pathValue)) {
        return 'manifest';
    }
    const artifactRole = SHARED_REPO_ARTIFACTS.find((artifact) => pathExcluded(pathValue, [artifact.glob]))?.role;
    if(artifactRole) {
        return artifactRole;
    }
    const supportingRole = REPO_SUPPORTING_FILES.find((file) => pathExcluded(pathValue, [file.glob]))?.role;
    if(supportingRole) {
        return supportingRole;
    }
    const integration = resolveLanguageIntegration({path: pathValue});
    if(integration?.category === 'config') {
        return 'configuration';
    }
    return '';
}

export function supportTermsForRepoQuestion(question) {
    const terms = [];
    const q = String(question || '').toLowerCase();
    for(const artifact of SHARED_REPO_ARTIFACTS) {
        const artifactTerms = artifact.terms || [];
        if(artifactTerms.some((term) => questionMatchesTerm(q, term))) {
            terms.push(...artifactTerms);
        }
    }
    for(const profile of repoProfilesForQuestion(question)) {
        terms.push(
            ...(profile.evidenceTerms || []),
            ...(profile.questionTerms || []),
            ...(profile.supportingFiles || []).flatMap((file) => file.terms || [])
        );
    }
    return uniqueStrings(terms);
}

export function repoProfilesForQuestion(question) {
    const q = String(question || '').toLowerCase();
    if(!q.trim()) {
        return [];
    }
    return LANGUAGE_INTEGRATIONS
        .map((integration) => {
            const profile = integration.repo || {};
            const directTerms = [
                integration.id,
                integration.name,
                ...(integration.aliases || []),
                ...(profile.questionTerms || [])
            ];
            const evidenceTerms = [
                ...(profile.evidenceTerms || []),
                ...(profile.sourceRoles || []),
                ...(profile.supportingFiles || []).flatMap((file) => file.terms || [])
            ];
            const directHits = directTerms.filter((term) => questionMatchesTerm(q, term));
            const evidenceHits = evidenceTerms.filter((term) => questionMatchesTerm(q, term));
            const score = (directHits.length * 3) + evidenceHits.length;
            return directHits.length > 0 ? {
                id: integration.id,
                name: integration.name,
                family: integration.family,
                category: integration.category,
                score,
                matchedTerms: uniqueStrings([...directHits, ...evidenceHits]),
                sourceRoles: profile.sourceRoles || [],
                supportingFiles: profile.supportingFiles || [],
                questionTerms: profile.questionTerms || [],
                evidenceTerms: profile.evidenceTerms || []
            } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function repoProfiles() {
    return LANGUAGE_INTEGRATIONS.map((integration) => ({
        id: integration.id,
        name: integration.name,
        family: integration.family,
        category: integration.category,
        sourceRoles: integration.repo?.sourceRoles || [],
        supportingFiles: integration.repo?.supportingFiles || [],
        questionTerms: integration.repo?.questionTerms || [],
        evidenceTerms: integration.repo?.evidenceTerms || []
    }));
}

function normalizeLanguage(language) {
    return String(language || '').trim().toLowerCase().replace(/[^a-z0-9#+-]/g, '');
}

function termsFromGlob(glob) {
    return String(glob || '')
        .replace(/\*\*/g, '')
        .split(/[^A-Za-z0-9#+]+/u)
        .map((term) => term.toLowerCase())
        .filter((term) => term.length >= 3 && !['json', 'toml', 'lock', 'xml', 'txt'].includes(term));
}

function questionMatchesTerm(question, term) {
    const normalized = String(term || '').toLowerCase().trim();
    if(!normalized) {
        return false;
    }
    if(/[^a-z0-9]/.test(normalized)) {
        return question.includes(normalized);
    }
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'u').test(question);
}

function extensionFromPath(filePath = '') {
    const name = String(filePath || '').split(/[\\/]/).pop() || '';
    if(name.startsWith('.') && !name.slice(1).includes('.')) {
        return name.toLowerCase();
    }
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function normalizeRepoPath(value) {
    const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
    return normalized && normalized !== '.' ? normalized : normalized || '';
}

function uniqueStrings(values) {
    return [...new Set(values.filter(Boolean))].sort();
}

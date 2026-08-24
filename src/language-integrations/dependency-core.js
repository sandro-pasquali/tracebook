import fs from 'fs-extra';
import path from 'node:path';
import fg from 'fast-glob';
import {createRepositoryPathResolver} from '../util/source-path.js';

export const VIRTUAL_DEP_PREFIX = '__dependencies__/';
export const README_NAMES = ['README.md', 'README.markdown', 'README.rst', 'README.txt', 'readme.md', 'readme.txt'];
export const MAX_MANIFEST_FILES = 80;

const MAX_README_CHARS = 1800;
const DEPENDENCY_SCAN_GLOBAL_EXCLUDE = [
    '**/.git/**',
    '**/data/**',
    '**/.cache/**'
];
const repositoryResolvers = new Map();

export function isVirtualDependencyPath(rel) {
    return String(rel || '').startsWith(VIRTUAL_DEP_PREFIX);
}

export function dependencyDocPath(ecosystem, name) {
    return `${VIRTUAL_DEP_PREFIX}${ecosystem}/${safeName(name)}.md`;
}

// Only synthesize dependency docs for runtime groups; skip dev/test groups, which
// are build/lint/test tooling (noise in product stories). Every collector tags its
// deps with a `group` label, and dev groups across ecosystems all contain "dev"
// (npm devDependencies, composer require-dev, Cargo dev-dependencies, Poetry
// tool.poetry.dev-dependencies); no runtime group label does.
//
export function isRuntimeDependencyGroup(group) {
    return !/dev/i.test(String(group || ''));
}

export function dependencyLineDoc(ecosystem, manifest, line, group = 'dependencies') {
    const name = dependencyNameFromSpec(line);
    return {
        path: dependencyDocPath(ecosystem, name || line),
        content: formatDependencyDoc({
            ecosystem,
            name: name || line,
            spec: line,
            group,
            manifest
        })
    };
}

export function formatDependencyDoc({ecosystem, name, spec, group, manifest, installed}) {
    const lines = [
        `# Dependency: ${name}`,
        '',
        '## Declaration',
        '',
        ...markdownTable([
            ['Ecosystem', ecosystem],
            ['Manifest', codeSpan(manifest)],
            ['Group', codeSpan(group)],
            ['Declared spec', codeSpan(spec)]
        ])
    ];

    const installedRows = [
        ['Installed version', codeSpan(installed?.version)],
        ['Description', installed?.description],
        ['Keywords', inlineList(installed?.keywords)],
        ['Homepage', linkText(installed?.homepage)],
        ['Repository', linkText(installed?.repository)],
        ['License', codeSpan(installed?.license)],
        ['Requires Python', codeSpan(installed?.requiresPython)],
        ['Main entry', codeSpan(installed?.main)],
        ['Module entry', codeSpan(installed?.module)],
        ['Types', codeSpan(installed?.types)]
    ];

    if(markdownTable(installedRows).length > 0) {
        lines.push('', '## Installed Package', '', ...markdownTable(installedRows));
    }

    if(installed?.requiresDist?.length) {
        lines.push('', '## Package Dependencies', '', ...installed.requiresDist.map((dep) => `- ${dep}`));
    }

    lines.push(...structuredBlock('Exports', installed?.exports));
    lines.push(...structuredBlock('Binary Entrypoints', installed?.bin));

    const excerpt = readmeExcerpt(installed?.readme, name);
    if(excerpt) {
        lines.push('', '## Local documentation excerpt', excerpt);
    }
    return compactMarkdownLines(lines).join('\n');
}

export async function findRepoFiles(root, patterns, limit = MAX_MANIFEST_FILES, repoIgnore = null, dependencyExclude = []) {
    try {
        const entries = await fg(patterns, {
            cwd: root,
            ignore: uniqueStrings([
                ...DEPENDENCY_SCAN_GLOBAL_EXCLUDE,
                ...dependencyExclude
            ]),
            onlyFiles: true,
            followSymbolicLinks: false,
            dot: true
        });
        const visible = repoIgnore ? await repoIgnore.filter(entries) : entries;
        return visible.sort().slice(0, limit);
    } catch {
        return [];
    }
}

export async function readJson(file, boundaryRoot) {
    try {
        const safe = await resolveDependencyReadPath(file, boundaryRoot);
        return safe ? await fs.readJson(safe) : null;
    } catch {
        return null;
    }
}

export async function readTextIfExists(file, boundaryRoot) {
    try {
        const safe = await resolveDependencyReadPath(file, boundaryRoot);
        if(!safe) return null;
        const stat = await fs.stat(safe);
        if(!stat.isFile() || stat.size > 250_000) return null;
        return await fs.readFile(safe, 'utf8');
    } catch {
        return null;
    }
}

export async function readFirstExisting(root, names, boundaryRoot) {
    for(const name of names) {
        const text = await readTextIfExists(path.join(root, name), boundaryRoot);
        if(text) return text;
    }
    return null;
}

async function resolveDependencyReadPath(file, boundaryRoot) {
    if(!boundaryRoot) {
        return null;
    }
    const root = path.resolve(boundaryRoot);
    let resolveRepositoryPath = repositoryResolvers.get(root);
    if(!resolveRepositoryPath) {
        resolveRepositoryPath = createRepositoryPathResolver(root);
        repositoryResolvers.set(root, resolveRepositoryPath);
    }
    const result = await resolveRepositoryPath(path.relative(root, path.resolve(file)) || '.');
    return result.ok ? result.path : null;
}

export function markdownTable(rows) {
    const filtered = rows
        .map(([label, value]) => [label, markdownCell(value)])
        .filter(([, value]) => value);
    if(filtered.length === 0) {
        return [];
    }
    return [
        '| Field | Value |',
        '| --- | --- |',
        ...filtered.map(([label, value]) => `| ${escapeTableCell(label)} | ${escapeTableCell(value)} |`)
    ];
}

export function codeSpan(value) {
    if(value === null || value === undefined || value === '') {
        return '';
    }
    return `\`${summarizeValue(value).replace(/`/g, "'")}\``;
}

export function inlineList(value) {
    if(value === null || value === undefined || value === '') {
        return '';
    }
    if(Array.isArray(value)) {
        return value.length > 0
            ? value.map((item) => codeSpan(item)).join(', ')
            : '';
    }
    if(typeof value === 'object') {
        return codeSpan(value);
    }
    return codeSpan(value);
}

export function structuredBlock(title, value) {
    if(value === null || value === undefined || value === '') {
        return [];
    }
    const text = prettyStructuredValue(value);
    if(!text) {
        return [];
    }
    return ['', `## ${title}`, '', ...fencedBlock(looksJson(text) ? 'json' : '', text)];
}

export function fencedBlock(language, text) {
    const info = language ? ` ${language}` : '';
    return [`~~~${info}`, String(text || ''), '~~~'];
}

export function compactMarkdownLines(lines) {
    const out = [];
    for(const value of lines.filter((line) => line !== null && line !== undefined)) {
        const line = String(value);
        if(line === '' && out.at(-1) === '') {
            continue;
        }
        out.push(line);
    }
    while(out[0] === '') out.shift();
    while(out.at(-1) === '') out.pop();
    return out;
}

export function parseJsonLike(text) {
    try {
        return JSON.parse(stripJsonComments(String(text || '')).replace(/,\s*([}\]])/g, '$1'));
    } catch {
        return null;
    }
}

export function xmlTag(text, tag) {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1].trim() : '';
}

export function repositoryUrl(repository) {
    if(!repository) return '';
    if(typeof repository === 'string') return repository;
    return repository.url || '';
}

export function summarizeValue(value) {
    if(!value) return '';
    if(typeof value === 'string') return value;
    try {
        return JSON.stringify(value).slice(0, 500);
    } catch {
        return String(value).slice(0, 500);
    }
}

export function tomlStringValue(text, key) {
    const m = String(text || '').match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
    return m ? m[1] : '';
}

export function tomlInlineValue(text, key) {
    const m = String(text || '').match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`));
    return m ? m[1] : '';
}

export function dependencyNameFromSpec(spec) {
    const value = String(spec || '').trim();
    const egg = value.match(/#egg=([^&\s]+)/);
    if(egg) return egg[1];
    const withoutExtras = value.replace(/\[[^\]]*]/, '');
    const firstToken = withoutExtras.split(/\s+/)[0];
    if(firstToken.includes(':') && !firstToken.includes('://')) {
        return firstToken;
    }
    const m = withoutExtras.match(/^(@?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)/);
    return m ? m[1] : value.split(/\s+/)[0];
}

export function isInsideRoot(root, abs) {
    const rootAbs = path.resolve(root);
    const targetAbs = path.resolve(abs);
    return targetAbs === rootAbs || targetAbs.startsWith(rootAbs + path.sep);
}

export function splitKeywords(value) {
    return String(value || '').split(/[,\s]+/).map((v) => v.trim()).filter(Boolean).slice(0, 20);
}

export function splitList(value) {
    return String(value || '').split(/;\s*/).map((v) => v.trim()).filter(Boolean);
}

export function safeName(name) {
    return String(name || 'unknown').replace(/^@/, '').replace(/[^A-Za-z0-9_.-]+/g, '__').slice(0, 120);
}

function readmeExcerpt(readme, packageName) {
    const text = String(readme || '').replace(/\r\n?/g, '\n');
    if(!text.trim()) {
        return '';
    }
    return stripReadmePrelude(text, packageName).slice(0, MAX_README_CHARS).trim();
}

function stripReadmePrelude(text, packageName) {
    const lines = text.split('\n');
    let changed = true;

    while(changed) {
        changed = false;
        changed = trimLeadingBlankLines(lines) || changed;
        changed = stripLeadingHtmlPrelude(lines) || changed;
        changed = stripLeadingBadgeLine(lines) || changed;
        changed = stripLeadingReadmeTitle(lines, packageName) || changed;
    }

    return lines.join('\n').trim();
}

function trimLeadingBlankLines(lines) {
    let changed = false;
    while(lines.length > 0 && lines[0].trim() === '') {
        lines.shift();
        changed = true;
    }
    return changed;
}

function stripLeadingHtmlPrelude(lines) {
    const first = lines[0]?.trim();
    if(!first) {
        return false;
    }
    if(isHtmlPreludeBlockStart(first)) {
        let depth = 0;
        do {
            const line = lines.shift() || '';
            depth += countHtmlOpenPreludeTags(line);
            depth -= countHtmlClosePreludeTags(line);
        } while(lines.length > 0 && depth > 0);
        return true;
    }
    if(isHtmlPreludeLine(first)) {
        lines.shift();
        return true;
    }
    return false;
}

function isHtmlPreludeBlockStart(line) {
    return /^<(?:div|p|center)\b/i.test(line) && (
        /\balign\s*=\s*["']?center/i.test(line)
        || /<img\b/i.test(line)
        || /^<center\b/i.test(line)
    );
}

function countHtmlOpenPreludeTags(line) {
    return (String(line).match(/<(?:div|p|center)\b/gi) || []).length;
}

function countHtmlClosePreludeTags(line) {
    return (String(line).match(/<\/(?:div|p|center)>/gi) || []).length;
}

function isHtmlPreludeLine(line) {
    return /^<hr\s*\/?>$/i.test(line)
        || /^<br\s*\/?>$/i.test(line)
        || /^<\/?(?:div|p|center)\b[^>]*>$/i.test(line)
        || (/^<a\b/i.test(line) && /<img\b/i.test(line) && /<\/a>$/i.test(line))
        || /^<img\b[^>]*\/?>$/i.test(line);
}

function stripLeadingBadgeLine(lines) {
    if(!isBadgeOnlyLine(lines[0])) {
        return false;
    }
    lines.shift();
    return true;
}

function isBadgeOnlyLine(line) {
    const text = String(line || '').trim();
    if(!text) {
        return false;
    }
    const withoutHtmlBadges = text
        .replace(/<a\b[^>]*>\s*<img\b[^>]*>\s*<\/a>/gi, '')
        .replace(/<img\b[^>]*>/gi, '');
    const withoutMarkdownBadges = withoutHtmlBadges
        .replace(/\[!\[[^\]]*]\([^)]*\)]\([^)]*\)/g, '')
        .replace(/!\[[^\]]*]\([^)]*\)/g, '');
    return withoutMarkdownBadges.trim() === '';
}

function stripLeadingReadmeTitle(lines, packageName) {
    const match = lines[0]?.trim().match(/^#\s+(.+?)\s*#*$/);
    if(!match || !isRedundantReadmeTitle(match[1], packageName)) {
        return false;
    }
    lines.shift();
    return true;
}

function isRedundantReadmeTitle(title, packageName) {
    const titleText = normalizeReadmeTitle(title);
    const packageText = normalizeReadmeTitle(packageName);
    const packageBase = packageText.split('/').pop();
    if(!titleText || !packageText) {
        return false;
    }
    return titleText === packageText
        || titleText.startsWith(`${packageText} `)
        || titleText === packageBase
        || titleText.startsWith(`${packageBase} `);
}

function normalizeReadmeTitle(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/&[a-z0-9#]+;/gi, ' ')
        .replace(/[`*_~[\]().:|<>]/g, ' ')
        .replace(/[^a-z0-9@/.-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^@/, '');
}

function markdownCell(value) {
    if(value === null || value === undefined || value === '') {
        return '';
    }
    return String(value).replace(/\r?\n/g, '<br>');
}

function escapeTableCell(value) {
    return String(value || '').replace(/\|/g, '\\|');
}

function linkText(value) {
    const text = String(value || '').trim();
    if(!text) {
        return '';
    }
    if(/^https?:\/\//i.test(text)) {
        return `[${text}](${text})`;
    }
    return text;
}

function prettyStructuredValue(value) {
    if(value === null || value === undefined || value === '') {
        return '';
    }
    if(typeof value === 'object') {
        return JSON.stringify(value, null, 2).slice(0, 1400);
    }
    const text = String(value).trim();
    if(looksJson(text)) {
        try {
            return JSON.stringify(JSON.parse(text), null, 2).slice(0, 1400);
        } catch {
            return text.slice(0, 1400);
        }
    }
    return text.slice(0, 1400);
}

function looksJson(text) {
    return /^\s*[{[]/.test(String(text || ''));
}

function stripJsonComments(text) {
    return String(text || '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '$1');
}

export function uniqueStrings(values) {
    return [...new Set(values.filter(Boolean))];
}

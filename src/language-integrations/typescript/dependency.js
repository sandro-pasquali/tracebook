import path from 'node:path';
import {
    MAX_MANIFEST_FILES,
    VIRTUAL_DEP_PREFIX,
    codeSpan,
    compactMarkdownLines,
    findRepoFiles,
    inlineList,
    markdownTable,
    parseJsonLike,
    readTextIfExists,
    safeName
} from '../dependency-core.js';
import {JAVASCRIPT_SOURCE_POLICY} from '../source-policies.js';

export const typescriptDependency = {
    ecosystems: ['typescript'],
    manifests: ['**/tsconfig*.json'],
    exclude: JAVASCRIPT_SOURCE_POLICY.exclude,
    collect: collectTypeScriptDocs
};

async function collectTypeScriptDocs(root, {repoIgnore, dependencyExclude = []} = {}) {
    const files = await findRepoFiles(root, ['**/tsconfig*.json'], MAX_MANIFEST_FILES, repoIgnore, dependencyExclude);
    const docs = [];

    for(const file of files) {
        const text = await readTextIfExists(path.join(root, file), root);
        const config = parseJsonLike(text);
        if(!config || typeof config !== 'object') {
            continue;
        }

        docs.push({
            path: `${VIRTUAL_DEP_PREFIX}typescript/${safeName(file)}.md`,
            content: formatTypeScriptConfigDoc(file, config)
        });
    }

    return docs;
}

function formatTypeScriptConfigDoc(manifest, config) {
    const compilerOptions = config.compilerOptions && typeof config.compilerOptions === 'object'
        ? config.compilerOptions
        : {};
    const lines = [
        `# TypeScript config: ${manifest}`,
        '',
        '## Config',
        '',
        ...markdownTable([
            ['Manifest', codeSpan(manifest)],
            ['Extends', codeSpan(config.extends)],
            ['Files', inlineList(config.files)],
            ['Include', inlineList(config.include)],
            ['Exclude', inlineList(config.exclude)],
            ['References', inlineList((config.references || []).map((reference) => reference?.path).filter(Boolean))]
        ])
    ];

    const compilerRows = [
        ['Target', codeSpan(compilerOptions.target)],
        ['Module', codeSpan(compilerOptions.module)],
        ['Module resolution', codeSpan(compilerOptions.moduleResolution)],
        ['JSX', codeSpan(compilerOptions.jsx)],
        ['Strict', codeSpan(compilerOptions.strict)],
        ['Allow JS', codeSpan(compilerOptions.allowJs)],
        ['Check JS', codeSpan(compilerOptions.checkJs)],
        ['Declaration output', codeSpan(compilerOptions.declaration)],
        ['Output directory', codeSpan(compilerOptions.outDir)],
        ['Root directory', codeSpan(compilerOptions.rootDir)],
        ['Base URL', codeSpan(compilerOptions.baseUrl)],
        ['Path aliases', inlineList(Object.keys(compilerOptions.paths || {}))]
    ];
    const compilerTable = markdownTable(compilerRows);
    if(compilerTable.length > 0) {
        lines.push('', '## Compiler Options', '', ...compilerTable);
    }

    return compactMarkdownLines(lines).join('\n');
}

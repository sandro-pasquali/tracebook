import {patternFactExtractor} from '../common.js';
import {JAVASCRIPT_SOURCE_POLICY} from '../source-policies.js';
import {javascriptAnnotation} from './annotation.js';
import {javascriptDependency} from './dependency.js';

export const integration = {
    id: 'javascript',
    name: 'JavaScript',
    grammar: 'javascript',
    family: 'javascript',
    aliases: ['javascript', 'js', 'node'],
    extensions: ['.js', '.mjs', '.cjs'],
    filenames: [],
    source: JAVASCRIPT_SOURCE_POLICY,
    dependency: javascriptDependency,
    repo: {
        sourceRoles: ['application module', 'server route', 'browser behavior', 'tooling script'],
        supportingFiles: [
            {glob: '**/vite.config.*', role: 'configuration', terms: ['vite', 'build', 'dev server']},
            {glob: '**/webpack.config.*', role: 'configuration', terms: ['webpack', 'bundle', 'build']},
            {glob: '**/rollup.config.*', role: 'configuration', terms: ['rollup', 'bundle', 'build']},
            {glob: '**/eslint.config.*', role: 'configuration', terms: ['eslint', 'lint', 'rules']}
        ],
        questionTerms: ['javascript', 'node', 'browser', 'route', 'handler', 'event', 'stream', 'api'],
        evidenceTerms: ['function', 'export', 'import', 'route', 'handler', 'event listener', 'promise']
    },
    annotation: javascriptAnnotation,
    queries: {
        definitions: [
            {
                id: 'function-declaration',
                query: '(function_declaration name: (identifier) @name) @definition',
                detail: 'declares a JavaScript function'
            },
            {
                id: 'class-declaration',
                query: '(class_declaration name: (identifier) @name) @definition',
                detail: 'declares a JavaScript class'
            }
        ],
        imports: [
            {
                id: 'import-source',
                query: '(import_statement source: (string (string_fragment) @target)) @import',
                nameCapture: 'target',
                targetCapture: 'target',
                detail: 'imports a JavaScript module'
            }
        ],
        calls: [
            {
                id: 'call-expression',
                query: '(call_expression function: (identifier) @name) @call',
                detail: 'calls a JavaScript function'
            },
            {
                id: 'member-call-expression',
                query: '(call_expression function: (member_expression property: (property_identifier) @name)) @call',
                detail: 'calls a JavaScript member'
            }
        ]
    },
    contract: {
        path: 'src/server.js',
        source: [
            'import {save} from "./store.js";',
            'export async function checkout(order) {',
            '    await save(order);',
            '    return order;',
            '}'
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'checkout'},
            {kind: 'import', target: './store.js'},
            {kind: 'call', name: 'save'}
        ],
        callLine: 'await save(order);',
        excludedPaths: ['test/server.test.js', 'src/server.spec.js', 'node_modules/pkg/index.js'],
        dependencyManifestPaths: ['package.json']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'route',
            pattern: /\b(?:app|router|route|server|api)\s*\.\s*(get|post|put|patch|delete|use|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
            name: (match) => `${match[1].toUpperCase()} ${match[2]}`,
            target: 2,
            detail: 'declares an HTTP route'
        }),
        patternFactExtractor({
            kind: 'configuration',
            pattern: /\b(?:process\.env|import\.meta\.env)\.([A-Za-z_][A-Za-z0-9_]*)/g,
            name: 1,
            target: 1,
            detail: 'reads configuration'
        }),
        patternFactExtractor({
            kind: 'storage',
            pattern: /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(findMany|findUnique|findOne|insert|update|upsert|delete|save|create|query|execute|select|from)\s*\(/g,
            name: (match) => `${match[1]}.${match[2]}`,
            target: 2,
            detail: 'uses a storage or database boundary'
        }),
        patternFactExtractor({
            kind: 'entrypoint',
            pattern: /\brequire\.main\s*===\s*module\b/g,
            name: 'main module',
            target: 'main module',
            detail: 'marks a JavaScript executable entrypoint'
        })
    ]
};

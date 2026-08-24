import {patternFactExtractor} from '../common.js';
import {JAVASCRIPT_SOURCE_POLICY} from '../source-policies.js';
import {javascriptAnnotation} from '../javascript/annotation.js';
import {typescriptDependency} from './dependency.js';

export const integration = {
    id: 'typescript',
    name: 'TypeScript',
    grammar: 'typescript',
    family: 'javascript',
    aliases: ['typescript', 'ts'],
    extensions: ['.ts'],
    filenames: [],
    source: JAVASCRIPT_SOURCE_POLICY,
    dependency: typescriptDependency,
    repo: {
        sourceRoles: ['typed application module', 'service module', 'tooling module'],
        supportingFiles: [
            {glob: '**/tsconfig*.json', role: 'configuration', terms: ['typescript', 'compiler', 'paths']},
            {glob: '**/vite.config.ts', role: 'configuration', terms: ['vite', 'typescript', 'build']},
            {glob: '**/eslint.config.ts', role: 'configuration', terms: ['eslint', 'typescript', 'rules']}
        ],
        questionTerms: ['typescript', 'types', 'interface', 'service', 'compiler', 'tsconfig'],
        evidenceTerms: ['type', 'interface', 'export', 'import', 'function', 'class']
    },
    annotation: javascriptAnnotation,
    queries: {
        definitions: [
            {
                id: 'function-declaration',
                query: '(function_declaration name: (identifier) @name) @definition',
                detail: 'declares a TypeScript function'
            },
            {
                id: 'class-declaration',
                query: '(class_declaration name: (type_identifier) @name) @definition',
                detail: 'declares a TypeScript class'
            },
            {
                id: 'interface-declaration',
                query: '(interface_declaration name: (type_identifier) @name) @definition',
                detail: 'declares a TypeScript interface'
            },
            {
                id: 'type-alias-declaration',
                query: '(type_alias_declaration name: (type_identifier) @name) @definition',
                detail: 'declares a TypeScript type alias'
            }
        ],
        imports: [
            {
                id: 'import-source',
                query: '(import_statement source: (string (string_fragment) @target)) @import',
                nameCapture: 'target',
                targetCapture: 'target',
                detail: 'imports a TypeScript module'
            }
        ],
        calls: [
            {
                id: 'call-expression',
                query: '(call_expression function: (identifier) @name) @call',
                detail: 'calls a TypeScript function'
            },
            {
                id: 'member-call-expression',
                query: '(call_expression function: (member_expression property: (property_identifier) @name)) @call',
                detail: 'calls a TypeScript member'
            }
        ]
    },
    contract: {
        path: 'src/server.ts',
        source: [
            'import {save} from "./store";',
            'export interface Order { id: string }',
            'export function checkout(order: Order): Order {',
            '    save(order);',
            '    return order;',
            '}'
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'Order'},
            {kind: 'definition', name: 'checkout'},
            {kind: 'import', target: './store'},
            {kind: 'call', name: 'save'}
        ],
        callLine: 'save(order);',
        excludedPaths: ['src/server.test.ts', 'node_modules/pkg/index.ts'],
        dependencyManifestPaths: ['tsconfig.json']
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
            detail: 'marks a TypeScript executable entrypoint'
        })
    ]
};

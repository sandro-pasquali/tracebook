import {patternFactExtractor} from '../common.js';
import {JAVASCRIPT_SOURCE_POLICY} from '../source-policies.js';
import {javascriptAnnotation} from '../javascript/annotation.js';

export const integration = {
    id: 'tsx',
    name: 'TSX/JSX',
    grammar: 'tsx',
    family: 'javascript',
    aliases: ['tsx', 'jsx'],
    extensions: ['.tsx', '.jsx'],
    filenames: [],
    source: JAVASCRIPT_SOURCE_POLICY,
    repo: {
        sourceRoles: ['ui component', 'view layer', 'interactive surface'],
        supportingFiles: [
            {glob: '**/tsconfig*.json', role: 'configuration', terms: ['jsx', 'typescript', 'compiler']},
            {glob: '**/vite.config.*', role: 'configuration', terms: ['jsx', 'dev server', 'build']}
        ],
        questionTerms: ['tsx', 'jsx', 'component', 'props', 'state', 'render', 'ui'],
        evidenceTerms: ['component', 'props', 'state', 'event handler', 'jsx element']
    },
    annotation: javascriptAnnotation,
    queries: {
        definitions: [
            {
                id: 'function-declaration',
                query: '(function_declaration name: (identifier) @name) @definition',
                detail: 'declares a TSX function'
            },
            {
                id: 'class-declaration',
                query: '(class_declaration name: (type_identifier) @name) @definition',
                detail: 'declares a TSX class'
            },
            {
                id: 'interface-declaration',
                query: '(interface_declaration name: (type_identifier) @name) @definition',
                detail: 'declares a TSX interface'
            }
        ],
        imports: [
            {
                id: 'import-source',
                query: '(import_statement source: (string (string_fragment) @target)) @import',
                nameCapture: 'target',
                targetCapture: 'target',
                detail: 'imports a TSX module'
            }
        ],
        calls: [
            {
                id: 'call-expression',
                query: '(call_expression function: (identifier) @name) @call',
                detail: 'calls a TSX function'
            },
            {
                id: 'member-call-expression',
                query: '(call_expression function: (member_expression property: (property_identifier) @name)) @call',
                detail: 'calls a TSX member'
            }
        ]
    },
    contract: {
        path: 'src/Button.tsx',
        source: [
            'import {labelFor} from "./labels";',
            'export function CheckoutButton() {',
            '  return <button>{labelFor("pay")}</button>;',
            '}'
        ].join('\n'),
        expectedFacts: [
            {kind: 'import', target: './labels'},
            {kind: 'definition', name: 'CheckoutButton'},
            {kind: 'call', name: 'labelFor'}
        ],
        expectedLineFacts: [
            {kind: 'jsx_element', name: 'button'}
        ],
        callLine: 'return <button>Pay</button>;',
        excludedPaths: ['src/Button.test.tsx', 'node_modules/pkg/Button.tsx']
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
            kind: 'jsx_element',
            pattern: /<([A-Za-z][A-Za-z0-9.]*)\b/g,
            name: (match) => match[1],
            target: 1,
            detail: 'renders a JSX element'
        }),
        patternFactExtractor({
            kind: 'interaction',
            pattern: /\b(on[A-Z][A-Za-z0-9_]*)\s*=/g,
            name: 1,
            target: 1,
            detail: 'wires a JSX event handler'
        })
    ]
};

import {patternFactExtractor} from '../common.js';
import {createCurlyBraceAnnotation} from '../annotation-factories.js';
import {GO_SOURCE_POLICY} from '../source-policies.js';
import {goDependency} from './dependency.js';

export const integration = {
    id: 'go',
    name: 'Go',
    grammar: 'go',
    family: 'go',
    aliases: ['go'],
    extensions: ['.go'],
    filenames: [],
    source: GO_SOURCE_POLICY,
    dependency: goDependency,
    repo: {
        sourceRoles: ['package source', 'command entrypoint', 'service module'],
        supportingFiles: [
            {glob: '**/go.work', role: 'manifest', terms: ['go workspace', 'module', 'replace']},
            {glob: '**/go.sum', role: 'manifest', terms: ['go checksum', 'module', 'dependency']}
        ],
        questionTerms: ['go', 'golang', 'package', 'goroutine', 'handler', 'module'],
        evidenceTerms: ['func', 'method', 'package', 'import', 'struct', 'interface']
    },
    queries: {
        definitions: [
            {
                id: 'function-declaration',
                query: '(function_declaration name: (identifier) @name) @definition',
                detail: 'declares a Go function'
            },
            {
                id: 'method-declaration',
                query: '(method_declaration name: (field_identifier) @name) @definition',
                detail: 'declares a Go method'
            }
        ],
        imports: [
            {
                id: 'import-spec',
                query: '(import_spec path: (interpreted_string_literal) @target) @import',
                nameCapture: 'target',
                targetCapture: 'target',
                detail: 'imports a Go package'
            }
        ],
        calls: [
            {
                id: 'call-expression',
                query: '(call_expression function: (identifier) @name) @call',
                detail: 'calls a Go function'
            },
            {
                id: 'selector-call-expression',
                query: '(call_expression function: (selector_expression field: (field_identifier) @name)) @call',
                detail: 'calls a Go selector'
            }
        ]
    },
    contract: {
        path: 'cmd/server/main.go',
        source: [
            'package main',
            '',
            'import (',
            '    "fmt"',
            '    "net/http"',
            '    "os"',
            ')',
            '',
            'func checkout() int {',
            '    fmt.Println("ok")',
            '    return 1',
            '}',
            '',
            'func main() {',
            '    http.HandleFunc("/health", health)',
            '    token := os.Getenv("API_TOKEN")',
            '    go checkout()',
            '    _ = token',
            '}'
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'checkout'},
            {kind: 'import', target: 'fmt'},
            {kind: 'call', name: 'Println'}
        ],
        expectedLineFacts: [
            {kind: 'route', name: 'HANDLE /health'},
            {kind: 'configuration', name: 'API_TOKEN'},
            {kind: 'concurrency', name: 'checkout'},
            {kind: 'entrypoint', name: 'main'}
        ],
        callLine: 'fmt.Println("ok")',
        excludedPaths: ['cmd/server/main_test.go', 'vendor/pkg/main.go', 'testdata/main.go'],
        dependencyManifestPaths: ['go.mod']
    },
    annotation: createCurlyBraceAnnotation({
        languageName: 'Go',
        definitionPatterns: [
            {kind: 'function', re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/},
            {kind: 'type', re: /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface|func|\w+)/}
        ],
        bindingPatterns: [
            /^([A-Za-z_][A-Za-z0-9_]*)\s*:=/,
            /^(?:var|const)\s+([A-Za-z_][A-Za-z0-9_]*)\b/
        ],
        callKeywords: ['if', 'for', 'switch', 'select', 'go', 'defer', 'return', 'range'],
        outputPattern: /\b(return|panic|continue|break|fallthrough)\b/
    }),
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'route',
            pattern: /\b(?:http\.)?HandleFunc\(\s*"([^"]+)"/g,
            name: (match) => `HANDLE ${match[1]}`,
            target: 1,
            detail: 'registers a Go HTTP handler'
        }),
        patternFactExtractor({
            kind: 'route',
            pattern: /\b[A-Za-z_][A-Za-z0-9_.]*\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|HandleFunc)\(\s*"([^"]+)"/g,
            name: (match) => `${match[1].toUpperCase()} ${match[2]}`,
            target: 2,
            detail: 'registers a Go router handler'
        }),
        patternFactExtractor({
            kind: 'configuration',
            pattern: /\bos\.(?:Getenv|LookupEnv)\(\s*"([^"]+)"/g,
            name: 1,
            target: 1,
            detail: 'reads configuration'
        }),
        patternFactExtractor({
            kind: 'storage',
            pattern: /\b([A-Za-z_][A-Za-z0-9_.]*)\.(QueryContext|QueryRowContext|ExecContext|Query|QueryRow|Exec|Find|InsertOne|UpdateOne|DeleteOne)\s*\(/g,
            name: (match) => `${match[1]}.${match[2]}`,
            target: 2,
            detail: 'uses a storage or database boundary'
        }),
        patternFactExtractor({
            kind: 'concurrency',
            pattern: /^go\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g,
            name: 1,
            target: 1,
            detail: 'starts goroutine work'
        }),
        patternFactExtractor({
            kind: 'cancellation',
            pattern: /\bcontext\.(WithCancel|WithTimeout|WithDeadline)\s*\(/g,
            name: 1,
            target: 1,
            detail: 'creates a Go cancellation boundary'
        }),
        patternFactExtractor({
            kind: 'response',
            pattern: /\b[A-Za-z_][A-Za-z0-9_]*\.(WriteHeader|Write)\s*\(/g,
            name: 1,
            target: 1,
            detail: 'writes an HTTP response'
        }),
        patternFactExtractor({
            kind: 'entrypoint',
            pattern: /^func\s+main\s*\(/g,
            name: 'main',
            target: 'main',
            detail: 'marks a Go executable entrypoint'
        })
    ]
};

import {patternFactExtractor} from '../common.js';
import {RUST_SOURCE_POLICY} from '../source-policies.js';
import {rustAnnotation} from './annotation.js';
import {rustDependency} from './dependency.js';

export const integration = {
    id: 'rust',
    name: 'Rust',
    grammar: 'rust',
    family: 'rust',
    aliases: ['rust', 'rs'],
    extensions: ['.rs'],
    filenames: [],
    source: RUST_SOURCE_POLICY,
    dependency: rustDependency,
    repo: {
        sourceRoles: ['crate module', 'binary entrypoint', 'library module', 'systems component'],
        supportingFiles: [
            {glob: '**/.cargo/config.toml', role: 'configuration', terms: ['cargo', 'target', 'registry']},
            {glob: '**/rust-toolchain.toml', role: 'configuration', terms: ['toolchain', 'channel', 'components']},
            {glob: '**/rustfmt.toml', role: 'configuration', terms: ['formatting', 'rustfmt']}
        ],
        questionTerms: ['rust', 'crate', 'cargo', 'trait', 'impl', 'async', 'ownership'],
        evidenceTerms: ['fn', 'struct', 'enum', 'trait', 'impl', 'use', 'module']
    },
    annotation: rustAnnotation,
    queries: {
        definitions: [
            {
                id: 'function-item',
                query: '(function_item name: (identifier) @name) @definition',
                detail: 'declares a Rust function'
            },
            {
                id: 'struct-item',
                query: '(struct_item name: (type_identifier) @name) @definition',
                detail: 'declares a Rust struct'
            },
            {
                id: 'enum-item',
                query: '(enum_item name: (type_identifier) @name) @definition',
                detail: 'declares a Rust enum'
            },
            {
                id: 'trait-item',
                query: '(trait_item name: (type_identifier) @name) @definition',
                detail: 'declares a Rust trait'
            }
        ],
        imports: [
            {
                id: 'use-declaration',
                query: '(use_declaration argument: (_) @target) @import',
                nameCapture: 'target',
                targetCapture: 'target',
                detail: 'imports a Rust path'
            }
        ],
        calls: [
            {
                id: 'call-expression',
                query: '(call_expression function: (identifier) @name) @call',
                detail: 'calls a Rust function'
            },
            {
                id: 'scoped-call-expression',
                query: '(call_expression function: (scoped_identifier name: (identifier) @name)) @call',
                detail: 'calls a Rust scoped function'
            }
        ]
    },
    contract: {
        path: 'src/main.rs',
        source: [
            'use std::fmt;',
            '#[derive(Serialize, Deserialize)]',
            'struct Order { id: i32 }',
            'fn checkout(order: i32) -> i32 {',
            '    tokio::spawn(async move {});',
            '    save(order);',
            '    order',
            '}'
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'checkout'},
            {kind: 'import', target: 'std::fmt'},
            {kind: 'call', name: 'save'}
        ],
        expectedLineFacts: [
            {kind: 'serialization', name: 'Serialize'},
            {kind: 'concurrency', name: 'tokio::spawn'}
        ],
        expectedAnnotation: {
            role: 'call boundary',
            facts: ['calls: save'],
            scoreAtLeast: 30
        },
        callLine: 'save(order);',
        excludedPaths: ['tests/main.rs', 'target/debug/build/main.rs', 'benches/checkout.rs'],
        dependencyManifestPaths: ['Cargo.toml', 'Cargo.lock']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'route',
            pattern: /#\[(get|post|put|patch|delete|route)\(\s*"([^"]+)"/g,
            name: (match) => `${match[1].toUpperCase()} ${match[2]}`,
            target: 2,
            detail: 'declares a Rust web route'
        }),
        patternFactExtractor({
            kind: 'route',
            pattern: /\.route\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)\s*\(/g,
            name: (match) => `${match[2].toUpperCase()} ${match[1]}`,
            target: 1,
            detail: 'registers a Rust router route'
        }),
        patternFactExtractor({
            kind: 'import',
            pattern: /^use\s+([^;]+);/g,
            name: 1,
            target: 1,
            detail: 'imports a Rust path'
        }),
        patternFactExtractor({
            kind: 'configuration',
            pattern: /\benv::var\(\s*['"]([^'"]+)['"]/g,
            name: 1,
            target: 1,
            detail: 'reads configuration'
        }),
        patternFactExtractor({
            kind: 'storage',
            pattern: /\b(sqlx::query!?|diesel::insert_into|diesel::update|diesel::delete)\s*\(/g,
            name: 1,
            target: 1,
            detail: 'uses a storage or database boundary'
        }),
        patternFactExtractor({
            kind: 'serialization',
            pattern: /#\[derive\([^)]*?\b(Serialize|Deserialize)\b[^)]*\)]/g,
            name: 1,
            target: 1,
            detail: 'declares Rust serialization support'
        }),
        patternFactExtractor({
            kind: 'concurrency',
            pattern: /\b(tokio::spawn|task::spawn|spawn_blocking)\s*\(/g,
            name: 1,
            target: 1,
            detail: 'starts Rust asynchronous work'
        }),
        patternFactExtractor({
            kind: 'error_boundary',
            pattern: /\b(anyhow!|bail!|ensure!|map_err)\s*[(!]/g,
            name: 1,
            target: 1,
            detail: 'handles or creates a Rust error boundary'
        }),
        patternFactExtractor({
            kind: 'entrypoint',
            pattern: /^(?:pub\s+)?(?:async\s+)?fn\s+main\s*\(/g,
            name: 'main',
            target: 'main',
            detail: 'marks a Rust executable entrypoint'
        })
    ]
};

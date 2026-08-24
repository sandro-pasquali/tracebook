import {patternFactExtractor} from '../common.js';
import {createCurlyBraceAnnotation} from '../annotation-factories.js';
import {PHP_SOURCE_POLICY} from '../source-policies.js';
import {phpDependency} from './dependency.js';

export const integration = {
    id: 'php',
    name: 'PHP',
    grammar: 'php',
    family: 'php',
    aliases: ['php'],
    extensions: ['.php'],
    filenames: [],
    source: PHP_SOURCE_POLICY,
    dependency: phpDependency,
    repo: {
        sourceRoles: ['application script', 'controller', 'service class', 'template helper'],
        supportingFiles: [
            {glob: '**/phpunit.xml', role: 'configuration', terms: ['phpunit', 'tests', 'configuration']},
            {glob: '**/phpstan.neon', role: 'configuration', terms: ['phpstan', 'analysis', 'rules']},
            {glob: '**/psalm.xml', role: 'configuration', terms: ['psalm', 'analysis', 'rules']}
        ],
        questionTerms: ['php', 'composer', 'controller', 'namespace', 'class', 'request'],
        evidenceTerms: ['function', 'class', 'namespace', 'use', 'method']
    },
    queries: {
        definitions: [
            {
                id: 'function-definition',
                query: '(function_definition name: (name) @name) @definition',
                detail: 'declares a PHP function'
            },
            {
                id: 'class-declaration',
                query: '(class_declaration name: (name) @name) @definition',
                detail: 'declares a PHP class'
            }
        ],
        imports: [
            {
                id: 'namespace-use',
                query: '(namespace_use_clause (_) @target) @import',
                nameCapture: 'target',
                targetCapture: 'target',
                detail: 'imports a PHP namespace or symbol'
            }
        ],
        calls: [
            {
                id: 'function-call-expression',
                query: '(function_call_expression function: (name) @name) @call',
                detail: 'calls a PHP function'
            }
        ]
    },
    contract: {
        path: 'src/handler.php',
        source: [
            '<?php',
            'use App\\Store;',
            'function checkout($order) {',
            '    return $order;',
            '}',
            'Route::post("/checkout", [CheckoutController::class, "store"]);',
            '$token = getenv("API_TOKEN");',
            'checkout(1);'
        ].join('\n'),
        expectedFacts: [
            {kind: 'import', target: 'App\\Store'},
            {kind: 'definition', name: 'checkout'},
            {kind: 'call', name: 'checkout'}
        ],
        expectedLineFacts: [
            {kind: 'route', name: 'POST /checkout'},
            {kind: 'configuration', name: 'API_TOKEN'}
        ],
        callLine: 'checkout(1);',
        excludedPaths: ['tests/HandlerTest.php', 'vendor/pkg/handler.php'],
        dependencyManifestPaths: ['composer.json']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'route',
            pattern: /\bRoute::(get|post|put|patch|delete|match|any)\(\s*['"]([^'"]+)['"]/gi,
            name: (match) => `${match[1].toUpperCase()} ${match[2]}`,
            target: 2,
            detail: 'declares a PHP framework route'
        }),
        patternFactExtractor({
            kind: 'route',
            pattern: /\$router->(get|post|put|patch|delete|map|any)\(\s*['"]([^'"]+)['"]/gi,
            name: (match) => `${match[1].toUpperCase()} ${match[2]}`,
            target: 2,
            detail: 'declares a PHP router route'
        }),
        patternFactExtractor({
            kind: 'configuration',
            pattern: /\bgetenv\(\s*['"]([^'"]+)['"]/g,
            name: 1,
            target: 1,
            detail: 'reads configuration'
        }),
        patternFactExtractor({
            kind: 'configuration',
            pattern: /\$_ENV\[\s*['"]([^'"]+)['"]\s*]/g,
            name: 1,
            target: 1,
            detail: 'reads configuration'
        }),
        patternFactExtractor({
            kind: 'storage',
            pattern: /\b(?:DB::|[A-Za-z_$][\w$]*->)(table|query|select|insert|update|delete|save|find)\s*\(/g,
            name: 1,
            target: 1,
            detail: 'uses a storage or database boundary'
        })
    ],
    annotation: createCurlyBraceAnnotation({
        languageName: 'PHP',
        definitionPatterns: [
            {kind: 'function', re: /^(?:public|private|protected|static|final|abstract|\s)*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/},
            {kind: 'class', re: /^(?:final\s+|abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'interface', re: /^interface\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'trait', re: /^trait\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'enum', re: /^enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/}
        ],
        bindingPatterns: [
            /^\$([A-Za-z_][A-Za-z0-9_]*)\s*=/,
            /^(?:public|private|protected|static|\s)*\$([A-Za-z_][A-Za-z0-9_]*)\s*=/
        ],
        callPattern: /\b([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?(?:->[A-Za-z_][A-Za-z0-9_]*)?)\s*\(/,
        callKeywords: ['if', 'for', 'foreach', 'while', 'switch', 'catch', 'return', 'throw', 'new']
    })
};

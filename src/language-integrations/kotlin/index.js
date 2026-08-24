import {patternFactExtractor} from '../common.js';
import {createCurlyBraceAnnotation} from '../annotation-factories.js';
import {JVM_SOURCE_POLICY} from '../source-policies.js';
import {javaDependency} from '../java/dependency.js';

export const integration = {
    id: 'kotlin',
    name: 'Kotlin',
    grammar: 'kotlin',
    family: 'c_like',
    aliases: ['kotlin', 'kt', 'kts'],
    extensions: ['.kt', '.kts'],
    filenames: [],
    source: JVM_SOURCE_POLICY,
    dependency: javaDependency,
    repo: {
        sourceRoles: ['application class', 'service class', 'scripted build logic'],
        supportingFiles: [
            {glob: '**/build.gradle.kts', role: 'manifest', terms: ['gradle', 'kotlin dsl', 'dependencies']},
            {glob: '**/settings.gradle.kts', role: 'manifest', terms: ['gradle', 'modules', 'workspace']},
            {glob: '**/gradle.properties', role: 'configuration', terms: ['gradle', 'properties', 'build']}
        ],
        questionTerms: ['kotlin', 'jvm', 'class', 'function', 'coroutine', 'gradle'],
        evidenceTerms: ['class', 'fun', 'import', 'annotation', 'package']
    },
    queries: {
        definitions: [
            {
                id: 'class-declaration',
                query: '(class_declaration (type_identifier) @name) @definition',
                detail: 'declares a Kotlin class'
            },
            {
                id: 'function-declaration',
                query: '(function_declaration (simple_identifier) @name) @definition',
                detail: 'declares a Kotlin function'
            }
        ],
        imports: [
            {
                id: 'import-header',
                query: '(import_header (identifier) @target) @import',
                nameCapture: 'target',
                targetCapture: 'target',
                detail: 'imports a Kotlin package or type'
            }
        ],
        calls: [
            {
                id: 'call-expression',
                query: '(call_expression (simple_identifier) @name) @call',
                detail: 'calls a Kotlin function'
            }
        ]
    },
    contract: {
        path: 'src/Checkout.kt',
        source: [
            'import kotlin.Int',
            'class CheckoutService {',
            '    fun checkout(): Int {',
            '        println("ok")',
            '        return 1',
            '    }',
            '}',
            'fun main() { CheckoutService().checkout() }'
        ].join('\n'),
        expectedFacts: [
            {kind: 'import', target: 'kotlin.Int'},
            {kind: 'definition', name: 'CheckoutService'},
            {kind: 'definition', name: 'checkout'},
            {kind: 'call', name: 'println'}
        ],
        expectedLineFacts: [
            {kind: 'entrypoint', name: 'main'}
        ],
        callLine: 'service.checkout()',
        excludedPaths: ['src/CheckoutTest.kt', 'build/generated/Checkout.kt'],
        dependencyManifestPaths: ['build.gradle.kts']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'route',
            pattern: /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*(?:\(\s*)?(?:value\s*=\s*|path\s*=\s*)?["']([^"']+)["']/g,
            name: (match) => `${springHttpMethod(match[1])} ${match[2]}`,
            target: 2,
            detail: 'declares a Kotlin web route'
        }),
        patternFactExtractor({
            kind: 'route',
            pattern: /\b(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/gi,
            name: (match) => `${match[1].toUpperCase()} ${match[2]}`,
            target: 2,
            detail: 'declares a Kotlin router route'
        }),
        patternFactExtractor({
            kind: 'configuration',
            pattern: /\bSystem\.getenv\(\s*"([^"]+)"/g,
            name: 1,
            target: 1,
            detail: 'reads configuration'
        }),
        patternFactExtractor({
            kind: 'storage',
            pattern: /\b([A-Za-z_][A-Za-z0-9_.]*)\.(save|findById|findAll|findOne|query|execute|update|delete|insert|select)\s*\(/g,
            name: (match) => `${match[1]}.${match[2]}`,
            target: 2,
            detail: 'uses a storage or database boundary'
        }),
        patternFactExtractor({
            kind: 'concurrency',
            pattern: /\b(launch|async|withContext)\s*\(/g,
            name: 1,
            target: 1,
            detail: 'starts or shifts coroutine work'
        }),
        patternFactExtractor({
            kind: 'entrypoint',
            pattern: /^fun\s+main\s*\(/g,
            name: 'main',
            target: 'main',
            detail: 'marks a Kotlin executable entrypoint'
        })
    ],
    annotation: createCurlyBraceAnnotation({
        languageName: 'Kotlin',
        definitionPatterns: [
            {kind: 'function', re: /^(?:public|private|protected|internal|suspend|inline|tailrec|operator|infix|\s)*fun\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/},
            {kind: 'class', re: /^(?:data\s+|sealed\s+|open\s+|abstract\s+|inner\s+|enum\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'interface', re: /^interface\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'object', re: /^(?:companion\s+)?object\s+([A-Za-z_][A-Za-z0-9_]*)\b/}
        ],
        bindingPatterns: [
            /^(?:val|var)\s+([A-Za-z_][A-Za-z0-9_]*)\b/
        ],
        callKeywords: ['if', 'for', 'while', 'when', 'catch', 'return', 'throw']
    })
};

function springHttpMethod(annotationName) {
    const method = String(annotationName || '').replace(/Mapping$/u, '').toUpperCase();
    return method === 'REQUEST' ? 'REQUEST' : method;
}

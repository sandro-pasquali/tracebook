import {patternFactExtractor} from '../common.js';
import {createCurlyBraceAnnotation} from '../annotation-factories.js';
import {JVM_SOURCE_POLICY} from '../source-policies.js';
import {javaDependency} from '../java/dependency.js';

export const integration = {
    id: 'scala',
    name: 'Scala',
    grammar: 'scala',
    family: 'c_like',
    aliases: ['scala', 'sc'],
    extensions: ['.scala', '.sc'],
    filenames: [],
    source: JVM_SOURCE_POLICY,
    dependency: javaDependency,
    repo: {
        sourceRoles: ['application class', 'service object', 'functional module'],
        supportingFiles: [
            {glob: '**/build.sbt', role: 'manifest', terms: ['sbt', 'dependencies', 'scala']},
            {glob: '**/project/*.sbt', role: 'manifest', terms: ['sbt', 'plugins', 'build']},
            {glob: '**/project/build.properties', role: 'configuration', terms: ['sbt', 'version', 'build']}
        ],
        questionTerms: ['scala', 'jvm', 'class', 'object', 'case class', 'sbt'],
        evidenceTerms: ['class', 'object', 'def', 'import', 'package']
    },
    queries: {
        definitions: [
            {
                id: 'class-definition',
                query: '(class_definition name: (identifier) @name) @definition',
                detail: 'declares a Scala class'
            },
            {
                id: 'function-definition',
                query: '(function_definition name: (identifier) @name) @definition',
                detail: 'declares a Scala function'
            }
        ],
        imports: [
            {
                id: 'import-declaration',
                query: '(import_declaration path: (stable_identifier) @target) @import',
                nameCapture: 'target',
                targetCapture: 'target',
                detail: 'imports a Scala package or type'
            }
        ],
        calls: [
            {
                id: 'call-expression',
                query: '(call_expression function: (identifier) @name) @call',
                detail: 'calls a Scala function'
            },
            {
                id: 'field-call-expression',
                query: '(call_expression function: (field_expression field: (identifier) @name)) @call',
                detail: 'calls a Scala member'
            }
        ]
    },
    contract: {
        path: 'src/Main.scala',
        source: [
            'import scala.collection.mutable',
            'class CheckoutService {',
            '  def checkout(order: Int): Int = {',
            '    val token = sys.env("API_TOKEN")',
            '    println(order)',
            '    order',
            '  }',
            '}',
            'object Main { def main(args: Array[String]): Unit = service.checkout(1) }'
        ].join('\n'),
        expectedFacts: [
            {kind: 'import', target: 'scala.collection.mutable'},
            {kind: 'definition', name: 'CheckoutService'},
            {kind: 'definition', name: 'checkout'},
            {kind: 'call', name: 'println'}
        ],
        expectedLineFacts: [
            {kind: 'configuration', name: 'API_TOKEN'},
            {kind: 'entrypoint', name: 'main'}
        ],
        callLine: 'service.checkout(order)',
        excludedPaths: ['src/MainSpec.scala', 'target/generated/Main.scala'],
        dependencyManifestPaths: ['build.sbt'],
        dependencyFixtures: [
            {
                path: 'build.sbt',
                content: 'libraryDependencies += "com.typesafe.akka" %% "akka-http" % "10.5.3"\n',
                expectedDocs: [
                    {path: '__dependencies__/jvm/com.typesafe.akka__akka-http__10.5.3.md', includes: ['com.typesafe.akka:akka-http:10.5.3']}
                ]
            }
        ]
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'route',
            pattern: /\bpath(?:Prefix)?\(\s*"([^"]+)"/g,
            name: (match) => `PATH ${match[1]}`,
            target: 1,
            detail: 'declares a Scala HTTP route path'
        }),
        patternFactExtractor({
            kind: 'configuration',
            pattern: /\bsys\.env(?:\.get)?\(\s*"([^"]+)"/g,
            name: 1,
            target: 1,
            detail: 'reads configuration'
        }),
        patternFactExtractor({
            kind: 'storage',
            pattern: /\b([A-Za-z_][A-Za-z0-9_.]*)\.(run|result|execute|update|insert|delete|find|save)\s*\(/g,
            name: (match) => `${match[1]}.${match[2]}`,
            target: 2,
            detail: 'uses a storage or database boundary'
        }),
        patternFactExtractor({
            kind: 'entrypoint',
            pattern: /\bdef\s+main\s*\(/g,
            name: 'main',
            target: 'main',
            detail: 'marks a Scala executable entrypoint'
        })
    ],
    annotation: createCurlyBraceAnnotation({
        languageName: 'Scala',
        definitionPatterns: [
            {kind: 'function', re: /^(?:override\s+|private\s+|protected\s+|final\s+|implicit\s+|inline\s+)*def\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'class', re: /^(?:case\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'object', re: /^(?:case\s+)?object\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'trait', re: /^trait\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'enum', re: /^enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/}
        ],
        bindingPatterns: [
            /^(?:lazy\s+)?(?:val|var)\s+([A-Za-z_][A-Za-z0-9_]*)\b/
        ],
        callKeywords: ['if', 'for', 'while', 'match', 'case', 'return', 'throw']
    })
};

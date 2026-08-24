import {patternFactExtractor} from '../common.js';
import {createCurlyBraceAnnotation} from '../annotation-factories.js';
import {JVM_SOURCE_POLICY} from '../source-policies.js';
import {javaDependency} from './dependency.js';

export const integration = {
    id: 'java',
    name: 'Java',
    grammar: 'java',
    family: 'c_like',
    aliases: ['java'],
    extensions: ['.java'],
    filenames: [],
    source: JVM_SOURCE_POLICY,
    dependency: javaDependency,
    repo: {
        sourceRoles: ['application class', 'service class', 'controller', 'domain model'],
        supportingFiles: [
            {glob: '**/gradle.properties', role: 'configuration', terms: ['gradle', 'properties', 'build']},
            {glob: '**/.mvn/maven.config', role: 'configuration', terms: ['maven', 'flags', 'build']},
            {glob: '**/settings.gradle.kts', role: 'manifest', terms: ['gradle', 'modules', 'workspace']}
        ],
        questionTerms: ['java', 'jvm', 'class', 'method', 'service', 'controller', 'spring'],
        evidenceTerms: ['class', 'method', 'import', 'annotation', 'package']
    },
    queries: {
        definitions: [
            {
                id: 'class-declaration',
                query: '(class_declaration name: (identifier) @name) @definition',
                detail: 'declares a Java class'
            },
            {
                id: 'method-declaration',
                query: '(method_declaration name: (identifier) @name) @definition',
                detail: 'declares a Java method'
            }
        ],
        imports: [
            {
                id: 'import-declaration',
                query: '(import_declaration (scoped_identifier) @target) @import',
                nameCapture: 'target',
                targetCapture: 'target',
                detail: 'imports a Java package or type'
            }
        ],
        calls: [
            {
                id: 'method-invocation',
                query: '(method_invocation name: (identifier) @name) @call',
                detail: 'calls a Java method'
            }
        ]
    },
    contract: {
        path: 'src/CheckoutService.java',
        source: [
            'import java.util.List;',
            '@RestController',
            'public class CheckoutService {',
            ['    @Value("', '{API_TOKEN}")'].join('$'),
            '    private String token;',
            '    public int checkout() {',
            '        System.out.println("ok");',
            '        return 1;',
            '    }',
            '}'
        ].join('\n'),
        expectedFacts: [
            {kind: 'import', target: 'java.util.List'},
            {kind: 'definition', name: 'CheckoutService'},
            {kind: 'definition', name: 'checkout'},
            {kind: 'call', name: 'println'}
        ],
        expectedLineFacts: [
            {kind: 'component', name: 'RestController'},
            {kind: 'configuration', name: 'API_TOKEN'}
        ],
        callLine: 'service.checkout();',
        excludedPaths: ['src/CheckoutServiceTest.java', 'target/generated/CheckoutService.java'],
        dependencyManifestPaths: ['pom.xml', 'build.gradle']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'route',
            pattern: /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*(?:\(\s*)?(?:value\s*=\s*|path\s*=\s*)?["']([^"']+)["']/g,
            name: (match) => `${springHttpMethod(match[1])} ${match[2]}`,
            target: 2,
            detail: 'declares a Java web route'
        }),
        patternFactExtractor({
            kind: 'configuration',
            pattern: /\bSystem\.getenv\(\s*"([^"]+)"/g,
            name: 1,
            target: 1,
            detail: 'reads configuration'
        }),
        patternFactExtractor({
            kind: 'configuration',
            pattern: /@Value\(\s*["']\$\{([^}"']+)/g,
            name: 1,
            target: 1,
            detail: 'injects Spring configuration'
        }),
        patternFactExtractor({
            kind: 'storage',
            pattern: /\b([A-Za-z_][A-Za-z0-9_.]*)\.(save|findById|findAll|findOne|query|queryForObject|execute|update|delete|insert|select)\s*\(/g,
            name: (match) => `${match[1]}.${match[2]}`,
            target: 2,
            detail: 'uses a storage or database boundary'
        }),
        patternFactExtractor({
            kind: 'component',
            pattern: /@(RestController|Controller|Service|Component|Repository|Entity|Configuration)\b/g,
            name: 1,
            target: 1,
            detail: 'declares a Java framework component'
        }),
        patternFactExtractor({
            kind: 'entrypoint',
            pattern: /\bpublic\s+static\s+void\s+main\s*\(/g,
            name: 'main',
            target: 'main',
            detail: 'marks a Java executable entrypoint'
        })
    ],
    annotation: createCurlyBraceAnnotation({
        languageName: 'Java',
        definitionPatterns: [
            {kind: 'class', re: /^(?:public|private|protected|abstract|final|static|\s)*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'interface', re: /^(?:public|private|protected|abstract|sealed|non-sealed|\s)*interface\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'enum', re: /^(?:public|private|protected|static|\s)*enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'record', re: /^(?:public|private|protected|static|final|\s)*record\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'method', re: /^(?:public|private|protected|static|final|abstract|synchronized|native|strictfp|\s)*(?:[A-Za-z_][A-Za-z0-9_<>, ?.[\]]+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:throws\b[^{]+)?\{?$/}
        ],
        bindingPatterns: [
            /^(?:final\s+)?(?:[A-Za-z_][A-Za-z0-9_<>, ?.[\]]+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*=/
        ],
        callKeywords: ['if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'new']
    })
};

function springHttpMethod(annotationName) {
    const method = String(annotationName || '').replace(/Mapping$/u, '').toUpperCase();
    return method === 'REQUEST' ? 'REQUEST' : method;
}

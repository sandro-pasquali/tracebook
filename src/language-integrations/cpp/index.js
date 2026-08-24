import {patternFactExtractor} from '../common.js';
import {createCurlyBraceAnnotation} from '../annotation-factories.js';
import {C_LIKE_SOURCE_POLICY} from '../source-policies.js';
import {nativeDependency} from '../c/dependency.js';

export const integration = {
    id: 'cpp',
    name: 'C++',
    grammar: 'cpp',
    family: 'c_like',
    aliases: ['cpp', 'c++', 'cxx'],
    extensions: ['.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'],
    filenames: [],
    source: C_LIKE_SOURCE_POLICY,
    dependency: nativeDependency,
    repo: {
        sourceRoles: ['native implementation', 'library interface', 'runtime boundary'],
        supportingFiles: [
            {glob: '**/CMakeLists.txt', role: 'build', terms: ['cmake', 'target', 'library']},
            {glob: '**/Makefile', role: 'build', terms: ['make', 'compiler', 'target']},
            {glob: '**/compile_commands.json', role: 'configuration', terms: ['compiler', 'include', 'flags']}
        ],
        questionTerms: ['cpp', 'c++', 'native', 'compile', 'class', 'memory', 'template'],
        evidenceTerms: ['include', 'class', 'method', 'header', 'compiler', 'linker']
    },
    queries: {
        definitions: [
            {
                id: 'class-specifier',
                query: '(class_specifier name: (type_identifier) @name) @definition',
                detail: 'declares a C++ class'
            },
            {
                id: 'function-definition',
                query: '(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition',
                detail: 'declares a C++ function'
            },
            {
                id: 'method-definition',
                query: '(function_definition declarator: (function_declarator declarator: (field_identifier) @name)) @definition',
                detail: 'declares a C++ method'
            }
        ],
        imports: [
            {
                id: 'preprocessor-include',
                query: '(preproc_include path: (_) @target) @import',
                nameCapture: 'target',
                targetCapture: 'target',
                detail: 'includes a C++ header'
            }
        ],
        calls: [
            {
                id: 'call-expression',
                query: '(call_expression function: (identifier) @name) @call',
                detail: 'calls a C++ function'
            },
            {
                id: 'field-call-expression',
                query: '(call_expression function: (field_expression field: (field_identifier) @name)) @call',
                detail: 'calls a C++ member function'
            }
        ]
    },
    contract: {
        path: 'src/native.cpp',
        source: [
            '#include <vector>',
            'int compute_total() { return 1; }',
            'class CheckoutService {',
            'public:',
            '    int checkout() { auto *value = new int(compute_total()); delete value; return compute_total(); }',
            '};',
            'int main() { CheckoutService service; return service.checkout(); }'
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'compute_total'},
            {kind: 'definition', name: 'CheckoutService'},
            {kind: 'definition', name: 'checkout'},
            {kind: 'import', target: '<vector>'},
            {kind: 'call', name: 'compute_total'}
        ],
        expectedLineFacts: [
            {kind: 'memory', name: 'new'},
            {kind: 'memory', name: 'delete'},
            {kind: 'entrypoint', name: 'main'}
        ],
        callLine: 'service.checkout();',
        excludedPaths: ['tests/native.cpp', 'src/cmake-build-debug/native.cpp'],
        dependencyManifestPaths: ['conanfile.txt']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'memory',
            pattern: /\b(new|delete|make_unique|make_shared)\b/g,
            name: 1,
            target: 1,
            detail: 'uses a C++ memory ownership boundary'
        }),
        patternFactExtractor({
            kind: 'io',
            pattern: /\b(std::)?(cout|cerr|ifstream|ofstream|fstream|printf|fprintf)\b/g,
            name: (match) => `${match[1] || ''}${match[2]}`,
            target: 2,
            detail: 'uses a C++ I/O boundary'
        }),
        patternFactExtractor({
            kind: 'entrypoint',
            pattern: /\bmain\s*\(/g,
            name: 'main',
            target: 'main',
            detail: 'marks a C++ executable entrypoint'
        })
    ],
    annotation: createCurlyBraceAnnotation({
        languageName: 'C++',
        definitionPatterns: [
            {kind: 'class', re: /^(?:template\s*<[^>]+>\s*)?(?:class|struct)\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'enum', re: /^(?:enum\s+(?:class\s+)?)\s*([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'namespace', re: /^namespace\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'function', re: /^(?:template\s*<[^>]+>\s*)?(?:static\s+|inline\s+|constexpr\s+|virtual\s+|explicit\s+|extern\s+)*(?:[A-Za-z_:][A-Za-z0-9_:<>~]*[\s*&]+)+([A-Za-z_~][A-Za-z0-9_:~]*)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{?$/}
        ],
        bindingPatterns: [
            /^(?:auto|const|static|constexpr|volatile|unsigned|signed|std::[A-Za-z0-9_:<>]+|[A-Za-z_:][A-Za-z0-9_:<>]*)[\s*&]+([A-Za-z_][A-Za-z0-9_]*)\s*=/
        ],
        callKeywords: ['if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'new', 'delete']
    })
};

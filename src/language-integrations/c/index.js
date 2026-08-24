import {patternFactExtractor} from '../common.js';
import {createCurlyBraceAnnotation} from '../annotation-factories.js';
import {C_LIKE_SOURCE_POLICY} from '../source-policies.js';
import {nativeDependency} from './dependency.js';

export const integration = {
    id: 'c',
    name: 'C',
    grammar: 'c',
    family: 'c_like',
    aliases: ['c'],
    extensions: ['.c'],
    filenames: [],
    source: C_LIKE_SOURCE_POLICY,
    dependency: nativeDependency,
    repo: {
        sourceRoles: ['native implementation', 'system library', 'runtime boundary'],
        supportingFiles: [
            {glob: '**/CMakeLists.txt', role: 'build', terms: ['cmake', 'target', 'library']},
            {glob: '**/Makefile', role: 'build', terms: ['make', 'compiler', 'target']},
            {glob: '**/compile_commands.json', role: 'configuration', terms: ['compiler', 'include', 'flags']}
        ],
        questionTerms: ['c', 'native', 'compile', 'memory', 'pointer', 'system'],
        evidenceTerms: ['include', 'function', 'header', 'compiler', 'linker']
    },
    queries: {
        definitions: [
            {
                id: 'function-definition',
                query: '(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition',
                detail: 'declares a C function'
            }
        ],
        imports: [
            {
                id: 'preprocessor-include',
                query: '(preproc_include path: (_) @target) @import',
                nameCapture: 'target',
                targetCapture: 'target',
                detail: 'includes a C header'
            }
        ],
        calls: [
            {
                id: 'call-expression',
                query: '(call_expression function: (identifier) @name) @call',
                detail: 'calls a C function'
            }
        ]
    },
    contract: {
        path: 'src/native.c',
        source: [
            '#include <stdio.h>',
            '#include <stdlib.h>',
            'static int checkout_order(int id) {',
            '    void *buffer = malloc(16);',
            '    free(buffer);',
            '    printf("checkout");',
            '    return id;',
            '}',
            'int main(void) {',
            '    return checkout_order(1);',
            '}'
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'checkout_order'},
            {kind: 'import', target: '<stdio.h>'},
            {kind: 'call', name: 'printf'}
        ],
        expectedLineFacts: [
            {kind: 'memory', name: 'malloc'},
            {kind: 'memory', name: 'free'},
            {kind: 'entrypoint', name: 'main'}
        ],
        callLine: 'printf("ok");',
        excludedPaths: ['tests/native.c', 'build/native.c'],
        dependencyManifestPaths: ['CMakeLists.txt', 'vcpkg.json'],
        dependencyFixtures: [
            {
                path: 'CMakeLists.txt',
                content: [
                    'find_package(OpenSSL REQUIRED)',
                    'target_link_libraries(native PRIVATE OpenSSL::SSL)'
                ].join('\n'),
                expectedDocs: [
                    {path: '__dependencies__/native/OpenSSL.md', includes: ['OpenSSL', 'cmake.find_package']},
                    {path: '__dependencies__/native/OpenSSL__SSL.md', includes: ['OpenSSL::SSL', 'cmake.target_link_libraries']}
                ]
            }
        ]
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'memory',
            pattern: /\b(malloc|calloc|realloc|free)\s*\(/g,
            name: 1,
            target: 1,
            detail: 'uses a C memory management boundary'
        }),
        patternFactExtractor({
            kind: 'io',
            pattern: /\b(fopen|fread|fwrite|read|write|close|printf|fprintf)\s*\(/g,
            name: 1,
            target: 1,
            detail: 'uses a C I/O boundary'
        }),
        patternFactExtractor({
            kind: 'entrypoint',
            pattern: /\bmain\s*\(\s*(?:void|int\s+argc)?/g,
            name: 'main',
            target: 'main',
            detail: 'marks a C executable entrypoint'
        })
    ],
    annotation: createCurlyBraceAnnotation({
        languageName: 'C',
        definitionPatterns: [
            {kind: 'function', re: /^(?:static\s+|inline\s+|extern\s+)*(?:[A-Za-z_][A-Za-z0-9_]*[\s*]+)+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/},
            {kind: 'struct', re: /^(?:typedef\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'enum', re: /^(?:typedef\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'union', re: /^(?:typedef\s+)?union\s+([A-Za-z_][A-Za-z0-9_]*)\b/}
        ],
        bindingPatterns: [
            /^(?:static\s+|const\s+|volatile\s+|unsigned\s+|signed\s+)*(?:[A-Za-z_][A-Za-z0-9_]*[\s*]+)+([A-Za-z_][A-Za-z0-9_]*)\s*=/
        ],
        callKeywords: ['if', 'for', 'while', 'switch', 'return', 'sizeof']
    })
};

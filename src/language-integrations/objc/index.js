import {patternFactExtractor} from '../common.js';
import {createCurlyBraceAnnotation} from '../annotation-factories.js';
import {C_LIKE_SOURCE_POLICY} from '../source-policies.js';

export const integration = {
    id: 'objc',
    name: 'Objective-C',
    grammar: 'objc',
    family: 'c_like',
    aliases: ['objc', 'objective-c'],
    extensions: ['.m', '.mm'],
    filenames: [],
    source: C_LIKE_SOURCE_POLICY,
    repo: {
        sourceRoles: ['native application source', 'runtime bridge', 'platform class'],
        supportingFiles: [
            {glob: '**/*.xcodeproj/project.pbxproj', role: 'manifest', terms: ['xcode project', 'target', 'build']},
            {glob: '**/*.xcconfig', role: 'configuration', terms: ['xcode config', 'build setting']},
            {glob: '**/Info.plist', role: 'configuration', terms: ['bundle metadata', 'platform settings']}
        ],
        questionTerms: ['objective-c', 'objc', 'class', 'selector', 'platform', 'native'],
        evidenceTerms: ['interface', 'implementation', 'method', 'import', 'selector']
    },
    queries: {
        definitions: [
            {
                id: 'class-interface',
                query: '(class_interface . (identifier) @name) @definition',
                detail: 'declares an Objective-C interface'
            },
            {
                id: 'method-definition',
                query: '(method_definition (method_type) (identifier) @name) @definition',
                detail: 'declares an Objective-C method'
            }
        ],
        imports: [
            {
                id: 'preprocessor-include',
                query: '(preproc_include path: (_) @target) @import',
                nameCapture: 'target',
                targetCapture: 'target',
                detail: 'imports an Objective-C header'
            }
        ]
    },
    contract: {
        path: 'src/Checkout.mm',
        source: [
            '#import <Foundation/Foundation.h>',
            '@interface CheckoutService : NSObject',
            '- (int)checkout;',
            '@end',
            '@implementation CheckoutService',
            '- (int)checkout { NSLog(@"checkout"); return 1; }',
            '@end'
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'CheckoutService'},
            {kind: 'definition', name: 'checkout'},
            {kind: 'import', target: '<Foundation/Foundation.h>'}
        ],
        expectedLineFacts: [
            {kind: 'platform_log', name: 'NSLog'}
        ],
        callLine: '[service checkout];',
        excludedPaths: ['tests/Checkout.mm', 'build/Checkout.mm']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'platform_log',
            pattern: /\b(NSLog)\s*\(/g,
            name: 1,
            target: 1,
            detail: 'uses Objective-C platform logging'
        }),
        patternFactExtractor({
            kind: 'notification',
            pattern: /\bNSNotificationCenter\b|\bpostNotificationName\s*:/g,
            name: 'NSNotificationCenter',
            target: 'NSNotificationCenter',
            detail: 'uses Objective-C notification delivery'
        }),
        patternFactExtractor({
            kind: 'memory',
            pattern: /\b(alloc|init|retain|release|autorelease)\b/g,
            name: 1,
            target: 1,
            detail: 'uses Objective-C object lifetime management'
        })
    ],
    annotation: createCurlyBraceAnnotation({
        languageName: 'Objective-C',
        definitionPatterns: [
            {kind: 'interface', re: /^@interface\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'implementation', re: /^@implementation\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'method', re: /^[-+]\s*\([^)]*\)\s*([A-Za-z_][A-Za-z0-9_]*)/},
            {kind: 'function', re: /^(?:static\s+|inline\s+|extern\s+)*(?:[A-Za-z_][A-Za-z0-9_]*[\s*]+)+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/}
        ],
        bindingPatterns: [
            /^(?:__block\s+|static\s+|const\s+)*(?:[A-Za-z_][A-Za-z0-9_]*[\s*]+)+([A-Za-z_][A-Za-z0-9_]*)\s*=/
        ],
        callKeywords: ['if', 'for', 'while', 'switch', 'return', 'sizeof', 'new']
    })
};

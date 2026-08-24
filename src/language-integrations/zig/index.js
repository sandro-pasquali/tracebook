import {patternFactExtractor} from '../common.js';
import {createCurlyBraceAnnotation} from '../annotation-factories.js';
import {ZIG_SOURCE_POLICY} from '../source-policies.js';

export const integration = {
    id: 'zig',
    name: 'Zig',
    grammar: 'zig',
    family: 'zig',
    aliases: ['zig'],
    extensions: ['.zig'],
    filenames: [],
    source: ZIG_SOURCE_POLICY,
    repo: {
        sourceRoles: ['systems module', 'build script', 'binary entrypoint', 'library module'],
        supportingFiles: [
            {glob: '**/build.zig.zon', role: 'manifest', terms: ['zig package', 'dependency', 'build']}
        ],
        questionTerms: ['zig', 'comptime', 'allocator', 'build', 'systems'],
        evidenceTerms: ['fn', 'const', 'struct', 'import', 'comptime']
    },
    queries: {
        definitions: [
            {
                id: 'function-declaration',
                query: '(function_declaration name: (identifier) @name) @definition',
                detail: 'declares a Zig function'
            },
            {
                id: 'variable-declaration',
                query: '(variable_declaration (identifier) @name) @definition',
                detail: 'declares a Zig binding'
            }
        ],
        imports: [
            {
                id: 'builtin-import',
                query: [
                    '(',
                    '  (builtin_function (builtin_identifier) @callee (arguments (string (string_content) @target))) @import',
                    '  (#eq? @callee "@import")',
                    ')'
                ].join('\n'),
                nameCapture: 'target',
                targetCapture: 'target',
                detail: 'imports a Zig package'
            }
        ]
    },
    contract: {
        path: 'src/main.zig',
        source: [
            'const std = @import("std");',
            'pub fn checkout(order: i32) i32 {',
            '    errdefer std.log.err("checkout failed", .{});',
            '    return order;',
            '}',
            'pub fn main() !void {',
            '    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);',
            '    defer arena.deinit();',
            '}'
        ].join('\n'),
        expectedFacts: [
            {kind: 'import', target: 'std'},
            {kind: 'definition', name: 'std'},
            {kind: 'definition', name: 'checkout'}
        ],
        expectedLineFacts: [
            {kind: 'error_boundary', name: 'errdefer'},
            {kind: 'memory', name: 'ArenaAllocator'},
            {kind: 'entrypoint', name: 'main'}
        ],
        callLine: '@import("std")',
        excludedPaths: ['test/main.zig', 'zig-cache/main.zig', 'zig-out/main.zig']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'memory',
            pattern: /\b(ArenaAllocator|GeneralPurposeAllocator|allocator\.(?:alloc|create|destroy|free))\b/g,
            name: 1,
            target: 1,
            detail: 'uses a Zig allocation boundary'
        }),
        patternFactExtractor({
            kind: 'error_boundary',
            pattern: /\b(try|catch|errdefer|unreachable)\b/g,
            name: 1,
            target: 1,
            detail: 'handles Zig error control flow'
        }),
        patternFactExtractor({
            kind: 'entrypoint',
            pattern: /^(?:pub\s+)?fn\s+main\s*\(/g,
            name: 'main',
            target: 'main',
            detail: 'marks a Zig executable entrypoint'
        })
    ],
    annotation: createCurlyBraceAnnotation({
        languageName: 'Zig',
        definitionPatterns: [
            {kind: 'function', re: /^(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/},
            {kind: 'type', re: /^(?:pub\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:struct|enum|union|opaque)\b/}
        ],
        bindingPatterns: [
            /^(?:const|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/
        ],
        callKeywords: ['if', 'for', 'while', 'switch', 'return', 'try', 'catch', 'defer', 'errdefer'],
        outputPattern: /\b(return|try|catch|break|continue|unreachable)\b/
    })
};

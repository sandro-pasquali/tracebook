import {patternFactExtractor} from '../common.js';
import {createBlockAnnotation} from '../annotation-factories.js';
import {FUNCTIONAL_SOURCE_POLICY} from '../source-policies.js';

export const integration = {
    id: 'lua',
    name: 'Lua',
    grammar: 'lua',
    family: 'lua',
    aliases: ['lua'],
    extensions: ['.lua'],
    filenames: [],
    source: FUNCTIONAL_SOURCE_POLICY,
    repo: {
        sourceRoles: ['script module', 'configuration script', 'embedded runtime module'],
        supportingFiles: [
            {glob: '**/*.rockspec', role: 'manifest', terms: ['luarocks', 'dependency', 'module']},
            {glob: '**/.luacheckrc', role: 'configuration', terms: ['luacheck', 'lint', 'rules']}
        ],
        questionTerms: ['lua', 'script', 'module', 'table', 'runtime'],
        evidenceTerms: ['function', 'local', 'require', 'table', 'return']
    },
    queries: {
        definitions: [
            {
                id: 'function-definition',
                query: '(function_definition_statement name: (identifier) @name) @definition',
                detail: 'declares a Lua function'
            }
        ],
        calls: [
            {
                id: 'call',
                query: '(call function: (variable name: (identifier) @name)) @call',
                detail: 'calls a Lua function'
            }
        ]
    },
    contract: {
        path: 'src/view.lua',
        source: [
            'function checkout(order)',
            '  local token = os.getenv("API_TOKEN")',
            '  return order',
            'end',
            'checkout(1)'
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'checkout'},
            {kind: 'call', name: 'checkout'}
        ],
        expectedLineFacts: [
            {kind: 'configuration', name: 'API_TOKEN'}
        ],
        callLine: 'checkout(1)',
        excludedPaths: ['test/view.lua', 'dist/view.lua']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'definition',
            pattern: /^function\s+([A-Za-z_][A-Za-z0-9_.:]*)\s*\(/g,
            name: 1,
            target: 1,
            detail: 'declares a Lua function'
        }),
        patternFactExtractor({
            kind: 'configuration',
            pattern: /\bos\.getenv\(\s*["']([^"']+)["']/g,
            name: 1,
            target: 1,
            detail: 'reads configuration'
        }),
        patternFactExtractor({
            kind: 'module',
            pattern: /\brequire\(\s*["']([^"']+)["']/g,
            name: 1,
            target: 1,
            detail: 'loads a Lua module'
        })
    ],
    annotation: createBlockAnnotation({
        languageName: 'Lua',
        definitionPatterns: [
            {kind: 'function', re: /^function\s+([A-Za-z_][A-Za-z0-9_.:]*)\s*\(/},
            {kind: 'function', re: /^local\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/}
        ],
        bindingPatterns: [
            /^(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/
        ],
        callKeywords: ['if', 'then', 'else', 'elseif', 'for', 'while', 'repeat', 'until', 'function', 'local', 'end', 'return'],
        commentPattern: /^--/,
        branchPattern: /\b(if|elseif|else)\b/,
        iterationPattern: /\b(for|while|repeat|until)\b/,
        outputPattern: /\b(return|error)\b/
    })
};

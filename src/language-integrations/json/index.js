import {patternFactExtractor} from '../common.js';
import {createConfigAnnotation} from '../annotation-factories.js';
import {CONFIG_SOURCE_POLICY} from '../source-policies.js';

export const integration = {
    id: 'json',
    name: 'JSON',
    grammar: 'json',
    family: 'json',
    aliases: ['json'],
    extensions: ['.json'],
    filenames: [],
    source: CONFIG_SOURCE_POLICY,
    repo: {
        sourceRoles: ['structured configuration', 'manifest', 'machine-readable metadata'],
        supportingFiles: [
            {glob: '**/*.schema.json', role: 'schema', terms: ['json schema', 'validation', 'configuration']},
            {glob: '**/.eslintrc.json', role: 'configuration', terms: ['eslint', 'lint', 'rules']}
        ],
        questionTerms: ['json', 'configuration', 'manifest', 'schema', 'settings', 'metadata'],
        evidenceTerms: ['key', 'value', 'object', 'array', 'schema', 'manifest']
    },
    annotation: createConfigAnnotation({languageName: 'JSON', entrySeparator: ':'}),
    queries: [
        {
            kind: 'configuration',
            id: 'object-pair',
            query: '(pair key: (string (string_content) @name) value: (_) @target) @configuration',
            targetCapture: 'target',
            detail: 'declares JSON configuration'
        }
    ],
    contract: {
        path: 'package.json',
        source: [
            '{',
            '  "name": "checkout",',
            '  "scripts": {',
            '    "test": "node --test"',
            '  },',
            '  "enabled": true',
            '}'
        ].join('\n'),
        expectedFacts: [
            {kind: 'configuration', name: 'name'},
            {kind: 'configuration', name: 'enabled'}
        ],
        expectedLineFacts: [
            {kind: 'script', name: 'test'}
        ],
        callLine: '"enabled": true',
        excludedPaths: ['test/app.json', 'node_modules/pkg/package.json']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'configuration',
            pattern: /^["']?([A-Za-z0-9_.-]+)["']?\s*:\s*(.+)$/g,
            name: 1,
            target: 2,
            detail: 'declares configuration'
        }),
        jsonPackageFact
    ]
};

function jsonPackageFact(line, context = {}) {
    if(String(context.path || '').split(/[\\/]/u).pop() !== 'package.json') {
        return [];
    }
    const script = String(line || '').match(/^"([A-Za-z0-9:_-]+)"\s*:\s*"([^"]+)"[,]?$/u);
    if(!script || !NPM_SCRIPT_NAMES.has(script[1])) {
        return [];
    }
    return [{
        kind: 'script',
        name: script[1],
        target: script[2],
        detail: 'declares an npm script'
    }];
}

const NPM_SCRIPT_NAMES = new Set(['test', 'start', 'build', 'dev', 'lint', 'format', 'typecheck', 'serve', 'preview', 'prepare', 'postinstall']);

import {patternFactExtractor} from '../common.js';
import {createCurlyBraceAnnotation} from '../annotation-factories.js';
import {FUNCTIONAL_SOURCE_POLICY} from '../source-policies.js';

export const integration = {
    id: 'rescript',
    name: 'ReScript',
    grammar: 'rescript',
    family: 'rescript',
    aliases: ['rescript', 'res'],
    extensions: ['.res', '.resi'],
    filenames: [],
    source: FUNCTIONAL_SOURCE_POLICY,
    repo: {
        sourceRoles: ['module implementation', 'module interface', 'typed UI module'],
        supportingFiles: [
            {glob: '**/rescript.json', role: 'configuration', terms: ['rescript', 'compiler', 'packages']},
            {glob: '**/bsconfig.json', role: 'configuration', terms: ['rescript', 'bucklescript', 'packages']}
        ],
        questionTerms: ['rescript', 'module', 'variant', 'record', 'compiler'],
        evidenceTerms: ['module', 'let', 'type', 'variant', 'record']
    },
    queries: {
        definitions: [
            {
                id: 'module-binding',
                query: '(module_binding name: (module_identifier) @name) @definition',
                detail: 'declares a ReScript module'
            },
            {
                id: 'let-binding',
                query: '(let_binding pattern: (value_identifier) @name) @definition',
                detail: 'declares a ReScript binding'
            }
        ]
    },
    contract: {
        path: 'src/checkout.res',
        source: [
            'module Checkout = {',
            '  let run = 1',
            '}',
            'let selected = Checkout.run'
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'Checkout'},
            {kind: 'definition', name: 'run'},
            {kind: 'definition', name: 'selected'}
        ],
        callLine: 'Checkout.run()',
        excludedPaths: ['test/checkout.res', 'dist/checkout.res']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'definition',
            pattern: /^module\s+([A-Z][A-Za-z0-9_]*)\b/g,
            name: 1,
            target: 1,
            detail: 'declares a ReScript module'
        }),
        patternFactExtractor({
            kind: 'definition',
            pattern: /^\s*let\s+([a-z_][A-Za-z0-9_]*)\s*=/g,
            name: 1,
            target: 1,
            detail: 'declares a ReScript binding'
        })
    ],
    annotation: createCurlyBraceAnnotation({
        languageName: 'ReScript',
        definitionPatterns: [
            {kind: 'function', re: /^let\s+([a-z_][A-Za-z0-9_]*)\s*=/},
            {kind: 'module', re: /^module\s+([A-Z][A-Za-z0-9_]*)\b/},
            {kind: 'type', re: /^type\s+([a-z_][A-Za-z0-9_]*)\b/}
        ],
        bindingPatterns: [
            /^let\s+([a-z_][A-Za-z0-9_]*)\s*=/
        ],
        callPattern: /\b([A-Za-z_][A-Za-z0-9_.]*)\s*\(/,
        callKeywords: ['if', 'switch', 'let', 'module', 'type']
    })
};

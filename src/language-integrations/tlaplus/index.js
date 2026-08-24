import {patternFactExtractor} from '../common.js';
import {createBlockAnnotation} from '../annotation-factories.js';
import {FUNCTIONAL_SOURCE_POLICY} from '../source-policies.js';

export const integration = {
    id: 'tlaplus',
    name: 'TLA+',
    grammar: 'tlaplus',
    family: 'tlaplus',
    aliases: ['tlaplus', 'tla+'],
    extensions: ['.tla'],
    filenames: [],
    source: FUNCTIONAL_SOURCE_POLICY,
    repo: {
        sourceRoles: ['formal specification', 'state machine model', 'invariant model'],
        supportingFiles: [
            {glob: '**/MC.cfg', role: 'configuration', terms: ['model checking', 'constants', 'invariants']},
            {glob: '**/TLC.cfg', role: 'configuration', terms: ['model checking', 'constants', 'invariants']}
        ],
        questionTerms: ['tla+', 'specification', 'invariant', 'state', 'operator', 'model checking'],
        evidenceTerms: ['module', 'variable', 'operator', 'invariant', 'theorem']
    },
    queries: {
        definitions: [
            {
                id: 'module',
                query: '(module name: (identifier) @name) @definition',
                detail: 'declares a TLA+ module'
            },
            {
                id: 'variable-declaration',
                query: '(variable_declaration (identifier) @name) @definition',
                detail: 'declares a TLA+ variable'
            },
            {
                id: 'operator-definition',
                query: '(operator_definition name: (identifier) @name) @definition',
                detail: 'declares a TLA+ operator'
            }
        ]
    },
    contract: {
        path: 'spec/Checkout.tla',
        source: [
            '---- MODULE Checkout ----',
            'VARIABLE x',
            'Init == x = 0',
            "Next == x' = x + 1",
            'Invariant == x >= 0',
            '===='
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'Checkout'},
            {kind: 'definition', name: 'x'},
            {kind: 'definition', name: 'Init'}
        ],
        expectedLineFacts: [
            {kind: 'action', name: 'Next'},
            {kind: 'invariant', name: 'Invariant'}
        ],
        callLine: 'Init == x = 0',
        excludedPaths: ['test/Checkout.tla', 'dist/Checkout.tla']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'invariant',
            pattern: /^(Invariant|Safety|TypeOK|[A-Za-z_][A-Za-z0-9_]*(?:Inv|Invariant))\s*==|^([A-Za-z_][A-Za-z0-9_]*)\s*==.*(?:>=|<=|\\in|UNCHANGED)/g,
            name: (match) => match[1] || match[2],
            target: (match) => match[1] || match[2],
            detail: 'declares a TLA+ invariant or state property'
        }),
        patternFactExtractor({
            kind: 'action',
            pattern: /^([A-Za-z_][A-Za-z0-9_]*)\s*==.*'/g,
            name: 1,
            target: 1,
            detail: 'declares a TLA+ next-state action'
        })
    ],
    annotation: createBlockAnnotation({
        languageName: 'TLA+',
        definitionPatterns: [
            {kind: 'module', re: /^----\s*MODULE\s+([A-Za-z_][A-Za-z0-9_]*)\s*----/},
            {kind: 'operator', re: /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*==/},
            {kind: 'variable', re: /^VARIABLES?\s+([A-Za-z_][A-Za-z0-9_]*)\b/}
        ],
        bindingPatterns: [
            /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*==/
        ],
        callPattern: /\b([A-Za-z_][A-Za-z0-9_]*)\b/,
        callKeywords: ['module', 'variables', 'variable', 'constant', 'constants', 'theorem', 'assume', 'prove'],
        commentPattern: /^\\\*/,
        branchPattern: /\b(IF|THEN|ELSE|CASE)\b/,
        iterationPattern: /\b(CHOOSE|SUBSET|UNION)\b/,
        outputPattern: /\b(TRUE|FALSE|UNCHANGED)\b/,
        blockEndPattern: /^====/
    })
};

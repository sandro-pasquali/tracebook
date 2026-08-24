import {patternFactExtractor} from '../common.js';
import {createCurlyBraceAnnotation} from '../annotation-factories.js';
import {FUNCTIONAL_SOURCE_POLICY} from '../source-policies.js';

export const integration = {
    id: 'systemrdl',
    name: 'SystemRDL',
    grammar: 'systemrdl',
    family: 'systemrdl',
    aliases: ['systemrdl'],
    extensions: ['.rdl'],
    filenames: [],
    source: FUNCTIONAL_SOURCE_POLICY,
    repo: {
        sourceRoles: ['register model', 'address map', 'hardware interface spec'],
        supportingFiles: [
            {glob: '**/peakrdl.toml', role: 'configuration', terms: ['peakrdl', 'registers', 'generation']},
            {glob: '**/systemrdl.toml', role: 'configuration', terms: ['systemrdl', 'registers', 'generation']}
        ],
        questionTerms: ['systemrdl', 'register', 'address map', 'field', 'hardware'],
        evidenceTerms: ['addrmap', 'reg', 'field', 'property', 'component']
    },
    queries: {
        definitions: [
            {
                id: 'component-definition',
                query: '(component_named_def id: (id) @name) @definition',
                detail: 'declares a SystemRDL component'
            },
            {
                id: 'component-instance',
                query: '(component_inst id: (id) @name) @definition',
                detail: 'instantiates a SystemRDL component'
            }
        ]
    },
    contract: {
        path: 'src/registers.rdl',
        source: [
            'addrmap checkout {',
            '  reg { field {} ready; } status;',
            '};'
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'checkout'},
            {kind: 'definition', name: 'status'},
            {kind: 'definition', name: 'ready'}
        ],
        callLine: 'addrmap checkout {',
        excludedPaths: ['test/registers.rdl', 'build/registers.rdl']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'definition',
            pattern: /^(addrmap|regfile|reg|field|signal)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
            name: 2,
            target: 2,
            detail: 'declares a SystemRDL component'
        })
    ],
    annotation: createCurlyBraceAnnotation({
        languageName: 'SystemRDL',
        definitionPatterns: [
            {kind: 'addrmap', re: /^addrmap\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'regfile', re: /^regfile\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'register', re: /^reg\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'field', re: /^field\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'signal', re: /^signal\s+([A-Za-z_][A-Za-z0-9_]*)\b/}
        ],
        bindingPatterns: [
            /^([A-Za-z_][A-Za-z0-9_]*)\s*=/
        ],
        callKeywords: ['addrmap', 'regfile', 'reg', 'field', 'signal']
    })
};

import {patternFactExtractor} from '../common.js';
import {createCurlyBraceAnnotation} from '../annotation-factories.js';
import {SOLIDITY_SOURCE_POLICY} from '../source-policies.js';

export const integration = {
    id: 'solidity',
    name: 'Solidity',
    grammar: 'solidity',
    family: 'c_like',
    aliases: ['solidity', 'sol'],
    extensions: ['.sol'],
    filenames: [],
    source: SOLIDITY_SOURCE_POLICY,
    repo: {
        sourceRoles: ['smart contract', 'library contract', 'deployment boundary'],
        supportingFiles: [
            {glob: '**/foundry.toml', role: 'configuration', terms: ['foundry', 'contracts', 'profile']},
            {glob: '**/hardhat.config.*', role: 'configuration', terms: ['hardhat', 'network', 'contracts']},
            {glob: '**/remappings.txt', role: 'configuration', terms: ['imports', 'remappings', 'contracts']}
        ],
        questionTerms: ['solidity', 'contract', 'function', 'modifier', 'event', 'deployment'],
        evidenceTerms: ['contract', 'function', 'modifier', 'event', 'mapping']
    },
    queries: {
        definitions: [
            {
                id: 'contract-declaration',
                query: '(contract_declaration name: (identifier) @name) @definition',
                detail: 'declares a Solidity contract'
            },
            {
                id: 'function-definition',
                query: '(function_definition name: (identifier) @name) @definition',
                detail: 'declares a Solidity function'
            }
        ]
    },
    contract: {
        path: 'contracts/Escrow.sol',
        source: [
            'contract Escrow {',
            '    event CheckedOut(address indexed account);',
            '    mapping(address => uint) public balances;',
            '    function checkout() public returns (uint) {',
            '        require(balances[msg.sender] > 0, "empty");',
            '        emit CheckedOut(msg.sender);',
            '        return 1;',
            '    }',
            '}'
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'Escrow'},
            {kind: 'definition', name: 'checkout'}
        ],
        expectedLineFacts: [
            {kind: 'event', name: 'CheckedOut'},
            {kind: 'storage', name: 'balances'},
            {kind: 'guard', name: 'require'},
            {kind: 'event_emit', name: 'CheckedOut'}
        ],
        callLine: 'checkout();',
        excludedPaths: ['test/Escrow.sol', 'artifacts/Escrow.sol', 'cache/Escrow.sol']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'event',
            pattern: /^event\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
            name: 1,
            target: 1,
            detail: 'declares a Solidity event'
        }),
        patternFactExtractor({
            kind: 'storage',
            pattern: /^mapping\s*\([^)]+\)\s+(?:public|private|internal|external|\s)*([A-Za-z_][A-Za-z0-9_]*)\b/g,
            name: 1,
            target: 1,
            detail: 'declares Solidity mapping storage'
        }),
        patternFactExtractor({
            kind: 'guard',
            pattern: /\b(require|revert|assert)\s*\(/g,
            name: 1,
            target: 1,
            detail: 'guards a Solidity execution path'
        }),
        patternFactExtractor({
            kind: 'event_emit',
            pattern: /\bemit\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
            name: 1,
            target: 1,
            detail: 'emits a Solidity event'
        })
    ],
    annotation: createCurlyBraceAnnotation({
        languageName: 'Solidity',
        definitionPatterns: [
            {kind: 'contract', re: /^(?:abstract\s+)?contract\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'interface', re: /^interface\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'library', re: /^library\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'function', re: /^function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/},
            {kind: 'modifier', re: /^modifier\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/},
            {kind: 'event', re: /^event\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/},
            {kind: 'struct', re: /^struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
            {kind: 'enum', re: /^enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/}
        ],
        bindingPatterns: [
            /^(?:mapping\s*\([^)]+\)|[A-Za-z_][A-Za-z0-9_\[\]]*)\s+(?:public|private|internal|external|constant|immutable|\s)*([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;)/
        ],
        callKeywords: ['if', 'for', 'while', 'return', 'throw', 'emit', 'require', 'revert', 'assert'],
        outputPattern: /\b(return|revert|require|assert|emit)\b/
    })
};

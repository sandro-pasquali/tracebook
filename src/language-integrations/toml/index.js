import {patternFactExtractor} from '../common.js';
import {createConfigAnnotation} from '../annotation-factories.js';
import {CONFIG_SOURCE_POLICY} from '../source-policies.js';

export const integration = {
    id: 'toml',
    name: 'TOML',
    grammar: 'toml',
    family: 'toml',
    aliases: ['toml'],
    extensions: ['.toml'],
    filenames: ['Cargo.lock', 'Pipfile'],
    source: CONFIG_SOURCE_POLICY,
    repo: {
        sourceRoles: ['structured configuration', 'package manifest', 'tool configuration'],
        supportingFiles: [
            {glob: '**/pyproject.toml', role: 'manifest', terms: ['python', 'project', 'tool config']},
            {glob: '**/Cargo.toml', role: 'manifest', terms: ['cargo', 'crate', 'dependencies']},
            {glob: '**/.cargo/config.toml', role: 'configuration', terms: ['cargo', 'target', 'registry']}
        ],
        questionTerms: ['toml', 'configuration', 'manifest', 'tool', 'settings'],
        evidenceTerms: ['section', 'key', 'value', 'dependency', 'tool config']
    },
    annotation: createConfigAnnotation({languageName: 'TOML', entrySeparator: '='}),
    queries: [
        {
            kind: 'configuration',
            id: 'pair',
            query: '(pair (bare_key) @name (_) @target) @configuration',
            targetCapture: 'target',
            detail: 'declares TOML configuration'
        }
    ],
    contract: {
        path: 'Cargo.toml',
        source: [
            '[package]',
            'name = "checkout"',
            'version = "0.1.0"',
            '[dependencies]',
            'serde = "1"'
        ].join('\n'),
        expectedFacts: [
            {kind: 'configuration', name: 'name'},
            {kind: 'configuration', name: 'version'}
        ],
        expectedLineFacts: [
            {kind: 'dependency', name: 'serde'}
        ],
        callLine: 'name = "checkout"',
        excludedPaths: ['test/Cargo.toml', 'target/Cargo.toml']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'configuration',
            pattern: /^["']?([A-Za-z0-9_.-]+)["']?\s*=\s*(.+)$/g,
            name: 1,
            target: 2,
            detail: 'declares configuration'
        }),
        tomlManifestFact
    ]
};

function tomlManifestFact(line, context = {}) {
    const filename = String(context.path || '').split(/[\\/]/u).pop();
    if(filename !== 'Cargo.toml' && filename !== 'pyproject.toml') {
        return [];
    }
    const assignment = String(line || '').match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/u);
    if(!assignment || TOML_METADATA_KEYS.has(assignment[1])) {
        return [];
    }
    return [{
        kind: 'dependency',
        name: assignment[1],
        target: assignment[2].replace(/^["']|["']$/gu, ''),
        detail: `declares a ${filename} dependency`
    }];
}

const TOML_METADATA_KEYS = new Set(['name', 'version', 'edition', 'rust-version', 'description', 'license', 'authors']);

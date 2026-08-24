import {patternFactExtractor} from '../common.js';
import {createConfigAnnotation} from '../annotation-factories.js';
import {CONFIG_SOURCE_POLICY} from '../source-policies.js';

export const integration = {
    id: 'yaml',
    name: 'YAML',
    grammar: 'yaml',
    family: 'yaml',
    aliases: ['yaml', 'yml'],
    extensions: ['.yaml', '.yml'],
    filenames: [],
    source: CONFIG_SOURCE_POLICY,
    repo: {
        sourceRoles: ['structured configuration', 'workflow definition', 'service manifest'],
        supportingFiles: [
            {glob: '**/docker-compose*.yml', role: 'configuration', terms: ['compose', 'services', 'containers']},
            {glob: '**/docker-compose*.yaml', role: 'configuration', terms: ['compose', 'services', 'containers']},
            {glob: '**/.github/workflows/*.yml', role: 'workflow', terms: ['workflow', 'ci', 'automation']},
            {glob: '**/.github/workflows/*.yaml', role: 'workflow', terms: ['workflow', 'ci', 'automation']}
        ],
        questionTerms: ['yaml', 'configuration', 'workflow', 'service', 'manifest', 'settings'],
        evidenceTerms: ['key', 'mapping', 'sequence', 'workflow', 'service', 'environment']
    },
    annotation: createConfigAnnotation({languageName: 'YAML', entrySeparator: ':'}),
    queries: [
        {
            kind: 'configuration',
            id: 'mapping-pair',
            query: '(block_mapping_pair key: (flow_node (plain_scalar (string_scalar) @name)) value: (_) @target) @configuration',
            targetCapture: 'target',
            detail: 'declares YAML configuration'
        }
    ],
    contract: {
        path: '.github/workflows/ci.yml',
        source: [
            'service:',
            '  name: checkout',
            '  enabled: true',
            'jobs:',
            '  test:',
            '    steps:',
            '      - uses: actions/checkout@v4',
            '      - run: yarn test'
        ].join('\n'),
        expectedFacts: [
            {kind: 'configuration', name: 'service'},
            {kind: 'configuration', name: 'name'},
            {kind: 'configuration', name: 'enabled'}
        ],
        expectedLineFacts: [
            {kind: 'workflow_action', name: 'actions/checkout@v4'},
            {kind: 'workflow_command', name: 'yarn test'}
        ],
        callLine: 'name: checkout',
        excludedPaths: ['test/app.yaml', 'dist/app.yaml']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'configuration',
            pattern: /^["']?([A-Za-z0-9_.-]+)["']?\s*:\s*(.+)$/g,
            name: 1,
            target: 2,
            detail: 'declares configuration'
        }),
        yamlWorkflowFact
    ]
};

function yamlWorkflowFact(line, context = {}) {
    const relPath = String(context.path || '').replace(/\\/g, '/');
    if(!/\.github\/workflows\/.+\.ya?ml$/u.test(relPath)) {
        return [];
    }
    const uses = String(line || '').match(/^-\s*uses:\s*(.+)$/u);
    if(uses) {
        return [{
            kind: 'workflow_action',
            name: uses[1].trim(),
            target: uses[1].trim(),
            detail: 'uses a GitHub Actions workflow action'
        }];
    }
    const run = String(line || '').match(/^-\s*run:\s*(.+)$/u);
    if(run) {
        return [{
            kind: 'workflow_command',
            name: run[1].trim(),
            target: run[1].trim(),
            detail: 'runs a GitHub Actions workflow command'
        }];
    }
    return [];
}

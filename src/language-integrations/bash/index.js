import {patternFactExtractor} from '../common.js';
import {createShellAnnotation} from '../annotation-factories.js';
import {SHELL_SOURCE_POLICY} from '../source-policies.js';

export const integration = {
    id: 'bash',
    name: 'Bash',
    grammar: 'bash',
    family: 'shell',
    aliases: ['bash', 'shell', 'sh'],
    extensions: ['.sh', '.bash'],
    filenames: [],
    source: SHELL_SOURCE_POLICY,
    repo: {
        sourceRoles: ['automation script', 'startup script', 'deployment script'],
        supportingFiles: [
            {glob: '**/Makefile', role: 'build', terms: ['make', 'task', 'script']}
        ],
        questionTerms: ['shell', 'bash', 'script', 'startup', 'deploy', 'automation'],
        evidenceTerms: ['command', 'environment', 'process', 'script']
    },
    queries: {
        definitions: [
            {
                id: 'function-definition',
                query: '(function_definition name: (word) @name) @definition',
                detail: 'declares a shell function'
            }
        ],
        calls: [
            {
                id: 'command-call',
                query: '(command name: (command_name (word) @name)) @call',
                detail: 'runs a shell command'
            }
        ]
    },
    contract: {
        path: 'scripts/deploy.sh',
        source: [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            ['export API_TOKEN="', '{API_TOKEN:-}"'].join('$'),
            'deploy_service() {',
            '  curl -fsS "$DEPLOY_URL"',
            '  echo "deploy"',
            '}',
            'deploy_service'
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'deploy_service'},
            {kind: 'call', name: 'deploy_service'}
        ],
        expectedLineFacts: [
            {kind: 'configuration', name: 'API_TOKEN'},
            {kind: 'process', name: 'curl'},
            {kind: 'safety', name: 'set -euo pipefail'}
        ],
        callLine: 'deploy_service',
        excludedPaths: ['test/deploy.sh', 'scripts/deploy.bats']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'configuration',
            pattern: /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/g,
            name: 1,
            target: 1,
            detail: 'defines a shell environment variable'
        }),
        patternFactExtractor({
            kind: 'process',
            pattern: /^\s*(curl|wget|ssh|scp|rsync|docker|kubectl|systemctl|service)\b/g,
            name: 1,
            target: 1,
            detail: 'runs an external process boundary'
        }),
        patternFactExtractor({
            kind: 'safety',
            pattern: /^set\s+(-[A-Za-z]*e[A-Za-z]*u[A-Za-z]*o\s+pipefail|-euo\s+pipefail)\b/g,
            name: 'set -euo pipefail',
            target: 'set -euo pipefail',
            detail: 'enables strict shell failure handling'
        })
    ],
    annotation: createShellAnnotation({languageName: 'shell'})
};

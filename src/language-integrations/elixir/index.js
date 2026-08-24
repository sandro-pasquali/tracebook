import {patternFactExtractor} from '../common.js';
import {createBlockAnnotation} from '../annotation-factories.js';
import {FUNCTIONAL_SOURCE_POLICY} from '../source-policies.js';
import {elixirDependency} from './dependency.js';

export const integration = {
    id: 'elixir',
    name: 'Elixir',
    grammar: 'elixir',
    family: 'elixir',
    aliases: ['elixir', 'ex', 'exs'],
    extensions: ['.ex', '.exs'],
    filenames: [],
    source: FUNCTIONAL_SOURCE_POLICY,
    dependency: elixirDependency,
    repo: {
        sourceRoles: ['application module', 'supervision module', 'web context', 'script'],
        supportingFiles: [
            {glob: '**/mix.exs', role: 'manifest', terms: ['mix', 'dependencies', 'application']},
            {glob: '**/mix.lock', role: 'manifest', terms: ['mix lock', 'dependency', 'version']},
            {glob: '**/config/*.exs', role: 'configuration', terms: ['config', 'runtime', 'environment']}
        ],
        questionTerms: ['elixir', 'module', 'process', 'supervisor', 'mix', 'pipeline'],
        evidenceTerms: ['defmodule', 'def', 'alias', 'use', 'pipeline']
    },
    queries: {
        definitions: [
            {
                id: 'module-definition',
                query: [
                    '(',
                    '  (call target: (identifier) @macro (arguments (alias) @name) (do_block)) @definition',
                    '  (#eq? @macro "defmodule")',
                    ')'
                ].join('\n'),
                detail: 'declares an Elixir module'
            },
            {
                id: 'function-definition',
                query: [
                    '(',
                    '  (call target: (identifier) @macro (arguments (call target: (identifier) @name)) (do_block)) @definition',
                    '  (#match? @macro "^defp?$")',
                    ')'
                ].join('\n'),
                detail: 'declares an Elixir function'
            }
        ],
        calls: [
            {
                id: 'call-target',
                query: '(call target: (identifier) @name) @call',
                detail: 'calls an Elixir function or macro'
            }
        ]
    },
    contract: {
        path: 'lib/checkout.ex',
        source: [
            'defmodule Checkout.Flow do',
            '  def run(order) do',
            '    save(order)',
            '    order',
            '  end',
            'end'
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'Checkout.Flow'},
            {kind: 'definition', name: 'run'},
            {kind: 'call', name: 'save'}
        ],
        expectedLineFacts: [
            {kind: 'definition', name: 'Checkout.Flow'},
            {kind: 'definition', name: 'run'}
        ],
        callLine: 'save(order)',
        excludedPaths: ['test/checkout.exs', 'build/checkout.ex'],
        dependencyManifestPaths: ['mix.exs', 'mix.lock'],
        dependencyFixtures: [
            {
                path: 'mix.exs',
                content: [
                    'defmodule App.MixProject do',
                    '  use Mix.Project',
                    '  defp deps do',
                    '    [{:phoenix, "~> 1.7"}]',
                    '  end',
                    'end'
                ].join('\n'),
                expectedDocs: [
                    {path: '__dependencies__/hex/phoenix.md', includes: ['phoenix ~> 1.7', 'mix.deps']}
                ]
            }
        ]
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'route',
            pattern: /\b(get|post|put|patch|delete|live)\s+["']([^"']+)["']/g,
            name: (match) => `${match[1].toUpperCase()} ${match[2]}`,
            target: 2,
            detail: 'declares an Elixir router route'
        }),
        patternFactExtractor({
            kind: 'configuration',
            pattern: /\bSystem\.get_env\(\s*["']([^"']+)["']/g,
            name: 1,
            target: 1,
            detail: 'reads configuration'
        }),
        patternFactExtractor({
            kind: 'storage',
            pattern: /\bRepo\.(all|one|get|get_by|insert|update|delete|transaction)\s*\(/g,
            name: (match) => `Repo.${match[1]}`,
            target: 1,
            detail: 'uses an Ecto storage boundary'
        }),
        patternFactExtractor({
            kind: 'concurrency',
            pattern: /\b(?:Task\.(async|start|start_link)|GenServer\.(call|cast)|send)\s*\(/g,
            name: (match) => match[1] || 'send',
            target: (match) => match[1] || 'send',
            detail: 'starts or communicates with an Elixir process boundary'
        }),
        patternFactExtractor({
            kind: 'definition',
            pattern: /^defmodule\s+([A-Z][A-Za-z0-9_.]*)\s+do\b/g,
            name: 1,
            target: 1,
            detail: 'declares an Elixir module'
        }),
        patternFactExtractor({
            kind: 'definition',
            pattern: /^defp?\s+([A-Za-z_][A-Za-z0-9_!?]*)\b/g,
            name: 1,
            target: 1,
            detail: 'declares an Elixir function'
        })
    ],
    annotation: createBlockAnnotation({
        languageName: 'Elixir',
        definitionPatterns: [
            {kind: 'module', re: /^defmodule\s+([A-Z][A-Za-z0-9_.]*)\s+do\b/},
            {kind: 'function', re: /^defp?\s+([A-Za-z_][A-Za-z0-9_!?]*)\b/},
            {kind: 'macro', re: /^defmacro\s+([A-Za-z_][A-Za-z0-9_!?]*)\b/}
        ],
        bindingPatterns: [
            /^([A-Za-z_][A-Za-z0-9_]*)\s*=/
        ],
        callKeywords: ['if', 'unless', 'case', 'cond', 'for', 'with', 'def', 'defp', 'defmodule', 'do', 'end', 'raise'],
        branchPattern: /\b(if|unless|case|cond|with)\b/,
        iterationPattern: /\b(for|Enum\.)\b/,
        outputPattern: /\b(raise|throw|exit)\b/
    })
};

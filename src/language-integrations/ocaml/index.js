import {patternFactExtractor} from '../common.js';
import {createBlockAnnotation} from '../annotation-factories.js';
import {FUNCTIONAL_SOURCE_POLICY} from '../source-policies.js';

export const integration = {
    id: 'ocaml',
    name: 'OCaml',
    grammar: 'ocaml',
    family: 'ocaml',
    aliases: ['ocaml'],
    extensions: ['.ml', '.mli'],
    filenames: [],
    source: FUNCTIONAL_SOURCE_POLICY,
    repo: {
        sourceRoles: ['module implementation', 'module interface', 'functional service'],
        supportingFiles: [
            {glob: '**/dune-project', role: 'manifest', terms: ['dune', 'package', 'workspace']},
            {glob: '**/dune', role: 'manifest', terms: ['dune', 'library', 'executable']},
            {glob: '**/*.opam', role: 'manifest', terms: ['opam', 'dependency', 'package']}
        ],
        questionTerms: ['ocaml', 'module', 'interface', 'dune', 'opam'],
        evidenceTerms: ['let', 'module', 'open', 'type', 'signature']
    },
    queries: {
        definitions: [
            {
                id: 'let-binding',
                query: '(value_definition (let_binding pattern: (value_name) @name)) @definition',
                detail: 'declares an OCaml value or function'
            }
        ]
    },
    contract: {
        path: 'src/checkout.ml',
        source: [
            'let checkout value =',
            '  value',
            '',
            'let total = checkout 1'
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'checkout'},
            {kind: 'definition', name: 'total'}
        ],
        callLine: 'checkout value',
        excludedPaths: ['test/checkout.ml', 'dist/checkout.ml']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'definition',
            pattern: /^let\s+(?:rec\s+)?([a-z_][A-Za-z0-9_']*)\b/g,
            name: 1,
            target: 1,
            detail: 'declares an OCaml value or function'
        }),
        patternFactExtractor({
            kind: 'definition',
            pattern: /^module\s+([A-Z][A-Za-z0-9_']*)\b/g,
            name: 1,
            target: 1,
            detail: 'declares an OCaml module'
        })
    ],
    annotation: createBlockAnnotation({
        languageName: 'OCaml',
        definitionPatterns: [
            {kind: 'function', re: /^let\s+(?:rec\s+)?([a-z_][A-Za-z0-9_']*)\b/},
            {kind: 'module', re: /^module\s+([A-Z][A-Za-z0-9_']*)\b/},
            {kind: 'type', re: /^type\s+([a-z_][A-Za-z0-9_']*)\b/}
        ],
        bindingPatterns: [
            /^let\s+(?:rec\s+)?([a-z_][A-Za-z0-9_']*)\b/
        ],
        callPattern: /\b([a-z_][A-Za-z0-9_'.]*)\b/,
        callKeywords: ['let', 'rec', 'module', 'type', 'match', 'with', 'if', 'then', 'else', 'fun', 'function'],
        commentPattern: /^\(\*/,
        branchPattern: /\b(if|then|else|match|with|function)\b/,
        iterationPattern: /\b(List\.map|List\.iter|Array\.map|Seq\.map)\b/,
        outputPattern: /\b(raise|failwith|invalid_arg)\b/,
        blockEndPattern: /^$/
    })
};

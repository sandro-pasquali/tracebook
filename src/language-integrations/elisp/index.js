import {createBlockAnnotation} from '../annotation-factories.js';
import {FUNCTIONAL_SOURCE_POLICY} from '../source-policies.js';

export const integration = {
    id: 'elisp',
    name: 'Emacs Lisp',
    grammar: 'elisp',
    family: 'lisp',
    aliases: ['elisp', 'emacs-lisp'],
    extensions: ['.el', '.elisp'],
    filenames: [],
    source: FUNCTIONAL_SOURCE_POLICY,
    repo: {
        sourceRoles: ['editor extension', 'configuration module', 'automation function'],
        supportingFiles: [
            {glob: '**/Cask', role: 'manifest', terms: ['package', 'dependency', 'emacs']},
            {glob: '**/Eask', role: 'manifest', terms: ['package', 'dependency', 'emacs']},
            {glob: '**/.dir-locals.el', role: 'configuration', terms: ['directory locals', 'emacs', 'settings']}
        ],
        questionTerms: ['emacs lisp', 'elisp', 'function', 'package', 'mode', 'configuration'],
        evidenceTerms: ['defun', 'setq', 'require', 'provide', 'mode']
    },
    queries: {
        definitions: [
            {
                id: 'function-definition',
                query: '(function_definition name: (symbol) @name) @definition',
                detail: 'declares an Emacs Lisp function'
            }
        ],
        calls: [
            {
                id: 'list-call',
                query: '(list . (symbol) @name) @call',
                detail: 'calls an Emacs Lisp form'
            }
        ]
    },
    contract: {
        path: 'src/checkout.el',
        source: [
            '(defun checkout ()',
            '  (message "ok"))'
        ].join('\n'),
        expectedFacts: [
            {kind: 'definition', name: 'checkout'},
            {kind: 'call', name: 'message'}
        ],
        callLine: '(message "ok")',
        excludedPaths: ['test/checkout.el', 'dist/checkout.el']
    },
    annotation: createBlockAnnotation({
        languageName: 'Emacs Lisp',
        definitionPatterns: [
            {kind: 'function', re: /^\(defun\s+([A-Za-z0-9-!?/*+=<>_]+)\b/},
            {kind: 'macro', re: /^\(defmacro\s+([A-Za-z0-9-!?/*+=<>_]+)\b/},
            {kind: 'variable', re: /^\(def(?:var|custom|const)\s+([A-Za-z0-9-!?/*+=<>_]+)\b/}
        ],
        bindingPatterns: [
            /^\((?:setq|let)\s+\(?([A-Za-z0-9-!?/*+=<>_]+)\b/
        ],
        callPattern: /^\(([A-Za-z0-9-!?/*+=<>_]+)\b/,
        callKeywords: ['defun', 'defmacro', 'defvar', 'defcustom', 'defconst', 'let', 'setq', 'if', 'cond', 'when', 'unless'],
        commentPattern: /^;/,
        branchPattern: /^\((?:if|cond|when|unless|pcase)\b/,
        iterationPattern: /^\((?:while|dolist|dotimes|mapc|mapcar)\b/,
        outputPattern: /^\((?:throw|signal|error)\b/,
        blockEndPattern: /^\)+$/
    })
};

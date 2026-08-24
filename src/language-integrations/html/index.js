import {patternFactExtractor} from '../common.js';
import {MARKUP_SOURCE_POLICY} from '../source-policies.js';
import {markupAnnotation} from './annotation.js';

export const integration = {
    id: 'html',
    name: 'HTML',
    grammar: 'html',
    family: 'markup',
    aliases: ['html'],
    extensions: ['.html', '.htm'],
    filenames: [],
    source: MARKUP_SOURCE_POLICY,
    repo: {
        sourceRoles: ['document surface', 'browser entrypoint', 'server-rendered page'],
        supportingFiles: [
            {glob: '**/site.webmanifest', role: 'configuration', terms: ['webmanifest', 'browser', 'app metadata']},
            {glob: '**/manifest.webmanifest', role: 'configuration', terms: ['webmanifest', 'browser', 'app metadata']},
            {glob: '**/robots.txt', role: 'metadata', terms: ['robots', 'crawl', 'site metadata']}
        ],
        questionTerms: ['html', 'markup', 'page', 'document', 'browser', 'form', 'dom', 'screen'],
        evidenceTerms: ['tag', 'element', 'attribute', 'src', 'href', 'form', 'document']
    },
    annotation: markupAnnotation,
    queries: [
        {
            kind: 'markup',
            id: 'start-tag',
            query: '(start_tag (tag_name) @name) @markup',
            detail: 'declares a markup element'
        },
        {
            kind: 'markup',
            id: 'self-closing-tag',
            query: '(self_closing_tag (tag_name) @name) @markup',
            detail: 'declares a self-closing markup element'
        },
        {
            kind: 'import',
            id: 'attribute-resource',
            query: [
                '(',
                '  (attribute (attribute_name) @attribute (quoted_attribute_value (attribute_value) @target)) @import',
                '  (#match? @attribute "^(src|href|action)$")',
                ')'
            ].join('\n'),
            nameCapture: 'target',
            targetCapture: 'target',
            detail: 'references a markup resource'
        }
    ],
    contract: {
        path: 'public/index.html',
        source: [
            '<section id="checkout">',
            '  <form action="/checkout" method="post">',
            '  <button>Pay</button>',
            '  </form>',
            '  <script src="/checkout.js"></script>',
            '</section>'
        ].join('\n'),
        expectedFacts: [
            {kind: 'markup', name: 'section'},
            {kind: 'markup', name: 'button'},
            {kind: 'markup', name: 'script'},
            {kind: 'import', target: '/checkout.js'}
        ],
        expectedLineFacts: [
            {kind: 'form_action', name: 'POST /checkout'}
        ],
        callLine: '<button>Pay</button>',
        excludedPaths: ['tests/index.html', 'node_modules/pkg/index.html']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'markup',
            pattern: /<([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/g,
            name: (match) => match[1].toLowerCase(),
            target: (match) => match[1].toLowerCase(),
            detail: 'declares a markup element'
        }),
        patternFactExtractor({
            kind: 'import',
            pattern: /\b(?:src|href|action)\s*=\s*["']([^"']+)["']/g,
            name: 1,
            target: 1,
            detail: 'references a markup resource'
        }),
        patternFactExtractor({
            kind: 'form_action',
            pattern: /<form\b[^>]*\baction\s*=\s*["']([^"']+)["'][^>]*\bmethod\s*=\s*["']([^"']+)["']/gi,
            name: (match) => `${match[2].toUpperCase()} ${match[1]}`,
            target: 1,
            detail: 'declares a form submission target'
        }),
        patternFactExtractor({
            kind: 'interaction',
            pattern: /\bon(click|submit|change|input)\s*=\s*["']([^"']+)["']/gi,
            name: (match) => `on${match[1]}`,
            target: 2,
            detail: 'declares an inline HTML interaction handler'
        })
    ]
};

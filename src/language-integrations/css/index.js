import {patternFactExtractor} from '../common.js';
import {STYLE_SOURCE_POLICY} from '../source-policies.js';
import {cssAnnotation} from './annotation.js';

export const integration = {
    id: 'css',
    name: 'CSS',
    grammar: 'css',
    family: 'css',
    aliases: ['css'],
    extensions: ['.css'],
    filenames: [],
    source: STYLE_SOURCE_POLICY,
    repo: {
        sourceRoles: ['stylesheet layer', 'layout rules', 'visual state rules'],
        supportingFiles: [
            {glob: '**/postcss.config.*', role: 'configuration', terms: ['postcss', 'stylesheet', 'build']},
            {glob: '**/tailwind.config.*', role: 'configuration', terms: ['tailwind', 'theme', 'utility classes']},
            {glob: '**/stylelint.config.*', role: 'configuration', terms: ['stylelint', 'css', 'rules']}
        ],
        questionTerms: ['css', 'style', 'stylesheet', 'selector', 'layout', 'responsive', 'theme', 'animation'],
        evidenceTerms: ['selector', 'property', 'declaration', 'cascade', 'variable', 'media query']
    },
    annotation: cssAnnotation,
    queries: [
        {
            kind: 'style',
            id: 'rule-set',
            query: '(rule_set (selectors) @name) @style',
            detail: 'declares a CSS selector'
        },
        {
            kind: 'style_property',
            id: 'declaration',
            query: '(declaration (property_name) @name (plain_value) @target) @style_property',
            targetCapture: 'target',
            detail: 'declares a CSS property'
        }
    ],
    contract: {
        path: 'src/styles.css',
        source: [
            ':root {',
            '  --checkout-color: red;',
            '}',
            '.checkout {',
            '  color: red;',
            '  background: white;',
            '}',
            '@media (max-width: 600px) {',
            '  .checkout { display: block; }',
            '}'
        ].join('\n'),
        expectedFacts: [
            {kind: 'style', name: '.checkout'},
            {kind: 'style_property', name: 'color'},
            {kind: 'style_property', name: 'background'}
        ],
        expectedLineFacts: [
            {kind: 'design_token', name: '--checkout-color'},
            {kind: 'style_rule', name: '@media (max-width: 600px)'}
        ],
        callLine: 'color: red;',
        excludedPaths: ['tests/styles.css', 'dist/styles.css', 'node_modules/pkg/styles.css']
    },
    lineFactExtractors: [
        patternFactExtractor({
            kind: 'style',
            pattern: /^([^@{}][^{]+)\{\s*$/g,
            name: 1,
            target: 1,
            detail: 'declares a CSS selector'
        }),
        patternFactExtractor({
            kind: 'style_property',
            pattern: /^(-{0,2}[A-Za-z][A-Za-z0-9_-]*)\s*:\s*([^;]+);?$/g,
            name: 1,
            target: 2,
            detail: 'declares a CSS property'
        }),
        patternFactExtractor({
            kind: 'style_rule',
            pattern: /^@(media|container|supports|keyframes|layer|import)\s+([^{};]+)/g,
            name: (match) => `@${match[1]} ${match[2]}`.trim(),
            target: 2,
            detail: 'declares a CSS at-rule'
        }),
        patternFactExtractor({
            kind: 'design_token',
            pattern: /^(--[A-Za-z][A-Za-z0-9_-]*)\s*:\s*([^;]+);?$/g,
            name: 1,
            target: 2,
            detail: 'declares a CSS custom property'
        })
    ]
};

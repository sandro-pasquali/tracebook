import {nodeLineRange, isCommentNode, isErrorNode} from '../util/tree-sitter-nodes.js';

export {nodeLineRange} from '../util/tree-sitter-nodes.js';

const COMMON_DEFINITION_NODE_TYPES = [
    'function_declaration',
    'function_definition',
    'method_definition',
    'class_declaration',
    'class_definition',
    'class_specifier',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'enum_specifier',
    'struct_specifier',
    'struct_item',
    'enum_item',
    'impl_item',
    'trait_item',
    'function_item',
    'method_declaration',
    'module',
    'module_declaration',
    'lexical_declaration',
    'variable_declaration'
];

const COMMON_IMPORT_NODE_TYPES = [
    'import_statement',
    'import_declaration',
    'use_declaration',
    'use_item',
    'using_directive',
    'preproc_include',
    'require'
];

const IDENTIFIER_NODE_TYPES = [
    'identifier',
    'type_identifier',
    'property_identifier',
    'field_identifier',
    'simple_identifier',
    'constant',
    'variable_name',
    'name'
];

const STRING_NODE_TYPES = [
    'string',
    'string_literal',
    'interpreted_string_literal',
    'raw_string_literal',
    'string_fragment'
];
const QUERY_CACHE = new WeakMap();

export function createLanguageIntegration(spec) {
    const resolvedSpec = {
        ...spec,
        category: spec.category || defaultIntegrationCategory(spec),
        commentPatterns: spec.commentPatterns || defaultCommentPatterns(spec),
        structuralPatterns: spec.structuralPatterns || defaultStructuralPatterns(spec),
        source: normalizeSourcePolicy(spec),
        dependency: normalizeDependencyPolicy(spec),
        repo: normalizeRepoProfile(mergeRepoProfile(defaultRepoProfile(spec), spec.repo)),
        queries: normalizeQueryPolicy(spec.queries)
    };
    const definitionNodeTypes = new Set(spec.definitionNodeTypes || COMMON_DEFINITION_NODE_TYPES);
    const importNodeTypes = new Set(spec.importNodeTypes || COMMON_IMPORT_NODE_TYPES);
    const identifierNodeTypes = new Set(spec.identifierNodeTypes || IDENTIFIER_NODE_TYPES);
    const stringNodeTypes = new Set(spec.stringNodeTypes || STRING_NODE_TYPES);
    const lineFactExtractors = spec.lineFactExtractors || [];
    const annotation = spec.annotation || {};

    return {
        ...resolvedSpec,
        definitionNodeTypes,
        importNodeTypes,
        identifierNodeTypes,
        stringNodeTypes,
        lineFactExtractors,
        classifyLine(line) {
            return classifyLine(line, resolvedSpec);
        },
        discoverNode(node, context = {}) {
            return discoverNode(node, {
                ...context,
                spec: resolvedSpec,
                definitionNodeTypes,
                importNodeTypes,
                identifierNodeTypes,
                stringNodeTypes
            });
        },
        discoverTree(root, context = {}) {
            return discoverTree(root, {
                ...context,
                spec: resolvedSpec,
                queries: resolvedSpec.queries
            });
        },
        discoverLine(line, context = {}) {
            return discoverLine(line, {...context, spec: resolvedSpec, lineFactExtractors});
        },
        annotateLine(input = {}) {
            return annotateLine({
                ...input,
                spec: resolvedSpec,
                annotation,
                lineFactExtractors
            });
        },
        storyForExcerpt(input = {}) {
            return cleanAnnotationText(annotation.storyForExcerpt?.({
                ...input,
                spec: resolvedSpec
            }) || '');
        },
        anchorScore(input = {}) {
            return Number(annotation.anchorScore?.({
                ...input,
                spec: resolvedSpec
            })) || 0;
        },
        symbolAtLine(input = {}) {
            return cleanSymbol(annotation.symbolAtLine?.({
                ...input,
                spec: resolvedSpec
            }));
        },
        findSymbolRange(input = {}) {
            return annotation.findSymbolRange?.({
                ...input,
                spec: resolvedSpec
            }) || null;
        },
        summarizeNode(node, context = {}) {
            return summarizeNode(node, {
                ...context,
                spec: resolvedSpec,
                queries: resolvedSpec.queries,
                definitionNodeTypes,
                importNodeTypes,
                identifierNodeTypes,
                stringNodeTypes
            });
        }
    };
}

function normalizeQueryPolicy(queries) {
    if(!queries) {
        return [];
    }
    if(Array.isArray(queries)) {
        return queries.map(normalizeQuerySpec).filter(Boolean);
    }
    return Object.entries(queries).flatMap(([group, items]) => {
        const kind = group.endsWith('s') ? group.slice(0, -1) : group;
        return (items || []).map((item) => normalizeQuerySpec({...item, kind: item.kind || kind}));
    }).filter(Boolean);
}

function normalizeQuerySpec(spec) {
    if(!spec?.query) {
        return null;
    }
    return {
        id: cleanFactText(spec.id),
        kind: cleanFactText(spec.kind || 'symbol'),
        query: String(spec.query),
        nameCapture: cleanFactText(spec.nameCapture || 'name'),
        targetCapture: cleanFactText(spec.targetCapture || ''),
        rangeCapture: cleanFactText(spec.rangeCapture || ''),
        detail: cleanFactText(spec.detail || '')
    };
}

function normalizeSourcePolicy(spec) {
    const source = spec.source || {};
    return {
        include: uniqueStrings([
            ...(source.include || []),
            ...sourceGlobsForSpec(spec)
        ]),
        exclude: uniqueStrings(source.exclude || [])
    };
}

function normalizeDependencyPolicy(spec) {
    const dependency = spec.dependency || null;
    if(!dependency) {
        return null;
    }
    return {
        ...dependency,
        manifests: uniqueStrings(dependency.manifests || []),
        exclude: uniqueStrings(dependency.exclude || [])
    };
}

function defaultIntegrationCategory(spec) {
    if(['json', 'yaml', 'toml'].includes(spec.family)) {
        return 'config';
    }
    if(['markup', 'css'].includes(spec.family)) {
        return 'surface';
    }
    return 'code';
}

function defaultRepoProfile(spec) {
    const category = spec.category || defaultIntegrationCategory(spec);
    if(category === 'config') {
        return {
            sourceRoles: ['structured configuration'],
            questionTerms: [spec.id, spec.name, 'config', 'configuration', 'settings'],
            evidenceTerms: ['configuration', 'setting', 'key', 'value']
        };
    }
    if(category === 'surface') {
        return {
            sourceRoles: ['user interface surface'],
            questionTerms: [spec.id, spec.name, 'ui', 'screen', 'page', 'layout', 'style'],
            evidenceTerms: ['ui', 'surface', 'element', 'selector', 'style', 'layout']
        };
    }
    return {
        sourceRoles: ['implementation source'],
        questionTerms: [spec.id, spec.name],
        evidenceTerms: ['definition', 'call', 'import']
    };
}

function mergeRepoProfile(base = {}, override = {}) {
    return {
        sourceRoles: [...(base.sourceRoles || []), ...(override.sourceRoles || [])],
        questionTerms: [...(base.questionTerms || []), ...(override.questionTerms || [])],
        evidenceTerms: [...(base.evidenceTerms || []), ...(override.evidenceTerms || [])],
        supportingFiles: [...(base.supportingFiles || []), ...(override.supportingFiles || [])]
    };
}

function normalizeRepoProfile(repo = {}) {
    return {
        sourceRoles: uniqueStrings(repo.sourceRoles || []),
        questionTerms: uniqueStrings(repo.questionTerms || []),
        evidenceTerms: uniqueStrings(repo.evidenceTerms || []),
        supportingFiles: normalizeSupportingFiles(repo.supportingFiles || [])
    };
}

function normalizeSupportingFiles(files) {
    return files.map((file) => {
        if(typeof file === 'string') {
            return {
                glob: file,
                role: 'configuration',
                terms: []
            };
        }
        return {
            glob: cleanFactText(file?.glob),
            role: cleanFactText(file?.role || 'configuration'),
            terms: uniqueStrings(file?.terms || [])
        };
    }).filter((file) => file.glob);
}

function sourceGlobsForSpec(spec) {
    return [
        ...(spec.extensions || []).map((extension) => `**/*${extension.startsWith('.') ? extension : `.${extension}`}`),
        ...(spec.filenames || []).map((filename) => `**/${filename}`)
    ];
}

function annotateLine({line, lines = [], lineNumber = 1, analysis = null, context = {}, spec, annotation, lineFactExtractors}) {
    const trimmed = String(line ?? lines[lineNumber - 1] ?? '').trim();
    if(!trimmed) {
        return emptyAnnotation();
    }

    const lineContext = {
        ...context,
        path: context.path || '',
        language: context.language || spec.id || spec.grammar || '',
        family: spec.family,
        grammar: spec.grammar,
        lineNo: lineNumber,
        spec
    };
    const discoveryFacts = discoverLine(trimmed, {...lineContext, lineFactExtractors})
        .map(formatAnnotationFact)
        .filter(Boolean);
    const syntaxRole = roleFromSyntaxTypes(analysis?.lines?.[lineNumber - 1]?.nodeTypes || []);
    const details = annotation.describeLine?.({
        line: String(line ?? lines[lineNumber - 1] ?? ''),
        trimmed,
        lines,
        lineNumber,
        analysis,
        context,
        spec,
        syntaxRole,
        discoveryFacts
    }) || {};

    return {
        role: cleanAnnotationText(details.role || syntaxRole || ''),
        facts: uniqueStrings([...discoveryFacts, ...(details.facts || [])]).slice(0, 8),
        note: cleanAnnotationText(details.note || ''),
        score: Number(details.score) || 0,
        worthy: details.worthy !== false,
        semanticKey: cleanAnnotationText(details.semanticKey || '')
    };
}

function emptyAnnotation() {
    return {
        role: '',
        facts: [],
        note: '',
        score: 0,
        worthy: false,
        semanticKey: ''
    };
}

function formatAnnotationFact(factItem) {
    const kind = cleanAnnotationText(factItem?.kind);
    const value = cleanAnnotationText(factItem?.name || factItem?.target);
    return kind && value ? `${kind}: ${value}` : '';
}

export function roleFromSyntaxTypes(nodeTypes) {
    const types = new Set((nodeTypes || []).map((type) => String(type || '').toLowerCase()));
    if([...types].some((type) => /function|method|class|struct|trait|interface|module/.test(type))) {
        return 'definition boundary';
    }
    if([...types].some((type) => /call|invocation/.test(type))) {
        return 'call boundary';
    }
    if([...types].some((type) => /assignment|variable|declaration|declarator/.test(type))) {
        return 'state/data';
    }
    if([...types].some((type) => /if|match|switch|case|conditional/.test(type))) {
        return 'branch';
    }
    if([...types].some((type) => /for|while|loop|iterator/.test(type))) {
        return 'iteration';
    }
    if([...types].some((type) => /return|yield/.test(type))) {
        return 'output boundary';
    }
    return '';
}

function defaultCommentPatterns(spec) {
    const slash = [/^\/\/\/?/, /^\/\*/, /^\*\/$/, /^\*(?:\/|$|\s(?!\{))/];
    const hash = [/^#!/, /^#/];
    if(['javascript', 'css', 'json', 'go', 'rust', 'c_like', 'dotnet', 'php', 'zig', 'rescript', 'systemrdl'].includes(spec.family)) {
        return slash;
    }
    if(['python', 'shell', 'yaml', 'toml', 'elixir'].includes(spec.family)) {
        return hash;
    }
    if(spec.family === 'lua') {
        return [/^--(\s|$)/];
    }
    if(spec.family === 'lisp') {
        return [/^;/];
    }
    if(spec.family === 'ocaml') {
        return [/^\(\*/, /^\*/];
    }
    if(spec.family === 'tlaplus') {
        return [/^\\\*/];
    }
    if(spec.family === 'markup' || spec.family === 'template') {
        return [/^<!--/, /^-->$/, /^\{#/, /^#\}/, /^\{\{!/];
    }
    return [];
}

function defaultStructuralPatterns(spec) {
    const patterns = [/^[{}()[\],;]+$/];
    if(spec.family === 'markup' || spec.family === 'template') {
        patterns.push(/^<\/[A-Za-z][^>]*>$/, /^<[A-Za-z][A-Za-z0-9:-]*>$/);
    }
    if(['shell', 'lua', 'elixir'].includes(spec.family)) {
        patterns.push(/^(end|fi|done|esac|\})$/i);
    }
    return patterns;
}

function classifyLine(line, spec) {
    const trimmed = String(line || '').trim();
    if(!trimmed) {
        return {substantive: false, commentOnly: false, structuralOnly: false};
    }
    const commentOnly = isCommentOnlyLine(trimmed, spec);
    const structuralOnly = isStructuralOnlyLine(trimmed, spec);
    return {
        substantive: !commentOnly && !structuralOnly,
        commentOnly,
        structuralOnly
    };
}

function isCommentOnlyLine(trimmed, spec) {
    for(const pattern of spec.commentPatterns || []) {
        if(pattern.test(trimmed)) {
            return true;
        }
    }
    return false;
}

function isStructuralOnlyLine(trimmed, spec) {
    for(const pattern of spec.structuralPatterns || [/^[{}()[\],;]+$/]) {
        if(pattern.test(trimmed)) {
            return true;
        }
    }
    return false;
}

function discoverNode(node, context) {
    if(!node || isCommentNode(node) || isErrorNode(node)) {
        return [];
    }
    const range = nodeLineRange(node, context.lineCount);
    const syntax = {
        engine: 'tree-sitter',
        grammar: context.spec.grammar,
        nodeType: node.type
    };
    const facts = [];

    if(context.definitionNodeTypes.has(node.type)) {
        for(const name of nodeSymbolNames(node, context).slice(0, 8)) {
            facts.push(fact({
                kind: 'definition',
                name,
                target: '',
                detail: `${context.spec.grammar} ${node.type}`,
                range,
                syntax
            }));
        }
    }

    if(context.importNodeTypes.has(node.type)) {
        for(const target of nodeImportTargets(node, context).slice(0, 8)) {
            facts.push(fact({
                kind: 'import',
                name: target,
                target,
                detail: `${context.spec.grammar} ${node.type}`,
                range,
                syntax
            }));
        }
    }

    return facts;
}

function discoverTree(root, context) {
    if(!root || !context.language || !Array.isArray(context.queries) || context.queries.length === 0) {
        return [];
    }
    const facts = [];
    for(const querySpec of context.queries) {
        const query = compiledQuery(context.language, querySpec);
        for(const match of query.matches(root)) {
            const factItem = factFromQueryMatch(match, querySpec, context);
            if(factItem) {
                facts.push(factItem);
            }
        }
    }
    return facts;
}

function compiledQuery(language, querySpec) {
    let byQuery = QUERY_CACHE.get(language);
    if(!byQuery) {
        byQuery = new Map();
        QUERY_CACHE.set(language, byQuery);
    }
    if(!byQuery.has(querySpec.query)) {
        byQuery.set(querySpec.query, language.query(querySpec.query));
    }
    return byQuery.get(querySpec.query);
}

function factFromQueryMatch(match, querySpec, context) {
    const rangeNode = captureNode(match, querySpec.rangeCapture)
        || captureNode(match, querySpec.kind)
        || captureNode(match, 'definition')
        || captureNode(match, 'import')
        || captureNode(match, 'configuration')
        || captureNode(match, 'markup')
        || captureNode(match, 'style')
        || captureNode(match, 'style_property')
        || match?.captures?.[0]?.node;
    const nameNode = captureNode(match, querySpec.nameCapture);
    const targetNode = captureNode(match, querySpec.targetCapture) || nameNode;
    const name = captureText(nameNode, querySpec.kind);
    const target = querySpec.targetCapture ? captureText(targetNode, querySpec.kind) : '';
    if(!name && !target) {
        return null;
    }
    const range = nodeLineRange(rangeNode || nameNode || targetNode, context.lineCount);
    return fact({
        kind: querySpec.kind,
        name,
        target,
        detail: querySpec.detail || `${context.spec.grammar} ${querySpec.kind}`,
        range,
        syntax: {
            engine: 'tree-sitter-query',
            grammar: context.spec.grammar,
            nodeType: rangeNode?.type || nameNode?.type || targetNode?.type || '',
            query: querySpec.id || querySpec.kind
        }
    });
}

function captureNode(match, captureName) {
    if(!captureName) {
        return null;
    }
    return match?.captures?.find((capture) => capture.name === captureName)?.node || null;
}

function captureText(node, kind) {
    if(!node) {
        return '';
    }
    const text = node.text || '';
    if(kind === 'import' || /string/.test(String(node.type || ''))) {
        return cleanStringTarget(text);
    }
    return cleanFactText(text);
}

function discoverLine(line, context) {
    const trimmed = String(line || '').trim();
    if(!trimmed || classifyLine(trimmed, context.spec).commentOnly) {
        return [];
    }
    const out = [];
    for(const extractFacts of context.lineFactExtractors) {
        const matches = extractFacts(trimmed, context) || [];
        out.push(...matches);
    }
    return out.map((item) => ({
        ...item,
        lineStart: item.lineStart || context.lineNo,
        lineEnd: item.lineEnd || item.lineStart || context.lineNo,
        syntax: item.syntax || {
            engine: 'tree-sitter-integration',
            grammar: context.spec.grammar,
            family: context.spec.family
        }
    }));
}

function summarizeNode(node, context) {
    const facts = [
        ...discoverTree(node, context),
        ...discoverNode(node, {
            ...context,
            lineCount: Number.MAX_SAFE_INTEGER
        })
    ];
    return {
        engine: 'tree-sitter',
        grammar: context.spec.grammar,
        nodeTypes: uniqueStrings([node?.type]),
        symbols: uniqueStrings(facts.filter((fact) => fact.kind === 'definition').map((fact) => fact.name)),
        imports: uniqueStrings(facts.filter((fact) => fact.kind === 'import').map((fact) => fact.target)),
        calls: uniqueStrings(facts.filter((fact) => fact.kind === 'call').map((fact) => fact.name || fact.target))
    };
}

function nodeSymbolNames(node, context) {
    const fromFields = ['name', 'declarator', 'property']
        .map((field) => symbolTextFromField(node.childForFieldName?.(field), context))
        .filter(Boolean);
    if(fromFields.length > 0) {
        return uniqueStrings(fromFields.map(cleanFactText));
    }

    const identifier = firstDescendantText(node, context.identifierNodeTypes);
    return identifier ? [cleanFactText(identifier)] : [];
}

function symbolTextFromField(fieldNode, context) {
    if(!fieldNode) {
        return '';
    }
    return firstDescendantText(fieldNode, context.identifierNodeTypes) || fieldNode.text || '';
}

function nodeImportTargets(node, context) {
    const fromFields = ['source', 'path', 'module', 'name']
        .map((field) => node.childForFieldName?.(field)?.text)
        .filter(Boolean);
    const stringTarget = firstDescendantText(node, context.stringNodeTypes);
    return uniqueStrings([...fromFields, stringTarget]
        .map((value) => cleanStringTarget(value))
        .filter(Boolean));
}

function firstDescendantText(node, nodeTypes) {
    const stack = [...(node?.namedChildren || [])];
    while(stack.length > 0) {
        const current = stack.shift();
        if(!current) {
            continue;
        }
        if(nodeTypes.has(current.type)) {
            return current.text || '';
        }
        stack.unshift(...(current.namedChildren || []));
    }
    return '';
}

function cleanStringTarget(value) {
    return cleanFactText(String(value || '').replace(/^['"`]+|['"`;]+$/g, ''));
}

function fact({kind, name, target, detail, range, syntax}) {
    return {
        kind,
        name: cleanFactText(name),
        target: cleanFactText(target),
        detail: cleanFactText(detail),
        lineStart: range.lineStart,
        lineEnd: range.lineEnd,
        syntax
    };
}

export function patternFactExtractor({kind, pattern, name = 1, target = null, detail}) {
    return (line, context) => {
        const out = [];
        for(const match of line.matchAll(pattern)) {
            const nameValue = captureValue(match, name);
            const targetValue = typeof target === 'function'
                ? target(match)
                : target === null
                    ? nameValue
                    : captureValue(match, target);
            out.push({
                kind,
                name: cleanFactText(nameValue),
                target: cleanFactText(targetValue),
                detail,
                lineStart: context.lineNo,
                lineEnd: context.lineNo
            });
        }
        return out;
    };
}

function captureValue(match, selector) {
    if(typeof selector === 'function') {
        return selector(match);
    }
    if(typeof selector === 'number') {
        return match[selector] || '';
    }
    if(typeof selector === 'string' && match.groups && selector in match.groups) {
        return match.groups[selector] || '';
    }
    return selector || '';
}

function cleanFactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function cleanAnnotationText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 280);
}

function cleanSymbol(value) {
    if(!value || typeof value !== 'object') {
        return null;
    }
    const name = cleanAnnotationText(value.name);
    const kind = cleanAnnotationText(value.kind);
    return name && kind ? {kind, name} : null;
}

function uniqueStrings(values) {
    const out = [];
    const seen = new Set();
    for(const value of values) {
        const text = cleanFactText(value);
        if(!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

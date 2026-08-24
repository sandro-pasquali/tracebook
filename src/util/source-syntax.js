import {createRequire} from 'node:module';
import {EOL} from 'node:os';
import {SUPPORTED_TREE_SITTER_GRAMMARS, resolveLanguageIntegration} from '../language-integrations/registry.js';
import {nodeLineRange, isCommentNode, isErrorNode} from './tree-sitter-nodes.js';

const require = createRequire(import.meta.url);
const MAX_TREE_SITTER_CHARS = 750_000;
const TREE_SITTER_TIMEOUT_MICROS = 250_000;
export const SOURCE_GRAPH_VERSION = '1';

let parserModulePromise = null;
let parserInitPromise = null;
const languagePromises = new Map();

export async function analyzeSourceLines(lines, context = {}) {
    const sourceLines = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
    const text = sourceLines.join('\n');
    const support = sourceSupportStatus(context);
    if(!support.supported) {
        return unsupportedAnalysis(sourceLines, support.reason);
    }
    const parsed = await parseSource(text, context);
    if(!parsed) {
        return unsupportedAnalysis(sourceLines, 'tree_sitter_unavailable');
    }

    try {
        const integration = sourceIntegration(context);
        const lineClassifications = sourceLines.map((line) => integration.classifyLine(line));
        const marks = sourceLines.map(() => ({
            hasComment: false,
            hasCode: false,
            hasString: false,
            hasError: false,
            nodeTypes: new Set()
        }));
        markSyntaxLines(parsed.tree.rootNode, marks, integration);

        const analyzed = lineClassifications.map((entry, index) => {
            const mark = marks[index];
            const syntaxCode = mark.hasCode && !entry.structuralOnly;
            const commentOnly = mark.hasComment && !mark.hasCode;
            const stringOnly = mark.hasString && !mark.hasCode;
            return {
                ...entry,
                engine: 'tree-sitter',
                commentOnly: commentOnly || entry.commentOnly,
                substantive: syntaxCode || (!commentOnly && !stringOnly && entry.substantive),
                nodeTypes: [...mark.nodeTypes]
            };
        });
        const treeFacts = [];
        collectTreeFacts(parsed.tree.rootNode, treeFacts, {
            path: context.path || '',
            grammar: parsed.grammar,
            language: parsed.language,
            lineCount: sourceLines.length,
            integration
        });

        return {
            engine: 'tree-sitter',
            supported: true,
            grammar: parsed.grammar,
            lines: analyzed,
            symbols: symbolRangesFromFacts(treeFacts),
            hasError: parsed.tree.rootNode.hasError()
        };
    } finally {
        parsed.tree.delete?.();
    }
}

export function isSubstantiveSourceLine(line, context = {}) {
    const integration = sourceIntegration(context);
    if(!integration || !sourceSupportStatus(context).supported) {
        return false;
    }
    return integration.classifyLine(line).substantive;
}

export async function syntaxChunksForText(content, context = {}, options = {}) {
    const text = String(content || '');
    const lines = text.split(/\r?\n/);
    const parsed = await parseSource(text, context);
    if(!parsed) {
        return [];
    }

    try {
        const integration = sourceIntegration(context);
        const topLevel = parsed.tree.rootNode.namedChildren
            .filter((node) => !isCommentNode(node) && !isErrorNode(node))
            .map((node) => {
                const range = nodeLineRange(node, lines.length);
                return range ? {...range, syntax: integration.summarizeNode(node, {
                    language: parsed.language,
                    lineCount: lines.length
                })} : null;
            })
            .filter((range) => range && range.lineEnd >= range.lineStart)
            .sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd);

        if(topLevel.length < 2) {
            return [];
        }

        const targetLines = Math.max(20, Number(options.targetLines) || 80);
        const overlapLines = Math.max(0, Number(options.overlapLines) || 8);
        const maxChars = Math.max(2000, Number(options.maxChars) || 20000);
        const chunks = [];
        let group = null;

        for(const range of topLevel) {
            const lineCount = range.lineEnd - range.lineStart + 1;
            const rangeText = sliceLines(lines, range.lineStart, range.lineEnd);
            if(lineCount > targetLines * 1.5 || rangeText.length > maxChars) {
                flushGroup(chunks, lines, group);
                group = null;
                chunks.push(...windowRange(lines, range.lineStart, range.lineEnd, targetLines, overlapLines, range.syntax));
                continue;
            }

            if(!group) {
                group = {...range};
                continue;
            }

            const merged = {
                lineStart: group.lineStart,
                lineEnd: range.lineEnd,
                syntax: mergeSyntax(group.syntax, range.syntax)
            };
            const mergedText = sliceLines(lines, merged.lineStart, merged.lineEnd);
            if((merged.lineEnd - merged.lineStart + 1) > targetLines || mergedText.length > maxChars) {
                flushGroup(chunks, lines, group);
                group = {...range};
            } else {
                group = merged;
            }
        }
        flushGroup(chunks, lines, group);

        const unique = dedupeChunks(chunks);
        return unique.length > 1 ? unique : [];
    } finally {
        parsed.tree.delete?.();
    }
}

export async function extractSourceGraph(content, context = {}) {
    const text = String(content || '');
    const lines = text.split(/\r?\n/);
    const integration = sourceIntegration(context);
    const facts = [];
    const parsed = await parseSource(text, context);
    if(!parsed) {
        return [];
    }

    try {
        collectTreeFacts(parsed.tree.rootNode, facts, {
            path: context.path || '',
            grammar: parsed.grammar,
            language: parsed.language,
            lineCount: lines.length,
            integration
        });
        collectLineFacts(lines, facts, {
            path: context.path || '',
            family: integration.family,
            grammar: integration.grammar || '',
            language: context.language || '',
            integration
        });
    } finally {
        parsed.tree.delete?.();
    }

    return dedupeFacts(facts).slice(0, 500);
}

async function parseSource(content, context = {}) {
    const text = String(content || '');
    if(!text || text.length > MAX_TREE_SITTER_CHARS) {
        return null;
    }
    const support = sourceSupportStatus(context);
    if(!support.supported) {
        return null;
    }
    const grammar = support.grammar;
    try {
        const Parser = await loadParser();
        const language = await loadLanguage(Parser, grammar);
        const parser = new Parser();
        try {
            parser.setLanguage(language);
            if(typeof parser.setTimeoutMicros === 'function') {
                parser.setTimeoutMicros(TREE_SITTER_TIMEOUT_MICROS);
            }
            return {grammar, language, tree: parser.parse(text)};
        } finally {
            if(typeof parser.delete === 'function') {
                parser.delete();
            }
        }
    } catch {
        return null;
    }
}

export function sourceSupportStatus(context = {}) {
    const descriptor = sourceDescriptor(context);
    if(!descriptor.grammar) {
        return {
            supported: false,
            reason: 'missing_tree_sitter_grammar',
            family: descriptor.family,
            grammar: ''
        };
    }
    if(!SUPPORTED_TREE_SITTER_GRAMMARS.has(descriptor.grammar)) {
        return {
            supported: false,
            reason: 'unsupported_tree_sitter_grammar',
            family: descriptor.family,
            grammar: descriptor.grammar
        };
    }
    return {
        supported: true,
        reason: '',
        family: descriptor.family,
        grammar: descriptor.grammar
    };
}

export function isTreeSitterSupportedContext(context = {}) {
    return sourceSupportStatus(context).supported;
}

function unsupportedAnalysis(lines, reason) {
    return {
        engine: 'unsupported',
        supported: false,
        reason,
        lines: lines.map(() => ({
            engine: 'unsupported',
            substantive: false,
            commentOnly: false,
            structuralOnly: false,
            nodeTypes: []
        }))
    };
}

function collectTreeFacts(root, facts, context) {
    for(const fact of context.integration.discoverTree(root, context)) {
        addFact(facts, fact);
    }

    const stack = [...(root?.namedChildren || [])];
    while(stack.length > 0) {
        const node = stack.pop();
        if(!node || isCommentNode(node) || isErrorNode(node)) {
            continue;
        }
        for(const fact of context.integration.discoverNode(node, context)) {
            addFact(facts, fact);
        }

        for(const child of node.namedChildren || []) {
            stack.push(child);
        }
    }
}

function collectLineFacts(lines, facts, context) {
    for(let i = 0; i < lines.length; i++) {
        const line = lines[i] || '';
        const trimmed = line.trim();
        if(!trimmed || context.integration.classifyLine(trimmed).commentOnly) {
            continue;
        }
        const lineNo = i + 1;
        for(const fact of context.integration.discoverLine(trimmed, {...context, lineNo})) {
            addFact(facts, fact);
        }
    }
}

function addFact(facts, input) {
    const name = cleanFactText(input.name);
    const target = cleanFactText(input.target);
    if(!input.kind || (!name && !target)) {
        return;
    }
    facts.push({
        kind: String(input.kind),
        name,
        target,
        detail: cleanFactText(input.detail),
        lineStart: Number(input.lineStart) || 1,
        lineEnd: Number(input.lineEnd) || Number(input.lineStart) || 1,
        syntax: input.syntax || null
    });
}

function cleanFactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function dedupeFacts(facts) {
    const seen = new Set();
    const out = [];
    for(const item of facts) {
        const key = [item.kind, item.name, item.target, item.lineStart, item.lineEnd].join('\t');
        if(seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function symbolRangesFromFacts(facts) {
    return dedupeFacts(facts)
        .filter((fact) => fact.kind === 'definition' && fact.name && fact.lineStart && fact.lineEnd)
        .map((fact) => ({
            name: fact.name,
            kind: fact.detail || fact.kind,
            lineStart: fact.lineStart,
            lineEnd: fact.lineEnd,
            grammar: fact.syntax?.grammar || ''
        }))
        .sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd || a.name.localeCompare(b.name));
}

async function loadParser() {
    if(!parserModulePromise) {
        parserModulePromise = import('web-tree-sitter').then((mod) => mod.default || mod);
    }
    const Parser = await parserModulePromise;
    if(!parserInitPromise) {
        parserInitPromise = Parser.init({
            locateFile: () => require.resolve('web-tree-sitter/tree-sitter.wasm')
        });
    }
    await parserInitPromise;
    return Parser;
}

async function loadLanguage(Parser, grammar) {
    if(!languagePromises.has(grammar)) {
        languagePromises.set(grammar, Parser.Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`)));
    }
    return languagePromises.get(grammar);
}

function markSyntaxLines(node, marks, descriptor) {
    const stack = [node];
    while(stack.length > 0) {
        const current = stack.pop();
        if(!current || current === node) {
            for(const child of current?.namedChildren || []) {
                stack.push(child);
            }
            continue;
        }

        const range = nodeLineRange(current, marks.length);
        if(range) {
            const comment = isCommentNode(current);
            const error = isErrorNode(current);
            const string = isStringNode(current);
            const namedLeaf = current.isNamed() && current.namedChildCount === 0;
            for(let line = range.lineStart; line <= range.lineEnd; line++) {
                const mark = marks[line - 1];
                if(!mark) continue;
                mark.nodeTypes.add(current.type);
                if(comment) mark.hasComment = true;
                if(error) mark.hasError = true;
                if(string) mark.hasString = true;
                if(namedLeaf && !comment && !error && (!string || STRING_VALUE_FAMILIES.has(descriptor.family)) && String(current.text || '').trim()) {
                    mark.hasCode = true;
                }
            }
        }

        for(const child of current.namedChildren || []) {
            stack.push(child);
        }
    }
}

function sourceDescriptor(context = {}) {
    const integration = resolveLanguageIntegration(context);
    return integration ? descriptor(integration.family, integration.grammar) : descriptor('unknown');
}

function sourceIntegration(context = {}) {
    return resolveLanguageIntegration(context);
}

function descriptor(family, grammar = null) {
    return {family, grammar};
}

function isStringNode(node) {
    return /string/.test(String(node?.type || ''));
}

function flushGroup(chunks, lines, group) {
    if(!group) return;
    chunks.push({
        lineStart: group.lineStart,
        lineEnd: group.lineEnd,
        content: sliceLines(lines, group.lineStart, group.lineEnd),
        syntax: group.syntax || null
    });
}

function windowRange(lines, lineStart, lineEnd, targetLines, overlapLines, syntax = null) {
    const chunks = [];
    const stride = Math.max(1, targetLines - overlapLines);
    let cursor = lineStart;
    while(cursor <= lineEnd) {
        const end = Math.min(lineEnd, cursor + targetLines - 1);
        chunks.push({
            lineStart: cursor,
            lineEnd: end,
            content: sliceLines(lines, cursor, end),
            syntax
        });
        if(end >= lineEnd) break;
        cursor += stride;
    }
    return chunks;
}

function mergeSyntax(a, b) {
    if(!a && !b) return null;
    return {
        engine: 'tree-sitter',
        grammar: a?.grammar || b?.grammar || '',
        nodeTypes: uniqueStrings([...(a?.nodeTypes || []), ...(b?.nodeTypes || [])]).slice(0, 16),
        symbols: uniqueStrings([...(a?.symbols || []), ...(b?.symbols || [])]).slice(0, 32),
        imports: uniqueStrings([...(a?.imports || []), ...(b?.imports || [])]).slice(0, 24)
    };
}

function uniqueStrings(values) {
    const out = [];
    const seen = new Set();
    for(const value of values) {
        const text = String(value || '').trim();
        if(!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

function sliceLines(lines, lineStart, lineEnd) {
    return lines.slice(lineStart - 1, lineEnd).join(EOL);
}

function dedupeChunks(chunks) {
    const seen = new Set();
    const out = [];
    for(const chunk of chunks) {
        const key = `${chunk.lineStart}:${chunk.lineEnd}`;
        if(seen.has(key) || !String(chunk.content || '').trim()) {
            continue;
        }
        seen.add(key);
        out.push(chunk);
    }
    return out;
}

const STRING_VALUE_FAMILIES = new Set([
    'json',
    'yaml',
    'toml',
    'markup',
    'template'
]);

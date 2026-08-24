import {splitIdentifier} from '../util/retrieval-core.js';

// Builds the text embedded per chunk: the file path/name terms, syntax terms, and
// code identifier terms folded in front of the chunk content (plus the index-time
// enrichment description when present), so both code-identifier and product-phrased
// questions match. Extracted from indexer.js; the output must stay byte-identical
// (it defines the stored vectors) — EMBEDDING_TEXT_VERSION reindexes on any change.
//

export const EMBEDDING_TEXT_VERSION = '1';

export function buildEmbeddingText(rel, chunk, description = '') {
    const pathParts = rel.split(/[\\/]/).filter(Boolean);
    const dir = pathParts.slice(0, -1).join('/') || '.';
    const file = pathParts.at(-1) || rel;
    const pathTokens = pathParts
        .flatMap(splitIdentifierLower)
        .filter(Boolean)
        .join(' ');
    const codeTerms = extractCodeTerms(chunk.content);
    const syntaxTerms = syntaxTermsForEmbedding(chunk.syntax);
    const range = chunk.lineStart > 1 ? ` lines ${chunk.lineStart}-${chunk.lineEnd}` : '';
    return [
        description ? `Purpose: ${description}` : null,
        `File: ${rel}${range}`,
        `Directory: ${dir}`,
        `Name terms: ${splitIdentifierLower(file).join(' ')} ${pathTokens}`,
        syntaxTerms ? `Syntax: ${syntaxTerms}` : null,
        codeTerms ? `Code terms: ${codeTerms}` : null,
        '',
        chunk.content
    ].filter(Boolean).join('\n');
}

function syntaxTermsForEmbedding(syntax) {
    if(!syntax || typeof syntax !== 'object') {
        return '';
    }
    return [
        syntax.grammar ? `grammar ${syntax.grammar}` : null,
        termsWithLabel('node', syntax.nodeTypes),
        termsWithLabel('symbol', syntax.symbols),
        termsWithLabel('import', syntax.imports)
    ].filter(Boolean).join(' ');
}

function termsWithLabel(label, values) {
    if(!Array.isArray(values) || values.length === 0) {
        return '';
    }
    return values
        .flatMap((value) => splitIdentifierLower(value).map((part) => `${label} ${part}`))
        .slice(0, 80)
        .join(' ');
}

function extractCodeTerms(content) {
    const text = String(content || '');
    const terms = new Set();
    for(const match of text.matchAll(/[A-Za-z_$][\w$]{2,}/g)) {
        for(const part of splitIdentifierLower(match[0])) {
            const term = part.toLowerCase();
            if(term.length >= 3 && !CODE_TERM_STOPWORDS.has(term)) {
                terms.add(term);
            }
        }
    }
    return [...terms].slice(0, 80).join(' ');
}

// The embedding text indexes lowercased identifier tokens, so every call here uses
// the shared splitter's lowerCase mode (kept byte-identical to the former local copy).
//
function splitIdentifierLower(value) {
    return splitIdentifier(value, {lowerCase: true});
}

const CODE_TERM_STOPWORDS = new Set([
    'and', 'are', 'async', 'await', 'class', 'const', 'def', 'else', 'enum',
    'false', 'for', 'from', 'func', 'function', 'impl', 'import', 'interface',
    'let', 'module', 'nil', 'none', 'null', 'package', 'private', 'protected',
    'public', 'return', 'self', 'static', 'struct', 'this', 'trait', 'true',
    'type', 'undefined', 'use', 'using', 'var', 'while', 'with'
]);

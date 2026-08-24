export const rustAnnotation = {
    describeLine({trimmed, lines, lineNumber, syntaxRole, discoveryFacts}) {
        const symbol = symbolInfo(trimmed);
        const binding = bindingInfo(trimmed);
        const call = callInfo(trimmed);
        const facts = [...discoveryFacts];
        if(symbol) {
            facts.push(`definition: ${symbol.name}`);
        }
        if(binding) {
            facts.push(`assigns: ${binding.name}`);
        }
        if(call) {
            facts.push(`calls: ${call.name}`);
        }
        const enclosing = nearestEnclosingSymbol(lines, lineNumber);
        if(enclosing?.name && enclosing.name !== symbol?.name) {
            facts.push(`inside: ${enclosing.name}`);
        }

        return {
            role: roleForLine({trimmed, symbol, binding, call, syntaxRole}),
            facts,
            note: noteForLine({trimmed, symbol, binding}),
            score: scoreLine({trimmed, symbol, binding, call}),
            worthy: isWorthyLine(trimmed)
        };
    },
    symbolAtLine({line}) {
        return symbolInfo(String(line || '').trim());
    },
    findSymbolRange({lines, terms}) {
        if(!terms || terms.size === 0) {
            return null;
        }
        for(let index = 0; index < lines.length; index++) {
            const symbol = symbolInfo(String(lines[index] || '').trim());
            if(!symbol?.name || !terms.has(symbol.name.toLowerCase())) {
                continue;
            }
            return {
                start: includeLeadingComments(lines, index),
                end: symbolEndByBalancedBraces(lines, index)
            };
        }
        return null;
    }
};

function roleForLine({trimmed, symbol, binding, call, syntaxRole}) {
    if(symbol) return `${symbol.kind} boundary`;
    if(/\breturn\b/.test(trimmed) || trimmed.startsWith('Ok(') || trimmed.startsWith('Err(')) return 'output boundary';
    if(/\bmatch\b|\bif\b|\belse\b/.test(trimmed)) return 'branch';
    if(/\bfor\b|\bwhile\b|\bloop\b/.test(trimmed)) return 'iteration';
    if(binding) return 'state/data';
    if(call) return 'call boundary';
    return syntaxRole || 'supporting statement';
}

function scoreLine({trimmed, symbol, binding, call}) {
    let score = 0;
    if(symbol) score += 25;
    if(binding) score += 20;
    if(call) score += 30;
    if(/\b(return|await|match|if|else|for|while|loop)\b/.test(trimmed)) score += 24;
    if(/[?!];?$/.test(trimmed)) score += 12;
    return score;
}

function noteForLine({trimmed, symbol, binding}) {
    if(symbol) {
        return `Introduces ${symbol.name}, the ${symbol.kind} this excerpt is explaining.`;
    }
    if(binding) {
        return `Binds ${binding.name} so later Rust code in this scope can use it.`;
    }
    if(trimmed.startsWith('return ')) {
        return 'Returns the value that exits this Rust scope.';
    }
    return '';
}

function isWorthyLine(trimmed) {
    return Boolean(trimmed && !/^\/\//.test(trimmed) && !/^[()[\]{};,]+$/.test(trimmed));
}

function symbolInfo(trimmed) {
    const patterns = [
        {kind: 'function', re: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
        {kind: 'struct', re: /^(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
        {kind: 'enum', re: /^(?:pub\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
        {kind: 'trait', re: /^(?:pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
        {kind: 'implementation', re: /^impl(?:\s+<[^>]+>)?\s+([A-Za-z_][A-Za-z0-9_]*)\b/},
        {kind: 'module', re: /^(?:pub\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\b/}
    ];
    for(const {kind, re} of patterns) {
        const match = trimmed.match(re);
        if(match) {
            return {kind, name: match[1]};
        }
    }
    return null;
}

function bindingInfo(trimmed) {
    const match = trimmed.match(/^let\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/);
    return match ? {name: match[1]} : null;
}

function callInfo(trimmed) {
    const match = trimmed.match(/\b([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\(/);
    if(!match || RUST_CALL_KEYWORDS.has(match[1])) {
        return null;
    }
    return {name: match[1]};
}

function nearestEnclosingSymbol(lines, lineNumber) {
    for(let index = lineNumber - 1; index >= 0; index--) {
        const symbol = symbolInfo(String(lines[index] || '').trim());
        if(symbol) {
            return symbol;
        }
    }
    return null;
}

function includeLeadingComments(lines, symbolIndex) {
    let start = symbolIndex;
    for(let index = symbolIndex - 1; index >= Math.max(0, symbolIndex - 4); index--) {
        const trimmed = String(lines[index] || '').trim();
        if(trimmed === '' || /^\/\//.test(trimmed)) {
            start = index;
            continue;
        }
        break;
    }
    return start;
}

function symbolEndByBalancedBraces(lines, symbolIndex) {
    const opening = findBodyOpening(lines, symbolIndex);
    if(!opening) {
        return symbolIndex + 1;
    }
    let depth = 0;
    for(let index = opening.line; index < lines.length; index++) {
        const line = stripQuotedSource(String(lines[index] || ''));
        const startColumn = index === opening.line ? opening.column : 0;
        for(let column = startColumn; column < line.length; column++) {
            const ch = line[column];
            if(ch === '{') {
                depth++;
            } else if(ch === '}') {
                depth = Math.max(0, depth - 1);
                if(depth === 0) {
                    return index + 1;
                }
            }
        }
    }
    return lines.length;
}

function findBodyOpening(lines, symbolIndex) {
    for(let index = symbolIndex; index < Math.min(lines.length, symbolIndex + 16); index++) {
        const column = stripQuotedSource(String(lines[index] || '')).indexOf('{');
        if(column >= 0) {
            return {line: index, column};
        }
        if(index > symbolIndex && symbolInfo(String(lines[index] || '').trim())) {
            return null;
        }
    }
    return null;
}

function stripQuotedSource(line) {
    let out = '';
    let quote = '';
    let escaped = false;
    for(let index = 0; index < line.length; index++) {
        const ch = line[index];
        const next = line[index + 1];
        if(quote) {
            if(escaped) {
                escaped = false;
            } else if(ch === '\\') {
                escaped = true;
            } else if(ch === quote) {
                quote = '';
            }
            out += ' ';
            continue;
        }
        if(ch === '/' && next === '/') {
            break;
        }
        if(ch === '"' || ch === '\'') {
            quote = ch;
            out += ' ';
            continue;
        }
        out += ch;
    }
    return out;
}

const RUST_CALL_KEYWORDS = new Set(['if', 'for', 'while', 'loop', 'match', 'return']);

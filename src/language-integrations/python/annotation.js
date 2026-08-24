export const pythonAnnotation = {
    describeLine({trimmed, lines, lineNumber, syntaxRole, discoveryFacts}) {
        const symbol = symbolInfo(trimmed);
        const assignment = assignmentInfo(trimmed);
        const call = callInfo(trimmed);
        const facts = [...discoveryFacts];
        if(symbol) {
            facts.push(`definition: ${symbol.name}`);
        }
        if(assignment) {
            facts.push(`assigns: ${assignment.name}`);
        }
        if(call) {
            facts.push(`calls: ${call.name}`);
        }
        const enclosing = nearestEnclosingSymbol(lines, lineNumber);
        if(enclosing?.name && enclosing.name !== symbol?.name) {
            facts.push(`inside: ${enclosing.name}`);
        }

        return {
            role: roleForLine({trimmed, symbol, assignment, call, syntaxRole}),
            facts,
            note: noteForLine({trimmed, symbol, assignment, call}),
            score: scoreLine({trimmed, symbol, assignment, call}),
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
                end: symbolEndByIndentation(lines, index)
            };
        }
        return null;
    }
};

function roleForLine({trimmed, symbol, assignment, call, syntaxRole}) {
    if(symbol) return `${symbol.kind} boundary`;
    if(/\breturn\b/.test(trimmed)) return 'output boundary';
    if(/\braise\b/.test(trimmed) || /\bexcept\b/.test(trimmed)) return 'error boundary';
    if(/\bif\b|\belif\b|\belse\b|\bmatch\b|\bcase\b/.test(trimmed)) return 'branch';
    if(/\bfor\b|\bwhile\b/.test(trimmed)) return 'iteration';
    if(assignment) return 'state/data';
    if(call) return 'call boundary';
    return syntaxRole || 'supporting statement';
}

function scoreLine({trimmed, symbol, assignment, call}) {
    let score = 0;
    if(symbol) score += 25;
    if(call) score += 30;
    if(assignment) score += 20;
    if(/\b(return|raise|yield|await)\b/.test(trimmed)) score += 35;
    if(/\b(if|elif|else|match|case|for|while|try|except|finally)\b/.test(trimmed)) score += 18;
    return score;
}

function noteForLine({trimmed, symbol, assignment, call}) {
    if(symbol) {
        return `Introduces ${symbol.name}, the ${symbol.kind} this excerpt is explaining.`;
    }
    if(assignment) {
        return `Stores ${assignment.name} so later Python logic in this scope can use it.`;
    }
    if(call) {
        return '';
    }
    if(/\breturn\b/.test(trimmed)) {
        return 'Returns the value that leaves this Python scope.';
    }
    if(/\braise\b/.test(trimmed)) {
        return 'Raises an error so the failure path is explicit instead of continuing silently.';
    }
    return '';
}

function isWorthyLine(trimmed) {
    return Boolean(trimmed && !/^#/.test(trimmed) && !/^[()[\]{},:]+$/.test(trimmed));
}

function symbolInfo(trimmed) {
    const match = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\b/) ||
        trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if(!match) {
        return null;
    }
    return {
        kind: trimmed.startsWith('class ') ? 'class' : 'function',
        name: match[1]
    };
}

function assignmentInfo(trimmed) {
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(.+)$/);
    return match ? {name: match[1], expression: match[2]} : null;
}

function callInfo(trimmed) {
    const match = trimmed
        .replace(/^(?:return|await)\s+/, '')
        .match(/\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\(/);
    if(!match || PYTHON_CALL_KEYWORDS.has(match[1])) {
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
        if(trimmed === '' || /^#/.test(trimmed)) {
            start = index;
            continue;
        }
        break;
    }
    return start;
}

function symbolEndByIndentation(lines, symbolIndex) {
    const symbolLine = String(lines[symbolIndex] || '');
    const baseIndent = leadingWhitespaceLength(symbolLine);
    let sawBody = false;
    for(let index = symbolIndex + 1; index < lines.length; index++) {
        const line = String(lines[index] || '');
        const inner = line.trim();
        if(!inner) {
            continue;
        }
        const indent = leadingWhitespaceLength(line);
        if(indent > baseIndent) {
            sawBody = true;
            continue;
        }
        return sawBody ? index : symbolIndex + 1;
    }
    return sawBody ? lines.length : symbolIndex + 1;
}

function leadingWhitespaceLength(line) {
    return (String(line || '').match(/^\s*/) || [''])[0].length;
}

const PYTHON_CALL_KEYWORDS = new Set(['if', 'for', 'while', 'with', 'except', 'return', 'await']);

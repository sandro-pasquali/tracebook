export function createCurlyBraceAnnotation({
    languageName,
    definitionPatterns = [],
    bindingPatterns = [],
    callPattern = /\b([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\(/,
    callKeywords = [],
    commentPattern = /^\/\//,
    branchPattern = /\b(if|else|switch|case|match|catch|guard|when)\b/,
    iterationPattern = /\b(for|while|loop|foreach)\b/,
    outputPattern = /\b(return|yield|throw|raise|break|continue)\b/,
    awaitPattern = /\b(await|async)\b/,
    stringQuotes = ['"', '\'']
} = {}) {
    const callKeywordSet = new Set(callKeywords);

    return {
        describeLine({trimmed, lines, lineNumber, syntaxRole, discoveryFacts}) {
            const symbol = symbolInfo(trimmed, definitionPatterns);
            const binding = bindingInfo(trimmed, bindingPatterns);
            const call = callInfo(trimmed, callPattern, callKeywordSet);
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
            const enclosing = nearestEnclosingSymbol(lines, lineNumber, definitionPatterns);
            if(enclosing?.name && enclosing.name !== symbol?.name) {
                facts.push(`inside: ${enclosing.name}`);
            }

            return {
                role: roleForCurlyLine({trimmed, symbol, binding, call, syntaxRole, branchPattern, iterationPattern, outputPattern}),
                facts,
                note: noteForCurlyLine({languageName, trimmed, symbol, binding, outputPattern}),
                score: scoreCurlyLine({trimmed, symbol, binding, call, branchPattern, iterationPattern, outputPattern, awaitPattern}),
                worthy: isWorthyCurlyLine(trimmed, commentPattern)
            };
        },
        storyForExcerpt({lines, context = {}}) {
            return genericStory({lines, context, languageName});
        },
        symbolAtLine({line}) {
            return symbolInfo(String(line || '').trim(), definitionPatterns);
        },
        findSymbolRange({lines, terms}) {
            return findCurlySymbolRange({
                lines,
                terms,
                definitionPatterns,
                commentPattern,
                stringQuotes
            });
        }
    };
}

export function createBlockAnnotation({
    languageName,
    definitionPatterns = [],
    bindingPatterns = [],
    callPattern = /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*(?:\(|$)/,
    callKeywords = [],
    commentPattern = /^#/,
    branchPattern = /\b(if|elsif|else|case|when|cond|unless)\b/,
    iterationPattern = /\b(for|while|until|each|loop)\b/,
    outputPattern = /\b(return|yield|raise|throw)\b/,
    blockEndPattern = /^end\b/
} = {}) {
    const callKeywordSet = new Set(callKeywords);

    return {
        describeLine({trimmed, lines, lineNumber, syntaxRole, discoveryFacts}) {
            const symbol = symbolInfo(trimmed, definitionPatterns);
            const binding = bindingInfo(trimmed, bindingPatterns);
            const call = callInfo(trimmed, callPattern, callKeywordSet);
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
            const enclosing = nearestEnclosingSymbol(lines, lineNumber, definitionPatterns);
            if(enclosing?.name && enclosing.name !== symbol?.name) {
                facts.push(`inside: ${enclosing.name}`);
            }

            return {
                role: roleForBlockLine({trimmed, symbol, binding, call, syntaxRole, branchPattern, iterationPattern, outputPattern}),
                facts,
                note: noteForBlockLine({languageName, trimmed, symbol, binding, outputPattern}),
                score: scoreBlockLine({trimmed, symbol, binding, call, branchPattern, iterationPattern, outputPattern}),
                worthy: isWorthyBlockLine(trimmed, commentPattern, blockEndPattern)
            };
        },
        storyForExcerpt({lines, context = {}}) {
            return genericStory({lines, context, languageName});
        },
        symbolAtLine({line}) {
            return symbolInfo(String(line || '').trim(), definitionPatterns);
        },
        findSymbolRange({lines, terms}) {
            return findBlockSymbolRange({
                lines,
                terms,
                definitionPatterns,
                commentPattern,
                blockEndPattern
            });
        }
    };
}

export function createShellAnnotation({languageName = 'shell'} = {}) {
    return createBlockAnnotation({
        languageName,
        definitionPatterns: [
            {kind: 'function', re: /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{/},
            {kind: 'function', re: /^function\s+([A-Za-z_][A-Za-z0-9_]*)\b/}
        ],
        bindingPatterns: [
            /^([A-Za-z_][A-Za-z0-9_]*)=/
        ],
        callPattern: /^([A-Za-z_][A-Za-z0-9_.:-]*)\b/,
        callKeywords: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function'],
        commentPattern: /^#/,
        branchPattern: /\b(if|elif|else|case)\b/,
        iterationPattern: /\b(for|while|until|select)\b/,
        outputPattern: /\b(return|exit|echo|printf)\b/,
        blockEndPattern: /^(fi|done|esac|\})$/
    });
}

export function createConfigAnnotation({languageName, entrySeparator = ':'} = {}) {
    return {
        describeLine({trimmed, discoveryFacts}) {
            const entry = configEntry(trimmed, entrySeparator);
            return {
                role: entry ? 'configuration entry' : '',
                facts: entry ? [`configuration: ${entry.key}`, ...discoveryFacts] : discoveryFacts,
                note: entry ? `Sets ${entry.key}, a configuration value consumed by code or tooling.` : '',
                score: entry ? 20 : 0,
                worthy: Boolean(trimmed && !/^[{}[\],]+$/.test(trimmed) && !/^#|^\/\//.test(trimmed))
            };
        },
        storyForExcerpt({lines, context = {}}) {
            const text = [context.question, context.intent, context.caption, ...(lines || [])]
                .filter(Boolean)
                .join('\n')
                .toLowerCase();
            return /\b(config|configuration|setting|option|manifest|metadata)\b/.test(text)
                ? `${languageName || 'Configuration'} entries provide values consumed by tools or runtime code.`
                : '';
        }
    };
}

function roleForCurlyLine({trimmed, symbol, binding, call, syntaxRole, branchPattern, iterationPattern, outputPattern}) {
    if(symbol) return `${symbol.kind} boundary`;
    if(outputPattern.test(trimmed)) return 'output boundary';
    if(branchPattern.test(trimmed)) return 'branch';
    if(iterationPattern.test(trimmed)) return 'iteration';
    if(binding) return 'state/data';
    if(call) return 'call boundary';
    return syntaxRole || 'supporting statement';
}

function roleForBlockLine({trimmed, symbol, binding, call, syntaxRole, branchPattern, iterationPattern, outputPattern}) {
    if(symbol) return `${symbol.kind} boundary`;
    if(outputPattern.test(trimmed)) return 'output boundary';
    if(branchPattern.test(trimmed)) return 'branch';
    if(iterationPattern.test(trimmed)) return 'iteration';
    if(binding) return 'state/data';
    if(call) return 'call boundary';
    return syntaxRole || 'supporting statement';
}

function scoreCurlyLine({trimmed, symbol, binding, call, branchPattern, iterationPattern, outputPattern, awaitPattern}) {
    let score = 0;
    if(symbol) score += 25;
    if(binding) score += 20;
    if(call) score += 30;
    if(outputPattern.test(trimmed)) score += 35;
    if(branchPattern.test(trimmed) || iterationPattern.test(trimmed)) score += 20;
    if(awaitPattern.test(trimmed)) score += 16;
    if(/[?!];?$/.test(trimmed)) score += 10;
    return score;
}

function scoreBlockLine({trimmed, symbol, binding, call, branchPattern, iterationPattern, outputPattern}) {
    let score = 0;
    if(symbol) score += 25;
    if(binding) score += 20;
    if(call) score += 28;
    if(outputPattern.test(trimmed)) score += 30;
    if(branchPattern.test(trimmed) || iterationPattern.test(trimmed)) score += 18;
    return score;
}

function noteForCurlyLine({languageName, trimmed, symbol, binding, outputPattern}) {
    if(symbol) {
        return `Introduces ${symbol.name}, the ${symbol.kind} this ${languageName} excerpt is explaining.`;
    }
    if(binding) {
        return `Binds ${binding.name} so later ${languageName} code in this scope can use it.`;
    }
    if(outputPattern.test(trimmed)) {
        return `Controls what leaves this ${languageName} scope or how it stops executing.`;
    }
    return '';
}

function noteForBlockLine({languageName, trimmed, symbol, binding, outputPattern}) {
    if(symbol) {
        return `Introduces ${symbol.name}, the ${symbol.kind} this ${languageName} excerpt is explaining.`;
    }
    if(binding) {
        return `Stores ${binding.name} so later ${languageName} code in this scope can use it.`;
    }
    if(outputPattern.test(trimmed)) {
        return `Controls what leaves this ${languageName} scope or how it stops executing.`;
    }
    return '';
}

function isWorthyCurlyLine(trimmed, commentPattern) {
    return Boolean(trimmed && !commentPattern.test(trimmed) && !/^[()[\]{};,]+$/.test(trimmed));
}

function isWorthyBlockLine(trimmed, commentPattern, blockEndPattern) {
    return Boolean(trimmed && !commentPattern.test(trimmed) && !blockEndPattern.test(trimmed) && !/^[()[\]{};,]+$/.test(trimmed));
}

function symbolInfo(trimmed, definitionPatterns) {
    for(const {kind, re} of definitionPatterns) {
        const match = trimmed.match(re);
        if(match?.[1]) {
            return {kind, name: match[1]};
        }
    }
    return null;
}

function bindingInfo(trimmed, bindingPatterns) {
    for(const re of bindingPatterns) {
        const match = trimmed.match(re);
        if(match?.[1]) {
            return {name: match[1]};
        }
    }
    return null;
}

function callInfo(trimmed, callPattern, callKeywordSet) {
    const source = String(trimmed || '')
        .replace(/^(?:return|await|try|throw|raise|yield)\s+/, '')
        .replace(/^(?:let|var|const|auto|final|val|var|mut)\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, '');
    const match = source.match(callPattern);
    const name = match?.[1] || '';
    if(!name || callKeywordSet.has(name.toLowerCase())) {
        return null;
    }
    return {name};
}

function nearestEnclosingSymbol(lines, lineNumber, definitionPatterns) {
    for(let index = lineNumber - 1; index >= 0; index--) {
        const symbol = symbolInfo(String(lines[index] || '').trim(), definitionPatterns);
        if(symbol) {
            return symbol;
        }
    }
    return null;
}

function findCurlySymbolRange({lines, terms, definitionPatterns, commentPattern, stringQuotes}) {
    if(!terms || terms.size === 0) {
        return null;
    }
    for(let index = 0; index < lines.length; index++) {
        const symbol = symbolInfo(String(lines[index] || '').trim(), definitionPatterns);
        if(!symbol?.name || !terms.has(symbol.name.toLowerCase())) {
            continue;
        }
        return {
            start: includeLeadingComments(lines, index, commentPattern),
            end: symbolEndByBalancedBraces(lines, index, stringQuotes)
        };
    }
    return null;
}

function findBlockSymbolRange({lines, terms, definitionPatterns, commentPattern, blockEndPattern}) {
    if(!terms || terms.size === 0) {
        return null;
    }
    for(let index = 0; index < lines.length; index++) {
        const symbol = symbolInfo(String(lines[index] || '').trim(), definitionPatterns);
        if(!symbol?.name || !terms.has(symbol.name.toLowerCase())) {
            continue;
        }
        return {
            start: includeLeadingComments(lines, index, commentPattern),
            end: symbolEndByBlock(lines, index, blockEndPattern)
        };
    }
    return null;
}

function includeLeadingComments(lines, symbolIndex, commentPattern) {
    let start = symbolIndex;
    for(let index = symbolIndex - 1; index >= Math.max(0, symbolIndex - 4); index--) {
        const trimmed = String(lines[index] || '').trim();
        if(trimmed === '' || commentPattern.test(trimmed)) {
            start = index;
            continue;
        }
        break;
    }
    return start;
}

function symbolEndByBalancedBraces(lines, symbolIndex, stringQuotes) {
    const opening = findBodyOpening(lines, symbolIndex, stringQuotes);
    if(!opening) {
        return symbolIndex + 1;
    }
    let depth = 0;
    for(let index = opening.line; index < lines.length; index++) {
        const line = stripQuotedSource(String(lines[index] || ''), stringQuotes);
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

function findBodyOpening(lines, symbolIndex, stringQuotes) {
    for(let index = symbolIndex; index < Math.min(lines.length, symbolIndex + 16); index++) {
        const column = stripQuotedSource(String(lines[index] || ''), stringQuotes).indexOf('{');
        if(column >= 0) {
            return {line: index, column};
        }
    }
    return null;
}

function symbolEndByBlock(lines, symbolIndex, blockEndPattern) {
    let depth = 0;
    for(let index = symbolIndex; index < lines.length; index++) {
        const trimmed = String(lines[index] || '').trim();
        if(index === symbolIndex || startsBlock(trimmed)) {
            depth++;
        }
        if(blockEndPattern.test(trimmed)) {
            depth = Math.max(0, depth - 1);
            if(depth === 0) {
                return index + 1;
            }
        }
    }
    return lines.length;
}

function startsBlock(trimmed) {
    return /^(def|class|module|if|unless|case|for|while|until|begin|do|try|receive|fn)\b/.test(trimmed);
}

function stripQuotedSource(line, stringQuotes = ['"', '\'']) {
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
        if(stringQuotes.includes(ch)) {
            quote = ch;
            out += ' ';
            continue;
        }
        out += ch;
    }
    return out;
}

function configEntry(trimmed, entrySeparator) {
    const escaped = entrySeparator === ':' ? ':' : '=';
    const match = String(trimmed || '').match(new RegExp(`^["']?([A-Za-z0-9_.-]+)["']?\\s*${escaped}\\s*(.+)$`));
    return match ? {key: match[1], value: match[2]} : null;
}

function genericStory({lines, context = {}, languageName}) {
    const text = [context.question, context.intent, context.caption, ...(lines || [])]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
    const story = [];
    if(/\b(request|response|route|handler|controller|endpoint)\b/.test(text)) {
        story.push(`This ${languageName} excerpt participates in a request or handler flow.`);
    }
    if(/\b(save|persist|insert|update|query|select|repository|database|store)\b/.test(text)) {
        story.push(`It reads or writes state that other ${languageName} code depends on.`);
    }
    if(/\b(error|exception|throw|raise|catch|rescue|result|failure)\b/.test(text)) {
        story.push('The excerpt includes a failure path that changes how execution continues.');
    }
    return story.join(' ');
}

export const javascriptAnnotation = {
    describeLine({trimmed, lines, lineNumber, context, syntaxRole, discoveryFacts}) {
        const facts = [...discoveryFacts];
        const enclosing = nearestEnclosingContext(lines, lineNumber, context);
        if(enclosing?.name) {
            facts.push(`inside: ${enclosing.name}`);
        }

        const domMutation = domMutationInfo(trimmed);
        if(domMutation) {
            facts.push(domMutation.clears ? `clears UI: ${domMutation.owner}` : `updates UI: ${domMutation.owner}`);
        }

        const assignment = assignmentInfo(trimmed);
        if(assignment?.name) {
            facts.push(`assigns: ${assignment.name}`);
        }

        const call = callInfo(trimmed);
        if(call) {
            facts.push(`calls: ${callLabel(call)}`);
        }

        const imported = importInfo(trimmed);
        if(imported?.target) {
            facts.push(`imports: ${imported.target}`);
        }

        const route = routeInfo(trimmed);
        if(route) {
            facts.push(`route: ${route.method} ${route.path}`);
        }

        const storage = storageFact(trimmed);
        if(storage) {
            facts.push(storage);
        }

        return {
            role: roleForLine({trimmed, call, route, domMutation, assignment, syntaxRole}),
            facts,
            note: noteForLine({trimmed, call, assignment, domMutation, lines, lineNumber, context}),
            score: scoreLine({trimmed, call, domMutation}),
            worthy: isWorthyLine(trimmed, context),
            semanticKey: semanticKeyForLine(trimmed)
        };
    },
    storyForExcerpt({lines, context = {}}) {
        const text = [
            context.question,
            context.intent,
            context.caption,
            ...(Array.isArray(lines) ? lines : [])
        ].filter(Boolean).join('\n').toLowerCase();
        const story = [];
        if(/\bstream|streaming|sse|emit|send|publish|event\b/.test(text)) {
            story.push('The excerpt sends incremental data or events instead of waiting for one final result.');
        }
        if(/\babortcontroller\b|onabort|\.abort\(/.test(text)) {
            story.push('Cancellation is wired into the flow so abandoned work can stop.');
        }
        if(/\bfor await/.test(text)) {
            story.push('Async iteration consumes produced values as they arrive.');
        }
        if(/\bcache|memo|replay|prior|history\b/.test(text)) {
            story.push('Cached or prior state can be reused instead of recomputing everything.');
        }
        if(/\bsave|persist|insert|update|upsert|write|record\b/.test(text)) {
            story.push('The flow records durable state after the important work completes.');
        }
        if(/\breq|request|body|json|response|status|invalid\b/.test(text)) {
            story.push('Request validation happens before downstream work begins.');
        }
        return story.join(' ');
    },
    anchorScore({line, trimmed}) {
        return javascriptAnchorScore(String(trimmed ?? line ?? '').trim());
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
                end: symbolEndByStructure(lines, index)
            };
        }
        return null;
    }
};

function roleForLine({trimmed, call, route, domMutation, assignment, syntaxRole}) {
    if(syntaxRole && !['call boundary', 'state/data'].includes(syntaxRole)) {
        return syntaxRole;
    }
    if(route) return 'entrypoint';
    if(domMutation?.clears) return 'ui reset';
    if(domMutation) return 'ui update';
    if(isStreamingCall(call, trimmed)) return 'stream lifecycle';
    if(/\bfor await\b/.test(trimmed)) return 'event bridge';
    if(isCancellationCall(call, trimmed)) return 'cancellation';
    if(isPersistenceCall(call, trimmed)) return 'persistence';
    if(isValidationLine(trimmed)) return 'validation';
    if(/\bcatch\b|\.catch\s*\(/.test(trimmed)) return 'error boundary';
    if(isLoggingLine(trimmed)) return 'incidental logging';
    if(storageFact(trimmed)) return 'storage/retrieval';
    if(assignment) return 'state/data';
    const symbol = symbolInfo(trimmed);
    if(symbol) return `${symbol.kind} boundary`;
    return syntaxRole || 'supporting statement';
}

function scoreLine({trimmed, call, domMutation}) {
    let score = 0;
    if(/\bawait\b|\breturn\b|\.then\(|\bthrow\b|\byield\b/.test(trimmed)) score += 45;
    if(call) score += 28;
    if(/\.(json|connect|open|create|delete|add|query|where|limit|select|insert|update|save|write|send|emit|on|watch|remove|read)\b/.test(trimmed)) score += 20;
    if(/\b(document\.createElement|customElements\.define)\b|\.(appendChild|getAttribute|setAttribute|addEventListener|querySelector|innerHTML|textContent|className)\b/.test(trimmed)) score += 38;
    if(domMutation?.clears) score -= 10;
    if(/\bconst\s+[A-Za-z_$][\w$]*\s*=/.test(trimmed)) score += 24;
    if(/\b(if|for|while|switch|case)\b/.test(trimmed)) score += 18;
    if(/\btry\b|\bcatch\b/.test(trimmed)) score -= 22;
    if(routeInfo(trimmed)) score -= 18;
    if(/\b(export\s+)?(async\s+)?function\b|\bclass\b|=>\s*\{?\s*$/.test(trimmed)) score -= 18;
    if(/^[A-Za-z_$][\w$]*\s*:\s*[^;]+,?$/.test(trimmed)) score -= 30;
    if(/[({[]\s*$/.test(trimmed)) score -= 12;
    if(isStreamingCall(call, trimmed)) score += 55;
    if(isCancellationCall(call, trimmed)) score += 45;
    if(isLoggingLine(trimmed)) score -= 70;
    return score;
}

function isWorthyLine(trimmed, context = {}) {
    if(!trimmed || /^[{}()[\],;]+$/.test(trimmed)) {
        return false;
    }
    if(/^(?:else|\}?\s*catch|\}?\s*finally)\b/.test(trimmed)) {
        return false;
    }
    if(/^[A-Za-z_$][\w$]*\s*:\s*[^;]+,?$/.test(trimmed) && !/\bevent\s*:|data\s*:/.test(trimmed)) {
        return false;
    }
    if(isLoggingLine(trimmed)) {
        const text = [context.question, context.intent, context.caption]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
        return /\b(log|logging|diagnostic|debug|error|invalid|failure|warn)\b/.test(text);
    }
    return true;
}

function noteForLine({trimmed, call, assignment, domMutation, lines, lineNumber, context}) {
    if(domMutation) {
        return noteForDomMutation(domMutation, context);
    }
    if(call) {
        const note = noteForCall({call, trimmed, lines, lineNumber, context});
        if(note) {
            return note;
        }
    }
    if(assignment?.name) {
        return noteForAssignment({assignment, trimmed, context});
    }
    const symbol = symbolInfo(trimmed);
    if(symbol?.name) {
        return `Introduces ${symbol.name}, the ${symbol.kind} this excerpt is explaining.`;
    }
    return '';
}

function noteForCall({call, trimmed, lines, lineNumber, context}) {
    const streamNote = streamCallNote({call, trimmed, lines, lineNumber});
    if(streamNote) {
        return streamNote;
    }
    const uiClearNote = uiClearCallNote({call, context});
    if(uiClearNote) {
        return uiClearNote;
    }
    const response = responseCallInfo(trimmed, call);
    if(response) {
        return responseNote(response, context);
    }
    if(isRequestJsonCall(call)) {
        return 'Parses the request body as JSON; malformed payloads continue through the nearby error path.';
    }
    if(isLoggerCall(call)) {
        return loggerCallNote({call, trimmed, lines, lineNumber, context});
    }
    const storage = storageFact(trimmed);
    if(storage) {
        return noteForStorageFact(storage, context);
    }
    if(isDiskReadCall(call)) {
        return `Reads from the filesystem so the ${contextLabel(context)} path can work from current source content.`;
    }
    if(isAbortCall(call)) {
        return 'Stops the in-flight operation when the caller has already cancelled the request.';
    }
    return '';
}

// Cancellation registration is checked before streaming: a call like
// stream.onCancel(...) is wiring teardown, not emitting output, and labeling it
// "sends output" would be wrong. The bare "Sends incremental output…" phrasing
// is formulaic (weak-note filtered), so streaming lines only get a note when
// there is something concrete to teach: the boundary being opened or the named
// event being carried.
//
function streamCallNote({call, trimmed, lines, lineNumber}) {
    if(isCancellationCall(call, trimmed)) {
        return `Connects cancellation through ${callLabel(call)} so abandoned work can stop cleanly.`;
    }
    if(isStreamingCall(call, trimmed)) {
        const label = callLabel(call);
        const eventName = eventNameNear(lines, lineNumber);
        // A write/send/emit is output flowing through an already-open
        // boundary, even when awaited — only non-send calls open one. Without
        // this split every `await stream.writeSSE(...)` line repeats the
        // "Opens … as a streaming boundary" template.
        //
        if(isStreamSendCall(call)) {
            return eventName
                ? `Sends the ${eventName} event through ${label}, carrying this flow's next incremental update.`
                : '';
        }
        if(/\b(return|await)\b/.test(trimmed) && /stream/i.test(label)) {
            return `Opens ${label} as a streaming boundary so consumers can receive incremental updates.`;
        }
        return eventName
            ? `Sends the ${eventName} event through ${label}, carrying this flow's next incremental update.`
            : '';
    }
    if(/\bfor await\b/.test(trimmed)) {
        return 'Consumes an async sequence one item at a time, which is the boundary that makes incremental processing possible.';
    }
    return '';
}

function noteForAssignment({assignment, trimmed, context}) {
    const call = callInfo(trimmed);
    if(call && isRequestJsonCall(call)) {
        return `Stores the parsed JSON body in ${assignment.name} for validation and routing below.`;
    }
    if(call && responseCallInfo(trimmed, call)) {
        return `Stores ${assignment.name} from the response helper for the surrounding ${contextLabel(context)} path.`;
    }
    return `Stores ${assignment.name} for later ${contextLabel(context)} decisions.`;
}

function noteForDomMutation(domMutation, context = {}) {
    const target = readableDomTarget(domMutation.owner);
    if(domMutation.clears) {
        if(domMutation.property === 'innerHTML') {
            return `Clears ${target} so stale rendered content is removed before the next ${contextLabel(context)} state is shown.`;
        }
        if(domMutation.property === 'textContent') {
            return `Clears the visible text in ${target} before the next ${contextLabel(context)} state is shown.`;
        }
        if(domMutation.property === 'className') {
            return `Resets the CSS classes on ${target} so old visual state does not leak into the next render.`;
        }
        if(['value', 'checked'].includes(domMutation.property)) {
            return `Resets ${target}'s form state before the next ${contextLabel(context)} render uses it.`;
        }
    }
    if(domMutation.property === 'innerHTML') {
        return `Replaces the rendered content in ${target}, which is how this ${contextLabel(context)} view changes what the user sees.`;
    }
    if(domMutation.property === 'textContent') {
        return `Updates the visible text in ${target} for the current ${contextLabel(context)} state.`;
    }
    if(domMutation.property === 'className') {
        return `Updates CSS classes on ${target}, changing how this ${contextLabel(context)} region is styled or positioned.`;
    }
    if(['hidden', 'disabled', 'checked', 'value'].includes(domMutation.property)) {
        return `Updates ${target}'s ${domMutation.property} property so the UI matches the current ${contextLabel(context)} state.`;
    }
    return `Updates ${target} in the rendered UI.`;
}

function uiClearCallNote({call, context = {}}) {
    if(call?.method !== 'clear' || !isLikelyUiTarget(call.receiver, context)) {
        return '';
    }
    return `Clears ${readableDomTarget(call.receiver)} so stale UI from the previous ${contextLabel(context)} state does not remain visible.`;
}

// Teach the control-flow consequence (the caller gets THIS payload and later
// handling is skipped), not the syntax of the response call itself.
//
function responseNote(response, context) {
    const status = response.status ? `a ${response.status} status and ` : '';
    const payload = response.payload ? `the ${response.payload} ` : 'its ';
    if(response.method === 'json') {
        return `The ${contextLabel(context)} ends here for this branch — the caller receives ${status}${payload}data as JSON instead of any later handling.`;
    }
    if(response.method === 'text') {
        return `The ${contextLabel(context)} ends here for this branch — the caller receives ${status}${payload}content as plain text instead of any later handling.`;
    }
    return `The ${contextLabel(context)} ends here for this branch — the response body sent on this line is what the caller receives.`;
}

function loggerCallNote({call, trimmed, lines, lineNumber, context}) {
    const message = firstStringLiteral(trimmed);
    const response = nextResponseInfo(lines, lineNumber);
    const method = String(call?.method || '').toLowerCase();
    if(message && /invalid json/i.test(message)) {
        const suffix = response ? ` before returning ${responseDescription(response)}` : ' before the bad request exits';
        return `Records invalid JSON parse failures${suffix}.`;
    }
    const severity = method === 'warn' || method === 'error' || method === 'fatal'
        ? 'failure'
        : 'diagnostic';
    if(message) {
        return `Logs "${message}" as a ${severity} breadcrumb for this ${contextLabel(context)} branch.`;
    }
    return `Logs this ${contextLabel(context)} branch so failures can be diagnosed later.`;
}

function nextResponseInfo(lines, lineNumber) {
    for(let index = lineNumber; index < Math.min(lines.length, lineNumber + 4); index++) {
        const trimmed = String(lines[index] || '').trim();
        const call = callInfo(trimmed);
        const response = responseCallInfo(trimmed, call);
        if(response) {
            return response;
        }
    }
    return null;
}

function responseDescription(response) {
    const status = response.status ? `a ${response.status}` : 'an';
    const payload = response.payload ? ` ${response.payload}` : '';
    return `${status}${payload} response`;
}

function eventNameNear(lines, lineNumber) {
    for(let index = Math.max(0, lineNumber - 1); index < Math.min(lines.length, lineNumber + 5); index++) {
        const line = String(lines[index] || '').trim();
        const literal = line.match(/\bevent\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
        if(literal) {
            return literal;
        }
        if(/\bevent\s*:\s*event\.type\b/.test(line)) {
            return 'dynamic event';
        }
    }
    return '';
}

function responseCallInfo(trimmed, call) {
    if(!call || !['json', 'text', 'body'].includes(call.method)) {
        return null;
    }
    // A response send ends the handler — its value is neither captured nor
    // awaited. `payload = await res.json()` is client code parsing a fetch
    // Response, so assigned or awaited calls never count as sends.
    //
    if(/=\s*(?:await\s+)?[A-Za-z_$][\w$.]*\.(?:json|text|body)\s*\(/.test(trimmed) ||
        /\bawait\s+[A-Za-z_$][\w$.]*\.(?:json|text|body)\s*\(/.test(trimmed)) {
        return null;
    }
    const receiver = String(call.receiver || '').toLowerCase();
    if(receiver && !/(^|\.)(c|ctx|context|res|response|reply)$/.test(receiver)) {
        return null;
    }
    const status = trimmed.match(/,\s*(\d{3})\s*\)?;?$/)?.[1] || '';
    const payload = trimmed.match(/\berror\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] ||
        firstStringLiteral(trimmed);
    return {
        method: call.method,
        status,
        payload
    };
}

function isRequestJsonCall(call) {
    return call?.callee === 'request.json' ||
        call?.callee === 'req.json' ||
        call?.callee?.endsWith('.req.json') ||
        call?.callee?.endsWith('.request.json');
}

function isLoggerCall(call) {
    const receiver = String(call?.receiver || '').toLowerCase();
    return /(?:^|\.)(?:\w*log|logger)$/.test(receiver) &&
        /^(debug|info|warn|error|fatal|trace)$/.test(String(call?.method || '').toLowerCase());
}

function isStreamingCall(call, trimmed = '') {
    const label = `${call?.callee || ''} ${call?.method || ''} ${trimmed}`.toLowerCase();
    return /\b(stream|send|emit|publish|subscribe|event|message|write)\b/.test(label) ||
        /\bfor\s+await\b/.test(trimmed);
}

function isStreamSendCall(call) {
    return /(write|send|emit|publish|push)/i.test(String(call?.method || call?.callee || ''));
}

// DOM construction and event wiring are never cancellation, no matter what the
// identifiers on the line are named — a cancel *button* being created or
// clicked is UI work, not async teardown.
//
const DOM_WIRING_METHODS = new Set([
    'createelement', 'createtextnode', 'addeventlistener', 'removeeventlistener',
    'append', 'appendchild', 'prepend', 'insertbefore', 'removechild', 'replacechildren',
    'queryselector', 'queryselectorall', 'setattribute', 'classlist'
]);

function isCancellationCall(call, trimmed = '') {
    const method = String(call?.method || '').toLowerCase();
    if(DOM_WIRING_METHODS.has(method)) {
        return false;
    }
    // Cancellation is a property of the call itself (callee/method), never of
    // surrounding identifier names on the line.
    //
    const label = `${String(call?.callee || '')} ${method}`.toLowerCase();
    return /\b(onabort|abort|oncancel|cancel|timeout|disconnect|close)\b/.test(label) ||
        /\b(?:AbortController|throwIfAborted)\b/.test(trimmed);
}

function isPersistenceCall(call, trimmed = '') {
    const label = `${call?.callee || ''} ${call?.method || ''} ${trimmed}`.toLowerCase();
    return /\b(save|persist|insert|update|upsert|write|record|append|push|add)\b/.test(label);
}

function isValidationLine(trimmed = '') {
    return /\b(validate|invalid|required|missing|parse|schema|body|json)\b/i.test(trimmed);
}

function isLoggingLine(trimmed = '') {
    return /\b(?:\w*log|logger)\.(debug|info|warn|error|fatal|trace)\s*\(/i.test(trimmed);
}

function isDiskReadCall(call) {
    return ['readFile', 'pathExists', 'stat', 'readdir'].includes(call?.method) &&
        /^(fs|fsp|fsExtra)$/.test(String(call?.receiver || ''));
}

function isAbortCall(call) {
    return call?.method === 'abort' || call?.callee === 'throwIfAborted';
}

function javascriptAnchorScore(trimmed = '') {
    if(!trimmed) {
        return 0;
    }
    const call = callInfo(trimmed);
    let score = 0;
    if(/\b(setTimeout|clearTimeout|setInterval|addEventListener|removeEventListener|fetch|dispatchEvent)\b/.test(trimmed)) score += 45;
    if(/\b(getReader|TextDecoder|decode)\b|\.read\s*\(|\byield\b/i.test(trimmed)) score += 45;
    if(isStreamingCall(call, trimmed)) score += 45;
    if(isCancellationCall(call, trimmed) || /\bAbortController\b/.test(trimmed)) score += 40;
    if(isRequestJsonCall(call) || responseCallInfo(trimmed, call)) score += 35;
    if(domMutationInfo(trimmed)) score += 30;
    if(isLoggingLine(trimmed)) score -= 70;
    return score;
}

function assignmentInfo(trimmed) {
    const declaration = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?);?$/);
    if(declaration) {
        return {name: declaration[1], expression: declaration[2], kind: 'declaration'};
    }
    const assignment = trimmed.match(/^((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=\s*(.+?);?$/);
    if(assignment) {
        return {name: assignment[1], expression: assignment[2], kind: 'assignment'};
    }
    return null;
}

function domMutationInfo(trimmed) {
    const assignment = String(trimmed || '').trim().match(/^((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=\s*(.+?);?$/);
    if(!assignment) {
        return null;
    }
    const target = assignment[1];
    const parts = target.split('.');
    const property = parts.at(-1);
    if(!DOM_MUTATION_PROPERTIES.has(property)) {
        return null;
    }
    const expression = assignment[2].trim().replace(/;$/, '');
    return {
        target,
        owner: parts.slice(0, -1).join('.') || target,
        property,
        expression,
        clears: isDomClearValue(property, expression)
    };
}

function isDomClearValue(property, expression) {
    const value = String(expression || '').trim();
    if(['innerHTML', 'textContent', 'className', 'value'].includes(property)) {
        return value === "''" || value === '""' || value === '``';
    }
    if(property === 'hidden' || property === 'disabled' || property === 'checked') {
        return value === 'false';
    }
    return false;
}

function readableDomTarget(target) {
    const raw = String(target || '').split('.').findLast(Boolean) || 'this UI region';
    const text = raw
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim()
        .toLowerCase();
    if(!text) {
        return 'this UI region';
    }
    if(/\b(rail|outlet|container|panel|element|node|view|section|button|input|form)\b/.test(text)) {
        return `the ${text}`;
    }
    return text === 'this ui region' ? text : `the ${text} UI region`;
}

function isLikelyUiTarget(target, context = {}) {
    const value = String(target || '');
    const contextText = [context.caption, context.intent, context.question, context.path]
        .filter(Boolean)
        .join(' ');
    return /\b(rail|outlet|container|panel|element|node|view|section|button|input|form|dom|component|render)\b/i.test(`${value} ${contextText}`);
}

function callInfo(trimmed) {
    const source = String(trimmed || '')
        .replace(/^(?:return|await)\s+/, '')
        .replace(/^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*/, '')
        .replace(/^((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=\s*/, '');
    const match = source.match(/\b((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/);
    if(!match) {
        return null;
    }
    const callee = match[1];
    const parts = callee.split('.');
    const method = parts.at(-1);
    if(CALL_KEYWORDS.has(method)) {
        return null;
    }
    return {
        callee,
        method,
        receiver: parts.length > 1 ? parts.slice(0, -1).join('.') : ''
    };
}

function importInfo(trimmed) {
    const from = trimmed.match(/^import\s+(.+?)\s+from\s+['"`]([^'"`]+)['"`]/);
    if(from) {
        return {name: cleanImportName(from[1]), target: from[2]};
    }
    const sideEffect = trimmed.match(/^import\s+['"`]([^'"`]+)['"`]/);
    if(sideEffect) {
        return {name: '', target: sideEffect[1]};
    }
    const required = trimmed.match(/\brequire\(\s*['"`]([^'"`]+)['"`]\s*\)/);
    if(required) {
        return {name: '', target: required[1]};
    }
    return null;
}

function cleanImportName(value) {
    return String(value || '')
        .replace(/[{}*]/g, '')
        .replace(/\bas\b\s+\w+/g, '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(', ');
}

function routeInfo(trimmed) {
    const direct = trimmed.match(/\b(?:app|router|route|server|api)\s*\.\s*(get|post|put|patch|delete|use|all)\s*\(\s*['"`]([^'"`]+)['"`]/i);
    if(direct) {
        return {method: direct[1].toUpperCase(), path: direct[2]};
    }
    const decorator = trimmed.match(/@\s*(Get|Post|Put|Patch|Delete|Route|Controller)\s*\(\s*['"`]?([^'"`)]*)['"`]?/);
    if(decorator) {
        return {method: decorator[1].toUpperCase(), path: decorator[2] || '/'};
    }
    return null;
}

// Control-flow keywords look like method definitions to the bare
// `name(...) {` pattern (`for (const x of xs) {`); they never name a symbol.
//
const SYMBOL_NAME_KEYWORDS = new Set([
    'for', 'if', 'while', 'switch', 'catch', 'return', 'do', 'else', 'try',
    'function', 'await', 'yield', 'typeof', 'new', 'case', 'with'
]);

function symbolInfo(trimmed) {
    const patterns = [
        {kind: 'function', re: /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/},
        {kind: 'class', re: /\bclass\s+([A-Za-z_$][\w$]*)/},
        {kind: 'type', re: /\b(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/},
        {kind: 'method', re: /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/},
        {kind: 'function', re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/}
    ];
    for(const {kind, re} of patterns) {
        const match = trimmed.match(re);
        if(match && !SYMBOL_NAME_KEYWORDS.has(match[1].toLowerCase())) {
            return {kind, name: match[1]};
        }
    }
    return null;
}

function storageFact(trimmed) {
    const method = trimmed.match(/\.(connect|delete|add|query|where|limit|select|toArray|insert|update|findMany|findOne|save|create|upsert)\s*\(/)?.[1];
    if(method) {
        return `storage call: .${method}()`;
    }
    if(/\b(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(trimmed)) {
        return 'storage statement: SQL';
    }
    return '';
}

function noteForStorageFact(fact, context = {}) {
    const value = String(fact || '').replace(/^storage (?:call|statement):\s*/, '');
    return `Uses ${value} as part of the storage or retrieval operation for this ${contextLabel(context)} path.`;
}

function callLabel(call) {
    if(!call) {
        return 'the called function';
    }
    return call.receiver ? `${call.receiver}.${call.method}` : call.method;
}

function firstStringLiteral(value) {
    return String(value || '').match(/['"`]([^'"`]+)['"`]/)?.[1] || '';
}

function semanticKeyForLine(source) {
    const domMutation = domMutationInfo(source);
    if(domMutation?.clears) {
        return `dom-clear:${domMutation.property}`;
    }
    // One cancellation lesson and one "opens a streaming boundary" lesson per
    // excerpt: abort + onAbort wiring (or two boundary opens) teach the same
    // thing, and the repeated template phrasing reads as filler. Event-send
    // lines keep distinct notes (they name different events), so only the
    // generic boundary shape gets the family key.
    //
    const call = callInfo(source);
    if(call && isCancellationCall(call, source)) {
        return 'cancellation-wiring';
    }
    if(call && isStreamingCall(call, source) && !isStreamSendCall(call) && /\b(return|await)\b/.test(source) && /stream/i.test(callLabel(call))) {
        return 'stream-boundary';
    }
    return '';
}

function nearestEnclosingContext(lines, lineNumber, context = {}) {
    for(let i = lineNumber - 1; i >= 0; i--) {
        const trimmed = String(lines[i] || '').trim();
        const route = routeInfo(trimmed);
        if(route) {
            return {kind: 'route', name: `${route.method} ${route.path}`};
        }
        const symbol = symbolInfo(trimmed);
        if(symbol) {
            return symbol;
        }
        const selector = isStyleContext(context)
            ? trimmed.match(/^([^@{}][^{]+)\{\s*$/)?.[1]?.trim()
            : '';
        if(selector) {
            return {kind: 'style rule', name: selector};
        }
    }
    return null;
}

function includeLeadingComments(lines, symbolIndex) {
    let start = symbolIndex;
    for(let index = symbolIndex - 1; index >= Math.max(0, symbolIndex - 4); index--) {
        const trimmed = String(lines[index] || '').trim();
        if(trimmed === '' || /^\/\//.test(trimmed) || /^\/?\*/.test(trimmed)) {
            start = index;
            continue;
        }
        break;
    }
    return start;
}

function symbolEndByStructure(lines, symbolIndex) {
    return symbolEndByBalancedBraces(lines, symbolIndex)
        ?? nextSymbolStart(lines, symbolIndex + 1);
}

function symbolEndByBalancedBraces(lines, symbolIndex) {
    const opening = findSymbolBodyOpening(lines, symbolIndex);
    if(!opening) {
        return null;
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
    return null;
}

function findSymbolBodyOpening(lines, symbolIndex) {
    let parenDepth = 0;
    for(let index = symbolIndex; index < Math.min(lines.length, symbolIndex + 16); index++) {
        const line = stripQuotedSource(String(lines[index] || ''));
        for(let column = 0; column < line.length; column++) {
            const ch = line[column];
            if(ch === '(' || ch === '[') {
                parenDepth++;
            } else if(ch === ')' || ch === ']') {
                parenDepth = Math.max(0, parenDepth - 1);
            } else if(ch === '{' && parenDepth === 0) {
                return {line: index, column};
            }
        }
        if(index > symbolIndex && parenDepth === 0 && symbolInfo(String(lines[index] || '').trim())) {
            return null;
        }
    }
    return null;
}

function nextSymbolStart(lines, startIndex) {
    for(let index = startIndex; index < lines.length; index++) {
        if(symbolInfo(String(lines[index] || '').trim())) {
            return index;
        }
    }
    return lines.length;
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
        if(ch === '"' || ch === '\'' || ch === '`') {
            quote = ch;
            out += ' ';
            continue;
        }
        out += ch;
    }
    return out;
}

function isStyleContext(context = {}) {
    const language = String(context.language || '').toLowerCase();
    const path = String(context.path || '').toLowerCase().split(/[?#]/)[0];
    return language === 'css' || /\.css$/.test(path);
}

function contextLabel(context = {}) {
    const text = [context.caption, context.intent]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    if(/\b(ui|dom|browser|screen|view|render|rendering)\b/.test(text)) return 'UI';
    if(/\b(style|css|appearance|layout|visual)\b/.test(text)) return 'rendering';
    if(/\b(route|api|request|response|stream)\b/.test(text)) return 'request';
    if(/\b(index|embedding|search|retrieval|vector)\b/.test(text)) return 'retrieval';
    if(/\b(error|exception|rejection|fallback)\b/.test(text)) return 'error-handling';
    return 'component';
}

const CALL_KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'await'
]);

const DOM_MUTATION_PROPERTIES = new Set([
    'innerHTML', 'textContent', 'className', 'hidden', 'disabled', 'checked', 'value'
]);

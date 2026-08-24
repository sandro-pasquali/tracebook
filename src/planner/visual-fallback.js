import {EOL} from 'node:os';

// Helpers for validating and retrying model-written visual components before
// they become final trace data.
//

// Header rules and parser-safety rules shared by the generation-time retry
// prompt and the client-triggered repair prompt, so both teach the model the
// same constraints.
//
const MERMAID_HEADER_RULE_SEQUENCE = '- mermaid must begin exactly with `sequenceDiagram`.';
const MERMAID_HEADER_RULE_GENERAL = '- mermaid must begin with `sequenceDiagram`, `flowchart TD`, `stateDiagram-v2`, `timeline`, `classDiagram`, or `mindmap`.';
const MERMAID_SAFETY_RULES = [
    '- Keep labels short and parser-safe.',
    '- Node labels must stay on one line; never wrap a label onto a new line unless the whole label is quoted.',
    '- Represent code operations such as yield, return, and await as messages or Notes, never as standalone source-code lines.',
    '- Every Mermaid block opened with `alt`, `opt`, `loop`, `par`, `critical`, `break`, `rect`, `box`, or `subgraph` must be closed with a matching `end`.',
    '- Do not use `else`, `and`, or `option` unless the corresponding Mermaid block is currently open.',
    '- Do not return an empty string, markdown fence without content, prose, or a placeholder.'
];

export function buildVisualRetryInstructions({planItem, reason, failedPartial}) {
    const lines = [
        '## Required retry',
        `The previous ${planItem.kind} output failed because: ${reason}.`,
        'Generate the same component again, but this time the Mermaid source is mandatory.',
        'Output only the JSON object for this component body.',
        '- mermaid must be a non-empty string.',
        planItem.kind === 'sequence_diagram' ? MERMAID_HEADER_RULE_SEQUENCE : MERMAID_HEADER_RULE_GENERAL,
        ...MERMAID_SAFETY_RULES
    ];
    if(failedPartial && typeof failedPartial === 'object') {
        lines.push('');
        lines.push('Previous invalid partial, for debugging only:');
        lines.push(JSON.stringify(failedPartial).slice(0, 1200));
    }
    return lines.join(EOL);
}

// Standalone "fix this Mermaid" prompt for the client-triggered repair endpoint.
// Unlike buildVisualRetryInstructions it has no planItem/outline context — it
// works purely from the broken source and the browser parser's error text.
//
export function buildMermaidRepairSystemPrompt() {
    return [
        'You repair broken Mermaid diagram source so it parses cleanly.',
        'Preserve the original diagram type, structure, and meaning; change only what is needed to make it valid.',
        'Return only the corrected Mermaid source in the `mermaid` field — no prose, no markdown fences.'
    ].join(EOL);
}

export function buildMermaidRepairPrompt({source, diagramType, error} = {}) {
    const lines = ['## Repair this Mermaid diagram'];
    if(diagramType) {
        lines.push(`Diagram type: ${diagramType}.`);
    }
    if(error) {
        lines.push(`The browser Mermaid parser rejected it with: ${String(error).slice(0, 500)}`);
    }
    lines.push('Rewrite it so it parses, keeping the same intent. Follow these rules:');
    lines.push(MERMAID_HEADER_RULE_GENERAL);
    for(const rule of MERMAID_SAFETY_RULES) {
        lines.push(rule);
    }
    lines.push('');
    lines.push('Broken Mermaid source:');
    lines.push(String(source || ''));
    return lines.join(EOL);
}

export function firstMermaidLine(value) {
    return String(value || '').split(/\r?\n/).find((line) => line.trim())?.trim() || '';
}

// Structural pre-flight for model-written Mermaid before it ships to the
// client. Schema validation only proves `mermaid` is a string; a truncated or
// malformed diagram then renders as "Figure unavailable". The checks here are
// deliberately conservative — Mermaid's grammar is wide and the client parser
// stays the final authority — but they catch dominant failure classes: output
// cut off inside a block (`alt` with no `end`) and executable source copied as
// a standalone sequence statement. Returns '' when the source looks plausible,
// otherwise a short reason for the retry prompt.
//
const MERMAID_HEADERS = /^(sequenceDiagram|flowchart\b|graph\b|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|timeline|mindmap|gantt|pie\b)/;
const MERMAID_BLOCK_OPENERS = /^(alt|opt|loop|par|critical|break|rect|box|subgraph)\b/;
const STANDALONE_SEQUENCE_CODE = /^(?:(?:yield|return|await|throw|const|let|var|function|class|import|export)\b|(?:if|for|while|switch|try|catch)\s*[({]|[A-Za-z_$][\w$.[\]]*\s*(?:=|\+=|-=|\*=|\/=))/;
const FLOWCHART_HEADERS = /^(flowchart|graph)\b/;
const DELIMITER_PAIRS = [['[', ']'], ['(', ')'], ['{', '}']];

// Node/edge delimiters are structural in flowchart-family diagrams, so a line
// holding more openers than closers means the output was cut off inside a
// node definition or a label wrapped unquoted onto the next line — both
// unparseable. Only the opener-heavy direction is flagged: the asymmetric
// `G>label]` node shape makes extra closers legal. Quoted strings and
// edge-label pipes are stripped first — their text may contain any character.
//
function unclosedDelimiterIssue(line) {
    const structural = line
        .replace(/"[^"]*"/g, '""')
        .replace(/\|[^|]*\|/g, '||');
    for(const [opener, closer] of DELIMITER_PAIRS) {
        const opens = structural.split(opener).length - 1;
        const closes = structural.split(closer).length - 1;
        if(opens > closes) {
            return `unclosed "${opener}" in "${line.slice(0, 60)}" — node truncated or label spans lines`;
        }
    }
    return '';
}

export function lintMermaidSource(source) {
    const lines = String(source || '').split(/\r?\n/).map((line) => line.trim());
    const header = lines.find(Boolean);
    if(!header) {
        return 'mermaid source is empty';
    }
    if(!MERMAID_HEADERS.test(header)) {
        return `first line "${header.slice(0, 60)}" is not a known diagram header`;
    }
    const sequenceDiagram = /^sequenceDiagram\b/.test(header);
    const flowchartDiagram = FLOWCHART_HEADERS.test(header);
    let depth = 0;
    for(const line of lines) {
        if(line.startsWith('%%')) {
            continue;
        }
        if(MERMAID_BLOCK_OPENERS.test(line)) {
            depth++;
            continue;
        }
        if(line === 'end') {
            depth--;
            if(depth < 0) {
                return '"end" without a matching block opener';
            }
            continue;
        }
        if(/^(else|and|option)\b/.test(line) && depth === 0) {
            return `"${line.split(/\s/)[0]}" outside of any block`;
        }
        if(sequenceDiagram && STANDALONE_SEQUENCE_CODE.test(line)) {
            return `standalone code statement "${line.slice(0, 60)}" must be represented as a Mermaid message or Note`;
        }
        if(flowchartDiagram) {
            const issue = unclosedDelimiterIssue(line);
            if(issue) {
                return issue;
            }
        }
    }
    if(depth > 0) {
        return `${depth} unclosed block${depth === 1 ? '' : 's'} — output likely truncated before "end"`;
    }
    return '';
}

// Conservative auto-repair run BEFORE lintMermaidSource on model output. It
// heals the one mechanically-safe failure class — a stray `end` (a block closer
// with no open block) — by dropping it, mirroring the depth counter the lint
// uses to detect it. It only ever removes an `end` the lint would have flagged,
// so it can turn a fail-closed into a clean figure but never the reverse;
// anything it does not fix still routes through the model retry. The source is
// returned untouched (original newlines preserved) when there is nothing to fix.
//
export function healMermaidSource(source) {
    const text = String(source || '');
    if(!text.trim()) {
        return text;
    }
    const kept = [];
    let depth = 0;
    let changed = false;
    for(const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if(trimmed.startsWith('%%')) {
            kept.push(line);
            continue;
        }
        if(MERMAID_BLOCK_OPENERS.test(trimmed)) {
            depth++;
            kept.push(line);
            continue;
        }
        if(trimmed === 'end') {
            if(depth > 0) {
                depth--;
                kept.push(line);
            } else {
                changed = true;
            }
            continue;
        }
        kept.push(line);
    }
    return changed ? kept.join('\n') : text;
}

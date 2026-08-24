// Map from server-emitted component type → DOM tag name.
// Unknown types fall back to <tool-unsupported>.
//

const map = new Map([
    ['annotated_code_excerpt', 'tool-annotated-code-excerpt'],
    ['mermaid_figure', 'tool-sequence-diagram'],
    ['sequence_diagram', 'tool-sequence-diagram'],
    ['evidence_callout', 'tool-evidence-callout']
]);

export function tagNameFor(type) {
    return map.get(type) || 'tool-unsupported';
}

export function isKnownType(type) {
    return map.has(type);
}

export function knownTypes() {
    return [...map.keys()];
}

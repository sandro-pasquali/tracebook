// Pure helpers over tree-sitter nodes, shared by the language integrations
// (common.js) and the source-syntax analyzer. Kept dependency-free so both
// sides can import it without a cycle (source-syntax -> registry -> common).
//

// Convert a node's 0-based start/end rows into 1-based, clamped line numbers.
// A node ending at column 0 spills onto the next row, so trim that trailing row.
//
export function nodeLineRange(node, lineCount) {
    const start = node.startPosition?.row ?? 0;
    const rawEnd = node.endPosition?.row ?? start;
    const end = (node.endPosition?.column === 0 && rawEnd > start) ? rawEnd - 1 : rawEnd;
    const lineStart = Math.max(1, Math.min(lineCount, start + 1));
    const lineEnd = Math.max(lineStart, Math.min(lineCount, end + 1));
    return {lineStart, lineEnd};
}

export function isCommentNode(node) {
    return node?.type === 'comment' || node?.type === 'line_comment' || node?.type === 'block_comment';
}

export function isErrorNode(node) {
    return node?.type === 'ERROR' || node?.isMissing?.();
}

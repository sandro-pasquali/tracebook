import test from 'node:test';
import assert from 'node:assert/strict';
import {fixMermaidRequestSchema} from '../../src/server/contracts.js';

test('fixMermaidRequestSchema accepts a minimal repair request', () => {
    const parsed = fixMermaidRequestSchema.safeParse({mermaid: 'sequenceDiagram\n    A->>B: hi'});
    assert.equal(parsed.success, true);
});

test('fixMermaidRequestSchema accepts optional diagramType and error', () => {
    const parsed = fixMermaidRequestSchema.safeParse({
        mermaid: 'flowchart TD\n    A --> B',
        diagramType: 'flowchart',
        error: 'Parse error on line 2'
    });
    assert.equal(parsed.success, true);
});

test('fixMermaidRequestSchema rejects an empty mermaid string', () => {
    const parsed = fixMermaidRequestSchema.safeParse({mermaid: ''});
    assert.equal(parsed.success, false);
});

test('fixMermaidRequestSchema rejects unknown keys', () => {
    const parsed = fixMermaidRequestSchema.safeParse({mermaid: 'sequenceDiagram', extra: true});
    assert.equal(parsed.success, false);
});

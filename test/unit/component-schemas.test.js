import test from 'node:test';
import assert from 'node:assert/strict';
import {componentSchemaByKind} from '../../src/registry/schemas.js';

test('sequence diagram schema rejects empty or non-sequence Mermaid', () => {
    const base = {
        id: 'runtime-sequence',
        sourceRefs: [],
        confidence: 0.8,
        reason: null,
        caption: 'Runtime flow'
    };

    assert.equal(componentSchemaByKind.sequence_diagram.safeParse({
        ...base,
        mermaid: ''
    }).success, false);
    assert.equal(componentSchemaByKind.sequence_diagram.safeParse({
        ...base,
        mermaid: 'flowchart TD\nA --> B'
    }).success, false);
    assert.equal(componentSchemaByKind.sequence_diagram.safeParse({
        ...base,
        mermaid: 'sequenceDiagram\nUser->>UI: Ask\nUI-->>User: Render'
    }).success, true);
});

test('mermaid figure schema requires a supported Mermaid declaration', () => {
    const base = {
        id: 'implementation-flow',
        sourceRefs: [],
        confidence: 0.8,
        reason: null,
        caption: 'Implementation flow',
        diagramType: 'flowchart'
    };

    assert.equal(componentSchemaByKind.mermaid_figure.safeParse({
        ...base,
        mermaid: '   '
    }).success, false);
    assert.equal(componentSchemaByKind.mermaid_figure.safeParse({
        ...base,
        mermaid: 'not mermaid'
    }).success, false);
    assert.equal(componentSchemaByKind.mermaid_figure.safeParse({
        ...base,
        mermaid: 'flowchart TD\nA --> B'
    }).success, true);
});

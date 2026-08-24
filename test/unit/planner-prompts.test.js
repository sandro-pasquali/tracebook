import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildComponentInstructions,
    buildComponentRetryInstructions,
    buildComponentSystemPrompt
} from '../../src/planner/prompts.js';

test('annotated component prompt states the exact body schema and rejects common aliases', () => {
    const planItem = {
        id: 'route-handler',
        kind: 'annotated_code_excerpt',
        intent: 'Show the route handler.',
        sourceRefHint: []
    };
    const system = buildComponentSystemPrompt(planItem);
    const instructions = buildComponentInstructions({planItem, outline: {title: 'Route flow', narrative: []}});

    assert.match(system, /component BODY only/v);
    assert.match(system, /Do not emit a `type` field/v);
    assert.match(system, /`id`, `sourceRefs`, `confidence`, `reason`/v);
    assert.match(system, /`caption`, `language`, `code`, `callouts`/v);
    assert.match(system, /exactly `line` and `note`/v);
    assert.match(system, /never `source_ref`/v);
    assert.match(system, /`extracted_content`/v);
    assert.match(instructions, /supplied AnnotatedCodeExcerpt schema/v);
    assert.doesNotMatch(instructions, /TraceComponent schema/v);
});

test('visual component prompts enumerate their exact kind-specific fields', () => {
    const mermaid = buildComponentSystemPrompt({kind: 'mermaid_figure'});
    const sequence = buildComponentSystemPrompt({kind: 'sequence_diagram'});

    assert.match(mermaid, /`diagramType`, `mermaid`, `caption`/v);
    assert.match(sequence, /exactly: `mermaid`, `caption`/v);
    assert.doesNotMatch(sequence, /`diagramType`/v);
});

test('component retry prompt carries the rejection reason without changing the schema contract', () => {
    const prompt = buildComponentRetryInstructions({
        planItem: {id: 'route-handler', kind: 'annotated_code_excerpt'},
        reason: 'response did not match schema',
        failedPartial: {source_ref: 'src/server.js:1-10'}
    });

    assert.match(prompt, /response did not match schema/v);
    assert.match(prompt, /id "route-handler"/v);
    assert.match(prompt, /one JSON object/v);
    assert.match(prompt, /"source_ref"/v);
});

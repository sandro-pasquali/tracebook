import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildFeatureTrace,
    simulateFeatureTrace,
    verifyFeatureTrace,
} from '../../src/feature-trace.js';

test('buildFeatureTrace derives evidence and entrypoints from components', () => {
    const featureTrace = buildFeatureTrace({
        question: 'How does the checkout API work?',
        traceId: 'trc_test_123456',
        createdAt: 1000,
        trace: {
            title: 'Checkout API flow',
            narrative: ['The client posts to the checkout route.'],
            components: [{
                type: 'annotated_code_excerpt',
                id: 'route',
                caption: 'Checkout route',
                confidence: 0.8,
                sourceRefs: [{path: 'src/routes/checkout.js', lineStart: 10, lineEnd: 20}],
            }],
        },
    });

    assert.equal(featureTrace.behavior, 'Checkout API flow');
    assert.deepEqual(featureTrace.actors.toSorted(), ['server', 'user/client']);
    assert.equal(featureTrace.entrypoints[0].path, 'src/routes/checkout.js');
    assert.equal(featureTrace.confidence, 0.8);
});

test('simulate and verify feature traces produce source-backed prompts', () => {
    const featureTrace = buildFeatureTrace({
        question: 'How does checkout work?',
        trace: {
            title: 'Checkout',
            narrative: ['Inventory is checked before payment.'],
            components: [{
                type: 'evidence_callout',
                id: 'inventory',
                summary: 'Inventory check',
                confidence: 0.7,
                sourceRefs: [{path: 'src/services/inventory.js', lineStart: 1, lineEnd: 8}],
            }],
        },
    });

    const simulation = simulateFeatureTrace({featureTrace, condition: 'inventory unavailable'});
    const verification = verifyFeatureTrace({featureTrace});

    assert.equal(simulation.type, 'simulation');
    assert.ok(simulation.evidence.length > 0);
    assert.equal(verification.type, 'verification');
    assert.equal(verification.questions.length, 3);
});

test('an admitted gap caps confidence and stays out of entrypoints and alternate paths', () => {
    const featureTrace = buildFeatureTrace({
        question: 'Are there apis that handle story deletion?',
        trace: {
            title: 'Story Deletion APIs',
            narrative: ['The app exposes a deletion endpoint.'],
            components: [
                {
                    type: 'evidence_callout',
                    id: 'gap-endpoint',
                    kind: 'gap',
                    confidence: 0.8,
                    summary: 'Deletion endpoint not located',
                    detail: 'The endpoint definition was not retrieved.',
                    sourceRefs: [{path: 'src/planner/keywords.js', lineStart: 354, lineEnd: 395}],
                },
                {
                    type: 'annotated_code_excerpt',
                    id: 'ui-delete',
                    confidence: 1,
                    caption: 'UI delete handling',
                    sourceRefs: [{path: 'public/js/panel.js', lineStart: 214, lineEnd: 241}],
                },
                {
                    type: 'mermaid_figure',
                    id: 'flow',
                    confidence: 1,
                    caption: 'Deletion flow',
                    sourceRefs: [{path: 'public/js/panel.js', lineStart: 214, lineEnd: 241}],
                },
            ],
        },
    });

    assert.ok(featureTrace.confidence <= 0.6, `confidence ${featureTrace.confidence} should be capped by the gap`);
    assert.ok(!featureTrace.entrypoints.some((e) => e.path === 'src/planner/keywords.js'));
    assert.equal(featureTrace.entrypoints.filter((e) => e.path === 'public/js/panel.js').length, 1);
    assert.deepEqual(featureTrace.alternatePaths, []);
    assert.equal(featureTrace.openQuestions[0], 'Deletion endpoint not located');
});

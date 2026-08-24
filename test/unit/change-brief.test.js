import test from 'node:test';
import assert from 'node:assert/strict';
import {generateChangeBrief} from '../../src/change-brief/generator.js';
import {renderAgentPrompt} from '../../src/change-brief/render.js';

test('generateChangeBrief reconciles model output to source evidence and renders an agent prompt', async () => {
    const savedTrace = {
        traceId: 'trc_checkout_123abc',
        question: 'How does checkout work?',
        sourceRevision: 'rev-1',
        trace: {
            title: 'Checkout flow',
            narrative: ['The checkout route validates the cart before payment.'],
            components: [{
                type: 'evidence_callout',
                id: 'route',
                summary: 'Checkout route',
                confidence: 0.9,
                sourceRefs: [{path: 'src/routes/checkout.js', lineStart: 10, lineEnd: 30}]
            }]
        },
        featureTrace: {
            summary: 'Checkout flow',
            entrypoints: [{path: 'src/routes/checkout.js', lineStart: 10, lineEnd: 30, role: 'request handling'}],
            evidence: [{path: 'src/routes/checkout.js', lineStart: 10, lineEnd: 30, claim: 'Checkout route'}],
            changeRisks: ['Changing src/routes/checkout.js lines 10-30 may affect request handling behavior.'],
            openQuestions: ['Which alternate failure paths should be traced before modifying this behavior?']
        }
    };
    const draft = {
        title: 'Add checkout refund request',
        productGoal: 'Let customers request a refund from the checkout area without issuing money automatically.',
        currentBehavior: 'Checkout currently validates the cart before payment.',
        likelyFiles: [
            {
                path: 'src/routes/checkout.js',
                role: 'source',
                reason: 'This route is the source-backed checkout entrypoint.',
                confidence: 'high',
                sourceRefs: [
                    {path: 'src/routes/checkout.js', lineStart: 1, lineEnd: 999},
                    {path: 'src/not-real.js', lineStart: 1, lineEnd: 2}
                ]
            },
            {
                path: 'src/not-real.js',
                role: 'service',
                reason: 'Invented by the model and should be dropped.',
                confidence: 'high'
            }
        ],
        existingPatterns: [{
            text: 'Use the existing route boundary.',
            sourceRefs: [{path: 'src/not-real.js', lineStart: 1, lineEnd: 2}]
        }],
        implementationConstraints: [{
            text: 'Do not issue refunds automatically.',
            sourceRefs: [{path: 'src/routes/checkout.js', lineStart: 1, lineEnd: 999}]
        }],
        acceptanceCriteria: ['Customers can submit a refund request.'],
        testPlan: [{
            text: 'Add route coverage for validation.',
            sourceRefs: [{path: 'test/routes/checkout.test.js', lineStart: 500, lineEnd: 600}]
        }],
        openQuestions: ['Should refund requests create support tickets?'],
        riskNotes: [{
            text: 'Checkout behavior is request-facing.',
            sourceRefs: [{path: '../outside.js', lineStart: 1, lineEnd: 2}]
        }]
    };
    const brief = await generateChangeBrief({
        savedTrace,
        changeIntent: 'Add a refund request action after checkout.',
        outputFormat: 'llm_prompt',
        sourceRevision: 'rev-1',
        model: {},
        generate: async ({prompt}) => {
            assert.match(prompt, /Requested change/v);
            assert.match(prompt, /src\/routes\/checkout\.js/v);
            return {object: draft, usage: {totalTokens: 42}};
        },
        tools: {
            search_codebase: {
                async execute() {
                    return {
                        results: [{
                            path: 'test/routes/checkout.test.js',
                            lineStart: 1,
                            lineEnd: 20,
                            similarity: 0.7,
                            content: '1  import test from "node:test";'
                        }]
                    };
                }
            }
        },
        now: () => 1000
    });

    assert.equal(brief.freshness, 'current');
    assert.equal(brief.likelyFiles.some((file) => file.path === 'src/not-real.js'), false);
    const checkoutFile = brief.likelyFiles.find((file) => file.path === 'src/routes/checkout.js');
    assert.equal(checkoutFile?.role, 'route');
    assert.deepEqual(checkoutFile?.sourceRefs, [{path: 'src/routes/checkout.js', lineStart: 10, lineEnd: 30}]);
    assert.ok(brief.likelyFiles.some((file) => file.path === 'test/routes/checkout.test.js'));
    const allowedRanges = new Map([
        ['src/routes/checkout.js', [10, 30]],
        ['test/routes/checkout.test.js', [1, 20]]
    ]);
    for(const section of [brief.existingPatterns, brief.implementationConstraints, brief.testPlan, brief.riskNotes]) {
        for(const item of section) {
            for(const ref of item.sourceRefs) {
                assert.ok(allowedRanges.has(ref.path), `unexpected sourceRef ${ref.path}`);
                const [lineStart, lineEnd] = allowedRanges.get(ref.path);
                assert.ok(ref.lineStart >= lineStart && ref.lineEnd <= lineEnd, `sourceRef escaped evidence range: ${JSON.stringify(ref)}`);
            }
        }
    }
    assert.match(brief.agentPrompt, /Relevant files to inspect first/v);
    assert.match(brief.agentPrompt, /src\/routes\/checkout\.js/v);
});

test('renderAgentPrompt omits generic source roles from file labels', () => {
    const text = renderAgentPrompt({
        title: 'Update fallback behavior',
        productGoal: 'Make the fallback clearer.',
        currentBehavior: 'Fallback behavior is implemented in a source file.',
        likelyFiles: [{path: 'src/misc.js', role: 'source', confidence: 'medium', reason: 'Contains the fallback behavior.'}],
        acceptanceCriteria: ['The fallback is clearer.'],
        existingPatterns: [],
        implementationConstraints: [],
        testPlan: [],
        riskNotes: [],
        openQuestions: []
    }, {outputFormat: 'llm_prompt'});

    assert.doesNotMatch(text, /\(source,/v);
    assert.match(text, /src\/misc\.js \(medium confidence\): Contains the fallback behavior\./v);
});

test('renderAgentPrompt supports repository issue-style output', () => {
    const text = renderAgentPrompt({
        title: 'Add export action',
        productGoal: 'Let users export a trace.',
        currentBehavior: 'Traces are currently shown in the browser.',
        likelyFiles: [{path: 'public/js/app.js', role: 'ui', confidence: 'high', reason: 'Main app entrypoint.'}],
        acceptanceCriteria: ['A completed trace can be exported.'],
        existingPatterns: [],
        implementationConstraints: [],
        testPlan: [],
        riskNotes: [],
        openQuestions: []
    }, {outputFormat: 'repository_issue'});

    assert.match(text, /^# Add export action/v);
    assert.match(text, /## Acceptance Criteria/v);
    assert.match(text, /`public\/js\/app\.js`/v);
});

test('renderAgentPrompt supports ticket-style output', () => {
    const text = renderAgentPrompt({
        title: 'Add export action',
        productGoal: 'Let users export a trace.',
        currentBehavior: 'Traces are currently shown in the browser.',
        likelyFiles: [{path: 'public/js/app.js', role: 'ui', confidence: 'high', reason: 'Main app entrypoint.'}],
        acceptanceCriteria: ['A completed trace can be exported.'],
        existingPatterns: [],
        implementationConstraints: [],
        testPlan: [],
        riskNotes: [],
        openQuestions: []
    }, {outputFormat: 'ticket'});

    assert.match(text, /^Title: Add export action/v);
    assert.match(text, /Type: Change request/v);
    assert.match(text, /Acceptance criteria/v);
});

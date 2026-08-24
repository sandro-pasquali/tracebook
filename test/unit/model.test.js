import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assertDirectAnswerCompatibleModel,
    directAnswerProviderOptions,
    modelIdOnly,
    parseModelSpec,
    resolveModel
} from '../../src/util/model.js';

test('resolveModel supports configured direct AI SDK providers', () => {
    const cases = [
        ['openai/gpt-4o-mini', 'openai.responses', 'gpt-4o-mini'],
        ['anthropic/claude-3-5-sonnet-20241022', 'anthropic.messages', 'claude-3-5-sonnet-20241022'],
        ['google/gemini-1.5-pro', 'google.generative-ai', 'gemini-1.5-pro'],
        ['mistral/mistral-large-latest', 'mistral.chat', 'mistral-large-latest']
    ];

    for(const [spec, provider, modelId] of cases) {
        const model = resolveModel(spec);
        assert.equal(model.provider, provider);
        assert.equal(model.modelId, modelId);
    }
});

test('parseModelSpec validates provider/model ids', () => {
    assert.deepEqual(parseModelSpec('Anthropic/claude-3-5-sonnet-20241022'), {
        provider: 'anthropic',
        modelId: 'claude-3-5-sonnet-20241022'
    });
    assert.equal(modelIdOnly('mistral/codestral-latest'), 'codestral-latest');
    assert.throws(() => parseModelSpec('antrhopic/claude'), /Supported providers: openai, anthropic, google, mistral/v);
    assert.throws(() => parseModelSpec('gpt-4o-mini'), /expected "<provider>\/<modelid>"/v);
});

test('resolveModel permanently disables Ollama thinking', () => {
    const model = resolveModel('ollama/direct-answer-model');
    assert.equal(model.settings.think, false);
});

test('direct-answer provider policy cannot be overridden by call options', () => {
    assert.deepEqual(directAnswerProviderOptions({
        provider: 'openai',
        modelId: 'gpt-5.1-mini',
        providerOptions: {openai: {reasoningEffort: 'high', reasoningSummary: 'detailed', forceReasoning: true}}
    }).openai, {reasoningEffort: 'none'});

    assert.deepEqual(directAnswerProviderOptions({
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        providerOptions: {anthropic: {thinking: {type: 'adaptive'}, effort: 'high', sendReasoning: true}}
    }).anthropic, {sendReasoning: false, thinking: {type: 'disabled'}});

    assert.deepEqual(directAnswerProviderOptions({
        provider: 'google',
        modelId: 'gemini-2.5-pro',
        providerOptions: {google: {thinkingConfig: {thinkingBudget: 8192, includeThoughts: true}}}
    }).google, {thinkingConfig: {thinkingBudget: 0, includeThoughts: false}});

    assert.deepEqual(directAnswerProviderOptions({
        provider: 'mistral',
        modelId: 'magistral-small-latest',
        providerOptions: {mistral: {reasoningEffort: 'high'}}
    }).mistral, {reasoningEffort: 'none'});
});

test('direct-answer policy rejects models whose reasoning cannot be disabled', () => {
    assert.throws(
        () => assertDirectAnswerCompatibleModel({provider: 'openai', modelId: 'o3', spec: 'openai/o3'}),
        /requires reasoning that cannot be disabled/v
    );
    assert.throws(
        () => assertDirectAnswerCompatibleModel({provider: 'google', modelId: 'gemini-3-pro', spec: 'google/gemini-3-pro'}),
        /does not expose a fully disabled thinking mode/v
    );
    assert.doesNotThrow(() => assertDirectAnswerCompatibleModel({
        provider: 'openai',
        modelId: 'gpt-5.1-mini',
        spec: 'openai/gpt-5.1-mini'
    }));
});

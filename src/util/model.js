import {createAnthropic} from '@ai-sdk/anthropic';
import {createGoogleGenerativeAI} from '@ai-sdk/google';
import {createMistral} from '@ai-sdk/mistral';
import {createOpenAI} from '@ai-sdk/openai';
import {wrapLanguageModel} from 'ai';
import {createOllama} from 'ai-sdk-ollama';

// Parse a provider-qualified model spec like "openai/gpt-4o-mini" and return
// a ready-to-use model instance from the corresponding AI SDK provider.
//
// Format: "<provider>/<modelid>". The model id may contain slashes (rare,
// but supported — only the FIRST slash separates provider from id).
//

export const MODEL_PROVIDER_API_KEYS = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_GENERATIVE_AI_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    // Local models via Ollama need no API key. null marks "no credential
    // required" so config validation skips the credential check for it.
    //
    ollama: null
};

export const SUPPORTED_MODEL_PROVIDERS = Object.freeze(Object.keys(MODEL_PROVIDER_API_KEYS));

const MISSING_API_KEY = 'tracebook-no-api-key-configured';
let activeOllamaBaseUrl = 'http://127.0.0.1:11434';
let ollamaProvider = createOllama({baseURL: activeOllamaBaseUrl});
let cloudProviders = createCloudProviders();

// Test-only seam: lets a test substitute mock models for every resolveModel
// call without touching the provider registry. null in production (no-op), so
// the resolution path below is byte-identical to having no seam at all.
//
let resolveOverride = null;

export function setResolveOverrideForTest(fn) {
    resolveOverride = fn;
}

export function configureModelRuntime({credentials = {}, ollamaBaseUrl} = {}) {
    cloudProviders = createCloudProviders(credentials);

    const nextOllamaBaseUrl = String(ollamaBaseUrl || activeOllamaBaseUrl || 'http://127.0.0.1:11434').trim();
    if(nextOllamaBaseUrl && nextOllamaBaseUrl !== activeOllamaBaseUrl) {
        activeOllamaBaseUrl = nextOllamaBaseUrl;
        ollamaProvider = createOllama({baseURL: activeOllamaBaseUrl});
    }
}

export function getOllamaBaseUrl() {
    return activeOllamaBaseUrl;
}

export function getOllamaProvider() {
    return ollamaProvider;
}

export function resolveModel(spec) {
    const normalized = normalizeModelSpec(spec, 'resolveModel');
    if(resolveOverride) {
        const mock = resolveOverride(normalized);
        if(mock) {
            return mock;
        }
    }
    const {provider, modelId} = parseModelSpec(normalized, 'resolveModel');
    assertDirectAnswerCompatibleModel({provider, modelId, spec: normalized});
    if(provider === 'ollama') {
        // Tracebook's planner externalizes its reasoning into explicit phases
        // (retrieval, outline, component synthesis). Provider-level thinking is
        // therefore always disabled: it competes with the answer for the output
        // budget and can leave structured calls with no JSON at all. This is a
        // product invariant, not a user-configurable model option.
        //
        return ollamaProvider(modelId, {think: false});
    }
    const model = cloudProviders[provider].languageModel(modelId);
    return wrapLanguageModel({
        model,
        middleware: directAnswerMiddleware({provider, modelId})
    });
}

export function parseModelSpec(spec, fnName = 'parseModelSpec') {
    if(typeof spec !== 'string' || spec.length === 0) {
        throw new Error(`${fnName}: spec must be a non-empty string in the form "<provider>/<modelid>"`);
    }
    const slash = spec.indexOf('/');
    if(slash <= 0 || slash === spec.length - 1) {
        throw new Error(`${fnName}: spec "${spec}" is malformed (expected "<provider>/<modelid>")`);
    }
    const provider = spec.slice(0, slash).toLowerCase();
    const modelId = spec.slice(slash + 1);
    if(!SUPPORTED_MODEL_PROVIDERS.includes(provider)) {
        throw new Error(`${fnName}: unknown provider "${provider}" in "${spec}". Supported providers: ${SUPPORTED_MODEL_PROVIDERS.join(', ')}`);
    }
    return {provider, modelId};
}

// Extract just the model id for log lines and metadata, dropping the provider.
//
export function modelIdOnly(spec) {
    return parseModelSpec(spec, 'modelIdOnly').modelId;
}

function normalizeModelSpec(spec, fnName) {
    const {provider, modelId} = parseModelSpec(spec, fnName);
    return `${provider}/${modelId}`;
}

function createCloudProviders(credentials = {}) {
    return {
        openai: createOpenAI({
            ...providerOptions(credentials.openaiApiKey),
            baseURL: 'https://api.openai.com/v1'
        }),
        anthropic: createAnthropic({
            ...providerOptions(credentials.anthropicApiKey),
            baseURL: 'https://api.anthropic.com/v1'
        }),
        google: createGoogleGenerativeAI(providerOptions(credentials.googleApiKey)),
        mistral: createMistral(providerOptions(credentials.mistralApiKey))
    };
}

function providerOptions(apiKey) {
    const text = String(apiKey || '').trim();
    // Always pass an apiKey so provider SDKs cannot fall back to process.env.
    // Runtime validation prevents real cloud calls with this inert value.
    return {apiKey: text || MISSING_API_KEY};
}

// Force provider-specific direct-answer settings after call-level options have
// been assembled. Applying these last makes the policy non-overridable even if a
// future call site starts passing providerOptions of its own.
//
function directAnswerMiddleware({provider, modelId}) {
    return {
        specificationVersion: 'v3',
        transformParams: async ({params}) => ({
            ...params,
            providerOptions: directAnswerProviderOptions({
                provider,
                modelId,
                providerOptions: params.providerOptions
            })
        })
    };
}

export function directAnswerProviderOptions({provider, modelId, providerOptions = {}}) {
    const next = {...(providerOptions || {})};
    const current = {...(next[provider] || {})};

    if(provider === 'openai') {
        delete current.forceReasoning;
        delete current.reasoningEffort;
        delete current.reasoningSummary;
        if(isOpenAIReasoningModel(modelId)) {
            current.reasoningEffort = 'none';
        }
    } else if(provider === 'anthropic') {
        delete current.effort;
        current.sendReasoning = false;
        current.thinking = {type: 'disabled'};
    } else if(provider === 'google') {
        delete current.thinkingConfig;
        if(isGoogleBudgetControlledThinkingModel(modelId)) {
            current.thinkingConfig = {thinkingBudget: 0, includeThoughts: false};
        }
    } else if(provider === 'mistral') {
        delete current.reasoningEffort;
        if(isMistralReasoningModel(modelId)) {
            current.reasoningEffort = 'none';
        }
    }

    next[provider] = current;
    return next;
}

export function assertDirectAnswerCompatibleModel({provider, modelId, spec = `${provider}/${modelId}`}) {
    if(provider === 'openai' && isOpenAIReasoningModel(modelId) && !openAISupportsNoReasoning(modelId)) {
        throw new Error(
            `Model "${spec}" requires reasoning that cannot be disabled. ` +
            'Tracebook only supports direct-answer models, or models that support reasoningEffort="none".'
        );
    }
    if(provider === 'google' && isGoogleLevelControlledThinkingModel(modelId)) {
        throw new Error(
            `Model "${spec}" does not expose a fully disabled thinking mode. ` +
            'Tracebook only supports Google models whose thinkingBudget can be set to 0.'
        );
    }
}

function isOpenAIReasoningModel(modelId) {
    const id = String(modelId || '').toLowerCase();
    return id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4-mini') ||
        (id.startsWith('gpt-5') && !id.startsWith('gpt-5-chat'));
}

function openAISupportsNoReasoning(modelId) {
    return /^gpt-5\.(?:[1-9]|\d{2,})(?:\D|$)/v.test(String(modelId || '').toLowerCase());
}

function isGoogleBudgetControlledThinkingModel(modelId) {
    return /^gemini-2\.5(?:\D|$)/v.test(String(modelId || '').toLowerCase());
}

function isGoogleLevelControlledThinkingModel(modelId) {
    return /^gemini-3(?:\D|$)/v.test(String(modelId || '').toLowerCase());
}

function isMistralReasoningModel(modelId) {
    return /^magistral(?:\D|$)/v.test(String(modelId || '').toLowerCase());
}

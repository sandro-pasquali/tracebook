import fs from 'node:fs';
import {createCredentialStore} from './credential-store.js';
import {ensureTracebookHome, resolveTracebookPaths} from './tracebook-paths.js';
import {
    MODEL_PROVIDER_API_KEYS,
    assertDirectAnswerCompatibleModel,
    configureModelRuntime,
    parseModelSpec
} from './model.js';

export const tracebookPaths = resolveTracebookPaths();
ensureTracebookHome(tracebookPaths);
export const TEAM_CONFIG_PATH = tracebookPaths.configPath;
const credentialStore = createCredentialStore();

const DEFAULT_VALUES = {
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    GOOGLE_GENERATIVE_AI_API_KEY: '',
    MISTRAL_API_KEY: '',
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    PORT: '3000',
    TPM_BUDGET: '100000',
    RUNTIME_RETRY_BACKOFF_MS: '30000',
    SHUTDOWN_TIMEOUT_MS: '10000',
    LOG_LEVEL: 'debug',
    LOG_PRETTY: 'true',
    EXPLORATION_MODEL: 'ollama/qwen3-coder-next:latest',
    SYNTHESIS_MODEL: 'ollama/qwen3-coder-next:latest',
    OUTLINE_MODEL: 'ollama/qwen3-coder-next:latest',
    HYDE_MODEL: 'ollama/qwen3-coder-next:latest',
    ANNOTATION_MODEL: 'ollama/qwen3-coder-next:latest',
    EVAL_FAST_MODEL: 'ollama/qwen3:4b-instruct',
    EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
    EMBEDDING_DIMS: '384',
    EMBEDDING_BATCH: '32',
    EMBEDDING_NUM_THREADS: '0',
    EMBEDDING_DTYPE: 'fp32',
    EMBEDDING_QUERY_PREFIX: '',
    EMBEDDING_DOC_PREFIX: '',
    DEPENDENCY_DOCS_ENABLED: 'true',
    ENRICHMENT_ENABLED: 'true',
    ENRICHMENT_MODEL: 'ollama/qwen3-coder-next:latest',
    ENRICHMENT_MAX_OUTPUT_TOKENS: '220',
    ENRICHMENT_MAX_INPUT_CHARS: '12000',
    ENRICHMENT_TIMEOUT_MS: '30000',
    ENRICHMENT_CONCURRENCY: '4',
    RERANK_ENABLED: 'true',
    RERANK_MODEL: 'Xenova/bge-reranker-base',
    RERANK_DTYPE: 'q8',
    RERANK_CANDIDATES: '20',
    RERANK_NUM_THREADS: '0',
    HYDE_ENABLED: 'true',
    HYDE_TIMEOUT_MS: '3000',
    HYDE_MIN_SIMILARITY: '0.3',
    SEARCH_SEMANTIC_THRESHOLD: '0.20',
    SEARCH_CONTENT_MAX: '2500',
    EMBEDDING_CACHE_CAP: '512',
    FASTPATH_SIMILARITY: '0.55',
    FASTPATH_MAX_RESULTS: '3',
    FASTPATH_MAX_QUESTION_LEN: '120',
    PLANNER_THROTTLE_MS: '220',
    EXPLORATION_MAX_STEPS: '6',
    EXPLORATION_MAX_TOKENS: '4000',
    EXPLORATION_WALL_MS: '18000',
    COMPONENT_THROTTLE_MS: '120',
    COMPONENT_MAX_TOKENS: '2500',
    OUTLINE_MAX_TOKENS: '1500',
    ANNOTATION_MAX_TOKENS: '900',
    TRACE_COMPONENT_LIMIT: '6',
    COMPONENT_CONCURRENCY: '2',
    COMPONENT_WALL_MS: '120000',
    CHUNK_SMALL_FILE_LINES: '80',
    CHUNK_WINDOW_LINES: '80',
    CHUNK_WINDOW_OVERLAP: '10',
    WATCHER_DEBOUNCE_MS: '250',
    WATCHER_OPTIMIZE_DEBOUNCE_MS: '1000',
    READ_FILE_MAX_LINES: '200',
    LIST_DIR_MAX_ENTRIES: '100',
    GREP_MAX_MATCHES: '30',
    GREP_MAX_LINE_LEN: '220',
    GREP_TIMEOUT_MS: '4000',
    GOVERNOR_WINDOW_MS: '60000',
    GOVERNOR_INITIAL_TOKEN_GUESS: '6000',
    ANSWER_CACHE_CAP: '50',
    ANSWER_CACHE_TTL_MS: '300000',
    TRACE_TTL_DAYS: '30',
    SIMILAR_TRACE_MIN_SIMILARITY: '0.55',
    FIND_TRACES_LIMIT: '3'
};

const CONDITIONAL_MODEL_ENV_KEYS = [
    {key: 'HYDE_MODEL', enabledKey: 'HYDE_ENABLED'},
    {key: 'ENRICHMENT_MODEL', enabledKey: 'ENRICHMENT_ENABLED', fallback: 'ollama/qwen3-coder-next:latest'}
];

let rawValues = buildRawValues();

export const config = buildConfig(rawValues);
applyModelRuntimeConfig(config);

export function reloadConfigFromDisk() {
    rawValues = buildRawValues();
    mutateConfig(config, buildConfig(rawValues));
    applyModelRuntimeConfig(config);
    return config;
}

export function appConfigPath() {
    return TEAM_CONFIG_PATH;
}

export function defaultConfigValues() {
    return {...DEFAULT_VALUES};
}

export function advancedSystemDefaults() {
    const defaults = buildConfig(DEFAULT_VALUES);
    return {
        search: {...defaults.search},
        fastPath: {...defaults.fastPath},
        rerank: {
            model: defaults.rerank.model,
            dtype: defaults.rerank.dtype,
            candidates: defaults.rerank.candidates,
            numThreads: defaults.rerank.numThreads
        },
        hyde: {
            timeoutMs: defaults.hyde.timeoutMs,
            minSimilarity: defaults.hyde.minSimilarity
        },
        enrichment: {
            model: defaults.enrichment.model,
            maxOutputTokens: defaults.enrichment.maxOutputTokens,
            maxInputChars: defaults.enrichment.maxInputChars,
            timeoutMs: defaults.enrichment.timeoutMs,
            concurrency: defaults.enrichment.concurrency
        },
        planner: {...defaults.planner},
        annotations: {...defaults.annotations},
        trace: {...defaults.trace},
        chunker: {...defaults.chunker},
        watcher: {...defaults.watcher},
        tools: {...defaults.tools},
        governor: {...defaults.governor},
        answerCache: {...defaults.answerCache},
        traces: {...defaults.traces}
    };
}

export function assertRuntimeConfigReady(runtimeConfig = config) {
    validateConfiguredModelProviders(runtimeConfig);
    validateRerankModel(runtimeConfig);
}

function buildRawValues() {
    const fileValues = flattenTeamConfig(readTeamConfigFile());
    const keychainValues = flattenCredentials(readStoredCredentials());
    const values = {};
    for(const key of Object.keys(DEFAULT_VALUES)) {
        values[key] = valueFor(key, fileValues, keychainValues);
    }
    return values;
}

function valueFor(key, fileValues, keychainValues) {
    if(keychainValues[key] !== undefined) {
        if(String(keychainValues[key]).trim() !== '') {
            return String(keychainValues[key]);
        }
        if(fileValues[key] !== undefined && String(fileValues[key]).trim() !== '') {
            return String(fileValues[key]);
        }
        return DEFAULT_VALUES[key];
    }
    if(fileValues[key] !== undefined && String(fileValues[key]).trim() !== '') {
        return String(fileValues[key]);
    }
    return DEFAULT_VALUES[key];
}

function readTeamConfigFile() {
    try {
        if(!fs.existsSync(TEAM_CONFIG_PATH)) {
            return {};
        }
        return JSON.parse(fs.readFileSync(TEAM_CONFIG_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function readStoredCredentials() {
    try {
        return credentialStore.readCredentials();
    } catch {
        return {};
    }
}

function flattenCredentials(credentials) {
    const out = {};
    assign(out, 'OPENAI_API_KEY', credentials?.openaiApiKey);
    assign(out, 'ANTHROPIC_API_KEY', credentials?.anthropicApiKey);
    assign(out, 'GOOGLE_GENERATIVE_AI_API_KEY', credentials?.googleApiKey);
    assign(out, 'MISTRAL_API_KEY', credentials?.mistralApiKey);
    return out;
}

function flattenTeamConfig(file) {
    const out = {};
    assign(out, 'OPENAI_API_KEY', file?.credentials?.openaiApiKey);
    assign(out, 'ANTHROPIC_API_KEY', file?.credentials?.anthropicApiKey);
    assign(out, 'GOOGLE_GENERATIVE_AI_API_KEY', file?.credentials?.googleApiKey);
    assign(out, 'MISTRAL_API_KEY', file?.credentials?.mistralApiKey);
    assign(out, 'OLLAMA_BASE_URL', file?.ollamaBaseUrl);
    assign(out, 'TPM_BUDGET', file?.tpmBudget);
    assign(out, 'LOG_LEVEL', file?.logging?.level);
    assign(out, 'LOG_PRETTY', file?.logging?.pretty);
    assign(out, 'EXPLORATION_MODEL', file?.models?.exploration);
    assign(out, 'SYNTHESIS_MODEL', file?.models?.synthesis);
    assign(out, 'OUTLINE_MODEL', file?.models?.outline);
    assign(out, 'HYDE_MODEL', file?.models?.hyde);
    assign(out, 'ANNOTATION_MODEL', file?.models?.annotation);
    assign(out, 'EVAL_FAST_MODEL', file?.models?.evalFast);
    assign(out, 'EMBEDDING_MODEL', file?.embeddings?.model);
    assign(out, 'EMBEDDING_DIMS', file?.embeddings?.dims);
    assign(out, 'EMBEDDING_BATCH', file?.embeddings?.batch);
    assign(out, 'EMBEDDING_NUM_THREADS', file?.embeddings?.numThreads);
    assign(out, 'EMBEDDING_DTYPE', file?.embeddings?.dtype);
    assign(out, 'EMBEDDING_QUERY_PREFIX', file?.embeddings?.queryPrefix);
    assign(out, 'EMBEDDING_DOC_PREFIX', file?.embeddings?.docPrefix);
    assign(out, 'EMBEDDING_CACHE_CAP', file?.embeddings?.cacheCap);
    assign(out, 'DEPENDENCY_DOCS_ENABLED', file?.dependencyDocs?.enabled);
    assign(out, 'RERANK_ENABLED', file?.rerank?.enabled);
    assign(out, 'RERANK_MODEL', file?.rerank?.model);
    assign(out, 'RERANK_DTYPE', file?.rerank?.dtype);
    assign(out, 'RERANK_CANDIDATES', file?.rerank?.candidates);
    assign(out, 'RERANK_NUM_THREADS', file?.rerank?.numThreads);
    assign(out, 'ENRICHMENT_ENABLED', file?.enrichment?.enabled);
    assign(out, 'ENRICHMENT_MODEL', file?.enrichment?.model);
    assign(out, 'ENRICHMENT_MAX_OUTPUT_TOKENS', file?.enrichment?.maxOutputTokens);
    assign(out, 'ENRICHMENT_MAX_INPUT_CHARS', file?.enrichment?.maxInputChars);
    assign(out, 'ENRICHMENT_TIMEOUT_MS', file?.enrichment?.timeoutMs);
    assign(out, 'ENRICHMENT_CONCURRENCY', file?.enrichment?.concurrency);
    assign(out, 'HYDE_ENABLED', file?.hyde?.enabled);
    assign(out, 'HYDE_TIMEOUT_MS', file?.hyde?.timeoutMs);
    assign(out, 'HYDE_MIN_SIMILARITY', file?.hyde?.minSimilarity);
    assign(out, 'SEARCH_SEMANTIC_THRESHOLD', file?.search?.semanticThreshold);
    assign(out, 'SEARCH_CONTENT_MAX', file?.search?.contentMax);
    assign(out, 'FASTPATH_SIMILARITY', file?.fastPath?.similarity);
    assign(out, 'FASTPATH_MAX_RESULTS', file?.fastPath?.maxResults);
    assign(out, 'FASTPATH_MAX_QUESTION_LEN', file?.fastPath?.maxQuestionLen);
    assign(out, 'PLANNER_THROTTLE_MS', file?.planner?.throttleMs);
    assign(out, 'EXPLORATION_MAX_STEPS', file?.planner?.explorationMaxSteps);
    assign(out, 'EXPLORATION_MAX_TOKENS', file?.planner?.explorationMaxTokens);
    assign(out, 'EXPLORATION_WALL_MS', file?.planner?.explorationWallMs);
    assign(out, 'COMPONENT_THROTTLE_MS', file?.planner?.componentThrottleMs);
    assign(out, 'COMPONENT_MAX_TOKENS', file?.planner?.componentMaxTokens);
    assign(out, 'OUTLINE_MAX_TOKENS', file?.planner?.outlineMaxTokens);
    assign(out, 'COMPONENT_CONCURRENCY', file?.planner?.componentConcurrency);
    assign(out, 'COMPONENT_WALL_MS', file?.planner?.componentWallMs);
    assign(out, 'ANNOTATION_MAX_TOKENS', file?.annotations?.maxTokens);
    assign(out, 'TRACE_COMPONENT_LIMIT', file?.trace?.componentLimit);
    assign(out, 'CHUNK_SMALL_FILE_LINES', file?.chunker?.smallFileLines);
    assign(out, 'CHUNK_WINDOW_LINES', file?.chunker?.windowLines);
    assign(out, 'CHUNK_WINDOW_OVERLAP', file?.chunker?.windowOverlap);
    assign(out, 'WATCHER_DEBOUNCE_MS', file?.watcher?.debounceMs);
    assign(out, 'WATCHER_OPTIMIZE_DEBOUNCE_MS', file?.watcher?.optimizeDebounceMs);
    assign(out, 'READ_FILE_MAX_LINES', file?.tools?.readFileMaxLines);
    assign(out, 'LIST_DIR_MAX_ENTRIES', file?.tools?.listDirMaxEntries);
    assign(out, 'GREP_MAX_MATCHES', file?.tools?.grepMaxMatches);
    assign(out, 'GREP_MAX_LINE_LEN', file?.tools?.grepMaxLineLen);
    assign(out, 'GREP_TIMEOUT_MS', file?.tools?.grepTimeoutMs);
    assign(out, 'GOVERNOR_WINDOW_MS', file?.governor?.windowMs);
    assign(out, 'GOVERNOR_INITIAL_TOKEN_GUESS', file?.governor?.initialTokenGuess);
    assign(out, 'ANSWER_CACHE_CAP', file?.answerCache?.cap);
    assign(out, 'ANSWER_CACHE_TTL_MS', file?.answerCache?.ttlMs);
    assign(out, 'TRACE_TTL_DAYS', file?.traces?.ttlDays);
    assign(out, 'SIMILAR_TRACE_MIN_SIMILARITY', file?.traces?.similarMinSimilarity);
    assign(out, 'FIND_TRACES_LIMIT', file?.traces?.findLimit);
    assign(out, 'RUNTIME_RETRY_BACKOFF_MS', file?.runtime?.retryBackoffMs);
    assign(out, 'SHUTDOWN_TIMEOUT_MS', file?.runtime?.shutdownTimeoutMs);
    return out;
}

function assign(out, key, value) {
    if(value !== undefined && value !== null) {
        out[key] = String(value);
    }
}

function buildConfig(values) {
    return {
        configPath: TEAM_CONFIG_PATH,
        port: intRange(values, 'PORT', 1, 65535),
        tpmBudget: intRange(values, 'TPM_BUDGET', 1000, 10000000),
        runtime: {
            retryBackoffMs: intRange(values, 'RUNTIME_RETRY_BACKOFF_MS', 0, 3600000),
            shutdownTimeoutMs: intRange(values, 'SHUTDOWN_TIMEOUT_MS', 0, 600000)
        },
        credentials: {
            openaiApiKey: optionalStr(values, 'OPENAI_API_KEY', ''),
            anthropicApiKey: optionalStr(values, 'ANTHROPIC_API_KEY', ''),
            googleApiKey: optionalStr(values, 'GOOGLE_GENERATIVE_AI_API_KEY', ''),
            mistralApiKey: optionalStr(values, 'MISTRAL_API_KEY', '')
        },
        ollamaBaseUrl: optionalStr(values, 'OLLAMA_BASE_URL', 'http://127.0.0.1:11434'),
        logging: {
            level: optionalStr(values, 'LOG_LEVEL', 'debug'),
            pretty: optionalBool(values, 'LOG_PRETTY', true)
        },
        models: {
            exploration: str(values, 'EXPLORATION_MODEL'),
            synthesis: str(values, 'SYNTHESIS_MODEL'),
            outline: str(values, 'OUTLINE_MODEL'),
            hyde: str(values, 'HYDE_MODEL'),
            annotation: str(values, 'ANNOTATION_MODEL'),
            // The eval harness's fast tier (eval:smoke, eval:generation:fast)
            // runs every LLM role on this model. A team knob like any other
            // model: contributors set whatever small local model they have.
            //
            evalFast: str(values, 'EVAL_FAST_MODEL')
        },
        embeddings: {
            model: str(values, 'EMBEDDING_MODEL'),
            dims: intRange(values, 'EMBEDDING_DIMS', 1, 100000),
            batch: intRange(values, 'EMBEDDING_BATCH', 1, 512),
            numThreads: intRange(values, 'EMBEDDING_NUM_THREADS', 0, 1024),
            cacheCap: intRange(values, 'EMBEDDING_CACHE_CAP', 0, 1000000),
            dtype: optionalStr(values, 'EMBEDDING_DTYPE', 'fp32'),
            queryPrefix: optionalStr(values, 'EMBEDDING_QUERY_PREFIX', ''),
            docPrefix: optionalStr(values, 'EMBEDDING_DOC_PREFIX', '')
        },
        hyde: {
            enabled: bool(values, 'HYDE_ENABLED'),
            timeoutMs: intRange(values, 'HYDE_TIMEOUT_MS', 100, 60000),
            minSimilarity: Math.min(1, Math.max(0, Number(optionalStr(values, 'HYDE_MIN_SIMILARITY', '0.3')) || 0.3))
        },
        search: {
            semanticThreshold: numRange(values, 'SEARCH_SEMANTIC_THRESHOLD', 0, 1),
            contentMax: intRange(values, 'SEARCH_CONTENT_MAX', 100, 50000)
        },
        fastPath: {
            similarity: numRange(values, 'FASTPATH_SIMILARITY', 0, 1),
            maxResults: intRange(values, 'FASTPATH_MAX_RESULTS', 1, 50),
            maxQuestionLen: intRange(values, 'FASTPATH_MAX_QUESTION_LEN', 1, 2000)
        },
        planner: {
            throttleMs: intRange(values, 'PLANNER_THROTTLE_MS', 0, 10000),
            explorationMaxSteps: intRange(values, 'EXPLORATION_MAX_STEPS', 1, 20),
            explorationMaxTokens: intRange(values, 'EXPLORATION_MAX_TOKENS', 256, 32000),
            explorationWallMs: intRange(values, 'EXPLORATION_WALL_MS', 1000, 120000),
            componentThrottleMs: intRange(values, 'COMPONENT_THROTTLE_MS', 0, 10000),
            componentMaxTokens: intRange(values, 'COMPONENT_MAX_TOKENS', 256, 16000),
            outlineMaxTokens: intRange(values, 'OUTLINE_MAX_TOKENS', 256, 8000),
            componentConcurrency: Math.max(1, Math.trunc(Number(optionalStr(values, 'COMPONENT_CONCURRENCY', '2'))) || 2),
            componentWallMs: Math.max(5000, Math.trunc(Number(optionalStr(values, 'COMPONENT_WALL_MS', '120000'))) || 120000)
        },
        annotations: {
            maxTokens: intRange(values, 'ANNOTATION_MAX_TOKENS', 128, 4000)
        },
        dependencyDocs: {
            enabled: optionalBool(values, 'DEPENDENCY_DOCS_ENABLED', true)
        },
        enrichment: {
            enabled: optionalBool(values, 'ENRICHMENT_ENABLED', false),
            model: optionalStr(values, 'ENRICHMENT_MODEL', 'ollama/qwen3-coder-next:latest'),
            maxOutputTokens: Math.max(16, Math.trunc(Number(optionalStr(values, 'ENRICHMENT_MAX_OUTPUT_TOKENS', '220'))) || 220),
            maxInputChars: Math.max(500, Math.trunc(Number(optionalStr(values, 'ENRICHMENT_MAX_INPUT_CHARS', '12000'))) || 12_000),
            timeoutMs: Math.max(500, Math.trunc(Number(optionalStr(values, 'ENRICHMENT_TIMEOUT_MS', '30000'))) || 30000),
            concurrency: Math.max(1, Math.trunc(Number(optionalStr(values, 'ENRICHMENT_CONCURRENCY', '4'))) || 4)
        },
        rerank: {
            enabled: optionalBool(values, 'RERANK_ENABLED', false),
            model: optionalStr(values, 'RERANK_MODEL', 'Xenova/bge-reranker-base'),
            dtype: optionalStr(values, 'RERANK_DTYPE', 'q8'),
            candidates: Math.max(1, Math.trunc(Number(optionalStr(values, 'RERANK_CANDIDATES', '20'))) || 20),
            numThreads: Math.max(0, Math.trunc(Number(optionalStr(values, 'RERANK_NUM_THREADS', '0'))) || 0)
        },
        trace: {
            componentLimit: intRange(values, 'TRACE_COMPONENT_LIMIT', 1, 10)
        },
        chunker: {
            smallFileLines: intRange(values, 'CHUNK_SMALL_FILE_LINES', 1, 2000),
            windowLines: intRange(values, 'CHUNK_WINDOW_LINES', 10, 2000),
            windowOverlap: intRange(values, 'CHUNK_WINDOW_OVERLAP', 0, 500)
        },
        watcher: {
            debounceMs: intRange(values, 'WATCHER_DEBOUNCE_MS', 0, 10000),
            optimizeDebounceMs: intRange(values, 'WATCHER_OPTIMIZE_DEBOUNCE_MS', 0, 60000)
        },
        tools: {
            readFileMaxLines: intRange(values, 'READ_FILE_MAX_LINES', 1, 2000),
            listDirMaxEntries: intRange(values, 'LIST_DIR_MAX_ENTRIES', 1, 10000),
            grepMaxMatches: intRange(values, 'GREP_MAX_MATCHES', 1, 10000),
            grepMaxLineLen: intRange(values, 'GREP_MAX_LINE_LEN', 20, 10000),
            grepTimeoutMs: intRange(values, 'GREP_TIMEOUT_MS', 100, 60000)
        },
        governor: {
            windowMs: intRange(values, 'GOVERNOR_WINDOW_MS', 1000, 3600000),
            initialTokenGuess: intRange(values, 'GOVERNOR_INITIAL_TOKEN_GUESS', 1, 1000000)
        },
        answerCache: {
            cap: intRange(values, 'ANSWER_CACHE_CAP', 0, 100000),
            ttlMs: intRange(values, 'ANSWER_CACHE_TTL_MS', 0, 86400000)
        },
        traces: {
            ttlDays: numRange(values, 'TRACE_TTL_DAYS', 0, 3650),
            similarMinSimilarity: numRange(values, 'SIMILAR_TRACE_MIN_SIMILARITY', 0, 1),
            findLimit: intRange(values, 'FIND_TRACES_LIMIT', 1, 100)
        }
    };
}

function applyModelRuntimeConfig(runtimeConfig) {
    configureModelRuntime({
        credentials: runtimeConfig.credentials,
        ollamaBaseUrl: runtimeConfig.ollamaBaseUrl
    });
}

function mutateConfig(target, next) {
    for(const key of Object.keys(target)) {
        delete target[key];
    }
    Object.assign(target, next);
}

function validateConfiguredModelProviders(runtimeConfig) {
    const requiredCredentialKeys = new Map();
    for(const {key, spec} of configuredModelSpecs(runtimeConfig)) {
        const {provider, modelId} = parseModelSpec(spec, key);
        assertDirectAnswerCompatibleModel({provider, modelId, spec});
        const credentialKey = MODEL_PROVIDER_API_KEYS[provider];
        if(credentialKey) {
            const roles = requiredCredentialKeys.get(credentialKey) || [];
            roles.push(`${key}=${spec}`);
            requiredCredentialKeys.set(credentialKey, roles);
        }
    }
    const credentials = credentialEnv(runtimeConfig);
    const missingCredentialKeys = [...requiredCredentialKeys.keys()].filter((key) => !credentials[key]);
    if(missingCredentialKeys.length > 0) {
        const detail = missingCredentialKeys
            .map((key) => `${key} (${requiredCredentialKeys.get(key).join(', ')})`)
            .join('; ');
        throw new Error(
            `Missing required provider credentials for configured models: ${detail}. ` +
            `Open /admin and add credentials for the providers used by the configured model preset.`
        );
    }
}

function validateRerankModel(runtimeConfig) {
    if(!runtimeConfig.rerank.enabled) {
        return;
    }
    const model = String(runtimeConfig.rerank.model || '').trim();
    if(/^ollama\//i.test(model)) {
        throw new Error(
            `RERANK_MODEL="${model}" is not supported: reranking is HuggingFace-only — Ollama has no rerank endpoint. ` +
            `Use a HuggingFace model id (e.g. Xenova/bge-reranker-base, or jina-reranker-v2-base-multilingual).`
        );
    }
}

function configuredModelSpecs(runtimeConfig) {
    const specs = [
        {key: 'EXPLORATION_MODEL', spec: runtimeConfig.models.exploration},
        {key: 'SYNTHESIS_MODEL', spec: runtimeConfig.models.synthesis},
        {key: 'OUTLINE_MODEL', spec: runtimeConfig.models.outline},
        {key: 'ANNOTATION_MODEL', spec: runtimeConfig.models.annotation}
    ];
    for(const {key, enabledKey, fallback} of CONDITIONAL_MODEL_ENV_KEYS) {
        const enabled = enabledKey === 'HYDE_ENABLED'
            ? runtimeConfig.hyde.enabled
            : runtimeConfig.enrichment.enabled;
        if(enabled) {
            const value = key === 'HYDE_MODEL' ? runtimeConfig.models.hyde : runtimeConfig.enrichment.model;
            specs.push({key, spec: value || fallback});
        }
    }
    return specs;
}

function credentialEnv(runtimeConfig) {
    return {
        OPENAI_API_KEY: runtimeConfig.credentials.openaiApiKey,
        ANTHROPIC_API_KEY: runtimeConfig.credentials.anthropicApiKey,
        GOOGLE_GENERATIVE_AI_API_KEY: runtimeConfig.credentials.googleApiKey,
        MISTRAL_API_KEY: runtimeConfig.credentials.mistralApiKey
    };
}

function num(values, key) {
    const value = Number(values[key]);
    if(!Number.isFinite(value)) {
        throw new Error(`Config value ${key}="${values[key]}" is not a finite number.`);
    }
    return value;
}

function numRange(values, key, min, max) {
    const value = num(values, key);
    if(value < min || value > max) {
        throw new Error(`Config value ${key}="${values[key]}" must be between ${min} and ${max}.`);
    }
    return value;
}

function intRange(values, key, min, max) {
    const value = num(values, key);
    if(!Number.isInteger(value)) {
        throw new Error(`Config value ${key}="${values[key]}" must be an integer.`);
    }
    if(value < min || value > max) {
        throw new Error(`Config value ${key}="${values[key]}" must be an integer between ${min} and ${max}.`);
    }
    return value;
}

function bool(values, key) {
    const value = String(values[key]).toLowerCase();
    if(value === 'true') {
        return true;
    }
    if(value === 'false') {
        return false;
    }
    throw new Error(`Config value ${key}="${values[key]}" must be "true" or "false".`);
}

function str(values, key) {
    return String(values[key]);
}

function optionalStr(values, key, fallback) {
    const value = values[key];
    return value === undefined || String(value).trim() === '' ? fallback : String(value);
}

function optionalBool(values, key, fallback) {
    const value = values[key];
    if(value === undefined || String(value).trim() === '') {
        return fallback;
    }
    const normalized = String(value).toLowerCase();
    if(normalized === 'true') {
        return true;
    }
    if(normalized === 'false') {
        return false;
    }
    throw new Error(`Config value ${key}="${values[key]}" must be "true" or "false".`);
}

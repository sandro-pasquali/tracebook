import path from 'node:path';
import fs from 'fs-extra';
import {z} from 'zod';
import {advancedSystemDefaults, assertRuntimeConfigReady} from '../util/config.js';
import {
    CREDENTIAL_FIELDS,
    createCredentialStore,
    credentialFieldsWithValues,
    credentialFingerprints,
    credentialStatus
} from '../util/credential-store.js';

const repoIdSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

const repoInputSchema = z.object({
    id: z.string().trim().optional(),
    name: z.string().trim().min(1).max(120),
    path: z.string().trim().min(1).max(2000),
    description: z.string().trim().max(500).optional().default('')
}).strict();

const credentialsInputSchema = z.object({
    openaiApiKey: z.string().optional(),
    anthropicApiKey: z.string().optional(),
    googleApiKey: z.string().optional(),
    mistralApiKey: z.string().optional()
}).partial().strict();

const modelSettingsSchema = z.object({
    exploration: z.string().trim().min(1).max(200).optional(),
    synthesis: z.string().trim().min(1).max(200).optional(),
    outline: z.string().trim().min(1).max(200).optional(),
    hyde: z.string().trim().min(1).max(200).optional(),
    annotation: z.string().trim().min(1).max(200).optional(),
    evalFast: z.string().trim().min(1).max(200).optional()
}).partial().strict();

const embeddingsSettingsSchema = z.object({
    model: z.string().trim().min(1).max(200).optional(),
    dims: z.coerce.number().int().min(1).max(100000).optional(),
    batch: z.coerce.number().int().min(1).max(512).optional(),
    numThreads: z.coerce.number().int().min(0).max(1024).optional(),
    dtype: z.string().trim().min(1).max(40).optional(),
    queryPrefix: z.string().max(500).optional(),
    docPrefix: z.string().max(500).optional(),
    cacheCap: z.coerce.number().int().min(0).max(1000000).optional()
}).partial().strict();

const enrichmentSettingsSchema = z.object({
    enabled: z.boolean().optional(),
    model: z.string().trim().min(1).max(200).optional(),
    maxOutputTokens: z.coerce.number().int().min(16).max(32000).optional(),
    maxInputChars: z.coerce.number().int().min(500).max(1000000).optional(),
    timeoutMs: z.coerce.number().int().min(500).max(600000).optional(),
    concurrency: z.coerce.number().int().min(1).max(100).optional()
}).partial().strict();

const rerankSettingsSchema = z.object({
    enabled: z.boolean().optional(),
    model: z.string().trim().min(1).max(200).optional(),
    dtype: z.string().trim().min(1).max(40).optional(),
    candidates: z.coerce.number().int().min(1).max(1000).optional(),
    numThreads: z.coerce.number().int().min(0).max(1024).optional()
}).partial().strict();

const hydeSettingsSchema = z.object({
    enabled: z.boolean().optional(),
    timeoutMs: z.coerce.number().int().min(100).max(60000).optional(),
    minSimilarity: z.coerce.number().min(0).max(1).optional()
}).partial().strict();

export const teamConfigSaveSchema = z.object({
    defaultRepoId: z.string().trim().optional(),
    repos: z.array(repoInputSchema).min(1).max(50).optional(),
    credentials: credentialsInputSchema.optional(),
    clearCredentials: z.array(z.enum(CREDENTIAL_FIELDS)).max(CREDENTIAL_FIELDS.length).optional(),
    ollamaBaseUrl: z.string().trim().max(500).optional(),
    tpmBudget: z.coerce.number().int().min(1000).max(10000000).optional(),
    logging: z.object({
        level: z.string().trim().min(1).max(80).optional(),
        pretty: z.boolean().optional()
    }).partial().strict().optional(),
    models: modelSettingsSchema.optional(),
    embeddings: embeddingsSettingsSchema.optional(),
    dependencyDocs: z.object({
        enabled: z.boolean().optional()
    }).partial().strict().optional(),
    enrichment: enrichmentSettingsSchema.optional(),
    rerank: rerankSettingsSchema.optional(),
    hyde: hydeSettingsSchema.optional(),
    search: z.object({
        semanticThreshold: z.coerce.number().min(0).max(1).optional(),
        // Accepted only so configurations written before this setting became
        // operative remain readable. The old value is intentionally ignored.
        threshold: z.coerce.number().min(0).max(1).optional(),
        contentMax: z.coerce.number().int().min(100).max(50000).optional()
    }).partial().strict().optional(),
    fastPath: z.object({
        similarity: z.coerce.number().min(0).max(1).optional(),
        maxResults: z.coerce.number().int().min(1).max(50).optional(),
        maxQuestionLen: z.coerce.number().int().min(1).max(2000).optional()
    }).partial().strict().optional(),
    planner: z.object({
        throttleMs: z.coerce.number().int().min(0).max(10000).optional(),
        explorationMaxSteps: z.coerce.number().int().min(1).max(20).optional(),
        explorationMaxTokens: z.coerce.number().int().min(256).max(32000).optional(),
        explorationWallMs: z.coerce.number().int().min(1000).max(120000).optional(),
        componentThrottleMs: z.coerce.number().int().min(0).max(10000).optional(),
        componentMaxTokens: z.coerce.number().int().min(256).max(16000).optional(),
        outlineMaxTokens: z.coerce.number().int().min(256).max(8000).optional(),
        componentConcurrency: z.coerce.number().int().min(1).max(100).optional(),
        componentWallMs: z.coerce.number().int().min(5000).max(600000).optional()
    }).partial().strict().optional(),
    annotations: z.object({
        maxTokens: z.coerce.number().int().min(128).max(4000).optional()
    }).partial().strict().optional(),
    trace: z.object({
        componentLimit: z.coerce.number().int().min(1).max(10).optional()
    }).partial().strict().optional(),
    chunker: z.object({
        smallFileLines: z.coerce.number().int().min(1).max(2000).optional(),
        windowLines: z.coerce.number().int().min(10).max(2000).optional(),
        windowOverlap: z.coerce.number().int().min(0).max(500).optional()
    }).partial().strict().optional(),
    watcher: z.object({
        debounceMs: z.coerce.number().int().min(0).max(10000).optional(),
        optimizeDebounceMs: z.coerce.number().int().min(0).max(60000).optional()
    }).partial().strict().optional(),
    tools: z.object({
        readFileMaxLines: z.coerce.number().int().min(1).max(2000).optional(),
        listDirMaxEntries: z.coerce.number().int().min(1).max(10000).optional(),
        grepMaxMatches: z.coerce.number().int().min(1).max(10000).optional(),
        grepMaxLineLen: z.coerce.number().int().min(20).max(10000).optional(),
        grepTimeoutMs: z.coerce.number().int().min(100).max(60000).optional()
    }).partial().strict().optional(),
    governor: z.object({
        windowMs: z.coerce.number().int().min(1000).max(3600000).optional(),
        initialTokenGuess: z.coerce.number().int().min(1).max(1000000).optional()
    }).partial().strict().optional(),
    answerCache: z.object({
        cap: z.coerce.number().int().min(0).max(100000).optional(),
        ttlMs: z.coerce.number().int().min(0).max(86400000).optional()
    }).partial().strict().optional(),
    traces: z.object({
        ttlDays: z.coerce.number().min(0).max(3650).optional(),
        similarMinSimilarity: z.coerce.number().min(0).max(1).optional(),
        findLimit: z.coerce.number().int().min(1).max(100).optional()
    }).partial().strict().optional()
}).strict();

export function createTeamConfigStore({
    projectRoot,
    configPath,
    runtimeConfig,
    reloadConfig,
    onSaved,
    credentialStore = createCredentialStore()
} = {}) {
    if(!projectRoot || !configPath || !runtimeConfig) {
        throw new Error('createTeamConfigStore requires {projectRoot, configPath, runtimeConfig}');
    }

    async function readRaw() {
        if(!await fs.pathExists(configPath)) {
            return {};
        }
        return fs.readJson(configPath);
    }

    async function publicConfig() {
        const raw = await readRaw();
        const normalized = normalizeConfig(raw);
        return {
            configPath,
            exists: await fs.pathExists(configPath),
            repos: normalized.repos,
            defaultRepoId: normalized.defaultRepoId,
            logging: normalized.logging,
            models: normalized.models,
            embeddings: normalized.embeddings,
            dependencyDocs: normalized.dependencyDocs,
            enrichment: normalized.enrichment,
            rerank: normalized.rerank,
            hyde: normalized.hyde,
            search: normalized.search,
            fastPath: normalized.fastPath,
            planner: normalized.planner,
            annotations: normalized.annotations,
            trace: normalized.trace,
            chunker: normalized.chunker,
            watcher: normalized.watcher,
            tools: normalized.tools,
            governor: normalized.governor,
            answerCache: normalized.answerCache,
            traces: normalized.traces,
            ollamaBaseUrl: normalized.ollamaBaseUrl,
            tpmBudget: normalized.tpmBudget,
            credentials: credentialStatus(normalized.credentials),
            credentialFingerprints: credentialFingerprints(normalized.credentials)
        };
    }

    async function save(input) {
        const parsed = teamConfigSaveSchema.parse(input || {});
        const existing = normalizeConfig(await readRaw());
        const repos = parsed.repos ? normalizeRepos(parsed.repos) : existing.repos;
        const defaultRepoId = chooseDefaultRepoId(parsed.defaultRepoId || existing.defaultRepoId, repos);
        const credentialsForValidation = mergeCredentials(
            applyCredentialClears(existing.credentials, parsed.clearCredentials),
            parsed.credentials
        );
        const next = {
            version: 1,
            defaultRepoId,
            repos,
            ollamaBaseUrl: parsed.ollamaBaseUrl || existing.ollamaBaseUrl,
            tpmBudget: parsed.tpmBudget ?? existing.tpmBudget,
            logging: mergeSettings(existing.logging, parsed.logging),
            models: mergeSettings(existing.models, parsed.models),
            embeddings: mergeSettings(existing.embeddings, parsed.embeddings),
            dependencyDocs: mergeSettings(existing.dependencyDocs, parsed.dependencyDocs),
            enrichment: mergeSettings(existing.enrichment, parsed.enrichment),
            rerank: mergeSettings(existing.rerank, parsed.rerank),
            hyde: mergeSettings(existing.hyde, parsed.hyde),
            search: mergeSettings(existing.search, parsed.search),
            fastPath: mergeSettings(existing.fastPath, parsed.fastPath),
            planner: mergeSettings(existing.planner, parsed.planner),
            annotations: mergeSettings(existing.annotations, parsed.annotations),
            trace: mergeSettings(existing.trace, parsed.trace),
            chunker: mergeSettings(existing.chunker, parsed.chunker),
            watcher: mergeSettings(existing.watcher, parsed.watcher),
            tools: mergeSettings(existing.tools, parsed.tools),
            governor: mergeSettings(existing.governor, parsed.governor),
            answerCache: mergeSettings(existing.answerCache, parsed.answerCache),
            traces: mergeSettings(existing.traces, parsed.traces)
        };
        assertRuntimeConfigReady(normalizeConfig({...next, credentials: credentialsForValidation}, {
            credentials: credentialsForValidation
        }));
        if(credentialFieldsWithValues(parsed.credentials).length > 0) {
            credentialStore.deleteCredentials(parsed.clearCredentials || []);
            credentialStore.writeCredentials(parsed.credentials);
        } else if((parsed.clearCredentials || []).length > 0) {
            credentialStore.deleteCredentials(parsed.clearCredentials);
        }
        await writeConfigFile(next);
        reloadConfig?.();
        onSaved?.();
        return publicConfig();
    }

    async function repos() {
        return (await publicConfig()).repos;
    }

    async function resolveRepo(repoId = '') {
        const current = await publicConfig();
        const id = String(repoId || current.defaultRepoId || '').trim();
        if(repoId) {
            return current.repos.find((repo) => repo.id === id) || null;
        }
        return current.repos.find((repo) => repo.id === id) || current.repos[0] || null;
    }

    async function checkRepo(repoId) {
        const repo = await resolveRepo(repoId);
        if(!repo) {
            return {ok: false, error: 'repo_not_found'};
        }
        try {
            const stat = await fs.stat(repo.path);
            if(!stat.isDirectory()) {
                return {ok: false, repo, error: 'not_a_directory'};
            }
            await fs.access(repo.path, fs.constants.R_OK);
            return {ok: true, repo};
        } catch(err) {
            return {ok: false, repo, error: err?.code || 'unreadable'};
        }
    }

    function advancedDefaults() {
        return advancedSystemDefaults();
    }

    return {advancedDefaults, checkRepo, publicConfig, repos, resolveRepo, save};

    async function writeConfigFile(next) {
        await fs.ensureDir(path.dirname(configPath));
        const tmp = `${configPath}.tmp`;
        await fs.writeJson(tmp, sanitizeConfigForDisk(next), {spaces: 2});
        await fs.chmod(tmp, 0o600).catch(() => {});
        await fs.rename(tmp, configPath);
    }

    function normalizeConfig(raw, {credentials} = {}) {
        const repos = normalizeRepos(Array.isArray(raw?.repos) && raw.repos.length > 0
            ? raw.repos
            : [defaultRepo()]);
        const hasCredentialOverride = credentials !== undefined;
        const effectiveCredentials = credentials || {
            ...nonEmptyCredentials(raw?.credentials),
            ...readStoredCredentials()
        };
        return {
            version: 1,
            defaultRepoId: chooseDefaultRepoId(raw?.defaultRepoId, repos),
            repos,
            credentials: {
                openaiApiKey: effectiveCredential(effectiveCredentials, 'openaiApiKey', hasCredentialOverride),
                anthropicApiKey: effectiveCredential(effectiveCredentials, 'anthropicApiKey', hasCredentialOverride),
                googleApiKey: effectiveCredential(effectiveCredentials, 'googleApiKey', hasCredentialOverride),
                mistralApiKey: effectiveCredential(effectiveCredentials, 'mistralApiKey', hasCredentialOverride)
            },
            ollamaBaseUrl: raw?.ollamaBaseUrl || runtimeConfig.ollamaBaseUrl,
            tpmBudget: raw?.tpmBudget || runtimeConfig.tpmBudget,
            logging: {
                level: raw?.logging?.level || runtimeConfig.logging.level,
                pretty: raw?.logging?.pretty ?? runtimeConfig.logging.pretty
            },
            models: {
                exploration: raw?.models?.exploration || runtimeConfig.models.exploration,
                synthesis: raw?.models?.synthesis || runtimeConfig.models.synthesis,
                outline: raw?.models?.outline || runtimeConfig.models.outline,
                hyde: raw?.models?.hyde || runtimeConfig.models.hyde,
                annotation: raw?.models?.annotation || runtimeConfig.models.annotation,
                evalFast: raw?.models?.evalFast || runtimeConfig.models.evalFast
            },
            embeddings: {
                model: raw?.embeddings?.model || runtimeConfig.embeddings.model,
                dims: raw?.embeddings?.dims ?? runtimeConfig.embeddings.dims,
                batch: raw?.embeddings?.batch ?? runtimeConfig.embeddings.batch,
                numThreads: raw?.embeddings?.numThreads ?? runtimeConfig.embeddings.numThreads,
                dtype: raw?.embeddings?.dtype || runtimeConfig.embeddings.dtype,
                queryPrefix: raw?.embeddings?.queryPrefix ?? runtimeConfig.embeddings.queryPrefix,
                docPrefix: raw?.embeddings?.docPrefix ?? runtimeConfig.embeddings.docPrefix,
                cacheCap: raw?.embeddings?.cacheCap ?? runtimeConfig.embeddings.cacheCap
            },
            dependencyDocs: {
                enabled: raw?.dependencyDocs?.enabled ?? runtimeConfig.dependencyDocs.enabled
            },
            enrichment: {
                enabled: raw?.enrichment?.enabled ?? runtimeConfig.enrichment.enabled,
                model: raw?.enrichment?.model || runtimeConfig.enrichment.model,
                maxOutputTokens: raw?.enrichment?.maxOutputTokens ?? runtimeConfig.enrichment.maxOutputTokens,
                maxInputChars: raw?.enrichment?.maxInputChars ?? runtimeConfig.enrichment.maxInputChars,
                timeoutMs: raw?.enrichment?.timeoutMs ?? runtimeConfig.enrichment.timeoutMs,
                concurrency: raw?.enrichment?.concurrency ?? runtimeConfig.enrichment.concurrency
            },
            rerank: {
                enabled: raw?.rerank?.enabled ?? runtimeConfig.rerank.enabled,
                model: raw?.rerank?.model || runtimeConfig.rerank.model,
                dtype: raw?.rerank?.dtype || runtimeConfig.rerank.dtype,
                candidates: raw?.rerank?.candidates ?? runtimeConfig.rerank.candidates,
                numThreads: raw?.rerank?.numThreads ?? runtimeConfig.rerank.numThreads
            },
            hyde: {
                enabled: raw?.hyde?.enabled ?? runtimeConfig.hyde.enabled,
                timeoutMs: raw?.hyde?.timeoutMs ?? runtimeConfig.hyde.timeoutMs,
                minSimilarity: raw?.hyde?.minSimilarity ?? runtimeConfig.hyde.minSimilarity
            },
            search: {
                semanticThreshold: raw?.search?.semanticThreshold ?? runtimeConfig.search.semanticThreshold,
                contentMax: raw?.search?.contentMax ?? runtimeConfig.search.contentMax
            },
            fastPath: {
                similarity: raw?.fastPath?.similarity ?? runtimeConfig.fastPath.similarity,
                maxResults: raw?.fastPath?.maxResults ?? runtimeConfig.fastPath.maxResults,
                maxQuestionLen: raw?.fastPath?.maxQuestionLen ?? runtimeConfig.fastPath.maxQuestionLen
            },
            planner: {
                throttleMs: raw?.planner?.throttleMs ?? runtimeConfig.planner.throttleMs,
                explorationMaxSteps: raw?.planner?.explorationMaxSteps ?? runtimeConfig.planner.explorationMaxSteps,
                explorationMaxTokens: raw?.planner?.explorationMaxTokens ?? runtimeConfig.planner.explorationMaxTokens,
                explorationWallMs: raw?.planner?.explorationWallMs ?? runtimeConfig.planner.explorationWallMs,
                componentThrottleMs: raw?.planner?.componentThrottleMs ?? runtimeConfig.planner.componentThrottleMs,
                componentMaxTokens: raw?.planner?.componentMaxTokens ?? runtimeConfig.planner.componentMaxTokens,
                outlineMaxTokens: raw?.planner?.outlineMaxTokens ?? runtimeConfig.planner.outlineMaxTokens,
                componentConcurrency: raw?.planner?.componentConcurrency ?? runtimeConfig.planner.componentConcurrency,
                componentWallMs: raw?.planner?.componentWallMs ?? runtimeConfig.planner.componentWallMs
            },
            annotations: {
                maxTokens: raw?.annotations?.maxTokens ?? runtimeConfig.annotations.maxTokens
            },
            trace: {
                componentLimit: raw?.trace?.componentLimit ?? runtimeConfig.trace.componentLimit
            },
            chunker: {
                smallFileLines: raw?.chunker?.smallFileLines ?? runtimeConfig.chunker.smallFileLines,
                windowLines: raw?.chunker?.windowLines ?? runtimeConfig.chunker.windowLines,
                windowOverlap: raw?.chunker?.windowOverlap ?? runtimeConfig.chunker.windowOverlap
            },
            watcher: {
                debounceMs: raw?.watcher?.debounceMs ?? runtimeConfig.watcher.debounceMs,
                optimizeDebounceMs: raw?.watcher?.optimizeDebounceMs ?? runtimeConfig.watcher.optimizeDebounceMs
            },
            tools: {
                readFileMaxLines: raw?.tools?.readFileMaxLines ?? runtimeConfig.tools.readFileMaxLines,
                listDirMaxEntries: raw?.tools?.listDirMaxEntries ?? runtimeConfig.tools.listDirMaxEntries,
                grepMaxMatches: raw?.tools?.grepMaxMatches ?? runtimeConfig.tools.grepMaxMatches,
                grepMaxLineLen: raw?.tools?.grepMaxLineLen ?? runtimeConfig.tools.grepMaxLineLen,
                grepTimeoutMs: raw?.tools?.grepTimeoutMs ?? runtimeConfig.tools.grepTimeoutMs
            },
            governor: {
                windowMs: raw?.governor?.windowMs ?? runtimeConfig.governor.windowMs,
                initialTokenGuess: raw?.governor?.initialTokenGuess ?? runtimeConfig.governor.initialTokenGuess
            },
            answerCache: {
                cap: raw?.answerCache?.cap ?? runtimeConfig.answerCache.cap,
                ttlMs: raw?.answerCache?.ttlMs ?? runtimeConfig.answerCache.ttlMs
            },
            traces: {
                ttlDays: raw?.traces?.ttlDays ?? runtimeConfig.traces.ttlDays,
                similarMinSimilarity: raw?.traces?.similarMinSimilarity ?? runtimeConfig.traces.similarMinSimilarity,
                findLimit: raw?.traces?.findLimit ?? runtimeConfig.traces.findLimit
            }
        };
    }

    function defaultRepo() {
        return {
            id: 'tracebook',
            name: 'Tracebook',
            path: projectRoot,
            description: 'Dogfood this Tracebook checkout.'
        };
    }

    function readStoredCredentials() {
        try {
            return nonEmptyCredentials(credentialStore.readCredentials());
        } catch {
            return {};
        }
    }

    function effectiveCredential(credentials, field, hasOverride) {
        return credentials[field] || (hasOverride ? '' : runtimeConfig.credentials[field]) || '';
    }
}

function normalizeRepos(repos) {
    const used = new Set();
    return repos.map((repo, index) => {
        const candidate = repoIdSchema.safeParse(repo.id || '').success
            ? repo.id
            : slugFor(repo.name || `repo-${index + 1}`);
        const id = uniqueId(candidate, used);
        used.add(id);
        return {
            id,
            name: repo.name,
            path: path.resolve(repo.path),
            description: repo.description || ''
        };
    });
}

function chooseDefaultRepoId(candidate, repos) {
    const id = String(candidate || '').trim();
    if(id && repos.some((repo) => repo.id === id)) {
        return id;
    }
    return repos[0]?.id || '';
}

function mergeCredentials(existing, incoming = {}) {
    const out = {...existing};
    for(const key of Object.keys(incoming || {})) {
        const value = String(incoming[key] || '').trim();
        if(value) {
            out[key] = value;
        }
    }
    return out;
}

function applyCredentialClears(existing, fields = []) {
    const out = {...existing};
    for(const field of fields || []) {
        delete out[field];
    }
    return out;
}

function nonEmptyCredentials(credentials = {}) {
    const out = {};
    for(const [key, value] of Object.entries(credentials || {})) {
        const text = String(value || '').trim();
        if(text) {
            out[key] = text;
        }
    }
    return out;
}

function sanitizeConfigForDisk(config = {}) {
    const out = structuredClone(config || {});
    delete out.credentials;
    out.version = out.version || 1;
    return out;
}

function mergeSettings(existing, incoming = {}) {
    const out = {...existing};
    for(const [key, value] of Object.entries(incoming || {})) {
        if(value !== undefined) {
            out[key] = value;
        }
    }
    return out;
}

function slugFor(value) {
    const slug = String(value || 'repo')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return repoIdSchema.safeParse(slug).success ? slug : 'repo';
}

function uniqueId(base, used) {
    if(!used.has(base)) {
        return base;
    }
    for(let i = 2; i < 1000; i++) {
        const next = `${base}-${i}`;
        if(!used.has(next)) {
            return next;
        }
    }
    return `${base}-${Date.now().toString(36)}`;
}

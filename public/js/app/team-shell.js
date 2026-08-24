import {apiFetch, setSelectedRepoId, selectedRepoId} from './team-context.js';

const SECRET_FIELDS = [
    {field: 'openaiApiKey', label: 'OpenAI'},
    {field: 'anthropicApiKey', label: 'Anthropic'},
    {field: 'googleApiKey', label: 'Google'},
    {field: 'mistralApiKey', label: 'Mistral'}
];

export async function renderTeamRouteIfNeeded() {
    if(location.pathname === '/repos') {
        await renderRepoPicker();
        return true;
    }
    if(location.pathname === '/admin') {
        await renderAdmin();
        return true;
    }
    return false;
}

async function renderRepoPicker() {
    const shell = resetPage('Choose Codebase', linkButton('/admin', 'Admin'));

    const list = document.createElement('div');
    list.className = 'team-repo-list';
    shell.appendChild(list);
    list.textContent = 'Loading repos...';

    try {
        const res = await apiFetch('/api/team/repos');
        const payload = await res.json();
        const repos = Array.isArray(payload?.repos) ? payload.repos : [];
        list.innerHTML = '';
        if(repos.length === 0) {
            list.appendChild(emptyState('No repos are configured yet.'));
            return;
        }
        for(const repo of repos) {
            list.appendChild(repoCard(repo));
        }
    } catch(err) {
        list.innerHTML = '';
        list.appendChild(emptyState(err?.message || 'Could not load repos.'));
    }
}

async function renderAdmin() {
    const shell = resetPage('Admin Setup', linkButton('/repos', 'Repo picker'));
    const form = document.createElement('form');
    form.className = 'team-admin-form';
    form.innerHTML = adminFormHtml();
    shell.appendChild(form);

    const status = document.createElement('div');
    status.className = 'team-status';
    shell.appendChild(status);

    let current = null;
    try {
        const res = await apiFetch('/api/team/config');
        current = await res.json();
        fillAdminForm(form, current);
        renderRepoRows(form, current.repos || []);
        status.textContent = current.exists
            ? `Config file: ${current.configPath}`
            : `No config file yet. Saving will create ${current.configPath}`;
    } catch(err) {
        status.textContent = err?.message || 'Could not load config.';
    }

    form.querySelector('[data-add-repo]')?.addEventListener('click', () => {
        const repos = readRepoRows(form);
        repos.push({name: '', path: '', description: ''});
        renderRepoRows(form, repos);
    });

    form.addEventListener('click', (ev) => {
        const button = ev.target.closest('[data-remove-repo]');
        if(!button) {
            return;
        }
        const row = button.closest('[data-repo-row]');
        row?.remove();
    });

    form.addEventListener('click', (ev) => {
        const button = ev.target.closest('[data-clear-secret]');
        if(!button || button.disabled) {
            return;
        }
        const field = button.dataset.clearSecret;
        const secret = SECRET_FIELDS.find((item) => item.field === field);
        const row = form.querySelector(`[data-secret-row="${field}"]`);
        if(!secret || !row) {
            return;
        }
        row.dataset.clearPending = 'true';
        form.elements[field].value = '';
        updateSecretControl(form, current, secret);
        status.textContent = `${secret.label} key will be cleared when you save.`;
    });

    form.addEventListener('input', (ev) => {
        const input = ev.target.closest('input');
        const secret = SECRET_FIELDS.find((item) => item.field === input?.name);
        if(!secret) {
            return;
        }
        const row = form.querySelector(`[data-secret-row="${secret.field}"]`);
        if(row && input.value.trim()) {
            row.dataset.clearPending = 'false';
            updateSecretControl(form, current, secret);
        }
    });

    form.querySelector('[data-restore-advanced-defaults]')?.addEventListener('click', async () => {
        status.textContent = 'Loading advanced defaults...';
        try {
            const res = await apiFetch('/api/team/defaults/advanced', {headers: {accept: 'application/json'}});
            const payload = await res.json();
            if(!res.ok) {
                throw new Error(payload?.error || `defaults_load_failed:${res.status}`);
            }
            applyAdvancedDefaults(form, payload.defaults || {});
            status.textContent = 'Advanced defaults restored in the form. Save to apply.';
        } catch(err) {
            status.textContent = err?.message || 'Could not restore advanced defaults.';
        }
    });

    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        status.textContent = 'Saving...';
        try {
            const payload = adminPayload(form, current);
            const res = await apiFetch('/api/team/config', {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify(payload)
            });
            const saved = await res.json();
            if(!res.ok) {
                throw new Error(saved?.message || saved?.error || `config_save_failed:${res.status}`);
            }
            current = saved;
            fillAdminForm(form, saved);
            renderRepoRows(form, saved.repos || []);
            status.textContent = `Saved ${saved.repos.length} repo${saved.repos.length === 1 ? '' : 's'}.`;
        } catch(err) {
            status.textContent = err?.message || 'Config save failed.';
        }
    });
}

function resetPage(titleText, headerAction = null) {
    document.body.classList.add('team-page');
    document.body.innerHTML = '';
    const header = document.createElement('header');
    header.className = 'team-topbar';
    const brand = document.createElement('a');
    brand.href = '/repos';
    brand.className = 'team-brand';
    brand.textContent = 'Tracebook';
    header.appendChild(brand);
    if(headerAction) {
        const nav = document.createElement('nav');
        nav.className = 'team-header-nav';
        nav.appendChild(headerAction);
        header.appendChild(nav);
    }
    document.body.appendChild(header);

    const main = document.createElement('main');
    main.className = 'team-shell';
    const title = document.createElement('h1');
    title.textContent = titleText;
    main.appendChild(title);
    document.body.appendChild(main);
    return main;
}

function repoCard(repo) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'team-repo-card';
    const title = document.createElement('strong');
    title.textContent = repo.name || repo.id;
    const path = document.createElement('span');
    path.textContent = repo.path || '';
    const description = document.createElement('em');
    description.textContent = repo.description || '';
    button.append(title, path, description);
    button.addEventListener('click', () => {
        setSelectedRepoId(repo.id);
        location.href = '/';
    });
    return button;
}

function emptyState(text) {
    const div = document.createElement('div');
    div.className = 'team-empty';
    div.textContent = text;
    return div;
}

function linkButton(href, text) {
    const link = document.createElement('a');
    link.href = href;
    link.className = 'team-link-button';
    link.textContent = text;
    return link;
}

function adminFormHtml() {
    return `
        <section class="team-admin-section">
            <h2>Repos</h2>
            <div data-repos></div>
            <button type="button" class="team-secondary" data-add-repo>Add repo</button>
        </section>
        <section class="team-admin-section">
            <h2>Model routing</h2>
            <p class="team-admin-help" data-model-routing-help>Generative model specs use <code>provider/model</code>. Repository state, indexes, and evidence selection stay local. A hosted role receives the bounded prompt and evidence described for that workload. Local memory depends on model size, quantization, context, and concurrency; hosted cost follows call count and context size.</p>
            <div class="team-secret-row" data-secret-row="openaiApiKey">
                <label>OpenAI API key <input name="openaiApiKey" type="password" autocomplete="off"></label>
                <span class="team-secret-fingerprint" data-secret-fingerprint="openaiApiKey"></span>
                <button type="button" class="team-secondary" data-clear-secret="openaiApiKey">Clear</button>
            </div>
            <div class="team-secret-row" data-secret-row="anthropicApiKey">
                <label>Anthropic API key <input name="anthropicApiKey" type="password" autocomplete="off"></label>
                <span class="team-secret-fingerprint" data-secret-fingerprint="anthropicApiKey"></span>
                <button type="button" class="team-secondary" data-clear-secret="anthropicApiKey">Clear</button>
            </div>
            <div class="team-secret-row" data-secret-row="googleApiKey">
                <label>Google API key <input name="googleApiKey" type="password" autocomplete="off"></label>
                <span class="team-secret-fingerprint" data-secret-fingerprint="googleApiKey"></span>
                <button type="button" class="team-secondary" data-clear-secret="googleApiKey">Clear</button>
            </div>
            <div class="team-secret-row" data-secret-row="mistralApiKey">
                <label>Mistral API key <input name="mistralApiKey" type="password" autocomplete="off"></label>
                <span class="team-secret-fingerprint" data-secret-fingerprint="mistralApiKey"></span>
                <button type="button" class="team-secondary" data-clear-secret="mistralApiKey">Clear</button>
            </div>
            <label>Token budget <input name="tpmBudget" type="number" min="1000"></label>
            <label>Log level <input name="logLevel" type="text"></label>
            <label class="team-checkbox"><input name="logPretty" type="checkbox"> Pretty logs</label>
            <label>Exploration model <input name="exploration" type="text"><span class="team-field-help" data-role-help="exploration">Iterative, tool-capable investigation. Receives the question, selected evidence, and bounded repository search/read results; latency and cost scale with exploration steps.</span></label>
            <label>Synthesis model <input name="synthesis" type="text"><span class="team-field-help" data-role-help="synthesis">Renders one structured result per planned story component from selected evidence. Total compute, latency, and cost scale with component count and concurrency.</span></label>
            <label>Outline model <input name="outline" type="text"><span class="team-field-help" data-role-help="outline">Plans chapter structure and coverage from the question and selected evidence; it also supports change-brief generation.</span></label>
            <label>Annotation model <input name="annotation" type="text"><span class="team-field-help" data-role-help="annotation">Runs source-focused structured calls over selected code excerpts to identify and explain load-bearing lines.</span></label>
            <label>HyDE model <input name="hydeModel" type="text"><span class="team-field-help" data-role-help="hyde">Conditionally generates a short query expansion when initial retrieval is weak. It receives the question, not repository evidence.</span></label>
            <label>Eval fast model <input name="evalFast" type="text" placeholder="small local model for eval smoke runs"><span class="team-field-help" data-role-help="eval-fast">Used only by the reduced generation-evaluation path; prefer a small local model.</span></label>
            <label>Embedding model <input name="embeddingModel" type="text"><span class="team-field-help" data-role-help="embedding">Encodes every indexed document or source chunk and each search query. Bare model IDs run through local Hugging Face Transformers; <code>ollama/</code> uses the configured Ollama endpoint.</span></label>
            <label>Embedding dimensions <input name="embeddingDims" type="number" min="1"></label>
            <label>Embedding batch <input name="embeddingBatch" type="number" min="1"></label>
            <label>Embedding threads <input name="embeddingNumThreads" type="number" min="0"></label>
            <label>Embedding dtype <input name="embeddingDtype" type="text"></label>
            <label>Embedding query prefix <input name="embeddingQueryPrefix" type="text"></label>
            <label>Embedding document prefix <input name="embeddingDocPrefix" type="text"></label>
            <label>Embedding cache cap <input name="embeddingCacheCap" type="number" min="0"></label>
            <label>Ollama base URL <input name="ollamaBaseUrl" type="text"><span class="team-field-help" data-ollama-endpoint-help>The default loopback URL runs Ollama on this machine. Another address sends all <code>ollama/</code> model requests to that host.</span></label>
            <label class="team-checkbox"><input name="dependencyDocsEnabled" type="checkbox"> Index dependency docs</label>
            <label class="team-checkbox"><input name="enrichmentEnabled" type="checkbox"> Enable file enrichment</label>
            <label class="team-checkbox"><input name="rerankEnabled" type="checkbox"> Enable reranker</label>
            <label class="team-checkbox"><input name="hydeEnabled" type="checkbox"> Enable HyDE</label>
        </section>
        <section class="team-admin-section">
            <h2>Retrieval</h2>
            <p class="team-admin-help">Reranking runs locally over the top candidates for each search. Larger rerankers trade additional memory and query latency for ordering quality; HyDE adds a model call only when initial retrieval is weak.</p>
            <div class="team-admin-grid">
                <label>Semantic vector threshold <input name="searchSemanticThreshold" type="number" min="0" max="1" step="0.01"></label>
                <label>Search content max <input name="searchContentMax" type="number" min="100"></label>
                <label>Fast path similarity <input name="fastPathSimilarity" type="number" min="0" max="1" step="0.01"></label>
                <label>Fast path max results <input name="fastPathMaxResults" type="number" min="1"></label>
                <label>Fast path question length <input name="fastPathMaxQuestionLen" type="number" min="1"></label>
                <label>Rerank model <input name="rerankModel" type="text"></label>
                <label>Rerank dtype <input name="rerankDtype" type="text"></label>
                <label>Rerank candidates <input name="rerankCandidates" type="number" min="1"></label>
                <label>Rerank threads <input name="rerankNumThreads" type="number" min="0"></label>
                <label>HyDE timeout ms <input name="hydeTimeoutMs" type="number" min="100"></label>
                <label>HyDE min similarity <input name="hydeMinSimilarity" type="number" min="0" max="1" step="0.01"></label>
            </div>
        </section>
        <section class="team-admin-section">
            <h2>Enrichment</h2>
            <p class="team-admin-help" data-enrichment-help>Enrichment runs one model call per new or changed source file. Each call includes the relative file path and at most Max input chars of source, so initial indexing can be a high-volume workload; a capable local model avoids per-file API cost.</p>
            <div class="team-admin-grid">
                <label>Enrichment model <input name="enrichmentModel" type="text"></label>
                <label>Max output tokens <input name="enrichmentMaxOutputTokens" type="number" min="16"></label>
                <label>Max input chars <input name="enrichmentMaxInputChars" type="number" min="500"></label>
                <label>Timeout ms <input name="enrichmentTimeoutMs" type="number" min="500"></label>
                <label>Concurrency <input name="enrichmentConcurrency" type="number" min="1"></label>
            </div>
        </section>
        <section class="team-admin-section">
            <h2>Planner</h2>
            <div class="team-admin-grid">
                <label>Planner throttle ms <input name="plannerThrottleMs" type="number" min="0"></label>
                <label>Exploration max steps <input name="explorationMaxSteps" type="number" min="1"></label>
                <label>Exploration max tokens <input name="explorationMaxTokens" type="number" min="256"></label>
                <label>Exploration wall ms <input name="explorationWallMs" type="number" min="1000"></label>
                <label>Component throttle ms <input name="componentThrottleMs" type="number" min="0"></label>
                <label>Component max tokens <input name="componentMaxTokens" type="number" min="256"></label>
                <label>Outline max tokens <input name="outlineMaxTokens" type="number" min="256"></label>
                <label>Annotation max tokens <input name="annotationMaxTokens" type="number" min="128"></label>
                <label>Trace component limit <input name="traceComponentLimit" type="number" min="1" max="10"></label>
                <label>Component concurrency <input name="componentConcurrency" type="number" min="1"></label>
                <label>Component wall ms <input name="componentWallMs" type="number" min="5000"></label>
            </div>
        </section>
        <section class="team-admin-section">
            <h2>Indexing And Tools</h2>
            <div class="team-admin-grid">
                <label>Small file lines <input name="chunkSmallFileLines" type="number" min="1"></label>
                <label>Window lines <input name="chunkWindowLines" type="number" min="10"></label>
                <label>Window overlap <input name="chunkWindowOverlap" type="number" min="0"></label>
                <label>Watcher debounce ms <input name="watcherDebounceMs" type="number" min="0"></label>
                <label>Watcher optimize ms <input name="watcherOptimizeDebounceMs" type="number" min="0"></label>
                <label>Read file max lines <input name="readFileMaxLines" type="number" min="1"></label>
                <label>List dir max entries <input name="listDirMaxEntries" type="number" min="1"></label>
                <label>Grep max matches <input name="grepMaxMatches" type="number" min="1"></label>
                <label>Grep max line length <input name="grepMaxLineLen" type="number" min="20"></label>
                <label>Grep timeout ms <input name="grepTimeoutMs" type="number" min="100"></label>
            </div>
        </section>
        <section class="team-admin-section">
            <h2>Cache And Governor</h2>
            <div class="team-admin-grid">
                <label>Governor window ms <input name="governorWindowMs" type="number" min="1000"></label>
                <label>Governor initial tokens <input name="governorInitialTokenGuess" type="number" min="1"></label>
                <label>Answer cache cap <input name="answerCacheCap" type="number" min="0"></label>
                <label>Answer cache TTL ms <input name="answerCacheTtlMs" type="number" min="0"></label>
                <label>Trace TTL days <input name="traceTtlDays" type="number" min="0" step="0.1"></label>
                <label>Similar trace similarity <input name="similarTraceMinSimilarity" type="number" min="0" max="1" step="0.01"></label>
                <label>Find traces limit <input name="findTracesLimit" type="number" min="1"></label>
            </div>
        </section>
        <div class="team-form-actions">
            <button type="submit">Save Config</button>
            <button type="button" class="team-secondary" data-restore-advanced-defaults>Restore advanced defaults</button>
        </div>
    `;
}

function fillAdminForm(form, config) {
    const set = (name, value) => {
        setFieldValue(form, name, value);
    };
    const setChecked = (name, value) => {
        const input = form.elements[name];
        if(input) {
            input.checked = Boolean(value);
        }
    };
    set('tpmBudget', config?.tpmBudget);
    set('logLevel', config?.logging?.level);
    setChecked('logPretty', config?.logging?.pretty);
    set('exploration', config?.models?.exploration);
    set('synthesis', config?.models?.synthesis);
    set('outline', config?.models?.outline);
    set('annotation', config?.models?.annotation);
    set('hydeModel', config?.models?.hyde);
    set('evalFast', config?.models?.evalFast);
    set('embeddingModel', config?.embeddings?.model);
    set('embeddingDims', config?.embeddings?.dims);
    set('embeddingBatch', config?.embeddings?.batch);
    set('embeddingNumThreads', config?.embeddings?.numThreads);
    set('embeddingDtype', config?.embeddings?.dtype);
    set('embeddingQueryPrefix', config?.embeddings?.queryPrefix);
    set('embeddingDocPrefix', config?.embeddings?.docPrefix);
    set('embeddingCacheCap', config?.embeddings?.cacheCap);
    set('ollamaBaseUrl', config?.ollamaBaseUrl);
    setChecked('dependencyDocsEnabled', config?.dependencyDocs?.enabled);
    setChecked('enrichmentEnabled', config?.enrichment?.enabled);
    setChecked('rerankEnabled', config?.rerank?.enabled);
    setChecked('hydeEnabled', config?.hyde?.enabled);
    set('searchSemanticThreshold', config?.search?.semanticThreshold);
    set('searchContentMax', config?.search?.contentMax);
    set('fastPathSimilarity', config?.fastPath?.similarity);
    set('fastPathMaxResults', config?.fastPath?.maxResults);
    set('fastPathMaxQuestionLen', config?.fastPath?.maxQuestionLen);
    set('rerankModel', config?.rerank?.model);
    set('rerankDtype', config?.rerank?.dtype);
    set('rerankCandidates', config?.rerank?.candidates);
    set('rerankNumThreads', config?.rerank?.numThreads);
    set('hydeTimeoutMs', config?.hyde?.timeoutMs);
    set('hydeMinSimilarity', config?.hyde?.minSimilarity);
    set('enrichmentModel', config?.enrichment?.model);
    set('enrichmentMaxOutputTokens', config?.enrichment?.maxOutputTokens);
    set('enrichmentMaxInputChars', config?.enrichment?.maxInputChars);
    set('enrichmentTimeoutMs', config?.enrichment?.timeoutMs);
    set('enrichmentConcurrency', config?.enrichment?.concurrency);
    set('plannerThrottleMs', config?.planner?.throttleMs);
    set('explorationMaxSteps', config?.planner?.explorationMaxSteps);
    set('explorationMaxTokens', config?.planner?.explorationMaxTokens);
    set('explorationWallMs', config?.planner?.explorationWallMs);
    set('componentThrottleMs', config?.planner?.componentThrottleMs);
    set('componentMaxTokens', config?.planner?.componentMaxTokens);
    set('outlineMaxTokens', config?.planner?.outlineMaxTokens);
    set('annotationMaxTokens', config?.annotations?.maxTokens);
    set('traceComponentLimit', config?.trace?.componentLimit);
    set('componentConcurrency', config?.planner?.componentConcurrency);
    set('componentWallMs', config?.planner?.componentWallMs);
    set('chunkSmallFileLines', config?.chunker?.smallFileLines);
    set('chunkWindowLines', config?.chunker?.windowLines);
    set('chunkWindowOverlap', config?.chunker?.windowOverlap);
    set('watcherDebounceMs', config?.watcher?.debounceMs);
    set('watcherOptimizeDebounceMs', config?.watcher?.optimizeDebounceMs);
    set('readFileMaxLines', config?.tools?.readFileMaxLines);
    set('listDirMaxEntries', config?.tools?.listDirMaxEntries);
    set('grepMaxMatches', config?.tools?.grepMaxMatches);
    set('grepMaxLineLen', config?.tools?.grepMaxLineLen);
    set('grepTimeoutMs', config?.tools?.grepTimeoutMs);
    set('governorWindowMs', config?.governor?.windowMs);
    set('governorInitialTokenGuess', config?.governor?.initialTokenGuess);
    set('answerCacheCap', config?.answerCache?.cap);
    set('answerCacheTtlMs', config?.answerCache?.ttlMs);
    set('traceTtlDays', config?.traces?.ttlDays);
    set('similarTraceMinSimilarity', config?.traces?.similarMinSimilarity);
    set('findTracesLimit', config?.traces?.findLimit);
    for(const secret of SECRET_FIELDS) {
        form.elements[secret.field].value = '';
        const row = form.querySelector(`[data-secret-row="${secret.field}"]`);
        if(row) {
            row.dataset.clearPending = 'false';
        }
        updateSecretControl(form, config, secret);
    }
}

function applyAdvancedDefaults(form, defaults) {
    setFieldValue(form, 'searchSemanticThreshold', defaults?.search?.semanticThreshold);
    setFieldValue(form, 'searchContentMax', defaults?.search?.contentMax);
    setFieldValue(form, 'fastPathSimilarity', defaults?.fastPath?.similarity);
    setFieldValue(form, 'fastPathMaxResults', defaults?.fastPath?.maxResults);
    setFieldValue(form, 'fastPathMaxQuestionLen', defaults?.fastPath?.maxQuestionLen);
    setFieldValue(form, 'rerankModel', defaults?.rerank?.model);
    setFieldValue(form, 'rerankDtype', defaults?.rerank?.dtype);
    setFieldValue(form, 'rerankCandidates', defaults?.rerank?.candidates);
    setFieldValue(form, 'rerankNumThreads', defaults?.rerank?.numThreads);
    setFieldValue(form, 'hydeTimeoutMs', defaults?.hyde?.timeoutMs);
    setFieldValue(form, 'hydeMinSimilarity', defaults?.hyde?.minSimilarity);

    setFieldValue(form, 'enrichmentModel', defaults?.enrichment?.model);
    setFieldValue(form, 'enrichmentMaxOutputTokens', defaults?.enrichment?.maxOutputTokens);
    setFieldValue(form, 'enrichmentMaxInputChars', defaults?.enrichment?.maxInputChars);
    setFieldValue(form, 'enrichmentTimeoutMs', defaults?.enrichment?.timeoutMs);
    setFieldValue(form, 'enrichmentConcurrency', defaults?.enrichment?.concurrency);

    setFieldValue(form, 'plannerThrottleMs', defaults?.planner?.throttleMs);
    setFieldValue(form, 'explorationMaxSteps', defaults?.planner?.explorationMaxSteps);
    setFieldValue(form, 'explorationMaxTokens', defaults?.planner?.explorationMaxTokens);
    setFieldValue(form, 'explorationWallMs', defaults?.planner?.explorationWallMs);
    setFieldValue(form, 'componentThrottleMs', defaults?.planner?.componentThrottleMs);
    setFieldValue(form, 'componentMaxTokens', defaults?.planner?.componentMaxTokens);
    setFieldValue(form, 'outlineMaxTokens', defaults?.planner?.outlineMaxTokens);
    setFieldValue(form, 'annotationMaxTokens', defaults?.annotations?.maxTokens);
    setFieldValue(form, 'traceComponentLimit', defaults?.trace?.componentLimit);
    setFieldValue(form, 'componentConcurrency', defaults?.planner?.componentConcurrency);
    setFieldValue(form, 'componentWallMs', defaults?.planner?.componentWallMs);

    setFieldValue(form, 'chunkSmallFileLines', defaults?.chunker?.smallFileLines);
    setFieldValue(form, 'chunkWindowLines', defaults?.chunker?.windowLines);
    setFieldValue(form, 'chunkWindowOverlap', defaults?.chunker?.windowOverlap);
    setFieldValue(form, 'watcherDebounceMs', defaults?.watcher?.debounceMs);
    setFieldValue(form, 'watcherOptimizeDebounceMs', defaults?.watcher?.optimizeDebounceMs);
    setFieldValue(form, 'readFileMaxLines', defaults?.tools?.readFileMaxLines);
    setFieldValue(form, 'listDirMaxEntries', defaults?.tools?.listDirMaxEntries);
    setFieldValue(form, 'grepMaxMatches', defaults?.tools?.grepMaxMatches);
    setFieldValue(form, 'grepMaxLineLen', defaults?.tools?.grepMaxLineLen);
    setFieldValue(form, 'grepTimeoutMs', defaults?.tools?.grepTimeoutMs);

    setFieldValue(form, 'governorWindowMs', defaults?.governor?.windowMs);
    setFieldValue(form, 'governorInitialTokenGuess', defaults?.governor?.initialTokenGuess);
    setFieldValue(form, 'answerCacheCap', defaults?.answerCache?.cap);
    setFieldValue(form, 'answerCacheTtlMs', defaults?.answerCache?.ttlMs);
    setFieldValue(form, 'traceTtlDays', defaults?.traces?.ttlDays);
    setFieldValue(form, 'similarTraceMinSimilarity', defaults?.traces?.similarMinSimilarity);
    setFieldValue(form, 'findTracesLimit', defaults?.traces?.findLimit);
}

function setFieldValue(form, name, value) {
    const input = form.elements[name];
    if(input) {
        input.value = value ?? '';
    }
}

function renderRepoRows(form, repos) {
    const root = form.querySelector('[data-repos]');
    root.innerHTML = '';
    for(const repo of repos) {
        const row = document.createElement('div');
        row.className = 'team-repo-row';
        row.dataset.repoRow = '1';
        row.innerHTML = `
            <input name="repoId" type="hidden">
            <label>Name <input name="repoName" type="text" required></label>
            <label>Absolute path <input name="repoPath" type="text" required></label>
            <label>Description <input name="repoDescription" type="text"></label>
            <button type="button" class="team-secondary" data-remove-repo>Remove</button>
        `;
        row.querySelector('[name="repoId"]').value = repo.id || '';
        row.querySelector('[name="repoName"]').value = repo.name || '';
        row.querySelector('[name="repoPath"]').value = repo.path || '';
        row.querySelector('[name="repoDescription"]').value = repo.description || '';
        root.appendChild(row);
    }
}

function readRepoRows(form) {
    return [...form.querySelectorAll('[data-repo-row]')].map((row) => ({
        id: row.querySelector('[name="repoId"]').value.trim(),
        name: row.querySelector('[name="repoName"]').value.trim(),
        path: row.querySelector('[name="repoPath"]').value.trim(),
        description: row.querySelector('[name="repoDescription"]').value.trim()
    })).filter((repo) => repo.name || repo.path);
}

function adminPayload(form, current) {
    const repos = readRepoRows(form);
    const selected = selectedRepoId();
    return {
        defaultRepoId: current?.defaultRepoId || repos[0]?.id || selected || undefined,
        repos,
        clearCredentials: SECRET_FIELDS
            .filter(({field}) => form.querySelector(`[data-secret-row="${field}"]`)?.dataset.clearPending === 'true')
            .map(({field}) => field),
        credentials: {
            openaiApiKey: form.elements.openaiApiKey.value.trim(),
            anthropicApiKey: form.elements.anthropicApiKey.value.trim(),
            googleApiKey: form.elements.googleApiKey.value.trim(),
            mistralApiKey: form.elements.mistralApiKey.value.trim()
        },
        tpmBudget: numberValue(form, 'tpmBudget'),
        logging: {
            level: textValue(form, 'logLevel'),
            pretty: checkedValue(form, 'logPretty')
        },
        models: {
            exploration: textValue(form, 'exploration'),
            synthesis: textValue(form, 'synthesis'),
            outline: textValue(form, 'outline'),
            annotation: textValue(form, 'annotation'),
            hyde: textValue(form, 'hydeModel'),
            evalFast: textValue(form, 'evalFast')
        },
        embeddings: {
            model: textValue(form, 'embeddingModel'),
            dims: numberValue(form, 'embeddingDims'),
            batch: numberValue(form, 'embeddingBatch'),
            numThreads: numberValue(form, 'embeddingNumThreads'),
            dtype: textValue(form, 'embeddingDtype'),
            queryPrefix: rawTextValue(form, 'embeddingQueryPrefix'),
            docPrefix: rawTextValue(form, 'embeddingDocPrefix'),
            cacheCap: numberValue(form, 'embeddingCacheCap')
        },
        ollamaBaseUrl: textValue(form, 'ollamaBaseUrl'),
        dependencyDocs: {enabled: checkedValue(form, 'dependencyDocsEnabled')},
        enrichment: {
            enabled: checkedValue(form, 'enrichmentEnabled'),
            model: textValue(form, 'enrichmentModel'),
            maxOutputTokens: numberValue(form, 'enrichmentMaxOutputTokens'),
            maxInputChars: numberValue(form, 'enrichmentMaxInputChars'),
            timeoutMs: numberValue(form, 'enrichmentTimeoutMs'),
            concurrency: numberValue(form, 'enrichmentConcurrency')
        },
        rerank: {
            enabled: checkedValue(form, 'rerankEnabled'),
            model: textValue(form, 'rerankModel'),
            dtype: textValue(form, 'rerankDtype'),
            candidates: numberValue(form, 'rerankCandidates'),
            numThreads: numberValue(form, 'rerankNumThreads')
        },
        hyde: {
            enabled: checkedValue(form, 'hydeEnabled'),
            timeoutMs: numberValue(form, 'hydeTimeoutMs'),
            minSimilarity: numberValue(form, 'hydeMinSimilarity')
        },
        search: {
            semanticThreshold: numberValue(form, 'searchSemanticThreshold'),
            contentMax: numberValue(form, 'searchContentMax')
        },
        fastPath: {
            similarity: numberValue(form, 'fastPathSimilarity'),
            maxResults: numberValue(form, 'fastPathMaxResults'),
            maxQuestionLen: numberValue(form, 'fastPathMaxQuestionLen')
        },
        planner: {
            throttleMs: numberValue(form, 'plannerThrottleMs'),
            explorationMaxSteps: numberValue(form, 'explorationMaxSteps'),
            explorationMaxTokens: numberValue(form, 'explorationMaxTokens'),
            explorationWallMs: numberValue(form, 'explorationWallMs'),
            componentThrottleMs: numberValue(form, 'componentThrottleMs'),
            componentMaxTokens: numberValue(form, 'componentMaxTokens'),
            outlineMaxTokens: numberValue(form, 'outlineMaxTokens'),
            componentConcurrency: numberValue(form, 'componentConcurrency'),
            componentWallMs: numberValue(form, 'componentWallMs')
        },
        annotations: {maxTokens: numberValue(form, 'annotationMaxTokens')},
        trace: {componentLimit: numberValue(form, 'traceComponentLimit')},
        chunker: {
            smallFileLines: numberValue(form, 'chunkSmallFileLines'),
            windowLines: numberValue(form, 'chunkWindowLines'),
            windowOverlap: numberValue(form, 'chunkWindowOverlap')
        },
        watcher: {
            debounceMs: numberValue(form, 'watcherDebounceMs'),
            optimizeDebounceMs: numberValue(form, 'watcherOptimizeDebounceMs')
        },
        tools: {
            readFileMaxLines: numberValue(form, 'readFileMaxLines'),
            listDirMaxEntries: numberValue(form, 'listDirMaxEntries'),
            grepMaxMatches: numberValue(form, 'grepMaxMatches'),
            grepMaxLineLen: numberValue(form, 'grepMaxLineLen'),
            grepTimeoutMs: numberValue(form, 'grepTimeoutMs')
        },
        governor: {
            windowMs: numberValue(form, 'governorWindowMs'),
            initialTokenGuess: numberValue(form, 'governorInitialTokenGuess')
        },
        answerCache: {
            cap: numberValue(form, 'answerCacheCap'),
            ttlMs: numberValue(form, 'answerCacheTtlMs')
        },
        traces: {
            ttlDays: numberValue(form, 'traceTtlDays'),
            similarMinSimilarity: numberValue(form, 'similarTraceMinSimilarity'),
            findLimit: numberValue(form, 'findTracesLimit')
        }
    };
}

function textValue(form, name) {
    const value = rawTextValue(form, name).trim();
    return value || undefined;
}

function rawTextValue(form, name) {
    return String(form.elements[name]?.value ?? '');
}

function numberValue(form, name) {
    const value = rawTextValue(form, name).trim();
    return value === '' ? undefined : Number(value);
}

function checkedValue(form, name) {
    return Boolean(form.elements[name]?.checked);
}

function updateSecretControl(form, config, {field, label}) {
    const input = form.elements[field];
    const row = form.querySelector(`[data-secret-row="${field}"]`);
    const clearButton = form.querySelector(`[data-clear-secret="${field}"]`);
    const fingerprint = form.querySelector(`[data-secret-fingerprint="${field}"]`);
    const configured = Boolean(config?.credentials?.[field]);
    const pendingClear = row?.dataset.clearPending === 'true';
    const fingerprintText = config?.credentialFingerprints?.[field] || '';

    input.placeholder = pendingClear
        ? `Save to clear ${label} key`
        : configured
            ? `Saved ${label} key configured; leave blank to keep it`
            : `Paste ${label} API key`;

    if(fingerprint) {
        fingerprint.textContent = pendingClear
            ? 'Will clear on save'
            : configured
                ? `Fingerprint ${fingerprintText || 'unavailable'}`
                : 'Not configured';
    }
    if(clearButton) {
        clearButton.disabled = !configured && !pendingClear;
    }
}

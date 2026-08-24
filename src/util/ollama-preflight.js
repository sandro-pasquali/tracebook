const OLLAMA_PREFIX = 'ollama/';

// Collect the unique Ollama model ids (prefix stripped) that the running config
// will actually use: the core LLM roles and the embedder always; HyDE only when
// enabled; enrichment only when enabled. The reranker is HuggingFace-only and is
// never an Ollama model, so it is deliberately excluded.
//
export function requiredOllamaModels(config) {
    const specs = [
        config.models.exploration,
        config.models.synthesis,
        config.models.outline,
        config.models.annotation,
        config.embeddings.model
    ];
    if(config.hyde.enabled) {
        specs.push(config.models.hyde);
    }
    if(config.enrichment.enabled) {
        specs.push(config.enrichment.model);
    }

    const ids = new Set();
    for(const spec of specs) {
        const value = String(spec || '');
        if(value.toLowerCase().startsWith(OLLAMA_PREFIX)) {
            ids.add(value.slice(OLLAMA_PREFIX.length));
        }
    }
    return [...ids];
}

// The Ollama model ids that must support tool calling: the exploration role is
// the only one that drives an agentic tool loop (the rest use structured JSON
// output). Returns [] when EXPLORATION_MODEL is a cloud spec.
//
export function requiredToolModels(config) {
    const spec = String(config.models.exploration || '');
    if(spec.toLowerCase().startsWith(OLLAMA_PREFIX)) {
        return [spec.slice(OLLAMA_PREFIX.length)];
    }
    return [];
}

// Boot preflight for local models. When any Ollama model is configured, verify
// the Ollama daemon is reachable, ensure every required model is pulled (pulling
// any that are missing), and verify that each tool-using model actually supports
// tool calling. Throws a detailed, actionable error if the daemon is
// unreachable, a pull fails, or a required model lacks tool support — surfaced as
// a runtime error rather than failing silently at first inference. A no-op when
// no Ollama model is configured (pure-cloud / HuggingFace setups are unaffected).
//
export async function ensureOllamaModels({models, toolModels, baseUrl, log, onStatus} = {}) {
    const required = Array.isArray(models) ? models : [];
    const toolRequired = Array.isArray(toolModels) ? toolModels : [];
    if(required.length === 0 && toolRequired.length === 0) {
        return;
    }

    const installed = await listInstalledModels({baseUrl});
    for(const model of required) {
        if(isInstalled(installed, model)) {
            continue;
        }
        log?.info?.({model}, 'pulling ollama model');
        onStatus?.(`Pulling ${model} via Ollama (first run can take several minutes)…`);
        await pullModel({baseUrl, model, onStatus});
        log?.info?.({model}, 'ollama model ready');
    }

    for(const model of toolRequired) {
        await assertToolSupport({baseUrl, model});
    }
}

// A configured id like "codestral" matches an installed tag "codestral" or
// "codestral:latest"; an explicit "codestral:22b" matches exactly.
//
function isInstalled(installedNames, model) {
    if(installedNames.has(model)) {
        return true;
    }
    if(!model.includes(':') && installedNames.has(`${model}:latest`)) {
        return true;
    }
    return false;
}

async function listInstalledModels({baseUrl}) {
    let response;
    try {
        response = await fetch(`${baseUrl}/api/tags`);
    } catch(error) {
        throw new Error(ollamaUnreachableMessage({baseUrl, detail: error?.message}), {cause: error});
    }
    if(!response.ok) {
        throw new Error(ollamaUnreachableMessage({baseUrl, detail: `HTTP ${response.status}`}));
    }
    const body = await response.json();
    const names = new Set();
    for(const entry of body?.models || []) {
        if(entry?.name) {
            names.add(entry.name);
        }
    }
    return names;
}

// Stream the pull so the long download can report live progress through onStatus.
// Ollama emits one JSON object per line ({status, total, completed, error}); the
// final line is {status:'success'}.
//
async function pullModel({baseUrl, model, onStatus}) {
    let response;
    try {
        response = await fetch(`${baseUrl}/api/pull`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({model, stream: true})
        });
    } catch(error) {
        throw new Error(pullFailedMessage({model, baseUrl, detail: error?.message}), {cause: error});
    }
    if(!response.ok || !response.body) {
        throw new Error(pullFailedMessage({model, baseUrl, detail: `HTTP ${response.status}`}));
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let lastKey = '';
    let lastEmit = 0;

    for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, {stream: true});
        let newline;
        while((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if(!line) {
                continue;
            }
            let event;
            try {
                event = JSON.parse(line);
            } catch {
                continue;
            }
            if(event.error) {
                throw new Error(pullFailedMessage({model, baseUrl, detail: event.error}));
            }
            const {message, key} = pullProgressText({model, event});
            const now = Date.now();
            if(key !== lastKey || now - lastEmit > 400) {
                lastKey = key;
                lastEmit = now;
                onStatus?.(message);
            }
        }
    }
}

function pullProgressText({model, event}) {
    const status = String(event.status || 'pulling');
    if(typeof event.total === 'number' && event.total > 0 && typeof event.completed === 'number') {
        const pct = Math.floor((event.completed / event.total) * 100);
        return {
            message: `Pulling ${model} — ${pct}% (${gib(event.completed)} / ${gib(event.total)})`,
            key: `${status}:${pct}`
        };
    }
    return {message: `Pulling ${model} — ${status}`, key: status};
}

function gib(bytes) {
    return `${(Number(bytes) / (1024 ** 3)).toFixed(1)} GB`;
}

// Verify a model advertises the "tools" capability via /api/show. If the daemon
// is too old to report capabilities (absent/empty), skip rather than false-block.
//
async function assertToolSupport({baseUrl, model}) {
    let response;
    try {
        response = await fetch(`${baseUrl}/api/show`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({model})
        });
    } catch(error) {
        throw new Error(ollamaUnreachableMessage({baseUrl, detail: error?.message}), {cause: error});
    }
    if(!response.ok) {
        return;
    }
    const body = await response.json().catch(() => null);
    const capabilities = body?.capabilities;
    if(!Array.isArray(capabilities) || capabilities.length === 0) {
        return;
    }
    if(!capabilities.includes('tools')) {
        throw new Error(toolUnsupportedMessage({model}));
    }
}

function toolUnsupportedMessage({model}) {
    return [
        `Ollama exploration model "${model}" does not support tool calling, which the`,
        `exploration step requires.`,
        `To fix, set the exploration model from /admin to a tool-capable model — recommended:`,
        `  ollama/<model> (agentic coding, built to explore codebases with tools).`,
        `Browse tool-capable models at https://ollama.com/search?c=tools.`
    ].join('\n');
}

function ollamaUnreachableMessage({baseUrl, detail}) {
    return [
        `Ollama is not reachable at ${baseUrl} (${detail || 'connection failed'}).`,
        `A model is configured with the "ollama/" provider, so a local Ollama daemon is required.`,
        `To fix, either:`,
        `  1. Install Ollama from https://ollama.com/download and start it with "ollama serve", or`,
        `  2. Switch the affected model values from /admin back to a cloud provider`,
        `     (e.g. openai/gpt-4.1-mini). Set the Ollama base URL in /admin if your daemon runs on a non-default address.`
    ].join('\n');
}

function pullFailedMessage({model, baseUrl, detail}) {
    return [
        `Failed to pull Ollama model "${model}" from ${baseUrl} (${detail || 'unknown error'}).`,
        `To fix, either:`,
        `  1. Pull it manually with "ollama pull ${model}" and confirm the model name exists at`,
        `     https://ollama.com/library, then check available disk space and network access, or`,
        `  2. Point the relevant /admin model value at a model you already have, or a cloud provider.`
    ].join('\n');
}

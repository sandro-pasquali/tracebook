import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureOllamaModels, requiredOllamaModels, requiredToolModels} from '../../src/util/ollama-preflight.js';

function makeConfig(overrides = {}) {
    return {
        models: {
            exploration: 'ollama/codestral',
            synthesis: 'ollama/codestral',
            outline: 'ollama/codestral',
            annotation: 'ollama/codestral',
            hyde: 'ollama/codestral'
        },
        embeddings: {model: 'jinaai/jina-embeddings-v2-base-code'},
        hyde: {enabled: false},
        enrichment: {enabled: false, model: 'ollama/codestral'},
        ...overrides
    };
}

// Install a fake global fetch for the duration of fn, returning the recorded calls.
//
async function withFetch(handler, fn) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        calls.push({url, options});
        return handler(url, options);
    };
    try {
        await fn(calls);
    } finally {
        globalThis.fetch = original;
    }
}

function jsonResponse(body, {ok = true, status = 200} = {}) {
    return {ok, status, json: async () => body};
}

// A streamed /api/pull response: each entry is one NDJSON line in the body.
//
function streamResponse(lines, {ok = true, status = 200} = {}) {
    async function* body() {
        const encoder = new TextEncoder();
        for(const line of lines) {
            yield encoder.encode(JSON.stringify(line) + '\n');
        }
    }
    return {ok, status, body: body()};
}

test('requiredOllamaModels collects ollama ids, dedupes, and excludes the HF embedder', () => {
    const models = requiredOllamaModels(makeConfig());
    assert.deepEqual(models, ['codestral']);
});

test('requiredOllamaModels includes hyde/enrichment only when enabled, and the ollama embedder', () => {
    const config = makeConfig({
        models: {
            exploration: 'openai/gpt-4.1-mini',
            synthesis: 'ollama/llama3',
            outline: 'ollama/llama3',
            annotation: 'openai/gpt-4o-mini',
            hyde: 'ollama/qwen2.5-coder'
        },
        embeddings: {model: 'ollama/nomic-embed-code'},
        hyde: {enabled: true},
        enrichment: {enabled: false, model: 'ollama/should-not-appear'}
    });
    const models = requiredOllamaModels(config).sort();
    assert.deepEqual(models, ['llama3', 'nomic-embed-code', 'qwen2.5-coder']);
});

test('ensureOllamaModels is a no-op (no network) when no ollama model is configured', async () => {
    await withFetch(
        () => {
            throw new Error('fetch should not be called');
        },
        async (calls) => {
            await ensureOllamaModels({models: [], baseUrl: 'http://127.0.0.1:11434'});
            assert.equal(calls.length, 0);
        }
    );
});

test('ensureOllamaModels throws an actionable error when the daemon is unreachable', async () => {
    await withFetch(
        () => {
            throw new Error('ECONNREFUSED');
        },
        async () => {
            await assert.rejects(
                ensureOllamaModels({models: ['codestral'], baseUrl: 'http://127.0.0.1:11434'}),
                /not reachable[\s\S]*ollama\.com\/download/
            );
        }
    );
});

test('ensureOllamaModels pulls only the missing models', async () => {
    await withFetch(
        (url, options) => {
            if(String(url).endsWith('/api/tags')) {
                return jsonResponse({models: [{name: 'codestral:latest'}]});
            }
            if(String(url).endsWith('/api/pull')) {
                assert.equal(options.method, 'POST');
                return streamResponse([{status: 'pulling'}, {status: 'success'}]);
            }
            throw new Error(`unexpected url ${url}`);
        },
        async (calls) => {
            await ensureOllamaModels({models: ['codestral', 'mistral'], baseUrl: 'http://127.0.0.1:11434'});
            const pulls = calls.filter((c) => String(c.url).endsWith('/api/pull'));
            assert.equal(pulls.length, 1);
            assert.equal(JSON.parse(pulls[0].options.body).model, 'mistral');
        }
    );
});

test('ensureOllamaModels streams pull progress and completes on success', async () => {
    const statuses = [];
    await withFetch(
        (url) => {
            if(String(url).endsWith('/api/tags')) {
                return jsonResponse({models: []});
            }
            if(String(url).endsWith('/api/pull')) {
                return streamResponse([
                    {status: 'pulling manifest'},
                    {status: 'pulling', total: 1000, completed: 250},
                    {status: 'pulling', total: 1000, completed: 1000},
                    {status: 'success'}
                ]);
            }
            throw new Error(`unexpected url ${url}`);
        },
        async () => {
            await ensureOllamaModels({
                models: ['devstral'],
                baseUrl: 'http://127.0.0.1:11434',
                onStatus: (message) => statuses.push(message)
            });
            assert.ok(statuses.some((s) => s.includes('25%')), `expected a 25% update, got: ${statuses.join(' | ')}`);
            assert.ok(statuses.some((s) => s.includes('100%')), `expected a 100% update, got: ${statuses.join(' | ')}`);
        }
    );
});

test('ensureOllamaModels throws when a streamed pull line reports an error', async () => {
    await withFetch(
        (url) => {
            if(String(url).endsWith('/api/tags')) {
                return jsonResponse({models: []});
            }
            if(String(url).endsWith('/api/pull')) {
                return streamResponse([{status: 'pulling'}, {error: 'no space left on device'}]);
            }
            throw new Error(`unexpected url ${url}`);
        },
        async () => {
            await assert.rejects(
                ensureOllamaModels({models: ['big'], baseUrl: 'http://127.0.0.1:11434'}),
                /Failed to pull Ollama model "big"[\s\S]*no space left on device/
            );
        }
    );
});

test('requiredToolModels returns the exploration model only when it is an ollama spec', () => {
    assert.deepEqual(requiredToolModels(makeConfig()), ['codestral']);
    const cloud = makeConfig({models: {...makeConfig().models, exploration: 'openai/gpt-4.1-mini'}});
    assert.deepEqual(requiredToolModels(cloud), []);
});

test('ensureOllamaModels passes when the tool model advertises the tools capability', async () => {
    await withFetch(
        (url) => {
            if(String(url).endsWith('/api/tags')) {
                return jsonResponse({models: [{name: 'devstral:latest'}]});
            }
            if(String(url).endsWith('/api/show')) {
                return jsonResponse({capabilities: ['completion', 'tools']});
            }
            throw new Error(`unexpected url ${url}`);
        },
        async () => {
            await ensureOllamaModels({
                models: ['devstral'],
                toolModels: ['devstral'],
                baseUrl: 'http://127.0.0.1:11434'
            });
        }
    );
});

test('ensureOllamaModels throws an actionable error when the tool model lacks tools support', async () => {
    await withFetch(
        (url) => {
            if(String(url).endsWith('/api/tags')) {
                return jsonResponse({models: [{name: 'codestral:latest'}]});
            }
            if(String(url).endsWith('/api/show')) {
                return jsonResponse({capabilities: ['completion', 'insert']});
            }
            throw new Error(`unexpected url ${url}`);
        },
        async () => {
            await assert.rejects(
                ensureOllamaModels({
                    models: ['codestral'],
                    toolModels: ['codestral'],
                    baseUrl: 'http://127.0.0.1:11434'
                }),
                /does not support tool calling[\s\S]*tool-capable model/
            );
        }
    );
});

test('ensureOllamaModels skips the tools check when the daemon reports no capabilities', async () => {
    await withFetch(
        (url) => {
            if(String(url).endsWith('/api/tags')) {
                return jsonResponse({models: [{name: 'codestral:latest'}]});
            }
            if(String(url).endsWith('/api/show')) {
                return jsonResponse({capabilities: []});
            }
            throw new Error(`unexpected url ${url}`);
        },
        async () => {
            await ensureOllamaModels({
                models: ['codestral'],
                toolModels: ['codestral'],
                baseUrl: 'http://127.0.0.1:11434'
            });
        }
    );
});

test('ensureOllamaModels throws an actionable error when a pull fails', async () => {
    await withFetch(
        (url) => {
            if(String(url).endsWith('/api/tags')) {
                return jsonResponse({models: []});
            }
            return jsonResponse({error: 'model not found'}, {ok: false, status: 404});
        },
        async () => {
            await assert.rejects(
                ensureOllamaModels({models: ['nope'], baseUrl: 'http://127.0.0.1:11434'}),
                /Failed to pull Ollama model "nope"[\s\S]*ollama pull nope/
            );
        }
    );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REQUEST_MARKER_HEADERS = {'x-tracebook-request': '1'};
const JSON_REQUEST_HEADERS = {
    'content-type': 'application/json',
    ...REQUEST_MARKER_HEADERS
};

test('server runtime status endpoint responds without starting the indexer', async () => {
    const {default: app} = await import('../../src/server.js');

    const response = await app.request('/api/runtime/status');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.runtime.state, 'idle');
    assert.equal(body.runtime.stage, 'idle');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('runtime-dependent GET routes do not start an idle runtime', async () => {
    const {default: app} = await import('../../src/server.js');

    const health = await app.request('/api/health');
    const healthBody = await health.json();
    assert.equal(health.status, 503);
    assert.equal(healthBody.error, 'runtime_initializing');

    const codebase = await app.request('/api/codebase');
    assert.equal(codebase.status, 503);

    const status = await app.request('/api/runtime/status');
    const statusBody = await status.json();
    assert.equal(statusBody.runtime.state, 'idle');
    assert.equal(statusBody.runtime.stage, 'idle');
});

test('server rejects legacy runtime startup through GET', async () => {
    const {default: app} = await import('../../src/server.js');
    const response = await app.request('/api/runtime/status?start=1');
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, 'invalid_request');
    assert.equal(body.part, 'query');
});

test('server starts the runtime only through the marked POST endpoint', () => {
    const result = spawnSync(process.execPath, [
        '--input-type=module',
        '--eval',
        [
            `globalThis.__TRACEBOOK_CONFIG_PATH__ = ${JSON.stringify(globalThis.__TRACEBOOK_CONFIG_PATH__)};`,
            'globalThis[Symbol.for("tracebook.runtime")] = new Promise(() => {});',
            'const {default: app} = await import("./src/server.js");',
            'const options = {method: "POST", headers: {"x-tracebook-request": "1"}};',
            'const first = await app.request("/api/runtime/start", options);',
            'const firstBody = await first.json();',
            'const second = await app.request("/api/runtime/start", options);',
            'const secondBody = await second.json();',
            'const status = await app.request("/api/runtime/status");',
            'const statusBody = await status.json();',
            'console.log(JSON.stringify({first: first.status, firstBody, second: second.status, secondBody, status: status.status, statusBody}));'
        ].join(' ')
    ], {
        cwd: process.cwd(),
        encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr);
    const jsonLine = result.stdout.trim().split(/\n/u).findLast((line) => line.trim().startsWith('{'));
    const payload = JSON.parse(jsonLine);
    assert.equal(payload.first, 200);
    assert.equal(payload.firstBody.runtime.state, 'initializing');
    assert.equal(payload.second, 200);
    assert.equal(payload.secondBody.runtime.state, 'initializing');
    assert.equal(payload.status, 200);
    assert.equal(payload.statusBody.runtime.state, 'initializing');
});

test('server runtime start reports setup required before admin config exists', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tracebook-server-setup-'));
    const configPath = path.join(root, 'missing-config.json');
    try {
        const result = spawnSync(process.execPath, [
            '--input-type=module',
            '--eval',
            [
                `globalThis.__TRACEBOOK_CONFIG_PATH__ = ${JSON.stringify(configPath)};`,
                'const {default: app} = await import("./src/server.js");',
                'const response = await app.request("/api/runtime/start", {method: "POST", headers: {"x-tracebook-request": "1"}});',
                'const body = await response.json();',
                'console.log(JSON.stringify({status: response.status, body}));'
            ].join(' ')
        ], {
            cwd: process.cwd(),
            encoding: 'utf8',
        });

        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stderr, /OPENAI_API_KEY/v);
        const jsonLine = result.stdout.trim().split(/\n/u).findLast((line) => line.trim().startsWith('{'));
        const payload = JSON.parse(jsonLine);

        assert.equal(payload.status, 200);
        assert.equal(payload.body.setupRequired, true);
        assert.equal(payload.body.runtime.stage, 'setup_required');
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test('server rejects untrusted hosts, origins, and unmarked mutations', async () => {
    const {default: app} = await import('../../src/server.js');

    const untrustedHost = await app.request('http://attacker.example/api/team/config');
    assert.equal(untrustedHost.status, 421);
    assert.deepEqual(await untrustedHost.json(), {error: 'invalid_request_host'});

    const untrustedOrigin = await app.request('http://localhost/api/team/config', {
        headers: {origin: 'http://attacker.example'}
    });
    assert.equal(untrustedOrigin.status, 403);
    assert.deepEqual(await untrustedOrigin.json(), {error: 'forbidden_request_origin'});

    const unmarked = await app.request('/api/stories', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: '{}'
    });
    assert.equal(unmarked.status, 403);
    assert.deepEqual(await unmarked.json(), {error: 'missing_request_marker'});
});

test('server rejects malformed story save requests', async () => {
    const {default: app} = await import('../../src/server.js');

    const response = await app.request('/api/stories', {
        method: 'POST',
        body: '{',
        headers: JSON_REQUEST_HEADERS,
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, 'invalid_json');
});

test('server rejects story payloads that do not match the request contract', async () => {
    const {default: app} = await import('../../src/server.js');

    const response = await app.request('/api/stories', {
        method: 'POST',
        body: JSON.stringify({
            storyId: 'story_contract_bad',
            title: 'Contract Bad',
            chapters: [],
            sourcePaths: [],
            unexpected: true,
        }),
        headers: JSON_REQUEST_HEADERS,
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, 'invalid_story_payload');
    assert.equal(body.part, 'body');
    assert.ok(body.issues.some((issue) => issue.code === 'unrecognized_keys'));
});

test('server rejects invalid query and route params at the contract boundary', async () => {
    const {default: app} = await import('../../src/server.js');

    const badLimit = await app.request('/api/stories?limit=0');
    const badLimitBody = await badLimit.json();

    assert.equal(badLimit.status, 400);
    assert.equal(badLimitBody.error, 'invalid_request');
    assert.equal(badLimitBody.part, 'query');

    const badTrace = await app.request('/api/traces/not-a-trace');
    const badTraceBody = await badTrace.json();

    assert.equal(badTrace.status, 400);
    assert.equal(badTraceBody.error, 'invalid_trace_id');
    assert.equal(badTraceBody.part, 'params');
});

test('server rejects undeclared and duplicate query parameters', async () => {
    const {default: app} = await import('../../src/server.js');

    const undeclared = await app.request('/api/health?debug=1');
    const undeclaredBody = await undeclared.json();

    assert.equal(undeclared.status, 400);
    assert.equal(undeclaredBody.error, 'invalid_request');
    assert.equal(undeclaredBody.part, 'query');
    assert.ok(undeclaredBody.issues.some((issue) => issue.code === 'unrecognized_keys'));

    const duplicate = await app.request('/api/stories?limit=10&limit=20');
    const duplicateBody = await duplicate.json();

    assert.equal(duplicate.status, 400);
    assert.equal(duplicateBody.error, 'invalid_request');
    assert.equal(duplicateBody.part, 'query');
    assert.ok(duplicateBody.issues.some((issue) => issue.path === 'limit'));
});

test('server rejects JSON routes without a JSON content type', async () => {
    const {default: app} = await import('../../src/server.js');

    const response = await app.request('/api/stories', {
        method: 'POST',
        body: JSON.stringify({chapters: []}),
        headers: {'content-type': 'text/plain', ...REQUEST_MARKER_HEADERS},
    });
    const body = await response.json();

    assert.equal(response.status, 415);
    assert.equal(body.error, 'unsupported_media_type');
});

test('server does not expose a code image endpoint', async () => {
    const {default: app} = await import('../../src/server.js');

    const response = await app.request('/api/code-to-image', {
        method: 'POST',
        body: JSON.stringify({code: 'const local = true;'}),
        headers: JSON_REQUEST_HEADERS,
    });

    assert.equal(response.status, 404);
});

test('server rejects trace simulation payloads at the contract boundary', async () => {
    const {default: app} = await import('../../src/server.js');

    const response = await app.request('/api/traces/trc_test_123abc/simulate', {
        method: 'POST',
        body: JSON.stringify({condition: '', unexpected: true}),
        headers: JSON_REQUEST_HEADERS,
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, 'invalid_request');
    assert.equal(body.part, 'body');
    assert.ok(body.issues.some((issue) => issue.path === 'condition'));
    assert.ok(body.issues.some((issue) => issue.code === 'unrecognized_keys'));
});

test('server returns local source files as plain text', async () => {
    const {default: app} = await import('../../src/server.js');

    const response = await app.request(sourceFileUrl('package.json'));
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain/v);
    assert.equal(response.headers.get('x-source-path'), 'package.json');
    assert.ok(Number(response.headers.get('x-source-bytes')) > 0);
    assert.match(body, /"scripts"/v);

    const rejected = await app.request(sourceFileUrl('not-a-real-file.js'));
    const rejectedBody = await rejected.text();

    assert.equal(rejected.status, 404);
    assert.equal(rejectedBody, 'not_found');
});

test('server rejects oversized source preview before returning content', async () => {
    const fixturePath = path.join(process.cwd(), 'too-large-source.js');
    await fs.writeFile(fixturePath, `${'x'.repeat(1_000_001)}\n`);
    try {
        const {default: app} = await import('../../src/server.js');

        const response = await app.request(sourceFileUrl('too-large-source.js'));
        const body = await response.text();

        assert.equal(response.status, 413);
        assert.equal(body, 'too_large:1000000');
    } finally {
        await fs.rm(fixturePath, {force: true});
    }
});

test('server source file endpoint rejects index-excluded physical paths', async () => {
    const {default: app} = await import('../../src/server.js');

    for(const path of ['.env', 'data/not-real.txt', '.git/config', 'test/unit/config.test.js']) {
        const response = await app.request(sourceFileUrl(path));
        const body = await response.text();

        assert.equal(response.status, 403);
        assert.equal(body, 'path_excluded');
    }
});

test('server source file endpoint rejects escaped and malformed paths', async () => {
    const {default: app} = await import('../../src/server.js');

    for(const path of ['../package.json', '..\\package.json']) {
        const response = await app.request(sourceFileUrl(path));
        const body = await response.text();

        assert.equal(response.status, 400);
        assert.equal(body, 'path_escape');
    }

    const malformed = await app.request('/api/source-file/not%25valid');
    const malformedBody = await malformed.text();

    assert.equal(malformed.status, 400);
    assert.equal(malformedBody, 'bad_source_token');
});

test('server source file endpoint refuses symlinks inside the repository', async (t) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-server-source-outside-'));
    const outsideFile = path.join(outside, 'outside.js');
    const fixturePath = path.join(process.cwd(), 'source-symlink-fixture.js');
    await fs.writeFile(outsideFile, 'export const shouldNeverBeReturned = true;\n');
    try {
        try {
            await fs.symlink(outsideFile, fixturePath, 'file');
        } catch(err) {
            if(err?.code === 'EPERM' || err?.code === 'EACCES') {
                t.skip(`symlinks unavailable: ${err.code}`);
                return;
            }
            throw err;
        }
        const {default: app} = await import('../../src/server.js');

        const response = await app.request(sourceFileUrl('source-symlink-fixture.js'));
        const body = await response.text();

        assert.equal(response.status, 403);
        assert.equal(body, 'symlink_excluded');
        assert.doesNotMatch(body, /shouldNeverBeReturned/v);
    } finally {
        await fs.rm(fixturePath, {force: true});
        await fs.rm(outside, {recursive: true, force: true});
    }
});

test('server returns virtual dependency source documents as plain text', async () => {
    const {default: app} = await import('../../src/server.js');

    // hono is a runtime dependency; dependency docs cover runtime deps (dev deps
    // like vite are intentionally excluded).
    //
    const response = await app.request(sourceFileUrl('__dependencies__/npm/hono.md'));
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain/v);
    assert.equal(response.headers.get('x-source-path'), '__dependencies__/npm/hono.md');
    assert.match(body, /^# Dependency: hono/v);
});

test('server marks stories stale from local file fingerprints without starting runtime indexing', async () => {
    const fixturePath = path.join(process.cwd(), 'stale-story-fixture.tmp.js');
    await fs.writeFile(fixturePath, 'export const value = 1;\n');
    try {
        const {default: app} = await import('../../src/server.js');

        const saveResponse = await app.request('/api/stories', {
            method: 'POST',
            headers: JSON_REQUEST_HEADERS,
            body: JSON.stringify({
                storyId: 'story_test_stale',
                title: 'Stale Story',
                chapters: [{question: 'What uses the fixture?'}],
                sourcePaths: ['stale-story-fixture.tmp.js'],
            }),
        });
        const saved = await saveResponse.json();

        assert.equal(saveResponse.status, 200);
        assert.equal(saved.freshness.state, 'current');
        assert.deepEqual(saved.freshness.changedPaths, []);

        const currentResponse = await app.request('/api/stories/story_test_stale');
        const current = await currentResponse.json();

        assert.equal(currentResponse.status, 200);
        assert.equal(current.freshness.state, 'current');

        await fs.writeFile(fixturePath, 'export const value = 2;\n');

        const staleResponse = await app.request('/api/stories/story_test_stale');
        const stale = await staleResponse.json();

        assert.equal(staleResponse.status, 200);
        assert.equal(stale.freshness.state, 'stale');
        assert.deepEqual(stale.freshness.changedPaths, ['stale-story-fixture.tmp.js']);

        const listResponse = await app.request('/api/stories?limit=100');
        const list = await listResponse.json();
        const listed = list.stories.find((story) => story.storyId === 'story_test_stale');

        assert.equal(listResponse.status, 200);
        assert.equal(listed.title, 'Stale Story');
        assert.equal(listed.chapterCount, 1);
        assert.equal(listed.freshness, undefined);

        const runtimeResponse = await app.request('/api/runtime/status');
        const runtime = await runtimeResponse.json();

        assert.equal(runtimeResponse.status, 200);
        assert.equal(runtime.runtime.state, 'idle');
    } finally {
        await fs.rm(fixturePath, {force: true});
        const {default: app} = await import('../../src/server.js');
        await app.request('/api/stories/story_test_stale', {
            method: 'DELETE',
            headers: REQUEST_MARKER_HEADERS
        });
    }
});

test('server serves the app shell for direct story route segments', async () => {
    const {default: app} = await import('../../src/server.js');
    const response = await app.request('/story_test_stale');
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/v);
    assert.match(body, /id="status-pill"/v);
});

function sourceFileUrl(path) {
    return `/api/source-file/${Buffer.from(path, 'utf8').toString('base64url')}`;
}

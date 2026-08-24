import test from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {
    enforceHttpBoundary,
    isLoopbackHostname,
    parseLoopbackAuthority,
    TRACEBOOK_REQUEST_HEADER
} from '../../src/server/http-boundary.js';

test('loopback parsing accepts only the released host forms', () => {
    for(const hostname of ['localhost', 'LOCALHOST', '127.0.0.1', '::1']) {
        assert.equal(isLoopbackHostname(hostname), true);
    }
    for(const hostname of ['', '0.0.0.0', '127.1', 'localhost.', 'dev.localhost', '[::1]']) {
        assert.equal(isLoopbackHostname(hostname), false);
    }

    assert.deepEqual(parseLoopbackAuthority('localhost:5173'), {
        hostname: 'localhost',
        port: '5173',
        authority: 'localhost:5173'
    });
    assert.deepEqual(parseLoopbackAuthority('[::1]:3000'), {
        hostname: '::1',
        port: '3000',
        authority: '[::1]:3000'
    });
    for(const authority of [
        '',
        'localhost:0',
        'localhost:65536',
        'localhost, attacker.example',
        '127.0.0.1.example.com',
        '[::1',
        '::1'
    ]) {
        assert.equal(parseLoopbackAuthority(authority), null);
    }
});

test('HTTP boundary accepts loopback request hosts and rejects all other authorities', async () => {
    const app = boundaryApp();

    for(const url of [
        'http://localhost/api/value',
        'http://127.0.0.1:4173/api/value',
        'http://[::1]:3000/api/value'
    ]) {
        const response = await app.request(url);
        assert.equal(response.status, 200, url);
    }

    for(const url of [
        'http://attacker.example/api/value',
        'http://localhost.example.com/api/value',
        'http://192.168.1.10/api/value'
    ]) {
        const response = await app.request(url);
        assert.equal(response.status, 421, url);
        assert.deepEqual(await response.json(), {error: 'invalid_request_host'});
    }

    for(const host of ['attacker.example', 'localhost, attacker.example', 'localhost:65536']) {
        const response = await app.request('http://localhost/api/value', {headers: {host}});
        assert.equal(response.status, 421, host);
    }
});

test('HTTP boundary requires an exact same-origin browser context', async () => {
    const app = boundaryApp();
    const sameOrigin = await app.request('http://localhost:3000/api/value', {
        headers: {
            host: 'localhost:3000',
            origin: 'http://localhost:3000',
            'sec-fetch-site': 'same-origin'
        }
    });
    assert.equal(sameOrigin.status, 200);

    const wrongOrigin = await app.request('http://localhost:3000/api/value', {
        headers: {origin: 'http://attacker.example'}
    });
    assert.equal(wrongOrigin.status, 403);
    assert.deepEqual(await wrongOrigin.json(), {error: 'forbidden_request_origin'});

    for(const fetchSite of ['cross-site', 'same-site', 'unexpected']) {
        const response = await app.request('http://localhost/api/value', {
            headers: {'sec-fetch-site': fetchSite}
        });
        assert.equal(response.status, 403, fetchSite);
        assert.deepEqual(await response.json(), {error: 'forbidden_request_site'});
    }
});

test('HTTP boundary requires the Tracebook marker on unsafe methods', async () => {
    const app = boundaryApp();

    const missing = await app.request('http://localhost/api/value', {method: 'POST'});
    assert.equal(missing.status, 403);
    assert.deepEqual(await missing.json(), {error: 'missing_request_marker'});

    const wrong = await app.request('http://localhost/api/value', {
        method: 'POST',
        headers: {[TRACEBOOK_REQUEST_HEADER]: 'wrong'}
    });
    assert.equal(wrong.status, 403);

    const marked = await app.request('http://localhost/api/value', {
        method: 'POST',
        headers: {
            origin: 'http://localhost',
            'sec-fetch-site': 'same-origin',
            [TRACEBOOK_REQUEST_HEADER]: '1'
        }
    });
    assert.equal(marked.status, 200);
    assert.deepEqual(await marked.json(), {ok: true});
});

test('HTTP boundary adds security headers and disables API caching', async () => {
    const app = boundaryApp();
    const response = await app.request('http://localhost/api/value');

    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
});

function boundaryApp() {
    const app = new Hono();
    app.use('*', enforceHttpBoundary);
    app.get('/api/value', (c) => c.json({ok: true}));
    app.post('/api/value', (c) => c.json({ok: true}));
    return app;
}

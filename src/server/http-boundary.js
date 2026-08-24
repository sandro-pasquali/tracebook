export const TRACEBOOK_REQUEST_HEADER = 'x-tracebook-request';
export const TRACEBOOK_REQUEST_HEADER_VALUE = '1';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_FETCH_SITES = new Set(['none', 'same-origin']);
const RESPONSE_HEADERS = {
    'content-security-policy': "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
};

export function isLoopbackHostname(value) {
    if(typeof value !== 'string') {
        return false;
    }
    const hostname = value.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function parseLoopbackAuthority(value) {
    if(typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
        return null;
    }
    let match = /^(localhost|127\.0\.0\.1)(?::([0-9]{1,5}))?$/iu.exec(value);
    let hostname;
    let port;
    if(match) {
        hostname = match[1].toLowerCase();
        port = match[2] || '';
    } else {
        match = /^\[::1\](?::([0-9]{1,5}))?$/u.exec(value);
        if(!match) {
            return null;
        }
        hostname = '::1';
        port = match[1] || '';
    }
    if(port && (Number(port) < 1 || Number(port) > 65535)) {
        return null;
    }
    const host = hostname === '::1' ? '[::1]' : hostname;
    return {
        hostname,
        port,
        authority: port ? `${host}:${port}` : host
    };
}

export async function enforceHttpBoundary(c, next) {
    applyResponseHeaders(c);

    const requestOrigin = resolveRequestOrigin(c);
    if(!requestOrigin) {
        return c.json({error: 'invalid_request_host'}, 421);
    }

    const suppliedOrigin = c.req.header('origin');
    if(suppliedOrigin && parseOrigin(suppliedOrigin) !== requestOrigin) {
        return c.json({error: 'forbidden_request_origin'}, 403);
    }

    const fetchSite = c.req.header('sec-fetch-site')?.toLowerCase();
    if(fetchSite && !ALLOWED_FETCH_SITES.has(fetchSite)) {
        return c.json({error: 'forbidden_request_site'}, 403);
    }

    if(UNSAFE_METHODS.has(c.req.method.toUpperCase()) &&
        c.req.header(TRACEBOOK_REQUEST_HEADER) !== TRACEBOOK_REQUEST_HEADER_VALUE) {
        return c.json({error: 'missing_request_marker'}, 403);
    }

    await next();
}

function resolveRequestOrigin(c) {
    let url;
    try {
        url = new URL(c.req.url);
    } catch {
        return null;
    }
    if(url.username || url.password || !parseLoopbackAuthority(url.host)) {
        return null;
    }

    const hostHeader = c.req.header('host');
    if(!hostHeader) {
        return url.origin;
    }
    const host = parseLoopbackAuthority(hostHeader);
    if(!host) {
        return null;
    }
    let headerOrigin;
    try {
        headerOrigin = new URL(`${url.protocol}//${host.authority}`).origin;
    } catch {
        return null;
    }
    return headerOrigin === url.origin ? headerOrigin : null;
}

function parseOrigin(value) {
    let origin;
    try {
        origin = new URL(value);
    } catch {
        return null;
    }
    if(origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
        return null;
    }
    return parseLoopbackAuthority(origin.host) ? origin.origin : null;
}

function applyResponseHeaders(c) {
    for(const [name, value] of Object.entries(RESPONSE_HEADERS)) {
        c.header(name, value);
    }
    if(c.req.path === '/api' || c.req.path.startsWith('/api/')) {
        c.header('cache-control', 'no-store');
    }
}

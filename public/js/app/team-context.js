const SELECTED_REPO_KEY = 'tracebook-selected-repo';
const REPO_HEADER = 'x-tracebook-repo';
const REQUEST_HEADER = 'x-tracebook-request';

export function selectedRepoId() {
    const href = globalThis.location?.href || 'http://localhost/';
    const fromUrl = new URL(href).searchParams.get('repo');
    if(fromUrl) {
        return fromUrl;
    }
    try {
        return localStorage.getItem(SELECTED_REPO_KEY) || '';
    } catch {
        return '';
    }
}

export function setSelectedRepoId(repoId) {
    const value = String(repoId || '').trim();
    try {
        if(value) {
            localStorage.setItem(SELECTED_REPO_KEY, value);
        } else {
            localStorage.removeItem(SELECTED_REPO_KEY);
        }
    } catch {}
}

export async function ensureRepoSelected() {
    if(location.pathname === '/repos' || location.pathname === '/admin') {
        return true;
    }
    let payload;
    try {
        const res = await apiFetch('/api/team/config', {headers: {accept: 'application/json'}});
        if(!res.ok) {
            return true;
        }
        payload = await res.json();
    } catch {
        return true;
    }
    if(payload?.exists === false) {
        location.href = '/admin';
        return false;
    }
    const repos = Array.isArray(payload?.repos) ? payload.repos : [];
    if(repos.length === 0) {
        return true;
    }
    const current = selectedRepoId();
    if(current && repos.some((repo) => repo.id === current)) {
        return true;
    }
    if(repos.length === 1) {
        setSelectedRepoId(repos[0].id);
        return true;
    }
    location.href = '/repos';
    return false;
}

export function apiFetch(url, options = {}) {
    return fetch(url, withApiHeaders(options));
}

export function withApiHeaders(options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set(REQUEST_HEADER, '1');
    const repoId = selectedRepoId();
    if(repoId) {
        headers.set(REPO_HEADER, repoId);
    }
    return {
        ...options,
        headers
    };
}

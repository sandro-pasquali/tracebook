const STORY_ROUTE_RE = /^\/(story_[a-z0-9]+(?:_[a-z0-9]+)?)\/?$/;

export function storyIdFromLocation() {
    return storyIdFromUrl(new URL(location.href));
}

export function storyIdFromUrl(url) {
    return storyIdFromPathname(url.pathname);
}

export function storyIdFromPathname(pathname) {
    return STORY_ROUTE_RE.exec(pathname)?.[1] || '';
}

export function writeStoryUrl(storyId) {
    const value = String(storyId || '').trim();
    if(!value) {
        return;
    }
    const url = new URL(location.href);
    url.pathname = `/${encodeURIComponent(value)}`;
    url.searchParams.delete('story');
    url.searchParams.delete('trace');
    history.replaceState(null, '', url);
}

export function clearStoryUrl(storyId = '') {
    const url = new URL(location.href);
    const routeStoryId = storyIdFromPathname(url.pathname);
    const expected = String(storyId || '').trim();
    if(expected && routeStoryId !== expected) {
        return false;
    }
    if(routeStoryId) {
        url.pathname = '/';
    }
    url.searchParams.delete('story');
    history.replaceState(null, '', url);
    return true;
}

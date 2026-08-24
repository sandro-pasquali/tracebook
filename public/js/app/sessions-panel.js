import {apiFetch} from './team-context.js';
import {clearStoryUrl, storyIdFromLocation} from './story-url.js';

export function createSessionsPanel({
    button,
    panel,
    closeButton,
    searchInput,
    list,
    onLoadTrace,
    onLoadStory,
    onShowError,
    onOpenChange,
    onNavigateAway,
    getCurrentStoryId,
    onStoryDeleted,
    onSummariesChange
} = {}) {
    const deletingStoryIds = new Set();
    let activeDeleteConfirm = null;
    let savedStorySummaries = null;
    let renderedSignature = '';
    let navigationInFlight = false;
    let loadingStoryId = '';
    let searchQuery = '';

    function init() {
        if(!button || !panel || !closeButton || !list) {
            return false;
        }
        button.addEventListener('click', async () => {
            const open = panel.getAttribute('aria-hidden') !== 'false';
            setOpen(open);
            if(open) {
                await loadList();
            }
        });
        closeButton.addEventListener('click', () => setOpen(false));
        searchInput?.addEventListener('input', () => {
            searchQuery = searchInput.value.trim().toLowerCase();
            renderList(savedStorySummaries || []);
        });
        return true;
    }

    function setOpen(open) {
        if(!open) {
            clearDeleteConfirm();
        }
        panel.setAttribute('aria-hidden', String(!open));
        panel.classList.toggle('is-open', open);
        button.setAttribute('aria-pressed', String(open));
        if(open) {
            window.setTimeout(() => searchInput?.focus(), 0);
        }
        onOpenChange?.();
    }

    function isOpen() {
        return Boolean(panel?.classList.contains('is-open'));
    }

    function invalidate() {
        savedStorySummaries = null;
    }

    async function loadList({showLoading = true} = {}) {
        if(showLoading) {
            clearDeleteConfirm();
            renderedSignature = '';
            renderEmpty('Loading stories...');
        }
        let sessions;
        try {
            sessions = await fetchSummaries({force: true});
        } catch(err) {
            renderedSignature = '';
            list.innerHTML = '';
            const error = document.createElement('div');
            error.className = 'sessions-empty';
            error.textContent = err?.message || 'Could not load previous stories.';
            list.appendChild(error);
            return;
        }

        renderList(sessions, {skipSignature: false});
    }

    function renderList(sessions, {skipSignature = true} = {}) {
        const filtered = filterStories(sessions);
        const nextSignature = signature(sessions);
        if(!skipSignature && nextSignature === renderedSignature) {
            return;
        }
        clearDeleteConfirm();
        renderedSignature = nextSignature;
        list.innerHTML = '';
        if(sessions.length === 0) {
            renderEmpty('No saved stories yet.');
            return;
        }
        if(filtered.length === 0) {
            renderEmpty('No matching stories.');
            return;
        }

        for(const session of filtered) {
            list.appendChild(renderItem(session));
        }
    }

    function renderEmpty(message) {
        list.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'sessions-empty';
        empty.textContent = message;
        list.appendChild(empty);
    }

    function filterStories(sessions) {
        if(!searchQuery) {
            return sessions;
        }
        return sessions.filter((session) => searchableText(session).includes(searchQuery));
    }

    function searchableText(session) {
        const paths = Array.isArray(session.sourcePaths) ? session.sourcePaths.join(' ') : '';
        return [
            session.title,
            session.lastQuestion,
            session.question,
            session.storyId,
            paths
        ].filter(Boolean).join(' ').toLowerCase();
    }

    async function fetchSummaries({force = false} = {}) {
        if(savedStorySummaries && !force) {
            return savedStorySummaries;
        }
        const res = await apiFetch('/api/stories?limit=100');
        if(!res.ok) {
            throw new Error(`sessions_fetch_failed:${res.status}`);
        }
        const payload = await res.json();
        savedStorySummaries = Array.isArray(payload?.stories)
            ? payload.stories.filter((story) => story?.storyId)
            : [];
        onSummariesChange?.(savedStorySummaries);
        return savedStorySummaries;
    }

    function getSummaries() {
        return savedStorySummaries || [];
    }

    async function navigate(delta) {
        if(navigationInFlight) {
            return;
        }
        navigationInFlight = true;
        try {
            const stories = await fetchSummaries({force: true});
            if(stories.length === 0) {
                return;
            }
            const currentId = getCurrentStoryId?.() || '';
            const currentIndex = stories.findIndex((story) => story.storyId === currentId);
            const nextIndex = currentIndex === -1
                ? (delta > 0 ? 0 : stories.length - 1)
                : wrapIndex(currentIndex + delta, stories.length);
            const next = stories[nextIndex];
            if(!next?.storyId || next.storyId === currentId) {
                return;
            }
            onNavigateAway?.();
            setOpen(false);
            await onLoadStory?.(next.storyId, {title: storyLabel(next)});
        } catch(err) {
            onShowError?.(err?.message || 'story_navigation_failed');
        } finally {
            navigationInFlight = false;
        }
    }

    function handlePointerDown(ev) {
        if(!activeDeleteConfirm) {
            return;
        }
        if(activeDeleteConfirm.row.contains(ev.target)) {
            return;
        }
        clearDeleteConfirm();
    }

    function signature(sessions) {
        return JSON.stringify((sessions || []).map((session) => ({
            storyId: session.storyId || '',
            traceId: session.traceId || '',
            title: session.title || '',
            updatedAt: session.updatedAt || session.finishedAt || session.startedAt || null,
            chapterCount: session.chapterCount || 0,
            lastQuestion: session.lastQuestion || session.question || '',
            freshness: session.freshness?.state || '',
            changedPaths: Array.isArray(session.freshness?.changedPaths) ? session.freshness.changedPaths : []
        })));
    }

    async function deleteStory(storyId) {
        if(!storyId || deletingStoryIds.has(storyId)) {
            return;
        }
        deletingStoryIds.add(storyId);
        try {
            const res = await apiFetch(`/api/stories/${encodeURIComponent(storyId)}`, {method: 'DELETE'});
            let payload = null;
            try {
                payload = await res.json();
            } catch {}
            if(!res.ok) {
                if(payload?.error === 'not_found') {
                    throw new Error('story not found');
                }
                if(payload?.error === 'invalid_story_id') {
                    throw new Error('invalid story id');
                }
                throw new Error(payload?.message || payload?.error || `story_delete_failed:${res.status}`);
            }
            if(storyIdFromLocation() === storyId) {
                clearStoryUrl(storyId);
            }
            onStoryDeleted?.(storyId);
            invalidate();
            await loadList();
        } catch(err) {
            onShowError?.(err?.message || 'story_delete_failed');
        } finally {
            deletingStoryIds.delete(storyId);
        }
    }

    function openDeleteConfirm({row, storyId, label}) {
        clearDeleteConfirm();
        row.classList.add('is-confirming-delete');

        const popover = document.createElement('div');
        popover.className = 'session-delete-confirm';
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-modal', 'false');

        const text = document.createElement('div');
        text.className = 'session-delete-confirm-text';
        text.textContent = `Delete "${label}"?`;

        const actions = document.createElement('div');
        actions.className = 'session-delete-confirm-actions';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'session-delete-confirm-btn';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            clearDeleteConfirm();
        });

        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'session-delete-confirm-btn is-danger';
        confirm.textContent = 'Delete';
        confirm.addEventListener('click', async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if(deletingStoryIds.has(storyId)) {
                return;
            }
            confirm.disabled = true;
            cancel.disabled = true;
            row.classList.add('is-deleting');
            clearDeleteConfirm();
            await deleteStory(storyId);
            row.classList.remove('is-deleting');
        });

        actions.append(cancel, confirm);
        popover.append(text, actions);
        row.appendChild(popover);

        activeDeleteConfirm = {storyId, row, popover};
    }

    function clearDeleteConfirm() {
        if(!activeDeleteConfirm) {
            return;
        }
        activeDeleteConfirm.row.classList.remove('is-confirming-delete');
        activeDeleteConfirm.popover.remove();
        activeDeleteConfirm = null;
    }

    function renderItem(session) {
        const row = document.createElement('div');
        row.className = 'session-item-row';
        const stale = isStale(session);
        const current = session.storyId && session.storyId === getCurrentStoryId?.();
        const loading = session.storyId && session.storyId === loadingStoryId;
        row.classList.toggle('is-stale', stale);
        row.classList.toggle('is-current', Boolean(current));
        row.classList.toggle('is-loading', Boolean(loading));

        const itemButton = document.createElement('button');
        itemButton.type = 'button';
        itemButton.className = 'session-item';
        itemButton.setAttribute('aria-current', current ? 'page' : 'false');
        itemButton.disabled = Boolean(loading);
        itemButton.addEventListener('click', async () => {
            const storyId = session.storyId || '';
            if(storyId) {
                loadingStoryId = storyId;
                renderList(savedStorySummaries || []);
                try {
                    onNavigateAway?.();
                    await onLoadStory?.(storyId, {title: storyLabel(session)});
                    setOpen(false);
                } finally {
                    loadingStoryId = '';
                    renderList(savedStorySummaries || []);
                }
                return;
            }
            await onLoadTrace?.(session.traceId);
            setOpen(false);
        });

        const title = document.createElement('span');
        title.className = 'session-title';
        title.textContent = session.title || session.question || session.storyId || session.traceId;

        const question = document.createElement('span');
        question.className = 'session-question';
        question.textContent = session.lastQuestion || session.question || '';

        const meta = document.createElement('span');
        meta.className = 'session-meta';
        const when = formatTime(session.updatedAt || session.finishedAt || session.startedAt);
        const kinds = Array.isArray(session.componentKinds) && session.componentKinds.length > 0
            ? ` · ${[...new Set(session.componentKinds)].join(', ')}`
            : '';
        const chapters = session.chapterCount ? ` · ${session.chapterCount} chapter${session.chapterCount === 1 ? '' : 's'}` : '';
        const freshness = stale ? ' · code changed' : '';
        const active = current ? ' · current' : '';
        const state = loading ? ' · loading' : active;
        meta.classList.toggle('is-stale', stale);
        meta.textContent = `${when || 'saved story'}${chapters}${kinds}${freshness}${state}`;

        const sources = document.createElement('span');
        sources.className = 'session-sources';
        sources.textContent = sourcePreview(session.sourcePaths);
        sources.hidden = !sources.textContent;

        itemButton.append(title, question, meta, sources);
        row.appendChild(itemButton);

        if(session.storyId) {
            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.className = 'session-delete';
            removeButton.textContent = '🗑';
            removeButton.setAttribute('aria-label', 'Delete story');
            removeButton.title = 'Delete story';
            removeButton.addEventListener('click', async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if(deletingStoryIds.has(session.storyId)) {
                    return;
                }
                if(activeDeleteConfirm?.storyId === session.storyId) {
                    clearDeleteConfirm();
                    return;
                }
                const label = title.textContent || session.storyId;
                openDeleteConfirm({row, storyId: session.storyId, label});
            });
            row.appendChild(removeButton);
        }

        return row;
    }

    return {
        init,
        setOpen,
        isOpen,
        invalidate,
        loadList,
        fetchSummaries,
        getSummaries,
        navigate,
        handlePointerDown,
        clearDeleteConfirm
    };
}

function isStale(session) {
    const freshness = session?.freshness;
    if(!freshness) {
        return false;
    }
    return freshness.state === 'stale' || freshness.stale === true;
}

function formatTime(value) {
    if(!value) {
        return '';
    }
    try {
        return new Intl.DateTimeFormat(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
        }).format(new Date(value));
    } catch {
        return '';
    }
}

function sourcePreview(paths) {
    if(!Array.isArray(paths) || paths.length === 0) {
        return '';
    }
    const visible = paths.slice(0, 2).map((value) => String(value || '').trim()).filter(Boolean);
    if(visible.length === 0) {
        return '';
    }
    const extra = paths.length > visible.length ? ` +${paths.length - visible.length}` : '';
    return `${visible.join(', ')}${extra}`;
}

function storyLabel(session) {
    return String(session?.title || session?.lastQuestion || session?.question || session?.storyId || '').trim();
}

function wrapIndex(index, length) {
    return ((index % length) + length) % length;
}

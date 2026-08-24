import {apiFetch} from './team-context.js';
import {storyIdFromLocation, writeStoryUrl} from './story-url.js';

const REPLAY_DELAY_MS = 35;

export function createStoryHistory({
    storySession,
    input,
    storyView,
    storyRunner,
    sessions,
    normalizeStoryFreshness,
    renderStoryContext,
    scheduleStoryFreshnessPoll,
    isFreshnessSuppressed = () => false,
    rememberLastViewedStory = () => {},
    forgetLastViewedStory = () => {},
    getLastViewedStoryId = () => '',
    clearMissingStoryUrl,
    showError,
    hideAskTooltip,
    scrollToBottom,
    scrollToTop,
    setStatusCrumb
} = {}) {
    let isReplaying = false;

    async function loadTraceSession(traceId) {
        if(!traceId) {
            return;
        }
        let trace;
        try {
            const res = await apiFetch(`/api/traces/${encodeURIComponent(traceId)}`);
            if(!res.ok) {
                showError(`trace not found: ${traceId}`);
                return;
            }
            trace = await res.json();
        } catch(err) {
            showError(err?.message || 'trace_load_failed');
            return;
        }

        const url = new URL(location.href);
        url.pathname = '/';
        url.searchParams.set('trace', traceId);
        url.searchParams.delete('story');
        history.replaceState(null, '', url);
        await replayTrace(trace, {fast: true});
        scrollToBottom({smooth: true});
    }

    async function loadStorySession(storyId, {title = ''} = {}) {
        if(!storyId) {
            return;
        }
        let loadingCrumb = '';
        let story;
        try {
            loadingCrumb = loadingStatusText(title || storyId);
            setStatusCrumb?.(loadingCrumb);
            const res = await apiFetch(`/api/stories/${encodeURIComponent(storyId)}`);
            if(!res.ok) {
                if(res.status === 404) {
                    clearMissingStoryUrl(storyId);
                    forgetLastViewedStory(storyId);
                }
                showError(`story not found: ${storyId}`);
                return;
            }
            story = await res.json();
            loadingCrumb = loadingStatusText(storyTitle(story, title || storyId));
            setStatusCrumb?.(loadingCrumb);
        } catch(err) {
            showError(err?.message || 'story_load_failed');
            return;
        } finally {
            if(!story && loadingCrumb) {
                setStatusCrumb?.('');
            }
        }

        writeStoryUrl(storyId);
        rememberLastViewedStory(storyId);
        await replayStory(story, {fast: true, suppressStatus: true});
        scheduleStoryFreshnessPoll();
        scrollToTop?.({smooth: false});
        if(loadingCrumb) {
            setStatusCrumb?.('');
        }
    }

    async function persistStorySession() {
        if(isReplaying) {
            return;
        }
        const payload = serializeStorySession();
        if(payload.chapters.length === 0) {
            return;
        }
        try {
            const res = await apiFetch('/api/stories', {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify(payload)
            });
            if(res.ok) {
                const saved = await res.json();
                if(saved?.storyId) {
                    storySession.storyId = saved.storyId;
                    rememberLastViewedStory(saved.storyId);
                    const freshnessSuppressed = isFreshnessSuppressed();
                    if(!freshnessSuppressed) {
                        sessions.invalidate();
                        sessions.fetchSummaries?.({force: true}).catch((err) => {
                            console.warn('[story-save] failed to refresh summaries', err?.message || err);
                        });
                    }
                    writeStoryUrl(saved.storyId);
                    if(!freshnessSuppressed) {
                        storySession.freshness = normalizeStoryFreshness(saved);
                        renderStoryContext();
                        scheduleStoryFreshnessPoll();
                    }
                }
            }
        } catch(err) {
            console.warn('[story-save] failed', err?.message || err);
        }
    }

    function serializeStorySession() {
        const chapters = storySession.chapters
            .filter((chapter) => chapter.question || chapter.title || chapter.events.length > 0)
            .map((chapter) => ({
                question: chapter.question || '',
                title: chapter.title || '',
                traceId: chapter.traceId || '',
                narrative: chapter.narrative.filter(Boolean),
                events: coalesceForReplay(chapter.events || [])
            }));
        return {
            storyId: storySession.storyId,
            title: chapters[0]?.title || chapters[0]?.question || 'Untitled story',
            createdAt: storySession.createdAt,
            chapters,
            sourcePaths: [...storySession.evidencePaths.keys()]
        };
    }

    async function maybeReplayFromUrl() {
        const params = new URLSearchParams(location.search);
        const storyId = storyIdFromLocation();
        if(storyId) {
            await loadStorySession(storyId);
            return;
        }
        const traceId = params.get('trace');
        if(!traceId) {
            const lastStoryId = getLastViewedStoryId();
            if(lastStoryId) {
                await loadStorySession(lastStoryId);
            }
            return;
        }

        let trace;
        try {
            const res = await apiFetch(`/api/traces/${encodeURIComponent(traceId)}`);
            if(!res.ok) {
                showError(`trace not found: ${traceId}`);
                return;
            }
            trace = await res.json();
        } catch(err) {
            showError(err?.message || 'replay_fetch_failed');
            return;
        }

        const fast = params.get('fast') !== '0';
        await replayTrace(trace, {fast});
    }

    async function replayTrace(trace, {fast = true} = {}) {
        isReplaying = true;
        try {
            if(trace.question) {
                storyView.resetSession(trace.question);
                input.value = '';
                hideAskTooltip();
            }

            const events = fast ? coalesceForReplay(trace.events || []) : (trace.events || []);
            for(const event of events) {
                storyRunner.handleEvent(event, {isReplaying});
                await delay(REPLAY_DELAY_MS);
            }
        } finally {
            isReplaying = false;
        }
    }

    async function replayStory(story, {fast = true, suppressStatus = false} = {}) {
        isReplaying = true;
        try {
            storySession.storyId = story.storyId || makeStoryId();
            storySession.createdAt = story.createdAt || Date.now();
            storyView.resetSession('');
            storySession.freshness = normalizeStoryFreshness(story);
            renderStoryContext();
            input.value = '';
            hideAskTooltip();

            const chapters = Array.isArray(story.chapters) ? story.chapters : [];
            for(let i = 0; i < chapters.length; i++) {
                const chapter = chapters[i];
                storyView.beginReplayChapter(chapter, i);
                const events = coalesceForReplay(chapter.events || []);
                for(const event of events) {
                    storyRunner.handleEvent(event, {isReplaying, suppressStatus});
                    if(!fast) {
                        await delay(REPLAY_DELAY_MS);
                    }
                }
                storyView.finishReplayChapter(chapter);
            }
            renderStoryContext();
        } finally {
            isReplaying = false;
        }
    }

    return {
        loadTraceSession,
        loadStorySession,
        persistStorySession,
        maybeReplayFromUrl,
        replayTrace,
        replayStory
    };
}

export function makeStoryId() {
    return `story_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Reduce the chatter of progressive component patches: keep narrative cadence
// (title, narrative steps, trace lifecycle), but emit only the LAST component.patch
// per component id so async renderers (e.g., Mermaid) receive a single, complete props.
//
function coalesceForReplay(events) {
    const finalPropsById = new Map();
    for(const ev of events) {
        if(ev?.type === 'component.patch' && ev.id) {
            finalPropsById.set(ev.id, ev);
        }
    }
    const seenComponentIds = new Set();
    const out = [];
    for(const ev of events) {
        if(ev?.type !== 'component.patch') {
            out.push(ev);
            continue;
        }
        if(!ev.id || seenComponentIds.has(ev.id)) continue;
        seenComponentIds.add(ev.id);
        out.push(finalPropsById.get(ev.id));
    }
    return out;
}

function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function loadingStatusText(label) {
    return `loading ${cleanStoryLabel(label) || 'story'}`;
}

function storyTitle(story, fallback = '') {
    const chapters = Array.isArray(story?.chapters) ? story.chapters : [];
    return cleanStoryLabel(
        story?.title ||
        chapters[0]?.title ||
        chapters[0]?.question ||
        fallback ||
        story?.storyId
    );
}

function cleanStoryLabel(value) {
    return String(value || '').trim();
}

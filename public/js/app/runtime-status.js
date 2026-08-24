import {createIndexingOverlay} from './indexing-overlay.js';
import {apiFetch} from './team-context.js';

const RUNTIME_WARMUP_POLL_MS = 800;
const INDEXING_PLACEHOLDER = 'Indexing repository — you can ask once it is ready…';

export function createRuntimeStatus({
    input,
    button,
    statusPill,
    setStatusCrumb,
    isStoryRunning = () => false,
    indexingOverlay: providedIndexingOverlay = null
} = {}) {
    let runtimeHeartbeatTimer = null;
    let runtimePollInFlight = null;
    let runtimeBanner = null;
    let runtimeReady = null;
    let runtimeStatusFailures = 0;
    const defaultAskPlaceholder = input?.getAttribute('placeholder') || '';
    const indexingOverlay = providedIndexingOverlay || createIndexingOverlay({
        input,
        setComposerBusy,
        setStatusCrumb,
        focusAskInput
    });

    function init() {
        if(!indexingOverlay.init()) {
            setComposerBusy(true);
        }
        startRuntimeHeartbeat();
        poll({start: true});
    }

    async function poll({start = false} = {}) {
        if(runtimePollInFlight) {
            return runtimePollInFlight;
        }
        runtimePollInFlight = pollRuntimeStatus({start})
            .finally(() => {
                runtimePollInFlight = null;
            });
        return runtimePollInFlight;
    }

    async function pollRuntimeStatus({start = false} = {}) {
        const url = start ? '/api/runtime/start' : '/api/runtime/status';
        let payload;
        try {
            const res = await apiFetch(url, {
                method: start ? 'POST' : 'GET',
                headers: {'accept': 'application/json'}
            });
            if(!res.ok) {
                return handleStatusUnavailable();
            }
            payload = await res.json();
        } catch {
            return handleStatusUnavailable();
        }

        runtimeStatusFailures = 0;
        if(payload?.setupRequired && location.pathname !== '/admin') {
            location.href = '/admin';
        }
        const runtime = payload?.runtime || null;
        if(!runtime) {
            return handleStatusUnavailable();
        }
        indexingOverlay.update(runtime);
        updateIndicator(runtime);
        applyReadiness(runtime);
        const delay = runtimeStatusPollDelay(runtime);
        if(delay > 0) {
            startRuntimeHeartbeat();
        } else {
            stopRuntimeHeartbeat();
        }
        return runtime;
    }

    function handleStatusUnavailable() {
        runtimeStatusFailures += 1;
        const runtime = {
            state: 'initializing',
            stage: 'starting',
            message: runtimeStatusFailures > 1
                ? 'Still waiting for local runtime status.'
                : 'Checking local runtime status.',
            progressRatio: 0.01
        };
        indexingOverlay.update(runtime);
        updateIndicator(runtime);
        applyReadiness(runtime);
        startRuntimeHeartbeat();
        return runtime;
    }

    function startRuntimeHeartbeat() {
        if(runtimeHeartbeatTimer || runtimeReady === true) {
            return;
        }
        runtimeHeartbeatTimer = window.setInterval(() => {
            if(runtimeReady === true) {
                stopRuntimeHeartbeat();
                return;
            }
            poll();
        }, RUNTIME_WARMUP_POLL_MS);
    }

    function stopRuntimeHeartbeat() {
        if(!runtimeHeartbeatTimer) {
            return;
        }
        window.clearInterval(runtimeHeartbeatTimer);
        runtimeHeartbeatTimer = null;
    }

    // Reflect runtime status onto the composer. Only a fully 'ready' runtime can
    // answer; 'idle'/'initializing'/'error' all gate the composer.
    //
    function applyReadiness(runtime) {
        const ready = runtime?.state === 'ready';
        runtimeReady = ready;
        if(!ready) {
            setComposerBusy(true);
            indexingOverlay.show(runtime);
            return;
        }
        stopRuntimeHeartbeat();
        indexingOverlay.hide();
        setComposerBusy(false);
    }

    function setComposerBusy(busy) {
        if(!button && !input) {
            return;
        }
        if(busy) {
            if(button) {
                button.disabled = true;
            }
            if(input) {
                input.disabled = true;
                input.placeholder = INDEXING_PLACEHOLDER;
                input.setAttribute('aria-busy', 'true');
            }
            return;
        }
        if(input) {
            input.disabled = false;
            input.placeholder = defaultAskPlaceholder;
            input.removeAttribute('aria-busy');
        }
        // Never re-enable mid-request — the in-flight run owns the button.
        //
        if(button && !isStoryRunning()) {
            button.disabled = false;
        }
    }

    function updateIndicator(runtime) {
        if(indexingOverlay.visible) {
            if(runtimeBanner) {
                runtimeBanner.hidden = true;
                runtimeBanner.classList.remove('is-error');
            }
            return;
        }
        if(!runtime || runtime.state === 'ready') {
            hideIndicator();
            return;
        }

        const banner = ensureRuntimeBanner();
        const isError = runtime.state === 'error';
        banner.classList.toggle('is-error', isError);

        const title = banner.querySelector('.runtime-banner-title');
        const detail = banner.querySelector('.runtime-banner-detail');
        const elapsed = typeof runtime.elapsedMs === 'number' ? ` · ${Math.max(1, Math.round(runtime.elapsedMs / 1000))}s` : '';
        const path = runtime.lastPath ? ` · ${runtime.lastPath}` : '';
        const count = Number.isFinite(runtime.filesProcessed) && runtime.filesProcessed > 0
            ? ` · ${runtime.filesProcessed} files checked`
            : '';

        title.textContent = isError ? 'Code index did not start' : 'Indexing repository';
        detail.textContent = isError
            ? (runtime.message || 'Check the server logs before asking a question.')
            : `${count}${path}${elapsed}`.replace(/^\s*·\s*/, '') || 'Preparing index';
        banner.hidden = false;

        if(!isError) {
            setStatusCrumb('indexing repository');
        }
    }

    function hideIndicator() {
        if(runtimeReady === true) {
            stopRuntimeHeartbeat();
        }
        if(runtimeBanner) {
            runtimeBanner.hidden = true;
            runtimeBanner.classList.remove('is-error');
        }
        if(statusPill?.textContent === 'indexing repository') {
            setStatusCrumb('');
        }
    }

    function focusAskInput() {
        if(!input || indexingOverlay.visible || input.disabled) {
            return;
        }
        try {
            input.focus({preventScroll: true});
        } catch {
            input.focus();
        }
    }

    function handleOverlayKeydown(ev) {
        return indexingOverlay.handleKeydown(ev);
    }

    function isReady() {
        return runtimeReady === true;
    }

    function runtimeStatusPollDelay(runtime) {
        if(runtime?.state === 'ready' || runtime?.state === 'error') {
            return 0;
        }
        return RUNTIME_WARMUP_POLL_MS;
    }

    function ensureRuntimeBanner() {
        if(runtimeBanner) {
            return runtimeBanner;
        }
        runtimeBanner = document.createElement('div');
        runtimeBanner.id = 'runtime-banner';
        runtimeBanner.className = 'runtime-banner';
        runtimeBanner.hidden = true;

        const title = document.createElement('div');
        title.className = 'runtime-banner-title';
        const detail = document.createElement('div');
        detail.className = 'runtime-banner-detail';
        runtimeBanner.append(title, detail);

        const topbar = document.querySelector('.topbar');
        if(topbar?.parentNode) {
            topbar.parentNode.insertBefore(runtimeBanner, topbar.nextSibling);
        } else {
            document.body.prepend(runtimeBanner);
        }
        return runtimeBanner;
    }

    return {
        init,
        poll,
        applyReadiness,
        setComposerBusy,
        updateIndicator,
        hideIndicator,
        focusAskInput,
        handleOverlayKeydown,
        isReady
    };
}

import {postSSE as defaultPostSSE} from '../runtime/sse-client.js';

export function createStoryRunner({
    input,
    button,
    postSSE = defaultPostSSE,
    isRuntimeReady,
    pollRuntimeStatus,
    updateRuntimeIndicator,
    applyRuntimeReadiness,
    hideRuntimeIndicator,
    setComposerBusy,
    buildStoryContext,
    storyView,
    renderChapterSources,
    handleDuplicateBlock,
    renderCrossRefs,
    registerBlock,
    registerSourceBlocks,
    renderChangeBriefAction,
    setMeta,
    setStatusCrumb,
    persistStorySession,
    addSchemaNote,
    showError,
    hideAskTooltip
} = {}) {
    let activeController = null;
    let successfulRendersThisRun = 0;
    let toolCallCount = 0;
    let storyPersistPromise = Promise.resolve();

    async function run(question, {forceFresh = false} = {}) {
        hideAskTooltip();

        // Gate on the index before starting a chapter. During cold start the
        // splash overlay owns the UI, so no question is queued behind indexing.
        //
        if(!isRuntimeReady()) {
            await pollRuntimeStatus({start: true});
            if(!isRuntimeReady()) {
                input.value = question;
                return;
            }
        }

        abort();
        activeController = new AbortController();
        const controller = activeController;

        const storyContext = buildStoryContext();
        successfulRendersThisRun = 0;
        storyView.startChapter(question);
        input.value = '';
        button.disabled = true;
        let sawFirstEvent = false;
        let sawTerminal = false;
        const startupWaitTimer = window.setTimeout(() => {
            if(!sawFirstEvent) {
                updateRuntimeIndicator({
                    state: 'initializing',
                    stage: 'indexing',
                    message: 'Indexing the repository before answering.'
                });
                pollRuntimeStatus({start: true});
            }
        }, 700);

        const body = {question, storyContext};
        if(forceFresh) {
            body.forceFresh = true;
        }

        try {
            for await (const frame of postSSE({url: '/api/ask', body, signal: controller.signal})) {
                if(controller.signal.aborted) break;
                sawFirstEvent = true;
                window.clearTimeout(startupWaitTimer);
                handleEvent(frame.data);
                if(frame.data?.type === 'trace.complete' || frame.data?.type === 'trace.error') {
                    sawTerminal = true;
                }
            }
        } catch(err) {
            if(err?.name !== 'AbortError') {
                showError(err?.message || 'request_failed');
            }
        } finally {
            if(activeController === controller) {
                activeController = null;
                if(isRuntimeReady()) {
                    button.disabled = false;
                } else {
                    setComposerBusy(true);
                }
            }
            window.clearTimeout(startupWaitTimer);
            // The working blinker is driven solely by the status crumb. A successful
            // run ends on trace.complete (crumb -> "complete"); a server error ends
            // on a trace.error event (its handler clears the crumb). Any OTHER ending
            // — a thrown/dropped stream, or a clean close with no terminal event —
            // leaves the crumb mid-flight ("exploring"/"composing"), so clear it here
            // so the blinker stops instead of pulsing forever. Aborts already cleared it.
            //
            if(!sawTerminal && !controller.signal.aborted) {
                setStatusCrumb('');
            }
        }
    }

    function abort() {
        if(!activeController) {
            return;
        }
        activeController.abort();
        activeController = null;
        if(button) {
            button.disabled = false;
        }
        // A cancelled run must not leave the working blinker pulsing.
        //
        setStatusCrumb('');
    }

    function isRunning() {
        return Boolean(activeController);
    }

    function waitForPersist() {
        return storyPersistPromise;
    }

    function handleEvent(event, {isReplaying = false, suppressStatus = false} = {}) {
        if(!event || !event.type) return;
        const setRunStatus = (text) => {
            if(!suppressStatus) {
                setStatusCrumb(text);
            }
        };
        storyView.recordEvent(event, {isReplaying});
        switch(event.type) {
            case 'runtime.indexing':
                // Safety net: the server reported it is still indexing after a
                // pre-ask gate. Put the question back in the composer and keep
                // the blocking overlay up until the runtime is ready.
                //
                if(storyView.getActiveChapter()?.question) {
                    input.value = storyView.getActiveChapter().question;
                }
                updateRuntimeIndicator(event.runtime);
                applyRuntimeReadiness(event.runtime);
                pollRuntimeStatus({start: true});
                break;
            case 'trace.start':
                hideRuntimeIndicator();
                toolCallCount = 0;
                storyView.resetTiming();
                setMeta({traceId: event.traceId});
                setRunStatus('exploring');
                break;
            case 'timing.checkpoint':
                storyView.handleTiming(event, {suppressStatus});
                break;
            case 'trace.similar':
                storyView.renderSimilarTraces(event.matches || []);
                break;
            case 'trace.replay':
                storyView.renderReplayBanner(event);
                break;
            case 'trace.title':
                storyView.setActiveTitle(event.title);
                break;
            case 'tool.call':
                toolCallCount += 1;
                storyView.appendExplorationCall(event.tool, event.inputSummary);
                setRunStatus(`exploring · ${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'}`);
                successfulRendersThisRun += 1;
                break;
            case 'tool.result':
                storyView.appendExplorationResult(event.tool, event.summary);
                break;
            case 'evidence.ready':
                renderChapterSources(event.items || [], event.retrieval || {});
                break;
            case 'synthesis.start':
                storyView.setComposingState();
                setRunStatus(`composing · streaming`);
                break;
            case 'narrative.patch':
                storyView.appendNarrative(event.startIndex || 0, event.items || []);
                if(Array.isArray(event.items) && event.items.length > 0) {
                    successfulRendersThisRun += event.items.length;
                }
                break;
            case 'component.patch':
                if(!handleDuplicateBlock(event)) {
                    storyView.applyComponentEvent(event);
                    renderCrossRefs(event);
                    registerBlock(event);
                    registerSourceBlocks(event);
                }
                successfulRendersThisRun += 1;
                break;
            case 'trace.complete':
                storyView.setActiveTraceId(event.traceId);
                renderChangeBriefAction?.(event);
                setMeta({
                    traceId: event.traceId,
                    model: event.model,
                    durationMs: event.durationMs,
                    usage: event.usage,
                    timing: event.timing
                });
                setRunStatus(`complete · ${(event.durationMs / 1000).toFixed(1)} seconds`);
                if(!isReplaying) {
                    storyPersistPromise = persistStorySession();
                }
                break;
            case 'trace.error':
                if(successfulRendersThisRun > 0) {
                    addSchemaNote('schema note: minor variance in model output — explanation rendered above.');
                } else {
                    showError(event.message || 'planner_error');
                }
                setRunStatus('');
                break;
            default:
                break;
        }
    }

    return {
        run,
        abort,
        isRunning,
        waitForPersist,
        handleEvent
    };
}

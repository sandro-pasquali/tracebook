import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoryRunner} from '../../public/js/app/story-runner.js';

// A mid-trace network error (the SSE connection dropping) used to leave the
// status crumb stuck at "exploring…/composing · streaming". That crumb is the
// sole driver of the brand-mark "working" blinker, so it pulsed forever. The
// error and abort paths must clear the crumb the same way the trace.error event
// handler does.
//

// story-runner uses window.setTimeout/clearTimeout; alias window to globalThis
// for the test and restore afterward.
//
function withWindow(t) {
    const prev = globalThis.window;
    globalThis.window = globalThis;
    t.after(() => {
        globalThis.window = prev;
    });
}

// storyView touches many methods; a no-op proxy keeps the test focused on the
// crumb behavior without enumerating each one.
//
const noopStoryView = new Proxy({}, {get: () => () => {}});

function makeDeps(crumbCalls) {
    return {
        input: {value: ''},
        button: {disabled: false},
        isRuntimeReady: () => true,
        pollRuntimeStatus: async () => {},
        updateRuntimeIndicator: () => {},
        applyRuntimeReadiness: () => {},
        hideRuntimeIndicator: () => {},
        setComposerBusy: () => {},
        buildStoryContext: () => ({chapters: [], sourcePaths: []}),
        storyView: noopStoryView,
        renderChapterSources: () => {},
        handleDuplicateBlock: () => false,
        renderCrossRefs: () => {},
        registerBlock: () => {},
        registerSourceBlocks: () => {},
        renderChangeBriefAction: () => {},
        setMeta: () => {},
        setStatusCrumb: (text) => crumbCalls.push(text),
        persistStorySession: () => Promise.resolve(),
        addSchemaNote: () => {},
        showError: () => {},
        hideAskTooltip: () => {}
    };
}

test('a mid-trace network error clears the status crumb (blinker stops)', async (t) => {
    withWindow(t);
    const crumbCalls = [];
    const errors = [];
    // Yields one event (sets crumb to "exploring") then throws a non-abort error,
    // simulating the SSE connection dropping mid-stream.
    //
    async function* droppingStream() {
        yield {data: {type: 'trace.start', traceId: 't', question: 'q'}};
        throw new Error('network error');
    }
    const deps = makeDeps(crumbCalls);
    deps.showError = (m) => errors.push(m);
    deps.postSSE = () => droppingStream();

    const runner = createStoryRunner(deps);
    await runner.run('how does the server work');

    assert.deepEqual(errors, ['network error'], 'the network error is surfaced');
    assert.equal(crumbCalls.at(-1), '', 'the last crumb update clears it, so the blinker stops');
});

test('aborting a run clears the status crumb', async (t) => {
    withWindow(t);
    const crumbCalls = [];
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    // Yields one event then parks, so the run sits mid-stream with the crumb set
    // and an active controller, exactly when an abort would land.
    //
    async function* parkedStream() {
        yield {data: {type: 'trace.start', traceId: 't', question: 'q'}};
        await gate;
    }
    const deps = makeDeps(crumbCalls);
    deps.postSSE = () => parkedStream();

    const runner = createStoryRunner(deps);
    const pending = runner.run('q');
    // Let the first yielded event be processed (crumb -> "exploring").
    //
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
    assert.ok(crumbCalls.some((c) => /exploring/.test(c)), 'crumb was set during the run');

    runner.abort();
    assert.equal(crumbCalls.at(-1), '', 'abort clears the crumb');

    release();
    await pending;
});

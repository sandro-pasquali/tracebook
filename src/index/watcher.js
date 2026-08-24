import chokidar from 'chokidar';
import {pathExcluded} from '../util/path-filter.js';
import {config} from '../util/config.js';
import {DEFAULT_INDEX_EXCLUDE} from './file-patterns.js';
import {DEFAULT_REPO_IGNORE_FILES} from '../util/repo-ignore.js';
import {createSourceCorpusPolicy} from './source-corpus-policy.js';

// File watcher that keeps the LanceDB index in sync with the filesystem.
// Uses the same include/exclude as the indexer.
//
export function createWatcher({root, include, exclude, indexer, onEvent, watch = chokidar.watch, debounceMs = config.watcher.debounceMs, optimizeDebounceMs = config.watcher.optimizeDebounceMs}) {
    if(!root || !indexer) {
        throw new Error('createWatcher requires {root, indexer}');
    }

    const sourcePolicy = createSourceCorpusPolicy({root, include, exclude: exclude || DEFAULT_INDEX_EXCLUDE});
    const effectiveExcludeGlob = sourcePolicy.excludeGlob;
    const watchPatterns = [
        ...sourcePolicy.includeGlob,
        ...repoIgnoreWatchPatterns()
    ];

    // Watch only the same file set the indexer cares about.
    //
    const w = watch(watchPatterns, {
        cwd: root,
        ignored: effectiveExcludeGlob,
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        awaitWriteFinish: {stabilityThreshold: 150, pollInterval: 50}
    });

    const pending = new Map();
    let closed = false;

    // Store compaction is expensive and need not run per save. Incremental writes
    // schedule it on a debounce so a burst of edits coalesces into one optimize
    // once the writes settle. A sustained edit stream keeps resetting the timer,
    // which is intentional — compacting mid-churn is wasted work.
    //
    let optimizeTimer = null;
    let optimizing = false;
    let optimizeQueued = false;

    function scheduleOptimize() {
        if(closed || typeof indexer.optimize !== 'function') {
            return;
        }
        if(optimizeTimer) {
            clearTimeout(optimizeTimer);
        }
        optimizeTimer = setTimeout(runOptimize, optimizeDebounceMs);
    }

    async function runOptimize() {
        optimizeTimer = null;
        if(closed || typeof indexer.optimize !== 'function') {
            return;
        }
        if(optimizing) {
            optimizeQueued = true;
            return;
        }
        optimizing = true;
        try {
            await indexer.optimize();
        } catch {
            // Best-effort; search still works on the unindexed tail.
            //
        } finally {
            optimizing = false;
            if(optimizeQueued && !closed) {
                optimizeQueued = false;
                scheduleOptimize();
            }
        }
    }

    function schedule(rel, kind) {
        if(closed) {
            return;
        }
        const state = pending.get(rel) || {
            timer: null,
            running: false,
            kind: null
        };
        state.kind = coalesceKind(state.kind, kind);
        if(state.timer) {
            clearTimeout(state.timer);
        }
        state.timer = setTimeout(() => flush(rel), debounceMs);
        pending.set(rel, state);
    }

    async function flush(rel) {
        const state = pending.get(rel);
        if(!state || closed) {
            return;
        }
        state.timer = null;
        if(state.running) {
            return;
        }

        const kind = state.kind;
        state.kind = null;
        state.running = true;
        try {
            await processEvent(rel, kind);
        } finally {
            state.running = false;
            if(closed) {
                pending.delete(rel);
            } else if(state.kind) {
                state.timer = setTimeout(() => flush(rel), debounceMs);
            } else {
                pending.delete(rel);
            }
        }
    }

    async function processEvent(rel, kind) {
        try {
            if(kind === 'unlink') {
                await indexer.removeFile(rel);
                scheduleOptimize();
                if(onEvent) onEvent({kind: 'removed', rel});
            } else if(kind === 'policy') {
                if(typeof indexer.invalidateIgnorePolicy === 'function') {
                    indexer.invalidateIgnorePolicy();
                }
                const res = await indexer.indexAll();
                if(onEvent) onEvent({kind: 'policy_reindexed', rel, ...res});
            } else {
                const res = await indexer.indexFile(rel);
                scheduleOptimize();
                if(onEvent) onEvent({kind: 'indexed', rel, ...res});
            }
        } catch(err) {
            if(onEvent) onEvent({kind: 'error', rel, message: err?.message});
        }
    }

    function coalesceKind(_previous, next) {
        if(next === 'policy') {
            return 'policy';
        }
        return next === 'unlink' ? 'unlink' : 'change';
    }

    function matchesInclude(rel) {
        // Apply the same exclude gate used by the indexer.
        //
        if(isRepoIgnorePath(rel)) {
            return !repoIgnorePathExcluded(rel, effectiveExcludeGlob);
        }
        return sourcePolicy.matchesWatchPath(rel);
    }

    w.on('add', (rel) => { if(matchesInclude(rel)) schedule(rel, isRepoIgnorePath(rel) ? 'policy' : 'add'); });
    w.on('change', (rel) => { if(matchesInclude(rel)) schedule(rel, isRepoIgnorePath(rel) ? 'policy' : 'change'); });
    w.on('unlink', (rel) => { if(matchesInclude(rel)) schedule(rel, isRepoIgnorePath(rel) ? 'policy' : 'unlink'); });

    return {
        async close() {
            closed = true;
            if(optimizeTimer) {
                clearTimeout(optimizeTimer);
                optimizeTimer = null;
            }
            for(const state of pending.values()) {
                if(state.timer) {
                    clearTimeout(state.timer);
                }
            }
            pending.clear();
            await w.close();
        }
    };
}

function repoIgnoreWatchPatterns() {
    return DEFAULT_REPO_IGNORE_FILES.flatMap((name) => [name, `**/${name}`]);
}

function isRepoIgnorePath(rel) {
    const name = String(rel || '').replace(/\\/g, '/').split('/').pop();
    return DEFAULT_REPO_IGNORE_FILES.includes(name);
}

function repoIgnorePathExcluded(rel, excludeGlob) {
    const normalized = String(rel || '').replace(/\\/g, '/');
    const parent = normalized.split('/').slice(0, -1).join('/');
    return Boolean(parent && pathExcluded(parent, excludeGlob));
}

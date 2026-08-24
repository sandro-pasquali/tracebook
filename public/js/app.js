// Surface any unhandled JS errors directly into the footer so we don't need
// DevTools open to see what's wrong.
//
window.addEventListener('error', (ev) => {
    showError(ev?.message || 'unknown_error');
});
window.addEventListener('unhandledrejection', (ev) => {
    showError(ev?.reason?.message || String(ev?.reason || 'unhandled_rejection'));
});

function showError(message) {
    const target = document.getElementById('footer-meta');
    if(!target) return;
    const err = document.createElement('span');
    err.className = 'error';
    err.textContent = `error: ${message}`;
    target.appendChild(err);
}

import {openSourceFile} from './components/_base.js';
import './components/annotated-code-excerpt.js';
import {reinitMermaidTheme} from './components/sequence-diagram.js';
import './components/evidence-callout.js';
import './components/unsupported.js';

import {createChapterNavigation} from './app/chapter-nav.js';
import {createChangeBriefs} from './app/change-briefs.js';
import {createRuntimeStatus} from './app/runtime-status.js';
import {createSessionsPanel} from './app/sessions-panel.js';
import {createStoryHistory, makeStoryId} from './app/story-history.js';
import {createSourceContext} from './app/source-context.js';
import {createStoryRunner} from './app/story-runner.js';
import {clearStoryUrl, storyIdFromLocation, writeStoryUrl} from './app/story-url.js';
import {createStoryView} from './app/story-view.js';
import {apiFetch, ensureRepoSelected} from './app/team-context.js';
import {renderTeamRouteIfNeeded} from './app/team-shell.js';

const teamRouteHandled = await renderTeamRouteIfNeeded();
if(!teamRouteHandled && await ensureRepoSelected()) {
    const form = document.getElementById('ask-form');
    const input = document.getElementById('ask-input');
    const button = document.getElementById('ask-button');
    const askTooltip = document.getElementById('ask-tooltip');
    const chapterNav = document.getElementById('chapter-nav');
    const brandMark = document.querySelector('.brand-mark');
    const titleRail = document.getElementById('title-rail');
    const explorationRail = document.getElementById('exploration-rail');
    const narrativeRail = document.getElementById('narrative-rail');
    const outletRoot = document.getElementById('outlet');
    const footerRail = document.getElementById('footer-rail');
    const footerMeta = document.getElementById('footer-meta');
    const newStoryButton = document.getElementById('new-story-button');
    const regenerateButton = document.getElementById('regenerate-story-button');
    const sessionsButton = document.getElementById('sessions-button');
    const sessionsPanel = document.getElementById('sessions-panel');
    const sessionsClose = document.getElementById('sessions-close');
    const sessionsSearch = document.getElementById('sessions-search');
    const sessionsList = document.getElementById('sessions-list');
    const jumpBottom = document.getElementById('jump-bottom');
    const statusPill = document.getElementById('status-pill');
    const themePickerButton = document.getElementById('theme-picker-button');
    const themeMenu = document.getElementById('theme-menu');
    const STORY_FRESHNESS_POLL_MS = 2500;
    const LAST_VIEWED_STORY_KEY = 'tracebook-last-viewed-story';
    let storyFreshnessTimer = null;
    let storyRegenerationInFlight = false;
    let storyRunner = null;
    let sessions = null;
    const runtimeStatus = createRuntimeStatus({
        input,
        button,
        statusPill,
        setStatusCrumb,
        isStoryRunning: () => storyRunner?.isRunning()
    });
    const chapterNavigation = createChapterNavigation({
        chapterNav,
        getChapters: () => storySession.chapters
    });
    sessions = createSessionsPanel({
        button: sessionsButton,
        panel: sessionsPanel,
        closeButton: sessionsClose,
        searchInput: sessionsSearch,
        list: sessionsList,
        onLoadTrace: (traceId) => storyHistory.loadTraceSession(traceId),
        onLoadStory: (storyId, options) => storyHistory.loadStorySession(storyId, options),
        onShowError: showError,
        onOpenChange: scheduleStoryFreshnessPoll,
        onNavigateAway: abortActiveRun,
        getCurrentStoryId: () => currentStoryId(),
        onStoryDeleted: forgetLastViewedStory,
        onSummariesChange: () => chapterNavigation.render()
    });

    const storySession = {
        storyId: makeStoryId(),
        createdAt: Date.now(),
        chapters: [],
        evidencePaths: new Map(),
        contextRail: null,
        blockRegistry: new Map(),
        sourceBlocks: new Map(),
        freshness: null
    };
    let storyView = null;
    let storyHistory = null;
    const sourceContext = createSourceContext({
        storySession,
        getActiveChapter: () => storyView?.getActiveChapter(),
        openSourceFile,
        onRegenerate: regenerateCurrentStory,
        onContextRender: syncFooterRegenerate
    });
    const {
        buildStoryContext,
        renderCrossRefs,
        handleDuplicateBlock,
        registerBlock,
        registerSourceBlocks,
        renderStoryContext,
        renderChapterSources,
        normalizeStoryFreshness
    } = sourceContext;
    storyView = createStoryView({
        storySession,
        titleRail,
        explorationRail,
        narrativeRail,
        outletRoot,
        footerRail,
        footerMeta,
        chapterNavigation,
        renderStoryContext,
        setStatusCrumb
    });
    const changeBriefs = createChangeBriefs({
        storyView,
        setStatusCrumb,
        showError
    });
    storyRunner = createStoryRunner({
        input,
        button,
        isRuntimeReady: runtimeStatus.isReady,
        pollRuntimeStatus: runtimeStatus.poll,
        updateRuntimeIndicator: runtimeStatus.updateIndicator,
        applyRuntimeReadiness: runtimeStatus.applyReadiness,
        hideRuntimeIndicator: runtimeStatus.hideIndicator,
        setComposerBusy: runtimeStatus.setComposerBusy,
        buildStoryContext,
        storyView,
        renderChapterSources,
        handleDuplicateBlock,
        renderCrossRefs,
        registerBlock,
        registerSourceBlocks,
        renderChangeBriefAction: changeBriefs.renderAction,
        setMeta,
        setStatusCrumb,
        persistStorySession: () => storyHistory.persistStorySession(),
        addSchemaNote,
        showError,
        hideAskTooltip
    });
    storyHistory = createStoryHistory({
        storySession,
        input,
        storyView,
        storyRunner,
        sessions,
        normalizeStoryFreshness,
        renderStoryContext,
        scheduleStoryFreshnessPoll,
        isFreshnessSuppressed: isStoryFreshnessSuppressed,
        rememberLastViewedStory,
        forgetLastViewedStory,
        getLastViewedStoryId,
        clearMissingStoryUrl,
        showError,
        hideAskTooltip,
        scrollToBottom,
        scrollToTop,
        setStatusCrumb
    });

    initThemeSwitcher();
    initNewStoryButton();
    initRegenerateButton();
    initMermaidRepairPersistence();
    initSessionsPanel();
    initBottomControls();
    initChapterNav();
    initRuntimeWarmupIndicator();
    initRuntimeStatus();

    storyView.initFirstChapter();
    storyHistory.maybeReplayFromUrl();
    refreshStoryNavigation();
    document.addEventListener('pointerdown', handleGlobalPointerDown);
    window.addEventListener('keydown', handleGlobalKeydown, {capture: true});
    runtimeStatus.focusAskInput();

    let repairPersistTimer = null;

    function initMermaidRepairPersistence() {
        document.addEventListener('mermaid:repaired', (ev) => {
            const {componentId, mermaid} = ev.detail || {};
            if(componentId && mermaid && applyRepairedMermaidToSession(componentId, mermaid)) {
                scheduleRepairPersist();
            }
        });
    }

    function applyRepairedMermaidToSession(componentId, mermaid) {
        let changed = false;
        for(const chapter of storySession.chapters) {
            for(const event of chapter.events || []) {
                if(event?.type === 'component.patch' && event.id === componentId && event.props) {
                    event.props.mermaid = mermaid;
                    changed = true;
                }
            }
        }
        return changed;
    }

    function scheduleRepairPersist() {
        window.clearTimeout(repairPersistTimer);
        repairPersistTimer = window.setTimeout(() => {
            storyHistory.persistStorySession().catch((err) => showError(err?.message || 'story_persist_failed'));
        }, 800);
    }

    function currentStoryId() {
        return storyIdFromLocation() || storySession.storyId || '';
    }

    function refreshStoryNavigation() {
        sessions.fetchSummaries()
            .then(() => chapterNavigation.render())
            .catch(() => chapterNavigation.render());
    }

    function initSessionsPanel() {
        sessions.init();
    }

    function initNewStoryButton() {
        if(!newStoryButton) {
            return;
        }
        newStoryButton.addEventListener('click', () => {
            storyRunner.abort();
            startNewStory();
        });
    }

    function initRegenerateButton() {
        if(!regenerateButton) {
            return;
        }
        regenerateButton.addEventListener('click', () => regenerateCurrentStory());
    }

    function syncFooterRegenerate() {
        if(!regenerateButton) {
            return;
        }
        const hasStory = !!storyView && storyView.currentStoryQuestions().length > 0;
        regenerateButton.hidden = !hasStory;
    }

    function startNewStory() {
        storyRegenerationInFlight = false;
        storySession.storyId = makeStoryId();
        storySession.createdAt = Date.now();
        sessions.setOpen(false);
        storyView.resetSession('');
        syncFooterRegenerate();
        setStatusCrumb('');
        input.value = '';
        if(runtimeStatus.isReady()) {
            runtimeStatus.setComposerBusy(false);
        } else {
            runtimeStatus.setComposerBusy(true);
        }
        const url = new URL(location.href);
        url.pathname = '/';
        url.searchParams.delete('story');
        url.searchParams.delete('trace');
        history.replaceState(null, '', url);
        forgetLastViewedStory();
        scheduleStoryFreshnessPoll();
        runtimeStatus.focusAskInput();
        scrollToBottom({smooth: true});
    }

    function rememberLastViewedStory(storyId) {
        const value = String(storyId || '').trim();
        if(!value) {
            return;
        }
        try {
            localStorage.setItem(LAST_VIEWED_STORY_KEY, value);
        } catch {}
    }

    function forgetLastViewedStory(storyId = '') {
        try {
            if(!storyId) {
                localStorage.removeItem(LAST_VIEWED_STORY_KEY);
                return;
            }
            if(localStorage.getItem(LAST_VIEWED_STORY_KEY) === storyId) {
                localStorage.removeItem(LAST_VIEWED_STORY_KEY);
            }
        } catch {}
    }

    function getLastViewedStoryId() {
        try {
            return localStorage.getItem(LAST_VIEWED_STORY_KEY) || '';
        } catch {
            return '';
        }
    }

    function abortActiveRun() {
        storyRunner.abort();
    }

    function initBottomControls() {
        if(jumpBottom) {
            jumpBottom.addEventListener('click', () => scrollToBottom({smooth: true}));
        }
        window.addEventListener('scroll', updateJumpBottomState, {passive: true});
        updateJumpBottomState();
    }

    function initChapterNav() {
        chapterNavigation.init();
    }

    function initRuntimeWarmupIndicator() {
        window.addEventListener('focus', pollStoryFreshnessIfNeeded);
        document.addEventListener('visibilitychange', () => {
            if(document.visibilityState === 'visible') {
                pollStoryFreshnessIfNeeded();
            }
        });
    }

    function initRuntimeStatus() {
        runtimeStatus.init();
    }

    function pollStoryFreshnessIfNeeded() {
        if(isStoryFreshnessSuppressed()) {
            return;
        }
        if(shouldPollStoryFreshness()) {
            refreshStoryFreshnessTargets().catch((err) => showError(err?.message || 'story_freshness_failed'));
        }
    }

    function isStoryFreshnessSuppressed() {
        return storyRegenerationInFlight;
    }

    function shouldPollStoryFreshness() {
        if(isStoryFreshnessSuppressed()) {
            return false;
        }
        return Boolean(storyIdFromLocation() || sessions.isOpen());
    }

    async function refreshLoadedStoryFreshness() {
        if(isStoryFreshnessSuppressed()) {
            return;
        }
        const storyId = storyIdFromLocation();
        if(!storyId) {
            return;
        }
        const res = await apiFetch(`/api/stories/${encodeURIComponent(storyId)}`);
        if(!res.ok) {
            if(res.status === 404) {
                clearMissingStoryUrl(storyId);
            }
            return;
        }
        const story = await res.json();
        if(isStoryFreshnessSuppressed()) {
            return;
        }
        storySession.freshness = normalizeStoryFreshness(story);
        renderStoryContext();
    }

    async function refreshStoryFreshnessTargets() {
        if(isStoryFreshnessSuppressed()) {
            return;
        }
        sessions.invalidate();
        if(sessions.isOpen()) {
            await sessions.loadList({showLoading: false});
        }
        await refreshLoadedStoryFreshness();
        scheduleStoryFreshnessPoll();
    }

    function scheduleStoryFreshnessPoll() {
        window.clearTimeout(storyFreshnessTimer);
        storyFreshnessTimer = null;
        if(!shouldPollStoryFreshness()) {
            return;
        }
        storyFreshnessTimer = window.setTimeout(() => {
            storyFreshnessTimer = null;
            refreshStoryFreshnessTargets().catch((err) => showError(err?.message || 'story_freshness_failed'));
        }, STORY_FRESHNESS_POLL_MS);
    }

    function clearMissingStoryUrl(storyId) {
        if(clearStoryUrl(storyId)) {
            scheduleStoryFreshnessPoll();
        }
    }

    function handleGlobalPointerDown(ev) {
        if(!chapterNavigation.contains(ev.target)) {
            chapterNavigation.closeMenu();
        }
        sessions.handlePointerDown(ev);
    }

    function handleGlobalKeydown(ev) {
        if(runtimeStatus.handleOverlayKeydown(ev)) {
            return;
        }
        if(ev.key === 'Escape') {
            chapterNavigation.closeMenu();
            sessions.clearDeleteConfirm();
            return;
        }
        if(!isStoryNavigationKey(ev)) {
            return;
        }

        if(ev.key === 'ArrowUp') {
            if(!chapterNavigation.hasMultipleChapters()) {
                return;
            }
            consumeStoryNavigationEvent(ev);
            chapterNavigation.step(-1, {wrap: true});
            return;
        }
        if(ev.key === 'ArrowDown') {
            if(!chapterNavigation.hasMultipleChapters()) {
                return;
            }
            consumeStoryNavigationEvent(ev);
            chapterNavigation.step(1, {wrap: true});
            return;
        }
        if(ev.key === 'ArrowLeft') {
            consumeStoryNavigationEvent(ev);
            sessions.navigate(-1);
            return;
        }
        if(ev.key === 'ArrowRight') {
            consumeStoryNavigationEvent(ev);
            sessions.navigate(1);
        }
    }

    function isStoryNavigationKey(ev) {
        if(!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(ev.key)) {
            return false;
        }
        if(ev.altKey || ev.ctrlKey || ev.metaKey || !ev.shiftKey) {
            return false;
        }
        return !document.querySelector('.mermaid-fullscreen');
    }

    function consumeStoryNavigationEvent(ev) {
        ev.preventDefault();
        ev.stopPropagation();
    }

    function initThemeSwitcher() {
        if(!themePickerButton || !themeMenu) {
            return;
        }
        const themes = new Set(['daylight', 'workbench', 'manuscript', 'boardroom', 'forensic']);
        const legacy = { light: 'workbench', dark: 'forensic' };
        const items = Array.from(themeMenu.querySelectorAll('.theme-menu-item'));

        // Each theme's palette as a flat list (surfaces, accents, text tones),
        // rendered as a square grid; leftover cells repeat the last color.
        //
        const palettes = {
            daylight: ['#fbfaf7', '#f2efe8', '#e8e3d8', '#1f8a5b', '#2570c4', '#9a6f0c', '#c24a2f', '#2b2a26', '#55524b'],
            workbench: ['#eaeaea', '#dcdcdc', '#d0d0d0', '#0d6e6e', '#188daf', '#876900', '#b04020', '#1e1e1e', '#4a4a4a'],
            manuscript: ['#f4ecdd', '#ece2cf', '#e2d6bd', '#4a7c59', '#3f6f8f', '#9a6a17', '#a44a3a', '#3a2f26', '#5f5140'],
            boardroom: ['#eef1f5', '#e3e8ef', '#d6dde7', '#0f766e', '#2563a8', '#8a6d1c', '#b4463d', '#1f2733', '#46505e'],
            forensic: ['#0e1013', '#161a20', '#1e242c', '#3ddc84', '#38bdf8', '#fbbf24', '#ff5c5c', '#e9eef3', '#aeb8c2']
        };
        const renderPaletteGrid = (host, colors) => {
            if(!host || !colors || colors.length === 0) {
                return;
            }
            const size = Math.ceil(Math.sqrt(colors.length));
            const last = colors[colors.length - 1];
            host.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
            const cells = Array.from({length: size * size}, (_, i) => {
                const cell = document.createElement('span');
                cell.className = 'theme-grid-cell';
                cell.style.background = i < colors.length ? colors[i] : last;
                return cell;
            });
            host.replaceChildren(...cells);
        };
        for(const item of items) {
            renderPaletteGrid(item.querySelector('.theme-grid'), palettes[item.dataset.themeId]);
        }

        const normalize = (name) => {
            if(themes.has(name)) {
                return name;
            }
            if(legacy[name]) {
                return legacy[name];
            }
            return 'daylight';
        };

        const reflect = (theme) => {
            for(const item of items) {
                item.setAttribute('aria-checked', String(item.dataset.themeId === theme));
            }
        };

        function onDocumentClick(ev) {
            if(!themeMenu.contains(ev.target) && !themePickerButton.contains(ev.target)) {
                closeMenu();
            }
        }

        function onKeydown(ev) {
            if(ev.key === 'Escape') {
                closeMenu();
                themePickerButton.focus();
            }
        }

        const openMenu = () => {
            if(!themeMenu.hidden) {
                return;
            }
            themeMenu.hidden = false;
            themePickerButton.setAttribute('aria-expanded', 'true');
            document.addEventListener('click', onDocumentClick, true);
            document.addEventListener('keydown', onKeydown, true);
        };

        const closeMenu = () => {
            if(themeMenu.hidden) {
                return;
            }
            themeMenu.hidden = true;
            themePickerButton.setAttribute('aria-expanded', 'false');
            document.removeEventListener('click', onDocumentClick, true);
            document.removeEventListener('keydown', onKeydown, true);
        };

        const apply = (name) => {
            const theme = normalize(name);
            document.documentElement.setAttribute('data-theme', theme);
            try { localStorage.setItem('tracebook-theme', theme); } catch {}
            reflect(theme);
            reinitMermaidTheme();
        };

        reflect(normalize(document.documentElement.getAttribute('data-theme')));

        themePickerButton.addEventListener('click', () => {
            if(themeMenu.hidden) {
                openMenu();
            } else {
                closeMenu();
            }
        });

        for(const item of items) {
            item.addEventListener('click', () => {
                apply(item.dataset.themeId);
                closeMenu();
                themePickerButton.focus();
            });
        }
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        await submitQuestionFromInput();
    });

    async function submitQuestionFromInput() {
        const question = input.value.trim();
        if(!question) {
            showAskTooltip();
            return;
        }
        await runStoryQuestion(question);
    }

    async function runStoryQuestion(question, {forceFresh = false} = {}) {
        await storyRunner.run(question, {forceFresh});
        syncFooterRegenerate();
    }

    input.addEventListener('input', () => {
        if(input.value.trim()) {
            hideAskTooltip();
        }
    });

    function showAskTooltip() {
        if(!askTooltip) {
            return;
        }
        askTooltip.classList.add('is-visible');
        input.setAttribute('aria-invalid', 'true');
        try {
            input.focus({preventScroll: true});
        } catch {
            input.focus();
        }
        window.clearTimeout(showAskTooltip._timer);
        showAskTooltip._timer = window.setTimeout(hideAskTooltip, 2600);
    }

    function hideAskTooltip() {
        if(!askTooltip) {
            return;
        }
        askTooltip.classList.remove('is-visible');
        input.removeAttribute('aria-invalid');
        window.clearTimeout(showAskTooltip._timer);
    }

    async function regenerateCurrentStory() {
        if(storyRegenerationInFlight) {
            return;
        }

        const questions = storyView.currentStoryQuestions();
        if(questions.length === 0) {
            try {
                input.focus({preventScroll: true});
            } catch {
                input.focus();
            }
            return;
        }
        storyRunner.abort();

        const storyId = storyIdFromLocation() || storySession.storyId;
        if(!storyId) {
            return;
        }
        const createdAt = storySession.createdAt || Date.now();
        storyRegenerationInFlight = true;
        window.clearTimeout(storyFreshnessTimer);
        button.disabled = true;
        if(regenerateButton) {
            regenerateButton.disabled = true;
        }

        try {
            storySession.storyId = storyId;
            storySession.createdAt = createdAt;
            storyView.resetSession('');
            storySession.storyId = storyId;
            storySession.createdAt = createdAt;
            storySession.freshness = null;
            renderStoryContext();
            input.value = '';
            hideAskTooltip();

            writeStoryUrl(storyId);

            for(const question of questions) {
                if(!storyRegenerationInFlight) {
                    break;
                }
                await runStoryQuestion(question, {forceFresh: true});
                await storyRunner.waitForPersist();
            }
        } finally {
            storyRegenerationInFlight = false;
            button.disabled = false;
            if(regenerateButton) {
                regenerateButton.disabled = false;
            }
            await refreshStoryFreshnessTargets().catch((err) => showError(err?.message || 'story_freshness_failed'));
        }
    }

    function setMeta({traceId, model, durationMs, usage, timing}) {
        footerMeta.innerHTML = '';
        if(traceId) addMeta(`trace ${traceId}`);
        if(model) addMeta('model', model);
        if(typeof durationMs === 'number') addMeta('took', `${(durationMs / 1000).toFixed(2)}s`);
        if(usage?.totalTokens) addMeta('tokens', String(usage.totalTokens));
        if(timing) {
            const ttftSynth = findCheckpoint(timing, 'synthesis.firstToken');
            const ttftExpl = findCheckpoint(timing, 'exploration.firstToken');
            const explEnd = findCheckpoint(timing, 'exploration.end');
            if(ttftExpl) addMeta('expl ttft', `${ttftExpl.sinceStart}ms`);
            if(explEnd) addMeta('expl', `${(explEnd.sinceStart / 1000).toFixed(2)}s`);
            if(ttftSynth) addMeta('synth ttft', `${ttftSynth.sinceStart - (explEnd?.sinceStart || 0)}ms`);
        }
    }

    function scrollToBottom({smooth = false} = {}) {
        window.scrollTo({
            top: document.documentElement.scrollHeight,
            behavior: smooth ? 'smooth' : 'auto'
        });
    }

    function scrollToTop({smooth = false} = {}) {
        window.scrollTo({
            top: 0,
            behavior: smooth ? 'smooth' : 'auto'
        });
    }

    function updateJumpBottomState() {
        if(!jumpBottom) {
            return;
        }
        const distance = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
        const nearBottom = distance < 160;
        jumpBottom.classList.toggle('is-visible', !nearBottom);
    }

    function findCheckpoint(timing, name) {
        if(!timing || !Array.isArray(timing.checkpoints)) return null;
        return timing.checkpoints.find((c) => c.name === name) || null;
    }

    function addMeta(label, value) {
        const meta = document.createElement('span');
        meta.className = 'meta';
        if(value === undefined) {
            meta.textContent = label;
        } else {
            meta.innerHTML = `${label} <span class="v"></span>`;
            meta.querySelector('.v').textContent = value;
        }
        footerMeta.appendChild(meta);
    }

    function addSchemaNote(message) {
        const target = document.getElementById('footer-meta');
        if(!target) return;
        const note = document.createElement('span');
        note.className = 'schema-note';
        note.textContent = message;
        target.appendChild(note);
    }

    function setStatusCrumb(text) {
        const value = text || '';
        brandMark?.classList.toggle('is-working', /\b(indexing|exploring|composing|streaming)\b/i.test(value));
        if(!statusPill) {
            return;
        }
        statusPill.textContent = value;
        statusPill.classList.toggle('is-active', !!value);
        statusPill.classList.toggle('is-composing', /\b(composing|streaming)\b/i.test(value));
        statusPill.classList.toggle('is-exploring', /\bexploring\b/i.test(value));
    }

    const renderedNarrativeStateReset = () => {
        storyView.resetNarrativeLength();
    };
    form.addEventListener('submit', renderedNarrativeStateReset);
}

import {createOutlet} from '../runtime/outlet.js';

export function createStoryView({
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
} = {}) {
    const renderedNarrativeLength = {value: 0};
    let activeChapter = null;
    let timingByName = {};

    function initFirstChapter() {
        const contextRail = document.createElement('section');
        contextRail.className = 'story-context-rail';
        contextRail.setAttribute('aria-live', 'polite');
        titleRail.before(contextRail);
        storySession.contextRail = contextRail;

        const firstCrossRefs = document.createElement('section');
        firstCrossRefs.className = 'cross-ref-rail';
        firstCrossRefs.setAttribute('aria-live', 'polite');
        outletRoot.after(firstCrossRefs);
        const firstBriefRail = document.createElement('section');
        firstBriefRail.className = 'change-brief-rail';
        firstBriefRail.setAttribute('aria-live', 'polite');
        titleRail.after(firstBriefRail);
        const firstSourceRail = document.createElement('section');
        firstSourceRail.className = 'chapter-source-rail';
        firstSourceRail.setAttribute('aria-live', 'polite');
        narrativeRail.after(firstSourceRail);

        activeChapter = {
            index: 0,
            question: '',
            title: '',
            narrative: [],
            root: null,
            titleRail,
            explorationRail,
            narrativeRail,
            sourceRail: firstSourceRail,
            outletRoot,
            briefRail: firstBriefRail,
            footerRail,
            outlet: createOutlet({root: outletRoot}),
            crossRefRail: firstCrossRefs,
            crossRefs: new Set(),
            evidenceRefs: new Set(),
            countedEvidenceRefs: new Set(),
            events: [],
            traceId: ''
        };
        storySession.chapters = [activeChapter];
        chapterNavigation.setVisibleIndex(0);
        resetTitle();
        chapterNavigation.render();
    }

    function startChapter(question) {
        renderedNarrativeLength.value = 0;

        if(storySession.chapters.length === 1 && storySession.chapters[0].question === '') {
            activeChapter = storySession.chapters[0];
            activeChapter.question = question;
            activeChapter.title = '';
            activeChapter.narrative = [];
            activeChapter.events = [];
            activeChapter.traceId = '';
            activeChapter.crossRefs.clear();
            activeChapter.evidenceRefs.clear();
            activeChapter.countedEvidenceRefs?.clear();
            clearChapter(activeChapter);
            setChapterPlaceholder(activeChapter, question);
            chapterNavigation.setVisibleIndex(activeChapter.index);
            chapterNavigation.render();
            return activeChapter;
        }

        const root = document.createElement('section');
        root.className = 'story-chapter';

        const followup = createFollowupMarker(question);

        const chapterTitle = document.createElement('section');
        chapterTitle.className = 'title-rail';
        chapterTitle.setAttribute('aria-live', 'polite');
        const chapterExploration = document.createElement('section');
        chapterExploration.className = 'exploration-rail';
        chapterExploration.setAttribute('aria-live', 'polite');
        const chapterNarrative = document.createElement('section');
        chapterNarrative.className = 'narrative-rail';
        chapterNarrative.setAttribute('aria-live', 'polite');
        const chapterSources = document.createElement('section');
        chapterSources.className = 'chapter-source-rail';
        chapterSources.setAttribute('aria-live', 'polite');
        const chapterOutlet = document.createElement('section');
        chapterOutlet.className = 'outlet';
        chapterOutlet.setAttribute('aria-live', 'polite');
        const briefRail = document.createElement('section');
        briefRail.className = 'change-brief-rail';
        briefRail.setAttribute('aria-live', 'polite');
        const crossRefs = document.createElement('section');
        crossRefs.className = 'cross-ref-rail';
        crossRefs.setAttribute('aria-live', 'polite');

        root.append(followup, chapterTitle, briefRail, chapterExploration, chapterNarrative, chapterSources, chapterOutlet, crossRefs);
        footerRail.parentNode.insertBefore(root, footerRail);

        const chapterIndex = storySession.chapters.length;
        root.dataset.chapterIndex = String(chapterIndex);
        activeChapter = {
            index: chapterIndex,
            question,
            title: '',
            narrative: [],
            root,
            titleRail: chapterTitle,
            explorationRail: chapterExploration,
            narrativeRail: chapterNarrative,
            sourceRail: chapterSources,
            outletRoot: chapterOutlet,
            briefRail,
            footerRail,
            outlet: createOutlet({root: chapterOutlet}),
            crossRefRail: crossRefs,
            crossRefs: new Set(),
            evidenceRefs: new Set(),
            countedEvidenceRefs: new Set(),
            events: [],
            traceId: ''
        };
        storySession.chapters.push(activeChapter);
        setChapterPlaceholder(activeChapter, question);
        chapterNavigation.setVisibleIndex(activeChapter.index);
        chapterNavigation.render();
        return activeChapter;
    }

    function resetSession(question = '') {
        for(const chapter of storySession.chapters.slice(1)) {
            if(chapter.root) {
                chapter.root.remove();
            }
        }
        storySession.chapters = [storySession.chapters[0]];
        storySession.freshness = null;
        storySession.evidencePaths.clear();
        storySession.blockRegistry.clear();
        storySession.sourceBlocks.clear();
        renderStoryContext();
        activeChapter = storySession.chapters[0];
        activeChapter.question = question;
        activeChapter.title = '';
        activeChapter.narrative = [];
        activeChapter.events = [];
        activeChapter.traceId = '';
        activeChapter.crossRefs.clear();
        activeChapter.evidenceRefs.clear();
        activeChapter.countedEvidenceRefs?.clear();
        clearChapter(activeChapter);
        renderedNarrativeLength.value = 0;
        if(question) {
            setChapterPlaceholder(activeChapter, question);
        } else {
            resetTitle();
        }
        chapterNavigation.setVisibleIndex(activeChapter.index);
        chapterNavigation.render();
    }

    function beginReplayChapter(chapter, index) {
        if(index === 0) {
            activeChapter = storySession.chapters[0];
            activeChapter.question = chapter.question || '';
            activeChapter.title = '';
            activeChapter.narrative = [];
            activeChapter.events = [];
            activeChapter.traceId = chapter.traceId || '';
            activeChapter.crossRefs.clear();
            activeChapter.evidenceRefs.clear();
            activeChapter.countedEvidenceRefs?.clear();
            clearChapter(activeChapter);
            setChapterPlaceholder(activeChapter, chapter.question || 'Loaded story');
            return activeChapter;
        }
        const next = startChapter(chapter.question || 'Continued story');
        next.traceId = chapter.traceId || '';
        return next;
    }

    function finishReplayChapter(chapter) {
        if(!activeChapter) {
            return;
        }
        activeChapter.events = chapter.events || [];
        activeChapter.traceId = chapter.traceId || activeChapter.traceId || '';
    }

    function getActiveChapter() {
        return activeChapter;
    }

    function recordEvent(event, {isReplaying = false} = {}) {
        if(activeChapter && !isReplaying) {
            activeChapter.events.push(event);
        }
    }

    function setActiveTraceId(traceId) {
        if(activeChapter) {
            activeChapter.traceId = traceId;
        }
    }

    function setActiveTitle(title) {
        setTitle(title);
        if(activeChapter) {
            activeChapter.title = title;
        }
        chapterNavigation.render();
    }

    function applyComponentEvent(event) {
        activeChapter?.outlet?.applyEvent(event);
    }

    function resetNarrativeLength() {
        renderedNarrativeLength.value = 0;
    }

    function currentStoryQuestions() {
        return storySession.chapters
            .map((chapter) => String(chapter?.question || '').trim())
            .filter(Boolean);
    }

    function resetTiming() {
        timingByName = {};
    }

    function handleTiming(event, {suppressStatus = false} = {}) {
        if(event.name === 'tool' && event.tool) {
            timingByName[`tool:${event.tool}`] = (timingByName[`tool:${event.tool}`] || 0) + (event.durationMs || 0);
        } else if(typeof event.sinceStart === 'number') {
            timingByName[event.name] = event.sinceStart;
        }
        if(event.name === 'exploration.firstToken' || event.name === 'synthesis.firstToken') {
            if(!suppressStatus) {
                setStatusCrumb(`${event.name === 'exploration.firstToken' ? 'exploring' : 'composing'} · ttft ${event.sinceStart}ms`);
            }
        }
    }

    function activeTitleRail() {
        return activeChapter?.titleRail || titleRail;
    }

    function activeExplorationRail() {
        return activeChapter?.explorationRail || explorationRail;
    }

    function activeNarrativeRail() {
        return activeChapter?.narrativeRail || narrativeRail;
    }

    function createFollowupMarker(question) {
        const marker = document.createElement('div');
        marker.className = 'followup-marker';
        const prompt = document.createElement('span');
        prompt.className = 'followup-prompt';
        prompt.textContent = question;
        marker.appendChild(prompt);
        return marker;
    }

    function clearChapter(chapter) {
        chapter.titleRail.innerHTML = '';
        chapter.titleRail.classList.remove('has-change-brief-action');
        chapter.explorationRail.innerHTML = '';
        chapter.narrativeRail.innerHTML = '';
        if(chapter.sourceRail) {
            chapter.sourceRail.innerHTML = '';
        }
        if(chapter.briefRail) {
            chapter.briefRail.innerHTML = '';
        }
        chapter.outlet.clear();
        if(chapter.crossRefRail) {
            chapter.crossRefRail.innerHTML = '';
        }
        footerMeta.innerHTML = '';
    }

    function setChapterPlaceholder(chapter, question) {
        chapter.titleRail.innerHTML = '';
        const placeholder = document.createElement('p');
        placeholder.className = 'placeholder';
        placeholder.textContent = `Composing the next chapter: "${question}"`;
        chapter.titleRail.appendChild(placeholder);
    }

    function renderReplayBanner(event) {
        const banner = document.createElement('div');
        banner.className = 'replay-banner';
        const label = document.createElement('span');
        label.className = 'replay-label';
        label.textContent = event.source === 'paraphrase'
            ? 'answered from system memory · paraphrase of a prior question'
            : 'answered from memory · verbatim repeat';
        banner.appendChild(label);
        if(typeof event.ageMs === 'number') {
            const age = document.createElement('span');
            age.className = 'replay-age';
            age.textContent = `${Math.round(event.ageMs / 1000)}s ago`;
            banner.appendChild(age);
        }
        activeTitleRail().appendChild(banner);
    }

    function renderSimilarTraces(matches) {
        if(!matches || matches.length === 0) {
            return;
        }
        const banner = document.createElement('div');
        banner.className = 'similar-traces-banner';
        const title = document.createElement('span');
        title.className = 'similar-traces-title';
        title.textContent = 'system memory · similar prior questions';
        banner.appendChild(title);
        for(const m of matches) {
            const link = document.createElement('a');
            link.className = 'similar-trace';
            link.href = `?trace=${encodeURIComponent(m.traceId)}`;
            link.target = '_blank';
            link.rel = 'noopener';
            link.title = m.summary || '';
            const sim = typeof m.similarity === 'number' ? ` · sim ${m.similarity.toFixed(2)}` : '';
            link.textContent = `${m.question}${sim}`;
            banner.appendChild(link);
        }
        activeExplorationRail().insertBefore(banner, activeExplorationRail().firstChild);
    }

    function setComposingState() {
        const placeholder = activeTitleRail().querySelector('.placeholder');
        if(placeholder) {
            placeholder.textContent = 'Composing the answer…';
            placeholder.classList.add('composing');
        }
    }

    function appendExplorationCall(tool, inputSummary) {
        const row = document.createElement('div');
        row.className = 'exploration-step call';
        row.dataset.tool = tool || '';

        const g = document.createElement('span');
        g.className = 'glyph';
        g.textContent = '→';

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = tool || 'tool';

        const arg = document.createElement('span');
        arg.className = 'arg';
        arg.textContent = inputSummary || '';

        row.append(g, name, arg);
        appendExplorationStep(row);
    }

    function appendExplorationResult(tool, summary) {
        const row = document.createElement('div');
        row.className = 'exploration-step result';

        const arrow = document.createElement('span');
        arrow.className = 'arrow';
        arrow.textContent = '⤿';

        const text = document.createElement('span');
        text.textContent = summary || '';

        row.append(arrow, text);
        appendExplorationStep(row);
    }

    function appendExplorationStep(row) {
        const log = ensureExplorationLog(activeExplorationRail());
        log.history.appendChild(row);

        const latest = row.cloneNode(true);
        latest.classList.add('latest');
        log.latest.innerHTML = '';
        log.latest.appendChild(latest);

        const count = log.history.querySelectorAll('.exploration-step').length;
        log.summary.textContent = count === 1
            ? 'show exploration history · 1 step'
            : `show exploration history · ${count} steps`;
    }

    function ensureExplorationLog(rail) {
        let wrap = rail.querySelector(':scope > .exploration-log');
        if(wrap) {
            return {
                wrap,
                latest: wrap.querySelector('.exploration-latest'),
                history: wrap.querySelector('.exploration-history-list'),
                summary: wrap.querySelector('.exploration-history summary')
            };
        }

        wrap = document.createElement('div');
        wrap.className = 'exploration-log';

        const latest = document.createElement('div');
        latest.className = 'exploration-latest';

        const history = document.createElement('details');
        history.className = 'exploration-history';
        const summary = document.createElement('summary');
        summary.textContent = 'show exploration history';
        const list = document.createElement('div');
        list.className = 'exploration-history-list';
        history.append(summary, list);

        wrap.append(latest, history);
        rail.appendChild(wrap);
        return {wrap, latest, history: list, summary};
    }

    function resetTitle() {
        activeTitleRail().innerHTML = '';
        const placeholder = document.createElement('p');
        placeholder.className = 'placeholder';
        placeholder.textContent = 'Start with the product story you need to understand or change.';
        activeTitleRail().appendChild(placeholder);
    }

    function setTitle(title) {
        activeTitleRail().innerHTML = '';
        const h1 = document.createElement('h1');
        h1.textContent = title;
        activeTitleRail().appendChild(h1);
    }

    function appendNarrative(startIndex, items) {
        if(startIndex < renderedNarrativeLength.value) {
            return 0;
        }
        for(let i = 0; i < items.length; i++) {
            const step = document.createElement('div');
            step.className = 'narrative-step';
            const n = document.createElement('span');
            n.className = 'n';
            n.textContent = String(startIndex + i + 1).padStart(2, '0');
            const t = document.createElement('span');
            t.className = 't';
            t.textContent = items[i];
            step.append(n, t);
            activeNarrativeRail().appendChild(step);
            if(activeChapter) {
                activeChapter.narrative[startIndex + i] = items[i];
            }
        }
        renderedNarrativeLength.value = startIndex + items.length;
        return items.length;
    }

    return {
        initFirstChapter,
        startChapter,
        resetSession,
        beginReplayChapter,
        finishReplayChapter,
        getActiveChapter,
        recordEvent,
        setActiveTraceId,
        setActiveTitle,
        applyComponentEvent,
        resetNarrativeLength,
        currentStoryQuestions,
        resetTiming,
        handleTiming,
        renderReplayBanner,
        renderSimilarTraces,
        setComposingState,
        appendExplorationCall,
        appendExplorationResult,
        appendNarrative
    };
}

export function createSourceContext({
    storySession,
    getActiveChapter,
    openSourceFile,
    onRegenerate,
    onContextRender
} = {}) {
    function activeChapter() {
        return getActiveChapter?.() || null;
    }

    function buildStoryContext() {
        const chapters = storySession.chapters
            .filter((chapter) => chapter.question || chapter.title || chapter.narrative.length > 0)
            .slice(-4)
            .map((chapter) => ({
                question: chapter.question || '',
                title: chapter.title || '',
                narrative: chapter.narrative.filter(Boolean).slice(0, 5),
                sourcePaths: [...chapter.evidenceRefs].slice(0, 8)
            }));

        return {
            chapters,
            sourcePaths: [...storySession.evidencePaths.keys()].slice(0, 12)
        };
    }

    function renderCrossRefs(event) {
        const refs = Array.isArray(event?.props?.sourceRefs) ? event.props.sourceRefs : [];
        if(!refs.length) {
            return;
        }

        const updates = rememberEvidenceRefs(refs);
        renderStoryContext();

        const chapter = activeChapter();
        if(!chapter?.crossRefRail) {
            return;
        }

        const repeated = updates.filter((u) => u.count > 1);
        if(!repeated.length) {
            return;
        }
        for(const item of repeated) {
            if(chapter.crossRefs.has(item.path)) {
                continue;
            }
            const prior = previousSourceBlock(item.path, event.id);
            if(!prior) {
                continue;
            }
            chapter.crossRefs.add(item.path);
            const display = sourceItemDisplay(item);
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `cross-ref-chip is-${sourceRoleClass(display.role)}`;
            chip.title = `Jump to earlier block using ${item.path}`;
            chip.textContent = display.role === 'dependency'
                ? `${display.roleLabel} ${display.pathLabel}`
                : `reused source: ${item.path}`;
            chip.addEventListener('click', () => scrollToSourceBlock(prior));
            chapter.crossRefRail.appendChild(chip);
        }
    }

    function handleDuplicateBlock(event) {
        const chapter = activeChapter();
        const fingerprint = blockFingerprint(event);
        if(!fingerprint || !chapter) {
            return false;
        }
        const prior = storySession.blockRegistry.get(fingerprint);
        if(!prior || prior.chapterIndex === chapter.index && prior.componentId === event.id) {
            return false;
        }
        chapter.outlet.remove(event.id);
        renderDuplicateBlockNote(event, prior, chapter);
        renderCrossRefs(event);
        return true;
    }

    function registerBlock(event) {
        const chapter = activeChapter();
        const fingerprint = blockFingerprint(event);
        if(!fingerprint || !chapter) {
            return;
        }
        const existing = storySession.blockRegistry.get(fingerprint);
        if(existing && !(existing.chapterIndex === chapter.index && existing.componentId === event.id)) {
            return;
        }
        const anchorId = `block-${fingerprint.slice(0, 16)}`;
        setTimeout(() => {
            const el = chapter?.outlet?.getElement(event.id);
            if(el) {
                el.id = anchorId;
            }
        }, 0);
        storySession.blockRegistry.set(fingerprint, {
            fingerprint,
            anchorId,
            componentId: event.id,
            chapterIndex: chapter.index,
            title: event.props?.caption || event.props?.summary || event.id,
            type: event.componentType
        });
    }

    function registerSourceBlocks(event) {
        const refs = Array.isArray(event?.props?.sourceRefs) ? event.props.sourceRefs : [];
        const chapter = activeChapter();
        if(!refs.length || !chapter?.outlet) {
            return;
        }
        const element = chapter.outlet.getElement(event.id);
        if(!element) {
            return;
        }
        const paths = new Set(refs.map((ref) => ref?.path).filter(Boolean));
        for(const sourcePath of paths) {
            const blocks = storySession.sourceBlocks.get(sourcePath) || [];
            const existing = blocks.find((block) => block.componentId === event.id);
            if(existing) {
                existing.element = element;
                existing.chapterIndex = chapter.index;
                continue;
            }
            blocks.push({
                path: sourcePath,
                componentId: event.id,
                chapterIndex: chapter.index,
                element
            });
            storySession.sourceBlocks.set(sourcePath, blocks);
        }
    }

    function previousSourceBlock(sourcePath, currentComponentId) {
        const blocks = storySession.sourceBlocks.get(sourcePath) || [];
        for(let index = blocks.length - 1; index >= 0; index--) {
            const block = blocks[index];
            if(block.componentId === currentComponentId) {
                continue;
            }
            const element = sourceBlockElement(block);
            if(element) {
                return {...block, element};
            }
        }
        return null;
    }

    function scrollToSourceBlock(block) {
        const element = sourceBlockElement(block);
        if(element) {
            element.scrollIntoView({behavior: 'smooth', block: 'center'});
        }
    }

    function sourceBlockElement(block) {
        if(block?.element?.isConnected) {
            return block.element;
        }
        if(!block?.componentId) {
            return null;
        }
        return document.querySelector(`[data-component-id="${cssEscape(block.componentId)}"]`);
    }

    function renderDuplicateBlockNote(event, prior, chapter) {
        const noteId = `duplicate-${event.id}`;
        let note = chapter.outletRoot.querySelector(`[data-duplicate-id="${cssEscape(noteId)}"]`);
        if(!note) {
            note = document.createElement('div');
            note.className = 'duplicate-block-note';
            note.dataset.duplicateId = noteId;
            note.setAttribute('data-component-index', String(event.index ?? 0));
            insertByComponentIndex(chapter.outletRoot, note, event.index ?? 0);
        }
        note.innerHTML = '';
        const label = document.createElement('span');
        label.className = 'duplicate-block-label';
        label.textContent = `${readableComponentType(event.componentType)} already shown above`;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'duplicate-block-link';
        button.textContent = prior.title || 'Jump to original';
        button.addEventListener('click', () => {
            const target = document.getElementById(prior.anchorId);
            if(target) {
                target.scrollIntoView({behavior: 'smooth', block: 'center'});
            }
        });
        note.append(label, button);
    }

    function insertByComponentIndex(root, node, index) {
        const children = [...root.children];
        const before = children.find((child) => Number(child.getAttribute('data-component-index')) > index);
        if(before) {
            root.insertBefore(node, before);
        } else {
            root.appendChild(node);
        }
    }

    function blockFingerprint(event) {
        const props = event?.props || {};
        if(props._final !== true) {
            return null;
        }
        if(event.componentType === 'mermaid_figure' || event.componentType === 'sequence_diagram') {
            const src = normalizeFingerprintText(props.mermaid || '');
            return src.length > 20 ? `mermaid:${simpleHash(src)}` : null;
        }
        if(event.componentType === 'annotated_code_excerpt') {
            const ref = sourceRefSignature(props.sourceRefs);
            const code = normalizeFingerprintText(props.code || '');
            return code.length > 20 ? `code:${simpleHash(`${ref}\n${code}`)}` : null;
        }
        if(event.componentType === 'evidence_callout') {
            const ref = sourceRefSignature(props.sourceRefs);
            const text = normalizeFingerprintText(`${props.summary || ''}\n${props.detail || ''}`);
            return text.length > 20 ? `evidence:${simpleHash(`${ref}\n${text}`)}` : null;
        }
        return null;
    }

    function sourceRefSignature(refs) {
        return (refs || [])
            .map((ref) => `${ref?.path || ''}:${ref?.lineStart || ''}-${ref?.lineEnd || ''}`)
            .filter(Boolean)
            .join('|');
    }

    function normalizeFingerprintText(text) {
        return String(text || '').trim().replace(/\s+/g, ' ');
    }

    function simpleHash(text) {
        let hash = 5381;
        for(let i = 0; i < text.length; i++) {
            hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
        }
        return (hash >>> 0).toString(36);
    }

    function readableComponentType(type) {
        return String(type || 'block').replace(/_/g, ' ');
    }

    function cssEscape(value) {
        if(window.CSS?.escape) {
            return CSS.escape(value);
        }
        return String(value).replace(/["\\]/g, '\\$&');
    }

    function rememberEvidenceRefs(refs) {
        const chapter = activeChapter();
        const updates = [];
        const paths = new Set((refs || []).map((ref) => ref?.path).filter(Boolean));
        for(const path of paths) {
            const ref = {path};
            if(!ref?.path) {
                continue;
            }
            if(chapter?.evidenceRefs) {
                chapter.evidenceRefs.add(ref.path);
            }
            if(chapter?.countedEvidenceRefs?.has(ref.path)) {
                const current = storySession.evidencePaths.get(ref.path);
                if(current) {
                    updates.push(current);
                }
                continue;
            }
            chapter?.countedEvidenceRefs?.add(ref.path);
            const existing = storySession.evidencePaths.get(ref.path);
            if(existing) {
                existing.count += 1;
                existing.lastChapterIndex = chapter?.index || 0;
                updates.push(existing);
                continue;
            }
            const entry = {
                chapterIndex: chapter?.index || 0,
                lastChapterIndex: chapter?.index || 0,
                path: ref.path,
                count: 1
            };
            storySession.evidencePaths.set(ref.path, entry);
            updates.push(entry);
        }
        return updates;
    }

    function renderStoryContext() {
        onContextRender?.();
        if(!storySession.contextRail) {
            return;
        }
        const entries = [...storySession.evidencePaths.values()]
            .sort(compareStoryContextEntries)
            .slice(0, 8);
        storySession.contextRail.innerHTML = '';
        const hasFreshnessNotice = renderStoryFreshnessNotice(storySession.contextRail);
        if(entries.length === 0) {
            return;
        }

        const label = document.createElement('span');
        label.className = 'story-context-label';
        label.textContent = 'story context';
        if(hasFreshnessNotice) {
            label.classList.add('after-freshness');
        }
        storySession.contextRail.appendChild(label);

        for(const entry of entries) {
            const display = sourceItemDisplay(entry);
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `story-context-chip ${entry.count > 1 ? 'is-reused' : ''} is-${sourceRoleClass(display.role)}`.trim();
            chip.title = `Open ${entry.path}`;
            chip.textContent = entry.count > 1
                ? `${formatSourceDisplayLabel(display)} ×${entry.count}`
                : formatSourceDisplayLabel(display);
            chip.addEventListener('click', () => openSourceFile?.({
                path: entry.path,
                sourceViewerTitle: 'story context'
            }));
            storySession.contextRail.appendChild(chip);
        }
    }

    function renderStoryFreshnessNotice(root) {
        if(!isStoryStale(storySession)) {
            return false;
        }

        const notice = document.createElement('div');
        notice.className = 'story-freshness is-stale';

        const label = document.createElement('span');
        label.className = 'story-freshness-label';
        label.textContent = 'code changed';

        const detail = document.createElement('span');
        detail.className = 'story-freshness-detail';
        detail.textContent = storyFreshnessDetail();

        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'story-freshness-action';
        action.textContent = 'Regenerate';
        action.addEventListener('click', () => onRegenerate?.());

        notice.append(label, detail, action);
        root.appendChild(notice);
        return true;
    }

    function storyFreshnessDetail() {
        const paths = Array.isArray(storySession.freshness?.changedPaths)
            ? storySession.freshness.changedPaths
            : [];
        if(paths.length === 1) {
            return `${formatSourceDisplayLabel(sourceItemDisplay({path: paths[0]}))} changed since this story was saved.`;
        }
        if(paths.length > 1) {
            return `${paths.length} referenced files changed since this story was saved.`;
        }
        return 'A referenced file changed since this story was saved.';
    }

    function renderChapterSources(items, retrieval = {}) {
        const chapter = activeChapter();
        if(!chapter?.sourceRail) {
            return;
        }
        const sources = capDependencySourceItems(dedupeSourceItems(items))
            .sort(compareSourceItems)
            .slice(0, 12);
        chapter.sourceRail.innerHTML = '';
        if(sources.length === 0) {
            return;
        }

        rememberEvidenceRefs(sources.map((item) => ({
            path: item.path,
            lineStart: item.lineStart,
            lineEnd: item.lineEnd
        })));
        renderStoryContext();

        const label = document.createElement('span');
        label.className = 'chapter-source-label';
        label.textContent = formatSourceRailLabel(retrieval);
        label.title = formatCorpusCoverageDetail(retrieval.coverage);
        chapter.sourceRail.appendChild(label);

        for(const item of sources) {
            const display = sourceItemDisplay(item);
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `chapter-source-chip is-${sourceRoleClass(display.role)}`;
            chip.title = `Open ${formatSourcePath(item)}`;
            chip.addEventListener('click', () => {
                openSourceFile?.({
                    ...item,
                    sourceViewerTitle: formatSourceViewerTitle({...item, role: display.role})
                });
            });

            const role = document.createElement('span');
            role.className = 'chapter-source-role';
            role.textContent = display.roleLabel;

            const path = document.createElement('span');
            path.className = 'chapter-source-path';
            path.textContent = display.pathLabel;

            chip.append(role, path);
            chapter.sourceRail.appendChild(chip);
        }
    }

    return {
        buildStoryContext,
        renderCrossRefs,
        handleDuplicateBlock,
        registerBlock,
        registerSourceBlocks,
        renderStoryContext,
        renderChapterSources,
        normalizeStoryFreshness,
        isStoryStale,
        formatSourceDisplayLabel,
        sourceItemDisplay
    };
}

export function normalizeStoryFreshness(item) {
    const freshness = item?.freshness && typeof item.freshness === 'object'
        ? item.freshness
        : {};
    return {
        state: String(freshness.state || (item?.isStale ? 'stale' : 'unknown')),
        changedPaths: Array.isArray(freshness.changedPaths) ? freshness.changedPaths : []
    };
}

export function isStoryStale(item) {
    return item?.isStale === true || item?.freshness?.state === 'stale';
}

export function formatSourceRailLabel(retrieval = {}) {
    const parts = ['sources considered'];
    const stage = retrieval.stage === 'prefetch'
        ? 'prefetch search'
        : retrieval.stage === 'exploration'
            ? 'exploration search'
            : '';
    if(stage) {
        parts.push(stage);
    }
    const searches = Number(retrieval.searches) || 0;
    if(searches > 1) {
        parts.push(`${searches} searches`);
    }
    const modes = Array.isArray(retrieval.modes)
        ? retrieval.modes.filter(Boolean).join('+')
        : '';
    if(modes) {
        parts.push(modes);
    }
    const totalMs = Number(retrieval.totalMs);
    if(Number.isFinite(totalMs) && totalMs > 0) {
        parts.push(`${Math.round(totalMs)}ms`);
    }
    const coverage = retrieval.coverage;
    if(coverage && Number.isFinite(Number(coverage.eligibleFiles))) {
        parts.push(`${Number(coverage.indexedSourceFiles) || 0}/${Number(coverage.eligibleFiles) || 0} indexed`);
        if(Number(coverage.skippedFiles) > 0) {
            parts.push(`${Number(coverage.skippedFiles)} skipped`);
        }
        if(Number(coverage.dependencyDocuments) > 0) {
            parts.push(`${Number(coverage.dependencyDocuments)} dependency docs`);
        }
    }
    return parts.join(' · ');
}

export function formatCorpusCoverageDetail(coverage = null) {
    if(!coverage || typeof coverage !== 'object') {
        return '';
    }
    const parts = [];
    const reasons = Object.entries(coverage.skippedByReason || {})
        .filter(([, count]) => Number(count) > 0)
        .map(([reason, count]) => `${reason}: ${count}`);
    if(reasons.length > 0) {
        parts.push(`Skipped (${reasons.join(', ')})`);
    }
    const enrichment = coverage.enrichment || {};
    if(enrichment.enabled) {
        const percent = Number.isFinite(Number(enrichment.coverage))
            ? `${Math.round(Number(enrichment.coverage) * 100)}%`
            : 'not measured';
        parts.push(`Enrichment coverage: ${percent}`);
    } else {
        parts.push('Enrichment disabled');
    }
    if(coverage.sourceRevision) {
        parts.push(`Index revision: ${coverage.sourceRevision}`);
    }
    const limitations = coverage.policyLimitations || {};
    const policy = [
        limitations.unsupportedTypesExcluded ? 'unsupported types excluded' : null,
        limitations.ignoreRulesApplied ? 'ignore rules applied' : null,
        limitations.binaryFilesExcluded ? 'binary files excluded' : null,
        Number(limitations.maximumFileBytes) > 0 ? `files over ${formatBytes(limitations.maximumFileBytes)} excluded` : null
    ].filter(Boolean);
    if(policy.length > 0) {
        parts.push(`Policy: ${policy.join(', ')}`);
    }
    return parts.join('. ');
}

function formatBytes(value) {
    const bytes = Number(value) || 0;
    return bytes >= 1_000_000 ? `${Number((bytes / 1_000_000).toFixed(1))} MB` : `${Math.round(bytes / 1000)} KB`;
}

function dedupeSourceItems(items) {
    const seen = new Set();
    const out = [];
    for(const item of items || []) {
        if(!item?.path) continue;
        const key = `${item.path}:${item.lineStart || ''}-${item.lineEnd || ''}`;
        if(seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function capDependencySourceItems(items) {
    const out = [];
    let dependencyCount = 0;
    for(const item of items || []) {
        if(sourceItemDisplay(item).role === 'dependency') {
            dependencyCount++;
            if(dependencyCount > 1) {
                continue;
            }
        }
        out.push(item);
    }
    return out;
}

function compareStoryContextEntries(a, b) {
    const roleA = sourceItemDisplay(a).role;
    const roleB = sourceItemDisplay(b).role;
    if(roleA === 'dependency' && roleB !== 'dependency') return 1;
    if(roleA !== 'dependency' && roleB === 'dependency') return -1;
    return b.count - a.count || a.path.localeCompare(b.path);
}

function compareSourceItems(a, b) {
    const roleA = sourceItemDisplay(a).role;
    const roleB = sourceItemDisplay(b).role;
    if(roleA === 'dependency' && roleB !== 'dependency') return 1;
    if(roleA !== 'dependency' && roleB === 'dependency') return -1;
    return 0;
}

function formatSourcePath(item) {
    const start = Number(item.lineStart);
    const end = Number(item.lineEnd);
    if(Number.isFinite(start) && Number.isFinite(end)) {
        return end && end !== start ? `${item.path}:${start}-${end}` : `${item.path}:${start}`;
    }
    return item.path;
}

function sourceItemDisplay(item) {
    if(!String(item?.path || '').startsWith('__dependencies__/')) {
        return {
            role: item.role || 'source',
            roleLabel: item.role || 'source',
            pathLabel: formatSourcePath(item)
        };
    }
    return {
        role: 'dependency',
        roleLabel: 'DEP',
        pathLabel: formatDependencySourcePath(item)
    };
}

function formatDependencySourcePath(item) {
    const name = dependencyNameFromPath(item.path);
    const start = Number(item.lineStart);
    const end = Number(item.lineEnd);
    if(Number.isFinite(start) && Number.isFinite(end)) {
        return end && end !== start ? `${name}:${start}-${end}` : `${name}:${start}`;
    }
    return name;
}

function dependencyNameFromPath(path) {
    const depPath = String(path || '').replace(/^__dependencies__\//, '');
    const parts = depPath.split('/').filter(Boolean);
    const file = parts.pop() || depPath;
    const ecosystem = parts.shift() || 'dep';
    const base = String(file || '')
        .replace(/\.md$/i, '')
        .replace(/__/g, '/');
    return base === 'manifest' ? `${ecosystem}/manifest` : (base || ecosystem);
}

function formatSourceDisplayLabel(display) {
    return display.role === 'dependency'
        ? `${display.roleLabel} ${display.pathLabel}`
        : display.pathLabel;
}

function formatSourceViewerTitle(item) {
    return String(item?.role || 'source').replace(/[-_]/g, ' ');
}

function sourceRoleClass(role) {
    return String(role || 'source').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
}

export {
    capDependencySourceItems as __capDependencySourceItemsForTest,
    compareStoryContextEntries as __compareStoryContextEntriesForTest
};

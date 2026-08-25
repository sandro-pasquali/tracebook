// Base class for all primitive tool components.
// Subclasses implement renderBody(props) — the framework owns:
//   - mounting a standard frame (header / body / footer)
//   - calling renderBody whenever props change
//   - rendering common footer fields (sourceRefs + deterministic evidence state)
//

import {Marked, Renderer} from 'marked';
import {codeImageFilename, renderCodeImage} from '@bandf/code-image';
import {apiFetch} from '../app/team-context.js';

const HLJS_PROMISE_KEY = '__tracebook_hljs_promise__';
const HLJS_INSTANCE_KEY = '__tracebook_hljs_instance__';
let hljsPromise = globalThis[HLJS_PROMISE_KEY] || null;
const RAW_MARKDOWN_TAGS = new Set([
    'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'div', 'em', 'hr',
    'i', 'img', 'kbd', 'li', 'ol', 'p', 'pre', 'samp', 'span', 'strong', 'sub',
    'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'
]);
const RAW_MARKDOWN_DROP_TAGS = new Set([
    'applet', 'button', 'embed', 'form', 'iframe', 'input', 'link', 'meta', 'object',
    'script', 'style', 'svg', 'textarea'
]);
const RAW_MARKDOWN_GLOBAL_ATTRS = new Set(['align', 'aria-hidden', 'aria-label', 'class', 'role', 'title']);
const RAW_MARKDOWN_ATTRS = {
    img: new Set(['alt', 'height', 'loading', 'src', 'title', 'width']),
    td: new Set(['align', 'colspan', 'rowspan']),
    th: new Set(['align', 'colspan', 'rowspan']),
    details: new Set(['open'])
};

const markedRenderer = new Renderer();
markedRenderer.html = ({text}) => sanitizeHtmlFragment(text);
markedRenderer.link = function({tokens}) {
    return this.parser.parseInline(tokens);
};
markedRenderer.image = function({href, title, text}) {
    const safeHref = safeRenderedHref(href);
    if(!safeHref) {
        return escapeHtml(text || '');
    }
    const titleAttr = title ? ` title="${escapeAttribute(title)}"` : '';
    return `<img src="${escapeAttribute(safeHref)}" alt="${escapeAttribute(text || '')}"${titleAttr}>`;
};
const markdownRenderer = new Marked({
    gfm: true,
    breaks: false,
    renderer: markedRenderer
});

export class BaseToolComponent extends HTMLElement {
    constructor() {
        super();
        this._props = null;
        this._mounted = false;
        this._renderSeq = 0;
    }

    connectedCallback() {
        if(this._mounted) return;
        this.classList.add('tool');

        this._headerEl = document.createElement('div');
        this._headerEl.className = 'tool-header';

        this._captionEl = document.createElement('div');
        this._captionEl.className = 'tool-caption';

        this._kindEl = document.createElement('div');
        this._kindEl.className = 'tool-kind';

        this._headerEl.append(this._captionEl, this._kindEl);

        this._bodyEl = document.createElement('div');
        this._bodyEl.className = 'tool-body';

        this._footerEl = document.createElement('div');
        this._footerEl.className = 'tool-footer';

        const skeleton = document.createElement('div');
        skeleton.className = 'tool-skeleton';
        this._bodyEl.appendChild(skeleton);

        this.append(this._headerEl, this._bodyEl, this._footerEl);
        this._mounted = true;

        if(this._props) {
            this._render(this._props);
        }
    }

    applyProps(props) {
        this._props = props;
        if(!this._mounted) return;
        this._render(props);
    }

    _render(props) {
        const renderSeq = ++this._renderSeq;
        this._captionEl.textContent = props.caption || ' ';
        this._kindEl.textContent = readableType(this.tagName);

        try {
            const result = this.renderBody(props);
            if(result && typeof result.then === 'function') {
                result.catch((err) => {
                    if(renderSeq !== this._renderSeq) {
                        return;
                    }
                    this._renderError(err);
                });
            }
        } catch(err) {
            this._renderError(err);
        }

        this._renderFooter(props);
    }

    renderBody() {
        this._bodyEl.innerHTML = '<div class="tool-unsupported">no renderer</div>';
    }

    _renderError(err) {
        this._bodyEl.innerHTML = `<div class="tool-unsupported">render_failed: ${escapeHtml(err?.message || String(err))}</div>`;
    }

    _renderFooter(props) {
        this._footerEl.innerHTML = '';

        const refs = Array.isArray(props.sourceRefs) ? props.sourceRefs : [];
        for(const ref of refs) {
            if(!ref || !ref.path) continue;
            const label = sourceRefDisplay(ref);
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = label.kind === 'dependency' ? 'src is-dependency' : 'src';
            chip.title = `Open ${ref.path}`;
            chip.addEventListener('click', () => {
                openSourceFile({
                    ...ref,
                    sourceViewerTitle: props.caption || readableType(this.tagName)
                });
            });
            if(label.prefix) {
                const prefix = document.createElement('span');
                prefix.className = 'src-prefix';
                prefix.textContent = label.prefix;
                chip.appendChild(prefix);
            }
            const file = document.createElement('span');
            file.className = 'file';
            file.textContent = label.path;
            chip.appendChild(file);
            if(ref.lineStart) {
                const lines = document.createElement('span');
                lines.className = 'lines';
                lines.textContent = ref.lineEnd && ref.lineEnd !== ref.lineStart
                    ? `:${ref.lineStart}-${ref.lineEnd}`
                    : `:${ref.lineStart}`;
                chip.appendChild(lines);
            }
            this._footerEl.appendChild(chip);
        }

        const evidenceState = normalizeEvidenceState(props);
        if(evidenceState) {
            const wrap = document.createElement('div');
            wrap.className = `evidence-state is-${evidenceState}`;
            wrap.textContent = evidenceStateLabel(evidenceState);
            this._footerEl.appendChild(wrap);
        }
    }
}

function normalizeEvidenceState(props) {
    const known = new Set(['verified_source', 'grounded', 'inferred', 'coverage_gap', 'generation_failure']);
    if(known.has(props?.evidenceState)) {
        return props.evidenceState;
    }
    // Backward compatibility for saved traces created before evidenceState was
    // added. This is deliberately qualitative; old numeric confidence values
    // are never converted into a displayed percentage.
    if(props?.type === 'annotated_code_excerpt' && props.sourceRefs?.length) {
        return 'verified_source';
    }
    if(props?.kind === 'gap') {
        return props?.gapReason === 'generation_failed' ? 'generation_failure' : 'coverage_gap';
    }
    if(props?.kind === 'grounded' && props.sourceRefs?.length) {
        return 'grounded';
    }
    if(typeof props?.confidence === 'number' || props?.kind === 'inferred') {
        return 'inferred';
    }
    return null;
}

function evidenceStateLabel(state) {
    return {
        verified_source: 'verified source',
        grounded: 'grounded in source',
        inferred: 'inferred from evidence',
        coverage_gap: 'coverage gap',
        generation_failure: 'generation failure'
    }[state] || '';
}

function readableType(tag) {
    return String(tag).toLowerCase().replace(/^tool-/, '').replace(/-/g, ' ');
}

function sourceRefDisplay(ref) {
    const path = String(ref?.path || '');
    if(!path.startsWith('__dependencies__/')) {
        return {kind: 'source', prefix: '', path};
    }
    const depPath = path.replace(/^__dependencies__\//, '');
    const parts = depPath.split('/').filter(Boolean);
    const file = parts.pop() || depPath;
    const ecosystem = parts.shift() || 'dep';
    return {
        kind: 'dependency',
        prefix: 'DEP',
        path: formatDependencyName(file, ecosystem)
    };
}

function formatDependencyName(file, ecosystem) {
    const base = String(file || '')
        .replace(/\.md$/i, '')
        .replace(/__/g, '/');
    if(base === 'manifest') {
        return `${ecosystem}/manifest`;
    }
    return base || ecosystem;
}

export async function openSourceFile(ref) {
    const overlay = document.createElement('div');
    overlay.className = 'mermaid-fullscreen source-fullscreen';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const shell = document.createElement('div');
    shell.className = 'mermaid-fullscreen-shell source-fullscreen-shell';
    const bar = document.createElement('div');
    bar.className = 'mermaid-fullscreen-bar source-fullscreen-bar';
    const title = document.createElement('div');
    title.className = 'mermaid-fullscreen-title source-fullscreen-title';
    title.textContent = sourceModalTitle(ref);
    const actions = document.createElement('div');
    actions.className = 'mermaid-fullscreen-actions source-fullscreen-actions';
    const codeImageAction = document.createElement('div');
    codeImageAction.className = 'source-code-image-action';
    const codeImage = document.createElement('button');
    codeImage.type = 'button';
    codeImage.className = 'mermaid-fullscreen-download source-code-image-button';
    codeImage.textContent = 'Copy Image';
    codeImage.title = 'Copy the highlighted source excerpt to the clipboard';
    codeImage.setAttribute('aria-haspopup', 'menu');
    codeImage.setAttribute('aria-expanded', 'false');
    const codeImageMenu = document.createElement('div');
    codeImageMenu.className = 'source-code-image-menu';
    codeImageMenu.setAttribute('role', 'menu');
    codeImageMenu.setAttribute('aria-label', 'Copy image theme');
    codeImageMenu.hidden = true;
    for(const [theme, label] of [['light', 'Light'], ['dark', 'Dark']]) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'source-code-image-menu-item';
        item.dataset.theme = theme;
        item.setAttribute('role', 'menuitem');
        item.textContent = label;
        codeImageMenu.appendChild(item);
    }
    codeImageAction.append(codeImage, codeImageMenu);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'mermaid-fullscreen-close source-fullscreen-close';
    close.textContent = 'Collapse';
    actions.append(codeImageAction, close);
    bar.append(title, actions);

    const canvas = document.createElement('div');
    canvas.className = 'source-fullscreen-canvas';
    const status = document.createElement('div');
    status.className = 'source-fullscreen-status';
    status.textContent = 'Loading source…';
    canvas.appendChild(status);
    shell.append(bar, canvas);
    overlay.appendChild(shell);
    document.body.appendChild(overlay);

    let resolveSourceReady;
    const sourceReady = new Promise((resolve) => {
        resolveSourceReady = resolve;
    });

    const closeCodeImageMenu = ({restoreFocus = false} = {}) => {
        codeImageMenu.hidden = true;
        codeImage.setAttribute('aria-expanded', 'false');
        if(restoreFocus) {
            codeImage.focus({preventScroll: true});
        }
    };
    const openCodeImageMenu = () => {
        codeImageMenu.hidden = false;
        codeImage.setAttribute('aria-expanded', 'true');
        codeImageMenu.querySelector('[role="menuitem"]')?.focus({preventScroll: true});
    };
    const refreshCodeImageState = () => updateCodeImageButton(codeImage, canvas);
    const cleanup = () => {
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('selectionchange', refreshCodeImageState);
        canvas.removeEventListener('source-view-panel-change', refreshCodeImageState);
        overlay.remove();
    };
    const onKey = (ev) => {
        if(ev.key !== 'Escape') {
            return;
        }
        if(!codeImageMenu.hidden) {
            ev.preventDefault();
            closeCodeImageMenu({restoreFocus: true});
            return;
        }
        cleanup();
    };
    close.addEventListener('click', cleanup);
    overlay.addEventListener('click', (ev) => {
        if(!codeImageAction.contains(ev.target)) {
            closeCodeImageMenu();
        }
        if(ev.target === overlay) cleanup();
    });
    codeImage.addEventListener('click', () => {
        if(codeImageMenu.hidden) {
            openCodeImageMenu();
        } else {
            closeCodeImageMenu({restoreFocus: true});
        }
    });
    codeImageMenu.addEventListener('click', (ev) => {
        const item = ev.target.closest('.source-code-image-menu-item');
        if(!item) {
            return;
        }
        closeCodeImageMenu();
        copySelectedCodeImage({
            button: codeImage,
            canvas,
            sourceReady,
            theme: item.dataset.theme
        });
    });
    codeImageMenu.addEventListener('keydown', (ev) => {
        if(!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) {
            return;
        }
        ev.preventDefault();
        const items = [...codeImageMenu.querySelectorAll('[role="menuitem"]')];
        const currentIndex = items.indexOf(document.activeElement);
        const nextIndex = ev.key === 'Home'
            ? 0
            : ev.key === 'End'
                ? items.length - 1
                : (currentIndex + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[nextIndex]?.focus({preventScroll: true});
    });
    document.addEventListener('keydown', onKey);
    document.addEventListener('selectionchange', refreshCodeImageState);
    canvas.addEventListener('source-view-panel-change', refreshCodeImageState);
    close.focus({preventScroll: true});

    try {
        const source = await fetchSource(ref.path);
        title.textContent = sourceModalTitle({...ref, path: source.path});
        await renderSourceFile(canvas, source, ref);
        resolveSourceReady({error: null});
        refreshCodeImageState();
    } catch(err) {
        canvas.innerHTML = '';
        canvas.appendChild(status);
        const message = err?.message || 'Could not load source.';
        status.textContent = message;
        resolveSourceReady({error: message});
    }
}

async function fetchSource(path) {
    const response = await apiFetch(sourceFileUrl(path), {
        headers: {accept: 'text/plain'}
    });
    const contentType = response.headers.get('content-type') || '';
    const content = await response.text();

    if(response.ok && contentType.includes('text/html')) {
        throw new Error('The local file route returned the app HTML. Restart the local server so the new route is loaded.');
    }
    if(!response.ok) {
        throw new Error(sourceErrorMessage(content, response.status, path));
    }
    return {
        path: response.headers.get('x-source-path') || path,
        bytes: Number(response.headers.get('x-source-bytes')) || content.length,
        totalLines: content.split(/\r?\n/).length,
        content
    };
}

function sourceErrorMessage(body, status, path) {
    if(status === 413) {
        const [, maxBytes] = String(body || '').split(':');
        return `File is too large to preview here${maxBytes ? ` (${maxBytes} byte limit)` : ''}.`;
    }
    if(status === 404) {
        return `Could not find ${path} on disk.`;
    }
    if(String(body || '').trim() === 'missing_path') {
        return 'No source path was provided.';
    }
    if(String(body || '').trim() === 'path_escape') {
        return 'That path is outside the local repository.';
    }
    return `Could not load source (${status}).`;
}

function sourceFileUrl(path) {
    return `/api/source-file/${encodeSourcePath(path)}`;
}

function encodeSourcePath(path) {
    const normalized = String(path || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const bytes = new TextEncoder().encode(normalized);
    let binary = '';
    for(const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function renderSourceFile(canvas, source, ref) {
    if(isMarkdownPath(source.path)) {
        await renderMarkdownSourceFile(canvas, source, ref);
        return;
    }
    await renderCodeSourceFile(canvas, source, ref);
}

async function renderMarkdownSourceFile(canvas, source, ref) {
    canvas.innerHTML = '';
    const tabs = document.createElement('div');
    tabs.className = 'source-view-tabs';
    tabs.setAttribute('role', 'tablist');

    const codeTab = document.createElement('button');
    codeTab.type = 'button';
    codeTab.className = 'source-view-tab';
    codeTab.textContent = 'Code';
    codeTab.setAttribute('role', 'tab');
    codeTab.setAttribute('aria-selected', 'false');

    const previewTab = document.createElement('button');
    previewTab.type = 'button';
    previewTab.className = 'source-view-tab is-active';
    previewTab.textContent = 'Rendered';
    previewTab.setAttribute('role', 'tab');
    previewTab.setAttribute('aria-selected', 'true');

    const codePanel = document.createElement('div');
    codePanel.className = 'source-view-panel';
    codePanel.setAttribute('role', 'tabpanel');
    codePanel.hidden = true;

    const previewPanel = document.createElement('div');
    previewPanel.className = 'source-view-panel is-active';
    previewPanel.setAttribute('role', 'tabpanel');

    tabs.append(codeTab, previewTab);
    canvas.append(tabs, codePanel, previewPanel);

    codeTab.addEventListener('click', () => {
        showSourcePanel(canvas, codeTab, codePanel, previewTab, previewPanel);
    });
    previewTab.addEventListener('click', () => {
        showSourcePanel(canvas, previewTab, previewPanel, codeTab, codePanel);
    });

    await renderCodeSourceFile(codePanel, source, ref);
    await renderMarkdownPreview(previewPanel, source);
}

function showSourcePanel(canvas, activeTab, activePanel, inactiveTab, inactivePanel) {
    activeTab.classList.add('is-active');
    activeTab.setAttribute('aria-selected', 'true');
    inactiveTab.classList.remove('is-active');
    inactiveTab.setAttribute('aria-selected', 'false');
    activePanel.hidden = false;
    activePanel.classList.add('is-active');
    inactivePanel.hidden = true;
    inactivePanel.classList.remove('is-active');
    canvas.scrollTop = 0;
    canvas.dispatchEvent(new CustomEvent('source-view-panel-change'));
}

async function renderMarkdownPreview(panel, source) {
    panel.innerHTML = '';
    const frame = document.createElement('div');
    frame.className = 'source-markdown-frame';
    const meta = document.createElement('div');
    meta.className = 'source-code-meta source-markdown-meta';
    meta.textContent = `${source.path} · rendered markdown`;
    const body = document.createElement('div');
    body.className = 'source-markdown-preview';
    body.innerHTML = markdownToHtml(source.content);
    frame.append(meta, body);
    panel.appendChild(frame);
    prepareMarkdownPreviewMedia(body);
    await highlightMarkdownPreview(body);
}

async function renderCodeSourceFile(canvas, source, ref) {
    canvas.innerHTML = '';
    const frame = document.createElement('div');
    frame.className = 'source-code-frame';
    frame.dataset.sourcePath = source.path || '';
    frame.dataset.sourceLanguage = languageFromPath(source.path) || '';
    const meta = document.createElement('div');
    meta.className = 'source-code-meta';
    meta.textContent = `${source.path} · ${source.totalLines || 0} lines`;
    const grid = document.createElement('div');
    grid.className = 'source-code-grid';
    frame.append(meta, grid);
    canvas.appendChild(frame);

    const lines = String(source.content || '').replace(/\r?\n$/, '').split(/\r?\n/);
    const hljs = await loadHljs();
    const language = languageFromPath(source.path);
    const supports = hljs && language && typeof hljs.getLanguage === 'function' && hljs.getLanguage(language);
    const start = Number(ref?.lineStart) || null;
    const end = Number(ref?.lineEnd) || start;
    let targetLine = null;

    for(let index = 0; index < lines.length; index++) {
        const lineNo = index + 1;
        const row = document.createElement('div');
        row.className = 'source-code-row';
        const isReferenced = start !== null && lineNo >= start && lineNo <= end;
        if(isReferenced) {
            row.classList.add('is-referenced');
        }
        const gutter = document.createElement('div');
        gutter.className = 'source-code-gutter';
        gutter.textContent = String(lineNo);

        const code = document.createElement('div');
        code.className = 'source-code-line';
        code.dataset.sourceLine = String(lineNo);
        code.dataset.sourceText = lines[index] || '';
        code.textContent = lines[index] || ' ';
        if(hljs) {
            try {
                const highlighted = supports
                    ? hljs.highlight(lines[index], {language, ignoreIllegals: true})
                    : null;
                code.innerHTML = highlighted?.value || escapeHtml(lines[index]) || ' ';
                code.classList.add('hljs');
            } catch {}
        }
        if(start !== null && lineNo === start) {
            targetLine = code;
        }

        row.append(gutter, code);
        grid.appendChild(row);
    }

    if(targetLine) {
        requestAnimationFrame(() => targetLine.scrollIntoView({block: 'center'}));
    }
}

function updateCodeImageButton(button, canvas) {
    if(button.classList.contains('is-busy')) {
        return;
    }
    button.disabled = false;
    button.title = selectedUserSourceCode(canvas)
        ? 'Copy your selected code to the clipboard as an image'
        : 'Copy the highlighted source excerpt to the clipboard as an image';
}

async function copySelectedCodeImage({button, canvas, sourceReady, theme}) {
    if(button.classList.contains('is-busy')) {
        return;
    }

    const originalText = button.textContent;
    button.classList.add('is-busy');
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    button.textContent = 'Loading';
    let blob;
    let filename;
    try {
        const ready = await sourceReady;
        if(ready.error) {
            throw new Error(ready.error);
        }
        const selection = selectedSourceCode(canvas);
        if(!selection) {
            throw new Error('The highlighted source excerpt is unavailable.');
        }
        button.textContent = 'Generating';
        blob = await renderCodeImage(selection, {theme: currentCodeImageTheme(theme)});
        filename = codeImageFilename(selection);
        button.textContent = 'Copying';
        await copyPngToClipboard(blob);
        button.textContent = 'Copied';
        showCodeImageDownloadPrompt({blob, filename, copied: true, returnFocus: button});
        setTimeout(() => {
            resetCodeImageButton(button, canvas, originalText);
        }, 1200);
    } catch(err) {
        button.textContent = 'Failed';
        button.title = err?.message || 'Could not copy the image';
        if(blob && filename) {
            showCodeImageDownloadPrompt({blob, filename, copied: false, returnFocus: button});
        } else {
            showCodeImageErrorPrompt({
                message: err?.message || 'Could not generate the code image.',
                returnFocus: button
            });
        }
        setTimeout(() => {
            resetCodeImageButton(button, canvas, originalText);
        }, 1800);
    }
}

function resetCodeImageButton(button, canvas, text) {
    button.classList.remove('is-busy');
    button.removeAttribute('aria-busy');
    button.textContent = text;
    updateCodeImageButton(button, canvas);
}

function currentCodeImageTheme(base = 'light') {
    const styles = getComputedStyle(document.documentElement);
    return {
        base,
        fontFamily: styles.getPropertyValue('--mono').trim() || undefined
    };
}

async function copyPngToClipboard(blob) {
    const ClipboardItemCtor = globalThis.ClipboardItem;
    if(!navigator.clipboard?.write || !ClipboardItemCtor) {
        throw new Error('Clipboard image copy is not available in this browser.');
    }
    await navigator.clipboard.write([
        new ClipboardItemCtor({'image/png': blob})
    ]);
}

function showCodeImageDownloadPrompt({blob, filename, copied, returnFocus}) {
    showCodeImageDialog({
        title: copied ? 'Image copied' : 'Copy failed',
        message: copied
            ? 'Download code image?'
            : 'Could not copy the image to the clipboard. Download code image?',
        primaryText: 'Yes',
        secondaryText: 'No',
        onPrimary: () => triggerBlobDownload(blob, filename),
        returnFocus
    });
}

function showCodeImageErrorPrompt({message, returnFocus}) {
    showCodeImageDialog({
        title: 'Code image failed',
        message,
        primaryText: 'OK',
        returnFocus
    });
}

function showCodeImageDialog({title: titleText, message: messageText, primaryText, secondaryText = '', onPrimary = null, returnFocus}) {
    const overlay = document.createElement('div');
    overlay.className = 'code-image-dialog-backdrop';

    const dialog = document.createElement('div');
    dialog.className = 'code-image-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'code-image-dialog-title');

    const title = document.createElement('div');
    title.id = 'code-image-dialog-title';
    title.className = 'code-image-dialog-title';
    title.textContent = titleText;

    const message = document.createElement('div');
    message.className = 'code-image-dialog-message';
    message.textContent = messageText;

    const actions = document.createElement('div');
    actions.className = 'code-image-dialog-actions';

    let secondary = null;
    if(secondaryText) {
        secondary = document.createElement('button');
        secondary.type = 'button';
        secondary.className = 'code-image-dialog-btn';
        secondary.textContent = secondaryText;
        actions.appendChild(secondary);
    }

    const primary = document.createElement('button');
    primary.type = 'button';
    primary.className = 'code-image-dialog-btn is-primary';
    primary.textContent = primaryText;
    actions.appendChild(primary);
    dialog.append(title, message, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        returnFocus?.focus?.({preventScroll: true});
    };
    const onKey = (ev) => {
        if(ev.key === 'Escape') {
            close();
        }
    };
    overlay.addEventListener('click', (ev) => {
        if(ev.target === overlay) {
            close();
        }
    });
    secondary?.addEventListener('click', close);
    primary.addEventListener('click', () => {
        onPrimary?.();
        close();
    });
    document.addEventListener('keydown', onKey);
    primary.focus({preventScroll: true});
}

function selectedSourceCode(canvas) {
    return selectedUserSourceCode(canvas) || highlightedSourceCode(canvas);
}

function selectedUserSourceCode(canvas) {
    const selection = window.getSelection?.();
    if(!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
    }

    for(const grid of canvas.querySelectorAll('.source-code-grid')) {
        if(!isVisibleInCanvas(grid, canvas) || !selectionIntersects(selection, grid)) {
            continue;
        }

        const lines = [];
        let lineStart = null;
        let lineEnd = null;
        for(const line of grid.querySelectorAll('.source-code-line')) {
            const selected = selectedLineText(selection, line);
            if(selected === null) {
                continue;
            }
            const lineNo = Number(line.dataset.sourceLine);
            lineStart ??= Number.isFinite(lineNo) ? lineNo : null;
            if(Number.isFinite(lineNo)) {
                lineEnd = lineNo;
            }
            lines.push(selected);
        }

        const result = sourceCodeSelection(grid, {lines, lineStart, lineEnd});
        if(result) {
            return result;
        }
    }
    return null;
}

function highlightedSourceCode(canvas) {
    for(const grid of canvas.querySelectorAll('.source-code-grid')) {
        const lines = [...grid.querySelectorAll('.source-code-row.is-referenced .source-code-line')];
        if(lines.length === 0) {
            continue;
        }
        const lineNumbers = lines
            .map((line) => Number(line.dataset.sourceLine))
            .filter(Number.isFinite);
        const result = sourceCodeSelection(grid, {
            lines: lines.map((line) => line.dataset.sourceText || ''),
            lineStart: lineNumbers[0] || null,
            lineEnd: lineNumbers.at(-1) || null
        });
        if(result) {
            return result;
        }
    }
    return null;
}

function sourceCodeSelection(grid, {lines, lineStart, lineEnd}) {
    const code = normalizeSelectedCode(lines.join('\n'));
    if(!code.trim()) {
        return null;
    }
    const frame = grid.closest('.source-code-frame');
    const path = frame?.dataset.sourcePath || '';
    const lineSuffix = lineStart && lineEnd
        ? lineStart === lineEnd ? `:${lineStart}` : `:${lineStart}-${lineEnd}`
        : '';
    return {
        code,
        path,
        language: frame?.dataset.sourceLanguage || '',
        title: path ? `${path}${lineSuffix}` : 'code'
    };
}

function selectionIntersects(selection, element) {
    for(let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        if(typeof range.intersectsNode === 'function' && range.intersectsNode(element)) {
            return true;
        }
    }
    return false;
}

function selectedLineText(selection, line) {
    const RangeCtor = globalThis.Range;
    if(!RangeCtor) {
        return null;
    }
    let touched = false;
    let text = '';
    for(let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        if(typeof range.intersectsNode !== 'function' || !range.intersectsNode(line)) {
            continue;
        }
        touched = true;
        const lineRange = document.createRange();
        lineRange.selectNodeContents(line);
        const coversLine = range.compareBoundaryPoints(RangeCtor.START_TO_START, lineRange) <= 0
            && range.compareBoundaryPoints(RangeCtor.END_TO_END, lineRange) >= 0;
        if(coversLine) {
            text += line.dataset.sourceText || '';
            continue;
        }

        const overlap = lineRange.cloneRange();
        if(range.compareBoundaryPoints(RangeCtor.START_TO_START, lineRange) > 0) {
            overlap.setStart(range.startContainer, range.startOffset);
        }
        if(range.compareBoundaryPoints(RangeCtor.END_TO_END, lineRange) < 0) {
            overlap.setEnd(range.endContainer, range.endOffset);
        }
        if(!overlap.collapsed) {
            text += overlap.toString();
        }
    }
    return touched ? text : null;
}

function normalizeSelectedCode(code) {
    return String(code || '')
        .replace(/\u00A0/g, ' ')
        .replace(/\r\n?/g, '\n');
}

function isVisibleInCanvas(element, canvas) {
    let current = element;
    while(current && current !== canvas) {
        if(current.hidden) {
            return false;
        }
        current = current.parentElement;
    }
    return true;
}

function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isMarkdownPath(path) {
    return /\.(md|markdown|mdown|mkdn|mdx)$/i.test(String(path || '').split(/[?#]/)[0]);
}

function markdownToHtml(markdown) {
    try {
        return markdownRenderer.parse(String(markdown || ''));
    } catch(err) {
        return `<pre>${escapeHtml(err?.message || 'Could not render markdown.')}</pre>`;
    }
}

async function highlightMarkdownPreview(root) {
    const hljs = await loadHljs();
    if(!hljs || typeof root.querySelectorAll !== 'function') {
        return;
    }
    for(const code of root.querySelectorAll('pre code')) {
        const language = [...code.classList]
            .map((name) => /^language-(.+)$/v.exec(name)?.[1])
            .find(Boolean);
        try {
            const result = language && hljs.getLanguage(language)
                ? hljs.highlight(code.textContent || '', {language, ignoreIllegals: true})
                : hljs.highlightAuto(code.textContent || '');
            code.innerHTML = result.value;
            code.classList.add('hljs');
        } catch {}
    }
}

function prepareMarkdownPreviewMedia(root) {
    if(typeof root.querySelectorAll !== 'function') {
        return;
    }
    for(const img of root.querySelectorAll('img')) {
        img.loading = img.loading || 'lazy';
        img.decoding = img.decoding || 'async';
        img.referrerPolicy = img.referrerPolicy || 'no-referrer';

        const src = img.getAttribute('src') || '';
        const alt = img.getAttribute('alt') || 'image';
        const fallback = document.createElement('span');
        fallback.className = 'source-markdown-image-fallback';
        fallback.textContent = src ? `Image unavailable: ${alt}` : `Image unavailable: ${alt}`;
        fallback.hidden = true;
        img.insertAdjacentElement('afterend', fallback);

        const showFallback = () => {
            img.classList.add('is-unavailable');
            fallback.hidden = false;
        };
        img.addEventListener('error', showFallback, {once: true});
        if(img.complete && img.naturalWidth === 0) {
            showFallback();
        }
    }
}

function safeRenderedHref(href) {
    const value = String(href || '').trim();
    if(!value || /[\u0000-\u001F\u007F]/.test(value)) {
        return '';
    }
    const compact = value.replace(/\s+/g, '');
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(compact)?.[1]?.toLowerCase();
    if(scheme && !['http', 'https', 'mailto'].includes(scheme)) {
        return '';
    }
    return value;
}

function safeRenderedSrc(src) {
    const value = safeRenderedHref(src);
    if(!value) {
        return '';
    }
    const compact = value.replace(/\s+/g, '');
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(compact)?.[1]?.toLowerCase();
    if(scheme && !['http', 'https'].includes(scheme)) {
        return '';
    }
    return value;
}

function sanitizeHtmlFragment(html) {
    const value = String(html || '');
    if(!value) {
        return '';
    }
    if(globalThis.document?.createElement) {
        return sanitizeHtmlFragmentWithDom(value);
    }
    return sanitizeHtmlFragmentWithFallback(value);
}

function sanitizeHtmlFragmentWithDom(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    sanitizeHtmlNode(template.content);
    return template.innerHTML;
}

function sanitizeHtmlNode(node) {
    for(const child of [...node.childNodes]) {
        if(child.nodeType !== Node.ELEMENT_NODE) {
            continue;
        }
        const tag = child.tagName.toLowerCase();
        if(RAW_MARKDOWN_DROP_TAGS.has(tag)) {
            child.remove();
            continue;
        }
        sanitizeHtmlNode(child);
        if(!RAW_MARKDOWN_TAGS.has(tag)) {
            child.replaceWith(...child.childNodes);
            continue;
        }
        sanitizeHtmlAttributes(child, tag);
    }
}

function sanitizeHtmlAttributes(element, tag) {
    for(const attr of [...element.attributes]) {
        const name = attr.name.toLowerCase();
        if(name.startsWith('on') || name === 'style' || !isAllowedRawMarkdownAttr(tag, name)) {
            element.removeAttribute(attr.name);
            continue;
        }
        if(name === 'href') {
            const href = safeRenderedHref(attr.value);
            if(!href) {
                element.removeAttribute(attr.name);
                continue;
            }
            element.setAttribute('href', href);
            if(tag === 'a') {
                element.setAttribute('target', '_blank');
                element.setAttribute('rel', 'noopener noreferrer');
            }
            continue;
        }
        if(name === 'src') {
            const src = safeRenderedSrc(attr.value);
            if(!src) {
                element.removeAttribute(attr.name);
                continue;
            }
            element.setAttribute('src', src);
        }
    }
}

function sanitizeHtmlFragmentWithFallback(html) {
    return String(html || '')
        .replace(/<\s*(script|style|iframe|object|embed|svg|textarea)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
        .replace(/<\s*(applet|button|form|input|link|meta)\b[^>]*>/gi, '')
        .replace(/<\s*\/?\s*([A-Za-z][A-Za-z0-9:-]*)\b([^>]*)>/g, (raw, rawTag, rawAttrs) => {
            const tag = rawTag.toLowerCase();
            if(RAW_MARKDOWN_DROP_TAGS.has(tag)) {
                return '';
            }
            if(tag === 'a') {
                return '';
            }
            if(!RAW_MARKDOWN_TAGS.has(tag)) {
                return escapeHtml(raw);
            }
            const closing = /^<\s*\//.test(raw);
            if(closing) {
                return `</${tag}>`;
            }
            const attrs = sanitizeRawMarkdownAttrs(tag, rawAttrs);
            const selfClosing = /\/\s*>$/.test(raw) || ['br', 'hr', 'img'].includes(tag);
            return `<${tag}${attrs}${selfClosing ? '>' : '>'}`;
        });
}

function sanitizeRawMarkdownAttrs(tag, rawAttrs) {
    const attrs = [];
    const attrPattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
    for(const match of String(rawAttrs || '').matchAll(attrPattern)) {
        const name = match[1].toLowerCase();
        if(name.startsWith('on') || name === 'style' || !isAllowedRawMarkdownAttr(tag, name)) {
            continue;
        }
        const rawValue = match[2];
        const value = rawValue === undefined ? '' : rawValue.replace(/^['"]|['"]$/g, '');
        if(name === 'href') {
            const href = safeRenderedHref(value);
            if(!href) {
                continue;
            }
            attrs.push(`href="${escapeAttribute(href)}"`);
            if(tag === 'a') {
                attrs.push('target="_blank"', 'rel="noopener noreferrer"');
            }
            continue;
        }
        if(name === 'src') {
            const src = safeRenderedSrc(value);
            if(!src) {
                continue;
            }
            attrs.push(`src="${escapeAttribute(src)}"`);
            continue;
        }
        if(rawValue === undefined) {
            attrs.push(name);
            continue;
        }
        attrs.push(`${name}="${escapeAttribute(value)}"`);
    }
    return attrs.length > 0 ? ` ${[...new Set(attrs)].join(' ')}` : '';
}

function isAllowedRawMarkdownAttr(tag, name) {
    return RAW_MARKDOWN_GLOBAL_ATTRS.has(name) || RAW_MARKDOWN_ATTRS[tag]?.has(name);
}

function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
}

export function __markdownToHtmlForTest(markdown) {
    return markdownToHtml(markdown);
}

async function loadHljs() {
    if(!hljsPromise) {
        hljsPromise = import('highlight.js').then((mod) => {
            const hljs = mod.default || mod;
            globalThis[HLJS_INSTANCE_KEY] = hljs;
            return hljs;
        }).catch(() => null);
        globalThis[HLJS_PROMISE_KEY] = hljsPromise;
    }
    return hljsPromise || globalThis[HLJS_INSTANCE_KEY] || null;
}

function sourceModalTitle(ref) {
    const title = String(ref?.sourceViewerTitle || ref?.sectionTitle || ref?.role || 'Source').trim() || 'Source';
    if(ref?.lineStart) {
        const lines = ref.lineEnd && ref.lineEnd !== ref.lineStart
            ? `lines ${ref.lineStart}-${ref.lineEnd}`
            : `line ${ref.lineStart}`;
        return `${title} · ${lines}`;
    }
    return title;
}

export function __sourceModalTitleForTest(ref) {
    return sourceModalTitle(ref);
}

export function __sourceRefDisplayForTest(ref) {
    return sourceRefDisplay(ref);
}

function languageFromPath(path) {
    const value = String(path || '').toLowerCase().split(/[?#]/)[0];
    const match = /\.([a-z0-9]+)$/.exec(value);
    if(!match) return null;
    const ext = match[1];
    const direct = {
        css: 'css',
        scss: 'scss',
        sass: 'scss',
        less: 'less',
        json: 'json',
        jsonc: 'json',
        md: 'markdown',
        markdown: 'markdown',
        py: 'python',
        go: 'go',
        rs: 'rust',
        java: 'java',
        php: 'php',
        sql: 'sql',
        toml: 'toml',
        yaml: 'yaml',
        yml: 'yaml',
        html: 'xml',
        htm: 'xml',
        xml: 'xml',
        js: 'javascript',
        jsx: 'javascript',
        mjs: 'javascript',
        cjs: 'javascript',
        ts: 'typescript',
        tsx: 'typescript',
        sh: 'bash',
        bash: 'bash',
        zsh: 'bash',
        cs: 'csharp',
        kt: 'kotlin',
        cpp: 'cpp',
        cc: 'cpp',
        cxx: 'cpp',
        hpp: 'cpp',
        hxx: 'cpp'
    };
    return direct[ext] || ext;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

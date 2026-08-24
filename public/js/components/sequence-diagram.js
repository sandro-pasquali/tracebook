import {BaseToolComponent} from './_base.js';
import {apiFetch} from '../app/team-context.js';

// Auto-repair: when the browser parser rejects a final diagram and the
// deterministic candidates are exhausted, ask the model to fix it once.
//
const AUTO_MERMAID_REPAIR = true;
const MERMAID_REPAIR_TIMEOUT_MS = 30000;

// <tool-sequence-diagram>
//   Props: { mermaid, caption }
//   Lazily loads Mermaid from a local ESM chunk and renders the figure into an SVG.
//   Falls back to a quiet placeholder when source is invalid (parse-first).
//
// Mermaid theme variables are pulled from live CSS variables on the document
// root, so calling reinitMermaidTheme() after a theme switch re-tunes future
// diagrams to match.
//

const MERMAID_PROMISE_KEY = '__tracebook_mermaid_promise__';
const MERMAID_INSTANCE_KEY = '__tracebook_mermaid_instance__';
let mermaidPromise = globalThis[MERMAID_PROMISE_KEY] || null;
let mermaidLoaded = globalThis[MERMAID_INSTANCE_KEY] || null;

function readThemeVars() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
    // bg = the diagram backdrop and the flat backing surfaces that read as
    // background (subgraph/cluster/note fills) — white on light themes, dark on
    // Forensic. bgElev fills the structural boxes (nodes, actor boxes) so they
    // stay visible; the rest is themed ink (text, borders, lines, note accent).
    //
    return {
        bg: v('--diagram-bg', '#ffffff'),
        bgElev: v('--bg-elev', '#dcdcdc'),
        text: v('--text', '#1e1e1e'),
        textSoft: v('--text-soft', '#4a4a4a'),
        border: v('--border-dotted-color', 'rgba(30, 30, 30, 0.35)'),
        line: v('--accent-cool', '#188daf'),
        noteAccent: v('--accent-inferred', '#876900')
    };
}

function mermaidConfig() {
    const t = readThemeVars();
    return {
        startOnLoad: false,
        theme: 'base',
        themeVariables: {
            background: t.bg,
            primaryColor: t.bgElev,
            primaryTextColor: t.text,
            primaryBorderColor: t.border,
            lineColor: t.line,
            secondaryColor: t.bg,
            tertiaryColor: t.bg,
            actorBkg: t.bgElev,
            actorBorder: t.border,
            actorTextColor: t.text,
            signalColor: t.textSoft,
            signalTextColor: t.text,
            labelBoxBkgColor: t.bgElev,
            labelBoxBorderColor: t.border,
            labelTextColor: t.text,
            noteBkgColor: t.bg,
            noteTextColor: t.text,
            noteBorderColor: t.noteAccent,
            sequenceNumberColor: t.bg,
            fontFamily: '-apple-system, "Helvetica Neue", Arial, sans-serif'
        },
        securityLevel: 'strict'
    };
}

async function loadMermaid() {
    if(!mermaidPromise) {
        mermaidPromise = import('mermaid').then((mod) => {
            mermaidLoaded = mod.default || mod;
            globalThis[MERMAID_INSTANCE_KEY] = mermaidLoaded;
            mermaidLoaded.initialize(mermaidConfig());
            return mermaidLoaded;
        });
        globalThis[MERMAID_PROMISE_KEY] = mermaidPromise;
    }
    return mermaidPromise;
}

// Re-apply Mermaid theme based on the currently active CSS variables, then
// re-render mounted diagrams because Mermaid bakes theme colors into the SVG.
//
export function reinitMermaidTheme() {
    if(mermaidLoaded) {
        try { mermaidLoaded.initialize(mermaidConfig()); } catch {}
    }
    refreshMountedMermaidDiagrams();
}

class SequenceDiagram extends BaseToolComponent {
    constructor() {
        super();
        this._renderToken = 0;
        this._lastRenderedSource = '';
        this._hasRenderedSvg = false;
        this._lastSvg = '';
    }

    async renderBody(props) {
        const myToken = ++this._renderToken;
        const isFinal = props._final === true;
        const src = normalizeMermaidSource(props.mermaid || '');
        const frame = this.ensureFrame();

        // Defensive: scrub any leaked mermaid temp containers from previous failed renders.
        //
        document.querySelectorAll('body > [id^="mmd_"]').forEach((n) => n.remove());

        if(!src) {
            if(!this._hasRenderedSvg) {
                frame.innerHTML = fallbackHtml(isFinal, 'empty');
            }
            return;
        }
        if(src === this._lastRenderedSource && this._hasRenderedSvg) {
            return;
        }
        if(!isFinal && !isPlausiblyCompleteMermaid(src)) {
            if(!this._hasRenderedSvg) {
                frame.innerHTML = fallbackHtml(false, 'composing');
            }
            return;
        }

        let mermaid;
        try {
            mermaid = await loadMermaid();
        } catch {
            if(myToken !== this._renderToken) return;
            if(isFinal || !this._hasRenderedSvg) {
                frame.innerHTML = fallbackHtml(isFinal, 'load_failed');
            }
            return;
        }

        if(myToken !== this._renderToken) return;

        // Parse-first: never invoke render() on invalid source. Try the raw
        // source first, then conservative repairs for common model mistakes.
        //
        const rendered = await firstRenderableMermaid(mermaid, src);

        if(myToken !== this._renderToken) return;

        if(!rendered) {
            if(isFinal && !this._repairAttempted && AUTO_MERMAID_REPAIR) {
                this._repairAttempted = true;
                frame.innerHTML = fallbackHtml(true, 'repairing');
                const error = await captureMermaidError(mermaid, src);
                if(myToken !== this._renderToken) return;
                const fixed = await requestMermaidRepair({
                    source: src,
                    diagramType: mermaidDiagramType(props, src),
                    error
                });
                if(myToken !== this._renderToken) return;
                if(fixed && fixed !== src) {
                    const repaired = await firstRenderableMermaid(mermaid, fixed);
                    if(myToken !== this._renderToken) return;
                    if(repaired) {
                        this.setFrameSvg(frame, repaired.svg);
                        this._lastRenderedSource = repaired.source;
                        this._lastSvg = repaired.svg;
                        this._hasRenderedSvg = true;
                        if(this._props) {
                            this._props.mermaid = repaired.source;
                        }
                        frame.classList.add('has-svg');
                        this.dispatchEvent(new CustomEvent('mermaid:repaired', {
                            bubbles: true,
                            composed: true,
                            detail: {componentId: this.dataset.componentId, mermaid: repaired.source}
                        }));
                        return;
                    }
                }
            }
            if(isFinal || !this._hasRenderedSvg) {
                frame.innerHTML = fallbackHtml(isFinal, 'parse_failed');
            }
            return;
        }

        this.setFrameSvg(frame, rendered.svg);
        this._lastRenderedSource = src;
        this._lastSvg = rendered.svg;
        this._hasRenderedSvg = true;
        frame.classList.add('has-svg');
    }

    setFrameSvg(frame, svg) {
        frame.innerHTML = '';
        const actions = document.createElement('div');
        actions.className = 'mermaid-actions';
        const expand = document.createElement('button');
        expand.type = 'button';
        expand.className = 'mermaid-expand';
        expand.textContent = 'Expand';
        expand.addEventListener('click', () => this.openFullscreen());
        actions.appendChild(expand);

        const canvas = document.createElement('div');
        canvas.className = 'mermaid-canvas';
        canvas.innerHTML = svg;
        frame.append(actions, canvas);
    }

    openFullscreen() {
        if(!this._lastSvg) {
            return;
        }
        const overlay = document.createElement('div');
        overlay.className = 'mermaid-fullscreen';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');

        const shell = document.createElement('div');
        shell.className = 'mermaid-fullscreen-shell';
        const bar = document.createElement('div');
        bar.className = 'mermaid-fullscreen-bar';
        const title = document.createElement('div');
        title.className = 'mermaid-fullscreen-title';
        title.textContent = this._props?.caption || 'Diagram';
        const actions = document.createElement('div');
        actions.className = 'mermaid-fullscreen-actions';
        const download = document.createElement('button');
        download.type = 'button';
        download.className = 'mermaid-fullscreen-download';
        download.textContent = 'Download PNG';
        download.addEventListener('click', () => {
            this.downloadPng(download);
        });
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'mermaid-fullscreen-close';
        close.textContent = 'Collapse';
        actions.append(download, close);
        bar.append(title, actions);

        const canvas = document.createElement('div');
        canvas.className = 'mermaid-fullscreen-canvas';
        canvas.innerHTML = this._lastSvg;
        shell.append(bar, canvas);
        overlay.appendChild(shell);
        document.body.appendChild(overlay);

        const cleanup = () => {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
        };
        const onKey = (ev) => {
            if(ev.key === 'Escape') cleanup();
        };
        close.addEventListener('click', cleanup);
        overlay.addEventListener('click', (ev) => {
            if(ev.target === overlay) cleanup();
        });
        document.addEventListener('keydown', onKey);
        close.focus({preventScroll: true});
    }

    async refreshMermaidTheme() {
        const src = normalizeMermaidSource(this._props?.mermaid || '');
        if(!src || !this._hasRenderedSvg) {
            return;
        }
        const myToken = ++this._renderToken;
        let mermaid;
        try {
            mermaid = await loadMermaid();
        } catch {
            return;
        }

        if(myToken !== this._renderToken) {
            return;
        }

        const rendered = await firstRenderableMermaid(mermaid, src).catch(() => null);
        if(myToken !== this._renderToken || !rendered) {
            return;
        }

        const frame = this.ensureFrame();
        this.setFrameSvg(frame, rendered.svg);
        this._lastRenderedSource = src;
        this._lastSvg = rendered.svg;
        this._hasRenderedSvg = true;
        frame.classList.add('has-svg');
    }

    async downloadPng(button) {
        if(!this._lastSvg) {
            return;
        }
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Preparing';
        try {
            await downloadSvgAsPng({
                svg: this._lastSvg,
                filename: pngFilename(this._props?.caption || 'mermaid-diagram')
            });
            button.textContent = 'Downloaded';
        } catch {
            button.textContent = 'Failed';
        } finally {
            setTimeout(() => {
                if(button.isConnected) {
                    button.disabled = false;
                    button.textContent = originalText;
                }
            }, 1200);
        }
    }

    ensureFrame() {
        let frame = this._bodyEl.querySelector('.mermaid-frame');
        if(!frame) {
            this._bodyEl.innerHTML = '';
            frame = document.createElement('div');
            frame.className = 'mermaid-frame';
            frame.innerHTML = fallbackHtml(false, 'composing');
            this._bodyEl.appendChild(frame);
        }
        return frame;
    }
}

function refreshMountedMermaidDiagrams() {
    if(typeof document === 'undefined') {
        return;
    }
    for(const diagram of document.querySelectorAll('tool-sequence-diagram')) {
        diagram.refreshMermaidTheme?.();
    }
}

async function downloadSvgAsPng({svg, filename}) {
    const normalized = normalizeSvgForPng(svg);
    const svgBlob = new Blob([normalized.source], {type: 'image/svg+xml;charset=utf-8'});
    const svgUrl = URL.createObjectURL(svgBlob);
    try {
        const image = document.createElement('img');
        const loaded = new Promise((resolve, reject) => {
            image.addEventListener('load', resolve, {once: true});
            image.addEventListener('error', () => reject(new Error('svg_image_load_failed')), {once: true});
        });
        image.src = svgUrl;
        await loaded;

        const canvas = document.createElement('canvas');
        const scale = pngScale(normalized.width, normalized.height);
        canvas.width = Math.max(1, Math.round(normalized.width * scale));
        canvas.height = Math.max(1, Math.round(normalized.height * scale));
        const context = canvas.getContext('2d');
        if(!context) {
            throw new Error('canvas_unavailable');
        }
        context.fillStyle = readThemeVars().bg;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);

        const pngBlob = await canvasToPngBlob(canvas);
        triggerBlobDownload(pngBlob, filename);
    } finally {
        URL.revokeObjectURL(svgUrl);
    }
}

function normalizeSvgForPng(svgText) {
    const text = String(svgText || '').trim();
    if(!text) {
        throw new Error('empty_svg');
    }
    const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = parsed.documentElement;
    if(!svg || svg.nodeName.toLowerCase() !== 'svg') {
        throw new Error('invalid_svg');
    }
    const size = svgSize(svg);
    if(!svg.getAttribute('xmlns')) {
        svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    }
    if(!parseSvgLength(svg.getAttribute('width'))) {
        svg.setAttribute('width', String(size.width));
    }
    if(!parseSvgLength(svg.getAttribute('height'))) {
        svg.setAttribute('height', String(size.height));
    }
    return {
        source: svg.outerHTML,
        width: size.width,
        height: size.height
    };
}

function svgSize(svg) {
    const viewBox = parseViewBox(svg.getAttribute('viewBox'));
    let width = parseSvgLength(svg.getAttribute('width'));
    let height = parseSvgLength(svg.getAttribute('height'));
    if(width && !height && viewBox) {
        height = width * (viewBox.height / viewBox.width);
    }
    if(height && !width && viewBox) {
        width = height * (viewBox.width / viewBox.height);
    }
    return {
        width: Math.max(1, Math.round(width || viewBox?.width || 1200)),
        height: Math.max(1, Math.round(height || viewBox?.height || 800))
    };
}

function parseSvgLength(value) {
    const text = String(value || '').trim();
    if(!text || text.includes('%')) {
        return null;
    }
    const n = Number.parseFloat(text);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function parseViewBox(value) {
    const parts = String(value || '').trim().split(/[\s,]+/).map(Number);
    if(parts.length !== 4 || !parts.every((part) => Number.isFinite(part)) || parts[2] <= 0 || parts[3] <= 0) {
        return null;
    }
    return {width: parts[2], height: parts[3]};
}

function pngScale(width, height) {
    const targetScale = Math.max(1, Math.min(2, Number(window.devicePixelRatio) || 1));
    const maxPixels = 16_000_000;
    const maxDimension = 8192;
    const basePixels = Math.max(1, width * height);
    const pixelScale = Math.sqrt(maxPixels / basePixels);
    const dimensionScale = Math.min(maxDimension / width, maxDimension / height);
    return Math.max(0.25, Math.min(targetScale, pixelScale, dimensionScale));
}

function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if(blob) {
                resolve(blob);
            } else {
                reject(new Error('png_export_failed'));
            }
        }, 'image/png');
    });
}

function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pngFilename(value) {
    const base = String(value || 'mermaid-diagram')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'mermaid-diagram';
    return `${base}.png`;
}

async function firstRenderableMermaid(mermaid, src, idFactory = randomMermaidId) {
    const repaired = repairMermaid(src);
    const sanitized = sanitizeFlowchartLabels(repaired || src);
    const candidates = uniqueCandidates([src, repaired, sanitized]);
    for(const candidate of candidates) {
        if(!await isParseableMermaid(mermaid, candidate)) {
            continue;
        }

        const svg = await renderMermaidCandidate(mermaid, candidate, idFactory);
        if(svg) {
            return {source: candidate, svg};
        }
    }
    return null;
}

async function isParseableMermaid(mermaid, candidate) {
    try {
        const parsed = await mermaid.parse(candidate, {suppressErrors: true});
        return parsed !== false;
    } catch {
        return false;
    }
}

async function renderMermaidCandidate(mermaid, candidate, idFactory) {
    try {
        const result = await mermaid.render(idFactory(), candidate);
        const svg = typeof result === 'string' ? result : result?.svg;
        if(typeof svg === 'string' && svg && !svg.includes('Syntax error in')) {
            return svg;
        }
    } catch {}
    return null;
}

function randomMermaidId() {
    return `mmd_${Math.random().toString(36).slice(2, 10)}`;
}

function uniqueCandidates(items) {
    const out = [];
    const seen = new Set();
    for(const item of items) {
        if(!item || seen.has(item)) {
            continue;
        }
        seen.add(item);
        out.push(item);
    }
    return out;
}

function normalizeMermaidSource(value) {
    let src = String(value || '').trim();
    src = src.replace(/^```(?:mermaid)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return src;
}

function isPlausiblyCompleteMermaid(src) {
    const lines = src.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if(lines.length < 4) {
        return false;
    }
    if(/^sequenceDiagram\b/i.test(src)) {
        return lines.some((line) => /--?>>/.test(line)) || lines.some((line) => /--?>/.test(line));
    }
    if(/^flowchart\b/i.test(src)) {
        return lines.some((line) => /--?>/.test(line) && /\]\s*$|\}\s*$|\)\s*$|[A-Za-z0-9_]\s*$/.test(line));
    }
    return lines.length >= 5;
}

const MERMAID_BLOCK_OPENERS = /^(alt|opt|loop|par|critical|break|rect|box|subgraph)\b/;

// Drop a stray `end` — a block closer with no open block — mirroring the depth
// counter the server-side lint uses to detect it. Runs for every diagram type,
// and in the replay renderer too, so a saved figure carrying an extra `end`
// self-heals on view instead of falling back to "Figure unavailable".
//
function dropStrayEnd(src) {
    const text = String(src || '');
    const kept = [];
    let depth = 0;
    let changed = false;
    for(const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if(trimmed.startsWith('%%')) {
            kept.push(line);
            continue;
        }
        if(MERMAID_BLOCK_OPENERS.test(trimmed)) {
            depth++;
            kept.push(line);
            continue;
        }
        if(trimmed === 'end') {
            if(depth > 0) {
                depth--;
                kept.push(line);
            } else {
                changed = true;
            }
            continue;
        }
        kept.push(line);
    }
    return changed ? kept.join('\n') : text;
}

function repairMermaid(src) {
    const balanced = dropStrayEnd(src);
    if(/^sequenceDiagram\b/i.test(balanced)) {
        return repairSequenceDiagram(balanced);
    }
    if(!/^flowchart\b/i.test(balanced)) {
        return balanced;
    }
    return sanitizeFlowchartLabels(repairFlowchart(balanced));
}

function repairFlowchart(src) {
    let auto = 0;
    const sourceLines = foldMultilineFlowNodes(src.split(/\r?\n/));
    const lines = [];
    for(let i = 0; i < sourceLines.length; i++) {
        const line = sourceLines[i];
        const trimmed = line.trim();
        if(!trimmed) {
            lines.push(line);
            continue;
        }
        if(/^(?:style|linkStyle)\s+/i.test(trimmed)) {
            continue;
        }

        const flowNote = line.match(/^(\s*)Note\s+(?:right|left|over)\s+of\s+([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/i);
        if(flowNote) {
            const [, indent, anchor, firstText] = flowNote;
            const noteText = [firstText];
            while(i + 1 < sourceLines.length) {
                const next = sourceLines[i + 1].trim();
                if(!next || isFlowchartStatement(next)) {
                    break;
                }
                noteText.push(next);
                i++;
            }
            auto += 1;
            lines.push(`${indent}${anchor} -.-> AutoNote${auto}[${safeFlowLabel(noteText.join(' '))}]`);
            continue;
        }

        const danglingLabeledEdge = line.match(/^(\s*)([A-Za-z][A-Za-z0-9_]*)\s*-->\|([^|]+)$/);
        if(danglingLabeledEdge) {
            const [, indent, from, label] = danglingLabeledEdge;
            auto += 1;
            lines.push(`${indent}${from} --> Auto${auto}[${safeFlowLabel(label)}]`);
            continue;
        }
        lines.push(line);
    }
    return lines.join('\n');
}

function foldMultilineFlowNodes(sourceLines) {
    const out = [];
    for(let i = 0; i < sourceLines.length; i++) {
        const line = sourceLines[i];
        const node = line.match(/^(\s*)([A-Za-z][A-Za-z0-9_]*)\s*[\[({/]+(.+)$/);
        if(!node || /[\])}]\s*$/.test(node[3])) {
            out.push(line);
            continue;
        }

        const [, indent, id, firstText] = node;
        const label = [firstText];
        let closed = false;
        while(i + 1 < sourceLines.length) {
            const next = sourceLines[i + 1].trim();
            if(!next || isFlowchartStatement(next)) {
                break;
            }
            label.push(next);
            i++;
            if(/[\])}]\s*$/.test(next)) {
                closed = true;
                break;
            }
        }

        if(closed) {
            out.push(`${indent}${id}[${safeFlowLabel(label.join(' '))}]`);
        } else {
            out.push(line);
        }
    }
    return out;
}

function isFlowchartStatement(trimmed) {
    return /^(?:flowchart|graph|subgraph|end|classDef|class|click|style|linkStyle)\b/i.test(trimmed) ||
        /^Note\s+(?:right|left|over)\s+of\b/i.test(trimmed) ||
        /^[A-Za-z][A-Za-z0-9_]*\s*(?:-{1,2}>|[-.]+>|==>|---|~~~)/.test(trimmed) ||
        /^[A-Za-z][A-Za-z0-9_]*\s*[\[(/{]/.test(trimmed);
}

function repairSequenceDiagram(src) {
    const participants = sequenceParticipants(src);
    let lastActor = participants[0] || 'System';
    const lines = src.split(/\r?\n/).map((line) => {
        const indent = line.match(/^\s*/)?.[0] || '';
        const trimmed = line.trim();
        if(!trimmed) return line;

        const message = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*)\s*([-.=]+[)>x]+)\s*([A-Za-z][A-Za-z0-9_]*)\s*:(.*)$/);
        if(message) {
            const [, from, arrow, to, text] = message;
            lastActor = to;
            return `${indent}${from}${safeSequenceArrow(arrow)}${to}: ${safeSequenceText(text)}`;
        }

        const reversedNote = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*)\s+Note\s+(right|left|over)\s+of\s+(.+?):\s*(.+)$/i);
        if(reversedNote) {
            lastActor = reversedNote[1];
            return `${indent}Note ${reversedNote[2].toLowerCase()} of ${reversedNote[3].trim()}: ${safeSequenceText(reversedNote[4])}`;
        }

        if(/^continue\b/i.test(trimmed) || /^break\s+(?:inner|outer)?\s*loop\b/i.test(trimmed)) {
            return `${indent}Note right of ${lastActor}: ${safeSequenceText(trimmed)}`;
        }

        // Models sometimes copy an executable source line directly into an
        // otherwise valid sequence diagram. Mermaid accepts operations only as
        // messages or notes, so preserve the useful text as a note. This runs in
        // the replay renderer too, repairing already-saved stories.
        //
        if(isStandaloneSequenceCode(trimmed)) {
            return `${indent}Note right of ${lastActor}: ${safeSequenceText(trimmed)}`;
        }

        return line;
    });
    return lines.join('\n');
}

function isStandaloneSequenceCode(line) {
    return /^(?:(?:yield|return|await|throw|const|let|var|function|class|import|export)\b|(?:if|for|while|switch|try|catch)\s*[({]|[A-Za-z_$][\w$.[\]]*\s*(?:=|\+=|-=|\*=|\/=))/.test(String(line || '').trim());
}

function sequenceParticipants(src) {
    const participants = [];
    const seen = new Set();
    const add = (value) => {
        const name = String(value || '').trim();
        if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || seen.has(name)) {
            return;
        }
        seen.add(name);
        participants.push(name);
    };
    for(const line of String(src || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        const participant = trimmed.match(/^(?:participant|actor)\s+([A-Za-z][A-Za-z0-9_]*)\b/i);
        if(participant) {
            add(participant[1]);
            continue;
        }
        const message = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*)\s*[-=.]+[)>x]+\s*([A-Za-z][A-Za-z0-9_]*)\s*:/);
        if(message) {
            add(message[1]);
            add(message[2]);
        }
    }
    return participants;
}

function safeSequenceArrow(arrow) {
    const value = String(arrow || '').trim();
    if(/[xX]$/.test(value)) {
        return value.startsWith('--') ? '--x' : '-x';
    }
    if(/\)$/.test(value)) {
        return value.startsWith('--') ? '--)' : '-)';
    }
    if(/>$/.test(value)) {
        return value.startsWith('--') ? '-->>' : '->>';
    }
    return value.startsWith('--') ? '-->' : '->';
}

function safeSequenceText(label) {
    return String(label || '')
        .replace(/[<>`]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || 'Step';
}

function safeFlowLabel(label) {
    return String(label || '')
        .replace(/[\[\]{}<>"'`*]/g, '')
        .replace(/[@(),/:\\-]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/"/g, "'")
        .trim()
        .slice(0, 80) || 'Next step';
}

function sanitizeFlowchartLabels(src) {
    if(!/^flowchart\b/i.test(src)) {
        return src;
    }
    return src
        .replace(/\|([^|\n]+)\|/g, (_m, label) => `|${safeFlowLabel(label)}|`)
        .replace(/\[([^\]\n]+)\]/g, (_m, label) => `[${safeFlowLabel(label)}]`)
        .replace(/\{([^}\n]+)\}/g, (_m, label) => `{${safeFlowLabel(label)}}`);
}

// Best-effort parser error text for the repair prompt. The render path parses
// with {suppressErrors:true} and discards the reason, so re-parse here to
// surface it.
//
async function captureMermaidError(mermaid, src) {
    try {
        await mermaid.parse(src);
        return '';
    } catch(err) {
        return String(err?.str || err?.message || err || '').slice(0, 500);
    }
}

function mermaidDiagramType(props, src) {
    const declared = String(props?.diagramType || '').trim();
    if(declared) {
        return declared;
    }
    const header = String(src || '').split(/\r?\n/).find((line) => line.trim())?.trim() || '';
    return header.split(/\s+/)[0] || '';
}

// Ask the server to repair broken Mermaid. Returns the corrected source string,
// or null on any failure/timeout — the caller keeps the fallback in that case.
//
async function requestMermaidRepair({source, diagramType, error}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MERMAID_REPAIR_TIMEOUT_MS);
    try {
        const res = await apiFetch('/api/fix-mermaid', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
                mermaid: source,
                diagramType: diagramType || undefined,
                error: error || undefined
            }),
            signal: controller.signal
        });
        if(!res.ok) {
            return null;
        }
        const data = await res.json();
        const fixed = normalizeMermaidSource(data?.mermaid || '');
        return fixed || null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function fallbackHtml(isFinal, reason) {
    if(!isFinal) {
        return '<div class="mermaid-fallback">Composing figure…</div>';
    }
    if(reason === 'repairing') {
        return '<div class="mermaid-fallback">Repairing figure…</div>';
    }
    const reasonText = reason === 'empty'
        ? 'Figure unavailable — no Mermaid source was produced.'
        : 'Figure unavailable — Mermaid source did not parse.';
    return `<div class="mermaid-fallback">${reasonText}</div>`;
}

export {
    firstRenderableMermaid as __firstRenderableMermaidForTest,
    repairMermaid as __repairMermaidForTest,
};

customElements.define('tool-sequence-diagram', SequenceDiagram);

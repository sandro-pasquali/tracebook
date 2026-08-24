import {BaseToolComponent} from './_base.js';

// <tool-annotated-code-excerpt>
//   Props: { path, language, lineStart, code, caption, callouts: [{line, note}] }
//   Renders a code block with absolute line numbers (starting at lineStart),
//   per-line syntax highlighting (via highlight.js lazy-loaded from local chunk), and
//   inline callouts wedged between source lines.
//

const HLJS_PROMISE_KEY = '__tracebook_hljs_promise__';
const HLJS_INSTANCE_KEY = '__tracebook_hljs_instance__';
let hljsPromise = globalThis[HLJS_PROMISE_KEY] || null;

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

class AnnotatedCodeExcerpt extends BaseToolComponent {
    constructor() {
        super();
        this._renderToken = 0;
    }

    async renderBody(props) {
        const myToken = ++this._renderToken;
        this._bodyEl.innerHTML = '';

        const code = typeof props.code === 'string' ? props.code : '';
        if(code.length === 0) {
            const placeholder = document.createElement('div');
            placeholder.className = 'tool-unsupported';
            placeholder.textContent = 'Composing excerpt…';
            this._bodyEl.appendChild(placeholder);
            return;
        }

        const primaryRef = Array.isArray(props.sourceRefs) && props.sourceRefs[0] ? props.sourceRefs[0] : null;
        const path = primaryRef?.path || '';
        const startLine = Number.isFinite(primaryRef?.lineStart) ? primaryRef.lineStart : 1;
        const displayLanguage = languageLabel(props.language, path);

        const frame = document.createElement('div');
        frame.className = 'code-frame';

        if(path) {
            const pathEl = document.createElement('div');
            pathEl.className = 'code-path';
            pathEl.textContent = path + (displayLanguage ? `  ·  ${displayLanguage}` : '');
            frame.appendChild(pathEl);
        }

        const grid = document.createElement('div');
        grid.className = 'code-grid';

        const lines = code.replace(/\n+$/, '').split('\n');

        const callouts = Array.isArray(props.callouts) ? props.callouts : [];
        const calloutsByLine = new Map();
        for(const c of callouts) {
            if(!c || typeof c.note !== 'string' || !Number.isFinite(c.line)) continue;
            const note = c.note.replace(/\s+/g, ' ').trim();
            if(!note || calloutsByLine.has(c.line)) continue;
            calloutsByLine.set(c.line, [note]);
        }

        const sourceCells = [];

        for(let i = 0; i < lines.length; i++) {
            const relLine = i + 1;
            const absLine = startLine + i;
            const hasCallout = calloutsByLine.has(relLine);

            const rowGutter = document.createElement('div');
            rowGutter.className = `code-gutter ${hasCallout ? 'has-callout' : ''}`.trim();
            rowGutter.textContent = String(absLine);

            const rowSource = document.createElement('div');
            rowSource.className = 'code-source';
            rowSource.textContent = lines[i] || ' ';
            sourceCells.push({el: rowSource, text: lines[i] || ''});

            if(hasCallout) {
                rowSource.classList.add('has-callout');
                const wrap = document.createElement('div');
                wrap.className = 'code-row has-callout';
                wrap.append(rowGutter, rowSource);
                grid.appendChild(wrap);

                for(const note of calloutsByLine.get(relLine)) {
                    const callout = document.createElement('div');
                    callout.className = 'callout';
                    const arrow = document.createElement('span');
                    arrow.className = 'arrow';
                    arrow.textContent = '↳';
                    const text = document.createElement('span');
                    text.textContent = note;
                    callout.append(arrow, text);
                    grid.appendChild(callout);
                }
            } else {
                const wrap = document.createElement('div');
                wrap.className = 'code-row';
                wrap.append(rowGutter, rowSource);
                grid.appendChild(wrap);
            }
        }

        frame.appendChild(grid);
        this._bodyEl.appendChild(frame);

        await this.#highlight(myToken, sourceCells, props.language, path);
    }

    async #highlight(myToken, sourceCells, language, path) {
        const hljs = await loadHljs();
        if(myToken !== this._renderToken) return;
        if(!hljs) return;

        const lang = normalizeLanguage(language) || languageFromPath(path);
        const supports = lang && typeof hljs.getLanguage === 'function' && hljs.getLanguage(lang);

        for(const {el, text} of sourceCells) {
            if(myToken !== this._renderToken) return;
            try {
                const out = supports
                    ? hljs.highlight(text, {language: lang, ignoreIllegals: true})
                    : hljs.highlightAuto(text);
                el.innerHTML = out?.value ?? escapeHtml(text);
                el.classList.add('hljs');
            } catch {
                // leave plain text in place
            }
        }
    }
}

function normalizeLanguage(lang) {
    if(typeof lang !== 'string') return null;
    const l = lang.trim().toLowerCase();
    if(!l) return null;
    if(['html', 'htm', 'xml', 'svg'].includes(l)) return 'xml';
    if(['js', 'jsx', 'mjs', 'cjs'].includes(l)) return 'javascript';
    if(['ts', 'tsx'].includes(l)) return 'typescript';
    if(['sh', 'bash', 'zsh'].includes(l)) return 'bash';
    if(l === 'yml') return 'yaml';
    if(l === 'md') return 'markdown';
    if(l === 'py') return 'python';
    if(l === 'rs') return 'rust';
    if(l === 'cs') return 'csharp';
    if(['c++', 'cpp', 'cc', 'cxx', 'hpp', 'hxx'].includes(l)) return 'cpp';
    if(l === 'kt') return 'kotlin';
    return l;
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
        dockerfile: 'dockerfile'
    };
    return normalizeLanguage(direct[ext] || ext);
}

function languageLabel(language, path) {
    const explicit = typeof language === 'string' ? language.trim().toLowerCase() : '';
    if(explicit) {
        return explicit;
    }
    const value = String(path || '').toLowerCase().split(/[?#]/)[0];
    const match = /\.([a-z0-9]+)$/.exec(value);
    return match ? match[1] : '';
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

customElements.define('tool-annotated-code-excerpt', AnnotatedCodeExcerpt);

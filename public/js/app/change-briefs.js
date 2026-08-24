import {apiFetch} from './team-context.js';

const OUTPUT_FORMAT_LABELS = {
    llm_prompt: 'LLM Prompt',
    repository_issue: 'Repository Issue',
    ticket: 'Ticket'
};

export function createChangeBriefs({
    storyView,
    setStatusCrumb,
    showError
} = {}) {
    function renderAction(event) {
        const chapter = storyView?.getActiveChapter?.();
        if(!chapter?.briefRail || !chapter?.titleRail || !event?.traceId) {
            return;
        }
        chapter.briefRail.innerHTML = '';
        chapter.titleRail.querySelector('.change-brief-header-toggle')?.remove();
        chapter.titleRail.classList.add('has-change-brief-action');

        const panel = document.createElement('section');
        panel.className = 'change-brief-panel';
        panel.dataset.traceId = event.traceId;
        panel.dataset.chapterIndex = String(chapter.index);
        panel.id = `change-brief-panel-${chapter.index}`;
        panel.hidden = true;
        chapter.briefRail.hidden = true;

        const head = document.createElement('div');
        head.className = 'change-brief-head';
        const label = document.createElement('span');
        label.className = 'change-brief-kicker';
        label.textContent = 'next change';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'change-brief-toggle change-brief-header-toggle';
        toggle.textContent = 'Generate Change Brief';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-controls', panel.id);
        head.appendChild(label);
        chapter.titleRail.appendChild(toggle);

        const form = document.createElement('form');
        form.className = 'change-brief-form';

        const textarea = document.createElement('textarea');
        textarea.name = 'changeIntent';
        textarea.rows = 3;
        textarea.maxLength = 4000;
        textarea.placeholder = 'Describe the change you want to make';

        const controls = document.createElement('div');
        controls.className = 'change-brief-controls';
        const formats = document.createElement('div');
        formats.className = 'change-brief-formats';
        formats.setAttribute('role', 'group');
        formats.setAttribute('aria-label', 'Output format');
        let activeOutputFormat = 'llm_prompt';
        let hasGenerated = false;
        for(const [outputFormat, text] of Object.entries(OUTPUT_FORMAT_LABELS)) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'change-brief-format';
            button.dataset.outputFormat = outputFormat;
            button.textContent = text;
            button.setAttribute('aria-pressed', String(outputFormat === activeOutputFormat));
            button.addEventListener('click', () => {
                activeOutputFormat = outputFormat;
                for(const other of formats.querySelectorAll('.change-brief-format')) {
                    other.setAttribute('aria-pressed', String(other === button));
                }
            });
            formats.appendChild(button);
        }

        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.className = 'change-brief-submit';
        submit.textContent = 'Generate';
        controls.append(formats, submit);

        const result = document.createElement('div');
        result.className = 'change-brief-result';

        toggle.addEventListener('click', () => {
            panel.hidden = !panel.hidden;
            chapter.briefRail.hidden = panel.hidden;
            toggle.setAttribute('aria-expanded', String(!panel.hidden));
            toggle.textContent = panel.hidden ? 'Generate Change Brief' : 'Close';
            if(!panel.hidden) {
                textarea.focus();
            }
        });

        form.addEventListener('submit', async (submitEvent) => {
            submitEvent.preventDefault();
            const changeIntent = textarea.value.trim();
            if(!changeIntent) {
                textarea.focus();
                return;
            }
            await generateBrief({
                traceId: event.traceId,
                changeIntent,
                outputFormat: activeOutputFormat,
                submit,
                result,
                hasGenerated: () => hasGenerated,
                markGenerated: () => {
                    hasGenerated = true;
                    submit.textContent = 'Re-generate';
                }
            });
        });

        form.append(textarea, controls);
        panel.append(head, result, form);
        chapter.briefRail.appendChild(panel);
    }

    async function generateBrief({traceId, changeIntent, outputFormat, submit, result, hasGenerated, markGenerated}) {
        const regenerating = hasGenerated?.() === true;
        submit.disabled = true;
        submit.classList.add('is-working');
        submit.setAttribute('aria-busy', 'true');
        submit.textContent = regenerating ? 'Re-generating...' : 'Generating...';
        setStatusCrumb?.('generating change brief');
        try {
            const response = await apiFetch(`/api/traces/${encodeURIComponent(traceId)}/change-brief`, {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({changeIntent, outputFormat})
            });
            const payload = await response.json().catch(() => ({}));
            if(!response.ok) {
                throw new Error(payload?.message || payload?.error || `change_brief_failed:${response.status}`);
            }
            renderBrief(result, payload.brief);
            markGenerated?.();
            setStatusCrumb?.('change brief ready');
        } catch(err) {
            showError?.(err?.message || 'change_brief_failed');
            setStatusCrumb?.('');
        } finally {
            submit.disabled = false;
            submit.classList.remove('is-working');
            submit.removeAttribute('aria-busy');
            if(hasGenerated?.() === true) {
                submit.textContent = 'Re-generate';
            } else {
                submit.textContent = 'Generate';
            }
        }
    }

    return {renderAction};
}

function renderBrief(root, brief) {
    root.innerHTML = '';
    if(!brief) {
        return;
    }
    const article = document.createElement('article');
    article.className = 'change-brief-card';

    const head = document.createElement('div');
    head.className = 'change-brief-card-head';
    const title = document.createElement('h2');
    title.textContent = brief.title || 'Change brief';
    const meta = document.createElement('span');
    meta.className = 'change-brief-meta';
    meta.textContent = brief.freshness === 'stale'
        ? 'source changed since trace'
        : OUTPUT_FORMAT_LABELS[brief.outputFormat] || '';
    head.append(title, meta);

    const goal = section('Product goal', brief.productGoal);
    const behavior = section('Current behavior', brief.currentBehavior);
    const files = fileList(brief.likelyFiles || []);
    const criteria = listSection('Acceptance criteria', brief.acceptanceCriteria || []);
    const risks = textItemsSection('Risk notes', brief.riskNotes || []);
    const questions = listSection('Open questions', brief.openQuestions || []);
    const prompt = outputBlock(brief.agentPrompt || '', brief.outputFormat);

    article.append(head, goal, behavior, files, criteria, risks, questions, prompt);
    root.appendChild(article);
}

function section(title, text) {
    const wrap = document.createElement('section');
    wrap.className = 'change-brief-section';
    const h = document.createElement('h3');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = text || '';
    wrap.append(h, p);
    return wrap;
}

function fileList(files) {
    const wrap = document.createElement('section');
    wrap.className = 'change-brief-section';
    const h = document.createElement('h3');
    h.textContent = 'Likely files';
    const list = document.createElement('div');
    list.className = 'change-brief-files';
    for(const file of files) {
        const item = document.createElement('div');
        item.className = `change-brief-file is-${file.confidence || 'medium'}`;
        const path = document.createElement('div');
        path.className = 'change-brief-file-path';
        path.textContent = file.path;
        const reason = document.createElement('div');
        reason.className = 'change-brief-file-reason';
        reason.textContent = formatFileReason(file);
        item.append(path, reason);
        list.appendChild(item);
    }
    wrap.append(h, list);
    return wrap;
}

function formatFileReason(file) {
    const role = file?.role && file.role !== 'source' ? file.role : '';
    return [role, file?.reason || ''].filter(Boolean).join(' · ');
}

function listSection(title, items) {
    const wrap = document.createElement('section');
    wrap.className = 'change-brief-section';
    const h = document.createElement('h3');
    h.textContent = title;
    const list = document.createElement('ul');
    for(const item of items) {
        const li = document.createElement('li');
        li.textContent = item;
        list.appendChild(li);
    }
    wrap.append(h, list);
    return wrap;
}

function textItemsSection(title, items) {
    return listSection(title, items.map((item) => item.text || '').filter(Boolean));
}

function outputBlock(text, outputFormat) {
    const wrap = document.createElement('section');
    wrap.className = 'change-brief-section change-brief-prompt-section';
    const head = document.createElement('div');
    head.className = 'change-brief-prompt-head';
    const h = document.createElement('h3');
    h.textContent = OUTPUT_FORMAT_LABELS[outputFormat] || 'Generated output';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'change-brief-copy';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
        await navigator.clipboard?.writeText?.(text);
        copy.textContent = 'Copied';
        setTimeout(() => {
            copy.textContent = 'Copy';
        }, 1400);
    });
    head.append(h, copy);
    const pre = document.createElement('pre');
    pre.className = 'change-brief-prompt';
    pre.textContent = text;
    wrap.append(head, pre);
    return wrap;
}

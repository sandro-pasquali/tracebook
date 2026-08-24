import {BaseToolComponent} from './_base.js';

// <tool-evidence-callout>
//   Props: { kind: 'grounded' | 'inferred' | 'gap', summary, detail }
//   Renders a one-line claim plus 2-4 sentence detail, color-coded by kind.
//

const KIND_LABEL = {
    grounded: 'grounded in source',
    inferred: 'inferred from evidence',
    gap: 'coverage gap'
};

const GAP_LABEL = {
    generation_failed: 'generation failure',
    not_retrieved: 'not found in retrieved evidence',
    source_excluded: 'source excluded from index',
    unsupported_type: 'unsupported source type',
    too_large: 'source too large to index'
};

class EvidenceCallout extends BaseToolComponent {
    renderBody(props) {
        this._bodyEl.innerHTML = '';
        const kind = ['grounded', 'inferred', 'gap'].includes(props.kind) ? props.kind : 'inferred';

        const wrap = document.createElement('div');
        wrap.className = `evidence evidence-${kind}`;

        const kindEl = document.createElement('div');
        kindEl.className = 'evidence-kind';
        kindEl.textContent = kind === 'gap'
            ? GAP_LABEL[props.gapReason] || KIND_LABEL.gap
            : KIND_LABEL[kind];

        const content = document.createElement('div');

        const summary = document.createElement('div');
        summary.className = 'evidence-summary';
        summary.textContent = props.summary || ' ';

        const detail = document.createElement('div');
        detail.className = 'evidence-detail';
        detail.textContent = props.detail || ' ';

        content.append(summary, detail);
        wrap.append(kindEl, content);
        this._bodyEl.appendChild(wrap);
    }
}

customElements.define('tool-evidence-callout', EvidenceCallout);

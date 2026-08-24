import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';

test('BaseToolComponent catches async render failures', async () => {
    installHTMLElementShim();
    const {BaseToolComponent} = await import(`../../public/js/components/_base.js?async-failure=${Date.now()}`);

    class BrokenComponent extends BaseToolComponent {
        renderBody() {
            return Promise.reject(new Error('async boom'));
        }
    }

    const component = new BrokenComponent();
    component.tagName = 'TRACE-BROKEN';
    component._mounted = true;
    component._captionEl = elementStub();
    component._kindEl = elementStub();
    component._bodyEl = elementStub();
    component._footerEl = elementStub();

    component.applyProps({caption: 'Broken', sourceRefs: []});
    await sleep(0);

    assert.match(component._bodyEl.innerHTML, /render_failed: async boom/v);
});

test('BaseToolComponent ignores stale async render failures', async () => {
    installHTMLElementShim();
    const {BaseToolComponent} = await import(`../../public/js/components/_base.js?stale-failure=${Date.now()}`);
    let rejectFirst;

    class SometimesBrokenComponent extends BaseToolComponent {
        renderBody(props) {
            if (props.caption === 'first') {
                return new Promise((resolve, reject) => {
                    rejectFirst = reject;
                });
            }

            this._bodyEl.innerHTML = '<div>second render</div>';
            return null;
        }
    }

    const component = new SometimesBrokenComponent();
    component.tagName = 'TRACE-SOMETIMES-BROKEN';
    component._mounted = true;
    component._captionEl = elementStub();
    component._kindEl = elementStub();
    component._bodyEl = elementStub();
    component._footerEl = elementStub();

    component.applyProps({caption: 'first', sourceRefs: []});
    component.applyProps({caption: 'second', sourceRefs: []});
    rejectFirst(new Error('late boom'));
    await sleep(0);

    assert.equal(component._bodyEl.innerHTML, '<div>second render</div>');
});

test('source markdown preview renders with marked and blocks unsafe content', async () => {
    installHTMLElementShim();
    const {__markdownToHtmlForTest} = await import(`../../public/js/components/_base.js?markdown-preview=${Date.now()}`);

    const html = __markdownToHtmlForTest([
        '# Title',
        '',
        '- one',
        '',
        '<script>alert(1)</script>',
        '',
        '[bad](javascript:alert(1))',
        '',
        '[good](https://example.com)',
        '',
        '<a href="/relative">raw link</a>',
        '',
        '<div align="center"><a href="https://hono.dev"><img src="https://example.com/hono.png" width="500" height="auto" alt="Hono"/></a></div><hr />',
    ].join('\n'));

    assert.match(html, /<h1>Title<\/h1>/v);
    assert.match(html, /<li>one<\/li>/v);
    assert.doesNotMatch(html, /<script|alert\(1\)/v);
    assert.doesNotMatch(html, /<a\b/v);
    assert.doesNotMatch(html, /\bhref=/v);
    assert.doesNotMatch(html, /target="_blank"/v);
    assert.match(html, /good/v);
    assert.match(html, /raw link/v);
    assert.match(html, /<div align="center">/v);
    assert.match(html, /<img src="https:\/\/example\.com\/hono\.png" width="500" height="auto" alt="Hono">/v);
    assert.match(html, /<hr>/v);
});

test('source modal title uses opening context instead of repeating file path', async () => {
    installHTMLElementShim();
    const {__sourceModalTitleForTest} = await import(`../../public/js/components/_base.js?source-title=${Date.now()}`);

    const title = __sourceModalTitleForTest({
        path: '.env.example',
        lineStart: 1,
        lineEnd: 41,
        sourceViewerTitle: 'configuration',
    });

    assert.equal(title, 'configuration · lines 1-41');
});

test('dependency source refs display compact dependency labels', async () => {
    installHTMLElementShim();
    const {__sourceRefDisplayForTest} = await import(`../../public/js/components/_base.js?source-display=${Date.now()}`);

    assert.deepEqual(__sourceRefDisplayForTest({
        path: '__dependencies__/npm/huggingface__transformers.md',
    }), {
        kind: 'dependency',
        prefix: 'DEP',
        path: 'huggingface/transformers',
    });
});

function installHTMLElementShim() {
    globalThis.HTMLElement ??= class {
        constructor() {
            this.classList = {
                add() {
                    return undefined;
                },
            };
        }

        append() {
            return undefined;
        }
    };
}

function elementStub() {
    return {
        textContent: '',
        innerHTML: '',
        className: '',
        style: {},
        append() {
            return undefined;
        },
        appendChild() {
            return undefined;
        },
    };
}

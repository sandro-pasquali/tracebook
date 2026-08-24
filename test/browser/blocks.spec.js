import {test} from '@japa/runner';
import {openApp} from './helpers/ui.js';

// Covers the core product output: that each block kind streamed via component.patch
// actually mounts its web component and renders real content (not just side effects).
//
test.group('block rendering', () => {
    test('renders annotated_code_excerpt, sequence_diagram and evidence_callout from component.patch', async ({visit, assert}) => {
        const page = await openApp(visit);
        await page.fill('#ask-input', 'render every BLOCKS kind');
        await page.click('#ask-button');
        await page.waitForFunction(() => (document.querySelector('#status-pill')?.textContent || '').includes('complete'));

        // evidence_callout: summary, kind label, a source chip and a deterministic evidence state.
        //
        await page.waitForSelector('tool-evidence-callout .evidence-summary');
        assert.match((await page.textContent('tool-evidence-callout .evidence-kind')) || '', /grounded/i);
        assert.match((await page.textContent('tool-evidence-callout .evidence-summary')) || '', /Canned callout/);
        assert.isAbove(await page.locator('tool-evidence-callout .tool-footer .src').count(), 0);
        assert.match((await page.textContent('tool-evidence-callout .tool-footer')) || '', /grounded in source/i);
        assert.notMatch((await page.textContent('tool-evidence-callout .tool-footer')) || '', /confidence\s+\d+%/i);

        // annotated_code_excerpt: code frame, the cited path, and the verbatim code.
        //
        await page.waitForSelector('tool-annotated-code-excerpt .code-frame');
        assert.match((await page.textContent('tool-annotated-code-excerpt .code-path')) || '', /src\/server\.js/);
        assert.match((await page.textContent('tool-annotated-code-excerpt')) || '', /new Hono/);

        // sequence_diagram: mounts with its caption and renders a Mermaid SVG.
        //
        await page.waitForSelector('tool-sequence-diagram');
        assert.match((await page.textContent('tool-sequence-diagram .tool-caption')) || '', /Request flow/);
        await page.waitForSelector('tool-sequence-diagram svg', {timeout: 20000});
    });

    test('rerenders rendered mermaid diagrams when the theme changes', async ({visit, assert}) => {
        const page = await openApp(visit);
        await page.evaluate(() => {
            localStorage.setItem('tracebook-theme', 'daylight');
            document.documentElement.setAttribute('data-theme', 'daylight');
        });
        await page.fill('#ask-input', 'render every BLOCKS kind');
        await page.click('#ask-button');
        await page.waitForFunction(() => (document.querySelector('#status-pill')?.textContent || '').includes('complete'));
        await page.waitForSelector('tool-sequence-diagram svg', {timeout: 20000});

        const before = await page.locator('tool-sequence-diagram svg').evaluate((svg) => svg.outerHTML);
        await page.click('#theme-picker-button');
        await page.click('#theme-menu [data-theme-id="forensic"]');
        await page.waitForFunction((previous) => {
            const svg = document.querySelector('tool-sequence-diagram svg');
            return svg && svg.outerHTML !== previous;
        }, before);
        const after = await page.locator('tool-sequence-diagram svg').evaluate((svg) => svg.outerHTML);

        assert.notEqual(after, before);
    });

    test('copies the highlighted source excerpt by default and lets a text selection override it', async ({visit, assert}) => {
        const page = await openApp(visit);
        await page.evaluate(() => {
            window.__clipboardWrites = [];
            window.__codeImageDrawnText = [];
            class FakeClipboardItem {
                constructor(items) {
                    this.items = items;
                    this.types = Object.keys(items);
                }
            }
            Object.defineProperty(window, 'ClipboardItem', {
                configurable: true,
                value: FakeClipboardItem
            });
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: {
                    async write(items) {
                        const writes = [];
                        for(const item of items) {
                            const blob = item.items['image/png'];
                            const bytes = new Uint8Array(await blob.arrayBuffer());
                            writes.push({
                                types: item.types,
                                type: blob.type,
                                size: blob.size,
                                signature: [...bytes.slice(0, 8)]
                            });
                        }
                        window.__clipboardWrites.push(writes);
                    }
                }
            });
            const nativeFillText = globalThis.CanvasRenderingContext2D.prototype.fillText;
            globalThis.CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
                window.__codeImageDrawnText.push(String(text));
                return nativeFillText.call(this, text, ...args);
            };
        });
        await page.fill('#ask-input', 'render every BLOCKS kind');
        await page.click('#ask-button');
        await page.waitForFunction(() => (document.querySelector('#status-pill')?.textContent || '').includes('complete'));

        await page.click('tool-annotated-code-excerpt .tool-footer .src');
        await page.waitForSelector('.source-code-image-button');
        await page.waitForSelector('.source-code-line');
        assert.isFalse(await page.isDisabled('.source-code-image-button'));
        assert.equal(await page.locator('.source-code-image-button').evaluate((button) => getComputedStyle(button).cursor), 'pointer');

        const httpRequests = [];
        page.on('request', (request) => {
            if(/^https?:/v.test(request.url())) {
                httpRequests.push(request.url());
            }
        });
        await page.click('.source-code-image-button');
        await page.waitForSelector('.code-image-dialog');
        assert.match((await page.textContent('.code-image-dialog-message')) || '', /Download code image\?/);
        const defaultImageText = await page.evaluate(() => window.__codeImageDrawnText.join(''));
        assert.include(defaultImageText, 'src/server.js:3-4');
        assert.include(defaultImageText, 'const app = new Hono();');
        assert.include(defaultImageText, 'app.get("/api/health", handler);');

        await page.click('.code-image-dialog-btn:not(.is-primary)');
        await page.waitForSelector('.code-image-dialog', {state: 'detached'});
        await page.waitForFunction(() => {
            const button = document.querySelector('.source-code-image-button');
            return button && !button.disabled && button.textContent === 'Copy Image';
        });

        await page.evaluate(() => {
            window.__codeImageDrawnText = [];
            const line = document.querySelectorAll('.source-code-line')[4];
            const range = document.createRange();
            range.selectNodeContents(line);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
        });
        await page.click('.source-code-image-button');
        await page.waitForSelector('.code-image-dialog');
        const selectedImageText = await page.evaluate(() => window.__codeImageDrawnText.join(''));
        assert.include(selectedImageText, 'src/server.js:5');
        assert.include(selectedImageText, 'app.post("/api/ask", askHandler);');
        assert.notInclude(selectedImageText, 'const app = new Hono();');
        assert.notInclude(selectedImageText, 'app.get("/api/health", handler);');

        const clipboardWrites = await page.evaluate(() => window.__clipboardWrites);
        assert.equal(clipboardWrites.length, 2);
        for(const [write] of clipboardWrites) {
            assert.deepEqual(write.types, ['image/png']);
            assert.equal(write.type, 'image/png');
            assert.isAbove(write.size, 1000);
            assert.deepEqual(write.signature, [137, 80, 78, 71, 13, 10, 26, 10]);
        }

        const downloadPromise = page.waitForEvent('download');
        await page.click('.code-image-dialog-btn.is-primary');
        const download = await downloadPromise;
        assert.equal(download.suggestedFilename(), 'src-server-code.png');

        assert.isFalse(httpRequests.some((url) => new URL(url).pathname === '/api/code-to-image'));
        assert.deepEqual(httpRequests.filter((url) => !isLoopbackUrl(url)), []);
    });

    test('shows code image generation errors in a dialog', async ({visit, assert}) => {
        const page = await openApp(visit);
        await page.fill('#ask-input', 'render every BLOCKS kind');
        await page.click('#ask-button');
        await page.waitForFunction(() => (document.querySelector('#status-pill')?.textContent || '').includes('complete'));

        await page.click('tool-annotated-code-excerpt .tool-footer .src');
        await page.waitForSelector('.source-code-line');
        assert.isFalse(await page.isDisabled('.source-code-image-button'));
        await page.evaluate(() => {
            Object.defineProperty(globalThis.HTMLCanvasElement.prototype, 'toBlob', {
                configurable: true,
                value(callback) {
                    callback(null);
                }
            });
        });

        await page.click('.source-code-image-button');
        await page.waitForSelector('.code-image-dialog');
        assert.match((await page.textContent('.code-image-dialog-title')) || '', /Code image failed/);
        assert.match((await page.textContent('.code-image-dialog-message')) || '', /could not encode the code image as PNG/i);
        await page.click('.code-image-dialog-btn.is-primary');
        await page.waitForSelector('.code-image-dialog', {state: 'detached'});
    });
});

function isLoopbackUrl(value) {
    const hostname = new URL(value).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

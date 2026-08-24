import {test} from '@japa/runner';
import {openApp} from './helpers/ui.js';

// Guards the "working blinker" (.brand-mark.is-working). It is driven solely by
// the status-crumb text. On a clean completion it stops; and — the regression we
// fixed — when the SSE connection drops mid-stream it must ALSO stop, instead of
// pulsing forever.
//
test.group('working blinker', () => {
    test('stops when a trace completes', async ({visit, assert}) => {
        const page = await openApp(visit);
        await page.fill('#ask-input', 'a normal completing question');
        await page.click('#ask-button');
        await page.waitForFunction(() => (document.querySelector('#status-pill')?.textContent || '').includes('complete'));

        assert.isFalse(await page.locator('.brand-mark').evaluate((el) => el.classList.contains('is-working')));
    });

    test('stops when the connection drops mid-stream', async ({visit, assert}) => {
        const page = await openApp(visit);
        // "DROP" makes the canned server emit a couple of events (blinker turns on)
        // then destroy the socket, so the client's SSE fetch throws.
        //
        await page.fill('#ask-input', 'DROP this connection mid stream');
        await page.click('#ask-button');

        // The blinker turns on while events stream...
        //
        await page.waitForFunction(() => document.querySelector('.brand-mark')?.classList.contains('is-working'));
        // ...and after the connection drops, the fix clears the crumb so it stops.
        //
        await page.waitForFunction(() => !document.querySelector('.brand-mark')?.classList.contains('is-working'), undefined, {timeout: 10000});

        assert.isFalse(await page.locator('.brand-mark').evaluate((el) => el.classList.contains('is-working')));
    });

    test('stops when the stream ends with no terminal event', async ({visit, assert}) => {
        const page = await openApp(visit);
        // "INCOMPLETE" makes the canned server emit a couple of events (blinker on)
        // then close the stream cleanly with no trace.complete / trace.error.
        //
        await page.fill('#ask-input', 'INCOMPLETE stream that just stops');
        await page.click('#ask-button');

        await page.waitForFunction(() => document.querySelector('.brand-mark')?.classList.contains('is-working'));
        await page.waitForFunction(() => !document.querySelector('.brand-mark')?.classList.contains('is-working'), undefined, {timeout: 10000});

        assert.isFalse(await page.locator('.brand-mark').evaluate((el) => el.classList.contains('is-working')));
    });
});

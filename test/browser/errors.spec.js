import {test} from '@japa/runner';
import {openApp} from './helpers/ui.js';

// A server-sent trace.error event (distinct from the raw connection drop covered
// in blinker.spec.js): the error is surfaced to the user and the working blinker
// stops.
//
test.group('error paths', () => {
    test('a trace.error event shows the message and stops the blinker', async ({visit, assert}) => {
        const page = await openApp(visit);
        await page.fill('#ask-input', 'please trigger an ERROR');
        await page.click('#ask-button');

        await page.waitForSelector('#footer-rail .error');
        assert.match((await page.textContent('#footer-rail .error')) || '', /planner exploded for the test/);
        assert.isFalse(await page.locator('.brand-mark').evaluate((el) => el.classList.contains('is-working')));
    });
});

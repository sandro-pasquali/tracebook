import {test} from '@japa/runner';
import {openApp, submitQuestion} from './helpers/ui.js';

// Guards the center chapter navigator. Regressions we fixed:
//   - it must navigate ONLY the current story's chapters (never list another story
//     as a chapter), so a single-chapter story shows no navigator;
//   - its ‹/› buttons must wrap and never be disabled at the ends.
//
test.group('chapter navigator', () => {
    test('multi-chapter story shows every chapter and the ‹/› buttons never disable', async ({visit, assert}) => {
        const page = await openApp(visit);
        await submitQuestion(page, 'first chapter question');
        await submitQuestion(page, 'second chapter question');
        await submitQuestion(page, 'third chapter question');

        await page.waitForSelector('#chapter-nav:not([hidden])');
        const count = (await page.textContent('.chapter-nav-current-count')) || '';
        assert.match(count.trim(), /\/\s*03$/);
        assert.equal(await page.locator('.chapter-nav-option').count(), 3);

        // On the LAST chapter the Next button must not be disabled (the regression
        // disabled it at the boundary) and must wrap to the first.
        //
        assert.isFalse(await page.isDisabled('.chapter-nav-step.is-next'));
        await page.click('.chapter-nav-step.is-next');
        await page.waitForFunction(() => (document.querySelector('.chapter-nav-current-count')?.textContent || '').trim().startsWith('01'));

        // On the FIRST chapter the Prev button must not be disabled and must wrap
        // back to the last.
        //
        assert.isFalse(await page.isDisabled('.chapter-nav-step.is-prev'));
        await page.click('.chapter-nav-step.is-prev');
        await page.waitForFunction(() => (document.querySelector('.chapter-nav-current-count')?.textContent || '').trim().startsWith('03'));
    });

    test('single-chapter story hides the navigator and never lists another story', async ({visit, assert}) => {
        const page = await openApp(visit);
        await submitQuestion(page, 'the only chapter question');

        assert.isTrue(await page.locator('#chapter-nav').isHidden());
        assert.equal(await page.locator('.chapter-nav-option').count(), 0);
    });
});

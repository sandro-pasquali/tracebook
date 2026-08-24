import {test} from '@japa/runner';
import {openApp, submitQuestion} from './helpers/ui.js';

test.group('chapter change brief panel', () => {
    test('opens beneath the chapter title, closes, and preserves generated state', async ({visit, assert}) => {
        const page = await openApp(visit);
        await page.setViewportSize({width: 1440, height: 900});

        await submitQuestion(page, 'first chapter question');
        await page.waitForSelector('#title-rail .change-brief-header-toggle', {timeout: 4000});

        const initialState = await page.evaluate(() => {
            const stage = document.querySelector('.stage').getBoundingClientRect();
            const title = document.querySelector('#title-rail').getBoundingClientRect();
            const button = document.querySelector('#title-rail .change-brief-header-toggle').getBoundingClientRect();
            const rail = document.querySelector('#change-brief-panel-0').parentElement;
            return {
                stageWidth: stage.width,
                buttonRightAligned: Math.abs(title.right - button.right) < 1,
                panelFollowsTitle: rail.previousElementSibling === document.querySelector('#title-rail'),
                panelHidden: document.querySelector('#change-brief-panel-0').hidden
            };
        });
        assert.isTrue(initialState.stageWidth <= 1080);
        assert.isTrue(initialState.buttonRightAligned);
        assert.isTrue(initialState.panelFollowsTitle);
        assert.isTrue(initialState.panelHidden);
        assert.equal(await page.locator('#story-sidecar').count(), 0);

        const firstToggle = page.locator('#title-rail .change-brief-header-toggle');
        await firstToggle.click();
        await page.waitForSelector('#change-brief-panel-0:not([hidden])');
        assert.equal(await firstToggle.getAttribute('aria-expanded'), 'true');
        assert.equal(await firstToggle.textContent(), 'Close');
        assert.equal(
            await page.getAttribute('#change-brief-panel-0 textarea[name="changeIntent"]', 'placeholder'),
            'Describe the change you want to make'
        );

        await page.fill('#change-brief-panel-0 textarea[name="changeIntent"]', 'Keep the first chapter intent');
        await page.click('#change-brief-panel-0 .change-brief-submit');
        await page.waitForSelector('#change-brief-panel-0 .change-brief-card', {timeout: 4000});

        await firstToggle.click();
        assert.isTrue(await page.locator('#change-brief-panel-0').isHidden());
        assert.equal(await firstToggle.getAttribute('aria-expanded'), 'false');
        assert.equal(await firstToggle.textContent(), 'Generate Change Brief');

        await firstToggle.click();
        assert.equal(
            await page.inputValue('#change-brief-panel-0 textarea[name="changeIntent"]'),
            'Keep the first chapter intent'
        );
        assert.include(
            await page.textContent('#change-brief-panel-0 .change-brief-card'),
            'Make the chapter behavior explicit'
        );

        await submitQuestion(page, 'second chapter question');
        await page.waitForSelector('.story-chapter .change-brief-header-toggle', {timeout: 4000});
        const secondToggle = page.locator('.story-chapter .change-brief-header-toggle');
        assert.equal(await secondToggle.getAttribute('aria-controls'), 'change-brief-panel-1');
        assert.isTrue(await page.locator('#change-brief-panel-1').isHidden());
        await secondToggle.click();
        assert.isTrue(await page.locator('#change-brief-panel-1').isVisible());
        await secondToggle.click();
        assert.isTrue(await page.locator('#change-brief-panel-1').isHidden());
    });

    test('keeps the title action and inline panel usable on compact screens', async ({visit, assert}) => {
        const page = await openApp(visit);
        await page.setViewportSize({width: 760, height: 900});
        await submitQuestion(page, 'responsive chapter question');
        await page.waitForSelector('#title-rail .change-brief-header-toggle', {timeout: 4000});

        assert.equal(
            await page.evaluate(() => getComputedStyle(document.querySelector('.change-brief-header-toggle')).position),
            'static'
        );
        await page.click('#title-rail .change-brief-header-toggle');
        assert.isTrue(await page.locator('#change-brief-panel-0').isVisible());
    });
});

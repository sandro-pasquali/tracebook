import {test} from '@japa/runner';
import {openApp, baseURL, resetServer} from './helpers/ui.js';

// The story library panel — where story management lives (and where the last
// navigator regression originated). Each test resets the canned server's story
// list so deletes don't couple across tests.
//
test.group('sessions panel', (group) => {
    group.each.setup(() => resetServer());

    test('lists saved stories, filters by search, and deletes one', async ({visit, assert}) => {
        const page = await openApp(visit);
        await page.click('#sessions-button');
        await page.waitForSelector('#sessions-list .session-item-row');
        assert.equal(await page.locator('#sessions-list .session-item-row').count(), 2);

        await page.fill('#sessions-search', 'beta');
        await page.waitForFunction(() => document.querySelectorAll('#sessions-list .session-item-row').length === 1);
        assert.match((await page.textContent('#sessions-list .session-title')) || '', /Beta Story/);

        await page.fill('#sessions-search', '');
        await page.waitForFunction(() => document.querySelectorAll('#sessions-list .session-item-row').length === 2);

        // The delete (trash) button is only revealed on row hover, so hover first.
        //
        const alphaRow = page.locator('.session-item-row', {hasText: 'Alpha Story'});
        await alphaRow.hover();
        await alphaRow.locator('.session-delete').click();
        await page.locator('.session-delete-confirm-btn.is-danger').click();

        await page.waitForFunction(() => document.querySelectorAll('#sessions-list .session-item-row').length === 1);
        assert.match((await page.textContent('#sessions-list .session-title')) || '', /Beta Story/);
    });
});

// The OTHER navigation axis: Shift+Left/Right switches between saved stories
// (separate from the chapter navigator) and wraps at the ends.
//
test.group('story switching', (group) => {
    group.each.setup(() => resetServer());

    test('Shift+Arrow keys move between saved stories and wrap around', async ({visit, assert}) => {
        const page = await visit(`${baseURL()}/story_alpha`);
        await page.waitForSelector('#ask-button:not([disabled])');
        await page.waitForFunction(() => location.pathname === '/story_alpha');

        await delayStoryLoad(page, 'story_beta');
        await forceScrollAwayFromTop(page);
        await page.keyboard.press('Shift+ArrowRight');
        await page.waitForFunction(() => (document.querySelector('#status-pill')?.textContent || '') === 'loading Beta Story');
        await page.waitForFunction(() => location.pathname === '/story_beta');
        await page.waitForFunction(() => window.scrollY === 0);

        // Wraps forward past the end back to the first story.
        //
        await page.keyboard.press('Shift+ArrowRight');
        await page.waitForFunction(() => location.pathname === '/story_alpha');

        // Wraps backward past the start to the last story.
        //
        await page.keyboard.press('Shift+ArrowLeft');
        await page.waitForFunction(() => location.pathname === '/story_beta');

        assert.match((await page.textContent('body')) || '', /Beta Story/);
    });

    test('story library clicks show loading status and land at the top', async ({visit, assert}) => {
        const page = await visit(`${baseURL()}/story_alpha`);
        await page.waitForSelector('#ask-button:not([disabled])');
        await page.waitForFunction(() => location.pathname === '/story_alpha');
        await delayStoryLoad(page, 'story_beta');
        await forceScrollAwayFromTop(page);

        await page.click('#sessions-button');
        await page.waitForSelector('#sessions-list .session-item-row');
        await page.locator('.session-item-row', {hasText: 'Beta Story'}).locator('.session-item').click();

        await page.waitForFunction(() => (document.querySelector('#status-pill')?.textContent || '') === 'loading Beta Story');
        await page.waitForFunction(() => location.pathname === '/story_beta');
        await page.waitForFunction(() => window.scrollY === 0);
        assert.match((await page.textContent('body')) || '', /Beta Story/);
    });

});

async function delayStoryLoad(page, storyId) {
    await page.route(`**/api/stories/${storyId}`, async (route) => {
        await new Promise((resolve) => {
            setTimeout(resolve, 120);
        });
        await route.continue();
    });
}

async function forceScrollAwayFromTop(page) {
    await page.evaluate(() => {
        let spacer = document.getElementById('test-scroll-spacer');
        if(!spacer) {
            spacer = document.createElement('div');
            spacer.id = 'test-scroll-spacer';
            spacer.style.height = '2400px';
            document.body.appendChild(spacer);
        }
        window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await page.waitForFunction(() => window.scrollY > 0);
}

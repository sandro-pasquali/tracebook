// Shared helpers for the browser specs. The canned server's URL is published on
// a global by the Japa setup hook in bin/test-browser.js.
//
export function baseURL() {
    return globalThis.__TEST_BASE_URL;
}

// Reset the canned server's mutable story state between tests so specs that
// delete/mutate stories don't couple through shared state.
//
export async function resetServer() {
    await fetch(`${baseURL()}/__test/reset`);
}

// Open the app and wait until the runtime reports ready (composer enabled).
//
export async function openApp(visit) {
    const page = await visit(baseURL());
    await page.waitForSelector('#ask-button:not([disabled])');
    return page;
}

// Submit a question and wait for the canned trace to finish (status crumb shows
// "complete") and the composer to re-enable, so the next submit can proceed.
//
export async function submitQuestion(page, question) {
    await page.fill('#ask-input', question);
    await page.click('#ask-button');
    await page.waitForFunction(() => (document.querySelector('#status-pill')?.textContent || '').includes('complete'));
    await page.waitForSelector('#ask-button:not([disabled])');
}

import {test} from '@japa/runner';
import {baseURL, resetServer} from './helpers/ui.js';

test.group('admin setup', (group) => {
    group.each.setup(() => resetServer());

    test('first run redirects from the app shell to admin setup when no config file exists', async ({visit}) => {
        await fetch(`${baseURL()}/__test/clear-team-config`);
        const page = await visit(baseURL());

        await page.waitForFunction(() => location.pathname === '/admin');
        await page.waitForSelector('form.team-admin-form');
    });

    test('team page navigation lives in the header', async ({visit, assert}) => {
        const admin = await visit(`${baseURL()}/admin`);
        await admin.waitForSelector('form.team-admin-form');

        assert.equal(await admin.textContent('header.team-topbar .team-header-nav a[href="/repos"]'), 'Repo picker');
        assert.equal(await admin.locator('.team-form-actions a[href="/repos"]').count(), 0);

        const repos = await visit(`${baseURL()}/repos`);
        await repos.waitForSelector('.team-repo-list');

        assert.equal(await repos.textContent('header.team-topbar .team-header-nav a[href="/admin"]'), 'Admin');
        assert.equal(await repos.locator('.team-actions a[href="/admin"]').count(), 0);
    });

    test('explains model workloads and network-last routing choices', async ({visit, assert}) => {
        const page = await visit(`${baseURL()}/admin`);
        await page.waitForSelector('form.team-admin-form');

        assert.include(await page.textContent('[data-model-routing-help]'), 'Repository state, indexes, and evidence selection stay local');
        assert.include(await page.textContent('[data-model-routing-help]'), 'Local memory depends on model size');
        assert.include(await page.textContent('[data-role-help="exploration"]'), 'tool-capable investigation');
        assert.include(await page.textContent('[data-role-help="synthesis"]'), 'scale with component count');
        assert.include(await page.textContent('[data-role-help="hyde"]'), 'not repository evidence');
        assert.include(await page.textContent('[data-role-help="embedding"]'), 'every indexed document or source chunk');
        assert.include(await page.textContent('[data-ollama-endpoint-help]'), 'default loopback URL');
        assert.include(await page.textContent('[data-enrichment-help]'), 'per new or changed source file');
        assert.include(await page.textContent('[data-enrichment-help]'), 'at most Max input chars of source');
    });

    test('saves repo, model, and advanced runtime settings through the admin UI', async ({visit, assert}) => {
        const page = await visit(`${baseURL()}/admin`);
        await page.waitForSelector('form.team-admin-form');

        await page.fill('[name="repoName"]', 'Fixture Repo');
        await page.fill('[name="repoPath"]', '/repo/fixture');
        await page.fill('[name="openaiApiKey"]', 'sk-browser-test');
        await page.fill('[name="exploration"]', 'ollama/devstral');
        await page.fill('[name="tpmBudget"]', '222000');
        await page.fill('[name="embeddingBatch"]', '24');
        await page.fill('[name="embeddingQueryPrefix"]', 'query: ');
        await page.uncheck('[name="dependencyDocsEnabled"]');
        await page.fill('[name="rerankModel"]', 'Xenova/browser-reranker');
        await page.fill('[name="hydeMinSimilarity"]', '0.21');
        await page.fill('[name="enrichmentConcurrency"]', '3');
        await page.fill('[name="componentConcurrency"]', '1');
        await page.fill('[name="readFileMaxLines"]', '177');
        await page.fill('[name="answerCacheTtlMs"]', '123000');
        await page.fill('[name="findTracesLimit"]', '7');

        await page.click('button[type="submit"]');
        await page.waitForFunction(() => (document.querySelector('.team-status')?.textContent || '').includes('Saved'));

        const saved = await (await fetch(`${baseURL()}/__test/team-config-save`)).json();

        assert.equal(saved.repos[0].name, 'Fixture Repo');
        assert.equal(saved.repos[0].path, '/repo/fixture');
        assert.equal(saved.credentials.openaiApiKey, 'sk-browser-test');
        assert.equal(saved.models.exploration, 'ollama/devstral');
        assert.equal(saved.tpmBudget, 222_000);
        assert.equal(saved.embeddings.batch, 24);
        assert.equal(saved.embeddings.queryPrefix, 'query: ');
        assert.equal(saved.dependencyDocs.enabled, false);
        assert.equal(saved.rerank.model, 'Xenova/browser-reranker');
        assert.equal(saved.hyde.minSimilarity, 0.21);
        assert.equal(saved.enrichment.concurrency, 3);
        assert.equal(saved.planner.componentConcurrency, 1);
        assert.equal(saved.tools.readFileMaxLines, 177);
        assert.equal(saved.answerCache.ttlMs, 123_000);
        assert.equal(saved.traces.findLimit, 7);
    });

    test('shows credential fingerprints and clears saved secrets', async ({visit, assert}) => {
        const page = await visit(`${baseURL()}/admin`);
        await page.waitForSelector('form.team-admin-form');

        await page.fill('[name="openaiApiKey"]', 'sk-browser-test');
        await page.click('button[type="submit"]');
        await page.waitForFunction(() => (document.querySelector('.team-status')?.textContent || '').includes('Saved'));

        assert.match(await page.textContent('[data-secret-fingerprint="openaiApiKey"]'), /^Fingerprint sha256:[a-f0-9]{12}$/u);

        await page.click('[data-clear-secret="openaiApiKey"]');

        assert.equal(await page.textContent('[data-secret-fingerprint="openaiApiKey"]'), 'Will clear on save');

        await page.click('button[type="submit"]');
        await page.waitForFunction(() => (document.querySelector('.team-status')?.textContent || '').includes('Saved'));

        const saved = await (await fetch(`${baseURL()}/__test/team-config-save`)).json();
        const current = await (await fetch(`${baseURL()}/api/team/config`)).json();

        assert.deepEqual(saved.clearCredentials, ['openaiApiKey']);
        assert.equal(current.credentials.openaiApiKey, false);
        assert.equal(current.credentialFingerprints.openaiApiKey, '');
    });

    test('restores named advanced sections without changing setup fields', async ({visit, assert}) => {
        const page = await visit(`${baseURL()}/admin`);
        await page.waitForSelector('form.team-admin-form');

        await page.fill('[name="exploration"]', 'ollama/custom-explore');
        await page.fill('[name="embeddingModel"]', 'ollama/custom-embed');
        await page.uncheck('[name="enrichmentEnabled"]');
        await page.uncheck('[name="rerankEnabled"]');
        await page.fill('[name="searchSemanticThreshold"]', '0.12');
        await page.fill('[name="enrichmentConcurrency"]', '9');
        await page.fill('[name="componentConcurrency"]', '1');
        await page.fill('[name="chunkWindowLines"]', '222');
        await page.fill('[name="answerCacheCap"]', '999');

        await page.click('[data-restore-advanced-defaults]');
        await page.waitForFunction(() => (document.querySelector('.team-status')?.textContent || '').includes('Advanced defaults restored'));

        assert.equal(await page.inputValue('[name="searchSemanticThreshold"]'), '0.2');
        assert.equal(await page.inputValue('[name="enrichmentConcurrency"]'), '4');
        assert.equal(await page.inputValue('[name="componentConcurrency"]'), '2');
        assert.equal(await page.inputValue('[name="chunkWindowLines"]'), '80');
        assert.equal(await page.inputValue('[name="answerCacheCap"]'), '50');
        assert.equal(await page.inputValue('[name="exploration"]'), 'ollama/custom-explore');
        assert.equal(await page.inputValue('[name="embeddingModel"]'), 'ollama/custom-embed');
        assert.equal(await page.isChecked('[name="enrichmentEnabled"]'), false);
        assert.equal(await page.isChecked('[name="rerankEnabled"]'), false);

        await page.click('button[type="submit"]');
        await page.waitForFunction(() => (document.querySelector('.team-status')?.textContent || '').includes('Saved'));

        const saved = await (await fetch(`${baseURL()}/__test/team-config-save`)).json();

        assert.equal(saved.models.exploration, 'ollama/custom-explore');
        assert.equal(saved.embeddings.model, 'ollama/custom-embed');
        assert.equal(saved.enrichment.enabled, false);
        assert.equal(saved.rerank.enabled, false);
        assert.equal(saved.search.semanticThreshold, 0.2);
        assert.equal(saved.enrichment.concurrency, 4);
        assert.equal(saved.planner.componentConcurrency, 2);
        assert.equal(saved.chunker.windowLines, 80);
        assert.equal(saved.answerCache.cap, 50);
    });
});

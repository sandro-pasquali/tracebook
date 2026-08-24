import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTraceStore} from '../../src/trace-store.js';
import {createStoryStore} from '../../src/story-store.js';
import {createChangeBriefStore} from '../../src/change-brief/store.js';

test('trace store saves source revisions and compact replay events', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-traces-'));
    const traces = createTraceStore({root});
    const traceId = 'trc_test_123abc';

    await traces.save({
        traceId,
        question: 'How does replay work?',
        startedAt: 100,
        finishedAt: 150,
        model: 'test-model',
        sourceRevision: 'rev-1',
        trace: {
            title: 'Replay',
            components: [{
                type: 'evidence_callout',
                id: 'callout',
                sourceRefs: [{path: 'src/server.js', lineStart: 1, lineEnd: 5}],
            }],
        },
        events: [
            {type: 'timing.checkpoint', name: 'not persisted'},
            {type: 'trace.title', title: 'Replay'},
            {
                type: 'component.patch', id: 'a', index: 0, componentType: 'evidence_callout', props: {summary: 'draft'},
            },
            {
                type: 'component.patch', id: 'a', index: 0, componentType: 'evidence_callout', props: {summary: 'final'},
            },
        ],
    });

    const saved = await traces.load(traceId);
    const summaries = await traces.listSummaries();

    assert.equal(saved.sourceRevision, 'rev-1');
    assert.equal(saved.events.length, 2);
    assert.equal(saved.events[1].props.summary, 'final');
    assert.equal(summaries[0].traceId, traceId);
    assert.deepEqual(summaries[0].sourcePaths, ['src/server.js']);
});

test('trace store lists from a summary sidecar and self-heals when it is deleted', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-traces-'));
    const traces = createTraceStore({root});

    await traces.save({
        traceId: 'trc_one_aaa111',
        question: 'First question',
        startedAt: 100,
        finishedAt: 150,
        model: 'test-model',
        trace: {title: 'First', components: []},
        events: [{type: 'trace.title', title: 'First'}],
    });
    await traces.save({
        traceId: 'trc_two_bbb222',
        question: 'Second question',
        startedAt: 200,
        finishedAt: 260,
        model: 'test-model',
        trace: {title: 'Second', components: []},
        events: [{type: 'trace.title', title: 'Second'}],
    });

    // The sidecar exists and listing returns newest-first by finish time.
    //
    const sidecar = JSON.parse(await fs.readFile(path.join(root, '_summaries.json'), 'utf8'));
    assert.deepEqual(Object.keys(sidecar).sort(), ['trc_one_aaa111', 'trc_two_bbb222']);
    const summaries = await traces.listSummaries();
    assert.deepEqual(summaries.map((s) => s.traceId), ['trc_two_bbb222', 'trc_one_aaa111']);

    // Listing must not surface the sidecar itself as a trace id.
    //
    assert.deepEqual((await traces.list()).sort(), ['trc_one_aaa111', 'trc_two_bbb222']);

    // Deleting the sidecar self-heals by rebuilding from the trace files.
    //
    await fs.rm(path.join(root, '_summaries.json'), {force: true});
    const healed = await traces.listSummaries();
    assert.deepEqual(healed.map((s) => s.traceId), ['trc_two_bbb222', 'trc_one_aaa111']);
    const rebuilt = JSON.parse(await fs.readFile(path.join(root, '_summaries.json'), 'utf8'));
    assert.deepEqual(Object.keys(rebuilt).sort(), ['trc_one_aaa111', 'trc_two_bbb222']);
});

test('story store saves, summarizes, and removes stories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-stories-'));
    const stories = createStoryStore({root});

    const saved = await stories.save({
        storyId: 'story_test_123abc',
        title: 'Checkout Story',
        chapters: [{question: 'How does checkout work?'}],
        sourcePaths: ['src/routes/checkout.js'],
        sourceFingerprints: {
            'src/routes/checkout.js': {status: 'ok', hash: 'hash-1'},
        },
    });
    const loaded = await stories.load(saved.storyId);
    const summaries = await stories.listSummaries();
    const removed = await stories.remove(saved.storyId);

    assert.equal(loaded.title, 'Checkout Story');
    assert.deepEqual(loaded.sourceFingerprints, {
        'src/routes/checkout.js': {status: 'ok', hash: 'hash-1'},
    });
    assert.equal(summaries[0].chapterCount, 1);
    assert.deepEqual(summaries[0].sourceFingerprints, {
        'src/routes/checkout.js': {status: 'ok', hash: 'hash-1'},
    });
    assert.deepEqual(summaries[0].sourcePaths, ['src/routes/checkout.js']);
    assert.deepEqual(removed, {deleted: true, storyId: saved.storyId});
    assert.equal(await stories.load(saved.storyId), null);
});

test('story store lists newest-first from a summary sidecar and self-heals drift', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-stories-'));
    const stories = createStoryStore({root});

    await stories.save({
        storyId: 'story_old_123abc',
        title: 'Old Story',
        createdAt: 100,
        chapters: [{question: 'What happened first?'}],
        sourcePaths: ['src/old.js'],
    });
    await new Promise((resolve) => {
        setTimeout(resolve, 2);
    });
    await stories.save({
        storyId: 'story_new_123abc',
        title: 'New Story',
        createdAt: 200,
        chapters: [{question: 'What happened later?'}, {question: 'What changed?'}],
        sourcePaths: ['src/new.js', 'src/extra.js'],
    });

    const sidecarPath = path.join(root, '_summaries.json');
    const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));

    assert.deepEqual(Object.keys(sidecar).sort(), ['story_new_123abc', 'story_old_123abc']);
    assert.deepEqual((await stories.list()).sort(), ['story_new_123abc', 'story_old_123abc']);
    assert.deepEqual((await stories.listSummaries()).map((story) => story.storyId), ['story_new_123abc', 'story_old_123abc']);
    assert.equal(sidecar.story_new_123abc.chapterCount, 2);
    assert.deepEqual(sidecar.story_new_123abc.sourcePaths, ['src/new.js', 'src/extra.js']);

    await fs.rm(sidecarPath, {force: true});
    const healed = await stories.listSummaries();
    const rebuilt = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));

    assert.deepEqual(healed.map((story) => story.storyId), ['story_new_123abc', 'story_old_123abc']);
    assert.deepEqual(Object.keys(rebuilt).sort(), ['story_new_123abc', 'story_old_123abc']);

    const removed = await stories.remove('story_new_123abc');
    const afterDelete = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));

    assert.equal(removed.deleted, true);
    assert.deepEqual(Object.keys(afterDelete), ['story_old_123abc']);
});

test('story store rejects invalid explicit story ids', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-stories-'));
    const stories = createStoryStore({root});

    await assert.rejects(
        stories.save({
            storyId: '../story_bad',
            title: 'Bad Story',
            chapters: [{question: 'Can this escape?'}],
        }),
        /invalid_story_id/v,
    );

    assert.deepEqual(await fs.readdir(root), []);
});

test('concurrent story saves of the same id neither corrupt the file nor throw', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-stories-'));
    const stories = createStoryStore({root});

    const saves = [];
    for(let i = 0; i < 20; i++) {
        saves.push(stories.save({
            storyId: 'story_hot_123abc',
            title: `Rev ${i}`,
            chapters: [{question: `Question ${i}`}],
            sourcePaths: [`src/file-${i}.js`],
        }));
    }
    await Promise.all(saves);

    const loaded = await stories.load('story_hot_123abc');
    assert.match(loaded.title, /^Rev \d+$/v);
    assert.equal(loaded.chapters.length, 1);

    const leftovers = (await fs.readdir(root)).filter((name) => name.includes('.tmp'));
    assert.deepEqual(leftovers, []);

    const summaries = await stories.listSummaries();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].storyId, 'story_hot_123abc');
});

test('concurrent trace saves of different ids all land in the sidecar', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-traces-'));
    const traces = createTraceStore({root});

    const ids = [];
    const saves = [];
    for(let i = 0; i < 12; i++) {
        const traceId = `trc_race_${String(i).padStart(6, '0')}`;
        ids.push(traceId);
        saves.push(traces.save({
            traceId,
            question: `Question ${i}`,
            startedAt: 100 + i,
            finishedAt: 200 + i,
            trace: {title: `Trace ${i}`, components: []},
            events: [{type: 'trace.title', title: `Trace ${i}`}],
        }));
    }
    await Promise.all(saves);

    const summaries = await traces.listSummaries({limit: 50});
    assert.deepEqual(summaries.map((s) => s.traceId).sort(), ids);
});

test('summary listing racing a save does not lose entries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-traces-'));
    const traces = createTraceStore({root});

    await traces.save({
        traceId: 'trc_base_aaa111',
        question: 'Base',
        startedAt: 100,
        finishedAt: 150,
        trace: {title: 'Base', components: []},
        events: [{type: 'trace.title', title: 'Base'}],
    });

    // Force a drift rebuild on the read path while a save's sidecar upsert is
    // in flight: both mutate the sidecar and must serialize on its chain.
    //
    await fs.rm(path.join(root, '_summaries.json'), {force: true});
    const [, listed] = await Promise.all([
        traces.save({
            traceId: 'trc_race_bbb222',
            question: 'Racing',
            startedAt: 200,
            finishedAt: 260,
            trace: {title: 'Racing', components: []},
            events: [{type: 'trace.title', title: 'Racing'}],
        }),
        traces.listSummaries({limit: 50}),
    ]);
    assert.ok(listed.length >= 1);

    const settled = await traces.listSummaries({limit: 50});
    assert.deepEqual(settled.map((s) => s.traceId).sort(), ['trc_base_aaa111', 'trc_race_bbb222']);
});

test('change brief store saves and loads generated briefs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-briefs-'));
    const briefs = createChangeBriefStore({root});

    const saved = await briefs.save({
        traceId: 'trc_test_123abc',
        title: 'Add export action',
        createdAt: 1000,
    });
    const loaded = await briefs.load(saved.briefId);
    const ids = await briefs.list();

    assert.match(saved.briefId, /^brf_/v);
    assert.equal(loaded.title, 'Add export action');
    assert.deepEqual(ids, [saved.briefId]);
});

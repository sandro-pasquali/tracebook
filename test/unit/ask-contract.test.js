import test from 'node:test';
import assert from 'node:assert/strict';
import {askRequestSchema} from '../../src/server/contracts.js';

// Story context is round-tripped server output (generated titles, narrative
// bullets, prior questions). The contract must clamp over-budget free-text to
// the context budget, never reject it — a saved story bricking its own
// follow-up asks is the regression these tests pin. Budgets sit well above
// natural output (bullets measure 150–250 chars), any clamp cuts at a word
// boundary with an ellipsis, and clamping is reported via `clamped` so the
// ask route can log it.
//

function contextChapter(overrides = {}) {
    return {
        question: 'How does indexing work?',
        title: 'Indexing',
        narrative: ['Files are scanned.'],
        sourcePaths: ['src/index/indexer.js'],
        ...overrides
    };
}

function askBody(chapters) {
    return {
        question: 'And what about chunking?',
        storyContext: {chapters, sourcePaths: []},
        forceFresh: false
    };
}

test('naturally-sized generated bullets pass through untouched', () => {
    // The real story that used to 400: bullets measured 156-252 chars. All of
    // them must round-trip verbatim under the budget — no clamping at all.
    //
    const bullets = [156, 178, 252, 192, 179].map((len) => `A generated narrative bullet. ${'x'.repeat(len - 31)}.`);
    const parsed = askRequestSchema.safeParse(askBody([contextChapter({narrative: bullets})]));

    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data.storyContext.chapters[0].narrative, bullets);
    assert.deepEqual(parsed.data.storyContext.clamped, []);
});

test('an over-budget bullet clamps at a word boundary and is reported', () => {
    const longBullet = 'word '.repeat(150).trim();
    const parsed = askRequestSchema.safeParse(askBody([contextChapter({narrative: ['Short bullet.', longBullet]})]));

    assert.equal(parsed.success, true);
    const narrative = parsed.data.storyContext.chapters[0].narrative;
    assert.equal(narrative[0], 'Short bullet.');
    assert.ok(narrative[1].length <= 500);
    assert.ok(narrative[1].endsWith('…'), 'clamped text ends with an ellipsis');
    assert.equal(narrative[1].includes('wor…'), false, 'never cut mid-word');
    assert.deepEqual(parsed.data.storyContext.clamped, ['chapters[0].narrative[1]']);
});

test('over-budget questions and titles clamp with field descriptors', () => {
    const parsed = askRequestSchema.safeParse(askBody([contextChapter({
        question: 'Why does it work this way? '.repeat(30),
        title: 'A very long generated title. '.repeat(20)
    })]));

    assert.equal(parsed.success, true);
    const chapter = parsed.data.storyContext.chapters[0];
    assert.ok(chapter.question.length <= 500);
    assert.ok(chapter.title.length <= 200);
    assert.ok(chapter.question.endsWith('…'));
    assert.deepEqual(parsed.data.storyContext.clamped.sort(), ['chapters[0].question', 'chapters[0].title']);
});

test('unbroken over-budget text still clamps within the budget', () => {
    const noWhitespace = 'x'.repeat(900);
    const parsed = askRequestSchema.safeParse(askBody([contextChapter({narrative: [noWhitespace]})]));

    assert.equal(parsed.success, true);
    const [bullet] = parsed.data.storyContext.chapters[0].narrative;
    assert.ok(bullet.length <= 500);
    assert.ok(bullet.endsWith('…'));
});

test('the newest chapters and narrative budget are kept, extras dropped', () => {
    const chapters = Array.from({length: 6}, (_, i) => contextChapter({
        question: `Question ${i}`,
        narrative: Array.from({length: 8}, (_, j) => `Chapter ${i} bullet ${j}.`)
    }));
    const parsed = askRequestSchema.safeParse(askBody(chapters));

    assert.equal(parsed.success, true);
    const kept = parsed.data.storyContext.chapters;
    assert.equal(kept.length, 4);
    assert.equal(kept[0].question, 'Question 2');
    assert.equal(kept[3].question, 'Question 5');
    assert.equal(kept[0].narrative.length, 5);
    assert.deepEqual(parsed.data.storyContext.clamped, []);
});

test('empty narrative items drop after trimming', () => {
    const parsed = askRequestSchema.safeParse(askBody([contextChapter({narrative: ['  ', 'Real bullet.', '']})]));

    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data.storyContext.chapters[0].narrative, ['Real bullet.']);
});

test('structural violations still reject strictly', () => {
    const badPath = askRequestSchema.safeParse(askBody([contextChapter({sourcePaths: ['../../etc/passwd']})]));
    assert.equal(badPath.success, false);

    const badShape = askRequestSchema.safeParse({
        question: 'Q',
        storyContext: {chapters: [{...contextChapter(), unexpected: true}], sourcePaths: []},
        forceFresh: false
    });
    assert.equal(badShape.success, false);
});

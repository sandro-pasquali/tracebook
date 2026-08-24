import test from 'node:test';
import assert from 'node:assert/strict';
import {planCallouts} from '../../src/planner/grounding/callouts.js';
import {isNonTeachingValue, isWeakNote} from '../../src/planner/grounding/weak-notes.js';

// The unified weak-note predicate must catch the formulaic callouts that actually
// shipped (they previously slipped the narrower callouts.js list) while leaving
// genuine, behavior-teaching notes alone.
//
const WEAK = [
    'Stores body for later UI decisions.',
    'Stores codeTerms for later retrieval decisions.',
    'Stores title for the surrounding component logic.',
    'Runs inside for, tying this line to the surrounding component scope.',
    'Runs inside if, tying this line to the surrounding request scope.',
    'Keeps document visible because it affects the surrounding UI behavior.',
    'Keeps window visible because it affects the surrounding UI behavior.',
    'Calls foo to do the thing.',
    'Connects this line to the surrounding component behavior.',
    // The families that shipped in a real story before the template factories
    // were emptied — banned here so LLM-written echoes are also caught.
    //
    'Runs inside readTeamConfigFile, tying this line to the surrounding component scope.',
    'Uses .add() as part of the storage or retrieval operation.',
    'Keeps level visible as the available source evidence.',
    'Connects this excerpt to the GET /api/team/defaults/advanced request entrypoint.',
    'Sends incremental output through stream.writeEvent instead of waiting for one final result.'
];

const STRONG = [
    'Creates the primary story runner that orchestrates narrative execution with all necessary callbacks.',
    'Aborts any previous execution run to prevent stale or duplicate processing when starting a new question.',
    'Generates a stable hash key from the target root to isolate data for different repositories.',
    'Initiates a streaming SSE response so the client receives incremental answer data as it is produced.'
];

test('weak/formulaic callout notes are flagged', () => {
    for(const note of WEAK) {
        assert.ok(isWeakNote(note), `should flag as weak: ${JSON.stringify(note)}`);
    }
});

test('behavior-teaching notes are NOT flagged', () => {
    for(const note of STRONG) {
        assert.ok(!isWeakNote(note), `should keep: ${JSON.stringify(note)}`);
    }
});

test('empty/blank notes are weak', () => {
    assert.ok(isWeakNote(''));
    assert.ok(isWeakNote('   '));
});

test('an excerpt with no teaching anchors ships zero callouts, never filler', () => {
    const callouts = planCallouts({callouts: [], lines: ['const a = 1;', 'const b = 2;'], analysis: null, context: {}});
    assert.deepEqual(callouts, []);
});

test('a single strong provided note is not padded with generated company', () => {
    const lines = [
        'const total = items.length;',
        'flushQueue(pending);',
        'return total;'
    ];
    const callouts = planCallouts({
        callouts: [{line: 2, note: 'Flushes the pending queue so earlier writes are durable before the count is reported.'}],
        lines,
        analysis: null,
        context: {},
        preferProvided: true
    });
    assert.equal(callouts.length, 1);
    assert.match(callouts[0].note, /Flushes the pending queue/);
});

test('language keywords and bare globals are non-teaching anchors', () => {
    for(const v of ['for', 'if', 'while', 'document', 'window', 'console', 'this']) {
        assert.ok(isNonTeachingValue(v), `non-teaching: ${v}`);
    }
    for(const v of ['registerAskRoute', 'storyRunner', 'embedder']) {
        assert.ok(!isNonTeachingValue(v), `teaching: ${v}`);
    }
});

test('multi-word "Keeps … visible" filler is flagged as weak', () => {
    assert.ok(isWeakNote('Keeps this line visible because it affects the surrounding request behavior.'));
    assert.ok(isWeakNote('Keeps the parsed url visible because it affects the surrounding UI behavior.'));
});

test('same-tag markup creation notes collapse to one per excerpt', async () => {
    const {defaultCalloutsForExcerpt} = await import('../../src/planner/grounding/callouts.js');
    const lines = [
        '<button id="new-story" class="chrome-button">New story</button>',
        '<button id="sessions" class="chrome-button">Previous stories</button>',
        '<button id="theme-toggle" class="chrome-button">Theme</button>',
        '<nav id="chapter-nav" class="chapter-nav"></nav>',
    ];
    const callouts = await defaultCalloutsForExcerpt(lines, {path: 'public/index.html', language: 'html'});
    const buttonNotes = callouts.filter((c) => /Creates the button#/.test(c.note));
    assert.ok(buttonNotes.length <= 1, `expected at most one button creation note, got ${buttonNotes.length}`);
});

test('cancellation and stream-boundary notes collapse to one per family per excerpt', async () => {
    const {defaultCalloutsForExcerpt} = await import('../../src/planner/grounding/callouts.js');
    const lines = [
        'const controller = new AbortController();',
        'stream.onAbort(() => controller.abort());',
        'controller.abort();',
        'return streamSSE(c, run);',
        'await stream.writeSSE({event: "trace.start"});',
    ];
    const callouts = await defaultCalloutsForExcerpt(lines, {path: 'src/server/ask-route.js', language: 'javascript'});
    const cancellation = callouts.filter((c) => /cancellation|abandoned work/.test(c.note));
    const boundaries = callouts.filter((c) => /streaming boundary/.test(c.note));
    assert.ok(cancellation.length <= 1, `expected at most one cancellation note, got ${cancellation.length}`);
    assert.ok(boundaries.length <= 1, `expected at most one streaming boundary note, got ${boundaries.length}`);
});

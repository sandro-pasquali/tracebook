import test from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {chunkFile, MAX_CHUNK_CHARS} from '../../src/index/chunker.js';

test('chunkFile keeps small supported source files as one line-preserving chunk', async () => {
    const chunks = await chunkFile('export const one = 1;\nexport const two = 2;\n', {path: 'src/app.js'});

    assert.deepEqual(chunks, [{
        lineStart: 1,
        lineEnd: 3,
        content: 'export const one = 1;\nexport const two = 2;\n',
    }]);
});

test('chunkFile rejects unsupported source types instead of heuristic chunking', async () => {
    const chunks = await chunkFile('one\ntwo\nthree', {path: 'notes.txt'});

    assert.deepEqual(chunks, []);
});

test('chunkFile keeps shared documentation artifacts as text chunks', async () => {
    const chunks = await chunkFile('# Setup\n\nRun the server.\n', {path: 'README.md'});

    assert.deepEqual(chunks, [{
        lineStart: 1,
        lineEnd: 4,
        content: '# Setup\n\nRun the server.\n',
    }]);
});

test('chunkFile keeps repo supporting artifacts as text chunks', async () => {
    const chunks = await chunkFile('flask==3.0.0\nrequests>=2\n', {path: 'requirements.txt'});

    assert.deepEqual(chunks, [{
        lineStart: 1,
        lineEnd: 3,
        content: 'flask==3.0.0\nrequests>=2\n',
    }]);
});

test('chunkFile windows long supported source files on parser boundaries', async () => {
    const content = Array.from({length: 100}, (_, index) => `export const value${index + 1} = ${index + 1};`).join('\n');
    const chunks = await chunkFile(content, {path: 'src/generated.js'});

    assert.equal(chunks.length, 2);
    assert.deepEqual(pickRange(chunks[0]), {lineStart: 1, lineEnd: 80});
    assert.deepEqual(pickRange(chunks[1]), {lineStart: 81, lineEnd: 100});
    assert.match(chunks[1].content, /^export const value81/v);
});

test('chunkFile splits a single oversized line without exceeding max chars', async () => {
    const chunks = await chunkFile(`export const payload = "${'x'.repeat(MAX_CHUNK_CHARS + 25)}";`, {path: 'large.js'});

    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks.map(pickRange), [
        {lineStart: 1, lineEnd: 1},
        {lineStart: 1, lineEnd: 1},
    ]);
    assert.ok(chunks.every((chunk) => chunk.content.length <= MAX_CHUNK_CHARS));
});

test('chunkFile window-chunks supported source above the tree-sitter size limit', async () => {
    const content = Array.from({length: 10_000}, (_, index) =>
        `export const value${index} = "${'x'.repeat(55)}";`,
    ).join('\n');
    const bytes = Buffer.byteLength(content, 'utf8');
    assert.ok(content.length > 750_000, `expected >750k chars, got ${content.length}`);
    assert.ok(bytes < 1_000_000, `fixture must remain indexable, got ${bytes} bytes`);

    const chunks = await chunkFile(content, {path: 'src/large-generated.js'});

    assert.ok(chunks.length > 1);
    assert.deepEqual(pickRange(chunks[0]), {lineStart: 1, lineEnd: 80});
    assert.equal(chunks.at(-1).lineEnd, 10_000);
    assert.ok(chunks.every((chunk) => chunk.content.length <= MAX_CHUNK_CHARS));
});

function pickRange(chunk) {
    return {
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
    };
}

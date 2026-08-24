import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createReadFileTool} from '../../src/tools/read-file.js';
import {createListDirTool} from '../../src/tools/list-dir.js';
import {createGrepTool} from '../../src/tools/grep.js';

test('read_file returns bounded line-numbered slices and blocks path escapes', async () => {
    const root = await fixtureRoot();
    const readFile = createReadFileTool({root, exclude: ['secret/**']});

    const slice = await readFile.execute({path: 'src/app.js', lineStart: 2, lineEnd: 3});
    assert.equal(slice.path, 'src/app.js');
    assert.equal(slice.lineStart, 2);
    assert.match(slice.content, /2\s+const token = 'public';/v);

    const escaped = await readFile.execute({path: '../package.json'});
    assert.equal(escaped.error, 'invalid_input');
    assert.ok(escaped.issues.some((issue) => issue.path === 'path'));

    const absolute = await readFile.execute({path: path.join(os.tmpdir(), 'outside.js')});
    assert.equal(absolute.error, 'invalid_input');
    assert.ok(absolute.issues.some((issue) => issue.path === 'path'));

    const normalized = await readFile.execute({path: './src/app.js', lineStart: 1, lineEnd: 1});
    assert.equal(normalized.path, 'src/app.js');
    assert.equal(normalized.lineStart, 1);
    assert.match(normalized.content, /1\s+export function checkout/v);

    const excluded = await readFile.execute({path: 'secret/app.js'});
    assert.equal(excluded.error, 'path_excluded');

    await fs.writeFile(path.join(root, 'src/large.js'), Array.from({length: 1000}, (_, index) => `export const line${index + 1} = ${index + 1};`).join('\n'));
    const largeSlice = await readFile.execute({path: 'src/large.js', lineStart: 998, lineEnd: 1000});
    assert.equal(largeSlice.totalLines, 1000);
    assert.equal(largeSlice.lineStart, 998);
    assert.equal(largeSlice.lineEnd, 1000);
    assert.match(largeSlice.content, /998\s+export const line998 = 998;/v);
    assert.match(largeSlice.content, /1000\s+export const line1000 = 1000;/v);
});

test('read_file rejects promptly when aborted', async () => {
    const root = await fixtureRoot();
    const readFile = createReadFileTool({root, exclude: []});
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        () => readFile.execute({path: 'src/app.js'}, {abortSignal: controller.signal}),
        /aborted/v,
    );
});

test('source tools reject malformed inputs at the zod boundary', async () => {
    const root = await fixtureRoot();
    const readFile = createReadFileTool({root, exclude: []});
    const listDir = createListDirTool({root, exclude: []});
    const grep = createGrepTool({
        root,
        include: ['**/*.js', '**/*.md'],
        exclude: [],
    });

    const unknown = await readFile.execute({path: 'src/app.js', unexpected: true});
    assert.equal(unknown.error, 'invalid_input');
    assert.ok(unknown.issues.some((issue) => issue.code === 'unrecognized_keys'));

    const invertedRange = await readFile.execute({path: 'src/app.js', lineStart: 3, lineEnd: 2});
    assert.equal(invertedRange.error, 'invalid_input');
    assert.ok(invertedRange.issues.some((issue) => issue.path === 'lineEnd'));

    const missingPath = await listDir.execute({path: ''});
    assert.equal(missingPath.error, 'invalid_input');
    assert.ok(missingPath.issues.some((issue) => issue.path === 'path'));

    const emptyPattern = await grep.execute({pattern: '   '});
    assert.equal(emptyPattern.error, 'invalid_input');
    assert.ok(emptyPattern.issues.some((issue) => issue.path === 'pattern'));
});

test('list_dir respects excludes and reports immediate children', async () => {
    const root = await fixtureRoot();
    const listDir = createListDirTool({root, exclude: ['secret/**']});

    const listed = await listDir.execute({path: '.'});

    assert.equal(listed.path, '.');
    assert.deepEqual(listed.entries.map(entry => entry.name).toSorted(), ['README.md', 'src']);
    const escaped = await listDir.execute({path: '../'});
    assert.equal(escaped.error, 'invalid_input');
    assert.ok(escaped.issues.some((issue) => issue.path === 'path'));

    const absolute = await listDir.execute({path: path.join(os.tmpdir(), 'outside')});
    assert.equal(absolute.error, 'invalid_input');
    assert.ok(absolute.issues.some((issue) => issue.path === 'path'));

    const normalized = await listDir.execute({path: './src'});
    assert.equal(normalized.path, 'src');
    assert.deepEqual(normalized.entries.map(entry => entry.name), ['app.js']);

    const excluded = await listDir.execute({path: 'secret'});
    assert.equal(excluded.error, 'path_excluded');
});

test('grep finds fixed string matches across included files', async () => {
    const root = await fixtureRoot();
    const grep = createGrepTool({
        root,
        include: ['**/*.js', '**/*.md'],
        exclude: ['secret/**'],
    });

    const result = await grep.execute({pattern: 'checkout', limit: 5});

    assert.equal(result.error, undefined);
    assert.equal(result.count, 2);
    assert.deepEqual(result.matches.map(match => match.path).toSorted(), ['README.md', 'src/app.js']);
});

test('grep fallback scans files by line without ripgrep', async () => {
    const root = await fixtureRoot();
    await fs.writeFile(path.join(root, 'src/large.js'), Array.from({length: 1000}, (_, index) =>
        index === 899 ? 'export const fallbackNeedle = true;' : `export const line${index + 1} = ${index + 1};`,
    ).join('\n'));
    const grep = createGrepTool({
        root,
        include: ['**/*.js', '**/*.md'],
        exclude: ['secret/**'],
        ripgrep: async () => null,
    });

    const result = await grep.execute({pattern: 'fallbackNeedle', limit: 5});

    assert.equal(result.error, undefined);
    assert.equal(result.count, 1);
    assert.deepEqual(result.matches[0], {
        path: 'src/large.js',
        line: 900,
        content: 'export const fallbackNeedle = true;',
    });
});

test('source tools never expose repository symlinks', async (t) => {
    const root = await fixtureRoot();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-tools-outside-'));
    const outsideFile = path.join(outside, 'outside.js');
    const fileLink = path.join(root, 'src', 'linked.js');
    const directoryLink = path.join(root, 'linked-dir');
    await fs.writeFile(outsideFile, 'export const outsideNeedle = true;\n');
    if(!await createSymlinkOrSkip(t, outsideFile, fileLink, 'file')) {
        return;
    }
    if(!await createSymlinkOrSkip(t, outside, directoryLink, 'dir')) {
        return;
    }

    const readFile = createReadFileTool({root, exclude: []});
    const listDir = createListDirTool({root, exclude: []});
    const grep = createGrepTool({
        root,
        include: ['**/*.js'],
        exclude: [],
        // Exercise the result-boundary check even if an alternate rg build or
        // injected implementation reports a symlink match.
        //
        ripgrep: async () => [{path: 'src/linked.js', line: 1, content: 'outsideNeedle'}],
    });

    assert.deepEqual(await readFile.execute({path: 'src/linked.js'}), {
        error: 'symlink_excluded',
        path: 'src/linked.js',
    });
    assert.deepEqual(await readFile.execute({path: 'linked-dir/outside.js'}), {
        error: 'symlink_excluded',
        path: 'linked-dir/outside.js',
    });
    const listed = await listDir.execute({path: '.'});
    assert.equal(listed.entries.some((entry) => entry.name === 'linked-dir'), false);
    const found = await grep.execute({pattern: 'outsideNeedle'});
    assert.equal(found.count, 0);
});

test('source tools respect repository ignore files', async () => {
    const root = await fixtureRoot();
    await fs.writeFile(path.join(root, '.gitignore'), 'secret/\n');
    const readFile = createReadFileTool({root, exclude: []});
    const listDir = createListDirTool({root, exclude: []});
    const grep = createGrepTool({
        root,
        include: ['**/*.js', '**/*.md'],
        exclude: [],
    });

    const read = await readFile.execute({path: 'secret/app.js'});
    const listed = await listDir.execute({path: '.'});
    const found = await grep.execute({pattern: 'checkout', limit: 10});

    assert.equal(read.error, 'path_excluded');
    assert.equal(listed.entries.some((entry) => entry.name === 'secret'), false);
    assert.equal(listed.entries.some((entry) => entry.name === 'src'), true);
    assert.deepEqual(found.matches.map((match) => match.path).toSorted(), ['README.md', 'src/app.js']);
});

test('virtual dependency docs respect ignored manifests', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-tools-deps-'));
    await fs.writeFile(path.join(root, '.gitignore'), 'package.json\n');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({dependencies: {leftpad: '^1.0.0'}}));
    const readFile = createReadFileTool({root, exclude: []});

    const doc = await readFile.execute({path: '__dependencies__/npm/manifest.md'});

    assert.equal(doc.error, 'not_found');
});

async function fixtureRoot() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-tools-'));
    await fs.mkdir(path.join(root, 'src'), {recursive: true});
    await fs.mkdir(path.join(root, 'secret'), {recursive: true});
    await fs.writeFile(path.join(root, 'src/app.js'), [
        'export function checkout() {',
        '    const token = \'public\';',
        '    return token;',
        '}',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'README.md'), 'checkout docs\n');
    await fs.writeFile(path.join(root, 'secret/app.js'), 'checkout secret\n');
    return root;
}

async function createSymlinkOrSkip(t, target, link, type) {
    try {
        await fs.symlink(target, link, type);
        return true;
    } catch(err) {
        if(err?.code === 'EPERM' || err?.code === 'EACCES') {
            t.skip(`symlinks unavailable: ${err.code}`);
            return false;
        }
        throw err;
    }
}

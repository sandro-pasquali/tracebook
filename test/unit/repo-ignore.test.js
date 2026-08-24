import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRepoIgnore} from '../../src/util/repo-ignore.js';

test('repo ignore policy applies root and nested ignore files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-ignore-'));
    await fs.mkdir(path.join(root, 'ignored'), {recursive: true});
    await fs.mkdir(path.join(root, 'src', 'nested', 'private'), {recursive: true});
    await fs.mkdir(path.join(root, 'build'), {recursive: true});
    await fs.writeFile(path.join(root, '.gitignore'), [
        'ignored/**',
        '!ignored/keep.js',
        '*.generated.js',
        'build/',
        'src/nested/private/',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'src', 'nested', '.gitignore'), 'local-only.js\n');
    const ignore = createRepoIgnore({root});

    assert.equal(await ignore.isIgnored('ignored/file.js'), true);
    assert.equal(await ignore.isIgnored('ignored/keep.js'), false);
    assert.equal(await ignore.isIgnored('src/app.generated.js'), true);
    assert.equal(await ignore.isIgnored('build', {isDirectory: true}), true);
    assert.equal(await ignore.isIgnored('build/app.js'), true);
    assert.equal(await ignore.isIgnored('src/nested/private/app.js'), true);
    assert.equal(await ignore.isIgnored('src/nested/local-only.js'), true);
    assert.equal(await ignore.isIgnored('src/app.js'), false);
});

test('repo ignore filter preserves only visible files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-ignore-filter-'));
    await fs.mkdir(path.join(root, 'src'), {recursive: true});
    await fs.writeFile(path.join(root, '.ignore'), '*.secret.js\n');
    const ignore = createRepoIgnore({root});

    const visible = await ignore.filter([
        'src/app.js',
        'src/app.secret.js',
        './src/../src/visible.js',
    ]);

    assert.deepEqual(visible, ['src/app.js', './src/../src/visible.js']);
});

test('repo ignore policy applies git info excludes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-ignore-info-'));
    await fs.mkdir(path.join(root, '.git', 'info'), {recursive: true});
    await fs.writeFile(path.join(root, '.git', 'info', 'exclude'), 'private.log\n');
    const ignore = createRepoIgnore({root});

    assert.equal(await ignore.isIgnored('private.log'), true);
    assert.equal(await ignore.isIgnored('public.log'), false);
});

test('repo ignore policy does not load nested ignore files under ignored directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-ignore-nested-'));
    await fs.mkdir(path.join(root, 'build'), {recursive: true});
    await fs.writeFile(path.join(root, '.gitignore'), 'build/\n');
    await fs.writeFile(path.join(root, 'build', '.gitignore'), '!keep.js\n');
    const ignore = createRepoIgnore({root});

    assert.equal(await ignore.isIgnored('build/keep.js'), true);
});

test('license boilerplate is soft-ignored by default and re-includable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-ignore-'));
    await fs.writeFile(path.join(root, 'LICENSE.md'), '# AGPL');
    const ignore = createRepoIgnore({root});

    assert.equal(await ignore.isIgnored('LICENSE.md'), true);
    assert.equal(await ignore.isIgnored('COPYING'), true);
    assert.equal(await ignore.isIgnored('NOTICE.txt'), true);
    assert.equal(await ignore.isIgnored('src/app.js'), false);

    const optedIn = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-ignore-'));
    await fs.writeFile(path.join(optedIn, '.tracebookignore'), '!LICENSE*\n');
    const optedInIgnore = createRepoIgnore({root: optedIn});

    assert.equal(await optedInIgnore.isIgnored('LICENSE.md'), false);
});

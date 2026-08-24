import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRepositoryPathResolver} from '../../src/util/source-path.js';

test('repository path resolver returns canonical normal files and blocks lexical escapes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-source-path-'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'app.js'), 'export const app = true;\n');
    const resolveRepositoryPath = createRepositoryPathResolver(root);

    const source = await resolveRepositoryPath('src/app.js');
    const escaped = await resolveRepositoryPath('../outside.js');
    const missing = await resolveRepositoryPath('src/missing.js');

    assert.equal(source.ok, true);
    assert.equal(source.path, await fs.realpath(path.join(root, 'src', 'app.js')));
    assert.deepEqual(escaped, {ok: false, reason: 'path_escape'});
    assert.deepEqual(missing, {ok: false, reason: 'not_found'});
});

test('repository path resolver rejects file and intermediate directory symlinks', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-source-path-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-source-path-outside-'));
    await fs.writeFile(path.join(outside, 'outside.js'), 'export const secret = true;\n');
    await fs.mkdir(path.join(root, 'src'));
    if(!await createSymlinkOrSkip(t, path.join(outside, 'outside.js'), path.join(root, 'src', 'file-link.js'), 'file')) {
        return;
    }
    if(!await createSymlinkOrSkip(t, outside, path.join(root, 'directory-link'), 'dir')) {
        return;
    }
    const resolveRepositoryPath = createRepositoryPathResolver(root);

    assert.deepEqual(await resolveRepositoryPath('src/file-link.js'), {ok: false, reason: 'symlink_excluded'});
    assert.deepEqual(await resolveRepositoryPath('directory-link/outside.js'), {ok: false, reason: 'symlink_excluded'});
});

test('repository path resolver permits a configured root that is itself a symlink', async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-source-root-link-'));
    const root = path.join(parent, 'checkout');
    const linkedRoot = path.join(parent, 'configured-root');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'app.js'), 'export const app = true;\n');
    if(!await createSymlinkOrSkip(t, root, linkedRoot, 'dir')) {
        return;
    }
    const resolveRepositoryPath = createRepositoryPathResolver(linkedRoot);

    const source = await resolveRepositoryPath('app.js');

    assert.equal(source.ok, true);
    assert.equal(source.path, await fs.realpath(path.join(root, 'app.js')));
});

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

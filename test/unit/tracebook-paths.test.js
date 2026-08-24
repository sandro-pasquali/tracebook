import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {ensureTracebookHome, resolveTracebookPaths} from '../../src/util/tracebook-paths.js';

test('Tracebook paths live under one home-directory application root', () => {
    const paths = resolveTracebookPaths({
        homeDir: '/Users/example',
        configPathOverride: null
    });

    assert.deepEqual(paths, {
        home: path.resolve('/Users/example/.tracebook'),
        configPath: path.resolve('/Users/example/.tracebook/tracebook.config.json'),
        dataRoot: path.resolve('/Users/example/.tracebook/data'),
        reposRoot: path.resolve('/Users/example/.tracebook/data/repos')
    });
});

test('the isolated config-path seam keeps all test state under one temporary home', () => {
    const configPath = path.resolve('/tmp/tracebook-test-home/tracebook.config.json');
    const paths = resolveTracebookPaths({configPathOverride: configPath});

    assert.deepEqual(paths, {
        home: path.dirname(configPath),
        configPath,
        dataRoot: path.resolve(path.dirname(configPath), 'data'),
        reposRoot: path.resolve(path.dirname(configPath), 'data/repos')
    });
});

test('boot initialization creates private application directories idempotently', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-paths-'));
    const paths = resolveTracebookPaths({
        configPathOverride: path.join(root, '.tracebook', 'tracebook.config.json')
    });
    try {
        ensureTracebookHome(paths);
        ensureTracebookHome(paths);

        assert.equal((await fs.stat(paths.home)).isDirectory(), true);
        assert.equal((await fs.stat(paths.reposRoot)).isDirectory(), true);
        assert.equal(await fs.pathExists(paths.configPath), false);
        assert.equal((await fs.stat(paths.home)).mode & 0o777, 0o700);
    } finally {
        await fs.remove(root);
    }
});

test('boot initialization fails when the application home is not a directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-paths-blocked-'));
    const blocked = path.join(root, '.tracebook');
    await fs.writeFile(blocked, 'not a directory');
    const paths = {
        home: blocked,
        configPath: path.join(blocked, 'tracebook.config.json'),
        dataRoot: path.join(blocked, 'data'),
        reposRoot: path.join(blocked, 'data', 'repos')
    };
    try {
        assert.throws(
            () => ensureTracebookHome(paths),
            /Tracebook application storage is unavailable/v
        );
    } finally {
        await fs.remove(root);
    }
});

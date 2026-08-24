import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createSourceCorpusPolicy} from '../../src/index/source-corpus-policy.js';

test('source corpus policy centralizes hard excludes, source gating, and repo ignores', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-source-policy-'));
    await fs.mkdir(path.join(root, 'src'), {recursive: true});
    await fs.mkdir(path.join(root, 'secret'), {recursive: true});
    await fs.mkdir(path.join(root, 'node_modules', 'pkg'), {recursive: true});
    await fs.writeFile(path.join(root, '.gitignore'), 'secret/\n');
    await fs.writeFile(path.join(root, 'src', 'app.js'), 'export const app = true;\n');
    await fs.writeFile(path.join(root, 'README.md'), '# App\n');
    await fs.writeFile(path.join(root, 'package.json'), '{"dependencies":{"leftpad":"^1.0.0"}}\n');
    await fs.writeFile(path.join(root, 'secret', 'app.js'), 'export const secret = true;\n');
    await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'export const dependency = true;\n');
    await fs.writeFile(path.join(root, 'notes.unknownext'), 'not source\n');

    const policy = createSourceCorpusPolicy({root, include: ['**/*'], exclude: []});

    assert.deepEqual(await policy.listIndexableFiles(), [
        'README.md',
        'package.json',
        'src/app.js',
    ]);
    assert.deepEqual(
        await policy.filterVisiblePaths(['secret/app.js', 'src/app.js', 'README.md']),
        ['src/app.js', 'README.md'],
    );
    assert.deepEqual(await policy.checkPath('secret/app.js'), {
        ok: false,
        reason: 'repo_ignored',
        path: 'secret/app.js',
    });
    assert.equal((await policy.checkPath('node_modules/pkg/index.js')).reason, 'path_excluded');
    assert.equal((await policy.checkPath('notes.unknownext')).reason, 'source_type_excluded');
    assert.equal(policy.checkHardPath('../outside.js').reason, 'path_escape');
    assert.equal(policy.matchesWatchPath('src/app.js'), true);
    assert.equal(policy.matchesWatchPath('notes.unknownext'), false);
});

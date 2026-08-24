import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {collectDependencyDocs} from '../../src/index/dependency-docs.js';

test('dependency docs format npm manifests as structured markdown', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-deps-'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
        name: 'sample-app',
        description: 'A sample project',
        packageManager: 'yarn@1.22.22',
        type: 'module',
        engines: {node: '>=24.0.0'},
        scripts: {
            test: 'node --test',
        },
        dependencies: {
            hono: '^4.0.0',
        },
    }, null, 2));

    const docs = await collectDependencyDocs({root});
    const manifest = docs.find(doc => doc.path === '__dependencies__/npm/manifest.md');
    const dependency = docs.find(doc => doc.path === '__dependencies__/npm/hono.md');

    assert.ok(manifest);
    assert.match(manifest.content, /^# Dependency manifest: npm package\.json/v);
    assert.match(manifest.content, /## Project/v);
    assert.match(manifest.content, /\| Manifest \| `package\.json` \|/v);
    assert.match(manifest.content, /## Engines/v);
    assert.match(manifest.content, /## Scripts/v);
    assert.match(manifest.content, /### test/v);
    assert.match(manifest.content, /~~~ sh\nnode --test\n~~~/v);
    assert.doesNotMatch(manifest.content, /^scripts:/mv);

    assert.ok(dependency);
    assert.match(dependency.content, /## Declaration/v);
    assert.match(dependency.content, /\| Declared spec \| `\^4\.0\.0` \|/v);
});

test('dependency docs strip package README chrome before excerpts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-deps-'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
        name: 'sample-app',
        dependencies: {
            hono: '^4.0.0',
            vite: '^7.0.0',
        },
    }, null, 2));

    await writeInstalledPackage(root, 'hono', {
        version: '4.0.0',
        description: 'Web framework',
    }, [
        '<div align="center">',
        '  <a href="https://hono.dev">',
        '    <img src="https://example.com/hono.png" width="500" height="auto" alt="Hono"/>',
        '  </a>',
        '</div>',
        '<hr />',
        '[![npm](https://img.shields.io/npm/v/hono.svg)](https://npmjs.com/package/hono)',
        '',
        '# Hono',
        '',
        'Hono - _**means flame in Japanese**_ - is a web framework.',
    ].join('\n'));
    await writeInstalledPackage(root, 'vite', {
        version: '7.0.0',
        description: 'Native-ESM powered web dev build tool',
        bin: {
            vite: 'bin/vite.js',
        },
    }, [
        '# Vite ⚡',
        '',
        '> Next Generation Frontend Tooling',
        '',
        '- Instant Server Start',
    ].join('\n'));

    const docs = await collectDependencyDocs({root});
    const hono = docs.find(doc => doc.path === '__dependencies__/npm/hono.md');
    const vite = docs.find(doc => doc.path === '__dependencies__/npm/vite.md');

    assert.ok(hono);
    assert.doesNotMatch(hono.content, /<div align="center">/v);
    assert.doesNotMatch(hono.content, /img\.shields/v);
    assert.doesNotMatch(hono.content, /^# Hono$/mv);
    assert.match(hono.content, /Hono - _\*\*means flame in Japanese\*\*_/v);

    assert.ok(vite);
    assert.doesNotMatch(vite.content, /^# Vite/vm);
    assert.match(vite.content, /> Next Generation Frontend Tooling/v);
    assert.ok(vite.content.includes('~~~ json\n{\n  "vite": "bin/vite.js"\n}\n~~~'));
});

test('dependency docs do not read installed package metadata through repository symlinks', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-deps-symlink-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-deps-outside-'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
        name: 'sample-app',
        dependencies: {escape: '^1.0.0'},
    }));
    await fs.writeFile(path.join(outside, 'package.json'), JSON.stringify({
        name: 'escape',
        version: '1.2.3',
        description: 'OUTSIDE_PACKAGE_SECRET',
    }));
    await fs.writeFile(path.join(outside, 'README.md'), 'OUTSIDE_README_SECRET\n');
    await fs.mkdir(path.join(root, 'node_modules'), {recursive: true});
    try {
        await fs.symlink(outside, path.join(root, 'node_modules', 'escape'), 'dir');
    } catch(err) {
        if(err?.code === 'EPERM' || err?.code === 'EACCES') {
            t.skip(`symlinks unavailable: ${err.code}`);
            return;
        }
        throw err;
    }

    const docs = await collectDependencyDocs({root});
    const dependency = docs.find((doc) => doc.path === '__dependencies__/npm/escape.md');

    assert.ok(dependency);
    assert.match(dependency.content, /Declared spec/v);
    assert.doesNotMatch(dependency.content, /OUTSIDE_PACKAGE_SECRET|OUTSIDE_README_SECRET/v);
    assert.doesNotMatch(dependency.content, /1\.2\.3/v);
});

test('dependency docs are collected by language-specific integrations', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tracebook-deps-'));

    await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
            target: 'ES2024',
            module: 'NodeNext',
            strict: true,
        },
        include: ['src/**/*.ts'],
    }, null, 2));
    await fs.writeFile(path.join(root, 'pyproject.toml'), [
        '[project]',
        'dependencies = [',
        '  "requests>=2.31",',
        ']',
        '',
        '[project.optional-dependencies]',
        'dev = ["pytest>=8"]',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'go.mod'), [
        'module example.com/app',
        '',
        'require (',
        '  github.com/acme/lib v1.2.3',
        ')',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'Cargo.toml'), [
        '[package]',
        'name = "sample"',
        'version = "0.1.0"',
        '',
        '[dependencies]',
        'serde = "1"',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'composer.json'), JSON.stringify({
        require: {
            'monolog/monolog': '^3.0',
        },
    }, null, 2));
    await fs.writeFile(path.join(root, 'pom.xml'), [
        '<project>',
        '  <dependencies>',
        '    <dependency>',
        '      <groupId>org.example</groupId>',
        '      <artifactId>demo</artifactId>',
        '      <version>1.0</version>',
        '    </dependency>',
        '  </dependencies>',
        '</project>',
    ].join('\n'));

    const docs = await collectDependencyDocs({root});

    assert.ok(docs.find(doc => doc.path === '__dependencies__/typescript/tsconfig.json.md'));
    assert.ok(docs.find(doc => doc.path === '__dependencies__/python/requests.md'));
    // pytest is under [project.optional-dependencies] dev — a dev group, so it is
    // intentionally NOT documented (runtime deps only).
    //
    assert.ok(!docs.some(doc => doc.path === '__dependencies__/python/pytest.md'));
    assert.ok(docs.find(doc => doc.path === '__dependencies__/go/github.com__acme__lib.md'));
    assert.ok(docs.find(doc => doc.path === '__dependencies__/rust/serde.md'));
    assert.ok(docs.find(doc => doc.path === '__dependencies__/php/monolog__monolog.md'));
    assert.ok(docs.some(doc => doc.content.includes('org.example:demo:1.0')));
});

async function writeInstalledPackage(root, name, manifest, readme) {
    const packageRoot = path.join(root, 'node_modules', ...name.split('/'));
    await fs.mkdir(packageRoot, {recursive: true});
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
        name,
        ...manifest,
    }, null, 2));
    await fs.writeFile(path.join(packageRoot, 'README.md'), readme);
}

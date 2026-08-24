import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_INDEX_EXCLUDE, DEFAULT_INDEX_INCLUDE, effectiveIndexExclude} from '../../src/index/file-patterns.js';
import {
    DEFAULT_LANGUAGE_SOURCE_EXCLUDE,
    DEFAULT_REPO_ARTIFACT_GLOBS,
    DEFAULT_SUPPORTED_SOURCE_GLOBS,
    DEPENDENCY_MANIFEST_GLOBS,
    LANGUAGE_INTEGRATIONS,
    REPO_SUPPORTING_FILE_GLOBS,
    isDependencyManifestPath,
    isRepoArtifactPath,
    isRepoSupportingPath,
    resolveLanguageIntegration,
    roleForRepoSupportingPath,
    repoProfilesForQuestion,
    repoProfiles,
    sourcePathExcludedByIntegration
} from '../../src/language-integrations/registry.js';
import {pathExcluded} from '../../src/util/path-filter.js';
import {DEFAULT_IGNORE_RULES} from '../../src/index/default-ignore.js';
import createIgnore from 'ignore';

test('default ignore rules exclude test/fixture sources (overridable layer, not source policy)', () => {
    // Test/fixture exclusion now lives in DEFAULT_IGNORE_RULES, seeded into the
    // repo-ignore engine so a repo can re-include via .tracebookignore negation —
    // rather than the one-way source-policy layer.
    //
    const matcher = createIgnore().add(DEFAULT_IGNORE_RULES);
    for(const path of [
        'test/unit/server.test.js',
        'tests/server.test.ts',
        'src/__tests__/server.test.js',
        'src/server.spec.ts',
        'packages/app/test/fixture.js',
        'packages/app/tests/fixture.js',
        'tests/README.md',
        'fixtures/setup.md',
        'tests/requirements.txt',
    ]) {
        assert.equal(matcher.ignores(path), true, path);
        // No longer hard-excluded at the integration layer (it is overridable now).
        //
        assert.equal(sourcePathExcludedByIntegration(path), false, path);
    }
});

test('language integration source policies keep implementation source and config searchable', () => {
    for(const path of [
        'src/server.js',
        'public/js/app.js',
        'package.json',
        'vite.config.js',
        'README.md',
        'docs/setup.md',
        'requirements.txt',
        'Makefile',
    ]) {
        assert.equal(pathExcluded(path, DEFAULT_INDEX_EXCLUDE), false, path);
        assert.equal(sourcePathExcludedByIntegration(path), false, path);
    }
});

test('effective index excludes combine defaults with caller-provided policy', () => {
    const exclude = effectiveIndexExclude(['internal-generated/**']);

    assert.equal(pathExcluded('internal-generated/output.js', exclude), true);
    assert.equal(pathExcluded('node_modules/pkg/index.js', exclude), true);
    assert.equal(pathExcluded('src/planner/index.js', exclude), false);
});

test('language source policies handle wildcard build directory segments', () => {
    assert.equal(sourcePathExcludedByIntegration('src/cmake-build-debug/native.cpp'), true);
    assert.equal(isDependencyManifestPath('requirements.txt'), true);
});

test('default index include combines parser-backed integrations and shared artifacts', () => {
    const includeText = DEFAULT_INDEX_INCLUDE.join('\n');

    assert.ok(resolveLanguageIntegration({path: 'src/server.py'}));
    assert.ok(resolveLanguageIntegration({path: 'src/main.rs'}));
    assert.ok(resolveLanguageIntegration({path: 'scripts/deploy.sh'}));
    assert.equal(resolveLanguageIntegration({path: 'README.md'}), null);
    assert.equal(isRepoArtifactPath('README.md'), true);
    assert.equal(isRepoArtifactPath('docs/architecture.md'), true);
    assert.equal(isRepoArtifactPath('CHANGELOG.md'), true);
    assert.equal(resolveLanguageIntegration({path: '.env.example'}), null);
    assert.equal(isRepoArtifactPath('.env.example'), false);
    assert.equal(resolveLanguageIntegration({path: 'src/styles.scss'}), null);
    assert.match(includeText, /\.rs|rs,/v);
    assert.ok(DEFAULT_REPO_ARTIFACT_GLOBS.includes('**/*.md'));
    assert.ok(DEFAULT_INDEX_INCLUDE.includes('**/*.md'));
    assert.ok(REPO_SUPPORTING_FILE_GLOBS.includes('**/requirements*.txt'));
    assert.ok(REPO_SUPPORTING_FILE_GLOBS.includes('**/go.work'));
    assert.ok(REPO_SUPPORTING_FILE_GLOBS.includes('**/tailwind.config.*'));
    assert.ok(DEFAULT_INDEX_INCLUDE.includes('**/requirements*.txt'));
    assert.doesNotMatch(includeText, /\bmdx\b/v);
    assert.doesNotMatch(includeText, /\bscss\b/v);
});

test('every integration declares source policy and repo profile', () => {
    for(const glob of DEFAULT_SUPPORTED_SOURCE_GLOBS) {
        assert.ok(DEFAULT_INDEX_INCLUDE.includes(glob), glob);
    }
    assert.ok(DEFAULT_LANGUAGE_SOURCE_EXCLUDE.length > 0);
    for(const integration of LANGUAGE_INTEGRATIONS) {
        assert.ok(['code', 'surface', 'config'].includes(integration.category), integration.id);
        assert.ok(integration.source?.include?.length > 0, integration.id);
        assert.ok(Array.isArray(integration.source?.exclude), integration.id);
        assert.ok(integration.repo?.sourceRoles?.length > 0, integration.id);
        assert.ok(integration.repo?.questionTerms?.length > 0, integration.id);
        assert.ok(integration.repo?.evidenceTerms?.length > 0, integration.id);
        for(const supportingFile of integration.repo?.supportingFiles || []) {
            assert.ok(REPO_SUPPORTING_FILE_GLOBS.includes(supportingFile.glob), `${integration.id} ${supportingFile.glob}`);
            assert.ok(supportingFile.role, `${integration.id} ${supportingFile.glob}`);
        }
    }
    assert.equal(repoProfiles().find((profile) => profile.id === 'json')?.category, 'config');
    assert.equal(repoProfiles().find((profile) => profile.id === 'html')?.category, 'surface');
    assert.equal(repoProfiles().find((profile) => profile.id === 'python')?.category, 'code');
});

test('dependency manifests come from integration metadata', () => {
    assert.ok(DEPENDENCY_MANIFEST_GLOBS.includes('**/package.json'));
    assert.ok(DEPENDENCY_MANIFEST_GLOBS.includes('**/Cargo.toml'));
    assert.equal(isDependencyManifestPath('package.json'), true);
    assert.equal(isDependencyManifestPath('services/api/pyproject.toml'), true);
    assert.equal(isDependencyManifestPath('README.md'), false);

    const dependencyIntegrations = LANGUAGE_INTEGRATIONS.filter((integration) => integration.dependency);
    assert.ok(dependencyIntegrations.length >= 7);
    for(const integration of dependencyIntegrations) {
        assert.equal(typeof integration.dependency.collect, 'function', integration.id);
        assert.ok(integration.dependency.manifests.length > 0, integration.id);
    }
});

test('supporting evidence paths come from config, docs, and dependency metadata', () => {
    assert.equal(isRepoSupportingPath('README.md'), true);
    assert.equal(roleForRepoSupportingPath('README.md'), 'documentation');
    assert.equal(isRepoSupportingPath('docs/setup.md'), true);
    assert.equal(roleForRepoSupportingPath('docs/setup.md'), 'documentation');
    assert.equal(isRepoSupportingPath('.env.example'), false);
    assert.equal(roleForRepoSupportingPath('.env.example'), '');
    assert.equal(isRepoSupportingPath('requirements.txt'), true);
    assert.equal(roleForRepoSupportingPath('requirements.txt'), 'manifest');
    assert.equal(isRepoSupportingPath('Makefile'), true);
    assert.equal(roleForRepoSupportingPath('Makefile'), 'build');
    assert.equal(isRepoSupportingPath('go.work'), true);
    assert.equal(roleForRepoSupportingPath('go.work'), 'manifest');
    assert.equal(isRepoSupportingPath('.cargo/config.toml'), true);
    assert.equal(roleForRepoSupportingPath('.cargo/config.toml'), 'configuration');
    assert.equal(isRepoSupportingPath('build.sbt'), true);
    assert.equal(roleForRepoSupportingPath('build.sbt'), 'manifest');
    assert.equal(isRepoSupportingPath('.github/workflows/ci.yml'), true);
    assert.equal(roleForRepoSupportingPath('.github/workflows/ci.yml'), 'workflow');
    assert.equal(isRepoSupportingPath('tailwind.config.js'), true);
    assert.equal(roleForRepoSupportingPath('tailwind.config.js'), 'configuration');
    assert.equal(isRepoSupportingPath('site.webmanifest'), true);
    assert.equal(roleForRepoSupportingPath('site.webmanifest'), 'configuration');
    assert.equal(isRepoSupportingPath('foundry.toml'), true);
    assert.equal(roleForRepoSupportingPath('foundry.toml'), 'configuration');
    assert.equal(isRepoSupportingPath('build.zig.zon'), true);
    assert.equal(roleForRepoSupportingPath('build.zig.zon'), 'manifest');
    assert.equal(isRepoSupportingPath('config/app.yaml'), true);
    assert.equal(roleForRepoSupportingPath('config/app.yaml'), 'configuration');
    assert.equal(isRepoSupportingPath('package.json'), true);
    assert.equal(roleForRepoSupportingPath('package.json'), 'manifest');
    assert.equal(isRepoSupportingPath('src/server.js'), false);
});

test('repo profile matching is integration-owned rather than JavaScript-specific', () => {
    assert.deepEqual(repoProfilesForQuestion('How does the Rust crate use Cargo?').slice(0, 1).map((profile) => profile.id), ['rust']);
    assert.deepEqual(repoProfilesForQuestion('Explain the Go HTTP handler package').slice(0, 1).map((profile) => profile.id), ['go']);
    assert.deepEqual(repoProfilesForQuestion('Where is the Python environment configured?').slice(0, 1).map((profile) => profile.id), ['python']);
    assert.ok(repoProfilesForQuestion('How does the CSS responsive layout work?').some((profile) => profile.id === 'css'));
});

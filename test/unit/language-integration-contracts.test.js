import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import createIgnore from 'ignore';
import {collectDependencyDocs} from '../../src/index/dependency-docs.js';
import {DEFAULT_IGNORE_RULES} from '../../src/index/default-ignore.js';
import {
    LANGUAGE_INTEGRATIONS,
    isDependencyManifestPath,
    isSupportedSourcePath,
    resolveLanguageIntegration,
    sourcePathExcludedByIntegration
} from '../../src/language-integrations/registry.js';

// A contract path is "kept out of the corpus" if either the integration's hard
// excludes drop it OR the overridable default ignore rules do (soft repo-shape
// guesses like test/ moved to DEFAULT_IGNORE_RULES).
//
const defaultIgnore = createIgnore().add(DEFAULT_IGNORE_RULES);

function excludedFromCorpus(relPath) {
    return sourcePathExcludedByIntegration(relPath) || defaultIgnore.ignores(relPath);
}

const WORKER = 'test/helpers/language-contract-worker.js';
const UNREGISTERED_SOURCE_PATHS = [
    'src/app.not-supported',
    'src/Main.unknownlang',
    'queries/security.querylang',
    'lib/handler.serverlang',
    'Sources/Checkout.mobilelang',
    'views/checkout.templatex'
];

test('registered language integrations satisfy their owned contracts', async () => {
    assert.ok(LANGUAGE_INTEGRATIONS.length > 0);

    for(const integration of LANGUAGE_INTEGRATIONS) {
        await assertIntegrationContract(integration);
    }
});

test('unregistered source paths are not supported integrations', () => {
    for(const path of UNREGISTERED_SOURCE_PATHS) {
        assert.equal(resolveLanguageIntegration({path}), null, path);
        assert.equal(isSupportedSourcePath(path), false, path);
    }
});

async function assertIntegrationContract(integration) {
    const contract = integration.contract;
    assert.ok(contract, `${integration.id} must own a conformance contract`);
    assert.ok(contract.path, `${integration.id} contract must declare an implementation path`);
    assert.ok(contract.source, `${integration.id} contract must declare source`);
    assert.ok((contract.expectedFacts || []).length >= 2, `${integration.id} contract must prove multiple facts`);
    assert.ok(integration.queries.length > 0, `${integration.id} must own tree-sitter queries`);

    assert.equal(resolveLanguageIntegration({path: contract.path})?.id, integration.id, integration.id);
    assert.equal(isSupportedSourcePath(contract.path), true, integration.id);
    assert.equal(sourcePathExcludedByIntegration(contract.path), false, integration.id);

    for(const excluded of contract.excludedPaths || []) {
        assert.equal(excludedFromCorpus(excluded), true, `${integration.id} should exclude ${excluded}`);
    }

    for(const manifest of contract.dependencyManifestPaths || []) {
        assert.equal(isDependencyManifestPath(manifest), true, `${integration.id} should own ${manifest}`);
    }

    const result = runWorker(contract);
    assert.equal(result.analysis.engine, 'tree-sitter', `${integration.id} parser engine`);
    assert.equal(result.analysis.supported, true, `${integration.id} parser support`);
    assert.equal(result.analysis.grammar, integration.grammar, `${integration.id} grammar`);
    assert.equal(result.analysis.hasError, false, `${integration.id} fixture should parse cleanly`);
    assert.ok(
        result.facts.filter((fact) => fact.engine === 'tree-sitter-query').length >= contract.expectedFacts.length,
        `${integration.id} should expose multiple query-backed facts`
    );

    for(const expected of contract.expectedFacts || []) {
        const matched = result.facts.find((fact) => matchesExpectedFact(fact, expected));
        assert.ok(
            matched,
            `${integration.id} missing fact ${JSON.stringify(expected)} in ${JSON.stringify(result.facts)}`
        );
        assert.equal(
            matched.engine,
            'tree-sitter-query',
            `${integration.id} fact ${JSON.stringify(expected)} must be query-backed`
        );
    }

    for(const expected of contract.expectedLineFacts || []) {
        const matched = result.facts.find((fact) => matchesExpectedFact(fact, expected));
        assert.ok(
            matched,
            `${integration.id} missing line fact ${JSON.stringify(expected)} in ${JSON.stringify(result.facts)}`
        );
        if(expected.engine) {
            assert.equal(
                matched.engine,
                expected.engine,
                `${integration.id} line fact ${JSON.stringify(expected)} must use ${expected.engine}`
            );
        }
    }

    if(contract.callLine) {
        assertUsefulAnnotation(integration.id, result.annotation);
    }
    if(contract.expectedAnnotation) {
        assertExpectedAnnotation(integration.id, result.annotation, contract.expectedAnnotation);
    }

    if(contract.dependencyFixtures?.length) {
        await assertDependencyFixtures(integration.id, contract.dependencyFixtures);
    }
}

function runWorker(contract) {
    const child = spawnSync(process.execPath, [
        '--import',
        './test/setup-env.js',
        WORKER
    ], {
        cwd: process.cwd(),
        input: JSON.stringify(contract),
        encoding: 'utf8',
        maxBuffer: 2_000_000
    });

    assert.equal(
        child.status,
        0,
        [
            `language contract worker failed for ${contract.path}`,
            child.stdout,
            child.stderr
        ].filter(Boolean).join('\n')
    );
    return JSON.parse(child.stdout);
}

function matchesExpectedFact(fact, expected) {
    return fact.kind === expected.kind
        && (!expected.name || fact.name === expected.name)
        && (!expected.target || fact.target === expected.target);
}

function assertExpectedAnnotation(id, annotation, expected) {
    assert.ok(annotation, `${id} should produce an annotation`);
    if(expected.role) {
        assert.equal(annotation.role, expected.role, `${id} annotation role`);
    }
    for(const fact of expected.facts || []) {
        assert.ok(annotation.facts.includes(fact), `${id} annotation missing fact ${fact} in ${JSON.stringify(annotation.facts)}`);
    }
    for(const note of expected.noteIncludes || []) {
        assert.match(annotation.note || '', new RegExp(escapeRegExp(note), 'u'), `${id} annotation note`);
    }
    if(expected.scoreAtLeast !== undefined) {
        assert.ok(annotation.score >= expected.scoreAtLeast, `${id} annotation score ${annotation.score} < ${expected.scoreAtLeast}`);
    }
    if(expected.semanticKey) {
        assert.equal(annotation.semanticKey, expected.semanticKey, `${id} annotation semantic key`);
    }
}

async function assertDependencyFixtures(id, fixtures) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `tracebook-${id}-deps-`));
    try {
        for(const fixture of fixtures) {
            const file = path.join(root, fixture.path);
            fs.mkdirSync(path.dirname(file), {recursive: true});
            fs.writeFileSync(file, fixture.content);
        }

        const docs = await collectDependencyDocs({root});
        for(const fixture of fixtures) {
            for(const expected of fixture.expectedDocs || []) {
                const doc = docs.find((item) => item.path === expected.path);
                assert.ok(doc, `${id} missing dependency doc ${expected.path} in ${docs.map((item) => item.path).join(', ')}`);
                for(const text of expected.includes || []) {
                    assert.ok(doc.content.includes(text), `${id} dependency doc ${expected.path} missing ${text}`);
                }
            }
        }
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
}

function assertUsefulAnnotation(id, annotation) {
    assert.ok(annotation, `${id} should produce an annotation`);
    assert.equal(annotation.worthy, true, `${id} annotation should be worthy`);
    assert.ok(
        annotation.role || annotation.facts.length > 0 || annotation.note,
        `${id} annotation should expose role, facts, or note`
    );
    assert.doesNotMatch(annotation.note || '', /carry out the surrounding|Stores .* for later .* decisions|^Calls \S+ to /i, id);
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

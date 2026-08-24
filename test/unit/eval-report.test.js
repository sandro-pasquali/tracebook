import {test} from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import {assertEnrichmentCoverage, baselineFile, compareToBaseline, hashCases, saveBaseline} from '../eval/report.js';

// The eval regression gate must be trustworthy: tolerances, lower-better
// direction, condition mismatches, and gating predicates are all decision
// logic — a bug here silently green-lights a real regression.
//

const CONDITIONS = {
    kind: 'retrieval',
    repo: 'fixture',
    k: 6,
    caseCount: 2,
    casesHash: 'abc123',
    embeddings: {model: 'test-model', dims: 384}
};

async function withBaseline(metrics, conditions = CONDITIONS) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-report-test-'));
    const file = baselineFile({baselinesDir: dir, repoName: 'fixture', kind: 'retrieval'});
    await saveBaseline({file, conditions, metrics, projectRoot: process.cwd()});
    return {dir, file};
}

test('hashCases is stable and order-sensitive for case content only', () => {
    const cases = [{type: 'product', question: 'q1', expect: ['a.js'], extra: 'ignored'}];
    const again = [{type: 'product', question: 'q1', expect: ['a.js']}];
    assert.equal(hashCases(cases), hashCases(again));
    assert.notEqual(hashCases(cases), hashCases([{type: 'product', question: 'q2', expect: ['a.js']}]));
});

test('identical metrics compare ok', async () => {
    const metrics = {ladder: {'+rerank': {all: {recall: 0.9, mrr: 0.63, n: 48}}}};
    const {dir, file} = await withBaseline(metrics);
    try {
        const result = await compareToBaseline({file, conditions: CONDITIONS, metrics, tolerance: 0.05, isGated: () => true});
        assert.equal(result.ok, true);
        assert.equal(result.incomparable, null);
        assert.equal(result.regressions.length, 0);
    } finally {
        await fs.remove(dir);
    }
});

test('drop beyond tolerance on a higher-better metric regresses', async () => {
    const base = {ladder: {'+rerank': {all: {recall: 0.9, mrr: 0.63, n: 48}}}};
    const current = {ladder: {'+rerank': {all: {recall: 0.8, mrr: 0.62, n: 48}}}};
    const {dir, file} = await withBaseline(base);
    try {
        const result = await compareToBaseline({file, conditions: CONDITIONS, metrics: current, tolerance: 0.05, isGated: () => true});
        assert.equal(result.ok, false);
        assert.equal(result.regressions.length, 1);
        assert.equal(result.regressions[0].key, 'ladder.+rerank.all.recall');
        const mrrRow = result.gated.find((row) => row.key === 'ladder.+rerank.all.mrr');
        assert.equal(mrrRow.status, 'ok');
    } finally {
        await fs.remove(dir);
    }
});

test('rise beyond tolerance on a lower-better metric regresses', async () => {
    const base = {types: {all: {gap: 0.05, err: 0, cite: 0.8, n: 48}}};
    const current = {types: {all: {gap: 0.3, err: 0, cite: 0.95, n: 48}}};
    const {dir, file} = await withBaseline(base);
    try {
        const result = await compareToBaseline({file, conditions: CONDITIONS, metrics: current, tolerance: 0.1, isGated: () => true});
        assert.equal(result.ok, false);
        assert.deepEqual(result.regressions.map((row) => row.key), ['types.all.gap']);
        const citeRow = result.gated.find((row) => row.key === 'types.all.cite');
        assert.equal(citeRow.status, 'improved');
    } finally {
        await fs.remove(dir);
    }
});

test('changed conditions are incomparable, not a bogus delta', async () => {
    const metrics = {ladder: {'+rerank': {all: {recall: 0.9, mrr: 0.63, n: 48}}}};
    const {dir, file} = await withBaseline(metrics);
    try {
        const changed = {...CONDITIONS, embeddings: {model: 'other-model', dims: 768}};
        const result = await compareToBaseline({file, conditions: changed, metrics, tolerance: 0.05, isGated: () => true});
        assert.equal(result.ok, false);
        assert.match(result.incomparable, /embeddings/);
        assert.equal(result.gated.length, 0);
    } finally {
        await fs.remove(dir);
    }
});

test('ungated metrics report as info and never fail the run', async () => {
    const base = {ladder: {'+lexical': {product: {recall: 0.78, mrr: 0.58, n: 4}}}};
    const current = {ladder: {'+lexical': {product: {recall: 0.5, mrr: 0.3, n: 4}}}};
    const {dir, file} = await withBaseline(base);
    try {
        const result = await compareToBaseline({file, conditions: CONDITIONS, metrics: current, tolerance: 0.05, isGated: () => false});
        assert.equal(result.ok, true);
        assert.equal(result.gated.length, 0);
        assert.ok(result.info.some((row) => row.key === 'ladder.+lexical.product.recall' && row.delta < 0));
    } finally {
        await fs.remove(dir);
    }
});

test('assertEnrichmentCoverage rejects a silently-failed enrichment run and allows the rest', () => {
    assert.throws(() => {
        assertEnrichmentCoverage({enrichment: {enabled: true, attempted: 50, succeeded: 0}});
    }, /enrichment coverage 0\/50/);
    assert.throws(() => {
        assertEnrichmentCoverage({enrichment: {enabled: true, attempted: 10, succeeded: 8}});
    }, /failing silently/);
    assertEnrichmentCoverage({enrichment: {enabled: true, attempted: 10, succeeded: 10}});
    assertEnrichmentCoverage({enrichment: {enabled: true, attempted: 0, succeeded: 0}});
    assertEnrichmentCoverage({enrichment: {enabled: false, attempted: 0, succeeded: 0}});
    assertEnrichmentCoverage({});
});

test('missing baseline file reports a clear incomparable message', async () => {
    const result = await compareToBaseline({
        file: path.join(os.tmpdir(), 'tb-report-test-missing', 'retrieval.json'),
        conditions: CONDITIONS,
        metrics: {},
        tolerance: 0.05,
        isGated: () => true
    });
    assert.equal(result.ok, false);
    assert.match(result.incomparable, /--save-baseline/);
});

test('single-case moves on small types stay under the noise floor; two-case moves gate', async () => {
    const base = {ladder: {'+rerank': {product: {recall: 0.5, n: 18}}}};
    const oneCase = {ladder: {'+rerank': {product: {recall: 0.4444, n: 18}}}};
    const twoCases = {ladder: {'+rerank': {product: {recall: 0.3889, n: 18}}}};
    const {dir, file} = await withBaseline(base);
    try {
        const oneCaseResult = await compareToBaseline({file, conditions: CONDITIONS, metrics: oneCase, tolerance: 0.05, isGated: () => true});
        assert.equal(oneCaseResult.ok, true, 'a one-case flip is below the measurement noise floor');

        const twoCaseResult = await compareToBaseline({file, conditions: CONDITIONS, metrics: twoCases, tolerance: 0.05, isGated: () => true});
        assert.equal(twoCaseResult.ok, false, 'a two-case drop still gates');
        assert.equal(twoCaseResult.regressions[0].key, 'ladder.+rerank.product.recall');
    } finally {
        await fs.remove(dir);
    }
});

test('a recorded run promotes to baseline as a file copy', async () => {
    const {lastRunFile, promoteLastRun} = await import('../eval/report.js');
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-lastrun-'));
    const baselinesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-baselines-'));
    try {
        const metrics = {ladder: {'+rerank': {all: {recall: 0.9, n: 49}}}};
        await saveBaseline({
            file: lastRunFile({cacheDir, repoName: 'fixture', kind: 'retrieval'}),
            conditions: CONDITIONS,
            metrics,
            projectRoot: process.cwd()
        });

        const {payload, target} = await promoteLastRun({cacheDir, baselinesDir, repoName: 'fixture', kind: 'retrieval'});
        const promoted = await fs.readJson(target);

        assert.deepEqual(promoted.metrics, metrics);
        assert.equal(promoted.savedAt, payload.savedAt);
        assert.equal(target, baselineFile({baselinesDir, repoName: 'fixture', kind: 'retrieval'}));

        await assert.rejects(
            promoteLastRun({cacheDir, baselinesDir, repoName: 'missing', kind: 'generation'}),
            /no recorded generation run/
        );
    } finally {
        await fs.remove(cacheDir);
        await fs.remove(baselinesDir);
    }
});

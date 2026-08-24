import test from 'node:test';
import assert from 'node:assert/strict';
import {
    __capDependencySourceItemsForTest,
    __compareStoryContextEntriesForTest,
    formatCorpusCoverageDetail,
    formatSourceRailLabel
} from '../../public/js/app/source-context.js';

test('source rail helper caps dependency items to one', () => {
    const items = [
        {path: 'app/server.js'},
        {path: '__dependencies__/npm/lancedb__lancedb.md'},
        {path: '__dependencies__/npm/vite.md'},
        {path: 'app/search.js'}
    ];

    assert.deepEqual(__capDependencySourceItemsForTest(items).map((item) => item.path), [
        'app/server.js',
        '__dependencies__/npm/lancedb__lancedb.md',
        'app/search.js'
    ]);
});

test('source rail reports indexed corpus coverage without a numeric confidence score', () => {
    const coverage = {
        eligibleFiles: 12,
        indexedSourceFiles: 10,
        skippedFiles: 2,
        skippedByReason: {too_large: 1, unsupported_type: 1},
        dependencyDocuments: 3,
        enrichment: {enabled: true, coverage: 0.75},
        sourceRevision: 'abc123',
        policyLimitations: {
            maximumFileBytes: 1_000_000,
            unsupportedTypesExcluded: true,
            ignoreRulesApplied: true,
            binaryFilesExcluded: true
        }
    };

    assert.match(formatSourceRailLabel({coverage}), /10\/12 indexed · 2 skipped · 3 dependency docs/v);
    const detail = formatCorpusCoverageDetail(coverage);
    assert.match(detail, /too_large: 1/v);
    assert.match(detail, /Enrichment coverage: 75%/v);
    assert.match(detail, /Index revision: abc123/v);
    assert.match(detail, /files over 1 MB excluded/v);
});

test('story context sorter keeps source files ahead of high-count dependencies', () => {
    const entries = [
        {path: '__dependencies__/npm/vite.md', count: 40},
        {path: 'app/search.js', count: 2},
        {path: 'server/routes.js', count: 1}
    ].sort(__compareStoryContextEntriesForTest);

    assert.deepEqual(entries.map((entry) => entry.path), [
        'app/search.js',
        'server/routes.js',
        '__dependencies__/npm/vite.md'
    ]);
});

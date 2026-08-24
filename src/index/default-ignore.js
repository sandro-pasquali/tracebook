// Built-in "soft" ignore rules: tracebook's default guesses about what isn't
// product source (tests, fixtures, build output, a generic data dir). They are
// expressed in gitignore syntax and seeded as the LOWEST-precedence layer of the
// repo-ignore engine, so a repo's .gitignore / .tracebookignore — and especially
// `!negation` rules — can override any of them. That makes every default a
// recoverable heuristic on arbitrary repos, instead of a one-way exclusion.
//
// Hard excludes (VCS, dependency installs, caches, compiled artifacts, lockfiles,
// language build/cache dirs) are NOT here — they stay in the glob/integration layer
// because they are never legitimately source and need not be re-includable.
//
export const DEFAULT_IGNORE_RULES = Object.freeze([
    // Tests, specs, fixtures (any depth).
    //
    'test/',
    'tests/',
    'Tests/',
    'fixtures/',
    'fixture/',
    '__fixtures__/',
    '__tests__/',
    '*.test.*',
    '*.spec.*',

    // Build / generated output.
    //
    'build/',
    'dist/',
    'coverage/',
    '/out/',
    '*.generated.*',
    '*.gen.*',
    '*.min.*',

    // Generic top-level data directory.
    //
    '/data/',

    // License and legal boilerplate: long generic English that soaks up
    // semantic and rerank similarity while answering nothing about behavior
    // (an AGPL text outranked source files in the retrieval eval). Soft, so a
    // repo that wants license content indexed can re-include it.
    //
    'LICENSE*',
    'LICENCE*',
    'COPYING*',
    'NOTICE*',
    'license*',
    'licence*'
]);

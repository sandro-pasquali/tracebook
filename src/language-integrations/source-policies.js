// Per-language HARD excludes only: dependency installs, caches, compiled
// artifacts, lockfiles, and ecosystem build dirs that are never source. The soft,
// cross-language guesses (test/ tests/ fixtures/ build/ dist/ out/ coverage/,
// *.test.*, *.spec.*, *.generated.*/*.gen.*/*.min.*, data/) moved to
// DEFAULT_IGNORE_RULES (src/index/default-ignore.js) so they are overridable via a
// repo's .gitignore/.tracebookignore.
//
function sourcePolicy(...groups) {
    return {
        exclude: unique(groups.flat())
    };
}

export const SHELL_SOURCE_POLICY = sourcePolicy([
    '**/bats/**',
    '**/*.bats'
]);

export const JAVASCRIPT_SOURCE_POLICY = sourcePolicy([
    '**/node_modules/**',
    '**/.next/**',
    '**/.turbo/**',
    '**/__mocks__/**',
    '**/*.d.ts',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb'
]);

export const MARKUP_SOURCE_POLICY = sourcePolicy([
    '**/node_modules/**'
]);

export const STYLE_SOURCE_POLICY = sourcePolicy([
    '**/node_modules/**'
]);

export const CONFIG_SOURCE_POLICY = sourcePolicy([
    '**/node_modules/**',
    '**/.venv/**',
    '**/venv/**',
    '**/env/**',
    '**/vendor/**',
    '**/target/**',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    'Cargo.lock'
]);

export const PYTHON_SOURCE_POLICY = sourcePolicy([
    '**/.venv/**',
    '**/venv/**',
    '**/env/**',
    '**/__pycache__/**',
    '**/.pytest_cache/**',
    '**/.mypy_cache/**',
    '**/*.pyc',
    '**/*.pyo',
    '**/*.egg-info/**'
]);

export const RUST_SOURCE_POLICY = sourcePolicy([
    'target/**',
    '**/target/**',
    '**/benches/**',
    '**/examples/**',
    '**/*_test.rs'
]);

export const GO_SOURCE_POLICY = sourcePolicy([
    '**/vendor/**',
    '**/testdata/**',
    '**/*_test.go'
]);

export const C_LIKE_SOURCE_POLICY = sourcePolicy([
    '**/cmake-build-*/**',
    '**/CMakeFiles/**',
    '**/*.o',
    '**/*.obj',
    '**/*.a',
    '**/*.so',
    '**/*.dll',
    '**/*.dylib'
]);

export const DOTNET_SOURCE_POLICY = sourcePolicy([
    '**/bin/**',
    '**/obj/**',
    '**/packages/**',
    '**/*Tests.cs',
    '**/*Test.cs'
]);

export const JVM_SOURCE_POLICY = sourcePolicy([
    '**/.gradle/**',
    '**/target/**',
    '**/*Test.java',
    '**/*Tests.java',
    '**/*Test.kt',
    '**/*Tests.kt',
    '**/*Spec.kt',
    '**/*Test.scala',
    '**/*Spec.scala'
]);

export const PHP_SOURCE_POLICY = sourcePolicy([
    '**/vendor/**',
    '**/*Test.php'
]);

export const FUNCTIONAL_SOURCE_POLICY = sourcePolicy();

export const SOLIDITY_SOURCE_POLICY = sourcePolicy([
    '**/artifacts/**',
    '**/cache/**',
    '**/broadcast/**'
]);

export const ZIG_SOURCE_POLICY = sourcePolicy([
    'zig-cache/**',
    'zig-out/**',
    '**/zig-cache/**',
    '**/zig-out/**'
]);

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

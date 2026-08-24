export const SHARED_REPO_ARTIFACTS = Object.freeze([
    {
        glob: '**/*.md',
        role: 'documentation',
        terms: ['docs', 'documentation', 'readme', 'overview', 'setup', 'usage', 'architecture']
    }
]);

// Hard artifact excludes only. Soft repo-shape guesses (test/, fixtures/, build/,
// dist/, coverage/) moved to DEFAULT_IGNORE_RULES (overridable via the repo's
// .gitignore/.tracebookignore); see src/index/default-ignore.js.
//
export const SHARED_REPO_ARTIFACT_EXCLUDE = Object.freeze([
    '**/node_modules/**',
    '**/vendor/**',
    '**/target/**',
    '**/.git/**'
]);

import {
    DEFAULT_REPO_ARTIFACT_GLOBS,
    DEFAULT_LANGUAGE_SOURCE_EXCLUDE,
    DEFAULT_SUPPORTED_SOURCE_GLOBS,
    DEPENDENCY_EXCLUDE_GLOBS,
    REPO_SUPPORTING_FILE_GLOBS
} from '../language-integrations/registry.js';

export const DEFAULT_INDEX_INCLUDE = [...new Set([
    ...DEFAULT_SUPPORTED_SOURCE_GLOBS,
    ...DEFAULT_REPO_ARTIFACT_GLOBS,
    ...REPO_SUPPORTING_FILE_GLOBS
])];

// Hard, non-overridable excludes (VCS/cache/IDE/secrets/logs). Soft repo-shape
// guesses (tests, build output, a generic data/ dir) live in DEFAULT_IGNORE_RULES
// (src/index/default-ignore.js), seeded into the repo-ignore engine so a repo's
// .gitignore/.tracebookignore can override them.
//
export const DEFAULT_INDEX_EXCLUDE = [
    '.git/**',
    '.cache/**',
    '.eval-cache/**',
    '.idea/**',
    '.env',
    '.env.local',
    '.env.*.local',
    '*.log'
];

export function effectiveIndexExclude(exclude = DEFAULT_INDEX_EXCLUDE) {
    return [...new Set([
        ...DEFAULT_INDEX_EXCLUDE,
        ...(Array.isArray(exclude) ? exclude : []),
        ...DEFAULT_LANGUAGE_SOURCE_EXCLUDE,
        ...DEPENDENCY_EXCLUDE_GLOBS
    ])].sort();
}

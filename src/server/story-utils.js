import {createHash} from 'node:crypto';
import {normalizeSourcePath} from '../util/source-path.js';
import {normalizeSourceFingerprints} from '../util/source-fingerprints.js';

const STORY_SOURCE_FINGERPRINT_VERSION = '1';

export async function withStoryFreshness(story, {readSource}) {
    const freshness = await storyFreshness(story, {readSource});
    return {
        ...story,
        freshness,
        isStale: freshness.state === 'stale'
    };
}

export async function storySourceFingerprints(sourcePaths = [], {readSource}) {
    const out = {};
    const paths = [...new Set((sourcePaths || [])
        .map((p) => normalizeSourcePath(p))
        .filter(Boolean))];
    for(const relPath of paths) {
        out[relPath] = await storySourceFingerprint(relPath, {readSource});
    }
    return out;
}

async function storyFreshness(story, {readSource}) {
    const sourceFingerprints = normalizeStorySourceFingerprints(story?.sourceFingerprints);
    const paths = Object.keys(sourceFingerprints);
    const currentFingerprints = await storySourceFingerprints(paths, {readSource});
    const changedPaths = paths.filter((p) => !fingerprintsMatch(sourceFingerprints[p], currentFingerprints[p]));
    return {
        state: changedPaths.length > 0 ? 'stale' : 'current',
        changedPaths,
        checkedAt: Date.now()
    };
}

async function storySourceFingerprint(relPath, {readSource}) {
    try {
        const source = await readSource(relPath);
        if(source.error) {
            return {status: source.error, hash: null};
        }
        return {
            status: 'ok',
            hash: createHash('sha256')
                .update(`${STORY_SOURCE_FINGERPRINT_VERSION}\n${source.content}`, 'utf8')
                .digest('hex')
                .slice(0, 16)
        };
    } catch {
        return {status: 'read_failed', hash: null};
    }
}

function normalizeStorySourceFingerprints(value) {
    return normalizeSourceFingerprints(value, {normalizeKey: normalizeSourcePath});
}

function fingerprintsMatch(left, right) {
    return String(left?.status || '') === String(right?.status || '') &&
        String(left?.hash || '') === String(right?.hash || '');
}

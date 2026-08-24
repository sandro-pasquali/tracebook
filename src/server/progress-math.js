// Pure helpers for the runtime indexing progress bar: ratio math, event
// classification, and message/revision normalization. Extracted from
// runtime-manager.js so the lifecycle orchestrator stays focused; no shared state.
//

export function progressRatio(done, total) {
    if(!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) {
        return 0;
    }
    return clampProgressRatio(done / total);
}

export function indexingProgressRatio(done, total) {
    const base = 0.14;
    const span = 0.8;
    return clampProgressRatio(base + (progressRatio(done, total) * span));
}

export function isActiveIndexProgress(ev) {
    return ev?.kind === 'source_start' || ev?.kind === 'dependency_start';
}

export function indexingProgressMessage(ev) {
    return ev?.kind === 'dependency_start'
        ? 'Checking dependency metadata for code search.'
        : 'Checking source files for code search.';
}

export function clampProgressRatio(value) {
    if(!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(1, value));
}

export function normalizeRevision(value) {
    const revision = String(value || '').trim();
    return revision || null;
}

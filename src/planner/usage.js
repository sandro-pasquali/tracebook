export function combineUsage(a, b) {
    if(!a && !b) return null;
    const left = normalizeUsage(a);
    const right = normalizeUsage(b);
    const add = (x, y) => (x || 0) + (y || 0);
    return {
        promptTokens: add(left.promptTokens, right.promptTokens),
        completionTokens: add(left.completionTokens, right.completionTokens),
        totalTokens: add(left.totalTokens, right.totalTokens)
    };
}

export function settleGovernorCall(governor, reservation, usage) {
    if(!governor || !reservation) {
        return;
    }
    const tokens = normalizeUsage(usage).totalTokens;
    if(tokens > 0) {
        governor.afterCall(tokens, reservation);
    } else {
        governor.releaseCall?.(reservation);
    }
}

export function isAbortError(err) {
    return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}

export function normalizeUsage(usage) {
    if(!usage) {
        return {promptTokens: 0, completionTokens: 0, totalTokens: 0};
    }
    const promptTokens = usage.promptTokens ?? usage.inputTokens ?? 0;
    const completionTokens = usage.completionTokens ?? usage.outputTokens ?? 0;
    const totalTokens = usage.totalTokens ?? (promptTokens + completionTokens);
    return {promptTokens, completionTokens, totalTokens};
}

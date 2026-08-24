export function buildTraceError(code, err, meta = {}) {
    const error = serializeError(err);
    const modelOutput = classifyModelOutputError(err, {maxOutputTokens: meta.maxOutputTokens});
    return {
        type: 'trace.error',
        code,
        stage: meta.stage || code,
        message: modelOutput?.message || error.message || code,
        error,
        ...(modelOutput && {modelOutput})
    };
}

// AI SDK object-generation failures are often reported as JSON parse errors even
// when parsing is only the downstream symptom. A length-limited response tells us
// the model exhausted its answer budget; an empty response is the especially
// important case where no answer was produced at all (for example, a provider
// spent the allowance in hidden reasoning). Give callers a stable, actionable
// classification instead of surfacing "Unexpected end of JSON input".
//
export function classifyModelOutputError(err, {maxOutputTokens} = {}) {
    if(err?.finishReason !== 'length') {
        return null;
    }
    const text = String(err?.text || '').trim();
    const outputTokens = readOutputTokens(err?.usage);
    const budget = Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
        ? Math.trunc(maxOutputTokens)
        : outputTokens || null;
    if(!text) {
        return {
            code: 'model_output_exhausted_before_answer',
            finishReason: 'length',
            outputTokens,
            maxOutputTokens: budget,
            message: budget
                ? `Model exhausted the ${budget}-token output budget without returning an answer.`
                : 'Model exhausted its output budget without returning an answer.'
        };
    }
    return {
        code: 'model_output_truncated',
        finishReason: 'length',
        outputTokens,
        maxOutputTokens: budget,
        message: budget
            ? `Model output was truncated at the ${budget}-token output budget.`
            : 'Model output was truncated at its output budget.'
    };
}

function serializeError(err) {
    if(!err) {
        return {name: 'Error', message: ''};
    }
    if(err instanceof Error) {
        return {
            name: err.name,
            message: truncateLogValue(err.message),
            stack: truncateLogValue(err.stack, 4000),
            cause: serializeCause(err.cause)
        };
    }
    if(typeof err === 'object') {
        return {
            name: err.name || err.constructor?.name || 'Error',
            message: truncateLogValue(err.message || safeJson(err)),
            value: truncateLogValue(safeJson(err))
        };
    }
    return {
        name: typeof err,
        message: truncateLogValue(String(err))
    };
}

function serializeCause(cause) {
    if(!cause) {
        return undefined;
    }
    if(cause instanceof Error) {
        return {
            name: cause.name,
            message: truncateLogValue(cause.message),
            stack: truncateLogValue(cause.stack, 4000)
        };
    }
    return truncateLogValue(typeof cause === 'object' ? safeJson(cause) : String(cause));
}

function safeJson(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function truncateLogValue(value, maxChars = 2000) {
    if(value === undefined || value === null) {
        return value;
    }
    const text = String(value);
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function readOutputTokens(usage) {
    const value = usage?.outputTokens;
    if(Number.isFinite(value)) {
        return Number(value);
    }
    if(Number.isFinite(value?.total)) {
        return Number(value.total);
    }
    if(Number.isFinite(usage?.completionTokens)) {
        return Number(usage.completionTokens);
    }
    return null;
}

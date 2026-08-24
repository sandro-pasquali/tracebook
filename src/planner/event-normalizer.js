export function sdkToolCallToPlannerEvent(event, {summarizeInput = defaultSummarize} = {}) {
    if(event?.type !== 'tool-call') {
        return null;
    }
    return {
        type: 'tool.call',
        tool: event.toolName,
        inputSummary: summarizeInput(event.toolName, event.input)
    };
}

export function sdkToolResultToPlannerArtifacts(event, {
    startedAtMs = null,
    now = Date.now,
    summarizeResult = defaultSummarize,
    wrapOutput = (output) => output
} = {}) {
    if(event?.type !== 'tool-result') {
        return null;
    }
    const durationMs = Number.isFinite(startedAtMs) ? Math.max(0, now() - startedAtMs) : null;
    return {
        event: {
            type: 'tool.result',
            tool: event.toolName,
            summary: summarizeResult(event.toolName, event.output),
            durationMs
        },
        toolMessage: {
            role: 'tool',
            content: [{
                type: 'tool-result',
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                output: wrapOutput(event.output)
            }]
        },
        durationMs
    };
}

function defaultSummarize(_toolName, value) {
    return value;
}

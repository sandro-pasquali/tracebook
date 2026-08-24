// Build the assistant tool-call + tool-result message pair that injects a
// search result into the model's context as if it had issued the call itself.
// Prefetch, exploration, and the coverage backstop all feed evidence in this
// exact shape, so they share one factory to keep the structure identical.
//
export function buildToolExchange({callId, input, output, toolName = 'search_codebase'}) {
    return [
        {
            role: 'assistant',
            content: [{type: 'tool-call', toolCallId: callId, toolName, input}]
        },
        {
            role: 'tool',
            content: [{type: 'tool-result', toolCallId: callId, toolName, output}]
        }
    ];
}

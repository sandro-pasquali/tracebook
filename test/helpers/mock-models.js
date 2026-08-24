import {MockLanguageModelV3, simulateReadableStream} from 'ai/test';
import {setResolveOverrideForTest} from '../../src/util/model.js';

// Mock AI-SDK models for planner tests. These build the low-level
// LanguageModelV3 stream/generate results that streamObject, streamText,
// generateObject, and generateText consume, so a test can drive the real
// planner code paths with deterministic model output and zero network calls.
//
// The stream-part shapes here were validated against ai@6 (V3 provider spec):
// finishReason is {unified, raw}; usage carries structured input/output token
// objects. doStream MUST be a function that returns a FRESH stream per call —
// simulateReadableStream is single-use, so an array of pre-built results breaks
// on the second step of a multi-step stream.
//

const USAGE = {
    inputTokens: {total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0},
    outputTokens: {total: 10, text: 10, reasoning: 0}
};

function streamOf(chunks) {
    return {stream: simulateReadableStream({chunks, chunkDelayInMs: null, initialDelayInMs: null})};
}

function finishPart(unified, raw) {
    return {type: 'finish', finishReason: {unified, raw}, usage: USAGE};
}

// Stream a block of text as incremental deltas (~20 chars each). streamObject
// reconstructs its object from the accumulated text; streamText surfaces it as
// text-delta events.
//
function textChunks(text, {finish = 'stop'} = {}) {
    const out = [{type: 'stream-start', warnings: []}, {type: 'text-start', id: 't1'}];
    for(const piece of String(text).match(/[\s\S]{1,20}/g) || ['']) {
        out.push({type: 'text-delta', id: 't1', delta: piece});
    }
    out.push({type: 'text-end', id: 't1'});
    out.push(finishPart(finish, finish));
    return out;
}

// Stream a single tool call. The SDK executes the matching tool from the
// `tools` passed to streamText, producing the tool-result event.
//
function toolCallChunks({id, toolName, input}) {
    const inputJson = typeof input === 'string' ? input : JSON.stringify(input || {});
    return [
        {type: 'stream-start', warnings: []},
        {type: 'tool-input-start', id, toolName},
        {type: 'tool-input-delta', id, delta: inputJson},
        {type: 'tool-input-end', id},
        {type: 'tool-call', toolCallId: id, toolName, input: inputJson},
        finishPart('tool-calls', 'tool_calls')
    ];
}

// Stream that surfaces a provider error part (drives streamText's error event).
//
function errorChunks(message) {
    return [
        {type: 'stream-start', warnings: []},
        {type: 'error', error: new Error(message)}
    ];
}

function genResult(text) {
    return {
        content: [{type: 'text', text: String(text)}],
        finishReason: {unified: 'stop', raw: 'stop'},
        usage: USAGE,
        warnings: []
    };
}

// streamObject / generateObject source: streams the object as JSON. Works for
// both because doStream and doGenerate both serve the same JSON payload.
//
export function streamObjectModel(object, {modelId = 'mock-object'} = {}) {
    const text = JSON.stringify(object);
    return new MockLanguageModelV3({
        provider: 'test',
        modelId,
        doStream: () => streamOf(textChunks(text)),
        doGenerate: async () => genResult(text)
    });
}

export function emptyLengthModel({modelId = 'mock-empty-length'} = {}) {
    return new MockLanguageModelV3({
        provider: 'test',
        modelId,
        doStream: () => streamOf([
            {type: 'stream-start', warnings: []},
            finishPart('length', 'length')
        ]),
        doGenerate: async () => ({
            content: [],
            finishReason: {unified: 'length', raw: 'length'},
            usage: USAGE,
            warnings: []
        })
    });
}

// Streams a COMPLETE, schema-valid JSON object but reports finishReason
// 'length' — the silently-truncated case where the model hit its output
// budget yet the JSON happened to close. doGenerate serves the recovery retry.
//
export function lengthFinishObjectModel({streamObject, generatedObject}, {modelId = 'mock-length-finish-object'} = {}) {
    const streamText = JSON.stringify(streamObject);
    const generateText = JSON.stringify(generatedObject);
    return new MockLanguageModelV3({
        provider: 'test',
        modelId,
        doStream: () => streamOf(textChunks(streamText, {finish: 'length'})),
        doGenerate: async () => genResult(generateText)
    });
}

export function streamThenGenerateObjectModel({streamObject, generatedObject}, {modelId = 'mock-stream-then-generate-object'} = {}) {
    const streamText = JSON.stringify(streamObject);
    const generateText = JSON.stringify(generatedObject);
    return new MockLanguageModelV3({
        provider: 'test',
        modelId,
        doStream: () => streamOf(textChunks(streamText)),
        doGenerate: async () => genResult(generateText)
    });
}

// streamText source running a sequence of steps. Each step is either
// {tool: {id?, name, input}} (emits a tool call the SDK then executes),
// {text: '...'} (emits plain text and finishes), or {error: 'msg'} (emits a
// provider error part). The final non-error step should be a text step so the
// tool loop terminates.
//
export function streamTextModel(steps, {modelId = 'mock-text'} = {}) {
    const list = Array.isArray(steps) && steps.length > 0 ? steps : [{text: ''}];
    const results = list.map((step) => {
        if(step.error) {
            return errorChunks(typeof step.error === 'string' ? step.error : 'mock_stream_error');
        }
        return step.tool
            ? toolCallChunks({id: step.tool.id || 'call_1', toolName: step.tool.name, input: step.tool.input})
            : textChunks(step.text || '');
    });
    let index = 0;
    return new MockLanguageModelV3({
        provider: 'test',
        modelId,
        doStream: () => streamOf(results[Math.min(index++, results.length - 1)])
    });
}

// generateText source (HyDE, stage-query extraction).
//
export function generateTextModel(text, {modelId = 'mock-gen-text'} = {}) {
    return new MockLanguageModelV3({
        provider: 'test',
        modelId,
        doGenerate: async () => genResult(text)
    });
}

// Install a resolveModel override that dispatches by the normalized model spec
// (e.g. "openai/test-outline"). Returns a restore fn; callers MUST call it (or
// setResolveOverrideForTest(null)) in a finally/t.after so the global seam does
// not leak across tests.
//
export function installMockModels(mapBySpec) {
    setResolveOverrideForTest((spec) => mapBySpec[spec] || null);
    return () => setResolveOverrideForTest(null);
}

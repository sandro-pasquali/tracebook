import {stepCountIs, streamText} from 'ai';
import {config} from '../../util/config.js';
import {resolveModel} from '../../util/model.js';
import {formatIntentForPrompt} from '../../intent-classifier.js';
import {buildExplorationSystemPrompt} from '../prompts.js';
import {buildTraceError} from '../errors.js';
import {settleGovernorCall} from '../usage.js';
import {sdkToolCallToPlannerEvent, sdkToolResultToPlannerArtifacts} from '../event-normalizer.js';
import {summarizeToolInput, summarizeToolResult, wrapToolOutput} from '../evidence.js';
import {buildSimilarTracesMessage} from './similar-traces.js';

// ───── Exploration phase ─────
// The exploration model issues tool calls (search/read/grep) to gather evidence,
// guided by the pre-fetched starting evidence. A wall-clock timeout and the
// parent abort signal both cancel the stream. The fast path skips the model
// entirely when the pre-fetch was already decisive.
//
// Yields exploration timing + tool events. Returns {explorationMessages,
// explorationUsage}, or {halt: true} after yielding a trace.error.
//
export async function* runExploration(ctx) {
    const {classification, questionContext, explorationQuestion, similarTraces, prefetchResult, prefetchMessages, fastPath, tools, governor, signal, timer} = ctx;

    const explorationMark = timer.mark('exploration.start');
    yield {type: 'timing.checkpoint', name: explorationMark.name, sinceStart: explorationMark.sinceStart, sinceLast: explorationMark.sinceLast};

    const pendingToolStarts = new Map();
    let explorationFirstTokenSeen = false;

    const explorationMessages_in = [
        {role: 'user', content: `${formatIntentForPrompt(classification)}\n\n${explorationQuestion}`}
    ];
    if(questionContext.contextMessage) {
        explorationMessages_in.push({
            role: 'user',
            content: questionContext.contextMessage
        });
    }
    const explorationSimilarMessage = buildSimilarTracesMessage(similarTraces);
    if(explorationSimilarMessage) {
        explorationMessages_in.push({
            role: 'user',
            content: explorationSimilarMessage
        });
    }
    if(prefetchResult) {
        explorationMessages_in.push(...prefetchMessages);
        explorationMessages_in.push({
            role: 'user',
            content: 'The above pre-fetched results are your starting evidence. Inspect them first; only call tools to fill gaps the pre-fetch did not cover.'
        });
    }

    // ───── Fast path: skip exploration when pre-fetch is decisive ─────
    // If the top match is very strong and the question is small/simple,
    // jump straight to synthesis with just the pre-fetched evidence.
    //
    let explorationMessages = [];
    let explorationUsage = null;

    if(fastPath) {
        const fastMark = timer.mark('exploration.fastpath', {topSimilarity: prefetchResult.results[0]?.similarity});
        yield {type: 'timing.checkpoint', name: fastMark.name, sinceStart: fastMark.sinceStart, sinceLast: fastMark.sinceLast, topSimilarity: fastMark.topSimilarity};
        explorationMessages = prefetchMessages;
    } else {
        let exploration;
        let explorationTimedOut = false;
        let explorationDegraded = false;
        let explorationDegradeError = null;
        let explorationReservation = null;
        const streamedToolMessages = [];
        const explorationController = new AbortController();
        const abortExploration = () => explorationController.abort();
        if(signal) {
            if(signal.aborted) {
                explorationController.abort();
            } else {
                signal.addEventListener('abort', abortExploration, {once: true});
            }
        }
        const explorationTimeout = setTimeout(() => {
            explorationTimedOut = true;
            explorationController.abort();
        }, config.planner.explorationWallMs);
        try {
            explorationReservation = governor ? await governor.beforeCall(config.planner.explorationMaxTokens) : null;
            exploration = streamText({
                model: resolveModel(config.models.exploration),
                system: buildExplorationSystemPrompt(),
                messages: explorationMessages_in,
                tools,
                stopWhen: stepCountIs(config.planner.explorationMaxSteps),
                maxOutputTokens: config.planner.explorationMaxTokens,
                abortSignal: explorationController.signal
            });
        } catch(err) {
            governor?.releaseCall?.(explorationReservation);
            clearTimeout(explorationTimeout);
            if(signal) {
                signal.removeEventListener('abort', abortExploration);
            }
            yield buildTraceError('exploration_init_failed', err, {stage: 'exploration.init'});
            return {halt: true};
        }

        try {
            for await (const ev of exploration.fullStream) {
                if(signal?.aborted) break;
                if(!explorationFirstTokenSeen) {
                    explorationFirstTokenSeen = true;
                    const m = timer.mark('exploration.firstToken');
                    yield {type: 'timing.checkpoint', name: m.name, sinceStart: m.sinceStart, sinceLast: m.sinceLast};
                }
                if(ev.type === 'tool-call') {
                    pendingToolStarts.set(ev.toolCallId, Date.now());
                    yield sdkToolCallToPlannerEvent(ev, {summarizeInput: summarizeToolInput});
                } else if(ev.type === 'tool-result') {
                    const startedAtMs = pendingToolStarts.get(ev.toolCallId);
                    if(startedAtMs) {
                        pendingToolStarts.delete(ev.toolCallId);
                    }
                    const artifacts = sdkToolResultToPlannerArtifacts(ev, {
                        startedAtMs,
                        summarizeResult: summarizeToolResult,
                        wrapOutput: wrapToolOutput
                    });
                    const durationMs = artifacts.durationMs;
                    const m = timer.mark('tool', {tool: ev.toolName, durationMs});
                    yield artifacts.event;
                    streamedToolMessages.push(artifacts.toolMessage);
                    yield {type: 'timing.checkpoint', name: m.name, tool: ev.toolName, durationMs, sinceStart: m.sinceStart, sinceLast: m.sinceLast};
                } else if(ev.type === 'error') {
                    // A mid-stream provider/model error (e.g. a flaky local model
                    // emitting a malformed tool call) does not kill the chapter:
                    // flag the degrade and stop iterating so the finalize block
                    // continues with the evidence already gathered, exactly like
                    // the wall-clock timeout path. Shared cleanup below clears the
                    // timeout and abort listener; the governor settles at the end.
                    //
                    explorationDegraded = true;
                    explorationDegradeError = ev.error;
                    break;
                }
            }
        } catch(err) {
            if(!explorationTimedOut && !explorationController.signal.aborted) {
                explorationDegraded = true;
                explorationDegradeError = err;
            }
        }
        clearTimeout(explorationTimeout);
        if(signal) {
            signal.removeEventListener('abort', abortExploration);
        }

        try {
            if(explorationTimedOut || explorationDegraded) {
                if(explorationDegraded) {
                    const degradeMessage = buildTraceError('exploration_stream_degraded', explorationDegradeError, {stage: 'exploration.stream'}).message;
                    const degradeMark = timer.mark('exploration.degraded', {code: 'exploration_stream_degraded', message: degradeMessage, toolResults: streamedToolMessages.length});
                    yield {type: 'timing.checkpoint', name: degradeMark.name, sinceStart: degradeMark.sinceStart, sinceLast: degradeMark.sinceLast, code: degradeMark.code, message: degradeMark.message, toolResults: degradeMark.toolResults};
                } else {
                    const timeoutMark = timer.mark('exploration.timeout', {limitMs: config.planner.explorationWallMs, toolResults: streamedToolMessages.length});
                    yield {type: 'timing.checkpoint', name: timeoutMark.name, sinceStart: timeoutMark.sinceStart, sinceLast: timeoutMark.sinceLast, limitMs: timeoutMark.limitMs, toolResults: timeoutMark.toolResults};
                }
                explorationMessages = [...prefetchMessages, ...streamedToolMessages];
                explorationUsage = null;
            } else {
                const resp = await exploration.response;
                // Synthesis only sees the messages we hand it. The prefetch tool-call
                // and its result lived in the input (explorationMessages_in) and are
                // NOT in resp.messages, so we prepend them here so the synthesis
                // model has the same evidence base the exploration model had.
                //
                const modelMessages = resp?.messages || [];
                explorationMessages = [...prefetchMessages, ...modelMessages];
                explorationUsage = await exploration.usage;
            }
        } catch(err) {
            governor?.releaseCall?.(explorationReservation);
            yield buildTraceError('exploration_finalize_failed', err, {stage: 'exploration.finalize'});
            return {halt: true};
        }

        settleGovernorCall(governor, explorationReservation, explorationUsage);
    }

    const explorationEnd = timer.mark('exploration.end', {tokens: explorationUsage?.totalTokens || 0, fastPath});
    yield {type: 'timing.checkpoint', name: explorationEnd.name, sinceStart: explorationEnd.sinceStart, sinceLast: explorationEnd.sinceLast, tokens: explorationEnd.tokens, fastPath};

    return {explorationMessages, explorationUsage};
}

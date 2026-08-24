import { streamSSE } from "hono/streaming";
import { runPlanner } from "../planner/index.js";
import {
    askRequestSchema,
    emptyQuerySchema,
    withRequest,
} from "./contracts.js";

export function registerAskRoute(
    app,
    { getRuntime, getSourceRevision, requireRuntime, routeLogger },
) {
    app.post(
        "/api/ask",
        withRequest(
            { query: emptyQuerySchema, body: askRequestSchema },
            async (c, { body }) => {
                const requestLog = routeLogger(c);
                const { question, forceFresh } = body;
                // The contract clamps over-budget context text instead of
                // rejecting it; surface any clamping here and strip the marker
                // so the planner receives exactly {chapters, sourcePaths}.
                //
                const { clamped: clampedContext = [], ...storyContext } = body.storyContext;
                const hasStoryContext =
                    storyContext.chapters.length > 0 ||
                    storyContext.sourcePaths.length > 0;
                const askLog = requestLog.child({
                    route: "ask",
                    forceFresh,
                    hasStoryContext,
                    chapters: storyContext.chapters.length,
                    sourcePaths: storyContext.sourcePaths.length,
                });
                if (clampedContext.length > 0) {
                    askLog.warn(
                        { clamped: clampedContext },
                        "story context exceeded its budget and was clamped",
                    );
                }
                const notReady = await requireRuntime(c);
                if (notReady) {
                    return notReady;
                }
                const {
                    answerCache,
                    traceIndexer,
                    traces,
                    tools,
                    governor,
                    embedder,
                    store,
                    indexer,
                    reranker,
                    degraded,
                } = getRuntime(c);

                askLog.info(
                    { questionLength: question.length },
                    "ask stream was requested",
                );

                return streamSSE(c, async (stream) => {
                    const controller = new AbortController();
                    const collected = [];
                    let precomputedSimilar = [];
                    let traceMeta = null;
                    let finalTrace = null;
                    let finalFeatureTrace = null;
                    const onAbort = () => {
                        askLog.warn(
                            { traceId: traceMeta?.traceId },
                            "ask stream aborted by client",
                        );
                        controller.abort();
                    };
                    stream.onAbort(onAbort);
                    const currentSourceRevision = getSourceRevision(c);

                    // Hot-path: serve verbatim repeats from the answer cache.
                    const cached =
                        forceFresh || hasStoryContext
                            ? null
                            : answerCache.get(question, {
                                sourceRevision: currentSourceRevision,
                            });
                    if (cached) {
                        try {
                            askLog.info(
                                {
                                    ageMs: Date.now() - cached.savedAt,
                                    events: cached.events.length,
                                    sourceRevision: currentSourceRevision,
                                },
                                "answer cache replay started",
                            );
                            await stream.writeSSE({
                                event: "trace.replay",
                                data: JSON.stringify({
                                    type: "trace.replay",
                                    source: "cache",
                                    ageMs: Date.now() - cached.savedAt,
                                    sourceRevision: currentSourceRevision,
                                }),
                            });
                            for (const event of cached.events) {
                                if (controller.signal.aborted) break;
                                await stream.writeSSE({
                                    event: event.type,
                                    data: JSON.stringify(event),
                                });
                            }
                            askLog.info(
                                { events: cached.events.length },
                                "answer cache replay completed",
                            );
                        } catch (err) {
                            askLog.warn({ err }, "answer cache replay failed");
                        }
                        return;
                    }

                    // Similar traces are planning context, never substitute
                    // answers. A high embedding score is not proof that two
                    // questions have the same intent or required evidence.
                    try {
                        const similar =
                            forceFresh || hasStoryContext
                                ? []
                                : await traceIndexer.findSimilarByQuery(question, { limit: 3 });
                        const freshSimilar = await freshSimilarTraces(similar, {
                            traces,
                            sourceRevision: currentSourceRevision,
                            log: askLog,
                        });
                        precomputedSimilar = freshSimilar.map(
                            ({ savedTrace, ...match }) => match,
                        );
                    } catch (err) {
                        precomputedSimilar = [];
                        askLog.warn({ err }, "similar trace lookup failed");
                    }

                    try {
                        for await (const event of runPlanner({
                            question,
                            storyContext,
                            tools,
                            governor,
                            traceIndexer,
                            embedder,
                            store,
                            reranker,
                            degraded,
                            corpusCoverage: indexer.sourceState().coverage,
                            precomputedSimilarTraces: forceFresh ? [] : precomputedSimilar,
                            signal: controller.signal,
                        })) {
                            collected.push(event);
                            if (event.type === "trace.error") {
                                askLog.warn(
                                    {
                                        traceId: traceMeta?.traceId,
                                        code: event.code,
                                        stage: event.stage,
                                        error: event.error,
                                    },
                                    "planner emitted trace.error",
                                );
                            }
                            if (event.type === "trace.start") {
                                traceMeta = {
                                    traceId: event.traceId,
                                    startedAt: event.startedAt,
                                };
                                askLog.info({ traceId: event.traceId }, "trace started");
                            }
                            if (event.type === "trace.complete" && traceMeta) {
                                traceMeta.finishedAt = event.finishedAt;
                                traceMeta.usage = event.usage;
                                traceMeta.model = event.model;
                                finalTrace = event.trace || null;
                                finalFeatureTrace = event.featureTrace || null;
                                askLog.info(
                                    {
                                        traceId: traceMeta.traceId,
                                        model: traceMeta.model,
                                        usage: traceMeta.usage,
                                        durationMs: traceMeta.finishedAt - traceMeta.startedAt,
                                        components: finalTrace?.components?.length || 0,
                                    },
                                    "trace completed",
                                );
                            }
                            if (event.type === "trace.error") {
                                askLog.error(
                                    { traceId: traceMeta?.traceId, traceError: event },
                                    "trace emitted error",
                                );
                            }
                            if (event.type === "timing.checkpoint") {
                                askLog.debug(
                                    {
                                        traceId: traceMeta?.traceId,
                                        name: event.name,
                                        sinceStart: event.sinceStart,
                                        sinceLast: event.sinceLast,
                                        durationMs: event.durationMs,
                                        tool: event.tool,
                                        mode: event.mode,
                                        tokens: event.tokens,
                                    },
                                    "planner timing checkpoint",
                                );
                            }
                            if (event.type === "tool.call") {
                                askLog.debug(
                                    {
                                        traceId: traceMeta?.traceId,
                                        tool: event.tool,
                                        input: event.inputSummary,
                                    },
                                    "tool call",
                                );
                            }
                            if (event.type === "tool.result") {
                                askLog.debug(
                                    {
                                        traceId: traceMeta?.traceId,
                                        tool: event.tool,
                                        result: event.summary,
                                    },
                                    "tool result",
                                );
                            }
                            await stream.writeSSE({
                                event: event.type,
                                data: JSON.stringify(clientSafeEvent(event)),
                            });
                        }
                    } catch (err) {
                        askLog.error(
                            { traceId: traceMeta?.traceId, err },
                            "ask stream failed",
                        );
                        if (!controller.signal.aborted) {
                            const backoff = err?.code === "runtime_init_backoff";
                            await stream.writeSSE({
                                event: "trace.error",
                                data: JSON.stringify({
                                    type: "trace.error",
                                    code: backoff ? "runtime_init_backoff" : "server_error",
                                    message: backoff
                                        ? "The runtime is recovering from an initialization failure. Try again shortly."
                                        : "The story run failed. Check the server logs for details.",
                                }),
                            });
                        }
                    } finally {
                        if (traceMeta && !controller.signal.aborted) {
                            try {
                                await traces.save({
                                    traceId: traceMeta.traceId,
                                    question,
                                    startedAt: traceMeta.startedAt,
                                    finishedAt: traceMeta.finishedAt || Date.now(),
                                    events: collected,
                                    usage: traceMeta.usage,
                                    model: traceMeta.model,
                                    trace: finalTrace,
                                    featureTrace: finalFeatureTrace,
                                    sourceRevision: currentSourceRevision,
                                });
                                askLog.info(
                                    {
                                        traceId: traceMeta.traceId,
                                        events: collected.length,
                                        model: traceMeta.model,
                                    },
                                    "trace saved",
                                );
                            } catch (err) {
                                askLog.error(
                                    { traceId: traceMeta.traceId, err },
                                    "trace save failed",
                                );
                            }
                            // Learning loop is best-effort and must not affect the response.
                            if (finalTrace) {
                                traceIndexer
                                    .persistTrace({
                                        traceId: traceMeta.traceId,
                                        question,
                                        trace: finalTrace,
                                        timestamp: traceMeta.finishedAt || Date.now(),
                                    })
                                    .catch((err) =>
                                        askLog.warn(
                                            { traceId: traceMeta.traceId, err },
                                            "trace index persist failed",
                                        ),
                                    );
                                if (!forceFresh && !hasStoryContext) {
                                    answerCache.set(question, collected, {
                                        sourceRevision: currentSourceRevision,
                                    });
                                    askLog.debug(
                                        {
                                            traceId: traceMeta.traceId,
                                            events: collected.length,
                                            sourceRevision: currentSourceRevision,
                                        },
                                        "answer cached",
                                    );
                                }
                            }
                        }
                    }
                });
            },
            {
                routeLogger,
                invalidJsonLog: "invalid JSON for ask request",
                invalidLog: "invalid ask request body",
            },
        ),
    );
}

async function freshSimilarTraces(
    matches,
    { traces, sourceRevision, log } = {},
) {
    if (!Array.isArray(matches) || matches.length === 0 || !traces) {
        return [];
    }
    const out = [];
    for (const match of matches) {
        if (!match?.traceId) {
            continue;
        }
        try {
            const savedTrace = await traces.load(match.traceId);
            if (!traceMatchesSourceRevision(savedTrace, sourceRevision)) {
                log?.debug?.(
                    {
                        priorTraceId: match.traceId,
                        savedSourceRevision: savedTrace?.sourceRevision ?? null,
                        sourceRevision,
                    },
                    "similar trace skipped because source revision changed",
                );
                continue;
            }
            out.push({ ...match, savedTrace });
        } catch (err) {
            log?.warn?.(
                { priorTraceId: match.traceId, err },
                "similar trace freshness check failed",
            );
        }
    }
    return out;
}

function traceMatchesSourceRevision(trace, sourceRevision) {
    const current = normalizeSourceRevision(sourceRevision);
    if (current === null || !trace) {
        return false;
    }
    return normalizeSourceRevision(trace.sourceRevision) === current;
}

function normalizeSourceRevision(value) {
    const s = String(value ?? "").trim();
    return s ? s : null;
}

// trace.error events carry a serialized error (message/stack/cause) for
// server-side logging; the client consumes only {code, stage, message}. Strip
// the internals at the live SSE boundary — persistence and cache replay
// already strip them via compactReplayEvents.
//
function clientSafeEvent(event) {
    if (event?.type !== "trace.error" || !event.error) {
        return event;
    }
    const { error, ...rest } = event;
    return rest;
}

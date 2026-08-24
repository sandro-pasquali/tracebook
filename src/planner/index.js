import {createTimer} from '../util/timing.js';
import {config} from '../util/config.js';
import {modelIdOnly} from '../util/model.js';
import {classifyIntent} from '../intent-classifier.js';
import {buildQuestionContext} from './question-context.js';
import {chooseSynthesisMode} from './synthesis-routing.js';
import {synthesizeLeanTrace} from './lean-trace.js';
import {combineUsage} from './usage.js';
import {buildTraceCompleteEvent} from './phases/complete.js';
import {runPrefetch} from './phases/prefetch.js';
import {runExploration} from './phases/exploration.js';
import {runCoverage} from './phases/coverage.js';
import {runOutline} from './phases/outline.js';
import {runComponents} from './phases/components.js';

// Re-exported from the phases that now own them, kept on the index surface so
// existing importers/tests are unaffected.
//
export {coverageSeedQueries, parseStageQueries, wantsCoverageBackstop} from './phases/coverage.js';
export {componentSignature} from './phases/components.js';

// Runs the planner end-to-end and yields events for the SSE pipe.
// Events: trace.start | tool.call | tool.result | trace.title | narrative.patch
//       | component.patch | trace.complete | trace.error
//
// runPlanner is a thin orchestrator: it builds a shared `ctx`, yields the
// trace.start + intent events, then delegates each phase (prefetch, exploration,
// coverage, outline, components) to a generator under ./phases/ via `yield*`.
//
export async function* runPlanner({question, storyContext, tools, governor, traceIndexer, embedder, store, reranker = null, degraded = null, precomputedSimilarTraces = null, corpusCoverage = null, throttleMs = config.planner.throttleMs, signal} = {}) {
    if(!question || !tools) {
        throw new Error('runPlanner requires {question, tools}');
    }

    const traceId = `trc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = createTimer({label: traceId});
    const startedAt = timer.startedAt;
    const classification = classifyIntent({question, storyContext});
    const questionContext = buildQuestionContext({question, storyContext, classification});
    const retrievalQuestion = questionContext.retrievalQuestion;
    const explorationQuestion = questionContext.explorationQuestion;
    const synthesisQuestion = questionContext.answerQuestion || question;

    // Shared, mostly-stable context threaded into every phase generator.
    //
    const ctx = {
        question, storyContext, tools, governor, traceIndexer, embedder, store, reranker, degraded,
        precomputedSimilarTraces, corpusCoverage, throttleMs, signal,
        traceId, timer, startedAt, classification, questionContext,
        retrievalQuestion, explorationQuestion, synthesisQuestion
    };

    yield {type: 'trace.start', traceId, question, startedAt};
    const intentMark = timer.mark('intent.classified', {
        intent: classification.intent,
        scope: classification.scope,
        confidence: classification.confidence
    });
    yield {
        type: 'timing.checkpoint',
        name: intentMark.name,
        sinceStart: intentMark.sinceStart,
        sinceLast: intentMark.sinceLast,
        intent: intentMark.intent,
        scope: intentMark.scope,
        confidence: intentMark.confidence
    };

    Object.assign(ctx, yield* runPrefetch(ctx));
    const {fastPath, prefetchEvidencePacket} = ctx;

    const preExplorationRoute = chooseSynthesisMode({question, evidencePacket: prefetchEvidencePacket, fastPath, classification});
    if(preExplorationRoute.mode === 'lean') {
        const routeMark = timer.mark('synthesis.route', {...preExplorationRoute, stage: 'prefetch'});
        yield {type: 'timing.checkpoint', name: routeMark.name, sinceStart: routeMark.sinceStart, sinceLast: routeMark.sinceLast, mode: routeMark.mode, reason: routeMark.reason, stage: routeMark.stage};

        const lean = yield* synthesizeLeanTrace({question, evidencePacket: prefetchEvidencePacket, timer, signal});
        if(!lean?.trace) {
            return;
        }
        yield buildTraceCompleteEvent(
            {traceId, startedAt, timer, fastPath, question},
            {trace: lean.trace, usage: null, model: 'local', synthesisMode: 'lean'}
        );
        return;
    }

    const exploration = yield* runExploration(ctx);
    if(exploration.halt) {
        return;
    }
    Object.assign(ctx, exploration);
    const {explorationUsage} = exploration;

    Object.assign(ctx, yield* runCoverage(ctx));
    const {evidencePacket} = ctx;

    const route = chooseSynthesisMode({question, evidencePacket, fastPath, classification});
    const routeMark = timer.mark('synthesis.route', {...route, stage: 'post_exploration'});
    yield {type: 'timing.checkpoint', name: routeMark.name, sinceStart: routeMark.sinceStart, sinceLast: routeMark.sinceLast, mode: routeMark.mode, reason: routeMark.reason, stage: routeMark.stage};

    if(route.mode === 'lean') {
        const lean = yield* synthesizeLeanTrace({question, evidencePacket, timer, signal});
        if(!lean?.trace) {
            return;
        }
        yield buildTraceCompleteEvent(
            {traceId, startedAt, timer, fastPath, question},
            {trace: lean.trace, usage: combineUsage(explorationUsage, lean.usage), model: modelIdOnly(config.models.outline), synthesisMode: 'lean'}
        );
        return;
    }

    // ───── Phase 2: Synthesis — outline first, components fanned out in parallel ─────
    //
    const outlineResult = yield* runOutline(ctx);
    if(outlineResult.halt) {
        return;
    }
    Object.assign(ctx, outlineResult);

    // 2b — Component fan-out + dedup + the terminal full trace.complete.
    //
    yield* runComponents(ctx);
}

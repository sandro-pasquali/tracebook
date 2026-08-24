import {config} from '../util/config.js';
import {isSupportingEvidencePath} from '../util/retrieval-core.js';
import {resolveLanguageIntegration} from '../language-integrations/registry.js';
import {isSystemOverviewQuestion, wantsSupportingEvidence} from '../util/retrieval-intent.js';
import {
    EVIDENCE_STOPWORDS,
    evidenceLineSpan,
    isSubstantiveCodeEvidence,
    numberOrNull,
    questionSubjectScore,
    rangesOverlap,
    rankEvidenceItems,
    rankEvidenceItemsWithScores,
    selectLayerDiverse,
    selectPathDiverse,
    sourceLayerForEvidence,
    stripLineNumber
} from './evidence.js';

const VISUAL_COMPONENT_KINDS = new Set(['mermaid_figure', 'sequence_diagram']);

// Ceiling on code excerpts per trace (each is its own LLM synthesis call), and
// the relevance gate that decides how many distinct files genuinely carry the
// answer: a file earns an excerpt when its evidence score is within this ratio
// of the top code file's score. A single dominant file yields one excerpt;
// several co-strong files (e.g. a config + the server it wires) each earn one.
//
const MAX_CODE_BLOCKS = 4;
const CODE_RELEVANCE_RATIO = 0.5;

export function ensureRequestedVisualPlan({outline, evidencePacket, question, classification, selectionQuestion = question}) {
    if(!requiresVisualComponent(question, classification) || !outline || !Array.isArray(outline.plan)) {
        return outline;
    }
    if(outline.plan.some((item) => VISUAL_COMPONENT_KINDS.has(item?.kind))) {
        return outline;
    }
    const sourceRefHint = sourceHintsForDiagram(evidencePacket, selectionQuestion);
    if(sourceRefHint.length === 0) {
        return outline;
    }

    const kind = visualKindForQuestion(question, classification);
    const slot = {
        id: kind === 'sequence_diagram' ? 'runtime-sequence' : 'implementation-flow',
        kind,
        intent: 'Show the implementation flow visually before the supporting source excerpts.',
        sourceRefHint
    };
    return addPlanItem(outline, slot, {position: 'front'});
}

export function ensureOverviewPlan({outline, evidencePacket, question, classification, selectionQuestion = question}) {
    if(classification?.scope !== 'system' || !isSystemOverviewQuestion(question) || !outline || !Array.isArray(outline.plan)) {
        return outline;
    }
    const ranked = rankEvidenceItems(
        (evidencePacket?.items || []).filter((item) => !isSupportingEvidencePath(item.path)),
        selectionQuestion
    );
    const byPath = new Map();
    for(const item of ranked) {
        if(item?.path && !byPath.has(item.path)) {
            byPath.set(item.path, item);
        }
    }
    const hubItems = (evidencePacket?.architectureHubs || [])
        .map((hub) => byPath.get(hub.path))
        .filter(Boolean);
    const spine = [];
    const spinePaths = new Set();
    for(const item of [...hubItems, ...selectLayerDiverse(ranked, 5)]) {
        if(!item?.path || spinePaths.has(item.path)) {
            continue;
        }
        spine.push(item);
        spinePaths.add(item.path);
        if(spine.length >= 5) {
            break;
        }
    }
    if(spine.length === 0) {
        return outline;
    }

    const used = new Set();
    const reserved = [...outline.plan];
    const existingVisual = outline.plan.find((item) => VISUAL_COMPONENT_KINDS.has(item?.kind));
    if(existingVisual) {
        used.add(existingVisual);
    }
    const visual = {
        ...(existingVisual || {}),
        id: existingVisual?.id || uniquePlanId(reserved, 'architecture-spine'),
        kind: 'mermaid_figure',
        intent: 'Map the architecture spine from entrypoint through orchestration, data boundaries, and user-facing output.',
        sourceRefHint: spine.map(refForEvidenceItem)
    };
    reserved.push(visual);

    const codeSlots = [];
    for(const item of spine.filter(isSubstantiveCodeEvidence).slice(0, 3)) {
        const existing = outline.plan.find((planItem) => planItem?.kind === 'annotated_code_excerpt' &&
            (planItem.sourceRefHint || []).some((ref) => ref.path === item.path));
        if(existing) {
            used.add(existing);
        }
        const layer = sourceLayerForEvidence(item);
        const slot = {
            ...(existing || {}),
            id: existing?.id || uniquePlanId(reserved, `overview-${planIdFromPath(item.path)}`),
            kind: 'annotated_code_excerpt',
            intent: `Show the ${layer} layer in ${item.path} as a checkable part of the architecture spine.`,
            sourceRefHint: [refForEvidenceItem(item)]
        };
        codeSlots.push(slot);
        reserved.push(slot);
    }

    const tail = outline.plan.filter((item) => !used.has(item) && !VISUAL_COMPONENT_KINDS.has(item?.kind));
    return {...outline, plan: [visual, ...codeSlots, ...tail].slice(0, config.trace.componentLimit)};
}

export function ensureRequestedCodePlan({outline, evidencePacket, question, classification, selectionQuestion = question}) {
    if(!requiresCodeComponent(question, classification) || !outline || !Array.isArray(outline.plan)) {
        return outline;
    }

    const existingCodeItems = outline.plan.filter((item) => item?.kind === 'annotated_code_excerpt');
    const existingCount = existingCodeItems.length;
    const existingHints = planHints(existingCodeItems);
    const targetCount = desiredCodeComponentCount({question, selectionQuestion, evidencePacket, existingHints});
    if(existingCount >= targetCount) {
        return outline;
    }

    const candidates = sourceHintsForCode(evidencePacket, selectionQuestion, existingHints);
    if(candidates.length === 0) {
        return outline;
    }

    let next = outline;
    let count = existingCount;
    for(const item of candidates) {
        if(count >= targetCount) {
            break;
        }
        const slot = {
            id: uniquePlanId(next.plan, `code-${planIdFromPath(item.path)}`),
            kind: 'annotated_code_excerpt',
            intent: `Show the load-bearing source in ${item.path} so the flow can be checked against code.`,
            sourceRefHint: [refForEvidenceItem(item)]
        };
        next = addPlanItem(next, slot, {protectKinds: [...VISUAL_COMPONENT_KINDS]});
        count = next.plan.filter((planItem) => planItem?.kind === 'annotated_code_excerpt').length;
    }
    return next;
}

export function ensureApiPlan({outline, evidencePacket, question, classification, selectionQuestion = question}) {
    if(!requiresApiContract(question, classification) || !outline || !Array.isArray(outline.plan)) {
        return outline;
    }

    const facets = apiFacetEvidence(evidencePacket, selectionQuestion);
    let next = outline;

    if(!next.plan.some((item) => VISUAL_COMPONENT_KINDS.has(item?.kind))) {
        const visualHints = apiVisualHints(facets, evidencePacket, selectionQuestion);
        if(visualHints.length > 0) {
            next = addPlanItem(next, {
                id: uniquePlanId(next.plan, 'api-flow'),
                kind: 'sequence_diagram',
                intent: 'Show the API boundary from caller through route handling, response transport, and state effects.',
                sourceRefHint: visualHints
            }, {position: 'front'});
        }
    }

    next = addApiFacetSlot(next, facets.routeHandler, {
        id: 'api-route-handler',
        intent: 'Show the endpoint registration and handler entrypoint that receive API requests.'
    });
    next = addApiFacetSlot(next, facets.requestContract, {
        id: 'api-request-contract',
        intent: facets.requestContractIdentifiers.length > 0
            ? `Show the endpoint-specific ${facets.requestContractIdentifiers[0]} request shape and how it is validated before handler work begins.`
            : 'Show how the API request shape is validated or normalized before handler work begins.'
    });

    if(facets.callerUsage) {
        next = addApiFacetSlot(next, facets.callerUsage, {
            id: 'api-caller-usage',
            intent: 'Show where the API is called or consumed by the client side of the application.'
        });
    } else if(questionAsksForUsage(question) && !next.plan.some((item) => item?.id === 'api-caller-gap')) {
        next = addPlanItem(next, {
            id: 'api-caller-gap',
            kind: 'evidence_callout',
            intent: 'Call out that the retrieved evidence did not include a caller or client usage site for the API.',
            sourceRefHint: []
        }, {protectKinds: [...VISUAL_COMPONENT_KINDS]});
    }

    next = addApiFacetSlot(next, facets.responseOrState, {
        id: 'api-response-state',
        intent: 'Show how the API sends responses or streams events and records cache, trace, or storage side effects.'
    });

    return next;
}

export function ensureNamedCodePlan({outline, evidencePacket, question, classification}) {
    if(!requiresCodeComponent(question, classification) || !outline || !Array.isArray(outline.plan)) {
        return outline;
    }
    const matches = namedCodeRefs(evidencePacket, question);
    if(matches.length === 0) {
        return outline;
    }

    let next = outline;
    for(const match of matches.slice(0, 3)) {
        const codeCount = next.plan.filter((item) => item?.kind === 'annotated_code_excerpt').length;
        if(codeCount >= MAX_CODE_BLOCKS) {
            break;
        }
        if(planAlreadyCoversRef(next.plan, match.ref, match.name)) {
            continue;
        }
        const slot = {
            id: uniquePlanId(next.plan, `code-${planIdFromIdentifier(match.name)}`),
            kind: 'annotated_code_excerpt',
            intent: `Show ${match.name}, which is named in the question and carries part of the requested flow.`,
            sourceRefHint: [match.ref]
        };
        next = addPlanItem(next, slot, {protectKinds: [...VISUAL_COMPONENT_KINDS]});
    }
    return next;
}

function namedCodeRefs(evidencePacket, question) {
    const names = identifierTermsFromQuestion(question);
    if(names.length === 0) {
        return [];
    }
    const out = [];
    const used = new Set();
    for(const name of names) {
        const found = findIdentifierDefinition(evidencePacket?.items || [], name);
        if(!found || used.has(`${found.ref.path}:${found.ref.lineStart}:${name.toLowerCase()}`)) {
            continue;
        }
        used.add(`${found.ref.path}:${found.ref.lineStart}:${name.toLowerCase()}`);
        out.push(found);
    }
    return out;
}

function identifierTermsFromQuestion(question) {
    const text = String(question || '');
    const terms = [];
    const seen = new Set();
    const add = (value) => {
        const name = String(value || '').trim();
        const lower = name.toLowerCase();
        if(!/^[A-Za-z_$][\w$]{2,}$/.test(name) || EVIDENCE_STOPWORDS.has(lower) || seen.has(lower)) {
            return;
        }
        seen.add(lower);
        terms.push(name);
    };
    for(const match of text.matchAll(/`([^`]+)`/g)) {
        for(const token of match[1].matchAll(/[A-Za-z_$][\w$]{2,}/g)) {
            add(token[0]);
        }
    }
    for(const match of text.matchAll(/\b[A-Za-z_$][\w$]{2,}\b/g)) {
        const value = match[0];
        if(/[A-Z_$]/.test(value) || /(?:^|_)(?:file|path|store|index|remove|create|render|handle|watch|sync|search|embed|chunk)(?:_|$)/i.test(value)) {
            add(value);
        }
    }
    return terms.slice(0, 8);
}

function findIdentifierDefinition(items, name) {
    const candidates = [];
    const wanted = String(name || '').toLowerCase();
    for(const item of items || []) {
        if(!item?.path || isSupportingEvidencePath(item.path) || !isSubstantiveCodeEvidence(item)) {
            continue;
        }
        const integration = resolveLanguageIntegration({path: item.path});
        if(!integration) {
            continue;
        }
        const lines = String(item.content || '').split(/\r?\n/);
        for(let index = 0; index < lines.length; index++) {
            const parsed = parseLineNumberedSourceLine(lines[index], item.lineStart, index);
            const symbol = integration.symbolAtLine({
                line: parsed.source,
                lineNumber: parsed.lineNumber,
                context: {path: item.path}
            });
            if(symbol?.name?.toLowerCase() !== wanted) {
                continue;
            }
            const lineStart = parsed.lineNumber;
            candidates.push({
                name,
                ref: {
                    path: item.path,
                    lineStart,
                    lineEnd: lineStart + 24
                },
                score: (item.tool === 'read_file' ? 5 : 0) + Math.max(0, evidenceLineSpan(item) / 25)
            });
        }
    }
    candidates.sort((a, b) => b.score - a.score || a.ref.lineStart - b.ref.lineStart);
    return candidates[0] || null;
}

function parseLineNumberedSourceLine(line, fallbackStart = 1, index = 0) {
    const raw = String(line || '');
    const match = raw.match(/^\s*(\d+)\s{2}([\s\S]*)$/);
    if(match) {
        return {lineNumber: Number(match[1]), source: match[2]};
    }
    return {
        lineNumber: (Number(fallbackStart) || 1) + index,
        source: stripLineNumber(raw)
    };
}

function planAlreadyCoversRef(plan, ref, name = '') {
    const lowerName = String(name || '').toLowerCase();
    for(const item of plan || []) {
        if(item?.kind !== 'annotated_code_excerpt') {
            continue;
        }
        const intent = String(item.intent || item.id || '').toLowerCase();
        for(const hint of item.sourceRefHint || []) {
            if(hint?.path !== ref.path) {
                continue;
            }
            const overlaps = rangesOverlap(
                numberOrNull(hint.lineStart) || ref.lineStart,
                numberOrNull(hint.lineEnd) || ref.lineEnd,
                ref.lineStart,
                ref.lineEnd
            );
            if(overlaps && (!lowerName || intent.includes(lowerName))) {
                return true;
            }
        }
    }
    return false;
}

function requiresVisualComponent(question, classification) {
    const q = String(question || '').toLowerCase();
    const firstShape = classification?.preferredAnswerShapes?.[0];
    return VISUAL_COMPONENT_KINDS.has(firstShape) ||
        /\b(visual|visually|visualize|picture|pictures|diagram|draw|flowchart)\b/.test(q) ||
        (/\b(flow|lifecycle|sequence|process flow|data flow|control flow)\b/.test(q) && /\b(show|give|map|walk|trace|reason|understand)\b/.test(q));
}

function requiresCodeComponent(question, classification) {
    const q = String(question || '').toLowerCase();
    return /\b(show|see|display|open|include|give)\b.*\b(code|source|html|css|markup|stylesheet|styles?|file|files)\b/.test(q) ||
        /\b(more code|much more code|code displayed|show me the code|show me code|show the code)\b/.test(q) ||
        (classification?.preferredAnswerShapes || []).includes('annotated_code_excerpt');
}

// Evidence-driven: one code excerpt per distinct load-bearing file the evidence
// actually spans, bounded by MAX_CODE_BLOCKS and the shared component budget. An
// explicit ask for more code jumps straight to the ceiling. The relevance gate
// (CODE_RELEVANCE_RATIO) keeps a single dominant file at one excerpt while
// letting several co-strong files each earn one — so the count reflects genuine
// multi-file need rather than how many files happened to be retrieved.
//
function desiredCodeComponentCount({question, selectionQuestion = question, evidencePacket, existingHints = []}) {
    const ceiling = Math.max(1, Math.min(MAX_CODE_BLOCKS, config.trace.componentLimit - 1));
    const q = String(question || '').toLowerCase();
    if(/\b(much more code|more code|more source|more files|code displayed)\b/.test(q)) {
        return ceiling;
    }

    const scored = scoredCodeCandidates(evidencePacket, selectionQuestion, existingHints);
    if(scored.length === 0) {
        return 1;
    }
    const topScore = scored[0].score;
    if(!(topScore > 0)) {
        return 1;
    }
    // The strongest file always earns an excerpt. A second/third file earns one
    // only when it is BOTH comparably scored (within the ratio) AND genuinely
    // relevant to the question (shares a query term) — so semantic noise that
    // merely scores near the baseline never pads the answer, while files that
    // actually carry the asked-about flow each get shown.
    //
    let count = 1;
    for(let i = 1; i < scored.length; i++) {
        const entry = scored[i];
        if(entry.score >= topScore * CODE_RELEVANCE_RATIO && sharesQueryTerm(entry.item, selectionQuestion)) {
            count++;
        }
    }
    return Math.max(1, Math.min(ceiling, count));
}

function sharesQueryTerm(item, question) {
    const haystack = `${item?.path || ''}\n${String(item?.content || '').slice(0, 3000)}`.toLowerCase();
    const tokens = String(question || '').toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || [];
    return tokens.some((token) => !EVIDENCE_STOPWORDS.has(token) && haystack.includes(token));
}

function requiresApiContract(question, classification) {
    return classification?.domains?.includes('api') ||
        /\b(apis?|endpoints?|routes?|requests?|responses?|sse|streams?|streaming)\b/i.test(String(question || ''));
}

function questionAsksForUsage(question) {
    return /\b(use|used|usage|called|caller|client|frontend|browser|consume|consumed)\b/i.test(String(question || ''));
}

// The outline model plans its excerpts range-blind and sometimes stacks
// several over the same stretch of one file; re-annotating the same lines
// under different captions reads as repetition. Later excerpt items whose
// primary hint overlaps an earlier item's by >=60% of the smaller span are
// dropped — the freed slots let augmentation surface genuinely distinct
// facets instead.
//
const PLAN_RANGE_OVERLAP_RATIO = 0.6;

export function dedupeOverlappingPlanItems(outline) {
    if(!outline || !Array.isArray(outline.plan)) {
        return outline;
    }
    const kept = [];
    const claimed = [];
    for(const item of outline.plan) {
        if(item?.kind !== 'annotated_code_excerpt') {
            kept.push(item);
            continue;
        }
        const ref = primaryNumericHint(item);
        if(!ref) {
            kept.push(item);
            continue;
        }
        const covered = claimed.some((prior) =>
            prior.path === ref.path && hintOverlapRatio(prior, ref) >= PLAN_RANGE_OVERLAP_RATIO);
        if(covered) {
            continue;
        }
        claimed.push(ref);
        kept.push(item);
    }
    return kept.length === outline.plan.length ? outline : {...outline, plan: kept};
}

function primaryNumericHint(item) {
    const hint = (Array.isArray(item?.sourceRefHint) ? item.sourceRefHint : [])[0];
    const lineStart = numberOrNull(hint?.lineStart);
    const lineEnd = numberOrNull(hint?.lineEnd);
    if(!hint?.path || lineStart === null || lineEnd === null || lineEnd < lineStart) {
        return null;
    }
    return {path: hint.path, lineStart, lineEnd};
}

function hintOverlapRatio(a, b) {
    const overlap = Math.min(a.lineEnd, b.lineEnd) - Math.max(a.lineStart, b.lineStart) + 1;
    if(overlap <= 0) {
        return 0;
    }
    const smaller = Math.max(1, Math.min(a.lineEnd - a.lineStart + 1, b.lineEnd - b.lineStart + 1));
    return overlap / smaller;
}

// Route registrations identify endpoint files. Positive signal for the
// routeHandler facet; negative for requestContract, where a *different*
// endpoint file satisfying the validation patterns demonstrates another
// feature's route, not this one's contract — schemas/validators don't
// register routes.
//
const ROUTE_REGISTRATION_PATTERNS = [
    /\bapp\.(?:get|post|put|patch|delete|use)\s*\(/i,
    /\brouter\.(?:get|post|put|patch|delete|use)\s*\(/i,
    /\bregister[A-Z]\w*Routes?\b/
];

function apiFacetEvidence(evidencePacket, question) {
    const items = (evidencePacket?.items || [])
        .filter((item) => !isSupportingEvidencePath(item.path))
        .filter(isSubstantiveCodeEvidence);
    const routeHandler = bestApiFacetItem(items, question, {
        terms: ['api', 'endpoint', 'route', 'handler', 'server', 'controller'],
        content: [
            ...ROUTE_REGISTRATION_PATTERNS,
            /['"`]\/api\//i
        ],
        path: /(^|\/)(server|routes?|controllers?|handlers?|api)\b/i
    });
    const requestContractIdentifiers = apiRequestContractIdentifiers(routeHandler);
    return {
        routeHandler,
        requestContract: bestApiFacetItem(items, question, {
            terms: ['request', 'body', 'query', 'params', 'schema', 'validation', 'contract'],
            content: [
                /\bwithRequest\s*\(/,
                /\b(?:body|query|params)Schema\b/,
                /\bz\.object\s*\(/,
                /\b(?:validate|validation|parse|safeParse)\b/i
            ],
            path: /(^|\/)(contracts?|schemas?|validation|validators?|server|routes?)\b/i,
            avoidContent: ROUTE_REGISTRATION_PATTERNS,
            preferredIdentifiers: requestContractIdentifiers
        }),
        requestContractIdentifiers,
        callerUsage: bestApiFacetItem(items, question, {
            terms: ['client', 'frontend', 'browser', 'fetch', 'caller', 'usage'],
            content: [
                /\bfetch\s*\(/,
                /\bapiFetch\s*\(/,
                /\bEventSource\s*\(/,
                /['"`]\/api\//i
            ],
            path: /(^|\/)(public|client|frontend|browser|web|ui|app)\b/i,
            avoidPath: /(^|\/)(server|routes?|controllers?|handlers?)\b/i
        }),
        responseOrState: bestApiFacetItem(items, question, {
            terms: ['response', 'stream', 'sse', 'event', 'cache', 'persist', 'save', 'storage', 'trace', 'story'],
            content: [
                /\bstreamSSE\s*\(/,
                /\bwriteSSE\s*\(/,
                /\bc\.json\s*\(/,
                /\b(?:save|persist|cache|storage|store|trace|story|abort|error)\b/i
            ],
            path: /(^|\/)(server|routes?|storage|store|cache|trace|story|runtime)\b/i
        })
    };
}

function bestApiFacetItem(items, question, facet) {
    let best = null;
    for(const item of items || []) {
        const facetScore = apiFacetScore(item, facet);
        if(facetScore <= 0) {
            continue;
        }
        // Subject relevance is scored lean (similarity + question-token hits
        // only) and weighted heavily: the full evidence ranking carries
        // architecture boosts that re-reward "API-ness" and would double-count
        // structure over topic. Pattern-dense but off-subject plumbing (e.g.
        // generic SSE streaming for a deletion question) must not beat the
        // on-subject file that satisfies the same facet.
        //
        const score = facetScore * 3 + questionSubjectScore(item, question) * 3;
        if(!best || score > best.score) {
            best = {item, score};
        }
    }
    return best?.item || null;
}

// A facet's content patterns are alternatives — any one of them means the item
// satisfies the facet. Counting multiple hits rewards keyword density and
// swamps the subject-relevance term in bestApiFacetItem, so exactly one
// pattern hit scores.
//
const FACET_CONTENT_PATTERN_CAP = 1;

function apiFacetScore(item, facet) {
    const path = String(item?.path || '');
    const content = String(item?.content || '');
    const haystack = `${path}\n${content.slice(0, 4000)}`.toLowerCase();
    let score = 0;
    if(facet.path?.test(path)) {
        score += 4;
    }
    if(facet.avoidPath?.test(path)) {
        score -= 3;
    }
    if((facet.avoidContent || []).some((pattern) => pattern.test(content))) {
        score -= 6;
    }
    for(const term of facet.terms || []) {
        if(haystack.includes(term)) {
            score += 0.75;
        }
    }
    let patternHits = 0;
    for(const pattern of facet.content || []) {
        if(pattern.test(content)) {
            patternHits++;
        }
    }
    score += Math.min(patternHits, FACET_CONTENT_PATTERN_CAP) * 5;
    score += preferredIdentifierEvidenceBonus(content, facet.preferredIdentifiers);
    return score;
}

// Follow the concrete contract names bound at the chosen route instead of
// treating every schema/validator in the evidence packet as interchangeable.
// For `/api/ask`, this turns the route's `body: askRequestSchema` reference into
// a strong preference for the chunk that defines `askRequestSchema`.
//
function apiRequestContractIdentifiers(routeItem) {
    const content = String(routeItem?.content || '');
    const withRequestIndex = content.search(/\bwithRequest\s*\(/);
    if(withRequestIndex < 0) {
        return [];
    }
    const contractWindow = content.slice(withRequestIndex, withRequestIndex + 1200);
    const found = [];
    const seen = new Set();
    const add = (value, priority = 3) => {
        const identifier = String(value || '');
        if(!identifier || !/(?:schema|contract|validator)$/i.test(identifier) || seen.has(identifier)) {
            return;
        }
        seen.add(identifier);
        found.push({identifier, priority});
    };
    const partPriority = {body: 0, params: 1, query: 2};
    for(const match of contractWindow.matchAll(/\b(body|query|params)\s*:\s*([A-Za-z_$][\w$]*)/g)) {
        add(match[2], partPriority[match[1]]);
    }
    const direct = /\bwithRequest\s*\(\s*([A-Za-z_$][\w$]*)/.exec(contractWindow);
    if(direct) {
        add(direct[1], 0);
    }
    return found
        .sort((a, b) => a.priority - b.priority)
        .slice(0, 4)
        .map((entry) => entry.identifier);
}

function preferredIdentifierEvidenceBonus(content, identifiers = []) {
    let best = 0;
    for(const identifier of identifiers) {
        const escaped = escapeRegExp(identifier);
        const definition = new RegExp(`\\b(?:export\\s+)?(?:const|let|var|function|class)\\s+${escaped}\\b`);
        const mention = new RegExp(`\\b${escaped}\\b`);
        if(definition.test(content)) {
            best = Math.max(best, 14);
        } else if(mention.test(content)) {
            best = Math.max(best, 4);
        }
    }
    return best;
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function apiVisualHints(facets, evidencePacket, question) {
    const selected = [];
    const seen = new Set();
    for(const item of [facets.callerUsage, facets.routeHandler, facets.requestContract, facets.responseOrState]) {
        if(!item?.path || seen.has(item.path)) {
            continue;
        }
        seen.add(item.path);
        selected.push(refForEvidenceItem(item));
        if(selected.length >= 4) {
            return selected;
        }
    }
    if(selected.length > 0) {
        return selected;
    }
    return sourceHintsForDiagram(evidencePacket, question);
}

function addApiFacetSlot(outline, item, {id, intent}) {
    if(!item?.path) {
        return outline;
    }
    const ref = refForEvidenceItem(item);
    if(planAlreadyCoversRef(outline.plan, ref)) {
        return outline;
    }
    return addPlanItem(outline, {
        id: uniquePlanId(outline.plan, id),
        kind: 'annotated_code_excerpt',
        intent,
        sourceRefHint: [ref]
    }, {protectKinds: [...VISUAL_COMPONENT_KINDS]});
}

// Distinct-path, substantive, non-supporting code evidence with composite
// scores, sorted strongest first — the pool both the count gate and the slot
// fill draw from.
//
function scoredCodeCandidates(evidencePacket, question, existingHints) {
    const items = (evidencePacket?.items || [])
        .filter((item) => !evidenceCoveredByHints(item, existingHints))
        .filter((item) => !isSupportingEvidencePath(item.path))
        .filter(isSubstantiveCodeEvidence);
    const ranked = rankEvidenceItemsWithScores(items, question);
    const seen = new Set();
    const out = [];
    for(const entry of ranked) {
        const path = entry.item?.path;
        if(!path || seen.has(path)) {
            continue;
        }
        seen.add(path);
        out.push(entry);
    }
    return out;
}

function visualKindForQuestion(question, classification) {
    const firstShape = classification?.preferredAnswerShapes?.[0];
    if(VISUAL_COMPONENT_KINDS.has(firstShape)) {
        return firstShape;
    }
    const q = String(question || '').toLowerCase();
    if(/\b(sequence|request|response|api|endpoint|route|client|server|browser|frontend|backend|stream|streaming|sse|websocket|event)\b/.test(q)) {
        return 'sequence_diagram';
    }
    return 'mermaid_figure';
}

function sourceHintsForDiagram(evidencePacket, question) {
    const items = evidencePacket?.items || [];
    const ranked = rankEvidenceItems(items, question);
    const primary = ranked.filter((item) => !isSupportingEvidencePath(item.path));
    const selected = selectPathDiverse(primary.length ? primary : ranked, 4);
    return selected.map(refForEvidenceItem).filter((ref) => ref.path);
}

function sourceHintsForCode(evidencePacket, question, existingHints) {
    const items = (evidencePacket?.items || [])
        .filter((item) => !evidenceCoveredByHints(item, existingHints))
        .filter((item) => !isSupportingEvidencePath(item.path))
        .filter(isSubstantiveCodeEvidence);
    const ranked = rankEvidenceItems(items, question);
    const limit = Math.max(0, config.trace.componentLimit);
    return selectUiSurfaceDiverse(ranked, question, limit) || selectPathDiverse(ranked, limit);
}

function selectUiSurfaceDiverse(items, question, limit) {
    const wanted = uiSurfaceFamiliesForQuestion(question);
    if(wanted.size === 0 || limit <= 0) {
        return null;
    }
    const selected = [];
    for(const family of wanted) {
        const found = items.find((item) => sourceFamilyForPath(item.path) === family && !selected.includes(item));
        if(found) {
            selected.push(found);
            if(selected.length >= limit) {
                return selected;
            }
        }
    }
    for(const item of items) {
        if(selected.includes(item)) {
            continue;
        }
        selected.push(item);
        if(selected.length >= limit) {
            break;
        }
    }
    return selected;
}

function uiSurfaceFamiliesForQuestion(question) {
    const q = String(question || '').toLowerCase();
    const families = new Set();
    if(/\b(html|markup|template|dom|document|page|screen|layout|visible|ui|frontend|browser)\b/.test(q)) {
        families.add('markup');
    }
    if(/\b(css|style|styles|stylesheet|selector|layout|appearance|theme|visual|color|spacing|responsive|animation)\b/.test(q)) {
        families.add('style');
    }
    return families;
}

function sourceFamilyForPath(path) {
    const family = resolveLanguageIntegration({path})?.family;
    if(family === 'markup' || family === 'template') {
        return 'markup';
    }
    if(family === 'css') {
        return 'style';
    }
    return '';
}

function planHints(planItems) {
    const hints = [];
    for(const item of planItems || []) {
        for(const ref of item?.sourceRefHint || []) {
            if(ref?.path) {
                hints.push(ref);
            }
        }
    }
    return hints;
}

function evidenceCoveredByHints(item, hints) {
    for(const hint of hints || []) {
        if(hint?.path !== item?.path) {
            continue;
        }
        const hintStart = numberOrNull(hint.lineStart);
        const hintEnd = numberOrNull(hint.lineEnd);
        const itemStart = numberOrNull(item.lineStart);
        const itemEnd = numberOrNull(item.lineEnd);
        if(hintStart === null || hintEnd === null || itemStart === null || itemEnd === null) {
            return true;
        }
        if(rangesOverlap(hintStart, hintEnd, itemStart, itemEnd)) {
            return true;
        }
    }
    return false;
}

function refForEvidenceItem(item) {
    return {
        path: item?.path || '',
        lineStart: numberOrNull(item?.lineStart),
        lineEnd: numberOrNull(item?.lineEnd)
    };
}

function addPlanItem(outline, slot, {position = 'end', protectKinds = []} = {}) {
    const plan = Array.isArray(outline?.plan) ? [...outline.plan] : [];
    if(plan.some((item) => item?.id === slot.id)) {
        return outline;
    }

    if(plan.length < config.trace.componentLimit) {
        if(position === 'front') {
            plan.unshift(slot);
        } else {
            plan.push(slot);
        }
        return {...outline, plan};
    }

    const replaceIndex = findReplaceablePlanIndex(plan, protectKinds);
    if(replaceIndex < 0) {
        return outline;
    }
    plan[replaceIndex] = slot;
    if(position === 'front') {
        const [inserted] = plan.splice(replaceIndex, 1);
        plan.unshift(inserted);
    }
    return {...outline, plan};
}

function findReplaceablePlanIndex(plan, protectKinds = []) {
    const protectedKinds = new Set(protectKinds);
    for(let i = plan.length - 1; i >= 0; i--) {
        if(!protectedKinds.has(plan[i]?.kind) && plan[i]?.kind === 'evidence_callout') {
            return i;
        }
    }
    for(let i = plan.length - 1; i >= 0; i--) {
        if(!protectedKinds.has(plan[i]?.kind)) {
            return i;
        }
    }
    return -1;
}

function planIdFromPath(path) {
    const raw = String(path || 'source').split('/').pop() || 'source';
    const withoutExtension = raw.replace(/\.[^.]+$/, '') || raw;
    const id = withoutExtension
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return id || 'source';
}

function planIdFromIdentifier(name) {
    return String(name || 'symbol')
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'symbol';
}

function uniquePlanId(plan, base) {
    const ids = new Set((plan || []).map((item) => item?.id).filter(Boolean));
    if(!ids.has(base)) {
        return base;
    }
    for(let i = 2; i < 20; i++) {
        const candidate = `${base}-${i}`;
        if(!ids.has(candidate)) {
            return candidate;
        }
    }
    return `${base}-${Date.now().toString(36)}`;
}

export function ensureSupportingActorPlan({outline, evidencePacket, question = ''}) {
    if(!wantsSupportingEvidence(question)) {
        return outline;
    }
    const supporting = (evidencePacket?.items || []).filter((item) => isSupportingEvidencePath(item.path));
    if(!supporting.length || !outline || !Array.isArray(outline.plan)) {
        return outline;
    }
    const hasSupportingSlot = outline.plan.some((item) =>
        Array.isArray(item?.sourceRefHint) &&
        item.sourceRefHint.some((ref) => isSupportingEvidencePath(ref?.path))
    );
    if(hasSupportingSlot) {
        return outline;
    }

    const slot = {
        id: 'supporting-actors',
        kind: 'evidence_callout',
        intent: 'Explain the dependency, manifest, and configuration actors that shape this implementation.',
        sourceRefHint: supporting.slice(0, 4).map((item) => ({
            path: item.path,
            lineStart: item.lineStart,
            lineEnd: item.lineEnd
        }))
    };

    const plan = [...outline.plan];
    if(plan.length < config.trace.componentLimit) {
        plan.push(slot);
    } else {
        plan[plan.length - 1] = slot;
    }
    return {...outline, plan};
}

// FeatureTrace is the product-behavior artifact under the rendered UI trace.
// It is deliberately deterministic for now: the LLM explains code, then this
// layer reshapes the answer into Explain -> Simulate -> Verify affordances.

// An admitted coverage gap caps overall confidence: components that are
// internally confident about adjacent content must not average away "the
// expected source was not found".
//
const GAP_CONFIDENCE_CEILING = 0.6;

export function buildFeatureTrace({question, trace, traceId, createdAt = Date.now()} = {}) {
    const components = Array.isArray(trace?.components) ? trace.components : [];
    const evidence = collectEvidence(components);
    const behavior = behaviorName({question, trace});
    const actors = inferActors({question, trace});
    const hasGap = components.some((c) => c?.type === 'evidence_callout' && c?.kind === 'gap');
    let confidence = evidence.length > 0
        ? average(components.map((c) => Number(c?.confidence)).filter(Number.isFinite))
        : 0;
    if(hasGap) {
        confidence = Math.min(confidence, GAP_CONFIDENCE_CEILING);
    }

    return {
        traceId,
        createdAt,
        behavior,
        question: question || '',
        summary: trace?.title || behavior,
        actors,
        entrypoints: selectEntrypoints(evidence),
        happyPath: Array.isArray(trace?.narrative) ? trace.narrative.slice(0, 8) : [],
        alternatePaths: inferAlternatePaths(components),
        evidence,
        confidence: Number((confidence || 0).toFixed(2)),
        openQuestions: inferOpenQuestions({question, components, evidence}),
        changeRisks: inferChangeRisks(evidence)
    };
}

export function simulateFeatureTrace({featureTrace, condition} = {}) {
    const c = String(condition || '').trim();
    if(!featureTrace || !c) {
        return {error: 'missing_feature_trace_or_condition'};
    }

    const hits = rankEvidenceForCondition(featureTrace.evidence || [], c);
    const affected = hits.slice(0, 4).map((h) => h.evidence);
    const hasEvidence = affected.length > 0;

    return {
        type: 'simulation',
        behavior: featureTrace.behavior,
        condition: c,
        summary: hasEvidence
            ? `The condition appears most connected to ${affected.map((e) => e.path).join(', ')}.`
            : 'The existing trace does not contain direct evidence for this condition.',
        changedSteps: hasEvidence
            ? affected.map((e) => `Inspect ${e.path}${lineRange(e)} before changing behavior for "${c}".`)
            : [`No grounded changed step can be asserted for "${c}" from this trace alone.`],
        unchangedSteps: (featureTrace.happyPath || []).slice(0, hasEvidence ? 3 : 2),
        evidence: affected,
        gaps: hasEvidence ? [] : [
            'Run a deeper trace for this condition so the system can gather source evidence for the alternate path.'
        ],
        confidence: hasEvidence ? 0.65 : 0.25
    };
}

export function verifyFeatureTrace({featureTrace} = {}) {
    if(!featureTrace) {
        return {error: 'missing_feature_trace'};
    }

    const entry = featureTrace.entrypoints?.[0];
    const evidence = featureTrace.evidence?.[0];
    const questions = [
        {
            id: 'behavior-summary',
            prompt: `Tell the story of "${featureTrace.behavior}" in one or two sentences.`,
            expected: featureTrace.summary || featureTrace.behavior,
            evidence: evidence ? [evidence] : []
        },
        {
            id: 'entrypoint',
            prompt: entry
                ? `Where does this story enter the code, and why does that source matter?`
                : 'Which source file would you inspect first, and what evidence supports that choice?',
            expected: entry ? `${entry.path}${lineRange(entry)} is the first grounded entrypoint in this trace.` : 'The trace has no grounded entrypoint.',
            evidence: entry ? [entry] : []
        },
        {
            id: 'change-risk',
            prompt: 'Before asking an LLM to change this feature, what source-backed risk would you carry forward?',
            expected: featureTrace.changeRisks?.[0] || 'Identify side effects and missing alternate paths before changing code.',
            evidence: featureTrace.evidence?.slice(0, 2) || []
        }
    ];

    return {
        type: 'verification',
        behavior: featureTrace.behavior,
        readinessRule: 'Ready to author the next feature story only when the reader can retell the current behavior, identify its source entrypoint, and name the source-backed risk they would carry into an LLM coding session.',
        questions
    };
}

function collectEvidence(components) {
    const out = [];
    const seen = new Set();
    for(const component of components) {
        const refs = Array.isArray(component?.sourceRefs) ? component.sourceRefs : [];
        for(const ref of refs) {
            if(!ref?.path) {
                continue;
            }
            const item = {
                path: ref.path,
                lineStart: numberOrNull(ref.lineStart),
                lineEnd: numberOrNull(ref.lineEnd),
                componentId: component.id || null,
                componentType: component.type || null,
                componentKind: component.kind || null,
                claim: component.summary || component.caption || component.reason || ''
            };
            const key = `${item.path}:${item.lineStart || ''}-${item.lineEnd || ''}:${item.componentId || ''}`;
            if(seen.has(key)) {
                continue;
            }
            seen.add(key);
            out.push(item);
        }
    }
    return out;
}

// Entrypoints answer "where does this behavior enter the code". Refs cited by
// a gap callout are adjacent context around something that was NOT found, so
// they never qualify, and the same range cited by several components is one
// entrypoint, not several.
//
function selectEntrypoints(evidence) {
    const out = [];
    const seen = new Set();
    for(const e of evidence) {
        if(e.componentType === 'evidence_callout' && e.componentKind === 'gap') {
            continue;
        }
        const key = `${e.path}:${e.lineStart || ''}-${e.lineEnd || ''}`;
        if(seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push({
            path: e.path,
            lineStart: e.lineStart,
            lineEnd: e.lineEnd,
            role: roleForPath(e.path)
        });
        if(out.length >= 5) {
            break;
        }
    }
    return out;
}

function behaviorName({question, trace}) {
    const raw = trace?.title || question || 'Unknown behavior';
    return String(raw).replace(/^Source match for\s*/i, '').replace(/^No source match for\s*/i, '').replace(/^["']|["']$/g, '').slice(0, 100);
}

function inferActors({question, trace}) {
    const text = `${question || ''}\n${trace?.title || ''}\n${(trace?.narrative || []).join('\n')}`.toLowerCase();
    const actors = [];
    if(/\b(user|browser|client|form|ui)\b/.test(text)) actors.push('user/client');
    if(/\b(api|server|route|handler|hono|endpoint)\b/.test(text)) actors.push('server');
    if(/\b(llm|model|provider|planner|synthesis|exploration|ai sdk)\b/.test(text)) actors.push('llm/planner');
    if(/\bdb|database|store|lance|index|cache|trace\b/.test(text)) actors.push('data store');
    return actors.length > 0 ? actors : ['system'];
}

// Gap callouts are coverage failures, not behavior branches — they surface in
// openQuestions, never as alternate paths the behavior could take.
//
function inferAlternatePaths(components) {
    return components
        .filter((c) => c?.type === 'evidence_callout' && c.kind === 'inferred')
        .map((c) => ({
            condition: c.summary || 'Alternate path',
            detail: c.detail || '',
            confidence: Number(c.confidence) || 0
        }))
        .slice(0, 5);
}

function inferOpenQuestions({components, evidence}) {
    const gaps = components
        .filter((c) => c?.type === 'evidence_callout' && c.kind === 'gap')
        .map((c) => c.summary || c.detail)
        .filter(Boolean);
    if(gaps.length > 0) {
        return gaps.slice(0, 5);
    }
    if(evidence.length === 0) {
        return ['No source evidence was captured for this trace.'];
    }
    return ['Which alternate failure paths should be traced before modifying this behavior?'];
}

function inferChangeRisks(evidence) {
    if(evidence.length === 0) {
        return ['Changing this behavior without source evidence is high risk.'];
    }
    return evidence.slice(0, 4).map((e) => `Changing ${e.path}${lineRange(e)} may affect ${roleForPath(e.path)} behavior.`);
}

function rankEvidenceForCondition(evidence, condition) {
    const terms = String(condition || '').toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
    return evidence
        .map((e, index) => {
            const haystack = `${e.path} ${e.claim || ''} ${e.componentId || ''} ${e.componentType || ''}`.toLowerCase();
            const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
            return {evidence: e, score, index};
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index);
}

// Coarse architectural layer for a path, using vocabulary common across
// codebases rather than any one repo's module names. Used only to label
// entrypoints and phrase change-risk sentences, so an "implementation" fallback
// is always acceptable when nothing matches.
//
function roleForPath(path) {
    if(/public\/|client|frontend|\bui\b|view|component|template|app\.js/i.test(path)) return 'user-facing';
    if(/server|route|api|handler|controller|endpoint|middleware/i.test(path)) return 'request handling';
    if(/store|database|\bdb\b|model|repository|schema|migration|cache/i.test(path)) return 'data/state';
    if(/service|domain|usecase|worker|\bjob\b|lib\/|core\//i.test(path)) return 'service logic';
    return 'implementation';
}

function lineRange(item) {
    return item?.lineStart && item?.lineEnd ? ` lines ${item.lineStart}-${item.lineEnd}` : '';
}

function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function average(values) {
    if(!values.length) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

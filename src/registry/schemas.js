import {z} from 'zod';
import {config} from '../util/config.js';

// Schemas for the UI primitive vocabulary.
// The LLM emits a `components` array; each entry must match one of these by `type`.
// Schema validation is the contract that prevents hallucinated component types and shapes.
//

const sourceRef = z.object({
    path: z.string().describe('Repo-relative path to the source file.'),
    lineStart: z.number().int().nullable().describe('1-based start line, or null if not line-specific.'),
    lineEnd: z.number().int().nullable().describe('1-based end line, or null if not line-specific.')
});

const commonFields = {
    id: z.string().describe('Stable component id within this Trace; lowercase, kebab-case.'),
    sourceRefs: z.array(sourceRef).describe('Files this component is grounded in. Empty array allowed only when type is evidence_callout with kind=inferred or gap.'),
    confidence: z.number().min(0).max(1).describe('How well-grounded this component is in the source. 1 = direct quote/observation; 0 = pure inference.'),
    reason: z.string().nullable().describe('Optional one-sentence rationale, or null when kind/summary already express the rationale.')
};

// Field order is intentional: short required fields first (caption, language)
// so the model finishes them before tackling the long content (code, callouts).
// This protects against truncation mid-stream — the model can run out of
// tokens before emitting the last fields, and a missing `caption` (a required
// string) was the cause of intermittent validation failures.
//
const annotatedCodeExcerpt = z.object({
    type: z.literal('annotated_code_excerpt'),
    ...commonFields,
    caption: z.string().describe('Short header above the code block, e.g., "Auth middleware".'),
    language: z.string().describe('Language hint for highlighting (e.g., html, css, javascript, typescript, jsx, tsx, json, markdown, python, go, rust, java, csharp, php, yaml, shell).'),
    code: z.string().describe('Verbatim excerpt from the source file. Target 10–32 lines, up to 60 if needed to keep a function, handler, callback, HTML section, CSS rule group, config block, query, or template COMPLETE. Never inline whole files. Always end on a natural boundary (closing brace, closing tag, completed CSS rule, completed object/list block, or blank line). Prefer the smallest window that includes a complete logical unit. The path and starting line number live in sourceRefs[0] — do not duplicate them here.'),
    callouts: z.array(z.object({
        line: z.number().int().describe('1-based line number RELATIVE to the excerpt (not the file).'),
        note: z.string().describe('Plain-language explanation of why this line matters to the surrounding behavior.')
    })).min(1).describe('REQUIRED. Per-line callouts wedged between source lines explaining the load-bearing lines. Target 3–5 callouts (NEVER more than 5, NEVER fewer than 3 if you can help it). Each note may be one or two compact sentences that teach the behavior, data flow, side effect, or boundary. Too few leaves code unexplained; too many drowns the code.')
});

const sequenceDiagram = z.object({
    type: z.literal('sequence_diagram'),
    ...commonFields,
    mermaid: z.string().trim().min(1).refine((value) => /^sequenceDiagram\b/i.test(value), {
        message: 'sequence_diagram Mermaid must begin with sequenceDiagram'
    }).describe('Valid Mermaid sequenceDiagram source. Must begin with `sequenceDiagram`.'),
    caption: z.string().describe('Short header above the diagram.')
});

const mermaidFigure = z.object({
    type: z.literal('mermaid_figure'),
    ...commonFields,
    diagramType: z.enum(['sequence', 'flowchart', 'state', 'timeline', 'class', 'mindmap', 'other']).nullable().describe('The Mermaid diagram family chosen for this figure, or null if unspecified.'),
    mermaid: z.string().trim().min(1).refine(isSupportedMermaidDeclaration, {
        message: 'mermaid_figure Mermaid must begin with a supported Mermaid declaration'
    }).describe('Valid Mermaid source. Use a supported declaration such as `sequenceDiagram`, `flowchart TD`, `stateDiagram-v2`, `timeline`, `classDiagram`, or `mindmap`.'),
    caption: z.string().describe('Short header above the figure.')
});

const evidenceCallout = z.object({
    type: z.literal('evidence_callout'),
    ...commonFields,
    kind: z.enum(['grounded', 'inferred', 'gap']).describe('grounded = directly proven by source; inferred = reasoned from evidence but not stated; gap = required source evidence was unavailable. Runtime post-processing assigns the specific gap reason.'),
    summary: z.string().describe('One-line claim or observation.'),
    detail: z.string().describe('Two to four sentences explaining the claim and what supports or undermines it.')
});

const componentUnion = z.discriminatedUnion('type', [
    annotatedCodeExcerpt,
    sequenceDiagram,
    mermaidFigure,
    evidenceCallout
]);
const TRACE_COMPONENT_LIMIT = config.trace.componentLimit;

// Top-level shape returned by the planner LLM call.
// The narrative array gives the user a brief textual through-line; components carry the visual payload.
//
const traceSchema = z.object({
    title: z.string().describe('One-line title for the Trace, derived from the question.'),
    narrative: z.array(z.string()).min(1).max(5).describe('Short ordered list of plain-language steps that summarize the answer. Each step is one sentence.'),
    components: z.array(componentUnion).min(1).max(TRACE_COMPONENT_LIMIT).describe(`Ordered list of UI primitives that visually explain the answer. Hard cap of ${TRACE_COMPONENT_LIMIT} — prefer fewer, more focused components over many.`)
});

// Outline schema — the first synthesis pass.
// Produces title + narrative + a short plan for which components to render,
// WITHOUT generating any of the component bodies. The full components are
// generated in parallel in a second pass, one streamObject call per plan item.
//
const PRIMITIVE_TYPES = ['annotated_code_excerpt', 'mermaid_figure', 'sequence_diagram', 'evidence_callout'];

const componentPlanItem = z.object({
    id: z.string().describe('Stable component id within this Trace; lowercase, kebab-case.'),
    kind: z.enum(PRIMITIVE_TYPES).describe('Which primitive type to render.'),
    intent: z.string().describe('One short sentence: what this component should explain and why it earns a slot.'),
    sourceRefHint: z.array(z.object({
        path: z.string().describe('Repo-relative path that appeared in a tool result.'),
        lineStart: z.number().int().nullable(),
        lineEnd: z.number().int().nullable()
    })).describe('Suggested file regions to cite. Drawn from the exploration tool results. Use an empty array when no specific source hint is available.')
});

const traceOutlineSchema = z.object({
    title: z.string().describe('One-line title for the Trace.'),
    narrative: z.array(z.string()).min(1).max(5).describe('Ordered one-sentence steps that summarize the answer.'),
    plan: z.array(componentPlanItem).min(1).max(TRACE_COMPONENT_LIMIT).describe(`Ordered plan of 1–${TRACE_COMPONENT_LIMIT} components to render. The component bodies are generated in a separate pass.`)
});

// Lookup of the per-kind schemas. The synthesis fan-out picks the specific
// schema by kind instead of using the discriminated union, which avoids
// OpenAI structured-output edge cases around oneOf branches.
//
// `*Body` variants drop the `type` literal — the kind is implicit at the call
// site, and z.literal sometimes trips up OpenAI's structured output
// validation. The planner re-injects `type` after the model returns.
//
const annotatedCodeExcerptBody = annotatedCodeExcerpt.omit({type: true});
const sequenceDiagramBody = sequenceDiagram.omit({type: true});
const mermaidFigureBody = mermaidFigure.omit({type: true});
const evidenceCalloutBody = evidenceCallout.omit({type: true});

const componentSchemaByKind = {
    annotated_code_excerpt: annotatedCodeExcerptBody,
    mermaid_figure: mermaidFigureBody,
    sequence_diagram: sequenceDiagramBody,
    evidence_callout: evidenceCalloutBody
};

export {traceSchema, componentUnion, PRIMITIVE_TYPES, traceOutlineSchema, componentPlanItem, componentSchemaByKind, annotatedCodeExcerpt, sequenceDiagram, mermaidFigure, evidenceCallout};

function isSupportedMermaidDeclaration(value) {
    return /^(?:sequenceDiagram|flowchart\b|graph\b|stateDiagram-v2\b|timeline\b|classDiagram\b|mindmap\b)/i.test(String(value || '').trim());
}

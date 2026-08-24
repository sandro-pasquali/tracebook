import {z} from 'zod';

const sourceRef = z.object({
    path: z.string().min(1).describe('Repo-relative source path.'),
    lineStart: z.number().int().positive().nullable().describe('1-based start line, or null when file-level.'),
    lineEnd: z.number().int().positive().nullable().describe('1-based end line, or null when file-level.')
}).strict();

const evidenceBackedText = z.object({
    text: z.string().trim().min(1).max(600),
    sourceRefs: z.array(sourceRef).max(4).default([])
}).strict();

const fileSuggestion = z.object({
    path: z.string().min(1),
    role: z.enum(['ui', 'route', 'service', 'data', 'test', 'config', 'tooling', 'source']).default('source'),
    reason: z.string().trim().min(1).max(500),
    confidence: z.enum(['high', 'medium', 'low']).default('medium'),
    sourceRefs: z.array(sourceRef).max(6).default([])
}).strict();

export const changeBriefOutputFormatSchema = z.enum(['llm_prompt', 'repository_issue', 'ticket']);

// Canonical LLM-produced body. The route adds ids, timestamps, source revision,
// output rendering, and a deterministic evidence appendix after validation.
//
export const changeBriefDraftSchema = z.object({
    title: z.string().trim().min(1).max(160),
    productGoal: z.string().trim().min(1).max(1200),
    currentBehavior: z.string().trim().min(1).max(1200),
    likelyFiles: z.array(fileSuggestion).min(1).max(8),
    existingPatterns: z.array(evidenceBackedText).max(8).default([]),
    implementationConstraints: z.array(evidenceBackedText).max(8).default([]),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(400)).min(1).max(10),
    testPlan: z.array(evidenceBackedText).max(8).default([]),
    openQuestions: z.array(z.string().trim().min(1).max(400)).max(8).default([]),
    riskNotes: z.array(evidenceBackedText).max(8).default([])
}).strict();

export const changeBriefSchema = changeBriefDraftSchema.extend({
    briefId: z.string().min(1),
    traceId: z.string().min(1),
    createdAt: z.number().int().positive(),
    sourceRevision: z.string().nullable(),
    traceSourceRevision: z.string().nullable(),
    freshness: z.enum(['current', 'stale', 'unknown']),
    changeIntent: z.string().trim().min(1),
    outputFormat: changeBriefOutputFormatSchema,
    agentPrompt: z.string().trim().min(1),
    evidence: z.array(z.object({
        path: z.string().min(1),
        lineStart: z.number().int().positive().nullable(),
        lineEnd: z.number().int().positive().nullable(),
        reason: z.string().trim().min(1),
        confidence: z.enum(['high', 'medium', 'low']),
        content: z.string().default('')
    }).strict()).max(16)
}).strict();

export const changeBriefRequestSchema = z.object({
    changeIntent: z.string().trim().min(1).max(4000),
    outputFormat: changeBriefOutputFormatSchema.default('llm_prompt')
}).strict();

export function sanitizeChangeBriefDraft(value) {
    return changeBriefDraftSchema.parse(value);
}

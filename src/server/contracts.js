import {z} from 'zod';
import {compactReplayEvents} from '../util/replay-events.js';
import {
    base64UrlTokenSchema,
    formatZodIssues,
    limitSchema,
    sourcePathSchema,
    storyIdSchema,
    traceIdSchema
} from '../util/input-schemas.js';

// Story context is round-tripped server output: prior questions, generated
// chapter titles, and generated narrative bullets, replayed back as prompt
// context for follow-up asks. Free-text fields are therefore CLAMPED to the
// context budget instead of rejected — the pipeline does not bound what it
// generates, and a saved story must never brick its own follow-up asks over a
// long bullet. The budgets sit well above natural output (the outline prompt
// asks for one-sentence steps, measured at 150–250 chars), so clamping is a
// safety net, not a steady-state behavior: any clamp cuts at a word boundary
// with an ellipsis (never mid-word) and is reported to the caller via the
// `clamped` field, which the ask route logs and strips. Structural fields
// (source paths) stay strictly validated.
//
const STORY_CONTEXT_BUDGET = {
    chapters: 4,
    questionChars: 500,
    titleChars: 200,
    narrativeItems: 5,
    narrativeItemChars: 500
};

function clampAtWordBoundary(text, maxChars) {
    const head = text.slice(0, maxChars - 1);
    const cut = head.lastIndexOf(' ');
    const kept = cut > 0 ? head.slice(0, cut) : head;
    return `${kept.trimEnd()}…`;
}

function clampContextField(value, maxChars, field, clamped) {
    const text = String(value || '').trim();
    if(text.length <= maxChars) {
        return text;
    }
    clamped.push(field);
    return clampAtWordBoundary(text, maxChars);
}

const storyContextChapter = z.object({
    question: z.string().default(''),
    title: z.string().default(''),
    narrative: z.array(z.string()).max(20).default([]),
    sourcePaths: z.array(sourcePathSchema).max(8).default([]).transform((paths) => [...new Set(paths)])
}).strict();

const storyContext = z.object({
    chapters: z.array(storyContextChapter).max(100).default([]),
    sourcePaths: z.array(sourcePathSchema).max(12).default([]).transform((paths) => [...new Set(paths)])
}).strict().transform((value) => {
    const clamped = [];
    const recent = value.chapters.slice(-STORY_CONTEXT_BUDGET.chapters);
    const offset = value.chapters.length - recent.length;
    const chapters = recent
        .map((chapter, i) => {
            const at = offset + i;
            return {
                question: clampContextField(chapter.question, STORY_CONTEXT_BUDGET.questionChars, `chapters[${at}].question`, clamped),
                title: clampContextField(chapter.title, STORY_CONTEXT_BUDGET.titleChars, `chapters[${at}].title`, clamped),
                narrative: chapter.narrative
                    .map((item, j) => clampContextField(item, STORY_CONTEXT_BUDGET.narrativeItemChars, `chapters[${at}].narrative[${j}]`, clamped))
                    .filter(Boolean)
                    .slice(0, STORY_CONTEXT_BUDGET.narrativeItems),
                sourcePaths: chapter.sourcePaths
            };
        })
        .filter((chapter) =>
            chapter.question || chapter.title || chapter.narrative.length > 0 || chapter.sourcePaths.length > 0
        );
    return {chapters, sourcePaths: value.sourcePaths, clamped};
});

const storyChapter = z.object({
    question: z.string().trim().max(1000).default(''),
    title: z.string().trim().max(500).default(''),
    traceId: z.union([traceIdSchema, z.literal('')]).default(''),
    narrative: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
    events: z.array(z.record(z.string(), z.unknown())).max(2000).default([])
}).strict();

export const askRequestSchema = z.object({
    question: z.string().trim().min(1).max(4000),
    storyContext: storyContext.default({chapters: [], sourcePaths: []}),
    forceFresh: z.boolean().default(false)
}).strict();

export const storySaveRequestSchema = z.object({
    storyId: storyIdSchema.optional(),
    title: z.string().trim().max(500).optional(),
    createdAt: z.number().finite().positive().optional(),
    chapters: z.array(storyChapter).max(100).default([]),
    sourcePaths: z.array(sourcePathSchema).max(200).default([])
}).strict().transform((value) => {
    const chapters = value.chapters
        .map((chapter) => ({
            ...chapter,
            events: compactReplayEvents(chapter.events).slice(0, 1000)
        }))
        .filter((chapter) => chapter.question || chapter.title || chapter.events.length > 0);
    const sourcePaths = [...new Set(value.sourcePaths)];
    const title = value.title || chapters[0]?.title || chapters[0]?.question || 'Untitled story';
    return {
        storyId: value.storyId,
        title,
        createdAt: value.createdAt,
        chapters,
        sourcePaths
    };
});

export const simulateTraceRequestSchema = z.object({
    condition: z.string().trim().min(1).max(1000)
}).strict();

export const changeBriefRequestSchema = z.object({
    changeIntent: z.string().trim().min(1).max(4000),
    outputFormat: z.enum(['llm_prompt', 'repository_issue', 'ticket']).default('llm_prompt')
}).strict();

export const fixMermaidRequestSchema = z.object({
    mermaid: z.string().min(1).max(20_000),
    diagramType: z.string().trim().max(60).optional(),
    error: z.string().max(2000).optional()
}).strict();

export const listQuerySchema = z.object({
    limit: limitSchema({max: 100, defaultValue: 50})
}).strict();

export const emptyQuerySchema = z.object({}).strict();

export const storyIdParamsSchema = z.object({
    id: storyIdSchema
}).strict();

export const traceIdParamsSchema = z.object({
    id: traceIdSchema
}).strict();

export const teamRepoIdParamsSchema = z.object({
    id: z.string().trim().min(1).max(64)
}).strict();

export const sourceFileTokenParamsSchema = z.object({
    token: base64UrlTokenSchema
}).strict();

// options.ready is a readiness guard (requireRuntime/requireStorage in
// server.js) that resolves to a not-ready Response or null. It runs AFTER
// contract validation on purpose: a malformed request is a 400 regardless of
// runtime state, so readiness never obscures a contract failure.
//
export function withRequest(contract, handler, options = {}) {
    return async (c) => {
        const parsed = await validateRequest(c, contract, options);
        if(!parsed.ok) {
            return parsed.response;
        }
        if(options.ready) {
            const notReady = await options.ready(c);
            if(notReady) {
                return notReady;
            }
        }
        return handler(c, parsed.request);
    };
}

async function validateRequest(c, contract, options) {
    const request = {};
    if(contract.params) {
        const params = readParams(c);
        if(!params.ok) {
            return invalidIssues(c, params.issues, 'params', options);
        }
        const parsed = parsePart(params.data, contract.params);
        if(!parsed.success) {
            return invalidRequest(c, parsed.error, 'params', options);
        }
        request.params = parsed.data;
    }
    if(contract.query) {
        const query = readQuery(c.req.url);
        if(!query.ok) {
            return invalidIssues(c, query.issues, 'query', options);
        }
        const parsed = parsePart(query.data, contract.query);
        if(!parsed.success) {
            return invalidRequest(c, parsed.error, 'query', options);
        }
        request.query = parsed.data;
    }
    if(contract.body) {
        let body;
        if(!isJsonContentType(c.req.header('content-type'))) {
            const log = routeLog(c, options);
            log?.warn?.(options.invalidContentTypeLog || 'unsupported request content type');
            return {
                ok: false,
                response: c.json({error: options.unsupportedMediaTypeError || 'unsupported_media_type'}, 415)
            };
        }
        try {
            body = await c.req.json();
        } catch {
            const log = routeLog(c, options);
            log?.warn?.(options.invalidJsonLog || 'invalid JSON request body');
            return {
                ok: false,
                response: c.json({error: options.invalidJsonError || 'invalid_json'}, 400)
            };
        }
        const parsed = parsePart(body, contract.body);
        if(!parsed.success) {
            return invalidRequest(c, parsed.error, 'body', options);
        }
        request.body = parsed.data;
    }
    return {ok: true, request};
}

function readParams(c) {
    try {
        return {ok: true, data: c.req.param()};
    } catch {
        return {
            ok: false,
            issues: [{
                path: '',
                code: 'custom',
                message: 'Invalid route parameter encoding'
            }]
        };
    }
}

function readQuery(url) {
    const out = {};
    const duplicateKeys = new Set();
    let searchParams;
    try {
        searchParams = new URL(url).searchParams;
    } catch {
        return {
            ok: false,
            issues: [{
                path: '',
                code: 'custom',
                message: 'Invalid request URL'
            }]
        };
    }
    for(const [key, value] of searchParams.entries()) {
        if(Object.hasOwn(out, key)) {
            duplicateKeys.add(key);
            continue;
        }
        out[key] = value;
    }
    if(duplicateKeys.size > 0) {
        return {
            ok: false,
            issues: [...duplicateKeys].map((key) => ({
                path: key,
                code: 'custom',
                message: 'Duplicate query parameter'
            }))
        };
    }
    return {ok: true, data: out};
}

function parsePart(input, schema) {
    const parsed = schema.safeParse(input);
    if(parsed.success) {
        return {success: true, data: parsed.data};
    }
    return {success: false, error: parsed.error};
}

function invalidRequest(c, error, part, options) {
    return invalidIssues(c, formatZodIssues(error), part, options, error);
}

function invalidIssues(c, issues, part, options, error = null) {
    const log = routeLog(c, options);
    log?.warn?.({part, issues}, options.invalidLog || 'request validation failed');
    if(options.invalidRequestResponse) {
        return {
            ok: false,
            response: options.invalidRequestResponse(c, {part, issues, error})
        };
    }
    const errorCode = options.errorCodes?.[part] || options.invalidRequestError || 'invalid_request';
    return {
        ok: false,
        response: c.json({error: errorCode, part, issues}, 400)
    };
}

function routeLog(c, options) {
    return options.routeLogger ? options.routeLogger(c) : c.get?.('logger');
}

function isJsonContentType(value) {
    const type = String(value || '').split(';')[0].trim().toLowerCase();
    return type === 'application/json' || type.endsWith('+json');
}

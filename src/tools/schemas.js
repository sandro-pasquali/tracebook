import {z} from 'zod';
import {invalidInput, sourcePathSchema} from '../util/input-schemas.js';

const TOOL_LINE_MAX = 1_000_000;

export const readFileInputSchema = z.object({
    path: sourcePathSchema.describe('Repo-relative path (as returned by search_codebase or list_dir).'),
    lineStart: z.number().int().min(1).max(TOOL_LINE_MAX).optional().describe('1-based start line. Default 1.'),
    lineEnd: z.number().int().min(1).max(TOOL_LINE_MAX).optional().describe('1-based end line (inclusive). Default: lineStart + 200, or end of file.')
}).strict().refine((input) => input.lineEnd === undefined || input.lineStart === undefined || input.lineEnd >= input.lineStart, {
    path: ['lineEnd'],
    message: 'lineEnd must be greater than or equal to lineStart'
});

export const listDirInputSchema = z.object({
    path: sourcePathSchema.default('.').describe('Repo-relative directory path. Default "." (repo root).')
}).strict();

export const grepInputSchema = z.object({
    pattern: z.string().trim().min(1).max(300).refine((value) => !value.includes('\0'), {message: 'Pattern cannot contain NUL bytes'}).describe('The literal string or simple substring to find. Case-insensitive.'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum number of matches to return. Default 30.')
}).strict();

export const searchInputSchema = z.object({
    query: z.string().trim().min(1).max(1000).describe('Natural-language description of what to find. Examples: "session token validation", "where payment failures are handled", "the entry point that wires routes".'),
    limit: z.number().int().min(1).max(20).optional().describe('How many results to return. Default 6.')
}).strict();

export function parseToolInput(schema, input) {
    const parsed = schema.safeParse(input);
    if(parsed.success) {
        return {ok: true, input: parsed.data};
    }
    return {ok: false, response: invalidInput(parsed.error)};
}

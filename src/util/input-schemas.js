import {Buffer} from 'node:buffer';
import {z} from 'zod';
import {normalizeSourcePath} from './source-path.js';

const UTF8_DECODER = new TextDecoder('utf-8', {fatal: true});

export const STORY_ID_RE = /^story_[a-z0-9]+(?:_[a-z0-9]+)?$/;
export const TRACE_ID_RE = /^trc_[a-z0-9]+_[a-z0-9]+$/;
export const BASE64URL_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

export const storyIdSchema = z.string().trim().regex(STORY_ID_RE, {message: 'Invalid story id'});
export const traceIdSchema = z.string().trim().regex(TRACE_ID_RE, {message: 'Invalid trace id'});

export const base64UrlTokenSchema = z.string()
    .trim()
    .min(1)
    .max(2048)
    .regex(BASE64URL_TOKEN_RE, {message: 'Invalid base64url token'})
    .refine((value) => value.length % 4 !== 1, {message: 'Invalid base64url token length'});

export const sourcePathSchema = z.string()
    .trim()
    .min(1)
    .max(500)
    .transform((value) => normalizeSourcePath(value))
    .pipe(z.string().min(1).max(500).refine(isSafeSourcePath, {message: 'Invalid source path'}));

export function limitSchema({max = 100, defaultValue = 50} = {}) {
    return z.coerce.number().int().min(1).max(max).default(defaultValue);
}

export function decodeBase64UrlUtf8(token) {
    const parsed = base64UrlTokenSchema.safeParse(token);
    if(!parsed.success) {
        return null;
    }
    const value = parsed.data;
    const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
    try {
        return UTF8_DECODER.decode(Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    } catch {
        return null;
    }
}

export function formatZodIssues(error) {
    return (error?.issues || []).map((issue) => ({
        path: issue.path.map(String).join('.'),
        code: issue.code,
        message: issue.message
    }));
}

export function invalidInput(error) {
    return {
        error: 'invalid_input',
        issues: formatZodIssues(error)
    };
}

function isSafeSourcePath(value) {
    if(!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || /[\u0000-\u001F\u007F]/.test(value)) {
        return false;
    }
    return !value.split('/').includes('..');
}

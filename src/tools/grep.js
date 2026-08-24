import {tool} from 'ai';
import {execa} from 'execa';
import {config} from '../util/config.js';
import {createSourceCorpusPolicy} from '../index/source-corpus-policy.js';
import {scanTextFileLines} from '../util/source-read.js';
import {grepInputSchema, parseToolInput} from './schemas.js';

// grep(pattern, limit?) — fixed-string search across indexed files.
// Prefers ripgrep when available; falls back to a pure-Node scan otherwise.
//
export function createGrepTool({root, include, exclude, repoIgnore, ripgrep = tryRipgrep}) {
    if(!root) throw new Error('createGrepTool requires {root}');
    const sourcePolicy = createSourceCorpusPolicy({root, include, exclude, repoIgnore});

    return tool({
        description: 'Search for an exact string or simple pattern across indexed source files. Returns file/line/content matches. Use when you know an identifier or literal string and want to find every occurrence. For semantic concepts, prefer search_codebase.',
        inputSchema: grepInputSchema,
        execute: async (input) => {
            const parsed = parseToolInput(grepInputSchema, input);
            if(!parsed.ok) {
                return parsed.response;
            }
            const {pattern, limit} = parsed.input;
            const max = Math.min(config.tools.grepMaxMatches, limit ?? config.tools.grepMaxMatches);
            const scanMax = max * 5;
            let matches = await ripgrep({pattern, root, max: scanMax, includeGlob: sourcePolicy.includeGlob, excludeGlob: sourcePolicy.excludeGlob});
            if(matches === null) {
                matches = await fallbackScan({pattern, sourcePolicy, max});
            }

            const visiblePaths = await sourcePolicy.filterVisiblePaths(matches.map((m) => m.path));
            const readablePaths = new Set();
            await Promise.all(visiblePaths.map(async (rel) => {
                const physical = await sourcePolicy.resolvePhysicalPath(rel);
                if(physical.ok) {
                    readablePaths.add(rel);
                }
            }));
            const filtered = matches.filter((m) => readablePaths.has(m.path)).slice(0, max);

            return {
                pattern,
                count: filtered.length,
                truncated: filtered.length >= max,
                matches: filtered
            };
        }
    });
}

async function tryRipgrep({pattern, root, max, includeGlob = [], excludeGlob = []}) {
    const args = [
        '--no-config',
        '--no-heading',
        '--with-filename',
        '--line-number',
        '--color=never',
        '--hidden',
        '--smart-case',
        '--max-count', String(max),
        '--max-columns', String(config.tools.grepMaxLineLen + 60),
        '--fixed-strings'
    ];
    for(const glob of includeGlob) {
        args.push('--glob', glob);
    }
    for(const glob of excludeGlob) {
        args.push('--iglob', `!${glob}`);
    }
    args.push('--', pattern, '.');

    let result;
    try {
        result = await execa('rg', args, {
            cwd: root,
            timeout: config.tools.grepTimeoutMs,
            maxBuffer: 1_000_000,
            reject: false,
            stripFinalNewline: true
        });
    } catch {
        return null;
    }

    // ripgrep exits 0 (matches) or 1 (no matches). Anything else — a missing binary
    // (ENOENT, no exitCode), a timeout, or a crash — returns null so the caller falls
    // back to the in-process scan.
    //
    if(result.timedOut || (result.exitCode !== 0 && result.exitCode !== 1)) {
        return null;
    }

    const out = [];
    for(const line of String(result.stdout || '').split('\n')) {
        if(out.length >= max) break;
        const parsed = parseRgLine(line);
        if(parsed) out.push(parsed);
    }
    return out;
}

function parseRgLine(line) {
    if(!line) return null;
    const a = line.indexOf(':');
    if(a < 0) return null;
    const b = line.indexOf(':', a + 1);
    if(b < 0) return null;
    const file = line.slice(0, a).replace(/^\.\//, '');
    const lineNo = Number(line.slice(a + 1, b));
    if(!Number.isFinite(lineNo)) return null;
    let content = line.slice(b + 1);
    if(content.length > config.tools.grepMaxLineLen) {
        content = content.slice(0, config.tools.grepMaxLineLen) + '…';
    }
    return {path: file, line: lineNo, content};
}

async function fallbackScan({pattern, sourcePolicy, max}) {
    const needle = pattern.toLowerCase();
    const visible = await sourcePolicy.listIndexableFiles();
    const matches = [];
    for(const rel of visible.sort()) {
        if(matches.length >= max) break;
        try {
            const physical = await sourcePolicy.resolvePhysicalPath(rel);
            if(!physical.ok) {
                continue;
            }
            await scanTextFileLines(physical.path, {
                onLine(line, lineNumber) {
                    if(matches.length >= max) {
                        return false;
                    }
                    if(line.toLowerCase().includes(needle)) {
                        let content = line;
                        if(content.length > config.tools.grepMaxLineLen) {
                            content = content.slice(0, config.tools.grepMaxLineLen) + '…';
                        }
                        matches.push({path: rel, line: lineNumber, content});
                    }
                    return matches.length < max;
                }
            });
        } catch {
            continue;
        }
    }
    return matches;
}

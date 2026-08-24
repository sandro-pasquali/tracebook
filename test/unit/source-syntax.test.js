import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeSourceLines, extractSourceGraph, sourceSupportStatus} from '../../src/util/source-syntax.js';

test('source syntax is fail-closed for unsupported file types', async () => {
    const analysis = await analyzeSourceLines(['# Notes', 'plain text'], {path: 'README.md'});
    const graph = await extractSourceGraph('# Notes\nplain text\n', {path: 'README.md'});

    assert.equal(sourceSupportStatus({path: 'README.md'}).supported, false);
    assert.equal(analysis.engine, 'unsupported');
    assert.equal(analysis.supported, false);
    assert.ok(analysis.lines.every((line) => line.substantive === false));
    assert.deepEqual(graph, []);
});

test('source syntax requires a tree-sitter-backed integration for supported source', async () => {
    const analysis = await analyzeSourceLines([
        'def answer():',
        '    return 42',
    ], {path: 'app.py'});

    assert.equal(sourceSupportStatus({path: 'app.py'}).supported, true);
    assert.equal(analysis.engine, 'tree-sitter');
    assert.equal(analysis.supported, true);
    assert.equal(analysis.grammar, 'python');
    assert.equal(analysis.lines[0].substantive, true);
});

test('source syntax exposes tree-sitter definition ranges for supported languages', async () => {
    const analysis = await analyzeSourceLines([
        'public class CheckoutService {',
        '    public Response checkout(Request request) {',
        '        return Response.ok();',
        '    }',
        '}',
    ], {path: 'CheckoutService.java'});

    assert.equal(analysis.engine, 'tree-sitter');
    assert.ok(analysis.symbols.some((symbol) =>
        symbol.name === 'checkout' &&
        symbol.lineStart === 2 &&
        symbol.lineEnd === 4
    ));
});

test('source graph facts come from the resolved language integration', async () => {
    const jsFacts = await extractSourceGraph([
        "import {serve} from 'server-lib';",
        "app.get('/health', () => ({ok: true}));",
    ].join('\n'), {path: 'server.js'});
    const pyFacts = await extractSourceGraph([
        'def answer():',
        '    return 42',
    ].join('\n'), {path: 'worker.py'});

    assert.ok(jsFacts.some((fact) => fact.kind === 'route' && fact.target === '/health'));
    assert.ok(jsFacts.some((fact) => fact.kind === 'import' && /server-lib/.test(fact.target)));
    assert.ok(pyFacts.some((fact) => fact.kind === 'definition' && fact.name === 'answer'));
    assert.ok([...jsFacts, ...pyFacts].every((fact) => fact.syntax?.engine !== 'scanner'));
});

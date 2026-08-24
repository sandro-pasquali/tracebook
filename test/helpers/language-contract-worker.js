import {readFileSync} from 'node:fs';
import {analyzeSourceLines, extractSourceGraph} from '../../src/util/source-syntax.js';
import {resolveLanguageIntegration} from '../../src/language-integrations/registry.js';

const contract = JSON.parse(readFileSync(0, 'utf8'));
const context = {path: contract.path};
const source = String(contract.source || '');
const lines = source.split(/\r?\n/);
const analysis = await analyzeSourceLines(lines, context);
const facts = await extractSourceGraph(source, context);
const integration = resolveLanguageIntegration(context);
const annotationLine = contract.annotationLine || contract.callLine;
const annotationLineNumber = annotationLine ? lineNumberForAnnotation(lines, annotationLine) : 1;
const annotation = annotationLine && integration
    ? integration.annotateLine({
        line: annotationLineNumber > 0 ? lines[annotationLineNumber - 1] : annotationLine,
        lines,
        lineNumber: annotationLineNumber > 0 ? annotationLineNumber : 1,
        context
    })
    : null;

process.stdout.write(JSON.stringify({
    analysis: {
        engine: analysis.engine,
        supported: analysis.supported,
        grammar: analysis.grammar,
        hasError: analysis.hasError,
        symbols: analysis.symbols || []
    },
    facts: facts.map((fact) => ({
        kind: fact.kind,
        name: fact.name,
        target: fact.target,
        lineStart: fact.lineStart,
        lineEnd: fact.lineEnd,
        engine: fact.syntax?.engine || ''
    })),
    annotation
}));

function lineNumberForAnnotation(lines, expectedLine) {
    const expected = String(expectedLine || '').trim();
    const index = lines.findIndex((line) => String(line || '').trim() === expected);
    return index >= 0 ? index + 1 : 0;
}

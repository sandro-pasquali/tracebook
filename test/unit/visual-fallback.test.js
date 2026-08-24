import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildMermaidRepairPrompt,
    buildMermaidRepairSystemPrompt,
    buildVisualRetryInstructions
} from '../../src/planner/visual-fallback.js';

test('visual retry instructions require balanced Mermaid blocks', () => {
    const instructions = buildVisualRetryInstructions({
        planItem: {id: 'api-route-structure', kind: 'sequence_diagram'},
        reason: 'mermaid_syntax: 1 unclosed block',
        failedPartial: null
    });

    assert.match(instructions, /must begin exactly with `sequenceDiagram`/v);
    assert.match(instructions, /must be closed with a matching `end`/v);
    assert.match(instructions, /Do not use `else`, `and`, or `option`/v);
    assert.match(instructions, /yield, return, and await as messages or Notes/v);
});

test('lintMermaidSource accepts balanced block structures', async () => {
    const {lintMermaidSource} = await import('../../src/planner/visual-fallback.js');
    const balanced = [
        'sequenceDiagram',
        '    participant C as Client',
        '    participant S as Server',
        '    C->>S: DELETE /api/stories/:id',
        '    alt Story found',
        '        S->>C: 200 OK',
        '    else Story not found',
        '        S->>C: 404 Not Found',
        '    end'
    ].join('\n');
    assert.equal(lintMermaidSource(balanced), '');

    const subgraphs = [
        'flowchart TD',
        '    subgraph Server',
        '        A --> B',
        '    end',
        '    B --> C[end of stream handling]'
    ].join('\n');
    assert.equal(lintMermaidSource(subgraphs), '');
});

test('lintMermaidSource flags the truncated-alt diagram that shipped broken', async () => {
    const {lintMermaidSource} = await import('../../src/planner/visual-fallback.js');
    // Verbatim failure from trc_mqb9v597: the model stopped before `end`.
    //
    const truncated = [
        'sequenceDiagram',
        '    participant C as Client',
        '    participant A as API Server',
        '    C->>A: HTTP Request (GET/POST/DELETE)',
        '    alt Not Ready',
        '        A-->>C: 503 Service Unavailable',
        '    else Ready',
        '        A-->>C: HTTP Response (JSON/SSE)'
    ].join('\n');
    assert.match(lintMermaidSource(truncated), /unclosed block/);
});

test('lintMermaidSource flags structural errors without over-matching labels', async () => {
    const {lintMermaidSource} = await import('../../src/planner/visual-fallback.js');
    assert.match(lintMermaidSource(''), /empty/);
    assert.match(lintMermaidSource('here is a diagram:\nsequenceDiagram'), /not a known diagram header/);
    assert.match(lintMermaidSource('sequenceDiagram\n    end'), /"end" without a matching block opener/);
    assert.match(lintMermaidSource('sequenceDiagram\n    else Ready\n    A->>B: x'), /"else" outside of any block/);
    assert.equal(lintMermaidSource('sequenceDiagram\n    A->>B: the end of the request'), '');
});

test('lintMermaidSource flags the truncated flowchart that shipped broken in a story chapter', async () => {
    const {lintMermaidSource} = await import('../../src/planner/visual-fallback.js');
    // Verbatim failure from trc_mroylbfj: an unquoted node label wrapped onto
    // the next line, and the output degenerated into an unclosed node at the
    // tail. Both leave a line with more openers than closers.
    //
    const truncated = [
        'flowchart TD',
        '    A[File Content] --> B{Tree-sitter',
        '      supported?}',
        '    B -->|Yes| C[Run syntaxChunksForText]',
        '    C --> E[syntaxChunks length > 0?]',
        '    H --> J',
        '    J[K['
    ].join('\n');
    assert.match(lintMermaidSource(truncated), /unclosed "\{"/v);

    const tailOnly = [
        'flowchart TD',
        '    A[File Content] --> B[Chunks]',
        '    B --> J',
        '    J[K['
    ].join('\n');
    assert.match(lintMermaidSource(tailOnly), /unclosed "\["/v);
});

test('lintMermaidSource accepts legal flowchart shapes, quotes, pipes, and comments', async () => {
    const {lintMermaidSource} = await import('../../src/planner/visual-fallback.js');
    const legal = [
        'flowchart TD',
        '    %% a comment with an unclosed [ bracket',
        '    A["arr[0] access"] --> B[ok]',
        '    G>asymmetric] --> H[done]',
        '    B -->|Yes: [maybe]| C[ok]',
        '    E{{hexagon}} --> D[(database)]',
        '    S(["stadium label"]) --> F[/parallelogram/]'
    ].join('\n');
    assert.equal(lintMermaidSource(legal), '');

    // Non-flowchart diagrams keep free-text brackets: the delimiter check is
    // flowchart-only because brackets are structural only there.
    //
    const sequenceWithBrackets = [
        'sequenceDiagram',
        '    participant A',
        '    Note over A: array[0] access [detail'
    ].join('\n');
    assert.equal(lintMermaidSource(sequenceWithBrackets), '');

    const graphTruncated = [
        'graph LR',
        '    A[start'
    ].join('\n');
    assert.match(lintMermaidSource(graphTruncated), /unclosed "\["/v);
});

test('lintMermaidSource rejects the standalone yield statement from the saved SSE story', async () => {
    const {lintMermaidSource} = await import('../../src/planner/visual-fallback.js');
    const source = `sequenceDiagram
    participant Client
    participant Server as Backend (/api/ask)

    Client->>Server: POST /api/ask<br/>JSON body + headers
    activate Server
    Server-->>Client: HTTP 200 OK<br/>Content-Type: text/event-stream
    activate Client
    loop SSE events
        Server->>Client: data:<event type>: <payload>
        Client->>Client: parseFrame()
        yield {event, data}
    end
    Server--xClient: stream end / abort`;

    assert.match(lintMermaidSource(source), /standalone code statement "yield \{event, data\}"/v);
});

test('healMermaidSource drops a stray "end" so the figure clears the lint', async () => {
    const {healMermaidSource, lintMermaidSource} = await import('../../src/planner/visual-fallback.js');
    // Failure class from the "Hono bootstrap" mermaid_figure: the model closed a
    // block that was never opened. lintMermaidSource rejects it; heal removes the
    // stray closer so the same source ships instead of failing closed.
    //
    const stray = [
        'sequenceDiagram',
        '    participant B as Bootstrap',
        '    participant H as Hono',
        '    B->>H: new Hono()',
        '    B->>H: app.use(logger)',
        '    B->>H: app.route(/api, routes)',
        '    end'
    ].join('\n');
    assert.match(lintMermaidSource(stray), /"end" without a matching block opener/v);

    const healed = healMermaidSource(stray);
    assert.equal(lintMermaidSource(healed), '');
    assert.doesNotMatch(healed, /^\s*end\s*$/mv);
    assert.match(healed, /B->>H: new Hono\(\)/v);
});

test('healMermaidSource keeps matched blocks and leaves valid source untouched', async () => {
    const {healMermaidSource} = await import('../../src/planner/visual-fallback.js');
    const balanced = [
        'sequenceDiagram',
        '    participant C as Client',
        '    participant S as Server',
        '    C->>S: GET /',
        '    alt found',
        '        S->>C: 200',
        '    else missing',
        '        S->>C: 404',
        '    end'
    ].join('\n');
    // Nothing to fix: returns the exact input, preserving newlines.
    //
    assert.equal(healMermaidSource(balanced), balanced);
});

test('healMermaidSource removes only the unmatched "end", keeping matched ones', async () => {
    const {healMermaidSource, lintMermaidSource} = await import('../../src/planner/visual-fallback.js');
    const mixed = [
        'sequenceDiagram',
        '    participant C',
        '    participant S',
        '    loop poll',
        '        C->>S: ping',
        '        S->>C: pong',
        '    end',
        '    C->>S: done',
        '    end'
    ].join('\n');
    const healed = healMermaidSource(mixed);
    assert.equal(lintMermaidSource(healed), '');
    // The loop's matching end survives; the trailing stray end is gone.
    //
    assert.equal((healed.match(/^\s*end\s*$/gmv) || []).length, 1);
});

test('buildMermaidRepairPrompt carries the source, error, and the shared safety rules', () => {
    const broken = 'sequenceDiagram\n    C->>S: hi\n    alt Ready';
    const prompt = buildMermaidRepairPrompt({
        source: broken,
        diagramType: 'sequenceDiagram',
        error: 'Parse error on line 3: got EOF'
    });

    assert.match(prompt, /Diagram type: sequenceDiagram/v);
    assert.match(prompt, /Parse error on line 3: got EOF/v);
    assert.match(prompt, /must be closed with a matching `end`/v);
    assert.match(prompt, /Node labels must stay on one line/v);
    // The broken source is embedded verbatim for the model to fix.
    //
    assert.ok(prompt.includes(broken));
});

test('buildMermaidRepairPrompt omits optional lines when diagramType and error are absent', () => {
    const prompt = buildMermaidRepairPrompt({source: 'flowchart TD\n    A --> B'});
    assert.doesNotMatch(prompt, /Diagram type:/v);
    assert.doesNotMatch(prompt, /rejected it with:/v);
    assert.match(prompt, /Broken Mermaid source:/v);
});

test('buildMermaidRepairSystemPrompt instructs mermaid-only, structure-preserving output', () => {
    const system = buildMermaidRepairSystemPrompt();
    assert.match(system, /repair broken Mermaid/vi);
    assert.match(system, /Preserve the original diagram type/v);
    assert.match(system, /no markdown fences/v);
});

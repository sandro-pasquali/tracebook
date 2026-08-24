import test from 'node:test';
import assert from 'node:assert/strict';

test('flowchart repair normalizes multiline labels and sequence-style notes', async () => {
    installCustomElementShim();
    const {__repairMermaidForTest} = await import(`../../public/js/components/sequence-diagram.js?repair=${Date.now()}`);
    const source = `flowchart LR
    Client([Client Browser])
    ServerMiddleware[Server Middleware
(app.use('*', async (c, next)))]
    RouteSSE[/SSE Event Route
(e.g. /api/events)]
    EventStream((Event Stream Open))
    ServerPush[Server pushes updates
via SSE protocol]

    Client -->|HTTP GET /api/events| ServerMiddleware
    ServerMiddleware --> RouteSSE
    RouteSSE -->|Establishes SSE connection| EventStream
    EventStream --> ServerPush
    ServerPush --> Client

    Note right of RouteSSE: Handles
SSE request and keeps
connection alive
    Note right of ServerPush: Push new data as
server events`;

    const repaired = __repairMermaidForTest(source);

    assert.notEqual(repaired, source);
    assert.doesNotMatch(repaired, /Note right of/v);
    assert.ok(repaired.includes('ServerMiddleware[Server Middleware app.use async c next]'));
    assert.ok(repaired.includes('RouteSSE -.-> AutoNote1[Handles SSE request and keeps connection alive]'));
    assert.ok(repaired.includes('ServerPush -.-> AutoNote2[Push new data as server events]'));
});

test('flowchart repair drops generated link styles and sanitizes labels', async () => {
    installCustomElementShim();
    const {__repairMermaidForTest} = await import(`../../public/js/components/sequence-diagram.js?link-style=${Date.now()}`);
    const source = `flowchart LR
    Client([Client Browser])
    ServerMiddleware[Server Middleware (app.use('*', async (c, next)))]
    RouteSSE[/SSE Event Route (e.g. /api/events)/]
    EventStream((Event Stream Open))
    ServerPush[Server pushes updates via SSE protocol]

    Client -->|HTTP GET /api/events| ServerMiddleware
    ServerMiddleware --> RouteSSE
    RouteSSE -->|Establishes SSE connection| EventStream
    EventStream --> ServerPush
    ServerPush --> Client

    linkStyle 5 stroke-dasharray: 5 5;`;

    const repaired = __repairMermaidForTest(source);

    assert.doesNotMatch(repaired, /linkStyle/v);
    assert.ok(repaired.includes('ServerMiddleware[Server Middleware app.use async c next]'));
    assert.ok(repaired.includes('RouteSSE[SSE Event Route e.g. api events]'));
    assert.ok(repaired.includes('Client -->|HTTP GET api events| ServerMiddleware'));
});

test('flowchart repair normalizes scoped package labels from saved diagrams', async () => {
    installCustomElementShim();
    const {__firstRenderableMermaidForTest, __repairMermaidForTest} = await import(`../../public/js/components/sequence-diagram.js?scoped-package=${Date.now()}`);
    const source = `flowchart TD
    A[Vite Configuration] --> B{Command/Mode}
    B -->|serve| C[Development Server]
    B -->|client| D[Client Build]
    B -->|build| E[Production Build]
    C --> F[@hono/vite-dev-server]
    F --> G[Hono Server Entry]
    E --> I[@hono/vite-build]
    I --> J[SSR Bundle]
    style A fill:#f9f,stroke:#333`;

    const repaired = __repairMermaidForTest(source);

    assert.doesNotMatch(repaired, /@hono/v);
    assert.doesNotMatch(repaired, /^ {4}style /m);
    assert.ok(repaired.includes('F[hono vite dev server]'));
    assert.ok(repaired.includes('I[hono vite build]'));

    const mermaid = {
        async parse(candidate) {
            return candidate.includes('@hono') || candidate.includes('style A') ? false : {diagramType: 'flowchart-v2'};
        },
        async render(_id, candidate) {
            return candidate.includes('@hono') || candidate.includes('style A') ? null : {svg: '<svg role="img"></svg>'};
        },
    };

    const rendered = await __firstRenderableMermaidForTest(mermaid, source, () => 'mmd_scoped_package');

    assert.equal(rendered.svg, '<svg role="img"></svg>');
    assert.equal(rendered.source, repaired);
});

test('mermaid rendering falls through to repaired candidates', async () => {
    installCustomElementShim();
    const {__firstRenderableMermaidForTest} = await import(`../../public/js/components/sequence-diagram.js?render-fallback=${Date.now()}`);
    const source = `flowchart LR
    Client([Client Browser])
    ServerMiddleware[Server Middleware]
    Client --> ServerMiddleware
    linkStyle 1 stroke-dasharray: 5 5;`;
    const renderedSources = [];
    const mermaid = {
        async parse() {
            return {diagramType: 'flowchart-v2'};
        },
        async render(_id, candidate) {
            renderedSources.push(candidate);
            if(candidate.includes('linkStyle')) {
                throw new Error('bad link style');
            }
            return {svg: '<svg role="img"></svg>'};
        },
    };

    const rendered = await __firstRenderableMermaidForTest(mermaid, source, () => 'mmd_test');

    assert.equal(rendered.svg, '<svg role="img"></svg>');
    assert.equal(renderedSources.length, 2);
    assert.match(renderedSources[0], /linkStyle/v);
    assert.doesNotMatch(rendered.source, /linkStyle/v);
});

test('sequence diagram repair normalizes overlong response arrows', async () => {
    installCustomElementShim();
    const {__firstRenderableMermaidForTest, __repairMermaidForTest} = await import(`../../public/js/components/sequence-diagram.js?sequence-arrow=${Date.now()}`);
    const source = `sequenceDiagram
    participant Client
    participant Server

    Client->>Server: POST request with JSON body
    Server-->>>Client: Sends streamed event payload
    Note left of Client: Receives and decodes streamed events`;
    const repaired = __repairMermaidForTest(source);

    assert.doesNotMatch(repaired, /-->>>/v);
    assert.match(repaired, /Server-->>Client: Sends streamed event/v);

    const mermaid = {
        async parse(candidate) {
            return candidate.includes('-->>>') ? false : {diagramType: 'sequence'};
        },
        async render(_id, candidate) {
            return candidate.includes('-->>>') ? null : {svg: '<svg role="img"></svg>'};
        },
    };

    const rendered = await __firstRenderableMermaidForTest(mermaid, source, () => 'mmd_sequence_arrow');

    assert.equal(rendered.svg, '<svg role="img"></svg>');
    assert.doesNotMatch(rendered.source, /-->>>/v);
});

test('sequence diagram repair converts the standalone yield from the saved SSE story into a parseable note', async () => {
    installCustomElementShim();
    const {default: mermaid} = await import('mermaid');
    const {__repairMermaidForTest} = await import(`../../public/js/components/sequence-diagram.js?sse-yield=${Date.now()}`);
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

    assert.equal(await mermaid.parse(source, {suppressErrors: true}), false);

    const repaired = __repairMermaidForTest(source);

    assert.match(repaired, /Note right of Client: yield \{event, data\}/v);
    assert.notEqual(await mermaid.parse(repaired, {suppressErrors: true}), false);
});

test('theme reinit refreshes mounted mermaid diagrams', async (t) => {
    installCustomElementShim();
    const previousDocument = globalThis.document;
    let refreshes = 0;
    globalThis.document = {
        querySelectorAll(selector) {
            assert.equal(selector, 'tool-sequence-diagram');
            return [
                {
                    refreshMermaidTheme() {
                        refreshes++;
                    }
                },
                {}
            ];
        }
    };
    t.after(() => {
        if(previousDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = previousDocument;
        }
    });

    const {reinitMermaidTheme} = await import(`../../public/js/components/sequence-diagram.js?theme-refresh=${Date.now()}`);

    reinitMermaidTheme();

    assert.equal(refreshes, 1);
});

test('mermaid repair drops a stray end so a saved figure self-heals on replay', async () => {
    installCustomElementShim();
    const {__repairMermaidForTest} = await import(`../../public/js/components/sequence-diagram.js?stray-end=${Date.now()}`);
    const source = `sequenceDiagram
    participant B as Bootstrap
    participant H as Hono
    B->>H: new Hono()
    B->>H: app.use(logger)
    end`;

    const repaired = __repairMermaidForTest(source);

    assert.doesNotMatch(repaired, /^\s*end\s*$/mv);
    assert.ok(repaired.includes('B->>H: new Hono()'));
});

test('mermaid repair keeps the matched end of an alt block', async () => {
    installCustomElementShim();
    const {__repairMermaidForTest} = await import(`../../public/js/components/sequence-diagram.js?matched-end=${Date.now()}`);
    const source = `sequenceDiagram
    participant C as Client
    participant S as Server
    C->>S: GET /
    alt found
        S->>C: 200
    else missing
        S->>C: 404
    end`;

    const repaired = __repairMermaidForTest(source);

    assert.match(repaired, /^\s*end\s*$/mv);
});

function installCustomElementShim() {
    globalThis.HTMLElement ??= class HTMLElementShim {
        constructor() {
            this.dataset = {};
        }
    };
    globalThis.customElements ??= {
        define() {
            return undefined;
        },
    };
}

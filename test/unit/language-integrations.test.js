import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveLanguageIntegration} from '../../src/language-integrations/registry.js';
import {extractSourceGraph} from '../../src/util/source-syntax.js';

test('language integrations expose language-owned annotations for representative source lines', () => {
    const samples = [
        {path: 'Main.java', line: 'public Response checkout(Request request) {'},
        {path: 'server.go', line: 'func checkout(ctx context.Context) error {'},
        {path: 'script.sh', line: 'deploy_service() {'},
        {path: 'native.c', line: 'static int checkout_order(int id) {'},
        {path: 'native.cpp', line: 'class CheckoutService {'},
        {path: 'Handler.cs', line: 'public async Task<Response> Checkout(Request request) {'},
        {path: 'Handler.kt', line: 'suspend fun checkout(request: Request) {'},
        {path: 'handler.php', line: 'function checkout($request) {'},
        {path: 'view.lua', line: 'local function render_view(model)'},
        {path: 'checkout.ex', line: 'defmodule Checkout.Flow do'},
        {path: 'main.zig', line: 'pub fn checkout(order: Order) !void {'},
        {path: 'Escrow.sol', line: 'contract Escrow {'},
        {path: 'package.json', line: '"scripts": {'},
        {path: 'config.yaml', line: 'server: checkout'},
        {path: 'Cargo.toml', line: 'name = "checkout"'},
    ];

    for(const sample of samples) {
        const integration = resolveLanguageIntegration({path: sample.path});
        assert.ok(integration, sample.path);
        const annotation = integration.annotateLine({
            line: sample.line,
            lines: [sample.line],
            lineNumber: 1,
            context: {path: sample.path}
        });

        assert.equal(annotation.worthy, true, sample.path);
        assert.ok(annotation.role || annotation.facts.length > 0 || annotation.note, sample.path);
    }
});

test('language integrations identify named symbols outside JavaScript', () => {
    const cases = [
        {path: 'Main.java', line: 'public Response checkout(Request request) {', name: 'checkout'},
        {path: 'server.go', line: 'func checkout(ctx context.Context) error {', name: 'checkout'},
        {path: 'Escrow.sol', line: 'contract Escrow {', name: 'Escrow'},
    ];

    for(const item of cases) {
        const integration = resolveLanguageIntegration({path: item.path});
        assert.equal(integration.symbolAtLine({line: item.line})?.name, item.name);
    }
});

test('language integrations expose cross-language HTTP route and configuration facts', async () => {
    const cases = [
        {
            path: 'api.py',
            source: '@app.get("/orders")\ndef list_orders():\n    return os.environ.get("DATABASE_URL")\n',
            route: 'GET /orders',
            config: 'DATABASE_URL',
        },
        {
            path: 'server.go',
            source: 'package main\n\nfunc main() {\n    http.HandleFunc("/health", health)\n    token := os.Getenv("API_TOKEN")\n}\n',
            route: 'HANDLE /health',
            config: 'API_TOKEN',
        },
        {
            path: 'CheckoutController.java',
            source: 'class CheckoutController {\n  @PostMapping("/checkout")\n  String checkout() { return System.getenv("API_TOKEN"); }\n}\n',
            route: 'POST /checkout',
            config: 'API_TOKEN',
        },
        {
            path: 'Routes.kt',
            source: 'class Routes {\n  @GetMapping("/orders")\n  fun orders() = System.getenv("API_TOKEN")\n}\n',
            route: 'GET /orders',
            config: 'API_TOKEN',
        },
        {
            path: 'Program.cs',
            source: 'var secret = Environment.GetEnvironmentVariable("API_TOKEN");\napp.MapGet("/health", () => "ok");\n',
            route: 'GET /health',
            config: 'API_TOKEN',
        },
        {
            path: 'routes.php',
            source: '<?php\nRoute::post("/checkout", [CheckoutController::class, "store"]);\n$token = getenv("API_TOKEN");\n',
            route: 'POST /checkout',
            config: 'API_TOKEN',
        },
        {
            path: 'main.rs',
            source: 'use std::env;\n#[get("/health")]\nfn health() { let token = env::var("API_TOKEN"); }\n',
            route: 'GET /health',
            config: 'API_TOKEN',
        },
        {
            path: 'router.ex',
            source: 'defmodule App.Router do\n  get "/health", HealthController, :show\n  def token, do: System.get_env("API_TOKEN")\nend\n',
            route: 'GET /health',
            config: 'API_TOKEN',
        },
    ];

    for(const item of cases) {
        const facts = await extractSourceGraph(item.source, {path: item.path});
        assert.ok(facts.some((fact) => fact.kind === 'route' && fact.name === item.route), `${item.path} route ${JSON.stringify(facts)}`);
        assert.ok(facts.some((fact) => fact.kind === 'configuration' && fact.name === item.config), `${item.path} config ${JSON.stringify(facts)}`);
    }
});

test('language integrations expose storage and executable entrypoint facts', async () => {
    const cases = [
        {
            path: 'cli.js',
            source: 'async function main() {\n    await db.query("select 1");\n}\nif(require.main === module) {\n    main();\n}\n',
            facts: [
                {kind: 'storage', name: 'db.query'},
                {kind: 'entrypoint', name: 'main module'},
            ],
        },
        {
            path: 'worker.py',
            source: 'if __name__ == "__main__":\n    db.execute("select 1")\n',
            facts: [
                {kind: 'storage', name: 'db.execute'},
                {kind: 'entrypoint', name: 'python main guard'},
            ],
        },
        {
            path: 'main.go',
            source: 'package main\nfunc main() {\n    db.Query("select 1")\n}\n',
            facts: [
                {kind: 'storage', name: 'db.Query'},
                {kind: 'entrypoint', name: 'main'},
            ],
        },
        {
            path: 'Main.java',
            source: 'class Main {\n  public static void main(String[] args) {\n    repository.save(order);\n  }\n}\n',
            facts: [
                {kind: 'storage', name: 'repository.save'},
                {kind: 'entrypoint', name: 'main'},
            ],
        },
        {
            path: 'Program.cs',
            source: 'class Program {\n  static void Main(string[] args) {\n    db.SaveChanges();\n  }\n}\n',
            facts: [
                {kind: 'storage', name: 'db.SaveChanges'},
                {kind: 'entrypoint', name: 'Main'},
            ],
        },
        {
            path: 'main.rs',
            source: 'fn main() {\n    sqlx::query!("select 1");\n}\n',
            facts: [
                {kind: 'storage', name: 'sqlx::query!'},
                {kind: 'entrypoint', name: 'main'},
            ],
        },
        {
            path: 'repo.ex',
            source: 'defmodule App.Save do\n  def run(order), do: Repo.insert(order)\nend\n',
            facts: [
                {kind: 'storage', name: 'Repo.insert'},
            ],
        },
    ];

    for(const item of cases) {
        const facts = await extractSourceGraph(item.source, {path: item.path});
        for(const expected of item.facts) {
            assert.ok(
                facts.some((fact) => fact.kind === expected.kind && fact.name === expected.name),
                `${item.path} missing ${JSON.stringify(expected)} in ${JSON.stringify(facts)}`
            );
        }
    }
});

test('javascript response notes fire on sends, not on client-side response parsing', () => {
    const integration = resolveLanguageIntegration({path: 'app.js'});
    const serverSend = integration.annotateLine({
        line: 'return c.json({error: "not_found"}, 404);',
        lines: ['return c.json({error: "not_found"}, 404);'],
        lineNumber: 1,
        context: {},
    });
    assert.match(serverSend.note, /ends here for this branch/v);

    const clientParse = integration.annotateLine({
        line: 'payload = await res.json();',
        lines: ['payload = await res.json();'],
        lineNumber: 1,
        context: {caption: 'Frontend UI handling of story deletion requests'},
    });
    assert.doesNotMatch(String(clientParse.note || ''), /ends here for this branch/v);
});

test('javascript cancellation notes require a cancellation call, not identifier names', () => {
    const integration = resolveLanguageIntegration({path: 'app.js'});
    const domLines = [
        "const cancel = document.createElement('button');",
        "cancel.addEventListener('click', (ev) => {",
        'actions.append(cancel, confirm);',
    ];
    for(const line of domLines) {
        const annotation = integration.annotateLine({line, lines: [line], lineNumber: 1, context: {}});
        assert.doesNotMatch(String(annotation.note || ''), /cancellation/v, line);
    }

    const realCancellation = integration.annotateLine({
        line: 'controller.abort();',
        lines: ['controller.abort();'],
        lineNumber: 1,
        context: {},
    });
    assert.ok(realCancellation.note, 'a real abort call still gets a note');
});

test('javascript symbol notes never name control-flow keywords', () => {
    const integration = resolveLanguageIntegration({path: 'app.js'});
    const annotation = integration.annotateLine({
        line: 'for (const event of cached.events) {',
        lines: ['for (const event of cached.events) {'],
        lineNumber: 1,
        context: {},
    });
    assert.doesNotMatch(String(annotation.note || ''), /Introduces for/v);
});

test('html markup notes teach interactive elements and skip structural containers', () => {
    const integration = resolveLanguageIntegration({path: 'index.html'});
    const container = integration.annotateLine({
        line: '<div id="ask-tooltip" class="ask-tooltip">',
        lines: ['<div id="ask-tooltip" class="ask-tooltip">'],
        lineNumber: 1,
        context: {},
    });
    assert.equal(container.note, '');

    const button = integration.annotateLine({
        line: '<button id="new-story" class="primary">New story</button>',
        lines: ['<button id="new-story" class="primary">New story</button>'],
        lineNumber: 1,
        context: {},
    });
    assert.match(button.note, /button#new-story/v);
});

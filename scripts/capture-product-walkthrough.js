import {Buffer} from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import fs from 'fs-extra';
import {chromium} from 'playwright';
import {startTestServer} from '../test/browser/helpers/server.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const outputRoot = path.join(projectRoot, 'docs', 'images', 'product-walkthrough');
const mainQuestion = 'What happens when someone asks Tracebook a question about a codebase?';
const followUpQuestion = 'How does Tracebook keep later chapters connected to the first?';
const changeIntent = 'Show which files were searched and flag coverage gaps before the story is generated.';
const screenshotNames = [
    '01-admin-setup.png',
    '02-repository-picker.png',
    '03-indexing-progress.png',
    '04-ask-a-question.png',
    '05-source-grounded-story.png',
    '06-sequence-diagram.png',
    '07-annotated-code.png',
    '08-evidence-callout.png',
    '09-source-view.png',
    '10-change-brief-input.png',
    '11-change-brief.png',
    '12-follow-up-chapters.png',
    '13-story-library.png'
];

const repositories = [
    {
        id: 'tracebook',
        name: 'Tracebook',
        path: '/workspace/tracebook',
        description: 'Source-grounded product stories for the Tracebook codebase.'
    },
    {
        id: 'acme-commerce',
        name: 'Acme Commerce',
        path: '/workspace/acme-commerce',
        description: 'Checkout, payments, inventory, and fulfillment services.'
    }
];

const teamConfig = {
    configPath: '/workspace/.tracebook/tracebook.config.json',
    exists: true,
    repos: repositories,
    defaultRepoId: 'tracebook',
    credentials: {
        openaiApiKey: false,
        anthropicApiKey: false,
        googleApiKey: false,
        mistralApiKey: false
    },
    credentialFingerprints: {
        openaiApiKey: '',
        anthropicApiKey: '',
        googleApiKey: '',
        mistralApiKey: ''
    },
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    tpmBudget: 100_000,
    logging: {level: 'info', pretty: true},
    models: {
        exploration: 'ollama/qwen3-coder-next:latest',
        synthesis: 'ollama/qwen3-coder-next:latest',
        outline: 'ollama/qwen3-coder-next:latest',
        hyde: 'ollama/qwen3-coder-next:latest',
        annotation: 'ollama/qwen3-coder-next:latest',
        evalFast: 'ollama/qwen3:4b'
    },
    embeddings: {
        model: 'Xenova/all-MiniLM-L6-v2',
        dims: 384,
        batch: 32,
        numThreads: 0,
        dtype: 'fp32',
        queryPrefix: '',
        docPrefix: '',
        cacheCap: 512
    },
    dependencyDocs: {enabled: true},
    enrichment: {
        enabled: true,
        model: 'ollama/qwen3-coder-next:latest',
        maxOutputTokens: 220,
        maxInputChars: 12_000,
        timeoutMs: 8000,
        concurrency: 4
    },
    rerank: {
        enabled: true,
        model: 'Xenova/bge-reranker-base',
        dtype: 'q8',
        candidates: 20,
        numThreads: 0
    },
    hyde: {enabled: true, timeoutMs: 3000, minSimilarity: 0.3},
    search: {semanticThreshold: 0.2, contentMax: 2500},
    fastPath: {similarity: 0.55, maxResults: 3, maxQuestionLen: 120},
    planner: {
        throttleMs: 220,
        explorationMaxSteps: 6,
        explorationMaxTokens: 4000,
        explorationWallMs: 18_000,
        componentThrottleMs: 120,
        componentMaxTokens: 2500,
        outlineMaxTokens: 1500,
        componentConcurrency: 2,
        componentWallMs: 120_000
    },
    annotations: {maxTokens: 900},
    trace: {componentLimit: 6},
    chunker: {smallFileLines: 80, windowLines: 80, windowOverlap: 10},
    watcher: {debounceMs: 250, optimizeDebounceMs: 1000},
    tools: {
        readFileMaxLines: 200,
        listDirMaxEntries: 100,
        grepMaxMatches: 30,
        grepMaxLineLen: 220,
        grepTimeoutMs: 4000
    },
    governor: {windowMs: 60_000, initialTokenGuess: 6000},
    answerCache: {cap: 50, ttlMs: 300_000},
    traces: {ttlDays: 30, similarMinSimilarity: 0.55, findLimit: 3}
};

const sourcePaths = new Set([
    'src/server/ask-route.js',
    'src/planner/index.js',
    'src/planner/evidence-policy.js',
    'src/story-store.js',
    'public/js/app/source-context.js'
]);

const askRouteSource = await fs.readFile(path.join(projectRoot, 'src/server/ask-route.js'), 'utf8');
const askRouteExcerpt = askRouteSource.split(/\r?\n/).slice(12, 28).join('\n');

function sseFrame(type, data) {
    return 'event: ' + type + '\ndata: ' + JSON.stringify({type, ...data}) + '\n\n';
}

function evidenceReadyItems() {
    return [
        {
            path: 'src/server/ask-route.js',
            lineStart: 13,
            lineEnd: 24,
            score: 0.94,
            reason: 'The request boundary validates the question and carries story context into planning.'
        },
        {
            path: 'src/planner/index.js',
            lineStart: 22,
            lineEnd: 53,
            score: 0.91,
            reason: 'The planner coordinates retrieval, exploration, coverage, outlining, and components.'
        },
        {
            path: 'src/planner/evidence-policy.js',
            lineStart: 18,
            lineEnd: 52,
            score: 0.86,
            reason: 'Evidence policy bounds what can support generated claims.'
        },
        {
            path: 'src/story-store.js',
            lineStart: 80,
            lineEnd: 96,
            score: 0.79,
            reason: 'Completed investigations are summarized for the story library.'
        }
    ];
}

function retrievalSnapshot() {
    return {
        stage: 'exploration',
        searches: 3,
        modes: ['semantic', 'lexical', 'graph'],
        totalMs: 186,
        coverage: {
            eligibleFiles: 214,
            indexedSourceFiles: 211,
            skippedFiles: 3,
            dependencyDocuments: 24
        }
    };
}

function primaryTraceFrames() {
    const traceId = 'trc_question_to_story';
    const title = 'From question to source-grounded story';
    const narrative = [
        'The browser sends the question and recent story context to the selected repository runtime.',
        'The planner searches the local hybrid index, follows relevant source relationships, and gathers a bounded evidence packet.',
        'Outline and component passes turn that evidence into a readable explanation, a sequence diagram, and annotated source.',
        'Grounding checks reconcile the citations before the completed trace is streamed back and saved as a story chapter.'
    ];
    const sequenceProps = {
        id: 'question-flow',
        type: 'sequence_diagram',
        caption: 'A question becomes a grounded story',
        mermaid: [
            'sequenceDiagram',
            '  participant U as Reader',
            '  participant B as Browser',
            '  participant A as Ask route',
            '  participant I as Local index',
            '  participant P as Planner',
            '  U->>B: Ask a product question',
            '  B->>A: POST /api/ask',
            '  A->>P: Question + story context',
            '  P->>I: Search bounded source',
            '  I-->>P: Ranked evidence',
            '  P-->>B: Stream narrative, diagram, and code',
            '  B-->>U: Source-grounded chapter'
        ].join('\n'),
        sourceRefs: [
            {path: 'src/server/ask-route.js', lineStart: 13, lineEnd: 24},
            {path: 'src/planner/index.js', lineStart: 22, lineEnd: 53}
        ],
        confidence: 0.96,
        _final: true
    };
    const codeProps = {
        id: 'ask-route-entry',
        type: 'annotated_code_excerpt',
        caption: 'The request enters through a validated streaming route',
        language: 'javascript',
        code: askRouteExcerpt,
        callouts: [
            {line: 1, note: 'Registers the POST boundary used by every question.'},
            {line: 4, note: 'Validates both query and request body before the planner runs.'},
            {line: 7, note: 'Preserves the user question and the explicit force-fresh choice.'},
            {line: 12, note: 'Carries bounded prior chapters and source paths into the next investigation.'}
        ],
        sourceRefs: [{path: 'src/server/ask-route.js', lineStart: 13, lineEnd: 28}],
        confidence: 1,
        _final: true
    };
    const calloutProps = {
        id: 'planner-contract',
        type: 'evidence_callout',
        kind: 'grounded',
        summary: 'The planner requires repository tools before it can produce a chapter.',
        detail: 'The same scoped question and evidence context flows through prefetch, exploration, coverage, outlining, and component generation. This keeps the explanation tied to what was gathered for the request.',
        sourceRefs: [{path: 'src/planner/index.js', lineStart: 22, lineEnd: 53}],
        confidence: 0.98,
        _final: true
    };
    const trace = {
        title,
        narrative,
        components: [sequenceProps, codeProps, calloutProps]
    };
    return [
        sseFrame('trace.start', {traceId, question: mainQuestion, startedAt: Date.now() - 4800}),
        sseFrame('tool.call', {tool: 'search_codebase', inputSummary: 'question handling, planner phases, story persistence'}),
        sseFrame('tool.result', {tool: 'search_codebase', summary: 'Found the request boundary, planner orchestration, evidence policy, and story storage.'}),
        sseFrame('tool.call', {tool: 'read_file', inputSummary: 'src/server/ask-route.js:13-190'}),
        sseFrame('tool.result', {tool: 'read_file', summary: 'Confirmed the validated SSE route and the evidence-bound planner call.'}),
        sseFrame('evidence.ready', {items: evidenceReadyItems(), retrieval: retrievalSnapshot()}),
        sseFrame('synthesis.start', {mode: 'full'}),
        sseFrame('trace.title', {title}),
        sseFrame('narrative.patch', {startIndex: 0, items: narrative}),
        sseFrame('component.patch', {index: 0, id: sequenceProps.id, componentType: sequenceProps.type, props: sequenceProps}),
        sseFrame('component.patch', {index: 1, id: codeProps.id, componentType: codeProps.type, props: codeProps}),
        sseFrame('component.patch', {index: 2, id: calloutProps.id, componentType: calloutProps.type, props: calloutProps}),
        sseFrame('trace.complete', {
            traceId,
            finishedAt: Date.now(),
            durationMs: 4800,
            model: 'qwen3-coder-next',
            usage: {inputTokens: 6120, outputTokens: 1480},
            timing: {},
            trace
        })
    ];
}

function followUpTraceFrames() {
    const traceId = 'trc_story_context';
    const title = 'Follow-up chapters carry story context forward';
    const narrative = [
        'Each completed chapter records its question, generated title, concise narrative, and cited source paths.',
        'A follow-up sends a bounded slice of that context with the new question, helping retrieval stay connected without replaying the entire story.',
        'Repeated source paths remain visible as shared story context, while each chapter keeps its own evidence and trace identity.'
    ];
    const calloutProps = {
        id: 'bounded-story-context',
        type: 'evidence_callout',
        kind: 'grounded',
        summary: 'Follow-ups carry a compact record of the preceding product story.',
        detail: 'The browser sends at most four recent chapters and a bounded set of cited source paths. That gives the next investigation continuity while keeping the model input explicit and reviewable.',
        sourceRefs: [{path: 'public/js/app/source-context.js', lineStart: 12, lineEnd: 26}],
        confidence: 1,
        _final: true
    };
    const trace = {title, narrative, components: [calloutProps]};
    return [
        sseFrame('trace.start', {traceId, question: followUpQuestion, startedAt: Date.now() - 2200}),
        sseFrame('tool.call', {tool: 'read_file', inputSummary: 'public/js/app/source-context.js:12-26'}),
        sseFrame('tool.result', {tool: 'read_file', summary: 'Confirmed the bounded chapter and source-path context sent with follow-ups.'}),
        sseFrame('evidence.ready', {
            items: [{
                path: 'public/js/app/source-context.js',
                lineStart: 12,
                lineEnd: 26,
                score: 0.96,
                reason: 'Builds the bounded context supplied to the next chapter.'
            }],
            retrieval: {
                stage: 'exploration',
                searches: 1,
                modes: ['semantic', 'graph'],
                totalMs: 74,
                coverage: retrievalSnapshot().coverage
            }
        }),
        sseFrame('synthesis.start', {mode: 'lean'}),
        sseFrame('trace.title', {title}),
        sseFrame('narrative.patch', {startIndex: 0, items: narrative}),
        sseFrame('component.patch', {index: 0, id: calloutProps.id, componentType: calloutProps.type, props: calloutProps}),
        sseFrame('trace.complete', {
            traceId,
            finishedAt: Date.now(),
            durationMs: 2200,
            model: 'local',
            usage: null,
            timing: {},
            trace
        })
    ];
}

function storySummaries() {
    const now = Date.UTC(2026, 7, 24, 14, 30, 0);
    return [
        {
            storyId: 'story_question_flow',
            title: 'From question to source-grounded story',
            createdAt: now - 18 * 60_000,
            updatedAt: now,
            chapterCount: 2,
            lastQuestion: followUpQuestion,
            componentKinds: ['sequence_diagram', 'annotated_code_excerpt', 'evidence_callout'],
            sourcePaths: ['src/server/ask-route.js', 'src/planner/index.js', 'public/js/app/source-context.js'],
            freshness: {state: 'current', changedPaths: []}
        },
        {
            storyId: 'story_indexing',
            title: 'Keeping the search corpus current',
            createdAt: now - 86_400_000,
            updatedAt: now - 86_400_000,
            chapterCount: 3,
            lastQuestion: 'What happens when a watched file changes?',
            componentKinds: ['sequence_diagram', 'evidence_callout'],
            sourcePaths: ['src/index/watcher.js', 'src/index/indexer.js'],
            freshness: {state: 'stale', changedPaths: ['src/index/watcher.js']}
        },
        {
            storyId: 'story_change_brief',
            title: 'Turning evidence into an implementation brief',
            createdAt: now - 172_800_000,
            updatedAt: now - 172_800_000,
            chapterCount: 1,
            lastQuestion: 'How does a change brief stay grounded?',
            componentKinds: ['annotated_code_excerpt', 'evidence_callout'],
            sourcePaths: ['src/change-brief/generator.js', 'src/change-brief/render.js'],
            freshness: {state: 'current', changedPaths: []}
        }
    ];
}

function changeBrief(outputFormat) {
    return {
        briefId: 'brief_question_flow',
        traceId: 'trc_question_to_story',
        title: 'Expose retrieval coverage in every completed chapter',
        productGoal: 'Help readers judge how complete a product story is before they use it to guide a code change.',
        currentBehavior: 'The chapter lists the sources considered and records corpus coverage, but the most important coverage signal is easy to miss when readers move directly from the narrative to generated components.',
        likelyFiles: [
            {
                path: 'public/js/app/source-context.js',
                role: 'ui',
                reason: 'Renders the chapter source rail and formats corpus coverage.',
                confidence: 'high'
            },
            {
                path: 'public/styles.css',
                role: 'ui',
                reason: 'Owns the visual hierarchy for source and coverage indicators.',
                confidence: 'medium'
            },
            {
                path: 'test/browser/blocks.spec.js',
                role: 'test',
                reason: 'Exercises source-grounded component rendering in a real browser.',
                confidence: 'medium'
            }
        ],
        acceptanceCriteria: [
            'Every completed chapter shows indexed, skipped, and dependency-document coverage near its source list.',
            'A non-zero skipped count is visually distinct without implying that the generated answer is incorrect.',
            'Coverage detail remains available to keyboard and screen-reader users.',
            'Browser tests cover complete and partial corpus states.'
        ],
        riskNotes: [{
            text: 'Coverage is a corpus-level signal, not proof that every relevant file was retrieved; the copy must preserve that distinction.'
        }],
        openQuestions: ['Should a large skipped-file count link directly to the indexing policy documentation?'],
        agentPrompt: [
            '# Expose retrieval coverage in every completed chapter',
            '',
            '## Product Goal',
            '',
            'Help readers judge how complete a product story is before they use it to guide a code change.',
            '',
            '## Current Behavior',
            '',
            'The chapter records corpus coverage, but the signal is easy to miss beside the source list.',
            '',
            '## Relevant Files',
            '',
            '- public/js/app/source-context.js — render and format coverage near chapter sources',
            '- public/styles.css — preserve the visual hierarchy and accessible states',
            '- test/browser/blocks.spec.js — add browser coverage for complete and partial corpora',
            '',
            '## Acceptance Criteria',
            '',
            '- Show indexed, skipped, and dependency-document counts.',
            '- Distinguish a non-zero skipped count without overstating its meaning.',
            '- Preserve keyboard and screen-reader access.'
        ].join('\n'),
        outputFormat,
        freshness: 'current'
    };
}

function runtimeSnapshot(mode) {
    if(mode === 'indexing') {
        return {
            state: 'initializing',
            stage: 'indexing',
            message: 'Embedding source chunks and updating the local search index.',
            startedAt: Date.now() - 18_000,
            filesProcessed: 149,
            totalFiles: 214,
            sourceFiles: 190,
            dependencyFiles: 24,
            progressRatio: 0.7,
            indexedFiles: 142,
            skippedFiles: 7,
            lastPath: 'src/planner/phases/components.js',
            chunksInStore: 618,
            elapsedMs: 18_000
        };
    }
    return {
        state: 'ready',
        stage: 'ready',
        message: 'Code index ready.',
        filesProcessed: 214,
        totalFiles: 214,
        sourceFiles: 190,
        dependencyFiles: 24,
        progressRatio: 1,
        indexedFiles: 207,
        skippedFiles: 7,
        chunksInStore: 884,
        elapsedMs: 24_800,
        corpusCoverage: retrievalSnapshot().coverage
    };
}

async function fulfillJson(route, body, status = 200) {
    await route.fulfill({
        status,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(body)
    });
}

async function requestJson(request) {
    try {
        return request.postDataJSON() || {};
    } catch {
        return {};
    }
}

async function handleApiRoute(route, runtimeMode) {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if(pathname === '/api/team/config') {
        if(request.method() === 'POST') {
            const saved = await requestJson(request);
            await fulfillJson(route, {...teamConfig, ...saved, exists: true});
            return;
        }
        await fulfillJson(route, teamConfig);
        return;
    }
    if(pathname === '/api/team/repos') {
        await fulfillJson(route, {repos: repositories, defaultRepoId: 'tracebook'});
        return;
    }
    if(pathname === '/api/team/defaults/advanced') {
        await fulfillJson(route, {defaults: {}});
        return;
    }
    if(pathname === '/api/runtime/status' || pathname === '/api/runtime/start') {
        await fulfillJson(route, {runtime: runtimeSnapshot(runtimeMode.value)});
        return;
    }
    if(pathname === '/api/ask' && request.method() === 'POST') {
        const body = await requestJson(request);
        const frames = body.question === followUpQuestion ? followUpTraceFrames() : primaryTraceFrames();
        await route.fulfill({
            status: 200,
            contentType: 'text/event-stream; charset=utf-8',
            headers: {'cache-control': 'no-cache'},
            body: frames.join('')
        });
        return;
    }
    if(pathname === '/api/stories' && request.method() === 'POST') {
        const body = await requestJson(request);
        await fulfillJson(route, {
            ...body,
            storyId: 'story_question_flow',
            freshness: {state: 'current', changedPaths: []}
        });
        return;
    }
    if(pathname === '/api/stories' && request.method() === 'GET') {
        await fulfillJson(route, {stories: storySummaries()});
        return;
    }
    if(pathname === '/api/stories/story_question_flow') {
        await fulfillJson(route, {
            ...storySummaries()[0],
            freshness: {state: 'current', changedPaths: []}
        });
        return;
    }
    if(/^\/api\/stories\//.test(pathname)) {
        const story = storySummaries().find((item) => pathname.endsWith(item.storyId));
        await fulfillJson(route, story || {error: 'not_found'}, story ? 200 : 404);
        return;
    }
    if(/^\/api\/traces\/[^/]+\/change-brief$/.test(pathname) && request.method() === 'POST') {
        const body = await requestJson(request);
        await fulfillJson(route, {brief: changeBrief(body.outputFormat || 'llm_prompt')});
        return;
    }
    if(pathname.startsWith('/api/source-file/')) {
        const encoded = pathname.slice('/api/source-file/'.length);
        const sourcePath = Buffer.from(encoded, 'base64url').toString('utf8');
        if(!sourcePaths.has(sourcePath)) {
            await route.fulfill({status: 404, contentType: 'text/plain', body: 'not_found'});
            return;
        }
        const content = await fs.readFile(path.join(projectRoot, sourcePath), 'utf8');
        await route.fulfill({
            status: 200,
            contentType: 'text/plain; charset=utf-8',
            headers: {
                'x-source-path': sourcePath,
                'x-source-bytes': String(Buffer.byteLength(content))
            },
            body: content
        });
        return;
    }
    await fulfillJson(route, {});
}

async function waitForStablePage(page) {
    await page.evaluate(async () => {
        if(globalThis.document.fonts?.ready) {
            await globalThis.document.fonts.ready;
        }
    });
    await page.waitForTimeout(120);
}

async function capturePage(page, name) {
    await waitForStablePage(page);
    await page.screenshot({
        path: path.join(outputRoot, name),
        animations: 'disabled',
        caret: 'hide'
    });
    process.stdout.write('captured ' + name + '\n');
}

async function captureElement(locator, name) {
    const page = locator.page();
    const fixedChrome = page.locator('.topbar, #ask-form');
    let chromeVisibility = null;

    if (await fixedChrome.count()) {
        chromeVisibility = await fixedChrome.evaluateAll((elements) =>
            elements.map((element) => {
                const previousVisibility = element.style.visibility;
                element.style.visibility = 'hidden';
                return previousVisibility;
            })
        );
    }

    await locator.scrollIntoViewIfNeeded();
    await locator.waitFor({state: 'visible'});
    await page.waitForTimeout(120);

    try {
        await locator.screenshot({
            path: path.join(outputRoot, name),
            animations: 'disabled',
            caret: 'hide'
        });
    } finally {
        if (chromeVisibility !== null) {
            await fixedChrome.evaluateAll((elements, visibility) => {
                elements.forEach((element, index) => {
                    element.style.visibility = visibility[index] || '';
                });
            }, chromeVisibility);
        }
    }

    process.stdout.write('captured ' + name + '\n');
}

async function openReadyWorkspace(page, serverUrl, runtimeMode) {
    runtimeMode.value = 'ready';
    await page.goto(serverUrl + '/?repo=tracebook', {waitUntil: 'networkidle'});
    await page.waitForSelector('#ask-button:not([disabled])');
    await page.waitForSelector('#indexing-overlay', {state: 'hidden'});
}

async function captureWalkthrough(page, serverUrl, runtimeMode) {
    await page.goto(serverUrl + '/admin', {waitUntil: 'networkidle'});
    await page.waitForSelector('form.team-admin-form');
    await page.evaluate(() => globalThis.scrollTo(0, 0));
    await capturePage(page, '01-admin-setup.png');

    await page.goto(serverUrl + '/repos', {waitUntil: 'networkidle'});
    await page.waitForSelector('.team-repo-card');
    await capturePage(page, '02-repository-picker.png');

    runtimeMode.value = 'indexing';
    await page.goto(serverUrl + '/?repo=tracebook', {waitUntil: 'domcontentloaded'});
    await page.waitForSelector('#indexing-overlay:not([hidden])');
    await page.waitForFunction(() => globalThis.document.querySelector('#indexing-progress-percent')?.textContent === '70%');
    await capturePage(page, '03-indexing-progress.png');

    await openReadyWorkspace(page, serverUrl, runtimeMode);
    await page.fill('#ask-input', mainQuestion);
    await capturePage(page, '04-ask-a-question.png');

    await page.click('#ask-button');
    await page.waitForFunction(() => (globalThis.document.querySelector('#status-pill')?.textContent || '').includes('complete'));
    await page.waitForSelector('tool-sequence-diagram svg', {timeout: 20_000});
    await page.waitForSelector('tool-annotated-code-excerpt .code-frame');
    await page.evaluate(() => globalThis.scrollTo(0, 0));
    await capturePage(page, '05-source-grounded-story.png');

    await captureElement(page.locator('tool-sequence-diagram'), '06-sequence-diagram.png');
    await captureElement(page.locator('tool-annotated-code-excerpt'), '07-annotated-code.png');
    await captureElement(page.locator('tool-evidence-callout'), '08-evidence-callout.png');

    await page.click('tool-annotated-code-excerpt .tool-footer .src');
    await page.waitForSelector('.source-fullscreen .source-code-line');
    await capturePage(page, '09-source-view.png');
    await page.click('.source-fullscreen-close');
    await page.waitForSelector('.source-fullscreen', {state: 'detached'});

    await page.evaluate(() => globalThis.scrollTo(0, 0));
    await page.click('#title-rail .change-brief-header-toggle');
    await page.fill('#change-brief-panel-0 textarea[name="changeIntent"]', changeIntent);
    await page.click('#change-brief-panel-0 [data-output-format="repository_issue"]');
    await capturePage(page, '10-change-brief-input.png');

    await page.click('#change-brief-panel-0 .change-brief-submit');
    await page.waitForSelector('#change-brief-panel-0 .change-brief-card');
    await captureElement(page.locator('#change-brief-panel-0'), '11-change-brief.png');
    await page.click('#title-rail .change-brief-header-toggle');

    await page.fill('#ask-input', followUpQuestion);
    await page.click('#ask-button');
    await page.waitForFunction(() => globalThis.document.querySelectorAll('.change-brief-header-toggle').length === 2);
    await page.waitForSelector('#chapter-nav:not([hidden])');
    await page.click('.chapter-nav-current');
    await capturePage(page, '12-follow-up-chapters.png');
    await page.click('#sessions-button');
    await page.waitForSelector('#sessions-panel.is-open .session-item-row');
    await capturePage(page, '13-story-library.png');
}

await fs.ensureDir(outputRoot);
const server = await startTestServer();
let browser;
try {
    browser = await chromium.launch({headless: true});
    const context = await browser.newContext({
        viewport: {width: 1440, height: 960},
        deviceScaleFactor: 1,
        colorScheme: 'light',
        locale: 'en-US',
        timezoneId: 'America/New_York'
    });
    await context.addInitScript(() => {
        localStorage.setItem('tracebook-theme', 'daylight');
        localStorage.setItem('tracebook-selected-repo', 'tracebook');
        Math.random = () => 0.314159;
    });
    const runtimeMode = {value: 'ready'};
    await context.route('**/api/**', (route) => handleApiRoute(route, runtimeMode));
    const page = await context.newPage();
    page.on('console', (message) => {
        if(message.type() === 'error') {
            process.stderr.write('browser console: ' + message.text() + '\n');
        }
    });
    await captureWalkthrough(page, server.url, runtimeMode);
    for(const name of screenshotNames) {
        const target = path.join(outputRoot, name);
        const stat = await fs.stat(target);
        if(stat.size < 10_000) {
            throw new Error('Screenshot is unexpectedly small: ' + name);
        }
    }
    await context.close();
} finally {
    await browser?.close();
    await server.close();
}

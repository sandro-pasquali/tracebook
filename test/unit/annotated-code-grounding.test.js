import test from 'node:test';
import assert from 'node:assert/strict';
import {enforceGroundedAnnotatedCode, enforceHouseLimits} from '../../src/planner/annotated-code-grounding.js';

test('enforceGroundedAnnotatedCode replaces ungrounded code with an evidence slice', async () => {
    const component = {
        type: 'annotated_code_excerpt',
        id: 'checkout-code',
        caption: 'Checkout handler',
        language: 'javascript',
        code: 'console.log("not from evidence");',
        callouts: [],
        sourceRefs: [{path: 'src/checkout.js', lineStart: 1, lineEnd: 1}],
        confidence: 0.2,
        reason: null,
    };

    await enforceGroundedAnnotatedCode(component, {
        id: 'checkout-code',
        kind: 'annotated_code_excerpt',
        intent: 'Show the checkout handler source.',
    }, [checkoutEvidence()], {
        question: 'Show me the checkout handler code',
    });

    assert.match(component.code, /export async function checkout/v);
    assert.match(component.code, /await saveOrder\(order\)/v);
    assert.deepEqual(component.sourceRefs, [{
        path: 'src/checkout.js',
        lineStart: 10,
        lineEnd: 17,
    }]);
    assert.ok(component.callouts.length >= 1);
    assert.ok(component.callouts.length <= 5);
    assert.ok(component.callouts.every((callout) => callout.line >= 1 && callout.line <= component.code.split(/\r?\n/).length));
    assert.equal(component.reason, 'The excerpt is taken directly from retrieved source evidence.');
});

test('enforceGroundedAnnotatedCode expands matching tiny code and corrects source refs', async () => {
    const component = {
        type: 'annotated_code_excerpt',
        id: 'checkout-code',
        caption: 'Checkout handler',
        language: 'javascript',
        code: [
            '    await saveOrder(order);',
            '    return order;',
        ].join('\n'),
        callouts: [{line: 1, note: 'Saves the order.'}],
        sourceRefs: [{path: 'src/checkout.js', lineStart: 1, lineEnd: 2}],
        confidence: 0.8,
        reason: 'Already grounded.',
    };

    await enforceGroundedAnnotatedCode(component, {
        id: 'checkout-code',
        kind: 'annotated_code_excerpt',
        intent: 'Show saveOrder in code.',
    }, [checkoutEvidence()]);

    assert.deepEqual(component.sourceRefs, [{
        path: 'src/checkout.js',
        lineStart: 10,
        lineEnd: 17,
    }]);
    assert.match(component.code, /export async function checkout/v);
    assert.match(component.code, /await saveOrder\(order\)/v);
});

test('enforceGroundedAnnotatedCode avoids tautological logging callouts', async () => {
    const component = {
        type: 'annotated_code_excerpt',
        id: 'message-json',
        caption: 'Message request JSON handling',
        language: 'javascript',
        code: 'return nothingFromEvidence();',
        callouts: [],
        sourceRefs: [{path: 'src/message-route.js', lineStart: 338, lineEnd: 346}],
        confidence: 0.2,
        reason: null,
    };

    await enforceGroundedAnnotatedCode(component, {
        id: 'message-json',
        kind: 'annotated_code_excerpt',
        intent: 'Show how the message request handles invalid JSON.',
    }, [{
        tool: 'read_file',
        path: 'src/message-route.js',
        lineStart: 338,
        lineEnd: 346,
        content: [
            '338  app.post(\'/api/messages\', async (c) => {',
            '339      const requestLog = routeLogger(c);',
            '340      let body;',
            '341      try {',
            '342          body = await c.req.json();',
            '343      } catch {',
            '344          requestLog.warn(\'invalid JSON for message request\');',
            '345          return c.json({error: \'invalid_json\'}, 400);',
            '346      }',
        ].join('\n'),
    }], {
        question: 'What happens when the message endpoint receives invalid JSON?',
    });

    assert.ok(component.callouts.length > 0);
    assert.ok(component.callouts.every((callout) => !/carry out the surrounding/i.test(callout.note)));
    assert.ok(component.callouts.every((callout) => !/^Calls \S+ to /i.test(callout.note)));
    assert.ok(component.callouts.some((callout) => /invalid JSON parse failures|400|invalid_json/i.test(callout.note)));
});

test('enforceGroundedAnnotatedCode selects stream teaching anchors instead of incidental logging', async () => {
    const component = {
        type: 'annotated_code_excerpt',
        id: 'response-stream',
        caption: 'Response event stream',
        language: 'javascript',
        code: 'return notFromEvidence();',
        callouts: [],
        sourceRefs: [{path: 'src/stream-route.js', lineStart: 360, lineEnd: 378}],
        confidence: 0.2,
        reason: null,
    };

    await enforceGroundedAnnotatedCode(component, {
        id: 'response-stream',
        kind: 'annotated_code_excerpt',
        intent: 'Explain how the response handler streams produced events to the client.',
    }, [{
        tool: 'read_file',
        path: 'src/stream-route.js',
        lineStart: 360,
        lineEnd: 378,
        content: [
            '360      return openEventStream(response, async (stream) => {',
            '361          const controller = new AbortController();',
            '362          const collected = [];',
            '363          const onCancel = () => {',
            '364              requestLog.warn({requestId}, \'event stream cancelled by client\');',
            '365              controller.abort();',
            '366          };',
            '367          stream.onCancel(onCancel);',
            '368          try {',
            '369              for await (const message of produceUpdates({',
            '370                  signal: controller.signal',
            '371              })) {',
            '372                  collected.push(message);',
            '373                  await stream.writeEvent({',
            '374                      type: message.type,',
            '375                      data: JSON.stringify(message)',
            '376                  });',
            '377              }',
            '378          }',
        ].join('\n'),
    }], {
        question: 'How does the response stream work?',
    });

    const notes = component.callouts.map((callout) => callout.note).join('\n');
    assert.match(notes, /streaming boundary|incremental updates|incremental output/i);
    assert.match(notes, /openEventStream|writeEvent/i);
    assert.match(notes, /disconnect|cancellation|cancel/i);
    assert.doesNotMatch(notes, /^Logs|Logs "/im);
    assert.doesNotMatch(notes, /carry out the surrounding/i);
});

test('enforceGroundedAnnotatedCode rejects tiny incidental stream decoder excerpts', async () => {
    const component = {
        type: 'annotated_code_excerpt',
        id: 'client-stream-decoding',
        caption: 'Client stream response decoding and event yielding',
        language: 'javascript',
        code: '        let detail = \'\';',
        callouts: [{line: 1, note: 'Initializes detail before reading errors.'}],
        sourceRefs: [{path: 'src/client-stream.js', lineStart: 12, lineEnd: 12}],
        confidence: 1,
        reason: 'The model selected this line.',
    };

    await enforceGroundedAnnotatedCode(component, {
        id: 'client-stream-decoding',
        kind: 'annotated_code_excerpt',
        intent: 'Show how the client decodes a streamed response and yields parsed events.',
    }, [{
        tool: 'read_file',
        path: 'src/client-stream.js',
        lineStart: 1,
        lineEnd: 64,
        content: streamClientEvidence(),
    }], {
        question: 'Explain how a component consumes a streamed response from server back to client.',
    });

    assert.match(component.code, /response\.body\.getReader\(\)/v);
    assert.match(component.code, /reader\.read\(\)/v);
    assert.match(component.code, /yield parsed/v);
    assert.ok(component.sourceRefs[0].lineStart < 24);
    assert.ok(component.sourceRefs[0].lineEnd >= 46);
    assert.doesNotMatch(component.callouts.map((callout) => callout.note).join('\n'), /detail as an empty string|storage mechanism/i);
});

test('enforceGroundedAnnotatedCode never offers a one-line request initializer for a behavioral contract component', async () => {
    const component = {
        type: 'annotated_code_excerpt',
        id: 'api-request-contract',
        caption: 'Request shape validation and normalization before handler execution',
        language: 'javascript',
        code: '    const request = {};',
        callouts: [{line: 1, note: 'Initializes the request object.'}],
        sourceRefs: [{path: 'src/server/contracts.js', lineStart: 22, lineEnd: 22}],
        confidence: 1,
        reason: 'The model selected this line.',
    };
    const source = [
        ...Array.from({length: 20}, (_, index) => `const setup${index} = true;`),
        'async function validateRequest(c, contract, options) {',
        '    const request = {};',
        '    if(contract.params) {',
        '        const params = readParams(c);',
        '        const parsed = parsePart(params.data, contract.params);',
        '        if(!parsed.success) return invalidRequest(c, parsed.error);',
        '        request.params = parsed.data;',
        '    }',
        '    if(contract.query) {',
        '        const query = readQuery(c.req.url);',
        '        const parsed = parsePart(query.data, contract.query);',
        '        if(!parsed.success) return invalidRequest(c, parsed.error);',
        '        request.query = parsed.data;',
        '    }',
        '    if(contract.body) {',
        '        const body = await c.req.json();',
        '        const parsed = parsePart(body, contract.body);',
        '        if(!parsed.success) return invalidRequest(c, parsed.error);',
        '        request.body = parsed.data;',
        '    }',
        '    return {ok: true, request};',
        '}',
        ...Array.from({length: 45}, (_, index) => `const tail${index} = true;`),
    ];
    let offeredRanges = [];

    await enforceGroundedAnnotatedCode(component, {
        id: 'api-request-contract',
        kind: 'annotated_code_excerpt',
        intent: 'Show how the API request shape is validated or normalized before handler work begins.',
    }, [{
        tool: 'read_file',
        path: 'src/server/contracts.js',
        lineStart: 1,
        lineEnd: source.length,
        content: source.map((line, index) => `${index + 1}  ${line}`).join('\n'),
    }], {
        question: 'How does the API work?',
        excerptSelector: ({ranges}) => {
            offeredRanges = ranges;
            return [...ranges].sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
        },
    });

    assert.ok(offeredRanges.length > 0);
    assert.ok(offeredRanges.every((range) => range.end - range.start >= 8));
    assert.ok(component.code.split(/\r?\n/).length >= 8);
    assert.match(component.code, /async function validateRequest/v);
    assert.match(component.code, /parsePart\(body, contract\.body\)/v);
    assert.notEqual(component.code.trim(), 'const request = {};');
});

test('enforceGroundedAnnotatedCode explains DOM resets without repeating storage callouts', async () => {
    const controller = new AbortController();
    controller.abort();
    const component = {
        type: 'annotated_code_excerpt',
        id: 'reset-panel',
        caption: 'Panel UI reset',
        language: 'javascript',
        code: 'return notFromEvidence();',
        callouts: [],
        sourceRefs: [{path: 'src/panel-view.js', lineStart: 120, lineEnd: 131}],
        confidence: 0.2,
        reason: null,
    };

    await enforceGroundedAnnotatedCode(component, {
        id: 'reset-panel',
        kind: 'annotated_code_excerpt',
        intent: 'Explain how changing panels resets the UI before rendering new content.',
    }, [{
        tool: 'read_file',
        path: 'src/panel-view.js',
        lineStart: 120,
        lineEnd: 131,
        content: [
            '120  function resetPanel(panel) {',
            '121      panel.header.innerHTML = \'\';',
            '122      panel.summary.innerHTML = \'\';',
            '123      panel.body.innerHTML = \'\';',
            '124      if(panel.sidebar) {',
            '125          panel.sidebar.innerHTML = \'\';',
            '126      }',
            '127      panel.outlet.clear();',
            '128      if(panel.footer) {',
            '129          panel.footer.innerHTML = \'\';',
            '130      }',
            '131      statusBar.innerHTML = \'\';',
            '132  }',
        ].join('\n'),
    }], {
        question: 'How does changing panels reset the UI?',
        signal: controller.signal,
    });

    const notes = component.callouts.map((callout) => callout.note);
    assert.ok(notes.length > 0);
    assert.ok(notes.every((note) => !/^Stores .* for later .* decisions\.$/i.test(note)));
    assert.ok(notes.every((note) => !/Stores .*\.(?:innerHTML|textContent|className)/i.test(note)));
    assert.equal(new Set(notes.map((note) => note.toLowerCase())).size, notes.length);
    assert.ok(notes.some((note) => /Clears .*stale rendered content|Clears .*stale UI/i.test(note)));
    assert.ok(notes.filter((note) => /innerHTML|rendered content|visible text|CSS classes/i.test(note)).length <= 1);
});

test('enforceGroundedAnnotatedCode can use model-selected behavior range before annotating', async () => {
    const component = {
        type: 'annotated_code_excerpt',
        id: 'callback-flow',
        caption: 'Callback flow',
        language: 'javascript',
        code: 'return notFromEvidence();',
        callouts: [],
        sourceRefs: [{path: 'src/server.js', lineStart: 1, lineEnd: 20}],
        confidence: 0.2,
        reason: null,
    };
    const filler = Array.from({length: 28}, (_, index) => `${index + 1}  const setup${index} = true;`);
    const behavior = [
        '29  app.post("/api/oauth/callback", async (c) => {',
        '30      const payload = await c.req.json();',
        '31      const session = await exchangeOAuthCode(payload.code);',
        '32      await saveSession(session);',
        '33      return c.json({ok: true});',
        '34  });',
    ];
    const tail = Array.from({length: 40}, (_, index) => `${35 + index}  const later${index} = true;`);

    await enforceGroundedAnnotatedCode(component, {
        id: 'callback-flow',
        kind: 'annotated_code_excerpt',
        intent: 'Explain the callback request flow.',
    }, [{
        tool: 'read_file',
        path: 'src/server.js',
        lineStart: 1,
        lineEnd: 74,
        content: [...filler, ...behavior, ...tail].join('\n'),
    }], {
        question: 'How does the OAuth callback flow work?',
        excerptSelector: ({ranges}) => ranges.find((range) => range.lineStart < 29 && range.lineEnd >= 34),
    });

    assert.match(component.code, /exchangeOAuthCode/v);
    assert.match(component.code, /saveSession/v);
    assert.equal(component.sourceRefs[0].path, 'src/server.js');
    assert.ok(component.sourceRefs[0].lineStart < 29);
    assert.ok(component.sourceRefs[0].lineEnd >= 34);
});

test('enforceGroundedAnnotatedCode can select non-JavaScript symbols from tree-sitter ranges', async () => {
    const component = {
        type: 'annotated_code_excerpt',
        id: 'checkout-java',
        caption: 'Checkout method',
        language: 'java',
        code: 'return notFromEvidence();',
        callouts: [],
        sourceRefs: [{path: 'src/CheckoutService.java', lineStart: 1, lineEnd: 34}],
        confidence: 0.2,
        reason: null,
    };
    const setup = [
        '1  public class CheckoutService {',
        ...Array.from({length: 12}, (_, index) => `${index + 2}      private final String setup${index} = "x";`)
    ];
    const method = [
        '14      public Response checkout(Request request) {',
        '15          Order order = parseOrder(request);',
        '16          repository.save(order);',
        '17          return Response.ok(order.id());',
        '18      }',
    ];
    const tail = [
        ...Array.from({length: 15}, (_, index) => `${19 + index}      private void helper${index}() {}`),
        '34  }'
    ];

    await enforceGroundedAnnotatedCode(component, {
        id: 'checkout-java',
        kind: 'annotated_code_excerpt',
        intent: 'Explain the checkout method.',
    }, [{
        tool: 'read_file',
        path: 'src/CheckoutService.java',
        lineStart: 1,
        lineEnd: 34,
        content: [...setup, ...method, ...tail].join('\n'),
    }], {
        question: 'How does checkout work?',
        excerptSelector: () => null,
    });

    assert.match(component.code, /public Response checkout/v);
    assert.match(component.code, /repository\.save/v);
    assert.doesNotMatch(component.code, /setup0/v);
    assert.deepEqual(component.sourceRefs, [{
        path: 'src/CheckoutService.java',
        lineStart: 14,
        lineEnd: 18,
    }]);
});

test('enforceHouseLimits uses the annotation model boundary as excerpt-level guidance', async () => {
    const component = {
        type: 'annotated_code_excerpt',
        id: 'response-stream',
        caption: 'Response event stream',
        language: 'javascript',
        code: [
            'return openEventStream(response, async (stream) => {',
            '    const controller = new AbortController();',
            '    stream.onCancel(() => controller.abort());',
            '    for await (const event of produceUpdates({signal: controller.signal})) {',
            '        await stream.writeEvent({type: event.type, data: JSON.stringify(event)});',
            '    }',
            '});',
        ].join('\n'),
        callouts: [],
        sourceRefs: [{path: 'src/stream-route.js', lineStart: 360, lineEnd: 366}],
        confidence: 1,
        reason: null,
    };
    const writerCalls = [];

    await enforceHouseLimits(component, {
        id: 'response-stream',
        kind: 'annotated_code_excerpt',
        intent: 'Explain how the response handler streams produced events to the client.',
    }, {
        question: 'How does the response stream work?',
        annotationWriter: async (input) => {
            writerCalls.push(input);
            return {
                summary: 'This excerpt turns produced events into a streamed response while wiring client disconnects into cancellation.',
                callouts: [
                    {line: 3, note: 'This cancellation hook connects client disconnects to the stream controller.'},
                    {line: 4, note: 'Passing the controller signal into the producer links client disconnects to the long-running work that emits events.'},
                    {line: 5, note: 'Each produced event is serialized into a stream frame, which is the handoff from server-side work to the live client timeline.'},
                ],
            };
        },
    });

    assert.equal(writerCalls.length, 1);
    assert.match(writerCalls[0].context.story, /incremental|cancellation|Async iteration/i);
    assert.equal(component.reason, 'This excerpt turns produced events into a streamed response while wiring client disconnects into cancellation.');
    assert.deepEqual(component.callouts.map((callout) => callout.line), [1, 3, 5]);
    const notes = component.callouts.map((callout) => callout.note).join('\n');
    assert.match(notes, /incremental output|streaming boundary/i);
    assert.match(notes, /disconnect/i);
});

function checkoutEvidence() {
    return {
        tool: 'read_file',
        path: 'src/checkout.js',
        lineStart: 10,
        lineEnd: 17,
        content: [
            '10  export async function checkout() {',
            '11      const order = await loadOrder();',
            '12      if(!order) {',
            '13          throw new Error(\'missing order\');',
            '14      }',
            '15      await saveOrder(order);',
            '16      return order;',
            '17  }',
        ].join('\n'),
    };
}

function streamClientEvidence() {
    return [
        '1  export async function* consumeStream(request) {',
        '2      const response = await fetch(request.url, {',
        '3          method: request.method,',
        '4          body: request.body,',
        '5          signal: request.signal',
        '6      });',
        '7  ',
        '8      if(!response.ok) {',
        '9          let detail = \'\';',
        '10          try {',
        '11              detail = await response.text();',
        '12          } catch {}',
        '13          throw new Error(\'stream request failed: \' + detail);',
        '14      }',
        '15  ',
        '16      if(!response.body) {',
        '17          throw new Error(\'stream response has no body\');',
        '18      }',
        '19  ',
        '20      const reader = response.body.getReader();',
        '21      const decoder = new TextDecoder();',
        '22      let buffer = \'\';',
        '23  ',
        '24      while(true) {',
        '25          const {value, done} = await reader.read();',
        '26          if(done) {',
        '27              break;',
        '28          }',
        '29          buffer += decoder.decode(value, {stream: true});',
        '30  ',
        '31          let boundary;',
        '32          while((boundary = buffer.indexOf(\'\\n\\n\')) !== -1) {',
        '33              const frame = buffer.slice(0, boundary);',
        '34              buffer = buffer.slice(boundary + 2);',
        '35              const parsed = parseFrame(frame);',
        '36              if(parsed) {',
        '37                  yield parsed;',
        '38              }',
        '39          }',
        '40      }',
        '41  ',
        '42      if(buffer.trim().length > 0) {',
        '43          const parsed = parseFrame(buffer);',
        '44          if(parsed) {',
        '45              yield parsed;',
        '46          }',
        '47      }',
        '48  }',
        '49  ',
        '50  function parseFrame(frame) {',
        '51      return JSON.parse(frame);',
        '52  }',
    ].join('\n');
}

test('enforceGroundedAnnotatedCode offers narrow exploration reads as excerpt candidates', async () => {
    const component = {
        type: 'annotated_code_excerpt',
        id: 'server-route-registration',
        caption: 'HTTP route registration pattern',
        language: 'javascript',
        code: 'return notFromEvidence();',
        callouts: [],
        sourceRefs: [{path: 'src/server.js', lineStart: 1, lineEnd: 48}],
        confidence: 0.5,
        reason: null,
    };
    const filler = Array.from({length: 195}, (_, index) => `${index + 1}  const setup${index} = true;`);
    const adminRoute = [
        '196  registerStaticAssets(app);',
        '197  ',
        '198  app.get("/admin", serveStatic({root: staticRoot, path: "index.html"}));',
        '199  app.get("/repos", serveStatic({root: staticRoot, path: "index.html"}));',
        '200  registerHealthRoutes(app);',
    ];
    const seenCandidates = [];

    await enforceGroundedAnnotatedCode(component, {
        id: 'server-route-registration',
        kind: 'annotated_code_excerpt',
        intent: 'Show where panels are registered as routes.',
    }, [
        {
            tool: 'read_file',
            path: 'src/server.js',
            lineStart: 1,
            lineEnd: 200,
            content: [...filler, ...adminRoute].join('\n'),
        },
        {
            tool: 'read_file',
            path: 'src/server.js',
            lineStart: 190,
            lineEnd: 200,
            content: adminRoute.join('\n'),
        },
    ], {
        question: 'How would I add a new administration panel that is linked to the existing ones?',
        excerptSelector: ({ranges}) => {
            seenCandidates.push(...ranges);
            return ranges.find((range) => /exploration model read directly/.test(range.reason || ''));
        },
    });

    assert.ok(
        seenCandidates.some((range) => /exploration model read directly/.test(range.reason || '')),
        'the targeted read range should be offered as a candidate'
    );
    assert.match(component.code, /\/admin/v);
    assert.ok(component.sourceRefs[0].lineStart >= 190);
});

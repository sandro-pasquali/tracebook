import test from 'node:test';
import assert from 'node:assert/strict';
import {postSSE} from '../../public/js/runtime/sse-client.js';

test('postSSE decodes chunked server-sent events from a POST response', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({url, options});
        return new Response(chunkStream([
            'event: trace.start\n',
            'data: {"type":"trace.start","traceId":"trc_test_123abc"}\n\n',
            ': keepalive\n\n',
            'event: narrative.patch\n',
            'data: {"type":"narrative.patch","items":["one"],',
            '"startIndex":0}\n\n',
            'event: ignored\n',
            'data: not-json\n\n',
        ]), {
            status: 200,
            headers: {'content-type': 'text/event-stream'},
        });
    };

    try {
        const frames = [];
        for await (const frame of postSSE({
            url: '/api/ask',
            body: {question: 'How does checkout work?'},
            signal: undefined,
        })) {
            frames.push(frame);
        }

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, '/api/ask');
        assert.equal(calls[0].options.method, 'POST');
        assert.equal(calls[0].options.headers.get('accept'), 'text/event-stream');
        assert.equal(calls[0].options.headers.get('x-tracebook-request'), '1');
        assert.deepEqual(JSON.parse(calls[0].options.body), {question: 'How does checkout work?'});
        assert.deepEqual(frames, [
            {
                event: 'trace.start',
                data: {type: 'trace.start', traceId: 'trc_test_123abc'},
            },
            {
                event: 'narrative.patch',
                data: {type: 'narrative.patch', items: ['one'], startIndex: 0},
            },
        ]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('postSSE includes response details when the request fails', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({error: 'missing_question'}, {
        status: 400,
    });

    try {
        await assert.rejects(
            async () => {
                for await (const _frame of postSSE({url: '/api/ask', body: {}})) {
                    // Exhaust the async iterator.
                }
            },
            /SSE request failed \(400\): missing_question/v,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

function chunkStream(chunks) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for(const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        },
    });
}

import {apiFetch} from '../app/team-context.js';

// Minimal SSE consumer over fetch.
// Server uses POST + SSE response body, so we cannot use the native EventSource (GET-only).
//
// Yields decoded events: { event: string, data: object }
//

export async function* postSSE({url, body, signal}) {
    const response = await apiFetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'accept': 'text/event-stream'
        },
        body: JSON.stringify(body),
        signal
    });

    if(!response.ok) {
        let detail = '';
        try {
            const contentType = response.headers.get('content-type') || '';
            if(contentType.includes('application/json')) {
                const payload = await response.json();
                detail = payload?.message || payload?.error || '';
            } else {
                detail = (await response.text()).trim();
            }
        } catch {}
        throw new Error(detail ? `SSE request failed (${response.status}): ${detail}` : `SSE request failed (${response.status})`);
    }

    if(!response.body) {
        throw new Error(`SSE request failed (${response.status}): empty response body`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while(true) {
        const {value, done} = await reader.read();
        if(done) {
            break;
        }
        buffer += decoder.decode(value, {stream: true});

        let sep;
        while((sep = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const parsed = parseFrame(frame);
            if(parsed) {
                yield parsed;
            }
        }
    }

    if(buffer.trim().length > 0) {
        const parsed = parseFrame(buffer);
        if(parsed) {
            yield parsed;
        }
    }
}

function parseFrame(frame) {
    let eventName = 'message';
    const dataLines = [];
    for(const rawLine of frame.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if(line.startsWith(':')) {
            continue;
        }
        if(line.startsWith('event:')) {
            eventName = line.slice(6).trim();
        } else if(line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
        }
    }
    if(dataLines.length === 0) {
        return null;
    }
    try {
        return {event: eventName, data: JSON.parse(dataLines.join('\n'))};
    } catch {
        return null;
    }
}

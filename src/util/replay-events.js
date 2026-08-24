const REPLAY_EVENT_TYPES = new Set([
    'trace.start',
    'trace.replay',
    'trace.similar',
    'tool.call',
    'tool.result',
    'synthesis.start',
    'trace.title',
    'narrative.patch',
    'component.patch',
    'trace.complete',
    'trace.error'
]);

// Keep only the event data needed to replay the visible UI. Progressive
// component patches are useful live, but for storage/replay the final props per
// component render the same artifact with far fewer bytes.
export function compactReplayEvents(events = []) {
    if(!Array.isArray(events) || events.length === 0) {
        return [];
    }

    const finalComponentPatchById = new Map();
    for(const event of events) {
        if(event?.type === 'component.patch' && event.id) {
            finalComponentPatchById.set(event.id, event);
        }
    }

    const seenComponentIds = new Set();
    const out = [];
    for(const event of events) {
        if(!event || !REPLAY_EVENT_TYPES.has(event.type)) {
            continue;
        }
        if(event.type === 'component.patch') {
            if(!event.id || seenComponentIds.has(event.id)) {
                continue;
            }
            seenComponentIds.add(event.id);
            const compact = compactEvent(finalComponentPatchById.get(event.id) || event);
            if(compact) out.push(compact);
            continue;
        }

        const compact = compactEvent(event);
        if(compact) out.push(compact);
    }
    return out;
}

function compactEvent(event) {
    switch(event.type) {
        case 'trace.start':
            return pick(event, ['type', 'traceId', 'question', 'startedAt']);
        case 'trace.replay':
            return pick(event, ['type', 'source', 'priorTraceId', 'priorQuestion', 'similarity', 'ageMs']);
        case 'trace.similar':
            return {type: event.type, matches: Array.isArray(event.matches) ? event.matches : []};
        case 'tool.call':
            return pick(event, ['type', 'tool', 'inputSummary', 'prefetch']);
        case 'tool.result':
            return pick(event, ['type', 'tool', 'summary', 'durationMs', 'prefetch']);
        case 'synthesis.start':
            return pick(event, ['type', 'mode']);
        case 'trace.title':
            return pick(event, ['type', 'title']);
        case 'narrative.patch':
            return {
                type: event.type,
                startIndex: Number.isFinite(event.startIndex) ? event.startIndex : 0,
                items: Array.isArray(event.items) ? event.items : []
            };
        case 'component.patch':
            return {
                type: event.type,
                index: Number.isFinite(event.index) ? event.index : 0,
                id: event.id,
                componentType: event.componentType,
                props: stripUndefined(event.props || {})
            };
        case 'trace.complete':
            return pick(event, [
                'type',
                'traceId',
                'startedAt',
                'finishedAt',
                'durationMs',
                'usage',
                'model',
                'explorationModel',
                'timing',
                'fastPath',
                'synthesisMode'
            ]);
        case 'trace.error':
            return pick(event, ['type', 'code', 'stage', 'message']);
        default:
            return null;
    }
}

function pick(source, keys) {
    const out = {};
    for(const key of keys) {
        if(source[key] !== undefined) {
            out[key] = source[key];
        }
    }
    return out;
}

function stripUndefined(value) {
    if(Array.isArray(value)) {
        return value.map(stripUndefined);
    }
    if(!value || typeof value !== 'object') {
        return value;
    }
    const out = {};
    for(const [key, item] of Object.entries(value)) {
        if(item !== undefined) {
            out[key] = stripUndefined(item);
        }
    }
    return out;
}

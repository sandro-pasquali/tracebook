export const markupAnnotation = {
    describeLine({trimmed, discoveryFacts}) {
        const fact = markupFact(trimmed);
        // Same-tag creation notes within one excerpt teach the same thing
        // ("creates a button"); the per-tag semanticKey lets callout selection
        // keep only the best of them.
        //
        const tag = fact ? String(fact).replace(/^markup:\s*/, '').match(/^[a-z][a-z0-9-]*/i)?.[0] || '' : '';
        return {
            role: fact ? 'ui markup' : '',
            facts: fact ? [fact, ...discoveryFacts] : discoveryFacts,
            note: fact ? noteForMarkupFact(fact) : '',
            score: fact ? 28 : 0,
            worthy: isWorthyMarkupLine(trimmed),
            semanticKey: tag ? `markup:${tag}` : ''
        };
    },
    storyForExcerpt({lines, context = {}}) {
        const text = [
            context.question,
            context.intent,
            context.caption,
            ...(Array.isArray(lines) ? lines : [])
        ].filter(Boolean).join('\n').toLowerCase();
        if(/\b(form|button|input|section|main|nav|dialog|template|slot|component|render|ui|layout)\b/.test(text)) {
            return 'The excerpt defines the rendered structure the user or client code interacts with.';
        }
        return '';
    }
};

function markupFact(trimmed) {
    const open = trimmed.match(/^<([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/);
    if(!open || trimmed.startsWith('</')) {
        return '';
    }
    const tag = open[1].toLowerCase();
    const attrs = open[2] || '';
    const id = attrs.match(/\bid\s*=\s*["']([^"']+)["']/)?.[1] || '';
    const classes = attrs.match(/\bclass\s*=\s*["']([^"']+)["']/)?.[1] || '';
    const classSuffix = classes ? `.${classes.split(/\s+/).filter(Boolean).slice(0, 3).join('.')}` : '';
    return `markup: ${tag}${id ? `#${id}` : ''}${classSuffix}`;
}

// Only elements the user actually interacts with earn a structural note;
// "creates a div" teaches nothing, so containers return '' and the candidate
// is dropped rather than shipped as filler.
//
const INTERACTIVE_MARKUP_TAGS = new Set([
    'button', 'a', 'input', 'select', 'textarea', 'form', 'nav', 'dialog',
    'label', 'summary', 'details', 'option', 'video', 'audio', 'canvas', 'iframe'
]);

export function isInteractiveMarkupValue(value) {
    const tag = String(value || '').match(/^[a-z][a-z0-9-]*/i)?.[0] || '';
    return INTERACTIVE_MARKUP_TAGS.has(tag.toLowerCase());
}

function noteForMarkupFact(fact) {
    const value = String(fact || '').replace(/^markup:\s*/, '');
    if(!isInteractiveMarkupValue(value)) {
        return '';
    }
    return `Creates the ${value} element the user interacts with in the rendered interface.`;
}

function isWorthyMarkupLine(trimmed) {
    return Boolean(trimmed && !trimmed.startsWith('</') && !/^<!--/.test(trimmed));
}

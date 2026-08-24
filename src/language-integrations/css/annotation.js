export const cssAnnotation = {
    describeLine({trimmed, lines, lineNumber, discoveryFacts}) {
        const fact = styleFact(trimmed, lines, lineNumber);
        return {
            role: fact ? 'ui style' : '',
            facts: fact ? [fact, ...discoveryFacts] : discoveryFacts,
            note: fact ? noteForStyleFact(fact) : '',
            score: fact ? 30 : 0,
            worthy: isWorthyStyleLine(trimmed)
        };
    },
    storyForExcerpt({lines, context = {}}) {
        const text = [
            context.question,
            context.intent,
            context.caption,
            ...(Array.isArray(lines) ? lines : [])
        ].filter(Boolean).join('\n').toLowerCase();
        if(/\b(style|css|layout|selector|animation|responsive|theme|visual|appearance)\b/.test(text)) {
            return 'The excerpt controls layout, styling, or visual state for rendered interface elements.';
        }
        return '';
    }
};

function styleFact(trimmed, lines, lineNumber) {
    const atRule = trimmed.match(/^@(media|container|supports|keyframes|layer|import)\s+([^{};]+)/);
    if(atRule) {
        return `style at-rule: @${atRule[1]}`;
    }
    const selector = trimmed.match(/^([^@{}][^{]+)\{\s*$/)?.[1]?.trim();
    if(selector) {
        return `style selector: ${selector}`;
    }
    const property = trimmed.match(/^(-{0,2}[A-Za-z][A-Za-z0-9_-]*)\s*:\s*([^;]+);?$/);
    if(property) {
        const owner = nearestCssSelector(lines, lineNumber);
        return `style property: ${property[1]}${owner ? ` on ${owner}` : ''}`;
    }
    return '';
}

function nearestCssSelector(lines, lineNumber) {
    for(let i = lineNumber - 2; i >= 0; i--) {
        const selector = String(lines[i] || '').trim().match(/^([^@{}][^{]+)\{\s*$/)?.[1]?.trim();
        if(selector) {
            return selector;
        }
        if(/^\}/.test(String(lines[i] || '').trim())) {
            break;
        }
    }
    return '';
}

function noteForStyleFact(fact) {
    const text = String(fact || '');
    if(text.startsWith('style selector:')) {
        return `Targets ${text.replace(/^style selector:\s*/, '')} so the related UI region can be styled.`;
    }
    if(text.startsWith('style property:')) {
        return `Sets ${text.replace(/^style property:\s*/, '')}, contributing to the rendered layout or appearance.`;
    }
    if(text.startsWith('style at-rule:')) {
        return `Starts ${text.replace(/^style at-rule:\s*/, '')}, which scopes or groups the following style rules.`;
    }
    return '';
}

function isWorthyStyleLine(trimmed) {
    return Boolean(trimmed && !/^[{};]+$/.test(trimmed) && !/^\/\*/.test(trimmed));
}

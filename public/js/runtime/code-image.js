const MAX_CODE_CHARACTERS = 30_000;
const EXPORT_SCALE = 2;
const MAX_EXPORT_PIXELS = 24_000_000;
const MAX_EXPORT_DIMENSION = 16_384;
const MIN_CARD_WIDTH = 620;
const MAX_CARD_WIDTH = 1320;
const OUTER_PADDING = 48;
const HEADER_HEIGHT = 48;
const CODE_HORIZONTAL_PADDING = 30;
const CODE_TOP_PADDING = 28;
const CODE_BOTTOM_PADDING = 32;
const CODE_FONT_SIZE = 14;
const CODE_LINE_HEIGHT = 22;

export async function renderCodeImage(input, {highlighter = null} = {}) {
    const selection = validateCodeImageSelection(input);
    const document = globalThis.document;
    if(!document?.createElement) {
        throw new Error('This browser cannot render code images.');
    }

    const palette = readPalette(document.documentElement);
    const measurementCanvas = document.createElement('canvas');
    const measurementContext = measurementCanvas.getContext('2d');
    if(!measurementContext) {
        throw new Error('This browser cannot measure the code image.');
    }

    const cardWidth = imageCardWidth(selection.code, palette.mono, measurementContext);
    const contentWidth = cardWidth - (CODE_HORIZONTAL_PADDING * 2);
    const tokens = highlightedTokens(selection, highlighter, palette, document);
    const lines = layoutTokens(tokens, {
        contentWidth,
        context: measurementContext,
        mono: palette.mono
    });
    const width = cardWidth + (OUTER_PADDING * 2);
    const height = (OUTER_PADDING * 2)
        + HEADER_HEIGHT
        + CODE_TOP_PADDING
        + CODE_BOTTOM_PADDING
        + (Math.max(lines.length, 1) * CODE_LINE_HEIGHT);
    assertExportDimensions(width, height);

    const canvas = document.createElement('canvas');
    canvas.width = width * EXPORT_SCALE;
    canvas.height = height * EXPORT_SCALE;
    const context = canvas.getContext('2d');
    if(!context) {
        throw new Error('This browser cannot draw the code image.');
    }
    context.scale(EXPORT_SCALE, EXPORT_SCALE);
    paintImage(context, {
        cardWidth,
        height,
        lines,
        palette,
        selection,
        width
    });

    const png = await canvasBlob(canvas);
    if(!png) {
        throw new Error('The browser could not encode the code image as PNG.');
    }
    return png;
}

export function validateCodeImageSelection(input) {
    const code = String(input?.code || '').replace(/\r\n?/g, '\n');
    if(!code.trim()) {
        throw new Error('Select some code before creating an image.');
    }
    if(code.length > MAX_CODE_CHARACTERS) {
        throw new Error(`Select ${MAX_CODE_CHARACTERS.toLocaleString('en-US')} characters or fewer for a code image.`);
    }
    return {
        code,
        path: String(input?.path || ''),
        language: String(input?.language || ''),
        title: String(input?.title || input?.path || 'code')
    };
}

export function codeImageFilename(input) {
    return `${downloadBaseName(input?.path || input?.title || 'code')}-code.png`;
}

function imageCardWidth(code, mono, context) {
    context.font = codeFont({bold: false, italic: false}, mono);
    let longestLine = 0;
    for(const line of code.split('\n')) {
        longestLine = Math.max(longestLine, context.measureText(line.replace(/\t/g, '    ')).width);
    }
    return clamp(
        Math.ceil(longestLine) + (CODE_HORIZONTAL_PADDING * 2),
        MIN_CARD_WIDTH,
        MAX_CARD_WIDTH
    );
}

function highlightedTokens(selection, highlighter, palette, document) {
    const fallback = [{
        text: selection.code,
        style: defaultTokenStyle(palette)
    }];
    const language = selection.language.trim().toLowerCase();
    let html;
    try {
        if(highlighter && language && highlighter.getLanguage?.(language)) {
            html = highlighter.highlight(selection.code, {
                language,
                ignoreIllegals: true
            }).value;
        } else if(highlighter?.highlightAuto) {
            html = highlighter.highlightAuto(selection.code).value;
        }
    } catch {
        return fallback;
    }
    if(!html) {
        return fallback;
    }

    const template = document.createElement('template');
    template.innerHTML = html;
    const tokens = [];
    collectTextTokens(template.content, new Set(), tokens, palette);
    return tokens.map((token) => token.text).join('') === selection.code ? tokens : fallback;
}

function collectTextTokens(node, inheritedClasses, tokens, palette) {
    for(const child of node.childNodes) {
        if(child.nodeType === 3) {
            if(child.nodeValue) {
                appendToken(tokens, child.nodeValue, tokenStyle(inheritedClasses, palette));
            }
            continue;
        }
        if(child.nodeType !== 1) {
            continue;
        }
        const classes = new Set(inheritedClasses);
        for(const className of child.classList) {
            classes.add(className);
        }
        collectTextTokens(child, classes, tokens, palette);
    }
}

function tokenStyle(classes, palette) {
    const style = defaultTokenStyle(palette);
    if(hasAny(classes, ['hljs-comment', 'hljs-quote'])) {
        style.color = palette.textMuted;
        style.italic = true;
    }
    if(hasAny(classes, ['hljs-string', 'hljs-template-string', 'hljs-regexp', 'hljs-symbol'])) {
        style.color = palette.grounded;
    }
    if(hasAny(classes, ['hljs-number', 'hljs-literal', 'hljs-meta'])) {
        style.color = palette.inferred;
    }
    if(hasAny(classes, ['hljs-keyword', 'hljs-built_in', 'hljs-type', 'hljs-selector-tag'])) {
        style.color = palette.cool;
    }
    if(
        (classes.has('hljs-function') && classes.has('hljs-title'))
        || (classes.has('hljs-title') && (classes.has('function_') || classes.has('class_')))
    ) {
        style.color = palette.text;
        style.bold = true;
    }
    if(hasAny(classes, ['hljs-attr', 'hljs-property', 'hljs-attribute', 'hljs-variable', 'hljs-params'])) {
        style.color = palette.textSoft;
    }
    if(hasAny(classes, ['hljs-tag', 'hljs-name', 'hljs-selector-id', 'hljs-selector-class', 'hljs-section'])) {
        style.color = palette.cool;
    }
    if(classes.has('hljs-deletion')) {
        style.color = palette.gap;
    }
    if(classes.has('hljs-addition')) {
        style.color = palette.grounded;
    }
    return style;
}

function defaultTokenStyle(palette) {
    return {color: palette.text, bold: false, italic: false};
}

function appendToken(tokens, text, style) {
    const previous = tokens.at(-1);
    if(previous && sameTokenStyle(previous.style, style)) {
        previous.text += text;
        return;
    }
    tokens.push({text, style});
}

function layoutTokens(tokens, {contentWidth, context, mono}) {
    const lines = [[]];
    let lineWidth = 0;
    let column = 0;

    for(const token of tokens) {
        context.font = codeFont(token.style, mono);
        for(const character of token.text) {
            if(character === '\n') {
                lines.push([]);
                lineWidth = 0;
                column = 0;
                continue;
            }
            const text = character === '\t' ? ' '.repeat(4 - (column % 4)) : character;
            const width = context.measureText(text).width;
            if(lineWidth > 0 && lineWidth + width > contentWidth) {
                lines.push([]);
                lineWidth = 0;
                column = 0;
            }
            appendVisualSegment(lines.at(-1), {text, width, style: token.style});
            lineWidth += width;
            column += [...text].length;
        }
    }
    return lines;
}

function appendVisualSegment(line, segment) {
    const previous = line.at(-1);
    if(previous && sameTokenStyle(previous.style, segment.style)) {
        previous.text += segment.text;
        previous.width += segment.width;
        return;
    }
    line.push({...segment});
}

function paintImage(context, {cardWidth, height, lines, palette, selection, width}) {
    const background = context.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, palette.backgroundRaised);
    background.addColorStop(0.52, palette.background);
    background.addColorStop(1, palette.backgroundInset);
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);

    const cardX = OUTER_PADDING;
    const cardY = OUTER_PADDING;
    const cardHeight = height - (OUTER_PADDING * 2);
    context.save();
    context.shadowColor = 'rgba(0, 0, 0, 0.18)';
    context.shadowBlur = 60;
    context.shadowOffsetY = 22;
    roundedRect(context, cardX, cardY, cardWidth, cardHeight, 14);
    context.fillStyle = palette.codeBackground;
    context.fill();
    context.restore();

    context.save();
    roundedRect(context, cardX, cardY, cardWidth, cardHeight, 14);
    context.clip();
    context.fillStyle = palette.codeBackground;
    context.fillRect(cardX, cardY, cardWidth, cardHeight);
    context.fillStyle = palette.backgroundRaised;
    context.fillRect(cardX, cardY, cardWidth, HEADER_HEIGHT);
    context.fillStyle = palette.borderSoft;
    context.fillRect(cardX, cardY + HEADER_HEIGHT - 1, cardWidth, 1);
    context.restore();

    drawHeader(context, {cardWidth, cardX, cardY, palette, selection});
    drawCode(context, {cardX, cardY, lines, mono: palette.mono});

    roundedRect(context, cardX, cardY, cardWidth, cardHeight, 14);
    context.strokeStyle = palette.border;
    context.lineWidth = 1;
    context.stroke();
}

function drawHeader(context, {cardWidth, cardX, cardY, palette, selection}) {
    const centerY = cardY + (HEADER_HEIGHT / 2);
    for(const [index, color] of ['#ff5f57', '#febc2e', '#28c840'].entries()) {
        context.beginPath();
        context.arc(cardX + 23 + (index * 18), centerY, 5.5, 0, Math.PI * 2);
        context.fillStyle = color;
        context.fill();
    }

    context.textBaseline = 'middle';
    context.font = `400 12px ${palette.mono}`;
    context.fillStyle = palette.textSoft;
    context.textAlign = 'center';
    context.fillText(
        fitText(context, selection.title, cardWidth - 240),
        cardX + (cardWidth / 2),
        centerY
    );

    context.font = `400 10px ${palette.mono}`;
    context.fillStyle = palette.textMuted;
    context.textAlign = 'right';
    context.fillText(
        fitText(context, languageLabel(selection.language).toUpperCase(), 72),
        cardX + cardWidth - 18,
        centerY
    );
}

function drawCode(context, {cardX, cardY, lines, mono}) {
    const startX = cardX + CODE_HORIZONTAL_PADDING;
    let baseline = cardY + HEADER_HEIGHT + CODE_TOP_PADDING + CODE_FONT_SIZE;
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';

    for(const line of lines) {
        let x = startX;
        for(const segment of line) {
            context.font = codeFont(segment.style, mono);
            context.fillStyle = segment.style.color;
            context.fillText(segment.text, x, baseline);
            x += segment.width;
        }
        baseline += CODE_LINE_HEIGHT;
    }
}

function roundedRect(context, x, y, width, height, radius) {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.lineTo(x + width - radius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + radius);
    context.lineTo(x + width, y + height - radius);
    context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    context.lineTo(x + radius, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - radius);
    context.lineTo(x, y + radius);
    context.quadraticCurveTo(x, y, x + radius, y);
    context.closePath();
}

function fitText(context, value, maxWidth) {
    const text = String(value || '');
    if(context.measureText(text).width <= maxWidth) {
        return text;
    }
    const ellipsis = '…';
    let fitted = text;
    while(fitted && context.measureText(`${fitted}${ellipsis}`).width > maxWidth) {
        fitted = fitted.slice(0, -1);
    }
    return `${fitted}${ellipsis}`;
}

function assertExportDimensions(width, height) {
    const outputWidth = width * EXPORT_SCALE;
    const outputHeight = height * EXPORT_SCALE;
    if(
        outputWidth > MAX_EXPORT_DIMENSION
        || outputHeight > MAX_EXPORT_DIMENSION
        || outputWidth * outputHeight > MAX_EXPORT_PIXELS
    ) {
        throw new Error('That selection is too large to render as one image. Select a smaller excerpt.');
    }
}

function canvasBlob(canvas) {
    return new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/png');
    });
}

function readPalette(root) {
    const styles = getComputedStyle(root);
    const value = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
    return {
        background: value('--bg', '#fbfaf7'),
        backgroundRaised: value('--bg-elev', '#f2efe8'),
        backgroundInset: value('--bg-elev-2', '#e8e3d8'),
        codeBackground: value('--code-bg', '#f4f1ea'),
        text: value('--text', '#2b2a26'),
        textMuted: value('--text-muted', '#8a867d'),
        textSoft: value('--text-soft', '#55524b'),
        border: value('--border', 'rgba(43, 42, 38, 0.28)'),
        borderSoft: value('--border-soft', 'rgba(43, 42, 38, 0.14)'),
        grounded: value('--accent-grounded', '#1f8a5b'),
        cool: value('--accent-cool', '#2570c4'),
        inferred: value('--accent-inferred', '#9a6f0c'),
        gap: value('--accent-gap', '#c24a2f'),
        mono: value('--mono', 'Menlo, Consolas, monospace')
    };
}

function codeFont(style, mono) {
    return `${style.italic ? 'italic' : 'normal'} ${style.bold ? '600' : '400'} ${CODE_FONT_SIZE}px ${mono}`;
}

function sameTokenStyle(left, right) {
    return left.color === right.color && left.bold === right.bold && left.italic === right.italic;
}

function hasAny(values, candidates) {
    return candidates.some((candidate) => values.has(candidate));
}

function languageLabel(language) {
    return String(language || '').trim() || 'text';
}

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}

function downloadBaseName(value) {
    return String(value || 'code')
        .split(/[?#]/)[0]
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .join('-')
        .replace(/\.[A-Za-z0-9]+$/v, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'code';
}

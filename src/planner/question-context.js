import {EOL} from 'node:os';

export function buildQuestionContext({question, storyContext, classification}) {
    const hasContext = Array.isArray(storyContext?.chapters) && storyContext.chapters.length > 0;
    const expanded = expandQueryVocabulary(question, classification);
    const retellingTarget = classification?.isRetelling ? retellingTargetFromContext(storyContext) : null;
    if(!hasContext && !storyContext?.sourcePaths?.length) {
        return {
            retrievalQuestion: question,
            explorationQuestion: expanded,
            answerQuestion: question,
            retellingTarget: null,
            contextMessage: null
        };
    }

    const lines = ['## Current follow-up'];
    lines.push(question);
    lines.push('');
    lines.push('## Conversation context');
    lines.push('Interpret the current question as a continuation of this product story. Reuse prior source context as orientation, but re-verify claims against source evidence.');
    if(retellingTarget) {
        lines.push('The current follow-up is a retelling or presentation request, not a request to explain visualization internals.');
        lines.push('Keep the answer focused on the prior story target below, and use the follow-up only to choose the style or component shape.');
        lines.push('');
        lines.push('## Retelling target');
        if(retellingTarget.question) lines.push(`question: ${retellingTarget.question}`);
        if(retellingTarget.title) lines.push(`title: ${retellingTarget.title}`);
        for(const item of retellingTarget.narrative) {
            lines.push(`- ${item}`);
        }
    }
    for(const [index, chapter] of (storyContext.chapters || []).entries()) {
        lines.push('');
        lines.push(`### Prior chapter ${index + 1}`);
        if(chapter.question) lines.push(`question: ${chapter.question}`);
        if(chapter.title) lines.push(`title: ${chapter.title}`);
        for(const item of chapter.narrative || []) {
            lines.push(`- ${item}`);
        }
    }
    if(Array.isArray(storyContext.sourcePaths) && storyContext.sourcePaths.length > 0) {
        lines.push('');
        lines.push('Previously cited source paths:');
        for(const p of storyContext.sourcePaths.slice(0, 12)) {
            lines.push(`- ${p}`);
        }
    }

    const priorQuestions = (storyContext.chapters || []).map((c) => c.question).filter(Boolean).slice(-3).join(' ');
    const priorTitles = (storyContext.chapters || []).map((c) => c.title).filter(Boolean).slice(-3).join(' ');
    const sourceHints = priorSourceHintsForQuestion(storyContext.sourcePaths || [], {question, classification}).join(' ');
    // A substantive follow-up carries its own subject, so the retrieval query is the
    // current question plus the prior source paths as a soft anchor. The prior chapter's
    // question/title are deliberately NOT blended in here: their natural-language topic
    // dominates the embedding and demotes the file the new question is actually about
    // (e.g. a "how does the server work" follow-up to a UI-flow chapter sank src/server.js
    // from rank 1 to 5). The model still receives that prior context via contextMessage.
    // Retelling/style-only follow-ups have no subject of their own, so they keep leaning on
    // the prior story content as the query.
    //
    const retrievalParts = classification?.isRetelling
        ? [retellingTarget?.searchText, priorQuestions, priorTitles, sourceHints].filter(Boolean)
        : [question, sourceHints];
    const retrievalQuestion = retrievalParts
        .filter(Boolean)
        .join('\n');
    const answerQuestion = retellingTarget
        ? [
            `Retell the prior story in response to this follow-up: ${question}`,
            retellingTarget.searchText
        ].filter(Boolean).join('\n')
        : question;

    return {
        retrievalQuestion,
        explorationQuestion: retellingTarget?.searchText || expanded,
        answerQuestion,
        retellingTarget,
        contextMessage: lines.join(EOL)
    };
}

function retellingTargetFromContext(storyContext) {
    const chapters = Array.isArray(storyContext?.chapters) ? storyContext.chapters : [];
    if(chapters.length === 0) {
        return null;
    }
    const candidates = chapters.filter((chapter) => !isStyleOnlyFollowUp(chapter?.question));
    const selected = candidates.at(-1) || chapters.at(-1);
    if(!selected) {
        return null;
    }
    const narrative = Array.isArray(selected.narrative)
        ? selected.narrative.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5)
        : [];
    const sourcePaths = uniqueStrings([
        ...(Array.isArray(selected.sourcePaths) ? selected.sourcePaths : []),
        ...(Array.isArray(storyContext?.sourcePaths) ? storyContext.sourcePaths.slice(0, 8) : [])
    ]);
    const searchText = [
        selected.question,
        selected.title,
        ...narrative,
        sourcePaths.length ? `Previously cited paths: ${sourcePaths.join(' ')}` : ''
    ].map((item) => String(item || '').trim()).filter(Boolean).join('\n');
    if(!searchText) {
        return null;
    }
    return {
        question: String(selected.question || '').trim(),
        title: String(selected.title || '').trim(),
        narrative,
        sourcePaths,
        searchText
    };
}

function isStyleOnlyFollowUp(question) {
    const q = String(question || '').toLowerCase().trim();
    if(!q) {
        return false;
    }
    const explicitStyleOnly = /\b(explain it|make it simpler|simplify|plain english|i don't understand|i dont understand|visual thinker)\b/.test(q);
    const asksForStyle = /\b(visual|visually|visualize|diagram|flowchart|picture|draw|map|simpler|simplify|high level|plain english)\b/.test(q);
    const hasSpecificSubject = /\b(api|pipeline|llm|ui|text|server|route|database|index|retrieval|component|file|source|function|class|auth|upload)\b/.test(q);
    return explicitStyleOnly || (asksForStyle && !hasSpecificSubject);
}

function uniqueStrings(values) {
    const out = [];
    const seen = new Set();
    for(const value of values || []) {
        const text = String(value || '').trim();
        if(!text || seen.has(text)) {
            continue;
        }
        seen.add(text);
        out.push(text);
    }
    return out;
}

function priorSourceHintsForQuestion(sourcePaths, {classification} = {}) {
    const paths = uniqueStrings(sourcePaths).slice(0, 12);
    if(!classification?.domains?.includes('api')) {
        return paths.slice(0, 8);
    }
    const apiRelevant = paths.filter((sourcePath) => isApiRelevantPath(sourcePath));
    return apiRelevant.slice(0, 8);
}

function isApiRelevantPath(sourcePath) {
    const path = String(sourcePath || '').toLowerCase();
    return /\b(api|endpoint|route|routes|server|handler|request|response|stream|sse|client|browser|frontend|fetch|http|controller)\b/.test(path) ||
        /(^|\/)(server|routes?|controllers?|handlers?|api|client|frontend|browser|web|public)\b/.test(path);
}

function expandQueryVocabulary(question, classification) {
    const q = String(question || '');
    const hints = [...(classification?.retrievalHints || [])];
    if(/\b(api|endpoint|route|request|response|sse|stream)\b/i.test(q)) {
        hints.push('API route endpoint request response stream event handler server controller');
    }
    if(/\b(ui|browser|frontend|screen|button|click|clicked|input|form|render|component|html|css|style|styles|react)\b/i.test(q)) {
        hints.push('UI frontend HTML CSS component DOM event listener click handler form input render state fetch template stylesheet');
    }
    if(/\b(code|source|show|file|files|html|css|javascript|typescript|jsx|tsx|markup|stylesheet)\b/i.test(q)) {
        hints.push('source code file excerpt annotated_code_excerpt HTML CSS JavaScript TypeScript JSX TSX markup stylesheet');
    }
    if(/\b(llm|llms|model|models|ai|tools?|agent|planner)\b/i.test(q)) {
        hints.push('LLM model AI agent prompt tool call inference completion embedding reranking orchestration');
    }
    if(/\b(cache|memory|prior|similar|trace)\b/i.test(q)) {
        hints.push('cache memory prior similar history replay persistence telemetry tracing');
    }
    if(/\b(db|database|datastore|store|storage|orm|model|models|migration|schema|repository|repo|controller|dao|sql|query|queries|vector|embedding|embeddings|index|indexing|indexed|search|retrieval|chunk|chunking)\b/i.test(q)) {
        hints.push('database datastore storage repository controller ORM model migration schema SQL query vector embedding index indexing chunking retrieval store upsert table search');
        hints.push('storage indexer watcher embedding vector search content hash lexical semantic retrieval');
    }
    if(/\b(dependencies|dependency|install|installs|package|packages|package manager|npm|pnpm|yarn|node_modules|typescript|tsconfig|python|pip|venv|virtualenv|requirements|pyproject|poetry|rust|cargo|crate|crates)\b/i.test(q)) {
        hints.push('dependencies dependency install package manager manifest package metadata repository exports types configuration');
        hints.push('language package manifest lockfile registry source features');
        hints.push('dependency documentation manifest lockfile package metadata installed version declared version');
    }
    return hints.length > 0 ? `${q}\n${hints.join('\n')}` : q;
}

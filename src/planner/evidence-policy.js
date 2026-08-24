import {resolveLanguageIntegration, roleForRepoSupportingPath} from '../language-integrations/registry.js';
import {isSystemOverviewQuestion, wantsSupportingEvidence} from '../util/retrieval-intent.js';
import {buildRepoContext, isSupportingEvidencePath, sourceFamilyForPath, splitIdentifier} from '../util/retrieval-core.js';

// Re-exported so existing importers (evidence.js, plan-augmentation.js) keep their
// import path while the implementation lives in the shared retrieval module.
//
export {selectPathDiverse} from '../util/retrieval-core.js';

export const EVIDENCE_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'then', 'than',
    'what', 'when', 'where', 'which', 'who', 'why', 'how', 'does', 'work',
    'works', 'system', 'process', 'implementation', 'deep', 'level', 'tell',
    'everything', 'about', 'please', 'explain', 'walkthrough', 'overview',
    'codebase', 'repository', 'repo', 'source', 'code'
]);

// Ranking runs once for the outline and again per component within a request, all
// against the same immutable question. The token set and repo context depend only on
// the question, so memoize the pair (bounded, keyed by question text) instead of
// re-tokenizing and re-resolving repo profiles on every call.
//
const questionContextCache = new Map();
const QUESTION_CONTEXT_CACHE_CAP = 64;

function questionRankingContext(question) {
    const key = String(question || '');
    const cached = questionContextCache.get(key);
    if(cached) {
        return cached;
    }
    const context = {tokens: evidenceTokens(question), repoContext: repoContextForQuestion(question), overview: isSystemOverviewQuestion(question)};
    questionContextCache.set(key, context);
    while(questionContextCache.size > QUESTION_CONTEXT_CACHE_CAP) {
        questionContextCache.delete(questionContextCache.keys().next().value);
    }
    return context;
}

export function rankEvidenceItemsWithScores(items, question = '') {
    const {tokens, repoContext, overview} = questionRankingContext(question);
    const scored = (items || []).map((item, index) => ({
        item,
        index,
        score: scoreEvidenceItem(item, tokens, question, repoContext, overview)
    }));
    return scored
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((entry) => ({item: entry.item, score: entry.score}));
}

export function rankEvidenceItems(items, question = '') {
    return rankEvidenceItemsWithScores(items, question).map((entry) => entry.item);
}

// Preserve relevance order while reserving early slots for distinct system
// layers. Pure path diversity can still return four files from one directory
// (four route files, for example); layer diversity is what lets a component see
// the boundary, orchestration, data, and presentation evidence needed to
// explain a mechanism rather than merely list nearby files.
//
export function selectLayerDiverse(items, limit) {
    const ranked = items || [];
    if(limit <= 0) {
        return [];
    }
    const selected = [];
    const seenItems = new Set();
    const seenPaths = new Set();
    const seenLayers = new Set();
    for(const item of ranked) {
        const path = String(item?.path || '');
        const layer = sourceLayerForEvidence(item);
        if(seenPaths.has(path) || seenLayers.has(layer)) {
            continue;
        }
        selected.push(item);
        seenItems.add(item);
        seenPaths.add(path);
        seenLayers.add(layer);
        if(selected.length >= limit) {
            return selected;
        }
    }
    for(const item of ranked) {
        if(seenItems.has(item) || seenPaths.has(String(item?.path || ''))) {
            continue;
        }
        selected.push(item);
        seenItems.add(item);
        seenPaths.add(String(item?.path || ''));
        if(selected.length >= limit) {
            return selected;
        }
    }
    for(const item of ranked) {
        if(seenItems.has(item)) {
            continue;
        }
        selected.push(item);
        if(selected.length >= limit) {
            break;
        }
    }
    return selected;
}

export function sourceLayerForEvidence(item) {
    const path = String(item?.path || '').toLowerCase();
    if(isSupportingEvidencePath(path)) {
        return roleForRepoSupportingPath(path) === 'configuration' ? 'configuration' : 'supporting';
    }
    if(/(^|\/)(public|client|frontend|ui|views?|templates?|components?|pages?)(\/|$)/.test(path)) {
        return 'presentation';
    }
    if(/(^|\/)(routes?|controllers?|handlers?|endpoints?|api|middleware|server)(\/|\.|$)/.test(path)) {
        return 'boundary';
    }
    if(/(^|\/)(store|storage|database|db|models?|repositories|dao|migrations?|index)(\/|\.|$)/.test(path)) {
        return 'data';
    }
    if(/(^|\/)(config|settings?|bootstrap|startup|main|app|cli)(\/|\.|$)/.test(path)) {
        return 'entrypoint';
    }
    if(/(^|\/)(test|tests|spec|specs|fixtures?)(\/|\.|$)/.test(path)) {
        return 'verification';
    }
    return 'core';
}

function evidenceTokens(question) {
    const raw = String(question || '').match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [];
    const out = [];
    const seen = new Set();
    for(const token of raw.flatMap(splitIdentifier)) {
        const normalized = token.toLowerCase();
        if(normalized.length < 3 || EVIDENCE_STOPWORDS.has(normalized) || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        out.push(normalized);
    }
    return out.slice(0, 40);
}

// Light, language-agnostic inflection folding so a question word still hits its
// source form: "apis" -> "api", "stories" -> "story", "deletion" -> "delet"
// (which substring-matches delete/deleted/deletes). No dictionary stemming —
// just suffix folds that are safe across identifiers and prose.
//
function tokenMatchVariants(token) {
    const variants = new Set([token]);
    if(token.length >= 5 && token.endsWith('ies')) {
        variants.add(`${token.slice(0, -3)}y`);
    }
    if(token.length >= 4 && token.endsWith('s') && !token.endsWith('ss')) {
        variants.add(token.slice(0, -1));
    }
    for(const variant of [...variants]) {
        if(variant.length >= 6 && variant.endsWith('ion')) {
            variants.add(variant.slice(0, -3));
        }
    }
    return [...variants];
}

function tokenMatchesText(token, text) {
    return tokenMatchVariants(token).some((variant) => text.includes(variant));
}

// Whole-word prefix bridging, the other direction of containment: code often
// abbreviates what the question spells out ("admin"/"administration",
// "config"/"configuration"). `includes` covers question-word ⊂ text; this
// covers text-word ⊂ question-word — a whole word in the text (>= 4 chars)
// that is a proper prefix of the token.
//
const PREFIX_WORD_MIN = 4;
const PREFIX_TOKEN_MIN = 6;

function wordPrefixMatch(token, words) {
    if(token.length < PREFIX_TOKEN_MIN) {
        return false;
    }
    for(const word of words) {
        if(word.length >= PREFIX_WORD_MIN && word.length < token.length && token.startsWith(word)) {
            return true;
        }
    }
    return false;
}

// One matcher per scored text: the word set backing prefix matching is built
// lazily and only once however many tokens are tested against it.
//
function createTokenMatcher(text) {
    let words = null;
    return (token) => {
        if(tokenMatchesText(token, text)) {
            return true;
        }
        words ||= new Set(text.match(/[a-z][a-z0-9]{3,}/g) || []);
        return wordPrefixMatch(token, words);
    };
}

// Pure subject relevance: similarity plus folded question-token hits, with
// none of the architecture/repo/keyword boosts. Callers that already encode
// their own structural priors (the API facet selector) use this so question
// topic and structural shape are weighed independently.
//
export function questionSubjectScore(item, question) {
    const {tokens} = questionRankingContext(question);
    const path = String(item?.path || '').toLowerCase();
    const haystack = `${path}\n${String(item?.content || '').slice(0, SCORE_HAYSTACK_CHARS)}`.toLowerCase();
    const matchesPath = createTokenMatcher(path);
    const matchesHaystack = createTokenMatcher(haystack);
    let score = typeof item?.score === 'number' ? item.score * 5 : 0;
    for(const token of tokens) {
        if(matchesPath(token)) {
            score += 2.5;
        }
        if(matchesHaystack(token)) {
            score += 0.75;
        }
    }
    return score;
}

// A read_file item is a deliberate exploration choice, not a passive retrieval
// hit. Search results carry similarity * 5 (~2.5-3 points); without an
// equivalent prior, a file the model chose to read in full ranks below every
// mediocre search snippet and the strongest evidence never reaches synthesis.
//
const READ_FILE_SCORE_PRIOR = 3;
// Token scans cover the full stored evidence body (read_file items keep up to
// 6000 chars): a cap below that hides exactly the lines that made the file
// worth reading.
//
const SCORE_HAYSTACK_CHARS = 8000;

function scoreEvidenceItem(item, tokens, question, repoContext, overview = false) {
    const path = String(item?.path || '');
    const content = String(item?.content || '');
    const pathLower = path.toLowerCase();
    const haystack = `${path}\n${content.slice(0, SCORE_HAYSTACK_CHARS)}`.toLowerCase();
    const matchesPath = createTokenMatcher(pathLower);
    const matchesHaystack = createTokenMatcher(haystack);
    let score = typeof item?.score === 'number' ? item.score * 5 : 0;
    if(item?.tool === 'read_file') {
        score += READ_FILE_SCORE_PRIOR;
    }

    for(const token of tokens) {
        if(matchesPath(token)) {
            score += 2.5;
        }
        if(matchesHaystack(token)) {
            score += 0.75;
        }
    }

    score += architectureEvidenceBoost({path, content, question});
    score += repoProfileEvidenceBoost({path, content, repoContext});

    if(isSupportingEvidencePath(path)) {
        score += wantsSupportingEvidence(question) ? 2 : 0.25;
    }
    if(/\b(export|function|class|const|async|def|fn|struct|impl|app\.(get|post|use)|create[A-Z]\w+)\b/.test(content)) {
        score += 0.75;
    }

    // Overview questions have no semantic tokens (every content word is a
    // stopword), so without a prior the ranking is arbitrary retrieval order.
    // Prefer the repo's own overview documentation (registry-classified role,
    // no path patterns here) and shallow entry-level files over deep leaves.
    //
    if(overview) {
        if(roleForRepoSupportingPath(path) === 'documentation') {
            score += 5;
        }
        if(path.split('/').length <= 2) {
            score += 1.5;
        }
    }
    return score;
}

function repoContextForQuestion(question) {
    return buildRepoContext(question, {
        normalize: (term) => String(term || '').toLowerCase(),
        termOrder: ['matchedTerms', 'questionTerms', 'evidenceTerms']
    });
}

function repoProfileEvidenceBoost({path, content, repoContext}) {
    if(!repoContext || repoContext.profiles.length === 0) {
        return 0;
    }
    const integration = resolveLanguageIntegration({path});
    let score = 0;
    if(integration?.id && repoContext.ids.has(integration.id)) {
        score += 4;
    }
    if(integration?.family && repoContext.families.has(integration.family)) {
        score += 1.5;
    }
    if(integration?.category && repoContext.categories.has(integration.category)) {
        score += 0.75;
    }
    const haystack = `${path}\n${content.slice(0, SCORE_HAYSTACK_CHARS)}`.toLowerCase();
    let hits = 0;
    for(const term of repoContext.terms) {
        if(term.length >= 3 && haystack.includes(term)) {
            hits++;
        }
    }
    return score + Math.min(3, hits * 0.5);
}

function architectureEvidenceBoost({path, content, question}) {
    const q = String(question || '').toLowerCase();
    const p = String(path || '').toLowerCase();
    const c = String(content || '').toLowerCase();
    let score = 0;

    if(/\b(ui|browser|frontend|page|screen|layout|html|markup|dom|css|style|styles|stylesheet|selector|theme|visual|appearance)\b/.test(q)) {
        const family = sourceFamilyForPath(path);
        if(family === 'markup' && /\b(ui|browser|frontend|page|screen|layout|html|markup|dom|visible)\b/.test(q)) {
            score += 5;
        }
        if(family === 'style' && /\b(layout|css|style|styles|stylesheet|selector|theme|visual|appearance|color|spacing|responsive)\b/.test(q)) {
            score += 5;
        }
        if(family === 'markup' && /<\/?(html|head|body|main|section|form|button|input|nav|header|footer|div|span)\b/.test(c)) {
            score += 2;
        }
        if(family === 'style' && /[{;}]\s*(?:\n|$)|--[\w-]+\s*:/.test(c)) {
            score += 2;
        }
    }

    if(/\b(apis?|endpoints?|routes?|webhooks?|sse|streaming|handlers?|controllers?)\b/.test(q)) {
        if(/(^|\/)(server|servers|routes?|controllers?|handlers?|apis?|endpoints?|middleware)\b/i.test(p)) {
            score += 4;
        }
        // Route registrations across common server stacks: Express/Hono/Koa
        // style `app.get(`/`router.delete(`, Python decorators `@app.get(`,
        // Spring `@GetMapping`, plus literal API path segments.
        //
        if(/\b(?:app|router|server|api)\s*\.\s*(?:get|post|put|patch|delete|del|head|options|all|use)\s*\(/i.test(c) ||
            /@(?:app|router)\.(?:get|post|put|patch|delete)\b/.test(c) ||
            /@(?:Get|Post|Put|Patch|Delete|Request)Mapping\b/.test(content) ||
            /['"`]\/api\//i.test(c)) {
            score += 3;
        }
    }

    if(/\b(index|indexing|indexed|retrieval|search|vector|embedding|embeddings|chunk|chunking)\b/.test(q)) {
        if(/(^|\/)(index|indexes|search|retrieval|embed|embedding|chunk|vector|store|db|database|watch|dependency)/.test(p)) {
            score += 4;
        }
        const compactContent = c.replace(/[^a-z0-9]+/g, '');
        if(/index|embed|embedding|vector|search|upsert|dependency|watcher|chunk/.test(compactContent)) {
            score += 3;
        }
    }
    if(/\b(db|database|datastore|store|storage|orm|schema|model|migration|repository|dao|sql|query|queries)\b/.test(q)) {
        if(/(^|\/)(db|database|data|store|storage|model|schema|repository|repositories|dao|migration|prisma)/.test(p)) {
            score += 3;
        }
        if(/\b(table|schema|query|upsert|insert|select|where|migration|model|repository|prisma|sequelize|typeorm|mongoose)\b/.test(c)) {
            score += 2;
        }
    }
    if(/\b(dependencies|dependency|install|installs|package|packages|npm|pnpm|yarn|python|pip|rust|cargo|crate|typescript|tsconfig|config|configuration)\b/.test(q)) {
        if(isSupportingEvidencePath(path)) {
            score += 3;
        }
    }
    return score;
}

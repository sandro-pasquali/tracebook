export function wantsSupportingEvidence(question) {
    return /\b(deep|implementation|algorithm|architecture|actors?|themes?|technology|configuration|config|dependencies|dependency|install|installs|package|packages|package manager|npm|pnpm|yarn|node_modules|typescript|tsconfig|python|pip|venv|virtualenv|requirements|pyproject|poetry|rust|cargo|crate|crates|db|database|datastore|store|storage|orm|model|models|migration|schema|repository|repo|controller|dao|sql|query|queries|lance|lancedb|vector|embedding|embeddings|index|indexing|indexed|search|retrieval|chunk|chunking|stack|librar(?:y|ies)|frameworks?|tooling|setup|built with|powered by|runs on|written in|uses?|using)\b/i.test(String(question || ''));
}

// A whole-system overview question ("how does this system/codebase work",
// "give me the big picture") — the phrasing whose content words are all
// evidence stopwords, leaving ranking with no semantic signal. Used to open the
// outline's supporting-evidence slots (README/docs) and apply overview priors.
// Generic English only: no ecosystem or repo terms belong here.
//
export function isSystemOverviewQuestion(question) {
    const text = String(question || '').toLowerCase();
    if(!text.trim()) {
        return false;
    }
    if(/\b(?:how|what)\b.*\b(?:system|codebase|repository|repo|project|app|application|product|everything|whole|architecture)\b.*\b(?:work|works|working|built|structured|organized|organised|do|does|fit together)\b/.test(text)) {
        return true;
    }
    // "what happens end to end when ..." — an end-to-end walk request is an
    // overview even when no system/codebase noun appears.
    //
    if(/\bend[- ]to[- ]end\b/.test(text) && /\b(?:what happens|how|walk(?: me)? through|flow|overview)\b/.test(text)) {
        return true;
    }
    return /\b(?:overview|big picture|high[- ]level|bird'?s[- ]eye|end[- ]to[- ]end)\b.*\b(?:system|codebase|repository|repo|project|app|application|architecture|flow)\b/.test(text) ||
        /\b(?:system|codebase|repository|repo|project|architecture)\b.*\b(?:overview|big picture|high[- ]level|end[- ]to[- ]end)\b/.test(text);
}

// Narrow intent: the question is actually about the dependency manifest itself —
// what's installed, which versions, how packages are declared. Deliberately
// tighter than wantsSupportingEvidence (which also fires on config/search/db/…),
// because it gates whether a manifest (package.json) may rank as PRIMARY evidence
// rather than being demoted to supporting context.
//
export function wantsDependencyManifest(question) {
    return /\b(dependency|dependencies|devdependencies|manifest|version|versions|installed|install|package\.json|package manager|npm|pnpm|yarn)\b/i.test(String(question || ''));
}

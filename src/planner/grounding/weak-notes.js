// One shared "weak callout note" predicate, used by both the deterministic
// callout planner (callouts.js) and the LLM annotation path (annotation-model.js).
// Previously each module kept its own list and they diverged: the model path
// rejected "Stores X for later/surrounding…" while the deterministic path did not,
// so formulaic synthesis notes shipped. Keeping one union here prevents that drift.
//
// A weak note is one that restates the syntax ("stores X", "runs inside if",
// "checks a condition") instead of teaching why the line matters in the flow.
//
// The generation eval imports isWeakNote as its weak-co LEAK GATE: production
// filters with this predicate, so a counted callout shipped through a path
// that skipped or escaped filtering. Independent quality measurement lives in
// the eval's dup-co metric, which shares no code with this list.
//
const WEAK_NOTE_PATTERNS = [
    /^Delegates to the next function or returns the result\.$/i,
    /^Shows the source statement this explanation is grounded in\.$/i,
    /^Defines the function or class being explained\.$/i,
    /^Checks a condition before continuing the operation\.$/i,
    /^Marks an active source line in this excerpt\.$/i,
    /^Calls\s+\S+\s+to\b/i,
    /\bcarry out the surrounding\b/i,
    /^Stores\s+\S+\s+for (?:the surrounding|later)\b/i,
    /^Keeps\s+.{1,80}\s+visible because\b/i,
    /^Runs inside (?:for|if|while|switch|try|catch|else|return|do)\b/i,
    /^Runs inside \S+, tying this line to the surrounding\b/i,
    /^Connects this (?:line|excerpt) to the\b/i,
    /^Highlights\b/i,
    /^Highlights syntax:/i,
    /\bas part of the storage or retrieval operation\b/i,
    /\bas (?:relevant|the available) source evidence\.?$/i,
    /^Sends incremental output through\b/i
];

export function isWeakNote(note) {
    const text = String(note || '').replace(/\s+/g, ' ').trim();
    if(!text) {
        return true;
    }
    return WEAK_NOTE_PATTERNS.some((pattern) => pattern.test(text));
}

// Anchor "values" that carry no teaching signal: language keywords and bare
// globals. A templated note built on these ("Runs inside for…", "Keeps document
// visible…") is noise, so the generators return '' for them and the candidate is
// dropped before selection.
//
const NON_TEACHING_VALUES = new Set([
    'for', 'if', 'while', 'switch', 'try', 'catch', 'else', 'return', 'do', 'case',
    'document', 'window', 'console', 'globalthis', 'this'
]);

export function isNonTeachingValue(value) {
    return NON_TEACHING_VALUES.has(String(value || '').trim().toLowerCase());
}

// Hard limits on annotated-code excerpts. The schema and prompt ask the model
// for these, but it regularly overshoots (50-line blocks, 10+ callouts), so
// they are enforced again here. MIN_CALLOUTS is a floor of 1, not an aim: the
// prompts still ask for 3-5, but selection must never pad an excerpt with
// filler notes just to reach a count — fewer teaching notes beat boilerplate.
//
export const MAX_CODE_LINES = 60;
export const TRUNCATION_WINDOW = 3;
export const MAX_CALLOUTS = 5;
export const MIN_CALLOUTS = 1;

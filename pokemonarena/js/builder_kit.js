// pokemonarena/js/builder_kit.js -- THE TEAM BUILDER's KIT: the heavy pure layers the builder's state machine works with, bound to one decoded pack and handed to the model as DATA.
//
// Pure ES module (browser + Node): no DOM, no storage, no timers. It is NOT in the hub's first paint: builder_ctl.js imports it (the ctl is loaded the first time a builder screen opens) and
// gives the result to the model (builder_hub.js attach(kit)); a Node test makes one the same way. So builder_hub.js and its screen modules import nothing heavy, and stay pure: the clock and the
// random bytes a new id needs come in here as `deps`, exactly as editor_state.js takes them.
//
//   const kit = createBuilderKit({ pack, deps });          // deps: { now, randomBytes } (default: profile.js defaultDeps())
//   kit.reduce(state, action)          editor_state.js reduce() with ctx = { pack, deps }: THE ONLY WAY the builder edits a profile
//   kit.initialState(profile, opts)    editor_state.js initialState
//   kit.ES / kit.ED                    editor_state.js / editor_data.js, whole (selectors, limits, ruleset helpers; searches, catalogs, validation, derived numbers)
//   kit.rules(id)                      the resolved ruleset of an id (rules.js resolveRuleset; an id it refuses gives the default ruleset, so one bad team cannot blank a screen)
//   kit.text(s) / kit.lines(s) / kit.flow(s)   A ROM STRING MADE DRAWABLE: charset.js displayText() rewrites the multi-glyph tokens ({PO}{Ke}{BL}{OC}{K} -> POKeBLOCK), which the font's
//                                      encoder otherwise throws on; curly quotes become the straight ones the ROM font has. lines() splits on the ROM's line breaks, flow() joins them into one
//                                      line of words (for the message box, which wraps by its own width)
//   kit.textIssue(s, max)              profile.js textIssue: why a name cannot be used, or null
//   kit.LIMITS                         profile.js PROFILE_LIMITS (trainerName 10, teamName 16, nickname 10 ...)
// A later stage that needs more of the pure layers (team codes, stats) ADDS them here.

import * as ES from './editor_state.js';
import * as ED from './editor_data.js';
import { resolveRuleset, DEFAULT_RULESET_ID } from './rules.js';
import { displayText } from './charset.js';
import { textIssue, PROFILE_LIMITS, defaultDeps } from './profile.js';

export function createBuilderKit({ pack, deps } = {}) {
  if (!pack || !Array.isArray(pack.species)) throw new TypeError('createBuilderKit needs the decoded pack (tables.js loadPack)');
  const d = { ...defaultDeps(), ...(deps || {}) };
  const ctx = { pack, deps: d };
  const resolved = new Map();
  function rules(id) {
    let r = resolved.get(id);
    if (!r) { try { r = resolveRuleset(id); } catch (_e) { r = resolveRuleset(DEFAULT_RULESET_ID); } resolved.set(id, r); }
    return r;
  }
  const text = (s) => displayText(String(s === undefined || s === null ? '' : s)).replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
  const lines = (s) => text(s).split('\n');
  const flow = (s) => lines(s).join(' ').replace(/\s+/g, ' ').trim();
  return Object.freeze({ pack, deps: d, ES, ED, reduce: (state, action) => ES.reduce(state, action, ctx), initialState: ES.initialState, rules, text, lines, flow, textIssue, LIMITS: PROFILE_LIMITS });
}

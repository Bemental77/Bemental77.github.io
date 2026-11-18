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
//   kit.LINKS                          editor_links.js, whole: FORMATS, CPU_LEVELS, formatsForTeamSize, formatForTeamSize, battleUrl (the address of a test battle, the DOM editor's)
//   kit.HP_TYPES                       stats.js HIDDEN_POWER_TYPES: the sixteen types Hidden Power can have ({ index, name, id })
//   kit.encodeTeam(profile, teamId)    -> Promise<{ ok: true, code } | { ok: false, message }>: the ARENA1 code of a team (teamcode.js). Never rejects
//   kit.decodeCode(text)               -> Promise<{ ok: true, team, validation: { ok, count, problems: [{ mon, label, text }] } } | { ok: false, code, message }>: what a pasted code holds,
//                                      judged by its own rules (teamcode.js decodeTeamCode + validateDecodedTeam), and refused when it names a Pokemon this ROM lacks. Never rejects
// A later stage that needs more of the pure layers (exports, saves) ADDS them here.

import * as ES from './editor_state.js';
import * as ED from './editor_data.js';
import * as LINKS from './editor_links.js';
import { resolveRuleset, DEFAULT_RULESET_ID } from './rules.js';
import { displayText } from './charset.js';
import { textIssue, PROFILE_LIMITS, defaultDeps } from './profile.js';
import { HIDDEN_POWER_TYPES } from './stats.js';
import { encodeTeamCode, decodeTeamCode, teamFromProfile, validateDecodedTeam } from './teamcode.js';

/** How many of a decoded team's problems the preview is given (the team screen's CHECK lists them all once the team is added). */
export const CODE_PROBLEMS_SHOWN = 4;
const msgOf = (e) => String(e && e.message ? e.message : e);

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
  const text = (s) => displayText(String(s === undefined || s === null ? '' : s)).replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const lines = (s) => text(s).split('\n');
  const flow = (s) => lines(s).join(' ').replace(/\s+/g, ' ').trim();

  async function encodeTeam(profile, teamId) {
    try { return { ok: true, code: await encodeTeamCode(teamFromProfile(profile, teamId)) }; }
    catch (e) { return { ok: false, code: e && e.code ? String(e.code) : 'encode.failed', message: 'This team cannot be turned into a code yet: ' + msgOf(e) }; }
  }
  async function decodeCode(codeText) {
    let r;
    try { r = await decodeTeamCode(codeText); } catch (e) { r = { ok: false, code: 'code.internal', message: 'the code could not be read: ' + msgOf(e) }; }
    if (!r.ok) return { ok: false, code: r.code, message: r.message };
    // a card naming a Pokemon this ROM has no entry for cannot be shown or edited: say which one, instead of adding a record nobody can open
    const missing = r.team.mons.map((m, i) => [i, m.species]).filter(([, sp]) => !pack.species[sp]);
    if (missing.length) return { ok: false, code: 'code.species-unknown', message: 'this code holds ' + (missing.length === 1 ? 'a Pokemon' : missing.length + ' Pokemon') + ' that this ROM does not have (slot ' + missing.map(([i, sp]) => (i + 1) + ': number ' + sp).join(', slot ') + '), so it cannot be opened here' };
    let v;
    try { v = validateDecodedTeam(r.team, pack); } catch (e) { return { ok: false, code: 'code.rules', message: 'the rules of this code could not be read: ' + msgOf(e) }; }
    return { ok: true, team: r.team, validation: { ok: v.ok, count: v.reasons.length, problems: v.reasons.slice(0, CODE_PROBLEMS_SHOWN).map((x) => ({ mon: x.mon === undefined ? null : x.mon, label: ED.fieldLabel(x.path), text: ED.reasonText(x.code, x.message) })) } };
  }
  return Object.freeze({ pack, deps: d, ES, ED, LINKS, HP_TYPES: HIDDEN_POWER_TYPES, reduce: (state, action) => ES.reduce(state, action, ctx), initialState: ES.initialState, rules, text, lines, flow, textIssue, LIMITS: PROFILE_LIMITS, encodeTeam, decodeCode });
}

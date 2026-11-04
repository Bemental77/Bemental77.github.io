// pokemonarena/js/editor_state.js -- the team / profile editor's state machine: a PURE reducer over the profile document.
//
// Pure ES module (browser + Node): no DOM, no storage, no clocks and no randomness of its own (ids and timestamps come from ctx.deps, like
// profile.js). reduce(state, action, ctx) never mutates its arguments and returns a NEW state; a rejected action returns a state whose
// `profile` is the SAME object as before (identity, not just equality) with `error` set -- so "invalid input is rejected" is testable as
// `next.profile === state.profile`.
//
//   import { initialState, reduce } from './editor_state.js';
//   let s = initialState(profile);                    // profile = a normalised v2 document (store.js loadProfile)
//   s = reduce(s, { type: 'monSet', monId, field: 'nature', value: 3 }, { pack });
//   if (s.error) show(s.error.message); else if (isDirty(s)) save(s.profile);
//
// WHAT LIVES HERE: every edit the editor can make (profile name, teams, team order, mons, species, level, nature, ability, item, gender,
// moves, EVs, stat points, IVs and their presets, ruleset switch / conform, team import), undo / redo, and the bookkeeping that tells the
// autosaver whether the document in memory is ahead of what was last written.
// WHAT DOES NOT: storage (store.js), screens (editor_views.js), the router, anything async. A team code is decoded by the caller and
// handed in as data.
//
// PRINCIPLES (each has a test in tools/pokemonarena_editor_test.mjs):
//   * A number that is not an integer is REJECTED (value.not-integer); an integer outside the field's range is CLAMPED with a notice.
//   * An enumerated field (nature, ability slot, gender, move, item, species) outside what rules.js allows is REJECTED, never clamped.
//   * What a ruleset fixes (Champions: Lv 50, IV 31, stat points) cannot be edited away: the edit is rejected with the ruleset's own code.
//   * Switching a team's ruleset changes ONLY the ruleset id (no data is destroyed); teamConform is the explicit, undoable "fix it" step.
//   * No committed state is ever one profile.js checkProfile() rejects, so the autosaver can never hit a ValidationError from an edit.
//   * Undo holds the last 20 edits (consecutive edits that share a `key` -- one slider drag -- are ONE edit). Undo restores teams, box, name
//     and settings only; the identity, the stats and the store's rev/updatedAt are never rolled back.

import {
  createMon, createTeam, newId, textIssue, checkProfile, checkMon, defaultDeps, PROFILE_LIMITS, SETTING_ENUMS,
} from './profile.js';
import { resolveRuleset, blankRec, RULESET_LAYERS } from './rules.js';
import {
  STAT_ORDER, LIMITS, pointsToEv, evToPoints, hiddenPowerIvs, snapEvsToMinimum, sumStats,
} from './stats.js';
import { monsFromDecoded } from './teamcode.js';
import { moveStatuses, itemStatus, genderOptions, defaultGender, abilityOptions, speciesExclusions, speciesComparator, SPECIES_SORT_IDS, SPECIES_SORTS } from './editor_data.js';

export const EDITOR_LIMITS = Object.freeze({ teamsMax: 16, undoMax: 20, teamSize: 6, boxMax: PROFILE_LIMITS.boxMax });
export const AVATAR_PRESETS = 52; // the ROM's trainer head portraits (speciesgfx.js TRAINER_HEAD_COUNT)
export const IV_PRESETS = Object.freeze(['all31', 'all0', 'zeroAtk', 'zeroSpe', 'zeroAtkSpe']);

const clone = (o) => JSON.parse(JSON.stringify(o));
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

// ---------------------------------------------------------------------------------------------
// ruleset ids <-> the choices the rules panel shows
// ---------------------------------------------------------------------------------------------

/** The level / points modes (mutually exclusive layers) and the two independent clause layers, in the order the panel shows them. */
export const LEVEL_MODES = Object.freeze(['standard', 'lv5', 'lv100', 'strict-champions']);

/** 'arena-gen3-standard+lv5+item-clause' -> { mode: 'lv5', itemClause: true, noSpeciesClause: false, unknown: [] }. Throws RangeError on an id rules.js refuses. */
export function parseRulesetId(id) {
  const R = resolveRuleset(id);
  const layers = R.id.split('+').slice(1);
  const mode = LEVEL_MODES.find((m) => m !== 'standard' && layers.includes(m)) || 'standard';
  const known = new Set([...LEVEL_MODES, 'item-clause', 'no-species-clause']);
  return { mode, itemClause: layers.includes('item-clause'), noSpeciesClause: layers.includes('no-species-clause'), unknown: layers.filter((l) => !known.has(l)) };
}
/** The inverse (rules.js canonicalises layer order). `keep` carries over layers the panel does not know. */
export function buildRulesetId({ mode = 'standard', itemClause = false, noSpeciesClause = false, keep = [] } = {}) {
  const layers = [];
  if (mode !== 'standard') layers.push(mode);
  if (itemClause) layers.push('item-clause');
  if (noSpeciesClause) layers.push('no-species-clause');
  for (const k of keep) if (!layers.includes(k) && RULESET_LAYERS.includes(k)) layers.push(k);
  return resolveRuleset(['arena-gen3-standard', ...layers].join('+')).id;
}
const MODE_LABEL = { standard: 'Standard (Lv 50, 510 EV)', lv5: 'Level 5', lv100: 'Level 100', 'strict-champions': 'Champions (Lv 50, stat points)' };
/** A short human name for a ruleset id. */
export function rulesetLabel(id) {
  let p;
  try { p = parseRulesetId(id); } catch (_e) { return String(id); }
  const extra = [];
  if (p.itemClause) extra.push('item clause');
  if (p.noSpeciesClause) extra.push('duplicates allowed');
  return MODE_LABEL[p.mode] + (extra.length ? ', ' + extra.join(', ') : '');
}

// ---------------------------------------------------------------------------------------------
// selectors
// ---------------------------------------------------------------------------------------------

export const findTeam = (profile, teamId) => profile.teams.find((t) => t.id === teamId) || null;
export const findMon = (profile, monId) => profile.box.find((m) => m.id === monId) || null;
export const teamOfMon = (profile, monId) => profile.teams.find((t) => t.monIds.includes(monId)) || null;
export const teamMonsOf = (profile, teamId) => { const t = findTeam(profile, teamId); return t ? t.monIds.map((id) => findMon(profile, id)).filter(Boolean) : []; };
/** The ruleset a stored mon is edited under: its team's, else the profile's default. */
export function rulesetIdOfMon(profile, monId) { const t = teamOfMon(profile, monId); return t ? t.ruleset : profile.settings.defaultRuleset; }
export const unusedMons = (profile) => { const used = new Set(profile.teams.flatMap((t) => t.monIds)); return profile.box.filter((m) => !used.has(m.id)); };
export const isDirty = (state) => state.seq > state.savedSeq;
export const canUndo = (state) => state.undo.length > 0;
export const canRedo = (state) => state.redo.length > 0;

// ---------------------------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------------------------

/** { profile, seq, savedSeq, undo[], redo[], lastKey, error, notice, result, readOnly }. */
export function initialState(profile, { readOnly = false } = {}) {
  return { profile, seq: 0, savedSeq: 0, undo: [], redo: [], lastKey: null, error: null, notice: null, result: null, readOnly: !!readOnly };
}

const reject = (state, type, code, message, detail) => ({ ...state, error: { code, message, action: type, ...(detail || {}) }, notice: null, result: null });

function restoreContent(current, snapshot) {
  return { ...current, trainerName: snapshot.trainerName, avatar: snapshot.avatar, settings: snapshot.settings, teams: snapshot.teams, box: snapshot.box };
}

const LABELS = {
  rename: 'rename profile', avatar: 'change avatar', setting: 'change setting', teamCreate: 'new team', teamRename: 'rename team', teamDuplicate: 'duplicate team', teamDelete: 'delete team',
  teamMove: 'reorder teams', teamRuleset: 'change rules', teamConform: 'convert team to its rules', teamImport: 'import team', saveImport: 'import from a save', monAdd: 'add Pokemon', monRemove: 'remove Pokemon',
  monMove: 'reorder Pokemon', teamSort: 'sort Pokemon', monDuplicate: 'duplicate Pokemon', monSet: 'edit Pokemon', moveSet: 'change move', moveReorder: 'reorder moves', evSet: 'change EVs',
  ivSet: 'change IVs', ivPreset: 'IV preset', evSnap: 'snap EVs', evReset: 'reset EVs', boxCleanup: 'clean up the box',
};

function commit(state, type, next, meta = {}) {
  const check = checkProfile(next);
  if (check.length) return reject(state, type, 'internal.invalid', 'the edit would produce an invalid profile: ' + check[0].code + ' ' + check[0].path, { problems: check.slice(0, 3) });
  const coalesce = !!meta.key && state.lastKey === meta.key && state.undo.length > 0;
  const undo = coalesce ? state.undo : state.undo.concat([{ profile: state.profile, label: meta.label || LABELS[type] || type }]).slice(-EDITOR_LIMITS.undoMax);
  return { ...state, profile: next, seq: state.seq + 1, undo, redo: [], lastKey: meta.key || null, error: null, notice: meta.notice || null, result: meta.result || null };
}

function nextNameLike(base, existing, max) {
  const names = new Set(existing);
  for (let n = 2; n < 1000; n++) {
    const suffix = ' ' + n;
    const cand = base.slice(0, Math.max(0, max - suffix.length)) + suffix;
    if (!names.has(cand) && !textIssue(cand, max)) return cand;
  }
  return base;
}
function defaultTeamName(existing) {
  const names = new Set(existing);
  for (let n = existing.length + 1; n < 1000; n++) { const c = 'TEAM ' + n; if (!names.has(c)) return c; }
  return 'TEAM';
}
function cleanText(value, max) {
  if (typeof value !== 'string') return { ok: false, code: 'text.type', message: 'expected text' };
  const issue = textIssue(value, max);
  if (issue === 'length') return { ok: false, code: 'text.length', message: `at most ${max} characters` };
  if (issue === 'chars') return { ok: false, code: 'text.chars', message: 'braces and control characters are not allowed' };
  if (issue) return { ok: false, code: 'text.charset', message: 'that text uses a character the game font cannot draw' };
  return { ok: true, value };
}
/** { ok:true, value, clamped } for an integer (clamped into [lo, hi] with a flag), else { ok:false } for anything that is not an integer. */
function intIn(value, lo, hi) {
  if (!isInt(value)) return { ok: false, code: 'value.not-integer', message: 'expected a whole number' };
  const v = Math.max(lo, Math.min(hi, value));
  return { ok: true, value: v, clamped: v !== value };
}
const clampNotice = (field, v) => ({ code: 'clamped', message: `${field} was limited to ${v}` });

const gcBox = (profile) => { const used = new Set(profile.teams.flatMap((t) => t.monIds)); profile.box = profile.box.filter((m) => used.has(m.id)); };

// ---------------------------------------------------------------------------------------------
// conforming a mon to a ruleset (the explicit, undoable fix after a ruleset switch)
// ---------------------------------------------------------------------------------------------

/**
 * A copy of `mon` made to satisfy what `ruleset` FIXES or CAPS: level, IVs, nature range, ability slot, held item, EVs / stat points (snapped to
 * the 4-then-8 grid in points mode, trimmed to the budget from the last stat backwards), moves (illegal ones dropped; if none is left the earliest
 * legal level-up move), gender. It cannot fix a banned species or a team-level clause. Returns { mon, changed: [field names] }.
 */
export function conformMon(mon, pack, ruleset, deps) {
  const R = typeof ruleset === 'string' ? resolveRuleset(ruleset) : ruleset;
  const d = { ...defaultDeps(), ...(deps || {}) };
  const m = clone(mon);
  const changed = new Set();
  const set = (field, obj, key, v) => { if (obj[key] !== v) { obj[key] = v; changed.add(field); } };
  const sp = pack.species[m.species];

  set('level', m, 'level', R.level.fixed !== null ? R.level.fixed : Math.max(R.level.min, Math.min(R.level.max, m.level)));
  for (const k of STAT_ORDER) set('iv', m.iv, k, R.iv.fixed !== null ? R.iv.fixed : Math.max(R.iv.min, Math.min(R.iv.max, m.iv[k])));
  if (m.nature >= Math.min(R.nature.count, pack.natures.length)) set('nature', m, 'nature', 0);

  if (sp && sp.legal) {
    const opts = abilityOptions(pack, m.species, R).slots.filter((s) => s.allowed);
    if (opts.length && !opts.some((s) => s.slot === m.abilitySlot)) set('ability', m, 'abilitySlot', opts[0].slot);
    const g = defaultGender(pack, m.species, m.gender);
    set('gender', m, 'gender', g);
  }
  if (m.heldItem !== 0 && !itemStatus(pack, m.heldItem, R).ok) set('item', m, 'heldItem', 0);

  // EVs / stat points
  const ev = { ...m.ev };
  for (const k of STAT_ORDER) ev[k] = Math.min(ev[k], R.ev.perStat);
  if (R.points) {
    const pts = {};
    for (const k of STAT_ORDER) pts[k] = Math.min(evToPoints(ev[k], m.iv[k]), R.points.perStat);
    let over = sumStats(pts) - R.points.total;
    for (let i = STAT_ORDER.length - 1; i >= 0 && over > 0; i--) { const k = STAT_ORDER[i]; const cut = Math.min(pts[k], over); pts[k] -= cut; over -= cut; }
    for (const k of STAT_ORDER) ev[k] = pointsToEv(pts[k], m.iv[k]);
  } else if (R.ev.total !== null) {
    let over = sumStats(ev) - R.ev.total;
    for (let i = STAT_ORDER.length - 1; i >= 0 && over > 0; i--) { const k = STAT_ORDER[i]; const cut = Math.min(ev[k], over); ev[k] -= cut; over -= cut; }
  }
  for (const k of STAT_ORDER) set('ev', m.ev, k, ev[k]);

  // moves: keep what rules.js still allows (a dropped move is the only data conform ever deletes, and it was illegal)
  if (sp && sp.legal && !R.banned.species.includes(m.species)) {
    const ids = [...new Set(m.moves.map((x) => x.id))];
    const rec = { species: m.species, level: m.level, nature: m.nature, abilitySlot: m.abilitySlot, item: 0, moves: [], ivs: { ...m.iv }, evs: { ...m.ev } };
    const st = moveStatuses(pack, rec, ids, R);
    let keep = m.moves.filter((x, i) => st[x.id].ok && m.moves.findIndex((y) => y.id === x.id) === i).slice(0, R.moves.max);
    if (keep.length === 0) {
      try { keep = [{ id: blankRec(m.species, pack, R).moves[0], ppUps: 0 }]; } catch (_e) { keep = m.moves.slice(0, 1); }
    }
    if (JSON.stringify(keep) !== JSON.stringify(m.moves)) { m.moves = keep; changed.add('moves'); }
  }
  if (changed.size) m.updatedAt = d.now();
  return { mon: m, changed: [...changed] };
}

// ---------------------------------------------------------------------------------------------
// the reducer
// ---------------------------------------------------------------------------------------------

/**
 * reduce(state, action, ctx). ctx = { pack (required for any action that reads the ROM tables), deps: { now, randomBytes } }.
 * Unknown action types and actions on missing ids are rejected, never thrown. Returns a new state.
 */
export function reduce(state, action, ctx = {}) {
  try {
    return step(state, action, ctx);
  } catch (e) {
    return reject(state, action && action.type, 'internal.error', 'unexpected failure: ' + (e && e.message ? e.message : String(e)));
  }
}

const MUTATING = new Set(Object.keys(LABELS));

function step(state, action, ctx) {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') return reject(state, undefined, 'action.shape', 'an action is { type, ... }');
  const type = action.type;
  const deps = { ...defaultDeps(), ...(ctx.deps || {}) };
  const pack = ctx.pack;
  const resolve = ctx.resolve || resolveRuleset; // a test seam: lets a test hand the reducer a ruleset with a ban list; production never passes it

  // ---- non-document actions
  if (type === 'load') {
    if (!action.profile) return reject(state, type, 'load.profile', 'load needs a profile');
    return initialState(action.profile, { readOnly: action.readOnly });
  }
  if (type === 'saved') { // the store accepted seq `action.seq` as rev `action.rev`
    if (!isInt(action.rev) || !isInt(action.seq) || action.seq > state.seq) return reject(state, type, 'saved.shape', 'saved needs { rev, seq }');
    return { ...state, profile: { ...state.profile, rev: action.rev, updatedAt: isInt(action.updatedAt) ? action.updatedAt : state.profile.updatedAt }, savedSeq: Math.max(state.savedSeq, action.seq), error: null };
  }
  if (type === 'setIdentity') { // the identity is the browser's, not an edit: no undo entry, but it must reach the store
    return { ...state, profile: { ...state.profile, identity: clone(action.identity) }, seq: state.seq + 1, error: null };
  }
  if (type === 'undo') {
    if (!state.undo.length) return reject(state, type, 'undo.empty', 'nothing to undo');
    const entry = state.undo[state.undo.length - 1];
    return { ...state, profile: restoreContent(state.profile, entry.profile), undo: state.undo.slice(0, -1), redo: state.redo.concat([{ profile: state.profile, label: entry.label }]), seq: state.seq + 1, lastKey: null, error: null, notice: { code: 'undo', message: 'undid: ' + entry.label }, result: null };
  }
  if (type === 'redo') {
    if (!state.redo.length) return reject(state, type, 'redo.empty', 'nothing to redo');
    const entry = state.redo[state.redo.length - 1];
    return { ...state, profile: restoreContent(state.profile, entry.profile), redo: state.redo.slice(0, -1), undo: state.undo.concat([{ profile: state.profile, label: entry.label }]), seq: state.seq + 1, lastKey: null, error: null, notice: { code: 'redo', message: 'redid: ' + entry.label }, result: null };
  }
  if (type === 'clearMessages') return { ...state, error: null, notice: null, result: null };
  if (type === 'rebase') { // another tab saved first and the player chose to keep THIS tab's edits: adopt the store's rev, stay dirty
    if (!isInt(action.rev) || action.rev < 0) return reject(state, type, 'rebase.shape', 'rebase needs a rev');
    return { ...state, profile: { ...state.profile, rev: action.rev }, seq: state.seq + 1, error: null };
  }

  if (!MUTATING.has(type)) return reject(state, type, 'action.unknown', 'unknown action ' + type);
  if (state.readOnly) return reject(state, type, 'profile.readonly', 'this profile was saved by a newer version of the app and is read-only here');
  const P = state.profile;

  // ---- profile level
  if (type === 'rename') {
    const t = cleanText(action.name, PROFILE_LIMITS.trainerName);
    if (!t.ok) return reject(state, type, 'name.' + t.code, 'name: ' + t.message);
    if (t.value.trim() === '') return reject(state, type, 'name.empty', 'the name cannot be empty');
    if (t.value === P.trainerName) return { ...state, error: null, notice: null, result: null };
    return commit(state, type, { ...P, trainerName: t.value });
  }
  if (type === 'avatar') {
    const kind = action.kind, id = action.id;
    if (kind !== 'preset' && kind !== 'mon') return reject(state, type, 'avatar.kind', 'avatar kind is preset or mon');
    if (!isInt(id) || id < 0) return reject(state, type, 'avatar.id', 'avatar id must be a whole number');
    if (kind === 'preset' && id >= AVATAR_PRESETS) return reject(state, type, 'avatar.id', 'there are ' + AVATAR_PRESETS + ' preset avatars');
    if (kind === 'mon') {
      const sp = pack ? pack.species[id] : null;
      if (!sp || !sp.legal) return reject(state, type, 'avatar.id', 'that species is not on the roster');
    }
    if (P.avatar.kind === kind && P.avatar.id === id) return { ...state, error: null, notice: null, result: null };
    return commit(state, type, { ...P, avatar: { kind, id } });
  }
  if (type === 'setting') {
    const key = action.key;
    const s = { ...P.settings };
    if (key === 'defaultRuleset') {
      let id; try { id = resolveRuleset(action.value).id; } catch (e) { return reject(state, type, 'setting.ruleset', 'unknown ruleset'); }
      s.defaultRuleset = id;
    } else if (Object.prototype.hasOwnProperty.call(SETTING_ENUMS, key)) {
      if (!SETTING_ENUMS[key].includes(action.value)) return reject(state, type, 'setting.value', `${key} must be one of ${SETTING_ENUMS[key].join(', ')}`);
      s[key] = action.value;
    } else if (key === 'sound' || key === 'reducedMotion') {
      if (typeof action.value !== 'boolean') return reject(state, type, 'setting.value', key + ' must be true or false');
      s[key] = action.value;
    } else return reject(state, type, 'setting.key', 'unknown setting ' + String(key));
    return commit(state, type, { ...P, settings: s });
  }

  // ---- teams
  if (type === 'teamCreate') {
    if (P.teams.length >= EDITOR_LIMITS.teamsMax) return reject(state, type, 'teams.full', `a profile holds at most ${EDITOR_LIMITS.teamsMax} teams`);
    const name = action.name === undefined ? defaultTeamName(P.teams.map((t) => t.name)) : action.name;
    const t = cleanText(name, PROFILE_LIMITS.teamName);
    if (!t.ok || t.value.trim() === '') return reject(state, type, 'name.' + (t.ok ? 'empty' : t.code), 'team name: ' + (t.ok ? 'cannot be empty' : t.message));
    let rs;
    try { rs = resolveRuleset(action.ruleset === undefined ? P.settings.defaultRuleset : action.ruleset).id; } catch (e) { return reject(state, type, 'ruleset.unknown', 'unknown ruleset'); }
    const team = createTeam({ name: t.value, ruleset: rs, monIds: [] }, deps);
    return commit(state, type, { ...P, teams: P.teams.concat([team]) }, { result: { teamId: team.id } });
  }
  if (type === 'teamRename') {
    const team = findTeam(P, action.teamId);
    if (!team) return reject(state, type, 'team.missing', 'no such team');
    const t = cleanText(action.name, PROFILE_LIMITS.teamName);
    if (!t.ok) return reject(state, type, 'name.' + t.code, 'team name: ' + t.message);
    if (t.value.trim() === '') return reject(state, type, 'name.empty', 'the team name cannot be empty');
    if (t.value === team.name) return { ...state, error: null, notice: null, result: null };
    return commit(state, type, { ...P, teams: P.teams.map((x) => (x === team ? { ...x, name: t.value } : x)) });
  }
  if (type === 'teamDuplicate') {
    const team = findTeam(P, action.teamId);
    if (!team) return reject(state, type, 'team.missing', 'no such team');
    if (P.teams.length >= EDITOR_LIMITS.teamsMax) return reject(state, type, 'teams.full', `a profile holds at most ${EDITOR_LIMITS.teamsMax} teams`);
    const mons = teamMonsOf(P, team.id).map((m) => ({ ...clone(m), id: newId('m', deps), createdAt: deps.now(), updatedAt: deps.now() }));
    if (P.box.length + mons.length > EDITOR_LIMITS.boxMax) return reject(state, type, 'box.full', 'the box is full');
    const copy = createTeam({ name: nextNameLike(team.name, P.teams.map((t) => t.name), PROFILE_LIMITS.teamName), ruleset: team.ruleset, monIds: mons.map((m) => m.id) }, deps);
    const teams = P.teams.slice();
    teams.splice(P.teams.indexOf(team) + 1, 0, copy);
    return commit(state, type, { ...P, teams, box: P.box.concat(mons) }, { result: { teamId: copy.id } });
  }
  if (type === 'teamDelete') {
    const team = findTeam(P, action.teamId);
    if (!team) return reject(state, type, 'team.missing', 'no such team');
    const next = { ...P, teams: P.teams.filter((t) => t !== team), box: P.box.slice() };
    gcBox(next);
    return commit(state, type, next, { label: `delete team ${team.name}` });
  }
  if (type === 'teamMove') {
    const i = P.teams.findIndex((t) => t.id === action.teamId);
    if (i < 0) return reject(state, type, 'team.missing', 'no such team');
    const to = intIn(action.to, 0, P.teams.length - 1);
    if (!to.ok) return reject(state, type, to.code, to.message);
    if (to.value === i) return { ...state, error: null, notice: null, result: null };
    const teams = P.teams.slice();
    teams.splice(to.value, 0, teams.splice(i, 1)[0]);
    return commit(state, type, { ...P, teams });
  }
  if (type === 'teamRuleset') {
    const team = findTeam(P, action.teamId);
    if (!team) return reject(state, type, 'team.missing', 'no such team');
    let id; try { id = resolveRuleset(action.ruleset).id; } catch (e) { return reject(state, type, 'ruleset.unknown', 'unknown ruleset'); }
    if (id === team.ruleset) return { ...state, error: null, notice: null, result: null };
    return commit(state, type, { ...P, teams: P.teams.map((x) => (x === team ? { ...x, ruleset: id } : x)) }, { notice: { code: 'ruleset-changed', message: 'rules changed; nothing in the team was edited. Use "Convert team" to make it fit.' } });
  }
  if (type === 'teamConform') {
    const team = findTeam(P, action.teamId);
    if (!team) return reject(state, type, 'team.missing', 'no such team');
    if (!pack) return reject(state, type, 'ctx.pack', 'this action needs the ROM tables');
    const byId = new Map();
    const changedFields = new Set();
    for (const m of teamMonsOf(P, team.id)) {
      const r = conformMon(m, pack, resolve(team.ruleset), deps);
      if (r.changed.length) { byId.set(m.id, r.mon); r.changed.forEach((f) => changedFields.add(f)); }
    }
    if (!byId.size) return { ...state, error: null, notice: { code: 'conform.nothing', message: 'the team already fits its rules' }, result: null };
    return commit(state, type, { ...P, box: P.box.map((m) => byId.get(m.id) || m) }, { notice: { code: 'conformed', message: `converted ${byId.size} Pokemon (${[...changedFields].join(', ')})` }, result: { changed: byId.size, fields: [...changedFields] } });
  }
  if (type === 'teamImport') {
    if (P.teams.length >= EDITOR_LIMITS.teamsMax) return reject(state, type, 'teams.full', `a profile holds at most ${EDITOR_LIMITS.teamsMax} teams`);
    const src = action.team;
    if (!src || !Array.isArray(src.mons) || src.mons.length < 1 || src.mons.length > EDITOR_LIMITS.teamSize) return reject(state, type, 'import.shape', 'the team needs 1 to 6 Pokemon');
    let rs; try { rs = resolveRuleset(src.ruleset).id; } catch (e) { return reject(state, type, 'ruleset.unknown', 'the team uses a ruleset this version does not know'); }
    if (P.box.length + src.mons.length > EDITOR_LIMITS.boxMax) return reject(state, type, 'box.full', 'the box is full');
    // a Pokemon whose number this ROM has no entry for cannot be shown, edited or fought with: refuse the card instead of storing a record nobody can open
    if (pack) {
      const bad = src.mons.findIndex((m) => !m || !isInt(m.species) || !pack.species[m.species]);
      if (bad >= 0) return reject(state, type, 'species.unknown', `Pokemon ${bad + 1} in this team is not in this ROM`);
    }
    let mons;
    try { mons = monsFromDecoded(src, deps); } catch (e) { return reject(state, type, 'import.invalid', 'a Pokemon in this team is not well formed: ' + (e && e.message ? e.message : e)); }
    const nm = cleanText(typeof src.name === 'string' ? src.name : '', PROFILE_LIMITS.teamName);
    const name = nm.ok && nm.value.trim() !== '' ? nm.value : defaultTeamName(P.teams.map((t) => t.name));
    const team = createTeam({ name, ruleset: rs, monIds: mons.map((m) => m.id) }, deps);
    return commit(state, type, { ...P, teams: P.teams.concat([team]), box: P.box.concat(mons) }, { result: { teamId: team.id } });
  }

  // W1: Pokemon read from a SoulGold save file (saveimport.js importSave records, origin 'save-import') join the profile, either as a NEW team or
  // appended to an existing one. Every record is shape-checked here (checkMon), gets a fresh id (importing the same save twice never collides),
  // and is stored as it is: a record that fails its team's rules is kept and flagged in the team list, exactly like a team code that does.
  if (type === 'saveImport') {
    const src = action.mons;
    if (!Array.isArray(src) || src.length < 1 || src.length > EDITOR_LIMITS.teamSize) return reject(state, type, 'import.shape', 'choose 1 to 6 Pokemon to import');
    if (P.box.length + src.length > EDITOR_LIMITS.boxMax) return reject(state, type, 'box.full', 'the box is full');
    for (let i = 0; i < src.length; i++) {
      const m = src[i];
      if (!m || typeof m !== 'object' || !isInt(m.species) || (pack && !pack.species[m.species])) return reject(state, type, 'species.unknown', `Pokemon ${i + 1} is not in this ROM`);
      const bad = checkMon(m, 'mon');
      if (bad.length) return reject(state, type, 'import.invalid', `Pokemon ${i + 1} is not a well formed record: ${bad[0].code} ${bad[0].path}`, { problems: bad.slice(0, 3) });
    }
    const mons = src.map((m) => ({ ...clone(m), id: newId('m', deps), origin: 'save-import' }));
    if (action.teamId === null || action.teamId === undefined) {
      if (P.teams.length >= EDITOR_LIMITS.teamsMax) return reject(state, type, 'teams.full', `a profile holds at most ${EDITOR_LIMITS.teamsMax} teams`);
      let rs; try { rs = resolveRuleset(action.ruleset ?? P.settings.defaultRuleset).id; } catch (e) { return reject(state, type, 'ruleset.unknown', 'unknown ruleset'); }
      const nm = cleanText(typeof action.name === 'string' && action.name.trim() !== '' ? action.name : 'SAVE PARTY', PROFILE_LIMITS.teamName);
      const name = nm.ok ? nm.value : defaultTeamName(P.teams.map((t) => t.name));
      const team = createTeam({ name, ruleset: rs, monIds: mons.map((m) => m.id) }, deps);
      return commit(state, type, { ...P, teams: P.teams.concat([team]), box: P.box.concat(mons) }, { result: { teamId: team.id, count: mons.length } });
    }
    const team = findTeam(P, action.teamId);
    if (!team) return reject(state, type, 'team.missing', 'no such team');
    const R = resolve(team.ruleset);
    const room = Math.min(R.team.max, EDITOR_LIMITS.teamSize) - team.monIds.length;
    if (mons.length > room) return reject(state, type, 'team.full', `this team has room for ${Math.max(0, room)} more Pokemon`);
    const teams = P.teams.map((t) => (t === team ? { ...t, monIds: t.monIds.concat(mons.map((m) => m.id)) } : t));
    return commit(state, type, { ...P, teams, box: P.box.concat(mons) }, { result: { teamId: team.id, count: mons.length } });
  }

  // ---- mons in a team
  if (type === 'monAdd') {
    const team = findTeam(P, action.teamId);
    if (!team) return reject(state, type, 'team.missing', 'no such team');
    if (!pack) return reject(state, type, 'ctx.pack', 'this action needs the ROM tables');
    const R = resolve(team.ruleset);
    if (team.monIds.length >= Math.min(R.team.max, EDITOR_LIMITS.teamSize)) return reject(state, type, 'team.full', `this team already has ${team.monIds.length} Pokemon`);
    if (P.box.length >= EDITOR_LIMITS.boxMax) return reject(state, type, 'box.full', 'the box is full');
    const sp = isInt(action.species) ? pack.species[action.species] : null;
    if (!sp) return reject(state, type, 'species.unknown', 'unknown species');
    if (!sp.legal) return reject(state, type, 'species.illegal', 'that species is not on the roster');
    { const ex = speciesExclusions(pack, R).get(action.species); if (ex) return reject(state, type, ex.code, ex.text, { species: action.species }); }
    let rec;
    try { rec = blankRec(action.species, pack, R); } catch (e) { return reject(state, type, 'species.unusable', 'this species has no legal starting set under these rules: ' + e.message); }
    const iv = {}, ev = {};
    for (const k of STAT_ORDER) { iv[k] = R.iv.fixed !== null ? R.iv.fixed : (rec.ivs ? rec.ivs[k] : LIMITS.ivMax); ev[k] = 0; }
    const mon = createMon({ species: action.species, level: rec.level, nature: 0, abilitySlot: rec.abilitySlot, heldItem: 0, moves: rec.moves, ev, iv, gender: defaultGender(pack, action.species, 'M'), origin: 'custom' }, deps);
    const teams = P.teams.map((t) => (t === team ? { ...t, monIds: t.monIds.concat([mon.id]) } : t));
    return commit(state, type, { ...P, teams, box: P.box.concat([mon]) }, { result: { monId: mon.id, teamId: team.id } });
  }
  if (type === 'monRemove') {
    const team = findTeam(P, action.teamId);
    if (!team || !team.monIds.includes(action.monId)) return reject(state, type, 'mon.missing', 'that Pokemon is not in this team');
    const next = { ...P, teams: P.teams.map((t) => (t === team ? { ...t, monIds: t.monIds.filter((id) => id !== action.monId) } : t)), box: P.box.slice() };
    gcBox(next);
    return commit(state, type, next);
  }
  if (type === 'monMove') {
    const team = findTeam(P, action.teamId);
    if (!team) return reject(state, type, 'team.missing', 'no such team');
    const i = team.monIds.indexOf(action.monId);
    if (i < 0) return reject(state, type, 'mon.missing', 'that Pokemon is not in this team');
    const to = intIn(action.to, 0, team.monIds.length - 1);
    if (!to.ok) return reject(state, type, to.code, to.message);
    if (to.value === i) return { ...state, error: null, notice: null, result: null };
    const ids = team.monIds.slice();
    ids.splice(to.value, 0, ids.splice(i, 1)[0]);
    return commit(state, type, { ...P, teams: P.teams.map((t) => (t === team ? { ...t, monIds: ids } : t)) });
  }
  if (type === 'teamSort') {
    // Put a team's Pokemon in Pokedex, name or type order. This is the team's SLOT order: in a 6v6 battle the lead is chosen at the lead preview (engine.js: a `lead` battle starts in the
    // 'preview' phase) and the rest follow in this order, in 3v3 the lead is the first of the three picks at team preview (a `pick` battle), so nothing here promises a lead. One undo step; equal Pokemon keep the order they had.
    // Both outcomes carry a notice, because the screen says nothing else: 'team.sorted' (what the new order is) and 'team.in-order' (nothing moved, and why).
    const team = findTeam(P, action.teamId);
    if (!team) return reject(state, type, 'team.missing', 'no such team');
    if (!pack) return reject(state, type, 'ctx.pack', 'this action needs the ROM tables');
    if (!SPECIES_SORT_IDS.includes(action.by)) return reject(state, type, 'sort.unknown', 'sort by dex, name or type');
    const cmp = speciesComparator(pack, action.by);
    const speciesOf = (id) => { const m = findMon(P, id); return m ? m.species : -1; };
    const ids = team.monIds.map((id, i) => ({ id, i })).sort((a, b) => cmp(speciesOf(a.id), speciesOf(b.id)) || a.i - b.i).map((x) => x.id);
    const how = SPECIES_SORTS.find((x) => x[0] === action.by)[1].toLowerCase();
    if (ids.every((id, i) => id === team.monIds[i])) return { ...state, error: null, notice: { code: 'team.in-order', message: `the team is already sorted by ${how}` }, result: null };
    const nameOf = (id) => { const m = findMon(P, id); const sp = m ? pack.species[m.species] : null; return (m && m.nickname) || (sp ? sp.name : '?'); };
    return commit(state, type, { ...P, teams: P.teams.map((t) => (t === team ? { ...t, monIds: ids } : t)) }, { notice: { code: 'team.sorted', message: `sorted by ${how}: ${ids.map(nameOf).join(', ')}` } });
  }
  if (type === 'monDuplicate') {
    const team = findTeam(P, action.teamId);
    const mon = team && team.monIds.includes(action.monId) ? findMon(P, action.monId) : null;
    if (!mon) return reject(state, type, 'mon.missing', 'that Pokemon is not in this team');
    const R = resolve(team.ruleset);
    if (team.monIds.length >= Math.min(R.team.max, EDITOR_LIMITS.teamSize)) return reject(state, type, 'team.full', 'the team is full');
    if (P.box.length >= EDITOR_LIMITS.boxMax) return reject(state, type, 'box.full', 'the box is full');
    const copy = { ...clone(mon), id: newId('m', deps), createdAt: deps.now(), updatedAt: deps.now() };
    const ids = team.monIds.slice();
    ids.splice(ids.indexOf(mon.id) + 1, 0, copy.id);
    return commit(state, type, { ...P, teams: P.teams.map((t) => (t === team ? { ...t, monIds: ids } : t)), box: P.box.concat([copy]) }, { result: { monId: copy.id, teamId: team.id } });
  }
  if (type === 'boxCleanup') {
    const n = unusedMons(P).length;
    if (!n) return { ...state, error: null, notice: { code: 'box.clean', message: 'every Pokemon in the box is on a team' }, result: null };
    const next = { ...P, box: P.box.slice() };
    gcBox(next);
    return commit(state, type, next, { notice: { code: 'box.cleaned', message: `removed ${n} Pokemon that were on no team` } });
  }

  // ---- everything below edits ONE mon
  const mon = findMon(P, action.monId);
  if (!mon) return reject(state, type, 'mon.missing', 'no such Pokemon');
  if (!pack) return reject(state, type, 'ctx.pack', 'this action needs the ROM tables');
  const R = resolve(rulesetIdOfMon(P, mon.id));
  const m = clone(mon);
  const stamp = () => { m.updatedAt = deps.now(); return { ...P, box: P.box.map((x) => (x === mon ? m : x)) }; };

  if (type === 'monSet') {
    const field = action.field;
    const v = action.value;
    let notice = null;
    if (field === 'nickname') {
      const t = cleanText(v, PROFILE_LIMITS.nickname);
      if (!t.ok) return reject(state, type, 'nickname.' + t.code, 'nickname: ' + t.message);
      m.nickname = t.value;
    } else if (field === 'level') {
      const r = intIn(v, R.level.min, R.level.max);
      if (!r.ok) return reject(state, type, r.code, r.message);
      if (R.level.fixed !== null && r.value !== R.level.fixed) return reject(state, type, 'level.fixed', `these rules fix the level at ${R.level.fixed}`, { expected: R.level.fixed });
      m.level = r.value;
      if (r.clamped) notice = clampNotice('level', r.value);
    } else if (field === 'nature') {
      const r = intIn(v, 0, 24);
      const limit = Math.min(R.nature.count, pack.natures.length);
      if (!r.ok || r.clamped || r.value >= limit) return reject(state, type, 'nature.range', `nature must be 0 to ${limit - 1}`);
      m.nature = r.value;
    } else if (field === 'abilitySlot') {
      if (!isInt(v) || v < 0 || v > 2) return reject(state, type, 'ability.slot-range', 'ability slot must be 0, 1 or 2');
      const slot = abilityOptions(pack, m.species, R).slots.find((s) => s.slot === v);
      if (!slot) return reject(state, type, 'ability.slot-empty', 'this species has no ability in that slot');
      if (!slot.allowed) return reject(state, type, slot.code, slot.text);
      m.abilitySlot = v;
    } else if (field === 'heldItem') {
      if (!isInt(v) || v < 0 || v >= pack.items.length) return reject(state, type, 'item.unknown', 'unknown item');
      if (v !== 0) { const st = itemStatus(pack, v, R); if (!st.ok) return reject(state, type, st.code, st.text, { item: v }); }
      m.heldItem = v;
    } else if (field === 'gender') {
      if (!genderOptions(pack, m.species).includes(v)) return reject(state, type, 'gender.species', 'this species cannot be that gender');
      m.gender = v;
    } else if (field === 'shiny') {
      if (typeof v !== 'boolean') return reject(state, type, 'shiny.type', 'shiny is true or false');
      m.shiny = v;
    } else if (field === 'friendship') {
      const r = intIn(v, 0, 255);
      if (!r.ok) return reject(state, type, r.code, r.message);
      m.friendship = r.value;
      if (r.clamped) notice = clampNotice('friendship', r.value);
    } else if (field === 'species') {
      const nsp = isInt(v) ? pack.species[v] : null;
      if (!nsp) return reject(state, type, 'species.unknown', 'unknown species');
      if (!nsp.legal) return reject(state, type, 'species.illegal', 'that species is not on the roster');
      { const ex = speciesExclusions(pack, R).get(v); if (ex && v !== m.species) return reject(state, type, ex.code, ex.text, { species: v }); }
      if (v === m.species) return { ...state, error: null, notice: null, result: null };
      m.species = v;
      m.gender = defaultGender(pack, v, m.gender);
      const slots = abilityOptions(pack, v, R).slots.filter((s) => s.allowed);
      if (!slots.some((s) => s.slot === m.abilitySlot)) m.abilitySlot = slots.length ? slots[0].slot : 0;
      // keep the moves the new species can still learn; if none, give it its earliest legal level-up move
      const ids = m.moves.map((x) => x.id);
      const st = moveStatuses(pack, { species: v, level: m.level, nature: m.nature, abilitySlot: m.abilitySlot, item: 0, moves: [], ivs: { ...m.iv }, evs: { ...m.ev } }, ids, R);
      let keep = m.moves.filter((x) => st[x.id].ok);
      const dropped = m.moves.length - keep.length;
      if (!keep.length) { try { keep = [{ id: blankRec(v, pack, R).moves[0], ppUps: 0 }]; } catch (_e) { return reject(state, type, 'species.unusable', 'that species has no legal moves under these rules'); } }
      m.moves = keep;
      if (m.heldItem !== 0 && !itemStatus(pack, m.heldItem, R).ok) m.heldItem = 0;
      notice = dropped ? { code: 'moves-dropped', message: `${dropped} move${dropped === 1 ? '' : 's'} the new species cannot learn ${dropped === 1 ? 'was' : 'were'} removed` } : null;
    } else return reject(state, type, 'field.unknown', 'unknown field ' + String(field));
    return commit(state, type, stamp(), { key: action.coalesce || null, notice, label: `edit ${field}` });
  }

  if (type === 'moveSet') {
    const slot = action.slot;
    if (!isInt(slot) || slot < 0 || slot > 3 || slot > m.moves.length) return reject(state, type, 'move.slot', 'move slot must be 0 to 3, next to the filled ones');
    const id = action.moveId;
    if (id === null || id === 0) { // clear the slot
      if (slot >= m.moves.length) return reject(state, type, 'move.slot', 'that slot is already empty');
      if (m.moves.length <= 1) return reject(state, type, 'moves.min', 'a Pokemon needs at least one move');
      m.moves = m.moves.filter((_x, i) => i !== slot);
      return commit(state, type, stamp(), { label: 'clear a move' });
    }
    if (!isInt(id) || id < 1 || id >= pack.moves.length || !pack.moves[id]) return reject(state, type, 'move.unknown', 'unknown move');
    if (m.moves.some((x, i) => x.id === id && i !== slot)) return reject(state, type, 'move.duplicate', 'this Pokemon already knows that move');
    const st = moveStatuses(pack, { species: m.species, level: m.level, nature: m.nature, abilitySlot: m.abilitySlot, item: 0, moves: [], ivs: { ...m.iv }, evs: { ...m.ev } }, [id], R)[id];
    if (!st.ok) return reject(state, type, st.code, st.text, { move: id, why: st.why, needLevel: st.needLevel });
    const entry = { id, ppUps: slot < m.moves.length && m.moves[slot].id === id ? m.moves[slot].ppUps : 0 };
    if (slot === m.moves.length) m.moves = m.moves.concat([entry]); else m.moves = m.moves.map((x, i) => (i === slot ? entry : x));
    return commit(state, type, stamp(), { label: 'change a move' });
  }
  if (type === 'moveReorder') {
    const from = action.from, to = action.to;
    if (!isInt(from) || !isInt(to) || from < 0 || to < 0 || from >= m.moves.length || to >= m.moves.length) return reject(state, type, 'move.slot', 'move slots out of range');
    if (from === to) return { ...state, error: null, notice: null, result: null };
    const mv = m.moves.slice();
    mv.splice(to, 0, mv.splice(from, 1)[0]);
    m.moves = mv;
    return commit(state, type, stamp());
  }

  if (type === 'evSet') {
    const stat = action.stat;
    if (!STAT_ORDER.includes(stat)) return reject(state, type, 'stat.unknown', 'unknown stat');
    const mode = action.mode === 'points' ? 'points' : 'ev';
    if (mode === 'ev' && R.points) return reject(state, type, 'ev.locked', 'these rules store stat points; edit the points (EVs follow)');
    const others = STAT_ORDER.filter((k) => k !== stat);
    let notice = null;
    if (mode === 'ev') {
      const r = intIn(action.value, 0, R.ev.perStat);
      if (!r.ok) return reject(state, type, r.code, r.message);
      let v = r.value;
      if (R.ev.total !== null) {
        const room = Math.max(0, R.ev.total - others.reduce((a, k) => a + m.ev[k], 0));
        if (v > room) v = room;
      }
      m.ev[stat] = v;
      if (v !== action.value) notice = clampNotice('EV', v);
    } else {
      const iv = R.iv.fixed !== null ? R.iv.fixed : m.iv[stat];
      const perStat = R.points ? R.points.perStat : evToPoints(R.ev.perStat, iv);
      const r = intIn(action.value, 0, perStat);
      if (!r.ok) return reject(state, type, r.code, r.message);
      let v = Math.min(r.value, evToPoints(R.ev.perStat, iv));
      if (R.points) {
        const used = others.reduce((a, k) => a + evToPoints(m.ev[k], R.iv.fixed), 0);
        v = Math.min(v, Math.max(0, R.points.total - used));
      } else if (R.ev.total !== null) {
        const room = Math.max(0, R.ev.total - others.reduce((a, k) => a + m.ev[k], 0));
        while (v > 0 && pointsToEv(v, iv) > room) v--;
      }
      m.ev[stat] = pointsToEv(v, iv);
      if (v !== action.value) notice = clampNotice('stat points', v);
    }
    return commit(state, type, stamp(), { key: action.coalesce || null, notice, label: `change ${stat} ${mode === 'points' ? 'points' : 'EVs'}` });
  }
  if (type === 'evReset') {
    for (const k of STAT_ORDER) m.ev[k] = 0;
    return commit(state, type, stamp());
  }
  if (type === 'evSnap') {
    if (R.points) return { ...state, error: null, notice: { code: 'snap.points', message: 'stat points are already the cheapest EVs' }, result: null };
    const level = R.level.battle !== null ? R.level.battle : m.level;
    const base = pack.species[m.species].baseStats;
    const r = snapEvsToMinimum(base, m.iv, m.ev, level, pack.natures[m.nature], pack.natures);
    if (r.saved === 0) return { ...state, error: null, notice: { code: 'snap.nothing', message: 'every EV already buys its stat; nothing to snap' }, result: null };
    for (const k of STAT_ORDER) m.ev[k] = r.evs[k];
    return commit(state, type, stamp(), { notice: { code: 'snapped', message: `snapped EVs to the cheapest values; ${r.saved} EV freed` }, result: { saved: r.saved } });
  }
  if (type === 'ivSet') {
    const stat = action.stat;
    if (!STAT_ORDER.includes(stat)) return reject(state, type, 'stat.unknown', 'unknown stat');
    if (R.iv.fixed !== null) return reject(state, type, 'iv.fixed', `these rules fix every IV at ${R.iv.fixed}`, { expected: R.iv.fixed });
    const r = intIn(action.value, R.iv.min, R.iv.max);
    if (!r.ok) return reject(state, type, r.code, r.message);
    m.iv[stat] = r.value;
    return commit(state, type, stamp(), { key: action.coalesce || null, notice: r.clamped ? clampNotice('IV', r.value) : null, label: `change ${stat} IV` });
  }
  if (type === 'ivPreset') {
    if (R.iv.fixed !== null) return reject(state, type, 'iv.fixed', `these rules fix every IV at ${R.iv.fixed}`, { expected: R.iv.fixed });
    const p = String(action.preset);
    let iv;
    if (p.startsWith('hp:')) {
      try { iv = hiddenPowerIvs(p.slice(3)); } catch (_e) { return reject(state, type, 'ivpreset.unknown', 'unknown Hidden Power type'); }
    } else if (IV_PRESETS.includes(p)) {
      iv = {};
      for (const k of STAT_ORDER) iv[k] = R.iv.max;
      if (p === 'all0') for (const k of STAT_ORDER) iv[k] = R.iv.min;
      if (p === 'zeroAtk' || p === 'zeroAtkSpe') iv.atk = R.iv.min;
      if (p === 'zeroSpe' || p === 'zeroAtkSpe') iv.spe = R.iv.min;
    } else return reject(state, type, 'ivpreset.unknown', 'unknown IV preset');
    for (const k of STAT_ORDER) m.iv[k] = Math.max(R.iv.min, Math.min(R.iv.max, iv[k]));
    return commit(state, type, stamp(), { label: 'IV preset ' + p });
  }
  return reject(state, type, 'action.unknown', 'unknown action ' + type);
}


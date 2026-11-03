// pokemonarena/js/rules.js -- rulesets, move legality and validation of a Pokemon record / a team.
//
// Pure ES module (browser + Node). Its only imports are ./stats.js and ./engine_support.js (the engine layer, below). Everything it knows about the game comes in as
// the `pack` argument (the C1 pack, tables.js loadPack(): species / moves / items / machines / natures). No DOM,
// no clocks, no randomness, inputs are never mutated, and every result is a plain JSON-able object with a
// deterministic key and element order -- so the SAME function serves the editor, the team builder and the
// opponent's incoming card, and two peers always agree. The only module-level state is a memo of resolveRuleset()
// (a pure function of its string argument). Treat a pack as immutable once handed to these functions.
//
// WIRE SAFETY: validateMon / validateTeam are written to take UNTRUSTED JSON (an opponent's card). They read
// only OWN properties by fixed key, never iterate input keys, never throw on any JSON value, and cap the work
// done on an oversized team. (A malformed RULESET or PACK is a programmer error and does throw.)
//
// THE RECORD (rec) -- fields this module reads; anything else on the object is ignored:
//   species       number  species id (index into pack.species)
//   level         number  1..100, the mon's own level
//   nature        number  0..24 (index into pack.natures)
//   abilitySlot   number  0 | 1 | 2   (pack.species[].abilities[slot]; 2 is the hidden slot)
//   item          number  held item id, 0 = none (optional, default 0)
//   moves         number[] 1..4 move ids, no 0-padding
//   ivs           { hp, atk, def, spa, spd, spe }  0..31            (optional only when the ruleset fixes IVs)
//   evs           { ... }                           raw EV 0..255    (optional only in points mode)
//   points        { ... }                           0..32            (points mode only; the stored form there)
//
// RULESETS are plain frozen data, built from a base id plus named layers: 'arena-gen3-standard' alone, or
// 'arena-gen3-standard+strict-champions', '...+lv5', '...+lv100', '...+item-clause', '...+no-species-clause'.
// resolveRuleset(id) is the ONLY way a ruleset should cross the wire: send the id string, never the object.
//
// WHAT THESE RULES ARE NOT (stated so nobody trusts them for more): they check consistency of a record against
// the ROM's tables and the Gen 3 rules for EV/IV/natures; they are not anti-cheat (an honest-client consistency
// check). Move legality is "some member of the pre-evolution lineage can learn it by a source the ruleset allows",
// derived from the pack's lists; it does not model event-only moves, form-specific learnsets beyond what the pack
// lists, or "moves that cannot be combined". Battle-only forms (Mega etc.) are ordinary legal species in the pack
// and are NOT excluded here; use banned.species to exclude them.

import {
  STAT_ORDER, LIMITS, POINTS, sumStats, pointsToEv, computeStats, canonicalJSON, fnv1a32,
} from './stats.js';
import { engineSupport, abilityReason, itemReason, moveReason } from './engine_support.js';

// ENGINE LAYER (stage E1): the ruleset carries `engine: { enforce }`.  With enforce on (the default in
// 'arena-gen3-standard'), a move, ability or held item the battle engine cannot run (engine.js) is ILLEGAL with a
// machine-readable code (move.engine-unsupported, ability.engine-unsupported, item.engine-unsupported), and a species with
// no runnable ability slot or no runnable move at its level is excluded (species.engine-no-ability / species.engine-no-move).
// It is a plain ruleset field rather than a named layer so ruleset ids and team-code layer bits (teamcode.js LAYER_BITS) are
// unchanged.  A ruleset OBJECT with engine.enforce false (for engine tests) switches it off; ids always enforce.
// exports: engineSupports(pack), engineCoverage(pack, ruleset), engineExcludedSpecies(pack, ruleset).

export const RULES_VERSION = 1;
export const DEFAULT_RULESET_ID = 'arena-gen3-standard';
export const STRICT_RULESET_ID = 'arena-gen3-standard+strict-champions';
export const MOVE_SOURCES = Object.freeze(['levelUp', 'machine', 'tutor', 'egg']);

/** Every code validateMon / validateTeam can emit, with a one-line meaning. The test requires a mutant for each. */
export const RULE_CODES = Object.freeze({
  'rec.shape': 'the record is not an object',
  'species.unknown': 'species is not an integer index of a non-empty species slot',
  'species.illegal': 'the species slot exists but is not on the legal roster',
  'species.banned': 'the ruleset bans this species',
  'level.range': 'level is not an integer inside the ruleset level range',
  'level.fixed': 'the ruleset fixes the level and this is not it',
  'nature.range': 'nature is not one of the ruleset natures',
  'ability.slot-range': 'abilitySlot is not an integer 0..2',
  'ability.slot-disallowed': 'the ruleset does not allow this ability slot',
  'ability.slot-empty': 'the species has no ability in this slot',
  'ability.banned': 'the ruleset bans the ability this slot gives',
  'item.unknown': 'item is not 0 (none) or a known item id',
  'item.banned': 'the ruleset bans this item',
  'moves.shape': 'moves is not an array',
  'moves.count': 'wrong number of moves',
  'move.unknown': 'not a known move id (0 and out-of-range ids are unknown)',
  'move.duplicate': 'the same move appears twice',
  'move.banned': 'the ruleset bans this move',
  'move.illegal': 'the species lineage cannot know this move under the ruleset sources and level gate',
  'iv.missing': 'ivs (or one stat of it) is absent',
  'iv.range': 'an IV is not an integer inside the ruleset IV range',
  'iv.fixed': 'the ruleset fixes IVs and this one differs',
  'ev.missing': 'evs (or one stat of it) is absent',
  'ev.range': 'an EV is not an integer 0..perStat',
  'ev.total': 'the EV total is over the ruleset cap',
  'points.missing': 'points (or one stat of it) is absent in points mode',
  'points.range': 'a stat-point value is not an integer 0..perStat',
  'points.total': 'the stat-point total is over the cap',
  'points.ev-mismatch': 'evs was supplied and differs from the EVs derived from points',
  'move.engine-unsupported': 'the arena cannot use this move in battle',
  'ability.engine-unsupported': 'the arena cannot use the ability in this slot in battle',
  'item.engine-unsupported': 'the arena cannot use this held item in battle',
  'species.engine-no-ability': 'none of this species\' ability slots can be used in the arena',
  'species.engine-no-move': 'this species has no move the arena can use at this level',
  'team.shape': 'the team is not an array',
  'team.size': 'wrong number of Pokemon in the team',
  'team.species-clause': 'two team members share a Pokedex number',
  'team.item-clause': 'two team members hold the same item',
});

// ---------------------------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------------------------

const hasOwn = Object.prototype.hasOwnProperty;
const own = (o, k) => (o !== null && typeof o === 'object' && hasOwn.call(o, k) ? o[k] : undefined);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const num = (v) => (Object.is(v, -0) ? 0 : v); // JSON.parse('-0') is -0; treat it as 0 so peers hash the same bytes

function deepFreeze(o) {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------------------------------------
// rulesets
// ---------------------------------------------------------------------------------------------

const BASES = {
  'arena-gen3-standard': {
    id: 'arena-gen3-standard',
    version: RULES_VERSION,
    team: { min: 1, max: 6, speciesClause: true, itemClause: false },
    level: { min: LIMITS.levelMin, max: LIMITS.levelMax, fixed: null, battle: 50 },
    ev: { perStat: LIMITS.evMax, total: LIMITS.evTotalMax },
    iv: { min: 0, max: LIMITS.ivMax, fixed: null },
    points: null,
    nature: { count: 25 },
    ability: { slots: [0, 1, 2] },
    moves: { min: 1, max: 4, duplicates: false, sources: ['levelUp', 'machine', 'tutor', 'egg'], lineage: true, levelGate: true },
    banned: { species: [], items: [], moves: [], abilities: [] },
    engine: { enforce: true },
  },
};

const LAYER_ORDER = ['lv5', 'lv100', 'item-clause', 'no-species-clause', 'strict-champions'];
const LAYERS = {
  lv5: { conflicts: ['lv100', 'strict-champions'], apply(r) { r.level.battle = 5; } },
  lv100: { conflicts: ['lv5', 'strict-champions'], apply(r) { r.level.battle = 100; } },
  'item-clause': { conflicts: [], apply(r) { r.team.itemClause = true; } },
  'no-species-clause': { conflicts: [], apply(r) { r.team.speciesClause = false; } },
  // Champions-style: Lv50, IV 31, stat points (32 per stat, 66 total) are the STORED form, EVs are derived from them
  // (4 for the first point of a stat, 8 per further point), and the 510 EV total is relaxed because a legal 32/32/2
  // spread derives to 516 EV.
  'strict-champions': {
    conflicts: ['lv5', 'lv100'],
    apply(r) {
      r.level = { min: LIMITS.levelMin, max: LIMITS.levelMax, fixed: POINTS.level, battle: POINTS.level };
      r.iv = { min: 0, max: LIMITS.ivMax, fixed: POINTS.ivFixed };
      r.points = { perStat: POINTS.perStat, total: POINTS.total };
      r.ev = { perStat: LIMITS.evMax, total: null };
    },
  },
};

export const RULESET_LAYERS = Object.freeze(LAYER_ORDER.slice());
export const BASE_RULESET_IDS = Object.freeze(Object.keys(BASES));

const isIntIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const sortedUniqInts = (a) => Array.isArray(a) && a.every((x) => Number.isInteger(x)) && a.every((x, i) => i === 0 || a[i - 1] < x);

/** Structural problems of a ruleset object ([] = well formed). A malformed ruleset is a programmer error. */
export function checkRuleset(r) {
  const p = [];
  if (!isObj(r)) return ['ruleset is not an object'];
  if (typeof r.id !== 'string' || r.id === '') p.push('id');
  if (r.version !== RULES_VERSION) p.push('version');
  const t = r.team, l = r.level, e = r.ev, iv = r.iv, pt = r.points, n = r.nature, a = r.ability, m = r.moves, b = r.banned;
  if (!isObj(t) || !isIntIn(t.min, 1, 6) || !isIntIn(t.max, 1, 6) || t.min > t.max || typeof t.speciesClause !== 'boolean' || typeof t.itemClause !== 'boolean') p.push('team');
  if (!isObj(l) || !isIntIn(l.min, 1, 100) || !isIntIn(l.max, 1, 100) || l.min > l.max
    || !(l.fixed === null || isIntIn(l.fixed, l.min, l.max)) || !(l.battle === null || isIntIn(l.battle, 1, 100))) p.push('level');
  if (!isObj(e) || !isIntIn(e.perStat, 0, LIMITS.evMax) || !(e.total === null || isIntIn(e.total, 0, 6 * LIMITS.evMax))) p.push('ev');
  if (!isObj(iv) || !isIntIn(iv.min, 0, LIMITS.ivMax) || !isIntIn(iv.max, 0, LIMITS.ivMax) || iv.min > iv.max
    || !(iv.fixed === null || isIntIn(iv.fixed, iv.min, iv.max))) p.push('iv');
  if (pt !== null) {
    if (!isObj(pt) || !isIntIn(pt.perStat, 1, 255) || !isIntIn(pt.total, 0, 6 * pt.perStat)) p.push('points');
    else if (!isObj(iv) || iv.fixed === null) p.push('points needs iv.fixed');
    else {
      try { if (pointsToEv(pt.perStat, iv.fixed) > e.perStat) p.push('points exceed ev.perStat'); } catch (_e) { p.push('points do not fit an EV byte'); }
    }
  }
  if (!isObj(n) || !isIntIn(n.count, 1, 25)) p.push('nature');
  if (!isObj(a) || !sortedUniqInts(a.slots) || a.slots.length === 0 || !a.slots.every((s) => isIntIn(s, 0, 2))) p.push('ability');
  if (!isObj(m) || !isIntIn(m.min, 1, 4) || !isIntIn(m.max, 1, 4) || m.min > m.max || typeof m.duplicates !== 'boolean'
    || typeof m.lineage !== 'boolean' || typeof m.levelGate !== 'boolean'
    || !Array.isArray(m.sources) || !m.sources.every((s) => MOVE_SOURCES.includes(s))) p.push('moves');
  if (!isObj(b) || !['species', 'items', 'moves', 'abilities'].every((k) => sortedUniqInts(b[k]))) p.push('banned');
  if (!isObj(r.engine) || typeof r.engine.enforce !== 'boolean') p.push('engine');
  return p;
}

const resolved = new Map(); // id -> frozen ruleset (a pure function of the id, so caching it cannot change a result)

/** 'arena-gen3-standard' or 'arena-gen3-standard+lv5+item-clause'. Layers may be given in any order; the returned
 *  ruleset carries the canonical id (layers in registry order). Throws RangeError on an unknown id or a conflicting pair. */
export function resolveRuleset(spec) {
  if (typeof spec !== 'string') throw new TypeError('ruleset id must be a string');
  const parts = spec.split('+');
  const baseId = parts[0];
  if (!hasOwn.call(BASES, baseId)) throw new RangeError(`unknown base ruleset "${baseId}"`);
  const layers = parts.slice(1);
  for (const ly of layers) if (!hasOwn.call(LAYERS, ly)) throw new RangeError(`unknown ruleset layer "${ly}"`);
  if (new Set(layers).size !== layers.length) throw new RangeError('duplicate ruleset layer');
  for (const ly of layers) for (const c of LAYERS[ly].conflicts) if (layers.includes(c)) throw new RangeError(`ruleset layers "${ly}" and "${c}" conflict`);
  const ordered = LAYER_ORDER.filter((ly) => layers.includes(ly));
  const id = [baseId, ...ordered].join('+');
  if (resolved.has(id)) return resolved.get(id);
  const r = clone(BASES[baseId]);
  for (const ly of ordered) LAYERS[ly].apply(r);
  r.id = id;
  const problems = checkRuleset(r);
  if (problems.length) throw new Error(`internal: ruleset ${id} is malformed: ${problems.join(', ')}`);
  deepFreeze(r);
  resolved.set(id, r);
  return r;
}

function asRuleset(ruleset) {
  const r = typeof ruleset === 'string' ? resolveRuleset(ruleset) : ruleset;
  const problems = checkRuleset(r);
  if (problems.length) throw new TypeError(`malformed ruleset: ${problems.join(', ')}`);
  return r;
}

/** Stable fingerprint of a ruleset's CONTENT (for a disc string / replay header): canonical JSON + a 32-bit FNV-1a.
 *  A drift detector, not a security hash. */
export function rulesetFingerprint(ruleset) {
  const r = asRuleset(ruleset);
  const canonical = canonicalJSON(r);
  return { id: r.id, canonical, fnv32: fnv1a32(canonical) };
}

// ---------------------------------------------------------------------------------------------
// lineage and move legality
// ---------------------------------------------------------------------------------------------

function predecessors(pack, id) {
  const out = [];
  for (let p = 0; p < pack.species.length; p++) {
    const s = pack.species[p];
    if (s && s.evolutions.some((e) => e.target === id)) out.push(p);
  }
  return out;
}

/** The species plus everything that can evolve into it (transitively), ascending. A form with no incoming evolution
 *  edge of its own (forms[0] is the base form) borrows the predecessors of its base form. */
export function lineageOf(pack, speciesId) {
  const seen = new Set([speciesId]);
  const queue = [speciesId];
  while (queue.length) {
    const x = queue.pop();
    let pres = predecessors(pack, x);
    if (pres.length === 0) {
      const s = pack.species[x];
      if (s && s.forms.length > 0 && s.forms[0] !== x) pres = predecessors(pack, s.forms[0]);
    }
    for (const p of pres) if (!seen.has(p)) { seen.add(p); queue.push(p); }
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Every move a species (and, with `lineage`, its pre-evolutions) can learn, with HOW:
 *   { [moveId]: { levelUp: <lowest level> | null, machine: bool, tutor: bool, egg: bool, from: [species ids] } }
 * `teachable` in the pack is one merged list; as in tables.js learnableMoves, a move in the machine table counts
 * as TM/HM and any other teachable move as tutor. Level-up level 0 is an evolution move.
 */
export function learnsetOf(pack, speciesId, lineage = true) {
  const sp = pack.species[speciesId];
  if (!sp) return {};
  const ids = lineage ? lineageOf(pack, speciesId) : [speciesId];
  const machineMoves = new Set(pack.machines.map((m) => m.move));
  const out = {};
  const entry = (mv, from) => {
    let e = out[mv];
    if (!e) e = out[mv] = { levelUp: null, machine: false, tutor: false, egg: false, from: [] };
    if (!e.from.includes(from)) e.from.push(from);
    return e;
  };
  for (const id of ids) {
    const s = pack.species[id];
    if (!s) continue;
    for (const [mv, lv] of s.levelUp) {
      const e = entry(mv, id);
      if (e.levelUp === null || lv < e.levelUp) e.levelUp = lv;
    }
    for (const mv of s.teachable) {
      const e = entry(mv, id);
      if (machineMoves.has(mv)) e.machine = true; else e.tutor = true;
    }
    for (const mv of s.eggMoves) entry(mv, id).egg = true;
  }
  for (const k of Object.keys(out)) out[k].from.sort((a, b) => a - b);
  return out;
}

const isKnownMove = (pack, id) => Number.isInteger(id) && id >= 1 && id < pack.moves.length && pack.moves[id] != null;

/**
 * Can this species, at this level, know this move under the ruleset?
 *   { legal, reason: null | 'not-learnable' | 'level-too-low' | 'source-disabled', sources: [...], needLevel }
 * `sources` lists the allowed sources that provide it (empty when illegal).
 */
export function moveLegality(pack, speciesId, level, moveId, ruleset) {
  const R = asRuleset(ruleset);
  return judge(learnsetOf(pack, speciesId, R.moves.lineage)[moveId], level, R);
}

/** The decision itself, given a learnset entry (undefined = not learnable at all). */
function judge(e, level, R) {
  if (!e) return { legal: false, reason: 'not-learnable', sources: [], needLevel: null };
  const have = [];
  let needLevel = null, disabled = false;
  if (e.levelUp !== null) {
    if (!R.moves.sources.includes('levelUp')) disabled = true;
    else if (R.moves.levelGate && e.levelUp > level) needLevel = e.levelUp;
    else have.push('levelUp');
  }
  for (const s of ['machine', 'tutor', 'egg']) {
    if (!e[s]) continue;
    if (R.moves.sources.includes(s)) have.push(s); else disabled = true;
  }
  if (have.length > 0) return { legal: true, reason: null, sources: have, needLevel: null };
  return { legal: false, reason: needLevel !== null ? 'level-too-low' : disabled ? 'source-disabled' : 'not-learnable', sources: [], needLevel };
}

/** Ascending ids of every move legal for the species at the level (banned moves excluded). */
export function legalMoves(pack, speciesId, level, ruleset) {
  const R = asRuleset(ruleset);
  const out = [];
  const learn = learnsetOf(pack, speciesId, R.moves.lineage);
  const sup = R.engine.enforce ? engineSupport(pack).moves : null;
  for (const k of Object.keys(learn)) {
    const id = Number(k);
    if (!isKnownMove(pack, id) || R.banned.moves.includes(id)) continue;
    if (sup && !sup.has(id)) continue;
    if (judge(learn[k], level, R).legal) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// effective values
// ---------------------------------------------------------------------------------------------

/** The IVs that count: the ruleset's fixed IV for every stat, else rec.ivs. Assumes a valid record. */
export function effectiveIvs(rec, ruleset) {
  const R = asRuleset(ruleset);
  const out = {};
  for (const k of STAT_ORDER) out[k] = R.iv.fixed !== null ? R.iv.fixed : num(rec.ivs[k]);
  return out;
}

/** The raw EVs that count: derived from rec.points in points mode (4-then-8), else rec.evs. Assumes a valid record. */
export function effectiveEvs(rec, ruleset) {
  const R = asRuleset(ruleset);
  const out = {};
  for (const k of STAT_ORDER) out[k] = R.points ? pointsToEv(num(rec.points[k]), R.iv.fixed) : num(rec.evs[k]);
  return out;
}

/** The level battles run at: the ruleset's normalised level, or the mon's own when the ruleset does not normalise. */
export function battleLevel(rec, ruleset) {
  const R = asRuleset(ruleset);
  return R.level.battle !== null ? R.level.battle : num(rec.level);
}

/** The six stats the mon has IN BATTLE under the ruleset. Assumes a valid record; throws RangeError on garbage. */
export function battleStats(rec, pack, ruleset) {
  const R = asRuleset(ruleset);
  const sp = pack.species[rec.species];
  if (!sp) throw new RangeError(`unknown species ${String(rec.species)}`);
  return computeStats(sp.baseStats, effectiveIvs(rec, R), effectiveEvs(rec, R), battleLevel(rec, R), num(rec.nature), pack.natures);
}

// ---------------------------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------------------------

function reporter() {
  const list = [];
  const add = (code, path, message, extra) => {
    const r = { code, path, message };
    if (extra) for (const k of Object.keys(extra)) r[k] = extra[k];
    list.push(r);
  };
  return { list, add };
}

/** Read a six-stat block. Returns the validated numbers, or null if any stat was missing/out of range (reasons added). */
function readStats(block, path, lo, hi, codes, add, fixed) {
  let ok = true;
  const vals = {};
  for (const k of STAT_ORDER) {
    const v = num(own(block, k));
    if (v === undefined) { add(codes.missing, `${path}.${k}`, `${path}.${k} is missing`); ok = false; }
    else if (!Number.isInteger(v) || v < lo || v > hi) { add(codes.range, `${path}.${k}`, `${path}.${k} must be an integer ${lo}..${hi}`, { min: lo, max: hi }); ok = false; }
    else if (fixed !== null && fixed !== undefined && v !== fixed) { add(codes.fixed, `${path}.${k}`, `${path}.${k} must be ${fixed} under this ruleset`, { expected: fixed }); ok = false; }
    else vals[k] = v;
  }
  return ok ? vals : null;
}

/**
 * Validate one record against a pack and a ruleset (object or id string).
 * Returns { ok, reasons } where each reason is { code, path, message, ...detail } and `code` is a key of RULE_CODES.
 */
export function validateMon(rec, pack, ruleset) {
  const R = asRuleset(ruleset);
  const { list, add } = reporter();
  if (!isObj(rec)) {
    add('rec.shape', '', 'the record must be an object');
    return { ok: false, reasons: list };
  }

  // species
  const sid = num(own(rec, 'species'));
  const sp = Number.isInteger(sid) && sid >= 0 && sid < pack.species.length ? pack.species[sid] : null;
  let spOk = false;
  if (!sp) add('species.unknown', 'species', 'species is not a known species id');
  else if (!sp.legal) add('species.illegal', 'species', 'species is not on the legal roster');
  else if (R.banned.species.includes(sid)) add('species.banned', 'species', 'species is banned by this ruleset');
  else spOk = true;

  // level
  const lv = num(own(rec, 'level'));
  const lvInRange = Number.isInteger(lv) && lv >= R.level.min && lv <= R.level.max; // gates level-up moves even when a fixed level is violated
  if (!lvInRange) add('level.range', 'level', `level must be an integer ${R.level.min}..${R.level.max}`, { min: R.level.min, max: R.level.max });
  else if (R.level.fixed !== null && lv !== R.level.fixed) add('level.fixed', 'level', `level must be ${R.level.fixed} under this ruleset`, { expected: R.level.fixed });

  // nature
  const nat = num(own(rec, 'nature'));
  const natLimit = Math.min(R.nature.count, pack.natures.length);
  if (!Number.isInteger(nat) || nat < 0 || nat >= natLimit) add('nature.range', 'nature', `nature must be an integer 0..${natLimit - 1}`, { min: 0, max: natLimit - 1 });

  // ability slot
  const slot = num(own(rec, 'abilitySlot'));
  if (!Number.isInteger(slot) || slot < 0 || slot > 2) add('ability.slot-range', 'abilitySlot', 'abilitySlot must be 0, 1 or 2');
  else if (!R.ability.slots.includes(slot)) add('ability.slot-disallowed', 'abilitySlot', `ability slot ${slot} is not allowed by this ruleset`);
  else if (spOk) {
    const ab = sp.abilities[slot];
    if (!ab) add('ability.slot-empty', 'abilitySlot', `this species has no ability in slot ${slot}`);
    else if (R.banned.abilities.includes(ab)) add('ability.banned', 'abilitySlot', 'the ability in this slot is banned by this ruleset', { ability: ab });
  }

  // item (optional, 0 = none)
  const itemRaw = own(rec, 'item');
  const item = itemRaw === undefined ? 0 : num(itemRaw);
  if (!Number.isInteger(item) || item < 0 || item >= pack.items.length) add('item.unknown', 'item', 'item must be 0 (none) or a known item id');
  else if (item !== 0 && R.banned.items.includes(item)) add('item.banned', 'item', 'this item is banned by this ruleset', { item });

  // moves
  const mv = own(rec, 'moves');
  if (!Array.isArray(mv)) add('moves.shape', 'moves', 'moves must be an array');
  else {
    if (mv.length < R.moves.min || mv.length > R.moves.max) add('moves.count', 'moves', `a Pokemon needs ${R.moves.min}..${R.moves.max} moves`, { min: R.moves.min, max: R.moves.max, actual: mv.length });
    const seen = new Map();
    const learn = spOk ? learnsetOf(pack, sid, R.moves.lineage) : null;
    for (let i = 0; i < Math.min(mv.length, 16); i++) {
      const id = num(mv[i]);
      const path = `moves[${i}]`;
      if (!isKnownMove(pack, id)) { add('move.unknown', path, 'not a known move id'); continue; }
      if (seen.has(id)) { if (!R.moves.duplicates) add('move.duplicate', path, 'this move is already in the set', { first: seen.get(id) }); }
      else seen.set(id, i);
      if (R.banned.moves.includes(id)) add('move.banned', path, 'this move is banned by this ruleset', { move: id });
      if (spOk && lvInRange) {
        const lg = judge(learn[id], lv, R);
        if (!lg.legal) add('move.illegal', path, `this species cannot know this move (${lg.reason})`, { move: id, why: lg.reason, needLevel: lg.needLevel });
      }
    }
  }

  // IVs: required unless the ruleset fixes them
  const ivBlock = own(rec, 'ivs');
  if (ivBlock === undefined && R.iv.fixed !== null) { /* implied */ }
  else if (!isObj(ivBlock)) add('iv.missing', 'ivs', 'ivs must be an object keyed hp/atk/def/spa/spd/spe');
  else readStats(ivBlock, 'ivs', R.iv.min, R.iv.max, { missing: 'iv.missing', range: 'iv.range', fixed: 'iv.fixed' }, add, R.iv.fixed);

  // EVs / stat points
  const evBlock = own(rec, 'evs');
  let evVals = null;
  if (evBlock === undefined && R.points) { /* derived from points */ }
  else if (!isObj(evBlock)) add('ev.missing', 'evs', 'evs must be an object keyed hp/atk/def/spa/spd/spe');
  else {
    evVals = readStats(evBlock, 'evs', 0, R.ev.perStat, { missing: 'ev.missing', range: 'ev.range' }, add, null);
    if (evVals && !R.points && R.ev.total !== null) {
      const total = sumStats(evVals);
      if (total > R.ev.total) add('ev.total', 'evs', `EVs total ${total}, over the cap of ${R.ev.total}`, { total, cap: R.ev.total });
    }
  }
  if (R.points) {
    const ptBlock = own(rec, 'points');
    if (!isObj(ptBlock)) add('points.missing', 'points', 'points must be an object keyed hp/atk/def/spa/spd/spe');
    else {
      const pv = readStats(ptBlock, 'points', 0, R.points.perStat, { missing: 'points.missing', range: 'points.range' }, add, null);
      if (pv) {
        const total = sumStats(pv);
        if (total > R.points.total) add('points.total', 'points', `stat points total ${total}, over the cap of ${R.points.total}`, { total, cap: R.points.total });
        if (R.ev.total !== null) { // the EV cap applies to the EVs the points derive to (the strict layer relaxes it: 32/32/2 derives to 516)
          let derived = 0;
          for (const k of STAT_ORDER) derived += pointsToEv(pv[k], R.iv.fixed);
          if (derived > R.ev.total) add('ev.total', 'points', `these points derive to ${derived} EV, over the cap of ${R.ev.total}`, { total: derived, cap: R.ev.total });
        }
        if (evVals) {
          for (const k of STAT_ORDER) {
            const want = pointsToEv(pv[k], R.iv.fixed);
            if (evVals[k] !== want) add('points.ev-mismatch', `evs.${k}`, `evs.${k} is ${evVals[k]} but ${pv[k]} points derive to ${want}`, { expected: want });
          }
        }
      }
    }
  }
  if (R.engine.enforce) engineChecks(rec, pack, R, { sid, sp, spOk, lv, lvInRange, slot, item, mv }, add);
  return { ok: list.length === 0, reasons: list };
}

/** The engine layer of validateMon (appended after every other reason so existing reason order is unchanged). */
function engineChecks(rec, pack, R, f, add) {
  const sup = engineSupport(pack);
  let abilityBlocked = false, moveBlocked = false, learnHere = null;
  if (f.spOk) {
    const slotsOk = R.ability.slots.filter((s) => f.sp.abilities[s] && !R.banned.abilities.includes(f.sp.abilities[s]) && sup.abilities.has(f.sp.abilities[s]));
    if (slotsOk.length === 0) {
      const why = R.ability.slots.map((s) => f.sp.abilities[s]).filter((a) => a && !R.banned.abilities.includes(a) && !sup.abilities.has(a)).map((a) => `${pack.abilities[a] ? pack.abilities[a].name : '?'}: ${abilityReason(pack, a).why}`);
      add('species.engine-no-ability', 'species', 'none of this species\' abilities can be used in the arena' + (why.length ? ' (' + why.join('; ') + ')' : ''), why.length ? { reasons: why } : undefined); abilityBlocked = true;
    }
    if (f.lvInRange) {
      const learn = learnsetOf(pack, f.sid, R.moves.lineage);
      learnHere = learn;
      let any = false;
      for (const k of Object.keys(learn)) {
        const id = Number(k);
        if (!isKnownMove(pack, id) || R.banned.moves.includes(id) || !sup.moves.has(id)) continue;
        if (judge(learn[k], f.lv, R).legal) { any = true; break; }
      }
      if (!any) { add('species.engine-no-move', 'species', 'this species has no move the arena can use at this level'); moveBlocked = true; }
    }
  }
  if (!abilityBlocked && f.spOk && Number.isInteger(f.slot) && f.slot >= 0 && f.slot <= 2 && R.ability.slots.includes(f.slot)) {
    const ab = f.sp.abilities[f.slot];
    if (ab && !sup.abilities.has(ab)) { const r = abilityReason(pack, ab); add('ability.engine-unsupported', 'abilitySlot', `${pack.abilities[ab] ? pack.abilities[ab].name : 'this ability'} cannot be used in the arena, because ${r.why}.`, { ability: ab, reason: r.why }); }
  }
  if (Number.isInteger(f.item) && f.item > 0 && f.item < pack.items.length && !sup.items.has(f.item)) { const r = itemReason(pack, f.item); add('item.engine-unsupported', 'item', `${pack.items[f.item] ? pack.items[f.item].name : 'this item'} cannot be used in the arena, because ${r.why}.`, { item: f.item, reason: r.why }); }
  if (!moveBlocked && Array.isArray(f.mv)) {
    for (let i = 0; i < Math.min(f.mv.length, 16); i++) {
      const id = num(f.mv[i]);
      // only a move that would otherwise be legal gets the engine reason (one fault, one reason); an illegal / banned one already has its own
      if (learnHere && isKnownMove(pack, id) && !sup.moves.has(id) && !R.banned.moves.includes(id) && judge(learnHere[id], f.lv, R).legal) { const r = moveReason(pack, id); add('move.engine-unsupported', `moves[${i}]`, `${pack.moves[id].name} cannot be used in the arena, because ${r.why}.`, { move: id, why: sup.moveReasons[id] || 'unsupported', reason: r.why }); }
    }
  }
}

/**
 * Validate a team. Returns { ok, reasons, mons } where `reasons` is the flat list (team-level reasons first, then every
 * mon's reasons with `mon` = its index and `path` prefixed `mons[i].`), and `mons[i] = { index, ok, reasons }`.
 * Per-mon validation stops after ruleset.team.max entries (the size reason already fails the team).
 */
export function validateTeam(team, pack, ruleset) {
  const R = asRuleset(ruleset);
  const { list, add } = reporter();
  if (!Array.isArray(team)) {
    add('team.shape', 'team', 'a team must be an array of records');
    return { ok: false, reasons: list, mons: [] };
  }
  if (team.length < R.team.min || team.length > R.team.max) add('team.size', 'team', `a team needs ${R.team.min}..${R.team.max} Pokemon`, { min: R.team.min, max: R.team.max, actual: team.length });
  const n = Math.min(team.length, R.team.max);
  const mons = [];
  const dex = new Map(), items = new Map();
  for (let i = 0; i < n; i++) {
    const v = validateMon(team[i], pack, R);
    mons.push({ index: i, ok: v.ok, reasons: v.reasons });
    const rec = team[i];
    const sid = num(own(rec, 'species'));
    const sp = Number.isInteger(sid) && sid >= 0 && sid < pack.species.length ? pack.species[sid] : null;
    if (sp) { const key = sp.natDex; (dex.get(key) || dex.set(key, []).get(key)).push(i); }
    const itemRaw = own(rec, 'item');
    const item = itemRaw === undefined ? 0 : num(itemRaw);
    if (Number.isInteger(item) && item > 0) (items.get(item) || items.set(item, []).get(item)).push(i);
  }
  if (R.team.speciesClause) {
    for (const [natDex, idx] of [...dex.entries()].sort((a, b) => a[1][0] - b[1][0])) {
      if (idx.length > 1) add('team.species-clause', 'team', `members ${idx.join(', ')} share Pokedex number ${natDex}`, { natDex, indexes: idx });
    }
  }
  if (R.team.itemClause) {
    for (const [item, idx] of [...items.entries()].sort((a, b) => a[1][0] - b[1][0])) {
      if (idx.length > 1) add('team.item-clause', 'team', `members ${idx.join(', ')} hold the same item`, { item, indexes: idx });
    }
  }
  const flat = list.slice();
  for (const m of mons) for (const r of m.reasons) flat.push({ ...r, path: `mons[${m.index}]${r.path ? '.' + r.path : ''}`, mon: m.index });
  return { ok: flat.length === 0, reasons: flat, mons };
}

// ---------------------------------------------------------------------------------------------
// a starting record
// ---------------------------------------------------------------------------------------------

/** A VALID starter record for a species under the ruleset: neutral nature (id 0), first available ability slot, no item,
 *  its earliest learnable level-up move, and zero EVs / points. Level is the fixed level, else 100 (battles normalise it). */
export function blankRec(speciesId, pack, ruleset) {
  const R = asRuleset(ruleset);
  const sp = pack.species[speciesId];
  if (!sp || !sp.legal) throw new RangeError(`species ${String(speciesId)} is not a legal species`);
  const level = R.level.fixed !== null ? R.level.fixed : R.level.max;
  const supAb = R.engine.enforce ? engineSupport(pack).abilities : null;
  const abilitySlot = R.ability.slots.find((s) => sp.abilities[s] !== 0 && (!supAb || supAb.has(sp.abilities[s])));
  if (abilitySlot === undefined) throw new RangeError('species has no ability in any allowed slot');
  const legal = legalMoves(pack, speciesId, level, R);
  const first = sp.levelUp.map((e) => e[0]).find((m) => legal.includes(m));
  const move = first !== undefined ? first : legal[0];
  if (move === undefined) throw new RangeError('species has no legal move under this ruleset');
  const rec = { species: speciesId, level, nature: 0, abilitySlot, item: 0, moves: [move] };
  if (R.iv.fixed === null) { rec.ivs = {}; for (const k of STAT_ORDER) rec.ivs[k] = R.iv.max; }
  if (R.points) { rec.points = {}; for (const k of STAT_ORDER) rec.points[k] = 0; }
  else { rec.evs = {}; for (const k of STAT_ORDER) rec.evs[k] = 0; }
  return rec;
}

// ---------------------------------------------------------------------------------------------
// engine support summary
// ---------------------------------------------------------------------------------------------

/** What the battle engine can run: { moves:Set, abilities:Set, items:Set, moveReasons, moveList, abilityList, itemList, counts }. */
export function engineSupports(pack) {
  return engineSupport(pack);
}

const excludedCache = new WeakMap();
/** Species the engine layer excludes under a ruleset, with why: [{ id, why: 'no-ability' | 'no-move' }] ascending. Judged at the
 *  ruleset's highest allowed level (the most moves a species can have). */
export function engineExcludedSpecies(pack, ruleset) {
  const R = asRuleset(ruleset);
  let byRs = excludedCache.get(pack);
  if (!byRs) { byRs = new Map(); excludedCache.set(pack, byRs); }
  const key = canonicalJSON({ s: R.ability.slots, m: R.moves, b: R.banned, l: R.level.max, e: R.engine });
  if (byRs.has(key)) return byRs.get(key);
  const sup = engineSupport(pack);
  const out = [];
  for (const id of pack.roster) {
    const sp = pack.species[id];
    if (R.banned.species.includes(id)) continue;
    const slotsOk = R.ability.slots.filter((s) => sp.abilities[s] && !R.banned.abilities.includes(sp.abilities[s]) && sup.abilities.has(sp.abilities[s]));
    if (slotsOk.length === 0) { out.push({ id, why: 'no-ability' }); continue; }
    const lv = R.level.fixed !== null ? R.level.fixed : R.level.max;
    const learn = learnsetOf(pack, id, R.moves.lineage);
    let any = false;
    for (const k of Object.keys(learn)) {
      const mid = Number(k);
      if (!isKnownMove(pack, mid) || R.banned.moves.includes(mid) || !sup.moves.has(mid)) continue;
      if (judge(learn[k], lv, R).legal) { any = true; break; }
    }
    if (!any) out.push({ id, why: 'no-move' });
  }
  byRs.set(key, out);
  return out;
}

/** Final legal counts under a ruleset: { species, moves, abilities, items, excluded:[...] } (moves/abilities/items are the
 *  engine-supported ones not banned by the ruleset; species excludes engine_excluded and banned). */
export function engineCoverage(pack, ruleset) {
  const R = asRuleset(ruleset);
  const sup = engineSupport(pack);
  const ex = R.engine.enforce ? engineExcludedSpecies(pack, R) : [];
  const exIds = new Set(ex.map((e) => e.id));
  const species = pack.roster.filter((id) => !exIds.has(id) && !R.banned.species.includes(id));
  const keep = (set, banned) => [...set].filter((id) => !banned.includes(id));
  return {
    species: species.length,
    speciesLegalBeforeEngine: pack.roster.filter((id) => !R.banned.species.includes(id)).length,
    moves: keep(sup.moves, R.banned.moves).length,
    abilities: keep(sup.abilities, R.banned.abilities).length,
    items: keep(sup.items, R.banned.items).length,
    excluded: ex,
  };
}

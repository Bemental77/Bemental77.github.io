// pokemonarena/js/editor_data.js -- the editor's read side: searchable lists and derived numbers, as PURE functions of (pack, ruleset, record).
//
// Pure ES module (browser + Node): no DOM, no clocks, no randomness, no ROM bytes (the pack from tables.js is passed in). Nothing here is ROM
// content; every name, number and description comes out of the pack at call time.
//
// THE RULE THIS FILE EXISTS TO KEEP: legality is rules.js's decision, asked at runtime, never copied. A move or an item is shown as
// "unavailable" iff rules.js says so for THIS ruleset, and the reason shown is the machine code rules.js returned plus RULE_CODES[code]. When
// rules.js learns a new "engine-unsupported" reason (another stage is adding that layer while this file is written), it appears here with no
// edit, because the status of a move is "what validateMon() reported at path moves[i]" and the status of an item is "what it reported at path
// 'item'". Nothing in this file names a reason code, a ruleset fingerprint, or a banned list.
//
//   moveCatalog(pack, mon, ruleset, opts)        every move the species' lineage can learn, each with sources + a rules.js verdict
//   moveStatuses(pack, rec, moveIds, ruleset)    { [moveId]: { ok, code, message, ...detail } } by batches of 16 through validateMon
//   itemCatalog(pack, ruleset, opts)             { id, name, desc, ..., status } per item
//   speciesSearch(pack, query, ruleset)          roster ids matching a name / number / type query
//   derived(pack, mon, ruleset)                  battle stats and the numbers shown next to them
//   validationView(pack, mons, ruleset)          reasons grouped for display (team level + per mon), each with the RULE_CODES text

import { STAT_ORDER, LIMITS, POINTS, hiddenPower, sumStats, evsToPoints } from './stats.js';
import * as RULES from './rules.js';
import {
  resolveRuleset, validateMon, learnsetOf, RULE_CODES, battleStats, battleLevel, effectiveEvs,
} from './rules.js';
import { toRulesRec, validateMonList, validateStoredMon } from './profile.js';

export const STAT_LABELS = Object.freeze({ hp: 'HP', atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed' });
export const STAT_SHORT = Object.freeze({ hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' });
export const BATCH = 16; // validateMon looks at the first 16 moves of a record

const asRuleset = (r) => (typeof r === 'string' ? resolveRuleset(r) : r);

// ---------------------------------------------------------------------------------------------
// rules.js verdicts, as data
// ---------------------------------------------------------------------------------------------

/** The text to show for a reason code: the RULE_CODES meaning when rules.js knows the code, else the reason's own message, else the code. */
export function reasonText(code, message) {
  if (Object.prototype.hasOwnProperty.call(RULE_CODES, code)) return RULE_CODES[code];
  return String(message || code).replace(/\s*\(\s*[a-z]+(?:[-.][a-z]+)+\s*\)/gi, '') || code;          // W1 D6: a machine word the message ends with, in parentheses, is not for the player
}

const moveSlot = (path) => { const m = /^moves\[(\d+)\]$/.exec(path); return m ? Number(m[1]) : -1; };

/**
 * Ask rules.js about a list of move ids for one record. Returns { [moveId]: status } where status = { ok:true } or
 * { ok:false, code, message, text, ...detail } (the FIRST reason at that slot, in rules.js's own order). The record's other fields are
 * irrelevant to the verdict on a move except species and level, so this is accurate for any record.
 */
export function moveStatuses(pack, rec, moveIds, ruleset) {
  const R = asRuleset(ruleset);
  const out = {};
  for (let i = 0; i < moveIds.length; i += BATCH) {
    const batch = moveIds.slice(i, i + BATCH);
    const v = validateMon({ ...rec, moves: batch }, pack, R);
    for (const id of batch) out[id] = { ok: true };
    for (const r of v.reasons) {
      const slot = moveSlot(r.path);
      if (slot < 0 || slot >= batch.length) continue;
      const id = batch[slot];
      if (out[id].ok) { const { path, ...rest } = r; out[id] = { ...rest, ok: false, text: reasonText(r.code, r.message) }; }
    }
  }
  return out;
}

const NONE_ID = 0;
/** Same idea for items: the verdict rules.js gives an item id held by a record of no species (so only the item rule can speak). */
export function itemStatus(pack, itemId, ruleset) {
  const R = asRuleset(ruleset);
  const v = validateMon({
    species: -1, level: 50, nature: 0, abilitySlot: 0, item: itemId, moves: [],
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
  }, pack, R);
  const r = v.reasons.find((x) => x.path === 'item');
  if (!r) return { ok: true };
  const { path, ...rest } = r;
  return { ...rest, ok: false, text: reasonText(r.code, r.message) };
}

// ---------------------------------------------------------------------------------------------
// moves
// ---------------------------------------------------------------------------------------------

let machineMemo = null; // pack -> Map(moveId -> 'TM12' | 'HM03')
function machineLabels(pack) {
  if (machineMemo && machineMemo.pack === pack) return machineMemo.map;
  const map = new Map();
  for (const m of pack.machines) if (!map.has(m.move)) map.set(m.move, m.kind + String(m.number).padStart(2, '0'));
  machineMemo = { pack, map };
  return map;
}

/** Source tags for one learnset entry: [{ kind:'levelUp'|'machine'|'tutor'|'egg', label }] in a fixed order. */
export function sourceTags(pack, entry, moveId) {
  const tags = [];
  if (!entry) return tags;
  if (entry.levelUp !== null) tags.push({ kind: 'levelUp', label: entry.levelUp === 0 ? 'Evo' : 'Lv ' + entry.levelUp });
  if (entry.machine) tags.push({ kind: 'machine', label: machineLabels(pack).get(moveId) || 'TM' });
  if (entry.tutor) tags.push({ kind: 'tutor', label: 'Tutor' });
  if (entry.egg) tags.push({ kind: 'egg', label: 'Egg' });
  return tags;
}

/**
 * Every move the mon's lineage can learn (any level, any source), each with its source tags, the ROM's numbers and rules.js's verdict
 * for THIS mon (species, level, ruleset). opts.allMoves = true appends the moves it cannot learn at all (disabled, why = not-learnable).
 * Deterministic order: by move id.
 */
export function moveCatalog(pack, mon, ruleset, opts = {}) {
  const R = asRuleset(ruleset);
  const rec = toRulesRec(mon, R);
  const learn = learnsetOf(pack, mon.species, R.moves.lineage);
  let ids = Object.keys(learn).map(Number).filter((id) => id >= 1 && id < pack.moves.length && pack.moves[id]);
  if (opts.allMoves) {
    const set = new Set(ids);
    for (let id = 1; id < pack.moves.length; id++) if (pack.moves[id] && !set.has(id) && pack.moves[id].name && pack.moves[id].name !== '-') ids.push(id);
  }
  ids.sort((a, b) => a - b);
  const status = moveStatuses(pack, rec, ids, R);
  return ids.map((id) => {
    const mv = pack.moves[id];
    const entry = learn[id];
    return {
      id, name: mv.name, type: mv.type, category: mv.category, power: mv.power, accuracy: mv.accuracy, pp: mv.pp, priority: mv.priority,
      desc: mv.desc, tags: sourceTags(pack, entry, id), learnable: !!entry, learnLevel: entry ? entry.levelUp : null,
      status: status[id],
    };
  });
}

/** Filter + sort a moveCatalog. q matches the name (substring, case-insensitive); type = ROM type id; category = 0..2; source = a tag kind. */
export function filterMoves(entries, f = {}) {
  const q = (f.q || '').trim().toLowerCase();
  let out = entries.filter((e) => {
    if (q && !e.name.toLowerCase().includes(q)) return false;
    if (f.type !== undefined && f.type !== null && f.type !== '' && e.type !== Number(f.type)) return false;
    if (f.category !== undefined && f.category !== null && f.category !== '' && e.category !== Number(f.category)) return false;
    if (f.powerMin !== undefined && f.powerMin !== null && f.powerMin !== '' && !(e.power >= Number(f.powerMin))) return false;
    if (f.powerMax !== undefined && f.powerMax !== null && f.powerMax !== '' && !(e.power <= Number(f.powerMax))) return false;
    if (f.source && !e.tags.some((t) => t.kind === f.source)) return false;
    if (f.onlyAvailable && !e.status.ok) return false;
    return true;
  });
  const sort = f.sort || 'name';
  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name) || a.id - b.id,
    power: (a, b) => (b.power - a.power) || a.name.localeCompare(b.name),
    type: (a, b) => (a.type - b.type) || a.name.localeCompare(b.name),
    level: (a, b) => ((a.learnLevel === null ? 999 : a.learnLevel) - (b.learnLevel === null ? 999 : b.learnLevel)) || a.name.localeCompare(b.name),
  }[sort] || null;
  if (cmp) out = out.slice().sort(cmp);
  // available moves first, unavailable ones (with their reason) after, each group keeping the chosen order
  return out.filter((e) => e.status.ok).concat(out.filter((e) => !e.status.ok));
}

// ---------------------------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------------------------

/**
 * Items for the held-item picker. opts.holdEffectOnly (default true) keeps items the ROM gives a hold effect (388 of 930 in this ROM): a
 * heuristic for "things worth holding", NOT a rules.js decision (rules.js accepts any item id; the editor narrows the LIST, not the rule).
 * Each item carries rules.js's verdict; unavailable ones are listed after the available ones.
 */
export function itemCatalog(pack, ruleset, opts = {}) {
  const R = asRuleset(ruleset);
  const holdOnly = opts.holdEffectOnly !== false;
  const q = (opts.q || '').trim().toLowerCase();
  const out = [];
  for (const it of pack.items) {
    if (it.id === NONE_ID) continue;
    if (!it.name || /^\?+$/.test(it.name)) continue;
    if (holdOnly && !(it.holdEffect > 0)) continue;
    if (q && !it.name.toLowerCase().includes(q) && !(it.desc || '').toLowerCase().includes(q)) continue;
    out.push({ id: it.id, name: it.name, desc: it.desc, price: it.price, holdEffect: it.holdEffect, holdEffectParam: it.holdEffectParam, machine: it.machine, status: itemStatus(pack, it.id, R) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  return out.filter((e) => e.status.ok).concat(out.filter((e) => !e.status.ok));
}

// ---------------------------------------------------------------------------------------------
// species
// ---------------------------------------------------------------------------------------------

export const uniqueTypes = (sp) => (sp.types[0] === sp.types[1] ? [sp.types[0]] : sp.types.slice());
const isBaseForm = (sp) => !sp.forms || sp.forms.length === 0 || sp.forms[0] === sp.id;

/**
 * Why a species cannot be picked under a ruleset, as a Map(id -> { code, text }): the ruleset's own ban list ('species.banned') plus whatever rules.js
 * says the battle engine cannot run (RULES.engineExcludedSpecies, when this rules.js has it): 'species.engine-no-ability' / 'species.engine-no-move'.
 * An absent id is available. Asked of rules.js on every call (it caches by ruleset content), never copied.
 */
export function speciesExclusions(pack, ruleset) {
  const R = asRuleset(ruleset);
  const out = new Map();
  for (const id of R.banned.species) out.set(id, { code: 'species.banned', text: reasonText('species.banned') });
  if (R.engine && R.engine.enforce && typeof RULES.engineExcludedSpecies === 'function') {
    for (const e of RULES.engineExcludedSpecies(pack, R)) {
      if (out.has(e.id)) continue;
      const code = e.why === 'no-ability' ? 'species.engine-no-ability' : e.why === 'no-move' ? 'species.engine-no-move' : 'species.engine-' + e.why;
      out.set(e.id, { code, text: reasonText(code) });
    }
  }
  return out;
}

/** A display row: { id, name, natDex, types[], baseForm, available, code?, text? }. `available` = on the roster and not excluded by the ruleset (ban or engine layer). */
export function speciesRow(pack, id, ruleset, exclusions) {
  const sp = pack.species[id];
  if (!sp) return null;
  const ex = ruleset ? (exclusions || speciesExclusions(pack, ruleset)).get(id) : null;
  const row = { id, name: sp.name, natDex: sp.natDex, types: uniqueTypes(sp), baseForm: isBaseForm(sp), available: !!sp.legal && !ex };
  if (!sp.legal) { row.code = 'species.illegal'; row.text = reasonText('species.illegal'); } else if (ex) { row.code = ex.code; row.text = ex.text; }
  return row;
}

let searchMemo = null; // pack -> precomputed lowercase names
function searchIndex(pack) {
  if (searchMemo && searchMemo.pack === pack) return searchMemo.index;
  const typeByName = new Map(pack.types.map((t) => [t.name.toLowerCase(), t.id]));
  const index = pack.roster.map((id) => ({ id, name: pack.species[id].name.toLowerCase(), natDex: pack.species[id].natDex, types: uniqueTypes(pack.species[id]) }));
  searchMemo = { pack, index, typeByName };
  return index;
}

/**
 * Roster species matching a query. Tokens are AND-ed: a token matches a name substring, a Pokedex number / species id (digits, optional
 * leading '#'), or a type name (exact, case-insensitive). Ordered by Pokedex number then id. Banned species are returned LAST and marked
 * unavailable by speciesRow, so the picker can show them disabled.
 */
export function speciesSearch(pack, query, ruleset, opts = {}) {
  const index = searchIndex(pack);
  const exclusions = speciesExclusions(pack, ruleset);
  const typeByName = searchMemo.typeByName;
  const toks = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const hits = index.filter((s) => toks.every((t) => {
    const num = /^#?(\d+)$/.exec(t);
    if (num) { const n = Number(num[1]); return s.natDex === n || s.id === n || String(s.natDex).startsWith(num[1]); }
    if (typeByName.has(t) && s.types.includes(typeByName.get(t))) return true;
    return s.name.includes(t);
  }));
  hits.sort((a, b) => a.natDex - b.natDex || a.id - b.id);
  const rows = hits.map((s) => speciesRow(pack, s.id, ruleset, exclusions));
  const avail = rows.filter((r) => r.available);
  return (opts.unavailable === 'hide' ? avail : avail.concat(rows.filter((r) => !r.available))).map((r) => r.id);
}

/** Gender options a species allows, from the ROM gender ratio (255 genderless, 0 male only, 254 female only). */
export function genderOptions(pack, speciesId) {
  const r = pack.species[speciesId] ? pack.species[speciesId].genderRatio : 127;
  return r === 255 ? ['-'] : r === 0 ? ['M'] : r === 254 ? ['F'] : ['M', 'F'];
}
export function defaultGender(pack, speciesId, current) {
  const opts = genderOptions(pack, speciesId);
  return opts.includes(current) ? current : opts[0];
}

// ---------------------------------------------------------------------------------------------
// ability + nature
// ---------------------------------------------------------------------------------------------

/**
 * The species' ability slots with what rules.js says: [{ slot, id, name, short, long, hidden, allowed, code, text }] for every NON-EMPTY slot,
 * then `innates` = the species' innate abilities (read from the ROM, shown for reference: the arena engine decides what they do).
 */
export function abilityOptions(pack, speciesId, ruleset) {
  const R = asRuleset(ruleset);
  const sp = pack.species[speciesId];
  if (!sp) return { slots: [], innates: [] };
  const slots = [];
  const level = R.level.fixed !== null ? R.level.fixed : R.level.max;
  const stats0 = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
  for (let s = 0; s < 3; s++) {
    const id = sp.abilities[s];
    if (!id) continue;
    const ab = pack.abilities[id] || { name: '?', short: '', long: '' };
    // the verdict is rules.js's: the slot rule, the ban list and the engine layer all come back as reasons on this one-slot probe
    const v = validateMon({ species: speciesId, level, nature: 0, abilitySlot: s, item: 0, moves: [], ivs, evs: stats0, points: stats0 }, pack, R);
    const r = v.reasons.find((x) => x.path === 'abilitySlot') || v.reasons.find((x) => x.code === 'species.engine-no-ability');
    const allowed = !r, code = r ? r.code : null, text = r ? reasonText(r.code, r.message) : null;
    slots.push({ slot: s, id, name: ab.name, short: ab.short, long: ab.long, hidden: s === 2, allowed, code, text });
  }
  const innates = sp.innates.filter((id) => id).map((id) => { const ab = pack.abilities[id] || { name: '?', short: '', long: '' }; return { id, name: ab.name, short: ab.short, long: ab.long }; });
  return { slots, innates };
}

/** The 25 natures: { id, name, up, down, neutral, label } where label reads like "Adamant (+Atk, -SpA)" or "Hardy (neutral)". */
export function natureOptions(pack) {
  return pack.natures.map((n) => {
    const neutral = n.up === n.down;
    return { id: n.id, name: n.name, up: neutral ? null : n.up, down: neutral ? null : n.down, neutral, label: neutral ? `${n.name} (neutral)` : `${n.name} (+${STAT_SHORT[n.up]}, -${STAT_SHORT[n.down]})` };
  });
}

// ---------------------------------------------------------------------------------------------
// derived numbers
// ---------------------------------------------------------------------------------------------

/**
 * What the editor shows next to the EV / IV inputs for one stored mon under a ruleset:
 *   { ok, stats{hp..spe}, level (the battle level), nature, evs (effective), points (per stat, Champions view), pointsUsed, evUsed,
 *     hiddenPower { typeId, type, power }, error? }
 * Never throws: an unusable record (unknown species ...) returns { ok:false, error }.
 */
export function derived(pack, mon, ruleset) {
  const R = asRuleset(ruleset);
  try {
    const rec = toRulesRec(mon, R);
    const stats = battleStats(rec, pack, R);
    const evs = effectiveEvs(rec, R);
    const points = evsToPoints(evs, R.iv.fixed !== null ? Object.fromEntries(STAT_ORDER.map((k) => [k, R.iv.fixed])) : mon.iv);
    const nat = pack.natures[mon.nature] || null;
    const hp = hiddenPower(R.iv.fixed !== null ? Object.fromEntries(STAT_ORDER.map((k) => [k, R.iv.fixed])) : mon.iv, { fixedPower: 60 });
    return {
      ok: true, stats, level: battleLevel(rec, R), nature: nat ? { id: nat.id, name: nat.name, up: nat.up === nat.down ? null : nat.up, down: nat.up === nat.down ? null : nat.down } : null,
      evs, points, pointsUsed: sumStats(points), evUsed: sumStats(evs), hiddenPower: { typeId: hp.typeId, type: hp.type, power: hp.power },
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** Which of the two EV views a ruleset makes the STORED form: 'points' for the Champions layer, else 'ev'. */
export const storedView = (ruleset) => (asRuleset(ruleset).points ? 'points' : 'ev');

/** The budgets the EV panel shows: { ev: {used,total,remaining,over}|null, points: {...}|null }. EV total is null when the ruleset relaxes it. */
export function budgets(mon, ruleset) {
  const R = asRuleset(ruleset);
  const evs = effectiveEvs(toRulesRec(mon, R), R);
  const points = evsToPoints(evs, R.iv.fixed !== null ? Object.fromEntries(STAT_ORDER.map((k) => [k, R.iv.fixed])) : mon.iv);
  const mk = (used, total) => (total === null ? null : { used, total, remaining: total - used, over: used > total });
  return {
    ev: mk(sumStats(evs), R.ev.total),
    points: mk(sumStats(points), R.points ? R.points.total : POINTS.total),
    pointsBinding: !!R.points, evPerStat: R.ev.perStat, pointsPerStat: R.points ? R.points.perStat : POINTS.perStat,
  };
}

// ---------------------------------------------------------------------------------------------
// validation, grouped for display
// ---------------------------------------------------------------------------------------------

const FIELD_LABELS = {
  species: 'Species', level: 'Level', nature: 'Nature', abilitySlot: 'Ability', item: 'Held item', moves: 'Moves', ivs: 'IVs', evs: 'EVs', points: 'Stat points', gender: 'Gender',
};
/** Human label of a rules.js / profile.js path such as 'moves[2]' or 'ivs.atk' or 'mons[1].level'. */
export function fieldLabel(path) {
  const p = String(path || '').replace(/^mons\[\d+\]\.?/, '');
  const head = p.split(/[.[]/)[0];
  const base = FIELD_LABELS[head] || (head === 'team' ? 'Team' : head ? head : 'Team');
  const m = /^moves\[(\d+)\]/.exec(p);
  if (m) return `Move ${Number(m[1]) + 1}`;
  const s = /^(?:ivs|evs|points)\.(\w+)/.exec(p);
  if (s && STAT_LABELS[s[1]]) return `${base} (${STAT_LABELS[s[1]]})`;
  return base;
}

/**
 * Validate a team of STORED mons under a ruleset. Returns
 *   { ok, count, team: [problem], mons: [[problem] per mon] }   problem = { code, text, message, path, label, mon? }
 * `text` is RULE_CODES[code] (or the reason's own message for a code rules.js does not list), `message` the reason's specific message.
 */
export function validationView(pack, mons, ruleset) {
  const R = asRuleset(ruleset);
  const v = validateMonList(mons, pack, R);
  const mk = (r) => ({ code: r.code, text: reasonText(r.code, r.message), message: r.message || '', path: r.path || '', label: fieldLabel(r.path), ...(r.mon !== undefined ? { mon: r.mon } : {}) });
  const team = [], per = mons.map(() => []);
  for (const r of v.reasons) {
    if (r.mon !== undefined && per[r.mon]) per[r.mon].push(mk(r));
    else team.push(mk(r));
  }
  return { ok: v.ok, count: v.reasons.length, team, mons: per };
}

/** The verdict for ONE stored mon (profile record) under a ruleset: { ok, problems[] } with the same problem shape. */
export function monProblems(pack, mon, ruleset) {
  const R = asRuleset(ruleset);
  const v = validateStoredMon(mon, pack, R);
  return { ok: v.ok, problems: v.reasons.map((r) => ({ code: r.code, text: reasonText(r.code, r.message), message: r.message || '', path: r.path || '', label: fieldLabel(r.path) })) };
}

export { LIMITS, POINTS, STAT_ORDER };

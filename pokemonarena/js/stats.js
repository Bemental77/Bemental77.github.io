// pokemonarena/js/stats.js -- Gen 3 stat arithmetic, natures, Hidden Power and the Champions-style "points" view.
//
// Pure ES module (browser + Node): no imports, no DOM, no clocks, no randomness, no globals. Integer
// arithmetic only (see idiv) so every peer computes bit-identical numbers; a netplay stage can call it on
// both sides and compare. Nothing here is ROM content: the formulas are code, the base stats / natures /
// names come in as arguments (from the C1 pack, tables.js).
//
// FORMULAS (what is and is not verified -- read before relying on them):
//   HP    = floor((2*B + IV + floor(EV/4)) * L / 100) + L + 10
//   other = floor((2*B + IV + floor(EV/4)) * L / 100) + 5, then a nature multiplier: x110/100 or x90/100, floored
//   Provenance, in order of strength:
//   1. The hack's OWN routine, read statically from the ROM (this stage; nothing was executed): a function at file
//      offset 0x1ed920 loops over the six stats and computes exactly the sums above, with the divides done by
//      the ROM's signed-divide routine (so truncating, i.e. floor for these non-negative values), the nature
//      multipliers 110/100 on the raised stat and 90/100 on the lowered one (neutral when the table's raised ==
//      lowered), and a special case that gives species 292 (Shedinja) HP 1. Its literal pool points at the same
//      species and nature tables tables.js decodes. tools/pokemonarena_rules_test.mjs (rom/code/* checks) pins each
//      of those facts as an assertion on the instruction encodings and has ROM-byte mutants that make them fail.
//      The earlier research stage had recorded "the hack's own formula not located"; that is now out of date.
//   2. The standard main-series source (pret CalculateMonStats / ModifyStatByNature) as recorded by the earlier
//      research stage; THIS STAGE DID NOT RE-FETCH THE DECOMP (no third-party code may be downloaded here).
//   3. Well-known in-game values, used as golden vectors (a Lv100 Garchomp, base 108/130/102, IV 31, 252 EV in
//      HP/Attack/Speed: 420 HP, 394 Attack with a raising nature, 333 Speed with a raising nature).
//   STILL UNMODELLED: the ROM routine raises an IV to 31 when a per-stat "hyper trained" flag is set (a hack
//   feature stored in the mon; the record here has no such flag, so IVs are taken as given).
//   Shedinja: the ROM keys the HP-1 rule on species id 292. Here it is keyed on base HP === 1 because this module
//   sees base stats, not ids; the pack has exactly one such species (292), asserted by the test, so the two agree.
//
// POINTS VIEW (Champions-style). At level 50 with an ODD IV (31), one stat point = +1 stat, and the stored-EV
// conversion is "4 EV for the first point of a stat, 8 for each further one" (252 EV = 32 points). That
// falls straight out of the formula: gain(q) = floor((q + (IV & 1)) / 2) where q = floor(EV/4).
// (IV 31 is odd, hence the 4-then-8 shape. With an even IV the first point costs 8 as well.)

export const STAT_ORDER = Object.freeze(['hp', 'atk', 'def', 'spa', 'spd', 'spe']); // order every UI shows
export const ROM_STAT_ORDER = Object.freeze(['hp', 'atk', 'def', 'spe', 'spa', 'spd']); // ROM struct order (tables.js STAT_KEYS)
export const NATURE_STATS = Object.freeze(['atk', 'def', 'spe', 'spa', 'spd']); // the five stats a nature can touch, in nature-table order

export const LIMITS = Object.freeze({
  ivMax: 31,
  evMax: 255, // a single EV byte
  evTotalMax: 510, // main-series total EV cap
  evDivisor: 4, // only floor(EV/4) reaches the formula
  levelMin: 1,
  levelMax: 100,
});

export const POINTS = Object.freeze({
  level: 50, // the level at which 1 point = +1 stat
  ivFixed: 31, // Champions-style spreads assume perfect IVs
  perStat: 32,
  total: 66,
});

// ---------------------------------------------------------------------------------------------
// integer helpers
// ---------------------------------------------------------------------------------------------

/** Integer division of non-negative integers. Never goes through a float quotient. */
function idiv(a, b) {
  return (a - (a % b)) / b;
}

function nonNeg(name, v) {
  if (!Number.isInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer, got ${String(v)}`);
  return v;
}

function levelOk(v) {
  if (!Number.isInteger(v) || v < LIMITS.levelMin || v > LIMITS.levelMax) {
    throw new RangeError(`level must be an integer ${LIMITS.levelMin}..${LIMITS.levelMax}, got ${String(v)}`);
  }
  return v;
}

// ---------------------------------------------------------------------------------------------
// core formulas
// ---------------------------------------------------------------------------------------------

/** HP, before any special case. */
export function calcHp(base, iv, ev, level) {
  nonNeg('base', base); nonNeg('iv', iv); nonNeg('ev', ev); levelOk(level);
  return idiv((2 * base + iv + idiv(ev, LIMITS.evDivisor)) * level, 100) + level + 10;
}

/** A non-HP stat BEFORE the nature multiplier. */
export function calcOtherRaw(base, iv, ev, level) {
  nonNeg('base', base); nonNeg('iv', iv); nonNeg('ev', ev); levelOk(level);
  return idiv((2 * base + iv + idiv(ev, LIMITS.evDivisor)) * level, 100) + 5;
}

/** Nature multiplier on an already-computed stat: +1 -> x110/100, -1 -> x90/100, 0 -> unchanged. */
export function applyNature(stat, mod) {
  nonNeg('stat', stat);
  if (mod > 0) return idiv(stat * 110, 100);
  if (mod < 0) return idiv(stat * 90, 100);
  return stat;
}

/** One stat by key. HP ignores `mod`; every other key applies it. */
export function calcStat(key, base, iv, ev, level, mod = 0) {
  if (key === 'hp') return calcHp(base, iv, ev, level);
  if (!STAT_ORDER.includes(key)) throw new RangeError(`unknown stat key ${String(key)}`);
  return applyNature(calcOtherRaw(base, iv, ev, level), mod);
}

// ---------------------------------------------------------------------------------------------
// natures
// ---------------------------------------------------------------------------------------------

/** The canonical Gen 3 layout: nature n raises NATURE_STATS[floor(n/5)] and lowers NATURE_STATS[n % 5]; up===down is neutral.
 *  This is arithmetic, not a stored table; tables.js decodes the ROM's own table and natureMismatches() diffs the two. */
export function builtinNature(id) {
  if (!Number.isInteger(id) || id < 0 || id > 24) throw new RangeError(`nature id must be 0..24, got ${String(id)}`);
  return { id, up: NATURE_STATS[idiv(id, 5)], down: NATURE_STATS[id % 5] };
}

/** Resolve a nature given as an id (looked up in `table` when supplied -- the ROM's table via the pack -- else the
 *  builtin layout) or as an already-resolved { up, down }. Returns { up, down }. */
export function resolveNature(nature, table) {
  if (nature !== null && typeof nature === 'object') {
    if (!NATURE_STATS.includes(nature.up) || !NATURE_STATS.includes(nature.down)) throw new RangeError('nature object needs up/down stat keys');
    return { up: nature.up, down: nature.down };
  }
  if (table) {
    const e = table[nature];
    if (!e) throw new RangeError(`nature id ${String(nature)} is not in the supplied table`);
    return { up: e.up, down: e.down };
  }
  const b = builtinNature(nature);
  return { up: b.up, down: b.down };
}

/** -1 / 0 / +1 for one stat key under a resolved nature. HP is never touched. */
export function natureMod(resolved, key) {
  if (key === 'hp') return 0;
  if (resolved.up === resolved.down) return 0;
  if (key === resolved.up) return 1;
  if (key === resolved.down) return -1;
  return 0;
}

/** ids where `table[id]` (the pack's ROM-decoded natures) disagrees with the canonical layout. [] means they agree. */
export function natureMismatches(table) {
  const bad = [];
  for (let id = 0; id < 25; id++) {
    const e = table[id], b = builtinNature(id);
    if (!e || e.up !== b.up || e.down !== b.down) bad.push(id);
  }
  if (table.length !== 25) bad.push(-1);
  return bad;
}

// ---------------------------------------------------------------------------------------------
// whole-mon stats
// ---------------------------------------------------------------------------------------------

/**
 * All six stats.
 *   base    { hp, atk, def, spa, spd, spe }  (a species' baseStats)
 *   ivs     { ... } 0..31       evs { ... } raw EVs (NOT points)
 *   level   the level the stats are computed AT (the battle level, after any normalisation)
 *   nature  id | { up, down }   table: optional ROM nature table (pack.natures)
 *   opts.fixedHp1 (default true): a base HP of exactly 1 yields max HP 1 (Shedinja rule)
 */
export function computeStats(base, ivs, evs, level, nature, table, opts = {}) {
  const nat = resolveNature(nature, table);
  const out = {};
  for (const k of STAT_ORDER) {
    const b = base[k], i = ivs[k], e = evs[k];
    if (k === 'hp') out.hp = (opts.fixedHp1 !== false && b === 1) ? 1 : calcHp(b, i, e, level);
    else out[k] = calcStat(k, b, i, e, level, natureMod(nat, k));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Hidden Power (Gen 3 rule)
// ---------------------------------------------------------------------------------------------

/** The sixteen Hidden Power types, index 0..15, with the ROM's own type ids (None 0, Normal 1, ..., ??? 10, Fire 11 ... Dark 18).
 *  tables.js decodes the ROM's type names; the test cross-checks these ids against them. */
export const HIDDEN_POWER_TYPES = Object.freeze([
  Object.freeze({ index: 0, name: 'Fighting', id: 2 }),
  Object.freeze({ index: 1, name: 'Flying', id: 3 }),
  Object.freeze({ index: 2, name: 'Poison', id: 4 }),
  Object.freeze({ index: 3, name: 'Ground', id: 5 }),
  Object.freeze({ index: 4, name: 'Rock', id: 6 }),
  Object.freeze({ index: 5, name: 'Bug', id: 7 }),
  Object.freeze({ index: 6, name: 'Ghost', id: 8 }),
  Object.freeze({ index: 7, name: 'Steel', id: 9 }),
  Object.freeze({ index: 8, name: 'Fire', id: 11 }),
  Object.freeze({ index: 9, name: 'Water', id: 12 }),
  Object.freeze({ index: 10, name: 'Grass', id: 13 }),
  Object.freeze({ index: 11, name: 'Electric', id: 14 }),
  Object.freeze({ index: 12, name: 'Psychic', id: 15 }),
  Object.freeze({ index: 13, name: 'Ice', id: 16 }),
  Object.freeze({ index: 14, name: 'Dragon', id: 17 }),
  Object.freeze({ index: 15, name: 'Dark', id: 18 }),
]);

/**
 * Gen 3 Hidden Power from IVs. Bit i of the type word is the LOW bit of the IV of ROM_STAT_ORDER[i]
 * (HP, Atk, Def, Spe, SpA, SpD); bit i of the power word is the SECOND-lowest bit.
 *   type  = HIDDEN_POWER_TYPES[floor(typeBits * 15 / 63)]
 *   power = floor(powerBits * 40 / 63) + 30      (30..70)
 * opts.fixedPower: return that power instead (the ROM's move table lists Hidden Power at a fixed 60, which suggests
 * the hack uses a fixed power -- see the test; the 30..70 formula is the Gen 3 default and is UNVERIFIED for the hack).
 */
export function hiddenPower(ivs, opts = {}) {
  let typeBits = 0, powerBits = 0;
  for (let i = 0; i < ROM_STAT_ORDER.length; i++) {
    const v = nonNeg(`ivs.${ROM_STAT_ORDER[i]}`, ivs[ROM_STAT_ORDER[i]]);
    typeBits += (v & 1) * (1 << i);
    powerBits += ((v >> 1) & 1) * (1 << i);
  }
  const t = HIDDEN_POWER_TYPES[idiv(typeBits * 15, 63)];
  const power = opts.fixedPower !== undefined ? opts.fixedPower : idiv(powerBits * 40, 63) + 30;
  return { typeIndex: t.index, typeId: t.id, type: t.name, power, typeBits, powerBits };
}

function popcount6(n) {
  let c = 0;
  for (let i = 0; i < 6; i++) c += (n >> i) & 1;
  return c;
}

/**
 * An IV spread for "Hidden Power <type>": every IV is 30 or 31 (so the power word is all ones = power 70), choosing
 * among the type words that give this type the one with the HIGHEST IV total, ties broken to lower Attack first,
 * then Defense, Sp.Atk, Sp.Def, Speed, HP. That rule is this module's own convention (a special set needs Attack
 * least); it is NOT claimed to equal any other teambuilder's preset table. What IS guaranteed (and tested) is the
 * round trip: hiddenPower(hiddenPowerIvs(t)) is type t at power 70.
 */
export function hiddenPowerIvs(type) {
  const idx = typeof type === 'string' ? HIDDEN_POWER_TYPES.findIndex((t) => t.name === type) : type;
  if (!Number.isInteger(idx) || idx < 0 || idx > 15) throw new RangeError(`unknown Hidden Power type ${String(type)}`);
  const pref = [1, 2, 4, 5, 3, 0]; // indexes into ROM_STAT_ORDER, most-wants-to-be-lowered first
  let best = -1;
  for (let t = 0; t < 64; t++) {
    if (idiv(t * 15, 63) !== idx) continue;
    if (best < 0) { best = t; continue; }
    const a = popcount6(t), b = popcount6(best);
    if (a > b) { best = t; continue; }
    if (a < b) continue;
    for (const p of pref) { // equal totals: lower the preferred stat
      const ta = (t >> p) & 1, tb = (best >> p) & 1;
      if (ta !== tb) { if (ta < tb) best = t; break; }
    }
  }
  const ivs = {};
  ROM_STAT_ORDER.forEach((k, i) => { ivs[k] = 30 + ((best >> i) & 1); });
  return ivs;
}

// ---------------------------------------------------------------------------------------------
// points view (Champions-style): 1 point = +1 stat at level 50
// ---------------------------------------------------------------------------------------------

/** Largest number of points an IV can reach with a single-byte EV (IV 31 -> 32). */
export function maxPoints(iv = POINTS.ivFixed) {
  return evToPoints(LIMITS.evMax, iv);
}

/** Stat gain at level 50 (before any nature) that `ev` buys over 0 EV, for an IV of the given parity. */
export function evToPoints(ev, iv = POINTS.ivFixed) {
  nonNeg('ev', ev); nonNeg('iv', iv);
  return idiv(idiv(ev, LIMITS.evDivisor) + (iv & 1), 2);
}

/** Smallest EV that buys `points` at level 50: 0 -> 0; for an odd IV 1 -> 4, 2 -> 12, ... 32 -> 252 (the official
 *  4-then-8 conversion); for an even IV 8 per point. Throws if the result would not fit in an EV byte. */
export function pointsToEv(points, iv = POINTS.ivFixed) {
  nonNeg('points', points); nonNeg('iv', iv);
  if (points === 0) return 0;
  const ev = LIMITS.evDivisor * (2 * points - (iv & 1));
  if (ev > LIMITS.evMax) throw new RangeError(`${points} points need ${ev} EV, over ${LIMITS.evMax} (IV ${iv} reaches at most ${maxPoints(iv)})`);
  return ev;
}

/** { hp: ev, ... } -> { hp: points, ... }. `ivs` may be omitted (all 31). */
export function evsToPoints(evs, ivs) {
  const out = {};
  for (const k of STAT_ORDER) out[k] = evToPoints(evs[k], ivs ? ivs[k] : POINTS.ivFixed);
  return out;
}

/** { hp: points, ... } -> { hp: EV, ... } by the minimum-EV conversion above. */
export function pointsToEvs(points, ivs) {
  const out = {};
  for (const k of STAT_ORDER) out[k] = pointsToEv(points[k], ivs ? ivs[k] : POINTS.ivFixed);
  return out;
}

export function sumStats(obj) {
  let s = 0;
  for (const k of STAT_ORDER) s += obj[k];
  return s;
}

/** Remaining counter: total - used. Negative means over budget. */
export function remaining(total, used) {
  return total - used;
}

/** { unit, used, total, remaining, over } for a points block (default budget 66). */
export function pointsBudget(points, total = POINTS.total) {
  const used = sumStats(points);
  return { unit: 'points', used, total, remaining: remaining(total, used), over: used > total };
}

/** { unit, used, total, remaining, over } for raw EVs (default budget 510). */
export function evBudget(evs, total = LIMITS.evTotalMax) {
  const used = sumStats(evs);
  return { unit: 'ev', used, total, remaining: remaining(total, used), over: used > total };
}

/**
 * Snap-to-minimum for ONE stat: the smallest EV (<= `ev`) that yields the same FINAL stat (nature included) at
 * `level`. Typing 255 where 252 buys the same stat snaps to 252; at level 50 an EV between two points snaps down
 * to the cheaper one. Monotone in EV, so the first match from 0 is the minimum.
 */
export function snapEvToMinimum(ev, ctx) {
  nonNeg('ev', ev);
  const target = calcStat(ctx.stat, ctx.base, ctx.iv, ev, ctx.level, ctx.mod || 0);
  for (let e = 0; e <= ev; e++) {
    if (calcStat(ctx.stat, ctx.base, ctx.iv, e, ctx.level, ctx.mod || 0) === target) return e;
  }
  return ev; // unreachable: e === ev always matches
}

/** snapEvToMinimum for all six stats. `nature` as in computeStats. Returns { evs, saved } (saved = EV freed). */
export function snapEvsToMinimum(base, ivs, evs, level, nature, table) {
  const nat = resolveNature(nature, table);
  const out = {};
  let saved = 0;
  for (const k of STAT_ORDER) {
    out[k] = snapEvToMinimum(evs[k], { stat: k, base: base[k], iv: ivs[k], level, mod: natureMod(nat, k) });
    saved += evs[k] - out[k];
  }
  return { evs: out, saved };
}

/**
 * The view the editor shows when the points toggle is on: per-stat points (stat gain at level 50), the cheapest EVs
 * that buy them, and the raw EV total next to the snapped one.
 */
export function pointsView(evs, ivs) {
  const points = evsToPoints(evs, ivs);
  const minEvs = pointsToEvs(points, ivs);
  return {
    points,
    minEvs,
    pointsUsed: sumStats(points),
    evUsed: sumStats(evs),
    evUsedMin: sumStats(minEvs),
  };
}

// ---------------------------------------------------------------------------------------------
// canonical JSON + a tiny fingerprint, for putting a ruleset id/content next to a disc string
// ---------------------------------------------------------------------------------------------

/** JSON with object keys sorted at every depth; arrays keep their order. Throws on undefined/function/non-finite numbers. */
export function canonicalJSON(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJSON: non-finite number');
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  }
  throw new TypeError('canonicalJSON: unsupported type ' + t);
}

/** 32-bit FNV-1a of a string's UTF-16 code units, as 8 hex digits. A FINGERPRINT for drift detection, not a security hash. */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

#!/usr/bin/env node
// POKEMONARENA STATS + RULES TEST  (stage C2 / workstream R1)
//
// Proves that pokemonarena/js/stats.js and pokemonarena/js/rules.js compute and enforce what they claim against the
// REAL pack decoded from the pinned ROM, and that the checks themselves can fail:
//
//   * ONE SUITE of named checks (`stats/...`, `rules/...`, `purity/...`, `determinism/...`) is defined as data and can
//     be run against ANY pair of module sources. First against the real files, then against each MUTANT.
//   * MUTANTS: ~70 one-snippet edits of stats.js / rules.js (an off-by-one, a flipped sign, a dropped guard, a rule
//     switched off, ...). Each names the check(s) that MUST fail for it. The harness refuses a mutant whose target
//     snippet is not found exactly the stated number of times (so a refactor cannot silently turn it into a no-op).
//   * TWINS: the unmutated source goes through the SAME loader (data: URL import, no edit) and must pass every
//     check silently, and must produce the same digest as the real files -- a loader that broke things would show.
//   * MATRIX: every code in RULES.RULE_CODES has a bad record that fires it (at the stated path, and nothing else)
//     and a good twin that is fully silent; the matrix also fails if a code is added without a case.
//   * DIFFERENTIAL: an independent, test-local validator and an independent lineage/learnset oracle are compared with
//     rules.js over thousands of generated records on all four preset rulesets, plus a junk-input fuzz that must
//     never throw.
//   * GOLDEN VECTORS: Base 100 / IV 31 / Lv50: EV 0 -> HP 175, other 120; EV 252 -> HP 207, other 152, +nature 167,
//     -nature 136; the points identity over base 1..255 x points 0..32 (8415 cells, 0 mismatches).
//
// WHAT THIS DOES NOT PROVE (also printed at the end): the formulas are the standard main-series ones; the hack's OWN
// stat routine was not located in the ROM code (see stats.js header), so "matches the hack" is untested until a
// conformance run against the real game exists. Hidden Power's POWER is flagged: the ROM move table says 60.
//
// USAGE   node tools/pokemonarena_rules_test.mjs         (from anywhere; exits non-zero on any failure)
// ENV     ARENA_ROM      path to the ROM (default gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba)
//         ARENA_FUZZ     records per ruleset in the differential run (default 4000)
//         ARENA_BROWSER=1 adds headless-Chrome parity (needs PORT=8093 node tools/devserver.mjs; ARENA_BASE, ARENA_CDP_PORT)
//
// Reads the ROM, writes nothing. Pure ASCII.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as STATS0 from '../pokemonarena/js/stats.js';
import * as RULES0 from '../pokemonarena/js/rules.js';
import { loadPack, learnableMoves, STAT_KEYS, LAYOUT } from '../pokemonarena/js/tables.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const STATS_PATH = path.join(root, 'pokemonarena', 'js', 'stats.js');
const RULES_PATH = path.join(root, 'pokemonarena', 'js', 'rules.js');
const FUZZ_N = Number(process.env.ARENA_FUZZ || 4000);

// ---------------------------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------------------------
let passed = 0, failed = 0;
const failures = [];
function t(name, ok, detail = '') {
  if (ok === true) { passed++; console.log(`  ok   ${name}`); }
  else {
    failed++;
    const why = typeof ok === 'string' ? ok : detail;
    failures.push(`${name}: ${why}`);
    console.log(`  FAIL ${name}${why ? '  -- ' + why : ''}`);
  }
}
const head = (s) => console.log(`\n== ${s}`);
const J = (x) => JSON.stringify(x);
const eqv = (got, want) => (J(got) === J(want) ? true : `got ${J(got)} want ${J(want)}`);
const all = (xs, fn) => { for (const x of xs) { const r = fn(x); if (r !== true) return r; } return true; };

if (!fs.existsSync(ROM_PATH)) { console.error(`ROM not found: ${ROM_PATH}  (set ARENA_ROM)`); process.exit(2); }
const rom = fs.readFileSync(ROM_PATH);

function deepFreeze(o) {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); }
  return o;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------------------------------------
// reference data embedded in the TEST (hand-written, not ROM-derived)
// ---------------------------------------------------------------------------------------------
const UI = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const ROM_ORDER = ['hp', 'atk', 'def', 'spe', 'spa', 'spd'];
// The standard 25-nature chart by in-game id order: [raised, lowered]; null = neutral. Series vocabulary, hand-written.
const NATURE_CHART = [
  ['Hardy', null, null], ['Lonely', 'atk', 'def'], ['Brave', 'atk', 'spe'], ['Adamant', 'atk', 'spa'], ['Naughty', 'atk', 'spd'],
  ['Bold', 'def', 'atk'], ['Docile', null, null], ['Relaxed', 'def', 'spe'], ['Impish', 'def', 'spa'], ['Lax', 'def', 'spd'],
  ['Timid', 'spe', 'atk'], ['Hasty', 'spe', 'def'], ['Serious', null, null], ['Jolly', 'spe', 'spa'], ['Naive', 'spe', 'spd'],
  ['Modest', 'spa', 'atk'], ['Mild', 'spa', 'def'], ['Quiet', 'spa', 'spe'], ['Bashful', null, null], ['Rash', 'spa', 'spd'],
  ['Calm', 'spd', 'atk'], ['Gentle', 'spd', 'def'], ['Sassy', 'spd', 'spe'], ['Careful', 'spd', 'spa'], ['Quirky', null, null],
];
// BigInt reference arithmetic: a different code path from the module's integer helper.
function bigStat(kind, b, iv, ev, lv, mod) {
  const B = BigInt;
  let x = ((2n * B(b) + B(iv) + B(ev) / 4n) * B(lv)) / 100n;
  if (kind === 'hp') return Number(x + B(lv) + 10n);
  x += 5n;
  if (mod > 0) x = (x * 110n) / 100n; else if (mod < 0) x = (x * 90n) / 100n;
  return Number(x);
}
function bruteSnap(kind, b, iv, ev, lv, mod) {
  const target = bigStat(kind, b, iv, ev, lv, mod);
  for (let e = 0; e <= ev; e++) if (bigStat(kind, b, iv, e, lv, mod) === target) return e;
  return ev;
}
const throwsKind = (fn, Kind) => { try { fn(); return 'did not throw'; } catch (e) { return e instanceof Kind ? true : `threw ${e && e.name}: ${e && e.message}`; } };

// ---------------------------------------------------------------------------------------------
// the pack (decoded once from the real ROM, then deep-frozen so any mutation by the code under test throws)
// ---------------------------------------------------------------------------------------------
const tPack0 = process.hrtime.bigint();
const pack = loadPack(rom);
const packMs = Number(process.hrtime.bigint() - tPack0) / 1e6;
deepFreeze(pack);
const moveId = (name) => { const m = pack.moves.find((x) => x.name === name); if (!m) throw new Error('no move named ' + name); return m.id; };
const MV = Object.fromEntries(['Earthquake', 'Dragon Claw', 'Sandstorm', 'Dig', 'Thunderbolt', 'Hydro Pump', 'Surf', 'Thunder Wave', 'Flamethrower', 'Dragon Dance',
  'Belly Drum', 'Transform', 'Tackle', 'Take Down', 'Fake Out', 'Hidden Power', 'Slash', 'Bite'].map((n) => [n, moveId(n)]));
const NULL_SLOT = pack.species.findIndex((x, i) => i > 0 && x === null);
const MILOTIC = pack.species.find((x) => x && x.legal && x.name === 'Milotic').id;
const TYRANITAR = pack.species.find((x) => x && x.legal && x.name === 'Tyranitar').id, GENGAR = pack.species.find((x) => x && x.legal && x.name === 'Gengar').id;
const MEGA_STONE = pack.items.find((i) => i.name === 'Venusaurite').id;
const NO_ABILITY_SPECIES = RULES0.engineExcludedSpecies(pack, 'arena-gen3-standard').find((e) => e.why === 'no-ability').id; // a species whose every ability slot the engine cannot run
// a move Garchomp can legally learn that the battle engine cannot run (found through the pure learnset rule, engine layer off)
const ENGINE_UNSUPPORTED_GARCHOMP_MOVE = moveId('Stone Edge');   // legal for Garchomp; unsupported only in the poisoned pack of the matrix case below
// round 3: every move a species learns is now run by the engine, so the unsupported-move case uses a pack where Stone Edge is turned into a Dynamax-class effect (a class the engine does not run)
const poisonMove = (P, id) => ({ ...P, moves: P.moves.map((m, i) => (i === id ? { ...m, effect: 307 } : m)) });
// a species with one ability slot the engine runs and one it does not (looked up, so the fixture follows what the engine supports)
const MIXED_AB = (() => { const sup = RULES0.engineSupports(pack).abilities; for (const sid of pack.roster) { const sl = pack.species[sid].abilities; const good = [0, 1, 2].find((k) => sl[k] && sup.has(sl[k])), bad = [0, 1, 2].find((k) => sl[k] && !sup.has(sl[k])); if (good !== undefined && bad !== undefined) return { sid, good, bad }; } return null; })();
const ITEM = { Leftovers: 472, LifeOrb: 479, ChoiceBand: 442 };
const STD = 'arena-gen3-standard', STRICT = RULES0.STRICT_RULESET_ID;
const PRESETS = [STD, STRICT, 'arena-gen3-standard+lv5', 'arena-gen3-standard+lv100+item-clause'];

// ---------------------------------------------------------------------------------------------
// record fixtures
// ---------------------------------------------------------------------------------------------
const ivs31 = () => ({ hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 });
const zero6 = () => ({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 });
const garch = () => ({ species: 445, level: 100, nature: 3, abilitySlot: 2, item: ITEM.Leftovers, moves: [MV.Earthquake, MV['Dragon Claw'], MV.Sandstorm, MV.Dig], ivs: ivs31(), evs: { hp: 6, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 } });
const garchStrict = () => ({ species: 445, level: 50, nature: 3, abilitySlot: 2, item: ITEM.Leftovers, moves: [MV.Earthquake, MV['Dragon Claw'], MV.Sandstorm, MV.Dig], points: { hp: 2, atk: 32, def: 0, spa: 0, spd: 0, spe: 32 } });
const baseFor = (rsid) => (rsid === STRICT ? garchStrict() : garch());
const codesOf = (v) => v.reasons.map((r) => r.code + '@' + r.path).sort();

// ---------------------------------------------------------------------------------------------
// independent oracles (test-local; deliberately not sharing code with rules.js)
// ---------------------------------------------------------------------------------------------
// Pre-evolution closure by fixpoint iteration (rules.js uses a work-queue): a species p precedes x when p lists x as an
// evolution target; a non-base form with no predecessor of its own borrows its base form's predecessors.
function oracleLineage(P, id) {
  const set = new Set([id]);
  const preds = (x) => { const r = []; P.species.forEach((s, i) => { if (s && s.evolutions.some((e) => e.target === x)) r.push(i); }); return r; };
  for (let changed = true; changed;) {
    changed = false;
    for (const x of [...set]) {
      let ps = preds(x);
      const sx = P.species[x];
      if (ps.length === 0 && sx && sx.forms.length > 0 && sx.forms[0] !== x) ps = preds(sx.forms[0]);
      for (const p of ps) if (!set.has(p)) { set.add(p); changed = true; }
    }
  }
  return [...set].sort((a, b) => a - b);
}
const oracleMemo = new WeakMap(); // pack -> Map('id:lineage' -> learnset); the oracle is pure, so memoising it cannot change a result
function oracleLearnset(P, id, lineage) {
  let memo = oracleMemo.get(P);
  if (!memo) oracleMemo.set(P, (memo = new Map()));
  const key = id + ':' + lineage;
  if (memo.has(key)) return memo.get(key);
  const machine = new Set(P.machines.map((m) => m.move));
  const out = {};
  const get = (m) => (out[m] = out[m] || { lu: null, mc: false, tu: false, eg: false });
  for (const x of lineage ? oracleLineage(P, id) : [id]) {
    const s = P.species[x];
    for (const [m, l] of s.levelUp) { const e = get(m); e.lu = e.lu === null ? l : Math.min(e.lu, l); }
    for (const m of s.teachable) { if (machine.has(m)) get(m).mc = true; else get(m).tu = true; }
    for (const m of s.eggMoves) get(m).eg = true;
  }
  memo.set(key, out);
  return out;
}
function oracleJudge(e, level, rs) {
  if (!e) return false;
  const src = rs.moves.sources;
  if (e.lu !== null && src.includes('levelUp') && (!rs.moves.levelGate || e.lu <= level)) return true;
  if (e.mc && src.includes('machine')) return true;
  if (e.tu && src.includes('tutor')) return true;
  if (e.eg && src.includes('egg')) return true;
  return false;
}
// The record validator, re-derived from the documented rules (codes + paths), returns sorted 'code@path' strings.
function oracleCodes(rec, P, rs) {
  const out = [];
  const isI = (x) => typeof x === 'number' && isFinite(x) && Math.floor(x) === x;
  const g = (o, k) => (typeof o === 'object' && o !== null && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
  const plain = (o) => typeof o === 'object' && o !== null && !Array.isArray(o);
  if (!plain(rec)) return ['rec.shape@'];
  const sid = g(rec, 'species');
  let sp = null, spOk = false;
  if (isI(sid) && sid >= 0 && sid < P.species.length) sp = P.species[sid];
  if (!sp) out.push('species.unknown@species');
  else if (!sp.legal) out.push('species.illegal@species');
  else if (rs.banned.species.includes(sid)) out.push('species.banned@species');
  else spOk = true;
  const lv = g(rec, 'level');
  const lvIn = isI(lv) && lv >= rs.level.min && lv <= rs.level.max;
  if (!lvIn) out.push('level.range@level');
  else if (rs.level.fixed !== null && lv !== rs.level.fixed) out.push('level.fixed@level');
  const n = g(rec, 'nature');
  if (!(isI(n) && n >= 0 && n < Math.min(rs.nature.count, P.natures.length))) out.push('nature.range@nature');
  const sl = g(rec, 'abilitySlot');
  if (!(isI(sl) && sl >= 0 && sl <= 2)) out.push('ability.slot-range@abilitySlot');
  else if (!rs.ability.slots.includes(sl)) out.push('ability.slot-disallowed@abilitySlot');
  else if (spOk) {
    const ab = sp.abilities[sl];
    if (ab === 0) out.push('ability.slot-empty@abilitySlot');
    else if (rs.banned.abilities.includes(ab)) out.push('ability.banned@abilitySlot');
  }
  const itRaw = g(rec, 'item');
  const it = itRaw === undefined ? 0 : itRaw;
  if (!(isI(it) && it >= 0 && it < P.items.length)) out.push('item.unknown@item');
  else if (it !== 0 && rs.banned.items.includes(it)) out.push('item.banned@item');
  const mv = g(rec, 'moves');
  if (!Array.isArray(mv)) out.push('moves.shape@moves');
  else {
    if (mv.length < rs.moves.min || mv.length > rs.moves.max) out.push('moves.count@moves');
    const learn = spOk ? oracleLearnset(P, sid, rs.moves.lineage) : null;
    const seen = new Set();
    for (let i = 0; i < Math.min(mv.length, 16); i++) {
      const m = mv[i], p = `moves[${i}]`;
      if (!(isI(m) && m >= 1 && m < P.moves.length)) { out.push('move.unknown@' + p); continue; }
      if (seen.has(m)) { if (!rs.moves.duplicates) out.push('move.duplicate@' + p); } else seen.add(m);
      if (rs.banned.moves.includes(m)) out.push('move.banned@' + p);
      if (spOk && lvIn && !oracleJudge(learn[m], lv, rs)) out.push('move.illegal@' + p);
    }
  }
  const ivb = g(rec, 'ivs');
  if (ivb === undefined && rs.iv.fixed !== null) { /* implied */ }
  else if (!plain(ivb)) out.push('iv.missing@ivs');
  else {
    for (const k of UI) {
      const v = g(ivb, k);
      if (v === undefined) out.push('iv.missing@ivs.' + k);
      else if (!isI(v) || v < rs.iv.min || v > rs.iv.max) out.push('iv.range@ivs.' + k);
      else if (rs.iv.fixed !== null && v !== rs.iv.fixed) out.push('iv.fixed@ivs.' + k);
    }
  }
  const evb = g(rec, 'evs');
  let evOk = null;
  if (evb === undefined && rs.points) { /* derived */ }
  else if (!plain(evb)) out.push('ev.missing@evs');
  else {
    evOk = {};
    let bad = false;
    for (const k of UI) {
      const v = g(evb, k);
      if (v === undefined) { out.push('ev.missing@evs.' + k); bad = true; }
      else if (!isI(v) || v < 0 || v > rs.ev.perStat) { out.push('ev.range@evs.' + k); bad = true; }
      else evOk[k] = v;
    }
    if (bad) evOk = null;
    else if (!rs.points && rs.ev.total !== null && UI.reduce((s, k) => s + evOk[k], 0) > rs.ev.total) out.push('ev.total@evs');
  }
  if (rs.points) {
    const pb = g(rec, 'points');
    if (!plain(pb)) out.push('points.missing@points');
    else {
      const pv = {};
      let bad = false;
      for (const k of UI) {
        const v = g(pb, k);
        if (v === undefined) { out.push('points.missing@points.' + k); bad = true; }
        else if (!isI(v) || v < 0 || v > rs.points.perStat) { out.push('points.range@points.' + k); bad = true; }
        else pv[k] = v;
      }
      if (!bad) {
        if (UI.reduce((s, k) => s + pv[k], 0) > rs.points.total) out.push('points.total@points');
        if (rs.ev.total !== null && UI.reduce((s, k) => s + (pv[k] === 0 ? 0 : 4 * (2 * pv[k] - (rs.iv.fixed & 1))), 0) > rs.ev.total) out.push('ev.total@points');
        if (evOk) for (const k of UI) { const want = pv[k] === 0 ? 0 : 4 * (2 * pv[k] - (rs.iv.fixed & 1)); if (evOk[k] !== want) out.push('points.ev-mismatch@evs.' + k); }
      }
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------------------------
// the record generator for the differential run
// ---------------------------------------------------------------------------------------------
const JUNK = [undefined, null, true, false, 'x', '5', '', [], {}, NaN, Infinity, -Infinity, 1.5, -1, -0, 0.5, 1e21, 2 ** 31, [1], { a: 1 }];
const HOT_SPECIES = [25, 445, 6, 132, 292, 947, 172, 1553];
// A near-valid record for the ruleset (so every rule is exercised from a base that passes the OTHER rules).
function genClean(rng, rs) {
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const sid = rng() < 0.3 ? pick(HOT_SPECIES) : pick(pack.roster);
  const sp = pack.species[sid];
  const level = rs.level.fixed !== null ? rs.level.fixed : pick([100, 100, 50, 75, 30, 1]);
  const slots = rs.ability.slots.filter((x) => sp.abilities[x] !== 0);
  const rec = {
    species: sid, level,
    nature: Math.floor(rng() * Math.min(rs.nature.count, 25)),
    abilitySlot: slots.length ? pick(slots) : 0,
    item: rng() < 0.6 ? 0 : 1 + Math.floor(rng() * 929),
    moves: [],
  };
  const learnO = oracleLearnset(pack, sid, rs.moves.lineage); // the generator uses the ORACLE's notion of legal, not the module under test
  const legal = Object.keys(learnO).map(Number).filter((m) => m >= 1 && m < pack.moves.length && !rs.banned.moves.includes(m) && oracleJudge(learnO[m], level, rs));
  const want = rs.moves.min + Math.floor(rng() * (rs.moves.max - rs.moves.min + 1));
  const pool = legal.slice();
  while (rec.moves.length < want && pool.length) { const i = Math.floor(rng() * pool.length); rec.moves.push(pool[i]); pool.splice(i, 1); }
  if (rec.moves.length === 0) rec.moves.push(1);
  if (rs.iv.fixed === null || rng() < 0.5) { rec.ivs = {}; for (const k of UI) rec.ivs[k] = rs.iv.fixed !== null ? rs.iv.fixed : rs.iv.min + Math.floor(rng() * (rs.iv.max - rs.iv.min + 1)); }
  if (rs.points) {
    rec.points = zero6();
    let budget = Math.floor(rng() * (rs.points.total + 1));
    for (const k of UI) { const v = Math.min(budget, Math.floor(rng() * (rs.points.perStat + 1))); rec.points[k] = v; budget -= v; }
    if (rng() < 0.5) { rec.evs = {}; for (const k of UI) rec.evs[k] = rec.points[k] === 0 ? 0 : 8 * rec.points[k] - 4; }
  } else {
    rec.evs = zero6();
    let budget = Math.floor(rng() * ((rs.ev.total === null ? 6 * rs.ev.perStat : rs.ev.total) + 1));
    for (const k of UI) { const v = Math.min(budget, Math.floor(rng() * (rs.ev.perStat + 1))); rec.evs[k] = v; budget -= v; }
  }
  return rec;
}
// Single perturbations of a clean record: each aims at one rule.
const PERTURB = [
  (r, p) => { r.level = p([0, 1, 49, 50, 51, 99, 100, 101, -1, 50.5, '50', null]); },
  (r, p) => { r.nature = p([-1, 0, 19, 20, 24, 25, 26, 0.5, '3', null]); },
  (r, p) => { r.abilitySlot = p([-1, 0, 1, 2, 3, 1.5, '0', null]); },
  (r, p) => { r.item = p([0, 472, 479, 929, 930, 931, -1, 0.5, '472', null]); },
  (r, p, rng) => { r.moves[Math.floor(rng() * r.moves.length)] = p([0, 1, 85, 89, 53, 935, 936, 5000, -1, 2.5, 'x', null]); },
  (r) => { if (r.moves.length) r.moves.push(r.moves[0]); },
  (r) => { r.moves.length = 0; },
  (r, p) => { while (r.moves.length < 5) r.moves.push(p([1, 2, 3, 4, 5, 6, 7])); },
  (r, p) => { if (r.ivs) r.ivs[p(UI)] = p([-1, 0, 4, 5, 20, 21, 30, 31, 32, 1.5, '31', null]); },
  (r, p) => { if (r.evs) r.evs[p(UI)] = p([-1, 0, 1, 100, 200, 201, 252, 255, 256, 1.5, '5', null]); },
  (r, p) => { if (r.evs) { r.evs[p(UI)] = 255; r.evs[p(UI)] = 255; r.evs[p(UI)] = p([0, 1, 2]); } },
  (r, p) => { if (r.points) r.points[p(UI)] = p([-1, 0, 1, 31, 32, 33, 1.5, '3', null]); },
  (r, p) => { if (r.points) { r.points.hp = 32; r.points.atk = 32; r.points.def = p([1, 2, 3]); } },
  (r, p) => { if (r.points && r.evs) r.evs[p(UI)] += p([1, -1, 4, 8]); },
  (r, p, rng) => { delete r[p(Object.keys(r))]; },
  (r, p) => { r[p(['ivs', 'evs', 'points', 'moves'])] = p(JUNK); },
  (r, p) => { const k = p(UI); const b = p(['ivs', 'evs', 'points']); if (r[b] && typeof r[b] === 'object') { if (rngBool(p)) delete r[b][k]; else r[b][k] = p(JUNK); } },
  (r, p) => { r.species = p([0, 1, 1578, 1579, -1, 3000, 25, 445, 947, 292, 132, 1.5]); },
];
const rngBool = (p) => p([true, false]);
function genRec(rng, rs) {
  const pick = (a) => a[Math.floor(rng() * a.length)];
  if (rng() < 0.02) return pick(JUNK);
  const rec = genClean(rng, rs);
  const n = rng() < 0.35 ? 0 : rng() < 0.7 ? 1 : 2 + Math.floor(rng() * 2); // 35% untouched, else 1..3 perturbations
  for (let i = 0; i < n; i++) {
    const f = pick(PERTURB);
    try { f(rec, pick, rng); } catch (_e) { /* a perturbation that does not apply to this (already damaged) record: skip it */ }
  }
  return rec;
}

// ---------------------------------------------------------------------------------------------
// THE SUITE: named checks over ANY module pair. add(id, cost, fn(ctx)) with fn -> true | failure string.
//   ctx = { S, R, sources: {stats, rules}, pack, ... }
// ---------------------------------------------------------------------------------------------
function defineSuite() {
  const checks = [];
  const add = (id, cost, fn) => checks.push({ id, cost, fn });
  const C = 'cheap', H = 'heavy';

  // ===================================== stats: golden vectors =====================================
  add('stats/golden/hp-ev0', C, ({ S }) => eqv(S.calcHp(100, 31, 0, 50), 175));
  add('stats/golden/other-ev0', C, ({ S }) => eqv(S.calcStat('atk', 100, 31, 0, 50), 120));
  add('stats/golden/hp-ev252', C, ({ S }) => eqv(S.calcHp(100, 31, 252, 50), 207));
  add('stats/golden/other-ev252', C, ({ S }) => eqv(S.calcStat('atk', 100, 31, 252, 50), 152));
  add('stats/golden/nature-plus', C, ({ S }) => eqv(S.calcStat('atk', 100, 31, 252, 50, 1), 167));
  add('stats/golden/nature-minus', C, ({ S }) => eqv(S.calcStat('atk', 100, 31, 252, 50, -1), 136));
  add('stats/golden/extremes', C, ({ S }) => eqv([S.calcHp(255, 31, 255, 100), S.calcStat('def', 255, 31, 255, 100), S.calcStat('def', 255, 31, 255, 100, 1), S.calcStat('def', 255, 31, 255, 100, -1)], [714, 609, 669, 548]));
  add('stats/golden/low-level', C, ({ S }) => eqv([S.calcHp(100, 31, 0, 5), S.calcStat('spe', 100, 31, 0, 5)], [26, 16]));
  add('stats/golden/known-main-series-values', C, ({ S }) => eqv([S.calcHp(108, 31, 252, 100), S.calcStat('atk', 130, 31, 252, 100, 1), S.calcStat('spe', 102, 31, 252, 100, 1)], [420, 394, 333]));
  add('stats/nature/floors-not-rounds', C, ({ S }) => eqv([S.applyNature(5, 1), S.applyNature(15, -1), S.applyNature(19, 1), S.applyNature(7, 0)], [5, 13, 20, 7]));
  add('stats/nature/minus-collision', C, ({ S }) => eqv([S.applyNature(10, -1), S.applyNature(11, -1), S.applyNature(12, -1)], [9, 9, 10]));
  add('stats/nature/hp-ignores-nature', C, ({ S }) => eqv([S.calcStat('hp', 100, 31, 0, 50, 1), S.calcStat('hp', 100, 31, 0, 50, -1)], [175, 175]));
  add('stats/vs-bigint-oracle', C, ({ S }) => {
    let n = 0;
    for (const b of [0, 1, 2, 5, 10, 45, 50, 77, 100, 128, 200, 254, 255]) for (const iv of [0, 1, 15, 30, 31]) for (const ev of [0, 1, 3, 4, 7, 8, 100, 251, 252, 255]) for (const lv of [1, 5, 20, 50, 77, 100]) {
      if (S.calcHp(b, iv, ev, lv) !== bigStat('hp', b, iv, ev, lv, 0)) return `hp mismatch at ${[b, iv, ev, lv]}`;
      for (const mod of [-1, 0, 1]) { n++; if (S.calcStat('spd', b, iv, ev, lv, mod) !== bigStat('x', b, iv, ev, lv, mod)) return `stat mismatch at ${[b, iv, ev, lv, mod]}`; }
    }
    return n > 4000 ? true : 'grid too small';
  });
  add('stats/input-validation', C, ({ S }) => all([
    () => throwsKind(() => S.calcHp(100, 31, -1, 50), RangeError), () => throwsKind(() => S.calcHp(100, 31, 1.5, 50), RangeError),
    () => throwsKind(() => S.calcHp(100, 31, 0, 0), RangeError), () => throwsKind(() => S.calcHp(100, 31, 0, 101), RangeError),
    () => throwsKind(() => S.calcHp('100', 31, 0, 50), RangeError), () => throwsKind(() => S.calcStat('xx', 1, 1, 1, 50), RangeError),
    () => throwsKind(() => S.calcHp(NaN, 31, 0, 50), RangeError),
    () => eqv(S.calcHp(1, 0, 0, 1), 11), () => eqv(S.calcHp(1, 0, 0, 100), 112), () => eqv(S.calcHp(0, 0, 0, 1), 11),
  ], (f) => f()));

  // ===================================== stats: natures =====================================
  add('stats/natures/builtin-chart', C, ({ S }) => all(NATURE_CHART.map((n, i) => [n, i]), ([n, i]) => {
    const b = S.builtinNature(i);
    if (n[1] === null) return b.up === b.down ? true : `nature ${i} ${n[0]} should be neutral, got ${b.up}/${b.down}`;
    return b.up === n[1] && b.down === n[2] ? true : `nature ${i} ${n[0]}: got ${b.up}/${b.down}, chart ${n[1]}/${n[2]}`;
  }));
  add('stats/natures/rom-table-matches-chart', C, ({ S, pack: P }) => all(NATURE_CHART.map((n, i) => [n, i]), ([n, i]) => {
    const e = P.natures[i];
    if (e.name !== n[0]) return `ROM nature ${i} is named ${e.name}, chart says ${n[0]}`;
    if (n[1] === null) return e.up === e.down ? true : `${n[0]} should be neutral`;
    return e.up === n[1] && e.down === n[2] ? true : `${n[0]}: ROM ${e.up}/${e.down} chart ${n[1]}/${n[2]}`;
  }));
  add('stats/natures/mismatch-detector', C, ({ S, pack: P }) => {
    const ok = eqv(S.natureMismatches(P.natures), []);
    if (ok !== true) return 'real table flagged: ' + ok;
    const bad = clone(P.natures); bad[3].down = 'spd';
    const bad2 = clone(P.natures); bad2.pop();
    return eqv([S.natureMismatches(bad), S.natureMismatches(bad2).includes(-1)], [[3], true]);
  });
  add('stats/natures/mod-matrix', C, ({ S, pack: P }) => all(NATURE_CHART.map((n, i) => [n, i]), ([n, i]) => {
    for (const viaTable of [false, true]) {
      const r = S.resolveNature(i, viaTable ? P.natures : undefined);
      for (const k of UI) {
        const want = k === 'hp' || n[1] === null ? 0 : k === n[1] ? 1 : k === n[2] ? -1 : 0;
        if (S.natureMod(r, k) !== want) return `${n[0]} ${k} via ${viaTable ? 'ROM table' : 'builtin'}: got ${S.natureMod(r, k)} want ${want}`;
      }
    }
    return true;
  }));
  add('stats/natures/id-guards', C, ({ S }) => all([() => throwsKind(() => S.builtinNature(-1), RangeError), () => throwsKind(() => S.builtinNature(25), RangeError),
    () => throwsKind(() => S.resolveNature({ up: 'hp', down: 'atk' }), RangeError), () => throwsKind(() => S.resolveNature(99, []), RangeError)], (f) => f()));

  // ===================================== stats: whole-mon, Shedinja =====================================
  add('stats/computeStats/garchomp-from-pack', C, ({ S, pack: P }) => {
    const sp = P.species[445];
    if (!sp || sp.name !== 'Garchomp') return 'species 445 is not Garchomp';
    const got = S.computeStats(sp.baseStats, ivs31(), { hp: 252, atk: 252, def: 0, spa: 0, spd: 0, spe: 6 }, 100, 3, P.natures);
    return eqv(got, { hp: 420, atk: 394, def: 226, spa: 176, spd: 206, spe: 241 });
  });
  add('stats/computeStats/matches-bigint-for-every-species', C, ({ S, pack: P }) => {
    const evs = { hp: 100, atk: 5, def: 252, spa: 0, spd: 31, spe: 255 }, ivs = { hp: 7, atk: 31, def: 0, spa: 15, spd: 30, spe: 1 };
    for (const id of P.roster) {
      const sp = P.species[id];
      for (const [nat, lv] of [[3, 50], [10, 100], [0, 5]]) {
        const got = S.computeStats(sp.baseStats, ivs, evs, lv, nat, P.natures);
        const ch = NATURE_CHART[nat];
        for (const k of UI) {
          const mod = k === 'hp' || ch[1] === null ? 0 : k === ch[1] ? 1 : k === ch[2] ? -1 : 0;
          const want = k === 'hp' ? (sp.baseStats.hp === 1 ? 1 : bigStat('hp', sp.baseStats.hp, ivs.hp, evs.hp, lv, 0)) : bigStat('x', sp.baseStats[k], ivs[k], evs[k], lv, mod);
          if (got[k] !== want) return `species ${id} ${sp.name} ${k} nature ${nat} lv ${lv}: got ${got[k]} want ${want}`;
        }
      }
    }
    return true;
  });
  add('stats/shedinja/hp-is-one', C, ({ S, pack: P }) => {
    const sh = P.species[292];
    if (!sh || sh.name !== 'Shedinja' || sh.baseStats.hp !== 1) return 'species 292 is not a base-HP-1 Shedinja';
    for (const lv of [1, 50, 100]) for (const ev of [0, 252]) if (S.computeStats(sh.baseStats, ivs31(), { ...zero6(), hp: ev }, lv, 0, P.natures).hp !== 1) return `Shedinja HP is not 1 at lv ${lv} ev ${ev}`;
    const off = S.computeStats(sh.baseStats, ivs31(), zero6(), 50, 0, P.natures, { fixedHp1: false }).hp;
    return off === bigStat('hp', 1, 31, 0, 50, 0) ? true : `fixedHp1:false gave ${off}`;
  });
  add('stats/shedinja/only-base-hp-1-species', C, ({ pack: P }) => eqv(P.roster.filter((i) => P.species[i].baseStats.hp === 1), [292]));

  // ===================================== stats: Hidden Power =====================================
  add('stats/hidden-power/golden', C, ({ S }) => {
    const all31 = ivs31(), all0 = zero6();
    const a = S.hiddenPower(all31), b = S.hiddenPower(all0);
    return eqv([a.type, a.power, a.typeId, b.type, b.power, b.typeId], ['Dark', 70, 18, 'Fighting', 30, 2]);
  });
  add('stats/hidden-power/type-bit-order-is-rom-order', C, ({ S }) => {
    // low IV bit of exactly one stat; ROM order HP,Atk,Def,Spe,SpA,SpD => type words 1,2,4,8,16,32 => floor(w*15/63)
    // w=1 ->0, 2 ->0, 4 ->0 (60/63), 8 -> 1 (120/63=1.9), 16 -> 3 (240/63=3.8), 32 -> 7 (480/63=7.6)
    const want = { hp: 'Fighting', atk: 'Fighting', def: 'Fighting', spe: 'Flying', spa: 'Ground', spd: 'Steel' };
    return all(ROM_ORDER, (k) => { const ivs = zero6(); ivs[k] = 1; const h = S.hiddenPower(ivs); return h.type === want[k] ? true : `only ${k} odd: got ${h.type} want ${want[k]}`; });
  });
  add('stats/hidden-power/power-bit-order-and-formula', C, ({ S }) => {
    // only stat k has its SECOND IV bit set => power word = 1 << (index of k in ROM order)
    return all(ROM_ORDER.map((k, i) => [k, i]), ([k, i]) => {
      const ivs = zero6(); ivs[k] = 2;
      const h = S.hiddenPower(ivs), want = 30 + Math.floor(((1 << i) * 40) / 63);
      return h.power === want && h.powerBits === 1 << i && h.typeBits === 0 ? true : `only ${k} has bit1: got power ${h.power} bits ${h.powerBits}, want ${want} / ${1 << i}`;
    });
  });
  add('stats/hidden-power/all-64-type-words', C, ({ S }) => {
    for (let w = 0; w < 64; w++) {
      const ivs = {}; ROM_ORDER.forEach((k, i) => { ivs[k] = 28 + ((w >> i) & 1); }); // 28 or 29: low bit = the word bit, second bit 0
      const h = S.hiddenPower(ivs);
      if (h.typeIndex !== Math.floor((w * 15) / 63) || h.typeBits !== w) return `word ${w}: got index ${h.typeIndex} bits ${h.typeBits}`;
    }
    return true;
  });
  add('stats/hidden-power/types-match-rom-names', C, ({ S, pack: P }) => {
    const ids = S.HIDDEN_POWER_TYPES.map((x) => x.id);
    for (const x of S.HIDDEN_POWER_TYPES) if (P.types[x.id].name !== x.name) return `type ${x.id}: ROM says ${P.types[x.id].name}, module says ${x.name}`;
    const excluded = P.types.map((x) => x.id).filter((i) => !ids.includes(i));
    return eqv([ids.length, excluded, P.types.map((x) => x.name).filter((_, i) => excluded.includes(i))], [16, [0, 1, 10, 19, 20], ['None', 'Normal', '???', 'Fairy', 'Stellar']]);
  });
  add('stats/hidden-power/ivs-round-trip', C, ({ S }) => all(S.HIDDEN_POWER_TYPES, (ty) => {
    const ivs = S.hiddenPowerIvs(ty.name), h = S.hiddenPower(ivs), byIndex = S.hiddenPowerIvs(ty.index);
    if (h.type !== ty.name || h.power !== 70) return `${ty.name}: round trip gave ${h.type} power ${h.power}`;
    if (!ROM_ORDER.every((k) => ivs[k] === 30 || ivs[k] === 31)) return `${ty.name}: IVs not 30/31`;
    return J(ivs) === J(byIndex) ? true : `${ty.name}: by name and by index differ`;
  }));
  add('stats/hidden-power/ivs-pins', C, ({ S }) => eqv([S.hiddenPowerIvs('Dark'), S.hiddenPowerIvs('Fighting')], [{ hp: 31, atk: 31, def: 31, spe: 31, spa: 31, spd: 31 }, { hp: 31, atk: 31, def: 30, spe: 30, spa: 30, spd: 30 }]));
  add('stats/hidden-power/ivs-guards', C, ({ S }) => all([() => throwsKind(() => S.hiddenPowerIvs('Normal'), RangeError), () => throwsKind(() => S.hiddenPowerIvs(16), RangeError),
    () => throwsKind(() => S.hiddenPower({ hp: 1 }), RangeError)], (f) => f()));
  add('stats/hidden-power/rom-move-fact-and-fixed-power-option', C, ({ S, pack: P }) => {
    const m = P.moves[237];
    if (!m || m.name !== 'Hidden Power') return 'move 237 is not Hidden Power';
    // ROM FACT recorded by this test: the move table lists Hidden Power as Normal / Special / 60, i.e. a FIXED power. The
    // Gen 3 30..70 formula is therefore unverified for the hack; fixedPower lets a caller pick the table value.
    if (m.type !== 1 || m.category !== 1 || m.power !== 60) return `ROM Hidden Power is type ${m.type} cat ${m.category} power ${m.power}`;
    return S.hiddenPower(ivs31(), { fixedPower: m.power }).power === 60 ? true : 'fixedPower option ignored';
  });

  // ===================================== stats: points view =====================================
  add('stats/points/identity-8415-cells', C, ({ S }) => {
    let bad = 0, first = '';
    for (let b = 1; b <= 255; b++) for (let p = 0; p <= 32; p++) {
      const ev = S.pointsToEv(p);
      if (S.calcHp(b, 31, ev, 50) !== b + p + 75) { bad++; first = first || `hp b${b} p${p}`; }
      if (S.calcStat('atk', b, 31, ev, 50) !== b + p + 20) { bad++; first = first || `atk b${b} p${p}`; }
    }
    return bad === 0 ? true : `${bad} mismatches, first ${first}`;
  });
  add('stats/points/identity-also-holds-for-min252-8p', C, ({ S }) => {
    for (let b = 1; b <= 255; b++) for (let p = 0; p <= 32; p++) {
      const ev = Math.min(252, 8 * p);
      if (S.calcHp(b, 31, ev, 50) !== b + p + 75 || S.calcStat('def', b, 31, ev, 50) !== b + p + 20) return `b${b} p${p}`;
    }
    return true;
  });
  add('stats/points/official-conversion-pins', C, ({ S }) => {
    const got = [0, 1, 2, 3, 31, 32].map((p) => S.pointsToEv(p));
    const e = eqv(got, [0, 4, 12, 20, 244, 252]);
    if (e !== true) return e;
    return eqv(S.pointsToEv(32) + S.pointsToEv(32) + S.pointsToEv(2), 516);
  });
  add('stats/points/min-ev-is-minimal-and-round-trips', C, ({ S }) => all(Array.from({ length: 33 }, (_, p) => p), (p) => {
    const ev = S.pointsToEv(p);
    if (S.evToPoints(ev) !== p) return `evToPoints(pointsToEv(${p})) = ${S.evToPoints(ev)}`;
    if (p > 0 && S.evToPoints(ev - 1) !== p - 1) return `${ev - 1} EV already buys ${p} points, so ${ev} is not minimal`;
    return true;
  }));
  add('stats/points/evToPoints-is-the-brute-force-stat-gain', C, ({ S }) => {
    for (const b of [1, 37, 100, 255]) for (let iv = 0; iv <= 31; iv++) for (let ev = 0; ev <= 255; ev++) {
      const gOther = bigStat('x', b, iv, ev, 50, 0) - bigStat('x', b, iv, 0, 50, 0);
      const gHp = bigStat('hp', b, iv, ev, 50, 0) - bigStat('hp', b, iv, 0, 50, 0);
      const p = S.evToPoints(ev, iv);
      if (gOther !== p || gHp !== p) return `b${b} iv${iv} ev${ev}: points ${p}, stat gain other ${gOther} hp ${gHp}`;
    }
    return true;
  });
  add('stats/points/even-iv-costs-eight', C, ({ S }) => eqv([S.pointsToEv(1, 30), S.pointsToEv(31, 30), S.maxPoints(30), S.maxPoints(31), S.maxPoints()], [8, 248, 31, 32, 32]));
  add('stats/points/range-guard', C, ({ S }) => all([() => throwsKind(() => S.pointsToEv(33), RangeError), () => throwsKind(() => S.pointsToEv(32, 30), RangeError),
    () => throwsKind(() => S.pointsToEv(-1), RangeError), () => throwsKind(() => S.evToPoints(-1), RangeError)], (f) => f()));
  add('stats/points/keyed-converters-and-view', C, ({ S }) => {
    const pts = { hp: 2, atk: 32, def: 0, spa: 0, spd: 0, spe: 32 };
    const evs = S.pointsToEvs(pts);
    const a = eqv(evs, { hp: 12, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 });
    if (a !== true) return a;
    if (J(S.evsToPoints(evs)) !== J(pts)) return 'evsToPoints does not invert pointsToEvs';
    const view = S.pointsView({ hp: 255, atk: 250, def: 7, spa: 0, spd: 1, spe: 252 });
    // 255 EV -> 32 points, 250 -> 31 (floor(62+1)/2), 7 -> 1, 1 EV -> 0 points (floor(0+1)/2), 252 -> 32
    return eqv([view.points, view.minEvs, view.pointsUsed, view.evUsed, view.evUsedMin], [{ hp: 32, atk: 31, def: 1, spa: 0, spd: 0, spe: 32 }, { hp: 252, atk: 244, def: 4, spa: 0, spd: 0, spe: 252 }, 96, 765, 752]);
  });
  add('stats/points/budgets-and-remaining', C, ({ S }) => {
    const ok66 = S.pointsBudget({ hp: 32, atk: 32, def: 2, spa: 0, spd: 0, spe: 0 }), over = S.pointsBudget({ hp: 32, atk: 32, def: 3, spa: 0, spd: 0, spe: 0 });
    const ev = S.evBudget({ hp: 252, atk: 252, def: 6, spa: 0, spd: 0, spe: 0 }), evOver = S.evBudget({ hp: 252, atk: 252, def: 7, spa: 0, spd: 0, spe: 0 });
    return eqv([ok66.used, ok66.remaining, ok66.over, over.remaining, over.over, ev.remaining, ev.over, evOver.remaining, evOver.over, S.remaining(66, 10), S.sumStats({ hp: 1, atk: 2, def: 3, spa: 4, spd: 5, spe: 6 })], [66, 0, false, -1, true, 0, false, -1, true, 56, 21]);
  });
  add('stats/snap/vs-brute-force', C, ({ S }) => {
    for (const kind of ['hp', 'atk']) for (const b of [1, 45, 100, 255]) for (const iv of [0, 31]) for (const lv of [5, 50, 100]) for (const mod of kind === 'hp' ? [0] : [-1, 0, 1]) {
      for (const ev of [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 100, 248, 250, 251, 252, 253, 255]) {
        const got = S.snapEvToMinimum(ev, { stat: kind, base: b, iv, level: lv, mod });
        const want = bruteSnap(kind === 'hp' ? 'hp' : 'x', b, iv, ev, lv, mod);
        if (got !== want) return `${kind} base${b} iv${iv} lv${lv} mod${mod} ev${ev}: got ${got} want ${want}`;
      }
    }
    return true;
  });
  add('stats/snap/pins', C, ({ S }) => {
    const c = { stat: 'atk', base: 100, iv: 31, level: 50, mod: 0 };
    return eqv([0, 3, 4, 7, 8, 11, 12, 250, 251, 252, 255].map((ev) => S.snapEvToMinimum(ev, c)), [0, 0, 4, 4, 4, 4, 12, 244, 244, 252, 252]);
  });
  add('stats/snap/uses-the-final-stat-not-the-raw-one', C, ({ S }) => {
    // with a lowering nature two adjacent raw stats can collapse to one final stat, so the minimum EV is LOWER than the neutral minimum
    let found = null;
    for (let b = 1; b <= 255 && !found; b++) for (let ev = 4; ev <= 252; ev += 4) {
      const neutral = S.snapEvToMinimum(ev, { stat: 'atk', base: b, iv: 31, level: 50, mod: 0 });
      const minus = S.snapEvToMinimum(ev, { stat: 'atk', base: b, iv: 31, level: 50, mod: -1 });
      if (minus < neutral) { found = [b, ev, neutral, minus]; break; }
    }
    if (!found) return 'no case where a -nature lets the EV snap lower than neutral (the final-stat semantic is untested)';
    const [b, ev, neutral, minus] = found;
    return minus === bruteSnap('x', b, 31, ev, 50, -1) && neutral === bruteSnap('x', b, 31, ev, 50, 0) ? true : `case ${found} disagrees with brute force`;
  });
  add('stats/snap/all-six', C, ({ S, pack: P }) => {
    const sp = P.species[445];
    const r = S.snapEvsToMinimum(sp.baseStats, ivs31(), { hp: 255, atk: 250, def: 7, spa: 0, spd: 1, spe: 252 }, 50, 3, P.natures);
    const want = {};
    let saved = 0;
    const evIn = { hp: 255, atk: 250, def: 7, spa: 0, spd: 1, spe: 252 };
    for (const k of UI) { const ch = NATURE_CHART[3]; const mod = k === 'hp' ? 0 : k === ch[1] ? 1 : k === ch[2] ? -1 : 0; want[k] = bruteSnap(k === 'hp' ? 'hp' : 'x', sp.baseStats[k], 31, evIn[k], 50, mod); saved += evIn[k] - want[k]; }
    return eqv(r, { evs: want, saved });
  });

  // ===================================== stats: constants, canonical JSON =====================================
  add('stats/constants/orders-match-tables-js', C, ({ S }) => eqv([[...S.ROM_STAT_ORDER], [...S.STAT_ORDER].sort(), [...S.NATURE_STATS], S.LIMITS.evTotalMax, S.LIMITS.ivMax, S.POINTS.total, S.POINTS.perStat, S.POINTS.level],
    [[...STAT_KEYS], [...UI].sort(), ['atk', 'def', 'spe', 'spa', 'spd'], 510, 31, 66, 32, 50]));
  add('stats/canonical/json', C, ({ S }) => all([
    () => eqv(S.canonicalJSON({ b: 1, a: [2, { d: 1, c: 2 }], z: null }), '{"a":[2,{"c":2,"d":1}],"b":1,"z":null}'),
    () => eqv(S.canonicalJSON({ a: 1, b: 2 }), S.canonicalJSON({ b: 2, a: 1 })), () => eqv(S.canonicalJSON(-0), '0'), () => eqv(S.canonicalJSON([3, 1, 2]), '[3,1,2]'),
    () => throwsKind(() => S.canonicalJSON(NaN), TypeError), () => throwsKind(() => S.canonicalJSON(undefined), TypeError), () => throwsKind(() => S.canonicalJSON(() => 1), TypeError),
  ], (f) => f()));
  add('stats/canonical/fnv1a32-known-vectors', C, ({ S }) => eqv(['', 'a', 'foobar'].map((s) => S.fnv1a32(s)), ['811c9dc5', 'e40c292c', 'bf9cf968']));

  // ===================================== rules: rulesets =====================================
  add('rules/ruleset/standard-pins', C, ({ R }) => {
    const r = R.resolveRuleset(STD);
    return eqv(r, {
      id: STD, version: 1, team: { min: 1, max: 6, speciesClause: true, itemClause: false },
      level: { min: 1, max: 100, fixed: null, battle: 50 }, ev: { perStat: 255, total: 510 }, iv: { min: 0, max: 31, fixed: null }, points: null,
      nature: { count: 25 }, ability: { slots: [0, 1, 2] },
      moves: { min: 1, max: 4, duplicates: false, sources: ['levelUp', 'machine', 'tutor', 'egg'], lineage: true, levelGate: true },
      banned: { species: [], items: [], moves: [], abilities: [] },
      engine: { enforce: true }, // stage E1: the battle-engine support layer is part of the default ruleset
    });
  });
  add('rules/ruleset/layer-pins', C, ({ R }) => {
    const s = R.resolveRuleset(STRICT), l5 = R.resolveRuleset(STD + '+lv5'), l100 = R.resolveRuleset(STD + '+lv100'), ic = R.resolveRuleset(STD + '+item-clause'), ns = R.resolveRuleset(STD + '+no-species-clause');
    return eqv([s.level, s.iv, s.points, s.ev, l5.level.battle, l100.level.battle, ic.team.itemClause, ic.team.speciesClause, ns.team.speciesClause, ns.team.itemClause, s.id],
      [{ min: 1, max: 100, fixed: 50, battle: 50 }, { min: 0, max: 31, fixed: 31 }, { perStat: 32, total: 66 }, { perStat: 255, total: null }, 5, 100, true, true, false, false, STRICT]);
  });
  add('rules/ruleset/ids-canonical-and-errors', C, ({ R }) => all([
    () => eqv(R.resolveRuleset(STD + '+item-clause+lv5').id, STD + '+lv5+item-clause'),
    () => (R.resolveRuleset(STD + '+item-clause+lv5') === R.resolveRuleset(STD + '+lv5+item-clause') ? true : 'layer order changes the object'),
    () => throwsKind(() => R.resolveRuleset(STD + '+strict-champions+lv5'), RangeError), () => throwsKind(() => R.resolveRuleset(STD + '+lv5+lv100'), RangeError),
    () => throwsKind(() => R.resolveRuleset(STD + '+nope'), RangeError), () => throwsKind(() => R.resolveRuleset('nope'), RangeError), () => throwsKind(() => R.resolveRuleset(STD + '+lv5+lv5'), RangeError),
    () => throwsKind(() => R.resolveRuleset('__proto__'), RangeError), () => throwsKind(() => R.resolveRuleset('constructor'), RangeError), () => throwsKind(() => R.resolveRuleset(STD + '+constructor'), RangeError),
    () => throwsKind(() => R.resolveRuleset(5), TypeError), () => throwsKind(() => R.resolveRuleset(''), RangeError),
  ], (f) => f()));
  add('rules/ruleset/frozen-and-memoised', C, ({ R }) => {
    const r = R.resolveRuleset(STRICT);
    if (r !== R.resolveRuleset(STRICT)) return 'two resolves returned different objects';
    if (!Object.isFrozen(r) || !Object.isFrozen(r.moves.sources) || !Object.isFrozen(r.banned.species) || !Object.isFrozen(r.points)) return 'not deeply frozen';
    return throwsKind(() => { r.ev.total = 999; }, TypeError);
  });
  add('rules/ruleset/malformed-is-refused', C, ({ R }) => {
    const base = clone(R.resolveRuleset(STD));
    const cases = {
      'team.max 7': (r) => { r.team.max = 7; }, 'team.min>max': (r) => { r.team.min = 6; r.team.max = 2; }, 'level.fixed outside': (r) => { r.level.fixed = 200; },
      'ev.perStat 256': (r) => { r.ev.perStat = 256; }, 'iv.max 32': (r) => { r.iv.max = 32; }, 'points without fixed iv': (r) => { r.points = { perStat: 32, total: 66 }; },
      'nature.count 26': (r) => { r.nature.count = 26; }, 'slots unsorted': (r) => { r.ability.slots = [2, 0]; }, 'slots empty': (r) => { r.ability.slots = []; }, 'slot 3': (r) => { r.ability.slots = [0, 3]; },
      'moves.max 5': (r) => { r.moves.max = 5; }, 'bad source': (r) => { r.moves.sources = ['levelUp', 'tm']; }, 'lineage not bool': (r) => { r.moves.lineage = 1; },
      'banned unsorted': (r) => { r.banned.items = [5, 3]; }, 'banned missing': (r) => { delete r.banned.abilities; }, 'wrong version': (r) => { r.version = 2; }, 'id empty': (r) => { r.id = ''; },
    };
    if (R.checkRuleset(base).length !== 0) return 'the real ruleset is flagged: ' + R.checkRuleset(base);
    for (const [label, mut] of Object.entries(cases)) {
      const r = clone(base); mut(r);
      if (R.checkRuleset(r).length === 0) return `"${label}" was not flagged`;
      const e = throwsKind(() => R.validateMon(garch(), pack, r), TypeError);
      if (e !== true) return `"${label}": validateMon ${e}`;
    }
    return all([() => throwsKind(() => R.validateTeam([], pack, null), TypeError), () => (R.checkRuleset('x').length ? true : 'string ruleset object not flagged')], (f) => f());
  });
  add('rules/ruleset/fingerprints-pinned', C, ({ R }) => {
    // A tripwire: any edit to a preset's CONTENT changes its fingerprint and must update this table on purpose (and bump the rules version).
    // NOTE (stage E1): every pin changed on purpose when the ruleset gained `engine: { enforce: true }`; the pre-E1 values were d04bd254 / 762cdfc8 / 9340035e / 83f71b26 / f8362ac1 / ad1f6b7a.
    const pins = { [STD]: '595011f0', [STRICT]: '7104f9a4', [STD + '+lv5']: 'e19a1ada', [STD + '+lv100']: 'bcf37572', [STD + '+item-clause']: '41bacead', [STD + '+no-species-clause']: 'cb9f8f56' };
    const got = Object.fromEntries(Object.keys(pins).map((id) => [id, R.rulesetFingerprint(id).fnv32]));
    const stable = R.rulesetFingerprint(STD).canonical === R.rulesetFingerprint(clone(R.resolveRuleset(STD))).canonical;
    if (!stable) return 'fingerprint depends on object identity';
    if (new Set(Object.values(got)).size !== Object.keys(pins).length) return 'two presets share a fingerprint: ' + J(got);
    return eqv(got, pins);
  });

  // ===================================== rules: lineage and legality =====================================
  add('rules/legal/known-legal-and-illegal-moves', C, ({ R, pack: P }) => {
    const rows = [
      [25, 'Pikachu', [MV['Thunder Wave'], MV.Surf], [MV['Hydro Pump'], MV.Earthquake]],
      [6, 'Charizard', [MV.Flamethrower, MV['Dragon Dance']], [MV['Hydro Pump'], MV.Thunderbolt]],
      [445, 'Garchomp', [MV.Earthquake, MV['Dragon Claw']], [MV.Thunderbolt, MV['Hydro Pump']]],
      [132, 'Ditto', [MV.Transform], [MV['Hydro Pump'], MV.Tackle]],
    ];
    return all(rows, ([id, name, legal, illegal]) => {
      if (P.species[id].name !== name) return `species ${id} is ${P.species[id].name}, expected ${name}`;
      for (const m of legal) if (!R.moveLegality(P, id, 100, m, STD).legal) return `${name} should be able to know ${P.moves[m].name}`;
      for (const m of illegal) { const v = R.moveLegality(P, id, 100, m, STD); if (v.legal || v.reason !== 'not-learnable') return `${name} must not know ${P.moves[m].name} (${J(v)})`; }
      return true;
    });
  });
  add('rules/legal/ditto-only-transform', C, ({ R, pack: P }) => eqv(R.legalMoves(P, 132, 100, STD), [MV.Transform]));
  add('rules/legal/level-gate-boundary', C, ({ R, pack: P }) => {
    const tdn = MV['Take Down'];
    const e = R.learnsetOf(P, 445, true)[tdn];
    if (!e || e.levelUp !== 54 || e.machine || e.tutor || e.egg) return 'fixture drifted: Take Down on Garchomp lineage is not level-up-54-only: ' + J(e);
    const at53 = R.moveLegality(P, 445, 53, tdn, STD), at54 = R.moveLegality(P, 445, 54, tdn, STD);
    const noGate = R.moveLegality(P, 445, 1, tdn, { ...clone(R.resolveRuleset(STD)), moves: { ...clone(R.resolveRuleset(STD)).moves, levelGate: false } });
    return eqv([at53.legal, at53.reason, at53.needLevel, at54.legal, at54.sources, noGate.legal], [false, 'level-too-low', 54, true, ['levelUp'], true]);
  });
  add('rules/legal/lineage-brings-egg-and-prevo-moves', C, ({ R, pack: P }) => {
    const noLine = { ...clone(R.resolveRuleset(STD)) }; noLine.moves = { ...noLine.moves, lineage: false };
    const bd = R.moveLegality(P, 6, 100, MV['Belly Drum'], STD), bdOwn = R.moveLegality(P, 6, 100, MV['Belly Drum'], noLine);
    const fo = R.moveLegality(P, 25, 100, MV['Fake Out'], STD), foOwn = R.moveLegality(P, 25, 100, MV['Fake Out'], noLine);
    return eqv([bd.legal, bd.sources, bdOwn.legal, bdOwn.reason, fo.legal, foOwn.legal, R.learnsetOf(P, 25, true)[MV['Fake Out']].from, R.learnsetOf(P, 6, true)[MV['Belly Drum']].from],
      [true, ['egg'], false, 'not-learnable', true, false, [172], [4]]);
  });
  add('rules/legal/source-toggles', C, ({ R, pack: P }) => {
    const mk = (sources) => { const r = clone(R.resolveRuleset(STD)); r.moves.sources = sources; return r; };
    const noMachine = mk(['levelUp', 'tutor', 'egg']), noTutor = mk(['levelUp', 'machine', 'egg']), noTutorEgg = mk(['levelUp', 'machine']), none = mk([]);
    const surf = R.moveLegality(P, 25, 100, MV.Surf, noMachine);
    const dd1 = R.moveLegality(P, 6, 100, MV['Dragon Dance'], noTutor), dd2 = R.moveLegality(P, 6, 100, MV['Dragon Dance'], noTutorEgg);
    // Thunder Wave on Pikachu is BOTH a level-up move (level 4) and a TM
    const onlyLevelUp = mk(['levelUp']), onlyMachine = mk(['machine']);
    const twLv = R.moveLegality(P, 25, 100, MV['Thunder Wave'], onlyLevelUp), twLow = R.moveLegality(P, 25, 3, MV['Thunder Wave'], onlyLevelUp);
    const twMachineLow = R.moveLegality(P, 25, 1, MV['Thunder Wave'], onlyMachine), twNeither = R.moveLegality(P, 25, 100, MV['Thunder Wave'], mk(['tutor', 'egg']));
    const nothing = R.moveLegality(P, 6, 100, MV.Flamethrower, none);
    return eqv([surf.legal, surf.reason, dd1.legal, dd1.sources, dd2.legal, dd2.reason, twLv.sources, twLow.reason, twLow.needLevel, twMachineLow.sources, twNeither.reason, nothing.legal, nothing.reason],
      [false, 'source-disabled', true, ['egg'], false, 'source-disabled', ['levelUp'], 'level-too-low', 4, ['machine'], 'source-disabled', false, 'source-disabled']);
  });
  add('rules/legal/lineage-pins', C, ({ R, pack: P }) => eqv([R.lineageOf(P, 445), R.lineageOf(P, 25), R.lineageOf(P, 6), R.lineageOf(P, 132), R.lineageOf(P, 172)], [[443, 444, 445], [25, 172], [4, 5, 6], [132], [172]]));
  add('rules/legal/forms-borrow-their-base-form-lineage', C, ({ R, pack: P }) => {
    // 1553 (a Raichu form) has no incoming evolution edge of its own; its base form 26 does. 907 (a Charizard form) likewise.
    const a = R.lineageOf(P, 1553), b = R.lineageOf(P, 907);
    return eqv([a.includes(25), a.includes(172), a.includes(26), b.includes(5), b.includes(4)], [true, true, false, true, true]);
  });
  add('rules/legal/lineage-matches-independent-oracle', H, ({ R, pack: P }) => {
    for (const id of P.roster) { const a = R.lineageOf(P, id), b = oracleLineage(P, id); if (J(a) !== J(b)) return `species ${id}: ${J(a)} vs oracle ${J(b)}`; }
    return true;
  });
  add('rules/legal/own-species-sources-agree-with-tables-js', H, ({ R, pack: P }) => {
    const sorted = (xs) => [...xs].sort((a, b) => a - b);
    for (const id of P.roster) {
      const mine = R.learnsetOf(P, id, false), theirs = learnableMoves(P, id);
      const pick = (f) => sorted(Object.keys(mine).filter((k) => f(mine[k])).map(Number));
      const bad = [['levelUp', pick((e) => e.levelUp !== null), sorted(theirs.levelUp)], ['machine', pick((e) => e.machine), sorted(theirs.machine)],
        ['tutor', pick((e) => e.tutor), sorted(theirs.tutor)], ['egg', pick((e) => e.egg), sorted(theirs.egg)]].find(([, a, b]) => J(a) !== J(b));
      if (bad) return `species ${id} ${bad[0]} differs from tables.js learnableMoves`;
    }
    return true;
  });
  add('rules/legal/learnsets-match-independent-oracle', H, ({ R, pack: P }) => {
    for (const id of P.roster) for (const lineage of [true, false]) {
      const mine = R.learnsetOf(P, id, lineage), o = oracleLearnset(P, id, lineage);
      const a = Object.keys(mine).map((k) => [Number(k), mine[k].levelUp, mine[k].machine, mine[k].tutor, mine[k].egg]);
      const b = Object.keys(o).map((k) => [Number(k), o[k].lu, o[k].mc, o[k].tu, o[k].eg]).sort((x, y) => x[0] - y[0]);
      if (J(a) !== J(b)) return `species ${id} lineage=${lineage}: first diff at ${J(a.find((x, i) => J(x) !== J(b[i])))}`;
    }
    return true;
  });
  add('rules/legal/legalMoves-is-the-set-moveLegality-accepts', C, ({ R, pack: P }) => {
    const bannedSet = clone(R.resolveRuleset(STD)); bannedSet.banned.moves = [MV.Earthquake];
    for (const id of [25, 6, 445, 132, 1553]) for (const lv of [1, 54, 100]) {
      const lm = R.legalMoves(P, id, lv, STD);
      // candidates: everything in the learnset plus every 31st move id (which are almost all unlearnable): moveLegality must agree move by move
      const cand = new Set([...Object.keys(R.learnsetOf(P, id, true)).map(Number), ...Array.from({ length: 30 }, (_, i) => 1 + i * 31)]);
      const engOk = R.engineSupports(P).moves; // stage E1: the engine layer filters legalMoves; moveLegality itself stays the pure learnset rule
      const brute = [...cand].filter((m) => m >= 1 && m < P.moves.length && R.moveLegality(P, id, lv, m, STD).legal && engOk.has(m)).sort((a, b) => a - b);
      if (J(lm) !== J(brute)) return `species ${id} lv ${lv}: legalMoves ${lm.length} vs per-move ${brute.length}`;
      if (lm.some((m, i) => i > 0 && lm[i - 1] >= m) || lm.includes(0)) return `species ${id}: not strictly ascending / contains 0`;
    }
    const withBan = R.legalMoves(P, 445, 100, bannedSet);
    return withBan.includes(MV.Earthquake) ? 'a banned move is listed as legal' : R.legalMoves(P, 445, 100, STD).includes(MV.Earthquake) ? true : 'Earthquake missing from the unbanned list';
  });

  // ===================================== rules: validation goldens and boundaries =====================================
  add('rules/valid/baselines-ok', C, ({ R, pack: P }) => all([[STD, garch()], [STRICT, garchStrict()], [STD + '+lv5', garch()], [STD + '+lv100+item-clause', garch()]], ([rs, rec]) => {
    const v = R.validateMon(rec, P, rs);
    return v.ok && v.reasons.length === 0 ? true : `${rs}: ${J(v.reasons)}`;
  }));
  // [label, ruleset, mutate(rec), expected sorted 'code@path' list]   (empty list = must be fully valid)
  const BOUND = [];
  const B = (label, rs, mut, want) => BOUND.push([label, rs, mut, want]);
  const s = (rec, k, v) => { rec[k] = v; return rec; };
  B('level 1', STD, (r) => s(r, 'level', 1), []); B('level 0', STD, (r) => s(r, 'level', 0), ['level.range@level']);
  B('level 100', STD, (r) => s(r, 'level', 100), []); B('level 101', STD, (r) => s(r, 'level', 101), ['level.range@level']);
  B('level 50.5', STD, (r) => s(r, 'level', 50.5), ['level.range@level']); B('level "50"', STD, (r) => s(r, 'level', '50'), ['level.range@level']);
  B('nature 0', STD, (r) => s(r, 'nature', 0), []); B('nature 24', STD, (r) => s(r, 'nature', 24), []);
  B('nature 25', STD, (r) => s(r, 'nature', 25), ['nature.range@nature']); B('nature -1', STD, (r) => s(r, 'nature', -1), ['nature.range@nature']);
  B('slot 0', STD, (r) => s(r, 'abilitySlot', 0), []); B('slot 2', STD, (r) => s(r, 'abilitySlot', 2), []);
  B('slot 1 empty for Garchomp', STD, (r) => s(r, 'abilitySlot', 1), ['ability.slot-empty@abilitySlot']);
  B('slot 3', STD, (r) => s(r, 'abilitySlot', 3), ['ability.slot-range@abilitySlot']); B('slot -1', STD, (r) => s(r, 'abilitySlot', -1), ['ability.slot-range@abilitySlot']);
  B('item 0', STD, (r) => s(r, 'item', 0), []); B('item omitted', STD, (r) => { delete r.item; return r; }, []);
  B('item 929', STD, (r) => s(r, 'item', 929), []); B('item 930', STD, (r) => s(r, 'item', 930), ['item.unknown@item']); B('item -1', STD, (r) => s(r, 'item', -1), ['item.unknown@item']);
  B('iv 0', STD, (r) => { r.ivs.atk = 0; return r; }, []); B('iv 31', STD, (r) => { r.ivs.atk = 31; return r; }, []);
  B('iv 32', STD, (r) => { r.ivs.atk = 32; return r; }, ['iv.range@ivs.atk']); B('iv -1', STD, (r) => { r.ivs.spe = -1; return r; }, ['iv.range@ivs.spe']);
  B('ev 255 alone', STD, (r) => { r.evs = { ...zero6(), atk: 255 }; return r; }, []);
  B('ev 256', STD, (r) => { r.evs = { ...zero6(), atk: 256 }; return r; }, ['ev.range@evs.atk']); B('ev -1', STD, (r) => { r.evs.def = -1; return r; }, ['ev.range@evs.def']);
  B('ev total 510', STD, (r) => r, []); B('ev total 511', STD, (r) => { r.evs.hp = 7; return r; }, ['ev.total@evs']);
  B('ev total 510 spread', STD, (r) => { r.evs = { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 }; return r; }, []);
  B('ev: one bad stat suppresses the total', STD, (r) => { r.evs = { hp: 255, atk: 255, def: 255, spa: 0, spd: 0, spe: 256 }; return r; }, ['ev.range@evs.spe']);
  B('moves 1', STD, (r) => s(r, 'moves', [MV.Earthquake]), []); B('moves 4', STD, (r) => r, []);
  B('moves 5', STD, (r) => s(r, 'moves', [MV.Earthquake, MV['Dragon Claw'], MV.Sandstorm, MV.Dig, MV.Surf]), ['moves.count@moves']);
  B('moves 0', STD, (r) => s(r, 'moves', []), ['moves.count@moves']); B('moves not array', STD, (r) => s(r, 'moves', 'Earthquake'), ['moves.shape@moves']);
  B('move id 0', STD, (r) => { r.moves[1] = 0; return r; }, ['move.unknown@moves[1]']); B('move id 936', STD, (r) => { r.moves[1] = 936; return r; }, ['move.unknown@moves[1]']);
  B('move id 935 is known (illegal for Garchomp)', STD, (r) => { r.moves[1] = 935; return r; }, ['move.illegal@moves[1]']);
  B('duplicate move', STD, (r) => { r.moves[1] = r.moves[0]; return r; }, ['move.duplicate@moves[1]']);
  B('illegal move', STD, (r) => { r.moves[3] = MV.Thunderbolt; return r; }, ['move.illegal@moves[3]']);
  B('species 0 (non-roster slot)', STD, (r) => s(r, 'species', 0), ['species.illegal@species']); B('species 1578 (non-roster slot)', STD, (r) => s(r, 'species', 1578), ['species.illegal@species']);
  B('species: an all-zero slot', STD, (r) => s(r, 'species', NULL_SLOT), ['species.unknown@species']); B('species -1', STD, (r) => s(r, 'species', -1), ['species.unknown@species']);
  B('species 1579 (out of range)', STD, (r) => s(r, 'species', 1579), ['species.unknown@species']); B('species 1.5', STD, (r) => s(r, 'species', 1.5), ['species.unknown@species']);
  B('ivs missing', STD, (r) => { delete r.ivs; return r; }, ['iv.missing@ivs']); B('evs missing', STD, (r) => { delete r.evs; return r; }, ['ev.missing@evs']);
  B('one iv missing', STD, (r) => { delete r.ivs.spd; return r; }, ['iv.missing@ivs.spd']); B('one ev missing', STD, (r) => { delete r.evs.hp; return r; }, ['ev.missing@evs.hp']);
  B('level 50 under lv5 preset', STD + '+lv5', (r) => s(r, 'level', 50), []);
  // strict
  B('strict baseline 32/32/2 (516 EV derived)', STRICT, (r) => r, []);
  B('strict points 32 each ok', STRICT, (r) => { r.points = { hp: 32, atk: 32, def: 2, spa: 0, spd: 0, spe: 0 }; return r; }, []);
  B('strict points 33', STRICT, (r) => { r.points.def = 33; return r; }, ['points.range@points.def']); B('strict points -1', STRICT, (r) => { r.points.def = -1; return r; }, ['points.range@points.def']);
  B('strict points total 66', STRICT, (r) => { r.points = { hp: 2, atk: 32, def: 0, spa: 0, spd: 0, spe: 32 }; return r; }, []);
  B('strict points total 67', STRICT, (r) => { r.points.def = 1; return r; }, ['points.total@points']);
  B('strict level 50', STRICT, (r) => r, []); B('strict level 49', STRICT, (r) => s(r, 'level', 49), ['level.fixed@level']); B('strict level 51', STRICT, (r) => s(r, 'level', 51), ['level.fixed@level']);
  B('strict level 101', STRICT, (r) => s(r, 'level', 101), ['level.range@level']);
  B('strict ivs omitted', STRICT, (r) => r, []); B('strict ivs 31 given', STRICT, (r) => s(r, 'ivs', ivs31()), []);
  B('strict iv 30', STRICT, (r) => s(r, 'ivs', { ...ivs31(), spa: 30 }), ['iv.fixed@ivs.spa']); B('strict iv 32', STRICT, (r) => s(r, 'ivs', { ...ivs31(), spa: 32 }), ['iv.range@ivs.spa']);
  B('strict evs equal to derived', STRICT, (r) => s(r, 'evs', { hp: 12, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }), []);
  B('strict evs from the wrong (8p) conversion', STRICT, (r) => s(r, 'evs', { hp: 16, atk: 256 - 4, def: 0, spa: 0, spd: 0, spe: 252 }), ['points.ev-mismatch@evs.hp']);
  B('strict evs 256', STRICT, (r) => s(r, 'evs', { hp: 12, atk: 256, def: 0, spa: 0, spd: 0, spe: 252 }), ['ev.range@evs.atk']);
  B('strict points omitted', STRICT, (r) => { delete r.points; return r; }, ['points.missing@points']);
  B('strict one point stat omitted', STRICT, (r) => { delete r.points.spe; return r; }, ['points.missing@points.spe']);
  B('strict move legality uses level 50', STRICT, (r) => { r.moves[3] = MV['Take Down']; return r; }, ['move.illegal@moves[3]']);
  add('rules/valid/boundary-table', C, ({ R, pack: P }) => all(BOUND, ([label, rs, mut, want]) => {
    const rec = mut(baseFor(rs));
    const got = codesOf(R.validateMon(rec, P, rs));
    return J(got) === J(want.slice().sort()) ? true : `${label} [${rs}]: got ${J(got)} want ${J(want)}`;
  }));

  add('rules/valid/illegal-species-slots', C, ({ R, pack: P }) => {
    const ill = P.species.map((x, i) => (x && !x.legal ? i : -1)).filter((i) => i >= 0);
    if (ill.length === 0) return 'no non-roster species exists to test species.illegal with';
    return all(ill, (id) => { const v = R.validateMon({ ...garch(), species: id }, P, STD); return v.reasons.some((r) => r.code === 'species.illegal') ? true : `species ${id}: ${J(codesOf(v))}`; });
  });
  add('rules/valid/types-are-strict', C, ({ R, pack: P }) => {
    const junk = ['5', 5.5, NaN, null, true, [], {}, Infinity, undefined];
    const fields = [['level', 'level.range@level'], ['nature', 'nature.range@nature'], ['abilitySlot', 'ability.slot-range@abilitySlot'], ['species', 'species.unknown@species']];
    for (const [f, code] of fields) for (const j of junk) {
      const rec = garch(); rec[f] = j;
      const got = codesOf(R.validateMon(rec, P, STD));
      if (!got.includes(code)) return `${f} = ${String(j)}: got ${J(got)}`;
    }
    const rec = garch(); rec.item = '472';
    return codesOf(R.validateMon(rec, P, STD)).includes('item.unknown@item') ? true : 'string item accepted';
  });
  add('rules/valid/negative-zero-is-zero', C, ({ R, pack: P }) => {
    const rec = JSON.parse(JSON.stringify(garch()).replace('"def":0', '"def":-0'));
    if (!Object.is(rec.evs.def, -0)) return 'fixture did not produce -0';
    const v = R.validateMon(rec, P, STD);
    const evs = R.effectiveEvs(rec, STD);
    return v.ok && Object.is(evs.def, 0) ? true : `ok ${v.ok} effective def is ${Object.is(evs.def, -0) ? '-0' : evs.def}`;
  });
  add('rules/valid/missing-top-level-fields', C, ({ R, pack: P }) => {
    const want = { species: 'species.unknown@species', level: 'level.range@level', nature: 'nature.range@nature', abilitySlot: 'ability.slot-range@abilitySlot', moves: 'moves.shape@moves', ivs: 'iv.missing@ivs', evs: 'ev.missing@evs' };
    for (const [f, code] of Object.entries(want)) { const rec = garch(); delete rec[f]; if (!codesOf(R.validateMon(rec, P, STD)).includes(code)) return `without ${f}: ${J(codesOf(R.validateMon(rec, P, STD)))}`; }
    return true;
  });
  add('rules/valid/unknown-fields-are-ignored', C, ({ R, pack: P }) => {
    const rec = { ...garch(), nickname: 'x'.repeat(500), shiny: true, junk: { a: [1, 2] }, evs: { ...garch().evs, extra: 99999 } };
    return R.validateMon(rec, P, STD).ok ? true : J(R.validateMon(rec, P, STD).reasons);
  });
  add('rules/valid/reason-shape', C, ({ R, pack: P }) => {
    const rec = garch(); rec.level = 0; rec.nature = 99; rec.moves = [0, 0, MV.Thunderbolt]; rec.evs.hp = 255;
    const v = R.validateMon(rec, P, STD);
    if (v.ok || v.reasons.length < 5) return 'expected several reasons: ' + J(v.reasons);
    for (const r of v.reasons) if (!(r.code in R.RULE_CODES) || typeof r.path !== 'string' || typeof r.message !== 'string' || r.message.length < 5) return 'bad reason ' + J(r);
    return J(v) === J(R.validateMon(clone(rec), P, STD)) ? true : 'not deterministic across a JSON clone';
  });
  add('rules/valid/no-cascade-from-invalid-level-or-species', C, ({ R, pack: P }) => {
    const a = garch(); a.level = 0; a.moves = [MV['Take Down'], MV.Earthquake];
    const b = garch(); b.species = NULL_SLOT; b.abilitySlot = 1;
    const illId = P.species.findIndex((x) => x && !x.legal && x.abilities[0] === 0);
    if (illId < 0) return 'fixture drifted: no non-roster species with an empty ability slot 0 (a cascade would not show)';
    const c = { ...garch(), species: illId, abilitySlot: 0 }; // an existing but non-roster species: no ability / move cascade either
    return eqv([codesOf(R.validateMon(a, P, STD)), codesOf(R.validateMon(b, P, STD)), codesOf(R.validateMon(c, P, STD))], [['level.range@level'], ['species.unknown@species'], ['species.illegal@species']]);
  });
  add('rules/valid/inherited-and-proto-fields-ignored', C, ({ R, pack: P }) => {
    const proto = garch();
    const inheriting = Object.create(proto);
    const v1 = R.validateMon(inheriting, P, STD);
    if (v1.ok || !codesOf(v1).includes('species.unknown@species')) return 'inherited properties were read: ' + J(codesOf(v1));
    const viaJson = JSON.parse('{"__proto__": {"species": 445}, "constructor": 1}');
    const v2 = R.validateMon(viaJson, P, STD);
    return !v2.ok && codesOf(v2).includes('species.unknown@species') ? true : J(codesOf(v2));
  });
  add('rules/valid/custom-knobs', C, ({ R, pack: P }) => {
    const mk = (f) => { const r = clone(R.resolveRuleset(STD)); f(r); return r; };
    const cases = [
      ['slots [0,1] disallows 2', mk((r) => { r.ability.slots = [0, 1]; }), garch(), ['ability.slot-disallowed@abilitySlot']],
      ['nature.count 20 rejects 22', mk((r) => { r.nature.count = 20; }), { ...garch(), nature: 22 }, ['nature.range@nature']],
      ['moves.min 2 rejects one move', mk((r) => { r.moves.min = 2; }), { ...garch(), moves: [MV.Earthquake] }, ['moves.count@moves']],
      ['duplicates allowed', mk((r) => { r.moves.duplicates = true; }), { ...garch(), moves: [MV.Earthquake, MV.Earthquake] }, []],
      ['sources without machine', mk((r) => { r.moves.sources = ['levelUp', 'tutor', 'egg']; }), { ...garch(), moves: [MV.Earthquake] }, ['move.illegal@moves[0]']],
      ['levelGate off allows low level', mk((r) => { r.moves.levelGate = false; }), { ...garch(), level: 1, moves: [MV['Take Down']] }, []],
      ['levelGate on rejects low level', R.resolveRuleset(STD), { ...garch(), level: 1, moves: [MV['Take Down']] }, ['move.illegal@moves[0]']],
      ['lineage off rejects egg-only inheritance', mk((r) => { r.moves.lineage = false; }), { ...garch(), species: 6, abilitySlot: 0, moves: [MV['Belly Drum']] }, ['move.illegal@moves[0]']],
      ['lineage on accepts it', R.resolveRuleset(STD), { ...garch(), species: 6, abilitySlot: 0, moves: [MV['Belly Drum']] }, []],
      ['ev total null relaxes the cap', mk((r) => { r.ev.total = null; }), { ...garch(), evs: { hp: 255, atk: 255, def: 255, spa: 0, spd: 0, spe: 0 } }, []],
      ['ev perStat 100', mk((r) => { r.ev.perStat = 100; }), { ...garch(), evs: { ...zero6(), atk: 101 } }, ['ev.range@evs.atk']],
      ['iv range 5..20', mk((r) => { r.iv.min = 5; r.iv.max = 20; }), garch(), UI.map((k) => `iv.range@ivs.${k}`)],
      ['strict that keeps the 510 cap: 32/32/2 derives to 516 EV', (() => { const r = clone(R.resolveRuleset(STRICT)); r.ev.total = 510; return r; })(), garchStrict(), ['ev.total@points']],
      ['strict with the cap relaxed accepts the same card', R.resolveRuleset(STRICT), garchStrict(), []],
      ['strict that keeps the cap still accepts a 30/30/2 card (derives to 484)', (() => { const r = clone(R.resolveRuleset(STRICT)); r.ev.total = 510; return r; })(), { ...garchStrict(), points: { hp: 2, atk: 30, def: 0, spa: 0, spd: 0, spe: 30 } }, []],
    ];
    return all(cases, ([label, rs, rec, want]) => { const got = codesOf(R.validateMon(rec, P, rs)); return J(got) === J(want.slice().sort()) ? true : `${label}: got ${J(got)} want ${J(want)}`; });
  });
  add('rules/valid/banned-lists', C, ({ R, pack: P }) => {
    const rs = clone(R.resolveRuleset(STD)), rsSp = clone(R.resolveRuleset(STD));
    rs.banned = { species: [], items: [ITEM.Leftovers], moves: [MV.Earthquake], abilities: [24] };
    rsSp.banned = { species: [445], items: [], moves: [], abilities: [] };
    const got = codesOf(R.validateMon(garch(), P, rs)), gotSp = codesOf(R.validateMon(garch(), P, rsSp));
    const clean = codesOf(R.validateMon(garch(), P, STD));
    return eqv([got, gotSp, clean], [['ability.banned@abilitySlot', 'item.banned@item', 'move.banned@moves[0]'], ['species.banned@species'], []]);
  });
  add('rules/valid/catalogue-covers-every-code', C, ({ R }) => {
    const have = Object.keys(R.RULE_CODES).sort(), cases = Object.keys(MATRIX).sort();
    return J(have) === J(cases) ? true : `RULE_CODES vs matrix: ${J(have.filter((x) => !cases.includes(x)))} uncovered, ${J(cases.filter((x) => !have.includes(x)))} unknown`;
  });
  // the MATRIX: for every code a bad input that fires it and a good twin that is silent. kind 'mon' | 'team'.
  const MATRIX = {
    'rec.shape': { kind: 'mon', rs: STD, good: () => garch(), bad: () => 'a string', path: '' },
    'species.unknown': { kind: 'mon', rs: STD, good: () => garch(), bad: () => s(garch(), 'species', NULL_SLOT), path: 'species' },
    'species.illegal': { kind: 'mon', rs: STD, good: () => garch(), bad: () => s(garch(), 'species', pack.species.findIndex((x) => x && !x.legal)), path: 'species' },
    'species.banned': { kind: 'mon', rs: STD, good: () => garch(), bad: () => garch(), path: 'species', rsBad: (r) => { r.banned.species = [445]; } },
    'level.range': { kind: 'mon', rs: STD, good: () => garch(), bad: () => s(garch(), 'level', 0), path: 'level' },
    'level.fixed': { kind: 'mon', rs: STRICT, good: () => garchStrict(), bad: () => s(garchStrict(), 'level', 51), path: 'level' },
    'nature.range': { kind: 'mon', rs: STD, good: () => garch(), bad: () => s(garch(), 'nature', 25), path: 'nature' },
    'ability.slot-range': { kind: 'mon', rs: STD, good: () => garch(), bad: () => s(garch(), 'abilitySlot', 3), path: 'abilitySlot' },
    'ability.slot-disallowed': { kind: 'mon', rs: STD, good: () => garch(), bad: () => garch(), path: 'abilitySlot', rsBad: (r) => { r.ability.slots = [0, 1]; } },
    'ability.slot-empty': { kind: 'mon', rs: STD, good: () => garch(), bad: () => s(garch(), 'abilitySlot', 1), path: 'abilitySlot' },
    'ability.banned': { kind: 'mon', rs: STD, good: () => garch(), bad: () => garch(), path: 'abilitySlot', rsBad: (r) => { r.banned.abilities = [24]; } },
    'item.unknown': { kind: 'mon', rs: STD, good: () => garch(), bad: () => s(garch(), 'item', 930), path: 'item' },
    'item.banned': { kind: 'mon', rs: STD, good: () => garch(), bad: () => garch(), path: 'item', rsBad: (r) => { r.banned.items = [ITEM.Leftovers]; } },
    'moves.shape': { kind: 'mon', rs: STD, good: () => garch(), bad: () => s(garch(), 'moves', 5), path: 'moves' },
    'moves.count': { kind: 'mon', rs: STD, good: () => garch(), bad: () => s(garch(), 'moves', []), path: 'moves' },
    'move.unknown': { kind: 'mon', rs: STD, good: () => garch(), bad: () => { const r = garch(); r.moves[2] = 0; return r; }, path: 'moves[2]' },
    'move.duplicate': { kind: 'mon', rs: STD, good: () => garch(), bad: () => { const r = garch(); r.moves[1] = r.moves[0]; return r; }, path: 'moves[1]' },
    'move.banned': { kind: 'mon', rs: STD, good: () => garch(), bad: () => garch(), path: 'moves[0]', rsBad: (r) => { r.banned.moves = [MV.Earthquake]; } },
    'move.illegal': { kind: 'mon', rs: STD, good: () => garch(), bad: () => { const r = garch(); r.moves[3] = MV['Hydro Pump']; return r; }, path: 'moves[3]' },
    'iv.missing': { kind: 'mon', rs: STD, good: () => garch(), bad: () => { const r = garch(); delete r.ivs; return r; }, path: 'ivs' },
    'iv.range': { kind: 'mon', rs: STD, good: () => garch(), bad: () => { const r = garch(); r.ivs.hp = 32; return r; }, path: 'ivs.hp' },
    'iv.fixed': { kind: 'mon', rs: STRICT, good: () => garchStrict(), bad: () => s(garchStrict(), 'ivs', { ...ivs31(), hp: 30 }), path: 'ivs.hp' },
    'ev.missing': { kind: 'mon', rs: STD, good: () => garch(), bad: () => { const r = garch(); delete r.evs; return r; }, path: 'evs' },
    'ev.range': { kind: 'mon', rs: STD, good: () => garch(), bad: () => { const r = garch(); r.evs.spe = 256; return r; }, path: 'evs.spe' },
    'ev.total': { kind: 'mon', rs: STD, good: () => garch(), bad: () => { const r = garch(); r.evs.def = 1; return r; }, path: 'evs' },
    'points.missing': { kind: 'mon', rs: STRICT, good: () => garchStrict(), bad: () => { const r = garchStrict(); delete r.points; return r; }, path: 'points' },
    'points.range': { kind: 'mon', rs: STRICT, good: () => garchStrict(), bad: () => { const r = garchStrict(); r.points.hp = 33; return r; }, path: 'points.hp' },
    'points.total': { kind: 'mon', rs: STRICT, good: () => garchStrict(), bad: () => { const r = garchStrict(); r.points.def = 1; return r; }, path: 'points' },
    'points.ev-mismatch': { kind: 'mon', rs: STRICT, good: () => garchStrict(), bad: () => s(garchStrict(), 'evs', { hp: 8, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }), path: 'evs.hp' },
    // stage E1: the engine-support codes (a unit-level proof lives in pokemonarena_engine_test.mjs too)
    'move.engine-unsupported': { kind: 'mon', rs: STD, pack: (P) => poisonMove(P, ENGINE_UNSUPPORTED_GARCHOMP_MOVE), good: () => garch(), bad: () => { const r = garch(); r.moves[1] = ENGINE_UNSUPPORTED_GARCHOMP_MOVE; return r; }, path: 'moves[1]' },
    'ability.engine-unsupported': { kind: 'mon', rs: STD, good: () => s(RULES0.blankRec(MIXED_AB.sid, pack, STD), 'abilitySlot', MIXED_AB.good), bad: () => s(RULES0.blankRec(MIXED_AB.sid, pack, STD), 'abilitySlot', MIXED_AB.bad), path: 'abilitySlot' },   // Milotic slot 2 = Cute Charm (needs gender, which the engine does not have)
    'item.engine-unsupported': { kind: 'mon', rs: STD, good: () => garch(), bad: () => s(garch(), 'item', MEGA_STONE), path: 'item' },
    'species.engine-no-ability': { kind: 'mon', rs: STD, good: () => garch(), bad: () => { const r = garch(); r.species = NO_ABILITY_SPECIES; r.abilitySlot = 0; r.moves = [RULES0.legalMoves(pack, NO_ABILITY_SPECIES, 100, 'arena-gen3-standard')[0]]; return r; }, path: 'species' },
    'species.engine-no-move': { kind: 'mon', rs: STD, good: () => garch(), bad: () => s(garch(), 'moves', [MV.Earthquake]), path: 'species', rsBad: (r) => { r.moves.sources = []; }, also: ['move.illegal'] },
    'team.shape': { kind: 'team', rs: STD, good: () => [garch()], bad: () => ({ 0: garch() }), path: 'team' },
    'team.size': { kind: 'team', rs: STD, good: () => [garch()], bad: () => [], path: 'team' },
    'team.species-clause': { kind: 'team', rs: STD, good: () => [garch(), { ...garch(), species: 6, abilitySlot: 0, moves: [MV.Flamethrower] }], bad: () => [garch(), { ...garch(), species: 947, abilitySlot: 0, moves: [MV.Earthquake] }], path: 'team' },
    'team.item-clause': { kind: 'team', rs: STD + '+item-clause', good: () => [garch(), { ...garch(), species: 6, abilitySlot: 0, moves: [MV.Flamethrower], item: ITEM.LifeOrb }], bad: () => [garch(), { ...garch(), species: 6, abilitySlot: 0, moves: [MV.Flamethrower] }], path: 'team' },
  };
  add('rules/matrix/every-code-fires-on-its-bad-input-and-stays-silent-on-the-good-twin', C, ({ R, pack: P }) => all(Object.entries(MATRIX), ([code, m]) => {
    const run = (input, rsMut) => {
      let rs = m.rs;
      if (rsMut) { rs = clone(R.resolveRuleset(m.rs)); rsMut(rs); }
      const PP = m.pack ? m.pack(P) : P;
      return m.kind === 'mon' ? R.validateMon(input, PP, rs) : R.validateTeam(input, PP, rs);
    };
    const good = run(m.good(), null);
    if (!good.ok) return `${code}: the GOOD twin is not silent: ${J(good.reasons.map((r) => r.code))}`;
    const bad = run(m.bad(), m.rsBad || null);
    const fired = bad.reasons.filter((r) => r.code === code);
    if (fired.length === 0) return `${code}: the bad input did not fire it (got ${J(bad.reasons.map((r) => r.code))})`;
    if (!fired.some((r) => r.path === m.path)) return `${code}: fired at ${J(fired.map((r) => r.path))}, expected ${m.path}`;
    const others = bad.reasons.filter((r) => r.code !== code && !(m.also || []).includes(r.code));
    if (others.length) return `${code}: the bad input also fired ${J(others.map((r) => r.code))} (a mutant should break exactly one rule)`;
    return true;
  }));

  // ===================================== rules: teams =====================================
  const t2 = (a, b) => [a, b];
  add('rules/team/size-boundaries', C, ({ R, pack: P }) => {
    const mon = (sid) => R.blankRec(sid, P, STD);
    const six = [4, 25, 132, 292, 445, 172].map(mon), seven = [...six, mon(6)];
    const r0 = R.validateTeam([], P, STD), r1 = R.validateTeam([mon(25)], P, STD), r6 = R.validateTeam(six, P, STD), r7 = R.validateTeam(seven, P, STD);
    return eqv([codesOf(r0), r1.ok, r6.ok, codesOf(r7), r7.mons.length], [['team.size@team'], true, true, ['team.size@team'], 6]);
  });
  add('rules/team/shape', C, ({ R, pack: P }) => all([null, undefined, {}, 'x', 5, { length: 3 }], (x) => { const v = R.validateTeam(x, P, STD); return !v.ok && J(codesOf(v)) === J(['team.shape@team']) && v.mons.length === 0 ? true : J(v); }));
  add('rules/team/species-clause-by-dex-number', C, ({ R, pack: P }) => {
    const a = R.blankRec(445, P, STD), b = R.blankRec(947, P, STD), c = R.blankRec(1558, P, STD), other = R.blankRec(6, P, STD);
    const same = R.validateTeam(t2(a, b), P, STD), three = R.validateTeam([a, b, c], P, STD), diff = R.validateTeam(t2(a, other), P, STD), off = R.validateTeam(t2(a, b), P, STD + '+no-species-clause');
    const fired = same.reasons.find((r) => r.code === 'team.species-clause');
    return eqv([P.species[445].natDex === P.species[947].natDex, fired && fired.indexes, three.reasons.filter((r) => r.code === 'team.species-clause').length, diff.ok, off.ok],
      [true, [0, 1], 1, true, true]);
  });
  add('rules/team/item-clause', C, ({ R, pack: P }) => {
    const mk = (sid, item) => ({ ...R.blankRec(sid, P, STD), item });
    const dupe = [mk(445, ITEM.Leftovers), mk(6, ITEM.Leftovers)], bothNone = [mk(445, 0), mk(6, 0)], differ = [mk(445, ITEM.Leftovers), mk(6, ITEM.LifeOrb)];
    const on = STD + '+item-clause';
    return eqv([R.validateTeam(dupe, P, STD).ok, codesOf(R.validateTeam(dupe, P, on)), R.validateTeam(bothNone, P, on).ok, R.validateTeam(differ, P, on).ok],
      [true, ['team.item-clause@team'], true, true]);
  });
  add('rules/team/paths-flattening-and-order', C, ({ R, pack: P }) => {
    const good = R.blankRec(25, P, STD), bad = R.blankRec(445, P, STD);
    bad.evs.hp = 255; bad.evs.atk = 255; bad.evs.def = 1; // total 511
    const bad2 = R.blankRec(6, P, STD); bad2.level = 0;
    const v = R.validateTeam([good, bad2, bad, good], P, STD);
    // two Pikachu entries -> the species clause is a team-level reason and must come FIRST
    const codes = v.reasons.map((r) => `${r.code}@${r.path}#${r.mon === undefined ? 'team' : r.mon}`);
    return eqv([codes, v.mons.map((m) => m.ok)], [['team.species-clause@team#team', 'level.range@mons[1].level#1', 'ev.total@mons[2].evs#2'], [true, false, false, true]]);
  });

  // ===================================== rules: effective values and battle stats =====================================
  add('rules/battle/effective-values', C, ({ R }) => {
    const st = garchStrict();
    const ev = R.effectiveEvs(st, STRICT), iv = R.effectiveIvs(st, STRICT), evStd = R.effectiveEvs(garch(), STD), ivStd = R.effectiveIvs({ ...garch(), ivs: { ...ivs31(), atk: 7 } }, STD);
    return eqv([ev, iv, evStd, ivStd.atk], [{ hp: 12, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, ivs31(), garch().evs, 7]);
  });
  add('rules/battle/battle-level-normalisation', C, ({ R }) => {
    const own = clone(R.resolveRuleset(STD)); own.level.battle = null;
    return eqv([R.battleLevel(garch(), STD), R.battleLevel(garch(), STD + '+lv5'), R.battleLevel(garch(), STD + '+lv100'), R.battleLevel(garch(), STRICT), R.battleLevel({ level: 37 }, own)], [50, 5, 100, 50, 37]);
  });
  add('rules/battle/stats-at-the-battle-level', C, ({ R, S, pack: P }) => {
    const sp = P.species[445], rec = garch();
    const at = (lv) => S.computeStats(sp.baseStats, rec.ivs, rec.evs, lv, rec.nature, P.natures);
    const a = R.battleStats(rec, P, STD), b = R.battleStats(rec, P, STD + '+lv100'), c = R.battleStats(rec, P, STD + '+lv5');
    const e1 = eqv([a, b, c], [at(50), at(100), at(5)]);
    if (e1 !== true) return e1;
    // Garchomp (108/130/95/80/85/102), IV 31, EV 6/252/0/0/0/252, Adamant, hand-computed at level 100
    return eqv(b, { hp: 358, atk: 394, def: 226, spa: 176, spd: 206, spe: 303 });
  });
  add('rules/battle/strict-points-identity-on-every-species', C, ({ R, pack: P }) => {
    for (const id of P.roster) {
      const sp = P.species[id];
      for (const p of [0, 1, 16, 32]) {
        const rec = { species: id, level: 50, nature: 0, abilitySlot: 0, item: 0, moves: [1], points: { hp: p, atk: p, def: p, spa: p, spd: p, spe: p } };
        const st = R.battleStats(rec, P, STRICT);
        for (const k of UI) {
          const want = k === 'hp' ? (sp.baseStats.hp === 1 ? 1 : sp.baseStats.hp + p + 75) : sp.baseStats[k] + p + 20;
          if (st[k] !== want) return `species ${id} ${sp.name} ${k} p${p}: got ${st[k]} want ${want}`;
        }
      }
    }
    return true;
  });
  add('rules/battle/nature-applies-through-battleStats', C, ({ R, pack: P }) => {
    const mk = (nature) => ({ ...garch(), nature });
    const neutral = R.battleStats(mk(0), P, STD), adamant = R.battleStats(mk(3), P, STD);
    return eqv([adamant.atk, adamant.spa, adamant.hp === neutral.hp, adamant.spe === neutral.spe], [Math.floor(neutral.atk * 110 / 100), Math.floor(neutral.spa * 90 / 100), true, true]);
  });
  add('rules/battle/blankRec-valid-for-every-species-and-preset', H, ({ R, pack: P }) => {
    for (const rs of PRESETS) for (const id of P.roster) {
      let rec;
      if (new Set(R.engineExcludedSpecies(P, rs).map((e) => e.id)).has(id)) { // stage E1: species the battle engine cannot run are excluded
        const e = throwsKind(() => R.blankRec(id, P, rs), RangeError);
        if (e !== true) return `excluded species ${id} under ${rs}: ${e}`;
        continue;
      }
      try { rec = R.blankRec(id, P, rs); } catch (e) { return `blankRec(${id}) under ${rs} threw ${e.message}`; }
      const v = R.validateMon(rec, P, rs);
      if (!v.ok) return `blankRec(${id}) under ${rs} invalid: ${J(codesOf(v))}`;
      if (R.battleStats(rec, P, rs).hp < 1) return `species ${id}: HP < 1`;
    }
    return all([() => throwsKind(() => R.blankRec(0, P, STD), RangeError), () => throwsKind(() => R.blankRec(pack.species.findIndex((x) => x && !x.legal), P, STD), RangeError)], (f) => f());
  });

  // ===================================== rules: wire safety, determinism, differential =====================================
  add('rules/wire/frozen-inputs-are-not-mutated', C, ({ R, pack: P }) => {
    const rec = deepFreeze(garch()), team = deepFreeze([garch(), { ...garch(), species: 947 }]), strict = deepFreeze(garchStrict());
    try {
      R.validateMon(rec, P, STD); R.validateTeam(team, P, STD); R.validateMon(strict, P, STRICT); R.battleStats(rec, P, STD); R.effectiveEvs(strict, STRICT);
      R.legalMoves(P, 445, 100, STD); R.learnsetOf(P, 445, true); R.lineageOf(P, 445);
    } catch (e) { return `touched a frozen input: ${e.message}`; }
    return J(R.validateMon(rec, P, STD)) === J(R.validateMon(clone(rec), P, STD)) ? true : 'frozen and unfrozen disagree';
  });
  add('determinism/key-order-and-json-roundtrip', C, ({ R, pack: P }) => {
    // several invalid stats, so the ORDER of the reasons is observable; the same record with every object's keys reversed must give the identical result
    const rec = garch();
    rec.evs = { hp: -1, atk: 300, def: 5, spa: -5, spd: 9, spe: 400 };
    rec.ivs = { hp: 40, atk: 31, def: -2, spa: 31, spd: 99, spe: 31 };
    const rev = {};
    for (const k of Object.keys(rec).reverse()) rev[k] = Array.isArray(rec[k]) || typeof rec[k] !== 'object' ? rec[k] : Object.fromEntries(Object.entries(rec[k]).reverse());
    const bad = garch(); bad.level = 0; bad.moves[2] = Number.NaN;
    const a = R.validateMon(rec, P, STD), b = R.validateMon(rev, P, STD);
    if (a.reasons.length < 6) return 'fixture should raise several reasons: ' + J(a.reasons);
    return all([[a, b], [R.validateMon(bad, P, STD), R.validateMon(JSON.parse(JSON.stringify(bad)), P, STD)]], ([x, y]) => (J(x) === J(y) ? true : 'result depends on key order / JSON round trip'));
  });
  add('rules/wire/junk-never-throws', H, ({ R, pack: P }) => {
    const rng = mulberry32(0x5eed1234);
    const deepJunk = (d) => {
      const r = rng();
      if (d > 3 || r < 0.5) return JUNK[Math.floor(rng() * JUNK.length)];
      if (r < 0.75) return Array.from({ length: Math.floor(rng() * 5) }, () => deepJunk(d + 1));
      const o = {}; for (const k of ['species', 'level', 'nature', 'moves', 'ivs', 'evs', 'points', 'item', 'abilitySlot', '__proto__', 'constructor', 'hp', '0']) if (rng() < 0.5) o[k] = deepJunk(d + 1);
      return o;
    };
    let n = 0;
    for (let i = 0; i < 6000; i++) {
      const x = deepJunk(0);
      for (const rs of [STD, STRICT]) {
        try { const v = R.validateMon(x, P, rs); if (typeof v.ok !== 'boolean' || !Array.isArray(v.reasons)) return 'bad result shape'; if (typeof x !== 'object' || x === null || Array.isArray(x)) if (v.ok) return 'non-object accepted'; n++; }
        catch (e) { return `validateMon threw on ${J(x)}: ${e.message}`; }
        try { R.validateTeam(x, P, rs); R.validateTeam([x, x, x], P, rs); n++; } catch (e) { return `validateTeam threw on ${J(x)}: ${e.message}`; }
      }
    }
    const huge = { ...garch(), moves: Array.from({ length: 1e6 }, (_, i) => i) };
    const v = R.validateMon(huge, P, STD);
    if (v.reasons.length > 40) return `a million-move array produced ${v.reasons.length} reasons (work is not capped)`;
    const bigTeam = R.validateTeam(Array.from({ length: 3000 }, () => garch()), P, STD);
    return v.reasons.some((r) => r.code === 'moves.count') && bigTeam.mons.length === 6 && n > 20000 ? true : 'size caps not applied';
  });
  // A hand-built ruleset that switches on every knob the presets leave off: bans, a restricted slot list, a looser EV cap,
  // a smaller nature count, a higher move minimum, level gate off, no lineage, duplicates allowed.
  const customRuleset = (R) => {
    const r = clone(R.resolveRuleset(STD));
    r.id = 'custom-test';
    r.ability.slots = [0, 1]; r.ev = { perStat: 200, total: 400 }; r.nature.count = 20; r.moves.min = 2; r.moves.duplicates = true;
    r.banned = { species: [25, 445], items: [472], moves: [MV.Earthquake, MV.Flamethrower].sort((a, b) => a - b), abilities: [24, 66] };
    r.engine = { enforce: false };
    return r;
  };
  add('rules/differential/validateMon-vs-independent-oracle', H, ({ R, pack: P }) => {
    let n = 0, okCount = 0;
    const seenCodes = new Set();
    // stage E1: the oracle below re-implements the PRE-engine rules, so every ruleset here has the engine layer switched off (it is tested in pokemonarena_engine_test.mjs)
    const sets = [...PRESETS.map((id) => ({ ...clone(R.resolveRuleset(id)), engine: { enforce: false } })), customRuleset(R)];
    const loose = customRuleset(R); loose.moves.levelGate = false; loose.moves.lineage = false; loose.id = 'custom-loose'; sets.push(loose);
    for (const rs of sets) {
      const rng = mulberry32(0xa11ce + rs.id.length);
      for (let i = 0; i < FUZZ_N; i++) {
        const rec = genRec(rng, rs);
        const got = codesOf(R.validateMon(rec, P, rs)), want = oracleCodes(rec, P, rs);
        n++;
        if (got.length === 0) okCount++;
        for (const c of got) seenCodes.add(c.split('@')[0]);
        if (J(got) !== J(want)) return `${rs.id} record ${i}: rules.js ${J(got)} vs oracle ${J(want)} for ${J(rec)}`;
      }
    }
    const missing = Object.keys(R.RULE_CODES).filter((c) => !c.startsWith('team.') && !c.includes('engine-') && !seenCodes.has(c));
    if (okCount < n * 0.03) return `only ${okCount} of ${n} generated records were valid: the generator is not reaching the accepting side`;
    return missing.length === 0 ? true : `the generator never produced: ${missing.join(', ')}`;
  });

  // ===================================== ROM code evidence =====================================
  // The hack's own stat routine WAS located by a static read of its Thumb code (hand-written decoder, nothing executed):
  // a function that starts at file offset 0x1ed920 and loops over the stats. These checks pin the facts that decode showed,
  // as assertions on instruction ENCODINGS (built from the mnemonic, no ROM bytes stored here). They read ctx.rom, so a
  // ROM-byte mutant (section C2) proves each one can fail.
  const T16 = (b, o) => b[o] | (b[o + 1] << 8);
  const blTarget = (b, o) => { const h1 = T16(b, o), h2 = T16(b, o + 2); if ((h1 >> 11) !== 0x1e || (h2 >> 11) !== 0x1f) return null; return o + 4 + ((((h1 & 0x7ff) << 21) >> 21) << 12) + ((h2 & 0x7ff) << 1); };
  const bTarget = (b, o) => { const h = T16(b, o); if ((h >> 12) !== 0xd) return null; return o + 4 + (((h & 255) << 24) >> 24) * 2; };
  const E = {
    movs: (rd, imm) => 0x2000 | (rd << 8) | imm, adds8: (rd, imm) => 0x3000 | (rd << 8) | imm, lslsImm: (rd, rs, imm) => (imm << 6) | (rs << 3) | rd,
    asrsImm: (rd, rs, imm) => 0x1000 | (imm << 6) | (rs << 3) | rd, muls: (rd, rs) => 0x4340 | (rs << 3) | rd, cmpReg: (rd, rs) => 0x4280 | (rs << 3) | rd,
    ldrbImm: (rd, rb, imm) => 0x7800 | (imm << 6) | (rb << 3) | rd, addHi: (rd, rs) => 0x4400 | ((rd >> 3) << 7) | ((rs >> 3) << 6) | ((rs & 7) << 3) | (rd & 7),
    push: (list, lr) => 0xb400 | list | (lr ? 0x100 : 0),
  };
  const DIVSI3 = 0x28913c; // the routine every "x / 100" in this function calls
  const expectWords = (b, rows) => { for (const [o, want, what] of rows) { const got = T16(b, o); if (got !== want) return `0x${o.toString(16)} (${what}): ROM halfword 0x${got.toString(16)}, expected 0x${want.toString(16)}`; } return true; };
  add('rom/code/stat-routine-starts-where-expected', C, ({ rom: b }) => expectWords(b, [[0x1ed920, E.push(0xf0, true), 'push {r4-r7,lr}']]));
  add('rom/code/nature-multipliers-110-and-90-over-100', C, ({ rom: b }) => {
    const e = expectWords(b, [
      [0x1edae8, E.movs(0, 110), 'movs r0,#110'], [0x1edaea, E.movs(1, 100), 'movs r1,#100'], [0x1edaec, E.muls(0, 3), 'muls r0,r3'],
      [0x1edaf8, E.movs(0, 90), 'movs r0,#90'], [0x1edafa, E.movs(1, 100), 'movs r1,#100'], [0x1edafc, E.muls(0, 3), 'muls r0,r3'],
      [0x1eda10, E.ldrbImm(2, 3, 4), 'ldrb r2,[r3,#4]  (nature +4 = raised stat)'], [0x1eda12, E.ldrbImm(1, 3, 5), 'ldrb r1,[r3,#5]  (nature +5 = lowered stat)'],
      [0x1eda16, E.cmpReg(2, 1), 'cmp r2,r1 (raised == lowered -> neutral)'],
    ]);
    if (e !== true) return e;
    const bl1 = blTarget(b, 0x1edaee), bl2 = blTarget(b, 0x1edafe), neutral = bTarget(b, 0x1eda18);
    return bl1 === DIVSI3 && bl2 === DIVSI3 && neutral === 0x1edaf2 ? true : `bl targets ${bl1} ${bl2}, neutral branch ${neutral}`;
  });
  add('rom/code/non-hp-stat-is-2b-plus-iv-plus-ev-over-4-times-level-over-100-plus-5', C, ({ rom: b }) => {
    const e = expectWords(b, [
      [0x1ed9e4, E.lslsImm(0, 0, 1), 'lsls r0,r0,#1  (2 * base)'], [0x1ed9f0, E.asrsImm(3, 3, 2), 'asrs r3,r3,#2  (EV / 4)'],
      [0x1ed9f6, E.movs(1, 100), 'movs r1,#100'], [0x1ed9fa, E.muls(0, 3), 'muls r0,r3  (* level)'], [0x1eda14, E.adds8(0, 5), 'adds r0,#5'],
    ]);
    return e !== true ? e : blTarget(b, 0x1ed9fc) === DIVSI3 ? true : 'the divide after the multiply is not the divide routine';
  });
  add('rom/code/hp-is-the-same-sum-times-level-over-100-plus-level-plus-10', C, ({ rom: b }) => {
    const e = expectWords(b, [
      [0x1eda72, E.movs(1, 100), 'movs r1,#100'], [0x1eda76, E.muls(0, 3), 'muls r0,r3  (* level)'], [0x1eda7c, E.addHi(0, 11), 'add r0,r11  (+ level)'], [0x1eda7e, E.adds8(0, 10), 'adds r0,#10'],
    ]);
    return e !== true ? e : blTarget(b, 0x1eda78) === DIVSI3 ? true : 'the HP divide is not the divide routine';
  });
  add('rom/code/species-292-is-special-cased-to-hp-1', C, ({ rom: b, pack: P }) => {
    const e = expectWords(b, [
      [0x1eda48, E.movs(3, 146), 'movs r3,#146'], [0x1eda50, E.lslsImm(3, 3, 1), 'lsls r3,r3,#1  (146 * 2 = 292)'], [0x1eda52, E.cmpReg(1, 3), 'cmp r1,r3  (species == 292)'],
      [0x1edb2c, E.movs(2, 1), 'movs r2,#1'], [0x1edb2e, E.movs(3, 1), 'movs r3,#1'], [0x1edb30, E.movs(0, 1), 'movs r0,#1  (HP = 1)'],
    ]);
    if (e !== true) return e;
    if (bTarget(b, 0x1eda54) !== 0x1edb2c) return 'the species-292 branch does not go to the HP = 1 block';
    return P.species[292] && P.species[292].name === 'Shedinja' ? true : 'species 292 is not Shedinja in the pack';
  });
  add('rom/code/stat-routine-reads-the-tables-tables-js-decodes', C, ({ rom: b }) => {
    const w = (o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    return eqv([w(0x1edb4c), w(0x1edb58)], [(0x08000000 + LAYOUT.natures.offset) >>> 0, (0x08000000 + LAYOUT.species.offset) >>> 0]);
  });

  // ===================================== purity =====================================
  const FORBIDDEN = /\b(Math\.random|Date\b|performance\b|process\b|require\s*\(|fetch\s*\(|document\b|window\b|localStorage|sessionStorage|crypto\b|setTimeout|setInterval|Intl\b|globalThis|navigator\b|Symbol\.|eval\s*\(|new Function)/;
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  add('purity/no-nondeterminism-or-io-in-either-module', C, ({ sources }) => {
    for (const [name, src] of Object.entries(sources)) { const m = FORBIDDEN.exec(stripComments(src)); if (m) return `${name}.js uses ${m[0]}`; }
    return true;
  });
  add('purity/imports-are-local-and-minimal', C, ({ sources }) => {
    const imp = (src) => [...stripComments(src).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    return eqv([imp(sources.stats), imp(sources.rules).map((x) => (x.startsWith('data:') ? './stats.js' : x.startsWith('file:') ? './engine_support.js' : x))], [[], ['./stats.js', './engine_support.js']]);
  });
  add('purity/no-module-level-mutable-bindings', C, ({ sources }) => {
    for (const [name, src] of Object.entries(sources)) { const m = /^(let|var)\s/m.exec(stripComments(src)); if (m) return `${name}.js has a top-level ${m[1]}`; }
    return true;
  });
  add('purity/ascii-only', C, ({ sources }) => all(Object.entries(sources), ([name, src]) => { const i = [...src].findIndex((c) => c.charCodeAt(0) > 126 || (c.charCodeAt(0) < 32 && c !== '\n' && c !== '\r' && c !== '\t')); return i < 0 ? true : `${name}.js has a non-ASCII character at ${i}`; }));
  add('purity/public-api-present', C, ({ S, R }) => {
    const need = {
      S: ['STAT_ORDER', 'ROM_STAT_ORDER', 'NATURE_STATS', 'LIMITS', 'POINTS', 'calcHp', 'calcOtherRaw', 'calcStat', 'applyNature', 'builtinNature', 'resolveNature', 'natureMod', 'natureMismatches', 'computeStats',
        'HIDDEN_POWER_TYPES', 'hiddenPower', 'hiddenPowerIvs', 'maxPoints', 'evToPoints', 'pointsToEv', 'evsToPoints', 'pointsToEvs', 'sumStats', 'remaining', 'pointsBudget', 'evBudget', 'snapEvToMinimum', 'snapEvsToMinimum', 'pointsView', 'canonicalJSON', 'fnv1a32'],
      R: ['RULES_VERSION', 'DEFAULT_RULESET_ID', 'STRICT_RULESET_ID', 'MOVE_SOURCES', 'RULE_CODES', 'RULESET_LAYERS', 'BASE_RULESET_IDS', 'checkRuleset', 'resolveRuleset', 'rulesetFingerprint', 'lineageOf', 'learnsetOf', 'moveLegality',
        'legalMoves', 'effectiveIvs', 'effectiveEvs', 'battleLevel', 'battleStats', 'validateMon', 'validateTeam', 'blankRec'],
    };
    const miss = [...need.S.filter((k) => !(k in S)).map((k) => 'stats.' + k), ...need.R.filter((k) => !(k in R)).map((k) => 'rules.' + k)];
    return miss.length === 0 ? true : 'missing exports: ' + miss.join(', ');
  });

  return checks;
}

// ---------------------------------------------------------------------------------------------
// loading module variants from source text (data: URLs, nothing written to disk)
// ---------------------------------------------------------------------------------------------
const SRC = { stats: fs.readFileSync(STATS_PATH, 'utf8'), rules: fs.readFileSync(RULES_PATH, 'utf8') };
const dataUrl = (src) => 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
async function loadVariant(sources) {
  const statsUrl = dataUrl(sources.stats);
  const link = "from './stats.js'";
  if (sources.rules.split(link).length !== 2) throw new Error("rules.js no longer contains exactly one \"from './stats.js'\" import; update the loader");
  const supLink = "from './engine_support.js'";
  if (sources.rules.split(supLink).length !== 2) throw new Error("rules.js no longer contains exactly one \"from './engine_support.js'\" import; update the loader");
  const rulesSrc = sources.rules.replace(link, `from '${statsUrl}'`).replace(supLink, `from '${pathToFileURL(path.join(root, 'pokemonarena', 'js', 'engine_support.js')).href}'`);
  const S = await import(statsUrl), R = await import(dataUrl(rulesSrc));
  return { S, R, sources };
}
function runSuite(suite, ctxBase, only) {
  const results = [];
  for (const c of suite) {
    if (only && !(c.cost === 'cheap' || only.has(c.id))) continue;
    let r;
    const t0 = process.hrtime.bigint();
    try { r = c.fn(ctxBase); } catch (e) { r = `threw ${e && e.name}: ${e && e.message}`; }
    results.push({ id: c.id, ok: r === true, detail: r === true ? '' : String(r), ms: Number(process.hrtime.bigint() - t0) / 1e6 });
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// the mutants: { id, file, from, to, count, expect: [check ids that MUST fail] }
// ---------------------------------------------------------------------------------------------
const M = [];
const mut = (id, file, from, to, expect, count = 1) => M.push({ id, file, from, to, expect, count });
// ---- stats.js
mut('S01 HP constant +10 -> +9', 'stats', 'return idiv((2 * base + iv + idiv(ev, LIMITS.evDivisor)) * level, 100) + level + 10;', 'return idiv((2 * base + iv + idiv(ev, LIMITS.evDivisor)) * level, 100) + level + 9;', ['stats/golden/hp-ev0']);
mut('S02 other-stat constant +5 -> +6', 'stats', 'return idiv((2 * base + iv + idiv(ev, LIMITS.evDivisor)) * level, 100) + 5;', 'return idiv((2 * base + iv + idiv(ev, LIMITS.evDivisor)) * level, 100) + 6;', ['stats/golden/other-ev0']);
mut('S03 integer division rounds instead of floors', 'stats', 'return (a - (a % b)) / b;', 'return Math.round(a / b);', ['stats/golden/hp-ev0']);
mut('S04 EV divisor 4 -> 5', 'stats', 'evDivisor: 4, // only floor(EV/4) reaches the formula', 'evDivisor: 5, // only floor(EV/4) reaches the formula', ['stats/golden/hp-ev252']);
mut('S05 +nature x110 -> x111', 'stats', 'return idiv(stat * 110, 100);', 'return idiv(stat * 111, 100);', ['stats/golden/nature-plus']);
mut('S06 -nature x90 -> x89', 'stats', 'return idiv(stat * 90, 100);', 'return idiv(stat * 89, 100);', ['stats/golden/nature-minus']);
mut('S07 +nature rounds instead of floors', 'stats', 'return idiv(stat * 110, 100);', 'return Math.round(stat * 110 / 100);', ['stats/nature/floors-not-rounds']);
mut('S08 natureMod: raised and lowered swapped', 'stats', 'if (key === resolved.up) return 1;', 'if (key === resolved.up) return -1;', ['stats/natures/mod-matrix']);
mut('S09 HP is modified by the nature', 'stats', "if (key === 'hp') return calcHp(base, iv, ev, level);", "if (key === 'hp') return applyNature(calcHp(base, iv, ev, level), mod);", ['stats/nature/hp-ignores-nature']);
mut('S10 builtin nature layout: up/down swapped', 'stats', 'return { id, up: NATURE_STATS[idiv(id, 5)], down: NATURE_STATS[id % 5] };', 'return { id, up: NATURE_STATS[id % 5], down: NATURE_STATS[idiv(id, 5)] };', ['stats/natures/builtin-chart', 'stats/natures/mod-matrix']);
mut('S11 natureMod ignores neutral natures', 'stats', 'if (resolved.up === resolved.down) return 0;', '', ['stats/natures/mod-matrix']);
mut('S12 Shedinja rule keyed on the wrong HP', 'stats', 'opts.fixedHp1 !== false && b === 1', 'opts.fixedHp1 !== false && b === 2', ['stats/shedinja/hp-is-one']);
mut('S13 Shedinja rule removed', 'stats', '(opts.fixedHp1 !== false && b === 1) ? 1 : calcHp(b, i, e, level)', 'calcHp(b, i, e, level)', ['stats/shedinja/hp-is-one']);
mut('S14 Hidden Power type uses the second IV bit', 'stats', 'typeBits += (v & 1) * (1 << i);', 'typeBits += ((v >> 1) & 1) * (1 << i);', ['stats/hidden-power/all-64-type-words', 'stats/hidden-power/type-bit-order-is-rom-order']);
mut('S15 Hidden Power power uses the third IV bit', 'stats', 'powerBits += ((v >> 1) & 1) * (1 << i);', 'powerBits += ((v >> 2) & 1) * (1 << i);', ['stats/hidden-power/power-bit-order-and-formula']);
mut('S16 Hidden Power reads stats in UI order, not ROM order', 'stats', 'const v = nonNeg(`ivs.${ROM_STAT_ORDER[i]}`, ivs[ROM_STAT_ORDER[i]]);', 'const v = nonNeg(`ivs.${STAT_ORDER[i]}`, ivs[STAT_ORDER[i]]);', ['stats/hidden-power/type-bit-order-is-rom-order']);
mut('S17 Hidden Power power offset 30 -> 31', 'stats', 'idiv(powerBits * 40, 63) + 30', 'idiv(powerBits * 40, 63) + 31', ['stats/hidden-power/golden']);
mut('S18 Hidden Power type divisor 63 -> 64', 'stats', 'HIDDEN_POWER_TYPES[idiv(typeBits * 15, 63)]', 'HIDDEN_POWER_TYPES[idiv(typeBits * 15, 64)]', ['stats/hidden-power/golden']);
mut('S19 Hidden Power list: Dark and Steel swapped', 'stats', "Object.freeze({ index: 7, name: 'Steel', id: 9 }),", "Object.freeze({ index: 7, name: 'Dark', id: 9 }),", ['stats/hidden-power/types-match-rom-names']);
mut('S20 pointsToEv: flat 8 per point (not 4-then-8)', 'stats', 'const ev = LIMITS.evDivisor * (2 * points - (iv & 1));', 'const ev = LIMITS.evDivisor * (2 * points);', ['stats/points/official-conversion-pins']);
mut('S21 evToPoints ignores the IV parity', 'stats', 'return idiv(idiv(ev, LIMITS.evDivisor) + (iv & 1), 2);', 'return idiv(idiv(ev, LIMITS.evDivisor), 2);', ['stats/points/evToPoints-is-the-brute-force-stat-gain']);
mut('S22 pointsToEv: no EV-byte guard', 'stats', 'if (ev > LIMITS.evMax) throw new RangeError', 'if (false) throw new RangeError', ['stats/points/range-guard']);
mut('S23 snap returns the input EV', 'stats', 'if (calcStat(ctx.stat, ctx.base, ctx.iv, e, ctx.level, ctx.mod || 0) === target) return e;', 'if (calcStat(ctx.stat, ctx.base, ctx.iv, e, ctx.level, ctx.mod || 0) === target) return ev;', ['stats/snap/pins']);
mut('S24 snap compares the raw stat, not the final one', 'stats', 'if (calcStat(ctx.stat, ctx.base, ctx.iv, e, ctx.level, ctx.mod || 0) === target) return e;', 'if (calcStat(ctx.stat, ctx.base, ctx.iv, e, ctx.level, 0) === calcStat(ctx.stat, ctx.base, ctx.iv, ev, ctx.level, 0)) return e;', ['stats/snap/uses-the-final-stat-not-the-raw-one']);
mut('S25 pointsBudget: over at equality', 'stats', "return { unit: 'points', used, total, remaining: remaining(total, used), over: used > total };", "return { unit: 'points', used, total, remaining: remaining(total, used), over: used >= total };", ['stats/points/budgets-and-remaining']);
mut('S26 evBudget: over at equality', 'stats', "return { unit: 'ev', used, total, remaining: remaining(total, used), over: used > total };", "return { unit: 'ev', used, total, remaining: remaining(total, used), over: used >= total };", ['stats/points/budgets-and-remaining']);
mut('S27 remaining sign flipped', 'stats', 'return total - used;', 'return used - total;', ['stats/points/budgets-and-remaining']);
mut('S28 canonicalJSON: keys not sorted', 'stats', 'const keys = Object.keys(value).sort();', 'const keys = Object.keys(value);', ['stats/canonical/json']);
mut('S29 canonicalJSON: -0 kept', 'stats', "return Object.is(value, -0) ? '0' : String(value);", "return Object.is(value, -0) ? '-0' : String(value);", ['stats/canonical/json']);
mut('S30 FNV prime changed', 'stats', 'Math.imul(h, 0x01000193)', 'Math.imul(h, 0x01000194)', ['stats/canonical/fnv1a32-known-vectors']);
mut('S31 non-negative guard allows -1', 'stats', 'if (!Number.isInteger(v) || v < 0) throw', 'if (!Number.isInteger(v) || v < -1) throw', ['stats/input-validation']);
mut('S32 level upper bound 100 -> 101', 'stats', '|| v > LIMITS.levelMax) {', '|| v > LIMITS.levelMax + 1) {', ['stats/input-validation']);
mut('S33 hiddenPowerIvs: lowest IV total instead of highest', 'stats', 'if (a > b) { best = t; continue; }', 'if (a < b) { best = t; continue; }', ['stats/hidden-power/ivs-pins']);
mut('S34 EV total limit 510 -> 511', 'stats', 'evTotalMax: 510, // main-series total EV cap', 'evTotalMax: 511, // main-series total EV cap', ['stats/constants/orders-match-tables-js']);
mut('S35 a clock sneaks into stats.js', 'stats', 'export function sumStats(obj) {\n  let s = 0;', 'export function sumStats(obj) {\n  let s = Date.now() * 0;', ['purity/no-nondeterminism-or-io-in-either-module']);
mut('S36 pointsView: minimal EVs ignored', 'stats', 'const minEvs = pointsToEvs(points, ivs);', 'const minEvs = evs;', ['stats/points/keyed-converters-and-view']);
mut('S37 maxPoints off by one', 'stats', 'return evToPoints(LIMITS.evMax, iv);', 'return evToPoints(LIMITS.evMax, iv) + 1;', ['stats/points/even-iv-costs-eight']);
mut('S38 computeStats: HP uses the SpA IV', 'stats', "const b = base[k], i = ivs[k], e = evs[k];", "const b = base[k], i = k === 'hp' ? ivs.spa : ivs[k], e = evs[k];", ['stats/computeStats/matches-bigint-for-every-species']);
// ---- rules.js
mut('R01 EV total: > cap becomes >= cap', 'rules', 'if (total > R.ev.total) add', 'if (total >= R.ev.total) add', ['rules/valid/boundary-table']);
mut('R02 stat blocks: > hi becomes >= hi', 'rules', '|| v > hi) { add(codes.range', '|| v >= hi) { add(codes.range', ['rules/valid/boundary-table']);
mut('R03 stat blocks: < lo becomes <= lo', 'rules', '!Number.isInteger(v) || v < lo ||', '!Number.isInteger(v) || v <= lo ||', ['rules/valid/boundary-table']);
mut('R04 level lower bound strict', 'rules', 'lv >= R.level.min && lv <= R.level.max;', 'lv > R.level.min && lv <= R.level.max;', ['rules/valid/boundary-table']);
mut('R05 level upper bound strict', 'rules', 'lv >= R.level.min && lv <= R.level.max;', 'lv >= R.level.min && lv < R.level.max;', ['rules/valid/boundary-table']);
mut('R06 nature bound: >= limit becomes > limit', 'rules', 'nat >= natLimit', 'nat > natLimit', ['rules/valid/boundary-table']);
mut('R07 ability slot upper bound 2 -> 3', 'rules', 'slot < 0 || slot > 2) add', 'slot < 0 || slot > 3) add', ['rules/valid/boundary-table']);
mut('R08 slot-disallowed check dropped', 'rules', 'else if (!R.ability.slots.includes(slot))', 'else if (false)', ['rules/valid/custom-knobs']);
mut('R09 slot-empty check dropped', 'rules', 'if (!ab) add(', 'if (false) add(', ['rules/valid/boundary-table']);
mut('R10 item bound: >= length becomes > length', 'rules', 'item >= pack.items.length) add', 'item > pack.items.length) add', ['rules/valid/boundary-table']);
mut('R12 moves.count max: > becomes >=', 'rules', 'mv.length > R.moves.max) add', 'mv.length >= R.moves.max) add', ['rules/valid/boundary-table']);
mut('R13 moves.count min: < becomes <=', 'rules', 'mv.length < R.moves.min ||', 'mv.length <= R.moves.min ||', ['rules/valid/boundary-table']);
mut('R14 duplicate move check dropped', 'rules', 'if (seen.has(id)) { if (!R.moves.duplicates)', 'if (false) { if (!R.moves.duplicates)', ['rules/valid/boundary-table']);
mut('R15 duplicates option ignored', 'rules', 'if (!R.moves.duplicates) add', 'if (true) add', ['rules/valid/custom-knobs']);
mut('R16 move id 0 counts as a known move', 'rules', 'Number.isInteger(id) && id >= 1 && id < pack.moves.length', 'Number.isInteger(id) && id >= 0 && id < pack.moves.length', ['rules/valid/boundary-table']);
mut('R17 move id range: < length becomes <= length (both guards)', 'rules', 'id >= 1 && id < pack.moves.length && pack.moves[id] != null', 'id >= 1 && id <= pack.moves.length', ['rules/valid/boundary-table']);
mut('R18 level gate: <= becomes <', 'rules', 'else if (R.moves.levelGate && e.levelUp > level) needLevel = e.levelUp;', 'else if (R.moves.levelGate && e.levelUp >= level) needLevel = e.levelUp;', ['rules/legal/level-gate-boundary']);
mut('R19 level gate never applies', 'rules', 'else if (R.moves.levelGate && e.levelUp > level) needLevel = e.levelUp;', 'else if (false) needLevel = e.levelUp;', ['rules/legal/level-gate-boundary']);
mut('R20 lineage switch ignored (always own species only)', 'rules', 'const ids = lineage ? lineageOf(pack, speciesId) : [speciesId];', 'const ids = [speciesId];', ['rules/legal/lineage-brings-egg-and-prevo-moves']);
mut('R21 egg moves not collected', 'rules', 'for (const mv of s.eggMoves) entry(mv, id).egg = true;', '', ['rules/legal/lineage-brings-egg-and-prevo-moves', 'rules/legal/own-species-sources-agree-with-tables-js']);
mut('R22 machine/tutor classification swapped', 'rules', 'if (machineMoves.has(mv)) e.machine = true; else e.tutor = true;', 'if (machineMoves.has(mv)) e.tutor = true; else e.machine = true;', ['rules/legal/source-toggles']);
mut('R23 forms do not borrow their base form lineage', 'rules', 'pres = predecessors(pack, s.forms[0]);', 'pres = [];', ['rules/legal/forms-borrow-their-base-form-lineage']);
mut('R24 predecessors: wrong edge direction', 'rules', 's.evolutions.some((e) => e.target === id)', 's.evolutions.some((e) => e.target === id + 1)', ['rules/legal/lineage-pins']);
mut('R25 lowest level-up level not taken', 'rules', 'if (e.levelUp === null || lv < e.levelUp) e.levelUp = lv;', 'if (e.levelUp === null || lv > e.levelUp) e.levelUp = lv;', ['rules/legal/level-gate-boundary']);
mut('R26 disabled sources ignored (everything allowed)', 'rules', "if (R.moves.sources.includes(s)) have.push(s); else disabled = true;", 'have.push(s);', ['rules/legal/source-toggles']);
mut('R27 disabled level-up source ignored', 'rules', "if (!R.moves.sources.includes('levelUp')) disabled = true;", 'if (false) disabled = true;', ['rules/legal/source-toggles']);
mut('R28 legalMoves lists banned moves', 'rules', '|| R.banned.moves.includes(id)) continue;', '|| false) continue;', ['rules/legal/legalMoves-is-the-set-moveLegality-accepts']);
mut('R29 species clause keyed on species id', 'rules', 'const key = sp.natDex;', 'const key = sid;', ['rules/team/species-clause-by-dex-number', 'rules/matrix/every-code-fires-on-its-bad-input-and-stays-silent-on-the-good-twin']);
mut('R30 species clause always on', 'rules', 'if (R.team.speciesClause) {', 'if (true) {', ['rules/team/species-clause-by-dex-number']);
mut('R31 item clause counts empty slots', 'rules', 'if (Number.isInteger(item) && item > 0) (items.get(item)', 'if (Number.isInteger(item) && item >= 0) (items.get(item)', ['rules/team/item-clause']);
mut('R32 item clause always on', 'rules', 'if (R.team.itemClause) {', 'if (true) {', ['rules/team/item-clause']);
mut('R33 team size: > max becomes >= max', 'rules', 'team.length > R.team.max) add', 'team.length >= R.team.max) add', ['rules/team/size-boundaries']);
mut('R34 team members validated without a cap', 'rules', 'const n = Math.min(team.length, R.team.max);', 'const n = team.length;', ['rules/wire/junk-never-throws']);
mut('R35 points.ev-mismatch check dropped', 'rules', 'if (evVals[k] !== want) add(', 'if (false) add(', ['rules/valid/boundary-table']);
mut('R36 points total: > cap becomes >= cap', 'rules', 'if (total > R.points.total) add', 'if (total >= R.points.total) add', ['rules/valid/boundary-table']);
mut('R37 points mode switched off', 'rules', '  if (R.points) {\n    const ptBlock', '  if (false) {\n    const ptBlock', ['rules/valid/boundary-table']);
mut('R38 fixed IV not enforced', 'rules', 'else if (fixed !== null && fixed !== undefined && v !== fixed)', 'else if (false)', ['rules/valid/boundary-table']);
mut('R39 fixed level not enforced', 'rules', 'else if (R.level.fixed !== null && lv !== R.level.fixed)', 'else if (false)', ['rules/valid/boundary-table']);
mut('R40 strict layer keeps the 510 EV cap', 'rules', 'r.ev = { perStat: LIMITS.evMax, total: null };', 'r.ev = { perStat: LIMITS.evMax, total: LIMITS.evTotalMax };', ['rules/valid/baselines-ok', 'rules/ruleset/layer-pins']);
mut('R41 strict per-stat points 32 -> 33', 'rules', 'r.points = { perStat: POINTS.perStat, total: POINTS.total };', 'r.points = { perStat: POINTS.perStat + 1, total: POINTS.total };', ['rules/ruleset/layer-pins']);
mut('R42 banned species not enforced', 'rules', 'else if (R.banned.species.includes(sid))', 'else if (false)', ['rules/valid/banned-lists']);
mut('R43 banned abilities not enforced', 'rules', 'else if (R.banned.abilities.includes(ab))', 'else if (false)', ['rules/valid/banned-lists']);
mut('R44 banned items not enforced', 'rules', 'else if (item !== 0 && R.banned.items.includes(item))', 'else if (false)', ['rules/valid/banned-lists']);
mut('R45 banned moves not enforced', 'rules', 'if (R.banned.moves.includes(id)) add(', 'if (false) add(', ['rules/valid/banned-lists']);
mut('R46 malformed rulesets accepted', 'rules', 'if (problems.length) throw new TypeError(`malformed ruleset', 'if (false) throw new TypeError(`malformed ruleset', ['rules/ruleset/malformed-is-refused']);
mut('R47 own() reads inherited properties', 'rules', 'hasOwn.call(o, k) ? o[k] : undefined', 'k in o ? o[k] : undefined', ['rules/valid/inherited-and-proto-fields-ignored']);
mut('R48 -0 not normalised', 'rules', 'const num = (v) => (Object.is(v, -0) ? 0 : v);', 'const num = (v) => v;', ['rules/valid/negative-zero-is-zero']);
mut('R49 layer conflicts not detected', 'rules', 'for (const c of LAYERS[ly].conflicts) if (layers.includes(c)) throw', 'for (const c of []) if (layers.includes(c)) throw', ['rules/ruleset/ids-canonical-and-errors']);
mut('R50 prototype keys accepted as base ruleset ids', 'rules', 'if (!hasOwn.call(BASES, baseId)) throw', 'if (!(baseId in BASES)) throw', ['rules/ruleset/ids-canonical-and-errors']);
mut('R51 layers not put in canonical order', 'rules', 'const ordered = LAYER_ORDER.filter((ly) => layers.includes(ly));', 'const ordered = layers;', ['rules/ruleset/ids-canonical-and-errors']);
mut('R52 evs always required (even in points mode)', 'rules', 'if (evBlock === undefined && R.points) {', 'if (false) {', ['rules/valid/boundary-table']);
mut('R53 ivs always required (even when fixed)', 'rules', 'if (ivBlock === undefined && R.iv.fixed !== null) {', 'if (false) {', ['rules/valid/boundary-table']);
mut('R54 item must be present', 'rules', 'const item = itemRaw === undefined ? 0 : num(itemRaw);\n  if (!Number.isInteger(item) || item < 0 || item >= pack.items.length)', 'const item = num(itemRaw);\n  if (!Number.isInteger(item) || item < 0 || item >= pack.items.length)', ['rules/valid/boundary-table']);
mut('R55 nature bound ignores the ruleset count', 'rules', 'const natLimit = Math.min(R.nature.count, pack.natures.length);', 'const natLimit = pack.natures.length;', ['rules/valid/custom-knobs']);
mut('R56 effectiveIvs ignores a fixed IV', 'rules', 'R.iv.fixed !== null ? R.iv.fixed : num(rec.ivs[k])', 'num(rec.ivs[k])', ['rules/battle/effective-values']);
mut('R57 battleLevel ignores normalisation', 'rules', 'return R.level.battle !== null ? R.level.battle : num(rec.level);', 'return num(rec.level);', ['rules/battle/battle-level-normalisation']);
mut('R58 effectiveEvs ignores points', 'rules', 'R.points ? pointsToEv(num(rec.points[k]), R.iv.fixed) : num(rec.evs[k])', 'num(rec.evs[k])', ['rules/battle/effective-values']);
mut('R59 invalid level still gates moves', 'rules', 'if (spOk && lvInRange) {', 'if (spOk) {', ['rules/valid/no-cascade-from-invalid-level-or-species']);
mut('R60 invalid species still checked for abilities', 'rules', '  else if (spOk) {\n    const ab = sp.abilities[slot];', '  else if (sp) {\n    const ab = sp.abilities[slot];', ['rules/valid/no-cascade-from-invalid-level-or-species']);
mut('R61 species.illegal reported as legal', 'rules', 'else if (!sp.legal) add(', 'else if (false) add(', ['rules/valid/illegal-species-slots']);
mut('R62 move count cap 16 removed (unbounded per-move work)', 'rules', 'i < Math.min(mv.length, 16)', 'i < mv.length', ['rules/wire/junk-never-throws']);
mut('R63 learnset reads the wrong table for tutor moves', 'rules', 'for (const mv of s.teachable) {', 'for (const mv of s.eggMoves) {', ['rules/legal/known-legal-and-illegal-moves']);
mut('R64 blankRec ignores the fixed level', 'rules', 'const level = R.level.fixed !== null ? R.level.fixed : R.level.max;', 'const level = R.level.max;', ['rules/battle/blankRec-valid-for-every-species-and-preset']);
mut('R71 form lineage fallback applied even when the form has its own predecessors', 'rules', 'if (pres.length === 0) {', 'if (pres.length >= 0) {', ['rules/legal/lineage-matches-independent-oracle']);
mut('R72 pre-evolution TMs/tutors ignored (own species only)', 'rules', 'for (const mv of s.teachable) {', 'if (id === speciesId) for (const mv of s.teachable) {', ['rules/legal/learnsets-match-independent-oracle']);
mut('R73 points.ev-mismatch checked for HP only', 'rules', 'for (const k of STAT_ORDER) {\n            const want = pointsToEv(pv[k], R.iv.fixed);', "for (const k of ['hp']) {\n            const want = pointsToEv(pv[k], R.iv.fixed);", ['rules/differential/validateMon-vs-independent-oracle']);
mut('R74 move legality skipped for the 4th move onwards (only the first three are judged)', 'rules', 'if (spOk && lvInRange) {', 'if (spOk && lvInRange && i < 3) {', ['rules/valid/boundary-table']);
mut('R65 clause reasons dropped from the flat list', 'rules', 'const flat = list.slice();', 'const flat = [];', ['rules/team/species-clause-by-dex-number']);
mut('R66 per-mon reason paths not prefixed', 'rules', "path: `mons[${m.index}]${r.path ? '.' + r.path : ''}`", 'path: r.path', ['rules/team/paths-flattening-and-order']);
mut('R67 Math.random used by rules.js', 'rules', 'export function lineageOf(pack, speciesId) {\n  const seen', 'export function lineageOf(pack, speciesId) {\n  void Math.random();\n  const seen', ['purity/no-nondeterminism-or-io-in-either-module']);
mut('R68 rules.js grows a node: import', 'rules', "import {\n  STAT_ORDER", "import fs from 'node:fs';\nimport {\n  STAT_ORDER", ['purity/imports-are-local-and-minimal']);
mut('R69 module-level mutable state added', 'rules', 'export const RULES_VERSION = 1;', 'export const RULES_VERSION = 1;\nlet counter = 0;', ['purity/no-module-level-mutable-bindings']);
mut('S39 builtinNature accepts id 25', 'stats', 'if (!Number.isInteger(id) || id < 0 || id > 24) throw', 'if (!Number.isInteger(id) || id < 0 || id > 25) throw', ['stats/natures/id-guards']);
mut('S40 hiddenPowerIvs accepts type index 16', 'stats', 'if (!Number.isInteger(idx) || idx < 0 || idx > 15) throw', 'if (!Number.isInteger(idx) || idx < 0 || idx > 16) throw', ['stats/hidden-power/ivs-guards']);
mut('R75 level is coerced to a number (strings and booleans accepted)', 'rules', "const lv = num(own(rec, 'level'));", "const lv = Number(num(own(rec, 'level')));", ['rules/valid/types-are-strict']);
mut('R76 a missing moves field is not reported', 'rules', "if (!Array.isArray(mv)) add('moves.shape'", "if (mv !== undefined && !Array.isArray(mv)) add('moves.shape'", ['rules/valid/missing-top-level-fields']);
mut('R77 a rule code is added with no matrix case', 'rules', "'rec.shape': 'the record is not an object',", "'rec.extra': 'a code nobody tests',\n  'rec.shape': 'the record is not an object',", ['rules/valid/catalogue-covers-every-code']);
mut('R78 a non-array team is only rejected when null', 'rules', 'if (!Array.isArray(team)) {', 'if (team == null) {', ['rules/team/shape']);
mut('R79 stat blocks are walked in the caller key order', 'rules', 'for (const k of STAT_ORDER) {\n    const v = num(own(block, k));', 'for (const k of Object.keys(block).filter((x) => STAT_ORDER.includes(x))) {\n    const v = num(own(block, k));', ['determinism/key-order-and-json-roundtrip']);
mut('R80 blankRec is renamed (public API changed)', 'rules', 'export function blankRec(speciesId, pack, ruleset) {', 'export function blankRecX(speciesId, pack, ruleset) {', ['purity/public-api-present']);
mut('R70 a non-ASCII character sneaks in', 'rules', '// pokemonarena/js/rules.js -- rulesets', '// pokemonarena/js/rules.js \u2014 rulesets', ['purity/ascii-only']);

// ---------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------
// data mutants: the same suite against a damaged PACK and a damaged ROM image (a pin that no data change can trip is decoration too)
// ---------------------------------------------------------------------------------------------
const PM = [];
const pmut = (id, edit, expect) => PM.push({ id, edit, expect });
const nameToMove = (p, n) => p.moves.find((m) => m.name === n).id;
pmut('P01 a nature in the pack lowers the wrong stat', (p) => { p.natures[3].down = 'spd'; }, ['stats/natures/rom-table-matches-chart', 'stats/natures/mismatch-detector']);
pmut('P02 Shedinja gets base HP 2', (p) => { p.species[292].baseStats.hp = 2; }, ['stats/shedinja/hp-is-one', 'stats/shedinja/only-base-hp-1-species']);
pmut('P03 a second species gets base HP 1', (p) => { p.species[132].baseStats.hp = 1; }, ['stats/shedinja/only-base-hp-1-species']);
pmut('P04 the pack lists Hidden Power at power 61', (p) => { p.moves[237].power = 61; }, ['stats/hidden-power/rom-move-fact-and-fixed-power-option']);
pmut('P05 a type name differs from the Hidden Power table', (p) => { p.types[2].name = 'Fightng'; }, ['stats/hidden-power/types-match-rom-names']);
pmut('P06 Garchomp base Attack 131', (p) => { p.species[445].baseStats.atk = 131; }, ['stats/computeStats/garchomp-from-pack', 'rules/battle/stats-at-the-battle-level']);
pmut('P07 Pikachu loses Thunder Wave (level-up and TM)', (p) => { const m = nameToMove(p, 'Thunder Wave'); p.species[25].levelUp = p.species[25].levelUp.filter((e) => e[0] !== m); p.species[25].teachable = p.species[25].teachable.filter((x) => x !== m); p.species[172].levelUp = p.species[172].levelUp.filter((e) => e[0] !== m); p.species[172].teachable = p.species[172].teachable.filter((x) => x !== m); }, ['rules/legal/known-legal-and-illegal-moves']);
pmut('P08 Pikachu gains Hydro Pump', (p) => { p.species[25].teachable = [...p.species[25].teachable, nameToMove(p, 'Hydro Pump')]; }, ['rules/legal/known-legal-and-illegal-moves']);
pmut('P09 Charmander loses its egg moves', (p) => { p.species[4].eggMoves = []; }, ['rules/legal/lineage-brings-egg-and-prevo-moves']);
pmut('P10 Gabite no longer evolves into Garchomp', (p) => { p.species[444].evolutions = []; }, ['rules/legal/lineage-pins']);
pmut('P11 Take Down moves to level 55 for the whole Gible line', (p) => { for (const id of [443, 444, 445]) p.species[id].levelUp = p.species[id].levelUp.map(([m, l]) => (m === nameToMove(p, 'Take Down') ? [m, 55] : [m, l])); }, ['rules/legal/level-gate-boundary']);
pmut('P12 a Garchomp form gets another Pokedex number', (p) => { p.species[947].natDex = 9999; }, ['rules/team/species-clause-by-dex-number']);
pmut('P13 Garchomp gains an ability in slot 1', (p) => { p.species[445].abilities[1] = 8; }, ['rules/valid/boundary-table']);
pmut('P14 Ditto learns Tackle', (p) => { p.species[132].levelUp = [...p.species[132].levelUp, [nameToMove(p, 'Tackle'), 1]]; }, ['rules/legal/ditto-only-transform']);
pmut('P15 the item table loses its last entry', (p) => { p.items.pop(); }, ['rules/valid/boundary-table']);
pmut('P16 the machine table loses Surf', (p) => { p.machines = p.machines.filter((m) => m.move !== nameToMove(p, 'Surf')); }, ['rules/legal/source-toggles']);
pmut('P17 Pikachu no longer evolves from Pichu', (p) => { p.species[172].evolutions = []; }, ['rules/legal/lineage-pins']);
pmut('P18 Garchomp gains Thunderbolt by TM', (p) => { p.species[445].teachable = [...p.species[445].teachable, nameToMove(p, 'Thunderbolt')]; }, ['rules/legal/known-legal-and-illegal-moves']);
const RM = [];
const rmut = (id, off, byte, expect) => RM.push({ id, off, byte, expect });
rmut('X01 the +nature multiplier immediate 110 -> 111', 0x1edae8, 111, ['rom/code/nature-multipliers-110-and-90-over-100']);
rmut('X02 the -nature multiplier immediate 90 -> 91', 0x1edaf8, 91, ['rom/code/nature-multipliers-110-and-90-over-100']);
rmut('X03 the divisor 100 -> 101 in the non-HP stat', 0x1ed9f6, 101, ['rom/code/non-hp-stat-is-2b-plus-iv-plus-ev-over-4-times-level-over-100-plus-5']);
rmut('X04 the non-HP constant +5 -> +6', 0x1eda14, 6, ['rom/code/non-hp-stat-is-2b-plus-iv-plus-ev-over-4-times-level-over-100-plus-5']);
rmut('X05 the HP constant +10 -> +11', 0x1eda7e, 11, ['rom/code/hp-is-the-same-sum-times-level-over-100-plus-level-plus-10']);
rmut('X06 the special-cased species 292 -> 294', 0x1eda48, 147, ['rom/code/species-292-is-special-cased-to-hp-1']);
rmut('X07 the nature table pointer in the literal pool', 0x1edb4c, 0xad, ['rom/code/stat-routine-reads-the-tables-tables-js-decodes']);
rmut('X08 the species table pointer in the literal pool', 0x1edb59, 0x7c, ['rom/code/stat-routine-reads-the-tables-tables-js-decodes']);
rmut('X09 the first opcode of the routine changed', 0x1ed921, 0xb4, ['rom/code/stat-routine-starts-where-expected']);

async function main() {
  const suite = defineSuite();
  const ids = suite.map((c) => c.id);
  head('A. SUITE on the real modules (' + suite.length + ' named checks; ROM pack decoded in ' + packMs.toFixed(0) + ' ms)');
  t('check ids are unique', new Set(ids).size === ids.length);
  const real = { S: STATS0, R: RULES0, sources: SRC, pack, rom };
  const t0 = Date.now();
  const realResults = runSuite(suite, real);
  for (const r of realResults) t(r.id, r.ok ? true : r.detail);
  console.log(`  info suite wall time ${Date.now() - t0} ms; heavy checks: ${suite.filter((c) => c.cost === 'heavy').map((c) => c.id).join(', ')}`);
  const cheapMs = realResults.filter((r) => suite.find((c) => c.id === r.id).cost === 'cheap').reduce((a, r) => a + r.ms, 0);
  console.log(`  info the ${realResults.filter((r) => suite.find((c) => c.id === r.id).cost === 'cheap').length} cheap checks take ${cheapMs.toFixed(0)} ms in total (re-run once per mutant); slowest: ${realResults.filter((r) => suite.find((c) => c.id === r.id).cost === 'cheap').sort((a, b) => b.ms - a.ms).slice(0, 4).map((r) => r.id + ' ' + r.ms.toFixed(0) + 'ms').join(', ')}`);

  head('B. TWIN: the unmutated source through the mutant loader');
  const twin = await loadVariant({ stats: SRC.stats, rules: SRC.rules });
  const twinResults = runSuite(suite, { ...twin, pack, rom });
  const twinFail = twinResults.filter((r) => !r.ok);
  t(`the unedited twin passes all ${twinResults.length} checks (loader adds no behaviour)`, twinFail.length === 0, twinFail.map((r) => r.id + ': ' + r.detail).join(' | '));
  t('twin and real modules give the same validation output for 30 fixed records', (() => {
    const recs = [garch(), garchStrict(), { ...garch(), level: 0 }, { ...garch(), moves: [1, 1] }, 'x', null];
    const run = (R) => J(PRESETS.map((rs) => recs.map((r) => R.validateMon(r, pack, rs))));
    return run(twin.R) === run(RULES0);
  })());

  head('C. SOURCE MUTANTS (' + M.length + '): each must make its NAMED check(s) fail; the twin above stays silent');
  const idSet = new Set(ids);
  const trippedBy = new Map(); // check id -> the first mutant that made it fail
  const note = (mid, failedIds) => { for (const f of failedIds) if (!trippedBy.has(f)) trippedBy.set(f, mid); };
  let caught = 0;
  const bad = [];
  const extraTrips = [];
  const mutMs = [];
  for (const m of M) {
    const tm0 = Date.now();
    const nameOk = m.expect.every((e) => idSet.has(e));
    if (!nameOk) { t(`${m.id}: expected check names exist`, false, m.expect.filter((e) => !idSet.has(e)).join(', ')); continue; }
    const src = SRC[m.file];
    const hits = src.split(m.from).length - 1;
    if (hits !== m.count) { t(`${m.id}: mutation target found ${m.count}x in ${m.file}.js`, false, `found ${hits}x: ${JSON.stringify(m.from.slice(0, 80))}`); continue; }
    const mutated = { stats: SRC.stats, rules: SRC.rules };
    mutated[m.file] = src.split(m.from).join(m.to);
    let variant;
    try { variant = await loadVariant(mutated); } catch (e) { t(`${m.id}: mutant loads`, false, e.message.split('\n')[0]); continue; }
    const res = runSuite(suite, { ...variant, pack, rom }, new Set(m.expect));
    const failedIds = res.filter((r) => !r.ok).map((r) => r.id);
    note(m.id, failedIds);
    const missed = m.expect.filter((e) => !failedIds.includes(e));
    if (missed.length === 0) { caught++; t(`${m.id}  -> caught by ${m.expect.join(' + ')}`, true); }
    else { bad.push(m.id); t(`${m.id}: NOT caught by ${missed.join(', ')}`, false, failedIds.length ? `it did trip: ${failedIds.slice(0, 4).join(', ')}` : 'it tripped nothing'); }
    mutMs.push([m.id, Date.now() - tm0]);
    const others = failedIds.filter((x) => !m.expect.includes(x));
    if (others.length) extraTrips.push(`${m.id}: also ${others.length} (${others.slice(0, 3).join(', ')}${others.length > 3 ? ', ...' : ''})`);
  }
  t(`all ${M.length} source mutants caught (${caught} caught)`, caught === M.length, bad.join(', '));
  console.log(`  info slowest source mutants (they run a named heavy check): ${mutMs.sort((a, b) => b[1] - a[1]).slice(0, 5).map(([i, ms]) => i.split(' ')[0] + ' ' + ms + 'ms').join(', ')}; median ${mutMs.map((x) => x[1]).sort((a, b) => a - b)[Math.floor(mutMs.length / 2)]} ms`);
  console.log(`  info source mutants that also tripped checks beyond their named ones: ${extraTrips.length} of ${M.length} (the rest tripped exactly what they named)`);

  head('C2. DATA MUTANTS: a damaged pack (' + PM.length + ') and a damaged ROM image (' + RM.length + ') against the unedited modules');
  let dataCaught = 0;
  const dataBad = [];
  for (const m of PM) {
    if (!m.expect.every((e) => idSet.has(e))) { t(`${m.id}: expected check names exist`, false, m.expect.filter((e) => !idSet.has(e)).join(', ')); continue; }
    const p2 = structuredClone(pack);
    m.edit(p2);
    const res = runSuite(suite, { S: STATS0, R: RULES0, sources: SRC, pack: p2, rom }, new Set(m.expect));
    const failedIds = res.filter((r) => !r.ok).map((r) => r.id);
    note(m.id, failedIds);
    const missed = m.expect.filter((e) => !failedIds.includes(e));
    if (missed.length === 0) { dataCaught++; t(`${m.id}  -> caught by ${m.expect.join(' + ')}`, true); } else { dataBad.push(m.id); t(`${m.id}: NOT caught by ${missed.join(', ')}`, false, `it did trip: ${failedIds.slice(0, 4).join(', ') || 'nothing'}`); }
  }
  for (const m of RM) {
    if (!m.expect.every((e) => idSet.has(e))) { t(`${m.id}: expected check names exist`, false, m.expect.filter((e) => !idSet.has(e)).join(', ')); continue; }
    const rom2 = Buffer.from(rom);
    const before = rom2[m.off];
    rom2[m.off] = m.byte;
    if (before === m.byte) { t(`${m.id}: the edit changes a byte`, false, `byte at 0x${m.off.toString(16)} is already 0x${m.byte.toString(16)}`); continue; }
    const res = runSuite(suite, { S: STATS0, R: RULES0, sources: SRC, pack, rom: rom2 }, new Set(m.expect));
    const failedIds = res.filter((r) => !r.ok).map((r) => r.id);
    note(m.id, failedIds);
    const missed = m.expect.filter((e) => !failedIds.includes(e));
    if (missed.length === 0) { dataCaught++; t(`${m.id}  -> caught by ${m.expect.join(' + ')}`, true); } else { dataBad.push(m.id); t(`${m.id}: NOT caught by ${missed.join(', ')}`, false, `it did trip: ${failedIds.slice(0, 4).join(', ') || 'nothing'}`); }
  }
  t(`all ${PM.length + RM.length} data mutants caught (${dataCaught} caught)`, dataCaught === PM.length + RM.length, dataBad.join(', '));

  head('C3. no decoration: every check must have been seen to FAIL under at least one mutant');
  const never = ids.filter((i) => !trippedBy.has(i));
  t(`every one of the ${ids.length} checks was tripped by at least one mutant`, never.length === 0, 'never failed under any mutant: ' + never.join(', '));
  console.log(`  info checks tripped only as a side effect of other mutants (not named by any): ${ids.filter((i) => trippedBy.has(i) && !M.concat(PM, RM).some((m) => m.expect.includes(i))).length}`);

  head('D. DOCUMENTED FACTS the numbers above rest on');
  const m237 = pack.moves[237];
  console.log(`  info ROM Hidden Power move (id 237): type ${m237.type} (${pack.types[m237.type].name}), category ${m237.category}, power ${m237.power}, effect ${m237.effect}`);
  console.log('  info STAT FORMULA: located in the ROM by a static read of its Thumb code (function at file offset 0x1ed920): (2*base + IV + EV/4) * level / 100 + 5 (HP: + level + 10), nature x110/100 on the raised stat and x90/100 on the lowered one, species 292 forced to HP 1. Not executed: the rom/code/* checks pin what the decode showed.');
  console.log('  info NOT MODELLED: the routine also raises an IV to 31 when a per-stat "hyper trained" flag is set (a hack feature; stored in the mon, absent from the record). The editor/rules treat IVs as given.');
  console.log('  info Hidden Power power: stats.js returns the Gen 3 30..70 value by default; the ROM table says a fixed 60, so callers building a battle engine should pass { fixedPower: 60 } until a conformance run decides');

  head('E. determinism digest (what the browser run must reproduce)');
  const digest = digestFn(STATS0, RULES0, pack);
  const nodeHash = crypto.createHash('sha256').update(J(digest)).digest('hex');
  console.log(`  info digest sha256 ${nodeHash} over ${J(digest).length} chars`);
  t('digest is stable across two runs', J(digestFn(STATS0, RULES0, pack)) === J(digest));
  t('digest through the data: loader equals the real modules', J(digestFn(twin.S, twin.R, pack)) === J(digest));

  if (process.env.ARENA_BROWSER === '1') await browserParity(nodeHash, J(digest).length);
  else console.log('\n(browser parity skipped: set ARENA_BROWSER=1 with PORT=8093 node tools/devserver.mjs running)');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

// A self-contained function (no closure references) so it can be stringified into the browser page.
function digestFn(S, R, pack) {
  const out = {};
  out.stats = [S.calcHp(100, 31, 0, 50), S.calcStat('atk', 100, 31, 252, 50, 1), S.calcStat('atk', 100, 31, 252, 50, -1), S.calcHp(108, 31, 252, 100)];
  out.points = []; for (let p = 0; p <= 32; p++) out.points.push(S.pointsToEv(p));
  out.hp = [];
  for (let w = 0; w < 64; w++) { const ivs = {}; ['hp', 'atk', 'def', 'spe', 'spa', 'spd'].forEach((k, i) => { ivs[k] = 30 + ((w >> i) & 1); }); out.hp.push(S.hiddenPower(ivs)); }
  out.hpIvs = S.HIDDEN_POWER_TYPES.map((x) => S.hiddenPowerIvs(x.name));
  const ids = ['arena-gen3-standard', 'arena-gen3-standard+strict-champions', 'arena-gen3-standard+lv5', 'arena-gen3-standard+lv100', 'arena-gen3-standard+item-clause', 'arena-gen3-standard+no-species-clause'];
  out.rulesets = ids.map((id) => R.rulesetFingerprint(id));
  out.blank = [];
  for (const rsid of [ids[0], ids[1], ids[2]]) {
    for (const sid of [4, 6, 25, 132, 292, 445, 907, 150]) { // stage E1: 150 replaces 1553 (Raichu-Alola has no ability the battle engine runs, so blankRec refuses it)
      const rec = R.blankRec(sid, pack, rsid);
      out.blank.push({ rec, v: R.validateMon(rec, pack, rsid), st: R.battleStats(rec, pack, rsid) });
    }
  }
  out.legal = [4, 25, 132, 445].map((sid) => R.legalMoves(pack, sid, 50, ids[0]));
  out.lineage = [445, 25, 6, 1553, 907].map((sid) => R.lineageOf(pack, sid));
  out.team = R.validateTeam([R.blankRec(445, pack, ids[0]), R.blankRec(947, pack, ids[0]), { species: 1, junk: true }], pack, ids[0]);
  return out;
}

async function browserParity(nodeHash, nodeLen) {
  head('F. browser parity (headless Chrome, throwaway profile, bare CDP)');
  const base = process.env.ARENA_BASE || 'http://localhost:8093';
  try {
    const { withBrowser } = await import('./headless_cdp.mjs');
    const romUrl = base + '/gba/gbaWasm/roms/' + encodeURIComponent('Pokemon SoulGold (v1.1.1).gba');
    const probe = [
      '(async () => {',
      "  const T = await import('/pokemonarena/js/tables.js'); const S = await import('/pokemonarena/js/stats.js'); const R = await import('/pokemonarena/js/rules.js');",
      '  const buf = new Uint8Array(await (await fetch(' + J(romUrl) + ')).arrayBuffer());',
      '  const pack = await T.loadPackAsync(buf);',
      '  const out = (' + digestFn.toString() + ')(S, R, pack);',
      '  const json = JSON.stringify(out);',
      "  const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))), (x) => x.toString(16).padStart(2, '0')).join('');",
      '  const m = /HeadlessChrome\\/[0-9.]+/.exec(navigator.userAgent);',
      '  return { hash: h, len: json.length, ua: m ? m[0] : navigator.userAgent };',
      '})()',
    ].join('\n');
    const res = await withBrowser({ port: Number(process.env.ARENA_CDP_PORT || 9245), width: 800, height: 600 }, async (page) => {
      await page.navigate(base + '/pokemonarena/manifest.json');
      return page.eval(probe);
    });
    console.log(`  info ${res.ua}: digest ${res.hash} over ${res.len} chars`);
    t('the browser digest of stats.js + rules.js outputs equals the Node digest', res.hash === nodeHash && res.len === nodeLen, `browser ${res.hash}/${res.len}, node ${nodeHash}/${nodeLen}`);
  } catch (e) { t('browser parity run', false, e.message); }
}

main().catch((e) => { console.error(e); process.exit(1); });

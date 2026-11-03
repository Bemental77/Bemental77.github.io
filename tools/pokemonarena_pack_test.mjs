#!/usr/bin/env node
// POKEMONARENA ROM-DATA PACK TEST  (stage C1 / workstream R0)
//
// Proves that pokemonarena/js/{rom,charset,tables}.js decode the battle data of the pinned ROM
// (Pokemon SoulGold v1.1.1) correctly, and that the checks themselves can fail:
//
//   * IDENTITY    pure-JS SHA-256/MD5 against NIST/RFC vectors, node:crypto and the pinned hashes; a one-byte
//                 flip, a truncation and a header edit are each REFUSED by loadPack() AND by loadPackAsync() (the
//                 path a page calls), including with crypto.subtle absent (insecure-origin fallback).
//   * CHARSET     table properties, lossless decode->encode for arbitrary byte strings and for every string
//                 the ROM yields, every byte used by the ROM is in the verified CORE table.
//   * PACK        ~60 named checks (counts, spot values, learnsets, evolutions, TM/HM + tutor cross-checks,
//                 the 18x18 type chart diffed cell by cell against an embedded canonical Gen 6+ chart, ...).
//   * MUTANTS     every table region is corrupted one byte at a time; the run must trip the SPECIFIC check(s)
//                 named for that mutant and NO check outside the allowed family. A no-op "twin" mutant that
//                 goes through the same copy/patch/load/check path must stay silent.
//   * MANIFEST    pokemonarena/manifest.json must equal LAYOUT/PINNED, and loading with the layout taken
//                 FROM the manifest must reproduce the identical pack.
//   * PACK HYGIENE JSON round-trip, determinism across loads, decode time + machine load.
//
// USAGE   node tools/pokemonarena_pack_test.mjs         (from anywhere; exits non-zero on any failure)
// ENV     ARENA_ROM   path to the ROM (default gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba)
//         ARENA_REPS  decode-time repetitions (default 15)
//
// This test only READS the ROM and writes nothing. The ROM bytes are never copied anywhere but memory.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { PINNED, sha256Hex, md5Hex, sha256HexFast, MD5_T, identify, readHeader, assertPinnedAsync, RomMismatchError, RomFormatError } from '../pokemonarena/js/rom.js';
import {
  CHARSET, CORE_BYTES, RECALLED_BYTES, createCodec, defaultCodec, hasUnknownTokens, displayText,
} from '../pokemonarena/js/charset.js';
import { LAYOUT, loadPack, loadPackAsync, learnableMoves, typeEffectiveness } from '../pokemonarena/js/tables.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const E = String.fromCharCode(0xe9); // e-acute, spelled without a literal so this file stays ASCII

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
const same = (a, b) => J(a) === J(b);

if (!fs.existsSync(ROM_PATH)) {
  console.error(`ROM not found: ${ROM_PATH}  (set ARENA_ROM)`);
  process.exit(2);
}
const rom = fs.readFileSync(ROM_PATH);
const cpuSnap = () => os.cpus().reduce((a, c) => { for (const k in c.times) a.total += c.times[k]; a.idle += c.times.idle; return a; }, { idle: 0, total: 0 });
const cpuBusy = (a, b) => { const dt = b.total - a.total; return dt > 0 ? (100 * (1 - (b.idle - a.idle) / dt)) : NaN; };
const load0 = cpuSnap();

// ---------------------------------------------------------------------------------------------
// reference data embedded in the TEST (hand-written, not ROM-derived)
// ---------------------------------------------------------------------------------------------
// Canonical Gen 6+ 18-type effectiveness chart, by attacker. Types not listed = 1x.
const CANON = {
  Normal: { NVE: ['Rock', 'Steel'], IMM: ['Ghost'] },
  Fire: { SE: ['Grass', 'Ice', 'Bug', 'Steel'], NVE: ['Fire', 'Water', 'Rock', 'Dragon'] },
  Water: { SE: ['Fire', 'Ground', 'Rock'], NVE: ['Water', 'Grass', 'Dragon'] },
  Electric: { SE: ['Water', 'Flying'], NVE: ['Electric', 'Grass', 'Dragon'], IMM: ['Ground'] },
  Grass: { SE: ['Water', 'Ground', 'Rock'], NVE: ['Fire', 'Grass', 'Poison', 'Flying', 'Bug', 'Dragon', 'Steel'] },
  Ice: { SE: ['Grass', 'Ground', 'Flying', 'Dragon'], NVE: ['Fire', 'Water', 'Ice', 'Steel'] },
  Fighting: { SE: ['Normal', 'Ice', 'Rock', 'Dark', 'Steel'], NVE: ['Poison', 'Flying', 'Psychic', 'Bug', 'Fairy'], IMM: ['Ghost'] },
  Poison: { SE: ['Grass', 'Fairy'], NVE: ['Poison', 'Ground', 'Rock', 'Ghost'], IMM: ['Steel'] },
  Ground: { SE: ['Fire', 'Electric', 'Poison', 'Rock', 'Steel'], NVE: ['Grass', 'Bug'], IMM: ['Flying'] },
  Flying: { SE: ['Grass', 'Fighting', 'Bug'], NVE: ['Electric', 'Rock', 'Steel'] },
  Psychic: { SE: ['Fighting', 'Poison'], NVE: ['Psychic', 'Steel'], IMM: ['Dark'] },
  Bug: { SE: ['Grass', 'Psychic', 'Dark'], NVE: ['Fire', 'Fighting', 'Poison', 'Flying', 'Ghost', 'Steel', 'Fairy'] },
  Rock: { SE: ['Fire', 'Ice', 'Flying', 'Bug'], NVE: ['Fighting', 'Ground', 'Steel'] },
  Ghost: { SE: ['Psychic', 'Ghost'], NVE: ['Dark'], IMM: ['Normal'] },
  Dragon: { SE: ['Dragon'], NVE: ['Steel'], IMM: ['Fairy'] },
  Dark: { SE: ['Psychic', 'Ghost'], NVE: ['Fighting', 'Dark', 'Fairy'] },
  Steel: { SE: ['Ice', 'Rock', 'Fairy'], NVE: ['Fire', 'Water', 'Electric', 'Steel'] },
  Fairy: { SE: ['Fighting', 'Dragon', 'Dark'], NVE: ['Fire', 'Poison', 'Steel'] },
};
const REAL_TYPES = Object.keys(CANON);
const UQ = { SE: 0x2000, NVE: 0x800, NEUTRAL: 0x1000, IMM: 0 };
const canonCell = (a, d) => (CANON[a].SE?.includes(d) ? UQ.SE : CANON[a].NVE?.includes(d) ? UQ.NVE : CANON[a].IMM?.includes(d) ? UQ.IMM : UQ.NEUTRAL);
const mulName = (v) => ({ 0: '0x', 0x800: '0.5x', 0x1000: '1x', 0x2000: '2x' }[v] ?? '0x' + v.toString(16));

const TYPE_NAMES = ['None', 'Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', '???', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark', 'Fairy', 'Stellar'];
const NATURE_NAMES = ['Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty', 'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax', 'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive', 'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash', 'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky'];
// Fixed (u32 table at 0x889500) formulas for the six growth groups; index = level, checked for level >= 2.
const EXP_FORMULA = [
  (n) => n ** 3,
  (n) => (n < 50 ? Math.floor(n ** 3 * (100 - n) / 50) : n < 68 ? Math.floor(n ** 3 * (150 - n) / 100) : n < 98 ? Math.floor(n ** 3 * Math.floor((1911 - 10 * n) / 3) / 500) : Math.floor(n ** 3 * (160 - n) / 100)),
  (n) => (n < 15 ? Math.floor(n ** 3 * (Math.floor((n + 1) / 3) + 24) / 50) : n < 36 ? Math.floor(n ** 3 * (n + 14) / 50) : Math.floor(n ** 3 * (Math.floor(n / 2) + 32) / 50)),
  (n) => Math.floor(6 * n ** 3 / 5 - 15 * n ** 2 + 100 * n - 140),
  (n) => Math.floor(4 * n ** 3 / 5),
  (n) => Math.floor(5 * n ** 3 / 4),
];
// Other full copies of the 110-entry TM/HM move table that live in different compilation units of the ROM.
const TMHM_COPIES = [0x75df10, 0x79eb8c, 0x1117a44];
// Mew's learnset is the union of everything learnable; its teachable pointer, used as a cross-check source.
const MEW_ID = 151;
// Where the ROM's string pool starts: the first byte after the item table (930 records of 44 bytes).
const ITEM_TABLE_END = 0x74f19c;
// Number of 4-aligned u32 words in the ROM equal to the bus address of file offset `off` (literal-pool references --
// CODE evidence for where a table starts, independent of the table's own contents).
const refCache = new WeakMap(); // rom bytes -> Map(off -> count); the scan is 8M words, so do it once per (rom, offset)
function romWordRefs(romBytes, off) {
  let m = refCache.get(romBytes);
  if (!m) refCache.set(romBytes, (m = new Map()));
  if (m.has(off)) return m.get(off);
  const dv = new DataView(romBytes.buffer, romBytes.byteOffset, romBytes.byteLength);
  const want = (0x08000000 + off) >>> 0;
  let n = 0;
  for (let o = 0; o + 4 <= romBytes.length; o += 4) if (dv.getUint32(o, true) === want) n++;
  m.set(off, n);
  return n;
}

// ---------------------------------------------------------------------------------------------
// the checks: each returns true, or a string describing the failure. runChecks(pack, ctx) -> [{id, ok, detail}]
// ---------------------------------------------------------------------------------------------
function runChecks(pack, ctx) {
  const R = [];
  const add = (id, fn) => {
    let ok = false, detail = '';
    try {
      const r = fn();
      ok = r === true;
      detail = ok ? '' : String(r);
    } catch (e) { detail = 'threw ' + (e && e.message); }
    R.push({ id, ok, detail });
  };
  const sp = (id) => pack.species[id];
  const spByName = (name) => pack.species.find((s) => s && s.name === name && s.legal);
  const mvByName = (name) => pack.moves.find((m) => m.name === name);
  const tname = (i) => pack.types[i].name;
  const legal = () => pack.roster.map((id) => pack.species[id]);
  const stats = (s) => [s.baseStats.hp, s.baseStats.atk, s.baseStats.def, s.baseStats.spe, s.baseStats.spa, s.baseStats.spd];
  const machineMoves = () => new Set(pack.machines.map((m) => m.move));
  const idText = (arr) => arr.slice(0, 8).join(', ') + (arr.length > 8 ? ` (+${arr.length - 8} more)` : '');

  // ---- pack-level ---------------------------------------------------------------------------
  add('pack/rom-record', () => (pack.rom.length === PINNED.length && pack.rom.gameCode === 'BPEE' && pack.rom.title === 'POKEMON EMER' && pack.rom.headerChecksumOk) || J(pack.rom));
  add('pack/counts', () => {
    const want = { speciesSlots: 1579, speciesNonEmpty: 1040, speciesLegal: 1038, moves: 936, movesReal: 935, abilities: 523, items: 930, types: 21, natures: 25, machines: 110, tutors: 149, evolutions: 430 };
    return same(pack.counts, want) || `counts ${J(pack.counts)} != ${J(want)}`;
  });
  add('pack/jsonable', () => {
    const bad = [];
    const walk = (v, p) => {
      if (bad.length) return;
      if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
      if (typeof v === 'number') { if (!Number.isFinite(v)) bad.push(p); return; }
      if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { if (!(i in v)) bad.push(p + '[hole ' + i + ']'); walk(v[i], p + '[' + i + ']'); } return; }
      if (typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype)) { for (const k of Object.keys(v)) walk(v[k], p + '.' + k); return; }
      bad.push(p + ' (' + typeof v + ')');
    };
    walk(pack, 'pack');
    if (bad.length) return 'non-JSON value at ' + bad[0];
    return same(JSON.parse(JSON.stringify(pack)), pack) || 'JSON round-trip differs';
  });

  // ---- text ---------------------------------------------------------------------------------
  const allStrings = () => {
    const out = [];
    for (const s of pack.species) if (s) { out.push(s.name, s.category); if (s.dexText) out.push(s.dexText); }
    for (const m of pack.moves) out.push(m.name, m.desc);
    for (const a of pack.abilities) out.push(a.name, a.short, a.long);
    for (const i of pack.items) { out.push(i.name); if (i.plural) out.push(i.plural); if (i.desc) out.push(i.desc); }
    for (const n of pack.natures) out.push(n.name);
    for (const ty of pack.types) out.push(ty.name);
    return out;
  };
  add('text/no-unknown-tokens', () => {
    const bad = allStrings().filter((s) => hasUnknownTokens(s));
    return bad.length === 0 || `${bad.length} strings contain {XX} tokens, e.g. ${J(bad[0].slice(0, 60))}`;
  });
  add('text/roundtrip-and-verified-bytes', () => {
    const core = new Set(CORE_BYTES);
    for (const s of allStrings()) {
      const bytes = ctx.codec.encode(s, { terminate: false });
      if (ctx.codec.decode(bytes) !== s) return `decode(encode(x)) != x for ${J(s.slice(0, 40))}`;
      for (const b of bytes) if (!core.has(b)) return `byte 0x${b.toString(16)} (${J(CHARSET[b])}) used by ${J(s.slice(0, 40))} is not in the verified CORE table`;
    }
    return true;
  });
  add('text/names-readable', () => {
    const rx = {
      species: /^[A-Za-z0-9'.\- \u2640\u2642\u00e9]+$/, move: /^[A-Za-z0-9,'\- ]+$/, ability: /^[A-Za-z'\- ]+$/, nature: /^[A-Z][a-z]+$/,
    };
    for (const s of legal()) { if (!rx.species.test(s.name) || s.name.length > 12) return `species ${s.id} name ${J(s.name)}`; }
    for (const m of pack.moves) if (m.id > 0 && !rx.move.test(m.name)) return `move ${m.id} name ${J(m.name)}`;
    for (const a of pack.abilities) if (a.id > 0 && !rx.ability.test(a.name)) return `ability ${a.id} name ${J(a.name)}`;
    for (const n of pack.natures) if (!rx.nature.test(n.name)) return `nature ${n.id} name ${J(n.name)}`;
    return true;
  });

  // ---- types / chart ------------------------------------------------------------------------
  add('types/names', () => same(pack.types.map((x) => x.name), TYPE_NAMES) || J(pack.types.map((x) => x.name)));
  add('types/chart-values', () => {
    if (pack.typeChart.length !== 21 || pack.typeChart.some((r) => r.length !== 21)) return 'not 21x21';
    for (let a = 0; a < 21; a++) for (let d = 0; d < 21; d++) if (![0, 0x800, 0x1000, 0x2000].includes(pack.typeChart[a][d])) return `cell [${tname(a)}][${tname(d)}] = 0x${pack.typeChart[a][d].toString(16)}`;
    return true;
  });
  add('types/chart-canonical', () => {
    const diffs = [];
    for (const a of REAL_TYPES) for (const d of REAL_TYPES) {
      const got = typeEffectiveness(pack, TYPE_NAMES.indexOf(a), TYPE_NAMES.indexOf(d));
      const want = canonCell(a, d);
      if (got !== want) diffs.push(`${a}->${d}: ROM ${mulName(got)} vs canon ${mulName(want)}`);
    }
    return diffs.length === 0 || `${diffs.length} of 324 cells differ: ${diffs.slice(0, 6).join('; ')}`;
  });
  add('types/chart-pseudo-neutral', () => {
    for (const n of ['None', '???', 'Stellar']) {
      const i = TYPE_NAMES.indexOf(n);
      if (!pack.typeChart[i].every((v) => v === 0x1000)) return `${n} as attacker is not all 1x`;
      if (!pack.typeChart.every((row) => row[i] === 0x1000)) return `${n} as defender is not all 1x`;
    }
    return true;
  });
  add('types/chart-counts', () => {
    const c = { SE: 0, NVE: 0, IMM: 0 };
    for (const a of REAL_TYPES) for (const d of REAL_TYPES) {
      const v = pack.typeChart[TYPE_NAMES.indexOf(a)][TYPE_NAMES.indexOf(d)];
      if (v === 0x2000) c.SE++; else if (v === 0x800) c.NVE++; else if (v === 0) c.IMM++;
    }
    return same(c, { SE: 51, NVE: 61, IMM: 8 }) || J(c);
  });

  // ---- natures / exp ------------------------------------------------------------------------
  add('natures/names', () => same(pack.natures.map((n) => n.name), NATURE_NAMES) || J(pack.natures.map((n) => n.name)));
  add('natures/effects', () => {
    const O = ['atk', 'def', 'spe', 'spa', 'spd'];
    for (const n of pack.natures) {
      const up = O[Math.floor(n.id / 5)], down = O[n.id % 5];
      if (n.up !== up || n.down !== down) return `${n.name}: +${n.up} -${n.down}, expected +${up} -${down}`;
    }
    return true;
  });
  add('exp/shape-and-values', () => {
    if (pack.exp.length !== 8 || pack.exp.some((r) => r.length !== 101)) return 'not 8 x 101';
    const l100 = pack.exp.map((r) => r[100]);
    if (!same(l100, [1000000, 600000, 1640000, 1059860, 800000, 1250000, 1000000, 1000000])) return 'level-100 column ' + J(l100);
    for (let r = 0; r < 6; r++) for (let n = 2; n <= 100; n++) if (pack.exp[r][n] !== EXP_FORMULA[r](n)) return `row ${r} level ${n}: ${pack.exp[r][n]} != formula ${EXP_FORMULA[r](n)}`;
    return same(pack.exp[6], pack.exp[0]) && same(pack.exp[7], pack.exp[0]) || 'rows 6/7 are not copies of row 0';
  });
  add('exp/monotonic', () => {
    for (let r = 0; r < 8; r++) for (let n = 1; n <= 100; n++) if (pack.exp[r][n] < pack.exp[r][n - 1]) return `row ${r} drops at level ${n}`;
    return true;
  });

  // ---- abilities ----------------------------------------------------------------------------
  add('abilities/samples', () => {
    const A = pack.abilities;
    if (A.length !== 523) return 'length ' + A.length;
    const want = { 0: '-------', 1: 'Stench', 9: 'Static', 26: 'Levitate', 31: 'Lightning Rod', 65: 'Overgrow', 100: 'Stall', 522: 'Malice Aura' };
    for (const [i, n] of Object.entries(want)) if (A[i].name !== n) return `ability ${i} = ${J(A[i].name)}, expected ${J(n)}`;
    if (A[65].short !== 'Ups Grass moves in a pinch.') return 'Overgrow short text ' + J(A[65].short);
    if (!/^Paralyzes on contact/.test(A[9].short)) return 'Static short text ' + J(A[9].short);
    return true;
  });
  add('abilities/ai-rating-signed', () => {
    // The rating byte is SIGNED: nine abilities are negative in the ROM (a u8 read would turn -2 into 254).
    const neg = {};
    for (const a of pack.abilities) if (a.aiRating < 0) neg[a.name] = a.aiRating;
    const want = { Truant: -2, 'Slow Start': -2, Normalize: -1, Stall: -1, Klutz: -1, Defeatist: -1, 'Heavy Metal': -1, 'Zen Mode': -1, 'Perish Body': -1 };
    const sortedEntries = (o) => Object.entries(o).sort((x, y) => (x[0] < y[0] ? -1 : 1));
    if (!same(sortedEntries(neg), sortedEntries(want))) return 'negative ratings ' + J(neg);
    const r = pack.abilities.map((a) => a.aiRating);
    return (Math.min(...r) === -2 && Math.max(...r) === 10 && pack.abilities[25].aiRating === 10 && pack.abilities[9].aiRating === 4) || `range ${Math.min(...r)}..${Math.max(...r)}`;
  });
  add('abilities/long-text', () => {
    // short = the pointer at +0x14, long = the pointer at +0x18; swapping or shifting them is caught here.
    const A = pack.abilities;
    if (!/^Contact has a 30% chance\nto paralyze the attacker\./.test(A[9].long)) return 'Static long text ' + J(A[9].long);
    if (!/^The Pok.mon is immune to\nGround-type moves/.test(A[26].long)) return 'Levitate long text ' + J(A[26].long);
    if (!/^Boosts the power of the\n/.test(A[65].long)) return 'Overgrow long text ' + J(A[65].long);
    for (const a of A) if (a.id > 0 && (a.long === a.short || a.long.length <= a.short.length)) return `ability ${a.id} (${a.name}): long text is not longer than the short text`;
    return true;
  });
  add('abilities/text-present', () => {
    for (const a of pack.abilities) if (a.id > 0 && (!a.name || !a.short || !a.long)) return `ability ${a.id} has empty text`;
    return true;
  });
  add('abilities/species-refs', () => {
    for (const s of legal()) for (const a of [...s.abilities, ...s.innates]) if (a >= 523) return `species ${s.id} references ability ${a}`;
    return true;
  });

  // ---- items / machines ---------------------------------------------------------------------
  add('items/count-and-names', () => {
    const I = pack.items;
    if (I.length !== 930) return 'length ' + I.length;
    const want = { 1: `Pok${E} Ball`, 2: 'Great Ball', 3: 'Ultra Ball', 4: 'Master Ball', 442: 'Choice Band', 472: 'Leftovers', 582: 'TM01 Work Up', 682: 'HM01 Cut', 691: 'HM10 Whirlpool', 929: 'Soggy Herb' };
    for (const [i, n] of Object.entries(want)) if (I[i].name !== n) return `item ${i} = ${J(I[i].name)}, expected ${J(n)}`;
    return true;
  });
  add('items/descriptions-aligned', () => {
    // An item's description pointer is the word at +0x0c of its own 44-byte record; the name-relative +0x24 word is the NEXT item's text.
    const I = pack.items;
    const want = [[1, /catching wild/], [2, /higher catch rate/], [28, /20 points/], [43, /poisoned/], [102, /Raises the level/], [114, /100\s+steps/], [442, /Boosts Attack/], [472, /gradually restores/], [583, /sharp claws/], [682, /sharp blades/], [929, /Sp\. Def IV/]];
    for (const [i, rx] of want) if (!rx.test(I[i].desc || '')) return `item ${i} (${I[i].name}) desc ${J(I[i].desc)} does not match ${rx}`;
    return true;
  });
  add('items/all-records-intact', () => {
    // Every one of the 930 records decodes whole: an integer price, no `partial` flag, no null text field.
    for (const i of pack.items) {
      if ('partial' in i) return `item ${i.id} still carries a partial flag`;
      if (!Number.isInteger(i.price) || i.price < 0 || i.price > 999999) return `item ${i.id} (${i.name}) price ${i.price}`;
      if (!i.name || !i.desc) return `item ${i.id} has a null name/description`;
    }
    return pack.items[929].price === 20 || 'last record price ' + pack.items[929].price;
  });
  add('items/table-extent-and-code-refs', () => {
    // The table is exactly 930 x 44 bytes and ends where the string pool begins; literal-pool words in the ROM's CODE
    // reference its base 30 times (and the old name-pointer anchor, base + 0x14, never).
    const L = ctx.layout || LAYOUT;
    const end = L.items.offset + L.items.count * L.items.stride;
    if (end !== ITEM_TABLE_END) return `table ends at 0x${end.toString(16)}, expected 0x${ITEM_TABLE_END.toString(16)} (start 0x${L.items.offset.toString(16)}, stride ${L.items.stride})`;
    const core = new Set(CORE_BYTES);
    for (let k = 0; k < 8; k++) if (!core.has(ctx.rom[end + k])) return `byte 0x${ctx.rom[end + k].toString(16)} just past the table is not text`;
    const refs = romWordRefs(ctx.rom, L.items.offset), refsOld = romWordRefs(ctx.rom, L.items.offset + 0x14);
    return (refs === 30 && refsOld === 0) || `literal-pool refs to the base ${refs} (expected 30), to base+0x14 ${refsOld} (expected 0)`;
  });
  add('items/prices-and-hold', () => {
    // Prices chosen so that a decoder reading the NEXT record's price (the old bug) gets every one of them wrong.
    const P = {
      Potion: 200, 'Super Potion': 700, 'Hyper Potion': 1500, 'Max Potion': 2500, 'Full Restore': 3000, Revive: 2000, 'Max Revive': 4000,
      Repel: 400, 'Super Repel': 700, 'Max Repel': 900, 'Rare Candy': 10000, 'Master Ball': 999999, 'Soggy Herb': 20, Leftovers: 20000, 'Choice Band': 100000,
    };
    const byName = (n) => pack.items.find((i) => i.name === n);
    for (const [n, p] of Object.entries(P)) { const it = byName(n); if (!it || it.price !== p) return `${n}: price ${it && it.price}, expected ${p}`; }
    if (pack.items[582].price !== 3000 || pack.items[681].price !== 5000 || pack.items[682].price !== 0) return 'TM01/TM100/HM01 prices ' + J([pack.items[582].price, pack.items[681].price, pack.items[682].price]);
    // hold effect + parameter live in the same record (Potion/Repel carry their heal amount / step count there)
    const H = { Leftovers: [41, 10], 'Choice Band': [29, 0], 'Oran Berry': [1, 10], 'Sitrus Berry': [82, 25], Eviolite: [91, 50], Potion: [0, 20], 'Super Potion': [0, 60], 'Max Repel': [0, 250] };
    for (const [n, [e, p]] of Object.entries(H)) { const it = byName(n); if (!it || it.holdEffect !== e || it.holdEffectParam !== p) return `${n}: hold ${it && it.holdEffect}/${it && it.holdEffectParam}, expected ${e}/${p}`; }
    return true;
  });
  add('machines/shape', () => {
    const M = pack.machines;
    if (M.length !== 110) return 'length ' + M.length;
    for (let i = 0; i < 110; i++) {
      const wantKind = i < 100 ? 'TM' : 'HM', wantNum = i < 100 ? i + 1 : i - 99;
      if (M[i].kind !== wantKind || M[i].number !== wantNum || M[i].item !== 582 + i) return `machine ${i}: ${J(M[i])}`;
    }
    if (new Set(M.map((m) => m.move)).size !== 110) return 'machine moves are not 110 distinct ids';
    return true;
  });
  add('machines/match-item-names', () => {
    for (const m of pack.machines) {
      const it = pack.items[m.item];
      const mv = pack.moves[m.move];
      if (!mv || m.move < 1) return `machine ${m.kind}${m.number}: move id ${m.move}`;
      const mm = /^(TM|HM)(\d*) (.+)$/.exec(it.name);
      if (!mm) return `item ${it.id} name ${J(it.name)} is not TM/HM-shaped`;
      if (mm[1] !== m.kind) return `item ${it.id} ${J(it.name)} kind != ${m.kind}`;
      if (mm[2] !== '' && Number(mm[2]) !== m.number) return `item ${it.id} ${J(it.name)} number != ${m.number}`;
      if (mm[3].toLowerCase() !== mv.name.toLowerCase()) return `item ${it.id} ${J(it.name)} teaches ${J(mv.name)} per the table`;
      if (!same(it.machine, { kind: m.kind, number: m.number, move: m.move })) return `item ${it.id}.machine = ${J(it.machine)}`;
    }
    return pack.items.filter((i) => i.machine).length === 110 || 'items carrying .machine != 110';
  });
  add('machines/copies-agree', () => {
    const dv = new DataView(ctx.rom.buffer, ctx.rom.byteOffset, ctx.rom.byteLength);
    for (const off of TMHM_COPIES) for (let i = 0; i < 110; i++) if (dv.getUint16(off + 2 * i, true) !== pack.machines[i].move) return `copy at 0x${off.toString(16)} differs from the table at entry ${i}`;
    return true;
  });

  // ---- moves --------------------------------------------------------------------------------
  add('moves/counts', () => (pack.moves.length === 936 && pack.moves[0].name === '-' && pack.counts.movesReal === 935 && pack.moves.filter((m) => m.id > 0 && m.name !== '-').length === 935) || 'move counts');
  add('moves/categories', () => {
    const c = [0, 0, 0];
    for (const m of pack.moves) if (m.id > 0) c[m.category]++;
    return same(c, [423, 241, 271]) || J(c);
  });
  add('moves/ranges', () => {
    const PP = new Set([1, 5, 10, 15, 20, 25, 30, 35, 40]);
    let maxPower = 0;
    for (const m of pack.moves) {
      if (m.id === 0) continue;
      if (m.type < 1 || m.type > 19 || m.type === 10) return `move ${m.id} ${m.name}: type ${m.type}`;
      if (m.accuracy > 100) return `move ${m.id}: accuracy ${m.accuracy}`;
      if (m.target < 1 || m.target > 14) return `move ${m.id}: target ${m.target}`;
      if (!PP.has(m.pp)) return `move ${m.id}: pp ${m.pp}`;
      if (m.category > 2) return `move ${m.id}: category ${m.category}`;
      maxPower = Math.max(maxPower, m.power);
    }
    return maxPower === 250 || 'max power ' + maxPower;
  });
  add('moves/priority-histogram', () => {
    const h = {};
    for (const m of pack.moves) if (m.id > 0) h[m.priority] = (h[m.priority] || 0) + 1;
    const want = { '-7': 1, '-6': 5, '-5': 2, '-4': 2, '-3': 3, '-1': 1, 0: 879, 1: 16, 2: 7, 3: 6, 4: 12, 5: 1 };
    return same(Object.fromEntries(Object.entries(h).sort((a, b) => a[0] - b[0])), Object.fromEntries(Object.entries(want).sort((a, b) => a[0] - b[0]))) || J(h);
  });
  add('moves/spot-checks', () => {
    // [name, effect, type, category, power, accuracy, target, pp, priority]
    const T = [
      ['Thunderbolt', 1, 'Electric', 1, 90, 100, 1, 15, 0],
      ['Pound', 1, 'Normal', 0, 40, 100, 1, 35, 0],
      ['Quick Attack', 1, 'Normal', 0, 40, 100, 1, 30, 1],
      ['Protect', 86, 'Normal', 2, 0, 0, 7, 10, 4],
      ['Fake Out', 119, 'Normal', 0, 40, 100, 1, 10, 3],
      ['Counter', 66, 'Fighting', 0, 1, 100, 3, 20, -5],
      ['Roar', 24, 'Normal', 2, 0, 0, 1, 20, -6],
      ['Swords Dance', 38, 'Normal', 2, 0, 0, 7, 20, 0],
      ['Earthquake', 111, 'Ground', 0, 100, 100, 11, 10, 0],
      ['Surf', 1, 'Water', 1, 90, 100, 11, 15, 0],
      ['Rain Dance', 107, 'Water', 2, 0, 0, 12, 5, 0],
      ['Spikes', 87, 'Ground', 2, 0, 0, 13, 20, 0],
      ['Perish Song', 89, 'Normal', 2, 0, 0, 14, 5, 0],
      ['Helping Hand', 135, 'Normal', 2, 0, 0, 8, 20, 5],
      ['Thrash', 1, 'Normal', 0, 120, 100, 5, 10, 0],
      ['Dragon Darts', 1, 'Dragon', 0, 50, 100, 2, 10, 0],
      ['Hyper Voice', 1, 'Normal', 1, 90, 100, 6, 10, 0],
      ['Howl', 7, 'Normal', 2, 0, 0, 9, 40, 0],
      ['Acupressure', 251, 'Normal', 2, 0, 0, 10, 30, 0],
      ['Me First', 219, 'Normal', 2, 0, 0, 4, 20, 0],
    ];
    for (const [name, eff, type, cat, pow, acc, tgt, pp, pri] of T) {
      const m = mvByName(name);
      if (!m) return `${name} missing`;
      const got = [m.effect, tname(m.type), m.category, m.power, m.accuracy, m.target, m.pp, m.priority];
      const want = [eff, type, cat, pow, acc, tgt, pp, pri];
      if (!same(got, want)) return `${name}: ${J(got)} != ${J(want)}  [effect,type,cat,power,acc,target,pp,priority]`;
    }
    return true;
  });
  add('moves/descriptions', () => {
    const m = mvByName('Thunderbolt');
    return (m.desc === 'A strong electrical attack\nthat may paralyze the foe.' && mvByName('Swords Dance').desc === 'A fighting dance that\nsharply raises Attack.') || J(m.desc);
  });
  add('moves/additional-effects', () => {
    const withAny = pack.moves.filter((m) => m.additional.length > 0);
    const total = pack.moves.reduce((n, m) => n + m.additional.length, 0);
    if (withAny.length !== 336 || total !== 342) return `moves with effects ${withAny.length}, entries ${total}`;
    for (const m of withAny) for (const e of m.additional) if (e.chance > 100) return `move ${m.id}: chance ${e.chance}`;
    const tf = mvByName('Thunder Fang');
    if (!same(tf.additional.map((e) => [e.effect, e.chance]), [[5, 10], [9, 10]])) return 'Thunder Fang ' + J(tf.additional);
    return same(mvByName('Fake Out').additional.map((e) => [e.effect, e.chance]), [[9, 100]]) || 'Fake Out ' + J(mvByName('Fake Out').additional);
  });
  add('moves/strike-and-crit', () => {
    const S = { 'Double Kick': 2, 'Triple Kick': 3, 'Triple Axel': 3, 'Surging Strikes': 3, 'Dual Wingbeat': 2, 'Population Bomb': 10, Pound: 0, Tackle: 0 };
    for (const [n, k] of Object.entries(S)) if (mvByName(n).strikeCount !== k) return `${n}.strikeCount = ${mvByName(n).strikeCount}, expected ${k}`;
    const crit = { Slash: [1, false], 'Karate Chop': [1, false], 'Storm Throw': [0, true], 'Frost Breath': [0, true], 'Surging Strikes': [0, true], Pound: [0, false] };
    for (const [n, [cs, ac]] of Object.entries(crit)) { const m = mvByName(n); if (m.critStage !== cs || m.alwaysCrit !== ac) return `${n}: critStage ${m.critStage}, alwaysCrit ${m.alwaysCrit}`; }
    return true;
  });
  add('moves/flag-samples', () => {
    const want = [
      ['Tackle', 'contact', true], ['Earthquake', 'contact', false], ['Thunderbolt', 'contact', false],
      ['Fire Punch', 'punch', true], ['Mach Punch', 'punch', true], ['Fire Fang', 'bite', true], ['Crunch', 'bite', true], ['Low Kick', 'kick', true],
      ['Hyper Voice', 'sound', true], ['Water Pulse', 'pulse', true], ['Sleep Powder', 'powder', true], ['Swords Dance', 'dance', true],
      ['Gust', 'wind', true], ['Slash', 'slicing', true], ['Absorb', 'heal', true], ['Sludge Bomb', 'ball', true], ['Tackle', 'punch', false],
    ];
    for (const [n, f, v] of want) if (mvByName(n).flags[f] !== v) return `${n}.flags.${f} = ${mvByName(n).flags[f]}, expected ${v}`;
    return true;
  });
  add('moves/flag-families', () => {
    // Each flag bit was named by its correlation with a move-name family; assert the correlation stays strong.
    const fam = {
      punch: /Punch|Hammer Arm|Sky Uppercut|Meteor Mash|Plasma Fists|Wicked Blow|Surging Strikes|Ice Hammer|Double Iron Bash|Rage Fist|Headlong Rush/,
      kick: /Kick|Stomp|Low Sweep|Triple Axel/,
      bite: /Bite|Fang|Crunch|Jaw Lock|Fishious Rend/,
      pulse: /Pulse|Aura Sphere/,
      powder: /Powder|Spore/,
      wind: /Wind|Gust|Hurricane|Blizzard|Heat Wave|Whirlwind|Tailwind|Twister|Air Cutter|Icy Wind|(Bleakwind|Wildbolt|Sandsear|Springtide) Storm|Aeroblast|Sandstorm/,
    };
    const lim = { punch: [0.9, 0.9], kick: [0.9, 0.85], bite: [0.9, 0.75], pulse: [0.9, 0.9], powder: [0.9, 0.8], wind: [0.8, 0.8] };
    for (const [f, rx] of Object.entries(fam)) {
      const withFlag = pack.moves.filter((m) => m.id > 0 && m.flags[f]);
      const named = pack.moves.filter((m) => m.id > 0 && rx.test(m.name));
      const tp = withFlag.filter((m) => rx.test(m.name)).length;
      const prec = tp / withFlag.length, rec = tp / named.length;
      if (prec < lim[f][0] || rec < lim[f][1]) return `${f}: precision ${prec.toFixed(2)} (min ${lim[f][0]}), recall ${rec.toFixed(2)} (min ${lim[f][1]})`;
    }
    const contact = pack.moves.filter((m) => m.id > 0 && m.flags.contact);
    const phys = contact.filter((m) => m.category === 0).length / contact.length;
    return phys >= 0.9 || `only ${phys.toFixed(2)} of contact moves are Physical`;
  });

  // ---- species ------------------------------------------------------------------------------
  add('species/slots-and-roster', () => {
    const nonEmpty = pack.species.slice(1, 1578).filter((s) => s).length;
    const zero = pack.species.slice(1, 1578).filter((s) => !s).length;
    if (pack.species.length !== 1579) return 'slots ' + pack.species.length;
    if (nonEmpty !== 1038 || zero !== 539) return `ids 1..1577: ${nonEmpty} non-empty / ${zero} zero (expected 1038 / 539)`;
    if (pack.roster.length !== 1038) return 'roster ' + pack.roster.length;
    for (const id of pack.roster) { const s = pack.species[id]; if (!s || !s.name || s.bst === 0 || id < 1) return `roster id ${id} not legal`; }
    const illegal = pack.species.filter((s) => s && !s.legal).map((s) => s.id);
    return same(illegal, [0, 1578]) || 'non-null but illegal slots ' + J(illegal);
  });
  add('species/roster-not-contiguous', () => {
    const missing = [];
    for (let i = 1; i <= 905; i++) if (!pack.species[i]) missing.push(i);
    return (missing.length === 283 && pack.species[1288] === null && pack.species[1435].name === 'Lugia') || `ids 1..905 absent: ${missing.length}`;
  });
  add('species/bulbasaur', () => {
    const s = sp(1);
    return (s.name === 'Bulbasaur' && same(stats(s), [45, 49, 49, 45, 65, 65]) && same(s.types.map(tname), ['Grass', 'Poison']) && s.natDex === 1) || J([s.name, stats(s), s.types]);
  });
  add('species/pikachu', () => {
    const s = sp(25);
    if (s.name !== 'Pikachu' || !same(stats(s), [35, 55, 40, 90, 50, 50])) return J([s.name, stats(s)]);
    if (!same(s.types.map(tname), ['Electric', 'Electric'])) return 'types ' + J(s.types);
    if (!same(s.abilities.map((a) => pack.abilities[a].name), ['Static', '-------', 'Lightning Rod'])) return 'abilities ' + J(s.abilities);
    if (s.catchRate !== 190 || s.evYield.spe !== 2 || s.evYield.hp !== 0 || s.genderRatio !== 127 || s.growthRate !== 0 || s.height !== 4 || s.weight !== 60 || s.friendship !== 50) return 'misc ' + J([s.catchRate, s.evYield, s.genderRatio, s.growthRate, s.height, s.weight, s.friendship]);
    if (s.heldItems.rare !== 392 || pack.items[392].name !== 'Light Ball') return 'rare item ' + s.heldItems.rare;
    if (s.category !== 'Mouse') return 'category ' + s.category;
    return /^It stores electricity in the electric sacs/.test(s.dexText) || 'dex text ' + J(s.dexText);
  });
  add('species/breeding-and-yield-fields', () => {
    // [name, eggGroups, expYield, eggCycles]. Egg groups use the Gen-3 numbering (1 Monster, 2 Water 1, 3 Bug, 4 Flying, 5 Field,
    // 6 Fairy, 7 Grass, 8 Human-Like, 9 Water 3, 10 Mineral, 11 Amorphous, 12 Water 2, 13 Ditto, 14 Dragon, 15 Undiscovered).
    const T = [
      ['Bulbasaur', [1, 7], 64, 20], ['Pikachu', [5, 6], 112, 10], ['Charizard', [1, 14], 267, 20], ['Mewtwo', [15, 15], 340, 120],
      ['Snorlax', [1, 1], 189, 40], ['Dragonite', [2, 14], 300, 40], ['Magikarp', [12, 14], 40, 5], ['Ditto', [13, 13], 101, 20],
      ['Chansey', [6, 6], 395, 40], ['Blissey', [6, 6], 635, 40], ['Eevee', [5, 5], 65, 35], ['Onix', [10, 10], 77, 25],
    ];
    for (const [n, eg, xp, cyc] of T) {
      const s = spByName(n);
      if (!s || !same(s.eggGroups, eg) || s.expYield !== xp || s.eggCycles !== cyc) return `${n}: eggGroups ${s && J(s.eggGroups)}, expYield ${s && s.expYield}, eggCycles ${s && s.eggCycles}; expected ${J(eg)}, ${xp}, ${cyc}`;
    }
    const groups = new Set(legal().flatMap((s) => s.eggGroups));
    return (groups.size === 15 && Math.min(...groups) === 1 && Math.max(...groups) === 15) || 'egg groups ' + J([...groups]);
  });
  add('species/cry-id-regression-pins', () => {
    // REGRESSION PINS ONLY: cryId is decoded as a number and its meaning (an index into a cry table) is not verified here.
    const want = { Bulbasaur: 1, Pikachu: 24, Mewtwo: 168, Snorlax: 161, Eevee: 145, Machamp: 68, Gengar: 96, Weedle: 13 };
    for (const [n, c] of Object.entries(want)) { const s = spByName(n); if (!s || s.cryId !== c) return `${n}: cryId ${s && s.cryId}, pinned ${c}`; }
    return true;
  });
  add('species/anchor-values', () => {
    const want = { 6: ['Charizard', [78, 84, 78, 100, 109, 85]], 150: ['Mewtwo', [106, 110, 90, 130, 154, 90]], 94: ['Gengar', [60, 65, 60, 110, 130, 75]], 143: ['Snorlax', [160, 110, 65, 30, 65, 110]] };
    for (const [id, [n, st]] of Object.entries(want)) { const s = sp(id); if (!s || s.name !== n || !same(stats(s), st)) return `species ${id}: ${s && s.name} ${s && J(stats(s))} != ${n} ${J(st)}`; }
    return true;
  });
  add('species/field-ranges', () => {
    for (const s of legal()) {
      for (const v of stats(s)) if (v < 1 || v > 255) return `species ${s.id} stat ${v}`;
      for (const ty of s.types) if (ty < 1 || ty > 19 || ty === 10) return `species ${s.id} type ${ty}`;
      if (s.heldItems.common >= 930 || s.heldItems.rare >= 930) return `species ${s.id} held item`;
      if (s.growthRate > 5) return `species ${s.id} growthRate ${s.growthRate}`;
      if (s.abilities[0] === 0) return `species ${s.id} has no first ability`;
    }
    return true;
  });
  add('species/natdex', () => {
    const dex = new Set(legal().map((s) => s.natDex));
    if (dex.size !== 702 || Math.max(...dex) !== 1025 || Math.min(...dex) !== 1) return `distinct dex numbers ${dex.size}, range ${Math.min(...dex)}..${Math.max(...dex)}`;
    for (const s of legal()) if (s.id <= 905 && s.natDex !== s.id) return `species ${s.id} natDex ${s.natDex}`;
    return true;
  });
  add('species/forms', () => {
    for (const s of legal()) {
      if (s.forms.length && !s.forms.includes(s.id)) return `species ${s.id} not in its own form list ${J(s.forms)}`;
      for (const f of s.forms) if (!pack.species[f] || !pack.species[f].legal) return `species ${s.id} form ${f} is not a legal slot`;
    }
    return same(sp(3).forms, [3, 906, 1489]) || 'Venusaur forms ' + J(sp(3).forms);
  });

  // ---- learnsets ----------------------------------------------------------------------------
  add('learn/levelup-ascending-and-in-range', () => {
    let entries = 0;
    for (const s of legal()) {
      let prev = 0;
      if (s.levelUp.length === 0) return `species ${s.id} has no level-up moves`;
      for (const [mv, lv] of s.levelUp) {
        entries++;
        if (mv < 1 || mv > 935) return `species ${s.id}: level-up move id ${mv}`;
        if (lv < 0 || lv > 100) return `species ${s.id}: level ${lv}`; // level 0 = learned on evolution (inferred)
        if (lv < prev) return `species ${s.id} (${s.name}): level ${lv} after ${prev}`;
        prev = lv;
      }
    }
    return entries === 18135 || 'level-up entries ' + entries;
  });
  add('learn/move-ids-in-range', () => {
    for (const s of legal()) for (const m of [...s.teachable, ...s.eggMoves]) if (m < 1 || m > 935) return `species ${s.id}: move id ${m}`;
    for (const m of pack.tutors) if (m < 1 || m > 935) return `tutor move id ${m}`;
    return true;
  });
  add('learn/totals', () => {
    let te = 0, eg = 0, egSpecies = 0;
    const union = new Set();
    for (const s of legal()) { te += s.teachable.length; eg += s.eggMoves.length; if (s.eggMoves.length) egSpecies++; for (const m of s.teachable) union.add(m); }
    return (te === 60228 && eg === 2935 && egSpecies === 302 && union.size === 253) || J({ te, eg, egSpecies, union: union.size });
  });
  add('learn/bulbasaur-levelup', () => {
    const got = sp(1).levelUp.map(([m, l]) => `${pack.moves[m].name}@${l}`).join(', ');
    const want = 'Tackle@1, Growl@1, Vine Whip@3, Growth@6, Leech Seed@9, Razor Leaf@12, Poison Powder@15, Sleep Powder@15, Seed Bomb@18, Take Down@21, Sweet Scent@24, Synthesis@27, Double-Edge@27, Worry Seed@30, Power Whip@33, Solar Beam@36';
    return got === want || got;
  });
  add('learn/tutor-table', () => {
    const mm = machineMoves();
    if (pack.tutors.length !== 149 || new Set(pack.tutors).size !== 149) return 'tutor table length/distinct ' + pack.tutors.length + '/' + new Set(pack.tutors).size;
    const nonMachineTutors = new Set(pack.tutors.filter((m) => !mm.has(m)));
    const teachableNonMachine = new Set();
    for (const s of legal()) for (const m of s.teachable) if (!mm.has(m)) teachableNonMachine.add(m);
    const mewNonMachine = new Set(sp(MEW_ID).teachable.filter((m) => !mm.has(m)));
    const eq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
    const draco = mvByName('Draco Meteor').id;
    // 7 table entries are also TM/HM moves; the table is a strict subset of what species can be taught, short by exactly Draco Meteor.
    if (nonMachineTutors.size !== 142) return 'tutor table minus machines = ' + nonMachineTutors.size;
    const extraInTable = [...nonMachineTutors].filter((m) => !teachableNonMachine.has(m));
    if (extraInTable.length) return 'tutor table has moves nobody can be taught: ' + idText(extraInTable);
    const missingFromTable = [...teachableNonMachine].filter((m) => !nonMachineTutors.has(m));
    if (!same(missingFromTable, [draco])) return 'teachable non-machine moves absent from the tutor table: ' + J(missingFromTable) + ' (expected only Draco Meteor)';
    if (!eq(teachableNonMachine, mewNonMachine)) return 'Mew non-machine teachables != union over species';
    return pack.machines.every((m) => sp(MEW_ID).teachable.includes(m.move)) || 'Mew does not learn every TM/HM';
  });
  add('learn/helper-partition', () => {
    const L = learnableMoves(pack, 25);
    const mm = machineMoves();
    if (!L.machine.every((m) => mm.has(m)) || !L.tutor.every((m) => !mm.has(m))) return 'machine/tutor split wrong';
    return L.machine.length + L.tutor.length === new Set(sp(25).teachable).size || 'split does not partition the teachable list';
  });

  // ---- evolutions ---------------------------------------------------------------------------
  add('evolutions/count-and-methods', () => {
    const all = legal().flatMap((s) => s.evolutions);
    const h = {};
    for (const e of all) h[e.method] = (h[e.method] || 0) + 1;
    const withCond = all.filter((e) => e.conditions.length > 0).length;
    if (all.length !== 430) return 'records ' + all.length;
    if (withCond !== 101) return 'records with conditions ' + withCond;
    return same(h, { 0: 3, 1: 311, 2: 18, 3: 93, 4: 1, 5: 1, 6: 2, 7: 1 }) || J(h);
  });
  add('evolutions/targets-valid', () => {
    const ok = new Set(pack.roster);
    for (const s of legal()) for (const e of s.evolutions) {
      if (!ok.has(e.target)) return `species ${s.id} (${s.name}) evolves into slot ${e.target}, which is not on the roster`;
      for (const c of e.conditions) if (c[0] === 0x27) return `species ${s.id}: terminator leaked into conditions`;
    }
    return true;
  });
  add('evolutions/samples', () => {
    const ev = (n) => spByName(n).evolutions.map((e) => `${e.method}:${e.param}->${pack.species[e.target].name}#${e.target}`);
    if (!same(ev('Bulbasaur'), ['1:16->Ivysaur#2'])) return 'Bulbasaur ' + J(ev('Bulbasaur'));
    if (!same(ev('Ivysaur'), ['1:32->Venusaur#3'])) return 'Ivysaur ' + J(ev('Ivysaur'));
    if (!same(ev('Pikachu'), ['3:213->Raichu#26', '3:164->Raichu#958'])) return 'Pikachu ' + J(ev('Pikachu'));
    if (spByName('Eevee').evolutions.length !== 10) return 'Eevee has ' + spByName('Eevee').evolutions.length + ' records';
    const nin = spByName('Nincada').evolutions.find((e) => pack.species[e.target].name === 'Shedinja');
    return (nin && nin.method === 4 && same(nin.conditions, [[36, 1, 1, 0]])) || 'Nincada->Shedinja ' + J(nin);
  });
  return R;
}

// ---------------------------------------------------------------------------------------------
// A. hashing
// ---------------------------------------------------------------------------------------------
head('A. hashing (pure-JS SHA-256 / MD5 used for the ROM identity pin)');
{
  const enc = (s) => new TextEncoder().encode(s);
  const kat = [
    ['sha256("")', sha256Hex(enc('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['sha256("abc")', sha256Hex(enc('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['sha256(448-bit NIST)', sha256Hex(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['md5("")', md5Hex(enc('')), 'd41d8cd98f00b204e9800998ecf8427e'],
    ['md5("abc")', md5Hex(enc('abc')), '900150983cd24fb0d6963f7d28e17f72'],
    ['md5("message digest")', md5Hex(enc('message digest')), 'f96b697d7cb7938d525a2f31aaf161d0'],
  ];
  for (const [n, got, want] of kat) t(`known answer ${n}`, got === want, `${got} != ${want}`);
  // lengths that straddle the 55/56/64 padding boundaries, against node:crypto
  let boundaryOk = true;
  for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000]) {
    const b = new Uint8Array(n).map((_, i) => (i * 131 + 7) & 255);
    if (sha256Hex(b) !== crypto.createHash('sha256').update(b).digest('hex') || md5Hex(b) !== crypto.createHash('md5').update(b).digest('hex')) boundaryOk = false;
  }
  t('matches node:crypto at every padding boundary length', boundaryOk);
  let sinBad = 0;
  for (let i = 0; i < 64; i++) if ((Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0) !== MD5_T[i]) sinBad++;
  t('MD5 T table equals floor(abs(sin(i+1))*2^32) for all 64 entries', sinBad === 0, `${sinBad} entries differ`);
  const tHash = process.hrtime.bigint();
  const sha = sha256Hex(rom);
  const msSha = Number(process.hrtime.bigint() - tHash) / 1e6;
  const md5 = md5Hex(rom);
  t('ROM sha256 == pinned == node:crypto', sha === PINNED.sha256 && sha === crypto.createHash('sha256').update(rom).digest('hex'), sha);
  t('ROM md5 == pinned == node:crypto', md5 === PINNED.md5 && md5 === crypto.createHash('md5').update(rom).digest('hex'), md5);
  console.log(`  info pure-JS sha256 over ${rom.length} bytes: ${msSha.toFixed(0)} ms`);
}

// ---------------------------------------------------------------------------------------------
// B. identity / refusal
// ---------------------------------------------------------------------------------------------
head('B. ROM identity and refusal of any other ROM');
{
  const h = readHeader(rom);
  t('length is 33,554,432', rom.length === 33554432, String(rom.length));
  t('header: POKEMON EMER / BPEE / maker 01 / fixed 0x96 / version 0 / checksum 0x72 valid', h.title === 'POKEMON EMER' && h.gameCode === 'BPEE' && h.makerCode === '01' && h.fixedByte === 0x96 && h.version === 0 && h.headerChecksum === 0x72 && h.headerChecksumOk, J(h));
  t('identify(): full hash passes', identify(rom, { hash: 'full' }).ok === true);
  const refused = (label, buf, mode) => {
    let err = null;
    try { loadPack(buf, mode ? { verify: mode } : {}); } catch (e) { err = e; }
    t(`REFUSED: ${label}`, err instanceof RomMismatchError, err ? `${err.name}: ${err.message.slice(0, 90)}` : 'loadPack accepted it');
  };
  const flip = Buffer.from(rom); flip[0x1f00000] ^= 1;
  refused('one bit flipped at 0x1f00000 (outside every table)', flip);
  const flipHdr = Buffer.from(rom); flipHdr[0xa0] ^= 0x20;
  refused('header title edited', flipHdr, 'header');
  refused('truncated to 32,000,000 bytes', rom.subarray(0, 32000000), 'header');
  refused('empty buffer', new Uint8Array(0), 'header');
  const otherVer = Buffer.from(rom); otherVer[0xbc] = 1;
  refused('header version byte 1 (a different release)', otherVer, 'header');
  // twin: the same pipeline with NO edit must be accepted
  let accepted = true;
  try { loadPack(Buffer.from(rom), { dexText: false }); } catch { accepted = false; }
  t('twin: an unedited copy of the ROM is accepted by the same call', accepted);
  let typeErr = false;
  try { loadPack('not bytes'); } catch (e) { typeErr = e instanceof TypeError; }
  t('non-byte input rejected with TypeError', typeErr);
}

if (failed > 0) {
  // Not the pinned ROM (or the hashing is broken): every later section would report noise about the wrong file.
  console.log(`\nidentity section failed -> stopping before the table checks\n\n${passed} passed, ${failed} failed\n\nFAILURES:`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// B2. the async path -- the one a page actually calls -- has its own identity gate
// ---------------------------------------------------------------------------------------------
head('B2. async identity gate (loadPackAsync / assertPinnedAsync / sha256HexFast)');
{
  const refusedAsync = async (label, buf) => {
    let err = null;
    try { await loadPackAsync(buf); } catch (e) { err = e; }
    t(`REFUSED (async): ${label}`, err instanceof RomMismatchError, err ? `${err.name}: ${err.message.slice(0, 90)}` : 'loadPackAsync accepted it');
    return err;
  };
  const flipAsync = Buffer.from(rom); flipAsync[0x1f00000] ^= 1;
  const e1 = await refusedAsync('one bit flipped at 0x1f00000 (length, header and every table intact)', flipAsync);
  t('...and the refusal names the sha256 mismatch', Boolean(e1) && /sha256/.test(e1.message));
  const flipTable = Buffer.from(rom); flipTable[LAYOUT.species.offset + 5] ^= 1;
  await refusedAsync('one bit flipped inside the species table', flipTable);
  const flipTitle = Buffer.from(rom); flipTitle[0xa0] ^= 0x20;
  const eT = await refusedAsync('header title edited', flipTitle);
  const eL = await refusedAsync('truncated to 32,000,000 bytes', rom.subarray(0, 32000000));
  await refusedAsync('empty buffer', new Uint8Array(0));
  // The cheap header/length reasons must be reported BEFORE the 32 MiB hash is computed (fast failure, and the reason names the real problem).
  t('...a header edit is refused on the header (message names the title, no sha256 mismatch)', Boolean(eT) && /title/.test(eT.message) && !/sha256/.test(eT.message), eT && eT.message.slice(0, 100));
  t('...a truncated ROM is refused on its length (message names the length, no sha256 mismatch)', Boolean(eL) && /length 32000000/.test(eL.message) && !/sha256/.test(eL.message), eL && eL.message.slice(0, 100));
  let direct = null;
  try { await assertPinnedAsync(flipAsync); } catch (e) { direct = e; }
  t('REFUSED (async): assertPinnedAsync alone, on the bit-flipped buffer', direct instanceof RomMismatchError);
  // twin: the same calls on an unedited copy must succeed and agree with the sync loader
  let okPack = null;
  try { okPack = await loadPackAsync(Buffer.from(rom)); } catch { okPack = null; }
  t('twin: an unedited copy is accepted by loadPackAsync and yields the identical pack as loadPack', okPack !== null && same(okPack, loadPack(rom)));
  const small = new Uint8Array(1000).map((_, i) => (i * 7 + 3) & 255);
  const refSha = crypto.createHash('sha256').update(small).digest('hex');
  t('sha256HexFast (WebCrypto) equals the pure-JS and node:crypto digests', (await sha256HexFast(small)) === refSha && sha256Hex(small) === refSha);
  // An insecure (plain http, non-localhost) page has NO crypto.subtle: the hash must fall back to pure JS, and the gate must still bite.
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let fb = null, fbRefused = null, fbAccepted = null, subtleGone = false;
  try {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    subtleGone = !(globalThis.crypto && globalThis.crypto.subtle);
    fb = await sha256HexFast(small);
    try { await loadPackAsync(flipAsync); fbRefused = false; } catch (e) { fbRefused = e instanceof RomMismatchError; }
    try { await loadPackAsync(Buffer.from(rom), { dexText: false }); fbAccepted = true; } catch { fbAccepted = false; }
  } finally {
    if (desc) Object.defineProperty(globalThis, 'crypto', desc); else delete globalThis.crypto;
  }
  t('without crypto.subtle: sha256HexFast falls back to the pure-JS digest', subtleGone && fb === refSha, `subtleGone ${subtleGone}, ${fb}`);
  t('without crypto.subtle: loadPackAsync still refuses the bit-flipped ROM and accepts the unedited twin', fbRefused === true && fbAccepted === true, `refused ${fbRefused}, accepted ${fbAccepted}`);
  t('crypto.subtle is restored after the fallback test', Boolean(globalThis.crypto && globalThis.crypto.subtle));
}

// ---------------------------------------------------------------------------------------------
// C. charset
// ---------------------------------------------------------------------------------------------
head('C. charset (both directions)');
{
  t('CORE and RECALLED tables are disjoint, 256 entries, no duplicate glyph', (() => {
    const seen = new Map();
    for (let b = 0; b < 256; b++) { const c = CHARSET[b]; if (c === null) continue; if (seen.has(c)) return false; seen.set(c, b); }
    return CHARSET.length === 256 && !CORE_BYTES.some((b) => RECALLED_BYTES.includes(b));
  })());
  t(`CORE bytes = ${CORE_BYTES.length}, RECALLED (unverified against this ROM) bytes = ${RECALLED_BYTES.length}`, CORE_BYTES.length > 90 && RECALLED_BYTES.length > 30);
  t('0xFF terminates; 0xFE is newline; 0x00 is space', defaultCodec.decode([0xca, 0xdd, 0xff, 0xca]) === 'Pi' && defaultCodec.decode([0xfe]) === '\n' && defaultCodec.decode([0x00]) === ' ');
  const enc = defaultCodec.encode('Pikachu');
  t('encode("Pikachu") = CA DD DF D5 D7 DC E9 FF', J([...enc]) === J([0xca, 0xdd, 0xdf, 0xd5, 0xd7, 0xdc, 0xe9, 0xff]), J([...enc]));
  t('apostrophe/degree aliases encode to the canonical bytes', defaultCodec.encode("Farfetch'd", { terminate: false }).includes(0xb4) && same([...defaultCodec.encode('\u2019', { terminate: false })], [0xb4]) && same([...defaultCodec.encode('\u00b0', { terminate: false })], [0x2a]));
  t('digraph tokens: {PK}{MN} encode to 53 54 and display as PKMN', same([...defaultCodec.encode('{PK}{MN}', { terminate: false })], [0x53, 0x54]) && displayText('wild {PK}{MN}') === 'wild PKMN' && displayText('{K' + E + '}') === 'K' + E);
  t('fixed-width field pads with 0x00 after the terminator', same([...defaultCodec.encode('Mew', { width: 6 })], [0xc7, 0xd9, 0xeb, 0xff, 0, 0]));
  let threw = false;
  try { defaultCodec.encode('\u30c4'); } catch { threw = true; }
  t('unencodable character throws', threw);
  // an undefined byte whose hex needs a letter: the token must be UPPERCASE, because hasUnknownTokens() only looks for uppercase
  t('undefined byte 0xFA decodes to the token {FA} and hasUnknownTokens() sees it', CHARSET[0xfa] === null && defaultCodec.decode([0xfa]) === '{FA}' && hasUnknownTokens(defaultCodec.decode([0xca, 0xfa])) && !hasUnknownTokens('Pikachu {PK}'));
  // fixed-width fields: the 0x00 pad decodes to spaces, decodeField removes them, decode() keeps them
  const padded = Uint8Array.from([0xca, 0xdd, 0, 0, 0, 0]);
  t('decodeField trims the 0x00 padding that decode() keeps', defaultCodec.decodeField(padded, 0, 6) === 'Pi' && defaultCodec.decode(padded, 0, 6) === 'Pi    ' && defaultCodec.decodeField(Uint8Array.from([0, 0, 0]), 0, 3) === '');
  // lossless for ANY byte string (seeded LCG, no Math.random)
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 8;
  let lossless = true;
  for (let n = 0; n < 400; n++) {
    const len = 1 + (rnd() % 40);
    const bytes = Array.from({ length: len }, () => { let b = rnd() & 255; return b === 0xff ? 0xfe : b; });
    const back = defaultCodec.encode(defaultCodec.decode(bytes), { terminate: false });
    if (!same([...back], bytes)) { lossless = false; break; }
  }
  t('decode -> encode is lossless for 400 random byte strings (incl. undefined bytes as {XX})', lossless);
  // negative control: a table with two letters swapped decodes names wrongly -> the pack checks must notice
  const swapped = [...CHARSET]; [swapped[0xd5], swapped[0xd9]] = [swapped[0xd9], swapped[0xd5]]; // a <-> e
  const badCodec = createCodec(swapped);
  const badPack = loadPack(rom, { verify: 'none', codec: badCodec, dexText: false });
  const badRes = runChecks(badPack, { rom, codec: badCodec }).filter((r) => !r.ok).map((r) => r.id);
  t('NEGATIVE CONTROL: codec with a<->e swapped trips species/bulbasaur and moves/spot-checks', badRes.includes('species/bulbasaur') && badRes.includes('moves/spot-checks') && badRes.includes('abilities/samples'), J(badRes));
  let dupThrew = false;
  try { const dup = [...CHARSET]; dup[0xd5] = dup[0xd6]; createCodec(dup); } catch { dupThrew = true; }
  t('NEGATIVE CONTROL: a table mapping two bytes to one glyph is rejected at construction', dupThrew);
}

// ---------------------------------------------------------------------------------------------
// D. pack checks on the unmodified ROM
// ---------------------------------------------------------------------------------------------
head('D. pack checks (unmodified ROM)');
const ctx = { rom, codec: defaultCodec, layout: LAYOUT };
let golden;
try { golden = loadPack(rom); } catch (e) {
  t('loadPack(ROM) on the unmodified ROM', false, `${e.name}: ${e.message}`);
  console.log(`\n${passed} passed, ${failed} failed\n\nFAILURES:`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1); // every later section needs a good pack
}
const goldenRes = runChecks(golden, ctx);
for (const r of goldenRes) t(r.id, r.ok, r.detail);
console.log(`  info ${goldenRes.length} named checks, ${goldenRes.filter((r) => r.ok).length} pass`);
t('pack.rom records the verified sha256', golden.rom.sha256 === PINNED.sha256 && golden.rom.verified === 'sha256');
{
  // Controls for the checks that no ROM byte-flip can reach: poison a deep copy of the pack and require the specific check to fail.
  const poison = (edit) => { const p = JSON.parse(JSON.stringify(golden)); edit(p); return runChecks(p, ctx).filter((r) => !r.ok).map((r) => r.id); };
  const A = String.fromCharCode(0xc0); // A-grave: in the RECALLED table only, never used by this ROM
  const f1 = poison((p) => { p.moves[5].power = NaN; });
  t('NEGATIVE CONTROL: pack/jsonable notices a NaN', f1.includes('pack/jsonable'), J(f1));
  const f2 = poison((p) => { p.species[25].dexText = new Map(); });
  t('NEGATIVE CONTROL: pack/jsonable notices a Map', f2.includes('pack/jsonable'), J(f2));
  const f3 = poison((p) => { delete p.species[25]; });
  t('NEGATIVE CONTROL: pack/jsonable notices an array hole', f3.includes('pack/jsonable'), J(f3));
  const f4 = poison((p) => { p.species[25].name = 'Pikachu' + A; });
  t('NEGATIVE CONTROL: a name using a byte outside the verified CORE table trips text/roundtrip-and-verified-bytes', f4.includes('text/roundtrip-and-verified-bytes') && f4.includes('species/pikachu'), J(f4));
  const f5 = poison((p) => { p.moves[1].name = 'Pou{7D}d'; });
  t('NEGATIVE CONTROL: an undecoded {XX} token trips text/no-unknown-tokens', f5.includes('text/no-unknown-tokens'), J(f5));
  const f6 = poison((p) => { p.roster.pop(); });
  t('NEGATIVE CONTROL: a roster missing one legal species trips species/slots-and-roster', f6.includes('species/slots-and-roster'), J(f6));
  const f7 = poison(() => {});
  t('twin of the controls above: an unpoisoned deep copy is silent', f7.length === 0, J(f7));
}

// ---------------------------------------------------------------------------------------------
// E. manifest
// ---------------------------------------------------------------------------------------------
head('E. manifest.json vs code');
{
  const mpath = path.join(root, 'pokemonarena', 'manifest.json');
  const man = JSON.parse(fs.readFileSync(mpath, 'utf8'));
  t('manifest rom block equals PINNED', man.rom.length === PINNED.length && man.rom.sha256 === PINNED.sha256 && man.rom.md5 === PINNED.md5 && man.rom.title === PINNED.title && man.rom.gameCode === PINNED.gameCode && man.rom.makerCode === PINNED.makerCode && Number(man.rom.fixedByte) === PINNED.fixedByte && man.rom.version === PINNED.version && Number(man.rom.headerChecksum) === PINNED.headerChecksum && man.rom.fileName === PINNED.fileName);
  const fromMan = {};
  for (const [k, v] of Object.entries(man.layout)) { fromMan[k] = {}; for (const [f, x] of Object.entries(v)) fromMan[k][f] = f === 'offset' ? Number(x) : x; }
  t('manifest layout equals LAYOUT (every table, every field)', same(fromMan, JSON.parse(JSON.stringify(LAYOUT))), J(fromMan).slice(0, 80));
  t('manifest has no ROM-derived content (only keys: schema, note, rom, layout; no strings beyond hashes/ids)', same(Object.keys(man), ['schema', 'note', 'rom', 'layout']));
  // Declared cross-stage dependency: the three modules are .js ES modules and Node treats .js as ESM only through the nearest package.json
  // (pokemonarena/package.json, owned by another stage) -- or, from Node 22.7, by syntax detection.
  let pjType = null;
  try { pjType = JSON.parse(fs.readFileSync(path.join(root, 'pokemonarena', 'package.json'), 'utf8')).type; } catch { pjType = null; }
  t('dependency on pokemonarena/package.json: it exists and declares "type":"module"', pjType === 'module', `type = ${J(pjType)}; without it Node < 22.7 cannot import the .js modules`);
  const viaManifest = loadPack(rom, { layout: fromMan });
  t('loading with the layout taken FROM the manifest reproduces the identical pack', same(viaManifest, golden));
  // negative controls: a drifted table offset must either be refused by the loader or trip the checks
  const tryLayout = (layout) => {
    try { return { failing: runChecks(loadPack(rom, { verify: 'none', layout }), { ...ctx, layout }).filter((r) => !r.ok).map((r) => r.id) }; } catch (e) { return { threw: e instanceof RomFormatError ? 'RomFormatError: ' + e.message.slice(0, 70) : 'WRONG ERROR ' + e.name }; }
  };
  const drift = JSON.parse(JSON.stringify(fromMan)); drift.species.offset += LAYOUT.species.stride;
  const dr = tryLayout(drift);
  t('NEGATIVE CONTROL: species offset drifted by one row is caught', Boolean(dr.threw && dr.threw.startsWith('RomFormatError')) || (dr.failing && dr.failing.includes('species/bulbasaur')), J(dr));
  const drift1 = JSON.parse(JSON.stringify(fromMan)); drift1.species.slots -= 1;
  const dr1 = tryLayout(drift1);
  t('NEGATIVE CONTROL: species slot count 1579 -> 1578 trips pack/counts (the egg slot is no longer decoded)', dr1.failing && dr1.failing.includes('pack/counts'), J(dr1));
  const drift2 = JSON.parse(JSON.stringify(fromMan)); drift2.moves.offset += 4;
  const d2 = tryLayout(drift2);
  t('NEGATIVE CONTROL: moves offset drifted by 4 bytes is caught', Boolean(d2.threw) || d2.failing.some((x) => x.startsWith('moves/')), J(d2));
  const drift3 = JSON.parse(JSON.stringify(fromMan)); drift3.typeChart.offset += 4;
  const d3 = tryLayout(drift3);
  t('NEGATIVE CONTROL: type chart offset drifted by one cell trips types/chart-canonical', d3.failing && d3.failing.includes('types/chart-canonical'), J(d3));
  // The exact earlier bug: anchoring the item table on the name-pointer field (start + 0x14) instead of the record start.
  const drift4 = JSON.parse(JSON.stringify(fromMan)); drift4.items.offset += 0x14;
  const d4 = tryLayout(drift4);
  t('NEGATIVE CONTROL: item table anchored on the name pointer (start + 0x14) is caught', Boolean(d4.threw) || (d4.failing.includes('items/prices-and-hold') && d4.failing.includes('items/table-extent-and-code-refs')), J(d4));
  // ...and one record late/early, which keeps the string pool boundary wrong too
  const drift5 = JSON.parse(JSON.stringify(fromMan)); drift5.items.offset += LAYOUT.items.stride;
  const d5 = tryLayout(drift5);
  t('NEGATIVE CONTROL: item table shifted by one whole record is caught', Boolean(d5.threw) || (d5.failing.includes('items/prices-and-hold') && d5.failing.includes('items/table-extent-and-code-refs')), J(d5));
  const twin = tryLayout(JSON.parse(JSON.stringify(fromMan)));
  t('twin of the layout controls: the unshifted layout trips nothing', twin.failing && twin.failing.length === 0, J(twin));
}

// ---------------------------------------------------------------------------------------------
// F. mutants: corrupt one table region at a time
// ---------------------------------------------------------------------------------------------
head('F. mutation controls (each corrupts one table region; must trip the named check and nothing outside its family)');
{
  const dvOf = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const sOff = (id) => LAYOUT.species.offset + id * LAYOUT.species.stride;
  const mOff = (id) => LAYOUT.moves.offset + id * LAYOUT.moves.stride;
  const aOff = (id) => LAYOUT.abilities.offset + id * LAYOUT.abilities.stride;
  const iOff = (id) => LAYOUT.items.offset + id * LAYOUT.items.stride;
  const gdv = dvOf(rom);
  const g32 = (o) => gdv.getUint32(o, true);
  const moveId = (n) => golden.moves.find((m) => m.name === n).id;
  const typeId = (n) => TYPE_NAMES.indexOf(n);
  const chartOff = (a, d) => LAYOUT.typeChart.offset + (typeId(a) * 21 + typeId(d)) * 4;
  const fn = (n, ...a) => ({ n, a });
  const MUTANTS = [
    { id: 'twin-noop', desc: 'no edit (the twin: same copy/patch/load/check path)', patch: () => {}, expectFail: [], only: [] },
    { id: 'species-stat', desc: 'Bulbasaur HP 45 -> 46', patch: (b) => { b[sOff(1)] = 46; }, expectFail: ['species/bulbasaur'], only: ['species/', 'pack/counts'] },
    { id: 'species-name', desc: 'Pikachu name P -> Q', patch: (b) => { b[sOff(25) + 0x33] += 1; }, expectFail: ['species/pikachu'], only: ['species/', 'text/', 'evolutions/'] },
    { id: 'species-zeroed', desc: 'one stray byte written into the all-zero slot 21 (Spearow)', patch: (b) => { b[sOff(21) + 5] = 1; }, expectFail: ['species/slots-and-roster'], only: ['species/', 'pack/counts', 'learn/', 'text/', 'evolutions/'] },
    { id: 'species-zeroed-last-byte', desc: 'one stray byte written into the LAST byte of the all-zero slot 21 (Spearow)', patch: (b) => { b[sOff(21) + LAYOUT.species.stride - 1] = 1; }, expectFail: ['species/slots-and-roster'], only: ['species/', 'pack/counts', 'learn/', 'text/', 'evolutions/'] },
    { id: 'move-power', desc: 'Thunderbolt power 90 -> 91', patch: (b) => { const d = dvOf(b); d.setUint16(mOff(moveId('Thunderbolt')) + 0x0a, d.getUint16(mOff(moveId('Thunderbolt')) + 0x0a, true) + (1 << 7), true); }, expectFail: ['moves/spot-checks'], only: ['moves/'] },
    { id: 'move-category', desc: 'Pound Physical -> Special', patch: (b) => { const d = dvOf(b); const o = mOff(moveId('Pound')) + 0x0a; d.setUint16(o, (d.getUint16(o, true) & ~(3 << 5)) | (1 << 5), true); }, expectFail: ['moves/categories', 'moves/spot-checks'], only: ['moves/'] },
    { id: 'move-priority', desc: 'Quick Attack priority nibble +1 -> +2', patch: (b) => { b[mOff(moveId('Quick Attack')) + 0x14] += 1; }, expectFail: ['moves/priority-histogram', 'moves/spot-checks'], only: ['moves/'] },
    { id: 'move-flag', desc: 'Tackle contact bit cleared', patch: (b) => { b[mOff(moveId('Tackle')) + 0x16] &= ~1; }, expectFail: ['moves/flag-samples'], only: ['moves/'] },
    { id: 'move-extra-effect', desc: 'Thunder Fang second additional-effect chance 10 -> 200', patch: (b) => { const p = g32(mOff(moveId('Thunder Fang')) + 0x2c) - 0x08000000; b[p + 4 + 3] = 200; }, expectFail: ['moves/additional-effects'], only: ['moves/'] },
    { id: 'levelup-order', desc: 'Bulbasaur first level-up level 1 -> 50', patch: (b) => { const p = g32(sOff(1) + 0xa8) - 0x08000000; dvOf(b).setUint16(p + 2, 50, true); }, expectFail: ['learn/levelup-ascending-and-in-range', 'learn/bulbasaur-levelup'], only: ['learn/'] },
    { id: 'levelup-move-id', desc: 'Bulbasaur first level-up move id -> 0x3000', patch: (b) => { const p = g32(sOff(1) + 0xa8) - 0x08000000; dvOf(b).setUint16(p, 0x3000, true); }, expectFail: ['learn/levelup-ascending-and-in-range'], only: ['learn/'] },
    { id: 'teachable-id', desc: 'Pikachu teachable[0] -> 936 (one past the last move)', patch: (b) => { const p = g32(sOff(25) + 0xac) - 0x08000000; dvOf(b).setUint16(p, 936, true); }, expectFail: ['learn/move-ids-in-range'], only: ['learn/'] },
    { id: 'egg-move', desc: 'Bulbasaur egg move[0] -> 0', patch: (b) => { const p = g32(sOff(1) + 0xb0) - 0x08000000; dvOf(b).setUint16(p, 0, true); }, expectFail: ['learn/move-ids-in-range'], only: ['learn/'] },
    { id: 'tutor-table', desc: 'tutor table entry 10 -> another tutor move', patch: (b) => { const o = LAYOUT.tutors.offset; const d = dvOf(b); d.setUint16(o + 20, d.getUint16(o + 22, true), true); }, expectFail: ['learn/tutor-table'], only: ['learn/'] },
    { id: 'chart-cell', desc: 'Fire -> Grass 2x -> 1x', patch: (b) => { dvOf(b).setUint32(chartOff('Fire', 'Grass'), 0x1000, true); }, expectFail: ['types/chart-canonical', 'types/chart-counts'], only: ['types/'], detailHas: ['Fire->Grass: ROM 1x vs canon 2x'] },
    { id: 'chart-transposed', desc: 'Grass -> Fire and Fire -> Grass swapped (transposed pair)', patch: (b) => { const d = dvOf(b); const a = chartOff('Fire', 'Grass'), c = chartOff('Grass', 'Fire'); const x = d.getUint32(a, true), y = d.getUint32(c, true); d.setUint32(a, y, true); d.setUint32(c, x, true); }, expectFail: ['types/chart-canonical'], only: ['types/'], detailHas: ['Fire->Grass', 'Grass->Fire'] },
    { id: 'chart-value', desc: 'a cell holds 0x3000 (not a legal multiplier)', patch: (b) => { dvOf(b).setUint32(chartOff('Water', 'Fire'), 0x3000, true); }, expectFail: ['types/chart-values', 'types/chart-canonical'], only: ['types/'] },
    { id: 'chart-pseudo', desc: 'Stellar attacker row: one cell 2x', patch: (b) => { dvOf(b).setUint32(chartOff('Stellar', 'Normal'), 0x2000, true); }, expectFail: ['types/chart-pseudo-neutral'], only: ['types/'] },
    { id: 'type-name', desc: 'type 13 name "Grass" -> "Hrass"', patch: (b) => { b[LAYOUT.types.offset + 13 * LAYOUT.types.stride] += 1; }, expectFail: ['types/names'], only: ['types/', 'text/', 'moves/', 'species/'] },
    { id: 'ability-name', desc: 'Overgrow -> Pvergrow', patch: (b) => { b[aOff(65)] += 1; }, expectFail: ['abilities/samples'], only: ['abilities/', 'text/'] },
    { id: 'ability-desc-ptr', desc: 'Static short-text pointer -> Overgrow short-text pointer', patch: (b) => { dvOf(b).setUint32(aOff(9) + 0x14, g32(aOff(65) + 0x14), true); }, expectFail: ['abilities/samples'], only: ['abilities/'] },
    { id: 'item-desc-frame', desc: 'item 1 and item 2 description words swapped', patch: (b) => { const d = dvOf(b); const x = g32(iOff(1) + 0x0c), y = g32(iOff(2) + 0x0c); d.setUint32(iOff(1) + 0x0c, y, true); d.setUint32(iOff(2) + 0x0c, x, true); }, expectFail: ['items/descriptions-aligned'], only: ['items/'] },
    { id: 'item-price', desc: 'Leftovers price 20000 -> 20001', patch: (b) => { b[iOff(472) + 0x00] += 1; }, expectFail: ['items/prices-and-hold'], only: ['items/'] },
    { id: 'item-price-potion', desc: 'Potion price 200 -> 201 (the word a late-reading decoder would give to the PREVIOUS item)', patch: (b) => { b[iOff(28) + 0x00] += 1; }, expectFail: ['items/prices-and-hold'], only: ['items/'] },
    { id: 'item-price-last', desc: 'last record (Soggy Herb, formerly called damaged) price 20 -> 21', patch: (b) => { b[iOff(929) + 0x00] += 1; }, expectFail: ['items/prices-and-hold', 'items/all-records-intact'], only: ['items/'] },
    { id: 'item-hold-param', desc: 'Leftovers hold-effect parameter 10 -> 11', patch: (b) => { b[iOff(472) + 0x1d] += 1; }, expectFail: ['items/prices-and-hold'], only: ['items/'] },
    { id: 'item-name-ptr', desc: 'Great Ball name pointer -> Ultra Ball name pointer', patch: (b) => { dvOf(b).setUint32(iOff(2) + 0x14, g32(iOff(3) + 0x14), true); }, expectFail: ['items/count-and-names'], only: ['items/', 'text/', 'machines/'] },
    { id: 'species-egg-group', desc: 'Pikachu egg group 2 (Fairy) -> Monster', patch: (b) => { b[sOff(25) + 0x17] = 1; }, expectFail: ['species/breeding-and-yield-fields'], only: ['species/'] },
    { id: 'species-exp-yield', desc: 'Snorlax base experience 189 -> 190', patch: (b) => { b[sOff(143) + 0x0a] += 1; }, expectFail: ['species/breeding-and-yield-fields'], only: ['species/'] },
    { id: 'species-egg-cycles', desc: 'Mewtwo egg cycles 120 -> 121', patch: (b) => { b[sOff(150) + 0x13] += 1; }, expectFail: ['species/breeding-and-yield-fields'], only: ['species/'] },
    { id: 'species-cry-id', desc: 'Pikachu cry id 24 -> 25', patch: (b) => { b[sOff(25) + 0x40] += 1; }, expectFail: ['species/cry-id-regression-pins'], only: ['species/'] },
    { id: 'ability-ai-rating', desc: 'Truant AI rating -2 (0xFE) -> +2', patch: (b) => { b[aOff(54) + 0x1c] = 2; }, expectFail: ['abilities/ai-rating-signed'], only: ['abilities/'] },
    { id: 'ability-long-ptr', desc: 'Static long-text pointer -> its short-text pointer', patch: (b) => { dvOf(b).setUint32(aOff(9) + 0x18, g32(aOff(9) + 0x14), true); }, expectFail: ['abilities/long-text'], only: ['abilities/'] },
    { id: 'tmhm-entry', desc: 'TM table entry 0 (Work Up) -> Dragon Claw', patch: (b) => { dvOf(b).setUint16(LAYOUT.tmhm.offset, moveId('Dragon Claw'), true); }, expectFail: ['machines/match-item-names', 'machines/copies-agree', 'machines/shape'], only: ['machines/', 'learn/', 'items/'] },
    { id: 'nature-effect', desc: 'Lonely: swap +Atk/-Def to +Def/-Atk', patch: (b) => { const o = LAYOUT.natures.offset + 1 * LAYOUT.natures.stride; b[o + 4] = 2; b[o + 5] = 1; }, expectFail: ['natures/effects'], only: ['natures/'] },
    { id: 'exp-row', desc: 'Medium Slow row, level 50 lowered by one', patch: (b) => { const o = LAYOUT.exp.offset + (3 * 101 + 50) * 4; const d = dvOf(b); d.setUint32(o, d.getUint32(o, true) - 1, true); }, expectFail: ['exp/shape-and-values'], only: ['exp/'] },
    { id: 'exp-monotonic', desc: 'Fast row, level 60 dropped below level 59', patch: (b) => { dvOf(b).setUint32(LAYOUT.exp.offset + (4 * 101 + 60) * 4, 5, true); }, expectFail: ['exp/monotonic', 'exp/shape-and-values'], only: ['exp/'] },
    { id: 'evo-target', desc: 'Bulbasaur -> Ivysaur target changed to empty slot 1288', patch: (b) => { const p = g32(sOff(1) + 0xb4) - 0x08000000; dvOf(b).setUint16(p + 4, 1288, true); }, expectFail: ['evolutions/targets-valid', 'evolutions/samples'], only: ['evolutions/'] },
    { id: 'evo-terminator', desc: 'Pikachu second evolution record method -> 0xFFFF (list ends early)', patch: (b) => { const p = g32(sOff(25) + 0xb4) - 0x08000000; dvOf(b).setUint16(p + 12, 0xffff, true); }, expectFail: ['pack/counts', 'evolutions/count-and-methods', 'evolutions/samples'], only: ['evolutions/', 'pack/counts'] },
    { id: 'evo-condition', desc: 'Nincada->Shedinja condition id 36 -> 35', patch: (b) => { const s = golden.species.find((x) => x && x.name === 'Nincada'); const p = g32(sOff(s.id) + 0xb4) - 0x08000000; const rec = [0, 1].map((k) => p + 12 * k).find((q) => dvOf(b).getUint16(q, true) === 4); const c = g32(rec + 8) - 0x08000000; dvOf(b).setUint16(c, 35, true); }, expectFail: ['evolutions/samples'], only: ['evolutions/'] },
    { id: 'form-table', desc: 'Venusaur form list: second id -> an empty slot', patch: (b) => { const p = g32(sOff(3) + 0xb8) - 0x08000000; dvOf(b).setUint16(p + 2, 1288, true); }, expectFail: ['species/forms'], only: ['species/'] },
    { id: 'pointer-wild', desc: 'Bulbasaur level-up pointer -> 0x00000001 (not a ROM address)', patch: (b) => { dvOf(b).setUint32(sOff(1) + 0xa8, 1, true); }, expectThrow: /species: bad ROM pointer 0x1/, },
    { id: 'string-unterminated', desc: 'Pound name pointer -> a region of 0x00 bytes with no 0xFF within 1 KiB', patch: (b) => { dvOf(b).setUint32(mOff(1), 0x08000000 + 0x7f0000, true); }, expectThrow: /moves: unterminated string/, prepare: (b) => { b.fill(0, 0x7f0000, 0x7f0000 + 4096); } },
  ];
  for (const m of MUTANTS) {
    const buf = Buffer.from(rom);
    if (m.prepare) m.prepare(buf);
    m.patch(buf);
    let pack = null, thrown = null;
    try { pack = loadPack(buf, { verify: 'none' }); } catch (e) { thrown = e; }
    if (m.expectThrow) {
      t(`mutant ${m.id}: ${m.desc} -> loader throws ${m.expectThrow}`, thrown instanceof RomFormatError && m.expectThrow.test(thrown.message), thrown ? `${thrown.name}: ${thrown.message}` : 'loaded without error');
      continue;
    }
    if (thrown) { t(`mutant ${m.id}: ${m.desc}`, false, `loader threw ${thrown.name}: ${thrown.message}`); continue; }
    const res = runChecks(pack, ctx);
    const failing = res.filter((r) => !r.ok);
    const ids = failing.map((r) => r.id);
    const missing = m.expectFail.filter((id) => !ids.includes(id));
    const stray = ids.filter((id) => !m.only.some((p) => id.startsWith(p)));
    let detailOk = true;
    if (m.detailHas) { const all = failing.map((r) => r.detail).join(' | '); detailOk = m.detailHas.every((s) => all.includes(s)); }
    const shown = ids.length ? ids.join(', ') : '(none)';
    if (m.expectFail.length === 0) t(`mutant ${m.id}: ${m.desc} -> silent`, ids.length === 0, `unexpected failures: ${shown}`);
    else t(`mutant ${m.id}: ${m.desc} -> trips ${m.expectFail[0]}${m.expectFail.length > 1 ? ' (+' + (m.expectFail.length - 1) + ')' : ''}`, missing.length === 0 && stray.length === 0 && detailOk, `missing ${J(missing)} stray ${J(stray)} detailOk ${detailOk}; failing: ${shown}`);
    if (m.expectFail.length) console.log(`       tripped: ${shown}${m.detailHas ? '\n       detail: ' + failing.find((r) => r.id === m.expectFail[0]).detail.slice(0, 160) : ''}`);
  }
  // identity mutant through identify(): one flipped bit outside every table changes only the hash
  const ob = Buffer.from(rom); ob[0x1f00000] ^= 1;
  const idr = identify(ob, { hash: 'sha256' });
  t('mutant rom-bitflip: identify() fails on sha256 alone (header and length still pass)', !idr.ok && idr.reasons.length === 1 && /^sha256/.test(idr.reasons[0]) && identify(ob, { hash: 'none' }).ok, J(idr.reasons));
  const noPack = (() => { try { return loadPack(ob, { verify: 'none', dexText: false }); } catch { return null; } })();
  t('...and with verification off that same buffer still decodes (proving the hash gate, not the decoder, is what refuses it)', noPack !== null && same(noPack.counts, golden.counts));
}

// ---------------------------------------------------------------------------------------------
// G. determinism, hygiene, timing
// ---------------------------------------------------------------------------------------------
head('G. determinism, size and decode time');
{
  const a = loadPack(rom, { verify: 'none' }), b = loadPack(rom, { verify: 'none' });
  t('two loads are deeply identical', same(a, b));
  t('pack with verify:none differs from the verified pack only in pack.rom', same({ ...a, rom: null }, { ...golden, rom: null }) && a.rom.verified === 'none');
  const copyBuf = new Uint8Array(rom.buffer.slice(rom.byteOffset, rom.byteOffset + rom.byteLength));
  t('Uint8Array and ArrayBuffer inputs give the same pack as Buffer', same(loadPack(copyBuf, { verify: 'none' }), a) && same(loadPack(copyBuf.buffer, { verify: 'none' }), a));
  const lean = loadPack(rom, { verify: 'none', dexText: false });
  t('dexText:false drops only the dex entries', lean.species.every((s) => s === null || s.dexText === null) && same(lean.moves, a.moves));
  const js = JSON.stringify(a);
  const gz = zlib.gzipSync(js, { level: 6 }).length;
  // JSON.stringify().length counts UTF-16 code units; the bytes on the wire are UTF-8 (accented letters take two), so print both.
  console.log(`  info pack JSON ${js.length} chars = ${Buffer.byteLength(js)} UTF-8 bytes, gzip ${gz} bytes; without dex text ${Buffer.byteLength(JSON.stringify(lean))} UTF-8 bytes`);
  const reps = Number(process.env.ARENA_REPS || 15);
  const times = [];
  const c0 = cpuSnap();
  for (let i = 0; i < reps; i++) { const t0 = process.hrtime.bigint(); loadPack(rom, { verify: 'none' }); times.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  const c1 = cpuSnap();
  const sorted = [...times].sort((x, y) => x - y);
  const med = sorted[Math.floor(sorted.length / 2)];
  console.log(`  info decode (verify:none) x${reps}: min ${sorted[0].toFixed(1)} ms, median ${med.toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms; first run (cold JIT) ${times[0].toFixed(1)} ms`);
  console.log(`  info machine load during the timing loop: CPU busy ${cpuBusy(c0, c1).toFixed(1)}% across ${os.cpus().length} logical CPUs (os.loadavg() is always 0 on Windows: ${J(os.loadavg())}); whole test run so far ${cpuBusy(load0, cpuSnap()).toFixed(1)}% busy`);
  const tv = process.hrtime.bigint(); loadPack(rom); const msVerified = Number(process.hrtime.bigint() - tv) / 1e6;
  console.log(`  info decode WITH the pure-JS sha256 identity check: ${msVerified.toFixed(0)} ms (the hash dominates; loadPackAsync uses WebCrypto when present)`);
  t('decode finishes in under 500 ms median (loose bound; the measured number is printed above)', med < 500, `${med.toFixed(1)} ms`);
}

// ---------------------------------------------------------------------------------------------
// H. (optional) the SAME modules in headless Chrome must produce a byte-identical pack
//    ARENA_BROWSER=1 node tools/pokemonarena_pack_test.mjs      needs:  PORT=8093 node tools/devserver.mjs
//    ARENA_BASE (default http://localhost:8093)   ARENA_CDP_PORT (default 9245)
// ---------------------------------------------------------------------------------------------
if (process.env.ARENA_BROWSER === '1') {
  head('H. browser parity (headless Chrome, throwaway profile, bare CDP)');
  const base = process.env.ARENA_BASE || 'http://localhost:8093';
  try {
    const { withBrowser } = await import('./headless_cdp.mjs');
    const nodeJson = JSON.stringify(golden);
    const nodeHash = crypto.createHash('sha256').update(nodeJson).digest('hex');
    const romUrl = base + '/gba/gbaWasm/roms/' + encodeURIComponent('Pokemon SoulGold (v1.1.1).gba');
    const probe = [
      '(async () => {',
      "  const T = await import('/pokemonarena/js/tables.js');",
      '  const buf = new Uint8Array(await (await fetch(' + J(romUrl) + ')).arrayBuffer());',
      '  const t0 = performance.now(); const pack = await T.loadPackAsync(buf); const ms = performance.now() - t0;',
      '  const json = JSON.stringify(pack);',
      "  const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))), (x) => x.toString(16).padStart(2, '0')).join('');",
      '  const bad = buf.slice(); bad[0x1f00000] ^= 1;',
      "  let refused = 'ACCEPTED'; try { await T.loadPackAsync(bad); } catch (e) { refused = e.name; }",
      '  const m = /HeadlessChrome\\/[0-9.]+/.exec(navigator.userAgent);',
      '  return { hash: h, len: json.length, ms, refused, ua: m ? m[0] : navigator.userAgent };',
      '})()',
    ].join('\n');
    const res = await withBrowser({ port: Number(process.env.ARENA_CDP_PORT || 9245), width: 800, height: 600 }, async (page) => {
      await page.navigate(base + '/pokemonarena/manifest.json');
      return page.eval(probe);
    });
    console.log(`  info ${res.ua}: loadPackAsync (incl. WebCrypto sha256) ${res.ms.toFixed(0)} ms, JSON ${res.len} chars (UTF-16 units)`);
    t('browser pack JSON is byte-identical to the Node pack (same sha256 over JSON.stringify)', res.hash === nodeHash && res.len === nodeJson.length, `browser ${res.hash} / ${res.len}, node ${nodeHash} / ${nodeJson.length}`);
    t('browser loadPackAsync refuses a one-bit-flipped ROM', res.refused === 'RomMismatchError', res.refused);
  } catch (e) { t('browser parity run', false, e.message); }
} else console.log('\n(section H, browser parity, skipped: set ARENA_BROWSER=1 with PORT=8093 node tools/devserver.mjs running)');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }

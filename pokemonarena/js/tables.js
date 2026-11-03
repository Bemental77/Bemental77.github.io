// pokemonarena/js/tables.js -- decode the battle-data tables of Pokemon SoulGold v1.1.1 from the ROM bytes.
//
// loadPack(romBytes) -> a plain JSON-able object ("the pack"). Everything is decoded at runtime from
// the ROM the visitor's browser already fetched; this file holds only offsets, strides and field
// layouts (hand-written code), never ROM content. Pure ES module (browser + Node, no `node:` imports),
// deterministic and side-effect free so a netplay stage can call it on every peer and compare packs.
// (Under Node the .js files load as ES modules via pokemonarena/package.json {"type":"module"} -- a file owned by
// another stage; Node >= 22.7 also detects the syntax without it. Browsers need nothing.)
//
// Pack shape (every array index IS the in-ROM id):
//   schema      1
//   rom         { length, title, gameCode, version, headerChecksumOk, sha256: <hex|null>, verified: 'sha256'|'none' }
//   counts      { ... }   summary numbers, also what the test pins
//   types[21]   { id, name }                   id 0 "None" ... id 20 "Stellar"; ids are the numbering species/moves use
//   typeChart   number[21][21]                 [attacker][defender], UQ4.12 fixed point: 0 | 0x800 | 0x1000 | 0x2000
//   natures[25] { id, name, up, down }         up/down are stat keys 'atk'|'def'|'spe'|'spa'|'spd'; up===down means neutral
//   exp[8][101] cumulative EXP to reach level L (index = L), row = species.growthRate
//   abilities[523] { id, name, short, long, aiRating, flags }
//   items[930]  { id, name, plural, desc, price, holdEffect, holdEffectParam, machine }
//               (44-byte records starting at 0x7451c4; price is the record's FIRST word, desc the word at +0x0c, name at
//               +0x14. All 930 records are intact: the table ends exactly where the string pool starts, 0x74f19c.)
//   moves[936]  { id, name, desc, effect, type, category, power, accuracy, target, pp, priority, strikeCount,
//                 critStage, alwaysCrit, flags{...}, additional[{effect, flags, chance}], bytes[16] }
//   machines[110] { item, kind:'TM'|'HM', number, move }   TM01..TM100 then HM01..HM10
//   tutors      number[]                       move ids offered by tutors (0xFFFF-terminated u16 list in the ROM)
//   species[1579] null for an all-zero slot, else
//               { id, legal, name, category, baseStats{hp,atk,def,spe,spa,spd}, bst, types[2], catchRate, expYield,
//                 evYield{...}, heldItems{common,rare}, genderRatio, eggCycles, friendship, growthRate, eggGroups[2],
//                 abilities[3], innates[3], cryId, natDex, height, weight, dexText,
//                 levelUp[[move,level]...], teachable[], eggMoves[], evolutions[{method,param,target,conditions}], forms[] }
//   roster      ids of legal species, ascending ("curated roster": non-empty name AND non-zero stats; NOT contiguous)
//
// What is NOT in these tables (behaviour that lives in ROM code): move effect scripts (moves carry only a numeric
// `effect` id), ability effects (name/text/AI rating only), held-item effects (an unnamed id+param pair), status /
// weather / terrain mechanics, the damage and stat formulas, crit odds, accuracy/evasion stage tables,
// evolution-condition semantics (ids are decoded as numbers only), form-change triggers, innate-ability unlock rules.

import { RomReader, RomFormatError, PINNED, assertPinned, assertPinnedAsync, identify } from './rom.js';
import { defaultCodec } from './charset.js';

export const PACK_SCHEMA = 1;

// Table placement for the pinned ROM. pokemonarena/manifest.json mirrors this (tools/pokemonarena_pack_test.mjs
// fails if the two drift). Field offsets inside a record are in the decoders below.
export const LAYOUT = Object.freeze({
  species: Object.freeze({ offset: 0x7c7310, stride: 0x118, slots: 1579 }),
  moves: Object.freeze({ offset: 0x769860, stride: 0x48, count: 936 }),
  abilities: Object.freeze({ offset: 0xef6e44, stride: 0x20, count: 523 }),
  // items.offset is the START of record 0 (its first word is the price). 930 * 0x2c = 0x9fd8, so the table ends at
  // 0x74f19c, the first byte of the string pool; the base is referenced by 30 literal-pool words in the ROM.
  // (An earlier revision anchored on the NAME-pointer field, 0x7451d8 = start + 0x14, and read each price one record late.)
  items: Object.freeze({ offset: 0x7451c4, stride: 0x2c, count: 930 }),
  types: Object.freeze({ offset: 0x43b56c, stride: 40, count: 21 }),
  typeChart: Object.freeze({ offset: 0x43b8b4, size: 21 }),
  natures: Object.freeze({ offset: 0xef5cac, stride: 20, count: 25 }),
  exp: Object.freeze({ offset: 0x889500, rows: 8, levels: 101 }),
  tmhm: Object.freeze({ offset: 0x73be1c, count: 110, tmCount: 100, firstItem: 582 }),
  tutors: Object.freeze({ offset: 0x788c70 }),
});

export const STAT_KEYS = Object.freeze(['hp', 'atk', 'def', 'spe', 'spa', 'spd']); // ROM struct order
export const NATURE_STAT = Object.freeze({ 1: 'atk', 2: 'def', 3: 'spe', 4: 'spa', 5: 'spd' });
export const CATEGORY = Object.freeze(['Physical', 'Special', 'Status']);
export const GROWTH_RATE = Object.freeze(['Medium Fast', 'Erratic', 'Fluctuating', 'Medium Slow', 'Fast', 'Slow']);
// Move `target` codes, named from sample moves (Thunderbolt=1, Swords Dance=7, Earthquake/Surf=11, Rain Dance=12,
// Spikes=13, Perish Song=14, ...) -- the ROM stores only the number.
export const TARGET = Object.freeze({
  1: 'selected', 2: 'smart', 3: 'depends', 4: 'opponent', 5: 'random', 6: 'foes', 7: 'user', 8: 'ally',
  9: 'userAndAllies', 10: 'userOrAlly', 11: 'foesAndAlly', 12: 'field', 13: 'opponentsField', 14: 'allBattlers',
});
export const EVO_END = 0xffff; // method terminator of an evolution list
export const EVO_COND_END = 0x27; // condition-id terminator of an evolution condition list
export const MAX_SPECIES_ID = 1577;

// Species-record field offsets.
const SP = {
  baseStats: 0x00, types: 0x06, catchRate: 0x08, expYield: 0x0a, evYield: 0x0c, itemCommon: 0x0e, itemRare: 0x10,
  genderRatio: 0x12, eggCycles: 0x13, friendship: 0x14, growthRate: 0x15, eggGroups: 0x16, abilities: 0x18,
  innates: 0x20, category: 0x26, name: 0x33, cryId: 0x40, natDex: 0x42, height: 0x44, weight: 0x46,
  dexText: 0x50, levelUp: 0xa8, teachable: 0xac, eggMoves: 0xb0, evolutions: 0xb4, forms: 0xb8,
};
const SP_NAME_LEN = 13;
// Item-record field offsets, relative to the START of a 44-byte record (LAYOUT.items.offset + id * 0x2c).
// Words at +0x04, +0x08, +0x10 are not decoded (a small id/zero word, a field-use code pointer, another pointer or zero).
const IT = { price: 0x00, desc: 0x0c, name: 0x14, plural: 0x18, holdEffect: 0x1c, holdEffectParam: 0x1d };
// Move-record field offsets.
const MV = {
  name: 0x00, desc: 0x04, effect: 0x08, typeCatPower: 0x0a, accTarget: 0x0c, pp: 0x0e, prioStrike: 0x14,
  critByte: 0x15, flagsA: 0x16, flagsB: 0x17, additional: 0x2c, bytesStart: 0x10, bytesLen: 16,
};

function wrap(table, fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RomFormatError || e instanceof RangeError) {
      const err = new RomFormatError(`${table}: ${e.message}`);
      err.cause = e;
      throw err;
    }
    throw e;
  }
}

class Ctx {
  constructor(rom, codec) {
    this.r = new RomReader(rom);
    this.codec = codec;
  }
  /** Text at a file offset, 0xFF-terminated. */
  textAt(off, max = 1024) {
    const b = this.r.bytes;
    let n = 0;
    while (n < max && b[off + n] !== 0xff) n++;
    if (n === max) throw new RomFormatError(`unterminated string at 0x${off.toString(16)}`);
    return this.codec.decode(b, off, n);
  }
  /** Text through a pointer field; null pointer -> null. */
  textPtr(fieldOff, max) {
    const o = this.r.ptr(fieldOff);
    return o === null ? null : this.textAt(o, max);
  }
  field(off, width) {
    return this.codec.decodeField(this.r.bytes, off, width);
  }
}

// ---------------------------------------------------------------------------------------------

function decodeTypes(c, L) {
  const out = [];
  for (let i = 0; i < L.types.count; i++) out.push({ id: i, name: c.field(L.types.offset + i * L.types.stride, 9) });
  return out;
}

function decodeTypeChart(c, L) {
  const n = L.typeChart.size;
  const rows = [];
  for (let a = 0; a < n; a++) {
    const row = [];
    for (let d = 0; d < n; d++) row.push(c.r.u32(L.typeChart.offset + (a * n + d) * 4));
    rows.push(row);
  }
  return rows;
}

function decodeNatures(c, L) {
  const out = [];
  for (let i = 0; i < L.natures.count; i++) {
    const a = L.natures.offset + i * L.natures.stride;
    const up = c.r.u8(a + 4), down = c.r.u8(a + 5);
    if (!(up in NATURE_STAT) || !(down in NATURE_STAT)) throw new RomFormatError(`nature ${i}: stat code ${up}/${down}`);
    out.push({ id: i, name: c.textPtr(a), up: NATURE_STAT[up], down: NATURE_STAT[down] });
  }
  return out;
}

function decodeExp(c, L) {
  const rows = [];
  for (let r = 0; r < L.exp.rows; r++) {
    const row = [];
    for (let lv = 0; lv < L.exp.levels; lv++) row.push(c.r.u32(L.exp.offset + (r * L.exp.levels + lv) * 4));
    rows.push(row);
  }
  return rows;
}

function decodeAbilities(c, L) {
  const out = [];
  for (let i = 0; i < L.abilities.count; i++) {
    const a = L.abilities.offset + i * L.abilities.stride;
    out.push({
      id: i,
      name: c.field(a, 20),
      short: c.textPtr(a + 0x14),
      long: c.textPtr(a + 0x18),
      aiRating: c.r.s8(a + 0x1c),
      flags: c.r.u8(a + 0x1d),
    });
  }
  return out;
}

function decodeItems(c, L) {
  const out = [];
  for (let i = 0; i < L.items.count; i++) {
    const a = L.items.offset + i * L.items.stride; // file offset of this record's FIRST byte (its price word)
    // ROM FACT: a record is 44 bytes and the table is exactly 930 of them (0x7451c4 .. 0x74f19c, where the string pool
    // begins), so no record is damaged. The price is the first word of the SAME record. An earlier revision anchored
    // on the name-pointer field (+0x14) and read the word at name+0x18 -- the NEXT record's price -- for every item
    // (Potion read 700 instead of 200), and mistook the then-unreachable last record for a "damaged" one.
    // The description pointer is likewise inside its own record (+0x0c); name-relative +0x24 is the next item's text.
    out.push({
      id: i,
      name: c.textPtr(a + IT.name),
      plural: c.textPtr(a + IT.plural),
      desc: c.textPtr(a + IT.desc),
      price: c.r.u32(a + IT.price),
      holdEffect: c.r.u8(a + IT.holdEffect),
      holdEffectParam: c.r.u8(a + IT.holdEffectParam),
      machine: null,
    });
  }
  return out;
}

function decodeMoves(c, L) {
  const out = [];
  for (let i = 0; i < L.moves.count; i++) {
    const a = L.moves.offset + i * L.moves.stride;
    const tcp = c.r.u16(a + MV.typeCatPower), at = c.r.u16(a + MV.accTarget);
    const prioStrike = c.r.u8(a + MV.prioStrike), critByte = c.r.u8(a + MV.critByte);
    const fa = c.r.u8(a + MV.flagsA), fb = c.r.u8(a + MV.flagsB);
    const nAdd = (critByte >> 5) & 3;
    const addOff = c.r.ptr(a + MV.additional);
    const additional = [];
    if (addOff !== null) {
      for (let k = 0; k < nAdd; k++) {
        additional.push({ effect: c.r.u16(addOff + 4 * k), flags: c.r.u8(addOff + 4 * k + 2), chance: c.r.u8(addOff + 4 * k + 3) });
      }
    }
    const bytes = [];
    for (let k = 0; k < MV.bytesLen; k++) bytes.push(c.r.u8(a + MV.bytesStart + k));
    out.push({
      id: i,
      name: c.textPtr(a + MV.name),
      desc: c.textPtr(a + MV.desc),
      effect: c.r.u16(a + MV.effect),
      type: tcp & 0x1f,
      category: (tcp >> 5) & 3,
      power: tcp >> 7,
      accuracy: at & 0x7f, // 0 = never misses
      target: (at >> 7) & 0xf,
      pp: c.r.u8(a + MV.pp),
      priority: ((prioStrike & 0xf) ^ 8) - 8,
      strikeCount: prioStrike >> 4, // 0 = ordinary; 2 = double hit, 3 = triple hit ... (name-checked, see test)
      critStage: (critByte >> 2) & 3,
      alwaysCrit: ((critByte >> 4) & 1) === 1,
      // Bit meanings below were recovered by correlating each bit with move-name families (precision/recall are
      // asserted in the pack test); the ROM has no names for them. Everything else stays in `bytes`.
      flags: {
        contact: (fa & 1) !== 0, punch: (fa & 0x20) !== 0, kick: (fa & 0x40) !== 0, bite: (fa & 0x80) !== 0,
        pulse: (fb & 1) !== 0, sound: (fb & 2) !== 0, ball: (fb & 4) !== 0, powder: (fb & 8) !== 0,
        dance: (fb & 0x10) !== 0, wind: (fb & 0x20) !== 0, slicing: (fb & 0x40) !== 0, heal: (fb & 0x80) !== 0,
      },
      additional,
      bytes, // raw bytes +0x10..+0x1F; +0x20..+0x2B and +0x30.. (contest data, anim pointer) are not decoded
    });
  }
  return out;
}

function decodeMachines(c, L) {
  const out = [];
  for (let i = 0; i < L.tmhm.count; i++) {
    const tm = i < L.tmhm.tmCount;
    out.push({ item: L.tmhm.firstItem + i, kind: tm ? 'TM' : 'HM', number: tm ? i + 1 : i - L.tmhm.tmCount + 1, move: c.r.u16(L.tmhm.offset + 2 * i) });
  }
  return out;
}

function decodeEvolutions(c, off) {
  const out = [];
  for (let k = 0; k < 16; k++) {
    const q = off + 12 * k;
    const method = c.r.u16(q);
    if (method === EVO_END) return out;
    const condOff = c.r.ptr(q + 8);
    const conditions = [];
    if (condOff !== null) {
      let ended = false;
      for (let j = 0; j < 8; j++) {
        const p = condOff + 8 * j;
        const cond = c.r.u16(p);
        if (cond === EVO_COND_END) { ended = true; break; }
        conditions.push([cond, c.r.u16(p + 2), c.r.u16(p + 4), c.r.u16(p + 6)]);
      }
      if (!ended) throw new RomFormatError(`evolution condition list at 0x${condOff.toString(16)} not terminated`);
    }
    out.push({ method, param: c.r.u16(q + 2), target: c.r.u16(q + 4), conditions });
  }
  throw new RomFormatError(`evolution list at 0x${off.toString(16)} not terminated`);
}

function decodeLevelUp(c, off) {
  const out = [];
  for (let k = 0; k < 256; k++) {
    const move = c.r.u16(off + 4 * k);
    if (move === 0xffff) return out;
    out.push([move, c.r.u16(off + 4 * k + 2)]);
  }
  throw new RomFormatError(`level-up list at 0x${off.toString(16)} not terminated`);
}

function decodeSpecies(c, L, opts) {
  const out = [];
  for (let id = 0; id < L.species.slots; id++) {
    const a = L.species.offset + id * L.species.stride;
    if (c.r.allZero(a, L.species.stride)) { out.push(null); continue; }
    const baseStats = {};
    let bst = 0;
    STAT_KEYS.forEach((k, i) => { const v = c.r.u8(a + SP.baseStats + i); baseStats[k] = v; bst += v; });
    const ev = c.r.u16(a + SP.evYield);
    const evYield = {};
    STAT_KEYS.forEach((k, i) => { evYield[k] = (ev >> (2 * i)) & 3; });
    const name = c.field(a + SP.name, SP_NAME_LEN);
    const lu = c.r.ptr(a + SP.levelUp), te = c.r.ptr(a + SP.teachable), eg = c.r.ptr(a + SP.eggMoves);
    const ev2 = c.r.ptr(a + SP.evolutions), fo = c.r.ptr(a + SP.forms), dx = c.r.ptr(a + SP.dexText);
    out.push({
      id,
      legal: id >= 1 && name !== '' && bst > 0,
      name,
      category: c.field(a + SP.category, SP_NAME_LEN),
      baseStats,
      bst,
      types: [c.r.u8(a + SP.types), c.r.u8(a + SP.types + 1)],
      catchRate: c.r.u8(a + SP.catchRate),
      expYield: c.r.u16(a + SP.expYield),
      evYield,
      heldItems: { common: c.r.u16(a + SP.itemCommon), rare: c.r.u16(a + SP.itemRare) },
      genderRatio: c.r.u8(a + SP.genderRatio), // 0 male only .. 254 female only, 255 genderless
      eggCycles: c.r.u8(a + SP.eggCycles),
      friendship: c.r.u8(a + SP.friendship),
      growthRate: c.r.u8(a + SP.growthRate),
      eggGroups: [c.r.u8(a + SP.eggGroups), c.r.u8(a + SP.eggGroups + 1)],
      abilities: [0, 1, 2].map((k) => c.r.u16(a + SP.abilities + 2 * k)), // [slot 0, slot 1, hidden]
      innates: [0, 1, 2].map((k) => c.r.u16(a + SP.innates + 2 * k)),
      cryId: c.r.u16(a + SP.cryId),
      natDex: c.r.u16(a + SP.natDex),
      height: c.r.u16(a + SP.height), // decimetres
      weight: c.r.u16(a + SP.weight), // hectograms
      dexText: opts.dexText && dx !== null ? c.textAt(dx, 2048) : null,
      levelUp: lu === null ? [] : decodeLevelUp(c, lu),
      teachable: te === null ? [] : c.r.u16List(te, 0xffff, 1024),
      eggMoves: eg === null ? [] : c.r.u16List(eg, 0xffff, 128),
      evolutions: ev2 === null ? [] : decodeEvolutions(c, ev2),
      forms: fo === null ? [] : c.r.u16List(fo, 0xffff, 64),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

/**
 * Decode every battle-data table from a ROM image.
 *   opts.verify  'sha256' (default): refuse anything but the pinned ROM (RomMismatchError), pure-JS hash, sync.
 *                'header': length + header only (use after you hashed it yourself, e.g. loadPackAsync).
 *                'none':   no identity check at all (tests / mutation controls ONLY -- never for online features).
 *   opts.layout  table placement override (default LAYOUT); lets the test prove a wrong offset is caught.
 *   opts.codec   text codec (default: Gen-3 charset)
 *   opts.dexText false to skip the 1038 dex entries (smaller pack)
 */
export function loadPack(rom, opts = {}) {
  const verify = opts.verify || 'sha256';
  const L = opts.layout || LAYOUT;
  let ident = null;
  if (verify === 'sha256') ident = assertPinned(rom, { hash: 'sha256' });
  else if (verify === 'header') ident = assertPinned(rom, { hash: 'none' });
  else if (verify !== 'none') throw new TypeError(`unknown verify mode ${verify}`);
  return buildPack(rom, L, opts, ident, verify);
}

/** Same as loadPack but hashes with WebCrypto (fast, non-blocking) when the platform has it. */
export async function loadPackAsync(rom, opts = {}) {
  const ident = await assertPinnedAsync(rom);
  return buildPack(rom, opts.layout || LAYOUT, opts, ident, 'sha256');
}

function buildPack(rom, L, opts, ident, verify) {
  const c = new Ctx(rom, opts.codec || defaultCodec);
  const hdr = ident ? ident.header : identify(rom, { hash: 'none' }).header;
  const pack = { schema: PACK_SCHEMA };
  pack.rom = {
    length: c.r.length,
    title: hdr.title ?? null,
    gameCode: hdr.gameCode ?? null,
    version: hdr.version ?? null,
    headerChecksumOk: !!hdr.headerChecksumOk,
    sha256: ident && ident.sha256 ? ident.sha256 : null,
    verified: verify === 'sha256' ? 'sha256' : 'none',
  };
  pack.types = wrap('types', () => decodeTypes(c, L));
  pack.typeChart = wrap('typeChart', () => decodeTypeChart(c, L));
  pack.natures = wrap('natures', () => decodeNatures(c, L));
  pack.exp = wrap('exp', () => decodeExp(c, L));
  pack.abilities = wrap('abilities', () => decodeAbilities(c, L));
  pack.items = wrap('items', () => decodeItems(c, L));
  pack.moves = wrap('moves', () => decodeMoves(c, L));
  pack.machines = wrap('machines', () => decodeMachines(c, L));
  pack.tutors = wrap('tutors', () => c.r.u16List(L.tutors.offset, 0xffff, 512));
  for (const m of pack.machines) {
    const it = pack.items[m.item];
    if (it) it.machine = { kind: m.kind, number: m.number, move: m.move };
  }
  pack.species = wrap('species', () => decodeSpecies(c, L, { dexText: opts.dexText !== false }));
  pack.roster = [];
  for (const s of pack.species) if (s && s.legal) pack.roster.push(s.id);
  pack.counts = {
    speciesSlots: pack.species.length,
    speciesNonEmpty: pack.species.filter((s) => s).length,
    speciesLegal: pack.roster.length,
    moves: pack.moves.length,
    movesReal: pack.moves.filter((m) => m.id > 0 && m.name !== '-').length,
    abilities: pack.abilities.length,
    items: pack.items.length,
    types: pack.types.length,
    natures: pack.natures.length,
    machines: pack.machines.length,
    tutors: pack.tutors.length,
    evolutions: pack.species.reduce((n, s) => n + (s ? s.evolutions.length : 0), 0),
  };
  return pack;
}

// ---------------------------------------------------------------------------------------------
// Small pure helpers over a pack (no state, no rounding, integers only).
// ---------------------------------------------------------------------------------------------

/** UQ4.12 type multiplier, attacker type id vs defender type id. 0x1000 = 1x. */
export function typeEffectiveness(pack, attackType, defendType) {
  return pack.typeChart[attackType][defendType];
}

/** Learnable moves of a species, split by source (ROM order, de-duplicated). TM/HM vs tutor is decided by
 *  membership in the machine table; `teachable` in the ROM is one merged list (TM order, then tutor moves). */
export function learnableMoves(pack, speciesId) {
  const sp = pack.species[speciesId];
  if (!sp) return null;
  const machineMoves = new Set(pack.machines.map((m) => m.move));
  const uniq = (xs) => [...new Set(xs)];
  const levelUp = uniq(sp.levelUp.map((e) => e[0]));
  const machine = uniq(sp.teachable.filter((m) => machineMoves.has(m)));
  const tutor = uniq(sp.teachable.filter((m) => !machineMoves.has(m)));
  const egg = uniq(sp.eggMoves);
  return { levelUp, machine, tutor, egg, all: uniq([...levelUp, ...machine, ...tutor, ...egg]) };
}

export { PINNED };

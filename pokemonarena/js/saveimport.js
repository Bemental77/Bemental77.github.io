// pokemonarena/js/saveimport.js -- read a Pokemon SoulGold v1.1.1 battery save (.sav) into pokemonarena profile records.
//
// The "Transfer Pak" of the Arena: a player brings THEIR OWN Pokemon from their SoulGold save into the Arena's box so they can edit
// EVs / IVs / moves and battle with them. This module only READS. It never writes a save back, never touches the network, and never
// mutates the buffer it is given (the test asserts that).
//
// Pure ES module (browser + Node 24): no `node:` imports, no DOM, no timers, no randomness, no clocks. Deterministic. Never throws on
// hostile input: every failure is { ok:false, error:{code,message,...} } with a code from SAVE_CODES.
//
//   importSave(bytes, { rom, pack, ruleset, layout?, saveSha256?, deps? }) -> {
//     ok, error?,                              // error = { code, message, ... }  (see SAVE_CODES)
//     container: { size, slotUsed, slots:[...], counter, fallback },
//     trainer:   { name, gender:'M'|'F', tid, sid, id },
//     party:     [mon],                        // mon = a pokemonarena/js/profile.js Pokemon record (checkMon passes), origin 'save-import'
//                                              (effective values: a hyper-trained stat is IV 31, the ability slot is the one the game shows, shiny follows the game's rule incl. story flag 0x95e)
//     boxes:     [{ index, name, current, wallpaper, mons:[mon] }],      // 15 boxes
//     reports:   { [mon.id]: { where:{party:true,slot}|{box,slot}, validation:{ok,reasons}, fixes:[{field,code,message,...}],
//                              derived:{level,levelFromExp,exp,growthRate,speciesName,...}, selfCheck:{...}|null } },
//     summary:   { total, legal, needsFix, rejected, statCheck:{ mons, statsMatched, statsTotal, rate }|null },
//     warnings:  [{ code, message, ... }],
//     rejected:  [{ where, species?, reason, code, message }],
//   }
//   importSaveFile(fileOrBytes, opts)  async: accepts a File / Blob / ArrayBuffer / Uint8Array and calls importSave.
//
// WHAT IS KNOWN, AND HOW (nothing here is taken from vanilla pokeemerald without a check):
//  * CONTAINER   Source of truth = the ROM: the save-slot layout table at ROM file offset 0xF32F6C (14 x {u16 offset, u16 size}) is read from
//                the ROM the caller supplies, its structure is checked, and the section sizes used for the per-sector checksum come from
//                it. Footer (sector +0xFF4: id u16, checksum u16, signature u32 0x08012025, counter u32) and the checksum algorithm
//                (sum of u32 words over the section size, folded (s>>>16)+(s&0xFFFF)) were verified against a save written by the game
//                itself (tools/pokemonarena_savegen.mjs): 14 of 14 sectors match.
//  * RECORDS     Pokemon structs in this hack (pokeemerald-expansion based) are PLAINTEXT, 76 bytes in a box and 96 in the party, and several
//                fields are bit-packed into the spare high bits of their neighbours (moves are 11 bits, EXP 24 bits, the ability index
//                lives in the top nibble of move 4, the six hyper-training flags in the top bits of moves/PP, the nature is stored as an
//                XOR against personality % 25). Every one of those was read from the game's own setter code (SetBoxMonData, jump tables
//                at ROM 0x7c6a58 and 0x7c6bb0) AND confirmed by loading encoder-built saves in the real game (tools/pokemonarena_savegen.mjs;
//                evidence per field in pokemonarena/saveimport_manifest.json "evidence"). Nothing is taken from vanilla pokeemerald unchecked.
//  * PINNED:     the field offsets below and the block offsets (party / boxes inside SaveBlock1 / PokemonStorage) are pinned in
//                saveimport_manifest.json; the test fails if the manifest and this file disagree.

import { decodeField, decodeText } from './charset.js';
import { computeStats } from './stats.js';
import { checkMon, validateStoredMon } from './profile.js';
import { PINNED, readHeader } from './rom.js';

export const ACCEPTED_SIZES = Object.freeze([0x20000, 0x20010, 0x22000]);
export const FLASH_BYTES = 0x20000;
export const SECTOR_BYTES = 0x1000;
export const SECTOR_DATA_MAX = 0xff4;
export const SECTORS_PER_SLOT = 14;
export const SIGNATURE = 0x08012025;
export const LAYOUT_TABLE_OFFSET = 0xf32f6c;
export const LAYOUT_ENTRIES = 14;
export const SAVE_ORIGIN = 'save-import';

export const SAVE_CODES = Object.freeze({
  'save.bad-input': 'the input is not a byte buffer',
  'save.size': 'the file size is not one of the sizes a SoulGold battery file has (0x20000, 0x20010, 0x22000)',
  'save.empty': 'the save is erased flash (every byte 0xFF): the game was never saved',
  'save.rom-missing': 'the ROM (or a pre-read layout) is required: the save layout table lives in the ROM',
  'save.wrong-rom': 'the ROM / pack is not Pokemon SoulGold v1.1.1',
  'save.layout': 'the ROM save-layout table failed its structural checks',
  'save.no-valid-slot': 'neither save slot is complete and checksum-valid',
  'save.internal': 'internal error (a bug): please report',
});

// Field offsets. Block-level: inside SaveBlock2 / SaveBlock1 / PokemonStorage. Record-level: inside the 80-byte Pokemon record.
export const BLOCK = Object.freeze({
  sb2: Object.freeze({ name: 0x00, nameLen: 8, gender: 0x08, tid: 0x0a, sid: 0x0c }),
  sb1: Object.freeze({ partyCount: 0x234, party: 0x238, partyStride: 96, partyMax: 6, flags: 0x1898, shinyFlag: 0x95e }), // FlagGet(id) reads SaveBlock1[0x1898 + (id>>3)] bit (id&7) (ROM 0x132f14)
  storage: Object.freeze({ currentBox: 0, boxes: 4, boxCount: 15, perBox: 30, recordBytes: 76, names: 0x859c, nameStride: 9, wallpapers: 0x8623, tag: 0x87b4, tagText: 'BX16' }),
});
export const FIELD = Object.freeze({
  personality: 0x00, otId: 0x04, nickname: 0x08, nicknameLen: 12,
  flagsA: 0x14, flagsB: 0x15, otName: 0x16, otNameLen: 7, markings: 0x1d, extra: 0x1e,
  shinyWord: 0x1e, speciesWord: 0x20, itemWord: 0x22, experience: 0x24, expMask: 0xffffff, ppBonuses: 0x2a, friendship: 0x2b,
  moves: 0x2c, moveMask: 0x7ff, pp: 0x34, ppMask: 0x7f, evs: 0x38, contest: 0x3e, pokerus: 0x44, metLocation: 0x45, origins: 0x46, ivWord: 0x48,
  // bit-packed fields, each { offset, shift, bits } (value = (byte >> shift) & (2^bits - 1)); verified by the real game, see the manifest
  natureXor: Object.freeze({ offset: 0x14, shift: 3, bits: 5 }),
  abilityNum: Object.freeze({ offset: 0x33, shift: 4, bits: 2 }),
  hyper: Object.freeze({ hp: Object.freeze({ offset: 0x33, shift: 6 }), atk: Object.freeze({ offset: 0x33, shift: 7 }), def: Object.freeze({ offset: 0x34, shift: 7 }), spe: Object.freeze({ offset: 0x35, shift: 7 }), spa: Object.freeze({ offset: 0x36, shift: 7 }), spd: Object.freeze({ offset: 0x37, shift: 7 }) }),
  shinyModifierBit: Object.freeze({ offset: 0x1f, shift: 6 }),
  // party-only tail (a party record = the 76-byte box record + these 20 bytes)
  status: 0x4c, level: 0x50, hp: 0x52, maxHp: 0x54, atk: 0x56, def: 0x58, spe: 0x5a, spa: 0x5c, spd: 0x5e,
  boxBytes: 76, partyBytes: 96,
});
const ROM_STATS = ['hp', 'atk', 'def', 'spe', 'spa', 'spd']; // order of the EV bytes and of the IV word (5 bits each, 30 bits)

// ------------------------------------------------------------------------------------------------------------------------------
// small helpers
// ------------------------------------------------------------------------------------------------------------------------------
const hasOwn = Object.prototype.hasOwnProperty;
const hex = (n, w = 0) => '0x' + (n >>> 0).toString(16).padStart(w, '0');
const err = (code, extra) => ({ ok: false, error: { code, message: SAVE_CODES[code] || code, ...(extra || {}) } });

function toBytes(src) {
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  return null;
}
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Vanilla-compatible section checksum: sum of the little-endian u32 words of the section data, folded to 16 bits. */
export function sectionChecksum(bytes, start, size) {
  let sum = 0;
  const words = size >>> 2;
  for (let i = 0; i < words; i++) sum = (sum + u32(bytes, start + i * 4)) >>> 0;
  return ((sum >>> 16) + (sum & 0xffff)) & 0xffff;
}

// ------------------------------------------------------------------------------------------------------------------------------
// the ROM layout table
// ------------------------------------------------------------------------------------------------------------------------------
/** Read and check the save-layout table from the ROM. Returns { ok, layout:{sections:[{id,offset,size}], sb2Size, sb1Size, storageSize} } or { ok:false, why }. */
export function readLayout(rom) {
  const r = toBytes(rom);
  if (!r || r.length < LAYOUT_TABLE_OFFSET + LAYOUT_ENTRIES * 4) return { ok: false, why: 'the ROM is too short to hold the layout table' };
  const sections = [];
  for (let id = 0; id < LAYOUT_ENTRIES; id++) sections.push({ id, offset: u16(r, LAYOUT_TABLE_OFFSET + id * 4), size: u16(r, LAYOUT_TABLE_OFFSET + id * 4 + 2) });
  for (const s of sections) {
    if (s.size < 4 || s.size > SECTOR_DATA_MAX || (s.size & 3)) return { ok: false, why: `section ${s.id}: size ${hex(s.size)} is not a plausible sector payload` };
  }
  // SaveBlock1 = ids 1..4 and PokemonStorage = ids 5..13 are each ONE block cut into consecutive pieces: offsets must be the running sum.
  const checkRun = (from, to, what) => {
    let at = 0;
    for (let id = from; id <= to; id++) {
      if (sections[id].offset !== at) return `${what}: section ${id} starts at ${hex(sections[id].offset)}, the previous pieces end at ${hex(at)}`;
      at += sections[id].size;
    }
    return null;
  };
  const bad = (sections[0].offset !== 0 && 'section 0 (SaveBlock2) must start at 0') || checkRun(1, 4, 'SaveBlock1') || checkRun(5, 13, 'PokemonStorage');
  if (bad) return { ok: false, why: bad };
  const sum = (a, b) => { let t = 0; for (let i = a; i <= b; i++) t += sections[i].size; return t; };
  return { ok: true, layout: { sections, sb2Size: sections[0].size, sb1Size: sum(1, 4), storageSize: sum(5, 13) } };
}

// ------------------------------------------------------------------------------------------------------------------------------
// the container: two slots of 14 sectors
// ------------------------------------------------------------------------------------------------------------------------------
function readSector(bytes, index, layout) {
  const base = index * SECTOR_BYTES;
  const id = u16(bytes, base + 0xff4), checksum = u16(bytes, base + 0xff6), signature = u32(bytes, base + 0xff8), counter = u32(bytes, base + 0xffc);
  const s = { index, id, checksum, signature, counter, signatureOk: signature === SIGNATURE, idOk: id < LAYOUT_ENTRIES, checksumOk: false, erased: false };
  if (s.signatureOk && s.idOk) s.checksumOk = sectionChecksum(bytes, base, layout.sections[id].size) === checksum;
  s.erased = signature === 0xffffffff && id === 0xffff;
  return s;
}

function judgeSlot(bytes, slot, layout) {
  const first = slot * SECTORS_PER_SLOT;
  const sectors = [];
  for (let i = 0; i < SECTORS_PER_SLOT; i++) sectors.push(readSector(bytes, first + i, layout));
  const problems = [];
  const byId = new Map();
  for (const s of sectors) {
    if (s.erased) { problems.push({ sector: s.index, why: 'erased' }); continue; }
    if (!s.signatureOk) { problems.push({ sector: s.index, why: 'signature' }); continue; }
    if (!s.idOk) { problems.push({ sector: s.index, why: 'section-id', id: s.id }); continue; }
    if (!s.checksumOk) { problems.push({ sector: s.index, id: s.id, why: 'checksum' }); continue; }
    if (byId.has(s.id)) { problems.push({ sector: s.index, id: s.id, why: 'duplicate-id' }); continue; }
    byId.set(s.id, s);
  }
  const missing = [];
  for (let id = 0; id < LAYOUT_ENTRIES; id++) if (!byId.has(id)) missing.push(id);
  const counters = new Set([...byId.values()].map((s) => s.counter));
  if (counters.size > 1) problems.push({ why: 'mixed-counters', counters: [...counters] });
  const sigCounters = sectors.filter((s) => s.signatureOk).map((s) => s.counter);
  const counter = counters.size === 1 ? [...counters][0] : (sigCounters.length ? Math.max(...sigCounters) : null);
  const any = sectors.some((s) => !s.erased);
  return { slot, valid: !problems.length && !missing.length, any, problems, missing, counter, byId, sectors };
}

/** Is counter `a` newer than counter `b`? (vanilla wrap rule: 0xFFFFFFFF -> 0 counts as newer.) */
function newer(a, b) {
  if (a === 0xffffffff && b === 0) return false;
  if (a === 0 && b === 0xffffffff) return true;
  return a > b;
}

/** Choose the slot to load. Returns { chosen, fallback, warnings, slots } where chosen is a judged slot or null. */
export function chooseSlot(bytes, layout) {
  const slots = [judgeSlot(bytes, 0, layout), judgeSlot(bytes, 1, layout)];
  const warnings = [];
  const valid = slots.filter((s) => s.valid);
  let chosen = null, fallback = false;
  if (valid.length === 2) {
    const [a, b] = slots;
    if (a.counter === b.counter) { warnings.push({ code: 'save.slot-tie', message: 'both slots are valid with the same save counter; the second slot was used' }); chosen = b; }
    else chosen = newer(a.counter, b.counter) ? a : b;
  } else if (valid.length === 1) {
    chosen = valid[0];
    const other = slots[1 - chosen.slot];
    if (other.any && other.counter !== null && newer(other.counter, chosen.counter)) {
      fallback = true;
      warnings.push({ code: 'save.fallback-slot', message: `slot ${other.slot} has a newer save counter (${other.counter}) but is damaged; the older slot ${chosen.slot} (counter ${chosen.counter}) was used`, damagedSlot: other.slot, problems: other.problems.slice(0, 6), missing: other.missing });
    } else if (other.any && !other.valid) {
      warnings.push({ code: 'save.other-slot-damaged', message: `slot ${other.slot} is damaged and ignored`, damagedSlot: other.slot, problems: other.problems.slice(0, 6), missing: other.missing });
    }
  }
  return { chosen, fallback, warnings, slots };
}

/** Reassemble a block from consecutive sections of one slot. Returns a Uint8Array copy. */
function assemble(bytes, slot, layout, fromId, toId, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (let id = fromId; id <= toId; id++) {
    const sec = slot.byId.get(id), size = layout.sections[id].size;
    out.set(bytes.subarray(sec.index * SECTOR_BYTES, sec.index * SECTOR_BYTES + size), at);
    at += size;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------------
// one Pokemon record
// ------------------------------------------------------------------------------------------------------------------------------
/** Level from experience: the highest L whose cumulative-EXP row entry is <= exp. */
export function levelFromExp(pack, growthRate, exp) {
  const row = pack.exp && pack.exp[growthRate];
  if (!row) return 1;
  let level = 1;
  for (let l = 2; l <= 100; l++) { if (exp >= row[l]) level = l; else break; }
  return level;
}

/** Decode the raw fields of one record (76-byte box record, 96-byte party record) at `o`. No pack needed. Pure bit extraction; every
 *  packed field follows FIELD (see the header for how each was established). */
export function decodeRaw(b, o, hasParty) {
  const personality = u32(b, o + FIELD.personality), otId = u32(b, o + FIELD.otId);
  const speciesWord = u16(b, o + FIELD.speciesWord), itemWord = u16(b, o + FIELD.itemWord);
  const ivWord = u32(b, o + FIELD.ivWord);
  const bitsOf = (spec) => (b[o + spec.offset] >> spec.shift) & ((1 << (spec.bits || 1)) - 1);
  const raw = {
    personality, otId, tid: otId & 0xffff, sid: otId >>> 16,
    nicknameBytes: b.subarray(o + FIELD.nickname, o + FIELD.nickname + FIELD.nicknameLen),
    otNameBytes: b.subarray(o + FIELD.otName, o + FIELD.otName + FIELD.otNameLen),
    flagsA: b[o + FIELD.flagsA], flagsB: b[o + FIELD.flagsB],
    language: b[o + FIELD.flagsA] & 7,
    natureXor: bitsOf(FIELD.natureXor),
    hasSpecies: (b[o + FIELD.flagsB] >> 1) & 1, isBadEgg: b[o + FIELD.flagsB] & 1,
    // an Egg is flagged twice by the game (flag byte bit 2 AND IV word bit 30, SetBoxMonData case 55); either one alone also shows an Egg in the Summary
    isEgg: ((b[o + FIELD.flagsB] >> 2) & 1) | ((ivWord >>> 30) & 1),
    shinyModifier: bitsOf(FIELD.shinyModifierBit),
    hpLost: u16(b, o + FIELD.shinyWord) & 0x3fff,
    species: speciesWord & 0x7ff, teraType: speciesWord >>> 11,
    heldItem: itemWord & 0x3ff, ball: itemWord >>> 10,
    experience: u32(b, o + FIELD.experience) & FIELD.expMask, expTopByte: b[o + FIELD.experience + 3],
    ppBonuses: b[o + FIELD.ppBonuses], friendship: b[o + FIELD.friendship],
    moves: [0, 1, 2, 3].map((i) => u16(b, o + FIELD.moves + i * 2) & FIELD.moveMask),
    pp: [0, 1, 2, 3].map((i) => b[o + FIELD.pp + i] & FIELD.ppMask),
    ev: {}, iv: {}, hyper: {},
    abilityNum: bitsOf(FIELD.abilityNum),
    ivWord, origins: u16(b, o + FIELD.origins), metLocation: b[o + FIELD.metLocation],
  };
  ROM_STATS.forEach((k, i) => { raw.ev[k] = b[o + FIELD.evs + i]; raw.iv[k] = (ivWord >>> (i * 5)) & 31; raw.hyper[k] = bitsOf(FIELD.hyper[k]); });
  if (hasParty) {
    raw.party = { level: b[o + FIELD.level], hp: u16(b, o + FIELD.hp), maxHp: u16(b, o + FIELD.maxHp), stats: {}, status: u32(b, o + FIELD.status) };
    for (const k of ['atk', 'def', 'spe', 'spa', 'spd']) raw.party.stats[k] = u16(b, o + FIELD[k]);
    raw.party.stats.hp = raw.party.maxHp;
  }
  return raw;
}

const emptyRecord = (b, o, len) => { for (let i = 0; i < len; i++) if (b[o + i] !== 0) return false; return true; };

/** Nature the game uses: personality % 25 XOR the 5-bit delta stored in the flag byte (SetBoxMonData case 12; Mints change the delta). */
export function natureOf(raw) { return (raw.personality % 25) ^ raw.natureXor; }

/** Reasons a decoded record cannot be imported (null = fine). */
function rejectReason(raw, pack) {
  if (raw.isEgg) return { code: 'mon.egg', message: 'an Egg cannot be imported' };
  if (raw.isBadEgg) return { code: 'mon.bad-egg', message: 'the record is flagged as a Bad Egg' };
  if (raw.species === 0) return { code: 'mon.no-species', message: 'the record has no species' };
  const sp = raw.species < pack.species.length ? pack.species[raw.species] : null;
  if (!sp) return { code: 'species.unknown', message: `species id ${raw.species} is not in this ROM's species table` };
  if (!sp.legal) return { code: 'species.illegal', message: `species id ${raw.species} (${sp.name}) is not a legal roster species` };
  // measured in the real game: a record whose nature index is 25 or more RESETS the console (tools/pokemonarena_saveimport_test.mjs, [enc] nature range)
  if (natureOf(raw) >= pack.natures.length) return { code: 'mon.nature-range', message: `the stored nature index is ${natureOf(raw)} (personality % 25 xor ${raw.natureXor}); the game itself crashes on it` };
  return null;
}

/** Build a profile.js Pokemon record from the raw fields. `ctx` = { pack, nextId, now, shinyThreshold, provenance }. Returns { mon, notes, hyperList }. */
function buildMon(raw, ctx, level) {
  const { pack } = ctx;
  const sp = pack.species[raw.species];
  const notes = [];
  const nature = natureOf(raw);
  const ratio = sp.genderRatio;
  const gender = ratio === 255 ? '-' : ratio === 0 ? 'M' : ratio === 254 ? 'F' : ((raw.personality & 0xff) >= ratio ? 'M' : 'F');
  // SHINY: the game's rule is (tid ^ sid ^ pid_hi ^ pid_lo) < threshold, XOR the stored shiny-modifier bit (SetBoxMonData case 11; Pidgey sprite palettes
  // in the real game: xor 3 -> shiny, xor 3 + modifier -> NOT shiny, xor 100 -> shiny, xor 600 -> normal, xor 600 + modifier -> shiny). The threshold is 512,
  // or 256 once story flag 0x95e is set (cleared/set in a copy of the real save and re-measured: xor 256..511 shiny only with the flag clear).
  const natural = ((raw.tid ^ raw.sid ^ (raw.personality >>> 16) ^ (raw.personality & 0xffff)) >>> 0) < ctx.shinyThreshold;
  const shiny = natural !== (raw.shinyModifier === 1);
  // ABILITY: the index is 2 bits at record byte 0x33 bits 4-5; the game shows the highest NON-EMPTY slot at or below it (an index of 3 behaves as 2;
  // an empty slot falls back downwards). Measured on Pidgey (3 abilities) and Sprigatito (slot 1 empty).
  const slots = sp.abilities;
  const wanted = Math.min(raw.abilityNum, 2);
  let abilitySlot = wanted;
  if (wanted !== raw.abilityNum) notes.push({ code: 'ability.index-clamped', message: `the stored ability index ${raw.abilityNum} was read as 2, as the game does` });
  while (abilitySlot > 0 && !slots[abilitySlot]) abilitySlot--;
  if (abilitySlot !== wanted) notes.push({ code: 'ability.slot-fallback', message: `ability slot ${wanted} is empty for this species; the game uses slot ${abilitySlot}`, stored: raw.abilityNum, used: abilitySlot });
  const ev = {}, iv = {}, hyperList = [];
  ROM_STATS.forEach((k) => { ev[k] = raw.ev[k]; iv[k] = raw.hyper[k] ? 31 : raw.iv[k]; if (raw.hyper[k]) hyperList.push(k); });
  if (hyperList.length) notes.push({ code: 'iv.hyper-trained', message: `hyper-trained stat(s) ${hyperList.join(', ')} count as IV 31 (as the game shows and uses them)`, stats: hyperList, storedIvs: { ...raw.iv } });
  const moves = [];
  for (let i = 0; i < 4; i++) if (raw.moves[i] !== 0) moves.push({ id: raw.moves[i], ppUps: (raw.ppBonuses >> (i * 2)) & 3 });
  const nick = decodeField(raw.nicknameBytes, 0, FIELD.nicknameLen);
  const ot = decodeField(raw.otNameBytes, 0, FIELD.otNameLen);
  const mon = {
    id: ctx.nextId(), species: raw.species, nickname: nick.toUpperCase() === sp.name.toUpperCase() ? '' : nick, level, nature, abilitySlot, heldItem: raw.heldItem,
    moves, ev, iv, gender, shiny, friendship: raw.friendship,
    originalTrainer: { name: ot, tid: raw.tid, sid: raw.sid },
    origin: SAVE_ORIGIN, provenance: { ...ctx.provenance, pid: raw.personality, otId: raw.otId },
    createdAt: ctx.now, updatedAt: ctx.now,
  };
  return { mon, notes, hyperList };
}

// ------------------------------------------------------------------------------------------------------------------------------
// the importer
// ------------------------------------------------------------------------------------------------------------------------------
function textOk(s, max) { return typeof s === 'string' && [...s].length <= max; }

/** Turn rules.js reasons into "which field needs fixing" entries. */
function fixesFrom(reasons) {
  const out = [];
  for (const r of reasons || []) {
    const path = String(r.path || '');
    let field = path.split(/[.[]/)[0] || 'record';
    if (field === 'item') field = 'heldItem';
    if (/^moves?\b/.test(path) || r.code.startsWith('move')) field = 'moves';
    if (r.code.startsWith('ability')) field = 'ability';
    out.push({ field, code: r.code, path, message: r.message, ...(r.move !== undefined ? { move: r.move } : {}), ...(r.why ? { why: r.why } : {}) });
  }
  return out;
}

function checkPack(pack, rom) {
  if (!pack || typeof pack !== 'object' || !Array.isArray(pack.species) || !Array.isArray(pack.exp) || !pack.rom) return err('save.wrong-rom', { detail: 'the pack is not a tables.js pack' });
  const p = pack.rom;
  if (p.sha256 !== undefined && p.sha256 !== null && p.sha256 !== PINNED.sha256) return err('save.wrong-rom', { detail: 'the pack was decoded from another ROM', packSha256: p.sha256 });
  if (p.length !== PINNED.length || p.gameCode !== PINNED.gameCode || p.title !== PINNED.title) return err('save.wrong-rom', { detail: 'the pack header does not match SoulGold v1.1.1', packRom: { length: p.length, title: p.title, gameCode: p.gameCode } });
  const r = toBytes(rom);
  if (r) {
    let h = null;
    try { h = readHeader(r); } catch (_e) { h = null; }
    if (!h || r.length !== PINNED.length || h.gameCode !== PINNED.gameCode || h.title !== PINNED.title) return err('save.wrong-rom', { detail: 'the ROM bytes are not SoulGold v1.1.1' });
  }
  return null;
}

export function importSave(input, opts = {}) {
  try {
    return importSaveInner(input, opts || {});
  } catch (e) {
    return err('save.internal', { detail: String(e && e.message ? e.message : e) });
  }
}

function importSaveInner(input, opts) {
  const all = toBytes(input);
  if (!all) return err('save.bad-input');
  if (!ACCEPTED_SIZES.includes(all.length)) return err('save.size', { size: all.length, accepted: ACCEPTED_SIZES.slice() });
  const bytes = all.subarray(0, FLASH_BYTES);
  const { pack, ruleset = 'arena-gen3-standard' } = opts;
  const bad = checkPack(pack, opts.rom);
  if (bad) return bad;
  let layout = opts.layout;
  if (!layout) {
    if (!opts.rom) return err('save.rom-missing');
    const l = readLayout(opts.rom);
    if (!l.ok) return err('save.layout', { detail: l.why });
    layout = l.layout;
  }
  const warnings = [];
  let allFF = true;
  for (let i = 0; i < FLASH_BYTES; i++) if (bytes[i] !== 0xff) { allFF = false; break; }
  if (allFF) return err('save.empty');

  const sel = chooseSlot(bytes, layout);
  warnings.push(...sel.warnings);
  if (!sel.chosen) return err('save.no-valid-slot', { slots: sel.slots.map((s) => ({ slot: s.slot, counter: s.counter, problems: s.problems.slice(0, 8), missing: s.missing })) });
  if (all.length === 0x22000 || all.length === 0x20010) warnings.push({ code: 'save.size-extra', message: `the file is ${hex(all.length)} bytes; only the first 0x20000 (the flash image) were read`, size: all.length });
  const slot = sel.chosen;

  const sb2 = assemble(bytes, slot, layout, 0, 0, layout.sb2Size);
  const sb1 = assemble(bytes, slot, layout, 1, 4, layout.sb1Size);
  const storage = assemble(bytes, slot, layout, 5, 13, layout.storageSize);

  const now = opts.deps && typeof opts.deps.now === 'function' ? opts.deps.now() : 0;
  let idn = 0;
  const idPrefix = 'sv' + (slot.counter >>> 0).toString(36);
  const nextId = () => idPrefix + '-' + (++idn).toString(36);

  // ---- trainer
  const nameBytes = sb2.subarray(BLOCK.sb2.name, BLOCK.sb2.name + BLOCK.sb2.nameLen);
  const trainer = { name: decodeField(nameBytes, 0, BLOCK.sb2.nameLen), gender: sb2[BLOCK.sb2.gender] === 1 ? 'F' : 'M', tid: u16(sb2, BLOCK.sb2.tid), sid: u16(sb2, BLOCK.sb2.sid) };
  trainer.id = trainer.tid;
  if (sb2[BLOCK.sb2.gender] > 1) warnings.push({ code: 'trainer.gender', message: `the trainer gender byte is ${sb2[BLOCK.sb2.gender]}; read as male` });

  // story flag 0x95e (SaveBlock1 flag array) halves the shiny threshold from 512 to 256 (ROM 0x1ebc7e reads it through FlagGet, ROM 0x132f14)
  const shinyFlag = (sb1[BLOCK.sb1.flags + (BLOCK.sb1.shinyFlag >> 3)] >> (BLOCK.sb1.shinyFlag & 7)) & 1;
  const shinyThreshold = shinyFlag ? 256 : 512;
  const reports = {}, party = [], boxes = [], rejected = [];
  let total = 0, legal = 0, needsFix = 0, statMons = 0, statsMatched = 0, statsTotal = 0;
  const saveSha256 = typeof opts.saveSha256 === 'string' && /^[0-9a-f]{64}$/.test(opts.saveSha256) ? opts.saveSha256 : undefined;

  const doRecord = (b, o, hasParty, where, provExtra) => {
    const len = hasParty ? FIELD.partyBytes : BLOCK.storage.recordBytes;
    if (emptyRecord(b, o, Math.min(len, FIELD.boxBytes))) return null;
    const raw = decodeRaw(b, o, hasParty);
    total++;
    const why = rejectReason(raw, pack);
    if (why) { rejected.push({ where, species: raw.species, reason: why.code, code: why.code, message: why.message }); return null; }
    const sp = pack.species[raw.species];
    // LEVEL comes from the EXP and the species' growth rate, never from the stored level byte: in the real game a party record whose level
    // byte says 50 but whose EXP is a level-20 amount is shown as Lv20 (and an EXP above the cap as Lv100).
    const fromExp = levelFromExp(pack, sp.growthRate, raw.experience);
    const level = fromExp;
    const notes = [];
    if (raw.experience > pack.exp[sp.growthRate][100]) notes.push({ code: 'exp.over-cap', message: `${raw.experience} EXP is above the level-100 amount; level 100 was used`, exp: raw.experience });
    if (hasParty && raw.party.level !== fromExp) notes.push({ code: 'level.stored-differs', message: `the stored level byte is ${raw.party.level}; the level from EXP (${fromExp}) was used, as the game does`, stored: raw.party.level, fromExp });
    const ctx = { pack, nextId, now, shinyThreshold, provenance: { source: 'save', ...(saveSha256 ? { saveSha256 } : {}), ...provExtra } };
    const built = buildMon(raw, ctx, level);
    notes.push(...built.notes);
    const mon = built.mon;
    // shape repair that never loses the Pokemon: a nickname/OT name longer than the profile allows is cut and reported
    if (!textOk(mon.nickname, 10)) { notes.push({ code: 'nickname.cut', message: `the nickname "${mon.nickname}" is longer than 10 characters and was cut` }); mon.nickname = [...mon.nickname].slice(0, 10).join(''); }
    if (!textOk(mon.originalTrainer.name, 10)) mon.originalTrainer.name = [...mon.originalTrainer.name].slice(0, 10).join('');
    if (!mon.moves.length) { notes.push({ code: 'moves.none', message: 'the record has no moves' }); }
    const shape = checkMon(mon, 'mon');
    if (shape.length) { rejected.push({ where, species: raw.species, reason: 'mon.shape', code: 'mon.shape', message: 'the decoded record is not a valid profile record: ' + shape.map((s) => s.code + ' ' + s.path).join(', '), problems: shape.slice(0, 6) }); return null; }
    let validation;
    try { validation = validateStoredMon(mon, pack, ruleset); } catch (e) { return err('save.internal', { detail: 'validation threw: ' + String(e && e.message ? e.message : e) }); }
    if (validation.ok) legal++; else needsFix++;
    let selfCheck = null;
    if (hasParty) {
      const base = sp.baseStats;
      const rec = computeStats(base, mon.iv, mon.ev, level, mon.nature, pack.natures);
      const stored = raw.party.stats;
      const mism = [];
      for (const k of ROM_STATS) if (rec[k] !== stored[k]) mism.push({ stat: k, computed: rec[k], stored: stored[k] });
      // NOTE: the game recomputes the stats of a loaded party record (a record with a deliberately wrong stored Attack shows the computed one),
      // so a mismatch here means a mis-decoded EV/IV/nature/level field, or a stale stored value; it is reported, never fatal.
      selfCheck = { computed: rec, stored: { ...stored }, mismatches: mism, matched: ROM_STATS.length - mism.length, total: ROM_STATS.length };
      statMons++; statsMatched += selfCheck.matched; statsTotal += selfCheck.total;
      if (mism.length) notes.push({ code: 'stats.mismatch', message: `${mism.length} of 6 stored stats differ from the stats computed from the decoded EV/IV/nature/level: ${mism.map((m) => m.stat).join(', ')}`, mismatches: mism });
    }
    reports[mon.id] = {
      where, validation, fixes: fixesFrom(validation.reasons), notes,
      derived: { level, levelFromExp: fromExp, exp: raw.experience, growthRate: sp.growthRate, speciesName: sp.name, abilityNum: raw.abilityNum, ball: raw.ball, ppBonuses: raw.ppBonuses, metLocation: raw.metLocation, hyperTrained: built.hyperList, natureXor: raw.natureXor, shinyModifier: raw.shinyModifier, shinyThreshold, language: raw.language, egg: false, partyStatus: hasParty ? raw.party.status : 0, hp: hasParty ? raw.party.hp : null },
      selfCheck,
    };
    return mon;
  };

  // ---- party
  const countRaw = u32(sb1, BLOCK.sb1.partyCount);
  let partyCount = countRaw;
  if (countRaw > BLOCK.sb1.partyMax) { warnings.push({ code: 'party.count', message: `the stored party count is ${countRaw}; it was clamped to ${BLOCK.sb1.partyMax}` }); partyCount = BLOCK.sb1.partyMax; }
  for (let i = 0; i < partyCount; i++) {
    const m = doRecord(sb1, BLOCK.sb1.party + i * BLOCK.sb1.partyStride, true, { party: true, slot: i }, { slot: i });
    if (m && m.ok === false) return m;
    if (m) party.push(m);
  }

  // ---- storage
  const S = BLOCK.storage;
  let tagOk = true;
  for (let i = 0; i < S.tagText.length; i++) if (storage[S.tag + i] !== S.tagText.charCodeAt(i)) tagOk = false;
  if (!tagOk) warnings.push({ code: 'storage.tag', message: `the PC storage tag "${S.tagText}" is missing; the boxes may be from a different layout and were read anyway` });
  const current = storage[S.currentBox];
  for (let bx = 0; bx < S.boxCount; bx++) {
    const mons = [];
    for (let sl = 0; sl < S.perBox; sl++) {
      const m = doRecord(storage, S.boxes + (bx * S.perBox + sl) * S.recordBytes, false, { box: bx, slot: sl }, { slot: sl, box: bx });
      if (m && m.ok === false) return m;
      if (m) mons.push(m);
    }
    const nm = decodeField(storage, S.names + bx * S.nameStride, S.nameStride);
    boxes.push({ index: bx, name: nm, current: bx === current, wallpaper: storage[S.wallpapers + bx], mons });
  }

  const warn2 = [];
  if (partyCount === 0 && boxes.every((b) => !b.mons.length) && !rejected.length) warn2.push({ code: 'save.no-pokemon', message: 'the save holds no Pokemon' });
  return {
    ok: true,
    container: { size: all.length, slotUsed: slot.slot, counter: slot.counter, fallback: sel.fallback, slots: sel.slots.map((s) => ({ slot: s.slot, valid: s.valid, counter: s.counter, problems: s.problems.length, missing: s.missing.slice() })) },
    trainer, party, boxes, reports,
    summary: { total, legal, needsFix, rejected: rejected.length, statCheck: statMons ? { mons: statMons, statsMatched, statsTotal, rate: statsMatched / statsTotal } : null },
    warnings: warnings.concat(warn2), rejected,
  };
}

/** Async wrapper for pages: File / Blob / ArrayBuffer / Uint8Array in, importSave result out. Never throws. */
export async function importSaveFile(file, opts = {}) {
  try {
    let src = file;
    if (src && typeof src.arrayBuffer === 'function') src = await src.arrayBuffer();
    return importSave(src, opts);
  } catch (e) {
    return err('save.internal', { detail: String(e && e.message ? e.message : e) });
  }
}

/** The pieces a test needs without a pack: container parse only. */
export function parseContainer(input, layout) {
  const all = toBytes(input);
  if (!all || !ACCEPTED_SIZES.includes(all.length)) return null;
  return chooseSlot(all.subarray(0, FLASH_BYTES), layout);
}
export { decodeText };

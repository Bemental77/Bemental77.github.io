// pokemonarena/js/speciesgfx.js
//
// Species and trainer graphics of the SoulGold v1.1.1 ROM, decoded at runtime from the ROM bytes the caller
// supplies. Pure ES module (browser + Node). Holds offsets and layout rules only; no ROM-derived data.
//
//   import { speciesGfx, trainerFront, trainerBack, trainerHead } from './speciesgfx.js';
//   const g = speciesGfx(rom, 25);      // Pikachu
//   g.front.frames[0]   // { width:64, height:64, pixels }  (indices 0..15, 0 = transparent)
//   g.palettes.normal   // Uint16Array(16) BGR555;  g.palettes.shiny likewise
//
// Struct layout (measured against the ROM, offsets relative to a species slot):
//   table 0x7c7310, stride 0x118, slot n at 0x7c7310 + n*0x118 (slot = species id, 1..1577; 539 slots are all-zero)
//   +0x33 name (13 bytes, Gen-3 charset)   +0x5c front pic ptr (smol)   +0x60 back pic ptr (smol)
//   +0x64 palette ptr   +0x68 shiny palette ptr   +0x6c icon ptr (raw 32x64, two 32x32 frames)
//   +0x70/+0x74/+0x78/+0x7c/+0x80 female front/back/pal/shiny pal/icon (only a few species)
//   +0x8c front size byte (tiles w<<4|h)  +0x8d front y offset  +0x8e back size byte  +0x8f back y offset
//   +0x92 low 3 bits = shared icon palette index  (+0x93 is 0 in every slot; the foe elevation is at +0x9c, the shadow at +0xa2..+0xa4)
//   +0x94 icon palette ptr  +0x98 shiny icon palette ptr (0 for 51 slots: those use the shared table)
//   shared icon palettes: 6 SpritePalette records {ptr, tag} at 0xf076b0
// Palettes are read through the pointers, NEVER inferred from "pic - 0x20": that adjacency holds for only 918
// of the 1038 populated slots.

import { smolDecode, tilesToBitmap, cropBitmap, readPalette, GfxError } from './gfxcodec.js';
import { decodeGen3String } from './uiassets.js';

export const SPECIES_TABLE = 0x7c7310;
export const SPECIES_STRIDE = 0x118;
export const MAX_SPECIES_ID = 1577;
export const ICON_PALETTE_TABLE = 0xf076b0;
export const TRAINER_FRONT_TABLE = 0x6e1c60, TRAINER_FRONT_STRIDE = 32, TRAINER_FRONT_COUNT = 134;
export const TRAINER_BACK_TABLE = 0x6e1b28, TRAINER_BACK_STRIDE = 24, TRAINER_BACK_COUNT = 8;
export const TRAINER_HEAD_TABLE = 0x5b13c0, TRAINER_HEAD_STRIDE = 16, TRAINER_HEAD_COUNT = 52;
export const TYPE_ICON_SHEET = 0x6a3ef8;

const u32 = (rom, o) => (rom[o] | (rom[o + 1] << 8) | (rom[o + 2] << 16) | (rom[o + 3] << 24)) >>> 0;
function ptr(rom, p) {
  if (p === 0) return 0;
  if (p < 0x08000000 || p >= 0x08000000 + rom.length) throw new GfxError('bad ROM pointer 0x' + p.toString(16));
  return p - 0x08000000;
}

export function speciesSlot(rom, id) {
  if (!Number.isInteger(id) || id < 1 || id > MAX_SPECIES_ID) throw new GfxError('species id out of range: ' + id);
  return SPECIES_TABLE + id * SPECIES_STRIDE;
}

// Raw pointer fields of a slot as ROM offsets (0 = null). Returns null for an all-zero (removed) slot.
export function speciesRecord(rom, id) {
  const b = speciesSlot(rom, id);
  const front = ptr(rom, u32(rom, b + 0x5c));
  if (!front) return null;
  return {
    id, slot: b,
    name: decodeGen3String(rom, b + 0x33, 13),
    front, back: ptr(rom, u32(rom, b + 0x60)), pal: ptr(rom, u32(rom, b + 0x64)), shinyPal: ptr(rom, u32(rom, b + 0x68)),
    icon: ptr(rom, u32(rom, b + 0x6c)), iconPal: ptr(rom, u32(rom, b + 0x94)), iconShinyPal: ptr(rom, u32(rom, b + 0x98)),
    iconPalIndex: rom[b + 0x92] & 7,
    female: {
      front: ptr(rom, u32(rom, b + 0x70)), back: ptr(rom, u32(rom, b + 0x74)), pal: ptr(rom, u32(rom, b + 0x78)),
      shinyPal: ptr(rom, u32(rom, b + 0x7c)), icon: ptr(rom, u32(rom, b + 0x80)),
    },
    frontSize: rom[b + 0x8c], frontYOffset: rom[b + 0x8d], backSize: rom[b + 0x8e], backYOffset: rom[b + 0x8f],
    // FA1: the foe's elevation is the byte at +0x9c (it was read from +0x93, which is 0 in every one of the 1,038 species, so no floating Pokemon was ever lifted);
    // the foe's ground shadow: +0xa4 shape class 0..3 (which 64x8 of the 32 shadow tiles), +0xa2 / +0xa3 signed x / y offsets. All verified against the oracle's OAM
    // on 13 species (shadow sprite at (144 + dx, spriteTop + 44 + dy), spriteTop = 8 + frontYOffset - elevation).
    elevation: rom[b + 0x9c],
    shadow: { size: rom[b + 0xa4] & 3, dx: (rom[b + 0xa2] << 24) >> 24, dy: (rom[b + 0xa3] << 24) >> 24 },
  };
}

function frames64(data, perFrameBytes) {
  const n = Math.floor(data.length / perFrameBytes);
  const out = [];
  for (let k = 0; k < n; k++) out.push(tilesToBitmap(data.subarray(k * perFrameBytes, (k + 1) * perFrameBytes), 8, 8));
  return out;
}

// Decode everything the battle / team UI needs for one species. opts.female selects the female variants where the
// ROM has them (falls back to the base art). Returns null for a removed (all-zero) slot.
// front.frames: 1 or 2 bitmaps of 64x64 (689 of 1038 species have a second frame); back.frames: 1.
// icon: { frames: [32x32, 32x32] } or null (51 slots have no icon: e.g. 1557 Staraptor).
export function speciesGfx(rom, id, opts = {}) {
  const r = speciesRecord(rom, id);
  if (!r) return null;
  const f = opts.female ? r.female : null;
  const frontOff = (f && f.front) || r.front;
  const backOff = (f && f.back) || r.back;
  const palOff = (f && f.pal) || r.pal;
  const shinyOff = (f && f.shinyPal) || r.shinyPal;
  const iconOff = (f && f.icon) || r.icon;
  const front = smolDecode(rom, frontOff).data, back = smolDecode(rom, backOff).data;
  const shared = (idx) => {
    const e = ICON_PALETTE_TABLE + idx * 8;
    return readPalette(rom, ptr(rom, u32(rom, e)), 16);
  };
  let icon = null, iconPalette = null, iconShinyPalette = null;
  if (iconOff) {
    const sheet = tilesToBitmap(rom.subarray(iconOff, iconOff + 1024), 4, 8);   // frame 0 on top, frame 1 below
    icon = { frames: [cropBitmap(sheet, 0, 0, 32, 32), cropBitmap(sheet, 0, 32, 32, 32)] };
    iconPalette = r.iconPal ? readPalette(rom, r.iconPal, 16) : shared(r.iconPalIndex);
    iconShinyPalette = r.iconShinyPal ? readPalette(rom, r.iconShinyPal, 16) : iconPalette;
  }
  return {
    id, name: r.name, elevation: r.elevation, shadow: r.shadow, yOffsets: { front: r.frontYOffset, back: r.backYOffset },
    sizeBytes: { front: r.frontSize, back: r.backSize },
    front: { frames: frames64(front, 2048) }, back: { frames: frames64(back, 2048) }, icon,
    palettes: {
      normal: readPalette(rom, palOff, 16), shiny: readPalette(rom, shinyOff, 16),
      icon: iconPalette, iconShiny: iconShinyPalette,
    },
  };
}

// Trainer classes: 134 front pics (smol 64x64), 8 back pics (raw, 4 or 5 frames of 64x64), 52 head portraits
// (smol 64x64). Palettes are read through the table's own pointer.
export function trainerFront(rom, index) {
  if (!(index >= 0 && index < TRAINER_FRONT_COUNT)) throw new GfxError('trainer front index out of range: ' + index);
  const o = TRAINER_FRONT_TABLE + index * TRAINER_FRONT_STRIDE;
  const bm = tilesToBitmap(smolDecode(rom, ptr(rom, u32(rom, o + 4))).data, 8, 8);
  return { index, bitmap: bm, palette: readPalette(rom, ptr(rom, u32(rom, o + 12)), 16) };
}
export function trainerBack(rom, index) {
  if (!(index >= 0 && index < TRAINER_BACK_COUNT)) throw new GfxError('trainer back index out of range: ' + index);
  const o = TRAINER_BACK_TABLE + index * TRAINER_BACK_STRIDE;
  const data = ptr(rom, u32(rom, o + 4));
  const frameCount = rom[o + 1];                      // y_offset field; equals the data-pointer spacing / 0x800 for all 8 entries
  const frames = [];
  for (let k = 0; k < frameCount; k++) frames.push(tilesToBitmap(rom.subarray(data + k * 0x800, data + (k + 1) * 0x800), 8, 8));
  return { index, frames, palette: readPalette(rom, ptr(rom, u32(rom, o + 12)), 16) };
}
export function trainerHead(rom, index) {
  if (!(index >= 0 && index < TRAINER_HEAD_COUNT)) throw new GfxError('trainer head index out of range: ' + index);
  const o = TRAINER_HEAD_TABLE + index * TRAINER_HEAD_STRIDE;
  const bm = tilesToBitmap(smolDecode(rom, ptr(rom, u32(rom, o))).data, 8, 8);
  return { index, bitmap: bm, palette: readPalette(rom, ptr(rom, u32(rom, o + 4)), 16) };
}

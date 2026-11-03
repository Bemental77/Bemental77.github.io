// pokemonarena/js/anim_mon.js -- Pokemon-sprite and system animation data for the battle scene (AN1).
//
// Pure ES module (browser + Node): reads the ROM bytes the caller passes, holds offsets and rules only (no ROM-derived data is stored here).
//
// WHAT THIS MODULE KNOWS FROM THE ROM (all measured on SoulGold v1.1.1, cross-checked by tools/pokemonarena_anim_scene_test.mjs):
//   * Each species record (speciesgfx.js: table 0x7c7310, stride 0x118) carries its sprite-animation fields:
//       +0x54  u8   flags byte (low nibble 0..9, bit 7 on 130 species); meaning NOT decoded
//       +0x55  u8   front animation delay (frames): 0 for 975 species, 3..70 otherwise
//       +0x56  u8   front animation id (0..153), the index of the species' front-sprite MOTION routine
//       +0x57  u8   back animation id (0..25), the index of the back-sprite motion routine
//       +0x58  ptr  { ptr -> animation 0 (always the single static frame), ptr -> animation 1 (the frame swap played when the mon is sent out) }
//     An animation is a list of 4-byte commands: s16 image index (>= 0: show that picture, -1: END, -2: JUMP, -3: LOOP) and u16 (low byte = frames
//     to show it, high bits = flip flags). 349 of the 1038 species have the one-command list [(0,1)] and so no second picture; that is exactly
//     the count of species speciesgfx.js finds with a single front frame (1038 - 689 = 349), which is the check that these are the right fields.
//   * WHAT IS NOT DECODED: the motion routines themselves (what frontAnimId / backAnimId DO to the sprite's position, scale and rotation) are
//     native THUMB code in the ROM. They are not run or ported here, so the front sprite swaps its two ROM pictures at the ROM's own times but
//     does not move. frontAnimId / backAnimId are exposed so a later stage can drive them.
//
import { smolDecode, tilesToBitmap, readPalette } from './gfxcodec.js';

// ANIMATION IDS used with the shared move animator (workflows/pokemonarena-anim.md SHARED CONTRACT). The ids follow the Gen-3 engine's enum order
// (RECOLLECTION of pokeemerald constants/battle_anim.h, NOT read from this ROM; tools/pokemonarena_anim_scene_test.mjs asks the real animator
// whether each is available, and move_anim.js's coverage table is the authority).

export const GENERAL = Object.freeze({
  STATS_CHANGE: 0, SUBSTITUTE_FADE: 1, SUBSTITUTE_APPEAR: 2, POKEBLOCK_THROW: 3, ITEM_KNOCKOFF: 4, TURN_TRAP: 5, ITEM_EFFECT: 6, SMOKEBALL_ESCAPE: 7,
  HANGED_ON: 8, RAIN_CONTINUES: 9, SUN_CONTINUES: 10, SANDSTORM_CONTINUES: 11, HAIL_CONTINUES: 12, LEECH_SEED_DRAIN: 13, MON_HIT: 14, ITEM_STEAL: 15,
  SNATCH_MOVE: 16, FUTURE_SIGHT_HIT: 17, DOOM_DESIRE_HIT: 18, FOCUS_PUNCH_SETUP: 19, INGRAIN_HEAL: 20, WISH_HEAL: 21,
  STRONG_WINDS_CONTINUE: 29,    // AN1 round 6: NOT in the vanilla enum; the id the REAL game plays when Delta Stream takes the field (oracle, tools/pokemonarena_anim_scene_test.mjs "primal weather")
});
export const STATUS = Object.freeze({ PSN: 0, CONFUSION: 1, BRN: 2, INFATUATION: 3, SLP: 4, PRZ: 5, FRZ: 6, CURSED: 7, NIGHTMARE: 8 });
export const SPECIAL = Object.freeze({ LVL_UP: 0, SWITCH_OUT_PLAYER_MON: 1, SWITCH_OUT_OPPONENT_MON: 2, BALL_THROW: 3, SAFARI_BALL_THROW: 4, SUBSTITUTE_TO_MON: 5, MON_TO_SUBSTITUTE: 6 });

// the engine's status codes (events: status-set st) -> status animation id
export const STATUS_ANIM_OF = Object.freeze({ 1: STATUS.SLP, 2: STATUS.PSN, 3: STATUS.BRN, 4: STATUS.FRZ, 5: STATUS.PRZ, 6: STATUS.PSN, 7: STATUS.FRZ });       // 7 = frostbite (the engine's round 3): the freeze status animation
// the engine's weather codes (events: weather w) -> the general animation that plays when the weather "continues"
// 6 / 7 / 8 = the primal weathers (heavy rain, extremely harsh sunlight, strong winds): MEASURED in the real game through the oracle (Primordial Sea plays general 9 exactly like Drizzle, Desolate Land
// general 10 like Drought, Delta Stream general 29), AN1 round 6
export const WEATHER_ANIM_OF = Object.freeze({ 1: GENERAL.RAIN_CONTINUES, 2: GENERAL.SUN_CONTINUES, 3: GENERAL.SANDSTORM_CONTINUES, 4: GENERAL.HAIL_CONTINUES, 5: GENERAL.HAIL_CONTINUES, 6: GENERAL.RAIN_CONTINUES, 7: GENERAL.SUN_CONTINUES, 8: GENERAL.STRONG_WINDS_CONTINUE });

// Stat-change animation argument: general animation 0 reads ctx.animArg (move_anim.js start(); ANIM.md "Stat-change argument", MEASURED by AN2 by running every value):
// 14..20 stat up one stage, 21..27 down one stage, 37..43 up two, 44..50 down two, each block in the order of the seven stats. The stat order inside a block is the game's
// stat numbering (atk, def, spe, spa, spd, acc, eva) -- AN2 says which slot is which stat is NOT verified, so the colour of an arrow may be a stat off.
export const STAT_ANIM_ID = Object.freeze({ atk: 1, def: 2, spe: 3, spa: 4, spd: 5, acc: 6, eva: 7 });
export const STAT_ANIM_BASE = Object.freeze({ plus1: 14, minus1: 21, plus2: 37, minus2: 44 });
export function statAnimArg(stat, delta) {
  const id = STAT_ANIM_ID[stat] || 1, n = Math.abs(delta | 0) >= 2 ? 2 : 1;
  const base = delta > 0 ? (n === 2 ? STAT_ANIM_BASE.plus2 : STAT_ANIM_BASE.plus1) : (n === 2 ? STAT_ANIM_BASE.minus2 : STAT_ANIM_BASE.minus1);
  return base + id - 1;
}

/* ------------------------------------------------------------------------------------------ species animation data */

const SPECIES_TABLE = 0x7c7310, SPECIES_STRIDE = 0x118, MAX_SPECIES_ID = 1577;
const u32 = (rom, o) => (rom[o] | (rom[o + 1] << 8) | (rom[o + 2] << 16) | (rom[o + 3] << 24)) >>> 0;
const u16 = (rom, o) => rom[o] | (rom[o + 1] << 8);
const toOff = (rom, p) => (p >= 0x08000000 && p + 4 <= 0x08000000 + rom.length ? p - 0x08000000 : -1);
export const ANIM_CMD_END = -1, ANIM_CMD_JUMP = -2, ANIM_CMD_LOOP = -3;

// one AnimCmd list at ROM offset `o` -> [{ img, dur, hflip, vflip } | { op: 'jump'|'loop', param }] up to and including END, or null when malformed
export function parseAnimCmds(rom, o, maxLen = 40) {
  if (o < 0) return null;
  const out = [];
  for (let i = 0; i < maxLen; i++) {
    const p = o + i * 4;
    if (p + 4 > rom.length) return null;
    const t = u16(rom, p), x = u16(rom, p + 2);
    if (t === 0xffff) { out.push({ op: 'end' }); return out; }
    if (t === 0xfffe) { out.push({ op: 'jump', param: x }); return out; }
    if (t === 0xfffd) { out.push({ op: 'loop', param: x }); continue; }
    if (t > 0x3ff) return null;
    out.push({ img: t, dur: x & 0xff, hflip: !!(x & 0x100), vflip: !!(x & 0x200) });
  }
  return null;
}

// -> { id, flags, delay, frontAnimId, backAnimId, cmds (animation 1: the frame swap), still (animation 0), frames (distinct pictures used), duration (frames) } | null
export function speciesAnimInfo(rom, id) {
  if (!Number.isInteger(id) || id < 1 || id > MAX_SPECIES_ID) return null;
  const b = SPECIES_TABLE + id * SPECIES_STRIDE;
  if (u32(rom, b + 0x5c) === 0) return null;                                    // removed slot (no front picture)
  const ptr = toOff(rom, u32(rom, b + 0x58));
  if (ptr < 0) return null;
  const a0 = toOff(rom, u32(rom, ptr)), a1 = toOff(rom, u32(rom, ptr + 4));
  const still = parseAnimCmds(rom, a0), cmds = parseAnimCmds(rom, a1);
  if (!still || !cmds) return null;
  const imgs = new Set(); let duration = 0;
  for (const c of cmds) if (c.img !== undefined) { imgs.add(c.img); duration += c.dur; }
  return { id, flags: rom[b + 0x54], delay: rom[b + 0x55], frontAnimId: rom[b + 0x56], backAnimId: rom[b + 0x57], cmds, still, frames: imgs.size, duration };
}

// the picture index shown t frames after the front animation was triggered (the delay comes first), 0 once it has ended. JUMP/LOOP are followed with a guard.
export function frontFrameAt(info, t) {
  if (!info) return 0;
  let n = t - info.delay;
  if (n < 0) return 0;
  const cmds = info.cmds;
  let i = 0, guard = 0;
  while (i < cmds.length && guard++ < 64) {
    const c = cmds[i];
    if (c.img === undefined) { if (c.op === 'jump') { i = c.param; continue; } if (c.op === 'end') return 0; i++; continue; }
    if (n < c.dur || c.dur === 0 && n === 0) return c.img;
    n -= c.dur; i++;
  }
  return 0;
}
// total frames the front animation lasts (delay + the sum of durations), 0 for a single-picture species
export function frontAnimLength(info) { return info && info.frames > 1 ? info.delay + info.duration : 0; }

/* ------------------------------------------------------------------------------------------------------ ball art */
// The ROM's ball sprites: 17 records of stride 0x2c at 0x7bb0bc, in the engine's ball order (index 0 is the teal "strange" ball, 1 the red Poke Ball, ...). Each
// record is { ptr -> smol sheet, u16 size 0x180, u16 tag 55000 + index, ptr -> raw 16-colour palette, u16 tag, ... the sprite template }; the sheet is three
// 16x16 pictures (closed, open, and a dark open frame some balls have). MEASURED: all 17 records satisfy size 0x180 and tag 55000 + index.
export const BALL_TABLE = 0x7bb0bc, BALL_STRIDE = 0x2c, BALL_COUNT = 17, BALL_TAG0 = 55000;
export function ballGfx(rom, index) {
  if (!Number.isInteger(index) || index < 0 || index >= BALL_COUNT) return null;
  const o = BALL_TABLE + index * BALL_STRIDE;
  if (u16(rom, o + 4) !== 0x180 || u16(rom, o + 6) !== BALL_TAG0 + index) return null;
  const sheet = toOff(rom, u32(rom, o)), pal = toOff(rom, u32(rom, o + 8));
  if (sheet < 0 || pal < 0 || pal + 32 > rom.length) return null;
  let data;
  try { data = smolDecode(rom, sheet).data; } catch (_e) { return null; }
  if (data.length !== 0x180) return null;
  const frames = [0, 1, 2].map((f) => tilesToBitmap(data.subarray(f * 128, (f + 1) * 128), 2, 2));
  return { index, frames, palette: readPalette(rom, pal, 16) };
}

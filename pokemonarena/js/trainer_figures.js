// pokemonarena/js/trainer_figures.js -- THE BATTLE FIGURES a trainer can choose (trainer_card.js `front` / `back`), found in the ROM's own tables.
//
// A battle shows trainers through the ROM's own battle code (anim_sys.js): the FOE's picture comes from a ROM trainer id (gTrainers[id].trainerPic), the player's back picture from the
// save block's gender byte. So a FRONT picture is only a battle figure when some ROM trainer uses it: that trainer's id is what a battle is handed to draw it (trainerForFront). This
// hack's gTrainers is at 0x497FBC, 52 bytes each (class +28, picture +30, name +31): the SAME table anim_sys.js reads for the CPU levels (its TRAINERS constant; a test compares the two),
// recognised by the class-name table at 0x43b03c (16 bytes each), so a different ROM gives empty lists instead of wrong pictures.
//
//   frontChoices(rom) -> [{ pic, trainerId, cls }]   every distinct front picture a ROM trainer uses, by picture index, with the FIRST trainer id that uses it and that trainer's class name
//   trainerForFront(rom, pic) -> trainer id | 0     the id a battle is handed to show `pic` (0: none; the battle keeps its own choice)
//   backChoices(rom) -> [index]                    the back pictures the player's own battles can show: every one of the ROM's back table (0..7) on this ROM (BATTLE track, measured: see backChoices)
//   FIGURE_DEFAULT = { front, back }               what an unchosen card shows
//
// Nothing ROM-derived is written here: offsets, strides and names of classes only. Pure ES module (browser + Node): no DOM, no clock, no storage. The ROM bytes are handed in; the lists are
// remembered per ROM buffer (a WeakMap), so the pickers can ask every frame.

import { decodeText } from './charset.js';

export const TRAINER_TABLE = Object.freeze({ offset: 0x497FBC, stride: 52, count: 1164, classAt: 28, picAt: 30, nameAt: 31 });
export const CLASS_TABLE = Object.freeze({ offset: 0x43b03c, stride: 16, count: 83 });
/** Front pictures that are not a person a player would stand as (found by looking at the contact sheet: the ROM uses them for a ghost and the like). Filled in by the TRAINER app track. */
export const FRONT_EXCLUDE = Object.freeze([]);
export const FIGURE_DEFAULT = Object.freeze({ front: null, back: 0 });

const cache = new WeakMap();
function scan(rom) {
  const out = [];
  try {
    if (!rom || rom.length < TRAINER_TABLE.offset + TRAINER_TABLE.stride * TRAINER_TABLE.count) return out;
    const text = (o, n) => { const b = []; for (let i = 0; i < n && rom[o + i] !== 0xff; i++) b.push(rom[o + i]); return decodeText(Uint8Array.from(b)); };
    const cname = (c) => (c < CLASS_TABLE.count ? text(CLASS_TABLE.offset + c * CLASS_TABLE.stride, 13) : '');
    if (cname(38) !== 'Champion' || cname(37) !== 'Youngster' || cname(31) !== 'Elite Four') return out;     // not the table this was written for
    const seen = new Set();
    for (let id = 1; id < TRAINER_TABLE.count; id++) {
      const o = TRAINER_TABLE.offset + id * TRAINER_TABLE.stride;
      if (!text(o + TRAINER_TABLE.nameAt, 12).trim()) continue;
      const pic = rom[o + TRAINER_TABLE.picAt];
      if (seen.has(pic) || FRONT_EXCLUDE.includes(pic)) continue;
      seen.add(pic);
      out.push(Object.freeze({ pic, trainerId: id, cls: cname(rom[o + TRAINER_TABLE.classAt]) }));
    }
    out.sort((a, b) => a.pic - b.pic);
  } catch (_e) { return []; }
  return out;
}
/** Every front picture a battle can show (see the header). Never throws; [] for a ROM this was not written for. */
export function frontChoices(rom) {
  if (!rom || typeof rom !== 'object') return [];
  let v = cache.get(rom);
  if (!v) { v = Object.freeze(scan(rom)); cache.set(rom, v); }
  return v;
}
/** The ROM trainer id that shows front picture `pic` in a battle, or 0 when no ROM trainer uses it. */
export function trainerForFront(rom, pic) {
  if (!Number.isInteger(pic)) return 0;
  const hit = frontChoices(rom).find((c) => c.pic === pic);
  return hit ? hit.trainerId : 0;
}
/** The back pictures the player's own battle can show (see the header). The ROM's battle code draws the player's back picture from the save block's gender byte, and it draws ANY index of its
 *  back table from it, not only the two genders: measured on this ROM (INAPP.md "BATTLE: as built" of the TRAINER section) by running the ROM's own trainer intro with the byte at 0..7: each index
 *  drew exactly the frames of speciesgfx.js trainerBack(rom, i) with its own palette (standing, the throw, sliding out), at the positions 0 and 1 use, and nothing else of the picture changed.
 *  tools/pokemonarena_battle_trainer_test.mjs B pins it. A ROM this was not measured on (no trainer table found: frontChoices is empty) keeps the two genders. */
export function backChoices(rom) {
  if (!frontChoices(rom).length) return [0, 1];
  const out = [];
  for (let i = 0; i < 8; i++) out.push(i);          // 8 = speciesgfx.js TRAINER_BACK_COUNT, the ROM back table (the test compares the two)
  return out;
}

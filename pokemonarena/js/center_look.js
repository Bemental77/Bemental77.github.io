// pokemonarena/js/center_look.js -- A TRAINER'S LOOK in the Trainer Center: which of the ROM's own overworld trainer sprites a player walks around as, and how that travels in seven characters
// (pokemonarena/INAPP.md "Contract 4"). It replaces the hand-drawn avatar module of the first Trainer Center: nothing is drawn here and there is no art, no palette and no colour in this file.
//
// THE CODE. A look is 'w' followed by the ROM graphics id of the sprite in base 36, left-padded with '0' to six characters: 'w000000' is graphics id 0, 'w00002h' is id 89. Seven characters of
// [0-9a-z], which is what the open-games board's listing carries as `av` (openlobby.js checks only that shape) and what the room's own messages carry (center_net.js).
// WHICH ids are a look is the ROM's business, not this file's: world_rom.js world.ow.avatars is the list (the 16x32 people with a drawn walk in four directions), and every function below that
// needs it is HANDED it. Nothing ROM-derived is in the source.
//   * an id that is not in that list draws the FIRST avatar (lookFor);
//   * an OLD code (first character 0-5: the seven base-36 digits of the hand-drawn Trainer Center) draws the first avatar too, and is never stored again (loadLook reads it as "no look").
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock; storage is injected and every use of it is inside a try.

/** localStorage: this browser's look (the key the first Trainer Center used; an old value under it reads as none). */
export const LOOK_KEY = 'arena.avatar';
/** A look code: 'w' and six base-36 digits. */
export const LOOK_RE = /^w[0-9a-z]{6}$/;
/** A code of the hand-drawn Trainer Center (seven base-36 digits, the first a skin tone 0-5): no sprite of the ROM. */
export const OLD_LOOK_RE = /^[0-5][0-9a-z]{6}$/;
/** The largest graphics id a code can hold (six base-36 digits). */
export const LOOK_ID_MAX = 36 ** 6 - 1;

/** A graphics id -> its code ('w00002h'), or null for anything that is not an id a code can hold. */
export function lookCode(id) {
  if (!Number.isInteger(id) || id < 0 || id > LOOK_ID_MAX) return null;
  return 'w' + id.toString(36).padStart(6, '0');
}
/** A code -> the graphics id it names, or null when it is not a look code at all (wrong length, wrong characters, an old code). Says nothing about whether the ROM has such a sprite. */
export function lookId(code) {
  if (typeof code !== 'string' || !LOOK_RE.test(code)) return null;
  const id = parseInt(code.slice(1), 36);
  return Number.isInteger(id) && id >= 0 ? id : null;
}
const listOf = (avatars) => (Array.isArray(avatars) ? avatars : []);
/** Is `code` a look a player can have: a look code whose id is one of `avatars` (world.ow.avatars)? */
export function isLook(code, avatars) {
  const id = lookId(code);
  return id !== null && listOf(avatars).includes(id);
}
/**
 * THE SPRITE TO DRAW for whatever a listing or a message says: the id the code names when it is one of `avatars`, else the FIRST avatar (an old code, junk, nothing, an id the ROM's list
 * does not have). -> a graphics id, or null only when `avatars` is empty.
 */
export function lookFor(code, avatars) {
  const list = listOf(avatars), id = lookId(code);
  if (id !== null && list.includes(id)) return id;
  return list.length ? list[0] : null;
}
/** The stored look of this browser: a look code, or null when there is none, it is an old code or it is junk. Never throws. (Whether its id is an avatar is asked with isLook: the ROM decides.) */
export function loadLook(storage) {
  try { const v = storage ? storage.getItem(LOOK_KEY) : null; return typeof v === 'string' && LOOK_RE.test(v) ? v : null; } catch (_e) { return null; }
}
/** Keep a look for the next visit. -> true when it is stored (false: not a look code, no storage, or a storage that refused). */
export function saveLook(storage, code) {
  try { if (!storage || typeof code !== 'string' || !LOOK_RE.test(code)) return false; storage.setItem(LOOK_KEY, code); return storage.getItem(LOOK_KEY) === code; } catch (_e) { return false; }
}
/** A look for a first visit: one of `avatars`, picked by `n` (any unsigned integer: the caller's random number). -> a code, or null when the list is empty. */
export function pickLook(avatars, n) {
  const list = listOf(avatars);
  if (!list.length) return null;
  return lookCode(list[(Number.isFinite(n) ? Math.abs(Math.floor(n)) : 0) % list.length]);
}

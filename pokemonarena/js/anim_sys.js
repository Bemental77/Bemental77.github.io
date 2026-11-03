// pokemonarena/js/anim_sys.js -- the scene's side of AN2's SYSTEM animations (animator.start('system', id, ctx); ANIM.md "Round 3" and its "AN1 integration guide"): which id plays
// for which scene event, the party records handed to the ROM, and the warm-up that keeps the first intro from stuttering.
//
// Pure ES module (browser + Node). It holds ids, rules and builders only; every picture and every motion comes from the ROM code AN2's engine runs.
//
//   id 0 intro (wild)  1 introTrainer  2 sendOutPlayer  3 recallPlayer  4 faintPlayer  5 faintFoe  6 hitPlayer  7 hitFoe  8 sendOutFoe  9 recallFoe
//
// WHICH INTRO THE ARENA USES: id 1, the trainer intro. The opponent is a CPU TRAINER, and the wild intro (id 0) would say and draw "a wild X appeared" with no trainer. The ROM draws
// the foe trainer's picture from a ROM trainer id (ctx.trainer) and the player's trainer back sprite from the save-block gender (ctx.gender). The arena has no trainer art of its own, so
// the picture is a ROM trainer's, picked by CPU level (trainerChoices / pickTrainer below); the back sprite is the ROM's 'M' one unless the scene is given playerGender. The ROM's own battle
// text of the intro is NOT shown (the scene draws its own messages in the ROM font over the run: draw() with BG0 off, text fed by the run's `message` events), so the trainer's ROM name
// never appears; only its sprite does.

import { decodeText } from './charset.js';

export const SYS = Object.freeze({ intro: 0, introTrainer: 1, sendOutPlayer: 2, recallPlayer: 3, faintPlayer: 4, faintFoe: 5, hitPlayer: 6, hitFoe: 7, sendOutFoe: 8, recallFoe: 9 });
export const LAYERS_NO_TEXT = 0x1e;            // BG1..3 + OBJ: the run's own text boxes (BG0) are left to the scene
export const LAYERS_ALL = 0x1f;
export const PREWARM_STEPS = 60;               // measured: with 60 steps of a throwaway intro run (and a draw each) no step of the next intro costs more than a frame; 0 steps: four steps cost 48-105 ms

// the party record's status word (Gen 3 constants; sleep is a counter, 2 here)
const STATUS_WORD = Object.freeze({ SLP: 2, PSN: 0x08, BRN: 0x10, FRZ: 0x20, PAR: 0x40 });

// a scene display mon ({ species, name, level, gender, hp, maxHp, status, shiny }) -> a makePartyMon spec. expOf(species, level) gives the experience a mon of that level has: WITHOUT it
// (exp 0) a TRAINER battle's setup recomputes the level from the experience and the foe's healthbox shows the wrong level (measured: 66 px of the final intro frame differ at level 50, 12 px
// at level 5; with the experience of its level the final frame is identical to the scene's action menu, 0 of 38400 px). A wild intro does not recompute it.
export function partySpec(m, over, expOf) {
  const o = over || {};
  const maxHp = Math.max(1, m.maxHp | 0), hp = o.hp !== undefined ? o.hp : m.hp;
  return {
    species: m.species, level: m.level, nickname: m.name, hp: Math.max(0, Math.min(maxHp, hp | 0)), maxHp, shiny: !!m.shiny,
    gender: m.gender === 'F' ? 'F' : 'M', status: STATUS_WORD[m.status] || 0,
    ...(typeof expOf === 'function' ? { exp: expOf(m.species, m.level) | 0 } : {}),
  };
}

// the ids an event of the scene maps to (viewSide = the engine side shown at the bottom left)
export function eventId(kind, side, viewSide) {
  const mine = side === viewSide;
  if (kind === 'faint') return mine ? SYS.faintPlayer : SYS.faintFoe;
  if (kind === 'hit') return mine ? SYS.hitPlayer : SYS.hitFoe;
  if (kind === 'sendout') return mine ? SYS.sendOutPlayer : SYS.sendOutFoe;
  if (kind === 'recall') return mine ? SYS.recallPlayer : SYS.recallFoe;
  return -1;
}

// 'exact' | 'approx' play; anything else (fallback, none, a throw) leaves the scene's own code
export function sysPlayable(animator, id) {
  if (!animator || typeof animator.available !== 'function') return false;
  try { const a = animator.available('system', id); return a === 'exact' || a === 'approx'; } catch (_e) { return false; }
}

// The first intro of a page visit is heavy (first execution of the ROM's setup code under the JS engine). Playing a throwaway run for PREWARM_STEPS frames before the battle begins
// moves that cost behind the boot screen. Returns { ms, steps } (steps 0 when the animator has no system animations).
export function prewarmSystem(animator, steps = PREWARM_STEPS) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (!sysPlayable(animator, SYS.introTrainer)) return { ms: 0, steps: 0 };
  let n = 0;
  try {
    const run = animator.start('system', SYS.introTrainer, { foe: { species: 19, level: 5 }, player: { species: 4, level: 5 }, keys: null });
    const img = { width: 240, height: 160, data: new Uint8ClampedArray(240 * 160 * 4) };
    for (; n < steps && !run.done; n++) { run.step(); run.draw(img, { layers: LAYERS_ALL }); }
    if (typeof run.dispose === 'function') run.dispose();
  } catch (_e) { /* a warm-up that fails is just not a warm-up */ }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { ms: t1 - t0, steps: n };
}

// ---- the foe trainer's picture, by CPU level (round 4) ----
// The ROM draws the foe trainer's picture (and the player's back sprite) from a ROM trainer id (ctx.trainer; ANIM.md) and the player's gender (ctx.gender). The arena has no trainer art of its own,
// so the CPU levels are given ROM trainers, found in the ROM's own tables (this hack's gTrainers at 0x497FBC, 52 bytes each: class +28, picture +30, name +31; the class-name table at 0x43b03c,
// 16 bytes each, which is how a class is recognised BY NAME and not by a number written here): EASY = Youngster / Lass / Bug Catcher / School Kid / Camper / Picnicker, NORMAL = Cooltrainer /
// Gym Leader, HARD = Elite Four / Champion. One trainer id per distinct picture (the first id that uses it), so every entry of a list looks different.
const TRAINERS = Object.freeze({ offset: 0x497FBC, stride: 52, count: 1164, classAt: 28, picAt: 30, nameAt: 31 });
const CLASS_NAMES = Object.freeze({ offset: 0x43b03c, stride: 16, count: 83 });
const LEVEL_CLASSES = Object.freeze({
  easy: /^(Youngster|Lass|Bug Catcher|School Kid|Camper|Picnicker)$/, normal: /^(Cooltrainer|Leader)$/, hard: /^(Elite Four|Champion)$/,
});
export function trainerChoices(rom) {
  const out = { easy: [], normal: [], hard: [] };
  try {
    const text = (o, n) => { const b = []; for (let i = 0; i < n && rom[o + i] !== 0xff; i++) b.push(rom[o + i]); return decodeText(Uint8Array.from(b)); };
    if (!rom || rom.length < TRAINERS.offset + TRAINERS.stride * TRAINERS.count) return out;
    const cname = (c) => (c < CLASS_NAMES.count ? text(CLASS_NAMES.offset + c * CLASS_NAMES.stride, 13) : '');
    if (cname(38) !== 'Champion' || cname(37) !== 'Youngster' || cname(31) !== 'Elite Four') return out;          // not the table this was written for: no trainer is picked (the ROM's default stays)
    const seen = { easy: new Set(), normal: new Set(), hard: new Set() };
    for (let id = 1; id < TRAINERS.count; id++) {
      const o = TRAINERS.offset + id * TRAINERS.stride;
      if (!text(o + TRAINERS.nameAt, 12).trim()) continue;
      const cls = cname(rom[o + TRAINERS.classAt]), pic = rom[o + TRAINERS.picAt];
      for (const k of Object.keys(LEVEL_CLASSES)) if (LEVEL_CLASSES[k].test(cls) && !seen[k].has(pic)) { seen[k].add(pic); out[k].push(id); }
    }
  } catch (_e) { /* an unreadable table leaves the lists empty */ }
  return out;
}
// the trainer id for a CPU level and a battle seed; 0 = none known (the engine's own default trainer)
export function pickTrainer(choices, level, seed) {
  const list = choices && choices[level];
  if (!list || !list.length) return 0;
  let h = Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return list[(h >>> 0) % list.length];
}

// tools/pokemonarena_sys_compare.mjs -- verifies the SYSTEM animations (pokemonarena/js/battle_sys.js) against the REAL game, frame by frame.
//
//   node tools/pokemonarena_sys_compare.mjs --dir <oracle state dir> [--foe 19] [--foe-level 2] [--player <species>] [--shots 100,200,300] [--sheet out.png] [--json out.json] [--hour-tod 3]
//
// What it does: (1) the OR1 oracle (pinned mGBA running the real ROM) starts a real wild battle with the given parties (startBattle) and a fixed key script (the oracle's own pressUntil('A'))
// with L held (the hack's native 1x battle speed) and records, per video frame, gSprites (64 x 0x44), the battle main function, the controller functions, the key mask, Random()'s counter and
// -- at --shots frames -- the screen. (2) The same battle is run by SystemRun (the product code) fed the SAME key mask per iteration. (3) The two are compared:
//   * main loop alignment: the real game takes lag frames when one iteration needs more than a frame; an iteration is matched to the real frame whose Random() counter first reaches the
//     engine's count (the sfc32 counter advances by exactly 2 per iteration), so a lag frame never skews the comparison;
//   * every sprite-struct field the picture depends on (OAM attrs, callback, data x/y offsets) per iteration;
//   * the battle main function / controller function timeline (equal = same code path, same wait lengths);
//   * the screen at the shot frames (pixel count that differs).
// The oracle's save has the lead Pokemon following the player in the overworld (the ROM then skips the ball throw) and an outdoor map (the ROM tints the battle background by the time of
// day); the arena has neither, so the recording clears the follower's object event and sets gMapHeader.mapType = 8 (indoors, no background tint). Everything else is the game as it ran.
// Scratch output only (the sheet is never committed). Needs Node 24 and the pinned ROM.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openOracle, KEY as OKEY, FINDINGS, FUNCS } from './pokemonarena_rom_oracle.mjs';
import { contactSheet, writePng } from './pokemonarena_anim_png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPR = 0x0203beb4;

export async function recordReal(o, sc) {
  const frames = [], shots = {}; const oamShots = {}; globalThis.__oamShots = oamShots;
  const shotAt = new Set(sc.shots || []);
  const origSet = o.core.setKeys.bind(o.core), origRun = o.core.runFrame.bind(o.core);
  let rec = false, curKeys = 0;
  o.core.setKeys = (p, k) => { curKeys = k; return origSet(p, k | OKEY.L); };
  o.core.runFrame = () => {
    origRun();
    if (!rec) return;
    if (shotAt.has(frames.length)) { shots[frames.length] = Buffer.from(o.screenshotRGBA()); if (process.env.SHOWPX) oamShots[frames.length] = Buffer.from(o.readBytes(0x07000000, 0x400)); }
    frames.push({
      keys: curKeys, rng: o.readU32(0x03005a74), spr: Buffer.from(o.readBytes(SPR, 64 * 0x44)),
      main: o.readU32(FINDINGS.gBattleMainFunc.addr), ctl: [0, 1].map((i) => o.readU32(FINDINGS.gBattlerControllerFuncs.addr + 4 * i)),
    });
  };
  const wrapSet = o.writeU32.bind(o), wrapSet8 = o.writeU8.bind(o);
  let startRam = null;
  o.writeU32 = (a, v) => {
    if (a === FINDINGS.gMain.addr + 4 && v === FUNCS.cb2.battleInit) {
      rec = true;
      wrapSet8(0x02003840, 8);                                   // gMapHeader.mapType = indoors: no time-of-day tint of the background
      for (let i = 0; i < 16; i++) wrapSet8(0x02003314 + 36 * i, 0);   // no follower object event: the ROM then throws the ball
      startRam = { foe: Buffer.from(o.readBytes(FINDINGS.gEnemyParty.addr, 0x60)), player: Buffer.from(o.readBytes(FINDINGS.gPlayerParty.addr, 0x60)), sb1: Buffer.from(o.readBytes(0x020165cc, 0x3d68)), sb2: Buffer.from(o.readBytes(0x0201a2a0, 0xf2c)), tod: o.readU8(0x03001d4c), trainerStruct: Buffer.from(o.readBytes(0x02002398, 0x40)) };
    }
    return wrapSet(a, v);
  };
  const foe = { species: sc.foe, level: sc.foeLevel || 2, moves: [33], hp: 30, maxHp: 30, ...(sc.foeExtra || {}) };
  const player = sc.player ? { species: sc.player, level: sc.playerLevel || 5, moves: [33], hp: 20, maxHp: 20, ...(sc.playerExtra || {}) } : null;
  await o.startBattle({ foe, player, trainer: !!sc.trainer, reach: sc.reach || 'action' });
  rec = false;
  return { frames, shots, startRam, foeSpec: foe, playerSpec: player };
}

/** Which real frame each engine iteration corresponds to (lag frames of the real game are never chosen). */
export function alignIterations(real, J0 = 100) {
  const OFF = real.findIndex((f) => f.main !== real[0].main);
  if (OFF < 0) throw new Error('the real battle never started');
  for (let q = OFF + 30; q <= OFF + J0; q++) if (real[q].rng - real[q - 1].rng !== 2) throw new Error('a lag frame inside the alignment prefix (frame ' + q + '): raise J0 or start elsewhere');
  const iterFrame = [];
  for (let j = 0; j <= J0; j++) iterFrame.push(OFF + j);
  for (let j = J0 + 1; ; j++) {
    const tgt = real[OFF + J0].rng + 2 * (j - J0);
    let r = -1; for (let q = OFF + J0; q < real.length; q++) if (real[q].rng >= tgt) { r = q; break; }
    if (r < 0) break; iterFrame.push(r);
  }
  return { OFF, iterFrame };
}

import { songInfo as SONG } from '../pokemonarena/js/anim_sound.js';
const S16 = (v) => (v << 16) >> 16;
export function spriteDiff(mem, real, i) {
  const o = SPR + i * 0x44, b = real.spr, r = i * 0x44;
  const inE = mem.ewU8(o + 0x3e) & 1, inR = b[r + 0x3e] & 1;
  if (!inE && !inR) return false;
  return inE !== inR || mem.ewU32(o + 0x1c) !== b.readUInt32LE(r + 0x1c) || mem.ewU16(o) !== b.readUInt16LE(r) || mem.ewU16(o + 2) !== b.readUInt16LE(r + 2) || mem.ewU16(o + 4) !== b.readUInt16LE(r + 4)
    || mem.ewS16(o + 0x20) !== S16(b.readUInt16LE(r + 0x20)) || mem.ewS16(o + 0x22) !== S16(b.readUInt16LE(r + 0x22)) || mem.ewS16(o + 0x24) !== S16(b.readUInt16LE(r + 0x24)) || mem.ewS16(o + 0x26) !== S16(b.readUInt16LE(r + 0x26));
}

export async function compareIntro(rom, rec, sc, { createMoveAnimator, animator: shared }) {
  const { frames, shots, startRam } = rec;
  const OFF = frames.findIndex((f) => f.main !== frames[0].main);
  const realIntro = frames.findIndex((f) => f.main === SYS_INTRO_MAIN);
  if (OFF < 0 || realIntro < 0) throw new Error('the real battle never reached its intro');
  const animator = shared || await createMoveAnimator({ rom });
  // Which real frame each engine iteration corresponds to. Before the intro (battle init: the real game's own lag frames, which the engine does not model) iteration j = real frame OFF + j; from
  // the first intro iteration on, an iteration is matched through the Random() counter (+2 per main-loop iteration in both runs), so lag frames of the real game never skew the comparison.
  const dyn = [];
  const keyFor = (j) => ((j === 0 ? frames[OFF].keys : frames[Math.min(dyn[j - 1] + 1, frames.length - 1)].keys) & 0x3ff);
  const run = animator.start('system', 0, {
    foe: rec.foeSpec, player: rec.playerSpec || undefined, partyBytes: sc.exactBytes ? { foe: startRam.foe, player: startRam.player } : undefined,
    saveBlocks: process.env.REALSB ? { sb1: startRam.sb1, sb2: startRam.sb2 } : undefined,
    battleTypeFlags: sc.trainer ? 8 : 0, trainerStruct: sc.trainer ? startRam.trainerStruct : undefined, trainer: sc.trainer ? true : undefined, trainerParty: process.env.TRAINERPARTY ? true : undefined,
    timeOfDay: startRam.tod, environment: 0, keys: keyFor, seed: 1, maxFrames: frames.length + 80,
  });
  const mem = run.eng.mem;
  const out = { iterations: 0, spriteExact: 0, firstSpriteDiff: -1, timeline: { real: [], engine: [] }, shots: [], sheet: [], doneAt: -1, anchor: null };
  let lastR = '', lastE = '', anchor = null;
  const shotKeys = Object.keys(shots).map(Number);
  const st = (a, b) => a.toString(16) + '/' + b.toString(16);
  for (let j = 0; !run.done; j++) {
    run.step();
    const eng = mem.read32(AD_RNG1_COUNTER);
    if (!anchor && mem.read32(SYS_MAIN_FUNC) === SYS_INTRO_MAIN) anchor = { j, R: realIntro, cReal: frames[realIntro].rng, cEng: eng };
    if (!anchor) dyn[j] = Math.min(OFF + j, frames.length - 1);
    else if (j === anchor.j) dyn[j] = anchor.R;
    else {
      const target = anchor.cReal + (eng - anchor.cEng);
      let r = -1; for (let q = dyn[j - 1]; q < frames.length; q++) if (frames[q].rng >= target) { r = q; break; }
      if (r < 0) break;
      dyn[j] = r;
    }
    if (!anchor) continue;
    const f = frames[dyn[j]];
    const es = st(mem.read32(SYS_MAIN_FUNC), mem.read32(SYS_CTL)), rs = st(f.main, f.ctl[0]);
    if (es !== lastE) { out.timeline.engine.push((j - anchor.j) + ':' + es); lastE = es; if (process.env.SHOWMAP && es.startsWith('808f0dd')) console.log('real rng 426..431', [426, 427, 428, 429, 430, 431].map((q) => frames[q].rng).join(' '), 'real main 427,428', frames[427].main.toString(16), frames[428].main.toString(16), 'engine counter', eng, 'anchor', JSON.stringify(anchor), 'engine reaches', es, 'at j', j, 'maps to real', dyn[j], 'real main there', f.main.toString(16), 'delta', frames[dyn[j]].rng - frames[dyn[j] - 1].rng); }
    if (rs !== lastR) { out.timeline.real.push((j - anchor.j) + ':' + rs); lastR = rs; }
    let nd = 0;
    for (let i = 0; i < 64; i++) if (spriteDiff(mem, f, i)) {
      nd++;
      if (process.env.SHOW && j >= +process.env.SHOW && j < +process.env.SHOW + (+process.env.SHOWN || 2)) {
        const hx = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
        console.log('it', j, 'real frame', dyn[j], 'slot', i, 'inUse E', mem.ewU8(SPR + i * 0x44 + 0x3e) & 1, 'R', f.spr[i * 0x44 + 0x3e] & 1, 'cb E', mem.ewU32(SPR + i * 0x44 + 0x1c).toString(16), 'R', f.spr.readUInt32LE(i * 0x44 + 0x1c).toString(16), 'E', hx(mem.ewram.slice(SPR + i * 0x44 - 0x02000000, SPR + i * 0x44 - 0x02000000 + 0x44)));
        console.log('                         R', hx(f.spr.slice(i * 0x44, i * 0x44 + 0x44)));
      }
    }
    out.iterations++; if (!nd) out.spriteExact++; else if (out.firstSpriteDiff < 0) out.firstSpriteDiff = j - anchor.j;
    for (const r of shotKeys) if (dyn[j] === r - 1) {
      const img = Uint8Array.from(run.draw(null));
      const want = shots[r]; let d = 0;
      for (let p = 0; p < 240 * 160; p++) if (img[p * 4] !== want[p * 4] || img[p * 4 + 1] !== want[p * 4 + 1] || img[p * 4 + 2] !== want[p * 4 + 2]) d++;
      out.shots.push({ realFrame: r, iteration: j, differingPixels: d });
      if (process.env.SHOWPX && d) { let n = 0; const hx = (a, p) => [a[p * 4], a[p * 4 + 1], a[p * 4 + 2]].join(','); const pts = []; for (let p = 0; p < 240 * 160 && n < 12; p++) if (img[p * 4] !== want[p * 4] || img[p * 4 + 1] !== want[p * 4 + 1] || img[p * 4 + 2] !== want[p * 4 + 2]) { pts.push('(' + (p % 240) + ',' + ((p / 240) | 0) + ') eng ' + hx(img, p) + ' real ' + hx(want, p)); n++; } console.log('shot', r, 'diff px:', pts.join(' | '));
        const ro = globalThis.__oamShots[r], eo = Buffer.from(mem.oam); const hx2 = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); for (let i = 0; i < 128; i++) { const a = ro.subarray(i * 8, i * 8 + 6), b2 = eo.subarray(i * 8, i * 8 + 6); if (!a.equals(b2)) console.log('  oam', i, 'real', hx2(a), 'eng', hx2(b2)); } for (let k = 0; k < 32; k++) { const a = ro.subarray(k * 32 + 6, k * 32 + 8), b2 = eo.subarray(k * 32 + 6, k * 32 + 8); const a2 = ro.subarray(k * 32 + 14, k * 32 + 16), b3 = eo.subarray(k * 32 + 14, k * 32 + 16); if (!a.equals(b2) || !a2.equals(b3)) console.log('  matrix', k, 'real pa/pb', hx2(a), hx2(a2), 'eng', hx2(b2), hx2(b3)); } }
      out.sheet.push({ rgba: img, label: 'ENG r' + r }, { rgba: Uint8Array.from(want), label: 'REAL r' + r });
    }
  }
  if (process.env.EXTRA) { // the game goes on: a few more iterations past the action menu (the engine's run stops at the menu), compared the same way
    for (let e = 1; e <= Number(process.env.EXTRA); e++) { run.iterate(0); const j = dyn.length; const eng2 = mem.read32(AD_RNG1_COUNTER); const target = anchor.cReal + (eng2 - anchor.cEng); let r = -1; for (let q = dyn[j - 1]; q < frames.length; q++) if (frames[q].rng >= target) { r = q; break; } if (r < 0) break; dyn[j] = r; let nd = 0; const sl = []; for (let i = 0; i < 64; i++) if (spriteDiff(mem, frames[r], i)) { nd++; sl.push(i); } console.log('extra iteration +' + e, 'real frame', r, 'sprite diffs', nd, sl.join(',')); } }
  out.anchor = anchor ? { engineIteration: anchor.j, realFrame: anchor.R } : null;
  out.doneAt = run.frame; out.ready = run.ready; out.error = run.error ? String(run.error) : null;
  out.events = { messages: run.messages.length };
  return out;
}
const SYS_MAIN_FUNC = 0x03002e64, SYS_CTL = 0x03002e44, SYS_INTRO_MAIN = 0x0808b9d1, AD_RNG1_COUNTER = 0x03005a74;

/* ------------------------------------------------------------------------------------------------------------------ system EVENTS
 * The same comparison for an event after the intro (faint, hit, recall, send-out). The real game plays the intro with the key script below, and at the first iteration of the action selection
 * the oracle INJECTS the command the engine injects (it writes the same bytes the battle script's BtlController_Emit* would: the command id into gBattleResources->bufferA[battler], the battler's
 * bit into gBattleControllerExecFlags, the battle main function parked on an empty function). From there both run on their own and are compared. */
export const EVENT_PLANS = {
  2: { name: 'sendOutPlayer', pre: [{ battler: 0, cmd: [6, 1] }], main: [{ battler: 0, cmd: [5, 1, 0], party1: true }] },
  3: { name: 'recallPlayer', main: [{ battler: 0, cmd: [6, 0] }] },
  4: { name: 'faintPlayer', main: [{ battler: 0, cmd: [10] }] },
  5: { name: 'faintFoe', main: [{ battler: 1, cmd: [10] }] },
  6: { name: 'hitPlayer', main: [{ battler: 0, cmd: [36] }] },
  7: { name: 'hitFoe', main: [{ battler: 1, cmd: [36] }] },
  8: { name: 'sendOutFoe', trainer: true, pre: [{ battler: 1, cmd: [6, 1] }], main: [{ battler: 1, cmd: [5, 1, 0], foeParty1: true }] },
  9: { name: 'recallFoe', trainer: true, main: [{ battler: 1, cmd: [6, 0] }] },
};
const A_SCHEDULE = (i) => (i >= 64 && ((i - 64) % 60) < 5 ? 1 : 0);
const GBATTLEMONS = 0x02001ecc;
const ACTION_SELECT = 0x0808f0dd, PAUSE_MAIN = 0x08068a75, RES_PTR = 0x02001c6c, EXEC_FLAGS = 0x02001d38;

export async function recordRealEvent(o, sc, planId) {
  const plan = planId === 'none' ? { main: [], trainer: !!sc.trainer } : EVENT_PLANS[planId];
  const frames = [], shots = {};
  const wantShots = new Set();
  const origSet = o.core.setKeys.bind(o.core), origRun = o.core.runFrame.bind(o.core);
  let rec = false, curKeys = 0, injectedAt = -1;
  o.core.setKeys = (p, k) => { curKeys = k; return origSet(p, k | OKEY.L); };
  o.core.runFrame = () => {
    origRun();
    if (!rec) return;
    if (wantShots.has(frames.length)) shots[frames.length] = Buffer.from(o.screenshotRGBA());
    frames.push({
      keys: curKeys, rng: o.readU32(0x03005a74), spr: Buffer.from(o.readBytes(SPR, 64 * 0x44)),
      main: o.readU32(FINDINGS.gBattleMainFunc.addr), ctl: [0, 1].map((i) => o.readU32(FINDINGS.gBattlerControllerFuncs.addr + 4 * i)),
    });
  };
  const wrapSet = o.writeU32.bind(o), wrapSet8 = o.writeU8.bind(o);
  let startRam = null;
  o.writeU32 = (a, v) => {
    if (a === FINDINGS.gMain.addr + 4 && v === FUNCS.cb2.battleInit) {
      rec = true;
      wrapSet8(0x02003840, 8);
      for (let i = 0; i < 16; i++) wrapSet8(0x02003314 + 36 * i, 0);
      startRam = { foe: Buffer.from(o.readBytes(FINDINGS.gEnemyParty.addr, 0x60)), player: Buffer.from(o.readBytes(FINDINGS.gPlayerParty.addr, 0x60)), sb1: Buffer.from(o.readBytes(0x020165cc, 0x3d68)), sb2: Buffer.from(o.readBytes(0x0201a2a0, 0xf2c)), tod: o.readU8(0x03001d4c), trainerStruct: Buffer.from(o.readBytes(0x02002398, 0x40)) };
    }
    return wrapSet(a, v);
  };
  const foe = { species: sc.foe, level: sc.foeLevel || 2, moves: [33], hp: 30, maxHp: 30, ...(sc.foeExtra || {}) };
  const player = sc.player ? { species: sc.player, level: sc.playerLevel || 5, moves: [33], hp: 20, maxHp: 20, ...(sc.playerExtra || {}) } : null;
  await o.startBattle({ foe, player, trainer: !!plan.trainer, reach: 'intro' });
  const step1 = () => { o.core.setKeys(0, A_SCHEDULE(frames.length) ? OKEY.A : 0); o.core.runFrame(); };
  let guard = 0;
  while (o.readU32(FINDINGS.gBattleMainFunc.addr) !== ACTION_SELECT && guard++ < 1500) step1();
  if (guard >= 1500) throw new Error('the real battle never reached its action selection');
  // an iteration that spans two video frames (a lag frame) has set the main function in its first frame: wait until the iteration has ended (the Random() counter advanced in the last frame)
  guard = 0; while (frames[frames.length - 1].rng === frames[frames.length - 2].rng && guard++ < 10) step1();
  const issue = (list) => {
    const res = o.readU32(RES_PTR);
    wrapSet(FINDINGS.gBattleMainFunc.addr, PAUSE_MAIN);
    for (const { battler, cmd } of list) { for (let i = 0; i < cmd.length; i++) wrapSet8(res + 16 + battler * 0x200 + i, cmd[i]); wrapSet(EXEC_FLAGS, (o.readU32(EXEC_FLAGS) | (1 << battler)) >>> 0); }
  };
  const quiet = (n) => { let last = '', still = 0, guard2 = 0; while (still < n && guard2++ < 700) { step0(); const h = frames[frames.length - 1].spr.toString('base64') + o.readU32(EXEC_FLAGS); still = h === last ? still + 1 : 0; last = h; } };
  const step0 = () => { o.core.setKeys(0, 0); o.core.runFrame(); };
  const injectFrame = frames.length - 1;             // the last recorded frame is the state the injection starts from
  if (plan.pre) { issue(plan.pre); quiet(8); }
  for (const c of plan.main) if (c.foeParty1) {
    const spec = { species: sc.switchIn || (sc.foe === 1 ? 4 : 1), level: 5, moves: [33], hp: 20, maxHp: 20 };
    const bytes = await o.monBytes(spec); o.writeBytes(FINDINGS.gEnemyParty.addr + 0x60, bytes); startRam.switchIn = Buffer.from(bytes); sc.switchSpec = spec;
    o.writeU16(GBATTLEMONS + 152 * c.battler, spec.species);       // what the battle script's switchindataupdate does before switchinanim (Round 5; see tools/pokemonarena_sys_natural.mjs)
  }
  for (const c of plan.main) if (c.party1) {
    const spec = { species: sc.switchIn || (sc.player === 1 ? 4 : 1), level: 5, moves: [33], hp: 20, maxHp: 20 };
    const bytes = await o.monBytes(spec); o.writeBytes(FINDINGS.gPlayerParty.addr + 0x60, bytes); startRam.switchIn = Buffer.from(bytes); sc.switchSpec = spec;
    o.writeU16(GBATTLEMONS + 152 * c.battler, spec.species);
  }
  injectedAt = frames.length - 1;
  if (planId === 'none') { for (let k = 0; k < 60; k++) step1(); rec = false; return { frames, shots, startRam, foeSpec: foe, playerSpec: player, injectedAt, injectFrame, switchSpec: sc.switchSpec }; }
  issue(plan.main);
  for (const r of sc.shotsRel || []) wantShots.add(injectedAt + 1 + r);
  for (let k = 0; k < (sc.eventFrames || 360); k++) step0();
  rec = false;
  return { frames, shots, startRam, foeSpec: foe, playerSpec: player, injectedAt, injectFrame, switchSpec: sc.switchSpec };
}

/** Maps engine iterations to real frames (see compareIntro): before the intro iteration j = real frame OFF + j; from the first intro iteration on, by the Random() counter. */
class IterMapper {
  constructor(frames) {
    this.frames = frames; this.OFF = frames.findIndex((f) => f.main !== frames[0].main); this.realIntro = frames.findIndex((f) => f.main === SYS_INTRO_MAIN);
    this.dyn = []; this.anchor = null;
  }
  after(j, mem) {
    const { frames } = this, c = mem.read32(AD_RNG1_COUNTER);
    if (!this.anchor && mem.read32(SYS_MAIN_FUNC) === SYS_INTRO_MAIN) this.anchor = { j, R: this.realIntro, cReal: frames[this.realIntro].rng, cEng: c };
    if (!this.anchor) { this.dyn[j] = Math.min(this.OFF + j, frames.length - 1); return this.dyn[j]; }
    if (j === this.anchor.j) { this.dyn[j] = this.anchor.R; return this.dyn[j]; }
    const target = this.anchor.cReal + (c - this.anchor.cEng);
    let r = -1; for (let q = this.dyn[j - 1]; q < frames.length; q++) if (frames[q].rng >= target) { r = q; break; }
    this.dyn[j] = r; return r;
  }
  /** Re-anchor at a point both runs identify by an EVENT (the injection), not by counting: engine iteration j is real frame R from here on. */
  reanchor(j, R, mem) { this.anchor = { j, R, cReal: this.frames[R].rng, cEng: mem.read32(AD_RNG1_COUNTER) }; this.dyn[j] = R; }
  keys(j) { return ((j === 0 ? this.frames[this.OFF].keys : this.frames[Math.min(this.dyn[j - 1] + 1, this.frames.length - 1)].keys) & 0x3ff); }
}

export async function compareEvent(rom, rec, sc, planId, { animator }) {
  const { frames, shots, startRam, injectedAt } = rec;
  const mapper = new IterMapper(frames);
  const run = animator.start('system', planId, {
    foe: rec.foeSpec, player: rec.playerSpec || undefined,
    partyBytes: { foe: startRam.foe, player: startRam.player, switchIn: startRam.switchIn },
    isSEPlaying: process.env.SELAT ? ((idx, el) => { const s = SONG(rom, idx); return (s.player === 1 || s.player === 2) && el < Math.min(s.frames + 1 + Number(process.env.SELAT), 600); }) : undefined,
    switchIn: rec.switchSpec, trainerStruct: EVENT_PLANS[planId].trainer ? startRam.trainerStruct : undefined, timeOfDay: startRam.tod, environment: 0, seed: 1, maxFrames: 2000,
    keys: (j, r) => { if (j > 0) mapper.after(j - 1, r.eng.mem); return mapper.keys(j); },
  });
  const mem = run.eng.mem;
  const out = { iterations: 0, spriteExact: 0, firstSpriteDiff: -1, shots: [], sheet: [], settled: run.settledAt, events: [], injectionMatch: null, doneAt: -1 };
  // the engine's last hidden iteration is the real state at the injection: check that the mapping agrees
  const lastHidden = run.iterTotal - 1;
  const rHidden = mapper.after(lastHidden, mem);
  // the real game and the engine both stop at the first iteration of the action selection: the injection state must be identical. Compare it, then count from there.
  let nd0 = 0; for (let i = 0; i < 64; i++) if (spriteDiff(mem, frames[injectedAt], i)) nd0++;
  out.injectionMatch = { engineMapsTo: rHidden, realInjectedAt: injectedAt, spriteDiffsAtInjection: nd0 };
  mapper.reanchor(lastHidden, injectedAt, mem);
  if (process.env.SHOWINJ) { for (let q = injectedAt - 3; q <= injectedAt + 2; q++) console.log('real frame', q, 'main', frames[q].main.toString(16), 'ctl', frames[q].ctl.map((x) => x.toString(16)).join(','), 'rng delta', frames[q].rng - frames[q - 1].rng); console.log('engine last hidden iteration', lastHidden, 'maps to', rHidden, 'engine main', mem.read32(SYS_MAIN_FUNC).toString(16), 'anchor', JSON.stringify(mapper.anchor)); }
  const shotKeys = Object.keys(shots).map(Number);
  let j = lastHidden;
  while (!run.done) {
    run.step(); j++;
    const r = mapper.after(j, mem);
    if (process.env.SHOWMAP) console.log('map it', out.iterations, 'j', j, 'real', r, 'real rng delta', r > 0 ? frames[r].rng - frames[r - 1].rng : '-', 'eng counter', mem.read32(AD_RNG1_COUNTER));
    if (r < 0 || r >= frames.length) break;
    const f = frames[r];
    let nd = 0;
    for (let i = 0; i < 64; i++) if (spriteDiff(mem, f, i)) {
      nd++;
      if (process.env.SHOW && out.iterations >= +process.env.SHOW && out.iterations < +process.env.SHOW + (+process.env.SHOWN || 2)) console.log('ev it', out.iterations, 'real frame', r, 'slot', i, 'inUse E', mem.ewU8(SPR + i * 0x44 + 0x3e) & 1, 'R', f.spr[i * 0x44 + 0x3e] & 1, 'cb E', mem.ewU32(SPR + i * 0x44 + 0x1c).toString(16), 'R', f.spr.readUInt32LE(i * 0x44 + 0x1c).toString(16));
      if (process.env.SHOWHEX) { const hx = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); console.log('    E', hx(mem.ewram.slice(SPR + i * 0x44 - 0x02000000, SPR + i * 0x44 - 0x02000000 + 0x44))); console.log('    R', hx(f.spr.slice(i * 0x44, i * 0x44 + 0x44))); }
    }
    out.iterations++; if (!nd) out.spriteExact++; else if (out.firstSpriteDiff < 0) out.firstSpriteDiff = out.iterations - 1;
    for (const s of shotKeys) if (r === s - 1) {
      const img = Uint8Array.from(run.draw(null)); const want = shots[s]; let d = 0;
      for (let p = 0; p < 240 * 160; p++) if (img[p * 4] !== want[p * 4] || img[p * 4 + 1] !== want[p * 4 + 1] || img[p * 4 + 2] !== want[p * 4 + 2]) d++;
      out.shots.push({ realFrame: s, iteration: out.iterations, differingPixels: d });
      if (process.env.SHOWPX && d) { const pts = []; for (let p = 0; p < 240 * 160 && pts.length < 10; p++) if (img[p * 4] !== want[p * 4] || img[p * 4 + 1] !== want[p * 4 + 1] || img[p * 4 + 2] !== want[p * 4 + 2]) pts.push('(' + (p % 240) + ',' + ((p / 240) | 0) + ') e' + [img[p * 4], img[p * 4 + 1], img[p * 4 + 2]].join(',') + ' r' + [want[p * 4], want[p * 4 + 1], want[p * 4 + 2]].join(',')); console.log('event shot', s, d, 'px:', pts.join(' | ')); }
      out.sheet.push({ rgba: img, label: 'ENG +' + (s - injectedAt - 1) }, { rgba: Uint8Array.from(want), label: 'REAL +' + (s - injectedAt - 1) });
    }
  }
  out.doneAt = run.frame; out.error = run.error ? String(run.error) : null; out.truncated = run.truncated;
  return out;
}


/** Species whose animation ids cover every front id (0..153) and back id (0..25) of the ROM: one species per id (the lowest species number that has graphics). */
export async function coverageSpecies(rom) {
  const am = await import(pathToFileURL(path.join(ROOT, 'pokemonarena/js/anim_mon.js')).href);
  const front = new Map(), back = new Map();
  for (let id = 1; id <= 1577; id++) {
    let info = null; try { info = am.speciesAnimInfo(rom, id); } catch (e) { info = null; }
    if (!info) continue;
    if (!front.has(info.frontAnimId)) front.set(info.frontAnimId, id);
    if (!back.has(info.backAnimId)) back.set(info.backAnimId, id);
  }
  return { front: [...front].sort((a, b) => a[0] - b[0]), back: [...back].sort((a, b) => a[0] - b[0]) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2), opt = {};
  for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, '')] = args[i + 1];
  const rom = new Uint8Array(fs.readFileSync(process.env.POKEMONARENA_ROM || 'gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba'));
  const o = await openOracle({ stateDir: opt.dir });
  if (opt.batch === 'coverage') {
    const cov = await coverageSpecies(rom);
    const { createMoveAnimator } = await import(pathToFileURL(path.join(ROOT, 'pokemonarena/js/move_anim.js')).href);
    const rows = [];
    const animator = await createMoveAnimator({ rom });
    const n = Math.max(cov.front.length, cov.back.length);
    for (let k = 0; k < n; k++) {
      const [fid, fsp] = cov.front[k % cov.front.length], [bid, bsp] = cov.back[k % cov.back.length];
      const sc = { foe: fsp, foeLevel: 2, player: bsp, playerLevel: 5, shots: [110, 200, 280], exactBytes: true };
      const row = { frontAnimId: fid, foe: fsp, backAnimId: bid, player: bsp };
      try { const rec = await recordReal(o, sc); const res = await compareIntro(rom, rec, sc, { createMoveAnimator, animator }); Object.assign(row, { iterations: res.iterations, spriteExact: res.spriteExact, firstSpriteDiff: res.firstSpriteDiff, ready: res.ready, error: res.error, timelineEqual: res.timeline.real.join(' ') === res.timeline.engine.join(' '), shotsDiff: res.shots.map((s) => s.differingPixels) }); } catch (e) { row.error = String(e && e.message || e); }
      rows.push(row); console.log(JSON.stringify(row));
    }
    if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(rows, null, 1));
    // the iteration in which the action menu opens (the last one) is excluded from the sprite count: the real game creates the menu's two sprites one iteration earlier (ANIM.md)
    const same = (r) => r.spriteExact === r.iterations || (r.spriteExact === r.iterations - 1 && r.firstSpriteDiff === r.iterations - 1);
    const ok = rows.filter((r) => !r.error && same(r) && r.timelineEqual && r.shotsDiff.every((d) => d === 0)).length;
    console.log('coverage: ' + ok + ' of ' + rows.length + ' scenarios exact (sprites in every iteration but the menu-opening one + timeline + screenshots)');
    process.exit(0);
  }
  if (opt.event === 'none') {
    const sc = { foe: Number(opt.foe || 19), foeLevel: 4, trainer: opt.trainer === '1', foeExtra: opt['foe-extra'] ? JSON.parse(opt['foe-extra']) : undefined, playerExtra: opt['player-extra'] ? JSON.parse(opt['player-extra']) : undefined, player: opt.player ? Number(opt.player) : null, shots: [], exactBytes: true };
    const rec = await recordRealEvent(o, { ...sc, shotsRel: [] }, 'none');
    const res = await compareIntro(rom, rec, sc, { createMoveAnimator: (await import(pathToFileURL(path.join(ROOT, 'pokemonarena/js/move_anim.js')).href)).createMoveAnimator });
    console.log(JSON.stringify({ iterations: res.iterations, spriteExact: res.spriteExact, firstSpriteDiff: res.firstSpriteDiff, ready: res.ready }));
    console.log('real  :', res.timeline.real.join(' '));
    console.log('engine:', res.timeline.engine.join(' '));
    process.exit(0);
  }
  if (opt.event !== undefined || opt.batch === 'events') {
    const { createMoveAnimator } = await import(pathToFileURL(path.join(ROOT, 'pokemonarena/js/move_anim.js')).href);
    const animator = await createMoveAnimator({ rom });
    const ids = opt.batch === 'events' ? Object.keys(EVENT_PLANS).map(Number) : [Number(opt.event)];
    const pairs = opt.batch === 'events' ? [[19, 4], [25, 1289], [132, 9], [6, 150]] : [[Number(opt.foe || 19), Number(opt.player || 4)]];
    const switchIn = opt.switch === undefined ? undefined : Number(opt.switch);   // --switch N: the incoming Pokemon's species (default: Bulbasaur / Charmander)
    const rows = [];
    // a trainer battle: the real game rebuilds the foe party from the (stale) trainer data in the pinned save: Crystal's Marill Lv4 (species 183)
    for (const id of ids) for (const [foe0, player] of pairs) {
      const trainerPlan = !!EVENT_PLANS[id].trainer, foe = trainerPlan ? 183 : foe0;
      const sc = { foe, foeLevel: trainerPlan ? 4 : 3, player, playerLevel: 5, switchIn, shotsRel: [2, 6, 12, 24, 48], eventFrames: Number(opt.frames || 330) };
      const row = { event: EVENT_PLANS[id].name, foe, player };
      try {
        const rec = await recordRealEvent(o, sc, id);
        const res = await compareEvent(rom, rec, sc, id, { animator });
        Object.assign(row, { iterations: res.iterations, spriteExact: res.spriteExact, firstSpriteDiff: res.firstSpriteDiff, injection: res.injectionMatch.spriteDiffsAtInjection === 0, injectionDetail: res.injectionMatch, shotsDiff: res.shots.map((s) => s.differingPixels), doneAt: res.doneAt, error: res.error, truncated: res.truncated });
        if (opt.sheet) { const sh = contactSheet(res.sheet, { cols: 4, scale: 1 }); writePng(opt.sheet.replace('.png', '_' + row.event + '_' + foe + '_' + player + '.png'), sh.width, sh.height, sh.rgba); }
      } catch (e) { row.error = String(e && e.stack || e).slice(0, 400); }
      rows.push(row); console.log(JSON.stringify(row));
    }
    if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(rows, null, 1));
    const ok = rows.filter((r) => !r.error && r.spriteExact === r.iterations && r.injection && r.shotsDiff.every((d) => d === 0)).length;
    console.log('events: ' + ok + ' of ' + rows.length + ' scenarios exact');
    process.exit(0);
  }
  const sc = { foe: Number(opt.foe || 19), foeLevel: Number(opt['foe-level'] || 2), trainer: opt.trainer === '1', player: opt.player ? Number(opt.player) : null, shots: (opt.shots || '100,200,300,350').split(',').map(Number), exactBytes: opt.exact === '1' };
  const rec = await recordReal(o, sc);
  if (process.env.SHOWRNG) console.log('rng deltas', rec.frames.slice(0, 60).map((f, k) => (k ? f.rng - rec.frames[k - 1].rng : 0)).join(' '));
  const { createMoveAnimator } = await import(pathToFileURL(path.join(ROOT, 'pokemonarena/js/move_anim.js')).href);
  const res = await compareIntro(rom, rec, sc, { createMoveAnimator });
  console.log(JSON.stringify({ scenario: sc, iterations: res.iterations, spriteExactIterations: res.spriteExact, firstSpriteDiff: res.firstSpriteDiff, shots: res.shots, ready: res.ready, doneAt: res.doneAt, error: res.error, messages: res.events.messages }));
  console.log('real  :', res.timeline.real.join(' '));
  console.log('engine:', res.timeline.engine.join(' '));
  if (opt.sheet) { const sh = contactSheet(res.sheet, { cols: 4, scale: 1 }); writePng(opt.sheet, sh.width, sh.height, sh.rgba); }
}

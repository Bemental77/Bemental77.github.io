// tools/pokemonarena_anim_field_compare.mjs -- the WHOLE FIELD of a move animation against the REAL game, pixel by pixel (pokemonarena/ANIM.md "Round 6").
//
//   node tools/pokemonarena_anim_field_compare.mjs [--moves "Thunderbolt,Hyper Beam,..."] [--foe N --atk N] [--dir <oracle state dir>] [--png <dir>] [--json <file>]
//   node tools/pokemonarena_anim_field_compare.mjs --calibrate [--dir <oracle state dir>]
//
// Why this exists. pokemonarena_anim_oracle_compare.mjs compares the engine's SPRITE state (gSprites structs) and the I/O registers with the real game's; it never looked at what the PPU
// draws, and the terrain is not in the engine at all (the scene supplies it as a picture). So the ROM's palette blends of the terrain (AnimTask_BlendBattleAnimPal with F_PAL_BG: Thunderbolt,
// Hyper Beam, Fire Blast, Rain Dance, Thunder Wave, Hail, Sunny Day ...), the way the pinned mGBA rounds its colour effects, a per-line BLDALPHA (Surf) and the BG3 shake (Earthquake) went
// unseen for five rounds. This tool plays the move in the real game (the OR1 oracle, L held = native 1x), plays it in the engine over the scene's terrain (battle_ui.js, the very picture the
// scene composites on), and compares the FIELD (everything but the two healthboxes and the text window) frame by frame, plus the luminance of a background-only patch.
//   * alignment: the engine's frame 0 is searched among real frames 60..130 (the animation starts about 80 frames after the first key press) by the smallest total difference;
//   * Random(): the engine's two PRNG states are seeded from the real game's at that frame (a move that scatters sprites with Random2 is otherwise unmatchable), the best of the three
//     frames around the alignment is kept;
//   * the numbers: mean differing field pixels per frame (of 18,496), frames with 0 differing pixels, the same with each engine frame matched against real frames within +-14 (a LAG frame of
//     the real game -- one main-loop iteration that needs more than a video frame, which the engine cannot model -- shifts everything after it by one frame), and the luminance series of
//     the patch x 110..139, y 4..29 (the terrain: sky and water, no sprites) in 15 samples.
// --calibrate measures the oracle's colour-effect arithmetic: BLDCNT effect 2 / 3 at EVY 1..16 and effect 1 at several EVA / EVB, against the formulas anim_ppu.js implements.
// Scratch output only (PNG sheets); needs Node 24, the pinned ROM and the pinned mGBA. Browser-free.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openOracle, KEY as OKEY } from './pokemonarena_rom_oracle.mjs';
import { createMoveAnimator } from '../pokemonarena/js/move_anim.js';
import { createBattleUi } from '../pokemonarena/js/battle_ui.js';
import { loadPack } from '../pokemonarena/js/tables.js';
import { contactSheet, writePng } from './pokemonarena_anim_png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENV = 4, ATK = 6, FOE = 143, W = 240;
// healthboxes + the text window: not animation (the real game hides the boxes during a move animation and the scene draws them itself)
const BOX = [[0, 14, 104, 36], [124, 72, 116, 48], [0, 112, 240, 48]];
const inBox = (x, y) => BOX.some(([bx, by, bw, bh]) => x >= bx && y >= by && x < bx + bw && y < by + bh);
export const FIELD_PX = (() => { let n = 0; for (let y = 0; y < 112; y++) for (let x = 0; x < W; x++) if (!inBox(x, y)) n++; return n; })();

export const fieldDiff = (a, b) => { let n = 0; for (let y = 0; y < 112; y++) for (let x = 0; x < W; x++) { if (inBox(x, y)) continue; const i = (y * W + x) * 4; if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++; } return n; };
/** Mean luminance of the background-only patch (sky and water above the foe's healthbox row: x 110..139, y 4..29). */
export const patchLuminance = (f) => { let t = 0, n = 0; for (let y = 4; y < 30; y++) for (let x = 110; x < 140; x++) { const i = (y * W + x) * 4; t += f[i] * 0.3 + f[i + 1] * 0.59 + f[i + 2] * 0.11; n++; } return Math.round(t / n); };

/** The oracle as the comparison needs it: the cartridge clock pinned to 2023-11-14 12:00 UTC (a daytime battle: the arena's terrain is the day picture; at night the real game tints the terrain). */
export const openFieldOracle = (dir) => openOracle({ stateDir: dir || path.join(os.tmpdir(), 'pokemonarena-fa1-states'), rtc: { fixedEpochMs: 1699963200000, tzOffsetMin: 0 } });

export function loadRom() {
  const b = fs.readFileSync(process.env.POKEMONARENA_ROM || path.join(ROOT, 'gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba'));
  return new Uint8Array(b.buffer, b.byteOffset, b.length);
}

/** The engine's frames of a move over the scene's own terrain (env), as the scene composites it: field pixels only matter, the boxes / text are masked by the comparison. */
export function engineFrames(an, ui, moveId, { atk = ATK, foe = FOE, env = ENV, rng1, rng2, maxFrames = 700, self = false } = {}) {
  // a move that targets its user (Mist, Protect, Reflect ...) is launched the way the scene launches it: attacker = target = the user's side, the other Pokemon a bystander (scene.js, selfRun)
  const run = an.start('move', moveId, self ? { attacker: { side: 0, species: atk }, target: { side: 0, species: atk }, bystander: { species: foe }, rng1, rng2 } : { attacker: { side: 0, species: atk }, target: { side: 1, species: foe }, rng1, rng2 });
  const view = Object.create(null); Object.assign(view, { env, foe: undefined, player: undefined, box: { mode: 'message', text: ['', ''] }, tags: [], overlay: null });
  Object.defineProperty(view, 'fxDraw', { value: (f) => run.draw(f), enumerable: false });
  const frames = [];
  while (!run.done && frames.length < maxFrames) { run.step(); frames.push(Uint8Array.from(ui.render(view).rgba)); }
  if (run.done && frames.length > 1) frames.pop();      // the frame on which the run reports `done` is the scene's first frame of rest, not an animation frame
  return { frames, run };
}

/** The real game playing the move: FIGHT, the first move, then `n` frames. Every frame's picture and the two PRNG states (Random() at 0x03005a68, Random2() at 0x03005a58). */
export async function realFrames(o, pack, moveId, { atk = ATK, foe = FOE, env = ENV, n = 460 } = {}) {
  const mid = (nm) => pack.moves.findIndex((m) => m && m.name === nm);
  const harden = mid('Harden');
  await o.startBattle({ terrain: env, foe: { species: foe, level: 50, moves: [harden, 0, 0, 0], hp: 400, maxHp: 400, nickname: 'Snorlax', stats: { atk: 100, def: 100, spe: 1, spa: 100, spd: 100 }, gender: 'M' },
    player: { species: atk, level: 50, moves: [moveId, 0, 0, 0], hp: 300, maxHp: 300, nickname: 'Charizard', stats: { atk: 100, def: 100, spe: 100, spa: 100, spd: 100 }, gender: 'M' }, reach: 'action' });
  const frames = [], rng = [];
  const step = (keys) => { o.core.setKeys(0, keys | OKEY.L); o.core.runFrame(); frames.push(Uint8Array.from(o.screenshotRGBA())); const b1 = o.readBytes(0x03005a68, 16), b2 = o.readBytes(0x03005a58, 16); rng.push({ r1: [0, 1, 2, 3].map((i) => b1.readUInt32LE(4 * i)), r2: [0, 1, 2, 3].map((i) => b2.readUInt32LE(4 * i)) }); };
  for (let i = 0; i < 8; i++) step(0);
  for (let i = 0; i < 6; i++) step(OKEY.A);
  for (let i = 0; i < 20; i++) step(0);
  for (let i = 0; i < 6; i++) step(OKEY.A);
  for (let i = 0; i < n; i++) step(0);
  return { frames, rng };
}

/** Slide the engine's animation over the real recording: the start offset with the smallest total field difference. */
function bestOffset(R, A, { min = 60, max = 130 } = {}) {
  let best = { d: -1, score: Infinity, per: null };
  for (let d = min; d <= max && d + A.length <= R.length; d++) {
    let s = 0; const per = [];
    for (let k = 0; k < A.length; k++) { const v = fieldDiff(R[d + k], A[k]); s += v; per.push(v); if (s >= best.score) break; }
    if (per.length === A.length && s < best.score) best = { d, score: s, per };
  }
  return best;
}

/** One move, both sides, all the numbers. opts.an / ui are reused across moves. */
export async function compareMove({ o, an, ui, pack, moveId, name = '', search = {}, keep = false, atk = ATK, foe = FOE, self = SELF_TARGET.has(name) }) {
  const real = await realFrames(o, pack, moveId, { atk, foe });
  const R = real.frames;
  // pass 1 without the real PRNG states: finds the start; pass 2 seeds them from the real game around it (a move that draws Random2 is unmatchable otherwise)
  let A = engineFrames(an, ui, moveId, { atk, foe, self }).frames, best = bestOffset(R, A, search);
  const seeded = [];
  for (const dd of [-2, -1, 0]) {
    const at = real.rng[Math.max(0, best.d + dd - 1)];
    const E = engineFrames(an, ui, moveId, { atk, foe, self, rng1: at.r1, rng2: at.r2 });
    const b = bestOffset(R, E.frames, { min: Math.max(0, best.d - 3), max: best.d + 3 });
    if (b.d >= 0) seeded.push({ A: E.frames, best: b });
  }
  for (const s of seeded) if (s.best.score < best.score) { best = s.best; A = s.A; }
  const aLen = A.length, d = best.d, per = best.per;
  const zero = per.filter((v) => v === 0).length, mean = best.score / aLen;
  // within +-14 real frames: a lag frame of the real game shifts everything after it
  let tolSum = 0, tolZero = 0;
  for (let k = 0; k < aLen; k++) { let m = Infinity; for (let j = Math.max(0, d + k - 14); j <= Math.min(R.length - 1, d + k + 14); j++) { const v = fieldDiff(R[j], A[k]); if (v < m) m = v; if (m === 0) break; } tolSum += m; if (m === 0) tolZero++; }
  const step = Math.max(1, Math.floor(aLen / 14)), lumR = [], lumA = [];
  for (let k = 0; k < aLen; k += step) { lumR.push(patchLuminance(R[d + k])); lumA.push(patchLuminance(A[k])); }
  const lumDiff = Math.max(...lumR.map((v, i) => Math.abs(v - lumA[i])));
  // the same against the real frames within +-14 (a lag frame shifts a fade by one step)
  let lumTol = 0; for (let k = 0, s = 0; k < aLen; k += step, s++) { let m = Infinity; for (let j = Math.max(0, d + k - 14); j <= Math.min(R.length - 1, d + k + 14); j++) m = Math.min(m, Math.abs(patchLuminance(R[j]) - lumA[s])); lumTol = Math.max(lumTol, m); }
  const out = { name, id: moveId, frames: aLen, offset: d, meanDiffPx: +mean.toFixed(1), exactFrames: zero, maxDiffPx: Math.max(...per), tolMeanDiffPx: +(tolSum / aLen).toFixed(1), tolExactFrames: tolZero, lumReal: lumR, lumArena: lumA, lumMaxDiff: lumDiff, lumTolMaxDiff: lumTol, fieldPx: FIELD_PX };
  if (keep) { out.R = R; out.A = A; out.per = per; }
  return out;
}

/** The oracle's colour-effect arithmetic against the formulas of anim_ppu.js (0 mismatches expected on stable pixels). Returns { brightness: {...}, alpha: {...}, ok }. */
export async function calibrate(o) {
  const D = 0x04000000, exp5 = (c) => (c << 3) | (c >> 2);
  await o.startBattle({ foe: { species: FOE, level: 50, moves: [33, 0, 0, 0], hp: 100, maxHp: 100 }, player: { species: ATK, level: 50, moves: [33, 0, 0, 0], hp: 100, maxHp: 100 }, terrain: ENV, reach: 'action' });
  o.runFrames(40);
  const shot = () => Uint8Array.from(o.screenshotRGBA());
  const up = (v, y) => v + (((255 - v) * y) >> 4), downR = (v, y) => v - ((v * y) >> 4), downGB = (v, y) => (v * (16 - y)) >> 4;
  const res = { brightnessMismatch: 0, brightnessChecked: 0, alphaMismatch: 0, alphaChecked: 0, fiveBitAlphaMismatch: 0, byY: {} };
  for (const effect of [2, 3]) for (let y = 1; y <= 16; y++) {
    // the battle screen is not frozen (a blinking cursor, an idle animation): a pixel that changes on the effect frame itself would count as a mismatch, so a level is tried at up to 4 phases
    let best = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      o.writeU16(D + 0x50, 0); o.runFrames(1 + attempt * 3); const a = shot(); o.runFrames(1); const b = shot();                 // two plain frames: stable pixels
      o.writeU16(D + 0x50, (effect << 6) | 0x3f); o.writeU16(D + 0x54, y); o.runFrames(1); const c = shot();
      o.writeU16(D + 0x50, 0); o.writeU16(D + 0x54, 0); o.runFrames(1); const d2 = shot();                                       // and one after: stable on both sides
      let bad = 0, n = 0;
      for (let p = 0; p < W * 112; p++) {
        const q = p * 4; if (a[q] !== b[q] || a[q + 1] !== b[q + 1] || a[q + 2] !== b[q + 2] || a[q] !== d2[q] || a[q + 1] !== d2[q + 1] || a[q + 2] !== d2[q + 2]) continue;
        for (let ch = 0; ch < 3; ch++) { const want = effect === 2 ? up(b[q + ch], y) : (ch === 0 ? downR(b[q + ch], y) : downGB(b[q + ch], y)); n++; if (want !== c[q + ch]) bad++; }
      }
      if (!best || bad < best[1]) best = [n, bad]; if (bad === 0) break;
    }
    res.byY[(effect === 2 ? 'up' : 'down') + y] = best; res.brightnessChecked += best[0]; res.brightnessMismatch += best[1];
  }
  for (const [eva, evb] of [[8, 8], [6, 10], [12, 4], [4, 12], [10, 6], [3, 13], [14, 2], [9, 7]]) {
    const disp = o.readU16(D); let best = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      o.writeU16(D + 0x50, 0); o.runFrames(1 + attempt * 3); const a = shot(); o.runFrames(1); const b = shot();
      o.writeU16(D, disp & ~0x0100); o.runFrames(1); const below = shot(); o.writeU16(D, disp);                                // BG0 off: what lies under it
      o.writeU16(D + 0x50, (1 << 6) | 1 | (0x3e << 8)); o.writeU16(D + 0x52, eva | (evb << 8)); o.runFrames(1); const bl = shot();
      o.writeU16(D + 0x50, 0); o.runFrames(1); const d2 = shot();
      let n = 0, bad = 0, bad5 = 0;
      for (let p = 0; p < W * 160; p++) {
        const q = p * 4; if (a[q] !== b[q] || a[q + 1] !== b[q + 1] || a[q + 2] !== b[q + 2] || a[q] !== d2[q] || a[q + 1] !== d2[q + 1] || a[q + 2] !== d2[q + 2]) continue;
        if (a[q] === below[q] && a[q + 1] === below[q + 1] && a[q + 2] === below[q + 2]) continue;
        for (let ch = 0; ch < 3; ch++) { n++; if (Math.min(255, (a[q + ch] * eva + below[q + ch] * evb) >> 4) !== bl[q + ch]) bad++; if (exp5(Math.min(31, ((a[q + ch] >> 3) * eva + (below[q + ch] >> 3) * evb) >> 4)) !== bl[q + ch]) bad5++; }
      }
      if (!best || bad < best[1]) best = [n, bad, bad5]; if (bad === 0) break;
    }
    res.alphaChecked += best[0]; res.alphaMismatch += best[1]; res.fiveBitAlphaMismatch += best[2];
  }
  res.ok = res.brightnessMismatch === 0 && res.alphaMismatch === 0 && res.fiveBitAlphaMismatch > 1000;
  return res;
}

/** Moves the scene launches with attacker = target = the user's side. */
export const SELF_TARGET = new Set(['Mist', 'Protect', 'Reflect', 'Light Screen', 'Swords Dance']);
export const DEFAULT_MOVES = 'Ember,Growl,Flamethrower,Slash,Dragon Claw,Tackle,Body Slam,Double Slap,Water Gun,Sleep Powder,Swords Dance,Mist,Bubble Beam,Toxic,Bite,Protect,Solar Beam,Reflect,Light Screen,Hydro Pump,Quick Attack,Earthquake,Thunder Wave,Confuse Ray,Aurora Beam,Hypnosis,Hail,Sunny Day,Psychic,Fire Blast,Giga Drain,Ice Beam,Thunderbolt,Rain Dance,Hyper Beam,Surf,Sandstorm'.split(',');

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2), opt = {};
  for (let i = 0; i < args.length; i++) { if (args[i] === '--calibrate') opt.calibrate = '1'; else if (args[i].startsWith('--')) { opt[args[i].slice(2)] = args[i + 1]; i++; } }
  const o = await openFieldOracle(opt.dir);
  if (opt.calibrate) {
    const r = await calibrate(o);
    console.log(JSON.stringify({ ...r, byY: undefined }));
    console.log(r.ok ? 'calibration: the oracle\'s brightness and alpha-blend arithmetic equal anim_ppu.js\'s on every stable pixel (and the 5-bit blend does not)' : 'calibration FAILED');
    process.exit(r.ok ? 0 : 1);
  }
  const rom = loadRom(), pack = loadPack(rom, { verify: 'header', dexText: false }), ui = createBattleUi(rom);
  let coverage = null; try { coverage = JSON.parse(fs.readFileSync(path.join(ROOT, 'pokemonarena/js/anim_coverage.json'), 'utf8')); } catch (_e) { /* optional */ }
  const an = await createMoveAnimator({ rom, coverage });
  const names = opt.moves ? opt.moves.split(',') : DEFAULT_MOVES, rows = [];
  for (const name of names) {
    const id = pack.moves.findIndex((m) => m && m.name === name); if (id < 0) { console.log(name + ': not in the pack'); continue; }
    const r = await compareMove({ o, an, ui, pack, moveId: id, name, keep: !!opt.png, foe: opt.foe ? Number(opt.foe) : FOE, atk: opt.atk ? Number(opt.atk) : ATK });
    rows.push({ ...r, R: undefined, A: undefined, per: undefined });
    console.log(name.padEnd(13) + ' id ' + String(id).padStart(3) + ' ' + String(r.frames).padStart(3) + 'f  off ' + String(r.offset).padStart(3) + '  mean differing field px/frame ' + String(r.meanDiffPx).padStart(8) + ' of ' + FIELD_PX + '  exact frames ' + r.exactFrames + '/' + r.frames + '  within +-14: ' + r.tolMeanDiffPx + ' px, ' + r.tolExactFrames + ' exact  lum real ' + r.lumReal.join(',') + ' | arena ' + r.lumArena.join(','));
    if (opt.png) { const pick = Array.from({ length: 6 }, (_, i) => Math.floor((i * (r.frames - 1)) / 5)); const sh = contactSheet(pick.flatMap((k) => [{ rgba: r.R[r.offset + k], label: 'real ' + k }, { rgba: r.A[k], label: 'arena ' + k }]), { cols: 4, scale: 1 }); fs.mkdirSync(opt.png, { recursive: true }); writePng(path.join(opt.png, 'field_' + name.replace(/\W+/g, '_') + '.png'), sh.width, sh.height, sh.rgba); }
  }
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(rows, null, 1));
  const tot = rows.length, exact = rows.filter((r) => r.meanDiffPx === 0).length, near = rows.filter((r) => r.meanDiffPx > 0 && r.meanDiffPx < 400).length, mod = rows.filter((r) => r.meanDiffPx >= 400 && r.meanDiffPx <= 2000).length, large = rows.filter((r) => r.meanDiffPx > 2000).length;
  console.log(`field compare: ${tot} moves: ${exact} pixel-exact, ${near} near (< 400 px/frame), ${mod} moderate (400-2000), ${large} large (> 2000)`);
  process.exit(0);
}

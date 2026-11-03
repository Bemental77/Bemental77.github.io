// tools/pokemonarena_anim_oracle_probe.mjs -- records the REAL game's own move animation, frame by frame, with OR1's mGBA oracle
// (tools/pokemonarena_rom_oracle.mjs; the pinned first-party core, nothing downloaded or rebuilt), so the animation engine
// (pokemonarena/js/move_anim.js + anim_cpu.js) can be checked against what the game really does.
//
//   node tools/pokemonarena_anim_oracle_probe.mjs --out <dir> --moves 52,33,0,0 [--slot 0] [--checkpoint CK_MOVE_MENU] [--dir <oracle state dir>] [--hold L|none]
//
// It restores the move-menu checkpoint, writes the chosen moves into the player's gBattleMons, presses A on the slot, then every frame reads
// (a) the whole sprite array gSprites (0x0203beb4, 64 x 0x44 bytes), (b) the animation-engine block (0x020018b4..+0x60), (c) the frame itself,
// while gAnimScriptActive (0x020018b9) is set. The output is scratch (frames and RAM images of a ROM-driven run): it lives in --out, never committed.
//
// ABOUT THE SPEED LOOP (found by reading the ROM, see ANIM.md): this hack's BattleMainCB2 (0x0808b099) runs the whole battle callback chain
// several times per displayed frame ("battle speed"); 0x0806a250 returns 1 while the L button is held. The oracle therefore HOLDS L by default so the
// recorded run is the game's native 1.000x rate -- the rate the engine reproduces (the animator's step() count per frame is the caller's choice).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openOracle, KEY } from './pokemonarena_rom_oracle.mjs';
import { writePng, contactSheet } from './pokemonarena_anim_png.mjs';

export const SPR = 0x0203beb4, ANIM = 0x020018b4;

/** Capture one animation from an oracle already at a move-menu checkpoint. Returns { started, anim: [{f, active, io, tasks, rng, bsi, spr, blk, rgba}], rngPrev / ioPrev (RNG state and I/O registers on the frame before the animation launched), env0 (palette tags, reserved palette count, terrain at the first animation frame), ram0 (with wantRam) }. */
export function captureMove(o, { slot = 0, moves = null, hold = 'L', maxFrames = 900, expect = null, idle: idleFrames = 0, wantRam = false } = {}) {
  if (idleFrames) o.runFrames(idleFrames);                 // idle frames at the menu change the game's RNG roll (OR1): a move that missed shows no animation, so the batch retries with another roll
  // The foe may act first (the turn order is the game's): only the animation of the move we asked for is recorded -- gAnimMoveIndex (the u16 at
  // ANIM+0x40) must equal `expect` (default: the move placed in the chosen slot); a different animation is skipped and the capture waits for ours.
  const want = expect !== null ? expect : (moves ? moves[slot] : null);
  if (moves) o.setBattleMon(0, { moves, pp: moves.map(() => 20) });
  if (slot === 1) o.press(KEY.RIGHT, 3, 10); else if (slot === 2) o.press(KEY.DOWN, 3, 10); else if (slot === 3) { o.press(KEY.DOWN, 3, 10); o.press(KEY.RIGHT, 3, 10); }
  const HOLD = hold && hold !== 'none' ? KEY[hold] : 0;
  const anim = [];
  let started = -1, f = 0, idle = 0, rngPrev = Buffer.from(o.readBytes(0x03005a50, 0x28)), ioPrev = Buffer.from(o.readBytes(0x04000000, 0x58)), varsPrev = Buffer.from(o.readBytes(0x02001c52, 0x18)), ram0 = null, env0 = null;
  while (f < maxFrames) {
    o.core.setKeys(0, HOLD | (f < 4 ? KEY.A : 0));
    o.core.runFrame(); f++;
    const active = o.readU8(ANIM + 5);
    if (active && started < 0 && (want === null || o.readU16(ANIM + 0x40) === want)) { started = f; env0 = { tags: Buffer.from(o.readBytes(0x030020dc, 32)), reserved: o.readU8(0x03005b28), terrain: o.readU8(0x02001d43), btf: o.readU32(0x02001ab4), mons: Buffer.from(o.readBytes(0x02001ecc, 2 * 0x98)), animSpecies: Buffer.from(o.readBytes(0x02001904, 8)), tileBitmap: Buffer.from(o.readBytes(0x0300237c, 128)) }; if (wantRam) ram0 = { ewram: Buffer.from(o.readBytes(0x02000000, 0x40000)), iwram: Buffer.from(o.readBytes(0x03000000, 0x8000)) }; }
    if (started < 0) { rngPrev = Buffer.from(o.readBytes(0x03005a50, 0x28)); ioPrev = Buffer.from(o.readBytes(0x04000000, 0x58)); varsPrev = Buffer.from(o.readBytes(0x02001c52, 0x18)); }
    if (started >= 0) {
      anim.push({ f, active, io: Buffer.from(o.readBytes(0x04000000, 0x58)), tasks: Buffer.from(o.readBytes(0x03005b34, 640)), rng: Buffer.from(o.readBytes(0x03005a50, 0x28)), bsi: Buffer.from(o.readBytes(0x2001d4c, 4)), spr: Buffer.from(o.readBytes(SPR, 64 * 0x44)), blk: Buffer.from(o.readBytes(ANIM, 0x60)), pf: Buffer.from(o.readBytes(0x0203844c, 0x20)), rgba: o.screenshotRGBA() });
      if (!active) { if (++idle > 3) break; } else idle = 0;
    }
  }
  o.core.setKeys(0, 0);
  return { started, anim, rngPrev, ioPrev, varsPrev, env0, ram0 };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const opt = { hold: 'L', out: '.', slot: 0, checkpoint: 'CK_MOVE_MENU', dir: undefined, maxFrames: 900 };
  for (let i = 0; i < args.length; i += 2) { const k = args[i].replace(/^--/, ''); opt[k] = isNaN(Number(args[i + 1])) ? args[i + 1] : Number(args[i + 1]); }
  fs.mkdirSync(opt.out, { recursive: true });
  const o = await openOracle({ stateDir: opt.dir });
  await o.goto(opt.checkpoint);
  const moves = opt.moves ? String(opt.moves).split(',').map(Number) : null;
  const cap = captureMove(o, { slot: opt.slot, moves, hold: opt.hold, maxFrames: opt.maxFrames });
  console.log('animation started at frame', cap.started, 'captured', cap.anim.length, 'frames');
  fs.writeFileSync(path.join(opt.out, 'probe.json'), JSON.stringify({ started: cap.started, count: cap.anim.length, checkpoint: opt.checkpoint, slot: opt.slot, anim: cap.anim.map((x) => ({ f: x.f, active: x.active, bsi: x.bsi.toString('base64'), spr: x.spr.toString('base64'), blk: x.blk.toString('base64') })) }));
  const picks = []; const n = Math.min(24, cap.anim.length);
  for (let k = 0; k < n; k++) picks.push(Math.round((k * (cap.anim.length - 1)) / Math.max(1, n - 1)));
  const sheet = contactSheet(picks.map((p) => ({ rgba: cap.anim[p].rgba, label: `real f${cap.anim[p].f - cap.started}` })), { cols: 6, scale: 1 });
  writePng(path.join(opt.out, 'real_sheet.png'), sheet.width, sheet.height, sheet.rgba);
  console.log('wrote', opt.out);
}

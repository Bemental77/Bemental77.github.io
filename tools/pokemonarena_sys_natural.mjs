// tools/pokemonarena_sys_natural.mjs -- the system animations' send-outs against the REAL game's NATURAL switch (ANIM.md "Round 5").
//
//   node tools/pokemonarena_sys_natural.mjs [--dir <oracle state dir>] [--foe 130,143,6,25,129,94,200] [--player 25,130,143,129,94] [--json out.json]
//
// Why this exists. pokemonarena_sys_compare.mjs verifies an EVENT by injecting the very controller command the engine injects (the oracle writes the command id into the battler's buffer and
// its bit into gBattleControllerExecFlags). That proves the engine runs the ROM's controller exactly as the oracle's injection does -- and nothing about what the game's battle SCRIPT does
// around that command. Round 4 found the gap: the script's `switchindataupdate` copies the incoming Pokemon into gBattleMons[battler] BEFORE `switchinanim`, and neither injection did, so
// both ran the OUTGOING Pokemon's species through the ROM (the foe's ground shadow, SpriteCB_EnemyShadow 0x0807eb88, the mon sprite's template, the animation lengths). Both sides were
// equally wrong, so the injected comparison passed. This tool plays the game's own thing:
//   foe    a real trainer battle (the game builds the trainer's party); the lead is set to 1 HP, the player's Tackle faints it, the game's own script sends out the trainer's next Pokemon
//          (a Pokemon the tool wrote into party slot 1);
//   player a real wild battle, the player picks POKeMON in the action menu, the second party member and SHIFT; the game recalls the lead and sends the second out.
// From the frame the controller starts the switch-in animation, every video frame's REAL state (VRAM, OAM, palette, I/O) is dumped, rendered through the first-party PPU with the text
// layer left out (the very function the runs use; sanity: with every layer it equals the real screenshot, 0 px), and compared with the engine's frames of the same event, aligned by the
// Random() counter (+2 per main-loop iteration in both). The comparison region is the side of the picture the event animates (foe: x 112..239, y 0..63; player: x 0..127, y 40..111): the
// rest holds sprites only the natural flow has (the trainer's party-status balls, the healthboxes mid-update, the EXP bar of the knocked-out foe).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openOracle, FINDINGS, FUNCS, KEY as OKEY } from './pokemonarena_rom_oracle.mjs';
import { GbaMem } from '../pokemonarena/js/anim_ram.js';
import { AnimPpu } from '../pokemonarena/js/anim_ppu.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPR = 0x0203beb4, SWITCH_IN_WAIT = 0x806676d, SHADOW_CB = 0x0807eb89;
export const LAYERS_NO_TEXT = 0x1e;
export const REGION = { foe: [112, 0, 240, 64], player: [0, 40, 128, 112] };

const hexdump = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Plays the real game's natural send-out of `second` (a species number) and records the video state of the switch-in animation. kind: 'foe' | 'player'. */
export async function recordNatural(o, kind, second) {
  const frames = [];
  const origRun = o.core.runFrame.bind(o.core), origSet = o.core.setKeys.bind(o.core), wrapSet = o.writeU32.bind(o), wrapSet8 = o.writeU8.bind(o);
  let holdL = false, rec = false, snap = false, idle = -1, idleRun = 0, startRam = null;
  const side = kind === 'foe' ? 1 : 0;
  const ctlAddr = FINDINGS.gBattlerControllerFuncs.addr + 4 * side;
  const dump = () => ({ vram: Buffer.from(o.readBytes(0x06000000, 0x18000)), oam: Buffer.from(o.readBytes(0x07000000, 0x400)), pram: Buffer.from(o.readBytes(0x05000000, 0x400)), io: Buffer.from(o.readBytes(0x04000000, 0x400)) });
  o.core.setKeys = (p, k) => origSet(p, holdL ? (k | OKEY.L) : k);          // L held = the hack's native 1x battle speed
  o.writeU32 = (a, v) => {
    if (a === FINDINGS.gMain.addr + 4 && v === FUNCS.cb2.battleInit) {      // the same two fixes as the event recorder: indoors (no time-of-day tint) and no follower (the ball is thrown)
      wrapSet8(0x02003840, 8); for (let i = 0; i < 16; i++) wrapSet8(0x02003314 + 36 * i, 0);
      startRam = { tod: o.readU8(0x03001d4c), trainerStruct: Buffer.from(o.readBytes(0x02002398, 0x40)) };
    }
    return wrapSet(a, v);
  };
  o.core.runFrame = () => {
    origRun(); if (!rec) return;
    const ctl = o.readU32(ctlAddr); const f = { rng: o.readU32(0x03005a74), ctl };
    if (!snap && ctl === SWITCH_IN_WAIT) { snap = true; }
    if (snap) { Object.assign(f, dump()); idleRun = ctl === idle ? idleRun + 1 : 0; } else idle = ctl;
    frames.push(f);
  };
  try {
    const lead = { species: 6, level: 50, moves: [33, 0, 0, 0], hp: 150, maxHp: 150, nickname: 'ZAP' };
    let secondBytes;
    if (kind === 'foe') {
      holdL = true;
      await o.startBattle({ trainer: 'game', player: lead, reach: 'action' });
      const E = FINDINGS.gEnemyParty;
      secondBytes = await o.monBytes({ species: second, level: 50, moves: [33, 0, 0, 0], hp: 170, maxHp: 170 });
      o.writeBytes(E.addr + E.stride, secondBytes);
      o.setBattleMon(1, { hp: 1 });
      var startFoe = Buffer.from(o.readBytes(E.addr, 0x60)), startPlayer = Buffer.from(o.readBytes(FINDINGS.gPlayerParty.addr, 0x60));
      rec = true;
      o.playTurn(0, {});                                                    // the player's Tackle faints the lead; the game's script sends the next one out
      for (let i = 0; i < 60 && !(snap && idleRun > 30); i++) { o.press('B', 5, 40); o.runFrames(30); }
    } else {
      await o.startBattle({ foe: { species: 19, level: 3, moves: [33, 0, 0, 0], hp: 30, maxHp: 30 }, player: [lead, { species: second, level: 50, moves: [33, 0, 0, 0], hp: 170, maxHp: 170, nickname: 'ZIP' }], trainer: false, reach: 'action' });
      startFoe = Buffer.from(o.readBytes(FINDINGS.gEnemyParty.addr, 0x60)); startPlayer = Buffer.from(o.readBytes(FINDINGS.gPlayerParty.addr, 0x60));
      secondBytes = Buffer.from(o.readBytes(FINDINGS.gPlayerParty.addr + 0x60, 0x60));
      o.openPartyMenu(); o.runFrames(90);                                    // the party screen ignores input for a while after it opens
      o.press('DOWN', 8, 30); o.press('A', 5, 30);                           // the second Pokemon, its menu
      rec = true; holdL = true;
      o.press('A', 5, 0);                                                    // SHIFT
      for (let i = 0; i < 1200 && !(snap && idleRun > 30); i++) o.runFrames(1);
    }
    rec = false;
    if (!snap) throw new Error('the switch-in animation never started (' + kind + ' ' + second + ')');
    const f0 = frames.findIndex((f) => f.vram);
    const sprEnd = Buffer.from(o.readBytes(SPR, 64 * 0x44));
    return { kind, second, frames, f0, startRam, startFoe, startPlayer, secondBytes: Buffer.from(secondBytes), sprEnd, battlerSpecies: o.battleMon(side).species };
  } finally { o.core.runFrame = origRun; o.core.setKeys = origSet; o.writeU32 = o.constructor.prototype.writeU32; }
}

/** The first-party PPU fed with a dump of the real video state. */
export function realRenderer(rom) {
  const mem = new GbaMem(rom), ppu = new AnimPpu(mem);
  return (f, layers = LAYERS_NO_TEXT) => { mem.vram.set(f.vram); mem.oam.set(f.oam); mem.pram.set(f.pram); mem.io.set(f.io); ppu.layerMask = layers; ppu.setBaseRGBA(null); return Uint8ClampedArray.from(ppu.render()); };
}

const regionDiff = (A, B, [x0, y0, x1, y1]) => { let d = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const q = (y * 240 + x) * 4; if (A[q] !== B[q] || A[q + 1] !== B[q + 1] || A[q + 2] !== B[q + 2]) d++; } return d; };
const timeline = (arr) => { const out = []; let last = -1; arr.forEach(([i, c]) => { if (c !== last) { out.push([i, c]); last = c; } }); return out; };

/** Plays the engine's event on the same battle and compares it with a recording. opts.mutate(SystemRun.prototype) may break something (negative controls) and returns an undo function. */
export async function compareNatural(rom, rec, { animator, mutate } = {}) {
  const render = realRenderer(rom);
  const { frames, f0, startRam } = rec;
  const id = rec.kind === 'foe' ? 8 : 2;
  const undo = mutate ? mutate() : null;
  try {
    const ctx = { foe: { species: 183, level: 4 }, player: { species: 6, level: 50 }, partyBytes: { foe: rec.startFoe, player: rec.startPlayer, switchIn: rec.secondBytes }, seed: 1, trainer: rec.kind === 'foe' ? 1 : 0,
      trainerStruct: rec.kind === 'foe' ? startRam.trainerStruct : undefined, timeOfDay: startRam.tod, environment: 0, maxFrames: 2000 };
    const run = animator.start('system', id, ctx);
    const mem = run.eng.mem, c0 = mem.read32(0x03005a74);
    const side = rec.kind === 'foe' ? 1 : 0, ctlAddr = 0x03002e44 + 4 * side;
    const region = REGION[rec.kind];
    // Two alignments, both by the Random() counter (+2 per main-loop iteration in both runs). LOGIC (the controller function): the real controller flips to the switch-in function at the end of
    // frame f0, the engine's first iteration is that frame. PICTURE: the real game shows an iteration's sprites / palettes one video frame later (OAM and palette are copied by the NEXT VBlank),
    // while the engine draws after the VBlank work of the same iteration, so the engine's iteration j is the picture of real frame f0 + j + 1 (measured: region diff 0 over 185 frames; at
    // f0 + j it is thousands of pixels).
    const perFrame = [], engTl = [], realTl = [];
    let prevL = f0, prevP = f0 + 1, j = 0;
    const find = (anchor, from, target, needVram) => { for (let q = from; q < frames.length; q++) if (frames[q].rng >= target && (!needVram || frames[q].vram)) return q; return -1; };
    while (!run.done && j < 500) {
      run.step();
      engTl.push([j, mem.read32(ctlAddr)]);
      const adv = mem.read32(0x03005a74) - c0 - 2;
      const rl = find(f0, prevL, frames[f0].rng + adv, false), rp = find(f0 + 1, prevP, frames[f0 + 1].rng + adv, true);
      if (rl < 0 || rp < 0) break; prevL = rl; prevP = rp;
      realTl.push([j, frames[rl].ctl]);
      const A = run.draw(null, { layers: LAYERS_NO_TEXT }), B = render(frames[rp]);
      perFrame.push(regionDiff(A, B, region));
      j++;
    }
    // the shadow sprite pair: the engine's last frame vs the real one (struct fields the picture depends on)
    const shadow = (get) => { const o = []; for (let i = 0; i < 64; i++) { const b = get(i); if ((b.flags & 1) && b.cb === SHADOW_CB) o.push([b.attr0, b.attr1, b.attr2, b.x, b.y, b.x2, b.y2].join(',')); } return o; };
    const eShadow = shadow((i) => ({ flags: mem.ewU8(SPR + i * 0x44 + 0x3e), cb: mem.ewU32(SPR + i * 0x44 + 0x1c), attr0: mem.ewU16(SPR + i * 0x44), attr1: mem.ewU16(SPR + i * 0x44 + 2), attr2: mem.ewU16(SPR + i * 0x44 + 4), x: mem.ewS16(SPR + i * 0x44 + 0x20), y: mem.ewS16(SPR + i * 0x44 + 0x22), x2: mem.ewS16(SPR + i * 0x44 + 0x24), y2: mem.ewS16(SPR + i * 0x44 + 0x26) }));
    const se = rec.sprEnd;
    const rShadow = shadow((i) => ({ flags: se[i * 0x44 + 0x3e], cb: se.readUInt32LE(i * 0x44 + 0x1c), attr0: se.readUInt16LE(i * 0x44), attr1: se.readUInt16LE(i * 0x44 + 2), attr2: se.readUInt16LE(i * 0x44 + 4), x: se.readInt16LE(i * 0x44 + 0x20), y: se.readInt16LE(i * 0x44 + 0x22), x2: se.readInt16LE(i * 0x44 + 0x24), y2: se.readInt16LE(i * 0x44 + 0x26) }));
    const bad = perFrame.map((d, k) => [k, d]).filter(([, d]) => d);
    const eT = timeline(engTl), rT = timeline(realTl);
    return { kind: rec.kind, second: rec.second, iterations: perFrame.length, doneAt: run.frame, regionPx: perFrame.reduce((a, d) => a + d, 0), badFrames: bad.length, firstBad: bad.length ? bad[0] : null, lastFramePx: perFrame[perFrame.length - 1],
      timelineEqual: eT.length === rT.length && eT.every((e, i) => e[0] === rT[i][0] && e[1] === rT[i][1]), engineTimeline: eT.map((e) => e[0] + ':' + e[1].toString(16)).join(' '), realTimeline: rT.map((e) => e[0] + ':' + e[1].toString(16)).join(' '),
      shadowEqual: rec.kind === 'foe' ? eShadow.length === 2 && eShadow.join('|') === rShadow.join('|') : null, engineShadow: eShadow, realShadow: rShadow, error: run.error ? String(run.error) : null };
  } finally { if (undo) undo(); }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2), opt = {};
  for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, '')] = args[i + 1];
  const rom = new Uint8Array(fs.readFileSync(process.env.POKEMONARENA_ROM || 'gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba'));
  const { createMoveAnimator } = await import(pathToFileURL(path.join(ROOT, 'pokemonarena/js/move_anim.js')).href);
  const animator = await createMoveAnimator({ rom, systemCache: 0 });
  const o = await openOracle({ stateDir: opt.dir });
  const rows = [];
  for (const [kind, list] of [['foe', (opt.foe || '130,143,6,25,129,94,200').split(',').filter(Boolean).map(Number)], ['player', (opt.player || '25,130,143,129,94').split(',').filter(Boolean).map(Number)]]) {
    for (const second of list) {
      const rec = await recordNatural(o, kind, second);
      const res = await compareNatural(rom, rec, { animator });
      const row = { ...res }; delete row.engineTimeline; delete row.realTimeline; rows.push(row);
      console.log(JSON.stringify(row)); if (!res.timelineEqual) console.log('   engine', res.engineTimeline, '\n   real  ', res.realTimeline);
    }
  }
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(rows, null, 1));
  const ok = rows.filter((r) => !r.error && r.regionPx === 0 && r.timelineEqual && (r.shadowEqual !== false)).length;
  console.log('natural send-outs: ' + ok + ' of ' + rows.length + ' exact (region pixels 0, controller timeline equal, shadow sprites equal)');
}

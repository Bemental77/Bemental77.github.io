// tools/pokemonarena_anim_oracle_compare.mjs -- compares the animation engine's sprite state with the REAL game's, frame by frame.
//   node tools/pokemonarena_anim_oracle_compare.mjs <probe.json from pokemonarena_anim_oracle_probe.mjs> <moveId> [attackerSpecies defenderSpecies]
// Library: import { compareMove } from './pokemonarena_anim_oracle_compare.mjs'.
// For every captured frame it takes the in-use sprites of gSprites (0x44-byte structs) in the real game and in move_anim.js, drops the sprites
// the engine does not create (healthboxes, shadows: the engine has no battle UI -- they are the sprites alive on the real game's first captured frame),
// and compares (callback, position, OAM attribute 0 / size, data[0..7]) as a multiset. It searches the frame offset between the two runs
// (the real game's controller starts the script a frame or two off the engine's start()) and reports the exact-match count.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMoveAnimator, AD } from '../pokemonarena/js/move_anim.js';

const SPR = AD.sprites, SIZE = 0x44;

function snapshot(buf /* Buffer of 64*0x44 bytes */) {
  const out = [];
  for (let i = 0; i < 64; i++) {
    const o = i * SIZE;
    if (!(buf[o + 0x3e] & 1)) continue;
    const rec = {
      id: i, cb: buf.readUInt32LE(o + 0x1c), a0: buf.readUInt16LE(o), a1: buf.readUInt16LE(o + 2), a2: buf.readUInt16LE(o + 4),
      x: buf.readInt16LE(o + 0x20), y: buf.readInt16LE(o + 0x22), x2: buf.readInt16LE(o + 0x24), y2: buf.readInt16LE(o + 0x26),
      anim: buf[o + 0x2a], cmd: buf[o + 0x2b], flags: buf[o + 0x3f], data: [],
    };
    for (let k = 0; k < 8; k++) rec.data.push(buf.readInt16LE(o + 0x2e + 2 * k));
    out.push(rec);
  }
  return out;
}
// sprite ids that appear inside data[] (a callback stored a battler's sprite id) differ between the two runs by construction (the real battle numbers its
// sprites after the healthboxes and shadows); they are compared as 'B<battler>' symbols
let idMap = new Map();
const symData = (r) => r.data.map((d) => (idMap.has(d) ? idMap.get(d) : d)).join(',');
const key = (r) => [r.cb.toString(16), r.x, r.y, r.x2, r.y2, r.a0 & 0xfeff, r.a1 & 0xc000, r.anim, r.cmd, symData(r)].join('|');
const posKey = (r) => `${r.cb.toString(16)}@${r.x + r.x2},${r.y + r.y2}`;

/** realSpr: array of Buffers (gSprites image per frame). Returns { offset, exact, pos, total, realFrames, engineFrames, mismatches[] }. */
export async function compareMove({ an, realSpr, realBsi = null, realIo = null, realTasks = null, realRng = null, realBlk = null, moveId, spA = 1289, spB = 183, side = 0, extraEngineFrames = 40, kind = 'move', ctx = {}, ignoreCbs = [] }) {
  // LAG FRAMES: the real game runs one main-loop iteration per VBlank, and two Random() draws at the end of each (the OR1 oracle's gRngState finding: the sfc32 counter word
  // advances by exactly 2 per iteration). An iteration that does not finish before the capture point (a heavy load: LoadBattleAnimBg, a sprite sheet) leaves that hardware
  // frame with the iteration half done and the counter unchanged; the next frame shows the finished iteration. Those half-done captures are not logical frames, so they are
  // dropped (and reported in .lag) before the engine, which has no cycle clock, is compared frame for frame.
  const lag = []; let afterLag = new Set();
  if (realRng) {
    const d = (k) => realRng[k].readUInt32LE(0x24);
    const keep = realRng.map((_r, k) => k === 0 || d(k) !== d(k - 1));
    for (let k = 0; k < keep.length; k++) if (!keep[k]) lag.push(k);
    { let j = 0; for (let k = 0; k < keep.length; k++) if (keep[k]) { if (k > 0 && !keep[k - 1]) afterLag.add(j); j++; } }   // kept-frame indexes that follow a dropped frame
    const f = (arr) => (arr ? arr.filter((_v, k) => keep[k]) : arr);
    realSpr = f(realSpr); realBsi = f(realBsi); realIo = f(realIo); realTasks = f(realTasks); realBlk = f(realBlk); realRng = f(realRng);
  }
  const realFrames = realSpr.map(snapshot);
  const mapFor = (ids) => new Map(ids.map((id, b) => [id, 'B' + b]).filter(([id]) => id !== 255));
  const realMap = realBsi ? mapFor([...realBsi[0]].slice(0, 2)) : new Map(), engMap = mapFor(ctx.battlerSlots || [9, 11]);
  // who attacks whom comes from the real game's own animation block (+0x22 attacker, +0x21 target): a self-targeting move (Mist, Swords Dance, weather, ...) has both on one side
  const spOf = (sd) => (sd ? spB : spA);
  const atkSide = realBlk && realBlk[0] ? realBlk[0][0x22] & 1 : side, tgtSide = realBlk && realBlk[0] ? realBlk[0][0x21] & 1 : side ^ 1;
  const run = an.start(kind, moveId, { attacker: { side: atkSide, species: spOf(atkSide) }, target: { side: tgtSide, species: spOf(tgtSide) }, bystander: { species: spOf(atkSide ^ 1) }, seed: 1, ...ctx });
  const eng = [], engIo = [], engTasks = [], engBlk = [];
  const engIo0 = Buffer.from(an.eng.mem.io.slice(0, 0x58));   // the registers the run starts from (the 'step -1' state: the real capture of the first iteration still holds these for buffered writes)
  const engEnv = new Set(snapshot(Buffer.from(an.eng.mem.ewram.slice(SPR & 0x3ffff, (SPR & 0x3ffff) + 64 * SIZE))).map((r) => r.id));   // the slots the environment holds before the first step (placeholders + the two battlers)
  for (let i = 0; i < realSpr.length + extraEngineFrames && !run.done; i++) {
    run.step();
    const m = an.eng.mem;
    eng.push(snapshot(Buffer.from(m.ewram.slice(SPR & 0x3ffff, (SPR & 0x3ffff) + 64 * SIZE))));
    engIo.push(Buffer.from(m.io.slice(0, 0x58))); engTasks.push(Buffer.from(m.iwram.slice(0x5b34, 0x5b34 + 640))); engBlk.push(Buffer.from(m.ewram.slice(0x18b4, 0x18b4 + 0x60)));
  }
  const realEnv = new Set(realFrames[0].map((r) => r.id));
  if (realBsi) for (const id of [...realBsi[0]].slice(0, 2)) if (id !== 255) realEnv.add(id);   // the battlers' own sprites are environment even when they are not in use on the first captured frame
  const keyReal = (r) => { idMap = realMap; return key(r); }, keyEng = (r) => { idMap = engMap; return key(r); };
  const ign = new Set(ignoreCbs);   // callbacks whose sprites are left out of BOTH sides (e.g. the dummy-callback clone of a battler's mon sprite, which this model animates differently)
  const filt = (frame, env) => frame.filter((r) => !env.has(r.id) && !ign.has(r.cb));
  let best = null, bestScore = -1;
  // the frame offset: the one that agrees best on the sprites AND on the script position; ties (a long stretch with no sprites at all) go to the canonical offset -1 (the real game's
  // first captured frame is the launching iteration, the engine's step 0 is the next one), then to the smallest |offset|
  const deltas = []; for (let d = -6; d <= 12; d++) deltas.push(d); deltas.sort((a, b) => Math.abs(a + 1) - Math.abs(b + 1) || a - b);
  for (const delta of deltas) {
    let match = 0, total = 0, pos = 0, blkEq = 0;
    for (let k = 0; k < realFrames.length; k++) {
      const e = eng[k + delta]; if (!e) continue;
      if (realBlk && engBlk[k + delta]) { const a = realBlk[k], b = engBlk[k + delta]; if (a.readUInt32LE(0) === b.readUInt32LE(0) && a[4] === b[4]) blkEq++; }
      const A = filt(realFrames[k], realEnv).map(keyReal).sort(), B = filt(e, engEnv).map(keyEng).sort();
      total++; if (A.length === B.length && A.every((v, i) => v === B[i])) match++;
      const pa = filt(realFrames[k], realEnv).map(posKey).sort(), pb = filt(e, engEnv).map(posKey).sort();
      if (pa.length === pb.length && pa.every((v, i) => v === pb[i])) pos++;
    }
    if (match + pos + blkEq > bestScore) { bestScore = match + pos + blkEq; best = { offset: delta, exact: match, pos, total }; }
  }
  const mismatches = [];
  for (let k = 0; k < realFrames.length; k++) {
    const e = eng[k + best.offset]; if (!e) continue;
    const A = filt(realFrames[k], realEnv), B = filt(e, engEnv);
    const ka = new Map(A.map((r) => [keyReal(r), r])), kb = new Map(B.map((r) => [keyEng(r), r]));
    const onlyA = [...ka.keys()].filter((x) => !kb.has(x)), onlyB = [...kb.keys()].filter((x) => !ka.has(x));
    if (onlyA.length || onlyB.length) mismatches.push({ k, realOnly: onlyA.slice(0, 2), engineOnly: onlyB.slice(0, 2) });
  }
  // ---- I/O registers per frame (BG control / scroll (the scroll registers are 9-bit: the real core masks the write, the engine keeps the raw value, so both are masked), windows, mosaic, blend, DISPCNT): a BG-only difference shows here and not in the sprites
  const IOREGS = [0x00, 0x08, 0x0a, 0x0c, 0x0e, 0x10, 0x12, 0x14, 0x16, 0x18, 0x1a, 0x1c, 0x1e, 0x40, 0x42, 0x44, 0x46, 0x48, 0x4a, 0x4c, 0x50, 0x52, 0x54];
  const ioMismatches = []; let ioTotal = 0, ioExact = 0, ioStrict = 0, ioLagSkipped = 0; const ioByReg = {};
  if (realIo) for (let k = 0; k < realIo.length; k++) {
    // The GPU registers reach the chip two ways: SetGpuReg writes straight through while the CPU is inside VBlank (the first ~83k cycles of an iteration) and buffers the write for the
    // next VBlank copy (CopyBufferedValuesToGpuRegs, the start of the next hardware frame) otherwise. Which one a given write took depends on the real cycle at which the iteration
    // reached it, and the engine has no cycle clock: it copies at the end of its step. So the real capture of iteration k holds a register's value from engine step k-1 (buffered) or
    // step k (direct); a frame matches when EVERY register equals one of the two (`exact`), and `strict` counts the frames that match the buffered phase for all registers.
    // The frame after a lag frame is skipped: its VBlank copy came mid-iteration. A value the engine never holds at either step is a real difference and is reported.
    if (afterLag.has(k)) { ioLagSkipped++; continue; }
    const ioAt = (j) => (j === -1 ? engIo0 : engIo[j]), e0 = ioAt(k + best.offset - 1), e1 = ioAt(k + best.offset), e2 = k === 0 ? ioAt(k + best.offset + 1) : undefined, e3 = k === 0 ? Buffer.from(run.ioBeforeLaunch) : undefined;   // frame 0 is the LAUNCHING iteration: its direct writes may already include the engine's first step
    if (!e0 && !e1 && !e2 && !e3) continue; ioTotal++;
    const d = []; let strict = true;
    for (const r of IOREGS) {
      const m = r >= 0x10 && r <= 0x1e ? 0x1ff : 0xffff, a = realIo[k].readUInt16LE(r) & m;
      const b0 = e0 ? e0.readUInt16LE(r) & m : null, b1 = e1 ? e1.readUInt16LE(r) & m : null, b2 = e2 ? e2.readUInt16LE(r) & m : null, b3 = e3 ? e3.readUInt16LE(r) & m : null;
      if (a !== b0) strict = false;
      if (a !== b0 && a !== b1 && a !== b2 && a !== b3) { d.push(`0x${r.toString(16)}:${a.toString(16)}/${(b0 ?? b1 ?? b2 ?? 0).toString(16)}`); ioByReg[r] = (ioByReg[r] || 0) + 1; }
    }
    if (strict) ioStrict++;
    if (d.length) ioMismatches.push({ k, d }); else ioExact++;
  }
  // ---- the SHAPE of every register's history: the sequence of distinct values it takes (repeats collapsed, values held for fewer than 3 frames dropped). An iteration that straddles a VBlank lets the real
  // chip show a value for ONE frame that the engine (which copies at the end of its step) never shows -- BLDCNT 0x3f40 for a frame before 0x00e8 is the usual one -- so the per-frame
  // comparison above can fail by a single frame on a run whose registers do exactly the same things. The shape comparison is the claim that no BG / window / blend register ever holds
  // a value for 2+ frames in one run and not the other, nor changes in a different order.
  const rle = (arr) => { const out = []; let i = 0; while (i < arr.length) { let j = i; while (j < arr.length && arr[j] === arr[i]) j++; out.push([arr[i], j - i]); i = j; } return out; };
  const SHAPE_MIN_RUN = 3;   // a value held for 1-2 frames is below the resolution of this check (the direct / buffered phase and the VBlank straddle move a run's ends by one frame each)
  const shape = (arr) => { const long = rle(arr).filter(([_v, n], i, a) => n >= SHAPE_MIN_RUN || i === 0 || i === a.length - 1).map(([v]) => v); const out = []; for (const v of long) if (!out.length || out[out.length - 1] !== v) out.push(v); return out; };
  const shapeBad = [];
  if (realIo) {
    const ks = []; for (let k = 0; k < realIo.length; k++) if (!afterLag.has(k) && engIo[k + best.offset - 1] !== undefined || k === 0) ks.push(k);
    for (const r of IOREGS) {
      const m = r >= 0x10 && r <= 0x1e ? 0x1ff : 0xffff;
      const A = ks.map((k) => realIo[k].readUInt16LE(r) & m);
      // the engine's value on the SAME frames (the buffered phase: step k-1; a frame the real run skipped as lag is skipped on both sides, so a run keeps the same length on both)
      const B = []; for (const k of ks) { const j = Math.max(-1, k + best.offset - 1), e = j === -1 ? engIo0 : engIo[j]; if (e) B.push(e.readUInt16LE(r) & m); }
      const sa = shape(A), sb = shape(B);
      if (sa.length !== sb.length || sa.some((v, i) => v !== sb[i])) shapeBad.push(r);
    }
  }
  // ---- tasks (function, priority, data words) of the tasks the animation created
  const taskList = (buf, skipIds) => { const out = []; for (let i = 0; i < 16; i++) { if (skipIds.has(i)) continue; const o = i * 40; if (buf[o + 4] !== 1) continue; const d = []; for (let j = 0; j < 16; j++) d.push(buf.readInt16LE(o + 8 + 2 * j)); out.push(buf.readUInt32LE(o).toString(16) + '|' + buf[o + 7] + '|' + d.join(',')); } return out.sort(); };
  const realTaskEnv = new Set(); if (realTasks) for (let i = 0; i < 16; i++) if (realTasks[0][i * 40 + 4] === 1) realTaskEnv.add(i);
  const taskMismatches = []; let taskTotal = 0, taskExact = 0;
  if (realTasks) for (let k = 0; k < realTasks.length; k++) {
    const e = engTasks[k + best.offset]; if (!e) continue; taskTotal++;
    const A = taskList(realTasks[k], realTaskEnv), B = taskList(e, new Set());
    if (A.length === B.length && A.every((v, i) => v === B[i])) taskExact++; else taskMismatches.push({ k, realOnly: A.filter((x) => !B.includes(x)).slice(0, 2), engineOnly: B.filter((x) => !A.includes(x)).slice(0, 2) });
  }
  // ---- the engine block (script pointer, wait counter, arguments): the first frame where the two scripts are not at the same place names the command that diverged
  let blkFirst = null, blkLastK = -1; let blkSame = 0, blkTotal = 0;
  if (realBlk) for (let k = 0; k < realBlk.length; k++) {
    const e = engBlk[k + best.offset]; if (!e) continue; blkTotal++; blkLastK = k;
    const a = realBlk[k], f = (b) => ({ ptr: b.readUInt32LE(0), wait: b[4], active: b[5], cb: b.readUInt32LE(8), args: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => b.readUInt16LE(0x10 + 2 * i)) });
    const A = f(a), B = f(e);
    if (A.ptr === B.ptr && A.wait === B.wait && A.active === B.active) blkSame++; else if (!blkFirst) blkFirst = { k, real: A, engine: B };
  }
  // ---- the END: the real game's script is active on logical frames 0..L (frame 0 = the launching iteration); the engine's step j is the real frame j+1, so the engine should make exactly L+1 steps.
  let realLast = -1; if (realBlk) for (let k = 0; k < realBlk.length; k++) if (realBlk[k][5]) realLast = k;
  const end = realBlk ? { real: realLast + 1, engine: engBlk.length, delta: engBlk.length - (realLast + 1) } : null;
  return { ...best, lag, end, blk: { total: blkTotal, same: blkSame, first: blkFirst, lastK: blkLastK }, realFrames: realFrames.length, engineFrames: eng.length, mismatches, io: { total: ioTotal, exact: ioExact, strict: ioStrict, shapeBad, lagSkipped: ioLagSkipped, byReg: ioByReg, mismatches: ioMismatches }, tasks: { total: taskTotal, exact: taskExact, mismatches: taskMismatches } };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const probe = JSON.parse(fs.readFileSync(argv[0], 'utf8'));
  const rom = new Uint8Array(fs.readFileSync('gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba'));
  const an = await createMoveAnimator({ rom });
  const r = await compareMove({ an, realSpr: probe.anim.map((a) => Buffer.from(a.spr, 'base64')), realBsi: probe.anim.map((a) => Buffer.from(a.bsi || 'AAAAAA==', 'base64')), moveId: Number(argv[1]), spA: Number(argv[2] || 1289), spB: Number(argv[3] || 183) });
  console.log(`move ${argv[1]}: real ${r.realFrames} frames, engine ${r.engineFrames}, best offset ${r.offset}: exact sprite-state match ${r.exact}/${r.total}, position-only ${r.pos}/${r.total}`);
  for (const m of r.mismatches.slice(0, 8)) console.log(` frame ${m.k}: real-only ${m.realOnly.join(' ; ')} | engine-only ${m.engineOnly.join(' ; ')}`);
}

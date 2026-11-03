// tools/pokemonarena_anim_oracle_batch.mjs -- runs many moves through the REAL game (OR1's mGBA oracle) and the animation engine and tabulates how closely
// the engine follows the game: gSprites, the I/O registers (BG control + scroll, windows, blend), the tasks, and the animation script's own position.
//   node tools/pokemonarena_anim_oracle_batch.mjs --dir <oracle state dir> --out <dir> [--ids 1-935 | 1,2,5-9] [--shard i/n] [--resume 1] [--save-real 1]
// Writes <out>/results.<shard>.jsonl, one line per move (a move is appended when it is finished, so an interrupted run resumes with --resume 1). Scratch output only: nothing
// ROM-derived is committed (the lines hold offsets, counts and statuses; --save-real writes contact sheets of REAL frames, which stay in scratch).
//
// Per move: the ladder in pokemonarena_anim_oracle_scenarios.mjs is walked until the real game animates the move (a move that is refused in the trainer battle, say
// Whirlwind, needs a wild one), then compareMove() is run with the game's OWN Random2 state (the frame before the animation launched) and Random() state injected, the
// game's attacker / target taken from its animation block, the oracle's clock (22:13 -> hour 22) and the battle terrain it was recorded on.
import fs from 'node:fs';
import path from 'node:path';
import { openOracle } from './pokemonarena_rom_oracle.mjs';
import { captureMove } from './pokemonarena_anim_oracle_probe.mjs';
import { compareMove } from './pokemonarena_anim_oracle_compare.mjs';
import zlib from 'node:zlib';
import { reachMoveMenu, LADDER, FOE_SPECIES, envCtx, packCapture, unpackCapture } from './pokemonarena_anim_oracle_scenarios.mjs';
import { createMoveAnimator } from '../pokemonarena/js/move_anim.js';
import { writePng, contactSheet } from './pokemonarena_anim_png.mjs';

const args = process.argv.slice(2);
const opt = { out: '.', dir: undefined, ids: '', shard: '0/1', resume: 0, 'save-real': 0, rolls: '0,5,11,17', 'max-ms': 180000, cache: '', 'from-cache': 0 };
for (let i = 0; i < args.length; i += 2) { const k = args[i].replace(/^--/, ''); opt[k] = args[i + 1]; }
const parseIds = (s) => { const out = []; for (const part of String(s).split(',').filter(Boolean)) { const [a, b] = part.split('-').map(Number); for (let i = a; i <= (b ?? a); i++) out.push(i); } return out; };
const [shardI, shardN] = String(opt.shard).split('/').map(Number);
const ids = parseIds(opt.ids).filter((_id, k) => k % shardN === shardI);
fs.mkdirSync(opt.out, { recursive: true });
const file = path.join(opt.out, `results.${shardI}of${shardN}.jsonl`);
const done = new Set();
if (Number(opt.resume) && fs.existsSync(file)) for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (l.trim()) done.add(JSON.parse(l).id); }
const rom = new Uint8Array(fs.readFileSync('gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba'));
const an = await createMoveAnimator({ rom });
const o = Number(opt['from-cache']) ? null : await openOracle({ stateDir: opt.dir });
if (opt.cache) fs.mkdirSync(opt.cache, { recursive: true });
const cacheFile = (id) => path.join(opt.cache, id + '.cap.gz');
const words = (b, off) => [0, 1, 2, 3].map((i) => b.readUInt32LE(off + 4 * i));
const rolls = String(opt.rolls).split(',').map(Number);

async function oneMove(id) {
  const t0 = Date.now();
  let cap = null, scenario = null, tries = 0, idleUsed = 0, terrain = 0;
  if (Number(opt['from-cache'])) {      // re-compare a cached real capture against the current engine; the real game is not run
    if (!fs.existsSync(cacheFile(id))) return { id, error: 'no cached capture' };
    const u = unpackCapture(zlib.gunzipSync(fs.readFileSync(cacheFile(id))).toString('utf8'));
    cap = u.cap; ({ scenario, idle: idleUsed, tries, terrain } = u.meta);
  }
  if (!cap) outer: for (const sc of LADDER) {
    for (const idle of rolls) {      // a move that MISSES shows no animation: retry with another RNG roll
      if (Date.now() - t0 > Number(opt['max-ms'])) break outer;
      tries++;
      try { await reachMoveMenu(o, sc); } catch (e) { break; }
      terrain = o.readU8(0x02001d43);
      try { cap = captureMove(o, { moves: [id, 33, 0, 0], hold: 'L', maxFrames: 1500, idle }); } catch (e) { cap = null; break; }
      if (cap.started >= 0 && cap.anim.length >= 3) { scenario = sc; idleUsed = idle; break outer; }
      cap = null;
    }
  }
  if (!cap) return { id, error: 'the real game never animated it (' + tries + ' tries over the scenario ladder)' };
  if (opt.cache && !Number(opt['from-cache'])) fs.writeFileSync(cacheFile(id), zlib.gzipSync(packCapture(cap, { scenario, idle: idleUsed, tries, terrain })));
  const ctx = envCtx(cap, terrain);
  let cmp;
  try { cmp = await compareMove({ an, realSpr: cap.anim.map((a) => a.spr), realBsi: cap.anim.map((a) => a.bsi), realIo: cap.anim.map((a) => a.io), realTasks: cap.anim.map((a) => a.tasks), realBlk: cap.anim.map((a) => a.blk), realRng: cap.anim.map((a) => a.rng), moveId: id, spB: FOE_SPECIES[scenario], ctx }); }
  catch (e) { return { id, scenario, error: 'compare: ' + e.message }; }
  const b = cmp.blk;
  // the engine's `end` does not wait for the sound to finish (item: IsSEPlaying): a script that differs ONLY on the last frame, the engine finished and the game still waiting, is that
  const seWaitOnly = !!(b.first && b.first.k === b.lastK && b.first.real.active === 1 && b.first.engine.active === 0);
  const scriptEqual = !b.first;
  const r = {
    id, scenario, idle: idleUsed, tries, terrain, foe: FOE_SPECIES[scenario], hwFrames: cap.anim.length, lag: cmp.lag, logicalFrames: cmp.realFrames, engineFrames: cmp.engineFrames, offset: cmp.offset,
    sprites: [cmp.exact, cmp.total], pos: cmp.pos, io: [cmp.io.exact, cmp.io.total], ioStrict: cmp.io.strict, ioShapeBad: cmp.io.shapeBad, tasks: [cmp.tasks.exact, cmp.tasks.total],
    scriptEqual, seWaitOnly, end: cmp.end, ioByReg: cmp.io.byReg,
    firstMismatch: cmp.mismatches[0] || null, firstIo: cmp.io.mismatches[0] || null, firstTask: cmp.tasks.mismatches[0] || null,
    ms: Date.now() - t0,
  };
  const endOk = !r.end || r.end.delta === 0;   // the animation ends on the same frame as the real one (the sound-effect wait is modelled)
  r.identical = r.sprites[0] === r.sprites[1] && r.io[0] === r.io[1] && r.tasks[0] === r.tasks[1] && (scriptEqual || seWaitOnly) && endOk;
  // identical up to timing: the same sprites, tasks and script frame for frame, and every I/O register takes the same sequence of values (see compareMove: shape)
  r.identicalShape = r.sprites[0] === r.sprites[1] && r.tasks[0] === r.tasks[1] && (scriptEqual || seWaitOnly) && r.ioShapeBad.length === 0 && endOk;
  if (Number(opt['save-real']) && cap.anim[0].rgba) {
    const n = Math.min(18, cap.anim.length), picks = [];
    for (let k = 0; k < n; k++) picks.push(Math.round((k * (cap.anim.length - 1)) / Math.max(1, n - 1)));
    const sheet = contactSheet(picks.map((p) => ({ rgba: cap.anim[p].rgba, label: `real ${id} f${cap.anim[p].f - cap.started}` })), { cols: 6 });
    writePng(path.join(opt.out, `real_${id}.png`), sheet.width, sheet.height, sheet.rgba);
  }
  return r;
}

let nDone = 0, nIdent = 0;
for (const id of ids) {
  if (done.has(id)) continue;
  let r;
  try { r = await oneMove(id); } catch (e) { r = { id, error: 'harness: ' + (e && e.message) }; }
  fs.appendFileSync(file, JSON.stringify(r) + '\n');
  nDone++; if (r.identical) nIdent++;
  console.log(r.error ? `move ${id}: ${r.error}` : `move ${id} [${r.scenario}]: sprites ${r.sprites.join('/')} io ${r.io.join('/')} tasks ${r.tasks.join('/')} script ${r.scriptEqual ? 'equal' : r.seWaitOnly ? 'equal-but-end-wait' : 'DIFF'} lag ${r.lag.length}${r.identical ? '  IDENTICAL' : ''}  ${(r.ms / 1000).toFixed(0)}s`);
}
console.log(`shard ${shardI}/${shardN}: ${nDone} moves run this session, ${nIdent} identical`);

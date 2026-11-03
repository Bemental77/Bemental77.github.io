// tools/pokemonarena_anim_oracle_diag.mjs -- explains WHY the engine and the real game differ on a move: sprites, I/O registers and tasks per frame, with the real
// game's own Random2 state injected into the engine (three candidates: the state one frame before the animation started, at its first frame, none).
//   node tools/pokemonarena_anim_oracle_diag.mjs --dir <oracle state dir> [--out <dir>] [--retry 1] <moveId>...
import fs from 'node:fs';
import path from 'node:path';
import { openOracle } from './pokemonarena_rom_oracle.mjs';
import { captureMove } from './pokemonarena_anim_oracle_probe.mjs';
import { compareMove } from './pokemonarena_anim_oracle_compare.mjs';
import { createMoveAnimator } from '../pokemonarena/js/move_anim.js';
import { reachMoveMenu, LADDER, FOE_SPECIES, envCtx } from './pokemonarena_anim_oracle_scenarios.mjs';

const args = process.argv.slice(2);
const opt = { dir: undefined, out: null, scenario: 'trainer' };
const ids = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) { opt[args[i].slice(2)] = isNaN(Number(args[i + 1])) ? args[i + 1] : Number(args[i + 1]); i++; } else ids.push(Number(args[i])); }
const rom = new Uint8Array(fs.readFileSync('gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba'));
const an = await createMoveAnimator({ rom });
const o = await openOracle({ stateDir: opt.dir });
const words = (b, off) => [0, 1, 2, 3].map((i) => b.readUInt32LE(off + 4 * i));
for (const id of ids) {
  let cap = null;
  let terrain = 0;
  for (const idle of [0, 3, 7, 11, 17, 23, 31, 41]) { await reachMoveMenu(o, opt.scenario); terrain = o.readU8(0x02001d43); cap = captureMove(o, { moves: [id, 33, 0, 0], idle, wantRam: true }); if (cap.started >= 0 && cap.anim.length > 3) break; cap = null; }
  if (!cap) { console.log(`move ${id}: the real game never animated it`); continue; }
  // 'real' = the game's own Random2 state from the frame before the animation launched and its Random() state after the launching iteration; 'none' = the engine's own fixed seed
  const variants = { none: null, real: envCtx(cap, terrain) };
  let best = null;
  for (const [name, rng2] of Object.entries(variants)) {
    const r = await compareMove({ an, realSpr: cap.anim.map((a) => a.spr), realBsi: cap.anim.map((a) => a.bsi), realIo: cap.anim.map((a) => a.io), realTasks: cap.anim.map((a) => a.tasks), realBlk: cap.anim.map((a) => a.blk), realRng: cap.anim.map((a) => a.rng), moveId: id, spB: FOE_SPECIES[opt.scenario], ctx: rng2 || { hour: 22, terrain } });
    console.log(`move ${id} rng2=${name}: lag [${r.lag.join(",")}] sprites ${r.exact}/${r.total} (offset ${r.offset}), io ${r.io.exact}/${r.io.total}, tasks ${r.tasks.exact}/${r.tasks.total}`);
    if (!best || r.exact + r.io.exact + r.tasks.exact > best.r.exact + best.r.io.exact + best.r.tasks.exact) best = { name, r };
  }
  const r = best.r;
  if (r.blk.first) { const f = r.blk.first, h = (v) => v.toString(16); console.log(`   script diverges at frame ${f.k}: real ptr ${h(f.real.ptr)} wait ${f.real.wait} active ${f.real.active} | engine ptr ${h(f.engine.ptr)} wait ${f.engine.wait} active ${f.engine.active}  (script equal on ${r.blk.same}/${r.blk.total} frames)`); } else console.log(`   script pointer + wait equal on all ${r.blk.total} frames`);
  for (const m of r.mismatches.slice(0, 3)) console.log(`   sprite frame ${m.k}: real-only ${m.realOnly.join(' ; ').slice(0, 140)}  | engine-only ${m.engineOnly.join(' ; ').slice(0, 140)}`);
  for (const m of r.io.mismatches.slice(0, 3)) console.log(`   io frame ${m.k}: ${m.d.join(' ')}`);
  for (const m of r.tasks.mismatches.slice(0, 3)) console.log(`   task frame ${m.k}: real-only ${m.realOnly.join(' ; ').slice(0, 120)} | engine-only ${m.engineOnly.join(' ; ').slice(0, 120)}`);
  if (opt.out) { fs.mkdirSync(opt.out, { recursive: true }); fs.writeFileSync(path.join(opt.out, `ram0_${id}.json`), JSON.stringify({ ewram: cap.ram0.ewram.toString('base64'), iwram: cap.ram0.iwram.toString('base64'), rngPrev: cap.rngPrev.toString('base64') })); }
}

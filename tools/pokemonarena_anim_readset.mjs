// tools/pokemonarena_anim_readset.mjs -- finds the battle STATE the ROM's animation code reads that the engine's boot did not reproduce.
//
// The engine runs the ROM's own animation code on a small model of the battle (move_anim.js); anything the code reads that the model leaves at zero or at the wrong value is
// an environment difference (a species table the real launcher fills, a battle flag, a palette tag). Guessing them one move at a time was slow; this lists them all:
// during a run it logs every byte of EWRAM / IWRAM the code READS before it has WRITTEN it (the "read set"), and compares each such byte with the REAL game's RAM image taken
// at the first animation frame (captureMove(..., {wantRam: true}).ram0).
//   node tools/pokemonarena_anim_readset.mjs --dir <oracle state dir> [--scenario trainer] <moveId>...
// Output: ranges of differing bytes with the engine's value, the real value, and the first PC that read them. Pointers into the heap and the sprite / task / palette arrays
// differ by construction (the allocations are the engine's own) and are summarised, not listed.
import fs from 'node:fs';
import { openOracle } from './pokemonarena_rom_oracle.mjs';
import { captureMove } from './pokemonarena_anim_oracle_probe.mjs';
import { reachMoveMenu, FOE_SPECIES, envCtx } from './pokemonarena_anim_oracle_scenarios.mjs';
import { createMoveAnimator, AD } from '../pokemonarena/js/move_anim.js';

const EW = 0x02000000, IW = 0x03000000;
/** Runs one move in the engine under a read/write tap. Returns Map(addr -> {v: byte value read, pc}) of bytes read before any run-time write. */
export function readSet(an, kind, id, ctx, maxFrames = 400) {
  const mem = an.eng.mem;
  const run = an.start(kind, id, ctx);
  const written = new Set(), reads = new Map();
  let pc = 0;
  const cpu = an.eng.cpu;
  const rd = { read8: mem.read8.bind(mem), read16: mem.read16.bind(mem), read32: mem.read32.bind(mem) };
  const wr = { write8: mem.write8.bind(mem), write16: mem.write16.bind(mem), write32: mem.write32.bind(mem) };
  const inRam = (a) => (a >>> 24) === 2 || (a >>> 24) === 3;
  const note = (a, n, v) => { for (let i = 0; i < n; i++) { const b = (a + i) >>> 0; if (!written.has(b) && !reads.has(b)) reads.set(b, { v: (v >>> (8 * i)) & 0xff, pc: cpu.r ? cpu.r[15] >>> 0 : 0 }); } };
  mem.read8 = (a) => { const v = rd.read8(a); if (inRam(a)) note(a, 1, v); return v; };
  mem.read16 = (a) => { const v = rd.read16(a); if (inRam(a)) note(a, 2, v); return v; };
  mem.read32 = (a) => { const v = rd.read32(a); if (inRam(a)) note(a, 4, v); return v; };
  const mark = (a, n) => { if (inRam(a)) for (let i = 0; i < n; i++) written.add((a + i) >>> 0); };
  mem.write8 = (a, v) => { mark(a, 1); return wr.write8(a, v); };
  mem.write16 = (a, v) => { mark(a, 2); return wr.write16(a, v); };
  mem.write32 = (a, v) => { mark(a, 4); return wr.write32(a, v); };
  try { for (let k = 0; k < maxFrames && !run.done; k++) run.step(); }
  finally { Object.assign(mem, rd, wr); }
  return reads;
}

/** Compare a read set with the real RAM image. Returns [{addr, len, engine: Buffer, real: Buffer, pc}] merged into runs of adjacent differing bytes. */
export function diffAgainstReal(reads, ram0, engineRam) {
  const real = (a) => ((a >>> 24) === 2 ? ram0.ewram[a - EW] : ram0.iwram[a - IW]);
  const eng = (a) => ((a >>> 24) === 2 ? engineRam.ewram[a - EW] : engineRam.iwram[a - IW]);
  const addrs = [...reads.keys()].sort((x, y) => x - y);
  const out = [];
  for (const a of addrs) {
    const r = real(a);
    if (reads.get(a).v === r) continue;
    const last = out[out.length - 1];
    if (last && last.addr + last.len === a && a - last.addr < 32) { last.len++; last.engine.push(reads.get(a).v); last.real.push(r); }
    else out.push({ addr: a, len: 1, engine: [reads.get(a).v], real: [r], pc: reads.get(a).pc });
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const args = process.argv.slice(2), opt = { dir: undefined, scenario: 'trainer' }, ids = [];
  for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) { opt[args[i].slice(2)] = args[i + 1]; i++; } else ids.push(Number(args[i])); }
  const rom = new Uint8Array(fs.readFileSync('gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba'));
  const an = await createMoveAnimator({ rom });
  const o = await openOracle({ stateDir: opt.dir });
  const hx = (v) => v.toString(16).padStart(2, '0');
  for (const id of ids) {
    let cap = null, terrain = 0;
    for (const idle of [0, 5, 11, 17]) { await reachMoveMenu(o, opt.scenario); terrain = o.readU8(0x02001d43); cap = captureMove(o, { moves: [id, 33, 0, 0], idle, wantRam: true }); if (cap.started >= 0 && cap.anim.length > 3) break; cap = null; }
    if (!cap) { console.log(`move ${id}: the real game never animated it in scenario ${opt.scenario}`); continue; }
    const ctx = { ...envCtx(cap, terrain), attacker: { side: cap.anim[0].blk[0x22] & 1, species: 1289 }, target: { side: cap.anim[0].blk[0x21] & 1, species: FOE_SPECIES[opt.scenario] } };
    if ((ctx.attacker.side) !== 0) ctx.attacker.species = FOE_SPECIES[opt.scenario];
    const reads = readSet(an, 'move', id, ctx);
    const engineRam = { ewram: Buffer.from(an.eng.mem.ewram), iwram: Buffer.from(an.eng.mem.iwram) };
    // the engine's RAM is overwritten by the run; re-create the start state to get the values the code SAW: they are in the read log itself (reads.get(a).v)
    const d = diffAgainstReal(reads, cap.ram0, engineRam);
    const heapLo = AD.heap, heapHi = AD.heap + AD.heapSize;
    // not environment: the heap (the engine's own allocations), gSprites / gTasks, the palette buffers (the real battle's healthbox / ball colours), the OAM buffer and the sprite sort lists
    const skip = [[heapLo, heapHi], [AD.sprites, AD.sprites + 64 * 0x44], [0x03005b34, 0x03005b34 + 640], [0x02038440, 0x02038e00], [0x0203b480, 0x0203bea0], [0x0203b9d0, 0x0203bb00]];
    const interesting = d.filter((x) => !skip.some(([lo, hi]) => x.addr >= lo && x.addr < hi));
    console.log(`move ${id} [${opt.scenario}]: ${reads.size} bytes read before written, ${d.length} differ from the real image, ${interesting.length} outside the heap / sprite / task arrays`);
    for (const x of interesting.slice(0, 60)) console.log(`   0x${x.addr.toString(16)} +${x.len}  engine ${x.engine.slice(0, 12).map(hx).join(' ')}  real ${x.real.slice(0, 12).map(hx).join(' ')}  first read at pc 0x${x.pc.toString(16)}`);
  }
}

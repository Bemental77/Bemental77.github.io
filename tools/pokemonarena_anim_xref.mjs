// tools/pokemonarena_anim_xref.mjs -- literal-pool cross references in the ROM (how the ROM's own routines are found from the addresses the real game is seen running).
//   node tools/pokemonarena_anim_xref.mjs <addr> [<addr>...]      e.g. 0x0808b70d  (THUMB pointers carry bit 0)
// For every 4-byte-aligned word in the ROM equal to <addr> it prints the pool address and the function that reaches it: the nearest earlier `push {...,lr}` (THUMB 0xb5xx) that is
// followed by no other push-with-lr before the pool, plus the first few instructions of that function. Library: import { xrefs, functionStart } from this file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { disRange } from './pokemonarena_anim_dis.mjs';

const ROM = process.env.POKEMONARENA_ROM || process.env.ARENA_ROM || 'gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba';
export function loadRom() { return new Uint8Array(fs.readFileSync(ROM)); }
const u32 = (r, o) => (r[o] | (r[o + 1] << 8) | (r[o + 2] << 16) | (r[o + 3] << 24)) >>> 0;

/** All ROM offsets (file offsets) of aligned words equal to `value`. */
export function xrefs(rom, value) {
  const out = [];
  for (let o = 0; o + 4 <= rom.length; o += 4) if (u32(rom, o) === (value >>> 0)) out.push(o);
  return out;
}
/** The THUMB function a literal-pool word at file offset `pool` belongs to: scan back for `push {..., lr}` (0xb5xx) at an even offset, not crossing 2 KB. Returns a file offset or -1. */
export function functionStart(rom, pool, maxBack = 2048) {
  for (let o = pool - 2; o >= Math.max(0, pool - maxBack); o -= 2) {
    const hw = rom[o] | (rom[o + 1] << 8);
    if ((hw & 0xff00) === 0xb500) return o;           // push {rlist, lr}
  }
  return -1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const rom = loadRom();
  for (const a of process.argv.slice(2)) {
    const v = Number(a);
    const hits = xrefs(rom, v);
    console.log(`${a}: ${hits.length} literal-pool word(s)`);
    for (const h of hits.slice(0, 12)) {
      const f = functionStart(rom, h);
      console.log(`  pool 0x${(0x08000000 + h).toString(16)}  in function starting 0x${f >= 0 ? (0x08000000 + f).toString(16) : '?'} (+0x${f >= 0 ? (h - f).toString(16) : '?'})`);
    }
  }
}

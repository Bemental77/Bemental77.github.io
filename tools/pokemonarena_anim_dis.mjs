// tools/pokemonarena_anim_dis.mjs -- a small first-party ARMv4T THUMB (+ a few ARM) disassembler used to read the
// Pokemon SoulGold ROM's battle-animation code while building pokemonarena/js/anim_cpu.js. Hand-written; contains no
// ROM data. Usage (ROM path comes from POKEMONARENA_ROM or the default site path):
//   node tools/pokemonarena_anim_dis.mjs <romAddr|fileOffset> [count=64] [--arm]
// Library: import { disThumb, disArm, disRange } from './pokemonarena_anim_dis.mjs'.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const R = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'sp', 'lr', 'pc'];
const COND = ['eq', 'ne', 'cs', 'cc', 'mi', 'pl', 'vs', 'vc', 'hi', 'ls', 'ge', 'lt', 'gt', 'le', 'al', 'nv'];
const h = (v) => '0x' + (v >>> 0).toString(16);
const sx = (v, bits) => (v << (32 - bits)) >> (32 - bits);

/** Disassemble one THUMB instruction at bus address `addr` (hw = halfword, hw2 = the next halfword, for BL).
 *  Returns { text, size, target?, lit? }; lit = the pc-relative literal address of `ldr rX,[pc,#n]`. */
export function disThumb(addr, hw, hw2) {
  const op = hw >> 11;
  let t, size = 2, target, lit;
  if ((hw >> 13) === 0) {
    if (op === 3) {
      const I = (hw >> 10) & 1, sub = (hw >> 9) & 1, rn = (hw >> 6) & 7, rs = (hw >> 3) & 7, rd = hw & 7;
      t = `${sub ? 'sub' : 'add'} ${R[rd]}, ${R[rs]}, ${I ? '#' + rn : R[rn]}`;
    } else {
      const off = (hw >> 6) & 31, rs = (hw >> 3) & 7, rd = hw & 7;
      t = `${['lsl', 'lsr', 'asr'][op]} ${R[rd]}, ${R[rs]}, #${off || (op ? 32 : 0)}`;
      if (op === 0 && off === 0) t = `mov ${R[rd]}, ${R[rs]}`;
    }
  } else if ((hw >> 13) === 1) {
    const rd = (hw >> 8) & 7, imm = hw & 255;
    t = `${['mov', 'cmp', 'add', 'sub'][op & 3]} ${R[rd]}, #${imm}`;
  } else if ((hw >> 10) === 0x10) {
    const o = (hw >> 6) & 15, rs = (hw >> 3) & 7, rd = hw & 7;
    t = `${['and', 'eor', 'lsl', 'lsr', 'asr', 'adc', 'sbc', 'ror', 'tst', 'neg', 'cmp', 'cmn', 'orr', 'mul', 'bic', 'mvn'][o]} ${R[rd]}, ${R[rs]}`;
  } else if ((hw >> 10) === 0x11) {
    const o = (hw >> 8) & 3, h1 = (hw >> 7) & 1, h2 = (hw >> 6) & 1, rs = ((hw >> 3) & 7) | (h2 << 3), rd = (hw & 7) | (h1 << 3);
    if (o === 3) t = `${h1 ? 'blx' : 'bx'} ${R[rs]}`;
    else t = `${['add', 'cmp', 'mov'][o]} ${R[rd]}, ${R[rs]}`;
  } else if (op === 9) {
    const rd = (hw >> 8) & 7, w = (hw & 255) << 2;
    lit = (((addr + 4) & ~3) + w) >>> 0;
    t = `ldr ${R[rd]}, [pc, #${w}]`;
  } else if ((hw >> 12) === 5) {
    const o = (hw >> 9) & 7, ro = (hw >> 6) & 7, rb = (hw >> 3) & 7, rd = hw & 7;
    t = `${['str', 'strh', 'strb', 'ldsb', 'ldr', 'ldrh', 'ldrb', 'ldsh'][o]} ${R[rd]}, [${R[rb]}, ${R[ro]}]`;
  } else if ((hw >> 13) === 3) {
    const B = (hw >> 12) & 1, L = (hw >> 11) & 1, off = (hw >> 6) & 31, rb = (hw >> 3) & 7, rd = hw & 7;
    t = `${L ? 'ldr' : 'str'}${B ? 'b' : ''} ${R[rd]}, [${R[rb]}, #${B ? off : off << 2}]`;
  } else if ((hw >> 12) === 8) {
    const L = (hw >> 11) & 1, off = ((hw >> 6) & 31) << 1, rb = (hw >> 3) & 7, rd = hw & 7;
    t = `${L ? 'ldrh' : 'strh'} ${R[rd]}, [${R[rb]}, #${off}]`;
  } else if ((hw >> 12) === 9) {
    const L = (hw >> 11) & 1, rd = (hw >> 8) & 7, w = (hw & 255) << 2;
    t = `${L ? 'ldr' : 'str'} ${R[rd]}, [sp, #${w}]`;
  } else if ((hw >> 12) === 10) {
    const sp = (hw >> 11) & 1, rd = (hw >> 8) & 7, w = (hw & 255) << 2;
    t = `add ${R[rd]}, ${sp ? 'sp' : 'pc'}, #${w}`;
    if (!sp) lit = ((addr + 4) & ~3) + w;
  } else if ((hw >> 8) === 0xb0) {
    const w = (hw & 127) << 2;
    t = `${hw & 128 ? 'sub' : 'add'} sp, #${w}`;
  } else if ((hw >> 12) === 11 && ((hw >> 9) & 3) === 2) {
    const L = (hw >> 11) & 1, rl = hw & 255, r = (hw >> 8) & 1;
    const l = []; for (let i = 0; i < 8; i++) if (rl & (1 << i)) l.push(R[i]);
    if (r) l.push(L ? 'pc' : 'lr');
    t = `${L ? 'pop' : 'push'} {${l.join(', ')}}`;
  } else if ((hw >> 12) === 12) {
    const L = (hw >> 11) & 1, rb = (hw >> 8) & 7, rl = hw & 255;
    const l = []; for (let i = 0; i < 8; i++) if (rl & (1 << i)) l.push(R[i]);
    t = `${L ? 'ldmia' : 'stmia'} ${R[rb]}!, {${l.join(', ')}}`;
  } else if ((hw >> 12) === 13) {
    const c = (hw >> 8) & 15;
    if (c === 15) t = `swi #${hw & 255}`;
    else if (c === 14) t = `udf #${hw & 255}`;
    else { target = (addr + 4 + sx(hw & 255, 8) * 2) >>> 0; t = `b${COND[c]} ${h(target)}`; }
  } else if (op === 28) {
    target = (addr + 4 + sx(hw & 0x7ff, 11) * 2) >>> 0; t = `b ${h(target)}`;
  } else if ((hw >> 12) === 15) {
    if (((hw >> 11) & 1) === 0) {
      if (hw2 !== undefined && (hw2 >> 11) >= 0x1e) {
        const off = (sx(hw & 0x7ff, 11) << 12) + ((hw2 & 0x7ff) << 1);
        target = (addr + 4 + off) >>> 0;
        t = `${(hw2 >> 11) === 0x1f ? 'bl' : 'blx'} ${h(target)}`; size = 4;
      } else t = 'bl.hi ?';
    } else t = 'bl.lo ?';
  } else t = `.hword ${h(hw)}`;
  return { text: t, size, target, lit };
}

function armOperand2(w) {
  if (w & (1 << 25)) { const imm = w & 255, rot = ((w >> 8) & 15) * 2; return '#' + h(((imm >>> rot) | (imm << (32 - rot))) >>> 0); }
  const rm = R[w & 15], st = (w >> 5) & 3, nm = ['lsl', 'lsr', 'asr', 'ror'][st];
  if (w & 16) return `${rm}, ${nm} ${R[(w >> 8) & 15]}`;
  const a = (w >> 7) & 31;
  return a === 0 && st === 0 ? rm : `${rm}, ${nm} #${a || (st ? 32 : 0)}`;
}

/** Disassemble one 32-bit ARM instruction (the subset ARM-mode helpers use). */
export function disArm(addr, w) {
  const cc = (w >>> 28) === 14 ? '' : COND[w >>> 28];
  let t, target, lit;
  if ((w & 0x0ffffff0) === 0x012fff10) t = `bx${cc} ${R[w & 15]}`;
  else if (((w >> 25) & 7) === 5) { target = (addr + 8 + (sx(w & 0xffffff, 24) << 2)) >>> 0; t = `b${w & (1 << 24) ? 'l' : ''}${cc} ${h(target)}`; }
  else if (((w >> 26) & 3) === 0 && (w & 0x0fc000f0) === 0x90) t = `mul${cc} ${R[(w >> 16) & 15]}, ${R[w & 15]}, ${R[(w >> 8) & 15]}`;
  else if (((w >> 26) & 3) === 0 && (w & 0x0f8000f0) === 0x800090) t = `${w & (1 << 22) ? 's' : 'u'}${w & (1 << 21) ? 'mlal' : 'mull'}${cc} ${R[(w >> 12) & 15]}, ${R[(w >> 16) & 15]}, ${R[w & 15]}, ${R[(w >> 8) & 15]}`;
  else if (((w >> 26) & 3) === 0 && (w & 0x90) !== 0x90) {
    const o = (w >> 21) & 15, S = (w >> 20) & 1;
    const nm = ['and', 'eor', 'sub', 'rsb', 'add', 'adc', 'sbc', 'rsc', 'tst', 'teq', 'cmp', 'cmn', 'orr', 'mov', 'bic', 'mvn'][o];
    if (!S && o >= 8 && o <= 11) t = (w & 0x0fbf0fff) === 0x010f0000 ? `mrs${cc} ${R[(w >> 12) & 15]}, ${w & (1 << 22) ? 'spsr' : 'cpsr'}` : `msr${cc} ?${h(w)}`;
    else if (o >= 8 && o <= 11) t = `${nm}${cc} ${R[(w >> 16) & 15]}, ${armOperand2(w)}`;
    else if (o === 13 || o === 15) t = `${nm}${S ? 's' : ''}${cc} ${R[(w >> 12) & 15]}, ${armOperand2(w)}`;
    else t = `${nm}${S ? 's' : ''}${cc} ${R[(w >> 12) & 15]}, ${R[(w >> 16) & 15]}, ${armOperand2(w)}`;
  } else if (((w >> 26) & 3) === 1) {
    const L = (w >> 20) & 1, B = (w >> 22) & 1, U = (w >> 23) & 1, P = (w >> 24) & 1, rn = (w >> 16) & 15, rd = R[(w >> 12) & 15];
    let off;
    if (w & (1 << 25)) off = (U ? '' : '-') + armOperand2(w & ~(1 << 25));
    else off = '#' + (U ? '' : '-') + (w & 0xfff);
    if (rn === 15 && !(w & (1 << 25))) lit = ((addr + 8) + (U ? 1 : -1) * (w & 0xfff)) >>> 0;
    t = `${L ? 'ldr' : 'str'}${B ? 'b' : ''}${cc} ${rd}, [${R[rn]}${P ? ', ' + off + ']' : '], ' + off}${P && (w & (1 << 21)) ? '!' : ''}`;
  } else if (((w >> 25) & 7) === 4) {
    const L = (w >> 20) & 1, rn = (w >> 16) & 15, rl = w & 0xffff, l = [];
    for (let i = 0; i < 16; i++) if (rl & (1 << i)) l.push(R[i]);
    t = `${L ? 'ldm' : 'stm'}${['da', 'ia', 'db', 'ib'][(w >> 23) & 3]}${cc} ${R[rn]}${w & (1 << 21) ? '!' : ''}, {${l.join(', ')}}`;
  } else if (((w >> 24) & 15) === 15) t = `swi${cc} #${w & 0xffffff}`;
  else if (((w >> 25) & 7) === 0 && (w & 0x90) === 0x90) {
    const L = (w >> 20) & 1, sh = (w >> 5) & 3, rn = (w >> 16) & 15, rd = R[(w >> 12) & 15];
    const nm = L ? ['', 'ldrh', 'ldrsb', 'ldrsh'][sh] : ['', 'strh'][sh] || 'swp';
    const off = (w & (1 << 22)) ? '#' + (((w >> 4) & 0xf0) | (w & 15)) : R[w & 15];
    t = `${nm}${cc} ${rd}, [${R[rn]}, ${off}]`;
  } else t = `.word ${h(w)}`;
  return { text: t, size: 4, target, lit };
}

export function disRange(rom, startOff, count, { arm = false } = {}) {
  const lines = [];
  let o = startOff;
  const dv = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  for (let i = 0; i < count && o + 2 <= rom.length; i++) {
    const addr = 0x08000000 + o;
    let r;
    if (arm) r = disArm(addr, dv.getUint32(o, true));
    else r = disThumb(addr, dv.getUint16(o, true), o + 4 <= rom.length ? dv.getUint16(o + 2, true) : undefined);
    let extra = '';
    if (r.lit !== undefined) {
      const lo = r.lit - 0x08000000;
      if (lo >= 0 && lo + 4 <= rom.length) extra = `   ; =${h(dv.getUint32(lo, true))}`;
    }
    const raw = r.size === 4 && !arm ? dv.getUint16(o, true).toString(16).padStart(4, '0') + dv.getUint16(o + 2, true).toString(16).padStart(4, '0')
      : r.size === 4 ? dv.getUint32(o, true).toString(16).padStart(8, '0') : dv.getUint16(o, true).toString(16).padStart(4, '0');
    lines.push(`${h(addr).padEnd(11)} ${raw.padEnd(9)} ${r.text}${extra}`);
    o += r.size;
  }
  return lines;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const romPath = process.env.POKEMONARENA_ROM || 'C:/Users/Admin/Dev/Bemental77.github.io/gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba';
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const rom = new Uint8Array(fs.readFileSync(romPath));
  let a = parseInt(args[0]);
  if (a >= 0x08000000) a -= 0x08000000;
  a &= ~1;
  for (const l of disRange(rom, a, parseInt(args[1] || '64'), { arm: process.argv.includes('--arm') })) console.log(l);
}

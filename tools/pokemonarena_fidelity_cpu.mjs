// tools/pokemonarena_fidelity_cpu.mjs -- a small first-party ARMv4T interpreter (THUMB complete, ARM data-processing / branch / load-store /
// multiply subset) used by the FIDELITY stage to RUN the Pokemon SoulGold ROM's own pure functions (HP-bar pixel math, colour
// thresholds, bar movement) at test time instead of trusting recollection of the Gen-3 decompilation. Hand-written; contains no ROM
// data. The ROM is passed in by the caller and is only ever READ; RAM is a private scratch sandbox.
//
//   import { createCpu } from './pokemonarena_fidelity_cpu.mjs';
//   const cpu = createCpu(romBytes);
//   cpu.call(0x08xxxxxx | 1, [a0, a1, a2])  -> { r0, steps }       // THUMB entry points have the low bit set, ARM entry points do not
//
// Memory map: ROM 0x08000000.. (read-only, any mirror), EWRAM 0x02000000 (256 KiB) and IWRAM 0x03000000 (32 KiB) are sandbox RAM that
// is zero-filled at every call(); stack = top of IWRAM. Any other address throws CpuFault (so a function that touches hardware or
// unmapped memory is rejected, never silently mis-run). A step cap stops runaway loops. `hooks` maps an address to a JS function
// (cpu) => void that runs INSTEAD of the code there, then returns to LR (used for the ROM's division veneers, which are ARM code
// behind a THUMB `bx pc` stub; the interpreter can run them too -- the test proves the hook and the ROM routine agree).

export class CpuFault extends Error {
  constructor(msg, pc) { super(msg + (pc === undefined ? '' : ' @0x' + (pc >>> 0).toString(16))); this.name = 'CpuFault'; this.pc = pc; }
}

const EWRAM_SIZE = 0x40000, IWRAM_SIZE = 0x8000;

export function createCpu(rom, opts = {}) {
  const hooks = new Map(Object.entries(opts.hooks || {}).map(([k, v]) => [Number(k) >>> 0, v]));
  const maxSteps = opts.maxSteps || 2000000;
  const ewram = new Uint8Array(EWRAM_SIZE), iwram = new Uint8Array(IWRAM_SIZE);
  const r = new Int32Array(16);                       // r[15] = address of the NEXT instruction to fetch (pc as seen by the executor)
  let N = 0, Z = 0, C = 0, V = 0, thumb = true, steps = 0, halted = false;
  const LR_SENTINEL = 0xfffffff0;                     // returning to this address ends the call

  const cpu = {
    r, hooks, rom,
    get steps() { return steps; },
    get flags() { return { N, Z, C, V }; },
    ewram, iwram,
  };

  /* ---------------------------------------------------------------- memory */
  function region(a, n) {
    const top = a >>> 24;
    if (top >= 8 && top <= 0xd) { const o = a & 0x01ffffff; if (o + n <= rom.length) return { m: rom, o, rw: false }; }
    else if (top === 2) { const o = a & 0x3ffff; if (o + n <= EWRAM_SIZE) return { m: ewram, o, rw: true }; }
    else if (top === 3) { const o = a & 0x7fff; if (o + n <= IWRAM_SIZE) return { m: iwram, o, rw: true }; }
    throw new CpuFault('bad memory access 0x' + (a >>> 0).toString(16), r[15]);
  }
  const rd8 = (a) => { const g = region(a >>> 0, 1); return g.m[g.o]; };
  const rd16 = (a) => { a >>>= 0; const g = region(a & ~1, 2); return g.m[g.o] | (g.m[g.o + 1] << 8); };
  const rd32 = (a) => {
    a >>>= 0; const g = region(a & ~3, 4); const v = (g.m[g.o] | (g.m[g.o + 1] << 8) | (g.m[g.o + 2] << 16) | (g.m[g.o + 3] << 24));
    const s = (a & 3) * 8; return s ? ((v >>> s) | (v << (32 - s))) | 0 : v | 0;
  };
  const wr8 = (a, v) => { const g = region(a >>> 0, 1); if (!g.rw) throw new CpuFault('write to ROM', r[15]); g.m[g.o] = v & 255; };
  const wr16 = (a, v) => { a >>>= 0; const g = region(a & ~1, 2); if (!g.rw) throw new CpuFault('write to ROM', r[15]); g.m[g.o] = v & 255; g.m[g.o + 1] = (v >> 8) & 255; };
  const wr32 = (a, v) => { a >>>= 0; const g = region(a & ~3, 4); if (!g.rw) throw new CpuFault('write to ROM', r[15]); g.m[g.o] = v & 255; g.m[g.o + 1] = (v >> 8) & 255; g.m[g.o + 2] = (v >> 16) & 255; g.m[g.o + 3] = (v >>> 24) & 255; };
  cpu.rd8 = rd8; cpu.rd16 = rd16; cpu.rd32 = rd32; cpu.wr8 = wr8; cpu.wr16 = wr16; cpu.wr32 = wr32;

  /* ---------------------------------------------------------------- ALU helpers */
  const setNZ = (v) => { N = v < 0 ? 1 : 0; Z = v === 0 ? 1 : 0; };
  function add(a, b, c, setf) {
    const res = (a >>> 0) + (b >>> 0) + c, v = res | 0;
    if (setf) { setNZ(v); C = res > 0xffffffff ? 1 : 0; V = (((a ^ v) & (b ^ v)) < 0) ? 1 : 0; }
    return v;
  }
  function sub(a, b, c, setf) { // a - b - (1-c)
    const res = (a >>> 0) - (b >>> 0) - (1 - c), v = res | 0;
    if (setf) { setNZ(v); C = res >= 0 ? 1 : 0; V = (((a ^ b) & (a ^ v)) < 0) ? 1 : 0; }
    return v;
  }
  // shifts with carry-out (type 0 lsl, 1 lsr, 2 asr, 3 ror); `reg` = shift amount came from a register (amount 0 = no-op)
  function shift(type, v, amt, setf, reg) {
    let res = v, c = C;
    if (reg && amt === 0) return v;
    if (type === 0) {
      if (amt === 0) { /* unchanged */ } else if (amt < 32) { c = (v >>> (32 - amt)) & 1; res = v << amt; } else if (amt === 32) { c = v & 1; res = 0; } else { c = 0; res = 0; }
    } else if (type === 1) {
      if (amt === 0 && !reg) { c = (v >>> 31) & 1; res = 0; } else if (amt < 32) { c = (v >>> (amt - 1)) & 1; res = v >>> amt; } else if (amt === 32) { c = (v >>> 31) & 1; res = 0; } else { c = 0; res = 0; }
    } else if (type === 2) {
      if (amt === 0 && !reg) amt = 32;
      if (amt < 32) { c = (v >> (amt - 1)) & 1; res = v >> amt; } else { c = (v >>> 31) & 1; res = v >> 31; }
    } else {
      if (amt === 0 && !reg) { c = v & 1; res = (C << 31) | (v >>> 1); } else { amt &= 31; if (amt === 0) { c = (v >>> 31) & 1; res = v; } else { c = (v >>> (amt - 1)) & 1; res = (v >>> amt) | (v << (32 - amt)); } }
    }
    if (setf) C = c;
    return res | 0;
  }
  const cond = (c) => {
    switch (c) {
      case 0: return Z === 1; case 1: return Z === 0; case 2: return C === 1; case 3: return C === 0; case 4: return N === 1; case 5: return N === 0;
      case 6: return V === 1; case 7: return V === 0; case 8: return C === 1 && Z === 0; case 9: return C === 0 || Z === 1; case 10: return N === V; case 11: return N !== V;
      case 12: return Z === 0 && N === V; case 13: return Z === 1 || N !== V; default: return true;
    }
  };
  function branchTo(a) { // bx semantics
    if (a & 1) { thumb = true; r[15] = a & ~1; } else { thumb = false; r[15] = a & ~3; }
  }
  function writePc(a) { r[15] = thumb ? a & ~1 : a & ~3; }

  /* ---------------------------------------------------------------- THUMB */
  function stepThumb() {
    const pc = r[15] >>> 0, hw = rd16(pc);
    r[15] = pc + 2;
    const pc4 = pc + 4;
    const op = hw >> 11;
    if ((hw >> 13) === 0) {
      if (op === 3) { // add/sub
        const I = (hw >> 10) & 1, S = (hw >> 9) & 1, rn = (hw >> 6) & 7, rs = (hw >> 3) & 7, rd = hw & 7;
        const b = I ? rn : r[rn];
        r[rd] = S ? sub(r[rs], b, 1, true) : add(r[rs], b, 0, true);
      } else {
        const off = (hw >> 6) & 31, rs = (hw >> 3) & 7, rd = hw & 7;
        r[rd] = shift(op, r[rs], op === 0 ? off : (off || 32), true, op !== 0 ? false : false);
        if (op !== 0 && off === 0) { /* lsr/asr #0 means #32: handled by passing 32 */ }
        setNZ(r[rd]);
      }
    } else if ((hw >> 13) === 1) {
      const rd = (hw >> 8) & 7, imm = hw & 255;
      switch (op & 3) {
        case 0: r[rd] = imm; setNZ(imm); break;
        case 1: sub(r[rd], imm, 1, true); break;
        case 2: r[rd] = add(r[rd], imm, 0, true); break;
        default: r[rd] = sub(r[rd], imm, 1, true);
      }
    } else if ((hw >> 10) === 0x10) {
      const o = (hw >> 6) & 15, rs = (hw >> 3) & 7, rd = hw & 7, a = r[rd], b = r[rs];
      switch (o) {
        case 0: r[rd] = a & b; setNZ(r[rd]); break;
        case 1: r[rd] = a ^ b; setNZ(r[rd]); break;
        case 2: r[rd] = shift(0, a, b & 255, true, true); setNZ(r[rd]); break;
        case 3: r[rd] = shift(1, a, b & 255, true, true); setNZ(r[rd]); break;
        case 4: r[rd] = shift(2, a, b & 255, true, true); setNZ(r[rd]); break;
        case 5: r[rd] = add(a, b, C, true); break;
        case 6: r[rd] = sub(a, b, C, true); break;
        case 7: r[rd] = shift(3, a, b & 255, true, true); setNZ(r[rd]); break;
        case 8: setNZ(a & b); break;
        case 9: r[rd] = sub(0, b, 1, true); break;
        case 10: sub(a, b, 1, true); break;
        case 11: add(a, b, 0, true); break;
        case 12: r[rd] = a | b; setNZ(r[rd]); break;
        case 13: r[rd] = Math.imul(a, b); setNZ(r[rd]); break;
        case 14: r[rd] = a & ~b; setNZ(r[rd]); break;
        default: r[rd] = ~b; setNZ(r[rd]);
      }
    } else if ((hw >> 10) === 0x11) {
      const o = (hw >> 8) & 3, h1 = (hw >> 7) & 1, h2 = (hw >> 6) & 1, rs = ((hw >> 3) & 7) | (h2 << 3), rd = (hw & 7) | (h1 << 3);
      const sv = rs === 15 ? pc4 : r[rs];
      if (o === 3) { if (h1) r[14] = (pc + 2) | 1; branchTo(sv); }
      else {
        const dv = rd === 15 ? pc4 : r[rd];
        if (o === 0) { const v = (dv + sv) | 0; if (rd === 15) writePc(v); else r[rd] = v; }
        else if (o === 1) sub(dv, sv, 1, true);
        else if (rd === 15) writePc(sv); else r[rd] = sv;
      }
    } else if (op === 9) {
      const rd = (hw >> 8) & 7; r[rd] = rd32((pc4 & ~3) + ((hw & 255) << 2));
    } else if ((hw >> 12) === 5) {
      const o = (hw >> 9) & 7, ro = (hw >> 6) & 7, rb = (hw >> 3) & 7, rd = hw & 7, a = (r[rb] + r[ro]) | 0;
      switch (o) {
        case 0: wr32(a, r[rd]); break; case 1: wr16(a, r[rd]); break; case 2: wr8(a, r[rd]); break;
        case 3: r[rd] = (rd8(a) << 24) >> 24; break; case 4: r[rd] = rd32(a); break; case 5: r[rd] = rd16(a); break;
        case 6: r[rd] = rd8(a); break; default: r[rd] = (rd16(a) << 16) >> 16;
      }
    } else if ((hw >> 13) === 3) {
      const B = (hw >> 12) & 1, L = (hw >> 11) & 1, off = (hw >> 6) & 31, rb = (hw >> 3) & 7, rd = hw & 7;
      if (B) { const a = (r[rb] + off) | 0; if (L) r[rd] = rd8(a); else wr8(a, r[rd]); } else { const a = (r[rb] + (off << 2)) | 0; if (L) r[rd] = rd32(a); else wr32(a, r[rd]); }
    } else if ((hw >> 12) === 8) {
      const L = (hw >> 11) & 1, off = ((hw >> 6) & 31) << 1, rb = (hw >> 3) & 7, rd = hw & 7, a = (r[rb] + off) | 0;
      if (L) r[rd] = rd16(a); else wr16(a, r[rd]);
    } else if ((hw >> 12) === 9) {
      const L = (hw >> 11) & 1, rd = (hw >> 8) & 7, a = (r[13] + ((hw & 255) << 2)) | 0;
      if (L) r[rd] = rd32(a); else wr32(a, r[rd]);
    } else if ((hw >> 12) === 10) {
      const sp = (hw >> 11) & 1, rd = (hw >> 8) & 7, w = (hw & 255) << 2;
      r[rd] = sp ? (r[13] + w) | 0 : ((pc4 & ~3) + w) | 0;
    } else if ((hw >> 8) === 0xb0) {
      const w = (hw & 127) << 2; r[13] = (hw & 128) ? (r[13] - w) | 0 : (r[13] + w) | 0;
    } else if ((hw >> 12) === 11 && ((hw >> 9) & 3) === 2) {
      const L = (hw >> 11) & 1, rl = hw & 255, R = (hw >> 8) & 1;
      if (L) {
        let sp = r[13];
        for (let i = 0; i < 8; i++) if (rl & (1 << i)) { r[i] = rd32(sp); sp = (sp + 4) | 0; }
        if (R) { const v = rd32(sp); sp = (sp + 4) | 0; r[13] = sp; branchTo(v); return; }
        r[13] = sp;
      } else {
        let n = R ? 1 : 0; for (let i = 0; i < 8; i++) if (rl & (1 << i)) n++;
        let sp = (r[13] - 4 * n) | 0; r[13] = sp;
        for (let i = 0; i < 8; i++) if (rl & (1 << i)) { wr32(sp, r[i]); sp = (sp + 4) | 0; }
        if (R) wr32(sp, r[14]);
      }
    } else if ((hw >> 12) === 12) {
      const L = (hw >> 11) & 1, rb = (hw >> 8) & 7, rl = hw & 255;
      let a = r[rb];
      for (let i = 0; i < 8; i++) if (rl & (1 << i)) { if (L) r[i] = rd32(a); else wr32(a, r[i]); a = (a + 4) | 0; }
      if (!(L && (rl & (1 << rb)))) r[rb] = a;
    } else if ((hw >> 12) === 13) {
      const c = (hw >> 8) & 15;
      if (c === 15) throw new CpuFault('swi ' + (hw & 255), pc);
      if (c === 14) throw new CpuFault('udf', pc);
      if (cond(c)) writePc(pc4 + (((hw & 255) << 24) >> 24) * 2);
    } else if (op === 28) {
      writePc(pc4 + (((hw & 0x7ff) << 21) >> 21) * 2);
    } else if ((hw >> 12) === 15) {
      if (((hw >> 11) & 1) === 0) {
        const hw2 = rd16(pc + 2); // second half
        if ((hw2 >> 11) < 0x1e) throw new CpuFault('bad bl pair', pc);
        const off = (((hw & 0x7ff) << 21) >> 9) + ((hw2 & 0x7ff) << 1);
        r[14] = (pc + 4) | 1;
        const target = (pc4 + off) >>> 0;
        if ((hw2 >> 11) === 0x1f) { thumb = true; r[15] = target & ~1; } else { thumb = false; r[15] = target & ~3; }
      } else throw new CpuFault('stray bl.lo', pc);
    } else throw new CpuFault('unhandled thumb ' + hw.toString(16), pc);
  }

  /* ---------------------------------------------------------------- ARM subset */
  function armOp2(w, setf) {
    if (w & (1 << 25)) { const imm = w & 255, rot = ((w >> 8) & 15) * 2; const v = rot ? ((imm >>> rot) | (imm << (32 - rot))) | 0 : imm; if (setf && rot) C = (v >>> 31) & 1; return v; }
    const rm = w & 15; let v = rm === 15 ? (r[15] + 4) | 0 : r[rm];           // r[15] is already pc+4 here, ARM pc reads as +8
    const type = (w >> 5) & 3;
    if (w & 16) { const amt = r[(w >> 8) & 15] & 255; return shift(type, rm === 15 ? (v + 4) | 0 : v, amt, setf, true); }
    return shift(type, v, (w >> 7) & 31, setf, false);
  }
  function stepArm() {
    const pc = r[15] >>> 0, w = rd32(pc);
    r[15] = pc + 4;
    const cc = w >>> 28;
    if (cc !== 14 && !cond(cc)) return;
    const pc8 = pc + 8;
    const rv = (n) => (n === 15 ? pc8 | 0 : r[n]);
    if ((w & 0x0ffffff0) === 0x012fff10) { branchTo(r[w & 15]); return; }
    if (((w >> 25) & 7) === 5) { if (w & (1 << 24)) r[14] = pc + 4; r[15] = (pc8 + (((w & 0xffffff) << 8) >> 6)) >>> 0; return; }
    if (((w >> 22) & 0x3f) === 0 && (w & 0xf0) === 0x90) { // MUL / MLA
      const rd = (w >> 16) & 15, rn = (w >> 12) & 15, rs = (w >> 8) & 15, rm = w & 15;
      let v = Math.imul(r[rm], r[rs]); if (w & (1 << 21)) v = (v + r[rn]) | 0;
      r[rd] = v; if (w & (1 << 20)) setNZ(v); return;
    }
    if (((w >> 23) & 0x1f) === 1 && (w & 0xf0) === 0x90) { // UMULL/UMLAL/SMULL/SMLAL
      const rdhi = (w >> 16) & 15, rdlo = (w >> 12) & 15, rs = (w >> 8) & 15, rm = w & 15, sg = (w >> 22) & 1;
      let p = sg ? BigInt(r[rm]) * BigInt(r[rs]) : BigInt(r[rm] >>> 0) * BigInt(r[rs] >>> 0);
      if (w & (1 << 21)) p += (BigInt(r[rdhi] >>> 0) << 32n) | BigInt(r[rdlo] >>> 0);
      p = BigInt.asUintN(64, p); r[rdlo] = Number(p & 0xffffffffn) | 0; r[rdhi] = Number(p >> 32n) | 0;
      if (w & (1 << 20)) { N = r[rdhi] < 0 ? 1 : 0; Z = (r[rdhi] === 0 && r[rdlo] === 0) ? 1 : 0; } return;
    }
    if (((w >> 26) & 3) === 0 && !((w & 0x90) === 0x90 && !(w & (1 << 25)))) {
      const o = (w >> 21) & 15, S = (w >> 20) & 1, rn = (w >> 16) & 15, rd = (w >> 12) & 15;
      if (!S && o >= 8 && o <= 11) throw new CpuFault('psr transfer unsupported', pc);
      const logical = o === 0 || o === 1 || o === 8 || o === 9 || o === 12 || o === 13 || o === 14 || o === 15;
      const b = armOp2(w, S && logical), a = rv(rn);
      let res = 0;
      switch (o) {
        case 0: res = a & b; break; case 1: res = a ^ b; break; case 2: res = sub(a, b, 1, !!S); break; case 3: res = sub(b, a, 1, !!S); break;
        case 4: res = add(a, b, 0, !!S); break; case 5: res = add(a, b, C, !!S); break; case 6: res = sub(a, b, C, !!S); break; case 7: res = sub(b, a, C, !!S); break;
        case 8: setNZ(a & b); return; case 9: setNZ(a ^ b); return; case 10: sub(a, b, 1, true); return; case 11: add(a, b, 0, true); return;
        case 12: res = a | b; break; case 13: res = b; break; case 14: res = a & ~b; break; default: res = ~b;
      }
      if (S && logical) setNZ(res);
      if (rd === 15) { if (S) throw new CpuFault('movs pc unsupported', pc); r[15] = (res >>> 0) & ~3; } else r[rd] = res;
      return;
    }
    if (((w >> 26) & 3) === 1) { // LDR/STR word/byte
      const I = (w >> 25) & 1, P = (w >> 24) & 1, U = (w >> 23) & 1, B = (w >> 22) & 1, Wb = (w >> 21) & 1, L = (w >> 20) & 1, rn = (w >> 16) & 15, rd = (w >> 12) & 15;
      let off = I ? armOp2(w & ~(1 << 25), false) : (w & 0xfff);
      if (I) off = shift((w >> 5) & 3, rv(w & 15), (w >> 7) & 31, false, false);
      const base = rv(rn), ea = U ? (base + off) | 0 : (base - off) | 0, a = P ? ea : base;
      if (L) { const v = B ? rd8(a) : rd32(a); if (!P || Wb) r[rn] = ea; if (rd === 15) r[15] = (v >>> 0) & ~3; else r[rd] = v; }
      else { const v = rd === 15 ? (pc8 + 4) | 0 : r[rd]; if (B) wr8(a, v); else wr32(a, v); if (!P || Wb) r[rn] = ea; }
      return;
    }
    if (((w >> 25) & 7) === 4) { // LDM/STM
      const P = (w >> 24) & 1, U = (w >> 23) & 1, Wb = (w >> 21) & 1, L = (w >> 20) & 1, rn = (w >> 16) & 15, rl = w & 0xffff;
      let n = 0; for (let i = 0; i < 16; i++) if (rl & (1 << i)) n++;
      let a = r[rn]; const start = U ? (P ? a + 4 : a) : (P ? a - 4 * n : a - 4 * n + 4);
      let p = start;
      for (let i = 0; i < 16; i++) if (rl & (1 << i)) { if (L) { const v = rd32(p); if (i === 15) r[15] = (v >>> 0) & ~3; else r[i] = v; } else wr32(p, i === 15 ? (pc8 + 4) | 0 : r[i]); p = (p + 4) | 0; }
      if (Wb) r[rn] = U ? (a + 4 * n) | 0 : (a - 4 * n) | 0;
      return;
    }
    if (((w >> 25) & 7) === 0 && (w & 0x90) === 0x90) { // LDRH/STRH/LDRSB/LDRSH
      const P = (w >> 24) & 1, U = (w >> 23) & 1, Imm = (w >> 22) & 1, Wb = (w >> 21) & 1, L = (w >> 20) & 1, rn = (w >> 16) & 15, rd = (w >> 12) & 15, sh = (w >> 5) & 3;
      const off = Imm ? (((w >> 4) & 0xf0) | (w & 15)) : r[w & 15];
      const base = rv(rn), ea = U ? (base + off) | 0 : (base - off) | 0, a = P ? ea : base;
      if (L) { const v = sh === 1 ? rd16(a) : sh === 2 ? (rd8(a) << 24) >> 24 : (rd16(a) << 16) >> 16; if (!P || Wb) r[rn] = ea; r[rd] = v; }
      else { wr16(a, r[rd]); if (!P || Wb) r[rn] = ea; }
      return;
    }
    throw new CpuFault('unhandled arm ' + w.toString(16), pc);
  }

  /* ---------------------------------------------------------------- run */
  cpu.reset = () => { ewram.fill(0); iwram.fill(0); r.fill(0); N = Z = C = V = 0; steps = 0; };
  // Run the function at `entry` (low bit set = THUMB). args go in r0..r3 (then the stack). Returns { r0, steps }.
  cpu.call = (entry, args = [], o = {}) => {
    if (!o.keepMem) cpu.reset(); else { r.fill(0); steps = 0; }
    for (let i = 0; i < Math.min(4, args.length); i++) r[i] = args[i] | 0;
    r[13] = 0x03007f00;
    if (args.length > 4) { r[13] -= 4 * (args.length - 4); for (let i = 4; i < args.length; i++) wr32(r[13] + 4 * (i - 4), args[i]); }
    r[14] = LR_SENTINEL | 1;
    halted = false;
    branchTo(entry >>> 0);
    while (!halted) {
      if (++steps > maxSteps) throw new CpuFault('step limit', r[15]);
      const pc = r[15] >>> 0;
      if (pc === (LR_SENTINEL & ~1) || pc === LR_SENTINEL) break;
      const hk = hooks.get(pc >>> 0) || hooks.get((pc | 1) >>> 0);
      if (hk) { hk(cpu); const lr = r[14]; branchTo(lr >>> 0); continue; }
      if (thumb) stepThumb(); else stepArm();
    }
    return { r0: r[0], r1: r[1], steps };
  };
  return cpu;
}

// The ROM's division veneers are THUMB `bx pc` stubs into ARM routines; hosts may hook them with these (signed / unsigned quotient in r0, remainder in r1).
export const DIV_HOOKS = {
  signed: (cpu) => { const a = cpu.r[0], b = cpu.r[1]; if (b === 0) throw new CpuFault('divide by zero'); const q = Math.trunc(a / b); cpu.r[0] = q | 0; cpu.r[1] = (a - q * b) | 0; },
  unsigned: (cpu) => { const a = cpu.r[0] >>> 0, b = cpu.r[1] >>> 0; if (b === 0) throw new CpuFault('divide by zero'); const q = Math.floor(a / b); cpu.r[0] = q | 0; cpu.r[1] = (a - q * b) | 0; },
};

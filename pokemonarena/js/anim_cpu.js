// pokemonarena/js/anim_cpu.js -- a first-party ARMv4T interpreter (THUMB formats 1-19 + the ARM instructions a ROM contains)
// with an HLE of the GBA BIOS calls the animation code makes. Pure ES module (browser + Node); no third-party code, no ROM data.
//
// Why it exists: the move animations of the game are driven by native THUMB routines (sprite callbacks, "visual tasks", the script
// command handlers). Running those very routines (against anim_ram.js) reproduces every move without hand-porting any of them.
//
//   const cpu = new GbaCpu(mem);
//   cpu.hook(0x08123456, (c) => { c.r[0] = 1; });      // intercept a function by address (the hook "returns" via lr)
//   const r0 = cpu.call(0x0802a3f5, [arg0, arg1]);        // run a THUMB function to its return; throws CpuFault on a bad state
//
// Conventions: r[15] is the address of the NEXT instruction; an instruction that reads PC as an operand sees (its address + 4)
// in THUMB and (its address + 8) in ARM. Flags are kept as 0/1 integers in cpu.N .Z .C .V. Cycle counts are not modelled;
// cpu.icount counts retired instructions (the budget guard every caller passes).

export class CpuFault extends Error {
  constructor(msg, cpu) { super(msg); this.name = 'CpuFault'; if (cpu) { this.pc = cpu.r[15] >>> 0; this.icount = cpu.icount; } }
}
export class CpuBudgetError extends CpuFault {
  constructor(msg, cpu) { super(msg, cpu); this.name = 'CpuBudgetError'; }
}

export const SLICE_CHECK = 2048;                     // instructions between two looks at the host clock in a sliced call (a power of two)
const SLICE_MASK = SLICE_CHECK - 1;
const RET_MAGIC = 0x0fff0000;   // not mapped anywhere: "return to the caller" sentinel (lr is set to this | 1)

/* ---------------------------------------------------------------------------------------------- BIOS tables */
// BIOS sine table: 256 entries, amplitude 0x4000 (1.14 fixed point) -- derived at load time, not copied from anywhere.
const BIOS_SIN = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) t[i] = Math.round(Math.sin((i * 2 * Math.PI) / 256) * 0x4000);
  return t;
})();

function biosArcTan(tan) {
  // GBATEK "ArcTan": polynomial evaluated in 1.14 fixed point; tan is a signed 16-bit value
  const r0 = (tan << 16) >> 16;
  const r1 = -((r0 * r0) >> 14);
  let r3 = 0xa9;
  r3 = ((r1 * r3) >> 14) + 0x390;
  r3 = ((r1 * r3) >> 14) + 0x91c;
  r3 = ((r1 * r3) >> 14) + 0xfb6;
  r3 = ((r1 * r3) >> 14) + 0x16aa;
  r3 = ((r1 * r3) >> 14) + 0x2081;
  r3 = ((r1 * r3) >> 14) + 0x3651;
  r3 = ((r1 * r3) >> 14) + 0xa2f9;
  return (r0 * r3) >> 16;
}
function biosArcTan2(x, y) {
  x = (x << 16) >> 16; y = (y << 16) >> 16;           // BIOS takes signed 16-bit arguments
  if (y === 0) return x >= 0 ? 0 : 0x8000;
  if (x === 0) return y >= 0 ? 0x4000 : 0xc000;
  if (y >= 0) {
    if (x >= 0) { if (x >= y) return biosArcTan(Math.trunc((y << 14) / x)) & 0xffff; }
    else if (-x >= y) return (biosArcTan(Math.trunc((y << 14) / x)) + 0x8000) & 0xffff;
    return (0x4000 - biosArcTan(Math.trunc((x << 14) / y))) & 0xffff;
  }
  if (x <= 0) { if (-x > -y) return (biosArcTan(Math.trunc((y << 14) / x)) + 0x8000) & 0xffff; }
  else if (x >= -y) return (biosArcTan(Math.trunc((y << 14) / x)) + 0x10000) & 0xffff;
  return (0xc000 - biosArcTan(Math.trunc((x << 14) / y))) & 0xffff;
}

export class GbaCpu {
  constructor(mem, opts = {}) {
    this.mem = mem;
    this.r = new Uint32Array(16);
    this.N = 0; this.Z = 0; this.C = 0; this.V = 0;
    this.thumb = true;
    this.icount = 0;
    this.hooks = new Map();
    // bit per halfword of ROM: "a hook sits here" (16 MiB). opts.hookFlag shares one array between cores whose hook SETS are identical (the system-animation engine pool: the arrays are the
    // size of half the ROM, and the hooks are the same addresses in every engine; each core keeps its own hook functions in this.hooks)
    this.hookFlag = opts.hookFlag || new Uint8Array(mem.rom.length >> 1);
    this.swiLog = new Map();
    this.swiHandler = null;       // optional override (cpu, n) -> true when handled
    this.trace = null;            // optional (pc, hw) tap
    this.callDepth = 0;
    this.unhandledSwi = new Set();
    // Sliced calls (beginCall / resume): a ROM call that can be suspended every SLICE_CHECK instructions when a host deadline has passed, and continued later. Only the OUTERMOST loop
    // (callDepth 1) ever suspends: a nested call made from inside a hook (the smol decoder's fallback, CreateMon wrapper) always runs to its end, so a suspension never leaves a half-run
    // hook behind. `clock` is injectable (tests drive it from the instruction count).
    this.pending = null; this.suspended = false; this._deadline = 0; this._tick = 0;
    this.defaultClock = this.clock = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
  }

  /** Intercept a ROM function at `addr` (THUMB address, bit 0 ignored). The hook runs instead of the function and the
   *  call then returns to lr. A hook that sets cpu.noReturn = true has redirected PC itself. */
  hook(addr, fn) {
    const a = (addr >>> 0) & ~1;
    this.hooks.set(a, fn);
    const o = (a - 0x08000000) >>> 1;
    if (o >= 0 && o < this.hookFlag.length) this.hookFlag[o] = 1;
  }
  /** Observe a ROM function without replacing it: fn(cpu) runs when execution reaches `addr`, then the function runs as usual. */
  hookBefore(addr, fn) { fn.before = true; this.hook(addr, fn); }
  unhook(addr) {
    const a = (addr >>> 0) & ~1;
    this.hooks.delete(a);
    const o = (a - 0x08000000) >>> 1;
    if (o >= 0 && o < this.hookFlag.length) this.hookFlag[o] = 0;
  }

  /** Call a THUMB (odd) or ARM (even) function; returns r0. Registers r4-r11 are preserved like AAPCS. */
  call(addr, args = [], opts = {}) {
    const r = this.r;
    const saved = Uint32Array.from(r);
    const sThumb = this.thumb, sN = this.N, sZ = this.Z, sC = this.C, sV = this.V;
    for (let i = 0; i < args.length && i < 4; i++) r[i] = args[i] >>> 0;
    // arguments 5..: pushed on the stack (AAPCS), the caller's sp is lowered
    let sp = r[13] >>> 0;
    if (args.length > 4) {
      sp -= 4 * (args.length - 4);
      sp &= ~7;
      for (let i = 4; i < args.length; i++) this.mem.write32(sp + 4 * (i - 4), args[i] >>> 0);
      r[13] = sp;
    }
    r[14] = (RET_MAGIC | 1) >>> 0;
    this.thumb = (addr & 1) === 1;
    r[15] = (addr >>> 0) & ~1;
    this.callDepth++;
    try {
      this._run(opts.budget || 2_000_000);
    } finally { this.callDepth--; }
    const ret = r[0] >>> 0, ret1 = r[1] >>> 0;
    // restore callee-saved state (the harness may rely on a clean slate between calls)
    const keep = opts.keepRegs;
    if (!keep) { for (let i = 0; i < 16; i++) r[i] = saved[i]; this.thumb = sThumb; this.N = sN; this.Z = sZ; this.C = sC; this.V = sV; }
    this.ret1 = ret1;
    return ret;
  }

  /* ------------------------------------------------------------------------------------------- main loop */
  _run(budget, absLimit) {
    const r = this.r, mem = this.mem, hookFlag = this.hookFlag;
    const limit = absLimit === undefined ? this.icount + budget : absLimit;
    while (true) {
      const ip = r[15];
      if (ip === RET_MAGIC) return;
      if (this.icount >= limit) throw new CpuBudgetError(`instruction budget (${absLimit === undefined ? budget : this.pending ? this.pending.budget : budget}) exhausted`, this);
      // sliced call: every SLICE_CHECK instructions look at the host clock; past the deadline, stop HERE (registers and memory are consistent) and let resume() continue
      if (this._deadline !== 0 && (++this._tick & SLICE_MASK) === 0 && this.callDepth === 1 && this.clock() >= this._deadline) { this.suspended = true; return; }
      // hooks (ROM only)
      if ((ip >>> 24) === 8) {
        const ho = (ip - 0x08000000) >>> 1;
        if (hookFlag[ho] === 1) {
          const fn = this.hooks.get(ip);
          if (fn) {
            if (fn.before) fn(this);               // an observer: runs, then the real function executes normally
            else {
              this.noReturn = false;
              fn(this);
              if (!this.noReturn) { const lr = r[14]; this.thumb = (lr & 1) === 1; r[15] = lr & ~1; }
              this.icount++;
              continue;
            }
          }
        }
      }
      this.icount++;
      if (this.thumb) this._stepThumb(ip); else this._stepArm(ip);
    }
  }

  /** Start a call that can be run in slices: sets the registers up exactly as call() does and returns; resume(deadline) runs it. Only one sliced call may be in flight. */
  beginCall(addr, args = [], opts = {}) {
    if (this.pending) throw new Error('a sliced call is already in flight');
    const r = this.r;
    const st = { saved: Uint32Array.from(r), sThumb: this.thumb, sN: this.N, sZ: this.Z, sC: this.C, sV: this.V, budget: opts.budget || 2_000_000, keep: !!opts.keepRegs, limit: 0, instr: 0, i0: this.icount };
    for (let i = 0; i < args.length && i < 4; i++) r[i] = args[i] >>> 0;
    let sp = r[13] >>> 0;
    if (args.length > 4) {
      sp -= 4 * (args.length - 4);
      sp &= ~7;
      for (let i = 4; i < args.length; i++) this.mem.write32(sp + 4 * (i - 4), args[i] >>> 0);
      r[13] = sp;
    }
    r[14] = (RET_MAGIC | 1) >>> 0;
    this.thumb = (addr & 1) === 1;
    r[15] = (addr >>> 0) & ~1;
    this.callDepth++;
    st.limit = this.icount + st.budget;
    this.pending = st;
  }
  /** Run the pending call until it returns (true) or the host clock passes `deadline` (a clock() value; Infinity = never) at a check point (false). At least SLICE_CHECK instructions run
   *  per call, so a deadline already in the past still makes progress. A fault or budget overrun leaves no call pending and rethrows. */
  resume(deadline) {
    const st = this.pending;
    if (!st) throw new Error('no sliced call in flight');
    this._deadline = deadline === Infinity ? 0 : deadline; this._tick = 0; this.suspended = false;
    try { this._run(0, st.limit); } catch (e) { this._deadline = 0; this.callDepth--; this.pending = null; throw e; }
    this._deadline = 0;
    if (this.suspended) { this.suspended = false; return false; }
    const r = this.r;
    this.callDepth--; this.pending = null;
    const ret = r[0] >>> 0, ret1 = r[1] >>> 0;
    if (!st.keep) { for (let i = 0; i < 16; i++) r[i] = st.saved[i]; this.thumb = st.sThumb; this.N = st.sN; this.Z = st.sZ; this.C = st.sC; this.V = st.sV; }
    this.ret1 = ret1; this.lastRet = ret;
    return true;
  }
  /** Throw a pending sliced call away and restore the caller's registers (a prepared run that is disposed half way). */
  abortCall() {
    const st = this.pending; if (!st) return;
    const r = this.r;
    for (let i = 0; i < 16; i++) r[i] = st.saved[i]; this.thumb = st.sThumb; this.N = st.sN; this.Z = st.sZ; this.C = st.sC; this.V = st.sV;
    this.callDepth--; this.pending = null; this.suspended = false; this._deadline = 0;
  }

  step() { // single instruction (used by the unit tests)
    const ip = this.r[15];
    this.icount++;
    if (this.thumb) this._stepThumb(ip); else this._stepArm(ip);
  }

  /* --------------------------------------------------------------------------------------------- helpers */
  _setNZ(v) { this.N = v >>> 31; this.Z = v === 0 ? 1 : 0; }
  _add(a, b, c) {
    a >>>= 0; b >>>= 0;
    const s = a + b + c, res = s >>> 0;
    this.N = res >>> 31; this.Z = res === 0 ? 1 : 0; this.C = s > 0xffffffff ? 1 : 0;
    this.V = ((~(a ^ b) & (a ^ res)) >>> 31) & 1;
    return res;
  }
  _sub(a, b, c) { // a - b - (1 - c)  (c is the carry-in: 1 for plain SUB)
    a >>>= 0; b >>>= 0;
    const s = a + (~b >>> 0) + c, res = s >>> 0;
    this.N = res >>> 31; this.Z = res === 0 ? 1 : 0; this.C = s > 0xffffffff ? 1 : 0;
    this.V = (((a ^ b) & (a ^ res)) >>> 31) & 1;
    return res;
  }
  _cond(c) {
    switch (c) {
      case 0: return this.Z === 1;
      case 1: return this.Z === 0;
      case 2: return this.C === 1;
      case 3: return this.C === 0;
      case 4: return this.N === 1;
      case 5: return this.N === 0;
      case 6: return this.V === 1;
      case 7: return this.V === 0;
      case 8: return this.C === 1 && this.Z === 0;
      case 9: return this.C === 0 || this.Z === 1;
      case 10: return this.N === this.V;
      case 11: return this.N !== this.V;
      case 12: return this.Z === 0 && this.N === this.V;
      case 13: return this.Z === 1 || this.N !== this.V;
      case 14: return true;
      default: return false;
    }
  }
  // shifts by an immediate-style amount with carry-out; mode 0 lsl 1 lsr 2 asr 3 ror. `reg` = shift amount came from a register
  _shift(mode, v, amt, reg, setC) {
    v >>>= 0;
    if (reg) {
      amt &= 255;
      if (amt === 0) return v;                 // value and carry unchanged
    } else if (amt === 0) {
      if (mode === 0) return v;                // LSL #0
      if (mode === 1) { if (setC) this.C = v >>> 31; return 0; }                       // LSR #32
      if (mode === 2) { if (setC) this.C = v >>> 31; return (v >>> 31) ? 0xffffffff : 0; }  // ASR #32
      // ROR #0 = RRX
      const c = this.C; if (setC) this.C = v & 1; return ((c << 31) | (v >>> 1)) >>> 0;
    }
    switch (mode) {
      case 0:
        if (amt < 32) { if (setC) this.C = (v >>> (32 - amt)) & 1; return (v << amt) >>> 0; }
        if (setC) this.C = amt === 32 ? v & 1 : 0;
        return 0;
      case 1:
        if (amt < 32) { if (setC) this.C = (v >>> (amt - 1)) & 1; return v >>> amt; }
        if (setC) this.C = amt === 32 ? v >>> 31 : 0;
        return 0;
      case 2:
        if (amt < 32) { if (setC) this.C = (v >>> (amt - 1)) & 1; return (v >> amt) >>> 0; }
        if (setC) this.C = v >>> 31;
        return (v >>> 31) ? 0xffffffff : 0;
      default: {
        const a = amt & 31;
        if (a === 0) { if (setC) this.C = v >>> 31; return v; }
        if (setC) this.C = (v >>> (a - 1)) & 1;
        return ((v >>> a) | (v << (32 - a))) >>> 0;
      }
    }
  }
  _ld32(a) { // unaligned LDR rotates the aligned word
    const v = this.mem.read32(a);
    const s = (a & 3) * 8;
    return s ? ((v >>> s) | (v << (32 - s))) >>> 0 : v;
  }
  _ld16(a) {
    const v = this.mem.read16(a);
    return (a & 1) ? ((v >>> 8) | (v << 24)) >>> 0 : v;
  }
  _ldsh(a) { return (a & 1) ? ((this.mem.read8(a) << 24) >> 24) >>> 0 : ((this.mem.read16(a) << 16) >> 16) >>> 0; }

  /* --------------------------------------------------------------------------------------------- THUMB */
  _stepThumb(ip) {
    const r = this.r, mem = this.mem;
    const hw = mem.read16(ip);
    r[15] = ip + 2;
    if (this.trace) this.trace(ip, hw);
    switch (hw >>> 11) {
      case 0: { // LSL imm
        const rd = hw & 7, rs = (hw >> 3) & 7, off = (hw >> 6) & 31;
        const v = this._shift(0, r[rs], off, false, true); r[rd] = v; this._setNZ(v); return;
      }
      case 1: { // LSR imm
        const rd = hw & 7, rs = (hw >> 3) & 7, off = (hw >> 6) & 31;
        const v = this._shift(1, r[rs], off, false, true); r[rd] = v; this._setNZ(v); return;
      }
      case 2: { // ASR imm
        const rd = hw & 7, rs = (hw >> 3) & 7, off = (hw >> 6) & 31;
        const v = this._shift(2, r[rs], off, false, true); r[rd] = v; this._setNZ(v); return;
      }
      case 3: { // ADD/SUB reg or imm3
        const rd = hw & 7, rs = (hw >> 3) & 7, n = (hw >> 6) & 7;
        const b = (hw & 0x400) ? n : r[n];
        r[rd] = (hw & 0x200) ? this._sub(r[rs], b, 1) : this._add(r[rs], b, 0);
        return;
      }
      case 4: { const rd = (hw >> 8) & 7, v = hw & 255; r[rd] = v; this.N = 0; this.Z = v === 0 ? 1 : 0; return; }
      case 5: { const rd = (hw >> 8) & 7; this._sub(r[rd], hw & 255, 1); return; }
      case 6: { const rd = (hw >> 8) & 7; r[rd] = this._add(r[rd], hw & 255, 0); return; }
      case 7: { const rd = (hw >> 8) & 7; r[rd] = this._sub(r[rd], hw & 255, 1); return; }
      case 8: { // ALU (010000) or hi-reg/BX (010001)
        if (!(hw & 0x400)) { this._thumbAlu(hw); return; }
        const op = (hw >> 8) & 3, h1 = (hw >> 7) & 1, h2 = (hw >> 6) & 1;
        const rs = ((hw >> 3) & 7) | (h2 << 3), rd = (hw & 7) | (h1 << 3);
        const sv = rs === 15 ? (ip + 4) >>> 0 : r[rs];
        if (op === 3) { // BX
          if (sv & 1) { this.thumb = true; r[15] = sv & ~1; } else { this.thumb = false; r[15] = sv & ~3; }
          return;
        }
        const dv = rd === 15 ? (ip + 4) >>> 0 : r[rd];
        if (op === 0) { const v = (dv + sv) >>> 0; if (rd === 15) r[15] = v & ~1; else r[rd] = v; }
        else if (op === 1) this._sub(dv, sv, 1);
        else { if (rd === 15) r[15] = sv & ~1; else r[rd] = sv; }
        return;
      }
      case 9: { // LDR pc-relative
        const rd = (hw >> 8) & 7;
        r[rd] = mem.read32((((ip + 4) & ~3) + ((hw & 255) << 2)) >>> 0);
        return;
      }
      case 10: case 11: { // load/store register offset (0101xxx) and sign-extended
        const rd = hw & 7, rb = (hw >> 3) & 7, ro = (hw >> 6) & 7, a = (r[rb] + r[ro]) >>> 0;
        switch ((hw >> 9) & 7) {
          case 0: mem.write32(a, r[rd]); break;
          case 1: mem.write16(a, r[rd]); break;
          case 2: mem.write8(a, r[rd]); break;
          case 3: r[rd] = (mem.read8(a) << 24) >> 24 >>> 0; break;
          case 4: r[rd] = this._ld32(a); break;
          case 5: r[rd] = this._ld16(a); break;
          case 6: r[rd] = mem.read8(a); break;
          default: r[rd] = this._ldsh(a);
        }
        return;
      }
      case 12: { const rd = hw & 7, a = (r[(hw >> 3) & 7] + (((hw >> 6) & 31) << 2)) >>> 0; mem.write32(a, r[rd]); return; }
      case 13: { const rd = hw & 7, a = (r[(hw >> 3) & 7] + (((hw >> 6) & 31) << 2)) >>> 0; r[rd] = this._ld32(a); return; }
      case 14: { const rd = hw & 7, a = (r[(hw >> 3) & 7] + ((hw >> 6) & 31)) >>> 0; mem.write8(a, r[rd]); return; }
      case 15: { const rd = hw & 7, a = (r[(hw >> 3) & 7] + ((hw >> 6) & 31)) >>> 0; r[rd] = mem.read8(a); return; }
      case 16: { const rd = hw & 7, a = (r[(hw >> 3) & 7] + (((hw >> 6) & 31) << 1)) >>> 0; mem.write16(a, r[rd]); return; }
      case 17: { const rd = hw & 7, a = (r[(hw >> 3) & 7] + (((hw >> 6) & 31) << 1)) >>> 0; r[rd] = this._ld16(a); return; }
      case 18: { const rd = (hw >> 8) & 7, a = (r[13] + ((hw & 255) << 2)) >>> 0; mem.write32(a, r[rd]); return; }
      case 19: { const rd = (hw >> 8) & 7, a = (r[13] + ((hw & 255) << 2)) >>> 0; r[rd] = this._ld32(a); return; }
      case 20: { const rd = (hw >> 8) & 7; r[rd] = ((ip + 4) & ~3) + ((hw & 255) << 2); return; }
      case 21: { const rd = (hw >> 8) & 7; r[rd] = r[13] + ((hw & 255) << 2); return; }
      case 22: case 23: { // misc 1011xxxx
        if ((hw & 0xff00) === 0xb000) { const w = (hw & 127) << 2; r[13] = (hw & 0x80) ? r[13] - w : r[13] + w; return; }
        if (((hw >> 9) & 3) === 2) { // push / pop
          const L = (hw >> 11) & 1, rl = hw & 255, R = (hw >> 8) & 1;
          if (!L) {
            let n = R ? 1 : 0; for (let i = 0; i < 8; i++) if (rl & (1 << i)) n++;
            let sp = (r[13] - 4 * n) >>> 0; r[13] = sp;
            for (let i = 0; i < 8; i++) if (rl & (1 << i)) { mem.write32(sp, r[i]); sp += 4; }
            if (R) mem.write32(sp, r[14]);
          } else {
            let sp = r[13] >>> 0;
            for (let i = 0; i < 8; i++) if (rl & (1 << i)) { r[i] = mem.read32(sp); sp += 4; }
            if (R) { const v = mem.read32(sp); sp += 4; r[13] = sp; r[15] = v & ~1; return; }
            r[13] = sp;
          }
          return;
        }
        throw new CpuFault(`undefined THUMB 0x${hw.toString(16)} at 0x${ip.toString(16)}`, this);
      }
      case 24: { // STMIA
        const rb = (hw >> 8) & 7, rl = hw & 255; let a = r[rb] >>> 0;
        if (rl === 0) { mem.write32(a, (ip + 6) >>> 0); r[rb] = a + 0x40; return; }
        for (let i = 0; i < 8; i++) if (rl & (1 << i)) { mem.write32(a, r[i]); a += 4; }
        r[rb] = a; return;
      }
      case 25: { // LDMIA
        const rb = (hw >> 8) & 7, rl = hw & 255; let a = r[rb] >>> 0;
        if (rl === 0) { r[15] = mem.read32(a) & ~1; r[rb] = a + 0x40; return; }
        for (let i = 0; i < 8; i++) if (rl & (1 << i)) { r[i] = mem.read32(a); a += 4; }
        if (!(rl & (1 << rb))) r[rb] = a;
        return;
      }
      case 26: case 27: { // conditional branch / SWI
        const c = (hw >> 8) & 15;
        if (c === 15) { this._swi(hw & 255, ip); return; }
        if (c === 14) throw new CpuFault(`undefined THUMB 0x${hw.toString(16)} at 0x${ip.toString(16)}`, this);
        if (this._cond(c)) r[15] = (ip + 4 + (((hw & 255) << 24) >> 23)) >>> 0;
        return;
      }
      case 28: { r[15] = (ip + 4 + (((hw & 0x7ff) << 21) >> 20)) >>> 0; return; }
      case 29: throw new CpuFault(`BLX/undefined THUMB 0x${hw.toString(16)} at 0x${ip.toString(16)}`, this);
      case 30: { r[14] = (ip + 4 + (((hw & 0x7ff) << 21) >> 9)) >>> 0; return; }
      default: { // 31: BL second half
        const t = (r[14] + ((hw & 0x7ff) << 1)) >>> 0;
        r[14] = (ip + 2) | 1;
        r[15] = t; return;
      }
    }
  }

  _thumbAlu(hw) {
    const r = this.r, rd = hw & 7, rs = (hw >> 3) & 7;
    const a = r[rd], b = r[rs];
    let v;
    switch ((hw >> 6) & 15) {
      case 0: v = (a & b) >>> 0; this._setNZ(v); r[rd] = v; return;
      case 1: v = (a ^ b) >>> 0; this._setNZ(v); r[rd] = v; return;
      case 2: v = this._shift(0, a, b, true, true); this._setNZ(v); r[rd] = v; return;
      case 3: v = this._shift(1, a, b, true, true); this._setNZ(v); r[rd] = v; return;
      case 4: v = this._shift(2, a, b, true, true); this._setNZ(v); r[rd] = v; return;
      case 5: r[rd] = this._add(a, b, this.C); return;
      case 6: r[rd] = this._sub(a, b, this.C); return;
      case 7: v = this._shift(3, a, b, true, true); this._setNZ(v); r[rd] = v; return;
      case 8: v = (a & b) >>> 0; this._setNZ(v); return;
      case 9: r[rd] = this._sub(0, b, 1); return;
      case 10: this._sub(a, b, 1); return;
      case 11: this._add(a, b, 0); return;
      case 12: v = (a | b) >>> 0; this._setNZ(v); r[rd] = v; return;
      case 13: v = Math.imul(a, b) >>> 0; this._setNZ(v); r[rd] = v; return;
      case 14: v = (a & ~b) >>> 0; this._setNZ(v); r[rd] = v; return;
      default: v = ~b >>> 0; this._setNZ(v); r[rd] = v;
    }
  }

  /* ------------------------------------------------------------------------------------------------ ARM */
  _stepArm(ip) {
    const r = this.r, mem = this.mem;
    const w = mem.read32(ip);
    r[15] = ip + 4;
    if (this.trace) this.trace(ip, w);
    const cond = w >>> 28;
    if (cond !== 14 && !this._cond(cond)) return;
    const pcv = (ip + 8) >>> 0;
    const reg = (n) => (n === 15 ? pcv : r[n]);
    const k = (w >>> 25) & 7;
    // BX
    if ((w & 0x0ffffff0) === 0x012fff10) {
      const v = reg(w & 15);
      if (v & 1) { this.thumb = true; r[15] = v & ~1; } else r[15] = v & ~3;
      return;
    }
    if (k === 5) { // B / BL
      const off = ((w & 0xffffff) << 8) >> 6;
      if (w & (1 << 24)) r[14] = (ip + 4) >>> 0;
      r[15] = (pcv + off) >>> 0; return;
    }
    if (k === 7 && (w & (1 << 24))) { this._swi(w & 0xffffff, ip); return; }
    if (k === 0 && (w & 0xf0) === 0x90) { // multiply family
      const rd = (w >> 16) & 15, rn = (w >> 12) & 15, rs = (w >> 8) & 15, rm = w & 15, S = (w >> 20) & 1;
      if (!(w & (1 << 23))) { // MUL/MLA
        let v = Math.imul(reg(rm), reg(rs));
        if (w & (1 << 21)) v += reg(rn);
        v >>>= 0; r[rd] = v; if (S) this._setNZ(v); return;
      }
      const a = BigInt(reg(rm)), b = BigInt(reg(rs));
      let prod;
      if (w & (1 << 22)) prod = BigInt.asIntN(32, a) * BigInt.asIntN(32, b); else prod = a * b;
      if (w & (1 << 21)) prod += (BigInt(reg(rd)) << 32n) | BigInt(reg(rn));
      prod = BigInt.asUintN(64, prod);
      r[rn] = Number(prod & 0xffffffffn); r[rd] = Number(prod >> 32n);
      if (S) { this.N = Number(prod >> 63n); this.Z = prod === 0n ? 1 : 0; }
      return;
    }
    if (k === 0 && (w & 0x90) === 0x90) { // halfword / signed transfers
      const P = (w >> 24) & 1, U = (w >> 23) & 1, I = (w >> 22) & 1, W = (w >> 21) & 1, L = (w >> 20) & 1;
      const rn = (w >> 16) & 15, rd = (w >> 12) & 15, sh = (w >> 5) & 3;
      const off = I ? (((w >> 4) & 0xf0) | (w & 15)) : reg(w & 15);
      const base = reg(rn);
      const addr = P ? (U ? base + off : base - off) >>> 0 : base;
      if (L) {
        if (sh === 1) r[rd] = this._ld16(addr);
        else if (sh === 2) r[rd] = ((mem.read8(addr) << 24) >> 24) >>> 0;
        else r[rd] = this._ldsh(addr);
      } else if (sh === 1) mem.write16(addr, reg(rd));
      else throw new CpuFault(`unsupported ARM 0x${w.toString(16)} at 0x${ip.toString(16)}`, this);
      if (!P || W) { if (!(L && rn === rd)) r[rn] = (U ? base + off : base - off) >>> 0; }
      return;
    }
    if (k === 0 || k === 1) { // data processing (+ MRS/MSR)
      const I = (w >> 25) & 1, op = (w >> 21) & 15, S = (w >> 20) & 1, rn = (w >> 16) & 15, rd = (w >> 12) & 15;
      if (!S && op >= 8 && op <= 11) { // PSR transfer
        if (op === 8 || op === 10) { // MRS
          r[rd] = ((this.N << 31) | (this.Z << 30) | (this.C << 29) | (this.V << 28) | (this.thumb ? 0x20 : 0) | 0x1f) >>> 0; return;
        }
        let v = I ? this._rotImm(w) : reg(w & 15);   // MSR (flags field only)
        if (w & (1 << 19)) { this.N = (v >>> 31) & 1; this.Z = (v >>> 30) & 1; this.C = (v >>> 29) & 1; this.V = (v >>> 28) & 1; }
        return;
      }
      let b, shC = this.C;
      if (I) { b = this._rotImm(w); const rot = ((w >> 8) & 15) * 2; if (rot) shC = b >>> 31; }
      else {
        const rm = w & 15, mode = (w >> 5) & 3;
        let v = reg(rm);
        const saveC = this.C;
        if (w & 16) { // register-specified shift; PC reads as +12
          if (rm === 15) v = (ip + 12) >>> 0;
          b = this._shift(mode, v, reg((w >> 8) & 15), true, true);
        } else b = this._shift(mode, v, (w >> 7) & 31, false, true);
        shC = this.C; this.C = saveC;
      }
      const a = reg(rn);
      let res, logical = false;
      switch (op) {
        case 0: res = (a & b) >>> 0; logical = true; break;
        case 1: res = (a ^ b) >>> 0; logical = true; break;
        case 2: res = S ? this._sub(a, b, 1) : (a - b) >>> 0; break;
        case 3: res = S ? this._sub(b, a, 1) : (b - a) >>> 0; break;
        case 4: res = S ? this._add(a, b, 0) : (a + b) >>> 0; break;
        case 5: res = S ? this._add(a, b, this.C) : (a + b + this.C) >>> 0; break;
        case 6: res = S ? this._sub(a, b, this.C) : (a - b - 1 + this.C) >>> 0; break;
        case 7: res = S ? this._sub(b, a, this.C) : (b - a - 1 + this.C) >>> 0; break;
        case 8: res = (a & b) >>> 0; logical = true; break;
        case 9: res = (a ^ b) >>> 0; logical = true; break;
        case 10: this._sub(a, b, 1); return;
        case 11: this._add(a, b, 0); return;
        case 12: res = (a | b) >>> 0; logical = true; break;
        case 13: res = b >>> 0; logical = true; break;
        case 14: res = (a & ~b) >>> 0; logical = true; break;
        default: res = ~b >>> 0; logical = true;
      }
      if (logical && S) { this._setNZ(res); this.C = shC; }
      if (op === 8 || op === 9) return;
      if (rd === 15) r[15] = res & (this.thumb ? ~1 : ~3); else r[rd] = res;
      return;
    }
    if (k === 2 || k === 3) { // single data transfer
      if (k === 3 && (w & 0x10)) throw new CpuFault(`undefined ARM 0x${w.toString(16)} at 0x${ip.toString(16)}`, this);
      const I = (w >> 25) & 1, P = (w >> 24) & 1, U = (w >> 23) & 1, B = (w >> 22) & 1, W = (w >> 21) & 1, L = (w >> 20) & 1;
      const rn = (w >> 16) & 15, rd = (w >> 12) & 15;
      let off;
      if (!I) off = w & 0xfff;
      else { const saveC = this.C; off = this._shift((w >> 5) & 3, reg(w & 15), (w >> 7) & 31, false, true); this.C = saveC; }
      const base = reg(rn);
      const eff = (U ? base + off : base - off) >>> 0;
      const addr = P ? eff : base;
      if (L) {
        const v = B ? mem.read8(addr) : this._ld32(addr);
        if (!P || W) r[rn] = eff;
        if (rd === 15) { if (v & 1) { this.thumb = true; r[15] = v & ~1; } else r[15] = v & ~3; } else r[rd] = v;
      } else {
        const v = rd === 15 ? (ip + 12) >>> 0 : r[rd];
        if (B) mem.write8(addr, v); else mem.write32(addr, v);
        if (!P || W) r[rn] = eff;
      }
      return;
    }
    if (k === 4) { // LDM/STM
      const P = (w >> 24) & 1, U = (w >> 23) & 1, W = (w >> 21) & 1, L = (w >> 20) & 1, rn = (w >> 16) & 15, rl = w & 0xffff;
      let n = 0; for (let i = 0; i < 16; i++) if (rl & (1 << i)) n++;
      const base = r[rn] >>> 0;
      let a = U ? (P ? base + 4 : base) : (P ? base - 4 * n : base - 4 * n + 4);
      a >>>= 0;
      const nb = (U ? base + 4 * n : base - 4 * n) >>> 0;
      if (L) {
        for (let i = 0; i < 16; i++) if (rl & (1 << i)) {
          const v = mem.read32(a); a += 4;
          if (i === 15) { if (v & 1) { this.thumb = true; r[15] = v & ~1; } else r[15] = v & ~3; } else r[i] = v;
        }
        if (W && !(rl & (1 << rn))) r[rn] = nb;
      } else {
        for (let i = 0; i < 16; i++) if (rl & (1 << i)) { mem.write32(a, i === 15 ? (ip + 12) >>> 0 : r[i]); a += 4; }
        if (W) r[rn] = nb;
      }
      return;
    }
    throw new CpuFault(`unsupported ARM 0x${w.toString(16)} at 0x${ip.toString(16)}`, this);
  }
  _rotImm(w) {
    const imm = w & 255, rot = ((w >> 8) & 15) * 2;
    return rot ? ((imm >>> rot) | (imm << (32 - rot))) >>> 0 : imm;
  }

  /* ------------------------------------------------------------------------------------------------ SWI */
  _swi(n, ip) {
    this.swiLog.set(n, (this.swiLog.get(n) || 0) + 1);
    if (this.swiHandler && this.swiHandler(this, n)) return;
    const r = this.r, mem = this.mem;
    switch (n) {
      case 0x06: { // Div
        const a = r[0] | 0, b = r[1] | 0;
        if (b === 0) throw new CpuFault('BIOS Div by zero', this);
        const q = (a / b) | 0, m = (a % b) | 0;
        r[0] = q >>> 0; r[1] = m >>> 0; r[3] = Math.abs(q) >>> 0; return;
      }
      case 0x07: { // DivArm
        const a = r[1] | 0, b = r[0] | 0;
        if (b === 0) throw new CpuFault('BIOS DivArm by zero', this);
        const q = (a / b) | 0, m = (a % b) | 0;
        r[0] = q >>> 0; r[1] = m >>> 0; r[3] = Math.abs(q) >>> 0; return;
      }
      case 0x08: { // Sqrt
        const v = r[0] >>> 0; let s = Math.floor(Math.sqrt(v));
        while (s * s > v) s--; while ((s + 1) * (s + 1) <= v) s++;
        r[0] = s >>> 0; return;
      }
      case 0x09: r[0] = biosArcTan(r[0]) >>> 0; return;
      case 0x0a: r[0] = biosArcTan2(r[0], r[1]) >>> 0; return;
      case 0x0b: { // CpuSet
        let src = r[0] >>> 0, dst = r[1] >>> 0; const ctl = r[2] >>> 0, cnt = ctl & 0x1fffff, fill = (ctl >> 24) & 1, w32 = (ctl >> 26) & 1;
        if (w32) { src &= ~3; dst &= ~3; const fv = fill ? mem.read32(src) : 0; for (let i = 0; i < cnt; i++) { mem.write32(dst, fill ? fv : mem.read32(src)); if (!fill) src += 4; dst += 4; } }
        else { src &= ~1; dst &= ~1; const fv = fill ? mem.read16(src) : 0; for (let i = 0; i < cnt; i++) { mem.write16(dst, fill ? fv : mem.read16(src)); if (!fill) src += 2; dst += 2; } }
        return;
      }
      case 0x0c: { // CpuFastSet (words, count rounded up to 8)
        let src = (r[0] & ~3) >>> 0, dst = (r[1] & ~3) >>> 0; const ctl = r[2] >>> 0, fill = (ctl >> 24) & 1;
        let cnt = ctl & 0x1fffff; cnt = (cnt + 7) & ~7;
        const fv = fill ? mem.read32(src) : 0;
        for (let i = 0; i < cnt; i++) { mem.write32(dst, fill ? fv : mem.read32(src)); if (!fill) src += 4; dst += 4; }
        return;
      }
      case 0x0e: this._bgAffineSet(); return;
      case 0x0f: this._objAffineSet(); return;
      case 0x11: case 0x12: this._lz77(r[0] >>> 0, r[1] >>> 0, n === 0x12); return;
      case 0x14: case 0x15: this._rl(r[0] >>> 0, r[1] >>> 0, n === 0x15); return;
      case 0x13: this._huff(r[0] >>> 0, r[1] >>> 0); return;
      case 0x10: this._bitUnPack(r[0] >>> 0, r[1] >>> 0, r[2] >>> 0); return;
      case 0x01: case 0x02: case 0x04: case 0x05: case 0x03: return; // RamReset / Halt / IntrWait / VBlankWait: no-ops here
      default:
        this.unhandledSwi.add(n);
        throw new CpuFault(`unhandled SWI 0x${n.toString(16)} at 0x${ip.toString(16)}`, this);
    }
  }

  _objAffineSet() {
    const r = this.r, mem = this.mem;
    let src = r[0] >>> 0, dst = r[1] >>> 0; const n = r[2] >>> 0, stride = r[3] | 0;
    for (let i = 0; i < n; i++) {
      const sx = (mem.read16(src) << 16) >> 16, sy = (mem.read16(src + 2) << 16) >> 16, th = (mem.read16(src + 4) >> 8) & 255;
      src += 8;
      const s = BIOS_SIN[th], c = BIOS_SIN[(th + 64) & 255];
      // The reference BIOS (the real game, OR1 oracle) rounds each product toward ZERO, not down: (-74.31 -> -74, not -75). Measured on the foe's front-animation matrices (system animations).
      mem.write16(dst, Math.trunc((sx * c) / 16384));
      mem.write16(dst + stride, Math.trunc((-(sx * s)) / 16384));
      mem.write16(dst + 2 * stride, Math.trunc((sy * s) / 16384));
      mem.write16(dst + 3 * stride, Math.trunc((sy * c) / 16384));
      dst += 4 * stride;
    }
  }
  _bgAffineSet() {
    const r = this.r, mem = this.mem;
    let src = r[0] >>> 0, dst = r[1] >>> 0; const n = r[2] >>> 0;
    for (let i = 0; i < n; i++) {
      const ox = mem.read32(src) | 0, oy = mem.read32(src + 4) | 0;
      const cx = (mem.read16(src + 8) << 16) >> 16, cy = (mem.read16(src + 10) << 16) >> 16;
      const sx = (mem.read16(src + 12) << 16) >> 16, sy = (mem.read16(src + 14) << 16) >> 16, th = (mem.read16(src + 16) >> 8) & 255;
      src += 20;
      const s = BIOS_SIN[th], c = BIOS_SIN[(th + 64) & 255];
      const a = (c * sx) >> 14, b = (-(s * sx)) >> 14, cc = (s * sy) >> 14, d = (c * sy) >> 14;
      mem.write16(dst, a); mem.write16(dst + 2, b); mem.write16(dst + 4, cc); mem.write16(dst + 6, d);
      mem.write32(dst + 8, (ox - (a * cx + b * cy)) | 0);
      mem.write32(dst + 12, (oy - (cc * cx + d * cy)) | 0);
      dst += 16;
    }
  }
  _lz77(src, dst, vram) {
    const mem = this.mem;
    const hdr = mem.read32(src);
    if ((hdr & 0xf0) !== 0x10) throw new CpuFault(`LZ77 header 0x${hdr.toString(16)} at 0x${src.toString(16)}`, this);
    const size = hdr >>> 8;
    // fast path: the compressed stream sits in the cartridge (always, for the animation graphics)
    const inRom = (src >>> 24) >= 8 && (src >>> 24) <= 13;
    const rom = mem.rom, rb = inRom ? (src & mem.romMask) + 4 : 0;
    let ip = inRom ? rb : src + 4;
    const rd = inRom ? (i) => rom[i] : (i) => mem.read8(i);
    const out = new Uint8Array(size);
    let op = 0;
    while (op < size) {
      const flags = rd(ip++);
      for (let b = 7; b >= 0 && op < size; b--) {
        if (flags & (1 << b)) {
          const b1 = rd(ip++), b2 = rd(ip++);
          const len = (b1 >> 4) + 3, disp = (((b1 & 15) << 8) | b2) + 1;
          if (disp > op) throw new CpuFault('LZ77 displacement before start', this);
          for (let k = 0; k < len && op < size; k++) { out[op] = out[op - disp]; op++; }
        } else out[op++] = rd(ip++);
      }
    }
    if (vram) { for (let i = 0; i < size; i += 2) mem.write16(dst + i, out[i] | ((i + 1 < size ? out[i + 1] : 0) << 8)); }
    else for (let i = 0; i < size; i++) mem.write8(dst + i, out[i]);
  }
  _rl(src, dst, vram) {
    const mem = this.mem;
    const hdr = mem.read32(src); src += 4;
    const size = hdr >>> 8;
    const out = new Uint8Array(size);
    let op = 0;
    while (op < size) {
      const f = mem.read8(src++);
      const len = f & 0x7f;
      if (f & 0x80) { const v = mem.read8(src++); for (let i = 0; i < len + 3 && op < size; i++) out[op++] = v; }
      else for (let i = 0; i < len + 1 && op < size; i++) out[op++] = mem.read8(src++);
    }
    if (vram) { for (let i = 0; i < size; i += 2) mem.write16(dst + i, out[i] | ((i + 1 < size ? out[i + 1] : 0) << 8)); }
    else for (let i = 0; i < size; i++) mem.write8(dst + i, out[i]);
  }
  // BIOS BitUnPack (SWI 0x10): info = { u16 srcBytes, u8 srcWidth, u8 dstWidth, u32 offset | zeroFlag<<31 }; output in 32-bit units
  _bitUnPack(src, dst, info) {
    const mem = this.mem;
    const len = mem.read16(info), sw = mem.read8(info + 2), dw = mem.read8(info + 3);
    const off = mem.read32(info + 4), addOff = off & 0x7fffffff, zero = (off >>> 31) & 1;
    if (![1, 2, 4, 8].includes(sw) || ![1, 2, 4, 8, 16, 32].includes(dw)) throw new CpuFault(`BitUnPack widths ${sw}/${dw}`, this);
    const smask = (1 << sw) - 1;
    let acc = 0, accBits = 0;
    for (let i = 0; i < len; i++) {
      const b = mem.read8(src + i);
      for (let k = 0; k < 8; k += sw) {
        let v = (b >> k) & smask;
        if (v !== 0 || zero) v = (v + addOff) >>> 0;
        acc = (acc | (dw === 32 ? v : (v << accBits))) >>> 0;
        accBits += dw;
        if (accBits >= 32) { mem.write32(dst, acc); dst += 4; acc = 0; accBits = 0; }
      }
    }
  }
  _huff(src, dst) {
    const mem = this.mem;
    const hdr = mem.read32(src); src += 4;
    const bits = hdr & 15, size = hdr >>> 8;
    const treeSize = (mem.read8(src) + 1) * 2;
    const tree = src;
    let sp = src + treeSize;
    const out = new Uint8Array(size);
    let op = 0, acc = 0, accBits = 0; const per = 8 / bits;
    let word = 0, wordBits = 0;
    while (op < size) {
      let node = tree + 1;
      while (true) {
        if (wordBits === 0) { word = mem.read32(sp); sp += 4; wordBits = 32; }
        const bit = (word >>> 31) & 1; word = (word << 1) >>> 0; wordBits--;
        const nb = mem.read8(node);
        const child = (node & ~1) + (nb & 0x3f) * 2 + 2 + bit;
        if (nb & (bit ? 0x40 : 0x80)) { acc |= mem.read8(child) << accBits; node = -1; accBits += bits; break; }
        node = child;
      }
      if (accBits >= 8 || bits === 8) { out[op++] = acc & 255; acc = 0; accBits = 0; }
      if (per < 1) break;
    }
    for (let i = 0; i < size; i += 4) mem.write32(dst + i, out[i] | (out[i + 1] << 8) | (out[i + 2] << 16) | (out[i + 3] << 24));
  }
}

export const RETURN_SENTINEL = RET_MAGIC;

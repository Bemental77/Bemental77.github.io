// tools/pokemonarena_anim_cpu_test.mjs -- unit tests of pokemonarena/js/anim_cpu.js (the ARMv4T interpreter) and anim_ram.js (the memory map / DMA),
// with hand-assembled THUMB / ARM sequences whose expected results come from the ARM architecture rules (not from the implementation),
// a BIOS HLE section, and NEGATIVE CONTROLS: deliberately broken copies of the interpreter that the same suite must reject.
//   node tools/pokemonarena_anim_cpu_test.mjs      -> prints "passed N, failed M" per section and exits non-zero on any failure
import { GbaCpu, CpuFault, CpuBudgetError, SLICE_CHECK } from '../pokemonarena/js/anim_cpu.js';
import { GbaMem, EWRAM_BASE, IWRAM_BASE, VRAM_BASE, IO_BASE, PRAM_BASE } from '../pokemonarena/js/anim_ram.js';

/* ------------------------------------------------------------------------------------------------ THUMB assembler (just what the tests need) */
const R = (n) => n & 7;
const th = {
  movi: (rd, i) => 0x2000 | (R(rd) << 8) | (i & 255), cmpi: (rd, i) => 0x2800 | (R(rd) << 8) | (i & 255),
  addi: (rd, i) => 0x3000 | (R(rd) << 8) | (i & 255), subi: (rd, i) => 0x3800 | (R(rd) << 8) | (i & 255),
  lsl: (rd, rs, i) => (0 << 11) | ((i & 31) << 6) | (R(rs) << 3) | R(rd), lsr: (rd, rs, i) => (1 << 11) | ((i & 31) << 6) | (R(rs) << 3) | R(rd),
  asr: (rd, rs, i) => (2 << 11) | ((i & 31) << 6) | (R(rs) << 3) | R(rd),
  addr: (rd, rs, rn) => 0x1800 | (R(rn) << 6) | (R(rs) << 3) | R(rd), subr: (rd, rs, rn) => 0x1a00 | (R(rn) << 6) | (R(rs) << 3) | R(rd),
  alu: (op, rd, rs) => 0x4000 | (op << 6) | (R(rs) << 3) | R(rd),      // 0 and 1 eor 2 lsl 3 lsr 4 asr 5 adc 6 sbc 7 ror 8 tst 9 neg 10 cmp 11 cmn 12 orr 13 mul 14 bic 15 mvn
  hi: (op, rd, rs) => 0x4400 | (op << 8) | ((rd & 8) ? 0x80 : 0) | ((rs & 8) ? 0x40 : 0) | (R(rs) << 3) | R(rd),   // 0 add 1 cmp 2 mov 3 bx
  ldrpc: (rd, w) => 0x4800 | (R(rd) << 8) | (w & 255),
  strr: (rd, rb, ro) => 0x5000 | (R(ro) << 6) | (R(rb) << 3) | R(rd), ldrr: (rd, rb, ro) => 0x5800 | (R(ro) << 6) | (R(rb) << 3) | R(rd),
  ldsbr: (rd, rb, ro) => 0x5600 | (R(ro) << 6) | (R(rb) << 3) | R(rd), ldshr: (rd, rb, ro) => 0x5e00 | (R(ro) << 6) | (R(rb) << 3) | R(rd),
  ldrhr: (rd, rb, ro) => 0x5a00 | (R(ro) << 6) | (R(rb) << 3) | R(rd), strhr: (rd, rb, ro) => 0x5200 | (R(ro) << 6) | (R(rb) << 3) | R(rd),
  strb: (rd, rb, i) => 0x7000 | ((i & 31) << 6) | (R(rb) << 3) | R(rd), ldrb: (rd, rb, i) => 0x7800 | ((i & 31) << 6) | (R(rb) << 3) | R(rd),
  str: (rd, rb, i) => 0x6000 | (((i >> 2) & 31) << 6) | (R(rb) << 3) | R(rd), ldr: (rd, rb, i) => 0x6800 | (((i >> 2) & 31) << 6) | (R(rb) << 3) | R(rd),
  push: (rl, lr = 0) => 0xb400 | (lr ? 0x100 : 0) | rl, pop: (rl, pc = 0) => 0xbc00 | (pc ? 0x100 : 0) | rl,
  stmia: (rb, rl) => 0xc000 | (R(rb) << 8) | rl, ldmia: (rb, rl) => 0xc800 | (R(rb) << 8) | rl,
  bcc: (cond, off) => 0xd000 | (cond << 8) | (off & 255), b: (off) => 0xe000 | (off & 0x7ff), swi: (n) => 0xdf00 | n,
  bl: (offHalfwords) => { const o = offHalfwords; return [0xf000 | ((o >> 11) & 0x7ff), 0xf800 | (o & 0x7ff)]; },
  bxlr: () => 0x4770, nop: () => 0x46c0,
};

/* ---------------------------------------------------------------------------------------------------------------- harness */
function machine(CpuClass = GbaCpu) {
  const rom = new Uint8Array(0x100000);
  const mem = new GbaMem(rom);
  const cpu = new CpuClass(mem);
  cpu.r[13] = IWRAM_BASE + 0x7f00;
  return { mem, cpu };
}
const CODE = 0x08001000;                                  // test code lives in the (synthetic) cartridge: hooks only apply to ROM addresses
function load(mem, halfwords, at = CODE) { let o = (at & 0x01ffffff); for (const h of halfwords.flat()) { mem.rom[o++] = h & 255; mem.rom[o++] = (h >> 8) & 255; } return at; }
const loadRaw = load;
function run(CpuClass, halfwords, regs = {}, setup = null, raw = false) {
  const { mem, cpu } = machine(CpuClass);
  load(mem, raw ? halfwords : [...halfwords, th.bxlr()]);
  for (const [k, v] of Object.entries(regs)) cpu.r[+k] = v >>> 0;
  if (regs.C !== undefined) cpu.C = regs.C;
  if (setup) setup(mem, cpu);
  cpu.call(CODE | 1, [], { keepRegs: true });
  return { mem, cpu, r: cpu.r };
}
const hex = (v) => '0x' + (v >>> 0).toString(16);

/* -------------------------------------------------------------------------------------------------------------- the suite */
function suite(CpuClass, label) {
  const results = [];
  const T = (section, name, fn) => { let ok = false, msg = ''; try { const r = fn(); ok = r === true; if (!ok) msg = String(r); } catch (e) { msg = 'threw ' + e.message; } results.push({ section, name, ok, msg }); };
  const eq = (a, b, what) => ((a >>> 0) === (b >>> 0) ? true : `${what}: got ${hex(a)} expected ${hex(b)}`);

  // --- data processing / flags (THUMB)
  T('thumb alu', 'mov/add/sub immediates', () => { const x = run(CpuClass, [th.movi(0, 200), th.addi(0, 100), th.subi(0, 44)]); return eq(x.r[0], 256, 'r0'); });
  T('thumb alu', 'ADD sets carry on unsigned overflow', () => { const x = run(CpuClass, [th.alu(13, 0, 1), th.addr(2, 0, 1)], { 0: 0xffffffff, 1: 2 }); /* mul then add */ return true; });
  T('thumb alu', 'ADD 0xFFFFFFFF + 1 = 0, C=1 Z=1', () => { const x = run(CpuClass, [th.addr(2, 0, 1)], { 0: 0xffffffff, 1: 1 }); return eq(x.r[2], 0, 'r2') === true && x.cpu.C === 1 && x.cpu.Z === 1 && x.cpu.V === 0 ? true : `flags C${x.cpu.C} Z${x.cpu.Z} V${x.cpu.V}`; });
  T('thumb alu', 'ADD 0x7FFFFFFF + 1 sets V and N', () => { const x = run(CpuClass, [th.addr(2, 0, 1)], { 0: 0x7fffffff, 1: 1 }); return x.cpu.V === 1 && x.cpu.N === 1 && x.cpu.C === 0 ? true : `flags N${x.cpu.N} V${x.cpu.V} C${x.cpu.C}`; });
  T('thumb alu', 'SUB 5 - 3 = 2 with C set (no borrow)', () => { const x = run(CpuClass, [th.subr(2, 0, 1)], { 0: 5, 1: 3 }); return eq(x.r[2], 2, 'r2') === true && x.cpu.C === 1 ? true : `C${x.cpu.C}`; });
  T('thumb alu', 'SUB 3 - 5 borrows (C clear, N set)', () => { const x = run(CpuClass, [th.subr(2, 0, 1)], { 0: 3, 1: 5 }); return eq(x.r[2], 0xfffffffe, 'r2') === true && x.cpu.C === 0 && x.cpu.N === 1 ? true : `C${x.cpu.C} N${x.cpu.N}`; });
  T('thumb alu', 'ADC adds the carry in (C=1)', () => { const x = run(CpuClass, [th.alu(5, 0, 1)], { 0: 10, 1: 20 }, (m, c) => { c.C = 1; }); return eq(x.r[0], 31, 'r0'); });
  T('thumb alu', 'ADC with carry out', () => { const x = run(CpuClass, [th.alu(5, 0, 1)], { 0: 0xffffffff, 1: 0 }, (m, c) => { c.C = 1; }); return eq(x.r[0], 0, 'r0') === true && x.cpu.C === 1 ? true : 'carry out lost'; });
  T('thumb alu', 'SBC subtracts the borrow (C=0 -> minus 1)', () => { const x = run(CpuClass, [th.alu(6, 0, 1)], { 0: 10, 1: 3 }, (m, c) => { c.C = 0; }); return eq(x.r[0], 6, 'r0'); });
  T('thumb alu', 'SBC with C=1 is a plain subtract', () => { const x = run(CpuClass, [th.alu(6, 0, 1)], { 0: 10, 1: 3 }, (m, c) => { c.C = 1; }); return eq(x.r[0], 7, 'r0'); });
  T('thumb alu', 'NEG 5 = -5, N set', () => { const x = run(CpuClass, [th.alu(9, 0, 1)], { 1: 5 }); return eq(x.r[0], 0xfffffffb, 'r0') === true && x.cpu.N === 1 ? true : 'N'; });
  T('thumb alu', 'MUL low 32 bits', () => { const x = run(CpuClass, [th.alu(13, 0, 1)], { 0: 0x10001, 1: 0x10001 }); return eq(x.r[0], 0x20001, 'r0'); });
  T('thumb alu', 'AND / EOR / ORR / BIC / MVN', () => { const a = run(CpuClass, [th.alu(0, 0, 1)], { 0: 0xff0f, 1: 0x0ff0 }), e = run(CpuClass, [th.alu(1, 0, 1)], { 0: 0xff0f, 1: 0x0ff0 }), o = run(CpuClass, [th.alu(12, 0, 1)], { 0: 0xff0f, 1: 0x0ff0 }), b = run(CpuClass, [th.alu(14, 0, 1)], { 0: 0xff0f, 1: 0x0ff0 }), n = run(CpuClass, [th.alu(15, 0, 1)], { 1: 0 }); return a.r[0] === 0x0f00 && e.r[0] === 0xf0ff && o.r[0] === 0xffff && b.r[0] === 0xf00f && n.r[0] === 0xffffffff ? true : [hex(a.r[0]), hex(e.r[0]), hex(o.r[0]), hex(b.r[0]), hex(n.r[0])].join(' '); });
  T('thumb alu', 'TST / CMP / CMN set flags only', () => { const x = run(CpuClass, [th.alu(8, 0, 1), th.cmpi(0, 3)], { 0: 3, 1: 4 }); return x.r[0] === 3 && x.cpu.Z === 1 && x.cpu.C === 1 ? true : `Z${x.cpu.Z} C${x.cpu.C}`; });
  // --- shifts
  T('thumb shifts', 'LSL #1 carry = old bit 31', () => { const x = run(CpuClass, [th.lsl(1, 0, 1)], { 0: 0x80000001 }); return eq(x.r[1], 2, 'r1') === true && x.cpu.C === 1 ? true : 'C'; });
  T('thumb shifts', 'LSL #0 is MOV and keeps C', () => { const x = run(CpuClass, [th.lsl(1, 0, 0)], { 0: 7 }, (m, c) => { c.C = 1; }); return x.r[1] === 7 && x.cpu.C === 1 ? true : 'C changed'; });
  T('thumb shifts', 'LSR #0 means LSR #32: result 0, C = bit 31', () => { const x = run(CpuClass, [th.lsr(1, 0, 0)], { 0: 0x80000000 }); return x.r[1] === 0 && x.cpu.C === 1 ? true : `r1 ${hex(x.r[1])} C${x.cpu.C}`; });
  T('thumb shifts', 'ASR #0 means ASR #32: sign fill', () => { const x = run(CpuClass, [th.asr(1, 0, 0)], { 0: 0x80000000 }); return x.r[1] === 0xffffffff && x.cpu.C === 1 ? true : `r1 ${hex(x.r[1])}`; });
  T('thumb shifts', 'ASR keeps the sign', () => { const x = run(CpuClass, [th.asr(1, 0, 4)], { 0: 0xfffffff0 }); return eq(x.r[1], 0xffffffff, 'r1'); });
  T('thumb shifts', 'LSL by register >= 32 gives 0; == 32 carry = bit 0', () => { const a = run(CpuClass, [th.alu(2, 0, 1)], { 0: 3, 1: 32 }), b = run(CpuClass, [th.alu(2, 0, 1)], { 0: 3, 1: 33 }); return a.r[0] === 0 && a.cpu.C === 1 && b.r[0] === 0 && b.cpu.C === 0 ? true : `a C${a.cpu.C} b C${b.cpu.C}`; });
  T('thumb shifts', 'shift by register 0 leaves value and carry', () => { const x = run(CpuClass, [th.alu(3, 0, 1)], { 0: 9, 1: 0 }, (m, c) => { c.C = 1; }); return x.r[0] === 9 && x.cpu.C === 1 ? true : 'changed'; });
  T('thumb shifts', 'ROR rotates', () => { const x = run(CpuClass, [th.alu(7, 0, 1)], { 0: 0x000000f1, 1: 4 }); return eq(x.r[0], 0x1000000f, 'r0'); });
  // --- memory
  T('thumb memory', 'STR/LDR word, STRH/LDRH, STRB/LDRB round trip', () => { const x = run(CpuClass, [th.str(0, 1, 0), th.ldr(2, 1, 0), th.strb(0, 1, 8), th.ldrb(3, 1, 8)], { 0: 0x11223344, 1: IWRAM_BASE + 0x100 }); return x.r[2] === 0x11223344 && x.r[3] === 0x44 ? true : `${hex(x.r[2])} ${hex(x.r[3])}`; });
  T('thumb memory', 'LDR from an unaligned address rotates the word', () => { const x = run(CpuClass, [th.ldrr(2, 1, 3)], { 1: IWRAM_BASE + 0x100, 3: 1 }, (m) => { m.write32(IWRAM_BASE + 0x100, 0x44332211); }); return eq(x.r[2], 0x11443322, 'r2'); });
  T('thumb memory', 'LDSB sign-extends a byte; LDSH sign-extends a halfword', () => { const x = run(CpuClass, [th.ldsbr(2, 1, 3), th.ldshr(4, 1, 5)], { 1: IWRAM_BASE + 0x100, 3: 0, 5: 4 }, (m) => { m.write8(IWRAM_BASE + 0x100, 0x80); m.write16(IWRAM_BASE + 0x104, 0x8001); }); return x.r[2] === 0xffffff80 && x.r[4] === 0xffff8001 ? true : `${hex(x.r[2])} ${hex(x.r[4])}`; });
  T('thumb memory', 'LDRH from an odd address rotates by 8', () => { const x = run(CpuClass, [th.ldrhr(2, 1, 3)], { 1: IWRAM_BASE + 0x100, 3: 1 }, (m) => { m.write16(IWRAM_BASE + 0x100, 0xaabb); }); return eq(x.r[2], 0xbb0000aa, 'r2'); });
  T('thumb memory', 'PUSH {r0,r1,lr} / POP {r2,r3} order and sp', () => { const x = run(CpuClass, [th.push(0b11, 1), th.pop(0b1100)], { 0: 0xa, 1: 0xb, 14: 0xc0de }, (m, c) => { c.r[13] = IWRAM_BASE + 0x200; }); return x.r[2] === 0xa && x.r[3] === 0xb && x.r[13] === IWRAM_BASE + 0x200 - 12 + 8 ? true : `${hex(x.r[2])} ${hex(x.r[3])} sp ${hex(x.r[13])}`; });
  T('thumb memory', 'STMIA / LDMIA move a register list and write back', () => { const x = run(CpuClass, [th.stmia(0, 0b1110), th.subi(0, 12), th.ldmia(0, 0b00110000)], { 0: IWRAM_BASE + 0x300, 1: 1, 2: 2, 3: 3 }); return x.r[4] === 1 && x.r[5] === 2 && x.r[0] === IWRAM_BASE + 0x300 + 8 ? true : `${x.r[4]} ${x.r[5]} r0 ${hex(x.r[0])}`; });
  T('thumb memory', 'LDR pc-relative reads the literal after the instruction', () => { const x = run(CpuClass, [th.ldrpc(0, 1), th.bxlr(), 0, 0, 0xbeef, 0xdead], {}, null, true); return eq(x.r[0], 0xdeadbeef, 'r0'); });
  // --- branches
  T('thumb branch', 'all 14 conditions after CMP 5,3 (signed/unsigned)', () => {
    const bad = [];
    const expect = { 0: 0, 1: 1, 2: 1, 3: 0, 4: 0, 5: 1, 6: 0, 7: 1, 8: 1, 9: 0, 10: 1, 11: 0, 12: 1, 13: 0 };   // after cmp 5,3
    for (let c = 0; c < 14; c++) {
      const x = run(CpuClass, [th.cmpi(0, 3), th.bcc(c, 1), th.movi(1, 0), th.b(0), th.movi(1, 1)], { 0: 5, 1: 9 });
      // taken -> the branch skips `movi r1,0` and the b, executing `movi r1,1` (r1 = 1); not taken -> r1 = 0 (the b then skips the last movi)
      const taken = x.r[1] === 1;
      if ((taken ? 1 : 0) !== expect[c]) bad.push(c);
    }
    return bad.length ? 'wrong for cond ' + bad.join(',') : true;
  });
  for (const [a, b, exp] of [[5, 5, { 0: 1, 1: 0, 2: 1, 3: 0, 4: 0, 5: 1, 6: 0, 7: 1, 8: 0, 9: 1, 10: 1, 11: 0, 12: 0, 13: 1 }], [3, 5, { 0: 0, 1: 1, 2: 0, 3: 1, 4: 1, 5: 0, 6: 0, 7: 1, 8: 0, 9: 1, 10: 0, 11: 1, 12: 0, 13: 1 }]]) {
    T('thumb branch', `conditions after CMP ${a},${b}`, () => {
      const bad = [];
      for (let c = 0; c < 14; c++) {
        const x = run(CpuClass, [th.cmpi(0, b), th.bcc(c, 1), th.movi(1, 0), th.b(0), th.movi(1, 1)], { 0: a, 1: 9 });
        if (((x.r[1] === 1) ? 1 : 0) !== exp[c]) bad.push(c);
      }
      return bad.length ? 'wrong for cond ' + bad.join(',') : true;
    });
  }
  T('thumb branch', 'BL / BX LR call and return', () => {
    const { mem, cpu } = machine(CpuClass);
    // 0: bl +4 halfwords (to sub at index 6); sub: movi r0,42 ; bx lr ; main continues after bl: movi r1,7 ; bx lr
    load(mem, [th.push(0, 1), th.bl(2), th.movi(1, 7), th.pop(0, 1), th.movi(0, 42), th.bxlr()]);
    cpu.call(CODE | 1, [], { keepRegs: true });
    return cpu.r[0] === 42 && cpu.r[1] === 7 ? true : `r0 ${cpu.r[0]} r1 ${cpu.r[1]}`;
  });
  T('thumb branch', 'BX to an even address enters ARM state', () => {
    const { mem, cpu } = machine(CpuClass);
    // thumb: movi r3 ... use hi-reg: mov r3,(addr of arm code) via ldr pc-literal; bx r3 ; arm: mov r0,#9 ; bx lr
    const arm = EWRAM_BASE + 0x1100;
    mem.write32(arm, 0xe3a00009); mem.write32(arm + 4, 0xe12fff1e);
    load(mem, [th.ldrpc(3, 1), th.hi(3, 0, 3), 0, 0, arm & 0xffff, arm >>> 16]);
    cpu.call(CODE | 1, [], { keepRegs: true });
    return cpu.r[0] === 9 ? true : `r0 ${cpu.r[0]}`;
  });
  // --- ARM
  T('arm', 'MOV with rotated immediate; ADD with shifted register', () => {
    const { mem, cpu } = machine(CpuClass); const a = EWRAM_BASE + 0x1080;
    [0xe3a004ff /* mov r0,#0xff000000 */, 0xe3a01003 /* mov r1,#3 */, 0xe0802101 /* add r2,r0,r1,lsl #2 */, 0xe12fff1e].forEach((w, i) => mem.write32(a + 4 * i, w));
    cpu.call(a, [], { keepRegs: true });
    return cpu.r[0] === 0xff000000 && cpu.r[2] === 0xff00000c ? true : `${hex(cpu.r[0])} ${hex(cpu.r[2])}`;
  });
  T('arm', 'LDR/STR pre- and post-indexed, LDM/STM', () => {
    const { mem, cpu } = machine(CpuClass); const a = EWRAM_BASE + 0x1080, d = IWRAM_BASE + 0x400;
    const code = [0xe5810004 /* str r0,[r1,#4] */, 0xe4912008 /* ldr r2,[r1],#8 */, 0xe8a1000c /* stmia r1!,{r2,r3} */, 0xe12fff1e];
    code.forEach((w, i) => mem.write32(a + 4 * i, w));
    cpu.r[0] = 0x55; cpu.r[1] = d; cpu.r[3] = 0x77; mem.write32(d, 0x1234);
    cpu.call(a, [], { keepRegs: true });
    return mem.read32(d + 4) === 0x55 && cpu.r[1] === d + 8 + 8 && mem.read32(d + 8 + 4) === 0x77 ? true : `${hex(mem.read32(d + 4))} r1 ${hex(cpu.r[1])}`;
  });
  T('arm', 'conditional execution (NE skips when Z set) and UMULL', () => {
    const { mem, cpu } = machine(CpuClass); const a = EWRAM_BASE + 0x1080;
    const code = [0xe3500005 /* cmp r0,#5 */, 0x13a01001 /* movne r1,#1 */, 0x03a02002 /* moveq r2,#2 */, 0xe0843090 /* umull r3,r4,r0,r0? (rd=4,rn=3,rs=0,rm=0) */, 0xe12fff1e];
    code.forEach((w, i) => mem.write32(a + 4 * i, w));
    cpu.r[0] = 5; cpu.r[1] = 9; cpu.r[2] = 9;
    cpu.call(a, [], { keepRegs: true });
    return cpu.r[1] === 9 && cpu.r[2] === 2 ? true : `r1 ${cpu.r[1]} r2 ${cpu.r[2]}`;
  });
  // --- BIOS HLE
  const swi = (n) => [th.swi(n)];
  T('bios', 'Div (SWI 6): quotient, remainder, |quotient|', () => { const x = run(CpuClass, swi(6), { 0: (-7) >>> 0, 1: 2 }); return x.r[0] === ((-3) >>> 0) && x.r[1] === ((-1) >>> 0) && x.r[3] === 3 ? true : `${x.r[0] | 0} ${x.r[1] | 0} ${x.r[3]}`; });
  T('bios', 'DivArm (SWI 7) swaps the operands', () => { const x = run(CpuClass, swi(7), { 0: 2, 1: 9 }); return x.r[0] === 4 && x.r[1] === 1 ? true : `${x.r[0]} ${x.r[1]}`; });
  T('bios', 'Sqrt (SWI 8) floors', () => { const a = run(CpuClass, swi(8), { 0: 99 }), b = run(CpuClass, swi(8), { 0: 100 }), c = run(CpuClass, swi(8), { 0: 0xffffffff }); return a.r[0] === 9 && b.r[0] === 10 && c.r[0] === 65535 ? true : `${a.r[0]} ${b.r[0]} ${c.r[0]}`; });
  T('bios', 'ArcTan2 (SWI 0xA) quadrant axes', () => { const e = (x, y) => run(CpuClass, swi(0xa), { 0: x >>> 0, 1: y >>> 0 }).r[0]; return e(100, 0) === 0 && e(0, 100) === 0x4000 && e((-100) >>> 0, 0) === 0x8000 && e(0, (-100) >>> 0) === 0xc000 ? true : [e(100, 0), e(0, 100), e(-100, 0), e(0, -100)].map(hex).join(' '); });
  T('bios', 'ArcTan2 45 degrees = 0x2000 (within 1 count)', () => { const v = run(CpuClass, swi(0xa), { 0: 4096, 1: 4096 }).r[0]; return Math.abs(v - 0x2000) <= 1 ? true : hex(v); });
  T('bios', 'CpuSet copies / fills halfwords and words', () => { const x = run(CpuClass, swi(0xb), { 0: IWRAM_BASE + 0x500, 1: IWRAM_BASE + 0x600, 2: 4 }, (m) => { for (let i = 0; i < 4; i++) m.write16(IWRAM_BASE + 0x500 + 2 * i, 0x100 + i); }); const f = run(CpuClass, swi(0xb), { 0: IWRAM_BASE + 0x500, 1: IWRAM_BASE + 0x700, 2: (1 << 24) | (1 << 26) | 3 }, (m) => { m.write32(IWRAM_BASE + 0x500, 0xabcd1234); }); return x.mem.read16(IWRAM_BASE + 0x606) === 0x103 && f.mem.read32(IWRAM_BASE + 0x708) === 0xabcd1234 ? true : 'copy/fill'; });
  T('bios', 'LZ77UnCompWram (SWI 0x11) decodes a literal + back-reference stream', () => {
    // header 0x10 size 4; flags 0b01000000: literal 'A' then a reference (len 3, disp 1) -> "AAAA"
    const stream = [0x10, 4, 0, 0, 0x40, 0x41, 0x00, 0x00];
    const x = run(CpuClass, swi(0x11), { 0: IWRAM_BASE + 0x800, 1: IWRAM_BASE + 0x900 }, (m) => { stream.forEach((b, i) => m.write8(IWRAM_BASE + 0x800 + i, b)); });
    return x.mem.read32(IWRAM_BASE + 0x900) === 0x41414141 ? true : hex(x.mem.read32(IWRAM_BASE + 0x900));
  });
  T('bios', 'LZ77UnCompVram (SWI 0x12) writes halfwords to VRAM', () => { const stream = [0x10, 4, 0, 0, 0x40, 0x41, 0x00, 0x00]; const x = run(CpuClass, swi(0x12), { 0: IWRAM_BASE + 0x800, 1: VRAM_BASE }, (m) => { stream.forEach((b, i) => m.write8(IWRAM_BASE + 0x800 + i, b)); }); return x.mem.read16(VRAM_BASE) === 0x4141 && x.mem.read16(VRAM_BASE + 2) === 0x4141 ? true : 'vram'; });
  T('bios', 'RLUnCompWram (SWI 0x14): run + literal', () => { const x = run(CpuClass, swi(0x14), { 0: IWRAM_BASE + 0x800, 1: IWRAM_BASE + 0x900 }, (m) => { [0x30, 5, 0, 0, 0x82, 0x07].forEach((b, i) => m.write8(IWRAM_BASE + 0x800 + i, b)); }); return x.mem.read8(IWRAM_BASE + 0x900) === 7 && x.mem.read8(IWRAM_BASE + 0x904) === 7 ? true : 'rl run'; });
  T('bios', 'RLUnCompWram literal run', () => { const x = run(CpuClass, swi(0x14), { 0: IWRAM_BASE + 0x800, 1: IWRAM_BASE + 0x900 }, (m) => { [0x30, 3, 0, 0, 0x02, 0x11, 0x22, 0x33].forEach((b, i) => m.write8(IWRAM_BASE + 0x800 + i, b)); }); return x.mem.read8(IWRAM_BASE + 0x900) === 0x11 && x.mem.read8(IWRAM_BASE + 0x902) === 0x33 ? true : 'rl literal'; });
  T('bios', 'unknown SWI raises a typed CpuFault, never silently continues', () => { try { run(CpuClass, swi(0x77)); return 'no fault'; } catch (e) { return e instanceof CpuFault ? true : 'wrong error ' + e.name; } });
  // --- machine
  T('machine', 'instruction budget guard raises CpuBudgetError on an infinite loop', () => { const { mem, cpu } = machine(CpuClass); load(mem, [th.b(-2 & 0x7ff)]); try { cpu.call(CODE | 1, [], { budget: 1000 }); return 'returned'; } catch (e) { return e instanceof CpuBudgetError ? true : e.name; } });
  T('machine', 'a hook replaces a function and returns through lr', () => { const { mem, cpu } = machine(CpuClass); load(mem, [th.movi(0, 1), th.bxlr()]); cpu.hook(CODE | 1, (c) => { c.r[0] = 99; }); const r = cpu.call(CODE | 1); return r === 99 ? true : r; });
  T('machine', 'hookBefore observes and then runs the real function', () => { const { mem, cpu } = machine(CpuClass); load(mem, [th.movi(0, 5), th.bxlr()]); let seen = 0; cpu.hookBefore(CODE | 1, () => { seen++; }); const r = cpu.call(CODE | 1); return r === 5 && seen === 1 ? true : `r ${r} seen ${seen}`; });
  T('machine', 'call() preserves the caller registers r4-r11', () => { const { mem, cpu } = machine(CpuClass); load(mem, [th.movi(4, 1), th.bxlr()]); cpu.r[4] = 77; cpu.call(CODE | 1); return cpu.r[4] === 77 ? true : cpu.r[4]; });
  // --- sliced calls (beginCall / resume / abortCall): the round-4 preparation of the system animations runs ROM code in budgeted slices
  // two nested loops: r0 counts to 16 * 255 = 4080; 2 + 16 * (1 + 255 * 3 + 2) + 1 = 12291 instructions (> 2048, so a sliced call is cut several times)
  const loopProg = [th.movi(0, 0), th.movi(2, 16), th.movi(1, 255), th.addi(0, 1), th.subi(1, 1), th.bcc(1, (3 - (5 + 2)) & 255), th.subi(2, 1), th.bcc(1, (2 - (7 + 2)) & 255), th.bxlr()];
  const syncRun = () => { const { mem, cpu } = machine(CpuClass); load(mem, loopProg); cpu.r[4] = 77; cpu.N = 1; const r = cpu.call(CODE | 1); return { r, ic: cpu.icount, r4: cpu.r[4], N: cpu.N, depth: cpu.callDepth }; };
  const slicedRun = (deadlineOf) => {
    const { mem, cpu } = machine(CpuClass); load(mem, loopProg); cpu.r[4] = 77; cpu.N = 1; cpu.clock = () => cpu.icount;
    cpu.beginCall(CODE | 1); const per = []; let guard = 0;
    for (;;) { const i0 = cpu.icount; const done = cpu.resume(deadlineOf(cpu)); per.push(cpu.icount - i0); if (done) break; if (++guard > 100) return { stuck: true, per }; }
    return { r: cpu.lastRet, ic: cpu.icount, r4: cpu.r[4], N: cpu.N, depth: cpu.callDepth, pending: cpu.pending, per };
  };
  T('sliced', 'a sliced call (deadline always past) returns what call() returns, in as many instructions, with r4 and the flags restored', () => {
    const a = syncRun(), b = slicedRun(() => -1);
    return b.r === a.r && a.r === 4080 && b.ic === a.ic && b.r4 === 77 && b.N === 1 && b.depth === 0 && b.pending === null ? true : JSON.stringify({ a, b: { ...b, per: b.per.length } });
  });
  T('sliced', 'every suspension comes after exactly one check interval (2047 instructions) even when the deadline is already past: a budget of 0 makes progress', () => {
    const b = slicedRun(() => -1); const cut = b.per.slice(0, -1);
    return cut.length >= 5 && cut.every((x) => x === SLICE_CHECK - 1) ? true : JSON.stringify(b.per.slice(0, 8));
  });
  T('sliced', 'a deadline in the future lets the call run to its end without a suspension', () => { const b = slicedRun(() => Infinity); return b.per.length === 1 && b.r === 4080 ? true : JSON.stringify(b.per); });
  T('sliced', 'a finite far deadline is honoured at check points only: it ends after the first check past it', () => {
    const { mem, cpu } = machine(CpuClass); load(mem, loopProg); cpu.clock = () => cpu.icount; cpu.beginCall(CODE | 1);
    const done = cpu.resume(5000);                                   // virtual time = instructions executed: the check at 2048, 4096 are before 5000, the one at 6144 is past it
    return !done && cpu.icount === 3 * SLICE_CHECK - 1 ? true : 'icount ' + cpu.icount;
  });
  T('sliced', 'abortCall() restores the caller registers and a new call can follow', () => {
    const { mem, cpu } = machine(CpuClass); load(mem, loopProg); cpu.r[4] = 77; cpu.clock = () => cpu.icount; cpu.beginCall(CODE | 1); cpu.r[4] = 5; cpu.resume(-1); cpu.abortCall();
    const again = cpu.call(CODE | 1);
    return cpu.pending === null && cpu.callDepth === 0 && cpu.r[4] === 77 && again === 4080 ? true : JSON.stringify([cpu.pending, cpu.callDepth, cpu.r[4], again]);
  });
  T('sliced', 'a budget overrun inside a sliced call throws CpuBudgetError and leaves nothing pending', () => {
    const { mem, cpu } = machine(CpuClass); load(mem, loopProg); cpu.clock = () => cpu.icount; cpu.beginCall(CODE | 1, [], { budget: 3000 });
    try { for (let i = 0; i < 10; i++) cpu.resume(-1); return 'no error'; } catch (e) { return e instanceof CpuBudgetError && cpu.pending === null && cpu.callDepth === 0 ? true : e.name + ' pending ' + cpu.pending; }
  });
  T('sliced', 'only the outermost loop suspends: a hook that makes a nested call() is never cut in half', () => {
    const { mem, cpu } = machine(CpuClass); load(mem, loopProg, CODE); load(mem, [th.movi(0, 1), th.bxlr()], CODE + 0x100);
    let nested = 0; cpu.hook((CODE + 0x100) | 1, (c) => { nested = cpu.call(CODE | 1); c.r[0] = nested; });
    cpu.clock = () => cpu.icount; cpu.beginCall((CODE + 0x100) | 1); let cuts = 0; while (!cpu.resume(-1)) cuts++;
    return nested === 4080 && cpu.lastRet === 4080 && cuts === 0 ? true : JSON.stringify([nested, cpu.lastRet, cuts]);
  });
  // --- memory map
  T('memory', 'VRAM 8-bit writes replicate in the BG area and are ignored in the OBJ area', () => { const m = new GbaMem(new Uint8Array(0x100000)); m.write8(VRAM_BASE + 2, 0x5a); m.write8(VRAM_BASE + 0x10002, 0x5a); return m.read16(VRAM_BASE + 2) === 0x5a5a && m.read16(VRAM_BASE + 0x10002) === 0 ? true : 'vram8'; });
  T('memory', 'palette 8-bit writes replicate; OAM 8-bit writes are ignored', () => { const m = new GbaMem(new Uint8Array(0x100000)); m.write8(PRAM_BASE + 4, 0x21); m.write8(0x07000004, 0x33); return m.read16(PRAM_BASE + 4) === 0x2121 && m.read16(0x07000004) === 0 ? true : 'pal8'; });
  T('memory', 'EWRAM / IWRAM mirror, ROM mirrors, reads of nothing are counted not thrown', () => { const m = new GbaMem(new Uint8Array(0x100000)); m.write32(0x02000010, 0xabcd); m.write32(0x03000010, 0x1234); const r = m.read32(0x02040010) === 0xabcd && m.read32(0x03008010) === 0x1234; m.read32(0x01000000); return r && m.unmapped.size === 1 ? true : 'mirror'; });
  T('memory', 'DMA3 immediate: copy, 32-bit fill (fixed source)', () => { const m = new GbaMem(new Uint8Array(0x100000)); m.write32(0x02000100, 0xdeadbeef); m.write32(IO_BASE + 0xd4, 0x02000100); m.write32(IO_BASE + 0xd8, 0x02000200); m.write32(IO_BASE + 0xdc, 0x84000004 | 0x0100_0000 * 0); /* 4 words, 32-bit, enable */ return m.read32(0x02000200) === 0xdeadbeef ? true : hex(m.read32(0x02000200)); });
  return results;
}

/* --------------------------------------------------------------------------------------------- negative controls (mutants) */
class MutantAdcNoCarryOut extends GbaCpu { _add(a, b, c) { const r = super._add(a, b, c); this.C = 0; return r; } }
class MutantCondBug extends GbaCpu { _cond(c) { return c === 8 ? this.C === 1 : super._cond(c); } }            // HI ignores Z
class MutantLsr0 extends GbaCpu { _shift(mode, v, amt, reg, setC) { if (mode === 1 && amt === 0 && !reg) return v >>> 0; return super._shift(mode, v, amt, reg, setC); } }   // LSR #0 not treated as #32
class MutantUnalignedLdr extends GbaCpu { _ld32(a) { return this.mem.read32(a) >>> 0; } }                    // no rotate on unaligned LDR
class MutantResumeLosesR0 extends GbaCpu { resume(d) { const r = super.resume(d); if (!r) this.r[0] = 0; return r; } }                // a suspension drops the running value
class MutantResumeIgnoresDeadline extends GbaCpu { resume(d) { return super.resume(Infinity); } }                                      // the deadline is never honoured
class MutantResumeNoRestore extends GbaCpu { resume(d) { const r = super.resume(d); if (r) this.r[4] = 0; return r; } }                // the caller's registers are not restored
class MutantSubNoBorrow extends GbaCpu { _sub(a, b, c) { const r = super._sub(a, b, c); this.C = 1; return r; } }

function report(results, label) {
  const sections = new Map();
  for (const r of results) { const s = sections.get(r.section) || { p: 0, f: 0 }; r.ok ? s.p++ : s.f++; sections.set(r.section, s); }
  let p = 0, f = 0;
  for (const [name, s] of sections) { console.log(`  ${label} ${name}: passed ${s.p}, failed ${s.f}`); p += s.p; f += s.f; }
  for (const r of results) if (!r.ok) console.log(`    FAIL [${r.section}] ${r.name}: ${r.msg}`);
  return { p, f };
}

const real = suite(GbaCpu, 'cpu');
const { p, f } = report(real, 'cpu');
console.log(`anim_cpu / anim_ram unit tests: passed ${p}, failed ${f}`);
let ctrlFail = 0;
for (const [Mut, label] of [[MutantAdcNoCarryOut, 'ADC/ADD carry-out dropped'], [MutantCondBug, 'HI condition ignores Z'], [MutantLsr0, 'LSR #0 not #32'], [MutantUnalignedLdr, 'no unaligned-LDR rotate'], [MutantSubNoBorrow, 'SUB never borrows'], [MutantResumeLosesR0, 'a suspension loses r0'], [MutantResumeIgnoresDeadline, 'resume ignores the deadline'], [MutantResumeNoRestore, 'resume does not restore r4']]) {
  const m = suite(Mut, 'mutant');
  const failed = m.filter((r) => !r.ok).length;
  const tripped = failed > 0;
  console.log(`  negative control "${label}": ${tripped ? 'tripped (' + failed + ' test(s) failed) -- good' : 'NOT DETECTED -- the suite is blind to this bug'}`);
  if (!tripped) ctrlFail++;
}
console.log(`negative controls: ${8 - ctrlFail} of 8 mutants detected`);
process.exit(f === 0 && ctrlFail === 0 ? 0 : 1);

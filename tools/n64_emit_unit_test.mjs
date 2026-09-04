// bementalJIT MIPS emitter unit corpus (n64/docs/jit/TASKS.md M2:
// "unit corpus with red-test discipline").
//
//   node tools/n64_emit_unit_test.mjs [path-to-mips_emit.js]
//
// Runs n64/bementalJIT/mips_emit.js OUTSIDE the browser: stubs window/Module,
// hands compileSpan a synthetic guest (real WebAssembly.Memory as the guest
// address space, a real WebAssembly.Table), then EXECUTES the block it emits
// and reads the guest register file back out of linear memory.
//
// Why this exists. The differential harness (tools/n64_jit_diff_test.mjs) is
// the campaign's oracle, but it costs a browser and 600 VI frames per ROM and
// only says "diverged at frame N". These tests take ~1 second, need no ROM,
// and pin ONE contract each -- and every case below was RED on some real
// revision of the emitter, so a green run means something.
//
// The contract they pin is the JOIN CONTRACT. A natively-emitted memory op
// compiles to `if (dispatch_table[a>>16] == read/write_rdram) { fast }
// else { interp }`, and the slow arm CONTINUES in-block. The register cache
// is compile-time state shared across both arms, so any C.read/C.ensure/
// C.writeFromStack whose BYTES land inside one arm while its COMPILE-STATE
// escapes to both is a latent divergence: the wasm local is only assigned on
// one path, and locals are zero-initialised. Note this depends on emit-CALL
// order, not byte order -- `[].concat(C.read(rs), ..., f(C.writeFromStack(rt)))`
// evaluates left to right, but building `fastBytes` into a variable first
// inverts that silently.
//
// The stub "interpreter op" advances PC by one precomp_instr stride, which is
// what the real interpreter does for a non-faulting op -- so the slow arm's
// `PC != instrPtr + stride` divergence check passes and the block continues,
// exactly as in the core.
import fs from 'node:fs';
import vm from 'node:vm';

const SRCFILE = process.argv[2] || new URL('../n64/bementalJIT/mips_emit.js', import.meta.url).pathname;
const src = fs.readFileSync(SRCFILE, 'utf8');

// --- synthetic guest layout (byte addresses inside the fake linear memory) ---
const SRC = 0x10000, ENTRY = 0x20000, STRIDE = 32;
const REG = 0x40000, HI = 0x40100, LO = 0x40108;
const PCG = 0x40200, LASTADDR = 0x40204, NEXTINT = 0x40208, SKIPJ = 0x40210, JTA = 0x40214;
const COUNT = 0x62000 + 9 * 4;                 // &g_cp0_regs[CP0_COUNT_REG]
const TBL = 0x1000000;                 // 8 dispatch tables, 0x10000 u32 each
const INVALID = 0x300000, BLOCKS = 0x400000, DRAM = 0x800000;
const CP1S = 0x60000, CP1D = 0x60100, FPRSTORE = 0x61000;
// wave 11b: FCR31 arrives as jit_params[43], gated by the version magic at
// [44]. `opts.noFcr31` models an OLD core (or a magic mismatch): the page
// passes 0 and every compare/BC1 must fall back rather than store through a
// guessed address.
const FCR31A = 0x63000;
// &g_dev.r4300.delay_slot. The block entry guard reads it; `opts.noDelaySlot`
// models a core too old to export it (the emitter must then compile NOTHING).
const DELAYSLOT = 0x63010;
// g_cp0_regs must be modelled as a REAL uint32_t[32] array, because the
// emitter derives its base from the 12-byte gap between the two elements the
// param block exposes (count = index 9, status = index 12). A harness that
// scatters those two pointers silently trips the emitter's layout guard and
// every MFC0 test would pass by falling back.
const CP0REGS = 0x62000, CP0ST = CP0REGS + 12 * 4;
const RD_RDRAM = 0x111, RD_RDRAM_D = 0x131, WR_RDRAM = 0x121, WR_RDRAM_D = 0x141;

const leb = (n) => { const o = []; n >>>= 0; do { let b = n & 0x7f; n >>>= 7; o.push(n ? b | 0x80 : b); } while (n); return o; };
const sec = (id, c) => [id, ...leb(c.length), ...c];

// MIPS encoders
const I = (op, rs, rt, imm) => ((op << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff)) >>> 0;
const R = (rs, rt, rd, sa, fn) => ((rs << 21) | (rt << 16) | (rd << 11) | (sa << 6) | fn) >>> 0;
const OR = (rd, rs, rt) => R(rs, rt, rd, 0, 0x25);
const OPC = { LB: 0x20, LH: 0x21, LW: 0x23, LBU: 0x24, LHU: 0x25, LWU: 0x27, LD: 0x37,
              SB: 0x28, SH: 0x29, SW: 0x2b, SD: 0x3f, ADDIU: 0x09, LUI: 0x0f, BEQ: 0x04, BNE: 0x05, BNEL: 0x15 };
const MFC1 = (rt, fs) => ((0x11 << 26) | (0x00 << 21) | (rt << 16) | (fs << 11)) >>> 0;
const MFC0 = (rt, rd) => ((0x10 << 26) | (0x00 << 21) | (rt << 16) | (rd << 11)) >>> 0;
const MTC0 = (rt, rd) => ((0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11)) >>> 0;
// COP1 fmt ops: fmt in the rs field, ft unused for converts
const C1 = (fmt, fs, fd, fn) => ((0x11 << 26) | (fmt << 21) | (fs << 11) | (fd << 6) | fn) >>> 0;
const FMT = { S: 0x10, D: 0x11, W: 0x14, L: 0x15 };
// function codes, per pure_interp.c:517-556 (S-format) and :560-621 (D/W/L)
const FN = { ROUND_L: 0x08, TRUNC_L: 0x09, CEIL_L: 0x0a, FLOOR_L: 0x0b,
             ROUND_W: 0x0c, TRUNC_W: 0x0d, CEIL_W: 0x0e, FLOOR_W: 0x0f,
             CVT_S: 0x20, CVT_D: 0x21, CVT_W: 0x24, CVT_L: 0x25 };
// wave 11b. C.cond.fmt puts ft in bits 20:16 and fs in 15:11, so it needs a
// different encoder from the converts above (which leave ft zero).
const CMP = (fmt, fs, ft, cond) => ((0x11 << 26) | (fmt << 21) | (ft << 16) | (fs << 11) | (0x30 | cond)) >>> 0;
const C1S = (fs, ft, cond) => CMP(FMT.S, fs, ft, cond);
const C1D = (fs, ft, cond) => CMP(FMT.D, fs, ft, cond);
// the 16 FP predicates, in fn order (fpu.h:222-388). 0x8-0xF are the
// SIGNALLING half — mips_instructions.def wraps those in isnan -> stop=1.
const CC = { F: 0x0, UN: 0x1, EQ: 0x2, UEQ: 0x3, OLT: 0x4, ULT: 0x5, OLE: 0x6, ULE: 0x7,
             SF: 0x8, NGLE: 0x9, SEQ: 0xa, NGL: 0xb, LT: 0xc, NGE: 0xd, LE: 0xe, NGT: 0xf };
// BC1: which = (word >> 16) & 3 -> 0 BC1F, 1 BC1T, 2 BC1FL, 3 BC1TL
const BC1 = (which, imm) => ((0x11 << 26) | (0x08 << 21) | (which << 16) | (imm & 0xffff)) >>> 0;
// r0-destination family (2026-09-02). MULT/DIV/MTHI all encode rd = 0, which
// is why the emitter's guard is keyed on the OPCODE's destination, not on the
// rd field — see SPECIAL_RD_NOP in mips_emit.js.
const SLL = (rd, rt, sa) => R(0, rt, rd, sa, 0x00);
const MULT = (rs, rt) => R(rs, rt, 0, 0, 0x18);
const DIV = (rs, rt) => R(rs, rt, 0, 0, 0x1a);
const MTHI = (rs) => R(rs, 0, 0, 0, 0x11);
const MFHI = (rd) => R(0, 0, rd, 0, 0x10);
const MFLO = (rd) => R(0, 0, rd, 0, 0x12);
const JALR = (rd, rs) => R(rs, 0, rd, 0, 0x09);
const MTC1 = (rt, fs) => ((0x11 << 26) | (0x04 << 21) | (rt << 16) | (fs << 11)) >>> 0;
// J whose target leaves the synthetic block (blockStart 0x80100000) -> the
// _OUT variant, i.e. jump_to_address + jump_to_func
const JOUT = (target) => ((0x02 << 26) | ((target >>> 2) & 0x3ffffff)) >>> 0;

function makeWorld(words, opts = {}) {
  const mem = new WebAssembly.Memory({ initial: 1024 });          // 64 MB
  const table = new WebAssembly.Table({ initial: 8, element: 'anyfunc' });
  const HEAPU32 = new Uint32Array(mem.buffer);
  const REG64 = new BigUint64Array(mem.buffer);

  // table[1..7] = stub interpreter op: PC += STRIDE
  const body = [0x00, 0x41, 0x00, 0x41, 0x00, 0x28, 0x02, ...leb(PCG), 0x41, STRIDE, 0x6a, 0x36, 0x02, ...leb(PCG), 0x0b];
  const stub = new WebAssembly.Module(new Uint8Array([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...sec(1, [1, 0x60, 0, 0]),
    ...sec(2, [1, 1, 0x65, 1, 0x6d, 0x02, 0x00, 0x00]),
    ...sec(3, [1, 0]), ...sec(7, [1, 1, 0x66, 0x00, 0x00]),
    ...sec(10, [1, ...leb(body.length), ...body]),
  ]));
  const si = new WebAssembly.Instance(stub, { e: { m: mem } });
  for (let i = 1; i < 8; i++) table.set(i, si.exports.f);

  for (let i = 0; i < words.length; i++) HEAPU32[(SRC >> 2) + i] = words[i] >>> 0;
  for (let i = 0; i < words.length + 4; i++) HEAPU32[(ENTRY + i * STRIDE) >> 2] = 1;
  HEAPU32[NEXTINT >> 2] = 0xffffffff;   // next_interrupt never due
  HEAPU32[COUNT >> 2] = 0;
  HEAPU32[SKIPJ >> 2] = 0;
  HEAPU32[LASTADDR >> 2] = 0x80100000;
  HEAPU32[DELAYSLOT >> 2] = opts.inDelaySlot ? 1 : 0;
  // the core always invokes a block through `PC->ops()`, so PC == entryPtr on
  // entry; the delay-slot guard's `call_indirect` relies on that being true.
  HEAPU32[PCG >> 2] = ENTRY;
  // Both FPR banks, 32 entries each, modelled the way the core lays them out
  // in FR=1 mode: reg_cop1_simple[i] and reg_cop1_double[i] both point at the
  // SAME 8-byte reg_cop1_fgr_64[i] slot (cp1.c:120-165), the float using its
  // low 4 bytes. Filling only entry 0 (as this harness used to) would make
  // every convert test read a null bank pointer.
  for (let i = 0; i < 32; i++) {
    HEAPU32[(CP1S >> 2) + i] = FPRSTORE + i * 8;
    HEAPU32[(CP1D >> 2) + i] = FPRSTORE + i * 8;
  }
  HEAPU32[CP0ST >> 2] = opts.cu1 === false ? 0 : 0x20000000;      // CP0 Status CU1
  for (const [i, v] of Object.entries(opts.cp0 || {})) HEAPU32[(CP0REGS >> 2) + (+i)] = v >>> 0;

  const t = (n) => TBL + n * 0x40000;
  // rdramHit=false points every dispatch entry at something that is NOT
  // read/write_rdram, which is exactly the off-RDRAM / MMIO / TLB slow arm.
  const hit = !!opts.rdramHit;
  const fill = (base, v) => { for (let i = 0; i < 0x10000; i++) HEAPU32[(base >> 2) + i] = v; };
  // every width has its OWN table and its own read/write_rdram* sentinel; miss
  // one and that width silently takes the slow arm in a "fast arm" test
  fill(t(0), hit ? RD_RDRAM : 0);   fill(t(1), hit ? 0x112 : 0); fill(t(2), hit ? 0x113 : 0);
  fill(t(3), hit ? WR_RDRAM : 0);   fill(t(4), hit ? 0x122 : 0); fill(t(5), hit ? 0x123 : 0);
  fill(t(6), hit ? RD_RDRAM_D : 0); fill(t(7), hit ? WR_RDRAM_D : 0);

  const p = {
    vaddr: 0x80100000, entryPtr: ENTRY, span: words.length, srcPtr: SRC, stride: STRIDE, addrOff: 4,
    pcGlobal: PCG, reg: REG, hi: HI, lo: LO,
    blockStart: 0x80100000, blockEnd: 0x80100000 + words.length * 4,
    lastAddr: LASTADDR, nextInt: NEXTINT, count: COUNT, cpo: 2, skipJump: SKIPJ, genInt: 1,
    readmemW: t(0), readmemB: t(1), readmemH: t(2), rdRdram: RD_RDRAM, rdRdramB: 0x112, rdRdramH: 0x113,
    dramBase: DRAM,
    writememW: t(3), writememB: t(4), writememH: t(5), wrRdram: WR_RDRAM, wrRdramB: 0x122, wrRdramH: 0x123,
    invalidCode: INVALID, blocksBase: BLOCKS, notCompiled: 0x99,
    cp1Simple: CP1S, cp1Double: CP1D, cp0Status: opts.breakCp0Layout ? CP0ST + 4 : CP0ST,
    readmemD: t(6), writememD: t(7), rdRdramD: RD_RDRAM_D, wrRdramD: WR_RDRAM_D,
    jumpToAddr: JTA, jumpToFunc: 1,
    fcr31: opts.noFcr31 ? 0 : FCR31A,
    delaySlot: opts.noDelaySlot ? 0 : DELAYSLOT,
  };
  return { mem, table, HEAPU32, REG64, p };
}

function loadEmitter() {
  const sb = { WebAssembly, console: { error() {}, log() {}, warn() {} }, Uint32Array, Object, Array, Math, String };
  sb.window = sb; vm.createContext(sb); vm.runInContext(src, sb);
  return sb.bementalMips;
}

// run one case: seed regs/dram, emit, execute, compare
function T(name, words, { regs = {}, dram = {}, expectRegs = {}, expectDram = {}, expectStats = null, opts = {},
                          fprF32 = {}, fprF64 = {}, fprI32 = {}, fprI64 = {}, fcr31 = 0, expectFcr31 = null,
                          expectFprI32 = {}, expectFprI64 = {}, expectFprF32 = {}, expectFprF64 = {},
                          expectRefused = false, expectPC = null, expectLastAddr = null, expectCount = null,
                          lastAddr = null }) {
  const bm = loadEmitter();
  const { mem, table, HEAPU32, REG64, p } = makeWorld(words, opts);
  const DV = new DataView(mem.buffer);
  HEAPU32[FCR31A >> 2] = fcr31 >>> 0;
  const fprAt = (i) => FPRSTORE + (+i) * 8;
  for (const [i, v] of Object.entries(fprF32)) DV.setFloat32(fprAt(i), v, true);
  for (const [i, v] of Object.entries(fprF64)) DV.setFloat64(fprAt(i), v, true);
  for (const [i, v] of Object.entries(fprI32)) DV.setInt32(fprAt(i), v | 0, true);
  for (const [i, v] of Object.entries(fprI64)) DV.setBigInt64(fprAt(i), BigInt.asIntN(64, BigInt(v)), true);
  for (const [r, v] of Object.entries(regs)) REG64[(REG >> 3) + (+r)] = BigInt.asUintN(64, BigInt(v));
  for (const [a, v] of Object.entries(dram)) HEAPU32[(DRAM + (+a)) >> 2] = v >>> 0;
  if (lastAddr !== null) HEAPU32[LASTADDR >> 2] = lastAddr >>> 0;
  const idx = bm.compileSpan(p, { HEAPU32, wasmTable: table, wasmMemory: mem });
  // A refusal is a RESULT, not a failure: the delay-slot guard cannot be
  // emitted without &delay_slot, and an unguarded block corrupts the guest, so
  // the emitter must compile NOTHING rather than install one.
  if (expectRefused) {
    return { name, ok: idx === 0 && bm.stats.fails === 0,
             detail: idx === 0 ? '' : `expected refusal, got slot ${idx} (fails=${bm.stats.fails})` };
  }
  if (!(idx > 0)) return { name, ok: false, detail: `emit FAILED (idx=${idx}, emitFails=${bm.stats.fails})` };
  let threw = null;
  try { table.get(idx)(); } catch (e) { threw = String(e).slice(0, 120); }
  const bad = [];
  for (const [r, want] of Object.entries(expectRegs)) {
    const got = '0x' + BigInt.asUintN(64, REG64[(REG >> 3) + (+r)]).toString(16);
    if (got !== want) bad.push(`reg[${r}]=${got} want ${want}`);
  }
  for (const [a, want] of Object.entries(expectDram)) {
    const got = '0x' + (HEAPU32[(DRAM + (+a)) >> 2] >>> 0).toString(16);
    if (got !== want) bad.push(`dram[0x${(+a).toString(16)}]=${got} want ${want}`);
  }
  for (const [i, want] of Object.entries(expectFprI32)) {
    const got = '0x' + (DV.getUint32(fprAt(i), true) >>> 0).toString(16);
    if (got !== want) bad.push(`fpr32[${i}]=${got} want ${want}`);
  }
  for (const [i, want] of Object.entries(expectFprI64)) {
    const got = '0x' + DV.getBigUint64(fprAt(i), true).toString(16);
    if (got !== want) bad.push(`fpr64[${i}]=${got} want ${want}`);
  }
  for (const [i, want] of Object.entries(expectFprF32)) {
    const got = DV.getFloat32(fprAt(i), true);
    if (!Object.is(got, want)) bad.push(`fprF32[${i}]=${got} want ${want}`);
  }
  for (const [i, want] of Object.entries(expectFprF64)) {
    const got = DV.getFloat64(fprAt(i), true);
    if (!Object.is(got, want)) bad.push(`fprF64[${i}]=${got} want ${want}`);
  }
  if (expectFcr31 !== null) {
    const got = '0x' + (HEAPU32[FCR31A >> 2] >>> 0).toString(16);
    if (got !== expectFcr31) bad.push(`FCR31=${got} want ${expectFcr31}`);
  }
  if (expectPC !== null) {
    const got = HEAPU32[PCG >> 2] >>> 0;
    if (got !== (expectPC >>> 0)) bad.push(`PC=${got} want ${expectPC >>> 0}`);
  }
  if (expectLastAddr !== null) {
    const got = '0x' + (HEAPU32[LASTADDR >> 2] >>> 0).toString(16);
    if (got !== expectLastAddr) bad.push(`last_addr=${got} want ${expectLastAddr}`);
  }
  if (expectCount !== null) {
    const got = '0x' + (HEAPU32[COUNT >> 2] >>> 0).toString(16);
    if (got !== expectCount) bad.push(`Count=${got} want ${expectCount}`);
  }
  if (threw) bad.push('trapped: ' + threw);
  if (expectStats) for (const [k, want] of Object.entries(expectStats)) {
    if (bm.stats[k] !== want) bad.push(`stats.${k}=${bm.stats[k]} want ${want}`);
  }
  return { name, ok: bad.length === 0, detail: bad.join('; ') };
}

const V = '0xdeadbeef12345678';
const SLOW_ADDR = '0xffffffffa0000000';   // dispatch entry is not *_rdram => slow arm
const HIT_ADDR = '0x100000';              // dispatch entry is *_rdram      => fast arm

const tests = [
  // ---- join contract: value register (rt) on a store's SLOW arm ----
  // RED before 2026-08-29: rt's load prologue was emitted only inside the
  // fast arm, so the slow arm left the local at zero and the following read
  // of rt saw 0.
  T('SW slow arm: rt survives into the next op', [I(OPC.SW, 4, 8, 0x18), OR(10, 8, 0)],
    { regs: { 4: SLOW_ADDR, 8: V }, expectRegs: { 10: V } }),
  T('SD slow arm: rt survives into the next op', [I(OPC.SD, 4, 8, 0x18), OR(10, 8, 0)],
    { regs: { 4: SLOW_ADDR, 8: V }, expectRegs: { 10: V } }),
  T('SB slow arm: rt survives into the next op', [I(OPC.SB, 4, 8, 0x18), OR(10, 8, 0)],
    { regs: { 4: SLOW_ADDR, 8: V }, expectRegs: { 10: V } }),
  // rs == rt: the ADDRESS itself was computed from the unassigned local
  T('SW slow arm, rs==rt', [I(OPC.SW, 8, 8, 0x18), OR(10, 8, 0)], { regs: { 8: V }, expectRegs: { 10: V } }),
  T('SD slow arm, rs==rt', [I(OPC.SD, 8, 8, 0x18), OR(10, 8, 0)], { regs: { 8: V }, expectRegs: { 10: V } }),
  // controls: the fast arm was always correct and must stay so
  T('SW fast arm control', [I(OPC.SW, 4, 8, 0x18), OR(10, 8, 0)],
    { regs: { 4: HIT_ADDR, 8: V }, expectRegs: { 10: V }, opts: { rdramHit: true } }),
  T('SD fast arm control', [I(OPC.SD, 4, 8, 0x18), OR(10, 8, 0)],
    { regs: { 4: HIT_ADDR, 8: V }, expectRegs: { 10: V }, opts: { rdramHit: true } }),

  // ---- join contract: address register (rs) on a LOAD ----
  // RED on an intermediate wave-9 revision: hoisting the fast-arm bytes into
  // a variable made C.writeFromStack(rt) run BEFORE C.read(rs), so for the
  // ubiquitous `lw $8, off($8)` pointer chase the address came out as 0.
  T('LW rs==rt pointer chase', [I(OPC.LW, 8, 8, 0x18), OR(10, 8, 0)],
    { regs: { 8: HIT_ADDR }, dram: { 0x100018: 0xcafebabe },
      expectRegs: { 10: '0xffffffffcafebabe' }, opts: { rdramHit: true } }),
  T('LD rs==rt pointer chase', [I(OPC.LD, 8, 8, 0x18), OR(10, 8, 0)],
    { regs: { 8: HIT_ADDR }, dram: { 0x100018: 0xcafebabe, 0x10001c: 0x0badf00d },
      expectRegs: { 10: '0xcafebabe0badf00d' }, opts: { rdramHit: true } }),
  T('LHU rs==rt pointer chase', [I(OPC.LHU, 8, 8, 0x18), OR(10, 8, 0)],
    { regs: { 8: HIT_ADDR }, dram: { 0x100018: 0xcafebabe },
      expectRegs: { 10: '0xcafe' }, opts: { rdramHit: true } }),

  // ---- wave 9 value semantics ----
  // readd/writed split the doubleword HIGH word first (m64p_memory.c:127-133,
  // :170-181): dram[a] is bits 63..32 and dram[a+4] is bits 31..0.
  T('SD writes the high word first (big-endian order)', [I(OPC.SD, 4, 8, 0x20)],
    { regs: { 4: HIT_ADDR, 8: V }, opts: { rdramHit: true },
      expectDram: { 0x100020: '0xdeadbeef', 0x100024: '0x12345678' } }),
  T('LD reads the high word first', [I(OPC.LD, 4, 9, 0x20)],
    { regs: { 4: HIT_ADDR }, dram: { 0x100020: 0xdeadbeef, 0x100024: 0x12345678 },
      opts: { rdramHit: true }, expectRegs: { 9: V } }),
  T('SD -> LD round trip', [I(OPC.SD, 4, 8, 0x20), I(OPC.LD, 4, 9, 0x20)],
    { regs: { 4: HIT_ADDR, 8: V }, opts: { rdramHit: true }, expectRegs: { 9: V } }),
  T('SD/LD in a branch delay slot emit and run', [I(OPC.BNE, 4, 5, 2), I(OPC.SD, 4, 8, 0x20), OR(10, 8, 0), 0],
    { regs: { 4: HIT_ADDR, 5: '0x1', 8: V }, opts: { rdramHit: true },
      expectDram: { 0x100020: '0xdeadbeef', 0x100024: '0x12345678' } }),

  // ---- CU1 guard ----
  // MFC1 marks rt dirty while building the native arm; cuGuard's else arm
  // then flushes that dirty set. If rt was not already live, the else arm
  // stored an unassigned (zero) local over the guest register and THEN handed
  // control to the interpreter. Latent: needs CU1 clear at an MFC1/DMFC1.
  T('MFC1 with CU1 clear must not clobber reg[rt]', [MFC1(8, 0)],
    { regs: { 8: V }, expectRegs: { 8: V }, opts: { cu1: false } }),

  // ---- wave 10a: MFC0 ----
  // `rrt = SE32(g_cp0_regs[rd])` for every rd except RANDOM(1)/COUNT(9),
  // which call cp0_update_count() first (mips_instructions.def:618-634).
  T('MFC0 Status (rd=12) sign-extends into rt', [MFC0(8, 12)],
    { opts: { cp0: { 12: 0x8000ff01 } }, expectRegs: { 8: '0xffffffff8000ff01' },
      expectStats: { nativeCop0: 1, fallbackOps: 0 } }),
  T('MFC0 Cause (rd=13) is a plain read', [MFC0(8, 13)],
    { opts: { cp0: { 13: 0x00000400 } }, expectRegs: { 8: '0x400' },
      expectStats: { nativeCop0: 1, fallbackOps: 0 } }),
  T('MFC0 COUNT (rd=9) must FALL BACK (cp0_update_count side effect)', [MFC0(8, 9)],
    { expectStats: { nativeCop0: 0, fallbackOps: 1 } }),
  T('MFC0 RANDOM (rd=1) must FALL BACK (recomputes Random)', [MFC0(8, 1)],
    { expectStats: { nativeCop0: 0, fallbackOps: 1 } }),
  T('MTC0 must FALL BACK (Status/Count/Compare have side effects)', [MTC0(8, 12)],
    { expectStats: { nativeCop0: 0, fallbackOps: 1 } }),
  // the base of g_cp0_regs is DERIVED from (count, status) being 12 bytes
  // apart; if that ever stops holding, MFC0 must refuse to emit rather than
  // read from a wrong address
  T('MFC0 refuses to emit when the CP0 layout assumption fails', [MFC0(8, 12)],
    { expectStats: { nativeCop0: 0, fallbackOps: 1 }, opts: { breakCp0Layout: true } }),
  // a natively-emitted delay slot is counted by compileSpan as nativeMemSlots
  // (the counter predates non-memory slots), NOT by the main dispatch's
  // nativeCop0 -- what matters is that it did not fall back
  T('MFC0 in a branch delay slot', [I(OPC.BEQ, 4, 5, 2), MFC0(8, 12), OR(10, 8, 0), 0],
    { regs: { 4: '0x1', 5: '0x1' }, opts: { cp0: { 12: 0x12345678 } },
      expectRegs: { 8: '0x12345678' },
      expectStats: { nativeCop0: 0, nativeMemSlots: 1, fallbackOps: 0 } }),

  // ---- wave 11a: FP converts ----
  // The expectations below are NOT read off fpu.h -- fpu.h's casts are C
  // undefined behaviour out of range, so they say nothing about the shipped
  // answer. They are read off the SHIPPED dist binary's own lowering
  // (n64/N64Wasm/dist/n64wasm.wasm disassembled with wasm2wat; func 2548 =
  // TRUNC.W.S etc). See the wave-11a block comment in mips_emit.js.
  T('TRUNC.W.S positive truncates toward zero', [C1(FMT.S, 1, 2, FN.TRUNC_W)],
    { fprF32: { 1: 3.75 }, expectFprI32: { 2: '0x3' },
      expectStats: { nativeFPCvt: 1, fallbackOps: 0 } }),
  T('TRUNC.W.S negative truncates toward zero', [C1(FMT.S, 1, 2, FN.TRUNC_W)],
    { fprF32: { 1: -3.75 }, expectFprI32: { 2: '0xfffffffd' },
      expectStats: { nativeFPCvt: 1, fallbackOps: 0 } }),
  // THE UB CASE. A saturating conversion would give 0x7fffffff here; the
  // shipped binary gives INT32_MIN, because LLVM guarded the trapping
  // i32.trunc_f32_s with |r| < 2^31 and yields INT32_MIN on the else arm.
  T('TRUNC.W.S out of range is INT32_MIN, not saturation', [C1(FMT.S, 1, 2, FN.TRUNC_W)],
    { fprF32: { 1: 1e30 }, expectFprI32: { 2: '0x80000000' },
      expectStats: { nativeFPCvt: 1, fallbackOps: 0 } }),
  T('TRUNC.W.S -inf is INT32_MIN', [C1(FMT.S, 1, 2, FN.TRUNC_W)],
    { fprF32: { 1: -Infinity }, expectFprI32: { 2: '0x80000000' } }),
  // NaN: abs(NaN) < 2^31 is false, so NaN also takes the else arm. A
  // saturating conversion would give 0.
  T('TRUNC.W.S NaN is INT32_MIN, not 0', [C1(FMT.S, 1, 2, FN.TRUNC_W)],
    { fprF32: { 1: NaN }, expectFprI32: { 2: '0x80000000' } }),
  T('FLOOR.W.S rounds toward -inf', [C1(FMT.S, 1, 2, FN.FLOOR_W)],
    { fprF32: { 1: -3.25 }, expectFprI32: { 2: '0xfffffffc' },
      expectStats: { nativeFPCvt: 1, fallbackOps: 0 } }),
  T('CEIL.W.S rounds toward +inf', [C1(FMT.S, 1, 2, FN.CEIL_W)],
    { fprF32: { 1: 3.25 }, expectFprI32: { 2: '0x4' },
      expectStats: { nativeFPCvt: 1, fallbackOps: 0 } }),
  // .L forms write the DOUBLE bank as int64 and guard against 2^63
  T('TRUNC.L.S writes the 64-bit result', [C1(FMT.S, 1, 2, FN.TRUNC_L)],
    { fprF32: { 1: -5.9 }, expectFprI64: { 2: '0xfffffffffffffffb' },
      expectStats: { nativeFPCvt: 1, fallbackOps: 0 } }),
  T('TRUNC.L.S out of range is INT64_MIN', [C1(FMT.S, 1, 2, FN.TRUNC_L)],
    { fprF32: { 1: 1e30 }, expectFprI64: { 2: '0x8000000000000000' } }),
  T('TRUNC.W.D truncates a double into the SIMPLE bank', [C1(FMT.D, 1, 2, FN.TRUNC_W)],
    { fprF64: { 1: 9.99 }, expectFprI32: { 2: '0x9' },
      expectStats: { nativeFPCvt: 1, fallbackOps: 0 } }),
  T('TRUNC.W.D out of range is INT32_MIN', [C1(FMT.D, 1, 2, FN.TRUNC_W)],
    { fprF64: { 1: 1e30 }, expectFprI32: { 2: '0x80000000' } }),
  // plain converts: set_rounding() is INERT in this build (it compiles to a
  // load and a `drop`), so these are always round-to-nearest-even
  T('CVT.S.W int32 -> float', [C1(FMT.W, 1, 2, FN.CVT_S)],
    { fprI32: { 1: -7 }, expectFprF32: { 2: -7 },
      expectStats: { nativeFPCvt: 1, fallbackOps: 0 } }),
  T('CVT.D.W int32 -> double', [C1(FMT.W, 1, 2, FN.CVT_D)],
    { fprI32: { 1: 123456 }, expectFprF64: { 2: 123456 },
      expectStats: { nativeFPCvt: 1, fallbackOps: 0 } }),
  T('CVT.S.L int64 -> float', [C1(FMT.L, 1, 2, FN.CVT_S)],
    { fprI64: { 1: -1048576 }, expectFprF32: { 2: -1048576 },
      expectStats: { nativeFPCvt: 1, fallbackOps: 0 } }),
  T('CVT.D.L int64 -> double', [C1(FMT.L, 1, 2, FN.CVT_D)],
    { fprI64: { 1: 1234567890 }, expectFprF64: { 2: 1234567890 },
      expectStats: { nativeFPCvt: 1, fallbackOps: 0 } }),
  T('CVT.D.S float -> double', [C1(FMT.S, 1, 2, FN.CVT_D)],
    { fprF32: { 1: 0.5 }, expectFprF64: { 2: 0.5 },
      expectStats: { nativeFPCvt: 1, fallbackOps: 0 } }),
  T('CVT.S.D double -> float (demote)', [C1(FMT.D, 1, 2, FN.CVT_S)],
    { fprF64: { 1: 0.25 }, expectFprF32: { 2: 0.25 },
      expectStats: { nativeFPCvt: 1, fallbackOps: 0 } }),

  // ---- wave 11a: what must STILL fall back, and why ----
  // ROUND.* lowers to a roundf() CALL in the shipped binary (func 2553 =
  // `call 700`). C round() is half-AWAY-from-zero; wasm f32.nearest is
  // half-to-EVEN. Emitting f32.nearest would be wrong at exactly .5, so this
  // must keep falling back until roundf is open-coded.
  T('ROUND.W.S must FALL BACK (roundf != f32.nearest at .5)', [C1(FMT.S, 1, 2, FN.ROUND_W)],
    { expectStats: { nativeFPCvt: 0, fallbackOps: 1 } }),
  T('ROUND.L.S must FALL BACK', [C1(FMT.S, 1, 2, FN.ROUND_L)],
    { expectStats: { nativeFPCvt: 0, fallbackOps: 1 } }),
  // CVT.W.* / CVT.L.* dispatch on FCR31&3 (funcs 2554-2557) and FCR31's
  // address is not in the jit_params block
  T('CVT.W.S must FALL BACK (FCR31 rounding-mode dispatch)', [C1(FMT.S, 1, 2, FN.CVT_W)],
    { expectStats: { nativeFPCvt: 0, fallbackOps: 1 } }),
  T('CVT.L.D must FALL BACK (FCR31 rounding-mode dispatch)', [C1(FMT.D, 1, 2, FN.CVT_L)],
    { expectStats: { nativeFPCvt: 0, fallbackOps: 1 } }),
  // ---- wave 11b: FP compares + BC1 ----
  // FCR31 seeds carry NON-condition bits (rounding mode 3 + bit 24) in every
  // case below: a compare must REPLACE bit 23 and preserve the rest, and an
  // emitter that just stored 0/0x800000 would pass a bare-zero seed.
  T('C.LT.S sets FCR31 bit 23 and preserves the other bits',
    [C1S(1, 2, CC.LT)],
    { fprF32: { 1: 1.0, 2: 2.0 }, fcr31: 0x01000003, expectFcr31: '0x1800003',
      expectStats: { nativeFPCmp: 1, fallbackOps: 0 } }),
  T('C.LT.S false CLEARS bit 23 and preserves the other bits',
    [C1S(1, 2, CC.LT)],
    { fprF32: { 1: 2.0, 2: 1.0 }, fcr31: 0x01800003, expectFcr31: '0x1000003',
      expectStats: { nativeFPCmp: 1, fallbackOps: 0 } }),
  T('C.LE.S true at equality', [C1S(1, 2, CC.LE)],
    { fprF32: { 1: 2.5, 2: 2.5 }, fcr31: 0, expectFcr31: '0x800000' }),
  T('C.LT.D compares the DOUBLE bank', [C1D(1, 2, CC.LT)],
    { fprF64: { 1: -1.5, 2: 0.25 }, fcr31: 0, expectFcr31: '0x800000',
      expectStats: { nativeFPCmp: 1, fallbackOps: 0 } }),
  // C.F.* is unconditional-clear and takes NO operands at all (fpu.h:221-224)
  T('C.F.S always clears, reading no operand', [C1S(1, 2, CC.F)],
    { fcr31: 0x00800000, expectFcr31: '0x0', expectStats: { nativeFPCmp: 1 } }),

  // NaN handling is the ONLY thing separating the 16 predicates, and it splits
  // three ways (fpu.h:222-388). These four pin the ordered/unordered contrast
  // on the SAME NaN input, so an emitter that used one wasm compare for all of
  // them fails at least two.
  T('C.EQ.S with NaN CLEARS (ordered predicate)', [C1S(1, 2, CC.EQ)],
    { fprF32: { 1: NaN, 2: NaN }, fcr31: 0x00800000, expectFcr31: '0x0' }),
  T('C.UEQ.S with NaN SETS (unordered predicate)', [C1S(1, 2, CC.UEQ)],
    { fprF32: { 1: NaN, 2: 1.0 }, fcr31: 0, expectFcr31: '0x800000' }),
  T('C.UEQ.S without NaN is plain equality', [C1S(1, 2, CC.UEQ)],
    { fprF32: { 1: 1.0, 2: 2.0 }, fcr31: 0x00800000, expectFcr31: '0x0' }),
  T('C.UN.S is true iff an operand is NaN', [C1S(1, 2, CC.UN)],
    { fprF32: { 1: 1.0, 2: NaN }, fcr31: 0, expectFcr31: '0x800000' }),
  T('C.UN.S false on ordered operands', [C1S(1, 2, CC.UN)],
    { fprF32: { 1: 1.0, 2: 2.0 }, fcr31: 0x00800000, expectFcr31: '0x0' }),
  T('C.OLT.S with NaN CLEARS', [C1S(1, 2, CC.OLT)],
    { fprF32: { 1: NaN, 2: 2.0 }, fcr31: 0x00800000, expectFcr31: '0x0' }),
  // ULT == !(s >= t) and ULE == !(s > t): the single-compare forms. If either
  // were emitted as a plain lt/le these would read 0.
  T('C.ULT.S with NaN SETS', [C1S(1, 2, CC.ULT)],
    { fprF32: { 1: NaN, 2: 2.0 }, fcr31: 0, expectFcr31: '0x800000' }),
  T('C.ULT.S ordered behaves as <', [C1S(1, 2, CC.ULT)],
    { fprF32: { 1: 2.0, 2: 2.0 }, fcr31: 0x00800000, expectFcr31: '0x0' }),
  T('C.ULE.S with NaN SETS', [C1S(1, 2, CC.ULE)],
    { fprF32: { 1: 1.0, 2: NaN }, fcr31: 0, expectFcr31: '0x800000' }),
  T('C.ULE.S ordered behaves as <=', [C1S(1, 2, CC.ULE)],
    { fprF32: { 1: 3.0, 2: 2.0 }, fcr31: 0x00800000, expectFcr31: '0x0' }),

  // THE SIGNALLING GROUP (fn 0x38-0x3F). mips_instructions.def:1300-1390 wraps
  // these — and ONLY these — in `if (isnan(..)) { DebugMessage(); stop = 1; }`.
  // fpu.h alone does not show it, and the FCR31 result is the same either way,
  // so a "plain wasm" emitter is bit-exact on every architectural checksum and
  // still fails to halt where the interpreter halts. The NaN arm must hand the
  // instruction to the interpreter and EXIT: FCR31 untouched (the stub op only
  // advances PC) and the following in-block instruction must NOT run.
  T('C.LT.S with a NaN operand bails to the interpreter and exits',
    [C1S(1, 2, CC.LT), I(OPC.ADDIU, 0, 10, 0x77)],
    { fprF32: { 1: NaN, 2: 2.0 }, fcr31: 0x01000003, expectFcr31: '0x1000003',
      expectRegs: { 10: '0x0' }, expectStats: { nativeFPCmp: 1, fallbackOps: 0 } }),
  T('C.LT.S without NaN takes the native arm and continues',
    [C1S(1, 2, CC.LT), I(OPC.ADDIU, 0, 10, 0x77)],
    { fprF32: { 1: 1.0, 2: 2.0 }, fcr31: 0x01000003, expectFcr31: '0x1800003',
      expectRegs: { 10: '0x77' }, expectStats: { nativeFPCmp: 1, fallbackOps: 0 } }),
  T('C.SEQ.S with a NaN operand bails too (signalling group)',
    [C1S(1, 2, CC.SEQ), I(OPC.ADDIU, 0, 10, 0x77)],
    { fprF32: { 1: 2.0, 2: NaN }, fcr31: 0, expectFcr31: '0x0', expectRegs: { 10: '0x0' } }),
  // ...while the NON-signalling twin of the same predicate does NOT bail
  T('C.EQ.S with NaN does NOT bail (no signalling wrapper)',
    [C1S(1, 2, CC.EQ), I(OPC.ADDIU, 0, 10, 0x77)],
    { fprF32: { 1: 2.0, 2: NaN }, fcr31: 0x00800000, expectFcr31: '0x0',
      expectRegs: { 10: '0x77' } }),
  // C.SF/C.NGLE always clear, but still signal on NaN
  T('C.SF.S clears on ordered operands', [C1S(1, 2, CC.SF)],
    { fprF32: { 1: 1.0, 2: 2.0 }, fcr31: 0x00800000, expectFcr31: '0x0' }),
  T('C.SF.S with NaN bails (still signalling)',
    [C1S(1, 2, CC.SF), I(OPC.ADDIU, 0, 10, 0x77)],
    { fprF32: { 1: NaN, 2: 2.0 }, fcr31: 0x00800000, expectFcr31: '0x800000',
      expectRegs: { 10: '0x0' } }),

  // guard arms: a compare must not run with CU1 clear, and must fall back
  // entirely when the core did not supply FCR31's address
  T('C.LT.S with CU1 clear does not touch FCR31', [C1S(1, 2, CC.LT)],
    { fprF32: { 1: 1.0, 2: 2.0 }, fcr31: 0x01000003, expectFcr31: '0x1000003',
      opts: { cu1: false } }),
  T('C.LT.S must FALL BACK when jit_params has no FCR31 (version skew)',
    [C1S(1, 2, CC.LT)],
    { fprF32: { 1: 1.0, 2: 2.0 }, fcr31: 0x01000003, expectFcr31: '0x1000003',
      opts: { noFcr31: true }, expectStats: { nativeFPCmp: 0, fallbackOps: 1 } }),
  // a compare is fault-free apart from CU1, so it is legal in a delay slot
  T('C.LT.S in a branch delay slot', [I(OPC.BEQ, 4, 5, 2), C1S(1, 2, CC.LT), OR(10, 8, 0), 0],
    { regs: { 4: '0x1', 5: '0x1' }, fprF32: { 1: 1.0, 2: 2.0 },
      fcr31: 0, expectFcr31: '0x800000', expectStats: { nativeFPCmp: 1, fallbackOps: 0 } }),

  // ---- wave 11b: BC1F/BC1T/BC1FL/BC1TL ----
  // The core dispatches on (word >> 16) & 3 only (recomp.c:1584), so bits
  // 20:18 are ignored; BC1(3=TL) is a LIKELY branch, whose delay slot runs
  // ONLY when taken. The two arms below therefore have distinct signatures:
  //   taken     -> slot runs (r10), block exits at the target (r11 stays 0)
  //   not taken -> slot SKIPPED (r10 stays 0), execution resumes at addr+8 (r11)
  // A fallback would advance PC one instruction and run the slot either way,
  // so this discriminates emission from fallback on behaviour, not just stats.
  T('BC1TL taken runs its delay slot and exits at the target',
    [BC1(3, 2), I(OPC.ADDIU, 0, 10, 0x5555), I(OPC.ADDIU, 0, 11, 0x1234), 0],
    { fcr31: 0x00800000, expectRegs: { 10: '0x5555', 11: '0x0' },
      expectStats: { nativeFPBranches: 1, fallbackOps: 0 } }),
  T('BC1TL not taken SKIPS its delay slot (branch-likely)',
    [BC1(3, 2), I(OPC.ADDIU, 0, 10, 0x5555), I(OPC.ADDIU, 0, 11, 0x1234), 0],
    { fcr31: 0x01000003, expectRegs: { 10: '0x0', 11: '0x1234' },
      expectStats: { nativeFPBranches: 1, fallbackOps: 0 } }),
  // BC1FL is the same branch with the sense inverted — an emitter that dropped
  // the i32.eqz would swap these two rows
  T('BC1FL takes when the condition bit is CLEAR',
    [BC1(2, 2), I(OPC.ADDIU, 0, 10, 0x5555), I(OPC.ADDIU, 0, 11, 0x1234), 0],
    { fcr31: 0x01000003, expectRegs: { 10: '0x5555', 11: '0x0' },
      expectStats: { nativeFPBranches: 1, fallbackOps: 0 } }),
  T('BC1FL does not take when the condition bit is SET',
    [BC1(2, 2), I(OPC.ADDIU, 0, 10, 0x5555), I(OPC.ADDIU, 0, 11, 0x1234), 0],
    { fcr31: 0x00800000, expectRegs: { 10: '0x0', 11: '0x1234' },
      expectStats: { nativeFPBranches: 1, fallbackOps: 0 } }),
  // BC1T is NOT likely: its delay slot runs on both arms
  T('BC1T not taken still runs its delay slot (not likely)',
    [BC1(1, 2), I(OPC.ADDIU, 0, 10, 0x5555), I(OPC.ADDIU, 0, 11, 0x1234), 0],
    { fcr31: 0x01000003, expectRegs: { 10: '0x5555', 11: '0x1234' },
      expectStats: { nativeFPBranches: 1, fallbackOps: 0 } }),
  // DECLARE_JUMP's cop1 flag: check_cop1_unusable() runs BEFORE the branch, so
  // a CU1-clear BC1 must hand the WHOLE branch back and exit — neither the
  // delay slot nor the fall-through may run
  T('BC1TL with CU1 clear bails before branching',
    [BC1(3, 2), I(OPC.ADDIU, 0, 10, 0x5555), I(OPC.ADDIU, 0, 11, 0x1234), 0],
    { fcr31: 0x00800000, expectRegs: { 10: '0x0', 11: '0x0' }, opts: { cu1: false },
      expectStats: { nativeFPBranches: 1 } }),
  T('BC1F must FALL BACK when jit_params has no FCR31 (version skew)',
    [BC1(0, 2), 0],
    { opts: { noFcr31: true }, expectStats: { nativeFPBranches: 0 } }),

  // ---- wave 11a: guard arms ----
  // CU1 clear must hand the op to the interpreter, not convert anyway
  T('TRUNC.W.S with CU1 clear does not write the destination', [C1(FMT.S, 1, 2, FN.TRUNC_W)],
    { fprF32: { 1: 3.75 }, fprI32: { 2: 0x5a5a5a5a }, expectFprI32: { 2: '0x5a5a5a5a' },
      opts: { cu1: false } }),
  // fault-free, so it is legal in a delay slot (routed via emitSlotNative)
  T('TRUNC.W.S in a branch delay slot', [I(OPC.BEQ, 4, 5, 2), C1(FMT.S, 1, 2, FN.TRUNC_W), OR(10, 8, 0), 0],
    { regs: { 4: '0x1', 5: '0x1' }, fprF32: { 1: -2.5 },
      expectFprI32: { 2: '0xfffffffe' }, expectStats: { fallbackOps: 0 } }),

  // ---- recomp.c's RNOP rewrite: a DESTINATION of r0 is a whole-instruction
  // NOP (2026-09-02, superMarioStarRoad.z64 divergence at VI frame 24) ----
  //
  // recomp.c ends most of its emitters with `if (dst->f.i.rt == reg) RNOP()`
  // / `if (dst->f.r.rd == reg) RNOP()`, and `reg` is `&reg[0]`
  // (recomp.c:99-117), so the test is "destination is r0". RNOP sets
  // `dst->ops = NOP` (recomp.c:137-141): no arithmetic, no memory access, no
  // write to reg[0]. The emitter used to write reg[0] anyway, and reg[0] is
  // in the differential checksum.
  //
  // reg[0] is SEEDED with a sentinel in each case so "untouched" is proven
  // rather than coinciding with wasm's zero-init. Reading $zero still reads
  // that sentinel, which is faithful: this core has a real reg[0] cell.
  T('ADDIU into $zero is a NOP (the superMarioStarRoad word 0x24000101)',
    [0x24000101 >>> 0, 0],
    { regs: { 0: '0x5a5a' }, expectRegs: { 0: '0x5a5a' } }),
  T('ADDIU into $zero in a J_OUT delay slot (the exact ROM shape)',
    [JOUT(0x80200000), 0x24000101 >>> 0, I(OPC.ADDIU, 0, 11, 1), 0],
    { regs: { 0: '0x5a5a' }, expectRegs: { 0: '0x5a5a', 11: '0x0' },
      expectStats: { nativeBranches: 1, fallbackOps: 0 } }),
  T('ADDIU into $zero in a BEQ delay slot', [I(OPC.BEQ, 4, 5, 2), 0x24000101 >>> 0, OR(10, 8, 0), 0],
    { regs: { 0: '0x5a5a', 4: '0x1', 5: '0x1' }, expectRegs: { 0: '0x5a5a' } }),
  T('LUI into $zero is a NOP', [I(OPC.LUI, 0, 0, 0x8034), 0],
    { regs: { 0: '0x5a5a' }, expectRegs: { 0: '0x5a5a' } }),
  T('SLL into $zero is a NOP', [SLL(0, 8, 3), 0],
    { regs: { 0: '0x5a5a', 8: '0xff' }, expectRegs: { 0: '0x5a5a' } }),
  T('OR into $zero is a NOP', [OR(0, 8, 9), 0],
    { regs: { 0: '0x5a5a', 8: V, 9: V }, expectRegs: { 0: '0x5a5a' } }),
  T('SLTU into $zero is a NOP', [R(8, 9, 0, 0, 0x2b), 0],
    { regs: { 0: '0x5a5a', 8: '0x1', 9: '0x2' }, expectRegs: { 0: '0x5a5a' } }),
  // a load into r0 must not even PERFORM THE ACCESS (RLW recomp.c:1979-1985)
  T('LW into $zero is a NOP (fast arm)', [I(OPC.LW, 4, 0, 0x18), 0],
    { regs: { 0: '0x5a5a', 4: HIT_ADDR }, dram: { 0x100018: 0xcafebabe },
      opts: { rdramHit: true }, expectRegs: { 0: '0x5a5a' } }),
  T('LD into $zero is a NOP (fast arm)', [I(OPC.LD, 4, 0, 0x20), 0],
    { regs: { 0: '0x5a5a', 4: HIT_ADDR }, dram: { 0x100020: 0xdeadbeef, 0x100024: 0x12345678 },
      opts: { rdramHit: true }, expectRegs: { 0: '0x5a5a' } }),
  T('MFHI into $zero is a NOP', [MTHI(8), MFHI(0), 0],
    { regs: { 0: '0x5a5a', 8: V }, expectRegs: { 0: '0x5a5a' } }),
  T('MFC0 into $zero is a NOP', [MFC0(0, 12), 0],
    { regs: { 0: '0x5a5a' }, opts: { cp0: { 12: 0x12345678 } }, expectRegs: { 0: '0x5a5a' } }),
  // RMFC1 (recomp.c:1530-1537) applies the guard, so a CU1 check never runs
  // either — the whole instruction is gone
  T('MFC1 into $zero is a NOP, even with CU1 clear', [MFC1(0, 1), I(OPC.ADDIU, 8, 9, 1), 0],
    { regs: { 0: '0x5a5a', 8: '0x1' }, fprI32: { 1: 0x11223344 }, opts: { cu1: false },
      expectRegs: { 0: '0x5a5a', 9: '0x2' } }),
  // DECLARE_JUMP writes the link only `if (link_register != &reg[0])`
  // (cached_interp.c:78-81); JALR's link register is &rrd, so rd=0 links nothing
  T('JALR $zero, $rs jumps but links nothing', [JALR(0, 8), 0, 0, 0],
    { regs: { 0: '0x5a5a', 8: '0x80100010' }, expectRegs: { 0: '0x5a5a' },
      expectStats: { nativeBranches: 1 } }),

  // ---- negative controls for the SAME fix: r0 as a SOURCE, and the ops
  // recomp.c deliberately does NOT guard. These are the cases an over-broad
  // "suppress anything mentioning r0" fix would break — note MULT/DIV/MTHI
  // all encode rd = 0, so a guard keyed on the rd FIELD rather than on the
  // opcode's actual destination would silently delete them.
  T('control: MTHI/MFHI still move hi (MTHI encodes rd=0, unguarded)', [MTHI(8), MFHI(9), 0],
    { regs: { 8: V }, expectRegs: { 9: V } }),
  T('control: MULT still writes hi/lo (encodes rd=0, unguarded)', [MULT(8, 9), MFLO(10), MFHI(11), 0],
    { regs: { 8: '0x3', 9: '0x5' }, expectRegs: { 10: '0xf', 11: '0x0' } }),
  T('control: DIV still writes lo (encodes rd=0, unguarded)', [DIV(8, 9), MFLO(10), 0],
    { regs: { 8: '0x11', 9: '0x3' }, expectRegs: { 10: '0x5' } }),
  T('control: SW reads $zero as a SOURCE and still stores', [I(OPC.SW, 4, 0, 0x18), 0],
    { regs: { 0: '0x5a5a', 4: HIT_ADDR }, opts: { rdramHit: true },
      expectDram: { 0x100018: '0x5a5a' } }),
  T('control: ADDIU from $zero still writes its destination', [I(OPC.ADDIU, 0, 9, 5), 0],
    { regs: { 0: '0x0' }, expectRegs: { 9: '0x5' } }),
  T('control: JALR $ra, $rs still links', [JALR(31, 8), 0, 0, 0],
    // the link is SE32(PC->addr + 8) (cached_interp.c:80), so it sign-extends
    { regs: { 8: '0x80100010' }, expectRegs: { 31: '0xffffffff80100008' },
      expectStats: { nativeBranches: 1 } }),
  T('control: MTC1 from $zero still writes the FPR', [MTC1(0, 1), 0],
    { regs: { 0: '0x5a5a' }, expectFprI32: { 1: '0x5a5a' } }),

  // ---- join contract, THIRD instance: a LOAD's slow arm (2026-09-02,
  // conker.z64 diverged at VI frame 82) ----
  //
  // emitLoad's fast arm ends with C.writeFromStack(rt), marking rt dirty;
  // slowArm's C.flushSnapshot() then stored that local on the SLOW arm, where
  // it is never assigned — zeroing reg[rt] and only THEN calling the
  // interpreter op. The old comment called it benign "because the op rewrites
  // rt anyway"; it does not when the op faults (TLB/MMIO), when ops is
  // NOTCOMPILED, or when rt is r0.
  //
  // The stub op in this harness only advances PC and writes NO register, so it
  // models exactly that case. reg[rt] must come out untouched.
  T('LW slow arm must not clobber rt when the interp op writes nothing',
    [I(OPC.LW, 4, 9, 0x18), 0],
    { regs: { 4: SLOW_ADDR, 9: V }, expectRegs: { 9: V } }),
  T('LD slow arm must not clobber rt when the interp op writes nothing',
    [I(OPC.LD, 4, 9, 0x18), 0],
    { regs: { 4: SLOW_ADDR, 9: V }, expectRegs: { 9: V } }),
  T('LBU slow arm must not clobber rt when the interp op writes nothing',
    [I(OPC.LBU, 4, 9, 0x18), 0],
    { regs: { 4: SLOW_ADDR, 9: V }, expectRegs: { 9: V } }),
  // the delay-slot form takes slowArm's OTHER branch (hand the whole branch
  // back and exit), which flushed the same unassigned local
  T('LW slow arm in a delay slot must not clobber rt',
    [I(OPC.BEQ, 5, 6, 2), I(OPC.LW, 4, 9, 0x18), OR(10, 8, 0), 0],
    { regs: { 4: SLOW_ADDR, 5: '0x1', 6: '0x1', 9: V }, expectRegs: { 9: V } }),
  // controls: the value ALREADY dirty on entry must still be flushed for the
  // interp op to read, and rs==rt must still compute the address from rs
  T('control: LW slow arm still flushes a register dirtied EARLIER in the block',
    [I(OPC.ADDIU, 9, 9, 1), I(OPC.LW, 4, 8, 0x18), 0],
    { regs: { 4: SLOW_ADDR, 9: '0x10' }, expectRegs: { 9: '0x11' } }),
  T('control: LW slow arm, rs==rt keeps the address register',
    [I(OPC.LW, 8, 8, 0x18), 0],
    { regs: { 8: SLOW_ADDR }, expectRegs: { 8: SLOW_ADDR } }),

  // ---- DELAY-SLOT ENTRY GUARD (conker.z64 frame-82 divergence, 2026-09-04) ----
  // A JIT block is installed as ONE instruction's `ops`, and the core calls
  // `PC->ops()` for a branch DELAY SLOT expecting exactly one instruction:
  // DECLARE_JUMP (cached_interp.c:87-90) and, at EVERY page boundary,
  // FIN_BLOCK's delay-slot path (cached_interp.c:184-206) — which then
  // RESTORES `PC = inst+1`, discarding whatever PC the callee left. Running a
  // whole span there executes instructions the guest never issued, and its
  // last_addr/Count writes SURVIVE that PC restore. On conker.z64 the block at
  // 0x10014000 took its branch, wrote last_addr = 0x1001402c, FIN_BLOCK
  // restored PC to 0x10014004, and the next cp0_update_count() computed
  // (0x10014004 - 0x1001402c) >> 2 as UNSIGNED -> Count += ~0xC0000000.
  // These four are RED against the pre-fix emitter.
  T('delay-slot entry runs ONE instruction, not the span',
    [I(OPC.ADDIU, 0, 8, 0x11), I(OPC.ADDIU, 0, 9, 0x22), I(OPC.ADDIU, 0, 10, 0x33), 0],
    { opts: { inDelaySlot: true },
      // the stub interp op only advances PC, so a guarded entry writes NOTHING
      expectRegs: { 8: '0x0', 9: '0x0', 10: '0x0' }, expectPC: ENTRY + STRIDE }),
  T('control: the SAME span with delay_slot clear still runs natively',
    [I(OPC.ADDIU, 0, 8, 0x11), I(OPC.ADDIU, 0, 9, 0x22), I(OPC.ADDIU, 0, 10, 0x33), 0],
    { expectRegs: { 8: '0x11', 9: '0x22', 10: '0x33' } }),
  // the load-bearing one: a delay-slot entry must not move last_addr/Count.
  // The block below takes its branch, so an unguarded emitter writes
  // last_addr = branch target and batches Count at the branch tail.
  T('delay-slot entry must not touch last_addr or Count',
    [I(OPC.BEQ, 5, 6, 2), 0, I(OPC.ADDIU, 0, 8, 0x11), 0, 0],
    { regs: { 5: '0x7', 6: '0x7' }, lastAddr: 0x80100000,
      opts: { inDelaySlot: true },
      expectLastAddr: '0x80100000', expectCount: '0x0', expectRegs: { 8: '0x0' } }),
  T('control: the SAME branch with delay_slot clear DOES move last_addr',
    [I(OPC.BEQ, 5, 6, 2), 0, I(OPC.ADDIU, 0, 8, 0x11), 0, 0],
    { regs: { 5: '0x7', 6: '0x7' }, lastAddr: 0x80100000,
      expectLastAddr: '0x8010000c' }),
  // A core that does not export &delay_slot cannot be made safe, so the
  // emitter must compile NOTHING rather than install an unguarded block.
  T('no &delay_slot param => the whole span is refused',
    [I(OPC.ADDIU, 0, 8, 0x11), 0],
    { opts: { noDelaySlot: true }, expectRefused: true }),
];

let fail = 0;
for (const t of tests) {
  if (!t.ok) fail++;
  console.log(`${t.ok ? 'PASS' : 'FAIL'}  ${t.name}${t.ok ? '' : '   ' + t.detail}`);
}
console.log(JSON.stringify({ source: SRCFILE, total: tests.length, failures: fail }));
process.exit(fail ? 1 : 0);

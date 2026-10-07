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

const SRCFILE = process.argv.slice(2).find((a) => !a.startsWith('--')) || new URL('../n64/bementalJIT/mips_emit.js', import.meta.url).pathname;
const src = fs.readFileSync(SRCFILE, 'utf8');

// --- synthetic guest layout (byte addresses inside the fake linear memory) ---
const SRC = 0x10000, ENTRY = 0x20000, STRIDE = 32;
const REG = 0x40000, HI = 0x40100, LO = 0x40108;
const PCG = 0x40200, LASTADDR = 0x40204, NEXTINT = 0x40208, SKIPJ = 0x40210, JTA = 0x40214, ACTUALA = 0x40218;
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
  // table[7] = a gen_interrupt that changes NOTHING (a masked VI: the core's
  // retro_return ends the frame without moving PC) when opts.genIntNoop
  if (opts.genIntNoop) {
    const nb = [0x00, 0x0b];
    const nm = new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
      ...sec(1, [1, 0x60, 0, 0]), ...sec(3, [1, 0]), ...sec(7, [1, 1, 0x66, 0x00, 0x00]),
      ...sec(10, [1, ...leb(nb.length), ...nb])]));
    table.set(7, new WebAssembly.Instance(nm, {}).exports.f);
  }
  // table[6] = an interpreter op that WRITES a guest register through reg[]
  // (reg[incReg] += 1, then PC += STRIDE), installed at the span indices in
  // opts.opsAt. Pinning's contract: reg[] is current BEFORE the op runs (the
  // op reads it) and the local is re-synced AFTER (the op wrote it).
  if (opts.incReg !== undefined) {
    const ra = leb(REG + opts.incReg * 8);
    const ib = [0x00, 0x41, 0x00, 0x41, 0x00, 0x29, 0x03, ...ra, 0x42, 0x01, 0x7c, 0x37, 0x03, ...ra,
                0x41, 0x00, 0x41, 0x00, 0x28, 0x02, ...leb(PCG), 0x41, STRIDE, 0x6a, 0x36, 0x02, ...leb(PCG), 0x0b];
    const im = new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
      ...sec(1, [1, 0x60, 0, 0]), ...sec(2, [1, 1, 0x65, 1, 0x6d, 0x02, 0x00, 0x00]),
      ...sec(3, [1, 0]), ...sec(7, [1, 1, 0x66, 0x00, 0x00]), ...sec(10, [1, ...leb(ib.length), ...ib])]));
    table.set(6, new WebAssembly.Instance(im, { e: { m: mem } }).exports.f);
  }

  for (let i = 0; i < words.length; i++) HEAPU32[(SRC >> 2) + i] = words[i] >>> 0;
  for (let i = 0; i < words.length + 4; i++) HEAPU32[(ENTRY + i * STRIDE) >> 2] = 1;
  for (const [i, v] of Object.entries(opts.opsAt || {})) HEAPU32[(ENTRY + (+i) * STRIDE) >> 2] = v;
  // recompile_block's calloc'd tail: a span that runs past its page ends on an
  // entry the compile never wrote (see PAGE-END TRUNCATION in the emitter)
  if (opts.nullOpsFrom !== undefined) for (let i = opts.nullOpsFrom; i < words.length + 4; i++) HEAPU32[(ENTRY + i * STRIDE) >> 2] = 0;
  HEAPU32[NEXTINT >> 2] = opts.nextInt !== undefined ? opts.nextInt >>> 0 : 0xffffffff;   // default: next_interrupt never due
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
  // invalid_code[]: every page a DATA page (1) — the common case for a store — unless the case
  // models a code page (opts.codePages: [page, ...] stay 0, blocks[page] a block of compiled ops).
  // A store into a code page is CHECK_MEMORY's cold exit (mips_emit.js checkMemoryBytes).
  new Uint8Array(mem.buffer).fill(1, INVALID, INVALID + 0x100000);
  for (const pg of opts.codePages || []) {
    new Uint8Array(mem.buffer)[INVALID + pg] = 0;
    HEAPU32[(BLOCKS >> 2) + pg] = 0x500000 + pg * 16; HEAPU32[(0x500000 + pg * 16) >> 2] = 0x510000;
    for (let k = 0; k < 1024; k++) HEAPU32[(0x510000 + k * STRIDE) >> 2] = 5;   // every op compiled (not NOTCOMPILED 0x99)
  }
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
    blockStart: 0x80100000, blockEnd: 0x80100000 + (opts.pageLen !== undefined ? opts.pageLen : words.length) * 4,
    lastAddr: LASTADDR, nextInt: NEXTINT, count: COUNT, cpo: 2, skipJump: SKIPJ, genInt: opts.genIntNoop ? 7 : 1,
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
  // JUMP_TO IN-MODULE (mips_emit.js jtHelper): opts.actual = { pages: { page: mirrorInvalid } }
  // gives the emitter &actual and models each listed page as VALID (invalid_code 0), with a
  // precomp block whose entry k holds addr = page base + 4k; its KSEG1/KSEG0 mirror page gets
  // invalid_code `mirrorInvalid`. jump_to_func stays table[1] (the PC += STRIDE stub), so a case
  // can tell which path ran.
  if (opts.actual) {
    p.actualPtr = ACTUALA;
    HEAPU32[ACTUALA >> 2] = 0xdead0000;
    let n = 0;
    for (const [pgs, mir] of Object.entries(opts.actual.pages || {})) {
      const pg = +pgs, blk = 0x5a0000 + n * 0x8000, st = 0x700000 + n * 16; n++;
      new Uint8Array(mem.buffer)[INVALID + pg] = 0;
      new Uint8Array(mem.buffer)[INVALID + ((pg ^ 0x20000) >>> 0)] = mir;
      HEAPU32[(BLOCKS >> 2) + pg] = st; HEAPU32[st >> 2] = blk; HEAPU32[(st >> 2) + 1] = (pg * 4096) >>> 0; HEAPU32[(st >> 2) + 2] = (pg * 4096 + 4096) >>> 0;
      for (let k = 0; k < 1024; k++) HEAPU32[(blk + k * STRIDE + 4) >> 2] = (pg * 4096 + k * 4) >>> 0;
    }
  }
  // entryOff: the span starts `entryOff` words into the page (words[] is the
  // whole page), the way recompile_block hands over any entry past offset 0
  if (opts.entryOff) {
    const k = opts.entryOff;
    p.vaddr += k * 4; p.entryPtr += k * STRIDE; p.srcPtr += k * 4; p.span -= k;
    HEAPU32[PCG >> 2] = ENTRY + k * STRIDE;
  }
  return { mem, table, HEAPU32, REG64, p };
}

// `--pin` runs the WHOLE corpus with register pinning on (window.__jitPin);
// cases that pin opts.pin themselves. CI should run it both ways.
const PIN_ALL = process.argv.includes('--pin');
// `--nocold` runs the WHOLE corpus with every slow arm inline (?jitcold=0, mips_emit.js COLD
// PATHS); cases that set opts.noCold do so themselves. CI should run it both ways.
const NOCOLD_ALL = process.argv.includes('--nocold');
const CHAIN_ALL = process.argv.includes('--chain');
function loadEmitter(pin, noCold, cold, chain) {
  const sb = { WebAssembly, console: { error() {}, log() {}, warn() {} }, Uint32Array, Object, Array, Math, String };
  sb.window = sb; sb.__jitPin = !!(pin || (PIN_ALL && pin !== false));   // pin === false: this case opts out of --pin
  // CHAINING is off unless asked for: a chained exit runs the stub op at PC, which the
  // corpus's exit expectations (PC, regs) do not model; `--chain` runs everything chained
  sb.__fbAsync = { jitCold: !(noCold || (NOCOLD_ALL && !cold)), jitChain: !!(chain || CHAIN_ALL) };
  vm.createContext(sb); vm.runInContext(src, sb);
  return sb.bementalMips;
}

// run one case: seed regs/dram, emit, execute, compare
function T(name, words, { regs = {}, dram = {}, expectRegs = {}, expectDram = {}, expectStats = null, opts = {},
                          fprF32 = {}, fprF64 = {}, fprI32 = {}, fprI64 = {}, fcr31 = 0, expectFcr31 = null,
                          expectFprI32 = {}, expectFprI64 = {}, expectFprF32 = {}, expectFprF64 = {},
                          expectRefused = false, expectPC = null, expectLastAddr = null, expectCount = null,
                          lastAddr = null, enterAt = 0, skipJump = 0, expectInvalid = {},
                          expectActual = null, expectJTA = null }) {
  const bm = loadEmitter(opts.pin, opts.noCold, opts.cold, opts.chain);
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
  if (skipJump) HEAPU32[SKIPJ >> 2] = skipJump >>> 0;
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
  const bad = [];
  // enterAt: enter through the op INSTALLED at that span index (a label
  // entry), the way the dispatcher's `PC->ops()` would — PC points at it
  let fnIdx = idx;
  if (enterAt) {
    fnIdx = HEAPU32[(ENTRY + enterAt * STRIDE) >> 2];
    HEAPU32[PCG >> 2] = ENTRY + enterAt * STRIDE;
    if (fnIdx === 1) bad.push(`no entry installed at index ${enterAt} (ops still the interpreter stub)`);
  }
  if (!bad.length) { try { table.get(fnIdx)(); } catch (e) { threw = String(e).slice(0, 120); } }
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
  for (const [pg, want] of Object.entries(expectInvalid)) {
    const got = new Uint8Array(mem.buffer)[INVALID + (+pg)];
    if (got !== want) bad.push(`invalid_code[0x${(+pg).toString(16)}]=${got} want ${want}`);
  }
  if (expectActual !== null) {
    const got = '0x' + (HEAPU32[ACTUALA >> 2] >>> 0).toString(16);
    if (got !== expectActual) bad.push(`actual=${got} want ${expectActual}`);
  }
  if (expectJTA !== null) {
    const got = '0x' + (HEAPU32[JTA >> 2] >>> 0).toString(16);
    if (got !== expectJTA) bad.push(`jump_to_address=${got} want ${expectJTA}`);
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


// Reference for ROUND/CVT: fpu.h + the guard LLVM emitted in the shipped
// binary (see the wave-11a note in the emitter). mode: 0 round (roundf, half
// away), 1 trunc, 2 ceil, 3 floor.
function refRound(x, mode) {
  if (mode === 1) return Math.trunc(x);
  if (mode === 2) return Math.ceil(x);
  if (mode === 3) return Math.floor(x);
  const t = Math.trunc(x);
  return Math.abs(x - t) >= 0.5 ? t + (x < 0 ? -1 : 1) : t;
}
function refW(x, mode) { const r = refRound(x, mode); return (Math.abs(r) < 2147483648) ? ('0x' + ((r | 0) >>> 0).toString(16)) : '0x80000000'; }
function refL(x, mode) {
  const r = refRound(x, mode);
  if (!(Math.abs(r) < 9223372036854775808)) return '0x8000000000000000';
  return '0x' + BigInt.asUintN(64, BigInt(r)).toString(16);
}
function cvtCases() {
  const vals = [2.5, -2.5, 0.5, -0.5, 1.5, -1.49, 3.7, -3.7, 0, -0, 1e10, -1e10, 2147483520, 8388607.5,
                NaN, Infinity, -Infinity, 1e30];
  const out = [];
  for (const S of [true, false]) {
    for (const W of [true, false]) {
      const fmt = S ? FMT.S : FMT.D, sfx = (W ? 'W' : 'L') + '.' + (S ? 'S' : 'D');
      const conv = (x) => S ? Math.fround(x) : x;
      const exp = (x, m) => W ? refW(conv(x), m) : refL(conv(x), m);
      // ROUND.*: one block per value
      for (const v of vals) {
        out.push(T(`ROUND.${sfx}(${v})`, [C1(fmt, 1, 2, W ? FN.ROUND_W : FN.ROUND_L)],
          { [S ? 'fprF32' : 'fprF64']: { 1: v }, [W ? 'expectFprI32' : 'expectFprI64']: { 2: exp(v, 0) },
            expectStats: { nativeFPCvt: 1, fallbackOps: 0 } }));
      }
      // CVT.*: every FCR31 rounding mode, FCR31 carrying unrelated bits too
      for (const m of [0, 1, 2, 3]) for (const v of [2.5, -2.5, -0.5, 3.7, -3.7, NaN, 1e30]) {
        out.push(T(`CVT.${sfx}(${v}) mode ${m}`, [C1(fmt, 1, 2, W ? FN.CVT_W : FN.CVT_L)],
          { fcr31: 0x01800000 | m, [S ? 'fprF32' : 'fprF64']: { 1: v }, [W ? 'expectFprI32' : 'expectFprI64']: { 2: exp(v, m) },
            expectFcr31: '0x' + ((0x01800000 | m) >>> 0).toString(16), expectStats: { nativeFPCvt: 1, fallbackOps: 0 } }));
      }
    }
  }
  return out;
}

const V = '0xdeadbeef12345678';
const SLOW_ADDR = '0xffffffffa0000000';   // dispatch entry is not *_rdram => slow arm
const HIT_ADDR = '0x100000';              // dispatch entry is *_rdram      => fast arm

const tests = [
  // ---- join contract: value register (rt) on a store's SLOW arm ----
  // RED before 2026-08-29: rt's load prologue was emitted only inside the
  // fast arm, so the slow arm left the local at zero and the following read
  // of rt saw 0.
  // 2026-09-30: a store's slow arm now HANDS BACK to the dispatcher (an MI
  // write can run gen_interrupt and end the frame without moving PC —
  // mi_controller.c:105), so the next op is not run in-block. What these
  // pin is unchanged: rt (and, for rs==rt, the address register) must still
  // hold its value in reg[] when control leaves, and PC must be the next op.
  T('SW slow arm: rt survives, block hands back at the next op', [I(OPC.SW, 4, 8, 0x18), OR(10, 8, 0)],
    { regs: { 4: SLOW_ADDR, 8: V }, expectRegs: { 8: V, 10: '0x0' }, expectPC: ENTRY + STRIDE }),
  T('SD slow arm: rt survives, block hands back at the next op', [I(OPC.SD, 4, 8, 0x18), OR(10, 8, 0)],
    { regs: { 4: SLOW_ADDR, 8: V }, expectRegs: { 8: V, 10: '0x0' }, expectPC: ENTRY + STRIDE }),
  T('SB slow arm: rt survives, block hands back at the next op', [I(OPC.SB, 4, 8, 0x18), OR(10, 8, 0)],
    { regs: { 4: SLOW_ADDR, 8: V }, expectRegs: { 8: V, 10: '0x0' }, expectPC: ENTRY + STRIDE }),
  // rs == rt: the ADDRESS itself was computed from the unassigned local
  T('SW slow arm, rs==rt', [I(OPC.SW, 8, 8, 0x18), OR(10, 8, 0)], { regs: { 8: V }, expectRegs: { 8: V }, expectPC: ENTRY + STRIDE }),
  T('SD slow arm, rs==rt', [I(OPC.SD, 8, 8, 0x18), OR(10, 8, 0)], { regs: { 8: V }, expectRegs: { 8: V }, expectPC: ENTRY + STRIDE }),
  // a dirty register written BEFORE the store must be flushed on that exit
  T('store slow arm flushes a register dirtied earlier in the block',
    [I(OPC.ADDIU, 9, 9, 1), I(OPC.SW, 4, 8, 0x18), 0],
    { regs: { 4: SLOW_ADDR, 9: '0x10' }, expectRegs: { 9: '0x11' }, expectPC: ENTRY + 2 * STRIDE }),
  // MTC0 runs gen_interrupt inline (Count/Status): its fallback hands back too
  T('MTC0 fallback hands back to the dispatcher', [MTC0(8, 12), I(OPC.ADDIU, 0, 9, 5), 0],
    { expectRegs: { 9: '0x0' }, expectPC: ENTRY + STRIDE }),
  // ...and the op after it is a LABEL, so the dispatcher's next PC->ops()
  // re-enters native code instead of interpreting the rest of the span
  T('the op after an MTC0 fallback is an enterable label', [MTC0(8, 12), I(OPC.ADDIU, 0, 9, 5), 0],
    { enterAt: 1, expectRegs: { 9: '0x5' }, expectStats: { labelEntries: 1 } }),
  T('SWL fallback hands back; the next op is an enterable label', [I(0x2a, 4, 8, 0x18), I(OPC.ADDIU, 0, 9, 7), 0],
    { expectRegs: { 9: '0x0' }, expectPC: ENTRY + STRIDE, expectStats: { labelEntries: 1 } }),
  T('control: a native SW adds no label after itself', [I(OPC.SW, 4, 8, 0x18), I(OPC.ADDIU, 0, 9, 5), 0],
    { regs: { 4: HIT_ADDR }, opts: { rdramHit: true }, expectRegs: { 9: '0x5' }, expectStats: { labelEntries: undefined } }),
  T('control (?jitcold=0): a LOAD slow arm still continues in-block', [I(OPC.LW, 4, 8, 0x18), I(OPC.ADDIU, 0, 9, 5), 0],
    { regs: { 4: SLOW_ADDR }, expectRegs: { 9: '0x5' }, opts: { noCold: true } }),
  // COLD PATHS: the slow arm is out of line and returns to the dispatcher after its op, with
  // PC at the next instruction (the stub op advanced it) and nothing after it run
  T('cold: a LOAD slow arm hands back at the next instruction', [I(OPC.LW, 4, 8, 0x18), I(OPC.ADDIU, 0, 9, 5), 0],
    { regs: { 4: SLOW_ADDR }, expectRegs: { 9: '0x0' }, expectPC: ENTRY + STRIDE, opts: { cold: true } }),
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

  // ---- ROUND.* and CVT.W/L.* native (2026-09-30) ----
  // These USED to be pinned as must-fall-back: ROUND because the binary's
  // roundf is half-AWAY-from-zero (f32.nearest is half-to-even), CVT because
  // it dispatches on FCR31&3 and FCR31's address was not in the param block.
  // The emitter now open-codes roundf exactly and reads FCR31 (wave 11b put
  // its address in the block), so they are VALUE tests against a reference
  // of fpu.h + the LLVM guard: r = round(x); |r| < 2^k ? (int)r : INT_MIN.
  // The .5 rows are the ones f32.nearest gets wrong (2.5 -> 2, -0.5 -> -0).
  ...cvtCases(),
  // without FCR31 the CVT forms cannot dispatch and must still fall back;
  // ROUND does not read FCR31 and stays native
  // CFC1 $31 writes ONLY the low word of rt (rrt32): the high half survives
  T('CFC1 rt, $31 replaces the LOW word and keeps the high word',
    [((0x11 << 26) | (0x02 << 21) | (9 << 16) | (31 << 11)) >>> 0, OR(10, 9, 0)],
    { fcr31: 0x01800003, regs: { 9: '0xdeadbeef12345678' },
      expectRegs: { 9: '0xdeadbeef01800003', 10: '0xdeadbeef01800003' }, expectStats: { fallbackOps: 0 } }),
  T('CFC1 with CU1 clear still hands back to the interpreter',
    [((0x11 << 26) | (0x02 << 21) | (9 << 16) | (31 << 11)) >>> 0],
    { fcr31: 0x01800003, regs: { 9: '0x5' }, opts: { cu1: false }, expectRegs: { 9: '0x5' } }),
  T('CFC1 rt, $0 (FCR0) stays a fallback', [((0x11 << 26) | (0x02 << 21) | (9 << 16) | (0 << 11)) >>> 0],
    { expectStats: { fallbackOps: 1 } }),
  T('CVT.W.S without &FCR31 still FALLS BACK', [C1(FMT.S, 1, 2, FN.CVT_W)],
    { opts: { noFcr31: true }, expectStats: { nativeFPCvt: 0, fallbackOps: 1 } }),
  T('ROUND.W.S without &FCR31 is still native', [C1(FMT.S, 1, 2, FN.ROUND_W)],
    { opts: { noFcr31: true }, fprF32: { 1: 2.5 }, expectFprI32: { 2: '0x3' },
      expectStats: { nativeFPCvt: 1, fallbackOps: 0 } }),
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
  // ---- skip_jump (2026-10-03: SKIP_JUMP AT ENTRY in the emitter) ----
  // skip_jump != 0 (an exception was taken in a delay slot) makes DECLARE_JUMP behave as NOT
  // taken. It cannot change while native code runs, so the emitter tests it once, at entry: a
  // block entered with it set runs its entry's ORIGINAL interpreter op (the stub: PC += stride)
  // and returns, exactly as for a delay-slot entry — no native branch, no last_addr/Count write.
  // RED against an emitter that drops the test (the branch is taken natively: r10 = 0x33).
  T('skip_jump set at entry: the block runs its entry op only',
    [I(OPC.BEQ, 5, 6, 3), I(OPC.ADDIU, 0, 9, 2), I(OPC.ADDIU, 0, 8, 0x11), 0, I(OPC.ADDIU, 0, 10, 0x33), 0],
    { regs: { 5: '0x7', 6: '0x7' }, lastAddr: 0x80100000, skipJump: 0x80100004,
      expectRegs: { 8: '0x0', 9: '0x0', 10: '0x0' }, expectPC: ENTRY + STRIDE,
      expectLastAddr: '0x80100000', expectCount: '0x0' }),
  T('control: skip_jump clear, the same BEQ is taken in-span',
    [I(OPC.BEQ, 5, 6, 3), I(OPC.ADDIU, 0, 9, 2), I(OPC.ADDIU, 0, 8, 0x11), 0, I(OPC.ADDIU, 0, 10, 0x33), 0],
    { regs: { 5: '0x7', 6: '0x7' }, lastAddr: 0x80100000,
      expectRegs: { 8: '0x0', 9: '0x2', 10: '0x33' }, expectPC: ENTRY + 6 * STRIDE,
      expectLastAddr: '0x80100010', expectCount: '0x4' }),
  T('skip_jump set at a LABEL entry: that label\'s op only',
    [I(OPC.ADDIU, 0, 1, 3), I(OPC.ADDIU, 2, 2, 1), I(OPC.ADDIU, 1, 1, 0xffff), I(OPC.BNE, 1, 0, 0xfffd), 0, I(OPC.ADDIU, 0, 3, 7), 0],
    { enterAt: 1, regs: { 1: '0x2' }, lastAddr: 0x80100000, skipJump: 0x80100010,
      expectRegs: { 1: '0x2', 2: '0x0', 3: '0x0' }, expectPC: ENTRY + 2 * STRIDE,
      expectLastAddr: '0x80100000', expectCount: '0x0' }),
  T('skip_jump set at entry of a pinned loop: the guard runs before the prologue',
    [I(OPC.ADDIU, 0, 1, 3), I(OPC.ADDIU, 2, 2, 1), I(OPC.ADDIU, 1, 1, 0xffff), I(OPC.BNE, 1, 0, 0xfffd), I(OPC.ADDIU, 3, 3, 1), 0, 0],
    { opts: { pin: true }, regs: { 1: '0x9', 2: '0x4' }, lastAddr: 0x80100000, skipJump: 0x80100010,
      expectRegs: { 1: '0x9', 2: '0x4', 3: '0x0' }, expectPC: ENTRY + STRIDE, expectLastAddr: '0x80100000' }),
  T('skip_jump set at entry of a J-out block: no jump_to, entry op only',
    [JOUT(0x80200000), I(OPC.ADDIU, 0, 9, 2), I(OPC.ADDIU, 0, 8, 0x11), 0],
    { lastAddr: 0x80100000, skipJump: 0x80100004, opts: { pageLen: 1024 },
      expectRegs: { 8: '0x0', 9: '0x0' }, expectPC: ENTRY + STRIDE, expectLastAddr: '0x80100000', expectCount: '0x0' }),
  // ---- JUMP_TO IN-MODULE (2026-10-03): the module does jump_to_func's common case ----
  // A J out of the page into a VALID page: actual = blocks[page], PC = block + (t - start)/4,
  // last_addr = that entry's addr, and jump_to_func (the stub, which would add one STRIDE)
  // never runs. RED on an emitter without the helper: it calls the stub (PC = ENTRY + STRIDE).
  // (cold paths on in every mode: a module of its own carries the helper only with them)
  T('jump_to in-module: J out into a valid page sets actual and PC like jump_to_func',
    [JOUT(0x80200040), I(OPC.ADDIU, 0, 9, 2), 0],
    { opts: { cold: true, actual: { pages: { 0x80200: 0 } }, pageLen: 1024 }, lastAddr: 0x80100000,
      expectRegs: { 9: '0x2' }, expectActual: '0x700000', expectPC: 0x5a0000 + 16 * STRIDE,
      expectLastAddr: '0x80200040', expectInvalid: { 0x80200: 0, 0xa0200: 0 } }),
  T('jump_to in-module: a JR $ra into a valid KSEG1 page',
    [R(31, 0, 0, 0, 0x08), I(OPC.ADDIU, 0, 9, 3), 0],
    { regs: { 31: '0xffffffffa0200008' }, opts: { cold: true, actual: { pages: { 0xa0200: 0 } }, pageLen: 1024 }, lastAddr: 0x80100000,
      expectRegs: { 9: '0x3' }, expectActual: '0x700000', expectPC: 0x5a0000 + 2 * STRIDE, expectLastAddr: '0xa0200008' }),
  // the mirror line of update_invalid_addr: an invalid KSEG1 twin invalidates the page, and the
  // page to (re)initialise is jump_to_func's (the stub ran: PC moved one STRIDE from ENTRY)
  T('jump_to in-module: an invalid mirror page marks the target invalid and calls jump_to_func',
    [JOUT(0x80200040), 0, 0],
    { opts: { cold: true, actual: { pages: { 0x80200: 1 } }, pageLen: 1024 }, lastAddr: 0x80100000,
      expectActual: '0xdead0000', expectJTA: '0x80200040', expectInvalid: { 0x80200: 1, 0xa0200: 1 } }),
  T('jump_to in-module: a TLB-mapped target is jump_to_func\'s',
    [R(8, 0, 0, 0, 0x08), 0, 0],
    { regs: { 8: '0x400040' }, opts: { cold: true, actual: { pages: { 0x80200: 0 } }, pageLen: 1024 }, lastAddr: 0x80100000,
      expectActual: '0xdead0000', expectJTA: '0x400040' }),
  // ---- CHECK_MEMORY on a CODE page (invalid_code 0, every op compiled) ----
  // The store is done, the probe marks the page invalid, and the block continues.
  T('store into a CODE page: stored, page marked invalid, block continues',
    [I(OPC.ADDIU, 0, 9, 5), I(OPC.SW, 4, 9, 0x18), I(OPC.ADDIU, 0, 10, 7), 0],
    { regs: { 4: HIT_ADDR }, opts: { rdramHit: true, codePages: [0x100] },
      expectRegs: { 9: '0x5', 10: '0x7' }, expectDram: { 0x100018: '0x5' }, expectPC: ENTRY + 4 * STRIDE,
      expectInvalid: { 0x100: 1 } }),
  T('control: the same store into a DATA page leaves invalid_code alone',
    [I(OPC.ADDIU, 0, 9, 5), I(OPC.SW, 4, 9, 0x18), I(OPC.ADDIU, 0, 10, 7), 0],
    { regs: { 4: HIT_ADDR }, opts: { rdramHit: true },
      expectRegs: { 9: '0x5', 10: '0x7' }, expectDram: { 0x100018: '0x5' }, expectPC: ENTRY + 4 * STRIDE,
      expectInvalid: { 0x100: 1 } }),
  T('a delay-slot store into a CODE page marks it and completes its branch',
    [I(OPC.BEQ, 0, 0, 3), I(OPC.SW, 4, 9, 0x18), I(OPC.ADDIU, 0, 10, 7), 0, I(OPC.ADDIU, 0, 11, 3), 0],
    { regs: { 4: HIT_ADDR, 9: '0x6' }, opts: { rdramHit: true, codePages: [0x100] }, lastAddr: 0x80100000,
      expectRegs: { 10: '0x0', 11: '0x3' }, expectDram: { 0x100018: '0x6' }, expectPC: ENTRY + 6 * STRIDE,
      expectInvalid: { 0x100: 1 } }),
  T('control: the SAME branch with delay_slot clear DOES move last_addr',
    [I(OPC.BEQ, 5, 6, 2), 0, I(OPC.ADDIU, 0, 8, 0x11), 0, 0],
    { regs: { 5: '0x7', 6: '0x7' }, lastAddr: 0x80100000,
      expectLastAddr: '0x8010000c' }),
  // A core that does not export &delay_slot cannot be made safe, so the
  // emitter must compile NOTHING rather than install an unguarded block.
  T('no &delay_slot param => the whole span is refused',
    [I(OPC.ADDIU, 0, 8, 0x11), 0],
    { opts: { noDelaySlot: true }, expectRefused: true }),

  // ---- MULTI-ENTRY SPANS + PAGE-END TRUNCATION (2026-09-30) ----
  // Before: only the span ENTRY was native. A PLAIN branch to any other
  // in-span index EXITED to the dispatcher, whose `PC->ops()` there was the
  // interpreter op, so the rest ran on the cached interpreter; and a JAL's
  // return point (reached by the callee's JR) was interpreter-only.
  // RED against the pre-change emitter: the forward/backward/multi-segment
  // cases (it exits at the branch: wrong PC, later regs unwritten), every
  // enterAt case (no entry installed), and the truncation case (refused).
  T('in-span FORWARD branch stays native (no exit at the branch)',
    [I(OPC.BEQ, 0, 0, 2), I(OPC.ADDIU, 0, 8, 0x11), I(OPC.ADDIU, 0, 9, 0x22), I(OPC.ADDIU, 0, 10, 0x33), 0],
    { expectRegs: { 8: '0x11', 9: '0x0', 10: '0x33' }, expectPC: ENTRY + 5 * STRIDE,
      // labels: the target (3) and the not-taken fall-through (2)
      expectLastAddr: '0x8010000c', expectCount: '0x4', expectStats: { labelEntries: 2 } }),
  T('in-span BACKWARD branch to a non-entry label loops natively',
    [I(OPC.ADDIU, 0, 1, 3), I(OPC.ADDIU, 2, 2, 1), I(OPC.ADDIU, 1, 1, 0xffff), I(OPC.BNE, 1, 0, 0xfffd), 0, I(OPC.ADDIU, 0, 3, 7), 0],
    { expectRegs: { 1: '0x0', 2: '0x3', 3: '0x7' }, expectPC: ENTRY + 7 * STRIDE }),
  T('BNEL backward to a label: slot runs only on the taken iterations',
    [I(OPC.ADDIU, 0, 1, 2), I(OPC.ADDIU, 2, 2, 1), I(OPC.ADDIU, 1, 1, 0xffff), I(OPC.BNEL, 1, 0, 0xfffd), I(OPC.ADDIU, 3, 3, 5), 0],
    { expectRegs: { 1: '0x0', 2: '0x2', 3: '0x5' }, expectPC: ENTRY + 6 * STRIDE }),
  // three segments: forward seg0->seg1, forward seg1->seg2, backward seg2->seg1
  T('three segments: forward, forward, and a backward re-dispatch',
    [I(OPC.BEQ, 0, 0, 2), 0, I(OPC.ADDIU, 0, 9, 0x99),
     I(OPC.ADDIU, 8, 8, 1),
     I(OPC.BEQ, 0, 0, 2), 0, I(OPC.ADDIU, 0, 9, 0x77),
     I(OPC.ADDIU, 0, 10, 0x55),
     I(OPC.BNE, 8, 11, 0xfffa), 0, 0],
    // labels: targets 3 and 7, fall-throughs 2, 6 and 10
    { regs: { 11: '0x3' }, expectRegs: { 8: '0x3', 9: '0x0', 10: '0x55' }, expectPC: ENTRY + 11 * STRIDE,
      expectStats: { labelEntries: 5 } }),
  T('a label is ENTERABLE: its installed op runs from the label',
    [I(OPC.ADDIU, 0, 1, 3), I(OPC.ADDIU, 2, 2, 1), I(OPC.ADDIU, 1, 1, 0xffff), I(OPC.BNE, 1, 0, 0xfffd), 0, I(OPC.ADDIU, 0, 3, 7), 0],
    { enterAt: 1, regs: { 1: '0x2' }, expectRegs: { 1: '0x0', 2: '0x2', 3: '0x7' }, expectPC: ENTRY + 7 * STRIDE }),
  T('a label entered as a DELAY SLOT runs its ONE original op',
    [I(OPC.ADDIU, 0, 1, 3), I(OPC.ADDIU, 2, 2, 1), I(OPC.ADDIU, 1, 1, 0xffff), I(OPC.BNE, 1, 0, 0xfffd), 0, I(OPC.ADDIU, 0, 3, 7), 0],
    { enterAt: 1, opts: { inDelaySlot: true }, regs: { 1: '0x2' }, lastAddr: 0x80100000,
      expectRegs: { 1: '0x2', 2: '0x0', 3: '0x0' }, expectPC: ENTRY + 2 * STRIDE,
      expectLastAddr: '0x80100000', expectCount: '0x0' }),
  T('a JAL return point (addr+8) becomes an entry',
    [((0x03 << 26) | ((0x80200000 >>> 2) & 0x3ffffff)) >>> 0, 0, I(OPC.ADDIU, 0, 5, 9), 0],
    { enterAt: 2, expectRegs: { 5: '0x9' }, expectPC: ENTRY + 4 * STRIDE }),
  // control: a target that is the DELAY SLOT of another branch gets no label,
  // so that branch still exits to the dispatcher exactly as before
  T('control: a branch into another branch\'s delay slot still exits there',
    [I(OPC.ADDIU, 0, 8, 1), I(OPC.BEQ, 5, 6, 3), I(OPC.ADDIU, 0, 9, 2), I(OPC.BEQ, 0, 0, 0xfffe), 0, I(OPC.ADDIU, 0, 10, 3), 0],
    // labels: 5 (target of idx 1) and 3 (its fall-through); NOT 2
    { regs: { 5: '0x1', 6: '0x2' }, expectRegs: { 8: '0x1', 9: '0x2', 10: '0x0' }, expectPC: ENTRY + 2 * STRIDE,
      expectStats: { labelEntries: 2 } }),
  // the interrupt poll still runs on a NATIVE in-span branch: with
  // next_interrupt due, gen_interrupt (the stub: PC += stride) moves PC off
  // the target and the block exits there instead of continuing
  T('in-span branch still polls next_interrupt and exits when PC moves',
    [I(OPC.BEQ, 0, 0, 2), I(OPC.ADDIU, 0, 8, 0x11), I(OPC.ADDIU, 0, 9, 0x22), I(OPC.ADDIU, 0, 10, 0x33), 0],
    { opts: { nextInt: 0 }, expectRegs: { 8: '0x11', 10: '0x0' }, expectPC: ENTRY + 4 * STRIDE }),
  // (a) from ANOTHER span: a branch earlier in the page (outside this span)
  // targets an index inside it — IDO's `j cond` loop shape
  T('a same-page branch from OUTSIDE the span makes its target an entry',
    [I(OPC.BEQ, 0, 0, 2), 0, I(OPC.ADDIU, 0, 8, 1), I(OPC.ADDIU, 0, 9, 2), 0],
    { opts: { entryOff: 2 }, enterAt: 3, expectRegs: { 8: '0x0', 9: '0x2' }, expectPC: ENTRY + 5 * STRIDE,
      expectStats: { labelEntries: 1 } }),
  // ---- doubleword ALU + SYNC/CACHE native (2026-09-30) ----
  // Each is checked against the C in mips_instructions.def (cited in the
  // emitter). All were interpreter fallbacks before, so a stub op (PC += stride,
  // writes nothing) would leave every destination at its seed — RED on HEAD.
  T('DSLL32 / DSRL32 / DSRA32',
    [R(0, 8, 9, 4, 0x3c), R(0, 8, 10, 4, 0x3e), R(0, 8, 11, 4, 0x3f), 0],
    { regs: { 8: '0x80000001f0000003' },
      expectRegs: { 9: '0x3000000000', 10: '0x8000000', 11: '0xfffffffff8000000' } }),
  T('DSLL / DSRL / DSRA by 3',
    [R(0, 8, 9, 3, 0x38), R(0, 8, 10, 3, 0x3a), R(0, 8, 11, 3, 0x3b), 0],
    { regs: { 8: '0x80000001f0000003' },
      expectRegs: { 9: '0xf80000018', 10: '0x100000003e000000', 11: '0xf00000003e000000' } }),
  T('DSLLV / DSRLV / DSRAV use rs & 63',
    [R(12, 8, 9, 0, 0x14), R(12, 8, 10, 0, 0x16), R(12, 8, 11, 0, 0x17), 0],
    { regs: { 8: '0x80000001f0000003', 12: '0x44' },   // 0x44 & 63 = 4
      expectRegs: { 9: '0x1f00000030', 10: '0x80000001f000000', 11: '0xf80000001f000000' } }),
  T('DADDU / DSUBU / DADDIU wrap at 64 bits',
    [R(8, 12, 9, 0, 0x2d), R(8, 12, 10, 0, 0x2f), I(0x19, 8, 11, 0xffff), 0],
    { regs: { 8: '0xffffffffffffffff', 12: '0x2' },
      expectRegs: { 9: '0x1', 10: '0xfffffffffffffffd', 11: '0xfffffffffffffffe' } }),
  T('DADDU into r0 is a NOP (recomp.c RNOP), SYNC and CACHE do nothing',
    [R(8, 12, 0, 0, 0x2d), R(0, 0, 0, 0, 0x0f), I(0x2f, 8, 1, 0x10), I(OPC.ADDIU, 0, 9, 7), 0],
    { regs: { 0: '0x0', 8: '0x5', 12: '0x6' }, expectRegs: { 0: '0x0', 9: '0x7' },
      expectStats: { fallbackOps: 0 } }),
  // RED against HEAD's back-edge (and, before the fix, against every native
  // in-span branch): gen_interrupt that leaves PC alone — a VI whose
  // exception is masked still ends the frame via retro_return — must return
  // control to r4300_step, not keep looping into the next frame.
  T('gen_interrupt that does not move PC still returns to the dispatcher',
    [I(OPC.ADDIU, 2, 2, 1), I(OPC.BNE, 2, 3, 0xfffe), 0, I(OPC.ADDIU, 0, 4, 9), 0],
    { regs: { 3: '0x5' }, opts: { nextInt: 0, genIntNoop: true },
      expectRegs: { 2: '0x1', 4: '0x0' }, expectPC: ENTRY }),
  T('a span that runs past its PAGE compiles, and falls through AT the page end',
    [I(OPC.ADDIU, 0, 8, 0x11), I(OPC.ADDIU, 0, 9, 0x22), I(OPC.ADDIU, 0, 10, 0x33), I(OPC.ADDIU, 0, 11, 0x44)],
    { opts: { pageLen: 2, nullOpsFrom: 4 }, expectRegs: { 8: '0x11', 9: '0x22', 10: '0x0', 11: '0x0' },
      expectPC: ENTRY + 2 * STRIDE, expectStats: { pageTruncated: 1 } }),
  T('control: a span ending INSIDE its page is not truncated',
    [I(OPC.ADDIU, 0, 8, 0x11), I(OPC.ADDIU, 0, 9, 0x22), 0],
    { opts: { pageLen: 1024 }, expectRegs: { 8: '0x11', 9: '0x22' }, expectPC: ENTRY + 3 * STRIDE,
      expectStats: { pageTruncated: undefined } }),
];

// ---- RECOMPILE CACHE (2026-09-30) ----
// A recompile of the SAME span (same page words, same precomp ops, same
// addresses) re-installs the cached instance; ANY difference in the key must
// miss. Simulates init_block (ops reset) between the two compiles.
function cacheCase(name, mutate, wantHit) {
  const bm = loadEmitter();
  const words = [I(OPC.ADDIU, 0, 1, 3), I(OPC.ADDIU, 2, 2, 1), I(OPC.ADDIU, 1, 1, 0xffff), I(OPC.BNE, 1, 0, 0xfffd), 0, I(OPC.ADDIU, 0, 3, 7), 0];
  const w = makeWorld(words, {});
  const Mod = { HEAPU32: w.HEAPU32, wasmTable: w.table, wasmMemory: w.mem };
  const i1 = bm.compileSpan(w.p, Mod);
  for (let k = 0; k < words.length + 4; k++) w.HEAPU32[(ENTRY + k * STRIDE) >> 2] = 1;   // init_block
  mutate(w);
  const i2 = bm.compileSpan(w.p, Mod);
  const hits = bm.stats.cacheHits || 0;
  const bad = [];
  if (!(i1 > 0 && i2 > 0)) bad.push(`compile failed ${i1} ${i2}`);
  if ((hits === 1) !== wantHit) bad.push(`cacheHits=${hits} want ${wantHit ? 1 : 0}`);
  // run the second install from label 1 to prove the labels were re-installed
  w.HEAPU32[PCG >> 2] = ENTRY + STRIDE;
  const li = w.HEAPU32[(ENTRY + STRIDE) >> 2];
  if (li === 1) bad.push('label 1 not re-installed');
  else {
    w.REG64[(REG >> 3) + 1] = 2n; w.REG64[(REG >> 3) + 2] = 0n;
    try { w.table.get(li)(); } catch (e) { bad.push('trapped ' + e); }
    const r2 = w.REG64[(REG >> 3) + 2], r3 = w.REG64[(REG >> 3) + 3];
    const want3 = (w.HEAPU32[(SRC >> 2) + 5] === words[5]) ? 7n : 9n;
    if (r2 !== 2n || r3 !== want3) bad.push(`r2=${r2} r3=${r3}`);
  }
  return { name, ok: bad.length === 0, detail: bad.join('; ') };
}
// ---- PINNING (2026-10-01): registers referenced inside a native loop live in
// their locals across the back-edge; reg[] is written on exit / before calls.
{
  const ADDIU = (rt, rs, imm) => I(OPC.ADDIU, rs, rt, imm);
  const BNE = (rs, rt, off) => I(OPC.BNE, rs, rt, off);
  const LWL = (rt, rs, imm) => I(0x22, rs, rt, imm);
  // pinning is OPT-IN (window.__jitPin): every case here turns it on
  const TP = (n, w, c) => T(n, w, { ...c, opts: { ...(c.opts || {}), pin: true } });
  // 0 r8++ | 1 r11++ <- loop | 2 bne r8,r10,1 | 3 (slot) r8++ | 4 nop
  const loop = [ADDIU(8, 8, 1), ADDIU(11, 11, 1), BNE(8, 10, -2), ADDIU(8, 8, 1), 0];
  tests.push(
    TP('pinning: a counted loop runs natively and writes its pinned registers back on exit', loop,
      // BNE tests r8 BEFORE its slot increments it: r8 at the branch runs 1..7
      { regs: { 10: '0x7' }, expectRegs: { 8: '0x8', 11: '0x7', 10: '0x7' }, expectPC: ENTRY + 5 * STRIDE,
        expectStats: { pinnedBlocks: 1, pinnedRegs: 2 } }),
    // the gen_interrupt poll on the first back-edge exits RAW — reg[] must
    // already hold the pinned values (flushAll before the call)
    TP('pinning: an interrupt exit on the back-edge leaves reg[] current', loop,
      { regs: { 10: '0x7' }, opts: { nextInt: 0, genIntNoop: true }, expectRegs: { 8: '0x2', 11: '0x1' } }),
    // a block entered as a DELAY SLOT runs one op and must NOT run the
    // epilogue: the pinned locals were never loaded (they hold zero)
    TP('pinning: the delay-slot entry guard exits before the epilogue', loop,
      { regs: { 8: '0x55', 11: '0x66', 10: '0x7' }, opts: { inDelaySlot: true }, expectRegs: { 8: '0x55', 11: '0x66' } }),
    // an interpreter op inside the loop READS and WRITES pinned r8 through
    // reg[]: 0 r8++ | 1 r11++ <- | 2 LWL (op: reg[8]++) | 3 bne r8,r10 | 4 nop
    TP('pinning: an interpreter op inside the loop sees and updates a pinned register',
      [ADDIU(8, 8, 1), ADDIU(11, 11, 1), LWL(12, 8, 0), BNE(8, 10, -3), 0, 0],
      { regs: { 10: '0x7' }, opts: { incReg: 8, opsAt: { 2: 6 }, nextInt: 400 },
        expectRegs: { 8: '0x7', 11: '0x6' }, expectStats: { pinnedBlocks: 1 } }),
    // a slow STORE hands back RAW mid-loop: reg[] must hold the value the
    // loop computed before it
    TP('pinning: a slow store exit mid-loop leaves reg[] current',
      [ADDIU(8, 8, 1), ADDIU(11, 11, 1), I(OPC.SW, 4, 11, 0x18), BNE(8, 10, -3), ADDIU(8, 8, 1), 0],
      { regs: { 4: SLOW_ADDR, 10: '0x7' }, expectRegs: { 8: '0x1', 11: '0x1' }, expectPC: ENTRY + 3 * STRIDE,
        expectStats: { pinnedBlocks: 1 } }),
    // a loop exit through an OUT jump (JR inside the loop) stores before jump_to
    TP('pinning: a JR out of the loop leaves reg[] current',
      // 0 r8++ | 1 r11++ <- | 2 bne r8,r10,1 | 3 (slot) r8++ | 4 jr $ra | 5 (slot) r11 += 0x10
      [ADDIU(8, 8, 1), ADDIU(11, 11, 1), BNE(8, 10, -2), ADDIU(8, 8, 1), R(31, 0, 0, 0, 0x08), ADDIU(11, 11, 0x10), 0],
      { regs: { 10: '0x3', 31: '0x80200000' }, expectRegs: { 8: '0x4', 11: '0x13' }, expectStats: { pinnedBlocks: 1 } }),
    // an op that WRITES a pinned register and then hands back must exit RAW:
    // the epilogue would store the stale local over the op's result
    TP('pinning: a hand-back after an op that wrote a pinned register skips the epilogue',
      [ADDIU(8, 8, 1), ADDIU(11, 11, 1), MTC0(8, 12), BNE(8, 10, -3), 0, 0],
      { regs: { 10: '0x7' }, opts: { incReg: 8, opsAt: { 2: 6 } }, expectRegs: { 8: '0x2', 11: '0x1' },
        expectPC: ENTRY + 3 * STRIDE, expectStats: { pinnedBlocks: 1 } }),
    // a READ-ONLY pinned register (no native write in the span) is never
    // stored back, so an interpreter op that changes it in reg[] must win:
    // 0 r8++ | 1 r11++ <- | 2 LWL r12,0(r10) (op: reg[10]++) | 3 bne r10,r9 | 4 nop
    TP('pinning: a read-only pinned register follows reg[] across an interpreter op',
      [ADDIU(8, 8, 1), ADDIU(11, 11, 1), LWL(12, 10, 0), BNE(10, 9, -3), 0, 0],
      { regs: { 9: '0x5' }, opts: { incReg: 10, opsAt: { 2: 6 }, nextInt: 400 },
        expectRegs: { 10: '0x5', 11: '0x5', 8: '0x1' }, expectStats: { pinnedBlocks: 1, pinnedRegs: 2 } }),
    // control: no backward branch, no pins — the pre-pinning shape
    TP('control: a span with no loop pins nothing', [ADDIU(8, 8, 1), ADDIU(8, 8, 1), 0],
      { expectRegs: { 8: '0x2' }, expectStats: { pinnedBlocks: undefined } }),
  );
}
tests.push(cacheCase('recompile of an IDENTICAL span re-installs the cached instance (entry + labels)', () => {}, true));
tests.push(cacheCase('control: one changed page word MISSES the cache', (w) => { w.HEAPU32[(SRC >> 2) + 5] = I(OPC.ADDIU, 0, 3, 9); }, false));
tests.push(cacheCase('control: one changed precomp op MISSES the cache', (w) => { w.HEAPU32[(ENTRY + 2 * STRIDE) >> 2] = 2; }, false));

// ---- BATCHED MODULES (2026-10-03): the compile worker emits a batch of offers as ONE module
// (mips_emit.js emitBatch). Each span's code must run exactly as from its own module: the same
// span is emitted alone (compileSpan) and as the SECOND span of a two-span batch, and both are
// run from the entry and from a label (wrapper -> body by function index, the shared segment
// global, the shared CHECK_MEMORY helper at index 0), through a slow store (cold arm) and a
// CHECK_MEMORY probe of a code page.
function batchCase(name, enterAt, slow) {
  // 0 r9++ | 1 r8++ <- label | 2 sw r8,0x18(r4) | 3 bne r8,r10,1 | 4 (slot) r11++ | 5 nop
  const words = [I(OPC.ADDIU, 9, 9, 1), I(OPC.ADDIU, 8, 8, 1), I(OPC.SW, 4, 8, 0x18), I(OPC.BNE, 8, 10, 0xfffd), I(OPC.ADDIU, 11, 11, 1), 0, 0];
  const seed = (w) => {
    w.REG64[(REG >> 3) + 4] = BigInt.asUintN(64, BigInt(slow ? SLOW_ADDR : HIT_ADDR));
    w.REG64[(REG >> 3) + 10] = 5n;
    w.HEAPU32[PCG >> 2] = ENTRY + enterAt * STRIDE;
  };
  const read = (w) => [8, 9, 10, 11].map((r) => w.REG64[(REG >> 3) + r]).join(',') + ' pc=' + w.HEAPU32[PCG >> 2] + ' dram=' + w.HEAPU32[(DRAM + 0x100018) >> 2] + ' inv=' + new Uint8Array(w.mem.buffer)[INVALID + 0x100];
  const opts = { rdramHit: !slow };
  // (a) alone
  const bmA = loadEmitter(false, false, true);       // cold paths, like the batch's jobs
  const wa = makeWorld(words, opts); seed(wa);
  const ia = bmA.compileSpan(wa.p, { HEAPU32: wa.HEAPU32, wasmTable: wa.table, wasmMemory: wa.mem });
  // a code page under the store: CHECK_MEMORY must mark it (blocks[0x100] -> a block whose op is not NOTCOMPILED)
  const codePage = (w) => { w.HEAPU32[(BLOCKS >> 2) + 0x100] = 0x500000; w.HEAPU32[0x500000 >> 2] = 0x510000; w.HEAPU32[(0x510000 + (0x18 >> 2) * STRIDE) >> 2] = 5; new Uint8Array(w.mem.buffer)[INVALID + 0x100] = 0; };
  codePage(wa);
  const fa = enterAt ? wa.HEAPU32[(ENTRY + enterAt * STRIDE) >> 2] : ia;   // the entry is installed by the core (recomp.c), labels by the emitter
  try { wa.table.get(fa)(); } catch (e) { return { name, ok: false, detail: 'alone trapped ' + e }; }
  // (b) second span of a batch, from offer-shaped jobs (asyncOffer)
  const bmB = loadEmitter();
  const wb = makeWorld(words, opts); seed(wb);
  const p = wb.p, pageN = words.length;
  const job = (id) => ({ id, p: Object.assign({}, p), w0: SRC >> 2, words: wb.HEAPU32.slice(SRC >> 2, (SRC >> 2) + pageN + 1),
                         ops: wb.HEAPU32.slice(0, 0).constructor.from({ length: p.span + 2 }, (_, k) => wb.HEAPU32[(ENTRY + k * STRIDE) >> 2]),
                         flags: { noFP: false, noLabels: false, pin: false, cold: true }, tableBase: wb.table.length });
  const r = bmB.emitBatch([job(1), job(2)]);
  if (!r.bytes || r.items.some((it) => !it.ok)) return { name, ok: false, detail: 'batch failed ' + JSON.stringify(r.items.map((it) => it.err || it.ok)) };
  const inst = new WebAssembly.Instance(new WebAssembly.Module(r.bytes), { e: { t: wb.table, m: wb.mem } });
  // LABELS BY PC (cold paths, nfn 1): a label is entered through the body itself, PC at the label
  const it2 = r.items[1], fn = (enterAt && it2.nfn !== 1) ? inst.exports['s' + it2.k + '_' + it2.labels.indexOf(enterAt)] : inst.exports['s' + it2.k];
  if (!fn) return { name, ok: false, detail: 'no export for entry ' + enterAt + ' labels ' + JSON.stringify(it2.labels) };
  codePage(wb);
  try { fn(); } catch (e) { return { name, ok: false, detail: 'batch trapped ' + e }; }
  const A = read(wa), B = read(wb);
  return { name, ok: ia > 0 && A === B, detail: `alone ${A} | batch ${B}` };
}
tests.push(batchCase('batch: a span runs as from its own module (entry, fast store, code-page probe)', 0, false));
tests.push(batchCase('batch: entering at a label (by PC: the body is installed at the label)', 1, false));
tests.push(batchCase('batch: a slow store takes its cold arm and hands back', 0, true));

// ---- CHAINING (2026-10-03): at an exit where nothing that can end the frame ran, the block
// tail-calls PC->ops itself. Differential: the same span compiled with chaining OFF and ON,
// run from the same state. A chained exit must leave EXACTLY what the unchained one left plus
// one run of the op at PC (the harness's stub: PC += STRIDE, nothing else); an exit after a
// taken interrupt poll, a gen_interrupt in a jump_to tail or a fallback that may run
// gen_interrupt (MTC0) must NOT chain (extra = 0): the dispatcher has to check the frame flags.
// `jitAtPC`: every precomp entry still holding the interpreter stub (table[1]) is given a
// copy of it at a JIT-range slot (at or above the table length at the first compile), so a
// chained exit finds a JIT block there; without it the op at PC is an interpreter op, which
// is never chained into.
function chainCase(name, words, { regs = {}, opts = {}, extra, jitAtPC = true }) {
  const run = (chain) => {
    const bm = loadEmitter(false, false, false, chain);
    const w = makeWorld(words, opts);
    for (const [r, v] of Object.entries(regs)) w.REG64[(REG >> 3) + (+r)] = BigInt.asUintN(64, BigInt(v));
    const idx = bm.compileSpan(w.p, { HEAPU32: w.HEAPU32, wasmTable: w.table, wasmMemory: w.mem });
    if (!(idx > 0)) return { err: 'emit failed' };
    if (jitAtPC) {
      const js = w.table.grow(1);
      w.table.set(js, w.table.get(1));
      for (let k = 0; k < words.length + 4; k++) if (w.HEAPU32[(ENTRY + k * STRIDE) >> 2] === 1) w.HEAPU32[(ENTRY + k * STRIDE) >> 2] = js;
    }
    try { w.table.get(idx)(); } catch (e) { return { err: 'trapped ' + e }; }
    const r = []; for (let k = 0; k < 32; k++) r.push(w.REG64[(REG >> 3) + k]);
    return { pc: w.HEAPU32[PCG >> 2], regs: r.join(','), count: w.HEAPU32[COUNT >> 2], last: w.HEAPU32[LASTADDR >> 2], chains: bm.stats };
  };
  const off = run(false), on = run(true);
  if (off.err || on.err) return { name, ok: false, detail: `off ${off.err || 'ok'} on ${on.err || 'ok'}` };
  const ok = on.pc - off.pc === extra * STRIDE && on.regs === off.regs && on.count === off.count && on.last === off.last;
  return { name, ok, detail: `pc off ${off.pc} on ${on.pc} (want +${extra * STRIDE}) regs ${on.regs === off.regs ? 'eq' : 'NE'} count ${off.count}/${on.count}` };
}
tests.push(chainCase('chain: the fall-through exit runs PC->ops once, nothing else changes',
  [I(OPC.ADDIU, 0, 9, 5), I(OPC.ADDIU, 9, 10, 1), 0], { extra: 1 }));
tests.push(chainCase('chain: an in-span branch exit with the poll NOT due chains',
  [I(OPC.BEQ, 0, 0, 0x10), I(OPC.ADDIU, 0, 8, 0x11), I(OPC.ADDIU, 0, 9, 0x22), 0], { extra: 1 }));
tests.push(chainCase('chain: an in-span branch exit with the poll DUE does not chain',
  [I(OPC.BEQ, 0, 0, 0x10), I(OPC.ADDIU, 0, 8, 0x11), I(OPC.ADDIU, 0, 9, 0x22), 0], { opts: { nextInt: 0 }, extra: 0 }));
tests.push(chainCase('chain: a gen_interrupt that leaves PC alone does not chain',
  [I(OPC.ADDIU, 2, 2, 1), I(OPC.BNE, 2, 3, 0xfffe), 0, I(OPC.ADDIU, 0, 4, 9), 0],
  { regs: { 3: '0x5' }, opts: { nextInt: 0, genIntNoop: true }, extra: 0 }));
tests.push(chainCase('chain: a J_OUT tail (jump_to, poll not due) chains',
  [JOUT(0x80200000), 0, I(OPC.ADDIU, 0, 11, 1), 0], { extra: 1 }));
tests.push(chainCase('chain: a J_OUT tail whose gen_interrupt ran does not chain',
  [JOUT(0x80200000), 0, I(OPC.ADDIU, 0, 11, 1), 0], { opts: { nextInt: 0, genIntNoop: true }, extra: 0 }));
tests.push(chainCase('chain: an MTC0 fallback (may run gen_interrupt) hands back without chaining',
  [MTC0(8, 12), I(OPC.ADDIU, 0, 9, 5), 0], { extra: 0 }));
tests.push(chainCase('chain: never INTO an interpreter op (NOTCOMPILED/FIN_BLOCK nest PC->ops)',
  [I(OPC.ADDIU, 0, 9, 5), I(OPC.ADDIU, 9, 10, 1), 0], { extra: 0, jitAtPC: false }));
tests.push(chainCase('chain: into a label entry (its wrapper tail-calls the body)',
  [I(OPC.ADDIU, 0, 9, 5), I(OPC.BEQ, 0, 0, 0x10), 0, 0], { extra: 1 }));

// ---- A PAGE'S SOURCE (2026-10-07, mips_emit.js A PAGE'S SOURCE IS PART OF WHAT A MODULE WAS BUILT
// FROM): an off-thread module is installed at a field end only if what it was built from still
// holds. For a TLB-mapped page that includes WHERE the page is compiled from: a span offered while
// virtual page V mapped to physical P1, landing after V was remapped to P2 and recompiled from it
// (same block, page valid, P1's words unchanged, ops of the same kinds), must NOT be installed —
// it is P1's code. RED on a5f9447^ (installed). Control: with no remap it is installed.
function asyncSourceCase(name, remap) {
  const posted = [];
  const sb = { WebAssembly, console: { error() {}, log() {}, warn() {} }, Uint32Array, Object, Array, Math, String, Map, Set, Proxy, performance: { now: () => 0 } };
  sb.window = sb; sb.__fbAsync = { jitCold: true, jitChain: false };
  sb.__n64JitWorkerUrl = 'stub';
  sb.Worker = function () { this.postMessage = (b) => { for (const j of (Array.isArray(b) ? b : [b])) posted.push(j); }; };
  vm.createContext(sb); vm.runInContext(src, sb);
  const bm = sb.bementalMips;
  const words = [I(OPC.ADDIU, 9, 9, 1), I(OPC.ADDIU, 8, 8, 1), 0, 0];
  const w = makeWorld(words, {});
  const M = { HEAPU32: w.HEAPU32, HEAPU8: new Uint8Array(w.mem.buffer), wasmTable: w.table, wasmMemory: w.mem };
  sb.Module = M;
  const V = 0x10100000, page = V >>> 12, BP = 0x5c0000, SRC2 = 0x18000;
  const p1 = Object.assign({}, w.p, { vaddr: V, blockStart: V, blockEnd: V + words.length * 4 });
  // V is a valid code page whose precomp block (blocks[page] -> { block, start, end }) the span lives in
  M.HEAPU8[INVALID + page] = 0;
  w.HEAPU32[(BLOCKS >> 2) + page] = BP; w.HEAPU32[BP >> 2] = ENTRY; w.HEAPU32[(BP >> 2) + 1] = V; w.HEAPU32[(BP >> 2) + 2] = V + words.length * 4;
  // P2: the same kinds of instruction, other immediates
  const words2 = [I(OPC.ADDIU, 9, 9, 7), I(OPC.ADDIU, 8, 8, 7), 0, 0];
  for (let i = 0; i < words2.length; i++) w.HEAPU32[(SRC2 >> 2) + i] = words2[i];
  if (bm.compileSpan(p1, M) !== 0) return { name, ok: false, detail: 'expected an async offer (0)' };
  bm.frameEnd();                                       // flushes the offer to the "worker"
  const job = posted.find((j) => j && j.p && j.p.vaddr === V);
  if (!job) return { name, ok: false, detail: 'no job posted' };
  const r = bm.emitJob(job);
  if (!r.ok) return { name, ok: false, detail: 'emit failed ' + r.err };
  if (remap) bm.compileSpan(Object.assign({}, p1, { srcPtr: SRC2 }), M);   // the core recompiled V from P2
  bm.async.ready.push(r);
  bm.frameEnd();
  const entry = w.HEAPU32[ENTRY >> 2], installed = entry !== 1;
  const why = JSON.stringify(bm.async.staleWhy || {});
  return { name, ok: remap ? (!installed && /"source":1/.test(why)) : installed, detail: `entry op ${entry} staleWhy ${why}` };
}
tests.push(asyncSourceCase('async: a span built from P1 is not installed after its TLB page was recompiled from P2', true));
tests.push(asyncSourceCase('control: with no remap the same off-thread span is installed', false));

let fail = 0;
for (const t of tests) {
  if (!t.ok) fail++;
  console.log(`${t.ok ? 'PASS' : 'FAIL'}  ${t.name}${t.ok ? '' : '   ' + t.detail}`);
}
console.log(JSON.stringify({ source: SRCFILE, total: tests.length, failures: fail }));
process.exit(fail ? 1 : 0);

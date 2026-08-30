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
              SB: 0x28, SH: 0x29, SW: 0x2b, SD: 0x3f, ADDIU: 0x09, BEQ: 0x04, BNE: 0x05, BNEL: 0x15 };
const MFC1 = (rt, fs) => ((0x11 << 26) | (0x00 << 21) | (rt << 16) | (fs << 11)) >>> 0;
const MFC0 = (rt, rd) => ((0x10 << 26) | (0x00 << 21) | (rt << 16) | (rd << 11)) >>> 0;
const MTC0 = (rt, rd) => ((0x10 << 26) | (0x04 << 21) | (rt << 16) | (rd << 11)) >>> 0;

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
  HEAPU32[CP1S >> 2] = FPRSTORE;
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
  };
  return { mem, table, HEAPU32, REG64, p };
}

function loadEmitter() {
  const sb = { WebAssembly, console: { error() {}, log() {} }, Uint32Array, Object, Array, Math, String };
  sb.window = sb; vm.createContext(sb); vm.runInContext(src, sb);
  return sb.bementalMips;
}

// run one case: seed regs/dram, emit, execute, compare
function T(name, words, { regs = {}, dram = {}, expectRegs = {}, expectDram = {}, expectStats = null, opts = {} }) {
  const bm = loadEmitter();
  const { mem, table, HEAPU32, REG64, p } = makeWorld(words, opts);
  for (const [r, v] of Object.entries(regs)) REG64[(REG >> 3) + (+r)] = BigInt.asUintN(64, BigInt(v));
  for (const [a, v] of Object.entries(dram)) HEAPU32[(DRAM + (+a)) >> 2] = v >>> 0;
  const idx = bm.compileSpan(p, { HEAPU32, wasmTable: table, wasmMemory: mem });
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
];

let fail = 0;
for (const t of tests) {
  if (!t.ok) fail++;
  console.log(`${t.ok ? 'PASS' : 'FAIL'}  ${t.name}${t.ok ? '' : '   ' + t.detail}`);
}
console.log(JSON.stringify({ source: SRCFILE, total: tests.length, failures: fail }));
process.exit(fail ? 1 : 0);

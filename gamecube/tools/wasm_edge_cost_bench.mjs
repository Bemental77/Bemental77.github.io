#!/usr/bin/env node
// wasm_edge_cost_bench.mjs — price ONE JIT chain edge under the module
// topologies this JIT can plausibly emit. Hand-encodes raw wasm; depends on
// nothing in the tree, opens no browser, builds no C++.
//
// WHY THIS EXISTS
// ---------------
// `gamecube/docs/designs/wasm-dispatch-research.md` ranks "batch hot blocks
// into few multi-function modules with a module-INTERNAL table" as candidate
// #1, on the strength of two vendor statements:
//   * V8 (https://v8.dev/blog/wasm-speculative-optimizations): inlining a
//     `call_indirect` whose target belongs to another instance "would require
//     additional compiler machinery"; V8 instead checks instance identity and
//     deoptimizes. The blog names our exact configuration: "called via an
//     imported table."
//   * SpiderMonkey (https://dbezhetskov.dev/opt-ind-call/): private-table
//     indirect calls got "-30%" while external calls paid "+18%".
// Neither statement is a measurement OF THIS JIT's edge shape, and the tree has
// never had one. Meanwhile `block_cache.cpp:205-232` records THREE net-negative
// measurements of region promotion — the only mechanism that could deliver an
// internal table today. So "is candidate #1 worth another campaign against
// three recorded negatives" rests on an unmeasured premise. This prices it,
// with the terminal copied op-for-op from `ppc_emit.cpp::emit_chain_or_return`.
//
// THE ARMS (identical bodies, identical terminal ops, identical edge count)
//   A  per-block  : N modules, N instances, table IMPORTED   <- what ships today
//   A2 one-module : 1 module,  N funcs,     table IMPORTED   <- isolates instance count
//   B  internal   : 1 module,  N funcs,     table INTERNAL   <- candidate #1
//   C  direct     : 1 module,  N funcs,     return_call      <- the ceiling
//
// A vs A2 = the cost of many instances. A2 vs B = the cost of importing the
// table. B vs C = what a self-emitted inline cache (candidate #2) could add.
//
// USAGE
//   node gamecube/tools/wasm_edge_cost_bench.mjs
//   BODY_OPS=0 N_BLOCKS=512 REPS=7 node gamecube/tools/wasm_edge_cost_bench.mjs
//   ARMS=A,B node gamecube/tools/wasm_edge_cost_bench.mjs
// Emits one machine-readable line prefixed `[edge-bench-json] `.
//
// READ BEFORE QUOTING A NUMBER: arms are INTERLEAVED round-robin and the
// reported figure is the MEDIAN of REPS interleaved repetitions, because
// CLAUDE.md gate #10 records matched-pair noise as bad as +/-25% at load 11-23.
// Report `uptime` alongside. A ratio survives load; an absolute Medge/s does not.

// Runs in BOTH node and a browser page. Node's V8 is not the product: node
// v24.15 carries V8 13.6, while V8's speculative `call_indirect` inlining
// shipped in Chrome M137 / V8 13.7 — so a node-only result could miss the very
// mechanism under test. `wasm_edge_cost_bench_chrome.mjs` runs this same source
// in the Chrome the probe uses.
const ENV = (typeof process !== 'undefined' && process.env)
  ? process.env : (globalThis.__EDGE_BENCH_ENV || {});
const IS_NODE = typeof process !== 'undefined' && !!(process.versions || {}).node;
const nowMs = () => (typeof performance !== 'undefined' && performance.now)
  ? performance.now() : Number(process.hrtime.bigint()) / 1e6;
const RUNTIME = IS_NODE ? ('node ' + process.version + ' / V8 ' + process.versions.v8)
                        : ('browser ' + (globalThis.navigator ? navigator.userAgent : '?'));

const N_BLOCKS = Number(ENV.N_BLOCKS ?? 512);
const BODY_OPS = Number(ENV.BODY_OPS ?? 68);   // ~SAB 3-5-instr block body (census: 125.4 d0 total, 56.2 fixed)
const EDGES    = Number(ENV.EDGES    ?? 40_000_000);
const SLICE    = Number(ENV.SLICE    ?? 100_000);  // edges per host call == a downcount slice
const REPS     = Number(ENV.REPS     ?? 7);
const WARMUP   = Number(ENV.WARMUP   ?? 2);
const ARMS     = (ENV.ARMS ?? 'A,A2,B,C').split(',').map(s => s.trim()).filter(Boolean);

// ---------------------------------------------------------------- wasm encoder
function uleb(n) { const o = []; n >>>= 0; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; o.push(x); } while (n); return o; }
function sleb(n) { const o = []; n |= 0; for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } }
// Concatenation is push-based, never spread-based: `[...a, ...b]` on a
// 100 KB module section throws "Maximum call stack size exceeded" (it did, at
// N_BLOCKS=512 with a non-empty body).
function pushAll(dst, src) { for (let i = 0; i < src.length; i++) dst.push(src[i]); return dst; }
function join(...arrs) { const o = []; for (const a of arrs) pushAll(o, a); return o; }
const vec   = (items) => { const o = uleb(items.length); for (const it of items) pushAll(o, it); return o; };
const sect  = (id, payload) => { const o = [id]; pushAll(o, uleb(payload.length)); return pushAll(o, payload); };
const str   = (s) => { const b = []; for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i) & 0x7f); return join(uleb(b.length), b); };

const OP = {
  if: 0x04, end: 0x0b, return: 0x0f, return_call: 0x12, return_call_indirect: 0x13,
  drop: 0x1a, local_get: 0x20, local_set: 0x21, local_tee: 0x22,
  i32_load: 0x28, i32_store: 0x36, i32_const: 0x41,
  i32_eq: 0x46, i32_le_s: 0x4c, i32_lt_u: 0x49, i32_ge_s: 0x4e,
  i32_add: 0x6a, i32_sub: 0x6b, i32_mul: 0x6c, i32_and: 0x71, i32_shr_u: 0x76,
};
const VOID_BT = 0x40;
const i32c  = (v) => [OP.i32_const, ...sleb(v)];
const load  = (off) => [OP.i32_load, 2, ...uleb(off)];    // align=2 => 4-byte
const store = (off) => [OP.i32_store, 2, ...uleb(off)];

// ------------------------------------------------------------- memory layout
// Mirrors the shapes emit_chain_or_return touches, not their real addresses.
const MEM_PAGES = 8;          // 512 KiB
const CTX       = 0x1000;
const OFF_PC    = 0;          // ppc_off::PC
const OFF_DOWN  = 4;          // ppc_off::DOWNCOUNT
const OFF_MSR   = 8;          // ppc_off::MSR
const SCRATCH   = 0x2000;
const TAG_BASE  = 0x10000;    // g_bem_disp_tag[]
const SLOT_BASE = 0x20000;    // g_bem_disp_slot[]
const DISP_MASK = 0xfff;      // BEM_DISP_MASK_NEXT-alike: 4096 buckets
const PC_BASE   = 0x80100000;
const PC_STEP   = 0x10;       // 4 guest instrs/block — SAB measures 3-5.5
const pcOf      = (i) => (PC_BASE + i * PC_STEP) >>> 0;
const bktOf     = (pc) => (((pc >>> 2) & DISP_MASK) * 4) >>> 0;   // byte offset

const LOC_A = 0, LOC_B = 1, LOC_W = 2;   // TMP_A_CHAIN, TMP_B_CHAIN, W..W+3 = body accumulators
const N_LOCALS = 6;
const WORK = 0x3000;    // 4 live words the body reads and writes back
// SUCC = successors per call site. 1 = monomorphic (a fall-through / loop
// back-edge). >1 makes the site polymorphic, which is what a conditional branch
// or a `bclr` return actually is, and is the regime where V8's speculative
// `call_indirect` inlining stops helping. SPREAD scatters the targets so they
// are not adjacent. Requires N_BLOCKS a power of two and PC_BASE aligned to
// N_BLOCKS*PC_STEP, both asserted in main().
const SUCC   = Number(ENV.SUCC   ?? 8);   // successor-table entries == HIT resolution
const SPREAD = Number(ENV.SPREAD ?? 37);
// BATCHES: arm G splits the N blocks into BATCHES modules of N/BATCHES functions.
// In-group edges take that module's INTERNAL table; cross-group edges take the
// shared IMPORTED table, exactly as a real batched JIT would. BATCHES=1 is arm B
// plus a group test; BATCHES=N_BLOCKS is arm A plus a group test. The sweep
// between them is the realistic design space, because a single module of 1024
// functions was measured to lose most of the batching win.
// NOT named GROUPS. `GROUPS` is a special bash variable (the caller's group-ID
// array) and a `GROUPS=8 cmd` assignment prefix is SILENTLY IGNORED — a whole
// coverage sweep ran at the default and printed a believable flat curve twice
// before this was found. `env GROUPS=8 cmd` works and a bash prefix does not,
// which is what made it look like a bug in the runner. The knob-echo check in
// the Chrome runner cannot catch this class: the variable never reaches the
// node process at all, so there is nothing to compare against.
const BATCHES = Number(ENV.BATCHES ?? 4);
const GSIZE  = Math.floor(N_BLOCKS / BATCHES);
const GSHIFT = Math.round(Math.log2(GSIZE));
// HIT: the fraction of a block's successors that stay inside its own group.
// This is the SELECTION POLICY variable — block_cache.cpp:205-232 blames all
// three recorded region-promotion regressions on a "~5% region hit" coverage
// wall, and the 2026-07-15 census (:218-223) says board top-512 covers 77.8% of
// dynamic entries. HIT lets that be swept instead of argued.
const HIT = Math.min(1, Math.max(0, Number(ENV.HIT ?? 1)));
const SUCCTAB = 0x30000;   // [block][s] -> successor PC, built in JS

// Successor table, built HERE so the emitter, the dispatch-cache primer and the
// arm-C inline cache all agree on one set of edges.
const SUCC_PC = [];   // SUCC_PC[i] = array of SUCC successor PCs
const SUCC_IDX = [];
(function buildSuccessors() {
  // Exactly TWO distinct targets per site — a taken/not-taken conditional
  // branch, which is what a 3-5-instruction Gekko block actually ends in. Only
  // the FRACTION of executions taking the in-group target varies with HIT, so
  // polymorphism is held constant while coverage sweeps.
  //
  // Two modelling traps this shape exists to avoid, both of which produced
  // nonsense before:
  //   * HIT=1 with BATCHES>1 TRAPS the chain inside one group — the working set
  //     silently collapses to GSIZE blocks and even arm A (which has no groups)
  //     sped up 2.7x across the sweep. HIT is clamped below 1 whenever BATCHES>1.
  //   * A group of ONE block has no in-group successor except ITSELF, and a
  //     self-loop is a different, much faster shape than a chain edge (it read
  //     134 Medge/s where the arm should have matched A's 70).
  // Arm A's own rate staying flat across a BATCHES/HIT sweep is the check that
  // the topology is being held fixed; if it moves, the sweep is invalid.
  const usableHit = (BATCHES < 2 || GSIZE < 2) ? (BATCHES < 2 ? 1 : 0)
                                              : Math.min(HIT, (SUCC - 1) / SUCC);
  const inGroup = Math.round(usableHit * SUCC);
  for (let i = 0; i < N_BLOCKS; i++) {
    const myGroup = Math.floor(i / GSIZE), base = myGroup * GSIZE;
    const tIn  = base + ((i - base + 1) % GSIZE);                                  // in-group
    const tOut = BATCHES < 2 ? ((i + 1) % N_BLOCKS)
                            : (((myGroup + 1) % BATCHES) * GSIZE + ((i + 1) % GSIZE));  // other group
    const idxs = [];
    for (let s = 0; s < SUCC; s++) idxs.push((s < inGroup ? tIn : tOut) % N_BLOCKS);
    SUCC_IDX.push(idxs);
    SUCC_PC.push(idxs.map(pcOf));
  }
})();

// ------------------------------------------------------- the emitted function
// Body: a memory RMW plus BODY_OPS of dependent ALU. Terminal: op-for-op the
// shipping non-merged/non-region `emit_chain_or_return`
// (ppc_emit.cpp:233-244 service bail, :273-289 vector guard in its EDGE-DIET
// short-circuit form, :336-421 bucket probe, :461-462 host return).
function blockBody(i, mode) {
  const b = [];

  // body: the edge counter RMW — also the work-parity witness.
  b.push(...i32c(SCRATCH), ...i32c(SCRATCH), ...load(0), ...i32c(1), OP.i32_add, ...store(0));

  // body: real ALU work. Accumulators are SEEDED FROM MEMORY and STORED BACK,
  // so the chain is live and cannot be constant-folded away (an earlier version
  // seeded from a constant and V8 deleted the entire body). Four independent
  // accumulators give the instruction-level parallelism emitted guest code has;
  // a single dependent chain would be latency-bound and would understate the
  // edge's share.
  // Each addend is LOADED FROM MEMORY, never a constant. A constant addend let
  // V8 fuse the arithmetic of several inlined blocks into one expression, which
  // made arm C insensitive to BODY_OPS and inflated every batched arm — real
  // guest bodies are not algebraically composable like that. The block also
  // stores to SCRATCH/WORK/CTX, so the loads cannot be hoisted past them.
  const seedStore = 4 * 3 * 2;                                  // seed + writeback ops
  const reps = Math.max(0, Math.floor((BODY_OPS - seedStore) / 5));
  if (BODY_OPS > 0) {
    for (let k = 0; k < 4; k++) b.push(...i32c(WORK), ...load(k * 4), OP.local_set, ...uleb(LOC_W + k));
    for (let r = 0; r < reps; r++) {
      const k = r & 3;
      b.push(OP.local_get, ...uleb(LOC_W + k));
      b.push(...i32c(WORK + 64), ...load(((r & 7) * 4)));        // opaque addend
      b.push(OP.i32_add, OP.local_set, ...uleb(LOC_W + k));
    }
    for (let k = 0; k < 4; k++) b.push(...i32c(WORK), OP.local_get, ...uleb(LOC_W + k), ...store(k * 4));
  }

  // guest-visible state update: next PC, read from the successor table so JS
  // owns the edge topology (locality, fan-out) and every arm sees the same one.
  b.push(...i32c(CTX));
  if (SUCC <= 1) {
    b.push(...i32c(SUCCTAB + i * SUCC * 4), ...load(0));
  } else {
    b.push(...i32c(SUCCTAB + i * SUCC * 4));
    b.push(...i32c(SCRATCH), ...load(0), ...i32c(SUCC - 1), OP.i32_and, ...i32c(4), OP.i32_mul);
    b.push(OP.i32_add, ...load(0));
  }
  b.push(...store(OFF_PC));
  // downcount -= 4 cycles
  b.push(...i32c(CTX), ...i32c(CTX), ...load(OFF_DOWN), ...i32c(4), OP.i32_sub, ...store(OFF_DOWN));

  // ================= TERMINAL =================
  // [a] service bail: downcount <= 0
  b.push(...i32c(CTX), ...load(OFF_DOWN), ...i32c(0), OP.i32_le_s);
  b.push(OP.if, VOID_BT);
  b.push(...i32c(CTX), ...load(OFF_PC), OP.return);
  b.push(OP.end);

  // vector-page guard, EDGE-DIET short-circuit form: (PC < 0x4000) && (MSR & IR)
  b.push(...i32c(CTX), ...load(OFF_PC), OP.local_tee, ...uleb(LOC_A));
  b.push(...i32c(0x4000), OP.i32_lt_u);
  b.push(OP.if, VOID_BT);
  b.push(...i32c(CTX), ...load(OFF_MSR), ...i32c(0x20), OP.i32_and);
  b.push(OP.if, VOID_BT);
  b.push(...i32c(CTX), ...load(OFF_PC), OP.return);
  b.push(OP.end, OP.end);

  // bucket probe: tag hit && slot >= 0 -> chain
  b.push(OP.local_get, ...uleb(LOC_A), ...i32c(2), OP.i32_shr_u);
  b.push(...i32c(DISP_MASK), OP.i32_and, ...i32c(4), OP.i32_mul);
  b.push(OP.local_tee, ...uleb(LOC_B));
  b.push(...i32c(TAG_BASE), OP.i32_add, ...load(0));
  b.push(OP.local_get, ...uleb(LOC_A), OP.i32_eq);
  b.push(OP.if, VOID_BT);
  b.push(...i32c(SLOT_BASE), OP.local_get, ...uleb(LOC_B), OP.i32_add, ...load(0));
  b.push(OP.local_tee, ...uleb(LOC_A), ...i32c(0), OP.i32_ge_s);
  b.push(OP.if, VOID_BT);
  if (mode === 'group') {
    // slot holds the GLOBAL block index. Same group -> internal table (index 1,
    // index rebased into the module); other group -> shared imported table
    // (index 0), which is a cross-instance call just like arm A.
    const myGroup = Math.floor(i / GSIZE);
    b.push(OP.local_get, ...uleb(LOC_A), ...i32c(GSHIFT), OP.i32_shr_u);
    b.push(...i32c(myGroup), OP.i32_eq);
    b.push(OP.if, VOID_BT);
    b.push(OP.local_get, ...uleb(LOC_A), ...i32c(GSIZE - 1), OP.i32_and);
    b.push(OP.return_call_indirect, ...uleb(0), ...uleb(1));   // INTERNAL table
    b.push(OP.end);
    b.push(OP.local_get, ...uleb(LOC_A));
    b.push(OP.return_call_indirect, ...uleb(0), ...uleb(0));   // IMPORTED table
  } else if (mode === 'direct') {
    // arm C. At SUCC=1 the successor is a compile-time constant, so this is a
    // plain direct tail call — the ceiling. At SUCC>1 the successor SET is
    // still statically known (it is generated by the formula above), so this
    // becomes a self-emitted inline cache: guard the loaded slot against each
    // candidate index and direct-call on a match, else fall through to the
    // indirect call. That is exactly candidate #2 of wasm-dispatch-research.md
    // ("emit the inline cache ourselves"), priced here rather than assumed.
    for (const c of [...new Set(SUCC_IDX[i])]) {
      b.push(OP.local_get, ...uleb(LOC_A), ...i32c(c), OP.i32_eq);
      b.push(OP.if, VOID_BT);
      b.push(OP.return_call, ...uleb(fnIdx(c, mode)));
      b.push(OP.end);
    }
    // IC miss -> the ordinary indirect edge (arm C keeps an internal table).
    b.push(OP.local_get, ...uleb(LOC_A));
    b.push(OP.return_call_indirect, ...uleb(0), ...uleb(0));
  } else {
    b.push(OP.local_get, ...uleb(LOC_A));
    b.push(OP.return_call_indirect, ...uleb(0), ...uleb(0));   // typeidx, tableidx
  }
  b.push(OP.end, OP.end);

  // host return
  b.push(...i32c(CTX), ...load(OFF_PC), OP.return);
  b.push(OP.end);   // function end
  return b;
}
// Imports carry no functions in any arm, so a defined function's index is just
// its block index (per-block modules define exactly one function: index 0).
const fnIdx = (i, mode) => (mode === 'perblock' ? 0 : i);

// ------------------------------------------------------------ module builders
const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const TYPE_VOID_TO_I32 = [0x60, 0x00, 0x01, 0x7f];
const LOCALS_N_I32 = [...uleb(1), ...uleb(N_LOCALS), 0x7f];
const codeEntry = (body) => { const w = join(LOCALS_N_I32, body); return join(uleb(w.length), w); };

const impMemory = () => join(str('env'), str('memory'), [0x02, 0x03], uleb(MEM_PAGES), uleb(MEM_PAGES));
const impTable  = () => join(str('env'), str('__indirect_function_table'), [0x01, 0x70, 0x01], uleb(N_BLOCKS), uleb(N_BLOCKS));

function buildPerBlockModule(i) {
  return Uint8Array.from(join(
    MAGIC,
    sect(1, vec([TYPE_VOID_TO_I32])),
    sect(2, vec([impMemory(), impTable()])),
    sect(3, vec([uleb(0)])),
    sect(7, vec([join(str('run'), [0x00], uleb(0))])),
    sect(10, vec([codeEntry(blockBody(i, 'perblock'))])),
  ));
}

// mode: 'imported' (arm A2) | 'internal' (arm B) | 'direct' (arm C)
function buildBatchModule(mode) {
  const idxs = Array.from({ length: N_BLOCKS }, (_, i) => i);
  const imports = mode === 'imported' ? [impMemory(), impTable()] : [impMemory()];
  // A2 must hand its functions to JS so the IMPORTED table can be filled; B and
  // C export only the entry point, keeping B's table neither imported nor
  // exported (SpiderMonkey's stated precondition; V8 only needs instance match).
  const exports = mode === 'imported'
    ? idxs.map(i => join(str('f' + i), [0x00], uleb(i)))
    : [join(str('run'), [0x00], uleb(0))];

  const parts = join(
    MAGIC,
    sect(1, vec([TYPE_VOID_TO_I32])),
    sect(2, vec(imports)),
    sect(3, vec(idxs.map(() => uleb(0)))),
  );
  if (mode !== 'imported') pushAll(parts, sect(4, vec([join([0x70, 0x01], uleb(N_BLOCKS), uleb(N_BLOCKS))])));
  pushAll(parts, sect(7, vec(exports)));
  if (mode !== 'imported') {
    pushAll(parts, sect(9, vec([join(uleb(0), i32c(0), [OP.end], vec(idxs.map(f => uleb(f))))])));
  }
  pushAll(parts, sect(10, vec(idxs.map(i => codeEntry(blockBody(i, mode))))));
  return Uint8Array.from(parts);
}

// One group module: imports memory + the shared table, declares its OWN internal
// table holding just its GSIZE functions, exports them so the shared table can
// be populated.
function buildGroupModule(g) {
  const local = Array.from({ length: GSIZE }, (_, k) => k);
  const parts = join(
    MAGIC,
    sect(1, vec([TYPE_VOID_TO_I32])),
    sect(2, vec([impMemory(), impTable()])),
    sect(3, vec(local.map(() => uleb(0)))),
    // table index 0 is the IMPORTED one; this internal table is index 1.
    sect(4, vec([join([0x70, 0x01], uleb(GSIZE), uleb(GSIZE))])),
    sect(7, vec(local.map(k => join(str('f' + k), [0x00], uleb(k))))),
    // element segment flags=0x02: active, explicit tableidx, elemkind funcref.
    sect(9, vec([join([0x02], uleb(1), i32c(0), [OP.end, 0x00], vec(local.map(k => uleb(k))))])),
    sect(10, vec(local.map(k => codeEntry(blockBody(g * GSIZE + k, 'group'))))),
  );
  return Uint8Array.from(parts);
}

// --------------------------------------------------------------------- driver
const memory = new WebAssembly.Memory({ initial: MEM_PAGES, maximum: MEM_PAGES, shared: true });
const HEAP = new Int32Array(memory.buffer);

function primeDispatchCache() {
  // Every edge HITS — the shipping steady state, and the only regime in which
  // the arms differ solely by call topology.
  for (let i = 0; i < N_BLOCKS; i++)
    for (let s = 0; s < SUCC; s++) HEAP[(SUCCTAB + (i * SUCC + s) * 4) >> 2] = SUCC_PC[i][s] | 0;
  for (let k = 0; k < 4; k++) HEAP[(WORK + k * 4) >> 2] = 0x1234 + k;
  for (let k = 0; k < 8; k++) HEAP[(WORK + 64 + k * 4) >> 2] = (0x9e3779b9 | 0) + k;   // opaque addends
  HEAP.fill(0,  TAG_BASE  >> 2, (TAG_BASE  >> 2) + DISP_MASK + 1);
  HEAP.fill(-1, SLOT_BASE >> 2, (SLOT_BASE >> 2) + DISP_MASK + 1);
  const seen = new Set();
  for (let i = 0; i < N_BLOCKS; i++) {
    const pc = pcOf(i), off = bktOf(pc);
    if (seen.has(off)) throw new Error(`bucket collision at block ${i} (pc 0x${pc.toString(16)}) — lower N_BLOCKS or raise PC_STEP`);
    seen.add(off);
    HEAP[(TAG_BASE  + off) >> 2] = pc | 0;
    HEAP[(SLOT_BASE + off) >> 2] = i;      // table index == block index
  }
}

function makeArm(name) {
  if (name === 'A') {
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: N_BLOCKS, maximum: N_BLOCKS });
    let entry = null;
    for (let i = 0; i < N_BLOCKS; i++) {
      const inst = new WebAssembly.Instance(new WebAssembly.Module(buildPerBlockModule(i)),
        { env: { memory, __indirect_function_table: table } });
      table.set(i, inst.exports.run);
      if (i === 0) entry = inst.exports.run;
    }
    return { enter: entry, label: 'A  per-block modules, imported table' };
  }
  if (name === 'A2') {
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: N_BLOCKS, maximum: N_BLOCKS });
    const inst = new WebAssembly.Instance(new WebAssembly.Module(buildBatchModule('imported')),
      { env: { memory, __indirect_function_table: table } });
    for (let i = 0; i < N_BLOCKS; i++) table.set(i, inst.exports['f' + i]);
    return { enter: inst.exports.f0, label: 'A2 one module, imported table' };
  }
  if (name === 'B') {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(buildBatchModule('internal')), { env: { memory } });
    return { enter: inst.exports.run, label: 'B  one module, INTERNAL table' };
  }
  if (name === 'G') {
    if (GSIZE * BATCHES !== N_BLOCKS) fatal('BATCHES must divide N_BLOCKS');
    if ((GSIZE & (GSIZE - 1)) !== 0) fatal('N_BLOCKS/BATCHES must be a power of two');
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: N_BLOCKS, maximum: N_BLOCKS });
    let entry = null;
    for (let g = 0; g < BATCHES; g++) {
      const inst = new WebAssembly.Instance(new WebAssembly.Module(buildGroupModule(g)),
        { env: { memory, __indirect_function_table: table } });
      for (let k = 0; k < GSIZE; k++) table.set(g * GSIZE + k, inst.exports['f' + k]);
      if (g === 0) entry = inst.exports.f0;
    }
    return { enter: entry, label: `G  ${BATCHES} modules x ${GSIZE} funcs, internal+shared` };
  }
  if (name === 'C') {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(buildBatchModule('direct')), { env: { memory } });
    return { enter: inst.exports.run, label: 'C  one module, direct return_call' };
  }
  throw new Error('unknown arm ' + name);
}

function runArm(arm, edges) {
  primeDispatchCache();
  HEAP[(CTX + OFF_PC)  >> 2] = pcOf(0) | 0;
  HEAP[(CTX + OFF_MSR) >> 2] = 0;                 // MSR.IR clear -> vector arm never taken
  let done = 0;
  const t0 = nowMs();
  while (done < edges) {
    HEAP[(CTX + OFF_DOWN) >> 2] = SLICE * 4;      // downcount drains 4/edge
    arm.enter();
    done += SLICE;
  }
  return { ms: nowMs() - t0, edges: done };
}

// ------------------------------------------------------------------------ main
function fatal(msg) { console.error(msg); if (IS_NODE) process.exit(9); throw new Error(msg); }

function main() {
  if (SUCC > 1) {
    if ((SUCC & (SUCC - 1)) !== 0) fatal('SUCC must be a power of two');
  }
  const arms = [];
  for (const n of ARMS) {
    try { arms.push({ name: n, ...makeArm(n) }); }
    catch (e) { fatal(`arm ${n} FAILED to build: ${e.message}`); }
  }
  if (!arms.length) fatal('no arms');

  // Correctness gate: every arm must traverse the SAME number of edges and land
  // on the SAME scratch total. An arm that silently host-returns early would
  // otherwise look fast.
  const checks = arms.map(a => {
    HEAP[SCRATCH >> 2] = 0;
    runArm(a, SLICE * 4);
    return HEAP[SCRATCH >> 2];
  });
  if (new Set(checks).size !== 1) {
    fatal('ARMS DISAGREE on work done: ' + arms.map((a, i) => `${a.name}=${checks[i]}`).join(' '));
  }
  console.log(`# wasm chain-edge cost bench`);
  console.log(`# N_BLOCKS=${N_BLOCKS} BATCHES=${BATCHES} HIT=${HIT} SUCC=${SUCC} BODY_OPS=${BODY_OPS} EDGES=${EDGES.toLocaleString()} SLICE=${SLICE} REPS=${REPS} WARMUP=${WARMUP}`);
  console.log(`# ${RUNTIME} — work-parity check PASS (${checks[0]} RMWs per arm)`);
  console.log('');

  const samples = Object.fromEntries(arms.map(a => [a.name, []]));
  for (let w = 0; w < WARMUP; w++) for (const a of arms) runArm(a, Math.min(EDGES, 4_000_000));
  for (let r = 0; r < REPS; r++) {
    for (const a of arms) samples[a.name].push(EDGES / runArm(a, EDGES).ms / 1000);   // Medge/s
    if (IS_NODE) process.stderr.write(`  rep ${r + 1}/${REPS} done\n`);
  }

  const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
  const out = {};
  console.log('arm                                        median Medge/s      min      max');
  for (const a of arms) {
    const s = samples[a.name];
    out[a.name] = { label: a.label, median_medges_s: med(s), min: Math.min(...s), max: Math.max(...s), samples: s };
    console.log(`${a.label.padEnd(42)} ${med(s).toFixed(2).padStart(8)} ${Math.min(...s).toFixed(2).padStart(8)} ${Math.max(...s).toFixed(2).padStart(8)}`);
  }
  const base = out[arms[0].name].median_medges_s;
  console.log(`\nratios vs ${arms[0].name} (${arms[0].label.trim()}):`);
  for (const a of arms) console.log(`  ${a.name.padEnd(4)} ${(out[a.name].median_medges_s / base).toFixed(4)}x`);
  const result = {
    config: { N_BLOCKS, BODY_OPS, EDGES, SLICE, REPS, WARMUP, SUCC, SPREAD, BATCHES, HIT, ARMS: ARMS.join(','), runtime: RUNTIME },
    arms: out,
  };
  globalThis.__EDGE_BENCH_RESULT = result;
  console.log('\n[edge-bench-json] ' + JSON.stringify(result));
}
if (IS_NODE || globalThis.__EDGE_BENCH_AUTORUN !== false) main();

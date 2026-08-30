// wasm_emit.cpp — SHIL → WASM emitter (native).
//
// Phase-2 native emit ported from wasm_emit.h.reference. Covers integer ALU,
// shifts, comparisons, carry/rotate (adc/sbc/negc/rocl/rocr/shld/shad),
// 32x32→64 multiply (mul_u64/mul_s64), dynamic jumps/conds, area-3 fastmem
// readm/writem, FPU scalar arith + compare + convert, fmac, fsrra, fipr,
// ftrv, frswap, setpeq, mov64, pref, sync_sr/sync_fpscr, and shop_ifb.
//
// Division (div32u/div32s/div32p2/div1) intentionally falls through to the
// IFB fallback path because it's rare and the carry/dual-output logic is
// complex; ship native correctness first, optimize divides later.

#include "wasm_emit.h"
#include "hw/sh4/sh4_mem.h"
// rdv_readMemImmediate / rdv_writeMemImmediate — the same constant-folded
// address resolver rec_x64.cpp uses for its GenReadMemImmediate /
// GenWriteMemImmediate fastpath (rec_x64.cpp:848, :971). Returns isRam=true
// + a host pointer when the EA lands in mem_b/vram/aica_ram; under emcc a
// host pointer is a wasm linear-memory offset so we can bake it as an
// i32.const and emit a direct i32.load/store. Returns isRam=false when the
// EA resolves to MMIO — in that case we still skip the runtime area check
// since the physical address is now a known constant.
#include "hw/sh4/dyna/ngen.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

namespace bemental::sh4 {

// VRAM linear-memory base. Bridge sets this at first SH4 dispatch (see
// dreamcast/flycast-bridge/rec_wasm.cpp). 0 = "not yet initialized,
// fall back to sh4_write32/read32 imports for area-4/5".
u32 g_vram_lin_base = 0;
u32 g_ocram_lin_base = 0;      // lever-9D: OnChipRAM linear base (set by rec_wasm init)
u32 g_ccr_addr = 0;            // lever-9D: &CCN_CCR
bool g_emit_ocram_fp = true;   // lever-9D bisect switch
// Runtime kill-switch for every emitted memory fastpath (immediate-EA bake,
// area-3 RAM store/load, area-1 swizzle, area-4/5 linear, memset pattern).
// OFF forces every guest memory access through the sh4_mem_* imports —
// flycast's canonical paths — which is the JIT-arm memory-corruption
// differential (boot-title-wedge): interp arm boots clean, JIT arm corrupts
// RAM; if OFF also boots clean, the emitted fastpaths are the culprit.
// Toggled via _flycast_set_mem_fastpaths BEFORE blocks compile.
bool g_emit_mem_fastpaths = true;
bool g_emit_imm_fastpath = true;   // immediate-EA fastpath only (bisect switch)
bool g_emit_memset = true;         // memset self-loop fastpath only (bisect switch)
bool g_emit_writem_fp = true;

// Lever-4 / Build 2 (dreamcast/docs/lever-4-smc-bitmap): SMC code-page map +
// IC generation, C linkage (map DEFINED in rec_wasm.cpp, populated by
// jit_register while armed; generation DEFINED at the g_ic block below). The
// store-side fastpaths emit a branchless `g_ic_generation += g_code_pages[page]`
// so an in-wasm store to a page holding compiled code invalidates every IC
// entry — the event-driven SMC net that makes cond/static IC safe. Computed
// addressing is legal HERE (the area-3 store fastpath already indexes RAM);
// the DISPATCH path stays const-addr scalar only (#18 landmine).
extern "C" {
    extern uint8_t g_code_map[(1u << 22) + 16];   // 4-BYTE word chunks + guard tail (granularity ladder: 4KB thrashed on mixed pages; 16B thrashed on the ISR frame-counter word beside code)
    extern uint32_t g_smc_last_addr;       // DIAG (strip after verdict): last marked phys addr
    extern volatile uint32_t g_ic_generation;
}
// Emits `map word-chunk of addr_local` on the stack, then loads the map byte.
// SH4 stores are naturally aligned (unaligned faults on real HW), so a w<=4
// store touches EXACTLY one 4-byte chunk — one load8 is width-exact. A span
// pad or blanket next-chunk read false-positives data adjacent to code (the
// task-3b/3c storms); neither exists here.
static void emitSmcChunkLoad(WasmModuleBuilder& b, u32 addr_local, u32 byte_off = 0) {
    b.op_local_get(addr_local);
    if (byte_off != 0) { b.op_i32_const((s32)byte_off); b.op_i32_add(); }
    b.op_i32_const(0x00FFFFFC);
    b.op_i32_and();
    b.op_i32_const(2);
    b.op_i32_shr_u();                    // word-chunk index (bits 2-23)
    // g_code_map's base folds into the load's memarg offset instead of an
    // `i32.const base; i32.add` pair — identical addressing (the memarg offset
    // is an unsigned addend on the dynamic address; chunk < 2^22 and the base
    // is a live heap address, so neither form can wrap or leave bounds where
    // the other would not). 2 fewer wasm instructions on EVERY register-EA
    // area-3 store, 4 fewer on the size-8 fmov.d pair, 2 fewer per iteration
    // of the memset fastpath's mark loop.
    b.op_i32_load8_u((u32)(uintptr_t)g_code_map);   // map[chunk] (0|1)
}
static void emitSmcMarkLocal(WasmModuleBuilder& b, u32 addr_local, u32 width) {
    // `addr_local` holds the MASKED physical EA (addr & 0x1FFFFFFF), area==3.
    // gen += map[c(phys)] — adds 0 for non-code chunks; the map is all-zero
    // while disarmed, so this cannot move the generation off 0. Any nonzero
    // add invalidates (equality compare). width <= 4 and aligned -> single
    // chunk; the 8-byte fmov.d pair (aligned) -> chunks c and c+1.
    const u32 gen = (u32)(uintptr_t)&g_ic_generation;
    b.op_i32_const((s32)gen);            // store addr
    b.op_i32_const((s32)gen);            // load addr
    b.op_i32_load(0);                    // gen
    emitSmcChunkLoad(b, addr_local);
    if (width > 4) {
        emitSmcChunkLoad(b, addr_local, 4);
        b.op_i32_add();
    }
    b.op_i32_add();
    b.op_i32_store(0);                   // gen += touched-chunk map bytes
    // (The K2-attribution last-addr diag emitted here was STRIPPED after its
    // verdict — it named the 16B-granularity false positives: the pre-block
    // data word 0x0c37ea68, then the ISR frame counter 0x0c379b80. See
    // docs/lever-4-smc-bitmap. g_smc_last_addr stays defined, reads 0.)
}
// Lever-5B: inline-sync_sr support. The TU-static interrupt-decode state
// addresses (sh4_interrupts.cpp, WASM-gated accessor) are cached on first
// sync_sr emission; g_emit_syncsr_fast is the bisect kill-switch
// (FLYCAST_SYNCSR=0 forces the old always-C emission).
extern "C" void sh4_intr_state_ptrs(uint32_t* out4);
bool g_emit_syncsr_fast = []{
    const char* e = std::getenv("FLYCAST_SYNCSR");
    return !(e && e[0] == '0');
}();
static u32 g_sr_vpend_addr = 0, g_sr_vmask_addr = 0,
           g_sr_decoded_addr = 0, g_sr_ilb_addr = 0;
static bool sr_ptrs_ready() {
    static bool init = false;
    if (!init) {
        uint32_t p[4] = {0, 0, 0, 0};
        sh4_intr_state_ptrs(p);
        g_sr_vpend_addr = p[0]; g_sr_vmask_addr = p[1];
        g_sr_decoded_addr = p[2]; g_sr_ilb_addr = p[3];
        init = true;
    }
    return g_sr_vpend_addr != 0;
}

// Compile-time-constant variant for the immediate-EA store fastpath: the
// touched word-chunks are known at emit time, so the whole mark is const-addr.
// Aligned w<=4 -> one chunk; the 8-byte pair (w=8) -> two.
static void emitSmcMarkConstPage(WasmModuleBuilder& b, u32 phys_addr, u32 width) {
    const u32 map = (u32)(uintptr_t)g_code_map;
    const u32 c1 = (phys_addr & 0x00FFFFFFu) >> 2;
    const u32 c2 = ((phys_addr & 0x00FFFFFFu) + (width ? width - 1 : 0)) >> 2;
    const u32 gen = (u32)(uintptr_t)&g_ic_generation;
    b.op_i32_const((s32)gen);
    b.op_i32_const((s32)gen);
    b.op_i32_load(0);
    b.op_i32_const((s32)(map + c1));
    b.op_i32_load8_u(0);
    if (c2 != c1) {
        b.op_i32_const((s32)(map + c2));
        b.op_i32_load8_u(0);
        b.op_i32_add();
    }
    b.op_i32_add();
    b.op_i32_store(0);
}
bool g_emit_regcache = true;  // see scanBlock gate (boot-title-wedge kill-switch)

// ---------------------------------------------------------------------------
// PROLOGUE / HOP TRIM (2026-08-29 codegen audit). Three levers, each with its
// own bisect switch, all measured ONLY by instruction count so far — the
// wall-clock value is UNMEASURED until a matched pair runs.
//
// Evidence (offline emitter dump + wasm2wat, /tmp/dc-emit): an EMPTY
// BET_StaticJump block emits 69 wasm instructions before any guest work; a
// 1-guest-op block emits 84. On the hot path (IC hit, slice in budget) a block
// executes ~30 fixed instructions + 8 linear-memory accesses per hop, plus
// 3 instructions and 1 load per cached register in the eager prologue.
//
//   g_emit_preload_elide  — skip the prologue load for a register whose FIRST
//                           top-level access in the block is a full definition
//                           (the local is written before anything can read it).
//                           Universal on cmp+branch blocks (sr.T is always
//                           def-first) and on any block that loads/immediates
//                           into a fresh GPR. Semantics-identical.
//   g_emit_prologue_trim  — hoist the slice-yield precheck to the top of the
//                           block (so no guest work — memset fastpath, cache
//                           reload — runs on a spent slice) and reuse its
//                           cycle_counter load for the per-block drain via
//                           LOCAL_CC. Semantics-identical.
//   g_emit_hop_guard      — DEFAULT ON (unchanged behaviour). When OFF, the
//                           caller-side `cycle_counter > 0` vector guard is
//                           dropped from emit_tail_to / the const-target probe
//                           / the global probe / the RAS check, because with
//                           the precheck hoisted to the top of EVERY block the
//                           callee already enforces the same invariant one
//                           instruction later. Saves 5 executed instructions
//                           and 1 load per block hop. NOT semantics-identical:
//                           a spent slice now costs one extra block entry (and
//                           one extra sh4_jit_lookup_idx on the probe paths)
//                           per timeslice, and the g_exit_* round-trip
//                           counters stop counting guard-blocks (they then
//                           count lookup misses only). Default OFF until a
//                           matched pair certifies it.
// ---------------------------------------------------------------------------
bool g_emit_preload_elide = []{
    const char* e = std::getenv("FLYCAST_PRELOAD_ELIDE");
    return !(e && e[0] == '0');
}();

// ---------------------------------------------------------------------------
// AREA-3 DISCRIMINATOR (2026-08-29). The register-EA load/store fastpaths ask
// "is this EA in area 3 (system RAM)?". The legacy form spends 8 wasm ops:
//
//     local.get TMP; i32.const 0x1FFFFFFF; i32.and; local.tee TMP;
//     i32.const 26; i32.shr_u; i32.const 3; i32.eq
//
// and, because the tee CLOBBERS LOCAL_TMP with the masked value, the non-RAM
// arm has to recompute the raw EA from rs1(+rs3) — 1-4 more ops and up to two
// extra loads. The fast form is 5 ops and leaves LOCAL_TMP holding the RAW EA:
//
//     local.get TMP; i32.const 0x1C000000; i32.and; i32.const 0x0C000000; i32.eq
//
// BIT-IDENTITY (exhaustive, not argued): ((ea & 0x1FFFFFFF) >> 26) == 3 selects
// exactly ea[28:26] == 0b011 — the 0x1FFFFFFF mask clears bits 31..29, the >>26
// keeps bits 28..26, and == 3 demands 011. (ea & 0x1C000000) == 0x0C000000 is
// the same three-bit test written in place. Verified by enumerating all 2^32
// values in the offline harness (area3_proof): 0 mismatches. The RAM index in
// the taken arm is `x & 0x00FFFFFF`, and the SMC mark's chunk index is
// `x & 0x00FFFFFC` — both sit strictly inside the 0x1FFFFFFF mask, so feeding
// them the RAW EA instead of the masked one is also bit-identical WHENEVER the
// arm is taken (which is exactly when ea[31:29] contributes nothing).
// Kill-switch: FLYCAST_AREA3_FAST=0 / bemental_sh4_set_area3_fast(0) restores
// the legacy 8-op form byte-for-byte (the historical boot-title-wedge sites are
// these four, so the bisect switch is non-negotiable).
// ---------------------------------------------------------------------------
// Matched-pair knob: emcc's getenv() does NOT see the host environment in the
// worker (rec_wasm.cpp says the same about FLYCAST_SHARD), and the bridge has no
// flycast_set_area3_fast wrapper yet, so the A/B arm for a browser build is this
// literal. 1 = fast form (default), 0 = the legacy 8-op form, byte-for-byte.
#ifndef FLYCAST_AREA3_FAST_DEFAULT
#define FLYCAST_AREA3_FAST_DEFAULT 1
#endif
bool g_emit_area3_fast = []{
    const char* e = std::getenv("FLYCAST_AREA3_FAST");
    return e ? (e[0] != '0') : (bool)FLYCAST_AREA3_FAST_DEFAULT;
}();
bool g_emit_prologue_trim = []{
    const char* e = std::getenv("FLYCAST_PROLOGUE_TRIM");
    return !(e && e[0] == '0');
}();
bool g_emit_hop_guard = []{
    const char* e = std::getenv("FLYCAST_HOP_GUARD");
    return !(e && e[0] == '0');
}();

// ---------------------------------------------------------------------------
// Env-var gates (module-scope, read once at first emit). Both default OFF —
// flipping requires FLYCAST_SELF_LOOP=1 / FLYCAST_LAZY_REGCACHE=1 in the host
// process environment before the worker spawns its bementalJIT instance.
//
//   FLYCAST_SELF_LOOP:    F3 — wrap self-branching short blocks in a wasm
//                         `loop $L; ...; br_if $L; end` rather than emitting a
//                         per-iteration return-to-dispatcher. Caps trampoline
//                         + dispatcher round-trips for tight wait loops (e.g.
//                         the 295K-iter spin observed at 0x8c008374).
//
//   FLYCAST_LAZY_REGCACHE: F9 — defer RegCache local population until first
//                          use, instead of eagerly reloading every assigned
//                          register in the block prologue. Avoids loads for
//                          registers a block scans-but-doesn't-execute (e.g.
//                          when the IFB fallback path is taken).
//
//   KNOWN LIMITATION (F9): lazy-load is emitted at the first BUILD-TIME use,
//   which may sit inside an `op_if`/`op_else` arm (see shop_shld / shop_shad
//   at lines 763..831). If the runtime path takes the OTHER arm first, the
//   target local is zero-initialized (wasm spec) rather than holding the
//   memory-backed register value. Mirrors the PowerPC `b11_coherence_bug`
//   class — proper fix is an if_depth counter à la bementalJIT/guests/
//   powerpc-next/reg_cache.cpp (m_if_depth gates B11 caching to depth 0).
//   Until that lands, F9 is best held behind FLYCAST_LAZY_REGCACHE=1 for
//   A/B perf evaluation; do not flip the default until coherence is fixed.
// ---------------------------------------------------------------------------
static bool s_self_loop_enabled = []{
    // DEFAULT OFF (boot-title-wedge differential, 2026-08-20): the DP
    // decompressor loop (dt + bf/s with a T-writing shlr in the delay slot,
    // no fallback ops — so the fallback exclusion doesn't catch it) produces
    // garbage output under the in-wasm self-loop emission while the interp
    // arm is correct. Loop-less emission is dispatcher-paced and always
    // correct; re-enable only after the self-loop passes the emitter unit
    // test with T-writing delay slots (test_sh4_dispatch fixture).
    const char* e = std::getenv("FLYCAST_SELF_LOOP");
    if (e) return e[0] != '0';
    // DEFAULT ON (2026-08-21): re-enabled with the T-writing-delay-slot gate
    // below (self_loop requires <=1 SR_T write). The DP-decompressor loop that
    // forced this off (dt + bf/s with a T-writing shlr in the delay slot) has
    // TWO SR_T writes so it is now excluded and runs dispatcher-paced; simple
    // copy/fill loops (memset at 0x8c12bc6e: one setae T-write, add delay slot)
    // self-loop in-block — the SEGA-boot memset was ~7500 B/s via the dispatcher,
    // starving the guest and triggering a level-4 interrupt storm (~66K/s).
    //
    // DEFAULT ON (2026-08-21, ORDER 21b) — WITH the cycle-counter loop bound
    // added to the exit below. The interp-narrow verdict showed the UNBOUNDED
    // self-loop mis-behaved: it ran all N iterations of the 0x8c12bc6e memset
    // with NO interrupt servicing (cycle_counter drained hugely negative), then
    // a deferred IRQ burst pinned the main thread at the rts (0x8c12bc78) and the
    // storm never collapsed. The fix bounds the loop by cycle_counter (native
    // slice_loop) so interrupts are serviced every timeslice. Runtime toggle
    // bemental_sh4_set_self_loop / flycast_set_self_loop for A/B.
    return true;
}();
// Settable override (the const-init above is the compile-time default). The
// use-site (build block) reads g_emit_self_loop so the toggle takes effect.
bool g_emit_self_loop = s_self_loop_enabled;

// Lever #2 (cross-block register residency) — 2-block region inlining. DELETED
// 2026-08-29 by the LEVER-12 audit. Kept as a note because the reasoning is the
// argument for not writing it again:
//
//   Shape: {A(BET_Cond, taken->B) -> B(BET_StaticJump -> A) -> A} emitted as ONE
//   wasm loop with B's body inlined, so the SH4 working set stays in locals
//   across A->B->A. LEVER-12's trace formation is a strict generalization of
//   exactly this shape (a 2-member loop trace), so nothing is lost.
//
//   Why deleted rather than left gated OFF:
//   1. It did NOT preserve slice cadence. Its inner loop yielded at
//      SELF_LOOP_CYCLE_SLICE (8192 guest cycles ~= 18 timeslices) instead of at
//      the timeslice boundary, so it ran ~455 iterations of arbitrary guest work
//      — including shop_writem stores — before the crediting loop could run
//      sh4_sched_tick/UpdateINTC. The offline runtime differential measured the
//      overshoot directly: fixture T2 ran 480 iterations under the region vs 174
//      per-block on the same credit budget, with the guest bytes byte-identical
//      over the shared prefix (deferral, not corruption). That is the same
//      deferral class as the unbounded self-loop that produced the Maple bit12
//      storm; the 8192 bound is the shipped self-loop's bound, but the shipped
//      self-loop defers ONE self-branching block's countdown, not a two-block
//      body with stores. LEVER-12 does not do this: every trace member keeps its
//      own slice-yield precheck, so a trace never runs a block on a spent slice.
//   2. It was unreachable in the shipped build: not in flycast_worker_link.sh's
//      EXPORTED_FUNCTIONS, no flycast_set_region wrapper in rec_wasm.cpp (the old
//      comment here claimed one existed — it never did), and a worker has no env
//      to read FLYCAST_REGION from. Dead weight that an A/B could still switch on
//      by hand and reintroduce (1).
//   3. It carried a second, independent copy of the RegCache dirty-model
//      reasoning inside a wasm `loop`. The audit found a real bug there (flushAll
//      inside a conditional arm that then left, with no saveDirty/restoreDirty),
//      which is exactly the maintenance cost of keeping two implementations of
//      one shape.
//
//   Its original shelving verdict is still the useful measurement: the title's
//   hot loops are CROSS-shard, and vaddr_to_block is a single batch, so an
//   intra-batch-only region never reached them (chit/schedtick unchanged ~528 ON
//   vs OFF). That constraint applies to LEVER-12 too — it is the reason the
//   trace lever has to be measured on shard-resident loops, not asserted.

// ---------------------------------------------------------------------------
// LEVER-12 — TRACE / SUPERBLOCK FORMATION (2026-08-29). Generalizes lever-2's
// hard-coded 2-block region into an N-block trace: starting at `block`, follow
// the successor chain through the shard batch and INLINE each member's body
// into the head's function, so the per-block-boundary tax is paid once per
// TRACE instead of once per basic block.
//
// What a boundary costs today, on the cheapest possible hop (both blocks in the
// same shard, so it is a direct `return_call`, IC not involved), counted off the
// offline emitter dump: caller-side cycle guard (5 instrs, 1 load) + the tail
// call (3) + callee slice precheck (6, 1 load) + callee reloadPrologue (3 instrs
// + 1 load per cached register) + callee drain (5, 1 store) + caller flushAll
// (3 instrs + 1 store per dirty register) + the PC store. With 4 live registers
// that is ~45 executed instructions and ~7 linear-memory accesses BEFORE any
// guest work. A trace boundary keeps only the slice precheck (5 instrs, 1 load)
// — everything else is structurally gone, because the registers never leave
// their wasm locals and there is no call.
//
// WHY NOW: the lever-2 card (docs/lever-2-region-residency.md, 2026-08-22)
// shelved regions because "vaddr_to_block is a SINGLE batch and the hot loops
// are cross-shard". That blocker was written when shard install was default
// OFF — the per-block path calls build_block(), which passes vaddr_to_block =
// nullptr, so NO region could ever form in the shipped configuration. Shard
// install is default ON since 2026-08-27 (lever-6D certification), batches are
// SHARD_BLOCK_CAP = 4096 blocks and only seal at that cap or after 100K
// dispatches (rec_wasm.cpp), so a hot loop's blocks — discovered within a few
// dispatches of each other — land in the SAME batch and resolve through the
// same map that already makes intra-shard `return_call` tail-links fire (the
// mechanism lever-6D measured at +27-30% on heavy scenes).
//
// SEMANTICS. Each inlined member keeps its OWN slice-yield precheck (flush +
// PC = that member's vaddr + return), so interrupt-service cadence is unchanged
// at block granularity — the trace never runs a block on a spent slice. Each
// member keeps its own cycle drain, so guest-cycle accounting is unchanged.
// What changes: (1) ctx->pc is not written at interior boundaries (it lags to
// the trace head, exactly as it already lags inside any multi-op block);
// (2) an interior member's code is executed from the head's inlined copy, so
// its OWN ram_code_sum is not re-verified on entry — the same staleness class
// as the default-ON intra-shard tail-link, which also calls a sibling's
// function body with no lookup (rec_wasm jit_lookup verify is per-lookup);
// (3) the block-cache-visible exit counters attribute to the head.
//
// DEFAULT OFF. Emission is deliberately NOT bit-identical (that is the point),
// so this needs a matched pair + a parity gate before any default flip.
//   FLYCAST_TRACE=0  off (default)
//   FLYCAST_TRACE=1  LOOP traces only (a member's successor returns to the head)
//   FLYCAST_TRACE=2  loop traces + straight-line traces
//   FLYCAST_TRACE_BLOCKS=<n>  max members (default 4, clamped 2..16)
//   FLYCAST_TRACE_OPS=<n>     max total SHIL ops (default 48, clamped 4..256)
//   FLYCAST_TRACE_XPAGE=1     allow members on a different 4KB page than the head
// Runtime setters: bemental_sh4_set_trace / _trace_limits (compile-time levers —
// they only affect blocks built AFTER the call).
// ---------------------------------------------------------------------------
// Matched-pair knob for browser builds — see the FLYCAST_AREA3_FAST_DEFAULT note
// on why the env var alone cannot flip a worker build.
// 0 = off, 1 = loop traces, 2 = loop + straight-line traces.
#ifndef FLYCAST_TRACE_DEFAULT
#define FLYCAST_TRACE_DEFAULT 0
#endif
int g_emit_trace = []{
    const char* e = std::getenv("FLYCAST_TRACE");
    return e ? std::atoi(e) : FLYCAST_TRACE_DEFAULT;
}();
u32 g_trace_max_blocks = []{
    const char* e = std::getenv("FLYCAST_TRACE_BLOCKS");
    u32 v = e ? (u32)std::atoi(e) : 4u;
    return v < 2 ? 2u : (v > 16 ? 16u : v);
}();
u32 g_trace_max_ops = []{
    const char* e = std::getenv("FLYCAST_TRACE_OPS");
    u32 v = e ? (u32)std::atoi(e) : 48u;
    return v < 4 ? 4u : (v > 256 ? 256u : v);
}();
bool g_trace_cross_page = []{
    const char* e = std::getenv("FLYCAST_TRACE_XPAGE");
    return e && e[0] != '0';
}();
// Risk-1 closure (see the g_trace_gen block for the full argument): guard every
// INTERIOR trace edge with an SMC generation compare, so a traced member can
// never run code the generation says has been overwritten. DEFAULT OFF, and
// deliberately so: the audit established that an unguarded trace edge is exactly
// as protected as the default-ON intra-shard tail-link it replaces (same map,
// same re-verify points, same unverified-entry count per unit of guest work), so
// this is an UPGRADE past shipping behaviour rather than a fix for a regression.
// It costs ~5 instructions + 2 loads per interior boundary on a lever whose whole
// value is boundary cost, so leaving it off keeps a matched pair measuring the
// lever instead of the lever plus a tax. Flip it ON for shipping once the raw
// win is measured. Inert while the IC is disarmed (?noic).
#ifndef FLYCAST_TRACE_SMCGUARD_DEFAULT
#define FLYCAST_TRACE_SMCGUARD_DEFAULT 0
#endif
bool g_trace_smc_guard = []{
    const char* e = std::getenv("FLYCAST_TRACE_SMCGUARD");
    return e ? (e[0] != '0') : (bool)FLYCAST_TRACE_SMCGUARD_DEFAULT;
}();

// Codegen-audit trim: derive a BET_CLS_COND exit's branch predicate ONCE
// instead of twice (see the BET_CLS_COND case in emitBlockExit). DEFAULT ON —
// it is a strict instruction reduction with identical observable semantics,
// carried by the offline runtime differential (ctx + all 16MB of guest RAM +
// ordered import log + cycles + credits + final PC). Kill-switch for a bisect.
bool g_emit_cond_merge = []{
    const char* e = std::getenv("FLYCAST_COND_MERGE");
    return e ? (e[0] != '0') : true;
}();
// Emit-time counters (read by a future ctxsnap case, like g_exit_*): how many
// traces formed and how many member blocks were inlined.
extern "C" { uint32_t g_trace_formed = 0; uint32_t g_trace_members = 0; uint32_t g_trace_loops = 0; }

// ORDER 21b: emit the immediate post-RTE UpdateINTC? DEFAULT OFF (the fix — RTE
// defers IRQ delivery to the slice-boundary crediting loop so the RTE target runs
// first, breaking the Maple bit12 storm livelock). ON = legacy per-block delivery.
bool g_emit_rte_intc = false;

// ORDER 21b: bound the in-block self-loop by cycle_counter (break every timeslice
// to service interrupts, native slice_loop)? The bound was added for the 384KB
// memset's deferred-IRQ burst, but it adds a per-timeslice round-trip that makes
// pure fixed-count busy-wait DELAY loops (e.g. the SEGA-screen timer at 0x8c0084f0,
// ~40M iters) ~30x slower than native. With the RTE-INTC + SRdecode interrupt-gate
// fixes now in, IRQ delivery is correct even when a self-loop defers a burst.
// DEFAULT ON (bounded, native slice_loop): unbounded collapses the fixed-count
// DELAY loops (advanced the boot to game code 0x8c411054 / the 0x8c3c2xxx event
// dispatcher) BUT defers IRQs in interrupt-DEPENDENT game loops, reintroducing the
// istnrm=0x1010 state there. The clean answer is a HYBRID (unbound pure busy-waits,
// keep bounded for polls) or a runtime idle-loop detector — until then bounded is
// the correct/safe default. Toggle to false for the delay-speedup experiment.
// VERDICT (2026-08-21 oracle-diff): unbounded self-loops let the scheduler bunch
// and defer IRQs unboundedly; bounded-per-timeslice is correct but pays a C
// round-trip every ~64 iters, making the boot's ~40M-iter busy-wait DELAY loops
// ~30x slower than native. FIX: batch by cycle_counter — run a big slice of
// iterations in-block (cheap), break to service IRQs, re-enter. SELF_LOOP_CYCLE_
// SLICE sets the batch: 0 = per-timeslice (old bounded); larger = fewer
// round-trips (faster delays) but coarser IRQ servicing. 65536 cycles (~0.3ms
// guest) is ~100x fewer breaks than per-timeslice yet services IRQs far finer
// than a VBlank (16ms) — collapses the boot delays without a storm.
bool g_self_loop_cycle_bound = true;
// Must stay BELOW the HBlank period (~12700 SH4 cycles) so the crediting loop
// delivers faster than level-6 (VBlank-In/HBlank) re-fires — otherwise level-6
// is always pending at each delivery and level-4 (Maple bit12) is STARVED, so
// bit12 never clears -> the game-phase istnrm=0x1010 wait (verified: main thread
// at 0x8c411054 with IMASK=0, so it is delivery-rate not masking). 8192 gives
// ~19x fewer round-trips than per-timeslice (fast delays) yet delivers finer
// than HBlank (level-4 gets its turn). Oracle-diff verdict, 2026-08-21.
constexpr s32 SELF_LOOP_CYCLE_SLICE = 8192;

static bool s_lazy_regcache_enabled = []{
    // Lever-6A: DEFAULT ON. The B11-class coherence hazard (lazy bookkeeping
    // inside conditional arms) is closed structurally: every lazy helper
    // consults WasmModuleBuilder::ifDepth() and BYPASSES the cache (direct
    // ctx access, no loaded/dirty mutation) inside if/else arms. loop/block
    // bodies execute unconditionally on entry and do not count.
    // 6A VERDICT (2026-08-26): REVERTED to OFF. With the ifDepth gate the
    // run went garbage-fast (clk p50 552MHz, fps=0 for 83 heartbeats — the
    // guest spun without presenting frames): at least one coherence class
    // remains uncovered. Do-not-retry without a full structural EmitIf
    // wrapper (the powerpc-next RegCache::EmitIf pattern) + an emitter unit
    // test. Eager stays the default.
    const char* e = std::getenv("FLYCAST_LAZY_REGCACHE");
    return e && e[0] != '0';
}();

// Per-block interrupt-pend prologue check. Mirrors redream's x64 backend
// (x64_backend.cc:651-653): test ctx->interrupt_pend, on non-zero dispatch
// UpdateINTC via the SHIL_FB sentinel and exit the block. Without this we
// only catch pending interrupts at timeslice boundaries (every 448 cycles
// in rec_wasm.cpp:1407-1414), which under our reduced JIT throughput lets
// PSO IRL4-wait loops poll forever. Default ON; env-var doesn't reach the
// pthread worker so flipping requires rebuild.
static bool s_intc_pend_check = []{
    const char* e = std::getenv("FLYCAST_INTC_PROLOGUE");
    if (e) return e[0] != '0';
    // DEFAULT OFF (2026-08-21): the per-block check delivered interrupt_pend on
    // EVERY block entry, so while a Holly level-4 (Maple bit12) interrupt was
    // pending the main thread re-vectored to the ISR on every block and made
    // zero forward progress -> a ~66K/s delivery STORM starving the boot. Native
    // x64 delivers only at timeslice boundaries (rec_wasm.cpp:2203-2206 does the
    // same, every 448 cyc), which lets the main thread run between interrupts and
    // clear the source. The 2026 IRL4-wait-loop concern predates honest crediting.
    return false;
}();

// ---------------------------------------------------------------------------
// Param helpers
// ---------------------------------------------------------------------------

static inline void emitLoadParam(WasmModuleBuilder& b, const shil_param& p) {
    if (p.is_imm()) {
        b.op_i32_const((s32)p._imm);
    } else if (p.is_r32i() || p.is_r32f()) {
        b.op_local_get(LOCAL_CTX);
        b.op_i32_load(p.reg_offset());
    }
}

static inline void emitLoadParamF32(WasmModuleBuilder& b, const shil_param& p) {
    if (p.is_imm()) {
        float val;
        u32 bits = p._imm;
        std::memcpy(&val, &bits, 4);
        b.op_f32_const(val);
    } else {
        b.op_local_get(LOCAL_CTX);
        b.op_f32_load(p.reg_offset());
    }
}

static inline void emitStoreRdF32(WasmModuleBuilder& b, const shil_param& rd) {
    b.op_f32_store(rd.reg_offset());
}

// ---------------------------------------------------------------------------
// Lever-5G: FPU f32 register cache. The CPU profile put 59.9% of heavy-phase
// wall in emitted block code, with every FPU op doing raw ctx
// load/load/op/store — geometry code was pure memory traffic. fr offsets
// whose every in-block access goes through these f32 helpers get f32 locals
// (candidates minus a conservative exclusion set built by scanBlockF32;
// mixed-path offsets stay memory-direct, so no cross-type staleness can
// exist). Kill-switch: FLYCAST_FPU_CACHE=0.
// ---------------------------------------------------------------------------
bool g_emit_fpu_cache = []{
    const char* e = std::getenv("FLYCAST_FPU_CACHE");
    return !(e && e[0] == '0');
}();

static inline void emitLoadParamF32C(WasmModuleBuilder& b, const shil_param& p,
                                     const RegCache& cache) {
    if (p.is_imm()) {
        float val;
        u32 bits = p._imm;
        std::memcpy(&val, &bits, 4);
        b.op_f32_const(val);
        return;
    }
    s32 local = cache.getLocalF32(p.reg_offset());
    if (local >= 0) {
        if (s_lazy_regcache_enabled && !cache.isLoaded(p.reg_offset())) {
            if (b.ifDepth() > 0) {               // 6A bypass
                b.op_local_get(LOCAL_CTX);
                b.op_f32_load(p.reg_offset());
                return;
            }
            b.op_local_get(LOCAL_CTX);
            b.op_f32_load(p.reg_offset());
            b.op_local_set((u32)local);
            const_cast<RegCache&>(cache).markLoaded(p.reg_offset());
        }
        b.op_local_get((u32)local);
        return;
    }
    b.op_local_get(LOCAL_CTX);
    b.op_f32_load(p.reg_offset());
}
static inline void emitPreStoreF32(WasmModuleBuilder& b, const shil_param& rd,
                                   const RegCache& cache) {
    if (!rd.is_imm() && cache.getLocalF32(rd.reg_offset()) >= 0) {
        if (!(s_lazy_regcache_enabled && !cache.isLoaded(rd.reg_offset()) && b.ifDepth() > 0))
            return;                              // 6A bypass otherwise
    }
    b.op_local_get(LOCAL_CTX);
}
static inline void emitPostStoreF32(WasmModuleBuilder& b, const shil_param& rd,
                                    RegCache& cache) {
    s32 local = cache.getLocalF32(rd.reg_offset());
    if (local >= 0 &&
        !(s_lazy_regcache_enabled && !cache.isLoaded(rd.reg_offset()) && b.ifDepth() > 0)) {
        b.op_local_set((u32)local);
        cache.markDirty(rd.reg_offset());
        cache.markLoaded(rd.reg_offset());
        return;
    }
    b.op_f32_store(rd.reg_offset());
}

// Lever-5G v2: offset-keyed variants for the raw-bank natives (fipr/ftrv)
// whose operand offsets are compile-time constants.
static inline void emitF32OffLoad(WasmModuleBuilder& b, const RegCache& cache, u32 off) {
    s32 local = cache.getLocalF32(off);
    if (local >= 0) {
        if (s_lazy_regcache_enabled && !cache.isLoaded(off)) {
            if (b.ifDepth() > 0) {               // 6A bypass
                b.op_local_get(LOCAL_CTX);
                b.op_f32_load(off);
                return;
            }
            b.op_local_get(LOCAL_CTX);
            b.op_f32_load(off);
            b.op_local_set((u32)local);
            const_cast<RegCache&>(cache).markLoaded(off);
        }
        b.op_local_get((u32)local);
        return;
    }
    b.op_local_get(LOCAL_CTX);
    b.op_f32_load(off);
}
static inline void emitF32OffStorePre(WasmModuleBuilder& b, const RegCache& cache, u32 off) {
    if (cache.getLocalF32(off) >= 0 &&
        !(s_lazy_regcache_enabled && !cache.isLoaded(off) && b.ifDepth() > 0)) return;
    b.op_local_get(LOCAL_CTX);
}
static inline void emitF32OffStorePost(WasmModuleBuilder& b, RegCache& cache, u32 off) {
    s32 local = cache.getLocalF32(off);
    if (local >= 0 &&
        !(s_lazy_regcache_enabled && !cache.isLoaded(off) && b.ifDepth() > 0)) {
        b.op_local_set((u32)local);
        cache.markDirty(off);
        cache.markLoaded(off);
        return;
    }
    b.op_f32_store(off);
}

// Cache-aware load: push the register's value onto the stack.
// F9 lazy mode: if the cache local hasn't been loaded yet, emit a one-shot
// `local.get ctx; i32.load <off>; local.set <local>` before the local.get.
// const_cast is necessary because the prior signature is `const RegCache&`
// for nearly every call site; flipping the whole API to non-const would
// touch dozens of lines for a single bookkeeping bit. The mutation is
// confined to `loaded`/dirty flags — the cache structure itself is stable.
static inline void emitLoadParamCached(WasmModuleBuilder& b, const shil_param& p,
                                       const RegCache& cache) {
    if (p.is_imm()) {
        b.op_i32_const((s32)p._imm);
        return;
    }
    if (p.is_r32i()) {
        s32 local = cache.getLocal(p.reg_offset());
        if (local >= 0) {
            if (s_lazy_regcache_enabled && !cache.isLoaded(p.reg_offset())) {
                if (b.ifDepth() > 0) {           // 6A: conditional arm — bypass
                    b.op_local_get(LOCAL_CTX);
                    b.op_i32_load(p.reg_offset());
                    return;
                }
                b.op_local_get(LOCAL_CTX);
                b.op_i32_load(p.reg_offset());
                b.op_local_set((u32)local);
                const_cast<RegCache&>(cache).markLoaded(p.reg_offset());
            }
            b.op_local_get((u32)local);
            return;
        }
    }
    b.op_local_get(LOCAL_CTX);
    b.op_i32_load(p.reg_offset());
}

// emitPreStore: push ctx_ptr ONLY if rd is not cached (paired with emitPostStore).
static inline void emitPreStore(WasmModuleBuilder& b, const shil_param& rd,
                                const RegCache& cache) {
    if (rd.is_r32i() && cache.getLocal(rd.reg_offset()) >= 0) {
        // 6A: an UNLOADED reg stored inside a conditional arm must go to ctx
        // (a local.set there would leave the other arm's path reading a
        // zero-initialized local via the merged compile-time state).
        if (!(s_lazy_regcache_enabled && !cache.isLoaded(rd.reg_offset()) && b.ifDepth() > 0))
            return;
    }
    b.op_local_get(LOCAL_CTX);
}

// emitPostStore: local.set if cached (and mark dirty), else i32.store with offset.
// F9 lazy mode: a local.set fully overwrites the local, so the local is now
// the canonical value — mark loaded so subsequent reads skip the lazy fetch.
static inline void emitPostStore(WasmModuleBuilder& b, const shil_param& rd,
                                 RegCache& cache) {
    if (rd.is_r32i()) {
        s32 local = cache.getLocal(rd.reg_offset());
        if (local >= 0 &&
            !(s_lazy_regcache_enabled && !cache.isLoaded(rd.reg_offset()) && b.ifDepth() > 0)) {
            b.op_local_set((u32)local);
            cache.markDirty(rd.reg_offset());
            if (s_lazy_regcache_enabled) cache.markLoaded(rd.reg_offset());
            return;
        }
    }
    b.op_i32_store(rd.reg_offset());
}

static inline void emitPreStoreOffset(WasmModuleBuilder& b, u32 offset,
                                      const RegCache& cache) {
    if (cache.getLocal(offset) >= 0) return;
    b.op_local_get(LOCAL_CTX);
}

static inline void emitPostStoreOffset(WasmModuleBuilder& b, u32 offset,
                                       RegCache& cache) {
    s32 local = cache.getLocal(offset);
    if (local >= 0) {
        b.op_local_set((u32)local);
        cache.markDirty(offset);
        if (s_lazy_regcache_enabled) cache.markLoaded(offset);
    } else {
        b.op_i32_store(offset);
    }
}

// F9 reload point: in eager mode this is reloadAll (emit a fetch per assigned
// register); in lazy mode this is invalidateAll (next use will fetch on demand).
// Applies at the block prologue and after every IFB/SHIL_FB fallback call.
static inline void reloadOrInvalidate(WasmModuleBuilder& b, RegCache& cache) {
    if (s_lazy_regcache_enabled) cache.invalidateAll();
    else                         cache.reloadAll(b);
}

// Block-prologue flavour: honours the per-entry `preload` bit computed by
// computeNoPreload. NEVER use this after a fallback call — there ctx memory is
// authoritative for every entry and reloadAll is the only correct reload.
static inline void reloadPrologueOrInvalidate(WasmModuleBuilder& b, RegCache& cache) {
    if (s_lazy_regcache_enabled) cache.invalidateAll();
    else                         cache.reloadPrologue(b);
}

// F9 helper for exit-path readers (jdyn / sr.T). emitBlockExit takes
// `const RegCache&`, so we const_cast to mutate the loaded flag. Same
// rationale as emitLoadParamCached's const_cast — only bookkeeping bits
// flip, never the entry map's structure.
static inline void emitCachedLocalGet(WasmModuleBuilder& b,
                                      const RegCache& cache,
                                      u32 ctxOffset, u32 wasmLocal) {
    if (s_lazy_regcache_enabled && !cache.isLoaded(ctxOffset)) {
        if (b.ifDepth() > 0) {                   // 6A: conditional arm — bypass
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctxOffset);
            return;
        }
        b.op_local_get(LOCAL_CTX);
        b.op_i32_load(ctxOffset);
        b.op_local_set(wasmLocal);
        const_cast<RegCache&>(cache).markLoaded(ctxOffset);
    }
    b.op_local_get(wasmLocal);
}

// ---------------------------------------------------------------------------
// Area-3 discriminator (see the g_emit_area3_fast comment for the bit-identity
// proof). CONTRACT, both flavours: consumes the raw EA from the stack, pushes
// the area-3 predicate, and leaves LOCAL_TMP holding
//   fast   -> the RAW EA          (nothing was masked)
//   legacy -> the MASKED phys EA  (addr & 0x1FFFFFFF)
// The taken arm reads LOCAL_TMP only through `& 0x00FFFFFF` (RAM index) and
// `& 0x00FFFFFC` (SMC chunk), which are invariant under the difference.
// ---------------------------------------------------------------------------
static void emitArea3Test(WasmModuleBuilder& b) {
    if (g_emit_area3_fast) {
        b.op_i32_const((s32)0x1C000000);
        b.op_i32_and();
        b.op_i32_const((s32)0x0C000000);
        b.op_i32_eq();
    } else {
        b.op_i32_const(0x1FFFFFFF);
        b.op_i32_and();
        b.op_local_tee(LOCAL_TMP);
        b.op_i32_const(26);
        b.op_i32_shr_u();
        b.op_i32_const(3);
        b.op_i32_eq();
    }
}
// Same, for call sites where the raw EA is on the stack but NOT yet in
// LOCAL_TMP (the legacy form's tee did double duty there).
static void emitArea3TestTee(WasmModuleBuilder& b) {
    if (g_emit_area3_fast) b.op_local_tee(LOCAL_TMP);
    emitArea3Test(b);
}
// Non-area-3 arm: push the RAW (unmasked) EA. Under the fast discriminator
// LOCAL_TMP still holds it, so the rs1(+rs3) recompute — and the extra cached
// loads it costs — disappears. Under the legacy form LOCAL_TMP was clobbered
// with the masked value, so the recompute is emitted exactly as before.
static void emitRawEaSlowArm(WasmModuleBuilder& b, const shil_opcode& op, RegCache& cache) {
    if (g_emit_area3_fast) { b.op_local_get(LOCAL_TMP); return; }
    emitLoadParamCached(b, op.rs1, cache);
    if (!op.rs3.is_null()) {
        emitLoadParamCached(b, op.rs3, cache);
        b.op_i32_add();
    }
}
// Variant for the arms that also need the raw EA IN LOCAL_TMP afterwards: the
// legacy form tees it, the fast form already has it there (so the tee, and the
// local.get feeding it, both vanish).
static void emitRawEaSlowArmTee(WasmModuleBuilder& b, const shil_opcode& op, RegCache& cache) {
    if (g_emit_area3_fast) { b.op_local_get(LOCAL_TMP); return; }
    emitLoadParamCached(b, op.rs1, cache);
    if (!op.rs3.is_null()) {
        emitLoadParamCached(b, op.rs3, cache);
        b.op_i32_add();
    }
    b.op_local_tee(LOCAL_TMP);
}
// Variant for the OC-RAM fallback arms, which consumed the recomputed EA into
// LOCAL_TMP with a local.set before re-reading it. Under the fast form the raw
// EA is already in LOCAL_TMP, so the whole recompute+set disappears.
static void emitRawEaSlowArmSet(WasmModuleBuilder& b, const shil_opcode& op, RegCache& cache) {
    if (g_emit_area3_fast) return;
    emitLoadParamCached(b, op.rs1, cache);
    if (!op.rs3.is_null()) {
        emitLoadParamCached(b, op.rs3, cache);
        b.op_i32_add();
    }
    b.op_local_set(LOCAL_TMP);
}

// ---------------------------------------------------------------------------
// Immediate-address fastpath helpers — port of rec_x64.cpp's
// GenReadMemImmediate / GenWriteMemImmediate (rec_x64.cpp:848-1053).
//
// When the effective address is computable at emit time we can:
//   - For RAM: emit a direct i32.load[8s|16s] / i32.store[8|16] against the
//     resolved host pointer (under emcc this IS a linear-mem offset). No
//     runtime area check, no slow-path import call.
//   - For MMIO: emit a direct WIMPORT_READn / WIMPORT_WRITEn call with the
//     physical address baked as an i32.const. Skips the runtime
//     (masked >> 26) == 3 area discriminator and the redundant
//     LOCAL_TMP shuffle.
//
// Both helpers return true if they emitted the operation natively; false
// means the caller should fall through to the existing area-3 runtime
// fastpath (which is what rec_x64 does too — see rec_x64.cpp:217 and :255).
// We extend rec_x64's rs1-only test to also accept op.rs3.is_imm() so
// reg-imm pre-folded addresses (which the SH4 SHIL pass leaves as rs1=imm,
// rs3=imm separately on some patterns) still hit the fastpath.
// ---------------------------------------------------------------------------
static bool emitImmediateAddress(u32& out_addr, const shil_opcode& op) {
    if (!op.rs1.is_imm()) return false;
    u32 addr = op.rs1._imm;
    if (!op.rs3.is_null()) {
        if (!op.rs3.is_imm()) return false;
        addr += op.rs3._imm;
    }
    out_addr = addr;
    return true;
}

// PORTED FROM rec_x64.cpp:848-969 (GenReadMemImmediate).
// Emits the read-side immediate fastpath. The pre-amble (`emitPreStore` for
// the destination) is the caller's responsibility because rd is loaded once
// per call site — same shape as rec_x64 deferring host_reg_to_shil_param to
// after the value is computed.
static bool tryEmitReadmImmediate(WasmModuleBuilder& b, const shil_opcode& op,
                                  RuntimeBlockInfo* block, RegCache& cache) {
    u32 addr;
    if (!emitImmediateAddress(addr, op)) return false;

    void* ptr = nullptr;
    bool isRam = false;
    u32 physAddr = 0;
    // PORTED FROM rec_x64.cpp:855.
    if (!rdv_readMemImmediate(addr, op.size, ptr, isRam, physAddr, block))
        return false;

    // 64-bit pair read — PORTED FROM rec_x64.cpp:899-938.
    if (op.size == 8) {
        if (isRam && ptr != nullptr) {
            // Two 32-bit loads from contiguous host RAM. Cast `ptr` to u32:
            // emcc represents a host pointer as a wasm linear-memory offset.
            const u32 base = (u32)(uintptr_t)ptr;
            b.op_local_get(LOCAL_CTX);
            b.op_i32_const((s32)base);
            b.op_i32_load(0);
            b.op_i32_store(op.rd.reg_offset());

            b.op_local_get(LOCAL_CTX);
            b.op_i32_const((s32)base);
            b.op_i32_load(4);
            b.op_i32_store(op.rd.reg_offset() + 4);
        } else {
            // MMIO 64-bit: two import calls. PORTED FROM rec_x64.cpp:918-937.
            b.op_local_get(LOCAL_CTX);
            b.op_i32_const((s32)physAddr);
            b.op_call(WIMPORT_READ32);
            b.op_i32_store(op.rd.reg_offset());

            b.op_local_get(LOCAL_CTX);
            b.op_i32_const((s32)(physAddr + 4));
            b.op_call(WIMPORT_READ32);
            b.op_i32_store(op.rd.reg_offset() + 4);
        }
        return true;
    }

    // 1/2/4-byte path. Push the destination ctx_ptr (or skip if rd is
    // cached in a local) then emit the value computation, then PostStore.
    emitPreStore(b, op.rd, cache);

    if (isRam && ptr != nullptr) {
        // RAM: bake the host pointer as the linear-mem base for a direct
        // i32.load[Ns|Nu]. Signed extension matches rec_x64's movsx
        // (rec_x64.cpp:869, :880) — readConst handlers return sign-extended
        // bytes/halfs.
        const u32 base = (u32)(uintptr_t)ptr;
        b.op_i32_const((s32)base);
        switch (op.size) {
        case 1: b.op_i32_load8_s(0); break;
        case 2: b.op_i32_load16_s(0); break;
        default: b.op_i32_load(0); break;
        }
    } else {
        // MMIO: emit a direct call to the appropriate import with the
        // resolved physical address as the argument. PORTED FROM
        // rec_x64.cpp:941-964.
        b.op_i32_const((s32)physAddr);
        switch (op.size) {
        // Sign-extend 8/16-bit import reads: SH4 mov.b/mov.w sign-extend at
        // the CPU regardless of source; the sh4_mem_read8/16 imports return
        // zero-extended u32 (audit finding #2 — the area-3 arm already uses
        // i32.load8_s/16_s; the import arms diverged from the interpreter).
        case 1: b.op_call(WIMPORT_READ8);
                b.op_i32_const(24); b.op_i32_shl();
                b.op_i32_const(24); b.op_i32_shr_s(); break;
        case 2: b.op_call(WIMPORT_READ16);
                b.op_i32_const(16); b.op_i32_shl();
                b.op_i32_const(16); b.op_i32_shr_s(); break;
        default: b.op_call(WIMPORT_READ32); break;
        }
    }

    emitPostStore(b, op.rd, cache);
    return true;
}

// PORTED FROM rec_x64.cpp:971-1053 (GenWriteMemImmediate).
static bool tryEmitWriteMemImmediate(WasmModuleBuilder& b, const shil_opcode& op,
                                     RuntimeBlockInfo* block, RegCache& cache) {
    u32 addr;
    if (!emitImmediateAddress(addr, op)) return false;

    void* ptr = nullptr;
    bool isRam = false;
    u32 physAddr = 0;
    // PORTED FROM rec_x64.cpp:978.
    if (!rdv_writeMemImmediate(addr, op.size, ptr, isRam, physAddr, block))
        return false;

    // 64-bit pair write — PORTED FROM rec_x64.cpp:1027-1035.
    if (op.size == 8) {
        if (isRam && ptr != nullptr) {
            const u32 base = (u32)(uintptr_t)ptr;
            b.op_i32_const((s32)base);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(op.rs2.reg_offset());
            b.op_i32_store(0);

            b.op_i32_const((s32)base);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(op.rs2.reg_offset() + 4);
            b.op_i32_store(4);

            // Lever-4: area-3 only (isRam also covers VRAM immediates, which
            // hold no SH4 code). Width 8 covers the pair's touched chunks.
            const u32 phys = addr & 0x1FFFFFFFu;
            if ((phys >> 26) == 3)
                emitSmcMarkConstPage(b, phys, 8);
        } else {
            // MMIO 64-bit: two write32 import calls.
            b.op_i32_const((s32)physAddr);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(op.rs2.reg_offset());
            b.op_call(WIMPORT_WRITE32);

            b.op_i32_const((s32)(physAddr + 4));
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(op.rs2.reg_offset() + 4);
            b.op_call(WIMPORT_WRITE32);
        }
        return true;
    }

    if (isRam && ptr != nullptr) {
        // PORTED FROM rec_x64.cpp:986-1024: store the data via a direct
        // i32.store[N] at the resolved host base.
        const u32 base = (u32)(uintptr_t)ptr;
        b.op_i32_const((s32)base);
        emitLoadParamCached(b, op.rs2, cache);
        switch (op.size) {
        case 1: b.op_i32_store8(0); break;
        case 2: b.op_i32_store16(0); break;
        default: b.op_i32_store(0); break;
        }
        // Lever-4: area-3 only (isRam also covers VRAM immediates).
        if (((addr & 0x1FFFFFFFu) >> 26) == 3)
            emitSmcMarkConstPage(b, addr & 0x1FFFFFFFu, op.size);
    } else {
        // PORTED FROM rec_x64.cpp:1046-1049: MMIO write through the import.
        b.op_i32_const((s32)physAddr);
        emitLoadParamCached(b, op.rs2, cache);
        switch (op.size) {
        case 1: b.op_call(WIMPORT_WRITE8);  break;
        case 2: b.op_call(WIMPORT_WRITE16); break;
        default: b.op_call(WIMPORT_WRITE32); break;
        }
    }

    return true;
}

// SHIL_FB ops are dispatched host-side (sh4_interp_shil_fb) from a pointer baked
// into the emitted block. The RuntimeBlockInfo oplist that `op` lives in is FREED
// after compile() (bementalJIT blocks aren't retained in flycast's bm), so baking
// &op directly DANGLES — at run time sh4_interp_shil_fb then reads freed memory
// whose op.op is often a shil_recimp (mov32/writem/jdyn/...) and die()s "requires
// native dynarec implementation" (fatal). Persist a leaked copy (bounded by the
// number of SHIL_FB ops compiled — a boot's worth is a few thousand * ~sizeof) so
// the baked pointer stays valid for the life of the emitted block. ORDER 21b.
static u32 persist_shil_op(const shil_opcode& op) {
    return (u32)(uintptr_t)(new shil_opcode(op));
}

// ---------------------------------------------------------------------------
// Per-op emit. Returns true if natively handled, false to fall back to IFB.
// ---------------------------------------------------------------------------
bool emitShilOp(WasmModuleBuilder& b, const shil_opcode& op,
                RuntimeBlockInfo* block, u32 opIndex, RegCache& cache) {
    switch (op.op) {

    // ---- Integer ALU ----
    // PORTED FROM xbyak_base.h:133-141 (shil_param_to_host_reg ==> mov rd,rs1)
    case shop_mov32:
        // Lever-5G: fmov fr,fr routes through the f32 cache when either side
        // holds an f32 entry (bit-preserving through f32 locals — wasm
        // local/load/store moves never canonicalize NaNs; only arithmetic
        // may). Uncached sides fall to ctx f32 load/store, same bits.
        if (g_emit_fpu_cache && op.rd.is_r32f() && op.rs1.is_r32f() &&
            (cache.getLocalF32(op.rd.reg_offset()) >= 0 ||
             cache.getLocalF32(op.rs1.reg_offset()) >= 0)) {
            emitPreStoreF32(b, op.rd, cache);
            emitLoadParamF32C(b, op.rs1, cache);
            emitPostStoreF32(b, op.rd, cache);
            return true;
        }
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:169-171 (genBinaryOp(op, add))
    case shop_add:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_add();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:172-174 (genBinaryOp(op, sub))
    // x86 genBinaryOp has a "neg+add" trick when rd==rs2 (xbyak_base.h:46-53);
    // unneeded here — wasm has no register aliasing, we emit a fresh
    // expression tree (load rs1; load rs2; i32.sub; store rd).
    case shop_sub:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_sub();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:160-162 (genBinaryOp(op, and_))
    case shop_and:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_and();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:163-165 (genBinaryOp(op, or_))
    case shop_or:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_or();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:166-168 (genBinaryOp(op, xor_))
    case shop_xor:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_xor();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:154-158 (mov rd,rs1; not_ rd)
    // Wasm has no `not` op; bitwise NOT is implemented as xor with all-ones.
    case shop_not:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(-1);
        b.op_i32_xor();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:149-153 (mov rd,rs1; neg rd)
    // Wasm has no `neg` op; two's-complement negate is 0 - x.
    case shop_neg:
        emitPreStore(b, op.rd, cache);
        b.op_i32_const(0);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_sub();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:176-185 (SHIFT_OP(shl))
    // SH4 SHIL only emits imm rs2 here (variable shifts are shop_shld/shad).
    // x86 emit dies on non-imm rs2; the wasm path also accepts reg-sourced
    // rs2 (harmless — wasm i32.shl masks shift count to low 5 bits, matching
    // x86 `shl r32, cl`).
    case shop_shl:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_shl();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:186-188 (SHIFT_OP(shr))
    case shop_shr:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_shr_u();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:189-191 (SHIFT_OP(sar))
    case shop_sar:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_shr_s();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:192-194 (SHIFT_OP(ror))
    case shop_ror:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_rotr();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_ext_s8:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(24);
        b.op_i32_shl();
        b.op_i32_const(24);
        b.op_i32_shr_s();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_ext_s16:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(16);
        b.op_i32_shl();
        b.op_i32_const(16);
        b.op_i32_shr_s();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_mul_u16:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(0xFFFF);
        b.op_i32_and();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_const(0xFFFF);
        b.op_i32_and();
        b.op_i32_mul();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_mul_s16:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(16);
        b.op_i32_shl();
        b.op_i32_const(16);
        b.op_i32_shr_s();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_const(16);
        b.op_i32_shl();
        b.op_i32_const(16);
        b.op_i32_shr_s();
        b.op_i32_mul();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_mul_i32:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_mul();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:143-147 (mov rd,rs1; ror rd.cvt16(), 8)
    // SWAP.B swaps the two low bytes [byte0 <-> byte1], leaving the high
    // 16 bits unchanged. x86 does this with a 16-bit ror-by-8 on the low
    // half. Wasm has no 16-bit-wide rotate, so we reconstruct manually:
    //   rd = ((rs1 >> 8) & 0xFF) | ((rs1 & 0xFF) << 8) | (rs1 & 0xFFFF0000)
    // Caches rs1 in LOCAL_TMP so we don't re-emit emitLoadParamCached three
    // times (in lazy-regcache mode that could trigger the F9 coherence bug).
    case shop_swaplb:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_local_tee(LOCAL_TMP);
        b.op_i32_const(8);
        b.op_i32_shr_u();
        b.op_i32_const(0xFF);
        b.op_i32_and();
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(0xFF);
        b.op_i32_and();
        b.op_i32_const(8);
        b.op_i32_shl();
        b.op_i32_or();
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const((s32)0xFFFF0000u);
        b.op_i32_and();
        b.op_i32_or();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_xtrct:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(16);
        b.op_i32_shr_u();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_const(16);
        b.op_i32_shl();
        b.op_i32_or();
        emitPostStore(b, op.rd, cache);
        return true;

    // ---- Comparisons ----
    case shop_test:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_and();
        b.op_i32_eqz();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_seteq:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_eq();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_setge:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_ge_s();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_setgt:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_gt_s();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_setae:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_ge_u();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_setab:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_gt_u();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_setpeq: {
        // PORTED FROM rec-x64/xbyak_base.h:355
        // setpeq: rd = 1 if any byte of (rs1 XOR rs2) is zero, else 0.
        // x64 short-circuits with `je end` after each byte-test; wasm has no
        // labelled gotos to jump out mid-expression, so we OR four byte-zero
        // results together (each i32 is 1 if that byte matched, 0 otherwise).
        // emitLoadParamCached for rs2 handles both reg and imm cases — xbyak
        // base branches on op.rs2.is_r32i() but the SHIL semantics are the
        // same regardless.
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_xor();
        b.op_local_tee(LOCAL_TMP);
        b.op_i32_const(0xFF);
        b.op_i32_and();
        b.op_i32_eqz();
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(8);
        b.op_i32_shr_u();
        b.op_i32_const(0xFF);
        b.op_i32_and();
        b.op_i32_eqz();
        b.op_i32_or();
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(16);
        b.op_i32_shr_u();
        b.op_i32_const(0xFF);
        b.op_i32_and();
        b.op_i32_eqz();
        b.op_i32_or();
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(24);
        b.op_i32_shr_u();
        b.op_i32_eqz();
        b.op_i32_or();
        emitPostStore(b, op.rd, cache);
        return true;
    }

    // ---- Dynamic jump / conditional ----
    // PORTED FROM xbyak_base.h:106-131 (shop_jcond / shop_jdyn shared block)
    // x86 writes the resolved jump target into mapRegister(op.rd) (a host
    // GPR) and lets rec_x64.cpp's epilogue read it. We can't preserve host
    // register state across the dispatcher boundary, so we spill the target
    // into ctx_off::JDYN (a context field) — the dispatcher reads it as the
    // next-PC. Per task constraint #4: do NOT emit a native wasm branch
    // here; the block-boundary semantics require the dispatcher.
    //
    // x86 handles rs1.is_imm() (line 113-121) by `mov rd, imm` (+ optional
    // add of rs2 imm). emitLoadParamCached already collapses that case into
    // an i32.const, and the rs2 add below mirrors xbyak_base.h:127-128.
    case shop_jdyn:
        emitPreStoreOffset(b, ctx_off::JDYN, cache);
        emitLoadParamCached(b, op.rs1, cache);
        if (!op.rs2.is_null()) {
            emitLoadParamCached(b, op.rs2, cache);
            b.op_i32_add();
        }
        emitPostStoreOffset(b, ctx_off::JDYN, cache);
        return true;

    // PORTED FROM xbyak_base.h:106-131. shop_jcond shares the case body with
    // shop_jdyn — both fold an optional rs2 (immediate offset) into rs1. The
    // prior wasm port assumed rs2 was always null for jcond; xbyak_base makes
    // no such assumption, so we now match it identically.
    case shop_jcond:
        emitPreStoreOffset(b, ctx_off::JDYN, cache);
        emitLoadParamCached(b, op.rs1, cache);
        if (!op.rs2.is_null()) {
            emitLoadParamCached(b, op.rs2, cache);
            b.op_i32_add();
        }
        emitPostStoreOffset(b, ctx_off::JDYN, cache);
        return true;

    // ---- Memory: 1/2/4-byte readm with area-3 fastpath ----
    case shop_readm: {
        // PORTED FROM rec_x64.cpp:216-251.
        // Immediate-address fastpath FIRST (rec_x64.cpp:217 — `if
        // (!GenReadMemImmediate(op, block))`). When the EA is constant at
        // emit time the resolver returns a host pointer (RAM) or a known
        // physical address (MMIO) and we skip the runtime area dispatch.
        if (g_emit_imm_fastpath && tryEmitReadmImmediate(b, op, block, cache))
            return true;

        emitLoadParamCached(b, op.rs1, cache);
        if (!op.rs3.is_null()) {
            emitLoadParamCached(b, op.rs3, cache);
            b.op_i32_add();
        }
        b.op_local_set(LOCAL_TMP);

        if (op.size == 8) {
            // 64-bit read (float pair). Lever-5A area-3 fastpath: without it
            // every fmov.d @Rm+ pays TWO C imports — the heavy-phase memcpy
            // and geometry loops' dominant per-iteration cost (bulk moves use
            // fmov.d under FPSCR.SZ=1). Same two-i32 shape as the proven
            // imm-EA variant; MMIO falls through to the import pair.
            if (g_emit_mem_fastpaths) {
                b.op_local_get(LOCAL_TMP);
                emitArea3Test(b);                // TMP: raw (fast) / masked (legacy)
                b.op_if(0x40);
                    b.op_local_get(LOCAL_CTX);   // for the lo-word store
                    b.op_local_get(LOCAL_RAM);
                    b.op_local_get(LOCAL_TMP);
                    b.op_i32_const(0x00FFFFFF);
                    b.op_i32_and();
                    b.op_i32_add();
                    b.op_local_tee(LOCAL_TMP2);  // linear addr
                    b.op_i32_load(0);
                    b.op_i32_store(op.rd.reg_offset());
                    b.op_local_get(LOCAL_CTX);
                    b.op_local_get(LOCAL_TMP2);
                    b.op_i32_load(4);
                    b.op_i32_store(op.rd.reg_offset() + 4);
                b.op_else();
                    // Non-RAM: the RAW EA. Under the legacy discriminator TMP
                    // holds the MASKED value here, so it is recomputed from
                    // rs1(+rs3); under the fast one TMP is already raw.
                    emitRawEaSlowArmTee(b, op, cache);
                    b.op_call(WIMPORT_READ32);
                    b.op_local_set(LOCAL_TMP2);
                    b.op_local_get(LOCAL_CTX);
                    b.op_local_get(LOCAL_TMP2);
                    b.op_i32_store(op.rd.reg_offset());
                    b.op_local_get(LOCAL_TMP);
                    b.op_i32_const(4);
                    b.op_i32_add();
                    b.op_call(WIMPORT_READ32);
                    b.op_local_set(LOCAL_TMP2);
                    b.op_local_get(LOCAL_CTX);
                    b.op_local_get(LOCAL_TMP2);
                    b.op_i32_store(op.rd.reg_offset() + 4);
                b.op_end();
                return true;
            }
            b.op_local_get(LOCAL_TMP);
            b.op_call(WIMPORT_READ32);
            b.op_local_set(LOCAL_TMP2);
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_TMP2);
            b.op_i32_store(op.rd.reg_offset());

            b.op_local_get(LOCAL_TMP);
            b.op_i32_const(4);
            b.op_i32_add();
            b.op_call(WIMPORT_READ32);
            b.op_local_set(LOCAL_TMP2);
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_TMP2);
            b.op_i32_store(op.rd.reg_offset() + 4);
            return true;
        }

        if (!g_emit_mem_fastpaths) {
            // Slow-only arm: original (unmasked) EA through the import.
            emitPreStore(b, op.rd, cache);
            b.op_local_get(LOCAL_TMP);
            switch (op.size) {
            // Sign-extend (see audit finding #2 note above).
            case 1: b.op_call(WIMPORT_READ8);
                    b.op_i32_const(24); b.op_i32_shl();
                    b.op_i32_const(24); b.op_i32_shr_s(); break;
            case 2: b.op_call(WIMPORT_READ16);
                    b.op_i32_const(16); b.op_i32_shl();
                    b.op_i32_const(16); b.op_i32_shr_s(); break;
            default: b.op_call(WIMPORT_READ32); break;
            }
            emitPostStore(b, op.rd, cache);
            return true;
        }

        emitPreStore(b, op.rd, cache);


        b.op_local_get(LOCAL_TMP);
        emitArea3Test(b);                        // TMP: raw (fast) / masked (legacy)

        b.op_if(WASM_TYPE_I32);
        b.op_local_get(LOCAL_RAM);
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(0x00FFFFFF);
        b.op_i32_and();
        b.op_i32_add();
        switch (op.size) {
        case 1: b.op_i32_load8_s(0); break;
        case 2: b.op_i32_load16_s(0); break;
        default: b.op_i32_load(0); break;
        }
        b.op_else();
        // Slow path: recompute the ORIGINAL virtual address (rs1 + rs3).
        // The fast-path branch masked LOCAL_TMP to 0x1FFFFFFF, which would
        // collapse SH4 P4-region addresses (0xFF800000+, BSC/INTC/TMU MMIO)
        // down to P0 mirrors that hit unmapped space in Flycast's memmap.
        // Bug discovered 2026-05-14: BIOS at 0x800000A2 reads RFCR
        // (0xFF800028), got back 0 instead of 0x11, polled loop never exited.
        // (Under the FAST discriminator nothing was masked, so LOCAL_TMP still
        // holds the original virtual address and the recompute is elided.)
        // Lever-9D v2: OC-RAM arm ON THE IMPORT-FALLBACK PATH ONLY. v1 tested
        // every access up front and lost 5.2% (the guard + CCR load ran on
        // tens of millions of RAM accesses/s to save ~340K imports/s). Here
        // the area-3 arm has already filtered the common case for free; this
        // path runs only for non-RAM EAs, where the measured traffic is 100%
        // OC-RAM (raw bucket b31 — PSO keeps its stack at 0x7Exxxxxx).
        // Mapping = onChipRamOffset (sh4_mmr.cpp): ((raw>>(OIX?13:1))&0x1000)
        // | (raw&0xfff), gated on CCR.ORA; P4 MMRs (0xFF...) fail the raw
        // range test and keep the import.
        const bool ocfp_r = g_emit_ocram_fp && g_ocram_lin_base != 0 && g_ccr_addr != 0;
        if (ocfp_r) {
            emitRawEaSlowArmSet(b, op, cache);   // legacy: recompute + set; fast: no-op
            b.op_local_get(LOCAL_TMP);           // raw EA
            b.op_i32_const((s32)0xFC000000);
            b.op_i32_and();
            b.op_i32_const((s32)0x7C000000);
            b.op_i32_eq();
            b.op_i32_const((s32)g_ccr_addr);
            b.op_i32_load(0);
            b.op_i32_const(0x20);                // CCR.ORA
            b.op_i32_and();
            b.op_i32_const(0);
            b.op_i32_ne();
            b.op_i32_and();
            b.op_if(WASM_TYPE_I32);
            b.op_i32_const((s32)g_ccr_addr);
            b.op_i32_load(0);
            b.op_i32_const(0x80);                // CCR.OIX index-mode select
            b.op_i32_and();
            b.op_if(WASM_TYPE_I32);
              b.op_local_get(LOCAL_TMP); b.op_i32_const(13); b.op_i32_shr_u();
            b.op_else();
              b.op_local_get(LOCAL_TMP); b.op_i32_const(1); b.op_i32_shr_u();
            b.op_end();
            b.op_i32_const(0x1000); b.op_i32_and();
            b.op_local_get(LOCAL_TMP); b.op_i32_const(0xfff); b.op_i32_and();
            b.op_i32_or();
            b.op_i32_const((s32)g_ocram_lin_base);
            b.op_i32_add();
            switch (op.size) {
            case 1: b.op_i32_load8_s(0); break;
            case 2: b.op_i32_load16_s(0); break;
            default: b.op_i32_load(0); break;
            }
            b.op_else();
            b.op_local_get(LOCAL_TMP);
            switch (op.size) {
            case 1: b.op_call(WIMPORT_READ8);
                    b.op_i32_const(24); b.op_i32_shl();
                    b.op_i32_const(24); b.op_i32_shr_s(); break;
            case 2: b.op_call(WIMPORT_READ16);
                    b.op_i32_const(16); b.op_i32_shl();
                    b.op_i32_const(16); b.op_i32_shr_s(); break;
            default: b.op_call(WIMPORT_READ32); break;
            }
            b.op_end();
        } else {
        emitRawEaSlowArm(b, op, cache);          // raw EA for the import
        switch (op.size) {
        // Sign-extend 8/16-bit import reads: SH4 mov.b/mov.w sign-extend at
        // the CPU regardless of source; the sh4_mem_read8/16 imports return
        // zero-extended u32 (audit finding #2 — the area-3 arm already uses
        // i32.load8_s/16_s; the import arms diverged from the interpreter).
        case 1: b.op_call(WIMPORT_READ8);
                b.op_i32_const(24); b.op_i32_shl();
                b.op_i32_const(24); b.op_i32_shr_s(); break;
        case 2: b.op_call(WIMPORT_READ16);
                b.op_i32_const(16); b.op_i32_shl();
                b.op_i32_const(16); b.op_i32_shr_s(); break;
        default: b.op_call(WIMPORT_READ32); break;
        }
        }
        b.op_end();

        emitPostStore(b, op.rd, cache);
        return true;
    }

    // ---- Memory: 1/2/4-byte writem with area-3 fastpath ----
    case shop_writem: {
        // PORTED FROM rec_x64.cpp:253-286.
        // Immediate-address fastpath FIRST (rec_x64.cpp:255 — `if
        // (!GenWriteMemImmediate(op, block))`). For an immediate EA that
        // resolves into VRAM the resolver returns `isram=true` with
        // ptr=&vram[offset] — under emcc that pointer IS the linear-mem
        // offset, so this naturally subsumes the area-4/5 g_vram_lin_base
        // path below for the immediate case while keeping the runtime
        // VRAM fastpath for register-based addresses.
        if (g_emit_imm_fastpath && tryEmitWriteMemImmediate(b, op, block, cache))
            return true;

        if (op.size == 8) {
            // Lever-5A area-3 fastpath for the fmov.d store pair (was two
            // unconditional C imports). RAM arm: two in-wasm i32 stores + the
            // width-8 SMC mark; non-RAM recomputes the raw EA for the imports.
            if (g_emit_mem_fastpaths && g_emit_writem_fp) {
                emitLoadParamCached(b, op.rs1, cache);
                if (!op.rs3.is_null()) {
                    emitLoadParamCached(b, op.rs3, cache);
                    b.op_i32_add();
                }
                emitArea3TestTee(b);             // TMP: raw (fast) / masked (legacy)
                b.op_if(0x40);
                    b.op_local_get(LOCAL_RAM);
                    b.op_local_get(LOCAL_TMP);
                    b.op_i32_const(0x00FFFFFF);
                    b.op_i32_and();
                    b.op_i32_add();
                    b.op_local_tee(LOCAL_TMP2);  // linear addr
                    b.op_local_get(LOCAL_CTX);
                    b.op_i32_load(op.rs2.reg_offset());
                    b.op_i32_store(0);
                    b.op_local_get(LOCAL_TMP2);
                    b.op_local_get(LOCAL_CTX);
                    b.op_i32_load(op.rs2.reg_offset() + 4);
                    b.op_i32_store(4);
                    emitSmcMarkLocal(b, LOCAL_TMP, 8);
                b.op_else();
                    emitRawEaSlowArmTee(b, op, cache);
                    b.op_local_get(LOCAL_CTX);
                    b.op_i32_load(op.rs2.reg_offset());
                    b.op_call(WIMPORT_WRITE32);
                    b.op_local_get(LOCAL_TMP);
                    b.op_i32_const(4);
                    b.op_i32_add();
                    b.op_local_get(LOCAL_CTX);
                    b.op_i32_load(op.rs2.reg_offset() + 4);
                    b.op_call(WIMPORT_WRITE32);
                b.op_end();
                return true;
            }
            emitLoadParamCached(b, op.rs1, cache);
            if (!op.rs3.is_null()) {
                emitLoadParamCached(b, op.rs3, cache);
                b.op_i32_add();
            }
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(op.rs2.reg_offset());
            b.op_call(WIMPORT_WRITE32);

            emitLoadParamCached(b, op.rs1, cache);
            if (!op.rs3.is_null()) {
                emitLoadParamCached(b, op.rs3, cache);
                b.op_i32_add();
            }
            b.op_i32_const(4);
            b.op_i32_add();
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(op.rs2.reg_offset() + 4);
            b.op_call(WIMPORT_WRITE32);
            return true;
        }

        emitLoadParamCached(b, op.rs1, cache);
        if (!op.rs3.is_null()) {
            emitLoadParamCached(b, op.rs3, cache);
            b.op_i32_add();
        }
        b.op_local_set(LOCAL_TMP);

        if (!g_emit_mem_fastpaths || !g_emit_writem_fp) {
            // Slow-only arm: original (unmasked) EA through the import.
            b.op_local_get(LOCAL_TMP);
            emitLoadParamCached(b, op.rs2, cache);
            switch (op.size) {
            case 1: b.op_call(WIMPORT_WRITE8);  break;
            case 2: b.op_call(WIMPORT_WRITE16); break;
            default: b.op_call(WIMPORT_WRITE32); break;
            }
            return true;
        }


        b.op_local_get(LOCAL_TMP);
        emitArea3Test(b);                        // TMP: raw (fast) / masked (legacy)

        b.op_if();
        b.op_local_get(LOCAL_RAM);
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(0x00FFFFFF);
        b.op_i32_and();
        b.op_i32_add();
        emitLoadParamCached(b, op.rs2, cache);
        switch (op.size) {
        case 1: b.op_i32_store8(0); break;
        case 2: b.op_i32_store16(0); break;
        default: b.op_i32_store(0); break;
        }
        // Lever-4: this is the one store the C hooks can't see — mark it.
        emitSmcMarkLocal(b, LOCAL_TMP, op.size);
        b.op_else();
        // NON-area-3 stores → canonical flycast import (sh4_mem_write* ->
        // WriteMem -> pvr_write32p / etc). The former in-wasm area-1 VRAM
        // swizzle store is REMOVED (boot-title-wedge 2026-08-20, bisected
        // as the boot-blocking bug): its offset math matched pvr_map32
        // exactly, but a raw i32.store into vram[] SKIPS flycast's
        // pvr_write32p side effects (fb_dirty framebuffer-watch), so the
        // boot's direct-VRAM framebuffer write never marked the frame dirty
        // and boot wedged. The VRAM-clear that motivated the swizzle now
        // completes anyway (honest sh4_sched cycle crediting fixed the real
        // stall — it was scheduler starvation, not write speed). Perf can be
        // revisited with a swizzle that ALSO sets fb_dirty; correctness
        // first. (audit finding: the memory-fastpath boot bug.)
        // (Under the FAST discriminator LOCAL_TMP still holds the raw EA, so
        // the rs1(+rs3) recompute below is elided — see emitRawEaSlowArm*.)
        // Lever-9D v2: OC-RAM store arm on the import-fallback path only (see
        // the readm twin for the v1 -5.2% lesson). No smc_mark: OC-RAM is not
        // JIT-source space (blocks compile from RAM/ROM vaddrs only).
        {
        const bool ocfp_w = g_emit_ocram_fp && g_ocram_lin_base != 0 && g_ccr_addr != 0;
        if (ocfp_w) {
            emitRawEaSlowArmSet(b, op, cache);   // legacy: recompute + set; fast: no-op
            b.op_local_get(LOCAL_TMP);           // raw EA
            b.op_i32_const((s32)0xFC000000);
            b.op_i32_and();
            b.op_i32_const((s32)0x7C000000);
            b.op_i32_eq();
            b.op_i32_const((s32)g_ccr_addr);
            b.op_i32_load(0);
            b.op_i32_const(0x20);                // CCR.ORA
            b.op_i32_and();
            b.op_i32_const(0);
            b.op_i32_ne();
            b.op_i32_and();
            b.op_if(0x40);
            b.op_i32_const((s32)g_ccr_addr);
            b.op_i32_load(0);
            b.op_i32_const(0x80);                // CCR.OIX index-mode select
            b.op_i32_and();
            b.op_if(WASM_TYPE_I32);
              b.op_local_get(LOCAL_TMP); b.op_i32_const(13); b.op_i32_shr_u();
            b.op_else();
              b.op_local_get(LOCAL_TMP); b.op_i32_const(1); b.op_i32_shr_u();
            b.op_end();
            b.op_i32_const(0x1000); b.op_i32_and();
            b.op_local_get(LOCAL_TMP); b.op_i32_const(0xfff); b.op_i32_and();
            b.op_i32_or();
            b.op_i32_const((s32)g_ocram_lin_base);
            b.op_i32_add();
            emitLoadParamCached(b, op.rs2, cache);
            switch (op.size) {
            case 1: b.op_i32_store8(0); break;
            case 2: b.op_i32_store16(0); break;
            default: b.op_i32_store(0); break;
            }
            b.op_else();
            b.op_local_get(LOCAL_TMP);
            emitLoadParamCached(b, op.rs2, cache);
            switch (op.size) {
            case 1: b.op_call(WIMPORT_WRITE8);  break;
            case 2: b.op_call(WIMPORT_WRITE16); break;
            default: b.op_call(WIMPORT_WRITE32); break;
            }
            b.op_end();
        } else {
        emitRawEaSlowArm(b, op, cache);          // raw EA for the import
        emitLoadParamCached(b, op.rs2, cache);
        switch (op.size) {
        case 1: b.op_call(WIMPORT_WRITE8);  break;
        case 2: b.op_call(WIMPORT_WRITE16); break;
        default: b.op_call(WIMPORT_WRITE32); break;
        }
        }
        }
        b.op_end();                              // close outer area-3 if
        return true;
    }

    // ---- Single-op interpreter fallback ----
    case shop_ifb: {
        // PORTED FROM rec_x64.cpp:161-182
        // x64:  if (op.rs1._imm) sh4ctx.pc = op.rs2._imm; call OpDesc[op.rs3]->oph
        // wasm: same pc-write, then WIMPORT_IFB(opcode, pc) which routes to
        //       sh4_interp_ifb (EmscriptenWorker.cpp:983) on the host side.
        //
        // Unlike x64 (which has the host function pointer baked in at compile
        // time), wasm must round-trip through an import. To amortize the cost,
        // we inline native fast-paths below for DIV0U/DIV0S — flycast's
        // decoder emits these as shop_ifb but the semantics are simple enough
        // to expand inline.
        cache.flushAll(b);
        if (op.rs1._imm) {
            b.op_local_get(LOCAL_CTX);
            b.op_i32_const((s32)op.rs2._imm);
            b.op_i32_store(ctx_off::PC);
        }
        // Inline fast paths for opcodes flycast's decoder emits as shop_ifb
        // but whose semantics are simple enough to emit natively in wasm,
        // bypassing the sh4_interp_ifb import call. Per
        // /tmp/dc-probes/ifb-pc-trace.log, DIV0U (0x0019) and DIV0S (0x2nm7)
        // fire 130-160/sec post-VRAM-fill, each shop_ifb costing the
        // full import-call round-trip. Native rec-x64 doesn't pay this
        // since the explicit-shil path produces native x86 directly.
        const u32 opc16 = (u32)op.rs3._imm & 0xFFFFu;
        // SH4 GPR offsets in Sh4Context: r[0]@0xC0=192, r[N]@192+4N.
        const u32 RBASE = 192;
        if (opc16 == 0x0019u) {
            // DIV0U: SR.Q=0, SR.M=0, SR.T=0
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::SR_STATUS);
            b.op_i32_const((s32)~((1u << 8) | (1u << 9)));
            b.op_i32_and();
            b.op_i32_store(ctx_off::SR_STATUS);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_const(0);
            b.op_i32_store(ctx_off::SR_T);
            reloadOrInvalidate(b, cache);
            return true;
        }
        if ((opc16 & 0xF00Fu) == 0x2007u) {
            // DIV0S Rm,Rn (opcode 0x2nm7):
            //   Q = Rn[31]; M = Rm[31]; T = M^Q
            //   SR.Q -> bit 8 of SR_STATUS, SR.M -> bit 9
            const u32 n = (opc16 >> 8) & 0xFu;
            const u32 m = (opc16 >> 4) & 0xFu;
            const u32 rN_off = RBASE + n * 4;
            const u32 rM_off = RBASE + m * 4;
            // Q = Rn>>31; M = Rm>>31; T = Q^M
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(rN_off);
            b.op_i32_const(31); b.op_i32_shr_u();
            b.op_local_tee(LOCAL_TMP);              // TMP=Q (low bit)
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(rM_off);
            b.op_i32_const(31); b.op_i32_shr_u();
            b.op_local_tee(LOCAL_TMP2);             // TMP2=M
            b.op_i32_xor();                          // (Q^M) on stack
            b.op_local_set(LOCAL_TMP3);             // TMP3=T
            // SR_STATUS = (old & ~(Q|M)) | (Q<<8) | (M<<9)
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::SR_STATUS);
            b.op_i32_const((s32)~((1u << 8) | (1u << 9)));
            b.op_i32_and();
            b.op_local_get(LOCAL_TMP);
            b.op_i32_const(8); b.op_i32_shl();
            b.op_i32_or();
            b.op_local_get(LOCAL_TMP2);
            b.op_i32_const(9); b.op_i32_shl();
            b.op_i32_or();
            b.op_i32_store(ctx_off::SR_STATUS);
            // SR_T = T
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_TMP3);
            b.op_i32_store(ctx_off::SR_T);
            reloadOrInvalidate(b, cache);
            return true;
        }
        // Default: PC convention etc., fall through to sh4_interp_ifb import.
        // Sh4cntx.pc == current_opcode_pc + 2 (sh4_interpreter.cpp ReadNexOp
        // advances pc to addr+2 BEFORE calling OpPtr; PC-relative loads and
        // branches expect this). decoder.cpp:70 sets op.rs2._imm = rpc + 2.
        b.op_i32_const((s32)op.rs3._imm);
        b.op_i32_const((s32)op.rs2._imm);
        b.op_call(WIMPORT_IFB);
        reloadOrInvalidate(b, cache);
        return true;
    }

    // ---- FPU scalar ----
    case shop_fadd:
        emitPreStoreF32(b, op.rd, cache);
        emitLoadParamF32C(b, op.rs1, cache);
        emitLoadParamF32C(b, op.rs2, cache);
        b.op_f32_add();
        emitPostStoreF32(b, op.rd, cache);
        return true;

    case shop_fsub:
        emitPreStoreF32(b, op.rd, cache);
        emitLoadParamF32C(b, op.rs1, cache);
        emitLoadParamF32C(b, op.rs2, cache);
        b.op_f32_sub();
        emitPostStoreF32(b, op.rd, cache);
        return true;

    case shop_fmul:
        emitPreStoreF32(b, op.rd, cache);
        emitLoadParamF32C(b, op.rs1, cache);
        emitLoadParamF32C(b, op.rs2, cache);
        b.op_f32_mul();
        emitPostStoreF32(b, op.rd, cache);
        return true;

    case shop_fdiv:
        emitPreStoreF32(b, op.rd, cache);
        emitLoadParamF32C(b, op.rs1, cache);
        emitLoadParamF32C(b, op.rs2, cache);
        b.op_f32_div();
        emitPostStoreF32(b, op.rd, cache);
        return true;

    case shop_fabs:
        emitPreStoreF32(b, op.rd, cache);
        emitLoadParamF32C(b, op.rs1, cache);
        b.op_f32_abs();
        emitPostStoreF32(b, op.rd, cache);
        return true;

    case shop_fneg:
        emitPreStoreF32(b, op.rd, cache);
        emitLoadParamF32C(b, op.rs1, cache);
        b.op_f32_neg();
        emitPostStoreF32(b, op.rd, cache);
        return true;

    case shop_fsqrt:
        emitPreStoreF32(b, op.rd, cache);
        emitLoadParamF32C(b, op.rs1, cache);
        b.op_f32_sqrt();
        emitPostStoreF32(b, op.rd, cache);
        return true;

    case shop_fseteq:
        emitPreStore(b, op.rd, cache);
        emitLoadParamF32C(b, op.rs1, cache);
        emitLoadParamF32C(b, op.rs2, cache);
        b.op_f32_eq();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_fsetgt:
        emitPreStore(b, op.rd, cache);
        emitLoadParamF32C(b, op.rs1, cache);
        emitLoadParamF32C(b, op.rs2, cache);
        b.op_f32_gt();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_cvt_i2f_n:
    case shop_cvt_i2f_z:
        emitPreStoreF32(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_f32_convert_i32_s();
        emitPostStoreF32(b, op.rd, cache);
        return true;

    case shop_cvt_f2i_t:
        // NaN → 0x80000000 per SH4 spec (wasm i32.trunc_sat_f32_s returns 0).
        emitPreStore(b, op.rd, cache);
        emitLoadParamF32C(b, op.rs1, cache);
        emitLoadParamF32C(b, op.rs1, cache);
        b.op_f32_eq();
        b.op_if(WASM_TYPE_I32);
        emitLoadParamF32C(b, op.rs1, cache);
        b.op_i32_trunc_sat_f32_s();
        b.op_else();
        b.op_i32_const((s32)0x80000000);
        b.op_end();
        emitPostStore(b, op.rd, cache);
        return true;

    // ---- FPU vector / fused (f64 accumulation to match reference) ----
    case shop_fmac:
        emitPreStoreF32(b, op.rd, cache);
        emitLoadParamF32C(b, op.rs1, cache);
        emitLoadParamF32C(b, op.rs2, cache);
        emitLoadParamF32C(b, op.rs3, cache);
        b.op_f32_mul();
        b.op_f32_add();
        emitPostStoreF32(b, op.rd, cache);
        return true;

    case shop_fsrra:
        emitPreStoreF32(b, op.rd, cache);
        b.op_f32_const(1.0f);
        emitLoadParamF32C(b, op.rs1, cache);
        b.op_f32_sqrt();
        b.op_f32_div();
        emitPostStoreF32(b, op.rd, cache);
        return true;

    case shop_fipr: {
        u32 off1 = op.rs1.reg_offset();
        u32 off2 = op.rs2.reg_offset();
        emitPreStoreF32(b, op.rd, cache);   // lever-5G v2: cache-aware
        for (int i = 0; i < 4; ++i) {
            emitF32OffLoad(b, cache, off1 + i * 4);
            b.op_f64_promote_f32();
            emitF32OffLoad(b, cache, off2 + i * 4);
            b.op_f64_promote_f32();
            b.op_f64_mul();
            if (i > 0) b.op_f64_add();
        }
        b.op_f32_demote_f64();
        emitPostStoreF32(b, op.rd, cache);
        return true;
    }

    case shop_ftrv: {
        u32 voff = op.rs1.reg_offset();
        u32 moff = op.rs2.reg_offset();

        // Lever-5G v2: source the vector via the f32 cache (compile-time
        // offsets). Values still snapshot into the INT scratch locals so the
        // column stores cannot alias the row reads.
        emitF32OffLoad(b, cache, voff);
        b.op_i32_reinterpret_f32();
        b.op_local_set(LOCAL_TMP2);

        emitF32OffLoad(b, cache, voff + 4);
        b.op_i32_reinterpret_f32();
        b.op_local_set(LOCAL_TMP3);

        emitF32OffLoad(b, cache, voff + 8);
        b.op_i32_reinterpret_f32();
        b.op_local_set(LOCAL_TMP4);

        emitF32OffLoad(b, cache, voff + 12);
        b.op_i32_reinterpret_f32();
        b.op_local_set(LOCAL_TMP5);

        const u32 tmps[4] = { LOCAL_TMP2, LOCAL_TMP3, LOCAL_TMP4, LOCAL_TMP5 };
        for (int col = 0; col < 4; ++col) {
            emitF32OffStorePre(b, cache, voff + col * 4);
            for (int row = 0; row < 4; ++row) {
                b.op_local_get(tmps[row]);
                b.op_f32_reinterpret_i32();
                b.op_f64_promote_f32();
                b.op_local_get(LOCAL_CTX);
                b.op_f32_load(moff + (row * 4 + col) * 4);
                b.op_f64_promote_f32();
                b.op_f64_mul();
                if (row > 0) b.op_f64_add();
            }
            b.op_f32_demote_f64();
            emitF32OffStorePost(b, cache, voff + col * 4);
        }
        return true;
    }

    case shop_frswap: {
        u32 off1 = op.rs1.reg_offset();
        u32 off2 = op.rd.reg_offset();
        for (int i = 0; i < 16; ++i) {
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(off1 + i * 4);
            b.op_local_set(LOCAL_TMP);

            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(off2 + i * 4);
            b.op_i32_store(off1 + i * 4);

            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_TMP);
            b.op_i32_store(off2 + i * 4);
        }
        return true;
    }

    // ---- Variable shifts ----
    case shop_shld: {
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_const(0);
        b.op_i32_ge_s();
        b.op_if(WASM_TYPE_I32);
            emitLoadParamCached(b, op.rs1, cache);
            emitLoadParamCached(b, op.rs2, cache);
            b.op_i32_const(0x1F);
            b.op_i32_and();
            b.op_i32_shl();
        b.op_else();
            b.op_i32_const(0);
            emitLoadParamCached(b, op.rs2, cache);
            b.op_i32_sub();
            b.op_i32_const(0x1F);
            b.op_i32_and();
            b.op_i32_eqz();
            b.op_if(WASM_TYPE_I32);
                b.op_i32_const(0);
            b.op_else();
                emitLoadParamCached(b, op.rs1, cache);
                b.op_i32_const(0);
                emitLoadParamCached(b, op.rs2, cache);
                b.op_i32_sub();
                b.op_i32_const(0x1F);
                b.op_i32_and();
                b.op_i32_shr_u();
            b.op_end();
        b.op_end();
        emitPostStore(b, op.rd, cache);
        return true;
    }

    case shop_shad: {
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_const(0);
        b.op_i32_ge_s();
        b.op_if(WASM_TYPE_I32);
            emitLoadParamCached(b, op.rs1, cache);
            emitLoadParamCached(b, op.rs2, cache);
            b.op_i32_const(0x1F);
            b.op_i32_and();
            b.op_i32_shl();
        b.op_else();
            b.op_i32_const(0);
            emitLoadParamCached(b, op.rs2, cache);
            b.op_i32_sub();
            b.op_i32_const(0x1F);
            b.op_i32_and();
            b.op_i32_eqz();
            b.op_if(WASM_TYPE_I32);
                emitLoadParamCached(b, op.rs1, cache);
                b.op_i32_const(31);
                b.op_i32_shr_s();
            b.op_else();
                emitLoadParamCached(b, op.rs1, cache);
                b.op_i32_const(0);
                emitLoadParamCached(b, op.rs2, cache);
                b.op_i32_sub();
                b.op_i32_const(0x1F);
                b.op_i32_and();
                b.op_i32_shr_s();
            b.op_end();
        b.op_end();
        emitPostStore(b, op.rd, cache);
        return true;
    }

    // ---- 64-bit copy (float register pairs) ----
    case shop_mov64:
        // PORTED FROM rec_x64.cpp:184-214
        // x64 with ALLOC_F64=false: rax = qword[rs1]; qword[rd] = rax.
        // x64 with ALLOC_F64=true:  movss between xmm halves with overlap shuffle.
        //
        // wasm has no 8-byte i64 store register-allocated to ctx fields and the
        // ALLOC_F64 fast-path would require x4 xmm-equivalent allocation that
        // we don't have, so we emit two 32-bit loads + stores. The flycast verify
        // asserts both ops are r64f — this matches `op.rs1.is_reg() && op.rd.is_reg()`.
        // Returns false (fall to IFB) only if either operand isn't a reg, which
        // shouldn't happen in practice but keeps us safe under unexpected IR.
        if (op.rs1.is_reg() && op.rd.is_reg()) {
            u32 srcOff = op.rs1.reg_offset();
            u32 dstOff = op.rd.reg_offset();
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(srcOff);
            b.op_i32_store(dstOff);
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(srcOff + 4);
            b.op_i32_store(dstOff + 4);
            return true;
        }
        return false;

    // ---- Dual-output (rd + rd2) using i64 scratch ----
    case shop_adc: {
        u32 t64 = cache.tmp64Local();
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i64_extend_i32_u();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i64_extend_i32_u();
        b.op_i64_add();
        emitLoadParamCached(b, op.rs3, cache);
        b.op_i64_extend_i32_u();
        b.op_i64_add();
        b.op_local_tee(t64);
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd, cache);

        emitPreStore(b, op.rd2, cache);
        b.op_local_get(t64);
        b.op_i64_const(32);
        b.op_i64_shr_u();
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd2, cache);
        return true;
    }

    case shop_sbc: {
        u32 t64 = cache.tmp64Local();
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i64_extend_i32_u();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i64_extend_i32_u();
        b.op_i64_sub();
        emitLoadParamCached(b, op.rs3, cache);
        b.op_i64_extend_i32_u();
        b.op_i64_sub();
        b.op_local_tee(t64);
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd, cache);

        emitPreStore(b, op.rd2, cache);
        b.op_local_get(t64);
        b.op_i64_const(32);
        b.op_i64_shr_u();
        b.op_i32_wrap_i64();
        b.op_i32_const(1);
        b.op_i32_and();
        emitPostStore(b, op.rd2, cache);
        return true;
    }

    case shop_negc: {
        // PORTED FROM rec_x64.cpp:303-329
        // x64 trick: rd = -zext64(rs1); rd -= zext64(rs2); rd2 = rd >> 63.
        // The high bit of the 64-bit result is the borrow out (T) — if
        // (rs1 != 0) || (rs2 != 0), the subtraction underflows past zero and
        // bit 63 is set.
        //
        // wasm mirror: build the i64 result on stack via two i64_sub ops from
        // i64.const(0), then logical shift right by 63 to extract the borrow.
        // Equivalent to (and previously implemented as) "(high32 & 1)" — bit
        // 32 and bit 63 are equal here because rs1/rs2 are zext'd to 64 bits,
        // so the upper 32 bits are either all-zero (no borrow) or all-one
        // (borrow). Switching to shr_u(63) matches the rec_x64 emit literally
        // and emits one fewer wasm op per call site (no i32_const(1)+and).
        u32 t64 = cache.tmp64Local();
        emitPreStore(b, op.rd, cache);
        b.op_i64_const(0);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i64_extend_i32_u();
        b.op_i64_sub();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i64_extend_i32_u();
        b.op_i64_sub();
        b.op_local_tee(t64);
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd, cache);

        emitPreStore(b, op.rd2, cache);
        b.op_local_get(t64);
        b.op_i64_const(63);
        b.op_i64_shr_u();
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd2, cache);
        return true;
    }

    case shop_rocl: {
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(31);
        b.op_i32_shr_u();
        b.op_local_set(LOCAL_TMP);

        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(1);
        b.op_i32_shl();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_or();
        emitPostStore(b, op.rd, cache);

        emitPreStore(b, op.rd2, cache);
        b.op_local_get(LOCAL_TMP);
        emitPostStore(b, op.rd2, cache);
        return true;
    }

    case shop_rocr: {
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(1);
        b.op_i32_and();
        b.op_local_set(LOCAL_TMP);

        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(1);
        b.op_i32_shr_u();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_const(31);
        b.op_i32_shl();
        b.op_i32_or();
        emitPostStore(b, op.rd, cache);

        emitPreStore(b, op.rd2, cache);
        b.op_local_get(LOCAL_TMP);
        emitPostStore(b, op.rd2, cache);
        return true;
    }

    case shop_mul_u64: {
        u32 t64 = cache.tmp64Local();
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i64_extend_i32_u();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i64_extend_i32_u();
        b.op_i64_mul();
        b.op_local_tee(t64);
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd, cache);

        emitPreStore(b, op.rd2, cache);
        b.op_local_get(t64);
        b.op_i64_const(32);
        b.op_i64_shr_u();
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd2, cache);
        return true;
    }

    case shop_mul_s64: {
        u32 t64 = cache.tmp64Local();
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i64_extend_i32_s();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i64_extend_i32_s();
        b.op_i64_mul();
        b.op_local_tee(t64);
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd, cache);

        emitPreStore(b, op.rd2, cache);
        b.op_local_get(t64);
        b.op_i64_const(32);
        b.op_i64_shr_u();
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd2, cache);
        return true;
    }

    // ---- System ops that need flush+reload around a fallback call ----
    case shop_sync_sr: {
        // Lever-5B: inline the COMMON case of UpdateSR (no register-bank
        // change) — the game's imask set/restore leaf primitives fire this
        // ~400K/s in gameplay-class code, and every fire previously paid the
        // full flushAll + C import + host switch + UpdateSR + reload. The
        // inline mirrors sh4_core_regs.cpp UpdateSR + sh4_interrupts.cpp
        // SRdecode/recalc_pending_itrs exactly:
        //   need_swap = (MD ? old^new : old) & RB   -> C fallback (rare)
        //   else: old_sr.status = new & (MD ? ~0 : ~RB)
        //         decoded_srimask = BL ? 0 : ~InterruptLevelBit[IMASK]
        //         interrupt_pend  = vpend & vmask & decoded_srimask
        // The TU-static addresses come from sh4_intr_state_ptrs (WASM-gated
        // accessor). Computed loads here are block-BODY emission — the legal
        // shape class (area-3 fastpath precedent), not the #18 dispatch-path
        // landmine. Delivery semantics unchanged: pend is consumed by the
        // per-block prologue check + the crediting loop, same as the C path.
        cache.flushAll(b);
        if (g_emit_syncsr_fast && sr_ptrs_ready()) {
            constexpr s32 RB_BIT = 1 << 29;
            // TMP := new = ctx->sr.status (stack keeps a copy)
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::SR_STATUS);
            b.op_local_tee(LOCAL_TMP);
            // TMP2 := old
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::OLD_SR_STATUS);
            b.op_local_set(LOCAL_TMP2);
            // need_swap = (old ^ (new & mdmask)) & RB, mdmask = -((new>>30)&1)
            b.op_i32_const(30); b.op_i32_shr_u();
            b.op_i32_const(1);  b.op_i32_and();
            b.op_i32_const(-1); b.op_i32_mul();       // mdmask
            b.op_local_get(LOCAL_TMP); b.op_i32_and();
            b.op_local_get(LOCAL_TMP2); b.op_i32_xor();
            b.op_i32_const(RB_BIT); b.op_i32_and();
            b.op_if(0x40);                            // bank change -> full C UpdateSR
                b.op_i32_const((s32)persist_shil_op(op));
                b.op_i32_const((s32)opIndex);
                b.op_call(WIMPORT_SHIL_FB);
            b.op_else();                              // FAST inline
                // old_sr.status = new & (~RB | (md ? RB : 0))
                b.op_local_get(LOCAL_CTX);
                b.op_local_get(LOCAL_TMP);
                b.op_local_get(LOCAL_TMP);
                b.op_i32_const(30); b.op_i32_shr_u();
                b.op_i32_const(1);  b.op_i32_and();
                b.op_i32_const(29); b.op_i32_shl();   // md ? RB : 0
                b.op_i32_const((s32)~RB_BIT); b.op_i32_or();
                b.op_i32_and();
                b.op_i32_store(ctx_off::OLD_SR_STATUS);
                // d = ~ILB[(new>>4)&0xF] & ((bl)-1); decoded_srimask = d
                b.op_i32_const((s32)g_sr_decoded_addr);
                b.op_local_get(LOCAL_TMP);
                b.op_i32_const(4);   b.op_i32_shr_u();
                b.op_i32_const(0xF); b.op_i32_and();
                b.op_i32_const(2);   b.op_i32_shl();  // u32 index -> byte offset
                b.op_i32_const((s32)g_sr_ilb_addr);
                b.op_i32_add();
                b.op_i32_load(0);                     // ILB[IMASK]
                b.op_i32_const(-1); b.op_i32_xor();   // ~ILB
                b.op_local_get(LOCAL_TMP);
                b.op_i32_const(28); b.op_i32_shr_u();
                b.op_i32_const(1);  b.op_i32_and();
                b.op_i32_const(1);  b.op_i32_sub();   // bl-1: 0 if BL, ~0 if not
                b.op_i32_and();
                b.op_local_tee(LOCAL_TMP2);
                b.op_i32_store(0);
                // ctx->interrupt_pend = vpend & vmask & d
                b.op_local_get(LOCAL_CTX);
                b.op_i32_const((s32)g_sr_vpend_addr); b.op_i32_load(0);
                b.op_i32_const((s32)g_sr_vmask_addr); b.op_i32_load(0);
                b.op_i32_and();
                b.op_local_get(LOCAL_TMP2);
                b.op_i32_and();
                b.op_i32_store(ctx_off::INTERRUPT_PEND);
            b.op_end();
        } else {
            b.op_i32_const((s32)persist_shil_op(op));
            b.op_i32_const((s32)opIndex);
            b.op_call(WIMPORT_SHIL_FB);
        }
        reloadOrInvalidate(b, cache);
        return true;
    }

    case shop_sync_fpscr:
        // PORTED FROM rec_x64.cpp:295-301 — route through WIMPORT_SHIL_FB,
        // which dispatches to Sh4Context::UpdateFPSCR host-side.
        cache.flushAll(b);
        b.op_i32_const((s32)persist_shil_op(op));
        b.op_i32_const((s32)opIndex);
        b.op_call(WIMPORT_SHIL_FB);
        reloadOrInvalidate(b, cache);
        return true;

    // ---- Prefetch: inline the no-op path, only call shil_fb for SQ region ----
    case shop_pref: {
        // PORTED FROM rec_x64.cpp:344-390
        // x64: tests (rs1 >> 26) == 0x38 (store-queue region 0xE0000000-),
        //      and only calls do_sqw_mmu_no_ex / sh4ctx.doSqWrite when matched;
        //      no-op otherwise. We do the same: emit a guard `if`, and only on
        //      match call out through WIMPORT_SHIL_FB which routes to
        //      sh4_interp_shil_fb's default-arm UpdateSR/UpdateFPSCR pair
        //      (which is wrong for pref but flycast's per-op handler will look
        //      up the original opcode from oplist[op_idx] and route correctly).
        //
        // NB: The handler IS pref-aware on the host side because
        // sh4_interp_shil_fb's switch only matches shop_sync_sr/_fpscr — pref
        // falls into the default-arm "call both" pair. That's a host-side bug
        // (defensive fallback) we should fix by extending the host switch.
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(26);
        b.op_i32_shr_u();
        b.op_i32_const(0x38);
        b.op_i32_eq();
        b.op_if();
        for (auto& kv : cache.entries) {
            if (!kv.second.dirty) continue;
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(kv.second.wasmLocal);
            if (kv.second.isF32) b.op_f32_store(kv.first);   // lever-5G typed spill
            else                 b.op_i32_store(kv.first);
        }
        b.op_i32_const((s32)persist_shil_op(op));
        b.op_i32_const((s32)opIndex);
        b.op_call(WIMPORT_SHIL_FB);
        if (s_lazy_regcache_enabled) {
            // No emit — invalidation is bookkeeping only; first post-call use
            // re-fetches. But the reload was previously inside an `if` arm, so
            // doing nothing here keeps the arm body well-formed and balanced.
            cache.invalidateAll();
        } else {
            for (auto& kv : cache.entries) {
                b.op_local_get(LOCAL_CTX);
                // Typed reload — an f32 entry fed by i32.load is a V8
                // validation error that takes the whole module down (the
                // 2026-08-27 552-block shard kill: pref + f32-cached fr in
                // one block). The spill twin above was typed by lever-5G;
                // this half was missed because pref has no fr params, so
                // scanBlockF32's exclusion never protects these blocks.
                if (kv.second.isF32) b.op_f32_load(kv.first);
                else                 b.op_i32_load(kv.first);
                b.op_local_set(kv.second.wasmLocal);
            }
        }
        b.op_end();
        return true;
    }

    // Canonical-only SHIL ops have no 1:1 SH4 opcode at op.guest_offs — they're
    // decoder lowerings (div32u/s/p2) or pure SHIL synthetics (fsca/illegal/
    // debug_*). The generic fallback below reads ReadMem16(guest_offs) and runs
    // the SH4 interpreter on whatever opcode happens to sit there, which is
    // semantically wrong for these ops. Route through WIMPORT_SHIL_FB instead,
    // which dispatches via shil_chf[op.op](&op) on the host side
    // (sh4_interp_shil_fb in EmscriptenWorker.cpp).
    case shop_div32u:
    case shop_div32s:
    case shop_div32p2:
    case shop_fsca:
    case shop_illegal:
    case shop_debug_1:
    case shop_debug_3:
        cache.flushAll(b);
        b.op_i32_const((s32)persist_shil_op(op));
        b.op_i32_const((s32)opIndex);
        b.op_call(WIMPORT_SHIL_FB);
        reloadOrInvalidate(b, cache);
        return true;

    // shop_div1 corresponds 1:1 to SH4's div1 opcode — IFB fallback below
    // correctly invokes the SH4 interpreter on that exact instruction.
    case shop_div1:
    default:
        return false;
    }
}

// ---------------------------------------------------------------------------
// Block exit — writes ctx.pc per the block's BlockEndType class.
// ---------------------------------------------------------------------------
// Helper: returns the function index of a sibling block if linkable, else -1.
// Sibling-link is valid when (a) the vaddr→idx map is present, (b) the target
// vaddr is in the map, (c) target != this block's own vaddr (no self-link —
// trivial infinite tail-call chains add no value vs the C++ dispatcher's loop
// and confuse profilers).
bool g_emit_tail_link = true;   // block-to-block return_call tail-linking (bisect switch)

// ORDER 21b Lever-1 PREDICTION instrumentation: runtime exit-to-C round-trip
// classification. Each compiled block whose exit CANNOT tail-link emits a bump
// of one of these on its exit path, so the totals are execution-weighted counts
// of the round-trips each lever could remove. Read via flycast_ctx_snapshot
// 15/16/17. Strip after the prediction verdict (instruments strip after verdict).
// extern "C" -> unmangled global symbol so the bridge TU (rec_wasm.cpp) can
// read them without namespace-mangling mismatch across translation units.
extern "C" {
uint32_t g_exit_dyn         = 0;  // BET_CLS_Dynamic (jmp/jsr @Rn, rts, RTE) -> Lever 1
uint32_t g_exit_static_xshd = 0;  // BET_CLS_Static cross-shard / StaticIntr -> Lever 2
uint32_t g_exit_cond_xshd   = 0;  // BET_CLS_COND with a cross-shard arm      -> Lever 1/2

// Monomorphic INLINE CACHE for dynamic exits (jsr/jmp @Rn, rts) — native flycast's
// fpcb/rdv_LinkBlock monomorphic guard, reshaped for immutable WASM. Per-call-site
// scalar triple {ic_pc, ic_slot, ic_gen} at COMPILE-TIME-CONSTANT addresses — ONLY
// the emit_rt_bump-proven `i32.const A; i32.load/store` shape (NO shared array, NO
// computed index) so the runtime module still instantiates. g_ic_generation: 0 =
// DISARMED (fills gated off -> boot byte-identical to today); 1 = armed (parent
// flips post-title); ++ on stale/clear invalidates every cached entry.
static constexpr uint32_t IC_SITES = 1u << 16;   // 1.5MB BSS (zero-init); recompiles leak a slot, bounded
// Lever-6C: TWO ways per site (dynamic jsr sites are polymorphic; one way
// thrashed like pre-5E2 conds, ~1.4M C-probes/s heavy). [6s+0..2]=way0
// {pc,slot,gen}; [6s+3..5]=way1. Fill demotes way0->way1. Const-target
// (5E2) sites use way0 {slot,gen} only.
uint32_t g_ic[6 * IC_SITES];
uint32_t g_ic_next = 0;                            // compile-time site allocator
volatile uint32_t g_ic_generation = 0;             // 0=disarmed, 1=armed, ++ = invalidate epoch
// TEST (2026-08-23): extend the IC to cond/static exits. UNSAFE alone — those exits
// carry the ram_code_sum SMC-verify coverage (jit_lookup); moving them onto the IC
// drops SMC detection. Paired with a periodic g_ic_generation flush in the crediting
// loop (rec_wasm.cpp) that bounds staleness by forcing periodic re-verify. Emission
// always includes the ops (inert until armed); this just gates cond/static sites.
// Lever-5E3: depth-1 return-address prediction. A BET_DynamicCall exit
// PRIMES g_ras_pc with the block's NextBlock (the decoder's own "ret hint"),
// invalidating the cached slot when the call site changes; the C resolver
// (sh4_jit_lookup_idx) fills slot+gen when it resolves that pc while armed;
// a BET_DynamicRet exit checks the triple before its per-site IC. Leaf
// jsr/rts pairs hit ~always where the per-site rts IC was megamorphic.
uint32_t g_ras_pc = 0, g_ras_slot = 0;
uint32_t g_ras_gen = 0xFFFFFFFFu;   // never-matching until first armed fill

// ---------------------------------------------------------------------------
// LEVER-12 risk-1 closure — per-trace-edge SMC generation guard.
//
// THE HOLE, stated exactly. jit_lookup (rec_wasm.cpp) is the ONLY dispatch-path
// caller of ram_code_sum, so any edge that reaches compiled guest code WITHOUT a
// lookup runs unverified. Two such edges exist:
//   (a) the default-ON intra-shard tail-link: sibling_func_idx resolves a target
//       to a shard-local function index at COMPILE time and emitTailTo emits a
//       bare `return_call <idx>`;
//   (b) a LEVER-12 trace's interior member, whose body is inlined straight into
//       the head's function.
// These are EQUIVALENT, not merely comparable: both resolve through maps that
// build_blocks derives from the SAME `blocks` vector (vaddr_to_idx and
// vaddr_to_block, so a trace can only inline what a tail-link could already have
// called); both re-verify at exactly the same points (a spent slice returns
// PC = that block's own vaddr to the trampoline, which then does a verified
// jit_lookup — emitTailTo's spent-slice arm and emit_member_precheck are the
// same shape); and both execute the same NUMBER of unverified guest-code entries
// per unit of guest work (an N-block loop costs N unverified entries per
// iteration either way). So LEVER-12 does not open a new staleness class and
// does not widen the existing one. It is genuinely no worse.
//
// It can, however, be made BETTER, and cheaply, which is what this is. Since
// 2026-08-27 dreamcast.html COLD-ARMS the IC at boot (`setic on:1` at ready —
// the old post-title timer is retired), so the lever-4 per-write SMC hooks are
// live through PSO's SMC-heavy boot: any store into a marked code word bumps
// g_ic_generation. That makes a generation compare a valid staleness proof for a
// trace edge, exactly as lever-5E1 already uses it to collapse jit_lookup's
// O(len) sum ("an unchanged generation proves the block's bytes unchanged").
//
// SHAPE, per interior member (i >= 1) of a trace:
//     if (*tgen != g_ic_generation) { *tgen = g_ic_generation;
//                                     flush; PC = member.vaddr; return PC; }
// 5 instructions + 2 constant-address loads on the fast path.
//
// WHY IT CANNOT LIVELOCK, and why the de-opt target is the MEMBER and never the
// head: bailing to the head's own vaddr would re-enter this same function, which
// would re-check and bail again forever (jit_lookup finds the head's own bytes
// clean and hands back this very function). Bailing to member[i]'s vaddr enters
// member[i]'s OWN function after a verified lookup, and that function executes
// member[i]'s body before it can reach any guard of its own — so every bail
// makes at least one block of forward progress.
//
// The loop back-edge into the head is deliberately NOT guarded. On iteration 2+
// the head's own bytes have not been re-verified since function entry — but that
// is EXACTLY the shipped property of both the intra-shard tail-link (B's
// return_call back into A re-runs A unverified) and the default-ON self-loop
// (one lookup, N iterations of the body), so leaving it unguarded holds parity
// rather than opening anything. It could be closed the same way if wanted: the
// restamp below means a head guard would de-opt at most once per bump — the
// trampoline's verified jit_lookup(head) hands back this same function and the
// now-restamped guard does not re-fire — so it terminates. It is left out only
// because it would double the guard tax on the 2-block loop, which is the shape
// the lever exists for.
//
// WHY IT SELF-HEALS: the guard restamps *tgen before leaving, so one generation
// bump costs ONE de-opt per guarded edge, not permanent de-optimization. Measured
// churn is tiny — over the three real PSO runs with icgen telemetry in
// /tmp/dc-probes, g_ic_generation moved 21 / 2 / 7 times across an entire run
// (R-CAPX 2->23, R-UNCX 2->4, isk-diag 7903->7910).
//
// LIMIT (do not oversell this): while the IC is DISARMED (?noic, or before the
// page's setic) g_ic_generation is pinned at 0 and never moves, so the guard is
// inert and the trace edge is exactly as (un)protected as the shipped tail-link.
// The guard raises the traced path above the tail-link when armed; it does not
// fix the tail-link, which remains the wider exposure and is not this file's to
// change unilaterally.
static constexpr uint32_t TRACE_GEN_SITES = 1u << 16;   // 256KB BSS, zero-init
uint32_t g_trace_gen[TRACE_GEN_SITES];
uint32_t g_trace_gen_next = 0;    // compile-time site allocator; exhaustion just
                                  // drops the guard (= shipped tail-link semantics)

static bool g_ic_cs = true;    // cond/static IC: ~1.8x native. SAFE as of lever-4 Build 2 — every write path into RAM (emitted fastpath stores incl. memset, C slowpath imports, WriteMemBlock/DMA chokepoints) bumps g_ic_generation on a code-word hit (4-byte-granular map, zero false positives at the title: icgen=1 flat, task-3e probe). The old corruption class (loader SMC out-racing periodic flushes) is closed event-driven; jit_register re-registration bumps cover slot-churn.
}

static s32 sibling_func_idx(u32 target_vaddr, u32 self_vaddr,
                            const std::unordered_map<u32, u32>* vaddr_to_idx) {
    if (!g_emit_tail_link) return -1;
    if (vaddr_to_idx == nullptr) return -1;
    if (target_vaddr == self_vaddr) return -1;
    auto it = vaddr_to_idx->find(target_vaddr);
    if (it == vaddr_to_idx->end()) return -1;
    return (s32)(WIMPORT_COUNT + it->second);
}

// ---------------------------------------------------------------------------
// Exit-tail primitives. Hoisted out of emitBlockExit (2026-08-29) UNCHANGED so
// the trace emitter can reuse the exact same tail-call / const-target-probe
// shapes for its side exits. emitBlockExit keeps thin lambdas that forward
// here, so its emission is byte-identical to before the hoist (verified by a
// fixture-level diff over the offline emitter dump).
// ---------------------------------------------------------------------------
static void emitTailTo(WasmModuleBuilder& b, u32 func_idx) {
        if (!g_emit_hop_guard) {
            // Guard elided: the callee's OWN slice-yield precheck is now the
            // first instruction of its body (prologue-trim hoist) and stores
            // exactly the PC this arm already wrote, so the observable result
            // is identical — one extra function entry per spent slice.
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_RAM);
            b.op_return_call(func_idx);
            return;
        }
        b.op_local_get(LOCAL_CTX);
        b.op_i32_load(ctx_off::CYCLE_COUNTER);
        b.op_i32_const(0);
        b.op_i32_gt_s();
        b.op_if(0x40);                          // void — vector-guard
          b.op_local_get(LOCAL_CTX);
          b.op_local_get(LOCAL_RAM);
          b.op_return_call(func_idx);           // in-budget: chain, ends frame
        b.op_end();
        // slice spent (cycle_counter <= 0): return PC to C so the dispatcher's
        // cycle_counter<=0 branch runs sh4_sched_tick + UpdateINTC, then re-dispatches.
        b.op_local_get(LOCAL_CTX);
        b.op_i32_load(ctx_off::PC);
        b.op_return();
}

static void emitRtBump(WasmModuleBuilder& b, uint32_t* ctr) {
        u32 a = (u32)(uintptr_t)ctr;
        b.op_i32_const((s32)a);   // addr (for store)
        b.op_i32_const((s32)a);   // addr (for load)
        b.op_i32_load(0);         // -> *ctr
        b.op_i32_const(1);
        b.op_i32_add();           // -> *ctr + 1
        b.op_i32_store(0);        // *ctr = *ctr + 1
}

static void emitConstTargetProbe(WasmModuleBuilder& b, u32 target) {
        const bool have_ic = g_ic_cs && (g_ic_next < IC_SITES);
        const uint32_t site = have_ic ? g_ic_next++ : 0;
        uint32_t* icpc = &g_ic[6*site+0];
        uint32_t* icsl = &g_ic[6*site+1];
        uint32_t* icgn = &g_ic[6*site+2];
        if (have_ic) {
            g_ic[6*site+0] = target;        // forensics stamp (not compared)
            // Sentinel: with no pc tag, gen-match alone must never validate an
            // UNFILLED site (icgn=0 would match the disarmed gen=0 and fire
            // table slot 0). 0xFFFFFFFF is unreachable (fills stamp live gens).
            g_ic[6*site+2] = 0xFFFFFFFFu;
        }

        if (g_emit_hop_guard) {
        b.op_local_get(LOCAL_CTX);
        b.op_i32_load(ctx_off::CYCLE_COUNTER);
        b.op_i32_const(0);
        b.op_i32_gt_s();
        b.op_if(0x40);                          // vector-guard (Maple-storm scar, KEEP)
        }
          if (have_ic) {
            b.op_i32_const((s32)(u32)(uintptr_t)icgn); b.op_i32_load(0);
            b.op_i32_const((s32)(u32)(uintptr_t)&g_ic_generation); b.op_i32_load(0);
            b.op_i32_eq();                      // gen match == entry valid (no tag needed)
            b.op_if(0x40);
              b.op_local_get(LOCAL_CTX);
              b.op_local_get(LOCAL_RAM);
              b.op_i32_const((s32)(u32)(uintptr_t)icsl); b.op_i32_load(0);
              b.op_return_call_indirect(0, 0);
            b.op_end();
          }
          b.op_i32_const((s32)target);
          b.op_call(WIMPORT_LOOKUP_IDX);
          b.op_local_tee(LOCAL_TMP2);
          b.op_i32_const(-1);
          b.op_i32_ne();
          b.op_if(0x40);
            if (have_ic) {
              b.op_i32_const((s32)(u32)(uintptr_t)&g_ic_generation); b.op_i32_load(0);
              b.op_if(0x40);                    // fills gated on armed
                b.op_i32_const((s32)(u32)(uintptr_t)icsl); b.op_local_get(LOCAL_TMP2); b.op_i32_store(0);
                b.op_i32_const((s32)(u32)(uintptr_t)icgn); b.op_i32_const((s32)(u32)(uintptr_t)&g_ic_generation); b.op_i32_load(0); b.op_i32_store(0);
              b.op_end();
            }
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_RAM);
            b.op_local_get(LOCAL_TMP2);
            b.op_return_call_indirect(0, 0);
          b.op_end();
        if (g_emit_hop_guard) b.op_end();        // close the vector-guard if
        (void)icpc;
}

void emitBlockExit(WasmModuleBuilder& b, RuntimeBlockInfo* block,
                   const RegCache& cache,
                   const std::unordered_map<u32, u32>* vaddr_to_idx) {
    u32 bcls = BET_GET_CLS(block->BlockType);
    const u32 self_vaddr = block != nullptr ? block->vaddr : 0u;

    // Intra-link helper: tail-call the sibling block — BUT vector-guarded, exactly
    // like emit_global_probe. ORDER 21b (PSO title frame-wait livelock): the old
    // form was an UNCONDITIONAL `return_call`, so an all-intra-shard hot loop
    // (whose blocks all resolve via sibling_func_idx, never the cross-shard probe)
    // return_call-chained FOREVER and never re-entered the C trampoline. But
    // sh4_sched_tick (guest timebase -> SPG scanline -> VBlank raise) AND UpdateINTC
    // (interrupt delivery) live ONLY in the trampoline's `cycle_counter <= 0` branch
    // (rec_wasm.cpp). So the guest's VBlank ISR never ran, the game's "wait N
    // VBlanks" frame-sync loops never advanced, and the boot livelocked at varying
    // PCs (0x8c3c53f8 / 0x8c37bxxx) with interrupts pending-but-undelivered. Native
    // rec-x64 links blocks only WITHIN a timeslice and falls back to intc_sched at
    // cycle_counter<=0 — match that. This helper now ALWAYS ends the frame: it
    // return_calls the sibling while the slice has budget (cycle_counter > 0), else
    // returns the (already-stored) PC to the trampoline so sched+interrupts run.
    // Both callers still `return` after it (the frame is always ended here).
    auto emit_tail_to = [&](u32 func_idx) { emitTailTo(b, func_idx); };

    // ORDER 21b prediction: emit `*(u32*)ctr += 1` into the block's exit path.
    // Only the non-tail-linked (return-to-C) paths call this, so the runtime
    // total is the execution-weighted round-trip count for that class. The
    // counters (g_exit_dyn / g_exit_static_xshd / g_exit_cond_xshd) are defined
    // at namespace scope above. Strip with them after the verdict.
    auto emit_rt_bump = [&](uint32_t* ctr) { emitRtBump(b, ctr); };

    // ORDER 21b Lever 1/2 — GLOBAL cross-shard / dynamic tail-link probe.
    // Precondition: PC already holds the target vaddr and the RegCache is
    // flushed (emitBlockFuncBody flushAll's before emitBlockExit). Emits, with
    // GC scar #1 (the vector-guard) FIRST so a chain never outruns a due
    // timeslice/interrupt (else a poll chain waiting on an interrupt-set flag
    // livelocks — the storm class):
    //   if (cycle_counter > 0) {
    //     idx = sh4_lookup_idx(PC);                 ;; -1 on miss OR SMC-stale
    //     if (idx != -1) return_call_indirect(idx); ;; chain in-wasm; ends frame
    //   }
    // On guard-block or miss it falls through to the caller's rt_bump (scar #2
    // miss telemetry) + return-to-C. NOT emitted for BET_*Intr blocks — those
    // must reach the UpdateINTC tail-call below.
    // emit_ic = true only for BET_CLS_Dynamic (jsr/jmp @Rn, rts) — confines the IC
    // byte-growth to the class that fires the title's dominant cost, halving the
    // module-scale replication that is the residual instantiation risk.
    // Lever-5E2: const-target probe for cond/static exits. The target pc is a
    // COMPILE-TIME constant, so the site needs no pc tag — just {slot, gen}
    // (the same proven scalar shape; ic_pc is stamped with the target for
    // forensics only). Per-ARM sites mean an alternating conditional keeps
    // BOTH targets cached — the monomorphic single-site thrash (a 50/50
    // branch never hit) was driving ~2M C-probe lookups/s. Precondition:
    // ctx->pc already stores `target`.
    auto emit_const_target_probe = [&](u32 target) { emitConstTargetProbe(b, target); };

    auto emit_global_probe = [&](bool emit_ic) {
        const bool have_ic = emit_ic && (g_ic_next < IC_SITES);
        const uint32_t site = have_ic ? g_ic_next++ : 0;
        uint32_t* icpc = &g_ic[6*site+0];
        uint32_t* icsl = &g_ic[6*site+1];
        uint32_t* icgn = &g_ic[6*site+2];
        uint32_t* icpc1 = &g_ic[6*site+3];
        uint32_t* icsl1 = &g_ic[6*site+4];
        uint32_t* icgn1 = &g_ic[6*site+5];

        if (g_emit_hop_guard) {
        b.op_local_get(LOCAL_CTX);
        b.op_i32_load(ctx_off::CYCLE_COUNTER);
        b.op_i32_const(0);
        b.op_i32_gt_s();
        b.op_if(0x40);                          // void — vector-guard (Maple-storm scar, KEEP)
        }

          if (have_ic) {                        // ---- IC HIT: constant-addr scalar loads only ----
            b.op_i32_const((s32)(u32)(uintptr_t)icpc); b.op_i32_load(0);
            b.op_local_get(LOCAL_CTX); b.op_i32_load(ctx_off::PC);
            b.op_i32_eq();
            b.op_i32_const((s32)(u32)(uintptr_t)icgn); b.op_i32_load(0);
            b.op_i32_const((s32)(u32)(uintptr_t)&g_ic_generation); b.op_i32_load(0);
            b.op_i32_eq();
            b.op_i32_and();                     // ic_pc==pc && ic_gen==g_ic_generation
            b.op_if(0x40);                      // hit
              b.op_local_get(LOCAL_CTX);
              b.op_local_get(LOCAL_RAM);
              b.op_i32_const((s32)(u32)(uintptr_t)icsl); b.op_i32_load(0);   // cached table idx
              b.op_return_call_indirect(0, 0);  // way0 hit — no wasm->C boundary
            b.op_end();
            // Lever-6C way1 (polymorphic call sites)
            b.op_i32_const((s32)(u32)(uintptr_t)icpc1); b.op_i32_load(0);
            b.op_local_get(LOCAL_CTX); b.op_i32_load(ctx_off::PC);
            b.op_i32_eq();
            b.op_i32_const((s32)(u32)(uintptr_t)icgn1); b.op_i32_load(0);
            b.op_i32_const((s32)(u32)(uintptr_t)&g_ic_generation); b.op_i32_load(0);
            b.op_i32_eq();
            b.op_i32_and();
            b.op_if(0x40);
              b.op_local_get(LOCAL_CTX);
              b.op_local_get(LOCAL_RAM);
              b.op_i32_const((s32)(u32)(uintptr_t)icsl1); b.op_i32_load(0);
              b.op_return_call_indirect(0, 0);
            b.op_end();
          }

          b.op_local_get(LOCAL_CTX);
          b.op_i32_load(ctx_off::PC);           // target vaddr
          b.op_call(WIMPORT_LOOKUP_IDX);        // MISS: existing C resolver (unchanged)
          b.op_local_tee(LOCAL_TMP2);
          b.op_i32_const(-1);
          b.op_i32_ne();
          b.op_if(0x40);                        // void — hit
            if (have_ic) {                      // ---- FILL, gated on generation != 0 (= armed) ----
              b.op_i32_const((s32)(u32)(uintptr_t)&g_ic_generation); b.op_i32_load(0);
              b.op_if(0x40);
                // 6C: demote way0 -> way1 before refilling way0
                b.op_i32_const((s32)(u32)(uintptr_t)icpc1); b.op_i32_const((s32)(u32)(uintptr_t)icpc); b.op_i32_load(0); b.op_i32_store(0);
                b.op_i32_const((s32)(u32)(uintptr_t)icsl1); b.op_i32_const((s32)(u32)(uintptr_t)icsl); b.op_i32_load(0); b.op_i32_store(0);
                b.op_i32_const((s32)(u32)(uintptr_t)icgn1); b.op_i32_const((s32)(u32)(uintptr_t)icgn); b.op_i32_load(0); b.op_i32_store(0);
                b.op_i32_const((s32)(u32)(uintptr_t)icpc); b.op_local_get(LOCAL_CTX); b.op_i32_load(ctx_off::PC); b.op_i32_store(0);
                b.op_i32_const((s32)(u32)(uintptr_t)icsl); b.op_local_get(LOCAL_TMP2); b.op_i32_store(0);
                b.op_i32_const((s32)(u32)(uintptr_t)icgn); b.op_i32_const((s32)(u32)(uintptr_t)&g_ic_generation); b.op_i32_load(0); b.op_i32_store(0);
              b.op_end();
            }
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_RAM);
            b.op_local_get(LOCAL_TMP2);         // wasmTable index
            b.op_return_call_indirect(0, 0);    // type 0 (i32,i32)->i32, table 0
          b.op_end();
        if (g_emit_hop_guard) b.op_end();        // close the vector-guard if
    };

    // Whether emitBlockExit's caller still needs to push the PC for the
    // function's return value. Tail-call paths handle their own return,
    // so the caller's trailing `local.get LOCAL_CTX; i32.load PC` becomes
    // unreachable (still valid wasm) and we set this to false. Currently
    // the caller in emitBlockFuncBody always pushes — that's fine for the
    // non-linked paths; the linked paths emit return_call which terminates
    // the function, making any subsequent ops unreachable.

    switch (bcls) {
    case BET_CLS_Static: {
        u32 target = (block->BlockType == BET_StaticIntr)
                        ? block->NextBlock
                        : block->BranchBlock;
        b.op_local_get(LOCAL_CTX);
        b.op_i32_const((s32)target);
        b.op_i32_store(ctx_off::PC);

        // Intra-link StaticJump AND StaticCall (BSR) — both have a compile-time
        // constant target (BranchBlock). BSR's pr-save is NOT the dispatcher's
        // job: the decoder emits `shop_mov32 reg_pr = retaddr` INSIDE the block
        // (decoder.cpp:106-109,165), so PR is already stored when we tail-call
        // the callee; the callee's RTS reads the correct return address.
        // (Still skip StaticIntr — the UpdateINTC tail-call below must run.)
        // Profile (2026-08-21): rts/call round-trips are the #1 dispatcher cost.
        if (block != nullptr &&
            (block->BlockType == BET_StaticJump || block->BlockType == BET_StaticCall)) {
            s32 fidx = sibling_func_idx(target, self_vaddr, vaddr_to_idx);
            if (fidx >= 0) {
                emit_tail_to((u32)fidx);
                return;  // tail-call replaces frame; below is unreachable
            }
        }
        if (block != nullptr && block->BlockType != BET_StaticIntr)
            emit_const_target_probe(target);    // lever-5E2: const-target, no pc tag, per-site slot+gen
        else if (block != nullptr && block->BlockType == BET_StaticIntr) {
            // Lever-5C: an ldc-SR block's sync_sr (5B inline or C fallback)
            // has ALREADY recomputed ctx->interrupt_pend by this point. The
            // unconditional return-to-C + UpdateINTC here made EVERY imask
            // set/restore call a C round-trip (~430K/s in the heavy phase,
            // the rtstat mystery). pend==0 — the overwhelming case — can
            // chain like any static exit; pend!=0 falls through to the
            // UpdateINTC tail exactly as before (immediate delivery), and
            // the per-block prologue pend check backstops the chained path
            // one block later (finer than the shipped deferred-RTE choice).
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::INTERRUPT_PEND);
            b.op_i32_eqz();
            b.op_if(0x40);
                emit_const_target_probe(target);   // lever-5E2 const-target form
            b.op_end();
        }
        emit_rt_bump(&g_exit_static_xshd);  // reached only on guard-block/miss (scar #2)
        break;
    }

    case BET_CLS_Dynamic: {
        b.op_local_get(LOCAL_CTX);
        s32 jdynLocal = cache.getLocal(ctx_off::JDYN);
        if (jdynLocal >= 0) {
            emitCachedLocalGet(b, cache, ctx_off::JDYN, (u32)jdynLocal);
        } else {
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::JDYN);
        }
        b.op_i32_store(ctx_off::PC);
        // Lever-5E3 prime: a dynamic CALL's return lands at NextBlock — record
        // it, invalidating the cached slot only when the call site changes so
        // hot same-site loops keep their valid prediction.
        if (block != nullptr && block->BlockType == BET_DynamicCall) {
            b.op_i32_const((s32)(u32)(uintptr_t)&g_ras_pc);
            b.op_i32_load(0);
            b.op_i32_const((s32)block->NextBlock);
            b.op_i32_ne();
            b.op_if(0x40);
                b.op_i32_const((s32)(u32)(uintptr_t)&g_ras_pc);
                b.op_i32_const((s32)block->NextBlock);
                b.op_i32_store(0);
                b.op_i32_const((s32)(u32)(uintptr_t)&g_ras_gen);
                b.op_i32_const(-1);
                b.op_i32_store(0);
            b.op_end();
        }
        // Lever-5E3 check: on a RETURN, if the resolved pc matches the
        // prediction and its fill is current-generation, chain directly.
        if (block != nullptr && block->BlockType == BET_DynamicRet) {
            if (g_emit_hop_guard) {
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::CYCLE_COUNTER);
            b.op_i32_const(0);
            b.op_i32_gt_s();
            b.op_if(0x40);                      // vector-guard (storm scar, KEEP)
            }
                b.op_local_get(LOCAL_CTX);
                b.op_i32_load(ctx_off::PC);
                b.op_i32_const((s32)(u32)(uintptr_t)&g_ras_pc);
                b.op_i32_load(0);
                b.op_i32_eq();
                b.op_i32_const((s32)(u32)(uintptr_t)&g_ras_gen);
                b.op_i32_load(0);
                b.op_i32_const((s32)(u32)(uintptr_t)&g_ic_generation);
                b.op_i32_load(0);
                b.op_i32_eq();
                b.op_i32_and();
                b.op_if(0x40);
                    b.op_local_get(LOCAL_CTX);
                    b.op_local_get(LOCAL_RAM);
                    b.op_i32_const((s32)(u32)(uintptr_t)&g_ras_slot);
                    b.op_i32_load(0);
                    b.op_return_call_indirect(0, 0);
                b.op_end();
            if (g_emit_hop_guard) b.op_end();   // close the vector-guard if
        }
        if (block != nullptr && block->BlockType != BET_DynamicIntr)
            emit_global_probe(true);        // chain jmp/jsr @Rn, rts; skip RTE — IC on the DYNAMIC class
        emit_rt_bump(&g_exit_dyn);          // reached only on guard-block/miss (scar #2)
        break;
    }

    case BET_CLS_COND: {
        u32 cond = (block->BlockType == BET_Cond_1) ? 1 : 0;

        // ---- Single-predicate form (FLYCAST_COND_MERGE, DEFAULT ON) --------
        // The legacy shape below derives the branch predicate TWICE: once to
        // select the PC constant through an i32-typed if/else, then again to
        // split into the per-arm tail-call / const-target probe. The second
        // derivation is redundant — nothing between them writes SR_T or jdyn
        // (the only emitted code is `local.get ctx; i32.const target;
        // i32.store PC`) — so the two arms can own the PC store directly and
        // the predicate can be derived once. Saves the second derivation plus
        // its `local.get ctx` and typed-if scaffolding, ~3-4 executed
        // instructions on EVERY conditional exit that does not tail-link.
        // Semantics are unchanged: PC is still stored before any probe or
        // tail-call runs on that path (emitConstTargetProbe uses a compile-time
        // constant target and never reads ctx->PC; emitTailTo reads it only on
        // its spent-slice return, after the store).
        // NOTE for later: this also removes the stated obstacle to PARTIAL
        // sibling linking ("we'd need to undo the i32_store and re-branch") —
        // each arm is now its own control-flow region, so one arm could
        // tail-link while the other probes. Not done here; it changes chaining
        // behaviour and IC-site accounting and wants its own matched pair.
        auto push_pred = [&]() {
            if (block->has_jcond) {
                s32 jdynLocal = cache.getLocal(ctx_off::JDYN);
                if (jdynLocal >= 0) emitCachedLocalGet(b, cache, ctx_off::JDYN, (u32)jdynLocal);
                else { b.op_local_get(LOCAL_CTX); b.op_i32_load(ctx_off::JDYN); }
            } else {
                s32 srTLocal = cache.getLocal(ctx_off::SR_T);
                if (srTLocal >= 0) emitCachedLocalGet(b, cache, ctx_off::SR_T, (u32)srTLocal);
                else { b.op_local_get(LOCAL_CTX); b.op_i32_load(ctx_off::SR_T); }
            }
            if (cond != 1) b.op_i32_eqz();   // Cond_0 (bf): taken == !T
        };
        auto store_pc = [&](u32 target) {
            b.op_local_get(LOCAL_CTX);
            b.op_i32_const((s32)target);
            b.op_i32_store(ctx_off::PC);
        };
        if (g_emit_cond_merge && block != nullptr) {
            const s32 br_idx   = sibling_func_idx(block->BranchBlock, self_vaddr, vaddr_to_idx);
            const s32 next_idx = sibling_func_idx(block->NextBlock,   self_vaddr, vaddr_to_idx);
            const bool both_siblings = (br_idx >= 0 && next_idx >= 0);
            push_pred();
            b.op_if(0x40);                                  // void
              store_pc(block->BranchBlock);
              if (both_siblings) emit_tail_to((u32)br_idx); // ends the frame
              else               emit_const_target_probe(block->BranchBlock);
            b.op_else();
              store_pc(block->NextBlock);
              if (both_siblings) emit_tail_to((u32)next_idx);
              else               emit_const_target_probe(block->NextBlock);
            b.op_end();
            if (both_siblings) return;   // both arms tail-called; below unreachable
            emit_rt_bump(&g_exit_cond_xshd);   // guard-block/miss only (scar #2)
            break;
        }
        // ---- Legacy two-derivation form (kill-switch: FLYCAST_COND_MERGE=0) --
        b.op_local_get(LOCAL_CTX);

        if (block->has_jcond) {
            s32 jdynLocal = cache.getLocal(ctx_off::JDYN);
            if (jdynLocal >= 0) {
                emitCachedLocalGet(b, cache, ctx_off::JDYN, (u32)jdynLocal);
            } else {
                b.op_local_get(LOCAL_CTX);
                b.op_i32_load(ctx_off::JDYN);
            }
        } else {
            s32 srTLocal = cache.getLocal(ctx_off::SR_T);
            if (srTLocal >= 0) {
                emitCachedLocalGet(b, cache, ctx_off::SR_T, (u32)srTLocal);
            } else {
                b.op_local_get(LOCAL_CTX);
                b.op_i32_load(ctx_off::SR_T);
            }
        }

        if (cond == 1) {
            b.op_if(WASM_TYPE_I32);
        } else {
            b.op_i32_eqz();
            b.op_if(WASM_TYPE_I32);
        }
        b.op_i32_const((s32)block->BranchBlock);
        b.op_else();
        b.op_i32_const((s32)block->NextBlock);
        b.op_end();

        b.op_i32_store(ctx_off::PC);

        // Intra-link for BET_Cond: BOTH arms must be in the active set for
        // unconditional tail-call replacement. Otherwise, fall through to
        // the C++ dispatcher (which can chain to the right block on the
        // next iteration). Doing partial-link (only one arm tail-calls,
        // the other returns) would complicate the wasm control flow since
        // we'd need to undo the i32_store and re-branch.
        if (block != nullptr) {
            s32 br_idx   = sibling_func_idx(block->BranchBlock, self_vaddr, vaddr_to_idx);
            s32 next_idx = sibling_func_idx(block->NextBlock,   self_vaddr, vaddr_to_idx);
            if (br_idx >= 0 && next_idx >= 0) {
                // Re-derive the condition (SR_T or jdyn) into an if/else.
                if (block->has_jcond) {
                    s32 jdynLocal = cache.getLocal(ctx_off::JDYN);
                    if (jdynLocal >= 0) {
                        emitCachedLocalGet(b, cache, ctx_off::JDYN, (u32)jdynLocal);
                    } else {
                        b.op_local_get(LOCAL_CTX);
                        b.op_i32_load(ctx_off::JDYN);
                    }
                } else {
                    s32 srTLocal = cache.getLocal(ctx_off::SR_T);
                    if (srTLocal >= 0) {
                        emitCachedLocalGet(b, cache, ctx_off::SR_T, (u32)srTLocal);
                    } else {
                        b.op_local_get(LOCAL_CTX);
                        b.op_i32_load(ctx_off::SR_T);
                    }
                }
                if (cond == 1) {
                    b.op_if(0x40);   // void blocktype
                } else {
                    b.op_i32_eqz();
                    b.op_if(0x40);   // void blocktype
                }
                // taken arm — branch target
                emit_tail_to((u32)br_idx);
                b.op_else();
                // not-taken arm — next block
                emit_tail_to((u32)next_idx);
                b.op_end();
                // Both arms tail-called; control never returns to the
                // caller's trailing PC-load. That code is unreachable.
                return;
            }
        }
        // Lever-5E2 arm-split: re-derive the condition (same pattern as the
        // sibling-link path) and probe the matching CONST target — each arm
        // owns its own {slot,gen} site, so alternating branches keep both
        // targets cached instead of thrashing one monomorphic entry.
        if (block != nullptr) {
            if (block->has_jcond) {
                s32 jdynLocal = cache.getLocal(ctx_off::JDYN);
                if (jdynLocal >= 0) {
                    emitCachedLocalGet(b, cache, ctx_off::JDYN, (u32)jdynLocal);
                } else {
                    b.op_local_get(LOCAL_CTX);
                    b.op_i32_load(ctx_off::JDYN);
                }
            } else {
                s32 srTLocal = cache.getLocal(ctx_off::SR_T);
                if (srTLocal >= 0) {
                    emitCachedLocalGet(b, cache, ctx_off::SR_T, (u32)srTLocal);
                } else {
                    b.op_local_get(LOCAL_CTX);
                    b.op_i32_load(ctx_off::SR_T);
                }
            }
            if (cond == 1) {
                b.op_if(0x40);
            } else {
                b.op_i32_eqz();
                b.op_if(0x40);
            }
            emit_const_target_probe(block->BranchBlock);
            b.op_else();
            emit_const_target_probe(block->NextBlock);
            b.op_end();
        }
        emit_rt_bump(&g_exit_cond_xshd);     // reached only on guard-block/miss (scar #2)
        break;
    }
    }

    // Tail-call UpdateINTC for blocks that end with an SR-affecting op
    // (LDC SR -> BET_StaticIntr, RTE -> BET_DynamicIntr). After the SR
    // change, decoded_srimask may have just reopened — UpdateINTC checks
    // Sh4cntx.interrupt_pend and dispatches Do_Interrupt() if any IRQ is
    // newly deliverable. Native rec-x64 does the equivalent via
    // GenCall(UpdateINTC) at rec_x64.cpp:517-531. Without this, BIOS's
    // first BL-clearing LDC clears BL in ctx but no IRQ is ever delivered,
    // so the IRQ-driven init sequence wedges. Sentinel block_vaddr=0xFF..F
    // routes the SHIL_FB import to UpdateINTC via sh4_interp_shil_fb.
    // ORDER 21b — DO NOT emit the immediate UpdateINTC for RTE (BET_DynamicIntr)
    // by default: it re-vectored a still-pending IRQ the instant RTE restored PC,
    // BEFORE the RTE-target instruction ran — a per-block delivery far more
    // aggressive than native (rec_x64 delivers at timeslice boundaries only). With
    // the Maple bit12 storm still pending after every ISR, that livelocked the main
    // thread (spc pinned, memset frontier frozen at 124 MHz). RTE's IRQ is still
    // delivered by the crediting-loop UpdateINTC at the next slice boundary — AFTER
    // the target runs (native's order; the SH4 "one instruction after RTE"
    // behaviour). Keep it for BET_StaticIntr (LDC SR / BL-clear) — the BIOS init
    // path documented above needs that immediate delivery. g_emit_rte_intc restores
    // the old behaviour for A/B.
    const bool intr_intc =
        block != nullptr &&
        (block->BlockType == BET_StaticIntr ||
         (block->BlockType == BET_DynamicIntr && g_emit_rte_intc));
    if (intr_intc) {
        b.op_i32_const((s32)0xFFFFFFFFu);   // sentinel
        b.op_i32_const(0);
        b.op_call(WIMPORT_SHIL_FB);
    }
}

// ---------------------------------------------------------------------------
// Memset byte-loop pattern detector + fast-path emitter.
//
// Targets the BSS-clear / buffer-init style loop seen on PSO boot at
// 0x8c0133f4 (see dreamcast_sh4_memset_loop_2026_05_17.md). Pattern:
//
//   mov.b R_val,@R_dst     ; shop_writem size=1
//   add #1,R_dst           ; shop_add rs2.imm=1, rd==rs1==R_dst
//   mov.l @R_endp,R_end    ; shop_readm size=4
//   cmp/hs R_end,R_dst     ; shop_setae rs1=R_dst (post-inc), rs2=R_end
//   bf <self>              ; BET_Cond_0, BranchBlock == vaddr
//
// When matched, instead of dispatching the 5-op block once per byte stored
// (the F3 self-loop gate at line 1379 rejects this shape — it only accepts
// shop_sub#1 or shop_seteq bodies), emit a single wasm `memory.fill` that
// covers [R_dst, R_end) in one operation. Falls back to the normal block
// emit if any runtime check fails (endpoints not in area-3 RAM, or
// R_end < R_dst).
// ---------------------------------------------------------------------------
struct MemsetPattern {
    bool detected      = false;
    u32  dst_off       = 0;    // ctx offset of R_dst (e.g. R5)
    u32  val_off       = 0;    // ctx offset of R_val (e.g. R4)
    u32  endp_off      = 0;    // ctx offset of R_endp (e.g. R6 — address holding end)
    u32  end_off       = 0;    // ctx offset of R_end (e.g. R2 — value loaded from @R_endp)
};

static MemsetPattern detectMemsetByteLoop(RuntimeBlockInfo* block) {
    MemsetPattern p;
    if (block == nullptr) return p;
    if (BET_GET_CLS(block->BlockType) != BET_CLS_COND) return p;
    if (block->BlockType != BET_Cond_0) return p;     // bf only
    if (block->BranchBlock != block->vaddr) return p; // taken arm == self
    if (block->oplist.size() != 4) return p;

    const shil_opcode& w = block->oplist[0];
    const shil_opcode& a = block->oplist[1];
    const shil_opcode& r = block->oplist[2];
    const shil_opcode& s = block->oplist[3];

    // writem size=1, address rs1, value rs2, no rs3 displacement.
    if (w.op != shop_writem || w.size != 1) return p;
    if (!w.rs1.is_r32i() || !w.rs2.is_r32i()) return p;
    if (!w.rs3.is_null()) return p;

    // add: rd = rs1 + 1; rd must alias rs1 (in-place ++), and equal writem's
    // address operand (we're incrementing the dest pointer).
    if (a.op != shop_add) return p;
    if (!a.rd.is_r32i() || !a.rs1.is_r32i() || !a.rs2.is_imm()) return p;
    if (a.rs2._imm != 1) return p;
    if (a.rd.reg_offset() != a.rs1.reg_offset()) return p;
    if (a.rd.reg_offset() != w.rs1.reg_offset()) return p;

    // readm size=4, address rs1, dest rd. No rs3 displacement.
    if (r.op != shop_readm || r.size != 4) return p;
    if (!r.rs1.is_r32i() || !r.rd.is_r32i()) return p;
    if (!r.rs3.is_null()) return p;

    // setae: rs1 = incremented dest, rs2 = loaded end. (cmp/hs Rm,Rn maps
    // to T = (Rn >= Rm) unsigned; flycast's SHIL canonicalizes so
    // rs1 holds the LHS of the >= comparison.)
    if (s.op != shop_setae) return p;
    if (!s.rs1.is_r32i() || !s.rs2.is_r32i()) return p;
    if (s.rs1.reg_offset() != a.rd.reg_offset()) return p;
    if (s.rs2.reg_offset() != r.rd.reg_offset()) return p;

    p.detected = true;
    p.dst_off  = w.rs1.reg_offset();
    p.val_off  = w.rs2.reg_offset();
    p.endp_off = r.rs1.reg_offset();
    p.end_off  = r.rd.reg_offset();
    return p;
}

// Emits the memset fast-path probe. Stack must be empty on entry.
// If the runtime checks (both endpoints in area-3 RAM AND end >= start AND
// dest_masked+len fits within MEM1) all pass, the fast path executes
// memory.fill, updates ctx (R_dst=R_end, T=1, PC=NextBlock, CYCLE_COUNTER
// debited proportionally), and `return`s. Otherwise control falls through
// with an empty stack to the regular block emit (the slow byte-loop).
//
// Uses direct ctx i32.load/i32.store (no cache locals) so it can run
// before reloadOrInvalidate, and so a fall-through leaves cache state
// untouched for the regular emit path.
static void emitMemsetFastPath(WasmModuleBuilder& b, RuntimeBlockInfo* block,
                               const MemsetPattern& p)
{
    // Not named RAM_SIZE because flycast's types.h has a
    // `#define RAM_SIZE settings.platform.ram_size` that would substitute in
    // here and break the constexpr declaration.
    constexpr u32 MEM1_BYTES    = 0x01000000;   // MEM1 = 16 MiB
    constexpr u32 SH4_AREA_MASK = 0x1FFFFFFF;
    constexpr u32 SH4_LO24_MASK = 0x00FFFFFF;

    // dst_addr -> LOCAL_TMP
    b.op_local_get(LOCAL_CTX);
    b.op_i32_load(p.dst_off);
    b.op_local_set(LOCAL_TMP);

    // end_ptr_addr -> LOCAL_TMP2
    b.op_local_get(LOCAL_CTX);
    b.op_i32_load(p.endp_off);
    b.op_local_set(LOCAL_TMP2);

    // Read end value from @end_ptr_addr with area-3 fastpath, mirroring
    // the shop_readm fastpath at line 511-547. Result -> LOCAL_TMP3.
    b.op_local_get(LOCAL_TMP2);
    b.op_i32_const(SH4_AREA_MASK); b.op_i32_and();
    b.op_local_tee(LOCAL_TMP3);
    b.op_i32_const(26); b.op_i32_shr_u();
    b.op_i32_const(3); b.op_i32_eq();
    b.op_if(WASM_TYPE_I32);
        b.op_local_get(LOCAL_RAM);
        b.op_local_get(LOCAL_TMP3);
        b.op_i32_const(SH4_LO24_MASK); b.op_i32_and();
        b.op_i32_add();
        b.op_i32_load(0);
    b.op_else();
        b.op_local_get(LOCAL_TMP2);
        b.op_call(WIMPORT_READ32);
    b.op_end();
    b.op_local_set(LOCAL_TMP3);              // end_val (R2)

    // Combined fast-path condition:
    //   (dst_addr in area-3) && (end_val in area-3)
    //   && (end_val >= dst_addr) && (dst_masked + length <= MEM1_BYTES)
    // Computed as four bools AND'd; V8 still gets to short-circuit through
    // the outer `if` branch (only one fill site per memset).

    // dst_area3
    b.op_local_get(LOCAL_TMP);
    b.op_i32_const(SH4_AREA_MASK); b.op_i32_and();
    b.op_i32_const(26); b.op_i32_shr_u();
    b.op_i32_const(3); b.op_i32_eq();

    // end_val area-3
    b.op_local_get(LOCAL_TMP3);
    b.op_i32_const(SH4_AREA_MASK); b.op_i32_and();
    b.op_i32_const(26); b.op_i32_shr_u();
    b.op_i32_const(3); b.op_i32_eq();
    b.op_i32_and();

    // end_val > dst (unsigned, STRICT). The SH4 loop is a do-while: writem is
    // oplist[0], so it stores one byte BEFORE the bottom cmp/hs+bf. Hence even
    // when end_val == dst the hardware writes ONE byte at dst and advances
    // R_dst to dst+1. A `>=` guard let the fastpath fire on end_val==dst,
    // filling ZERO bytes and leaving R_dst==dst — a dropped byte AND an
    // off-by-one pointer that corrupts all downstream pointer math (the
    // deterministic 2nd-stage decrypt corruption). `>` restricts the fastpath
    // to fills of >=1 byte (exact do-while equivalence); end_val<=dst falls
    // through to the real per-op loop, which handles the single-byte case.
    b.op_local_get(LOCAL_TMP3);
    b.op_local_get(LOCAL_TMP);
    b.op_i32_gt_u();
    b.op_i32_and();

    // (dst_masked + (end_val - dst)) <= MEM1_BYTES — guards mirror-region
    // fills from overrunning MEM1's 16 MiB region in linear memory.
    // = (dst & LO24) + (end_val - dst) <= MEM1_BYTES
    b.op_local_get(LOCAL_TMP);
    b.op_i32_const(SH4_LO24_MASK); b.op_i32_and();
    b.op_local_get(LOCAL_TMP3);
    b.op_local_get(LOCAL_TMP);
    b.op_i32_sub();
    b.op_i32_add();
    b.op_i32_const((s32)MEM1_BYTES);
    b.op_i32_le_u();
    b.op_i32_and();

    b.op_if();
        // memory.fill(LOCAL_RAM + (dst & 0xFFFFFF), R_val, end - dst)
        b.op_local_get(LOCAL_RAM);
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(SH4_LO24_MASK); b.op_i32_and();
        b.op_i32_add();

        b.op_local_get(LOCAL_CTX);
        b.op_i32_load(p.val_off);

        b.op_local_get(LOCAL_TMP3);
        b.op_local_get(LOCAL_TMP);
        b.op_i32_sub();
        b.op_local_tee(LOCAL_TMP4);        // length, kept for cycle drain

        b.op_memory_fill();

        // R_dst = end_val
        b.op_local_get(LOCAL_CTX);
        b.op_local_get(LOCAL_TMP3);
        b.op_i32_store(p.dst_off);

        // R_end already holds end_val on natural exit (mov.l @R_endp,R_end).
        // Store it explicitly so downstream code sees the same SHIL effect.
        b.op_local_get(LOCAL_CTX);
        b.op_local_get(LOCAL_TMP3);
        b.op_i32_store(p.end_off);

        // SR.T = 1 (cmp/hs of equal endpoints sets T)
        b.op_local_get(LOCAL_CTX);
        b.op_i32_const(1);
        b.op_i32_store(ctx_off::SR_T);

        // PC = NextBlock (bf-not-taken arm, i.e. exit the loop)
        b.op_local_get(LOCAL_CTX);
        b.op_i32_const((s32)block->NextBlock);
        b.op_i32_store(ctx_off::PC);

        // Cycle drain: 5 cycles per skipped iteration (loop body is 5
        // instructions on real SH4: mov.b, add, mov.l, cmp/hs, bf-d).
        b.op_local_get(LOCAL_CTX);
        b.op_local_get(LOCAL_CTX);
        b.op_i32_load(ctx_off::CYCLE_COUNTER);
        b.op_local_get(LOCAL_TMP4);
        b.op_i32_const(5);
        b.op_i32_mul();
        b.op_i32_sub();
        b.op_i32_store(ctx_off::CYCLE_COUNTER);

        // Lever-4 SMC mark over the filled range: gen += map[c] for every 4B
        // word-chunk in [dst, dst+len). A memset over compiled code (loader
        // zeroing a stage) must invalidate the IC like any other store.
        // len >= 1 is guaranteed (the strict `>` guard above), and the MEM1
        // guard bounds hi < 2^22. TMP (dst) and TMP4 (len) are dead after
        // this; TMP2 is free. TMP2 = lo chunk, TMP = hi chunk.
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(SH4_LO24_MASK); b.op_i32_and();
        b.op_local_tee(LOCAL_TMP2);                    // masked dst
        b.op_local_get(LOCAL_TMP4);
        b.op_i32_add();
        b.op_i32_const(1); b.op_i32_sub();
        b.op_i32_const(2); b.op_i32_shr_u();
        b.op_local_set(LOCAL_TMP);                     // hi = (mdst+len-1)>>2
        b.op_local_get(LOCAL_TMP2);
        b.op_i32_const(2); b.op_i32_shr_u();
        b.op_local_set(LOCAL_TMP2);                    // lo = mdst>>2
        b.op_loop(0x40);
            {
                const u32 gen = (u32)(uintptr_t)&g_ic_generation;
                b.op_i32_const((s32)gen);
                b.op_i32_const((s32)gen);
                b.op_i32_load(0);
                b.op_local_get(LOCAL_TMP2);
                b.op_i32_load8_u((u32)(uintptr_t)g_code_map);   // base in the memarg
                b.op_i32_add();
                b.op_i32_store(0);                     // gen += map[c]
            }
            b.op_local_get(LOCAL_TMP2);
            b.op_i32_const(1); b.op_i32_add();
            b.op_local_tee(LOCAL_TMP2);
            b.op_local_get(LOCAL_TMP);
            b.op_i32_le_u();
            b.op_br_if(0);                             // while (c <= hi)
        b.op_end();

        // return ctx.pc
        b.op_local_get(LOCAL_CTX);
        b.op_i32_load(ctx_off::PC);
        b.op_return();
    b.op_end();
    // Fall-through: stack empty, normal block emit continues.
}

// ---------------------------------------------------------------------------
// Internal: emit one block's function body INTO an existing builder.
//
// Called by build_block between b.beginCodeSection(1) and the matching
// endSection(); caller is responsible for opening/closing the code section.
//
// Layout assumes the function signature is (i32 ctx_ptr, i32 ram_base) -> i32
// — same as the standalone build_block emits.
//
// Pre-scan allocates one i32 cache local per referenced register, plus a
// single i64 scratch for dual-output 64-bit ops.
//   Layout (after the 2 i32 params at indices 0,1):
//     indices 2..(2+i32Count-1)  : i32 locals (TMP..TMP5 + cache slots)
//     index   2+i32Count         : the i64 scratch
//
// BUG FIXED 2026-05-15: i32Count must be computed BEFORE setting
// _tmp64LocalIdx (otherwise local.tee(t64) writes i64 into an i32 slot, V8
// rejects entire module). See the original build_block comment for details.
// ---------------------------------------------------------------------------
// Lever-5G: allocate f32 cache entries. Candidates = fr offsets accessed by
// the f32-helper op set (+ fmov fr,fr). Exclusions = ANY other op touching
// the offset through a non-f32 path — readm into fr, writem from fr, mov64
// pairs, and the raw-bank natives fipr/ftrv/frswap (v2 can make those
// cache-aware; v1 keeps them memory-direct and airtight). An excluded offset
// gets NO entry, so both paths stay ctx-direct and can never desync.
static bool fpu_f32_helper_op(u32 opnum) {
    switch (opnum) {
    case shop_fadd: case shop_fsub: case shop_fmul: case shop_fdiv:
    case shop_fabs: case shop_fneg: case shop_fsqrt: case shop_fmac:
    case shop_fsrra: case shop_fseteq: case shop_fsetgt:
    case shop_cvt_i2f_n: case shop_cvt_i2f_z: case shop_cvt_f2i_t:
        return true;
    default: return false;
    }
}
// Multi-block variant. The candidate/exclusion sets MUST be unioned across every
// oplist that will be emitted into one function body: calling the single-block
// scan once per member is UNSOUND, because addOffsetF32 is idempotent and an
// exclusion discovered in member 2 cannot retract a candidate member 1 already
// installed. Concretely — member 1 does `fadd fr2` (candidate) and member 2 does
// `fmov.d @rn, fr2` (a size-8 writem, which reads fr2 straight out of ctx) — the
// sequential scan leaves fr2 in an f32 local, so member 2 stores the STALE ctx
// copy. Caught by the T6_fpu_loop fixture in the runtime differential; it applies
// to the lever-2 region path too, which is why both go through this function.
static void scanBlocksF32(RuntimeBlockInfo* const* blks, size_t nblk, RegCache& cache) {
    if (!g_emit_fpu_cache || blks == nullptr || nblk == 0) return;
    std::vector<u32> cand, excl;
    auto addTo = [](std::vector<u32>& v, u32 off) {
        for (u32 o : v) if (o == off) return;
        v.push_back(off);
    };
    auto span = [&](std::vector<u32>& v, u32 base, u32 words) {
        for (u32 i = 0; i < words; i++) addTo(v, base + i * 4);
    };
    for (size_t bi = 0; bi < nblk; ++bi) {
    RuntimeBlockInfo* blk = blks[bi];
    if (blk == nullptr) continue;
    for (size_t i = 0; i < blk->oplist.size(); ++i) {
        const shil_opcode& op = blk->oplist[i];
        const shil_param* ps[5] = { &op.rs1, &op.rs2, &op.rs3, &op.rd, &op.rd2 };
        if (fpu_f32_helper_op(op.op)) {
            for (auto* p : ps)
                if (p->is_r32f()) addTo(cand, p->reg_offset());
            continue;
        }
        if (op.op == shop_mov32 && op.rd.is_r32f() && op.rs1.is_r32f()) {
            addTo(cand, op.rd.reg_offset());
            addTo(cand, op.rs1.reg_offset());
            continue;
        }
        switch (op.op) {
        case shop_fipr:
            // 5G v2: cache-aware emission — vectors + rd are candidates.
            span(cand, op.rs1.reg_offset(), 4);
            span(cand, op.rs2.reg_offset(), 4);
            if (!op.rd.is_null()) addTo(cand, op.rd.reg_offset());
            break;
        case shop_ftrv:
            // 5G v2: the v vector is a candidate; the xf matrix stays
            // ctx-direct (read-only here, and nothing else caches xf, so no
            // mixed-path hazard — caching 16 once-read values would cost
            // more in prologue reloads than it saves).
            span(cand, op.rs1.reg_offset(), 4);
            break;
        case shop_frswap:
            span(excl, op.rs1.reg_offset(), 16);
            span(excl, op.rd.reg_offset(), 16);
            break;
        default: {
            // Generic rule: any f32/f64-typed param on a non-helper op
            // (readm rd, writem rs2, mov64 pairs, fsca rd, IFB'd FPU ops)
            // excludes its offset(s).
            //
            // The exclusion is driven by the WIDTH THE EMITTER ACTUALLY TOUCHES,
            // not only by the param's declared type: the size-8 readm/writem and
            // mov64 paths read/write BOTH words (reg_offset and reg_offset + 4)
            // straight out of ctx, whatever the param claims. A scalar-typed
            // param on such an op used to leave the SECOND word cacheable, and
            // an f32 local holding it then shadowed the ctx copy the emitted
            // pair-store reads (T6_fpu_loop caught exactly this: fr3 stayed in a
            // local while `fmov.d fr2, @rn` stored the stale ctx word).
            const bool pair = ((op.op == shop_readm || op.op == shop_writem) && op.size == 8)
                              || op.op == shop_mov64;
            for (auto* p : ps) {
                if (p->is_r32f()) {
                    addTo(excl, p->reg_offset());
                    if (pair) addTo(excl, p->reg_offset() + 4);
                } else if (p->is_r64f()) {
                    addTo(excl, p->reg_offset()); addTo(excl, p->reg_offset() + 4);
                }
            }
            break;
        }
        }
    }
    }
    for (u32 off : cand) {
        bool ex = false;
        for (u32 e : excl) if (e == off) { ex = true; break; }
        if (!ex) cache.addOffsetF32(off);
    }
}
static void scanBlockF32(RuntimeBlockInfo* blk, RegCache& cache) {
    scanBlocksF32(&blk, 1, cache);
}

// ---------------------------------------------------------------------------
// Preload elision (prologue-trim lever). The eager RegCache prologue emits
// `local.get ctx; load off; local.set L` for EVERY offset scanBlock/scanBlockF32
// assigned — including offsets the block only ever WRITES. On a cmp+branch block
// that is a guaranteed dead load of sr.T every single execution; on a 12-op block
// with 14 live offsets the measured dump showed 9 of 14 dead (see the gate
// comment at g_emit_preload_elide).
//
// This walks the oplist in program order and marks an offset "no preload" iff
// its FIRST access is a full, unconditional, top-level DEFINITION emitted
// through emitPostStore / emitPostStoreOffset / emitPostStoreF32 (`local.set L`).
// Anything else — a read, a vector/64-bit op that writes ctx memory directly, or
// any op that flushes+reloads the cache — leaves the offset preloaded.
//
// Correctness rests on three properties, each checked against the emitters:
//   1. every whitelisted op's rd/rd2 store is emitted at ifDepth 0 (readm/shld/
//      shad/cvt_f2i_t open an `if` for the VALUE and store after its `end`), so
//      the local.set always executes when the op executes;
//   2. the scan stops at the first barrier op (ifb/sync_*/pref/div*/fsca/
//      mov64/frswap/unknown), so no decision is made past a flushAll+reloadAll;
//   3. reads inside one op are marked before that op's defs, so an in-place
//      update (rd == rs1) is correctly classified read-first.
// Not applied to lever-2 regions (two oplists, union'd cache) — see call site.
// ---------------------------------------------------------------------------
static bool preload_barrier_op(u32 opnum) {
    switch (opnum) {
    case shop_ifb: case shop_sync_sr: case shop_sync_fpscr: case shop_pref:
    case shop_div1: case shop_div32u: case shop_div32s: case shop_div32p2:
    case shop_fsca: case shop_illegal: case shop_debug_1: case shop_debug_3:
    case shop_mov64: case shop_frswap:
        return true;
    default:
        return false;
    }
}
static bool preload_toplevel_def_op(const shil_opcode& op) {
    switch (op.op) {
    case shop_mov32: case shop_add: case shop_sub: case shop_and: case shop_or:
    case shop_xor:   case shop_not: case shop_neg: case shop_shl: case shop_shr:
    case shop_sar:   case shop_ror: case shop_ext_s8: case shop_ext_s16:
    case shop_mul_u16: case shop_mul_s16: case shop_mul_i32:
    case shop_swaplb:  case shop_xtrct:
    case shop_test:  case shop_seteq: case shop_setge: case shop_setgt:
    case shop_setae: case shop_setab: case shop_setpeq:
    case shop_jdyn:  case shop_jcond:
    case shop_fadd:  case shop_fsub: case shop_fmul: case shop_fdiv:
    case shop_fabs:  case shop_fneg: case shop_fsqrt:
    case shop_fseteq: case shop_fsetgt:
    case shop_cvt_i2f_n: case shop_cvt_i2f_z: case shop_cvt_f2i_t:
    case shop_fmac:  case shop_fsrra:
    case shop_shld:  case shop_shad:
    case shop_adc:   case shop_sbc:  case shop_negc:
    case shop_rocl:  case shop_rocr:
    case shop_mul_u64: case shop_mul_s64:
        return true;
    // 1/2/4-byte readm stores rd through emitPostStore after the area-3 if's
    // `end`. The size-8 pair writes ctx memory directly (r64f, never cached) —
    // classify it as a read so nothing downstream can be elided on its account.
    case shop_readm:
        return op.size != 8;
    default:
        return false;
    }
}
static void appendParamOffsets(const shil_param& p, std::vector<u32>& out) {
    if (!p.is_reg()) return;                 // null / imm contribute nothing
    const u32 base = p.reg_offset();
    const u32 n    = p.count();              // 1 r32, 2 r64f, 4/16 vector views
    for (u32 i = 0; i < n; ++i) out.push_back(base + i * 4);
}
static void computeNoPreload(RuntimeBlockInfo* blk, RegCache& cache)
{
    if (blk == nullptr) return;
    // 0 = untouched, 1 = read first, 2 = defined first
    std::unordered_map<u32, int> state;
    std::vector<u32> offs;
    auto mark = [&](const shil_param& p, int kind) {
        offs.clear();
        appendParamOffsets(p, offs);
        for (u32 o : offs) state.emplace(o, kind);
    };
    for (size_t i = 0; i < blk->oplist.size(); ++i) {
        const shil_opcode& op = blk->oplist[i];
        if (preload_barrier_op(op.op)) break;
        // Sources first — an in-place update (rd == rs1) must read-classify.
        mark(op.rs1, 1); mark(op.rs2, 1); mark(op.rs3, 1);
        if (preload_toplevel_def_op(op)) {
            mark(op.rd, 2); mark(op.rd2, 2);
        } else {
            // Op continues (writem / fipr / ftrv / size-8 readm) but its
            // destinations do not qualify as elidable defs.
            mark(op.rd, 1); mark(op.rd2, 1);
        }
    }
    for (const auto& kv : state)
        if (kv.second == 2) cache.setNoPreload(kv.first);
}

// ---------------------------------------------------------------------------
// LEVER-12 trace formation — planning half (see the g_emit_trace comment).
// ---------------------------------------------------------------------------

// Any op whose emission flushes+reloads the whole cache or drops into the
// interpreter. Excluded from traces for the same reason the self-loop excludes
// them (boot-title-wedge finding #1): they make the compile-time dirty model
// and the runtime state diverge in ways this first increment does not model.
static bool traceBlockHasFallback(RuntimeBlockInfo* blk) {
    for (size_t i = 0; i < blk->oplist.size(); ++i) {
        switch (blk->oplist[i].op) {
        case shop_ifb: case shop_sync_sr: case shop_sync_fpscr:
        case shop_pref: case shop_div1: case shop_div32u:
        case shop_div32s: case shop_div32p2: case shop_fsca:
            return true;
        default: break;
        }
    }
    return false;
}
static int traceTWrites(RuntimeBlockInfo* blk) {
    int n = 0;
    for (size_t i = 0; i < blk->oplist.size(); ++i) {
        const shil_opcode& op = blk->oplist[i];
        if (op.rd.is_reg()  && op.rd.reg_offset()  == (u32)ctx_off::SR_T) ++n;
        if (op.rd2.is_reg() && op.rd2.reg_offset() == (u32)ctx_off::SR_T) ++n;
    }
    return n;
}
// A block this emitter is willing to inline into somebody else's function.
// The HEAD is checked separately (it also has to lose to the self-loop and
// memset fastpaths, which are proven and strictly better for their shapes).
static bool traceBlockEligible(RuntimeBlockInfo* blk, RuntimeBlockInfo* head) {
    if (blk == nullptr) return false;
    if (blk->oplist.size() >= 20) return false;
    if (traceBlockHasFallback(blk)) return false;
    if (detectMemsetByteLoop(blk).detected) return false;
    const u32 cls = BET_GET_CLS(blk->BlockType);
    // A self-branching block is the self-loop lever's shape — leave it to run
    // as its own function (the trace would inline a body whose back edge we do
    // not model here).
    if (cls == BET_CLS_COND && blk->BranchBlock == blk->vaddr) return false;
    // Cond members re-derive the branch predicate from live SR_T at the block
    // bottom, exactly as emitBlockExit does; keep the self-loop's conservative
    // >1-T-write exclusion (a T-writing delay slot without has_jcond).
    if (cls == BET_CLS_COND && !blk->has_jcond && traceTWrites(blk) > 1) return false;
    if (!g_trace_cross_page && head != nullptr
        && (blk->vaddr >> 12) != (head->vaddr >> 12)) return false;
    return true;
}

// The successor a trace follows out of `blk`.
//   BET_StaticJump           -> its one target, no side exit.
//   BET_CLS_COND             -> normally the FALL-THROUGH (NextBlock), with the
//                               taken arm as the side exit; but if the TAKEN arm
//                               closes the loop back to the head (directly, or
//                               through one BET_StaticJump), follow it instead.
//   everything else          -> no continuation (the trace ends here and the
//                               member's own emitBlockExit closes it).
// Returns false when there is no trace continuation.
static bool traceChooseSucc(RuntimeBlockInfo* blk, RuntimeBlockInfo* head,
                            const std::unordered_map<u32, RuntimeBlockInfo*>* v2b,
                            u32* out_succ, bool* out_taken_is_cont, u32* out_side)
{
    if (blk == nullptr) return false;
    if (blk->BlockType == BET_StaticJump) {
        *out_succ = blk->BranchBlock; *out_taken_is_cont = true; *out_side = 0;
        return true;
    }
    if (BET_GET_CLS(blk->BlockType) != BET_CLS_COND) return false;
    const u32 taken = blk->BranchBlock, fall = blk->NextBlock;
    auto closes = [&](u32 target) -> bool {
        if (target == head->vaddr) return true;
        auto it = v2b->find(target);                     // one-block lookahead
        if (it == v2b->end() || it->second == nullptr) return false;
        RuntimeBlockInfo* n = it->second;
        return n->BlockType == BET_StaticJump && n->BranchBlock == head->vaddr
               && traceBlockEligible(n, head);
    };
    const bool taken_closes = closes(taken);
    const bool fall_closes  = closes(fall);
    if (taken_closes && !fall_closes) {
        *out_succ = taken; *out_taken_is_cont = true; *out_side = fall;
    } else {
        *out_succ = fall;  *out_taken_is_cont = false; *out_side = taken;
    }
    return true;
}

struct TracePlan {
    std::vector<RuntimeBlockInfo*> blocks;   // blocks[0] == head
    bool is_loop = false;                    // last member's successor == head
};

static TracePlan planTrace(RuntimeBlockInfo* head,
                           const std::unordered_map<u32, RuntimeBlockInfo*>* v2b)
{
    TracePlan plan;
    if (g_emit_trace <= 0 || head == nullptr || v2b == nullptr) return plan;
    if (!g_emit_regcache || s_lazy_regcache_enabled) return plan;  // eager cache only
    // ---- risk-3 valve: never let trace formation be what exhausts the IC ----
    // A trace's side exits allocate g_ic sites, and a straight-line trace
    // duplicates its TAIL member's whole exit into every prefix that reaches it,
    // so per-block site consumption can multiply. Measured offline (emit_dump
    // `sizes`, 256-block single-page shards): the FLYCAST_TRACE=1 loop shape is
    // EXACTLY neutral (1.00 sites/block on and off), but the FLYCAST_TRACE=2
    // 4-block-static-chain shape goes 0.50 -> 2.00 sites/block, a 4x multiplier
    // — the worst case the default limits permit. Real-run anchor: PSO's longest
    // run with icn telemetry (/tmp/dc-probes/R-CAPX.log) compiled 11767 blocks
    // and reached g_ic_next = 12220, i.e. 1.04 sites/block, so the table (65536)
    // exhausts near 63K blocks today but near 15.8K blocks under a worst-case
    // TRACE=2 workload — only 1.34x the observed high-water.
    // Why that matters beyond capacity: have_ic degrades GRACEFULLY per site, so
    // exhaustion is silent, and in a matched pair the TRACED arm would exhaust
    // FIRST — every block compiled after the crossover loses its IC in the ON arm
    // while the same block still has one in the OFF arm. That reads as a trace
    // regression and is not one. Stopping trace formation at 3/4 of the table
    // makes trace-attributable exhaustion impossible: the remaining quarter is
    // reserved for the plain per-block exits, which is what the arm without
    // traces would have spent anyway. Nothing observed comes near this bound.
    if (g_ic_next >= IC_SITES - (IC_SITES / 4)) return plan;
    // The head must not be a shape a proven in-block fastpath already owns.
    if (detectMemsetByteLoop(head).detected) return plan;
    if (BET_GET_CLS(head->BlockType) == BET_CLS_COND && head->BranchBlock == head->vaddr)
        return plan;
    if (!traceBlockEligible(head, nullptr)) return plan;

    plan.blocks.push_back(head);
    u32 ops = (u32)head->oplist.size();
    RuntimeBlockInfo* cur = head;
    for (;;) {
        u32 succ = 0, side = 0; bool taken_is_cont = false;
        if (!traceChooseSucc(cur, head, v2b, &succ, &taken_is_cont, &side)) break;
        if (succ == head->vaddr) { plan.is_loop = true; break; }   // loop closes
        if (plan.blocks.size() >= g_trace_max_blocks) break;
        auto it = v2b->find(succ);
        if (it == v2b->end() || it->second == nullptr) break;       // out of shard
        RuntimeBlockInfo* nxt = it->second;
        if (nxt == cur) break;
        bool already = false;
        for (auto* m : plan.blocks) if (m == nxt || m->vaddr == nxt->vaddr) already = true;
        if (already) break;                    // only head-closing cycles are modelled
        if (!traceBlockEligible(nxt, head)) break;
        if (ops + (u32)nxt->oplist.size() > g_trace_max_ops) break;
        plan.blocks.push_back(nxt);
        ops += (u32)nxt->oplist.size();
        cur = nxt;
    }
    // A 1-block "trace" is just the normal path; a loop trace needs >= 2 members
    // (the 1-block self-loop is the self-loop lever's job).
    if (plan.blocks.size() < 2) { plan.blocks.clear(); plan.is_loop = false; }
    if (!plan.is_loop && g_emit_trace < 2) { plan.blocks.clear(); }
    return plan;
}

static void emitBlockFuncBody(WasmModuleBuilder& b, RuntimeBlockInfo* block,
                              const std::unordered_map<u32, u32>* vaddr_to_idx = nullptr,
                              const std::unordered_map<u32, RuntimeBlockInfo*>* vaddr_to_block = nullptr)
{
    b.beginFuncBody();

    RegCache cache;

    // Reg-cache kill-switch (boot-title-wedge differential): when disabled,
    // no wasm locals are assigned, so every getLocal() returns -1 and all
    // reads/writes go straight to ctx memory (reloadAll/flushAll become
    // no-ops over an empty entry set). If this makes the DP-decrypt PRNG
    // pool correct, the reg-cache across the deep call nest is convicted.
    // LEVER-12 trace formation. Must be planned BEFORE scanBlock so every
    // member's working set gets a local. (This replaced the lever-2 2-block
    // region, deleted 2026-08-29 — see the note at the top of this file.)
    TracePlan trace = planTrace(block, vaddr_to_block);
    const bool have_trace = !trace.blocks.empty();

    if (block != nullptr && g_emit_regcache) cache.scanBlock(block);
    if (have_trace)
        for (size_t i = 1; i < trace.blocks.size(); ++i) cache.scanBlock(trace.blocks[i]);
    // Lever-5G: f32 entries (fr bank) — after the int scan so mixed offsets
    // keep their int entries and addOffsetF32's already-present check holds.
    if (g_emit_regcache) {
        // One scan over ALL the oplists that land in this function body — see
        // scanBlocksF32 on why a per-member scan is unsound.
        if (have_trace) {
            scanBlocksF32(trace.blocks.data(), trace.blocks.size(), cache);
        } else if (block != nullptr) {
            scanBlockF32(block, cache);
        }
    }
    const u32 i32Count = LOCAL_FIXED_I32_COUNT + cache.localCount();
    cache._tmp64LocalIdx = 2 + i32Count;
    // f32 locals occupy the third typed group, after the i64 scratch.
    cache.finalizeF32Locals(2 + i32Count + 1);
    {
        const u32 counts[] = { i32Count, 1, cache.f32Count() };
        const u8  types[]  = { WASM_TYPE_I32, WASM_TYPE_I64, WASM_TYPE_F32 };
        b.emitLocals(3, counts, types);
    }

    if (block != nullptr) {
        // F3 self-loop detection.
        //   - block is BET_CLS_COND (Cond_0 / Cond_1)
        //   - the taken arm targets this block's own vaddr
        //   - block is short (heuristic 20-op cap; 0x8c008374-class spinners
        //     are typically 2-5 ops)
        //   - body contains a register decrement (`shop_sub` rs2 imm 1) or a
        //     direct seteq that produces the loop's exit predicate
        // When all four hold we emit `loop $L; body; cond; br_if 0; end;`
        // and write PC = NextBlock unconditionally on fall-through, bypassing
        // the regular BET_CLS_COND branch in emitBlockExit. The loop body
        // does the cycle-drain itself, so each iteration debits the block's
        // guest_cycles into CYCLE_COUNTER just as the dispatcher would.
        const u32 bcls = BET_GET_CLS(block->BlockType);
        bool self_loop = false;
        if (g_emit_self_loop
            && bcls == BET_CLS_COND
            && block->BranchBlock == block->vaddr
            && block->oplist.size() < 20)
        {
            // Loop-marker scan + FALLBACK EXCLUSION (boot-title-wedge audit
            // finding #1, 2026-08-20): the reg-cache dirty-set is tracked
            // linearly at COMPILE time, but an emitted wasm `loop` re-enters
            // at RUNTIME — any in-body fallback op (ifb / div* / sync_sr /
            // pref / fsca) flushes only the compile-time-dirty set, so regs
            // dirtied later in the body are silently dropped on iteration
            // N+1 and the post-call reload clobbers live locals with stale
            // ctx memory. dt-terminated copy/checksum loops with mac.l-class
            // ops computed garbage — the DP-launcher staging corruption.
            // Such blocks now run loop-less (dispatcher-paced): always
            // correct, and only fallback-containing loops pay the cost.
            bool has_loop_marker = false;
            bool has_fallback_op = false;
            // Count ops that write SR.T (rd/rd2 offset == the T reg). A block
            // WITHOUT has_jcond re-derives the branch predicate from LIVE SR_T
            // at the loop bottom; the SH4 evaluates a bf/s|bt/s branch on the T
            // value BEFORE its delay slot, so if the delay slot writes T (>1
            // T-write in the block) the bottom re-derivation reads the wrong T.
            // This is EXACTLY the DP-decompressor garbage (dt sets T, shlr in the
            // delay slot overwrites it). One T-write (the loop's own cmp/setae)
            // is safe; >1 is excluded. has_jcond loops read the captured JDYN and
            // are safe regardless, but we keep the simple <=1 gate conservatively.
            int t_writes = 0;
            for (size_t i = 0; i < block->oplist.size(); ++i) {
                const shil_opcode& op = block->oplist[i];
                switch (op.op) {
                case shop_ifb:
                case shop_sync_sr:
                case shop_sync_fpscr:
                case shop_pref:
                case shop_div1:
                case shop_div32u:
                case shop_div32s:
                case shop_div32p2:
                case shop_fsca:
                    has_fallback_op = true;
                    break;
                default:
                    break;
                }
                if (op.rd.is_reg()  && op.rd.reg_offset()  == (u32)ctx_off::SR_T) ++t_writes;
                if (op.rd2.is_reg() && op.rd2.reg_offset() == (u32)ctx_off::SR_T) ++t_writes;
                if (op.op == shop_sub && op.rs2.is_imm() && op.rs2._imm == 1)
                    has_loop_marker = true;
                if (op.op == shop_seteq)
                    has_loop_marker = true;
                if (op.op == shop_setae)
                    has_loop_marker = true;
            }
            self_loop = has_loop_marker && !has_fallback_op
                        && (block->has_jcond || t_writes <= 1);
        }

        // ORDER 21b slice-yield precheck — HOISTED to the top of the block by
        // the prologue-trim lever. Rationale for the hoist (the original order
        // ran memset-fastpath + reloadAll first): (a) a spent slice returns
        // without paying the eager cache prologue (N loads) or the memset
        // endpoint probe; (b) it restores the invariant "no guest work executes
        // with cycle_counter <= 0", which the memset fastpath could otherwise
        // violate for a chained entry; (c) it makes the precheck the FIRST
        // instruction of every block, which is the property g_emit_hop_guard=0
        // relies on to drop the redundant caller-side guard. The precheck's
        // cycle_counter load is tee'd into LOCAL_CC and reused by the drain
        // below (one load instead of two). Nothing between the tee and the
        // drain writes cycle_counter on a fall-through path: the memset
        // fastpath debits and RETURNS, the intc check calls out and RETURNS,
        // and the cache reload only touches locals.
        const bool ptrim = g_emit_prologue_trim && (block != nullptr);
        if (ptrim) {
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::CYCLE_COUNTER);
            b.op_local_tee(LOCAL_CC);
            b.op_i32_const(0);
            b.op_i32_le_s();
            b.op_if(0x40);
              b.op_local_get(LOCAL_CTX);
              b.op_i32_const((s32)block->vaddr);
              b.op_i32_store(ctx_off::PC);
              b.op_local_get(LOCAL_CTX);
              b.op_i32_load(ctx_off::PC);
              b.op_return();
            b.op_end();
        }

        // Memset byte-loop fast path. Detected BEFORE reloadOrInvalidate so
        // a successful early-return skips the cache prologue entirely. On
        // fall-through (runtime endpoint/length checks failed) cache state
        // is untouched — the regular emit path that follows runs unchanged.
        const MemsetPattern mp = (g_emit_mem_fastpaths && g_emit_memset)
                                     ? detectMemsetByteLoop(block) : MemsetPattern{};
        if (mp.detected) {
            emitMemsetFastPath(b, block, mp);
        }

        // Lazy mode: prologue is a no-op; first use lazy-loads from memory.
        // Eager mode: emit reloadAll up-front (current default), minus the
        // entries computeNoPreload proved are defined before they are read.
        // Both flavors run BEFORE the loop header so cached locals persist
        // across iterations rather than being re-fetched every time.
        // Preload elision analyses ONE oplist; a trace has several, and a
        // register defined-before-read in the head may be read-first by a later
        // member (and, in a loop trace, by the head itself on iteration 2).
        // Elision is therefore off whenever a multi-block body is emitted.
        if (g_emit_preload_elide && g_emit_regcache && !have_trace)
            computeNoPreload(block, cache);
        reloadPrologueOrInvalidate(b, cache);

        // Per-block interrupt-pend check (Fix A — redream-style). If a peripheral
        // raise (asic_RaiseInterrupt) has set ctx->interrupt_pend AND the SR.IMASK
        // mask allows it, dispatch UpdateINTC via the SHIL_FB sentinel route
        // (block_vaddr=0xFFFFFFFF triggers UpdateINTC at EmscriptenWorker.cpp:1095)
        // and return ctx->pc — the dispatcher re-enters at the new PC after Flycast's
        // Do_Interrupt has rewritten it for the exception vector.
        if (s_intc_pend_check && block != nullptr) {
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::INTERRUPT_PEND);
            b.op_if();
                b.op_i32_const((s32)0xFFFFFFFFu);
                b.op_i32_const(0);
                b.op_call(WIMPORT_SHIL_FB);
                b.op_local_get(LOCAL_CTX);
                b.op_i32_load(ctx_off::PC);
                b.op_return();
            b.op_end();
        }

        // ORDER 21b — NATIVE SLICE-LOOP YIELD (interrupt-starvation general fix).
        // If this timeslice is already spent (cycle_counter <= 0), return to the C
        // trampoline BEFORE running the block so the crediting loop runs
        // sh4_sched_tick (SPG scanline -> VBlank raise) + UpdateINTC (delivery,
        // gated by SRdecode). The exit-path guards (emit_global_probe / emit_tail_to /
        // self-loop bound) only cover *taken* exits, so an in-wasm loop could run past
        // many timeslices with NO VBlank -> the game's frame-sync waits livelock
        // (0x8c3c53f8 / divide loops / etc.). This mirrors rec-x64's per-block mainloop
        // check and guarantees interrupt service regardless of chain/self-loop shape.
        // Cheap: one in-wasm compare per block; a C round-trip only at the ~448-cycle
        // timeslice boundary (chaining still runs ~64 blocks/slice). Re-dispatch after
        // the crediting refill finds cycle_counter>0 and runs the block — no live-loop.
        // (Emitted HERE only when the prologue-trim lever is off; with it on the
        // same check runs at the very top of the block — see `ptrim` above.)
        if (block != nullptr && !ptrim) {
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::CYCLE_COUNTER);
            b.op_i32_const(0);
            b.op_i32_le_s();
            b.op_if(0x40);
              b.op_local_get(LOCAL_CTX);
              b.op_i32_const((s32)block->vaddr);
              b.op_i32_store(ctx_off::PC);
              b.op_local_get(LOCAL_CTX);
              b.op_i32_load(ctx_off::PC);
              b.op_return();
            b.op_end();
        }

        // -------------------------------------------------------------------
        // LEVER-12 — TRACE / SUPERBLOCK BODY.
        //
        //   [loop $L]                              ; loop traces only
        //     for each member M:
        //       if (cycle_counter <= 0) { flush; PC = M.vaddr; return PC }
        //       cycle_counter -= M.guest_cycles
        //       <M's SHIL ops, registers staying in locals>
        //       interior cond member: if (side arm) { flush; PC = side;
        //                                            tail/probe; return PC }
        //       last member, loop:    if (continue arm) br $L
        //                             then the other arm's exit as above
        //       last member, line:    flushAll; emitBlockExit(M)
        //   [end]
        //
        // The registers never round-trip through ctx across an interior
        // boundary, there is no call, and no PC is written — that is the whole
        // lever. Correctness rests on three bookkeeping rules:
        //  1. every exit arm FLUSHES before it leaves, and the compile-time
        //     dirty model is saved/restored around it (saveDirty/restoreDirty)
        //     so the fall-through path still knows those registers are dirty;
        //  2. a loop trace marks the whole cache dirty at the loop header, so
        //     every in-loop flush is a superset of the true dirty set on
        //     iteration 2+ (the linear model is not a fixpoint otherwise —
        //     this is the boot-title-wedge finding-#1 class);
        //  3. members with fallback ops are excluded, so no flushAll+reloadAll
        //     sandwich can appear inside the traced body.
        // -------------------------------------------------------------------
        if (have_trace) {
            ++g_trace_formed;
            g_trace_members += (uint32_t)trace.blocks.size();
            if (trace.is_loop) ++g_trace_loops;

            // Rule 2: loop-carried registers are conservatively dirty.
            if (trace.is_loop) cache.markAllDirty();

            // Push 1 iff blk's conditional branch is TAKEN (mirrors the
            // predicate emitBlockExit re-derives for the same block).
            auto push_taken = [&](RuntimeBlockInfo* blk) {
                if (blk->has_jcond) {
                    s32 j = cache.getLocal(ctx_off::JDYN);
                    if (j >= 0) emitCachedLocalGet(b, cache, ctx_off::JDYN, (u32)j);
                    else { b.op_local_get(LOCAL_CTX); b.op_i32_load(ctx_off::JDYN); }
                } else {
                    s32 t = cache.getLocal(ctx_off::SR_T);
                    if (t >= 0) emitCachedLocalGet(b, cache, ctx_off::SR_T, (u32)t);
                    else { b.op_local_get(LOCAL_CTX); b.op_i32_load(ctx_off::SR_T); }
                }
                if (blk->BlockType != BET_Cond_1) b.op_i32_eqz();  // Cond_0: taken == !T
            };
            // Leave the function for `target`, from inside a conditional arm.
            // Same shape the per-block exit would have taken for a constant
            // target: sibling tail-call when the target is in this shard, else
            // the const-target IC probe, else return the PC to the dispatcher.
            auto emit_exit_to = [&](RuntimeBlockInfo* from, u32 target) {
                cache.flushAll(b);
                b.op_local_get(LOCAL_CTX);
                b.op_i32_const((s32)target);
                b.op_i32_store(ctx_off::PC);
                s32 fidx = sibling_func_idx(target, from->vaddr, vaddr_to_idx);
                if (fidx >= 0) {
                    emitTailTo(b, (u32)fidx);       // ends the frame itself
                    return;
                }
                emitConstTargetProbe(b, target);
                emitRtBump(b, &g_exit_static_xshd);
                b.op_local_get(LOCAL_CTX);
                b.op_i32_load(ctx_off::PC);
                b.op_return();
            };
            // Per-member slice-yield precheck (same test, same PC, same return
            // value as the per-block one — only the flush is new, because a
            // trace can reach it with registers live in locals).
            auto emit_member_precheck = [&](RuntimeBlockInfo* blk) {
                b.op_local_get(LOCAL_CTX);
                b.op_i32_load(ctx_off::CYCLE_COUNTER);
                b.op_i32_const(0);
                b.op_i32_le_s();
                b.op_if(0x40);
                  auto snap = cache.saveDirty();
                  cache.flushAll(b);
                  b.op_local_get(LOCAL_CTX);
                  b.op_i32_const((s32)blk->vaddr);
                  b.op_i32_store(ctx_off::PC);
                  b.op_local_get(LOCAL_CTX);
                  b.op_i32_load(ctx_off::PC);
                  b.op_return();
                  cache.restoreDirty(snap);
                b.op_end();
            };
            // Risk-1 SMC generation guard for an INTERIOR member (never the
            // head — see the g_trace_gen block on why bailing to the head
            // livelocks and bailing to the member cannot). One de-opt per site
            // per generation bump; the restamp is what makes it self-healing.
            auto emit_member_smc_guard = [&](RuntimeBlockInfo* blk) {
                if (!g_trace_smc_guard) return;
                if (g_trace_gen_next >= TRACE_GEN_SITES) return;   // graceful: no guard
                uint32_t* tgen = &g_trace_gen[g_trace_gen_next++];
                *tgen = g_ic_generation;    // stamp at compile time
                b.op_i32_const((s32)(u32)(uintptr_t)tgen); b.op_i32_load(0);
                b.op_i32_const((s32)(u32)(uintptr_t)&g_ic_generation); b.op_i32_load(0);
                b.op_i32_ne();
                b.op_if(0x40);
                  b.op_i32_const((s32)(u32)(uintptr_t)tgen);
                  b.op_i32_const((s32)(u32)(uintptr_t)&g_ic_generation);
                  b.op_i32_load(0);
                  b.op_i32_store(0);        // restamp: one de-opt per bump, not forever
                  auto snap = cache.saveDirty();
                  cache.flushAll(b);
                  b.op_local_get(LOCAL_CTX);
                  b.op_i32_const((s32)blk->vaddr);
                  b.op_i32_store(ctx_off::PC);
                  b.op_local_get(LOCAL_CTX);
                  b.op_i32_load(ctx_off::PC);
                  b.op_return();            // -> trampoline -> VERIFIED jit_lookup(blk)
                  cache.restoreDirty(snap);
                b.op_end();
            };

            if (trace.is_loop) b.op_loop(0x40);

            const size_t last = trace.blocks.size() - 1;
            for (size_t i = 0; i <= last; ++i) {
                RuntimeBlockInfo* m = trace.blocks[i];
                // The head's first entry is already covered by the block's own
                // slice check (hoisted by prologue-trim, or emitted just above
                // when that lever is off) — but a loop trace re-enters the head
                // every iteration, so it needs one INSIDE the loop.
                if (i > 0 || trace.is_loop) emit_member_precheck(m);
                // i == 0 is the head's own code — it was verified by the lookup
                // that entered this function, and guarding it would bail into
                // itself. Only inlined members need the generation proof.
                if (i > 0) emit_member_smc_guard(m);

                if (m->guest_cycles > 0) {
                    b.op_local_get(LOCAL_CTX);
                    if (i == 0 && !trace.is_loop && ptrim) {
                        b.op_local_get(LOCAL_CC);   // tee'd by the top precheck
                    } else {
                        b.op_local_get(LOCAL_CTX);
                        b.op_i32_load(ctx_off::CYCLE_COUNTER);
                    }
                    b.op_i32_const((s32)m->guest_cycles);
                    b.op_i32_sub();
                    b.op_i32_store(ctx_off::CYCLE_COUNTER);
                }

                for (size_t k = 0; k < m->oplist.size(); ++k) {
                    const shil_opcode& op = m->oplist[k];
                    if (emitShilOp(b, op, m, (u32)k, cache)) continue;
                    // Unreachable: traceBlockEligible rejects every op that
                    // cannot emit natively. Keep the correct fallback anyway.
                    cache.flushAll(b);
                    const u32 op_addr = m->vaddr + op.guest_offs;
                    b.op_i32_const((s32)(u32)ReadMem16(op_addr));
                    b.op_i32_const((s32)(op_addr + 2));
                    b.op_call(WIMPORT_IFB);
                    reloadOrInvalidate(b, cache);
                }

                u32 succ = 0, side = 0; bool taken_is_cont = false;
                const bool has_succ =
                    traceChooseSucc(m, block, vaddr_to_block, &succ, &taken_is_cont, &side);
                const bool is_cond = BET_GET_CLS(m->BlockType) == BET_CLS_COND;

                if (i < last) {
                    // Interior member: the trace continues on the chosen arm;
                    // the other arm (cond only) leaves here.
                    if (is_cond) {
                        push_taken(m);
                        if (taken_is_cont) b.op_i32_eqz();   // side arm = NOT taken
                        b.op_if(0x40);
                          auto snap = cache.saveDirty();
                          emit_exit_to(m, side);
                          cache.restoreDirty(snap);
                        b.op_end();
                    }
                    (void)has_succ;
                    continue;
                }

                // Last member.
                if (trace.is_loop) {
                    if (is_cond) {
                        push_taken(m);
                        if (!taken_is_cont) b.op_i32_eqz();  // continue arm
                        b.op_if(0x40);
                          b.op_br(1);                        // -> loop header
                        b.op_end();
                        auto snap = cache.saveDirty();
                        emit_exit_to(m, side);               // ends the frame
                        cache.restoreDirty(snap);
                    } else {
                        b.op_br(0);                          // -> loop header
                    }
                } else {
                    cache.flushAll(b);
                    emitBlockExit(b, m, cache, vaddr_to_idx);
                }
            }

            if (trace.is_loop) b.op_end();                   // close $L
            b.op_local_get(LOCAL_CTX);                       // function result
            b.op_i32_load(ctx_off::PC);
        } else {

        if (self_loop) {
            b.op_loop();   // 0x40 / void blocktype — loop body produces no value
        }

        // Per-block cycle drain. block->guest_cycles is populated by Flycast's
        // decoder (sum of cpu_cycles for each guest op + base block cost) and
        // is what rec-x64/rec-arm decrement per-block. The mainloop's coarse
        // flat 32-cycle subtract is removed; this is the only cycle accounting.
        // Prologue-trim: outside a self-loop the precheck's tee'd LOCAL_CC still
        // holds this block's cycle_counter, so the reload is redundant. Inside a
        // self-loop the drain re-runs per iteration and MUST re-read memory.
        if (block->guest_cycles > 0) {
            b.op_local_get(LOCAL_CTX);
            if (ptrim && !self_loop) {
                b.op_local_get(LOCAL_CC);
            } else {
                b.op_local_get(LOCAL_CTX);
                b.op_i32_load(ctx_off::CYCLE_COUNTER);
            }
            b.op_i32_const((s32)block->guest_cycles);
            b.op_i32_sub();
            b.op_i32_store(ctx_off::CYCLE_COUNTER);
        }

        for (size_t i = 0; i < block->oplist.size(); ++i) {
            const shil_opcode& op = block->oplist[i];
            if (emitShilOp(b, op, block, (u32)i, cache)) continue;

            // Fallback: shop_ifb of this guest opcode (e.g. division).
            cache.flushAll(b);
            const u32 op_addr = block->vaddr + op.guest_offs;
            const u32 pc      = op_addr + 2;
            const u32 opc = (u32)ReadMem16(op_addr);
            b.op_i32_const((s32)opc);
            b.op_i32_const((s32)pc);
            b.op_call(WIMPORT_IFB);
            reloadOrInvalidate(b, cache);
        }

        if (self_loop) {
            const u32 cond_taken = (block->BlockType == BET_Cond_1) ? 1 : 0;
            // Push CONT — the loop-continue (branch-taken) predicate. For Cond_0
            // (bf) that is !cond; for Cond_1 (bt) it is cond.
            auto push_cont = [&]() {
                if (block->has_jcond) {
                    s32 jdynLocal = cache.getLocal(ctx_off::JDYN);
                    if (jdynLocal >= 0) emitCachedLocalGet(b, cache, ctx_off::JDYN, (u32)jdynLocal);
                    else { b.op_local_get(LOCAL_CTX); b.op_i32_load(ctx_off::JDYN); }
                } else {
                    s32 srTLocal = cache.getLocal(ctx_off::SR_T);
                    if (srTLocal >= 0) emitCachedLocalGet(b, cache, ctx_off::SR_T, (u32)srTLocal);
                    else { b.op_local_get(LOCAL_CTX); b.op_i32_load(ctx_off::SR_T); }
                }
                if (cond_taken == 0) b.op_i32_eqz();
            };

            // Loop again only while CONT *and the timeslice still has budget*.
            // Bounding by cycle_counter services interrupts every timeslice, like
            // native's slice_loop (rec_x64.cpp:698). WITHOUT it, an N-iteration
            // fill (the 384KB boot memset at 0x8c12bc6e) drained cycle_counter to
            // a huge negative with NO interrupt servicing, then the crediting loop
            // delivered one giant deferred IRQ burst that pinned the main thread at
            // the rts (0x8c12bc78) — the boot never reached the bit12 clearer and
            // the storm never collapsed (ORDER 21b interp-narrow verdict).
            push_cont();
            if (g_self_loop_cycle_bound) {
                b.op_local_get(LOCAL_CTX);
                b.op_i32_load(ctx_off::CYCLE_COUNTER);
                b.op_i32_const((s32)-SELF_LOOP_CYCLE_SLICE);
                b.op_i32_gt_s();                    // cycle_counter > -SLICE (batch)
                b.op_i32_and();                     // CONT && budget-in-batch
            }
            b.op_br_if(0);                          // depth 0 = top of `loop`
            b.op_end();                             // close `loop`

            // Fell out: loop DONE (!CONT) or, when bounded, timeslice EXPIRED. Flush
            // the loop-carried regs, then pick PC.
            cache.flushAll(b);
            b.op_local_get(LOCAL_CTX);              // addr for the PC store
            if (g_self_loop_cycle_bound) {
                // re-enter loop head on a timeslice break (CONT still true), else NextBlock
                push_cont();
                b.op_if(WASM_TYPE_I32);
                  b.op_i32_const((s32)block->vaddr);
                b.op_else();
                  b.op_i32_const((s32)block->NextBlock);
                b.op_end();
            } else {
                // unbounded: fell out only because the loop finished (!CONT) -> NextBlock
                b.op_i32_const((s32)block->NextBlock);
            }
            b.op_i32_store(ctx_off::PC);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::PC);
        } else {
            cache.flushAll(b);
            emitBlockExit(b, block, cache, vaddr_to_idx);
            // Trailing PC-load for non-linked paths. Unreachable (but valid) when
            // emitBlockExit emitted a return_call tail-call.
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::PC);
        }
        }   // close the trace-else (self_loop / normal per-block path)
    } else {
        b.op_i32_const(0);
    }

    b.endFuncBody();
}

// ---------------------------------------------------------------------------
// Module-envelope helpers. All emitted modules share the same type+import
// layout, so the WIMPORT_* indices (matched up against rec_wasm's
// flycast_build_imports) are stable.
// ---------------------------------------------------------------------------
static void emitTypeImportSection(WasmModuleBuilder& b)
{
    b.emitTypeSection(3);
    {
        const u8 i32t[]  = { WASM_TYPE_I32 };
        const u8 i32x2[] = { WASM_TYPE_I32, WASM_TYPE_I32 };
        b.emitFuncType(i32x2, 2, i32t,  1);   // (i32,i32)->i32  run, read*
        b.emitFuncType(i32t,  1, i32t,  1);   // (i32)->i32      read*
        b.emitFuncType(i32x2, 2, nullptr, 0); // (i32,i32)->()   write*, ifb, shil_fb
    }
    b.endSection();

    // memory + WIMPORT_COUNT funcs + 1 table (__indirect_function_table).
    b.emitImportSection(1 + WIMPORT_COUNT + 1);
    b.emitImportMemory("env", "memory", 1);
    b.emitImportFunc("env", "sh4_read8",   1);
    b.emitImportFunc("env", "sh4_read16",  1);
    b.emitImportFunc("env", "sh4_read32",  1);
    b.emitImportFunc("env", "sh4_write8",  2);
    b.emitImportFunc("env", "sh4_write16", 2);
    b.emitImportFunc("env", "sh4_write32", 2);
    b.emitImportFunc("env", "sh4_ifb",     2);
    b.emitImportFunc("env", "sh4_shil_fb", 2);
    b.emitImportFunc("env", "sh4_lookup_idx", 1);   // WIMPORT_LOOKUP_IDX, (i32)->i32
    // Import Emscripten's shared __indirect_function_table as this module's
    // table 0 so emit_global_probe's return_call_indirect can target sibling
    // blocks' wasmTable slots. initialSize 0 / no-max is a permissive lower
    // bound — the real table is always larger by instantiation time.
    b.emitImportTable("env", "__indirect_function_table", 0);
    b.endSection();
}

// ---------------------------------------------------------------------------
// Whole-block module build (legacy / single-block path).
// ---------------------------------------------------------------------------
std::vector<u8> build_block(RuntimeBlockInfo* block) {
    WasmModuleBuilder b;
    b.emitHeader();
    emitTypeImportSection(b);

    {
        const u32 idx[] = { 0 };
        b.emitFunctionSection(1, idx);
    }
    b.emitExportSection("run", WIMPORT_COUNT);

    // Data count section is mandatory whenever the code section uses
    // bulk-memory ops (memory.fill, memory.copy, data.drop). Emit it
    // unconditionally with count=0 since the module has no data segments —
    // cheap (3 bytes) and unlocks memory.fill in the memset fast path.
    b.emitDataCountSection(0);

    b.beginCodeSection(1);
    emitBlockFuncBody(b, block);
    b.endSection();
    return b.getBytes();
}

// ---------------------------------------------------------------------------
// F1 — Sharded multi-block module build. One module hosts N block functions,
// each exported as run_0..run_<N-1>. F2 intra-shard linking wires up: the
// vaddr→local-func-idx map below feeds emitBlockFuncBody, and the existing
// sibling_func_idx returns valid `return_call` targets for any branch target
// whose vaddr lives in the same shard. Cross-shard branches still fall
// through to the C++ dispatcher unchanged.
//
// Layout mirrors build_block's single-fn module otherwise: identical type +
// import sections (so WIMPORT_* indices stay stable), all N local funcs use
// the same type-0 signature ((i32,i32)->i32). Export section uses the
// multi-export API (beginExportSection / emitExport / endSection).
// ---------------------------------------------------------------------------
std::vector<u8> build_blocks(const std::vector<RuntimeBlockInfo*>& blocks) {
    WasmModuleBuilder b;
    b.emitHeader();
    emitTypeImportSection(b);

    const u32 n = (u32)blocks.size();

    // Build vaddr→local-func-idx map up-front so every block's emitBlockExit
    // can link to ALL sibling blocks regardless of emit order (forward and
    // backward refs both resolve).
    std::unordered_map<u32, u32> vaddr_to_idx;
    vaddr_to_idx.reserve(n);
    // Lever #2: vaddr -> RuntimeBlockInfo* so emitBlockFuncBody can INLINE a
    // sibling block's body into a region (register residency).
    std::unordered_map<u32, RuntimeBlockInfo*> vaddr_to_block;
    vaddr_to_block.reserve(n);
    for (u32 i = 0; i < n; ++i) {
        if (blocks[i] != nullptr) {
            vaddr_to_idx[blocks[i]->vaddr] = i;
            vaddr_to_block[blocks[i]->vaddr] = blocks[i];
        }
    }

    // Function section: N entries, all using type 0 ((i32,i32)->i32).
    {
        std::vector<u32> typeIdx(n, 0u);
        b.emitFunctionSection(n, n > 0 ? typeIdx.data() : nullptr);
    }

    // Export section: N entries, "run_<i>" → WIMPORT_COUNT + i.
    // Buffer names; emitExport stores the const char* through emitName which
    // copies, but we keep the std::strings alive across the loop anyway for
    // safety.
    {
        std::vector<std::string> names(n);
        for (u32 i = 0; i < n; ++i) {
            names[i] = "run_" + std::to_string(i);
        }
        b.beginExportSection(n);
        for (u32 i = 0; i < n; ++i) {
            b.emitExport(names[i].c_str(), WASM_EXPORT_FUNC,
                         WIMPORT_COUNT + i);
        }
        b.endSection();
    }

    // Data count = 0; required by bulk-memory spec for memory.fill use.
    b.emitDataCountSection(0);

    // Code section: N function bodies. emitBlockFuncBody owns its own
    // beginFuncBody/endFuncBody pair so we just sequence them.
    b.beginCodeSection(n);
    for (u32 i = 0; i < n; ++i) {
        emitBlockFuncBody(b, blocks[i], &vaddr_to_idx, &vaddr_to_block);
    }
    b.endSection();
    return b.getBytes();
}

} // namespace bemental::sh4

// C-linkage bridge for the mem-fastpath kill-switch — the emitter global is
// namespaced; the bridge (rec_wasm.cpp _flycast_set_mem_fastpaths) links
// against this unmangled setter.
extern "C" void bemental_sh4_set_mem_fastpaths(int on) {
    bemental::sh4::g_emit_mem_fastpaths = !!on;
}
extern "C" void bemental_sh4_set_regcache(int on) {
    bemental::sh4::g_emit_regcache = !!on;
}
extern "C" void bemental_sh4_set_imm_fastpath(int on) {
    bemental::sh4::g_emit_imm_fastpath = !!on;
}
extern "C" void bemental_sh4_set_self_loop(int on) {
    bemental::sh4::g_emit_self_loop = !!on;
}
extern "C" void bemental_sh4_set_rte_intc(int on) {
    bemental::sh4::g_emit_rte_intc = !!on;
}
// Codegen-audit trim levers (2026-08-29). All three take effect at COMPILE
// time, so they must be set before blocks are built (env var, or a setter call
// from init) — flipping them mid-run only affects blocks compiled afterwards.
extern "C" void bemental_sh4_set_preload_elide(int on) {
    bemental::sh4::g_emit_preload_elide = !!on;
}
extern "C" void bemental_sh4_set_prologue_trim(int on) {
    bemental::sh4::g_emit_prologue_trim = !!on;
}
extern "C" void bemental_sh4_set_hop_guard(int on) {
    bemental::sh4::g_emit_hop_guard = !!on;
}
// Single-predicate BET_CLS_COND exit (2026-08-29). DEFAULT ON; bisect switch.
extern "C" void bemental_sh4_set_cond_merge(int on) {
    bemental::sh4::g_emit_cond_merge = !!on;
}
// LEVER-12 interior-edge SMC generation guard (2026-08-29). DEFAULT OFF — see
// the g_trace_gen block: the unguarded trace edge already matches the shipped
// intra-shard tail-link, so this is an upgrade past shipping behaviour, not a
// fix. Flip ON for shipping once the raw trace win has been measured.
extern "C" void bemental_sh4_set_trace_smc_guard(int on) {
    bemental::sh4::g_trace_smc_guard = !!on;
}
// Area-3 discriminator rewrite (2026-08-29). DEFAULT ON — the predicate is
// bit-identical over the whole 32-bit address space (enumerated) and the
// runtime differential over the emitter fixtures is architecturally identical.
// This is the kill-switch for the four historical boot-title-wedge sites.
extern "C" void bemental_sh4_set_area3_fast(int on) {
    bemental::sh4::g_emit_area3_fast = !!on;
}
// LEVER-12 trace formation (2026-08-29). Compile-time lever: only blocks built
// after the call are affected. mode 0 = off, 1 = loop traces, 2 = + straight
// line. Limits: max member blocks, max total SHIL ops, allow cross-page members.
extern "C" void bemental_sh4_set_trace(int mode) {
    bemental::sh4::g_emit_trace = mode;
}
extern "C" void bemental_sh4_set_trace_limits(int max_blocks, int max_ops, int cross_page) {
    if (max_blocks > 0)
        bemental::sh4::g_trace_max_blocks = (u32)(max_blocks < 2 ? 2 : (max_blocks > 16 ? 16 : max_blocks));
    if (max_ops > 0)
        bemental::sh4::g_trace_max_ops = (u32)(max_ops < 4 ? 4 : (max_ops > 256 ? 256 : max_ops));
    bemental::sh4::g_trace_cross_page = !!cross_page;
}

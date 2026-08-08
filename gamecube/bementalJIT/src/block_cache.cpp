#include "bementalJIT/block_cache.h"

#include "bementalJIT/region_desc.h"   // [region-merged] RegionBlockDesc + merged builder

#include <climits>
#include <cstdint>
#include <cstdlib>
#include <algorithm>     // [top-k window] partial_sort for the promotion ranking
#include <unordered_map>
#include <utility>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

// ---- in-WASM block chaining dispatch cache ------------------------------
// Direct-mapped guest-PC -> wasmTable-slot cache, probed ENTIRELY in WASM by
// each per-block module's epilogue (see ppc_emit.cpp emit_chain_or_return).
// When a block's successor PC resolves here AND no service point is pending
// (downcount>0, Exceptions unchanged), the block return_call_indirect's the
// successor's exported run() directly — no JS dispatch round-trip. A tag
// mismatch (empty bucket or collision) falls back to the JS chain_dispatch_raw
// loop, which is always correct. bucket = (pc>>2) & BEM_DISP_MASK.
//
// Stale entries are SAFE: slots are released (never wrong-block reused —
// _bemental_next_idx is monotonic), so a tail-call to a released slot traps
// and is caught by the JS try/catch around the chain head; register_pc_handle
// overwrites the bucket on recompile (self-heal). clear() invalidates en masse
// to avoid post-clear trap-churn. Tags init to 0xFFFFFFFF so no real guest PC
// (always 0x8xxxxxxx) and no zero-PC matches an unpopulated bucket.
extern "C" {
// [dispatch-cache 2026-06-21] 18 bits = 262144 buckets. At 16 bits PSO's ~4MB
// code range 16-way-aliased into the cache, so hot blocks evicted each other and
// every eviction turned an in-WASM tail-chain into a bem_chain_loop_c return
// (profiled at 22% of worker_0 — the #1 CPU cost, vs ~4.6% in block bodies).
// MUST stay in sync with ppc_emit.cpp BEM_DISP_MASK_NEXT.
#define BEM_DISP_BITS    18u
#define BEM_DISP_BUCKETS (1u << BEM_DISP_BITS)
#define BEM_DISP_MASK    (BEM_DISP_BUCKETS - 1u)
uint32_t      g_bem_disp_tag[BEM_DISP_BUCKETS];   // guest PC, 0xFFFFFFFF = empty
int32_t       g_bem_disp_slot[BEM_DISP_BUCKETS];  // wasmTable index (== handle)
// [region] Region-local direct-mapped cache: same bucket scheme, but the slot
// is the region module's INTERNAL funcref-table index (0..N-1), not the global
// wasmTable handle. The region body epilogue (emit_chain_or_return with the
// override) probes this -> return_call_indirect on the region module's INTERNAL
// table 0 (V8-inlined intra-region). A miss -> host return (per-block path).
// Single active region for now (the seal path repopulates on each gen build).
uint32_t      g_bem_rtag[BEM_DISP_BUCKETS];       // guest PC, 0xFFFFFFFF = empty
int32_t       g_bem_rslot[BEM_DISP_BUCKETS];      // region internal-table slot
// [region-merged 2026-07-15] Dedicated probe pair for MERGED gens: slots are
// PACKED (gen_idx<<16)|br_table_idx so a body can distinguish its own gen's
// entries (warm in-function re-dispatch) from other gens' (host fallthrough).
// Separate from rtag/rslot because the N-fn shape stores RAW internal indices.
uint32_t      g_bem_mrtag[BEM_DISP_BUCKETS];      // guest PC, 0xFFFFFFFF = empty
int32_t       g_bem_mrslot[BEM_DISP_BUCKETS];     // packed (gen<<16)|k, -1 = empty
uint32_t      g_bem_chain_exc0    = 0u;           // Exceptions at chain entry
unsigned char g_bem_chain_enabled = 1;            // master A/B toggle (gate #8)
// [perf gather-gate] Defined HERE (bementalJIT, linked by both the main dolphin
// build AND the test targets) rather than in the bridge, so ppc_emit.cpp's
// epilogue gate resolves it in the test build too. The bridge (dolphin_jit_
// wimports.cpp) externs it and owns the set (dolphin_write*/interp) + clear
// (dolphin_gather_drain). Set => a write-gather-pipe store is pending.
int g_bem_gp_dirty = 0;
// [lc-window PM23] linear-memory address of Memory::GetL1Cache() (256KB locked-L1
// backing). Published by JitWasm at compile-input setup; 0 disables the emitters'
// LC slow-arm shortcut. Blocks compiled before publication bake 0 (import path) —
// harmless, they recompile only if evicted, and publication precedes guest exec.
uint32_t g_bem_lc_base = 0;
// [fprf-gate PM46 2026-07-31] bFPRF half of the FPRF emission gate — native
// Jit64 emits FPRF only when `bFPRF && wantsFPRF`; default false = zero FPRF
// code, matching native MP4. Published by JitWasm from Config::MAIN_FPRF.
uint32_t g_bem_fprf_enabled = 0;
// [accurate-nans-gate PM59 2026-08-05] The SAME native-parity class as FPRF:
// native Jit64 emits the paired-single NaN ladder ONLY when m_accurate_nans
// (Config MAIN_ACCURATE_NANS, default FALSE — Jit_Paired.cpp:87,108). GMPE01
// has no INI override, so native MP4 emits ZERO accurate-NaN code, while we
// emitted the ~15-op ladder on EVERY ps arith/FMA op. default 0 = raw IEEE
// result (what native produces at default), matching the real dual-core oracle
// AND cutting the ladder from the 55.8% guest-body cost. Published by JitWasm
// from Config::MAIN_ACCURATE_NANS. Set to 1 by test_diff_next to keep the
// accurate path validated bit-for-bit against DolphinPPCTests.
uint32_t g_bem_accurate_nans = 0;
// [ni-flush-gate PM60 2026-08-05] The paired-single NI/FTZ subnormal flush is a
// pure wasm-vs-native TAX: native x86 gets flush-to-zero FREE from the host FPU
// (MXCSR FTZ/DAZ set once), but wasm has NO host FP-mode control, so we emit a
// per-op subnormal check+flush on every SIMD ps result (emit_v128_ni_flush ~14
// ops). Subnormals are astronomically rare in game math and invisible, so
// default 0 = skip (raw IEEE, faster than native's per-op-free-but-we-can't).
// Set to 1 by test_diff_next to keep the flushed path validated. Guest-observable
// (unlike accurate_nans which native also skips) — validate all 3 games render.
uint32_t g_bem_ni_flush = 0;
// Phase A: per-block execution counter + promote ring, written by the BLOCK
// PROLOGUE in-WASM (so it counts tail-chained executions the C dispatch loop
// never sees — the chain-head promotion was net-negative). On the
// HOT_THRESHOLD crossing the block pushes its start_pc here; BlockCache::
// chain_dispatch drains g_bem_promote_ring -> promote_hot -> region build,
// moving the actual hot path to intra-module dispatch. bucket=(pc>>2)&mask.
uint32_t      g_bem_pc_exec[BEM_DISP_BUCKETS];    // per-pc execution count
uint32_t      g_bem_promote_ring[256];            // prologue-pushed hot pcs
uint32_t      g_bem_promote_n = 0u;               // count in the ring
// [region-debug TEMP gate#8] region_dispatch outcome counters.
uint32_t      g_rd_calls = 0u, g_rd_nohandle = 0u, g_rd_noregion = 0u, g_rd_miss = 0u, g_rd_hit = 0u;
uint32_t      g_rd_nogen = 0u;   // [region-debug] sealed dispatch: no gens sealed yet OR gen slot missing
// Phase A: DEFAULT OFF. The prologue counter correctly captures the hot path
// (n_funcs 42->650) but the existing region path is net-negative as-is: it
// (a) doesn't dispatch (region_dispatch=0% — routing/build bug) and (b)
// cold-relinks per generation (ticks 7.14B->3.45B). Re-enable only with the
// dispatch fix + region SEAL (no relink-on-growth). Toggle for continued work.
// [sealed-multi-gen 2026-06-21] OFF: the seal is implemented + verified correct
// (6 gens, 0 traps, dedup/cap/teardown all work) and removes the cold-relink,
// but MEASURED net-negative — region hit% stays ~5% (coverage wall: ~570 of a
// far-larger working set promoted -> 94% miss), and dispatching a 5%-hit region
// FIRST (JitWasm.cpp:240) pays a wasted EM_ASM membrane crossing per miss. The
// binding constraint is promotion COVERAGE, not the cold-relink the seal fixed.
// Gate off to preserve the verified baseline; flip to 1 to resume coverage work.
// [region-ab 2026-07-13] A/B RE-RUN on the Party-Mode LOBBY (flat profile, the workload
// promotion targets — direct flip + full rebuild): promote ON = 13.3fps / jit=55-56ms vs
// OFF = 14.5fps / jit=51ms, same scene (draws=248 vs 247). NET-NEGATIVE (~-8%) — the
// coverage-wall verdict (~5% region hit -> per-miss membrane tax) holds on the lobby too,
// not just the cutscene. OFF stays the verified baseline; promotion needs the coverage
// redesign before it can win on any measured workload.
// [coverage-census 2026-07-15] MEASURED with counters TEMP-enabled (movie +
// board, 54s/240s probes): dynamic-entry coverage is CONCENTRATED — movie
// top-256 blocks = 94.4% of entries (top-512 97.8%, ~6.7k live blocks); board
// top-512 = 77.8% / top-1024 = 91.0% / top-2048 = 97.9% (~13.9k live). The old
// ~5%-hit wall was promotion SELECTION (chain-head signal / ~570 wrong blocks),
// NOT thin locality.
// [region-merged 2026-07-15] ON: counter-driven promotion into MERGED
// powerpc-next gens entered via the GLOBAL dispatch table (fn_k wrappers).
// A/B OFF arm = flip this back to 0 (the verified per-block baseline).
unsigned char g_bem_promote_enabled = 1;  // [PM54c A/B 2026-08-04] ON: N-fn shape
// with the audited fix set (gen-packed rslot + own-gen checks by construction,
// pending cap == seal_batch, seal-success-gated commit/populate, seal-time
// compaction). Acceptance: all sealed-gen n_funcs<=256, zero FAILED, zero
// traps, boot past the PM53e wedge, then page-fps vs the no-patch baselines
// (MP4 44.6, SAB 11.8-14.2). PM53e history (the pre-fix wedge):
// N-fn shape A/B WEDGED the guest (gc froze ~184 ticks post-boot, no fps,
// dataAddSampleReference spin at ~2900x, and gen 2 reported n_funcs=284 > the
// 256 batch cap = bookkeeping corruption): the N-fn dispatch path needs its
// own bring-up (registration/rtag wiring incomplete for the current topology)
// before it can be measured. Do not flip this ON in ANY shape without a
// dedicated bring-up leg. The PM53d merged-shape verdict below still stands:
// Step-1 (singles-in-regions: !merged lifted at ppc_emit.cpp:843 + the
// merged-context filler fix) ran ALL gens live (580 blocks, validate=true,
// zero traps, renders) under --no-liftoff — and still measured 34.4 gc/s vs
// 39.7 per-block baseline (IDCT 8.3x vs 7.3, MixAudio 9.5x). With step-0
// (-38%) and the 07-16 (-8%) results, three consistent measurements say the
// GIANT-FUNCTION br_table merged shape loses on V8 at this scale (the
// phi-merge microbench refutation didn't cover 152 locals x 580 arms), even
// TurboFan'd, even with singles arms. NEXT SHAPE (do not re-flip for merged):
// N-fn gens with intra-gen DIRECT return_call edges — the seal's re-emit pass
// knows every batch pc's module-local function index (rs.pc_to_idx), so chain
// exits targeting the batch can become direct calls (no table/signature tax),
// while small per-block functions keep V8's per-function optimization.
// Step-0 history:
// Regions-on A/B with the pipeline FIXED (sync seal + seal-cadence, below):
// 7 gens sealed/registered/ran (zero traps, renders) — the pipeline is proven
// under dual-core for the first time (the async .then NEVER fired on the
// non-yielding EmuThread; every post-07-22 region A/B silently measured
// per-block dispatch). But MEASURED: 24.6 gc/s vs 39.7 baseline, IDCT 7.3x ->
// 15.4x — merged bodies are Double-only; THP ps blocks lose the PM44/46/47
// singles arms inside regions and the structure win cannot offset it. Flip to
// 1 ONLY together with singles-in-regions (lift the !merged exclusion at
// ppc_emit.cpp:843 + MergedRegionCtx-aware entry guard) — that pairing is the
// measured path to the ~40%-of-thread per-entry prologue+call-tax prize.
// The full merged-region + residency machinery is LANDED and correct (zero traps/
// CompileErrors across ~150 sealed gens; conformance 3457/0) but scene-matched
// A/B (IDB save-state anchor) measured NEUTRAL — hypothesis: the 256-arm br_table
// loop-head phi-merge defeats V8 register allocation of the resident locals.
// Flip to 1 to re-test; see memory gc_60fps_roadmap_verified_2026_07_15.
// [xinst-fix] Runtime gate for the EXPENSIVE promote drain (re-emit + seal).
// Held OFF through boot's heavy block-discovery (where re-emit overhead stalls
// progress to a running state) and flipped ON by the dolphin-side drain once
// guest ticks pass a boot threshold — so the shared-instance region populates
// during steady-state running, where the cross-instance trampoline cost lives.
unsigned char g_bem_promote_active = 0;
}
static const int _bem_disp_cache_init = []() {
    for (unsigned i = 0; i < BEM_DISP_BUCKETS; ++i) {
        g_bem_disp_tag[i]  = 0xFFFFFFFFu;
        g_bem_disp_slot[i] = -1;
        g_bem_rtag[i]      = 0xFFFFFFFFu;
        g_bem_rslot[i]     = -1;
        g_bem_mrtag[i]     = 0xFFFFFFFFu;
        g_bem_mrslot[i]    = -1;
    }
    return 0;
}();

// ---- C-side in-WASM dispatch (membrane fix) -----------------------------
// EXACT guest-PC -> wasmTable-slot resolver (and its reverse for O(1) erase on
// eviction). The direct-mapped g_bem_disp_* cache above is lossy (collisions
// bail to the host) — safe for the in-WASM tail-chain miss path, but a C
// dispatch LOOP must resolve exactly or colliding hot blocks would thrash
// through TryCompileBlock. Populated by register_pc_handle, erased by
// release_raw, cleared by BlockCache::clear.
static std::unordered_map<uint32_t, int> g_bem_pc_handle;   // pc  -> handle(slot)
static std::unordered_map<int, uint32_t> g_bem_handle_pc;   // handle -> pc

// [single-spec PM26] Sticky per-pc force-double registry: a block whose
// single-valued prologue guard MISMATCHED at runtime deopts once (SAB cell
// 0x026B33E4 + downcount=0 + return start_pc); JitWasm::Run evicts + adds the
// pc here; the recompile queries bem_pc_force_double and emits WITHOUT the
// assumption. Sticky (never cleared) so speculation converges — a block whose
// live-in FPRs are genuinely double deopts exactly once.
static std::unordered_map<uint32_t, int> g_bem_force_double_map;
// [single-spec v4] retry budget: force-double only after 3 deopts of the same
// pc — a one-off mask flap (rare with the stable-reg restriction) recovers,
// a genuinely-flapping block still converges to double.
// [single-spec v8b PM44 2026-07-31] threshold 3 -> effectively-never: with
// volatile f0-f13 assumptions live, the audio ISR's interleaving flaps mask
// bits ~0.5/s and 3-strike PERMANENTLY force-doubled exactly the hot IDCT
// blocks (probe: deopt=41, ring all 800dexxx-800e0xxx, fps flat). The
// compile-time mask intersect already self-corrects each recompile (a
// genuinely-double live-in has its bit clear at recompile time and is not
// assumed), so unbounded deopt->recompile converges per-entry-state at
// ~0.5 recompiles/s — noise. Counter kept for the deopt-ring diagnostics.
extern "C" int bem_pc_force_double(uint32_t pc) {
    auto it = g_bem_force_double_map.find(pc);
    return (it != g_bem_force_double_map.end() && it->second >= 1000000) ? 1 : 0;
}
extern "C" void bem_pc_force_double_add(uint32_t pc) {
    g_bem_force_double_map[pc]++;
}
unsigned char g_bem_cdispatch_enabled = 1;  // C-loop vs legacy JS loop (A/B / fallback)

namespace bemental {

// Forward declaration for the guest emitter's merged-module builder.
// Defined in guests/powerpc/gekko_emit.cpp; declared here (rather than
// including gekko_emit.h) to keep block_cache.cpp guest-agnostic at the
// type level.
namespace powerpc {
    std::vector<u8> build_region_module(const u8* concatenated_bodies,
                                        std::size_t concatenated_size,
                                        u32 n_funcs,
                                        u32 mem_pages);

    // Forward-declared LocalIdxLookupFn must match the typedef in
    // guests/powerpc/gekko_emit.h. Kept here as a bare typedef so we don't
    // pull the whole guest header into block_cache.cpp.
    using LocalIdxLookupFn = bool(*)(const void* user, u32 target_pc, u32* out_local_idx);

    std::vector<u8> emit_block_body(u32 start_pc, const u32* insts, u32 count,
                                    u32 ctx_ptr_const,
                                    u32 mem1_base, u32 mem1_mask,
                                    u32 ram_size,
                                    const u32* instr_pcs,
                                    LocalIdxLookupFn lookup_fn,
                                    const void* lookup_user,
                                    bool emit_hle_check = true,
                                    bool emit_perf_stub = false,
                                    bool emit_hle_check_native = false);

    // Lever #2 — single-function merged-region build. See gekko_emit.h.
    struct BlockInputs {
        u32 start_pc;
        const u32* insts;
        u32 count;
        u32 ctx_ptr_const;
        u32 mem1_base;
        u32 mem1_mask;
        u32 ram_size;
        const u32* instr_pcs;
        bool emit_hle_check;
        bool emit_perf_stub = false;
        // Item 5 — match the BlockInputs in gekko_emit.h so the layout
        // is identical when this translation unit hands a BlockInputs
        // array to build_region_function.
        bool emit_hle_check_native = false;
        u32  block_cycles = 0;  // R2 — match gekko_emit.h BlockInputs layout
    };
    std::vector<u8> build_region_function(const BlockInputs* blocks,
                                          u32 n_blocks,
                                          LocalIdxLookupFn lookup_fn,
                                          const void* lookup_user,
                                          u32 mem_pages = 1);

    // [region-merged 2026-07-15] _next entry points provided UNCONDITIONALLY by
    // guests/powerpc-next/ppc_emit.cpp (the USE_REBUILD guards are gone — the
    // canonical build compiled the flag OFF, silently routing sealed regions
    // through the legacy gekko emitter). Declared here so block_cache.cpp stays
    // guest-agnostic at the include level. The merged builder + RegionBlockDesc
    // come from bementalJIT/region_desc.h (included at the top of this file).
    std::vector<u8> emit_block_body_next(u32 start_pc, const u32* insts, u32 count,
                                         u32 ctx_ptr_const,
                                         u32 mem1_base, u32 mem1_mask,
                                         u32 ram_size,
                                         const u32* instr_pcs,
                                         LocalIdxLookupFn lookup_fn,
                                         const void* lookup_user,
                                         bool emit_hle_check = true,
                                         bool emit_perf_stub = false,
                                         bool emit_hle_check_native = false,
                                         s32 region_gen_idx = -1);

    bool IsForwardConditionalBranch(u32 inst, u32 pc);
    bool IsSeamBackwardConditional(u32 inst);
    bool IsSeamInlineBl(u32 inst, u32 pc, u32 next_pc);
    bool IsPlainBlr(u32 inst);

    std::vector<u8> build_region_module_next(const u8* concatenated_bodies,
                                             std::size_t concatenated_size,
                                             u32 n_funcs,
                                             u32 mem_pages);
}

int compile_raw(const u8* bytes, std::size_t size) {
#ifdef __EMSCRIPTEN__
    const int ret = EM_ASM_INT({
        const view = new Uint8Array(Module.HEAPU8.buffer, $0, $1);
        const copy = new Uint8Array(view); // detach: HEAPU8 may grow
        try {
            const mod = new WebAssembly.Module(copy);

            // Resolve the host's WebAssembly.Memory so guest blocks can share
            // the heap. The runtime-local `wasmMemory` global is always
            // available; `Module.wasmMemory` is only set if the user opts
            // into exporting it via -sEXPORTED_RUNTIME_METHODS, and probing
            // it triggers an abort() in default builds.
            const memObj = (typeof wasmMemory !== 'undefined') ? wasmMemory : null;
            // Flycast-style lazy-thunk-resolve: on the very first compile,
            // call each Module._fn once with safe dummy args. The first
            // call replaces the JS arrow thunk with the raw WebAssembly.
            // Function reference, so subsequent direct binding (env.* =
            // Module._fn) gives the WASM block a WASM→WASM cross-module
            // call instead of WASM→JS→WASM. By compile time, runtime is
            // fully initialised and the dummy calls are safe.
            // Bootstrap: if bemental_imports isn't set up yet, do it now.
            // Under PROXY_TO_PTHREAD, JitWasm::Init's EM_ASM runs on
            // the worker-main wasm instance — pthread's Module never sees
            // those bindings. compile_raw runs on the pthread, so we
            // populate pthread's Module.bemental_imports here. Idempotent.
            if (!Module.bemental_imports_need_upgrade
                && (!Module.bemental_imports || !Module.bemental_imports.env
                    || !Module.bemental_imports.env.ppc_write16)) {
                if (typeof Module._dolphin_write16 === 'function') {
                    Module.bemental_imports_need_upgrade = true;
                    console.log('[bemental] bootstrap: pthread-side bemental_imports init');
                }
            }
            if (Module.bemental_imports_need_upgrade) {
                try {
                    Module._dolphin_read8(0);
                    Module._dolphin_read16(0);
                    Module._dolphin_read32(0);
                    Module._dolphin_write8(0, 0);
                    Module._dolphin_write16(0, 0);
                    Module._dolphin_write32(0, 0);
                    Module._dolphin_check_exc(0);
                    Module._dolphin_break_block(0, 0);
                    Module._dolphin_hle_check(0);
                    // Skip dolphin_interp(0,0) — it calls SingleStepInner
                    // which is not safe to invoke at random.
                    // Skip dolphin_hle_fire(0, 0) — it would actually
                    // execute an HLE handler at hook_index=0 which is the
                    // sentinel "unimplemented" PanicAlert.

                    // Lazy-init the imports container on the pthread side.
                    // The dolphin-bridge worker never publishes
                    // Module.bemental_imports up-front, so without this
                    // init the binding block below silently skips and
                    // every Instance() throws "ppc_read8 requires a
                    // callable" (2026-05-30 probe_fix.js with
                    // dolphin_jit_wimports.cpp present: upgrade fired,
                    // bindings never written, 100% compile-fail).
                    if (!Module.bemental_imports)
                        Module.bemental_imports = { env: {} };
                    if (!Module.bemental_imports.env)
                        Module.bemental_imports.env = {};
                    if (Module.bemental_imports && Module.bemental_imports.env) {
                        const e = Module.bemental_imports.env;
                        e.ppc_read8       = Module._dolphin_read8;
                        e.ppc_read16      = Module._dolphin_read16;
                        e.ppc_read32      = Module._dolphin_read32;
                        e.ppc_write8      = Module._dolphin_write8;
                        e.ppc_write16     = Module._dolphin_write16;
                        e.ppc_write32     = Module._dolphin_write32;
                        e.ppc_check_exc   = Module._dolphin_check_exc;
                        e.ppc_break_block = Module._dolphin_break_block;
                        e.ppc_hle_check   = Module._dolphin_hle_check;
                        // Item 5: direct-bind hle_fire for dolphin's own
                        // path (called when emit_hle_check_native is
                        // unused — module still declares the import).
                        if (Module._dolphin_hle_fire)
                            e.ppc_hle_fire = Module._dolphin_hle_fire;
                        // Researcher B's stack-corrupt diagnostic. Direct-bind
                        // if the export exists; without this, the env object
                        // built on the pthread-side bootstrap drops the import
                        // and wasm instantiation throws silently (caught at
                        // try/catch below) → ALL JIT BLOCKS fall back to interp.
                        // This is the root-cause class for any "I added a new
                        // WIMPORT and nothing fires" failure.
                        if (Module._dolphin_stack_corrupt)
                            e.ppc_stack_corrupt = Module._dolphin_stack_corrupt;
                        // Direct-bind ppc_interp now that dolphin_interp is
                        // exported by dolphin-bridge/dolphin_jit_wimports.cpp
                        // (2026-05-30). The previous "JS wrapper" comment
                        // referred to an older bridge where interp went
                        // through a thunk; the native C function takes
                        // (u32 unused, u32 pc) → void which matches the
                        // emitter's type-2 import signature.
                        if (Module._dolphin_interp)
                            e.ppc_interp = Module._dolphin_interp;
                        // ppc_msr_updated (WIMPORT idx 11) — added to fix the
                        // SAB DBException wedge. emit_mtmsr calls this after
                        // the MSR store so feature_flags/membase get
                        // recomputed (Jit64 parity via EmitUpdateMembase).
                        if (Module._dolphin_msr_updated)
                            e.ppc_msr_updated = Module._dolphin_msr_updated;
                        // ppc_gather_drain (WIMPORT idx 12) — block epilogue
                        // calls this to drain the GPU gather-pipe so CP-IRQ
                        // / PE_TOKEN / PE_FINISH fences fire (Jit64 parity
                        // via Cleanup + GPFifo::UpdateGatherPipe). Without
                        // this binding the emitted import resolves to
                        // undefined and EVERY block compile throws LinkError.
                        if (Module._dolphin_gather_drain)
                            e.ppc_gather_drain = Module._dolphin_gather_drain;
                    }
                    const isWasm = (typeof WebAssembly.Function !== 'undefined')
                        ? Module._dolphin_read32 instanceof WebAssembly.Function
                        : true;
                    console.log('[bemental] direct-binding upgrade complete (raw WASM funcs: ' + isWasm + ')');
                } catch (e) {
                    console.error('[bemental] direct-binding upgrade failed:', e && e.message);
                }
                Module.bemental_imports_need_upgrade = false;
            }
            // Start with { env: { memory: ..., ...user-provided } }
            // Consumers can populate Module.bemental_imports.env with host
            // functions (e.g. ppc_read8) before calling compile.
            const env = {};
            if (memObj) env.memory = memObj;
            if (Module.bemental_imports && Module.bemental_imports.env) {
                Object.assign(env, Module.bemental_imports.env);
            }
            // In-WASM block chaining: hand each per-block module the host's
            // shared __indirect_function_table (where every block's run() is
            // registered) so its epilogue can return_call_indirect a sibling.
            env.__indirect_function_table = wasmTable;
            const importObj = { env: env };

            const inst = new WebAssembly.Instance(mod, importObj);

            // Andy Wingo's JIT-in-WASM pattern: register the block's
            // exported run() function in the host's shared
            // __indirect_function_table (`wasmTable`) at a sequential
            // index. The C dispatcher then casts that index to a function
            // pointer and calls it — Emscripten compiles the call to
            // `call_indirect` inside the host WASM module, so dispatch
            // stays entirely in WASM (no JS round-trip per block).
            //
            // Use `wasmTable.set(idx, raw_wasm_func)` directly (Flycast
            // pattern, line 1622) instead of Module.addFunction, which
            // wraps the function in an extra JS thunk.
            if (!Module._bemental_table_base) {
                Module._bemental_table_base = wasmTable.length;
                Module._bemental_next_idx   = wasmTable.length;
                wasmTable.grow(8192);  // bulk pre-allocate
            }
            let idx = Module._bemental_next_idx;
            if (idx >= wasmTable.length) wasmTable.grow(4096);
            wasmTable.set(idx, inst.exports.run);
            Module._bemental_next_idx = idx + 1;

            // Keep the JS-side cache so we can release / debug.
            if (!Module.bemental_cache) Module.bemental_cache = {};
            Module.bemental_cache[idx] = inst;

            Module._bemental_compile_n = ((Module._bemental_compile_n|0) + 1) | 0;
            return idx;
        } catch (e) {
            if (typeof console !== 'undefined') {
                console.error('[bemental] compile_raw failed:', e, e && e.message, e && e.stack);
                const head = copy.subarray(0, Math.min(32, copy.length));
                const hex = Array.from(head).map(function(b) { return b.toString(16).padStart(2, '0'); }).join(' ');
                console.error('[bemental] size=' + copy.length + ' first 32 bytes:', hex);
            }
            return -1;
        }
    }, bytes, (int)size);
    return ret;
#else
    (void)bytes; (void)size;
    return -1;
#endif
}

// Block run() signature: () -> i32. As a C function pointer:
typedef u32 (*BemBlockFn)(void);

// Armed by the dolphin-bridge wake watcher; consumed here per dispatch.
int g_ax_wake_arm = 0;
// Re-check block watch (VIWaitForRetrace wake compare, 0x800C1544): the
// bridge logs the compare inputs whenever this block dispatches.
int g_recheck_handle = -1;
int g_vwaitset_handle = -1;
int g_ax_wake_ring[256];
int g_ax_wake_ring_n = 0;

// Diag hook installed by the dolphin bridge (null in standalone test
// links — tests have no bridge TU, so a hard extern breaks wasm-ld).
void (*g_block_watch_hook)(int phase) = nullptr;

// [pc-census 2026-06-12] temporary (strip per gate #8): hot-handle ring.
// Dispatch-context EM_ASM output (postMessage AND console.error) does not
// reach the probe (same constraint as the g_ax_wake_ring below) — so
// RECORD ONLY here; dolphin_gather_drain (dolphin_jit_wimports.cpp) drains
// + NOTICE_LOGs on the proven channel and resets the fill level, so each
// drained window is 256 consecutive dispatch handles.
int g_pc_census_ring[256];
int g_pc_census_n = 0;
u64 g_pc_census_total = 0;
// Chain block-transitions counter (JS-side increment, u32 wrap acceptable
// for rate reads between drains).
u32 g_chain_iters = 0;
// [gate-8] The pc-census + chain-iters counters are DIAGNOSTIC-ONLY (drained
// for [pc-census]/g_chain_iters NOTICE_LOGs in dolphin_jit_wimports.cpp). They
// rode along inside the hot bem_chain_loop_c iteration (a global RMW + bounds
// branch per dispatch), inflating the very bem_chain_loop_c self-time the CPU
// profile measures (25.4% on the clean baseline 2026-06-23). Compile-gated OFF
// so the dispatch loop carries zero diagnostic overhead; flip to 1 to re-arm
// the census tool for an investigation.
#ifndef BEM_DISPATCH_CENSUS
#define BEM_DISPATCH_CENSUS 0  // [PM51 census DONE: 99.66% chain hit-rate, 4.8M calls/s]
#endif

// [PM54c fix 2a] Single source of truth for the seal batch size: the drain's
// pending cap and region_should_relink's trigger must never desync (the old
// per-window promoted<256 cap let leftover pending stack to (256,511] —
// measured n_funcs=284 — overflowing the 16-bit slot pack's assumptions).
static u32 seal_batch() {
    static const u32 v = []() -> u32 {
        const char* e = std::getenv("BJIT_SEAL_BATCH");
        if (!e) return 256u;
        const u32 n = (u32)std::atoi(e);
        return n ? n : 1024u;
    }();
    return v;
}

// Hot-only merge (2026-06-17): per-handle dispatch counter + promotion queue.
// chain_dispatch_raw bumps g_disp_count[handle] each dispatch and, on the
// HOT_THRESHOLD crossing, pushes the pc onto g_promote_ring; BlockCache::
// chain_dispatch drains the ring into promote_hot (re-emit + accumulate into
// the hot merged region REGION_REL_0). Counts reset on cache clear (handles
// are reused). The JS literal 2048 in chain_dispatch_raw MUST match this.
static constexpr u32 HOT_THRESHOLD = 4u;
u32 g_disp_count[16384] = {0};   // indexed by cache handle (< MAX_CACHE_BLOCKS)
u32 g_promote_ring[256];
u32 g_promote_n = 0;

// [return-linking 2026-06-18] BLR return-address cache (RAS) for the merged
// region. The live gekko merged emit currently op_return()s on every blr/bctr
// (gekko_emit.cpp:2332-2361) — a host round-trip per function return that costs
// the measured 30-36x dispatch gap on call-heavy guest code (the PSO boot LZ
// decompressor: 2 bl/blr pairs per output byte). emit_at_bl pushes
// (ret_pc=bl_pc+4, ret_slot) when the return block resolves to a region slot;
// emit_at_blr pops and, on ret_pc==LR within the chain budget, tail-chains
// in-WASM to ret_slot (set entry_sel + br to the region loop) instead of
// returning to the host. Power-of-two ring: index = (sp & MASK); a leak from
// longjmp/exception simply makes a later pop mispredict -> safe op_return
// fallback. g_blr_chain bounds CONSECUTIVE in-WASM tail-chains so the host-side
// idle-skip streak detector still observes idle cycles (OSGetTick spins): force
// op_return every BLR_CHAIN_MAX. Reset: sp at cache-clear + region relink
// (slots are per-generation); chain at every region entry (host boundary).
// Plain u32 pairs so the gekko emitter can `extern` them without sharing a
// struct: entry i = g_blr_ras[2*i] (ret_pc), g_blr_ras[2*i+1] (ret_slot).
// 256 entries, power-of-two ring (index = sp & 255).
u32 g_blr_ras[256u * 2u] = {};
u32 g_blr_ras_sp = 0u;   // free-running; ring slot = sp & 255
u32 g_blr_chain  = 0u;   // consecutive in-WASM tail-chains since last host entry

s32 dispatch_raw(int handle) {
#if BEM_DISPATCH_CENSUS
    g_pc_census_total++;
    if (g_pc_census_n < 256) g_pc_census_ring[g_pc_census_n++] = handle;
#endif
    if (g_block_watch_hook) {
        if (handle == g_recheck_handle && g_recheck_handle >= 0) g_block_watch_hook(0);
        if (handle == g_vwaitset_handle && g_vwaitset_handle >= 0) g_block_watch_hook(1);
    }
    if (g_ax_wake_arm > 0) {
        --g_ax_wake_arm;
        // Push into the shared ring; the dolphin-bridge watcher drains it
        // via NOTICE_LOG (this TU has no fmt/Log.h include path, and
        // CPU-pthread console.error does not reach the probe's printed
        // buckets).
        if (g_ax_wake_ring_n < 256) g_ax_wake_ring[g_ax_wake_ring_n++] = handle;
    }
#ifdef __EMSCRIPTEN__
    if (handle <= 0) return 0;
    // We must call into JIT'd WASM with a JS-side try/catch because WASM
    // traps (e.g. unguarded i32.div_s/0, table OOB on a stale call_indirect
    // index) propagate as JS RuntimeError. A direct `fn()` from C++ would
    // unwind the entire pthread without recovery — caller's "trap recovery"
    // protocol expecting INT32_MIN never fires because nothing returns it.
    // The JS shim catches the trap, logs it once, and returns the sentinel.
    // Diagnostics stripped 2026-06-11 per gate #8 (pre-dispatch trace,
    // [ax-wake-traj], [wtraj] ring, [mp4-wedge-diag] per-dispatch PC
    // classification): the classification chain + map lookups ran on EVERY
    // dispatch and the console.error traffic flooded DevTools (2.5K+
    // "errors" in a browser session were instrumentation, not failures).
    // The bounded BLOCK TRAP log below is load-bearing (trap recovery) and
    // stays. History: see this file before commit <this one> / STATUS.md.
    return EM_ASM_INT({
        try {
            const f = wasmTable.get($0);
            if (!f) return -2147483648;  // freed slot
            return f() | 0;
        } catch (e) {
            if (Module.bemental_block_traps === undefined) Module.bemental_block_traps = 0;
            Module.bemental_block_traps++;
            if (Module.bemental_block_traps <= 16) {
                // Resolve guest PC from handle for fault localization. The
                // handle_to_pc map is populated by register_pc_handle at
                // compile time, so the PC here is the block START PC the
                // wasm "run" was dispatched for — same PC JitWasm.cpp:191
                // evicts on the INT32_MIN sentinel.
                const __pc = Module.bemental_handle_to_pc ? (Module.bemental_handle_to_pc[$0] >>> 0) : 0;
                const __msg = (e && e.message ? e.message : String(e));
                console.error('[bemental] BLOCK TRAP pc=0x' + __pc.toString(16)
                    + ' handle=' + $0
                    + ' #' + Module.bemental_block_traps
                    + ' msg="' + __msg + '"');
            }
            return -2147483648;  // INT32_MIN sentinel
        }
    }, handle);
#else
    (void)handle;
    return 0;
#endif
}

void release_raw(int handle) {
    // Exact-resolver erase (membrane-fix C dispatch loop). O(1) via the reverse
    // map; without this a freed slot stays resolvable and the C loop would
    // call_indirect a null table entry (trap).
    {
        auto rit = g_bem_handle_pc.find(handle);
        if (rit != g_bem_handle_pc.end()) {
            g_bem_pc_handle.erase(rit->second);
            g_bem_handle_pc.erase(rit);
        }
    }
#ifdef __EMSCRIPTEN__
    EM_ASM({
        // Clear the wasmTable slot — subsequent call_indirect on this
        // index will trap (which dispatch_raw catches via WASM trap →
        // JitWasm falls back to interpreter). We don't shrink the table
        // (Emscripten doesn't support shrinking).
        try { wasmTable.set($0, null); } catch (e) {}
        if (Module.bemental_cache && Module.bemental_cache[$0]) {
            Module.bemental_cache[$0] = null;
        }
        if (Module.bemental_pc_to_handle) {
            for (const [k, v] of Module.bemental_pc_to_handle) {
                if (v === $0) {
                    Module.bemental_pc_to_handle.delete(k);
                    // Invalidate this PC's in-WASM chaining dispatch-cache bucket
                    // so no sibling tail-calls the now-null slot (the source of
                    // the "null function" chain traps). $1=tag base, $2=slot
                    // base, $3=mask.
                    const bkt = (k >>> 2) & $3;
                    if ((HEAP32[($1 >> 2) + bkt] >>> 0) === (k >>> 0)) {
                        HEAP32[($1 >> 2) + bkt] = -1;  // tag = 0xFFFFFFFF
                        HEAP32[($2 >> 2) + bkt] = -1;  // slot = -1
                    }
                    break;
                }
            }
        }
    }, handle, (int)(uintptr_t)g_bem_disp_tag, (int)(uintptr_t)g_bem_disp_slot,
       (int)BEM_DISP_MASK);
#else
    (void)handle;
#endif
}

void register_pc_handle(u64 pc, int handle) {
    if ((u32)pc == 0x800C1544u) g_recheck_handle = handle;
    if ((u32)pc == 0x800059ECu) g_vwaitset_handle = handle;
    // Populate the in-WASM chaining dispatch cache (block START pc -> slot).
    {
        const u32 bkt = (((u32)pc) >> 2) & BEM_DISP_MASK;
        g_bem_disp_tag[bkt]  = (u32)pc;
        g_bem_disp_slot[bkt] = handle;
    }
    // Exact resolver for the C dispatch loop (membrane fix).
    g_bem_pc_handle[(uint32_t)pc] = handle;
    g_bem_handle_pc[handle]       = (uint32_t)pc;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        if (!Module.bemental_pc_to_handle) Module.bemental_pc_to_handle = new Map();
        Module.bemental_pc_to_handle.set($0 >>> 0, $1 | 0);
        // [wtraj] trajectory: inverse handle->pc so dispatch_raw can record the
        // executing block PC (native-granularity diff vs Jit64 [traj]).
        if (!Module.bemental_handle_to_pc) Module.bemental_handle_to_pc = {};
        Module.bemental_handle_to_pc[$1 | 0] = $0 >>> 0;

    }, static_cast<u32>(pc), handle);
#else
    (void)pc; (void)handle;
#endif
}

void unregister_pc(u64 pc) {
#ifdef __EMSCRIPTEN__
    EM_ASM({
        if (Module.bemental_pc_to_handle) {
            Module.bemental_pc_to_handle.delete($0 >>> 0);
        }
    }, static_cast<u32>(pc));
#else
    (void)pc;
#endif
}

// JS-side chain dispatch. Loops inside one EM_ASM call dispatching cached
// blocks via `Module.bemental_pc_to_handle.get(pc)`. Each block's return
// value becomes the next lookup key. Bails on cache miss, max_iters, trap,
// pending guest exceptions (*exceptions_addr != 0), or expired downcount
// (*downcount_addr <= 0 — blocks self-account cycles in their prologue as
// of 2026-06-12). Returns chain count; writes final pc + trap pc via
// pointer args.
#ifdef __EMSCRIPTEN__
// ---- Membrane fix: in-WASM C dispatch loop --------------------------------
// Runs cached blocks back-to-back via C call_indirect (a function-pointer cast
// of the wasmTable slot == handle — the Andy-Wingo JIT-in-WASM pattern emscripten
// lowers to call_indirect) instead of one EM_ASM `inst.exports.run()` JS-membrane
// crossing per block. Block bodies still tail-chain in-WASM (return_call_indirect);
// this handles chain heads + the cache-miss / exception / downcount bails. The C
// caller cannot catch WASM traps (a direct fn() unwinds the pthread), so
// chain_dispatch_raw invokes this through ONE EM_ASM try/catch per chain (not per
// block). Resolves pc->handle EXACTLY via g_bem_pc_handle — the lossy direct-mapped
// cache would thrash TryCompileBlock on collisions. Writes *final_pc before each
// call so the wrapper's catch can recover the trapping PC. Returns blocks run.
// [savestate-deadlock-fix PM61] a pending save/load, serviced ON THIS (CPU/Emu)
// thread so retro_(un)serialize's RunOnCPUThread runs inline (EmscriptenWorker.cpp).
// WEAK fallbacks so the standalone conformance test + ppc-worker builds (which
// don't link the dolphin bridge) resolve these. EmscriptenWorker.cpp provides
// the STRONG defs in the dolphin build (savestate service on the CPU/EmuThread),
// which override these weak ones; the test build gets op=0 (hook never fires).
extern "C" __attribute__((weak)) volatile int g_bem_state_op = 0;
extern "C" __attribute__((weak)) void bem_service_pending_state(void) {}

extern "C" EMSCRIPTEN_KEEPALIVE
s32 bem_chain_loop_c(u32 pc, u32 max, u32* final_pc, u32* trap_pc,
                     const u32* exc_addr, const s32* dc_addr) {
    typedef u32 (*BemBlockFnC)(void);
    *trap_pc = 0;
    // MSR sits 0xC bytes before Exceptions in PowerPCState (ppc_off MSR=0x2E0,
    // EXCEPTIONS=0x2EC) — used for the deliverability-based service-point bail
    // that mirrors emit_chain_or_return (ppc_emit.cpp): only return to the host
    // when CheckExceptions would actually act. The old `*exc_addr != exc0`
    // (snapshot-change) bail returned on a MASKED async IRQ (EE=0) that
    // CheckExternalExceptions cannot deliver — wasted round-trips that, on the
    // in-WASM tail-chain path, starved SAB's __fill_mem arena clear into a wedge.
    const u32* msr_addr = exc_addr ? reinterpret_cast<const u32*>(
        reinterpret_cast<const char*>(exc_addr) - 0xC) : nullptr;
    s32 count = 0;
    // [idle-collapse 2026-07-11] per-block busy-poll clock-jump state (see below).
    u32 idle_ring[32]; for (u32 i = 0; i < 32u; ++i) idle_ring[i] = 0;
    u32 idle_ri = 0, idle_streak = 0;
    while ((u32)count < max) {
        // [savestate-fix PM61] service a pending save/load HERE (CPU/Emu thread) so
        // retro_(un)serialize runs inline. Cheap volatile gate; the body only runs
        // when the message handler flagged a request.
        if (g_bem_state_op) {
            const int __sop = g_bem_state_op;
            bem_service_pending_state();
            if (__sop == 2) {
                // [savestate-fix PM61] a LOAD overwrote ppc_state.pc + regs + memory
                // (and cleared the block cache). This loop's local `pc` is STALE (the
                // pre-load PC). The unconditional `*final_pc = pc` at loop exit would
                // carry it, and JitWasm::Run writes final_pc back over the restored PC
                // (JitWasm.cpp:598) → the guest runs the pre-load scene. Re-sync `pc`
                // from the restored ppc_state.pc: exc_addr points into ppc_state at
                // EXCEPTIONS(0x2EC); PC is at ctx+0. Then the return carries the loaded
                // PC and the write-back is a no-op.
                if (exc_addr) pc = *reinterpret_cast<const u32*>(
                    reinterpret_cast<const char*>(exc_addr) - 0x2ECu);
                break;
            }
        }
        // [PM47 flag hygiene] the self-chain flag (0x026B38C0) is only valid
        // across a direct in-wasm self-tail-call. Any host-loop dispatch
        // breaks the hop: clear it, so a later revisit of the flagged pc
        // cannot fast-enter on scratch that intervening blocks overwrote.
        *(volatile u32*)(uintptr_t)0x026B38C0u = 0u;
#ifdef __EMSCRIPTEN__
        // [collapse] per-block ownership: bail the chain the instant the WORKER owns the CPU, alongside the
        // downcount/exception bails below. This is the mid-chain check the between-run_iter_batch flag could
        // never do — without it, dolphin's chain runs a long OS loop (OSLoadContext etc.) into the shared
        // ppc_state after ownership flips. cpu_owner @ SAB 0x026A0000: 0=DOLPHIN, 1=WORKER.
        if (*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026A0000u)) == 1u) break;
#endif
        if (exc_addr) {
            const u32 e  = *exc_addr;
            const u32 ee = msr_addr ? (*msr_addr & 0x8000u) : 0x8000u;
            // deliverable = (sync/non-maskable pending) OR (maskable pending AND MSR.EE)
            if ((e & 0x2FAu) || ((e & 0x105u) && ee)) break;
        }
        if (count > 0 && dc_addr && *dc_addr <= 0) break;    // CoreTiming slice budget spent
        // Resolve pc->handle. Fast path: the O(1) direct-mapped array (no hash).
        // Slow path (direct-mapped collision only — rare): the exact map.
        int handle;
        const u32 bkt = (pc >> 2) & BEM_DISP_MASK;
        if (g_bem_disp_tag[bkt] == pc) {
            handle = g_bem_disp_slot[bkt];
        } else {
            auto it = g_bem_pc_handle.find(pc);
            if (it == g_bem_pc_handle.end()) break;          // uncompiled -> host compiles
            handle = it->second;
        }
#if BEM_DISPATCH_CENSUS
        g_chain_iters = g_chain_iters + 1u;
        if (g_pc_census_n < 256) g_pc_census_ring[g_pc_census_n++] = (int)pc;
#endif
        // Phase A NOTE: chain-head promotion here was net-negative — the in-WASM
        // tail-chaining means hot loop bodies never pass through this C loop, so
        // counting chain heads promotes the wrong blocks (boot chain-starts, not
        // the hot path) and the region builds without dispatching (region_dispatch
        // = 0%, ticks 7.14B->6.83B). The correct promotion signal is per-block
        // execution count emitted in the BLOCK PROLOGUE (counts tail-chained
        // executions too) — the next Phase-A increment.
        *final_pc = pc;                                      // trap-recovery breadcrumb
        BemBlockFnC fn = (BemBlockFnC)(intptr_t)handle;
        pc = fn();                                           // in-WASM call_indirect
#ifdef __EMSCRIPTEN__
        // [vector-page guard 2026-07-09, INVARIANT-KEYED 2026-07-09-pm] mirror
        // emit_chain_or_return: chain INTO an exception vector (0 < pc < 0x4000) is
        // blocked ONLY when the carried MSR has IR set (0x20) — the crash invariant
        // (an rfi's 0x1030 output, IR=1, makes the vector fetch translate and fault,
        // ISI at 0x594). At IR=0 the vector is fetched physical (legit real-mode stub
        // execution) — allow it, so the stub advances instead of the worker re-
        // dispatching 0x500 forever (the over-fire that caused the 0x500 spin face).
        // Break so JitWasm::Run's delivery re-enters IR=1 vectors in real-mode.
        if (pc != 0u && pc < 0x4000u && msr_addr && (*msr_addr & 0x20u)) {
            *final_pc = pc; ++count; break;
        }
#endif
        ++count;
        // [idle-collapse 2026-07-11] Busy-poll clock-jump. Blocks that can't tail-chain
        // in-WASM (bl/blr through DVDGetDriveStatus, MMIO reads) return to THIS C loop per
        // block, so MP4's multi-block DVD-status poll grinds ~982 iters/chain to
        // downcount<=0 with a quasi-random final_pc the JitWasm outer ring can't match
        // (measured: idleSkip stays 0, ringMatch~39% but never 8 consecutive). Upstream
        // branchIsIdleLoop only flags SINGLE self-branch blocks so native doesn't idle-skip
        // this multi-block poll either — but native runs it at 486MHz; our JIT is ~10x
        // slower so grinding it IS the pre-takeover boot wedge. Detect the tight recurring
        // PC set HERE (per-block) and force downcount=0 so JitWasm::Run's CoreTiming::Advance
        // clock-jumps to the NEXT event (VI/DI); the DI-completion event sets the polled RAM
        // flag and the poll exits. Only the non-tail-chainable SLOW path uses this C loop
        // (hot compute loops tail-chain in-WASM, block_cache.cpp:654), so they're unaffected.
        // Bounded (jumps to the next event only) and gated on Exceptions==0 + a long streak so
        // real pending work / short forward chains are never skipped; count>64 skips the
        // per-block ring scan for normal short chains.
        if (count > 64 && dc_addr && (!exc_addr || *exc_addr == 0u)) {
            bool in_ring = false;
            for (u32 j = 0; j < 32u; ++j) { if (idle_ring[j] == pc) { in_ring = true; break; } }
            if (in_ring) {
                if (++idle_streak >= 96u) {
                    *const_cast<s32*>(dc_addr) = 0;   // clock-jump via the outer Advance
                    *final_pc = pc;
                    break;
                }
            } else {
                idle_streak = 0;
            }
            idle_ring[idle_ri & 31u] = pc;
            ++idle_ri;
        }
    }
    *final_pc = pc;
    return count;
}
#endif

s32 chain_dispatch_raw(u32 initial_pc, u32 max_iters, u32* final_pc, u32* trap_pc,
                       const u32* exceptions_addr, const s32* downcount_addr) {
    // Snapshot Exceptions for the in-WASM chaining bail check: each chained
    // block compares ctx.Exceptions to g_bem_chain_exc0 and returns to this JS
    // loop the moment a NEW (async IRQ) exception is posted — preserving the
    // per-block IRQ-delivery latency the JS loop's `exc0` check below gives.
    g_bem_chain_exc0 = exceptions_addr ? *exceptions_addr : 0u;
#ifdef __EMSCRIPTEN__
    // Membrane fix (default): run the dispatch loop in C with call_indirect,
    // guarded by ONE EM_ASM try/catch for WASM-trap recovery. g_bem_cdispatch_
    // enabled=0 falls back to the legacy per-block JS dispatch loop below.
    if (g_bem_cdispatch_enabled) {
        return EM_ASM_INT({
            try {
                return Module._bem_chain_loop_c($0, $1, $2, $3, $4, $5) | 0;
            } catch (e) {
                // A block trapped. bem_chain_loop_c wrote *final_pc ($2) before
                // the trapping call; surface it as trap_pc ($3) so JitWasm::Run
                // evicts + resumes the interpreter at that PC (same protocol as
                // the legacy loop's catch).
                if (Module.bemental_traps === undefined) Module.bemental_traps = 0;
                Module.bemental_traps++;
                if (Module.bemental_traps <= 16) {
                    console.error('[bemental] C-dispatch trap #' + Module.bemental_traps
                        + ' msg=' + (e && e.message ? e.message : String(e)));
                }
                HEAP32[$3 >> 2] = HEAP32[$2 >> 2] | 0;
                return 0;
            }
        }, initial_pc, max_iters, final_pc, trap_pc, exceptions_addr, downcount_addr);
    }
    return EM_ASM_INT({
        const map = Module.bemental_pc_to_handle;
        const cache = Module.bemental_cache;
        let pc = $0 >>> 0;
        const max = $1 >>> 0;
        const finalPcPtr = $2;
        const trapPcPtr = $3;
        const excPtr = $6 >> 2;
        const dcPtr = $7 >> 2;
        if (!map || !cache) {
            HEAP32[finalPcPtr >>> 2] = pc | 0;
            HEAP32[trapPcPtr >>> 2] = 0;
            return 0;
        }
        let count = 0;
        // Exception bail must be CHANGE-triggered, not nonzero-triggered:
        // during boot the guest often carries a masked-pending exception
        // (e.g. DEC raised while MSR.EE=0) for long stretches — the old
        // per-block loop called CheckExceptions (a no-op when masked) and
        // dispatched anyway. Bailing on nonzero froze dispatch into a
        // compile-retry loop (MP4 60s probe: gather_drain n=20,993 vs
        // baseline 10.2M). Only a NEW/changed Exceptions value needs the
        // C caller's CheckExceptions service.
        const exc0 = HEAP32[excPtr];
        // [pc-census 2026-06-12] temporary (strip per gate #8): record PCs
        // into the C ring ($4 = &g_pc_census_ring, $5 = &g_pc_census_n);
        // drained + printed by dolphin_gather_drain (output from this
        // context does not reach the probe).
        while (count < max) {
            // Service points the C caller owns: newly-raised exceptions and
            // the CoreTiming slice budget. HEAP32[excPtr] is u32 Exceptions;
            // HEAP32[dcPtr] is s32 downcount (signed compare intended).
            if (HEAP32[excPtr] !== exc0) break;
            if (count > 0 && HEAP32[dcPtr] <= 0) break;
            const handle = map.get(pc);
            if (handle === undefined) break;
            const inst = cache[handle];
            if (!inst || !inst.exports || typeof inst.exports.run !== 'function') break;
            // Hot-only merge: per-handle dispatch counter; on the HOT_THRESHOLD
            // (2048 — must match the C-side HOT_THRESHOLD) crossing, queue this
            // pc for promotion into the merged hot region (drained C-side in
            // BlockCache::chain_dispatch).
            // L2-revival fix (2026-06-19): `handle` is the MONOTONIC wasmTable
            // index (_bemental_next_idx, starts at _bemental_table_base, never
            // reset), so late-compiled blocks (the audio/gameplay hot cluster)
            // get handle >= 16384 and were silently excluded from promotion
            // counting — they could never cross HOT_THRESHOLD or enter the
            // merged region. Index the 16384-entry counter by the table-base-
            // relative slot (& 16383) so EVERY block can promote. Aliasing only
            // begins after 16384 distinct JIT blocks (vs the old bug excluding
            // everything past table_base+16384).
            {
                const slot = ((handle - (Module._bemental_table_base | 0)) & 16383);
                const di = ($9 >> 2) + slot;
                const dc = (HEAP32[di] + 1) | 0;
                HEAP32[di] = dc;
                if (dc === 2048) {
                    const pn = HEAP32[$11 >> 2];
                    if (pn < 256) { HEAP32[($10 >> 2) + pn] = pc | 0; HEAP32[$11 >> 2] = pn + 1; }
                }
            }
            {
                HEAP32[$8 >> 2] = (HEAP32[$8 >> 2] + 1) | 0;
                const czn = HEAP32[$5 >> 2];
                if (czn < 256) {
                    HEAP32[($4 >> 2) + czn] = pc | 0;
                    HEAP32[$5 >> 2] = czn + 1;
                }
            }
            try {
                pc = inst.exports.run() >>> 0;
            } catch (e) {
                if (Module.bemental_traps === undefined) Module.bemental_traps = 0;
                Module.bemental_traps++;
                if (Module.bemental_traps <= 16) {
                    console.error('[bemental] chain trap #' + Module.bemental_traps
                        + ' iter=' + count + ' handle=' + handle
                        + ' msg=' + (e && e.message ? e.message : String(e)));
                }
                // pc is unchanged when run() throws (assignment doesn't fire),
                // so it still holds the start_pc of the trapped block.
                HEAP32[finalPcPtr >>> 2] = pc | 0;
                HEAP32[trapPcPtr >>> 2] = pc | 0;
                return count;
            }
            count++;
        }
        HEAP32[finalPcPtr >>> 2] = pc | 0;
        HEAP32[trapPcPtr >>> 2] = 0;
        return count;
    }, initial_pc, max_iters, final_pc, trap_pc, g_pc_census_ring, &g_pc_census_n,
       exceptions_addr, downcount_addr, &g_chain_iters,
       g_disp_count, g_promote_ring, &g_promote_n);
#else
    (void)initial_pc; (void)max_iters; (void)exceptions_addr; (void)downcount_addr;
    if (final_pc) *final_pc = initial_pc;
    if (trap_pc) *trap_pc = 0;
    return 0;
#endif
}

int BlockCache::compile(u64 key, const u8* bytes, std::size_t size) {
    // Bound the cache to prevent OOM when the guest emits a flood of unique
    // blocks (e.g. JIT'ing garbage virtual addresses with MMU off — each one
    // compiles a fresh module). Wipe everything past the cap; hot blocks
    // recompile lazily on the next dispatch.
    //
    // Each entry pins a WebAssembly.Instance plus its compiled code object, so
    // 4096 was already pushing the tab. 1024 gives much earlier pressure
    // relief; hot inner loops still fit and recompile cheaply on miss.
    static constexpr std::size_t MAX_CACHE_BLOCKS = 16384;
    if (m_map.size() >= MAX_CACHE_BLOCKS) {
#ifdef __EMSCRIPTEN__
        EM_ASM({
            console.log('[bemental] cache evicted at cap (', $0, ')');
        }, (int)m_map.size());
#endif
        clear();
    }
    int handle = compile_raw(bytes, size);
    if (handle < 0) return -1;

    auto it = m_map.find(key);
    if (it != m_map.end()) {
        release_raw(it->second);
        it->second = handle;
    } else {
        m_map.emplace(key, handle);
    }
    register_pc_handle(key, handle);
    return handle;
}

int BlockCache::lookup(u64 key) const {
    auto it = m_map.find(key);
    return it == m_map.end() ? -1 : it->second;
}

bool BlockCache::dispatch(u64 key) {
    auto it = m_map.find(key);
    if (it == m_map.end()) return false;
    (void)dispatch_raw(it->second);
    return true;
}

bool BlockCache::dispatch(u64 key, s32* out) {
    auto it = m_map.find(key);
    if (it == m_map.end()) return false;
    s32 r = dispatch_raw(it->second);
    if (r == INT32_MIN) {
        // WASM trap — evict the block so we recompile fresh next time (in
        // case the trap was caused by stale-state / re-entry, not a real
        // bug). Return false; JitWasm::Run() falls back to SingleStepInner
        // for one instruction, which advances pc past the trapping op.
#ifdef __EMSCRIPTEN__
        EM_ASM({
            if (Module.bemental_block_traps === undefined) Module.bemental_block_traps = 0;
            Module.bemental_block_traps++;
            if (Module.bemental_block_traps <= 16) {
                console.error('[bemental] block trap key=0x'
                    + ($0>>>0).toString(16) + ' handle=' + $1
                    + ' (#' + Module.bemental_block_traps + ')');
            }
        }, static_cast<u32>(key), it->second);
#endif
        release_raw(it->second);
        m_map.erase(it);
        return false;
    }

    if (out) *out = r;
    return true;
}

// [C4 2026-07-12 oracle-audit] JS-side per-PC seal teardown — the eviction
// analog of clear()'s en-masse sealed-gen wipe (block_cache.cpp:1000-1019).
// Drops the single PC from Module.bemental_pc2gen (so region_dispatch's JS
// map.get(pc) misses) and clears its GLOBAL dispatch-cache bucket
// (g_bem_disp_tag/slot) + REGION-local bucket (g_bem_rtag/rslot) IF they still
// tag this PC — otherwise a C-loop resolve or an in-WASM tail-chain would route
// the freed PC into the now-stale sealed region fn. Does NOT touch
// Module.bemental_gens (the immutable gen instance is shared by its other PCs)
// nor m_sealed_gen_count — matching the "single PC" scope. Idempotent; a no-op
// when the PC was never promoted/sealed (buckets tag-mismatch, map has no key).
static void unseal_pc_js(u32 pc) {
#ifdef __EMSCRIPTEN__
    EM_ASM({
        const pc = $0 >>> 0;
        if (Module.bemental_pc2gen) Module.bemental_pc2gen.delete(pc);
        // Global dispatch cache ($1=tag base, $2=slot base, $3=mask): only clear
        // the bucket if it currently tags THIS pc (a collision victim tags a
        // different pc — leave it).
        const bkt = (pc >>> 2) & ($3 >>> 0);
        if ((HEAPU32[($1 >>> 2) + bkt] >>> 0) === pc) {
            HEAP32[($1 >>> 2) + bkt] = -1;   // tag = 0xFFFFFFFF (empty)
            HEAP32[($2 >>> 2) + bkt] = -1;   // slot = -1
        }
        // Region-local dispatch cache ($4=rtag base, $5=rslot base): same guard.
        if ((HEAPU32[($4 >>> 2) + bkt] >>> 0) === pc) {
            HEAP32[($4 >>> 2) + bkt] = -1;
            HEAP32[($5 >>> 2) + bkt] = -1;
        }
    }, pc,
       (int)(uintptr_t)&g_bem_disp_tag[0], (int)(uintptr_t)&g_bem_disp_slot[0],
       (int)BEM_DISP_MASK,
       (int)(uintptr_t)&g_bem_rtag[0], (int)(uintptr_t)&g_bem_rslot[0]);
#else
    (void)pc;
#endif
}

void BlockCache::evict(u64 key) {
    auto it = m_map.find(key);
    if (it == m_map.end()) return;
    release_raw(it->second);
    m_map.erase(it);
    // [C4 2026-07-12 oracle-audit] Also drop this PC from the sealed-region
    // state. WITHOUT this, region_dispatch (gated on m_sealed_pcs, run BEFORE
    // chain_dispatch at JitWasm.cpp) keeps running the STALE sealed body for a
    // targeted icbi/dcbf of a promoted PC, so the recompiled block never runs.
    // Erasing from m_sealed_pcs makes region_dispatch (block_cache.cpp:1850)
    // miss and fall through to chain_dispatch -> the freshly compiled block.
    // m_pending_emit drop prevents a stale promote_hot re-seal. Keeps
    // m_sealed_gen_count intact so region_dispatch's cold-window early-out
    // (block_cache.cpp:1849) is unaffected for the PCs still sealed.
    const u32 pc = static_cast<u32>(key);
    m_sealed_pcs.erase(pc);
    m_pending_emit.erase(pc);
    // [region-merged 2026-07-15] Clear the merged-gen probe bucket (tag-guard)
    // so no sealed body warm-edges into the evicted PC's stale arm. Runtime-
    // resolved edges make per-PC eviction SUFFICIENT for merged gens (no baked
    // edges — the gekko baked-edge eviction hole does not apply).
    {
        const u32 bkt = (pc >> 2) & BEM_DISP_MASK;
        if (g_bem_mrtag[bkt] == pc) { g_bem_mrtag[bkt] = 0xFFFFFFFFu; g_bem_mrslot[bkt] = -1; }
    }
    unseal_pc_js(pc);
    // [PM54f SMC fix 2026-08-07] If pc was fused into predecessor(s) by run-
    // fusion, evict them too: their compiled body embeds pc's now-stale
    // instructions and their own guest-end range does not cover pc, so this
    // targeted evict/icbi would otherwise leave the stale splice live. Move-out +
    // erase before recursing so the (fusion-depth-bounded) recursion cannot
    // observe a half-updated map; self-guard against a degenerate pred==pc.
    {
        auto fit = m_fused_succ_to_pred.find(pc);
        if (fit != m_fused_succ_to_pred.end()) {
            std::vector<u32> preds = std::move(fit->second);
            m_fused_succ_to_pred.erase(fit);
            for (u32 p : preds) if (p != pc) evict(static_cast<u64>(p));
        }
    }
}

void BlockCache::clear() {
    // Hot-only merge: reset per-handle dispatch counts (handles get reused).
    for (std::size_t i = 0; i < 16384; ++i) g_disp_count[i] = 0;
    g_promote_n = 0;
    g_blr_ras_sp = 0u;   // [return-linking] handles/slots reused after clear
    g_blr_chain  = 0u;
    for (const auto& kv : m_map) release_raw(kv.second);
    m_map.clear();
    // Invalidate the in-WASM chaining dispatch cache: slots just got released,
    // so every stale entry would tail-call a trapped slot until recompile.
    // [region-merged 2026-07-15] ALSO wipe both region probe pairs — clear()
    // previously left rtag/rslot stale (evict-map gotcha 4: clear-then-reseal
    // could dispatch the WRONG block via a stale internal-slot mapping).
    for (unsigned i = 0; i < BEM_DISP_BUCKETS; ++i) {
        g_bem_disp_tag[i]  = 0xFFFFFFFFu;
        g_bem_disp_slot[i] = -1;
        g_bem_rtag[i]      = 0xFFFFFFFFu;
        g_bem_rslot[i]     = -1;
        g_bem_mrtag[i]     = 0xFFFFFFFFu;
        g_bem_mrslot[i]    = -1;
    }
    // Exact resolver (membrane-fix C dispatch loop) — release_raw above already
    // erased per-handle, but clear defensively in case of any drift.
    g_bem_pc_handle.clear();
    g_bem_handle_pc.clear();
    // Reset the merged hot region(s). WITHOUT this, a state load (which calls
    // ClearCache via JitInterface::DoState in read mode) wipes m_map but leaves
    // REGION_REL_0 holding the STALE pre-load block bodies (e.g. the boot
    // decompressor at 0x806cxxxx). region_dispatch (gated on module_handle>=0,
    // block_cache.cpp:1229) then keeps running those stale bodies, so the guest
    // executes pre-load code regardless of the loaded scene — every loaded
    // savestate landed in the same 0x806c7xxx loop. Setting module_handle=-1
    // disables region_dispatch immediately; clearing the accumulation state lets
    // the region rebuild cleanly from post-load blocks. (2026-06-20)
    for (u32 ri = 0; ri < REGION_COUNT; ++ri) {
        RegionState& rs = m_regions[ri];
        rs.fn_bodies_concat.clear();
        rs.n_funcs                 = 0u;
        rs.pc_keys.clear();
        rs.pc_to_idx.clear();
        rs.block_records.clear();
        rs.blocks_since_link       = 0u;
        rs.last_accum_ms           = 0.0;
        rs.module_handle           = -1;
        rs.generation              = 0;
        rs.last_relink_ms          = 0.0;
        rs.dispatches_since_relink = 0u;
    }
    // [sealed-multi-gen 2026-06-21] Tear down the sealed-generation state too —
    // WITHOUT this, a savestate load (clear() via JitInterface::DoState) wipes
    // m_map + the pending region but leaves the sealed gens + global pc2gen map
    // holding STALE pre-load block bodies; region_dispatch would keep running
    // pre-load code post-load (the exact corruption class the per-region reset
    // above was added for on 2026-06-20).
    m_sealed_pcs.clear();
    m_sealed_gen_count = 0u;
    m_region_has_sealed = false;
    m_fused_succ_to_pred.clear();   // [PM54f] fusion mappings die with the gens
#ifdef __EMSCRIPTEN__
    EM_ASM({
        if (Module.bemental_pc_to_handle) Module.bemental_pc_to_handle.clear();
        if (Module.bemental_regions) {
            for (const k in Module.bemental_regions) {
                const rg = Module.bemental_regions[k];
                if (rg && rg.pcMap) rg.pcMap.clear();
            }
        }
        // Drop sealed-gen instances + the global dispatch map so post-load PCs
        // can't dispatch into freed/pre-load generation bodies.
        if (Module.bemental_gens) {
            for (let i = 0; i < Module.bemental_gens.length; i++) {
                if (Module.bemental_gens[i]) Module.bemental_gens[i].instance = null;
            }
            Module.bemental_gens = [];
        }
        if (Module.bemental_pc2gen) Module.bemental_pc2gen.clear();
    });
#endif
}

void BlockCache::invalidate_overlap(u32 addr, u32 max_block_bytes) {
    // Iterate all cached blocks; remove any whose [start_pc, start_pc +
    // max_block_bytes) range contains addr. We don't track per-block sizes,
    // so use max_block_bytes (default 256B = 64 instructions) as the upper
    // bound on block length. Over-eviction is correctness-safe: blocks just
    // recompile on next dispatch.
    std::vector<u32> fused_preds;   // [PM54f] predecessors to evict after the loop
    for (auto it = m_map.begin(); it != m_map.end(); ) {
        const u32 start_pc = static_cast<u32>(it->first);
        if (addr >= start_pc && addr < start_pc + max_block_bytes) {
            release_raw(it->second);
            it = m_map.erase(it);
            // [C4 2026-07-12 oracle-audit] Mirror evict()'s sealed-region clear
            // on the SMC/icbi-overlap path too: without it a promoted PC in this
            // overlap window keeps its stale sealed body live in region_dispatch
            // (gated on m_sealed_pcs, run BEFORE chain_dispatch), so the
            // recompiled block never runs after a self-modifying write.
            m_sealed_pcs.erase(start_pc);
            m_pending_emit.erase(start_pc);
            {   // [region-merged] merged-gen probe bucket too (tag-guard)
                const u32 bkt = (start_pc >> 2) & BEM_DISP_MASK;
                if (g_bem_mrtag[bkt] == start_pc) { g_bem_mrtag[bkt] = 0xFFFFFFFFu; g_bem_mrslot[bkt] = -1; }
            }
            unseal_pc_js(start_pc);
            // [PM54f SMC fix 2026-08-07] collect any predecessors that fused this
            // successor; evict them AFTER the m_map iteration so evict()'s own
            // m_map mutation can't invalidate this iterator.
            auto fit = m_fused_succ_to_pred.find(start_pc);
            if (fit != m_fused_succ_to_pred.end()) {
                fused_preds.insert(fused_preds.end(), fit->second.begin(), fit->second.end());
                m_fused_succ_to_pred.erase(fit);
            }
        } else {
            ++it;
        }
    }
    // [PM54f SMC fix] Evict the fused predecessors now that iteration is done
    // (evict() safely mutates m_map and recurses for chained fusions).
    for (u32 p : fused_preds) evict(static_cast<u64>(p));
}

s32 BlockCache::chain_dispatch(u32 initial_pc, u32 max_iters, u32* final_pc, u32* trap_pc,
                               const u32* exceptions_addr, const s32* downcount_addr) {
    u32 fpc = initial_pc;
    u32 tpc = 0;
    s32 count = chain_dispatch_raw(initial_pc, max_iters, &fpc, &tpc,
                                   exceptions_addr, downcount_addr);
    // Hot-only merge: drain blocks that crossed the dispatch threshold this
    // slice into the hot merged region (re-emit + accumulate), then relink the
    // hot region into one merged wasm function once enough have accumulated.
    // region_should_relink's tiered thresholds + tier-up grace gate keep this
    // from rebuilding on every call. NOT dispatched yet (step 4).
    // [xinst-fix] Only run the expensive promote drain (re-emit + seal) once
    // past boot — see g_bem_promote_active. During boot it stays OFF so block
    // discovery isn't taxed; the prologue still cheaply fills the ring, which we
    // simply discard until the gate opens.
    // [region-merged 2026-07-15] Promotion signal = the BLOCK-PROLOGUE exec
    // counters ONLY (every 16th execution pushes; counts in-WASM tail-chained
    // entries). The chain-head g_promote_ring drain is DELETED — it was the
    // proven-wrong selector (~570 wrong blocks -> the historic ~5% region hit;
    // the 2026-07-15 census measured the true concentration: board top-1024
    // blocks = 91% of dynamic entries). Gen-capacity gate (adversarial-verify
    // wf_0ce30bf7): at the MAX_GENS cap, region_seal early-returns leaving the
    // pending batch stranded while every window promotes 256 fresh pcs — pure
    // churn. Skip promotion entirely at cap.
    if (g_bem_promote_active) {
        static const u32 s_max_gens = []() -> u32 {
            const char* e = std::getenv("BJIT_MAX_GENS");
            if (!e) return 24u;                      // default: 24 gens x 256 = 6144 PCs
                                                     // (boot+movie consumed 8 gens in 60s;
                                                     // the BOARD's hot set needs its own slots)
            const unsigned long v = std::strtoul(e, nullptr, 10);
            return v == 0ul ? 48u : (u32)v;
        }();
        if (m_sealed_gen_count < s_max_gens) {
            // [top-k window 2026-07-15] The ring is a SAMPLER, not the selector.
            // Ring-arrival promotion flooded gens with every >=16-exec block in
            // whatever order boot/scene produced them (measured: the -25%
            // aggregate regression; delaying activation recovered to -6% but
            // gens still filled arrival-order). Accumulate samples into a
            // histogram; once a settle window has elapsed, promote the TOP
            // SEAL_BATCH blocks by execution count — gens then hold PROVEN-hot
            // steady-state blocks (census: board top-1024 = 91% of entries).
            static std::unordered_map<u32, u32> s_hit_hist;
            static u32 s_hist_samples = 0u;
            const u32 n = (g_bem_promote_n < 256u) ? g_bem_promote_n : 256u;
            for (u32 i = 0; i < n; ++i)
                s_hit_hist[g_bem_promote_ring[i]] += 16u;   // each push = 16 execs
            s_hist_samples += n;
            constexpr u32 kWindowSamples = 65536u;          // ~1M block executions
            if (s_hist_samples >= kWindowSamples) {
                std::vector<std::pair<u32, u32>> rank(s_hit_hist.begin(),
                                                      s_hit_hist.end());
                const std::size_t topn =
                    rank.size() < (std::size_t)256u ? rank.size() : (std::size_t)256u;
                std::partial_sort(rank.begin(), rank.begin() + topn, rank.end(),
                                  [](const std::pair<u32, u32>& a,
                                     const std::pair<u32, u32>& b) {
                                      return a.second > b.second;
                                  });
                u32 promoted = 0u;
                // [PM54c fix 2a] cap the PENDING TOTAL, not per-window adds:
                // invariant n_funcs <= seal_batch() at all times.
                for (std::size_t i = 0;
                     i < topn && m_regions[REGION_REL_0].n_funcs < seal_batch(); ++i) {
                    const u32 before = m_regions[REGION_REL_0].n_funcs;
                    promote_hot(rank[i].first);   // dedups sealed/pending internally
                    if (m_regions[REGION_REL_0].n_funcs != before) ++promoted;
                }
                s_hit_hist.clear();
                s_hist_samples = 0u;
                if (region_should_relink(REGION_REL_0)) {
                    region_relink(REGION_REL_0, /*mem_pages=*/1u);
                } else if (promoted <= 4u && m_regions[REGION_REL_0].n_funcs >= 64u) {
                    // Scene stable: seal a SUBSTANTIAL partial batch rather
                    // than stranding it below the 256 trigger. Batches under
                    // 64 stay pending — ON5 measured the unconditional
                    // force-seal fragmenting the 24-gen capacity into
                    // 1-3-block gens, wasting slots + compiles on marginal
                    // blocks. [PM53c] promoted==0 was a CADENCE DEADLOCK:
                    // per-window histogram jitter trickles >=1 marginal new
                    // block every window (measured: pending 244->245->246,
                    // never sealing), so tolerate a small trickle instead of
                    // requiring perfect quiescence.
                    region_relink(REGION_REL_0, /*mem_pages=*/1u);
                }
            }
        }
    }
    g_promote_n = 0;
    g_bem_promote_n = 0;
    if (tpc != 0u) {
        // Evict the trapped block from the C++ map. release_raw inside
        // chain_dispatch_raw does not run for the trapped block (the chain
        // exits with the trapped handle still in cache), so do it here.
        auto it = m_map.find(tpc);
        if (it != m_map.end()) {
            release_raw(it->second);
            m_map.erase(it);
        }
        // [region-merged 2026-07-15] The trap path previously skipped ALL
        // sealed cleanup (adversarial map: a trapped sealed pc stayed sealed
        // and kept being re-entered). Mirror evict()'s sealed clear.
        m_sealed_pcs.erase(tpc);
        m_pending_emit.erase(tpc);
        {
            const u32 bkt = (tpc >> 2) & BEM_DISP_MASK;
            if (g_bem_mrtag[bkt] == tpc) { g_bem_mrtag[bkt] = 0xFFFFFFFFu; g_bem_mrslot[bkt] = -1; }
        }
        unseal_pc_js(tpc);
    }
    if (final_pc) *final_pc = fpc;
    if (trap_pc) *trap_pc = tpc;
    return count;
}

// ---------------------------------------------------------------------------
// Multi-module region API (Phase 2). See block_cache.h for the design notes
// (internal table per module, V8 inlining invariant, partition source).
// ---------------------------------------------------------------------------

Region classify(u32 pc) {
    // MAIN_LOW upper bound covers both PSO (main DOL ends ~0x80046800)
    // and SAB (main DOL ends ~0x801de1e0). Single 0x80200000 bound serves
    // both games — see multi_module_partition_2026_05_03.md.
    if (pc >= 0x80000000u && pc < 0x80200000u)         return REGION_MAIN_LOW;
    if (pc >= 0x817e0000u && pc < 0x81800000u)         return REGION_HIGH_LOADER;
    // Phase 5 will populate REL_n via lookup_rel_for_pc.
    return REGION_JIT_RUNTIME;
}

// Monotonic millisecond clock. Uses emscripten_get_now() under emcc (returns
// double ms with sub-ms resolution) and a fallback otherwise so the host
// build still compiles without -DBUILD_FOR_BROWSER.
static double now_ms() {
#ifdef __EMSCRIPTEN__
    return emscripten_get_now();
#else
    return 0.0;
#endif
}

void BlockCache::region_accumulate(Region r, u32 pc,
                                   const u8* body_bytes, std::size_t body_size,
                                   const BlockEmitInputs* inputs) {
    if (r >= REGION_COUNT) return;
    // [region-merged 2026-07-15] RECORD-ONLY accumulation is allowed (empty
    // body + non-null inputs): promote_hot no longer emits at promote time —
    // the seal emits every body itself (merged from records; N-fn via the
    // re-emit pass, which clears+rebuilds fn_bodies_concat). Reject only the
    // legacy shape (no body AND no record — nothing to seal from).
    if ((body_bytes == nullptr || body_size == 0) && inputs == nullptr) return;
    RegionState& rs = m_regions[r];

    // Dedup: if this pc is already accumulated, skip. The first emission
    // is canonical for the region's current generation. region_relink
    // re-emits each block with the up-to-date pc_to_idx map so first-emit
    // unresolved branches get rewritten on relink without us having to
    // re-accumulate.
    if (rs.pc_to_idx.find(pc) != rs.pc_to_idx.end()) return;

    // Append the body verbatim. body_bytes is in code-section function-entry
    // format (5-byte LEB128 size prefix + locals + ops + 0x0B end), as
    // produced by WasmModuleBuilder. The merged-module emitter concats
    // these directly into its code section.
    const u32 local_idx = rs.n_funcs;
    if (body_bytes != nullptr && body_size != 0)
        rs.fn_bodies_concat.insert(rs.fn_bodies_concat.end(),
                                   body_bytes, body_bytes + body_size);
    rs.pc_keys.push_back(pc);
    rs.pc_to_idx.emplace(pc, local_idx);
    // Save emit inputs for re-emit at relink. Only if the caller provided
    // them — legacy callers without re-emit support pass null.
    if (inputs != nullptr) {
        rs.block_records.push_back(*inputs);
    } else {
        rs.block_records.emplace_back();  // placeholder; relink falls back to concat
    }
    rs.n_funcs           += 1u;
    rs.blocks_since_link += 1u;
    rs.last_accum_ms      = now_ms();

#ifdef __EMSCRIPTEN__
    // Diagnostic uses [worker] prefix so the probe puts it in the
    // worker bucket (displayed in full); generic [bemental] strings land
    // in the "other" bucket which is truncated to last 15 lines.
#endif
}

// Hot-only merge: stash emit inputs at compile (no body emitted yet).
void BlockCache::stash_block(u32 pc, const BlockEmitInputs& in) {
    m_pending_emit[pc] = in;
}

// Promote a hot block into the merged hot region (REGION_REL_0). Re-emits the
// body from stashed inputs and accumulates it; region_relink (driven by
// region_should_relink) later merges the hot region into one wasm function
// with internal br_table dispatch. First-emit branches are unresolved
// (lookup_fn=null) — region_relink re-emits with the complete pc_to_idx map.
void BlockCache::promote_hot(u32 pc) {
    // [sealed-multi-gen] Dedup across ALL sealed gens: pc_to_idx (checked by
    // region_has_pc) only holds the CURRENT pending batch, so without this a pc
    // sealed in a prior gen would re-promote into the next batch -> duplicate
    // body in two gens. m_sealed_pcs is the cumulative seal set.
    if (m_sealed_pcs.find(pc) != m_sealed_pcs.end()) return;
    if (region_has_pc(REGION_REL_0, pc)) return;            // already pending
    auto it = m_pending_emit.find(pc);
    if (it == m_pending_emit.end()) return;
    // [PM54c fix 2c] an empty-insts record must never enter the batch: it
    // would flip have_records=false at seal, the builder returns empty bytes,
    // and the whole batch strands (overflow PATH B).
    if (it->second.insts.empty()) return;
    const BlockEmitInputs& in = it->second;
    // [region-merged 2026-07-15] NO body emission at promote time: the seal's
    // own pass emits every body (merged builder from records; N-fn via the
    // emit_block_body_next re-emit loop). The old per-promote emission (gekko
    // under the OFF flag — the staleness bug) was pure wasted work: the seal
    // re-emit ALWAYS rebuilt fn_bodies_concat when records were complete.
    // Accumulate the RECORD only (region_accumulate now accepts empty bytes
    // when inputs are provided; the pc->idx bookkeeping is identical).
    region_accumulate(REGION_REL_0, pc, nullptr, 0u, &in);
}

bool BlockCache::region_has_pc(Region r, u32 pc) const {
    if (r >= REGION_COUNT) return false;
    return m_regions[r].pc_to_idx.find(pc) != m_regions[r].pc_to_idx.end();
}

bool BlockCache::region_lookup_local_idx(Region r, u32 target_pc, u32* out_idx) const {
    if (r >= REGION_COUNT) return false;
    const auto& m = m_regions[r].pc_to_idx;
    auto it = m.find(target_pc);
    if (it == m.end()) return false;
    if (out_idx) *out_idx = it->second;
    return true;
}

bool BlockCache::region_should_relink(Region r) const {
    if (r >= REGION_COUNT) return false;
    const RegionState& rs = m_regions[r];

    // Trigger 1: blocks accumulated. Threshold scales with how many blocks
    // are already in the region — small regions relink quickly so early
    // boot exploration moves PCs into the live module fast; large stable
    // regions relink less often to amortize V8 compile cost.
    //
    //   < 256 blocks total:    relink every 32 new   (boot warmup phase)
    //   < 1024 blocks total:   relink every 128 new  (active exploration)
    //   >= 1024 blocks total:  relink every 256 new  (steady state)
    //
    // Diagnose probe (2026-05-06) showed boot exploration adds new PCs
    // faster than the prior fixed 256 threshold relinks them — region
    // module perpetually 24% behind, dispatch falls to slow per-block
    // (cross-instance call_indirect deopt) path. Tiered threshold lets
    // boot stabilize the region quickly, then settles for steady state.
    u32 threshold;
    if (r == REGION_REL_0) {
        // [sealed-multi-gen 2026-06-21] The hot region seals fixed-size batches
        // into immutable generations; the batch size IS the seal cadence. Small
        // enough that the first seal fires early (chain_dispatch covers the
        // pre-first-seal window); large enough to amortize the one-time per-gen
        // Liftoff compile and keep most intra-loop branches intra-gen. The old
        // tiered 32/128/256 keyed on total n_funcs is meaningless here — n_funcs
        // resets to 0 after every seal, so it's purely the pending batch size.
        // [PM54c fix 2a] shared seal_batch() — cap and trigger cannot desync.
        threshold = seal_batch();
    } else if (rs.n_funcs < 256u)  threshold = 32u;
    else if (rs.n_funcs < 1024u)   threshold = 128u;
    else                           threshold = 256u;
    const bool block_trigger = (rs.blocks_since_link >= threshold);

    // [determinism] JITWASM_DETERMINISTIC=1 makes relink timing reproducible:
    // relink fires purely on block/dispatch COUNTS, never on wall-clock. This
    // removes the run-to-run variance in WHEN relink fires (and thus which
    // region module layout is live), which is the structural source of the
    // shifting wedge PC. Acceptance: two runs of one build → identical traces.
    static const bool s_deterministic = (std::getenv("JITWASM_DETERMINISTIC") != nullptr);

    // Trigger 2: steady-state catch — the region has at least one block
    // pending and hasn't accumulated a new one in >2 s. Without this, a
    // region that JITs a handful of blocks then quiesces would never get
    // its merged module built. TIME-based → suppressed in deterministic mode
    // (block_trigger alone governs; a deterministic dispatch-budget probe
    // doesn't strand blocks the way an open-ended run would).
    bool quiesce_trigger = false;
    if (!s_deterministic && rs.blocks_since_link >= 1u) {
        const double age = now_ms() - rs.last_accum_ms;
        if (age > 2000.0) quiesce_trigger = true;
    }

    if (!block_trigger && !quiesce_trigger) return false;

    // ---- Module-discard timing (V8 tier-up grace) ----
    // Once a region is past initial warmup (≥256 blocks → module is large
    // enough that TurboFan tier-up actually has inlining work to do), defer
    // relink while the just-installed module is still in V8's background
    // tier-up window. Without this, every threshold-trigger discards the
    // freshly-instantiated module before V8 ever upgrades it from Liftoff
    // → TurboFan, capping sustained throughput at baseline.
    //
    // We can't read V8 internals to know "tier-up done", so use two
    // proxies that bound the bg window from below:
    //   - elapsed-since-relink (>= grace ms)
    //   - dispatches-into-this-module (>= min dispatches; ensures V8
    //     actually collected feedback for the new instance — type
    //     feedback is per-instance and starts empty).
    //
    // Defaults derived from V8 research + lever_3_tierup_blocked_2026_05_05
    // (~300µs/fn bg compile; merged modules with ~480 fns → ~145 ms).
    // Defaults are conservative so steady-state behavior favors keeping a
    // tier-up'd module alive. Overridable via env for measurement.
    //
    // Disabled while still in warmup (n_funcs < 256) — boot needs fast
    // catch-up to surface PCs into the module before they pile up on the
    // slow per-block dispatch path.
    //
    // [sealed-multi-gen 2026-06-21] The hot region (REGION_REL_0) is exempt: a
    // seal builds a FRESH immutable gen and never rebuilds it, so there is no
    // tier-up'd module to protect from discard — deferring a seal just strands
    // hot blocks on the slow per-block path. Grace stays only for the legacy
    // non-REL_0 relink path.
    if (r != REGION_REL_0 && rs.n_funcs >= 256u && rs.last_relink_ms > 0.0) {
        static const double s_grace_ms =
            (std::getenv("BJIT_TIERUP_GRACE_MS") != nullptr)
                ? std::atof(std::getenv("BJIT_TIERUP_GRACE_MS"))
                : 250.0;
        static const u32 s_min_dispatches =
            (std::getenv("BJIT_TIERUP_MIN_DISPATCHES") != nullptr)
                ? static_cast<u32>(std::atoi(std::getenv("BJIT_TIERUP_MIN_DISPATCHES")))
                : 5000u;
        const double since_relink = now_ms() - rs.last_relink_ms;
        // Quiesce trigger ignores the grace gate: if the region has been
        // idle >2 s, V8 has definitely had its bg window — let the relink
        // proceed so pending blocks aren't stranded.
        // [determinism] in deterministic mode the wall-clock `since_relink`
        // term is dropped — the grace gate becomes purely dispatch-count
        // based, so relink timing no longer depends on real time.
        const bool grace_blocks = s_deterministic
            ? (rs.dispatches_since_relink < s_min_dispatches)
            : (since_relink < s_grace_ms && rs.dispatches_since_relink < s_min_dispatches);
        if (!quiesce_trigger && grace_blocks) {
            return false;
        }
    }

    return true;
}

// LocalIdxLookupFn closure that reads from a region's pc_to_idx map.
// Used during region_relink's re-emit pass so emit_block_body can resolve
// any pc that has been accumulated to its local fn idx, and emit
// return_call_indirect to the merged module's internal table.
namespace {
    struct RegionLookupCtx {
        const RegionState* rs;
    };
    bool region_lookup_for_emit(const void* user, u32 target_pc, u32* out_idx) {
        const auto* ctx = static_cast<const RegionLookupCtx*>(user);
        if (!ctx || !ctx->rs) return false;
        auto it = ctx->rs->pc_to_idx.find(target_pc);
        if (it == ctx->rs->pc_to_idx.end()) return false;
        if (out_idx) *out_idx = it->second;
        return true;
    }
}

// [sealed-multi-gen 2026-06-21] Seal the pending REGION_REL_0 batch into ONE
// fresh immutable generation module and append it. Unlike region_relink it
// NEVER rebuilds a prior gen — each gen is built once, V8 tiers it up, and it
// stays. region_dispatch routes via a global pc -> (genIdx<<16 | localIdx) map.
// The cold-relink that made grow-and-rebuild net-negative (650 blocks halved
// ticks) is gone: a seal's one-time Liftoff cost is paid once per gen.
// [PM54c fix 2c] pending-batch reset, factored so EVERY early exit from
// region_seal can release the batch instead of stranding it (overflow PATH B:
// the empty-bytes return previously left the batch pending forever, stacking
// +256 per window and re-attempting a failing seal).
void BlockCache::region_reset_pending(RegionState& rs) {
    rs.fn_bodies_concat.clear();
    rs.n_funcs                 = 0u;
    rs.pc_keys.clear();
    rs.pc_to_idx.clear();
    rs.block_records.clear();
    rs.blocks_since_link       = 0u;
    rs.last_accum_ms           = now_ms();
    rs.last_relink_ms          = now_ms();
    rs.dispatches_since_relink = 0u;
}

void BlockCache::region_seal(u32 mem_pages) {
    RegionState& rs = m_regions[REGION_REL_0];
    if (rs.n_funcs == 0u) return;

    // [PM54c fix 3a] Seal-time compaction+refresh against the LIVE
    // m_pending_emit: a pc evicted/SMC-invalidated/trapped while pending is
    // DROPPED (it re-promotes after recompile+re-heat — safe now that slots
    // are gen-packed), and surviving records are refreshed to the CURRENT
    // m_pending_emit content (a sealed gen must never serve stale pre-SMC
    // code). One site closes the content-desync class for all three
    // eviction paths.
    {
        u32 kept = 0u;
        for (u32 i = 0; i < rs.n_funcs; ++i) {
            const u32 pc = rs.pc_keys[i];
            auto it = m_pending_emit.find(pc);
            if (it == m_pending_emit.end() || it->second.insts.empty()) continue;
            rs.pc_keys[kept]       = pc;
            rs.block_records[kept] = it->second;
            ++kept;
        }
        if (kept != rs.n_funcs) {
            rs.pc_keys.resize(kept);
            rs.block_records.resize(kept);
            rs.pc_to_idx.clear();
            for (u32 i = 0; i < kept; ++i) rs.pc_to_idx[rs.pc_keys[i]] = i;
            rs.n_funcs = kept;
        }
        if (rs.n_funcs == 0u) { region_reset_pending(rs); return; }
    }

    // [seal-size cap 2026-08-08] Byte-budget block-count trim. build_region_module_next
    // roughly DOUBLES the concatenated bodies, and even ~256 un-fused blocks blow the
    // budget (measured: 256 blocks -> 642KB..1.1MB modules, fps whipsaw on the sync
    // WebAssembly.Module compile). Estimate body bytes (~insts*120 + 512 per block, which
    // matched the observed 1.3KB/block) and cap the batch near ~200KB of bodies so the
    // sealed module lands well under the 512KB budget. Trimmed blocks stay UNSEALED and
    // re-promote next window (histogram-driven) — the deferred carryover, not a drop.
    // Trimmed HERE, before re-emit, so rs.pc_to_idx omits them and no intra-region direct
    // edge is baked to a block outside the module (a post-emit cut would dangle + fail
    // validation). n_funcs<=256 (PM54c) is the ceiling; this budget binds below it.
    {
        constexpr size_t kSealBodyBudget = 150u * 1024u;
        size_t est = 0u;
        u32 keep = 0u;
        for (u32 i = 0; i < rs.n_funcs; ++i) {
            est += rs.block_records[i].insts.size() * 120u + 512u;
            if (est > kSealBodyBudget && i > 0u) break;   // always keep >= 1 block
            ++keep;
        }
        if (keep < rs.n_funcs) {
#ifdef __EMSCRIPTEN__
            EM_ASM({ console.log('[worker] [bemental] seal-cap gen ' + $0
                + ': batch ' + $1 + ' -> ' + $2 + ' blocks (carry ' + $3 + ', ~'
                + $4 + 'B est bodies)'); },
                (int)m_sealed_gen_count, (int)rs.n_funcs, (int)keep,
                (int)(rs.n_funcs - keep), (int)est);
#endif
            rs.pc_keys.resize(keep);
            rs.block_records.resize(keep);
            rs.pc_to_idx.clear();
            for (u32 i = 0; i < keep; ++i) rs.pc_to_idx[rs.pc_keys[i]] = i;
            rs.n_funcs = keep;
        }
    }

    // Generation cap — leak guard. Beyond MAX_GENS the pending batch stays
    // unmerged (region_dispatch misses those PCs -> chain_dispatch handles them,
    // correctness-safe). PSO's steady-state working set (~500 blocks, per
    // gc_merged_region_net_negative memo) sits far below MAX_GENS*SEAL_BATCH, so
    // the cap is a guard, not a functional limit.
    static const u32 s_max_gens =
        (std::getenv("BJIT_MAX_GENS") != nullptr)
            ? static_cast<u32>(std::atoi(std::getenv("BJIT_MAX_GENS")))
            : 24u;  // [region-merged 2026-07-15] 24 gens x 256 = 6144 PCs (boot+movie
                    // sealed 8 gens in the first 60s; the board needs its own ~2k —
                    // census: board top-2048 = 97.9%). MUST match the drain's
                    // gen-cap gate default in chain_dispatch.
    if (m_sealed_gen_count >= (s_max_gens ? s_max_gens : 48u)) {
#ifdef __EMSCRIPTEN__
        static bool s_warned = false;
        if (!s_warned) {
            s_warned = true;
            EM_ASM({ console.log('[worker] [bemental] seal: MAX_GENS reached ('
                + $0 + ') — pending hot blocks stay on per-block dispatch'); },
                (int)m_sealed_gen_count);
        }
#endif
        return;
    }

    // [return-linking] A fresh gen has its own slot layout; drop the RAS so a
    // stale entry under-flows to the safe op_return fallback (never tail-chains
    // to a wrong slot). Cross-gen blr falls back to op_return -> host dispatch,
    // which is correct. Same discipline as the legacy relink path.
    g_blr_ras_sp = 0u;
    g_blr_chain  = 0u;

    // ---- Re-emit pass (lever #2) over THIS pending batch ONLY ----
    // CRITICAL (sealed-multi-gen): region_lookup_for_emit binds to rs.pc_to_idx,
    // which holds ONLY the current pending batch (it is cleared after each
    // seal). A branch whose target was sealed in a PRIOR gen is therefore NOT
    // found -> set_pc + return (cross-gen EXIT to the dispatcher, which
    // re-enters the owning gen). This is exactly what keeps every gen's internal
    // br_table arms in range [0, batch) — NEVER feed a cumulative/global map
    // into region_lookup_for_emit, or a `br $L` could land out of range.
    static const bool s_reemit_enabled =
        (std::getenv("JITWASM_REEMIT_AT_RELINK_OFF") == nullptr);
    bool have_records = s_reemit_enabled && (rs.block_records.size() == rs.n_funcs);
    for (const auto& rec : rs.block_records) {
        if (rec.insts.empty()) { have_records = false; break; }
    }
    // ---- Shape choice FIRST (single-fn merged shape preferred) ----
    // [PM53e 2026-08-03] Default FLIPPED to the N-fn shape: the merged
    // giant-function br_table shape lost three A/Bs (see g_bem_promote_enabled
    // note). N-fn = small per-block functions in one module per gen, intra-gen
    // edges via the module-INTERNAL declared table (V8-inline-eligible),
    // singles arms emit per-block-style (merged=null). getenv is dead in the
    // worker (no ENV plumbing) — the default IS the config.
    static const bool s_merged_enabled = false;
    const bool use_merged_fn = s_merged_enabled && have_records;

    // [region-merged 2026-07-15] N-fn ONLY: re-emit the pending batch into
    // concatenated bodies (the merged builder emits its own bodies from the
    // records, with runtime-resolved intra-region edges — region_lookup_for_emit
    // and its baked-edge eviction hole do not apply to it). Unconditionally
    // powerpc-next: the gekko arms are RETIRED (the canonical build compiled
    // USE_REBUILD=OFF, silently routing every sealed region through the legacy
    // emitter — no ppc_msr_updated/ppc_gather_drain, no powerpc-next semantics:
    // the staleness bug).
    if (have_records && !use_merged_fn) {
        rs.fn_bodies_concat.clear();
        RegionLookupCtx ctx{ &rs };
        // [FUSION v2 PM54f] run-fusion over three seam shapes:
        //  FWD terminal forward cond, fallthrough in-batch (v1 — measured 0
        //      fires: analyzer-coalesced in-block, kept for completeness);
        //  BWD terminal BACKWARD cond (native BO only): NOT-TAKEN side
        //      last_pc+4 in-batch — the bcx stays in the stream and emits as
        //      a coalesced mid-block exit (taken keeps its exit);
        //  B   terminal unconditional b (LK=0, AA=0) to an in-batch target —
        //      the b is DELETED (inline adjacency IS the branch), the
        //      successor continues at its OWN pcs (non-contiguous stream via
        //      AnalyzeOps). Successors KEEP their standalone functions.
        auto rec_is_fp_free = [](const BlockEmitInputs& r) -> bool {
            for (u32 w : r.insts) {
                const u32 opcd = w >> 26;
                if (opcd == 4u || (opcd >= 48u && opcd <= 63u)) return false;
            }
            return true;
        };
        auto pcs_of = [](const BlockEmitInputs& r) -> std::vector<u32> {
            if (r.instr_pcs.size() == r.insts.size()) return r.instr_pcs;
            std::vector<u32> p(r.insts.size());
            for (u32 j = 0; j < (u32)p.size(); ++j) p[j] = r.start_pc + j * 4u;
            return p;
        };
        auto seam_kind = [](u32 inst) -> int {   // 0 none, 1 fwd, 2 bwd, 3 b, 4 bl, 5 blr
            const u32 opcd = inst >> 26;
            if (opcd == 18u) {
                if ((inst & 3u) == 0u) return 3;              // b
                if ((inst & 3u) == 1u) return 4;              // bl (AA=0)
                return 0;
            }
            if (opcd == 19u) return powerpc::IsPlainBlr(inst) ? 5 : 0;
            if (opcd != 16u) return 0;
            if (powerpc::IsForwardConditionalBranch(inst, 0u)) return 1;
            return powerpc::IsSeamBackwardConditional(inst) ? 2 : 0;
        };
        // [FUSION v3] callee eligibility: no LR writers inside (mtlr, any
        // LK-set branch) — the software-RAS check assumes the inlined bl was
        // the last LR writer on the good path.
        auto rec_no_lr_writers = [](const BlockEmitInputs& r) -> bool {
            for (u32 w : r.insts) {
                const u32 opcd = w >> 26;
                if ((opcd == 18u || opcd == 16u) && (w & 1u)) return false;
                if ((w & 0xFC1FFFFFu) == 0x7C0803A6u) return false;   // mtlr rX
            }
            return true;
        };
        auto seam_succ = [](u32 inst, u32 last_pc) -> u32 {
            if ((inst >> 26) == 18u) {           // b and bl: static target
                u32 raw = inst & 0x03FFFFFCu;
                return last_pc + ((raw & 0x02000000u) ? (raw | 0xFC000000u) : raw);
            }
            return last_pc + 4u;                 // conditional fallthrough
        };
        std::unordered_map<u32, u32> fuse_preds;  // succ pc -> #fusable edges
        for (u32 i = 0; i < rs.n_funcs; ++i) {
            const BlockEmitInputs& r = rs.block_records[i];
            if (r.insts.empty()) continue;
            const std::vector<u32> p = pcs_of(r);
            const int pk = seam_kind(r.insts.back());
            if (pk == 0 || pk >= 4) continue;   // bl/blr edges skip the pred rule
            const u32 succ = seam_succ(r.insts.back(), p.back());
            if (rs.pc_to_idx.find(succ) != rs.pc_to_idx.end()) fuse_preds[succ] += 1u;
        }
        u32 fused_runs = 0u, fused_blocks = 0u, fused_b = 0u, fused_bwd = 0u;
        u32 fused_bl = 0u, fused_blr = 0u;
        // [seal-size cap 2026-08-08] run-fusion inlines successor blocks and is the
        // source of the unbounded gen blowup (2.1MB observed vs the ~480KB envelope; a
        // synchronous WebAssembly.Module compile of an oversized gen stalls the EmuThread
        // for multiple frames — the fps whipsaw — and blows V8's per-function inlining
        // budget, wasting the N-fn design). Once the concatenated bodies pass this cutoff,
        // stop fusing and emit the remaining blocks UN-FUSED (small, valid, no dangling
        // intra-region edges) so the gen stays near the 512KB budget. n_funcs<=256 (PM54c)
        // is retained; this binds IN ADDITION. Truncating the batch is NOT done here — the
        // re-emitted bodies bake direct edges via rs.pc_to_idx which still holds every
        // batch pc, so a mid-batch cut would dangle those edges.
        constexpr size_t kSealFusionCutoff = 192u * 1024u;
        u32 unfused_by_cap = 0u;
        for (u32 i = 0; i < rs.n_funcs; ++i) {
            const BlockEmitInputs& rec = rs.block_records[i];
            std::vector<u32> fused = rec.insts;
            std::vector<u32> fpcs  = pcs_of(rec);
            u32 depth = 1u;
            const bool fusion_ok = rs.fn_bodies_concat.size() < kSealFusionCutoff;
            if (!fusion_ok) ++unfused_by_cap;
            if (rec_is_fp_free(rec) && fusion_ok) {
                u32 visited[8]; u32 n_vis = 0u; visited[n_vis++] = rec.start_pc;
                u32 pending_ret = 0u;            // [FUSION v3] one bl deep, no nesting
                for (;;) {
                    if (depth >= 8u || fused.size() >= 96u) break;
                    const int k = seam_kind(fused.back());
                    if (!k) break;
                    u32 succ;
                    if (k == 5) {                // blr: continue at the RAS ret
                        if (!pending_ret) break;
                        succ = pending_ret;
                    } else {
                        succ = seam_succ(fused.back(), fpcs.back());
                    }
                    if (k == 4 && pending_ret) break;      // no nested bl
                    auto sit = rs.pc_to_idx.find(succ);
                    if (sit == rs.pc_to_idx.end()) break;
                    if (k <= 3) {                // pred rule only for branch shapes
                        auto pit = fuse_preds.find(succ);
                        if (pit == fuse_preds.end() || pit->second != 1u) break;
                    }
                    bool seen = false;
                    for (u32 v = 0; v < n_vis; ++v)
                        if (visited[v] == succ) { seen = true; break; }
                    if (seen) break;             // no cycle unrolling
                    const BlockEmitInputs& nxt = rs.block_records[sit->second];
                    if (nxt.insts.empty() || nxt.start_pc != succ) break;
                    if (!rec_is_fp_free(nxt)) break;
                    if (k == 4 && !rec_no_lr_writers(nxt)) break;   // callee must keep LR
                    if (nxt.ctx_ptr_const != rec.ctx_ptr_const ||
                        nxt.mem1_base != rec.mem1_base ||
                        nxt.mem1_mask != rec.mem1_mask ||
                        nxt.ram_size  != rec.ram_size) break;
                    if (k == 3) { fused.pop_back(); fpcs.pop_back(); ++fused_b; }
                    if (k == 2) ++fused_bwd;
                    if (k == 4) { pending_ret = fpcs.back() + 4u; ++fused_bl; }
                    if (k == 5) { pending_ret = 0u; ++fused_blr; }
                    const std::vector<u32> np = pcs_of(nxt);
                    fused.insert(fused.end(), nxt.insts.begin(), nxt.insts.end());
                    fpcs.insert(fpcs.end(), np.begin(), np.end());
                    visited[n_vis++] = succ;
                    ++depth;
                }
                // [seam contract] every non-terminal coalescable conditional
                // must have its +4 successor ADJACENT in the stream (the
                // not-taken arms store NOTHING). Violation => drop the fusion.
                if (depth > 1u) {
                    for (std::size_t j = 0; j + 1 < fused.size(); ++j) {
                        const u32 w = fused[j];
                        if ((powerpc::IsForwardConditionalBranch(w, fpcs[j]) ||
                             powerpc::IsSeamBackwardConditional(w)) &&
                            fpcs[j + 1] != fpcs[j] + 4u) {
                            fused = rec.insts; fpcs = pcs_of(rec); depth = 1u;
                            break;
                        }
                    }
                }
                // [PM54f SMC fix 2026-08-07] Record each successor spliced into
                // THIS predecessor (visited[0]=rec.start_pc itself; [1,n_vis) are
                // the fused successors) so evict()/invalidate_overlap of a fused
                // successor also evicts the predecessor holding its stale bytes.
                // Gated on depth>1 so a seam-contract-reverted fusion (depth reset
                // to 1 above) records nothing.
                if (depth > 1u) {
                    for (u32 v = 1u; v < n_vis; ++v)
                        m_fused_succ_to_pred[visited[v]].push_back(rec.start_pc);
                }
            }
            if (depth > 1u) { ++fused_runs; fused_blocks += depth; }
            std::vector<u8> body = powerpc::emit_block_body_next(
                rec.start_pc, fused.data(), static_cast<u32>(fused.size()),
                rec.ctx_ptr_const, rec.mem1_base, rec.mem1_mask, rec.ram_size,
                fpcs.data(),                     // REAL parallel pcs
                &region_lookup_for_emit, &ctx,
                rec.emit_hle_check, rec.emit_perf_stub, rec.emit_hle_check_native,
                (s32)m_sealed_gen_count);
            rs.fn_bodies_concat.insert(rs.fn_bodies_concat.end(),
                                       body.begin(), body.end());
        }
#ifdef __EMSCRIPTEN__
        if (fused_runs) {
            EM_ASM({ console.log('[worker] [bemental] run-fusion: ' + $0
                + ' runs / ' + $1 + ' blocks (b ' + $2 + ', bwd ' + $3
                + ', bl ' + $4 + ', blr ' + $5 + ') gen ' + $6); },
                (int)fused_runs, (int)fused_blocks, (int)fused_b,
                (int)fused_bwd, (int)fused_bl, (int)fused_blr,
                (int)m_sealed_gen_count);
        }
        if (unfused_by_cap) {
            EM_ASM({ console.log('[worker] [bemental] seal-cap gen ' + $0 + ': ' + $1
                + ' blocks un-fused, bodies=' + $2 + 'B (cutoff ' + $3 + 'B)'); },
                (int)m_sealed_gen_count, (int)unfused_by_cap,
                (int)rs.fn_bodies_concat.size(), (int)kSealFusionCutoff);
        }
#endif
    }

    std::vector<u8> bytes;
    if (use_merged_fn) {
        // Merged single-function gen via the REAL powerpc-next builder
        // (region_desc.h). gen_idx packs into g_bem_mrslot below; the bodies'
        // own-gen check uses the same value — consistency is local to this seal.
        std::vector<powerpc::RegionBlockDesc> descs(rs.n_funcs);
        for (u32 i = 0; i < rs.n_funcs; ++i) {
            const BlockEmitInputs& rec = rs.block_records[i];
            descs[i].start_pc  = rec.start_pc;
            descs[i].insts     = rec.insts.data();
            descs[i].count     = (u32)rec.insts.size();
            descs[i].ctx_ptr   = rec.ctx_ptr_const;
            descs[i].mem1_base = rec.mem1_base;
            descs[i].mem1_mask = rec.mem1_mask;
            descs[i].ram_size  = rec.ram_size;
        }
        bytes = powerpc::build_region_function_next_merged(
            descs.data(), rs.n_funcs, /*gen_idx=*/m_sealed_gen_count,
            (u32)(uintptr_t)&g_blr_chain, mem_pages);
    } else {
        bytes = powerpc::build_region_module_next(
            rs.fn_bodies_concat.data(), rs.fn_bodies_concat.size(),
            rs.n_funcs, mem_pages);
    }
    if (bytes.empty()) {
#ifdef __EMSCRIPTEN__
        EM_ASM({ console.log('[worker] [bemental] seal gen ' + $0
            + ' FAILED: build_region returned empty bytes'); },
            (int)m_sealed_gen_count);
#endif
        // [PM54c fix 2c] release the batch — pcs stay per-block-served and
        // re-promotable; never strand-and-retry.
        region_reset_pending(rs);
        return;
    }

#ifdef __EMSCRIPTEN__
    // Append the immutable generation to Module.bemental_gens and register its
    // PCs in the global Module.bemental_pc2gen map. nFuncs <= SEAL_BATCH (96) so
    // the 16-bit localIdx pack (genIdx<<16 | localIdx) never overflows.
    // [region-merged async-seal 2026-07-15] The old synchronous
    // `new WebAssembly.Module` on a 250-480KB gen module stalled the GUEST for
    // the whole V8 compile — measured: 24 seals froze gameLoop in ~12s windows
    // (A/B: promote-ON aggregate -27% despite ~2x post-seal bursts). Compile +
    // instantiate ASYNC: the guest keeps running on the per-block path and the
    // gen goes live (table/bucket/pc2gen registration inside .then) when V8
    // finishes on its own time. C++ commits m_sealed_pcs/gen_count
    // optimistically below — safe: the packed mrtag entries of a not-yet-live
    // gen only gen-mismatch-fall-through in other gens' bodies, and the global
    // buckets repoint only inside .then. A failed compile leaves those PCs
    // sealed-but-unregistered: correct, unaccelerated, logged.
    const int seal_ok = EM_ASM_INT({
        const bytesPtr  = $0;
        const bytesLen  = $1 >>> 0;
        const pcKeysPtr = $2;
        const nFuncs    = $3 >>> 0;
        const genIdx    = $4 | 0;
        const mergedFn  = $5 | 0;
        const dispTag   = $6;
        const dispSlot  = $7;
        const dispMask  = $8 >>> 0;
        try {
            // Copy bytes + pc keys SYNCHRONOUSLY — the C++ buffers are reset
            // as soon as this EM_ASM returns.
            const view = new Uint8Array(Module.HEAPU8.buffer, bytesPtr, bytesLen);
            const copy = new Uint8Array(view);
            const pcs = new Array(nFuncs);
            for (let i = 0; i < nFuncs; i++) {
                pcs[i] = HEAPU32[(pcKeysPtr >>> 2) + i] >>> 0;
            }
            const memObj = (typeof wasmMemory !== 'undefined') ? wasmMemory : null;
            const env = {};
            if (memObj) env.memory = memObj;
            if (Module.bemental_imports && Module.bemental_imports.env) {
                Object.assign(env, Module.bemental_imports.env);
            }
            // [cross-gen fix 2026-07-15] merged modules import the GLOBAL table
            // for the standard-chain fallthrough (per-block compile_raw parity).
            if (typeof wasmTable !== 'undefined') {
                env['__indirect_function_table'] = wasmTable;
            }
            // [PM53c SYNC SEAL] The async .then NEVER RAN under the dual-core
            // topology: the EmuThread pthread never returns to its JS event
            // loop (continuous run loop + Atomics.wait throttle), so promise
            // microtasks never drain — gens sealed optimistically C++-side but
            // never registered (measured: pending resets, zero 'sealed gen'
            // prints, zero perf delta). Workers may sync-compile without size
            // limits; one Liftoff compile per gen is the intended cost.
            // NOTE: report failures via console.log — worker console.error
            // does NOT relay to the probe log (measured PM53d: every catch
            // print was silently lost; validate=false was invisible).
            const inst = new WebAssembly.Instance(
                new WebAssembly.Module(copy), { env: env });
            // NOTE: build `gen` with separate assignments — a `{a:x, b:y}` object
            // literal here has bare commas which the C preprocessor (balances
            // parens only) would split as EM_ASM macro args. Same reason the
            // legacy region_relink builds its region object field-by-field.
            const gen = {};
            gen.instance = inst;
            gen.nFuncs   = nFuncs;
            gen.merged   = !!mergedFn;
            if (gen.merged) {
                gen.regionFn = inst.exports['region'];
                gen.entrySel = inst.exports['entry_sel'];
                if (!gen.regionFn || !gen.entrySel) {
                    console.log('[worker] [bemental] seal gen ' + genIdx
                        + ' FAILED: merged shape missing exports');
                    return 0;
                }
            }
            // [region-merged 2026-07-15] BOTH shapes register fn_k in the
            // GLOBAL wasmTable + dispatch buckets. For the merged shape the
            // fn_k exports are the ENTRY WRAPPERS (reset blr-chain budget +
            // zero laps + set entry_sel + return_call $region), so a promoted
            // PC is entered by the normal per-block tail-chain / C loop at
            // measured-zero cross-instance cost — no JS per-hit dispatch.
            // For the N-fn shape they are the block functions (unchanged).
            {
                const fns = new Array(nFuncs);
                let haveFns = true;
                for (let i = 0; i < nFuncs; i++) {
                    fns[i] = inst.exports['fn_' + i];
                    if (!fns[i]) { haveFns = false; break; }
                }
                if (!haveFns) {
                    console.log('[worker] [bemental] seal gen ' + genIdx
                        + ' FAILED: missing fn_k exports (shape='
                        + (gen.merged ? 'merged' : 'Nfn') + ')');
                    return 0;
                }
                gen.fns = fns;
                if (!Module._bemental_table_base) {
                    Module._bemental_table_base = wasmTable.length;
                    Module._bemental_next_idx   = wasmTable.length;
                    wasmTable.grow(8192);
                }
                gen.globalSlots = new Array(nFuncs);
                for (let i = 0; i < nFuncs; i++) {
                    let gi = Module._bemental_next_idx;
                    if (gi >= wasmTable.length) wasmTable.grow(4096);
                    wasmTable.set(gi, fns[i]);
                    Module._bemental_next_idx = gi + 1;
                    gen.globalSlots[i] = gi;
                }
            }
            if (!Module.bemental_gens)   Module.bemental_gens   = [];
            if (!Module.bemental_pc2gen) Module.bemental_pc2gen = new Map();
            Module.bemental_gens[genIdx] = gen;
            for (let i = 0; i < nFuncs; i++) {
                const pc = pcs[i];   // [async-seal] pre-copied — C++ buffer is gone
                Module.bemental_pc2gen.set(pc, ((genIdx << 16) | i) >>> 0);
                // [Phase2] Point the GLOBAL dispatch cache (g_bem_disp_tag/slot,
                // $6/$7, mask $8) at this region fn's wasmTable slot so BOTH the
                // C-loop AND the per-block in-WASM tail-chain dispatch this PC
                // into the region instead of its per-block module.
                if (gen.globalSlots) {
                    const bkt = (pc >>> 2) & dispMask;
                    HEAPU32[(dispTag >>> 2) + bkt] = pc;
                    HEAP32[(dispSlot >>> 2) + bkt] = gen.globalSlots[i] | 0;
                }
            }
            console.log('[worker] [bemental] sealed gen ' + genIdx + ' n_funcs=' + nFuncs
                + ' bytes=' + bytesLen + (gen.merged ? ' shape=merged' : ' shape=Nfn')
                + ' emitter=next sync');   // [region-merged] gekko-relapse tripwire (gate greps this)
            return 1;
        } catch (e) {
            // console.log, NOT console.error — worker error lines don't relay
            // to the probe log (PM53d finding).
            console.log('[worker] [bemental] seal gen ' + genIdx + ' FAILED: '
                + (e && e.message ? e.message : String(e)));
            return 0;
        }
        return 0;
    },
    bytes.data(), (int)bytes.size(),
    rs.pc_keys.data(), (int)rs.n_funcs,
    (int)m_sealed_gen_count,
    use_merged_fn ? 1 : 0,
    (int)(uintptr_t)&g_bem_disp_tag[0], (int)(uintptr_t)&g_bem_disp_slot[0],
    (int)BEM_DISP_MASK);

    // [PM54c N-fn fix 2b] Commit ONLY on seal success (the seal is SYNCHRONOUS
    // since PM53c; the old optimistic commit misdocumented async semantics and
    // burned gen slots + permanently retired pcs on failure). On failure: pcs
    // stay per-block-served AND re-promotable; the genIdx is reused by the
    // next successful seal (a failed attempt registers nothing JS-side and,
    // with the populate relocated below, writes no rtag entries). Storm brake:
    // after 3 consecutive failures, commit the pcs anyway (permanently
    // per-block, today's semantics) so a deterministic compile failure cannot
    // retry forever.
    static u32 s_seal_fail_streak = 0;
    if (seal_ok) {
        s_seal_fail_streak = 0;
        for (u32 pc : rs.pc_keys) m_sealed_pcs.insert(pc);
        // [PM54c fix 1a] populate the region-local probe caches ONLY for a
        // LIVE gen, with GEN-PACKED slots in BOTH shapes ((gen<<16)|i — the
        // merged scheme, now shared). Bodies own-gen-check before calling
        // through their internal table, so other gens' surviving entries are
        // inert fallthroughs, never wrong-function calls. NOTE: BJIT_MAX_GENS
        // must stay < 32768 for the 16-bit pack (default 24; getenv is dead
        // in the worker so the default is the config).
        if (!use_merged_fn) {
            for (u32 i = 0; i < rs.n_funcs; ++i) {
                const u32 pc  = rs.block_records[i].start_pc;
                const u32 bkt = (pc >> 2) & BEM_DISP_MASK;
                g_bem_rtag[bkt]  = pc;
                g_bem_rslot[bkt] = (int32_t)((m_sealed_gen_count << 16) | i);
            }
        } else {
            for (u32 i = 0; i < rs.n_funcs; ++i) {
                const u32 pc  = rs.block_records[i].start_pc;
                const u32 bkt = (pc >> 2) & BEM_DISP_MASK;
                g_bem_mrtag[bkt]  = pc;
                g_bem_mrslot[bkt] = (int32_t)((m_sealed_gen_count << 16) | i);
            }
        }
        m_sealed_gen_count += 1u;
        m_region_has_sealed = true;
    } else {
        ++s_seal_fail_streak;
        if (s_seal_fail_streak >= 3u) {
            for (u32 pc : rs.pc_keys) m_sealed_pcs.insert(pc);
            s_seal_fail_streak = 0;
        }
    }
#else
    (void)mem_pages;
#endif

    // Reset the pending batch for the next generation. The sealed gen is
    // immutable and lives in Module.bemental_gens; pending state starts empty.
    region_reset_pending(rs);
}

void BlockCache::region_relink(Region r, u32 mem_pages) {
    if (r >= REGION_COUNT) return;
    // [sealed-multi-gen 2026-06-21] The hot region uses append-only sealing,
    // not grow-and-rebuild. Route it to region_seal; the legacy relink body
    // below serves only the non-REL_0 (Phase-5 REL slot) regions.
    if (r == REGION_REL_0) { region_seal(mem_pages); return; }
    RegionState& rs = m_regions[r];
    if (rs.n_funcs == 0u) return;
    // [return-linking] The relink rebuilds the merged module: a given return PC
    // can map to a DIFFERENT slot in the new generation, so any RAS entry holding
    // an old-generation slot is now stale. Drop the whole RAS — a subsequent blr
    // then under-flows -> mispredict -> safe op_return fallback (no tail-chain to
    // a wrong slot). Relink happens OUTSIDE the region while-loop (chain_dispatch),
    // so no in-flight region tail-chain races this.
    g_blr_ras_sp = 0u;
    g_blr_chain  = 0u;

    // ---- Re-emit pass (lever #2 — block-link patching) ----
    // The bodies in fn_bodies_concat were emitted at first-accumulate time
    // when sibling blocks weren't yet known, so any cross-block branch
    // baked the slow set-pc + return path. Re-emit each body now with the
    // up-to-date pc_to_idx map: branches whose targets are in the map
    // become return_call_indirect (intra-instance, V8-inline-able).
    //
    // Phase B4: default-ON (was default-OFF gated by JITWASM_REEMIT_AT_RELINK).
    // The 2026-05-06 measurement that motivated the gate observed 1500+
    // blocks per region; in current SAB boot we plateau at ~480/region per
    // probe (gen=9), well under the O(N^2) collapse threshold. Disable
    // explicitly via JITWASM_REEMIT_AT_RELINK_OFF=1 if a regression turns up
    // (e.g. game with much wider regions).
    //
    // Re-emit lets cross-block branches whose targets are NEWLY accumulated
    // since first emit become return_call_indirect (intra-instance, V8-
    // inline-able) instead of staying baked as set_pc + return.
    //
    // TODO: per-block "needs re-emit" tracking — only re-emit blocks with
    // unresolved branches whose targets are now in pc_to_idx. Reduces O(N^2)
    // to O(touched edges).
    static const bool s_reemit_enabled =
        (std::getenv("JITWASM_REEMIT_AT_RELINK_OFF") == nullptr);
    bool have_records = s_reemit_enabled && (rs.block_records.size() == rs.n_funcs);
    for (const auto& rec : rs.block_records) {
        if (rec.insts.empty()) { have_records = false; break; }
    }
    if (have_records) {
        rs.fn_bodies_concat.clear();
        RegionLookupCtx ctx{ &rs };
        for (u32 i = 0; i < rs.n_funcs; ++i) {
            const BlockEmitInputs& rec = rs.block_records[i];
#ifdef BEMENTALJIT_USE_REBUILD
            std::vector<u8> body = powerpc::emit_block_body_next(
#else
            std::vector<u8> body = powerpc::emit_block_body(
#endif
                rec.start_pc,
                rec.insts.data(),
                static_cast<u32>(rec.insts.size()),
                rec.ctx_ptr_const,
                rec.mem1_base, rec.mem1_mask, rec.ram_size,
                rec.instr_pcs.data(),
                &region_lookup_for_emit, &ctx,
                /*emit_hle_check=*/rec.emit_hle_check,
                /*emit_perf_stub=*/rec.emit_perf_stub,
                /*emit_hle_check_native=*/rec.emit_hle_check_native);
            rs.fn_bodies_concat.insert(rs.fn_bodies_concat.end(),
                                       body.begin(), body.end());
        }
    }

    // Lever #2 alt path — single-function merged region. Toggled by
    // BJIT_LEVER2_MERGED=1 (process env) OR Module.lever2_merged=1 (JS-side
    // flag, useful for puppeteer probe before pthread spawns). Requires
    // per-block records (same condition as re-emit at relink). Output is a
    // module exporting ONE function `region` and ONE mutable global
    // `entry_sel`; dispatcher writes entry_sel = local_idx then calls
    // region() to execute.
    // Lever #2 — single-function merged region with depth-tracked
    // br-to-loop. Default ON: SAB+PSO boot parity confirmed and ~43%
    // reduction in region-dispatch host round-trips on SAB at disp=100k.
    // Override via BJIT_LEVER2_MERGED_OFF=1 to fall back to N-fn shape.
#ifdef __EMSCRIPTEN__
    static const bool s_merged_enabled = (std::getenv("BJIT_LEVER2_MERGED_OFF") == nullptr);
#else
    static const bool s_merged_enabled = (std::getenv("BJIT_LEVER2_MERGED_OFF") == nullptr);
#endif
    bool use_merged_fn = s_merged_enabled
                      && (rs.block_records.size() == rs.n_funcs);
    if (use_merged_fn) {
        for (const auto& rec : rs.block_records) {
            if (rec.insts.empty()) { use_merged_fn = false; break; }
        }
    }

    std::vector<u8> bytes;
    if (use_merged_fn) {
        std::vector<powerpc::BlockInputs> bins(rs.n_funcs);
        for (u32 i = 0; i < rs.n_funcs; ++i) {
            const BlockEmitInputs& rec = rs.block_records[i];
            bins[i].start_pc       = rec.start_pc;
            bins[i].insts          = rec.insts.data();
            bins[i].count          = (u32)rec.insts.size();
            bins[i].ctx_ptr_const  = rec.ctx_ptr_const;
            bins[i].mem1_base      = rec.mem1_base;
            bins[i].mem1_mask      = rec.mem1_mask;
            bins[i].ram_size       = rec.ram_size;
            bins[i].instr_pcs      = rec.instr_pcs.data();
            bins[i].emit_hle_check = rec.emit_hle_check;
            bins[i].emit_perf_stub = rec.emit_perf_stub;
            bins[i].emit_hle_check_native = rec.emit_hle_check_native;
            bins[i].block_cycles   = rec.block_cycles;
        }
        RegionLookupCtx ctx{ &rs };
#ifdef __EMSCRIPTEN__
        // [slotmap] builder-agnostic dump of the authoritative slot→start_pc
        // map (br_table arm i lands on bins[i]) plus what the emit-time lookup
        // maps the wedge fn's key successors to. If lookup says 0x800e3958=slot
        // K but bins[K].start_pc != 0x800e3958, that mismatch is the self-loop.
#endif
#ifdef BEMENTALJIT_USE_REBUILD
        bytes = powerpc::build_region_function_next(
            bins.data(), rs.n_funcs,
            &region_lookup_for_emit, &ctx,
            mem_pages);
#else
        bytes = powerpc::build_region_function(
            bins.data(), rs.n_funcs,
            &region_lookup_for_emit, &ctx,
            mem_pages);
#endif
    } else {
#ifdef BEMENTALJIT_USE_REBUILD
        bytes = powerpc::build_region_module_next(
            rs.fn_bodies_concat.data(),
            rs.fn_bodies_concat.size(),
            rs.n_funcs,
            mem_pages);
#else
        bytes = powerpc::build_region_module(
            rs.fn_bodies_concat.data(),
            rs.fn_bodies_concat.size(),
            rs.n_funcs,
            mem_pages);
#endif
    }
    if (bytes.empty()) {
#ifdef __EMSCRIPTEN__
        EM_ASM({
            console.error('[bemental] region', $0,
                ' relink: build_region returned empty bytes');
        }, (int)r);
#endif
        return;
    }

#ifdef __EMSCRIPTEN__
    // Instantiate, populate JS-side per-region pc->local_fn_idx Map, and
    // swap module_handle. Keep the previous instance alive in
    // Module.bemental_regions_old until we've successfully bound the new
    // one — guards against an instantiate failure leaving the region with
    // no live module.
    const int new_handle = EM_ASM_INT({
        const r          = $0 | 0;
        const bytesPtr   = $1;
        const bytesLen   = $2 >>> 0;
        const pcKeysPtr  = $3;
        const nFuncs     = $4 >>> 0;
        const generation = $5 | 0;
        const mergedFn   = $6 | 0;     // 1 = single-fn merged region, 0 = N fn_<i> path
        try {
            const view = new Uint8Array(Module.HEAPU8.buffer, bytesPtr, bytesLen);
            const copy = new Uint8Array(view);
            const mod  = new WebAssembly.Module(copy);

            const memObj = (typeof wasmMemory !== 'undefined') ? wasmMemory : null;
            const env = {};
            if (memObj) env.memory = memObj;
            if (Module.bemental_imports && Module.bemental_imports.env) {
                Object.assign(env, Module.bemental_imports.env);
            }
            const inst = new WebAssembly.Instance(mod, { env: env });

            // Build pc -> local_fn_idx Map from the parallel pc_keys array.
            const pcMap = new Map();
            for (let i = 0; i < nFuncs; i++) {
                const pc = HEAPU32[(pcKeysPtr >>> 2) + i] >>> 0;
                pcMap.set(pc, i);
            }

            // Lever #2 merged shape exports `region` + `entry_sel`. Otherwise
            // pre-resolve each fn_<i> export into a JS array indexed by
            // local fn idx — avoids a string lookup per dispatch.
            const region = {};
            region.merged = !!mergedFn;
            if (region.merged) {
                region.regionFn  = inst.exports['region'];
                region.entrySel  = inst.exports['entry_sel'];
                if (!region.regionFn || !region.entrySel) {
                    console.error('[bemental] region ' + r
                        + ' merged shape missing exports — region:'
                        + (typeof region.regionFn) + ' entry_sel:'
                        + (typeof region.entrySel));
                    return -1;
                }
            } else {
                const fns = new Array(nFuncs);
                for (let i = 0; i < nFuncs; i++) {
                    fns[i] = inst.exports['fn_' + i];
                }
                region.fns = fns;
            }

            if (!Module.bemental_regions) Module.bemental_regions = {};
            const prev = Module.bemental_regions[r];
            region.instance   = inst;
            region.pcMap      = pcMap;
            region.nFuncs     = nFuncs;
            region.generation = generation;
            Module.bemental_regions[r] = region;
            if (prev) prev.instance = null;
            console.log('[worker] [bemental] region ' + r + ' relinked gen=' + generation
                + ' n_funcs=' + nFuncs + ' bytes=' + bytesLen
                + (region.merged ? ' shape=merged' : ' shape=Nfn'));
            return r;
        } catch (e) {
            console.error('[bemental] region ' + r + ' relink failed: '
                + (e && e.message ? e.message : String(e)));
            return -1;
        }
    },
    (int)r,
    bytes.data(), (int)bytes.size(),
    rs.pc_keys.data(), (int)rs.n_funcs,
    rs.generation + 1,
    use_merged_fn ? 1 : 0);

    if (new_handle < 0) return;
    rs.module_handle             = new_handle;
    rs.generation               += 1;
    rs.blocks_since_link         = 0u;
    rs.last_relink_ms            = now_ms();
    rs.dispatches_since_relink   = 0u;
#else
    (void)mem_pages;
#endif
}

bool BlockCache::region_dispatch(u32 pc, s32* out) {
    // [return-linking] Host boundary: reset the consecutive in-WASM tail-chain
    // counter so the idle-skip streak detector observes idle cycles. The RAS sp
    // PERSISTS across region entries (a call's blr can come after a downcount
    // bail + re-entry); only the chain budget resets here.
    g_blr_chain = 0u;
    // [sealed-multi-gen 2026-06-21] Route via the global pc -> (genIdx<<16 |
    // localIdx) map. Each promoted hot block lives in exactly one immutable
    // generation (dedup at promote time). A pc not in the map returns false ->
    // caller falls through to chain_dispatch. Intra-gen branches chain in-WASM
    // (entry_sel + br $L); cross-gen targets exit set_pc+return and re-dispatch
    // here into the owning gen.
    g_rd_calls++;                                            // [region-debug]
    if (m_sealed_gen_count == 0u) { g_rd_nogen++; return false; }  // [region-debug] cold window -> chain_dispatch
    if (m_sealed_pcs.find(pc) == m_sealed_pcs.end()) { g_rd_miss++; return false; }  // [xinst-fix] C-side miss: skip the JS-membrane EM_ASM
    m_regions[REGION_REL_0].dispatches_since_relink += 1u;  // diagnostic meter only
#ifdef __EMSCRIPTEN__
    return EM_ASM_INT({
        const pc       = $0 >>> 0;
        const outPtr   = $1;
        const map = Module.bemental_pc2gen;
        if (!map) { HEAP32[$5 >> 2] = (HEAP32[$5 >> 2] + 1) | 0; return 0; }   // [region-debug] nogen
        const packed = map.get(pc);
        if (packed === undefined) { HEAP32[$3 >> 2] = (HEAP32[$3 >> 2] + 1) | 0; return 0; }  // [region-debug] miss
        const g   = packed >>> 16;
        const idx = packed & 0xFFFF;
        const gen = Module.bemental_gens && Module.bemental_gens[g];
        if (!gen) { HEAP32[$5 >> 2] = (HEAP32[$5 >> 2] + 1) | 0; return 0; }   // [region-debug] nogen (stale)
        try {
            let next;
            if (gen.merged) {
                gen.entrySel.value = idx | 0;
                next = gen.regionFn() >>> 0;
            } else {
                next = gen.fns[idx]() >>> 0;
            }
            HEAP32[outPtr >>> 2] = next | 0;
            HEAP32[$4 >> 2] = (HEAP32[$4 >> 2] + 1) | 0;   // [region-debug] hit
            return 1;
        } catch (e) {
            if (Module.bemental_region_traps === undefined) Module.bemental_region_traps = 0;
            Module.bemental_region_traps++;
            if (Module.bemental_region_traps <= 16) {
                console.error('[bemental] sealed gen', g, 'dispatch trap pc=0x'
                    + pc.toString(16) + ' idx=' + idx
                    + ' msg=' + (e && e.message ? e.message : String(e)));
            }
            return 0;
        }
    }, (int)pc, out, /*$2 unused*/0,
       &g_rd_miss, &g_rd_hit, &g_rd_nogen) != 0;
#else
    (void)pc; (void)out;
    return false;
#endif
}

void BlockCache::region_drop(Region r) {
    if (r >= REGION_COUNT) return;
    RegionState& rs = m_regions[r];
#ifdef __EMSCRIPTEN__
    if (rs.module_handle >= 0) {
        EM_ASM({
            const r = $0 | 0;
            if (Module.bemental_regions && Module.bemental_regions[r]) {
                Module.bemental_regions[r] = null;
                delete Module.bemental_regions[r];
            }
        }, (int)r);
    }
#endif
    rs.fn_bodies_concat.clear();
    rs.pc_keys.clear();
    rs.n_funcs                 = 0u;
    rs.blocks_since_link       = 0u;
    rs.last_accum_ms           = 0.0;
    rs.module_handle           = -1;
    rs.generation              = 0;
    rs.last_relink_ms          = 0.0;
    rs.dispatches_since_relink = 0u;
}

std::size_t BlockCache::region_n_funcs(Region r) const {
    if (r >= REGION_COUNT) return 0u;
    return m_regions[r].n_funcs;
}

int BlockCache::region_generation(Region r) const {
    if (r >= REGION_COUNT) return 0;
    return m_regions[r].generation;
}

} // namespace bemental

// rec_wasm.cpp — Sh4Dynarec implementation for the wasm32 (Emscripten) target.
//
// Lives in flycast-bridge/ per the no-patching-upstream rule. Compiled into
// the libretro target by patches/0003 when ARCHITECTURE contains "wasm32".
//
// nasomers-pattern single-worker bridge:
//   - compile() builds a per-block WASM module via bemental::sh4::build_block,
//     hands the bytes to JS via wasm_install_block (EM_JS) which compiles +
//     instantiates + adds the "run" export to the shared wasmTable and
//     returns its table index. The C side registers that index (cast to a
//     BlockFn pointer) in a vaddr-keyed open-addressed hash table.
//   - block->code points at a single shared trampoline. The trampoline reads
//     PC out of Sh4cntx, calls jit_lookup(pc) to fetch the function pointer,
//     and invokes it; the wasm toolchain lowers the indirect call into a
//     `call_indirect` against the SAME shared wasmTable — no EM_JS hop at
//     dispatch time. The compiled module's emitBlockExit updates Sh4cntx.pc.
//   - mainloop() is a real loop (not a stub): it dispatches blocks until
//     CpuRunning goes false, mirroring the per-arch mainloops in rec-x64 etc.
//
// The JS side (flycast_worker_funcs.js) owns the WebAssembly.Module / Instance
// caches; the EM_JS bodies call out to that file's module-scope state.

#include "build.h"

#if FEAT_SHREC == DYNAREC_JIT && HOST_CPU == CPU_WASM

#include "types.h"
#include "hw/sh4/sh4_if.h"
#include "hw/sh4/sh4_core.h"
#include "hw/sh4/sh4_interrupts.h"
#include "hw/sh4/sh4_mem.h"
#include "hw/sh4/sh4_interpreter.h"
#include "hw/sh4/dyna/ngen.h"
#include "hw/sh4/dyna/blockmanager.h"
#include "hw/mem/addrspace.h"
#include "hw/pvr/pvr_mem.h"
#include "hw/aica/aica_if.h"
#include "hw/holly/sb.h"
#include "hw/holly/holly_intc.h"
#include "hw/pvr/pvr_regs.h"
#include "hw/sh4/sh4_sched.h"
#include "log/Log.h"
#include "oslib/host_context.h"

// bementalJITSh4 adds guests/sh4/ to its PUBLIC include path; rec_wasm.cpp
// is compiled into a target that links bementalJITSh4, so the bare include
// resolves. Mirrors how Dolphin's JitWasm.cpp includes "gekko_emit.h".
#include "wasm_emit.h"

#include <emscripten.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

// ---------------------------------------------------------------------------
// JS bridge: register / dispatch a per-block WASM module.
//
// EM_JS bodies live inside flycast_worker_funcs.js's module scope (post-js'd
// into the same factory), so they can reach the `flycast_block_modules` /
// `flycast_block_instances` Maps and the shared `flycast_wasm_imports`
// import object defined there. Doing the heavy lifting in funcs.js (rather
// than inlining everything here) keeps the EM_JS bodies short and lets us
// edit the JS side without touching C++.
// ---------------------------------------------------------------------------

// nasomers-pattern install: compile + instantiate a per-block WASM module on
// the JS side, grow the shared wasmTable, and return the new table index.
// The C-side dispatcher in wasm_block_trampoline calls the returned index as
// a function pointer; the WASM toolchain lowers that to a `call_indirect`
// against the same shared table, with NO JS hop at dispatch time. Returns
// 0 (sentinel — slot 0 is unused) on failure; the last error message can be
// retrieved via wasm_dispatcher_get_last_error.
EM_JS(int, wasm_install_block, (uintptr_t bytesPtr, int len, uint32_t vaddr), {
  if (typeof flycast_install_block !== 'function') return 0;
  return flycast_install_block(bytesPtr | 0, len | 0, vaddr >>> 0) | 0;
});

// F1 (shard install) — compile + instantiate a multi-block WASM module
// containing N exported run_0..run_<N-1> functions. The JS side grows
// wasmTable by N contiguously, populates the slots from the export map, and
// returns the BASE table index (which is the function pointer for run_0;
// run_i lives at base+i). Returns 0 (sentinel) on failure; the same
// flycast_last_register_error stash used by install_block carries the message.
EM_JS(int, wasm_install_shard, (uintptr_t bytesPtr, int len,
                                uintptr_t vaddrsPtr, int count), {
  if (typeof flycast_install_shard !== 'function') return 0;
  return flycast_install_shard(bytesPtr | 0, len | 0,
                               vaddrsPtr | 0, count | 0) | 0;
});

// Retrieves the last register-block error message from JS into a C buffer.
// JS-side stash is `flycast_last_register_error` (set in the catch arm of
// flycast_register_block). Returns the string length written (excluding NUL).
EM_JS(int, wasm_dispatcher_get_last_error,
      (char* dst, int max_len),
{
    var s = (typeof flycast_last_register_error === 'string')
              ? flycast_last_register_error : '';
    var n = Math.min(s.length, max_len - 1);
    for (var i = 0; i < n; i++) {
        HEAPU8[((dst >>> 0) + i) >>> 0] = s.charCodeAt(i) & 0xff;
    }
    HEAPU8[((dst >>> 0) + n) >>> 0] = 0;
    return n;
});

// ---------------------------------------------------------------------------
// Compiled-block byte store. Kept around for diagnostics / future "dump
// compiled blocks" tooling. The JS side already owns the live Module+Instance
// caches, but stashing the raw bytes lets us re-register or hex-dump after
// the fact without re-running build_block.
// ---------------------------------------------------------------------------
static std::unordered_map<u32, std::vector<u8>> g_compiled_blocks;

// ---------------------------------------------------------------------------
// nasomers-pattern direct table-call dispatch.
//
// Each compiled block becomes its own tiny WebAssembly.Module instantiated by
// the JS side; the resulting "run" export is added to the shared wasmTable
// and its table index is handed back to C. C-side maps vaddr → table index
// (cast to a `BlockFn` function pointer — on wasm32 a function pointer IS
// its table index, that's how `call_indirect` works). The dispatcher calls
// the pointer directly; the wasm toolchain lowers that to a `call_indirect`
// against the same shared table — no JS hop, no per-instance V8 cache miss.
//
// Lookup is a power-of-two open-addressed table with linear probing. Hash =
// Knuth multiplicative on the SH4 vaddr; 65536 slots is enough headroom for
// the SAB/PSO live block count (~3-5k) at <10% load factor with very low
// probe-length. Probe limit caps worst-case lookup at 8 steps; on miss we
// fall through to the standard cache-miss path which recompiles + re-installs.
// ---------------------------------------------------------------------------
typedef u32 (*BlockFn)(u32 ctx, u32 ram_base);

static constexpr u32 JIT_TABLE_SIZE  = 262144;  // bumped 4× from 65536 — PSO saturated 64K, ~327K re-compile attempts/30s probing
static constexpr u32 JIT_TABLE_MASK  = JIT_TABLE_SIZE - 1;
static constexpr u32 JIT_PROBE_LIMIT = 8;

static BlockFn  s_block_fn[JIT_TABLE_SIZE];
static uint32_t s_block_pc[JIT_TABLE_SIZE];   // 0 = empty slot
static uint32_t s_block_count = 0;            // installed-block tally for diag

static inline u32 jit_hash(u32 vaddr) {
    return (vaddr * 2654435761u) & JIT_TABLE_MASK;
}

static BlockFn jit_lookup(u32 vaddr) {
    u32 h = jit_hash(vaddr);
    for (u32 i = 0; i < JIT_PROBE_LIMIT; i++) {
        u32 slot = (h + i) & JIT_TABLE_MASK;
        if (s_block_pc[slot] == vaddr) return s_block_fn[slot];
        if (s_block_pc[slot] == 0)     return nullptr;
    }
    return nullptr;
}

static bool jit_register(u32 vaddr, BlockFn fn) {
    u32 h = jit_hash(vaddr);
    for (u32 i = 0; i < JIT_PROBE_LIMIT; i++) {
        u32 slot = (h + i) & JIT_TABLE_MASK;
        if (s_block_pc[slot] == 0) {
            s_block_fn[slot] = fn;
            s_block_pc[slot] = vaddr;
            ++s_block_count;
            return true;
        }
        if (s_block_pc[slot] == vaddr) {
            s_block_fn[slot] = fn;  // refresh — no count bump
            return true;
        }
    }
    return false;  // probe-limit hit — caller falls back to interp this iter
}

static void jit_clear() {
    memset(s_block_fn, 0, sizeof(s_block_fn));
    memset(s_block_pc, 0, sizeof(s_block_pc));
    s_block_count = 0;
}

// Removes a single vaddr's block from BOTH bementalJIT's jit_register table
// AND flycast's blkmap/FPCA, so the next dispatch re-enters compile() cleanly.
// Used by bementalJIT's outer-memcpy detector (option D) to invalidate block B
// once block A has been seen and cached: block B was originally compiled
// before block A in PSO's boot flow, so its first emit didn't have block A's
// shape data in cache. Forcing a full recompile lets the fast-path fire on
// the next dispatch.
//
// Both tables must be cleared together — clearing only ours leaves flycast's
// bm_AddBlock-time verify (`bm_GetCode == ngen_FailedToFindBlock`) tripping
// on the next compile attempt for the same vaddr.
extern "C" void bemental_jit_invalidate(u32 vaddr) {
    if (vaddr == 0) return;

    // 1. Clear bementalJIT's shadow table entry.
    u32 h = jit_hash(vaddr);
    for (u32 i = 0; i < JIT_PROBE_LIMIT; i++) {
        u32 slot = (h + i) & JIT_TABLE_MASK;
        if (s_block_pc[slot] == vaddr) {
            s_block_pc[slot] = 0;
            s_block_fn[slot] = nullptr;
            if (s_block_count > 0) --s_block_count;
            break;
        }
        if (s_block_pc[slot] == 0) break;   // empty slot — not in table
    }

    // 2. Discard from flycast's blkmap + FPCA so bm_AddBlock can re-register.
    DynarecCodeEntryPtr cde = bm_GetCodeByVAddr(vaddr);
    if (cde != ngen_FailedToFindBlock) {
        RuntimeBlockInfoPtr blkPtr = bm_GetBlock((void*)cde);
        if (blkPtr) {
            bm_DiscardBlock(blkPtr.get());
        }
    }
}

// Forward decls — `seal_pending_shard` below references these; actual
// definitions are further down in this file (g_diag_enabled at ~297,
// g_cb_disp_count at ~312). Forward-declaring here keeps W7's shard manager
// order-independent of the cost-breakdown counter block.
extern "C" {
    extern volatile bool g_diag_enabled;
    extern std::atomic<uint64_t> g_cb_disp_count;
}

// ---------------------------------------------------------------------------
// F1 — Sharded compilation state. Until s_pending_shard reaches
// SHARD_BLOCK_CAP entries (or a dispatch-count fallback triggers), newly
// compiled blocks stay queued and `jit_lookup` returns null for them; the
// dispatcher falls through to interp via the existing rdv_FailedToFindBlock_pc
// path. Once sealed, all N blocks become live in a single atomic install.
//
// Gated behind FLYCAST_SHARD=1 (default OFF). When disabled the legacy
// per-block install path runs untouched.
//
// SHARD_BLOCK_CAP=256 mirrors the wave-2 plan: large enough to amortize the
// WebAssembly.Module compile cost across many blocks (≈80-100ms cold-start),
// small enough that idle phases still seal eventually via the dispatch-count
// fallback. Each shard, once built, is IMMUTABLE — no incremental additions.
// ---------------------------------------------------------------------------
// Bumped 256 -> 1024 (2026-05-18 lever #3). PSO boot compiles ~289 blocks
// per [stats]; at 256 those split across 2 shards = 2 WebAssembly.Instances,
// every cross-shard dispatch eats the V8 cross-instance call_indirect deopt
// (phase1-feasibility.md). At 1024, all PSO boot blocks land in a single
// instance, eliminating cross-shard call_indirect entirely.
static constexpr u32 SHARD_BLOCK_CAP = 4096;
// Fallback seal trigger: if at least one block sits pending and this many
// dispatches have elapsed without the shard filling, force a seal. Stops
// blocks from sitting in pending forever during low-rate boot phases.
static constexpr u64 SHARD_DISPATCH_SEAL = 1000000;  // bumped from 100K — was causing 1534 seals/30s = 51/sec Module-creates, dominating dispatch cost

static std::vector<RuntimeBlockInfo*> s_pending_shard;
static u64 s_dispatches_at_last_seal = 0;

// [2026-05-19] Forcing shard ON validated the path engages (124 seals fired in 60s)
// but reproduces the compile-churn problem the comment warned about — pre bucket
// exploded to 23793 ns/disp, total dispatches dropped 13× vs baseline. Reverting
// to original env-gated default OFF until the persistent vaddr→shard-fn registry
// (or another seal-churn fix) lands. Note: env var FLYCAST_SHARD does NOT
// propagate through emcc's getenv() to wasm runtime — fix that mechanism if
// you want to use the env-gate path.
// [2026-05-19] Forcing shard ON validated the path engages (124 seals fired in 60s)
// but reproduces the compile-churn problem the comment warned about — pre bucket
// exploded to 23793 ns/disp, total dispatches dropped 13× vs baseline. The
// "persistent vaddr→shard-fn registry" fix attempted (kept the funcref in a map
// across flycast cache flushes, short-circuited compile() on re-issue) DID NOT
// HELP — 261K unique jit_register calls in 60s still happened, same regression.
// Reverting to env-gated default OFF.
static bool s_shard_enabled = []{
    const char* e = std::getenv("FLYCAST_SHARD");
    return e && e[0] != '0';
}();

// g_cb_disp_count is defined above at line ~195 inside the extern "C" block;
// we read it (no forward decl needed) to drive the SHARD_DISPATCH_SEAL
// fallback so a low-rate boot phase doesn't leave blocks pending forever.

static void seal_pending_shard() {
    if (s_pending_shard.empty()) return;

    std::vector<u8> bytes = bemental::sh4::build_blocks(s_pending_shard);

    std::vector<u32> vaddrs;
    vaddrs.reserve(s_pending_shard.size());
    for (auto* b : s_pending_shard) vaddrs.push_back(b->vaddr);

    const int count = (int)s_pending_shard.size();
    const int base_idx = wasm_install_shard(
        (uintptr_t)bytes.data(), (int)bytes.size(),
        (uintptr_t)vaddrs.data(), count);

    if (base_idx > 0) {
        for (int i = 0; i < count; ++i) {
            BlockFn fn = reinterpret_cast<BlockFn>(
                static_cast<uintptr_t>(base_idx + i));
            if (!jit_register(s_pending_shard[i]->vaddr, fn)) {
                // Probe-limit hit — drop this one; next dispatch retries
                // via the standard miss path.
                static int s_probe_log = 0;
                if (g_diag_enabled && s_probe_log < 4) {
                    s_probe_log++;
                    MAIN_THREAD_EM_ASM({
                        postMessage({cmd:'print', txt:
                            '[rec_wasm-shard] jit_register probe-limit vaddr=0x' +
                            ($0 >>> 0).toString(16)});
                    }, (int)s_pending_shard[i]->vaddr);
                }
            }
        }
        if (g_diag_enabled) {
            MAIN_THREAD_EM_ASM({
                postMessage({cmd:'print', txt:
                    '[rec_wasm-shard] sealed count=' + ($0|0) +
                    ' base_idx=' + ($1|0) +
                    ' bytes=' + ($2|0)});
            }, count, base_idx, (int)bytes.size());
        }
    } else {
        // Install failed — pull last error and log. Compiled blocks fall
        // back to interp via the dispatcher's standard miss path.
        static int s_inst_log = 0;
        if (g_diag_enabled && s_inst_log < 4) {
            s_inst_log++;
            char err[256] = {0};
            wasm_dispatcher_get_last_error(err, sizeof(err));
            MAIN_THREAD_EM_ASM({
                var errPtr = $0;
                var errStr = '';
                var i = 0;
                while (HEAPU8[errPtr+i] !== 0 && i < 256) {
                    errStr += String.fromCharCode(HEAPU8[errPtr+i]);
                    i++;
                }
                postMessage({cmd:'print', txt:
                    '[rec_wasm-shard] install_shard FAILED #' + ($1|0) +
                    ' count=' + ($2|0) +
                    ' bytes=' + ($3|0) +
                    ' err="' + errStr + '"'});
            }, (uintptr_t)err, s_inst_log, count, (int)bytes.size());
        }
        WARN_LOG(DYNAREC, "[rec_wasm-shard] install_shard FAILED count=%d bytes=%zu",
                 count, bytes.size());
    }

    s_pending_shard.clear();
    s_dispatches_at_last_seal = g_cb_disp_count.load(std::memory_order_relaxed);
}


// Runtime-toggleable diagnostic gate. When false, all stats / GDROM /
// per-1000 PC sampler logs are suppressed at near-zero cost (single load
// + branch). Counters keep advancing so a later flycast_diag_set(1) gives
// continuous numbers. Toggleable from JS via _flycast_diag_set(0|1).
extern "C" {
// Default OFF — page console can't keep up with per-1000 sampler at 380K disp/s
// (overflows V8's console buffer and crashes the tab "Aw, Snap!" Error code 5).
// Toggle from page: window.flycastWorker.postMessage({cmd:'diag', on:1}) or
// build_and_probe.sh enables it for the headless probe.
volatile bool g_diag_enabled = false;
std::atomic<uint64_t> g_ifb_count{0};
std::atomic<uint64_t> g_exc_count{0};
EMSCRIPTEN_KEEPALIVE void flycast_diag_set(int on) { g_diag_enabled = !!on; }
EMSCRIPTEN_KEEPALIVE uint64_t flycast_diag_ifb(void) { return g_ifb_count.load(); }

// Interpreter-only mode. When set, wasm_block_trampoline bypasses the JIT path
// entirely and routes every dispatch through Sh4Interpreter::Step() (one SH4
// op per call). Empirical anchor: nasomers/flycast-wasm (NO_REC=1) ships at
// 20–40 FPS on PSO with this exact path. Toggleable from JS via
// _flycast_set_interp_only(0|1). Default OFF.
volatile bool g_interp_only = false;
std::atomic<uint64_t> g_interp_step_count{0};
EMSCRIPTEN_KEEPALIVE void flycast_set_interp_only(int on) { g_interp_only = !!on; }
EMSCRIPTEN_KEEPALIVE uint64_t flycast_interp_step_count(void) { return g_interp_step_count.load(); }

// Dense PC-trace prefix. When non-zero, the PC sampler dumps every dispatch
// (instead of the default every-1000 stride) for the first N dispatches. Used
// to find the first JIT-vs-interp divergence point. Cost is ~100-400 µs/dump
// (proxied postMessage); a value of 5000 adds ~1s probe overhead.
volatile uint32_t g_pc_trace_until = 0;
EMSCRIPTEN_KEEPALIVE void flycast_set_pc_trace_until(uint32_t n) { g_pc_trace_until = n; }

// ---------------------------------------------------------------------------
// Per-phase cost-breakdown counters. Populated by the mainloop + trampoline
// when DEBUG_DISPATCH is on, dumped every 100K dispatches. Goal: split the
// ~100µs/dispatch wall-clock cost into bm-lookup, EM_JS round-trip, JS+wasm
// call, and writeback so we can pick the right optimization without guessing.
//
// Units: nanoseconds (emscripten_get_now() returns ms double; we multiply by
// 1e6 when accumulating to keep all counters integer for cheap atomic ops).
// ---------------------------------------------------------------------------
std::atomic<uint64_t> g_cb_disp_count{0};        // dispatches sampled
std::atomic<uint64_t> g_cb_bm_lookup_ns{0};      // bm_GetCodeByVAddr
std::atomic<uint64_t> g_cb_tramp_total_ns{0};    // wasm_block_trampoline() outer
std::atomic<uint64_t> g_cb_tramp_pre_ns{0};      // C-side prep before EM_JS
std::atomic<uint64_t> g_cb_tramp_emjs_ns{0};     // EM_JS call (JS lookup + wasm call + return)
std::atomic<uint64_t> g_cb_tramp_call_ns{0};     // fn() call_indirect into compiled block (excl. surrounding work)
std::atomic<uint64_t> g_cb_tramp_post_ns{0};     // PC writeback after EM_JS returns
std::atomic<uint64_t> g_cb_drain_ns{0};          // wrapper-gap: diag samplers + ring writes between ++dispatch and trampoline
std::atomic<uint64_t> g_cb_spg_ns{0};            // wrapper-gap: cycle_counter <= 0 branch (cycle refill + SPG raise + INTC pump)
std::atomic<uint64_t> g_cb_stats_ns{0};          // wrapper-gap: wall-time-gated [stats] flush block
std::atomic<uint64_t> g_cb_outer_ns{0};          // FULL inner-while iteration top-to-bottom — diagnoses the unaccounted ~51% wall gap
std::atomic<uint64_t> g_cb_mem_read_calls{0};    // sh4_mem_read* import hits
std::atomic<uint64_t> g_cb_mem_write_calls{0};   // sh4_mem_write* import hits
}

// Per-area (addr>>26) bucketed mem-import counters live in EmscriptenWorker.cpp
// (the file that owns the sh4_mem_read*/write* wrappers). Forward-declare so
// the [cost-breakdown] log below can read them. Gated extern so a non-DIAG
// build doesn't drag in unresolved refs.
#ifdef FLYCAST_BRIDGE_DIAG
extern "C" {
extern std::atomic<uint64_t> g_cb_mem_read_by_area[64];
extern std::atomic<uint64_t> g_cb_mem_write_by_area[64];
}
#endif

// ---------------------------------------------------------------------------
// Shared trampoline. Every successfully-compiled block's RuntimeBlockInfo::code
// points here. We read PC out of Sh4cntx, look up the compiled block's table
// index via jit_lookup, and call the function pointer directly. The wasm
// toolchain lowers the indirect call into a `call_indirect` against the same
// shared wasmTable used by JS install — no EM_JS hop at dispatch time.
//
// The compiled block's "run" export updates Sh4cntx.pc itself (via emitBlockExit
// in bementalJIT/guests/sh4/wasm_emit.cpp). The return value (next_pc) is the
// same PC value Sh4cntx.pc was just written to — we mirror it back to Sh4cntx
// defensively so a misbehaving emitBlockExit can't desync the dispatcher.
//
// Sh4cntx is a macro for p_sh4rcb->cntx; p_sh4rcb is a global set up at SH4
// init time, so the trampoline can look it up cheaply on every call.
// ---------------------------------------------------------------------------
static void wasm_block_trampoline()
{
#ifdef DEBUG_DISPATCH
    const double tA = emscripten_get_now();
#endif
    Sh4Context* ctx = &Sh4cntx;
    const u32 pc = ctx->pc;

    // Interp-only short-circuit. Bypasses jit_lookup / compile / call_indirect
    // entirely; advances PC by exactly one SH4 op via Sh4Interpreter::Step().
    // Sh4Interpreter::Instance is wired in mainloop() at startup
    // (Sh4Interpreter::Instance = Sh4Recompiler::Instance), so it is non-null
    // by the time the trampoline is reachable.
    if (g_interp_only) {
        if (Sh4Interpreter::Instance) {
            Sh4Interpreter::Instance->Step();
            g_interp_step_count.fetch_add(1, std::memory_order_relaxed);
        } else {
            ctx->pc = pc + 2;
        }
        return;
    }
    // Area-3 RAM fast-path in bementalJIT/guests/sh4/wasm_emit.cpp uses
    // `LOCAL_RAM + (addr & 0x00FFFFFF)` as the linear-memory offset for guest
    // RAM reads/writes. LOCAL_RAM is param #1 of the compiled "run" export.
    // Flycast allocates `mem_b` (the 16 MB system RAM buffer) via host malloc
    // — its address is whatever emcc's heap returned, NOT 0. Passing 0 made
    // the JIT read/write `wasmMemory[0..16MB]` while host-side disc DMAs
    // landed in `mem_b`. GetMemPtr(0x0c000000,1) returns &mem_b[0]; cast to
    // uintptr_t is the linear-memory offset of the RAM buffer.
    static uintptr_t s_ram_base = 0;
    if (!s_ram_base) {
        s_ram_base = (uintptr_t)GetMemPtr(0x0c000000, 1);
        // GetMemPtr only resolves area-3 (sh4_mem.cpp:277-291). The build
        // path is `ram_base == nullptr` (nvmem disabled per the [flycast.log]
        // line), so addrspace::getAddress returns all nulls. Read the
        // VRAM/RAM regions directly off the global RamRegion instances —
        // under emcc these data pointers ARE linear-memory offsets.
        const uintptr_t pVram  = (uintptr_t)&vram[0];
        const uintptr_t pMem   = (uintptr_t)&mem_b[0];
        const uintptr_t pAica  = (uintptr_t)&aica::aica_ram[0];
        // Expose VRAM linear-mem offset to the SH4 emitter so it can bake
        // an area-4/5 i32.store fastpath into compiled blocks. Read by
        // bementalJIT/guests/sh4/wasm_emit.cpp via extern.
        bemental::sh4::g_vram_lin_base = (u32)pVram;
        MAIN_THREAD_EM_ASM({
            postMessage({cmd:'print', txt:
                '[mem-map] ram=0x' + ($0>>>0).toString(16) +
                ' &mem_b[0]=0x' + ($1>>>0).toString(16) +
                ' &vram[0]=0x' + ($2>>>0).toString(16) +
                ' &aica_ram[0]=0x' + ($3>>>0).toString(16)});
        }, (int)s_ram_base, (int)pMem, (int)pVram, (int)pAica);
    }

    // ---- One-shot snapshot for the 0x8c02ab4c wedge investigation. ----
    // Captures all 16 GPRs + PR + 64B of OUR-RAM at the wedge PC window
    // (0x8c02ab30..0x8c02ab6f) + 64B at the PR target (0x8c020000..0x8c02003f)
    // so we can sh4dis both. Once-only; gated by static bool so it can't spam.
    static bool s_xab4c_dumped = false;
    if (!s_xab4c_dumped && pc == 0x8c02ab4cu) {
        s_xab4c_dumped = true;
        const u8* code_a = (const u8*)s_ram_base + 0x2ab30;
        const u8* code_b = (const u8*)s_ram_base + 0x20000;
        const u8* code_c = (const u8*)s_ram_base + 0x2c150;
        char hex_a[160] = {0}, hex_b[160] = {0}, hex_c[160] = {0};
        for (int i = 0; i < 64; ++i) {
            snprintf(hex_a + i*2, 4, "%02x", code_a[i]);
            snprintf(hex_b + i*2, 4, "%02x", code_b[i]);
            snprintf(hex_c + i*2, 4, "%02x", code_c[i]);
        }
        char buf[768];
        snprintf(buf, sizeof(buf),
            "[xab4c-snap] pc=%08x r0=%08x r1=%08x r2=%08x r3=%08x "
            "r4=%08x r5=%08x r6=%08x r7=%08x r8=%08x r9=%08x r10=%08x "
            "r11=%08x r12=%08x r13=%08x r14=%08x r15=%08x pr=%08x "
            "ram_2ab30=%s ram_20000=%s ram_2c150=%s",
            pc,
            ctx->r[0],  ctx->r[1],  ctx->r[2],  ctx->r[3],
            ctx->r[4],  ctx->r[5],  ctx->r[6],  ctx->r[7],
            ctx->r[8],  ctx->r[9],  ctx->r[10], ctx->r[11],
            ctx->r[12], ctx->r[13], ctx->r[14], ctx->r[15],
            ctx->pr, hex_a, hex_b, hex_c);
        MAIN_THREAD_EM_ASM({
            postMessage({cmd:'print', txt: UTF8ToString($0)});
        }, buf);
    }

    BlockFn fn = jit_lookup(pc);
    if (!fn) {
        // Cold block — ask the block manager to compile via the standard
        // Flycast miss path. compile() will install via wasm_install_block
        // and call jit_register. Re-lookup after; if STILL nothing (probe-
        // limit collision, install failure, etc.) single-step the next
        // instruction so we don't spin. SH4 insn width is 2 bytes; that
        // matches the historical EM_JS fallback's `vaddr + 2`.
        rdv_FailedToFindBlock_pc();
        fn = jit_lookup(pc);
        if (!fn) {
            ctx->pc = pc + 2;
#ifdef DEBUG_DISPATCH
            const double tD = emscripten_get_now();
            g_cb_tramp_pre_ns.fetch_add ((uint64_t)((tD - tA) * 1e6), std::memory_order_relaxed);
#endif
            return;
        }
    }
#ifdef DEBUG_DISPATCH
    const double tB = emscripten_get_now();
#endif
    const u32 next_pc_raw = fn((u32)(uintptr_t)ctx, (u32)s_ram_base);
#ifdef DEBUG_DISPATCH
    const double tC = emscripten_get_now();   // immediately after fn() returns
#endif
    // Mask bit 0 of next PC. Real SH4 hardware always fetches instructions
    // at (PC & ~1) — the LSB of PC is ignored by the fetch unit. Flycast's
    // decoder generates `dec_DynamicSet(reg_r0+n)` for JMP/JSR/RTS/RTE
    // (decoder.cpp:159,182,188) with NO masking, relying on hardware
    // tolerance. Our SHIL emit (wasm_emit.cpp:379) also passes the raw
    // value through to JDYN. Without masking, an odd target lands the
    // dispatcher at an odd PC, decoder reads misaligned 16-bit words,
    // produces nonsense -> IFB throws Sh4Ex_IllegalInstr at vbr+0x100,
    // Reios doesn't install a handler there, fatal. Diagnosed 2026-05-15
    // when IP.BIN under Reios faulted at spc=0x8c009dd1 (odd).
    const u32 next_pc = next_pc_raw & ~1u;
    // Defensive PC mirror — the WASM module already wrote ctx->pc, but if a
    // future code path returns next_pc without storing it (or vice versa),
    // we want the dispatcher to keep moving rather than spin on a stale PC.
    ctx->pc = next_pc;
#ifdef DEBUG_DISPATCH
    // One-shot stuck-PC RAM dump. Window-based: when dispatches stay within
    // the same 256-byte aligned window for 200K iters, dump 32B of code at
    // next_pc, 8B at r0 (the polled addr), the recent distinct-PC ring (full
    // loop body), and ctx->sr (so we can tell exception-handler wedges from
    // normal polling). Catches multi-PC tight loops the old exact-match
    // detector missed.
    {
        static u32  s_window_base = 0;
        static bool s_window_init = false;
        static u64  s_window_count = 0;
        static bool s_dumped = false;
        // Distinct-PC ring buffer (size 8, dedup-on-insert so a 5-7-PC tight
        // loop fills it once and stops churning — we want loop body identity,
        // not a raw dispatch trace).
        static constexpr unsigned RING_SZ = 8;
        static u32  s_pc_ring[RING_SZ] = {0};
        static unsigned s_pc_ring_head = 0; // next write slot
        static unsigned s_pc_ring_count = 0; // valid entries (saturates at RING_SZ)
        const u32 win = next_pc & ~0xFFu;
        if (!s_window_init) {
            s_window_init = true;
            s_window_base = win;
            s_window_count = 1;
        } else if (win == s_window_base) {
            s_window_count++;
        } else {
            s_window_base = win;
            s_window_count = 1;
            // Reset ring on window change — old PCs are from a different loop.
            s_pc_ring_head = 0;
            s_pc_ring_count = 0;
            for (unsigned i = 0; i < RING_SZ; i++) s_pc_ring[i] = 0;
        }
        // Dedup-on-insert into ring.
        {
            bool seen = false;
            for (unsigned i = 0; i < s_pc_ring_count; i++) {
                if (s_pc_ring[i] == next_pc) { seen = true; break; }
            }
            if (!seen) {
                s_pc_ring[s_pc_ring_head] = next_pc;
                s_pc_ring_head = (s_pc_ring_head + 1) % RING_SZ;
                if (s_pc_ring_count < RING_SZ) s_pc_ring_count++;
            }
        }
        // Periodic snapshots every 100K dispatches in the window, up to 20.
        // Captures R5/R4 trajectory so we can tell: (a) R5 monotonically
        // decreasing to 0 = function legitimately progressing; (b) R5 stuck =
        // JIT bug; (c) R5 oscillating = function being called repeatedly with
        // R5 reset each time.
        static unsigned s_snap_count = 0;
        if (s_window_count > 0 && (s_window_count % 100000) == 0 && s_snap_count < 20) {
            s_snap_count++;
            if (s_snap_count >= 20) s_dumped = true;
            const u32 code_off = (next_pc & 0x00FFFFFF);
            const u8* code = (const u8*)s_ram_base + code_off;
            const u32 r0    = ctx->r[0];
            const u32 r0_off= (r0 & 0x00FFFFFF);
            const u8* r0p   = (const u8*)s_ram_base + r0_off;
            const u32 sr_full = ctx->sr.getFull();
            // Print all 16 GPRs + sr.T separately as a second postMessage so the
            // delta between 100K-snap and 200K-snap is easy to grep.
            {
                char rbuf[512];
                int ro = snprintf(rbuf, sizeof(rbuf),
                    "[stuck-pc-regs] snap=%llu pc=0x%08x sr_T=%u r0=%08x r1=%08x r2=%08x r3=%08x r4=%08x r5=%08x r6=%08x r7=%08x r8=%08x r9=%08x r10=%08x r11=%08x r12=%08x r13=%08x r14=%08x r15=%08x pr=%08x",
                    (unsigned long long)s_window_count, next_pc, (unsigned)ctx->sr.T,
                    ctx->r[0],  ctx->r[1],  ctx->r[2],  ctx->r[3],
                    ctx->r[4],  ctx->r[5],  ctx->r[6],  ctx->r[7],
                    ctx->r[8],  ctx->r[9],  ctx->r[10], ctx->r[11],
                    ctx->r[12], ctx->r[13], ctx->r[14], ctx->r[15],
                    ctx->pr);
                (void)ro;
                MAIN_THREAD_EM_ASM({
                    var s = UTF8ToString($0);
                    postMessage({cmd:'print', txt: s});
                }, rbuf);
            }
            if (s_window_count != 200000) return;  // skip the rest at 100K snap
            char buf[768];
            int off = snprintf(buf, sizeof(buf),
                "[stuck-pc] window=0x%08x repeats=%llu sr=0x%08x pc=0x%08x code32: %02x%02x %02x%02x %02x%02x %02x%02x %02x%02x %02x%02x %02x%02x %02x%02x  %02x%02x %02x%02x %02x%02x %02x%02x %02x%02x %02x%02x %02x%02x %02x%02x  r0=0x%08x: %02x%02x %02x%02x %02x%02x %02x%02x  ring(%u):",
                s_window_base, (unsigned long long)s_window_count, sr_full, next_pc,
                code[0],code[1],code[2],code[3],code[4],code[5],code[6],code[7],
                code[8],code[9],code[10],code[11],code[12],code[13],code[14],code[15],
                code[16],code[17],code[18],code[19],code[20],code[21],code[22],code[23],
                code[24],code[25],code[26],code[27],code[28],code[29],code[30],code[31],
                r0,
                r0p[0],r0p[1],r0p[2],r0p[3],r0p[4],r0p[5],r0p[6],r0p[7],
                s_pc_ring_count);
            // Append ring entries in insertion order (oldest first).
            const unsigned start = (s_pc_ring_count < RING_SZ)
                ? 0
                : s_pc_ring_head;
            for (unsigned i = 0; i < s_pc_ring_count && off > 0 && off < (int)sizeof(buf); i++) {
                unsigned idx = (start + i) % RING_SZ;
                off += snprintf(buf + off, sizeof(buf) - off, " 0x%08x", s_pc_ring[idx]);
            }
            (void)off;
            MAIN_THREAD_EM_ASM({
                var s = UTF8ToString($0);
                postMessage({cmd:'print', txt: s});
            }, buf);
        }
    }
#endif
#ifdef DEBUG_DISPATCH
    const double tD = emscripten_get_now();
    // Decomposition of per-dispatch time. tC was captured immediately after
    // fn() returned (line ~462), so:
    //   pre  = tB - tA  : jit_lookup + ram_base init + xab4c snapshot
    //   call = tC - tB  : the compiled block (fn() body + wasm call_indirect entry/exit)
    //   post = tD - tC  : PC mask + ctx->pc store + stuck-pc diag work
    g_cb_tramp_pre_ns.fetch_add ((uint64_t)((tB - tA) * 1e6), std::memory_order_relaxed);
    g_cb_tramp_call_ns.fetch_add((uint64_t)((tC - tB) * 1e6), std::memory_order_relaxed);
    g_cb_tramp_post_ns.fetch_add((uint64_t)((tD - tC) * 1e6), std::memory_order_relaxed);
#endif
}

// ---------------------------------------------------------------------------
// Sh4Dynarec subclass.
// ---------------------------------------------------------------------------
class WasmDynarec : public Sh4Dynarec
{
public:
	WasmDynarec() {
		sh4Dynarec = this;
	}

	void init(Sh4Context& sh4ctx, Sh4CodeBuffer& codeBuffer) override
	{
		this->sh4ctx = &sh4ctx;
		this->codeBuffer = &codeBuffer;
		INFO_LOG(DYNAREC, "[rec_wasm] init");
	}

	void compile(RuntimeBlockInfo* block, bool /*smc_checks*/, bool /*optimise*/) override
	{
		// Earlier-style 0x8c0133f4 diag dump that lived here was DUPLICATING the
		// build_block() call done below at the per-block install site (line ~715),
		// and the duplicate decl of `bytes` triggered a -Wshadow / redefinition
		// merge collision. The line 715 install path already has a unified diag
		// dump covering 0x8c0133f4, 0x8c02ab4c, 0x8c02c160, 0x8c01a494. Kept here
		// as a placeholder so block-numbers in commit-history grep stay aligned.
		const u32 vaddr = block->vaddr;

		// F1 — Sharded install path. When FLYCAST_SHARD=1, push this
		// block into the pending shard and return early. The shard is
		// sealed (built + installed) once it reaches SHARD_BLOCK_CAP
		// blocks, OR when the dispatch counter has advanced
		// SHARD_DISPATCH_SEAL ticks since the last seal (fallback for
		// low-rate boot phases so blocks don't sit pending forever).
		// Until sealed, jit_lookup returns null and the dispatcher
		// falls through to the standard rdv_FailedToFindBlock_pc path
		// — same as a cold block in the per-block install model.
		//
		// block->code MUST still be set to a unique non-null sentinel —
		// Flycast's bm_AddBlock keys on it (blockmanager.cpp:215-219)
		// and die()s on duplicates / nullptr. The block's heap address
		// is the canonical unique-per-block value (matches the per-block
		// path below).
		if (s_shard_enabled) {
			// Two-level dedup:
			// (1) jit_lookup: if vaddr is already registered (from a prior
			//     sealed shard), don't re-compile. Just set the sentinel and
			//     return so flycast considers it compiled and the dispatcher
			//     finds the existing fn via jit_lookup.
			// (2) s_pending_vaddrs: within the CURRENT pending shard, don't
			//     duplicate-push (flycast's miss path creates fresh
			//     RuntimeBlockInfo* per lookup miss before seal).
			if (jit_lookup(vaddr) != nullptr) {
				block->code           = (DynarecCodeEntryPtr)(uintptr_t)block;
				block->host_code_size = 0;
				block->host_opcodes   = 0;
				return;
			}
			static std::unordered_set<u32> s_pending_vaddrs;
			if (s_pending_vaddrs.insert(vaddr).second) {
				s_pending_shard.push_back(block);
			} else {
				// Already pending — still set the sentinel so flycast doesn't die().
				block->code           = (DynarecCodeEntryPtr)(uintptr_t)block;
				block->host_code_size = 0;
				block->host_opcodes   = 0;
				return;
			}
			if (s_pending_shard.size() >= SHARD_BLOCK_CAP) {
				s_pending_vaddrs.clear();
				seal_pending_shard();
			} else {
				const u64 now = g_cb_disp_count.load(std::memory_order_relaxed);
				if (now - s_dispatches_at_last_seal >= SHARD_DISPATCH_SEAL) {
					s_pending_vaddrs.clear();
					seal_pending_shard();
				}
			}
			block->code           = (DynarecCodeEntryPtr)(uintptr_t)block;
			block->host_code_size = 0;
			block->host_opcodes   = 0;
			return;
		}

		// nasomers-pattern install path. Build the per-block WASM module
		// via bementalJIT, hand it to JS for compile+instantiate+wasmTable
		// install (returns a table index, 0 on failure), then register
		// vaddr -> fn-pointer (which IS the table index on wasm32) in our
		// C-side hash table. wasm_block_trampoline reads ctx->pc, calls
		// jit_lookup(pc), and the wasm toolchain lowers the indirect call
		// into a `call_indirect` against the SAME shared wasmTable — no
		// JS hop at dispatch time.
		std::vector<u8> bytes = bemental::sh4::build_block(block);
		// One-shot block-bytes hexdump for the 0x8c0133f4 memset-loop
		// throughput investigation. Logged once via postMessage; the
		// probe harness greps `[blockdump]` and decodes hex -> .wasm.
		static bool s_dumped_target1 = false;
		static bool s_dumped_target2 = false;
		static bool s_dumped_target3 = false;
		static bool s_dumped_target4 = false;
		const bool dump_now =
			(!s_dumped_target1 && vaddr == 0x8c0133f4u) ||
			(!s_dumped_target2 && vaddr == 0x8c02ab4cu) ||
			(!s_dumped_target3 && vaddr == 0x8c02c160u) ||
			(!s_dumped_target4 && vaddr == 0x8c01a494u);
		if (dump_now) {
			if (vaddr == 0x8c0133f4u) s_dumped_target1 = true;
			if (vaddr == 0x8c02ab4cu) s_dumped_target2 = true;
			if (vaddr == 0x8c02c160u) s_dumped_target3 = true;
			if (vaddr == 0x8c01a494u) s_dumped_target4 = true;
			std::string hex;
			hex.reserve(bytes.size() * 2);
			static const char* kHex = "0123456789abcdef";
			for (u8 by : bytes) {
				hex.push_back(kHex[by >> 4]);
				hex.push_back(kHex[by & 0xF]);
			}
			MAIN_THREAD_EM_ASM({
				var s = '[blockdump] vaddr=0x' + ($0>>>0).toString(16) +
				        ' size=' + ($1|0) +
				        ' hex=' + UTF8ToString($2);
				postMessage({cmd:'print', txt: s});
			}, (int)vaddr, (int)bytes.size(), hex.c_str());
		}
		int idx = wasm_install_block((uintptr_t)bytes.data(),
		                             (int)bytes.size(), vaddr);
		if (idx > 0) {
			// On wasm32, casting a table index to a function pointer is
			// the canonical way to obtain a callable funcref — `BlockFn`
			// matches the (i32 ctx, i32 ram_base) -> i32 ABI of the
			// emitted "run" export. The reverse cast happens implicitly
			// in `call_indirect` lowering.
			BlockFn fn = reinterpret_cast<BlockFn>(static_cast<uintptr_t>(idx));
			if (!jit_register(vaddr, fn)) {
				// Probe-limit hit. Block stays uninstalled; the next
				// dispatch hits the cache-miss path and tries again.
				static int s_probe_log = 0;
				if (g_diag_enabled && s_probe_log < 8) {
					s_probe_log++;
					MAIN_THREAD_EM_ASM({
						postMessage({cmd:'print', txt:
							'[rec_wasm] jit_register probe-limit at vaddr=0x' +
							($0 >>> 0).toString(16) + ' (probe #' + ($1|0) + ')'});
					}, (int)vaddr, s_probe_log);
				}
			}
		} else {
			static int s_inst_log = 0;
			if (g_diag_enabled && s_inst_log < 8) {
				s_inst_log++;
				char err[256] = {0};
				wasm_dispatcher_get_last_error(err, sizeof(err));
				const u32 dump_len = bytes.size() < 32 ? (u32)bytes.size() : 32;
				MAIN_THREAD_EM_ASM({
					var addr = $0;
					var n = $1;
					var hex = '';
					for (var i = 0; i < n; i++) {
						hex += ('0' + HEAPU8[addr+i].toString(16)).slice(-2);
						if (i < n-1) hex += ' ';
					}
					var errPtr = $2;
					var errStr = '';
					var i = 0;
					while (HEAPU8[errPtr+i] !== 0 && i < 256) {
						errStr += String.fromCharCode(HEAPU8[errPtr+i]);
						i++;
					}
					postMessage({cmd: 'print', txt:
						'[rec_wasm] install_block FAILED #' + ($3|0) +
						' vaddr=0x' + ($4 >>> 0).toString(16) +
						' bytes=' + ($5|0) +
						' err=\"' + errStr + '\"' +
						' first' + n + '=' + hex});
				}, bytes.data(), (int)dump_len, (uintptr_t)err,
				   s_inst_log, (int)vaddr, (int)bytes.size());
			}
			WARN_LOG(DYNAREC, "[rec_wasm] install_block FAILED vaddr=0x%08x bytes=%zu",
			         vaddr, bytes.size());
		}

		// One-shot dump of the first ~5 blocks compiled in system RAM
		// (vaddr >= 0x8c000000). Prints oplist size, BlockType, and the
		// first 8 raw guest instruction words. Tells us whether RAM has
		// real SH4 code or is zero-filled (i.e. 1ST_READ.BIN never landed).
		static unsigned s_ram_blocks_dumped = 0;
		if ((vaddr >> 28) == 0x8 && (vaddr & 0x0FF00000) >= 0x0C000000 &&
		    s_ram_blocks_dumped < 400) {
			++s_ram_blocks_dumped;
			u16 w0 = ReadMem16(vaddr + 0);
			u16 w1 = ReadMem16(vaddr + 2);
			u16 w2 = ReadMem16(vaddr + 4);
			u16 w3 = ReadMem16(vaddr + 6);
			u16 w4 = ReadMem16(vaddr + 8);
			u16 w5 = ReadMem16(vaddr + 10);
			u16 w6 = ReadMem16(vaddr + 12);
			u16 w7 = ReadMem16(vaddr + 14);
			MAIN_THREAD_EM_ASM({
				postMessage({cmd: 'print', txt:
					'[flycast-worker] compile RAM-block #' + ($0|0) +
					' vaddr=0x' + ($1 >>> 0).toString(16) +
					' ops=' + ($2|0) +
					' BlockType=0x' + ($3 >>> 0).toString(16) +
					' Branch=0x' + ($4 >>> 0).toString(16) +
					' Next=0x' + ($5 >>> 0).toString(16)});
			}, (int)s_ram_blocks_dumped, (int)vaddr,
			   (int)block->oplist.size(), (int)block->BlockType,
			   (int)block->BranchBlock, (int)block->NextBlock);
			MAIN_THREAD_EM_ASM({
				postMessage({cmd: 'print', txt:
					'[flycast-worker]   words: ' +
					($0 >>> 0).toString(16).padStart(4,'0') + ' ' +
					($1 >>> 0).toString(16).padStart(4,'0') + ' ' +
					($2 >>> 0).toString(16).padStart(4,'0') + ' ' +
					($3 >>> 0).toString(16).padStart(4,'0') + ' ' +
					($4 >>> 0).toString(16).padStart(4,'0') + ' ' +
					($5 >>> 0).toString(16).padStart(4,'0') + ' ' +
					($6 >>> 0).toString(16).padStart(4,'0') + ' ' +
					($7 >>> 0).toString(16).padStart(4,'0')});
			}, (int)w0, (int)w1, (int)w2, (int)w3,
			   (int)w4, (int)w5, (int)w6, (int)w7);
		}

		// block->code must be UNIQUE per block — Flycast's bm_AddBlock
		// (blockmanager.cpp:215-219) uses it as the key in `blkmap` and
		// die()s on duplicates. A native dynarec naturally gets uniqueness
		// because each block has its own JIT-emitted host code address;
		// our wasm setup has a single shared trampoline. Use the block's
		// own heap address (`blk` itself) as the unique fake code pointer.
		// The mainloop ignores this pointer and dispatches via
		// wasm_block_trampoline directly — see `mainloop` below.
		block->code            = (DynarecCodeEntryPtr)(uintptr_t)block;
		block->host_code_size  = 0;
		block->host_opcodes    = 0;
	}

	void reset() override
	{
		INFO_LOG(DYNAREC, "[rec_wasm] reset — clearing %zu compiled blocks",
		         g_compiled_blocks.size());
		g_compiled_blocks.clear();
		// Drop the vaddr -> fn table. The wasmTable slots on the JS side
		// stay allocated (V8 owns the table and we can't usefully shrink
		// it); the next install just keeps growing. The Instance refs in
		// flycast_table_slots[] remain GC roots so previously-installed
		// blocks won't be collected, but since jit_lookup() no longer
		// finds them by vaddr they're unreachable from the dispatcher.
		jit_clear();
		// F1 — Discard any pending un-sealed shard. The RuntimeBlockInfo*
		// pointers in s_pending_shard are owned by the block manager which
		// is also resetting; holding them past this point would be UAF.
		s_pending_shard.clear();
		s_dispatches_at_last_seal = 0;
	}

	void mainloop(void* /*cntx*/) override
	{
		// Dispatch loop with SH4 exception trampoline + cycle / INTC pump.
		// Mirrors Sh4Interpreter::Run (sh4_interpreter.cpp:41-69) at the
		// timeslice level: native rec-x64/rec-arm decrement cycle_counter
		// inside JIT-emitted code per-block and refill it via the same
		// UpdateSystem_INTC call; bementalJIT Phase 1 doesn't emit cycle
		// accounting, so we account coarsely here — fixed cost per block.
		//
		// Sh4Interpreter::Instance is used by ExecuteDelayslot() inside
		// interpreter ops (sh4_opcodes.cpp:800-801). Phase-1 IFB fallback
		// runs the interpreter handlers, so we must point Instance at a
		// live Sh4Interpreter. Sh4Recompiler inherits Sh4Interpreter so
		// Sh4Recompiler::Instance is type-compatible.
		Sh4Context* ctx = sh4ctx;
		Sh4Interpreter::Instance = Sh4Recompiler::Instance;
		ctx->restoreHostRoundingMode();

		static unsigned long s_dispatch_count = 0;
		static uint64_t s_cache_miss = 0;
#ifdef DEBUG_DISPATCH
		static unsigned long s_mainloop_entries = 0;
		static u32 s_last_logged_pc = 0;
		// Ring buffer of (PC before dispatch, PC after dispatch) for the last
		// 32 blocks. Dumped on the first executable-region violation so we can
		// see the indirect branch that took us out of system RAM.
		static constexpr unsigned PC_RING_LEN = 256;
		static u32 s_pc_ring_before[PC_RING_LEN] = {0};
		static u32 s_pc_ring_after [PC_RING_LEN] = {0};
		static u32 s_pc_ring_r15   [PC_RING_LEN] = {0};
		static u32 s_pc_ring_pr    [PC_RING_LEN] = {0};
		static unsigned s_pc_ring_idx = 0;
		static bool s_region_trap_fired = false;
		++s_mainloop_entries;
		if (s_mainloop_entries < 5 || s_mainloop_entries % 60 == 0) {
			MAIN_THREAD_EM_ASM({
				postMessage({cmd: 'print', txt:
					'[flycast-worker] mainloop entry #' + ($0 >>> 0) +
					' CpuRunning=' + $1 +
					' pc=0x' + ($2 >>> 0).toString(16)});
			}, (int)s_mainloop_entries, (int)ctx->CpuRunning, (int)ctx->pc);
		}
#endif // DEBUG_DISPATCH
		// nasomers path: blocks are installed eagerly inside compile() via
		// wasm_install_block, so no entry-time flush is needed. Any blocks
		// compiled before mainloop entry are already in s_block_pc/fn.
		//
		// try/catch hoisted outside the per-dispatch loop (2026-05-18 lever
		// #1). Previously every dispatch paid an asyncify-emulated try-frame
		// setup/teardown (measured ~1136 ns/dispatch wrapper gap per
		// /tmp/dc-probes/dispatch-decomp.log). PSO boot fires 0 exceptions
		// per the probe, so the inner loop runs uninterrupted in the happy
		// path; when SH4ThrownException fires, the inner loop unwinds to
		// this outer try, the handler dispatches Do_Exception, and the
		// outer while re-enters the inner loop while CpuRunning stays true.
		while (ctx->CpuRunning) {
			try {
				while (ctx->CpuRunning) {
				++s_dispatch_count;
#ifdef DEBUG_DISPATCH
				// Outer-loop timer — captures the FULL inner-while iteration body so we
				// can compute (outer - drain - tramp - spg - stats) = the unaccounted gap.
				// Measurement-grounded research 2026-05-18 found ~51% of wall in the gap.
				const double tOuterStart = emscripten_get_now();
				const double tA = emscripten_get_now();
				// Sample PC at startup + every 1k dispatches. When stuck at
				// the known BIOS polling PC, also dump R3 and the polled
				// MMIO word so we can identify which peripheral the BIOS
				// is waiting on.
				// Per-1000 PC sampler — gated behind g_diag_enabled to avoid
				// the MAIN_THREAD_EM_ASM proxy cost (~50-200µs/call) when not
				// debugging. At 24K disp/sec the unconditional version was 1-5%
				// of the dispatch budget. The 5s [stats] flush below is the
				// production-friendly throughput indicator.
				if (g_diag_enabled &&
				    (s_dispatch_count < 20 ||
				     s_dispatch_count < g_pc_trace_until ||
				     s_dispatch_count % 1000 == 0)) {
					u32 pc_now = ctx->pc;
					u32 r0 = ctx->r[0];
					u32 r6 = ctx->r[6];
					u32 r12 = ctx->r[12];
					u32 r14 = ctx->r[14];
					u32 sr_full = ctx->sr.getFull();
					u32 vbr = ctx->vbr;
					u32 pend = ctx->interrupt_pend;
					// Two-postMessage split: MAIN_THREAD_EM_ASM has a
					// limit on inline arg count (~5-7 safe). Split to keep
					// each call simple and avoid silent truncation that
					// tanked throughput in the prior probe (1000× slowdown
					// when the proxy hit the arg limit).
					MAIN_THREAD_EM_ASM({
						postMessage({cmd: 'print', txt:
							'[flycast-worker] sh4 dispatch #' + ($0 >>> 0) +
							' pc=0x' + ($1 >>> 0).toString(16) +
							' r0=0x' + ($2 >>> 0).toString(16) +
							' r6=0x' + ($3 >>> 0).toString(16) +
							' sr=0x' + ($4 >>> 0).toString(16)});
					}, (int)s_dispatch_count, (int)pc_now,
					   (int)r0, (int)r6, (int)sr_full);
					MAIN_THREAD_EM_ASM({
						postMessage({cmd: 'print', txt:
							'[flycast-worker]   ... r12=0x' + ($0 >>> 0).toString(16) +
							' r14=0x' + ($1 >>> 0).toString(16) +
							' vbr=0x' + ($2 >>> 0).toString(16) +
							' pend=0x' + ($3 >>> 0).toString(16)});
					}, (int)r12, (int)r14, (int)vbr, (int)pend);
					s_last_logged_pc = pc_now;
				}
				// One-shot dump of SH4 instructions at PCs that wrote zero
				// to SB_IML*NRM (interrupt mask registers). If real BIOS
				// at these PCs writes NON-ZERO but we observe zero, our
				// JIT is mis-computing the value.
				static bool s_mask_dump_fired = false;
				if (g_diag_enabled && !s_mask_dump_fired &&
				    ctx->pc >= 0x8c00b850u && ctx->pc < 0x8c00b8a0u) {
					s_mask_dump_fired = true;
					const u32 base = 0x8c00b850u;
					for (int row = 0; row < 8; row++) {
						u16 w[8];
						for (int i = 0; i < 8; i++) {
							w[i] = ReadMem16(base + row*16 + i*2);
						}
						MAIN_THREAD_EM_ASM({
							var hex = function(x){return ('0000'+(x>>>0).toString(16)).slice(-4);};
							postMessage({cmd: 'print', txt:
								'[mask-asm] 0x' + ($0 >>> 0).toString(16) + ': ' +
								hex($1)+' '+hex($2)+' '+hex($3)+' '+hex($4)+' '+
								hex($5)+' '+hex($6)+' '+hex($7)+' '+hex($8)});
						}, (int)(base + row*16),
						   (int)w[0], (int)w[1], (int)w[2], (int)w[3],
						   (int)w[4], (int)w[5], (int)w[6], (int)w[7]);
					}
				}
				// One-shot dump of SH4 instructions at the steady-state
				// hot loop PCs. Fires the FIRST time PC enters the narrow
				// loop band (0x8c0db0c0..0x8c0db240) so we capture the
				// actual loop body, not a function epilogue further down.
				static bool s_loop_dump_fired = false;
				if (g_diag_enabled && !s_loop_dump_fired &&
				    ctx->pc >= 0x8c0db0c0u && ctx->pc < 0x8c0db240u) {
					s_loop_dump_fired = true;
					const u32 base = 0x8c0db0c0u;  // dump full hot range
					for (int row = 0; row < 24; row++) {  // 384 bytes = covers 0x8c0db0c0..0x8c0db240
						u16 w[8];
						for (int i = 0; i < 8; i++) {
							w[i] = ReadMem16(base + row*16 + i*2);
						}
						MAIN_THREAD_EM_ASM({
							var hex = function(x){return ('0000'+(x>>>0).toString(16)).slice(-4);};
							postMessage({cmd: 'print', txt:
								'[loop-asm] 0x' + ($0 >>> 0).toString(16) + ': ' +
								hex($1)+' '+hex($2)+' '+hex($3)+' '+hex($4)+' '+
								hex($5)+' '+hex($6)+' '+hex($7)+' '+hex($8)});
						}, (int)(base + row*16),
						   (int)w[0], (int)w[1], (int)w[2], (int)w[3],
						   (int)w[4], (int)w[5], (int)w[6], (int)w[7]);
					}
				}
				// One-shot dump at 0x8c0d9fbc — the post-VBLANK-unblock
				// wedge. Captures the polling-loop body so we can decode
				// what's being polled (memory vs MMIO).
				static bool s_d9fbc_dump_fired = false;
				if (g_diag_enabled && !s_d9fbc_dump_fired &&
				    ctx->pc >= 0x8c0d9f80u && ctx->pc < 0x8c0da010u) {
					s_d9fbc_dump_fired = true;
					const u32 base = 0x8c0d9f80u;
					for (int row = 0; row < 9; row++) {
						u16 w[8];
						for (int i = 0; i < 8; i++) {
							w[i] = ReadMem16(base + row*16 + i*2);
						}
						MAIN_THREAD_EM_ASM({
							var hex = function(x){return ('0000'+(x>>>0).toString(16)).slice(-4);};
							postMessage({cmd: 'print', txt:
								'[d9fbc-asm] 0x' + ($0 >>> 0).toString(16) + ': ' +
								hex($1)+' '+hex($2)+' '+hex($3)+' '+hex($4)+' '+
								hex($5)+' '+hex($6)+' '+hex($7)+' '+hex($8)});
						}, (int)(base + row*16),
						   (int)w[0], (int)w[1], (int)w[2], (int)w[3],
						   (int)w[4], (int)w[5], (int)w[6], (int)w[7]);
					}
					MAIN_THREAD_EM_ASM({
						postMessage({cmd:'print', txt:
							'[d9fbc-gpr] r0=0x' + ($0 >>> 0).toString(16) +
							' r1=0x' + ($1 >>> 0).toString(16) +
							' r2=0x' + ($2 >>> 0).toString(16) +
							' r3=0x' + ($3 >>> 0).toString(16) +
							' r4=0x' + ($4 >>> 0).toString(16) +
							' r5=0x' + ($5 >>> 0).toString(16) +
							' r6=0x' + ($6 >>> 0).toString(16) +
							' r7=0x' + ($7 >>> 0).toString(16)});
					}, (int)ctx->r[0], (int)ctx->r[1], (int)ctx->r[2], (int)ctx->r[3],
					   (int)ctx->r[4], (int)ctx->r[5], (int)ctx->r[6], (int)ctx->r[7]);
					MAIN_THREAD_EM_ASM({
						postMessage({cmd:'print', txt:
							'[d9fbc-gpr] r8=0x' + ($0 >>> 0).toString(16) +
							' r9=0x' + ($1 >>> 0).toString(16) +
							' r10=0x' + ($2 >>> 0).toString(16) +
							' r11=0x' + ($3 >>> 0).toString(16) +
							' r12=0x' + ($4 >>> 0).toString(16) +
							' r13=0x' + ($5 >>> 0).toString(16) +
							' r14=0x' + ($6 >>> 0).toString(16) +
							' r15=0x' + ($7 >>> 0).toString(16) +
							' pr=0x' + ($8 >>> 0).toString(16)});
					}, (int)ctx->r[8], (int)ctx->r[9], (int)ctx->r[10], (int)ctx->r[11],
					   (int)ctx->r[12], (int)ctx->r[13], (int)ctx->r[14], (int)ctx->r[15],
					   (int)ctx->pr);
				}
				// IMASK-wedge dump at PC 0x8c00b6b8 — researcher 2026-05-17:
				// SR.IMASK stuck at 0xF for entire run; this PC is the top wedge
				// (1837 hits/30s) BEFORE the LDC SR blocks at 0x8c00b500/b532.
				// Whatever this loop polls is the gate that needs to satisfy
				// before BIOS init drops IMASK. Also dumps VBR (researcher
				// noted VBR=0x0 in old dumps but REIOS should set 0x8c000000).
				static bool s_b6b8_dump_fired = false;
				if (g_diag_enabled && !s_b6b8_dump_fired &&
				    ctx->pc >= 0x8c00b6a0u && ctx->pc < 0x8c00b6e0u) {
					s_b6b8_dump_fired = true;
					const u32 base = 0x8c00b6a0u;
					for (int row = 0; row < 5; row++) {
						u16 w[8];
						for (int i = 0; i < 8; i++) {
							w[i] = ReadMem16(base + row*16 + i*2);
						}
						MAIN_THREAD_EM_ASM({
							var hex = function(x){return ('0000'+(x>>>0).toString(16)).slice(-4);};
							postMessage({cmd: 'print', txt:
								'[b6b8-asm] 0x' + ($0 >>> 0).toString(16) + ': ' +
								hex($1)+' '+hex($2)+' '+hex($3)+' '+hex($4)+' '+
								hex($5)+' '+hex($6)+' '+hex($7)+' '+hex($8)});
						}, (int)(base + row*16),
						   (int)w[0], (int)w[1], (int)w[2], (int)w[3],
						   (int)w[4], (int)w[5], (int)w[6], (int)w[7]);
					}
					MAIN_THREAD_EM_ASM({
						postMessage({cmd:'print', txt:
							'[b6b8-gpr] r0=0x' + ($0 >>> 0).toString(16) +
							' r1=0x' + ($1 >>> 0).toString(16) +
							' r2=0x' + ($2 >>> 0).toString(16) +
							' r3=0x' + ($3 >>> 0).toString(16) +
							' r4=0x' + ($4 >>> 0).toString(16) +
							' r5=0x' + ($5 >>> 0).toString(16) +
							' r6=0x' + ($6 >>> 0).toString(16) +
							' r7=0x' + ($7 >>> 0).toString(16)});
					}, (int)ctx->r[0], (int)ctx->r[1], (int)ctx->r[2], (int)ctx->r[3],
					   (int)ctx->r[4], (int)ctx->r[5], (int)ctx->r[6], (int)ctx->r[7]);
					MAIN_THREAD_EM_ASM({
						postMessage({cmd:'print', txt:
							'[b6b8-gpr] r8=0x' + ($0 >>> 0).toString(16) +
							' r9=0x' + ($1 >>> 0).toString(16) +
							' r10=0x' + ($2 >>> 0).toString(16) +
							' r11=0x' + ($3 >>> 0).toString(16) +
							' r12=0x' + ($4 >>> 0).toString(16) +
							' r13=0x' + ($5 >>> 0).toString(16) +
							' r14=0x' + ($6 >>> 0).toString(16) +
							' r15=0x' + ($7 >>> 0).toString(16) +
							' pr=0x' + ($8 >>> 0).toString(16)});
					}, (int)ctx->r[8], (int)ctx->r[9], (int)ctx->r[10], (int)ctx->r[11],
					   (int)ctx->r[12], (int)ctx->r[13], (int)ctx->r[14], (int)ctx->r[15],
					   (int)ctx->pr);
					MAIN_THREAD_EM_ASM({
						postMessage({cmd:'print', txt:
							'[b6b8-sys] pc=0x' + ($0 >>> 0).toString(16) +
							' sr=0x' + ($1 >>> 0).toString(16) +
							' vbr=0x' + ($2 >>> 0).toString(16) +
							' gbr=0x' + ($3 >>> 0).toString(16) +
							' ssr=0x' + ($4 >>> 0).toString(16) +
							' spc=0x' + ($5 >>> 0).toString(16) +
							' fpscr=0x' + ($6 >>> 0).toString(16) +
							' pend=0x' + ($7 >>> 0).toString(16)});
					}, (int)ctx->pc, (int)ctx->sr.getFull(), (int)ctx->vbr,
					   (int)ctx->gbr, (int)ctx->ssr, (int)ctx->spc,
					   (int)ctx->fpscr.full, (int)ctx->interrupt_pend);
				}
#endif // DEBUG_DISPATCH
				// F5 (R3 fix #1) 2026-05-17: dropped the pre-trampoline
				// bm_GetCodeByVAddr(ctx->pc) call. Flycast's FPCA lookup
				// path was duplicating work the trampoline already does:
				// wasm_block_trampoline() calls jit_lookup(pc) and routes
				// misses through rdv_FailedToFindBlock_pc(), so a second
				// FPCA traversal here just burned cycles per dispatch.
				// The result (a per-block fake pointer) was never invoked
				// anyway — it was tagged `(void)code` immediately. Diag
				// timing of the dropped call is gated behind g_diag_enabled
				// when DEBUG_DISPATCH is on, so we still get a rough cost
				// number for the trampoline itself.
#ifdef DEBUG_DISPATCH
				// Lever #2 (2026-05-18): dropped the outer cb_t1/cb_t2 wrap.
				// Each emscripten_get_now() costs ~30-100ns; doing it twice
				// per dispatch in addition to the inner tA/tB/tC/tD wrap was
				// 2× redundant. tramp_total can be reconstructed from the
				// inner pre+call+post if needed. Saves ~100ns/dispatch.
				const double tB = emscripten_get_now();
				const u32 pc_before = ctx->pc;
				wasm_block_trampoline();
				const u32 pc_after  = ctx->pc;
				const double tC = emscripten_get_now();
				g_cb_disp_count.fetch_add(1, std::memory_order_relaxed);
				g_cb_bm_lookup_ns.fetch_add(0, std::memory_order_relaxed);
				// tramp_total now computed as pre+call+post sum at log time
				// (see cost-breakdown emit below). No additional fetch_add.
				// Log every 100K dispatches. Atomic-load all 8 counters,
				// derive per-dispatch averages in ns, post a single line.
				{
					const uint64_t n = g_cb_disp_count.load(std::memory_order_relaxed);
					if (n > 0 && (n % 100000ULL) == 0) {
						const uint64_t bm   = g_cb_bm_lookup_ns.load(std::memory_order_relaxed);
						const uint64_t pre  = g_cb_tramp_pre_ns.load(std::memory_order_relaxed);
						const uint64_t emjs = g_cb_tramp_emjs_ns.load(std::memory_order_relaxed);
						const uint64_t post = g_cb_tramp_post_ns.load(std::memory_order_relaxed);
						const uint64_t call = g_cb_tramp_call_ns.load(std::memory_order_relaxed);
						// tot reconstructed from inner timers after lever #2.
						const uint64_t tot  = pre + call + post;
						const uint64_t rd   = g_cb_mem_read_calls.load(std::memory_order_relaxed);
						const uint64_t wr   = g_cb_mem_write_calls.load(std::memory_order_relaxed);
						const int nblocks   = (int)s_block_count;
						const int bm_avg    = (int)(bm   / n);
						const int tot_avg   = (int)(tot  / n);
						const int pre_avg   = (int)(pre  / n);
						const int emjs_avg  = (int)(emjs / n);
						const int call_avg  = (int)(call / n);
						const int post_avg  = (int)(post / n);
						const int total_avg = bm_avg + tot_avg;
						MAIN_THREAD_EM_ASM({
							postMessage({cmd:'print', txt:
								'[cost-breakdown] disp=' + ($0|0) +
								' blocks=' + ($1|0) +
								' total_ns=' + ($2|0) +
								' bm=' + ($3|0) +
								' tramp_total=' + ($4|0) +
								' pre=' + ($5|0) +
								' emjs=' + ($6|0) +
								' call=' + ($7|0) +
								' post=' + ($8|0)});
						}, (int)n, nblocks, total_avg,
						   bm_avg, tot_avg, pre_avg, emjs_avg, call_avg, post_avg);
						// Wrapper-gap decomposition (added 2026-05-18 per researcher 1).
						const int drain_avg = (int)(g_cb_drain_ns.load(std::memory_order_relaxed) / n);
						const int spg_avg   = (int)(g_cb_spg_ns.load  (std::memory_order_relaxed) / n);
						const int stats_avg = (int)(g_cb_stats_ns.load(std::memory_order_relaxed) / n);
						const int outer_avg = (int)(g_cb_outer_ns.load(std::memory_order_relaxed) / n);
						// gap = outer - all-instrumented. If positive, time
						// is being spent OUTSIDE the named buckets (cost
						// research 2026-05-18: ~51% unaccounted).
						const int gap_avg   = outer_avg - tot_avg - drain_avg - spg_avg - stats_avg;
						MAIN_THREAD_EM_ASM({
							postMessage({cmd:'print', txt:
								'[cost-breakdown]   drain=' + ($0|0) +
								' spg=' + ($1|0) +
								' stats=' + ($2|0) +
								' outer=' + ($3|0) +
								' gap=' + ($4|0)});
						}, drain_avg, spg_avg, stats_avg, outer_avg, gap_avg);
						MAIN_THREAD_EM_ASM({
							postMessage({cmd:'print', txt:
								'[cost-breakdown]   mem_reads=' + ($0|0) +
								' mem_writes=' + ($1|0) +
								' reads/disp=' + ($2|0) +
								' writes/disp=' + ($3|0)});
						}, (int)rd, (int)wr,
						   (int)(rd / n), (int)(wr / n));
#ifdef FLYCAST_BRIDGE_DIAG
						// Per-area bucket dump. addr>>26 maps to SH4 area:
						//   0 = BIOS (0x0000_0000) + MMIO (0x005f_xxxx)
						//   3 = RAM  (0x0c00_0000) — should dominate
						//   4 = PVR / TA regs + VRAM mirror
						//   5 = AICA sound regs + ARAM
						//   6 = ext. dev / mirror
						//   7 = on-chip mod (store-queue, MMU control)
						// Sum everything not in {0,3,4,5} into 'other'.
						{
							const uint64_t r0 = g_cb_mem_read_by_area[0].load(std::memory_order_relaxed);
							const uint64_t r3 = g_cb_mem_read_by_area[3].load(std::memory_order_relaxed);
							const uint64_t r4 = g_cb_mem_read_by_area[4].load(std::memory_order_relaxed);
							const uint64_t r5 = g_cb_mem_read_by_area[5].load(std::memory_order_relaxed);
							uint64_t r_other = 0;
							for (int i = 0; i < 64; ++i) {
								if (i == 0 || i == 3 || i == 4 || i == 5) continue;
								r_other += g_cb_mem_read_by_area[i].load(std::memory_order_relaxed);
							}
							const uint64_t w0 = g_cb_mem_write_by_area[0].load(std::memory_order_relaxed);
							const uint64_t w3 = g_cb_mem_write_by_area[3].load(std::memory_order_relaxed);
							const uint64_t w4 = g_cb_mem_write_by_area[4].load(std::memory_order_relaxed);
							const uint64_t w5 = g_cb_mem_write_by_area[5].load(std::memory_order_relaxed);
							uint64_t w_other = 0;
							for (int i = 0; i < 64; ++i) {
								if (i == 0 || i == 3 || i == 4 || i == 5) continue;
								w_other += g_cb_mem_write_by_area[i].load(std::memory_order_relaxed);
							}
							// Split into 2 postMessages so each MAIN_THREAD_EM_ASM
							// stays at ≤8 args (the existing [cost-breakdown]
							// emits above are 8-arg max — matching that bound).
							MAIN_THREAD_EM_ASM({
								postMessage({cmd:'print', txt:
									'[cost-breakdown]   mem_by_area reads:'
									+ ' a0=' + ($0|0)
									+ ' a3=' + ($1|0)
									+ ' a4=' + ($2|0)
									+ ' a5=' + ($3|0)
									+ ' other=' + ($4|0)});
							}, (int)r0, (int)r3, (int)r4, (int)r5, (int)r_other);
							MAIN_THREAD_EM_ASM({
								postMessage({cmd:'print', txt:
									'[cost-breakdown]   mem_by_area writes:'
									+ ' a0=' + ($0|0)
									+ ' a3=' + ($1|0)
									+ ' a4=' + ($2|0)
									+ ' a5=' + ($3|0)
									+ ' other=' + ($4|0)});
							}, (int)w0, (int)w3, (int)w4, (int)w5, (int)w_other);
						}
#endif // FLYCAST_BRIDGE_DIAG
					}
				}

				// Executable-region trap. Legal SH4 code regions on Dreamcast
				// (ignoring P0/P1/P2/P3 mirror bits): physical 0x00000000-
				// 0x001FFFFF (BIOS, 2 MB) and 0x0C000000-0x0CFFFFFF (system
				// RAM, 16 MB). Anything else (PVR/VRAM/AICA/HOLLY/TA region)
				// indicates a wild indirect branch corrupted PC. Dump the
				// last 32 (before, after) PC pairs + GPRs and halt the CPU.
				if (!s_region_trap_fired) {
					s_pc_ring_before[s_pc_ring_idx] = pc_before;
					s_pc_ring_after [s_pc_ring_idx] = pc_after;
					s_pc_ring_r15   [s_pc_ring_idx] = ctx->r[15];
					s_pc_ring_pr    [s_pc_ring_idx] = ctx->pr;
					s_pc_ring_idx = (s_pc_ring_idx + 1) % PC_RING_LEN;

					// PR-corruption tripwire: PR must always be 16-bit aligned
					// (LSB=0) on real SH4. Any block exit with PR having bit 0
					// set is the upstream JIT bug we're hunting. Log only the
					// first occurrence per session, with surrounding context.
					static bool s_pr_trip_fired = false;
					if (g_diag_enabled && !s_pr_trip_fired && (ctx->pr & 1)) {
						s_pr_trip_fired = true;
						MAIN_THREAD_EM_ASM({
							postMessage({cmd: 'print', txt:
								'[pr-trip] block pc=0x' + ($0 >>> 0).toString(16) +
								'->0x' + ($1 >>> 0).toString(16) +
								' pr=0x' + ($2 >>> 0).toString(16) +
								' r15=0x' + ($3 >>> 0).toString(16) +
								' r0=0x' + ($4 >>> 0).toString(16) +
								' dispatch=#' + ($5|0)});
						}, (int)pc_before, (int)pc_after,
						   (int)ctx->pr, (int)ctx->r[15],
						   (int)ctx->r[0], (int)s_dispatch_count);
					}
					const u32 paddr = pc_after & 0x1FFFFFFF;
					const bool legal_bios = paddr <  0x00200000u;
					const bool legal_ram  = paddr >= 0x0C000000u && paddr < 0x0D000000u;
					if (!legal_bios && !legal_ram) {
						s_region_trap_fired = true;
						MAIN_THREAD_EM_ASM({
							postMessage({cmd: 'print', txt:
								'[flycast-worker] !! REGION TRAP at dispatch #' + ($0 >>> 0) +
								' pc_after=0x' + ($1 >>> 0).toString(16) +
								' pc_before=0x' + ($2 >>> 0).toString(16)});
						}, (int)s_dispatch_count, (int)pc_after, (int)pc_before);
						// Dump GPRs.
						for (int i = 0; i < 16; i += 4) {
							MAIN_THREAD_EM_ASM({
								postMessage({cmd: 'print', txt:
									'[flycast-worker]   r' + ($0|0) +
									'=0x' + ($1 >>> 0).toString(16) +
									' r' + (($0|0)+1) + '=0x' + ($2 >>> 0).toString(16) +
									' r' + (($0|0)+2) + '=0x' + ($3 >>> 0).toString(16) +
									' r' + (($0|0)+3) + '=0x' + ($4 >>> 0).toString(16)});
							}, i, (int)ctx->r[i], (int)ctx->r[i+1],
							     (int)ctx->r[i+2], (int)ctx->r[i+3]);
						}
						MAIN_THREAD_EM_ASM({
							postMessage({cmd: 'print', txt:
								'[flycast-worker]   pr=0x' + ($0 >>> 0).toString(16) +
								' gbr=0x' + ($1 >>> 0).toString(16) +
								' vbr=0x' + ($2 >>> 0).toString(16) +
								' mach=0x' + ($3 >>> 0).toString(16) +
								' macl=0x' + ($4 >>> 0).toString(16)});
						}, (int)ctx->pr, (int)ctx->gbr, (int)ctx->vbr,
						   (int)ctx->mac.h, (int)ctx->mac.l);
						// Dump the ring (oldest first).
						for (unsigned k = 0; k < PC_RING_LEN; k++) {
							const unsigned slot = (s_pc_ring_idx + k) % PC_RING_LEN;
							MAIN_THREAD_EM_ASM({
								postMessage({cmd: 'print', txt:
									'[flycast-worker]   ring[-' + ((($1|0)) - ($0|0)) + ']' +
									' before=0x' + ($2 >>> 0).toString(16) +
									' -> after=0x' + ($3 >>> 0).toString(16)});
							}, (int)k, (int)PC_RING_LEN,
							   (int)s_pc_ring_before[slot], (int)s_pc_ring_after[slot]);
						}
						ctx->CpuRunning = false;
					}
				}
#else
				wasm_block_trampoline();
#endif // DEBUG_DISPATCH
				// Per-block cycle drain now happens INSIDE the compiled
				// block (bementalJIT/guests/sh4/wasm_emit.cpp build_block
				// prologue), using block->guest_cycles populated by
				// Flycast's decoder. This matches the rec-x64 backend
				// (rec_x64.cpp:148-149) and fixes the over/under-drain
				// the flat 32-cycle subtract introduced. The drain check
				// + INTC pump below still drives the scheduler.
				if (ctx->cycle_counter <= 0) {
					ctx->cycle_counter += SH4_TIMESLICE;
					UpdateSystem_INTC();
					// Tick counter for SPG raise rate-limit. Increment is
					// load-bearing (gates raise rate to once per 64 drains
					// so the scheduler isn't crowded) so it lives outside
					// the DEBUG_DISPATCH gate.
					static u32 s_spg_tick = 0;
					// Forced VBlank delivery. Phase 1 SH4 runs at ~3% real
					// Dreamcast clock; flycast's sh4_sched fires callbacks
					// only when remaining ∈ [0, SH4_TIMESLICE] — events
					// scheduled further out (1.5M cycles for VBLANK_IN)
					// occur ~once per 30 sched-ticks but most of those
					// ticks are consumed by TMU/maple/etc., leaving spg
					// dispatched 3 times in 30 wall-seconds. PSO idle-polls
					// SB_ISTNRM bit 3 waiting for VBLANK_IN; without a
					// faster pump it never advances past the boot init.
					// Workaround: raise the SPG triplet (SCANINT1, SCANINT2,
					// HBLANK) directly at wall-60Hz, plus pump the proper
					// scheduler so other registered cbs (TMU, GDROM, maple)
					// also fire on time. This is a throughput band-aid,
					// removable once JIT speed catches up.
					// Wall-time gated SPG raise. Previously gated on
					// `s_spg_tick & 0x3F`, which assumed ~16K timeslices/sec
					// (= 250 Hz raise rate). Per /tmp/dc-probes/xab4c-snap2.log
					// the actual rate dropped to ~478 timeslices/sec, so the
					// counter-mask gave ~7.5 Hz — PSO booted ~1 step per 12s
					// of wall while it polls SB_ISTNRM bit 3. Decoupling from
					// JIT throughput by gating on emscripten_get_now() restores
					// the documented ~60 Hz target regardless of dispatch rate.
					static double s_last_spg_raise_ms = 0.0;
					const double now_ms = emscripten_get_now();
					if (now_ms - s_last_spg_raise_ms >= 16.0) {
						s_last_spg_raise_ms = now_ms;
						// SPG triplet + maple-vblank-over-irq (bit 13). Maple-VBOI
						// is what IP.BIN-loaded OS code uses to drive controller
						// polling; without it the maple bus stays cold and HLE
						// controller state never updates.
						asic_RaiseInterrupt(holly_SCANINT1);
						asic_RaiseInterrupt(holly_SCANINT2);
						asic_RaiseInterrupt(holly_HBLank);
						asic_RaiseInterrupt(holly_MAPLE_VBOI);
					}
					// Pump sh4_sched extra once. 3x extra pump previously
					// tanked throughput from 415K → 47K disp/s; 1x extra
					// (i.e. 2 total per timeslice) was the historical
					// sweet spot. 2x→1x has never been A/B'd — F7 (R5
					// fix #2) 2026-05-17 wires this behind env var
					// FLYCAST_SINGLE_INTC (default OFF, keeps both calls
					// so default behavior is unchanged) so the next probe
					// can compare disp/s with/without the extra pump.
					static const bool s_single_intc = []() {
						// TEMP: default ON. getenv() doesn't reach wasm pthread worker.
						const char* v = std::getenv("FLYCAST_SINGLE_INTC");
						if (v) return v[0] == '1';
						return true;
					}();
					if (!s_single_intc) {
						UpdateSystem_INTC();
					}
					++s_spg_tick;
#ifdef DEBUG_DISPATCH
					// SPG/ISTNRM scheduler diagnostic: hooked here because
					// UpdateSystem_INTC is the entry point that ticks
					// sh4_sched and (indirectly) spg_line_sched. We track
					// whether bit-3 (SCANINT1/VBLANK_IN) ever rises, so
					// the SB_ISTNRM-polling stall at PC 0x8c09b0xx can be
					// diagnosed as (a) raise never fires, (b) raise fires
					// but gets cleared before guest read, or (c) timing
					// mismatch between scanline programming and pump rate.
					static u32 s_spg_last_istnrm = 0;
					static u32 s_spg_scanint1_raises = 0;
					static u32 s_spg_scanint2_raises = 0;
					static u32 s_spg_hblank_raises = 0;
					const u32 cur_istnrm = SB_ISTNRM;
					if ((cur_istnrm & 0x08) && !(s_spg_last_istnrm & 0x08)) s_spg_scanint1_raises++;
					if ((cur_istnrm & 0x10) && !(s_spg_last_istnrm & 0x10)) s_spg_scanint2_raises++;
					if ((cur_istnrm & 0x20) && !(s_spg_last_istnrm & 0x20)) s_spg_hblank_raises++;
					s_spg_last_istnrm = cur_istnrm;
					if (g_diag_enabled && (s_spg_tick % 4096) == 0) {
						const u32 spg_status     = PvrReg(0x10C, u32);
						const u32 spg_vblank_int = PvrReg(0xCC, u32);
						const u32 spg_hblank_int = PvrReg(0xC8, u32);
						// Scheduler liveness: sched_next is the cycles until
						// next event. If it stays huge (> 1M) across many ticks
						// the scheduler isn't being pumped enough.
						const int  sched_next    = Sh4cntx.sh4_sched_next;
						const u64  sched_now     = sh4_sched_now64();
						MAIN_THREAD_EM_ASM({
							postMessage({cmd:'print', txt:
								'[spg] tick=' + ($0|0) +
								' scanline=' + (($1>>>0) & 0x3FF) +
								' istnrm=0x' + ($2>>>0).toString(16) +
								' SCANINT1=' + ($3|0) +
								' SCANINT2=' + ($4|0) +
								' HBLANK=' + ($5|0) +
								' SPG_VBLANK_INT=0x' + ($6>>>0).toString(16) +
								' SPG_HBLANK_INT=0x' + ($7>>>0).toString(16) +
								' sched_next=' + ($8|0) +
								' sched_now32=' + ($9>>>0)});
						}, (int)s_spg_tick, (int)spg_status, (int)cur_istnrm,
						   (int)s_spg_scanint1_raises, (int)s_spg_scanint2_raises,
						   (int)s_spg_hblank_raises,
						   (int)spg_vblank_int, (int)spg_hblank_int,
						   (int)sched_next, (int)(sched_now & 0xffffffff));
					}
#endif // DEBUG_DISPATCH
				}    // end if (ctx->cycle_counter <= 0)
#ifdef DEBUG_DISPATCH
				const double tD_inner = emscripten_get_now();
#endif
#ifdef DEBUG_DISPATCH
			// 5-second [stats] flush. Wallclock-gated, fires from the
			// SH4 thread but EM_ASM proxy cost is negligible at 1 call /
			// 5s. Gives 5 samples in a 25s probe.
			static double s_t0 = emscripten_get_now();
			static unsigned long s_disp_prev = 0;
			static uint64_t s_ifb_prev = 0, s_miss_prev = 0, s_exc_prev = 0;
			if (g_diag_enabled) {
				double now = emscripten_get_now();
				if (now - s_t0 >= 5000.0) {
					double dt   = (now - s_t0) / 1000.0;
					uint64_t d  = s_dispatch_count - s_disp_prev;
					uint64_t i  = g_ifb_count.load() - s_ifb_prev;
					uint64_t m  = s_cache_miss      - s_miss_prev;
					uint64_t e  = g_exc_count.load() - s_exc_prev;
					int dps = (int)(d / dt);
					int ips = (int)(i / dt);
					int mps = (int)(m / dt);
					int eps = (int)(e / dt);
					int blocks = (int)s_block_count;
					MAIN_THREAD_EM_ASM({
						postMessage({cmd: 'print', txt:
							'[stats] disp=' + ($0|0) + '/s ifb=' + ($1|0) +
							'/s blocks=' + ($2|0) +
							' cache_miss=' + ($3|0) + '/s exc=' + ($4|0) + '/s'});
					}, dps, ips, blocks, mps, eps);
					s_t0        = now;
					s_disp_prev = s_dispatch_count;
					s_ifb_prev  += i;
					s_miss_prev += m;
					s_exc_prev  += e;
				}
			}
				const double tE = emscripten_get_now();
				const double tOuterEnd = emscripten_get_now();
				g_cb_drain_ns.fetch_add((uint64_t)((tB       - tA      ) * 1e6), std::memory_order_relaxed);
				g_cb_spg_ns.fetch_add  ((uint64_t)((tD_inner - tC      ) * 1e6), std::memory_order_relaxed);
				g_cb_stats_ns.fetch_add((uint64_t)((tE       - tD_inner) * 1e6), std::memory_order_relaxed);
				g_cb_outer_ns.fetch_add((uint64_t)((tOuterEnd - tOuterStart) * 1e6), std::memory_order_relaxed);
#endif // DEBUG_DISPATCH
				}    // end inner while (hoisted try-frame, lever #1)
			} catch (const SH4ThrownException& ex) {
				// Vector through the SH4 exception handler. epc is the PC
				// at the time the exception was raised; expEvn picks the
				// vector (Sh4Ex_*: 0x100 GeneralException, 0x180 SlotIllegal,
				// 0x1A0 Trap, 0x600 Interrupt, etc.).
				g_exc_count.fetch_add(1, std::memory_order_relaxed);
#ifdef DEBUG_DISPATCH
				static int s_exc_log_count = 0;
				if (g_diag_enabled && s_exc_log_count < 4) {
					s_exc_log_count++;
					MAIN_THREAD_EM_ASM({
						postMessage({cmd: 'print', txt:
							'[exception] #' + ($0|0) +
							' epc=0x' + ($1 >>> 0).toString(16) +
							' expEvn=0x' + ($2 >>> 0).toString(16) +
							' sr=0x' + ($3 >>> 0).toString(16) +
							' vbr=0x' + ($4 >>> 0).toString(16) +
							' ssr=0x' + ($5 >>> 0).toString(16) +
							' spc=0x' + ($6 >>> 0).toString(16)});
					}, s_exc_log_count, (int)ex.epc, (int)ex.expEvn,
					   (int)ctx->sr.getFull(), (int)ctx->vbr,
					   (int)ctx->ssr, (int)ctx->spc);
					// Dump the PC ring buffer (last 32 block dispatches) with
					// R15 + PR snapshots so we can see when stack pointer or
					// return address first goes wrong. Researcher-1 hypothesis:
					// the bad PR=0x8c009dd0 was loaded from corrupted [R15]
					// or via a stale-cached PR write upstream.
					for (unsigned k = 0; k < PC_RING_LEN; k++) {
						const unsigned slot = (s_pc_ring_idx + k) % PC_RING_LEN;
						MAIN_THREAD_EM_ASM({
							postMessage({cmd: 'print', txt:
								'[exception]  ring[-' + (($1|0) - ($0|0)) + ']' +
								' pc=0x' + ($2 >>> 0).toString(16) +
								'->0x' + ($3 >>> 0).toString(16) +
								' r15=0x' + ($4 >>> 0).toString(16) +
								' pr=0x' + ($5 >>> 0).toString(16)});
						}, (int)k, (int)PC_RING_LEN,
						   (int)s_pc_ring_before[slot], (int)s_pc_ring_after[slot],
						   (int)s_pc_ring_r15[slot], (int)s_pc_ring_pr[slot]);
					}
				}
#endif // DEBUG_DISPATCH
				Do_Exception(ex.epc, ex.expEvn);
				// Pipeline drain cost on exception, mirrors interpreter
				// (sh4_interpreter.cpp:61). CPU_RATIO=8 in non-strict mode.
				ctx->cycle_counter -= 5 * 8;
			}

		}

		Sh4Interpreter::Instance = nullptr;
	}

	void handleException(host_context_t& /*context*/) override
	{
		// WASM has no native fault handler — exceptions propagate as C++
		// throws from the imports (e.g. SH4ThrownException out of the
		// IFB fallback). The dispatcher's normal driver path catches them.
		INFO_LOG(DYNAREC, "[rec_wasm] handleException stub");
	}

	bool rewrite(host_context_t& /*context*/, void* /*faultAddress*/) override
	{
		// No SIGSEGV-driven fastmem rewrites — every guest mem access goes
		// through the bounds-checked sh4_read*/sh4_write* imports.
		return false;
	}

	void canonStart(const shil_opcode* /*op*/) override
	{
		// TODO(canon): canonical-call ABI for SHIL native emit. Phase 1
		// only emits IFB fallbacks (emitShilOp returns true for shop_ifb
		// and false for everything else), so canonStart/Param/Call/Finish
		// are never reached on the IFB path. They'll be wired alongside
		// the first native SHIL emitter.
	}

	void canonParam(const shil_opcode* /*op*/, const shil_param* /*param*/,
	                CanonicalParamType /*paramType*/) override
	{
	}

	void canonCall(const shil_opcode* /*op*/, void* /*function*/) override
	{
	}

	void canonFinish(const shil_opcode* /*op*/) override
	{
	}

private:
	Sh4Context*     sh4ctx     = nullptr;
	Sh4CodeBuffer*  codeBuffer = nullptr;
};

static WasmDynarec instance;

#endif // FEAT_SHREC == DYNAREC_JIT && HOST_CPU == CPU_WASM

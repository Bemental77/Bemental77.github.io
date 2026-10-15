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
#include "hw/sh4/sh4_opcode_list.h"   // DIAG pchist disassembly
#include "hw/sh4/dyna/ngen.h"
#include "hw/sh4/dyna/blockmanager.h"
#include "hw/sh4/modules/mmu.h"   // mmu_enabled() — rollback keep-code load (patch 0002)
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
#include <map>
#include <string>
#include <algorithm>
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
static uint32_t g_compile_calls = 0;          // WasmDynarec::compile() calls (ctx_snapshot 111)
static uint32_t g_rb_stale_recompiles = 0;    // rollback-mode stale hit -> discard + recompile (ctx_snapshot 112)

static inline u32 jit_hash(u32 vaddr) {
    return (vaddr * 2654435761u) & JIT_TABLE_MASK;
}

// --- SMC invalidation (the stale-block fix, boot-title-wedge 2026-08-19) ---
// CONFIRMED: boot installs code at runtime (bootstrap2 rewrites
// 0x8c0084xx/0x8c0042xx; the GDROM HLE loader writes game code) and nothing
// invalidated compiled blocks — the dispatcher executed code compiled from
// the OLD bytes ([stale-block] reports: 0x8c00843e compiled 0x880150f9 vs
// RAM 0xd409d30b, +3 more, exactly the escape-trajectory blocks). The interp
// arm (always reads live RAM) boots clean; both JIT arms corrupted.
//
// Mechanism (v2 — FULL checksum): at install, sum every 16-bit code word of
// the block (direct mem_b reads — RAM-resident blocks only; BIOS is
// immutable). At lookup, recompute over live RAM (blocks cap at
// SH4_TIMESLICE/2 decode budget ≈ tens of bytes; measured cost ~3% of a
// dispatch) — a mismatch returns a miss, and the standard miss path
// recompiles from current RAM, refreshing the same hash slot in place (the
// old wasmTable entry leaks — bounded by boot-staging churn, acceptable).
//
// v1 verified only first+last words; the Reios trap-hook install (a single
// interior word written into an already-compiled block at the 0x8c00875a
// syscall stub) slipped through exactly as the documented gap predicted —
// the staging handoff then called a not-yet-hooked stub and jumped through
// a mid-load header pointer (stuck-pc at 0x6ded3c34 in zeroed RAM,
// pr=0x8c0042de, r3=0x6da60000). Full checksum closes the class.
static u32 s_block_sum[JIT_TABLE_SIZE];  // code checksum at install
static u32 s_block_len[JIT_TABLE_SIZE];  // code bytes (0 = no verify)

static inline bool vaddr_in_ram(u32 vaddr) {
    return ((vaddr & 0x1FFFFFFFu) >> 26) == 3;
}
static inline u32 ram_code_sum(u32 vaddr, u32 code_bytes) {
    u32 off = vaddr & 0x00FFFFFFu;
    u32 n = code_bytes >> 1;
    if (off + code_bytes > 0x01000000u) n = (0x01000000u - off) >> 1;
    u32 sum = 0;
    const u8* p = &mem_b[off];
    for (u32 i = 0; i < n; i++) {
        u16 w;
        memcpy(&w, p + i * 2, 2);
        sum += w + 0x9E3779B9u;  // position-independent-collision resistant enough
        sum = (sum << 5) | (sum >> 27);
    }
    return sum;
}

// Set by jit_lookup when it finds a registered block whose RAM has since
// changed (SMC). The trampoline reads and clears it to route the block to
// the interpreter instead of the miss/recompile path.
static bool g_lookup_stale = false;

// Monomorphic inline-cache epoch (defined in the emitter TU, single-int write only
// — the class proven SAFE for dispatch-path edits). 0=disarmed, 1=armed, ++ =
// invalidate every cached IC entry. Bumped here on SMC-stale + jit_clear so a
// cached dynamic-exit site can never serve a since-evicted/overwritten target.
extern volatile uint32_t g_ic_generation;
// TEST (2026-08-23): periodic IC-flush period-mask (power-of-two minus 1). When the
// IC covers cond/static exits, it stops calling jit_lookup so SMC verify lapses;
// flushing every (mask+1) chain-dispatches forces periodic re-verify. 0 = off (the
// shipped dynamic-only default). Settable at runtime via flycast_set_ic_flush.
volatile uint32_t g_ic_flush_mask = 0;   // PERIOD (chains between flushes); 0 = OFF (dynamic-only ships). >0 re-verifies every N chains — a cond/static-IC SMC net, but loader SMC out-races any period (see lever-3 doc); Build 2 (per-write hook) is the real fix.

// ---- Lever 4 / Build 2 (docs/lever-4-smc-bitmap): per-write SMC code map ----
// Byte map of the 4-BYTE guest-RAM words that contain compiled code (16MB/4B =
// 4M entries, 4MB BSS; chunk = (addr & 0xFFFFFF) >> 2 folds the 0x8C/0xAC
// mirrors). GRANULARITY LADDER (task-3 probes, 2026-08-24):
//   4KB pages  -> ~1.07M bumps/s at the STABLE title (PSO interleaves hot
//                 data with code in the same pages);
//   16B chunks -> ~1150/s, ALL from 0x8c379b80 — the ISR frame counter /
//                 INTEVT-latch data pair (the Maple-storm words) sharing one
//                 16B chunk with adjacent code;
//   4B words   -> data words become their own chunks. SH4 stores are
//                 naturally aligned (unaligned faults on real HW), so a w<=4
//                 store touches EXACTLY one word-chunk -> single load8 check.
// Populated by jit_register while armed (+ retroactively on arm); ZEROED on
// disarm so the emitter's branchless mark (`g_ic_generation += g_code_map[c]`)
// can never move the generation off 0 while disarmed. extern "C": the emitter
// TU bakes &g_code_map[...] as i32.const addresses. The +16 tail bytes guard
// any adjacent-entry read at the top edge (kept zero: both memsets cover
// sizeof). NO span pad and NO blanket next-chunk read — both false-positive
// on data adjacent to code (task-3b/3c storms); crossing only exists for the
// 8-byte immediate pair, whose two word-chunks are checked explicitly.
extern "C" {
uint8_t g_code_map[(1u << 22) + 16];
// DIAG (K2 attribution, strip after verdict): the emitted reg-EA mark also
// records the last PHYS address whose chunk was marked (branchless
// last += m*(phys-last)); ctxsnap 80 samples it — the dominant writer's
// target address surfaces statistically across 5s ticks.
uint32_t g_smc_last_addr;
// [smc] telemetry (ctxsnap 75-77,79): [0]=C slowpath single store, [1]=block/DMA
// chokepoint (WriteMemBlock_nommu_*), [2]=jit_register slot-churn re-register,
// [3]=jit_lookup clean->stale transitions (post-dedupe).
//
// [2026-08-29] LEDGER CLOSURE. These four were used to argue "no SMC occurred"
// over 75 s of shipping-binary gameplay (smcS=smcB=smcR=smcT=0 across all 59
// samples, cpg=10552) -- and that argument DID NOT HOLD, because icgen still
// advanced 2 -> 5 with all four reading 0. A source audit of every site that
// mutates g_ic_generation found FIVE further paths, none of which touched a
// counter:
//   [4] flycast_ic_invalidate()  -- savestate load replaces guest RAM wholesale
//   [5] jit_clear()              -- block-cache flush
//   [6] reset()                  -- flycast block-manager reset (code buffer)
//   [7] g_ic_flush_mask periodic -- inert at the shipped default 0
//   (E) THE EMITTED IN-WASM STORE MARK -- bementalJIT/guests/sh4/wasm_emit.cpp
//       emitSmcMarkLocal():87 and emitSmcMarkConstPage():135 do
//       `g_ic_generation += g_code_map[chunk]` BRANCHLESSLY, on the hot guest
//       store path, with no counter. This is the one that matters and the one
//       that cannot be counted inline: adding a counter there taxes EVERY
//       area-3 guest store, which is the same trade LEVER12/13 just retired.
// [4]-[7] are now counted. (E) is DERIVED instead, exactly and for free:
//   g_smc_gen_accounted accumulates the generation units added by every C-side
//   path and is rezeroed at each arm, so while armed
//       emitted_units = (g_ic_generation - 1) - g_smc_gen_accounted
//   is the number of generation units contributed by emitted stores. It is a
//   count of UNITS, not events (the 8-byte fmov.d pair marks two chunks and can
//   add 2 in one store), so it bounds events from above -- which is the correct
//   direction for a safety claim.
// PROVABILITY, which is the whole point: "no SMC occurred over this window" is
// now exactly `icgen delta == 0`, and the four/five/derived counters say WHICH
// path moved it when it is not 0. The old four could never support that claim.
volatile uint32_t g_smc_mark_counts[8];
// Generation units added by C-side paths since the last arm. Rezeroed by
// flycast_set_ic(1). See the ledger note above.
volatile uint32_t g_smc_gen_accounted;
}
// Lever-4 F1 (task-1 probe, 2026-08-24): a permanently-stale block (SMC'd once,
// interp-routed, never re-registered) re-bumped the generation on EVERY lookup
// — ~56 whole-IC flushes/s at the STABLE title, tags all zero. With the
// per-write hooks owning invalidation (any later write to a code page bumps),
// the stale-path bump dedupes to the clean->stale TRANSITION only. The sum is
// still recomputed every lookup, so a page restored to its compiled bytes
// (level reload) resurrects the block exactly as before — without a bump
// (its fn/index never changed; its entries were invalidated when it went
// stale and simply refill).
static uint8_t s_block_stale[JIT_TABLE_SIZE];
// Lever-5E1: generation at which this block's ram_code_sum last verified
// clean. Under the lever-4 invariant (EVERY write path into a compiled code
// word bumps g_ic_generation — emitted fastpaths, C slowpath, DMA
// chokepoints), an unchanged generation proves the block's bytes unchanged,
// so the O(len) per-lookup sum collapses to once-per-generation. The heavy
// phase paid this sum ~1.8M times/s (the IC thrashes on polymorphic exits
// and every miss re-summed). 0 = not verified this generation; disarmed
// (gen==0) always verifies — boot behavior unchanged.
static uint32_t s_block_vgen[JIT_TABLE_SIZE];
// ROLLBACK KEEP-CODE LOAD (patch 0002). The install UNIT a slot came from:
// blocks sealed together in one shard tail-link each other with a bare
// `return_call <idx>` resolved at compile time (bementalJIT wasm_emit.cpp
// "intra-shard tail-link" — an UNVERIFIED edge, no jit_lookup), so dropping
// ONE member of a shard while its siblings stay live is unsound: a sibling
// would still jump into the stale body. Invalidation therefore works on whole
// units. 0 = per-block install (its own module; no siblings).
static uint32_t s_block_unit[JIT_TABLE_SIZE];
static uint32_t s_cur_unit = 0, s_unit_serial = 0;
// ROLLBACK-MODE BATCH (rbb_compile, 2026-10-15). A batch member that was decoded
// AHEAD of its first execution, with the FPSCR/SR.FD of the miss that formed the
// batch, and that holds an FPU op (decode reads FPSCR.PR/SZ/RM, and SR.FD makes
// the decoder raise FpuDisabled). Per-block install decodes a block at its FIRST
// entry, with the FPSCR live then. So the member is UNCONFIRMED until its first
// entry: if the config live then equals the one it was decoded with, the code is
// what per-block install would have produced and the flag clears; otherwise the
// slot is discarded and the miss path compiles it from live state — again what
// per-block install would have done. 0 = confirmed / not a batch member.
static uint32_t s_block_fcfg[JIT_TABLE_SIZE];
static constexpr u32 FCFG_FPSCR_MASK = 0x00180003u;   // SZ(20) | PR(19) | RM(1:0)
static inline u32 fcfg_now() {
    return 0x80000000u | (Sh4cntx.fpscr.full & FCFG_FPSCR_MASK) | (Sh4cntx.sr.FD ? 0x40000000u : 0u);
}
static uint32_t g_rbb_cap = 32;          // members per batch incl. the miss; <= 1 = per-block (the control)
static uint32_t g_rbb_batches = 0;       // batches installed (ctx_snapshot 152)
static uint32_t g_rbb_members = 0;       // members installed AHEAD of execution (153)
static uint32_t g_rbb_fcfg_redo = 0;     // unconfirmed members whose first entry saw another FPU config (154)
static uint32_t g_rbb_dropped = 0;       // members built but not registered (probe limit) (155)
static uint32_t g_rbb_alias_drops = 0;   // misses whose other address view held the FPCA entry (157)
static void rb_discard_slot(u32 slot);   // defined with the keep-code load below
// Slot of the last jit_lookup that returned STALE (valid only right after it).
static uint32_t g_lookup_slot = 0;
static constexpr u32 SMC_CHUNKS = 1u << 22;   // 16MB >> 2
static inline void code_pages_mark_block(u32 vaddr, u32 code_bytes) {
    if (!vaddr_in_ram(vaddr) || code_bytes == 0) return;
    u32 off = vaddr & 0x00FFFFFFu;
    // Span-exact marking — no pad (false-positives data adjacent to code).
    u32 lo = off >> 2;
    u32 hi = (off + code_bytes - 1) >> 2;
    if (hi >= SMC_CHUNKS) hi = SMC_CHUNKS - 1;
    for (u32 c = lo; c <= hi; c++) g_code_map[c] = 1;
}
// C-path marks. One bump per event suffices: the IC hit compares the generation
// for EQUALITY, so a single ++ invalidates every entry; extra bumps only cost
// refills. Guarded on g_ic_generation so disarm stays inert.
extern "C" void smc_mark(uint32_t addr, uint32_t len, uint32_t tag) {
    if (!vaddr_in_ram(addr) || len == 0) return;
    u32 off = addr & 0x00FFFFFFu;
    // Width-exact: only the word-chunks the store touches.
    if (g_code_map[off >> 2] | g_code_map[(off + len - 1) >> 2]) {
        if (g_ic_generation) { ++g_ic_generation; ++g_smc_gen_accounted; }
        ++g_smc_mark_counts[tag < 3 ? tag : 2];
    }
}
extern "C" void smc_mark_range(uint32_t addr, uint32_t len, uint32_t tag) {
    if (!vaddr_in_ram(addr) || len == 0) return;
    u32 lo = (addr & 0x00FFFFFFu) >> 2;
    u32 hi = ((addr & 0x00FFFFFFu) + len - 1) >> 2;
    if (hi >= SMC_CHUNKS) hi = SMC_CHUNKS - 1;
    for (u32 c = lo; c <= hi; c++) {
        if (g_code_map[c]) {
            if (g_ic_generation) { ++g_ic_generation; ++g_smc_gen_accounted; }
            ++g_smc_mark_counts[tag < 3 ? tag : 2];
            return;
        }
    }
}

// Side-effect-free twin of jit_lookup: true iff jit_lookup(vaddr) would return a
// compiled block right now (registered, and not stale by the same rule). The
// PSO wait fast-forward (pswff_try) requires it for every block of the pass:
// a pending or stale block runs interpreted, which charges different cycles.
static bool jit_live(u32 vaddr) {
    u32 h = jit_hash(vaddr);
    for (u32 i = 0; i < JIT_PROBE_LIMIT; i++) {
        u32 slot = (h + i) & JIT_TABLE_MASK;
        if (s_block_pc[slot] == vaddr) {
            if (!s_block_fn[slot]) return false;
            if (s_block_fcfg[slot] && s_block_fcfg[slot] != fcfg_now()) return false;   // first entry would recompile
            if (s_block_len[slot] == 0) return true;
            const uint32_t gen = g_ic_generation;
            if (gen != 0 && s_block_vgen[slot] == gen && !s_block_stale[slot]) return true;
            return ram_code_sum(vaddr, s_block_len[slot]) == s_block_sum[slot];
        }
        if (s_block_pc[slot] == 0) return false;
    }
    return false;
}
// A verified hit about to run. An unconfirmed batch member (s_block_fcfg) is
// confirmed here, or discarded so the miss path compiles it from live state.
static inline BlockFn jit_confirm(u32 slot) {
    const u32 c = s_block_fcfg[slot];
    if (c) {
        if (c != fcfg_now()) { rb_discard_slot(slot); ++g_rbb_fcfg_redo; return nullptr; }
        s_block_fcfg[slot] = 0;
    }
    return s_block_fn[slot];
}
static BlockFn jit_lookup(u32 vaddr) {
    g_lookup_stale = false;
    u32 h = jit_hash(vaddr);
    for (u32 i = 0; i < JIT_PROBE_LIMIT; i++) {
        u32 slot = (h + i) & JIT_TABLE_MASK;
        if (s_block_pc[slot] == vaddr) {
            // SMC verify: live RAM must still match the compiled snapshot.
            // Mismatch = stale block (a loader/stage overwrote the code;
            // flycast's vmem write-protection is off with nvmem disabled, so
            // neither our hash nor flycast's bm was invalidated). Signal
            // STALE (distinct from miss) so the trampoline INTERPRETS this
            // block instead of recompiling — recompiling would desync
            // flycast's bm and crash bm_AddBlock's FPCA verify at stage-2.
            // The interpreter reads live RAM, so it's always correct; boot
            // loaders run once, so the interpret cost is negligible.
            if (s_block_len[slot] != 0) {
                // Lever-5E1: skip the O(len) sum when this block already
                // verified clean in the CURRENT generation (see s_block_vgen).
                const uint32_t gen = g_ic_generation;
                if (gen != 0 && s_block_vgen[slot] == gen && !s_block_stale[slot])
                    return jit_confirm(slot);
                if (ram_code_sum(vaddr, s_block_len[slot]) != s_block_sum[slot]) {
                    g_lookup_stale = true;
                    g_lookup_slot = slot;
                    s_block_vgen[slot] = 0;
                    // Lever-4 F1 dedupe: bump ONLY on the clean->stale
                    // transition. Repeat lookups of a known-stale block add
                    // nothing — the write hooks own invalidation for any NEW
                    // write to a code page.
                    if (!s_block_stale[slot]) {
                        s_block_stale[slot] = 1;
                        if (g_ic_generation) { ++g_ic_generation; ++g_smc_gen_accounted; }
                        ++g_smc_mark_counts[3];
                    }
                    return nullptr;
                }
                s_block_stale[slot] = 0;   // sum matches -> (re)verified
                s_block_vgen[slot] = gen;  // stamp; 0 while disarmed = no skip
            }
            return jit_confirm(slot);
        }
        if (s_block_pc[slot] == 0)     return nullptr;
    }
    return nullptr;
}

static bool jit_register(u32 vaddr, BlockFn fn, u32 code_bytes) {
    const bool verify = vaddr_in_ram(vaddr) && code_bytes >= 2;
    u32 h = jit_hash(vaddr);
    for (u32 i = 0; i < JIT_PROBE_LIMIT; i++) {
        u32 slot = (h + i) & JIT_TABLE_MASK;
        if (s_block_pc[slot] == 0 || s_block_pc[slot] == vaddr) {
            const bool fresh = (s_block_pc[slot] == 0);
            if (fresh) ++s_block_count;
            s_block_fn[slot]  = fn;
            s_block_pc[slot]  = vaddr;
            s_block_len[slot] = verify ? code_bytes : 0;
            s_block_sum[slot] = verify ? ram_code_sum(vaddr, code_bytes) : 0;
            s_block_stale[slot] = 0;   // fresh snapshot — no longer known-stale
            s_block_unit[slot] = s_cur_unit;   // patch 0002: install unit
            s_block_fcfg[slot] = 0;            // rbb_compile sets it after registering a member
            // Lever-5E1: the sum just computed IS this generation's verification.
            s_block_vgen[slot] = (verify && g_ic_generation) ? g_ic_generation : 0;
            // Build 2 (lever-4): a RE-compile moves this vaddr to a NEW wasmTable
            // index; an IC entry caching the OLD one serves stale — bump the
            // generation (validated in the lever-3 ladder, row 4). A FIRST-time
            // registration needs no bump: no current-generation IC entry can hold
            // an index for a pc that was a lookup miss until now — this keeps
            // cold-arm boot compile churn free. Pages are marked either way so
            // the per-write hooks see them as code.
            if (g_ic_generation) {
                code_pages_mark_block(vaddr, verify ? code_bytes : 0);
                if (!fresh) { ++g_ic_generation; ++g_smc_gen_accounted; ++g_smc_mark_counts[2]; }
            }
            return true;
        }
    }
    return false;  // probe-limit hit — caller falls back to interp this iter
}

// ORDER 21b Lever 1/2 — GLOBAL cross-shard / dynamic tail-link resolver.
// Emitted blocks (bementalJIT emit_global_probe) call this on a dynamic/cross-
// shard exit to resolve the target vaddr to its shared-wasmTable index, then
// return_call_indirect straight into it instead of round-tripping to the C
// trampoline. On wasm32 a BlockFn IS the __indirect_function_table index.
// Returns -1 on miss OR SMC-stale (jit_lookup sets g_lookup_stale + returns
// null) — the probe then falls back to the trampoline, which interprets the
// stale block. That is why the chain is SMC-safe (GC scar #3) with NO separate
// evict path: jit_lookup's per-lookup ram_code_sum verify IS the bucket guard.
// g_chain_enabled gates the whole lever at runtime for matched-pair A/B (no
// rebuild) and as a kill-switch. g_chain_hits/g_chain_misses are scar-#2
// telemetry (a climbing miss rate = under-covered, not healthy).
volatile bool g_chain_enabled = true;
uint64_t g_chain_hits = 0, g_chain_misses = 0;
extern "C" {
    extern uint32_t g_ras_pc, g_ras_slot, g_ras_gen;   // lever-5E3 (emitter TU)
}
extern "C" { extern volatile uint32_t g_idleskip; extern volatile uint32_t g_gwff; extern volatile uint32_t g_pswff; }
extern "C" EMSCRIPTEN_KEEPALIVE int sh4_jit_lookup_idx(uint32_t vaddr) {
    if (!g_chain_enabled) return -1;
    // THE IDLE-SKIP PCS ARE NEVER CHAINED INTO. The idle-skip check lives only
    // in the C trampoline (wasm_block_trampoline), so an edge that tail-linked
    // straight into the frame-wait spin skipped the check and ran the spin body
    // instead of burning. Whether an edge chains depends on whether its target
    // was compiled when the edge was LAST resolved — host history — so a
    // cold-cache run and a warm-cache run of the same frame from the same state
    // charged different cycles (measured with a credit-pass trace: first
    // difference at pass 3726, pc 0x8c3c53d8, residual 0 cold vs -4 warm; per-
    // frame guest cycles 6672302/6673198 cold vs 6672750/6672750 warm). That
    // made the trajectory depend on what this console happened to have compiled,
    // which a rollback (or a room whose consoles compiled different code) cannot
    // allow. A miss here returns the edge to the trampoline, so every arrival at
    // the spin sees the same check. IC/RAS slots are only ever filled from a hit
    // here, so they cannot cache these targets either.
    if (g_idleskip && (vaddr == 0x8c3c53d8u || vaddr == 0x8c3c53e0u || vaddr == 0x8c3c53f8u)) return -1;
    // Same rule for the Gauntlet wait-loop head (gwff_try lives in the trampoline).
    if (g_gwff && vaddr == 0x8c032e5au) return -1;
    if (vaddr == 0x8c38d480u) return -1;   // PSO wait-loop head (pswff_try), in every arm: see flycast_set_pswff
    BlockFn fn = jit_lookup(vaddr);
    if (fn) { ++g_chain_hits;
        // Lever-5E3 fill: this resolve IS the prediction's answer. Armed-only
        // (disarmed keeps g_ras_gen at its never-matching sentinel).
        if (vaddr == g_ras_pc && g_ic_generation) {
            g_ras_slot = (uint32_t)(uintptr_t)fn;
            g_ras_gen  = g_ic_generation;
        }
        return (int)(uintptr_t)fn; }
    ++g_chain_misses;
    return -1;
}
// #IC monomorphic inline-cache arm toggle (matched-pair A/B, mirrors flycast_set_chain).
// on: arm (generation 0->1 so emitted fills begin + hits become live). off: disarm
// (generation=0 -> no fills, hits never match -> byte-identical to no-IC). Parent
// flips ON only AFTER the title renders (boot code is SMC-heavy; disarmed through boot).
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_ic(int on) {
    if (on) {
        if (g_ic_generation == 0) {
            g_ic_generation = 1;
            // Ledger rebase: the derived emitted-mark count is
            // (g_ic_generation - 1) - g_smc_gen_accounted, which is only valid
            // measured from the arm that set the generation to 1. Rezero here
            // so an arm/disarm/re-arm cycle cannot make the residual go
            // negative and read as a huge unsigned number.
            g_smc_gen_accounted = 0;
            // Build 2 (lever-4): retroactively mark the pages of every block
            // compiled while disarmed, so the per-write SMC hooks see them.
            for (u32 slot = 0; slot < JIT_TABLE_SIZE; slot++)
                if (s_block_pc[slot] != 0 && s_block_len[slot] != 0)
                    code_pages_mark_block(s_block_pc[slot], s_block_len[slot]);
        }
    } else {
        g_ic_generation = 0;
        // All-zero map keeps the branchless emitted mark inert while disarmed.
        memset((void*)g_code_map, 0, sizeof(g_code_map));
    }
}
extern "C" void bemental_sh4_set_slice_inwasm(int on);
extern "C" { volatile uint32_t g_gwff = 1; }    // Gauntlet wait-loop fast-forward (gwff_try)
static volatile uint32_t g_gwff_runs = 0;      // fast-forwards applied
static volatile uint32_t g_gwff_passes = 0;    // passes applied (wraps)
static volatile uint32_t g_gwff_fallbacks = 0; // head arrivals that ran the pass for real
extern "C" { volatile uint32_t g_pswff = 1; }   // PSO wait-loop fast-forward (pswff_try): 0 off, 1 on, 2 DIAG check
static volatile uint32_t g_pswff_runs = 0, g_pswff_passes = 0, g_pswff_fallbacks = 0;
static volatile uint32_t g_pswff_chk_ok = 0, g_pswff_chk_bad = 0;
void bm_ResetCache();
// Slice end inside emitted code (sh4_slice_end). COMPILE-time: set before blocks build.
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_slice_inwasm(int on) {
    bemental_sh4_set_slice_inwasm(on);
    bm_ResetCache();   // blocks compiled under the other setting must not survive the switch
}
// div32u/s/p2 inline in emitted code (wasm_emit.cpp emitDiv32Inline);
// default OFF (the C fallback); ?divinline=1 arms it. COMPILE-time.
extern "C" void bemental_sh4_set_div_inline(int on);
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_divinline(int on) {
    bemental_sh4_set_div_inline(on);
    bm_ResetCache();
}
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_chain(int on) {
    g_chain_enabled = !!on;
}
// Lever-4: full IC invalidate without touching the block table (savestate
// load replaces guest RAM wholesale; cached {ic_pc,ic_slot} pairs may point
// at code that changed while their tags still match).
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_ic_invalidate(void) {
    // Ledger [4] -- see the g_smc_mark_counts note. Counted so a savestate load
    // cannot be mistaken for guest self-modifying code in the [smc] line.
    if (g_ic_generation) { ++g_ic_generation; ++g_smc_gen_accounted; ++g_smc_mark_counts[4]; }
}
// Lever-4 task 6 — parity gate: while g_parity_hashing, the crediting-loop
// delivery gate folds the architectural state (pc, r0-r15, sr, pr, gbr, vbr,
// ssr, spc, mac) into a rolling FNV hash each pass. The IC changes ONLY the
// dispatch route to an already-resolved target, so an armed run must produce
// the identical pass count + hash as a disarmed run from the same savestate;
// any wrong-target dispatch mutates state and diverges the hash at the next
// C return. Driven by emscripten_parity_run (EmscriptenWorker.cpp).
extern "C" {
volatile uint32_t g_parity_hashing = 0;
uint32_t g_parity_hash = 2166136261u;
uint32_t g_parity_passes = 0;
// Lever-5B sizing instrument: shop_sync_sr fire count (bumped in
// sh4_interp_shil_fb; each fire = flushAll + import + UpdateSR + reload).
volatile uint32_t g_syncsr_count = 0;
// Lever-10 sizing instrument: shop_sync_fpscr fire count (bumped in
// sh4_interp_shil_fb; each fire = flushAll + import + UpdateFPSCR + reload,
// and the containing block is fusion-excluded). Read via ctxsnap 89.
volatile uint32_t g_syncfpscr_count = 0;
volatile uint32_t g_div32_count = 0;      // shop_div32u/s/p2 C-fallback fires (ctxsnap 146)
// Lever-11: PSO frame-wait-spin slice burn. DEFAULT ON, same shape as the
// lever-6 shard default (dreamcast.html sends `shard on:0` for ?noshard=1
// against a wasm that defaults ON). Burns counted via ctxsnap 90.
//
// Headroom, per commit 83315e3's own matched uncapped pairs on the bounded
// mechanism that is actually in this file: B 402.4/391.2 MHz vs S 618.0/613.5
// MHz = +55%, sentinel drift -2.8%. (The older 410 -> 636 MHz figure predates
// 83315e3 and describes the UNBOUNDED skip — do not quote it for this build.)
// Native PSO is 200 MHz / 30 fps.
//
// RE-MEASURED 2026-08-28 on this bounded mechanism (the line above used to say
// "neither number was re-measured; no build/probe was run" — it has been now).
// Interleaved S/B/S/B, --uncap --loadstate state.bin (PSO CHARACTER SELECT —
// the only state that still restores; see the savestate note below), 60s arms,
// clk median of the final 12 heartbeats:
//     S1 877.02 MHz / 131.5 fps      B1 432.40 MHz / 65 fps
//     S2 815.39 MHz / 122.0 fps      B2 472.25 MHz / 71 fps
// S/B = 2.03x and 1.73x. Sentinel drift was -7.0% (S) / +9.2% (B) because
// eight other agents were building and probing on the same host throughout —
// the effect is ~10x the drift, but treat +-9% as the noise floor for ANY
// matched pair taken under that load, and re-take pairs on a quiet host.
// Best quiet-ish read (same scene, 1 competing probe): 937 MHz / 140 fps.
//
// The skip does NOT inflate clk. Guest cycles per PRESENTED frame are
// identical across all four arms above — 6.67 / 6.65 / 6.68 / 6.65 MHz/frame
// against native PSO's 200/30 = 6.67 — i.e. every fast-forwarded cycle still
// buys a proportional real HW frame. clk/200 is therefore an honest real-time
// multiple here: ~4.1-4.7x native, 122-140 presented fps, render verified
// intact by screenshot at 130 fps.
//
// SAVESTATE TRAP: /tmp/dcx-state-user2.bin — the state EVERY lever-8/9/10/11
// gameplay verdict was measured on — no longer restores against this build
// ("[page] state load FAILED"; the run silently cold-boots to the title screen
// instead, which still reads ~940 MHz and looks like a valid gameplay number).
// Confirm "[page] state loaded OK" in the log before believing any scene.
//
// Safety rests on the ISK_RUN bound in wasm_block_trampoline, not on the skip
// being "free": at most ISK_RUN consecutive visits to the spin PCs are
// skipped, then the block executes for real, so the guest always gets to run
// the compare that lets it leave the loop. Both earlier unbounded cuts hung a
// cold boot for exactly that reason.
//
// ESCAPE HATCH: the page must send `{cmd:'setidleskip', on:0}` for a
// ?noidleskip=1 query. That line has since LANDED (dreamcast.html — the
// `_isk.has('noidleskip')` arm), and the B arms of the pair above are its
// runtime proof: ?noidleskip=1 measurably halves the clock, so the OFF switch
// really reaches g_idleskip. The earlier "no runtime OFF exists yet" warning
// here is obsolete.
volatile uint32_t g_idleskip = 1;
// ROLLBACK DETERMINISM (patch 0001, dreamcast/docs/rollback/TASKS.md).
// The idle-skip progress bound's streak used to be a function-static inside
// wasm_block_trampoline. No savestate carries it and no reset cleared it, so
// two runs restored from the SAME bytes started with different streaks and
// executed (or skipped) a different visit of PSO's frame-wait spin — a
// different number of guest cycles burned before the next event. Hoisted
// here so WasmDynarec::reset() (every state load, via bm_ResetCache) and
// flycast_rb_reset_host_history() can zero it.
static u32 s_isk_streak = 0;
// Wall-clock guard. While set, the 2 s frame watchdog (dispatch_slice) is
// suspended exactly as it is for a parity arm: it converts host wall time
// into guest trajectory (it ends a frame at a wall-dependent dispatch), which
// no rollback or lockstep peer can reproduce. Set by netplay rooms.
volatile uint32_t g_deterministic = 0;
volatile uint32_t g_idleskip_burns = 0;
// DIAG (idle-share sizing, 2026-10-15): guest-time PC histogram. Every
// credited slice attributes the guest cycles since the previous slice
// boundary to the PC the slice ended at (block entry); idle-skip burns are
// attributed to their PC separately. flycast_pchist(1) arms, (2) prints the top.
static bool g_pch_on = false;
static constexpr u32 PCH_N = 1u << 14;
static u32 g_pch_pc[PCH_N]; static u64 g_pch_cyc[PCH_N], g_pch_burn[PCH_N];
static u64 g_pch_last = 0, g_pch_total = 0, g_pch_burnt = 0;
static inline u64* pch_slot(u32 pc, bool burn) {
	u32 h = (pc * 2654435761u) & (PCH_N - 1);
	for (u32 i = 0; i < 64; i++, h = (h + 1) & (PCH_N - 1)) {
		if (g_pch_pc[h] == pc || g_pch_pc[h] == 0) { g_pch_pc[h] = pc; return burn ? &g_pch_burn[h] : &g_pch_cyc[h]; }
	}
	return nullptr;
}
static const u32* g_pch_arm_ptr = nullptr;   // &arm_Reg[R15_ARM_NEXT], resolved when the histogram arms
static u32 g_pcha_pc[4096]; static u32 g_pcha_n[4096]; static u32 g_pcha_total = 0;
static inline void pcha_sample() {
	if (!g_pch_arm_ptr) return;
	const u32 apc = *g_pch_arm_ptr;
	u32 h = (apc * 2654435761u) & 4095;
	for (u32 i = 0; i < 32; i++, h = (h + 1) & 4095)
		if (g_pcha_pc[h] == apc || g_pcha_n[h] == 0) { g_pcha_pc[h] = apc; g_pcha_n[h]++; g_pcha_total++; return; }
}
static inline void pch_sample(u32 pc) {
	const u64 now = sh4_sched_now64();
	const u64 d = now - g_pch_last; g_pch_last = now;
	if (d > 2000000) return;   // state jump
	g_pch_total += d;
	if (u64* c = pch_slot(pc, false)) *c += d;
	pcha_sample();
}
static inline void pch_burn(u32 pc, u64 cyc) {
	g_pch_burnt += cyc; g_pch_total += cyc; g_pch_last += cyc;
	if (u64* c = pch_slot(pc, true)) *c += cyc;
}
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_pchist(int what) {
	if (what == 1) { memset(g_pcha_n, 0, sizeof g_pcha_n); g_pcha_total = 0; memset(g_pch_pc, 0, sizeof g_pch_pc); memset(g_pch_cyc, 0, sizeof g_pch_cyc); memset(g_pch_burn, 0, sizeof g_pch_burn);
	                 g_pch_total = g_pch_burnt = 0; g_pch_last = sh4_sched_now64(); g_pch_on = true; return; }
	if (what != 2) { g_pch_on = false; return; }
	std::vector<u32> idx;
	for (u32 i = 0; i < PCH_N; i++) if (g_pch_pc[i]) idx.push_back(i);
	std::sort(idx.begin(), idx.end(), [](u32 a, u32 b) { return g_pch_cyc[a] + g_pch_burn[a] > g_pch_cyc[b] + g_pch_burn[b]; });
	char line[512];
	snprintf(line, sizeof line, "[pchist] total=%llu cyc (%.2f guest s) burnt=%llu (%.2f%%) pcs=%u",
	         (unsigned long long)g_pch_total, g_pch_total / 200e6, (unsigned long long)g_pch_burnt,
	         g_pch_total ? 100.0 * g_pch_burnt / g_pch_total : 0.0, (unsigned)idx.size());
	MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, line);
	{
		std::vector<u32> ai; for (u32 i = 0; i < 4096; i++) if (g_pcha_n[i]) ai.push_back(i);
		std::sort(ai.begin(), ai.end(), [](u32 a, u32 b) { return g_pcha_n[a] > g_pcha_n[b]; });
		snprintf(line, sizeof line, "[pchist-arm] samples=%u distinct=%u (ARM7 PC where each sample's run stopped)", g_pcha_total, (unsigned)ai.size());
		MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, line);
		for (size_t k = 0; k < ai.size() && k < 12; k++) {
			const u32 apc = g_pcha_pc[ai[k]];
			std::string w; char b2[16];
			for (int j = -4; j < 8; j++) { snprintf(b2, sizeof b2, "%08x ", *(u32*)&aica::aica_ram[(apc + j * 4) & ARAM_MASK]); w += b2; }
			snprintf(line, sizeof line, "[pchist-arm] %5.2f%% pc=%06x words[-4..7]: %s", 100.0 * g_pcha_n[ai[k]] / std::max(1u, g_pcha_total), apc, w.c_str());
			MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, line);
		}
	}
	for (size_t k = 0; k < idx.size() && k < 40; k++) {
		const u32 i = idx[k], pc = g_pch_pc[i];
		std::string dis;
		for (u32 j = 0; j < 12; j++) {
			u16 op = 0; try { op = ReadMem16(pc + j * 2); } catch (...) {}
			char d[256] = {0}; if (OpDesc[op]) OpDesc[op]->Disassemble(d, pc + j * 2, op);
			// keep only the mnemonic (drop the live register dump the disassembler appends)
			std::string t = d; size_t sp = t.find(" ; "); if (sp != std::string::npos) t = t.substr(0, sp);
			for (const char* q = "R0123456789"; false;) (void)q;
			{ size_t k2 = t.find(" R"); while (k2 != std::string::npos && t.find('=', k2) != std::string::npos && t.find('=', k2) < t.find(' ', k2 + 1)) { t = t.substr(0, k2); break; } }
			dis += t;
			if ((op & 0xF000) == 0xD000) {   // mov.l @(disp,PC),Rn: show the literal
				const u32 la = ((pc + j * 2) & ~3u) + 4 + (op & 0xFF) * 4; u32 lv = 0; try { lv = ReadMem32(la); } catch (...) {}
				char lb[24]; snprintf(lb, sizeof lb, " {=%08x}", lv); dis += lb;
			}
			dis += " ; ";
		}
		snprintf(line, sizeof line, "[pchist] %5.2f%% exec %5.2f%% burn pc=%08x  %s",
		         100.0 * g_pch_cyc[i] / g_pch_total, 100.0 * g_pch_burn[i] / g_pch_total, pc, dis.substr(0, 380).c_str());
		MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, line);
	}
}
// Frame-watchdog run_iter generation (bumped in emscripten_run_iter). The
// watchdog's old reset heuristic (1M-dispatch gap) assumed a free-running
// dispatch rate; below ~500K disp/s (capped pacing, or idleskip) the reset
// lost the race against the 2s threshold and it FALSE-FIRED ~6x/min on
// healthy frames — including on the shipped capped page. Resetting per
// run_iter entry restores the intended "one frame stuck >2s wall" meaning.
volatile uint32_t g_wd_iter_gen = 0;
// Lever-5 attribution (strip after verdict): wall-ms split — SH4 mainloop
// vs whole retro_run. Ratio names the heavy phase's true owner (JIT vs
// renderer/devices). One get_now pair per mainloop ENTRY (frame-rate
// cadence, not per-dispatch — RELEASE-safe).
double g_attr_mainloop_ms = 0.0;
double g_attr_retro_ms = 0.0;
// ---------------------------------------------------------------------------
// Lever-12 mainloop split (2026-08-29). g_attr_mainloop_ms proved 99.16%
// capped / 99.59% uncapped of retro_run — i.e. nothing is lost OUTSIDE
// emulation — but it does NOT separate JIT execution from device work,
// because BOTH happen inside mainloop. This block closes that split.
//
// The three non-JIT consumers inside mainloop, and where each is timed:
//
//   [1] sh4_sched_tick()  -- HERE (crediting loop, below).
//       Every device callback: AicaUpdate (ARM7 + AICA_Sample), spg_line_sched
//       (VBLANK + Emulator::vblank), rend_end_render (ASIC RENDER_DONE raise),
//       TMU, maple, GDROM, AICA-DMA end, RTC. Fires only when sh4_sched_next
//       goes negative -- NOT per dispatch. AICA reschedules at AICA_TICK=4535
//       cycles => ~44.1K ticks/s; every other registered event is <1K/s
//       (getNextSpgInterrupt schedules to the next INTERESTING scanline, ~5-6
//       per field, not per line, unless SPG_HBLANK_INT.hblank_int_mode==2).
//       So sched_n/s is ~99% AicaUpdate, and that is CHECKABLE at runtime:
//       awr+adrop in the same heartbeat is exactly AICA_Sample calls/s. If
//       sched_n ~= awr+adrop, this bucket IS AICA+ARM7.
//
//   [2] the STARTRENDER store and the other Holly/PVR register stores --
//       timed in EmscriptenWorker.cpp's sh4_mem_write32, NOT here. See the
//       long note there: config::ThreadedRendering is force-disabled under
//       __EMSCRIPTEN__ (emulator.cpp Emulator::start), so pvrQueue.enqueue()
//       executes INLINE and the entire TA parse + GL draw + Present runs
//       inside one guest store instruction, inside a JIT block, inside this
//       mainloop. It is NOT a sched callback and never was.
//
//   [3] store-queue bursts (shop_pref -> doSqWrite) -- timed in
//       EmscriptenWorker.cpp's sh4_interp_shil_fb. This is the TA vertex
//       submission path.
//
// JIT-execution wall is then the RESIDUAL: mainloop - [1] - [2] - [3]. The
// four buckets are disjoint: [1] runs only from the crediting loop, [2] only
// from the guest write import, [3] only from the SHIL fallback import, and
// none nests inside another (sched callbacks are host-side and do not go
// through the guest store imports; rend_start_render only ARMS the
// render-done event via sh4_sched_request, it does not tick the scheduler).
//
// ---------------------------------------------------------------------------
// LEVER13_SCHED_TIMER -- DEFAULT 0 SINCE 2026-08-29. The `sch` bucket is RETIRED
// as a measurement; only its EVENT COUNT survives. Same species, same evidence
// and same remedy as LEVER12_HOT_TIMERS (EmscriptenWorker.cpp) -- that audit
// retired `pvr`/`sq` and KEPT `sch` on the grounds that its per-event reading
// (2645 ns) sat 6.0x above the emscripten_get_now() quantum, i.e. that the
// bucket RESOLVES. It does. That was the wrong question: a bucket can resolve
// and still cost more than it is worth.
//
// MEASURED, not argued. A CDP CPU profile of the emu worker (25.07 s of samples,
// PSO gameplay from /tmp/dcx-state-user2.bin, /tmp/dcx-worker.cpuprofile) puts
// 3.91% of ALL worker self time in
//     _emscripten_get_now <- wasm-to-js <- WasmDynarec::dispatch_slice
// and dispatch_slice's only get_now callers in a RELEASE build are (a) the
// frame watchdog at `(s_dispatch_count & 0x3FFFF) == 0`, which fires 2-4x/s and
// cannot be it, and (b) THIS PAIR, which fires twice per sh4_sched_tick. The
// [split] line reads n=10,689 ticks/s, so 21,378 calls/s. Whole clock-read
// bucket incl. the boundary trampoline: 4.67% of worker self time.
//
// The arithmetic closes against the shipped LEVER-12 verdict independently:
// that pair measured ~738 ns per get_now() call at machine load 23-41, so
// 21,378 x 738 ns = 15.8 ms/s of pure observer on a ~330 ms/s mainloop = 4.8%.
// Against the bucket's OWN reading (32.8 ms/s over 10,689 ticks = 3.07 us/tick)
// the observer is 1.48 us of the 3.07 -- the instrument is ~48% of what it
// reports, and true sched work is ~1.6 us/tick.
//
// WHY NOT SAMPLED (time 1 tick in N, as `sq` does). It would cost ~0 and still
// give a mean. Not taken here because sched ticks are DRIVEN BY SH4_TIMESLICE
// and the devices on the list have their own fixed periods (AICA every
// AICA_TICK=4535 cycles, SPG per line, VBlank per field), so a power-of-two
// stride can alias onto one device's period and sample a biased subset. A
// sampled `sch` would be cheap and WRONG, which is worse than absent. If it is
// ever wanted, sample on a counter that is not a multiple of the timeslice.
//
// CONSEQUENCE FOR THE SPLIT: with the timer off, sched cost lands in the `jit`
// residual, which note (f) already documents as an upper bound. The [split]
// line prints `sch=-` with its count, and the fat-tick split (which needs
// per-tick durations) is unavailable and prints as such. g_attr_sched_timed is
// the single source of truth the printer reads -- EmscriptenWorker.cpp does NOT
// carry a second copy of this #define, because two defines that must agree is
// exactly how a build ships a line that lies about its own units.
//
// Set to 1 to restore per-tick timing (measurement arm only).
#ifndef LEVER13_SCHED_TIMER
#define LEVER13_SCHED_TIMER 0
#endif
uint32_t g_attr_sched_timed = LEVER13_SCHED_TIMER ? 1u : 0u;
double   g_attr_sched_ms    = 0.0;   // total wall inside sh4_sched_tick()
uint32_t g_attr_sched_n     = 0;     // sh4_sched_tick() calls
// Fat-tick subset. An AicaUpdate tick is 512 ARM7 cycles + a 64-channel
// AICA_Sample mix; a VBLANK tick additionally runs Emulator::vblank ->
// runner.execTasks(). Splitting on duration separates "many small AICA ticks"
// from "few fat device ticks" WITHOUT needing per-callback identity (which
// would require a hook inside sh4_sched.cpp's handle_cb -- deliberately not
// taken, see the report). One compare per tick.
double   g_attr_schedfat_ms = 0.0;
uint32_t g_attr_schedfat_n  = 0;
static constexpr double SCHED_FAT_MS = 0.05;   // 50 us
// Lever-5D sizing: IFB fallback op mix (bumped in sh4_interp_ifb).
volatile uint32_t g_ifb_ftrv = 0, g_ifb_fipr = 0, g_ifb_fsca = 0, g_ifb_other = 0;
}

// Lever-12 buckets [2] and [3] live in EmscriptenWorker.cpp, which owns the
// sh4_mem_write*/sh4_interp_shil_fb guest imports they hang off. Declared here
// so flycast_ctx_snapshot can report the cumulative totals alongside [1].
extern "C" {
extern double   g_attr_render_ms;   // STARTRENDER store -> full synchronous render
extern uint32_t g_attr_render_n;
extern double   g_attr_pvrreg_ms;   // every OTHER Holly/PVR register store
extern uint32_t g_attr_pvrreg_n;
extern double   g_attr_sq_ms;       // store-queue bursts, SAMPLED
extern uint32_t g_attr_sq_n;        // exact burst count
extern uint32_t g_attr_sq_smp;      // bursts actually timed
extern uint32_t g_attr_sq_ta_n;     // subset of bursts routed to the TA FIFO
}

static void jit_clear() {
    memset(s_block_fn, 0, sizeof(s_block_fn));
    memset(s_block_pc, 0, sizeof(s_block_pc));
    s_block_count = 0;
    // Ledger [5] -- cache flush invalidates every IC entry. Counted (see the
    // g_smc_mark_counts note): this is administrative, NOT guest SMC.
    if (g_ic_generation) { ++g_ic_generation; ++g_smc_gen_accounted; ++g_smc_mark_counts[5]; }
    // Build 2 (lever-4): cleared blocks no longer occupy their pages; armed
    // re-registration re-marks them as compiles come back.
    memset((void*)g_code_map, 0, sizeof(g_code_map));
    memset(s_block_stale, 0, sizeof(s_block_stale));
    memset(s_block_vgen, 0, sizeof(s_block_vgen));
    memset(s_block_unit, 0, sizeof(s_block_unit));
    memset(s_block_fcfg, 0, sizeof(s_block_fcfg));
}

// Lever-6B: dispatch-loop state hoisted to file scope so the inner loop can
// live OUTSIDE mainloop's lexical try/catch. Emscripten-EH turns every call
// inside a try into an invoke_* thunk (wasm->JS->wasm); at ~0.5-1M dispatches/s
// that JS hop was ~2-3% of wall (profile: invoke_v <- mainloop). The loop now
// runs in dispatch_slice (noinline); SH4ThrownException still unwinds through
// it to mainloop's catch.
static unsigned long s_dispatch_count = 0;
static uint64_t s_cache_miss = 0;
#ifdef DEBUG_DISPATCH
static unsigned long s_mainloop_entries = 0;
static u32 s_last_logged_pc = 0;
static constexpr unsigned PC_RING_LEN = 256;
static u32 s_pc_ring_before[PC_RING_LEN] = {0};
static u32 s_pc_ring_after [PC_RING_LEN] = {0};
static u32 s_pc_ring_r15   [PC_RING_LEN] = {0};
static u32 s_pc_ring_pr    [PC_RING_LEN] = {0};
static unsigned s_pc_ring_idx = 0;
static bool s_region_trap_fired = false;
#else
static unsigned long s_mainloop_entries = 0;   // referenced by mainloop entry count either way
#endif

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
// Interpreted instructions spent on pending (compiled, un-sealed) spans since
// the last seal; >= SHARD_INTERP_SEAL seals (span_interp_pending).
static u32 s_pending_interp = 0;
static constexpr u32 SHARD_INTERP_SEAL = 50000;
// 6D fix: the pending-vaddr dedup set must live WITH the pending vector —
// as a function-static it survived seals and bm resets, so recompiled
// blocks skipped the push forever while fresh RuntimeBlockInfo* churned.
static std::unordered_set<u32> s_pending_vaddrs;
// vaddr -> code bytes for the blocks in the CURRENT un-sealed shard. Cleared
// wholesale at every seal and at reset(). ORDERED (std::map, not
// unordered_map) so a mid-span pc can be resolved back to the span that
// contains it — see find_span/span_interp_pending.
static std::map<u32, u32> s_pending_len;
// vaddr -> code bytes for COMPILED-BUT-UNREGISTERED blocks (see
// park_unregistered). Separate lifetime from s_pending_len on purpose: a park
// must outlive every shard seal, and the seal clears s_pending_len wholesale.
static std::map<u32, u32> s_unreg_len;

// Park a vaddr that flycast considers compiled (compile() sets block->code, so
// compilePC calls bm_AddBlock at driver.cpp:202, which claims FPCA(addr) at
// blockmanager.cpp:290) but that our jit table cannot reach (jit_register
// probe-limit, or the JS install threw). Re-entering the compile path for such
// a pc trips verify(bm_GetCode(addr) == ngen_FailedToFindBlock)
// (blockmanager.cpp:288) -> os_DebugBreak -> the pump dies. The dispatcher
// must span-INTERPRET a parked pc from live RAM instead, forever — until
// reset() clears the parks, which is sound because bm_ResetCache refills the
// WHOLE FPCB with ngen_FailedToFindBlock first (see reset()).
// ---------------------------------------------------------------------------
// A FAILED INSTALL IS A ROOM EVENT (2026-10-15). Which route a block takes
// (compiled vs span-interpreted) must be the same on every console of a room,
// and the two routes charge different guest cycles. A block whose install the
// HOST refuses (the JS module/instance creation throws: memory, table growth)
// is the one route decision that does not follow from guest execution. So:
//  (1) every install is retried (INSTALL_TRIES), which turns a transient
//      refusal into the same compiled route the other consoles took, and
//  (2) a block that still cannot be installed is parked as before AND counted
//      in g_jit_hard_parks, which is a word of the lockstep fingerprint
//      (flycast_worker.js lsWords, ctx_snapshot 144): the room declares the
//      desync at the next fingerprint, naming the cause, instead of drifting
//      silently. The count is zeroed only at the room anchor
//      (flycast_lockstep_reset), so every console starts the room at 0.
// ?jitfailinject=N poisons the Nth block compiled since the last JIT reset:
// every install of it fails (?jitfailonce=1: only its first attempt does).
// ---------------------------------------------------------------------------
static u32 g_jit_hard_parks = 0;
static u32 g_jit_retry_saves = 0;     // installs that succeeded on a retry
static u32 g_jitfail_inject_n = 0, g_jitfail_once = 0;
static u32 s_compiles_since_reset = 0, s_jitfail_vaddr = 0, s_jitfail_left = 0;
static constexpr int INSTALL_TRIES = 3;
static inline bool jitfail_hit(u32 vaddr) {
    if (!s_jitfail_left || vaddr != s_jitfail_vaddr) return false;
    --s_jitfail_left;
    MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[jitfail] injected install failure vaddr=0x' + ($0>>>0).toString(16) +
        ' (left ' + ($1>>>0) + ')'}); }, (int)vaddr, (int)s_jitfail_left);
    return true;
}
static int install_shard_tries(uintptr_t bytes, int len, const u32* vaddrs, int count) {
    bool poisoned = false;
    for (int i = 0; i < count; ++i) if (vaddrs[i] == s_jitfail_vaddr && s_jitfail_left) poisoned = true;
    for (int k = 0; k < INSTALL_TRIES; ++k) {
        // a poisoned member takes the whole module down, like a V8 validation failure
        if (poisoned && jitfail_hit(s_jitfail_vaddr)) continue;
        const int idx = wasm_install_shard(bytes, len, (uintptr_t)vaddrs, count);
        if (idx > 0) { if (k) ++g_jit_retry_saves; return idx; }
    }
    return 0;
}
static int install_block_tries(uintptr_t bytes, int len, u32 vaddr) {
    for (int k = 0; k < INSTALL_TRIES; ++k) {
        if (jitfail_hit(vaddr)) continue;
        const int idx = wasm_install_block(bytes, len, vaddr);
        if (idx > 0) { if (k) ++g_jit_retry_saves; return idx; }
    }
    return 0;
}
static void jit_declare_park(u32 vaddr) {
    ++g_jit_hard_parks;
    static int s_n = 0;
    if (s_n < 8) {
        ++s_n;
        MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[jit-park] ⚠ block 0x' + ($0>>>0).toString(16) +
            ' could not be installed after ' + $1 + ' tries; it runs interpreted on THIS console only. In a room this is a ' +
            'declared desync (fingerprint word jitParks=' + ($2>>>0) + ').'}); }, (int)vaddr, INSTALL_TRIES, (int)g_jit_hard_parks);
    }
}
// The ARM7 backend's install failure is the same class: its fallback (the v0
// span interpreter) does not slice cycles like the compiled block.
extern "C" void flycast_jit_declare_park_arm(uint32_t pc) { jit_declare_park(pc); }
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_jitfail(int n, int once) {
    g_jitfail_inject_n = (u32)n; g_jitfail_once = !!once;
}

extern volatile uint32_t g_rb_mode, g_rb_parks;   // patch 0002, defined below
static inline void park_unregistered(u32 vaddr, u32 code_bytes) {
    s_unreg_len[vaddr] = code_bytes;
    if (g_rb_mode) ++g_rb_parks;   // patch 0002: history-dependent route — must read 0
}

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
// Lever-6 cert (2026-08-27): DEFAULT ON. Certified by the from-load parity
// gate (cross-process hash 91ba21ac/446836 passes, shard == per-block ==
// IC-armed-under-shard), 3x200s full-boot soaks, and the interleaved A/B
// (+27-30% heavy-scene clk) — docs/lever-6-shard/TASKS.md. Escape hatches:
// ?noshard=1 (page) or FLYCAST_SHARD=0 (env).
static bool s_shard_enabled = []{
    const char* e = std::getenv("FLYCAST_SHARD");
    return !(e && e[0] == '0');
}();
// Lever-6D history: the May-era regression was BOOT compile-churn (261K
// jit_register/60s pre-fixes); today's boot compiles ~12K blocks once
// (smcR~=0), the SMC map + epoch verify exist, and the seal fallback stands —
// while the M2 microbench prices the per-block 12K-instance spray at 6-20x
// per hop vs intra-module, with direct in-shard return_call at 0.66ns.
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_shard(int on) {
    s_shard_enabled = !!on;
}
// Rollback-mode batch cap (rbb_compile). <= 1 = per-block install, the control.
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_rb_batch(int n) {
    g_rbb_cap = n < 1 ? 1u : n > 4096 ? 4096u : (u32)n;
}
// Lever-11 v0: frame-wait-spin slice burn toggle (?idleskip=1).
extern "C" { extern volatile uint32_t g_idleskip; }
// ---- LOCKSTEP DETERMINISM: flush the JIT so peers start identical ---------
// Routing (compiled vs span-interpreted) must be a pure function of GUEST
// execution, but the block table and the seal phase are process-lifetime host
// state that no savestate carries. retro_unserialize does NOT reset the cache
// (it only does emu.stop/loadstate/start — libretro.cpp), so a peer that has
// been running holds compiled blocks a fresh peer lacks, and routes the same
// guest code differently. bm_ResetCache() drives our reset() override above,
// which now clears the block shadow AND anchors the seal baseline.
//
// This changes NO cycle accounting, which is the whole point: the reverted
// 5d81938a tried to make the two routes cost the same and paid for it out of
// the interpreter's 8x underclock, which cost Gauntlet its cold boot
// (0.99883x/1889 presents -> 0.21399x/0 presents). Making the ROUTE
// deterministic instead has no guest-rate exposure by construction.
void bm_ResetCache();
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_lockstep_reset(void) {
    bm_ResetCache();
    g_jit_hard_parks = 0;   // the room anchor: every console starts the room at 0
}

extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_idleskip(int on) {
    g_idleskip = !!on;
}
// ROLLBACK DETERMINISM (patch 0001). on=1 suspends the wall-clock frame
// watchdog (see g_deterministic). Netplay (lockstep or rollback) sets it.
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_deterministic(int on) {
    g_deterministic = !!on;
}
// Zero every piece of HOST history that steers guest execution but is not in
// the savestate and is not cleared by bm_ResetCache. Called by every load path
// (emscripten_load_state, emscripten_load_state_rollback). Keep this list in
// sync with dreamcast/docs/rollback/TASKS.md "sources of non-determinism".
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_rb_reset_host_history(void) {
    s_isk_streak = 0;
}

// g_cb_disp_count is defined above at line ~195 inside the extern "C" block;
// we read it (no forward decl needed) to drive the SHARD_DISPATCH_SEAL
// fallback so a low-rate boot phase doesn't leave blocks pending forever.

static void seal_pending_shard() {
    s_pending_interp = 0;
    if (s_pending_shard.empty()) return;

    std::vector<u8> bytes = bemental::sh4::build_blocks(s_pending_shard);

    std::vector<u32> vaddrs;
    vaddrs.reserve(s_pending_shard.size());
    for (auto* b : s_pending_shard) vaddrs.push_back(b->vaddr);

    const int count = (int)s_pending_shard.size();
    const int base_idx = install_shard_tries(
        (uintptr_t)bytes.data(), (int)bytes.size(),
        vaddrs.data(), count);

    // Blocks whose jit_register hits the probe limit are compiled (bm_AddBlock
    // has already claimed FPCA for them) but NOT reachable via jit_lookup, so
    // they go straight into the PERMANENT park map (s_unreg_len) via
    // park_unregistered. They must NOT be parked in s_pending_len: the tail of
    // this function clears that map wholesale, and so does the NEXT seal — a
    // park that a later seal wiped is the same live crash this parking exists
    // to prevent (recompile -> blockmanager.cpp:288 -> os_DebugBreak).

    if (base_idx > 0) {
        s_cur_unit = ++s_unit_serial;   // patch 0002: every member stamps this unit
        for (int i = 0; i < count; ++i) {
            BlockFn fn = reinterpret_cast<BlockFn>(
                static_cast<uintptr_t>(base_idx + i));
            if (!jit_register(s_pending_shard[i]->vaddr, fn,
                              s_pending_shard[i]->sh4_code_size)) {
                // Probe-limit hit. Do NOT drop it: bm_AddBlock already
                // claimed FPCA(vaddr) when this block was first compiled
                // (driver.cpp:202 -> blockmanager.cpp:290), so "retry via the
                // standard miss path" would re-enter compilePC -> bm_AddBlock
                // -> verify(bm_GetCode(addr) == ngen_FailedToFindBlock) fails
                // (blockmanager.cpp:288) -> os_DebugBreak. Park it for
                // span-interp instead (same treatment as a hard install
                // failure below).
                park_unregistered(s_pending_shard[i]->vaddr,
                                  s_pending_shard[i]->sh4_code_size);
                static int s_probe_log = 0;
                if (s_probe_log < 8) {   // 6D: unconditional
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
        // Codegen-quality corpus attribution (strip after the corpus is
        // named): shard function-index -> SH4 vaddr map. The cpuprofile
        // names hot frames wasm-function[N] inside a shard module; block i
        // is function WIMPORT_COUNT+i (9 imports precede the defined
        // functions), so N maps to vaddrs[N-9]. One line per 64 blocks,
        // seal-time only — no steady-state cost.
        for (int i0 = 0; i0 < count; i0 += 64) {
            std::string vs;
            char tmp[12];
            const int end = (i0 + 64 < count) ? i0 + 64 : count;
            for (int i = i0; i < end; ++i) {
                snprintf(tmp, sizeof tmp, "%x", vaddrs[(size_t)i]);
                if (i > i0) vs.push_back(',');
                vs += tmp;
            }
            MAIN_THREAD_EM_ASM({
                postMessage({cmd:'print', txt:
                    '[shardmap] base=' + ($0|0) + ' i0=' + ($1|0) +
                    ' v=' + UTF8ToString($2)});
            }, base_idx, i0, vs.c_str());
        }
    } else {
        // Whole-shard install failed — usually ONE block failing V8
        // validation takes the whole module down (field-found 2026-08-27:
        // a 552-block shard died on "local.set[0] expected f32, found
        // i32.load" and the old handling wedged the guest: pending cleared
        // -> miss path recompiled -> bm_AddBlock verify DEBUGBREAK).
        // Degrade gracefully instead: install every block INDIVIDUALLY
        // (isolates the offender(s)); any block that still fails stays in
        // the span-interp map PERMANENTLY — the miss path must never
        // re-enter compile for it.
        static int s_inst_log = 0;
        if (s_inst_log < 4) {
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
                    ' err="' + errStr + '" — falling back to per-block installs'});
            }, (uintptr_t)err, s_inst_log, count, (int)bytes.size());
        }
        WARN_LOG(DYNAREC, "[rec_wasm-shard] install_shard FAILED count=%d bytes=%zu",
                 count, bytes.size());

        int singles = 0, hard_failed = 0;
        for (auto* blk : s_pending_shard) {
            std::vector<u8> one = bemental::sh4::build_block(blk);
            const int idx1 = install_block_tries(
                (uintptr_t)one.data(), (int)one.size(), blk->vaddr);
            if (idx1 > 0) {
                BlockFn fn = reinterpret_cast<BlockFn>(
                    static_cast<uintptr_t>(idx1));
                if (jit_register(blk->vaddr, fn, blk->sh4_code_size))
                    ++singles;
                else
                    // Installed but unreachable (probe limit). FPCA(vaddr) is
                    // already claimed, so this must span-interp too — a bare
                    // `continue` here left it to be recompiled straight into
                    // blockmanager.cpp:288's DEBUGBREAK.
                    park_unregistered(blk->vaddr, blk->sh4_code_size);
                continue;
            }
            ++hard_failed;
            park_unregistered(blk->vaddr, blk->sh4_code_size);
            jit_declare_park(blk->vaddr);
            static int s_bad_log = 0;
            if (s_bad_log < 8) {
                ++s_bad_log;
                char err[256] = {0};
                wasm_dispatcher_get_last_error(err, sizeof(err));
                MAIN_THREAD_EM_ASM({
                    var p = $1 >>> 0;
                    var s = '';
                    while (HEAPU8[p] !== 0 && s.length < 256) { s += String.fromCharCode(HEAPU8[p]); p++; }
                    postMessage({cmd:'print', txt:'[rec_wasm-shard] BAD BLOCK vaddr=0x' +
                        ($0>>>0).toString(16) + ' err="' + s + '"'});
                }, (int)blk->vaddr, (uintptr_t)err);
            }
            // One-shot forensic dump of the first offender's module bytes
            // (base64, chunked) — decode from the probe log and feed to
            // wasm-objdump to see the exact bad sequence.
            static bool s_dumped = false;
            if (!s_dumped) {
                s_dumped = true;
                MAIN_THREAD_EM_ASM({
                    var p = $0 >>> 0;
                    var n = $1 | 0;
                    var va = $2 >>> 0;
                    var bin = '';
                    for (var i = 0; i < n; i++) bin += String.fromCharCode(HEAPU8[p + i]);
                    var b64 = btoa(bin);
                    postMessage({cmd:'print', txt:'[wasm-dump] vaddr=0x' + va.toString(16) + ' len=' + n});
                    for (var o = 0; o < b64.length; o += 512)
                        postMessage({cmd:'print', txt:'[wasm-dump] ' + b64.substr(o, 512)});
                    postMessage({cmd:'print', txt:'[wasm-dump] END'});
                }, (uintptr_t)one.data(), (int)one.size(), (int)blk->vaddr);
            }
        }
        MAIN_THREAD_EM_ASM({
            postMessage({cmd:'print', txt:'[rec_wasm-shard] per-block fallback: installed=' +
                ($0|0) + ' hard-failed=' + ($1|0) + ' (hard failures span-interp permanently)'});
        }, singles, hard_failed);

        // Only the CURRENT shard's bookkeeping is cleared; the parks live in
        // s_unreg_len and survive this (and every later) seal.
        s_cur_unit = 0;   // patch 0002: later per-block installs are their own unit
        s_pending_shard.clear();
        s_pending_vaddrs.clear();
        s_pending_len.clear();
        s_dispatches_at_last_seal = s_dispatch_count;
        return;
    }

    // Only the CURRENT shard's bookkeeping is cleared; the probe-limit parks
    // live in s_unreg_len and survive this (and every later) seal.
    s_cur_unit = 0;   // patch 0002: later per-block installs are their own unit
    s_pending_shard.clear();
    s_pending_vaddrs.clear();
    s_pending_len.clear();
    s_dispatches_at_last_seal = s_dispatch_count;
}

// Shard parity gate (lever-6 cert): a parity arm must hash with ZERO pending
// blocks — a compiled-but-pending block span-interprets, and interp slicing
// is not guaranteed pass-identical to the sealed block's. Called at every
// parity arm entry; a no-pending call is a cheap early return.
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_shard_seal_now(void) {
    if (s_shard_enabled) seal_pending_shard();
}

// ===========================================================================
// ROLLBACK KEEP-CODE LOAD (patch 0002) — dreamcast/docs/rollback/TASKS.md
// ===========================================================================
// emscripten_load_state flushes EVERY compiled block (bm_ResetCache ->
// WasmDynarec::reset -> jit_clear), and the frames after a load recompile:
// measured 47.9 ms load + 691 ms for the next 8 frames, a 1,487 ms p50
// rollback step against a 33.3 ms frame. A rollback restores a state a few
// frames old in the SAME scene; its code pages are almost never different
// from what is resident. So: snapshot the resident code pages before the
// load, compare after it, and drop only the install units whose code bytes
// actually changed.
//
// ROUTING MUST STAY A PURE FUNCTION OF GUEST STATE, or keeping code trades a
// cost problem for a determinism one. Two route splits exist today and both
// charge different guest cycles:
//   (a) a compiled-but-PENDING shard block span-interprets until its shard
//       seals — whether a block is pending depends on compile history;
//   (b) an SMC-stale block INTERPRETS (jit_lookup -> g_lookup_stale), while
//       a peer that never compiled the old bytes COMPILES the new ones.
// Rollback mode closes both: it runs with per-block synchronous install
// (shard off: a block is live from its first execution, so (a) cannot occur)
// and turns a stale hit into discard + recompile (so (b) routes compiled on
// every peer). What remains history-dependent is a probe-limit PARK (table
// occupancy), which is counted in g_rb_parks and must read 0 in the rig.
volatile uint32_t g_rb_mode = 0;
volatile uint32_t g_rb_parks = 0;          // parks seen while in rollback mode
volatile uint32_t g_rb_last_discards = 0;  // blocks dropped by the last keep-code load
volatile uint32_t g_rb_last_changed_pages = 0;
volatile uint32_t g_rb_full_flushes = 0;   // keep-code loads that had to fall back

void bm_DiscardBlock(RuntimeBlockInfo* block);   // blockmanager.cpp:310
static constexpr u32 RB_PAGE_SHIFT = 12;                    // 4 KB
static constexpr u32 RB_PAGES = 0x01000000u >> RB_PAGE_SHIFT; // 16 MB main RAM
static uint8_t  s_rb_code_page[RB_PAGES];   // page holds registered code
static uint8_t  s_rb_changed[RB_PAGES];
static uint8_t* s_rb_shadow = nullptr;      // 16 MB, code pages only are filled

static inline void rb_mark_span(u32 vaddr, u32 len, uint8_t* map) {
    if (!vaddr_in_ram(vaddr) || len == 0) return;
    const u32 lo = (vaddr & 0x00FFFFFFu) >> RB_PAGE_SHIFT;
    u32 hi = ((vaddr & 0x00FFFFFFu) + len - 1) >> RB_PAGE_SHIFT;
    if (hi >= RB_PAGES) hi = RB_PAGES - 1;
    for (u32 p = lo; p <= hi; p++) map[p] = 1;
}
static inline bool rb_span_hits(u32 vaddr, u32 len, const uint8_t* map) {
    if (!vaddr_in_ram(vaddr) || len == 0) return false;
    const u32 lo = (vaddr & 0x00FFFFFFu) >> RB_PAGE_SHIFT;
    u32 hi = ((vaddr & 0x00FFFFFFu) + len - 1) >> RB_PAGE_SHIFT;
    if (hi >= RB_PAGES) hi = RB_PAGES - 1;
    for (u32 p = lo; p <= hi; p++) if (map[p]) return true;
    return false;
}

// Drop one slot from BOTH tables. flycast's FPCA entry goes back to
// ngen_FailedToFindBlock (bm_DiscardBlock), so the next miss passes
// bm_AddBlock's verify; our slot keeps its pc (the probe chain stays intact —
// jit_lookup stops at pc==0, so a hole would orphan every later colliding
// vaddr) but answers MISS: fn = nullptr with len = 0 skips the sum and is
// returned as a plain miss, and the recompile's jit_register overwrites this
// very slot (pc == vaddr branch).
static void rb_discard_slot(u32 slot) {
    const u32 v = s_block_pc[slot];
    if (v == 0 || s_block_fn[slot] == nullptr) return;
    // NOT bm_GetBlock(): that resolves through blkmap.upper_bound +
    // containsCode(), and this backend registers every block with
    // host_code_size = 0, so containsCode is false for all of them. Instead use
    // the fact compile() relies on: block->code IS the RuntimeBlockInfo*
    // ("Use the block's own heap address (`blk` itself) as the unique fake code
    // pointer", WasmDynarec::compile) — so the FPCA entry for v names the block.
    DynarecCodeEntryPtr c = bm_GetCodeByVAddr(v);   // mmu off (checked by caller)
    if (c != (DynarecCodeEntryPtr)ngen_FailedToFindBlock)
        bm_DiscardBlock((RuntimeBlockInfo*)(void*)c);
    s_block_fn[slot] = nullptr;
    s_block_len[slot] = 0;
    s_block_sum[slot] = 0;
    s_block_stale[slot] = 0;
    s_block_vgen[slot] = 0;
    s_block_unit[slot] = 0;
    s_block_fcfg[slot] = 0;
}

// Drop every slot in `slot`'s install unit (or just `slot` for unit 0).
static u32 rb_discard_unit_of(u32 slot) {
    const u32 unit = s_block_unit[slot];
    if (unit == 0) { rb_discard_slot(slot); return 1; }
    u32 n = 0;
    for (u32 i = 0; i < JIT_TABLE_SIZE; i++)
        if (s_block_unit[i] == unit) { rb_discard_slot(i); n++; }
    return n;
}

// Enter/leave rollback mode. Entering FLUSHES once, so every peer starts the
// mode from the same (empty) table and the same install model.
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_rollback_mode(int on) {
    if (on) {
        if (s_shard_enabled) seal_pending_shard();
        s_shard_enabled = false;
        g_rb_mode = 1;
        g_rb_parks = 0;
        bm_ResetCache();          // -> WasmDynarec::reset(): jit_clear + streak
    } else {
        g_rb_mode = 0;
    }
}

// STEP 1 of a keep-code load (BEFORE retro_unserialize): record which RAM
// pages hold resident code and copy exactly those pages aside.
extern "C" EMSCRIPTEN_KEEPALIVE u32 flycast_rb_snapshot_code_pages(void) {
    if (!s_rb_shadow) {
        s_rb_shadow = (uint8_t*)malloc(0x01000000u);
        if (!s_rb_shadow) return 0xFFFFFFFFu;
    }
    if (s_shard_enabled) seal_pending_shard();   // nothing may stay pending
    memset(s_rb_code_page, 0, sizeof(s_rb_code_page));
    for (u32 slot = 0; slot < JIT_TABLE_SIZE; slot++)
        if (s_block_pc[slot] != 0 && s_block_fn[slot] != nullptr)
            rb_mark_span(s_block_pc[slot], s_block_len[slot] ? s_block_len[slot] : 2, s_rb_code_page);
    for (const auto& kv : s_unreg_len) rb_mark_span(kv.first, kv.second, s_rb_code_page);
    u32 n = 0;
    for (u32 p = 0; p < RB_PAGES; p++)
        if (s_rb_code_page[p]) {
            memcpy(s_rb_shadow + (p << RB_PAGE_SHIFT), &mem_b[p << RB_PAGE_SHIFT], 1u << RB_PAGE_SHIFT);
            n++;
        }
    return n;
}

// STEP 2 (AFTER retro_unserialize): compare, then drop every install unit
// with a block on a changed page. Returns the number of blocks dropped, or
// 0xFFFFFFFF when the caller must fall back to the full flush (MMU on, a park
// or pending span on a changed page, or no shadow).
extern "C" EMSCRIPTEN_KEEPALIVE u32 flycast_rb_invalidate_changed(void) {
    g_rb_last_discards = 0;
    g_rb_last_changed_pages = 0;
    if (!s_rb_shadow || mmu_enabled()) { ++g_rb_full_flushes; return 0xFFFFFFFFu; }
    memset(s_rb_changed, 0, sizeof(s_rb_changed));
    u32 changed = 0;
    for (u32 p = 0; p < RB_PAGES; p++)
        if (s_rb_code_page[p] &&
            memcmp(s_rb_shadow + (p << RB_PAGE_SHIFT), &mem_b[p << RB_PAGE_SHIFT], 1u << RB_PAGE_SHIFT) != 0) {
            s_rb_changed[p] = 1;
            changed++;
        }
    g_rb_last_changed_pages = changed;
    if (changed == 0) return 0;
    for (const auto& kv : s_unreg_len)
        if (rb_span_hits(kv.first, kv.second, s_rb_changed)) { ++g_rb_full_flushes; return 0xFFFFFFFFu; }
    for (const auto& kv : s_pending_len)
        if (rb_span_hits(kv.first, kv.second, s_rb_changed)) { ++g_rb_full_flushes; return 0xFFFFFFFFu; }
    u32 dropped = 0;
    for (u32 slot = 0; slot < JIT_TABLE_SIZE; slot++)
        if (s_block_pc[slot] != 0 && s_block_fn[slot] != nullptr &&
            rb_span_hits(s_block_pc[slot], s_block_len[slot] ? s_block_len[slot] : 2, s_rb_changed))
            dropped += rb_discard_unit_of(slot);
    // Every IC entry and LEVER-12 trace-edge stamp may name a dropped index.
    if (g_ic_generation) { ++g_ic_generation; ++g_smc_gen_accounted; ++g_smc_mark_counts[4]; }
    g_rb_last_discards = dropped;
    return dropped;
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
// OOB-location probe (2026-05-21): read the live SH4 pc from JS. On a wasm
// memory-OOB trap the shim catch reads this to learn the trapping block's
// entry pc — ctx->pc holds the current block's entry until the trampoline
// writes next_pc after fn() returns, so a mid-block trap leaves it pointing
// at the faulting block.
EMSCRIPTEN_KEEPALIVE uint32_t flycast_get_sh4_pc(void) { return Sh4cntx.pc; }

// RELEASE-safe on-demand context snapshot (no per-dispatch cost). Lets the page
// read the live SH4/scheduler/interrupt state at a stall WITHOUT a DEBUG_DISPATCH
// build (whose per-1000 EM_ASM proxy is ~1400x slower and never reaches the
// RELEASE stall point). `which` selects one field; the worker 'ctxsnap' command
// reads 0..N and prints them. Strip after the boot-title-wedge verdict.
// Interrupt-delivery + scheduler-advance rate counters (boot-title-wedge).
// The intro state machine advances on a VBLANK-ISR-driven frame count; if
// interrupts are not vectored to the SH4 at ~frame cadence, the intro never
// advances. g_dbg_vec_count = interrupts actually vectored (UpdateINTC hit);
// g_dbg_sched_ticks = sh4_sched_tick calls (each drives spg_line_sched, the
// SPG VBlank raise). Read via flycast_ctx_snapshot 12/13; watch the per-second
// rate. Strip after verdict.
// Recent block-entry PC ring (moved above ctx_snapshot so cases 60-67 can read it).
static u32 g_pc_ring[128];
static u32 g_pc_ring_idx = 0;
uint64_t g_dbg_vec_count = 0;
uint64_t g_dbg_sched_ticks = 0;
// DIAG (render frontier): reliable per-credit-loop snapshot — SR/pend/istnrm/pc
// are COMMITTED to ctx at this point (unlike the async ctxsnap which is stale
// mid-self-loop). g_dbg_credit_runs climbing => the loop yields to the trampoline.
uint32_t g_dbg_credit_runs = 0, g_dbg_sr_credit = 0, g_dbg_pend_credit = 0,
         g_dbg_istnrm_credit = 0, g_dbg_pc_credit = 0;
int32_t  g_dbg_schednext_credit = 0; uint32_t g_dbg_schedtick_calls = 0;
// ORDER 21b maple-storm v2: last vectored INTEVT code. DEFINED in maple_if.cpp
// (shared tree, so both the native oracle build and this wasm build resolve it);
// set in sh4_interrupts.cpp Do_Interrupt. Extern-referenced here for ctx case 38
// (matches the C++-linkage extern in sh4_interrupts.cpp / def in maple_if.cpp).
extern uint32_t g_dbg_last_intevt;
// Lever-1 baseline (ORDER 21b): every wasm_block_trampoline() dispatch that
// actually calls a compiled block from C == one dispatcher round-trip. The
// share tail-linking can remove is the dynamic-exit subset. Read via
// flycast_ctx_snapshot(14); watch per-second rate. Strip after verdict.
uint64_t g_dbg_roundtrips = 0;

// ORDER 21b: exit-to-C round-trip class counters live in the JIT emitter TU
// (bementalJIT/guests/sh4/wasm_emit.cpp) so its emitted blocks can bake their
// linear-memory addresses as i32.const store targets. extern "C" there and
// here so the symbol matches without namespace mangling across TUs. Strip with
// them after the prediction verdict.
extern "C" {
    extern uint32_t g_exit_dyn, g_exit_static_xshd, g_exit_cond_xshd;
    extern uint32_t g_ic_next;   // lever-5E: IC site allocator high-water (emitter TU)
}

EMSCRIPTEN_KEEPALIVE uint32_t flycast_ctx_snapshot(uint32_t which) {
    switch (which) {
        case 0:  return Sh4cntx.pc;
        case 1:  return Sh4cntx.sr.getFull();
        case 2:  return Sh4cntx.interrupt_pend;
        case 3:  return (uint32_t)Sh4cntx.cycle_counter;
        case 4:  return (uint32_t)Sh4cntx.sh4_sched_next;
        case 5:  return (uint32_t)Sh4cntx.CpuRunning;
        case 6:  return Sh4cntx.vbr;
        case 7:  return SB_ISTNRM;
        case 8:  return SB_IML6NRM;
        case 9:  return Sh4cntx.spc;
        case 10: return Sh4cntx.ssr;
        case 11: return Sh4cntx.pr;
        case 12: return (uint32_t)g_dbg_vec_count;
        case 13: return (uint32_t)g_dbg_sched_ticks;
        case 14: return (uint32_t)g_dbg_roundtrips;  // Lever-1 baseline: dispatcher round-trips
        // ORDER 21b: execution-weighted exit-to-C round-trip class split. Emitter
        // (wasm_emit.cpp, namespace bemental::sh4) bumps these from the
        // non-tail-linked block exit paths.
        case 15: return g_exit_dyn;         // Lever 1
        case 16: return g_exit_static_xshd; // Lever 2
        case 17: return g_exit_cond_xshd;   // Lever 1/2
        case 110: return s_block_count;          // fresh block registrations
        case 111: return g_compile_calls;        // WasmDynarec::compile() calls
        case 112: return g_rb_stale_recompiles;  // rollback-mode stale -> recompile
        case 18: return (uint32_t)g_chain_hits;
        case 19: return (uint32_t)g_chain_misses;
        // ORDER 21b maple-storm diag (maple_if.cpp). 36/37 to clear the r[] range.
        case 36: { extern uint32_t g_dbg_maple_cyc;  return g_dbg_maple_cyc; }
        case 37: { extern uint32_t g_dbg_maple_last; return g_dbg_maple_last; }
        case 38: return g_dbg_last_intevt;  // last vectored INTEVT code
        case 39: { extern uint32_t g_dbg_istnrm_wr;    return g_dbg_istnrm_wr; }
        case 40: { extern uint32_t g_dbg_istnrm_wdata; return g_dbg_istnrm_wdata; }
        // ORDER 21b maple-storm v3 — DISPATCH DISCRIMINATORS (guest RAM reads).
        // Native (researcher B): handler table @0x8c00f600; Maple slot 0x62c=0x8c378d46,
        // VBlank slot 0x624=0x8c3c2b90; Maple callback-list head @0x8c578170.
        case 41: { try { return ReadMem32(0x8c00f62cu); } catch (...) { return 0xBADA5510u; } }  // Maple handler slot
        case 42: { try { return ReadMem32(0x8c00f624u); } catch (...) { return 0xBADA5510u; } }  // VBlank handler slot
        case 43: { try { return ReadMem32(0x8c578170u); } catch (...) { return 0xBADA5510u; } }  // Maple cb-list head
        case 44: { try { return ReadMem32(0xFF000028u); } catch (...) { return 0xBADA5510u; } }  // guest-side CCN_INTEVT read
        // v4 — the spurious-IRQ discriminator (researcher B: node 0x8c37b9c8 checks
        // "DMA-armed" flag @0x8c578988; if 0 -> counts spurious, never reaches ack).
        case 45: { try { return ReadMem32(0x8c578988u); } catch (...) { return 0xBADA5510u; } }  // Maple DMA-armed sw flag
        case 46: { try { return ReadMem32(0xa05f6c10u); } catch (...) { return 0xBADA5510u; } }  // SB_MDTSEL (native=0)
        case 47: { try { return ReadMem32(0xa05f6900u); } catch (...) { return 0xBADA5510u; } }  // guest-read SB_ISTNRM
        case 48: { try { return ReadMem32(0xa05f6920u); } catch (...) { return 0xBADA5510u; } }  // guest-read SB_IML4NRM
        case 49: { extern uint32_t g_dbg_maple_dodma; return g_dbg_maple_dodma; }  // DMA starts
        case 50: { extern uint32_t g_dbg_maple_schd;  return g_dbg_maple_schd; }   // completions (maple_schd fires)
        case 51: { extern uint32_t g_dbg_schd_armed0; return g_dbg_schd_armed0; }  // completions w/ armed==0 (spurious)
        case 52: { extern uint32_t g_dbg_schd_armed1; return g_dbg_schd_armed1; }  // completions w/ armed!=0 (valid)
        // v5 — is node2 (the acker) linked, and is node1 running? (researcher 3)
        case 53: { try { return ReadMem32(0x8c576f54u); } catch (...) { return 0xBADA5510u; } }  // node1.next (expect 0x8c576f60)
        case 54: { try { return ReadMem32(0x8c576f60u); } catch (...) { return 0xBADA5510u; } }  // node2.fn  (expect 0x8c37baa2)
        case 55: { try { return ReadMem32(0x8c5786e4u); } catch (...) { return 0xBADA5510u; } }  // node1 processed counter
        case 56: { try { return ReadMem32(0x8c57898cu); } catch (...) { return 0xBADA5510u; } }  // node1 skip counter
        case 57: { try { return ReadMem32(0x8c379b7cu); } catch (...) { return 0xBADA5510u; } }  // dispatcher latched INTEVT
        case 58: { extern uint32_t g_dbg_int320; return g_dbg_int320; }  // 0x320 (VBlank) deliveries
        case 59: { extern uint32_t g_dbg_int360; return g_dbg_int360; }  // 0x360 (Maple) deliveries
        // v7 — reliable committed crediting-loop snapshot (render frontier).
        case 68: return g_dbg_credit_runs;    // crediting-loop iterations (climbs => yielding)
        case 69: return g_dbg_sr_credit;      // committed SR at delivery gate (IMASK bits 4-7)
        case 70: return g_dbg_pend_credit;    // interrupt_pend after SRdecode
        case 71: return g_dbg_istnrm_credit;  // SB_ISTNRM at delivery
        case 72: return g_dbg_pc_credit;      // committed guest PC at crediting loop
        case 73: return (uint32_t)g_dbg_schednext_credit;  // committed sh4_sched_next
        // Lever-4 / Build 2 [smc] telemetry (docs/lever-4-smc-bitmap task 1).
        case 74: return g_ic_generation;          // monotonic while armed; delta/s = total bump rate
        case 75: return g_smc_mark_counts[0];     // C slowpath single-store marks
        case 76: return g_smc_mark_counts[1];     // WriteMemBlock/DMA chokepoint marks
        case 77: return g_smc_mark_counts[2];     // jit_register slot-churn bumps
        case 78: { u32 n = 0; for (u32 c = 0; c < SMC_CHUNKS; c++) n += g_code_map[c]; return n; }  // marked 16B code chunks
        case 79: return g_smc_mark_counts[3];     // jit_lookup clean->stale transitions (F1 dedupe)
        case 80: return g_smc_last_addr;          // DIAG: last phys addr whose chunk was marked (emitted reg-EA path)
        // [2026-08-29] LEDGER CLOSURE (see the g_smc_mark_counts note). Cases
        // 75/76/77/79 alone could never support "no SMC occurred" -- icgen moved
        // while all four read 0. These are the remaining paths.
        case 103: return g_smc_mark_counts[4];    // flycast_ic_invalidate (savestate load) -- administrative
        case 104: return g_smc_mark_counts[5];    // jit_clear (cache flush)               -- administrative
        case 105: return g_smc_mark_counts[6];    // block-manager reset                   -- administrative
        case 106: return g_smc_mark_counts[7];    // g_ic_flush_mask periodic (inert at default 0)
        case 107: return g_smc_gen_accounted;     // generation units added by ALL C paths since the last arm
        // DERIVED: generation units contributed by the EMITTED in-wasm store
        // mark (wasm_emit.cpp emitSmcMarkLocal/emitSmcMarkConstPage), which is
        // branchless on the hot guest-store path and deliberately uncounted
        // there. Units, not events -- an 8-byte fmov.d pair can add 2 -- so it
        // is an UPPER bound on emitted-mark events, the safe direction. Reads 0
        // while disarmed (nothing can move the generation off 0).
        case 108: return g_ic_generation ? (g_ic_generation - 1u - g_smc_gen_accounted) : 0u;
        case 81: return g_syncsr_count;           // lever-5B sizing: shop_sync_sr C-fallback fires
        case 89: return g_syncfpscr_count;        // lever-10 sizing: shop_sync_fpscr C-fallback fires
        case 90: return g_idleskip_burns;         // lever-11 v0: frame-wait-spin slice burns
        case 143: return g_jit_retry_saves;       // installs saved by a retry
        case 146: return g_div32_count;           // div32 C-fallback fires
        case 144: return g_jit_hard_parks;        // installs that failed every retry (fingerprint word)
        case 140: return g_gwff_runs;             // Gauntlet wait-loop fast-forwards
        case 141: return g_gwff_passes;           // passes they applied
        case 142: return g_gwff_fallbacks;        // head arrivals run for real
        case 147: return g_pswff_runs;            // PSO wait-loop fast-forwards
        case 148: return g_pswff_passes;          // passes they applied (wraps)
        case 149: return g_pswff_fallbacks;       // head arrivals run for real
        case 150: return g_pswff_chk_ok;          // ?pswff=2 DIAG: predictions that matched
        case 151: return g_pswff_chk_bad;         // ?pswff=2 DIAG: predictions that did not
        case 152: return g_rbb_batches;           // rollback-mode batches installed
        case 153: return g_rbb_members;           // members installed ahead of execution
        case 154: return g_rbb_fcfg_redo;         // members recompiled at first entry (FPU config)
        case 155: return g_rbb_dropped;           // members dropped at register (probe limit)
        case 156: return g_rb_parks;              // parks while in rollback mode (must stay 0)
        case 157: return g_rbb_alias_drops;       // P1/P2 alias entries dropped before a compile
        case 82: return (u32)g_attr_mainloop_ms;  // lever-5 attribution: SH4 mainloop wall (ms total)
        case 83: return (u32)g_attr_retro_ms;     // lever-5 attribution: whole retro_run wall (ms total)
        // lever-12 mainloop split (cumulative; the heartbeat carries the
        // per-window form). ms totals are truncated to u32 by the ctxsnap ABI.
        case 91: return (u32)g_attr_sched_ms;     // all sh4_sched callbacks (ms total)
        case 92: return g_attr_sched_n;           // sh4_sched_tick() calls
        case 93: return (u32)g_attr_schedfat_ms;  // subset: ticks >= 50us (ms total)
        case 94: return g_attr_schedfat_n;        // subset: ticks >= 50us (count)
        case 95: return (u32)g_attr_render_ms;    // STARTRENDER store = TA parse + draw + present (ms total)
        case 96: return g_attr_render_n;          // STARTRENDER stores
        case 97: return (u32)g_attr_pvrreg_ms;    // other Holly/PVR reg stores (ms total)
        case 98: return g_attr_pvrreg_n;          // other Holly/PVR reg stores (count)
        case 99: return (u32)g_attr_sq_ms;        // store-queue bursts, SAMPLED wall (ms of sampled subset)
        case 100: return g_attr_sq_n;             // store-queue bursts (exact count)
        case 101: return g_attr_sq_smp;           // store-queue bursts actually timed (sample count)
        case 102: return g_attr_sq_ta_n;          // store-queue bursts routed to the TA FIFO
        case 84: return g_ifb_ftrv;               // lever-5D: ftrv IFB fires
        case 88: return g_ic_next;                // lever-5E: IC site allocator high-water (cap 65536)
        case 85: return g_ifb_fipr;               // lever-5D: fipr IFB fires
        case 86: return g_ifb_fsca;               // lever-5D: fsca IFB fires
        case 87: return g_ifb_other;              // lever-5D: other IFB fires
        // v6 — last 8 block-entry PCs (newest first) = the live ISR loop path.
        case 60: return g_pc_ring[(g_pc_ring_idx - 1) & 127];
        case 61: return g_pc_ring[(g_pc_ring_idx - 2) & 127];
        case 62: return g_pc_ring[(g_pc_ring_idx - 3) & 127];
        case 63: return g_pc_ring[(g_pc_ring_idx - 4) & 127];
        case 64: return g_pc_ring[(g_pc_ring_idx - 5) & 127];
        case 65: return g_pc_ring[(g_pc_ring_idx - 6) & 127];
        case 66: return g_pc_ring[(g_pc_ring_idx - 7) & 127];
        case 67: return g_pc_ring[(g_pc_ring_idx - 8) & 127];
        // 20..35 = general regs r[0..15] (loop counters, memcpy args, etc.)
        default:
            if (which >= 20u && which < 36u) return Sh4cntx.r[which - 20u];
            return 0xDEADBEEFu;
    }
}

// Interpreter-only mode. When set, wasm_block_trampoline bypasses the JIT path
// entirely and routes every dispatch through Sh4Interpreter::Step() (one SH4
// op per call). Empirical anchor: nasomers/flycast-wasm (NO_REC=1) ships at
// 20–40 FPS on PSO with this exact path. Toggleable from JS via
// _flycast_set_interp_only(0|1). Default OFF.
volatile bool g_interp_only = false;
std::atomic<uint64_t> g_interp_step_count{0};
EMSCRIPTEN_KEEPALIVE void flycast_set_interp_only(int on) { g_interp_only = !!on; }
EMSCRIPTEN_KEEPALIVE uint64_t flycast_interp_step_count(void) { return g_interp_step_count.load(); }

// _flycast_set_mem_fastpaths(0|1). Default ON. OFF = every emitted memory
// access goes through the sh4_mem_* imports (flycast canonical paths) — the
// JIT-arm memory-corruption differential. Must be set before blocks compile.
extern void bemental_sh4_set_mem_fastpaths(int on);  // wasm_emit.cpp C-linkage bridge
EMSCRIPTEN_KEEPALIVE void flycast_set_mem_fastpaths(int on) { bemental_sh4_set_mem_fastpaths(on); }
extern void bemental_sh4_set_regcache(int on);
EMSCRIPTEN_KEEPALIVE void flycast_set_regcache(int on) { bemental_sh4_set_regcache(on); }
extern void bemental_sh4_set_imm_fastpath(int on);
EMSCRIPTEN_KEEPALIVE void flycast_set_imm_fastpath(int on) { bemental_sh4_set_imm_fastpath(on); }
// _flycast_set_sq_fp(0|1): the emitted store-queue store arm (wasm_emit.cpp). Default ON; set before blocks compile.
extern void bemental_sh4_set_sq_fp(int on);
EMSCRIPTEN_KEEPALIVE void flycast_set_sq_fp(int on) { bemental_sh4_set_sq_fp(on); }
// _flycast_set_self_loop(0|1). DEFAULT OFF (ORDER 21b): the in-block self-loop
// codegen mis-compiles the 0x8c12bc6e memset (correct data, wrong exit state —
// pins the main thread at the rts, storm never collapses). Self-branches now
// self-chain via the Lever-1 global probe (correct). ON = the old buggy path,
// for A/B. Must be set before blocks compile.
extern void bemental_sh4_set_self_loop(int on);
EMSCRIPTEN_KEEPALIVE void flycast_set_self_loop(int on) { bemental_sh4_set_self_loop(on); }
// _flycast_set_rte_intc(0|1). DEFAULT OFF (ORDER 21b storm fix): RTE defers IRQ
// delivery to the slice-boundary crediting loop so the RTE target runs before the
// storm re-vectors. ON = legacy immediate per-block delivery (the livelock).
extern void bemental_sh4_set_rte_intc(int on);
EMSCRIPTEN_KEEPALIVE void flycast_set_rte_intc(int on) { bemental_sh4_set_rte_intc(on); }

// PC-range interpreter fallback (boot-title-wedge / ship path): blocks whose
// entry PC is in [lo, hi) run through the interpreter instead of the JIT.
// Two uses: (1) interpret the cold one-time DP-launcher loader (which the
// JIT mis-emits in the ran3 seed hash) while the JIT runs the hot game code —
// correct boot at negligible cost since the loader runs once; (2) bisect the
// ran3 defect to a single block by narrowing the range until boot flips.
// Boot-title-wedge stopgap (PSO): the DP-launcher loader [0x8c004000,0x8c010000)
// contains a ran3 %55 divide block ([0x8c004320,0x8c004340), bisected update 15)
// with a subtle JIT bug (all its arithmetic ops verify correct in isolation;
// remaining suspect is the area-3 stack push/pop fastpath) that corrupts BOTH
// decrypt stages -> garbage entry -> wild-jump. Route the loader through the
// interpreter so the decrypt is CORRECT (verified ent=8c34d788, boot advances
// past the wild-jump). The loader runs once at boot; the game code (0x8c010000+)
// still JITs at full speed. STRIP once the emitter bug is root-caused.
volatile uint32_t g_interp_lo = 0;
volatile uint32_t g_interp_hi = 0;
EMSCRIPTEN_KEEPALIVE void flycast_set_interp_range(uint32_t lo, uint32_t hi) {
    g_interp_lo = lo; g_interp_hi = hi;
}

// Dense PC-trace prefix. When non-zero, the PC sampler dumps every dispatch
// (instead of the default every-1000 stride) for the first N dispatches. Used
// to find the first JIT-vs-interp divergence point. Cost is ~100-400 µs/dump
// (proxied postMessage); a value of 5000 adds ~1s probe overhead.
volatile uint32_t g_pc_trace_until = 0;
EMSCRIPTEN_KEEPALIVE void flycast_set_pc_trace_until(uint32_t n) { g_pc_trace_until = n; }

// ---------------------------------------------------------------------------
// Per-phase cost-breakdown counters. Populated by the mainloop + trampoline
// when DEBUG_DISPATCH is on, dumped every 100K dispatches. Goal: split the
// --- Escape forensics v2 (boot-title-wedge task 1) -------------------------
// Always-on 128-deep next_pc ring (1 store/dispatch) + ring of the last 8
// vector events (spc + interrupt-status/mask registers + pc-ring position).
// Flushed once at the first illegal-pc escape: shows the FATAL interrupt's
// full dispatcher trajectory and which ISTNRM/ISTEXT bits it carried vs the
// healthy first vector (banked in docs/boot-title-wedge). Diagnostic —
// strip after verdict.
struct VecEv { u32 spc, istnrm, istext, iml2, iml4, iml6, ring_pos; };
static VecEv g_vec_ring[8];
static u32 g_vec_ring_idx = 0;
static void isr_trace_flush(Sh4Context* ctx) {
    static bool s_flushed = false;
    if (s_flushed) return;
    s_flushed = true;
    char buf[512];
    for (int base = 0; base < 128; base += 16) {
        int off = snprintf(buf, sizeof(buf), "[pc-ring %d+]", base);
        for (int i = base; i < base + 16 && off < (int)sizeof(buf) - 10; i++)
            off += snprintf(buf + off, sizeof(buf) - off, " %08x",
                            g_pc_ring[(g_pc_ring_idx + i) & 127]);   // oldest→newest
        MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
    }
    for (u32 i = 0; i < 8; i++) {
        const VecEv& v = g_vec_ring[(g_vec_ring_idx + i) & 7];       // oldest→newest
        int off = snprintf(buf, sizeof(buf),
            "[vec-ring %u] spc=%08x istnrm=%08x istext=%08x iml2=%08x iml4=%08x iml6=%08x ring_pos=%u",
            i, v.spc, v.istnrm, v.istext, v.iml2, v.iml4, v.iml6, v.ring_pos);
        (void)off;
        MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
    }
    MAIN_THREAD_EM_ASM({
        postMessage({cmd:'print', txt:'[vec-ring now] idx=' + ($0>>>0) +
            ' spc=0x' + ($1>>>0).toString(16) + ' vbr=0x' + ($2>>>0).toString(16)});
    }, g_pc_ring_idx, (int)ctx->spc, (int)ctx->vbr);
}
// C-linkage flush for the bridge's stuck-pc dump (EmscriptenWorker.cpp):
// dumps the always-on pc ring + vector-event ring once.
extern "C" void rec_wasm_flush_rings(void) { isr_trace_flush(&Sh4cntx); }
// ---------------------------------------------------------------------------

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

// Lever-9D: OC-RAM fastpath accessors (patched into sh4_mmr.cpp; C linkage).
extern "C" {
uintptr_t sh4_ocram_base();
uintptr_t sh4_ccr_addr();
}

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

// Interpret exactly one guest instruction from live RAM. Used for SMC-stale
// blocks (recompiling would crash flycast's bm_AddBlock verify — see
// jit_lookup). Instance is cached once; Step() re-sets it around itself.
static inline void interp_one_step(Sh4Context* ctx, u32 pc) {
    static Sh4Interpreter* s_inst = nullptr;
    if (!s_inst && Sh4Interpreter::Instance) s_inst = Sh4Interpreter::Instance;
    if (s_inst) {
        s_inst->Step();
        g_interp_step_count.fetch_add(1, std::memory_order_relaxed);
    } else {
        ctx->pc = pc + 2;
    }
}

// Resolve pc to the pending-or-parked span that CONTAINS it, not merely to a
// span that STARTS at it. The map keys on the block start, so an exact-key
// lookup answers nothing for a pc in the middle of a span — and control then
// falls into rdv_FailedToFindBlock_pc for an address inside a block whose
// FPCA is already claimed, which is the overlapping-block desync class. A
// mid-span pc arises two ways: the interp loop below ran out of guard inside
// a span that branches to itself, or the guest jumped into the middle of one.
// Ordered map => O(log n) predecessor lookup; only the greatest key <= pc is
// considered, so overlapping spans degrade to today's behaviour (miss) rather
// than to a wrong span.
static bool find_span(const std::map<u32, u32>& m, u32 pc, u32& lo, u32& hi)
{
    auto it = m.upper_bound(pc);        // first key strictly > pc
    if (it == m.begin())
        return false;
    --it;                               // greatest key <= pc
    if (pc - it->first >= it->second)   // pc is past this span's end
        return false;
    lo = it->first;
    hi = it->first + it->second;
    return true;
}

// A pc inside a span in s_pending_len (compiled, awaiting a shard seal) or in
// s_unreg_len (compiled-but-unregistered — see park_unregistered) is one
// flycast's bm_AddBlock has already run for (driver.cpp:202), so FPCA(vaddr)
// is already claimed (blockmanager.cpp:290). Re-entering the compile path for
// such a pc trips
//     verify((void*)bm_GetCode(block->addr) == (void*)ngen_FailedToFindBlock)
// at blockmanager.cpp:288 -> os_DebugBreak -> the pump dies. So it must be
// span-INTERPRETED from live RAM, never recompiled. Returns true if pc was in
// such a span (and was interpreted).
static bool span_interp_pending(Sh4Context* ctx, u32 pc)
{
    u32 lo, hilim;
    if (!find_span(s_pending_len, pc, lo, hilim) &&
        !find_span(s_unreg_len,   pc, lo, hilim))
        return false;
    // The guard exists because a span whose terminating branch targets its own
    // start keeps pc inside [lo,hilim) forever; it is NOT a span-length bound.
    // Floor it above the span's own instruction count (2 bytes/insn) so a
    // straight-line span — every span that does not branch into itself — always
    // runs to completion in ONE call and can never strand pc mid-span. The
    // +1024 keeps the historical iteration budget for the short self-looping
    // spans this was tuned on; a self-looping span that does exhaust the guard
    // is now recoverable, because find_span resolves the mid-span pc it leaves
    // behind on the next dispatch.
    int guard = (int)((hilim - lo) / 2) + 1024;
    const int g0 = guard;
    while (ctx->pc >= lo && ctx->pc < hilim &&
           --guard > 0 && ctx->CpuRunning)
        interp_one_step(ctx, ctx->pc);
    // HOT PENDING CODE IS SEALED NOW, NOT WHEN 4096 BLOCKS HAVE QUEUED. A
    // compiled-but-pending block runs here in the INTERPRETER (~20-50x the
    // JIT's cost) until its shard seals, and the only seal triggers were the
    // 4096-block cap and a 100K-dispatch check made only when ANOTHER block
    // compiles. A boot or level load (Gauntlet: guest 0.42-0.50x at duty 100%,
    // span_interp_pending + Sh4Interpreter::Step 6.8% self) spent seconds
    // interpreting code that was already compiled. Seal once the pending
    // spans have cost SHARD_INTERP_SEAL interpreted instructions. The count
    // is a pure function of guest execution and the pending set, the same
    // class as the dispatch-count trigger, so peers that share a cache
    // history (every lockstep room starts from a flush) seal at the same point.
    s_pending_interp += (u32)(g0 - guard);
    if (s_pending_interp >= SHARD_INTERP_SEAL && !s_pending_shard.empty())
        seal_pending_shard();
    return true;
}

// ---------------------------------------------------------------------------
// GAUNTLET WAIT-LOOP FAST-FORWARD (2026-10-15). Gauntlet Legends' timed wait
// (caller 0x8c032e20) spins up to 0x100000 passes of
//     8c032e5a jsr @R13(=0x8c038440) ; mov #7,R4
//     8c032e5e (*[R15])-- ; if (*[R15+4] != R14) exit ; if (*[R15]) goto 8c032e5a
// where 0x8c038440 calls table entry 7 of 0x8c35c274 — the null stub
// 0x8c036600 (rts; nop) — and returns 0. A pass touches no device and reads
// no timer: its only effects are a counter decrement, three stack words that
// are rewritten with the same values every pass, a fixed register file, and
// guest time. The exit flag changes only through an interrupt or a scheduled
// event, and both are delivered at slice credits, so between two scheduler
// ticks every pass is the same step.
//
// gwff_try applies K passes at once, at the head 0x8c032e5a, where K stops
// short of (a) the first slice credit that would tick the scheduler and (b) the
// pass that takes the counter to zero (that one runs for real, so the guest
// takes its own exit). Exactness argument for the cycle accounting: blocks
// drain their guest_cycles at entry and credit 448-cycle slices when the
// counter is <= 0 at a block entry. With T_j the uncredited counter at the
// j-th block entry, the credits made by then are max(0, ceil((1-T_j)/448)),
// which only depends on the LAST entry (T falls monotonically). Credits that
// do not tick the scheduler do nothing but cc += 448, sched_next -= 448 (and
// SRdecode, a no-op on an unchanged SR with nothing pending). So the state
// after K passes is closed-form. Anything unexpected — code bytes, the table
// entry, the stack layout, pointers aliasing what a pass writes, a pending
// interrupt, the MMU, an unlearned block length — falls back to running the
// pass. The per-block cycles are learned at compile time from flycast's own
// decoder (only when the bytes compiled are exactly the expected ones), so
// they are a pure function of these bytes, never host history.
// ?gwff=0 (flycast_set_gwff(0)) is the control.
// ---------------------------------------------------------------------------
// (g_gwff and its counters are defined near bemental_sh4_set_slice_inwasm.)
extern "C" void bemental_sh4_set_nolink_pc(u32 pc);
static const u32 GW_ADDR[6] = { 0x8c032e5au, 0x8c038440u, 0x8c036600u, 0x8c03845au, 0x8c032e5eu, 0x8c032e6eu };
static const u32 GW_SIZE[6] = { 4u, 0x1au, 4u, 8u, 0x10u, 8u };
static u32 s_gw_cyc[6] = { 0, 0, 0, 0, 0, 0 };
static const u16 GW_CODE_A[14] = { 0x4d0b,0xe407,0x63f2,0x6232,0x72ff,0x2322,0x53f1,0x6232,0x32e0,0x8b03,0x61f2,0x6312,0x2338,0x8bf1 };
static const u16 GW_CODE_B[17] = { 0x4f22,0x7ff8,0x6243,0xd30e,0x4208,0x2f42,0x4200,0x323c,0x6423,0x1f21,0x6122,0x410b,0x5441,0x7f08,0x4f26,0x000b,0xe000 };
static bool gwff_code_ok() {
    for (u32 i = 0; i < 14; i++) if (ReadMem16(0x8c032e5au + i * 2) != GW_CODE_A[i]) return false;
    for (u32 i = 0; i < 17; i++) if (ReadMem16(0x8c038440u + i * 2) != GW_CODE_B[i]) return false;
    if (ReadMem32(0x8c038480u) != 0x8c35c274u) return false;    // mov.l literal: table base
    if (ReadMem32(0x8c036600u) != 0x0009000bu) return false;    // rts ; nop
    if (ReadMem32(0x8c35c2acu) != 0x8c036600u) return false;    // table entry 7 -> the stub
    return true;
}
static void gwff_learn(const RuntimeBlockInfo* b) {
    for (int i = 0; i < 6; i++) {
        if (b->vaddr != GW_ADDR[i]) continue;
        const u32 c = (b->sh4_code_size == GW_SIZE[i] && gwff_code_ok()) ? b->guest_cycles : 0u;
        if (c != s_gw_cyc[i]) {
            s_gw_cyc[i] = c;
            MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[gwff] learn 0x' + ($0>>>0).toString(16) +
                ' size=' + ($1|0) + ' cycles=' + ($2|0)}); }, (int)b->vaddr, (int)b->sh4_code_size, (int)c);
        }
        return;
    }
}
static inline bool gw_overlap(u32 a, u32 alen, u32 b, u32 blen) { return a < b + blen && b < a + alen; }
static inline bool gw_ram(u32 a) { return (a & 3u) == 0 && a >= 0x8c000000u && a < 0x8d000000u; }
extern volatile uint32_t g_slice_credited;
// Returns true if it applied K >= 1 passes (pc stays at the head).
static bool gwff_try(Sh4Context* ctx) {
    u32 C = 0;
    for (int i = 0; i < 6; i++) { if (!s_gw_cyc[i]) return false; C += s_gw_cyc[i]; }
    if (ctx->interrupt_pend || !ctx->CpuRunning || g_parity_hashing || mmu_enabled()) return false;
    if (ctx->r[13] != 0x8c038440u) return false;
    const u32 sp = ctx->r[15];
    if (!gw_ram(sp - 12) || !gw_ram(sp + 4)) return false;
    if (!gwff_code_ok()) return false;
    const u32 ctrp = ReadMem32(sp), flgp = ReadMem32(sp + 4);
    if (!gw_ram(ctrp) || !gw_ram(flgp) || ctrp == flgp) return false;
    // nothing a pass writes may alias anything a pass reads
    struct R { u32 a, n; } const fixed[] = { {0x8c032e5au, 28}, {0x8c038440u, 0x44}, {0x8c036600u, 4},
                                             {0x8c35c2acu, 8}, {flgp, 4}, {sp, 8} };
    for (const R& r : fixed) {
        if (gw_overlap(sp - 12, 12, r.a, r.n)) return false;
        if (gw_overlap(ctrp, 4, r.a, r.n)) return false;
    }
    const u32 flag = ReadMem32(flgp);
    if (flag != ctx->r[14]) return false;
    const u32 cnt = ReadMem32(ctrp);
    if (cnt < 2u) return false;
    const int sn = Sh4cntx.sh4_sched_next;
    if (sn < 0) return false;
    const long long M = sn / SH4_TIMESLICE;          // credits that cannot tick
    const long long cc0 = ctx->cycle_counter;
    const long long P = (long long)C - s_gw_cyc[5];  // a pass's cycles before F's entry
    const long long num = cc0 - P - 1 + (long long)SH4_TIMESLICE * M;
    if (num < 0) return false;
    long long K = 1 + num / C;
    if (K > (long long)cnt - 1) K = (long long)cnt - 1;
    if (K < 1) return false;
    const long long TF = cc0 - (K - 1) * (long long)C - P;   // uncredited cc at pass K's F entry
    const long long m = TF > 0 ? 0 : (1 - TF + SH4_TIMESLICE - 1) / SH4_TIMESLICE;
    if (m > M) return false;                         // (cannot happen; belt and braces)
    // apply
    WriteMem32(sp - 4, 0x8c032e5eu);                 // sts.l PR (jsr return) in 0x8c038440
    WriteMem32(sp - 12, 7u);                         // [R15'] = R4 (= 7, A's delay slot)
    WriteMem32(sp - 8, 0x8c35c2acu);                 // [R15'+4] = &table[7]
    WriteMem32(ctrp, cnt - (u32)K);
    ctx->r[0] = 0;
    ctx->r[1] = ctrp;
    ctx->r[2] = flag;
    ctx->r[3] = cnt - (u32)K;
    ctx->r[4] = ReadMem32(0x8c35c2b0u);              // table[7].arg, loaded in B's delay slot
    ctx->pr = 0x8c032e5eu;
    ctx->sr.T = 0;                                   // F: tst R3,R3 with R3 != 0
    ctx->cycle_counter = (int)(cc0 - K * (long long)C + (long long)SH4_TIMESLICE * m);
    Sh4cntx.sh4_sched_next = (int)(sn - (long long)SH4_TIMESLICE * m);
    if (m) g_slice_credited = 1;
    if (g_pch_on) pch_burn(0x8c032e5au, (u64)(K * C));
    ++g_gwff_runs;
    g_gwff_passes += (u32)K;
    if ((g_gwff_runs & 16383u) == 1u)
        MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[gwff] runs=' + ($0>>>0) + ' passes=' + ($1>>>0) +
            ' fallbacks=' + ($2>>>0) + ' lastK=' + ($3|0)}); }, (int)g_gwff_runs, (int)g_gwff_passes, (int)g_gwff_fallbacks, (int)K);
    return true;
}
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_gwff(int on) {
    g_gwff = !!on;
    bemental_sh4_set_nolink_pc(on ? 0x8c032e5au : 0u);
}

// ---------------------------------------------------------------------------
// PSO TIMED-WAIT FAST-FORWARD (2026-10-15). PSO's timed wait (0x8c38d456;
// the toaster gate's bench scene spends ~13.6% of all guest cycles here, ~43%
// of what idle-skip leaves) is the leaf loop
//     8c38d480 jsr @R13(=8c37b636) ; nop      R0 = ~TCNT0 (mov.l @(lit)=ffd8000c)
//     8c38d484 mov R0,R5 ; jsr @R10(=8c37b640) ; mov.l @R12,R4      R0 = R5 - R4
//     8c38d48a jsr @R9(=8c37b67a) ; mov R0,R4                       R0 = d*100/128
//     8c38d48e mov R0,R14 ; if (*0x8c58caf4 == 0) goto 8c38d49e (exit)
//     8c38d498 if (R14 <u 0x28870) goto 8c38d480
// It stores nothing, touches no stack and reads three words: TCNT0, the start
// tick [R12] and the flag 0x8c58caf4. Between two scheduler ticks no device and
// no interrupt can change RAM or deliver, so each pass differs from the last
// only in the TCNT0 value it reads, and that is a pure function of guest time:
// tmu.cpp's read is base - (now() >> shift), now() = sched_now64 + SLICE - cc.
// The registers after a pass depend only on that pass's read:
//   R3 = TCNT, R0 = R14 = e(d), R4 = d = ~TCNT - [R12], R5 = 100, R2 = 0x28870,
//   R3 = 0x8c58caf4, MACL = 100*(d>>7), PR = 0x8c38d48e, T = 0.
// e(d) = ((d&127)*100 >> 7) + (d>>7)*100 is monotone over u32 (no overflow), so
// the pass that exits is found by bisection. pswff_try applies K passes at the
// head 0x8c38d480, K stopping before (a) the first slice credit that would tick
// the scheduler (gwff_try's closed form, same derivation), (b) the pass whose
// value reaches 0x28870 (it runs for real, so the guest takes its own exit),
// (c) any read that would see the counter below zero (the real read reloads it
// and raises TUNI0), and (d) a wrap of d. The read inside pass j happens at
// now0 + (j-1)*C + c1 + c2 (blocks drain their cycles at entry; credits leave
// now() unchanged: sched_next -= 448, cc += 448). Anything unexpected falls back
// to the real pass. Block cycles are learned at compile time from flycast's
// decoder for the exact expected bytes only. ?pswff=0 is the control; ?pswff=2
// is a DIAG check that applies nothing and compares the K-pass prediction to
// the real state at the K-th following head arrival.
// ---------------------------------------------------------------------------
extern "C" void bemental_sh4_set_nolink_pc2(u32 pc);
extern "C" s64 tmu_tcnt_model(u32 ch, u64 at);
extern "C" u64 tmu_now_cycles();
// (g_pswff and its counters are defined near g_gwff.)
static constexpr u32 PS_HEAD = 0x8c38d480u;
static const u32 PS_ADDR[8] = { 0x8c38d480u, 0x8c37b636u, 0x8c38d484u, 0x8c37b640u,
                                0x8c38d48au, 0x8c37b67au, 0x8c38d48eu, 0x8c38d498u };
static const u32 PS_SIZE[8] = { 4u, 10u, 6u, 6u, 4u, 0x1au, 10u, 6u };
static u32 s_ps_cyc[8] = { 0, 0, 0, 0, 0, 0, 0, 0 };
static const u16 PS_CODE_A[14] = { 0x4d0b,0x0009,0x6503,0x4a0b,0x64c2,0x490b,0x6403,0x6e03,0xd33d,0x6232,0x2228,0x8902,0xd23c,0x3e22 };
static const u16 PS_CODE_A2 = 0x8bf0;            // 8c38d49c bf 8c38d480
static const u16 PS_CODE_B[5] = { 0xd243,0xe0ff,0x6322,0x000b,0x3038 };
static const u16 PS_CODE_C[3] = { 0x6053,0x000b,0x3048 };
static const u16 PS_CODE_D[13] = { 0xe07f,0x6243,0x2049,0xe564,0x0057,0xe3f9,0x423d,0x001a,0x0257,0x403d,0x021a,0x000b,0x302c };
static bool pswff_code_ok() {
    for (u32 i = 0; i < 14; i++) if (ReadMem16(0x8c38d480u + i * 2) != PS_CODE_A[i]) return false;
    if (ReadMem16(0x8c38d49cu) != PS_CODE_A2) return false;
    for (u32 i = 0; i < 5; i++) if (ReadMem16(0x8c37b636u + i * 2) != PS_CODE_B[i]) return false;
    for (u32 i = 0; i < 3; i++) if (ReadMem16(0x8c37b640u + i * 2) != PS_CODE_C[i]) return false;
    for (u32 i = 0; i < 13; i++) if (ReadMem16(0x8c37b67au + i * 2) != PS_CODE_D[i]) return false;
    if (ReadMem32(0x8c37b744u) != 0xffd8000cu) return false;   // B's literal: TCNT0
    if (ReadMem32(0x8c38d588u) != 0x8c58caf4u) return false;   // the flag's address
    if (ReadMem32(0x8c38d58cu) != 0x00028870u) return false;   // the bound
    return true;
}
static void pswff_learn(const RuntimeBlockInfo* b) {
    for (int i = 0; i < 8; i++) {
        if (b->vaddr != PS_ADDR[i]) continue;
        const u32 c = (b->sh4_code_size == PS_SIZE[i] && pswff_code_ok()) ? b->guest_cycles : 0u;
        if (c != s_ps_cyc[i]) {
            s_ps_cyc[i] = c;
            MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[pswff] learn 0x' + ($0>>>0).toString(16) +
                ' size=' + ($1|0) + ' cycles=' + ($2|0)}); }, (int)b->vaddr, (int)b->sh4_code_size, (int)c);
        }
        return;
    }
}
static inline u32 ps_e(u32 d) { return (((d & 127u) * 100u) >> 7) + (d >> 7) * 100u; }
// the DIAG check's stash: the state predicted for the next head arrival
static struct { bool on; long long left; u32 r[16]; u32 pr, macl, mach, T; int cc, sn; uint64_t ticks, vecs; } s_ps_chk = {};
// Returns true if it applied K >= 1 passes (pc stays at the head).
static bool pswff_try(Sh4Context* ctx) {
    u32 C = 0;
    for (int i = 0; i < 8; i++) { if (!s_ps_cyc[i]) return false; C += s_ps_cyc[i]; }
    if (ctx->interrupt_pend || !ctx->CpuRunning || g_parity_hashing || mmu_enabled()) return false;
    if (ctx->r[13] != 0x8c37b636u || ctx->r[10] != 0x8c37b640u || ctx->r[9] != 0x8c37b67au) return false;
    const u32 startp = ctx->r[12];
    if (!gw_ram(startp)) return false;
    if (!pswff_code_ok()) return false;
    if (g_pswff == 2 && s_ps_chk.on) return false;   // DIAG: a prediction is still in flight
    for (int i = 0; i < 8; i++) if (!jit_live(PS_ADDR[i])) return false;   // all compiled, none pending
    if (ReadMem32(0x8c58caf4u) == 0) return false;   // the guest exits this pass
    const u32 start = ReadMem32(startp);
    const int sn = Sh4cntx.sh4_sched_next;
    const int cc0i = ctx->cycle_counter;
    if (sn < 0 || cc0i <= 0) return false;
    // (a) the scheduler bound, as gwff_try: credits made by pass K's last block entry
    const long long M = sn / SH4_TIMESLICE;
    const long long cc0 = cc0i;
    const long long P = (long long)C - s_ps_cyc[7];
    const long long num = cc0 - P - 1 + (long long)SH4_TIMESLICE * M;
    if (num < 0) return false;
    long long Kmax = 1 + num / C;
    if (Kmax > 1000000) Kmax = 1000000;
    // (b)-(d): pass j reads at now0 + (j-1)*C + c1 + c2
    const u64 now0 = tmu_now_cycles();
    const u64 rd0 = now0 + s_ps_cyc[0] + s_ps_cyc[1];
    const s64 v1 = tmu_tcnt_model(0, rd0);
    if (v1 < 0 || v1 > 0xffffffffll) return false;
    const u32 d1 = (0xffffffffu - (u32)v1) - start;
    auto pass_ok = [&](long long j, u32* dout, u32* vout) -> bool {
        const s64 v = tmu_tcnt_model(0, rd0 + (u64)(j - 1) * C);
        if (v < 0 || v > v1) return false;
        const u64 d = (u64)d1 + (u64)(v1 - v);
        if (d > 0xffffffffull) return false;
        if (ps_e((u32)d) >= 0x28870u) return false;
        if (dout) *dout = (u32)d;
        if (vout) *vout = (u32)v;
        return true;
    };
    if (!pass_ok(1, nullptr, nullptr)) return false;
    long long lo = 1, hi = Kmax;                     // pass_ok(lo) holds; monotone in j
    while (lo < hi) { const long long mid = lo + (hi - lo + 1) / 2; if (pass_ok(mid, nullptr, nullptr)) lo = mid; else hi = mid - 1; }
    long long K = lo;
    u32 dK = 0, vK = 0;
    if (!pass_ok(K, &dK, &vK)) return false;         // (cannot happen)
    const long long TL = cc0 - (K - 1) * (long long)C - P;   // uncredited cc at pass K's last block entry
    const long long m = TL > 0 ? 0 : (1 - TL + SH4_TIMESLICE - 1) / SH4_TIMESLICE;
    if (m > M) return false;                         // (cannot happen)
    const u32 eK = ps_e(dK);
    u32 r[16]; for (int i = 0; i < 16; i++) r[i] = ctx->r[i];
    r[0] = eK; r[2] = 0x00028870u; r[3] = 0x8c58caf4u; r[4] = dK; r[5] = 100u; r[14] = eK;
    const int ccK = (int)(cc0 - K * (long long)C + (long long)SH4_TIMESLICE * m);
    const int snK = (int)(sn - (long long)SH4_TIMESLICE * m);
    if (g_pswff == 2) {                              // DIAG: predict, apply nothing
        s_ps_chk.on = true; s_ps_chk.left = K;
        for (int i = 0; i < 16; i++) s_ps_chk.r[i] = r[i];
        s_ps_chk.pr = 0x8c38d48eu; s_ps_chk.macl = (dK >> 7) * 100u; s_ps_chk.mach = ctx->mac.h; s_ps_chk.T = 0;
        s_ps_chk.cc = ccK; s_ps_chk.sn = snK; s_ps_chk.ticks = g_dbg_sched_ticks; s_ps_chk.vecs = g_dbg_vec_count;
        return false;
    }
    for (int i = 0; i < 16; i++) ctx->r[i] = r[i];
    ctx->mac.l = (dK >> 7) * 100u;
    ctx->pr = 0x8c38d48eu;
    ctx->sr.T = 0;
    ctx->cycle_counter = ccK;
    Sh4cntx.sh4_sched_next = snK;
    if (m) g_slice_credited = 1;
    if (g_pch_on) pch_burn(PS_HEAD, (u64)(K * C));
    ++g_pswff_runs;
    g_pswff_passes += (u32)K;
    (void)vK;
    if ((g_pswff_runs & 65535u) == 1u)
        MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[pswff] runs=' + ($0>>>0) + ' passes=' + ($1>>>0) +
            ' fallbacks=' + ($2>>>0) + ' lastK=' + ($3|0)}); }, (int)g_pswff_runs, (int)g_pswff_passes, (int)g_pswff_fallbacks, (int)K);
    return true;
}
// DIAG check: called at every head arrival before pswff_try while ?pswff=2.
static void pswff_check(Sh4Context* ctx) {
    if (!s_ps_chk.on) return;
    if (s_ps_chk.ticks != g_dbg_sched_ticks || s_ps_chk.vecs != g_dbg_vec_count) { s_ps_chk.on = false; return; }   // not comparable
    if (--s_ps_chk.left > 0) return;                 // the K-th real pass has not ended yet
    s_ps_chk.on = false;
    // The dispatcher may credit at the next head entry (pass K+1's), which the
    // prediction does not include: accept whole slices moved from sn to cc.
    const long long dc = (long long)ctx->cycle_counter - s_ps_chk.cc;
    const bool cyc_ok = dc == (long long)s_ps_chk.sn - Sh4cntx.sh4_sched_next && dc >= 0 && dc % SH4_TIMESLICE == 0 &&
                        (dc == 0 || s_ps_chk.cc <= 0);
    bool ok = ctx->pr == s_ps_chk.pr && ctx->mac.l == s_ps_chk.macl && ctx->mac.h == s_ps_chk.mach &&
              (u32)ctx->sr.T == s_ps_chk.T && cyc_ok;
    for (int i = 0; i < 16; i++) ok = ok && ctx->r[i] == s_ps_chk.r[i];
    if (ok) { ++g_pswff_chk_ok; if ((g_pswff_chk_ok & 65535u) == 1u)
        MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[pswff-check] ok=' + ($0>>>0) + ' bad=' + ($1>>>0)}); }, (int)g_pswff_chk_ok, (int)g_pswff_chk_bad);
        return; }
    if (++g_pswff_chk_bad <= 8) {
        char buf[600]; int o = snprintf(buf, sizeof buf, "[pswff-check] MISMATCH #%u cc %d/%d sn %d/%d pr %08x/%08x macl %08x/%08x T %u/%u",
            (unsigned)g_pswff_chk_bad, ctx->cycle_counter, s_ps_chk.cc, Sh4cntx.sh4_sched_next, s_ps_chk.sn,
            ctx->pr, s_ps_chk.pr, ctx->mac.l, s_ps_chk.macl, (unsigned)ctx->sr.T, s_ps_chk.T);
        for (int i = 0; i < 16; i++) if (ctx->r[i] != s_ps_chk.r[i]) o += snprintf(buf + o, sizeof buf - o, " r%d %08x/%08x", i, ctx->r[i], s_ps_chk.r[i]);
        MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
    }
}
// The head stays unlinked in EVERY arm, the control included, so ?pswff=0
// compiles the same code and differs only in the apply. What still differs is
// host dispatch history: the fast-forward removes dispatches, and outside
// rollback mode shard seal points (and so which blocks run interpreted, at a
// different cycle charge) follow dispatch counts. Measured on the bench scene
// with ?aicahash=1: sharded, on vs off differ in RAM (3 pages: the frame-time
// words at 0x8c58d000/0x8c5b9000 and 0x8c00f000) at the first 5 s window after
// the seed restore, the JIT-refill window, and agree from then on; with
// ?noshard=1 (no pending spans) all 25 windows are identical. Same caveat as
// gwff_try (docs/toaster-split).
extern "C" EMSCRIPTEN_KEEPALIVE void flycast_set_pswff(int on) {
    g_pswff = (u32)(on < 0 ? 0 : on > 2 ? 2 : on);
    s_ps_chk.on = false;
}

static uintptr_t g_tw_ram_base = 0;   // what the trampoline baked as the RAM base (tripwire)
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
    const bool interp_this = g_interp_only ||
        (g_interp_hi > g_interp_lo && pc >= g_interp_lo && pc < g_interp_hi);
    if (interp_this) {
        // Keystream watchpoint mirror (interp arm): capture R0 the instant
        // AFTER 0x8c00415c executes (pc==0x8c00415e) so it matches the JIT
        // arm's post-fn() capture — this is the correct reference keystream.
        if (pc == 0x8c00415eu) {
            static int s_iks = 0;
            if (s_iks < 12) {
                ++s_iks;
                MAIN_THREAD_EM_ASM({
                    postMessage({cmd:'print', txt:'[keystream #' + ($0|0) + '] r0(ks)=0x' +
                        ($1>>>0).toString(16) + ' r13(i)=' + ($2>>>0) + ' (INTERP)'});
                }, s_iks, (int)ctx->r[0], (int)ctx->r[13]);
            }
        }
        {
            static bool s_ire0 = false, s_ircc = false;
            const struct { u32 pc; bool* d; } pts[] = { {0x8c0040ccu,&s_ircc}, {0x8c0040e0u,&s_ire0} };
            for (auto& t : pts) {
                if (pc == t.pc && !*t.d) {
                    *t.d = true;
                    char buf[512];
                    int off = snprintf(buf, sizeof(buf), "[rdiff INT 0x%08x] mac=%08x:%08x", t.pc, ctx->mac.h, ctx->mac.l);
                    for (int i = 0; i < 16; i++) off += snprintf(buf+off, sizeof(buf)-off, " r%d=%08x", i, ctx->r[i]);
                    MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
                }
            }
        }
        if (pc == 0x8c004184u) {
            static bool s_ipool_done = false;
            if (!s_ipool_done) {
                s_ipool_done = true;
                const u32 sp = ctx->r[4];
                char buf[640];
                MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[pool INT] state=0x'+($0>>>0).toString(16)}); }, (int)sp);
                for (int line = 0; line < 4; line++) {
                    int off = snprintf(buf, sizeof(buf), "[pool INT %d]", line * 15);
                    for (int i = 0; i < 15; i++) {
                        u32 w = 0; try { w = ReadMem32(sp + (line * 15 + i) * 4); } catch (...) {}
                        off += snprintf(buf + off, sizeof(buf) - off, " %08x", w);
                    }
                    MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
                }
            }
        }
        // Step() nulls the global Instance on exit (sh4_interpreter.cpp:92-106),
        // so the old `if (Instance) Step(); else pc += 2` degraded to silent
        // pc-walking after the FIRST step — every interp differential since
        // May was hollow (charter §4). Cache the instance once; Step() sets
        // Instance=this around itself so delay-slot execution still works.
        static Sh4Interpreter* s_interp_inst = nullptr;
        if (!s_interp_inst && Sh4Interpreter::Instance)
            s_interp_inst = Sh4Interpreter::Instance;
        if (s_interp_inst) {
            s_interp_inst->Step();
            g_interp_step_count.fetch_add(1, std::memory_order_relaxed);
            // Same trajectory ring + escape tripwire as the JIT path — the
            // differential needs identical forensics on both arms.
            const u32 stepped_pc = ctx->pc & ~1u;
            g_pc_ring[g_pc_ring_idx++ & 127] = stepped_pc;
            const u32 paddr = stepped_pc & 0x1FFFFFFFu;
            static bool s_interp_escape_dumped = false;
            if (!s_interp_escape_dumped &&
                !((paddr < 0x00200000u) || ((paddr & 0x1C000000u) == 0x0C000000u))) {
                s_interp_escape_dumped = true;
                MAIN_THREAD_EM_ASM({
                    postMessage({cmd:'print', txt:'[interp-escape] pc=0x' + ($0>>>0).toString(16) +
                        ' spc=0x' + ($1>>>0).toString(16) + ' sr=0x' + ($2>>>0).toString(16) +
                        ' pr=0x' + ($3>>>0).toString(16)});
                }, (int)stepped_pc, (int)ctx->spc, (int)ctx->sr.getFull(), (int)ctx->pr);
                isr_trace_flush(ctx);
            }
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
        g_tw_ram_base = s_ram_base;   // the mainloop tripwire checks it against the live mem_b
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
        // Lever-9D: OC-RAM fastpath plumbing (accessors patched into
        // sh4_mmr.cpp — the 8KB OnChipRAM array + CCN_CCR live there as
        // statics). PSO keeps its stack in OC-RAM; the area histogram
        // measured ALL residual import traffic in raw bucket b31.
        bemental::sh4::g_ocram_lin_base = (u32)sh4_ocram_base();
        bemental::sh4::g_ccr_addr = (u32)sh4_ccr_addr();
        MAIN_THREAD_EM_ASM({
            postMessage({cmd:'print', txt:
                '[mem-map] ram=0x' + ($0>>>0).toString(16) +
                ' &mem_b[0]=0x' + ($1>>>0).toString(16) +
                ' &vram[0]=0x' + ($2>>>0).toString(16) +
                ' &aica_ram[0]=0x' + ($3>>>0).toString(16)});
        }, (int)s_ram_base, (int)pMem, (int)pVram, (int)pAica);
    }

    // (Closed boot-title-wedge one-shot dispatch snapshots — ipl-entry-snap,
    // xab4c-snap, pr-snap, poll-139e — stripped 2026-08-21 per strip-after-verdict:
    // they added per-dispatch `pc==const` checks to the JIT hot path.)

    // Lever-11 v0 sizing (flag-gated, default OFF): PSO's frame-wait spin —
    // 0x8c3c53d8 (jsr through the callback slot), 0x8c3c53e0 (frame-counter
    // check, the jsr's return pc), 0x8c3c53f8 (flag check, loops to 53d8) —
    // is the profile's top-3 self-time. Its exit condition changes only via
    // ISR-updated memory, and interrupts deliver at slice boundaries, so with
    // no interrupt pending the rest of the slice inside the spin is
    // guest-unobservable: burn the remaining credit in one step and let the
    // crediting loop advance the scheduler/deliver as usual. Guard: the
    // per-iteration callback must still be the null stub 0x8c3c34d0 (rts;nop)
    // — a real callback disables the skip. NOTE the double deref: the code
    // literal [0x8c3c5460] holds a struct POINTER (0x8c5b8fd4 in the live
    // dump); the callback is that struct's word 0 (`mov.l @R3,R2; jsr @R2`).
    if (g_idleskip && ctx->interrupt_pend == 0 &&
        (pc == 0x8c3c53d8u || pc == 0x8c3c53e0u || pc == 0x8c3c53f8u)) {
        // v0 verdict (isk=620K/s, clk NULL): a one-slice burn per visit costs
        // ~a C round-trip + two addrspace reads per 448 cycles — comparable
        // to just executing the spin. v0.1: (a) cache the guard verdict,
        // re-verifying every 256th burn (a real callback set mid-window is
        // seen within ≤256 slices ≈ 115K guest cycles); (b) fast-forward to
        // just before the NEXT scheduled event in one step — now64 =
        // sched_ffb - sched_next (sh4_sched.cpp:117), so shrinking
        // sched_next advances guest time; stopping while it is still > 0
        // guarantees no event in the skipped span was due. The next
        // crediting pass crosses zero naturally and fires the event.
        // Exact per-burn guard at direct-load cost: the struct pointer P in
        // the code literal [0x8c3c5460] is code-constant (0x8c5b8fd4 in the
        // live dump), so resolve &P[0] to a host pointer once and compare the
        // live callback word every burn. The earlier every-256th-burn cache
        // left up to ~7.5ms of guest time running with a stale verdict once
        // multi-slice skips landed — S arms grew 6 watchdog stalls/60s.
        static const u32* s_isk_cb_word = nullptr;
        if (!s_isk_cb_word) {
            const u32 p = ReadMem32(0x8c3c5460u);
            s_isk_cb_word = (const u32*)GetMemPtr(p, 4);
        }
        // Progress bound. Skipping EVERY visit to the spin means the guest
        // never executes the compare that lets it leave the loop: the exit
        // condition can be satisfied and the guest cannot observe it. That is
        // what pins a cold boot at the spin (measured: ctxsnap pc=0x8c3c53d8
        // with isk climbing ~44K/s while the boot never completes). Let at
        // most ISK_RUN consecutive skips pass, then execute the block for
        // real so the loop gets a chance to exit: one real iteration per
        // ISK_RUN+1 visits, i.e. a genuine wait still skips 32/33 = ~97%.
        //
        // [corrected 2026-08-28] 83315e3's message says "the counter resets
        // whenever the guest is anywhere else" — it does not. s_isk_streak is
        // reset ONLY when it reaches the cap, so it persists across
        // excursions out of the spin. That is the conservative direction (a
        // later wait can reach its real execution in fewer than ISK_RUN
        // skips) and it is why there is no per-dispatch reset store on the
        // hot path. The progress bound is unaffected.
        // s_isk_streak lives at file scope (see g_idleskip) so a state load
        // can zero it; it was a function-static here.
        constexpr u32 ISK_RUN = 32;
        if (s_isk_streak >= ISK_RUN) { s_isk_streak = 0; goto isk_no_skip; }
        if (s_isk_cb_word && *s_isk_cb_word == 0x8c3c34d0u) {
            ++g_idleskip_burns;
            // Fast-forward to the next scheduled event, accounting for the
            // skipped span the way the crediting loop does. That loop is
            //     sched_next -= N; if (sched_next < 0) sh4_sched_tick(N);
            // with N = SH4_TIMESLICE, and sh4_sched_tick computes
            // fztime = sh4_sched_now() - N (sh4_sched.cpp), so the identical
            // shape with a LARGER N is correct: everything that came due
            // inside the span still fires against the right window, and the
            // trailing sh4_sched_ffts() re-arms sched_next.
            //
            // The first cut shrank sched_next directly and never ticked, so
            // guest time jumped while the scheduler never saw the span.
            // Gameplay survived (VBlank-driven); a COLD BOOT hung with the
            // guest pinned at 0x8c00fa00 on the Reios GDROM completion it
            // polls, black screen. Do not reintroduce a jump that omits the
            // tick.
            const int due = Sh4cntx.sh4_sched_next;
            if (due > SH4_TIMESLICE) {
                if (g_pch_on) pch_burn(pc, (u64)(due + 1));
                Sh4cntx.sh4_sched_next -= (due + 1);   // -> -1: event now due
                sh4_sched_tick(due + 1);
                ++g_dbg_sched_ticks;
            }
            if (ctx->cycle_counter > 0) ctx->cycle_counter = 0;
            ++s_isk_streak;
            return;
        }
    }
isk_no_skip:
    if (g_gwff && pc == 0x8c032e5au) {
        if (gwff_try(ctx)) return;
        ++g_gwff_fallbacks;
    }
    if (g_pswff && pc == 0x8c38d480u) {
        if (g_pswff == 2) pswff_check(ctx);
        if (pswff_try(ctx)) return;
        ++g_pswff_fallbacks;
    }

    BlockFn fn = jit_lookup(pc);
    // (The lever-4 D1 post-restore bracket logs that lived here were STRIPPED
    // after their verdict — they proved the wild call_indirect was NOT this
    // dispatch but a std::async SH4 thread spawned by retro_unserialize's
    // emu.start() under a clobbered ThreadedRendering. Fixed by the
    // un-clobberable re-pin in Emulator::start() (emulator.cpp, WASM-gated).)
    if (!fn && g_lookup_stale && g_rb_mode) {
        // ROLLBACK MODE (patch 0002): a stale hit must route the SAME way on
        // every peer, and a peer that never compiled the old bytes compiles
        // the new ones. So drop the stale unit and fall into the miss path,
        // which recompiles from live RAM — instead of interpreting.
        rb_discard_unit_of(g_lookup_slot);
        g_lookup_stale = false;
        ++g_rb_stale_recompiles;
    }
    if (!fn && g_lookup_stale) {
        // SMC-stale block: interpret one instruction from live RAM instead
        // of recompiling (recompiling desyncs flycast's bm and crashes its
        // bm_AddBlock FPCA verify). Correct always; boot loaders run once.
        interp_one_step(ctx, pc);
        return;
    }
    if (!fn) {
        // Cold block — ask the block manager to compile via the standard
        // Flycast miss path. compile() will install via wasm_install_block
        // and call jit_register. Re-lookup after; if STILL nothing (probe-
        // limit collision, install failure, etc.) single-step the next
        // instruction so we don't spin. SH4 insn width is 2 bytes; that
        // matches the historical EM_JS fallback's `vaddr + 2`.
        // 6D: under sharded install, a compiled-but-PENDING block must be
        // executed INTERPRETED through its whole span — and the compile path
        // must not run for a pending pc (single-stepping left pc mid-block;
        // the next miss then compiled an OVERLAPPING block and flycast's bm
        // verify DEBUGBREAK'd — the documented desync class).
        // Parked (compiled-but-unregistered) pcs must be checked BEFORE
        // rdv_FailedToFindBlock_pc in BOTH modes: jit_register can hit its
        // probe limit on the shard seal, on the per-shard-block fallback, AND
        // on the per-block (noshard) install path, and every one of those
        // leaves FPCA(vaddr) already claimed. See span_interp_pending.
        if (s_shard_enabled) {
            if (span_interp_pending(ctx, pc))
                return;
            rdv_FailedToFindBlock_pc();
            fn = jit_lookup(pc);
            if (!fn) {
                if (!span_interp_pending(ctx, pc))
                    interp_one_step(ctx, pc);   // unknown miss: make honest progress
                return;
            }
        } else {
            if (span_interp_pending(ctx, pc))
                return;
            rdv_FailedToFindBlock_pc();
            fn = jit_lookup(pc);
            if (!fn) {
                // compile() just ran. If it could not make this block
                // reachable it parked the vaddr (probe limit, or the JS
                // install threw) — FPCA is claimed, so span-interpret it.
                // The old fallthrough below set pc += 2, SKIPPING the
                // instruction unexecuted and leaving pc mid-block, which then
                // compiled an OVERLAPPING block on the next miss.
                if (!span_interp_pending(ctx, pc))
                    interp_one_step(ctx, pc);   // unknown miss: honest progress
                return;
            }
        }
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
    ++g_dbg_roundtrips;  // Lever-1 baseline: one C->block dispatch
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
    // Escape forensics v2: always-on trajectory ring (flushed at escape).
    g_pc_ring[g_pc_ring_idx++ & 127] = next_pc;
    // Boot-bug block capture (boot-title-wedge, bisected to [0x8c008300,
    // 0x8c008400)): dump the code + entry pc the first time execution lands
    // in that window, so the defective block can be disassembled.
    {
        static bool s_bb = false;
        if (!s_bb && next_pc >= 0x8c004380u && next_pc < 0x8c004400u) {
            s_bb = true;
            MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[decbug entry] pc=0x'+($0>>>0).toString(16)}); }, (int)next_pc);
            char buf[560];
            for (int line = 0; line < 8; line++) {
                const u32 base = 0x8c004380u + line * 0x20;
                int off = snprintf(buf, sizeof(buf), "[decbug 0x%08x]", base);
                for (int i = 0; i < 16; i++) {
                    u32 w = 0; try { w = ReadMem16(base + i * 2) & 0xFFFF; } catch (...) {}
                    off += snprintf(buf + off, sizeof(buf) - off, " %04x", w);
                }
                MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
            }
        }
    }
    // ran3 block-entry register diff (boot-title-wedge, BOTH arms via the
    // trampoline). Dump r0-r15 + MAC at the first entry to the warmup-store
    // block 0x8c0040e0 and the seed-init block 0x8c0040cc. Identical inputs
    // across arms ⇒ the divergence is produced inside that block; differing
    // inputs ⇒ it's upstream. (JIT path: next_pc; interp mirror below.)
    {
        static bool s_re0 = false, s_rcc = false;
        const struct { u32 pc; bool* d; } pts[] = { {0x8c0040ccu,&s_rcc}, {0x8c0040e0u,&s_re0} };
        for (auto& t : pts) {
            if (next_pc == t.pc && !*t.d) {
                *t.d = true;
                char buf[512];
                int off = snprintf(buf, sizeof(buf), "[rdiff JIT 0x%08x] mac=%08x:%08x", t.pc, ctx->mac.h, ctx->mac.l);
                for (int i = 0; i < 16; i++) off += snprintf(buf+off, sizeof(buf)-off, " r%d=%08x", i, ctx->r[i]);
                MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
            }
        }
    }
    // Arithmetic-core code capture (boot-title-wedge): the two routines the
    // scramble dispatcher calls to fill the pool — one of these carries the
    // divergent op. Dump 48 words each on first entry.
    {
        static bool s_c1 = false, s_c2 = false;
        const struct { u32 pc; bool* done; const char* tag; } cores[] = {
            { 0x8c012e78u, &s_c1, "core-e78" },
            { 0x8c010080u, &s_c2, "core-080" },
        };
        for (auto& c : cores) {
            if (next_pc == c.pc && !*c.done) {
                *c.done = true;
                char buf[560];
                for (int line = 0; line < 6; line++) {
                    const u32 base = c.pc + line * 0x20;
                    int off = snprintf(buf, sizeof(buf), "[%s 0x%08x]", c.tag, base);
                    for (int i = 0; i < 16; i++) {
                        u32 w = 0; try { w = ReadMem16(base + i * 2) & 0xFFFF; } catch (...) {}
                        off += snprintf(buf + off, sizeof(buf) - off, " %04x", w);
                    }
                    MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
                }
            }
        }
    }
    // Scramble-routine code capture (boot-title-wedge): 0x8c012dc0 is the
    // jsr target that turns the "SEGA..." seed into the 55-word pool — the
    // routine where the arms diverge. Dump 64 words on first entry.
    {
        static bool s_scr_done = false;
        if (next_pc == 0x8c012dc0u && !s_scr_done) {
            s_scr_done = true;
            char buf[560];
            for (int line = 0; line < 8; line++) {
                const u32 base = 0x8c012dc0u + line * 0x20;
                int off = snprintf(buf, sizeof(buf), "[scramble] base=0x%08x:", base);
                for (int i = 0; i < 16; i++) {
                    u32 w = 0; try { w = ReadMem16(base + i * 2) & 0xFFFF; } catch (...) {}
                    off += snprintf(buf + off, sizeof(buf) - off, " %04x", w);
                }
                MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
            }
        }
    }
    // PRNG-pool watchpoint (boot-title-wedge): 0x8c004184 is the PRNG entry;
    // r4 = state pointer (index at [r4], pool follows). Dump 60 words on the
    // FIRST call (post-seed-init, pre-regen). Compared JIT vs interp, the
    // first divergent pool word says born-wrong (seed init) vs drifts-wrong
    // (regen). JIT path only (interp mirrors below).
    {
        static bool s_pool_done = false;
        if (next_pc == 0x8c004184u && !s_pool_done) {
            s_pool_done = true;
            const u32 sp = ctx->r[4];
            char buf[640];
            MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[pool JIT] state=0x'+($0>>>0).toString(16)}); }, (int)sp);
            for (int line = 0; line < 4; line++) {
                int off = snprintf(buf, sizeof(buf), "[pool JIT %d]", line * 15);
                for (int i = 0; i < 15; i++) {
                    u32 w = 0; try { w = ReadMem32(sp + (line * 15 + i) * 4); } catch (...) {}
                    off += snprintf(buf + off, sizeof(buf) - off, " %08x", w);
                }
                MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
            }
        }
    }
    // Keystream watchpoint (boot-title-wedge): 0x8c00415e is the instr right
    // after the PRNG bsr returns — R0 holds the keystream word about to XOR
    // the payload. JIT output = input-unchanged ⇒ keystream==0 suspected.
    // Capture the first 12 draws + the payload word (R2 at @R14). Both arms.
    {
        static int s_ks_hits = 0;
        if (next_pc == 0x8c00415eu && s_ks_hits < 12) {
            ++s_ks_hits;
            MAIN_THREAD_EM_ASM({
                postMessage({cmd:'print', txt:'[keystream #' + ($0|0) + '] r0(ks)=0x' +
                    ($1>>>0).toString(16) + ' r2(word)=0x' + ($2>>>0).toString(16) +
                    ' r13(i)=' + ($3>>>0) + ' r12(n)=' + ($4>>>0) +
                    ' r14=0x' + ($5>>>0).toString(16)});
            }, s_ks_hits, (int)ctx->r[0], (int)ctx->r[2], (int)ctx->r[13],
               (int)ctx->r[12], (int)ctx->r[14]);
        }
    }
    // One-shot escape-edge dump (RELEASE-safe, ORDER 19a §3 verification).
    // Since honest cycle crediting, interrupts actually DELIVER for the
    // first time; the first observed failure was the guest executing from
    // pc=0x205f6654 (register space). This names the exact edge: the last
    // legal block and the first wild target, plus the interrupt state
    // (spc/ssr/sr/pend) that distinguishes a mid-block-vector clobber from
    // a plain bad emitted branch. Cost: one compare + one static store per
    // dispatch; the dump fires once.
    {
        static u32 s_escape_prev_pc = 0;
        static bool s_escape_dumped = false;
        // Bootstrap2 entry ring: native NEVER executes 0x8c0084xx (it visits
        // 0x8c0084f0 only) — record who jumps INTO the region (8 prev→entry
        // pairs). The entry edge is the true divergence point.
        static u32 s_b2_pairs[16];
        static u32 s_b2_idx = 0;
        if ((next_pc & 0x1FFFFF00u) == 0x0C008400u &&
            (s_escape_prev_pc & 0x1FFFFF00u) != 0x0C008400u) {
            s_b2_pairs[(s_b2_idx * 2) & 15]     = s_escape_prev_pc;
            s_b2_pairs[(s_b2_idx * 2 + 1) & 15] = next_pc;
            s_b2_idx++;
        }
        const u32 paddr = next_pc & 0x1FFFFFFFu;
        const bool legal = (paddr < 0x00200000u) ||                     // BIOS
                           ((paddr & 0x1C000000u) == 0x0C000000u);      // RAM
        if (!legal && !s_escape_dumped) {
            s_escape_dumped = true;
            MAIN_THREAD_EM_ASM({
                postMessage({cmd:'print', txt:'[escape-edge] prev_pc=0x' +
                    ($0>>>0).toString(16) + ' -> wild_pc=0x' + ($1>>>0).toString(16) +
                    ' spc=0x' + ($2>>>0).toString(16) + ' ssr=0x' + ($3>>>0).toString(16) +
                    ' sr=0x' + ($4>>>0).toString(16) + ' vbr=0x' + ($5>>>0).toString(16) +
                    ' pend=0x' + ($6>>>0).toString(16) + ' pr=0x' + ($7>>>0).toString(16) +
                    ' r15=0x' + ($8>>>0).toString(16)});
            }, (int)s_escape_prev_pc, (int)next_pc, (int)ctx->spc, (int)ctx->ssr,
               (int)ctx->sr.getFull(), (int)ctx->vbr, (int)ctx->interrupt_pend,
               (int)ctx->pr, (int)ctx->r[15]);
            // Code + register census at the escape site: 16 SH4 words around
            // prev_pc (disassemble with dreamcast/tools/sh4dis.py) and the
            // full GPR file — the jsr operand register names the callback
            // table this jump went through.
            {
                char buf[512];
                int off = 0;
                const u32 base = (s_escape_prev_pc - 96) & ~1u;
                off += snprintf(buf + off, sizeof(buf) - off, "[escape-code] base=0x%08x words:", base);
                for (int i = 0; i < 56 && off < (int)sizeof(buf) - 8; i++)
                    off += snprintf(buf + off, sizeof(buf) - off, " %04x", ReadMem16(base + i * 2) & 0xFFFF);
                MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
                off = 0;
                off += snprintf(buf + off, sizeof(buf) - off, "[escape-regs]");
                for (int i = 0; i < 16 && off < (int)sizeof(buf) - 16; i++)
                    off += snprintf(buf + off, sizeof(buf) - off, " r%d=%08x", i, ctx->r[i]);
                MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
            }
            // The 1ST_READ header region the bootstrap jump reads its entry
            // from ([0x8c01002c]) — shows whether the loader syscalls ever
            // landed the binary.
            {
                char buf[512];
                int off = snprintf(buf, sizeof(buf), "[escape-1stread] base=0x8c010000 words:");
                for (int i = 0; i < 32 && off < (int)sizeof(buf) - 8; i++)
                    off += snprintf(buf + off, sizeof(buf) - off, " %04x", ReadMem16(0x8c010000u + i * 2) & 0xFFFF);
                MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
            }
            {
                char buf[512];
                int off = snprintf(buf, sizeof(buf), "[b2-entries] n=%u pairs:", s_b2_idx);
                for (u32 i = 0; i < 8 && off < (int)sizeof(buf) - 24; i++)
                    off += snprintf(buf + off, sizeof(buf) - off, " %08x->%08x",
                                    s_b2_pairs[(i * 2) & 15], s_b2_pairs[(i * 2 + 1) & 15]);
                MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
            }
            // Flush whatever ISR trajectory was captured up to the escape.
            isr_trace_flush(ctx);
        }
        s_escape_prev_pc = next_pc;
    }
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
// ---------------------------------------------------------------------------
// THE SLICE CREDIT, ONE COPY (2026-10-14). The dispatcher used to inline this
// loop; it is now also run from INSIDE emitted code (sh4_slice_end below), so
// both callers share this function and cannot drift. Returns nonzero if any
// pass vectored an interrupt.
// ---------------------------------------------------------------------------
volatile uint32_t g_slice_credited = 0;   // sh4_slice_end credited since the dispatcher last looked
static inline int credit_slices(Sh4Context* ctx) {
	int any = 0;
	do {
		if (g_pch_on) pch_sample(ctx->pc);
			ctx->cycle_counter += SH4_TIMESLICE;
			// DIAGNOSTIC (boot-title-wedge, strip after verdict):
			// suppress interrupt VECTORING while pc is inside the
			// DP decrypt routine (0x8c004100-0x8c00425f). The
			// scheduler still ticks and pend stays latched —
			// delivery resumes on the first drain outside the
			// range. The JIT arm's XOR keystream corrupts
			// nondeterministically, interrupt-correlated; if this
			// window makes the decrypt output correct and
			// deterministic, vector-time state preservation under
			// the JIT is convicted.
			int vectored;
			{
				const u32 dpc = ctx->pc;
				const bool in_decrypt =
					dpc >= 0x8c004100u && dpc < 0x8c004260u;
				Sh4cntx.sh4_sched_next -= SH4_TIMESLICE;
				if (Sh4cntx.sh4_sched_next < 0) {
					// Lever-12 bucket [1]: ALL sh4_sched device
					// callbacks. See the g_attr_sched_ms block near
					// the top of this file for what this covers and
					// what it deliberately does not (the renderer is
					// NOT here -- it is on the guest store path).
					// [2026-08-29] LEVER13_SCHED_TIMER: this pair fired
					// 21,378 times/s and was 3.91% of ALL worker self
					// time in the CDP profile. Default 0 keeps the
					// COUNT (which is load-robust and is what the
					// scene-identity controls are read from) and
					// drops only the clock reads. See the
					// LEVER13_SCHED_TIMER block by g_attr_sched_ms.
#if LEVER13_SCHED_TIMER
					const double t_sched = emscripten_get_now();
					sh4_sched_tick(SH4_TIMESLICE);
					const double d_sched = emscripten_get_now() - t_sched;
					g_attr_sched_ms += d_sched;
					if (d_sched >= SCHED_FAT_MS) {
						g_attr_schedfat_ms += d_sched;
						++g_attr_schedfat_n;
					}
#else
					sh4_sched_tick(SH4_TIMESLICE);
#endif
					++g_attr_sched_n;
					++g_dbg_sched_ticks;
				}
				// ORDER 21b — recompute the SR interrupt gate against LIVE
				// sr before this deferred (slice-boundary) delivery. Native
				// emits UpdateSR (-> SRdecode) THEN UpdateINTC at each block
				// end (rec_x64.cpp:296,530); our crediting-loop delivery read a
				// STALE Sh4cntx.interrupt_pend and so delivered a level-4 Maple
				// IRQ while the guest ran at SR.IMASK=15 (ssr=0x400000f0, a
				// masked bootstrap critical section), vectoring to the still-
				// unfilled reios vector vbr+0x600=0x8c000600 (all 0xFF) and
				// livelocking (Do_Interrupt sets BL=1, no valid RTE; veccnt
				// frozen at 40878, pc pinned). SRdecode() recomputes
				// decoded_srimask = ~InterruptLevelBit[sr.IMASK] (0 when sr.BL)
				// + recalc_pending_itrs (sh4_interrupts.cpp:142-151): at
				// IMASK=15 interrupt_pend -> 0 (held PENDING, not delivered);
				// at IMASK=0 it stays permissive, so no regression.
				SRdecode();
				vectored = (Sh4cntx.interrupt_pend && !in_decrypt)
					? UpdateINTC() : 0;
				if (vectored) ++g_dbg_vec_count;
				// DIAG: reliable committed snapshot at the delivery gate.
				++g_dbg_credit_runs;
				// Lever-4 task 6: parity-gate rolling state hash.
				if (g_parity_hashing) {
					u32 h = g_parity_hash;
					#define PMIX(v) do { h ^= (u32)(v); h *= 16777619u; } while (0)
					PMIX(ctx->pc); PMIX(ctx->sr.getFull()); PMIX(ctx->pr);
					PMIX(ctx->gbr); PMIX(ctx->vbr); PMIX(ctx->ssr); PMIX(ctx->spc);
					PMIX(ctx->mac.l); PMIX(ctx->mac.h);
					for (int i = 0; i < 16; i++) PMIX(ctx->r[i]);
					#undef PMIX
					g_parity_hash = h;
					++g_parity_passes;
				}
				g_dbg_sr_credit       = ctx->sr.getFull();
				g_dbg_pend_credit     = ctx->interrupt_pend;
				g_dbg_istnrm_credit   = SB_ISTNRM;
				g_dbg_pc_credit       = ctx->pc;
				g_dbg_schednext_credit = Sh4cntx.sh4_sched_next;
			}
			// Escape forensics v2: record every vector event —
			// spc + interrupt status/mask registers + trajectory
			// ring position. The fatal interrupt's bits diff
			// against the healthy first vector's.
			if (vectored) {
				VecEv& v = g_vec_ring[g_vec_ring_idx++ & 7];
				v.spc = ctx->spc;
				v.istnrm = SB_ISTNRM; v.istext = SB_ISTEXT;
				v.iml2 = SB_IML2NRM; v.iml4 = SB_IML4NRM;
				v.iml6 = SB_IML6NRM;
				v.ring_pos = g_pc_ring_idx;
			}
		any |= vectored;
	} while (ctx->cycle_counter <= 0);
	return any;
}

// SLICE END WITHOUT LEAVING WASM (2026-10-14). A block whose entry finds the
// timeslice spent (cycle_counter <= 0) used to store its PC and return to the
// C dispatcher, which credited the slice and then looked the SAME block up
// again: ~446K times a guest second at SH4_TIMESLICE 448 — dispatch_slice +
// jit_lookup + the trampoline were ~10% of the worker. With
// g_emit_slice_inwasm the block calls this instead and, unless something
// happened that the dispatcher must see, simply runs on.
// Returns 0 = credited, keep running this block; 1 = return PC to the dispatcher.
// The guest sees exactly what the dispatcher path produces: the same credit
// at the same guest point (the block's entry, PC already stored), and the
// dispatcher takes over whenever (a) the frame is over (CpuRunning false: the
// C loop owns the deterministic stop, so this does not credit at all), (b) an
// interrupt vectored (PC moved), or (c) the IC generation moved (a sched
// event wrote code: the dispatcher's verified lookup must run).
extern "C" EMSCRIPTEN_KEEPALIVE int sh4_slice_end(uint32_t vaddr) {
	Sh4Context* ctx = &Sh4cntx;
	if (!ctx->CpuRunning) return 1;
	const uint32_t gen0 = g_ic_generation;
	const int vec = credit_slices(ctx);
	g_slice_credited = 1;
	if (vec || !ctx->CpuRunning || g_ic_generation != gen0 || ctx->pc != vaddr) return 1;
	return 0;
}

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
		bemental_sh4_set_nolink_pc(g_gwff ? 0x8c032e5au : 0u);
		bemental_sh4_set_nolink_pc2(0x8c38d480u);   // every arm (flycast_set_pswff)
	}

	// -----------------------------------------------------------------------
	// ROLLBACK-MODE BATCH COMPILE (2026-10-15). Rollback mode installs every
	// block on its own (one WebAssembly.Module + Instance per block) so that a
	// block is live from its first execution and routing is a pure function of
	// guest state (no pending span-interpretation). That made the room start-up
	// refill 2.3x slower than sharded install: 6,245 blocks of the first lobby
	// frame in 1.48 s vs 0.31 s (dreamcast/docs/rollback/TASKS.md).
	//
	// Here a miss compiles its block WITH its static successors (BranchBlock /
	// NextBlock, breadth-first, up to g_rbb_cap blocks) into ONE module, and every
	// member is registered before the miss's block runs. Each member's body is
	// the per-block body (build_blocks_unlinked: no tail-link, no trace), so every
	// edge between members still goes through the verified lookup or the IC, as
	// between per-block installs. What per-block install would do differently,
	// and how each is closed:
	//  * it decodes a block at its first ENTRY; a member is decoded earlier.
	//    - Bytes: a member is registered with its checksum, and its first entry
	//      is a verified lookup (stale -> rollback-mode recompile), exactly as
	//      for any registered block.
	//    - FPU config: decode reads FPSCR.PR/SZ/RM and SR.FD. A member with an
	//      FPU op is UNCONFIRMED (s_block_fcfg) until its first entry, which
	//      confirms it or discards it for a recompile from live state.
	//    - Side effects of decoding: Setup raises guest exceptions for an odd
	//      pc, an MMU fault, FpuDisabled, or a fetch fault, and the decoder
	//      throws on a branch in a delay slot. Members are therefore taken only
	//      from main RAM, even pcs, with the MMU off and SR.FD clear, and after a
	//      pre-scan that rejects a delay-slot branch.
	//  * compilePC resets the whole cache when it compiles 0x8c0000e0,
	//    0xac010000 or 0xac008300: never members.
	//  * a member that would not register (probe limit) is dropped, never
	//    parked, so it is compiled on its first miss like any block.
	// Extra blocks in the table change no route: a block is either live or a
	// miss that compiles synchronously before it runs, in both models. The keep-
	// code load drops members per slot (unit 0: no member links another).
	// ?rbbatch=N sets the cap (worker URL); ?rbbatch=1 is per-block install.
	// -----------------------------------------------------------------------
	static bool rbb_scan_ok(u32 pc) {
		for (u32 i = 0; i < 512; i++, pc += 2) {
			if (!vaddr_in_ram(pc) || !vaddr_in_ram(pc + 2)) return false;
			const sh4_opcodelistentry* d = OpDesc[IReadMem16(pc)];
			if (!d) return false;
			if (d->SetPC()) {
				if (d->type & Delayslot) {
					const sh4_opcodelistentry* n = OpDesc[IReadMem16(pc + 2)];
					if (!n || n->SetPC()) return false;
				}
				return true;
			}
		}
		return true;
	}
	bool rbb_compile(RuntimeBlockInfo* head)
	{
		const u32 hv = head->vaddr;
		std::vector<RuntimeBlockInfo*> mem;
		mem.push_back(head);
		std::vector<u32> keys;   // RAM offset of every member: one FPCA entry each
		keys.push_back(hv & 0x00FFFFFEu);
		std::vector<u32> q;
		auto push = [&](RuntimeBlockInfo* r) {
			if (r->BranchBlock != NullAddress) q.push_back(r->BranchBlock);
			if (r->NextBlock != NullAddress) q.push_back(r->NextBlock);
		};
		push(head);
		for (size_t qi = 0; qi < q.size() && mem.size() < g_rbb_cap; qi++) {
			const u32 sv = q[qi];
			if ((sv & 1) || !vaddr_in_ram(sv)) continue;
			if (sv == 0x8c0000e0u || sv == 0xac010000u || sv == 0xac008300u) continue;
			const u32 key = sv & 0x00FFFFFEu;
			if (std::find(keys.begin(), keys.end(), key) != keys.end()) continue;
			if (bm_GetCodeByVAddr(sv) != (DynarecCodeEntryPtr)ngen_FailedToFindBlock) continue;
			if (s_unreg_len.count(sv)) continue;
			if (!rbb_scan_ok(sv)) continue;
			RuntimeBlockInfo* r = allocateBlock();
			if (!r->Setup(sv, Sh4cntx.fpscr)) { delete r; continue; }   // cannot fail on these pcs (see above)
			r->blockcheck_failures = 0;
			mem.push_back(r); keys.push_back(key);
			push(r);
		}
		if (mem.size() < 2) return false;   // nothing to batch: the per-block path is identical
		std::vector<u8> bytes = bemental::sh4::build_blocks_unlinked(mem);
		std::vector<u32> vaddrs;
		for (auto* r : mem) vaddrs.push_back(r->vaddr);
		const u32 fc = fcfg_now();
		s_cur_unit = 0;
		const int base = install_shard_tries((uintptr_t)bytes.data(), (int)bytes.size(), vaddrs.data(), (int)mem.size());
		if (base <= 0) {   // the head retries on its own module (the per-block path)
			for (size_t i = 1; i < mem.size(); i++) delete mem[i];
			return false;
		}
		++g_rbb_batches;
		for (size_t i = 0; i < mem.size(); i++) {
			RuntimeBlockInfo* r = mem[i];
			BlockFn fn = reinterpret_cast<BlockFn>(static_cast<uintptr_t>(base + (int)i));
			if (!jit_register(r->vaddr, fn, r->sh4_code_size)) {
				if (i == 0) { park_unregistered(r->vaddr, r->sh4_code_size); continue; }   // as the per-block path
				++g_rbb_dropped; delete r; continue;
			}
			if (i == 0) continue;   // compilePC adds the head to the block manager
			if (r->has_fpu_op) {
				const u32 h = jit_hash(r->vaddr);
				for (u32 k = 0; k < JIT_PROBE_LIMIT; k++) {
					const u32 slot = (h + k) & JIT_TABLE_MASK;
					if (s_block_pc[slot] == r->vaddr) { s_block_fcfg[slot] = fc; break; }
				}
			}
			if (g_gwff) gwff_learn(r);
			if (g_pswff) pswff_learn(r);
			r->code           = (DynarecCodeEntryPtr)(uintptr_t)r;
			r->host_code_size = 0;
			r->host_opcodes   = 0;
			bm_AddBlock(r);
			++g_rbb_members;
		}
		return true;
	}

	void compile(RuntimeBlockInfo* block, bool /*smc_checks*/, bool /*optimise*/) override
	{
		++g_compile_calls;
		if (g_gwff) gwff_learn(block);
		if (g_pswff) pswff_learn(block);
		if (g_jitfail_inject_n && ++s_compiles_since_reset == g_jitfail_inject_n) {
			s_jitfail_vaddr = block->vaddr;
			s_jitfail_left = g_jitfail_once ? 1u : 0xFFFFFFFFu;
		}
		// AN ALIAS IN THE BLOCK MANAGER. flycast's jump table is indexed by the
		// PHYSICAL address (FPCA: addr & 0x1FFFFFE), our table by vaddr, so the
		// P1 and P2 views of one code word (0x8c.. / 0xac..) share one FPCA entry.
		// A batch member compiled at one view, and then a miss at the other,
		// reaches compilePC with FPCA already claimed, and bm_AddBlock's verify
		// kills the worker (measured: Gauntlet's boot in rollback mode, miss at
		// 0x8c00d828). Per-block install never compiles a view the guest did not
		// execute, so drop the alias: the miss compiles from live RAM, as it would
		// have without the member, and the alias recompiles on its own next miss.
		if (g_rb_mode && !mmu_enabled()) {
			DynarecCodeEntryPtr c = bm_GetCodeByVAddr(block->vaddr);
			if (c != (DynarecCodeEntryPtr)ngen_FailedToFindBlock) {
				RuntimeBlockInfo* o = (RuntimeBlockInfo*)(void*)c;
				const u32 ov = o->vaddr, h = jit_hash(ov);
				bool done = false;
				for (u32 k = 0; k < JIT_PROBE_LIMIT && !done; k++) {
					const u32 slot = (h + k) & JIT_TABLE_MASK;
					if (s_block_pc[slot] == ov) { rb_discard_slot(slot); done = true; }
					else if (s_block_pc[slot] == 0) break;
				}
				if (bm_GetCodeByVAddr(block->vaddr) != (DynarecCodeEntryPtr)ngen_FailedToFindBlock) bm_DiscardBlock(o);
				++g_rbb_alias_drops;
			}
		}
		if (g_rb_mode && !s_shard_enabled && g_rbb_cap > 1 && !mmu_enabled() && !Sh4cntx.sr.FD &&
		    vaddr_in_ram(block->vaddr) && rbb_compile(block)) {
			block->code           = (DynarecCodeEntryPtr)(uintptr_t)block;
			block->host_code_size = 0;
			block->host_opcodes   = 0;
			return;
		}
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
			if (s_pending_vaddrs.insert(vaddr).second) {
				s_pending_len[vaddr] = block->sh4_code_size;
				s_pending_shard.push_back(block);
			} else {
				// Already pending — still set the sentinel so flycast doesn't die().
				block->code           = (DynarecCodeEntryPtr)(uintptr_t)block;
				block->host_code_size = 0;
				block->host_opcodes   = 0;
				return;
			}
			if (s_pending_shard.size() >= SHARD_BLOCK_CAP) {
				seal_pending_shard();
			} else {
				// 6D: g_cb_disp_count only ticks under DEBUG_DISPATCH — in
				// RELEASE the old fallback NEVER fired (zero seals, the whole
				// game span-interpreted at fps 15). Use the unconditional
				// dispatch counter, and a 100K threshold: with the pending
				// dedup + span-interp flow, re-seal storms are structurally
				// impossible, so the old churn concern is gone.
				if (s_dispatch_count - s_dispatches_at_last_seal >= 100000) {
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
		// Spin blocks (the JIT-non-termination wedge): the interpreter completes
		// this init loop nest and proceeds to game code; the JIT cycles here
		// forever. Dump their emitted wasm to find the loop-exit codegen bug.
		static bool s_dumped_target5 = false;  // 0x8c02c16a inner spin block
		static bool s_dumped_target6 = false;  // 0x8c02139e outer-loop spin block
		static bool s_dumped_target7 = false;  // 0x8c02116c
		static bool s_dumped_target8 = false;  // 0x8c00851e
		static bool s_dumped_target9 = false;  // 0xac008300 (P2) state-diff first-divergent block
		static bool s_dumped_target10 = false; // 0x8c02ab54 counter block (add #1,r13; cmp/ge; bf/s)
		// Codegen-quality corpus (lever-10 follow-on): the SDK fast-memcpy
		// self-loops — 8-byte fmov.d variant and 4-byte mov.l variant.
		static bool s_dumped_target11 = false; // 0x8c3c2eb0 fmov.d copy loop (SZ=1)
		static bool s_dumped_target12 = false; // 0x8c3c2ec0 mov.l copy loop
		const bool dump_now =
			(!s_dumped_target1 && vaddr == 0x8c0133f4u) ||
			(!s_dumped_target2 && vaddr == 0x8c02ab4cu) ||
			(!s_dumped_target3 && vaddr == 0x8c02c160u) ||
			(!s_dumped_target4 && vaddr == 0x8c01a494u) ||
			(!s_dumped_target5 && vaddr == 0x8c02c16au) ||
			(!s_dumped_target6 && vaddr == 0x8c02139eu) ||
			(!s_dumped_target7 && vaddr == 0x8c02116cu) ||
			(!s_dumped_target8 && vaddr == 0x8c00851eu) ||
			(!s_dumped_target9 && vaddr == 0xac008300u) ||
			(!s_dumped_target10 && vaddr == 0x8c02ab54u) ||
			(!s_dumped_target11 && vaddr == 0x8c3c2eb0u) ||
			(!s_dumped_target12 && vaddr == 0x8c3c2ec0u);
		if (dump_now) {
			if (vaddr == 0x8c0133f4u) s_dumped_target1 = true;
			if (vaddr == 0x8c02ab4cu) s_dumped_target2 = true;
			if (vaddr == 0x8c02c160u) s_dumped_target3 = true;
			if (vaddr == 0x8c01a494u) s_dumped_target4 = true;
			if (vaddr == 0x8c02c16au) s_dumped_target5 = true;
			if (vaddr == 0x8c02139eu) s_dumped_target6 = true;
			if (vaddr == 0x8c02116cu) s_dumped_target7 = true;
			if (vaddr == 0x8c00851eu) s_dumped_target8 = true;
			if (vaddr == 0xac008300u) s_dumped_target9 = true;
			if (vaddr == 0x8c02ab54u) s_dumped_target10 = true;
			if (vaddr == 0x8c3c2eb0u) s_dumped_target11 = true;
			if (vaddr == 0x8c3c2ec0u) s_dumped_target12 = true;
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
		int idx = install_block_tries((uintptr_t)bytes.data(),
		                              (int)bytes.size(), vaddr);
		if (idx > 0) {
			// On wasm32, casting a table index to a function pointer is
			// the canonical way to obtain a callable funcref — `BlockFn`
			// matches the (i32 ctx, i32 ram_base) -> i32 ABI of the
			// emitted "run" export. The reverse cast happens implicitly
			// in `call_indirect` lowering.
			BlockFn fn = reinterpret_cast<BlockFn>(static_cast<uintptr_t>(idx));
			if (!jit_register(vaddr, fn, block->sh4_code_size)) {
				// Probe-limit hit. The block is installed in the wasmTable
				// but unreachable via jit_lookup, and bm_AddBlock is about to
				// claim FPCA(vaddr) for it — so "the next dispatch tries
				// again" would recompile and trip
				// verify(bm_GetCode(addr) == ngen_FailedToFindBlock)
				// (blockmanager.cpp:288) -> os_DebugBreak. Park it so the
				// dispatcher span-interprets it instead (the miss path checks
				// the park map in per-block mode too).
				park_unregistered(vaddr, block->sh4_code_size);
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
			// install_block FAILED (idx <= 0): flycast_install_block threw —
			// on a phone the first thing to throw is the per-block
			// WebAssembly.Module/Instance spray itself (one live Module +
			// Instance per compiled block, ~12K at boot scale, every one
			// pinned in flycast_table_slots). This block is UNREACHABLE, yet
			// block->code is set at the bottom of compile() and compilePC
			// then calls bm_AddBlock (driver.cpp:202), which claims
			// FPCA(vaddr) (blockmanager.cpp:290). Logging alone left the next
			// dispatch to re-enter compilePC for this pc and die on
			// verify(bm_GetCode(addr) == ngen_FailedToFindBlock)
			// (blockmanager.cpp:288) -> os_DebugBreak. Park it: the miss path
			// span-interprets it from live RAM instead. Same treatment as the
			// probe-limit arm above and as both shard-seal arms.
			park_unregistered(vaddr, block->sh4_code_size);
			jit_declare_park(vaddr);
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
		if (((vaddr >> 28) == 0x8 || (vaddr >> 28) == 0xa) && (vaddr & 0x0FF00000) >= 0x0C000000 &&
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
		// DO NOT jit_clear() here. Sh4Dynarec::reset() is invoked from
		// flycast bm_ResetCache() (blockmanager.cpp:398), which immediately
		// AFTER us resets FPCA and then RELINKS every surviving block in
		// blkmap back into FPCA (blockmanager.cpp:399-409). flycast's reset
		// only compacts ITS code buffer; our compiled blocks live in the
		// shared wasmTable and survive it — their vaddr->index mapping is
		// still valid. Wiping the jit shadow here desynced us from the
		// relinked FPCA: jit_lookup missed -> recompile -> bm_AddBlock's
		// verify(FPCA==ngen_FailedToFindBlock) failed -> os_DebugBreak (a
		// [[noreturn]] worker kill) ~1692 blocks into boot. Keeping the
		// shadow keeps jit and FPCA in sync across the code-buffer reset.
		//
		// [verified 2026-08-28, source read] the sentence above about flycast
		// "RELINKS every surviving block in blkmap back into FPCA" does not
		// match the current tree: bm_ResetCache's post-reset loop
		// (blockmanager.cpp:401-414) calls block->Relink() + block->Discard()
		// and clears blkmap, and NEITHER writes FPCA — the base
		// RuntimeBlockInfo::Relink is `return 0` (blockmanager.h:58-60) and
		// nothing else in that loop touches the table. What DOES happen is
		// addrspace::bm_reset() at blockmanager.cpp:399: under emscripten
		// virtmem::init returns false before writing its out-param
		// (posix_vmem.cpp:167-171), so ram_base stays null and bm_reset takes
		// the bm_vmem_pagefill branch (addrspace.cpp:350-355), which sets
		// EVERY fpcb entry to ngen_FailedToFindBlock (blockmanager.cpp:339-345)
		// — the whole table, not a subset. So after this call NO address is
		// claimed, and clearing the park maps below is CORRECT: a recompile of
		// a formerly-parked vaddr now passes bm_AddBlock's verify. Do not
		// "fix" that by making parks survive reset; that would only strand
		// blocks in the interpreter forever.
		//
		// F1 — Discard any pending un-sealed shard. The RuntimeBlockInfo*
		// pointers in s_pending_shard are owned by the block manager which
		// is also resetting; holding them past this point would be UAF.
		s_pending_shard.clear();
		s_pending_vaddrs.clear();
		s_pending_len.clear();
		s_unreg_len.clear();
		// ---- LOCKSTEP DETERMINISM (2026-09-08) ----------------------------
		// WAS: s_dispatches_at_last_seal = 0. That is the seal-phase
		// ASYMMETRY. s_dispatch_count (:691) is a process-lifetime counter
		// reset NOWHERE, so zeroing only the baseline makes the fallback seal
		// test at :2125
		//     s_dispatch_count - s_dispatches_at_last_seal >= SHARD_DISPATCH_SEAL
		// INSTANTLY TRUE in an instance with history (it seals a shard of one
		// on the very next compiled block) and FALSE in a fresh one (which
		// accumulates up to SHARD_BLOCK_CAP first). Two peers restoring
		// identical bytes therefore route the same block down different paths
		// — one compiled, one span-interpreted — and the two routes charge
		// different guest cycles. Anchoring the baseline to the live counter
		// makes the delta start at 0 in BOTH, so the seal schedule is a pure
		// function of guest execution.
		s_dispatches_at_last_seal = s_dispatch_count;
		s_pending_interp = 0;
		s_compiles_since_reset = 0;   // ?jitfailinject ordinal restarts with the table
		// ROLLBACK DETERMINISM (patch 0001): the idle-skip streak is host
		// history no savestate carries. Zero it on every reset so a restore
		// starts the progress bound from the same phase on every run/peer.
		s_isk_streak = 0;
		// And drop the block shadow, so a peer with history and a fresh peer
		// begin with the SAME (empty) block table and compile in the same
		// guest order. Safe here specifically because flycast's bm_reset ran
		// immediately before us and set EVERY fpcb entry to
		// ngen_FailedToFindBlock (addrspace.cpp:350-355 via the
		// bm_vmem_pagefill branch — verified 2026-08-28 in the note above), so
		// no address is claimed and a recompile of any vaddr now passes
		// bm_AddBlock's verify. This is what makes ROUTING deterministic
		// without repricing either route — no cycle accounting is touched, so
		// unlike the reverted 5d81938a it carries no guest-rate risk.
		jit_clear();
		// Lever-4: the block table survives (above), but flycast just reset
		// its code buffer — conservatively invalidate every IC entry; the
		// C-probe path refills them against the relinked state.
		// Ledger [6] -- administrative, NOT guest SMC. See g_smc_mark_counts.
		if (g_ic_generation) { ++g_ic_generation; ++g_smc_gen_accounted; ++g_smc_mark_counts[6]; }
	}

	// Lever-6B: the dispatch loop lives OUTSIDE any lexical try/catch so its
	// calls (trampoline, sched, EM_ASM shims) compile to DIRECT wasm calls
	// instead of emscripten-EH invoke_* thunks (wasm->JS->wasm per call). An
	// SH4ThrownException raised inside still unwinds through this frame to
	// mainloop's catch. noinline keeps the compiler from re-inlining it into
	// the try region and resurrecting the invokes.
	__attribute__((noinline)) static void dispatch_slice(Sh4Context* ctx)
	{
		// A STOP ENDS THE FRAME AT A SLICE BOUNDARY, NEVER MID-SLICE, when the
		// trajectory must be a pure function of guest state (g_deterministic:
		// rollback mode). Sh4Executor::Stop() (the PVR present that ends a
		// frame) only clears CpuRunning; this loop sees it the next time a block
		// returns to C. A chained edge does not return to C, a cold edge (target
		// not compiled yet) does — so WHERE the frame ended, and therefore the
		// guest cycle at which the next frame's pads were applied, depended on
		// what this console had compiled. Measured: cold vs warm cache from one
		// state, same pads: frame 0 = 6672302 vs 6672750 cycles (one 448-cycle
		// slice), credit-pass traces identical up to the cold run's early exit.
		// Under g_deterministic the loop runs on to the end of the slice in which
		// the stop landed (the point a fully-chained run reaches), credits it,
		// and only then exits.
		bool det_credited = true;   // entry with CpuRunning already false: exit
		while (ctx->CpuRunning || (g_deterministic && !det_credited)) {
				det_credited = false;

				++s_dispatch_count;
				// TEST: periodic IC flush — bounds SMC-staleness when cond/static
				// exits use the IC (which skips jit_lookup's ram_code_sum verify).
				// Ledger [7] -- inert at the shipped default (g_ic_flush_mask == 0).
				if (g_ic_flush_mask && g_ic_generation &&
				    (s_dispatch_count % g_ic_flush_mask) == 0) {
					++g_ic_generation; ++g_smc_gen_accounted; ++g_smc_mark_counts[7];
				}
				// Frame watchdog (boot-title-wedge, RELEASE-safe): a single
				// run_iter that never completes a frame freezes the worker
				// (no vblank → CpuRunning never clears). Every 262144
				// dispatches check wall-time; if this run_iter has run > 2s,
				// dump the stuck pc + interrupt state and force the frame to
				// end so telemetry resumes and the next run_iter re-enters.
				// Lever-4 D2: the watchdog converts host wall-clock into guest
				// trajectory (frames truncated at wall-dependent points — the
				// parity drift's primary source per the static audit).
				// SUSPENDED while a parity arm hashes; replay frames run to
				// natural completion instead.
				if ((s_dispatch_count & 0x3FFFF) == 0 && !g_parity_hashing && !g_deterministic) {
					static double s_wd_start = 0.0;
					static uint64_t s_wd_last = 0;
					static uint32_t s_wd_gen = 0;
					const double now = emscripten_get_now();
					if (s_wd_last == 0 || s_dispatch_count - s_wd_last > 0x100000 ||
					    s_wd_gen != g_wd_iter_gen) {
						s_wd_start = now; s_wd_last = s_dispatch_count;
						s_wd_gen = g_wd_iter_gen;
					} else if (now - s_wd_start > 2000.0) {
						static int s_wd_fired = 0;
						if (s_wd_fired < 6) {
							++s_wd_fired;
							MAIN_THREAD_EM_ASM({
								postMessage({cmd:'print', txt:'[watchdog #'+($0|0)+'] stuck pc=0x'+($1>>>0).toString(16)+
									' istnrm=0x'+($2>>>0).toString(16)+' istext=0x'+($3>>>0).toString(16)+
									' pend=0x'+($4>>>0).toString(16)+' sr=0x'+($5>>>0).toString(16)+
									' pr=0x'+($6>>>0).toString(16)});
							}, s_wd_fired, (int)ctx->pc, (int)SB_ISTNRM, (int)SB_ISTEXT,
							   (int)ctx->interrupt_pend, (int)ctx->sr.getFull(), (int)ctx->pr);
						}
						s_wd_start = now; s_wd_last = s_dispatch_count;
						ctx->CpuRunning = false;   // break the hang; next run_iter re-enters
					}
				}
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
					// Holly interrupt-state at wedge — distinguishes
					// "raise never fired" (ISTNRM=0) from "raise fired but
					// SR.IMASK blocked" (ISTNRM&IML4NRM nonzero, ctx pend=0).
					const u32 hi_istnrm = SB_ISTNRM;
					const u32 hi_istext = SB_ISTEXT;
					const u32 hi_iml4n  = SB_IML4NRM;
					const u32 hi_iml4e  = SB_IML4EXT;
					MAIN_THREAD_EM_ASM({
						postMessage({cmd: 'print', txt:
							'[flycast-worker]   ... istnrm=0x' + ($0 >>> 0).toString(16) +
							' istext=0x' + ($1 >>> 0).toString(16) +
							' iml4nrm=0x' + ($2 >>> 0).toString(16) +
							' iml4ext=0x' + ($3 >>> 0).toString(16)});
					}, (int)hi_istnrm, (int)hi_istext, (int)hi_iml4n, (int)hi_iml4e);
					// PR (link register), r4/r5 (memcpy src/dst args), r13 (outer
					// loop counter), r12 (outer loop limit). The wedge PC is rts;
					// PR points at the caller's next insn.
					MAIN_THREAD_EM_ASM({
						postMessage({cmd: 'print', txt:
							'[flycast-worker]   ... pr=0x' + ($0 >>> 0).toString(16) +
							' r4=0x' + ($1 >>> 0).toString(16) +
							' r5=0x' + ($2 >>> 0).toString(16) +
							' r13=0x' + ($3 >>> 0).toString(16) +
							' r12=0x' + ($4 >>> 0).toString(16)});
					}, (int)ctx->pr, (int)ctx->r[4], (int)ctx->r[5],
					   (int)ctx->r[13], (int)ctx->r[12]);
					s_last_logged_pc = pc_now;
				}
				// One-shot dump of the caller at 0x8c0215e0-0x8c021600.
				static bool s_caller_dump_fired = false;
				if (g_diag_enabled && !s_caller_dump_fired &&
				    s_dispatch_count > 100000 &&
				    ctx->pc == 0x8c02c16au) {
					s_caller_dump_fired = true;
					MAIN_THREAD_EM_ASM({
						postMessage({cmd: 'print', txt:
							'[caller-asm] fired at dispatch #' + ($0 >>> 0) +
							' pr=0x' + ($1 >>> 0).toString(16)});
					}, (int)s_dispatch_count, (int)ctx->pr);
					const u32 cbase = ctx->pr - 0x10;
					u16 cw[16];
					for (int i = 0; i < 16; i++) cw[i] = ReadMem16(cbase + i*2);
					MAIN_THREAD_EM_ASM({
						var hex = function(x){return ('0000'+(x>>>0).toString(16)).slice(-4);};
						postMessage({cmd: 'print', txt:
							'[caller-asm] +0x00: ' +
							hex($0)+' '+hex($1)+' '+hex($2)+' '+hex($3)+' '+
							hex($4)+' '+hex($5)+' '+hex($6)+' '+hex($7)});
					}, (int)cw[0],(int)cw[1],(int)cw[2],(int)cw[3],(int)cw[4],(int)cw[5],(int)cw[6],(int)cw[7]);
					MAIN_THREAD_EM_ASM({
						var hex = function(x){return ('0000'+(x>>>0).toString(16)).slice(-4);};
						postMessage({cmd: 'print', txt:
							'[caller-asm] +0x10: ' +
							hex($0)+' '+hex($1)+' '+hex($2)+' '+hex($3)+' '+
							hex($4)+' '+hex($5)+' '+hex($6)+' '+hex($7)});
					}, (int)cw[8],(int)cw[9],(int)cw[10],(int)cw[11],(int)cw[12],(int)cw[13],(int)cw[14],(int)cw[15]);
				}
				// One-shot disassembly dump of the 0x8c02c16a wedge block.
				// Loop reads 1 byte/dispatch from r14 (VRAM 0x05XXxxxx); we
				// need to know what termination/exit condition it expects.
				static bool s_wedge_dump_fired = false;
				if (g_diag_enabled && !s_wedge_dump_fired &&
				    ctx->pc >= 0x8c02c160u && ctx->pc < 0x8c02c180u) {
					s_wedge_dump_fired = true;
					const u32 base = 0x8c02c160u;
					u16 w[16];
					for (int i = 0; i < 16; i++) w[i] = ReadMem16(base + i*2);
					MAIN_THREAD_EM_ASM({
						var hex = function(x){return ('0000'+(x>>>0).toString(16)).slice(-4);};
						postMessage({cmd: 'print', txt:
							'[wedge-asm] 0x8c02c160: ' +
							hex($0)+' '+hex($1)+' '+hex($2)+' '+hex($3)+' '+
							hex($4)+' '+hex($5)+' '+hex($6)+' '+hex($7)});
						postMessage({cmd: 'print', txt:
							'[wedge-asm] 0x8c02c170: ' +
							hex($8)+' '+hex($9)+' '+hex($10)+' '+hex($11)+' '+
							hex($12)+' '+hex($13)+' '+hex($14)+' '+hex($15)});
					}, (int)w[0],(int)w[1],(int)w[2],(int)w[3],(int)w[4],(int)w[5],(int)w[6],(int)w[7],
					   (int)w[8],(int)w[9],(int)w[10],(int)w[11],(int)w[12],(int)w[13],(int)w[14],(int)w[15]);
					// Dump current VRAM bytes the poll is scanning, so we can
					// see whether the DMA target buffer is actually zero or
					// nonzero where r14 is pointing.
					const u32 vaddr = ctx->r[14] & 0x1FFFFFFFu;
					u8 vb[16];
					for (int i = 0; i < 16; i++) vb[i] = ReadMem8(vaddr + i);
					// NOTE: MAIN_THREAD_EM_ASM's proxied arg marshaling caps at
					// 16 substituted args ($0..$15). Passing 17 ($0..$16) made
					// $16 a bare undefined identifier → "$16 is not defined"
					// thrown out of run_iter every time dispatch reached this
					// PC. Split across two postMessages, each <=9 args.
					MAIN_THREAD_EM_ASM({
						var hex2 = function(x){return ('00'+(x>>>0).toString(16)).slice(-2);};
						postMessage({cmd: 'print', txt:
							'[wedge-vram] 0x' + ($0 >>> 0).toString(16) + ': ' +
							hex2($1)+' '+hex2($2)+' '+hex2($3)+' '+hex2($4)+' '+
							hex2($5)+' '+hex2($6)+' '+hex2($7)+' '+hex2($8)});
					}, (int)vaddr,
					   (int)vb[0],(int)vb[1],(int)vb[2],(int)vb[3],(int)vb[4],(int)vb[5],(int)vb[6],(int)vb[7]);
					MAIN_THREAD_EM_ASM({
						var hex2 = function(x){return ('00'+(x>>>0).toString(16)).slice(-2);};
						postMessage({cmd: 'print', txt:
							'[wedge-vram] +8: ' +
							hex2($0)+' '+hex2($1)+' '+hex2($2)+' '+hex2($3)+' '+
							hex2($4)+' '+hex2($5)+' '+hex2($6)+' '+hex2($7)});
					}, (int)vb[8],(int)vb[9],(int)vb[10],(int)vb[11],
					   (int)vb[12],(int)vb[13],(int)vb[14],(int)vb[15]);
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
							// Full nonzero-bucket dump (raw addr>>26 — P1/P2/P4 mirrors land
							// in high buckets; the a0/a3/a4/a5 summary above only sees
							// masked-space areas and reads all-zero for mirror traffic).
							{
								static char areabuf[512];
								int off = 0;
								for (int i = 0; i < 64 && off < 440; ++i) {
									const uint64_t rv = g_cb_mem_read_by_area[i].load(std::memory_order_relaxed);
									const uint64_t wv = g_cb_mem_write_by_area[i].load(std::memory_order_relaxed);
									if (rv | wv)
										off += snprintf(areabuf + off, sizeof(areabuf) - off,
										                " b%d:r%llu/w%llu", i,
										                (unsigned long long)rv, (unsigned long long)wv);
								}
								areabuf[off] = 0;
								MAIN_THREAD_EM_ASM({
									postMessage({cmd:'print', txt:'[cost-breakdown]   mem_by_area_raw:' + UTF8ToString($0)});
								}, areabuf);
							}
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

					// [traj] First-seen block-entry trajectory: record each
					// DISTINCT block entry PC in execution order (no loop
					// repetition), so the full boot control-flow path fits in a
					// bounded buffer. Cheap (set lookup + push), no per-dispatch
					// proxy. Dumped once on the first transition into the spin
					// (0x8c02c16a). Diff vs the interpreter's trajectory => the
					// FIRST block where the JIT takes a different successor (the
					// divergent branch). The 256-ring was too short (divergence
					// is upstream of it), the dense trace too slow, sampler too
					// coarse.
					// State-diff: key by block-ENTRY pc (pc_after = the block
					// about to run), record an FNV hash of the architectural
					// state entering it. JIT & interp execute the same pcs in
					// the same order until they diverge, so the FIRST pc where
					// both ran it but the hashes differ = the first state
					// divergence (the prior block mis-computed something). Same
					// pc missing from one = a control-flow divergence.
					static std::unordered_set<u32> s_traj_seen;
					static std::vector<u32> s_traj_pc;
					static std::vector<u32> s_traj_hash;
					if (s_traj_pc.size() < 200000u && s_traj_seen.insert(pc_after).second) {
						u32 h = 2166136261u;
						for (int ri = 0; ri < 16; ri++) h = (h ^ ctx->r[ri]) * 16777619u;
						h = (h ^ ctx->sr.getFull()) * 16777619u;
						h = (h ^ ctx->pr)  * 16777619u;
						h = (h ^ ctx->gbr) * 16777619u;
						h = (h ^ ctx->vbr) * 16777619u;
						h = (h ^ ctx->mac.h) * 16777619u;
						h = (h ^ ctx->mac.l) * 16777619u;
						s_traj_pc.push_back(pc_after);
						s_traj_hash.push_back(h);
					}
					static bool s_traj_dumped = false;
					if (!s_traj_dumped && (pc_after == 0x8c02c16au || s_traj_pc.size() >= 4000u)) {
						s_traj_dumped = true;
						// Emit pc:hash pairs, 8 per line.
						std::string line; char tmp[24]; unsigned col = 0;
						for (size_t i = 0; i < s_traj_pc.size(); i++) {
							snprintf(tmp, sizeof(tmp), "%08x:%08x ", s_traj_pc[i], s_traj_hash[i]);
							line += tmp;
							if (++col == 8 || i + 1 == s_traj_pc.size()) {
								MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[traj] '+UTF8ToString($0)}); }, line.c_str());
								line.clear(); col = 0;
							}
						}
						MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[traj] count='+($0|0)}); }, (int)s_traj_pc.size());
					}

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
#elif defined(DISPATCH_MICROBENCH)
				// Clean per-dispatch cost (phase6 §2). ONE emscripten_get_now()
				// pair per 10k dispatches → measurement granularity ~0.5ns/disp,
				// versus the diag path's ~11 get_now()+samplers per dispatch.
				{
					static constexpr unsigned MBENCH_BATCH = 10000;
					static unsigned          mbench_n      = 0;
					static double            mbench_t0     = 0.0;
					static unsigned long     mbench_total  = 0;
					if (mbench_n == 0) mbench_t0 = emscripten_get_now();
					wasm_block_trampoline();
					if (++mbench_n == MBENCH_BATCH) {
						double dt_ms           = emscripten_get_now() - mbench_t0;
						double per_dispatch_us = (dt_ms * 1000.0) / (double)MBENCH_BATCH;
						mbench_total += MBENCH_BATCH;
						if ((mbench_total % 100000) == 0) {
							MAIN_THREAD_EM_ASM({
								postMessage({cmd: 'print', txt:
									'[mbench] per_dispatch_us=' + ($0).toFixed(3) +
									' blocks=' + ($1|0) +
									' cumulative=' + ($2|0)});
							}, per_dispatch_us, (int)s_block_count, (int)mbench_total);
						}
						mbench_n = 0;
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
				if (g_slice_credited) { g_slice_credited = 0; det_credited = true; }   // sh4_slice_end credited inside emitted code
				if (ctx->cycle_counter <= 0) {
					// ORDER 2026-08-19a §3 — honest cycle crediting (the
					// general fix). Tail-linked block chains drain
					// cycle_counter arbitrarily far below -SH4_TIMESLICE;
					// the old single refill credited exactly ONE 448-cycle
					// timeslice to sh4_sched per dispatcher visit and the
					// rest of the burn EVAPORATED. Everything scheduled on
					// sh4_sched starved in guest time — most fatally the
					// Reios GDROM HLE completion (gdrom_hle.cpp:238,
					// 1M-cycle ticks, 5 sectors/fire) that PSO's boot polls
					// on: at the measured ~240 credited timeslices/sec that
					// was ~9 wall-seconds PER FIRE, hundreds of fires per
					// load — effectively never. Credit every burned slice.
					credit_slices(ctx);
					// The wall-clock-gated SPG raise that lived here
					// (May 2026: SCANINT1/SCANINT2/HBLANK/MAPLE_VBOI forced
					// at wall-60Hz) is REMOVED, not tuned. It mixed wall
					// time into guest time — ~1800x too fast relative to
					// the starved guest clock — which distorted every boot
					// state machine, sent the trajectory down paths native
					// never executes, and made boot depth nondeterministic
					// under variable pump rates (the GC determinize-boot
					// lesson, ppc_worker.js:1933: fire device events on
					// GUEST CYCLES, never wall time; this exact band-aid is
					// cited there as the bug class). With honest crediting
					// the sched-driven spg_line_sched delivers VBlank at
					// true guest cadence (~1.5M cycles), and maple/TMU/GDROM
					// all ride the same clock. Do-not-keep list: wall-time
					// gates on device events.
					static u32 s_spg_tick = 0;
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
					det_credited = true;
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
		}
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
		// TRIPWIRE (2026-10-15): the executor's cached context must still be
		// the live Sh4RCB's. It was not when initMappings() re-allocated the
		// RCB under a cached pointer (addrspace.cpp termMappings) — boot then
		// ran a zeroed context from pc=0, which reads as a REIOS reboot loop
		// and appeared or vanished with unrelated layout changes. Say so.
		// Same for the buffer bases baked into the dispatcher and into every
		// compiled block (area-3 fast path, VRAM store fast path): they are
		// captured once and must stay the live mem_b / vram.
		if ((g_tw_ram_base && g_tw_ram_base != (uintptr_t)&mem_b[0]) ||
		    (bemental::sh4::g_vram_lin_base && bemental::sh4::g_vram_lin_base != (u32)(uintptr_t)&vram[0])) {
			static bool s_said_buf = false;
			if (!s_said_buf) {
				s_said_buf = true;
				MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[ctx-tripwire] FATAL: a cached guest-memory base is stale: RAM baked 0x' +
					($0>>>0).toString(16) + ' live 0x' + ($1>>>0).toString(16) + ', VRAM baked 0x' + ($2>>>0).toString(16) +
					' live 0x' + ($3>>>0).toString(16) + ' (see addrspace.cpp termMappings).'}); },
					(int)g_tw_ram_base, (int)(uintptr_t)&mem_b[0], (int)bemental::sh4::g_vram_lin_base, (int)(uintptr_t)&vram[0]);
			}
		}
		if (ctx != &Sh4cntx) {
			static bool s_said = false;
			if (!s_said) {
				s_said = true;
				MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[ctx-tripwire] FATAL: the SH4 executor caches context 0x' +
					($0>>>0).toString(16) + ' but p_sh4rcb->cntx is 0x' + ($1>>>0).toString(16) +
					' — a stale Sh4RCB pointer (see addrspace.cpp termMappings). Guest state is garbage.'}); },
					(int)(uintptr_t)ctx, (int)(uintptr_t)&Sh4cntx);
			}
		}

		// Lever-5 attribution (strip after verdict): accumulate this
		// invocation's wall into the SH4 bucket on ANY exit path.
		struct AttrScope {
			double t0;
			AttrScope() : t0(emscripten_get_now()) {}
			~AttrScope() { g_attr_mainloop_ms += emscripten_get_now() - t0; }
		} _attr_scope;


#ifdef DEBUG_DISPATCH
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
				dispatch_slice(ctx);
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

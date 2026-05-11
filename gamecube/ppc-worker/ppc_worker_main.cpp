// ppc_worker_main.cpp — entry shim for the dedicated PowerPC JIT worker.
//
// Phase 2a (foundation): ALL functions are stubs. The worker can be loaded,
// initialized, and called, but nothing actually dispatches yet — that is
// Phase 2c. This file's job is to prove the standalone bementalJIT WASM
// build works and the JS↔WASM interface is in place.
//
// Architecture target (per ppc_exterior_worker_2026_05_05.md):
//   - This worker hosts bementalJIT + a private BlockCache.
//   - PowerPCState, MEM1, and a small mailbox region live in
//     SharedArrayBuffer, mapped into BOTH this worker and dolphin_worker.
//   - Communication: SAB for high-rate state, postMessage for control.
//   - Phase 2c will wire dispatch; Phase 2d HLE callbacks; Phase 2e
//     exception delivery via Atomics.notify.

#include "bementalJIT/bemental.h"
#include "bementalJIT/block_cache.h"

#include <cstdio>
#include <cstdint>
#include <vector>

// gekko_emit.h is in the per-guest tree (not part of the public include/
// surface); declare the entries we use here. Default arguments are
// supplied at the call site.
namespace bemental::powerpc {
std::vector<u8> build_block(u32 start_pc, const u32* insts, u32 count,
                            u32 ctx_ptr_const, u32 mem_pages,
                            u32 mem1_base, u32 mem1_mask,
                            u32 ram_size,
                            const u32* instr_pcs,
                            bool emit_hle_check);
// Phase 3a.2 — emit just the function body (no module wrapper). Used by
// region_accumulate; the wrapper is built later at region_relink time.
// LocalIdxLookupFn = nullptr means branches that would target other
// region-local fns get baked as `set_pc + return` (slow path) on first
// emit; region_relink re-emits with the correct lookup_fn so they become
// `return_call_indirect` (lever #2). Signature matches gekko_emit.h:174.
using LocalIdxLookupFn = bool(*)(const void* user, u32 target_pc, u32* out_local_idx);
std::vector<u8> emit_block_body(u32 start_pc, const u32* insts, u32 count,
                                u32 ctx_ptr_const,
                                u32 mem1_base, u32 mem1_mask,
                                u32 ram_size,
                                const u32* instr_pcs,
                                LocalIdxLookupFn lookup_fn,
                                const void* lookup_user,
                                bool emit_hle_check);
}

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/atomic.h>
#endif

using namespace bemental;

// SAB-backed state pointers, set by ppc_worker_init(). All point INTO
// the shared heap (Emscripten's pthread heap is itself a SAB; under the
// Phase 2 design the PowerPCState portion is at a known offset and the
// JS side hands us that offset).
//
// PowerPCState SAB layout matches PowerPCState in Dolphin core. See
// bementalJIT/guests/powerpc/gekko_emit.h::ppc_off:: for canonical offsets.
//   0x000  PC (u32)
//   0x014  GPR_BASE  (32 × u32 → ends 0x094)
//   0x0A0  PS_BASE   (32 × 16B paired-singles → ends 0x2A0)
//   0x2A0  CR_BASE   (8 × u64 → ends 0x2E0)
//   0x2E0  MSR
//   0x2E4  FPSCR
//   0x2EC  EXCEPTIONS    (atomic — set by dolphin_worker, observed here)
//   0x2F0  DOWNCOUNT     (decremented by JIT, observed by dolphin's
//                         CoreTiming via SAB read)
//   0x340  SPR_BASE  (1024 × u32 → ends 0x1340)
// Total ~5 KB. We don't redefine the struct here — the JIT block cache
// emits writes/reads at these compile-time offsets relative to a base
// pointer we hand it.
static uintptr_t g_ppc_state_base = 0;
static uintptr_t g_mem1_base      = 0;
static u32       g_mem1_size      = 0;
static uintptr_t g_mailbox_base   = 0;

// Phase 3a.1 — link BlockCache into ppc-worker. Instance is private to
// this worker; dolphin's BlockCache lives in dolphin_worker. They do not
// share state at the C++ level (only the underlying SAB-mapped emulator
// state). Region-emit work in 3a.2-3a.7 calls methods on this instance.
// Declared at file scope (not inside extern "C") so it's visible to all
// translation units below it.
static BlockCache g_bcache;

extern "C" {

// init: wire up SAB pointers. Called once by the JS-side worker after
// it receives the SAB references via postMessage.
EMSCRIPTEN_KEEPALIVE
void ppc_worker_init(u32 ppc_state_addr,
                     u32 mem1_addr, u32 mem1_size,
                     u32 mailbox_addr) {
    g_ppc_state_base = ppc_state_addr;
    g_mem1_base      = mem1_addr;
    g_mem1_size      = mem1_size;
    g_mailbox_base   = mailbox_addr;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        console.log('[ppc-worker] init ppc_state=0x' + ($0>>>0).toString(16)
            + ' mem1=0x' + ($1>>>0).toString(16) + ' size=0x' + ($2>>>0).toString(16)
            + ' mailbox=0x' + ($3>>>0).toString(16));
    }, (u32)ppc_state_addr, (u32)mem1_addr, mem1_size, (u32)mailbox_addr);
#endif
}

// dispatch: stub. Phase 2c will wire actual block cache + dispatch.
// Returns input PC unchanged so any caller treating return-value as
// next-pc gets a no-op (dolphin_worker stays in charge until cutover).
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_dispatch(u32 pc) {
    return pc;
}

// Shared-memory verification probe. Reads a u32 at the given linear
// memory address and returns it. If the page wrote a sentinel into the
// SAB at this address, ppc-worker should read back the same value —
// proving the WebAssembly.Memory really is shared, not just two copies.
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_peek_u32(u32 addr) {
    return *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(addr));
}

// Companion poke for symmetric test from the ppc-worker side.
EMSCRIPTEN_KEEPALIVE
void ppc_worker_poke_u32(u32 addr, u32 value) {
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(addr)) = value;
}

// ---- Mailbox primitive (Phase 2c.4b — async one-way demo) ----
// 2c.4b ships only the simplest possible cross-worker write: ppc-worker
// pokes a sentinel into shared SAB at the mailbox address; page polls
// and verifies. No reply, no Atomics. Foundation for 2c.4c below.
EMSCRIPTEN_KEEPALIVE
void ppc_worker_mailbox_post_demo(u32 sentinel) {
    if (g_mailbox_base == 0u) return;
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(g_mailbox_base)) = sentinel;
}

// ---- Mailbox request-reply (Phase 2c.4c, extended in 2c.4f-1) ----
// Single-slot synchronous request-reply. Slot layout at g_mailbox_base:
//   +0  cmd          u32  ppc writes
//   +4  arg0         u32  ppc writes (typically address)
//   +8  arg1         u32  ppc writes (typically value, for writes)
//   +12 req_ready    u32  ppc sets 1 (publish), consumer resets to 0
//   +16 reply        u32  consumer writes
//   +20 reply_ready  u32  consumer sets 1, ppc Atomics.waits on it
//
// Consumer (dolphin_worker per Phase 2c.4e) polls req_ready in its
// inner-iter heartbeat, processes, writes reply, sets reply_ready,
// Atomics.notify.

constexpr u32 MBX_OFF_CMD         = 0;
constexpr u32 MBX_OFF_ARG0        = 4;
constexpr u32 MBX_OFF_ARG1        = 8;
constexpr u32 MBX_OFF_REQ_READY   = 12;
constexpr u32 MBX_OFF_REPLY       = 16;
constexpr u32 MBX_OFF_REPLY_READY = 20;

EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_mailbox_call_sync2(u32 cmd, u32 arg0, u32 arg1);

EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_mailbox_call_sync(u32 cmd, u32 arg0) {
    return ppc_worker_mailbox_call_sync2(cmd, arg0, 0u);
}

// MMIO wrappers. Cmd codes match sab_layout.h::MailboxCmd:
//   2 = Read8, 3 = Read16, 4 = Read32, 5 = Write8, 6 = Write16, 7 = Write32
EMSCRIPTEN_KEEPALIVE u32 ppc_worker_mmio_read8(u32 addr)  { return ppc_worker_mailbox_call_sync(2u, addr); }
EMSCRIPTEN_KEEPALIVE u32 ppc_worker_mmio_read16(u32 addr) { return ppc_worker_mailbox_call_sync(3u, addr); }
EMSCRIPTEN_KEEPALIVE u32 ppc_worker_mmio_read32(u32 addr) { return ppc_worker_mailbox_call_sync(4u, addr); }
EMSCRIPTEN_KEEPALIVE void ppc_worker_mmio_write8(u32 addr, u32 val)  { (void)ppc_worker_mailbox_call_sync2(5u, addr, val); }
EMSCRIPTEN_KEEPALIVE void ppc_worker_mmio_write16(u32 addr, u32 val) { (void)ppc_worker_mailbox_call_sync2(6u, addr, val); }
EMSCRIPTEN_KEEPALIVE void ppc_worker_mmio_write32(u32 addr, u32 val) { (void)ppc_worker_mailbox_call_sync2(7u, addr, val); }

EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_mailbox_call_sync2(u32 cmd, u32 arg0, u32 arg1) {
    if (g_mailbox_base == 0u) return 0u;
    u32* base = reinterpret_cast<u32*>(static_cast<uintptr_t>(g_mailbox_base));
    u32* p_cmd        = base + (MBX_OFF_CMD         / 4);
    u32* p_arg0       = base + (MBX_OFF_ARG0        / 4);
    u32* p_arg1       = base + (MBX_OFF_ARG1        / 4);
    u32* p_req_ready  = base + (MBX_OFF_REQ_READY   / 4);
    u32* p_reply      = base + (MBX_OFF_REPLY       / 4);
    u32* p_reply_ready = base + (MBX_OFF_REPLY_READY / 4);

    // Reset reply_ready so we can wait on transition 0→1.
    __atomic_store_n(p_reply_ready, 0u, __ATOMIC_RELEASE);
    // Write request fields.
    __atomic_store_n(p_cmd,  cmd,  __ATOMIC_RELAXED);
    __atomic_store_n(p_arg0, arg0, __ATOMIC_RELAXED);
    __atomic_store_n(p_arg1, arg1, __ATOMIC_RELAXED);
    // Publish: set req_ready=1; this is what the consumer polls/waits on.
    __atomic_store_n(p_req_ready, 1u, __ATOMIC_RELEASE);
    emscripten_atomic_notify(p_req_ready, 1);

    // Wait until reply_ready becomes non-zero. Bound the wait so a
    // consumer crash doesn't hang the worker forever.
    for (int i = 0; i < 100; ++i) {
        const u32 ready = __atomic_load_n(p_reply_ready, __ATOMIC_ACQUIRE);
        if (ready != 0u) break;
        emscripten_atomic_wait_u32(p_reply_ready, 0u, 100000000ll /* 100 ms */);
    }
    const u32 reply = __atomic_load_n(p_reply, __ATOMIC_ACQUIRE);
    // Consumer-acknowledged. Reset slot so consumer's next poll sees 0.
    __atomic_store_n(p_req_ready,  0u, __ATOMIC_RELEASE);
    __atomic_store_n(p_reply_ready, 0u, __ATOMIC_RELEASE);
    return reply;
}

// ---- Self-compile (Phase 2g) -----------------------------------------------
// ppc-worker reads instructions directly from SAB-mapped guest RAM (placed
// at g_mem1_base by ppc_worker_init) and calls bemental::powerpc::build_block
// without any round-trip to dolphin. Eliminates the proxy-call hang that
// blocked sustained dispatch under PROXY_TO_PTHREAD.
//
// PowerPC instructions live big-endian in guest RAM; host (wasm) is
// little-endian — byte-swap on read.
//
// Block-end heuristic: stop after ANY branch-class opcode (16 bc, 17 sc,
// 18 b/bl, 19 bclr/bcctr/rfi). This matches Dolphin's DecodeBlock for
// the common case; the chained-fall-through optimization (instr_pcs)
// is left for a later pass.

static constexpr u32 PPC_MAX_BLOCK_INSTRS = 64u;
static std::vector<u8> g_compile_buf;
static u32 g_compile_cycles = 0;

static inline u32 byteswap32(u32 v) {
    return (v >> 24) | ((v >> 8) & 0x0000FF00u) | ((v << 8) & 0x00FF0000u) | (v << 24);
}

EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_compile_block(u32 start_pc) {
    if (g_mem1_base == 0u || g_mem1_size == 0u) return 0u;
    // Translate guest virtual PC to SAB linear-memory address. MEM1 is
    // mirrored at 0x80000000 (cached) and 0x00000000 (real-mode); both
    // map to the same physical bytes via mask.
    const u32 ram_mask = g_mem1_size - 1u;  // assumes size is power-of-two
    const u32 phys     = start_pc & ram_mask;
    const uintptr_t ram_addr = g_mem1_base + phys;
    const u32* ram_ptr = reinterpret_cast<const u32*>(ram_addr);

    u32 insts[PPC_MAX_BLOCK_INSTRS];
    u32 count = 0;
    while (count < PPC_MAX_BLOCK_INSTRS) {
        const u32 raw_be = ram_ptr[count];
        const u32 inst   = byteswap32(raw_be);
        insts[count]     = inst;
        const u32 op     = (inst >> 26) & 0x3Fu;
        ++count;
        if (op == 16u || op == 17u || op == 18u || op == 19u) break;
    }
    if (count == 0u) return 0u;

    auto bytes = bemental::powerpc::build_block(
        start_pc, insts, count,
        /* ctx_ptr_const   = */ static_cast<u32>(g_ppc_state_base),
        /* mem_pages       = */ 0u,
        /* mem1_base       = */ static_cast<u32>(g_mem1_base),
        /* mem1_mask       = */ ram_mask,
        /* ram_size        = */ g_mem1_size,
        /* instr_pcs       = */ nullptr,
        /* emit_hle_check  = */ false);
    g_compile_buf  = std::move(bytes);
    g_compile_cycles = count;
    return static_cast<u32>(g_compile_buf.size());
}

// Phase 3a.2 — compile block AND accumulate into its region. Replaces
// the per-block standalone-module path (build_block + JS instantiate)
// with the multi-block region path (emit_block_body + region_accumulate;
// instantiate happens later at region_relink time).
//
// Caller (ppc_worker.js) treats this exactly like ppc_worker_compile_block
// for now — calls it on miss, gets back a body-byte size. The difference
// is that the body is parked in g_bcache; no module is yet runnable.
// Once 3a.3 wires region_relink_if_due() and 3a.4 wires region_dispatch
// fast-path, the second call to a same-PC block hits the relinked region
// module (one module per region, many blocks).
//
// Returns: number of bytes accumulated (= body size). 0 on failure or
// already-accumulated (idempotent — re-accumulating a known PC is a no-op
// per region_has_pc check).
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_compile_and_accumulate(u32 start_pc) {
    if (g_mem1_base == 0u || g_mem1_size == 0u) return 0u;

    const Region region = classify(start_pc);
    if (g_bcache.region_has_pc(region, start_pc)) {
        // Already accumulated; nothing to do.
        return 0u;
    }

    // Same decode loop as ppc_worker_compile_block — read guest RAM,
    // byte-swap PPC big-endian to native, terminate after first
    // branch-class opcode (16/17/18/19) or PPC_MAX_BLOCK_INSTRS.
    const u32 ram_mask = g_mem1_size - 1u;
    const u32 phys     = start_pc & ram_mask;
    const uintptr_t ram_addr = g_mem1_base + phys;
    const u32* ram_ptr = reinterpret_cast<const u32*>(ram_addr);

    u32 insts[PPC_MAX_BLOCK_INSTRS];
    u32 instr_pcs[PPC_MAX_BLOCK_INSTRS];
    u32 count = 0;
    while (count < PPC_MAX_BLOCK_INSTRS) {
        const u32 raw_be = ram_ptr[count];
        const u32 inst   = byteswap32(raw_be);
        insts[count]     = inst;
        instr_pcs[count] = start_pc + count * 4u;
        const u32 op     = (inst >> 26) & 0x3Fu;
        ++count;
        if (op == 16u || op == 17u || op == 18u || op == 19u) break;
    }
    if (count == 0u) return 0u;

    // Emit body (no module wrapper). lookup_fn=nullptr → branches to
    // region-local PCs that aren't yet in the region's pcMap fall back
    // to slow set_pc+return; region_relink (Phase 3a.3) re-emits these
    // with the now-complete lookup, converting them to the fast
    // return_call_indirect path (lever #2).
    auto body = bemental::powerpc::emit_block_body(
        start_pc, insts, count,
        /* ctx_ptr_const   = */ static_cast<u32>(g_ppc_state_base),
        /* mem1_base       = */ static_cast<u32>(g_mem1_base),
        /* mem1_mask       = */ ram_mask,
        /* ram_size        = */ g_mem1_size,
        /* instr_pcs       = */ instr_pcs,
        /* lookup_fn       = */ nullptr,
        /* lookup_user     = */ nullptr,
        /* emit_hle_check  = */ false);
    if (body.empty()) return 0u;

    // Stash the emit inputs so region_relink can re-emit with a complete
    // lookup_fn. The accumulator copies the data internally.
    BlockEmitInputs inputs;
    inputs.start_pc      = start_pc;
    inputs.ctx_ptr_const = static_cast<u32>(g_ppc_state_base);
    inputs.mem1_base     = static_cast<u32>(g_mem1_base);
    inputs.mem1_mask     = ram_mask;
    inputs.ram_size      = g_mem1_size;
    inputs.insts.assign(insts, insts + count);
    inputs.instr_pcs.assign(instr_pcs, instr_pcs + count);

    const std::size_t body_size = body.size();
    g_bcache.region_accumulate(region, start_pc,
                               body.data(), body.size(), &inputs);

    g_compile_cycles = count;
    return static_cast<u32>(body_size);
}

EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_compile_buf_addr() {
    return static_cast<u32>(reinterpret_cast<uintptr_t>(g_compile_buf.data()));
}

EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_compile_cycles() {
    return g_compile_cycles;
}

// shutdown: stub.
EMSCRIPTEN_KEEPALIVE
void ppc_worker_shutdown() {
#ifdef __EMSCRIPTEN__
    EM_ASM({ console.log('[ppc-worker] shutdown'); });
#endif
}

// version: lets JS verify the loaded wasm matches the protocol it
// expects. Bumped whenever the SAB layout or function signatures change.
// Bumps: 1 (Phase 2a foundation) → 2 (Phase 3a.1 BlockCache instance live).
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_version() {
    return 2u;
}

// Diagnostic export: number of accumulated bodies in a region. Returns 0
// until 3a.2 wires region_accumulate calls. JS verifies non-zero growth
// post-relink to confirm Phase 3a.2+ is working.
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_region_n_funcs(u32 region) {
    if (region >= REGION_COUNT) return 0u;
    return static_cast<u32>(g_bcache.region_n_funcs(static_cast<Region>(region)));
}

// Phase 3a.3 — iterate REGION_COUNT regions; for each that meets
// region_should_relink (≥64 blocks since last relink OR ≥1 block + 2s
// quiesce per block_cache.cpp:544-578), call region_relink which
// builds the merged module via the guest emitter, instantiates it via
// EM_ASM_INT into Module.bemental_regions[r], and drops the previous
// module. Returns the number of regions that relinked this call (0 if
// none were due, ≥1 if compile-pool is keeping up).
//
// Should be called from the JS dispatch loop on a slow cadence (e.g.
// every N misses or once per outer iter) so the threshold work does
// not pile up. Cheap when nothing is due (just N hashmap-size + N
// time-deltas).
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_relink_region_if_due(u32 mem_pages) {
    u32 n_relinked = 0u;
    for (u32 r = 0u; r < REGION_COUNT; ++r) {
        const Region region = static_cast<Region>(r);
        if (!g_bcache.region_should_relink(region)) continue;
        g_bcache.region_relink(region, mem_pages);
        ++n_relinked;
    }
    return n_relinked;
}

// Diagnostic: current generation counter for a region. Bumped each
// relink. JS reads this to detect when a fresh module is available
// (compare with previously-observed generation).
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_region_generation(u32 region) {
    if (region >= REGION_COUNT) return 0u;
    return static_cast<u32>(g_bcache.region_generation(static_cast<Region>(region)));
}

// Phase 3a.4 — wrapper around BlockCache::region_dispatch that hides the
// out-param convention behind a single-u32 return. The C side already
// does the merged-region pcMap lookup + regionFn() call inside an
// EM_ASM_INT, so the JS dispatch loop just calls this and checks
// against MISS_SENTINEL.
//
// Returns: next-pc on hit; 0xFFFFFFFF on miss (caller should fall
// through to compile + accumulate + maybe relink).
//
// Real guest PCs are always < 0x82000000, so 0xFFFFFFFF is a safe
// sentinel; no risk of conflating with a real next-pc.
static constexpr u32 PPC_WORKER_DISPATCH_MISS = 0xFFFFFFFFu;

EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_region_dispatch_pc(u32 pc) {
    s32 next = 0;
    if (g_bcache.region_dispatch(pc, &next)) {
        return static_cast<u32>(next);
    }
    return PPC_WORKER_DISPATCH_MISS;
}

}  // extern "C"

// main: not used in worker mode (we're loaded as a library), but
// emscripten requires SOMETHING. Return 0 immediately; runtime stays
// alive (-s EXIT_RUNTIME=0) so the exported functions remain callable.
int main(int /*argc*/, char** /*argv*/) {
    return 0;
}

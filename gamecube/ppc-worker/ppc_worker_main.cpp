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
#include "sab_layout.h"

#include <cstdio>
#include <cstdint>
#include <cstring>
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
                            bool emit_hle_check,
                            bool emit_perf_stub = false,
                            bool emit_hle_check_native = false);
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
                                bool emit_hle_check,
                                bool emit_perf_stub = false,
                                bool emit_hle_check_native = false);
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

// Boot-dispatcher mode controls. Default to "real boot" semantics
// (perf_stub off, native HLE off until table snapshot signals ready).
// Page flips these via ppc_worker_set_mode mailbox-equivalent C exports
// once the relevant infrastructure is live.
//   g_emit_perf_stub        — true under ?ppcperf=1/?ppcperfsynth=1 (V8
//                              tier-up measurement path); false for real
//                              boot so dispatched blocks call real
//                              env.ppc_* imports through the mailbox.
//   g_emit_hle_check_native — true once dolphin's HLE snapshot has been
//                              published to the SAB hash table at
//                              HLE_TABLE_ADDR. Until then, fall back to
//                              the JS-side env.ppc_hle_check mailbox.
static bool g_emit_perf_stub        = false;
static bool g_emit_hle_check_native = false;

// Phase 3a.1 — link BlockCache into ppc-worker. Instance is private to
// this worker; dolphin's BlockCache lives in dolphin_worker. They do not
// share state at the C++ level (only the underlying SAB-mapped emulator
// state). Region-emit work in 3a.2-3a.7 calls methods on this instance.
// Declared at file scope (not inside extern "C") so it's visible to all
// translation units below it.
static BlockCache g_bcache;

extern "C" {

// Researcher B stack-corrupt sentinel — ppc-worker side stub.
// JIT-emitted blocks call env.ppc_stack_corrupt which JS-shims to
// Module._dolphin_stack_corrupt. In ppc-worker context (where the JIT runs),
// "dolphin" doesn't actually exist — so this stub writes the (pc, ea, val,
// width, r1) tuple to a SAB ring at 0x02700000 (γ-safe range, above all
// documented sentinels, below dolphin's GLOBAL_BASE=256MB). Dolphin reads
// the ring on its [jit-inner] heartbeat.
//
// Ring layout at SAB[0x02700000]:
//   +0x00 = head (monotonic counter)
//   +0x04 = stack_writes_seen (total stack-range stores observed)
//   +0x08..+0xFFC = 255 entries × 16 bytes: (pc, ea, val, r1)
//                   (width omitted to save space; w=1/2/4 inferrable
//                   from caller analysis if needed)
EMSCRIPTEN_KEEPALIVE
void dolphin_stack_corrupt(u32 pc, u32 ea, u32 val, u32 width) {
    (void)width;  // not stored; saves 4 bytes per slot
    // Unconditional call counter at 0x02700100. Incremented BEFORE the EA
    // filter so dolphin-side [stack-canary] can discriminate "import never
    // bound / never called" (callcnt=0) from "called many times but EA
    // filter rejected all of them" (callcnt>>0, head=0).
    volatile u32* sCallCnt = reinterpret_cast<volatile u32*>(0x02700100u);
    *sCallCnt = *sCallCnt + 1u;
    // Stack-range gate: 0x80300000..0x80400000 (per observed r1 in 0x803cxxxx).
    if (ea < 0x80300000u || ea >= 0x80400000u) return;
    // Read current r1 from ppc_state (g_ppc_state_base is the host pointer
    // to PowerPCState; gpr[1] is at offset GPR_BASE+4 = 0x14 + 4 = 0x18).
    const u32 r1 = g_ppc_state_base
        ? *reinterpret_cast<volatile u32*>(g_ppc_state_base + 0x18u)
        : 0u;
    volatile u32* sHead  = reinterpret_cast<volatile u32*>(0x02700000u);
    volatile u32* sTotal = reinterpret_cast<volatile u32*>(0x02700004u);
    const u32 head = *sHead;
    *sHead  = head + 1u;
    *sTotal = *sTotal + 1u;
    const u32 slot_addr = 0x02700008u + (head & 0xFFu) * 16u;
    volatile u32* slot = reinterpret_cast<volatile u32*>(slot_addr);
    slot[0] = pc;
    slot[1] = ea;
    slot[2] = val;
    slot[3] = r1;
}

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

// Boot-dispatcher mode setters. The page calls these post-init to flip
// ppc-worker between "real boot" (default — real imports, no native HLE)
// and "perf measurement" (Option D stubs, native HLE inline). Idempotent;
// safe to call repeatedly. set_hle_check_native is meant for the page to
// flip ON once dolphin signals "HLE snapshot published" via a postMessage.
EMSCRIPTEN_KEEPALIVE
void ppc_worker_set_perf_stub(u32 enable) {
    g_emit_perf_stub = (enable != 0u);
}

EMSCRIPTEN_KEEPALIVE
void ppc_worker_set_hle_check_native(u32 enable) {
    g_emit_hle_check_native = (enable != 0u);
}

EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_get_perf_stub() { return g_emit_perf_stub ? 1u : 0u; }
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_get_hle_check_native() { return g_emit_hle_check_native ? 1u : 0u; }

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
        // Boot-mode default: real imports (perf_stub=false), JS-side HLE
        // check until dolphin signals the SAB hash table is ready.
        // ?ppcperf=1/?ppcperfsynth=1 flip g_emit_perf_stub via
        // ppc_worker_set_perf_stub.
        /* emit_hle_check         = */ true,
        /* emit_perf_stub         = */ g_emit_perf_stub,
        /* emit_hle_check_native  = */ g_emit_hle_check_native);
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
        // Boot-mode default — runtime-controlled via the same g_emit_*
        // flags as ppc_worker_compile_block above.
        /* emit_hle_check         = */ true,
        /* emit_perf_stub         = */ g_emit_perf_stub,
        /* emit_hle_check_native  = */ g_emit_hle_check_native);
    if (body.empty()) return 0u;

    // Stash the emit inputs so region_relink can re-emit with a complete
    // lookup_fn. The accumulator copies the data internally.
    BlockEmitInputs inputs;
    inputs.start_pc      = start_pc;
    inputs.ctx_ptr_const = static_cast<u32>(g_ppc_state_base);
    inputs.mem1_base     = static_cast<u32>(g_mem1_base);
    inputs.mem1_mask     = ram_mask;
    inputs.ram_size      = g_mem1_size;
    inputs.emit_perf_stub = g_emit_perf_stub;
    inputs.emit_hle_check_native = g_emit_hle_check_native;
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
// Bumps: 1 (Phase 2a foundation) → 2 (Phase 3a.1 BlockCache instance live)
//      → 3 (boot-dispatcher mode setters; g_emit_* defaults flipped to false).
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_version() {
    return 3u;
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

// Phase 3a.5 — force-relink any region whose accumulator has ≥1 body
// regardless of region_should_relink's natural threshold (which requires
// ≥64 blocks OR ≥2s quiesce). Solves the warmup chicken-and-egg: the
// first miss-storm needs a module materialized BEFORE 64 PCs have
// accumulated, otherwise dispatch keeps missing.
//
// JS calls this once at iter==0 of the merged-mode loop, and again on
// any iter where compile_and_accumulate succeeded but the next dispatch
// would still miss (caller tracks misses-since-relink and decides).
//
// Returns the number of regions force-relinked.
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_force_relink_all(u32 mem_pages) {
    u32 n_relinked = 0u;
    for (u32 r = 0u; r < REGION_COUNT; ++r) {
        const Region region = static_cast<Region>(r);
        if (g_bcache.region_n_funcs(region) == 0u) continue;
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

// ---- CoreTiming shared event queue (Item 7 Phase I) ----
// Infrastructure stub. The queue starts empty; nothing pushes into it
// yet — that's Phase II (DEC mirror) and Phase III (hybrid events).
// See gamecube/notes/item7_coretiming_design.md.
//
// Layout addresses come from sab_layout.h. All u32 reads/writes go
// through __atomic_* to be safe under the seqlock protocol; the
// initializer below uses RELAXED for one-time fill and a single
// RELEASE for the magic publish.

// Apply the pure-PPC DecCallback effect locally. Mirrors
// SystemTimers::DecrementerCallback in dolphin-src:
//   ppc_state.spr[SPR_DEC] = 0xFFFFFFFF;
//   ppc_state.Exceptions |= EXCEPTION_DECREMENTER;
// Both writes target the SAB-backed PowerPCState at g_ppc_state_base
// + ppc_off::SPR_BASE + 22*4 (SPR_DEC=22) and + ppc_off::EXCEPTIONS.
static void fire_pure_decrementer() {
    if (g_ppc_state_base == 0u) return;
    constexpr u32 SPR_BASE_OFF  = 0x340u;  // matches PowerPCState layout (per ppc_worker_main.cpp header comment)
    constexpr u32 SPR_DEC_INDEX = 22u;
    constexpr u32 EXCEPTIONS_OFF = 0x2ECu;
    constexpr u32 EXCEPTION_DECREMENTER = 0x00000800u;

    volatile u32* dec_slot = reinterpret_cast<volatile u32*>(
        static_cast<uintptr_t>(g_ppc_state_base + SPR_BASE_OFF + SPR_DEC_INDEX * 4u));
    *dec_slot = 0xFFFFFFFFu;

    u32* exc_slot = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(g_ppc_state_base + EXCEPTIONS_OFF));
    __atomic_or_fetch(exc_slot, EXCEPTION_DECREMENTER, __ATOMIC_RELEASE);
}

// Zero header + records, then publish magic. Idempotent — calling this
// twice is fine (re-zeroes any in-flight entries; Phase I doesn't have
// any).
EMSCRIPTEN_KEEPALIVE
void ppc_worker_ct_queue_init() {
    using namespace bemental_sab;
    volatile u8* base = reinterpret_cast<volatile u8*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR));
    // Zero the entire region (header + records).
    for (u32 i = 0; i < CT_QUEUE_BYTES; ++i) base[i] = 0u;
    // Publish magic with RELEASE so a reader observing the magic sees
    // a zero count.
    volatile u32* magic = reinterpret_cast<volatile u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_MAGIC));
    __atomic_store_n(reinterpret_cast<u32*>(const_cast<u32*>(magic)),
                     CT_QUEUE_MAGIC, __ATOMIC_RELEASE);
}

// Return the current entry count (number of records with CT_FLAG_VALID).
// Phase I returns 0; Phase II onward returns the seqlock-stable count.
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_ct_queue_count() {
    using namespace bemental_sab;
    return __atomic_load_n(reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_EVENT_COUNT)),
        __ATOMIC_ACQUIRE);
}

// Verify magic. Returns 1 iff CT_QUEUE_MAGIC has been published.
// JS-side diag uses this to confirm init succeeded.
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_ct_queue_ready() {
    using namespace bemental_sab;
    const u32 m = __atomic_load_n(reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_MAGIC)),
        __ATOMIC_ACQUIRE);
    return (m == CT_QUEUE_MAGIC) ? 1u : 0u;
}

// Walk the queue, fire any pure-PPC events whose time <= now. Returns
// the number of events fired. Caller passes the current sim time as
// (lo, hi) split 64-bit.
//
// Phase II: queue populated by dolphin_ct_publish_dec (mirrors DEC
// schedule). DEC entries fire fire_pure_decrementer() locally and set
// CT_PEND_DEC_PREFIRED as a diagnostic hint. The state mutation is
// idempotent so dolphin's local DEC firing remains safe.
//
// Phase III (when CT_PHASE3_ENABLE bit is set in PHASE_FLAGS): hybrid
// entries (VI/DSP/AI/AudioDMA/GPUSleeper/PatchEngine) have their cadence
// "consumed" — record is tombstoned — and the corresponding pending-mask
// bit is set so dolphin will run the C++ callback at its next heartbeat.
// Without the phase flag, hybrids are ignored (left for dolphin's local
// Advance to fire normally).
//
// Seqlock-stable: loops up to 2 times under writer contention; if
// the writer holds the lock longer than that, returns 0 and the
// caller retries next iter. That is safe because sim-time only
// monotonically advances.
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_ct_fire_due_pure(u32 now_lo, u32 now_hi) {
    using namespace bemental_sab;
    const u64 now = (static_cast<u64>(now_hi) << 32) | static_cast<u64>(now_lo);
    u32* hdr_seq = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_EVENT_SEQ));
    u32* hdr_cnt = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_EVENT_COUNT));
    u32* hdr_pending = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_DOLPHIN_PENDING_MASK));
    u32* hdr_phase = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_PHASE_FLAGS));
    const u32 phase = __atomic_load_n(hdr_phase, __ATOMIC_RELAXED);
    const bool phase3_on = (phase & CT_PHASE3_ENABLE) != 0u;

    for (int attempt = 0; attempt < 2; ++attempt) {
        const u32 s0 = __atomic_load_n(hdr_seq, __ATOMIC_ACQUIRE);
        if (s0 & 1u) continue;  // writer in progress
        const u32 cnt = __atomic_load_n(hdr_cnt, __ATOMIC_RELAXED);
        if (cnt == 0u) {
            // Empty queue. Seqlock didn't need to be re-checked because
            // we read no records.
            return 0u;
        }
        u32 fired = 0u;
        u32 hybrid_bits = 0u;
        for (u32 i = 0; i < CT_QUEUE_CAPACITY; ++i) {
            CtEventRecord* rec = reinterpret_cast<CtEventRecord*>(
                static_cast<uintptr_t>(ct_record_addr(i)));
            const u32 flags = __atomic_load_n(&rec->flags, __ATOMIC_RELAXED);
            if ((flags & CT_FLAG_VALID) == 0u) continue;
            if ((flags & CT_FLAG_REMOVED) != 0u) continue;
            const u64 t = (static_cast<u64>(static_cast<u32>(rec->time_hi)) << 32)
                          | static_cast<u64>(static_cast<u32>(rec->time_lo));
            if (t > now) continue;
            const u32 type_id = rec->event_type_id;
            bool consumed = false;
            if ((flags & CT_FLAG_PURE_PPC) != 0u) {
                if (type_id == CT_EV_DECREMENTER) {
                    fire_pure_decrementer();
                    hybrid_bits |= CT_PEND_DEC_PREFIRED;  // diagnostic hint
                    ++fired;
                    consumed = true;
                }
            } else if ((flags & CT_FLAG_HYBRID) != 0u) {
                if (phase3_on) {
                    const u32 bit = ct_event_pending_bit(type_id);
                    if (bit != 0u) {
                        hybrid_bits |= bit;
                        ++fired;
                        consumed = true;
                    }
                }
                // If phase3 is off, leave the entry — dolphin's local
                // Advance() still processes the equivalent local event.
            }
            if (consumed) {
                __atomic_store_n(&rec->flags,
                                 (flags | CT_FLAG_REMOVED) & ~CT_FLAG_VALID,
                                 __ATOMIC_RELEASE);
            }
        }
        // Seqlock re-check.
        const u32 s1 = __atomic_load_n(hdr_seq, __ATOMIC_ACQUIRE);
        if (s1 == s0) {
            if (hybrid_bits != 0u) {
                __atomic_or_fetch(hdr_pending, hybrid_bits, __ATOMIC_RELEASE);
            }
            return fired;
        }
        // Writer raced us; retry the whole walk.
    }
    return 0u;
}

// Diagnostic export: read the current dolphin-pending-mask without
// clearing it. Dolphin's outer Run() loop polls this in Phase III; the
// helper exists now so the JS side can verify the field is reachable.
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_ct_dolphin_pending_mask() {
    using namespace bemental_sab;
    return __atomic_load_n(reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_DOLPHIN_PENDING_MASK)),
        __ATOMIC_ACQUIRE);
}

// Phase II — ppc-worker-side seqlocked publish of a single event. Used
// by §2d (ppc-worker-initiated scheduling) once guest mtspr DEC paths
// run inside ppc-worker. Phase II ships this for completeness; dolphin's
// SystemTimers::DecrementerSet currently does the publish from C++ via
// dolphin_ct_publish_dec (JitWasm.cpp), so this entry-point is exercised
// only by future work.
//
// (event_type_id, time_lo, time_hi, flags) — flags should be CT_FLAG_VALID
// plus CT_FLAG_PURE_PPC or CT_FLAG_HYBRID. Returns the slot index used,
// or 0xFFFFFFFF if the queue is full.
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_ct_publish_event(u32 event_type_id, u32 time_lo, u32 time_hi, u32 flags) {
    using namespace bemental_sab;
    u32* hdr_seq = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_EVENT_SEQ));
    u32* hdr_cnt = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_EVENT_COUNT));
    u32* hdr_owner = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_WRITER_OWNER));

    // Acquire writer ownership (id 1 = ppc).
    for (int spin = 0; spin < 256; ++spin) {
        u32 expected = 0u;
        if (__atomic_compare_exchange_n(hdr_owner, &expected, 1u, false,
                                         __ATOMIC_ACQUIRE, __ATOMIC_RELAXED)) {
            break;
        }
        if (spin == 255) return 0xFFFFFFFFu;
    }
    // Begin seqlock write (seq -> odd).
    __atomic_add_fetch(hdr_seq, 1u, __ATOMIC_RELEASE);
    u32 chosen = 0xFFFFFFFFu;
    // Scan for a free slot (CT_FLAG_VALID==0). Re-use REMOVED tombstones.
    for (u32 i = 0; i < CT_QUEUE_CAPACITY; ++i) {
        CtEventRecord* rec = reinterpret_cast<CtEventRecord*>(
            static_cast<uintptr_t>(ct_record_addr(i)));
        const u32 cur = __atomic_load_n(&rec->flags, __ATOMIC_RELAXED);
        if ((cur & CT_FLAG_VALID) == 0u) {
            rec->time_lo       = static_cast<int32_t>(time_lo);
            rec->time_hi       = static_cast<int32_t>(time_hi);
            rec->event_type_id = event_type_id;
            rec->userdata_lo   = 0u;
            rec->userdata_hi   = 0u;
            __atomic_store_n(&rec->flags, flags | CT_FLAG_VALID,
                             __ATOMIC_RELEASE);
            chosen = i;
            break;
        }
    }
    // Recompute count (cheap; capacity is 256).
    u32 new_count = 0u;
    for (u32 i = 0; i < CT_QUEUE_CAPACITY; ++i) {
        CtEventRecord* rec = reinterpret_cast<CtEventRecord*>(
            static_cast<uintptr_t>(ct_record_addr(i)));
        const u32 cur = __atomic_load_n(&rec->flags, __ATOMIC_RELAXED);
        if ((cur & CT_FLAG_VALID) != 0u) ++new_count;
    }
    __atomic_store_n(hdr_cnt, new_count, __ATOMIC_RELEASE);
    // End seqlock write (seq -> even).
    __atomic_add_fetch(hdr_seq, 1u, __ATOMIC_RELEASE);
    __atomic_store_n(hdr_owner, 0u, __ATOMIC_RELEASE);
    return chosen;
}

// Phase II/III runtime control. Page-mediated flip via URL flag or post
// from dolphin's retro_load_game. Idempotent.
EMSCRIPTEN_KEEPALIVE
void ppc_worker_ct_set_phase_flags(u32 flags) {
    using namespace bemental_sab;
    __atomic_store_n(reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_PHASE_FLAGS)),
        flags, __ATOMIC_RELEASE);
}

EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_ct_get_phase_flags() {
    using namespace bemental_sab;
    return __atomic_load_n(reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_PHASE_FLAGS)),
        __ATOMIC_ACQUIRE);
}

// Read the canonical global sim time (lo word). Phase II uses this so
// ppc-worker can compare entry times against the timer dolphin publishes
// from CoreTiming::Advance(). Phase IV/V will move ownership to
// ppc-worker; the accessor stays.
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_ct_global_timer_lo() {
    using namespace bemental_sab;
    return __atomic_load_n(reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_GLOBAL_TIMER_LO)),
        __ATOMIC_ACQUIRE);
}

EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_ct_global_timer_hi() {
    using namespace bemental_sab;
    return __atomic_load_n(reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_GLOBAL_TIMER_HI)),
        __ATOMIC_ACQUIRE);
}

// ---- Item 7 Phase IV: ppc-worker owns CoreTiming cadence ----------------
//
// Under Phase IV ppc-worker is the canonical writer for two fields that
// dolphin's CoreTiming used to own outright:
//   - global_timer (CT queue header u64 split lo/hi)
//   - downcount (PowerPCState s32 at +0x2F0)
//
// The four entry points below wrap the math + atomics required by the
// run-continuous slice loop.

namespace {
// PowerPCState downcount offset (matches the layout comment near
// g_ppc_state_base — downcount is s32 at +0x2F0).
constexpr u32 PPC_DC_OFF = 0x2F0u;

// Phase IV slice cap — keeps the slice short enough that dolphin's
// service_iter heartbeat (which drains MMIO + hybrid-pending-mask) gets
// a chance to run at human-perceivable cadence. 200K cycles ~= 0.4 ms
// at 486 MHz emulated — well under one VI half-line.
constexpr u32 PHASE4_MAX_SLICE = 200000u;
}  // namespace

// Write split-64 sim time to CT queue header. Seqlock pattern: bump
// seq odd, store lo, store hi, bump seq even. Single-writer (ppc-worker
// under Phase IV); readers (dolphin Advance) tolerate transient
// inconsistency via the same seqlock retry pattern.
EMSCRIPTEN_KEEPALIVE
void ppc_worker_advance_global_timer(u32 lo, u32 hi) {
    using namespace bemental_sab;
    u32* p_seq = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_EVENT_SEQ));
    u32* p_lo  = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_GLOBAL_TIMER_LO));
    u32* p_hi  = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_GLOBAL_TIMER_HI));
    __atomic_add_fetch(p_seq, 1u, __ATOMIC_RELEASE);  // odd
    __atomic_store_n(p_lo, lo, __ATOMIC_RELAXED);
    __atomic_store_n(p_hi, hi, __ATOMIC_RELAXED);
    __atomic_add_fetch(p_seq, 1u, __ATOMIC_RELEASE);  // even
}

// Atomic write to PowerPCState.downcount. Signed s32. Used by
// ppc_worker_commit_slice and any external test path that wants to
// seed/clear downcount without a JIT-emitted store.
EMSCRIPTEN_KEEPALIVE
void ppc_worker_set_downcount(int32_t v) {
    if (g_ppc_state_base == 0u) return;
    int32_t* p_dc = reinterpret_cast<int32_t*>(
        static_cast<uintptr_t>(g_ppc_state_base + PPC_DC_OFF));
    __atomic_store_n(p_dc, v, __ATOMIC_RELEASE);
}

// Compute the next slice budget in cycles. Returned as u32 (always >=0).
// Formula: min(downcount, next_event_time - global_timer, PHASE4_MAX_SLICE).
// downcount<=0 -> 0 (caller should commit_slice(0) then yield).
// No pending event -> infinite, so the slice is capped by PHASE4_MAX_SLICE.
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_slice_budget(void) {
    using namespace bemental_sab;
    if (g_ppc_state_base == 0u) return 0u;
    const int32_t dc = __atomic_load_n(reinterpret_cast<int32_t*>(
        static_cast<uintptr_t>(g_ppc_state_base + PPC_DC_OFF)),
        __ATOMIC_ACQUIRE);
    if (dc <= 0) return 0u;

    // Read global_timer (seqlock).
    u32* p_seq = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_EVENT_SEQ));
    u32* p_lo  = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_GLOBAL_TIMER_LO));
    u32* p_hi  = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_GLOBAL_TIMER_HI));
    u32 gt_lo = 0u, gt_hi = 0u;
    for (int attempt = 0; attempt < 2; ++attempt) {
        const u32 s0 = __atomic_load_n(p_seq, __ATOMIC_ACQUIRE);
        if (s0 & 1u) continue;
        gt_lo = __atomic_load_n(p_lo, __ATOMIC_RELAXED);
        gt_hi = __atomic_load_n(p_hi, __ATOMIC_RELAXED);
        const u32 s1 = __atomic_load_n(p_seq, __ATOMIC_ACQUIRE);
        if (s1 == s0) break;
    }
    const uint64_t now = (static_cast<uint64_t>(gt_hi) << 32) | gt_lo;

    // Walk queue for nearest non-tombstoned event time.
    uint64_t nearest = static_cast<uint64_t>(-1);
    bool found = false;
    for (u32 i = 0; i < CT_QUEUE_CAPACITY; ++i) {
        CtEventRecord* rec = reinterpret_cast<CtEventRecord*>(
            static_cast<uintptr_t>(ct_record_addr(i)));
        const u32 flags = __atomic_load_n(&rec->flags, __ATOMIC_RELAXED);
        if ((flags & CT_FLAG_VALID) == 0u) continue;
        if ((flags & CT_FLAG_REMOVED) != 0u) continue;
        const uint64_t t = (static_cast<uint64_t>(static_cast<u32>(rec->time_hi)) << 32)
                          | static_cast<uint64_t>(static_cast<u32>(rec->time_lo));
        if (!found || t < nearest) { nearest = t; found = true; }
    }

    uint64_t cycles_to_evt = static_cast<uint64_t>(PHASE4_MAX_SLICE);
    if (found) {
        cycles_to_evt = (nearest > now) ? (nearest - now) : 0u;
    }
    uint64_t budget = static_cast<uint64_t>(static_cast<u32>(dc));
    if (cycles_to_evt < budget) budget = cycles_to_evt;
    if (budget > PHASE4_MAX_SLICE) budget = PHASE4_MAX_SLICE;
    return static_cast<u32>(budget);
}

// Commit a slice: subtract cycles from downcount, advance global_timer,
// fire any due pure-PPC events. Called once per JS-side slice after the
// dispatch inner loop returns.
EMSCRIPTEN_KEEPALIVE
void ppc_worker_commit_slice(u32 cycles_consumed) {
    using namespace bemental_sab;
    if (g_ppc_state_base == 0u) return;
    if (cycles_consumed == 0u) {
        // Still fire due events with the current timer — caller may have
        // burned wall time but no cycles (e.g. all-idle slice).
        const u32 gtl0 = ppc_worker_ct_global_timer_lo();
        const u32 gth0 = ppc_worker_ct_global_timer_hi();
        ppc_worker_ct_fire_due_pure(gtl0, gth0);
        return;
    }
    // Atomic downcount subtract.
    int32_t* p_dc = reinterpret_cast<int32_t*>(
        static_cast<uintptr_t>(g_ppc_state_base + PPC_DC_OFF));
    __atomic_sub_fetch(p_dc, static_cast<int32_t>(cycles_consumed),
                       __ATOMIC_ACQ_REL);

    // 64-bit add to global_timer (seqlock).
    u32* p_seq = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_EVENT_SEQ));
    u32* p_lo  = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_GLOBAL_TIMER_LO));
    u32* p_hi  = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(CT_QUEUE_ADDR + CT_OFF_GLOBAL_TIMER_HI));
    const u32 old_lo = __atomic_load_n(p_lo, __ATOMIC_ACQUIRE);
    const u32 old_hi = __atomic_load_n(p_hi, __ATOMIC_ACQUIRE);
    const uint64_t old_t = (static_cast<uint64_t>(old_hi) << 32) | old_lo;
    const uint64_t new_t = old_t + static_cast<uint64_t>(cycles_consumed);
    const u32 new_lo = static_cast<u32>(new_t & 0xFFFFFFFFull);
    const u32 new_hi = static_cast<u32>((new_t >> 32) & 0xFFFFFFFFull);
    __atomic_add_fetch(p_seq, 1u, __ATOMIC_RELEASE);  // odd
    __atomic_store_n(p_lo, new_lo, __ATOMIC_RELAXED);
    __atomic_store_n(p_hi, new_hi, __ATOMIC_RELAXED);
    __atomic_add_fetch(p_seq, 1u, __ATOMIC_RELEASE);  // even

    // Fire due pure-PPC events at the new time.
    ppc_worker_ct_fire_due_pure(new_lo, new_hi);
}

// ---- Phase 2e Step 1: C-side run-continuous core ---------------------------
//
// Ports the body of `case 'run-continuous'` in ppc_worker.js (~lines
// 741..990) into C. Owns the inner dispatch loop so the per-block JS
// round-trip disappears: read PC from SAB, region_dispatch, decrement
// downcount, write PC back, check exit conditions — all inside compiled
// wasm. The only JS crossing per iter is the EM_ASM_INT inside
// region_dispatch (which Phase 2 step 2 will replace with a direct
// wasm function-table call).
//
// Step 1 ONLY: this entry point is scaffolding. The JS-side run-continuous
// dispatcher above continues to drive boot; nothing calls this yet. Step 2
// flips the JS to invoke ppc_worker_run_slice and observes throughput.
//
// SAB addresses are absolute (PPC_STATE_BASE = 0x02400000, STOP_FLAG at
// 0x02500004) matching the constants used by ppc_worker.js. We do NOT
// derive them from g_ppc_state_base because the stop flag lives outside
// the PowerPCState block.
//
// ExitInfo packing (u64 return):
//   low  32 bits = iters executed in this slice
//   high 32 bits = exit reason enum:
//     0 = downcount exhausted (downcount <= 0)
//     1 = stop_flag set (page or dolphin requested yield)
//     2 = exception pending (Exceptions != 0; JS handles delivery)
//     3 = safety_cap (max_iters hit; hard 1M ceiling)
//     4 = region_miss (region_dispatch returned false; JS handles compile)
//
// `flags` param: reserved for step 2 (e.g. ignore_downcount for perf
// mode). Currently unused — all exits are evaluated normally.
//
// `wall_deadline_ms` param: also reserved; wall-time exits will be
// added in step 2 once we have a low-overhead clock. Currently ignored.

enum PpcSliceExitReason : u32 {
    PPC_SLICE_EXIT_DOWNCOUNT  = 0u,
    PPC_SLICE_EXIT_STOP_FLAG  = 1u,
    PPC_SLICE_EXIT_EXCEPTION  = 2u,
    PPC_SLICE_EXIT_SAFETY_CAP = 3u,
    PPC_SLICE_EXIT_REGION_MISS = 4u,
};

// Hard safety ceiling — refuses to loop more than 1M iters per slice
// regardless of caller-supplied max_iters. Prevents a runaway from
// pegging the worker thread for an unbounded period.
static constexpr u32 PPC_SLICE_SAFETY_CAP = 1000000u;

// SAB absolute addresses (mirror the JS constants).
static constexpr u32 PPC_SLICE_STATE_BASE       = 0x02400000u;
static constexpr u32 PPC_SLICE_OFF_PC           = 0x000u;
static constexpr u32 PPC_SLICE_OFF_MSR          = 0x2E0u;
static constexpr u32 PPC_SLICE_OFF_EXC          = 0x2ECu;
static constexpr u32 PPC_SLICE_OFF_DOWNCOUNT    = 0x2F0u;
static constexpr u32 PPC_SLICE_STOP_FLAG_ADDR   = 0x02500004u;

// Phase 2e Step 2: ExitInfo is written into SAB instead of returned packed
// in a u64. Avoids BigInt complexity (BIGINT not enabled in build flags) and
// keeps the C ABI simple (void return).  JS reads these two slots back after
// the call.
static constexpr u32 PPC_SLICE_EXIT_ITERS_ADDR  = 0x025000A0u;
static constexpr u32 PPC_SLICE_EXIT_REASON_ADDR = 0x025000A4u;

EMSCRIPTEN_KEEPALIVE
void ppc_worker_run_slice(u32 max_iters, u32 wall_deadline_ms, u32 flags) {
    (void)wall_deadline_ms;  // reserved for step 2
    (void)flags;             // reserved for step 2

    // Clamp caller cap to safety ceiling.
    u32 cap = max_iters;
    if (cap == 0u || cap > PPC_SLICE_SAFETY_CAP) cap = PPC_SLICE_SAFETY_CAP;

    volatile u32* p_pc  = reinterpret_cast<volatile u32*>(
        static_cast<uintptr_t>(PPC_SLICE_STATE_BASE + PPC_SLICE_OFF_PC));
    u32* p_msr          = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(PPC_SLICE_STATE_BASE + PPC_SLICE_OFF_MSR));
    u32* p_exc          = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(PPC_SLICE_STATE_BASE + PPC_SLICE_OFF_EXC));
    int32_t* p_dc       = reinterpret_cast<int32_t*>(
        static_cast<uintptr_t>(PPC_SLICE_STATE_BASE + PPC_SLICE_OFF_DOWNCOUNT));
    int32_t* p_stop     = reinterpret_cast<int32_t*>(
        static_cast<uintptr_t>(PPC_SLICE_STOP_FLAG_ADDR));
    u32* p_exit_iters   = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(PPC_SLICE_EXIT_ITERS_ADDR));
    u32* p_exit_reason  = reinterpret_cast<u32*>(
        static_cast<uintptr_t>(PPC_SLICE_EXIT_REASON_ADDR));

    u32 pc = *p_pc;
    u32 iters = 0u;
    PpcSliceExitReason reason = PPC_SLICE_EXIT_SAFETY_CAP;

    for (; iters < cap; ++iters) {
        // External stop flag (page or dolphin requesting yield).
        if (__atomic_load_n(p_stop, __ATOMIC_ACQUIRE) != 0) {
            reason = PPC_SLICE_EXIT_STOP_FLAG;
            break;
        }

        // Exception pending? Apply Q2 gate: external-only + EE=0 is
        // ignored (PPC code will eventually mtmsr EE=1 and deliver on its
        // own); anything else exits the slice for JS to deliver via
        // mailbox cmd 10. Without this gate the slice exits 0-iters
        // forever during early boot — the game's BS2 init holds EE=0 with
        // an external_int pending and never gets a chance to advance.
        const u32 exc = __atomic_load_n(p_exc, __ATOMIC_ACQUIRE);
        if (exc != 0u) {
            constexpr u32 EXC_EXTERNAL_INT = 0x00000004u;
            constexpr u32 MSR_EE           = 0x00008000u;
            const u32 msr = __atomic_load_n(p_msr, __ATOMIC_ACQUIRE);
            const bool external_only = (exc & ~EXC_EXTERNAL_INT) == 0u;
            const bool ee_set        = (msr & MSR_EE) != 0u;
            if (!external_only || ee_set) {
                reason = PPC_SLICE_EXIT_EXCEPTION;
                break;
            }
            // EE-gated external_int — fall through and keep dispatching.
        }

        // Downcount exhausted?
        const int32_t dc = __atomic_load_n(p_dc, __ATOMIC_ACQUIRE);
        if (dc <= 0) {
            reason = PPC_SLICE_EXIT_DOWNCOUNT;
            break;
        }

        // Dispatch via merged-region path. region_dispatch crosses into
        // JS via EM_ASM_INT to invoke the WASM region function — keeping
        // each region's function table inside its own instance per the
        // Q1 architectural decision (no shared WebAssembly.Table install).
        s32 next = 0;
        if (!g_bcache.region_dispatch(pc, &next)) {
            reason = PPC_SLICE_EXIT_REGION_MISS;
            break;
        }

        // Hit: decrement downcount by one cycle (block-cycles plumbing
        // is step 2 / Q3). Use __atomic_sub_fetch to stay race-free with
        // dolphin's parallel writes to downcount, matching the JS
        // Atomics.sub(i32, dc, 1) call this replaces.
        __atomic_sub_fetch(p_dc, 1, __ATOMIC_ACQ_REL);

        // Publish next PC back to SAB and update local cursor.
        pc = static_cast<u32>(next);
        *p_pc = pc;
    }

    // safety-cap if we fell out of the loop normally.
    if (iters >= cap && reason == PPC_SLICE_EXIT_SAFETY_CAP) {
        reason = PPC_SLICE_EXIT_SAFETY_CAP;
    }

    // Phase 2e Step 2: publish ExitInfo into SAB instead of returning it.
    // JS reads these two slots immediately after the call returns.
    __atomic_store_n(p_exit_iters, iters, __ATOMIC_RELEASE);
    __atomic_store_n(p_exit_reason, static_cast<u32>(reason), __ATOMIC_RELEASE);
}

}  // extern "C"

// ---------------------------------------------------------------------------
// Microbench harness — gated by PPC_WORKER_MICROBENCH so production builds
// are bit-identical without the flag. Implements native-speed-gap-test
// from gamecube/docs/native-speed-gap-test/TASKS.md.
//
// Three layers measured against one fixture block (15× addi r3,r3,1 ; blr):
//   L0  empty EM_ASM_INT loop — floor of any C→JS crossing.
//   L1  dispatch_raw(handle) — production single-block path (EM_ASM-wrapped
//       wasmTable.get($0)() — see bementalJIT/src/block_cache.cpp:206-252).
//   L2  C-direct call via fn-ptr cast on the same wasmTable index. The wasm
//       toolchain lowers a call through a fn-ptr to `call_indirect
//       __indirect_function_table` (verify post-build with wasm-objdump).
//       No JS hop, no try/catch sentinel. Any trap unwinds the pthread.
//
// L1 vs L0 = EM_ASM transition cost (independent of body).
// L2 vs L1 = cost of the JS trap-catch wrap at line 215.
// L2 = achievable in-C dispatch ceiling on the EXISTING wasmTable path.
// ---------------------------------------------------------------------------
#ifdef PPC_WORKER_MICROBENCH

#include <emscripten.h>
#include <atomic>

extern "C" {

static std::atomic<int> s_mb_handle{-1};
static constexpr u32 MB_FIXTURE_PC = 0x10000000u;
static constexpr u32 MB_FIXTURE_INSTR_COUNT = 16u;

// Pure-register Gekko block: 15× `addi r3, r3, 1` (0x38630001) + `blr` (0x4E800020).
// emit_perf_stub=true stubs every WIMPORT_* call site (drop+const-0); emit_hle_check
// =false skips the prologue check. Block body touches ctx[r3] via i32.load/store
// and ctx[LR] via final blr. No env.ppc_* round-trips.
EMSCRIPTEN_KEEPALIVE
int ppc_mb_init_fixture(void) {
    if (s_mb_handle.load(std::memory_order_acquire) >= 0)
        return s_mb_handle.load(std::memory_order_acquire);
    static const u32 insts[MB_FIXTURE_INSTR_COUNT] = {
        0x38630001u, 0x38630001u, 0x38630001u, 0x38630001u,
        0x38630001u, 0x38630001u, 0x38630001u, 0x38630001u,
        0x38630001u, 0x38630001u, 0x38630001u, 0x38630001u,
        0x38630001u, 0x38630001u, 0x38630001u,
        0x4E800020u,
    };
    auto bytes = bemental::powerpc::build_block(
        MB_FIXTURE_PC, insts, MB_FIXTURE_INSTR_COUNT,
        /*ctx_ptr_const*/ (u32)g_ppc_state_base,
        /*mem_pages*/ 0,
        /*mem1_base*/ 0, /*mem1_mask*/ 0, /*ram_size*/ 0,
        /*instr_pcs*/ nullptr,
        /*emit_hle_check*/ false,
        /*emit_perf_stub*/ true,
        /*emit_hle_check_native*/ false);
    if (bytes.empty()) return -1;
    int h = bemental::compile_raw(bytes.data(), bytes.size());
    s_mb_handle.store(h, std::memory_order_release);
    return h;
}

EMSCRIPTEN_KEEPALIVE
int ppc_mb_get_handle(void) { return s_mb_handle.load(std::memory_order_acquire); }

EMSCRIPTEN_KEEPALIVE
double ppc_mb_now_ms(void) { return emscripten_get_now(); }

// L0 — empty EM_ASM_INT loop. Returns sum of returned values so V8 can't
// dead-code-eliminate.
EMSCRIPTEN_KEEPALIVE
u32 ppc_mb_run_l0_empty_emasm(u32 count) {
    u32 acc = 0;
    for (u32 i = 0; i < count; ++i) {
        acc += (u32)EM_ASM_INT({ return $0; }, (int)i);
    }
    return acc;
}

// L1 — production dispatch path. Same body as ppc_worker_run_slice's hot
// step minus the exit checks.
EMSCRIPTEN_KEEPALIVE
u32 ppc_mb_run_l1_dispatch_raw(u32 count) {
    int h = s_mb_handle.load(std::memory_order_acquire);
    if (h < 0) return 0;
    u32 acc = 0;
    for (u32 i = 0; i < count; ++i) {
        acc += (u32)bemental::dispatch_raw(h);
    }
    return acc;
}

// L2 — C-direct call via fn-ptr cast on the wasmTable index returned by
// compile_raw. wasm32 fn-ptrs ARE __indirect_function_table indices; the
// toolchain lowers `fn()` to `call_indirect`. No JS hop. Any trap unwinds
// the pthread (the fixture block is trap-free by construction — pure
// register math + blr).
typedef u32 (*MbBlockFn)(void);
EMSCRIPTEN_KEEPALIVE
u32 ppc_mb_run_l2_direct(u32 count) {
    int h = s_mb_handle.load(std::memory_order_acquire);
    if (h < 0) return 0;
    MbBlockFn fn = (MbBlockFn)(uintptr_t)h;
    u32 acc = 0;
    for (u32 i = 0; i < count; ++i) {
        acc += fn();
    }
    return acc;
}

}  // extern "C"

#endif  // PPC_WORKER_MICROBENCH

// main: not used in worker mode (we're loaded as a library), but
// emscripten requires SOMETHING. Return 0 immediately; runtime stays
// alive (-s EXIT_RUNTIME=0) so the exported functions remain callable.
int main(int /*argc*/, char** /*argv*/) {
    return 0;
}

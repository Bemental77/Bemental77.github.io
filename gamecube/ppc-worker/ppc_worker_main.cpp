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

// ---- Mailbox request-reply (Phase 2c.4c) ----
// Single-slot synchronous request-reply. Slot layout at g_mailbox_base:
//   +0  cmd          u32  ppc writes
//   +4  arg0         u32  ppc writes
//   +8  req_ready    u32  ppc sets 1 (publish), consumer resets to 0
//   +12 reply        u32  consumer writes
//   +16 reply_ready  u32  consumer sets 1, ppc Atomics.waits on it
//
// Consumer (currently the page; in 2c.4e dolphin_worker takes over)
// polls req_ready, processes, writes reply, sets reply_ready,
// Atomics.notify. ppc-worker resets reply_ready and req_ready to 0 on
// return so the slot is reusable.
//
// Single-slot is fine for the verification path; full ring-buffer
// (sab_layout.h::MailboxRecord × 1024) lands when MMIO traffic is real.

constexpr u32 MBX_OFF_CMD         = 0;
constexpr u32 MBX_OFF_ARG0        = 4;
constexpr u32 MBX_OFF_REQ_READY   = 8;
constexpr u32 MBX_OFF_REPLY       = 12;
constexpr u32 MBX_OFF_REPLY_READY = 16;

EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_mailbox_call_sync(u32 cmd, u32 arg0) {
    if (g_mailbox_base == 0u) return 0u;
    u32* base = reinterpret_cast<u32*>(static_cast<uintptr_t>(g_mailbox_base));
    u32* p_cmd        = base + (MBX_OFF_CMD         / 4);
    u32* p_arg0       = base + (MBX_OFF_ARG0        / 4);
    u32* p_req_ready  = base + (MBX_OFF_REQ_READY   / 4);
    u32* p_reply      = base + (MBX_OFF_REPLY       / 4);
    u32* p_reply_ready = base + (MBX_OFF_REPLY_READY / 4);

    // Reset reply_ready so we can wait on transition 0→1.
    __atomic_store_n(p_reply_ready, 0u, __ATOMIC_RELEASE);
    // Write request fields.
    __atomic_store_n(p_cmd,  cmd,  __ATOMIC_RELAXED);
    __atomic_store_n(p_arg0, arg0, __ATOMIC_RELAXED);
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

// shutdown: stub.
EMSCRIPTEN_KEEPALIVE
void ppc_worker_shutdown() {
#ifdef __EMSCRIPTEN__
    EM_ASM({ console.log('[ppc-worker] shutdown'); });
#endif
}

// version: lets JS verify the loaded wasm matches the protocol it
// expects. Bumped whenever the SAB layout or function signatures change.
EMSCRIPTEN_KEEPALIVE
u32 ppc_worker_version() {
    return 1u;
}

}  // extern "C"

// main: not used in worker mode (we're loaded as a library), but
// emscripten requires SOMETHING. Return 0 immediately; runtime stays
// alive (-s EXIT_RUNTIME=0) so the exported functions remain callable.
int main(int /*argc*/, char** /*argv*/) {
    return 0;
}

// gamecube/ppc-worker/sab_layout.h — shared-memory layout between
// dolphin_worker and ppc-worker.
//
// Both workers' wasm modules import the same SharedArrayBuffer as their
// `env.memory` (via `-sIMPORTED_MEMORY=1`). The page allocates the SAB
// at startup, sized to fit dolphin_worker's existing heap PLUS the
// regions documented below.
//
// Address-space discipline:
//   - dolphin_worker is the OWNER. Its Emscripten heap allocator manages
//     dynamic allocation. PowerPCState and MEM1 are allocated by Dolphin
//     core during init; their addresses are read out of the running
//     instance and POSTed to ppc-worker via the metadata block below.
//   - ppc-worker is a CONSUMER. It does not malloc into shared memory.
//     bementalJIT's per-region BlockCache lives in ppc-worker's PRIVATE
//     heap (Emscripten's separate stack/heap section that the
//     pthread-init code carved out — small, ~8 MB).
//
// The shared SAB therefore has THREE logical regions:
//   1. dolphin_worker's heap (managed by its allocator) — addresses
//      0..N where N depends on Dolphin's runtime layout.
//   2. The SAB_METADATA block (this file's offsets) at a FIXED reserved
//      address, agreed by both sides at build time.
//   3. ppc-worker's reads/writes to PowerPCState (whose address it
//      learned from the metadata) and to MEM1 (likewise).
//
// Phase 2c Step 1 (this commit): defines layout. Workers don't yet
// share memory at runtime — that's the dolphin_worker rebuild step.

#pragma once
#include <cstdint>

namespace bemental_sab {

// Versioning. Bump whenever the layout/protocol changes; both sides
// MUST observe the same version after handshake.
constexpr uint32_t LAYOUT_VERSION = 1;

// ---- Metadata block (fixed offset in shared SAB) ----
// Allocated at the BACK end of the wasm linear memory, far above any
// heap allocations either side would make. dolphin_worker writes this
// block during init and signals ppc-worker to read it.
//
// Reserved range: top 64 KB of the SAB.
//   metadata_base = WASM_MEMORY_SIZE - 0x10000
constexpr uint32_t METADATA_RESERVE_BYTES = 0x10000u;

struct SabMetadata {
    uint32_t magic;              // 'BJWS' = 0x53574A42 (Be-Jit-WorkerS)
    uint32_t version;            // bump on layout change
    uint32_t ppc_state_addr;     // address of PowerPCState in shared SAB
    uint32_t mem1_addr;          // address of MEM1 (24 MB)
    uint32_t mem1_size;          // bytes (typically 0x01800000)
    uint32_t mailbox_addr;       // address of MailboxRingBuffer
    uint32_t mailbox_size;       // bytes
    uint32_t hle_table_addr;     // address of HLE-hook snapshot (Phase 2d)
    uint32_t hle_table_count;    // entries
    // Status flags. ppc-worker observes; dolphin_worker writes.
    uint32_t dolphin_ready;      // 1 = dolphin_worker has populated the metadata
    uint32_t ppc_active;         // ppc-worker writes 1 once it owns dispatch
    uint32_t reserved[20];
};
constexpr uint32_t MAGIC = 0x53574A42u;  // 'BJWS' little-endian

// ---- Mailbox: SPSC ring buffer for ppc→dolphin requests ----
// (compile-this-block, MMIO-read/write, HLE-fire). dolphin→ppc events
// (interrupt delivery, downcount expiry) use Atomics.notify on
// PowerPCState fields directly — no mailbox needed.
//
// Reuses the existing gamecube/ringbuffer.js layout to share JS-side
// helpers. Each slot is a fixed-size record (96 bytes — fits a small
// command header + a few payloads). Capacity 1024 → ~96 KB total.

enum class MailboxCmd : uint32_t {
    None             = 0,
    CompileBlock     = 1,  // payload: pc, body_bytes_addr, body_size
    MmioRead8        = 2,  // payload: addr; reply: value
    MmioRead16       = 3,
    MmioRead32       = 4,
    MmioWrite8       = 5,  // payload: addr, value
    MmioWrite16      = 6,
    MmioWrite32      = 7,
    HleCallbackFire  = 8,  // payload: callback_id, args_addr
    PpcInterp        = 9,  // payload: inst, pc; reply: next_pc
    PpcCheckExc      = 10, // reply: 1 if exception pending
};

struct MailboxRecord {
    uint32_t cmd;            // MailboxCmd
    uint32_t seq;            // sequence # for reply matching
    uint32_t arg0;
    uint32_t arg1;
    uint32_t arg2;
    uint32_t reply;          // ppc-worker writes; dolphin reads after notify
    uint32_t reply_ready;    // atomic; ppc waits via Atomics.wait
    uint32_t reserved[17];   // pad to 96 bytes
};
static_assert(sizeof(MailboxRecord) == 96, "MailboxRecord must be 96B");

constexpr uint32_t MAILBOX_CAPACITY = 1024u;
constexpr uint32_t MAILBOX_BYTES = MAILBOX_CAPACITY * sizeof(MailboxRecord);

}  // namespace bemental_sab

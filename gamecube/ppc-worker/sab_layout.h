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

// ---- MMIO mirror (Phase A1) ------------------------------------------------
// A 256 KB SAB region mirroring the guest MMIO window
// 0xCC000000 .. 0xCC040000. Dolphin keeps the mirror current on every
// internal register update; ppc-worker JIT'd code reads the mirror
// directly via i32.load offset=MMIO_MIRROR_ADDR+(ea-MMIO_GUEST_BASE),
// avoiding the synchronous mailbox round-trip that previously dominated
// per-instruction cost (see ppc_worker_2e4_to_2g.md).
//
// Eight register windows live inside this 256 KB:
//   CP   0xCC000000  (FIFO control + metrics; FIFO data at 0xCC008000
//                     is a separate streaming-write path, NOT mirrored)
//   VI   0xCC002000
//   PI   0xCC003000
//   AR   0xCC005000  (ARAM DMA + DSP mailboxes)
//   DI   0xCC006000
//   SI   0xCC006400
//   AI   0xCC006C00
//   (gaps elsewhere — mirror page is intentionally oversized for
//   simplicity; unused offsets are 0-filled and never accessed.)
//
// Stage 1 (current): JIT'd reads of NON-SIDE-EFFECT cells hit the
// mirror directly. JIT'd reads of READ-SIDE-EFFECT cells (7 known) and
// ALL writes still mailbox dolphin. Dolphin owns canonical storage and
// writes through to the mirror; ppc-worker is read-only against this
// region until stage 2.
//
// Stage 2 (future): direct-write cells (no handler side effects) emit
// i32.store to the mirror without mailboxing. Requires dolphin's
// register-file readers (PI IRQ logic etc.) to read from the SAB
// mirror instead of local struct members so a single source of truth
// remains. Out of A1 scope; A1.b classification table is laid out to
// support the cutover.

// 0x02100000 is already taken by WASM_SCRATCH_OFFSET in gamecube.html.
// 0x02400000 is PowerPCState. 0x02500000 is the yield flag. Park the
// mirror + cls tables above all of those, at 0x02600000 onward.
constexpr uint32_t MMIO_MIRROR_ADDR  = 0x02600000u;
constexpr uint32_t MMIO_MIRROR_BYTES = 0x00040000u;  // 256 KB

constexpr uint32_t MMIO_GUEST_BASE   = 0xCC000000u;
constexpr uint32_t MMIO_GUEST_LIMIT  = 0xCC040000u;  // exclusive

// True when a constant guest EA falls within the mirrored window.
// Used by gekko_emit's lis-then-load/store peephole to decide between
// direct mirror access and the runtime fastmem path.
constexpr inline bool mmio_in_range(uint32_t ea) {
    return ea >= MMIO_GUEST_BASE && ea < MMIO_GUEST_LIMIT;
}

// Mirror offset within the SAB for a given guest EA. Caller must have
// verified mmio_in_range(ea) first.
constexpr inline uint32_t mmio_mirror_offset(uint32_t ea) {
    return MMIO_MIRROR_ADDR + (ea - MMIO_GUEST_BASE);
}

// Cell classification. Used by both the emitter (decides which path to
// emit) and dolphin's write-through bridge (decides which writes need
// to also propagate to the mirror — all of them, but the table is
// where the registry lives).
//
// One classification per (ea, access_size). 8/16/32-bit accesses to
// the same address can have different classifications because
// dolphin's MMIO::HandlerArray is per-size.
enum class MmioCellClass : uint8_t {
    UNMAPPED = 0,    // EA not registered with dolphin's MMIO::Init;
                     // emit traps or falls back to mailbox.
    DIRECT_RW = 1,   // DirectRead + DirectWrite. Read from mirror;
                     // stage-1 still mailboxes write, stage-2 won't.
    READ_SE = 2,     // ComplexRead with side effects (clears flag,
                     // computes dynamic value, invokes emulator).
                     // Read MUST mailbox; write may be either.
    WRITE_SE = 3,    // DirectRead but ComplexWrite with side effects
                     // (IRQ update, DMA trigger, event schedule).
                     // Read from mirror; write MUST mailbox.
    READ_WRITE_SE = 4, // Both sides have side effects. Both mailbox.
    CONSTANT = 5,    // Read returns a fixed immediate (CP metrics,
                     // CONSTANT handlers). Read can fold to const at
                     // emit time; write is typically NOOP/Invalid.
};

// ---- MMIO classification tables (Phase A1.b) ------------------------------
// Dolphin populates these at retro_load_game by walking its MMIO::Mapping
// with ReadHandlingMethodVisitor / WriteHandlingMethodVisitor (already
// in dolphin-src/Source/Core/Core/HW/MMIOHandlers.h). One byte per EA
// cell, value from MmioCellClass. ppc-worker's emitter reads these
// tables at compile time to decide between fast-path mirror load and
// mailbox round-trip. Stored in SAB so the choice survives across
// dolphin and ppc-worker restarts.
//
// Two parallel tables — 16-bit and 32-bit access — because dolphin's
// HandlerArray classifies per access size. The same EA can be Direct
// for one size and Complex for another (e.g. CP STATUS_REGISTER is
// only registered for 16-bit). 8-bit MMIO is rare; deferred to stage 2.
//
// Indexing:
//   cls16[(ea - MMIO_GUEST_BASE) / 2]
//   cls32[(ea - MMIO_GUEST_BASE) / 4]
//
// EAs that are not registered with dolphin's MMIO::Init default to
// UNMAPPED (== 0). Emitter sees UNMAPPED → falls through to mailbox,
// matching today's behavior.

constexpr uint32_t MMIO_CLS16_ADDR  = 0x02640000u;
constexpr uint32_t MMIO_CLS16_BYTES = 0x00020000u;  // 128 KB (1 byte/16-bit EA)

constexpr uint32_t MMIO_CLS32_ADDR  = 0x02660000u;
constexpr uint32_t MMIO_CLS32_BYTES = 0x00010000u;  // 64 KB (1 byte/32-bit EA)

// Reserved 0x02670000..0x02680000 for stage-2 extensions: CONSTANT-
// value lookup, 8-bit cls table, write-classification (for stage-2
// direct-write opt-in).

constexpr inline uint32_t mmio_cls16_offset(uint32_t ea) {
    return MMIO_CLS16_ADDR + (ea - MMIO_GUEST_BASE) / 2u;
}
constexpr inline uint32_t mmio_cls32_offset(uint32_t ea) {
    return MMIO_CLS32_ADDR + (ea - MMIO_GUEST_BASE) / 4u;
}

// Compact descriptor — kept for future use (e.g. an enumerable table
// that ships alongside the cls arrays). Stage 1 uses the byte arrays
// directly.
struct MmioCellDesc {
    uint32_t guest_ea;          // 0xCCxxxxxx
    uint16_t access_size_bits;  // 8/16/32
    uint16_t cls;               // MmioCellClass
    uint32_t constant_value;    // valid iff cls == CONSTANT
};

}  // namespace bemental_sab

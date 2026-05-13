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
    HleCallbackFire  = 8,  // payload: callback_id, args_addr (legacy HleCheck, see ppc_worker.js cmd map)
    PpcInterp        = 9,  // payload: inst, pc; reply: next_pc
    PpcCheckExc      = 10, // reply: 1 if exception pending
    // 11 = BreakBlock, 12 = ReadTb (see ppc_worker.js)
    // 13 = CompileBlockRoute (see 4f-5 / 2d.4)
    HleFire          = 14, // Item 5: ppc-worker -> dolphin HLE::ExecuteFromJIT.
                           //   payload: pc, hook_index (low 16 bits) | (hook_type << 16)
                           //   reply:   next_pc (lr-after-execute for Replace,
                           //                     pc unchanged for Start)
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

// 0x02670000..0x02680000 (64 KB) — Item 6 MMIO Stage 2: pending-writes
// SPSC ring (was "reserved for stage-2 extensions"). Stage 2 carves
// this region into a fixed-size header + 4096 records of
// {cmd, size, ea, val} (16 B each). See PendingWritesRing struct below.

constexpr inline uint32_t mmio_cls16_offset(uint32_t ea) {
    return MMIO_CLS16_ADDR + (ea - MMIO_GUEST_BASE) / 2u;
}
constexpr inline uint32_t mmio_cls32_offset(uint32_t ea) {
    return MMIO_CLS32_ADDR + (ea - MMIO_GUEST_BASE) / 4u;
}

// ---- Item 6 Stage 2: pending-writes SPSC ring ----
//
// 64 KB region holds 4096 fixed-size records (16 B each, header is
// the first 16 B). ppc-worker (producer) writes records and bumps
// head; dolphin (consumer) reads records and bumps tail. Both
// indices are atomic u32s in the header.
//
// Layout at PWR_BASE_ADDR:
//   +0x00  u32 magic        ('PWR0' sentinel, set at init time)
//   +0x04  u32 version
//   +0x08  u32 head         (producer-owned, monotonic; index = head % capacity)
//   +0x0C  u32 tail         (consumer-owned, monotonic)
//   +0x10  u32 capacity     (== PWR_CAPACITY)
//   +0x14  u32 enq_count    (diag: total enqueues since init)
//   +0x18  u32 drop_count   (diag: producer attempted enqueue when ring full)
//   +0x1C  u32 drain_count  (diag: total records drained by dolphin)
//   +0x20  reserved (zeroed) up to PWR_RECORDS_OFF
//   +0x100 PendingWriteRecord[PWR_CAPACITY]
//
// Each record is exactly 16 B (cmd:u8, size_bits:u8, _pad:u16, ea:u32,
// val:u32, seq:u32). `cmd` selects the dolphin-side write handler
// (MailboxCmd::MmioWrite8/16/32). `seq` is the producer's head value
// at enqueue time — drainer uses it to detect head-rollover races.
constexpr uint32_t PWR_BASE_ADDR    = 0x02670000u;
constexpr uint32_t PWR_BYTES        = 0x00010000u;  // 64 KB
constexpr uint32_t PWR_CAPACITY     = 4096u;
constexpr uint32_t PWR_RECORDS_OFF  = 0x100u;       // header is the first 256 B

constexpr uint32_t PWR_OFF_MAGIC       = 0x00u;
constexpr uint32_t PWR_OFF_VERSION     = 0x04u;
constexpr uint32_t PWR_OFF_HEAD        = 0x08u;
constexpr uint32_t PWR_OFF_TAIL        = 0x0Cu;
constexpr uint32_t PWR_OFF_CAPACITY    = 0x10u;
constexpr uint32_t PWR_OFF_ENQ_COUNT   = 0x14u;
constexpr uint32_t PWR_OFF_DROP_COUNT  = 0x18u;
constexpr uint32_t PWR_OFF_DRAIN_COUNT = 0x1Cu;

constexpr uint32_t PWR_MAGIC       = 0x30525750u;  // 'PWR0' little-endian
constexpr uint32_t PWR_VERSION     = 1u;

// Record cmd values — match MailboxCmd::MmioWriteN so a future drainer
// that wants to route into the existing mailbox dispatcher can do so
// without remapping.
constexpr uint8_t PWR_CMD_W8  = 5u;
constexpr uint8_t PWR_CMD_W16 = 6u;
constexpr uint8_t PWR_CMD_W32 = 7u;

struct PendingWriteRecord {
    uint8_t  cmd;        // PWR_CMD_W8/W16/W32
    uint8_t  size_bits;  // 8 / 16 / 32 — redundant with cmd, kept for sanity
    uint16_t _pad;
    uint32_t ea;
    uint32_t val;
    uint32_t seq;        // head value at enqueue time
};
static_assert(sizeof(PendingWriteRecord) == 16, "PendingWriteRecord must be 16B");

constexpr inline uint32_t pwr_record_addr(uint32_t slot) {
    return PWR_BASE_ADDR + PWR_RECORDS_OFF + slot * sizeof(PendingWriteRecord);
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

// ---- CoreTiming shared event queue (Item 7 Phase I) ------------------------
// See gamecube/notes/item7_coretiming_design.md for the full design.
//
// Region at 0x02680000. Holds events that ppc-worker may fire directly
// (CT_EV_DECREMENTER) and events whose cadence ppc-worker may advance
// while signaling dolphin to run the side-effect (VI/DSP/AI/etc.).
//
// Phase I scope: layout + struct only. Queue is initialized empty.
// Dolphin's CoreTiming::m_event_queue is untouched.

constexpr uint32_t CT_QUEUE_ADDR        = 0x02680000u;
constexpr uint32_t CT_QUEUE_BYTES       = 0x00002000u;  // 8 KB — header + 256 records w/ headroom
constexpr uint32_t CT_QUEUE_CAPACITY    = 256u;
constexpr uint32_t CT_QUEUE_RECORDS_OFF = 0x80u;        // records start at +0x80 from header base
constexpr uint32_t CT_QUEUE_MAGIC       = 0x4351544Bu;  // 'KTQC' little-endian sentinel

// Header offsets (relative to CT_QUEUE_ADDR). All atomic-friendly u32.
constexpr uint32_t CT_OFF_MAGIC                = 0x00u;
constexpr uint32_t CT_OFF_GLOBAL_TIMER_LO      = 0x08u;
constexpr uint32_t CT_OFF_GLOBAL_TIMER_HI      = 0x0Cu;
constexpr uint32_t CT_OFF_SLICE_LENGTH         = 0x10u;
constexpr uint32_t CT_OFF_EVENT_SEQ            = 0x14u;
constexpr uint32_t CT_OFF_EVENT_COUNT          = 0x18u;
constexpr uint32_t CT_OFF_DOLPHIN_PENDING_MASK = 0x20u;
constexpr uint32_t CT_OFF_PPC_PENDING_SCHEDULE = 0x24u;
constexpr uint32_t CT_OFF_WRITER_OWNER         = 0x28u;
constexpr uint32_t CT_OFF_CADENCE_BASE         = 0x40u;  // cadence[8] follow (u32 each)

// Per-record layout — 24 bytes. 256 * 24 = 6 KB, fits inside CT_QUEUE_BYTES.
struct CtEventRecord {
    int32_t  time_lo;        // s64 absolute sim time, lo word
    int32_t  time_hi;        //                        hi word
    uint32_t event_type_id;  // CtEventTypeId
    uint32_t userdata_lo;
    uint32_t userdata_hi;
    uint32_t flags;          // CT_FLAG_*
};
static_assert(sizeof(CtEventRecord) == 24, "CtEventRecord must be 24B");

// Flag bits (CtEventRecord::flags). Distinct from each other so a
// future debugger can tell "valid but never fired" from "tombstoned".
constexpr uint32_t CT_FLAG_VALID    = 0x1u;  // entry is live (set by writer)
constexpr uint32_t CT_FLAG_PURE_PPC = 0x2u;  // ppc-worker may fire callback in-loop
constexpr uint32_t CT_FLAG_HYBRID   = 0x4u;  // ppc bumps cadence + signals dolphin
constexpr uint32_t CT_FLAG_REMOVED  = 0x8u;  // tombstoned, awaiting compaction

// Event-type registry. Values < CT_EV_DOLPHIN_OPAQUE are interpreted
// by ppc-worker; >= are dolphin-private (never published into the
// shared queue under the Phase III plan).
enum CtEventTypeId : uint32_t {
    CT_EV_NONE           = 0u,
    CT_EV_DECREMENTER    = 1u,  // pure-PPC; sets SPR_DEC=0xFFFFFFFF + EXCEPTION_DECREMENTER
    CT_EV_VI             = 2u,  // hybrid (Phase III)
    CT_EV_DSP            = 3u,  // hybrid
    CT_EV_AUDIO_DMA      = 4u,  // hybrid
    CT_EV_AI             = 5u,  // hybrid
    CT_EV_GPU_SLEEPER    = 6u,  // hybrid (cheap no-op IRQ-wise)
    CT_EV_PATCH_ENGINE   = 7u,  // hybrid (per VI field)
    CT_EV_DOLPHIN_OPAQUE = 64u, // sentinel — opaque to ppc-worker
};

// ---- Item 7 Phases II/III additions ----
// Bit positions in ct_dolphin_pending_mask. ppc-worker sets the bit
// when it fires a hybrid event's cadence; dolphin's outer Run() heartbeat
// polls the mask, atomically clears it, and runs the corresponding
// C++ callback (which touches device state and posts to GPU/audio).
//
// Bit 31 (CT_PEND_DEC_PREFIRED) is a Phase II coherence hint — ppc-worker
// sets it when it fires the pure DEC locally. Dolphin's heartbeat can
// observe it for diagnostics; the DEC effect (spr[SPR_DEC]=0xFFFFFFFF +
// Exceptions|=EXCEPTION_DECREMENTER) is idempotent so even if dolphin's
// local DEC also fires the result is unchanged.
constexpr uint32_t CT_PEND_VI            = 1u << 0;
constexpr uint32_t CT_PEND_DSP           = 1u << 1;
constexpr uint32_t CT_PEND_AUDIO_DMA     = 1u << 2;
constexpr uint32_t CT_PEND_AI            = 1u << 3;
constexpr uint32_t CT_PEND_GPU_SLEEPER   = 1u << 4;
constexpr uint32_t CT_PEND_PATCH_ENGINE  = 1u << 5;
constexpr uint32_t CT_PEND_DEC_PREFIRED  = 1u << 31;

// Phase III runtime gate. Default 0 = off (Phase II only). Dolphin
// writes this once at retro_load_game / via a setter. When 0, ppc-worker
// MUST NOT fire hybrid events even if shared-queue entries exist. Phase
// IV/V flags are reserved for future work.
constexpr uint32_t CT_OFF_PHASE_FLAGS    = 0x2Cu;  // u32 within queue header
constexpr uint32_t CT_PHASE3_ENABLE      = 1u << 0;  // hybrid mirror on
constexpr uint32_t CT_PHASE4_ENABLE      = 1u << 1;  // cadence handoff on (reserved)
constexpr uint32_t CT_PHASE5_ENABLE      = 1u << 2;  // retire local Advance for pure (reserved)

// Map an event type id to its dolphin-pending-mask bit, or 0 if the
// event does not have a hybrid bit (pure-PPC events return 0).
constexpr inline uint32_t ct_event_pending_bit(uint32_t event_type_id) {
    switch (event_type_id) {
        case CT_EV_VI:            return CT_PEND_VI;
        case CT_EV_DSP:           return CT_PEND_DSP;
        case CT_EV_AUDIO_DMA:     return CT_PEND_AUDIO_DMA;
        case CT_EV_AI:            return CT_PEND_AI;
        case CT_EV_GPU_SLEEPER:   return CT_PEND_GPU_SLEEPER;
        case CT_EV_PATCH_ENGINE:  return CT_PEND_PATCH_ENGINE;
        default:                  return 0u;
    }
}

// Address helpers for the record array.
constexpr inline uint32_t ct_record_addr(uint32_t index) {
    return CT_QUEUE_ADDR + CT_QUEUE_RECORDS_OFF + index * sizeof(CtEventRecord);
}

// ---- HLE hook table snapshot (Item 5) ----------------------------------------
// 1024-slot direct-mapped hash table (open addressing, linear probe).
// Each slot is 8 bytes: {u32 pc, u32 hook_index_or_flags}. Total 8 KB.
//
// pc == 0 ⇒ empty slot (PC 0 is never a valid HLE-patched address —
// MEM1 starts at 0x80000000 cached / 0x80003100 game code).
//
// Slot.hook_index_or_flags packs:
//   bits  0..15  hook_index (1..255 in practice; the os_patches[] array
//                 currently has 56 entries, plenty of headroom)
//   bits 16..23  hook_type  (1 = Start, 2 = Replace; per HLE::HookType)
//   bits 24..31  reserved
//
// The 1024 size is a build-time constant — 2× peak observed entries
// (~300 for SAB after PatchFunctions, ~similar for PSO). At 1024 with
// load factor < 0.3, hash collisions are rare and inline linear probe
// of 4 slots is sufficient.
//
// Hash: ((pc >> 2) * 0x9E3779B1u) & (HLE_TABLE_SLOTS - 1u). Same constant
// is mirrored in gekko_emit.cpp::emit_hle_check_native_*; dolphin's
// HLE::ExportSnapshot uses the same formula to place entries.
//
// Region 0x02680000..0x02682000 is taken by CoreTiming (CT queue,
// 8 KB). 0x02690000 is the next 64 KB-aligned free slot; reserve
// 0x02690000..0x026A0000 (64 KB) so future tweaks (e.g. 2048 slots)
// still fit without a layout bump.
constexpr uint32_t HLE_TABLE_ADDR  = 0x02690000u;
constexpr uint32_t HLE_TABLE_SLOTS = 1024u;
constexpr uint32_t HLE_TABLE_MASK  = HLE_TABLE_SLOTS - 1u;
constexpr uint32_t HLE_SLOT_BYTES  = 8u;  // sizeof({u32 pc, u32 idx_or_flags})
constexpr uint32_t HLE_TABLE_BYTES = HLE_TABLE_SLOTS * HLE_SLOT_BYTES;  // 8 KB
constexpr uint32_t HLE_TABLE_PROBE = 4u;  // max linear probe before fallback (emitter inlines this many)

// Multiplicative hash constant (Knuth's golden-ratio fraction × 2^32,
// rounded; same value used everywhere — emitter, dolphin writer, JS
// diag readers). PC is 4-byte aligned so shift right by 2 first.
constexpr uint32_t HLE_HASH_MULTIPLIER = 0x9E3779B1u;

// Hook-type encoding within slot.hook_index_or_flags (matches
// HLE::HookType values used by dolphin). Replace = block exits via
// LR (Replace semantics); Start = block continues at pc (Start
// semantics, real function still runs).
constexpr uint32_t HLE_HTYPE_START   = 1u;
constexpr uint32_t HLE_HTYPE_REPLACE = 2u;

// Pack/unpack helpers.
constexpr inline uint32_t hle_pack_slot(uint32_t hook_index, uint32_t hook_type) {
    return (hook_index & 0xFFFFu) | ((hook_type & 0xFFu) << 16);
}
constexpr inline uint32_t hle_unpack_index(uint32_t slot_v) { return slot_v & 0xFFFFu; }
constexpr inline uint32_t hle_unpack_type (uint32_t slot_v) { return (slot_v >> 16) & 0xFFu; }

// Hash → starting bucket index (in slots, not bytes). Caller probes
// (h+0), (h+1), ... up to HLE_TABLE_PROBE times before bailing.
constexpr inline uint32_t hle_hash_bucket(uint32_t pc) {
    return ((pc >> 2) * HLE_HASH_MULTIPLIER) & HLE_TABLE_MASK;
}

// Byte offset of slot[i] within the SAB.
constexpr inline uint32_t hle_slot_pc_offset (uint32_t slot_idx) {
    return HLE_TABLE_ADDR + slot_idx * HLE_SLOT_BYTES + 0u;
}
constexpr inline uint32_t hle_slot_idx_offset(uint32_t slot_idx) {
    return HLE_TABLE_ADDR + slot_idx * HLE_SLOT_BYTES + 4u;
}

// ---------------------------------------------------------------------------
// Phase 2e cache-warmup (Option 3 hybrid) — shadow-publish SPSC ring.
//
// dolphin's bementalJIT publishes a {pc, region, body_size} record into this
// ring every time a block is added to its cache. ppc-worker's drain loop
// pops records and calls compile_and_accumulate(pc), warming its own cache
// continuously during dolphin-owned dispatch — so when the user later arms
// ?ppcbootdispatch=1, the post-cutover dispatch path doesn't pay ~85 ms per
// first-touch compile.
//
// Layout (relative to SHADOW_RING_ADDR):
//   +0x00  u32 head   (producer cursor, monotonic; atomic RELAXED load /
//                      RELEASE store from dolphin pthread)
//   +0x04  u32 tail   (consumer cursor, monotonic; atomic ACQUIRE load /
//                      RELEASE store from ppc-worker)
//   +0x08  u32 enq_count   (cumulative enqueued, diag-only)
//   +0x0C  u32 drop_count  (cumulative dropped on overflow, diag-only)
//   +0x40  ShadowRecord[CAPACITY], 16 bytes each
//
// Reserve 0x026A0000..0x026B0000 (64 KB). 16384 records * 16 B = 256 KB
// would overrun; cap capacity at 4096 to fit in the 64 KB slot.
constexpr uint32_t SHADOW_RING_ADDR      = 0x026A0000u;
constexpr uint32_t SHADOW_RING_CAPACITY  = 4096u;
constexpr uint32_t SHADOW_RING_HEAD_OFF  = 0x00u;
constexpr uint32_t SHADOW_RING_TAIL_OFF  = 0x04u;
constexpr uint32_t SHADOW_RING_ENQ_OFF   = 0x08u;
constexpr uint32_t SHADOW_RING_DROP_OFF  = 0x0Cu;
constexpr uint32_t SHADOW_RING_DATA_OFF  = 0x40u;
struct ShadowRecord {
    uint32_t pc;
    uint32_t region;     // 0..8; REGION_COUNT for per-block (non-region) compile
    uint32_t size;       // body byte size (informational)
    uint32_t reserved;   // 0
};

}  // namespace bemental_sab

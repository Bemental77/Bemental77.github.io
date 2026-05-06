#pragma once
//
// SAB counter block — fixed-offset shared layout for bementalJIT performance
// telemetry. Single source of truth shared by bementalCompiler emit code,
// JitWasm dispatch code, and the JS probe driver (gamecube/tools/wild-perf.mjs).
//
// All slots are u64 (8 bytes), little-endian. Slot indices are u64-stride so
// JS code using BigUint64Array can index directly: bigU64[PERF_SLOT_*].
//
// Counters are monotonic; gauges are sampled. Owner column names which
// bementalJIT module (per bementalJIT_module_decomposition_2026_05_05.md)
// is responsible for the write. Probe driver reads via Atomics.load on
// BigUint64Array; writers use plain stores plus a release fence on the
// wild_ct_ticks slot to publish a coherent sample window.
//
// Adding a counter: append at the next free slot (do not reorder), bump
// PERF_SLOT_COUNT, mirror in JS probe driver.

#include "bementalCompiler/types.h"

namespace bemental {

enum PerfSlot : u32 {
    // -------- ppc-emit (the JIT itself) --------
    PERF_SLOT_WILD_CT_TICKS        = 0,   // PPC TBR ticks (CPU/12 = 40.5 MHz)
    PERF_SLOT_INTERP_FALLBACK      = 1,   // opcodes hitting SingleStepInner
    PERF_SLOT_FASTMEM_HITS         = 2,   // lwz/stw direct i32.load/store
    PERF_SLOT_FASTMEM_SLOW         = 3,   // lwz/stw via WIMPORT_READ32/WRITE32
    PERF_SLOT_IDLE_SKIP            = 4,   // busy-wait blocks short-circuited

    // -------- dolphin-bridge (HW emulation linkage) --------
    PERF_SLOT_WALL_ANCHOR_MS       = 8,   // performance.now() at last sync
    PERF_SLOT_INTERRUPT_RAISE      = 9,   // Atomics.notify into PPC worker
    PERF_SLOT_HLE_CALLBACK         = 10,  // HLE callbacks executed

    // -------- block-cache (long-lived emit module + link patching) --------
    PERF_SLOT_BLOCK_EMIT           = 16,  // blocks emitted into current module
    PERF_SLOT_BLOCK_LINK           = 17,  // intra-module return_call links
    PERF_SLOT_BLOCK_LINK_HITS      = 18,  // linked branches taken
    PERF_SLOT_MODULE_AGE_MS        = 19,  // wall-time current module alive
    PERF_SLOT_TIER_UP              = 20,  // Liftoff→TurboFan (heuristic)

    // -------- compile-pool (parallel WebAssembly.compile) --------
    PERF_SLOT_COMPILE_PENDING      = 24,  // gauge: queued jobs
    PERF_SLOT_COMPILE_DONE         = 25,  // counter: completed jobs
    PERF_SLOT_COMPILE_TOTAL_MS     = 26,  // sum; avg = total / done

    // -------- gx-bridge (FIFO recognition) --------
    PERF_SLOT_FIFO_FLUSH           = 32,  // CP FIFO flushes routed to GPU

    // -------- gpu-backend (WebGPU / WebGL2) --------
    PERF_SLOT_XFB_PRESENT          = 40,  // XFBs presented to canvas

    // Sentinel — bump when adding new slots.
    PERF_SLOT_COUNT                = 48,
};

constexpr u32 PERF_SLOT_STRIDE_BYTES = 8;
constexpr u32 PERF_BLOCK_BYTES       = PERF_SLOT_COUNT * PERF_SLOT_STRIDE_BYTES;

// Returns the byte offset of a slot inside the SAB counter block.
constexpr u32 perf_offset(PerfSlot s) {
    return static_cast<u32>(s) * PERF_SLOT_STRIDE_BYTES;
}

// Counter block lives at a fixed location inside the bementalJIT SAB region.
// Probe driver reads from this offset; emit code writes at the same offset.
// Chosen well above ppc_state to leave room for future state expansion.
constexpr u32 PERF_BLOCK_SAB_OFFSET = 0x10000;

}  // namespace bemental

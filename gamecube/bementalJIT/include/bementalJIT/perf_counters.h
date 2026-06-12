#pragma once
//
// SAB counter block — fixed-offset shared layout for bementalJIT performance
// telemetry. Mirror of bementalCompiler/include/bementalCompiler/perf_counters.h.
// Keep the two files identical except for the namespace name. If you add a
// slot here, add it there too.
//
// All slots are u64 (8 bytes), little-endian. Slot indices are u64-stride so
// JS code using BigUint64Array can index directly: bigU64[PERF_SLOT_*].
//
// See bementalJIT_module_decomposition_2026_05_05.md for owner module names.

#include "bementalJIT/types.h"

namespace bemental {

enum PerfSlot : u32 {
    // -------- ppc-emit --------
    PERF_SLOT_WILD_CT_TICKS        = 0,
    PERF_SLOT_INTERP_FALLBACK      = 1,
    PERF_SLOT_FASTMEM_HITS         = 2,
    PERF_SLOT_FASTMEM_SLOW         = 3,
    PERF_SLOT_IDLE_SKIP            = 4,

    // -------- dolphin-bridge --------
    PERF_SLOT_WALL_ANCHOR_MS       = 8,
    PERF_SLOT_INTERRUPT_RAISE      = 9,
    PERF_SLOT_HLE_CALLBACK         = 10,

    // -------- block-cache --------
    PERF_SLOT_BLOCK_EMIT           = 16,
    PERF_SLOT_BLOCK_LINK           = 17,
    PERF_SLOT_BLOCK_LINK_HITS      = 18,
    PERF_SLOT_MODULE_AGE_MS        = 19,
    PERF_SLOT_TIER_UP              = 20,

    // -------- compile-pool --------
    PERF_SLOT_COMPILE_PENDING      = 24,
    PERF_SLOT_COMPILE_DONE         = 25,
    PERF_SLOT_COMPILE_TOTAL_MS     = 26,

    // -------- gx-bridge --------
    PERF_SLOT_FIFO_FLUSH           = 32,

    // -------- gpu-backend --------
    PERF_SLOT_XFB_PRESENT          = 40,

    PERF_SLOT_COUNT                = 48,
};

constexpr u32 PERF_SLOT_STRIDE_BYTES = 8;
constexpr u32 PERF_BLOCK_BYTES       = PERF_SLOT_COUNT * PERF_SLOT_STRIDE_BYTES;

constexpr u32 perf_offset(PerfSlot s) {
    return static_cast<u32>(s) * PERF_SLOT_STRIDE_BYTES;
}

constexpr u32 PERF_BLOCK_SAB_OFFSET = 0x10000;

}  // namespace bemental

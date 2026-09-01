// SAB counter block — JS mirror of bementalCompiler/include/bementalCompiler/perf_counters.h.
// Single source of truth for the probe driver (wild-perf.mjs) and any UI
// that wants to read counters from the bementalJIT SAB region.
//
// All slots are u64 little-endian; index a BigUint64Array view with PERF_SLOT.*
// to read a slot directly. Block lives at byte offset PERF_BLOCK_SAB_OFFSET
// inside the bementalJIT SAB region.

export const PERF_SLOT = Object.freeze({
    // ---- ppc-emit ----
    WILD_CT_TICKS:        0,
    INTERP_FALLBACK:      1,
    FASTMEM_HITS:         2,
    FASTMEM_SLOW:         3,
    IDLE_SKIP:            4,

    // ---- dolphin-bridge ----
    WALL_ANCHOR_MS:       8,
    INTERRUPT_RAISE:      9,
    HLE_CALLBACK:         10,

    // ---- block-cache ----
    BLOCK_EMIT:           16,
    BLOCK_LINK:           17,
    BLOCK_LINK_HITS:      18,
    MODULE_AGE_MS:        19,
    TIER_UP:              20,

    // ---- compile-pool ----
    COMPILE_PENDING:      24,
    COMPILE_DONE:         25,
    COMPILE_TOTAL_MS:     26,

    // ---- gx-bridge ----
    FIFO_FLUSH:           32,

    // ---- gpu-backend ----
    XFB_PRESENT:          40,
});

export const PERF_SLOT_COUNT       = 48;
export const PERF_SLOT_STRIDE_BYTES = 8;
export const PERF_BLOCK_BYTES      = PERF_SLOT_COUNT * PERF_SLOT_STRIDE_BYTES;
export const PERF_BLOCK_SAB_OFFSET = 0x10000;

// Open a BigUint64Array view over the perf block inside an SAB.
export function openPerfView(sab) {
    return new BigUint64Array(sab, PERF_BLOCK_SAB_OFFSET, PERF_SLOT_COUNT);
}

// Atomic-load a single slot. Returns BigInt.
export function readSlot(view, slot) {
    return Atomics.load(view, slot);
}

// Snapshot the entire block. Returns a plain object keyed by PERF_SLOT name.
export function snapshot(view) {
    const out = {};
    for (const [name, idx] of Object.entries(PERF_SLOT)) {
        out[name] = Atomics.load(view, idx);
    }
    return out;
}

// Compute native PowerPC speed ratio from a window of two snapshots.
// 486 MHz CPU = TBR rate (CPU/12) of 40.5 MHz.
// native_ratio = (delta_ticks * 12) / (delta_wall_ms * 1e-3 * 486_000_000)
//              = (delta_ticks * 12 * 1000) / (delta_wall_ms * 486_000_000)
export function nativeRatio(prevSnap, currSnap) {
    const dTicks = currSnap.WILD_CT_TICKS - prevSnap.WILD_CT_TICKS;
    const dWall  = currSnap.WALL_ANCHOR_MS - prevSnap.WALL_ANCHOR_MS;
    if (dWall === 0n) return 0;
    // BigInt division loses precision; convert at the end.
    const num = Number(dTicks) * 12 * 1000;
    const den = Number(dWall) * 486_000_000;
    return num / den;
}

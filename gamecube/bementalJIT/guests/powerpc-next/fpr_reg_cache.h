#pragma once
//
// FPRRegCache — per-block PPC-FPR → WASM-i64-local binding. Parallel to
// RegCache (GPR cache), modeled on Dolphin Jit64's FPURegCache (Source/Core/
// Core/PowerPC/Jit64/RegCache/FPURegCache.{h,cpp}, GPL-2.0-or-later).
//
// Storage model: TWO i64 wasm locals per FPR (ps0_local[32] + ps1_local[32]).
// Indices: [wasm_local_base..wasm_local_base+31] = ps0 lanes,
//          [wasm_local_base+32..wasm_local_base+63] = ps1 lanes.
//
// Why i64 (not f64) — bit-exactness. emit_ps_bit_op (jit_paired.cpp:35-53),
// emit_ps_copy_halves (jit_paired.cpp:56-67), and emit_fmrx
// (jit_floating_point.cpp:30-40) are all i64 bit-copies today, preserving
// NaN payload + signed zero exactly. f64-typed locals would force wasm
// engines through normalization on some local.set paths and break bit-
// exactness on signaling NaNs. f64-arith use sites bridge via
// op_f64_reinterpret_i64 / op_i64_reinterpret_f64 (zero-cost wasm ops per
// wasm_module_builder.h:645-647).
//
// No immediate tracking — matches Jit64 FPURegCache.cpp:16-31 which asserts
// no immediates for FPRs.
//
// Lane-mask Bind semantics. A scalar FP op (fmr/fneg/...) writes only ps0;
// a paired op writes both lanes. The Bind(preg, mode, lane_mask) lane_mask
// has bit0=ps0, bit1=ps1. In Write mode, only lanes in lane_mask are marked
// dirty (so a scalar Write on fd doesn't dirty ps1 and won't flush stale
// ps1 to memory). Read-mode lazy-loads any requested lane that hasn't been
// loaded yet — same fallback shape as RegCache::Bind for analyzer-blind ops.

#include "bementalJIT/types.h"
#include "common/bit_set.h"

class WasmModuleBuilder;  // global namespace — bementalJIT/wasm_module_builder.h

namespace bemental::powerpc {

struct CodeBlock;
class FPRRegCache;

// Lane-mask convention — bit 0 = ps0, bit 1 = ps1.
constexpr u8 FPR_LANE_PS0 = 0x1;
constexpr u8 FPR_LANE_PS1 = 0x2;
constexpr u8 FPR_LANE_BOTH = FPR_LANE_PS0 | FPR_LANE_PS1;

enum class FPRMode {
    Read,
    Write,
    ReadWrite,
};

// Result of a Bind — the two wasm-local indices for the FPR's two lanes.
// The emit site consumes only the lanes it cares about; the other index is
// still valid (the lane is allocated/loaded as needed by Bind itself based
// on lane_mask).
struct RCFprPair {
    u32 ps0_idx = 0;
    u32 ps1_idx = 0;
};

class FPRRegCache {
public:
    explicit FPRRegCache(WasmModuleBuilder& wb);

    // Layout the per-block WASM-local assignment from the analyzer's output.
    // `wasm_local_base` is the index of the first WASM local reserved for
    // FPR caching (callers must declare 64 contiguous i64 locals starting
    // at this index). `ctx_ptr` is PowerPCState base, stamped for lazy-load
    // fallback when the analyzer's m_fpr_inputs is incomplete (e.g. psq_*
    // whose opinfo flags may not express FPR reads).
    void OnBlockEntry(const CodeBlock& block, u32 wasm_local_base,
                      u32 ctx_ptr);

    // Prologue: for every preg in block.m_fpr_inputs emit
    //   local.set(ps0_idx, i64.load(ctx_ptr + ppc_off::ps0(N)))
    //   local.set(ps1_idx, i64.load(ctx_ptr + ppc_off::ps1(N)))
    // Both lanes always (matches Jit64 FPURegCache.cpp:60-64 which loads
    // ps0+ps1 as one MOVAPD).
    void EmitPrologueLoads(u32 ctx_ptr);

    // Bind a preg's lanes for the next emitted op. Returns both lane
    // indices; emit sites consume only the lanes they touch.
    //
    // lane_mask selects which lanes participate. In Read/ReadWrite mode,
    // any requested lane that isn't loaded yet lazy-loads from
    // PowerPCState. In Write/ReadWrite mode, requested lanes are marked
    // dirty. Pure-Write lanes skip the lazy-load (the emit defines them).
    RCFprPair Bind(u32 preg, FPRMode mode, u8 lane_mask = FPR_LANE_BOTH);

    // Flush dirty lanes back to PowerPCState. `preg_mask` selects which
    // FPRs (default all 32). `lane_mask` selects which lanes (default both).
    // Emits one i64.store per dirty lane.
    void Flush(u32 ctx_ptr,
               BitSet32 preg_mask = BitSet32(0xFFFFFFFFu),
               u8 lane_mask = FPR_LANE_BOTH);

    // ReloadAll — for every assigned FPR, re-load both lanes from
    // PowerPCState. Used after host-side mutations of ps[] (interp
    // fallback, HLE that may touch FPRs) so subsequent emit_* calls see
    // post-mutation state instead of stale cached locals.
    void ReloadAll(u32 ctx_ptr);

    // Control-flow wrappers — mirror RegCache::EmitIf/Else/EndIf. Flush
    // dirty lanes on entry to each arm + at merge so divergent dirty
    // tracking can't leak across the join. No immediate tracking to
    // invalidate (FPRs have no SetImmediate).
    void EmitIf(u32 ctx_ptr, u32 result_type);
    void EmitElse(u32 ctx_ptr);
    void EmitEndIf(u32 ctx_ptr);

    // Debug / asserts.
    bool IsAssigned(u32 preg)        const { return m_state[preg].assigned; }
    bool IsPS0Loaded(u32 preg)       const { return m_state[preg].ps0_loaded; }
    bool IsPS1Loaded(u32 preg)       const { return m_state[preg].ps1_loaded; }
    bool IsPS0Dirty(u32 preg)        const { return m_state[preg].ps0_dirty; }
    bool IsPS1Dirty(u32 preg)        const { return m_state[preg].ps1_dirty; }
    u32  GetPS0LocalIdx(u32 preg)    const { return m_state[preg].ps0_local_idx; }
    u32  GetPS1LocalIdx(u32 preg)    const { return m_state[preg].ps1_local_idx; }

private:
    struct PregState {
        u32  ps0_local_idx = 0;
        u32  ps1_local_idx = 0;
        bool ps0_loaded   = false;
        bool ps1_loaded   = false;
        bool ps0_dirty    = false;
        bool ps1_dirty    = false;
        bool assigned     = false;
    };

    // Internal: emit a single-lane load from PowerPCState into the lane's local.
    void EmitLaneLoad(u32 ctx_ptr, u32 preg, u8 lane);
    // Internal: emit a single-lane store from the lane's local to PowerPCState.
    void EmitLaneStore(u32 ctx_ptr, u32 preg, u8 lane);

    WasmModuleBuilder& m_wb;
    PregState m_state[32]{};
    u32 m_local_base    = 0;
    u32 m_if_depth      = 0;
    u32 m_lazy_ctx_ptr  = 0;
};

}  // namespace bemental::powerpc

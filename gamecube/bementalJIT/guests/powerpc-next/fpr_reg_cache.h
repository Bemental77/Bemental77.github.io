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

// [simd-paired 2026-07-12] Precision representation of an FPR's live value.
// Double = authoritative in the i64 lane pair (f64 bits); Single = authoritative
// in the v128 local (f32x2 in lanes 0-1), the fast paired-single form matching
// JitArm64's RegType::Single. Memory (PowerPCState.ps[]) is ALWAYS f64.
enum class FPRPrec : u8 { Double, Single };

// Result of a Bind — the two wasm-local indices for the FPR's two lanes.
// The emit site consumes only the lanes it cares about; the other index is
// still valid (the lane is allocated/loaded as needed by Bind itself based
// on lane_mask).
struct RCFprPair {
    u32 ps0_idx = 0;
    u32 ps1_idx = 0;
    u32 v128_idx = 0;      // single-form v128 local (valid when is_single)
    bool is_single = false;
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
                      u32 ctx_ptr, u32 v128_local_base = 120u);

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

    // [simd-paired] Single-precision (v128 f32x2) fast path. IsSingle peeks
    // (no emit) whether the FPR's live value is already in single form — the
    // gate an op checks on ALL inputs before taking the SIMD path.
// [m00-hunt A/B PM37 2026-07-23] 1 = kill the Single (v128) representation:
// IsSingle always false -> every SIMD fast path (jit_paired gates, lfs-Single
// consumers) bypassed, all regs stay i64-pair repr. Tests whether the
// Single-repr chain zeroes PSMTXRotAxisRad's m00 (probe field xfm). REVERT.
#define BEM_SINGLE_REPR_DISABLE 0  // A/B done (m00 still died with 1 -> not the culprit; real root = slot-98 park clobber, fixed in jit_load_store.cpp)
#if BEM_SINGLE_REPR_DISABLE
    bool IsSingle(u32) const { return false; }
#else
    bool IsSingle(u32 preg) const { return m_state[preg].repr == FPRPrec::Single; }
#endif
    // BindSingleRead: FPR is already Single (caller checked IsSingle). Returns
    // its v128 local. BindSingleWrite: mark the FPR Single (the op computes an
    // f32x2 into the returned v128 local); the i64 pair becomes stale.
    RCFprPair BindSingleRead(u32 preg);
    RCFprPair BindSingleWrite(u32 preg);

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
    // [single-spec v7] host_may_write_fprs=false for interp fallbacks that
    // CANNOT touch ps[] (mfspr/mtspr TBL/DEC, mfcr/mtcrf/mtsr/tlbie, integer
    // Rc forms, lmw) — those must NOT wholesale-clear the shadow mask. The
    // unconditional clear fired on every timer read (thousands per s) and
    // zeroed the mask constantly: psWith == deopt (every speculating block
    // eventually entered on a just-zeroed mask), failBits == the whole
    // assumed set.
    void ReloadAll(u32 ctx_ptr, bool host_may_write_fprs = true);

    // [single-spec PM26] Prologue loads for FPRs assumed f32-valued in ps[]
    // (caller emitted the shadow-mask guard; runs on the match arm only).
    // Lands each FPR as Single repr (v128 rebuilt via the PEM-widen inverse)
    // with lanes loaded + everything clean. See fpr_reg_cache.cpp.
    // [self-loop PM47] fast_loop_mode: additionally spill each rebuilt v128 to
    // the scratch window (0x026B3C00 + preg*16) and land the FAST-REENTRY
    // uniform state instead (v128 valid + DIRTY, lanes UNLOADED) so both entry
    // paths of a self-loop block converge on identical compile-time state.
    void EmitAssumedSingleLoads(u32 ctx_ptr, BitSet32 assumed,
                                bool fast_loop_mode = false);

    // [self-loop PM47] Fast re-entry: rebuild each assumed FPR's v128 straight
    // from the scratch window (one v128.load each — replaces the ~160-op/reg
    // verify + PEM-inverse rebuild). Valid ONLY when the self-chain flag
    // (0x026B38C0) proves the last exit was THIS block's own singles arm.
    // Lands the same uniform state as fast_loop_mode above.
    void EmitFastReentry(BitSet32 assumed);

    // [self-loop PM47] Spill each assumed FPR's v128 to the scratch window
    // (3 ops/reg). Caller must have verified AllSingle(assumed) at COMPILE
    // time — a Double-repr reg's v128 local is stale.
    void EmitScratchSpill(BitSet32 assumed);

    // [self-loop PM47] All `regs` currently Single repr? (compile-time; gates
    // the fast-exit emission — any assumed reg the body demoted disables it.)
    bool AllSingle(BitSet32 regs) const {
        for (u32 i = 0; i < 32; ++i)
            if (regs[i] && m_state[i].repr != FPRPrec::Single) return false;
        return true;
    }

    // [self-loop PW-skip] FPRs for which Flush() would emit the expensive
    // Single->Double promote right now — the exact latch predicate Flush()
    // uses (repr Single && (v128 dirty || force-flush)). Lets the fast-loop
    // terminal identify pure-write Singles it may skip on the self-chain arm.
    BitSet32 DirtySingles() const {
        BitSet32 s(0);
        for (u32 i = 0; i < 32; ++i)
            if (m_state[i].repr == FPRPrec::Single &&
                (m_state[i].v128_dirty || m_force_flush[i]))
                s[i] = true;
        return s;
    }

    // [self-loop PM47] Force-flush set: fast-loop assumed regs enter CLEAN
    // (so common-path flush sites like the MSR.FP bailout emit nothing for
    // them) but on the FAST path their ps[] is stale — any Flush that could
    // make ps[] host-visible must still write them. Members are treated as
    // dirty-if-Single by Flush().
    void SetForceFlush(BitSet32 s) { m_force_flush = s; }

    // [self-loop PM47] SaveState/RestoreState (defined after PregState below):
    // the split epilogue emits Flush into BOTH runtime arms from the SAME
    // pre-flush state (the first emission would otherwise clear dirty bits
    // and make the second emit nothing).

    // [single-spec v3] producer marks its Double-repr output as single-VALUED
    // (ForceSingle'd widened single in both lanes) — call AFTER the Bind(Write)
    // that conservatively cleared it. Keys the shadow-mask SET at flush.
    void MarkValueSingle(u32 preg) {
        m_state[preg].value_single  = true;
        m_state[preg].value_unknown = false;
    }
    // [single-spec v5] lfd-family producer: value unknown until the flush's
    // runtime round-trip check. Call AFTER the Bind(Write).
    void MarkValueUnknown(u32 preg) {
        m_state[preg].value_single  = false;
        m_state[preg].value_unknown = true;
    }

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
        u32  v128_local_idx = 0;   // [simd-paired] single-form local
        FPRPrec repr      = FPRPrec::Double;  // Double until a Single-write
        bool v128_dirty   = false; // single value not yet reconciled to i64/memory
        bool ps0_loaded   = false;
        bool ps1_loaded   = false;
        bool ps0_dirty    = false;
        bool ps1_dirty    = false;
        bool assigned     = false;
        // [single-spec v3] the VALUE is a widened single in both lanes even
        // when repr is Double (scalar ps paths ForceSingle their outputs but
        // keep i64 repr). The shadow-mask SET decision keys on THIS, not on
        // repr — repr-keyed masking cleared bits for scalar-era ps results
        // and deopted the exact IDCT loop bodies speculation targets.
        bool value_single = false;
        // [single-spec v5 lfd tri-state] value UNKNOWN at compile time (lfd
        // loads arbitrary memory). Flush emits a RUNTIME widened-single
        // round-trip check on the stored lanes and ANDs it into the mask bit
        // — so __OSLoadFPUContext's lfd-restores of round-tripped singles
        // (the ISR path that cleared f27-f30 every ~ms and deopted the IDCT)
        // KEEP the bit, while a genuine double still clears it.
        bool value_unknown = false;
    };

public:
    // [self-loop PM47] see the comment in the API block above.
    struct StateSnapshot { PregState s[32]; };
    StateSnapshot SaveState() const {
        StateSnapshot snap;
        for (u32 i = 0; i < 32; ++i) snap.s[i] = m_state[i];
        return snap;
    }
    void RestoreState(const StateSnapshot& snap) {
        for (u32 i = 0; i < 32; ++i) m_state[i] = snap.s[i];
    }

private:

    // Internal: emit a single-lane load from PowerPCState into the lane's local.
    void EmitLaneLoad(u32 ctx_ptr, u32 preg, u8 lane);
    // Internal: emit a single-lane store from the lane's local to PowerPCState.
    void EmitLaneStore(u32 ctx_ptr, u32 preg, u8 lane);
    // [simd-paired] Reconcile a Single-repr FPR back into its i64 lane pair
    // (NaN-payload-exact per-lane widen). Sets repr=Double, marks lanes dirty.
    void EmitPromoteToDouble(u32 preg);

    WasmModuleBuilder& m_wb;
    PregState m_state[32]{};
    BitSet32 m_force_flush{0};   // [self-loop PM47]
    u32 m_local_base    = 0;
    u32 m_v128_base     = 120u;
    u32 m_if_depth      = 0;
    u32 m_lazy_ctx_ptr  = 0;
};

}  // namespace bemental::powerpc

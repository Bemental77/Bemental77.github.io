#pragma once
//
// RegCache — per-block PPC-GPR → WASM-local binding, ported in shape from
// Dolphin Jit64's RegCache + GPRRegCache (Source/Core/Core/PowerPC/Jit64/
// RegCache/, GPL-2.0-or-later). Phase 2 deliverable.
//
// Key design differences from Jit64:
//
// 1. Backing storage is fixed WASM locals (one per live PPC GPR over the
//    block), assigned UP FRONT from CodeBlock::m_gpr_inputs + the reg-flow
//    scan in PPCAnalyzer. There is no LRU eviction or spill pool — the
//    binding lifetime is the whole block.
// 2. Flush emits per-dirty-preg `i32.store offset=ppc_gpr_off(N)` to
//    PowerPCState. Called at block exit, before branches, before fallback
//    calls (interpreter may mutate gpr[]), and before control-flow joins
//    where the branch arms may have diverged binding state.
// 3. Immediate tracking is unchanged — SetImmediate32 records a known
//    compile-time value; BindOrImm folds the immediate when emit sites
//    can use one.
//
// The b11_coherence_bug class (raw op_if() that didn't bump if_depth and
// thus skipped invalidation across the arm) is made structurally
// unreachable here: the emitter calls RegCache::OnIfEnter/OnIfElse/OnIfEnd
// helpers which wrap the WASM control-flow ops AND own the flush/
// invalidate ordering. Emitters never call WasmModuleBuilder::op_if
// directly.

#include "bementalJIT/types.h"
#include "common/bit_set.h"
#include "rc_mode.h"

class WasmModuleBuilder;  // global namespace — defined in include/bementalJIT/wasm_module_builder.h

namespace bemental::powerpc {

struct CodeBlock;

class RegCache {
public:
    explicit RegCache(WasmModuleBuilder& wb);

    // Layout the per-block WASM-local assignment from the analyzer's output.
    // `wasm_local_base` is the index of the first WASM local reserved for
    // GPR caching (the emitter allocates LOCAL_TMP_*, then the GPR locals
    // start at wasm_local_base).
    void OnBlockEntry(const CodeBlock& block, u32 wasm_local_base);

    // Prologue: emit `local.set` from PowerPCState loads for every preg in
    // block.m_gpr_inputs (live-in set). After this, the WASM locals hold
    // the block-entry values of every live-in PPC GPR.
    void EmitPrologueLoads(u32 ctx_ptr);

    // Bind a preg for the next emitted op. Read mode binds the current
    // local; Write invalidates immediates and prior cached state; ReadWrite
    // does both.
    RCWasmLocal Bind(u32 preg, RCMode mode);

    // BindOrImm — folds known immediates. Read-only semantics; not for use
    // when the op writes the preg.
    RCOpArg BindOrImm(u32 preg);

    // Discard a known-immediate without emitting anything (e.g., after an
    // op writes the preg with a non-constant value).
    void DiscardImm(u32 preg);

    // Record a known compile-time value for `preg`. Subsequent BindOrImm
    // calls return RCOpArg::Imm32(imm). Subsequent Bind(Write) invalidates.
    void SetImmediate32(u32 preg, u32 imm);

    // Flush dirty bindings back to PowerPCState. `mask` selects which PPC
    // GPRs to flush; default is all-32. Called at:
    //   - Block exit (always — before the final read-PC-and-return).
    //   - Before branch terminators (so the dispatcher sees consistent
    //     post-block GPR state).
    //   - Before fallback calls (interpreter may mutate gpr[]).
    //   - At control-flow join points (when arms have diverging state).
    void Flush(u32 ctx_ptr, BitSet32 mask = BitSet32(0xFFFFFFFFu));

    // Control-flow wrappers — guarantee flush/invalidate ordering across
    // branch arms. Emitters MUST use these instead of raw
    // WasmModuleBuilder::op_if/op_else/op_end (structural fix for the
    // B11 coherence bug class).
    void EmitIf(u32 ctx_ptr, u32 result_type);
    void EmitElse(u32 ctx_ptr);
    void EmitEndIf(u32 ctx_ptr);

    // For debugging / asserts.
    bool IsImmediate(u32 preg) const { return m_state[preg].is_imm; }
    u32  GetImmediate(u32 preg) const { return m_state[preg].imm; }
    u32  GetLocalIdx(u32 preg)  const { return m_state[preg].local_idx; }
    bool IsDirty(u32 preg)      const { return m_state[preg].dirty; }

private:
    // Per-PPC-GPR state inside a block.
    struct PregState {
        u32  local_idx = 0;     // WASM local index assigned to this preg
        u32  imm       = 0;     // compile-time-known value
        bool is_imm    = false; // imm field valid
        bool dirty     = false; // local has been written; PowerPCState stale
        bool loaded    = false; // prologue load has been emitted
        bool assigned  = false; // a WASM local has been reserved for this preg
    };

    WasmModuleBuilder& m_wb;
    PregState m_state[32]{};
    u32 m_local_base = 0;
    u32 m_if_depth   = 0;
};

}  // namespace bemental::powerpc

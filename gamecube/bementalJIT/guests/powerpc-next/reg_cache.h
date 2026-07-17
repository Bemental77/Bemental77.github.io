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
    // start at wasm_local_base). `ctx_ptr` is the PowerPCState base address,
    // stamped into m_lazy_ctx_ptr for use by Bind()'s lazy-load fallback
    // (when the analyzer's live-in set is incomplete — e.g. for opcodes
    // whose opinfo flags can't express full register usage like lmw/stmw).
    void OnBlockEntry(const CodeBlock& block, u32 wasm_local_base,
                      u32 ctx_ptr);

    // Prologue: emit `local.set` from PowerPCState loads for every preg in
    // block.m_gpr_inputs (live-in set). After this, the WASM locals hold
    // the block-entry values of every live-in PPC GPR.
    void EmitPrologueLoads(u32 ctx_ptr);

    // [region-resident 2026-07-15] Merged-region residency: mark ALL 32 pregs
    // assigned+loaded WITHOUT emitting loads. Valid ONLY inside the merged
    // region function, whose activation pad loads every GPR once per host
    // entry and whose intra-region `br` edges keep the SAME activation alive
    // (locals persist; the identity preg->local mapping — OnBlockEntry's
    // local_idx = base + i — makes every body see the same layout). Memory
    // stays host-coherent through the unchanged terminal/mid-op dirty
    // flushes; interp/HLE ReloadAll refills locals after host mutations.
    void MarkAllLoaded() {
        for (u32 i = 0; i < 32u; ++i) {
            m_state[i].assigned = true;
            m_state[i].loaded   = true;
        }
    }

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

    // Mark a preg's wasm-local as dirty (needs flush back to PowerPCState).
    // Used when an emit writes to a Bind(Write)-bound local AFTER a Flush
    // that cleared the dirty bit. Without this, the local has the new value
    // but Flush thinks it's clean → block exit drops the write → silent
    // corruption. Diagnosed in emit_shiftx/emit_srawx where Flush precedes
    // op_if/op_else/op_end whose body's op_local_set is the actual write
    // (2026-06-04 multi-agent JIT correctness hunt).
    void MarkDirty(u32 preg);

    // Flush dirty bindings back to PowerPCState. `mask` selects which PPC
    // GPRs to flush; default is all-32. Called at:
    //   - Block exit (always — before the final read-PC-and-return).
    //   - Before branch terminators (so the dispatcher sees consistent
    //     post-block GPR state).
    //   - Before fallback calls (interpreter may mutate gpr[]).
    //   - At control-flow join points (when arms have diverging state).
    void Flush(u32 ctx_ptr, BitSet32 mask = BitSet32(0xFFFFFFFFu));

    // ReloadAll — emit `i32.load + local.set` for every previously-assigned
    // GPR cache local, re-pulling its value from PowerPCState. Required
    // after any host-side mutation of gpr[] (interp fallback, HLE handler
    // that touches gpr[]) so subsequent emit_* calls in the same block see
    // the post-mutation state instead of stale cached locals. Without this,
    // the AFTER-fallback Flush at block exit would overwrite the host's
    // writes with stale local values (2026-05-31: lmw fallback corrupted
    // r28-r31 in OSCacheInit, see jitwasm_run_wired follow-on bug
    // jit_emit_fallback_regcache_invalidate).
    void ReloadAll(u32 ctx_ptr);

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
    // Stamped once per block by OnBlockEntry. Used by Bind()'s lazy-load
    // fallback when the analyzer's live-in set is incomplete for a preg
    // (e.g. analyzer-blind opcodes like lmw/stmw whose opinfo flags can't
    // express full register usage). 0 is a sentinel — emitting a load
    // against ctx_ptr=0 would produce a wasm OOB trap.
    u32 m_lazy_ctx_ptr = 0;
};

}  // namespace bemental::powerpc

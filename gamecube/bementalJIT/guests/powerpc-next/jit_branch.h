#pragma once
//
// jit_branch.h — Phase 4 part 2 branch emitters. Targets the Jit64
// Jit_Branch.cpp shape: bx/bcx/bclrx/bcctrx/rfi. Each emitter sets
// PowerPCState.pc to the target (compile-time or runtime) and marks
// CodeOp.canEndBlock true; the per-block epilogue is responsible for
// the read-PC-and-return after Flush.

#include "bementalJIT/types.h"
#include "bementalJIT/region_desc.h"  // [order 13d] BemRelocSym (BEM_RSYM_NONE) for merged-aware branch exits
#include "code_op.h"
#include "cr_shadow.h"        // [PM57] CmpFuse
#include "fpr_reg_cache.h"
#include "reg_cache.h"

class WasmModuleBuilder;

namespace bemental::powerpc {

// [region-merged 2026-07-15; moved here for order 13d merged-aware branch exits]
// Context for emitting a block body INTO the merged single-function region.
struct MergedRegionCtx {
    u32 gen_idx;          // this gen's index (packed-slot ownership check)
    u32 region_func_idx;  // module-local func index of $region (cold re-entry)
    u32 sel_global_idx;   // entry_sel mutable-i32 global index
    u32 laps_global_idx;  // lap-counter mutable-i32 global index
    // [region-resident 2026-07-15] Warm edges are `br` back to the region LOOP
    // (same activation — locals persist, enabling GPR residency; a return_call
    // would reset locals to zero). br immediate from an edge site =
    // bodyBuilder.ctrlDepth() + br_extra_depth, where br_extra_depth =
    // (n_blocks - k) accounts for body k's splice nesting (loop + $DEF +
    // the (n-1-k) enclosing $B blocks, minus the loop interior itself).
    u32 br_extra_depth;   // per-body splice offset (set by the merged builder)
};

// [order 13d] The block-epilogue chain-or-return cascade (defined in ppc_emit.cpp).
// Declared here so emit_coalesced_taken_exit (jit_branch.cpp) can route a merged
// mid-block taken exit through the SAME warm cascade instead of op_return.
void emit_chain_or_return(WasmModuleBuilder& b, u32 ctx_ptr,
                          u32 tag_addr_ovr = 0u, u32 slot_addr_ovr = 0u,
                          const MergedRegionCtx* merged = nullptr,
                          s32 region_gen = -1,
                          const u32* direct_pcs = nullptr,
                          const u32* direct_fidx = nullptr,
                          u32 n_direct = 0u,
                          u16 tag_sym = (u16)BEM_RSYM_NONE,
                          u16 slot_sym = (u16)BEM_RSYM_NONE);


// Unconditional. LK=1 sets LR = next_pc; LK=0 doesn't touch LR.
// AA=1 absolute target; AA=0 PC-relative.
void emit_bx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
             u32 ctx_ptr);

// Conditional branch — bcx (op16). Decodes BO/BI for CR + CTR conditions.
// Native paths: BO=20 (branch always), bdnz/bdz, and the CR-bit conditional
// forms bne/beq. Rare BO combinations (LK conditional calls, exotic CTR+CR
// mixes) delegate to WIMPORT_INTERP.
//
// is_terminal=true (default): the bcx ends the block — store PC=target on taken,
// PC=fallthrough on not-taken, then the epilogue returns next-PC (today's
// behavior). is_terminal=false (forward-conditional coalescing): emit a mid-
// block conditional EXIT — taken stores PC=target, drains a pending gather-pipe
// write, and returns to the dispatcher; the not-taken arm stores NOTHING and
// the block keeps emitting the fall-through instructions.
// [self-loop PM47] fpr_flush_skip: FPRs the caller will reconcile itself
// (fast-loop assumed set — spilled to scratch on the self-chain path, flushed
// by the shared epilogue otherwise). Default = skip none (legacy behavior).
// [PM57 cmp-fuse] fuse: when non-null and valid for THIS branch's CR field, the
// CR-bit conditional arm emits a direct operand compare from the preceding cmp's
// locals instead of the pending-check+materialize read. nullptr = no fusion.
// [order 13d] merged/region args: when merged != nullptr AND is_terminal == false,
// the mid-block coalesced taken exit routes through emit_chain_or_return's warm
// cascade (entry_sel=k; br $L, GPR locals live) instead of op_return to the C loop
// (artifact #4). Defaults reproduce the legacy per-block behavior.
void emit_bcx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
              u32 ctx_ptr, bool is_terminal = true,
              BitSet32 fpr_flush_skip = BitSet32(0),
              const CmpFuse* fuse = nullptr,
              const MergedRegionCtx* merged = nullptr, s32 region_gen = -1,
              u32 chain_tag_addr = 0u, u32 chain_slot_addr = 0u,
              u16 chain_tag_sym = (u16)BEM_RSYM_NONE, u16 chain_slot_sym = (u16)BEM_RSYM_NONE);

// [PM53h int-fusion] Terminal bcx of a fused integer self-loop: taken arm
// re-enters the enclosing wasm loop (br) behind a downcount/exception/
// dispatch-tag guard; bail arms store PC exactly like emit_bcx's terminal
// arms and fall out to the unchanged epilogue. charge = per-iteration cycle
// cost; loop_head_depth = builder ctrlDepth() recorded right after op_loop;
// tag_addr = &g_bem_disp_tag[bucket(start_pc)].
// [PM57 cmp-fuse] fuse: same adjacent cmp->branch fusion as emit_bcx — the
// self-loop's terminal CR-bit test reads the preceding cmp's operand locals
// directly. This is the HOT path (IDCT self-chain), so fusing here is where the
// materialize tax is most worth removing. nullptr = no fusion.
// tag_sentinel: [AOT v4 reloc] non-zero in offline reloc mode — the tag const
// is emitted as this OOB sentinel + a reloc record instead of tag_addr.
void emit_bcx_fused(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                    const CodeOp& op, u32 ctx_ptr, u32 charge,
                    u32 loop_head_depth, bool block_has_store,
                    u32 tag_addr, u32 start_pc, const CmpFuse* fuse = nullptr,
                    bool fp_resident = false, u32 tag_sentinel = 0u);

// Indirect: bclr (op19:16) takes target from LR; bcctr (op19:528) takes
// target from CTR. Both support LK to set LR=next_pc.
void emit_bclrx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr);
void emit_bcctrx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                 u32 ctx_ptr);

// rfi (op19:50). Always block-end; restores PC from SRR0, MSR from SRR1.
// Phase 4 part 2 fallbacks this to WIMPORT_INTERP — the SRR1->MSR
// transition path needs the exception-state save/restore from
// Jit_SystemRegisters.cpp which lands in Phase 4 part 3.
void emit_rfi(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
              u32 ctx_ptr);

}  // namespace bemental::powerpc

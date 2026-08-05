#pragma once
//
// jit_branch.h — Phase 4 part 2 branch emitters. Targets the Jit64
// Jit_Branch.cpp shape: bx/bcx/bclrx/bcctrx/rfi. Each emitter sets
// PowerPCState.pc to the target (compile-time or runtime) and marks
// CodeOp.canEndBlock true; the per-block epilogue is responsible for
// the read-PC-and-return after Flush.

#include "bementalJIT/types.h"
#include "code_op.h"
#include "cr_shadow.h"        // [PM57] CmpFuse
#include "fpr_reg_cache.h"
#include "reg_cache.h"

class WasmModuleBuilder;

namespace bemental::powerpc {


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
void emit_bcx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
              u32 ctx_ptr, bool is_terminal = true,
              BitSet32 fpr_flush_skip = BitSet32(0),
              const CmpFuse* fuse = nullptr);

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
void emit_bcx_fused(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                    const CodeOp& op, u32 ctx_ptr, u32 charge,
                    u32 loop_head_depth, bool block_has_store,
                    u32 tag_addr, u32 start_pc, const CmpFuse* fuse = nullptr);

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

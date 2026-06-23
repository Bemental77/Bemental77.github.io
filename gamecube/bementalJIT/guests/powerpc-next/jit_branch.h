#pragma once
//
// jit_branch.h — Phase 4 part 2 branch emitters. Targets the Jit64
// Jit_Branch.cpp shape: bx/bcx/bclrx/bcctrx/rfi. Each emitter sets
// PowerPCState.pc to the target (compile-time or runtime) and marks
// CodeOp.canEndBlock true; the per-block epilogue is responsible for
// the read-PC-and-return after Flush.

#include "bementalJIT/types.h"
#include "code_op.h"
#include "fpr_reg_cache.h"
#include "reg_cache.h"

class WasmModuleBuilder;

namespace bemental::powerpc {


// Unconditional. LK=1 sets LR = next_pc; LK=0 doesn't touch LR.
// AA=1 absolute target; AA=0 PC-relative.
//
// BLR-stack: LK=1 PUSHes the after-PC onto the SAB-resident return-PC ring
// (see jit_branch.cpp header comment for the SAB layout) so the matching
// `blr` can detect stack corruption. Mirrors Jit64 Jit.cpp:641-645.
void emit_bx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
             u32 ctx_ptr);

// Conditional branch — bcx (op16). Decodes BO/BI for CR + CTR conditions.
// Native paths: BO=20 (branch always), bdnz/bdz, and the CR-bit conditional
// forms bne/beq. Rare BO combinations (LK conditional calls, exotic CTR+CR
// mixes) delegate to WIMPORT_INTERP.
//
// BLR-stack: the inline BO=20 LK=1 path pushes. The interp-fallback path
// does NOT push (interp owns LR mutation for the LK arm); this is a known
// gap in the mispredict diagnostic, tolerated because bclXX,LK is rare.
// is_terminal=true (default): the bcx ends the block — store PC=target on taken,
// PC=fallthrough on not-taken, then the epilogue returns next-PC (today's
// behavior). is_terminal=false (forward-conditional coalescing): emit a mid-
// block conditional EXIT — taken stores PC=target, drains a pending gather-pipe
// write, and returns to the dispatcher; the not-taken arm stores NOTHING and
// the block keeps emitting the fall-through instructions.
void emit_bcx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
              u32 ctx_ptr, bool is_terminal = true);

// Indirect: bclr (op19:16) takes target from LR; bcctr (op19:528) takes
// target from CTR. Both support LK to set LR=next_pc.
//
// BLR-stack: emit_bclrx POPs the ring and compares against the runtime
// SPR_LR; a mismatch bumps SAB[0x026B0504] (count) + records the site PC,
// actual LR, and expected popped value at SAB[0x026B0508..0x026B0510].
// PC is still written from SPR_LR (option (a) — preserves current
// semantics, just makes the wild-branch observable). Mirrors
// Jit64::WriteBLRExit (Jit.cpp:660-682) minus the dispatcher reroute.
//
// emit_bcctrx does NOT pop — CTR holds a forward-call target, not a
// return PC. LK=1 still PUSHes (bcctrl is a linked call).
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

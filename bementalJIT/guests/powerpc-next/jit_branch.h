#pragma once
//
// jit_branch.h — Phase 4 part 2 branch emitters. Targets the Jit64
// Jit_Branch.cpp shape: bx/bcx/bclrx/bcctrx/rfi. Each emitter sets
// PowerPCState.pc to the target (compile-time or runtime) and marks
// CodeOp.canEndBlock true; the per-block epilogue is responsible for
// the read-PC-and-return after Flush.

#include "bementalJIT/types.h"
#include "code_op.h"
#include "reg_cache.h"

class WasmModuleBuilder;

namespace bemental::powerpc {


// Unconditional. LK=1 sets LR = next_pc; LK=0 doesn't touch LR.
// AA=1 absolute target; AA=0 PC-relative.
void emit_bx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
             u32 ctx_ptr);

// Conditional branch — bcx (op16). Decodes BO/BI for CR + CTR conditions.
// Phase 4 part 2 ships the static-target variant; complex multi-condition
// dispatch (BO bit 4=0 needs CR check, BO bit 2=0 needs CTR decrement)
// delegates to the runtime helper when too rich for inline emit.
void emit_bcx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
              u32 ctx_ptr);

// Indirect: bclr (op19:16) takes target from LR; bcctr (op19:528) takes
// target from CTR. Both support LK to set LR=next_pc.
void emit_bclrx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                u32 ctx_ptr);
void emit_bcctrx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                 u32 ctx_ptr);

// rfi (op19:50). Always block-end; restores PC from SRR0, MSR from SRR1.
// Phase 4 part 2 fallbacks this to WIMPORT_INTERP — the SRR1->MSR
// transition path needs the exception-state save/restore from
// Jit_SystemRegisters.cpp which lands in Phase 4 part 3.
void emit_rfi(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
              u32 ctx_ptr);

}  // namespace bemental::powerpc

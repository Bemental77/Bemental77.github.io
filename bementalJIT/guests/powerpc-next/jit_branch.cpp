//
// jit_branch.cpp — Phase 4 part 2 branch emitters.
//
// Each emit_* sets PowerPCState.pc to the branch target. The per-block
// epilogue (in build_block / ppc_emit) handles the final read-PC-and-
// return; emit_* just writes ppc_state.pc + sets c.block_end = true via
// the caller's CodeOp metadata (analyst already sets canEndBlock).
//
// Static targets (b/bc with known offset) write a compile-time constant;
// indirect targets (bclr/bcctr) write a runtime local from LR/CTR.
//
// Note: PowerPCState writes here BYPASS RegCache (PC/LR/CTR are not GPR-
// cached). Direct ctx-relative i32_store. Before writing, we Flush dirty
// GPR bindings so the dispatcher's next iteration sees consistent state.

#include "jit_branch.h"

#include "bementalJIT/types.h"
#include "bementalJIT/wasm_module_builder.h"
#include "code_op.h"
#include "common/op_info.h"
#include "ppc_analyst.h"
#include "ppc_offsets.h"
#include "reg_cache.h"

namespace bemental::powerpc {

static constexpr u32 WIMPORT_INTERP = 6;

// Write a compile-time-constant value to a PowerPCState field. Stack-neutral.
static void emit_store_const_to_ctx(WasmModuleBuilder& wb, u32 ctx_ptr,
                                    u32 field_off, u32 value) {
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_const((s32)value);
    wb.op_i32_store(field_off);
}

// Copy a u32 from one PowerPCState field to another. Stack-neutral.
static void emit_copy_ctx_field(WasmModuleBuilder& wb, u32 ctx_ptr,
                                u32 dst_off, u32 src_off) {
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load(src_off);
    wb.op_i32_store(dst_off);
}

// ---------------------------------------------------------------------------
// emit_bx — unconditional branch.
//   target = SignExt26(LI << 2); if (!AA) target += pc;
//   if (LK) gpr[LR] = pc + 4;
//   pc = target;
// ---------------------------------------------------------------------------
void emit_bx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
             u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 li   = GekkoOperands::LI(inst);
    const bool aa  = GekkoOperands::AA(inst);
    const bool lk  = GekkoOperands::LK(inst);
    const u32 target = aa ? li : (op.address + li);

    // Flush dirty GPRs before block-exiting branch.
    rc.Flush(ctx_ptr);

    if (lk) {
        emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::lr_off(), op.address + 4);
    }
    emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::PC, target);
}

// ---------------------------------------------------------------------------
// emit_bcx — conditional branch.
//   target = SignExt16(BD << 2); if (!AA) target += pc;
//   BO[0..4] decode: bit 4=1 → ignore CR; bit 2=1 → ignore CTR (no decrement)
// Phase 4 part 2 ships static-target branch with BO=20 (branch always)
// inline; richer conditions fallback to WIMPORT_INTERP. The interpreter
// handles the CTR/CR combination logic exactly; emit_bcx invokes it via
// the per-op fallback.
// ---------------------------------------------------------------------------
void emit_bcx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
              u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 bo   = GekkoOperands::BO(inst);

    // Flush before bail-or-take.
    rc.Flush(ctx_ptr);

    if (bo == 20) {
        // "branch always" — equivalent to bx without LK side-effect choice.
        const u32 bd   = GekkoOperands::BD(inst);
        const bool aa  = GekkoOperands::AA(inst);
        const bool lk  = GekkoOperands::LK(inst);
        const u32 target = aa ? bd : (op.address + bd);
        if (lk) {
            emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::lr_off(),
                                    op.address + 4);
        }
        emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::PC, target);
        return;
    }

    // Conditional path — fallback to WIMPORT_INTERP. The interpreter
    // handles BO/BI/CTR/CR combinations and writes ppc_state.pc on its
    // own. After the call the dispatcher's outer loop picks up at
    // whatever PC the interp ended on.
    wb.op_i32_const((s32)inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(WIMPORT_INTERP);
}

// ---------------------------------------------------------------------------
// emit_bclrx — branch to LR.
//   BO=20 case (unconditional): pc = LR & ~3; (if LK) LR = pc+4;
//   Other BO values fall back to WIMPORT_INTERP.
// ---------------------------------------------------------------------------
void emit_bclrx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 bo   = GekkoOperands::BO(inst);
    const bool lk  = GekkoOperands::LK(inst);

    rc.Flush(ctx_ptr);

    if (bo == 20) {
        // Read LR into a temp, AND ~3, store to PC.
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load(ppc_off::lr_off());
        wb.op_i32_const(~3);
        wb.op_i32_and();
        wb.op_i32_store(ppc_off::PC);
        if (lk) {
            emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::lr_off(),
                                    op.address + 4);
        }
        return;
    }
    wb.op_i32_const((s32)inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(WIMPORT_INTERP);
}

// ---------------------------------------------------------------------------
// emit_bcctrx — branch to CTR.
//   BO[2]=1 (no CTR test): pc = CTR & ~3; (if LK) LR = pc+4;
//   BO[2]=0 fallback (CTR test path is unusual — interp).
// ---------------------------------------------------------------------------
void emit_bcctrx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                 u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 bo   = GekkoOperands::BO(inst);
    const bool lk  = GekkoOperands::LK(inst);
    // BO bit 2 selects whether CTR is tested. PowerPC encoding has BO bit
    // numbering reversed from natural; "BO[2]=1" in the spec means bit 2
    // from the high end in a 5-bit field = (bo & 0x04).
    const bool no_ctr_test = (bo & 0x04) != 0;
    const bool no_cr_test  = (bo & 0x10) != 0;

    rc.Flush(ctx_ptr);

    if (no_ctr_test && no_cr_test) {
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load(ppc_off::ctr_off());
        wb.op_i32_const(~3);
        wb.op_i32_and();
        wb.op_i32_store(ppc_off::PC);
        if (lk) {
            emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::lr_off(),
                                    op.address + 4);
        }
        return;
    }
    wb.op_i32_const((s32)inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(WIMPORT_INTERP);
}

// ---------------------------------------------------------------------------
// emit_rfi — Return From Interrupt. Restores PC from SRR0, MSR from SRR1.
// Phase 4 part 2 fallbacks entirely: the MSR transition can flip EE which
// requires the dispatcher's exception-check path to run before the next
// block. Inlining this safely needs the WIMPORT_CHECK_EXC integration that
// Phase 4 part 3 wires in.
// ---------------------------------------------------------------------------
void emit_rfi(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
              u32 ctx_ptr) {
    rc.Flush(ctx_ptr);
    wb.op_i32_const((s32)op.inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(WIMPORT_INTERP);
}

}  // namespace bemental::powerpc

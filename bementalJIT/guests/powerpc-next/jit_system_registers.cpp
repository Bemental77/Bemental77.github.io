//
// jit_system_registers.cpp — Phase 4 part 3 system-register emitters.
// Covers the "direct" subset of SPRs (CTR, LR, TBL, TBU, DEC, SPRG0-3,
// PVR, SRR0, SRR1, XER) where the SPR is just a u32 slot in
// PowerPCState.spr[]. The "complex" subset (CoreTiming-bound DEC,
// MMCR/PMCs, HID-paired-with-feature-flags, IBATs/DBATs that trigger
// MMU recompute) falls back to WIMPORT_INTERP.
//
// mtmsr is special: changing MSR can flip EE/IR/DR/PR. The rebuild's
// Phase 4 part 3 emits a fast-path for MSR.RI/PR transitions that don't
// touch EE/DR, and falls back to interp when EE or DR changes (those
// require an exception-check / MMU recompute that lives outside the
// JIT). The B6 mtmsr fast-path memory (jit_b6_mtmsr_fast_path_2026_05_05.md)
// established this contract; the rebuild preserves it.

#include "jit_system_registers.h"

#include "bementalJIT/types.h"
#include "bementalJIT/wasm_module_builder.h"
#include "code_op.h"
#include "common/op_info.h"
#include "ppc_analyst.h"
#include "ppc_offsets.h"
#include "reg_cache.h"

namespace bemental::powerpc {

static constexpr u32 WIMPORT_INTERP    = 6;
static constexpr u32 WIMPORT_CHECK_EXC = 7;

// PowerPC SPR encoding: the 10-bit SPR field is split (5+5) and swapped.
// Decode: real_spr = (spr_field[5..9] << 5) | spr_field[0..4]
static u32 decode_spr_num(u32 inst) {
    const u32 spr_field = (inst >> 11) & 0x3FF;
    return ((spr_field >> 5) & 0x1F) | ((spr_field & 0x1F) << 5);
}

// Return true if the SPR maps to a direct u32 slot in PowerPCState.spr[]
// (no CoreTiming / MMU side-effect). Conservative — anything not on this
// list falls back to interp.
static bool spr_is_direct(u32 spr) {
    switch (spr) {
    case ppc_off::SPR_XER:
    case ppc_off::SPR_LR:
    case ppc_off::SPR_CTR:
    case ppc_off::SPR_SRR0:
    case ppc_off::SPR_SRR1:
    case ppc_off::SPR_SPRG0:
    case ppc_off::SPR_SPRG1:
    case ppc_off::SPR_SPRG2:
    case ppc_off::SPR_SPRG3:
    case ppc_off::SPR_PVR:
        return true;
    default:
        return false;
    }
}

void emit_mfspr(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                u32 ctx_ptr) {
    const u32 inst    = op.inst;
    const u32 rt      = GekkoOperands::RD(inst);
    const u32 spr_num = decode_spr_num(inst);

    if (!spr_is_direct(spr_num)) {
        // Fallback — TBL/TBU/DEC need CoreTiming live values.
        wb.op_i32_const((s32)inst);
        wb.op_i32_const((s32)op.address);
        wb.op_call(WIMPORT_INTERP);
        return;
    }

    auto rc_rt = rc.Bind(rt, RCMode::Write);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load(ppc_off::spr(spr_num));
    wb.op_local_set(rc_rt.local_idx());
}

void emit_mtspr(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                u32 ctx_ptr) {
    const u32 inst    = op.inst;
    const u32 rs      = GekkoOperands::RS(inst);
    const u32 spr_num = decode_spr_num(inst);

    if (!spr_is_direct(spr_num)) {
        wb.op_i32_const((s32)inst);
        wb.op_i32_const((s32)op.address);
        wb.op_call(WIMPORT_INTERP);
        return;
    }

    auto rc_rs = rc.Bind(rs, RCMode::Read);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(rc_rs.local_idx());
    wb.op_i32_store(ppc_off::spr(spr_num));
}

void emit_mfmsr(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                u32 ctx_ptr) {
    const u32 rt = GekkoOperands::RD(op.inst);
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load(ppc_off::MSR);
    wb.op_local_set(rc_rt.local_idx());
}

void emit_mtmsr(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                u32 ctx_ptr) {
    // B6 fast-path preserved per jit_b6_mtmsr_fast_path_2026_05_05.md:
    //   1. Flush dirty GPRs.
    //   2. Write the new MSR value into PowerPCState.msr (direct store).
    //   3. Call WIMPORT_CHECK_EXC so the dispatcher picks up any EE-pending
    //      interrupt that just became deliverable.
    //   4. canEndBlock — the per-block epilogue handles the read-PC-and-
    //      return after this.
    const u32 rs = GekkoOperands::RS(op.inst);
    auto rc_rs = rc.Bind(rs, RCMode::Read);

    rc.Flush(ctx_ptr);

    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(rc_rs.local_idx());
    wb.op_i32_store(ppc_off::MSR);

    // Pending-exception probe — pass current PC. The host's
    // dolphin_check_exc reads ppc_state.Exceptions; if any unmasked
    // exception is now deliverable (e.g. EE flipped 0→1 with an
    // EXTERNAL_INT pending), it vectors PC and returns nonzero. We drop
    // the return value here — the per-block epilogue's read-PC-and-return
    // naturally picks up whatever ppc_state.pc the check left.
    wb.op_i32_const((s32)(op.address + 4));
    wb.op_call(WIMPORT_CHECK_EXC);
    wb.op_drop();
}

}  // namespace bemental::powerpc

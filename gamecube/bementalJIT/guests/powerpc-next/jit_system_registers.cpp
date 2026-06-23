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
#include "fpr_reg_cache.h"
#include "ppc_analyst.h"
#include "ppc_offsets.h"
#include "reg_cache.h"

namespace bemental::powerpc {

static constexpr u32 WIMPORT_INTERP      = 6;
static constexpr u32 WIMPORT_MSR_UPDATED = 11;
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
//
// NOTE: SPR_XER (1) is intentionally NOT in this list. PowerPC XER is stored
// in PowerPCState as the split fields xer_ca (u8 @0x2F4), xer_so_ov (u8
// @0x2F5), and xer_stringctrl (u16 @0x2F6) — see PowerPC.h:158-162 and
// PowerPC.h:205-219 (GetXER/SetXER). The slot at ppc_state.spr[1] is unused.
// mfspr/mtspr SPR_XER are handled specially via emit_load_arch_xer /
// emit_store_arch_xer below; the generic spr[] path would read/write
// garbage. Dolphin's interpreter handles this in
// Interpreter_SystemRegisters.cpp:321-323 / :494-496 by calling
// GetXER()/SetXER() before the generic spr[] load/store.
static bool spr_is_direct(u32 spr) {
    switch (spr) {
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

// Reconstruct architectural XER from PowerPCState's split fields. Mirrors
// PowerPC.h:205-212 (UReg_XER GetXER):
//   xer = xer_stringctrl
//       | (xer_ca    << XER_CA_SHIFT=29)
//       | (xer_so_ov << XER_OV_SHIFT=30)
// xer_so_ov packs (SO<<1)|OV, so left-shifted by 30 it places SO at bit 31
// (XER_SO_SHIFT) and OV at bit 30 (XER_OV_SHIFT) — see Gekko.h:353-355.
//
// Pushes the final i32 XER value on the wasm operand stack; otherwise
// stack-neutral.
static void emit_load_arch_xer(WasmModuleBuilder& wb, u32 ctx_ptr) {
    // string_ctrl (low 16 bits — no shift)
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load16_u(ppc_off::XER_STRINGCTRL);
    // ca << 29
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load8_u(ppc_off::XER_CA);
    wb.op_i32_const(29);
    wb.op_i32_shl();
    wb.op_i32_or();
    // so_ov << 30
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load8_u(ppc_off::XER_SO_OV);
    wb.op_i32_const(30);
    wb.op_i32_shl();
    wb.op_i32_or();
}

// Decompose a u32 XER value into the split storage fields. Mirrors
// PowerPC.h:214-219 (SetXER):
//   xer_stringctrl = BYTE_COUNT + (BYTE_CMP << 8)  // low 16 bits of XER
//   xer_ca         = (xer >> 29) & 1                // CA bit
//   xer_so_ov      = (xer >> 30) & 3                // (SO<<1) | OV
//
// Reads the XER value from local `xer_local`. Stack-neutral.
static void emit_store_arch_xer(WasmModuleBuilder& wb, u32 ctx_ptr,
                                u32 xer_local) {
    // xer_stringctrl = xer & 0xFF7F
    // Mask preserves the reserved bit 7 as zero. Matches Jit64
    // Jit_SystemRegisters.cpp:264 and Interpreter SetXER behavior; the
    // earlier 0xFFFF allowed bit 7 to leak into stored XER.
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(xer_local);
    wb.op_i32_const((s32)0xFF7F);
    wb.op_i32_and();
    wb.op_i32_store16(ppc_off::XER_STRINGCTRL);
    // xer_ca = (xer >> 29) & 1
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(xer_local);
    wb.op_i32_const(29);
    wb.op_i32_shr_u();
    wb.op_i32_const(1);
    wb.op_i32_and();
    wb.op_i32_store8(ppc_off::XER_CA);
    // xer_so_ov = (xer >> 30) & 3  → (SO<<1)|OV per storage format
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(xer_local);
    wb.op_i32_const(30);
    wb.op_i32_shr_u();
    wb.op_i32_const(3);
    wb.op_i32_and();
    wb.op_i32_store8(ppc_off::XER_SO_OV);
}

void emit_mfspr(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr) {
    const u32 inst    = op.inst;
    const u32 rt      = GekkoOperands::RD(inst);
    const u32 spr_num = decode_spr_num(inst);

    // SPR_XER: reconstruct architectural u32 from split storage fields.
    if (spr_num == ppc_off::SPR_XER) {
        auto rc_rt = rc.Bind(rt, RCMode::Write);
        emit_load_arch_xer(wb, ctx_ptr);
        wb.op_local_set(rc_rt.local_idx());
        return;
    }

    if (!spr_is_direct(spr_num)) {
        // Fallback — TBL/TBU/DEC need CoreTiming live values.
        // Mirror emit_fallback (ppc_emit.cpp:56-63): Flush dirty locals so
        // the interp sees current GPR state, then ReloadAll after so later
        // ops' Flush doesn't overwrite the interp's writes with stale
        // locals.
        rc.Flush(ctx_ptr);
        frc.Flush(ctx_ptr);
        wb.op_i32_const((s32)inst);
        wb.op_i32_const((s32)op.address);
        wb.op_call(WIMPORT_INTERP);
        rc.ReloadAll(ctx_ptr);
        frc.ReloadAll(ctx_ptr);
        return;
    }

    auto rc_rt = rc.Bind(rt, RCMode::Write);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load(ppc_off::spr(spr_num));
    wb.op_local_set(rc_rt.local_idx());
}

void emit_mtspr(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr) {
    const u32 inst    = op.inst;
    const u32 rs      = GekkoOperands::RS(inst);
    const u32 spr_num = decode_spr_num(inst);

    // SPR_XER: decompose architectural u32 into split storage fields.
    if (spr_num == ppc_off::SPR_XER) {
        auto rc_rs = rc.Bind(rs, RCMode::Read);
        emit_store_arch_xer(wb, ctx_ptr, rc_rs.local_idx());
        return;
    }

    // SPR_PVR (287) is read-only on real hardware; writes are silently
    // ignored by the interpreter. Emit nothing rather than corrupting the
    // PVR slot in PowerPCState.spr[].
    if (spr_num == ppc_off::SPR_PVR) {
        return;
    }

    if (!spr_is_direct(spr_num)) {
        // Mirror emit_fallback (ppc_emit.cpp:56-63): Flush dirty locals so
        // the interp sees current GPR state, then ReloadAll after so later
        // ops' Flush doesn't overwrite the interp's writes with stale
        // locals.
        rc.Flush(ctx_ptr);
        frc.Flush(ctx_ptr);
        wb.op_i32_const((s32)inst);
        wb.op_i32_const((s32)op.address);
        wb.op_call(WIMPORT_INTERP);
        rc.ReloadAll(ctx_ptr);
        frc.ReloadAll(ctx_ptr);
        return;
    }

    auto rc_rs = rc.Bind(rs, RCMode::Read);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(rc_rs.local_idx());
    wb.op_i32_store(ppc_off::spr(spr_num));
}

void emit_mfmsr(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr) {
    const u32 rt = GekkoOperands::RD(op.inst);
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load(ppc_off::MSR);
    wb.op_local_set(rc_rt.local_idx());
}

void emit_mtmsr(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr) {
    // ASYNC delivery (revert of synchronous-delivery fix). Per
    // feedback_session_2026_05_28_dolphin_run_avoidance and the SAB
    // BS2Emu comment at Boot_BS2Emu.cpp:328-332: "native leaves EE in
    // whatever state apploader left it (typically 0); guest's OSInit
    // enables EE only AFTER setting MEM[0xc0] to &__OSDefaultContext."
    //
    // Synchronous EE-on delivery (which the prior version did via
    // interp fallback on EE=1) exposed the gap: inside __SIInit,
    // OSRestoreInterrupts mtmsr enables EE while MEM[0xc0]=0. Vec 0x500
    // stub does `lwz r4, 0xc0(r0)` → r4=0 → exception save corrupts
    // low MEM at offsets 0xc..0x1ac → __OSUnhandledException → PPCHalt.
    //
    // The PROPER fix needs MEM[0xc0] set before any IRQ delivery. Until
    // that's traced, defer delivery to the heuristic at
    // JitWasm.cpp:5988-6010 — gives OSInit time to progress further.
    //
    // Both paths: store MSR + advance PC. No interp fallback for EE-on.
    // dolphin_check_exc still gets called so the dispatcher KNOWS about
    // pending deliverable exceptions (it returns nonzero, we drop it).
    const u32 rs = GekkoOperands::RS(op.inst);
    auto rc_rs = rc.Bind(rs, RCMode::Read);

    rc.Flush(ctx_ptr);
    frc.Flush(ctx_ptr);

    // [perf] Gate the msr_updated host crossing on MSR.IR/DR actually
    // changing. PowerPCManager::MSRUpdated() (PowerPC.cpp:681) derives
    // feature_flags + membase SOLELY from MSR bits 4 (DR) and 5 (IR)
    // ((msr.Hex>>4)&0x3); nothing else it does is observable on GC (the
    // pagetable path needs DR set AND pagetable_update_pending, which GC's
    // BAT-only MMU never sets). OSDisableInterrupts/OSRestoreInterrupts
    // toggle only MSR.EE (bit 15) and dominate mtmsr traffic — for them the
    // recompute is a pure no-op, but we were paying the wasm->JS crossing
    // (profiled ~4% of JIT-worker time) every time. Compute (old^new)&0x30
    // BEFORE the store, leave it on the wasm stack across the balanced store
    // (store consumes only its own 2 operands), then call msr_updated only
    // when IR/DR moved. rfi (which can also change IR/DR) keeps its own
    // unconditional recompute. Mirrors the intent of Jit64::mtmsr
    // (Jit_SystemRegisters.cpp:446 EmitUpdateMembase).
    constexpr s32 MSR_IR_DR = 0x30;  // bit4 DR | bit5 IR
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load(ppc_off::MSR);            // old MSR
    wb.op_local_get(rc_rs.local_idx());      // new MSR
    wb.op_i32_xor();
    wb.op_i32_const(MSR_IR_DR);
    wb.op_i32_and();                          // gate value (stays on stack)

    // Store new MSR (balanced: pushes ctx+val, i32_store pops both).
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(rc_rs.local_idx());
    wb.op_i32_store(ppc_off::MSR);

    // Recompute feature_flags/membase ONLY when IR/DR changed. type-2
    // import takes (i32,i32) — args unused (handler reads m_ppc_state).
    wb.op_if();
        wb.op_i32_const(0);
        wb.op_i32_const(0);
        wb.op_call(WIMPORT_MSR_UPDATED);
    wb.op_end();

    // Advance PC to op.address+4. The op-level FL_ENDBLOCK ends the block
    // here; epilogue reads PC back. Without this advance the dispatcher
    // would re-enter the same mtmsr → self-loop until the idle heuristic
    // fires CheckExceptions.
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_const((s32)(op.address + 4));
    wb.op_i32_store(ppc_off::PC);

    // Sync NPC = PC before the exception-drain. PowerPC.cpp:600's
    // CheckExternalExceptions captures SRR0 = m_ppc_state.npc; without this
    // store NPC stays at block-entry PC and SRR0 = wrong PC. Mirrors Jit64's
    // WriteExternalExceptionExit (Jit.cpp:719-723) which does
    // `MOV PPCSTATE(npc), pc` immediately before CheckExternalExceptionsFromJIT.
    // Diagnosed via multi-agent JIT correctness hunt 2026-06-04: SAB wedge at
    // SRR0=0x800e78c0 (= OSEnableInterrupts mfmsr = block-entry PC of the
    // mtmsr block) → DBExceptionDestination → PPCHalt.
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_const((s32)(op.address + 4));
    wb.op_i32_store(ppc_off::NPC);

    // Probe pending exceptions (dispatcher signals readiness). Drop result.
    wb.op_i32_const((s32)(op.address + 4));
    wb.op_call(WIMPORT_CHECK_EXC);
    wb.op_drop();
}

// ---------------------------------------------------------------------------
// CR pack/unpack — mfcr / mtcrf. Dolphin stores CR as 8 u64 fields; the
// packed 32-bit format mfcr produces requires extracting LT/GT/EQ/SO bits
// per field via Dolphin's ConditionRegister::GetCRBit logic. Inlining that
// in wasm is non-trivial and these ops are not hot — fall back to interp.
// Matches gekko_emit.cpp:2677/2681 (emit_fallback only).
// ---------------------------------------------------------------------------
static void emit_simple_fallback(WasmModuleBuilder& wb, RegCache& rc,
                                 FPRRegCache& frc, const CodeOp& op,
                                 u32 ctx_ptr) {
    // Mirror emit_fallback (ppc_emit.cpp:56-63): Flush dirty locals so the
    // interp sees current GPR state, then ReloadAll after so later ops'
    // Flush doesn't overwrite the interp's writes with stale locals.
    rc.Flush(ctx_ptr);
    frc.Flush(ctx_ptr);
    wb.op_i32_const((s32)op.inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(WIMPORT_INTERP);
    rc.ReloadAll(ctx_ptr);
    frc.ReloadAll(ctx_ptr);
}

void emit_mfcr(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
               u32 ctx_ptr) {
    emit_simple_fallback(wb, rc, frc, op, ctx_ptr);
}
void emit_mtcrf(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr) {
    emit_simple_fallback(wb, rc, frc, op, ctx_ptr);
}

// ---------------------------------------------------------------------------
// Segment-register / TLB privileged ops — mtsr/mfsr/mtsrin/mfsrin/tlbie.
// These touch MMU state that Dolphin's MemoryInterface tracks outside the
// JIT. The old emitter falls back to interp AND marks block_end=true
// (gekko_emit.cpp:2526-2530); in powerpc-next that's handled by the
// FL_ENDBLOCK flag on table31() metadata. We just emit the fallback;
// PC-advance + epilogue lives in the analyzer/build-block path.
//
// SAB only hits mtsr/mfsr inside __OSPSInit segment-register setup, which
// runs once at boot; tlbie is not used in normal boot. Cheap fallback is
// fine.
// ---------------------------------------------------------------------------
void emit_mtsr(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
               u32 ctx_ptr) {
    emit_simple_fallback(wb, rc, frc, op, ctx_ptr);
}
void emit_mfsr(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
               u32 ctx_ptr) {
    emit_simple_fallback(wb, rc, frc, op, ctx_ptr);
}
void emit_mtsrin(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                 u32 ctx_ptr) {
    emit_simple_fallback(wb, rc, frc, op, ctx_ptr);
}
void emit_mfsrin(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                 u32 ctx_ptr) {
    emit_simple_fallback(wb, rc, frc, op, ctx_ptr);
}
void emit_tlbie(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr) {
    emit_simple_fallback(wb, rc, frc, op, ctx_ptr);
}

}  // namespace bemental::powerpc

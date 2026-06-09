// jit_floating_point.cpp — scalar double-precision FP, V1 = trivial sign/copy
// only. Mirrors Source/Core/Core/PowerPC/Interpreter/Interpreter_FloatingPoint
// .cpp fmr/fneg/fabs/fnabs which only modify ps0(fd) (ps1(fd) preserved).
// Bit-exact via wasm f64.neg / f64.abs (sign-bit flip / clear, NaN payload
// preserved). Rc=1 routes to interp (CR1 update from FPSCR not modeled).
// MSR.FP gate silently skipped — same omission as existing FP emits.

#include "jit_floating_point.h"
#include "bementalJIT/wasm_module_builder.h"
#include "code_op.h"
#include "fpr_reg_cache.h"
#include "ppc_analyst.h"
#include "ppc_offsets.h"
#include "reg_cache.h"

namespace bemental {
namespace powerpc {

static constexpr u32 WIMPORT_INTERP = 6;

static void emit_rc_fallback(WasmModuleBuilder& wb, RegCache& rc,
                             FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    // FP Rc=1 routes through interp (CR1 update from FPSCR not modeled).
    // The interp can mutate ps[] via FPSCR side effects; flush+reload the
    // FPR cache around the call, same boundary as ppc_emit.cpp:emit_fallback.
    rc.Flush(ctx_ptr);
    frc.Flush(ctx_ptr);
    wb.op_i32_const((s32)op.inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(WIMPORT_INTERP);
    rc.ReloadAll(ctx_ptr);
    frc.ReloadAll(ctx_ptr);
}

// fmr fD, fB — ps0(fD) = ps0(fB). ps1(fD) untouched.
void emit_fmrx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd = GekkoOperands::FD(op.inst);
    const u32 fb = GekkoOperands::FB(op.inst);
    if (fd == fb) return;
    // Step-4 plumbing: emit reads ps0(fb) from memory + writes ps0(fd) to
    // memory. Flush before so memory read sees current value; reload after
    // so cache sees new value. Step 5 converts to cache-local copy.
    frc.Flush(ctx_ptr);
    // i64 bit-copy preserves NaN payload + signed zero exactly.
    wb.op_i32_const((s32)ctx_ptr);  // store-addr base
    wb.op_i32_const((s32)ctx_ptr);  // load-addr base
    wb.op_i64_load(ppc_off::ps0(fb));
    wb.op_i64_store(ppc_off::ps0(fd));
    frc.ReloadAll(ctx_ptr);
}

// fneg fD, fB — ps0(fD) = -ps0(fB). f64.neg flips sign bit, NaN payload kept.
void emit_fnegx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd = GekkoOperands::FD(op.inst);
    const u32 fb = GekkoOperands::FB(op.inst);
    frc.Flush(ctx_ptr);
    wb.op_i32_const((s32)ctx_ptr);  // store-addr base
    wb.op_i32_const((s32)ctx_ptr);  // load-addr base
    wb.op_f64_load(ppc_off::ps0(fb));
    wb.op_f64_neg();
    wb.op_f64_store(ppc_off::ps0(fd));
    frc.ReloadAll(ctx_ptr);
}

// fabs fD, fB — ps0(fD) = |ps0(fB)|. f64.abs clears sign bit.
void emit_fabsx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd = GekkoOperands::FD(op.inst);
    const u32 fb = GekkoOperands::FB(op.inst);
    frc.Flush(ctx_ptr);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_f64_load(ppc_off::ps0(fb));
    wb.op_f64_abs();
    wb.op_f64_store(ppc_off::ps0(fd));
    frc.ReloadAll(ctx_ptr);
}

// fnabs fD, fB — ps0(fD) = -|ps0(fB)|. abs then neg.
void emit_fnabsx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd = GekkoOperands::FD(op.inst);
    const u32 fb = GekkoOperands::FB(op.inst);
    frc.Flush(ctx_ptr);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_f64_load(ppc_off::ps0(fb));
    wb.op_f64_abs();
    wb.op_f64_neg();
    wb.op_f64_store(ppc_off::ps0(fd));
    frc.ReloadAll(ctx_ptr);
}

// Double-precision scalar arith — ps0 lane only.
// sub5: 18=div, 20=sub, 21=add, 25=mul. Mirrors ps_binary but single-lane.
// No demote/promote: scalar double-precision keeps full f64 precision.
void emit_fp_arith_double(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd   = GekkoOperands::FD(op.inst);
    const u32 fa   = GekkoOperands::FA(op.inst);
    const u32 fb   = GekkoOperands::FB(op.inst);
    const u32 fc   = GekkoOperands::FC(op.inst);
    const u32 sub5 = GekkoOperands::SUBOP5(op.inst);
    const u32 arg2 = (sub5 == 25) ? fc : fb;  // fmul uses fc; others use fb.

    frc.Flush(ctx_ptr);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_f64_load(ppc_off::ps0(fa));
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_f64_load(ppc_off::ps0(arg2));
    switch (sub5) {
    case 18: wb.op_f64_div(); break;
    case 20: wb.op_f64_sub(); break;
    case 21: wb.op_f64_add(); break;
    case 25: wb.op_f64_mul(); break;
    default: break;
    }
    wb.op_f64_store(ppc_off::ps0(fd));
    frc.ReloadAll(ctx_ptr);
}

// Double-precision FMA family — ps0 lane only.
// sub5: 28=fmsub, 29=fmadd, 30=fnmsub, 31=fnmadd. Mirrors ps_fma.
void emit_fp_fma_double(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd   = GekkoOperands::FD(op.inst);
    const u32 fa   = GekkoOperands::FA(op.inst);
    const u32 fb   = GekkoOperands::FB(op.inst);
    const u32 fc   = GekkoOperands::FC(op.inst);
    const u32 sub5 = GekkoOperands::SUBOP5(op.inst);
    const bool subtract = (sub5 == 28) || (sub5 == 30);
    const bool negate   = (sub5 == 30) || (sub5 == 31);

    frc.Flush(ctx_ptr);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_f64_load(ppc_off::ps0(fa));
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_f64_load(ppc_off::ps0(fc));
    wb.op_f64_mul();
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_f64_load(ppc_off::ps0(fb));
    if (subtract) wb.op_f64_sub();
    else          wb.op_f64_add();
    if (negate)   wb.op_f64_neg();
    wb.op_f64_store(ppc_off::ps0(fd));
    frc.ReloadAll(ctx_ptr);
}

}  // namespace powerpc
}  // namespace bemental

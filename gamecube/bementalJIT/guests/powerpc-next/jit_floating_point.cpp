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
#include "jit_load_store.h"   // emit_psq_convert_to_double (NaN-exact widen)
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
// Cache-local i64 copy — preserves NaN payload + signed zero exactly.
// No memory traffic at the emit site; memory becomes canonical on
// frc.Flush at block exit / fallback / branch.
void emit_fmrx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd = GekkoOperands::FD(op.inst);
    const u32 fb = GekkoOperands::FB(op.inst);
    if (fd == fb) return;
    // Bind fb's ps0 for Read, fd's ps0 for Write. Both lanes-mask = PS0
    // only (scalar FP semantics — ps1 preserved). i64 local-get + local-set
    // is the wasm equivalent of x86 MOVQ; bit-exact for any 64-bit pattern.
    auto fb_pair = frc.Bind(fb, FPRMode::Read,  FPR_LANE_PS0);
    auto fd_pair = frc.Bind(fd, FPRMode::Write, FPR_LANE_PS0);
    wb.op_local_get(fb_pair.ps0_idx);
    wb.op_local_set(fd_pair.ps0_idx);
}

// fneg fD, fB — ps0(fD) = -ps0(fB). f64.neg flips sign bit, NaN payload kept.
void emit_fnegx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd = GekkoOperands::FD(op.inst);
    const u32 fb = GekkoOperands::FB(op.inst);
    auto fb_pair = frc.Bind(fb, FPRMode::Read,  FPR_LANE_PS0);
    auto fd_pair = frc.Bind(fd, FPRMode::Write, FPR_LANE_PS0);
    wb.op_local_get(fb_pair.ps0_idx);
    wb.op_f64_reinterpret_i64();
    wb.op_f64_neg();
    wb.op_i64_reinterpret_f64();
    wb.op_local_set(fd_pair.ps0_idx);
}

// fabs fD, fB — ps0(fD) = |ps0(fB)|. f64.abs clears sign bit.
void emit_fabsx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd = GekkoOperands::FD(op.inst);
    const u32 fb = GekkoOperands::FB(op.inst);
    auto fb_pair = frc.Bind(fb, FPRMode::Read,  FPR_LANE_PS0);
    auto fd_pair = frc.Bind(fd, FPRMode::Write, FPR_LANE_PS0);
    wb.op_local_get(fb_pair.ps0_idx);
    wb.op_f64_reinterpret_i64();
    wb.op_f64_abs();
    wb.op_i64_reinterpret_f64();
    wb.op_local_set(fd_pair.ps0_idx);
}

// fnabs fD, fB — ps0(fD) = -|ps0(fB)|. abs then neg.
void emit_fnabsx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd = GekkoOperands::FD(op.inst);
    const u32 fb = GekkoOperands::FB(op.inst);
    auto fb_pair = frc.Bind(fb, FPRMode::Read,  FPR_LANE_PS0);
    auto fd_pair = frc.Bind(fd, FPRMode::Write, FPR_LANE_PS0);
    wb.op_local_get(fb_pair.ps0_idx);
    wb.op_f64_reinterpret_i64();
    wb.op_f64_abs();
    wb.op_f64_neg();
    wb.op_i64_reinterpret_f64();
    wb.op_local_set(fd_pair.ps0_idx);
}

// Double-precision scalar arith — ps0 lane only.
// sub5: 18=div, 20=sub, 21=add, 25=mul. Mirrors ps_binary but single-lane.
// No demote/promote: scalar double-precision keeps full f64 precision.
//
// Cache-local form: bind fa/arg2 ps0 (Read), bind fd ps0 (Write).
// Operands loaded from cache locals (i64) and reinterpreted to f64 at the
// use site; result reinterpreted back to i64 and stored into fd's local.
// Memory becomes canonical at block-exit Flush — no per-op memory traffic.
void emit_fp_arith_double(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd   = GekkoOperands::FD(op.inst);
    const u32 fa   = GekkoOperands::FA(op.inst);
    const u32 fb   = GekkoOperands::FB(op.inst);
    const u32 fc   = GekkoOperands::FC(op.inst);
    const u32 sub5 = GekkoOperands::SUBOP5(op.inst);
    const u32 arg2 = (sub5 == 25) ? fc : fb;  // fmul uses fc; others use fb.

    auto fa_pair   = frc.Bind(fa,   FPRMode::Read,  FPR_LANE_PS0);
    auto arg2_pair = frc.Bind(arg2, FPRMode::Read,  FPR_LANE_PS0);
    auto fd_pair   = frc.Bind(fd,   FPRMode::Write, FPR_LANE_PS0);

    wb.op_local_get(fa_pair.ps0_idx);
    wb.op_f64_reinterpret_i64();
    wb.op_local_get(arg2_pair.ps0_idx);
    wb.op_f64_reinterpret_i64();
    switch (sub5) {
    case 18: wb.op_f64_div(); break;
    case 20: wb.op_f64_sub(); break;
    case 21: wb.op_f64_add(); break;
    case 25: wb.op_f64_mul(); break;
    default: break;
    }
    wb.op_i64_reinterpret_f64();
    wb.op_local_set(fd_pair.ps0_idx);
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

    auto fa_pair = frc.Bind(fa, FPRMode::Read,  FPR_LANE_PS0);
    auto fb_pair = frc.Bind(fb, FPRMode::Read,  FPR_LANE_PS0);
    auto fc_pair = frc.Bind(fc, FPRMode::Read,  FPR_LANE_PS0);
    auto fd_pair = frc.Bind(fd, FPRMode::Write, FPR_LANE_PS0);

    wb.op_local_get(fa_pair.ps0_idx);
    wb.op_f64_reinterpret_i64();
    wb.op_local_get(fc_pair.ps0_idx);
    wb.op_f64_reinterpret_i64();
    wb.op_f64_mul();
    wb.op_local_get(fb_pair.ps0_idx);
    wb.op_f64_reinterpret_i64();
    if (subtract) wb.op_f64_sub();
    else          wb.op_f64_add();
    if (negate)   wb.op_f64_neg();
    wb.op_i64_reinterpret_f64();
    wb.op_local_set(fd_pair.ps0_idx);
}

// ---------------------------------------------------------------------------
// op59 single-precision arithmetic + op63 frsp (2026-06-12).
// Reference: Interpreter_FloatingPoint.cpp + Interpreter_FPUtils.h.
// Result = ForceSingle(fpscr, <f64 op>) Filled into BOTH lanes of fd.
// ---------------------------------------------------------------------------

// Scratch locals — group 6 in build_block_next ({2,32,64,2,1,2}); the two
// i32 psq stages (98/99) are reused for f32-bit twiddling / the NI flag.
static constexpr u32 LOCAL_FP_T0    = 98;   // i32 — f32 result bits (widen input)
static constexpr u32 LOCAL_FP_T1    = 99;   // i32 — runtime FPSCR.NI flag
static constexpr u32 LOCAL_FP_I64_A = 101;  // i64 — bit-twiddle stage
static constexpr u32 LOCAL_FP_I64_B = 102;  // i64 — Force25Bit shift

// Force25Bit (Interpreter_FPUtils.h:91-124): i64 double bits on stack ->
// i64 on stack. Normal path: (i & ~0x7FFFFFF) + (i & 0x8000000) — round-
// half-up at 25 significant bits (carry may propagate, intended). Subnormal
// path shifts the mask/round right until the fraction MSB would reach the
// exponent: shift = clz(frac) - (63 - 52); keep_mask is an ARITHMETIC
// shift (s64 in the reference), round a logical one.
static void emit_force25bit(WasmModuleBuilder& wb) {
    wb.op_local_set(LOCAL_FP_I64_A);
    // subnormal? exp==0 && frac!=0
    wb.op_local_get(LOCAL_FP_I64_A);
    wb.op_i64_const(0x7FF0000000000000ll);
    wb.op_i64_and();
    wb.op_i64_eqz();
    wb.op_local_get(LOCAL_FP_I64_A);
    wb.op_i64_const(0x000FFFFFFFFFFFFFll);
    wb.op_i64_and();
    wb.op_i64_eqz();
    wb.op_i32_eqz();
    wb.op_i32_and();
    wb.op_if(/*BLOCK_TYPE_VOID*/);
    {
        wb.op_local_get(LOCAL_FP_I64_A);
        wb.op_i64_const(0x000FFFFFFFFFFFFFll);
        wb.op_i64_and();
        wb.op_i64_clz();
        wb.op_i64_const(11);  // 63 - DOUBLE_FRAC_WIDTH(52)
        wb.op_i64_sub();
        wb.op_local_set(LOCAL_FP_I64_B);
        wb.op_i64_const((s64)0xFFFFFFFFF8000000ll);
        wb.op_local_get(LOCAL_FP_I64_B);
        wb.op_i64_shr_s();
        wb.op_local_get(LOCAL_FP_I64_A);
        wb.op_i64_and();
        wb.op_i64_const(0x8000000ll);
        wb.op_local_get(LOCAL_FP_I64_B);
        wb.op_i64_shr_u();
        wb.op_local_get(LOCAL_FP_I64_A);
        wb.op_i64_and();
        wb.op_i64_add();
        wb.op_local_set(LOCAL_FP_I64_A);
    }
    wb.op_else();
    {
        wb.op_local_get(LOCAL_FP_I64_A);
        wb.op_i64_const((s64)0xFFFFFFFFF8000000ll);
        wb.op_i64_and();
        wb.op_local_get(LOCAL_FP_I64_A);
        wb.op_i64_const(0x8000000ll);
        wb.op_i64_and();
        wb.op_i64_add();
        wb.op_local_set(LOCAL_FP_I64_A);
    }
    wb.op_end();
    wb.op_local_get(LOCAL_FP_I64_A);
}

// ForceSingle(fpscr, f64-on-stack) + Fill(fd both lanes).
// Interpreter_FPUtils.h:53-80 with the NI gate read from ctx FPSCR at
// RUNTIME (bit 2 = 0x4):
//   NI: |x| < 2^-126 (double compare, pre-cast)  -> signed zero
//   cast to f32 (wasm f32.demote_f64 = host cvtsd2ss = interp cast)
//   NI: f32 subnormal result                     -> signed zero (FlushToZero)
// Widen back NaN-payload-exact via emit_psq_convert_to_double (reads
// LOCAL_FP_T0); both fd lanes set (ps[FD].Fill).
static void emit_force_single_fill(WasmModuleBuilder& wb, const RCFprPair& fd_pair, u32 ctx_ptr) {
    wb.op_i64_reinterpret_f64();
    wb.op_local_set(LOCAL_FP_I64_A);
    // T1 = FPSCR & 4 (NI)
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load(ppc_off::FPSCR);
    wb.op_i32_const(4);
    wb.op_i32_and();
    wb.op_local_set(LOCAL_FP_T1);
    // stage 1 — NI pre-cast flush of single-subnormal magnitudes
    wb.op_local_get(LOCAL_FP_T1);
    wb.op_if(/*VOID*/);
    {
        wb.op_local_get(LOCAL_FP_I64_A);
        wb.op_i64_const(0x7FFFFFFFFFFFFFFFll);
        wb.op_i64_and();
        wb.op_i64_const(0x3810000000000000ll);  // smallest normal single, as double
        wb.op_i64_lt_u();
        wb.op_if(/*VOID*/);
        {
            wb.op_local_get(LOCAL_FP_I64_A);
            wb.op_i64_const((s64)0x8000000000000000ll);
            wb.op_i64_and();
            wb.op_local_set(LOCAL_FP_I64_A);
        }
        wb.op_end();
    }
    wb.op_end();
    // stage 2 — demote
    wb.op_local_get(LOCAL_FP_I64_A);
    wb.op_f64_reinterpret_i64();
    wb.op_f32_demote_f64();
    wb.op_i32_reinterpret_f32();
    wb.op_local_set(LOCAL_FP_T0);
    // stage 3 — NI post-cast f32 denormal flush (Common::FlushToZero).
    // (bits & 0x7FFFFFFF) < 0x00800000 covers subnormal AND zero (zero is
    // unchanged by the sign-only mask).
    wb.op_local_get(LOCAL_FP_T1);
    wb.op_if(/*VOID*/);
    {
        wb.op_local_get(LOCAL_FP_T0);
        wb.op_i32_const(0x7FFFFFFF);
        wb.op_i32_and();
        wb.op_i32_const(0x00800000);
        wb.op_i32_lt_u();
        wb.op_if(/*VOID*/);
        {
            wb.op_local_get(LOCAL_FP_T0);
            wb.op_i32_const((s32)0x80000000);
            wb.op_i32_and();
            wb.op_local_set(LOCAL_FP_T0);
        }
        wb.op_end();
    }
    wb.op_end();
    // widen + Fill both lanes
    emit_psq_convert_to_double(wb);
    wb.op_local_set(fd_pair.ps0_idx);
    wb.op_local_get(fd_pair.ps0_idx);
    wb.op_local_set(fd_pair.ps1_idx);
}

// op59 singles arith. sub5: 18=fdivs, 20=fsubs, 21=fadds, 25=fmuls.
// fmuls applies Force25Bit to frC (Interpreter fmulsx:371). Result
// ForceSingle'd and Filled into both lanes. Double-then-single rounding is
// EXACT for add/sub/mul/div (Interpreter_FPUtils.h:297-318 comment).
void emit_fp_arith_single(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd   = GekkoOperands::FD(op.inst);
    const u32 fa   = GekkoOperands::FA(op.inst);
    const u32 fb   = GekkoOperands::FB(op.inst);
    const u32 fc   = GekkoOperands::FC(op.inst);
    const u32 sub5 = GekkoOperands::SUBOP5(op.inst);
    const u32 arg2 = (sub5 == 25) ? fc : fb;

    auto fa_pair   = frc.Bind(fa,   FPRMode::Read,  FPR_LANE_PS0);
    auto arg2_pair = frc.Bind(arg2, FPRMode::Read,  FPR_LANE_PS0);
    auto fd_pair   = frc.Bind(fd,   FPRMode::Write, FPR_LANE_BOTH);

    wb.op_local_get(fa_pair.ps0_idx);
    wb.op_f64_reinterpret_i64();
    wb.op_local_get(arg2_pair.ps0_idx);
    if (sub5 == 25) emit_force25bit(wb);
    wb.op_f64_reinterpret_i64();
    switch (sub5) {
    case 18: wb.op_f64_div(); break;
    case 20: wb.op_f64_sub(); break;
    case 21: wb.op_f64_add(); break;
    case 25: wb.op_f64_mul(); break;
    default: break;
    }
    emit_force_single_fill(wb, fd_pair, ctx_ptr);
}

// op59 FMA family. sub5: 28=fmsubs, 29=fmadds, 30=fnmsubs, 31=fnmadds.
// frC Force25Bit'd (NI_madd_msub<single=true> quirk #2/#3). UNFUSED
// f64 mul-then-add (Jit64-without-hardware-FMA parity) — PPC fuses;
// divergence only on round-to-nearest ties (Interpreter_FPUtils.h:297+).
void emit_fp_fma_single(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd   = GekkoOperands::FD(op.inst);
    const u32 fa   = GekkoOperands::FA(op.inst);
    const u32 fb   = GekkoOperands::FB(op.inst);
    const u32 fc   = GekkoOperands::FC(op.inst);
    const u32 sub5 = GekkoOperands::SUBOP5(op.inst);
    const bool subtract = (sub5 == 28) || (sub5 == 30);
    const bool negate   = (sub5 == 30) || (sub5 == 31);

    auto fa_pair = frc.Bind(fa, FPRMode::Read,  FPR_LANE_PS0);
    auto fb_pair = frc.Bind(fb, FPRMode::Read,  FPR_LANE_PS0);
    auto fc_pair = frc.Bind(fc, FPRMode::Read,  FPR_LANE_PS0);
    auto fd_pair = frc.Bind(fd, FPRMode::Write, FPR_LANE_BOTH);

    wb.op_local_get(fa_pair.ps0_idx);
    wb.op_f64_reinterpret_i64();
    wb.op_local_get(fc_pair.ps0_idx);
    emit_force25bit(wb);
    wb.op_f64_reinterpret_i64();
    wb.op_f64_mul();
    wb.op_local_get(fb_pair.ps0_idx);
    wb.op_f64_reinterpret_i64();
    if (subtract) wb.op_f64_sub();
    else          wb.op_f64_add();
    if (negate)   wb.op_f64_neg();
    emit_force_single_fill(wb, fd_pair, ctx_ptr);
}

// fctiwz (op63 sub10=15): ps0(fD) = 0xFFF8000000000000 | value, where
// value = (s32)trunc(ps0(fB)) saturated (>=2^31 -> 0x7FFFFFFF, <-2^31 ->
// 0x80000000), NaN -> 0x80000000; bit 32 set when value==0 && signbit(b).
// ps1 untouched (Interpreter ConvertToInteger uses SetPS0). wasm
// i32.trunc_sat_f64_s matches the trunc+saturate exactly; only the NaN
// result differs (sat gives 0) — fixed with a select. FPSCR FI/FR/VXCVI
// not modeled (doubles-precedent divergence); fctiw (sub10=14) stays
// interp (depends on runtime FPSCR.RN).
void emit_fctiwz(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd = GekkoOperands::FD(op.inst);
    const u32 fb = GekkoOperands::FB(op.inst);
    auto fb_pair = frc.Bind(fb, FPRMode::Read,  FPR_LANE_PS0);
    auto fd_pair = frc.Bind(fd, FPRMode::Write, FPR_LANE_PS0);
    wb.op_local_get(fb_pair.ps0_idx);
    wb.op_local_set(LOCAL_FP_I64_A);
    // T0 = select(0x80000000 [NaN], trunc_sat(b), b != b)
    wb.op_i32_const((s32)0x80000000);
    wb.op_local_get(LOCAL_FP_I64_A);
    wb.op_f64_reinterpret_i64();
    wb.op_i32_trunc_sat_f64_s();
    wb.op_local_get(LOCAL_FP_I64_A);
    wb.op_f64_reinterpret_i64();
    wb.op_local_get(LOCAL_FP_I64_A);
    wb.op_f64_reinterpret_i64();
    wb.op_f64_ne();
    wb.op_select();
    wb.op_local_set(LOCAL_FP_T0);
    // ps0 = 0xFFF8000000000000 | zext(value) | ((value==0 && signbit) << 32)
    wb.op_local_get(LOCAL_FP_T0);
    wb.op_i64_extend_i32_u();
    wb.op_i64_const((s64)0xFFF8000000000000ll);
    wb.op_i64_or();
    wb.op_local_get(LOCAL_FP_T0);
    wb.op_i32_eqz();
    wb.op_local_get(LOCAL_FP_I64_A);
    wb.op_i64_const(63);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_and();
    wb.op_i64_extend_i32_u();
    wb.op_i64_const(32);
    wb.op_i64_shl();
    wb.op_i64_or();
    wb.op_local_set(fd_pair.ps0_idx);
}

// frsp (op63 sub10=12): ps[FD].Fill(ForceSingle(fpscr, ps0(fB))).
void emit_frsp(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd = GekkoOperands::FD(op.inst);
    const u32 fb = GekkoOperands::FB(op.inst);
    auto fb_pair = frc.Bind(fb, FPRMode::Read,  FPR_LANE_PS0);
    auto fd_pair = frc.Bind(fd, FPRMode::Write, FPR_LANE_BOTH);
    wb.op_local_get(fb_pair.ps0_idx);
    wb.op_f64_reinterpret_i64();
    emit_force_single_fill(wb, fd_pair, ctx_ptr);
}

}  // namespace powerpc
}  // namespace bemental

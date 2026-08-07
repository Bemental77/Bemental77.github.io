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
#include "jit_fp_helpers.h"   // [oracle-audit 2026-07-12] shared Force25Bit/
                              // ForceSingle/ForceDouble/NaN-ladder/FMA helpers
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
    // [pc-sync A4 2026-06-28] fmr./fabs./fneg./fsel. lack FL_USE_FPU (ppc_tables.cpp)
    // so the set_pc gate (ppc_emit.cpp:755) does not set pc; under the cutover the
    // dolphin_interp guard (dolphin_jit_wimports.cpp:294) would silently skip the
    // whole op. Store pc first. Matches ppc_emit.cpp:187-189.
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_const((s32)op.address);
    wb.op_i32_store(ppc_off::PC);
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

// fcmpu (op63 sub 0) / fcmpo (op63 sub 32) — scalar FP compare, NATIVE.
// [PM62 2026-08-05] Board profile: fcmpu 21.2M + fcmpo 15.1M interp fallbacks
// (36M, the dominant EmuThread interpreter cost on the MP4 3D board). Ported
// from the proven gekko emit_fcmpu_impl, RE-ENCODED to the powerpc-next packed
// CR scheme (cr_encode.cpp): u64 @ ppc_off::cr(crfd),
//   hi32 = 1 | (fu<<27) | (lt<<30) | (not_gt<<31),  lo32 = (ne ? 1 : 0)
// decoded as LT=bit30, GT=!bit31, EQ=(lo32==0), SO=bit27. bit27 here is the FP
// UNORDERED bit (either operand NaN), NOT XER.SO — so emit_cr_from_*_pair (which
// hardcodes XER.SO in bit27) can't be reused. not_gt = !(fa>fb) is true for
// LT/EQ/unordered and false only for GT, matching the integer decode's rule that
// EQ have not_gt=1. WASM f64 compares return 0 on NaN, so lt/gt/ne fall out
// correctly for the unordered case. fcmpo differs only in FPSCR VXVC / SNaN
// exception raising, which we skip (FP exceptions run masked, like native) —
// identical impl. FPSCR FX/VXSNAN/FPCC skipped (games read the CR field).
void emit_fcmpu(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                const CodeOp& op, u32 ctx_ptr) {
    const u32 crfd = GekkoOperands::CRFD(op.inst);
    // [PM63] Do NOT honor op.crDiscardable here — the analyzer's CR-liveness may
    // not model fcmpu as a CR writer (it was always interp-fallback before), so a
    // "dead" field it flags could actually be read by a later branch (cold boot
    // DVD stall). Always write; the interp fallback always did.
    const u32 fa = GekkoOperands::FA(op.inst);
    const u32 fb = GekkoOperands::FB(op.inst);
    auto fa_pair = frc.Bind(fa, FPRMode::Read, FPR_LANE_PS0);
    auto fb_pair = frc.Bind(fb, FPRMode::Read, FPR_LANE_PS0);
    const u32 A = fa_pair.ps0_idx, B = fb_pair.ps0_idx;
    auto push_fa = [&] { wb.op_local_get(A); wb.op_f64_reinterpret_i64(); };
    auto push_fb = [&] { wb.op_local_get(B); wb.op_f64_reinterpret_i64(); };

    wb.op_i32_const((s32)ctx_ptr);                    // i64.store address

    // ---- hi32 ----
    wb.op_i32_const(1);                               // bit0 marker (u64 bit 32)
    push_fa(); push_fa(); wb.op_f64_ne();             // is_nan = (fa!=fa)|(fb!=fb)
    push_fb(); push_fb(); wb.op_f64_ne();
    wb.op_i32_or();
    wb.op_i32_const(27); wb.op_i32_shl(); wb.op_i32_or();   // | fu<<27
    push_fa(); push_fb(); wb.op_f64_lt();             // lt = fa<fb
    wb.op_i32_const(30); wb.op_i32_shl(); wb.op_i32_or();   // | lt<<30
    push_fa(); push_fb(); wb.op_f64_gt(); wb.op_i32_eqz();  // not_gt = !(fa>fb)
    wb.op_i32_const(31); wb.op_i32_shl(); wb.op_i32_or();   // | not_gt<<31
    wb.op_i64_extend_i32_u(); wb.op_i64_const(32); wb.op_i64_shl();  // hi32 << 32

    // ---- lo32 = (ne ? 1 : 0) : 0 only on true EQ ----
    push_fa(); push_fb(); wb.op_f64_ne();
    wb.op_i64_extend_i32_u(); wb.op_i64_or();

    wb.op_i64_store(ppc_off::cr(crfd));
}

// fsel (op63 A-form sub5 23) — frD = (ps0(frA) >= 0.0) ? ps0(frC) : ps0(frB).
// [PM62] board: 3.3M interp fallbacks. Branchless FP select. PPC semantics:
// -0.0 >= 0.0 is TRUE (→frC), NaN >= 0.0 is FALSE (→frB) — WASM f64.ge matches
// both. Operates on the raw i64 ps0 patterns via wasm `select` (numeric-typed),
// so no reinterpret round-trip on the selected value (bit-exact). fsel. (Rc=1)
// updates CR1 from FPSCR — rare, kept on the interp path.
void emit_fsel(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd = GekkoOperands::FD(op.inst);
    const u32 fa = GekkoOperands::FA(op.inst);
    const u32 fb = GekkoOperands::FB(op.inst);
    const u32 fc = GekkoOperands::FC(op.inst);
    auto fa_pair = frc.Bind(fa, FPRMode::Read,  FPR_LANE_PS0);
    auto fb_pair = frc.Bind(fb, FPRMode::Read,  FPR_LANE_PS0);
    auto fc_pair = frc.Bind(fc, FPRMode::Read,  FPR_LANE_PS0);
    auto fd_pair = frc.Bind(fd, FPRMode::Write, FPR_LANE_PS0);
    // select(fc, fb, cond) : cond!=0 ? fc : fb ; cond = ps0(fa) >= 0.0
    wb.op_local_get(fc_pair.ps0_idx);          // true value  (i64)
    wb.op_local_get(fb_pair.ps0_idx);          // false value (i64)
    wb.op_local_get(fa_pair.ps0_idx); wb.op_f64_reinterpret_i64();
    wb.op_f64_const(0.0);
    wb.op_f64_ge();                            // cond (0 for <0 or NaN)
    wb.op_select();
    wb.op_local_set(fd_pair.ps0_idx);
}

// fres (op59 sub5 24) — frD = 1/ps0(frB), FILLED INTO BOTH PAIRED-SINGLE LANES.
// [PM62] board 1.7M interp fallbacks. FULL-PRECISION reciprocal (f64.div) instead
// of the PPC estimate: exact on every special case (0->+inf, inf->0, NaN->NaN,
// -0->-inf) and MORE accurate than the 5-bit estimate on normals — the guest's
// Newton-Raphson refinement converges regardless, so it's board-safe. Faster than
// the interp estimate-table fallback. FPSCR (FPRF/exceptions) skipped like the
// other native FP ops (native runs them off). fres. (Rc=1) -> interp (rare).
//
// [PM64] fres is op59 (single-precision family): Gekko fills BOTH ps0 AND ps1
// (Dolphin fresx -> ps[FD].Fill(result), Interpreter_FloatingPoint.cpp:520), same
// as the fdivs/fmuls sibling emit_fp_arith_single (FPR_LANE_BOTH +
// emit_force_single_fill). The original ps0-only write left ps1 STALE — a later
// paired-single consumer (ps_mul/ps_madd/psq_st reads ps1, jit_paired.cpp) picked
// up garbage in lane 1, warping 3D transform math while the scalar-only 2D HUD
// stayed correct (the SAB City-Escape shear). Fix: bind BOTH lanes and replicate
// ps0 into ps1 (both lanes hold the same full-precision value — that equality is
// the invariant that matters; ps0's estimate-vs-exact value is unchanged).
void emit_fres(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd = GekkoOperands::FD(op.inst);
    const u32 fb = GekkoOperands::FB(op.inst);
    auto fb_pair = frc.Bind(fb, FPRMode::Read,  FPR_LANE_PS0);
    auto fd_pair = frc.Bind(fd, FPRMode::Write, FPR_LANE_BOTH);
    wb.op_f64_const(1.0);
    wb.op_local_get(fb_pair.ps0_idx); wb.op_f64_reinterpret_i64();
    wb.op_f64_div();                           // 1.0 / ps0(fb)
    wb.op_i64_reinterpret_f64();
    wb.op_local_set(fd_pair.ps0_idx);
    wb.op_local_get(fd_pair.ps0_idx);          // Fill: ps1 = ps0 (both-lane single)
    wb.op_local_set(fd_pair.ps1_idx);
}

// frsqrte (op63 sub5 26) — ps0(frD) = 1/sqrt(ps0(frB)). [PM62] board 8.1M interp
// fallbacks (the biggest remaining FP fallback — 3D normalization/perspective).
// Full-precision 1/sqrt (exact on 0->+inf, neg->NaN, inf->0, NaN->NaN; Newton-safe
// on normals). FPSCR skipped. frsqrte. (Rc=1) -> interp.
void emit_frsqrte(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                  const CodeOp& op, u32 ctx_ptr) {
    if (GekkoOperands::Rc(op.inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 fd = GekkoOperands::FD(op.inst);
    const u32 fb = GekkoOperands::FB(op.inst);
    auto fb_pair = frc.Bind(fb, FPRMode::Read,  FPR_LANE_PS0);
    auto fd_pair = frc.Bind(fd, FPRMode::Write, FPR_LANE_PS0);
    wb.op_f64_const(1.0);
    wb.op_local_get(fb_pair.ps0_idx); wb.op_f64_reinterpret_i64();
    wb.op_f64_sqrt();
    wb.op_f64_div();                           // 1.0 / sqrt(ps0(fb))
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
// [C8+C12a 2026-07-12 oracle-audit] faddx/fsubx/fmulx/fdivx call NI_add/sub/
// mul/div (NaN ladder: MakeQuiet(first-NaN a->b) or PPC_NAN default) then
// ForceDouble (NI-gated FlushToZero, Interpreter_FloatingPoint.cpp:354/443/
// 483/744). fmulx double does NOT Force25Bit (only fmulsx/ps_mul do — C3).
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

    // Stash a, b for the NaN ladder (emit_nan_fixup_2op reads LOCAL_FMA_A/B).
    wb.op_local_get(fa_pair.ps0_idx);
    wb.op_f64_reinterpret_i64();
    wb.op_local_set(LOCAL_FMA_A);
    wb.op_local_get(arg2_pair.ps0_idx);
    wb.op_f64_reinterpret_i64();
    wb.op_local_set(LOCAL_FMA_B);
    // raw op
    wb.op_local_get(LOCAL_FMA_A);
    wb.op_local_get(LOCAL_FMA_B);
    switch (sub5) {
    case 18: wb.op_f64_div(); break;
    case 20: wb.op_f64_sub(); break;
    case 21: wb.op_f64_add(); break;
    case 25: wb.op_f64_mul(); break;
    default: break;
    }
    emit_nan_fixup_2op(wb);          // [C8] NaN ladder
    emit_force_double_setps0(wb, fd_pair, ctx_ptr);  // [C12a] ForceDouble->ps0
}

// Double-precision FMA family — ps0 lane only.
// sub5: 28=fmsub, 29=fmadd, 30=fnmsub, 31=fnmadd.
// [C2+C8+C12a 2026-07-12 oracle-audit] fused std::fma via emit_fma_core
// (bit-exact for single-prec inputs; ~1-ULP-on-subnormal-double residual
// documented in jit_fp_helpers.h). NaN ladder (MakeQuiet first-NaN a->b->c
// or PPC_NAN default) then ForceDouble; fnmadd/fnmsub apply the NaN-safe
// negate (std::isnan(tmp)?tmp:-tmp) AFTER ForceDouble, matching lines 653-654
// / 699-700. Note: fnmadd/fnmsub negate ForceDouble(product) — so negate goes
// after emit_force_double, on the value re-loaded from ps0.
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

    // Stage a, c (double FMA: NO Force25Bit — only the single family rounds c),
    // b. emit_fma_stage keeps A0/C0/B0 (primitive) + A/M2/B (NaN-ladder
    // originals) disjoint, so no re-stage is needed after emit_fma_core.
    emit_fma_stage(wb, fa_pair.ps0_idx, fc_pair.ps0_idx, fb_pair.ps0_idx,
                   /*force25_c=*/false);
    emit_fma_core(wb, subtract, /*single=*/false);  // [C2] round(a*c+(sub?-b:b))
    emit_nan_fixup_fma(wb);          // [C8] NaN ladder (gated on isnan(result), a->b->c)
    // ForceDouble then optional NaN-safe negate (fnmadd/fnmsub).
    emit_force_double_i64(wb, ctx_ptr);
    wb.op_f64_reinterpret_i64();
    if (negate) emit_nan_safe_neg(wb);  // [C8b] isnan(tmp)?tmp:-tmp
    wb.op_i64_reinterpret_f64();
    wb.op_local_set(fd_pair.ps0_idx);
}

// ---------------------------------------------------------------------------
// op59 single-precision arithmetic + op63 frsp (2026-06-12).
// Reference: Interpreter_FloatingPoint.cpp + Interpreter_FPUtils.h.
// Result = ForceSingle(fpscr, <f64 op>) Filled into BOTH lanes of fd.
// ---------------------------------------------------------------------------

// [oracle-audit 2026-07-12] Force25Bit, ForceSingle (emit_force_single_i64 /
// emit_force_single_fill), ForceDouble (emit_force_double_i64 /
// emit_force_double_setps0), the NaN ladder (emit_nan_fixup_2op /
// emit_nan_fixup_fma), emit_nan_safe_neg, and the correctly-rounded FMA core
// (emit_fma_core) now live in jit_fp_helpers.h so the paired emitters can
// share them. Scratch-local constants (LOCAL_FP_*, LOCAL_FMA_*) also moved
// there. All numerically cross-checked vs Interpreter_FPUtils.h (see report).

// op59 singles arith. sub5: 18=fdivs, 20=fsubs, 21=fadds, 25=fmuls.
// [C8 2026-07-12 oracle-audit] add the NI_add/sub/mul/div NaN ladder before
// ForceSingle (Interpreter fadds/fsubs/fmuls/fdivs). fmuls applies Force25Bit
// to frC (Interpreter fmulsx:371 — C3). Result ForceSingle'd + Filled into
// both lanes. Double-then-single rounding is EXACT for add/sub/mul/div
// (Interpreter_FPUtils.h:297-318 comment).
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

    // Stash a and the (possibly Force25Bit'd) b for the NaN ladder. The NaN
    // ladder must see the SAME b the multiply used; for fmuls that is the
    // Force25Bit'd c — which matches the oracle (NI_mul(a, c_value)).
    wb.op_local_get(fa_pair.ps0_idx);
    wb.op_f64_reinterpret_i64();
    wb.op_local_set(LOCAL_FMA_A);
    wb.op_local_get(arg2_pair.ps0_idx);
    if (sub5 == 25) emit_force25bit(wb);  // [C3] Force25Bit(frC) for fmuls
    wb.op_f64_reinterpret_i64();
    wb.op_local_set(LOCAL_FMA_B);
    // raw op
    wb.op_local_get(LOCAL_FMA_A);
    wb.op_local_get(LOCAL_FMA_B);
    switch (sub5) {
    case 18: wb.op_f64_div(); break;
    case 20: wb.op_f64_sub(); break;
    case 21: wb.op_f64_add(); break;
    case 25: wb.op_f64_mul(); break;
    default: break;
    }
    emit_nan_fixup_2op(wb);          // [C8] NaN ladder
    emit_force_single_fill(wb, fd_pair, ctx_ptr);
}

// op59 FMA family. sub5: 28=fmsubs, 29=fmadds, 30=fnmsubs, 31=fnmadds.
// [C2+C3+C8 2026-07-12 oracle-audit] FUSED std::fma via emit_fma_core (VERIFIED
// bit-exact for single-precision inputs, 0/1.58e8 vs std::fma incl. sub
// variants). frC Force25Bit'd for the multiply (NI_madd_msub<single=true>
// quirk #2/#3 — C3); the NaN ladder still uses ORIGINAL c (C8). NaN ladder
// (gated on isnan(result), MakeQuiet first-NaN a->b->c or PPC_NAN default),
// then ForceSingle; fnmadds/fnmsubs apply the NaN-safe negate AFTER
// ForceSingle (isnan(tmp)?tmp:-tmp, Interpreter_FloatingPoint.cpp:676-677 /
// 722-723). Result Filled into both lanes.
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

    // Stage a, Force25Bit(c) (for the multiply), original c (for the NaN
    // ladder), b. single=true adds the NI_madd_msub tie-correction.
    emit_fma_stage(wb, fa_pair.ps0_idx, fc_pair.ps0_idx, fb_pair.ps0_idx,
                   /*force25_c=*/true);            // [C3] Force25Bit(frC)
    emit_fma_core(wb, subtract, /*single=*/true);  // [C2] fused + tie-correct
    emit_nan_fixup_fma(wb);          // [C8] NaN ladder -> f64 on stack

    // ForceSingle -> i64 (widened single), optional NaN-safe negate, Fill both.
    emit_force_single_i64(wb, ctx_ptr);   // i64 on stack
    if (negate) {
        wb.op_f64_reinterpret_i64();
        emit_nan_safe_neg(wb);            // [C8b] isnan(tmp)?tmp:-tmp (f64->f64)
        wb.op_i64_reinterpret_f64();
    }
    wb.op_local_set(fd_pair.ps0_idx);
    wb.op_local_get(fd_pair.ps0_idx);
    wb.op_local_set(fd_pair.ps1_idx);
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

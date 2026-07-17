// jit_paired.cpp — opcode-4 trivial paired-singles ops.
// Bit-exact with Source/Core/Core/PowerPC/Interpreter/Interpreter_Paired.cpp
// (ps_mr/ps_neg/ps_abs/ps_nabs/ps_merge00/01/10/11/ps_sel). Per FP audit
// researcher 2026-06-08: these dominate the MP4 mtx/transform path that
// gcsetjmp/OSSaveContext bring into the throughput-bound steady-state.
//
// Rc=1 path routes to interp (Jit64 FALLBACK_IF(inst.Rc) shape) — Rc updates
// CR1 from FPSCR[FX,FEX,VX,OX] which bementalJIT doesn't yet track at the
// per-op level. MSR.FP gate is silently skipped (same omission as existing
// emit_lfd/stfd/lfsx/stfsx — to be addressed as a class).

#include "jit_paired.h"
#include "bementalJIT/wasm_module_builder.h"
#include "code_op.h"
#include "fpr_reg_cache.h"
#include "jit_fp_helpers.h"   // [oracle-audit 2026-07-12] shared Force25Bit/
                              // ForceSingle/NaN-ladder/FMA helpers
#include "ppc_analyst.h"
#include "ppc_offsets.h"
#include "reg_cache.h"

namespace bemental {
namespace powerpc {

static constexpr u32 WIMPORT_INTERP = 6;

static void emit_rc_fallback(WasmModuleBuilder& wb, RegCache& rc,
                             FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    // PS Rc=1 falls back to interp (CR1 update from FPSCR not modeled);
    // interp may mutate ps[] so the FPR cache flushes pre-call and reloads
    // post-call to stay coherent with PowerPCState.
    // [pc-sync A4 2026-06-28] ps_mr./ps_merge./ps_sel. lack FL_USE_FPU (ppc_tables.cpp)
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

// Cache-local bit-op helper for ps_neg/ps_abs/ps_nabs.
// Reads src lane local, applies the SIGN_BIT mask, writes dst lane local.
enum class PSBitOp { NEG, ABS, NABS };
static void emit_lane_bit_op(WasmModuleBuilder& wb, u32 src_local,
                             u32 dst_local, PSBitOp kind) {
    static constexpr s64 SIGN_BIT = (s64)0x8000000000000000ull;
    static constexpr s64 NOT_SIGN = (s64)0x7FFFFFFFFFFFFFFFull;
    wb.op_local_get(src_local);
    switch (kind) {
    case PSBitOp::NEG:  wb.op_i64_const(SIGN_BIT); wb.op_i64_xor(); break;
    case PSBitOp::ABS:  wb.op_i64_const(NOT_SIGN); wb.op_i64_and(); break;
    case PSBitOp::NABS: wb.op_i64_const(SIGN_BIT); wb.op_i64_or();  break;
    }
    wb.op_local_set(dst_local);
}

// ps_mr fD, fB — fD <- fB (both halves). Pure i64 cache-local copy.
void emit_ps_mr(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    if (GekkoOperands::Rc(inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 d = GekkoOperands::FD(inst);
    const u32 b = GekkoOperands::FB(inst);
    if (d == b) return;
    auto b_pair = frc.Bind(b, FPRMode::Read,  FPR_LANE_BOTH);
    auto d_pair = frc.Bind(d, FPRMode::Write, FPR_LANE_BOTH);
    wb.op_local_get(b_pair.ps0_idx);
    wb.op_local_set(d_pair.ps0_idx);
    wb.op_local_get(b_pair.ps1_idx);
    wb.op_local_set(d_pair.ps1_idx);
}

// [simd-paired Phase 2] neg/abs/nabs on a Single-form input: f32x4 sign-bit ops
// (bit 31) are exact bitwise ops that preserve NaN payload — same as the f64
// PSBitOp path (bit 63) but on the f32-packed lanes. NABS = abs then neg.
void emit_ps_neg(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    if (GekkoOperands::Rc(inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 d = GekkoOperands::FD(inst);
    const u32 b = GekkoOperands::FB(inst);
    if (frc.IsSingle(b)) {
        auto bv = frc.BindSingleRead(b); auto dv = frc.BindSingleWrite(d);
        wb.op_local_get(bv.v128_idx); wb.op_f32x4_neg(); wb.op_local_set(dv.v128_idx);
        return;
    }
    auto b_pair = frc.Bind(b, FPRMode::Read,  FPR_LANE_BOTH);
    auto d_pair = frc.Bind(d, FPRMode::Write, FPR_LANE_BOTH);
    emit_lane_bit_op(wb, b_pair.ps0_idx, d_pair.ps0_idx, PSBitOp::NEG);
    emit_lane_bit_op(wb, b_pair.ps1_idx, d_pair.ps1_idx, PSBitOp::NEG);
}

void emit_ps_abs(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    if (GekkoOperands::Rc(inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 d = GekkoOperands::FD(inst);
    const u32 b = GekkoOperands::FB(inst);
    if (frc.IsSingle(b)) {
        auto bv = frc.BindSingleRead(b); auto dv = frc.BindSingleWrite(d);
        wb.op_local_get(bv.v128_idx); wb.op_f32x4_abs(); wb.op_local_set(dv.v128_idx);
        return;
    }
    auto b_pair = frc.Bind(b, FPRMode::Read,  FPR_LANE_BOTH);
    auto d_pair = frc.Bind(d, FPRMode::Write, FPR_LANE_BOTH);
    emit_lane_bit_op(wb, b_pair.ps0_idx, d_pair.ps0_idx, PSBitOp::ABS);
    emit_lane_bit_op(wb, b_pair.ps1_idx, d_pair.ps1_idx, PSBitOp::ABS);
}

void emit_ps_nabs(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    if (GekkoOperands::Rc(inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 d = GekkoOperands::FD(inst);
    const u32 b = GekkoOperands::FB(inst);
    if (frc.IsSingle(b)) {
        auto bv = frc.BindSingleRead(b); auto dv = frc.BindSingleWrite(d);
        wb.op_local_get(bv.v128_idx); wb.op_f32x4_abs(); wb.op_f32x4_neg(); wb.op_local_set(dv.v128_idx);
        return;
    }
    auto b_pair = frc.Bind(b, FPRMode::Read,  FPR_LANE_BOTH);
    auto d_pair = frc.Bind(d, FPRMode::Write, FPR_LANE_BOTH);
    emit_lane_bit_op(wb, b_pair.ps0_idx, d_pair.ps0_idx, PSBitOp::NABS);
    emit_lane_bit_op(wb, b_pair.ps1_idx, d_pair.ps1_idx, PSBitOp::NABS);
}

// ps_merge00 fD, fA, fB — fD.ps0 <- fA.ps0; fD.ps1 <- fB.ps0.
// Write order: d.ps1 from b.ps0 FIRST, then d.ps0 from a.ps0. When d==b,
// writing d.ps0 = a.ps0 corrupts the shared local that also holds b.ps0;
// reading b.ps0 after that point sees a.ps0 instead of the original.
// Jit64 Jit_Paired.cpp:117 uses VUNPCKLPD which is atomic; we emit two
// sequential local copies so order matters. d==a aliasing is safe either
// way (different lane).
void emit_ps_merge00(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    if (GekkoOperands::Rc(inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 d = GekkoOperands::FD(inst);
    const u32 a = GekkoOperands::FA(inst);
    const u32 b = GekkoOperands::FB(inst);
    // [simd-paired] both inputs single -> lane shuffle (d.lane0=a.lane0, d.lane1=b.lane0),
    // keeps the Single chain alive for downstream ps ops. Shuffle is read-before-write
    // atomic, so d==a/d==b/a==b aliasing is automatically safe. lanes 2-3 = don't care.
    if (frc.IsSingle(a) && frc.IsSingle(b)) {
        auto av = frc.BindSingleRead(a); auto bv = frc.BindSingleRead(b);
        auto dv = frc.BindSingleWrite(d);
        static const u8 sh[16] = {0,1,2,3, 16,17,18,19, 0,0,0,0, 0,0,0,0};
        wb.op_local_get(av.v128_idx); wb.op_local_get(bv.v128_idx);
        wb.op_i8x16_shuffle(sh); wb.op_local_set(dv.v128_idx);
        return;
    }
    auto a_pair = frc.Bind(a, FPRMode::Read,  FPR_LANE_PS0);
    auto b_pair = frc.Bind(b, FPRMode::Read,  FPR_LANE_PS0);
    auto d_pair = frc.Bind(d, FPRMode::Write, FPR_LANE_BOTH);
    // d.ps1 = b.ps0  (consume b before d.ps0 write that aliases when d==b)
    wb.op_local_get(b_pair.ps0_idx);
    wb.op_local_set(d_pair.ps1_idx);
    // d.ps0 = a.ps0
    wb.op_local_get(a_pair.ps0_idx);
    wb.op_local_set(d_pair.ps0_idx);
}

// ps_merge01 fD, fA, fB — fD.ps0 <- fA.ps0; fD.ps1 <- fB.ps1.
void emit_ps_merge01(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    if (GekkoOperands::Rc(inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 d = GekkoOperands::FD(inst);
    const u32 a = GekkoOperands::FA(inst);
    const u32 b = GekkoOperands::FB(inst);
    // [simd-paired] d.lane0=a.lane0, d.lane1=b.lane1
    if (frc.IsSingle(a) && frc.IsSingle(b)) {
        auto av = frc.BindSingleRead(a); auto bv = frc.BindSingleRead(b);
        auto dv = frc.BindSingleWrite(d);
        static const u8 sh[16] = {0,1,2,3, 20,21,22,23, 0,0,0,0, 0,0,0,0};
        wb.op_local_get(av.v128_idx); wb.op_local_get(bv.v128_idx);
        wb.op_i8x16_shuffle(sh); wb.op_local_set(dv.v128_idx);
        return;
    }
    auto a_pair = frc.Bind(a, FPRMode::Read,  FPR_LANE_PS0);
    auto b_pair = frc.Bind(b, FPRMode::Read,  FPR_LANE_PS1);
    auto d_pair = frc.Bind(d, FPRMode::Write, FPR_LANE_BOTH);
    wb.op_local_get(a_pair.ps0_idx);
    wb.op_local_set(d_pair.ps0_idx);
    wb.op_local_get(b_pair.ps1_idx);
    wb.op_local_set(d_pair.ps1_idx);
}

// ps_merge10 fD, fA, fB — fD.ps0 <- fA.ps1; fD.ps1 <- fB.ps0.
// 2026-06-13 ALIAS FIX: this op has TWO distinct aliasing collisions —
// d.ps1 shares a local with a.ps1 when d==a, and d.ps0 shares with b.ps0
// when d==b — needing OPPOSITE write orders. The prior "write d.ps1 first"
// handled d==b but BROKE d==a: it clobbered a.ps1 before d.ps0 read it, so
// `ps_merge10 fX,fX,fY` (e.g. PSMTXIdentity 0x803763d4 building matrix[2][2]
// = 1.0) collapsed fX.ps0 to 0 -> zeroed matrix Z-row -> all 3D geometry
// clipped. Fix: read BOTH sources onto the wasm stack before writing either
// lane, so no write can clobber a not-yet-read source (covers d==a, d==b,
// a==b). Stack order: a.ps1 pushed first (deeper), b.ps0 on top.
void emit_ps_merge10(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    if (GekkoOperands::Rc(inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 d = GekkoOperands::FD(inst);
    const u32 a = GekkoOperands::FA(inst);
    const u32 b = GekkoOperands::FB(inst);
    // [simd-paired] d.lane0=a.lane1, d.lane1=b.lane0
    if (frc.IsSingle(a) && frc.IsSingle(b)) {
        auto av = frc.BindSingleRead(a); auto bv = frc.BindSingleRead(b);
        auto dv = frc.BindSingleWrite(d);
        static const u8 sh[16] = {4,5,6,7, 16,17,18,19, 0,0,0,0, 0,0,0,0};
        wb.op_local_get(av.v128_idx); wb.op_local_get(bv.v128_idx);
        wb.op_i8x16_shuffle(sh); wb.op_local_set(dv.v128_idx);
        return;
    }
    auto a_pair = frc.Bind(a, FPRMode::Read,  FPR_LANE_PS1);
    auto b_pair = frc.Bind(b, FPRMode::Read,  FPR_LANE_PS0);
    auto d_pair = frc.Bind(d, FPRMode::Write, FPR_LANE_BOTH);
    wb.op_local_get(a_pair.ps1_idx);   // [a.ps1]
    wb.op_local_get(b_pair.ps0_idx);   // [a.ps1, b.ps0]
    wb.op_local_set(d_pair.ps1_idx);   // d.ps1 = b.ps0  (pops top)
    wb.op_local_set(d_pair.ps0_idx);   // d.ps0 = a.ps1  (pops next)
}

// ps_merge11 fD, fA, fB — fD.ps0 <- fA.ps1; fD.ps1 <- fB.ps1.
void emit_ps_merge11(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    if (GekkoOperands::Rc(inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 d = GekkoOperands::FD(inst);
    const u32 a = GekkoOperands::FA(inst);
    const u32 b = GekkoOperands::FB(inst);
    // [simd-paired] d.lane0=a.lane1, d.lane1=b.lane1
    if (frc.IsSingle(a) && frc.IsSingle(b)) {
        auto av = frc.BindSingleRead(a); auto bv = frc.BindSingleRead(b);
        auto dv = frc.BindSingleWrite(d);
        static const u8 sh[16] = {4,5,6,7, 20,21,22,23, 0,0,0,0, 0,0,0,0};
        wb.op_local_get(av.v128_idx); wb.op_local_get(bv.v128_idx);
        wb.op_i8x16_shuffle(sh); wb.op_local_set(dv.v128_idx);
        return;
    }
    auto a_pair = frc.Bind(a, FPRMode::Read,  FPR_LANE_PS1);
    auto b_pair = frc.Bind(b, FPRMode::Read,  FPR_LANE_PS1);
    auto d_pair = frc.Bind(d, FPRMode::Write, FPR_LANE_BOTH);
    wb.op_local_get(a_pair.ps1_idx);
    wb.op_local_set(d_pair.ps0_idx);
    wb.op_local_get(b_pair.ps1_idx);
    wb.op_local_set(d_pair.ps1_idx);
}

// ps_sel fD, fA, fB, fC — fD.psN = (a.psN >= -0.0) ? c.psN : b.psN.
// IEEE: +0.0 >= -0.0 and -0.0 >= -0.0 are both true; NaN >= -0.0 is false.
//
// Cache-local form: bind a/b/c (Read, both lanes); the d-local indices
// come from a separate index lookup so we can defer the Bind(Write) until
// AFTER the if/else chain — that way the Bind's dirty mark happens at the
// point Flush at block exit / boundary correctly snapshots the final
// chosen value. Both arms write the SAME d local, so the post-merge local
// is the final value regardless of which arm ran.
//
// Raw op_if/op_else/op_end is correct here because there's no cross-arm
// cache divergence to worry about: a/b/c bindings are Read-only (no
// dirty state to flush), and the d-local writes converge on one local.
void emit_ps_sel(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    static constexpr u32 BLOCK_TYPE_VOID = 0x40;
    const u32 inst = op.inst;
    if (GekkoOperands::Rc(inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 d = GekkoOperands::FD(inst);
    const u32 a = GekkoOperands::FA(inst);
    const u32 b = GekkoOperands::FB(inst);
    const u32 c = GekkoOperands::FC(inst);

    auto a_pair = frc.Bind(a, FPRMode::Read, FPR_LANE_BOTH);
    auto b_pair = frc.Bind(b, FPRMode::Read, FPR_LANE_BOTH);
    auto c_pair = frc.Bind(c, FPRMode::Read, FPR_LANE_BOTH);
    // Bind d for Write — sets the local indices we'll write to. Pure Write
    // doesn't load (no lazy-load), and the dirty mark is what we want so
    // block-exit Flush emits the i64.store of the final local value.
    auto d_pair = frc.Bind(d, FPRMode::Write, FPR_LANE_BOTH);

    auto half = [&](u32 a_local, u32 b_local, u32 c_local, u32 d_local) {
        wb.op_local_get(a_local);
        wb.op_f64_reinterpret_i64();
        wb.op_f64_const(-0.0);
        wb.op_f64_ge();
        wb.op_if(BLOCK_TYPE_VOID);
            wb.op_local_get(c_local);
            wb.op_local_set(d_local);
        wb.op_else();
            wb.op_local_get(b_local);
            wb.op_local_set(d_local);
        wb.op_end();
    };
    half(a_pair.ps0_idx, b_pair.ps0_idx, c_pair.ps0_idx, d_pair.ps0_idx);
    half(a_pair.ps1_idx, b_pair.ps1_idx, c_pair.ps1_idx, d_pair.ps1_idx);
}

// ---------------------------------------------------------------------------
// Arithmetic paired-singles ops (ps_add/sub/mul/div, ps_madd family,
// ps_sum0/1, ps_muls0/1, ps_madds0/1).
//
// [C2+C3+C8+C10+C12b 2026-07-12 oracle-audit] Each lane now mirrors the
// Interpreter_Paired.cpp reference exactly: the 2-op NaN ladder (NI_add/sub/
// mul/div) or the fused std::fma NaN ladder (NI_madd_msub<single>), Force25Bit
// on frC for the mul/madd family (C3), and ForceSingle (NI-aware subnormal
// flush, C10) per lane instead of the old bare f32_demote/f64_promote.
// UpdateFPRFSingle (C12b) updates FPSCR.FPRF from ps0 (ps1 for ps_sum1).
// ---------------------------------------------------------------------------

// [simd-paired C10] NI (FTZ) subnormal flush on a v128 f32x2 (lanes 0-1), gated
// at RUNTIME on FPSCR.NI. Mirrors emit_force_single_i64's post-cast stage-3:
// if NI and the single result is subnormal (|bits| < 0x00800000), flush to
// signed zero. Inert (if-skipped) when NI=0 — the common IDCT/movie case, so
// the fast path stays a straight f32x4 op.
static void emit_v128_ni_flush(WasmModuleBuilder& wb, u32 v128_local, u32 ctx_ptr) {
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load(ppc_off::FPSCR);
    wb.op_i32_const(4);
    wb.op_i32_and();
    wb.op_if();
    for (u8 lane = 0; lane < 2; ++lane) {
        wb.op_local_get(v128_local);
        wb.op_i32x4_extract_lane(lane);
        wb.op_local_set(LOCAL_FP_T1);            // T1 = f32 bits
        wb.op_local_get(v128_local);             // v128 for replace_lane
        wb.op_local_get(LOCAL_FP_T1);
        wb.op_i32_const((s32)0x80000000);
        wb.op_i32_and();                         // signed-zero candidate
        wb.op_local_get(LOCAL_FP_T1);            // keep candidate
        wb.op_local_get(LOCAL_FP_T1);
        wb.op_i32_const(0x7FFFFFFF);
        wb.op_i32_and();
        wb.op_i32_const(0x00800000);
        wb.op_i32_lt_u();                        // subnormal?
        wb.op_select();                          // -> flushed or kept
        wb.op_i32x4_replace_lane(lane);
        wb.op_local_set(v128_local);
    }
    wb.op_end();
}

// [simd-paired] FPRF from a v128 single lane 0: extract f32, NaN-safe widen to
// f64 (into scratch i64 101), then the existing single-FPRF classifier.
static void emit_fprf_single_from_v128(WasmModuleBuilder& wb, u32 v128_local, u32 ctx_ptr,
                                       bool needed = true) {
    if (!needed) return;  // [dead-fprf] analyzer proved FPRF dead downstream
    wb.op_local_get(v128_local);
    wb.op_f32x4_extract_lane(0);
    wb.op_i32_reinterpret_f32();
    wb.op_local_set(LOCAL_FP_T0);                 // 98 = LOCAL_PSQ_T0
    emit_psq_convert_to_double(wb);               // -> i64 f64-bits
    wb.op_local_set(LOCAL_FP_I64_A);              // 101
    emit_update_fprf_single(wb, LOCAL_FP_I64_A, ctx_ptr);
}

void emit_ps_binary(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 fd   = GekkoOperands::FD(inst);
    const u32 fa   = GekkoOperands::FA(inst);
    const u32 fb   = GekkoOperands::FB(inst);
    const u32 fc   = GekkoOperands::FC(inst);
    const u32 sub5 = GekkoOperands::SUBOP5(inst);

    // ps_mul (sub5=25) uses FC as second operand; others use FB.
    const u32 arg2 = (sub5 == 25) ? fc : fb;
    const bool is_mul = (sub5 == 25);

    // [simd-paired Phase 1] Fast path: when both inputs are already single-form,
    // the whole op is one f32x4 SIMD instruction (matches JitArm64's size=32
    // singles path). Bit-exact for add/sub/mul/div with single inputs: an
    // f32 op == ForceSingle(f64 op) for <=24-bit operands. Force25Bit on frC is
    // a no-op here (input is already single). NI subnormal-flush reproduced.
    if (frc.IsSingle(fa) && frc.IsSingle(arg2)) {
        auto a = frc.BindSingleRead(fa);
        auto b = frc.BindSingleRead(arg2);
        auto d = frc.BindSingleWrite(fd);
        wb.op_local_get(a.v128_idx);
        wb.op_local_get(b.v128_idx);
        switch (sub5) {
        case 18: wb.op_f32x4_div(); break;
        case 20: wb.op_f32x4_sub(); break;
        case 21: wb.op_f32x4_add(); break;
        case 25: wb.op_f32x4_mul(); break;
        default: break;
        }
        wb.op_local_set(d.v128_idx);
        emit_v128_ni_flush(wb, d.v128_idx, ctx_ptr);
        emit_fprf_single_from_v128(wb, d.v128_idx, ctx_ptr, !op.fprf_discardable);
        return;
    }

    auto fa_pair   = frc.Bind(fa,   FPRMode::Read,  FPR_LANE_BOTH);
    auto arg2_pair = frc.Bind(arg2, FPRMode::Read,  FPR_LANE_BOTH);
    auto fd_pair   = frc.Bind(fd,   FPRMode::Write, FPR_LANE_BOTH);

    // Per-lane: stash a,b in the NaN-ladder locals, run the raw f64 op, NaN
    // ladder, ForceSingle -> i64 into d local. For ps_mul, b is Force25Bit'd
    // (C3) — the NaN ladder then sees the SAME (rounded) b the multiply used,
    // which matches NI_mul(a, Force25Bit(c)).
    auto lane = [&](u32 a_local, u32 b_local, u32 d_local) {
        wb.op_local_get(a_local);
        wb.op_f64_reinterpret_i64();
        wb.op_local_set(LOCAL_FMA_A);
        wb.op_local_get(b_local);
        if (is_mul) emit_force25bit(wb);   // [C3] Force25Bit(frC) for ps_mul
        wb.op_f64_reinterpret_i64();
        wb.op_local_set(LOCAL_FMA_B);
        wb.op_local_get(LOCAL_FMA_A);
        wb.op_local_get(LOCAL_FMA_B);
        switch (sub5) {
        case 18: wb.op_f64_div(); break;  // ps_div
        case 20: wb.op_f64_sub(); break;  // ps_sub
        case 21: wb.op_f64_add(); break;  // ps_add
        case 25: wb.op_f64_mul(); break;  // ps_mul
        default: break;
        }
        emit_nan_fixup_2op(wb);            // [C8] NaN ladder
        emit_force_single_i64(wb, ctx_ptr); // [C10] ForceSingle -> i64
        wb.op_local_set(d_local);
    };
    lane(fa_pair.ps0_idx, arg2_pair.ps0_idx, fd_pair.ps0_idx);
    lane(fa_pair.ps1_idx, arg2_pair.ps1_idx, fd_pair.ps1_idx);
    emit_update_fprf_single(wb, fd_pair.ps0_idx, ctx_ptr, !op.fprf_discardable);  // [C12b] FPRF from ps0
}

// ps_madd/msub/nmadd/nmsub. [C2+C3+C8+C10 2026-07-12 oracle-audit] Each lane
// = ForceSingle(NI_madd_msub<single>(a, c, b)) via emit_single_fma_lane
// (fused std::fma, Force25Bit(c), tie-correction, NaN ladder, ForceSingle),
// with the nmadd/nmsub NaN-safe negate. Replaces the old unfused mul-then-add
// + bare demote/promote.
void emit_ps_fma(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 fd   = GekkoOperands::FD(inst);
    const u32 fa   = GekkoOperands::FA(inst);
    const u32 fb   = GekkoOperands::FB(inst);
    const u32 fc   = GekkoOperands::FC(inst);
    const u32 sub5 = GekkoOperands::SUBOP5(inst);

    const bool subtract = (sub5 == 28) || (sub5 == 30);  // msub / nmsub
    const bool negate   = (sub5 == 30) || (sub5 == 31);  // nmsub / nmadd

    // [simd-paired FMA] All inputs single -> one f32x4.relaxed_madd (fused f32
    // FMA on FMA hardware — exactly JitArm64's singles-path FMLA). Keeps the
    // Single chain alive through the IDCT butterflies. Diverges from the f64
    // interpreter by 1 ulp on ties (the same divergence native itself has).
    // Force25Bit on frC is a no-op in the single domain. madd: a*c+b; msub:
    // a*c-b (negate b addend); nmadd/nmsub negate the whole result.
    if (frc.IsSingle(fa) && frc.IsSingle(fb) && frc.IsSingle(fc)) {
        auto a = frc.BindSingleRead(fa);
        auto b = frc.BindSingleRead(fb);
        auto c = frc.BindSingleRead(fc);
        auto d = frc.BindSingleWrite(fd);
        wb.op_local_get(a.v128_idx);   // x
        wb.op_local_get(c.v128_idx);   // y
        wb.op_local_get(b.v128_idx);   // z (addend)
        if (subtract) wb.op_f32x4_neg();
        wb.op_f32x4_relaxed_madd();    // x*y + z = a*c +/- b
        if (negate) wb.op_f32x4_neg();
        wb.op_local_set(d.v128_idx);
        emit_v128_ni_flush(wb, d.v128_idx, ctx_ptr);
        emit_fprf_single_from_v128(wb, d.v128_idx, ctx_ptr, !op.fprf_discardable);
        return;
    }

    auto fa_pair = frc.Bind(fa, FPRMode::Read,  FPR_LANE_BOTH);
    auto fb_pair = frc.Bind(fb, FPRMode::Read,  FPR_LANE_BOTH);
    auto fc_pair = frc.Bind(fc, FPRMode::Read,  FPR_LANE_BOTH);
    auto fd_pair = frc.Bind(fd, FPRMode::Write, FPR_LANE_BOTH);

    emit_single_fma_lane(wb, fa_pair.ps0_idx, fc_pair.ps0_idx, fb_pair.ps0_idx,
                         fd_pair.ps0_idx, subtract, negate, ctx_ptr);
    emit_single_fma_lane(wb, fa_pair.ps1_idx, fc_pair.ps1_idx, fb_pair.ps1_idx,
                         fd_pair.ps1_idx, subtract, negate, ctx_ptr);
    emit_update_fprf_single(wb, fd_pair.ps0_idx, ctx_ptr, !op.fprf_discardable);  // [C12b] FPRF from ps0
}

void emit_ps_sum(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 fd   = GekkoOperands::FD(inst);
    const u32 fa   = GekkoOperands::FA(inst);
    const u32 fb   = GekkoOperands::FB(inst);
    const u32 fc   = GekkoOperands::FC(inst);
    const u32 sub5 = GekkoOperands::SUBOP5(inst);

    // ps_sum0/1 reads only fa.ps0 + fb.ps1, and copies one fc lane.
    // [C8+C10+C12b 2026-07-12 oracle-audit] sum lane = ForceSingle(NI_add(
    // a.ps0, b.ps1)) (NaN ladder); copy lane = ForceSingle(c.psN) (bare —
    // a value pass-through, no NaN ladder per the oracle). FPRF from ps0
    // (ps_sum0) or ps1 (ps_sum1, Interpreter_Paired.cpp:378).
    auto fa_pair = frc.Bind(fa, FPRMode::Read,  FPR_LANE_PS0);
    auto fb_pair = frc.Bind(fb, FPRMode::Read,  FPR_LANE_PS1);
    auto fc_pair = frc.Bind(fc, FPRMode::Read,  FPR_LANE_BOTH);
    auto fd_pair = frc.Bind(fd, FPRMode::Write, FPR_LANE_BOTH);

    auto emit_sum = [&](u32 d_local) {
        wb.op_local_get(fa_pair.ps0_idx);
        wb.op_f64_reinterpret_i64();
        wb.op_local_set(LOCAL_FMA_A);
        wb.op_local_get(fb_pair.ps1_idx);
        wb.op_f64_reinterpret_i64();
        wb.op_local_set(LOCAL_FMA_B);
        wb.op_local_get(LOCAL_FMA_A);
        wb.op_local_get(LOCAL_FMA_B);
        wb.op_f64_add();
        emit_nan_fixup_2op(wb);            // [C8] NaN ladder
        emit_force_single_i64(wb, ctx_ptr); // [C10] ForceSingle
        wb.op_local_set(d_local);
    };
    auto emit_copy_c = [&](u32 c_local, u32 d_local) {
        wb.op_local_get(c_local);
        wb.op_f64_reinterpret_i64();
        emit_force_single_i64(wb, ctx_ptr); // [C10] ForceSingle(c)
        wb.op_local_set(d_local);
    };
    if (sub5 == 10) {  // ps_sum0
        emit_sum(fd_pair.ps0_idx);
        emit_copy_c(fc_pair.ps1_idx, fd_pair.ps1_idx);
        emit_update_fprf_single(wb, fd_pair.ps0_idx, ctx_ptr, !op.fprf_discardable);  // [C12b] ps0
    } else {  // ps_sum1 (sub5 == 11)
        emit_copy_c(fc_pair.ps0_idx, fd_pair.ps0_idx);
        emit_sum(fd_pair.ps1_idx);
        emit_update_fprf_single(wb, fd_pair.ps1_idx, ctx_ptr, !op.fprf_discardable);  // [C12b] ps1
    }
}

// ps_muls0/1. [C3+C8+C10+C12b 2026-07-12 oracle-audit] c0 = Force25Bit(c.psN)
// (once, shared by both lanes); each lane = ForceSingle(NI_mul(a.psN, c0))
// (NaN ladder). Replaces bare demote/promote.
void emit_ps_muls(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 fd   = GekkoOperands::FD(inst);
    const u32 fa   = GekkoOperands::FA(inst);
    const u32 fc   = GekkoOperands::FC(inst);
    const u32 sub5 = GekkoOperands::SUBOP5(inst);
    const u8  c_lane = (sub5 == 12) ? FPR_LANE_PS0 : FPR_LANE_PS1;

    auto fa_pair = frc.Bind(fa, FPRMode::Read,  FPR_LANE_BOTH);
    auto fc_pair = frc.Bind(fc, FPRMode::Read,  c_lane);
    auto fd_pair = frc.Bind(fd, FPRMode::Write, FPR_LANE_BOTH);
    const u32 c_local = (c_lane == FPR_LANE_PS0) ? fc_pair.ps0_idx : fc_pair.ps1_idx;

    // c0 = Force25Bit(c) -> LOCAL_FMA_C0 (f64), computed once. [C3]
    wb.op_local_get(c_local);
    emit_force25bit(wb);
    wb.op_f64_reinterpret_i64();
    wb.op_local_set(LOCAL_FMA_C0);

    auto lane = [&](u32 a_local, u32 d_local) {
        wb.op_local_get(a_local);
        wb.op_f64_reinterpret_i64();
        wb.op_local_set(LOCAL_FMA_A);
        wb.op_local_get(LOCAL_FMA_C0);        // Force25Bit'd c (== NI_mul's c)
        wb.op_local_set(LOCAL_FMA_B);
        wb.op_local_get(LOCAL_FMA_A);
        wb.op_local_get(LOCAL_FMA_B);
        wb.op_f64_mul();
        emit_nan_fixup_2op(wb);               // [C8] NaN ladder
        emit_force_single_i64(wb, ctx_ptr);   // [C10] ForceSingle
        wb.op_local_set(d_local);
    };
    lane(fa_pair.ps0_idx, fd_pair.ps0_idx);
    lane(fa_pair.ps1_idx, fd_pair.ps1_idx);
    emit_update_fprf_single(wb, fd_pair.ps0_idx, ctx_ptr, !op.fprf_discardable);  // [C12b] ps0
}

// ps_madds0/1. [C2+C3+C8+C10+C12b 2026-07-12 oracle-audit] Each lane =
// ForceSingle(NI_madd<single>(a.psN, c.psM, b.psN)) via emit_single_fma_lane
// (c from ONE lane — ps0 for madds0, ps1 for madds1 — shared by both output
// lanes; fused std::fma + Force25Bit(c) + tie-correction + NaN ladder +
// ForceSingle). No negate/subtract (madds is always a+ multiply-ADD).
void emit_ps_madds(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 fd   = GekkoOperands::FD(inst);
    const u32 fa   = GekkoOperands::FA(inst);
    const u32 fb   = GekkoOperands::FB(inst);
    const u32 fc   = GekkoOperands::FC(inst);
    const u32 sub5 = GekkoOperands::SUBOP5(inst);
    const u8  c_lane = (sub5 == 14) ? FPR_LANE_PS0 : FPR_LANE_PS1;

    auto fa_pair = frc.Bind(fa, FPRMode::Read,  FPR_LANE_BOTH);
    auto fb_pair = frc.Bind(fb, FPRMode::Read,  FPR_LANE_BOTH);
    auto fc_pair = frc.Bind(fc, FPRMode::Read,  c_lane);
    auto fd_pair = frc.Bind(fd, FPRMode::Write, FPR_LANE_BOTH);
    const u32 c_local = (c_lane == FPR_LANE_PS0) ? fc_pair.ps0_idx : fc_pair.ps1_idx;

    emit_single_fma_lane(wb, fa_pair.ps0_idx, c_local, fb_pair.ps0_idx,
                         fd_pair.ps0_idx, /*sub=*/false, /*negate=*/false, ctx_ptr);
    emit_single_fma_lane(wb, fa_pair.ps1_idx, c_local, fb_pair.ps1_idx,
                         fd_pair.ps1_idx, /*sub=*/false, /*negate=*/false, ctx_ptr);
    emit_update_fprf_single(wb, fd_pair.ps0_idx, ctx_ptr, !op.fprf_discardable);  // [C12b] ps0
}

}  // namespace powerpc
}  // namespace bemental

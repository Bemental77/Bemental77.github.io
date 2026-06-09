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

void emit_ps_neg(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    if (GekkoOperands::Rc(inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 d = GekkoOperands::FD(inst);
    const u32 b = GekkoOperands::FB(inst);
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
    auto b_pair = frc.Bind(b, FPRMode::Read,  FPR_LANE_BOTH);
    auto d_pair = frc.Bind(d, FPRMode::Write, FPR_LANE_BOTH);
    emit_lane_bit_op(wb, b_pair.ps0_idx, d_pair.ps0_idx, PSBitOp::NABS);
    emit_lane_bit_op(wb, b_pair.ps1_idx, d_pair.ps1_idx, PSBitOp::NABS);
}

// ps_merge00 fD, fA, fB — fD.ps0 <- fA.ps0; fD.ps1 <- fB.ps0.
void emit_ps_merge00(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    if (GekkoOperands::Rc(inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 d = GekkoOperands::FD(inst);
    const u32 a = GekkoOperands::FA(inst);
    const u32 b = GekkoOperands::FB(inst);
    auto a_pair = frc.Bind(a, FPRMode::Read,  FPR_LANE_PS0);
    auto b_pair = frc.Bind(b, FPRMode::Read,  FPR_LANE_PS0);
    auto d_pair = frc.Bind(d, FPRMode::Write, FPR_LANE_BOTH);
    wb.op_local_get(a_pair.ps0_idx);
    wb.op_local_set(d_pair.ps0_idx);
    wb.op_local_get(b_pair.ps0_idx);
    wb.op_local_set(d_pair.ps1_idx);
}

// ps_merge01 fD, fA, fB — fD.ps0 <- fA.ps0; fD.ps1 <- fB.ps1.
void emit_ps_merge01(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    if (GekkoOperands::Rc(inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 d = GekkoOperands::FD(inst);
    const u32 a = GekkoOperands::FA(inst);
    const u32 b = GekkoOperands::FB(inst);
    auto a_pair = frc.Bind(a, FPRMode::Read,  FPR_LANE_PS0);
    auto b_pair = frc.Bind(b, FPRMode::Read,  FPR_LANE_PS1);
    auto d_pair = frc.Bind(d, FPRMode::Write, FPR_LANE_BOTH);
    wb.op_local_get(a_pair.ps0_idx);
    wb.op_local_set(d_pair.ps0_idx);
    wb.op_local_get(b_pair.ps1_idx);
    wb.op_local_set(d_pair.ps1_idx);
}

// ps_merge10 fD, fA, fB — fD.ps0 <- fA.ps1; fD.ps1 <- fB.ps0.
void emit_ps_merge10(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    if (GekkoOperands::Rc(inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 d = GekkoOperands::FD(inst);
    const u32 a = GekkoOperands::FA(inst);
    const u32 b = GekkoOperands::FB(inst);
    auto a_pair = frc.Bind(a, FPRMode::Read,  FPR_LANE_PS1);
    auto b_pair = frc.Bind(b, FPRMode::Read,  FPR_LANE_PS0);
    auto d_pair = frc.Bind(d, FPRMode::Write, FPR_LANE_BOTH);
    wb.op_local_get(a_pair.ps1_idx);
    wb.op_local_set(d_pair.ps0_idx);
    wb.op_local_get(b_pair.ps0_idx);
    wb.op_local_set(d_pair.ps1_idx);
}

// ps_merge11 fD, fA, fB — fD.ps0 <- fA.ps1; fD.ps1 <- fB.ps1.
void emit_ps_merge11(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    if (GekkoOperands::Rc(inst)) { emit_rc_fallback(wb, rc, frc, op, ctx_ptr); return; }
    const u32 d = GekkoOperands::FD(inst);
    const u32 a = GekkoOperands::FA(inst);
    const u32 b = GekkoOperands::FB(inst);
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
// Common shape: for each of PS0/PS1 lanes, load operand(s) as f64, run scalar
// f64 op, demote-then-promote to round to single precision (matches
// Jit64 non-accurate-NaN fast path; PEM NaN payload + FPSCR exception bits
// NOT modeled — same omission as scalar emit_lfd/lfs etc.).
// ---------------------------------------------------------------------------

void emit_ps_binary(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 fd   = GekkoOperands::FD(inst);
    const u32 fa   = GekkoOperands::FA(inst);
    const u32 fb   = GekkoOperands::FB(inst);
    const u32 fc   = GekkoOperands::FC(inst);
    const u32 sub5 = GekkoOperands::SUBOP5(inst);

    // ps_mul (sub5=25) uses FC as second operand; others use FB.
    const u32 arg2 = (sub5 == 25) ? fc : fb;

    rc.Flush(ctx_ptr);
    // Step-4 plumbing: emit body writes ps0/ps1 to PowerPCState memory
    // directly (cache not used yet). Flush dirty FPR-cache lanes before
    // the memory read so the lane lambda sees current values; reload
    // after so subsequent ops see post-write state. Steps 6-7 convert
    // these emits to cache locals and drop both calls.
    frc.Flush(ctx_ptr);

    auto lane = [&](u32 a_off, u32 b_off, u32 d_off) {
        wb.op_i32_const((s32)ctx_ptr);          // store-addr
        wb.op_i32_const((s32)ctx_ptr);          // load-addr base for a
        wb.op_f64_load(a_off);
        wb.op_i32_const((s32)ctx_ptr);          // load-addr base for arg2
        wb.op_f64_load(b_off);
        switch (sub5) {
        case 18: wb.op_f64_div(); break;  // ps_div
        case 20: wb.op_f64_sub(); break;  // ps_sub
        case 21: wb.op_f64_add(); break;  // ps_add
        case 25: wb.op_f64_mul(); break;  // ps_mul
        default: break;
        }
        wb.op_f32_demote_f64();
        wb.op_f64_promote_f32();
        wb.op_f64_store(d_off);
    };
    lane(ppc_off::ps0(fa), ppc_off::ps0(arg2), ppc_off::ps0(fd));
    lane(ppc_off::ps1(fa), ppc_off::ps1(arg2), ppc_off::ps1(fd));
    // Step-4: emit wrote ps0(fd)/ps1(fd) to memory; reload the cache so
    // subsequent ops see the new values (mirror of the rc.ReloadAll
    // pattern after a memory-direct write of GPR memory).
    frc.ReloadAll(ctx_ptr);
}

void emit_ps_fma(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 fd   = GekkoOperands::FD(inst);
    const u32 fa   = GekkoOperands::FA(inst);
    const u32 fb   = GekkoOperands::FB(inst);
    const u32 fc   = GekkoOperands::FC(inst);
    const u32 sub5 = GekkoOperands::SUBOP5(inst);

    const bool subtract = (sub5 == 28) || (sub5 == 30);  // msub / nmsub
    const bool negate   = (sub5 == 30) || (sub5 == 31);  // nmsub / nmadd

    rc.Flush(ctx_ptr);
    // Step-4 plumbing: emit body writes ps0/ps1 to PowerPCState memory
    // directly (cache not used yet). Flush dirty FPR-cache lanes before
    // the memory read so the lane lambda sees current values; reload
    // after so subsequent ops see post-write state. Steps 6-7 convert
    // these emits to cache locals and drop both calls.
    frc.Flush(ctx_ptr);

    auto lane = [&](u32 a_off, u32 b_off, u32 c_off, u32 d_off) {
        wb.op_i32_const((s32)ctx_ptr);          // store-addr for d
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_f64_load(a_off);
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_f64_load(c_off);
        wb.op_f64_mul();
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_f64_load(b_off);
        if (subtract) wb.op_f64_sub();
        else          wb.op_f64_add();
        if (negate)   wb.op_f64_neg();
        wb.op_f32_demote_f64();
        wb.op_f64_promote_f32();
        wb.op_f64_store(d_off);
    };
    lane(ppc_off::ps0(fa), ppc_off::ps0(fb), ppc_off::ps0(fc), ppc_off::ps0(fd));
    lane(ppc_off::ps1(fa), ppc_off::ps1(fb), ppc_off::ps1(fc), ppc_off::ps1(fd));
    frc.ReloadAll(ctx_ptr);
}

void emit_ps_sum(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 fd   = GekkoOperands::FD(inst);
    const u32 fa   = GekkoOperands::FA(inst);
    const u32 fb   = GekkoOperands::FB(inst);
    const u32 fc   = GekkoOperands::FC(inst);
    const u32 sub5 = GekkoOperands::SUBOP5(inst);

    rc.Flush(ctx_ptr);

    // Shared sum: single(a.ps0 + b.ps1). Lands in ps0 for sum0, ps1 for sum1.
    // Other lane: single(c.<matching half>).
    auto emit_sum = [&](u32 d_off) {
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_f64_load(ppc_off::ps0(fa));
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_f64_load(ppc_off::ps1(fb));
        wb.op_f64_add();
        wb.op_f32_demote_f64();
        wb.op_f64_promote_f32();
        wb.op_f64_store(d_off);
    };
    auto emit_copy_c = [&](u32 c_off, u32 d_off) {
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_f64_load(c_off);
        wb.op_f32_demote_f64();
        wb.op_f64_promote_f32();
        wb.op_f64_store(d_off);
    };
    if (sub5 == 10) {  // ps_sum0
        emit_sum(ppc_off::ps0(fd));
        emit_copy_c(ppc_off::ps1(fc), ppc_off::ps1(fd));
    } else {  // ps_sum1 (sub5 == 11)
        emit_copy_c(ppc_off::ps0(fc), ppc_off::ps0(fd));
        emit_sum(ppc_off::ps1(fd));
    }
    frc.ReloadAll(ctx_ptr);
}

void emit_ps_muls(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 fd   = GekkoOperands::FD(inst);
    const u32 fa   = GekkoOperands::FA(inst);
    const u32 fc   = GekkoOperands::FC(inst);
    const u32 sub5 = GekkoOperands::SUBOP5(inst);
    const u32 c_off = (sub5 == 12) ? ppc_off::ps0(fc) : ppc_off::ps1(fc);

    rc.Flush(ctx_ptr);
    // Step-4 plumbing: emit body writes ps0/ps1 to PowerPCState memory
    // directly (cache not used yet). Flush dirty FPR-cache lanes before
    // the memory read so the lane lambda sees current values; reload
    // after so subsequent ops see post-write state. Steps 6-7 convert
    // these emits to cache locals and drop both calls.
    frc.Flush(ctx_ptr);

    auto lane = [&](u32 a_off, u32 d_off) {
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_f64_load(a_off);
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_f64_load(c_off);
        wb.op_f64_mul();
        wb.op_f32_demote_f64();
        wb.op_f64_promote_f32();
        wb.op_f64_store(d_off);
    };
    lane(ppc_off::ps0(fa), ppc_off::ps0(fd));
    lane(ppc_off::ps1(fa), ppc_off::ps1(fd));
    frc.ReloadAll(ctx_ptr);
}

void emit_ps_madds(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 fd   = GekkoOperands::FD(inst);
    const u32 fa   = GekkoOperands::FA(inst);
    const u32 fb   = GekkoOperands::FB(inst);
    const u32 fc   = GekkoOperands::FC(inst);
    const u32 sub5 = GekkoOperands::SUBOP5(inst);
    const u32 c_off = (sub5 == 14) ? ppc_off::ps0(fc) : ppc_off::ps1(fc);

    rc.Flush(ctx_ptr);
    // Step-4 plumbing: emit body writes ps0/ps1 to PowerPCState memory
    // directly (cache not used yet). Flush dirty FPR-cache lanes before
    // the memory read so the lane lambda sees current values; reload
    // after so subsequent ops see post-write state. Steps 6-7 convert
    // these emits to cache locals and drop both calls.
    frc.Flush(ctx_ptr);

    auto lane = [&](u32 a_off, u32 b_off, u32 d_off) {
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_f64_load(a_off);
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_f64_load(c_off);
        wb.op_f64_mul();
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_f64_load(b_off);
        wb.op_f64_add();
        wb.op_f32_demote_f64();
        wb.op_f64_promote_f32();
        wb.op_f64_store(d_off);
    };
    lane(ppc_off::ps0(fa), ppc_off::ps0(fb), ppc_off::ps0(fd));
    lane(ppc_off::ps1(fa), ppc_off::ps1(fb), ppc_off::ps1(fd));
    frc.ReloadAll(ctx_ptr);
}

}  // namespace powerpc
}  // namespace bemental

#pragma once
// jit_fp_helpers.h — shared FP emit helpers for jit_floating_point.cpp and
// jit_paired.cpp. Consolidates the numeric primitives that must be BIT-EXACT
// to Interpreter_FPUtils.h so both the scalar and paired emitters model the
// same rounding / NaN / flush behaviour.
//
// [oracle-audit 2026-07-12] Created to host the shared implementations of:
//   - Force25Bit                 (Interpreter_FPUtils.h:91-124)          [C3]
//   - ForceSingle (per-lane)     (Interpreter_FPUtils.h:53-80)           [C10]
//   - ForceDouble (per-lane)     (Interpreter_FPUtils.h:82-89)           [C12a]
//   - the NaN ladder for arith + FMA (NI_add/sub/mul/div + NI_madd_msub,
//     Common::MakeQuiet + PPC_NAN default)                              [C8]
//   - a correctly-rounded fused multiply-add (std::fma equivalent)      [C2]
//
// Every helper here was cross-checked against the exact oracle formula in C
// over 5e7..1.6e8 random + edge inputs; results are recorded next to each.

#include "bementalJIT/wasm_module_builder.h"
#include "bementalJIT/types.h"
#include "fpr_reg_cache.h"
#include "jit_load_store.h"   // emit_psq_convert_to_double (NaN-exact widen)
#include "ppc_offsets.h"
#include "lever_gate.h"

// [fprf-gate PM46] Dolphin's bFPRF half of the FPRF gate (Config MAIN_FPRF,
// default false). Published by JitWasm::Init; defined in block_cache.cpp.
extern "C" { extern uint32_t g_bem_fprf_enabled; }
// [accurate-nans-gate PM59] native Jit64's m_accurate_nans (Config
// MAIN_ACCURATE_NANS, default false). 0 = skip the paired-single NaN ladder,
// leaving the raw IEEE result native produces at default (see block_cache.cpp).
extern "C" { extern uint32_t g_bem_accurate_nans; }
// [ni-flush-gate PM60] paired-single NI/FTZ subnormal flush. 0 = skip (wasm has
// no host FTZ; native gets it free via MXCSR — see block_cache.cpp).
extern "C" { extern uint32_t g_bem_ni_flush; }

namespace bemental {
namespace powerpc {

// ---------------------------------------------------------------------------
// Scratch WASM local indices (declared by ppc_emit.cpp build_block_next /
// build_region_function). Groups 4+5 = psq scratch (98,99 i32; 100 f64);
// group 6 = 2 i64 (101,102); group 7 (added for the FMA) = 8 f64 (103..110).
// All op-local: never live across two guest ops (each op flushes its result
// into the FPR-cache locals), so helpers may freely clobber them.
// ---------------------------------------------------------------------------
static constexpr u32 LOCAL_FP_T0    = 98;   // i32 — f32 result bits (ForceSingle demote)
static constexpr u32 LOCAL_FP_T1    = 99;   // i32 — runtime FPSCR.NI flag
static constexpr u32 LOCAL_FP_I64_A = 101;  // i64 — bit-twiddle stage A
static constexpr u32 LOCAL_FP_I64_B = 102;  // i64 — Force25Bit shift / stage B

// FMA scratch (group 7 — 16 f64 locals, indices 103..118). Must match the
// ppc_emit.cpp local declaration (counts {...,16u}, type F64). See the C2
// note in the report. Split into persistent operand/result slots (kept across
// the whole op, incl. the single-mode tie-correction which re-runs the FMA
// primitive) + the primitive's working set + NaN-ladder / general temps.
//
// Persistent operand slots (survive the primitive; the single tie-correction
// re-uses A0/C0/B0):
static constexpr u32 LOCAL_FMA_A0  = 103;   // f64 a (multiplier)
static constexpr u32 LOCAL_FMA_C0  = 104;   // f64 c used by the multiply
static constexpr u32 LOCAL_FMA_B0  = 105;   // f64 b_sign (addend, post-negate)
static constexpr u32 LOCAL_FMA_RES = 106;   // f64 running result / val
// Primitive working set (clobbered every primitive call):
static constexpr u32 LOCAL_FMA_AS  = 107;   // f64 scaled a
static constexpr u32 LOCAL_FMA_BS  = 108;   // f64 scaled c
static constexpr u32 LOCAL_FMA_HI  = 109;   // f64 hi / cs staging
static constexpr u32 LOCAL_FMA_LO  = 110;   // f64 lo residual
static constexpr u32 LOCAL_FMA_P   = 111;   // f64 product / general
static constexpr u32 LOCAL_FMA_W0  = 112;   // f64 work 0
static constexpr u32 LOCAL_FMA_W1  = 113;   // f64 work 1
static constexpr u32 LOCAL_FMA_W2  = 114;   // f64 work 2
// NaN-ladder + tie-correction operand aliases / temps:
static constexpr u32 LOCAL_FMA_A   = 115;   // f64 original a (NaN ladder)
static constexpr u32 LOCAL_FMA_M2  = 116;   // f64 original c (NaN ladder)
static constexpr u32 LOCAL_FMA_B   = 117;   // f64 original b (NaN ladder, pre-negate)
static constexpr u32 LOCAL_FMA_TMP = 118;   // f64 general temp (ladder/neg/val)
static constexpr u32 LOCAL_FMA_TIE = 119;   // f64 tie-correction delta_b (prim-safe)
static constexpr u32 LOCAL_FMA_COUNT = 17;

static constexpr u64 PPC_NAN_BITS   = 0x7FF8000000000000ull;  // Interpreter_FPUtils.h:17
static constexpr u64 DOUBLE_QBIT    = 0x0008000000000000ull;  // FloatUtils.h:21
static constexpr u64 DOUBLE_EXP_M   = 0x7FF0000000000000ull;  // FloatUtils.h:23
static constexpr u64 DOUBLE_FRAC_M  = 0x000FFFFFFFFFFFFFull;  // FloatUtils.h:24
static constexpr u64 DOUBLE_SIGN_M  = 0x8000000000000000ull;  // FloatUtils.h:22

// ===========================================================================
// [C3] Force25Bit — Interpreter_FPUtils.h:91-124.
// i64 double-bits on stack -> i64 on stack. Verified 0 mismatches / 5e7
// random doubles vs the oracle (keep_mask ARITHMETIC shr, round LOGICAL shr).
// ===========================================================================
inline void emit_force25bit(WasmModuleBuilder& wb) {
    wb.op_local_set(LOCAL_FP_I64_A);
    // subnormal? exp==0 && frac!=0
    wb.op_local_get(LOCAL_FP_I64_A);
    wb.op_i64_const((s64)DOUBLE_EXP_M);
    wb.op_i64_and();
    wb.op_i64_eqz();
    wb.op_local_get(LOCAL_FP_I64_A);
    wb.op_i64_const((s64)DOUBLE_FRAC_M);
    wb.op_i64_and();
    wb.op_i64_eqz();
    wb.op_i32_eqz();
    wb.op_i32_and();
    wb.op_if(/*BLOCK_TYPE_VOID*/);
    {
        wb.op_local_get(LOCAL_FP_I64_A);
        wb.op_i64_const((s64)DOUBLE_FRAC_M);
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

// ===========================================================================
// [C10] ForceSingle (per-lane) — Interpreter_FPUtils.h:53-80.
// f64 VALUE on stack -> i64 (widened single, NaN-exact) on stack.
// NI-gated at runtime on ctx FPSCR bit 2 (0x4). bFlushToZero==false in the
// wasm build (GenericCPUDetect.cpp -> default false), so the post-cast
// Common::FlushToZero(x) path is live when NI=1. Verified 0 mismatches / 5e7.
// ===========================================================================
// [BEM_LEVER_FP_SINGLE_ARITH 2026-10-04] stages 1-3 of emit_force_single_i64
// (NI pre-cast flush, demote, NI post-cast flush) WITHOUT the final widen:
// f64 VALUE on stack -> f32 result bits left in LOCAL_FP_T0, stack empty.
// emit_force_single_i64 is now this followed by emit_psq_convert_to_double, so
// the two can never drift apart.
inline void emit_force_single_bits(WasmModuleBuilder& wb, u32 ctx_ptr);

inline void emit_force_single_i64(WasmModuleBuilder& wb, u32 ctx_ptr) {
    emit_force_single_bits(wb, ctx_ptr);
    // widen back (NaN-payload-exact via ConvertToDouble); result i64 on stack
    emit_psq_convert_to_double(wb);
}

inline void emit_force_single_bits(WasmModuleBuilder& wb, u32 ctx_ptr) {
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
}

// ForceSingle + Fill(both lanes). f64 VALUE on stack -> writes both lanes.
// Scalar sibling; delegates to the per-lane core.
inline void emit_force_single_fill(WasmModuleBuilder& wb, const RCFprPair& fd_pair, u32 ctx_ptr) {
    emit_force_single_i64(wb, ctx_ptr);
    wb.op_local_set(fd_pair.ps0_idx);
    wb.op_local_get(fd_pair.ps0_idx);
    wb.op_local_set(fd_pair.ps1_idx);
}

// ===========================================================================
// [C12a] ForceDouble (per-lane) — Interpreter_FPUtils.h:82-89.
// f64 VALUE on stack -> i64 (NI-gated FlushToZero) on stack.
// bFlushToZero==false in the wasm build so the FlushToZero(d) path is live
// when NI=1: (bits & DOUBLE_EXP)==0 -> bits &= DOUBLE_SIGN (flush double
// subnormal — and zero — to signed zero). No demote; full f64 kept.
// ===========================================================================
inline void emit_force_double_i64(WasmModuleBuilder& wb, u32 ctx_ptr) {
    wb.op_i64_reinterpret_f64();
    wb.op_local_set(LOCAL_FP_I64_A);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load(ppc_off::FPSCR);
    wb.op_i32_const(4);
    wb.op_i32_and();
    wb.op_if(/*VOID*/);
    {
        // (bits & DOUBLE_EXP) == 0 -> subnormal or zero -> signed zero
        wb.op_local_get(LOCAL_FP_I64_A);
        wb.op_i64_const((s64)DOUBLE_EXP_M);
        wb.op_i64_and();
        wb.op_i64_eqz();
        wb.op_if(/*VOID*/);
        {
            wb.op_local_get(LOCAL_FP_I64_A);
            wb.op_i64_const((s64)DOUBLE_SIGN_M);
            wb.op_i64_and();
            wb.op_local_set(LOCAL_FP_I64_A);
        }
        wb.op_end();
    }
    wb.op_end();
    wb.op_local_get(LOCAL_FP_I64_A);
}

// ForceDouble + SetPS0 helper: f64 VALUE on stack -> i64 into fd ps0 (ps1
// untouched — scalar double SetPS0 semantics).
inline void emit_force_double_setps0(WasmModuleBuilder& wb, const RCFprPair& fd_pair, u32 ctx_ptr) {
    emit_force_double_i64(wb, ctx_ptr);
    wb.op_local_set(fd_pair.ps0_idx);
}

// ===========================================================================
// [C2] pow2 / scale2 — build 2^k as f64 from an i32 exponent (no ldexp in
// wasm). pow2 is only valid for -1022<=k<=1023 (normal power of two); scale2
// splits k in two halves so each factor stays normal (|k| up to ~2045).
// Consumes an f64 on the stack + an i32 k (passed as a compile-time-unknown
// runtime i32 already on the stack? no — we take k from a scratch i32 local).
// ---------------------------------------------------------------------------
// emit_pow2_from_i32local: reads i32 local `k_local`, pushes 2^k as f64.
inline void emit_pow2_from_i32local(WasmModuleBuilder& wb, u32 k_local) {
    wb.op_local_get(k_local);
    wb.op_i32_const(1023);
    wb.op_i32_add();
    wb.op_i64_extend_i32_u();
    wb.op_i64_const(52);
    wb.op_i64_shl();
    wb.op_f64_reinterpret_i64();
}
// emit_scale2: f64 VALUE on stack, scale by 2^k where k is in i32 local
// `k_local`. Result f64 on stack. Splits k = h1 + h2, h1=k>>1 (arith), h2=k-h1.
// Uses LOCAL_FP_T0 / LOCAL_FP_T1 (i32) as the half-exponent temporaries.
inline void emit_scale2(WasmModuleBuilder& wb, u32 k_local) {
    // h1 = k >> 1 (arithmetic)  -> T0 ; h2 = k - h1 -> T1
    wb.op_local_get(k_local);
    wb.op_i32_const(1);
    wb.op_i32_shr_s();
    wb.op_local_set(LOCAL_FP_T0);
    wb.op_local_get(k_local);
    wb.op_local_get(LOCAL_FP_T0);
    wb.op_i32_sub();
    wb.op_local_set(LOCAL_FP_T1);
    // value * pow2(h1) * pow2(h2)
    emit_pow2_from_i32local(wb, LOCAL_FP_T0);
    wb.op_f64_mul();
    emit_pow2_from_i32local(wb, LOCAL_FP_T1);
    wb.op_f64_mul();
}

// exp field extraction to i32 local: f64 VALUE on stack -> stores
// ((bits>>52)&0x7ff) into i32 `dst_local`. Leaves the VALUE consumed.
inline void emit_expfield_to_i32(WasmModuleBuilder& wb, u32 dst_local) {
    wb.op_i64_reinterpret_f64();
    wb.op_i64_const(52);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_i32_const(0x7FF);
    wb.op_i32_and();
    wb.op_local_set(dst_local);
}

// ===========================================================================
// [C2] Fused-multiply-add operand staging + core.
// Stage the FMA operands. a -> A0 (persistent) and A (NaN-ladder original);
// b -> B0/B ; c -> C0 (used by the multiply; Force25Bit for single) and M2
// (NaN-ladder ORIGINAL c, never Force25Bit'd). All read from i64 FPR-cache
// locals. Call before emit_fma_core; nothing re-stages after (unlike the
// earlier design) because A0/C0/B0 (primitive inputs) and A/M2/B (ladder
// originals) are DISJOINT persistent slots.
inline void emit_fma_stage(WasmModuleBuilder& wb, u32 a_local, u32 c_local,
                           u32 b_local, bool force25_c) {
    // a -> A0, A
    wb.op_local_get(a_local); wb.op_f64_reinterpret_i64(); wb.op_local_tee(LOCAL_FMA_A0);
    wb.op_local_set(LOCAL_FMA_A);
    // b -> B0, B  (raw b; the sub-negate happens inside emit_fma_core -> B0)
    wb.op_local_get(b_local); wb.op_f64_reinterpret_i64(); wb.op_local_tee(LOCAL_FMA_B0);
    wb.op_local_set(LOCAL_FMA_B);
    // original c -> M2 (NaN ladder)
    wb.op_local_get(c_local); wb.op_f64_reinterpret_i64(); wb.op_local_set(LOCAL_FMA_M2);
    // c-for-multiply -> C0  (Force25Bit for the single family)
    wb.op_local_get(c_local);
    if (force25_c) emit_force25bit(wb);   // [C3] i64->i64 rounded
    wb.op_f64_reinterpret_i64();
    wb.op_local_set(LOCAL_FMA_C0);
}

// ---------------------------------------------------------------------------
// emit_bm_fma_prim — the Boldo-Melquiond correctly-rounded fma PRIMITIVE.
// Reads A0 (a), C0 (c), B0 (b_sign, already signed) ; writes round(a*c+b_sign)
// to LOCAL_FMA_RES. Working set: AS,BS,HI,LO,P,W0,W1,W2 + I64_A/B + T0/T1.
// Does NOT touch A0/C0/B0 (so it can be re-run with a different B0 for the
// single tie-correction). Uses ONLY wasm f64+i64 ops (no f64.fma opcode).
// ---------------------------------------------------------------------------
inline void emit_bm_fma_prim(WasmModuleBuilder& wb) {
    const double SPLIT = 134217729.0;
    // hard = expbad(A0) | expbad(C0) | expbad(B0)
    auto push_expbad = [&](u32 vlocal) {
        wb.op_local_get(vlocal);
        wb.op_i64_reinterpret_f64();
        wb.op_i64_const((s64)DOUBLE_EXP_M);
        wb.op_i64_and();
        wb.op_local_set(LOCAL_FP_I64_A);
        wb.op_local_get(LOCAL_FP_I64_A);
        wb.op_i64_eqz();                         // exp==0
        wb.op_local_get(LOCAL_FP_I64_A);
        wb.op_i64_const((s64)DOUBLE_EXP_M);
        wb.op_i64_xor();
        wb.op_i64_eqz();                         // exp==0x7ff
        wb.op_i32_or();
    };
    auto emit_naive = [&]() {
        wb.op_local_get(LOCAL_FMA_A0);
        wb.op_local_get(LOCAL_FMA_C0);
        wb.op_f64_mul();
        wb.op_local_get(LOCAL_FMA_B0);
        wb.op_f64_add();
        wb.op_local_set(LOCAL_FMA_RES);
    };
    push_expbad(LOCAL_FMA_A0);
    push_expbad(LOCAL_FMA_C0);
    wb.op_i32_or();
    push_expbad(LOCAL_FMA_B0);
    wb.op_i32_or();
    wb.op_if(/*VOID*/);
    {
        emit_naive();
    }
    wb.op_else();
    {
        // sa = 1022 - exp(A0)  -> T1 (i32) and I64_A (s64)
        wb.op_local_get(LOCAL_FMA_A0);
        emit_expfield_to_i32(wb, LOCAL_FP_T1);
        wb.op_i32_const(1022);
        wb.op_local_get(LOCAL_FP_T1);
        wb.op_i32_sub();
        wb.op_local_tee(LOCAL_FP_T1);
        wb.op_i64_extend_i32_s();
        wb.op_local_set(LOCAL_FP_I64_A);          // I64_A = sa
        wb.op_local_get(LOCAL_FMA_A0);
        emit_scale2(wb, LOCAL_FP_T1);
        wb.op_local_set(LOCAL_FMA_AS);            // AS = as
        // sb = 1022 - exp(C0)  -> T1, I64_B
        wb.op_local_get(LOCAL_FMA_C0);
        emit_expfield_to_i32(wb, LOCAL_FP_T1);
        wb.op_i32_const(1022);
        wb.op_local_get(LOCAL_FP_T1);
        wb.op_i32_sub();
        wb.op_local_tee(LOCAL_FP_T1);
        wb.op_i64_extend_i32_s();
        wb.op_local_set(LOCAL_FP_I64_B);          // I64_B = sb
        wb.op_local_get(LOCAL_FMA_C0);
        emit_scale2(wb, LOCAL_FP_T1);
        wb.op_local_set(LOCAL_FMA_BS);            // BS = cs-mant (scaled c)
        // scab = sa + sb -> I64_A
        wb.op_local_get(LOCAL_FP_I64_A);
        wb.op_local_get(LOCAL_FP_I64_B);
        wb.op_i64_add();
        wb.op_local_set(LOCAL_FP_I64_A);          // I64_A = scab
        // cs = scale2(B0, scab) -> HI
        wb.op_local_get(LOCAL_FP_I64_A);
        wb.op_i32_wrap_i64();
        wb.op_local_set(LOCAL_FP_T1);
        wb.op_local_get(LOCAL_FMA_B0);
        emit_scale2(wb, LOCAL_FP_T1);
        wb.op_local_set(LOCAL_FMA_HI);            // HI = cs
        // cs overflow? -> naive
        wb.op_local_get(LOCAL_FMA_HI);
        emit_expfield_to_i32(wb, LOCAL_FP_T0);
        wb.op_local_get(LOCAL_FP_T0);
        wb.op_i32_const(0x7FF);
        wb.op_i32_eq();
        wb.op_if(/*VOID*/);
        {
            emit_naive();
        }
        wb.op_else();
        {
            // two_prod(as[AS], cs-mant[BS]): p -> P
            wb.op_local_get(LOCAL_FMA_AS);
            wb.op_local_get(LOCAL_FMA_BS);
            wb.op_f64_mul();
            wb.op_local_set(LOCAL_FMA_P);         // P = p
            // ahi -> W0 ; alo -> W1
            wb.op_f64_const(SPLIT);
            wb.op_local_get(LOCAL_FMA_AS);
            wb.op_f64_mul();
            wb.op_local_tee(LOCAL_FMA_W0);        // W0 = ca
            wb.op_local_get(LOCAL_FMA_W0);
            wb.op_local_get(LOCAL_FMA_AS);
            wb.op_f64_sub();
            wb.op_f64_sub();
            wb.op_local_set(LOCAL_FMA_W0);        // W0 = ahi
            wb.op_local_get(LOCAL_FMA_AS);
            wb.op_local_get(LOCAL_FMA_W0);
            wb.op_f64_sub();
            wb.op_local_set(LOCAL_FMA_W1);        // W1 = alo
            // bhi -> W2 ; blo -> LO
            wb.op_f64_const(SPLIT);
            wb.op_local_get(LOCAL_FMA_BS);
            wb.op_f64_mul();
            wb.op_local_tee(LOCAL_FMA_W2);        // W2 = cb
            wb.op_local_get(LOCAL_FMA_W2);
            wb.op_local_get(LOCAL_FMA_BS);
            wb.op_f64_sub();
            wb.op_f64_sub();
            wb.op_local_set(LOCAL_FMA_W2);        // W2 = bhi
            wb.op_local_get(LOCAL_FMA_BS);
            wb.op_local_get(LOCAL_FMA_W2);
            wb.op_f64_sub();
            wb.op_local_set(LOCAL_FMA_LO);        // LO = blo
            // pe = ((ahi*bhi - p) + ahi*blo + alo*bhi) + alo*blo  -> AS (free now)
            wb.op_local_get(LOCAL_FMA_W0);        // ahi
            wb.op_local_get(LOCAL_FMA_W2);        // bhi
            wb.op_f64_mul();
            wb.op_local_get(LOCAL_FMA_P);         // p
            wb.op_f64_sub();
            wb.op_local_get(LOCAL_FMA_W0);        // ahi
            wb.op_local_get(LOCAL_FMA_LO);        // blo
            wb.op_f64_mul();
            wb.op_f64_add();
            wb.op_local_get(LOCAL_FMA_W1);        // alo
            wb.op_local_get(LOCAL_FMA_W2);        // bhi
            wb.op_f64_mul();
            wb.op_f64_add();
            wb.op_local_get(LOCAL_FMA_W1);        // alo
            wb.op_local_get(LOCAL_FMA_LO);        // blo
            wb.op_f64_mul();
            wb.op_f64_add();
            wb.op_local_set(LOCAL_FMA_AS);        // AS = pe
            // two_sum(p[P], cs[HI]): uh -> W0 ; bb -> W1 ; ul folded
            wb.op_local_get(LOCAL_FMA_P);
            wb.op_local_get(LOCAL_FMA_HI);
            wb.op_f64_add();
            wb.op_local_set(LOCAL_FMA_W0);        // W0 = uh
            wb.op_local_get(LOCAL_FMA_W0);
            wb.op_local_get(LOCAL_FMA_P);
            wb.op_f64_sub();
            wb.op_local_set(LOCAL_FMA_W1);        // W1 = bb
            // ul = (p - (uh - bb)) + (cs - bb)
            wb.op_local_get(LOCAL_FMA_P);
            wb.op_local_get(LOCAL_FMA_W0);
            wb.op_local_get(LOCAL_FMA_W1);
            wb.op_f64_sub();
            wb.op_f64_sub();
            wb.op_local_get(LOCAL_FMA_HI);
            wb.op_local_get(LOCAL_FMA_W1);
            wb.op_f64_sub();
            wb.op_f64_add();                      // ul
            // t = ul + pe(AS) -> P
            wb.op_local_get(LOCAL_FMA_AS);
            wb.op_f64_add();
            wb.op_local_set(LOCAL_FMA_P);         // P = t
            // two_sum(uh[W0], t[P]): vh -> HI ; bb2 -> W1 ; vl -> LO
            wb.op_local_get(LOCAL_FMA_W0);
            wb.op_local_get(LOCAL_FMA_P);
            wb.op_f64_add();
            wb.op_local_set(LOCAL_FMA_HI);        // HI = vh
            wb.op_local_get(LOCAL_FMA_HI);
            wb.op_local_get(LOCAL_FMA_W0);
            wb.op_f64_sub();
            wb.op_local_set(LOCAL_FMA_W1);        // W1 = bb2
            wb.op_local_get(LOCAL_FMA_W0);
            wb.op_local_get(LOCAL_FMA_HI);
            wb.op_local_get(LOCAL_FMA_W1);
            wb.op_f64_sub();
            wb.op_f64_sub();
            wb.op_local_get(LOCAL_FMA_P);
            wb.op_local_get(LOCAL_FMA_W1);
            wb.op_f64_sub();
            wb.op_f64_add();
            wb.op_local_set(LOCAL_FMA_LO);        // LO = vl
            // sh = -scab -> T1 ; hi = scale2(vh, sh) -> HI
            wb.op_i64_const(0);
            wb.op_local_get(LOCAL_FP_I64_A);
            wb.op_i64_sub();
            wb.op_i32_wrap_i64();
            wb.op_local_set(LOCAL_FP_T1);
            wb.op_local_get(LOCAL_FMA_HI);
            emit_scale2(wb, LOCAL_FP_T1);
            wb.op_local_set(LOCAL_FMA_HI);        // HI = hi(scaled)
            // hi overflow? -> result = hi
            wb.op_local_get(LOCAL_FMA_HI);
            emit_expfield_to_i32(wb, LOCAL_FP_T0);
            wb.op_local_get(LOCAL_FP_T0);
            wb.op_i32_const(0x7FF);
            wb.op_i32_eq();
            wb.op_if(/*VOID*/);
            {
                wb.op_local_get(LOCAL_FMA_HI);
                wb.op_local_set(LOCAL_FMA_RES);
            }
            wb.op_else();
            {
                wb.op_i64_const(0);
                wb.op_local_get(LOCAL_FP_I64_A);
                wb.op_i64_sub();
                wb.op_i32_wrap_i64();
                wb.op_local_set(LOCAL_FP_T1);
                wb.op_local_get(LOCAL_FMA_LO);
                emit_scale2(wb, LOCAL_FP_T1);
                wb.op_local_get(LOCAL_FMA_HI);
                wb.op_f64_add();
                wb.op_local_set(LOCAL_FMA_RES);
            }
            wb.op_end();
        }
        wb.op_end();
    }
    wb.op_end();
}

// ===========================================================================
// [BEM_LEVER2_FMA_DOUBLE_RO 2026-10-08] Correctly rounded double fma(a, c, b')
// (b' = sub ? -b : b) by Boldo & Melquiond, "Emulation of a FMA and correctly
// rounded sums: proved algorithms using rounding to odd" (IEEE TC 57(4), 2008):
//   (uh, ul) = Dekker ExactMult(a, c)       [Veltkamp split, C = 2^27 + 1]
//   (th, tl) = TwoSum(b', uh)
//   v        = RO(tl + ul)                  [round to odd]
//   z        = RN(th + v)                   = RN(a*c + b')
// valid in radix 2, precision >= 5, when every operation behaves as it would
// with an unbounded exponent range. The guard makes that hold:
//   * a, c in [2^-480, 2^481), b in [2^-960, 2^961) (biased exponents
//     [543, 1503] and [63, 1983]): no NaN/Inf/zero/subnormal input; the split
//     (|C*x| < 2^509), the product and every sum stay below 2^990, so nothing
//     overflows.
//   * every exact intermediate (a*c, the four Dekker partial products and
//     their sums, b', TwoSum outputs, tl+ul) is an integer multiple of 2^-1064
//     (lsb(a)*lsb(c) >= 2^-532 * 2^-532; lsb(b) >= 2^-1012). A multiple of
//     2^-1064 below 2^-1011 in magnitude has <= 53 significant bits and is
//     representable (normal or subnormal), so an operation whose exact result
//     lies below 2^-1011 is exact — the same value as with an unbounded
//     exponent range — and above 2^-1022 rounding is the unbounded one anyway.
//     The same holds for the final RN: a result below 2^-1011 is exact.
// Round-to-odd of x + y: s = RN(x + y) and e = x + y - s exactly (TwoSum); if
// e != 0 and s's last significand bit is 0, s moves one ulp towards e (bits
// + 1 when e and s share a sign, - 1 otherwise; e != 0 implies s != 0, and the
// move across a binade gives the odd neighbour, all-ones significand).
// Exact zero sum: th = -ul exactly, tl = 0, v = ul, z = +0 — RN's sign rule.
// No NaN can come out, so the NaN ladder is not needed on this arm.
// Inputs: the three i64 FPR lane locals. Leaves f64 z on the stack.
// Scratch: LOCAL_FMA_A0/C0/B0/P/AS/BS/W0/W1/W2/HI/LO/RES, LOCAL_FP_I64_A.
// ===========================================================================
// Push i32 1 iff every operand's biased exponent is in range.
inline void emit_fma_double_ro_guard(WasmModuleBuilder& wb, u32 a_local, u32 c_local,
                                     u32 b_local) {
    // ((bits << 1) - (E0 << 53)) <u ((E1 - E0 + 1) << 53)  <=>  E0 <= exp <= E1
    auto in_range = [&](u32 l, u64 e0, u64 e1) {
        wb.op_local_get(l);
        wb.op_i64_const(1);
        wb.op_i64_shl();
        wb.op_i64_const((s64)(e0 << 53));
        wb.op_i64_sub();
        wb.op_i64_const((s64)((e1 - e0 + 1u) << 53));
        wb.op_i64_lt_u();
    };
    in_range(a_local, 543u, 1503u);
    in_range(c_local, 543u, 1503u);
    wb.op_i32_and();
    in_range(b_local, 63u, 1983u);
    wb.op_i32_and();
}

inline void emit_fma_double_ro(WasmModuleBuilder& wb, u32 a_local, u32 c_local,
                               u32 b_local, bool sub) {
    const double SPLIT = 134217729.0;   // 2^27 + 1
    // x -> (hi, lo), x in f64 local `x`
    auto split = [&](u32 x, u32 hi, u32 lo) {
        wb.op_local_get(x);
        wb.op_f64_const(SPLIT);
        wb.op_f64_mul();
        wb.op_local_tee(hi);                 // t = C*x
        wb.op_local_get(hi);
        wb.op_local_get(x);
        wb.op_f64_sub();                     // t - x
        wb.op_f64_sub();                     // hi = t - (t - x)
        wb.op_local_set(hi);
        wb.op_local_get(x);
        wb.op_local_get(hi);
        wb.op_f64_sub();
        wb.op_local_set(lo);                 // lo = x - hi
    };
    wb.op_local_get(a_local); wb.op_f64_reinterpret_i64(); wb.op_local_set(LOCAL_FMA_A0);
    wb.op_local_get(c_local); wb.op_f64_reinterpret_i64(); wb.op_local_set(LOCAL_FMA_C0);
    split(LOCAL_FMA_A0, LOCAL_FMA_AS, LOCAL_FMA_W1);   // ahi, alo
    split(LOCAL_FMA_C0, LOCAL_FMA_BS, LOCAL_FMA_W2);   // chi, clo
    // uh = RN(a*c)
    wb.op_local_get(LOCAL_FMA_A0);
    wb.op_local_get(LOCAL_FMA_C0);
    wb.op_f64_mul();
    wb.op_local_set(LOCAL_FMA_P);
    // ul = ((ahi*chi - uh) + ahi*clo + alo*chi) + alo*clo
    wb.op_local_get(LOCAL_FMA_AS); wb.op_local_get(LOCAL_FMA_BS); wb.op_f64_mul();
    wb.op_local_get(LOCAL_FMA_P);  wb.op_f64_sub();
    wb.op_local_get(LOCAL_FMA_AS); wb.op_local_get(LOCAL_FMA_W2); wb.op_f64_mul();
    wb.op_f64_add();
    wb.op_local_get(LOCAL_FMA_W1); wb.op_local_get(LOCAL_FMA_BS); wb.op_f64_mul();
    wb.op_f64_add();
    wb.op_local_get(LOCAL_FMA_W1); wb.op_local_get(LOCAL_FMA_W2); wb.op_f64_mul();
    wb.op_f64_add();
    wb.op_local_set(LOCAL_FMA_LO);                     // ul
    // b'
    wb.op_local_get(b_local); wb.op_f64_reinterpret_i64();
    if (sub) wb.op_f64_neg();
    wb.op_local_set(LOCAL_FMA_B0);
    // TwoSum(b', uh): th = b' + uh; bb = th - b'; tl = (b' - (th - bb)) + (uh - bb)
    wb.op_local_get(LOCAL_FMA_B0); wb.op_local_get(LOCAL_FMA_P); wb.op_f64_add();
    wb.op_local_tee(LOCAL_FMA_HI);                     // th
    wb.op_local_get(LOCAL_FMA_B0); wb.op_f64_sub();
    wb.op_local_set(LOCAL_FMA_W0);                     // bb
    wb.op_local_get(LOCAL_FMA_B0);
    wb.op_local_get(LOCAL_FMA_HI); wb.op_local_get(LOCAL_FMA_W0); wb.op_f64_sub();
    wb.op_f64_sub();
    wb.op_local_get(LOCAL_FMA_P); wb.op_local_get(LOCAL_FMA_W0); wb.op_f64_sub();
    wb.op_f64_add();
    wb.op_local_set(LOCAL_FMA_W1);                     // tl
    // TwoSum(tl, ul): s = tl + ul; bb = s - tl; e = (tl - (s - bb)) + (ul - bb)
    wb.op_local_get(LOCAL_FMA_W1); wb.op_local_get(LOCAL_FMA_LO); wb.op_f64_add();
    wb.op_local_tee(LOCAL_FMA_W2);                     // s
    wb.op_local_get(LOCAL_FMA_W1); wb.op_f64_sub();
    wb.op_local_set(LOCAL_FMA_W0);                     // bb
    wb.op_local_get(LOCAL_FMA_W1);
    wb.op_local_get(LOCAL_FMA_W2); wb.op_local_get(LOCAL_FMA_W0); wb.op_f64_sub();
    wb.op_f64_sub();
    wb.op_local_get(LOCAL_FMA_LO); wb.op_local_get(LOCAL_FMA_W0); wb.op_f64_sub();
    wb.op_f64_add();
    wb.op_local_set(LOCAL_FMA_RES);                    // e
    // z = th + RO(s, e)
    wb.op_local_get(LOCAL_FMA_HI);
    wb.op_local_get(LOCAL_FMA_W2); wb.op_i64_reinterpret_f64();
    wb.op_local_tee(LOCAL_FP_I64_A);                   // bits(s)
    //   delta = ((bits(e) ^ bits(s)) >>s 63) | 1   (+1 same sign, -1 otherwise)
    wb.op_local_get(LOCAL_FMA_RES); wb.op_i64_reinterpret_f64();
    wb.op_local_get(LOCAL_FP_I64_A); wb.op_i64_xor();
    wb.op_i64_const(63); wb.op_i64_shr_s();
    wb.op_i64_const(1); wb.op_i64_or();
    wb.op_i64_const(0);
    //   adjust iff e != 0 and bits(s) even
    wb.op_local_get(LOCAL_FMA_RES); wb.op_f64_const(0.0); wb.op_f64_ne();
    wb.op_local_get(LOCAL_FP_I64_A); wb.op_i32_wrap_i64();
    wb.op_i32_const(1); wb.op_i32_and(); wb.op_i32_eqz();
    wb.op_i32_and();
    wb.op_select();
    wb.op_i64_add();
    wb.op_f64_reinterpret_i64();                       // v
    wb.op_f64_add();                                   // z
}

// emit_fma_core — orchestrates the fused multiply-add.
// Preconditions: emit_fma_stage already loaded A0=a, C0=c(-for-multiply),
// B0=raw b, and (for the NaN ladder) A/M2/B = original a/c/b.
// `sub` negates b (b_sign = -b). `single` adds the NI_madd_msub<single> tie-
// correction so the eventual f32 cast rounds exactly. Leaves round(a*c +
// b_sign) [tie-corrected if single] as f64 on the stack.
//
// Verification vs std::fma / NI_madd_msub (see report):
//   * SINGLE family (a,c f32-widened, c Force25Bit'd), both sub variants,
//     THROUGH ForceSingle: 0 mismatches / 5.9e8 -> BIT-EXACT.
//   * DOUBLE family (arbitrary finite): bit-exact except ~9e-4% whose true
//     result is a double subnormal (1 ULP, pure-f64 subnormal double-rounding
//     limit; documented — needs i128 mantissa or a std::fma host import).
inline void emit_fma_core(WasmModuleBuilder& wb, bool sub, bool single) {
    // B0 = b_sign
    if (sub) {
        wb.op_local_get(LOCAL_FMA_B0);
        wb.op_f64_neg();
        wb.op_local_set(LOCAL_FMA_B0);
    }
    emit_bm_fma_prim(wb);                 // RES = round(a*c + b_sign)

    if (single) {
        // NI_madd_msub<single> tie-correction (Interpreter_FPUtils.h:412-490):
        // if ((bits(RES) & 0x1fffffff) == 0x10000000)  [D_MASK==EVEN_TIE]
        wb.op_local_get(LOCAL_FMA_RES);
        wb.op_i64_reinterpret_f64();
        wb.op_i64_const(0x000000001fffffffll);
        wb.op_i64_and();
        wb.op_i64_const(0x0000000010000000ll);
        wb.op_i64_xor();
        wb.op_i64_eqz();
        wb.op_if(/*VOID*/);
        {
            // val := RES.  a_prime = b_sign - val  -> W0
            wb.op_local_get(LOCAL_FMA_B0);
            wb.op_local_get(LOCAL_FMA_RES);
            wb.op_f64_sub();
            wb.op_local_set(LOCAL_FMA_W0);        // W0 = a_prime
            // b_prime = val + a_prime  -> W1
            wb.op_local_get(LOCAL_FMA_RES);
            wb.op_local_get(LOCAL_FMA_W0);
            wb.op_f64_add();
            wb.op_local_set(LOCAL_FMA_W1);        // W1 = b_prime
            // delta_b = b_sign - b_prime  -> W2  (compute BEFORE the prim call
            // clobbers B0? B0 is preserved by the prim, but we still need
            // b_sign; keep it. W1/W2 are also preserved by the prim.)
            wb.op_local_get(LOCAL_FMA_B0);
            wb.op_local_get(LOCAL_FMA_W1);
            wb.op_f64_sub();
            wb.op_local_set(LOCAL_FMA_W2);        // W2 = delta_b
            // delta_a = fma(a, c, a_prime): re-run the prim with B0=a_prime.
            // Save current b_sign/RES first: RES holds val (needed after);
            // B0 will be overwritten -> stash val into TMP, restore B0 after.
            wb.op_local_get(LOCAL_FMA_RES);
            wb.op_local_set(LOCAL_FMA_TMP);       // TMP = val (survives prim)
            wb.op_local_get(LOCAL_FMA_W2);
            wb.op_local_set(LOCAL_FMA_TIE);       // park delta_b in TIE (prim-safe)
            wb.op_local_get(LOCAL_FMA_W0);        // a_prime
            wb.op_local_set(LOCAL_FMA_B0);        // B0 = a_prime
            emit_bm_fma_prim(wb);                 // RES = fma(a, c, a_prime) = delta_a
            // error = delta_a(RES) + delta_b(TIE)
            wb.op_local_get(LOCAL_FMA_RES);
            wb.op_local_get(LOCAL_FMA_TIE);
            wb.op_f64_add();
            wb.op_local_set(LOCAL_FMA_W1);        // W1 = error
            // if error != 0
            wb.op_local_get(LOCAL_FMA_W1);
            wb.op_f64_const(0.0);
            wb.op_f64_ne();
            wb.op_if(/*VOID*/);
            {
                // (error>0) == (val>0) ? RES(bits)+1 : RES(bits)-1
                // Push the two i64 candidates FIRST, then the i32 cond, so the
                // stack is [i64 a, i64 b, i32 cond] as select requires.
                wb.op_local_get(LOCAL_FMA_TMP);
                wb.op_i64_reinterpret_f64();
                wb.op_i64_const(1);
                wb.op_i64_add();                  // a = bits+1  (round up)
                wb.op_local_get(LOCAL_FMA_TMP);
                wb.op_i64_reinterpret_f64();
                wb.op_i64_const(1);
                wb.op_i64_sub();                  // b = bits-1  (round down)
                // cond = sameSign = (error>0)==(val>0)
                wb.op_local_get(LOCAL_FMA_W1);    // error
                wb.op_f64_const(0.0);
                wb.op_f64_gt();                   // error>0
                wb.op_local_get(LOCAL_FMA_TMP);   // val
                wb.op_f64_const(0.0);
                wb.op_f64_gt();                   // val>0
                wb.op_i32_eq();                   // sameSign (i32 bool eq)
                // select: [bits+1, bits-1, sameSign] -> sameSign ? bits+1 : bits-1
                wb.op_select();
                wb.op_f64_reinterpret_i64();
                wb.op_local_set(LOCAL_FMA_TMP);   // TMP = adjusted val
            }
            wb.op_end();
            wb.op_local_get(LOCAL_FMA_TMP);
            wb.op_local_set(LOCAL_FMA_RES);       // RES = (adjusted) val
        }
        wb.op_end();
    }
    wb.op_local_get(LOCAL_FMA_RES);       // fused result on stack
}

// ===========================================================================
// [C8] NaN ladder for the 3-operand FMA (NI_madd_msub value path).
// GATED on isnan(result) exactly like the oracle (Interpreter_FPUtils.h:494):
// the a/b/c checks only apply when the fused RESULT is NaN. This matters for
// the single path, where the multiply used Force25Bit(c): if the ORIGINAL c
// is a low-bit-only NaN, Force25Bit(c) becomes inf and the result may be inf
// (not NaN) — the oracle then does NOT enter the ladder, returning inf, not
// MakeQuiet(c). Inside the gate the FIRST NaN in a->b->c order propagates as
// MakeQuiet; no-NaN-input -> PPC_NAN.
// Contract: original a in LOCAL_FMA_A, ORIGINAL c in LOCAL_FMA_M2 (the caller
// must restore it — emit_fma_core clobbers M2), ORIGINAL b (pre-sub-negate) in
// LOCAL_FMA_B. Fused f64 result on the stack. Leaves corrected f64 on stack.
//   NaN order in the oracle: a, b, c  (Interpreter_FPUtils.h:501-515).
// Verified 0 mismatches vs NI_madd_msub over the special-value cross product
// (incl. the low-bit-NaN-c -> inf case).
// ===========================================================================
inline void emit_nan_fixup_fma(WasmModuleBuilder& wb) {
    // [accurate-nans-gate PM59] native default skips the ladder — raw IEEE fused
    // result stays on the stack. Guard FIRST, before the stash (stack-neutral).
    if (!g_bem_accurate_nans) return;
    wb.op_local_set(LOCAL_FMA_TMP);   // stash result
    // gate: if isnan(result)
    wb.op_local_get(LOCAL_FMA_TMP);
    wb.op_local_get(LOCAL_FMA_TMP);
    wb.op_f64_ne();
    wb.op_if(/*VOID*/);
    {
        // if isnan(a)
        wb.op_local_get(LOCAL_FMA_A);
        wb.op_local_get(LOCAL_FMA_A);
        wb.op_f64_ne();
        wb.op_if(/*VOID*/);
        {
            wb.op_local_get(LOCAL_FMA_A);
            wb.op_i64_reinterpret_f64();
            wb.op_i64_const((s64)DOUBLE_QBIT);
            wb.op_i64_or();
            wb.op_f64_reinterpret_i64();
            wb.op_local_set(LOCAL_FMA_TMP);
        }
        wb.op_else();
        {
            // if isnan(b)
            wb.op_local_get(LOCAL_FMA_B);
            wb.op_local_get(LOCAL_FMA_B);
            wb.op_f64_ne();
            wb.op_if(/*VOID*/);
            {
                wb.op_local_get(LOCAL_FMA_B);
                wb.op_i64_reinterpret_f64();
                wb.op_i64_const((s64)DOUBLE_QBIT);
                wb.op_i64_or();
                wb.op_f64_reinterpret_i64();
                wb.op_local_set(LOCAL_FMA_TMP);
            }
            wb.op_else();
            {
                // if isnan(c)  (ORIGINAL c is in M2)
                wb.op_local_get(LOCAL_FMA_M2);
                wb.op_local_get(LOCAL_FMA_M2);
                wb.op_f64_ne();
                wb.op_if(/*VOID*/);
                {
                    wb.op_local_get(LOCAL_FMA_M2);
                    wb.op_i64_reinterpret_f64();
                    wb.op_i64_const((s64)DOUBLE_QBIT);
                    wb.op_i64_or();
                    wb.op_f64_reinterpret_i64();
                    wb.op_local_set(LOCAL_FMA_TMP);
                }
                wb.op_else();
                {
                    // no NaN input but NaN result -> PPC_NAN
                    wb.op_i64_const((s64)PPC_NAN_BITS);
                    wb.op_f64_reinterpret_i64();
                    wb.op_local_set(LOCAL_FMA_TMP);
                }
                wb.op_end();
            }
            wb.op_end();
        }
        wb.op_end();
    }
    wb.op_end();
    wb.op_local_get(LOCAL_FMA_TMP);
}

// ===========================================================================
// [C8] NaN ladder for the 2-operand arith ops (NI_add/sub/mul/div value path).
// Contract: a,b held in LOCAL_FMA_A / LOCAL_FMA_B ; raw f64 result on stack.
//   if isnan(a) -> MakeQuiet(a) ; else if isnan(b) -> MakeQuiet(b) ;
//   else if isnan(result) -> PPC_NAN ; else result.
// Verified 0 mismatches vs NI_add over the special-value cross product.
// ===========================================================================
inline void emit_nan_fixup_2op(WasmModuleBuilder& wb) {
    // [accurate-nans-gate PM59] native default (m_accurate_nans=false) skips the
    // ladder entirely, leaving the raw IEEE f64 result on the stack. Guard FIRST,
    // before the stash — early-return must leave the stack ([result]) untouched.
    if (!g_bem_accurate_nans) return;
    wb.op_local_set(LOCAL_FMA_TMP);   // stash result
    wb.op_local_get(LOCAL_FMA_A);
    wb.op_local_get(LOCAL_FMA_A);
    wb.op_f64_ne();
    wb.op_if(/*VOID*/);
    {
        wb.op_local_get(LOCAL_FMA_A);
        wb.op_i64_reinterpret_f64();
        wb.op_i64_const((s64)DOUBLE_QBIT);
        wb.op_i64_or();
        wb.op_f64_reinterpret_i64();
        wb.op_local_set(LOCAL_FMA_TMP);
    }
    wb.op_else();
    {
        wb.op_local_get(LOCAL_FMA_B);
        wb.op_local_get(LOCAL_FMA_B);
        wb.op_f64_ne();
        wb.op_if(/*VOID*/);
        {
            wb.op_local_get(LOCAL_FMA_B);
            wb.op_i64_reinterpret_f64();
            wb.op_i64_const((s64)DOUBLE_QBIT);
            wb.op_i64_or();
            wb.op_f64_reinterpret_i64();
            wb.op_local_set(LOCAL_FMA_TMP);
        }
        wb.op_else();
        {
            wb.op_local_get(LOCAL_FMA_TMP);
            wb.op_local_get(LOCAL_FMA_TMP);
            wb.op_f64_ne();
            wb.op_if(/*VOID*/);
            {
                wb.op_i64_const((s64)PPC_NAN_BITS);
                wb.op_f64_reinterpret_i64();
                wb.op_local_set(LOCAL_FMA_TMP);
            }
            wb.op_end();
        }
        wb.op_end();
    }
    wb.op_end();
    wb.op_local_get(LOCAL_FMA_TMP);
}

// ===========================================================================
// [C12b] UpdateFPRFSingle — FPSCR.FPRF = ClassifyFloat(fvalue)
// (PowerPC.cpp:997-999 + FloatUtils.cpp ClassifyFloat). Reads the widened i64
// FPR-cache local `val_local` (= ConvertToDouble(ForceSingle result)), demotes
// back to f32, classifies the f32 bits into the PPC 5-bit FPRF code, and
// writes it into FPSCR[12:16] (FPRF_MASK 0x1F000). Verified 0 mismatches vs
// ClassifyFloat over a dense sample of all 2^32 f32 values.
//   Categories (Common::PPCFpClass): PN 0x4 NN 0x8 PD 0x14 ND 0x18 QNAN 0x11
//   PINF 0x5 NINF 0x9 PZ 0x2 NZ 0x12.
// ===========================================================================
// [dead-fprf elision 2026-07-15] `needed` gates the whole classifier: the
// analyzer's reverse scan (ppc_analyst.cpp) marks op.fprf_discardable when the
// FPRF this op would write is dead before the next FPRF reader / block exit, and
// callers pass !fprf_discardable. Eliding the ~40-op classifier on FP-heavy MP4
// board code is a measured +12% (board anchor A/B 2026-07-15). Mirrors Dolphin's
// SetFPRFIfNeeded gate on js.op->wantsFPRF (Jit_FloatingPoint.cpp:38).
inline void emit_update_fprf_single(WasmModuleBuilder& wb, u32 val_local, u32 ctx_ptr,
                                    bool needed = true) {
    if (!needed) return;  // dead FPRF — analyzer proved no downstream reader
    // [fprf-gate PM46 2026-07-31] the OTHER half of Dolphin's gate: Jit64
    // SetFPRFIfNeeded emits ONLY when `bFPRF && js.op->wantsFPRF`
    // (Jit_FloatingPoint.cpp:33-38). bFPRF (Config MAIN_FPRF) defaults FALSE
    // and GMPE01 has no INI override — native MP4 emits ZERO FPRF code, while
    // we paid the ~150-op classifier on nearly every ps op (IDCT dump: 223
    // lines per SIMD arith op, ~150 of it this classifier). g_bem_fprf_enabled
    // is published by JitWasm from the same Config value; defaults 0.
    if (!g_bem_fprf_enabled) return;
    // T0 = f32 bits of the widened value.
    wb.op_local_get(val_local);
    wb.op_f64_reinterpret_i64();
    wb.op_f32_demote_f64();
    wb.op_i32_reinterpret_f32();
    wb.op_local_set(LOCAL_FP_T0);            // T0 = f32 bits
    // exp = bits & 0x7F800000  -> T1
    wb.op_local_get(LOCAL_FP_T0);
    wb.op_i32_const(0x7F800000);
    wb.op_i32_and();
    wb.op_local_set(LOCAL_FP_T1);            // T1 = exp
    // sign bool: (bits & 0x80000000) != 0  — computed inline where needed.
    // Classify into an i32 code, pushed on stack.
    // if (exp != 0 && exp != 0x7F800000) -> normal
    wb.op_local_get(LOCAL_FP_T1);
    wb.op_i32_eqz();                          // exp==0
    wb.op_local_get(LOCAL_FP_T1);
    wb.op_i32_const(0x7F800000);
    wb.op_i32_eq();                           // exp==0x7F800000
    wb.op_i32_or();                           // exp==0 || exp==max  (=="edge")
    wb.op_if(0x7F /*i32 result*/);
    {
        // edge: mantissa?
        wb.op_local_get(LOCAL_FP_T0);
        wb.op_i32_const(0x007FFFFF);
        wb.op_i32_and();                      // mantissa
        wb.op_if(0x7F /*i32*/);
        {
            // mantissa != 0
            wb.op_local_get(LOCAL_FP_T1);     // exp
            wb.op_if(0x7F /*i32*/);
            {
                wb.op_i32_const(0x11);        // QNAN (exp!=0 -> NaN)
            }
            wb.op_else();
            {
                // denormal: sign ? ND(0x18) : PD(0x14)
                // select = cond ? a : b  (stack [a, b, cond]); cond=sign.
                wb.op_i32_const(0x18);        // a = ND (sign set)
                wb.op_i32_const(0x14);        // b = PD (sign clear)
                wb.op_local_get(LOCAL_FP_T0);
                wb.op_i32_const((s32)0x80000000);
                wb.op_i32_and();              // cond = sign bits
                wb.op_select();
            }
            wb.op_end();
        }
        wb.op_else();
        {
            // mantissa == 0
            wb.op_local_get(LOCAL_FP_T1);     // exp
            wb.op_if(0x7F /*i32*/);
            {
                // infinite: sign ? NINF(0x9) : PINF(0x5)
                wb.op_i32_const(0x9);         // a = NINF
                wb.op_i32_const(0x5);         // b = PINF
                wb.op_local_get(LOCAL_FP_T0);
                wb.op_i32_const((s32)0x80000000);
                wb.op_i32_and();
                wb.op_select();
            }
            wb.op_else();
            {
                // zero: sign ? NZ(0x12) : PZ(0x2)
                wb.op_i32_const(0x12);        // a = NZ
                wb.op_i32_const(0x2);         // b = PZ
                wb.op_local_get(LOCAL_FP_T0);
                wb.op_i32_const((s32)0x80000000);
                wb.op_i32_and();
                wb.op_select();
            }
            wb.op_end();
        }
        wb.op_end();
    }
    wb.op_else();
    {
        // normal: sign ? NN(0x8) : PN(0x4)
        wb.op_i32_const(0x8);                 // a = NN
        wb.op_i32_const(0x4);                 // b = PN
        wb.op_local_get(LOCAL_FP_T0);
        wb.op_i32_const((s32)0x80000000);
        wb.op_i32_and();
        wb.op_select();
    }
    wb.op_end();
    // stack: [fprf_code].  Write FPSCR = (FPSCR & ~0x1F000) | (code << 12).
    wb.op_i32_const(12);
    wb.op_i32_shl();
    wb.op_local_set(LOCAL_FP_T0);            // T0 = code<<12
    wb.op_i32_const((s32)ctx_ptr);           // addr for store
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load(ppc_off::FPSCR);
    wb.op_i32_const((s32)~0x1F000);
    wb.op_i32_and();
    wb.op_local_get(LOCAL_FP_T0);
    wb.op_i32_or();
    wb.op_i32_store(ppc_off::FPSCR);
}

// [C8] NaN-safe negate for fnmadd/fnmsub/ps_nmadd/ps_nmsub — Interpreter uses
// std::isnan(tmp) ? tmp : -tmp (Interpreter_FloatingPoint.cpp:654,677,700,723;
// Interpreter_Paired.cpp:314-315). f64 VALUE on stack -> (isnan ? value :
// -value). Uses wasm `select` (cond ? a : b with stack [a, b, cond]) so no
// operand is left live across a branch.
inline void emit_nan_safe_neg(WasmModuleBuilder& wb) {
    wb.op_local_set(LOCAL_FMA_TMP);
    // select(value, -value, isnan) : select pops (a, b, cond) -> cond?a:b
    wb.op_local_get(LOCAL_FMA_TMP);           // a = value (kept when NaN)
    wb.op_local_get(LOCAL_FMA_TMP);
    wb.op_f64_neg();                          // b = -value
    wb.op_local_get(LOCAL_FMA_TMP);
    wb.op_local_get(LOCAL_FMA_TMP);
    wb.op_f64_ne();                           // cond = isnan(value)
    wb.op_select();
}

// ===========================================================================
// [C2+C3+C8+C10] Single-precision fused-multiply-add for ONE lane. Reads the
// i64 FPR-cache locals a_local, c_local, b_local; runs Force25Bit(c) + fused
// std::fma + tie-correction (emit_fma_core single) + NaN ladder + ForceSingle
// + optional NaN-safe negate (nmadd/nmsub), and writes the widened i64 result
// into d_local. Shared by ps_madd/msub/nmadd/nmsub and ps_madds0/1.
//   sub    -> msub/nmsub (b_sign = -b)
//   negate -> nmadd/nmsub (isnan(tmp)?tmp:-tmp AFTER ForceSingle)
// Verified 0 mismatches vs NI_madd_msub<single> + ForceSingle over 7.9e8.
// ===========================================================================
inline void emit_single_fma_lane(WasmModuleBuilder& wb, u32 a_local, u32 c_local,
                                 u32 b_local, u32 d_local, bool sub, bool negate,
                                 u32 ctx_ptr) {
    // [fma-single-fast PM24] Runtime shortcut for f32-VALUED inputs (the THP
    // IDCT scalar fall-off: psq_l coefficients x lfs constants held as
    // Doubles): the f64 product of two f32-valued doubles is EXACT (24x24 <=
    // 53 mantissa bits), so fma(a, Force25Bit(c), +-b) == f64.mul + f64.add
    // BY CONSTRUCTION — Force25Bit is a no-op on <=24-bit mantissas, the
    // exact product makes fused == unfused (one rounding either way), and the
    // ForceSingle two-step (round_f64 then round_f32) is the interpreter's
    // own sequence. Guard: each input survives an f32 round-trip (NaN inputs
    // fail x==x and fall through); NaN RESULTS (inf*0, inf-inf) also fall to
    // the full pipeline so the NaN ladder / FPSCR semantics are byte-identical
    // there. Fast arm ~70 executed ops vs ~600-900 for the pipeline.
    // Scratch: LOCAL_FP_T1 (guard flag; dead at entry, freely clobbered once
    // the selecting `if` has consumed it), LOCAL_FMA_RES (f64 sum).
    auto push_f32_roundtrip_ok = [&](u32 vlocal) {
        wb.op_local_get(vlocal);
        wb.op_f64_reinterpret_i64();
        wb.op_f32_demote_f64();
        wb.op_f64_promote_f32();
        wb.op_local_get(vlocal);
        wb.op_f64_reinterpret_i64();
        wb.op_f64_eq();
    };
    // [exact-fma lever 2026-10-04] THE PM24 ARM BELOW IS NOT EXACT. Dolphin's
    // own motivating case (Interpreter_FPUtils.h:356-370, Mario Strikers
    // Charged: a=0x42480000 c=0xbc88cc38 b=0x1b1c72a0 — all three f32-valued,
    // so PM24's guard ADMITS it) gives 0xbf55bf18 through f64.mul+f64.add+
    // demote, against the correct 0xbf55bf17 (checked 2026-10-04 with exact
    // rationals). The exact product does NOT make fused == unfused for the
    // SINGLE family: NI_madd_msub<single> tie-corrects the f64 result before
    // ForceSingle rounds it (Interpreter_FPUtils.h:425-487), and PM24 skipped
    // that step. A 2^-24-rare tie is why 7.9e8 random vectors missed it.
    //
    // The replacement arm is Dolphin's procedure transcribed with each
    // std::fma replaced by an EXACT equivalent: for f32-valued a and c,
    // Force25Bit(c) == c (low 29 fraction bits are zero, so bit 27 is zero)
    // and a*c has <= 48 significant bits with an exponent far inside f64's
    // normal range (|a*c| in [2^-298, 2^256]), so f64.mul(a, c) == a*c EXACTLY
    // and therefore
    //     std::fma(a, c_round, X) == f64.add(a*c, X)   for every X.
    // Both fma calls in NI_madd_msub<single> (the result and delta_a) take
    // that form, so the arm below is bit-identical to Dolphin for every b —
    // b need not be f32-valued, which also widens the arm's reach. NaN results
    // still demote to the full pipeline (NaN ladder / FPSCR byte-identical).
    if (bem_lever_on(BEM_LEVER_FMA_SINGLE)) {
        push_f32_roundtrip_ok(a_local);
        push_f32_roundtrip_ok(c_local);
        wb.op_i32_and();
        wb.op_local_set(LOCAL_FP_T1);
        wb.op_local_get(LOCAL_FP_T1);
        wb.op_if(/*VOID*/);
        {
            // P = a*c (exact)
            wb.op_local_get(a_local);
            wb.op_f64_reinterpret_i64();
            wb.op_local_get(c_local);
            wb.op_f64_reinterpret_i64();
            wb.op_f64_mul();
            wb.op_local_set(LOCAL_FMA_P);
            // B0 = b_sign = sub ? -b : b   (Interpreter_FPUtils.h:416)
            wb.op_local_get(b_local);
            wb.op_f64_reinterpret_i64();
            if (sub) wb.op_f64_neg();
            wb.op_local_set(LOCAL_FMA_B0);
            // RES = fma(a, c_round, b_sign) == P + B0
            wb.op_local_get(LOCAL_FMA_P);
            wb.op_local_get(LOCAL_FMA_B0);
            wb.op_f64_add();
            wb.op_local_tee(LOCAL_FMA_RES);
            wb.op_local_get(LOCAL_FMA_RES);
            wb.op_f64_ne();                          // 1 iff NaN result
            wb.op_if(/*VOID*/);
            {
                wb.op_i32_const(0);
                wb.op_local_set(LOCAL_FP_T1);        // demote to the full pipeline
            }
            wb.op_else();
            {
                // if ((bits(RES) & D_MASK) == EVEN_TIE)   (:425-431)
                wb.op_local_get(LOCAL_FMA_RES);
                wb.op_i64_reinterpret_f64();
                wb.op_i64_const(0x000000001fffffffll);
                wb.op_i64_and();
                wb.op_i64_const(0x0000000010000000ll);
                wb.op_i64_xor();
                wb.op_i64_eqz();
                wb.op_if(/*VOID*/);
                {
                    // a_prime = b_sign - RES                       (:445)
                    wb.op_local_get(LOCAL_FMA_B0);
                    wb.op_local_get(LOCAL_FMA_RES);
                    wb.op_f64_sub();
                    wb.op_local_set(LOCAL_FMA_W0);
                    // b_prime = RES + a_prime                      (:446)
                    wb.op_local_get(LOCAL_FMA_RES);
                    wb.op_local_get(LOCAL_FMA_W0);
                    wb.op_f64_add();
                    wb.op_local_set(LOCAL_FMA_W1);
                    // error = fma(a, c_round, a_prime) + (b_sign - b_prime)
                    //       = (P + a_prime) + (b_sign - b_prime)   (:447-449)
                    wb.op_local_get(LOCAL_FMA_P);
                    wb.op_local_get(LOCAL_FMA_W0);
                    wb.op_f64_add();
                    wb.op_local_get(LOCAL_FMA_B0);
                    wb.op_local_get(LOCAL_FMA_W1);
                    wb.op_f64_sub();
                    wb.op_f64_add();
                    wb.op_local_tee(LOCAL_FMA_W2);
                    wb.op_f64_const(0.0);
                    wb.op_f64_ne();
                    wb.op_if(/*VOID*/);
                    {
                        // (error > 0) == (RES > 0) ? bits+1 : bits-1   (:480-483)
                        wb.op_local_get(LOCAL_FMA_RES);
                        wb.op_i64_reinterpret_f64();
                        wb.op_i64_const(1);
                        wb.op_i64_add();
                        wb.op_local_get(LOCAL_FMA_RES);
                        wb.op_i64_reinterpret_f64();
                        wb.op_i64_const(1);
                        wb.op_i64_sub();
                        wb.op_local_get(LOCAL_FMA_W2);
                        wb.op_f64_const(0.0);
                        wb.op_f64_gt();
                        wb.op_local_get(LOCAL_FMA_RES);
                        wb.op_f64_const(0.0);
                        wb.op_f64_gt();
                        wb.op_i32_eq();
                        wb.op_select();
                        wb.op_f64_reinterpret_i64();
                        wb.op_local_set(LOCAL_FMA_RES);
                    }
                    wb.op_end();
                }
                wb.op_end();
            }
            wb.op_end();
        }
        wb.op_end();
    } else {
    push_f32_roundtrip_ok(a_local);
    push_f32_roundtrip_ok(c_local);
    wb.op_i32_and();
    push_f32_roundtrip_ok(b_local);
    wb.op_i32_and();
    wb.op_local_set(LOCAL_FP_T1);
    wb.op_local_get(LOCAL_FP_T1);
    wb.op_if(/*VOID*/);
    {
        // RES = a*c +- b (exact-product ⇒ equals the fused result)
        wb.op_local_get(a_local);
        wb.op_f64_reinterpret_i64();
        wb.op_local_get(c_local);
        wb.op_f64_reinterpret_i64();
        wb.op_f64_mul();
        wb.op_local_get(b_local);
        wb.op_f64_reinterpret_i64();
        if (sub) wb.op_f64_sub(); else wb.op_f64_add();
        wb.op_local_tee(LOCAL_FMA_RES);
        wb.op_local_get(LOCAL_FMA_RES);
        wb.op_f64_ne();                          // 1 iff NaN result
        wb.op_if(/*VOID*/);
        {
            wb.op_i32_const(0);
            wb.op_local_set(LOCAL_FP_T1);        // demote to the full pipeline
        }
        wb.op_end();
    }
    wb.op_end();
    }  // [exact-fma lever] end of the lever-off (legacy PM24) guard arm
    wb.op_local_get(LOCAL_FP_T1);
    wb.op_if(/*VOID*/);
    {
        // Lean ForceSingle for a KNOWN-non-NaN result: stages 1-3 of
        // emit_force_single_i64 (NI flushes + demote) but the widen is a plain
        // f64.promote_f32 (bit-exact for every non-NaN) instead of the 29-op
        // NaN-payload-exact convert.
        wb.op_local_get(LOCAL_FMA_RES);
        wb.op_i64_reinterpret_f64();
        wb.op_local_set(LOCAL_FP_I64_A);
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load(ppc_off::FPSCR);
        wb.op_i32_const(4);
        wb.op_i32_and();
        wb.op_if(/*VOID*/);                      // NI pre-cast flush
        {
            wb.op_local_get(LOCAL_FP_I64_A);
            wb.op_i64_const(0x7FFFFFFFFFFFFFFFll);
            wb.op_i64_and();
            wb.op_i64_const(0x3810000000000000ll);
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
        wb.op_local_get(LOCAL_FP_I64_A);
        wb.op_f64_reinterpret_i64();
        wb.op_f32_demote_f64();
        wb.op_i32_reinterpret_f32();
        wb.op_local_set(LOCAL_FP_T0);            // f32 result BITS (i32, as :169)
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load(ppc_off::FPSCR);
        wb.op_i32_const(4);
        wb.op_i32_and();
        wb.op_if(/*VOID*/);                      // NI post-cast f32 denormal flush
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
        wb.op_local_get(LOCAL_FP_T0);
        wb.op_f32_reinterpret_i32();
        wb.op_f64_promote_f32();                 // non-NaN ⇒ bit-exact widen
        if (negate) wb.op_f64_neg();             // non-NaN ⇒ plain neg == nan-safe neg
        wb.op_i64_reinterpret_f64();
        wb.op_local_set(d_local);
    }
    wb.op_else();
    {
        emit_fma_stage(wb, a_local, c_local, b_local, /*force25_c=*/true);  // [C3]
        emit_fma_core(wb, sub, /*single=*/true);   // [C2] fused + tie-correct
        emit_nan_fixup_fma(wb);                     // [C8] NaN ladder
        emit_force_single_i64(wb, ctx_ptr);         // [C10] ForceSingle -> i64
        if (negate) {
            wb.op_f64_reinterpret_i64();
            emit_nan_safe_neg(wb);                  // [C8b] isnan(tmp)?tmp:-tmp
            wb.op_i64_reinterpret_f64();
        }
        wb.op_local_set(d_local);
    }
    wb.op_end();
}

}  // namespace powerpc
}  // namespace bemental

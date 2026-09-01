//
// cr_encode.cpp — Dolphin u64 CR-field encoding emitters.
//
// REWRITTEN 2026-05-30 to fix the sign-extension regression caught by
// the bementalJIT verification audit. See cr_encode.h header comment for
// the canonical Dolphin encoding (ConditionRegister.h:48-77) and the
// reason direct i64_extend_i32_s on a signed value is incorrect.

#include "cr_encode.h"

#include "bementalJIT/types.h"
#include "bementalJIT/wasm_module_builder.h"
#include "ppc_offsets.h"
#include "cr_shadow.h"

namespace bemental::powerpc {

// [PM56 lazy-CR] the deferred shadow + per-field pending flags (see cr_shadow.h).
extern "C" {
BemCrShadow g_bem_cr_shadow[8] = {};
uint8_t     g_bem_cr_pending[8] = {};
}

// [PM56 lazy-CR] Deferred store: park (a,b,tag,SO-snapshot) into the shadow and
// set pending[crfd]. ~11 ops vs the ~30-op eager build. b_is_imm bakes B as a
// const (cmpi/cmpli — also drops the LOCAL_TMP_IMM round-trip at the caller).
static void emit_defer_cr(WasmModuleBuilder& wb, u32 ctx_ptr, u32 crfd,
                          u32 a_local, u32 b_local, s32 b_imm, bool b_is_imm,
                          u8 tag) {
    const u32 S = (u32)(uintptr_t)&g_bem_cr_shadow[crfd];
    const u32 P = (u32)(uintptr_t)&g_bem_cr_pending[crfd];
    // shadow.a = a_local
    wb.op_i32_const((s32)S); wb.op_local_get(a_local); wb.op_i32_store(0);
    // shadow.b = b (reg or baked imm)
    wb.op_i32_const((s32)S);
    if (b_is_imm) wb.op_i32_const(b_imm); else wb.op_local_get(b_local);
    wb.op_i32_store(4);
    // shadow.tag = tag
    wb.op_i32_const((s32)S); wb.op_i32_const((s32)tag); wb.op_i32_store8(8);
    // shadow.so = (XER.SO_OV >> 1) & 1  — FREEZE SO now (produce-time value)
    wb.op_i32_const((s32)S);
    wb.op_i32_const((s32)ctx_ptr); wb.op_i32_load8_u(ppc_off::XER_SO_OV);
    wb.op_i32_const(1); wb.op_i32_shr_u();
    wb.op_i32_store8(9);
    // pending[crfd] = 1
    wb.op_i32_const((s32)P); wb.op_i32_const(1); wb.op_i32_store8(0);
}

void emit_defer_cr_reg(WasmModuleBuilder& wb, u32 ctx_ptr, u32 crfd,
                       u32 a_local, u32 b_local, u8 tag) {
    emit_defer_cr(wb, ctx_ptr, crfd, a_local, b_local, 0, /*b_is_imm=*/false, tag);
}
void emit_defer_cr_imm(WasmModuleBuilder& wb, u32 ctx_ptr, u32 crfd,
                       u32 a_local, s32 b_imm, u8 tag) {
    emit_defer_cr(wb, ctx_ptr, crfd, a_local, 0, b_imm, /*b_is_imm=*/true, tag);
}

// [PM56 lazy-CR] Reconstruct eager cr[] from the deferred shadow for every
// pending field, then clear pending. THE single source of truth for the
// deferred→eager encoding (the bridge funnel + the test harness both call
// this — no second encoding to drift). ctx_base = PowerPCState host address
// (the emitters' ctx_ptr). Must match emit_cr_from_*_pair/local exactly:
// hi32 = 1 | so<<27 | lt<<30 | (a<=b)<<31 ; lo32 = a-b (CMP) or a (RC_VS0).
extern "C" void bem_materialize_pending_cr(void* ctx_base) {
    auto* base = static_cast<unsigned char*>(ctx_base);
    for (int f = 0; f < 8; ++f) {
        if (!g_bem_cr_pending[f]) continue;
        const BemCrShadow& sh = g_bem_cr_shadow[f];
        const int32_t a = sh.a, b = sh.b;
        const uint32_t so = sh.so & 1u;
        const uint32_t kind = sh.tag & BEM_CR_KIND_MASK;
        const bool uns = (sh.tag & BEM_CR_UNSIGNED) != 0;
        bool lt, le;
        uint32_t lo;
        if (kind == BEM_CR_RC_VS0) { lt = a < 0; le = a <= 0; lo = (uint32_t)a; }
        else if (uns) { lt = (uint32_t)a < (uint32_t)b; le = (uint32_t)a <= (uint32_t)b;
                        lo = (uint32_t)a - (uint32_t)b; }
        else { lt = a < b; le = a <= b; lo = (uint32_t)a - (uint32_t)b; }
        const uint32_t hi = 1u | (so << 27) | ((uint32_t)lt << 30) | ((uint32_t)le << 31);
        *reinterpret_cast<uint64_t*>(base + ppc_off::cr((u32)f)) =
            ((uint64_t)hi << 32) | (uint64_t)lo;
        g_bem_cr_pending[f] = 0;
    }
}

// [PM56 lazy-CR] Clear pending[crfd] — every EAGER CR writer that survives
// (Rc-form ops still calling emit_cr0_from_local; interp SetField is covered by
// the host materialize) MUST call this so a stale pending flag can't make a
// later consumer read the shadow instead of the freshly-written eager cr[].
static void emit_clear_cr_pending(WasmModuleBuilder& wb, u32 crfd) {
    const u32 P = (u32)(uintptr_t)&g_bem_cr_pending[crfd];
    wb.op_i32_const((s32)P); wb.op_i32_const(0); wb.op_i32_store8(0);
}

// Helper (file-local, inlined at emit time): push the "high32" word of
// the CR encoding onto the wasm stack as an i32. Caller is responsible
// for promoting it to i64, shifting left 32, and OR-ing the low 32 bits.
//
// high32 bit layout (matches ConditionRegister.h PPCToInternal):
//   bit  0  = 1                            (always-set marker: bit 32 of u64)
//   bit 27  = XER.SO & 1                   (bit 59 of u64 — SO)
//   bit 30  = lt_bit                       (bit 62 of u64 — LT)
//   bit 31  = not_gt_bit                   (bit 63 of u64 — NOT GT)
//
// lt_emit and not_gt_emit are callable lambdas that push their single-bit
// i32 result onto the stack. Both are evaluated AFTER the prior bit OR
// is on the stack, so they must be self-contained (no leftover values).
template <typename LtEmit, typename NotGtEmit>
static void emit_cr_high32_into_stack(WasmModuleBuilder& wb, u32 ctx_ptr,
                                      LtEmit&& lt_emit, NotGtEmit&& not_gt_emit) {
    // Start with the always-set marker (bit 0).
    wb.op_i32_const(1);

    // OR in (XER.SO & 1) << 27.
    // XER_SO_OV byte layout: bit 1 = SO, bit 0 = OV. Right-shift by 1 to
    // isolate SO into bit 0 before the << 27 positions it at CR.SO.
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load8_u(ppc_off::XER_SO_OV);
    wb.op_i32_const(1);
    wb.op_i32_shr_u();
    wb.op_i32_const(27);
    wb.op_i32_shl();
    wb.op_i32_or();

    // OR in lt_bit << 30.
    lt_emit();
    wb.op_i32_const(30);
    wb.op_i32_shl();
    wb.op_i32_or();

    // OR in not_gt_bit << 31.
    not_gt_emit();
    wb.op_i32_const(31);
    wb.op_i32_shl();
    wb.op_i32_or();
}

// Helper: given high32 on the wasm stack as i32, fold in low32 (also
// emitted by `low_emit`) and produce the full i64 CR-field value on the
// stack, ready to be consumed by i64.store.
template <typename LowEmit>
static void fold_high32_low32_into_i64(WasmModuleBuilder& wb,
                                       LowEmit&& low_emit) {
    // Promote high32 to i64 and shift left 32.
    wb.op_i64_extend_i32_u();
    wb.op_i64_const(32);
    wb.op_i64_shl();
    // Push low32, zero-extend, OR.
    low_emit();
    wb.op_i64_extend_i32_u();
    wb.op_i64_or();
}

void emit_cr_from_signed_local(WasmModuleBuilder& wb, u32 ctx_ptr,
                               u32 crfd, u32 value_local) {
    // i64.store wants [i32 addr, i64 value] on the stack.
    wb.op_i32_const((s32)ctx_ptr);

    // high32 = 1 | (XER.SO & 1)<<27 | (value>>31 u)<<30 | (value<=0 s)<<31
    emit_cr_high32_into_stack(
        wb, ctx_ptr,
        // LT bit: sign bit of `value` (unsigned shift to isolate bit 31)
        [&] {
            wb.op_local_get(value_local);
            wb.op_i32_const(31);
            wb.op_i32_shr_u();
        },
        // NOT-GT bit: (value <= 0 signed)
        [&] {
            wb.op_local_get(value_local);
            wb.op_i32_const(0);
            wb.op_i32_le_s();
        });

    // low32 = value
    fold_high32_low32_into_i64(wb, [&] {
        wb.op_local_get(value_local);
    });

    wb.op_i64_store(ppc_off::cr(crfd));
}

void emit_cr_from_signed_pair(WasmModuleBuilder& wb, u32 ctx_ptr,
                              u32 crfd, u32 a_local, u32 b_local) {
    // i64.store wants [i32 addr, i64 value] on the stack.
    wb.op_i32_const((s32)ctx_ptr);

    // high32 = 1 | (XER.SO & 1)<<27 | (a<b s)<<30 | (a<=b s)<<31
    emit_cr_high32_into_stack(
        wb, ctx_ptr,
        // LT bit: signed less-than
        [&] {
            wb.op_local_get(a_local);
            wb.op_local_get(b_local);
            wb.op_i32_lt_s();
        },
        // NOT-GT bit: signed less-than-or-equal
        [&] {
            wb.op_local_get(a_local);
            wb.op_local_get(b_local);
            wb.op_i32_le_s();
        });

    // low32 = a - b  (zero iff a == b for any two i32 operands; subtraction
    // wraps on overflow but never lands at 0 unless a == b modulo 2^32).
    fold_high32_low32_into_i64(wb, [&] {
        wb.op_local_get(a_local);
        wb.op_local_get(b_local);
        wb.op_i32_sub();
    });

    wb.op_i64_store(ppc_off::cr(crfd));
}

void emit_cr_from_unsigned_pair(WasmModuleBuilder& wb, u32 ctx_ptr,
                                u32 crfd, u32 a_local, u32 b_local) {
    // i64.store wants [i32 addr, i64 value] on the stack.
    wb.op_i32_const((s32)ctx_ptr);

    // high32 = 1 | (XER.SO & 1)<<27 | (a<b u)<<30 | (a<=b u)<<31
    emit_cr_high32_into_stack(
        wb, ctx_ptr,
        // LT bit: unsigned less-than
        [&] {
            wb.op_local_get(a_local);
            wb.op_local_get(b_local);
            wb.op_i32_lt_u();
        },
        // NOT-GT bit: unsigned less-than-or-equal
        [&] {
            wb.op_local_get(a_local);
            wb.op_local_get(b_local);
            wb.op_i32_le_u();
        });

    // low32 = a - b  (zero iff a == b)
    fold_high32_low32_into_i64(wb, [&] {
        wb.op_local_get(a_local);
        wb.op_local_get(b_local);
        wb.op_i32_sub();
    });

    wb.op_i64_store(ppc_off::cr(crfd));
}

void emit_cr0_from_local(WasmModuleBuilder& wb, u32 ctx_ptr,
                         u32 value_local) {
    // [PM56 lazy-CR Stage 6a] gated: defer (RC_VS0) when lazy-CR is on, else
    // the eager build (shipping default). See BEM_LAZY_CR in cr_shadow.h.
    if (BEM_LAZY_CR) {
        emit_defer_cr(wb, ctx_ptr, 0, value_local, /*b_local=*/0, /*b_imm=*/0,
                      /*b_is_imm=*/false, BEM_CR_RC_VS0);
    } else {
        emit_cr_from_signed_local(wb, ctx_ptr, 0, value_local);
    }
    (void)&emit_clear_cr_pending;  // retained for the adjacent-fusion follow-up
}

}  // namespace bemental::powerpc

//
// cr_encode.cpp — Dolphin u64 CR-field encoding emitters.

#include "cr_encode.h"

#include "bementalJIT/types.h"
#include "bementalJIT/wasm_module_builder.h"
#include "ppc_offsets.h"

namespace bemental::powerpc {

void emit_cr_from_signed_local(WasmModuleBuilder& wb, u32 ctx_ptr,
                               u32 crfd, u32 value_local) {
    // i64.store wants [i32 addr, i64 value] on the stack.
    wb.op_i32_const((s32)ctx_ptr);

    // Build i64 CR value:
    //   sign_extend(value_local) | (XER.SO_bit << 59)
    wb.op_local_get(value_local);
    wb.op_i64_extend_i32_s();

    // SO portion:
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load8_u(ppc_off::XER_SO_OV);
    wb.op_i32_const(1);
    wb.op_i32_and();
    wb.op_i64_extend_i32_u();
    wb.op_i64_const(59);
    wb.op_i64_shl();

    wb.op_i64_or();

    wb.op_i64_store(ppc_off::cr(crfd));
}

void emit_cr_from_unsigned_pair(WasmModuleBuilder& wb, u32 ctx_ptr,
                                u32 crfd, u32 a_local, u32 b_local) {
    wb.op_i32_const((s32)ctx_ptr);

    // Trichotomy i32: (a>b)_u - (a<b)_u  ∈ {-1, 0, 1}
    wb.op_local_get(a_local);
    wb.op_local_get(b_local);
    wb.op_i32_gt_u();
    wb.op_local_get(a_local);
    wb.op_local_get(b_local);
    wb.op_i32_lt_u();
    wb.op_i32_sub();

    wb.op_i64_extend_i32_s();

    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load8_u(ppc_off::XER_SO_OV);
    wb.op_i32_const(1);
    wb.op_i32_and();
    wb.op_i64_extend_i32_u();
    wb.op_i64_const(59);
    wb.op_i64_shl();

    wb.op_i64_or();

    wb.op_i64_store(ppc_off::cr(crfd));
}

void emit_cr0_from_local(WasmModuleBuilder& wb, u32 ctx_ptr,
                         u32 value_local) {
    emit_cr_from_signed_local(wb, ctx_ptr, 0, value_local);
}

}  // namespace bemental::powerpc

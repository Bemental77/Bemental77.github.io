//
// jit_compare.cpp — Phase 4.5 compare ops with native CR-field setting.
//
// REWRITTEN 2026-05-30: the prior signed-compare path computed
// (ra - rb_or_simm) as i32 then passed the difference to
// emit_cr_from_signed_local. That subtraction OVERFLOWS for operands
// straddling the s32 boundary (e.g. cmpi ra=0x80000000, simm=1 →
// diff=0x7FFFFFFF reports GT when correct PPC semantics give LT). Now
// uses emit_cr_from_signed_pair which compares operands directly.
//
// Signed compares (cmp/cmpi): stash the second operand in a scratch
// local if needed (cmpi's SIMM_16 → LOCAL_TMP_IMM), then call
// emit_cr_from_signed_pair(ra_local, b_local).
//
// Unsigned compares (cmpl/cmpli): same shape but emit_cr_from_unsigned_pair.

#include "jit_compare.h"

#include "bementalJIT/types.h"
#include "bementalJIT/wasm_module_builder.h"
#include "code_op.h"
#include "cr_encode.h"
#include "ppc_analyst.h"
#include "reg_cache.h"

namespace bemental::powerpc {

static constexpr u32 LOCAL_TMP_DIFF = 0;  // shared with LOCAL_TMP_EA
static constexpr u32 LOCAL_TMP_IMM  = 1;  // shared with LOCAL_TMP_VAL

void emit_cmpi(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
               u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 crfd = GekkoOperands::CRFD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    auto rc_ra = rc.Bind(ra, RCMode::Read);
    // Stash SIMM (sign-extended to i32 by GekkoOperands::SIMM_16) in a
    // scratch local so the signed-pair helper can read it as a local.
    wb.op_i32_const((s32)simm);
    wb.op_local_set(LOCAL_TMP_IMM);

    emit_cr_from_signed_pair(wb, ctx_ptr, crfd, rc_ra.local_idx(),
                             LOCAL_TMP_IMM);
}

void emit_cmpli(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 crfd = GekkoOperands::CRFD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 uimm = GekkoOperands::UIMM_16(inst);

    auto rc_ra = rc.Bind(ra, RCMode::Read);
    // Stash UIMM in a scratch local so the unsigned-pair helper can read it.
    wb.op_i32_const((s32)uimm);
    wb.op_local_set(LOCAL_TMP_IMM);

    emit_cr_from_unsigned_pair(wb, ctx_ptr, crfd, rc_ra.local_idx(),
                               LOCAL_TMP_IMM);
}

void emit_cmp(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
              u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 crfd = GekkoOperands::CRFD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);

    auto rc_ra = rc.Bind(ra, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);

    emit_cr_from_signed_pair(wb, ctx_ptr, crfd, rc_ra.local_idx(),
                             rc_rb.local_idx());
}

void emit_cmpl(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
               u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 crfd = GekkoOperands::CRFD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);

    auto rc_ra = rc.Bind(ra, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);

    emit_cr_from_unsigned_pair(wb, ctx_ptr, crfd, rc_ra.local_idx(),
                               rc_rb.local_idx());
}

}  // namespace bemental::powerpc

//
// jit_compare.cpp — Phase 4.5 compare ops with native CR-field setting.
//
// Signed compares (cmp/cmpi): compute (ra - simm_or_rb) as i32, write to
// a scratch local, then call emit_cr_from_signed_local — which sign-extends
// to i64 and stores the Dolphin u64 CR encoding.
//
// Unsigned compares (cmpl/cmpli): call emit_cr_from_unsigned_pair directly
// — it builds the trichotomy {-1, 0, +1} from u32 lt/gt compares and
// sign-extends. For cmpli, we need the immediate in a local; use
// LOCAL_TMP_VAL (scratch slot 1).

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
    // diff = ra - simm  (signed-compare i32)
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_const((s32)simm);
    wb.op_i32_sub();
    wb.op_local_set(LOCAL_TMP_DIFF);

    emit_cr_from_signed_local(wb, ctx_ptr, crfd, LOCAL_TMP_DIFF);
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

    // diff = ra - rb (signed-compare)
    wb.op_local_get(rc_ra.local_idx());
    wb.op_local_get(rc_rb.local_idx());
    wb.op_i32_sub();
    wb.op_local_set(LOCAL_TMP_DIFF);

    emit_cr_from_signed_local(wb, ctx_ptr, crfd, LOCAL_TMP_DIFF);
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

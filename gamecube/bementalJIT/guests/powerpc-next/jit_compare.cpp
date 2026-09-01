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
#include "cr_shadow.h"
#include "ppc_offsets.h"   // [PM62] ppc_off::cr for native CR-logical
#include "fpr_reg_cache.h"
#include "ppc_analyst.h"
#include "reg_cache.h"

namespace bemental::powerpc {

static constexpr u32 LOCAL_TMP_DIFF = 0;  // shared with LOCAL_TMP_EA
static constexpr u32 LOCAL_TMP_IMM  = 1;  // shared with LOCAL_TMP_VAL

void emit_cmpi(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
               u32 ctx_ptr, CmpFuse* fuse) {
    const u32 inst = op.inst;
    const u32 crfd = GekkoOperands::CRFD(inst);
    if (op.crDiscardable[crfd]) return;  // CR field dead — skip the compare
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    auto rc_ra = rc.Bind(ra, RCMode::Read);
    if (BEM_LAZY_CR) {
        emit_defer_cr_imm(wb, ctx_ptr, crfd, rc_ra.local_idx(), (s32)simm,
                          BEM_CR_CMP_IMM);
        if (fuse) { fuse->valid = true; fuse->age = 0; fuse->crfd = crfd;
                    fuse->a_local = rc_ra.local_idx(); fuse->imm = (s32)simm;
                    fuse->is_imm = true; fuse->is_signed = true; }
    } else {
        wb.op_i32_const((s32)simm);
        wb.op_local_set(LOCAL_TMP_IMM);
        emit_cr_from_signed_pair(wb, ctx_ptr, crfd, rc_ra.local_idx(),
                                 LOCAL_TMP_IMM);
    }
}

void emit_cmpli(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr, CmpFuse* fuse) {
    const u32 inst = op.inst;
    const u32 crfd = GekkoOperands::CRFD(inst);
    if (op.crDiscardable[crfd]) return;
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 uimm = GekkoOperands::UIMM_16(inst);

    auto rc_ra = rc.Bind(ra, RCMode::Read);
    if (BEM_LAZY_CR) {
        emit_defer_cr_imm(wb, ctx_ptr, crfd, rc_ra.local_idx(), (s32)uimm,
                          BEM_CR_CMP_IMM | BEM_CR_UNSIGNED);
        if (fuse) { fuse->valid = true; fuse->age = 0; fuse->crfd = crfd;
                    fuse->a_local = rc_ra.local_idx(); fuse->imm = (s32)uimm;
                    fuse->is_imm = true; fuse->is_signed = false; }
    } else {
        wb.op_i32_const((s32)uimm);
        wb.op_local_set(LOCAL_TMP_IMM);
        emit_cr_from_unsigned_pair(wb, ctx_ptr, crfd, rc_ra.local_idx(),
                                   LOCAL_TMP_IMM);
    }
}

void emit_cmp(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
              u32 ctx_ptr, CmpFuse* fuse) {
    const u32 inst = op.inst;
    const u32 crfd = GekkoOperands::CRFD(inst);
    if (op.crDiscardable[crfd]) return;
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);

    auto rc_ra = rc.Bind(ra, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);
    if (BEM_LAZY_CR) {
        emit_defer_cr_reg(wb, ctx_ptr, crfd, rc_ra.local_idx(), rc_rb.local_idx(),
                          BEM_CR_CMP_REG);
        if (fuse) { fuse->valid = true; fuse->age = 0; fuse->crfd = crfd;
                    fuse->a_local = rc_ra.local_idx(); fuse->b_local = rc_rb.local_idx();
                    fuse->is_imm = false; fuse->is_signed = true; }
    } else {
        emit_cr_from_signed_pair(wb, ctx_ptr, crfd, rc_ra.local_idx(),
                                 rc_rb.local_idx());
    }
}

void emit_cmpl(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
               u32 ctx_ptr, CmpFuse* fuse) {
    const u32 inst = op.inst;
    const u32 crfd = GekkoOperands::CRFD(inst);
    if (op.crDiscardable[crfd]) return;
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);

    auto rc_ra = rc.Bind(ra, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);
    if (BEM_LAZY_CR) {
        emit_defer_cr_reg(wb, ctx_ptr, crfd, rc_ra.local_idx(), rc_rb.local_idx(),
                          BEM_CR_CMP_REG | BEM_CR_UNSIGNED);
        if (fuse) { fuse->valid = true; fuse->age = 0; fuse->crfd = crfd;
                    fuse->a_local = rc_ra.local_idx(); fuse->b_local = rc_rb.local_idx();
                    fuse->is_imm = false; fuse->is_signed = false; }
    } else {
        emit_cr_from_unsigned_pair(wb, ctx_ptr, crfd, rc_ra.local_idx(),
                                   rc_rb.local_idx());
    }
}

// [PM62 2026-08-05] op19 CR-logical family (crand/crandc/creqv/crnand/crnor/
// cror/crorc/crxor) — native, ported from the proven gekko emit_crlogic_common
// (guests/powerpc/gekko_emit.cpp:4651). Board profile: 8.9M interp fallbacks,
// dominated by cror (the fcmp+cror compound-branch idiom that pairs with the
// now-native fcmpu). SAME packed CR encoding as cr_encode.cpp (LT=hi bit30,
// GT=bit31-clear, EQ=lo==0, SO=hi bit27, marker bit0=1) — reads/writes cr[]
// eagerly (BEM_LAZY_CR=false, so a prior cmp/fcmpu already wrote cr[]). mcrf
// (sub 0, a whole-field copy) is NOT routed here — stays on the interp path.

// Push 0/1 for PPC CR bit crb (0-31; in-field 0=LT,1=GT,2=EQ,3=SO).
static void emit_cr_read_bit(WasmModuleBuilder& wb, u32 ctx_ptr, u32 crb) {
    const u32 f = crb >> 2, w = crb & 3;
    switch (w) {
      case 0:   // LT = hi bit30
        wb.op_i32_const((s32)ctx_ptr); wb.op_i32_load(ppc_off::cr(f) + 4);
        wb.op_i32_const(30); wb.op_i32_shr_u(); wb.op_i32_const(1); wb.op_i32_and();
        break;
      case 1:   // GT = (hi bit31 clear) AND (field != 0)
        wb.op_i32_const((s32)ctx_ptr); wb.op_i32_load(ppc_off::cr(f) + 4);
        wb.op_i32_const((s32)0x80000000); wb.op_i32_and(); wb.op_i32_eqz();
        wb.op_i32_const((s32)ctx_ptr); wb.op_i32_load(ppc_off::cr(f) + 4);
        wb.op_i32_const((s32)ctx_ptr); wb.op_i32_load(ppc_off::cr(f));
        wb.op_i32_or(); wb.op_i32_eqz(); wb.op_i32_eqz();
        wb.op_i32_and();
        break;
      case 2:   // EQ = lo == 0
        wb.op_i32_const((s32)ctx_ptr); wb.op_i32_load(ppc_off::cr(f));
        wb.op_i32_eqz();
        break;
      default:  // SO = hi bit27
        wb.op_i32_const((s32)ctx_ptr); wb.op_i32_load(ppc_off::cr(f) + 4);
        wb.op_i32_const(27); wb.op_i32_shr_u(); wb.op_i32_const(1); wb.op_i32_and();
        break;
    }
}

void emit_cr_logic(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                   const CodeOp& op, u32 ctx_ptr) {
    (void)rc; (void)frc;
    const u32 inst = op.inst;
    const u32 xo = GekkoOperands::SUBOP10(inst);
    const u32 bd = GekkoOperands::RD(inst), ba = GekkoOperands::RA(inst),
              bb = GekkoOperands::RB(inst);
    // v = f(bitA, bitB) -> TMP (local LOCAL_TMP_DIFF)
    emit_cr_read_bit(wb, ctx_ptr, ba);
    emit_cr_read_bit(wb, ctx_ptr, bb);
    switch (xo) {
      case 257: wb.op_i32_and(); break;                                        // crand
      case 129: wb.op_i32_const(1); wb.op_i32_xor(); wb.op_i32_and(); break;   // crandc a&~b
      case 289: wb.op_i32_xor(); wb.op_i32_const(1); wb.op_i32_xor(); break;   // creqv
      case 225: wb.op_i32_and(); wb.op_i32_const(1); wb.op_i32_xor(); break;   // crnand
      case 33:  wb.op_i32_or();  wb.op_i32_const(1); wb.op_i32_xor(); break;   // crnor
      case 449: wb.op_i32_or(); break;                                         // cror
      case 417: wb.op_i32_const(1); wb.op_i32_xor(); wb.op_i32_or(); break;    // crorc a|~b
      default:  wb.op_i32_xor(); break;                                        // 193 crxor
    }
    wb.op_local_set(LOCAL_TMP_DIFF);
    // Build nib of bd's field (b0=SO b1=EQ b2=GT b3=LT), override target bit.
    const u32 fd = bd >> 2, wd = bd & 3;
    emit_cr_read_bit(wb, ctx_ptr, (fd << 2) | 3u);                 // SO
    emit_cr_read_bit(wb, ctx_ptr, (fd << 2) | 2u);                 // EQ
    wb.op_i32_const(1); wb.op_i32_shl(); wb.op_i32_or();
    emit_cr_read_bit(wb, ctx_ptr, (fd << 2) | 1u);                 // GT
    wb.op_i32_const(2); wb.op_i32_shl(); wb.op_i32_or();
    emit_cr_read_bit(wb, ctx_ptr, (fd << 2) | 0u);                 // LT
    wb.op_i32_const(3); wb.op_i32_shl(); wb.op_i32_or();
    const u32 nb = 3u - wd;                                        // nib index of BT
    wb.op_i32_const((s32)~(1u << nb)); wb.op_i32_and();
    wb.op_local_get(LOCAL_TMP_DIFF);
    if (nb != 0u) { wb.op_i32_const((s32)nb); wb.op_i32_shl(); }
    wb.op_i32_or();
    wb.op_local_set(LOCAL_TMP_IMM);                                // nib -> TMP_IMM
    // lo = EQ ? 0 : 1  = ((nib>>1)&1)^1
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(LOCAL_TMP_IMM); wb.op_i32_const(1); wb.op_i32_shr_u();
    wb.op_i32_const(1); wb.op_i32_and(); wb.op_i32_const(1); wb.op_i32_xor();
    wb.op_i32_store(ppc_off::cr(fd));
    // hi = marker1 | SO<<27 | LT<<30 | (!GT)<<31
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(LOCAL_TMP_IMM); wb.op_i32_const(1); wb.op_i32_and();     // SO (nib b0)
    wb.op_i32_const(27); wb.op_i32_shl();
    wb.op_local_get(LOCAL_TMP_IMM); wb.op_i32_const(3); wb.op_i32_shr_u();   // LT (nib b3)
    wb.op_i32_const(1); wb.op_i32_and();
    wb.op_i32_const(30); wb.op_i32_shl(); wb.op_i32_or();
    wb.op_local_get(LOCAL_TMP_IMM); wb.op_i32_const(2); wb.op_i32_shr_u();   // GT (nib b2)
    wb.op_i32_const(1); wb.op_i32_and(); wb.op_i32_const(1); wb.op_i32_xor(); // !GT
    wb.op_i32_const(31); wb.op_i32_shl(); wb.op_i32_or();
    wb.op_i32_const(1); wb.op_i32_or();                            // marker
    wb.op_i32_store(ppc_off::cr(fd) + 4);
}

}  // namespace bemental::powerpc

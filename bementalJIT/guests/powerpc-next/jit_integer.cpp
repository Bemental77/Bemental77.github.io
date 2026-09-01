//
// jit_integer.cpp — Phase 4 integer emitters. Port of the integer ops
// from Dolphin Jit64's Jit_Integer.cpp, expressed in WASM via
// WasmModuleBuilder + RegCache. The Rc-bit / CR0-update + CA-chain
// (addic./adde/subfe/srawx) + compare paths are NOT yet ported — those
// require the Dolphin u64 CR-encoding helpers and are deferred to
// Phase 4.5 so per-byte oracle parity is preserved against the live tree.

#include "jit_integer.h"

#include "bementalJIT/types.h"
#include "bementalJIT/wasm_module_builder.h"
#include "code_op.h"
#include "ppc_analyst.h"
#include "ppc_offsets.h"
#include "reg_cache.h"

namespace bemental::powerpc {

// ---------------------------------------------------------------------------
// Helper: emit "value of preg ra" — handles the RA==0-means-zero case for
// D-form ops that use FL_IN_A0 semantics (addi/addis: when RA==0, the
// literal value 0 is used, not gpr[r0]).
// ---------------------------------------------------------------------------
static void emit_ra_or_zero(WasmModuleBuilder& wb, RegCache& rc, u32 ra) {
    if (ra == 0) {
        wb.op_i32_const(0);
    } else {
        auto rc_ra = rc.Bind(ra, RCMode::Read);
        wb.op_local_get(rc_ra.local_idx());
    }
}

// ---------------------------------------------------------------------------
// D-form arithmetic immediate
// ---------------------------------------------------------------------------
void emit_addi(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    emit_ra_or_zero(wb, rc, ra);
    wb.op_i32_const((s32)simm);
    wb.op_i32_add();
    wb.op_local_set(rc_rt.local_idx());
}

void emit_addis(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    // SIMM is the upper 16 bits — UIMM_16 shifted left by 16; sign is from
    // the shifted-up value, not the 16-bit half.
    const s32 simm = (s32)(GekkoOperands::UIMM_16(inst) << 16);
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    emit_ra_or_zero(wb, rc, ra);
    wb.op_i32_const(simm);
    wb.op_i32_add();
    wb.op_local_set(rc_rt.local_idx());
}

void emit_addic(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                u32 ctx_ptr) {
    // RT = RA + SIMM; set XER.CA = (result < RA).  RA is always read (no
    // a-or-zero variant — FL_IN_A, not FL_IN_A0).
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    auto rc_rt = rc.Bind(rt, RCMode::Write);
    auto rc_ra = rc.Bind(ra, RCMode::Read);

    // result = ra + simm; written to rt local
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_const((s32)simm);
    wb.op_i32_add();
    wb.op_local_set(rc_rt.local_idx());

    // CA = (rt < ra) unsigned compare — i.e. wrap-around detected.
    // Store as u8 at PowerPCState +0x2F4 (XER_CA, per the live-tree offset
    // table in gekko_emit.h ppc_off::XER_CA).
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(rc_rt.local_idx());
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_lt_u();
    wb.op_i32_store8(0x2F4);
}

void emit_subfic(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                 u32 ctx_ptr) {
    // RT = ~RA + SIMM + 1 = SIMM - RA  (with CA on overflow detect of the
    // two-operand carry chain: CA = (carry out of (~RA + SIMM + 1))).
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    auto rc_rt = rc.Bind(rt, RCMode::Write);
    auto rc_ra = rc.Bind(ra, RCMode::Read);

    // result = simm - ra
    wb.op_i32_const((s32)simm);
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_sub();
    wb.op_local_set(rc_rt.local_idx());

    // CA = (result + ra >= simm) unsigned — i.e. did the subtract carry out.
    // Equivalent: CA = (ra <= simm) for the unsigned interpretation.
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_const((s32)simm);
    wb.op_i32_le_u();
    wb.op_i32_store8(0x2F4);
}

void emit_mulli(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    auto rc_rt = rc.Bind(rt, RCMode::Write);
    auto rc_ra = rc.Bind(ra, RCMode::Read);
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_const((s32)simm);
    wb.op_i32_mul();
    wb.op_local_set(rc_rt.local_idx());
}

// ---------------------------------------------------------------------------
// D-form logical immediate
// ---------------------------------------------------------------------------
static void emit_logical_imm_simple(WasmModuleBuilder& wb, RegCache& rc,
                                    const CodeOp& op, u32 imm_value,
                                    void (WasmModuleBuilder::*opfn)()) {
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);   // dest (RA in D-form for these)
    const u32 rs   = GekkoOperands::RS(inst);   // src
    auto rc_ra = rc.Bind(ra, RCMode::Write);
    auto rc_rs = rc.Bind(rs, RCMode::Read);
    wb.op_local_get(rc_rs.local_idx());
    wb.op_i32_const((s32)imm_value);
    (wb.*opfn)();
    wb.op_local_set(rc_ra.local_idx());
}

void emit_ori(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    const u32 uimm = GekkoOperands::UIMM_16(op.inst);
    emit_logical_imm_simple(wb, rc, op, uimm, &WasmModuleBuilder::op_i32_or);
}
void emit_oris(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    const u32 uimm = GekkoOperands::UIMM_16(op.inst) << 16;
    emit_logical_imm_simple(wb, rc, op, uimm, &WasmModuleBuilder::op_i32_or);
}
void emit_xori(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    const u32 uimm = GekkoOperands::UIMM_16(op.inst);
    emit_logical_imm_simple(wb, rc, op, uimm, &WasmModuleBuilder::op_i32_xor);
}
void emit_xoris(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    const u32 uimm = GekkoOperands::UIMM_16(op.inst) << 16;
    emit_logical_imm_simple(wb, rc, op, uimm, &WasmModuleBuilder::op_i32_xor);
}

// ---------------------------------------------------------------------------
// X-form arithmetic (op31 sub)
// ---------------------------------------------------------------------------
static void emit_binop_x(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                         void (WasmModuleBuilder::*opfn)()) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    auto rc_ra = rc.Bind(ra, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);
    wb.op_local_get(rc_ra.local_idx());
    wb.op_local_get(rc_rb.local_idx());
    (wb.*opfn)();
    wb.op_local_set(rc_rt.local_idx());
}

void emit_addx (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    emit_binop_x(wb, rc, op, &WasmModuleBuilder::op_i32_add);
}
void emit_subfx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    // subf: RT = RB - RA  (note operand order is reversed vs Wasm sub-form).
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    auto rc_ra = rc.Bind(ra, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);
    wb.op_local_get(rc_rb.local_idx());
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_sub();
    wb.op_local_set(rc_rt.local_idx());
}
void emit_mullwx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    emit_binop_x(wb, rc, op, &WasmModuleBuilder::op_i32_mul);
}

// ---------------------------------------------------------------------------
// X-form logical (op31 sub) — bool family. RA-form dest, RS-RB source.
// ---------------------------------------------------------------------------
static void emit_boolx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                       void (WasmModuleBuilder::*opfn)()) {
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);   // dest
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    auto rc_ra = rc.Bind(ra, RCMode::Write);
    auto rc_rs = rc.Bind(rs, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);
    wb.op_local_get(rc_rs.local_idx());
    wb.op_local_get(rc_rb.local_idx());
    (wb.*opfn)();
    wb.op_local_set(rc_ra.local_idx());
}

void emit_andx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    emit_boolx(wb, rc, op, &WasmModuleBuilder::op_i32_and);
}
void emit_orx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    // Common shape: `or rA, rS, rS` = `mr rA, rS`. WASM doesn't have a
    // dedicated MOV; the redundant i32_or with two equal operands is fine
    // (Liftoff folds it; TurboFan does even better).
    emit_boolx(wb, rc, op, &WasmModuleBuilder::op_i32_or);
}
void emit_xorx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    emit_boolx(wb, rc, op, &WasmModuleBuilder::op_i32_xor);
}
void emit_norx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    // nor: RA = ~(RS | RB)
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    auto rc_ra = rc.Bind(ra, RCMode::Write);
    auto rc_rs = rc.Bind(rs, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);
    wb.op_local_get(rc_rs.local_idx());
    wb.op_local_get(rc_rb.local_idx());
    wb.op_i32_or();
    wb.op_i32_const(-1);
    wb.op_i32_xor();
    wb.op_local_set(rc_ra.local_idx());
}

// ---------------------------------------------------------------------------
// Sign-extend (op31 sub) — RA = SE(RS[0..7]) / SE(RS[0..15]).
// WASM has no signed-byte sign-extend opcode pre-bulk-memory; do it via
// shl 24 / shr_s 24 (16/16 for half).
// ---------------------------------------------------------------------------
static void emit_sign_ext(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                          u32 bit_count) {
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rs   = GekkoOperands::RS(inst);
    auto rc_ra = rc.Bind(ra, RCMode::Write);
    auto rc_rs = rc.Bind(rs, RCMode::Read);
    wb.op_local_get(rc_rs.local_idx());
    wb.op_i32_const((s32)(32 - bit_count));
    wb.op_i32_shl();
    wb.op_i32_const((s32)(32 - bit_count));
    wb.op_i32_shr_s();
    wb.op_local_set(rc_ra.local_idx());
}

void emit_extsbx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    emit_sign_ext(wb, rc, op, 8);
}
void emit_extshx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    emit_sign_ext(wb, rc, op, 16);
}

// ---------------------------------------------------------------------------
// Count leading zeros — direct WASM i32.clz mapping. PowerPC semantics
// match WASM's: cntlzw(0) == 32.
// ---------------------------------------------------------------------------
void emit_cntlzwx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rs   = GekkoOperands::RS(inst);
    auto rc_ra = rc.Bind(ra, RCMode::Write);
    auto rc_rs = rc.Bind(rs, RCMode::Read);
    wb.op_local_get(rc_rs.local_idx());
    wb.op_i32_clz();
    wb.op_local_set(rc_ra.local_idx());
}

// ---------------------------------------------------------------------------
// Shift logical — slw / srw. PowerPC handles shifts >= 32 by producing 0
// (only the low 6 bits of RB are inspected, and bit 5 forces the result
// to 0). Implement via guard: if (rb & 0x20) result = 0; else shift.
// ---------------------------------------------------------------------------
static void emit_shiftx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                        void (WasmModuleBuilder::*opfn)(),
                        u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);   // dest
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    auto rc_ra = rc.Bind(ra, RCMode::Write);
    auto rc_rs = rc.Bind(rs, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);

    // result = (rb & 0x20) ? 0 : (rs <<|>> (rb & 0x1F))
    wb.op_local_get(rc_rb.local_idx());
    wb.op_i32_const(0x20);
    wb.op_i32_and();
    wb.op_i32_eqz();  // 1 when bit 5 of rb is 0 → "do the shift"

    // RegCache is fine to leave dirty across this branch — RC.EmitIf takes
    // care of flush, but we don't use it because the if has an i32 result.
    // Instead: emit op_if with i32 result type and ensure both arms produce
    // an i32. (No additional Flush needed — we're not changing PowerPCState
    // in either arm beyond the rc_ra local.)
    rc.Flush(ctx_ptr);  // stack-neutral; condition stays atop stack
    wb.op_if(/*BLOCK_TYPE_I32=*/0x7F);
    wb.op_local_get(rc_rs.local_idx());
    wb.op_local_get(rc_rb.local_idx());
    wb.op_i32_const(0x1F);
    wb.op_i32_and();
    (wb.*opfn)();
    wb.op_else();
    wb.op_i32_const(0);
    wb.op_end();
    wb.op_local_set(rc_ra.local_idx());
}

void emit_slwx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    // ctx_ptr=0 — Flush is conservative and stack-neutral; for shifts no
    // PowerPCState side effect.
    emit_shiftx(wb, rc, op, &WasmModuleBuilder::op_i32_shl, 0);
}
void emit_srwx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    emit_shiftx(wb, rc, op, &WasmModuleBuilder::op_i32_shr_u, 0);
}

// ---------------------------------------------------------------------------
// Rotate / mask helpers. PowerPC bit-numbering: MSB=0 LSB=31. Mask
// construction from (MB, ME):
//   if MB <= ME: mask has bits [MB..ME] set (in PPC numbering)
//   if MB >  ME: mask has bits [0..ME] | [MB..31] set (wrapping)
// In LSB-zero (WASM/host) terms: PPC bit N == host bit (31-N). So PPC
// mask [MB..ME] == host mask [(31-ME)..(31-MB)].
// ---------------------------------------------------------------------------
static constexpr u32 make_ppc_mask(u32 mb, u32 me) {
    // mb/me are PPC bit positions (MSB=0). Convert to host LSB-zero.
    const u32 host_lo = 31u - me;  // lower bound (inclusive) in host
    const u32 host_hi = 31u - mb;  // upper bound (inclusive) in host
    if (mb <= me) {
        // contiguous mask in host bits [host_lo..host_hi]
        const u32 width = host_hi - host_lo + 1u;
        const u32 m = (width >= 32u) ? 0xFFFFFFFFu : ((1u << width) - 1u);
        return m << host_lo;
    }
    // wrapping mask = inverted contiguous gap. PPC says: bits [0..ME] |
    // [MB..31] are set. In host bits, that's [host_lo..31] | [0..host_hi]
    // — i.e. NOT bits [(host_hi+1)..(host_lo-1)].
    const u32 gap_lo = host_hi + 1u;
    const u32 gap_hi = host_lo - 1u;
    const u32 gap_width = gap_hi - gap_lo + 1u;
    const u32 gap = ((1u << gap_width) - 1u) << gap_lo;
    return ~gap;
}

void emit_rlwinmx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    // rlwinm: RA = ROL32(RS, SH) & mask(MB, ME)
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 sh   = (inst >> 11) & 0x1F;
    const u32 mb   = (inst >>  6) & 0x1F;
    const u32 me   = (inst >>  1) & 0x1F;
    const u32 mask = make_ppc_mask(mb, me);

    auto rc_ra = rc.Bind(ra, RCMode::Write);
    auto rc_rs = rc.Bind(rs, RCMode::Read);

    wb.op_local_get(rc_rs.local_idx());
    if (sh != 0) {
        wb.op_i32_const((s32)sh);
        wb.op_i32_rotl();
    }
    if (mask != 0xFFFFFFFFu) {
        wb.op_i32_const((s32)mask);
        wb.op_i32_and();
    }
    wb.op_local_set(rc_ra.local_idx());
}

void emit_rlwimix(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    // rlwimi: RA = (ROL32(RS, SH) & mask) | (RA & ~mask)
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 sh   = (inst >> 11) & 0x1F;
    const u32 mb   = (inst >>  6) & 0x1F;
    const u32 me   = (inst >>  1) & 0x1F;
    const u32 mask = make_ppc_mask(mb, me);

    auto rc_ra = rc.Bind(ra, RCMode::ReadWrite);
    auto rc_rs = rc.Bind(rs, RCMode::Read);

    // (ROL(rs, sh) & mask) | (ra & ~mask)
    wb.op_local_get(rc_rs.local_idx());
    if (sh != 0) {
        wb.op_i32_const((s32)sh);
        wb.op_i32_rotl();
    }
    wb.op_i32_const((s32)mask);
    wb.op_i32_and();
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_const((s32)~mask);
    wb.op_i32_and();
    wb.op_i32_or();
    wb.op_local_set(rc_ra.local_idx());
}

// ---------------------------------------------------------------------------
// Arithmetic shift right (srawix / srawx). PowerPC XER.CA semantics:
//   CA = (rs is negative) AND (any of the SH low bits of rs are set)
// i.e. CA captures "did we shift out a 1 from a negative value (which
// means the rounding direction was wrong vs floor-div-by-2^SH)".
// ---------------------------------------------------------------------------
void emit_srawix(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                 u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 sh   = (inst >> 11) & 0x1F;

    auto rc_ra = rc.Bind(ra, RCMode::Write);
    auto rc_rs = rc.Bind(rs, RCMode::Read);

    if (sh == 0) {
        // rt = rs; CA = 0
        wb.op_local_get(rc_rs.local_idx());
        wb.op_local_set(rc_ra.local_idx());
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_const(0);
        wb.op_i32_store8(ppc_off::XER_CA);
        return;
    }

    // result = (s32)rs >> sh
    wb.op_local_get(rc_rs.local_idx());
    wb.op_i32_const((s32)sh);
    wb.op_i32_shr_s();
    wb.op_local_set(rc_ra.local_idx());

    // CA = (rs < 0) AND ((rs & ((1<<sh)-1)) != 0)
    //    = (rs >>_u 31) AND ((rs & mask) != 0)
    const u32 low_mask = (1u << sh) - 1u;
    wb.op_i32_const((s32)ctx_ptr);
    // (rs >>_u 31)
    wb.op_local_get(rc_rs.local_idx());
    wb.op_i32_const(31);
    wb.op_i32_shr_u();
    // (rs & low_mask) != 0   →  (rs & low_mask) ne 0
    wb.op_local_get(rc_rs.local_idx());
    wb.op_i32_const((s32)low_mask);
    wb.op_i32_and();
    wb.op_i32_const(0);
    wb.op_i32_ne();
    // combine
    wb.op_i32_and();
    wb.op_i32_store8(ppc_off::XER_CA);
}

void emit_srawx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                u32 ctx_ptr) {
    // srawx: shift count from rb low 6 bits. If bit 5 set, result is
    // 0xFFFFFFFF if rs<0 else 0; CA = sign of rs. Otherwise behaves like
    // srawix with sh = rb & 0x1F.
    //
    // Phase 4.5 ships the rb-low-5-bits path inline; the bit-5 set case
    // falls back to interp (uncommon — typically only fires on bogus shift
    // counts). When the analyzer proves rb is bounded to <32 we can drop
    // the fallback branch entirely.
    const u32 inst = op.inst;
    auto rc_ra = rc.Bind(GekkoOperands::RA(inst), RCMode::Write);
    auto rc_rs = rc.Bind(GekkoOperands::RS(inst), RCMode::Read);
    auto rc_rb = rc.Bind(GekkoOperands::RB(inst), RCMode::Read);

    // For the common case (rb_low_6 < 32), do the rb_low_5 shift inline.
    // bit 5 set case: fall back to interp.
    wb.op_local_get(rc_rb.local_idx());
    wb.op_i32_const(0x20);
    wb.op_i32_and();
    wb.op_i32_eqz();

    // [Stack: i32 cond ("do shift inline")]
    rc.Flush(ctx_ptr);
    wb.op_if(/*BLOCK_TYPE_VOID=*/0x40);
        // rt = (s32)rs >> (rb & 0x1F)
        wb.op_local_get(rc_rs.local_idx());
        wb.op_local_get(rc_rb.local_idx());
        wb.op_i32_const(0x1F);
        wb.op_i32_and();
        wb.op_i32_shr_s();
        wb.op_local_set(rc_ra.local_idx());

        // CA = (rs < 0) AND any-bit-of-low-(rb&0x1F)-set
        wb.op_i32_const((s32)ctx_ptr);
        // (rs >>_u 31)
        wb.op_local_get(rc_rs.local_idx());
        wb.op_i32_const(31);
        wb.op_i32_shr_u();
        // (rs & ((1 << (rb & 0x1F)) - 1)) != 0
        wb.op_local_get(rc_rs.local_idx());
        wb.op_i32_const(1);
        wb.op_local_get(rc_rb.local_idx());
        wb.op_i32_const(0x1F);
        wb.op_i32_and();
        wb.op_i32_shl();
        wb.op_i32_const(1);
        wb.op_i32_sub();
        wb.op_i32_and();
        wb.op_i32_const(0);
        wb.op_i32_ne();
        wb.op_i32_and();
        wb.op_i32_store8(ppc_off::XER_CA);
    wb.op_else();
        // Bit-5 case — fallback to interp. Reuse WIMPORT_INTERP=6.
        wb.op_i32_const((s32)inst);
        wb.op_i32_const((s32)op.address);
        wb.op_call(/*WIMPORT_INTERP=*/6);
    wb.op_end();
}

// ---------------------------------------------------------------------------
// Negate (op31:104). rt = -ra. WASM: 0 - ra.
// ---------------------------------------------------------------------------
void emit_negx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    auto rc_ra = rc.Bind(ra, RCMode::Read);
    wb.op_i32_const(0);
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_sub();
    wb.op_local_set(rc_rt.local_idx());
}

// ---------------------------------------------------------------------------
// CA-chain ops — all share the structure:
//   sum1 = operand_a + operand_b
//   carry1 = (sum1 < operand_a)
//   rt = sum1 + CA_in
//   carry2 = (rt < sum1)         (can only happen when sum1 == 0xFFFFFFFF
//                                  and CA_in was 1)
//   new_CA = carry1 | carry2
//
// Caller supplies the operand_a / operand_b sequences; the helper does
// the rest. Uses LOCAL_TMP_VAL as scratch for the sum1 intermediate.
// ---------------------------------------------------------------------------
static constexpr u32 LOCAL_TMP_SCRATCH = 1;  // LOCAL_TMP_B / LOCAL_TMP_VAL

// CA-chain helper. Requires that operand_a_local and operand_b_local are
// NOT equal to LOCAL_TMP_SCRATCH (the helper uses it for sum1 storage).
// All current callers satisfy this — operands come from regcache GPR
// locals (indices >= GPR_LOCAL_BASE). subfex/subfzex inline their own
// chain because they need ~ra which doesn't live in a regcache local.
static void emit_ca_chain(WasmModuleBuilder& wb, u32 ctx_ptr,
                          u32 operand_a_local, u32 operand_b_local,
                          u32 dest_local) {
    // sum1 = a + b → tee TMP_SCRATCH
    wb.op_local_get(operand_a_local);
    wb.op_local_get(operand_b_local);
    wb.op_i32_add();
    wb.op_local_tee(LOCAL_TMP_SCRATCH);

    // dest = sum1 + xer_ca
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load8_u(ppc_off::XER_CA);
    wb.op_i32_add();
    wb.op_local_set(dest_local);

    // carry1 = (sum1 < a); carry2 = (dest < sum1); new_ca = carry1 | carry2
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(LOCAL_TMP_SCRATCH);
    wb.op_local_get(operand_a_local);
    wb.op_i32_lt_u();
    wb.op_local_get(dest_local);
    wb.op_local_get(LOCAL_TMP_SCRATCH);
    wb.op_i32_lt_u();
    wb.op_i32_or();
    wb.op_i32_store8(ppc_off::XER_CA);
}

void emit_addex(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                u32 ctx_ptr) {
    const u32 inst = op.inst;
    auto rc_rt = rc.Bind(GekkoOperands::RD(inst), RCMode::Write);
    auto rc_ra = rc.Bind(GekkoOperands::RA(inst), RCMode::Read);
    auto rc_rb = rc.Bind(GekkoOperands::RB(inst), RCMode::Read);
    emit_ca_chain(wb, ctx_ptr, rc_ra.local_idx(), rc_rb.local_idx(),
                  rc_rt.local_idx());
}

void emit_subfex(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                 u32 ctx_ptr) {
    // subfe: rt = ~ra + rb + CA. Inlined (can't reuse emit_ca_chain
    // because it stashes sum1 in LOCAL_TMP_SCRATCH; we'd alias if we
    // pre-stashed ~ra there). Recompute ~ra at the carry-out check.
    const u32 inst = op.inst;
    auto rc_rt = rc.Bind(GekkoOperands::RD(inst), RCMode::Write);
    auto rc_ra = rc.Bind(GekkoOperands::RA(inst), RCMode::Read);
    auto rc_rb = rc.Bind(GekkoOperands::RB(inst), RCMode::Read);

    // sum1 = ~ra + rb → tee LOCAL_TMP_SCRATCH
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_const(-1);
    wb.op_i32_xor();
    wb.op_local_get(rc_rb.local_idx());
    wb.op_i32_add();
    wb.op_local_tee(LOCAL_TMP_SCRATCH);
    // dest = sum1 + CA
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load8_u(ppc_off::XER_CA);
    wb.op_i32_add();
    wb.op_local_set(rc_rt.local_idx());
    // CA_out = (sum1 < ~ra) | (dest < sum1)
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(LOCAL_TMP_SCRATCH);
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_const(-1);
    wb.op_i32_xor();
    wb.op_i32_lt_u();
    wb.op_local_get(rc_rt.local_idx());
    wb.op_local_get(LOCAL_TMP_SCRATCH);
    wb.op_i32_lt_u();
    wb.op_i32_or();
    wb.op_i32_store8(ppc_off::XER_CA);
}

void emit_addmex(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                 u32 ctx_ptr) {
    // addme: rt = ra + (-1) + CA. operand_b = -1.
    const u32 inst = op.inst;
    auto rc_rt = rc.Bind(GekkoOperands::RD(inst), RCMode::Write);
    auto rc_ra = rc.Bind(GekkoOperands::RA(inst), RCMode::Read);
    wb.op_i32_const(-1);
    wb.op_local_set(LOCAL_TMP_SCRATCH);
    emit_ca_chain(wb, ctx_ptr, rc_ra.local_idx(), LOCAL_TMP_SCRATCH,
                  rc_rt.local_idx());
}

void emit_subfmex(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                  u32 ctx_ptr) {
    // subfme: rt = ~ra + (-1) + CA. Compute ~ra → ra_inv, then
    // ca_chain(ra_inv, -1). Need a different scratch for both, but we
    // only have one (LOCAL_TMP_SCRATCH). Fold: ~ra + (-1) = ~ra - 1.
    //   Compute (~ra - 1) directly, then add CA, set CA from carry.
    // For Phase 4.5, simplest: fallback. The op is rare in modern code.
    wb.op_i32_const((s32)op.inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(/*WIMPORT_INTERP=*/6);
    (void)wb; (void)rc; (void)ctx_ptr;
}

void emit_addzex(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                 u32 ctx_ptr) {
    // addze: rt = ra + 0 + CA = ra + CA. Specialized form:
    //   result = ra + CA_in
    //   CA_out = (result < ra)
    const u32 inst = op.inst;
    auto rc_rt = rc.Bind(GekkoOperands::RD(inst), RCMode::Write);
    auto rc_ra = rc.Bind(GekkoOperands::RA(inst), RCMode::Read);

    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load8_u(ppc_off::XER_CA);
    wb.op_i32_add();
    wb.op_local_set(rc_rt.local_idx());

    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(rc_rt.local_idx());
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_lt_u();
    wb.op_i32_store8(ppc_off::XER_CA);
}

void emit_subfzex(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                  u32 ctx_ptr) {
    // subfze: rt = ~ra + 0 + CA = ~ra + CA.
    //   result = ~ra + CA
    //   CA_out = (result < ~ra)
    const u32 inst = op.inst;
    auto rc_rt = rc.Bind(GekkoOperands::RD(inst), RCMode::Write);
    auto rc_ra = rc.Bind(GekkoOperands::RA(inst), RCMode::Read);

    // result = ~ra + CA → tee for carry check
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_const(-1);
    wb.op_i32_xor();
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load8_u(ppc_off::XER_CA);
    wb.op_i32_add();
    wb.op_local_set(rc_rt.local_idx());

    // CA_out = (result < ~ra)
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(rc_rt.local_idx());
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_const(-1);
    wb.op_i32_xor();
    wb.op_i32_lt_u();
    wb.op_i32_store8(ppc_off::XER_CA);
}

void emit_rlwnmx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op) {
    // rlwnm: RA = ROL32(RS, RB & 0x1F) & mask(MB, ME)
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    const u32 mb   = (inst >>  6) & 0x1F;
    const u32 me   = (inst >>  1) & 0x1F;
    const u32 mask = make_ppc_mask(mb, me);

    auto rc_ra = rc.Bind(ra, RCMode::Write);
    auto rc_rs = rc.Bind(rs, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);

    wb.op_local_get(rc_rs.local_idx());
    wb.op_local_get(rc_rb.local_idx());
    wb.op_i32_const(0x1F);
    wb.op_i32_and();
    wb.op_i32_rotl();
    if (mask != 0xFFFFFFFFu) {
        wb.op_i32_const((s32)mask);
        wb.op_i32_and();
    }
    wb.op_local_set(rc_ra.local_idx());
}

}  // namespace bemental::powerpc

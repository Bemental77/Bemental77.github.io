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
#include "cr_encode.h"
#include "fpr_reg_cache.h"
#include "ppc_analyst.h"
#include "ppc_offsets.h"
#include "reg_cache.h"

namespace bemental::powerpc {

// ---------------------------------------------------------------------------
// OE-form fallback. addx/subfx/addcx/subfcx/addex/subfex/addmex/subfmex/
// addzex/subfzex/mullwx/divwx/divwux/negx all have OE-suffix variants
// (bit 0x400 of the instruction word) that set XER.OV/SO on signed-overflow
// detection. The native emitters here do NOT track OV/SO; OE-form ops are
// rare in compiler output (typically only emerge from Watcom/CW range
// checks). Conservative fix: when OE bit is set, route the whole op to
// WIMPORT_INTERP — the interpreter handles OV/SO correctly. Mirrors the
// emit_fallback shape at ppc_emit.cpp:56-63 (Flush before, ReloadAll after,
// so subsequent ops in the block see post-interp register state).
// Returns true when the op was handled (interp call emitted); caller must
// early-return in that case.
static bool emit_oe_fallback_if_set(WasmModuleBuilder& wb, RegCache& rc,
                                    FPRRegCache& frc, const CodeOp& op,
                                    u32 ctx_ptr) {
    if (!GekkoOperands::OE(op.inst)) return false;
    rc.Flush(ctx_ptr);
    frc.Flush(ctx_ptr);
    wb.op_i32_const((s32)op.inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(/*WIMPORT_INTERP=*/6);
    rc.ReloadAll(ctx_ptr);
    frc.ReloadAll(ctx_ptr, /*host_may_write_fprs=*/false);
    return true;
}

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
void emit_addi(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    if (op.has_const_result) {
        // Forward const-prop hit (ra==0 li-form, or ra known-const). Skip
        // the runtime add — just materialize the known result directly.
        wb.op_i32_const((s32)op.const_result);
        wb.op_local_set(rc_rt.local_idx());
        return;
    }
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);
    emit_ra_or_zero(wb, rc, ra);
    wb.op_i32_const((s32)simm);
    wb.op_i32_add();
    wb.op_local_set(rc_rt.local_idx());
}

void emit_addis(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    if (op.has_const_result) {
        wb.op_i32_const((s32)op.const_result);
        wb.op_local_set(rc_rt.local_idx());
        return;
    }
    const u32 ra   = GekkoOperands::RA(inst);
    const s32 simm = (s32)(GekkoOperands::UIMM_16(inst) << 16);
    emit_ra_or_zero(wb, rc, ra);
    wb.op_i32_const(simm);
    wb.op_i32_add();
    wb.op_local_set(rc_rt.local_idx());
}

void emit_addic(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr) {
    // RT = RA + SIMM; set XER.CA = (result < RA).  RA is always read (no
    // a-or-zero variant — FL_IN_A, not FL_IN_A0).
    //
    // When RD==RA, rc_rt and rc_ra share the same wasm local. Writing rt
    // first and then reading "ra" reads the post-write (new) value, giving
    // CA = (rt < rt) = 0, which is wrong (e.g. wrap RA=0xFFFFFFFF, SIMM=1
    // ⇒ rt=0, CA should be 1, but observed 0). Fix: stash the original RA
    // in scratch local 1 before overwriting rt, and use that for CA.
    // Scratch local index matches the file-wide LOCAL_TMP_SCRATCH at line ~754
    // (= LOCAL_TMP_B / LOCAL_TMP_VAL); declared locally here since this fn
    // sits earlier in the TU than the file-scope constexpr.
    constexpr u32 LOCAL_TMP_SCRATCH = 1;
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 simm = GekkoOperands::SIMM_16(inst);

    auto rc_rt = rc.Bind(rt, RCMode::Write);
    auto rc_ra = rc.Bind(ra, RCMode::Read);

    // Stash original RA in LOCAL_TMP_SCRATCH so CA uses pre-write value
    // even when rt==ra.
    wb.op_local_get(rc_ra.local_idx());
    wb.op_local_set(LOCAL_TMP_SCRATCH);

    // result = ra + simm; written to rt local
    wb.op_local_get(LOCAL_TMP_SCRATCH);
    wb.op_i32_const((s32)simm);
    wb.op_i32_add();
    wb.op_local_set(rc_rt.local_idx());

    if (!op.ca_discardable) {
        // CA = (rt < ra_original) unsigned compare — wrap-around detected.
        // Store as u8 at PowerPCState +0x2F4 (XER_CA, per the live-tree
        // offset table in gekko_emit.h ppc_off::XER_CA).
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_local_get(rc_rt.local_idx());
        wb.op_local_get(LOCAL_TMP_SCRATCH);
        wb.op_i32_lt_u();
        wb.op_i32_store8(0x2F4);
    }
}

// addic.  (OPCD=13) — Add Immediate Carrying and Record.
// Same semantics as addic (XER.CA from unsigned wrap of RA+SIMM) PLUS a
// CR0 update from the signed result-vs-0. Per gekko_emit.cpp:300
// emit_addic_rc_impl.
void emit_addic_rc(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                   u32 ctx_ptr) {
    emit_addic(wb, rc, frc, op, ctx_ptr);
    // After emit_addic, rt's local holds the result. Re-bind RT in Read
    // mode (still cached) and update CR0 from its signed value-vs-0.
    const u32 rt = GekkoOperands::RD(op.inst);
    auto rc_rt = rc.Bind(rt, RCMode::Read);
    emit_cr0_from_local(wb, ctx_ptr, rc_rt.local_idx());
}

void emit_subfic(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
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

void emit_mulli(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op) {
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
                                    FPRRegCache& /*frc*/,
                                    const CodeOp& op, u32 imm_value,
                                    void (WasmModuleBuilder::*opfn)()) {
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);   // dest (RA in D-form for these)
    auto rc_ra = rc.Bind(ra, RCMode::Write);
    if (op.has_const_result) {
        // Forward const-prop hit (rs known-const). Materialize directly.
        wb.op_i32_const((s32)op.const_result);
        wb.op_local_set(rc_ra.local_idx());
        return;
    }
    const u32 rs   = GekkoOperands::RS(inst);   // src
    auto rc_rs = rc.Bind(rs, RCMode::Read);
    wb.op_local_get(rc_rs.local_idx());
    wb.op_i32_const((s32)imm_value);
    (wb.*opfn)();
    wb.op_local_set(rc_ra.local_idx());
}

void emit_ori(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op) {
    const u32 uimm = GekkoOperands::UIMM_16(op.inst);
    emit_logical_imm_simple(wb, rc, frc, op, uimm, &WasmModuleBuilder::op_i32_or);
}

// andi. (op 28) / andis. (op 29) — Logical AND Immediate (with optional shift)
// and Record. Computes RA = RS & UIMM (or UIMM<<16 for andis.) and updates
// CR0 from the result.
//
// SAB SetInterruptMask (canonical: ~/gc_refs/dolsdk2001/src/os/OSInterrupt.c:163
// .. ~:300, PI block at :248-289) compiles the pattern
// `if (!(current & OS_INTERRUPTMASK_PI_X)) reg |= Y` to an `andi.`/`andis.`
// + `bne` sequence. Without these emitters, every bit-test in SetInterruptMask
// fell back to interp. Historical: prior reports of "wasm writes PI MASK=0x3fff
// vs native=0xf8" traced to this code path; that specific divergence has been
// re-classified to upstream MMIO routing (see jit_load_store.cpp comments),
// but the emitters themselves remain required for correct CR0 semantics.
//
// CR0 spec: SO copied from XER.SO; LT/GT/EQ computed by signed comparison of
// result with 0. We use emit_cr0_from_local which mirrors the canonical
// gekko_emit.cpp:421-441 implementation.
static void emit_andi_imm(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                          u32 imm_value, u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);   // dest
    const u32 rs   = GekkoOperands::RS(inst);   // src
    auto rc_ra = rc.Bind(ra, RCMode::Write);
    auto rc_rs = rc.Bind(rs, RCMode::Read);

    // RA = RS & imm
    wb.op_local_get(rc_rs.local_idx());
    wb.op_i32_const((s32)imm_value);
    wb.op_i32_and();
    wb.op_local_set(rc_ra.local_idx());

    // CR0 from RA
    emit_cr0_from_local(wb, ctx_ptr, rc_ra.local_idx());
}

void emit_andix(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr) {
    const u32 uimm = GekkoOperands::UIMM_16(op.inst);
    emit_andi_imm(wb, rc, frc, op, uimm, ctx_ptr);
}

void emit_andisx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                 u32 ctx_ptr) {
    const u32 uimm = GekkoOperands::UIMM_16(op.inst) << 16;
    emit_andi_imm(wb, rc, frc, op, uimm, ctx_ptr);
}
void emit_oris(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op) {
    const u32 uimm = GekkoOperands::UIMM_16(op.inst) << 16;
    emit_logical_imm_simple(wb, rc, frc, op, uimm, &WasmModuleBuilder::op_i32_or);
}
void emit_xori(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op) {
    const u32 uimm = GekkoOperands::UIMM_16(op.inst);
    emit_logical_imm_simple(wb, rc, frc, op, uimm, &WasmModuleBuilder::op_i32_xor);
}
void emit_xoris(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op) {
    const u32 uimm = GekkoOperands::UIMM_16(op.inst) << 16;
    emit_logical_imm_simple(wb, rc, frc, op, uimm, &WasmModuleBuilder::op_i32_xor);
}

// ---------------------------------------------------------------------------
// X-form arithmetic (op31 sub)
// ---------------------------------------------------------------------------
static void emit_binop_x(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                         void (WasmModuleBuilder::*opfn)(),
                         u32 ctx_ptr) {
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
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_rt.local_idx());
    }
}

void emit_addx (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (emit_oe_fallback_if_set(wb, rc, frc, op, ctx_ptr)) return;
    emit_binop_x(wb, rc, frc, op, &WasmModuleBuilder::op_i32_add, ctx_ptr);
}
void emit_subfx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (emit_oe_fallback_if_set(wb, rc, frc, op, ctx_ptr)) return;
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
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_rt.local_idx());
    }
}
void emit_mullwx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (emit_oe_fallback_if_set(wb, rc, frc, op, ctx_ptr)) return;
    emit_binop_x(wb, rc, frc, op, &WasmModuleBuilder::op_i32_mul, ctx_ptr);
}

// ---------------------------------------------------------------------------
// X-form logical (op31 sub) — bool family. RA-form dest, RS-RB source.
// ---------------------------------------------------------------------------
static void emit_boolx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                       void (WasmModuleBuilder::*opfn)(),
                       u32 ctx_ptr) {
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
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_ra.local_idx());
    }
}

void emit_andx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    emit_boolx(wb, rc, frc, op, &WasmModuleBuilder::op_i32_and, ctx_ptr);
}
// andc rA, rS, rB  (op31 xo=60): RA = RS AND (NOT RB).
// Used by the SAB OS-interrupt path (canonical:
// ~/gc_refs/dolsdk2001/src/os/OSInterrupt.c:81 OSDisableInterrupts and the
// SetInterruptMask helper at :163) to clear interrupt bits from the OS mask
// shadow. Without this emitter, the analyst classifies the inst as unknown
// and the dispatch falls back to interp at ppc_emit.cpp:emit_fallback.
// Status: emitter added; the wider "PI MASK widening" trajectory bug
// originally attributed here has since been re-rooted to MMIO routing —
// see memory gamecube_first_mmio_divergence_2026_05_28 for the current
// authoritative wedge root.
void emit_andcx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);   // dest
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    auto rc_ra = rc.Bind(ra, RCMode::Write);
    auto rc_rs = rc.Bind(rs, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);
    wb.op_local_get(rc_rs.local_idx());
    wb.op_local_get(rc_rb.local_idx());
    wb.op_i32_const(-1);
    wb.op_i32_xor();                            // ~RB
    wb.op_i32_and();                            // RS & ~RB
    wb.op_local_set(rc_ra.local_idx());
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_ra.local_idx());
    }
}
void emit_orx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    // Common shape: `or rA, rS, rS` = `mr rA, rS`. WASM doesn't have a
    // dedicated MOV; the redundant i32_or with two equal operands is fine
    // (Liftoff folds it; TurboFan does even better).
    //
    // Removed 2026-05-30: a PC-hardcoded substitution at op.address ==
    // 0x800e3a7c that wrote `r0 = 0x38600000 | r20` instead of the canonical
    // `or` result. It was added to bisect the SetInterruptMask widening
    // wedge (now resolved upstream via the andi./andis. emit landed in
    // commit 4167634 + the cmp/CR0 sign-extension fix in commit c7dc522).
    // Per CLAUDE.md gate #8 ("diagnostics are temporary and must not
    // accumulate") the substitution is now scrubbed.
    emit_boolx(wb, rc, frc, op, &WasmModuleBuilder::op_i32_or, ctx_ptr);
}
void emit_xorx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    emit_boolx(wb, rc, frc, op, &WasmModuleBuilder::op_i32_xor, ctx_ptr);
}
void emit_norx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
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
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_ra.local_idx());
    }
}

// ---------------------------------------------------------------------------
// Sign-extend (op31 sub) — RA = SE(RS[0..7]) / SE(RS[0..15]).
// WASM has no signed-byte sign-extend opcode pre-bulk-memory; do it via
// shl 24 / shr_s 24 (16/16 for half).
// ---------------------------------------------------------------------------
static void emit_sign_ext(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                          u32 bit_count, u32 ctx_ptr) {
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
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_ra.local_idx());
    }
}

void emit_extsbx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    emit_sign_ext(wb, rc, frc, op, 8, ctx_ptr);
}
void emit_extshx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    emit_sign_ext(wb, rc, frc, op, 16, ctx_ptr);
}

// ---------------------------------------------------------------------------
// Count leading zeros — direct WASM i32.clz mapping. PowerPC semantics
// match WASM's: cntlzw(0) == 32.
// ---------------------------------------------------------------------------
void emit_cntlzwx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rs   = GekkoOperands::RS(inst);
    auto rc_ra = rc.Bind(ra, RCMode::Write);
    auto rc_rs = rc.Bind(rs, RCMode::Read);
    wb.op_local_get(rc_rs.local_idx());
    wb.op_i32_clz();
    wb.op_local_set(rc_ra.local_idx());
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_ra.local_idx());
    }
}

// ---------------------------------------------------------------------------
// Shift logical — slw / srw. PowerPC handles shifts >= 32 by producing 0
// (only the low 6 bits of RB are inspected, and bit 5 forces the result
// to 0). Implement via guard: if (rb & 0x20) result = 0; else shift.
// ---------------------------------------------------------------------------
static void emit_shiftx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
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
    // The Flush above cleared dirty for rc_ra; the op_local_set above wrote
    // the actual result into rc_ra's local. Re-mark dirty so block-exit Flush
    // writes the new value back to ppc_state.gpr[ra] — otherwise the write
    // is silently dropped, corrupting downstream readers of ra (e.g. the OS
    // interrupt-priority decode chain cntlzw(unmasked & *prio) ⇒ wrong index
    // ⇒ no registered handler ⇒ DBExceptionDestination → PPCHalt wedge).
    rc.MarkDirty(GekkoOperands::RA(op.inst));
    if (GekkoOperands::Rc(op.inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_ra.local_idx());
    }
}

void emit_slwx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    emit_shiftx(wb, rc, frc, op, &WasmModuleBuilder::op_i32_shl, ctx_ptr);
}
void emit_srwx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    emit_shiftx(wb, rc, frc, op, &WasmModuleBuilder::op_i32_shr_u, ctx_ptr);
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

void emit_rlwinmx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                  u32 ctx_ptr) {
    // rlwinm: RA = ROL32(RS, SH) & mask(MB, ME)
    // rlwinm. (Rc=1): also write CR0 from the signed result-vs-zero.
    //
    // SAB 0x500 EXT_INT handler depends on Rc here: at 0x80000570 the kernel
    // does `rlwinm. r5,r5,0,30,30` to extract SRR1.RI, then `bne+ 0x588`
    // tests CR0.EQ. Without CR0 update, the bne reads a stale CR0 and the
    // handler falls through to the non-recoverable rfi at 0x80000584, which
    // re-vectors into the crash dispatcher at 0x800e3ce4 instead of advancing
    // to 0x588.  See native /tmp/native-traj-mmio.log: 129 [traj] 0x588 vs
    // our wasm /tmp/probes/sab-si-none.log: 100× [wild-pivec] pc=0x500 and
    // 0 × pc=0x588.
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

    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_ra.local_idx());
    }
}

void emit_rlwimix(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                  u32 ctx_ptr) {
    // rlwimi: RA = (ROL32(RS, SH) & mask) | (RA & ~mask)
    // rlwimi. (Rc=1): also write CR0 from the signed result-vs-zero.
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

    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_ra.local_idx());
    }
}

// ---------------------------------------------------------------------------
// Arithmetic shift right (srawix / srawx). PowerPC XER.CA semantics:
//   CA = (rs is negative) AND (any of the SH low bits of rs are set)
// i.e. CA captures "did we shift out a 1 from a negative value (which
// means the rounding direction was wrong vs floor-div-by-2^SH)".
// ---------------------------------------------------------------------------
void emit_srawix(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
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
        if (!op.ca_discardable) {
            wb.op_i32_const((s32)ctx_ptr);
            wb.op_i32_const(0);
            wb.op_i32_store8(ppc_off::XER_CA);
        }
        if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
            emit_cr0_from_local(wb, ctx_ptr, rc_ra.local_idx());
        }
        return;
    }

    // result = (s32)rs >> sh
    wb.op_local_get(rc_rs.local_idx());
    wb.op_i32_const((s32)sh);
    wb.op_i32_shr_s();
    wb.op_local_set(rc_ra.local_idx());

    if (!op.ca_discardable) {
        // CA = (rs < 0) AND ((rs & ((1<<sh)-1)) != 0)
        //    = (rs >>_u 31) AND ((rs & mask) != 0)
        const u32 low_mask = (1u << sh) - 1u;
        wb.op_i32_const((s32)ctx_ptr);
        // (rs >>_u 31)
        wb.op_local_get(rc_rs.local_idx());
        wb.op_i32_const(31);
        wb.op_i32_shr_u();
        // (rs & low_mask) != 0
        wb.op_local_get(rc_rs.local_idx());
        wb.op_i32_const((s32)low_mask);
        wb.op_i32_and();
        wb.op_i32_const(0);
        wb.op_i32_ne();
        // combine
        wb.op_i32_and();
        wb.op_i32_store8(ppc_off::XER_CA);
    }

    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_ra.local_idx());
    }
}

void emit_srawx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
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

    // The Flush before the if cleared dirty for rc_ra; the IF arm above
    // op_local_set's the shifted value into rc_ra's local. Re-mark dirty so
    // block-exit Flush writes it back to ppc_state.gpr[ra]. The ELSE arm
    // (interp fallback) writes ppc_state.gpr[ra] directly via the host, so
    // ReloadAll would be the canonical follow-up there — but the if/else
    // collapses to a single dirty bit, and srawx is dominated by the inline
    // IF path on the OS interrupt-priority decode (srawi r0,..,4 / addze
    // family at SITransferNext, OSDispatchInterrupt cntlzw chain).
    rc.MarkDirty(GekkoOperands::RA(inst));
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_ra.local_idx());
    }
}

// ---------------------------------------------------------------------------
// Negate (op31:104). rt = -ra. WASM: 0 - ra.
// ---------------------------------------------------------------------------
void emit_negx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr) {
    if (emit_oe_fallback_if_set(wb, rc, frc, op, ctx_ptr)) return;
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    auto rc_ra = rc.Bind(ra, RCMode::Read);
    wb.op_i32_const(0);
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_sub();
    wb.op_local_set(rc_rt.local_idx());
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_rt.local_idx());
    }
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
                          u32 dest_local,
                          bool ca_discardable = false) {
    // sum1 = a + b → tee TMP_SCRATCH (leaves sum1 on the stack)
    wb.op_local_get(operand_a_local);
    wb.op_local_get(operand_b_local);
    wb.op_i32_add();
    wb.op_local_tee(LOCAL_TMP_SCRATCH);

    if (ca_discardable) {
        // dest = sum1 + xer_ca  (sum1 still on the stack from the tee)
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load8_u(ppc_off::XER_CA);
        wb.op_i32_add();
        wb.op_local_set(dest_local);
        return;
    }

    // 2026-06-12 ALIAS FIX: carry1 = (sum1 < a) MUST read the ORIGINAL
    // operand_a — but dest = sum1 + CA may overwrite operand_a's local when
    // rt == ra (e.g. __div2i's hot-loop `adde rX,rX,rX`). Compute carry1
    // FIRST (operand_a still intact), hold it on the stack, then write dest.
    // sum1 is on the stack from the tee above.
    wb.op_local_get(operand_a_local);
    wb.op_i32_lt_u();                       // stack: [carry1]

    // dest = sum1 (from TMP_SCRATCH) + CA, tee so it stays on the stack
    wb.op_local_get(LOCAL_TMP_SCRATCH);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load8_u(ppc_off::XER_CA);
    wb.op_i32_add();
    wb.op_local_tee(dest_local);            // stack: [carry1, dest]

    // carry2 = (dest < sum1); new_ca = carry1 | carry2
    wb.op_local_get(LOCAL_TMP_SCRATCH);
    wb.op_i32_lt_u();                       // stack: [carry1, carry2]
    wb.op_i32_or();                         // stack: [new_ca]
    wb.op_local_set(LOCAL_TMP_SCRATCH);     // sum1 no longer needed; stash new_ca
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(LOCAL_TMP_SCRATCH);
    wb.op_i32_store8(ppc_off::XER_CA);
}

void emit_addex(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr) {
    if (emit_oe_fallback_if_set(wb, rc, frc, op, ctx_ptr)) return;
    const u32 inst = op.inst;
    auto rc_rt = rc.Bind(GekkoOperands::RD(inst), RCMode::Write);
    auto rc_ra = rc.Bind(GekkoOperands::RA(inst), RCMode::Read);
    auto rc_rb = rc.Bind(GekkoOperands::RB(inst), RCMode::Read);
    emit_ca_chain(wb, ctx_ptr, rc_ra.local_idx(), rc_rb.local_idx(),
                  rc_rt.local_idx(), op.ca_discardable);
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_rt.local_idx());
    }
}

void emit_subfex(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                 u32 ctx_ptr) {
    if (emit_oe_fallback_if_set(wb, rc, frc, op, ctx_ptr)) return;
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
    if (!op.ca_discardable) {
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
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_rt.local_idx());
    }
}

void emit_addmex(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                 u32 ctx_ptr) {
    if (emit_oe_fallback_if_set(wb, rc, frc, op, ctx_ptr)) return;
    // addme: rt = ra + (-1) + CA. operand_b = -1.
    const u32 inst = op.inst;
    auto rc_rt = rc.Bind(GekkoOperands::RD(inst), RCMode::Write);
    auto rc_ra = rc.Bind(GekkoOperands::RA(inst), RCMode::Read);
    wb.op_i32_const(-1);
    wb.op_local_set(LOCAL_TMP_SCRATCH);
    emit_ca_chain(wb, ctx_ptr, rc_ra.local_idx(), LOCAL_TMP_SCRATCH,
                  rc_rt.local_idx(), op.ca_discardable);
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_rt.local_idx());
    }
}

void emit_subfmex(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                  u32 ctx_ptr) {
    // OE-form is handled by the same interp fallback below (the body
    // already routes to WIMPORT_INTERP), so no separate OE guard needed.
    // subfme: rt = ~ra + (-1) + CA. Compute ~ra → ra_inv, then
    // ca_chain(ra_inv, -1). Need a different scratch for both, but we
    // only have one (LOCAL_TMP_SCRATCH). Fold: ~ra + (-1) = ~ra - 1.
    //   Compute (~ra - 1) directly, then add CA, set CA from carry.
    // For Phase 4.5, simplest: fallback. The op is rare in modern code.
    //
    // CRITICAL: must rc.Flush(ctx_ptr) BEFORE the WIMPORT_INTERP call.
    // The interpreter writes the destination GPR directly to
    // PowerPCState.gpr[rt], but the RegCache still holds a stale rt-local
    // from prior emit context. Without the flush, the next regcache flush
    // would clobber what the interpreter just wrote with the stale local
    // value. Matches the pattern used by other interp-fallback sites in
    // this file (e.g. the invalid-TBR path in emit_mftb).
    rc.Flush(ctx_ptr);
    wb.op_i32_const((s32)op.inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(/*WIMPORT_INTERP=*/6);
    // ReloadAll mirrors canonical emit_fallback (ppc_emit.cpp:56-63): without
    // this, the next block-flush writes a stale local back over the rt the
    // interpreter just stored to PowerPCState.gpr[rt].
    rc.ReloadAll(ctx_ptr);
}

void emit_addzex(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                 u32 ctx_ptr) {
    if (emit_oe_fallback_if_set(wb, rc, frc, op, ctx_ptr)) return;
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
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_rt.local_idx());
    }
}

void emit_subfzex(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                  u32 ctx_ptr) {
    if (emit_oe_fallback_if_set(wb, rc, frc, op, ctx_ptr)) return;
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
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_rt.local_idx());
    }
}

void emit_rlwnmx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                 u32 ctx_ptr) {
    // rlwnm: RA = ROL32(RS, RB & 0x1F) & mask(MB, ME)
    // rlwnm. (Rc=1): also write CR0 from the signed result-vs-zero.
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

    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_ra.local_idx());
    }
}

// ---------------------------------------------------------------------------
// X-form carry arithmetic — addcx / subfcx. Single-operand carry-out (no
// carry-in). Both have OE-suffix variants (xo=522/520) that ignore OV/SO
// tracking and behave like the non-OE forms here.
// Ported from gekko_emit.cpp:1521-1563.
// ---------------------------------------------------------------------------

// addc rT, rA, rB: rT = rA + rB; XER.CA = unsigned carry-out.
// Per PowerPC arch manual: CA = (result < rA) unsigned.
// gekko_emit.cpp:1521 emit_addcx_impl.
void emit_addcx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr) {
    if (emit_oe_fallback_if_set(wb, rc, frc, op, ctx_ptr)) return;
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    auto rc_ra = rc.Bind(ra, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);

    // rt = ra + rb
    wb.op_local_get(rc_ra.local_idx());
    wb.op_local_get(rc_rb.local_idx());
    wb.op_i32_add();
    wb.op_local_set(rc_rt.local_idx());

    // XER.CA = (rt < ra) unsigned (wrap-around detection).
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(rc_rt.local_idx());
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_lt_u();
    wb.op_i32_store8(ppc_off::XER_CA);

    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_rt.local_idx());
    }
}

// subfc rT, rA, rB: rT = rB - rA; XER.CA = (rA <= rB) unsigned (carry-out
// of ~rA + rB + 1 = no-borrow).
// gekko_emit.cpp:1545 emit_subfcx_impl.
void emit_subfcx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                 u32 ctx_ptr) {
    if (emit_oe_fallback_if_set(wb, rc, frc, op, ctx_ptr)) return;
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    auto rc_ra = rc.Bind(ra, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);

    // rt = rb - ra
    wb.op_local_get(rc_rb.local_idx());
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i32_sub();
    wb.op_local_set(rc_rt.local_idx());

    // XER.CA = (ra <= rb) unsigned.
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_local_get(rc_ra.local_idx());
    wb.op_local_get(rc_rb.local_idx());
    wb.op_i32_le_u();
    wb.op_i32_store8(ppc_off::XER_CA);

    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_rt.local_idx());
    }
}

// ---------------------------------------------------------------------------
// X-form complemented logical — nand / eqv / orc.
// Ported from gekko_emit.cpp:1465-1502.
// ---------------------------------------------------------------------------

// nand rA, rS, rB: RA = ~(RS & RB). gekko_emit.cpp:1481 emit_nandx_impl.
void emit_nandx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    auto rc_ra = rc.Bind(ra, RCMode::Write);
    auto rc_rs = rc.Bind(rs, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);
    wb.op_local_get(rc_rs.local_idx());
    wb.op_local_get(rc_rb.local_idx());
    wb.op_i32_and();
    wb.op_i32_const(-1);
    wb.op_i32_xor();
    wb.op_local_set(rc_ra.local_idx());
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_ra.local_idx());
    }
}

// eqv rA, rS, rB: RA = ~(RS ^ RB). gekko_emit.cpp:1482 emit_eqvx_impl.
void emit_eqvx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
               u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    auto rc_ra = rc.Bind(ra, RCMode::Write);
    auto rc_rs = rc.Bind(rs, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);
    wb.op_local_get(rc_rs.local_idx());
    wb.op_local_get(rc_rb.local_idx());
    wb.op_i32_xor();
    wb.op_i32_const(-1);
    wb.op_i32_xor();
    wb.op_local_set(rc_ra.local_idx());
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_ra.local_idx());
    }
}

// orc rA, rS, rB: RA = RS | ~RB. gekko_emit.cpp:1487 emit_orcx_impl.
void emit_orcx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
               u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rs   = GekkoOperands::RS(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    auto rc_ra = rc.Bind(ra, RCMode::Write);
    auto rc_rs = rc.Bind(rs, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);
    wb.op_local_get(rc_rs.local_idx());
    wb.op_local_get(rc_rb.local_idx());
    wb.op_i32_const(-1);
    wb.op_i32_xor();    // ~RB
    wb.op_i32_or();     // RS | ~RB
    wb.op_local_set(rc_ra.local_idx());
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_ra.local_idx());
    }
}

// ---------------------------------------------------------------------------
// X-form wide multiply — high 32 bits of 32x32 product. Use i64 sign or
// zero extension, multiply in i64, take high half.
// Ported from gekko_emit.cpp:1790 / :1810.
// ---------------------------------------------------------------------------

// mulhw rT, rA, rB: rT = high 32 bits of (s32)rA * (s32)rB.
void emit_mulhwx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                 u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    auto rc_ra = rc.Bind(ra, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i64_extend_i32_s();
    wb.op_local_get(rc_rb.local_idx());
    wb.op_i64_extend_i32_s();
    wb.op_i64_mul();
    wb.op_i64_const(32);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_local_set(rc_rt.local_idx());
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_rt.local_idx());
    }
}

// mulhwu rT, rA, rB: rT = high 32 bits of (u32)rA * (u32)rB.
void emit_mulhwux(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                  u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    auto rc_ra = rc.Bind(ra, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);
    wb.op_local_get(rc_ra.local_idx());
    wb.op_i64_extend_i32_u();
    wb.op_local_get(rc_rb.local_idx());
    wb.op_i64_extend_i32_u();
    wb.op_i64_mul();
    wb.op_i64_const(32);
    wb.op_i64_shr_u();
    wb.op_i32_wrap_i64();
    wb.op_local_set(rc_rt.local_idx());
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_rt.local_idx());
    }
}

// ---------------------------------------------------------------------------
// X-form integer divide — guarded. WASM i32.div_s traps on /0 AND on
// INT_MIN/-1; i32.div_u traps on /0. PPC ISA leaves /0 and signed
// INT_MIN/-1 "undefined" but Dolphin's interpreter produces specific
// values game code may rely on. Emit a guard branch matching Dolphin.
// Ported from gekko_emit.cpp:1948-2001 emit_div_guarded.
// ---------------------------------------------------------------------------
static void emit_div_guarded_next(WasmModuleBuilder& wb, RegCache& rc,
                                  FPRRegCache& /*frc*/,
                                  const CodeOp& op, bool is_signed,
                                  u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    auto rc_rt = rc.Bind(rt, RCMode::Write);
    auto rc_ra = rc.Bind(ra, RCMode::Read);
    auto rc_rb = rc.Bind(rb, RCMode::Read);
    const u32 la = rc_ra.local_idx();
    const u32 lb = rc_rb.local_idx();

    if (is_signed) {
        // overflow = (b == 0) || (a == INT_MIN && b == -1)
        wb.op_local_get(lb);
        wb.op_i32_eqz();                   // b == 0
        wb.op_local_get(lb);
        wb.op_i32_const(-1);
        wb.op_i32_eq();                    // b == -1
        wb.op_local_get(la);
        wb.op_i32_const((s32)0x80000000);
        wb.op_i32_eq();                    // a == INT_MIN
        wb.op_i32_and();
        wb.op_i32_or();
        wb.op_if(/*BLOCK_TYPE_I32=*/0x7F);
            // overflow → result = (a < 0) ? -1 : 0
            wb.op_local_get(la);
            wb.op_i32_const(0);
            wb.op_i32_lt_s();
            wb.op_if(/*BLOCK_TYPE_I32=*/0x7F);
                wb.op_i32_const(-1);
            wb.op_else();
                wb.op_i32_const(0);
            wb.op_end();
        wb.op_else();
            wb.op_local_get(la);
            wb.op_local_get(lb);
            wb.op_i32_div_s();
        wb.op_end();
    } else {
        // unsigned: /0 → 0
        wb.op_local_get(lb);
        wb.op_i32_eqz();
        wb.op_if(/*BLOCK_TYPE_I32=*/0x7F);
            wb.op_i32_const(0);
        wb.op_else();
            wb.op_local_get(la);
            wb.op_local_get(lb);
            wb.op_i32_div_u();
        wb.op_end();
    }
    // Stack: [result]
    wb.op_local_set(rc_rt.local_idx());
    if (GekkoOperands::Rc(inst) && !op.crDiscardable[0]) {
        emit_cr0_from_local(wb, ctx_ptr, rc_rt.local_idx());
    }
}

void emit_divwx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr) {
    if (emit_oe_fallback_if_set(wb, rc, frc, op, ctx_ptr)) return;
    emit_div_guarded_next(wb, rc, frc, op, /*is_signed=*/true, ctx_ptr);
}
void emit_divwux(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                 u32 ctx_ptr) {
    if (emit_oe_fallback_if_set(wb, rc, frc, op, ctx_ptr)) return;
    emit_div_guarded_next(wb, rc, frc, op, /*is_signed=*/false, ctx_ptr);
}

// ---------------------------------------------------------------------------
// mftb — Time Base read. The TBR field is the same split-half encoding
// as SPR; only TBL (268) / TBU (269) are valid. Each maps to ppc_state.spr[]
// which dolphin snapshots at the dispatch boundary, so a thin u32 load is
// sufficient (no mailbox round-trip / CoreTiming call).
// SAB hits this at 0x800ecb48 (OSGetTime poll) ~246K times per the prior
// agent audit; falling back to interp here was a major fallback hot-spot.
// Ported from gekko_emit.cpp:2646 emit_mftb_impl.
// ---------------------------------------------------------------------------
void emit_mftb(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
               u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 rt   = GekkoOperands::RD(inst);
    // Same split-half decode used by mfspr: spr_field is (inst >> 11) & 0x3FF;
    // real = (high5 | (low5 << 5)).
    const u32 spr_field = (inst >> 11) & 0x3FFu;
    const u32 tbr = ((spr_field >> 5) & 0x1Fu) | ((spr_field & 0x1Fu) << 5);

    // CRITICAL: ppc_state.spr[TL/TU] is STALE until something refreshes it.
    // Native Interpreter::mfspr for SPR_TL/SPR_TU calls
    // PowerPC().WriteFullTimeBaseValue(SystemTimers::GetFakeTimeBase())
    // BEFORE reading the SPR (see Interpreter_SystemRegisters.cpp:254-258).
    // A direct ppc_state.spr[TL] load returns whatever was last snapshotted —
    // when the loop calling mftb is itself a short-cycle idle-spin (SAB's
    // __OSInitAudioSystem 0x800e4c5c..0x800ecb60 OSGetTick poll, 2026-05-31),
    // TBL never advances inside the spin → infinite loop.
    //
    // Route through WIMPORT_INTERP: marginally slower per insn but
    // semantically correct, and the only mftb call sites in steady-state
    // are idle-spins anyway — the cost is bounded by how fast TBL actually
    // ticks (Advance fires, spin exits).
    (void)tbr;
    (void)rt;
    // Mirror canonical emit_fallback (ppc_emit.cpp:56-63): Flush BEFORE the
    // interp call so the host sees current GPRs, then ReloadAll AFTER so
    // subsequent ops in the block see the post-interp rt value (otherwise
    // the regcache flush at block end overwrites it with a stale local).
    // [pc-sync A4 2026-06-28] Store ppc_state.pc=op.address BEFORE the interp so
    // the cutover dolphin_interp pc-guard (dolphin_jit_wimports.cpp:294) does not
    // silently skip the 2nd/3rd mftb of a 64-bit timebase read -> torn TB. Matches
    // emit_fallback (ppc_emit.cpp:187-189).
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_const((s32)op.address);
    wb.op_i32_store(ppc_off::PC);
    rc.Flush(ctx_ptr);
    wb.op_i32_const((s32)inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(/*WIMPORT_INTERP=*/6);
    rc.ReloadAll(ctx_ptr);
}

// ---------------------------------------------------------------------------
// dcbz — zero a 32-byte cache line at EA = (ra?gpr[ra]:0) + gpr[rb], aligned
// down to 32-byte boundary. The Gekko's memset/__fill_mem zero-init paths
// rely on this. History: 2026-06-01 routed ALL dcbz to WIMPORT_INTERP after an
// unguarded 8x WIMPORT_WRITE32 inline proved semantically wrong; 2026-07-15
// restores a GUARDED Jit64-parity fast path (classify-admitted RAM -> in-wasm
// fill, everything else -> the same interp delegate). See the body comment.
// ---------------------------------------------------------------------------
void emit_dcbz(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
               LoadStoreParams params) {
    // [dcbz-fastpath 2026-07-15] Jit64-parity inline 32-byte zero fill.
    // MEASURED: the 2026-06-01 interp delegation costs 3.81% of the JIT worker
    // (Interpreter::dcbz -> MMU::ClearDCacheLine -> 8x byte-wise WriteToHardware;
    // /tmp/worker_0.cpuprofile, movie). The ORACLE JIT (Jit64 Jit_LoadStore.cpp:
    // 424-483) emits: EA=(ra?gpr[ra]:0)+gpr[rb]; EA&=~31; per-address BAT guard ->
    // two 16-byte MOVAPS zero stores through fastmem; slow-call otherwise. It has
    // NO HID0.DCE check (interp-only edge) and LowDCBZHack (MainSettings.cpp:225)
    // defaults false and is not set by our libretro Options — both omitted here,
    // matching Jit64 exactly.
    // Guard parity: the same (EA & 0x3E000000)==0 region classify every inline
    // store uses (emit_fastmem_guard) plays Jit64's BAT-lookup role: it admits the
    // RAM mirrors {0x00,0x80,0xC0}; classify-reject (MMIO, direct-store segments,
    // exotic translations) falls back to the EXACT prior path (WIMPORT_INTERP ->
    // Interpreter::dcbz), preserving the direct-store-ignore + DSI + alignment-
    // exception semantics there (ClearDCacheLine, MMU.cpp:1017-1043).
    // The 2026-06-01 revert reasons are each addressed: ClearDCacheLine's real
    // work for RAM IS the 32-byte zero (its translation/direct-store arms live in
    // the fallback); cache-disabled regions classify-reject to the fallback; the
    // "JIT block-cache invalidation hook" concern is vacuous — MMU's data-write
    // path performs NO JIT invalidation (verified: MMU.cpp invalidation is only
    // dCache/TLB entry points), identical to our inline fastmem stw, so the fill
    // introduces no new skew; bad-EA exceptions only arise on classify-rejected
    // EAs, which take the fallback.
    const u32 inst = op.inst;
    const u32 ra   = GekkoOperands::RA(inst);
    const u32 rb   = GekkoOperands::RB(inst);
    constexpr u32 LOCAL_EA = 0;  // block-level i32 scratch (build_block_next declares 2 at 0/1)

    // Degenerate/unconfigured MEM1 (test harness): keep the prior interp-only
    // shape, mirroring emit_fastmem_guard's constant-false (jit_load_store.cpp:132).
    const bool fast_ok = params.ram_size >= 32u && params.mem1_mask == params.ram_size - 1u;
    if (!fast_ok) {
        rc.Flush(params.ctx_ptr);
        wb.op_i32_const((s32)inst);
        wb.op_i32_const((s32)op.address);
        wb.op_call(/*WIMPORT_INTERP=*/6);
        rc.ReloadAll(params.ctx_ptr);
        return;
    }

    // EA = (ra?gpr[ra]:0) + gpr[rb], line-aligned.
    emit_ra_or_zero(wb, rc, ra);
    {
        auto rc_rb = rc.Bind(rb, RCMode::Read);
        wb.op_local_get(rc_rb.local_idx());
    }
    wb.op_i32_add();
    wb.op_i32_const((s32)~31);
    wb.op_i32_and();
    wb.op_local_tee(LOCAL_EA);
    // Region classify — the single-mask admit shared with emit_fastmem_guard.
    wb.op_i32_const((s32)0x3E000000u);
    wb.op_i32_and();
    wb.op_i32_eqz();
    // Flush BEFORE the branch (stack-neutral; guard stays on top) so both arms
    // share one compile-time regcache state — the emit_load/store_common rule.
    rc.Flush(params.ctx_ptr);
    wb.op_if();
    {
        // Fast arm: zero the line in-wasm. (EA & mask) confines to [0, ram_size)
        // and EA is 32-byte aligned, so +24 stays inside the 32MB window.
        wb.op_local_get(LOCAL_EA);
        wb.op_i32_const((s32)params.mem1_mask);
        wb.op_i32_and();
        wb.op_i32_const((s32)params.mem1_base);
        wb.op_i32_add();
        wb.op_local_tee(LOCAL_EA);
        wb.op_i64_const(0); wb.op_i64_store(0);
        wb.op_local_get(LOCAL_EA); wb.op_i64_const(0); wb.op_i64_store(8);
        wb.op_local_get(LOCAL_EA); wb.op_i64_const(0); wb.op_i64_store(16);
        wb.op_local_get(LOCAL_EA); wb.op_i64_const(0); wb.op_i64_store(24);
    }
    wb.op_else();
    {
        // Slow arm: the exact prior behavior. Store pc first so the dolphin_interp
        // pc-guard cannot skip the op (pre-op set_pc fired via FL_LOADSTORE; this
        // is cheap insurance matching emit_fallback, ppc_emit.cpp:203-219).
        wb.op_i32_const((s32)params.ctx_ptr);
        wb.op_i32_const((s32)op.address);
        wb.op_i32_store(ppc_off::PC);
        wb.op_i32_const((s32)inst);
        wb.op_i32_const((s32)op.address);
        wb.op_call(/*WIMPORT_INTERP=*/6);
    }
    wb.op_end();
    // No rc.ReloadAll here: Interpreter::dcbz writes memory + (on fault) SRR0/
    // SRR1/MSR/Exceptions only — never GPRs/FPRs — and the fast arm writes no
    // registers, so cached locals stay coherent in both arms. (A ReloadAll inside
    // ONE arm would desync the compile-time cache state between the arms.)
    (void)frc;
}

}  // namespace bemental::powerpc

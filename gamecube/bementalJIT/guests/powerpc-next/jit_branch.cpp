//
// jit_branch.cpp — Phase 4 part 2 branch emitters.
//
// Each emit_* sets PowerPCState.pc to the branch target. The per-block
// epilogue (in build_block / ppc_emit) handles the final read-PC-and-
// return; emit_* just writes ppc_state.pc + sets c.block_end = true via
// the caller's CodeOp metadata (analyst already sets canEndBlock).
//
// Static targets (b/bc with known offset) write a compile-time constant;
// indirect targets (bclr/bcctr) write a runtime local from LR/CTR.
//
// Note: PowerPCState writes here BYPASS RegCache (PC/LR/CTR are not GPR-
// cached). Direct ctx-relative i32_store. Before writing, we Flush dirty
// GPR bindings so the dispatcher's next iteration sees consistent state.

#include "jit_branch.h"

#include "bementalJIT/region_desc.h"   // [AOT v4 reloc] BemRelocSym + sentinel
#include "bementalJIT/types.h"
#include "bementalJIT/wasm_module_builder.h"
#include "code_op.h"
#include "common/op_info.h"
#include "cr_shadow.h"
#include "ppc_analyst.h"
#include "ppc_emit.h"        // BEM_MIPS_EXEC_CELL + bem_mips_census_on()
#include "ppc_offsets.h"
#include "reg_cache.h"

namespace bemental::powerpc {

static constexpr u32 WIMPORT_INTERP = 6;
// [EDGE-DIET 13h] dolphin_check_exc import (idx 7) — delivers any pending exception
// (sets PC=vector; arg unused). Used post-rfi since the diet removed the edge's
// maskable-exception check and rfi can flip MSR.EE=1 with an IRQ pending.
static constexpr u32 WIMPORT_CHECK_EXC = 7;

// [MIPS meter 2026-08-11] Fused-loop back-edge charge accumulation. Counts the
// per-iteration re-charge so loop-resident hot code is not undercounted (which
// would falsely inflate phantom).
// [runtime-gated 2026-09-02] The duplicated `BEM_MIPS_CENSUS = true` /
// `BEM_MIPS_EXEC_CELL` pair that had to be "kept in sync by hand" with
// ppc_emit.cpp is GONE: both now come from ppc_emit.h, and the on/off decision
// is the shared bem_mips_census_on() emit-time SAB read. Nothing to keep in
// sync any more — the two sites cannot disagree.
// Block-module import index for ppc_gather_drain (ppc_emit.cpp emitImportFunc
// order; idx 12). Used by the coalesced taken-exit below to drain a pending
// gather-pipe write, since the early op_return bypasses the block epilogue's
// store-gated drain.
static constexpr u32 WIMPORT_GATHER_DRAIN = 12;
// [perf gather-gate] runtime "a write-gather-pipe store is pending" flag
// (defined in src/block_cache.cpp). The coalesced taken-exit gates its drain on
// this so it is a no-op when no GP write happened on the taken path.
extern "C" { extern int g_bem_gp_dirty; extern int g_bem_aot_reloc_mode; extern uint32_t g_bem_aot_count_exits; }

// [AOT v4 reloc 2026-08-13] gp_dirty address const: sentinel + reloc record in
// offline reloc mode (a native tool's &g_bem_gp_dirty is a wild pointer in the
// worker), byte-identical to the plain const otherwise. See region_desc.h.
static inline void emit_gp_dirty_addr(WasmModuleBuilder& wb) {
    if (g_bem_aot_reloc_mode)
        wb.op_i32_const_reloc((u16)bemental::powerpc::BEM_RSYM_GP_DIRTY, 0u,
                              bemental::powerpc::bem_reloc_sentinel(
                                  (u16)bemental::powerpc::BEM_RSYM_GP_DIRTY, 0u));
    else
        wb.op_i32_const((s32)(uintptr_t)&g_bem_gp_dirty);
}

// [census 2026-08-13c Item 1] per-exit-reason counter (offline diag asset only,
// gated on g_bem_aot_count_exits which only aot_merge sets). Stack-neutral.
static inline void emit_exit_census_jb(WasmModuleBuilder& wb, u32 cell) {
    if (!g_bem_aot_count_exits) return;
    wb.op_i32_const((s32)cell); wb.op_i32_const((s32)cell);
    wb.op_i32_load(0); wb.op_i32_const(1); wb.op_i32_add(); wb.op_i32_store(0);
}

// emit_coalesced_taken_exit — the taken arm of a mid-block (is_terminal=false)
// forward conditional branch: drain a pending gather-pipe write, then return
// the just-stored target PC to the dispatcher. PC=target must already be stored.
static void emit_coalesced_taken_exit(WasmModuleBuilder& wb, u32 ctx_ptr,
                                      const MergedRegionCtx* merged = nullptr,
                                      s32 region_gen = -1,
                                      u32 chain_tag_addr = 0u, u32 chain_slot_addr = 0u,
                                      u16 chain_tag_sym = (u16)BEM_RSYM_NONE,
                                      u16 chain_slot_sym = (u16)BEM_RSYM_NONE) {
    emit_gp_dirty_addr(wb);
    wb.op_i32_load(0);
    wb.op_if();                       // void block (0x40)
        wb.op_i32_const(0);
        wb.op_i32_const(0);
        wb.op_call(WIMPORT_GATHER_DRAIN);
    wb.op_end();
    // PM47 self-chain flag (0x026B38C0) must be 0 on every exit that is not
    // the direct self-tail-call: this early return bypasses the epilogue's
    // clear, and the dispatcher never writes the cell — a later in-chain
    // revisit of the flagged start_pc would fast-reenter on stale scratch.
    wb.op_i32_const((s32)0x026B38C0);
    wb.op_i32_const(0);
    wb.op_i32_store(0);
    // [order 13d] merged: route the taken exit through the SAME warm cascade as the
    // block epilogue (PC=target already stored above; probe mrtag/mrslot -> own-gen
    // warm entry_sel=k; br $L with GPR locals live -> else global-fallback in-wasm
    // chain -> host return) INSTEAD of op_return-ing to the C loop (artifact #4). The
    // warm br depth auto-adjusts via ctrlDepth() to the enclosing taken op_if.
    if (merged) {
        emit_chain_or_return(wb, ctx_ptr, chain_tag_addr, chain_slot_addr, merged,
                             region_gen, nullptr, nullptr, 0u, chain_tag_sym, chain_slot_sym);
    } else {
        emit_exit_census_jb(wb, 0x026B34D8u);   // [census] only the non-merged op_return path (post-fix: taken collapses)
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load(ppc_off::PC);
        wb.op_return();
    }
}

// Write a compile-time-constant value to a PowerPCState field. Stack-neutral.
static void emit_store_const_to_ctx(WasmModuleBuilder& wb, u32 ctx_ptr,
                                    u32 field_off, u32 value) {
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_const((s32)value);
    wb.op_i32_store(field_off);
}

// Copy a u32 from one PowerPCState field to another. Stack-neutral.
static void emit_copy_ctx_field(WasmModuleBuilder& wb, u32 ctx_ptr,
                                u32 dst_off, u32 src_off) {
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load(src_off);
    wb.op_i32_store(dst_off);
}

// ---------------------------------------------------------------------------
// emit_bx — unconditional branch.
//   target = SignExt26(LI << 2); if (!AA) target += pc;
//   if (LK) gpr[LR] = pc + 4;
//   pc = target;
// ---------------------------------------------------------------------------
void emit_bx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
             u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 li   = GekkoOperands::LI(inst);
    const bool aa  = GekkoOperands::AA(inst);
    const bool lk  = GekkoOperands::LK(inst);
    const u32 target = aa ? li : (op.address + li);

    // Flush dirty GPRs before block-exiting branch.
    rc.Flush(ctx_ptr);
    frc.Flush(ctx_ptr);

    if (lk) {
        emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::lr_off(), op.address + 4);
    }
    emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::PC, target);
}

// Pushes 1 iff CR bit `bi` is set (Dolphin u64 CR-field encoding: LT⇔hi&(1<<30),
// EQ⇔lo==0, GT⇔(s64)val>0 ⇔ hi bit-31 clear — the u64 always has bit 32 set per
// PPCToInternal, matching Jit64 Jit_SystemRegisters.cpp:177-179's CMP 64 + CC_G;
// SO⇔hi&(1<<27)). Factored so emit_bcx and emit_bcx_fused share ONE copy of the
// GT/SO polarity subtleties (pass-2 audit w6oeq0l6e RANK 10: a diverging
// !LT&&!EQ GT copy broke on SO-set-alone after mtcrf/mcrxr).
// [PM56 lazy-CR] Push 1 iff CR bit is set, reading the EAGER cr[] field.
static void emit_crbit_test_eager(WasmModuleBuilder& wb, u32 ctx_ptr,
                                  u32 field_idx, u32 bit_in_field) {
    switch (bit_in_field) {
      case 0:  // LT
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load(ppc_off::cr(field_idx) + 4u);
        wb.op_i32_const(1 << 30);
        wb.op_i32_and();
        wb.op_i32_const(0);
        wb.op_i32_ne();
        break;
      case 1:  // GT
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load(ppc_off::cr(field_idx) + 4u);
        wb.op_i32_const((s32)0x80000000u);
        wb.op_i32_and();
        wb.op_i32_eqz();
        break;
      case 2:  // EQ
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load(ppc_off::cr(field_idx));
        wb.op_i32_eqz();
        break;
      case 3:  // SO
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load(ppc_off::cr(field_idx) + 4u);
        wb.op_i32_const(1 << 27);
        wb.op_i32_and();
        wb.op_i32_const(0);
        wb.op_i32_ne();
        break;
    }
}

// [PM56 lazy-CR] Push 1 iff CR bit is set, reconstructing from the DEFERRED
// shadow (used when pending[field]). Tag is a runtime byte (the feeding block
// is unknown), so signed/unsigned and CMP-vs-RC_VS0 dispatch at runtime.
static void emit_materialize_crbit(WasmModuleBuilder& wb, u32 field_idx,
                                   u32 bit_in_field) {
    const u32 S = (u32)(uintptr_t)&g_bem_cr_shadow[field_idx];
    auto push_a    = [&] { wb.op_i32_const((s32)S); wb.op_i32_load(0); };
    auto push_b    = [&] { wb.op_i32_const((s32)S); wb.op_i32_load(4); };
    auto push_kind = [&] {
        wb.op_i32_const((s32)S); wb.op_i32_load8_u(8);
        wb.op_i32_const((s32)BEM_CR_KIND_MASK); wb.op_i32_and();
    };
    auto push_is_rc = [&] {
        push_kind(); wb.op_i32_const((s32)BEM_CR_RC_VS0); wb.op_i32_eq();
    };
    auto push_is_unsigned = [&] {
        wb.op_i32_const((s32)S); wb.op_i32_load8_u(8);
        wb.op_i32_const((s32)BEM_CR_UNSIGNED); wb.op_i32_and();
    };
    if (bit_in_field == 3) {   // SO — frozen byte (already 0/1)
        wb.op_i32_const((s32)S); wb.op_i32_load8_u(9);
        return;
    }
    if (bit_in_field == 2) {   // EQ — signedness irrelevant
        push_is_rc();
        wb.op_if(0x7F);
            push_a(); wb.op_i32_eqz();            // a == 0
        wb.op_else();
            push_a(); push_b(); wb.op_i32_eq();   // a == b
        wb.op_end();
        return;
    }
    // LT (0) or GT (1): RC_VS0 → a vs 0 signed; else signed/unsigned a vs b.
    push_is_rc();
    wb.op_if(0x7F);
        push_a(); wb.op_i32_const(0);
        if (bit_in_field == 0) wb.op_i32_lt_s(); else wb.op_i32_gt_s();
    wb.op_else();
        push_is_unsigned();
        wb.op_if(0x7F);
            push_a(); push_b();
            if (bit_in_field == 0) wb.op_i32_lt_u(); else wb.op_i32_gt_u();
        wb.op_else();
            push_a(); push_b();
            if (bit_in_field == 0) wb.op_i32_lt_s(); else wb.op_i32_gt_s();
        wb.op_end();
    wb.op_end();
}

// Pushes 1 iff CR bit `bi` is set. [PM56 lazy-CR] runtime-dispatches: if the
// field is pending (deferred), materialize from the shadow; else read eager
// cr[]. When pending is unset the emitted path is byte-identical to pre-PM56.
static void emit_crbit_test(WasmModuleBuilder& wb, u32 ctx_ptr, u32 bi) {
    const u32 field_idx    = bi / 4u;
    const u32 bit_in_field = bi % 4u;               // 0=LT,1=GT,2=EQ,3=SO
    if (!BEM_LAZY_CR) {                              // shipping: eager only
        emit_crbit_test_eager(wb, ctx_ptr, field_idx, bit_in_field);
        return;
    }
    wb.op_i32_const((s32)(uintptr_t)&g_bem_cr_pending[field_idx]);
    wb.op_i32_load8_u(0);
    wb.op_if(0x7F);
        emit_materialize_crbit(wb, field_idx, bit_in_field);
    wb.op_else();
        emit_crbit_test_eager(wb, ctx_ptr, field_idx, bit_in_field);
    wb.op_end();
}

// [PM57 adjacent cmp->branch fusion] Push 1 iff CR bit is set, reading the
// preceding cmp's operand LOCALS directly (no pending-check, no shadow). Called
// ONLY when the fuse is valid for this field and bit != SO (see emit_bcx). The
// predicate table (LT⇔a<b, GT⇔a>b, EQ⇔a==b; signedness from the cmp form) is
// exactly the definition of the deferred field, so this is bit-for-bit the same
// truth value the materialize path would produce — verified vs the oracle by
// test_diff_next and the fused-adjacent differential.
static void emit_crbit_fused(WasmModuleBuilder& wb, const CmpFuse& f,
                             u32 bit_in_field) {
    wb.op_local_get(f.a_local);
    if (f.is_imm) wb.op_i32_const(f.imm);
    else          wb.op_local_get(f.b_local);
    switch (bit_in_field) {
      case 0:  if (f.is_signed) wb.op_i32_lt_s(); else wb.op_i32_lt_u(); break; // LT
      case 1:  if (f.is_signed) wb.op_i32_gt_s(); else wb.op_i32_gt_u(); break; // GT
      case 2:  wb.op_i32_eq(); break;                                           // EQ
      // case 3 (SO) is never fused — caller guards bit_in_field != 3.
    }
}

// ---------------------------------------------------------------------------
// emit_bcx — conditional branch.
//   target = SignExt16(BD << 2); if (!AA) target += pc;
//   BO[0..4] decode: bit 4=1 → ignore CR; bit 2=1 → ignore CTR (no decrement)
// Native paths: BO=20 (branch always), bdnz/bdz (BO=0b10000 / 0b10010), and
// the CR-bit conditional forms BO=0b00100 / 0b01100 (bne / beq). Genuinely
// rare combos (LK conditional calls; exotic CTR+CR mixes) fall back to
// WIMPORT_INTERP via the trailing path.
// ---------------------------------------------------------------------------
void emit_bcx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
              u32 ctx_ptr, bool is_terminal, BitSet32 fpr_flush_skip,
              const CmpFuse* fuse,
              const MergedRegionCtx* merged, s32 region_gen,
              u32 chain_tag_addr, u32 chain_slot_addr,
              u16 chain_tag_sym, u16 chain_slot_sym) {
    const u32 inst = op.inst;
    const u32 bo   = GekkoOperands::BO(inst);

    // Flush before bail-or-take.
    // [bcx flush-narrow REVERTED 2026-07-23] Taken-arm-only keep-dirty spill
    // (EmitSpillAll) was tried and MEASURED WORSE (gc-rate 17.9 -> 15.3 on the
    // MP4 movie probe): clean-marking here means later branches in the block
    // have nothing left to flush, while a keep-dirty spill re-ran the FULL
    // dirty set at every taken exit — and branchy hot blocks (THP IDCT 4-way
    // column select) EXIT via taken branches most iterations. Keeping Singles
    // alive on the fall-through cannot pay for that. The Single-chain fix for
    // branchy blocks is structural (in-block loops / cross-block repr), not
    // flush placement.
    // [self-loop PM47] fpr_flush_skip (terminal self-loop bcx only): the
    // caller's split epilogue owns those regs — scratch-spill on the
    // self-chain path, full flush otherwise. Keeps them Single + dirty here.
    rc.Flush(ctx_ptr);
    frc.Flush(ctx_ptr, BitSet32(~fpr_flush_skip.m_val));

    if (bo == 20) {
        // "branch always" — equivalent to bx without LK side-effect choice.
        const u32 bd   = GekkoOperands::BD(inst);
        const bool aa  = GekkoOperands::AA(inst);
        const bool lk  = GekkoOperands::LK(inst);
        const u32 target = aa ? bd : (op.address + bd);
        if (lk) {
            emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::lr_off(),
                                    op.address + 4);
        }
        emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::PC, target);
        return;
    }

    // Conditional path. Natively resolve the common forms (mirrors the
    // proven gekko_emit.cpp::emit_bcx_impl): store PC=target/fallthrough so
    // the block epilogue returns the correct next_pc. Previously ALL
    // conditional forms fell back to WIMPORT_INTERP, whose ppc_state.pc
    // write was NOT reflected in the block's returned next_pc — the OSInit
    // guard `bne` (fn 0x800e362c) then returned its own entry PC, self-
    // looping and wedging SAB boot. Proof: native trajectory diverges at
    // 0x800e3650→0x800e3654 (/tmp/native-osexc-362c.log).
    const u32  bi  = GekkoOperands::BI(inst);
    const s32  bd  = GekkoOperands::BD(inst);
    const bool aa  = GekkoOperands::AA(inst);
    const bool lk  = GekkoOperands::LK(inst);
    const u32  target      = aa ? (u32)bd : (u32)((s32)op.address + bd);
    const u32  fallthrough = op.address + 4u;
    constexpr u32 LOCAL_TMP_A = 0u;  // build_block_next declares 2 i32 scratch

    // bdnz (BO=0b10000) / bdz (BO=0b10010): decrement CTR, branch on != / == 0.
    if (!lk && (bo == 0b10000u || bo == 0b10010u)) {
        const bool is_bdnz = (bo == 0b10000u);
        wb.op_i32_const((s32)ctx_ptr);              // store addr for CTR write
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load(ppc_off::ctr_off());
        wb.op_i32_const(1);
        wb.op_i32_sub();
        wb.op_local_tee(LOCAL_TMP_A);               // stash CTR-1 for the test
        wb.op_i32_store(ppc_off::ctr_off());        // CTR := CTR - 1
        wb.op_local_get(LOCAL_TMP_A);
        wb.op_i32_const(0);
        if (is_bdnz) wb.op_i32_ne(); else wb.op_i32_eq();
        wb.op_if();
            emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::PC, target);
            if (!is_terminal) emit_coalesced_taken_exit(wb, ctx_ptr, merged, region_gen,
                                                        chain_tag_addr, chain_slot_addr,
                                                        chain_tag_sym, chain_slot_sym);
        if (is_terminal) {
            wb.op_else();
            emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::PC, fallthrough);
        }
        wb.op_end();
        return;
    }

    // CR-bit conditional, no CTR decrement, no LK: BO=0b00100 (branch on CR
    // false, e.g. bne) or BO=0b01100 (branch on CR true, e.g. beq).
    if (!lk && (bo & 0b10100u) == 0b00100u) {
        const bool branch_if_true = (bo & 0b01000u) != 0u;
        // [PM57 adjacent cmp->branch fusion] If the immediately-preceding cmp
        // deferred THIS CR field, read its operand locals directly (~3 ops)
        // instead of the pending-check+materialize path. Sound: the cmp still
        // wrote shadow+pending (backs any cross-block/later reader); this only
        // shortcuts the adjacent consumer. SO (bit 3) is never operand-derivable
        // (comes from XER, frozen in shadow.so) — leave it to emit_crbit_test.
        const u32 field_idx    = bi / 4u;
        const u32 bit_in_field = bi % 4u;
        if (fuse && fuse->valid && fuse->crfd == field_idx && bit_in_field != 3u)
            emit_crbit_fused(wb, *fuse, bit_in_field);
        else
            emit_crbit_test(wb, ctx_ptr, bi);
        if (!branch_if_true) wb.op_i32_eqz();        // invert: stack=1 iff taken
        wb.op_if();
            emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::PC, target);
            // [coalesce] mid-block: taken drains a pending GP write + returns to
            // the dispatcher; the not-taken arm stores nothing and the block
            // continues with the fall-through instructions.
            if (!is_terminal) emit_coalesced_taken_exit(wb, ctx_ptr, merged, region_gen,
                                                        chain_tag_addr, chain_slot_addr,
                                                        chain_tag_sym, chain_slot_sym);
        if (is_terminal) {
            wb.op_else();
            emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::PC, fallthrough);
        }
        wb.op_end();
        return;
    }

    // Genuinely rare forms (LK conditional calls; exotic CTR+CR combos):
    // fall back to the interpreter (unchanged behavior). ppc_state.pc is
    // written by interp; these terminals still rely on that path.
    wb.op_i32_const((s32)inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(WIMPORT_INTERP);
}

// ---------------------------------------------------------------------------
// emit_bcx_fused — [PM53h int-fusion] terminal bcx of a FUSED integer
// self-loop. Same head flush + condition evaluation as emit_bcx (the in-loop
// full rc.Flush is LOAD-BEARING: it makes the back-edge's runtime state
// satisfy the head's compile-time state — dirty=false everywhere — for free).
// The taken arm, instead of storing PC for the epilogue chain, re-enters the
// enclosing wasm loop via br after a 3-term guard (downcount>0 &&
// Exceptions==0 && dispatch-tag still names this block: PM47 liveness
// parity — the non-fused path re-probes the cache every chain hop, so the
// fused loop must not outlive an eviction). Guard order is TEST-THEN-CHARGE:
// the entry charge covered iteration 1; the back-edge charges the NEXT
// iteration only when it will actually run (charging before the test would
// overcharge every bail by one block of cycles — a systematic guest-timing
// skew at every slice boundary). Bail paths land bit-identical ctx state to
// the non-fused arms (taken: PC=target; not-taken: PC=fallthrough) and fall
// out of the loop into the unchanged epilogue.
// Caller guarantees (prescan_int_self_loop): AA=0, LK=0, BO is bdnz/bdz or a
// native CR-bit form, no FPRs anywhere in the block.
void emit_bcx_fused(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                    const CodeOp& op, u32 ctx_ptr, u32 charge,
                    u32 loop_head_depth, bool block_has_store,
                    u32 tag_addr, u32 start_pc, const CmpFuse* fuse, bool fp_resident,
                    u32 tag_sentinel) {
    const u32  inst = op.inst;
    const u32  bo   = GekkoOperands::BO(inst);
    const u32  bi   = GekkoOperands::BI(inst);
    const s32  bd   = GekkoOperands::BD(inst);
    const u32  target      = (u32)((s32)op.address + bd);
    const u32  fallthrough = op.address + 4u;
    constexpr u32 LOCAL_TMP_A = 0u;

    rc.Flush(ctx_ptr);
    // [WS-1 STEP-3 store-residency] fp_resident keeps the assumed/body v128s
    // resident across the op_br back-edge (wasm locals persist) — the loop-exit
    // epilogue flushes them, and SetForceFlush(assumed) covers host-visible
    // points inside the loop. Non-resident (int_fused): pre-scan admits no FPRs,
    // so this stays the original compile-time no-op.
    if (!fp_resident) frc.Flush(ctx_ptr);

    // Condition -> stack 1 iff taken. Mirrors emit_bcx's native forms.
    if (bo == 0b10000u || bo == 0b10010u) {
        const bool is_bdnz = (bo == 0b10000u);
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load(ppc_off::ctr_off());
        wb.op_i32_const(1);
        wb.op_i32_sub();
        wb.op_local_tee(LOCAL_TMP_A);
        wb.op_i32_store(ppc_off::ctr_off());        // CTR := CTR - 1
        wb.op_local_get(LOCAL_TMP_A);
        wb.op_i32_const(0);
        if (is_bdnz) wb.op_i32_ne(); else wb.op_i32_eq();
    } else {
        // [PM57 cmp-fuse] fuse the terminal CR-bit test against the preceding
        // cmp's operand locals (the IDCT self-chain's cmpw;bne idiom) — same
        // predicate/soundness as emit_bcx's arm; SO (bit 3) never fused.
        const u32 field_idx    = bi / 4u;
        const u32 bit_in_field = bi % 4u;
        if (fuse && fuse->valid && fuse->crfd == field_idx && bit_in_field != 3u)
            emit_crbit_fused(wb, *fuse, bit_in_field);
        else
            emit_crbit_test(wb, ctx_ptr, bi);
        if ((bo & 0b01000u) == 0u) wb.op_i32_eqz(); // branch-if-false form
    }
    wb.op_if();                                     // TAKEN
        if (block_has_store) {
            // Per-iteration gather-drain parity: the non-fused path drains
            // once per block execution (epilogue); the fused loop must not
            // accumulate GP chunks across iterations. No-op when clean.
            emit_gp_dirty_addr(wb);
            wb.op_i32_load(0);
            wb.op_if();
                wb.op_i32_const(0);
                wb.op_i32_const(0);
                wb.op_call(WIMPORT_GATHER_DRAIN);
            wb.op_end();
        }
        // Back-edge guard.
        wb.op_i32_const((s32)ctx_ptr); wb.op_i32_load(ppc_off::DOWNCOUNT);
        wb.op_i32_const(0); wb.op_i32_gt_s();
        wb.op_i32_const((s32)ctx_ptr); wb.op_i32_load(ppc_off::EXCEPTIONS);
        wb.op_i32_eqz();
        wb.op_i32_and();
        // [AOT v4 reloc] tag const: sentinel + record when offline (sym/addend
        // ride pre-encoded in tag_sentinel; see ppc_emit.cpp caller).
        if (tag_sentinel)
            wb.op_i32_const_reloc((u16)((tag_sentinel >> 24) & 0x0Fu),
                                  tag_sentinel & 0x00FFFFFFu, tag_sentinel);
        else
            wb.op_i32_const((s32)tag_addr);
        wb.op_i32_load(0);
        wb.op_i32_const((s32)start_pc); wb.op_i32_eq();
        wb.op_i32_and();
        wb.op_if();
            wb.op_i32_const((s32)ctx_ptr);          // DOWNCOUNT -= charge
            wb.op_i32_const((s32)ctx_ptr);
            wb.op_i32_load(ppc_off::DOWNCOUNT);
            wb.op_i32_const((s32)charge);
            wb.op_i32_sub();
            wb.op_i32_store(ppc_off::DOWNCOUNT);
            // [MIPS meter] executed cycles += charge on each fused-loop iteration.
            if (bem_mips_census_on()) {
                wb.op_i32_const((s32)BEM_MIPS_EXEC_CELL);
                wb.op_i32_const((s32)BEM_MIPS_EXEC_CELL);
                wb.op_i32_load(0);
                wb.op_i32_const((s32)charge);
                wb.op_i32_add();
                wb.op_i32_store(0);
            }
            wb.op_br(wb.ctrlDepth() - loop_head_depth);   // continue the loop
        wb.op_end();
        // Bail: exactly the non-fused taken arm's residue.
        emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::PC, target);
    wb.op_else();
        emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::PC, fallthrough);
    wb.op_end();
}

// ---------------------------------------------------------------------------
// emit_bclrx — branch to LR.
//   BO=20 case (unconditional): pc = LR & ~3; (if LK) LR = pc+4;
//   Other BO values fall back to WIMPORT_INTERP.
// ---------------------------------------------------------------------------
void emit_bclrx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 bo   = GekkoOperands::BO(inst);
    const bool lk  = GekkoOperands::LK(inst);

    rc.Flush(ctx_ptr);
    frc.Flush(ctx_ptr);

    if (bo == 20) {
        // Read LR into a temp, AND ~3, store to PC.
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load(ppc_off::lr_off());
        wb.op_i32_const(~3);
        wb.op_i32_and();
        wb.op_i32_store(ppc_off::PC);
        if (lk) {
            emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::lr_off(),
                                    op.address + 4);
        }
        return;
    }
    wb.op_i32_const((s32)inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(WIMPORT_INTERP);
}

// ---------------------------------------------------------------------------
// emit_bcctrx — branch to CTR.
//   BO[2]=1 (no CTR test): pc = CTR & ~3; (if LK) LR = pc+4;
//   BO[2]=0 fallback (CTR test path is unusual — interp).
// ---------------------------------------------------------------------------
void emit_bcctrx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                 u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 bo   = GekkoOperands::BO(inst);
    const bool lk  = GekkoOperands::LK(inst);
    // BO bit 2 selects whether CTR is tested. PowerPC encoding has BO bit
    // numbering reversed from natural; "BO[2]=1" in the spec means bit 2
    // from the high end in a 5-bit field = (bo & 0x04).
    const bool no_ctr_test = (bo & 0x04) != 0;
    const bool no_cr_test  = (bo & 0x10) != 0;

    rc.Flush(ctx_ptr);
    frc.Flush(ctx_ptr);

    if (no_ctr_test && no_cr_test) {
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load(ppc_off::ctr_off());
        wb.op_i32_const(~3);
        wb.op_i32_and();
        wb.op_i32_store(ppc_off::PC);
        if (lk) {
            emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::lr_off(),
                                    op.address + 4);
        }
        return;
    }
    wb.op_i32_const((s32)inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(WIMPORT_INTERP);
}

// ---------------------------------------------------------------------------
// emit_rfi — Return From Interrupt. Restores PC from SRR0, MSR from SRR1.
// Phase 4 part 2 fallbacks entirely: the MSR transition can flip EE which
// requires the dispatcher's exception-check path to run before the next
// block. Inlining this safely needs the WIMPORT_CHECK_EXC integration that
// Phase 4 part 3 wires in.
// ---------------------------------------------------------------------------
void emit_rfi(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
              u32 ctx_ptr) {
    rc.Flush(ctx_ptr);
    frc.Flush(ctx_ptr);
    wb.op_i32_const((s32)op.inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(WIMPORT_INTERP);
    // [EDGE-DIET 13h] rfi restored MSR from SRR1 (may flip EE=1 with an IRQ pending).
    // The edge predicate no longer checks maskable exceptions, so deliver here — the
    // WIMPORT_CHECK_EXC integration the original comment noted this op needs. Stack-
    // neutral (const +1, call -1+1, drop -1 = 0). Mirrors emit_mtmsr's check.
    wb.op_i32_const(0);
    wb.op_call(WIMPORT_CHECK_EXC);
    wb.op_drop();
}

}  // namespace bemental::powerpc

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
//
// ---------------------------------------------------------------------------
// BLR-stack mispredict diagnostic (ported from Jit64::WriteBLRExit).
// ---------------------------------------------------------------------------
// Jit64 maintains a host-stack-resident shadow of expected return PCs: every
// `bl`/`bcl`/`bclrl`/`bcctrl` (any LK=1) PUSHes the after-PC; every `blr`
// CMPs the popped value against the actual LR and routes a mismatch to
// `dispatcher_mispredicted_blr` (Jit.cpp:660-682). That mismatch path is
// what catches stack corruption that would otherwise wild-branch.
// Historical: the 0x800e5778 SAB symptom motivated this port; that PC has
// since been superseded as "the wedge" (see memory
// gamecube_first_mmio_divergence_2026_05_28).
//
// bementalJIT has no host stack to PUSH on (we're running inside a WASM
// module function with no architectural caller frame between blocks). We
// model the same logic with a 16-deep ring of u32s in the SAB diag region:
//
//   SAB[0x026B0500]              u32 ring head index (monotonic, wraps via &15)
//   SAB[0x026B0504]              u32 mismatch count (bump on bclr mismatch)
//   SAB[0x026B0508]              u32 last-mismatch site PC (the bclr address)
//   SAB[0x026B050C]              u32 last-mismatch actual SPR_LR
//   SAB[0x026B0510]              u32 last-mismatch expected (popped) value
//   SAB[0x026B0540..0x026B057F]  u32[16] ring of pushed (after-)PCs
//
// JS-side readers (dolphin-bridge worker_funcs.js / probes) can poll
// SAB[0x026B0504]/+0x0508/+0x050C/+0x0510 to print a console.warn when a
// mismatch fires. The mismatch handling chosen here is option (a) per the
// task description: ppc_state.pc still receives the actual LR (we don't
// silently rewrite the PC to a recovery target — that would mask real
// bugs in callers we haven't fixed yet), so behavior is unchanged in the
// no-corruption case. The diagnostic just makes the corruption observable.
// ---------------------------------------------------------------------------

#include "jit_branch.h"

#include "bementalJIT/types.h"
#include "bementalJIT/wasm_module_builder.h"
#include "code_op.h"
#include "common/op_info.h"
#include "ppc_analyst.h"
#include "ppc_offsets.h"
#include "reg_cache.h"

namespace bemental::powerpc {

static constexpr u32 WIMPORT_INTERP = 6;

// BLR-stack SAB layout. See header comment.
static constexpr u32 BLR_RING_HEAD       = 0x026B0500u;
static constexpr u32 BLR_MISMATCH_COUNT  = 0x026B0504u;
static constexpr u32 BLR_MISMATCH_PC     = 0x026B0508u;
static constexpr u32 BLR_MISMATCH_ACTUAL = 0x026B050Cu;
static constexpr u32 BLR_MISMATCH_EXPECT = 0x026B0510u;
static constexpr u32 BLR_RING_BASE       = 0x026B0540u;
static constexpr u32 BLR_RING_MASK       = 0x0Fu;   // 16 slots

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
// BLR-stack helpers. Both are stack-neutral on the WASM operand stack.
//
// The ring lives at a fixed SAB address (not in PowerPCState), so the only
// "context" the helpers need is the absolute SAB byte offset baked in at
// emit time. WASM i32_load/store address operands are (linear_addr + imm
// offset); we use linear_addr=0 and put the absolute address in the imm
// offset for the constant addresses, which keeps the emitted byte count
// down and lets V8's loadelim merge same-address accesses.
// ---------------------------------------------------------------------------

// emit_blr_push: push (pc+4) onto the ring. Used by any LK=1 branch.
//
// Pseudo-WASM (stack-balanced):
//   h        = load i32 @ BLR_RING_HEAD
//   slot_off = (h & 15) * 4 + BLR_RING_BASE
//   store i32 (after_pc) @ slot_off
//   store i32 (h + 1)   @ BLR_RING_HEAD
//
// Implementation: address-arithmetic in the WASM stack with literal-base
// add. The store address is `(h & 15) << 2`, then i32_store with imm
// offset BLR_RING_BASE.
static void emit_blr_push(WasmModuleBuilder& wb, u32 after_pc) {
    // Load h.
    wb.op_i32_const(0);
    wb.op_i32_load(BLR_RING_HEAD);
    // Stack: [h]
    // Compute slot byte-offset within the ring: (h & 15) << 2.
    wb.op_i32_const((s32)BLR_RING_MASK);
    wb.op_i32_and();
    wb.op_i32_const(2);
    wb.op_i32_shl();
    // Stack: [slot_off_within_ring]  (will be used as i32_store base addr;
    //         the imm-offset adds BLR_RING_BASE to reach the absolute SAB addr)
    wb.op_i32_const((s32)after_pc);
    wb.op_i32_store(BLR_RING_BASE);
    // Stack: []
    // h = h + 1.
    wb.op_i32_const(0);
    // Stack: [0]
    wb.op_i32_const(0);
    wb.op_i32_load(BLR_RING_HEAD);
    wb.op_i32_const(1);
    wb.op_i32_add();
    // Stack: [0, h+1]
    wb.op_i32_store(BLR_RING_HEAD);
}

// emit_blr_pop_and_check: pop the top of the ring; compare it against the
// runtime SPR_LR value; if mismatch, bump the diagnostic counters. Does
// NOT modify ppc_state.pc (the caller's normal `pc := LR` store still
// happens). Stack-neutral.
//
// Pseudo-WASM:
//   h_new    = (load i32 @ BLR_RING_HEAD) - 1
//   store i32 h_new @ BLR_RING_HEAD
//   slot_off = (h_new & 15) * 4 + BLR_RING_BASE
//   expected = load i32 @ slot_off
//   actual   = load i32 @ ctx.SPR[LR]
//   if (expected != actual) {
//     mismatch_count += 1
//     mismatch_pc     = site_pc
//     mismatch_actual = actual
//     mismatch_expect = expected
//   }
static void emit_blr_pop_and_check(WasmModuleBuilder& wb, u32 ctx_ptr,
                                   u32 site_pc) {
    // h_new = h - 1; store back.
    wb.op_i32_const(0);
    wb.op_i32_const(0);
    wb.op_i32_load(BLR_RING_HEAD);
    wb.op_i32_const(1);
    wb.op_i32_sub();
    wb.op_i32_store(BLR_RING_HEAD);

    // Compute slot byte-offset = (h_new & 15) << 2.
    // We need to re-read h (it was just stored) — read it back here.
    wb.op_i32_const(0);
    wb.op_i32_load(BLR_RING_HEAD);
    wb.op_i32_const((s32)BLR_RING_MASK);
    wb.op_i32_and();
    wb.op_i32_const(2);
    wb.op_i32_shl();
    // Stack: [slot_off]
    wb.op_i32_load(BLR_RING_BASE);
    // Stack: [expected]

    // Read actual SPR_LR.
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_load(ppc_off::lr_off());
    // Stack: [expected, actual]

    // Compare: if (expected != actual) ... — duplicate values via locals?
    // We don't have a free local at this layer (the rebuild emitter doesn't
    // pre-allocate scratch the way gekko_emit's EmitCtx does), so emit a
    // local-free path: keep `actual` cached by storing it to the
    // mismatch_actual slot SPECULATIVELY, then overwrite it back to 0 in
    // the no-mismatch case... cleaner is to re-load both inside the if.
    // The stack currently has [expected, actual]; ne consumes both.
    wb.op_i32_ne();
    // Stack: [cond]

    wb.op_if(/*blockType=*/0x40);  // void block
    {
        // mismatch_count += 1.
        wb.op_i32_const(0);
        wb.op_i32_const(0);
        wb.op_i32_load(BLR_MISMATCH_COUNT);
        wb.op_i32_const(1);
        wb.op_i32_add();
        wb.op_i32_store(BLR_MISMATCH_COUNT);

        // mismatch_pc = site_pc (compile-time constant).
        wb.op_i32_const(0);
        wb.op_i32_const((s32)site_pc);
        wb.op_i32_store(BLR_MISMATCH_PC);

        // mismatch_actual = actual SPR_LR.
        wb.op_i32_const(0);
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load(ppc_off::lr_off());
        wb.op_i32_store(BLR_MISMATCH_ACTUAL);

        // mismatch_expect = re-popped slot value. Note: by the time we're
        // in the if-true arm the head has already been decremented, so
        // re-reading the slot gives the same `expected` as the comparison
        // above (no other thread writes the ring).
        wb.op_i32_const(0);
        // Recompute slot_off = (h & 15) << 2.
        wb.op_i32_const(0);
        wb.op_i32_load(BLR_RING_HEAD);
        wb.op_i32_const((s32)BLR_RING_MASK);
        wb.op_i32_and();
        wb.op_i32_const(2);
        wb.op_i32_shl();
        wb.op_i32_load(BLR_RING_BASE);
        wb.op_i32_store(BLR_MISMATCH_EXPECT);
    }
    wb.op_end();
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
        // Mirror Jit64::WriteCallExit: PUSH the expected after-PC onto the
        // BLR-stack ring. The matching pop fires when this call's `blr`
        // returns. (See Jit.cpp:641-645 — PUSH(RSCRATCH2) of after.)
        emit_blr_push(wb, op.address + 4);
    }
    emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::PC, target);
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
              u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 bo   = GekkoOperands::BO(inst);

    // Flush before bail-or-take.
    rc.Flush(ctx_ptr);
    frc.Flush(ctx_ptr);

    if (bo == 20) {
        // "branch always" — equivalent to bx without LK side-effect choice.
        const u32 bd   = GekkoOperands::BD(inst);
        const bool aa  = GekkoOperands::AA(inst);
        const bool lk  = GekkoOperands::LK(inst);
        const u32 target = aa ? bd : (op.address + bd);
        if (lk) {
            emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::lr_off(),
                                    op.address + 4);
            // PUSH after-PC: bcl(LK=1) is a linked call too, same as bl.
            emit_blr_push(wb, op.address + 4);
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
        wb.op_else();
            emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::PC, fallthrough);
        wb.op_end();
        return;
    }

    // CR-bit conditional, no CTR decrement, no LK: BO=0b00100 (branch on CR
    // false, e.g. bne) or BO=0b01100 (branch on CR true, e.g. beq).
    if (!lk && (bo & 0b10100u) == 0b00100u) {
        const bool branch_if_true = (bo & 0b01000u) != 0u;
        const u32  field_idx    = bi / 4u;
        const u32  bit_in_field = bi % 4u;          // 0=LT,1=GT,2=EQ,3=SO
        // CR field is a u64 (Dolphin encoding): LT⇔hi&(1<<30), EQ⇔lo==0,
        // GT⇔!LT&&!EQ, SO⇔hi&(1<<27). Pushes 1 iff the tested bit is set.
        switch (bit_in_field) {
          case 0:  // LT
            wb.op_i32_const((s32)ctx_ptr);
            wb.op_i32_load(ppc_off::cr(field_idx) + 4u);
            wb.op_i32_const(1 << 30);
            wb.op_i32_and();
            wb.op_i32_const(0);
            wb.op_i32_ne();
            break;
          case 1:  // GT: (s64)cr_val > 0 ⇔ bit 63 clear. Per
                   // ConditionRegister.h:27-39 the u64 always has bit 32 set
                   // (PPCToInternal:50 `cr_val = 0x100000000`), so (s64)>0 is
                   // equivalent to (hi32 & 0x80000000) == 0. Matches Jit64
                   // Jit_SystemRegisters.cpp:177-179 (CMP 64 + CC_G).
                   // Pass-2 audit (w6oeq0l6e RANK 10): prior !LT&&!EQ
                   // diverged when SO is set alone (post-mtcrf PPC value 0x1,
                   // post-mcrxr).
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
        if (!branch_if_true) wb.op_i32_eqz();        // invert: stack=1 iff taken
        wb.op_if();
            emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::PC, target);
        wb.op_else();
            emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::PC, fallthrough);
        wb.op_end();
        return;
    }

    // Genuinely rare forms (LK conditional calls; exotic CTR+CR combos):
    // fall back to the interpreter (unchanged behavior). ppc_state.pc is
    // written by interp; these terminals still rely on that path.
    //
    // Note: bcx with LK=1 in the fallback path won't get a BLR-stack push.
    // That's a tolerated gap — the conditional-call idiom (`bclXX ...,LK`)
    // is rare; missing pushes only mean the ring stays in sync only when
    // the caller didn't take the LK arm.
    wb.op_i32_const((s32)inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(WIMPORT_INTERP);
}

// ---------------------------------------------------------------------------
// emit_bclrx — branch to LR.
//   BO=20 case (unconditional): pc = LR & ~3; (if LK) LR = pc+4;
//   Other BO values fall back to WIMPORT_INTERP.
//
// Jit64 parity: WriteBLRExit (Jit.cpp:660-682) CMPs the popped shadow PC
// against the actual LR and routes mismatches to dispatcher_mispredicted_blr.
// We mirror that by popping the ring + bumping mismatch diagnostics, without
// rerouting the PC (option (a) from the task brief — preserves current
// "trust LR" semantics, just makes the mismatch observable).
// ---------------------------------------------------------------------------
void emit_bclrx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op,
                u32 ctx_ptr) {
    const u32 inst = op.inst;
    const u32 bo   = GekkoOperands::BO(inst);
    const bool lk  = GekkoOperands::LK(inst);

    rc.Flush(ctx_ptr);
    frc.Flush(ctx_ptr);

    if (bo == 20) {
        // Pop + check FIRST, before mutating LR for the LK case.
        emit_blr_pop_and_check(wb, ctx_ptr, op.address);

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
            // blrl is also a linked call — push the new after-PC.
            emit_blr_push(wb, op.address + 4);
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
//
// Note: bcctr does NOT pop the BLR-stack. CTR holds the target (vtable
// dispatch / computed jump), not a return PC; this is a forward call, not
// a return. Jit64 likewise only checks the BLR stack in WriteBLRExit
// (LR path), not in bcctr.
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
            // bcctrl is a linked call — push after-PC for the matching blr.
            emit_blr_push(wb, op.address + 4);
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
}

}  // namespace bemental::powerpc

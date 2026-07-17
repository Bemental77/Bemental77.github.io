//
// ppc_emit.cpp — Phase 4 dispatch + build_block shell. Routes CodeOps
// to the right per-op emit function and produces a complete WASM
// module bytestream.
//
// Status: dispatch_op covers integer / branch / system-register / load-
// store / compare / rotate families that Phase 4 + 4.5 shipped. FP,
// paired-singles, mfcr/mtcrf, segment registers, and tlbie fall back
// to WIMPORT_INTERP.
//
// build_block_next() is a working shell that demonstrates end-to-end
// emit using the new infrastructure. It is NOT yet wired into the live
// runtime — Phase 7 cut-over flips dolphin-side build_block consumers
// to this. For now, callable for test_analyst-style harnesses.

#include "ppc_emit.h"

#include "bementalJIT/types.h"
#include "bementalJIT/wasm_module_builder.h"
#include "code_op.h"
#include "common/op_info.h"
#include "hle_prologue.h"
#include "jit_branch.h"
#include "jit_compare.h"
#include "jit_integer.h"
#include "jit_floating_point.h"
#include "jit_load_store.h"
#include "jit_paired.h"
#include "jit_system_registers.h"
#include "ppc_analyst.h"
#include "ppc_offsets.h"
#include "fpr_reg_cache.h"
#include "reg_cache.h"

// NOTE: Cannot include "../powerpc/gekko_emit.h" — both libs share the
// `bemental::powerpc` namespace and have parallel definitions for spr/gpr/
// WIMPORT_* enum / BlockInputs, causing ODR redefinition collisions.
// Until a follow-up extracts shared types to a third-party header, the
// region implementations below stay as passthroughs to the live functions
// (forward-declared inside #ifdef BEMENTALJIT_USE_REBUILD blocks below).
// Real region impls (which deref BlockInputs members and would route the
// region path entirely through powerpc-next ports) are reverted pending
// the shared-header extraction.

namespace bemental::powerpc {

static constexpr u32 WIMPORT_INTERP    = 6;
static constexpr u32 WIMPORT_CHECK_EXC = 7;
static constexpr u8  BLOCK_TYPE_VOID   = 0x40;

// In-WASM block chaining (defined in src/block_cache.cpp). Each per-block
// module imports the host __indirect_function_table and, at its epilogue,
// probes this direct-mapped pc->slot cache to return_call_indirect its
// successor instead of returning the next-PC to the JS dispatch loop.
extern "C" {
    extern uint32_t      g_bem_disp_tag[];     // [BEM_DISP_BUCKETS] guest PC / 0xFFFFFFFF
    extern int32_t       g_bem_disp_slot[];    // [BEM_DISP_BUCKETS] wasmTable index
    extern uint32_t      g_bem_rtag[];         // [region] region-local cache: PC
    extern int32_t       g_bem_rslot[];        // [region] region internal-table slot
    extern uint32_t      g_bem_mrtag[];        // [region-merged] merged-gen cache: PC
    extern int32_t       g_bem_mrslot[];       // [region-merged] PACKED (gen<<16)|br_table_idx
    extern uint32_t      g_bem_chain_exc0;     // Exceptions snapshot at chain entry
    extern unsigned char g_bem_chain_enabled;  // master A/B toggle
    extern uint32_t      g_bem_pc_exec[];       // Phase A: per-pc execution count
    extern uint32_t      g_bem_promote_ring[];  // Phase A: prologue promote ring
    extern uint32_t      g_bem_promote_n;       // Phase A: ring count
    extern unsigned char g_bem_promote_enabled; // Phase A: A/B toggle
    extern int           g_bem_gp_dirty;        // [perf] gather-pipe write pending (bridge)
}
static constexpr u32 BEM_DISP_MASK_NEXT = 0x3FFFFu;  // MUST match block_cache.cpp BEM_DISP_MASK (BEM_DISP_BITS=18)
static constexpr u32 LOCAL_TMP_A_CHAIN  = 0u;       // build_block_next i32 scratch 0
static constexpr u32 LOCAL_TMP_B_CHAIN  = 1u;       // build_block_next i32 scratch 1

// Emit the block terminal: either tail-chain to the successor block in-WASM
// (return_call_indirect via the imported table) or return the next-PC to the
// JS chain_dispatch_raw loop. Precondition: ctx.PC already holds the next-PC
// and RegCache/FPRRegCache have been flushed (successor reloads from memory).
// tag_addr_ovr/slot_addr_ovr: when non-zero, resolve the successor via a
// caller-supplied direct-mapped cache + return_call_indirect on TABLE 0 of the
// current module. The per-block path passes 0/0 -> the global g_bem_disp_*
// cache + the IMPORTED table 0. The region path passes its OWN cache addresses
// (g_bem_rtag/g_bem_rslot, holding region-local internal-table slots) -> the
// INTERNAL table 0 of the region module, which V8 inlines (same instance).
// [region-merged 2026-07-15] Context for emitting a block body INTO the merged
// single-function region (build_region_function_next). When non-null, the
// terminal's chain-hit arm re-dispatches INSIDE the region function via
// `entry_sel = k; return_call $region` instead of return_call_indirect on a
// table — V8 compiles the self-tail-call as a jump, so intra-region edges cost
// ~the microbench a2 (6.64 ns) instead of the cross-module chain (9.82 ns).
// The probe arrays are the REGION rtag/rslot; rslot values are PACKED
// (gen_idx << 16) | br_table_index so a body can tell its OWN gen's entries
// (warm: sel+return_call) from another gen's (cold: fall through to the host
// return — the host chain then enters the other gen via its global-table
// wrapper, which the microbench measured as free).
// laps: per-invocation intra-region edge counter (module global, zeroed by the
// fn_k entry wrappers). At REGION_LAP_MAX with no pending exception the edge
// forces downcount=0 and exits to the host — the in-region idle-poll escape
// (adversarial-verify wf_0ce30bf7: fully-sealed analyzer-unflagged multi-PC
// polls otherwise burn whole slices at real cycle cost, the historic JS-ring
// wedge). Threshold high enough that hot COMPUTE loops (downcount-bounded well
// below it per entry) never trip it in practice.
struct MergedRegionCtx {
    u32 gen_idx;          // this gen's index (packed-slot ownership check)
    u32 region_func_idx;  // module-local func index of $region (cold re-entry)
    u32 sel_global_idx;   // entry_sel mutable-i32 global index
    u32 laps_global_idx;  // lap-counter mutable-i32 global index
    // [region-resident 2026-07-15] Warm edges are `br` back to the region LOOP
    // (same activation — locals persist, enabling GPR residency; a return_call
    // would reset locals to zero). br immediate from an edge site =
    // bodyBuilder.ctrlDepth() + br_extra_depth, where br_extra_depth =
    // (n_blocks - k) accounts for body k's splice nesting (loop + $DEF +
    // the (n-1-k) enclosing $B blocks, minus the loop interior itself).
    u32 br_extra_depth;   // per-body splice offset (set by the merged builder)
};
static constexpr u32 REGION_LAP_MAX = 2048u;

static void emit_chain_or_return(WasmModuleBuilder& b, u32 ctx_ptr,
                                 u32 tag_addr_ovr = 0u, u32 slot_addr_ovr = 0u,
                                 const MergedRegionCtx* merged = nullptr) {
    if (!g_bem_chain_enabled) {
        b.op_i32_const((s32)ctx_ptr);
        b.op_i32_load(ppc_off::PC);
        b.op_return();
        return;
    }
    const u32 tag_addr  = tag_addr_ovr  ? tag_addr_ovr  : (u32)(uintptr_t)&g_bem_disp_tag[0];
    const u32 slot_addr = slot_addr_ovr ? slot_addr_ovr : (u32)(uintptr_t)&g_bem_disp_slot[0];
    const u32 exc0_addr = (u32)(uintptr_t)&g_bem_chain_exc0;

    // Service-point bail: return next-PC to the JS loop when the CoreTiming
    // slice is spent OR a pending exception is actually DELIVERABLE by
    // PowerPC::CheckExceptions. Verified to ~halve the SAB __fill_mem boot
    // freeze in a load-matched interleaved A/B (BASE 6/12 -> FIX 3/12,
    // 2026-06-22).
    //
    // The old form bailed on `Exceptions != g_bem_chain_exc0` (chain-entry
    // snapshot). For a block reached by in-WASM tail-chain that snapshot is the
    // PREDECESSOR's (stale): a masked async IRQ (SI EXTERNAL_INT posted while
    // MSR.EE=0) made Exceptions(0x4) != exc0(0) fire, so the predecessor bailed
    // BEFORE tail-chaining into its successor — SAB's __fill_mem arena clear
    // then made zero forward progress and never reached OSEnableInterrupts to
    // unmask the IRQ (the nondeterministic boot freeze). CheckExternalExceptions
    // is a no-op while EE=0 (PowerPC.cpp:598), so bailing there was pure waste.
    //
    // Deliverable = (any non-maskable/synchronous exception pending) OR
    //   (a maskable IRQ pending AND MSR.EE=1) — matches CheckExceptions exactly
    //   and removes the stale-snapshot HEAD/TAIL asymmetry.
    constexpr s32 EXC_SYNC     = 0x2FA;   // SYSCALL|DSI|ISI|ALIGN|FPU|PROGRAM|FAKE_MEMCHECK
    constexpr s32 EXC_MASKABLE = 0x105;   // DECREMENTER|EXTERNAL_INT|PERFORMANCE_MONITOR
    constexpr s32 MSR_EE       = 0x8000;
    (void)exc0_addr;
    // [a] downcount <= 0
    b.op_i32_const((s32)ctx_ptr); b.op_i32_load(ppc_off::DOWNCOUNT);
    b.op_i32_const(0); b.op_i32_le_s();
    // [b] (Exceptions & EXC_SYNC) != 0
    b.op_i32_const((s32)ctx_ptr); b.op_i32_load(ppc_off::EXCEPTIONS);
    b.op_i32_const(EXC_SYNC); b.op_i32_and();
    b.op_i32_const(0); b.op_i32_ne();
    b.op_i32_or();
    // [c] (Exceptions & EXC_MASKABLE) != 0  AND  (MSR & MSR_EE) != 0
    b.op_i32_const((s32)ctx_ptr); b.op_i32_load(ppc_off::EXCEPTIONS);
    b.op_i32_const(EXC_MASKABLE); b.op_i32_and();
    b.op_i32_const(0); b.op_i32_ne();
    b.op_i32_const((s32)ctx_ptr); b.op_i32_load(ppc_off::MSR);
    b.op_i32_const(MSR_EE); b.op_i32_and();
    b.op_i32_const(0); b.op_i32_ne();
    b.op_i32_and();
    b.op_i32_or();
    b.op_if(BLOCK_TYPE_VOID);
        b.op_i32_const((s32)ctx_ptr); b.op_i32_load(ppc_off::PC); b.op_return();
    b.op_end();

    // [vector-page guard 2026-07-09, INVARIANT-KEYED 2026-07-09-pm] Never tail-chain
    // INTO an exception vector (pc < 0x4000) WHEN THE CARRIED MSR HAS IR SET (0x20).
    // The crash was a chain/rfi into the vector carrying a translated-mode MSR (rfi
    // output 0x1030, IR=1): the vector INSTRUCTION fetch then translates and faults
    // (ISI at 0x594). Guard the INVARIANT (MSR.IR = fetch translation state), NOT the
    // geography — an earlier PC<0x4000-only guard OVER-FIRED on LEGIT real-mode stub
    // execution (msr=0x1000, IR=0), stranding the worker re-dispatching 0x500 forever
    // (the 0x500 dispatch-spin face, autopsied 2026-07-09: block runs, next=0x500).
    // At IR=0 the vector is fetched physical (real-mode, correct) — let it chain
    // natively so the stub advances to its handler. At IR=1, force the JS dispatch
    // loop (CheckExternalExceptions/delivery clears IR to real-mode).
    b.op_i32_const((s32)ctx_ptr); b.op_i32_load(ppc_off::PC);
    b.op_i32_const(0x4000); b.op_i32_lt_u();                 // (PC < 0x4000) -> 0/1
    b.op_i32_const((s32)ctx_ptr); b.op_i32_load(ppc_off::MSR);
    b.op_i32_const(0x20); b.op_i32_and();                    // MSR & IR(0x20) -> 0/0x20
    b.op_i32_const(0); b.op_i32_ne();                        // -> 0/1 (normalize before AND)
    b.op_i32_and();                                          // (PC<0x4000) AND (IR set)
    b.op_if(BLOCK_TYPE_VOID);
        b.op_i32_const((s32)ctx_ptr); b.op_i32_load(ppc_off::PC); b.op_return();
    b.op_end();

    // bucket byte-offset = ((PC>>2) & MASK) * 4 ; keep PC in TMP_A, byteoff in TMP_B
    b.op_i32_const((s32)ctx_ptr); b.op_i32_load(ppc_off::PC);
    b.op_local_tee(LOCAL_TMP_A_CHAIN);
    b.op_i32_const(2); b.op_i32_shr_u();
    b.op_i32_const((s32)BEM_DISP_MASK_NEXT); b.op_i32_and();
    b.op_i32_const(4); b.op_i32_mul();
    b.op_local_tee(LOCAL_TMP_B_CHAIN);
    // tag hit?  g_bem_disp_tag[bucket] == PC
    b.op_i32_const((s32)tag_addr); b.op_i32_add(); b.op_i32_load(0);
    b.op_local_get(LOCAL_TMP_A_CHAIN); b.op_i32_eq();
    b.op_if(BLOCK_TYPE_VOID);
        // slot = g_bem_disp_slot[bucket]; if slot >= 0 → dispatch
        b.op_i32_const((s32)slot_addr); b.op_local_get(LOCAL_TMP_B_CHAIN);
        b.op_i32_add(); b.op_i32_load(0);
        b.op_local_tee(LOCAL_TMP_A_CHAIN);
        b.op_i32_const(0); b.op_i32_ge_s();
        b.op_if(BLOCK_TYPE_VOID);
        if (merged) {
            // [region-merged] slot is PACKED (gen<<16)|k. Own-gen hit → warm
            // in-function re-dispatch; other gen → fall through to the host
            // return (its global-table wrapper is a free tail-chain away).
            b.op_local_get(LOCAL_TMP_A_CHAIN);
            b.op_i32_const(16); b.op_i32_shr_u();
            b.op_i32_const((s32)merged->gen_idx); b.op_i32_eq();
            b.op_if(BLOCK_TYPE_VOID);
                // laps++
                b.op_global_get(merged->laps_global_idx);
                b.op_i32_const(1); b.op_i32_add();
                b.op_global_set(merged->laps_global_idx);
                // laps < REGION_LAP_MAX → warm edge
                b.op_global_get(merged->laps_global_idx);
                b.op_i32_const((s32)REGION_LAP_MAX); b.op_i32_lt_u();
                b.op_if(BLOCK_TYPE_VOID);
                    b.op_local_get(LOCAL_TMP_A_CHAIN);
                    b.op_i32_const(0xFFFF); b.op_i32_and();
                    b.op_global_set(merged->sel_global_idx);
                    // [region-resident] warm edge = br back to the region LOOP:
                    // same activation, GPR locals persist (a return_call would
                    // zero them). Depth = body-relative nesting + splice offset.
                    b.op_br(b.ctrlDepth() + merged->br_extra_depth);
                b.op_end();
                // lap threshold: in-region idle-poll escape. With no pending
                // exception, force downcount=0 so the host slice ends and
                // CoreTiming::Advance fires the awaited event (VI/DSP/timer)
                // instead of the poll burning the whole slice at cycle cost.
                b.op_i32_const((s32)ctx_ptr); b.op_i32_load(ppc_off::EXCEPTIONS);
                b.op_i32_eqz();
                b.op_if(BLOCK_TYPE_VOID);
                    b.op_i32_const((s32)ctx_ptr); b.op_i32_const(0);
                    b.op_i32_store(ppc_off::DOWNCOUNT);
                b.op_end();
                // fall through → global-table chain / host return below
            b.op_end();
        } else {
            b.op_local_get(LOCAL_TMP_A_CHAIN);       // table index operand
            b.op_return_call_indirect(/*typeIdx*/0, /*tableIdx*/0);
        }
        b.op_end();
    b.op_end();

    if (merged) {
        // [cross-gen fix 2026-07-15] mrtag miss / other-gen / lap-overflow-with-
        // pending-exception land here. Probe the STANDARD global dispatch cache
        // (g_bem_disp_tag/slot) and return_call_indirect on the imported global
        // table — chaining IN-WASM to the other gen's wrapper, an unsealed
        // per-block module, or anything else registered, exactly like a normal
        // block epilogue. Without this every such exit was a host bounce
        // (measured: promote-ON -25% aggregate on the 300s chain A/B).
        const u32 gtag  = (u32)(uintptr_t)&g_bem_disp_tag[0];
        const u32 gslot = (u32)(uintptr_t)&g_bem_disp_slot[0];
        b.op_i32_const((s32)ctx_ptr); b.op_i32_load(ppc_off::PC);
        b.op_local_tee(LOCAL_TMP_A_CHAIN);
        b.op_i32_const(2); b.op_i32_shr_u();
        b.op_i32_const((s32)BEM_DISP_MASK_NEXT); b.op_i32_and();
        b.op_i32_const(4); b.op_i32_mul();
        b.op_local_tee(LOCAL_TMP_B_CHAIN);
        b.op_i32_const((s32)gtag); b.op_i32_add(); b.op_i32_load(0);
        b.op_local_get(LOCAL_TMP_A_CHAIN); b.op_i32_eq();
        b.op_if(BLOCK_TYPE_VOID);
            b.op_i32_const((s32)gslot); b.op_local_get(LOCAL_TMP_B_CHAIN);
            b.op_i32_add(); b.op_i32_load(0);
            b.op_local_tee(LOCAL_TMP_A_CHAIN);
            b.op_i32_const(0); b.op_i32_ge_s();
            b.op_if(BLOCK_TYPE_VOID);
                b.op_local_get(LOCAL_TMP_A_CHAIN);
                b.op_return_call_indirect(/*typeIdx*/0, /*tableIdx*/0);
            b.op_end();
        b.op_end();
    }

    // No chain (bail / tag miss / freed slot): return next-PC to the JS loop.
    b.op_i32_const((s32)ctx_ptr); b.op_i32_load(ppc_off::PC); b.op_return();
}

// Emit a fallback call to WIMPORT_INTERP for an op without a native
// emitter. Flushes regcache (dirty wasm locals → PowerPCState memory) so
// the interp sees current GPR state, calls into single-step, then
// RELOADS all assigned cache locals from memory so subsequent ops in the
// same block see the post-interp GPR values. Without the reload, a later
// op's Flush at block exit overwrites the interp's writes with stale
// local values — observed 2026-05-31 as r28-r31 corruption in
// __OSCacheInit's lmw-restore sequence, which zeroed r31 in
// __init_hardware's saved-LR slot and made blr return to PC=0.
//
// Pass-2 audit (w6oeq0l6e RANK 6): for ops that can raise a precise
// exception (canCauseException — FP-unavailable / FP exceptions / div),
// invoke CHECK_EXC after the interp call. CheckExceptionsFromJIT
// transitions PC to the vector if an exception was delivered. We detect
// this by comparing PC to op.address+4 (the normal fallthrough); if it
// differs, exit the block so the dispatcher routes through the new PC.
// Without this, a falling-back op that raised an exception left PC at
// the vector but subsequent ops in the same block kept running with
// stale ppc_state.
static void emit_fallback(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                          const CodeOp& op, u32 ctx_ptr) {
    // [set_pc-gate] The pre-op set_pc is now skipped for native non-block-ending
    // ops, so a fallback op must write its OWN pc here — the dolphin_interp guard
    // (if ppc_state.pc != pc) bails otherwise, and CHECK_EXC's SRR0 below needs it.
    wb.op_i32_const((s32)ctx_ptr);
    wb.op_i32_const((s32)op.address);
    wb.op_i32_store(ppc_off::PC);
    // FPR cache must flush BEFORE the interp call (interp reads ps[] from
    // PowerPCState directly), and reload AFTER (interp may have mutated
    // ps[] — any FP op fallback, OSContext save/restore via interp). Same
    // class as the GPR fallback fix at commit 65be5fd.
    rc.Flush(ctx_ptr);
    frc.Flush(ctx_ptr);
    wb.op_i32_const((s32)op.inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(WIMPORT_INTERP);

    if (op.canCauseException) {
        wb.op_i32_const((s32)op.address);
        wb.op_call(WIMPORT_CHECK_EXC);
        wb.op_drop();  // CHECK_EXC reserved i32 return
        wb.op_i32_const((s32)ctx_ptr);
        wb.op_i32_load(ppc_off::PC);
        wb.op_i32_const((s32)(op.address + 4u));
        wb.op_i32_ne();
        wb.op_if(BLOCK_TYPE_VOID);
            // Pass-3 audit: must drain GPU gather-pipe before early-exit
            // (FIX 9's normal-epilogue drain is bypassed by op_return). A
            // fallback stw to 0xCC008000 (FL_LOADSTORE → canCauseException)
            // followed by DSI would otherwise leave the FIFO undrained.
            wb.op_i32_const(0);
            wb.op_i32_const(0);
            wb.op_call(WIMPORT_GATHER_DRAIN);
            wb.op_i32_const((s32)ctx_ptr);
            wb.op_i32_load(ppc_off::PC);
            wb.op_return();
        wb.op_end();
    }

    rc.ReloadAll(ctx_ptr);
    frc.ReloadAll(ctx_ptr);
}

bool dispatch_op(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 const CodeOp& op, LoadStoreParams params) {
    const u32 inst  = op.inst;
    const u32 opcd  = GekkoOperands::OPCD(inst);
    const u32 sub10 = GekkoOperands::SUBOP10(inst);

    switch (opcd) {
    // ---- D-form integer / logical ----
    case 7:  emit_mulli  (wb, rc, frc, op);                       return true;
    case 8:  emit_subfic (wb, rc, frc, op, params.ctx_ptr);       return true;
    case 10: emit_cmpli  (wb, rc, frc, op, params.ctx_ptr);       return true;
    case 11: emit_cmpi   (wb, rc, frc, op, params.ctx_ptr);       return true;
    case 12: emit_addic    (wb, rc, frc, op, params.ctx_ptr);     return true;
    case 13: emit_addic_rc (wb, rc, frc, op, params.ctx_ptr);     return true;
    case 14: emit_addi     (wb, rc, frc, op);                     return true;
    case 15: emit_addis  (wb, rc, frc, op);                       return true;
    case 24: emit_ori    (wb, rc, frc, op);                       return true;
    case 25: emit_oris   (wb, rc, frc, op);                       return true;
    case 26: emit_xori   (wb, rc, frc, op);                       return true;
    case 27: emit_xoris  (wb, rc, frc, op);                       return true;
    case 28: emit_andix  (wb, rc, frc, op, params.ctx_ptr);       return true;
    case 29: emit_andisx (wb, rc, frc, op, params.ctx_ptr);       return true;

    // ---- D-form loads ----
    case 32: emit_load_d (wb, rc, frc, params, op, LoadWidth::U32, false); return true;
    case 33: emit_load_d (wb, rc, frc, params, op, LoadWidth::U32, true);  return true;
    case 34: emit_load_d (wb, rc, frc, params, op, LoadWidth::U8,  false); return true;
    case 35: emit_load_d (wb, rc, frc, params, op, LoadWidth::U8,  true);  return true;
    case 40: emit_load_d (wb, rc, frc, params, op, LoadWidth::U16, false); return true;
    case 41: emit_load_d (wb, rc, frc, params, op, LoadWidth::U16, true);  return true;
    case 42: emit_load_d (wb, rc, frc, params, op, LoadWidth::S16, false); return true;
    case 43: emit_load_d (wb, rc, frc, params, op, LoadWidth::S16, true);  return true;

    // ---- D-form load-multiple / store-multiple (opc 46/47) ----
    // Native emit per mp4_wedge_is_throughput_2026_06_07: every
    // gcsetjmp/gclongjmp pays one lmw + one stmw (RD=13, 19 words each)
    // via interp fallback on every protothread context switch.
    case 46: emit_lmw    (wb, rc, frc, params, op);                          return true;
    case 47: emit_stmw   (wb, rc, frc, params, op);                          return true;

    // ---- D-form stores ----
    case 36: emit_store_d(wb, rc, frc, params, op, StoreWidth::U32, false); return true;
    case 37: emit_store_d(wb, rc, frc, params, op, StoreWidth::U32, true);  return true;
    case 38: emit_store_d(wb, rc, frc, params, op, StoreWidth::U8,  false); return true;
    case 39: emit_store_d(wb, rc, frc, params, op, StoreWidth::U8,  true);  return true;
    case 44: emit_store_d(wb, rc, frc, params, op, StoreWidth::U16, false); return true;
    case 45: emit_store_d(wb, rc, frc, params, op, StoreWidth::U16, true);  return true;

    // ---- Rotate / mask ----
    case 20: emit_rlwimix(wb, rc, frc, op, params.ctx_ptr);       return true;
    case 21: emit_rlwinmx(wb, rc, frc, op, params.ctx_ptr);       return true;
    case 23: emit_rlwnmx (wb, rc, frc, op, params.ctx_ptr);       return true;

    // ---- Branch (D-form) ----
    case 16: emit_bcx    (wb, rc, frc, op, params.ctx_ptr);       return true;
    case 18: emit_bx     (wb, rc, frc, op, params.ctx_ptr);       return true;

    case 19:
        switch (sub10) {
        case 16:  emit_bclrx (wb, rc, frc, op, params.ctx_ptr);   return true;
        case 528: emit_bcctrx(wb, rc, frc, op, params.ctx_ptr);   return true;
        case 50:  emit_rfi   (wb, rc, frc, op, params.ctx_ptr);   return true;
        case 150: /* isync */                                return true;
        default:  break;
        }
        break;

    case 31:
        switch (sub10) {
        // X-form integer — all FL_RC_BIT, ctx_ptr threaded for CR0 update.
        case 266: case 778: emit_addx  (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 40:  case 552: emit_subfx (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 235: case 747: emit_mullwx(wb, rc, frc, op, params.ctx_ptr);       return true;
        // X-form carry arithmetic (OE-suffix variants share emit; OV/SO untracked).
        case 10:  case 522: emit_addcx (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 8:   case 520: emit_subfcx(wb, rc, frc, op, params.ctx_ptr);       return true;
        // X-form wide multiply (high half).
        case 75:            emit_mulhwx (wb, rc, frc, op, params.ctx_ptr);      return true;
        case 11:            emit_mulhwux(wb, rc, frc, op, params.ctx_ptr);      return true;
        // X-form integer divide (guarded).
        case 491: case 1003: emit_divwx (wb, rc, frc, op, params.ctx_ptr);      return true;
        case 459: case 971:  emit_divwux(wb, rc, frc, op, params.ctx_ptr);      return true;
        case 28:            emit_andx  (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 60:            emit_andcx (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 444:           emit_orx   (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 316:           emit_xorx  (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 124:           emit_norx  (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 476:           emit_nandx (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 284:           emit_eqvx  (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 412:           emit_orcx  (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 24:            emit_slwx  (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 536:           emit_srwx  (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 792:           emit_srawx (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 824:           emit_srawix(wb, rc, frc, op, params.ctx_ptr);       return true;
        case 954:           emit_extsbx(wb, rc, frc, op, params.ctx_ptr);       return true;
        case 922:           emit_extshx(wb, rc, frc, op, params.ctx_ptr);       return true;
        case 26:            emit_cntlzwx(wb, rc, frc, op, params.ctx_ptr);      return true;
        case 104: case 616: emit_negx  (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 138: case 650: emit_addex (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 136: case 648: emit_subfex(wb, rc, frc, op, params.ctx_ptr);       return true;
        case 234: case 746: emit_addmex(wb, rc, frc, op, params.ctx_ptr);       return true;
        case 232: case 744: emit_subfmex(wb, rc, frc, op, params.ctx_ptr);      return true;
        case 202: case 714: emit_addzex(wb, rc, frc, op, params.ctx_ptr);       return true;
        case 200: case 712: emit_subfzex(wb, rc, frc, op, params.ctx_ptr);      return true;
        case 0:             emit_cmp   (wb, rc, frc, op, params.ctx_ptr);       return true;
        case 32:            emit_cmpl  (wb, rc, frc, op, params.ctx_ptr);       return true;

        // X-form loads
        case 23:  emit_load_x (wb, rc, frc, params, op, LoadWidth::U32, false); return true;
        case 55:  emit_load_x (wb, rc, frc, params, op, LoadWidth::U32, true);  return true;
        case 87:  emit_load_x (wb, rc, frc, params, op, LoadWidth::U8,  false); return true;
        case 119: emit_load_x (wb, rc, frc, params, op, LoadWidth::U8,  true);  return true;
        case 279: emit_load_x (wb, rc, frc, params, op, LoadWidth::U16, false); return true;
        case 311: emit_load_x (wb, rc, frc, params, op, LoadWidth::U16, true);  return true;
        case 343: emit_load_x (wb, rc, frc, params, op, LoadWidth::S16, false); return true;
        case 375: emit_load_x (wb, rc, frc, params, op, LoadWidth::S16, true);  return true;

        // X-form stores
        case 151: emit_store_x(wb, rc, frc, params, op, StoreWidth::U32, false); return true;
        case 183: emit_store_x(wb, rc, frc, params, op, StoreWidth::U32, true);  return true;
        case 215: emit_store_x(wb, rc, frc, params, op, StoreWidth::U8,  false); return true;
        case 247: emit_store_x(wb, rc, frc, params, op, StoreWidth::U8,  true);  return true;
        case 407: emit_store_x(wb, rc, frc, params, op, StoreWidth::U16, false); return true;
        case 439: emit_store_x(wb, rc, frc, params, op, StoreWidth::U16, true);  return true;

        // FP X-form indexed load/store (lfsx 535, stfsx 663, stfiwx 983).
        case 535: emit_lfsx  (wb, rc, frc, params, op);                          return true;
        case 663: emit_stfsx (wb, rc, frc, params, op);                          return true;
        case 983: emit_stfiwx(wb, rc, frc, params, op);                          return true;

        // System registers
        case 339: emit_mfspr(wb, rc, frc, op, params.ctx_ptr);                  return true;
        case 467: emit_mtspr(wb, rc, frc, op, params.ctx_ptr);                  return true;
        case 83:  emit_mfmsr(wb, rc, frc, op, params.ctx_ptr);                  return true;
        case 146: emit_mtmsr(wb, rc, frc, op, params.ctx_ptr);                  return true;
        // Time-base read (direct SPR slot — no CoreTiming).
        case 371: emit_mftb  (wb, rc, frc, op, params.ctx_ptr);                 return true;
        // CR pack/unpack — interp fallback (CR-encoding non-trivial).
        case 19:  emit_mfcr  (wb, rc, frc, op, params.ctx_ptr);                 return true;
        case 144: emit_mtcrf (wb, rc, frc, op, params.ctx_ptr);                 return true;
        // Segment register access / TLB invalidate — interp fallback
        // (privileged MMU ops; rare and block-ending).
        case 210: emit_mtsr  (wb, rc, frc, op, params.ctx_ptr);                 return true;
        case 242: emit_mtsrin(wb, rc, frc, op, params.ctx_ptr);                 return true;
        case 306: emit_tlbie (wb, rc, frc, op, params.ctx_ptr);                 return true;
        case 595: emit_mfsr  (wb, rc, frc, op, params.ctx_ptr);                 return true;
        case 659: emit_mfsrin(wb, rc, frc, op, params.ctx_ptr);                 return true;

        // dcbz — 32-byte zero block. Memset/__fill_mem hot path.
        case 1014: emit_dcbz(wb, rc, frc, op, params);                          return true;

        // Sync / DATA-cache barriers / hints — emit nothing. The linear
        // memory model has no real data cache to flush/invalidate/prefetch.
        //   598 sync/lwsync, 854 eieio, 86 dcbf, 54 dcbst, 470 dcbi,
        //   278 dcbt, 246 dcbtst.
        case 598: case 854:
        case 86:  case 54:  case 470:
        case 278: case 246:
            return true;

        // icbi — interp fallback so the full invalidation plumbing runs
        // (Interpreter::icbi -> iCache.Invalidate -> JitInterface ->
        // JitWasm wasm-block range evict). FL_ENDBLOCK in the opinfo ends
        // the block after it. NOT a nop: the wasm block cache IS the
        // instruction cache (2026-06-11 PSO switcher->PsoV3 handoff bug).
        case 982:
            emit_fallback(wb, rc, frc, op, params.ctx_ptr);
            return false;

        default: break;
        }
        break;

    // ---- FP D-form load/store + PS D-form indexed memory + FP arith ----
    // Phase 4 routes all FP / PS ops to WIMPORT_INTERP. ppc_tables.cpp now
    // classifies these with FL_USE_FPU / FL_LOADSTORE / FL_IN_FLOAT_* so
    // the analyzer keeps the block intact across long stfd/lfd chains in
    // OSContext save/restore (per gsne8p.map: __OSLoadFPUContext 0x800e5388
    // — 0x800e54ab, __OSSaveFPUContext 0x800e54ac — 0x800e55d3, and the
    // ~70 stfd/psq_st pair in OSFillFPUContext referenced by OSContext.c
    // :566-643). Without this classification the analyzer broke at the
    // first FP op, yielding 1-op blocks of pure FPU loadstores with no
    // dispatch amortization. Once Phase 5 ports the per-op FP emitters
    // from guests/powerpc/gekko_emit.cpp (emit_lfs_impl..emit_fmaddx_impl
    // at ~line 2706..3150), the dispatch cases here can call them
    // directly. Until then, fallthrough.
    //   48-55 = lfs/lfsu/lfd/lfdu/stfs/stfsu/stfd/stfdu (FP D-form)
    //   56-57 = psq_l/psq_lu                            (PS D-form load)
    //   60-61 = psq_st/psq_stu                          (PS D-form store)
    //   4     = paired-singles subtable (handled by analyzer/table4)
    //   59    = single-precision FP arith subtable
    //   63    = double-precision FP + system-FP subtable
    case 4: {
        // Opcode-4 trivial paired-singles ops — native emit. Per FP audit
        // researcher 2026-06-08 + mp4_wedge_is_throughput_2026_06_07:
        // dominates MP4 mtx/transform path in steady state.
        const u32 sub5 = GekkoOperands::SUBOP5(inst);
        switch (sub10) {
        case  72: emit_ps_mr      (wb, rc, frc, op, params.ctx_ptr); return true;
        case  40: emit_ps_neg     (wb, rc, frc, op, params.ctx_ptr); return true;
        case 264: emit_ps_abs     (wb, rc, frc, op, params.ctx_ptr); return true;
        case 136: emit_ps_nabs    (wb, rc, frc, op, params.ctx_ptr); return true;
        case 528: emit_ps_merge00 (wb, rc, frc, op, params.ctx_ptr); return true;
        case 560: emit_ps_merge01 (wb, rc, frc, op, params.ctx_ptr); return true;
        case 592: emit_ps_merge10 (wb, rc, frc, op, params.ctx_ptr); return true;
        case 624: emit_ps_merge11 (wb, rc, frc, op, params.ctx_ptr); return true;
        default: break;
        }
        // ps_sel is the 4-op-form encoded by SUBOP5=23.
        if (sub5 == 23) { emit_ps_sel(wb, rc, frc, op, params.ctx_ptr); return true; }
        // Arithmetic paired-singles by SUBOP5. Per FP audit researcher:
        // 441 ps_* arith lines in MP4 mtx/psmtx code — dominates steady-
        // state render once boot pushes past the OSContext-heavy window.
        switch (sub5) {
        case 10: case 11:                    emit_ps_sum   (wb, rc, frc, op, params.ctx_ptr); return true;
        case 12: case 13:                    emit_ps_muls  (wb, rc, frc, op, params.ctx_ptr); return true;
        case 14: case 15:                    emit_ps_madds (wb, rc, frc, op, params.ctx_ptr); return true;
        case 18: case 20: case 21: case 25:  emit_ps_binary(wb, rc, frc, op, params.ctx_ptr); return true;
        case 28: case 29: case 30: case 31:  emit_ps_fma   (wb, rc, frc, op, params.ctx_ptr); return true;
        default: break;
        }
        // ps_cmp*/ps_res/ps_rsqrte/psq_*x/dcbz_l — still interp fallback.
        emit_fallback(wb, rc, frc, op, params.ctx_ptr);
        return false;
    }
    // stfs/stfsu — native PEM ConvertToSingle (2026-06-11; PSO/MP4 highest-
    // frequency FP-store fallback eliminated).
    case 52: emit_stfs(wb, rc, frc, params, op, /*update=*/false); return true;
    case 53: emit_stfs(wb, rc, frc, params, op, /*update=*/true ); return true;

    // psq_l/psq_lu/psq_st/psq_stu — native paired-single quantized
    // load/store (2026-06-12; the HandleReverb hot-loop fallback class).
    case 56: emit_psq_l (wb, rc, frc, params, op, /*update=*/false); return true;
    case 57: emit_psq_l (wb, rc, frc, params, op, /*update=*/true ); return true;
    case 60: emit_psq_st(wb, rc, frc, params, op, /*update=*/false); return true;
    case 61: emit_psq_st(wb, rc, frc, params, op, /*update=*/true ); return true;

    // Opcode 59 — single-precision arith (2026-06-12, the HandleReverb /
    // audio-mixer hot class). sub5-keyed; fres (24) stays interp (reciprocal
    // estimate table).
    case 59: {
        const u32 sub5_59 = GekkoOperands::SUBOP5(inst);
        switch (sub5_59) {
        case 18: case 20: case 21: case 25:  emit_fp_arith_single(wb, rc, frc, op, params.ctx_ptr); return true;
        case 28: case 29: case 30: case 31:  emit_fp_fma_single  (wb, rc, frc, op, params.ctx_ptr); return true;
        default: break;
        }
        emit_fallback(wb, rc, frc, op, params.ctx_ptr);
        return false;
    }

    // Opcode 63 — scalar f64 trivial sign/copy ops (fmr/fneg/fabs/fnabs),
    // arith/FMA doubles, frsp. Remaining (fcmpu/o/fctiw*/mffs/mtfsf*/fsel/
    // frsqrte) still routed to interp.
    case 63: {
        switch (sub10) {
        case  72: emit_fmrx  (wb, rc, frc, op, params.ctx_ptr); return true;
        case  40: emit_fnegx (wb, rc, frc, op, params.ctx_ptr); return true;
        case 264: emit_fabsx (wb, rc, frc, op, params.ctx_ptr); return true;
        case 136: emit_fnabsx(wb, rc, frc, op, params.ctx_ptr); return true;
        case  12: emit_frsp  (wb, rc, frc, op, params.ctx_ptr); return true;
        case  15: emit_fctiwz(wb, rc, frc, op, params.ctx_ptr); return true;
        default: break;
        }
        // SUBOP5-keyed arith — 4-operand form (table63 in ppc_tables.cpp
        // dispatches the arith ops via sub5). Per FP audit: heavy mtx use.
        const u32 sub5_63 = GekkoOperands::SUBOP5(inst);
        switch (sub5_63) {
        case 18: case 20: case 21: case 25:  emit_fp_arith_double(wb, rc, frc, op, params.ctx_ptr); return true;
        case 28: case 29: case 30: case 31:  emit_fp_fma_double  (wb, rc, frc, op, params.ctx_ptr); return true;
        default: break;
        }
        // fcmpu/fcmpo/frsp/fctiw*/mffs/mtfsf* still routed to interp.
        emit_fallback(wb, rc, frc, op, params.ctx_ptr);
        return false;
    }

    // FP D-form double load/store — native emit (slowmem-only path).
    // Per mp4_wedge_is_throughput_2026_06_07 + FP audit researcher 2026-06-08:
    // every gcsetjmp/gclongjmp pays 18 of these via interp fallback.
    case 50: emit_lfd (wb, rc, frc, params, op, /*update=*/false); return true;
    case 51: emit_lfd (wb, rc, frc, params, op, /*update=*/true ); return true;
    case 54: emit_stfd(wb, rc, frc, params, op, /*update=*/false); return true;
    case 55: emit_stfd(wb, rc, frc, params, op, /*update=*/true ); return true;

    // FP D-form single load (lfs/lfsu) — naive f32->f64 promote (same
    // approximation as existing emit_lfsx). stfs/stfsu still in fallback
    // pending PEM ConvertToSingle implementation.
    case 48: emit_lfs (wb, rc, frc, params, op, /*update=*/false); return true;
    case 49: emit_lfs (wb, rc, frc, params, op, /*update=*/true ); return true;

    default: break;
    }
    // No native emitter for this op — fallback to interp.
    emit_fallback(wb, rc, frc, op, params.ctx_ptr);
    return false;
}

// ---------------------------------------------------------------------------
// build_block_next — Phase 4.7 full build-block.
//
//   1. PPCAnalyzer::Analyze on the supplied instruction stream
//   2. Emit complete WASM module:
//        header + type(4) + import(1 memory + 13 funcs) + function(1) +
//        export("run") + code section with one function body
//   3. Function body:
//        a. Declare 2 i32 scratch locals (LOCAL_TMP_A, LOCAL_TMP_B) +
//           32 i32 GPR-cache locals.
//        b. emit_hle_prologue(ctx_ptr, start_pc)
//        c. RegCache::OnBlockEntry + EmitPrologueLoads
//        d. For each CodeOp: dispatch_op  (idle-skip override when the
//           terminator's branchIsIdleLoop is set)
//        e. Epilogue: RegCache::Flush, then i32.const(ctx_ptr) +
//           i32.load(PC) leaves the next-PC on the stack for the
//           function return.
//
// Module shape mirrors live gekko_emit.cpp:4375-4454 byte-for-byte so
// Phase 7 cut-over is binary-compatible: same 13-import set (11 originals +
// ppc_msr_updated + ppc_gather_drain), same export name and index
// (= WIMPORT_COUNT), same function type 0 = () -> i32.
//
// The JS-side import-binding code keys on the import names, not indices,
// so the rebuild can safely use the same shim runtime.
// ---------------------------------------------------------------------------
// Default null — current conservative behavior (every op gets HLE prologue).
// Set by host integrator (JitWasm) to HLE::GetHookByAddress wrapper.
HleHookQueryFn g_hle_hook_query = nullptr;

// [region] Shared block-body emit: prologue (downcount/idle + promote ring) +
// RegCache/FPRRegCache setup + the per-op dispatch loop + epilogue (gather
// drain + flush + terminal). Extracted from build_block_next so the region
// builder reuses the EXACT same op emission (13 imports, coalescing, gather/
// msr gates). The caller declares locals + the module scaffolding. Live
// per-block path is byte-identical (region_mode defaults false).
static void emit_block_body_into(WasmModuleBuilder& b, CodeBlock& block,
                                 CodeBuffer& buffer, BlockStats& stats,
                                 u32 count, u32 start_pc, u32 ctx_ptr,
                                 u32 mem1_base, u32 mem1_mask, u32 ram_size,
                                 u32 chain_tag_addr = 0u, u32 chain_slot_addr = 0u,
                                 const MergedRegionCtx* merged = nullptr) {
    // IN-BLOCK CYCLE ACCOUNTING (2026-06-12, Jit64 parity: Jit.cpp charges
    // js.downcountAmount at block entry). downcount -= numCycles emitted in
    // the block prologue so the chain dispatcher can run block-to-block
    // without a host round-trip per block; JitWasm.cpp's C-side decrement
    // is REMOVED in the same change (double-charge otherwise). Early block
    // exits overcharge slightly — same behavior as Jit64.
    //
    // IDLE BLOCKS (analyzer branchIsIdleLoop — the canonical Dolphin
    // IsBusyWaitLoop port, covers mftb spins AND lwz-poll loops like
    // SelectThread's RunQueueBits wait) write downcount = 0 instead:
    // Jit64's HandleIdle semantics at slice granularity. Without this the
    // chain burns idle spins at real cycle cost and guest time crawls in
    // wall terms once the guest is event-bound (PSO deep park: ViSwap
    // 2560 -> 4, AID 45x under its own schedule — events weren't broken,
    // guest-time advance was).
    {
        const bool idle_block = block.m_num_instructions > 0 &&
            buffer.data()[block.m_num_instructions - 1].branchIsIdleLoop;
        if (idle_block) {
            b.op_i32_const((s32)ctx_ptr);
            b.op_i32_const(0);
            b.op_i32_store(ppc_off::DOWNCOUNT);
        } else {
            const u32 charge = stats.numCycles ? stats.numCycles : (u32)count;
            b.op_i32_const((s32)ctx_ptr);
            b.op_i32_const((s32)ctx_ptr);
            b.op_i32_load(ppc_off::DOWNCOUNT);
            b.op_i32_const((s32)charge);
            b.op_i32_sub();
            b.op_i32_store(ppc_off::DOWNCOUNT);
            // Phase A: per-block execution counter for region promotion. Counts
            // EVERY execution (including in-WASM tail-chained entries the C
            // dispatch loop never sees). On crossing HOT_THRESHOLD push start_pc
            // to g_bem_promote_ring (drained C-side -> promote_hot -> region).
            // Non-idle blocks only (idle/poll loops are idle-skipped, not hot).
            // Uses scratch locals 0/1 (free here; RegCache uses 2..). TMP_A/B.
            if (g_bem_promote_enabled) {
                const u32 bkt       = (start_pc >> 2) & BEM_DISP_MASK_NEXT;
                const u32 exec_addr = (u32)(uintptr_t)&g_bem_pc_exec[bkt];
                const u32 ring_addr = (u32)(uintptr_t)&g_bem_promote_ring[0];
                const u32 n_addr    = (u32)(uintptr_t)&g_bem_promote_n;
                // count = *exec_addr + 1 ; *exec_addr = count ; (count in TMP_A)
                b.op_i32_const((s32)exec_addr);
                b.op_i32_const((s32)exec_addr); b.op_i32_load(0);
                b.op_i32_const(1); b.op_i32_add();
                b.op_local_tee(LOCAL_TMP_A_CHAIN);
                b.op_i32_store(0);
                // [xinst-fix] if ((count & 15) == 0) — fire EVERY 16 executions,
                // not once at count==N. The promote drain is gated OFF during boot
                // (g_bem_promote_active); the steady-state hot loop's blocks were
                // compiled during boot, so a one-shot count==N trigger already
                // passed before the gate opened and they'd never be captured. The
                // every-16 trigger re-fires for already-warm blocks once the gate
                // opens (promote_hot dedups, so repeats are cheap), while blocks
                // run <16 times never push (cold-block filter).
                b.op_local_get(LOCAL_TMP_A_CHAIN);
                b.op_i32_const(15);
                b.op_i32_and();
                b.op_i32_const(0);
                b.op_i32_eq();
                b.op_if(BLOCK_TYPE_VOID);
                    // pn = *n_addr ; if (pn < 256)
                    b.op_i32_const((s32)n_addr); b.op_i32_load(0);
                    b.op_local_tee(LOCAL_TMP_B_CHAIN);
                    b.op_i32_const(256); b.op_i32_lt_u();
                    b.op_if(BLOCK_TYPE_VOID);
                        // g_bem_promote_ring[pn] = start_pc
                        b.op_i32_const((s32)ring_addr);
                        b.op_local_get(LOCAL_TMP_B_CHAIN); b.op_i32_const(4); b.op_i32_mul(); b.op_i32_add();
                        b.op_i32_const((s32)start_pc);
                        b.op_i32_store(0);
                        // *n_addr = pn + 1
                        b.op_i32_const((s32)n_addr);
                        b.op_local_get(LOCAL_TMP_B_CHAIN); b.op_i32_const(1); b.op_i32_add();
                        b.op_i32_store(0);
                    b.op_end();
                b.op_end();
            }
        }
    }

    // RegCache: assign per-PPC-GPR WASM locals + emit prologue loads
    // for live-in registers.
    // [region-resident 2026-07-15] Merged-region bodies SKIP the prologue
    // loads: the $region activation pad loaded all 32 GPRs once, warm edges
    // are same-activation `br`s (locals persist), and every host-visible
    // point still sees coherent memory via the unchanged dirty flushes.
    RegCache rc(b);
    rc.OnBlockEntry(block, /*wasm_local_base=*/2u, ctx_ptr);
    if (merged) rc.MarkAllLoaded();
    else        rc.EmitPrologueLoads(ctx_ptr);

    // FPRRegCache: assign per-PPC-FPR WASM locals (both ps0/ps1 lanes) +
    // emit i64 prologue loads for live-in FPRs (block.m_fpr_inputs).
    // Step-3 wiring: prologue+epilogue only — no emit_* site references
    // frc yet. Bit-exact round-trip safe because i64 load+store preserves
    // any 64-bit pattern (NaN payload + signed-zero preserved).
    FPRRegCache frc(b);
    frc.OnBlockEntry(block, /*wasm_local_base=*/34u, ctx_ptr);
    frc.EmitPrologueLoads(ctx_ptr);

    LoadStoreParams params;
    params.ctx_ptr   = ctx_ptr;
    params.mem1_base = mem1_base;
    params.mem1_mask = mem1_mask;
    params.ram_size  = ram_size;

    // Per-CodeOp dispatch. 2026-05-18 port of JIT64's HandleFunctionHooking
    // (Jit.cpp:1065-1066): JIT64 calls HLE::TryReplaceFunction on EVERY op's
    // address, not just block start. If any mid-block op is HLE-hooked, the
    // hook fires and the block exits there. This catches wild-branch-into-
    // mid-function cases. Historical: the SAB 0x800e5778 OSLoadContext-with-
    // r3=0 symptom motivated the port; that specific PC has since been
    // superseded as the wedge (current root in memory
    // gamecube_first_mmio_divergence_2026_05_28), but the per-op hook check
    // is still correctness-required vs the original "start-of-block only"
    // shape, which equivalent to JIT64 calling HandleFunctionHooking on
    // op[0] only — missing downstream hooked PCs.
    //
    // RegCache must be flushed before the HLE call so the host sees current
    // GPR state if the hook reads ppc_state.
    //
    // Idle-skip override fires only for the terminator (last op) when the
    // analyzer flagged branchIsIdleLoop.
    const std::size_t n_ops = buffer.size();
    // Track whether the block contains any store — gates the gather-pipe
    // drain at block exit (structural audit wp7gh3uoi msr-ee finding #1).
    // Pure ALU/branch blocks (the overwhelming majority pre-VI_FIELD_BELOW)
    // skip the unconditional wasm→JS crossing.
    bool block_has_store = false;
    // Jit64 parity (Jit.cpp:1104-1128): the FIRST FL_USE_FPU op in a block
    // gets an MSR.FP bailout check; once it passes, later FP ops in the
    // same block skip it (FP can't be disabled mid-block — mtmsr ends the
    // block). Root cause of the MP4 minimumVcount boot wedge (2026-06-11):
    // native lfs ran with MSR.FP=0 (no trap), the interp-fallback stfs then
    // raised FPU-unavailable, __OSLoadFPUContext clobbered the lfs result
    // with the stale saved context, and SRR0-based re-execution resumed at
    // the stfs — storing stale f1 (f64 2^52 → 0x59800000) and saturating
    // minimumVcount to 0xFFFFFFFF (red test: lfs_msr_fp_disabled).
    bool first_fp_found = false;
    for (std::size_t i = 0; i < n_ops; ++i) {
        const CodeOp& op = buffer[i];
        const bool is_terminator = (i + 1 == n_ops);
        if (op.opinfo) {
            const OpType t = op.opinfo->type;
            if (t == OpType::Store || t == OpType::StoreFP || t == OpType::StorePS) {
                block_has_store = true;
            }
        }

        // Per-op HLE check, GATED on compile-time host query (structural
        // audit 2026-06-08, wp7gh3uoi — finding #1, ~18x per-op blowup).
        // If no hook is registered at op.address, emit ZERO wasm ops here —
        // mirrors Jit64's HandleFunctionHooking shape (Jit.cpp:1065). When
        // g_hle_hook_query is null (default), preserve the old conservative
        // every-op-prologue behavior. Caller must evict cached blocks when
        // installing hooks at PCs already compiled (existing pattern at
        // EmscriptenWorker.cpp:357).
        const bool may_have_hook =
            (g_hle_hook_query == nullptr) || g_hle_hook_query(op.address);
        if (may_have_hook) {
            rc.Flush(ctx_ptr);
            // Step-4 plumbing: HLE handlers don't touch FPRs today
            // (OSReport/DBPrintf only mutate gpr[3..5]) but future FP-aware
            // HLE could. Conservative match to rc.Flush/rc.ReloadAll keeps
            // the FPR cache coherent across the HLE-may-fire boundary.
            frc.Flush(ctx_ptr);
            emit_hle_prologue(b, ctx_ptr, op.address);
            // Pass-2 audit (w6oeq0l6e RANK 3): HLE Start hooks (OSReport,
            // DBPrintf, generic-skip) read & mutate ppc_state.gpr[3..5]
            // (HLE_OS.cpp). On the fall-through path (Start hook ran,
            // returned 0), the block continues with stale regcache locals
            // — same class as the emit_mfspr/mtspr/mftb fix at commit
            // 87e55db. Reload all GPRs from PowerPCState so post-hook gpr
            // writes are visible.
            rc.ReloadAll(ctx_ptr);
            frc.ReloadAll(ctx_ptr);
        }

        // Pre-op set_pc — mirrors Jit64 FallBackToInterpreter (Jit.cpp:357):
        // write ppc_state.pc only when op.canEndBlock, NOT before every op.
        // [set_pc-gate] op.canEndBlock = FL_ENDBLOCK + bclr/bcctr/rfi
        // (ppc_analyst.cpp:481). Also keep it for FL_LOADSTORE (slow-path DSI
        // reads ctx.PC), FL_USE_FPU (the FP-unavailable bailout below uses ctx.PC),
        // and canCauseException (trap/syscall/div). Pure native ALU ops (add/addi/
        // or/rlwinm/mtspr...) skip it — drops 3 wasm ops from the bulk of the body.
        // The historical SAB 0x500 EXT_INT self-loop (addis/addi/mtspr native then
        // rfi fell back; interp guard `if (ppc_state.pc != pc)` saw a stale pc and
        // skipped rfi) STAYS fixed: rfi is canEndBlock (gets the pre-op pc) AND
        // emit_fallback now sets its own pc. (An FL_ENDBLOCK-only gate broke boot —
        // it missed bclr/bcctr/rfi, sending returns/jumps to stale PCs.)
        // is_terminator: the non-branch block-exit PC fixup (~line 846) does
        // `if (PC == op.address) PC = op.address+4` and REQUIRES the pre-op pc to
        // have written op.address (a cap-cut ALU terminator otherwise leaves PC
        // stale -> epilogue returns the wrong next-pc -> the 27-PC +4 walk).
        if (is_terminator || op.canEndBlock || op.canCauseException ||
            (op.opinfo && (op.opinfo->flags & (FL_LOADSTORE | FL_USE_FPU))))
        {
            b.op_i32_const((s32)ctx_ptr);
            b.op_i32_const((s32)op.address);
            b.op_i32_store(ppc_off::PC);
        }

        // Always route through dispatch_op for the terminator. The
        // emit_idle_skip override was wrong for benign polling loops
        // (e.g. SAB 0x800ecb48 mftbu/mftbl/mftbu/cmpw/bne TBU-retry):
        // it dropped the bne's CR0[EQ] check and unconditionally set
        // PC=target, so the loop self-spun forever even when r3==r5
        // (which is the case every iteration since both reads happen in
        // the same JIT dispatch and TBU only advances between
        // dispatches). emit_bcx handles the conditional correctly; if
        // the cond falls through, next_pc=fallthrough and the block
        // exits naturally. PowerPC ISA's standard 64-bit timebase read
        // pattern depends on this behavior to terminate.
        // FP-unavailable bailout before the first FP op (see first_fp_found
        // above). ctx.PC already holds op.address (pre-op set_pc), matching
        // Jit64's MOV(pc, op.address) — SRR0 lands on THIS op so the whole
        // FP sequence re-executes after __OSLoadFPUContext.
        if (op.opinfo && (op.opinfo->flags & FL_USE_FPU) && !first_fp_found) {
            rc.Flush(ctx_ptr);
            frc.Flush(ctx_ptr);
            b.op_i32_const((s32)ctx_ptr);
            b.op_i32_load(ppc_off::MSR);
            b.op_i32_const(0x2000);          // MSR.FP (Jit64 Jit.cpp:1107)
            b.op_i32_and();
            b.op_i32_eqz();
            b.op_if(BLOCK_TYPE_VOID);
                // Exceptions |= EXCEPTION_FPU_UNAVAILABLE (0x40, Gekko.h:930)
                b.op_i32_const((s32)ctx_ptr);
                b.op_i32_const((s32)ctx_ptr);
                b.op_i32_load(ppc_off::EXCEPTIONS);
                b.op_i32_const(0x40);
                b.op_i32_or();
                b.op_i32_store(ppc_off::EXCEPTIONS);
                // Deliver: CheckExceptionsFromJIT sets PC to vector 0x800,
                // SRR0 = op.address (PowerPC.cpp:538-548).
                b.op_i32_const((s32)op.address);
                b.op_call(WIMPORT_CHECK_EXC);
                b.op_drop();
                // Early-exit parity with emit_fallback's exception path:
                // drain the gather pipe (the normal epilogue is bypassed).
                b.op_i32_const(0);
                b.op_i32_const(0);
                b.op_call(WIMPORT_GATHER_DRAIN);
                b.op_i32_const((s32)ctx_ptr);
                b.op_i32_load(ppc_off::PC);
                b.op_return();
            b.op_end();
            first_fp_found = true;
        }

        // [coalesce] A FORWARD conditional branch that is NOT the block
        // terminator (the decode loop + analyst kept decoding past it) is
        // emitted as a mid-block conditional EXIT: taken stores PC=target +
        // returns to the dispatcher, not-taken falls through to the next op in
        // this same block. The pre-op set_pc above left PC=op.address for the
        // not-taken arm; the next op's set_pc advances it to the fall-through.
        bool emitted_native;
        if (!is_terminator && IsForwardConditionalBranch(op.inst, op.address)) {
            emit_bcx(b, rc, frc, op, ctx_ptr, /*is_terminal=*/false);
            emitted_native = true;
        } else {
            emitted_native = dispatch_op(b, rc, frc, op, params);
        }

        // Block-exit PC correctness for non-branch-terminated blocks (decode-
        // cap cuts, FL_ENDBLOCK non-branch terminators like mtspr MMCR0).
        // The pre-op set_pc above wrote op.address; native non-branch
        // emitters never advance PC, and the epilogue RETURNS ctx PC as
        // next_pc (consumed at JitWasm.cpp:235 as the next dispatch
        // address). Without this, the boundary op re-executes in the next
        // block — non-idempotent boundary ops (stwu/lwzu rA update, MMIO
        // stores) corrupt state. Interp-fallback ops are excluded: the
        // interpreter advances ppc_state.pc itself (and rfi/sc must keep
        // their vector PC). Branches are excluded: emit_bx/bcx/blr/bctr
        // write the taken/fallthrough PC. Legacy build_block returns the
        // +4 fallthrough for these blocks (test_gekko no_terminator_block
        // asserts it); this restores parity.
        // CONDITIONAL form (2026-06-10, v2): only advance when PC still
        // holds the pre-op value — i.e. nothing inside the op's emitted
        // code redirected it. The v1 UNCONDITIONAL store regressed boot to
        // a 27-PC low-memory +4 walk (bisected; see STATUS.md "BUG 2"):
        // it clobbered PC values written by host imports during the op
        // (check_exc exception vectors, interp side effects, MMIO-write
        // consequences), which the load-PC epilogue had respected.
        // Compile-time gates: last op only, natively emitted only (interp
        // fallback advances/redirects ppc_state.pc itself), non-branch
        // only (branch emitters write taken/fallthrough PC; a self-loop
        // branch legitimately leaves PC == op.address and must not be
        // bumped).
        if (is_terminator && emitted_native &&
            !(op.opinfo && op.opinfo->type == OpType::Branch)) {
            b.op_i32_const((s32)ctx_ptr);
            b.op_i32_load(ppc_off::PC);
            b.op_i32_const((s32)op.address);
            b.op_i32_eq();
            b.op_if(BLOCK_TYPE_VOID);
            b.op_i32_const((s32)ctx_ptr);
            b.op_i32_const((s32)(op.address + 4u));
            b.op_i32_store(ppc_off::PC);
            b.op_end();
        }
    }

    // Epilogue: drain gather-pipe (so GPU FIFO sees CP_INT/PE_TOKEN/PE_FINISH
    // after stw-to-0xCC008000 family stores), flush dirty GPR locals, then
    // read PC back and return. The trailing i32 satisfies type 0's i32 result.
    //
    // Pass-2 audit (w6oeq0l6e RANK 9): without this drain, post-boot GPU
    // FIFO writes accumulate past GATHER_PIPE_SIZE and CP-interrupt-triggered
    // fences never fire → games wait forever on GP-triggered events. Mirrors
    // Jit64 Cleanup() (Jit.cpp:454-490).
    //
    // Structural audit wp7gh3uoi msr-ee finding #1: gate on whether this
    // block actually emitted a store. Pure ALU/branch blocks (the bulk of
    // pre-VI_FIELD_BELOW boot) skip the wasm→JS crossing. Conservative —
    // any store could route to MMIO (including the gather-pipe range), so
    // we always drain when stores exist; only fully store-free blocks skip.
    if (block_has_store) {
        // [perf] Only cross to the host gather-pipe drain (a wasm->JS
        // UpdateGatherPipe flush) when a gather-pipe write is actually
        // pending. g_bem_gp_dirty (bridge) is set by dolphin_write* / interp
        // on any WPAR (0xCC008000) store and cleared by the drain. Pure-
        // compute store-blocks (the bulk) skip the crossing. UpdateGatherPipe
        // only flushes complete 32-byte chunks, so skipping it while no GP
        // write is pending is bit-identical to calling it (it would no-op).
        b.op_i32_const((s32)(uintptr_t)&g_bem_gp_dirty);
        b.op_i32_load(0);
        b.op_if(BLOCK_TYPE_VOID);
            b.op_i32_const(0);
            b.op_i32_const(0);
            b.op_call(WIMPORT_GATHER_DRAIN);
        b.op_end();
    }

    // Flush dirty FPR lanes back to PowerPCState before the GPR flush.
    // In step 3 wiring no emit_* writes the cache so this is a no-op (no
    // dirty bits set), but the call sits structurally where future emit-
    // site conversions will need it. Per step-3 plan: prologue load +
    // epilogue flush form a bit-exact round-trip on FPR memory.
    frc.Flush(ctx_ptr);
    rc.Flush(ctx_ptr);
    // Terminal: tail-chain to the successor block in-WASM when it resolves and
    // no service point is pending; otherwise return next-PC to the JS loop.
    // (Merged-region bodies re-dispatch in-function instead — see MergedRegionCtx.)
    emit_chain_or_return(b, ctx_ptr, chain_tag_addr, chain_slot_addr, merged);
}

std::vector<u8> build_block_next(u32 start_pc,
                                 const u32* insts, u32 count,
                                 u32 ctx_ptr,
                                 u32 mem1_base, u32 mem1_mask, u32 ram_size,
                                 u32* out_cycles,
                                 bool* out_is_idle_loop) {
    // Wrap raw insts[] in a fetch callback for PPCAnalyzer.
    struct FetchCtx { const u32* insts; u32 base_pc; u32 count; };
    FetchCtx fc{insts, start_pc, count};
    auto fetch = +[](u32 pc, void* user) -> u32 {
        const FetchCtx* f = static_cast<const FetchCtx*>(user);
        const u32 idx = (pc - f->base_pc) / 4;
        if (idx >= f->count) return 0;
        return f->insts[idx];
    };

    PPCAnalyzer pa;
    CodeBlock block;
    BlockStats stats;
    block.m_stats = &stats;
    CodeBuffer buffer;
    pa.Analyze(start_pc, &block, &buffer, count, fetch, &fc);

    if (out_cycles) *out_cycles = stats.numCycles;
    if (out_is_idle_loop) {
        // True iff the analyst's IsBusyWaitLoop classified the terminator
        // as an mftb-style busy-wait. CTR-counted loops (bdnz) and other
        // non-timing-poll self-loops set this false so the JitWasm
        // dispatcher's idle-skip ring won't force downcount=0 on them.
        const bool n_ops_positive = block.m_num_instructions > 0;
        *out_is_idle_loop = n_ops_positive &&
            buffer.data()[block.m_num_instructions - 1].branchIsIdleLoop;
    }

    WasmModuleBuilder b;
    b.emitHeader();

    // ---- Type section: 4 types (matches live) ----
    //   type 0: () -> i32                 — block "run" function
    //   type 1: (i32) -> i32              — ppc_read8/16/32, check_exc, hle_check
    //   type 2: (i32, i32) -> ()          — ppc_write8/16/32, interp, break_block
    //   type 3: (i32, i32) -> i32         — ppc_hle_fire
    b.emitTypeSection(4);
    {
        const u8 i32t[]  = { WASM_TYPE_I32 };
        const u8 i32x2[] = { WASM_TYPE_I32, WASM_TYPE_I32 };
        b.emitFuncType(nullptr, 0, i32t, 1);     // type 0
        b.emitFuncType(i32t, 1, i32t, 1);        // type 1
        b.emitFuncType(i32x2, 2, nullptr, 0);    // type 2
        b.emitFuncType(i32x2, 2, i32t, 1);       // type 3
    }
    b.endSection();

    // ---- Import section: 1 memory + WIMPORT_COUNT (= 13) host functions
    //      + 1 table (__indirect_function_table, for in-WASM block chaining) ----
    b.emitImportSection(1u + WIMPORT_COUNT + 1u);
    b.emitImportMemory("env", "memory", /*initialPages=*/1u);
    b.emitImportFunc("env", "ppc_read8",       /*type*/1);   // idx 0
    b.emitImportFunc("env", "ppc_read16",      /*type*/1);   // idx 1
    b.emitImportFunc("env", "ppc_read32",      /*type*/1);   // idx 2
    b.emitImportFunc("env", "ppc_write8",      /*type*/2);   // idx 3
    b.emitImportFunc("env", "ppc_write16",     /*type*/2);   // idx 4
    b.emitImportFunc("env", "ppc_write32",     /*type*/2);   // idx 5
    b.emitImportFunc("env", "ppc_interp",      /*type*/2);   // idx 6
    b.emitImportFunc("env", "ppc_check_exc",   /*type*/1);   // idx 7
    b.emitImportFunc("env", "ppc_break_block", /*type*/2);   // idx 8
    b.emitImportFunc("env", "ppc_hle_check",   /*type*/1);   // idx 9
    b.emitImportFunc("env", "ppc_hle_fire",    /*type*/3);   // idx 10
    b.emitImportFunc("env", "ppc_msr_updated", /*type*/2);   // idx 11
    b.emitImportFunc("env", "ppc_gather_drain", /*type*/2);  // idx 12
    // Imported table = table index 0; emit_chain_or_return targets it via
    // return_call_indirect. initial=0 so any host table (which is far larger)
    // satisfies the import's minimum-size check.
    b.emitImportTable("env", "__indirect_function_table", /*initial*/0u, /*hasMax*/false);
    b.endSection();

    // ---- Function section: 1 function of type 0 ----
    {
        const u32 typeIdx[] = { 0u };
        b.emitFunctionSection(1u, typeIdx);
    }

    // ---- Export section: "run" → func index = WIMPORT_COUNT ----
    b.emitExportSection("run", WIMPORT_COUNT);

    // ---- Code section: 1 function body ----
    b.beginCodeSection(1u);
    b.beginFuncBody();

    // Locals: 2 i32 scratch (LOCAL_TMP_A=0, LOCAL_TMP_B=1) + 32 i32 GPR
    // cache locals (indices 2..33) + 64 i64 FPR-lane locals (indices
    // 34..97 — 32 ps0 lanes then 32 ps1 lanes). RegCache uses
    // wasm_local_base=2; FPRRegCache uses wasm_local_base=34. Total 98
    // locals, well within wasm engine limits.
    {
        // Groups 4+5: psq scratch — 2 i32 pair-element stages (locals 98,
        // 99) + one f64 clamp stage (local 100); jit_load_store LOCAL_PSQ_*.
        // Group 6: 2 i64 scratch (locals 101, 102) for op59/frsp
        // Force25Bit + ForceSingle bit-twiddling; jit_floating_point
        // LOCAL_FP_I64_*.
        // Group 7 [oracle-audit 2026-07-12]: 17 f64 scratch (locals 103..119)
        // for the bit-exact fused multiply-add (Boldo-Melquiond FMA + single
        // tie-correction) in jit_fp_helpers.h LOCAL_FMA_* (C2).
        // Group 8 [simd-paired 2026-07-12]: 32 v128 (locals 120..151) — the
        // single-precision f32x2 form of each FPR (FPRRegCache v128_local_idx).
        const u32 counts[] = { 2u, 32u, 64u, 2u, 1u, 2u, 17u, 32u };
        const u8  types[]  = { WASM_TYPE_I32, WASM_TYPE_I32, WASM_TYPE_I64, WASM_TYPE_I32, WASM_TYPE_F64, WASM_TYPE_I64, WASM_TYPE_F64, WASM_TYPE_V128 };
        b.emitLocals(8u, counts, types);
    }

    emit_block_body_into(b, block, buffer, stats, count, start_pc, ctx_ptr,
                         mem1_base, mem1_mask, ram_size);

    b.endFuncBody();
    b.endSection();

    return b.getBytes();
}


// [region-merged 2026-07-15] Region-path _next implementations — REAL, and
// compiled UNCONDITIONALLY (the BEMENTALJIT_USE_REBUILD guards are gone: the
// canonical build-wasm-4010 compiles with the flag OFF, which silently routed
// the whole region path to the LEGACY gekko emitter — regions lacked
// ppc_msr_updated/ppc_gather_drain and every powerpc-next semantic fix, the
// "staleness bug"). block_cache's seal now calls these directly.

std::vector<u8> emit_block_body_next(u32 start_pc, const u32* insts, u32 count,
                                     u32 ctx_ptr_const,
                                     u32 mem1_base, u32 mem1_mask, u32 ram_size,
                                     const u32* instr_pcs,
                                     LocalIdxLookupFn lookup_fn,
                                     const void* lookup_user,
                                     bool emit_hle_check,
                                     bool emit_perf_stub,
                                     bool emit_hle_check_native) {
    // Real ppc-next region body: analyze, then emit ONLY the function body
    // (locals + code, no module wrapper) so build_region_module_next can copy
    // it verbatim into the region module's code section. Uses the SAME op
    // emission as the live per-block path (emit_block_body_into) — 13 imports,
    // coalescing, gather/msr gates — with the REGION-LOCAL cache so the
    // in-WASM tail-chain resolves into the region module's INTERNAL table 0.
    (void)instr_pcs; (void)lookup_fn; (void)lookup_user;
    (void)emit_hle_check; (void)emit_perf_stub; (void)emit_hle_check_native;
    struct FetchCtx { const u32* insts; u32 base_pc; u32 count; };
    FetchCtx fc{insts, start_pc, count};
    auto fetch = +[](u32 pc, void* user) -> u32 {
        const FetchCtx* f = static_cast<const FetchCtx*>(user);
        const u32 idx = (pc - f->base_pc) / 4u;
        if (idx >= f->count) return 0u;
        return f->insts[idx];
    };
    PPCAnalyzer pa;
    CodeBlock block;
    BlockStats stats;
    block.m_stats = &stats;
    CodeBuffer buffer;
    pa.Analyze(start_pc, &block, &buffer, count, fetch, &fc);

    WasmModuleBuilder b;
    b.beginFuncBody();
    {
        // Group 7 [oracle-audit 2026-07-12]: 17 f64 scratch (103..119) for the
        // bit-exact FMA (jit_fp_helpers.h LOCAL_FMA_*, C2). MUST match the
        // build_block_next declaration above (region path shares emitters).
        // Group 8 [simd-paired 2026-07-12]: 32 v128 (120..151). MUST match the
        // build_block_next declaration above (region path shares emitters).
        const u32 counts[] = { 2u, 32u, 64u, 2u, 1u, 2u, 17u, 32u };
        const u8  types[]  = { WASM_TYPE_I32, WASM_TYPE_I32, WASM_TYPE_I64,
                               WASM_TYPE_I32, WASM_TYPE_F64, WASM_TYPE_I64,
                               WASM_TYPE_F64, WASM_TYPE_V128 };
        b.emitLocals(8u, counts, types);
    }
    const u32 rtag  = (u32)(uintptr_t)&g_bem_rtag[0];
    const u32 rslot = (u32)(uintptr_t)&g_bem_rslot[0];
    emit_block_body_into(b, block, buffer, stats, count, start_pc, ctx_ptr_const,
                         mem1_base, mem1_mask, ram_size, rtag, rslot);
    b.endFuncBody();
    return b.getBytes();
}

std::vector<u8> build_region_module_next(const u8* concatenated_bodies,
                                         std::size_t concatenated_size,
                                         u32 n_funcs,
                                         u32 mem_pages) {
    // Real ppc-next region module: N pre-emitted bodies + an INTERNAL funcref
    // table (V8 inlines intra-region return_call_indirect because the table is
    // declared, not imported). 13 imports (incl ppc_msr_updated/ppc_gather_drain
    // — the gekko region path omitted these, the staleness bug). Section order
    // per spec: type, import, function, table, export, element, code.
    if (n_funcs == 0u || concatenated_bodies == nullptr || concatenated_size == 0u)
        return {};
    WasmModuleBuilder b;
    b.emitHeader();
    b.emitTypeSection(4);
    {
        const u8 i32t[]  = { WASM_TYPE_I32 };
        const u8 i32x2[] = { WASM_TYPE_I32, WASM_TYPE_I32 };
        b.emitFuncType(nullptr, 0, i32t, 1);
        b.emitFuncType(i32t, 1, i32t, 1);
        b.emitFuncType(i32x2, 2, nullptr, 0);
        b.emitFuncType(i32x2, 2, i32t, 1);
    }
    b.endSection();
    b.emitImportSection(1u + WIMPORT_COUNT);
    b.emitImportMemory("env", "memory", mem_pages > 0u ? mem_pages : 1u);
    b.emitImportFunc("env", "ppc_read8",       1);   // 0
    b.emitImportFunc("env", "ppc_read16",      1);   // 1
    b.emitImportFunc("env", "ppc_read32",      1);   // 2
    b.emitImportFunc("env", "ppc_write8",      2);   // 3
    b.emitImportFunc("env", "ppc_write16",     2);   // 4
    b.emitImportFunc("env", "ppc_write32",     2);   // 5
    b.emitImportFunc("env", "ppc_interp",      2);   // 6
    b.emitImportFunc("env", "ppc_check_exc",   1);   // 7
    b.emitImportFunc("env", "ppc_break_block", 2);   // 8
    b.emitImportFunc("env", "ppc_hle_check",   1);   // 9
    b.emitImportFunc("env", "ppc_hle_fire",    3);   // 10
    b.emitImportFunc("env", "ppc_msr_updated", 2);   // 11
    b.emitImportFunc("env", "ppc_gather_drain", 2);  // 12
    b.endSection();
    {
        std::vector<u32> typeIndices(n_funcs, 0u);
        b.emitFunctionSection(n_funcs, typeIndices.data());
    }
    b.beginTableSection(1);
    b.emitTable(n_funcs, /*hasMax=*/true, n_funcs, WASM_REF_FUNCREF);
    b.endSection();
    b.beginExportSection(n_funcs);
    {
        char name[24];
        for (u32 i = 0; i < n_funcs; ++i) {
            std::snprintf(name, sizeof(name), "fn_%u", (unsigned)i);
            b.emitExport(name, WASM_EXPORT_FUNC, WIMPORT_COUNT + i);
        }
    }
    b.endSection();
    b.beginElementSection(1);
    {
        std::vector<u32> indices(n_funcs);
        for (u32 i = 0; i < n_funcs; ++i) indices[i] = WIMPORT_COUNT + i;
        b.emitActiveElementSegment(/*offset=*/0u, indices.data(), n_funcs);
    }
    b.endSection();
    b.beginCodeSection(n_funcs);
    b.emitBytes(concatenated_bodies, concatenated_size);
    b.endSection();
    return b.getBytes();
}

std::vector<u8> build_region_function_next_merged(const RegionBlockDesc* blocks,
                                                  u32 n_blocks,
                                                  u32 gen_idx,
                                                  u32 blr_chain_addr,
                                                  u32 mem_pages) {
    // [region-merged 2026-07-15] ONE wasm function for the whole generation.
    // Shape: func $region (idx 13) = 8-group locals + (N+1) nested void blocks
    // + br_table(entry_sel) + the N spliced block-body expressions + a default
    // arm returning ctx.PC. Bodies are the SAME emit_block_body_into output as
    // the live per-block path (13-import contract, all powerpc-next semantics),
    // emitted expression-only with MergedRegionCtx so intra-region edges become
    // `entry_sel = k; return_call $region` (microbench a2, 6.64ns) resolved at
    // RUNTIME via the gen-packed rtag/rslot cache — no br-depth tracking, no
    // build-time lookup (bctr/blr targets warm-chain too when sealed). fn_k
    // wrappers (idx 14+k) are the GLOBAL-dispatch-table entry points: reset the
    // blr-chain budget (host-boundary contract, block_cache.cpp:448) + zero the
    // lap counter + set entry_sel + tail into $region.
    // Splice validity: bodies are self-contained expressions whose brs only
    // reference their own nesting and which terminate every path with
    // return/return_call — relative br depths survive splicing untouched.
    if (blocks == nullptr || n_blocks == 0u || n_blocks > 0xFFFFu) return {};

    // ---- Emit the N bodies (expression bytes only; locals live in $region) ----
    MergedRegionCtx mctx;
    mctx.gen_idx         = gen_idx;
    mctx.region_func_idx = WIMPORT_COUNT;        // func 13 = $region
    mctx.sel_global_idx  = 0u;                   // global 0 = entry_sel
    mctx.laps_global_idx = 1u;                   // global 1 = laps
    // Merged gens probe DEDICATED arrays (g_bem_mrtag/mrslot) — the N-fn
    // shape's rtag/rslot hold RAW internal-table indices; merged slots are
    // gen-packed. Sharing one array would collide the two semantics.
    const u32 rtag  = (u32)(uintptr_t)&g_bem_mrtag[0];
    const u32 rslot = (u32)(uintptr_t)&g_bem_mrslot[0];
    std::vector<std::vector<u8>> bodies(n_blocks);
    for (u32 i = 0; i < n_blocks; ++i) {
        const RegionBlockDesc& d = blocks[i];
        if (d.insts == nullptr || d.count == 0u) return {};
        struct FetchCtx { const u32* insts; u32 base_pc; u32 count; };
        FetchCtx fc{d.insts, d.start_pc, d.count};
        auto fetch = +[](u32 pc, void* user) -> u32 {
            const FetchCtx* f = static_cast<const FetchCtx*>(user);
            const u32 idx = (pc - f->base_pc) / 4u;
            return idx >= f->count ? 0u : f->insts[idx];
        };
        PPCAnalyzer pa;
        CodeBlock block;
        BlockStats stats;
        block.m_stats = &stats;
        CodeBuffer buffer;
        pa.Analyze(d.start_pc, &block, &buffer, d.count, fetch, &fc);
        WasmModuleBuilder bb;   // no framing: getBytes() = raw expression bytes
        // [region-resident] body k splices inside loop + $DEF + (n-1-k) $B
        // blocks; warm-edge br imm = bodyDepth + (n_blocks - k) reaches $L.
        mctx.br_extra_depth = n_blocks - i;
        emit_block_body_into(bb, block, buffer, stats, d.count, d.start_pc,
                             d.ctx_ptr, d.mem1_base, d.mem1_mask, d.ram_size,
                             rtag, rslot, &mctx);
        bodies[i] = bb.getBytes();
    }
    const u32 ctx_ptr_any = blocks[0].ctx_ptr;   // one PowerPCState for all

    // ---- Module assembly (section order: type, import, func, global, export, code) ----
    WasmModuleBuilder b;
    b.emitHeader();
    b.emitTypeSection(4);
    {
        const u8 i32t[]  = { WASM_TYPE_I32 };
        const u8 i32x2[] = { WASM_TYPE_I32, WASM_TYPE_I32 };
        b.emitFuncType(nullptr, 0, i32t, 1);
        b.emitFuncType(i32t, 1, i32t, 1);
        b.emitFuncType(i32x2, 2, nullptr, 0);
        b.emitFuncType(i32x2, 2, i32t, 1);
    }
    b.endSection();
    b.emitImportSection(2u + WIMPORT_COUNT);
    b.emitImportMemory("env", "memory", mem_pages > 0u ? mem_pages : 1u);
    b.emitImportFunc("env", "ppc_read8",        1);   // 0
    b.emitImportFunc("env", "ppc_read16",       1);   // 1
    b.emitImportFunc("env", "ppc_read32",       1);   // 2
    b.emitImportFunc("env", "ppc_write8",       2);   // 3
    b.emitImportFunc("env", "ppc_write16",      2);   // 4
    b.emitImportFunc("env", "ppc_write32",      2);   // 5
    b.emitImportFunc("env", "ppc_interp",       2);   // 6
    b.emitImportFunc("env", "ppc_check_exc",    1);   // 7
    b.emitImportFunc("env", "ppc_break_block",  2);   // 8
    b.emitImportFunc("env", "ppc_hle_check",    1);   // 9
    b.emitImportFunc("env", "ppc_hle_fire",     3);   // 10
    b.emitImportFunc("env", "ppc_msr_updated",  2);   // 11
    b.emitImportFunc("env", "ppc_gather_drain", 2);   // 12
    // [cross-gen fix 2026-07-15] Import the GLOBAL __indirect_function_table so
    // merged bodies can fall through mrtag-miss/gen-mismatch to the STANDARD
    // global-table chain (return_call_indirect) instead of a host bounce —
    // without this, every cross-gen/unsealed exit cost a host round-trip that
    // the per-block path chained in-wasm (measured: promote-ON -25% aggregate).
    b.emitImportTable("env", "__indirect_function_table", /*initial*/0u, /*hasMax*/false);
    b.endSection();
    {
        std::vector<u32> typeIndices(1u + n_blocks, 0u);
        b.emitFunctionSection(1u + n_blocks, typeIndices.data());
    }
    b.beginGlobalSection(2u);
    b.emitGlobalI32Mut(0);   // global 0: entry_sel
    b.emitGlobalI32Mut(0);   // global 1: laps
    b.endSection();
    b.beginExportSection(2u + n_blocks);
    b.emitExport("region",    WASM_EXPORT_FUNC,   WIMPORT_COUNT);
    b.emitExport("entry_sel", WASM_EXPORT_GLOBAL, 0u);
    {
        char name[24];
        for (u32 i = 0; i < n_blocks; ++i) {
            std::snprintf(name, sizeof(name), "fn_%u", (unsigned)i);
            b.emitExport(name, WASM_EXPORT_FUNC, WIMPORT_COUNT + 1u + i);
        }
    }
    b.endSection();
    b.beginCodeSection(1u + n_blocks);
    // ---- $region ----
    b.beginFuncBody();
    {
        // Identical 8-group local layout to build_block_next — the spliced
        // bodies hardcode these indices.
        const u32 counts[] = { 2u, 32u, 64u, 2u, 1u, 2u, 17u, 32u };
        const u8  types[]  = { WASM_TYPE_I32, WASM_TYPE_I32, WASM_TYPE_I64,
                               WASM_TYPE_I32, WASM_TYPE_F64, WASM_TYPE_I64,
                               WASM_TYPE_F64, WASM_TYPE_V128 };
        b.emitLocals(8u, counts, types);
    }
    // [region-resident 2026-07-15] Activation pad: load ALL 32 GPRs into their
    // identity locals (preg n -> local 2+n, RegCache::OnBlockEntry layout) ONCE
    // per host entry. Warm edges `br` back to the loop below — the SAME
    // activation — so bodies skip every GPR prologue reload (MarkAllLoaded)
    // and V8 can keep the guest registers in host registers across edges.
    // GPR offsets: PowerPCState gpr[] base 0x14 + 4n (reg_cache.cpp
    // ppc_gpr_off, matches gekko ppc_off::gpr()).
    for (u32 n = 0; n < 32u; ++n) {
        b.op_i32_const((s32)ctx_ptr_any);
        b.op_i32_load(0x14u + 4u * n);
        b.op_local_set(2u + n);
    }
    b.op_loop(BLOCK_TYPE_VOID);                   // $L — warm edges land here
    // Dispatch skeleton: $DEF outermost (inside $L), then $B_{N-1} .. $B_0.
    for (u32 i = 0; i < n_blocks + 1u; ++i) b.op_block(BLOCK_TYPE_VOID);
    b.op_global_get(0u);                          // entry_sel
    {
        std::vector<u32> labels(n_blocks);
        for (u32 k = 0; k < n_blocks; ++k) labels[k] = k;   // depth k = $B_k
        b.op_br_table(labels.data(), n_blocks, /*default=*/n_blocks);  // = $DEF
    }
    for (u32 k = 0; k < n_blocks; ++k) {
        b.op_end();                               // close $B_k — br_table lands here
        b.emitBytes(bodies[k].data(), bodies[k].size());
    }
    b.op_end();                                   // close $DEF — default arm
    // Default (sel out of range — never set by wrappers/edges, but the
    // validator needs the arm): return current PC to the host, which
    // re-resolves through the normal dispatch. NOT gekko's silent block-0.
    b.op_i32_const((s32)ctx_ptr_any);
    b.op_i32_load(ppc_off::PC);
    b.op_return();
    b.op_end();                                   // close $L (unreachable edge)
    b.op_unreachable();                           // loop never falls through
    b.endFuncBody();
    // ---- fn_k entry wrappers ----
    for (u32 k = 0; k < n_blocks; ++k) {
        b.beginFuncBody();
        b.emitLocals(0u, nullptr, nullptr);
        // Host-boundary contract: reset the consecutive-tail-chain budget so
        // the idle-skip streak detector keeps observing (block_cache.cpp:448).
        b.op_i32_const((s32)blr_chain_addr);
        b.op_i32_const(0);
        b.op_i32_store(0);
        b.op_i32_const(0);
        b.op_global_set(1u);                      // laps = 0 (per host entry)
        b.op_i32_const((s32)k);
        b.op_global_set(0u);                      // entry_sel = k
        b.op_return_call(WIMPORT_COUNT);          // tail into $region
        b.endFuncBody();
    }
    b.endSection();
    return b.getBytes();
}


}  // namespace bemental::powerpc

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
        case 1014: emit_dcbz(wb, rc, frc, op, params.ctx_ptr);                  return true;

        // Sync / cache barriers / cache hints — emit nothing. The emulator's
        // linear memory model has no real cache to flush/invalidate/prefetch.
        //   598 sync/lwsync, 854 eieio, 982 icbi (i-cache invalidate),
        //    86 dcbf, 54 dcbst, 470 dcbi, 278 dcbt, 246 dcbtst.
        case 598: case 854: case 982:
        case 86:  case 54:  case 470:
        case 278: case 246:
            return true;

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
    case 52: case 53:   // stfs/stfsu — deferred, needs PEM ConvertToSingle
    case 56: case 57:
    case 59:
    case 60: case 61:
        emit_fallback(wb, rc, frc, op, params.ctx_ptr);
        return false;

    // Opcode 63 — scalar f64 trivial sign/copy ops (fmr/fneg/fabs/fnabs).
    // All others (fadd/fsub/fmul/fdiv/fmadd family/fcmpu/o/frsp/fctiw*/
    // mffs/mtfsf*) still routed to interp pending full op63 port.
    case 63: {
        switch (sub10) {
        case  72: emit_fmrx  (wb, rc, frc, op, params.ctx_ptr); return true;
        case  40: emit_fnegx (wb, rc, frc, op, params.ctx_ptr); return true;
        case 264: emit_fabsx (wb, rc, frc, op, params.ctx_ptr); return true;
        case 136: emit_fnabsx(wb, rc, frc, op, params.ctx_ptr); return true;
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

    // ---- Import section: 1 memory + WIMPORT_COUNT (= 13) host functions ----
    b.emitImportSection(1u + WIMPORT_COUNT);
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
        const u32 counts[] = { 2u, 32u, 64u };
        const u8  types[]  = { WASM_TYPE_I32, WASM_TYPE_I32, WASM_TYPE_I64 };
        b.emitLocals(3u, counts, types);
    }

    // RegCache: assign per-PPC-GPR WASM locals + emit prologue loads
    // for live-in registers.
    RegCache rc(b);
    rc.OnBlockEntry(block, /*wasm_local_base=*/2u, ctx_ptr);
    rc.EmitPrologueLoads(ctx_ptr);

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

        // Pre-op set_pc — mirrors live gekko_emit.cpp:4023+. Native
        // emitters don't write ppc_state.pc; without this pre-set, a later
        // op in the same block that falls back to dolphin_interp sees a
        // stale pc and the dolphin_interp guard (`if (ppc_state.pc != pc)
        // return`, search JitWasm.cpp for that conditional) bails before
        // SingleStepInner runs. Historically observed on the SAB 0x500
        // EXT_INT path: addis/addi/mtspr ran natively without updating pc,
        // then rfi fell back; the interp guard saw stale pc and skipped
        // the rfi, leaving the block in a self-loop until idle-skip
        // heuristics tripped.
        b.op_i32_const((s32)ctx_ptr);
        b.op_i32_const((s32)op.address);
        b.op_i32_store(ppc_off::PC);

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
        const bool emitted_native = dispatch_op(b, rc, frc, op, params);

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
        // BISECT 2026-06-10: disabled pending investigation — first probe
        // with this enabled wedged boot at 27 PCs with a +4 block-compile
        // walk through low memory (0x17ec...). See STATUS.md.
        if (false && is_terminator && emitted_native &&
            !(op.opinfo && op.opinfo->type == OpType::Branch)) {
            b.op_i32_const((s32)ctx_ptr);
            b.op_i32_const((s32)(op.address + 4u));
            b.op_i32_store(ppc_off::PC);
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
        b.op_i32_const(0);
        b.op_i32_const(0);
        b.op_call(WIMPORT_GATHER_DRAIN);
    }

    // Flush dirty FPR lanes back to PowerPCState before the GPR flush.
    // In step 3 wiring no emit_* writes the cache so this is a no-op (no
    // dirty bits set), but the call sits structurally where future emit-
    // site conversions will need it. Per step-3 plan: prologue load +
    // epilogue flush form a bit-exact round-trip on FPR memory.
    frc.Flush(ctx_ptr);
    rc.Flush(ctx_ptr);
    b.op_i32_const((s32)ctx_ptr);
    b.op_i32_load(ppc_off::PC);
    b.op_return();

    b.endFuncBody();
    b.endSection();

    return b.getBytes();
}


#ifdef BEMENTALJIT_USE_REBUILD

// Region-path _next implementations: PASSTHROUGHS to the live bemental::
// powerpc:: functions in guests/powerpc/gekko_emit.cpp. Real implementations
// were attempted but require including ../powerpc/gekko_emit.h, which ODR-
// collides with powerpc-next's own ppc_offsets.h (both define ppc_off::spr/
// gpr/etc in the same namespace) and with the local WIMPORT_INTERP constant.
//
// Follow-up: extract BlockInputs + LocalIdxLookupFn + WIMPORT_* + ppc_off::*
// into a third shared header (e.g. bementalJIT/include/bementalJIT/ppc_shared.h)
// that both gekko_emit.h and powerpc-next headers can include without
// collision. Then re-introduce the real region impls so the region path
// exercises the per-op HLE check, const-MMIO routing, and LR-stack push/pop
// natively rather than via the live-gekko forward.

// Forward decls for the live functions we forward to.
std::vector<u8> emit_block_body(u32 start_pc, const u32* insts, u32 count,
                                u32 ctx_ptr_const,
                                u32 mem1_base, u32 mem1_mask, u32 ram_size,
                                const u32* instr_pcs,
                                LocalIdxLookupFn lookup_fn,
                                const void* lookup_user,
                                bool emit_hle_check,
                                bool emit_perf_stub,
                                bool emit_hle_check_native);
std::vector<u8> build_region_module(const u8* concatenated_bodies,
                                    std::size_t concatenated_size,
                                    u32 n_funcs,
                                    u32 mem_pages);
std::vector<u8> build_region_function(const BlockInputs* blocks,
                                      u32 n_blocks,
                                      LocalIdxLookupFn lookup_fn,
                                      const void* lookup_user,
                                      u32 mem_pages);

std::vector<u8> emit_block_body_next(u32 start_pc, const u32* insts, u32 count,
                                     u32 ctx_ptr_const,
                                     u32 mem1_base, u32 mem1_mask, u32 ram_size,
                                     const u32* instr_pcs,
                                     LocalIdxLookupFn lookup_fn,
                                     const void* lookup_user,
                                     bool emit_hle_check,
                                     bool emit_perf_stub,
                                     bool emit_hle_check_native) {
    return emit_block_body(start_pc, insts, count, ctx_ptr_const,
                           mem1_base, mem1_mask, ram_size, instr_pcs,
                           lookup_fn, lookup_user, emit_hle_check,
                           emit_perf_stub, emit_hle_check_native);
}

std::vector<u8> build_region_module_next(const u8* concatenated_bodies,
                                         std::size_t concatenated_size,
                                         u32 n_funcs,
                                         u32 mem_pages) {
    return build_region_module(concatenated_bodies, concatenated_size,
                               n_funcs, mem_pages);
}

std::vector<u8> build_region_function_next(const BlockInputs* blocks,
                                           u32 n_blocks,
                                           LocalIdxLookupFn lookup_fn,
                                           const void* lookup_user,
                                           u32 mem_pages) {
    return build_region_function(blocks, n_blocks, lookup_fn, lookup_user,
                                 mem_pages);
}

#endif  // BEMENTALJIT_USE_REBUILD


}  // namespace bemental::powerpc

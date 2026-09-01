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
#include "idle_skip.h"
#include "jit_branch.h"
#include "jit_compare.h"
#include "jit_integer.h"
#include "jit_load_store.h"
#include "jit_system_registers.h"
#include "ppc_analyst.h"
#include "ppc_offsets.h"
#include "reg_cache.h"

// NOTE: Cannot include "../powerpc/gekko_emit.h" — both libs share the
// `bemental::powerpc` namespace and have parallel definitions for spr/gpr/
// WIMPORT_* enum / BlockInputs, causing ODR redefinition collisions.
// Until a follow-up extracts shared types to a third-party header, the
// region implementations below stay as passthroughs to the live functions
// (forward-declared inside #ifdef BEMENTALJIT_USE_REBUILD blocks below).
// Agent 4's real region impls (which deref BlockInputs members and would
// route the SAB wedge path through powerpc-next ports) are reverted.

namespace bemental::powerpc {

static constexpr u32 WIMPORT_INTERP = 6;

// Emit a fallback call to WIMPORT_INTERP for an op without a native
// emitter. Caller flushes regcache state first.
static void emit_fallback(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                          u32 ctx_ptr) {
    rc.Flush(ctx_ptr);
    wb.op_i32_const((s32)op.inst);
    wb.op_i32_const((s32)op.address);
    wb.op_call(WIMPORT_INTERP);
}

bool dispatch_op(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                 LoadStoreParams params) {
    const u32 inst  = op.inst;
    const u32 opcd  = GekkoOperands::OPCD(inst);
    const u32 sub10 = GekkoOperands::SUBOP10(inst);

    switch (opcd) {
    // ---- D-form integer / logical ----
    case 7:  emit_mulli  (wb, rc, op);                       return true;
    case 8:  emit_subfic (wb, rc, op, params.ctx_ptr);       return true;
    case 10: emit_cmpli  (wb, rc, op, params.ctx_ptr);       return true;
    case 11: emit_cmpi   (wb, rc, op, params.ctx_ptr);       return true;
    case 12: emit_addic  (wb, rc, op, params.ctx_ptr);       return true;
    case 14: emit_addi   (wb, rc, op);                       return true;
    case 15: emit_addis  (wb, rc, op);                       return true;
    case 24: emit_ori    (wb, rc, op);                       return true;
    case 25: emit_oris   (wb, rc, op);                       return true;
    case 26: emit_xori   (wb, rc, op);                       return true;
    case 27: emit_xoris  (wb, rc, op);                       return true;

    // ---- D-form loads ----
    case 32: emit_load_d (wb, rc, params, op, LoadWidth::U32, false); return true;
    case 33: emit_load_d (wb, rc, params, op, LoadWidth::U32, true);  return true;
    case 34: emit_load_d (wb, rc, params, op, LoadWidth::U8,  false); return true;
    case 35: emit_load_d (wb, rc, params, op, LoadWidth::U8,  true);  return true;
    case 40: emit_load_d (wb, rc, params, op, LoadWidth::U16, false); return true;
    case 41: emit_load_d (wb, rc, params, op, LoadWidth::U16, true);  return true;
    case 42: emit_load_d (wb, rc, params, op, LoadWidth::S16, false); return true;
    case 43: emit_load_d (wb, rc, params, op, LoadWidth::S16, true);  return true;

    // ---- D-form stores ----
    case 36: emit_store_d(wb, rc, params, op, StoreWidth::U32, false); return true;
    case 37: emit_store_d(wb, rc, params, op, StoreWidth::U32, true);  return true;
    case 38: emit_store_d(wb, rc, params, op, StoreWidth::U8,  false); return true;
    case 39: emit_store_d(wb, rc, params, op, StoreWidth::U8,  true);  return true;
    case 44: emit_store_d(wb, rc, params, op, StoreWidth::U16, false); return true;
    case 45: emit_store_d(wb, rc, params, op, StoreWidth::U16, true);  return true;

    // ---- Rotate / mask ----
    case 20: emit_rlwimix(wb, rc, op);                       return true;
    case 21: emit_rlwinmx(wb, rc, op);                       return true;
    case 23: emit_rlwnmx (wb, rc, op);                       return true;

    // ---- Branch (D-form) ----
    case 16: emit_bcx    (wb, rc, op, params.ctx_ptr);       return true;
    case 18: emit_bx     (wb, rc, op, params.ctx_ptr);       return true;

    case 19:
        switch (sub10) {
        case 16:  emit_bclrx (wb, rc, op, params.ctx_ptr);   return true;
        case 528: emit_bcctrx(wb, rc, op, params.ctx_ptr);   return true;
        case 50:  emit_rfi   (wb, rc, op, params.ctx_ptr);   return true;
        case 150: /* isync */                                return true;
        default:  break;
        }
        break;

    case 31:
        switch (sub10) {
        // X-form integer
        case 266: case 778: emit_addx  (wb, rc, op);                       return true;
        case 40:  case 552: emit_subfx (wb, rc, op);                       return true;
        case 235: case 747: emit_mullwx(wb, rc, op);                       return true;
        case 28:            emit_andx  (wb, rc, op);                       return true;
        case 444:           emit_orx   (wb, rc, op);                       return true;
        case 316:           emit_xorx  (wb, rc, op);                       return true;
        case 124:           emit_norx  (wb, rc, op);                       return true;
        case 24:            emit_slwx  (wb, rc, op);                       return true;
        case 536:           emit_srwx  (wb, rc, op);                       return true;
        case 792:           emit_srawx (wb, rc, op, params.ctx_ptr);       return true;
        case 824:           emit_srawix(wb, rc, op, params.ctx_ptr);       return true;
        case 954:           emit_extsbx(wb, rc, op);                       return true;
        case 922:           emit_extshx(wb, rc, op);                       return true;
        case 26:            emit_cntlzwx(wb, rc, op);                      return true;
        case 104:           emit_negx  (wb, rc, op);                       return true;
        case 138: case 650: emit_addex (wb, rc, op, params.ctx_ptr);       return true;
        case 136: case 648: emit_subfex(wb, rc, op, params.ctx_ptr);       return true;
        case 234: case 746: emit_addmex(wb, rc, op, params.ctx_ptr);       return true;
        case 232: case 744: emit_subfmex(wb, rc, op, params.ctx_ptr);      return true;
        case 202: case 714: emit_addzex(wb, rc, op, params.ctx_ptr);       return true;
        case 200: case 712: emit_subfzex(wb, rc, op, params.ctx_ptr);      return true;
        case 0:             emit_cmp   (wb, rc, op, params.ctx_ptr);       return true;
        case 32:            emit_cmpl  (wb, rc, op, params.ctx_ptr);       return true;

        // X-form loads
        case 23:  emit_load_x (wb, rc, params, op, LoadWidth::U32, false); return true;
        case 55:  emit_load_x (wb, rc, params, op, LoadWidth::U32, true);  return true;
        case 87:  emit_load_x (wb, rc, params, op, LoadWidth::U8,  false); return true;
        case 119: emit_load_x (wb, rc, params, op, LoadWidth::U8,  true);  return true;
        case 279: emit_load_x (wb, rc, params, op, LoadWidth::U16, false); return true;
        case 311: emit_load_x (wb, rc, params, op, LoadWidth::U16, true);  return true;
        case 343: emit_load_x (wb, rc, params, op, LoadWidth::S16, false); return true;
        case 375: emit_load_x (wb, rc, params, op, LoadWidth::S16, true);  return true;

        // X-form stores
        case 151: emit_store_x(wb, rc, params, op, StoreWidth::U32, false); return true;
        case 183: emit_store_x(wb, rc, params, op, StoreWidth::U32, true);  return true;
        case 215: emit_store_x(wb, rc, params, op, StoreWidth::U8,  false); return true;
        case 247: emit_store_x(wb, rc, params, op, StoreWidth::U8,  true);  return true;
        case 407: emit_store_x(wb, rc, params, op, StoreWidth::U16, false); return true;
        case 439: emit_store_x(wb, rc, params, op, StoreWidth::U16, true);  return true;

        // System registers
        case 339: emit_mfspr(wb, rc, op, params.ctx_ptr);                  return true;
        case 467: emit_mtspr(wb, rc, op, params.ctx_ptr);                  return true;
        case 83:  emit_mfmsr(wb, rc, op, params.ctx_ptr);                  return true;
        case 146: emit_mtmsr(wb, rc, op, params.ctx_ptr);                  return true;

        // Sync / cache barriers — emit nothing.
        case 598: case 854: case 982:                                       return true;

        default: break;
        }
        break;

    default: break;
    }
    // No native emitter for this op — fallback to interp.
    emit_fallback(wb, rc, op, params.ctx_ptr);
    return false;
}

// ---------------------------------------------------------------------------
// build_block_next — Phase 4.7 full build-block.
//
//   1. PPCAnalyzer::Analyze on the supplied instruction stream
//   2. Emit complete WASM module:
//        header + type(4) + import(1 memory + 11 funcs) + function(1) +
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
// Phase 7 cut-over is binary-compatible: same 11-import set, same export
// name and index (= WIMPORT_COUNT), same function type 0 = () -> i32.
//
// The JS-side import-binding code keys on the import names, not indices,
// so the rebuild can safely use the same shim runtime.
// ---------------------------------------------------------------------------
std::vector<u8> build_block_next(u32 start_pc,
                                 const u32* insts, u32 count,
                                 u32 ctx_ptr,
                                 u32 mem1_base, u32 mem1_mask, u32 ram_size) {
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

    // ---- Import section: 1 memory + 11 host functions ----
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
    // cache locals (indices 2..33). RegCache uses wasm_local_base=2.
    {
        const u32 counts[] = { 2u, 32u };
        const u8  types[]  = { WASM_TYPE_I32, WASM_TYPE_I32 };
        b.emitLocals(2u, counts, types);
    }

    // RegCache: assign per-PPC-GPR WASM locals + emit prologue loads
    // for live-in registers.
    RegCache rc(b);
    rc.OnBlockEntry(block, /*wasm_local_base=*/2u);
    rc.EmitPrologueLoads(ctx_ptr);

    LoadStoreParams params;
    params.ctx_ptr   = ctx_ptr;
    params.mem1_base = mem1_base;
    params.mem1_mask = mem1_mask;
    params.ram_size  = ram_size;

    // Per-CodeOp dispatch. 2026-05-18 port of JIT64's HandleFunctionHooking
    // (Jit.cpp:1065-1066): JIT64 calls HLE::TryReplaceFunction on EVERY op's
    // address, not just block start. If any mid-block op is HLE-hooked, the
    // hook fires and the block exits there. This catches wild-branch-into-
    // mid-function cases (the SAB wedge at 0x800e5778 where ppc-worker landed
    // mid-OSLoadContext with r3=0 and the registered HLE patch at the function
    // entry never had a chance to fire). Previous port only emitted the HLE
    // prologue at start_pc once — equivalent to JIT64 calling HandleFunctionHooking
    // only at op[0], which doesn't catch downstream hooked PCs.
    //
    // RegCache must be flushed before the HLE call so the host sees current
    // GPR state if the hook reads ppc_state.
    //
    // Idle-skip override fires only for the terminator (last op) when the
    // analyzer flagged branchIsIdleLoop.
    const std::size_t n_ops = buffer.size();
    for (std::size_t i = 0; i < n_ops; ++i) {
        const CodeOp& op = buffer[i];
        const bool is_terminator = (i + 1 == n_ops);

        // Per-op HLE check (was: emit_hle_prologue at block-start only).
        // emit_hle_prologue emits the if/return early-exit shape; if the
        // host's hle_check returns 0 (not hooked), the wasm falls through
        // to the dispatch_op below. Cost = one i32_const + one host call
        // per op when not hooked; the trade-off is correctness for wild
        // mid-function branches.
        rc.Flush(ctx_ptr);
        emit_hle_prologue(b, ctx_ptr, op.address);

        if (is_terminator && op.branchIsIdleLoop) {
            emit_idle_skip(b, rc, op, ctx_ptr);
        } else {
            dispatch_op(b, rc, op, params);
        }
    }

    // Epilogue: flush dirty GPR locals, then read PC back and return.
    // The trailing i32 satisfies type 0's i32 result.
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
// collision. Then re-introduce the real region impls so the SAB wedge path
// exercises the per-op HLE check (task 25), const-MMIO routing (task 26),
// and LR-stack push/pop (task 27).

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

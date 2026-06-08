#pragma once
//
// ppc_emit.h — Phase 4 / pre-Phase-7 entry point. dispatch_op() routes
// a single CodeOp to the right Phase 4 emit_* function based on the
// opcode. Ops without a native emitter call WIMPORT_INTERP (fallback).
//
// build_block_next() is the new build_block — the eventual replacement
// for live gekko_emit.cpp's build_block. Phase 7 cut-over flips the
// dolphin-side caller from build_block (live) to build_block_next
// (rebuild). Until then, build_block_next is callable but the live
// runtime doesn't invoke it.

#include <cstddef>
#include <vector>

#include "bementalJIT/types.h"
#include "code_op.h"
#include "jit_load_store.h"
#include "reg_cache.h"

class WasmModuleBuilder;

namespace bemental::powerpc {

// ---------------------------------------------------------------------------
// Region-build / block-body callback types (shared with live powerpc/).
// The canonical definitions live in guests/powerpc/gekko_emit.h. Both libs
// share the `bemental::powerpc` namespace so the names refer to the same
// entity — but the C++ ODR forbids two FULL DEFINITIONS in different TUs
// even when layouts match. Forward-declare here; the only consumers of
// the layout (the `_next` wrapper implementations in ppc_emit.cpp) include
// gekko_emit.h to see the full definition. block_cache.cpp does the same.
// ---------------------------------------------------------------------------
using LocalIdxLookupFn = bool(*)(const void* user, u32 target_pc, u32* out_local_idx);

struct BlockInputs;  // full definition in guests/powerpc/gekko_emit.h


// Dispatch one CodeOp: route to the right Phase 4 emit fn.  Falls back
// to WIMPORT_INTERP for ops without a native emitter (paired-singles,
// FP arith, complex SPRs, segment registers, etc.).
//
// Returns true if a native emitter was invoked; false on fallback.
bool dispatch_op(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op,
                 LoadStoreParams params);

// Phase 4 build_block — eventual cut-over target. Phase 1 deliverable
// onward; not yet called by live runtime.
//
// Arguments mirror live build_block enough that integration is mostly
// a re-bind on the caller side.
// out_cycles (optional): receives the analyzer's summed opinfo->num_cycles
// for the decoded block. Used by JitWasm::Run to drain downcount accurately
// per Jit64's js.downcountAmount semantics (Jit.cpp:1003,587,715). Without
// this, blocks dominated by div/mul/lmw/dcb* drain downcount too slowly
// and CoreTiming events fire late (pass-2 audit w6oeq0l6e RANK 12).
//
// out_is_idle_loop (optional): true iff the analyst classified the block's
// terminator as a busy-wait loop (branchIsIdleLoop, e.g. mftb-poll). The
// JitWasm dispatcher uses this to force downcount=0 only on idle blocks —
// without this gate, CTR-counted cache-flush loops (DCFlushRange et al)
// get force-zeroed every iteration → 6.65M Advance-bound iterations
// observed in pass-7 (workflow a449a929c58f3908c). branchIsIdleLoop is
// set by IsBusyWaitLoop at ppc_analyst.cpp:414-415.
std::vector<u8> build_block_next(u32 start_pc,
                                 const u32* insts, u32 count,
                                 u32 ctx_ptr,
                                 u32 mem1_base, u32 mem1_mask, u32 ram_size,
                                 u32* out_cycles = nullptr,
                                 bool* out_is_idle_loop = nullptr);

// ---------------------------------------------------------------------------
// _next region/block-body entry points.
//
// block_cache.cpp's region_relink and JitWasm.cpp's per-block-body emit
// path call emit_block_body / build_region_module / build_region_function
// on every JIT step. When BEMENTALJIT_USE_REBUILD=ON, those callsites are
// gated to the _next variants below.
//
// Implementations (ppc_emit.cpp):
//   All three _next entry points are currently PASSTHROUGHS to the live
//   guests/powerpc/ gekko_emit.cpp symbols, gated by BEMENTALJIT_USE_REBUILD.
//   The ODR collision blocking real impls is documented in ppc_emit.cpp's
//   region-section header comment; resolving it (extract BlockInputs +
//   LocalIdxLookupFn + WIMPORT_* + ppc_off::* into a shared third header)
//   unblocks routing the region path through the powerpc-next dispatch /
//   RegCache / HLE-prologue chain rather than the live forward.
//
// Known gap: merged-region intra-region branch resolution (global.set
// entry_sel + br $L) is not yet implemented in powerpc-next's jit_branch
// emitters. Intra-region branches in build_region_function_next emit
// set-pc + return (host-bounce), correctness-preserving. Future patch
// must add MergedModeArgs plumbing into emit_bx/emit_bcx.
//
// Both libraries are linked together when BEMENTALJIT_USE_REBUILD=ON, so
// build_region_module_next can resolve the unsuffixed live symbol.
// ---------------------------------------------------------------------------
std::vector<u8> emit_block_body_next(u32 start_pc, const u32* insts, u32 count,
                                     u32 ctx_ptr_const,
                                     u32 mem1_base, u32 mem1_mask,
                                     u32 ram_size,
                                     const u32* instr_pcs,
                                     LocalIdxLookupFn lookup_fn,
                                     const void* lookup_user,
                                     bool emit_hle_check = true,
                                     bool emit_perf_stub = false,
                                     bool emit_hle_check_native = false);

std::vector<u8> build_region_module_next(const u8* concatenated_bodies,
                                         std::size_t concatenated_size,
                                         u32 n_funcs,
                                         u32 mem_pages = 1);

std::vector<u8> build_region_function_next(const BlockInputs* blocks,
                                           u32 n_blocks,
                                           LocalIdxLookupFn lookup_fn,
                                           const void* lookup_user,
                                           u32 mem_pages = 1);

}  // namespace bemental::powerpc

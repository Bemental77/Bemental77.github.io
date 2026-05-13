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
std::vector<u8> build_block_next(u32 start_pc,
                                 const u32* insts, u32 count,
                                 u32 ctx_ptr,
                                 u32 mem1_base, u32 mem1_mask, u32 ram_size);

}  // namespace bemental::powerpc

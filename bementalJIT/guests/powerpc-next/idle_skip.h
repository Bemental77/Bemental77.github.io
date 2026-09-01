#pragma once
//
// idle_skip.h — Phase 4 idle-loop early-exit (B1). Mirrors the live
// tree's idle-skip behavior driven by CodeBlock::branchIsIdleLoop (set
// by PPCAnalyzer::IsBusyWaitLoop).
//
// When the block's terminator branches back to start AND no intervening
// op has a side effect, the analyzer marks branchIsIdleLoop=true. The
// emitter then replaces the terminator with a downcount-advance + early
// return — equivalent to "the dispatcher would just spin here, so let
// it consume the rest of its quantum and exit."

#include "bementalJIT/types.h"
#include "code_op.h"

class WasmModuleBuilder;

namespace bemental::powerpc {

class RegCache;

// Emit the idle-skip sequence. Caller has already determined that this
// block is an idle loop (CodeOp[last].branchIsIdleLoop is true).
//   - Advance ppc_state.downcount to a known-low value (or zero).
//   - Write target PC to ppc_state.pc.
//   - Return.
// Stack-neutral.
void emit_idle_skip(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& term,
                    u32 ctx_ptr);

}  // namespace bemental::powerpc

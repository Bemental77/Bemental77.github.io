#pragma once
//
// CodeOp + CodeBlock — IR substrate consumed by ppc_analyst.cpp and (later)
// by the per-op emitters (jit_integer.cpp, jit_load_store.cpp, ...).
//
// Layout mirrors Dolphin's PPCAnalyst::CodeOp / CodeBlock exactly so the
// Phase 1 oracle test can diff bit-exact against native Dolphin output on
// the same byte stream. Full Jit64 width is shipped from Phase 1
// (forward-compatible with later FP-aware emit phases).

#include <cstddef>
#include <vector>

#include "bementalJIT/types.h"
#include "common/bit_set.h"
#include "common/op_info.h"

namespace bemental::powerpc {

// Per-instruction record. ~16 B effective payload + analyzer-populated
// metadata.
struct CodeOp {
    u32 inst       = 0;  // raw 32-bit instruction word
    const GekkoOPInfo* opinfo = nullptr;
    u32 address    = 0;
    u32 branchTo   = 0xFFFFFFFFu;  // INVALID_BRANCH_TARGET when not a branch

    // Live-in / live-out reg-flow.
    BitSet32 regsIn;
    BitSet32 regsOut;
    BitSet32 fregsIn;
    s8       fregOut = -1;
    BitSet8  crIn;
    BitSet8  crOut;

    // Branch-merge / carry-merge / CROR-merge metadata.
    bool   branchUsesCtr      = false;
    bool   branchIsIdleLoop   = false;
    BitSet8 wantsCR;
    bool   wantsFPRF          = false;
    bool   wantsCA            = false;
    bool   wantsCAInFlags     = false;
    BitSet8 outputCR;
    bool   outputFPRF         = false;
    bool   outputCA           = false;

    bool   canEndBlock        = false;
    bool   canCauseException  = false;
    bool   skipLRStack        = false;
    bool   skip               = false;  // followed BL-s, e.g.

    // Reachability / discardability (reverse-scan output).
    BitSet8  crInUse;
    BitSet8  crDiscardable;
    BitSet32 fprInUse;
    BitSet32 gprInUse;
    BitSet32 gprDiscardable;
    BitSet32 fprDiscardable;

    // Single-precision / duplicated-FPR / store-safety tracking (FP phases).
    BitSet32 fprInXmm;             // retained for source-compat with Jit64 IR
    BitSet32 fprIsSingle;
    BitSet32 fprIsDuplicated;
    BitSet32 fprIsStoreSafeBeforeInst;
    BitSet32 fprIsStoreSafeAfterInst;

    BitSet32 GetFregsOut() const {
        BitSet32 result;
        if (fregOut >= 0) result[fregOut] = true;
        return result;
    }
};

struct BlockStats {
    u32 numCycles = 0;
};

struct BlockRegStats {
    bool any = false;
};

using CodeBuffer = std::vector<CodeOp>;

struct CodeBlock {
    u32 m_address           = 0;
    u32 m_num_instructions  = 0;

    BlockStats*    m_stats = nullptr;
    BlockRegStats* m_gpa   = nullptr;
    BlockRegStats* m_fpa   = nullptr;

    bool m_broken          = false;
    bool m_memory_exception = false;

    BitSet8  m_gqr_used;
    BitSet8  m_gqr_modified;

    // GPRs read before defined — block's live-in set.
    BitSet32 m_gpr_inputs;

    // Physical-address range tracking is deferred to a later phase
    // (Common::RangeSet<u32> port). Phase 1 leaves the field absent.
};

constexpr u32 INVALID_BRANCH_TARGET = 0xFFFFFFFFu;

}  // namespace bemental::powerpc

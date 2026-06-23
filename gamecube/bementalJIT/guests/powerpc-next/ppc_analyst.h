#pragma once
//
// PPCAnalyzer — ported shape of Dolphin's PPCAnalyst::PPCAnalyzer.
//
// Walks an instruction stream starting at a guest PC, decodes each Gekko
// instruction, classifies it via lookup_op_info(), and populates CodeOp
// records with reg-flow + branch-merge metadata. Optionally inlines
// unconditional branches/follows BL-s. Detects idle-loop blocks.
//
// Not ported in Phase 1 (deferred):
// - Branch-merge / carry-merge / CROR-merge reorder passes (require an
//   in-place CodeOp[] reorder pass; depends on the per-op file split).
// - m_physical_addresses RangeSet (depends on the RangeSet port).
//
// Phase 1 acceptance: produces bit-exact regsIn/regsOut/fregsIn/fregOut/
// crIn/crOut/wantsCA/outputCA/canEndBlock against Dolphin's analyzer for
// the same byte stream.

#include <cstddef>

#include "bementalJIT/types.h"
#include "code_op.h"

namespace bemental::powerpc {

class PPCAnalyzer {
public:
    enum AnalystOption {
        OPTION_CONDITIONAL_CONTINUE = (1 << 0),
        OPTION_BRANCH_FOLLOW        = (1 << 1),
        OPTION_COMPLEX_BLOCK        = (1 << 2),  // unused / Phase >1
        OPTION_FORWARD_JUMP         = (1 << 3),  // unused / Phase >1
        OPTION_BRANCH_MERGE         = (1 << 4),  // Phase 4
        OPTION_CARRY_MERGE          = (1 << 5),  // Phase 4
        OPTION_CROR_MERGE           = (1 << 6),  // Phase 4
    };

    void SetOption(AnalystOption option)             { m_options |= option; }
    void ClearOption(AnalystOption option)           { m_options &= ~option; }
    bool HasOption(AnalystOption option) const       { return (m_options & option) != 0; }
    void SetBranchFollowingEnabled(bool enabled)     { m_enable_branch_following = enabled; }
    void SetFloatExceptionsEnabled(bool enabled)     { m_enable_float_exceptions = enabled; }
    void SetDivByZeroExceptionsEnabled(bool enabled) { m_enable_div_by_zero_exceptions = enabled; }

    // Decode instructions starting at `address` (limit `block_size` ops) into
    // `buffer`. Fills `block` with reg-flow + endblock + stats. Caller
    // supplies a fetch callback that returns the instruction word at a guest
    // PC — sidesteps any direct dependency on a specific MMU.
    //
    // Returns the start PC of the next block (PC just past the last decoded
    // instruction). When the decoder follows a branch into a different
    // region, that target PC is returned.
    using FetchFn = u32 (*)(u32 pc, void* user);
    u32 Analyze(u32 address, CodeBlock* block, CodeBuffer* buffer,
                std::size_t block_size, FetchFn fetch, void* fetch_user) const;

private:
    bool IsBusyWaitLoop(CodeBlock* block, CodeOp* code, std::size_t instructions) const;
    void SetInstructionStats(CodeBlock* block, CodeOp* code, const GekkoOPInfo* opinfo) const;

    u32  m_options                       = 0;
    bool m_enable_branch_following       = false;
    bool m_enable_float_exceptions       = false;
    bool m_enable_div_by_zero_exceptions = false;
};

// Helper — extract operand fields from a 32-bit Gekko instruction word.
// Phase 1 keeps the raw-u32 representation used by the existing
// gekko_emit.cpp; later phases can wrap this in a UGeckoInstruction union.
struct GekkoOperands {
    static constexpr u32 OPCD(u32 inst)  { return (inst >> 26) & 0x3F; }
    static constexpr u32 RD(u32 inst)    { return (inst >> 21) & 0x1F; }
    static constexpr u32 RS(u32 inst)    { return (inst >> 21) & 0x1F; }
    static constexpr u32 RA(u32 inst)    { return (inst >> 16) & 0x1F; }
    static constexpr u32 RB(u32 inst)    { return (inst >> 11) & 0x1F; }
    static constexpr u32 RC(u32 inst)    { return (inst >>  6) & 0x1F; }
    static constexpr u32 FD(u32 inst)    { return (inst >> 21) & 0x1F; }
    static constexpr u32 FS(u32 inst)    { return (inst >> 21) & 0x1F; }
    static constexpr u32 FA(u32 inst)    { return (inst >> 16) & 0x1F; }
    static constexpr u32 FB(u32 inst)    { return (inst >> 11) & 0x1F; }
    static constexpr u32 FC(u32 inst)    { return (inst >>  6) & 0x1F; }
    static constexpr u32 SUBOP10(u32 inst) { return (inst >> 1) & 0x3FF; }
    static constexpr u32 SUBOP5(u32 inst)  { return (inst >> 1) & 0x1F; }
    static constexpr u32 SIMM_16(u32 inst) {
        return (u32)(s32)(s16)(inst & 0xFFFF);
    }
    static constexpr u32 UIMM_16(u32 inst) { return inst & 0xFFFF; }
    static constexpr u32 BD(u32 inst)    { return (s32)(s16)(inst & 0xFFFC); }
    static constexpr u32 BO(u32 inst)    { return (inst >> 21) & 0x1F; }
    static constexpr u32 BI(u32 inst)    { return (inst >> 16) & 0x1F; }
    static constexpr u32 LI(u32 inst)    {
        const u32 raw = inst & 0x03FFFFFC;
        return (raw & 0x02000000) ? (raw | 0xFC000000) : raw;
    }
    static constexpr bool LK(u32 inst)   { return (inst & 1) != 0; }
    static constexpr bool AA(u32 inst)   { return (inst & 2) != 0; }
    static constexpr bool Rc(u32 inst)   { return (inst & 1) != 0; }
    static constexpr bool OE(u32 inst)   { return (inst & 0x400) != 0; }
    static constexpr u32 CRFD(u32 inst)  { return (inst >> 23) & 7; }
    static constexpr u32 CRFS(u32 inst)  { return (inst >> 18) & 7; }
    static constexpr u32 CRBD(u32 inst)  { return (inst >> 21) & 0x1F; }
    static constexpr u32 CRBA(u32 inst)  { return (inst >> 16) & 0x1F; }
    static constexpr u32 CRBB(u32 inst)  { return (inst >> 11) & 0x1F; }
};

constexpr u32 BRANCH_FOLLOWING_THRESHOLD = 2;

// IsBlockTerminator — single source of truth for "does this Gekko instruction
// end a basic block?". Used by both PPCAnalyzer::Analyze (per-op canEndBlock
// derivation lives in SetInstructionStats via opinfo->flags & FL_ENDBLOCK,
// this helper is the equivalent for callers that only have a u32 inst word
// and don't materialize a CodeOp) and JitWasm::TryCompileBlock (decode-loop
// terminator check). Routes through lookup_op_info()'s flag table so that
// adding/removing FL_ENDBLOCK on an op in ppc_tables.cpp automatically
// updates BOTH the analyst and the JIT block decoder — no drift.
//
// Matches Dolphin Jit64's InstructionCanEndBlock (PPCAnalyst.cpp:218-223),
// minus the mtspr/MMCR0/MMCR1 special-case (bementalJIT's table entry for
// mtspr does not carry FL_ENDBLOCK, so the special-case is moot here).
bool IsBlockTerminator(u32 inst);

// IsForwardConditionalBranch — true for a coalescable forward conditional bcx
// (OPCD 16, BO!=20, LK==0, AA==0, (s32)BD>0). The JitWasm decode loop and
// PPCAnalyzer::Analyze both use this to KEEP DECODING past such a branch (it
// becomes a mid-block conditional exit; the not-taken fall-through stays in the
// block). Backward/self conditional branches stay terminal so IsBusyWaitLoop
// idle detection (SAB boot-freeze downcount=0 fix) still keys on the last op.
bool IsForwardConditionalBranch(u32 inst, u32 pc);

}  // namespace bemental::powerpc

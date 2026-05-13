//
// PPCAnalyzer::Analyze — port of Dolphin's PPCAnalyst::Analyze for the
// bementalJIT rebuild. Phase 1 ships the decode + reg-flow population
// pass. Reorder passes (branch-merge / carry-merge / CROR-merge) and
// IsBusyWaitLoop are stubbed/skeletal; full ports land in Phase 4 along
// with the per-op file split.
//
// Source reference: gamecube/dolphin-src/Source/Core/Core/PowerPC/PPCAnalyst.cpp
// License of the reference: GPL-2.0-or-later. This port follows the same
// algorithmic shape.

#include "ppc_analyst.h"

#include <cstddef>

#include "bementalJIT/types.h"
#include "code_op.h"
#include "common/op_info.h"

namespace bemental::powerpc {

// EvaluateBranchTarget — return the absolute target PC for any branch
// instruction at `pc`, or INVALID_BRANCH_TARGET if not a branch. The host
// supplies the instruction word indirectly via the inst parameter.
static u32 EvaluateBranchTarget(u32 inst, u32 pc) {
    const u32 opcd = GekkoOperands::OPCD(inst);
    switch (opcd) {
    case 16: {  // bcx — conditional
        u32 target = GekkoOperands::BD(inst);
        if (!GekkoOperands::AA(inst)) target += pc;
        return target;
    }
    case 18: {  // bx — unconditional
        u32 target = GekkoOperands::LI(inst);
        if (!GekkoOperands::AA(inst)) target += pc;
        return target;
    }
    default:
        return INVALID_BRANCH_TARGET;
    }
}

void PPCAnalyzer::SetInstructionStats(CodeBlock* block, CodeOp* code,
                                      const GekkoOPInfo* opinfo) const {
    code->wantsCR.m_val      = 0;
    code->wantsFPRF          = (opinfo->flags & FL_READ_FPRF) != 0;
    code->wantsCA            = (opinfo->flags & FL_READ_CA) != 0;
    code->wantsCAInFlags     = false;  // populated by Phase 4 carry-merge pass.
    code->outputCR.m_val     = 0;
    code->outputFPRF         = (opinfo->flags & FL_SET_FPRF) != 0;
    code->outputCA           = (opinfo->flags & FL_SET_CA) != 0;
    code->canEndBlock        = (opinfo->flags & FL_ENDBLOCK) != 0;
    code->canCauseException  =
        (opinfo->flags & (FL_LOADSTORE | FL_USE_FPU | FL_PROGRAMEXCEPTION |
                          FL_FLOAT_EXCEPTION | FL_FLOAT_DIV)) != 0;

    const u32 inst = code->inst;

    // GPR inputs — driven by FL_IN_A / FL_IN_A0 / FL_IN_B / FL_IN_C / FL_IN_S.
    code->regsIn.m_val = 0;
    if (opinfo->flags & FL_IN_A) {
        code->regsIn[GekkoOperands::RA(inst)] = true;
    }
    if (opinfo->flags & FL_IN_A0) {
        if (GekkoOperands::RA(inst) != 0)
            code->regsIn[GekkoOperands::RA(inst)] = true;
    }
    if (opinfo->flags & FL_IN_B) {
        code->regsIn[GekkoOperands::RB(inst)] = true;
    }
    if (opinfo->flags & FL_IN_C) {
        code->regsIn[GekkoOperands::RC(inst)] = true;
    }
    if (opinfo->flags & FL_IN_S) {
        code->regsIn[GekkoOperands::RS(inst)] = true;
    }

    // GPR outputs.
    code->regsOut.m_val = 0;
    if (opinfo->flags & FL_OUT_D) {
        code->regsOut[GekkoOperands::RD(inst)] = true;
    }
    if (opinfo->flags & FL_OUT_A) {
        code->regsOut[GekkoOperands::RA(inst)] = true;
    }

    // FPR inputs / outputs.
    code->fregsIn.m_val = 0;
    if (opinfo->flags & FL_IN_FLOAT_A) {
        code->fregsIn[GekkoOperands::FA(inst)] = true;
    }
    if (opinfo->flags & FL_IN_FLOAT_B) {
        code->fregsIn[GekkoOperands::FB(inst)] = true;
    }
    if (opinfo->flags & FL_IN_FLOAT_C) {
        code->fregsIn[GekkoOperands::FC(inst)] = true;
    }
    if (opinfo->flags & FL_IN_FLOAT_S) {
        code->fregsIn[GekkoOperands::FS(inst)] = true;
    }
    if (opinfo->flags & FL_IN_FLOAT_D) {
        code->fregsIn[GekkoOperands::FD(inst)] = true;
    }
    code->fregOut = (opinfo->flags & FL_OUT_FLOAT_D)
                        ? (s8)GekkoOperands::FD(inst)
                        : (s8)-1;

    // CR fields — Rc bit on integer ops sets CR0; FL_RC_BIT_F sets CR1.
    // FL_SET_CRn sets the CRFD-named field; FL_SET_ALL_CR sets every CR.
    code->crOut.m_val = 0;
    if ((opinfo->flags & FL_RC_BIT) && GekkoOperands::Rc(inst)) {
        code->crOut[0] = true;
    }
    if ((opinfo->flags & FL_RC_BIT_F) && GekkoOperands::Rc(inst)) {
        code->crOut[1] = true;
    }
    if (opinfo->flags & FL_SET_CR0) code->crOut[0] = true;
    if (opinfo->flags & FL_SET_CR1) code->crOut[1] = true;
    if (opinfo->flags & FL_SET_CRn) code->crOut[GekkoOperands::CRFD(inst)] = true;
    if (opinfo->flags & FL_SET_ALL_CR) {
        code->crOut = BitSet8(0xFF);
    }

    code->crIn.m_val = 0;
    if (opinfo->flags & FL_READ_CRn)  code->crIn[GekkoOperands::CRFS(inst)] = true;
    if (opinfo->flags & FL_READ_CR_BI) code->crIn[GekkoOperands::BI(inst) >> 2] = true;
    if (opinfo->flags & FL_READ_ALL_CR) {
        code->crIn = BitSet8(0xFF);
    }

    // Track GQR usage on paired-singles dispatch. PS ops embed the GQR index
    // in the I field at bits 12..14. Phase 1 doesn't decode this — flagged
    // for Phase 4+.
    (void)block;
}

bool PPCAnalyzer::IsBusyWaitLoop(CodeBlock* block, CodeOp* code,
                                 std::size_t instructions) const {
    // Phase 1 minimal heuristic: a tight loop is one whose terminating
    // branch jumps back to the block start AND every intervening op is
    // side-effect-free (no FL_LOADSTORE / FL_SET_MSR / FL_SET_FPRF / etc.).
    // Phase 4 will port Dolphin's full IsBusyWaitLoop with mtspr/lwz
    // tolerance for ARAM polling.
    if (instructions == 0) return false;
    CodeOp* last = &code[instructions - 1];
    if (last->branchTo != block->m_address) return false;
    for (std::size_t i = 0; i + 1 < instructions; ++i) {
        if (!code[i].opinfo) return false;
        const u64 flags = code[i].opinfo->flags;
        if (flags & (FL_LOADSTORE | FL_SET_MSR | FL_SET_FPRF | FL_USE_FPU))
            return false;
    }
    return true;
}

u32 PPCAnalyzer::Analyze(u32 address, CodeBlock* block, CodeBuffer* buffer,
                         std::size_t block_size, FetchFn fetch,
                         void* fetch_user) const {
    block->m_address          = address;
    block->m_num_instructions = 0;
    block->m_broken           = false;
    block->m_memory_exception = false;
    block->m_gqr_used.m_val   = 0;
    block->m_gqr_modified.m_val = 0;
    block->m_gpr_inputs.m_val = 0;

    if (block->m_stats) block->m_stats->numCycles = 0;
    if (block->m_gpa)   block->m_gpa->any = false;
    if (block->m_fpa)   block->m_fpa->any = false;

    buffer->clear();
    buffer->reserve(block_size);

    BitSet32 defined_so_far;  // GPRs written by the in-progress block.

    u32 pc = address;
    bool reached_endblock = false;

    for (std::size_t i = 0; i < block_size; ++i) {
        const u32 inst = fetch(pc, fetch_user);
        const GekkoOPInfo* opinfo = lookup_op_info(inst, pc);

        CodeOp op{};
        op.inst     = inst;
        op.address  = pc;
        op.opinfo   = opinfo;
        op.branchTo = INVALID_BRANCH_TARGET;
        op.skip     = false;

        if (!opinfo) {
            // Unknown / invalid encoding. End block conservatively.
            buffer->push_back(op);
            ++block->m_num_instructions;
            block->m_broken = true;
            pc += 4;
            reached_endblock = true;
            break;
        }

        SetInstructionStats(block, &op, opinfo);

        // Track block-level live-in: any GPR read before being defined here.
        const BitSet32 read_now = op.regsIn;
        const BitSet32 reads_live_in = BitSet32(read_now.m_val & ~defined_so_far.m_val);
        block->m_gpr_inputs |= reads_live_in;
        defined_so_far |= op.regsOut;

        // Branch target classification.
        op.branchTo = EvaluateBranchTarget(inst, pc);
        const u32 opcd = GekkoOperands::OPCD(inst);
        if (opcd == 19) {
            // Sub-table — bclr/bcctr/rfi all end the block.
            const u32 sub10 = GekkoOperands::SUBOP10(inst);
            if (sub10 == 16 || sub10 == 528 || sub10 == 50) {
                op.canEndBlock = true;
            }
            if (sub10 == 528) op.branchUsesCtr = true;
        }
        if (opcd == 16) op.branchUsesCtr = (GekkoOperands::BO(inst) & 4) == 0;

        if (block->m_stats) block->m_stats->numCycles += opinfo->num_cycles;

        buffer->push_back(op);
        ++block->m_num_instructions;
        pc += 4;

        if (op.canEndBlock) {
            reached_endblock = true;
            break;
        }
    }

    // Reverse scan — populate gprInUse / gprDiscardable.
    BitSet32 live_after;
    BitSet32 fpr_live_after;
    for (std::size_t i = block->m_num_instructions; i-- > 0; ) {
        CodeOp& op = (*buffer)[i];
        op.gprInUse       = live_after;
        op.fprInUse       = fpr_live_after;
        op.gprDiscardable = BitSet32(op.regsOut.m_val & ~live_after.m_val);
        op.fprDiscardable = BitSet32(op.GetFregsOut().m_val & ~fpr_live_after.m_val);
        // Live-after for predecessor = (live_after | reads) & ~writes.
        live_after = BitSet32((live_after.m_val | op.regsIn.m_val) & ~op.regsOut.m_val);
        BitSet32 fregs_out = op.GetFregsOut();
        fpr_live_after = BitSet32((fpr_live_after.m_val | op.fregsIn.m_val) & ~fregs_out.m_val);
    }

    // Idle-loop classification — only valid for a fully-decoded short block
    // whose terminator branches back to start.
    if (reached_endblock && block->m_num_instructions > 0) {
        if (IsBusyWaitLoop(block, buffer->data(), block->m_num_instructions)) {
            (*buffer)[block->m_num_instructions - 1].branchIsIdleLoop = true;
        }
    }

    return pc;
}

}  // namespace bemental::powerpc

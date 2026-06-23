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

#include <bitset>
#include <cstddef>

#include "bementalJIT/types.h"
#include "code_op.h"
#include "common/op_info.h"
#include "ppc_offsets.h"  // SPR_MMCR0 / SPR_MMCR1 for mtspr terminator filter

namespace bemental::powerpc {

// IsMtspr / GetSPRIndex — mirror Dolphin's PPCAnalyst.cpp:207-216 helpers.
// SPR field bit layout: SPRU = inst[16:20], SPRL = inst[11:15], real_spr =
// (SPRU<<5) | SPRL. Bit-identical to jit_system_registers.cpp:34's
// decode_spr_num; kept local so ppc_analyst.cpp stays free of system-
// register internals.
static inline bool IsMtspr(u32 inst) {
    return GekkoOperands::OPCD(inst) == 31 && GekkoOperands::SUBOP10(inst) == 467;
}
static inline u32 GetSPRIndex(u32 inst) {
    const u32 sprl = (inst >> 11) & 0x1F;
    const u32 spru = (inst >> 16) & 0x1F;
    return (spru << 5) | sprl;
}

// IsBlockTerminator — table-driven block-terminator predicate. The lookup
// is keyed on the raw u32 instruction; pc is unused by lookup_op_info for
// classification (it's only consulted for HLE patch resolution, which the
// flag table is not part of), so we pass 0. An unknown encoding (lookup
// returns nullptr) is treated as a terminator — matches the analyst's
// conservative "Unknown / invalid encoding. End block conservatively."
// path in PPCAnalyzer::Analyze.
//
// mtspr-specific filter (per dolphin-src PPCAnalyst.cpp:218-223): mtspr is
// FL_ENDBLOCK in the table to drive cr_in/cr_out flags identically with
// Jit64, but only ACTUALLY terminates a block when target SPR is MMCR0 or
// MMCR1 — those reconfigure the perf-monitor and can change downcount
// accounting. Writes to other SPRs (LR, CTR, SPRG*, GQR*, etc.) are pure
// register updates and must NOT terminate.
bool IsBlockTerminator(u32 inst) {
    const GekkoOPInfo* opinfo = lookup_op_info(inst, /*pc=*/0u);
    if (!opinfo) return true;  // unknown encoding — end block conservatively.
    if ((opinfo->flags & FL_ENDBLOCK) == 0) return false;
    if (!IsMtspr(inst)) return true;
    const u32 spr = GetSPRIndex(inst);
    return spr == ppc_off::SPR_MMCR0 || spr == ppc_off::SPR_MMCR1;
}

// IsForwardConditionalBranch — true for a bcx (OPCD 16) that is coalescable:
// CR/CTR conditional (BO != 20 branch-always), NOT a linked call (LK==0), pc-
// relative (AA==0), and FORWARD ((s32)BD > 0). Forward conditional branches can
// be emitted as a mid-block conditional EXIT so the not-taken fall-through stays
// in the same block (native Jit64 coalescing). BACKWARD/self branches (BD<=0)
// are deliberately EXCLUDED so they stay block terminators — IsBusyWaitLoop
// idle detection (and the SAB boot-freeze downcount=0 fix) requires the idle
// branch to be the block's last op. AA==1 (absolute target, undefined fwd/back)
// and LK conditional calls also stay terminal. The pc arg is unused (BD is
// already pc-relative and sign-extended) but kept for call-site symmetry.
bool IsForwardConditionalBranch(u32 inst, u32 /*pc*/) {
    if (GekkoOperands::OPCD(inst) != 16u) return false;
    if (GekkoOperands::BO(inst) == 20u)   return false;  // branch-always
    if (GekkoOperands::LK(inst))          return false;  // conditional call
    if (GekkoOperands::AA(inst))          return false;  // absolute target
    return (s32)GekkoOperands::BD(inst) > 0;             // forward only
}

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

    // lmw rT,d(rA): writes r{rT..31}. stmw rS,d(rA): reads r{rS..31}.
    // The opinfo flag set cannot express the range, so we special-case
    // here so block-level live-in propagation, RegCache::OnBlockEntry, and
    // EmitPrologueLoads see these registers as touched. Without this, the
    // SAB SIGetType (0x800eb45c) epilogue's `lmw r27,20(r1)` restores
    // r27..r31 in PowerPCState via the interp fallback, but successor
    // blocks see m_gpr_inputs[27..31]=false → RegCache::Bind() fabricates
    // a u32{0} value → block-exit Flush corrupts the restored memory →
    // SIGetTypeAsync's trampoline at 0x800eb71c loads r31=0 → blrl→PC=0.
    {
        const u32 opcd_lmw = GekkoOperands::OPCD(inst);
        if (opcd_lmw == 46u) {                       // lmw
            const u32 rT = GekkoOperands::RD(inst);
            for (u32 r = rT; r < 32u; ++r) code->regsOut[r] = true;
        } else if (opcd_lmw == 47u) {                // stmw
            const u32 rS = GekkoOperands::RS(inst);
            for (u32 r = rS; r < 32u; ++r) code->regsIn[r] = true;
        }
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
    // Canonical Dolphin Jit64 port (Source/Core/Core/PowerPC/PPCAnalyst.cpp:737):
    //   * Loops to itself, no other branches.
    //   * No stores (memory writes break idle-spin assumption).
    //   * Reads only from registers either written earlier in the loop, or
    //     never written in the loop. If a register is read BEFORE being
    //     written in the loop, it's "externally driven" — and later writes
    //     to it would break the externally-driven assumption.
    //
    // The previous heuristic (Phase 1 minimal) rejected ALL FL_LOADSTORE ops.
    // That excluded the canonical OS idle pattern `lwz; cmp; beq self` —
    // which is exactly what MP4/SAB SelectThread+0x138 (poll RunQueueBits)
    // and __OSReschedule loops look like. Without idle-skip, SelectThread
    // dispatched 358 wasm blocks per CoreTiming slice instead of 1 — losing
    // ~358× throughput. Fix: port the upstream Load-aware dataflow check.
    if (instructions == 0) return false;
    std::bitset<32> write_disallowed_regs;
    std::bitset<32> written_regs;
    // bementalJIT's caller passes m_num_instructions (count), not the branch
    // index (upstream's convention). The branch is at index instructions-1.
    for (std::size_t i = 0; i < instructions; ++i) {
        if (!code[i].opinfo) return false;
        const OpType type = code[i].opinfo->type;
        if (type == OpType::Branch) {
            if (code[i].branchUsesCtr) return false;
            if (code[i].branchTo == block->m_address && i + 1 == instructions)
                return true;
        } else if (type != OpType::Integer && type != OpType::Load) {
            // Reject Store, SystemFP, DataCache, etc. Only Integer + Load
            // (and the terminating Branch) are allowed in a busy-wait.
            return false;
        } else {
            for (int reg : code[i].regsIn) {
                if (reg < 0) continue;
                if (written_regs[reg]) continue;
                write_disallowed_regs[reg] = true;
            }
            for (int reg : code[i].regsOut) {
                if (reg < 0) continue;
                if (write_disallowed_regs[reg]) return false;
                written_regs[reg] = true;
            }
        }
    }
    return false;
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
    block->m_fpr_inputs.m_val = 0;

    if (block->m_stats) block->m_stats->numCycles = 0;
    if (block->m_gpa)   block->m_gpa->any = false;
    if (block->m_fpa)   block->m_fpa->any = false;

    buffer->clear();
    buffer->reserve(block_size);

    BitSet32 defined_so_far;  // GPRs written by the in-progress block.
    BitSet32 fpr_defined_so_far;  // FPRs written by the in-progress block.

    // Forward const-propagation tracker. `gpr_known[i]` is true when
    // analyzer has proved gpr[i] holds the value `gpr_const[i]` at this
    // point in the linear decode. Mirrors gpr.IsImm()/Imm32() in Dolphin
    // Jit64 (RegCache::SetImmediate32 / IsImm). Used to populate
    // CodeOp::has_const_ea on D-form loads/stores so jit_load_store.cpp
    // can route compile-time-known MMIO stores directly to the host
    // import (preserving DICR.TSTART/DICMDBUF write ordering).
    bool gpr_known[32] = {};
    u32  gpr_const[32] = {};

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

        // Same shape for FPRs — block's live-in FPR set drives
        // FPRRegCache::EmitPrologueLoads. Mirrors the GPR forward-scan
        // pattern exactly so analyzer-blind opcodes behave identically.
        // Both lanes (ps0+ps1) are always loaded for any preg in this set;
        // lazy-load fallback at Bind() time handles opcodes whose opinfo
        // flags don't reflect their actual FPR reads (mirror of the
        // lmw/stmw analyzer-blind class for FPRs).
        const BitSet32 fpr_reads_now = op.fregsIn;
        const BitSet32 fpr_reads_live_in =
            BitSet32(fpr_reads_now.m_val & ~fpr_defined_so_far.m_val);
        block->m_fpr_inputs |= fpr_reads_live_in;
        fpr_defined_so_far |= op.GetFregsOut();

        // ------------------------------------------------------------------
        // Const-EA derivation for D-form loads/stores (op.has_const_ea).
        // Must run BEFORE we update gpr_known with this op's own output —
        // EA uses the RA value as it stood prior to this instruction.
        // OPCDs 32..47 = lwz/lwzu/lbz/lbzu/stw/stwu/stb/stbu/lhz/lhzu/lha/
        //               lhau/sth/sthu/lmw/stmw. OPCDs 48..55 = lfs/lfsu/lfd/
        // lfdu/stfs/stfsu/stfd/stfdu. All D-form, EA = (RA==0?0:rA) + SIMM.
        {
            const u32 opcd_ea = GekkoOperands::OPCD(inst);
            const bool is_dform_mem =
                (opcd_ea >= 32 && opcd_ea <= 47) ||
                (opcd_ea >= 48 && opcd_ea <= 55);
            if (is_dform_mem) {
                const u32 ra_ea = GekkoOperands::RA(inst);
                const u32 simm_ea = GekkoOperands::SIMM_16(inst);
                if (ra_ea == 0) {
                    op.has_const_ea = true;
                    op.const_ea = simm_ea;
                } else if (gpr_known[ra_ea]) {
                    op.has_const_ea = true;
                    op.const_ea = gpr_const[ra_ea] + simm_ea;
                }
            }
        }

        // ------------------------------------------------------------------
        // Forward const-propagation. Update gpr_known[] for THIS op's
        // output. Tracked productions:
        //   OPCD 14 addi  : rt = (ra==0 ? 0 : rA) + simm
        //   OPCD 15 addis : rt = (ra==0 ? 0 : rA) + (uimm<<16)
        //   OPCD 24 ori   : rA = rS | uimm
        //   OPCD 25 oris  : rA = rS | (uimm<<16)
        //   OPCD 26 xori  : rA = rS ^ uimm
        //   OPCD 27 xoris : rA = rS ^ (uimm<<16)
        // Everything else that writes a GPR INVALIDATES the known-const
        // entry. We must consult RA *before* updating to avoid self-aliasing.
        {
            const u32 opcd_p = GekkoOperands::OPCD(inst);
            bool produced = false;
            u32  produced_reg = 0;
            u32  produced_val = 0;
            switch (opcd_p) {
            case 14: {  // addi
                const u32 rt = GekkoOperands::RD(inst);
                const u32 ra = GekkoOperands::RA(inst);
                const u32 simm = GekkoOperands::SIMM_16(inst);
                if (ra == 0) {
                    produced = true;
                    produced_reg = rt;
                    produced_val = simm;
                } else if (gpr_known[ra]) {
                    produced = true;
                    produced_reg = rt;
                    produced_val = gpr_const[ra] + simm;
                }
                break;
            }
            case 15: {  // addis
                const u32 rt = GekkoOperands::RD(inst);
                const u32 ra = GekkoOperands::RA(inst);
                const u32 uimm_hi = GekkoOperands::UIMM_16(inst) << 16;
                if (ra == 0) {
                    produced = true;
                    produced_reg = rt;
                    produced_val = uimm_hi;
                } else if (gpr_known[ra]) {
                    produced = true;
                    produced_reg = rt;
                    produced_val = gpr_const[ra] + uimm_hi;
                }
                break;
            }
            case 24: {  // ori
                const u32 ra_dst = GekkoOperands::RA(inst);
                const u32 rs = GekkoOperands::RS(inst);
                const u32 uimm = GekkoOperands::UIMM_16(inst);
                if (gpr_known[rs]) {
                    produced = true;
                    produced_reg = ra_dst;
                    produced_val = gpr_const[rs] | uimm;
                }
                break;
            }
            case 25: {  // oris
                const u32 ra_dst = GekkoOperands::RA(inst);
                const u32 rs = GekkoOperands::RS(inst);
                const u32 uimm_hi = GekkoOperands::UIMM_16(inst) << 16;
                if (gpr_known[rs]) {
                    produced = true;
                    produced_reg = ra_dst;
                    produced_val = gpr_const[rs] | uimm_hi;
                }
                break;
            }
            case 26: {  // xori
                const u32 ra_dst = GekkoOperands::RA(inst);
                const u32 rs = GekkoOperands::RS(inst);
                const u32 uimm = GekkoOperands::UIMM_16(inst);
                if (gpr_known[rs]) {
                    produced = true;
                    produced_reg = ra_dst;
                    produced_val = gpr_const[rs] ^ uimm;
                }
                break;
            }
            case 27: {  // xoris
                const u32 ra_dst = GekkoOperands::RA(inst);
                const u32 rs = GekkoOperands::RS(inst);
                const u32 uimm_hi = GekkoOperands::UIMM_16(inst) << 16;
                if (gpr_known[rs]) {
                    produced = true;
                    produced_reg = ra_dst;
                    produced_val = gpr_const[rs] ^ uimm_hi;
                }
                break;
            }
            default:
                break;
            }

            // Invalidate every GPR this op writes that we DIDN'T just
            // record a fresh constant for.
            for (u32 r = 0; r < 32; ++r) {
                if (!op.regsOut[r]) continue;
                if (produced && r == produced_reg) continue;
                gpr_known[r] = false;
            }
            if (produced) {
                gpr_known[produced_reg] = true;
                gpr_const[produced_reg] = produced_val;
                op.has_const_result = true;
                op.const_result     = produced_val;
            }
        }

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
            // [coalesce] A FORWARD conditional branch does not end the block —
            // it is emitted as a mid-block conditional exit and the not-taken
            // fall-through continues here. reached_endblock stays false so the
            // idle-loop classification below keys on the TRUE terminator. Must
            // mirror the JitWasm.cpp decode loop's identical predicate so this
            // analyst length matches the decoded inst count.
            if (!IsForwardConditionalBranch(op.inst, op.address)) {
                reached_endblock = true;
                break;
            }
        }
    }

    // Reverse scan — populate gprInUse / gprDiscardable + crInUse /
    // crDiscardable + ca_discardable. Per structural audit wp7gh3uoi
    // cr-xer-fpscr finding #2: dead-CR elision saves ~24 wasm ops per Rc=1
    // op whose CR0 is overwritten or never branched on before block end.
    BitSet32 live_after;
    BitSet32 fpr_live_after;
    // CR / CA conservatively live at block end (next block may read them).
    BitSet8  cr_live_after(0xFF);
    bool     ca_live_after = true;
    for (std::size_t i = block->m_num_instructions; i-- > 0; ) {
        CodeOp& op = (*buffer)[i];
        op.gprInUse       = live_after;
        op.fprInUse       = fpr_live_after;
        op.gprDiscardable = BitSet32(op.regsOut.m_val & ~live_after.m_val);
        op.fprDiscardable = BitSet32(op.GetFregsOut().m_val & ~fpr_live_after.m_val);
        op.crInUse        = cr_live_after;
        op.crDiscardable  = BitSet8(op.crOut.m_val & ~cr_live_after.m_val);
        op.ca_discardable = op.outputCA && !ca_live_after;
        // Live-after for predecessor = (live_after | reads) & ~writes.
        live_after = BitSet32((live_after.m_val | op.regsIn.m_val) & ~op.regsOut.m_val);
        BitSet32 fregs_out = op.GetFregsOut();
        fpr_live_after = BitSet32((fpr_live_after.m_val | op.fregsIn.m_val) & ~fregs_out.m_val);
        cr_live_after = BitSet8((cr_live_after.m_val | op.crIn.m_val) & ~op.crOut.m_val);
        ca_live_after = (ca_live_after && !op.outputCA) || op.wantsCA;
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

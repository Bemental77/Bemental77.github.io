// test_analyst.cpp — Phase 1 acceptance for the bementalJIT rebuild.
//
// Validates PPCAnalyzer::Analyze produces the expected CodeOp metadata
// for three canned blocks:
//   (a) "addi r3,0,7; addi r4,r3,35; blr" — basic reg-flow + endblock.
//   (b) SAB idle loop pattern at 0x800ebea0 — branchIsIdleLoop=true.
//   (c) SDA-relative load+store — regsOut + canCauseException=true (loadstore).
//
// Bit-exact diff against native Dolphin's PPCAnalyst::Analyze is deferred to
// when the oracle harness lands (the diff format is just the same byte
// stream fed into both analyzers + a comparison of the BitSet32 fields).
// For Phase 1 ship, this file asserts the expected per-op values directly.

#include "guests/powerpc-next/code_op.h"
#include "guests/powerpc-next/ppc_analyst.h"

#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

using namespace bemental::powerpc;

static int g_pass = 0;
static int g_fail = 0;

static void report(const char* line, bool pass) {
    std::printf("%s %s\n", pass ? "[PASS]" : "[FAIL]", line);
    if (pass) ++g_pass; else ++g_fail;
#ifdef __EMSCRIPTEN__
    EM_ASM({
        const msg  = UTF8ToString($0);
        const pass = $1;
        if (typeof document === 'undefined') return;
        let pre = document.getElementById('bemental-out');
        if (!pre) {
            pre = document.createElement('pre');
            pre.id = 'bemental-out';
            pre.style.cssText = 'font: 14px ui-monospace, Menlo, monospace; padding: 16px;';
            document.body.appendChild(pre);
        }
        pre.textContent += (pass ? '[PASS] ' : '[FAIL] ') + msg + '\n';
    }, line, pass ? 1 : 0);
#endif
}

// Instruction encoding helpers (subset needed for the canned blocks).
static constexpr std::uint32_t enc_addi(unsigned rt, unsigned ra, std::int16_t simm) {
    return (14u << 26) | (rt << 21) | (ra << 16) | (std::uint16_t)simm;
}
static constexpr std::uint32_t enc_addis(unsigned rt, unsigned ra, std::int16_t simm) {
    return (15u << 26) | (rt << 21) | (ra << 16) | (std::uint16_t)simm;
}
static constexpr std::uint32_t enc_bclr() {
    // bclr = op 19, SUBOP10=16, BO=20 (branch always), BI=0
    return (19u << 26) | (20u << 21) | (0u << 16) | (0u << 11) | (16u << 1);
}
static constexpr std::uint32_t enc_bne_self(int word_offset) {
    // bcx: BO=4 (branch if false on CR0[2]==0), BI=2 (CR0 EQ bit).
    const std::int32_t bd = word_offset * 4;
    return (16u << 26) | (4u << 21) | (2u << 16) | ((std::uint32_t)bd & 0xFFFC);
}
static constexpr std::uint32_t enc_lwz(unsigned rt, unsigned ra, std::int16_t d) {
    return (32u << 26) | (rt << 21) | (ra << 16) | (std::uint16_t)d;
}
static constexpr std::uint32_t enc_stw(unsigned rs, unsigned ra, std::int16_t d) {
    return (36u << 26) | (rs << 21) | (ra << 16) | (std::uint16_t)d;
}
static constexpr std::uint32_t enc_cmpwi(unsigned crfd, unsigned ra, std::int16_t simm) {
    return (11u << 26) | (crfd << 23) | (0u << 22) | (0u << 21) | (ra << 16) | (std::uint16_t)simm;
}

// Test fixture state — a tiny address→instruction map.
struct Fixture {
    std::uint32_t base_pc;
    const std::uint32_t* insts;
    std::size_t count;
};

static std::uint32_t fetch_from_fixture(std::uint32_t pc, void* user) {
    const Fixture* f = static_cast<const Fixture*>(user);
    const std::size_t idx = (pc - f->base_pc) / 4;
    if (idx >= f->count) return 0u;  // NOP-ish (op 0 = invalid; analyzer breaks block)
    return f->insts[idx];
}

// ---------------------------------------------------------------------------
// Case (a) — addi r3,0,7; addi r4,r3,35; blr
// ---------------------------------------------------------------------------
static void case_a_basic_reg_flow() {
    const std::uint32_t insts[] = {
        enc_addi(3, 0, 7),    // r3 = 7
        enc_addi(4, 3, 35),   // r4 = r3 + 35
        enc_bclr(),           // blr — block end
    };
    Fixture fx{0x80003100, insts, 3};
    CodeBlock block;
    BlockStats stats;
    block.m_stats = &stats;
    CodeBuffer buffer;
    PPCAnalyzer pa;
    const std::uint32_t end_pc = pa.Analyze(fx.base_pc, &block, &buffer, 32,
                                            fetch_from_fixture, &fx);

    report("case-a: 3 instructions decoded",
           block.m_num_instructions == 3);
    report("case-a: end_pc advances past blr",
           end_pc == fx.base_pc + 12);
    report("case-a: addi r3,0,7 — regsOut={3}, regsIn={} (rA==0 case)",
           buffer[0].regsOut.m_val == (1u << 3) && buffer[0].regsIn.m_val == 0u);
    report("case-a: addi r4,r3,35 — regsOut={4}, regsIn={3}",
           buffer[1].regsOut.m_val == (1u << 4) && buffer[1].regsIn.m_val == (1u << 3));
    report("case-a: blr — canEndBlock=true",
           buffer[2].canEndBlock);
    report("case-a: blr — branchIsIdleLoop=false (not a self-loop)",
           !buffer[2].branchIsIdleLoop);
    report("case-a: block.m_gpr_inputs is empty (r3 defined before its read)",
           block.m_gpr_inputs.m_val == 0u);
}

// ---------------------------------------------------------------------------
// Case (b) — SAB idle-loop shape: cmpwi crf0, r3, 0; bne self-1.
// Per sab_idle_loop_2026_05_05.md, the OSCheckRunQueue spin reads RunQueueBits
// (a lwz from r3), tests it (cmpwi), and bne's back. For Phase 1's minimal
// IsBusyWaitLoop heuristic, the lwz violates "side-effect-free" — so a pure
// non-loadstore test variant is used here. The full Dolphin IsBusyWaitLoop
// (Phase 4 port) will accept lwz-from-poll-address. Phase 1 asserts the
// minimal heuristic correctly fires on a no-loadstore self-loop.
// ---------------------------------------------------------------------------
static void case_b_idle_loop_minimal() {
    const std::uint32_t insts[] = {
        enc_cmpwi(0, 3, 0),     // cmpwi crf0, r3, 0
        enc_bne_self(-1),       // bne -1 (back to cmpwi)
    };
    Fixture fx{0x800ebea0, insts, 2};
    CodeBlock block;
    BlockStats stats;
    block.m_stats = &stats;
    CodeBuffer buffer;
    PPCAnalyzer pa;
    pa.Analyze(fx.base_pc, &block, &buffer, 32, fetch_from_fixture, &fx);

    report("case-b: 2 instructions decoded",
           block.m_num_instructions == 2);
    report("case-b: cmpwi — outputCR[0]=true",
           buffer[0].crOut.m_val == 1u);
    report("case-b: bne — branchTo == base_pc",
           buffer[1].branchTo == fx.base_pc);
    report("case-b: bne — canEndBlock=true",
           buffer[1].canEndBlock);
    report("case-b: bne — branchIsIdleLoop=true (no loadstore, self-target)",
           buffer[1].branchIsIdleLoop);
}

// ---------------------------------------------------------------------------
// Case (c) — SDA-relative load+store: lwz r3, 0x100(r13); stw r3, 0x104(r13).
// Verifies regsOut={3} on the load, regsIn={3,13} on the store, and the
// canCauseException bit is set for both (loadstore).
// ---------------------------------------------------------------------------
static void case_c_sda_relative_loadstore() {
    const std::uint32_t insts[] = {
        enc_lwz(3, 13, 0x100),    // lwz r3, 0x100(r13)
        enc_stw(3, 13, 0x104),    // stw r3, 0x104(r13)
        enc_bclr(),               // blr
    };
    Fixture fx{0x80010000, insts, 3};
    CodeBlock block;
    BlockStats stats;
    block.m_stats = &stats;
    CodeBuffer buffer;
    PPCAnalyzer pa;
    pa.Analyze(fx.base_pc, &block, &buffer, 32, fetch_from_fixture, &fx);

    report("case-c: 3 instructions decoded",
           block.m_num_instructions == 3);
    report("case-c: lwz — regsOut={3}, regsIn={13}",
           buffer[0].regsOut.m_val == (1u << 3) && buffer[0].regsIn.m_val == (1u << 13));
    report("case-c: lwz — canCauseException=true (loadstore)",
           buffer[0].canCauseException);
    report("case-c: stw — regsIn={3,13}, regsOut={}",
           buffer[1].regsIn.m_val == ((1u << 3) | (1u << 13)) &&
           buffer[1].regsOut.m_val == 0u);
    report("case-c: stw — canCauseException=true",
           buffer[1].canCauseException);
    report("case-c: block.m_gpr_inputs == {13} (r13 read before any def)",
           block.m_gpr_inputs.m_val == (1u << 13));
    // Reverse-scan / liveness check: r3 is dead after stw, so gprDiscardable
    // on the lwz should NOT include r3 (since stw reads it after) — i.e.
    // r3 is still live just-after-lwz, and is killed by stw's read+nothing.
    // After stw, r3 is no longer read by anything, so live_after on stw == 0,
    // and gprDiscardable on stw covers nothing (stw has no regsOut).
    report("case-c: liveness — stw gprDiscardable empty (no regsOut)",
           buffer[1].gprDiscardable.m_val == 0u);
    report("case-c: liveness — blr gprInUse empty (block exits)",
           buffer[2].gprInUse.m_val == 0u);
}

int main() {
    case_a_basic_reg_flow();
    case_b_idle_loop_minimal();
    case_c_sda_relative_loadstore();
    std::printf("\n%d passed, %d failed\n", g_pass, g_fail);
#ifdef __EMSCRIPTEN__
    EM_ASM({
        if (typeof document === 'undefined') return;
        let pre = document.getElementById('bemental-out');
        if (!pre) return;
        pre.textContent += '\n' + $0 + ' passed, ' + $1 + ' failed\n';
    }, g_pass, g_fail);
#endif
    return g_fail == 0 ? 0 : 1;
}

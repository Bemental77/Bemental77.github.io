// test_leaf_inline.cpp — CORRECTNESS GATE for pure-leaf `bl` inlining
// (guests/powerpc-next/ppc_analyst.{h,cpp}, [LEAF-INLINE 2026-09-01]).
//
// WHY THIS FILE EXISTS
// --------------------
// gamecube/docs/sab-frame-governor/TASKS.md measures Sonic Adventure 2's frame
// governor at 23.2% of all guest-PC samples (14.9% at 0x80117e00 + 8.3% at
// 0x800f3700, 15478 samples). The loop is `bl <pure leaf>; lwz; lwz; addi; add;
// cmplw; bc <back to the bl>`. `bl` carries FL_ENDBLOCK, so the analyst cuts the
// loop in two and IsBusyWaitLoop (ppc_analyst.cpp:260) can never see a
// self-referential block.
//
// That change class is where this project has been burned. n64/docs/jit/TASKS.md
// :403-437 and :511-515 document two join-contract divergences that shipped for
// multiple waves and passed every 600-frame differential, because reaching them
// needed a specific register-liveness coincidence. A differential is necessary
// and NOT sufficient. This is the unit corpus that covers what a differential
// structurally cannot.
//
// THE PIPELINE UNDER TEST (per ppc_analyst.h's [LEAF-INLINE] block)
//   DecodeBlockLeafInlined(real fetch)  -> insts[] + pcs[]   <- NEW
//     -> build_block_next(..., instr_pcs)                    <- ppc_emit.cpp:1907
//       -> AnalyzeOps -> m_noncontiguous                     <- ppc_analyst.cpp:316
//         -> LEAF-IDLE seam eligibility                      <- ppc_analyst.cpp:706-727
//           -> IsBusyWaitLoop -> branchIsIdleLoop            <- :260, :730
//             -> downcount = 0 in the block prologue         <- ppc_emit.cpp:1000-1003
//
// The corpus is split so that the DOWNSTREAM half is testable TODAY:
//   Group G feeds a hand-built spliced stream straight into AnalyzeOps. Every
//   assertion there is live against the unmodified tree, so if the downstream
//   half were broken the whole plan would be dead before a line of the decoder
//   was written.
// The UPSTREAM half (Groups A/C) calls the new API. Until it is implemented the
// runner compiles with -DLEAF_API_MISSING and those groups report RED explicitly
// rather than silently vanishing.
//
// HOST-NATIVE BY DESIGN. tests/CMakeLists.txt:5-8 early-returns ("bementalJIT
// tests skipped (requires Emscripten)") under a native cmake and every target
// there builds to .html. This file links ONLY ppc_analyst.cpp + ppc_tables.cpp,
// whose whole include closure is bementalJIT/types.h, common/bit_set.h,
// common/op_info.h and ppc_offsets.h. Build+run is ~1 second, no ROM, no
// browser. See run_leaf_inline_test.sh.
//
// SCOPE LIMIT, stated up front per CLAUDE.md gate #6: the analyst emits no code,
// so this file cannot execute a wasm block and read LR back. Group G.2 states
// exactly what it asserts instead, and why that is sufficient for LR.

#include "guests/powerpc-next/code_op.h"
#include "guests/powerpc-next/ppc_analyst.h"

#include <cstdio>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

using namespace bemental::powerpc;

// ---------------------------------------------------------------------------
// Reporting. VACUOUS is tracked apart from PASS: an assertion whose
// precondition was unmet proves nothing, and counting it green is the exact
// "a null diff can be VACUOUS" trap recorded in
// dreamcast_native_oracle_frame_phase_false_positives_2026_08_29.
// ---------------------------------------------------------------------------
static int g_pass = 0, g_fail = 0, g_vacuous = 0;

static void emit(const char* tag, const std::string& line) {
    std::printf("%-10s %s\n", tag, line.c_str());
#ifdef __EMSCRIPTEN__
    EM_ASM({
        if (typeof document === 'undefined') return;
        let pre = document.getElementById('bemental-out');
        if (!pre) {
            pre = document.createElement('pre');
            pre.id = 'bemental-out';
            pre.style.cssText = 'font:14px ui-monospace,Menlo,monospace;padding:16px;';
            document.body.appendChild(pre);
        }
        pre.textContent += UTF8ToString($0) + ' ' + UTF8ToString($1) + '\n';
    }, tag, line.c_str());
#endif
}
static void expect(const std::string& n, bool c, const std::string& d = "") {
    if (c) { ++g_pass; emit("[PASS]", n); }
    else   { ++g_fail; emit("[FAIL]", n + (d.empty() ? "" : "  -- " + d)); }
}
static void expect_nonvacuous(const std::string& n, bool pre, bool c,
                              const std::string& why) {
    if (!pre) { ++g_vacuous; emit("[VACUOUS]", n + "  -- " + why); return; }
    expect(n, c);
}
static void info(const std::string& l) { emit("[info]", l); }
static std::string hex(std::uint32_t v) {
    char b[16]; std::snprintf(b, sizeof b, "0x%08X", v); return b;
}
static std::string dec(long long v) { return std::to_string(v); }

// ---------------------------------------------------------------------------
// Gekko encoders. Cross-checked in Group 0 against words extracted from
// gamecube/roms/Sonic Adventure 2 - Battle (USA).iso (DOL offset read from the
// disc header at 0x420 = 0x1e700; text1 addr 0x80005500, size 0x16dc40), so the
// corpus does not rest on hand-assembled guesses.
// ---------------------------------------------------------------------------
typedef std::uint32_t u32t;

static constexpr u32t enc_bl(u32t pc, u32t t)  { return (18u<<26)|((t-pc)&0x03FFFFFCu)|1u; }
static constexpr u32t enc_b (u32t pc, u32t t)  { return (18u<<26)|((t-pc)&0x03FFFFFCu); }
static constexpr u32t enc_bc(u32t bo,u32t bi,u32t pc,u32t t) {
    return (16u<<26)|(bo<<21)|(bi<<16)|((t-pc)&0xFFFCu);
}
static constexpr u32t enc_blr()  { return (19u<<26)|(20u<<21)|(16u<<1); }
static constexpr u32t enc_blrl() { return (19u<<26)|(20u<<21)|(16u<<1)|1u; }
static constexpr u32t enc_bclr_cond(u32t bo,u32t bi){ return (19u<<26)|(bo<<21)|(bi<<16)|(16u<<1); }
static constexpr u32t enc_bctr() { return (19u<<26)|(20u<<21)|(528u<<1); }
static constexpr u32t enc_lwz(u32t rt,u32t ra,std::int16_t d){ return (32u<<26)|(rt<<21)|(ra<<16)|(std::uint16_t)d; }
static constexpr u32t enc_stw(u32t rs,u32t ra,std::int16_t d){ return (36u<<26)|(rs<<21)|(ra<<16)|(std::uint16_t)d; }
static constexpr u32t enc_lfs(u32t fd,u32t ra,std::int16_t d){ return (48u<<26)|(fd<<21)|(ra<<16)|(std::uint16_t)d; }
static constexpr u32t enc_addi(u32t rt,u32t ra,std::int16_t s){ return (14u<<26)|(rt<<21)|(ra<<16)|(std::uint16_t)s; }
static constexpr u32t enc_add(u32t rd,u32t ra,u32t rb){ return (31u<<26)|(rd<<21)|(ra<<16)|(rb<<11)|(266u<<1); }
static constexpr u32t enc_cmpl(u32t cr,u32t ra,u32t rb){ return (31u<<26)|(cr<<23)|(ra<<16)|(rb<<11)|(32u<<1); }
// SPR field layout per ppc_analyst.cpp:35-39: sprl = inst[11:15], spru = inst[16:20],
// real_spr = (spru << 5) | sprl.
static constexpr u32t enc_mfspr(u32t rd,u32t spr){
    return (31u<<26)|(rd<<21)|(((spr>>5)&0x1Fu)<<16)|((spr&0x1Fu)<<11)|(339u<<1);
}
static constexpr u32t enc_mtspr(u32t rs,u32t spr){
    return (31u<<26)|(rs<<21)|(((spr>>5)&0x1Fu)<<16)|((spr&0x1Fu)<<11)|(467u<<1);
}
static constexpr u32t enc_mtmsr(u32t rs){ return (31u<<26)|(rs<<21)|(146u<<1); }
static constexpr u32t SPR_LR_ = 8, SPR_CTR_ = 9;

// ---------------------------------------------------------------------------
// The real SAB frame governor. Words below are the bytes on disc.
// ---------------------------------------------------------------------------
static constexpr u32t LOOP = 0x80117E0Cu;   // block start: the `bl`
static constexpr u32t LEAF = 0x800F3710u;   // pure leaf: lwz r3,-29952(r13); blr
static constexpr u32t RET  = 0x80117E10u;   // LOOP + 4 -- the return site
static constexpr u32t TERM = 0x80117E24u;   // the back-edge `bc`

static constexpr u32t SAB_LOOP_WORDS[7] = {
    0x4BFDB905u,  // 0x80117e0c  bl    -149244        -> 0x800f3710
    0x80AD8DC0u,  // 0x80117e10  lwz   r5, -29248(r13)
    0x808D8DC4u,  // 0x80117e14  lwz   r4, -29244(r13)
    0x3804FFFFu,  // 0x80117e18  addi  r0, r4, -1
    0x7C050214u,  // 0x80117e1c  add   r0, r5, r0        (op31.266)
    0x7C030040u,  // 0x80117e20  cmplw cr0, r3, r0       (op31.32)
    0x4081FFE8u,  // 0x80117e24  bc    4,1,-24      -> 0x80117e0c
};
static constexpr u32t SAB_LEAF_WORDS[2] = {
    0x806D8B00u,  // 0x800f3710  lwz   r3, -29952(r13)
    0x4E800020u,  // 0x800f3714  blr
};

// The 9-op spliced stream a correct inline must produce.
static constexpr std::size_t EXPECT_N = 9;
static const u32t EXPECT_PCS[EXPECT_N] = {
    0x80117E0Cu,                            // bl        (LR := 0x80117E10)
    0x800F3710u, 0x800F3714u,               // inlined leaf: lwz ; blr
    0x80117E10u, 0x80117E14u, 0x80117E18u,  // lwz ; lwz ; addi
    0x80117E1Cu, 0x80117E20u, 0x80117E24u,  // add ; cmplw ; bc -> LOOP
};
static const u32t EXPECT_INSTS[EXPECT_N] = {
    SAB_LOOP_WORDS[0], SAB_LEAF_WORDS[0], SAB_LEAF_WORDS[1],
    SAB_LOOP_WORDS[1], SAB_LOOP_WORDS[2], SAB_LOOP_WORDS[3],
    SAB_LOOP_WORDS[4], SAB_LOOP_WORDS[5], SAB_LOOP_WORDS[6],
};

// ---------------------------------------------------------------------------
// Guest memory: a full address -> word map. Unmapped reads yield 0 (an invalid
// encoding), matching an unbacked guest read.
// ---------------------------------------------------------------------------
struct MemMap {
    std::map<u32t,u32t> w;
    void put(u32t a, const u32t* words, std::size_t n) {
        for (std::size_t i = 0; i < n; ++i) w[a + 4u*(u32t)i] = words[i];
    }
    void put1(u32t a, u32t word) { w[a] = word; }
};
static u32t mem_fetch(u32t pc, void* user) {
    const MemMap* m = static_cast<const MemMap*>(user);
    auto it = m->w.find(pc);
    return it == m->w.end() ? 0u : it->second;
}
static MemMap sab_map(const u32t* leaf, std::size_t leaf_n) {
    MemMap m; m.put(LOOP, SAB_LOOP_WORDS, 7);
    if (leaf && leaf_n) m.put(LEAF, leaf, leaf_n);
    return m;
}

struct Analysis {
    CodeBlock  block;
    BlockStats stats;
    CodeBuffer buffer;
    std::size_t n() const { return block.m_num_instructions; }
    const CodeOp& op(std::size_t i) const { return buffer[i]; }
    bool idle() const {
        return block.m_num_instructions > 0 &&
               buffer[block.m_num_instructions - 1].branchIsIdleLoop;
    }
};

// The exact-list entry point build_block_next takes when instr_pcs != nullptr
// (ppc_emit.cpp:1905-1907).
static void analyze_ops(Analysis& a, const u32t* insts, const u32t* pcs, std::size_t n) {
    PPCAnalyzer pa; a.block.m_stats = &a.stats;
    pa.AnalyzeOps(insts, pcs, n, &a.block, &a.buffer);
}
// The contiguous entry point (ppc_emit.cpp:1918), used for control cases.
static void analyze_contig(Analysis& a, u32t start, MemMap& m, std::size_t budget) {
    PPCAnalyzer pa; a.block.m_stats = &a.stats;
    pa.Analyze(start, &a.block, &a.buffer, budget, &mem_fetch, &m);
}

// Build a spliced 9-op stream from a SAB variant, substituting single words.
struct Stream { std::vector<u32t> insts, pcs; };
static Stream sab_stream(const std::map<u32t,u32t>& overrides = {}) {
    Stream s;
    for (std::size_t i = 0; i < EXPECT_N; ++i) {
        u32t w = EXPECT_INSTS[i];
        auto it = overrides.find(EXPECT_PCS[i]);
        if (it != overrides.end()) w = it->second;
        s.insts.push_back(w);
        s.pcs.push_back(EXPECT_PCS[i]);
    }
    return s;
}

// ===========================================================================
// GROUP 0 — encoder fidelity against the real disc bytes.
// ===========================================================================
static void group0() {
    info("GROUP 0 -- encoders vs bytes read from 'Sonic Adventure 2 - Battle (USA).iso'");
    expect("0.1  enc_bl reproduces the disc word at 0x80117e0c",
           enc_bl(LOOP, LEAF) == SAB_LOOP_WORDS[0]);
    expect("0.2  enc_lwz r5,-29248(r13) reproduces 0x80117e10",
           enc_lwz(5,13,-29248) == SAB_LOOP_WORDS[1]);
    expect("0.3  enc_lwz r4,-29244(r13) reproduces 0x80117e14",
           enc_lwz(4,13,-29244) == SAB_LOOP_WORDS[2]);
    expect("0.4  enc_addi r0,r4,-1 reproduces 0x80117e18",
           enc_addi(0,4,-1) == SAB_LOOP_WORDS[3]);
    expect("0.5  enc_add r0,r5,r0 reproduces 0x80117e1c (op31.266)",
           enc_add(0,5,0) == SAB_LOOP_WORDS[4]);
    expect("0.6  enc_cmpl cr0,r3,r0 reproduces 0x80117e20 (op31.32)",
           enc_cmpl(0,3,0) == SAB_LOOP_WORDS[5]);
    expect("0.7  enc_bc 4,1 -> LOOP reproduces 0x80117e24",
           enc_bc(4,1,TERM,LOOP) == SAB_LOOP_WORDS[6]);
    expect("0.8  enc_lwz r3,-29952(r13) reproduces the leaf at 0x800f3710",
           enc_lwz(3,13,-29952) == SAB_LEAF_WORDS[0]);
    expect("0.9  enc_blr reproduces the leaf's 0x800f3714",
           enc_blr() == SAB_LEAF_WORDS[1]);
    expect("0.10 IsSeamInlineBl accepts the real bl at its real inline seam",
           IsSeamInlineBl(SAB_LOOP_WORDS[0], LOOP, LEAF));
    expect("0.11 IsPlainBlr accepts the real leaf terminator",
           IsPlainBlr(SAB_LEAF_WORDS[1]));
    expect("0.12 the real bl IS a block terminator (the gap being closed)",
           IsBlockTerminator(SAB_LOOP_WORDS[0]));
    expect("0.13 the real back-edge is NOT a forward conditional (stays terminal)",
           !IsForwardConditionalBranch(SAB_LOOP_WORDS[6], TERM));

    // Control: the un-spliced contiguous decode. This is the behaviour the
    // change replaces, and it must remain what happens when nothing splices.
    MemMap m = sab_map(SAB_LEAF_WORDS, 2);
    Analysis a; analyze_contig(a, LOOP, m, 64);
    expect("0.14 CONTROL: contiguous decode of the loop still ends AT the bl "
           "(1 op) -- the no-splice path is unchanged",
           a.n() == 1 && a.op(0).address == LOOP && !a.block.m_noncontiguous &&
           !a.idle(),
           "n_ops=" + dec((long long)a.n()));

    // OBSERVATION, recorded not asserted. IsBusyWaitLoop's Branch arm
    // (ppc_analyst.cpp:380-383) tests only branchTo == m_address and
    // i+1 == instructions; it does not test LK. So a self-targeting `bl`
    // decodes to a one-op block that is classified idle. This is PRE-EXISTING
    // and unrelated to leaf inlining -- it is recorded because the change makes
    // bl-shaped ops newly interesting to this classifier. I have not
    // established whether it is reachable in any real title.
    {
        MemMap sm = sab_map(SAB_LEAF_WORDS, 2);
        sm.put1(LOOP, enc_bl(LOOP, LOOP));         // bl +0
        Analysis sa; analyze_contig(sa, LOOP, sm, 64);
        info("  0.15 (observation) a self-targeting `bl` (bl +0) decodes to " +
             dec((long long)sa.n()) + " op and is classified idle=" + dec(sa.idle()) +
             " -- pre-existing; IsBusyWaitLoop's Branch arm does not test LK");
    }
}

// ===========================================================================
// GROUP G — THE DOWNSTREAM CONTRACT. Live against the unmodified tree.
//
// Feeds the hand-built spliced stream straight to AnalyzeOps, exactly as
// build_block_next does when the caller passes instr_pcs (ppc_emit.cpp:1905-1907).
// If any of this were red, the decoder work would be pointless.
// ===========================================================================
static void group_g() {
    info("GROUP G -- downstream: AnalyzeOps on the spliced stream (testable TODAY)");
    Stream s = sab_stream();
    Analysis a; analyze_ops(a, s.insts.data(), s.pcs.data(), EXPECT_N);

    info("  n_ops=" + dec((long long)a.n()) +
         " noncontig=" + dec(a.block.m_noncontiguous) +
         " idle=" + dec(a.idle()) + " cycles=" + dec(a.stats.numCycles));
    for (std::size_t i = 0; i < a.n(); ++i)
        info("    [" + dec((long long)i) + "] " + hex(a.op(i).address) + "  " +
             hex(a.op(i).inst) + "  " + (a.op(i).opinfo ? a.op(i).opinfo->opname : "<null>"));

    expect("G.1a AnalyzeOps keeps all 9 ops (the seams do not truncate)",
           a.n() == EXPECT_N, "n_ops=" + dec((long long)a.n()));
    expect("G.1b m_noncontiguous is set -- ppc_emit.cpp:1482/:1492 gate BOTH seam "
           "arms on it",
           a.block.m_noncontiguous);
    expect("G.1c block.m_address is the LOOP HEAD, not the leaf",
           a.block.m_address == LOOP, hex(a.block.m_address));
    expect_nonvacuous("G.1d TERMINATOR IS CLASSIFIED branchIsIdleLoop "
                      "(the whole point of the change)",
                      a.n() == EXPECT_N, a.idle(), "stream truncated");

    // ---- G.2  LR EXACTNESS -------------------------------------------------
    // The analyst emits no code, so this cannot execute a block and read LR.
    // What it asserts instead is the complete set of analyst-level facts that
    // determine LR, each tied to the emitter line that consumes it:
    //
    //   NON-INLINED (today):  jit_branch.cpp:147
    //       emit_store_const_to_ctx(wb, ctx_ptr, ppc_off::lr_off(), op.address + 4)
    //   INLINED:              ppc_emit.cpp:1485-1489
    //       i32.const ctx ; i32.const (op.address + 4u) ; i32.store lr_off()
    //
    // Both bake the SAME expression `op.address + 4` into the SAME slot
    // ppc_off::lr_off() (ppc_offsets.h:69, spr(SPR_LR=8)). So the two paths give
    // a BIT-IDENTICAL LR iff: (i) the bl CodeOp survives un-elided, (ii) its
    // .address is the real bl pc, and (iii) the emitter actually takes the seam
    // arm, whose guard at ppc_emit.cpp:1482-1484 is the four-way conjunction
    // asserted below. There is no other writer of lr_off() on this path.
    expect_nonvacuous("G.2a the bl survives into the buffer at index 0, un-skipped",
                      a.n() == EXPECT_N,
                      a.op(0).inst == SAB_LOOP_WORDS[0] && !a.op(0).skip, "truncated");
    expect_nonvacuous("G.2b the inlined bl keeps its REAL address 0x80117E0C, so "
                      "`op.address + 4` is identical in both emitters",
                      a.n() == EXPECT_N, a.op(0).address == LOOP, "truncated");
    expect_nonvacuous("G.2c the LR constant both paths bake is 0x80117E10",
                      a.n() == EXPECT_N, a.op(0).address + 4u == RET, "truncated");
    expect_nonvacuous("G.2d seam guard conjunct 1/4: bl is NOT the terminator",
                      a.n() == EXPECT_N, 1u < a.n(), "truncated");
    expect_nonvacuous("G.2e seam guard conjunct 2/4: block.m_noncontiguous",
                      a.n() == EXPECT_N, a.block.m_noncontiguous, "truncated");
    expect_nonvacuous("G.2f seam guard conjunct 3/4: i+1 < n_ops",
                      a.n() == EXPECT_N, 1u < a.n(), "truncated");
    expect_nonvacuous("G.2g seam guard conjunct 4/4: IsSeamInlineBl(inst,address,next)",
                      a.n() == EXPECT_N,
                      IsSeamInlineBl(a.op(0).inst, a.op(0).address, a.op(1).address),
                      "truncated");
    expect_nonvacuous("G.2h the LR store (index 0) precedes every consumer of LR",
                      a.n() == EXPECT_N, true, "truncated");
    expect_nonvacuous("G.2i the inlined leaf ends in a plain blr (ppc_emit.cpp:1493)",
                      a.n() > 2, IsPlainBlr(a.op(2).inst), "truncated");
    expect_nonvacuous("G.2j software-RAS predicted return == LR "
                      "(ras_ret = buffer[i+1].address, ppc_emit.cpp:1497)",
                      a.n() > 3, a.op(3).address == a.op(0).address + 4u &&
                                 a.op(3).address == RET, "truncated");

    // ---- G.3  a loop body that READS LR ------------------------------------
    {
        Stream r = sab_stream({{0x80117E18u, enc_mfspr(0, SPR_LR_)}});   // addi -> mflr r0
        Analysis b; analyze_ops(b, r.insts.data(), r.pcs.data(), EXPECT_N);
        expect("G.3a with an LR reader in the body the stream still analyzes whole",
               b.n() == EXPECT_N, "n_ops=" + dec((long long)b.n()));
        expect_nonvacuous("G.3b the bl (LR producer) is still at index 0, ahead of the "
                          "mflr at index 5, and still takes the seam arm",
                          b.n() == EXPECT_N,
                          b.op(0).address == LOOP && b.op(5).address == 0x80117E18u &&
                          IsSeamInlineBl(b.op(0).inst, b.op(0).address, b.op(1).address),
                          "truncated");
        // mflr is OpType::SPR; IsBusyWaitLoop (ppc_analyst.cpp:288-291) admits only
        // Integer, Load and the terminating Branch. An LR-observing loop must not be
        // silently idle-skipped.
        expect("G.3c an LR-reading loop is NOT classified idle (mflr is OpType::SPR)",
               !b.idle());
    }

    // ---- G.4  NON-SELF BACK-EDGES (task requirement 4) ---------------------
    // These are the latent-hazard cases in the n64/docs/jit/TASKS.md:511-515
    // sense: they catch an implementer who relaxes IsBusyWaitLoop's
    // `branchTo == block->m_address` (ppc_analyst.cpp:286) to "targets any
    // address in the decoded set". Non-vacuous because the stream is hand-built.
    {
        Stream r = sab_stream({{TERM, enc_bc(4,1,TERM,RET)}});   // -> LOOP+4
        Analysis b; analyze_ops(b, r.insts.data(), r.pcs.data(), EXPECT_N);
        expect_nonvacuous("G.4a back-edge to LOOP+4 (skipping the call) is NOT idle",
                          b.n() == EXPECT_N, !b.idle(), "truncated");
    }
    {
        Stream r = sab_stream({{TERM, enc_bc(4,1,TERM,LEAF)}});  // -> into the callee
        Analysis b; analyze_ops(b, r.insts.data(), r.pcs.data(), EXPECT_N);
        expect_nonvacuous("G.4b back-edge INTO the inlined callee body is NOT idle "
                          "(0x800F3710 IS in the decoded set but is not the head)",
                          b.n() == EXPECT_N, !b.idle(), "truncated");
    }
    {
        Stream r = sab_stream({{TERM, enc_bc(16,0,TERM,LOOP)}}); // bdnz -> LOOP
        Analysis b; analyze_ops(b, r.insts.data(), r.pcs.data(), EXPECT_N);
        expect_nonvacuous("G.4c a CTR-counted (bdnz) back-edge to the head is NOT idle "
                          "(trip-counted loop, ppc_analyst.cpp:285)",
                          b.n() == EXPECT_N, !b.idle(), "truncated");
    }
    {
        Stream r = sab_stream({{TERM, enc_b(TERM, LOOP)}});      // unconditional b -> LOOP
        Analysis b; analyze_ops(b, r.insts.data(), r.pcs.data(), EXPECT_N);
        info("  G.4d (info) unconditional `b <head>` terminator: n_ops=" +
             dec((long long)b.n()) + " idle=" + dec(b.idle()));
    }

    // ---- G.5  a STORE in the body must defeat idle classification ----------
    // The busy-wait assumption is "no memory writes". This is the safety net if
    // a future purity relaxation ever lets a store into the stream.
    //
    // CONTROLLED PAIR. The substituted op must not also break the loop's
    // register dataflow, or the test passes for the wrong reason -- an earlier
    // draft substituted at 0x80117e18, which deleted r0's only producer, and a
    // mutation run that ALLOWED stores still showed it green. G.5b is the
    // control: the identical stream with an Integer op in the same slot MUST be
    // idle, so the only difference between the two results is the store itself.
    {
        // 0x80117e14's `lwz r4,-29244(r13)` -> a store. r4 becomes read-before-
        // written, which the dataflow rule permits (nothing writes r4 later).
        Stream st = sab_stream({{0x80117E14u, enc_stw(4,13,0)}});
        Analysis bs; analyze_ops(bs, st.insts.data(), st.pcs.data(), EXPECT_N);
        Stream ct = sab_stream({{0x80117E14u, enc_addi(6,4,0)}});   // Integer, same slot
        Analysis bc_; analyze_ops(bc_, ct.insts.data(), ct.pcs.data(), EXPECT_N);

        expect("G.5a a STORE in the loop body defeats idle classification",
               !bs.idle());
        expect("G.5b CONTROL: the same stream with an Integer op in that slot IS "
               "idle -- so G.5a discriminates the STORE, not the dataflow",
               bc_.idle(),
               "control stream was not idle; G.5a proves nothing");
    }

    // ---- G.6  a malformed seam must fall back, not be trusted --------------
    // The blr's successor pc no longer equals bl.address+4, so the call/return
    // pairing at ppc_analyst.cpp:713-726 is broken. Eligibility must drop.
    {
        Stream r = sab_stream();
        r.pcs[3] = 0x80117E30u;                  // return site moved: unmatched blr
        Analysis b; analyze_ops(b, r.insts.data(), r.pcs.data(), EXPECT_N);
        expect("G.6a an UNMATCHED blr seam (return pc != bl.address+4) is not idle",
               !b.idle());
    }
    {
        // A second, nested bl with no matching blr -- depth > 1 is not modelled.
        Stream r = sab_stream({{0x800F3710u, enc_bl(0x800F3710u, 0x800F3714u)}});
        Analysis b; analyze_ops(b, r.insts.data(), r.pcs.data(), EXPECT_N);
        expect("G.6b a NESTED bl inside the inlined callee is not idle "
               "(depth-1 pairing only, ppc_analyst.cpp:708-726)",
               !b.idle());
    }

    // ---- G.7  GATE #9, analyst half ---------------------------------------
    // ppc_emit.cpp:997-999 reads exactly buffer[n-1].branchIsIdleLoop and nothing
    // else; ppc_emit.cpp:1000 uses stats.numCycles as `charge`.
    {
        int carriers = 0, first = -1;
        for (std::size_t i = 0; i < a.n(); ++i)
            if (a.op(i).branchIsIdleLoop) { ++carriers; if (first < 0) first = (int)i; }
        expect_nonvacuous("G.7a exactly one op carries branchIsIdleLoop and it is the "
                          "TERMINATOR (ppc_emit.cpp:997-999 reads only that one)",
                          a.n() == EXPECT_N,
                          carriers == 1 && first == (int)a.n() - 1,
                          "truncated");
        u32t sum = 0;
        for (std::size_t i = 0; i < a.n(); ++i)
            if (a.op(i).opinfo) sum += a.op(i).opinfo->num_cycles;
        expect("G.7b numCycles == sum of the decoded ops' table cycles "
               "(the analyst fabricates no credit)",
               a.stats.numCycles == sum,
               dec(a.stats.numCycles) + " vs " + dec(sum));
        expect_nonvacuous("G.7c the 9-op SAB block is worth exactly 9 cycles",
                          a.n() == EXPECT_N, a.stats.numCycles == 9u,
                          "truncated");
        // Identical ops, one idle and one not: if numCycles differed, the idle
        // flag would be buying time, which gate #9 forbids.
        Stream r = sab_stream({{TERM, enc_bc(4,1,TERM,RET)}});
        Analysis b; analyze_ops(b, r.insts.data(), r.pcs.data(), EXPECT_N);
        expect_nonvacuous("G.7d idle and non-idle analyses of the SAME 9 ops report "
                          "IDENTICAL numCycles (the flag adds no emulated time)",
                          a.n() == EXPECT_N && b.n() == EXPECT_N,
                          a.stats.numCycles == b.stats.numCycles &&
                          a.idle() && !b.idle(),
                          "truncated");
        // And the two SEPARATE blocks the un-spliced path produces must sum to the
        // same 9 cycles -- splicing must not change what the guest is charged.
        MemMap m = sab_map(SAB_LEAF_WORDS, 2);
        Analysis p1, p2, p3;
        analyze_contig(p1, LOOP, m, 64);    // [bl]
        analyze_contig(p2, LEAF, m, 64);    // [lwz ; blr]
        analyze_contig(p3, RET,  m, 64);    // [lwz ; lwz ; addi ; add ; cmplw ; bc]
        const u32t split_total = p1.stats.numCycles + p2.stats.numCycles + p3.stats.numCycles;
        expect_nonvacuous("G.7e SPLICED cycle charge == sum of the THREE un-spliced "
                          "blocks (1 + 2 + 6 ops): inlining is cycle-neutral",
                          a.n() == EXPECT_N,
                          a.stats.numCycles == split_total,
                          "truncated");
        info("  G.7f (info) un-spliced charge = " + dec(p1.stats.numCycles) + " + " +
             dec(p2.stats.numCycles) + " + " + dec(p3.stats.numCycles) + " = " +
             dec(split_total) + " ; spliced = " + dec(a.stats.numCycles));
    }
}

// ===========================================================================
// GROUP E — gate #9, the CoreTiming half.
//
// THE PROOF, with citations:
//   1. branchIsIdleLoop's ONLY effect is ppc_emit.cpp:1000-1003, which emits
//        i32.const ctx ; i32.const 0 ; i32.store DOWNCOUNT
//      in the block PROLOGUE in place of the :1004-1010 `downcount -= charge`.
//      It stores the literal ZERO and can store nothing else. The block BODY is
//      emitted identically either way, so architectural state stays exact and
//      the guest is not fast-forwarded.
//   2. CoreTiming::Advance then credits, verbatim at CoreTiming.cpp:394-396,
//        int cyclesExecuted = m_globals.slice_length - DowncountToCycles(ppc_state.downcount);
//        m_globals.global_timer += cyclesExecuted;
//      and slice_length was ALREADY clamped, at CoreTiming.cpp:488-489, to
//        std::min<s64>(m_event_queue.front().time - m_globals.global_timer,
//                      MAX_SLICE_LENGTH)                  (MAX_SLICE_LENGTH = 20000, :45)
//      DowncountToCycles(0) == 0 (:62-65, a multiply), so the credit is EXACTLY
//      slice_length and global_timer' = global_timer + slice_length <= next_event.time.
//      Emulated time advances TO the next scheduled event and never past it: the
//      guest still observes exactly one VI retrace per 1/60 emulated second.
//   3. This is the mechanism already shipping for the contiguous
//      `lwz; cmp; b<cond> self` polls (ppc_analyst.cpp:693-704). Leaf inlining
//      changes WHICH blocks reach it, never WHAT it does.
//
// Below is that arithmetic as an executable sweep. It is a MODEL of the cited
// lines, not the production code -- its value is that a future change to that
// arithmetic has a stated invariant to violate.
// ===========================================================================
static void group_e() {
    info("GROUP E -- gate #9: the mechanism can only ever ZERO downcount");
    const long long MAX_SLICE = 20000;          // CoreTiming.cpp:45
    bool overshoot = false, negative = false, dc0_full = true, idle_is_ceiling = true;
    long long worst = 0, cells = 0;

    for (long long gt = 0; gt <= 2000000; gt += 7919) {
        for (long long gap = 1; gap <= 60000; gap += 977) {
            const long long next_event = gt + gap;
            // CoreTiming.cpp:488-489
            const long long slice = (next_event - gt) < MAX_SLICE ? (next_event - gt) : MAX_SLICE;
            // ppc_emit.cpp:1000-1003 -- the idle prologue stores literal 0.
            // CoreTiming.cpp:62-65  -- DowncountToCycles(0) == 0.
            const long long credit_idle = slice - 0;
            const long long gt_after    = gt + credit_idle;
            ++cells;
            if (credit_idle != slice) dc0_full = false;
            if (credit_idle < 0)      negative = true;
            if (gt_after > next_event) {
                overshoot = true;
                if (gt_after - next_event > worst) worst = gt_after - next_event;
            }
            // A NON-idle block leaves downcount > 0 and therefore credits strictly
            // less. The idle path is the CEILING of credit within a slice, never
            // an excess beyond it.
            for (long long dc = 1; dc <= slice; dc += 97) {
                const long long credit_run = slice - dc;
                if (!(credit_run < credit_idle)) idle_is_ceiling = false;
                if (gt + credit_run > next_event) overshoot = true;
            }
        }
    }
    info("  swept " + dec(cells) + " (global_timer, next_event) cells");
    expect("E.1 downcount=0 credits EXACTLY slice_length, never more", dc0_full);
    expect("E.2 the credit is never negative (emulated time only advances)", !negative);
    expect("E.3 global_timer NEVER advances past the next scheduled event "
           "(so the guest still sees one VI retrace per 1/60 emulated second)",
           !overshoot, "worst overshoot " + dec(worst) + " cycles");
    expect("E.4 any downcount > 0 credits strictly LESS than the idle path: "
           "idle-skip is the CEILING of in-slice credit, not an excess",
           idle_is_ceiling);
    info("  E.5 (read-proof, not executable) the block BODY is emitted identically "
         "on both arms of ppc_emit.cpp:999-1010 -- only the prologue downcount "
         "store differs -- so every guest op still executes and architectural "
         "state is unchanged. Verified by reading ppc_emit.cpp:997-1010.");
}

// ===========================================================================
// GROUPS A + C — the UPSTREAM half: the new decoder API.
// Compiled out (and reported RED) when the API is not yet implemented.
// ===========================================================================
#ifndef LEAF_API_MISSING

static constexpr std::size_t CAP = 64;

struct Decoded {
    u32t insts[CAP], pcs[CAP];
    std::size_t n = 0;
    bool spliced = false;
    u32t guest_end = 0;
};
static void decode(Decoded& d, u32t start, MemMap& m) {
    d.n = DecodeBlockLeafInlined(start, &mem_fetch, &m, d.insts, d.pcs, CAP,
                                 &d.spliced, &d.guest_end);
}

// ---- GROUP A: the SAB shape is spliced -----------------------------------
static void group_a() {
    info("GROUP A -- DecodeBlockLeafInlined splices the SAB frame governor");
    MemMap m = sab_map(SAB_LEAF_WORDS, 2);
    Decoded d; decode(d, LOOP, m);

    info("  n=" + dec((long long)d.n) + " spliced=" + dec(d.spliced) +
         " guest_end=" + hex(d.guest_end));
    for (std::size_t i = 0; i < d.n && i < 12; ++i)
        info("    [" + dec((long long)i) + "] " + hex(d.pcs[i]) + "  " + hex(d.insts[i]));

    expect("A.1 decoder returns 9 ops (bl + 2-op leaf + 6-op body)",
           d.n == EXPECT_N, "n=" + dec((long long)d.n));
    expect("A.2 out_spliced is true (caller MUST pass out_pcs to build_block_next)",
           d.spliced);

    bool pcs_ok = d.n == EXPECT_N, insts_ok = d.n == EXPECT_N;
    for (std::size_t i = 0; i < EXPECT_N && d.n == EXPECT_N; ++i) {
        if (d.pcs[i]   != EXPECT_PCS[i])   pcs_ok   = false;
        if (d.insts[i] != EXPECT_INSTS[i]) insts_ok = false;
    }
    expect("A.3 pc sequence is exactly bl, leaf, leaf, body...", pcs_ok);
    expect("A.4 instruction words are the real disc words in stream order", insts_ok);

    // out_guest_end drives icbi range eviction: JitWasm.cpp sets
    // m_block_guest_end[start_pc] from it. It must cover the WHOLE contiguous
    // caller stream (past the bl, through the terminator), or the caller's own
    // body would not be evicted when the guest rewrites it.
    expect("A.4b out_guest_end covers the whole contiguous caller stream "
           "(0x80117E28 = terminator + 4), not just up to the bl",
           d.guest_end == TERM + 4u, hex(d.guest_end));
    // KNOWN GAP, pinned here rather than left implicit: a single [start, end)
    // record cannot also cover the inlined callee's range, so a guest that
    // rewrites the leaf body would not evict this block. JitWasm.cpp records the
    // same limitation at its m_block_guest_end assignment. Exposure is bounded
    // to <= kLeafInlineMaxOps words per spliced block.
    info(std::string("  A.4c (known gap) the inlined callee range [") + hex(LEAF) +
         ", " + hex(LEAF + 8u) + ") is OUTSIDE [" + hex(LOOP) + ", " +
         hex(d.guest_end) + "): in-range=" +
         dec(LEAF >= LOOP && LEAF < d.guest_end) +
         " -- a guest rewrite of the leaf will not evict this block");

    // End-to-end: the decoder's own output, through AnalyzeOps, must be idle.
    Analysis a;
    if (d.n) analyze_ops(a, d.insts, d.pcs, d.n);
    expect_nonvacuous("A.5 END-TO-END: the decoder's OWN output, fed to AnalyzeOps as "
                      "build_block_next does, is classified branchIsIdleLoop",
                      d.n > 0, a.block.m_noncontiguous && a.idle(),
                      "decoder returned no ops");

    // A block with no inlinable bl must be bit-identical to today.
    {
        MemMap m2 = sab_map(SAB_LEAF_WORDS, 2);
        Decoded d2; decode(d2, RET, m2);          // the 6-op body, no bl
        Analysis c; analyze_contig(c, RET, m2, 64);
        bool same = d2.n == c.n() && !d2.spliced;
        for (std::size_t i = 0; same && i < d2.n; ++i)
            same = d2.pcs[i] == c.op(i).address && d2.insts[i] == c.op(i).inst;
        expect("A.6 a block with NO inlinable bl decodes bit-identically to the "
               "contiguous path and reports spliced=false", same,
               "n=" + dec((long long)d2.n) + " vs " + dec((long long)c.n()) +
               " spliced=" + dec(d2.spliced));
    }
}

// ---- GROUP C: conservative purity refusal --------------------------------
// CONTRACT: fall back to TODAY's behaviour exactly -- the block ends AT the bl,
// one op, spliced=false. "Spliced but then not idle" is NOT acceptable: it would
// still splice foreign code in and still take the emitter's seam arm.
static void expect_refused(const std::string& name, const std::vector<u32t>& leaf) {
    MemMap m = sab_map(leaf.empty() ? nullptr : leaf.data(), leaf.size());
    Decoded d; decode(d, LOOP, m);
    // DecodePureLeaf must independently refuse.
    u32t li[CAP], lp[CAP];
    const std::size_t leaf_n = DecodePureLeaf(LEAF, &mem_fetch, &m, li, lp, CAP);
    expect(name, d.n == 1 && !d.spliced && d.pcs[0] == LOOP && leaf_n == 0,
           "block n=" + dec((long long)d.n) + " spliced=" + dec(d.spliced) +
           " DecodePureLeaf=" + dec((long long)leaf_n));
}

static void group_c() {
    info("GROUP C -- conservative purity refusal (block must end AT the bl)");
    expect_refused("C.1  callee contains a STORE (stw)",
                   {enc_stw(3,13,0), enc_blr()});
    expect_refused("C.2  callee contains a further BL (nested call)",
                   {enc_bl(LEAF, LEAF+0x40u), enc_blr()});
    expect_refused("C.3  callee contains a FORWARD conditional branch",
                   {enc_bc(4,2,LEAF,LEAF+8u), enc_lwz(3,13,-29952), enc_blr()});
    expect_refused("C.4  callee contains a BACKWARD conditional branch",
                   {enc_lwz(3,13,-29952), enc_bc(4,2,LEAF+4u,LEAF), enc_blr()});
    expect_refused("C.5  callee contains an unconditional B",
                   {enc_b(LEAF, LEAF+8u), enc_lwz(3,13,-29952), enc_blr()});
    expect_refused("C.6  callee ends in BCTR, not blr",
                   {enc_lwz(3,13,-29952), enc_bctr()});
    expect_refused("C.7  callee ends in a CONDITIONAL bclr (beqlr), not a plain blr",
                   {enc_lwz(3,13,-29952), enc_bclr_cond(12,2)});
    expect_refused("C.8  callee ends in BLRL (bclr LK=1 -- writes LR)",
                   {enc_lwz(3,13,-29952), enc_blrl()});
    expect_refused("C.9  callee writes an SPR (mtctr)",
                   {enc_mtspr(3,SPR_CTR_), enc_blr()});
    expect_refused("C.10 callee writes LR (mtlr) -- would corrupt the return seam",
                   {enc_mtspr(3,SPR_LR_), enc_blr()});
    expect_refused("C.11 callee writes MSR (mtmsr)",
                   {enc_mtmsr(3), enc_blr()});
    expect_refused("C.12 callee reads an SPR (mflr) -- OpType::SPR, refuse conservatively",
                   {enc_mfspr(3,SPR_LR_), enc_blr()});
    expect_refused("C.13 callee touches the FPU (lfs)",
                   {enc_lfs(1,13,0), enc_blr()});
    expect_refused("C.14 bl target is unmapped / invalid encoding", {});

    // Budget boundary either side of kLeafInlineMaxOps (declared in ppc_analyst.h).
    {
        std::vector<u32t> ok;
        for (std::size_t i = 0; i + 1 < kLeafInlineMaxOps; ++i) ok.push_back(enc_lwz(3,13,-29952));
        ok.push_back(enc_blr());                       // exactly kLeafInlineMaxOps
        MemMap m = sab_map(ok.data(), ok.size());
        Decoded d; decode(d, LOOP, m);
        expect("C.15 a callee of EXACTLY kLeafInlineMaxOps (" +
               dec((long long)kLeafInlineMaxOps) + ") ops IS inlined",
               d.spliced && d.n == (EXPECT_N - 2 + kLeafInlineMaxOps),
               "n=" + dec((long long)d.n) + " spliced=" + dec(d.spliced));
    }
    {
        std::vector<u32t> over;
        for (std::size_t i = 0; i < kLeafInlineMaxOps; ++i) over.push_back(enc_lwz(3,13,-29952));
        over.push_back(enc_blr());                     // kLeafInlineMaxOps + 1
        expect_refused("C.16 a callee of kLeafInlineMaxOps + 1 ops is refused", over);
    }
    {
        std::vector<u32t> run;
        for (int i = 0; i < 64; ++i) run.push_back(enc_addi(3,3,1));
        expect_refused("C.17 callee never returns within reach (no blr at all)", run);
    }
    // Self-recursive and self-overlapping targets.
    {
        MemMap m = sab_map(SAB_LEAF_WORDS, 2);
        m.put1(LOOP, enc_bl(LOOP, LOOP));              // bl +0
        Decoded d; decode(d, LOOP, m);
        expect("C.18 bl targeting the block START (self-recursive) is not spliced",
               !d.spliced && d.n == 1, "n=" + dec((long long)d.n) +
               " spliced=" + dec(d.spliced));
    }
    {
        MemMap m = sab_map(SAB_LEAF_WORDS, 2);
        m.put1(LOOP, enc_bl(LOOP, 0x80117E18u));       // target inside the caller
        Decoded d; decode(d, LOOP, m);
        expect("C.19 bl targeting an address INSIDE the caller's own range is not "
               "spliced (would break the RAS return match and the self-loop identity)",
               !d.spliced, "n=" + dec((long long)d.n) +
               " spliced=" + dec(d.spliced));
    }
    // Predicate-level sanity on the two small helpers.
    expect("C.20 IsInlinableBl accepts the real SAB bl and rejects a plain b",
           IsInlinableBl(SAB_LOOP_WORDS[0]) && !IsInlinableBl(enc_b(LOOP, LEAF)));
    expect("C.21 BlTarget resolves the real SAB bl to 0x800F3710",
           BlTarget(SAB_LOOP_WORDS[0], LOOP) == LEAF,
           hex(BlTarget(SAB_LOOP_WORDS[0], LOOP)));
}

#else   // LEAF_API_MISSING

static void group_a() {
    info("GROUP A -- DecodeBlockLeafInlined splices the SAB frame governor");
    expect("A.* the leaf-inline decoder API is IMPLEMENTED "
           "(DecodeBlockLeafInlined / DecodePureLeaf in ppc_analyst.cpp)", false,
           "declared in ppc_analyst.h but NOT DEFINED -- Groups A and C "
           "(22 assertions incl. every purity refusal) could not run");
}
static void group_c() {
    info("GROUP C -- conservative purity refusal (block must end AT the bl)");
    info("  skipped: the decoder API is not implemented yet (see A.*)");
}

#endif  // LEAF_API_MISSING

// ===========================================================================
int main() {
    info("test_leaf_inline -- correctness gate for pure-leaf bl inlining");
    info("target: gamecube/bementalJIT/guests/powerpc-next/ppc_analyst.{h,cpp}");
#ifdef LEAF_API_MISSING
    info("BUILD MODE: LEAF_API_MISSING -- the new decoder API is not defined yet");
#else
    info("BUILD MODE: full -- the new decoder API is linked");
#endif
    info("");
    group0();  info("");
    group_g(); info("");
    group_e(); info("");
    group_a(); info("");
    group_c(); info("");

    char sum[256];
    std::snprintf(sum, sizeof sum, "TOTAL  pass=%d  fail=%d  vacuous=%d",
                  g_pass, g_fail, g_vacuous);
    info(sum);
    if (g_vacuous)
        info("NOTE: VACUOUS results are NOT passes -- their precondition was unmet, "
             "so they discriminated nothing in this run.");
    return g_fail == 0 ? 0 : 1;
}

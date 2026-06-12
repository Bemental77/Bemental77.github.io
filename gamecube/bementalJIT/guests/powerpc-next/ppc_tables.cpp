//
// ppc_tables.cpp — opcode dispatch table data. Ported subset of Dolphin's
// PPCTables (Source/Core/Core/PowerPC/PPCTables.cpp, GPL-2.0-or-later).
//
// Phase 1 ships entries covering the integer / load-store / branch /
// SystemRegisters families used by the test_analyst.cpp oracle cases.
// Paired-singles (op 4), table59/table63 FP, and sub-table SPR ops are
// flagged as Subtable / Unknown with reasonable flag bits so the analyzer's
// reg-flow + endblock decisions match for the dominant code shapes.
// Full coverage lands when per-op emit files (jit_integer.cpp, etc.) are
// ported.
//
// FP / PS classification (Phase 4 minimal-impact safe path):
//   table4 (paired-singles), table59 (FP single arith), and table63 (FP
//   double + system-FP) entries are now populated for analyzer correctness
//   — block analysis no longer breaks at every FP op. The matching
//   ppc_emit.cpp dispatch routes all of these to WIMPORT_INTERP since
//   powerpc-next has no native FP emitters yet (Phase 5+). The motivation
//   is OSContext save/restore (OSSwitchFPUContext, __OSLoadFPUContext,
//   __OSSaveFPUContext at 0x800e5388..0x800e5b24 per gsne8p.map) — those
//   functions are >70 ops of pure stfd/lfd/psq_st/psq_l/mffs/mtfsf. With
//   no classification the analyzer broke every block at the first FP op
//   (one-op blocks of FPU loadstores), defeating dispatch amortization.
//   Canonical: dolphin-upstream Source/Core/Core/PowerPC/PPCTables.cpp
//   s_table4, s_table4_2, s_table4_3, s_table59, s_table63, s_table63_2.

#include "common/op_info.h"

#include "bementalJIT/types.h"
#include "ppc_analyst.h"

namespace bemental::powerpc {

namespace {

// Primary table — indexed by OPCD (bits 26..31), 64 entries.
constexpr GekkoOPInfo PRIMARY[64] = {
    /* 00 */ {"<invalid>", OpType::Invalid,   0, 0},
    /* 01 */ {"<invalid>", OpType::Invalid,   0, 0},
    /* 02 */ {"tdi",       OpType::System,    1, FL_IN_A | FL_PROGRAMEXCEPTION},
    /* 03 */ {"twi",       OpType::System,    1, FL_IN_A | FL_PROGRAMEXCEPTION | FL_ENDBLOCK},
    /* 04 */ {"<table4>",  OpType::Subtable,  0, 0},
    /* 05 */ {"<invalid>", OpType::Invalid,   0, 0},
    /* 06 */ {"<invalid>", OpType::Invalid,   0, 0},
    /* 07 */ {"mulli",     OpType::Integer,   3, FL_OUT_D | FL_IN_A},
    /* 08 */ {"subfic",    OpType::Integer,   1, FL_OUT_D | FL_IN_A | FL_SET_CA},
    /* 09 */ {"<invalid>", OpType::Invalid,   0, 0},
    /* 10 */ {"cmpli",     OpType::Integer,   1, FL_IN_A | FL_SET_CRn},
    /* 11 */ {"cmpi",      OpType::Integer,   1, FL_IN_A | FL_SET_CRn},
    /* 12 */ {"addic",     OpType::Integer,   1, FL_OUT_D | FL_IN_A | FL_SET_CA},
    /* 13 */ {"addic_rc",  OpType::Integer,   1, FL_OUT_D | FL_IN_A | FL_SET_CR0 | FL_SET_CA},
    /* 14 */ {"addi",      OpType::Integer,   1, FL_OUT_D | FL_IN_A0},
    /* 15 */ {"addis",     OpType::Integer,   1, FL_OUT_D | FL_IN_A0},
    /* 16 */ {"bcx",       OpType::Branch,    1, FL_ENDBLOCK | FL_READ_CR_BI},
    /* 17 */ {"sc",        OpType::System,    2, FL_ENDBLOCK | FL_PROGRAMEXCEPTION},
    /* 18 */ {"bx",        OpType::Branch,    1, FL_ENDBLOCK},
    /* 19 */ {"<table19>", OpType::Subtable,  0, 0},
    /* 20 */ {"rlwimix",   OpType::Integer,   1, FL_OUT_A | FL_IN_A | FL_IN_S | FL_RC_BIT},
    /* 21 */ {"rlwinmx",   OpType::Integer,   1, FL_OUT_A | FL_IN_S | FL_RC_BIT},
    /* 22 */ {"<invalid>", OpType::Invalid,   0, 0},
    /* 23 */ {"rlwnmx",    OpType::Integer,   1, FL_OUT_A | FL_IN_SB | FL_RC_BIT},
    /* 24 */ {"ori",       OpType::Integer,   1, FL_OUT_A | FL_IN_S},
    /* 25 */ {"oris",      OpType::Integer,   1, FL_OUT_A | FL_IN_S},
    /* 26 */ {"xori",      OpType::Integer,   1, FL_OUT_A | FL_IN_S},
    /* 27 */ {"xoris",     OpType::Integer,   1, FL_OUT_A | FL_IN_S},
    /* 28 */ {"andi_rc",   OpType::Integer,   1, FL_OUT_A | FL_IN_S | FL_SET_CR0},
    /* 29 */ {"andis_rc",  OpType::Integer,   1, FL_OUT_A | FL_IN_S | FL_SET_CR0},
    /* 30 */ {"<invalid>", OpType::Invalid,   0, 0},
    /* 31 */ {"<table31>", OpType::Subtable,  0, 0},
    /* 32 */ {"lwz",       OpType::Load,      1, FL_OUT_D | FL_IN_A0 | FL_LOADSTORE},
    /* 33 */ {"lwzu",      OpType::Load,      1, FL_OUT_AD | FL_IN_A  | FL_LOADSTORE},
    /* 34 */ {"lbz",       OpType::Load,      1, FL_OUT_D | FL_IN_A0 | FL_LOADSTORE},
    /* 35 */ {"lbzu",      OpType::Load,      1, FL_OUT_AD | FL_IN_A  | FL_LOADSTORE},
    /* 36 */ {"stw",       OpType::Store,     1, FL_IN_S  | FL_IN_A0 | FL_LOADSTORE},
    /* 37 */ {"stwu",      OpType::Store,     1, FL_OUT_A | FL_IN_S  | FL_IN_A | FL_LOADSTORE},
    /* 38 */ {"stb",       OpType::Store,     1, FL_IN_S  | FL_IN_A0 | FL_LOADSTORE},
    /* 39 */ {"stbu",      OpType::Store,     1, FL_OUT_A | FL_IN_S  | FL_IN_A | FL_LOADSTORE},
    /* 40 */ {"lhz",       OpType::Load,      1, FL_OUT_D | FL_IN_A0 | FL_LOADSTORE},
    /* 41 */ {"lhzu",      OpType::Load,      1, FL_OUT_AD | FL_IN_A  | FL_LOADSTORE},
    /* 42 */ {"lha",       OpType::Load,      1, FL_OUT_D | FL_IN_A0 | FL_LOADSTORE},
    /* 43 */ {"lhau",      OpType::Load,      1, FL_OUT_AD | FL_IN_A  | FL_LOADSTORE},
    /* 44 */ {"sth",       OpType::Store,     1, FL_IN_S  | FL_IN_A0 | FL_LOADSTORE},
    /* 45 */ {"sthu",      OpType::Store,     1, FL_OUT_A | FL_IN_S  | FL_IN_A | FL_LOADSTORE},
    /* 46 */ {"lmw",       OpType::System,    11, FL_IN_A0 | FL_LOADSTORE},
    /* 47 */ {"stmw",      OpType::System,    11, FL_IN_A0 | FL_LOADSTORE},
    /* 48 */ {"lfs",       OpType::LoadFP,    1, FL_OUT_FLOAT_D | FL_IN_A0 | FL_USE_FPU | FL_LOADSTORE},
    /* 49 */ {"lfsu",      OpType::LoadFP,    1, FL_OUT_FLOAT_D | FL_OUT_A | FL_IN_A | FL_USE_FPU | FL_LOADSTORE},
    /* 50 */ {"lfd",       OpType::LoadFP,    1, FL_OUT_FLOAT_D | FL_IN_A0 | FL_USE_FPU | FL_LOADSTORE},
    /* 51 */ {"lfdu",      OpType::LoadFP,    1, FL_OUT_FLOAT_D | FL_OUT_A | FL_IN_A | FL_USE_FPU | FL_LOADSTORE},
    /* 52 */ {"stfs",      OpType::StoreFP,   1, FL_IN_FLOAT_S | FL_IN_A0 | FL_USE_FPU | FL_LOADSTORE},
    /* 53 */ {"stfsu",     OpType::StoreFP,   1, FL_IN_FLOAT_S | FL_OUT_A | FL_IN_A | FL_USE_FPU | FL_LOADSTORE},
    /* 54 */ {"stfd",      OpType::StoreFP,   1, FL_IN_FLOAT_S | FL_IN_A0 | FL_USE_FPU | FL_LOADSTORE},
    /* 55 */ {"stfdu",     OpType::StoreFP,   1, FL_IN_FLOAT_S | FL_OUT_A | FL_IN_A | FL_USE_FPU | FL_LOADSTORE},
    /* 56 */ {"psq_l",     OpType::LoadPS,    1, FL_OUT_FLOAT_D | FL_IN_A0 | FL_USE_FPU | FL_LOADSTORE},
    /* 57 */ {"psq_lu",    OpType::LoadPS,    1, FL_OUT_FLOAT_D | FL_OUT_A | FL_IN_A | FL_USE_FPU | FL_LOADSTORE},
    /* 58 */ {"<invalid>", OpType::Invalid,   0, 0},
    /* 59 */ {"<table59>", OpType::Subtable,  0, 0},
    /* 60 */ {"psq_st",    OpType::StorePS,   1, FL_IN_FLOAT_S | FL_IN_A0 | FL_USE_FPU | FL_LOADSTORE},
    /* 61 */ {"psq_stu",   OpType::StorePS,   1, FL_IN_FLOAT_S | FL_OUT_A | FL_IN_A | FL_USE_FPU | FL_LOADSTORE},
    /* 62 */ {"<invalid>", OpType::Invalid,   0, 0},
    /* 63 */ {"<table63>", OpType::Subtable,  0, 0},
};

// Table 19 — secondary opcode (SUBOP10) for primary op 19. Only the entries
// the analyzer needs to classify ENDBLOCK / CR-logic are populated here.
// Phase 4 fills in the rest with their full Jit64 flag set.
static const GekkoOPInfo* table19(u32 sub10) {
    static constexpr GekkoOPInfo bclr   = {"bclrx",  OpType::Branch, 1, FL_ENDBLOCK | FL_READ_CR_BI};
    static constexpr GekkoOPInfo bcctr  = {"bcctrx", OpType::Branch, 1, FL_ENDBLOCK | FL_READ_CR_BI};
    static constexpr GekkoOPInfo rfi    = {"rfi",    OpType::System, 2, FL_ENDBLOCK | FL_SET_MSR | FL_CHECKEXCEPTIONS};
    static constexpr GekkoOPInfo crand  = {"crand",  OpType::CR,     1, FL_READ_ALL_CR | FL_SET_ALL_CR};
    static constexpr GekkoOPInfo cror   = {"cror",   OpType::CR,     1, FL_READ_ALL_CR | FL_SET_ALL_CR};
    static constexpr GekkoOPInfo crxor  = {"crxor",  OpType::CR,     1, FL_READ_ALL_CR | FL_SET_ALL_CR};
    static constexpr GekkoOPInfo crnand = {"crnand", OpType::CR,     1, FL_READ_ALL_CR | FL_SET_ALL_CR};
    static constexpr GekkoOPInfo crnor  = {"crnor",  OpType::CR,     1, FL_READ_ALL_CR | FL_SET_ALL_CR};
    static constexpr GekkoOPInfo creqv  = {"creqv",  OpType::CR,     1, FL_READ_ALL_CR | FL_SET_ALL_CR};
    static constexpr GekkoOPInfo crandc = {"crandc", OpType::CR,     1, FL_READ_ALL_CR | FL_SET_ALL_CR};
    static constexpr GekkoOPInfo crorc  = {"crorc",  OpType::CR,     1, FL_READ_ALL_CR | FL_SET_ALL_CR};
    static constexpr GekkoOPInfo mcrf   = {"mcrf",   OpType::CR,     1, FL_READ_CRn | FL_SET_CRn};
    static constexpr GekkoOPInfo isync  = {"isync",  OpType::InstructionCache, 1, 0};
    switch (sub10) {
    case 16:  return &bclr;
    case 528: return &bcctr;
    case 50:  return &rfi;
    case 257: return &crand;
    case 449: return &cror;
    case 193: return &crxor;
    case 225: return &crnand;
    case 33:  return &crnor;
    case 289: return &creqv;
    case 129: return &crandc;
    case 417: return &crorc;
    case 0:   return &mcrf;
    case 150: return &isync;
    default:  return nullptr;
    }
}

// Table 31 — secondary opcode (SUBOP10) for primary op 31. Phase 1 covers
// the integer X-form ops + a partial load/store X-form + the system
// register access ops needed for sanity. Many entries return nullptr
// (analyzer treats as Unknown / no flow info) until Phase 4 fills the
// per-op file split.
static const GekkoOPInfo* table31(u32 sub10) {
    // ADD family. OE-suffix variants carry FL_SET_OE so analyzer correctly
    // classifies them as XER.OV-writers (per dolphin-upstream PPCTables.cpp
    // s_table31). Emit functions in jit_integer.cpp branch on
    // GekkoOperands::OE(inst) internally and route the OE form to
    // WIMPORT_INTERP — see emit_oe_fallback_if_set. The split-entry shape
    // here matches Dolphin's source-of-truth flag bits even though
    // powerpc-next does not inline OV/SO tracking.
    static constexpr GekkoOPInfo addx    = {"addx",    OpType::Integer, 1, FL_OUT_D | FL_IN_AB | FL_RC_BIT};
    static constexpr GekkoOPInfo addox   = {"addox",   OpType::Integer, 1, FL_OUT_D | FL_IN_AB | FL_RC_BIT | FL_SET_OE};
    static constexpr GekkoOPInfo subfx   = {"subfx",   OpType::Integer, 1, FL_OUT_D | FL_IN_AB | FL_RC_BIT};
    static constexpr GekkoOPInfo subfox  = {"subfox",  OpType::Integer, 1, FL_OUT_D | FL_IN_AB | FL_RC_BIT | FL_SET_OE};
    static constexpr GekkoOPInfo addex   = {"addex",   OpType::Integer, 1, FL_OUT_D | FL_IN_AB | FL_READ_CA | FL_SET_CA | FL_RC_BIT};
    static constexpr GekkoOPInfo addeox  = {"addeox",  OpType::Integer, 1, FL_OUT_D | FL_IN_AB | FL_READ_CA | FL_SET_CA | FL_RC_BIT | FL_SET_OE};
    static constexpr GekkoOPInfo subfex  = {"subfex",  OpType::Integer, 1, FL_OUT_D | FL_IN_AB | FL_READ_CA | FL_SET_CA | FL_RC_BIT};
    static constexpr GekkoOPInfo subfeox = {"subfeox", OpType::Integer, 1, FL_OUT_D | FL_IN_AB | FL_READ_CA | FL_SET_CA | FL_RC_BIT | FL_SET_OE};
    static constexpr GekkoOPInfo mullwx  = {"mullwx",  OpType::Integer, 3, FL_OUT_D | FL_IN_AB | FL_RC_BIT};
    static constexpr GekkoOPInfo mullwox = {"mullwox", OpType::Integer, 3, FL_OUT_D | FL_IN_AB | FL_RC_BIT | FL_SET_OE};
    // FL_FLOAT_DIV is reserved for true FP divides (fdiv/fdivs); integer
    // divides don't raise a precise FP exception. Matches Dolphin
    // PPCTables.cpp:253-256. Removal is behavior-inert today (native
    // emitter at ppc_emit.cpp:188-189 bypasses canCauseException) but
    // prevents a future scheduler from over-conservatively serializing
    // around integer divides.
    static constexpr GekkoOPInfo divwx   = {"divwx",   OpType::Integer, 19, FL_OUT_D | FL_IN_AB | FL_RC_BIT};
    static constexpr GekkoOPInfo divwox  = {"divwox",  OpType::Integer, 19, FL_OUT_D | FL_IN_AB | FL_RC_BIT | FL_SET_OE};
    static constexpr GekkoOPInfo divwux  = {"divwux",  OpType::Integer, 19, FL_OUT_D | FL_IN_AB | FL_RC_BIT};
    static constexpr GekkoOPInfo divwuox = {"divwuox", OpType::Integer, 19, FL_OUT_D | FL_IN_AB | FL_RC_BIT | FL_SET_OE};
    static constexpr GekkoOPInfo andx   = {"andx",   OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_RC_BIT};
    static constexpr GekkoOPInfo andcx  = {"andcx",  OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_RC_BIT};
    static constexpr GekkoOPInfo orx    = {"orx",    OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_RC_BIT};
    static constexpr GekkoOPInfo xorx   = {"xorx",   OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_RC_BIT};
    static constexpr GekkoOPInfo norx   = {"norx",   OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_RC_BIT};
    static constexpr GekkoOPInfo slwx   = {"slwx",   OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_RC_BIT};
    static constexpr GekkoOPInfo srwx   = {"srwx",   OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_RC_BIT};
    static constexpr GekkoOPInfo srawx  = {"srawx",  OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_SET_CA | FL_RC_BIT};
    static constexpr GekkoOPInfo srawix = {"srawix", OpType::Integer, 1, FL_OUT_A | FL_IN_S | FL_SET_CA | FL_RC_BIT};
    static constexpr GekkoOPInfo cmp    = {"cmp",    OpType::Integer, 1, FL_IN_AB | FL_SET_CRn};
    // negx (xo=104) — rT = -rA. Encoded with RB=0 unused. Missing from
    // this table caused PPCAnalyzer::Analyze to early-end the block at
    // any neg.; SAB 0x800eb534 (`neg. r5, r5`) self-looped because the
    // following bne+ terminator never made it into the buffer.
    static constexpr GekkoOPInfo negx   = {"negx",   OpType::Integer, 1, FL_OUT_D | FL_IN_A | FL_RC_BIT};
    static constexpr GekkoOPInfo negox  = {"negox",  OpType::Integer, 1, FL_OUT_D | FL_IN_A | FL_RC_BIT | FL_SET_OE};
    static constexpr GekkoOPInfo cmpl   = {"cmpl",   OpType::Integer, 1, FL_IN_AB | FL_SET_CRn};
    static constexpr GekkoOPInfo cntlzwx= {"cntlzwx",OpType::Integer, 1, FL_OUT_A | FL_IN_S | FL_RC_BIT};
    static constexpr GekkoOPInfo extsbx = {"extsbx", OpType::Integer, 1, FL_OUT_A | FL_IN_S | FL_RC_BIT};
    static constexpr GekkoOPInfo extshx = {"extshx", OpType::Integer, 1, FL_OUT_A | FL_IN_S | FL_RC_BIT};
    // Carry-out arithmetic — write XER.CA but don't read it. OE-suffix
    // variants (addcox=522, subfcox=520) additionally set XER.OV/SO.
    static constexpr GekkoOPInfo addcx   = {"addcx",   OpType::Integer, 1, FL_OUT_D | FL_IN_AB | FL_SET_CA | FL_RC_BIT};
    static constexpr GekkoOPInfo addcox  = {"addcox",  OpType::Integer, 1, FL_OUT_D | FL_IN_AB | FL_SET_CA | FL_RC_BIT | FL_SET_OE};
    static constexpr GekkoOPInfo subfcx  = {"subfcx",  OpType::Integer, 1, FL_OUT_D | FL_IN_AB | FL_SET_CA | FL_RC_BIT};
    static constexpr GekkoOPInfo subfcox = {"subfcox", OpType::Integer, 1, FL_OUT_D | FL_IN_AB | FL_SET_CA | FL_RC_BIT | FL_SET_OE};
    // Carry-IN+OUT, single-source arithmetic (RB unused):
    //   addzex (xo=202/714) — rT = rA + CA
    //   addmex (xo=234/746) — rT = rA + CA + (-1)
    //   subfzex (xo=200/712) — rT = ~rA + CA
    //   subfmex (xo=232/744) — rT = ~rA + CA + (-1)
    // Emit handlers existed in ppc_emit.cpp:160-163; opinfo entries below
    // were missing — caused PPCAnalyzer to early-end the block at any such
    // op. SAB SITransferNext-class spin at 0x800ea454 (addze r0, r0) wedged
    // because the block compiled to 1 instruction, then JIT epilogue read
    // ppc_state.pc which never advanced past block start → self-loop.
    // Same class of bug as the negx fix in commit f8c941d.
    static constexpr GekkoOPInfo addzex   = {"addzex",   OpType::Integer, 1, FL_OUT_D | FL_IN_A | FL_READ_CA | FL_SET_CA | FL_RC_BIT};
    static constexpr GekkoOPInfo addzeox  = {"addzeox",  OpType::Integer, 1, FL_OUT_D | FL_IN_A | FL_READ_CA | FL_SET_CA | FL_RC_BIT | FL_SET_OE};
    static constexpr GekkoOPInfo addmex   = {"addmex",   OpType::Integer, 1, FL_OUT_D | FL_IN_A | FL_READ_CA | FL_SET_CA | FL_RC_BIT};
    static constexpr GekkoOPInfo addmeox  = {"addmeox",  OpType::Integer, 1, FL_OUT_D | FL_IN_A | FL_READ_CA | FL_SET_CA | FL_RC_BIT | FL_SET_OE};
    static constexpr GekkoOPInfo subfzex  = {"subfzex",  OpType::Integer, 1, FL_OUT_D | FL_IN_A | FL_READ_CA | FL_SET_CA | FL_RC_BIT};
    static constexpr GekkoOPInfo subfzeox = {"subfzeox", OpType::Integer, 1, FL_OUT_D | FL_IN_A | FL_READ_CA | FL_SET_CA | FL_RC_BIT | FL_SET_OE};
    static constexpr GekkoOPInfo subfmex  = {"subfmex",  OpType::Integer, 1, FL_OUT_D | FL_IN_A | FL_READ_CA | FL_SET_CA | FL_RC_BIT};
    static constexpr GekkoOPInfo subfmeox = {"subfmeox", OpType::Integer, 1, FL_OUT_D | FL_IN_A | FL_READ_CA | FL_SET_CA | FL_RC_BIT | FL_SET_OE};
    // High-half multiply — same operand shape as mullwx; multi-cycle latency.
    static constexpr GekkoOPInfo mulhwx = {"mulhwx", OpType::Integer, 3, FL_OUT_D | FL_IN_AB | FL_RC_BIT};
    static constexpr GekkoOPInfo mulhwux= {"mulhwux",OpType::Integer, 3, FL_OUT_D | FL_IN_AB | FL_RC_BIT};
    // Complemented logical — same shape as andx/orx/xorx.
    static constexpr GekkoOPInfo nandx  = {"nandx",  OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_RC_BIT};
    static constexpr GekkoOPInfo eqvx   = {"eqvx",   OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_RC_BIT};
    static constexpr GekkoOPInfo orcx   = {"orcx",   OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_RC_BIT};
    // Segment-register access / TLB ops — privileged, end-block (MMU recompute).
    static constexpr GekkoOPInfo mtsr   = {"mtsr",   OpType::System,  2, FL_IN_S | FL_PROGRAMEXCEPTION};
    static constexpr GekkoOPInfo mfsr   = {"mfsr",   OpType::System,  1, FL_OUT_D};
    static constexpr GekkoOPInfo mtsrin = {"mtsrin", OpType::System,  2, FL_IN_SB | FL_PROGRAMEXCEPTION};
    static constexpr GekkoOPInfo mfsrin = {"mfsrin", OpType::System,  1, FL_OUT_D | FL_IN_B};
    // FP X-form load/store (lfsx 535, stfsx 663, stfiwx 983). ps0
    // dest/source. FL_OUT_FLOAT_D / FL_IN_FLOAT_S.
    static constexpr GekkoOPInfo lfsx   = {"lfsx",   OpType::LoadFP,  1, FL_OUT_FLOAT_D | FL_IN_A0B | FL_LOADSTORE | FL_USE_FPU};
    static constexpr GekkoOPInfo stfsx  = {"stfsx",  OpType::StoreFP, 1, FL_IN_FLOAT_S  | FL_IN_A0B | FL_LOADSTORE | FL_USE_FPU};
    static constexpr GekkoOPInfo stfiwx = {"stfiwx", OpType::StoreFP, 1, FL_IN_FLOAT_S  | FL_IN_A0B | FL_LOADSTORE | FL_USE_FPU};
    // SPR / MSR.
    static constexpr GekkoOPInfo mfspr  = {"mfspr",  OpType::SPR,     1, FL_OUT_D};
    static constexpr GekkoOPInfo mtspr  = {"mtspr",  OpType::SPR,     2, FL_IN_S | FL_PROGRAMEXCEPTION};
    static constexpr GekkoOPInfo mfmsr  = {"mfmsr",  OpType::System,  1, FL_OUT_D};
    static constexpr GekkoOPInfo mtmsr  = {"mtmsr",  OpType::System,  2, FL_IN_S | FL_SET_MSR | FL_ENDBLOCK | FL_CHECKEXCEPTIONS};
    static constexpr GekkoOPInfo mfcr   = {"mfcr",   OpType::System,  1, FL_OUT_D | FL_READ_ALL_CR};
    static constexpr GekkoOPInfo mtcrf  = {"mtcrf",  OpType::System,  1, FL_IN_S | FL_SET_CRx};
    static constexpr GekkoOPInfo mftb   = {"mftb",   OpType::System,  1, FL_OUT_D | FL_TIMER};
    // Sync / cache.
    static constexpr GekkoOPInfo nop    = {"nop",    OpType::DataCache, 1, 0};
    // icbi is NOT a nop here: our wasm block cache IS the instruction
    // cache. Interp-routed (iCache.Invalidate -> JitInterface -> JitWasm
    // range-evict) and ends the block (Jit64 parity: FallBackToInterpreter
    // + WriteExit — ops after an icbi in the same block could be stale).
    // 2026-06-11 PSO root: the switcher loaded PsoV3.dol over already-
    // compiled first-stage addresses (text0 0x8000c000 overlap), icbi was
    // silent, stale blocks ran at the handoff, switcher fell into PPCHalt.
    static constexpr GekkoOPInfo icbi   = {"icbi",   OpType::DataCache, 1, FL_IN_A0B | FL_ENDBLOCK};
    static constexpr GekkoOPInfo dcbz   = {"dcbz",   OpType::DataCache, 1, FL_IN_A0B | FL_LOADSTORE};
    static constexpr GekkoOPInfo tlbie  = {"tlbie",  OpType::System,    1, FL_IN_B | FL_PROGRAMEXCEPTION};
    // X-form loads/stores (integer).
    static constexpr GekkoOPInfo lwzx   = {"lwzx",   OpType::Load,  1, FL_OUT_D | FL_IN_A0B | FL_LOADSTORE};
    static constexpr GekkoOPInfo lwzux  = {"lwzux",  OpType::Load,  1, FL_OUT_AD | FL_IN_AB | FL_LOADSTORE};
    static constexpr GekkoOPInfo lhzx   = {"lhzx",   OpType::Load,  1, FL_OUT_D | FL_IN_A0B | FL_LOADSTORE};
    static constexpr GekkoOPInfo lhzux  = {"lhzux",  OpType::Load,  1, FL_OUT_AD | FL_IN_AB | FL_LOADSTORE};
    static constexpr GekkoOPInfo lhax   = {"lhax",   OpType::Load,  1, FL_OUT_D | FL_IN_A0B | FL_LOADSTORE};
    static constexpr GekkoOPInfo lhaux  = {"lhaux",  OpType::Load,  1, FL_OUT_AD | FL_IN_AB | FL_LOADSTORE};
    static constexpr GekkoOPInfo lbzx   = {"lbzx",   OpType::Load,  1, FL_OUT_D | FL_IN_A0B | FL_LOADSTORE};
    static constexpr GekkoOPInfo lbzux  = {"lbzux",  OpType::Load,  1, FL_OUT_AD | FL_IN_AB | FL_LOADSTORE};
    static constexpr GekkoOPInfo stwx   = {"stwx",   OpType::Store, 1, FL_IN_S | FL_IN_A0B | FL_LOADSTORE};
    static constexpr GekkoOPInfo stwux  = {"stwux",  OpType::Store, 1, FL_OUT_A | FL_IN_S | FL_IN_AB | FL_LOADSTORE};
    static constexpr GekkoOPInfo sthx   = {"sthx",   OpType::Store, 1, FL_IN_S | FL_IN_A0B | FL_LOADSTORE};
    static constexpr GekkoOPInfo sthux  = {"sthux",  OpType::Store, 1, FL_OUT_A | FL_IN_S | FL_IN_AB | FL_LOADSTORE};
    static constexpr GekkoOPInfo stbx   = {"stbx",   OpType::Store, 1, FL_IN_S | FL_IN_A0B | FL_LOADSTORE};
    static constexpr GekkoOPInfo stbux  = {"stbux",  OpType::Store, 1, FL_OUT_A | FL_IN_S | FL_IN_AB | FL_LOADSTORE};
    // Byte-reversed X-form load/store. Pass-2 audit (w6oeq0l6e RANK 8): these
    // were missing entirely → table31() returned nullptr for any byterev op,
    // marking the block broken at the first lwbrx/lhbrx/stwbrx/sthbrx. Used
    // by VI/DSP/AI MMIO + any little-endian read path. Dispatch falls back to
    // emit_fallback (no native byterev emitter); analyzer just needs the
    // opinfo to keep blocks intact.
    static constexpr GekkoOPInfo lwbrx  = {"lwbrx",  OpType::Load,  1, FL_OUT_D | FL_IN_A0B | FL_LOADSTORE};
    static constexpr GekkoOPInfo lhbrx  = {"lhbrx",  OpType::Load,  1, FL_OUT_D | FL_IN_A0B | FL_LOADSTORE};
    static constexpr GekkoOPInfo stwbrx = {"stwbrx", OpType::Store, 1, FL_IN_S | FL_IN_A0B | FL_LOADSTORE};
    static constexpr GekkoOPInfo sthbrx = {"sthbrx", OpType::Store, 1, FL_IN_S | FL_IN_A0B | FL_LOADSTORE};
    // tw (xo=4) per dolphin-src PPCTables.cpp:380 — trap-word, ENDBLOCK so analyzer
    // terminates the block; matches Dolphin flag set verbatim.
    static constexpr GekkoOPInfo tw = {"tw", OpType::System, 2, FL_IN_A | FL_IN_B | FL_ENDBLOCK};
    // Reservation pair lwarx/stwcxd — single-CPU emu so the reservation is
    // trivially honored. Analyzer needs the flag set to bind A0/B/S/D and
    // SET_CR0 (stwcx. writes CR0). dolphin-src PPCTables.cpp:325/324.
    static constexpr GekkoOPInfo lwarx = {"lwarx", OpType::Load, 1, FL_OUT_D | FL_IN_A0 | FL_IN_B | FL_SET_CR0 | FL_LOADSTORE};
    static constexpr GekkoOPInfo stwcxd = {"stwcxd", OpType::Store, 1, FL_IN_S | FL_IN_A0 | FL_IN_B | FL_SET_CR0 | FL_LOADSTORE};
    // External-control I/O — eciwx/ecowx (xo=310/438) per dolphin-src
    // PPCTables.cpp:385/386. SystemType — modeled as Load/Store-shaped but
    // tagged System; analyzer just needs reg-flow for A0/B and D/S.
    static constexpr GekkoOPInfo eciwx = {"eciwx", OpType::System, 1, FL_IN_A0 | FL_IN_B | FL_OUT_D | FL_LOADSTORE};
    static constexpr GekkoOPInfo ecowx = {"ecowx", OpType::System, 1, FL_IN_A0 | FL_IN_B | FL_IN_S | FL_LOADSTORE};
    // mcrxr (xo=512) per dolphin-src PPCTables.cpp:376 — moves XER[0..3] to
    // CRn then clears XER[0..3]. Reads + writes CA, sets CRn.
    static constexpr GekkoOPInfo mcrxr = {"mcrxr", OpType::System, 1, FL_SET_CRn | FL_READ_CA | FL_SET_CA};
    // String load/store family — lswx/lswi/stswx/stswi per dolphin-src
    // PPCTables.cpp:328/329/347/348. NB register count comes from XER[25..31]
    // for the X-form (lswx/stswx) and from inst.NB for the I-form.
    static constexpr GekkoOPInfo lswx = {"lswx", OpType::Load, 1, FL_IN_A0 | FL_IN_B | FL_OUT_D | FL_LOADSTORE};
    static constexpr GekkoOPInfo lswi = {"lswi", OpType::Load, 1, FL_IN_A0 | FL_OUT_D | FL_LOADSTORE};
    static constexpr GekkoOPInfo stswx = {"stswx", OpType::Store, 1, FL_IN_A0 | FL_IN_B | FL_LOADSTORE};
    static constexpr GekkoOPInfo stswi = {"stswi", OpType::Store, 1, FL_IN_A0 | FL_LOADSTORE};
    // tlbsync (xo=566) per dolphin-src PPCTables.cpp:389 — privileged, TLB
    // sync; analyzer marks PROGRAMEXCEPTION to inhibit speculation across.
    static constexpr GekkoOPInfo tlbsync = {"tlbsync", OpType::System, 1, FL_PROGRAMEXCEPTION};
    // FP X-form load/store update family — lfsux/lfdx/lfdux/stfsux/stfdx/stfdux
    // per dolphin-src PPCTables.cpp:352/354/355/359/361/362. Match the
    // existing lfsx/stfsx/stfiwx flag shape; update forms add FL_OUT_A.
    static constexpr GekkoOPInfo lfsux = {"lfsux", OpType::LoadFP, 1, FL_OUT_FLOAT_D | FL_IN_A | FL_IN_B | FL_OUT_A | FL_USE_FPU | FL_LOADSTORE};
    static constexpr GekkoOPInfo lfdx = {"lfdx", OpType::LoadFP, 1, FL_IN_FLOAT_D | FL_OUT_FLOAT_D | FL_IN_A0 | FL_IN_B | FL_USE_FPU | FL_LOADSTORE};
    static constexpr GekkoOPInfo lfdux = {"lfdux", OpType::LoadFP, 1, FL_IN_FLOAT_D | FL_OUT_FLOAT_D | FL_IN_A | FL_IN_B | FL_OUT_A | FL_USE_FPU | FL_LOADSTORE};
    static constexpr GekkoOPInfo stfsux = {"stfsux", OpType::StoreFP, 1, FL_IN_FLOAT_S | FL_IN_A | FL_IN_B | FL_OUT_A | FL_USE_FPU | FL_LOADSTORE};
    static constexpr GekkoOPInfo stfdx = {"stfdx", OpType::StoreFP, 1, FL_IN_FLOAT_S | FL_IN_A0 | FL_IN_B | FL_USE_FPU | FL_LOADSTORE};
    static constexpr GekkoOPInfo stfdux = {"stfdux", OpType::StoreFP, 1, FL_IN_FLOAT_S | FL_IN_A | FL_IN_B | FL_OUT_A | FL_USE_FPU | FL_LOADSTORE};
    // dcba (xo=758) per dolphin-src PPCTables.cpp:300 — data cache block
    // allocate; classified DataCache with 5-cycle cost, no reg-flow flags.
    static constexpr GekkoOPInfo dcba = {"dcba", OpType::DataCache, 5, 0};

    switch (sub10) {
    case 266: return &addx;
    case 778: return &addox;
    case 40:  return &subfx;
    case 552: return &subfox;
    case 138: return &addex;
    case 650: return &addeox;
    case 136: return &subfex;
    case 648: return &subfeox;
    case 235: return &mullwx;
    case 747: return &mullwox;
    case 491: return &divwx;
    case 1003: return &divwox;
    case 459: return &divwux;
    case 971: return &divwuox;
    // negx (xo=104) / negox (xo=616 = 104 | OE_BIT). emit_negx handles OE
    // internally. Pass-2 audit (w6oeq0l6e RANK 7): previously mapped to 360
    // — that's an unused encoding; xo=616 falls through to nullptr → analyzer
    // breaks block + sets m_broken. Confirmed against
    // ~/gc_refs/dolphin-upstream/Source/Core/Core/PowerPC/PPCTables.cpp:262
    // and Interpreter_Tables.cpp:174.
    case 104: return &negx;
    case 616: return &negox;
    // Carry-out arith — OE variants set XER.OV/SO too.
    case 10:  return &addcx;
    case 522: return &addcox;
    case 8:   return &subfcx;
    case 520: return &subfcox;
    // Carry-in/out single-source (matching emit_addzex/addmex/subfzex/subfmex).
    case 202: return &addzex;
    case 714: return &addzeox;
    case 234: return &addmex;
    case 746: return &addmeox;
    case 200: return &subfzex;
    case 712: return &subfzeox;
    case 232: return &subfmex;
    case 744: return &subfmeox;
    case 75:  return &mulhwx;
    case 11:  return &mulhwux;
    case 28:  return &andx;
    case 60:  return &andcx;
    case 444: return &orx;
    case 316: return &xorx;
    case 124: return &norx;
    case 476: return &nandx;
    case 284: return &eqvx;
    case 412: return &orcx;
    case 24:  return &slwx;
    case 536: return &srwx;
    case 792: return &srawx;
    case 824: return &srawix;
    case 0:   return &cmp;
    case 32:  return &cmpl;
    case 26:  return &cntlzwx;
    case 954: return &extsbx;
    case 922: return &extshx;
    case 339: return &mfspr;
    case 467: return &mtspr;
    case 83:  return &mfmsr;
    case 146: return &mtmsr;
    case 19:  return &mfcr;
    case 144: return &mtcrf;
    case 371: return &mftb;
    // Sync + DATA-cache control / hints — classify as nop here:
    //   598 sync, 854 eieio, 86 dcbf, 54 dcbst, 470 dcbi, 278 dcbt,
    //   246 dcbtst. No real data cache in the linear-memory model.
    case 598: case 854:
    case 86:  case 54:  case 470:
    case 278: case 246:
        return &nop;
    case 982: return &icbi;  // NOT a nop — see opinfo comment above.
    case 1014: return &dcbz;
    case 306: return &tlbie;
    // Segment-register access — privileged, end-block.
    case 210: return &mtsr;
    case 242: return &mtsrin;
    case 595: return &mfsr;
    case 659: return &mfsrin;
    case 23:  return &lwzx;
    case 55:  return &lwzux;
    case 279: return &lhzx;
    case 311: return &lhzux;
    case 343: return &lhax;
    case 375: return &lhaux;
    case 87:  return &lbzx;
    case 119: return &lbzux;
    case 151: return &stwx;
    case 183: return &stwux;
    case 407: return &sthx;
    case 439: return &sthux;
    case 215: return &stbx;
    case 247: return &stbux;
    // Byte-reversed integer X-form load/store.
    case 534: return &lwbrx;
    case 662: return &stwbrx;
    case 790: return &lhbrx;
    case 918: return &sthbrx;
    // FP X-form load/store.
    case 535: return &lfsx;
    case 663: return &stfsx;
    case 983: return &stfiwx;
    // tw (xo=4) per dolphin-src PPCTables.cpp:380.
    case 4: return &tw;
    // Reservation pair lwarx/stwcxd per dolphin-src PPCTables.cpp:325/324.
    case 20: return &lwarx;
    case 150: return &stwcxd;
    // External-control I/O — eciwx/ecowx per dolphin-src PPCTables.cpp:385/386.
    case 310: return &eciwx;
    case 438: return &ecowx;
    // mcrxr per dolphin-src PPCTables.cpp:376.
    case 512: return &mcrxr;
    // String load/store family per dolphin-src PPCTables.cpp:328/329/347/348.
    case 533: return &lswx;
    case 597: return &lswi;
    case 661: return &stswx;
    case 725: return &stswi;
    // tlbsync per dolphin-src PPCTables.cpp:389.
    case 566: return &tlbsync;
    // FP X-form load/store update family per dolphin-src
    // PPCTables.cpp:352/354/355/359/361/362.
    case 567: return &lfsux;
    case 599: return &lfdx;
    case 631: return &lfdux;
    case 695: return &stfsux;
    case 727: return &stfdx;
    case 759: return &stfdux;
    // dcba per dolphin-src PPCTables.cpp:300.
    case 758: return &dcba;
    default:  return nullptr;
    }
}

// Table 4 — paired-singles. Canonical: dolphin-upstream PPCTables.cpp
// s_table4 (SUBOP10-keyed), s_table4_2 (SUBOP5-keyed PS arith), s_table4_3
// (low-6-bit-keyed psq_lx/stx/lux/stux). Dispatch order matches Dolphin's
// table-fill scheme: SUBOP10 hits first (single op codes), then SUBOP5
// (PS arith with rC in bits 21..25), then low-6 (psq_*x with W field in
// bits 6..9).
static const GekkoOPInfo* table4(u32 inst, u32 sub10) {
    // ---- SUBOP10 entries (s_table4 in Dolphin) ----
    static constexpr GekkoOPInfo ps_cmpu0   = {"ps_cmpu0", OpType::PS, 1,
        FL_IN_FLOAT_AB | FL_SET_CRn | FL_USE_FPU | FL_READ_FPRF | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo ps_cmpo0   = {"ps_cmpo0", OpType::PS, 1,
        FL_IN_FLOAT_AB | FL_SET_CRn | FL_USE_FPU | FL_READ_FPRF | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo ps_cmpu1   = {"ps_cmpu1", OpType::PS, 1,
        FL_IN_FLOAT_AB | FL_SET_CRn | FL_USE_FPU | FL_READ_FPRF | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo ps_cmpo1   = {"ps_cmpo1", OpType::PS, 1,
        FL_IN_FLOAT_AB | FL_SET_CRn | FL_USE_FPU | FL_READ_FPRF | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo ps_neg     = {"ps_neg", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_B | FL_IN_FLOAT_B_BITEXACT | FL_RC_BIT_F |
        FL_USE_FPU | FL_PROGRAMEXCEPTION};
    static constexpr GekkoOPInfo ps_nabs    = {"ps_nabs", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_B | FL_IN_FLOAT_B_BITEXACT | FL_RC_BIT_F |
        FL_USE_FPU | FL_PROGRAMEXCEPTION};
    static constexpr GekkoOPInfo ps_abs     = {"ps_abs", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_B | FL_IN_FLOAT_B_BITEXACT | FL_RC_BIT_F |
        FL_USE_FPU | FL_PROGRAMEXCEPTION};
    static constexpr GekkoOPInfo ps_mr      = {"ps_mr", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_B | FL_IN_FLOAT_B_BITEXACT | FL_RC_BIT_F |
        FL_USE_FPU | FL_PROGRAMEXCEPTION};
    static constexpr GekkoOPInfo ps_merge00 = {"ps_merge00", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_AB | FL_IN_FLOAT_AB_BITEXACT | FL_RC_BIT_F |
        FL_USE_FPU | FL_PROGRAMEXCEPTION};
    static constexpr GekkoOPInfo ps_merge01 = {"ps_merge01", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_AB | FL_IN_FLOAT_AB_BITEXACT | FL_RC_BIT_F |
        FL_USE_FPU | FL_PROGRAMEXCEPTION};
    static constexpr GekkoOPInfo ps_merge10 = {"ps_merge10", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_AB | FL_IN_FLOAT_AB_BITEXACT | FL_RC_BIT_F |
        FL_USE_FPU | FL_PROGRAMEXCEPTION};
    static constexpr GekkoOPInfo ps_merge11 = {"ps_merge11", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_AB | FL_IN_FLOAT_AB_BITEXACT | FL_RC_BIT_F |
        FL_USE_FPU | FL_PROGRAMEXCEPTION};
    static constexpr GekkoOPInfo dcbz_l     = {"dcbz_l", OpType::System, 1,
        FL_IN_A0B | FL_LOADSTORE | FL_PROGRAMEXCEPTION};

    switch (sub10) {
    case 0:    return &ps_cmpu0;
    case 32:   return &ps_cmpo0;
    case 64:   return &ps_cmpu1;
    case 96:   return &ps_cmpo1;
    case 40:   return &ps_neg;
    case 136:  return &ps_nabs;
    case 264:  return &ps_abs;
    case 72:   return &ps_mr;
    case 528:  return &ps_merge00;
    case 560:  return &ps_merge01;
    case 592:  return &ps_merge10;
    case 624:  return &ps_merge11;
    case 1014: return &dcbz_l;
    default:   break;
    }

    // ---- SUBOP5 entries (s_table4_2 in Dolphin) — PS arith ----
    // Dolphin fills these across all 32 SUBOP10 patterns with the same
    // upper-5-bit identifier (matches by SUBOP5 = bits 1..5, the lower 5
    // of SUBOP10). Equivalent to (sub10 & 0x1F) match.
    static constexpr GekkoOPInfo ps_sum0   = {"ps_sum0", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo ps_sum1   = {"ps_sum1", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo ps_muls0  = {"ps_muls0", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_AC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo ps_muls1  = {"ps_muls1", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_AC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo ps_madds0 = {"ps_madds0", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo ps_madds1 = {"ps_madds1", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo ps_div    = {"ps_div", OpType::PS, 17,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_AB | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION | FL_FLOAT_DIV};
    static constexpr GekkoOPInfo ps_sub    = {"ps_sub", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_AB | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo ps_add    = {"ps_add", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_AB | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo ps_sel    = {"ps_sel", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_IN_FLOAT_BC_BITEXACT | FL_RC_BIT_F |
        FL_USE_FPU | FL_PROGRAMEXCEPTION};
    static constexpr GekkoOPInfo ps_res    = {"ps_res", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_B | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION | FL_FLOAT_DIV};
    static constexpr GekkoOPInfo ps_mul    = {"ps_mul", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_AC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo ps_rsqrte = {"ps_rsqrte", OpType::PS, 2,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_B | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION | FL_FLOAT_DIV};
    static constexpr GekkoOPInfo ps_msub   = {"ps_msub", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo ps_madd   = {"ps_madd", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo ps_nmsub  = {"ps_nmsub", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo ps_nmadd  = {"ps_nmadd", OpType::PS, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_PROGRAMEXCEPTION | FL_FLOAT_EXCEPTION};

    const u32 sub5 = sub10 & 0x1F;
    switch (sub5) {
    case 10: return &ps_sum0;
    case 11: return &ps_sum1;
    case 12: return &ps_muls0;
    case 13: return &ps_muls1;
    case 14: return &ps_madds0;
    case 15: return &ps_madds1;
    case 18: return &ps_div;
    case 20: return &ps_sub;
    case 21: return &ps_add;
    case 23: return &ps_sel;
    case 24: return &ps_res;
    case 25: return &ps_mul;
    case 26: return &ps_rsqrte;
    case 28: return &ps_msub;
    case 29: return &ps_madd;
    case 30: return &ps_nmsub;
    case 31: return &ps_nmadd;
    default: break;
    }

    // ---- low-6-bit entries (s_table4_3 in Dolphin) — psq_*x indexed ----
    // Dolphin fills these across all 16 (i << 6) patterns with the same
    // low-6-bit identifier. Equivalent to (sub10 & 0x3F) match.
    static constexpr GekkoOPInfo psq_lx    = {"psq_lx", OpType::LoadPS, 1,
        FL_OUT_FLOAT_D | FL_IN_A0B | FL_USE_FPU | FL_LOADSTORE};
    static constexpr GekkoOPInfo psq_stx   = {"psq_stx", OpType::StorePS, 1,
        FL_IN_FLOAT_S | FL_IN_A0B | FL_USE_FPU | FL_LOADSTORE};
    static constexpr GekkoOPInfo psq_lux   = {"psq_lux", OpType::LoadPS, 1,
        FL_OUT_FLOAT_D | FL_OUT_A | FL_IN_AB | FL_USE_FPU | FL_LOADSTORE};
    static constexpr GekkoOPInfo psq_stux  = {"psq_stux", OpType::StorePS, 1,
        FL_IN_FLOAT_S | FL_OUT_A | FL_IN_AB | FL_USE_FPU | FL_LOADSTORE};

    const u32 sub6 = sub10 & 0x3F;
    switch (sub6) {
    case 6:  return &psq_lx;
    case 7:  return &psq_stx;
    case 38: return &psq_lux;
    case 39: return &psq_stux;
    default: return nullptr;
    }
}

// Table 59 — single-precision FP arith (SUBOP5-keyed; 4-operand ops carry
// rC in bits 21..25 so SUBOP10 would vary with rC). Canonical: dolphin-
// upstream PPCTables.cpp s_table59.
static const GekkoOPInfo* table59(u32 sub5) {
    static constexpr GekkoOPInfo fdivsx   = {"fdivsx", OpType::SingleFP, 17,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_AB | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION | FL_FLOAT_DIV};
    static constexpr GekkoOPInfo fsubsx   = {"fsubsx", OpType::SingleFP, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_AB | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo faddsx   = {"faddsx", OpType::SingleFP, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_AB | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo fresx    = {"fresx", OpType::SingleFP, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_B | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION | FL_FLOAT_DIV};
    static constexpr GekkoOPInfo fmulsx   = {"fmulsx", OpType::SingleFP, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_AC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo fmsubsx  = {"fmsubsx", OpType::SingleFP, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo fmaddsx  = {"fmaddsx", OpType::SingleFP, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo fnmsubsx = {"fnmsubsx", OpType::SingleFP, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo fnmaddsx = {"fnmaddsx", OpType::SingleFP, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};

    switch (sub5) {
    case 18: return &fdivsx;
    case 20: return &fsubsx;
    case 21: return &faddsx;
    case 24: return &fresx;
    case 25: return &fmulsx;
    case 28: return &fmsubsx;
    case 29: return &fmaddsx;
    case 30: return &fnmsubsx;
    case 31: return &fnmaddsx;
    default: return nullptr;
    }
}

// Table 63 — double-precision FP + system-FP. Dolphin uses SUBOP10 for
// the s_table63 entries (single-purpose ops) AND for s_table63_2 entries
// (4-operand ops with rC in bits 21..25). s_table63_2 fills the table
// across all 32 (i<<5) patterns with the same SUBOP5 — equivalent to
// (sub10 & 0x1F) lookup. Canonical: dolphin-upstream PPCTables.cpp
// s_table63 + s_table63_2 + GetOpInfo dispatch.
static const GekkoOPInfo* table63(u32 sub10) {
    // ---- SUBOP10-keyed (single-purpose ops, s_table63 in Dolphin) ----
    static constexpr GekkoOPInfo fabsx    = {"fabsx", OpType::DoubleFP, 1,
        FL_INOUT_FLOAT_D | FL_IN_FLOAT_B | FL_IN_FLOAT_B_BITEXACT | FL_RC_BIT_F |
        FL_USE_FPU};
    static constexpr GekkoOPInfo fcmpu    = {"fcmpu", OpType::DoubleFP, 1,
        FL_IN_FLOAT_AB | FL_SET_CRn | FL_USE_FPU | FL_READ_FPRF | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo fcmpo    = {"fcmpo", OpType::DoubleFP, 1,
        FL_IN_FLOAT_AB | FL_SET_CRn | FL_USE_FPU | FL_READ_FPRF | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo fctiwx   = {"fctiwx", OpType::DoubleFP, 1,
        FL_INOUT_FLOAT_D | FL_IN_FLOAT_B | FL_RC_BIT_F | FL_USE_FPU |
        FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo fctiwzx  = {"fctiwzx", OpType::DoubleFP, 1,
        FL_INOUT_FLOAT_D | FL_IN_FLOAT_B | FL_RC_BIT_F | FL_USE_FPU |
        FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo fmrx     = {"fmrx", OpType::DoubleFP, 1,
        FL_INOUT_FLOAT_D | FL_IN_FLOAT_B | FL_IN_FLOAT_B_BITEXACT | FL_RC_BIT_F |
        FL_USE_FPU};
    static constexpr GekkoOPInfo fnabsx   = {"fnabsx", OpType::DoubleFP, 1,
        FL_INOUT_FLOAT_D | FL_IN_FLOAT_B | FL_RC_BIT_F | FL_IN_FLOAT_B_BITEXACT |
        FL_USE_FPU};
    static constexpr GekkoOPInfo fnegx    = {"fnegx", OpType::DoubleFP, 1,
        FL_INOUT_FLOAT_D | FL_IN_FLOAT_B | FL_RC_BIT_F | FL_IN_FLOAT_B_BITEXACT |
        FL_USE_FPU};
    static constexpr GekkoOPInfo frspx    = {"frspx", OpType::DoubleFP, 1,
        FL_OUT_FLOAT_D | FL_IN_FLOAT_B | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};
    // System-FP — mcrfs / mffsx / mtfsb0x / mtfsb1x / mtfsfix / mtfsfx.
    // OSContext.c:598 uses `mffs fp0` to read FPSCR; OSContext.c:566 stfd
    // chains DO NOT use these but a downstream OSReport float-print may.
    static constexpr GekkoOPInfo mcrfs    = {"mcrfs", OpType::SystemFP, 1,
        FL_SET_CRn | FL_USE_FPU | FL_READ_FPRF};
    static constexpr GekkoOPInfo mffsx    = {"mffsx", OpType::SystemFP, 1,
        FL_RC_BIT_F | FL_INOUT_FLOAT_D | FL_USE_FPU | FL_READ_FPRF};
    static constexpr GekkoOPInfo mtfsb0x  = {"mtfsb0x", OpType::SystemFP, 3,
        FL_RC_BIT_F | FL_USE_FPU | FL_READ_FPRF | FL_SET_FPRF};
    static constexpr GekkoOPInfo mtfsb1x  = {"mtfsb1x", OpType::SystemFP, 3,
        FL_RC_BIT_F | FL_USE_FPU | FL_READ_FPRF | FL_SET_FPRF | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo mtfsfix  = {"mtfsfix", OpType::SystemFP, 3,
        FL_RC_BIT_F | FL_USE_FPU | FL_READ_FPRF | FL_SET_FPRF | FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo mtfsfx   = {"mtfsfx", OpType::SystemFP, 3,
        FL_RC_BIT_F | FL_IN_FLOAT_B | FL_USE_FPU | FL_READ_FPRF | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};

    switch (sub10) {
    case 264: return &fabsx;
    case 0:   return &fcmpu;
    case 32:  return &fcmpo;
    case 14:  return &fctiwx;
    case 15:  return &fctiwzx;
    case 72:  return &fmrx;
    case 136: return &fnabsx;
    case 40:  return &fnegx;
    case 12:  return &frspx;
    case 64:  return &mcrfs;
    case 583: return &mffsx;
    case 70:  return &mtfsb0x;
    case 38:  return &mtfsb1x;
    case 134: return &mtfsfix;
    case 711: return &mtfsfx;
    default:  break;
    }

    // ---- SUBOP5-keyed (4-operand arith, s_table63_2 in Dolphin) ----
    static constexpr GekkoOPInfo fdivx   = {"fdivx", OpType::DoubleFP, 31,
        FL_INOUT_FLOAT_D | FL_IN_FLOAT_AB | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION | FL_FLOAT_DIV};
    static constexpr GekkoOPInfo fsubx   = {"fsubx", OpType::DoubleFP, 1,
        FL_INOUT_FLOAT_D | FL_IN_FLOAT_AB | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo faddx   = {"faddx", OpType::DoubleFP, 1,
        FL_INOUT_FLOAT_D | FL_IN_FLOAT_AB | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo fselx   = {"fselx", OpType::DoubleFP, 1,
        FL_INOUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_IN_FLOAT_BC_BITEXACT | FL_RC_BIT_F |
        FL_USE_FPU};
    static constexpr GekkoOPInfo fmulx   = {"fmulx", OpType::DoubleFP, 1,
        FL_INOUT_FLOAT_D | FL_IN_FLOAT_AC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo frsqrtex= {"frsqrtex", OpType::DoubleFP, 1,
        FL_INOUT_FLOAT_D | FL_IN_FLOAT_B | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION | FL_FLOAT_DIV};
    static constexpr GekkoOPInfo fmsubx  = {"fmsubx", OpType::DoubleFP, 1,
        FL_INOUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo fmaddx  = {"fmaddx", OpType::DoubleFP, 1,
        FL_INOUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo fnmsubx = {"fnmsubx", OpType::DoubleFP, 1,
        FL_INOUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};
    static constexpr GekkoOPInfo fnmaddx = {"fnmaddx", OpType::DoubleFP, 1,
        FL_INOUT_FLOAT_D | FL_IN_FLOAT_ABC | FL_RC_BIT_F | FL_USE_FPU | FL_SET_FPRF |
        FL_FLOAT_EXCEPTION};

    const u32 sub5 = sub10 & 0x1F;
    switch (sub5) {
    case 18: return &fdivx;
    case 20: return &fsubx;
    case 21: return &faddx;
    case 23: return &fselx;
    case 25: return &fmulx;
    case 26: return &frsqrtex;
    case 28: return &fmsubx;
    case 29: return &fmaddx;
    case 30: return &fnmsubx;
    case 31: return &fnmaddx;
    default: return nullptr;
    }
}

}  // namespace

const GekkoOPInfo* lookup_op_info(u32 inst, u32 /*pc*/) {
    const u32 opcd = GekkoOperands::OPCD(inst);
    const GekkoOPInfo& primary = PRIMARY[opcd];
    if (primary.type == OpType::Invalid)  return nullptr;
    if (primary.type != OpType::Subtable) return &primary;

    const u32 sub10 = GekkoOperands::SUBOP10(inst);
    switch (opcd) {
    case 4:  return table4(inst, sub10);
    case 19: return table19(sub10);
    case 31: return table31(sub10);
    case 59: return table59(GekkoOperands::SUBOP5(inst));
    case 63: return table63(sub10);
    default:
        return nullptr;
    }
}

}  // namespace bemental::powerpc

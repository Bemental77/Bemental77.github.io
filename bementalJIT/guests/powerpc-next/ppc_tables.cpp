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
    /* 03 */ {"twi",       OpType::System,    1, FL_IN_A | FL_PROGRAMEXCEPTION},
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
    // ADD family (Rc and OE variants share the same metadata for analysis).
    static constexpr GekkoOPInfo addx   = {"addx",   OpType::Integer, 1, FL_OUT_D | FL_IN_AB | FL_RC_BIT};
    static constexpr GekkoOPInfo subfx  = {"subfx",  OpType::Integer, 1, FL_OUT_D | FL_IN_AB | FL_RC_BIT};
    static constexpr GekkoOPInfo addex  = {"addex",  OpType::Integer, 1, FL_OUT_D | FL_IN_AB | FL_READ_CA | FL_SET_CA | FL_RC_BIT};
    static constexpr GekkoOPInfo subfex = {"subfex", OpType::Integer, 1, FL_OUT_D | FL_IN_AB | FL_READ_CA | FL_SET_CA | FL_RC_BIT};
    static constexpr GekkoOPInfo mullwx = {"mullwx", OpType::Integer, 3, FL_OUT_D | FL_IN_AB | FL_RC_BIT};
    static constexpr GekkoOPInfo divwx  = {"divwx",  OpType::Integer, 19, FL_OUT_D | FL_IN_AB | FL_RC_BIT | FL_FLOAT_DIV};
    static constexpr GekkoOPInfo divwux = {"divwux", OpType::Integer, 19, FL_OUT_D | FL_IN_AB | FL_RC_BIT | FL_FLOAT_DIV};
    static constexpr GekkoOPInfo andx   = {"andx",   OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_RC_BIT};
    static constexpr GekkoOPInfo orx    = {"orx",    OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_RC_BIT};
    static constexpr GekkoOPInfo xorx   = {"xorx",   OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_RC_BIT};
    static constexpr GekkoOPInfo norx   = {"norx",   OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_RC_BIT};
    static constexpr GekkoOPInfo slwx   = {"slwx",   OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_RC_BIT};
    static constexpr GekkoOPInfo srwx   = {"srwx",   OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_RC_BIT};
    static constexpr GekkoOPInfo srawx  = {"srawx",  OpType::Integer, 1, FL_OUT_A | FL_IN_SB | FL_SET_CA | FL_RC_BIT};
    static constexpr GekkoOPInfo srawix = {"srawix", OpType::Integer, 1, FL_OUT_A | FL_IN_S | FL_SET_CA | FL_RC_BIT};
    static constexpr GekkoOPInfo cmp    = {"cmp",    OpType::Integer, 1, FL_IN_AB | FL_SET_CRn};
    static constexpr GekkoOPInfo cmpl   = {"cmpl",   OpType::Integer, 1, FL_IN_AB | FL_SET_CRn};
    static constexpr GekkoOPInfo cntlzwx= {"cntlzwx",OpType::Integer, 1, FL_OUT_A | FL_IN_S | FL_RC_BIT};
    static constexpr GekkoOPInfo extsbx = {"extsbx", OpType::Integer, 1, FL_OUT_A | FL_IN_S | FL_RC_BIT};
    static constexpr GekkoOPInfo extshx = {"extshx", OpType::Integer, 1, FL_OUT_A | FL_IN_S | FL_RC_BIT};
    // SPR / MSR.
    static constexpr GekkoOPInfo mfspr  = {"mfspr",  OpType::SPR,     1, FL_OUT_D};
    static constexpr GekkoOPInfo mtspr  = {"mtspr",  OpType::SPR,     2, FL_IN_S};
    static constexpr GekkoOPInfo mfmsr  = {"mfmsr",  OpType::System,  1, FL_OUT_D};
    static constexpr GekkoOPInfo mtmsr  = {"mtmsr",  OpType::System,  2, FL_IN_S | FL_SET_MSR | FL_ENDBLOCK | FL_CHECKEXCEPTIONS};
    static constexpr GekkoOPInfo mfcr   = {"mfcr",   OpType::System,  1, FL_OUT_D | FL_READ_ALL_CR};
    static constexpr GekkoOPInfo mtcrf  = {"mtcrf",  OpType::System,  1, FL_IN_S | FL_SET_CRx};
    static constexpr GekkoOPInfo mftb   = {"mftb",   OpType::System,  1, FL_OUT_D | FL_TIMER};
    // Sync / cache.
    static constexpr GekkoOPInfo nop    = {"nop",    OpType::DataCache, 1, 0};
    static constexpr GekkoOPInfo dcbz   = {"dcbz",   OpType::DataCache, 1, FL_IN_A0B | FL_LOADSTORE};
    static constexpr GekkoOPInfo tlbie  = {"tlbie",  OpType::System,    1, FL_IN_B | FL_ENDBLOCK};
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

    switch (sub10) {
    case 266: case 778: return &addx;
    case 40:  case 552: return &subfx;
    case 138: case 650: return &addex;
    case 136: case 648: return &subfex;
    case 235: case 747: return &mullwx;
    case 491: case 1003: return &divwx;
    case 459: case 971: return &divwux;
    case 28:  return &andx;
    case 444: return &orx;
    case 316: return &xorx;
    case 124: return &norx;
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
    case 598: case 854: case 982: return &nop;  // sync / eieio / icbi (no flow effect)
    case 1014: return &dcbz;
    case 306: return &tlbie;
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
    default:  return nullptr;
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
    case 19: return table19(sub10);
    case 31: return table31(sub10);
    // Phase 1 stubs — table4 (PS), table59 (FP single), table63 (FP double)
    // not yet populated. Analyzer treats unknown encodings as block-broken;
    // that's the safe default until Phase 4 ships the FP / PS port.
    case 4:
    case 59:
    case 63:
    default:
        return nullptr;
    }
}

}  // namespace bemental::powerpc

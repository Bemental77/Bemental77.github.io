#pragma once
//
// GekkoOPInfo / InstructionFlags / OpType — ported from Dolphin's
// Source/Core/Core/PowerPC/PPCTables.h (GPL-2.0-or-later). The opcode
// dispatch table data lives in ppc_tables.cpp; this header defines the
// types those entries use.

#include "bementalJIT/types.h"

namespace bemental::powerpc {

enum InstructionFlags : u64 {
    FL_SET_CR0        = (1ull << 0),
    FL_SET_CR1        = (1ull << 1),
    FL_SET_CRn        = (1ull << 2),
    FL_SET_CA         = (1ull << 3),
    FL_READ_CA        = (1ull << 4),
    FL_RC_BIT         = (1ull << 5),
    FL_RC_BIT_F       = (1ull << 6),
    FL_ENDBLOCK       = (1ull << 7),
    FL_IN_A           = (1ull << 8),
    FL_IN_A0          = (1ull << 9),  // rA-or-zero: when rA==0, value is literal 0.
    FL_IN_B           = (1ull << 10),
    FL_IN_C           = (1ull << 11),
    FL_IN_S           = (1ull << 12),
    FL_IN_AB          = FL_IN_A | FL_IN_B,
    FL_IN_AC          = FL_IN_A | FL_IN_C,
    FL_IN_ABC         = FL_IN_A | FL_IN_B | FL_IN_C,
    FL_IN_SB          = FL_IN_S | FL_IN_B,
    FL_IN_A0B         = FL_IN_A0 | FL_IN_B,
    FL_IN_A0BC        = FL_IN_A0 | FL_IN_B | FL_IN_C,
    FL_OUT_D          = (1ull << 13),
    FL_OUT_A          = (1ull << 14),
    FL_OUT_AD         = FL_OUT_A | FL_OUT_D,
    FL_TIMER          = (1ull << 15),
    FL_CHECKEXCEPTIONS= (1ull << 16),
    FL_NO_REORDER     = (1ull << 17),
    FL_USE_FPU        = (1ull << 18),
    FL_LOADSTORE      = (1ull << 19),
    FL_SET_FPRF       = (1ull << 20),
    FL_READ_FPRF      = (1ull << 21),
    FL_SET_OE         = (1ull << 22),
    FL_IN_FLOAT_A     = (1ull << 23),
    FL_IN_FLOAT_B     = (1ull << 24),
    FL_IN_FLOAT_C     = (1ull << 25),
    FL_IN_FLOAT_S     = (1ull << 26),
    FL_IN_FLOAT_D     = (1ull << 27),
    FL_IN_FLOAT_AB    = FL_IN_FLOAT_A | FL_IN_FLOAT_B,
    FL_IN_FLOAT_AC    = FL_IN_FLOAT_A | FL_IN_FLOAT_C,
    FL_IN_FLOAT_ABC   = FL_IN_FLOAT_A | FL_IN_FLOAT_B | FL_IN_FLOAT_C,
    FL_OUT_FLOAT_D    = (1ull << 28),
    FL_INOUT_FLOAT_D  = FL_IN_FLOAT_D | FL_OUT_FLOAT_D,
    FL_IN_FLOAT_A_BITEXACT  = (1ull << 29),
    FL_IN_FLOAT_B_BITEXACT  = (1ull << 30),
    FL_IN_FLOAT_C_BITEXACT  = (1ull << 31),
    FL_IN_FLOAT_AB_BITEXACT = FL_IN_FLOAT_A_BITEXACT | FL_IN_FLOAT_B_BITEXACT,
    FL_IN_FLOAT_BC_BITEXACT = FL_IN_FLOAT_B_BITEXACT | FL_IN_FLOAT_C_BITEXACT,
    FL_PROGRAMEXCEPTION     = (1ull << 32),
    FL_FLOAT_EXCEPTION      = (1ull << 33),
    FL_FLOAT_DIV            = (1ull << 34),
    FL_SET_ALL_CR           = (1ull << 35),
    FL_READ_CRn             = (1ull << 36),
    FL_READ_CR_BI           = (1ull << 37),
    FL_READ_ALL_CR          = (1ull << 38),
    FL_SET_CRx              = FL_SET_CR0 | FL_SET_CR1 | FL_SET_CRn | FL_SET_ALL_CR,
    FL_READ_CRx             = FL_READ_CRn | FL_READ_CR_BI | FL_READ_ALL_CR,
    FL_SET_MSR              = (1ull << 39),
};

enum class OpType {
    Invalid,
    Subtable,
    Integer,
    CR,
    SPR,
    System,
    SystemFP,
    Load,
    Store,
    LoadFP,
    StoreFP,
    DoubleFP,
    SingleFP,
    LoadPS,
    StorePS,
    PS,
    DataCache,
    InstructionCache,
    Branch,
    Unknown,
};

struct GekkoOPInfo {
    const char* opname;
    OpType type;
    u32 num_cycles;
    u64 flags;
};

// Lookup an opcode's info. Returns a pointer to a static table entry, or
// nullptr for an invalid encoding. Mirrors Dolphin's PPCTables::GetOpInfo
// shape but lives entirely inside bemental::powerpc.
const GekkoOPInfo* lookup_op_info(u32 inst, u32 pc);

}  // namespace bemental::powerpc

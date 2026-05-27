#pragma once
//
// Tiny PowerPC instruction encoder for T1 microkernels.
// One helper per instruction form; each returns the 32-bit encoded word.
// Comments next to call sites name the assembly mnemonic.
//
// Forms used: I, B, D, M, X, XL, XO, XFX. See PowerPC Architecture Book I.

#include "bementalJIT/types.h"

namespace ppc {

// I-form: |OP(6)|LI(24)|AA(1)|LK(1)|
static inline u32 b(s32 displacement, bool aa, bool lk) {
    u32 li = (static_cast<u32>(displacement) >> 2) & 0xFFFFFFu;
    return (18u << 26) | (li << 2) | (aa ? 2u : 0u) | (lk ? 1u : 0u);
}

// D-form: |OP(6)|D(5)|A(5)|imm(16)|
static inline u32 d_form(u32 op, u32 d, u32 a, u32 imm16) {
    return (op << 26) | ((d & 0x1F) << 21) | ((a & 0x1F) << 16) | (imm16 & 0xFFFF);
}
static inline u32 li(u32 d, s16 simm)         { return d_form(14, d, 0, static_cast<u16>(simm)); }
static inline u32 lis(u32 d, u16 imm)          { return d_form(15, d, 0, imm); }
static inline u32 addi(u32 d, u32 a, s16 simm) { return d_form(14, d, a, static_cast<u16>(simm)); }
static inline u32 ori(u32 a, u32 s, u16 imm)   { return d_form(24, s, a, imm); }
static inline u32 cmpwi(u32 cr, u32 a, s16 simm) {
    return (11u << 26) | ((cr & 7) << 23) | ((a & 0x1F) << 16) | (static_cast<u16>(simm));
}
static inline u32 lwz(u32 d, u32 a, s16 simm)  { return d_form(32, d, a, static_cast<u16>(simm)); }
static inline u32 stw(u32 s, u32 a, s16 simm)  { return d_form(36, s, a, static_cast<u16>(simm)); }
static inline u32 lbz(u32 d, u32 a, s16 simm)  { return d_form(34, d, a, static_cast<u16>(simm)); }
static inline u32 stb(u32 s, u32 a, s16 simm)  { return d_form(38, s, a, static_cast<u16>(simm)); }
static inline u32 mulli(u32 d, u32 a, s16 simm){ return d_form(7, d, a, static_cast<u16>(simm)); }
static inline u32 xori(u32 a, u32 s, u16 imm)  { return d_form(26, s, a, imm); }

// M-form: |OP(6)|S(5)|A(5)|SH(5)|MB(5)|ME(5)|Rc(1)|
static inline u32 rlwinm(u32 a, u32 s, u32 sh, u32 mb, u32 me) {
    return (21u << 26) | ((s & 0x1F) << 21) | ((a & 0x1F) << 16)
         | ((sh & 0x1F) << 11) | ((mb & 0x1F) << 6) | ((me & 0x1F) << 1);
}

// X-form: |OP(6)|D(5)|A(5)|B(5)|XO(10)|Rc(1)|
static inline u32 x_form(u32 op, u32 d, u32 a, u32 b_, u32 xo, bool rc=false) {
    return (op << 26) | ((d & 0x1F) << 21) | ((a & 0x1F) << 16)
         | ((b_ & 0x1F) << 11) | ((xo & 0x3FF) << 1) | (rc ? 1u : 0u);
}
static inline u32 add(u32 d, u32 a, u32 b_)  { return x_form(31, d, a, b_, 266); }
static inline u32 subf(u32 d, u32 a, u32 b_) { return x_form(31, d, a, b_, 40); }
static inline u32 mullw(u32 d, u32 a, u32 b_){ return x_form(31, d, a, b_, 235); }
static inline u32 xor_(u32 a, u32 s, u32 b_) { return x_form(31, s, a, b_, 316); }
static inline u32 or_(u32 a, u32 s, u32 b_)  { return x_form(31, s, a, b_, 444); }
static inline u32 lwzx(u32 d, u32 a, u32 b_) { return x_form(31, d, a, b_, 23); }
static inline u32 stwx(u32 s, u32 a, u32 b_) { return x_form(31, s, a, b_, 151); }
static inline u32 lbzx(u32 d, u32 a, u32 b_) { return x_form(31, d, a, b_, 87); }

// XFX-form (mtspr/mfspr): |OP(6)|D(5)|spr(10)|XO(10)|Rc(1)|
// SPR encoding: split-field (low5 << 5 | high5)
static inline u32 mtspr(u32 spr, u32 s) {
    u32 spr_split = ((spr & 0x1F) << 5) | ((spr >> 5) & 0x1F);
    return (31u << 26) | ((s & 0x1F) << 21) | (spr_split << 11) | (467u << 1);
}
static inline u32 mfspr(u32 d, u32 spr) {
    u32 spr_split = ((spr & 0x1F) << 5) | ((spr >> 5) & 0x1F);
    return (31u << 26) | ((d & 0x1F) << 21) | (spr_split << 11) | (339u << 1);
}
static inline u32 mtctr(u32 s) { return mtspr(9, s); }
static inline u32 mflr(u32 d)  { return mfspr(d, 8); }
static inline u32 mtlr(u32 s)  { return mtspr(8, s); }

// B-form: |OP(6)|BO(5)|BI(5)|BD(14)|AA(1)|LK(1)|
static inline u32 bc(u32 bo, u32 bi, s32 displacement, bool aa=false, bool lk=false) {
    u32 bd = (static_cast<u32>(displacement) >> 2) & 0x3FFFu;
    return (16u << 26) | ((bo & 0x1F) << 21) | ((bi & 0x1F) << 16)
         | (bd << 2) | (aa ? 2u : 0u) | (lk ? 1u : 0u);
}
// BO encodings (per PowerPC ABI): see Book I §2.4.1
//   16 = decrement CTR, branch if CTR != 0  (bdnz)
//   12 = branch if condition true (BI selects bit)  (e.g. blt cr0 = BO=12 BI=0)
static inline u32 bdnz(s32 displacement) { return bc(16, 0, displacement); }
static inline u32 bne(s32 displacement)  { return bc(4, 2, displacement); }   // not-EQ on cr0
static inline u32 blt(s32 displacement)  { return bc(12, 0, displacement); }  // LT on cr0

// XL-form (bclr/bcctr): |OP(6)|BO(5)|BI(5)|BH(5)|XO(10)|LK(1)|
static inline u32 xl_form(u32 op, u32 bo, u32 bi, u32 xo, bool lk=false) {
    return (op << 26) | ((bo & 0x1F) << 21) | ((bi & 0x1F) << 16)
         | ((xo & 0x3FF) << 1) | (lk ? 1u : 0u);
}
static inline u32 blr()      { return xl_form(19, 20, 0, 16); }      // bclr 20,0
static inline u32 blrl()     { return xl_form(19, 20, 0, 16, true); } // bclrl
static inline u32 bctr()     { return xl_form(19, 20, 0, 528); }
static inline u32 bctrl()    { return xl_form(19, 20, 0, 528, true); }

// FP D-form helpers (lfs/stfs/lfd/stfd)
static inline u32 lfs(u32 d, u32 a, s16 simm) { return d_form(48, d, a, static_cast<u16>(simm)); }
static inline u32 stfs(u32 s, u32 a, s16 simm){ return d_form(52, s, a, static_cast<u16>(simm)); }
static inline u32 lfd(u32 d, u32 a, s16 simm) { return d_form(50, d, a, static_cast<u16>(simm)); }

// FP A-form: |59|D(5)|A(5)|B(5)|C(5)|XO(5)|Rc|
static inline u32 a_form(u32 op, u32 d, u32 a, u32 b_, u32 c, u32 xo, bool rc=false) {
    return (op << 26) | ((d & 0x1F) << 21) | ((a & 0x1F) << 16)
         | ((b_ & 0x1F) << 11) | ((c & 0x1F) << 6) | ((xo & 0x1F) << 1) | (rc ? 1u : 0u);
}
static inline u32 fmuls(u32 d, u32 a, u32 c)             { return a_form(59, d, a, 0, c, 25); }
static inline u32 fadds(u32 d, u32 a, u32 b_)            { return a_form(59, d, a, b_, 0, 21); }
static inline u32 fmadds(u32 d, u32 a, u32 c, u32 b_)    { return a_form(59, d, a, b_, c, 29); }

// fctiwx: X-form on op 63
static inline u32 fctiwx(u32 d, u32 b_) { return x_form(63, d, 0, b_, 14); }

}  // namespace ppc

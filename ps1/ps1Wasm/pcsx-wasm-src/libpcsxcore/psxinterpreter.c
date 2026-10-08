/***************************************************************************
 *   Copyright (C) 2007 Ryan Schultz, PCSX-df Team, PCSX team              *
 *                                                                         *
 *   This program is free software; you can redistribute it and/or modify  *
 *   it under the terms of the GNU General Public License as published by  *
 *   the Free Software Foundation; either version 2 of the License, or     *
 *   (at your option) any later version.                                   *
 *                                                                         *
 *   This program is distributed in the hope that it will be useful,       *
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of        *
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the         *
 *   GNU General Public License for more details.                          *
 *                                                                         *
 *   You should have received a copy of the GNU General Public License     *
 *   along with this program; if not, write to the                         *
 *   Free Software Foundation, Inc.,                                       *
 *   51 Franklin Street, Fifth Floor, Boston, MA 02111-1307 USA.           *
 ***************************************************************************/

/*
 * PSX assembly interpreter.
 */

#include "psxcommon.h"
#include "r3000a.h"
#include "gte.h"
#include "psxhle.h"
#include <stdio.h>
static int branch = 0;
static int branch2 = 0;
static u32 branchPC;

// These macros are used to assemble the repassembler functions
FILE *mylogf=NULL;
#define PSXCPU_LOG(format, arg) {\
      if(mylogf==NULL) mylogf=fopen("/home/tjw/src/asmlog","w");\
      fprintf (mylogf, format , arg);\
      if(psxRegs.cycle&0xffff==0) fflush(mylogf);\
    }
#undef PSXCPU_LOG
#define debugI()
void execI();
static __inline void psxExecOp(void);

// Subsets
void (*psxBSC[64])();
void (*psxSPC[64])();
void (*psxREG[32])();
void (*psxCP0[32])();
void (*psxCP2[64])();
void (*psxCP2BSC[32])();

static void delayRead(int reg, u32 bpc) {
	u32 rold, rnew;

//	SysPrintf("delayRead at %x!\n", psxRegs.pc);

	rold = psxRegs.GPR.r[reg];
	psxBSC[psxRegs.code >> 26](); // branch delay load
	rnew = psxRegs.GPR.r[reg];

	psxRegs.pc = bpc;

	psxBranchTest();

	psxRegs.GPR.r[reg] = rold;
	execI(); // first branch opcode
	psxRegs.GPR.r[reg] = rnew;

	branch = 0;
}

static void delayWrite(int reg, u32 bpc) {

/*	SysPrintf("delayWrite at %x!\n", psxRegs.pc);

	SysPrintf("%s\n", disR3000AF(psxRegs.code, psxRegs.pc-4));
	SysPrintf("%s\n", disR3000AF(PSXMu32(bpc), bpc));*/

	// no changes from normal behavior

	psxBSC[psxRegs.code >> 26]();

	branch = 0;
	psxRegs.pc = bpc;

	psxBranchTest();
}

static void delayReadWrite(int reg, u32 bpc) {

//	SysPrintf("delayReadWrite at %x!\n", psxRegs.pc);

	// the branch delay load is skipped

	branch = 0;
	psxRegs.pc = bpc;

	psxBranchTest();
}

// this defines shall be used with the tmp 
// of the next func (instead of _Funct_...)
#define _tFunct_  ((tmp      ) & 0x3F)  // The funct part of the instruction register 
#define _tRd_     ((tmp >> 11) & 0x1F)  // The rd part of the instruction register 
#define _tRt_     ((tmp >> 16) & 0x1F)  // The rt part of the instruction register 
#define _tRs_     ((tmp >> 21) & 0x1F)  // The rs part of the instruction register 
#define _tSa_     ((tmp >>  6) & 0x1F)  // The sa part of the instruction register

int psxTestLoadDelay(int reg, u32 tmp) {
	if (tmp == 0) return 0; // NOP
	switch (tmp >> 26) {
		case 0x00: // SPECIAL
			switch (_tFunct_) {
				case 0x00: // SLL
				case 0x02: case 0x03: // SRL/SRA
					if (_tRd_ == reg && _tRt_ == reg) return 1; else
					if (_tRt_ == reg) return 2; else
					if (_tRd_ == reg) return 3;
					break;

				case 0x08: // JR
					if (_tRs_ == reg) return 2;
					break;
				case 0x09: // JALR
					if (_tRd_ == reg && _tRs_ == reg) return 1; else
					if (_tRs_ == reg) return 2; else
					if (_tRd_ == reg) return 3;
					break;

				// SYSCALL/BREAK just a break;

				case 0x20: case 0x21: case 0x22: case 0x23:
				case 0x24: case 0x25: case 0x26: case 0x27: 
				case 0x2a: case 0x2b: // ADD/ADDU...
				case 0x04: case 0x06: case 0x07: // SLLV...
					if (_tRd_ == reg && (_tRt_ == reg || _tRs_ == reg)) return 1; else
					if (_tRt_ == reg || _tRs_ == reg) return 2; else
					if (_tRd_ == reg) return 3;
					break;

				case 0x10: case 0x12: // MFHI/MFLO
					if (_tRd_ == reg) return 3;
					break;
				case 0x11: case 0x13: // MTHI/MTLO
					if (_tRs_ == reg) return 2;
					break;

				case 0x18: case 0x19:
				case 0x1a: case 0x1b: // MULT/DIV...
					if (_tRt_ == reg || _tRs_ == reg) return 2;
					break;
			}
			break;

		case 0x01: // REGIMM
			switch (_tRt_) {
				case 0x00: case 0x02:
				case 0x10: case 0x12: // BLTZ/BGEZ...
					if (_tRs_ == reg) return 2;
					break;
			}
			break;

		// J would be just a break;
		case 0x03: // JAL
			if (31 == reg) return 3;
			break;

		case 0x04: case 0x05: // BEQ/BNE
			if (_tRs_ == reg || _tRt_ == reg) return 2;
			break;

		case 0x06: case 0x07: // BLEZ/BGTZ
			if (_tRs_ == reg) return 2;
			break;

		case 0x08: case 0x09: case 0x0a: case 0x0b:
		case 0x0c: case 0x0d: case 0x0e: // ADDI/ADDIU...
			if (_tRt_ == reg && _tRs_ == reg) return 1; else
			if (_tRs_ == reg) return 2; else
			if (_tRt_ == reg) return 3;
			break;

		case 0x0f: // LUI
			if (_tRt_ == reg) return 3;
			break;

		case 0x10: // COP0
			switch (_tFunct_) {
				case 0x00: // MFC0
					if (_tRt_ == reg) return 3;
					break;
				case 0x02: // CFC0
					if (_tRt_ == reg) return 3;
					break;
				case 0x04: // MTC0
					if (_tRt_ == reg) return 2;
					break;
				case 0x06: // CTC0
					if (_tRt_ == reg) return 2;
					break;
				// RFE just a break;
			}
			break;

		case 0x12: // COP2
			switch (_tFunct_) {
				case 0x00: 
					switch (_tRs_) {
						case 0x00: // MFC2
							if (_tRt_ == reg) return 3;
							break;
						case 0x02: // CFC2
							if (_tRt_ == reg) return 3;
							break;
						case 0x04: // MTC2
							if (_tRt_ == reg) return 2;
							break;
						case 0x06: // CTC2
							if (_tRt_ == reg) return 2;
							break;
					}
					break;
				// RTPS... break;
			}
			break;

		case 0x22: case 0x26: // LWL/LWR
			if (_tRt_ == reg) return 3; else
			if (_tRs_ == reg) return 2;
			break;

		case 0x20: case 0x21: case 0x23:
		case 0x24: case 0x25: // LB/LH/LW/LBU/LHU
			if (_tRt_ == reg && _tRs_ == reg) return 1; else
			if (_tRs_ == reg) return 2; else
			if (_tRt_ == reg) return 3;
			break;

		case 0x28: case 0x29: case 0x2a:
		case 0x2b: case 0x2e: // SB/SH/SWL/SW/SWR
			if (_tRt_ == reg || _tRs_ == reg) return 2;
			break;

		case 0x32: case 0x3a: // LWC2/SWC2
			if (_tRs_ == reg) return 2;
			break;
	}

	return 0;
}

void psxDelayTest(int reg, u32 bpc) {
	u32 *code;
	u32 tmp;

	code = (u32 *)PSXM(bpc);
	tmp = ((code == NULL) ? 0 : SWAP32(*code));
	branch = 1;

	switch (psxTestLoadDelay(reg, tmp)) {
		case 1:
			delayReadWrite(reg, bpc); return;
		case 2:
			delayRead(reg, bpc); return;
		case 3:
			delayWrite(reg, bpc); return;
	}
	psxBSC[psxRegs.code >> 26]();

	branch = 0;
	psxRegs.pc = bpc;

	psxBranchTest();
}


/* ══ IDLE-LOOP FAST-FORWARD (exact) ═══════════════════════════════════════
 * A game waiting for the next vertical blank spins in a loop until an
 * interrupt handler changes a word in RAM. While it spins, nothing happens
 * that the loop itself does not do: no event can fire until psxBranchTest
 * finds one due, and every one of those is a cycle-count deadline
 * (`cycle - start >= delta`, see psxBranchTest). So when the loop's passes
 * are proven to change the machine in a known way per pass, the passes up to
 * the earliest deadline can be applied at once — the state after them is
 * bit-for-bit the state running them would have produced, and the branch
 * tests they would have run would all have found nothing due.
 * psxEvSeq (r3000a.c) counts every branch test that fired and every
 * exception; psxIoSeq (psxmem.c) every hardware-register read (a read can
 * have side effects or depend on the cycle count — the root counters do).
 * ps1_idle(-1) reads the switch, ps1_idle(0/1) sets it; stats at the
 * returned pointer: [0] skips, [1] skipped cycles / 1024, [2] unused,
 * [3] the switch. ⚠ Everything here is guest-deterministic state (it is in
 * static data, so in the snapshot and the fingerprint): two consoles that ran
 * the same frames hold the same values. */
extern u32 psxEvSeq, psxIoSeq;
static int il_on = 1;
static u32 il_stats[4], il_frac;

/* the earliest cycle count at which psxBranchTest would do something, as
 * cycles from now — valid right after a branch test that fired nothing */
static u32 ilBudget(void) {
	u32 m = psxNextCounter - (psxRegs.cycle - psxNextsCounter), r, i = psxRegs.interrupt;
#define IL_T(bit, n) if (i & (bit)) { r = psxRegs.intCycle[(n) + 1] - (psxRegs.cycle - psxRegs.intCycle[n]); if (r < m) m = r; }
	if (!Config.Sio) IL_T(0x80, 7)
	IL_T(0x04, 2) IL_T(0x040000, 2 + 16) IL_T(0x01000000, 3 + 24) IL_T(0x02000000, 5 + 24) IL_T(0x04000000, 1 + 24)
#undef IL_T
	return m;
}

/* ── THE PSY-Q VSync() WAIT ──────────────────────────────────────────────────
 * The one loop handled: libetc's VSync(0) wait (v_wait). It decrements a
 * timeout counter on the stack every pass, so each pass leaves one RAM word
 * one lower —
 *     L: lw   rC,off(rS) ; nop ; addiu rC,rC,-1 ; sw rC,off(rS)
 *        lw   rC,off(rS) ; nop ; bne  rC,rM,X   ; nop      (rM == -1: timeout)
 *        ...timeout path...
 *     X: lui  rC,hi ; lw rC,lo(rC) ; nop ; slt rC,rC,rA    (Vcount < count)
 *        bne  rC,zero,L ; nop
 * Measured: on Monster Rancher 2 these 14 instructions are ~60% of all the
 * guest executes (PC histogram, 1200 frames of the bench room's boot).
 * A pass from L with the counter at T, Vcount V < rA, and no event due:
 * stores T-1, does not take the timeout path unless T-1 == -1, reads V,
 * leaves rC = 1, and costs the same cycles every time. So k passes are
 * exactly: counter T-k, cycles += k*iter, every register as it is now —
 * for any k with no timeout among them (k <= T) and no branch test due
 * (ilBudget). Taken only when the words match this shape
 * exactly, the counter and Vcount are plain RAM (not the same word, not
 * hardware), rM really holds -1, and the last two closes were seen to differ
 * by exactly one pass (counter -1, same registers, same cycles, nothing
 * fired, no hardware read). */
static u32 vw_L = 0xffffffff, vw_B, vw_A, vw_V, vw_ok, vw_valid, vw_T, vw_cyc, vw_ev, vw_io;
static u32 vw_rC, vw_rS, vw_rM, vw_rA, vw_off;
static u32 vw_gpr[34], vw_w[16];
static u32 vwWord(u32 a) { u32 *w = (u32 *)PSXM(a); return w ? SWAP32(*w) : 0xffffffff; }
static int vwMatch(u32 L, u32 B) {
	u32 w0 = vwWord(L), rC = (w0 >> 16) & 31, rS = (w0 >> 21) & 31, off = w0 & 0xffff, X, w, rM, rA;
	if ((w0 >> 26) != 0x23 || rC == 0 || rC == rS) return 0;
	if (vwWord(L + 4) != 0) return 0;
	if (vwWord(L + 8) != ((0x09u << 26) | (rC << 21) | (rC << 16) | 0xffff)) return 0;
	if (vwWord(L + 12) != ((0x2bu << 26) | (rS << 21) | (rC << 16) | off)) return 0;
	if (vwWord(L + 16) != w0 || vwWord(L + 20) != 0) return 0;
	w = vwWord(L + 24); rM = (w >> 16) & 31;
	if ((w >> 26) != 0x05 || ((w >> 21) & 31) != rC || rM == rC || rM == rS || vwWord(L + 28) != 0) return 0;
	X = L + 28 + ((s32)(s16)(w & 0xffff) << 2);
	if (B != X + 16) return 0;
	w = vwWord(X); if ((w >> 26) != 0x0f || ((w >> 16) & 31) != rC) return 0;
	vw_V = (w & 0xffff) << 16;
	w = vwWord(X + 4); if ((w >> 26) != 0x23 || ((w >> 16) & 31) != rC || ((w >> 21) & 31) != rC) return 0;
	vw_V += (s32)(s16)(w & 0xffff);
	if (vwWord(X + 8) != 0) return 0;
	w = vwWord(X + 12); rA = (w >> 16) & 31;
	if ((w >> 26) != 0 || (w & 0x3f) != 0x2a || ((w >> 11) & 31) != rC || ((w >> 21) & 31) != rC || rA == rC) return 0;
	if (vwWord(B) != ((0x05u << 26) | (rC << 21) | (0 << 16) | ((L - (B + 4)) >> 2 & 0xffff))) return 0;
	if (vwWord(B + 4) != 0) return 0;
	vw_rC = rC; vw_rS = rS; vw_rM = rM; vw_rA = rA; vw_off = off;
	for (w = 0; w < 8; w++) vw_w[w] = vwWord(L + 4 * w);
	for (w = 0; w < 6; w++) vw_w[8 + w] = vwWord(X + 4 * w);
	return 1;
}
/* the loop's code is still the code that was matched */
static int vwSame(u32 L, u32 B) {
	u32 i, X = B - 16;
	for (i = 0; i < 8; i++) if (vwWord(L + 4 * i) != vw_w[i]) return 0;
	for (i = 0; i < 6; i++) if (vwWord(X + 4 * i) != vw_w[8 + i]) return 0;
	return 1;
}
/* a RAM word's host address, or NULL if `a` is not plain RAM both ways */
static u32 *vwRam(u32 a) {
	u32 t = a >> 16;
	if (t == 0x1f80 || (a & 3) || psxMemRLUT[t] == NULL || psxMemRLUT[t] != psxMemWLUT[t]) return NULL;
	return (u32 *)(psxMemRLUT[t] + (a & 0xffff));
}
/* every taken branch: a pass of the wait takes exactly two (L+24 -> X, B -> L) */
static __inline void vwEnter(u32 bpc, u32 tar) {
	if (vw_valid && !((bpc == vw_B && tar == vw_L) || (bpc == vw_L + 24 && tar == vw_B - 16))) vw_valid = 0;
}
static __inline void vwClose(u32 bpc, u32 tar) {
	u32 *pa, *pv, T;
	if (!il_on || psxRegs.pc != tar) return;
	if (tar != vw_L || bpc != vw_B) {
		if (!(tar < bpc && bpc - tar <= 0x100)) return;
		vw_L = tar; vw_B = bpc; vw_valid = 0;
		vw_ok = vwMatch(tar, bpc);
	}
	if (!vw_ok) return;
	vw_A = psxRegs.GPR.r[vw_rS] + (s32)(s16)vw_off;
	pa = vwRam(vw_A); pv = vwRam(vw_V);
	if (!pa || !pv || pa == pv || psxRegs.GPR.r[vw_rM] != 0xffffffff) { vw_valid = 0; return; }
	T = SWAP32(*pa);
	if (vw_valid && vw_ev == psxEvSeq && vw_io == psxIoSeq && T == vw_T - 1 &&
	    memcmp(vw_gpr, psxRegs.GPR.r, sizeof(vw_gpr)) == 0 &&
	    (s32)SWAP32(*pv) < (s32)psxRegs.GPR.r[vw_rA]) {
		u32 iter = psxRegs.cycle - vw_cyc, m = ilBudget();
		if (iter == 14 * BIAS && m > iter && T != 0xffffffff) {
			u32 k = (m - 1) / iter;
			if (k > T) k = T;
			/* the words are re-read right before a skip: code can be replaced
			 * (an overlay) between the match and now */
			if (k && !vwSame(tar, bpc)) { vw_ok = 0; vw_valid = 0; return; }
			if (k) {
				psxMemWrite32(vw_A, T - k);
				psxRegs.cycle += k * iter;
				T -= k;
				il_stats[0]++;
				il_frac += k * iter; il_stats[1] += il_frac >> 10; il_frac &= 1023;
			}
		}
	}
	memcpy(vw_gpr, psxRegs.GPR.r, sizeof(vw_gpr));
	vw_T = T; vw_cyc = psxRegs.cycle; vw_ev = psxEvSeq; vw_io = psxIoSeq; vw_valid = 1;
}
u32 *ps1_idle(int on) {
	if (on >= 0) { il_on = on ? 1 : 0; vw_L = 0xffffffff; vw_valid = 0; }
	il_stats[3] = il_on;
	return il_stats;
}

__inline static void doBranch(u32 tar) {
	u32 *code;
	u32 tmp;

	u32 bpc = psxRegs.pc - 4;

	branch2 = branch = 1;
	branchPC = tar;
	vwEnter(bpc, tar);

	code = (u32 *)PSXM(psxRegs.pc);
	psxRegs.code = ((code == NULL) ? 0 : SWAP32(*code));

	//debugI();

	psxRegs.pc += 4;
	psxRegs.cycle += BIAS;

	// check for load delay
	tmp = psxRegs.code >> 26;
	switch (tmp) {
		case 0x10: // COP0
			switch (_Rs_) {
				case 0x00: // MFC0
				case 0x02: // CFC0
					psxDelayTest(_Rt_, branchPC);
					return;
			}
			break;
		case 0x12: // COP2
			switch (_Funct_) {
				case 0x00:
					switch (_Rs_) {
						case 0x00: // MFC2
						case 0x02: // CFC2
							psxDelayTest(_Rt_, branchPC);
							return;
					}
					break;
			}
			break;
		case 0x32: // LWC2
			psxDelayTest(_Rt_, branchPC);
			return;
		default:
			if (tmp >= 0x20 && tmp <= 0x26) { // LB/LH/LWL/LW/LBU/LHU/LWR
				psxDelayTest(_Rt_, branchPC);
				return;
			}
			break;
	}

	psxExecOp();

	branch = 0;
	psxRegs.pc = branchPC;

	psxBranchTest();
	vwClose(bpc, tar);
}

/*********************************************************
* Arithmetic with immediate operand                      *
* Format:  OP rt, rs, immediate                          *
*********************************************************/
void psxADDI() 	{ if (!_Rt_) return; _rRt_ = _u32(_rRs_) + _Imm_ ; }		// Rt = Rs + Im 	(Exception on Integer Overflow)
void psxADDIU() { if (!_Rt_) return; _rRt_ = _u32(_rRs_) + _Imm_ ; }		// Rt = Rs + Im
void psxANDI() 	{ if (!_Rt_) return; _rRt_ = _u32(_rRs_) & _ImmU_; }		// Rt = Rs And Im
void psxORI() 	{ if (!_Rt_) return; _rRt_ = _u32(_rRs_) | _ImmU_; }		// Rt = Rs Or  Im
void psxXORI() 	{ if (!_Rt_) return; _rRt_ = _u32(_rRs_) ^ _ImmU_; }		// Rt = Rs Xor Im
void psxSLTI() 	{ if (!_Rt_) return; _rRt_ = _i32(_rRs_) < _Imm_ ; }		// Rt = Rs < Im		(Signed)
void psxSLTIU() { if (!_Rt_) return; _rRt_ = _u32(_rRs_) < ((u32)_Imm_); }		// Rt = Rs < Im		(Unsigned)

/*********************************************************
* Register arithmetic                                    *
* Format:  OP rd, rs, rt                                 *
*********************************************************/
void psxADD()	{ if (!_Rd_) return; _rRd_ = _u32(_rRs_) + _u32(_rRt_); }	// Rd = Rs + Rt		(Exception on Integer Overflow)
void psxADDU() 	{ if (!_Rd_) return; _rRd_ = _u32(_rRs_) + _u32(_rRt_); }	// Rd = Rs + Rt
void psxSUB() 	{ if (!_Rd_) return; _rRd_ = _u32(_rRs_) - _u32(_rRt_); }	// Rd = Rs - Rt		(Exception on Integer Overflow)
void psxSUBU() 	{ if (!_Rd_) return; _rRd_ = _u32(_rRs_) - _u32(_rRt_); }	// Rd = Rs - Rt
void psxAND() 	{ if (!_Rd_) return; _rRd_ = _u32(_rRs_) & _u32(_rRt_); }	// Rd = Rs And Rt
void psxOR() 	{ if (!_Rd_) return; _rRd_ = _u32(_rRs_) | _u32(_rRt_); }	// Rd = Rs Or  Rt
void psxXOR() 	{ if (!_Rd_) return; _rRd_ = _u32(_rRs_) ^ _u32(_rRt_); }	// Rd = Rs Xor Rt
void psxNOR() 	{ if (!_Rd_) return; _rRd_ =~(_u32(_rRs_) | _u32(_rRt_)); }// Rd = Rs Nor Rt
void psxSLT() 	{ if (!_Rd_) return; _rRd_ = _i32(_rRs_) < _i32(_rRt_); }	// Rd = Rs < Rt		(Signed)
void psxSLTU() 	{ if (!_Rd_) return; _rRd_ = _u32(_rRs_) < _u32(_rRt_); }	// Rd = Rs < Rt		(Unsigned)

/*********************************************************
* Register mult/div & Register trap logic                *
* Format:  OP rs, rt                                     *
*********************************************************/
void psxDIV() {
	if (_i32(_rRt_) != 0) {
		_i32(_rLo_) = _i32(_rRs_) / _i32(_rRt_);
		_i32(_rHi_) = _i32(_rRs_) % _i32(_rRt_);
	}
}

void psxDIVU() {
	if (_rRt_ != 0) {
		_rLo_ = _rRs_ / _rRt_;
		_rHi_ = _rRs_ % _rRt_;
	}
}

void psxMULT() {
	u64 res = (s64)((s64)_i32(_rRs_) * (s64)_i32(_rRt_));

	psxRegs.GPR.n.lo = (u32)(res & 0xffffffff);
	psxRegs.GPR.n.hi = (u32)((res >> 32) & 0xffffffff);
}

void psxMULTU() {
	u64 res = (u64)((u64)_u32(_rRs_) * (u64)_u32(_rRt_));

	psxRegs.GPR.n.lo = (u32)(res & 0xffffffff);
	psxRegs.GPR.n.hi = (u32)((res >> 32) & 0xffffffff);
}

/*********************************************************
* Register branch logic                                  *
* Format:  OP rs, offset                                 *
*********************************************************/
#define RepZBranchi32(op)      if(_i32(_rRs_) op 0) doBranch(_BranchTarget_);
#define RepZBranchLinki32(op)  if(_i32(_rRs_) op 0) { _SetLink(31); doBranch(_BranchTarget_); }

void psxBGEZ()   { RepZBranchi32(>=) }      // Branch if Rs >= 0
void psxBGEZAL() { RepZBranchLinki32(>=) }  // Branch if Rs >= 0 and link
void psxBGTZ()   { RepZBranchi32(>) }       // Branch if Rs >  0
void psxBLEZ()   { RepZBranchi32(<=) }      // Branch if Rs <= 0
void psxBLTZ()   { RepZBranchi32(<) }       // Branch if Rs <  0
void psxBLTZAL() { RepZBranchLinki32(<) }   // Branch if Rs <  0 and link

/*********************************************************
* Shift arithmetic with constant shift                   *
* Format:  OP rd, rt, sa                                 *
*********************************************************/
void psxSLL() { if (!_Rd_) return; _u32(_rRd_) = _u32(_rRt_) << _Sa_; } // Rd = Rt << sa
void psxSRA() { if (!_Rd_) return; _i32(_rRd_) = _i32(_rRt_) >> _Sa_; } // Rd = Rt >> sa (arithmetic)
void psxSRL() { if (!_Rd_) return; _u32(_rRd_) = _u32(_rRt_) >> _Sa_; } // Rd = Rt >> sa (logical)

/*********************************************************
* Shift arithmetic with variant register shift           *
* Format:  OP rd, rt, rs                                 *
*********************************************************/
void psxSLLV() { if (!_Rd_) return; _u32(_rRd_) = _u32(_rRt_) << _u32(_rRs_); } // Rd = Rt << rs
void psxSRAV() { if (!_Rd_) return; _i32(_rRd_) = _i32(_rRt_) >> _u32(_rRs_); } // Rd = Rt >> rs (arithmetic)
void psxSRLV() { if (!_Rd_) return; _u32(_rRd_) = _u32(_rRt_) >> _u32(_rRs_); } // Rd = Rt >> rs (logical)

/*********************************************************
* Load higher 16 bits of the first word in GPR with imm  *
* Format:  OP rt, immediate                              *
*********************************************************/
void psxLUI() { if (!_Rt_) return; _u32(_rRt_) = psxRegs.code << 16; } // Upper halfword of Rt = Im

/*********************************************************
* Move from HI/LO to GPR                                 *
* Format:  OP rd                                         *
*********************************************************/
void psxMFHI() { if (!_Rd_) return; _rRd_ = _rHi_; } // Rd = Hi
void psxMFLO() { if (!_Rd_) return; _rRd_ = _rLo_; } // Rd = Lo

/*********************************************************
* Move to GPR to HI/LO & Register jump                   *
* Format:  OP rs                                         *
*********************************************************/
void psxMTHI() { _rHi_ = _rRs_; } // Hi = Rs
void psxMTLO() { _rLo_ = _rRs_; } // Lo = Rs

/*********************************************************
* Special purpose instructions                           *
* Format:  OP                                            *
*********************************************************/
void psxBREAK() {
	// Break exception - psx rom doens't handles this
}

void psxSYSCALL() {
	psxRegs.pc -= 4;
	psxException(0x20, branch);
}

void psxRFE() {
//	SysPrintf("psxRFE\n");
	psxRegs.CP0.n.Status = (psxRegs.CP0.n.Status & 0xfffffff0) |
						  ((psxRegs.CP0.n.Status & 0x3c) >> 2);
}

/*********************************************************
* Register branch logic                                  *
* Format:  OP rs, rt, offset                             *
*********************************************************/
#define RepBranchi32(op)      if(_i32(_rRs_) op _i32(_rRt_)) doBranch(_BranchTarget_);

void psxBEQ() {	RepBranchi32(==) }  // Branch if Rs == Rt
void psxBNE() {	RepBranchi32(!=) }  // Branch if Rs != Rt

/*********************************************************
* Jump to target                                         *
* Format:  OP target                                     *
*********************************************************/
void psxJ()   {               doBranch(_JumpTarget_); }
void psxJAL() {	_SetLink(31); doBranch(_JumpTarget_); }

/*********************************************************
* Register jump                                          *
* Format:  OP rs, rd                                     *
*********************************************************/
void psxJR()   {
	doBranch(_u32(_rRs_));
	psxJumpTest();
}

void psxJALR() {
	u32 temp = _u32(_rRs_);
	if (_Rd_) { _SetLink(_Rd_); }
	doBranch(temp);
}

/*********************************************************
* Load and store for GPR                                 *
* Format:  OP rt, offset(base)                           *
*********************************************************/

#define _oB_ (_u32(_rRs_) + _Imm_)

void psxLB() {
	if (_Rt_) {
		_i32(_rRt_) = (signed char)psxMemRead8(_oB_); 
	} else {
		psxMemRead8(_oB_); 
	}
}

void psxLBU() {
	if (_Rt_) {
		_u32(_rRt_) = psxMemRead8(_oB_);
	} else {
		psxMemRead8(_oB_); 
	}
}

void psxLH() {
	if (_Rt_) {
		_i32(_rRt_) = (short)psxMemRead16(_oB_);
	} else {
		psxMemRead16(_oB_);
	}
}

void psxLHU() {
	if (_Rt_) {
		_u32(_rRt_) = psxMemRead16(_oB_);
	} else {
		psxMemRead16(_oB_);
	}
}

void psxLW() {
	if (_Rt_) {
		_u32(_rRt_) = psxMemRead32(_oB_);
	} else {
		psxMemRead32(_oB_);
	}
}

u32 LWL_MASK[4] = { 0xffffff, 0xffff, 0xff, 0 };
u32 LWL_SHIFT[4] = { 24, 16, 8, 0 };

void psxLWL() {
	u32 addr = _oB_;
	u32 shift = addr & 3;
	u32 mem = psxMemRead32(addr & ~3);

	if (!_Rt_) return;
	_u32(_rRt_) =	( _u32(_rRt_) & LWL_MASK[shift]) | 
					( mem << LWL_SHIFT[shift]);

	/*
	Mem = 1234.  Reg = abcd

	0   4bcd   (mem << 24) | (reg & 0x00ffffff)
	1   34cd   (mem << 16) | (reg & 0x0000ffff)
	2   234d   (mem <<  8) | (reg & 0x000000ff)
	3   1234   (mem      ) | (reg & 0x00000000)
	*/
}

u32 LWR_MASK[4] = { 0, 0xff000000, 0xffff0000, 0xffffff00 };
u32 LWR_SHIFT[4] = { 0, 8, 16, 24 };

void psxLWR() {
	u32 addr = _oB_;
	u32 shift = addr & 3;
	u32 mem = psxMemRead32(addr & ~3);

	if (!_Rt_) return;
	_u32(_rRt_) =	( _u32(_rRt_) & LWR_MASK[shift]) | 
					( mem >> LWR_SHIFT[shift]);

	/*
	Mem = 1234.  Reg = abcd

	0   1234   (mem      ) | (reg & 0x00000000)
	1   a123   (mem >>  8) | (reg & 0xff000000)
	2   ab12   (mem >> 16) | (reg & 0xffff0000)
	3   abc1   (mem >> 24) | (reg & 0xffffff00)
	*/
}

void psxSB() { psxMemWrite8 (_oB_, _u8 (_rRt_)); }
void psxSH() { psxMemWrite16(_oB_, _u16(_rRt_)); }
void psxSW() { psxMemWrite32(_oB_, _u32(_rRt_)); }

u32 SWL_MASK[4] = { 0xffffff00, 0xffff0000, 0xff000000, 0 };
u32 SWL_SHIFT[4] = { 24, 16, 8, 0 };

void psxSWL() {
	u32 addr = _oB_;
	u32 shift = addr & 3;
	u32 mem = psxMemRead32(addr & ~3);

	psxMemWrite32(addr & ~3,  (_u32(_rRt_) >> SWL_SHIFT[shift]) |
			     (  mem & SWL_MASK[shift]) );
	/*
	Mem = 1234.  Reg = abcd

	0   123a   (reg >> 24) | (mem & 0xffffff00)
	1   12ab   (reg >> 16) | (mem & 0xffff0000)
	2   1abc   (reg >>  8) | (mem & 0xff000000)
	3   abcd   (reg      ) | (mem & 0x00000000)
	*/
}

u32 SWR_MASK[4] = { 0, 0xff, 0xffff, 0xffffff };
u32 SWR_SHIFT[4] = { 0, 8, 16, 24 };

void psxSWR() {
	u32 addr = _oB_;
	u32 shift = addr & 3;
	u32 mem = psxMemRead32(addr & ~3);

	psxMemWrite32(addr & ~3,  (_u32(_rRt_) << SWR_SHIFT[shift]) |
			     (  mem & SWR_MASK[shift]) );

	/*
	Mem = 1234.  Reg = abcd

	0   abcd   (reg      ) | (mem & 0x00000000)
	1   bcd4   (reg <<  8) | (mem & 0x000000ff)
	2   cd34   (reg << 16) | (mem & 0x0000ffff)
	3   d234   (reg << 24) | (mem & 0x00ffffff)
	*/
}

/*********************************************************
* Moves between GPR and COPx                             *
* Format:  OP rt, fs                                     *
*********************************************************/
void psxMFC0() { if (!_Rt_) return; _i32(_rRt_) = (int)_rFs_; }
void psxCFC0() { if (!_Rt_) return; _i32(_rRt_) = (int)_rFs_; }

void psxTestSWInts() {
	// the next code is untested, if u know please
	// tell me if it works ok or not (linuzappz)
	if (psxRegs.CP0.n.Cause & psxRegs.CP0.n.Status & 0x0300 &&
		psxRegs.CP0.n.Status & 0x1) {
		psxException(psxRegs.CP0.n.Cause, branch);
	}
}

__inline static void MTC0(int reg, u32 val) {
//	SysPrintf("MTC0 %d: %x\n", reg, val);
	switch (reg) {
		case 12: // Status
			psxRegs.CP0.r[12] = val;
			psxTestSWInts();
			break;

		case 13: // Cause
			psxRegs.CP0.n.Cause = val & ~(0xfc00);
			psxTestSWInts();
			break;

		default:
			psxRegs.CP0.r[reg] = val;
			break;
	}
}

void psxMTC0() { MTC0(_Rd_, _u32(_rRt_)); }
void psxCTC0() { MTC0(_Rd_, _u32(_rRt_)); }

/*********************************************************
* Unknow instruction (would generate an exception)       *
* Format:  ?                                             *
*********************************************************/
void psxNULL() { 
#ifdef PSXCPU_LOG
	PSXCPU_LOG("psx: Unimplemented op %x\n", psxRegs.code);
#endif
}

void psxSPECIAL() {
	psxSPC[_Funct_]();
}

void psxREGIMM() {
	psxREG[_Rt_]();
}

void psxCOP0() {
	psxCP0[_Rs_]();
}

void psxCOP2() {
	psxCP2[_Funct_]();
}

void psxBASIC() {
	psxCP2BSC[_Rs_]();
}

void psxHLE() {
//	psxHLEt[psxRegs.code & 0xffff]();
	psxHLEt[psxRegs.code & 0x07]();		// HDHOSHY experimental patch
}

void (*psxBSC[64])() = {
	psxSPECIAL, psxREGIMM, psxJ   , psxJAL  , psxBEQ , psxBNE , psxBLEZ, psxBGTZ,
	psxADDI   , psxADDIU , psxSLTI, psxSLTIU, psxANDI, psxORI , psxXORI, psxLUI ,
	psxCOP0   , psxNULL  , psxCOP2, psxNULL , psxNULL, psxNULL, psxNULL, psxNULL,
	psxNULL   , psxNULL  , psxNULL, psxNULL , psxNULL, psxNULL, psxNULL, psxNULL,
	psxLB     , psxLH    , psxLWL , psxLW   , psxLBU , psxLHU , psxLWR , psxNULL,
	psxSB     , psxSH    , psxSWL , psxSW   , psxNULL, psxNULL, psxSWR , psxNULL, 
	psxNULL   , psxNULL  , gteLWC2, psxNULL , psxNULL, psxNULL, psxNULL, psxNULL,
	psxNULL   , psxNULL  , gteSWC2, psxHLE  , psxNULL, psxNULL, psxNULL, psxNULL 
};


void (*psxSPC[64])() = {
	psxSLL , psxNULL , psxSRL , psxSRA , psxSLLV   , psxNULL , psxSRLV, psxSRAV,
	psxJR  , psxJALR , psxNULL, psxNULL, psxSYSCALL, psxBREAK, psxNULL, psxNULL,
	psxMFHI, psxMTHI , psxMFLO, psxMTLO, psxNULL   , psxNULL , psxNULL, psxNULL,
	psxMULT, psxMULTU, psxDIV , psxDIVU, psxNULL   , psxNULL , psxNULL, psxNULL,
	psxADD , psxADDU , psxSUB , psxSUBU, psxAND    , psxOR   , psxXOR , psxNOR ,
	psxNULL, psxNULL , psxSLT , psxSLTU, psxNULL   , psxNULL , psxNULL, psxNULL,
	psxNULL, psxNULL , psxNULL, psxNULL, psxNULL   , psxNULL , psxNULL, psxNULL,
	psxNULL, psxNULL , psxNULL, psxNULL, psxNULL   , psxNULL , psxNULL, psxNULL
};

void (*psxREG[32])() = {
	psxBLTZ  , psxBGEZ  , psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL,
	psxNULL  , psxNULL  , psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL,
	psxBLTZAL, psxBGEZAL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL,
	psxNULL  , psxNULL  , psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL
};

void (*psxCP0[32])() = {
	psxMFC0, psxNULL, psxCFC0, psxNULL, psxMTC0, psxNULL, psxCTC0, psxNULL,
	psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL,
	psxRFE , psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL,
	psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL
};

void (*psxCP2[64])() = {
	psxBASIC, gteRTPS , psxNULL , psxNULL, psxNULL, psxNULL , gteNCLIP, psxNULL, // 00
	psxNULL , psxNULL , psxNULL , psxNULL, gteOP  , psxNULL , psxNULL , psxNULL, // 08
	gteDPCS , gteINTPL, gteMVMVA, gteNCDS, gteCDP , psxNULL , gteNCDT , psxNULL, // 10
	psxNULL , psxNULL , psxNULL , gteNCCS, gteCC  , psxNULL , gteNCS  , psxNULL, // 18
	gteNCT  , psxNULL , psxNULL , psxNULL, psxNULL, psxNULL , psxNULL , psxNULL, // 20
	gteSQR  , gteDCPL , gteDPCT , psxNULL, psxNULL, gteAVSZ3, gteAVSZ4, psxNULL, // 28 
	gteRTPT , psxNULL , psxNULL , psxNULL, psxNULL, psxNULL , psxNULL , psxNULL, // 30
	psxNULL , psxNULL , psxNULL , psxNULL, psxNULL, gteGPF  , gteGPL  , gteNCCT  // 38
};

void (*psxCP2BSC[32])() = {
	gteMFC2, psxNULL, gteCFC2, psxNULL, gteMTC2, psxNULL, gteCTC2, psxNULL,
	psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL,
	psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL,
	psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL, psxNULL
};


///////////////////////////////////////////

static int intInit() {
	return 0;
}

static void intReset() {
}


/* ══ DIRECT DISPATCH (2026-10-08) ════════════════════════════════════════
 * The same opcode -> function mapping as the psxBSC / psxSPC / psxREG tables
 * above (generated from them; the tables are never written), as a switch, so
 * the compiler can inline the handlers instead of making two call_indirects
 * per instruction (SPECIAL -> psxSPC). Same functions, same order of effects:
 * nothing the guest can see changes (tools/ps1_core_equiv.mjs). The tables
 * stay for the rare paths (load-delay handling, COP dispatch). */
static __inline void psxExecOp(void) {
	switch (psxRegs.code >> 26) {
		case 0x00:
			switch (psxRegs.code & 0x3f) {
				case 0x00: psxSLL(); return;
				case 0x02: psxSRL(); return;
				case 0x03: psxSRA(); return;
				case 0x04: psxSLLV(); return;
				case 0x06: psxSRLV(); return;
				case 0x07: psxSRAV(); return;
				case 0x08: psxJR(); return;
				case 0x09: psxJALR(); return;
				case 0x0c: psxSYSCALL(); return;
				case 0x0d: psxBREAK(); return;
				case 0x10: psxMFHI(); return;
				case 0x11: psxMTHI(); return;
				case 0x12: psxMFLO(); return;
				case 0x13: psxMTLO(); return;
				case 0x18: psxMULT(); return;
				case 0x19: psxMULTU(); return;
				case 0x1a: psxDIV(); return;
				case 0x1b: psxDIVU(); return;
				case 0x20: psxADD(); return;
				case 0x21: psxADDU(); return;
				case 0x22: psxSUB(); return;
				case 0x23: psxSUBU(); return;
				case 0x24: psxAND(); return;
				case 0x25: psxOR(); return;
				case 0x26: psxXOR(); return;
				case 0x27: psxNOR(); return;
				case 0x2a: psxSLT(); return;
				case 0x2b: psxSLTU(); return;
				default: psxNULL(); return;
			}
		case 0x01:
			switch ((psxRegs.code >> 16) & 0x1f) {
				case 0x00: psxBLTZ(); return;
				case 0x01: psxBGEZ(); return;
				case 0x10: psxBLTZAL(); return;
				case 0x11: psxBGEZAL(); return;
				default: psxNULL(); return;
			}
		case 0x02: psxJ(); return;
		case 0x03: psxJAL(); return;
		case 0x04: psxBEQ(); return;
		case 0x05: psxBNE(); return;
		case 0x06: psxBLEZ(); return;
		case 0x07: psxBGTZ(); return;
		case 0x08: psxADDI(); return;
		case 0x09: psxADDIU(); return;
		case 0x0a: psxSLTI(); return;
		case 0x0b: psxSLTIU(); return;
		case 0x0c: psxANDI(); return;
		case 0x0d: psxORI(); return;
		case 0x0e: psxXORI(); return;
		case 0x0f: psxLUI(); return;
		case 0x10: psxCOP0(); return;
		case 0x12: psxCOP2(); return;
		case 0x20: psxLB(); return;
		case 0x21: psxLH(); return;
		case 0x22: psxLWL(); return;
		case 0x23: psxLW(); return;
		case 0x24: psxLBU(); return;
		case 0x25: psxLHU(); return;
		case 0x26: psxLWR(); return;
		case 0x28: psxSB(); return;
		case 0x29: psxSH(); return;
		case 0x2a: psxSWL(); return;
		case 0x2b: psxSW(); return;
		case 0x2e: psxSWR(); return;
		case 0x32: gteLWC2(); return;
		case 0x3a: gteSWC2(); return;
		case 0x3b: psxHLE(); return;
		default: psxNULL(); return;
	}
}

#ifdef PS1_PCHIST
u32 ps1_pch[1 << 19];
u32 *ps1_pchist(void) { return ps1_pch; }
#endif
void execI() { 
	//printf("execI\n");
#ifdef PS1_PCHIST
	ps1_pch[(psxRegs.pc & 0x1fffff) >> 2]++;
#endif
	u32 *code = (u32 *)PSXM(psxRegs.pc);
	psxRegs.code = ((code == NULL) ? 0 : SWAP32(*code));

	debugI();
	

	psxRegs.pc += 4;
	psxRegs.cycle += BIAS;

	psxExecOp();
}

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif


static void intExecute() {

#ifdef __EMSCRIPTEN__
  // void emscripten_set_main_loop(em_callback_func func, int fps, int simulate_infinite_loop);
  emscripten_set_main_loop(execI, 0, 1);
#else
  while (1) {
    execI();
  }
#endif
}



static void intExecuteBlock() {
	branch2 = 0;
	while (!branch2) execI();
}

static void intClear(u32 Addr, u32 Size) {
}

static void intShutdown() {
}

// interpreter execution


R3000Acpu psxInt = {
	intInit,
	intReset,
	intExecute,
	intExecuteBlock,
	intClear,
	intShutdown
};

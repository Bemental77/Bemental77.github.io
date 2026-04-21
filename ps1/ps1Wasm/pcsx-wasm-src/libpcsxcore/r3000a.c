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
* R3000A CPU functions.
*/

#include "r3000a.h"
#include "cdrom.h"
#include "mdec.h"
#include "gte.h"

R3000Acpu *psxCpu = NULL;
psxRegisters psxRegs;

int psxInit() {
	SysPrintf(_("Running PCSX Version %s (%s).\n"), PACKAGE_VERSION, __DATE__);

#if 0
	if (Config.Cpu == CPU_INTERPRETER) {
		psxCpu = &psxInt;
	} else psxCpu = &psxRec;
#else
	psxCpu = &psxInt;
#endif

	Log = 0;

	if (psxMemInit() == -1) return -1;

	return psxCpu->Init();
}

void psxReset() {
	psxCpu->Reset();

	psxMemReset();

	memset(&psxRegs, 0, sizeof(psxRegs));

	psxRegs.pc = 0xbfc00000; // Start in bootstrap

	psxRegs.CP0.r[12] = 0x10900000; // COP0 enabled | BEV = 1 | TS = 1
	psxRegs.CP0.r[15] = 0x00000002; // PRevID = Revision ID, same as R3000A

	psxHwReset();
	psxBiosInit();

	if (!Config.HLE)
		psxExecuteBios();

#ifdef EMU_LOG
	EMU_LOG("*BIOS END*\n");
#endif
	Log = 0;
}

void psxShutdown() {
	psxMemShutdown();
	psxBiosShutdown();

	psxCpu->Shutdown();
}

void psxException(u32 code, u32 bd) {
	{ static u32 _n=0; _n++; if (_n < 10 || (_n & 0x7f)==0) SysPrintf("[DIAG-EXC] #%u code=%08x epc=%08x istat=%08x imask=%08x\n", _n, code, psxRegs.pc, psxHu32(0x1070), psxHu32(0x1074)); }
	// Set the Cause
	psxRegs.CP0.n.Cause = code;

	// Set the EPC & PC
	if (bd) {
#ifdef PSXCPU_LOG
		PSXCPU_LOG("bd set!!!\n");
#endif
		SysPrintf("bd set!!!\n");
		psxRegs.CP0.n.Cause |= 0x80000000;
		psxRegs.CP0.n.EPC = (psxRegs.pc - 4);
	} else
		psxRegs.CP0.n.EPC = (psxRegs.pc);

	if (psxRegs.CP0.n.Status & 0x400000)
		psxRegs.pc = 0xbfc00180;
	else
		psxRegs.pc = 0x80000080;

	// Set the Status
	psxRegs.CP0.n.Status = (psxRegs.CP0.n.Status &~0x3f) |
						  ((psxRegs.CP0.n.Status & 0xf) << 2);

	if (!Config.HLE && (((PSXMu32(psxRegs.CP0.n.EPC) >> 24) & 0xfe) == 0x4a)) {
		// "hokuto no ken" / "Crash Bandicot 2" ... fix
		PSXMu32ref(psxRegs.CP0.n.EPC)&= SWAPu32(~0x02000000);
	}

	if (Config.HLE) psxBiosException();
}

void psxBranchTest() {
	/* DIAG: PC range sampling each call, heartbeat every ~5M cycles */
	{
		static u32 _diag_last_cycle = 0;
		static u32 _diag_last_pc = 0;
		static int _diag_stuck_count = 0;
		static u32 _diag_pc_min = 0xffffffff;
		static u32 _diag_pc_max = 0;
		static u32 _diag_last_ra = 0;
		/* sample PC range */
		if (psxRegs.pc < _diag_pc_min) _diag_pc_min = psxRegs.pc;
		if (psxRegs.pc > _diag_pc_max) _diag_pc_max = psxRegs.pc;
		if (psxRegs.GPR.n.ra != _diag_last_ra) _diag_last_ra = psxRegs.GPR.n.ra;
		u32 _diag_delta = psxRegs.cycle - _diag_last_cycle;
		if (_diag_delta >= 5000000) {
			if (psxRegs.pc == _diag_last_pc) _diag_stuck_count++;
			else _diag_stuck_count = 0;
			SysPrintf("[DIAG] pc=%08x ra=%08x cyc=%u dc=%u intr=%08x IMSK=%08x ISTT=%08x SR=%08x stuck=%d pcrng=%08x..%08x\n",
				psxRegs.pc, psxRegs.GPR.n.ra, psxRegs.cycle, _diag_delta, psxRegs.interrupt,
				psxHu32(0x1074), psxHu32(0x1070), psxRegs.CP0.n.Status, _diag_stuck_count,
				_diag_pc_min, _diag_pc_max);
			_diag_pc_min = 0xffffffff;
			_diag_pc_max = 0;
			/* re-fire dump every 20 stuck heartbeats so it stays in the rolling console */
			if (_diag_stuck_count >= 2 && (_diag_stuck_count % 20) == 0 && (psxRegs.pc & 0xffe00000) == 0x80000000) {
				u32 ra = psxRegs.GPR.n.ra;
				u32 pc = psxRegs.pc;
				SysPrintf("[DIAG-CODE] pc-16 @%08x: %08x %08x %08x %08x %08x %08x %08x %08x\n",
					pc - 16, PSXMu32(pc - 16), PSXMu32(pc - 12), PSXMu32(pc - 8), PSXMu32(pc - 4),
					PSXMu32(pc), PSXMu32(pc + 4), PSXMu32(pc + 8), PSXMu32(pc + 12));
				if ((ra & 0xffe00000) == 0x80000000) {
					/* Dump the full range 0x8008e500..0x8008e660 (thread entry + retry loop) */
					u32 base = ra & ~0xff;  /* page-align back to show whole area */
					int k;
					for (k = 0; k < 0x180; k += 32) {
						SysPrintf("[DIAG-CODE] @%08x: %08x %08x %08x %08x %08x %08x %08x %08x\n",
							base + k,
							PSXMu32(base + k), PSXMu32(base + k + 4),
							PSXMu32(base + k + 8), PSXMu32(base + k + 12),
							PSXMu32(base + k + 16), PSXMu32(base + k + 20),
							PSXMu32(base + k + 24), PSXMu32(base + k + 28));
					}
					/* Dump the stub area at pc */
					u32 pbase = pc & ~0x1f;
					for (k = 0; k < 0x40; k += 32) {
						SysPrintf("[DIAG-CODE] stub @%08x: %08x %08x %08x %08x %08x %08x %08x %08x\n",
							pbase + k,
							PSXMu32(pbase + k), PSXMu32(pbase + k + 4),
							PSXMu32(pbase + k + 8), PSXMu32(pbase + k + 12),
							PSXMu32(pbase + k + 16), PSXMu32(pbase + k + 20),
							PSXMu32(pbase + k + 24), PSXMu32(pbase + k + 28));
					}
				}
			}
			_diag_last_cycle = psxRegs.cycle;
			_diag_last_pc = psxRegs.pc;
		}
	}

	if ((psxRegs.cycle - psxNextsCounter) >= psxNextCounter)
		psxRcntUpdate();

	if (psxRegs.interrupt) {
		if ((psxRegs.interrupt & 0x80) && !Config.Sio) { // sio
			if ((psxRegs.cycle - psxRegs.intCycle[7]) >= psxRegs.intCycle[7 + 1]) {
				psxRegs.interrupt &= ~0x80;
				sioInterrupt();
			}
		}
		if (psxRegs.interrupt & 0x04) { // cdr
			if ((psxRegs.cycle - psxRegs.intCycle[2]) >= psxRegs.intCycle[2 + 1]) {
				psxRegs.interrupt &= ~0x04;
				cdrInterrupt();
			}
		}
		if (psxRegs.interrupt & 0x040000) { // cdr read
			if ((psxRegs.cycle - psxRegs.intCycle[2 + 16]) >= psxRegs.intCycle[2 + 16 + 1]) {
				psxRegs.interrupt &= ~0x040000;
				cdrReadInterrupt();
			}
		}
		if (psxRegs.interrupt & 0x01000000) { // gpu dma
			if ((psxRegs.cycle - psxRegs.intCycle[3 + 24]) >= psxRegs.intCycle[3 + 24 + 1]) {
				psxRegs.interrupt &= ~0x01000000;
				gpuInterrupt();
			}
		}
		if (psxRegs.interrupt & 0x02000000) { // mdec out dma
			if ((psxRegs.cycle - psxRegs.intCycle[5 + 24]) >= psxRegs.intCycle[5 + 24 + 1]) {
				psxRegs.interrupt &= ~0x02000000;
				mdec1Interrupt();
			}
		}
		if (psxRegs.interrupt & 0x04000000) { // spu dma
			if ((psxRegs.cycle - psxRegs.intCycle[1 + 24]) >= psxRegs.intCycle[1 + 24 + 1]) {
				psxRegs.interrupt &= ~0x04000000;
				spuInterrupt();
			}
		}
	}

	if (psxHu32(0x1070) & psxHu32(0x1074)) {
		if ((psxRegs.CP0.n.Status & 0x401) == 0x401) {
#ifdef PSXCPU_LOG
			PSXCPU_LOG("Interrupt: %x %x\n", psxHu32(0x1070), psxHu32(0x1074));
#endif
//			SysPrintf("Interrupt (%x): %x %x\n", psxRegs.cycle, psxHu32(0x1070), psxHu32(0x1074));
			psxException(0x400, 0);
		}
	}
}

void psxJumpTest() {
	if (!Config.HLE && Config.PsxOut) {
		u32 call = psxRegs.GPR.n.t1 & 0xff;
		switch (psxRegs.pc & 0x1fffff) {
			case 0xa0:
#ifdef PSXBIOS_LOG
				if (call != 0x28 && call != 0xe) {
					PSXBIOS_LOG("Bios call a0: %s (%x) %x,%x,%x,%x\n", biosA0n[call], call, psxRegs.GPR.n.a0, psxRegs.GPR.n.a1, psxRegs.GPR.n.a2, psxRegs.GPR.n.a3); }
#endif
				if (biosA0[call])
					biosA0[call]();
				break;
			case 0xb0:
#ifdef PSXBIOS_LOG
				if (call != 0x17 && call != 0xb) {
					PSXBIOS_LOG("Bios call b0: %s (%x) %x,%x,%x,%x\n", biosB0n[call], call, psxRegs.GPR.n.a0, psxRegs.GPR.n.a1, psxRegs.GPR.n.a2, psxRegs.GPR.n.a3); }
#endif
				if (biosB0[call])
					biosB0[call]();
				break;
			case 0xc0:
#ifdef PSXBIOS_LOG
				PSXBIOS_LOG("Bios call c0: %s (%x) %x,%x,%x,%x\n", biosC0n[call], call, psxRegs.GPR.n.a0, psxRegs.GPR.n.a1, psxRegs.GPR.n.a2, psxRegs.GPR.n.a3);
#endif
				if (biosC0[call])
					biosC0[call]();
				break;
		}
	}
}

void psxExecuteBios() {
	while (psxRegs.pc != 0x80030000)
		psxCpu->ExecuteBlock();
}


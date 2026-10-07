/*
 * Copyright (c) 2009, Wei Mingzhi <whistler@openoffice.org>.
 * All Rights Reserved.
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, see <http://www.gnu.org/licenses>.
 */

#include "pad.h"


long PADinit(long flags) {
	LoadPADConfig();

	g.PadState[0].PadMode = 0;
	g.PadState[0].PadID = 0x41;
	g.PadState[1].PadMode = 0;
	g.PadState[1].PadID = 0x41;
	g.PadState[0].JoyKeyStatus = 0xFFFF;
    g.PadState[1].JoyKeyStatus = 0xFFFF;
	// The multitap's slots C and D: digital pads at rest until the page latches them.
	g.PadState[2].PadMode = 0;
	g.PadState[2].PadID = 0x41;
	g.PadState[3].PadMode = 0;
	g.PadState[3].PadID = 0x41;
	g.PadState[2].KeyStatus = g.PadState[2].JoyKeyStatus = 0xFFFF;
	g.PadState[3].KeyStatus = g.PadState[3].JoyKeyStatus = 0xFFFF;

	return PSE_PAD_ERR_SUCCESS;
}

long PADshutdown(void) {
	PADclose();
	return PSE_PAD_ERR_SUCCESS;
}

long PADopen(unsigned long *Disp) {
	if (!g.Opened) {
		g.PadState[0].JoyKeyStatus = 0xFFFF;
		g.PadState[1].JoyKeyStatus = 0xFFFF;
		g.PadState[2].JoyKeyStatus = 0xFFFF;
		g.PadState[3].JoyKeyStatus = 0xFFFF;
		g.KeyLeftOver = 0;
	}

	g.Opened = 1;

	return PSE_PAD_ERR_SUCCESS;
}

long PADclose(void) {
	if (g.Opened) {

	}

	g.Opened = 0;

	return PSE_PAD_ERR_SUCCESS;
}

long PADquery(void) {
	return PSE_PAD_USE_PORT1 | PSE_PAD_USE_PORT2;
}

static void UpdateInput(void) {

}

static uint8_t stdpar[2][8] = {
	{0xFF, 0x5A, 0xFF, 0xFF, 0x80, 0x80, 0x80, 0x80},
	{0xFF, 0x5A, 0xFF, 0xFF, 0x80, 0x80, 0x80, 0x80}
};

static uint8_t unk46[2][8] = {
	{0xFF, 0x5A, 0x00, 0x00, 0x01, 0x02, 0x00, 0x0A},
	{0xFF, 0x5A, 0x00, 0x00, 0x01, 0x02, 0x00, 0x0A}
};

static uint8_t unk47[2][8] = {
	{0xFF, 0x5A, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00},
	{0xFF, 0x5A, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00}
};

static uint8_t unk4c[2][8] = {
	{0xFF, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
	{0xFF, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
};

static uint8_t unk4d[2][8] = { 
	{0xFF, 0x5A, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF},
	{0xFF, 0x5A, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF}
};

static uint8_t stdcfg[2][8]   = { 
	{0xFF, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
	{0xFF, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
};

static uint8_t stdmode[2][8]  = { 
	{0xFF, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
	{0xFF, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
};

static uint8_t stdmodel[2][8] = { 
	{0xFF,
	 0x5A,
	 0x01, // 03 - dualshock2, 01 - dualshock
	 0x02, // number of modes
	 0x01, // current mode: 01 - analog, 00 - digital
	 0x02,
	 0x01,
	 0x00},
	{0xFF, 
	 0x5A,
	 0x01, // 03 - dualshock2, 01 - dualshock
	 0x02, // number of modes
	 0x01, // current mode: 01 - analog, 00 - digital
	 0x02,
	 0x01,
	 0x00}
};

static uint8_t CurPad = 0, CurByte = 0, CurCmd = 0, CmdLen = 0;

unsigned char PADstartPoll(int pad) {
	CurPad = pad - 1;
	CurByte = 0;

	return 0xFF;
}

unsigned char PADpoll(unsigned char value) {
	
	static uint8_t		*buf = NULL;
	uint16_t			n;
	if (CurByte == 0) {
		CurByte++;

		// Don't enable Analog/Vibration for a standard pad
		if (g.cfg.PadDef[CurPad].Type != PSE_PAD_TYPE_ANALOGPAD) {
			CurCmd = CMD_READ_DATA_AND_VIBRATE;
		} else {
			CurCmd = value;
		}

		switch (CurCmd) {
			case CMD_CONFIG_MODE:
				CmdLen = 8;
				buf = stdcfg[CurPad];
				if (stdcfg[CurPad][3] == 0xFF) return 0xF3;
				else return g.PadState[CurPad].PadID;

			case CMD_SET_MODE_AND_LOCK:
				CmdLen = 8;
				buf = stdmode[CurPad];
				return 0xF3;

			case CMD_QUERY_MODEL_AND_MODE:
				CmdLen = 8;
				buf = stdmodel[CurPad];
				buf[4] = g.PadState[CurPad].PadMode;
				return 0xF3;

			case CMD_QUERY_ACT:
				CmdLen = 8;
				buf = unk46[CurPad];
				return 0xF3;

			case CMD_QUERY_COMB:
				CmdLen = 8;
				buf = unk47[CurPad];
				return 0xF3;

			case CMD_QUERY_MODE:
				CmdLen = 8;
				buf = unk4c[CurPad];
				return 0xF3;

			case CMD_VIBRATION_TOGGLE:
				CmdLen = 8;
				buf = unk4d[CurPad];
				return 0xF3;

			case CMD_READ_DATA_AND_VIBRATE:
			default:
				UpdateInput();

				n = g.PadState[CurPad].KeyStatus;
				n &= g.PadState[CurPad].JoyKeyStatus;

				stdpar[CurPad][2] = n & 0xFF;
				stdpar[CurPad][3] = n >> 8;

				if (g.PadState[CurPad].PadMode == 1) {
					CmdLen = 8;

					stdpar[CurPad][4] = g.PadState[CurPad].AnalogStatus[ANALOG_RIGHT][0];
					stdpar[CurPad][5] = g.PadState[CurPad].AnalogStatus[ANALOG_RIGHT][1];
					stdpar[CurPad][6] = g.PadState[CurPad].AnalogStatus[ANALOG_LEFT][0];
					stdpar[CurPad][7] = g.PadState[CurPad].AnalogStatus[ANALOG_LEFT][1];
				} else {
					CmdLen = 4;
				}

				buf = stdpar[CurPad];
				return g.PadState[CurPad].PadID;
		}
	}

	switch (CurCmd) {
		case CMD_CONFIG_MODE:
			if (CurByte == 2) {
				switch (value) {
					case 0:
						buf[2] = 0;
						buf[3] = 0;
						break;

					case 1:
						buf[2] = 0xFF;
						buf[3] = 0xFF;
						break;
				}
			}
			break;

		case CMD_SET_MODE_AND_LOCK:
			if (CurByte == 2) {
				g.PadState[CurPad].PadMode = value;
				g.PadState[CurPad].PadID = value ? 0x73 : 0x41;
			}
			break;

		case CMD_QUERY_ACT:
			if (CurByte == 2) {
				switch (value) {
					case 0: // default
						buf[5] = 0x02;
						buf[6] = 0x00;
						buf[7] = 0x0A;
						break;

					case 1: // Param std conf change
						buf[5] = 0x01;
						buf[6] = 0x01;
						buf[7] = 0x14;
						break;
				}
			}
			break;

		case CMD_QUERY_MODE:
			if (CurByte == 2) {
				switch (value) {
					case 0: // mode 0 - digital mode
						buf[5] = PSE_PAD_TYPE_STANDARD;
						break;

					case 1: // mode 1 - analog mode
						buf[5] = PSE_PAD_TYPE_ANALOGPAD;
						break;
				}
			}
			break;
	}

	if (CurByte >= CmdLen) return 0;
	return buf[CurByte++];
}

static long PADreadPort(int num, PadDataS *pad) {
	UpdateInput();

	pad->buttonStatus = (g.PadState[num].KeyStatus & g.PadState[num].JoyKeyStatus);

	// ePSXe different from pcsx, swap bytes
	pad->buttonStatus = (pad->buttonStatus >> 8) | (pad->buttonStatus << 8);

	switch (g.cfg.PadDef[num].Type) {
		case PSE_PAD_TYPE_ANALOGPAD: // Analog Controller SCPH-1150
			pad->controllerType = PSE_PAD_TYPE_ANALOGPAD;
			pad->rightJoyX = g.PadState[num].AnalogStatus[ANALOG_RIGHT][0];
			pad->rightJoyY = g.PadState[num].AnalogStatus[ANALOG_RIGHT][1];
			pad->leftJoyX = g.PadState[num].AnalogStatus[ANALOG_LEFT][0];
			pad->leftJoyY = g.PadState[num].AnalogStatus[ANALOG_LEFT][1];
			break;

		case PSE_PAD_TYPE_STANDARD: // Standard Pad SCPH-1080, SCPH-1150
		default:
			pad->controllerType = PSE_PAD_TYPE_STANDARD;
			break;
	}

	return PSE_PAD_ERR_SUCCESS;
}

long PADreadPort1(PadDataS *pad) {
	return PADreadPort(0, pad);
}

long PADreadPort2(PadDataS *pad) {
	return PADreadPort(1, pad);
}

long PADkeypressed(void) {
	long s;

	//CheckKeyboard();

	s = g.KeyLeftOver;
	g.KeyLeftOver = 0;
	
	return s;
}

#ifndef _MACOSX

long PADconfigure(void) {
	return PSE_PAD_ERR_SUCCESS;
}

void PADabout(void) {

}

#endif

long PADtest(void) {
	return PSE_PAD_ERR_SUCCESS;
}

void * get_PadState_ptr(){
	return &(g.PadState[0]);
}

/* ══ THE MULTITAP (SCPH-1070) IN PORT 1 ═════════════════════════════════════════
 * PCSX had none. This is the protocol of Mednafen's InputDevice_Multitap (as
 * carried in beetle-psx-libretro mednafen/psx/frontio.c: Power / SetDTR /
 * Clock), translated from its bit clock to PCSX's byte-at-a-time SIO
 * (libpcsxcore/sio.c calls PADmtSelect on every port-1 DTR edge and PADmtByte
 * for every byte sent to port 1 while one is plugged in):
 *
 *   * a transfer starts when DTR is asserted. The address byte selects:
 *       0x01..0x04 -> slot A..D, passed straight through ("pass" mode);
 *       0x81       -> slot A's memory card (the console's card path in sio.c);
 *       0x82..0x84 -> no card behind those slots: nothing answers;
 *     unless the transfer is a FULL ("all four") one, see below.
 *   * the third byte of every pad transfer (the "TAP" byte) sets
 *     full_mode_setting = bit 0, which takes effect at the NEXT DTR assert.
 *   * a FULL transfer answers 0x80, 0x5A, then four 8-byte blocks, one per slot
 *     (a digital pad's block: ID 0x41, 0x5A, buttons lo, hi, then 0xFF). Each
 *     slot is sent the 8 bytes the host put in ITS block of the previous full
 *     transfer (sb[]; {0x42,0,..} when there was none) — the multitap buffers
 *     one transfer's worth of commands. A command byte other than 0x42 ends it
 *     after the fourth byte (fm_command_error). prev_fm_success marks a
 *     completed full transfer.
 *   * a slot with no pad (slots < 4) answers 0xFF and never ACKs; in a FULL
 *     transfer its block reads 0xFF.
 * The pad behind each slot answers exactly as PADpoll() answers for the plain
 * console's standard pad (sio.c's buffer length rule, the 0x43/0x45 ID quirk),
 * so slot A passed through is the port-1 pad the console always had.
 * While a multitap is in, port 2 has no pad (sio.c answers nothing there).
 *
 * slots == 0 — the plain two-port console — is decided by the page before
 * frame 0 and never touches any of this.
 */
MULTITAP PadMultitap;

enum { MT_IDLE = 0, MT_FULL, MT_PASS, MT_HIZ, MT_CARD };

int PADmtSlots(void) {
	return PadMultitap.slots;
}

static void mt_reset_protocol(void) {
	int32_t slots = PadMultitap.slots;
	int i;
	memset(&PadMultitap, 0, sizeof(PadMultitap));
	PadMultitap.slots = slots;
	for (i = 0; i < 4; i++) PadMultitap.sb[i][0] = 0x42;
}

// Plug in a multitap with `slots` pads (1..4), or pull it out (0). Called by
// the page through the worker ('netMultitap') before the first frame; returns
// what is now plugged in.
int ps1_multitap(int slots) {
	PadMultitap.slots = slots < 0 ? 0 : slots > 4 ? 4 : slots;
	mt_reset_protocol();
	return PadMultitap.slots;
}

// RIG ONLY (tools/ps1_rollback_probe.mjs --mt-poke): scramble the multitap's
// protocol state, so a test can show that it reaches the guest and that a
// rollback load restores it. Never called by the page.
int ps1_mt_poke(void) {
	int i, j;
	PadMultitap.full_mode_setting ^= 1;
	PadMultitap.prev_fm_success ^= 1;
	for (i = 0; i < 4; i++) for (j = 0; j < 8; j++) { PadMultitap.sb[i][j] ^= 0x5A; PadMultitap.fm[i][j] ^= 0x5A; }
	return PadMultitap.full_mode_setting;
}

void PADmtSelect(int dtr) {
	MULTITAP *m = &PadMultitap;
	int old = m->dtr, i;
	m->dtr = dtr ? 1 : 0;
	if (!m->dtr) {
		m->k = 0; m->mode = MT_IDLE; m->mc = 0; m->full_mode = 0;
	}
	if (!old && m->dtr) {
		m->full_mode = m->full_mode_setting;
		if (!m->prev_fm_success) {
			memset(m->sb, 0, sizeof(m->sb));
			for (i = 0; i < 4; i++) m->sb[i][0] = 0x42;
		}
		m->prev_fm_success = 0;
		m->k = 0; m->mode = MT_IDLE; m->mc = 0;
	}
}

// What the standard pad in `slot` answers at position `pos` of its reply
// (pos 0 answers the command byte), and its reply length — PADpoll()'s
// CMD_READ_DATA_AND_VIBRATE path and sio.c's `2 + (ID & 0x0f) * 2` rule.
static int mt_pad(int slot, int pos, int cmd, int *len) {
	PADSTATE *p = &g.PadState[slot];
	uint16_t n = p->KeyStatus & p->JoyKeyStatus;
	int id = p->PadID;
	*len = (id & 0x0f) ? 2 + (id & 0x0f) * 2 : 2 + 32;
	if (*len > 8) *len = 8;
	switch (pos) {
	case 0:
		if (id == 0x41 && cmd == 0x43) return 0x43;	// sio.c's quirk for a digital pad
		if (id == 0x41 && cmd == 0x45) return 0xf3;
		return id;
	case 1: return 0x5a;
	case 2: return n & 0xff;
	case 3: return n >> 8;
	case 4: return p->PadMode == 1 ? p->AnalogStatus[ANALOG_RIGHT][0] : 0xff;
	case 5: return p->PadMode == 1 ? p->AnalogStatus[ANALOG_RIGHT][1] : 0xff;
	case 6: return p->PadMode == 1 ? p->AnalogStatus[ANALOG_LEFT][0] : 0xff;
	case 7: return p->PadMode == 1 ? p->AnalogStatus[ANALOG_LEFT][1] : 0xff;
	}
	return 0xff;
}

// One byte to port 1. Returns 0 when the byte belongs to slot A's MEMORY CARD
// (sio.c then runs the console's own card path), else 1 with the reply in
// *out and *ack = whether the device ACKs it (sio.c raises the SIO interrupt).
int PADmtByte(unsigned char in, unsigned char *out, int *ack) {
	MULTITAP *m = &PadMultitap;
	int k = m->k, len, i, j;
	*out = 0xff; *ack = 0;
	if (m->k < 255) m->k++;
	if (k == 0) {
		m->mc = (in & 0xf0) ? 1 : 0;
		if (m->mc) {
			m->full_mode = 0;
			if (in == 0x81) { m->mode = MT_CARD; return 0; }
			m->mode = MT_HIZ;
			return 1;
		}
		if (m->full_mode) {
			memset(m->fm, 0xff, sizeof(m->fm));
			m->fm_err = 0;
			m->mode = MT_FULL;
			*ack = 1;
			return 1;
		}
		m->sel = (unsigned char)((in & 0x0f) - 1);
		if (m->sel < m->slots) { m->mode = MT_PASS; *ack = 1; }
		else m->mode = MT_HIZ;
		return 1;
	}
	if (m->mode == MT_CARD) return 0;
	if (k == 2 && !m->mc) m->full_mode_setting = in & 1;
	switch (m->mode) {
	case MT_PASS:
		*out = (unsigned char)mt_pad(m->sel, k - 1, in, &len);
		if (k - 1 < len - 1) *ack = 1;
		else m->mode = MT_HIZ;		// its last byte: no ACK, and nothing more answers
		return 1;
	case MT_FULL:
		if (k == 1) {
			if (in != 0x42) m->fm_err = 1;
			*out = 0x80; *ack = 1;
			return 1;
		}
		if (k == 2) {
			*out = 0x5a; *ack = m->slots > 0;
			if (!*ack) m->mode = MT_HIZ;
			return 1;
		}
		if (k == 3 && !m->fm_err) {
			for (i = 0; i < m->slots; i++)
				for (j = 0; j < 8; j++) {
					int c = mt_pad(i, j, m->sb[i][0], &len);
					m->fm[i][j] = j < len ? (unsigned char)c : 0xff;
				}
		}
		if (k >= 3 && k < 35) {
			int x = k - 3;
			*out = m->fm[x >> 3][x & 7];
			m->sb[x >> 3][x & 7] = in;
			if (k == 3 && m->fm_err) { m->mode = MT_HIZ; return 1; }
			if (k == 33) m->prev_fm_success = 1;
			if (k < 34) *ack = 1;
			else m->mode = MT_HIZ;
			return 1;
		}
		m->mode = MT_HIZ;
		return 1;
	default:
		return 1;	// MT_HIZ / MT_IDLE: nothing drives the line
	}
}
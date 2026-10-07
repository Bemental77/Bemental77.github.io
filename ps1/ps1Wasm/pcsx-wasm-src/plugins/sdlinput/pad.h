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

#ifndef PAD_H_
#define PAD_H_

// not using thread
#define volatile 

#ifdef __cplusplus
extern "C" {
#endif

#ifndef _MACOSX
#include "config.h"
#endif

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>

#include <SDL/SDL.h>
//#include <SDL_joystick.h>

#include "psemu_plugin_defs.h"

#ifdef ENABLE_NLS
#include <libintl.h>
#include <locale.h>
#define _(x)  gettext(x)
#define N_(x) (x)
#else
#define _(x)  (x)
#define N_(x) (x)
#endif

enum {
	DKEY_SELECT = 0,
	DKEY_L3,
	DKEY_R3,
	DKEY_START,
	DKEY_UP,
	DKEY_RIGHT,
	DKEY_DOWN,
	DKEY_LEFT,
	DKEY_L2,
	DKEY_R2,
	DKEY_L1,
	DKEY_R1,
	DKEY_TRIANGLE,
	DKEY_CIRCLE,
	DKEY_CROSS,
	DKEY_SQUARE,

	DKEY_TOTAL
};

enum {
	ANALOG_LEFT = 0,
	ANALOG_RIGHT,

	ANALOG_TOTAL
};

enum { NONE = 0, AXIS, HAT, BUTTON };

typedef struct tagKeyDef {
	uint8_t			JoyEvType;
	union {
		int16_t		d;
		int16_t		Axis;   // positive=axis+, negative=axis-, abs(Axis)-1=axis index
		uint16_t	Hat;	// 8-bit for hat number, 8-bit for direction
		uint16_t	Button; // button number
	} J;
	SDLKey		Key;
} KEYDEF;

enum { ANALOG_XP = 0, ANALOG_XM, ANALOG_YP, ANALOG_YM };

typedef struct tagPadDef {
	int8_t			DevNum;
	uint16_t		Type;
	KEYDEF			KeyDef[DKEY_TOTAL];
	KEYDEF			AnalogDef[ANALOG_TOTAL][4];
} PADDEF;

typedef struct tagConfig {
	uint8_t			Threaded;
	PADDEF			PadDef[2];
} CONFIG;

typedef struct tagPadState {
	SDL_Joystick		*JoyDev;
	uint8_t				PadMode;
	uint8_t				PadID;
	volatile uint16_t	KeyStatus;
	volatile uint16_t	JoyKeyStatus;
	volatile uint8_t	AnalogStatus[ANALOG_TOTAL][2]; // 0-255 where 127 is center position
	volatile uint8_t	AnalogKeyStatus[ANALOG_TOTAL][4];
} PADSTATE;

// PadState[0] / [1] are the console's ports 1 and 2. With a MULTITAP in port 1
// (PadMultitap.slots > 0, decided by the page before frame 0) PadState[0..3]
// are its slots A-D and port 2 is empty. The page latches the whole array as
// one contiguous image at get_ptr(-2): 2 x 24 bytes for the plain console, as
// always, or 4 x 24 with the multitap.
#define PAD_STATES 4

typedef struct tagGlobalData {
	CONFIG				cfg;

	uint8_t				Opened;
	//Display				*Disp;

	PADSTATE			PadState[PAD_STATES];
	volatile long		KeyLeftOver;
} GLOBALDATA;

// THE MULTITAP (SCPH-1070) IN PORT 1 — the protocol of Mednafen's
// InputDevice_Multitap (psx/input/multitap.cpp; beetle-psx frontio.c), driven
// byte by byte from sio.c. All of it is plain static data, so the worker's
// raw-memory rollback snapshot ([1024, sbrk)) carries it with the rest of the
// machine.
typedef struct tagMultitap {
	int32_t				slots;			// pads plugged into it (0 = no multitap: the plain console)
	uint8_t				dtr;			// port 1 selected with DTR asserted
	uint8_t				k;				// byte index in this transfer (0 = address)
	uint8_t				mode;			// MT_IDLE .. MT_CARD
	uint8_t				sel;			// pass-through slot
	uint8_t				mc;				// this transfer is a memory-card one
	uint8_t				full_mode_setting;	// TAP byte bit 0 of the last transfer: next one is "all four"
	uint8_t				full_mode;		// latched at DTR assert
	uint8_t				prev_fm_success;
	uint8_t				fm_err;
	uint8_t				sb[4][8];		// bytes the host sent each slot last full transfer = its next command
	uint8_t				fm[4][8];		// each slot's reply in this full transfer
} MULTITAP;

extern MULTITAP			PadMultitap;

int PADmtSlots(void);
void PADmtSelect(int dtr);
int PADmtByte(unsigned char in, unsigned char *out, int *ack);

extern GLOBALDATA		g;

enum {
	CMD_READ_DATA_AND_VIBRATE = 0x42,
	CMD_CONFIG_MODE = 0x43,
	CMD_SET_MODE_AND_LOCK = 0x44,
	CMD_QUERY_MODEL_AND_MODE = 0x45,
	CMD_QUERY_ACT = 0x46, // ??
	CMD_QUERY_COMB = 0x47, // ??
	CMD_QUERY_MODE = 0x4C, // QUERY_MODE ??
	CMD_VIBRATION_TOGGLE = 0x4D,
};

// cfg.c functions...
void LoadPADConfig();
void SavePADConfig();

// sdljoy.c functions...
void InitSDLJoy();
void DestroySDLJoy();
void CheckJoy();

// xkb.c functions...
void InitKeyboard();
void DestroyKeyboard();
void CheckKeyboard();

// analog.c functions...
void InitAnalog();
void CheckAnalog();
int AnalogKeyPressed(uint16_t Key);
int AnalogKeyReleased(uint16_t Key);

// pad.c functions...
/*
char *PSEgetLibName(void);
uint32_t PSEgetLibType(void);
uint32_t PSEgetLibVersion(void);
*/
long PADinit(long flags);
long PADshutdown(void);
long PADopen(unsigned long *Disp);
long PADclose(void);
long PADquery(void);
unsigned char PADstartPoll(int pad);
unsigned char PADpoll(unsigned char value);
long PADreadPort1(PadDataS *pad);
long PADreadPort2(PadDataS *pad);
long PADkeypressed(void);
long PADconfigure(void);
void PADabout(void);
long PADtest(void);

#ifdef __cplusplus
}
#endif

#endif

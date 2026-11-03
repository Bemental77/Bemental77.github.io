/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * (Derived from the MPL-2.0 Spuds0588/mgba-splitscreen sources at the commit pinned in gba/mgba/SOURCE.md; see that file.) */
/* bemental_gba.h - constants shared by the bridge (bemental_gba.c, legacy_mgs.c) and documented in gba/mgba/README.md.
 * gba/mgba/mgba_core.js carries the same numbers; tools/gba_mgba_core_test.mjs fails if the two drift. */
#ifndef BEMENTAL_GBA_H
#define BEMENTAL_GBA_H

#include <stddef.h>
#include <stdint.h>

#define BGB_ABI_VERSION 1

/* bgb_run_frame() return value: 0 = clean, otherwise a bitmask. */
#define BGB_ST_STALL 1         /* no seat could move while one still owed a frame (a link stall) */
#define BGB_ST_RECOVERED 2     /* the watchdog fired and woke every seat (GBASIOLockstepCoordinatorRecover) */
#define BGB_ST_STEP_CAP 4      /* the per-call step cap (or runFrame's own cap) ended the call early */
#define BGB_ST_MULTI_NODATA 8  /* a MULTI round completed without every secondary's ack: FFFF was delivered */
#define BGB_ST_NOT_LOADED 0x80

/* Incident kinds (struct Incident.kind). */
#define BGB_INC_LOOP_STALL 1
#define BGB_INC_RECOVER 2
#define BGB_INC_STEP_CAP 3
#define BGB_INC_MULTI_NODATA 4

/* bgb_stats() word indexes. */
#define BGB_STAT_VERSION 0
#define BGB_STAT_SEATS 1
#define BGB_STAT_CALLS 2
#define BGB_STAT_TRANSFERS 3
#define BGB_STAT_MULTI_NODATA 4
#define BGB_STAT_RECOVERS 5
#define BGB_STAT_LOOP_STALLS 6
#define BGB_STAT_STEP_CAPS 7
#define BGB_STAT_INCIDENTS 8
#define BGB_STAT_TRANSFERS_WIN 9
#define BGB_STAT_STALL_RUN 10
#define BGB_STAT_ATTACHED 11
#define BGB_STAT_WAITING 12
#define BGB_STAT_TRANSFER_ACTIVE 13
#define BGB_STAT_ASLEEP_MASK 14
#define BGB_STAT_SIO_IRQS 16   /* + seat: serial IRQs raised since load */
#define BGB_STAT_SIO_LAST 20   /* + seat: serial IRQs raised during the last call */
#define BGB_STAT_SIO_WIN 24    /* + seat: serial IRQs raised during the last 60 calls */
#define BGB_STAT_FRAMES 28     /* + seat: frames completed since reset */
#define BGB_STAT_MULTI_OK 15
#define BGB_STAT_AHEAD_STEPS 37   /* cooperative run-ahead steps: a finished seat stepped on to wake a sleeping one */
#define BGB_STAT_SLEEPS 38        /* link sleep callbacks since load */
#define BGB_STAT_WAKES 39         /* link wake callbacks since load */
#define BGB_STAT_MULTI_OK_WIN 32  /* MULTI rounds with real data in the last 60 calls */
#define BGB_STAT_MULTI_LAST 33    /* + 0..3: the four words the primary was handed at the end of its last round (SIOMULTI0..3) */
#define BGB_STAT_YIELDS 40        /* a seat woke another seat and yielded its own runLoop so the woken one could run */
#define BGB_STAT_WORDS 44

#endif

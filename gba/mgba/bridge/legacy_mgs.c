/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * (Derived from the MPL-2.0 Spuds0588/mgba-splitscreen sources at the commit pinned in gba/mgba/SOURCE.md; see that file.) */
/* legacy_mgs.c - the Spuds0588 fork's `mgs_*` ABI, re-implemented on top of the bridge so that glue written against the
 * fork's web build (and tools/gba_mgba_build_test.mjs, which predates the bridge) keeps working.
 *
 * COMPAT ONLY. New code uses gba/mgba/mgba_core.js (bgb_*). Differences from the fork that a caller can observe:
 *   - the ROM is shared between cores, not copied per core (so the heap high-water mark is far lower);
 *   - mgs_get_audio() returns player 0's samples of the LAST frame (the fork mixed a 500 ms catch-up stream of all players);
 *   - mgs_set_audio_source / mgs_enable_debug / mgs_set_fs_assist / the GB entry points are gone (GBA only; no Four Swords
 *     assist exists in this build); mgs_gb_* are not exported.
 */
#include <emscripten/emscripten.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "bemental_gba.h"

extern int bgb_init(int seats);
extern uint8_t* bgb_rom_alloc(size_t len);
extern int bgb_load_rom(uint8_t* rom, size_t len, int saveType);
extern int bgb_load_rom_borrowed(uint8_t* rom, size_t len, int saveType);
extern int bgb_rom_pristine(int seat);
extern int bgb_run_frame(void);
extern void bgb_set_keys(int seat, uint32_t mask);
extern uint32_t* bgb_video(int seat);
extern int16_t* bgb_audio(int seat);
extern int bgb_audio_frames(int seat);
extern unsigned bgb_audio_rate(int seat);
extern uint8_t* bgb_state_buf(void);
extern size_t bgb_state_size(void);
extern int bgb_state_save(int seat);
extern int bgb_state_load(int seat);
extern void bgb_link_reset(void);
extern size_t bgb_save_export(int seat);
extern uint8_t* bgb_save_ptr(void);
extern uint8_t* bgb_save_alloc(size_t n);
extern int bgb_save_import(int seat);
extern void bgb_quit(void);

static int g_count = 0;

EMSCRIPTEN_KEEPALIVE void mgs_init(int count) {
	g_count = count < 1 ? 1 : (count > 4 ? 4 : count);
	bgb_init(g_count);
}

EMSCRIPTEN_KEEPALIVE int mgs_load_rom(const uint8_t* rom, size_t len) {
	/* The fork's contract: the caller keeps ownership of `rom` (and frees it right after this returns). First try WITHOUT copying it: that
	 * is safe exactly when every seat has taken a private copy (cartridges with GPIO hardware, e.g. RTC), which is also the case where a
	 * second copy would hurt (a 32 MiB ROM). If any seat still maps the buffer, load again from a private copy. */
	int rc = bgb_load_rom_borrowed((uint8_t*) rom, len, -1);
	if (rc != 0) {
		return rc;
	}
	bool mapped = false;
	for (int i = 0; i < g_count; ++i) {
		mapped = mapped || bgb_rom_pristine(i) == 1;
	}
	if (!mapped) {
		return 0;
	}
	uint8_t* mine = bgb_rom_alloc(len);
	if (!mine) {
		return -1;
	}
	memcpy(mine, rom, len);
	return bgb_load_rom(mine, len, -1);
}

EMSCRIPTEN_KEEPALIVE void mgs_run_frame(void) { bgb_run_frame(); }
EMSCRIPTEN_KEEPALIVE uint8_t* mgs_get_video(int player) { return (uint8_t*) bgb_video(player); }
EMSCRIPTEN_KEEPALIVE unsigned mgs_get_video_width(int player) { return player >= 0 && player < g_count ? 240 : 0; }
EMSCRIPTEN_KEEPALIVE unsigned mgs_get_video_height(int player) { return player >= 0 && player < g_count ? 160 : 0; }
EMSCRIPTEN_KEEPALIVE int mgs_get_platform(int player) { return player >= 0 && player < g_count ? 1 /* mPLATFORM_GBA */ : 0; }
EMSCRIPTEN_KEEPALIVE void mgs_set_keys(int player, uint32_t keys) { bgb_set_keys(player, keys); }
EMSCRIPTEN_KEEPALIVE int16_t* mgs_get_audio(void) { return bgb_audio(0); }
EMSCRIPTEN_KEEPALIVE int mgs_audio_frames(void) { return bgb_audio_frames(0); }
EMSCRIPTEN_KEEPALIVE unsigned mgs_get_audio_rate(void) { return 32768; }

EMSCRIPTEN_KEEPALIVE size_t mgs_save_state(int player) { return bgb_state_save(player) ? bgb_state_size() : 0; }
EMSCRIPTEN_KEEPALIVE uint8_t* mgs_state_ptr(void) { return bgb_state_buf(); }
EMSCRIPTEN_KEEPALIVE int mgs_load_state(int player) { return bgb_state_load(player) ? 0 : -3; }
EMSCRIPTEN_KEEPALIVE int mgs_load_state_bytes(int player, const uint8_t* data, size_t size) {
	if (!data || size != bgb_state_size()) {
		return -1;
	}
	memcpy(bgb_state_buf(), data, size);
	return bgb_state_load(player) ? 0 : -3;
}
EMSCRIPTEN_KEEPALIVE void mgs_reset_sio(void) { bgb_link_reset(); }

EMSCRIPTEN_KEEPALIVE size_t mgs_export_save(int player) { return bgb_save_export(player); }
EMSCRIPTEN_KEEPALIVE uint8_t* mgs_save_ptr(void) { return bgb_save_ptr(); }
EMSCRIPTEN_KEEPALIVE int mgs_import_save(int player, const uint8_t* data, size_t size) {
	uint8_t* p = bgb_save_alloc(size);
	if (!p || !data) {
		return -1;
	}
	memcpy(p, data, size);
	return bgb_save_import(player) ? 0 : -5;
}

EMSCRIPTEN_KEEPALIVE void mgs_quit(void) { bgb_quit(); g_count = 0; }

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * (Derived from the MPL-2.0 Spuds0588/mgba-splitscreen sources at the commit pinned in gba/mgba/SOURCE.md; see that file.) */
/* bemental_gba.c - the site's own multi-core GBA bridge for mGBA (WebAssembly, single thread, no SharedArrayBuffer).
 *
 * ONE wasm instance hosts N (1..4) GBA cores ("seats"). With N >= 2 the seats are wired to each other through mGBA's
 * lockstep link coordinator (the Spuds0588/mgba-splitscreen fork's src/gba/sio/lockstep.c, minus its Four Swords assist - see
 * patches/0002) and are stepped cooperatively on the calling thread. With N == 1 there is no coordinator at all: a seat is
 * just mGBA's own runFrame().
 *
 * What this file is derived from, and what it is not:
 *   - The stepping loop is a re-statement of sp_run_frame() (mgba-splitscreen src/platform/libretro-splitscreen/instances.c)
 *     and of mgs_run_frame() (mgba-splitscreen/web/mgba_splitscreen_web.c), with two deliberate differences:
 *       1. A seat is owed exactly ONE FRAME per call, counted in the core's own video frame counter, not "a cycle budget that
 *          is reset every call". A reset budget discards each call's overshoot, which (from reading the code, NOT measured here)
 *          would make the guest run slightly FASTER than hardware; a frame target cannot. The guest never runs ahead of 1.000x.
 *       2. A stall is an INCIDENT: it is counted, recorded with the link state at the moment it happened, and returned to the
 *          caller. The fork healed it silently after ~60 frozen frames; here the heal (GBASIOLockstepCoordinatorRecover) is
 *          still available but is itself recorded as an incident, and can be switched off.
 *   - The ROM is mapped ONCE and shared by every seat through a read-only VFile whose map() returns the one buffer (mGBA
 *     already treats a "pristine" mapped ROM as read-only and copies it itself before the first write - _pristineCow).
 *     The fork copied the ROM per core.
 *
 * Everything is exported with a `bgb_` prefix; gba/mgba/mgba_core.js is the only intended caller. See gba/mgba/README.md.
 */
#include <mgba/core/core.h>
#include <mgba/core/config.h>
#include <mgba/core/log.h>
#include <mgba/core/lockstep.h>
#include <mgba/core/timing.h>
#include <mgba/gba/interface.h>
#include <mgba/internal/gba/gba.h>
#include <mgba/internal/gba/savedata.h>
#include <mgba/internal/gba/sio/lockstep.h>
#include <mgba-util/audio-buffer.h>
#include <mgba-util/vfs.h>
#include <emscripten/emscripten.h>

#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "bemental_gba.h"

#define MAX_SEATS 4
#define VIDEO_W 240
#define VIDEO_H 160
#define VIDEO_PIXELS (VIDEO_W * VIDEO_H)
#define AUDIO_FRAMES 2048
#define STATE_BYTES 0x61000u
#define STEP_CAP 400000
#define FRAME_CYCLES_C 280896 /* VIDEO_TOTAL_LENGTH */
#define WINDOW 60
#define MAX_INCIDENTS 64
#define LOG_LINES 512
#define LOG_WIDTH 128

/* ---- logging: a ring the host can drain; nothing ever reaches a console on its own --------------------------------- */

static struct mLogger g_logger;
static struct mLogFilter g_filter;
static bool g_logger_ready = false;
static char g_log[LOG_LINES][LOG_WIDTH];
static uint32_t g_log_total = 0;

static void bgb_log_cb(struct mLogger* logger, int category, enum mLogLevel level, const char* format, va_list args) {
	(void) logger;
	char* line = g_log[g_log_total % LOG_LINES];
	int n = snprintf(line, LOG_WIDTH, "[%s/%02x] ", mLogCategoryId(category) ? mLogCategoryId(category) : "?", (unsigned) level);
	if (n < 0) {
		n = 0;
	}
	vsnprintf(line + n, LOG_WIDTH - (size_t) n, format, args);
	++g_log_total;
}

static void install_logger(void) {
	if (g_logger_ready) {
		return;
	}
	mLogFilterInit(&g_filter);
	g_filter.defaultLevels = mLOG_WARN | mLOG_ERROR | mLOG_FATAL | mLOG_GAME_ERROR;
	g_logger.log = bgb_log_cb;
	g_logger.filter = &g_filter;
	mLogSetDefaultLogger(&g_logger);
	g_logger_ready = true;
}

EMSCRIPTEN_KEEPALIVE void bgb_log_set_debug(int on) {
	install_logger();
	g_filter.defaultLevels = on ? mLOG_ALL : (mLOG_WARN | mLOG_ERROR | mLOG_FATAL | mLOG_GAME_ERROR);
}
EMSCRIPTEN_KEEPALIVE uint32_t bgb_log_total(void) { return g_log_total; }
EMSCRIPTEN_KEEPALIVE const char* bgb_log_line(uint32_t index) {
	/* index is the absolute message number; only the last LOG_LINES are retained. */
	if (index >= g_log_total || g_log_total - index > LOG_LINES) {
		return NULL;
	}
	return g_log[index % LOG_LINES];
}

/* ---- one shared, read-only ROM mapping ------------------------------------------------------------------------------ */

struct SharedRom {
	struct VFile d;
	const uint8_t* data;
	size_t size;
	size_t pos;
};

static bool sr_close(struct VFile* vf) { free(vf); return true; } /* frees the handle, never the bytes */
static off_t sr_seek(struct VFile* vf, off_t offset, int whence) {
	struct SharedRom* s = (struct SharedRom*) vf;
	off_t base = whence == SEEK_SET ? 0 : whence == SEEK_CUR ? (off_t) s->pos : (off_t) s->size;
	off_t at = base + offset;
	if (at < 0) {
		at = 0;
	}
	if ((size_t) at > s->size) {
		at = (off_t) s->size;
	}
	s->pos = (size_t) at;
	return at;
}
static ssize_t sr_read(struct VFile* vf, void* buffer, size_t size) {
	struct SharedRom* s = (struct SharedRom*) vf;
	size_t left = s->size - s->pos;
	if (size > left) {
		size = left;
	}
	memcpy(buffer, s->data + s->pos, size);
	s->pos += size;
	return (ssize_t) size;
}
static ssize_t sr_readline(struct VFile* vf, char* buffer, size_t size) { (void) vf; (void) buffer; (void) size; return -1; }
static ssize_t sr_write(struct VFile* vf, const void* buffer, size_t size) { (void) vf; (void) buffer; (void) size; return -1; }
static void* sr_map(struct VFile* vf, size_t size, int flags) {
	struct SharedRom* s = (struct SharedRom*) vf;
	(void) flags;
	return size <= s->size ? (void*) s->data : NULL; /* the same pointer for every seat: that IS the sharing */
}
static void sr_unmap(struct VFile* vf, void* memory, size_t size) { (void) vf; (void) memory; (void) size; }
static void sr_truncate(struct VFile* vf, size_t size) { (void) vf; (void) size; }
static ssize_t sr_size(struct VFile* vf) { return (ssize_t) ((struct SharedRom*) vf)->size; }
static bool sr_sync(struct VFile* vf, void* buffer, size_t size) { (void) vf; (void) buffer; (void) size; return true; }

static struct VFile* shared_rom_open(const uint8_t* data, size_t size) {
	struct SharedRom* s = calloc(1, sizeof(*s));
	if (!s) {
		return NULL;
	}
	s->d.close = sr_close;
	s->d.seek = sr_seek;
	s->d.read = sr_read;
	s->d.readline = sr_readline;
	s->d.write = sr_write;
	s->d.map = sr_map;
	s->d.unmap = sr_unmap;
	s->d.truncate = sr_truncate;
	s->d.size = sr_size;
	s->d.sync = sr_sync;
	s->data = data;
	s->size = size;
	return &s->d;
}

/* ---- seats ---------------------------------------------------------------------------------------------------------- */

struct SeatUser {
	struct mLockstepUser u; /* must be first: the lockstep callbacks receive &u */
	int idx;
};

struct Seat {
	struct SeatUser user;
	struct GBASIOLockstepDriver driver;
	struct mCore* core;
	bool loaded;
	bool asleep;
	uint32_t target;      /* absolute frame-counter value this seat must have reached by the end of the current call */
	uint32_t lastFc;      /* frame counter at the last snapshot */
	uint32_t fcBase;      /* frame counter right after reset: framesDone = lastFc - fcBase */
	uint64_t cycles;      /* emulated cycles this seat has run since reset (sum of step deltas) */
	uint32_t aheadCycles; /* cycles this seat has run PAST its frame target during the current call, to wake a sleeping seat */
	int audioFrames;
	unsigned audioRate;
	uint32_t sioWin[WINDOW];
	uint32_t sioIrqPrev;
	uint32_t video[VIDEO_PIXELS];  /* renderer target, 0x00BBGGRR */
	uint32_t rgba[VIDEO_PIXELS];   /* published frame: the same pixels with alpha forced to FF (bytes R,G,B,A) */
	int16_t audio[AUDIO_FRAMES * 2];
};

static struct Seat g_seat[MAX_SEATS];
static int g_n = 0;
static bool g_inited = false;
static struct GBASIOLockstepCoordinator g_coord;
static bool g_has_coord = false;

static uint8_t* g_rom = NULL;     /* the one ROM image; owned here (adopted from the caller) unless g_rom_owned is false */
static bool g_rom_owned = true;
static size_t g_rom_len = 0;
static uint8_t g_state[STATE_BYTES];
static uint8_t g_hashbuf[STATE_BYTES];

static uint32_t g_calls = 0;
static uint32_t g_ahead_steps = 0, g_sleeps = 0, g_wakes = 0; /* run-ahead steps, link sleep/wake callbacks */
static uint32_t g_force_sleep = 0; /* DEBUG ONLY (bgb_debug_force_asleep): seats the host pretends are asleep, to exercise the stall path */
static uint32_t g_loop_stalls = 0;
static uint32_t g_step_caps = 0;
static uint32_t g_stall_run = 0;
static int g_recover_after = 60; /* consecutive stalled calls before the watchdog fires; 0 = never */
static uint32_t g_trWin[WINDOW];
static uint32_t g_trPrev = 0;
static uint32_t g_okWin[WINDOW];
static uint32_t g_okPrev = 0;
static uint32_t g_nodataPrev = 0;

struct Incident {
	uint32_t call;
	uint32_t kind;
	uint32_t asleepMask;
	uint32_t doneMask;
	uint32_t waiting;
	uint32_t transferActive;
	uint32_t multiNoData;
	uint32_t recovers;
};
static struct Incident g_incident[MAX_INCIDENTS];
static uint32_t g_incident_total = 0;

static void note_incident(uint32_t kind, uint32_t asleepMask, uint32_t doneMask) {
	struct Incident* in = &g_incident[g_incident_total % MAX_INCIDENTS];
	in->call = g_calls;
	in->kind = kind;
	in->asleepMask = asleepMask;
	in->doneMask = doneMask;
	in->waiting = g_has_coord ? g_coord.waiting : 0;
	in->transferActive = g_has_coord ? (g_coord.transferActive ? 1u : 0u) : 0;
	in->multiNoData = g_has_coord ? g_coord.witnessMultiNoData : 0;
	in->recovers = g_has_coord ? g_coord.witnessRecovers : 0;
	++g_incident_total;
}

static void user_sleep(struct mLockstepUser* u) { g_seat[((struct SeatUser*) u)->idx].asleep = true; ++g_sleeps; }
/* A seat that wakes ANOTHER seat yields: its current runLoop is cut short (the same GBAInterrupt the lockstep driver uses when a seat
 * goes to sleep) so the scheduler can run the one it just woke. Without this a HALTED core is one runLoop step that lasts until its
 * next interrupt - up to a whole frame - so a master waking its secondaries could not be preempted and ran a frame ahead of them
 * (measured: on the very first call the master ended with frame counter 2 while the secondary had 1). */
static int g_running = -1;
static uint32_t g_yields = 0;
static void user_wake(struct mLockstepUser* u) {
	int idx = ((struct SeatUser*) u)->idx;
	g_seat[idx].asleep = false;
	++g_wakes;
	if (g_running >= 0 && g_running != idx && g_seat[g_running].core) {
		GBAInterrupt((struct GBA*) g_seat[g_running].core->board);
		++g_yields;
	}
}
/* Wire id = seat index, always. Without this the coordinator hands out ids in hash-table iteration order, so which core is
 * the master (id 0) would depend on allocation order rather than on the seat the caller named. */
static int user_requested_id(struct mLockstepUser* u) { return ((struct SeatUser*) u)->idx; }
static void user_id_changed(struct mLockstepUser* u, int id) { (void) u; (void) id; }

static void snapshot(struct Seat* s) {
	const uint32_t* v = s->video;
	uint32_t* o = s->rgba;
	for (int i = 0; i < VIDEO_PIXELS; ++i) {
		o[i] = v[i] | 0xFF000000u;
	}
}

static void drain_audio(struct Seat* s) {
	struct mAudioBuffer* buf = s->core->getAudioBuffer(s->core);
	s->audioFrames = 0;
	if (buf) {
		s->audioFrames = (int) mAudioBufferRead(buf, s->audio, AUDIO_FRAMES);
		/* anything beyond one call's capacity is stale by construction; do not let it accumulate */
		int16_t sink[512 * 2];
		while (mAudioBufferRead(buf, sink, 512) > 0) {
		}
	}
	s->audioRate = s->core->audioSampleRate ? s->core->audioSampleRate(s->core) : 32768;
}

/* ---- teardown ------------------------------------------------------------------------------------------------------- */

static void teardown(void) {
	for (int i = 0; i < MAX_SEATS; ++i) {
		struct Seat* s = &g_seat[i];
		if (s->core) {
			if (s->loaded) {
				s->core->unloadROM(s->core);
			}
			mCoreConfigDeinit(&s->core->config);
			s->core->deinit(s->core);
			free(s->core);
			s->core = NULL;
		}
		s->loaded = false;
	}
	/* The cores go first: their SIO drivers call back into the coordinator while they are torn down. */
	if (g_has_coord) {
		GBASIOLockstepCoordinatorDeinit(&g_coord);
		g_has_coord = false;
	}
	if (g_rom_owned) {
		free(g_rom);
	}
	g_rom = NULL;
	g_rom_len = 0;
}

EMSCRIPTEN_KEEPALIVE void bgb_quit(void) {
	teardown();
	g_n = 0;
	g_inited = false;
}

/* ---- init / load ---------------------------------------------------------------------------------------------------- */

EMSCRIPTEN_KEEPALIVE int bgb_init(int seats) {
	if (seats < 1 || seats > MAX_SEATS) {
		return -1;
	}
	install_logger();
	teardown();
	memset(g_seat, 0, sizeof(g_seat));
	memset(g_incident, 0, sizeof(g_incident));
	memset(g_trWin, 0, sizeof(g_trWin));
	memset(g_okWin, 0, sizeof(g_okWin));
	g_okPrev = 0;
	g_incident_total = g_calls = g_loop_stalls = g_step_caps = g_stall_run = 0;
	g_ahead_steps = g_sleeps = g_wakes = g_yields = 0;
	g_trPrev = g_nodataPrev = 0;
	g_log_total = 0;
	g_force_sleep = 0;
	g_n = seats;
	for (int i = 0; i < seats; ++i) {
		g_seat[i].user.idx = i;
		g_seat[i].user.u.sleep = user_sleep;
		g_seat[i].user.u.wake = user_wake;
		g_seat[i].user.u.requestedId = user_requested_id;
		g_seat[i].user.u.playerIdChanged = user_id_changed;
	}
	g_inited = true;
	return 0;
}

EMSCRIPTEN_KEEPALIVE uint8_t* bgb_rom_alloc(size_t len) {
	return len >= 0xC0 && len <= (32u * 1024u * 1024u) ? (uint8_t*) malloc(len) : NULL;
}

/* The cartridge-clock pin is BRIDGE state, remembered here and (re)applied to every core the moment it exists. mGBA's own core init
 * (GBACoreInit -> mRTCGenericSourceInit) resets core->rtc to RTC_NO_OVERRIDE, i.e. the host clock, so a pin written straight into
 * core->rtc before loadRom() would be wiped without a sound. Keeping the setting here makes setRtc() order-independent:
 * create -> setRtc -> loadRom and create -> loadRom -> setRtc give the same guest clock. The pin is sticky across loadRom(),
 * reset() and a second loadRom() until setRtc() changes it. */
static bool g_rtc_pinned = false;
static double g_rtc_epoch_ms = 0.0;

/* RTC LATCH WITNESS (G2). Every time the game asks the cartridge clock for the date/time (the RTC_DATETIME / RTC_TIME commands over
 * GPIO, ROM addresses 0x080000C4-C8), mGBA's _rtcUpdateClock() calls core->rtc.d.unixTime() exactly once. The bridge puts a counting
 * wrapper in that function pointer so a determinism test can PROVE the guest really read the clock: how many latches, the first and
 * last unix time handed to the guest, and an FNV-1a digest over every value handed out. The wrapper changes no value (it returns what the
 * stock source returned) and costs nothing between latches. bgb_rtc_unix() deliberately bypasses it so that asking the witness does not
 * count as the guest asking. */
static time_t (*g_rtc_orig_unix)(struct mRTCSource*) = NULL;
struct RtcWit {
	uint32_t latches;
	int64_t first;
	int64_t last;
	uint32_t digest;
};
static struct RtcWit g_rtcw[MAX_SEATS];
static uint32_t fnv_bytes(uint32_t h, const uint8_t* p, size_t n);
static time_t rtc_unix_witness(struct mRTCSource* src);

static void rtc_witness_clear(void) {
	memset(g_rtcw, 0, sizeof(g_rtcw));
	for (int i = 0; i < MAX_SEATS; ++i) {
		g_rtcw[i].digest = 0x811C9DC5u;
	}
}

static void apply_rtc(struct Seat* s) {
	if (!s->core) {
		return;
	}
	if (s->core->rtc.d.unixTime != rtc_unix_witness) {
		g_rtc_orig_unix = s->core->rtc.d.unixTime; /* the generic source's own callback; the same pointer for every seat */
		s->core->rtc.d.unixTime = rtc_unix_witness;
	}
	s->core->rtc.override = g_rtc_pinned ? RTC_FAKE_EPOCH : RTC_NO_OVERRIDE;
	s->core->rtc.value = g_rtc_pinned ? (int64_t) g_rtc_epoch_ms : 0;
}

/* Reset-time hardware pins that must not depend on the host or on a config file somewhere on disk. */
static void pin_determinism(struct Seat* s) {
	struct GBA* gba = s->core->board;
	gba->idleOptimization = IDLE_LOOP_IGNORE; /* no idle-loop time skipping: the guest sees hardware timing */
	gba->allowOpposingDirections = true;
}

/* The drivers are created ONCE per load (Create memsets the driver, wiping the pointer the core's SIO handed it); the
 * coordinator can be rebuilt around them any number of times. */
static void create_drivers(void) {
	for (int i = 0; i < g_n; ++i) {
		GBASIOLockstepDriverCreate(&g_seat[i].driver, &g_seat[i].user.u);
	}
}

static void attach_all(void) {
	GBASIOLockstepCoordinatorInit(&g_coord);
	g_has_coord = true;
	for (int i = 0; i < g_n; ++i) {
		GBASIOLockstepCoordinatorAttach(&g_coord, &g_seat[i].driver);
	}
}

static void rebase(struct Seat* s) {
	s->lastFc = s->core->frameCounter(s->core);
	s->fcBase = s->lastFc;
	s->target = s->lastFc;
	s->asleep = false;
	s->cycles = 0;
	s->sioIrqPrev = ((struct GBA*) s->core->board)->witnessSioIrqs;
	memset(s->sioWin, 0, sizeof(s->sioWin));
}

/* Save-library tag the cartridge was linked with (the strings Nintendo's libraries embed, which mGBA's own detection also keys on).
 * Needed because mGBA decides the battery type LAZILY, at the game's first access to 0E000000: before that the save buffer does not
 * exist, and savedataRestore() on such a core returns success while keeping nothing - a silently dropped save. */
enum { TAG_NONE = 0, TAG_SRAM = 1, TAG_FLASH512 = 2, TAG_FLASH1M = 3, TAG_EEPROM = 4 };
static int g_rom_tag = TAG_NONE;

static int scan_save_tag(const uint8_t* rom, size_t len) {
	static const struct { const char* s; int tag; } tags[] = {
		{ "FLASH1M_V", TAG_FLASH1M }, { "FLASH512_V", TAG_FLASH512 }, { "FLASH_V", TAG_FLASH512 },
		{ "EEPROM_V", TAG_EEPROM }, { "SRAM_F_V", TAG_SRAM }, { "SRAM_V", TAG_SRAM },
	};
	for (size_t i = 0; i < sizeof(tags) / sizeof(*tags); ++i) {
		if (memmem(rom, len, tags[i].s, strlen(tags[i].s))) {
			return tags[i].tag;
		}
	}
	return TAG_NONE;
}

/* Adopts `rom` (allocated with bgb_rom_alloc, ROM bytes already written into it). saveType: -1 = autodetect, else a
 * GBASavedataType forced after the per-game defaults were applied. */
static int load_rom_common(uint8_t* rom, size_t len, int saveType, bool owned);
EMSCRIPTEN_KEEPALIVE int bgb_load_rom(uint8_t* rom, size_t len, int saveType) {
	return load_rom_common(rom, len, saveType, true);
}
/* Same, but the caller KEEPS the buffer (legacy_mgs.c only): it is never freed here. Safe only while no seat still maps it - i.e. when
 * every seat has already taken a private copy (bgb_rom_pristine() == 0 for all); the legacy shim checks that and reloads with an owned
 * copy otherwise. */
EMSCRIPTEN_KEEPALIVE int bgb_load_rom_borrowed(uint8_t* rom, size_t len, int saveType) {
	return load_rom_common(rom, len, saveType, false);
}
static int load_rom_common(uint8_t* rom, size_t len, int saveType, bool owned) {
	if (!g_inited) {
		if (owned) {
			free(rom);
		}
		return -7;
	}
	if (!rom || len < 0xC0 || len > (32u * 1024u * 1024u)) {
		if (owned) {
			free(rom);
		}
		return -1;
	}
	/* A header sanity check without mapping anything: GBAIsROM wants a VFile. */
	struct VFile* probe = shared_rom_open(rom, len);
	bool isRom = probe && GBAIsROM(probe);
	if (probe) {
		probe->close(probe);
	}
	if (!isRom) {
		if (owned) {
			free(rom);
		}
		return -2;
	}
	teardown(); /* a second load in the same instance replaces the first; frees the previous ROM */
	g_rom = rom;
	g_rom_owned = owned;
	g_rom_len = len;
	g_rom_tag = scan_save_tag(rom, len);
	g_calls = g_loop_stalls = g_step_caps = g_stall_run = 0;
	g_incident_total = 0;
	g_trPrev = g_nodataPrev = 0;
	memset(g_trWin, 0, sizeof(g_trWin));
	memset(g_okWin, 0, sizeof(g_okWin));
	g_okPrev = 0;
	rtc_witness_clear();

	if (g_n >= 2) {
		create_drivers();
		attach_all();
	}
	for (int i = 0; i < g_n; ++i) {
		struct Seat* s = &g_seat[i];
		s->core = mCoreCreate(mPLATFORM_GBA);
		if (!s->core) {
			return -3;
		}
		if (!s->core->init(s->core)) {
			return -4;
		}
		apply_rtc(s); /* init just reset core->rtc to the host clock: re-apply the remembered pin (see g_rtc_pinned) */
		/* Same order as the fork's web bridge: sizes and volume first, then config, then buffers. */
		s->core->setAudioBufferSize(s->core, AUDIO_FRAMES);
		s->core->opts.volume = 0x100;
		s->core->opts.useBios = false; /* never look for a BIOS file: the HLE BIOS only, on every machine */
		mCoreInitConfig(s->core, NULL);
		mCoreLoadConfig(s->core);
		s->core->opts.useBios = false;
		memset(s->video, 0, sizeof(s->video));
		s->core->setVideoBuffer(s->core, s->video, VIDEO_W);
		struct VFile* vf = shared_rom_open(g_rom, g_rom_len);
		if (!vf) {
			return -5;
		}
		if (!s->core->loadROM(s->core, vf)) {
			return -5;
		}
		s->loaded = true;
	}
	/* Link driver is attached and the cores reset in seat order, AFTER every ROM is loaded (instances.c _spFinishLoad). */
	for (int i = 0; i < g_n; ++i) {
		struct Seat* s = &g_seat[i];
		if (g_has_coord) {
			s->core->setPeripheral(s->core, mPERIPH_GBA_LINK_PORT, &s->driver);
		}
		s->core->reset(s->core);
		pin_determinism(s);
		if (saveType >= 0) {
			GBASavedataForceType(&((struct GBA*) s->core->board)->memory.savedata, (enum GBASavedataType) saveType);
		}
		unsigned w = 0, h = 0;
		s->core->currentVideoSize(s->core, &w, &h);
		if (w != VIDEO_W || h != VIDEO_H) {
			return -6;
		}
		rebase(s);
		snapshot(s);
	}
	return 0;
}

/* Re-reset every seat (power cycle). The coordinator carries round state across a reset, so it is rebuilt too. */
EMSCRIPTEN_KEEPALIVE int bgb_reset(void) {
	if (!g_inited || !g_seat[0].loaded) {
		return -1;
	}
	if (g_has_coord) {
		/* Drivers must be detached BEFORE the coordinator dies, or their stale ids point into a freed table. */
		for (int i = 0; i < g_n; ++i) {
			GBASIOLockstepCoordinatorDetach(&g_coord, &g_seat[i].driver);
		}
		GBASIOLockstepCoordinatorDeinit(&g_coord);
		attach_all();
	}
	rtc_witness_clear(); /* a power cycle starts the witness over: it counts latches since the last load or reset */
	for (int i = 0; i < g_n; ++i) {
		struct Seat* s = &g_seat[i];
		s->core->reset(s->core);
		pin_determinism(s);
		apply_rtc(s);
		rebase(s);
		snapshot(s);
	}
	g_calls = g_loop_stalls = g_step_caps = g_stall_run = 0;
	g_trPrev = g_nodataPrev = 0;
	memset(g_trWin, 0, sizeof(g_trWin));
	memset(g_okWin, 0, sizeof(g_okWin));
	g_okPrev = 0;
	return 0;
}

/* ---- the frame ------------------------------------------------------------------------------------------------------ */

static inline bool seat_asleep(int i) {
	return g_seat[i].asleep || ((g_force_sleep >> i) & 1u);
}

static inline bool seat_done(const struct Seat* s) {
	return (int32_t) (s->lastFc - s->target) >= 0;
}

/* DEBUG ONLY: record the first 512 steps after bgb_debug_trace(1) as {seat, cycles, frameCounter, asleep flag after the step}. */
static uint32_t g_trace[512][4];
static uint32_t g_trace_n = 0;
static int g_trace_on = 0;
EMSCRIPTEN_KEEPALIVE void bgb_debug_trace(int on) { g_trace_on = on; g_trace_n = 0; }
EMSCRIPTEN_KEEPALIVE uint32_t bgb_debug_trace_n(void) { return g_trace_n; }
EMSCRIPTEN_KEEPALIVE uint32_t bgb_debug_trace_get(uint32_t i, int k) { return i < 512 ? g_trace[i][k & 3] : 0; }

static inline uint32_t step_seat(struct Seat* s) {
	uint32_t before = (uint32_t) mTimingCurrentTime(s->core->timing);
	g_running = (int) (s - g_seat);
	s->core->runLoop(s->core);
	g_running = -1;
	uint32_t delta = (uint32_t) ((uint32_t) mTimingCurrentTime(s->core->timing) - before);
	s->cycles += delta;
	uint32_t fc = s->core->frameCounter(s->core);
	if (g_trace_on && g_trace_n < 512) {
		g_trace[g_trace_n][0] = (uint32_t) (s - g_seat);
		g_trace[g_trace_n][1] = (uint32_t) s->cycles;
		g_trace[g_trace_n][2] = fc;
		g_trace[g_trace_n][3] = s->asleep ? 1u : 0u;
		++g_trace_n;
	}
	if (fc != s->lastFc) {
		s->lastFc = fc;
		snapshot(s);
	}
	return delta;
}

static uint32_t masks(uint32_t* doneMask) {
	uint32_t a = 0, d = 0;
	for (int i = 0; i < g_n; ++i) {
		a |= (seat_asleep(i) ? 1u : 0u) << i;
		d |= (seat_done(&g_seat[i]) ? 1u : 0u) << i;
	}
	*doneMask = d;
	return a;
}

/* Advance EVERY seat by exactly one emulated frame. Returns a bitmask of BGB_ST_* (0 = clean). */
EMSCRIPTEN_KEEPALIVE int bgb_run_frame(void) {
	if (!g_inited || !g_seat[0].loaded) {
		return BGB_ST_NOT_LOADED;
	}
	int status = 0;
	++g_calls;
	for (int i = 0; i < g_n; ++i) {
		++g_seat[i].target;
		g_seat[i].aheadCycles = 0;
	}

	if (g_n == 1) {
		/* SOLO: mGBA's own runFrame. No coordinator, no sleep flags, nothing to stall. */
		struct Seat* s = &g_seat[0];
		uint32_t before = (uint32_t) mTimingCurrentTime(s->core->timing);
		s->core->runFrame(s->core);
		s->cycles += (uint32_t) ((uint32_t) mTimingCurrentTime(s->core->timing) - before);
		uint32_t fc = s->core->frameCounter(s->core);
		if (fc != s->lastFc) {
			s->lastFc = fc;
			snapshot(s);
		}
		if (!seat_done(s)) {
			/* runFrame's own safety cap fired before the video counter moved: that is not a link stall, but it is an
			 * incident - the seat is behind its frame target. */
			status |= BGB_ST_STEP_CAP;
			++g_step_caps;
			note_incident(BGB_INC_STEP_CAP, 0, 0);
		}
	} else {
		int guard = 0;
		bool stalled = false;
		for (;;) {
			bool owing = false, stepped = false;
			for (int i = 0; i < g_n; ++i) {
				struct Seat* s = &g_seat[i];
				if (seat_done(s)) {
					continue;
				}
				owing = true;
				if (seat_asleep(i)) {
					continue;
				}
				step_seat(s);
				stepped = true;
			}
			if (!owing) {
				break;
			}
			if (!stepped) {
				/* Every seat that still owes cycles is asleep waiting for the link. A sleeping core cannot service its own
				 * event queue, so a seat that is already finished (and awake) must run on to wake it: this is how the
				 * master releases the secondaries at the end of its frame. */
				bool ahead = false;
				for (int i = 0; i < g_n; ++i) {
					struct Seat* s = &g_seat[i];
					/* Run-ahead is for waking a sleeper, which takes a few thousand cycles. A seat that has already run a whole frame past its
					 * target in this call and still has not woken anyone is not waking anyone: that is a stall, reported as one. */
					if (seat_done(s) && !seat_asleep(i) && s->aheadCycles < FRAME_CYCLES_C) {
						s->aheadCycles += step_seat(s);
						++g_ahead_steps;
						ahead = true;
					}
				}
				if (!ahead) {
					stalled = true;
					break;
				}
			}
			if (++guard > STEP_CAP) {
				status |= BGB_ST_STEP_CAP;
				++g_step_caps;
				uint32_t dm;
				uint32_t am = masks(&dm);
				note_incident(BGB_INC_STEP_CAP, am, dm);
				break;
			}
		}
		if (stalled) {
			uint32_t dm;
			uint32_t am = masks(&dm);
			++g_loop_stalls;
			++g_stall_run;
			status |= BGB_ST_STALL;
			note_incident(BGB_INC_LOOP_STALL, am, dm);
			if (g_recover_after > 0 && g_stall_run >= (uint32_t) g_recover_after) {
				uint32_t before = g_coord.witnessRecovers;
				GBASIOLockstepCoordinatorRecover(&g_coord);
				if (g_coord.witnessRecovers != before) {
					status |= BGB_ST_RECOVERED;
					am = masks(&dm);
					note_incident(BGB_INC_RECOVER, am, dm);
				}
				g_stall_run = 0;
			}
		} else {
			g_stall_run = 0;
		}
		/* A completed MULTI round that never got every secondary's ack delivered FFFF: surface it, once per increase. */
		if (g_coord.witnessMultiNoData != g_nodataPrev) {
			g_nodataPrev = g_coord.witnessMultiNoData;
			status |= BGB_ST_MULTI_NODATA;
			uint32_t dm;
			uint32_t am = masks(&dm);
			note_incident(BGB_INC_MULTI_NODATA, am, dm);
		}
		uint32_t tr = g_coord.witnessTransfers;
		g_trWin[g_calls % WINDOW] = tr - g_trPrev;
		g_trPrev = tr;
		uint32_t ok = g_coord.witnessMultiOk;
		g_okWin[g_calls % WINDOW] = ok - g_okPrev;
		g_okPrev = ok;
	}

	for (int i = 0; i < g_n; ++i) {
		struct Seat* s = &g_seat[i];
		drain_audio(s);
		uint32_t irq = ((struct GBA*) s->core->board)->witnessSioIrqs;
		s->sioWin[g_calls % WINDOW] = irq - s->sioIrqPrev;
		s->sioIrqPrev = irq;
	}
	return status;
}

EMSCRIPTEN_KEEPALIVE void bgb_set_keys(int seat, uint32_t mask) {
	if (seat < 0 || seat >= g_n || !g_seat[seat].loaded) {
		return;
	}
	g_seat[seat].core->setKeys(g_seat[seat].core, mask & 0x3FFu);
}

EMSCRIPTEN_KEEPALIVE uint32_t* bgb_video(int seat) {
	return seat >= 0 && seat < g_n ? g_seat[seat].rgba : NULL;
}
EMSCRIPTEN_KEEPALIVE int16_t* bgb_audio(int seat) {
	return seat >= 0 && seat < g_n ? g_seat[seat].audio : NULL;
}
EMSCRIPTEN_KEEPALIVE int bgb_audio_frames(int seat) {
	return seat >= 0 && seat < g_n ? g_seat[seat].audioFrames : 0;
}
EMSCRIPTEN_KEEPALIVE unsigned bgb_audio_rate(int seat) {
	return seat >= 0 && seat < g_n ? g_seat[seat].audioRate : 0;
}

/* ---- memory reads (witnesses) --------------------------------------------------------------------------------------- */

EMSCRIPTEN_KEEPALIVE int bgb_read16(int seat, uint32_t address) {
	if (seat < 0 || seat >= g_n || !g_seat[seat].loaded) {
		return -1;
	}
	return (int) (g_seat[seat].core->rawRead16(g_seat[seat].core, address, -1) & 0xFFFF);
}
EMSCRIPTEN_KEEPALIVE uint32_t bgb_read32(int seat, uint32_t address) {
	if (seat < 0 || seat >= g_n || !g_seat[seat].loaded) {
		return 0xFFFFFFFFu;
	}
	return g_seat[seat].core->rawRead32(g_seat[seat].core, address, -1);
}

/* ---- savestates, hashes --------------------------------------------------------------------------------------------- */

EMSCRIPTEN_KEEPALIVE uint8_t* bgb_state_buf(void) { return g_state; }
EMSCRIPTEN_KEEPALIVE size_t bgb_state_size(void) { return STATE_BYTES; }

EMSCRIPTEN_KEEPALIVE int bgb_state_save(int seat) {
	if (seat < 0 || seat >= g_n || !g_seat[seat].loaded) {
		return 0;
	}
	if (g_seat[seat].core->stateSize(g_seat[seat].core) != STATE_BYTES) {
		return 0;
	}
	memset(g_state, 0, sizeof(g_state));
	return g_seat[seat].core->saveState(g_seat[seat].core, g_state) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int bgb_state_load(int seat) {
	if (seat < 0 || seat >= g_n || !g_seat[seat].loaded) {
		return 0;
	}
	struct Seat* s = &g_seat[seat];
	if (!s->core->loadState(s->core, g_state)) {
		return 0;
	}
	/* The restored video counter is the new reference: the seat owes nothing until the next call. */
	s->lastFc = s->core->frameCounter(s->core);
	s->target = s->lastFc;
	s->asleep = false;
	snapshot(s);
	return 1;
}

/* After restoring the states of linked seats, drop the coordinator's per-player queues and sleep flags (they came back
 * with the restored cores, or are stale relative to them) so the restored system is quiescent and re-handshakes.
 * Call once, after EVERY seat has been restored. (EmulationManager::load_state_set / mgs_reset_sio in the fork.) */
EMSCRIPTEN_KEEPALIVE void bgb_link_reset(void) {
	if (!g_has_coord) {
		return;
	}
	/* The coordinator is REBUILT, not just poked: its clock, barrier and player table are history that a restored state knows nothing
	 * about, and two instances only evolve identically from identical states if the link layer is a pure function of those states. */
	for (int i = 0; i < g_n; ++i) {
		GBASIOLockstepCoordinatorDetach(&g_coord, &g_seat[i].driver);
	}
	GBASIOLockstepCoordinatorDeinit(&g_coord);
	attach_all();
	for (int i = 0; i < g_n; ++i) {
		if (g_seat[i].driver.d.p && g_seat[i].driver.d.reset) {
			g_seat[i].driver.d.reset(&g_seat[i].driver.d);
		}
		g_seat[i].asleep = false;
	}
	g_stall_run = 0;
}

static uint32_t fnv_init(void) { return 0x811C9DC5u; }
static uint32_t fnv_bytes(uint32_t h, const uint8_t* p, size_t n) {
	for (size_t i = 0; i < n; ++i) {
		h ^= p[i];
		h *= 0x01000193u;
	}
	return h;
}
static uint32_t fnv_u32(uint32_t h, uint32_t v) {
	uint8_t b[4] = { (uint8_t) v, (uint8_t) (v >> 8), (uint8_t) (v >> 16), (uint8_t) (v >> 24) };
	return fnv_bytes(h, b, 4);
}

/* FNV-1a 32 over the seat's full 0x61000-byte core savestate (GBASerializedState): CPU registers, the whole video state
 * (VRAM, OAM, palette, renderer registers), IO registers, EWRAM, IWRAM, audio, timers, DMA, cartridge hardware (RTC/GPIO),
 * the event queue and the video frame counter. NOT in it: the ROM image, the battery save, the link coordinator, and
 * anything in the driver's extra state - those are covered by bgb_hash_link() and by exportSave(). */
EMSCRIPTEN_KEEPALIVE uint32_t bgb_hash(int seat) {
	if (seat < 0 || seat >= g_n || !g_seat[seat].loaded) {
		return 0;
	}
	memset(g_hashbuf, 0, sizeof(g_hashbuf));
	if (!g_seat[seat].core->saveState(g_seat[seat].core, g_hashbuf)) {
		return 0;
	}
	return fnv_bytes(fnv_init(), g_hashbuf, STATE_BYTES);
}

/* The game-visible state hash: bgb_hash() with the PSG sequencer block (0x130-0x18B: audio channels 1-4 envelope / frame / last-update
 * fields) zeroed first. mGBA's savestate does NOT round-trip that block bit-exactly - save(load(S)) differs from S in a handful of bytes
 * there (measured: 12-14 bytes inside 0x132-0x153 on Kirby, Sonic Advance 3 and Super Bust-A-Move) - and nothing outside it changed in
 * 30 frames of play, so a hash for "did the restored game evolve like the original" must not include it. Use bgb_hash() between
 * instances that ran the same sequence (strictest), bgb_hash_game() when one side was restored from a savestate. */
EMSCRIPTEN_KEEPALIVE uint32_t bgb_hash_game(int seat) {
	if (seat < 0 || seat >= g_n || !g_seat[seat].loaded) {
		return 0;
	}
	memset(g_hashbuf, 0, sizeof(g_hashbuf));
	if (!g_seat[seat].core->saveState(g_seat[seat].core, g_hashbuf)) {
		return 0;
	}
	memset(g_hashbuf + 0x130, 0, 0x18C - 0x130);
	return fnv_bytes(fnv_init(), g_hashbuf, STATE_BYTES);
}

/* FNV-1a 32 over the link layer: the coordinator (clock, barrier, transfer latch, both data arrays, counters-free) and, per
 * attached player in wire order, its mode, sleep/ack flags, clock offset and queued events. 0 for a solo instance. */
EMSCRIPTEN_KEEPALIVE uint32_t bgb_hash_link(void) {
	if (!g_has_coord) {
		return 0;
	}
	uint32_t h = fnv_init();
	h = fnv_u32(h, (uint32_t) g_coord.nAttached);
	h = fnv_u32(h, g_coord.waiting);
	h = fnv_u32(h, (uint32_t) g_coord.transferActive);
	h = fnv_u32(h, (uint32_t) g_coord.transferMode);
	h = fnv_u32(h, (uint32_t) g_coord.cycle);
	h = fnv_u32(h, (uint32_t) g_coord.nextHardSync);
	for (int i = 0; i < 4; ++i) {
		h = fnv_u32(h, g_coord.multiData[i]);
		h = fnv_u32(h, g_coord.normalData[i]);
	}
	for (int i = 0; i < g_coord.nAttached; ++i) {
		struct GBASIOLockstepPlayer* p = TableLookup(&g_coord.players, g_coord.attachedPlayers[i]);
		if (!p) {
			h = fnv_u32(h, 0xDEADBEEFu);
			continue;
		}
		h = fnv_u32(h, (uint32_t) p->playerId);
		h = fnv_u32(h, (uint32_t) p->mode);
		h = fnv_u32(h, (uint32_t) p->asleep);
		h = fnv_u32(h, (uint32_t) p->dataReceived);
		h = fnv_u32(h, (uint32_t) p->cycleOffset);
		for (int k = 0; k < MAX_GBAS; ++k) {
			h = fnv_u32(h, (uint32_t) p->otherModes[k]);
		}
		for (const struct GBASIOLockstepEvent* e = p->queue; e; e = e->next) {
			h = fnv_u32(h, (uint32_t) e->type);
			h = fnv_u32(h, (uint32_t) e->timestamp);
			h = fnv_u32(h, (uint32_t) e->playerId);
			h = fnv_u32(h, (uint32_t) e->finishCycle);
		}
	}
	return h;
}

/* ---- battery save --------------------------------------------------------------------------------------------------- */

static uint8_t* g_save = NULL;
static size_t g_save_len = 0;

/* The battery type a save of `len` bytes belongs to on a cartridge with this tag, or -1 when the size does not fit the tag. */
static int type_for_save(size_t len, int tag) {
	switch (tag) {
	case TAG_SRAM: return len == 32768 ? GBA_SAVEDATA_SRAM : -1;
	case TAG_FLASH512: return len == 65536 ? GBA_SAVEDATA_FLASH512 : -1;
	case TAG_FLASH1M: return len == 131072 ? GBA_SAVEDATA_FLASH1M : -1;
	case TAG_EEPROM: return len == 512 ? GBA_SAVEDATA_EEPROM512 : len == 8192 ? GBA_SAVEDATA_EEPROM : -1;
	default: /* no tag: trust the size */
		return len == 32768 ? GBA_SAVEDATA_SRAM : len == 65536 ? GBA_SAVEDATA_FLASH512 : len == 131072 ? GBA_SAVEDATA_FLASH1M : len == 512 ? GBA_SAVEDATA_EEPROM512 : len == 8192 ? GBA_SAVEDATA_EEPROM : -1;
	}
}

EMSCRIPTEN_KEEPALIVE int bgb_rom_save_tag(void) { return g_rom_tag; }

EMSCRIPTEN_KEEPALIVE size_t bgb_save_export(int seat) {
	free(g_save);
	g_save = NULL;
	g_save_len = 0;
	if (seat < 0 || seat >= g_n || !g_seat[seat].loaded || !g_seat[seat].core->savedataClone) {
		return 0;
	}
	void* sram = NULL;
	size_t n = g_seat[seat].core->savedataClone(g_seat[seat].core, &sram);
	if (n == 0 || !sram) {
		free(sram);
		return 0;
	}
	g_save = (uint8_t*) sram;
	g_save_len = n;
	return n;
}
EMSCRIPTEN_KEEPALIVE uint8_t* bgb_save_ptr(void) { return g_save; }

EMSCRIPTEN_KEEPALIVE uint8_t* bgb_save_alloc(size_t n) {
	free(g_save);
	g_save = n ? (uint8_t*) malloc(n) : NULL;
	g_save_len = g_save ? n : 0;
	return g_save;
}
/* Restores the bytes the caller wrote into bgb_save_alloc()'s buffer as seat's battery save. 1 = accepted. */
EMSCRIPTEN_KEEPALIVE int bgb_save_import(int seat) {
	if (seat < 0 || seat >= g_n || !g_seat[seat].loaded || !g_save || !g_seat[seat].core->savedataRestore) {
		return 0;
	}
	struct GBASavedata* sd = &((struct GBA*) g_seat[seat].core->board)->memory.savedata;
	if (sd->type == GBA_SAVEDATA_AUTODETECT) {
		int t = type_for_save(g_save_len, g_rom_tag);
		if (t < 0) {
			return 0; /* refuse loudly: a save that does not fit this cartridge's battery is not silently half-loaded */
		}
		GBASavedataForceType(sd, (enum GBASavedataType) t);
	}
	if (g_save_len != GBASavedataSize(sd)) {
		return 0;
	}
	return g_seat[seat].core->savedataRestore(g_seat[seat].core, g_save, g_save_len, true) ? 1 : 0;
}

/* ---- RTC pin (hook for G2) ------------------------------------------------------------------------------------------ */

extern int bementalRtcPinned;        /* defined by patches/0004 in gpio.c */
extern int32_t bementalRtcUtcOffsetSec;

/* epochMs: the unix time (ms) the guest sees at frame counter 0 of each seat; it then advances with emulated frames
 * (RTC_FAKE_EPOCH), never with the host clock. tzOffsetMin: minutes EAST of UTC that the guest's calendar uses (e.g. -300 =
 * UTC-5); the host's own time zone is never consulted. Pass pinned=0 to hand the RTC back to the host clock.
 * ORDER-INDEPENDENT: the setting is remembered (g_rtc_pinned) and applied to cores that already exist AND to every core created by
 * a later loadRom(), so it does not matter whether this runs before or after bgb_load_rom().
 * Returns 0, -1 (bgb_init not called), -2 (epochMs is NaN/infinite or outside +-9e15 ms, which a pinned clock cannot represent). */
EMSCRIPTEN_KEEPALIVE int bgb_set_rtc(int pinned, double epochMs, int tzOffsetMin) {
	if (!g_inited) {
		return -1;
	}
	if (pinned && !(isfinite(epochMs) && fabs(epochMs) <= 9e15)) {
		return -2;
	}
	g_rtc_pinned = pinned ? true : false;
	g_rtc_epoch_ms = pinned ? epochMs : 0.0;
	bementalRtcPinned = pinned ? 1 : 0;
	bementalRtcUtcOffsetSec = pinned ? tzOffsetMin * 60 : 0;
	for (int i = 0; i < g_n; ++i) {
		apply_rtc(&g_seat[i]);
	}
	return 0;
}

/* ---- witnesses ------------------------------------------------------------------------------------------------------ */

/* DEBUG ONLY: pretend the seats in `mask` are asleep waiting on the link. Exists so the stall/incident plumbing can be exercised
 * without a genuinely wedged game; a wedge was never observed in any real run. 0 clears it. */
EMSCRIPTEN_KEEPALIVE void bgb_debug_force_asleep(uint32_t mask) { g_force_sleep = mask; }
/* The unix time (seconds, a double) the RTC source of this seat reports right now. Goes around the latch witness on purpose. */
EMSCRIPTEN_KEEPALIVE double bgb_rtc_unix(int seat) {
	if (seat < 0 || seat >= g_n || !g_seat[seat].core) {
		return -1.0;
	}
	time_t (*raw)(struct mRTCSource*) = g_rtc_orig_unix ? g_rtc_orig_unix : g_seat[seat].core->rtc.d.unixTime;
	return (double) raw(&g_seat[seat].core->rtc.d);
}

/* The wrapper installed by apply_rtc(): returns exactly what the stock source returns and records that the guest asked. */
static time_t rtc_unix_witness(struct mRTCSource* src) {
	time_t t = g_rtc_orig_unix(src);
	for (int i = 0; i < g_n; ++i) {
		if (g_seat[i].core && src == &g_seat[i].core->rtc.d) {
			struct RtcWit* w = &g_rtcw[i];
			if (w->latches == 0) {
				w->first = (int64_t) t;
			}
			w->last = (int64_t) t;
			++w->latches;
			int64_t v = (int64_t) t;
			uint8_t b[8];
			for (int k = 0; k < 8; ++k) {
				b[k] = (uint8_t) ((uint64_t) v >> (8 * k));
			}
			w->digest = fnv_bytes(w->digest, b, 8);
			break;
		}
	}
	return t;
}

/* out[0..15] (uint32): the RTC witness of one seat. Returns 0 if the seat does not exist.
 *   0 latches since the last load/reset        1,2 first unix time handed to the guest (lo, hi)    3,4 last unix time handed (lo, hi)
 *   5 FNV-1a over every unix time handed out   6 calendar bytes 0-3 as the game last latched them (year,month,day,weekday; BCD, LE)
 *   7 calendar bytes 4-6 (hour,min,sec) | rtc control byte << 24     8 last RTC command byte the game sent   9 hw.devices bitmask (bit 0 = RTC present)
 *   10 pinned (1/0)   11 pinned UTC offset in seconds (int32), 0x7FFFFFFF when the host zone is in force   12..15 zero */
EMSCRIPTEN_KEEPALIVE int bgb_rtc_witness(int seat, uint32_t* out) {
	if (seat < 0 || seat >= g_n || !g_seat[seat].core) {
		return 0;
	}
	const struct RtcWit* w = &g_rtcw[seat];
	const struct GBACartridgeHardware* hw = &((struct GBA*) g_seat[seat].core->board)->memory.hw;
	memset(out, 0, 16 * sizeof(uint32_t));
	out[0] = w->latches;
	out[1] = (uint32_t) ((uint64_t) w->first & 0xFFFFFFFFu);
	out[2] = (uint32_t) ((uint64_t) w->first >> 32);
	out[3] = (uint32_t) ((uint64_t) w->last & 0xFFFFFFFFu);
	out[4] = (uint32_t) ((uint64_t) w->last >> 32);
	out[5] = w->digest;
	out[6] = (uint32_t) hw->rtc.time[0] | ((uint32_t) hw->rtc.time[1] << 8) | ((uint32_t) hw->rtc.time[2] << 16) | ((uint32_t) hw->rtc.time[3] << 24);
	out[7] = (uint32_t) hw->rtc.time[4] | ((uint32_t) hw->rtc.time[5] << 8) | ((uint32_t) hw->rtc.time[6] << 16) | ((uint32_t) hw->rtc.control << 24);
	out[8] = (uint32_t) hw->rtc.command;
	out[9] = hw->devices;
	out[10] = g_rtc_pinned ? 1u : 0u;
	out[11] = bementalRtcPinned ? (uint32_t) bementalRtcUtcOffsetSec : 0x7FFFFFFFu;
	return 1;
}
EMSCRIPTEN_KEEPALIVE int bgb_rtc_tz_offset_sec(void) { return bementalRtcPinned ? (int) bementalRtcUtcOffsetSec : 0x7FFFFFFF; /* INT_MAX = host zone */ }
EMSCRIPTEN_KEEPALIVE void bgb_set_recover_after(int calls) { g_recover_after = calls < 0 ? 0 : calls; }
EMSCRIPTEN_KEEPALIVE int bgb_seats(void) { return g_n; }
EMSCRIPTEN_KEEPALIVE double bgb_cycles(int seat) { return seat >= 0 && seat < g_n ? (double) g_seat[seat].cycles : -1.0; }
EMSCRIPTEN_KEEPALIVE uint32_t bgb_frame_counter(int seat) {
	return seat >= 0 && seat < g_n && g_seat[seat].loaded ? g_seat[seat].core->frameCounter(g_seat[seat].core) : 0;
}
EMSCRIPTEN_KEEPALIVE int bgb_frame_cycles(void) {
	return g_seat[0].loaded ? g_seat[0].core->frameCycles(g_seat[0].core) : 0;
}

/* out[] layout (uint32): see BGB_STAT_* in bemental_gba.h. */
EMSCRIPTEN_KEEPALIVE void bgb_stats(uint32_t* out) {
	memset(out, 0, BGB_STAT_WORDS * sizeof(uint32_t));
	out[BGB_STAT_VERSION] = BGB_ABI_VERSION;
	out[BGB_STAT_SEATS] = (uint32_t) g_n;
	out[BGB_STAT_CALLS] = g_calls;
	out[BGB_STAT_LOOP_STALLS] = g_loop_stalls;
	out[BGB_STAT_STEP_CAPS] = g_step_caps;
	out[BGB_STAT_INCIDENTS] = g_incident_total;
	out[BGB_STAT_STALL_RUN] = g_stall_run;
	uint32_t am = 0, dm = 0;
	if (g_n) {
		am = masks(&dm);
	}
	out[BGB_STAT_ASLEEP_MASK] = am;
	out[BGB_STAT_AHEAD_STEPS] = g_ahead_steps;
	out[BGB_STAT_SLEEPS] = g_sleeps;
	out[BGB_STAT_WAKES] = g_wakes;
	out[BGB_STAT_YIELDS] = g_yields;
	if (g_has_coord) {
		out[BGB_STAT_TRANSFERS] = g_coord.witnessTransfers;
		out[BGB_STAT_MULTI_NODATA] = g_coord.witnessMultiNoData;
		out[BGB_STAT_RECOVERS] = g_coord.witnessRecovers;
		out[BGB_STAT_ATTACHED] = (uint32_t) g_coord.nAttached;
		out[BGB_STAT_WAITING] = g_coord.waiting;
		out[BGB_STAT_TRANSFER_ACTIVE] = g_coord.transferActive ? 1u : 0u;
		uint32_t t = 0;
		for (int k = 0; k < WINDOW; ++k) {
			t += g_trWin[k];
		}
		out[BGB_STAT_TRANSFERS_WIN] = t;
		out[BGB_STAT_MULTI_OK] = g_coord.witnessMultiOk;
		uint32_t o = 0;
		for (int k = 0; k < WINDOW; ++k) {
			o += g_okWin[k];
		}
		out[BGB_STAT_MULTI_OK_WIN] = o;
		for (int k = 0; k < 4; ++k) {
			out[BGB_STAT_MULTI_LAST + k] = g_coord.witnessMultiLast[k];
		}
	}
	for (int i = 0; i < g_n; ++i) {
		struct Seat* s = &g_seat[i];
		if (!s->loaded) {
			continue;
		}
		out[BGB_STAT_SIO_IRQS + i] = ((struct GBA*) s->core->board)->witnessSioIrqs;
		out[BGB_STAT_SIO_LAST + i] = s->sioWin[g_calls % WINDOW];
		uint32_t w = 0;
		for (int k = 0; k < WINDOW; ++k) {
			w += s->sioWin[k];
		}
		out[BGB_STAT_SIO_WIN + i] = w;
		out[BGB_STAT_FRAMES + i] = s->lastFc - s->fcBase;
	}
}

EMSCRIPTEN_KEEPALIVE uint32_t bgb_incident_total(void) { return g_incident_total; }
/* Retained incidents are the last MAX_INCIDENTS; index is the absolute incident number. Returns 0 if not retained. */
EMSCRIPTEN_KEEPALIVE int bgb_incident_read(uint32_t index, uint32_t* out) {
	if (index >= g_incident_total || g_incident_total - index > MAX_INCIDENTS) {
		return 0;
	}
	memcpy(out, &g_incident[index % MAX_INCIDENTS], sizeof(struct Incident));
	return 1;
}

/* ---- identity ------------------------------------------------------------------------------------------------------- */

/* out: 40 bytes = title[17] system[4] code[5] maker[3] version[1] (the cartridge header, as mGBA reads it) + 10 zero pad. */
EMSCRIPTEN_KEEPALIVE int bgb_game_info(int seat, uint8_t* out) {
	if (seat < 0 || seat >= g_n || !g_seat[seat].loaded) {
		return 0;
	}
	struct mGameInfo info;
	memset(&info, 0, sizeof(info));
	g_seat[seat].core->getGameInfo(g_seat[seat].core, &info);
	memset(out, 0, 40);
	memcpy(out, info.title, 17);
	memcpy(out + 17, info.system, 4);
	memcpy(out + 21, info.code, 5);
	memcpy(out + 26, info.maker, 3);
	out[29] = info.version;
	return 1;
}
EMSCRIPTEN_KEEPALIVE uint32_t bgb_rom_crc32(int seat) {
	return seat >= 0 && seat < g_n && g_seat[seat].loaded ? ((struct GBA*) g_seat[seat].core->board)->romCrc32 : 0;
}
EMSCRIPTEN_KEEPALIVE int bgb_rom_pristine(int seat) {
	return seat >= 0 && seat < g_n && g_seat[seat].loaded ? (((struct GBA*) g_seat[seat].core->board)->isPristine ? 1 : 0) : -1;
}
EMSCRIPTEN_KEEPALIVE int bgb_savedata_type(int seat) {
	return seat >= 0 && seat < g_n && g_seat[seat].loaded ? (int) ((struct GBA*) g_seat[seat].core->board)->memory.savedata.type : -2;
}

/* gpgx_shim.c — a minimal libretro FRONTEND, compiled into the same wasm module
 * as the Genesis-Plus-GX libretro core, exposing a flat C API to genesis.html.
 *
 * Why a shim rather than a libretro frontend in JS: the core is a static archive
 * of wasm objects (Makefile.libretro platform=emscripten sets STATIC_LINKING=1 and
 * emar's the objects into genesis_plus_gx_libretro_emscripten.bc), so the retro_*
 * entry points are ordinary symbols in this module. Implementing the five
 * callbacks in C keeps every per-frame copy inside wasm; JS only reads two
 * pointers per frame. This mirrors what snes/snesWasm/source/exports.c does for
 * snes9x_2005, which is the pattern snes.html is already built around.
 *
 * ROM DELIVERY IS FROM MEMORY, NOT A FILE. GPGX's retro_get_system_info reports
 * need_fullpath=true (libretro/libretro.c:3131) but it also registers a
 * SET_CONTENT_INFO_OVERRIDE for md/bin/smd/gen with need_fullpath=false
 * (libretro/libretro.c:3060-3072, the !LOW_MEMORY arm), and load_archive()
 * short-circuits to the in-memory buffer whenever g_rom_data is set
 * (libretro/libretro.c:377-390). g_rom_data is only ever set from
 * RETRO_ENVIRONMENT_GET_GAME_INFO_EXT (libretro/libretro.c:3434-3438), so this
 * shim answers that call and no filesystem is needed at all.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <emscripten.h>

#include "libretro.h"

/* ── frame buffer ────────────────────────────────────────────────────────────
 * The core hands us RGB565 at a FIXED pitch of 720*2 bytes
 * (libretro/libretro.c:4009 passes `720 * 2` literally), with width/height
 * varying per mode — 320x224 for a normal NTSC Mega Drive frame, up to
 * 720x576 for PAL + NTSC-filter + interlace. Size the destination for that
 * maximum so no mode can overflow it. */
#define GPX_MAX_W 720
#define GPX_MAX_H 576

static uint8_t  vid_rgba[GPX_MAX_W * GPX_MAX_H * 4];
static unsigned vid_w = 320, vid_h = 224;
static int      vid_new = 0;      /* a frame arrived since the last read */

/* ── audio ring ──────────────────────────────────────────────────────────────
 * 44100 Hz stereo (SOUND_FREQUENCY, libretro/libretro.c:204). A Mega Drive
 * frame is ~736 stereo frames, so 32768 holds ~0.74 s — deep enough that a
 * ScriptProcessor block (2048) never has to race retro_run. */
#define ARING 32768                      /* MUST be a power of two */
static int16_t  aring[ARING * 2];
static unsigned a_w = 0, a_r = 0;        /* free-running frame counters */
static float    aout[8192 * 2];          /* interleaved f32 handed to JS */

/* ── input ───────────────────────────────────────────────────────────────────
 * One int16 RETRO_DEVICE_JOYPAD bitmask per port. The core reads port 0 with
 * RETRO_DEVICE_ID_JOYPAD_MASK when bitmasks are supported
 * (libretro/libretro.c:462) and with individual ids otherwise
 * (libretro/libretro.c:701 osd_input_update_internal), so both are served. */
#define GPX_PORTS 8
static int16_t pad[GPX_PORTS];

/* ── rom, kept alive for the module's lifetime ───────────────────────────── */
static uint8_t *rom_buf  = NULL;
static size_t   rom_size = 0;
static char     rom_name[256] = "game";
static char     rom_ext[16]   = "gen";
static char     rom_path[512] = "/game.gen";

static int core_inited = 0;
static int game_loaded = 0;

/* ── rollback support (off by default; genesis.html turns it on for a
 * rollback room only) ────────────────────────────────────────────────────────
 * fast_states: answer RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE with bit 2
 * ("use fast savestates"). Without it retro_unserialize() runs state_load() ->
 * system_reset() with reset_do_not_clear_buffers = 0 (core/state.c:64-66),
 * which clears VDP/render/pattern-cache buffers that are NOT in the blob, and
 * the FM/blip sound buffer state is not restored (libretro.c retro_unserialize
 * -> restore_sound_buffer only under fast_savestates). MEASURED on the shipped
 * binary (tools/rollback_state_measure.mjs): a run that had loaded a state
 * diverged from one that had not, byte-for-byte, within 1 frame — so a
 * rollback could never re-converge with a peer that did not roll back. This is
 * the upstream mechanism RetroArch run-ahead / rollback netplay rely on.
 * With fast_states == 0 the callback answers exactly as before (unsupported),
 * so single-player and lockstep keep the shipped behaviour.
 *
 * vid_skip: during a rollback RE-SIMULATION the frames are never presented,
 * so the RGB565 -> RGBA conversion (not part of the emulated state) is skipped.
 */
static int fast_states = 0;
static int vid_skip = 0;

static double av_fps         = 59.922751;
static double av_sample_rate = 44100.0;

/* ── logging ─────────────────────────────────────────────────────────────── */
static int log_enabled = 0;
static void gpx_log(enum retro_log_level level, const char *fmt, ...)
{
   char line[1024];
   va_list ap;
   if (!log_enabled && level < RETRO_LOG_WARN)
      return;
   va_start(ap, fmt);
   vsnprintf(line, sizeof(line), fmt, ap);
   va_end(ap);
   printf("[gpgx] %s", line);
}

/* ── environment ─────────────────────────────────────────────────────────── */
static bool env_cb(unsigned cmd, void *data)
{
   switch (cmd)
   {
      case RETRO_ENVIRONMENT_GET_CAN_DUPE:
         *(bool *)data = true;
         return true;

      case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
         /* The core asks for RGB565 (libretro/libretro.c:3489) and that is the
          * only format this shim's converter understands, so accept only it. */
         return *(enum retro_pixel_format *)data == RETRO_PIXEL_FORMAT_RGB565;

      case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
         ((struct retro_log_callback *)data)->log = gpx_log;
         return true;

      case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
         return true;

      case RETRO_ENVIRONMENT_GET_VARIABLE:
      {
         /* CLEARING value IS LOAD-BEARING. check_variables() reuses ONE stack
          * `struct retro_variable var` across ~60 queries
          * (libretro/libretro.c:1381), assigning only .key each time. A
          * frontend that returns false WITHOUT clearing .value leaves the
          * previous option's string in place, so every later option would be
          * compared against an unrelated value. Nulling it makes each
          * `if (!var.value)` branch take the core's own default. */
         struct retro_variable *var = (struct retro_variable *)data;
         var->value = NULL;
         return false;
      }

      case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
         *(bool *)data = false;
         return true;

      case RETRO_ENVIRONMENT_GET_GAME_INFO_EXT:
      {
         static struct retro_game_info_ext ext;
         const struct retro_game_info_ext **out =
            (const struct retro_game_info_ext **)data;
         if (!rom_buf || !rom_size)
            return false;
         memset(&ext, 0, sizeof(ext));
         ext.full_path       = rom_path;
         ext.dir             = "/";
         ext.name            = rom_name;
         ext.ext             = rom_ext;
         ext.data            = rom_buf;
         ext.size            = rom_size;
         ext.file_in_archive = false;
         ext.persistent_data = true;   /* rom_buf outlives retro_load_game */
         *out = &ext;
         return true;
      }

      /* Accepted-and-ignored: the core only needs a truthy answer. */
      case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
      case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
      case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
      case RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS:
      case RETRO_ENVIRONMENT_SET_DISK_CONTROL_INTERFACE:
      case RETRO_ENVIRONMENT_SET_DISK_CONTROL_EXT_INTERFACE:
      case RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS:
      case RETRO_ENVIRONMENT_SET_CONTENT_INFO_OVERRIDE:
      case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
      case RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO:
      case RETRO_ENVIRONMENT_SET_VARIABLES:
      case RETRO_ENVIRONMENT_SET_CORE_OPTIONS:
      case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_INTL:
      case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY:
      case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2:
      case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL:
         return true;

      case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
      {
         const struct retro_system_av_info *av =
            (const struct retro_system_av_info *)data;
         if (av->timing.fps > 1.0)         av_fps         = av->timing.fps;
         if (av->timing.sample_rate > 1.0) av_sample_rate = av->timing.sample_rate;
         return true;
      }

      case RETRO_ENVIRONMENT_SET_GEOMETRY:
         return true;

      case RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE:
         /* See fast_states above. 1 = video, 2 = audio, 4 = fast savestates:
          * video and audio stay enabled, so retro_run takes the same path it
          * takes when this is unanswered (do_skip = 0, audio_hard_disable = 0,
          * libretro.c:3896-3912). Only the savestate behaviour changes. */
         if (!fast_states)
            return false;
         if (data)
            *(int *)data = 1 | 2 | 4;
         return true;

      /* Everything else — system dir, save dir, rumble, perf counters,
       * audio-buffer status, core-option categories/version — is genuinely
       * unsupported here. Returning false makes the core take its own
       * fallback path in each case (e.g. system dir defaults to the rom dir,
       * option version 0 downgrades SET_CORE_OPTIONS_V2 to SET_VARIABLES). */
      default:
         return false;
   }
}

/* ── the four data callbacks ─────────────────────────────────────────────── */
static void video_cb(const void *data, unsigned width, unsigned height,
                     size_t pitch)
{
   const uint8_t *src = (const uint8_t *)data;
   unsigned y, x;

   if (width  > GPX_MAX_W) width  = GPX_MAX_W;
   if (height > GPX_MAX_H) height = GPX_MAX_H;
   vid_w = width;
   vid_h = height;

   if (vid_skip)
      return;

   /* NULL means "repeat the last frame" (libretro.c:4011 on a skipped frame).
    * Leave vid_rgba alone and report no new frame. */
   if (!src)
      return;

   for (y = 0; y < height; y++)
   {
      const uint16_t *row = (const uint16_t *)(src + y * pitch);
      uint8_t *dst = vid_rgba + (size_t)y * width * 4;
      for (x = 0; x < width; x++)
      {
         uint16_t c = row[x];
         /* RGB565 -> RGBA8888, replicating the high bits into the low ones so
          * full-scale 0x1f/0x3f maps to 0xff rather than 0xf8/0xfc. */
         uint8_t r = (uint8_t)((c >> 11) & 0x1f); r = (uint8_t)((r << 3) | (r >> 2));
         uint8_t g = (uint8_t)((c >>  5) & 0x3f); g = (uint8_t)((g << 2) | (g >> 4));
         uint8_t b = (uint8_t)( c        & 0x1f); b = (uint8_t)((b << 3) | (b >> 2));
         dst[x * 4 + 0] = r;
         dst[x * 4 + 1] = g;
         dst[x * 4 + 2] = b;
         dst[x * 4 + 3] = 0xff;
      }
   }
   vid_new = 1;
}

static void audio_push(int16_t l, int16_t r)
{
   unsigned i = a_w & (ARING - 1);
   aring[i * 2 + 0] = l;
   aring[i * 2 + 1] = r;
   a_w++;
   /* Overrun: drop the oldest frame rather than let the reader read torn data.
    * This only happens if JS stops pulling audio (tab hidden with the loop
    * still running), and dropping is the honest behaviour there. */
   if (a_w - a_r > ARING)
      a_r = a_w - ARING;
}

static void audio_sample_cb(int16_t l, int16_t r) { audio_push(l, r); }

static size_t audio_batch_cb(const int16_t *data, size_t frames)
{
   size_t i;
   for (i = 0; i < frames; i++)
      audio_push(data[i * 2 + 0], data[i * 2 + 1]);
   return frames;
}

static void input_poll_cb(void) { }

static int16_t input_state_cb(unsigned port, unsigned device,
                              unsigned index, unsigned id)
{
   (void)index;
   if (port >= GPX_PORTS)
      return 0;
   if (device != RETRO_DEVICE_JOYPAD)
      return 0;
   if (id == RETRO_DEVICE_ID_JOYPAD_MASK)
      return pad[port];
   if (id >= 16)
      return 0;
   return (pad[port] >> id) & 1;
}

/* ── exported API ────────────────────────────────────────────────────────── */

EMSCRIPTEN_KEEPALIVE
void gpx_set_log(int on) { log_enabled = on ? 1 : 0; }

EMSCRIPTEN_KEEPALIVE
void gpx_init(void)
{
   if (core_inited)
      return;
   /* Order matters: retro_set_environment MUST precede retro_init — the core
    * registers its options and queries GET_INPUT_BITMASKS from inside them. */
   retro_set_environment(env_cb);
   retro_set_video_refresh(video_cb);
   retro_set_audio_sample(audio_sample_cb);
   retro_set_audio_sample_batch(audio_batch_cb);
   retro_set_input_poll(input_poll_cb);
   retro_set_input_state(input_state_cb);
   retro_init();
   core_inited = 1;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *gpx_alloc(unsigned n) { return (uint8_t *)malloc(n); }

EMSCRIPTEN_KEEPALIVE
void gpx_free(uint8_t *p) { free(p); }

/* ext: a bare extension string ("gen", "bin", "md", "sms", "gg"), used both for
 * the fake path the core stores and for its own system detection. */
EMSCRIPTEN_KEEPALIVE
int gpx_load(const uint8_t *data, unsigned size, const char *name, const char *ext)
{
   struct retro_game_info info;
   struct retro_system_av_info av;

   gpx_init();

   if (game_loaded)
   {
      retro_unload_game();
      game_loaded = 0;
   }

   free(rom_buf);
   rom_buf = (uint8_t *)malloc(size);
   if (!rom_buf)
      return 0;
   memcpy(rom_buf, data, size);
   rom_size = size;

   snprintf(rom_name, sizeof(rom_name), "%s", (name && *name) ? name : "game");
   snprintf(rom_ext,  sizeof(rom_ext),  "%s", (ext  && *ext)  ? ext  : "gen");
   snprintf(rom_path, sizeof(rom_path), "/%s.%s", rom_name, rom_ext);

   memset(&info, 0, sizeof(info));
   info.path = rom_path;
   info.data = rom_buf;
   info.size = rom_size;

   if (!retro_load_game(&info))
      return 0;
   game_loaded = 1;

   memset(&av, 0, sizeof(av));
   retro_get_system_av_info(&av);
   if (av.timing.fps > 1.0)         av_fps         = av.timing.fps;
   if (av.timing.sample_rate > 1.0) av_sample_rate = av.timing.sample_rate;
   vid_w = av.geometry.base_width  ? av.geometry.base_width  : 320;
   vid_h = av.geometry.base_height ? av.geometry.base_height : 224;

   a_w = a_r = 0;
   vid_new = 0;
   memset(pad, 0, sizeof(pad));
   return 1;
}

EMSCRIPTEN_KEEPALIVE
void gpx_run(void)
{
   if (!game_loaded)
      return;
   vid_new = 0;
   retro_run();
}

EMSCRIPTEN_KEEPALIVE
void gpx_reset(void) { if (game_loaded) retro_reset(); }

EMSCRIPTEN_KEEPALIVE
uint8_t *gpx_video(void)  { return vid_rgba; }
EMSCRIPTEN_KEEPALIVE
unsigned gpx_width(void)  { return vid_w; }
EMSCRIPTEN_KEEPALIVE
unsigned gpx_height(void) { return vid_h; }
EMSCRIPTEN_KEEPALIVE
int gpx_frame_is_new(void){ return vid_new; }

EMSCRIPTEN_KEEPALIVE
double gpx_fps(void)         { return av_fps; }
EMSCRIPTEN_KEEPALIVE
double gpx_sample_rate(void) { return av_sample_rate; }

EMSCRIPTEN_KEEPALIVE
void gpx_set_pad(unsigned port, int mask)
{
   if (port < GPX_PORTS)
      pad[port] = (int16_t)mask;
}

/* ── the multitap: players 3 and 4 ───────────────────────────────────────────
 * A Mega Drive has two controller ports. Players 3-4 exist only behind an
 * adaptor, and Genesis-Plus-GX emulates both kinds (core/input_hw/
 * gamepad.c wayplay_*, teamplayer.c) behind libretro's
 * retro_set_controller_port_device() (libretro/libretro.c) — which this shim
 * never called, so every game saw two plain pads.
 *   kind 1  EA 4-Way Play   (both ports; EA's games)
 *   kind 2  Sega Team Player in port A (players 1-4 on the tap)
 *   kind 3  Sega Team Player in port B (player 1 on port A, 2-5 on the tap)
 *   kind 0  every adaptor out — the console a fresh page boots
 *           (bemental_input_defaults, genesis/genesisWasm/tools/
 *           patch_input_state.py). Only does anything if one was plugged in,
 *           so a two-player room never touches the input config at all.
 * six != 0 plugs 6-button pads into the adaptor, else 3-button (the page
 * follows the cart header's '6', as GPGX's own input_init does).
 * In every kind, libretro player p (this shim's pad[p]) is the p-th pad the
 * core enumerates (libretro.c osd_input_update), so room port p drives the
 * p-th controller of the room: for kinds 1/2, tap pads 1-4; for kind 3, port A
 * then tap pads 1-3.
 * It is part of the STARTING state (a multitap game probes for the adaptor at
 * boot), so genesis.html calls it before frame 0, from the agreed roster, on
 * every console. It is NOT in the savestate and does not need to be: a load
 * never re-plugs devices, so every rollback load keeps it.
 * Returns the kind now plugged in, or -1 (no game / unknown kind). */
#define GPX_RDEV(n) RETRO_DEVICE_SUBCLASS(RETRO_DEVICE_JOYPAD, n)
extern int  bemental_input_system(int port);
extern int  bemental_input_dev(int i);
extern void bemental_input_defaults(void);
static int mt_kind = 0;

EMSCRIPTEN_KEEPALIVE
int gpx_set_multitap(int kind, int six)
{
   if (!game_loaded)
      return -1;
   switch (kind)
   {
      case 0: if (mt_kind) bemental_input_defaults(); break;
      case 1: retro_set_controller_port_device(0, six ? GPX_RDEV(4) : GPX_RDEV(3)); break;
      case 2: retro_set_controller_port_device(0, six ? GPX_RDEV(6) : GPX_RDEV(5)); break;
      case 3: retro_set_controller_port_device(1, six ? GPX_RDEV(6) : GPX_RDEV(5)); break;
      default: return -1;
   }
   mt_kind = kind;
   return mt_kind;
}

/* Read-backs for a test: what the CORE has plugged in (input.system[port]:
 * core/input_hw/input.h SYSTEM_*), and which pad it enumerated at device i
 * (input.dev[i]: DEVICE_PAD3B = 0, DEVICE_PAD6B = 1, NO_DEVICE = 0xff). */
EMSCRIPTEN_KEEPALIVE
int gpx_input_system(int port) { return bemental_input_system(port); }
EMSCRIPTEN_KEEPALIVE
int gpx_input_dev(int i) { return bemental_input_dev(i); }

/* Read-back for a test: the 68000's 64 KB of work RAM, where a test ROM
 * (tools/genesis_multitap_rom.mjs) leaves what the GUEST read off its pads. */
EMSCRIPTEN_KEEPALIVE
uint8_t *gpx_wram_ptr(void)
{
   return game_loaded ? (uint8_t *)retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM) : NULL;
}

EMSCRIPTEN_KEEPALIVE
unsigned gpx_audio_avail(void) { return a_w - a_r; }

/* Copies up to `frames` stereo frames into a static interleaved f32 buffer and
 * returns how many were actually available. JS reads the pointer from
 * gpx_audio_buf(); it is stable for the module's lifetime. */
EMSCRIPTEN_KEEPALIVE
unsigned gpx_audio_read(unsigned frames)
{
   unsigned avail = a_w - a_r, i;
   if (frames > 8192) frames = 8192;
   if (frames > avail) frames = avail;
   for (i = 0; i < frames; i++)
   {
      unsigned idx = (a_r + i) & (ARING - 1);
      aout[i * 2 + 0] = aring[idx * 2 + 0] / 32768.0f;
      aout[i * 2 + 1] = aring[idx * 2 + 1] / 32768.0f;
   }
   a_r += frames;
   return frames;
}

EMSCRIPTEN_KEEPALIVE
float *gpx_audio_buf(void) { return aout; }

EMSCRIPTEN_KEEPALIVE
void gpx_audio_clear(void) { a_r = a_w; }

/* Rollback: the write cursor before a re-simulation, and a rewind to it
 * afterwards, so the re-simulated frames' audio (a repeat of frames already
 * heard) is discarded exactly, without touching what is still queued. */
EMSCRIPTEN_KEEPALIVE
unsigned gpx_audio_wpos(void) { return a_w; }
EMSCRIPTEN_KEEPALIVE
void gpx_audio_rewind(unsigned w)
{
   /* only ever backwards, and never behind the reader */
   if ((unsigned)(a_w - w) <= (unsigned)(a_w - a_r))
      a_w = w;
}

EMSCRIPTEN_KEEPALIVE
void gpx_set_fast_savestates(int on) { fast_states = on ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE
void gpx_set_video_skip(int on) { vid_skip = on ? 1 : 0; }

/* ── save states ─────────────────────────────────────────────────────────── */
EMSCRIPTEN_KEEPALIVE
unsigned gpx_state_size(void)
{
   return game_loaded ? (unsigned)retro_serialize_size() : 0u;
}

EMSCRIPTEN_KEEPALIVE
int gpx_state_save(uint8_t *dst, unsigned size)
{
   if (!game_loaded)
      return 0;
   return retro_serialize(dst, size) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
int gpx_state_load(const uint8_t *src, unsigned size)
{
   if (!game_loaded)
      return 0;
   return retro_unserialize(src, size) ? 1 : 0;
}

/* ── SRAM (battery-backed cart save) ─────────────────────────────────────── */
EMSCRIPTEN_KEEPALIVE
unsigned gpx_sram_size(void)
{
   return game_loaded ? (unsigned)retro_get_memory_size(RETRO_MEMORY_SAVE_RAM) : 0u;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *gpx_sram_ptr(void)
{
   return game_loaded
      ? (uint8_t *)retro_get_memory_data(RETRO_MEMORY_SAVE_RAM)
      : NULL;
}

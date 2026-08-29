// Worker-side Flycast bridge.
// Wraps the existing libretro retro_* API (linked from libflycast_libretro.a)
// and forwards video/audio out via postMessage / SAB ringbuffer to the page.
//
// Mirrors the shape of gamecube/dolphin-bridge/EmscriptenWorker.cpp but for
// Flycast's Dreamcast/NAOMI libretro core. Public C-linkage exports are named
// emscripten_* so emcc EXPORTED_FUNCTIONS picks them up with a single
// underscore prefix on the JS side (e.g. _emscripten_run_iter).
//
// Flycast's libretro callbacks live in shell/libretro/libretro.cpp. The
// pixel format is set by the core itself to RETRO_PIXEL_FORMAT_XRGB8888
// (libretro.cpp:345), so video_cb delivers 4-byte/pixel frames. We do NOT
// touch the format here.

#include <emscripten.h>
#include <emscripten/html5.h>
#include <emscripten/html5_webgl.h>
#include <emscripten/threading.h>
#include <atomic>
#include <cstdint>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdarg>

// Pull in the libretro.h that Flycast itself uses. The path is the bundled
// libretro-common include dir under flycast-src; the link script adds it to
// the include path. If the include search path is missing this header, the
// minimal extern "C" prototypes below cover the symbols we actually call.
#include <libretro.h>

// Flycast SH4 mem + opcode tables — used by the rec_wasm JS-import wrappers
// at the bottom of this file. Both headers are declarations of extern
// function pointers / arrays that the main libretro archive defines.
#include "hw/sh4/sh4_mem.h"
#include "hw/sh4/sh4_if.h"
#include "hw/sh4/sh4_core.h"
#include "hw/sh4/sh4_rom.h"   // sin_table — shop_fsca host impl
#include "hw/sh4/dyna/shil.h"          // shop_sync_sr / shop_sync_fpscr enums
#include "hw/sh4/dyna/blockmanager.h"  // bm_GetBlock
#include "imgread/common.h"             // libGDR_GetDiscType, DiscType enum
#include "hw/sh4/sh4_opcode_list.h"
#include "hw/sh4/sh4_interrupts.h"   // SR/decoded_srimask access for IRQ trace
#include "hw/sh4/sh4_sched.h"        // sh4_sched_now64 — guest-clock telemetry
#include "hw/sh4/sh4_mmr.h"          // CCN_QACR0 — lever-12 store-queue TA/RAM split
#include "hw/holly/holly_intc.h"     // asic_RaiseInterrupt + HollyInterruptID
#include "hw/holly/sb.h"             // SB_ISTNRM/SB_ISTEXT — boot-progress telemetry

extern "C" void rec_wasm_flush_rings(void);  // rec_wasm.cpp — stuck-pc ring dump
#include "stdclass.h"   // set_user_data_dir, get_readonly_data_path
#include "cfg/option.h" // config::CustomTextures / PreloadCustomTextures
#include "oslib/storage.h"
#include "oslib/oslib.h"   // hostfs::findFlash
#include "hw/maple/maple_cfg.h" // MDT_SegaVMU, MapleDeviceType
#include "hw/maple/maple_if.h"  // MapleDevices[][]

extern "C" {
void retro_init(void);
void retro_deinit(void);
void retro_set_environment(retro_environment_t cb);
void retro_set_video_refresh(retro_video_refresh_t cb);
void retro_set_audio_sample(retro_audio_sample_t cb);
void retro_set_audio_sample_batch(retro_audio_sample_batch_t cb);
void retro_set_input_poll(retro_input_poll_t cb);
void retro_set_input_state(retro_input_state_t cb);
void retro_run(void);
void retro_reset(void);
void retro_set_controller_port_device(unsigned port, unsigned device);
bool retro_load_game(const struct retro_game_info* info);
void retro_unload_game(void);
size_t retro_serialize_size(void);
bool retro_serialize(void* data, size_t size);
bool retro_unserialize(const void* data, size_t size);
}

// ---------------------------------------------------------------------------
// Delivered-vblank counters (2026-08-28) — defined in core/hw/pvr/spg.cpp.
//
// Declared here rather than in spg.h so this stays a two-symbol dependency on
// the core and does not force a rebuild of everything that includes spg.h.
// C++ linkage on both sides, so the mangled names match.
//
//   spg_vblank_frames  — monotonic count of field starts (prv_cur_scanline
//                        wraps to 0). SAME event native's vblk_cnt counts, so
//                        its rate is directly comparable to native's "V:".
//   spg_vblank_in_ints — monotonic count of SCANINT1 (vblank-IN) raises.
//   spg_frame_cycles() — live Frame_Cycles, i.e. SH4 cycles per field as the
//                        SPG registers are ACTUALLY programmed right now. The
//                        register-derived prediction is
//                        SH4_MAIN_CLOCK / Frame_Cycles (200e6 / 3336375 =
//                        59.9453/s for NTSC 480i), computed from the live
//                        value instead of hardcoded.
//
// Why this exists: before it, the port could COMPUTE its vblank rate from
// SPG_LOAD/SPG_CONTROL/FB_R_CTRL but could never COUNT a delivered one —
// Flycast's own vblk_cnt is behind `#if !defined(NDEBUG) || defined(DEBUGFAST)`
// and ENABLE_LOG is OFF in build-wasm. That made the vblank figure a
// derivation, not a measurement.
extern u32 spg_vblank_frames;
extern u32 spg_vblank_in_ints;
u32 spg_frame_cycles();

// ---------------------------------------------------------------------------
// State shared between callbacks
// ---------------------------------------------------------------------------

// Pad / MAPLE state. JS writes pad bits + analog axes here; input_state_cb
// reads from this buffer. Format is per-port: 8 bytes of digital bitmap
// followed by analog/trigger bytes — JS-side layout is the source of truth
// (flycast_worker_funcs.js will document it). Defaults to all-released.
static uint8_t g_maple_pad_state[256] = {0};

// Optional SAB-backed framebuffer. JS calls emscripten_set_video_target once
// with a SAB pointer + dimensions; video_cb memcpys into it. If unset
// (target=nullptr), video_cb falls back to a Transferable postMessage.
static uint8_t* g_video_target  = nullptr;
static int      g_video_target_w = 0;
static int      g_video_target_h = 0;

// Optional SAB-backed audio ringbuffer. JS calls emscripten_set_audio_ring
// with a heap address + capacity-in-int16-frames. audio_cb writes int16
// stereo samples into it as a simple lock-free SPSC ring. If ring_addr=0
// the audio callback no-ops (samples are dropped).
//
// Ring layout (capacity is power-of-two enforced by JS):
//   [0..3]   uint32 head (writer = audio_cb, JS reader advances tail)
//   [4..7]   uint32 tail (reader = JS audio worklet)
//   [8..]    int16 stereo samples (capacity * 2 * sizeof(int16))
static uint8_t* g_audio_ring_base     = nullptr;
static uint32_t g_audio_ring_capacity = 0;  // in stereo frames

// Audio-path observability (2026-08-28). Before this, BOTH ends of the ring
// failed invisibly: the worklet's stats postMessage had no listener on the
// page, and the writer had no counter at all — `if (free_frames == 0) break;`
// discarded frames and then returned `frames`, telling the core everything was
// consumed. These two monotonic counters are the write side of that fix; they
// are folded into the EXISTING once-per-second 'fps' heartbeat below, so they
// cost two adds per audio batch and zero extra main-thread hops.
//
//   g_audio_frames_written — stereo frames actually stored into the ring
//   g_audio_frames_dropped — stereo frames the core produced that we discarded
//
// (written + dropped) per second IS the AICA production rate, and AICA emits
// exactly one stereo frame per AICA_TICK = 4535 SH4 cycles at SH4_MAIN_CLOCK =
// 200 MHz => 44101.43 Hz. So this pair is a direct, high-resolution witness of
// guest-clock exactness: 44101/s means the guest is running at hardware rate,
// and any deviation is a real rate error (a 1% miss is audible as pitch drift
// and is far more sensitive than any frame counter).
//
// Threading: both are written only by audio_sample_batch_cb and read only by
// the fps heartbeat in video_cb. Both are libretro callbacks invoked from
// retro_run on the same emu pthread, so plain u64 is sufficient — there is no
// cross-agent visibility question for these two.
static uint64_t g_audio_frames_written = 0;
static uint64_t g_audio_frames_dropped = 0;

// ---------------------------------------------------------------------------
// Lever-12 mainloop split, buckets [2] and [3] (2026-08-29).
// Bucket [1] (sh4_sched callbacks) is in rec_wasm.cpp; see the g_attr_sched_ms
// block there for the whole design. These two live here because this file owns
// the guest-side imports they hang off.
//
// WHY THE RENDERER IS TIMED ON THE STORE PATH AND NOT IN THE SCHEDULER
// -------------------------------------------------------------------
// The standing assumption was that Flycast dispatches PVR/TA work from
// sh4_sched callbacks. It does not, in THIS build:
//
//   emulator.cpp Emulator::start() does `config::ThreadedRendering.override(false)`
//   unconditionally under __EMSCRIPTEN__. With threading off,
//   Renderer_if.cpp PvrMessageQueue::enqueue() takes the else-arm and calls
//   execute(msg) INLINE -- there is no render thread and no deferred queue.
//
//   The only producer of Render/Present messages on the hot path is
//   rend_start_render(), and its ONLY caller is pvr_regs.cpp pvr_WriteReg()
//   under `case STARTRENDER_addr:` -- i.e. a guest STORE to 0x005F8014.
//
// So the whole render -- TA context pop, FillBGP, palette_update, the
// renderer's Render(), then Present() -> retro_rend_present() -- executes
// inside ONE guest store instruction, inside a JIT block, inside dispatch_slice,
// inside mainloop. The only sched-side render callback is rend_end_render, and
// all it does is raise three ASIC interrupt lines.
//
// That is why "mainloop is 99.16% of retro_run" could never have separated
// JIT from renderer: the renderer is nested INSIDE the JIT's own dispatch
// path. g_attr_render_ms is the first number that pulls it back out.
//
// Present() also calls emu.getSh4Executor()->Stop() in the non-threaded arm,
// which clears CpuRunning and ends the mainloop -- so this store is also the
// frame boundary. g_attr_render_n should therefore track presents/s closely.
//
// COST: g_attr_render/pvrreg are one get_now pair per Holly/PVR register
// store (tens of thousands/s worst case, ~60/s for STARTRENDER itself).
// g_attr_sq is SAMPLED 1-in-64 because store-queue bursts are the TA vertex
// submission path and can run into the hundreds of thousands/s -- timing every
// one would be the per-dispatch observer effect this instrument exists to avoid.
extern "C" {
double   g_attr_render_ms = 0.0;    // STARTRENDER store: TA parse + draw + present
uint32_t g_attr_render_n  = 0;
double   g_attr_pvrreg_ms = 0.0;    // every OTHER store in the Holly/PVR reg window
uint32_t g_attr_pvrreg_n  = 0;
double   g_attr_sq_ms     = 0.0;    // store-queue bursts: wall of the SAMPLED subset only
uint32_t g_attr_sq_n      = 0;      // exact burst count
uint32_t g_attr_sq_smp    = 0;      // bursts actually timed (extrapolate by n/smp)
uint32_t g_attr_sq_ta_n   = 0;      // subset of g_attr_sq_n routed to the TA FIFO
}
// Buckets [1] and the two enclosing scopes, defined in rec_wasm.cpp. Declared
// up here (not at the later lever-5 extern block) so the fps heartbeat in
// video_cb below can fold the whole split into the message it already sends.
extern "C" {
extern double   g_attr_mainloop_ms, g_attr_retro_ms;
extern double   g_attr_sched_ms;
extern uint32_t g_attr_sched_n;
extern double   g_attr_schedfat_ms;
extern uint32_t g_attr_schedfat_n;
}
// Holly + PVR register window, PHYSICAL: 0x005F6000 (SB_* / DMA control)
// .. 0x005F9FFF (PVR core + TA). Guest stores arrive here with the region bits
// still set, so mask to 29 bits first (P1/P2/P3/P4 all alias the same phys).
static constexpr uint32_t HOLLY_REG_LO  = 0x005F6000u;
static constexpr uint32_t HOLLY_REG_HI  = 0x005F9FFFu;
static constexpr uint32_t STARTRENDER_PADDR = 0x005F8014u;  // pvr_regs.h STARTRENDER_addr 0x14
static constexpr uint32_t SQ_SAMPLE_MASK = 63u;             // time 1 burst in 64

static bool g_loaded = false;

// Libretro hardware-render callback registered by Flycast/glsm via
// SET_HW_RENDER. main() will create the WebGL2 context on this pthread; once
// retro_load_game returns we invoke g_hw_render.context_reset() so Flycast's
// renderer initializes (shader compile, FBO allocate, texture cache build).
static struct retro_hw_render_callback g_hw_render = {};
static bool g_hw_render_registered = false;

static uintptr_t hw_get_current_framebuffer_cb(void) {
    return 0;  // default FB = OffscreenCanvas backbuffer
}
static retro_proc_address_t hw_get_proc_address_cb(const char* sym) {
    return (retro_proc_address_t)emscripten_webgl_get_proc_address(sym);
}

// ---------------------------------------------------------------------------
// libretro callbacks
// ---------------------------------------------------------------------------

// Stub log callback. Without one, Flycast's retro_load_game crashes at
// libretro.cpp:2202 (call_indirect to NULL log_cb). Forward to the page.
static void flycast_log_cb(enum retro_log_level level, const char* fmt, ...) {
    (void)level;
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[flycast.log] ' + UTF8ToString($0)});
    }, buf);
}

static bool environment_cb(unsigned cmd, void* data) {
    switch (cmd) {
        case RETRO_ENVIRONMENT_GET_LOG_INTERFACE: {
            ((struct retro_log_callback*)data)->log = flycast_log_cb;
            return true;
        }
        case RETRO_ENVIRONMENT_SET_HW_RENDER: {
            auto* req = (struct retro_hw_render_callback*)data;
            g_hw_render = *req;
            req->get_current_framebuffer = hw_get_current_framebuffer_cb;
            req->get_proc_address        = hw_get_proc_address_cb;
            g_hw_render.get_current_framebuffer = hw_get_current_framebuffer_cb;
            g_hw_render.get_proc_address        = hw_get_proc_address_cb;
            g_hw_render_registered = true;
            MAIN_THREAD_EM_ASM({
                postMessage({cmd: 'print', txt: '[flycast-worker] SET_HW_RENDER captured (ctx_type=' + $0 + ', ver=' + $1 + '.' + $2 + ')'});
            }, (int)g_hw_render.context_type, (int)g_hw_render.version_major, (int)g_hw_render.version_minor);
            return true;
        }
        case RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER:
            // Steer Flycast to its OpenGL ES 3 path (WebGL2 is GLES3-compatible).
            // Without this it falls back to GLES2 (ctx_type=2) which uses an
            // older shader subset.
            *(unsigned*)data = RETRO_HW_CONTEXT_OPENGLES3;
            return true;
        case RETRO_ENVIRONMENT_GET_LANGUAGE:
            *(unsigned*)data = RETRO_LANGUAGE_ENGLISH;
            return true;
        case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
            *(bool*)data = false;
            return true;
        case RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE:
            *(int*)data = 3;  // bit 0 = video enabled, bit 1 = audio enabled
            return true;
        case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
            *(unsigned*)data = 2;
            return true;
        case RETRO_ENVIRONMENT_GET_FASTFORWARDING:
            *(bool*)data = false;
            return true;
        case RETRO_ENVIRONMENT_GET_CAN_DUPE:
            *(bool*)data = true;
            return true;
        case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
            *(const char**)data = "/";
            return true;
        case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
            *(const char**)data = "/bios";
            return true;
        case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
            return *(const enum retro_pixel_format*)data ==
                   RETRO_PIXEL_FORMAT_XRGB8888;
        case RETRO_ENVIRONMENT_GET_VARIABLE:
            return false;
        default:
            return false;
    }
}

static void video_cb(const void* data, unsigned w, unsigned h, size_t pitch) {
    static unsigned long frame_count = 0;
    static unsigned long real_frame_count = 0;
    // Monotonic present total (2026-08-28). frame_count is every video_cb call
    // = every retro_run (libretro.cpp:1283 calls video_cb exactly once per
    // retro_run, unconditionally); present_total is the subset that carried a
    // frame. calls - presents = libretro dupes, i.e. retro_runs where
    // retro_rend_present() never fired. Needed monotonic because the windowed
    // fps_* counters are rounded to int/s before they leave the worker, which
    // destroys the precision a dupe-fraction needs.
    static unsigned long present_total = 0;
    ++frame_count;
    // RETRO_HW_FRAME_BUFFER_VALID == (void*)-1 is libretro's HARDWARE-rendered
    // frame sentinel: the frame lives in the WebGL2 FBO, NOT at `data`. Flycast
    // is configured for HW rendering (SET_HW_RENDER), so once it produces a
    // frame it passes (void*)-1 here. The old `is_real_frame = data != nullptr`
    // + `if (!data) return` guards let the sentinel through → Path A/B then
    // memcpy'd from 0xFFFFFFFF → wasm "memory access out of bounds" (the OOB
    // the clean/fast build hit at the first rendered frame; the slow diag build
    // never rendered, so it never tripped this). Treat it as a non-software
    // frame: do not dereference `data`. (HW-frame *presentation* via the WebGL
    // canvas / glReadPixels is a separate follow-on.)
    const bool is_hw_frame = (data == (const void*)(intptr_t)-1);
    const bool is_real_frame = (data != nullptr) && !is_hw_frame;
    if (is_real_frame) ++real_frame_count;
    if (is_hw_frame || is_real_frame) ++present_total;
    // fps telemetry (charter Phase 2.1): presents/s posted to the page once
    // per second. A "present" = HW commit_frame or a software frame; the
    // data==NULL dupe sentinel advances the clock but not the count, so an
    // idle/stuck emu correctly reports fps=0. Cost: a few adds per call +
    // one MAIN_THREAD_EM_ASM per second — below measurement noise.
    {
        static double   fps_window_start = 0.0;
        static unsigned fps_presents = 0, fps_hw = 0, fps_calls = 0;
        ++fps_calls;
        if (is_hw_frame || is_real_frame) { ++fps_presents; if (is_hw_frame) ++fps_hw; }
        const double now_ms = emscripten_get_now();
        if (fps_window_start == 0.0) {
            fps_window_start = now_ms;
        } else if (now_ms - fps_window_start >= 1000.0) {
            const double dt_s = (now_ms - fps_window_start) / 1000.0;
            // Guest-clock telemetry (ORDER 19a): sched_kcyc lets the page
            // compute the honest guest-clock rate (delta kcycles / s); pc +
            // ISTNRM/ISTEXT expose boot progress on RELEASE builds with no
            // per-access observer effect (the DIAG [gdrom] trace throttled
            // a poll loop ~1000x and starved the clock it was watching).
            static u64 fps_last_sched = 0;
            const u64 sched_now = sh4_sched_now64();
            const u32 kcyc_delta = (u32)((sched_now - fps_last_sched) / 1024);
            fps_last_sched = sched_now;
            // Audio-ring telemetry (2026-08-28), folded into this SAME message
            // rather than a new one — the heartbeat is already budgeted as
            // below measurement noise and audio must not add a second hop.
            //   awr   = stereo frames/s actually stored into the ring
            //   adrop = stereo frames/s the core produced and we discarded
            // awr + adrop is the raw AICA production rate; see the
            // g_audio_frames_* block at the top of this file for why that is
            // the sharpest guest-rate-exactness witness we have.
            static u64 fps_last_awr = 0, fps_last_adrop = 0;
            const u64 awr_total   = g_audio_frames_written;
            const u64 adrop_total = g_audio_frames_dropped;
            const int awr   = (int)((double)(awr_total   - fps_last_awr)   / dt_s + 0.5);
            const int adrop = (int)((double)(adrop_total - fps_last_adrop) / dt_s + 0.5);
            fps_last_awr   = awr_total;
            fps_last_adrop = adrop_total;
            // ---- delivered-vblank measurement (2026-08-28) ----------------
            // The last instrumentation gap on this platform: the vblank rate
            // was DERIVED from the SPG registers (SH4_MAIN_CLOCK * (hcount+1)
            // / pixel_clock, /2 for interlace, * (vcount+1) => 59.9453/s) but
            // never COUNTED. spg.cpp now keeps two always-on monotonic
            // counters; this folds them into the EXISTING heartbeat instead of
            // adding a second main-thread hop (that pattern cost the GameCube
            // build 38.62% of a worker).
            //
            // Everything below is arithmetic on values already in hand plus
            // one snprintf, once per second, inside a proxied call that was
            // already being made. The formatting is done C-side so the whole
            // line rides on ONE extra EM_ASM argument.
            //
            // EVERY DERIVED FIGURE HERE IS PER-WINDOW (this ~1 s heartbeat).
            // Nothing cumulative is computed C-side, deliberately: the first
            // version of this block kept a cumulative baseline from the first
            // heartbeat, and that baseline sits INSIDE the boot ramp — the
            // guest runs at 0.535x for the first second, and sh4_sched_now64()
            // additionally takes a one-shot ~2.5e10-cycle step somewhere in the
            // first two heartbeats (see the probe's discontinuity report). A
            // cumulative average anchored there is wrong for the whole run and
            // decays toward the truth instead of converging on it, which is
            // exactly the shape of a number that looks like a measurement and
            // is not one.
            //
            // Instead the line carries the RAW MONOTONIC state — n, vbi, cyc,
            // t — and lets the consumer difference any two samples it likes.
            // That is what makes this a measurement: the probe picks a window
            // that starts after boot has settled and does exact arithmetic on
            // two counter readings and two clock readings.
            //
            //   n     spg_vblank_frames   (monotonic, field starts)
            //   vbi   spg_vblank_in_ints  (monotonic, SCANINT1 raises)
            //   cyc   sh4_sched_now64()   (monotonic guest cycles)
            //   t     emscripten_get_now()(worker ms; the clock `cyc` is
            //                              measured against — NOT console
            //                              arrival time, which jitters)
            //   fcyc  Frame_Cycles        (live SPG programming; the computed
            //                              rate is SH4_MAIN_CLOCK / fcyc)
            // win/wguest/wdelta are the same three quantities over just this
            // window, printed so a human reading the log live can see a stall
            // or a step immediately.
            static u64      vbl_cyc_prev = 0;
            static unsigned vbl_last  = 0;      // previous sample (window rate)
            static bool     vbl_primed = false;
            static char     vbl_line[384];
            const unsigned vbl_now = spg_vblank_frames;
            const unsigned vbi_now = spg_vblank_in_ints;
            const u32      fcyc    = spg_frame_cycles();
            if (!vbl_primed) { vbl_primed = true; vbl_last = vbl_now; vbl_cyc_prev = sched_now; }
            const double vbl_win = (double)(vbl_now - vbl_last) / dt_s;
            const double wguest  = ((double)(sched_now - vbl_cyc_prev) / (double)SH4_MAIN_CLOCK) / dt_s;
            const double vbl_pred = fcyc ? (double)SH4_MAIN_CLOCK / (double)fcyc : 0.0;
            const double wexpect  = vbl_pred * wguest;
            vbl_last     = vbl_now;
            vbl_cyc_prev = sched_now;
            // video_cb accounting. calls = retro_run invocations (libretro.cpp
            // calls video_cb exactly once per retro_run), pres = the subset
            // that carried RETRO_HW_FRAME_BUFFER_VALID; the difference is
            // libretro's dupe sentinel (data == 0).
            const unsigned long vcb_calls = frame_count;
            const unsigned long vcb_pres  = present_total;
            snprintf(vbl_line, sizeof(vbl_line),
                     "[vbl] n=%u vbi=%u cyc=%.0f t=%.0f dt=%.3f "
                     "win=%.4f/s wguest=%.5fx pred=%.4f/s wdelta=%+.4f%% "
                     "fcyc=%u calls=%lu pres=%lu",
                     vbl_now, vbi_now, (double)sched_now, now_ms, dt_s,
                     vbl_win, wguest, vbl_pred,
                     wexpect > 0.0 ? (vbl_win / wexpect - 1.0) * 100.0 : 0.0,
                     (unsigned)fcyc, vcb_calls, vcb_pres);
            // ---- lever-12 mainloop split ---------------------------------
            // Which half of the mainloop the ceiling lives in. Every figure is
            // PER-WINDOW (this ~1 s heartbeat), differenced from the previous
            // sample exactly like the [vbl] line above -- nothing cumulative is
            // computed here, for the boot-ramp reason documented there.
            //
            // WHAT EACH FIELD COVERS (read this before quoting any of them):
            //   rr    whole retro_run: mainloop + video_cb + audio upload +
            //         input poll + libretro env churn.
            //   ml    Sh4Recompiler::mainloop only. Nests everything below.
            //   sch   ALL sh4_sched device callbacks (AICA+ARM7, SPG/VBLANK,
            //         TMU, maple, GDROM, DMA-end, RTC, rend_end_render's IRQ
            //         raise). schn is the tick count: compare it to awr+adrop
            //         (= AICA_Sample calls/s) -- if they match, this bucket is
            //         AICA. fat/fatn is the >=50us subset, i.e. the few heavy
            //         device ticks separated from the ~44.1K light AICA ones.
            //   rnd   the STARTRENDER guest store = TA context pop + FillBGP +
            //         palette_update + Render() + Present(). NOT a scheduler
            //         callback -- ThreadedRendering is forced off under
            //         Emscripten so this runs INLINE inside a JIT block.
            //   pvr   every other Holly/PVR register store (0x005F6000-9FFF):
            //         ch2/sort/GDROM DMA arming, TA_LIST_INIT, programming.
            //   sq    store-queue bursts. SAMPLED 1-in-64 (sqn exact, smp
            //         timed); sq is the EXTRAPOLATED estimate, marked '~' so
            //         nobody quotes it as measured. ta= is the subset routed to
            //         the TA FIFO (real polygon submission) rather than to RAM
            //         (the guest's 32-byte memcpy idiom) -- do not call the
            //         whole bucket "TA cost" unless ta ~= n.
            //   jit   RESIDUAL: ml - sch - rnd - pvr - sq. This is SH4 block
            //         execution + dispatch + jit_lookup + IFB + the mem imports.
            //
            // WHAT IT MISSES -- read this before quoting `jit` as pure JIT or
            // `sch` as pure device work:
            //
            //   (a) THE ONE THAT CAN INVERT THE READING: there is a SECOND
            //       render path, and it IS in the scheduler. spg.cpp:193 calls
            //       rend_vblank() from spg_line_sched, and rend_vblank enqueues
            //       RenderFramebuffer+Present when EmulateFramebuffer is set OR
            //       when (!render_called && fb_dirty && FB_R_CTRL.fb_enable) --
            //       i.e. whenever the guest painted the framebuffer directly
            //       instead of issuing a STARTRENDER. EmulateFramebuffer
            //       defaults false, and an in-game frame issues STARTRENDER, so
            //       this should be dormant during gameplay -- but boot screens
            //       and menus that write the framebuffer directly WILL present
            //       through it, and that whole present lands in `sch`, not
            //       `rnd`. THE TELL: rndn ~= 0 while fat is large. If you see
            //       that, the frame is being presented from the scheduler and
            //       `sch` is not "AICA" that second.
            //   (b) TA data delivered by ch2-DMA is charged to `pvr` at the
            //       SB_C2DST store that starts it, not to `rnd`.
            //   (c) VRAM/TA traffic through 8/16-bit stores or WriteMemBlock is
            //       in `jit`. Only 32-bit stores are hooked here.
            //   (d) texture-cache work pulled in lazily during Render() is
            //       inside `rnd`; a palette_update outside it is not.
            //   (e) `sq` is a 1-in-64 extrapolation, valid only if burst cost is
            //       uncorrelated with position in the stream.
            //   (f) `jit` is a RESIDUAL, so every unhooked path and all timer
            //       overhead accumulate into it. It is an upper bound on JIT
            //       execution, not a measurement of it.
            static char split_line[448];
            static double s_p_rr = 0, s_p_ml = 0, s_p_sch = 0, s_p_fat = 0,
                          s_p_rnd = 0, s_p_pvr = 0, s_p_sq = 0;
            static uint32_t s_p_schn = 0, s_p_fatn = 0, s_p_rndn = 0,
                            s_p_pvrn = 0, s_p_sqn = 0, s_p_sqs = 0, s_p_sqta = 0;
            const double w_rr  = g_attr_retro_ms    - s_p_rr;
            const double w_ml  = g_attr_mainloop_ms - s_p_ml;
            const double w_sch = g_attr_sched_ms    - s_p_sch;
            const double w_fat = g_attr_schedfat_ms - s_p_fat;
            const double w_rnd = g_attr_render_ms   - s_p_rnd;
            const double w_pvr = g_attr_pvrreg_ms   - s_p_pvr;
            const double w_sqm = g_attr_sq_ms       - s_p_sq;
            const uint32_t w_schn = g_attr_sched_n    - s_p_schn;
            const uint32_t w_fatn = g_attr_schedfat_n - s_p_fatn;
            const uint32_t w_rndn = g_attr_render_n   - s_p_rndn;
            const uint32_t w_pvrn = g_attr_pvrreg_n   - s_p_pvrn;
            const uint32_t w_sqn  = g_attr_sq_n       - s_p_sqn;
            const uint32_t w_sqs  = g_attr_sq_smp     - s_p_sqs;
            const uint32_t w_sqta = g_attr_sq_ta_n    - s_p_sqta;
            s_p_rr = g_attr_retro_ms;      s_p_ml   = g_attr_mainloop_ms;
            s_p_sch = g_attr_sched_ms;     s_p_fat  = g_attr_schedfat_ms;
            s_p_rnd = g_attr_render_ms;    s_p_pvr  = g_attr_pvrreg_ms;
            s_p_sq  = g_attr_sq_ms;
            s_p_schn = g_attr_sched_n;     s_p_fatn = g_attr_schedfat_n;
            s_p_rndn = g_attr_render_n;    s_p_pvrn = g_attr_pvrreg_n;
            s_p_sqn  = g_attr_sq_n;        s_p_sqs  = g_attr_sq_smp;
            s_p_sqta = g_attr_sq_ta_n;
            // Extrapolate the sampled store-queue bucket. If the sample count
            // is 0 the estimate is 0 and is reported as such -- never silently
            // folded into the residual without saying so.
            const double w_sq  = w_sqs ? w_sqm * ((double)w_sqn / (double)w_sqs) : 0.0;
            const double w_jit = w_ml - w_sch - w_rnd - w_pvr - w_sq;
            const double pc_of = w_ml > 0.0 ? 100.0 / w_ml : 0.0;
            snprintf(split_line, sizeof(split_line),
                     "[split] rr=%.1f ml=%.1f (%.1f%% of rr) | "
                     "jit=%.1f (%.1f%%) sch=%.1f (%.1f%%, n=%u fat=%.1f/%u) "
                     "rnd=%.1f (%.1f%%, n=%u) pvr=%.1f (%.1f%%, n=%u) "
                     "sq~%.1f (%.1f%%, n=%u ta=%u smp=%u) | render_total=%.1f%%",
                     w_rr, w_ml, w_rr > 0.0 ? w_ml * 100.0 / w_rr : 0.0,
                     w_jit, w_jit * pc_of,
                     w_sch, w_sch * pc_of, w_schn, w_fat, w_fatn,
                     w_rnd, w_rnd * pc_of, w_rndn,
                     w_pvr, w_pvr * pc_of, w_pvrn,
                     w_sq,  w_sq  * pc_of, w_sqn, w_sqta, w_sqs,
                     (w_rnd + w_pvr + w_sq) * pc_of);
            MAIN_THREAD_EM_ASM({
                postMessage({cmd: 'fps', fps: $0, hw: $1, calls: $2,
                             kcyc: $3, pc: $4, istnrm: $5, istext: $6,
                             awr: $7, adrop: $8,
                             vbl: $9, vbi: $10, fcyc: $11,
                             split: UTF8ToString($13)});
                postMessage({cmd: 'print', txt: UTF8ToString($12)});
                postMessage({cmd: 'print', txt: UTF8ToString($13)});
            }, (int)(fps_presents / dt_s + 0.5), (int)(fps_hw / dt_s + 0.5),
               (int)(fps_calls / dt_s + 0.5),
               (int)(kcyc_delta / dt_s + 0.5), (int)Sh4cntx.pc,
               (int)SB_ISTNRM, (int)SB_ISTEXT,
               awr, adrop,
               (int)vbl_now, (int)vbi_now, (int)fcyc,
               (int)(intptr_t)vbl_line,
               (int)(intptr_t)split_line);
            // Audio state annunciator. The fields above are the numbers; this
            // is the one line that says what they MEAN, because the most
            // likely misread of this rig is someone running the uncapped arm,
            // hearing a chopped stream, and reporting "audio is broken".
            //
            // With ?uncap=1 the guest runs ~2x wall clock, so AICA produces
            // ~88 kfr/s into a ring that a 44.1 kHz sink drains at 44.1 kfr/s.
            // The ring saturates and then drops roughly every other frame
            // forever. The reader still receives CONTIGUOUS frames at the
            // correct pitch, so it does not play FAST — it plays CHOPPED.
            // That is drop-on-full working exactly as designed, and it must
            // say so in the log instead of being silent.
            //
            // Edge-triggered: one line when the classification changes, plus a
            // 10 s re-arm while unhealthy so a long log keeps carrying it. A
            // healthy run emits exactly one [audio] line — the transition into
            // HEALTHY — and then stays quiet, so this costs nothing on a good
            // run and cannot be confused with per-second spam.
            {
                enum { A_UNWIRED = 0, A_SILENT, A_HEALTHY, A_SLOW, A_UNCAP, A_SINK, A_FILLING };
                static int    s_aud_class   = -1;
                static double s_aud_last_ms = 0.0;
                const int produced = awr + adrop;   // AICA stereo frames/s
                const int nominal  = 44101;         // 200e6 / AICA_TICK(4535) = 44101.43
                int cls;
                if (!g_audio_ring_base || !g_audio_ring_capacity) cls = A_UNWIRED;
                else if (produced == 0)                           cls = A_SILENT;
                else if (adrop > 0)                               cls = (produced >= (nominal * 3) / 2) ? A_UNCAP : A_SINK;
                else if (produced < (nominal * 98)  / 100)         cls = A_SLOW;
                else if (produced > (nominal * 102) / 100)         cls = A_FILLING;
                else                                              cls = A_HEALTHY;
                if (cls != s_aud_class ||
                    (cls != A_HEALTHY && now_ms - s_aud_last_ms >= 10000.0)) {
                    s_aud_class   = cls;
                    s_aud_last_ms = now_ms;
                    static const char* const verdict[] = {
                        "RING UNWIRED - emscripten_set_audio_ring never called; every frame discarded",
                        "SILENT - core produced no audio this second (pre-boot, or AICA idle)",
                        "HEALTHY - guest at hardware rate, sink keeping up, nothing dropped",
                        "SLOW - guest BELOW hardware rate; the sink will underrun and stutter (pitch stays correct)",
                        "SATURATED/UNCAPPED - guest ~2x real time into a 44.1kHz sink: drop-on-full is WORKING, audio is CHOPPED BY DESIGN, not broken",
                        "SATURATED/SINK-STALLED - guest at ~real time but the reader is not draining (AudioContext suspended/muted, worklet never started, or the page is reading the wrong ring address)",
                        "FILLING - guest ABOVE hardware rate, ring not saturated yet; drops are imminent",
                    };
                    char abuf[384];
                    snprintf(abuf, sizeof(abuf),
                             "[audio] wrote=%d/s dropped=%d/s produced=%d/s "
                             "(AICA nominal 44101/s = 200MHz/4535) guest=%d.%03dx :: %s",
                             awr, adrop, produced,
                             produced / nominal,
                             (int)(((long long)(produced % nominal) * 1000) / nominal),
                             verdict[cls]);
                    MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, abuf);
                }
            }
            fps_window_start = now_ms;
            fps_presents = fps_hw = fps_calls = 0;
            // Header watch (boot-title-wedge): the staging area at 0x8c010000
            // is loaded/descrambled by guest code; the JIT arm ends up with
            // garbage there ([+0x2c]=0x6da60000, on-disc truth 0x8c013380 /
            // 0x8c1e6040). Dump 32 words on every CHANGE of (w0, entry) —
            // fires on BOTH arms at the exact staging moments, independent of
            // stuck detection (the freeze blocks ticks entirely, so a change
            // seen here happened while the worker was alive). Up to 8 dumps.
            {
                static u32 s_hdr_last_w0 = 0, s_hdr_last_ent = 0;
                static int s_hdr_dumps = 0;
                u32 w0 = 0, ent = 0;
                try { w0 = ReadMem32(0x8c010000u); ent = ReadMem32(0x8c01002cu); }
                catch (SH4ThrownException&) {}
                if ((w0 != s_hdr_last_w0 || ent != s_hdr_last_ent) && s_hdr_dumps < 8) {
                    ++s_hdr_dumps;
                    s_hdr_last_w0 = w0; s_hdr_last_ent = ent;
                    char buf[512];
                    int off = snprintf(buf, sizeof(buf),
                        "[hdr-watch #%d] w0=%08x ent=%08x pc=%08x words:",
                        s_hdr_dumps, w0, ent, Sh4cntx.pc);
                    for (int i = 0; i < 32 && off < (int)sizeof(buf) - 8; i++)
                        off += snprintf(buf + off, sizeof(buf) - off, " %04x",
                                        ReadMem16(0x8c010000u + i * 2) & 0xFFFF);
                    MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
                } else if (w0 != s_hdr_last_w0 || ent != s_hdr_last_ent) {
                    s_hdr_last_w0 = w0; s_hdr_last_ent = ent;
                }
            }
            // Decrypt-stream watch (boot-title-wedge): stage-1 XOR-decrypts
            // ~2.37MB in place at 0x8c800008 with a mul-based PRNG keystream.
            // Dump 16 words on every change (both arms — this tick runs on
            // interp too) so the JIT-vs-interp keystreams diff directly.
            {
                static u32 s_dec_last = 0;
                static int s_dec_dumps = 0;
                u32 d0 = 0;
                try { d0 = ReadMem32(0x8c800008u); } catch (SH4ThrownException&) {}
                if (d0 != s_dec_last && s_dec_dumps < 6) {
                    ++s_dec_dumps;
                    s_dec_last = d0;
                    char buf[512];
                    int off = snprintf(buf, sizeof(buf), "[dec-watch #%d] words@8c800000:", s_dec_dumps);
                    for (int i = 0; i < 24 && off < (int)sizeof(buf) - 8; i++)
                        off += snprintf(buf + off, sizeof(buf) - off, " %04x",
                                        ReadMem16(0x8c800000u + i * 2) & 0xFFFF);
                    MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
                } else if (d0 != s_dec_last) {
                    s_dec_last = d0;
                }
            }
            // Stuck-PC dump (GC doctrine: a stuck PC is a real bug — diagnose,
            // never wait out). Same pc for 5 consecutive 1s ticks → one-shot
            // dump: code window, SR/IMASK, interrupt state, GPRs, plus the
            // dispatcher's pc/vector rings. RELEASE-safe.
            {
                static u32 s_last_tick_pc = 0;
                static u32 s_same_ticks = 0;
                static bool s_stuck_dumped = false;
                static u32 s_tick_count = 0;
                ++s_tick_count;
                const u32 cur_pc = Sh4cntx.pc;
                if (cur_pc == s_last_tick_pc) ++s_same_ticks; else s_same_ticks = 0;
                s_last_tick_pc = cur_pc;
                // Fire on 5 stuck ticks OR unconditionally once at tick 60 —
                // multi-pc wait loops dodge the equality detector (each 1Hz
                // sample lands on a different loop pc), and the memory probes
                // are wanted on BOTH arms regardless.
                if ((s_same_ticks >= 5 || s_tick_count == 60) && !s_stuck_dumped) {
                    s_stuck_dumped = true;
                    const u32 sr = Sh4cntx.sr.getFull();
                    MAIN_THREAD_EM_ASM({
                        postMessage({cmd:'print', txt:'[stuck-pc] pc=0x' + ($0>>>0).toString(16) +
                            ' sr=0x' + ($1>>>0).toString(16) + ' imask=' + (($1>>4)&0xF) +
                            ' pend=0x' + ($2>>>0).toString(16) +
                            ' istnrm=0x' + ($3>>>0).toString(16) + ' istext=0x' + ($4>>>0).toString(16) +
                            ' iml2=0x' + ($5>>>0).toString(16) + ' iml4=0x' + ($6>>>0).toString(16) +
                            ' iml6=0x' + ($7>>>0).toString(16) + ' pr=0x' + ($8>>>0).toString(16)});
                    }, (int)cur_pc, (int)sr, (int)Sh4cntx.interrupt_pend,
                       (int)SB_ISTNRM, (int)SB_ISTEXT,
                       (int)SB_IML2NRM, (int)SB_IML4NRM, (int)SB_IML6NRM,
                       (int)Sh4cntx.pr);
                    {
                        char buf[512];
                        int off = snprintf(buf, sizeof(buf), "[stuck-code] base=0x%08x words:", cur_pc - 32);
                        for (int i = 0; i < 32 && off < (int)sizeof(buf) - 8; i++)
                            off += snprintf(buf + off, sizeof(buf) - off, " %04x",
                                            ReadMem16(cur_pc - 32 + i * 2) & 0xFFFF);
                        MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
                        off = snprintf(buf, sizeof(buf), "[stuck-regs]");
                        for (int i = 0; i < 16 && off < (int)sizeof(buf) - 16; i++)
                            off += snprintf(buf + off, sizeof(buf) - off, " r%d=%08x", i, Sh4cntx.r[i]);
                        MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
                        // Frontier probes (boot-title-wedge): the staging
                        // handoff pointers + target region + caller frame —
                        // dumped on BOTH arms so interp-vs-JIT memory diffs
                        // are read straight off the two logs.
                        struct { const char* tag; u32 va; int n; } probes[] = {
                            { "hdr@8c010000",  0x8c010000u, 8 },
                            { "ent@8c01002c",  0x8c01002cu, 2 },
                            { "tgt@8ca60000",  0x8ca60000u, 16 },
                            { "stk@r15",       Sh4cntx.r[15], 8 },
                            { "cal@pr-16",     Sh4cntx.pr - 16, 12 },
                        };
                        for (auto& p : probes) {
                            off = snprintf(buf, sizeof(buf), "[stuck-mem %s]", p.tag);
                            for (int i = 0; i < p.n && off < (int)sizeof(buf) - 8; i++)
                                off += snprintf(buf + off, sizeof(buf) - off, " %04x",
                                                ReadMem16(p.va + i * 2) & 0xFFFF);
                            MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
                        }
                    }
                    rec_wasm_flush_rings();
                }
            }
        }
    }
    if (is_hw_frame) {
        static unsigned long hw_frame_count = 0;
        ++hw_frame_count;
        // Present the frame flycast just rendered into the OffscreenCanvas
        // backbuffer. We run on the GL-owning thread with explicitSwapControl,
        // so commit_frame is the swap. Without it the backbuffer is never
        // composited to the visible canvas (black screen).
        EMSCRIPTEN_RESULT swap = emscripten_webgl_commit_frame();
        if (hw_frame_count < 5 || hw_frame_count % 600 == 0) {
            MAIN_THREAD_EM_ASM({
                postMessage({cmd: 'print', txt: '[flycast-worker] video_cb #' + $0 + ' HW_FRAME_VALID #' + $1 + ' commit_frame=' + $2 + ' w=' + $3 + ' h=' + $4});
            }, (int)frame_count, (int)hw_frame_count, (int)swap, w, h);
        }
        return;
    }
    // Log only the first few + the first real frame + every 1000th call.
    // The dupe-frame (data=NULL) stream is the libretro "is_dupe" sentinel
    // — at our boot speed it fires every iter for many seconds; the noise
    // crowded the console out without conveying new info.
    if (frame_count < 3 || (is_real_frame && real_frame_count < 5) ||
        frame_count % 1000 == 0) {
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt: '[flycast-worker] video_cb #' + $0 + ' data=' + $1 + ' w=' + $2 + ' h=' + $3 + ' pitch=' + $4 + ' real_frames=' + $5});
        }, (int)frame_count, (uintptr_t)data, w, h, (uint32_t)pitch, (int)real_frame_count);
    }
    if (!data || !w || !h) return;

    // Path A: SAB-backed framebuffer set by JS. Direct memcpy, no transfer
    // required — JS reads via the SAB view on the next animation frame.
    if (g_video_target && g_video_target_w == (int)w && g_video_target_h == (int)h) {
        const size_t row_bytes = (size_t)w * 4u;  // XRGB8888
        const uint8_t* src = (const uint8_t*)data;
        uint8_t* dst = g_video_target;
        for (unsigned y = 0; y < h; y++) {
            std::memcpy(dst + y * row_bytes, src + y * pitch, row_bytes);
        }
        return;
    }

    // Path B: Transferable postMessage fallback. Mirrors the dolphin-bridge
    // pattern. Page receives an opaque Uint8Array of (pitch * h) bytes.
    MAIN_THREAD_EM_ASM({
        var bytes = $2 * $3;
        var src = $0;
        var view = HEAPU8.subarray(src, src + bytes);
        var copy = new Uint8Array(view);
        postMessage({cmd: 'render', x: 0, y: 0, w: $1, h: $2 / $3, pixels: copy, pitch: $3}, [copy.buffer]);
    }, data, w, pitch * h, pitch);
    (void)h;
}

static size_t audio_sample_batch_cb(const int16_t* data, size_t frames) {
    if (!data || !frames) return frames;

    // SAB ring path.
    if (g_audio_ring_base && g_audio_ring_capacity) {
        // NOT volatile: `volatile` is a compiler-reordering barrier only and
        // orders NOTHING across agents. The reader is an AudioWorklet using
        // Atomics.load/Atomics.store (seq_cst), so this side must use real
        // atomics to pair with it. Ring SHAPE is unchanged — same u32 head at
        // +0, u32 tail at +4, int16 stereo payload at +8.
        uint32_t* head_p = (uint32_t*)(g_audio_ring_base + 0);
        uint32_t* tail_p = (uint32_t*)(g_audio_ring_base + 4);
        int16_t* ring_samples = (int16_t*)(g_audio_ring_base + 8);
        const uint32_t cap = g_audio_ring_capacity;  // stereo frames
        const uint32_t mask = cap - 1u;              // power-of-two
        // head is written only by us, so loading our own last value relaxed is
        // enough. tail is written by the worklet from another agent, so it
        // needs an ACQUIRE load.
        uint32_t head = __atomic_load_n(head_p, __ATOMIC_RELAXED);
        uint32_t tail = __atomic_load_n(tail_p, __ATOMIC_ACQUIRE);
        uint32_t written = 0;
        bool refreshed_tail = false;
        // Drop on overflow rather than block — the SH4 thread cannot stall
        // here. The page-side audio sink is responsible for keeping up.
        for (size_t i = 0; i < frames; i++) {
            uint32_t free_frames = cap - (head - tail);
            if (free_frames == 0 && !refreshed_tail) {
                // Our tail snapshot may simply be stale — the reader drains a
                // 128-frame quantum asynchronously. Re-read it ONCE before
                // conceding, so g_audio_frames_dropped counts real overruns
                // rather than snapshot lag. tail only ever increases, so a
                // re-read can only free space; the single retry keeps the
                // worst case bounded at one extra atomic load per batch.
                refreshed_tail = true;
                tail = __atomic_load_n(tail_p, __ATOMIC_ACQUIRE);
                free_frames = cap - (head - tail);
            }
            if (free_frames == 0) {
                // Real overrun. Everything from here to the end of the batch
                // is discarded, and we still return `frames` to the core — so
                // without this counter the loss was completely invisible.
                g_audio_frames_dropped += (uint64_t)(frames - i);
                break;
            }
            const uint32_t slot = (head & mask) * 2u;
            ring_samples[slot + 0] = data[i * 2 + 0];
            ring_samples[slot + 1] = data[i * 2 + 1];
            head++;
            written++;
        }
        if (written) {
            g_audio_frames_written += written;
            // RELEASE store of head — the publish edge of the SPSC ring. It
            // orders the int16 payload writes above BEFORE the head advance
            // that the worklet observes with Atomics.load(head). The previous
            // plain `volatile` store gave no such guarantee: a reader that saw
            // the advanced head before the payload landed would emit one
            // quantum of garbage. x86-TSO hides this; ARM (Apple Silicon,
            // phones) is exactly where it would show. Skipped when nothing was
            // written so the saturated/uncapped case pays nothing.
            __atomic_store_n(head_p, head, __ATOMIC_RELEASE);
        }
        return frames;
    }

    // Fallback: no ring is wired, so every frame is discarded (there is no
    // postMessage path — the message-per-batch overhead at 44.1 kHz is
    // unworkable). Count the loss: this is what makes "audio was never
    // connected" (wrote=0 dropped=44101/s) read differently in the log from
    // "the core produced nothing" (wrote=0 dropped=0). Caller still gets the
    // "consumed" count so Flycast doesn't back up its mixer.
    g_audio_frames_dropped += (uint64_t)frames;
    return frames;
}

static void audio_sample_cb(int16_t l, int16_t r) {
    int16_t buf[2] = {l, r};
    audio_sample_batch_cb(buf, 1);
}

static void input_poll_cb(void) {
    // No-op. Pad state is updated asynchronously by JS into g_maple_pad_state;
    // input_state_cb reads it directly each frame.
}

static int16_t input_state_cb(unsigned port, unsigned device, unsigned index,
                              unsigned id) {
    // Layout (per-port, 64 bytes per port, 4 ports = 256 bytes; the page's
    // packPad() in dreamcast.html is the source of truth):
    //   bytes  0..7 :  digital button bitmap (64 bits, indexed by RETRO id)
    //   bytes  8..9 :  s16 LE left-stick X   (-32767..32767, + = right)
    //   bytes 10..11:  s16 LE left-stick Y   (+ = down, libretro convention)
    //   bytes 12..13:  s16 LE right-stick X
    //   bytes 14..15:  s16 LE right-stick Y
    //   bytes 16..17:  s16 LE L2 analog trigger (0..32767)
    //   bytes 18..19:  s16 LE R2 analog trigger (0..32767)
    // The DC stick is read via get_analog_stick (libretro.cpp:2965) and the
    // DC triggers via get_analog_trigger's INDEX_ANALOG_BUTTON query with a
    // digital L2/R2 bit fallback. All-digital input left PSO unable to WALK
    // (gameplay movement is the analog stick) — 2026-08-27.
    if (port >= 4) return 0;
    const unsigned base = port * 64u;
    if (device == RETRO_DEVICE_ANALOG) {
        auto rd16 = [&](unsigned off) -> int16_t {
            return (int16_t)(uint16_t)(g_maple_pad_state[base + off]
                                       | (g_maple_pad_state[base + off + 1] << 8));
        };
        if (index == RETRO_DEVICE_INDEX_ANALOG_LEFT)
            return id == RETRO_DEVICE_ID_ANALOG_X ? rd16(8)
                 : id == RETRO_DEVICE_ID_ANALOG_Y ? rd16(10) : 0;
        if (index == RETRO_DEVICE_INDEX_ANALOG_RIGHT)
            return id == RETRO_DEVICE_ID_ANALOG_X ? rd16(12)
                 : id == RETRO_DEVICE_ID_ANALOG_Y ? rd16(14) : 0;
        if (index == RETRO_DEVICE_INDEX_ANALOG_BUTTON) {
            if (id == RETRO_DEVICE_ID_JOYPAD_L2) return rd16(16);
            if (id == RETRO_DEVICE_ID_JOYPAD_R2) return rd16(18);
            return 0;
        }
        return 0;
    }
    if (id >= 64) return 0;
    const unsigned byte = base + (id / 8u);
    if (byte >= sizeof(g_maple_pad_state)) return 0;
    return (g_maple_pad_state[byte] >> (id % 8u)) & 1;
}

// ---------------------------------------------------------------------------
// Public C exports
// ---------------------------------------------------------------------------

extern "C" {

// Force-keep emcc pthread runtime symbols. These are defined in
// emsdk/upstream/emscripten/system/lib/pthread/emscripten_yield.c but get
// dropped by LTO before --export-if-defined / -Wl,-u resolution. Taking
// their address from a KEEPALIVE function with observable side effects
// (stored to a volatile sink) prevents DCE.
extern void _emscripten_thread_crashed(void);
extern void _emscripten_thread_free_data(void);
// Guest-cycle clock for the worker pump's REAL-TIME GOVERNOR. The free-run
// pump's 60-iteration/s cap limits RENDERED frames, not guest time — one
// retro_run advances until a frame RENDERS, so 30fps content passes 2 guest
// VBlanks per iteration and the game ran at 2x wall speed once throughput
// exceeded native (field report 2026-08-27). The pump paces wall time
// against this counter at SH4_MAIN_CLOCK (200MHz) = exactly 1x hardware
// speed, content-agnostic. Returned as double (2^53 covers centuries).
EMSCRIPTEN_KEEPALIVE double flycast_guest_cycles(void) {
    return (double)sh4_sched_now64();
}

EMSCRIPTEN_KEEPALIVE void* flycast_keep_pthread_runtime(void) {
    static volatile void* sink[2];
    sink[0] = (void*)&_emscripten_thread_crashed;
    sink[1] = (void*)&_emscripten_thread_free_data;
    return (void*)sink;
}

// Stashed GL context handle, created on the shim/main-runtime thread.
static EMSCRIPTEN_WEBGL_CONTEXT_HANDLE g_gl_ctx = 0;

// Called from the JS shim on the main-runtime thread before retro_init.
// Creates the WebGL2 context on the OffscreenCanvas that lives on this
// thread, makes it current, and returns the context handle.
EMSCRIPTEN_KEEPALIVE
int emscripten_create_gl_context(void) {
    if (g_gl_ctx > 0) {
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt: '[flycast-worker] gl ctx already created, handle=' + $0});
        }, (int)g_gl_ctx);
        return (int)g_gl_ctx;
    }
    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes(&attrs);
    attrs.majorVersion              = 2;
    attrs.minorVersion              = 0;
    attrs.alpha                     = false;
    attrs.depth                     = true;
    attrs.stencil                   = true;
    attrs.antialias                 = false;
    attrs.preserveDrawingBuffer     = false;
    attrs.failIfMajorPerformanceCaveat = false;
    attrs.enableExtensionsByDefault = true;
    // explicitSwapControl=true: the worker drives the SH4 loop from a
    // postMessage handler, NOT emscripten's RAF main loop, so the implicit
    // swap (which is RAF-driven) never fires → frames rendered to the
    // OffscreenCanvas backbuffer were never presented (black canvas). With
    // explicit control we present via emscripten_webgl_commit_frame() when a
    // HW frame is ready (video_cb RETRO_HW_FRAME_BUFFER_VALID).
    attrs.explicitSwapControl       = true;
    attrs.renderViaOffscreenBackBuffer = false;
    attrs.proxyContextToMainThread  = EMSCRIPTEN_WEBGL_CONTEXT_PROXY_DISALLOW;

    g_gl_ctx = emscripten_webgl_create_context("#canvas", &attrs);
    if (g_gl_ctx <= 0) {
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt: '[flycast-worker] FATAL: emscripten_webgl_create_context failed (handle=' + $0 + ')'});
        }, (int)g_gl_ctx);
        return 0;
    }
    EMSCRIPTEN_RESULT mc = emscripten_webgl_make_context_current(g_gl_ctx);
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[flycast-worker] WebGL2 ctx created on main-runtime thread, handle=' + $0 + ', make_current=' + $1});
    }, (int)g_gl_ctx, (int)mc);
    return (int)g_gl_ctx;
}

EMSCRIPTEN_KEEPALIVE
void emscripten_worker_init(void) {
    // Runs on the main-runtime thread (= the shim worker, where the GL
    // context lives). Wires libretro callbacks then runs retro_init. Must
    // be called AFTER emscripten_create_gl_context so SET_HW_RENDER can
    // resolve get_proc_address against the current context.
    //
    // Flycast's findFlash() / get_readonly_data_path() look up the BIOS in
    // user_data_dir and system_data_dirs (core/stdclass.cpp:103-114). The
    // libretro layer only sets these on __APPLE__ (libretro.cpp:358-362),
    // so on our emcc target both are empty — Flycast's `nvmem::loadFiles()`
    // returns false → loadHle() (Reios) is invoked → Reios doesn't populate
    // exception vectors at VBR+0x100 → first trapa/IRQ from game code hits
    // an uninit RAM vector → Fatal "SH4 exception when blocked".
    //
    // Pointing user_data_dir at /bios/ makes Flycast find our embedded
    // /bios/dc_bios.bin via its standard "%bios.bin" pattern with prefix
    // "dc_" (nvmem.cpp:290).
    // Note: set_user_data_dir affects core/oslib but the libretro shell ships
    // its OWN findFlash (shell/libretro/oslib.cpp:76) which uses the libretro
    // `game_dir_no_slash` (= GET_SYSTEM_DIRECTORY + "/dc") instead of
    // user_data_dir. So the actual BIOS lookup path is /bios/dc/dc_boot.bin
    // (or dc_bios.bin). The link script embeds the files at that path.
    set_user_data_dir("/bios/");

    // Force custom-texture replacement OFF. We don't ship custom textures in
    // the embedded /bios/dc/textures/ tree, and leaving these options at the
    // libretro default + pre-creating the per-game subdir (the previous
    // workaround for an unrelated stat-throw) activates the custom-texture
    // preloader. Under emcc pthreads its loader-thread lambda never runs to
    // completion, pending_preloads stays at 1 forever, and retro_run loops
    // forever on the texPreloading early-return branch (libretro.cpp:1213),
    // calling video_cb(NULL,0,0,0) every frame and never invoking emu.render().
    config::CustomTextures.override(false);
    config::PreloadCustomTextures.override(false);
    // A/B test: force Reios HLE BIOS. Bypasses the real-BIOS GDROM init +
    // SPI dance (which currently stalls post-GET_TOC waiting on an
    // interrupt that never raises) and jumps directly to IP.BIN entry
    // at 0xac008300 via reios_locate_bootfile (reios.cpp:64-115). If
    // video frames appear under Reios but real-BIOS path doesn't, the
    // gap is GDROM completion-IRQ semantics. To revert: comment out.
    config::UseReios.override(true);
    // DEBUG: force ThreadedRendering=false to bypass std::async pthread.
    // The threaded path's std::async-spawned SH4 thread is silently never
    // running (mainloop entry never logs). Try synchronous path to verify
    // SH4 can dispatch at all.
    config::ThreadedRendering.override(false);
    //
    // [CORRECTED 2026-08-29] The paragraph that used to sit here said
    // "ThreadedRendering left at its default (true)" — flatly contradicting
    // the override on the line above it — and concluded that on the
    // single-thread path is_dupe "stays true forever and every video_cb is a
    // dupe-frame sentinel". Both halves are wrong, and the second half has
    // since been quoted as the premise for how video_cb relates to native's
    // render count. What the source actually does, with
    // ThreadedRendering == false:
    //
    //   libretro.cpp:1248   is_dupe = true            (start of retro_run)
    //   libretro.cpp:1250   if (config::ThreadedRendering)   -> NOT taken,
    //                       so :1254 `is_dupe = !emu.render()` never runs
    //   libretro.cpp:1259   emu.render()              (return value discarded)
    //   Renderer_if.cpp:249  present() calls retro_rend_present() only when
    //                       renderer->Present() returned true
    //   libretro.cpp:2622-2625  retro_rend_present() { if
    //                       (!config::ThreadedRendering) is_dupe = false; }
    //   libretro.cpp:1283   video_cb(is_dupe ? 0 : RETRO_HW_FRAME_BUFFER_VALID,
    //                       ...)  — ONE unconditional call per retro_run
    //
    // So is_dupe is cleared by the RENDERER's present, not by emu.render()'s
    // return, and it is false on essentially every retro_run once frames are
    // flowing. Measured on this build: 2855 video_cb calls, 2855 presents,
    // 0 dupes over a 95 s steady-state window (probe log
    // /tmp/probe-dcx-vbl3.log). All 10 dupes in that run landed in the first
    // ~1.1 s, before the first heartbeat.
    //
    // Related but NOT identical: native Flycast's "R:" figure is
    // (FrameCount - Last_FC)/ts, and FrameCount++ lives in DequeueRender()
    // (ta_ctx.cpp:87) — renders dequeued, not presents completed. The two are
    // 1:1 on the non-threaded path but they are different counters; do not
    // treat "video_cb presents" and native "R" as the same quantity by
    // definition.

    retro_set_environment(environment_cb);
    retro_set_video_refresh(video_cb);
    retro_set_audio_sample(audio_sample_cb);
    retro_set_audio_sample_batch(audio_sample_batch_cb);
    retro_set_input_poll(input_poll_cb);
    retro_set_input_state(input_state_cb);
    retro_init();
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[flycast-worker] worker_init: retro_init done'});
    });
}

static int load_disc_impl(const char* path) {
    if (g_loaded) {
        retro_unload_game();
        g_loaded = false;
    }
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[flycast-worker] load_disc: ' + UTF8ToString($0)});
    }, path);
    // A real Dreamcast always has a controller on port 0. PSO's game-phase
    // Maple-DMA-complete handler (guest 0x8c378d46) walks a callback list whose
    // result-processing node validates the poll response; with an EMPTY Maple bus
    // it bails before the unconditional ACK node (0x8c37baa2 -> writes 0x1000 to
    // SB_ISTNRM), so bit12 (Maple, IML4->IRL_11) latches and re-vectors forever
    // (INTEVT 0x360 storm, ~126K/s), starving the lower-priority VBlank (IRL_9)
    // the frame-sync loop at 0x8c411054 waits on. Our headless bridge has no
    // libretro frontend to plug a device, so config::MapleMainDevices stays
    // MDT_None for every port. Plug a standard controller before device creation
    // (mcfg_CreateDevices runs inside retro_load_game). Native oracle runs the
    // same way (controller polling, SB_MDSTAR double-buffered) and never storms.
    retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);

    // NOTE: the VMU (memory card) is attached from CORE code — see
    // createDreamcastDevices() in core/hw/maple/maple_cfg.cpp (__EMSCRIPTEN__).
    // It must NOT be forced here: the bridge TU is compiled with -D__LIBRETRO__
    // (not -DLIBRETRO), so cfg/option.h gives it a DIFFERENT config::Option memory
    // layout than the core (option_lr.h vs option.h — the non-libretro Option has
    // an extra std::string `section` member). Calling Option::override() across
    // that ODR mismatch writes members at the wrong offsets and corrupts the
    // options array, which later traps as a "null function" when Settings::load()
    // makes a virtual call through the clobbered vtable pointer.

    retro_game_info info{};
    info.path = path;
    info.data = nullptr;
    info.size = 0;
    info.meta = nullptr;
    bool ok = false;
    try {
        ok = retro_load_game(&info);
    } catch (const std::exception& e) {
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt: '[flycast-worker] load_disc: std::exception during retro_load_game: ' + UTF8ToString($0)});
        }, e.what());
        return 0;
    } catch (const char* msg) {
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt: '[flycast-worker] load_disc: C-string exception during retro_load_game: ' + UTF8ToString($0)});
        }, msg);
        return 0;
    } catch (...) {
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt: '[flycast-worker] load_disc: unknown exception during retro_load_game'});
        });
        return 0;
    }
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[flycast-worker] load_disc: retro_load_game returned ' + ($0 ? 'true' : 'false')});
    }, ok ? 1 : 0);
    if (!ok) return 0;
    g_loaded = true;

    // Confirm the VMU landed on the Maple bus (expansion slot A1 = bus0/port0).
    {
        int vmuDev = (MapleDevices[0][0] != nullptr) ? 1 : 0;
        int vmuType = (MapleDevices[0][0] != nullptr)
                ? (int)MapleDevices[0][0]->get_device_type() : -1;
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt:
                '[maple] vmuDev=' + $0 + ' type=' + $1 + ' (MDT_SegaVMU=1)'});
        }, vmuDev, vmuType);
    }

#ifdef FLYCAST_BRIDGE_DIAG
    // Dump 1 KiB of guest RAM at the addresses where we've observed wedges,
    // so we can statically disassemble what was loaded there post-boot.
    // One-shot, runs after retro_load_game succeeds.
    {
        static bool s_dumped = false;
        if (!s_dumped) {
            s_dumped = true;
            const u8* ram = (const u8*)GetMemPtr(0x0c000000, 1);
            // Snapshot windows: 0x8c00b000-0x8c00cFFF (4 KiB).
            // Print as hex-only lines, 64 bytes per line, prefixed with the guest
            // address. The probe-side log capture treats unique [ram-dump] lines
            // as data — do not split.
            for (u32 base = 0x0000b000; base < 0x0000d000; base += 64) {
                char buf[256];
                int o = snprintf(buf, sizeof(buf), "[ram-dump] 0x8c00%04x:", base & 0xFFFF);
                for (int i = 0; i < 64 && o + 3 < (int)sizeof(buf); i++)
                    o += snprintf(buf + o, sizeof(buf) - o, " %02x", ram[base + i]);
                MAIN_THREAD_EM_ASM({
                    postMessage({cmd:'print', txt: UTF8ToString($0)});
                }, buf);
            }
            // Also snapshot the RAM-flag area observed in the previous wedge:
            // 0x8c00d300-0x8c00d3FF, in case the flag at 0x8c00d338 has a pattern.
            for (u32 base = 0x0000d300; base < 0x0000d400; base += 64) {
                char buf[256];
                int o = snprintf(buf, sizeof(buf), "[ram-dump] 0x8c00%04x:", base & 0xFFFF);
                for (int i = 0; i < 64 && o + 3 < (int)sizeof(buf); i++)
                    o += snprintf(buf + o, sizeof(buf) - o, " %02x", ram[base + i]);
                MAIN_THREAD_EM_ASM({
                    postMessage({cmd:'print', txt: UTF8ToString($0)});
                }, buf);
            }
        }
    }
#endif // FLYCAST_BRIDGE_DIAG

    // Disc-type confirmation. DiscType enum (imgread/common.h):
    //   0=CdRom 1=CdRom_XA 2=CdRom_Extra 3=CdDA 4=GdRom 16=NoDisk 32=Open
    // PSO Ver.2 USA must classify as 4 (GdRom) for libGDR_GetToc on the
    // DoubleDensity area to return real lead-out FAD instead of 0xFF padding
    // (imgread/common.cpp:219-227). If we see CdRom_XA (1), the cue's
    // "REM HIGH-DENSITY AREA" marker wasn't picked up by the cue parser.
    {
        u32 disc_type = libGDR_GetDiscType();
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt:
                '[flycast-worker] disc_type=' + ($0 >>> 0) +
                ' (0=CdRom 1=CdRom_XA 4=GdRom 16=NoDisk)'});
        }, (int)disc_type);
    }

    // Pump retro_get_system_av_info to populate framebufferWidth/Height +
    // av_info. A real libretro frontend calls this after retro_load_game; if
    // we skip it, framebufferWidth=framebufferHeight=0 (file-static defaults),
    // emu.render() can't size the renderer, retro_run delivers is_dupe=true
    // forever and video_cb stays at data=0/w=0/h=0 every frame.
    {
        retro_system_av_info av_info{};
        retro_get_system_av_info(&av_info);
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt:
                '[flycast-worker] av_info base=' + $0 + 'x' + $1 +
                ' max=' + $2 + 'x' + $3 + ' fps=' + $4});
        }, (int)av_info.geometry.base_width, (int)av_info.geometry.base_height,
           (int)av_info.geometry.max_width, (int)av_info.geometry.max_height,
           (int)av_info.timing.fps);
    }

    // retro_load_game registered its hw_render request via env_cb(SET_HW_RENDER).
    // The libretro contract: once the frontend has a live GL context, it
    // invokes context_reset so the core can build shaders / FBOs / textures.
    // We're on the pthread that owns the WebGL2 ctx (created in main below),
    // so it's safe to call directly.
    if (g_hw_render_registered && g_hw_render.context_reset) {
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt: '[flycast-worker] invoking hw_render.context_reset'});
        });
        g_hw_render.context_reset();
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt: '[flycast-worker] hw_render.context_reset returned'});
        });
    } else {
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt: '[flycast-worker] WARNING: hw_render.context_reset not registered'});
        });
    }

#ifdef FLYCAST_BRIDGE_DIAG
    // sh4_sched.cpp's sch_list is a file-local std::vector<sched_list> with no
    // public size() accessor in sh4_sched.h (see header signature: register/
    // unregister/request/tick only). We deliberately do NOT patch flycast-src
    // to expose it (feedback_no_dolphin_patching applies equally to flycast-src
    // — observe natively, implement in bridge). The F7 walk-cost question can
    // instead be answered by counting callback registrations at the bridge:
    // every component that calls sh4_sched_register inside flycast bumps the
    // list by one. Until an accessor is added (or sh4_sched_tick is wrapped),
    // we log a one-shot SKIP so the [cost-breakdown] reader knows this row is
    // intentionally absent. Boot completes here (retro_load_game returned ok),
    // so this is the right moment to log it.
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt:
            '[cost-breakdown] sch_list.size=SKIP (file-static in sh4_sched.cpp; ' +
            'no accessor in sh4_sched.h; bridge does not patch flycast-src)'});
    });
#endif

    return 1;
}

EMSCRIPTEN_KEEPALIVE
int emscripten_load_disc(const char* path) {
    return load_disc_impl(path);
}

// Asyncify-suspension guard (boot-title-wedge H2, confirmed 2026-08-19 by
// frozen telemetry: fps/clk/pc freeze to exact-constant values while pump
// iters continue — run_iter suspended inside an asyncify frame while the
// pump kept "calling" it). The flag is set at entry and cleared at exit;
// a SUSPENDED call unwinds past the clear, leaving it set until the
// asyncify rewind completes the frame. The shim reads it via HEAPU8 at
// _flycast_run_iter_flag_ptr() — a heap read, safe while suspended —
// and skips re-entry.
static volatile uint8_t s_run_iter_inflight = 0;
EMSCRIPTEN_KEEPALIVE
uintptr_t flycast_run_iter_flag_ptr(void) { return (uintptr_t)&s_run_iter_inflight; }

// Lever-5 attribution timers (defined in rec_wasm.cpp; ctxsnap 82/83).
extern "C" { extern double g_attr_mainloop_ms, g_attr_retro_ms; }
// Frame-watchdog run_iter generation (defined in rec_wasm.cpp).
extern "C" { extern volatile uint32_t g_wd_iter_gen; }

// VMU bridge (defined in core/hw/maple/maple_devs.cpp under __EMSCRIPTEN__,
// patch 0014). The wasm VMU is in-memory only, so the page owns persistence:
// it seeds the card from a shipped default before the guest reads it and
// snapshots it back to IndexedDB whenever the generation moves. The shim
// reads/writes the buffer directly through HEAPU8 — no copy helpers needed.
extern "C" {
    extern u8 *g_vmu_flash_ptr;
    extern u32 g_vmu_flash_size;
    extern volatile u32 g_vmu_flash_gen;
}
// Console flash bridge (nvmem.cpp, patch 0015). PSO's Serial Number + Access
// Key are console-scoped, so this is what has to carry a registration.
extern "C" {
    extern u8 *g_dcflash_ptr;
    extern u32 g_dcflash_size;
    extern volatile u32 g_dcflash_gen;
}
extern "C" {
EMSCRIPTEN_KEEPALIVE uintptr_t flycast_flash_ptr()  { return (uintptr_t)g_dcflash_ptr; }
EMSCRIPTEN_KEEPALIVE uint32_t  flycast_flash_size() { return g_dcflash_size; }
EMSCRIPTEN_KEEPALIVE uint32_t  flycast_flash_gen()  { return g_dcflash_gen; }
}
extern "C" {
EMSCRIPTEN_KEEPALIVE uintptr_t flycast_vmu_ptr()  { return (uintptr_t)g_vmu_flash_ptr; }
EMSCRIPTEN_KEEPALIVE uint32_t  flycast_vmu_size() { return g_vmu_flash_size; }
EMSCRIPTEN_KEEPALIVE uint32_t  flycast_vmu_gen()  { return g_vmu_flash_gen; }
}

EMSCRIPTEN_KEEPALIVE
void emscripten_run_iter(void) {
    if (!g_loaded) return;
    // Re-arm the SH4 run flag each frame. The bridge mainloop yields a stuck
    // frame back to the pump by clearing ctx->CpuRunning (the 2s frame
    // watchdog at rec_wasm.cpp:1512, and the DEBUG stuck-pc dump), but nothing
    // restores it — Sh4Interpreter::Start() sets it true only once at boot.
    // Without this re-arm the first >2s stall (e.g. the post-decrypt GDROM
    // completion poll) permanently kills the CPU: every later run_iter
    // re-enters mainloop with CpuRunning=0 and does nothing (the observed
    // permanent-black screen + mainloop-entry log flood). Re-arming here turns
    // the watchdog into a per-frame yield so the next iter revives the guest
    // and it keeps advancing toward the awaited interrupt.
    Sh4cntx.CpuRunning = 1;
    // Frame-watchdog window reset (see g_wd_iter_gen in rec_wasm.cpp): a new
    // run_iter means the previous frame completed — the 2s stuck-frame clock
    // must start over.
    ++g_wd_iter_gen;
    static unsigned long s_call_count = 0;
    ++s_call_count;
    if (s_call_count < 5 || s_call_count % 1000 == 0) {
        EM_ASM({
            postMessage({cmd: 'print', txt: '[flycast-worker] run_iter enter #' + $0});
        }, (int)s_call_count);
    }
    s_run_iter_inflight = 1;
    // Lever-5 attribution (strip after verdict): split each frame's wall into
    // the SH4 mainloop share (accumulated in rec_wasm) vs everything else in
    // retro_run (renderer, TA, devices) — read via ctxsnap 82/83 (ms totals).
    {
        const double t0 = emscripten_get_now();
        retro_run();
        g_attr_retro_ms += emscripten_get_now() - t0;
    }
    s_run_iter_inflight = 0;
    if (s_call_count < 5 || s_call_count % 1000 == 0) {
        EM_ASM({
            postMessage({cmd: 'print', txt: '[flycast-worker] run_iter exit  #' + $0});
        }, (int)s_call_count);
    }
}

EMSCRIPTEN_KEEPALIVE
void emscripten_reset(void) {
    if (g_loaded) retro_reset();
}

EMSCRIPTEN_KEEPALIVE
uint8_t* emscripten_get_maple_ptr(void) {
    return g_maple_pad_state;
}

EMSCRIPTEN_KEEPALIVE
int emscripten_save_state(uint8_t** out_buf, size_t* out_size) {
    if (!out_buf || !out_size) return 0;
    *out_buf = nullptr;
    *out_size = 0;
    if (!g_loaded) return 0;
    size_t need = retro_serialize_size();
    if (!need) return 0;
    uint8_t* buf = (uint8_t*)std::malloc(need);
    if (!buf) return 0;
    if (!retro_serialize(buf, need)) {
        std::free(buf);
        return 0;
    }
    *out_buf = buf;
    *out_size = need;
    return 1;
}

// Lever-5F v2: hand JS the shared-table indexes of the shard-import targets.
// Taking the functions' addresses forces LLVM to give them wasmTable slots;
// funcs.js then binds `wasmTable.get(idx)` — RAW wasm function objects, so
// shard import calls go wasm->wasm with no JS hop. Immune to export-name
// minification (RELEASE minifies wasmExports keys, which silently defeated
// the v1 raw-export binding — the [5f-bind] audit caught it).
extern "C" {
    int sh4_jit_lookup_idx(uint32_t vaddr);
    uint32_t sh4_mem_read8(uint32_t addr);
    uint32_t sh4_mem_read16(uint32_t addr);
    uint32_t sh4_mem_read32(uint32_t addr);
    void sh4_mem_write8(uint32_t addr, uint32_t val);
    void sh4_mem_write16(uint32_t addr, uint32_t val);
    void sh4_mem_write32(uint32_t addr, uint32_t val);
    void sh4_interp_ifb(uint32_t opcode, uint32_t pc);
    void sh4_interp_shil_fb(uint32_t block_vaddr, uint32_t op_idx);
}
extern "C" EMSCRIPTEN_KEEPALIVE void sh4_import_fnptrs(uint32_t* out) {
    out[0] = (uint32_t)(uintptr_t)&sh4_mem_read8;
    out[1] = (uint32_t)(uintptr_t)&sh4_mem_read16;
    out[2] = (uint32_t)(uintptr_t)&sh4_mem_read32;
    out[3] = (uint32_t)(uintptr_t)&sh4_mem_write8;
    out[4] = (uint32_t)(uintptr_t)&sh4_mem_write16;
    out[5] = (uint32_t)(uintptr_t)&sh4_mem_write32;
    out[6] = (uint32_t)(uintptr_t)&sh4_interp_ifb;
    out[7] = (uint32_t)(uintptr_t)&sh4_interp_shil_fb;
    out[8] = (uint32_t)(uintptr_t)&sh4_jit_lookup_idx;
}

// Lever-4: full IC invalidate, defined in rec_wasm.cpp (no-op while disarmed).
extern "C" void flycast_ic_invalidate(void);
extern "C" void flycast_set_ic(int on);
// Lever-5B sizing instrument (defined in rec_wasm.cpp; read via ctxsnap 81).
extern "C" { extern volatile uint32_t g_syncsr_count; }
// Lever-10 sizing instrument (defined in rec_wasm.cpp; read via ctxsnap 89).
extern "C" { extern volatile uint32_t g_syncfpscr_count; }
// Lever-5D sizing (defined in rec_wasm.cpp; ctxsnap 84-87): IFB op mix.
extern "C" { extern volatile uint32_t g_ifb_ftrv, g_ifb_fipr, g_ifb_fsca, g_ifb_other; }
extern "C" {
    extern volatile uint32_t g_parity_hashing;
    extern uint32_t g_parity_hash, g_parity_passes;
    void flycast_shard_seal_now(void);
}

// Lever-4 task 6 — the IC parity gate (in-process savestate replay).
// Save state once, then run `frames` guest frames FOUR times from that state:
//   arm 0: warmup (discarded — fully compiles the window's blocks so every
//          later arm sees the identical block table; a first-run compile can
//          interp-route a queued block for one iter -> different slices),
//   arm 1: disarmed A, arm 2: disarmed B (A==B proves the window replays
//          deterministically — without it a mismatch could be noise),
//   arm 3: armed C (B==C is the gate: the IC must be trajectory-invisible).
// Rolling FNV of the architectural state at every crediting-loop pass
// (rec_wasm.cpp). STEPWISE — one retro_run per emscripten_parity_tick call,
// driven from JS at the same asyncify boundary as the normal pump: a single
// C invocation looping retro_run dies on the first asyncify unwind ('unwind'
// exception + table-index corruption, first attempt 2026-08-24). The JS
// driver pauses the freerun pump and respects the run_iter inflight flag.
static uint8_t* s_parity_buf = nullptr;
static size_t   s_parity_size = 0;
static uint32_t s_parity_frames = 0, s_parity_left = 0;
static int      s_parity_arm = -1;
static uint32_t s_parity_hashes[4], s_parity_passcnt[4];

static void parity_enter_arm(int a) {
    static const int arm_ic[4] = {0, 0, 0, 1};
    MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[parity] arm ' + ($0|0) + ': restoring...'}); }, a);
    const bool ok = retro_unserialize(s_parity_buf, s_parity_size);
    MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[parity] arm ' + ($0|0) + ': restore ' + (($1|0)?'ok':'FAILED') + ', ic=' + ($2|0)}); }, a, (int)ok, arm_ic[a]);
    flycast_ic_invalidate();
    flycast_set_ic(arm_ic[a]);
    // Lever-6 cert: hash windows must run with zero pending shard blocks —
    // a pending block span-interprets, whose slicing is not guaranteed
    // pass-identical to its sealed form. No-op when shard is off/empty.
    flycast_shard_seal_now();
    g_parity_hash = 2166136261u; g_parity_passes = 0; g_parity_hashing = 1;
    s_parity_arm = a; s_parity_left = s_parity_frames;
}

// Both entry points hold the run_iter inflight flag over their WHOLE bodies:
// retro_unserialize and retro_run can each suspend (asyncify), and the JS
// driver keys off the flag to know a rewind is still completing — entering
// any wasm export mid-unwind is the 'unwind'-throw corruption.
// Lever-6 cert: a copy of the last state fed through emscripten_load_state.
// parity_begin(frames, 1) replays THESE bytes instead of a live capture, so
// two processes autoloading the same state.bin hash the IDENTICAL window —
// cross-process hash equality becomes meaningful (shard vs per-block gate).
// A live capture is wall-trajectory-dependent (lever-4 D2), so cross-process
// comparison of from_load=0 hashes proves nothing.
static uint8_t* s_autoload_buf = nullptr;
static size_t   s_autoload_size = 0;

EMSCRIPTEN_KEEPALIVE
int emscripten_parity_begin(uint32_t frames, int from_load) {
    if (!g_loaded || frames == 0) return 0;
    s_run_iter_inflight = 1;
    if (s_parity_buf) { free(s_parity_buf); s_parity_buf = nullptr; }
    if (from_load) {
        if (!s_autoload_buf) {
            MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[parity] from_load requested but no state was loaded'}); });
            s_run_iter_inflight = 0;
            return 0;
        }
        s_parity_buf = (uint8_t*)malloc(s_autoload_size);
        memcpy(s_parity_buf, s_autoload_buf, s_autoload_size);
        s_parity_size = s_autoload_size;
    } else if (!emscripten_save_state(&s_parity_buf, &s_parity_size)) {
        MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[parity] save_state FAILED'}); });
        s_run_iter_inflight = 0;
        return 0;
    }
    MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt:'[parity] source=' + (($1|0)?'loaded-state':'live-capture') + ' ' + ($0>>>0) + ' bytes'}); }, (int)(uint32_t)s_parity_size, from_load);
    s_parity_frames = frames;
    parity_enter_arm(0);
    s_run_iter_inflight = 0;
    return 1;
}

// Returns 1 = call again (more frames/arms), 0 = done (verdict printed).
// If a suspend happens inside, the export returns early with the inflight
// flag still set; the JS driver waits for the rewind (flag clear) before the
// next tick — the frame was already counted (decrement precedes the run).
EMSCRIPTEN_KEEPALIVE
int emscripten_parity_tick(void) {
    if (s_parity_arm < 0) return 0;
    s_run_iter_inflight = 1;
    if (s_parity_left > 0) {
        --s_parity_left;
        Sh4cntx.CpuRunning = 1;
        retro_run();
        s_run_iter_inflight = 0;
        return 1;
    }
    g_parity_hashing = 0;
    s_parity_hashes[s_parity_arm]  = g_parity_hash;
    s_parity_passcnt[s_parity_arm] = g_parity_passes;
    if (s_parity_arm < 3) { parity_enter_arm(s_parity_arm + 1); s_run_iter_inflight = 0; return 1; }
    // All arms done: restore, re-arm (cold-arm default), report.
    retro_unserialize(s_parity_buf, s_parity_size);
    flycast_ic_invalidate();
    flycast_set_ic(1);
    free(s_parity_buf); s_parity_buf = nullptr;
    s_parity_arm = -1;
    s_run_iter_inflight = 0;
    const uint32_t* h = s_parity_hashes; const uint32_t* p = s_parity_passcnt;
    const int sound  = (h[1] == h[2]) && (p[1] == p[2]);
    const int parity = (h[2] == h[3]) && (p[2] == p[3]);
    MAIN_THREAD_EM_ASM({
        postMessage({cmd:'print', txt:'[parity] frames=' + ($0>>>0)
            + ' disA=' + ($1>>>0).toString(16) + '/' + ($2>>>0)
            + ' disB=' + ($3>>>0).toString(16) + '/' + ($4>>>0)
            + ' armC=' + ($5>>>0).toString(16) + '/' + ($6>>>0)
            + ' sound=' + ($7|0) + ' verdict=' + (($7|0) ? (($8|0) ? 'PASS' : 'DIVERGED') : 'UNSOUND-WINDOW')});
    }, (int)s_parity_frames, (int)h[1], (int)p[1], (int)h[2], (int)p[2],
       (int)h[3], (int)p[3], sound, parity);
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int emscripten_load_state(const uint8_t* buf, size_t size) {
    if (!g_loaded || !buf || !size) return 0;
    // Lever-6 cert: keep a copy for parity_begin(from_load=1) — see
    // s_autoload_buf above.
    if (s_autoload_buf) { free(s_autoload_buf); s_autoload_buf = nullptr; }
    s_autoload_buf = (uint8_t*)malloc(size);
    memcpy(s_autoload_buf, buf, size);
    s_autoload_size = size;
    const int ok = retro_unserialize(buf, size) ? 1 : 0;
    // Lever-4: a state load replaces guest RAM wholesale — invalidate every
    // inline-cache entry. The stale block-table sums are handled per-lookup
    // by ram_code_sum as before.
    flycast_ic_invalidate();
    return ok;
}

EMSCRIPTEN_KEEPALIVE
void emscripten_set_video_target(uint8_t* target_buf, int width, int height) {
    g_video_target   = target_buf;
    g_video_target_w = width;
    g_video_target_h = height;
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[flycast-worker] video target set buf=' + $0 + ' w=' + $1 + ' h=' + $2});
    }, (uintptr_t)target_buf, width, height);
}

EMSCRIPTEN_KEEPALIVE
void emscripten_set_audio_ring(uint32_t ring_addr, uint32_t ring_capacity) {
    g_audio_ring_base     = ring_addr ? (uint8_t*)(uintptr_t)ring_addr : nullptr;
    g_audio_ring_capacity = ring_capacity;
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[flycast-worker] audio ring addr=' + $0 + ' capacity=' + $1 + ' frames'});
    }, ring_addr, ring_capacity);
}

// -----------------------------------------------------------------------
// rec_wasm JS-import wrappers.
//
// Each compiled SH4 block (built by bemental::sh4::build_block) imports
// 8 functions from the JS side: sh4_read{8,16,32}, sh4_write{8,16,32},
// sh4_ifb, sh4_shil_fb. The JS bodies in flycast_worker_funcs.js just
// forward to these C exports via Module.cwrap so all the real work — bus
// routing, MMU lookups, interpreter dispatch — stays in C++.
//
// Naming: prefixed `sh4_mem_` / `sh4_interp_` to keep them distinct from
// Flycast's internal ReadMem* function pointers (which are extern globals,
// not exported symbols). Single-underscore prefix appears on the JS side
// per emcc EXPORTED_FUNCTIONS convention.
// -----------------------------------------------------------------------

// Diagnostic gate + IFB counter live in rec_wasm.cpp. Forward-declare so the
// import wrappers below can update them without dragging the dynarec header in.
extern "C" {
extern volatile bool g_diag_enabled;
extern std::atomic<uint64_t> g_ifb_count;
// Cost-breakdown memory-import call counters. Bumped from sh4_mem_read*/
// sh4_mem_write* below when DEBUG_DISPATCH is on so the per-100K-dispatch
// cost-breakdown log can report reads/writes per dispatch.
extern std::atomic<uint64_t> g_cb_mem_read_calls;
extern std::atomic<uint64_t> g_cb_mem_write_calls;
// Per-area (addr>>26) bucketed memory-import counters. 64 entries covers
// the full SH4 6-bit area field (only 0..7 are populated in practice:
// 0=BIOS+MMIO, 3=RAM, 4=PVR/TA, 5=AICA, 6=mirror, 7=on-chip). Read by
// rec_wasm.cpp's [cost-breakdown] log line.
extern std::atomic<uint64_t> g_cb_mem_read_by_area[64];
extern std::atomic<uint64_t> g_cb_mem_write_by_area[64];
}

// Defined here (not in rec_wasm.cpp) because this file owns the sh4_mem_*
// wrappers that bump them. rec_wasm.cpp picks them up via the extern decls
// above. Gated on FLYCAST_BRIDGE_DIAG to align with the per-area bumps
// guarded the same way in the wrappers below.
#ifdef FLYCAST_BRIDGE_DIAG
extern "C" {
std::atomic<uint64_t> g_cb_mem_read_by_area[64]  = {};
std::atomic<uint64_t> g_cb_mem_write_by_area[64] = {};
}
#endif

// ---------------------------------------------------------------------------
// GDROM diagnostic trace. The entire gdrom_log_r/_w state machine and its
// callsites in the sh4_mem_read*/write* wrappers are compiled out when
// FLYCAST_BRIDGE_DIAG is not defined. With DIAG off, sh4_mem_read* /
// sh4_mem_write* collapse to plain wrappers around ReadMem*/WriteMem*, killing
// the runtime g_diag_enabled branch on every guest memory access (per-op cost
// in the hot SH4 fallback path).
//
// flycast_worker_link.sh sets -DFLYCAST_BRIDGE_DIAG by default (probe builds
// need [gdrom] tracing) but drops the flag when FLYCAST_RELEASE=1.
// ---------------------------------------------------------------------------
#ifdef FLYCAST_BRIDGE_DIAG
// Read-side GDROM trace. Mirror of gdrom_log_w but for guest reads. Important
// because the question is whether BIOS POLLS status (we'd see W reads on
// 0x5f7084 / 0x5f709c) vs. waits for IRQ (silence on reads).
// Bridge-side GDROM state tracker. Flycast's gdromv3.cpp internal state
// (gd_state, pio_buff, packet_cmd) is private static — not accessible from
// our bridge without flycast-src patching. Instead we track transitions by
// observing MMIO writes/reads:
//   - GD_COMMAND (0x5f709c, byte) write = ATA opcode (e.g. 0xa0 SPI_PACKET,
//     0xef SET_FEATURES). The 12-byte SPI packet body follows as 6×W16 to
//     GD_DATA (0x5f7080) when the ATA opcode was 0xa0.
//   - GD_DATA reads after a SPI packet are the response payload. We count
//     them so we can tell whether the read returning 0xffff is "past end of
//     real response" vs "controller never had data".
static struct {
    uint8_t  last_ata_cmd     = 0;      // last byte written to 0x5f709c
    uint8_t  spi_packet[12]   = {0};    // 12-byte SPI packet body
    uint8_t  spi_packet_idx   = 0;      // bytes pushed since last 0xa0
    uint32_t reads_since_cmd  = 0;      // GD_DATA reads since last ATA cmd
    uint32_t reads_since_spi  = 0;      // GD_DATA reads since SPI packet completed
    bool     spi_packet_done  = false;
} g_gdrom_state;

static inline void gdrom_log_r(uint32_t addr, uint32_t val, int width) {
    if (!g_diag_enabled) return;
    const uint32_t p = addr & 0x1FFFFFFFu;
    // Cover BOTH the GDROM controller range (0x5f7000-0x5f74ff) AND the
    // HOLLY ASIC interrupt status / mask range (0x5f6900-0x5f6940).
    // SB_ISTNRM=0x5f6900, SB_ISTEXT=0x5f6904, SB_ISTERR=0x5f6908,
    // SB_IML2NRM=0x5f6910, SB_IML4NRM=0x5f6920, SB_IML6NRM=0x5f6930.
    const bool in_gdrom = (p >= 0x005f7000u && p < 0x005f7500u);
    const bool in_asic  = (p >= 0x005f6900u && p < 0x005f6940u);
    if (!in_gdrom && !in_asic) return;

    // Track GD_DATA reads (0x5f7080).
    bool is_data_read = false;
    if (p == 0x005f7080u) {
        is_data_read = true;
        g_gdrom_state.reads_since_cmd++;
        if (g_gdrom_state.spi_packet_done) g_gdrom_state.reads_since_spi++;
    }

    // Throttle [gdrom] R logging: log every 32nd 0xffff read on the data
    // port (otherwise the log floods); always log the first 8 reads after a
    // new SPI command; always log non-data reads. Include SPI context.
    static uint32_t s_throttle_counter = 0;
    bool should_log = !is_data_read
        || g_gdrom_state.reads_since_spi <= 8
        || (val != 0xffff && val != 0)
        || (++s_throttle_counter % 32 == 0);
    if (!should_log) return;

    if (is_data_read) {
        MAIN_THREAD_EM_ASM({
            var spi0 = $4 & 0xff;
            postMessage({cmd: 'print', txt:
                '[gdrom] R' + ($3|0) + ' reg=0x' + ($0 >>> 0).toString(16) +
                ' val=0x' + ($1 >>> 0).toString(16) +
                ' pc=0x' + ($2 >>> 0).toString(16) +
                ' [ata=0x' + (($5|0).toString(16)) +
                ' spi=0x' + spi0.toString(16) +
                ' rds=' + ($6|0) + ']'});
        }, (int)p, (int)val, (int)Sh4cntx.pc, width,
           (int)g_gdrom_state.spi_packet[0],
           (int)g_gdrom_state.last_ata_cmd,
           (int)g_gdrom_state.reads_since_spi);
    } else {
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt:
                '[gdrom] R' + ($3|0) + ' reg=0x' + ($0 >>> 0).toString(16) +
                ' val=0x' + ($1 >>> 0).toString(16) +
                ' pc=0x' + ($2 >>> 0).toString(16)});
        }, (int)p, (int)val, (int)Sh4cntx.pc, width);
    }
}

// IRQ raise observation: wasm-ld doesn't support `-Wl,--wrap=`, so we
// can't intercept asic_RaiseInterrupt cleanly. Instead, gdrom_log_w/r above
// snapshot Sh4cntx.interrupt_pend before/after each MMIO access — if pend
// transitions from 0 → non-zero across a write, that GDROM register access
// triggered an IRQ raise. Same observation, no symbol surgery required.

// Inline GDROM MMIO trace. SH4 GDROM regs are at physical 0x005f7000-
// 0x005f74ff (area 0 — top 3 bits=0). The wasm_emit area-3 fast-path skips
// area 0, so every guest write to these regs reaches us via the slow-path
// import. Cheap to log here; gated by g_diag_enabled.
//
// MUST be MAIN_THREAD_EM_ASM (not EM_ASM): the SH4 dispatcher with
// ThreadedRendering=true runs on a std::async-spawned pthread. Plain
// EM_ASM postMessage from a pthread goes to the pthread's own message
// channel, which the page-side worker shim treats as "unknown command".
//
// Logs interrupt_pend BEFORE and AFTER the underlying WriteMem* call
// (caller passes pend_before / does the write between calls, then we log).
// If pend changes from 0 → non-zero across the write, that GDROM register
// access triggered a synchronous asic_RaiseInterrupt. Equivalent observation
// without needing to wrap the IRQ raise function (wasm-ld doesn't support
// --wrap). pend_before captured by caller before the WriteMem call.
static inline void gdrom_log_w(uint32_t addr, uint32_t val, int width,
                               uint32_t pend_before) {
    if (!g_diag_enabled) return;
    const uint32_t p = addr & 0x1FFFFFFFu;
    const bool in_gdrom = (p >= 0x005f7000u && p < 0x005f7500u);
    const bool in_asic  = (p >= 0x005f6900u && p < 0x005f6940u);
    // PVR / TA registers (0x5F8000..0x5F9000). Only log the "important" ones
    // — anything that signals rendering activity. Logging every PVR reg
    // touch would flood (game pokes hundreds during init); the white-list
    // here covers STARTRENDER (0x5F8014), TA_LIST_INIT (0x5F8144),
    // TA_LIST_CONT (0x5F8160), TA_OL_BASE (0x5F8124), SPG_VBLANK_INT
    // (0x5F80CC, useful if game reprograms vblank lines), and FB_W_SOF
    // (0x5F8060 / 0x5F8064).
    const bool in_pvr_key = (
        p == 0x005f8014u ||  // STARTRENDER
        p == 0x005f8144u ||  // TA_LIST_INIT
        p == 0x005f8160u ||  // TA_LIST_CONT
        p == 0x005f8124u ||  // TA_OL_BASE
        p == 0x005f80ccu ||  // SPG_VBLANK_INT
        p == 0x005f8060u ||  // FB_W_SOF1
        p == 0x005f8064u);   // FB_W_SOF2
    if (!in_gdrom && !in_asic && !in_pvr_key) return;
    const uint32_t pend_after = Sh4cntx.interrupt_pend;

    // Track GDROM state machine via observed MMIO transactions.
    if (p == 0x005f709cu && width == 8) {
        // GD_COMMAND write — new ATA opcode. Reset SPI packet state.
        g_gdrom_state.last_ata_cmd     = (uint8_t)val;
        g_gdrom_state.spi_packet_idx   = 0;
        g_gdrom_state.spi_packet_done  = false;
        g_gdrom_state.reads_since_cmd  = 0;
        g_gdrom_state.reads_since_spi  = 0;
        for (int i = 0; i < 12; i++) g_gdrom_state.spi_packet[i] = 0;
    } else if (p == 0x005f7080u && width == 16 &&
               g_gdrom_state.last_ata_cmd == 0xa0 &&
               g_gdrom_state.spi_packet_idx < 12) {
        // SPI packet body bytes (6×W16 after a 0xa0 ATA cmd).
        g_gdrom_state.spi_packet[g_gdrom_state.spi_packet_idx + 0] = (uint8_t)(val & 0xff);
        g_gdrom_state.spi_packet[g_gdrom_state.spi_packet_idx + 1] = (uint8_t)((val >> 8) & 0xff);
        g_gdrom_state.spi_packet_idx += 2;
        if (g_gdrom_state.spi_packet_idx >= 12) {
            g_gdrom_state.spi_packet_done = true;
            g_gdrom_state.reads_since_spi = 0;
            // Log a one-shot SPI command summary for clarity.
            MAIN_THREAD_EM_ASM({
                var b = $0;
                var hex = '';
                for (var i = 0; i < 12; i++) {
                    hex += ('0' + ((HEAPU8[b+i])>>>0).toString(16)).slice(-2);
                    if (i < 11) hex += ' ';
                }
                postMessage({cmd: 'print', txt:
                    '[gdrom-spi] cmd=0x' + (HEAPU8[b]>>>0).toString(16) +
                    ' packet=' + hex});
            }, (uintptr_t)g_gdrom_state.spi_packet);
        }
    }

    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt:
            '[gdrom] W' + ($3|0) + ' reg=0x' + ($0 >>> 0).toString(16) +
            ' val=0x' + ($1 >>> 0).toString(16) +
            ' pc=0x' + ($2 >>> 0).toString(16) +
            ' pend=' + ($4 >>> 0).toString(16) + '->' + ($5 >>> 0).toString(16)});
    }, (int)p, (int)val, (int)Sh4cntx.pc, width,
       (int)pend_before, (int)pend_after);
}
#endif // FLYCAST_BRIDGE_DIAG


EMSCRIPTEN_KEEPALIVE
uint32_t sh4_mem_read8(uint32_t addr) {
#ifdef DEBUG_DISPATCH
    g_cb_mem_read_calls.fetch_add(1, std::memory_order_relaxed);
#endif
#ifdef FLYCAST_BRIDGE_DIAG
    g_cb_mem_read_by_area[(addr >> 26) & 63].fetch_add(1, std::memory_order_relaxed);
#endif
    uint32_t v = (uint32_t)ReadMem8(addr);
#ifdef FLYCAST_BRIDGE_DIAG
    gdrom_log_r(addr, v, 8);
#endif
    return v;
}

EMSCRIPTEN_KEEPALIVE
uint32_t sh4_mem_read16(uint32_t addr) {
#ifdef DEBUG_DISPATCH
    g_cb_mem_read_calls.fetch_add(1, std::memory_order_relaxed);
#endif
#ifdef FLYCAST_BRIDGE_DIAG
    g_cb_mem_read_by_area[(addr >> 26) & 63].fetch_add(1, std::memory_order_relaxed);
#endif
    uint32_t v = (uint32_t)ReadMem16(addr);
#ifdef FLYCAST_BRIDGE_DIAG
    gdrom_log_r(addr, v, 16);
#endif
    return v;
}

EMSCRIPTEN_KEEPALIVE
uint32_t sh4_mem_read32(uint32_t addr) {
#ifdef DEBUG_DISPATCH
    g_cb_mem_read_calls.fetch_add(1, std::memory_order_relaxed);
#endif
#ifdef FLYCAST_BRIDGE_DIAG
    g_cb_mem_read_by_area[(addr >> 26) & 63].fetch_add(1, std::memory_order_relaxed);
#endif
    uint32_t v = ReadMem32(addr);
#ifdef FLYCAST_BRIDGE_DIAG
    gdrom_log_r(addr, v, 32);
#endif
    return v;
}

static inline void hdr_write_watch(uint32_t addr, uint32_t val, int bits);

// Lever-4 / Build 2 (docs/lever-4-smc-bitmap): per-write SMC hook, defined in
// rec_wasm.cpp. Bumps g_ic_generation when a store touches a code page. These
// slowpath imports carry every guest store the emitted fastpaths don't.
extern "C" void smc_mark(uint32_t addr, uint32_t len, uint32_t tag);

EMSCRIPTEN_KEEPALIVE
void sh4_mem_write8(uint32_t addr, uint32_t val) {
#ifdef FLYCAST_BRIDGE_DIAG
    hdr_write_watch(addr, val, 8);
#endif
#ifdef DEBUG_DISPATCH
    g_cb_mem_write_calls.fetch_add(1, std::memory_order_relaxed);
#endif
#ifdef FLYCAST_BRIDGE_DIAG
    g_cb_mem_write_by_area[(addr >> 26) & 63].fetch_add(1, std::memory_order_relaxed);
    const uint32_t pend = Sh4cntx.interrupt_pend;
#endif
    WriteMem8(addr, (uint8_t)val);
    smc_mark(addr, 1, 0);
#ifdef FLYCAST_BRIDGE_DIAG
    gdrom_log_w(addr, val, 8, pend);
#endif
}

// Write-watchpoint on the staging header (boot-title-wedge): the loader
// obliterates 0x8c010000..0x30 with computed garbage while still in legal
// staging code. Under --nofastmem every guest store passes through these
// imports, so the writer's guest PC is capturable here. First 8 hits.
static inline void hdr_write_watch(uint32_t addr, uint32_t val, int bits) {
    const uint32_t p = addr & 0x1FFFFFFFu;
    // Write-SEQUENCE to the first pool word 0x8c00f2f8 (boot-title-wedge):
    // same seed → the fill writes a value sequence; the first write whose
    // value differs JIT-vs-interp, with its pc, names the divergent op.
    // (fastmem writes RAM in-wasm and skip this import — run --nofastmem to
    // see the JIT arm here; the interp arm always routes through imports.)
    if (p == 0x0C00F2F8u) {
        // Value-triggered: the specific pool word (JIT-wrong 0x5be637dc /
        // interp-correct 0x9e32255e) — dump the store's pc + full GPRs +
        // MAC. Whichever arm you run, its pool value fires here; the source
        // regs feeding this store point one op upstream to the divergence.
        if (val == 0x5be637dcu || val == 0x9e32255eu) {
            static int s_wv = 0;
            if (s_wv < 4) {
                ++s_wv;
                char buf[512];
                int off = snprintf(buf, sizeof(buf),
                    "[w2val] val=0x%08x pc=0x%08x pr=0x%08x mach=%08x macl=%08x regs:",
                    val, Sh4cntx.pc, Sh4cntx.pr, Sh4cntx.mac.h, Sh4cntx.mac.l);
                for (int i = 0; i < 16 && off < (int)sizeof(buf) - 16; i++)
                    off += snprintf(buf + off, sizeof(buf) - off, " r%d=%08x", i, Sh4cntx.r[i]);
                MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
                // Code window of the storing routine.
                for (int line = 0; line < 3; line++) {
                    const uint32_t base = (Sh4cntx.pc - 0x20) + line * 0x20;
                    off = snprintf(buf, sizeof(buf), "[w2val-code] base=0x%08x:", base);
                    for (int i = 0; i < 16; i++)
                        off += snprintf(buf + off, sizeof(buf) - off, " %04x", ReadMem16(base + i * 2) & 0xFFFF);
                    MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
                }
            }
        }
    }
    // ran3 pool-write sequence (boot-title-wedge, value-agnostic): every
    // write to the pool region from the ran3 core code (0x8c004000-0x8c004200)
    // — logged as (pc, word-index, val). Diffed across arms, the first
    // divergent val at the same (pc, index) names the op (or its inputs).
    if (p >= 0x0C00F2F8u && p < 0x0C00F3D4u) {
        const uint32_t wpc = Sh4cntx.pc;
        if (wpc >= 0x8c004000u && wpc < 0x8c004200u) {
            static int s_seq = 0;
            if (s_seq < 40) {
                ++s_seq;
                MAIN_THREAD_EM_ASM({
                    postMessage({cmd:'print', txt:'[ran3 #'+($0|0)+'] pc=0x'+($1>>>0).toString(16)+
                        ' idx='+(($2>>>0)-0x0c00f2f8>>2)+' val=0x'+($3>>>0).toString(16)+
                        ' r5=0x'+($4>>>0).toString(16)+' r6=0x'+($5>>>0).toString(16)});
                }, s_seq, (int)wpc, (int)p, val, (int)Sh4cntx.r[5], (int)Sh4cntx.r[6]);
            }
        }
    }
    // NOTE (boot-title-wedge): these memory-import watches fire on the JIT
    // arm ONLY — the interpreter calls flycast's native WriteMem*, never our
    // sh4_mem_write* imports, so interp write-sequences can't be captured
    // here. Interp reference must come via the trampoline block-boundary
    // dumps (pool watchpoint at 0x8c004184) or the emitter unit test.
    //
    // (disabled: superseded by the [ran3] sequence + trampoline pool dump)
    if (false && p >= 0x0C00F2F8u && p < 0x0C00F3D4u) {
        static bool s_pi_done = false;
        if (!s_pi_done) {
            s_pi_done = true;
            MAIN_THREAD_EM_ASM({
                postMessage({cmd:'print', txt:'[poolinit] first-write addr=0x'+($0>>>0).toString(16)+
                    ' val=0x'+($1>>>0).toString(16)+' pc=0x'+($2>>>0).toString(16)+
                    ' pr=0x'+($3>>>0).toString(16)});
            }, addr, val, (int)Sh4cntx.pc, (int)Sh4cntx.pr);
            char buf[560];
            for (int line = 0; line < 5; line++) {
                const uint32_t base = (Sh4cntx.pc - 0x60) + line * 0x40;
                int off = snprintf(buf, sizeof(buf), "[poolinit-code] base=0x%08x:", base);
                for (int i = 0; i < 32 && off < (int)sizeof(buf) - 8; i++)
                    off += snprintf(buf + off, sizeof(buf) - off, " %04x", ReadMem16(base + i * 2) & 0xFFFF);
                MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
            }
            int off = snprintf(buf, sizeof(buf), "[poolinit-regs]");
            for (int i = 0; i < 16 && off < (int)sizeof(buf) - 16; i++)
                off += snprintf(buf + off, sizeof(buf) - off, " r%d=%08x", i, Sh4cntx.r[i]);
            off += snprintf(buf + off, sizeof(buf) - off, " mach=%08x macl=%08x", Sh4cntx.mac.h, Sh4cntx.mac.l);
            MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
        }
    }
    // Input-staging watch: who writes the decompressor's input buffer at
    // 0x8c800000? (Its content never came from a visible GDROM read.)
    if (p >= 0x0C800000u && p < 0x0C800030u) {
        static int s_in_hits = 0;
        if (s_in_hits < 6) {
            ++s_in_hits;
            MAIN_THREAD_EM_ASM({
                postMessage({cmd:'print', txt:'[input-write #' + ($0|0) + '] W' + ($1|0) +
                    ' addr=0x' + ($2>>>0).toString(16) + ' val=0x' + ($3>>>0).toString(16) +
                    ' pc=0x' + ($4>>>0).toString(16) + ' pr=0x' + ($5>>>0).toString(16)});
            }, s_in_hits, bits, addr, val, (int)Sh4cntx.pc, (int)Sh4cntx.pr);
            if (s_in_hits == 1) {
                // Stage-1 (the descrambler): code + registers + ITS input.
                for (int line = 0; line < 3; line++) {
                    char buf[512];
                    const uint32_t base = (Sh4cntx.pc - 0x60) + line * 0x40;
                    int off = snprintf(buf, sizeof(buf), "[stage1-code] base=0x%08x words:", base);
                    for (int i = 0; i < 32 && off < (int)sizeof(buf) - 8; i++)
                        off += snprintf(buf + off, sizeof(buf) - off, " %04x",
                                        ReadMem16(base + i * 2) & 0xFFFF);
                    MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
                }
                char buf[512];
                int off = snprintf(buf, sizeof(buf), "[stage1-regs]");
                for (int i = 0; i < 16 && off < (int)sizeof(buf) - 16; i++)
                    off += snprintf(buf + off, sizeof(buf) - off, " r%d=%08x", i, Sh4cntx.r[i]);
                off += snprintf(buf + off, sizeof(buf) - off, " mach=%08x macl=%08x",
                                Sh4cntx.mac.h, Sh4cntx.mac.l);
                MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
            }
        }
    }
    if (p >= 0x0C010000u && p < 0x0C010030u) {
        static int s_hits = 0;
        if (s_hits < 8) {
            ++s_hits;
            MAIN_THREAD_EM_ASM({
                postMessage({cmd:'print', txt:'[hdr-write #' + ($0|0) + '] W' + ($1|0) +
                    ' addr=0x' + ($2>>>0).toString(16) + ' val=0x' + ($3>>>0).toString(16) +
                    ' pc=0x' + ($4>>>0).toString(16) + ' pr=0x' + ($5>>>0).toString(16)});
            }, s_hits, bits, addr, val, (int)Sh4cntx.pc, (int)Sh4cntx.pr);
            if (s_hits == 1) {
                // Ground-truth capture of the writing routine's code from
                // LIVE RAM (the staging area gets erased later, so disc
                // provenance is a dead end). 3 x 32 words from pc-0x40.
                for (int line = 0; line < 3; line++) {
                    char buf[512];
                    const uint32_t base = (Sh4cntx.pc - 0x40) + line * 0x40;
                    int off = snprintf(buf, sizeof(buf), "[hdr-write-code] base=0x%08x words:", base);
                    for (int i = 0; i < 32 && off < (int)sizeof(buf) - 8; i++)
                        off += snprintf(buf + off, sizeof(buf) - off, " %04x",
                                        ReadMem16(base + i * 2) & 0xFFFF);
                    MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
                }
                char buf[512];
                int off = snprintf(buf, sizeof(buf), "[hdr-write-regs]");
                for (int i = 0; i < 16 && off < (int)sizeof(buf) - 16; i++)
                    off += snprintf(buf + off, sizeof(buf) - off, " r%d=%08x", i, Sh4cntx.r[i]);
                MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
                // The decompressor's INPUT bytes (r4 walks 0x8c800009+):
                // compare against disc content to decide input-corrupt vs
                // math-corrupt.
                off = snprintf(buf, sizeof(buf), "[hdr-write-input] base=0x8c800000 words:");
                for (int i = 0; i < 32 && off < (int)sizeof(buf) - 8; i++)
                    off += snprintf(buf + off, sizeof(buf) - off, " %04x",
                                    ReadMem16(0x8c800000u + i * 2) & 0xFFFF);
                MAIN_THREAD_EM_ASM({ postMessage({cmd:'print', txt: UTF8ToString($0)}); }, buf);
            }
        }
    }
}

EMSCRIPTEN_KEEPALIVE
void sh4_mem_write16(uint32_t addr, uint32_t val) {
#ifdef FLYCAST_BRIDGE_DIAG
    hdr_write_watch(addr, val, 16);
#endif
#ifdef DEBUG_DISPATCH
    g_cb_mem_write_calls.fetch_add(1, std::memory_order_relaxed);
#endif
#ifdef FLYCAST_BRIDGE_DIAG
    g_cb_mem_write_by_area[(addr >> 26) & 63].fetch_add(1, std::memory_order_relaxed);
    const uint32_t pend = Sh4cntx.interrupt_pend;
#endif
    WriteMem16(addr, (uint16_t)val);
    smc_mark(addr, 2, 0);
#ifdef FLYCAST_BRIDGE_DIAG
    gdrom_log_w(addr, val, 16, pend);
#endif
}

EMSCRIPTEN_KEEPALIVE
void sh4_mem_write32(uint32_t addr, uint32_t val) {
#ifdef FLYCAST_BRIDGE_DIAG
    hdr_write_watch(addr, val, 32);
#endif
#ifdef DEBUG_DISPATCH
    g_cb_mem_write_calls.fetch_add(1, std::memory_order_relaxed);
#endif
#ifdef FLYCAST_BRIDGE_DIAG
    g_cb_mem_write_by_area[(addr >> 26) & 63].fetch_add(1, std::memory_order_relaxed);
    const uint32_t pend = Sh4cntx.interrupt_pend;
    // Bad-PR tripwire — narrowed: catch writes of an odd code-address
    // value to the specific stack slot range 0x7e000f60..0x7e000f80
    // where the corrupt PR=0x8c009dd1 was later loaded from (per ring
    // dump at the IP.BIN exception). This pinpoints the writing block.
    static int s_lsb_trip = 0;
    if (g_diag_enabled && s_lsb_trip < 8 && (val & 1) &&
        (val & 0xFF000000u) == 0x8C000000u &&
        addr >= 0x7e000f60u && addr <= 0x7e000f80u) {
        s_lsb_trip++;
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt:
                '[lsb-trip] #' + ($0|0) +
                ' write32 addr=0x' + ($1 >>> 0).toString(16) +
                ' val=0x' + ($2 >>> 0).toString(16) +
                ' guest_pc=0x' + ($3 >>> 0).toString(16) +
                ' r15=0x' + ($4 >>> 0).toString(16) +
                ' pr=0x' + ($5 >>> 0).toString(16)});
        }, s_lsb_trip, (int)addr, (int)val,
           (int)Sh4cntx.pc, (int)Sh4cntx.r[15], (int)Sh4cntx.pr);
    }
#endif
    // Lever-12 bucket [2]: Holly/PVR register stores. STARTRENDER is split out
    // because that single store carries the ENTIRE synchronous render (see the
    // g_attr_render_ms block at the top of this file); everything else in the
    // window is DMA arming (SB_C2DST ch2->TA, SB_SDST sort-DMA, SB_GDST) plus
    // plain register programming. The branch is one compare against a 29-bit
    // masked address on a path that already does an area lookup, so it costs
    // nothing on the ~99.9% of stores that are ordinary RAM traffic.
    {
        const uint32_t p29 = addr & 0x1FFFFFFFu;
        if (p29 >= HOLLY_REG_LO && p29 <= HOLLY_REG_HI) {
            const double t0 = emscripten_get_now();
            WriteMem32(addr, val);
            const double d = emscripten_get_now() - t0;
            if (p29 == STARTRENDER_PADDR) { g_attr_render_ms += d; ++g_attr_render_n; }
            else                          { g_attr_pvrreg_ms += d; ++g_attr_pvrreg_n; }
            smc_mark(addr, 4, 0);
#ifdef FLYCAST_BRIDGE_DIAG
            gdrom_log_w(addr, val, 32, pend);
#endif
            return;
        }
    }
    WriteMem32(addr, val);
    smc_mark(addr, 4, 0);
#ifdef FLYCAST_BRIDGE_DIAG
    gdrom_log_w(addr, val, 32, pend);
#endif
}

// IFB fallback. The compiled block emits:
//   call $sh4_ifb (i32 opcode_imm, i32 pc) -> ()
// We dispatch via the global OpPtr table — the same path rec-x64 takes when
// mmu is off (rec_x64.cpp:178). Sets pc into Sh4cntx first so opcodes that
// read PC (branches, PC-relative loads) see the right value.
EMSCRIPTEN_KEEPALIVE

void sh4_interp_ifb(uint32_t opcode, uint32_t pc) {
    g_ifb_count.fetch_add(1, std::memory_order_relaxed);
    // Lever-5D sizing (strip after verdict): which IFB ops burn the heavy
    // phase? ftrv/fipr/fsca are the 3D-geometry workhorses — each IFB fire
    // is a flushAll + import + OpDesc dispatch + interp handler + reload.
    {
        const uint32_t op16 = opcode & 0xFFFF;
        if      ((op16 & 0xF3FF) == 0xF1FD) ++g_ifb_ftrv;
        else if ((op16 & 0xF0FF) == 0xF0ED) ++g_ifb_fipr;
        else if ((op16 & 0xF1FF) == 0xF0FD) ++g_ifb_fsca;
        else                                ++g_ifb_other;
    }
    // Reios syscall trace (boot-title-wedge): every REIOS trap (0x085B) with
    // its args — the staging load's GDROM syscall traffic is the frontier
    // (disc ground truth: [1ST_READ+0x2c] must be 0x8c013380; JIT-arm RAM
    // holds 0x6da60000 ⇒ the load never landed). Consecutive duplicates
    // (same pc+r4..r7 — poll loops) are counted, not re-printed. Cap 120.
    if ((opcode & 0xFFFF) == 0x085B) {
        static u32 s_last_key[5] = {0};
        static u32 s_dup = 0;
        static int s_lines = 0;
        const u32 key[5] = { pc, Sh4cntx.r[4], Sh4cntx.r[5], Sh4cntx.r[6], Sh4cntx.r[7] };
        const bool same = key[0]==s_last_key[0] && key[1]==s_last_key[1] &&
                          key[2]==s_last_key[2] && key[3]==s_last_key[3] &&
                          key[4]==s_last_key[4];
        // Read-class REQ_CMDs always print (no dedup): repeated REQs through
        // the same param buffer carry different params — dedup hid the money
        // data (the big staged read's destination).
        const bool is_req = (key[4] == 0 && key[3] == 0);
        const bool is_read = is_req && (key[1] == 0x10 || key[1] == 0x11 ||
                                        key[1] == 0x1c || key[1] == 0x25 ||
                                        key[1] == 0x26 || key[1] == 0x27);
        if (same && !is_read) {
            ++s_dup;
        } else {
            if (s_lines < 120) {
                ++s_lines;
                // Decode the param block for reads:
                // params: [0]=sector [1]=count [2]=dst.
                u32 p0 = 0, p1 = 0, p2 = 0;
                if (is_read && key[2] != 0) {
                    try {
                        p0 = ReadMem32(key[2]);
                        p1 = ReadMem32(key[2] + 4);
                        p2 = ReadMem32(key[2] + 8);
                    } catch (SH4ThrownException&) {}
                }
                MAIN_THREAD_EM_ASM({
                    postMessage({cmd:'print', txt:'[reios-sc] pc=0x' + ($0>>>0).toString(16) +
                        ' r4=0x' + ($1>>>0).toString(16) + ' r5=0x' + ($2>>>0).toString(16) +
                        ' r6=0x' + ($3>>>0).toString(16) + ' r7=0x' + ($4>>>0).toString(16) +
                        ' r0=0x' + ($5>>>0).toString(16) + ($6 ? (' (prev x' + ($6>>>0) + ')') : '') +
                        ($7 ? (' READ sector=' + ($8>>>0) + ' n=' + ($9>>>0) +
                               ' dst=0x' + ($10>>>0).toString(16)) : '')});
                }, (int)pc, (int)key[1], (int)key[2], (int)key[3], (int)key[4],
                   (int)Sh4cntx.r[0], (int)s_dup, (int)is_read, (int)p0, (int)p1, (int)p2);
            }
            s_dup = 0;
            for (int i = 0; i < 5; i++) s_last_key[i] = key[i];
        }
    }
    // One-shot identification of which (pc, opcode) pairs are hitting the
    // interpreter fallback path. ifb at 130-160/sec post-VRAM-fill is the
    // dominant new dispatch cost (cited /tmp/dc-probes/post-vram.log [stats]).
    // Log first 32 unique pairs so we can identify which SHIL ops the
    // bementalJIT emitter is bailing on for the 0x8c019xxx-0x8c01cxxx region.
    {
        static uint32_t s_seen_pc[256] = {0};
        static uint32_t s_seen_op[256] = {0};
        static int      s_seen_count   = 0;
        if (s_seen_count < 256) {
            bool already = false;
            for (int i = 0; i < s_seen_count; ++i) {
                if (s_seen_pc[i] == pc && s_seen_op[i] == (opcode & 0xFFFF)) {
                    already = true; break;
                }
            }
            if (!already) {
                s_seen_pc[s_seen_count] = pc;
                s_seen_op[s_seen_count] = opcode & 0xFFFF;
                s_seen_count++;
                MAIN_THREAD_EM_ASM({
                    postMessage({cmd: 'print', txt:
                        '[ifb-pc] #' + ($0|0) +
                        ' pc=0x' + ($1 >>> 0).toString(16) +
                        ' op=0x' + (($2|0) & 0xFFFF).toString(16) +
                        ' major=' + ((($2|0) >> 12) & 0xF)});
                }, s_seen_count, pc, opcode);
            }
        }
    }
    Sh4cntx.pc = pc;

    // Inline fast paths for the two opcodes that dominate ifb/s on PSO boot
    // (per /tmp/dc-probes/post-vram.log: DIV0U at 0x8c00998c/0x8c009b00 and
    // DIV0S Rm,Rn at 0x8c0098e0/0x8c009a40/0x8c0103d6 — see [ifb-pc] entries).
    // Bypassing OpPtr dispatch + try/catch + asyncify frame shaves the
    // per-call cost from ~1μs to ~10ns of inline C. Doesn't eliminate the
    // cross-instance call_indirect entry to this function, but removes the
    // OpPtr indirection inside. Even though bementalJIT also has DIV0U/DIV0S
    // inlined in its shop_ifb emit path (wasm_emit.cpp), that path is never
    // taken for these opcodes — the decoder reaches them via a different
    // route. So we backstop here at the receiver.
    const uint16_t op16 = opcode & 0xFFFF;
    if (op16 == 0x0019u) {
        // DIV0U: SR.Q=0, SR.M=0, SR.T=0
        Sh4cntx.sr.Q = 0;
        Sh4cntx.sr.M = 0;
        Sh4cntx.sr.T = 0;
        return;
    }
    if ((op16 & 0xF00Fu) == 0x2007u) {
        // DIV0S Rm,Rn:  Q=Rn[31];  M=Rm[31];  T = M ^ Q
        const uint32_t n  = (op16 >> 8) & 0xFu;
        const uint32_t m  = (op16 >> 4) & 0xFu;
        const uint32_t Q  = (Sh4cntx.r[n] >> 31) & 1u;
        const uint32_t M  = (Sh4cntx.r[m] >> 31) & 1u;
        Sh4cntx.sr.Q = Q;
        Sh4cntx.sr.M = M;
        Sh4cntx.sr.T = M ^ Q;
        return;
    }

    // Pre-call arg capture for the GDROM CHECK_COMMAND post-exec log below.
    const uint32_t pre_r4 = Sh4cntx.r[4], pre_r5 = Sh4cntx.r[5];
    const uint32_t pre_r6 = Sh4cntx.r[6], pre_r7 = Sh4cntx.r[7];
    try {
        OpPtr[opcode & 0xFFFF](&Sh4cntx, opcode & 0xFFFF);
    } catch (const SH4ThrownException&) {
        // Log the (pc, opcode, sr) at the throw site for the first 16
        // occurrences so we can pinpoint which interpreter op is raising
        // exceptions during Reios boot. Then rethrow for the dispatcher
        // mainloop catch to handle (calls Do_Exception → vector dispatch).
        static int log_count = 0;
        if (log_count < 16) {
            log_count++;
            uint32_t sr = Sh4cntx.sr.getFull();
            MAIN_THREAD_EM_ASM({
                postMessage({cmd: 'print', txt:
                    '[sh4-throw] #' + $0 +
                    ' pc=' + ($1 >>> 0).toString(16) +
                    ' op=' + ($2 & 0xFFFF).toString(16) +
                    ' sr=' + ($3 >>> 0).toString(16) +
                    ' BL=' + (($3 >>> 28) & 1) +
                    ' MD=' + (($3 >>> 30) & 1)});
            }, log_count, pc, opcode, sr);
        }
        throw;
    }
    // GDROM CHECK_COMMAND post-exec result (boot-title-wedge): r0 after the
    // trap ran + the 4-word status block the HLE wrote at [r5]. Dedup on the
    // (id, r0, err, size, wait) signature so the endless poll compresses.
    if (op16 == 0x085Bu && pre_r6 == 0 && pre_r7 == 1) {
        uint32_t err = 0, size = 0, wait = 0;
        try {
            err  = ReadMem32(pre_r5);
            size = ReadMem32(pre_r5 + 8);
            wait = ReadMem32(pre_r5 + 12);
        } catch (SH4ThrownException&) {}
        static uint32_t s_last_sig = 0xDEADBEEFu;
        static uint32_t s_rep = 0;
        static int s_chk_lines = 0;
        const uint32_t sig = (Sh4cntx.r[0] << 24) ^ pre_r4 ^ err ^ (size * 31u) ^ (wait * 131u);
        if (sig != s_last_sig) {
            if (s_chk_lines < 40) {
                ++s_chk_lines;
                MAIN_THREAD_EM_ASM({
                    postMessage({cmd:'print', txt:'[gd-check] id=' + ($0>>>0) +
                        ' ret=' + ($1>>>0) + ' err=0x' + ($2>>>0).toString(16) +
                        ' size=0x' + ($3>>>0).toString(16) + ' wait=0x' + ($4>>>0).toString(16) +
                        ($5 ? (' (prev x' + ($5>>>0) + ')') : '')});
                }, (int)pre_r4, (int)Sh4cntx.r[0], (int)err, (int)size, (int)wait, (int)s_rep);
            }
            s_last_sig = sig;
            s_rep = 0;
        } else {
            ++s_rep;
        }
    }
}

// SHIL canonical-call fallback. Phase 1 emits NO calls to this — emitShilOp
// only handles shop_ifb natively, and every other op routes to sh4_ifb above.
// Once the SHIL native-emit roadmap lands, the ops that can't be expressed
// in WASM directly (helper calls, FPU side-effects, exceptions) will route
// through here with (block_vaddr, op_idx) and we'll need a shil-op table
// keyed by those args.
//
// SHIL canonical-call dispatcher. Two ops route through here per
// wasm_emit.cpp:1009-1014:
//   shop_sync_sr    -> UpdateSR()  (sh4_core_regs.cpp:21) — propagates SR
//                      changes, including the bank swap (r[0..7] <-> r_bank)
//                      when SR.RB flips and INTC mask refresh via SRdecode().
//                      WITHOUT THIS, RTE returning across an RB transition
//                      lands on the wrong bank with stale registers, which
//                      is exactly the divergence we observed at dispatch
//                      #4861K (real BIOS code -> wild PC at 0x8ce26a1e).
//   shop_sync_fpscr -> Sh4Context::UpdateFPSCR(ctx)  (sh4_if.h:206) —
//                      rebuilds derived FPU rounding/denormal state.
//
// Look up the block's oplist[op_idx] to dispatch. If lookup fails (block
// removed, index out of range), call both helpers — they're idempotent
// and the cost of an extra call dwarfs the cost of a missed sync.
EMSCRIPTEN_KEEPALIVE
void sh4_interp_shil_fb(uint32_t block_vaddr, uint32_t op_idx) {
    // Sentinel from emitBlockExit (wasm_emit.cpp BET_*Intr tail-call):
    // route to UpdateINTC so any IRQ that became deliverable after this
    // block's SR change actually reaches Do_Interrupt. Native rec-x64 emits
    // GenCall(UpdateINTC) at the equivalent block end (rec_x64.cpp:530).
    if (block_vaddr == 0xFFFFFFFFu) {
        // DIAGNOSTIC (boot-title-wedge, strip after verdict): mirror the
        // dispatcher's decrypt-window vector suppression so the experiment
        // covers block-entry pend checks too.
        const uint32_t dpc = Sh4cntx.pc;
        if (!(dpc >= 0x8c004100u && dpc < 0x8c004260u))
            UpdateINTC();
        return;
    }
    // block_vaddr carries a DIRECT pointer to the shil_opcode (see the SHIL_FB
    // emit sites in wasm_emit.cpp). The old design passed (block_vaddr, op_idx)
    // and did bm_GetBlock(vaddr)->oplist[op_idx] — but bementalJIT blocks are
    // NOT registered in flycast's bm (it avoids bm_AddBlock to dodge the FPCA
    // verify crash), so bm_GetBlock ALWAYS returned null and div32*/pref
    // silently no-op'd through the defensive fallback below. That was the
    // decrypt-divide bug: the whole software divide computed nothing.
    (void)op_idx;
    {
        shil_opcode& op = *reinterpret_cast<shil_opcode*>((uintptr_t)block_vaddr);
        switch (op.op) {
        case shop_sync_sr:
            // Lever-5B sizing instrument (ctxsnap 81): sync_sr fire rate — each
            // fire is a flushAll + this import + UpdateSR + reload. The heavy
            // phase's top PC region is the game's imask set/restore primitives.
            ++g_syncsr_count;
            UpdateSR();
            return;
        case shop_sync_fpscr:
            // Lever-10 sizing instrument (ctxsnap 89): sync_fpscr fire rate —
            // each fire is a flushAll + this import + UpdateFPSCR + reload.
            ++g_syncfpscr_count;
            Sh4Context::UpdateFPSCR(&Sh4cntx);
            return;
        case shop_div32u:
        case shop_div32s:
        case shop_div32p2: {
            // shil_chf[op.op] is the codegen compile() method (shil_canonical.h:63,
            // 41-43), which drives the backend's canonStart/canonParam/canonCall/
            // canonFinish to EMIT a call — it does NOT execute the arithmetic. On
            // the wasm backend those four are empty stubs (rec_wasm.cpp:2364-2384),
            // so shil_chf[shop_div32*](&op) is a silent NO-OP: rd/rd2 are never
            // written and the folded software divide produces garbage. Execute the
            // canonical arithmetic directly here. Formulas verbatim from
            // shil_canonical.h:547-651 (guarded by tests/src/div32_test.cpp).
            // Canon-call ABI pushes args rs3,rs2,rs1 so f1(r1,r2,r3)=(rs1,rs2,rs3);
            // u64 result splits low->rd (quotient), high->rd2 (remainder).
            auto rv_of = [&](const shil_param& p) -> u32 {
                return p.is_imm() ? p.imm_value() : *p.reg_ptr(Sh4cntx);
            };
            if (op.op == shop_div32u) {                 // shil_canonical.h:547-570
                u32 r1 = rv_of(op.rs1), r2 = rv_of(op.rs2), r3 = rv_of(op.rs3);
                u64 dividend = ((u64)r3 << 32) | r1;
                u32 quo, rem;
                if (r2) { quo = (u32)(dividend / r2); rem = (u32)(dividend % r2); }
                else    { quo = 0;                     rem = (u32)dividend; }
                *op.rd.reg_ptr(Sh4cntx) = quo;
                if (op.rd2.is_reg()) *op.rd2.reg_ptr(Sh4cntx) = rem;
            } else if (op.op == shop_div32s) {          // shil_canonical.h:583-606
                u32 r1 = rv_of(op.rs1); s32 r2 = (s32)rv_of(op.rs2); s32 r3 = (s32)rv_of(op.rs3);
                s64 dividend = ((s64)r3 << 32) | (u32)r1;
                if (dividend < 0) dividend++;           // 1's -> 2's complement
                s32 quo = (s32)(r2 ? dividend / r2 : 0);
                s32 rem = (s32)(dividend - quo * r2);    // quo*r2 in s32, matching flycast
                u32 negative = (r3 ^ r2) & 0x80000000;
                if (negative)    quo--;                  // 2's -> 1's complement
                else if (r3 < 0) rem--;
                *op.rd.reg_ptr(Sh4cntx) = (u32)quo;
                if (op.rd2.is_reg()) *op.rd2.reg_ptr(Sh4cntx) = (u32)rem;
            } else {                                     // shop_div32p2, shil_canonical.h:619-640
                s32 a = (s32)rv_of(op.rs1), b = (s32)rv_of(op.rs2); u32 T = rv_of(op.rs3);
                if (!(T & 0x80000000)) { if (!(T & 1)) a -= b; }
                else                   { if (b > 0) a--; if (T & 1) a += b; }
                *op.rd.reg_ptr(Sh4cntx) = (u32)a;
            }
            return;
        }
        case shop_fsca: {
            // sin/cos table lookup — bit-exact port of shil_canonical.h's
            // fsca_table (fsca_impl) / sh4_fpu.cpp:348. Until 2026-08-27 this
            // fell into the default arm's stubbed canon ABI and was a SILENT
            // NO-OP (same class as the div32 bug): the camera-rotation matrix
            // consumed stale fr values and gameplay vertex transforms exploded
            // off-screen — the black-world bug (world geometry invisible while
            // HUD/dialogue rendered; docs/black-world-fsca.md).
            const u32 fixed = op.rs1.is_imm() ? op.rs1.imm_value()
                                              : *op.rs1.reg_ptr(Sh4cntx);
            f32* fd = (f32*)op.rd.reg_ptr(Sh4cntx);
            const u32 pi_index = fixed & 0xFFFF;
            fd[0] = sin_table[pi_index].u[0];
            fd[1] = sin_table[pi_index].u[1];
            return;
        }
        case shop_pref: {
            // Store-queue flush. Canonical (shil_canonical.h:801) / interpreter
            // (sh4_opcodes.cpp:1153): a pref whose target is the SQ region
            // (0xE0000000-, addr>>26 == 0x38) bursts the 32-byte store queue to
            // memory via ctx->doSqWrite. The native emit (wasm_emit.cpp:1556)
            // guards the SQ region then routes here; without executing doSqWrite
            // the burst is DROPPED (silent no-op via the stubbed canon ABI, same
            // class as the div32 bug) — a decompressor's SQ output path is lost.
            const u32 rn = op.rs1.is_imm() ? op.rs1.imm_value()
                                           : *op.rs1.reg_ptr(Sh4cntx);
            // Lever-12 bucket [3]: store-queue burst. This is the TA vertex
            // submission path (QACR maps the SQ at 0xE0000000 onto the TA FIFO
            // at 0x10000000), so it is real render work executing inside the
            // JIT dispatch loop, exactly like STARTRENDER. It is also the ONE
            // bucket hot enough to need sampling: a busy frame can burst
            // hundreds of thousands of 32-byte queues per second, and timing
            // every one would reproduce the per-dispatch observer effect
            // (a CPU profile already crushed this guest 792 -> 118-208 MHz).
            // Count exactly, time 1 in 64; the consumer scales by n/smp.
            if ((rn >> 26) == 0x38) {
                // Which sink this burst goes to. storeq.cpp setSqwHandler()
                // picks doSqWrite from CCN_QACR0.Area: area 4 -> sqWriteTA ->
                // TAWriteSQ -> ta_vtx_data32 (POLYGON SUBMISSION, i.e. real
                // render work), area 3 -> a plain 32-byte RAM copy (a fast
                // memcpy idiom, i.e. ordinary guest work). Counting the split
                // stops this bucket from being quoted as "TA cost" when it may
                // be mostly memcpy. Mirrors flycast's own QACR0-only read; if
                // CCN_MMUCR.AT is set the handler is sqWrite<true> and this
                // classification does not apply (PSO runs MMU-off).
                if (CCN_QACR0.Area == 4) ++g_attr_sq_ta_n;
                if ((g_attr_sq_n++ & SQ_SAMPLE_MASK) == 0) {
                    const double t0 = emscripten_get_now();
                    Sh4cntx.doSqWrite(rn, &Sh4cntx);
                    g_attr_sq_ms += emscripten_get_now() - t0;
                    ++g_attr_sq_smp;
                } else {
                    Sh4cntx.doSqWrite(rn, &Sh4cntx);
                }
            }
            return;
        }
        default:
            // Remaining canonical-only SHIL ops (fsca, illegal, debug_*) still
            // route through the stubbed canon ABI above and are therefore also
            // no-ops today — a separate lever wires them (or implements a real
            // WasmDynarec canon ABI).
            shil_chf[op.op](&op);
            return;
        }
    }
}

}  // extern "C"

// ---------------------------------------------------------------------------
// main: keep runtime alive; init is driven explicitly from JS via
// emscripten_worker_init so the page controls the boot sequence (e.g. the
// page may want to mount FS contents before retro_init runs).
// ---------------------------------------------------------------------------
int main(void) {
    // The pthread that runs main() is NOT the main-runtime thread under
    // PROXY_TO_PTHREAD=1 — the shim worker is. So we don't do GL work here;
    // emscripten_create_gl_context + emscripten_worker_init are called by
    // the shim on the main-runtime thread instead. Just sit alive so the
    // pthread doesn't tear down its mailbox.
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[flycast-worker] main pthread entered (idle)'});
    });
    emscripten_exit_with_live_runtime();
    return 0;
}

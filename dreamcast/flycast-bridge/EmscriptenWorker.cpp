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
#include "hw/sh4/dyna/shil.h"          // shop_sync_sr / shop_sync_fpscr enums
#include "hw/sh4/dyna/blockmanager.h"  // bm_GetBlock
#include "imgread/common.h"             // libGDR_GetDiscType, DiscType enum
#include "hw/sh4/sh4_opcode_list.h"
#include "hw/sh4/sh4_interrupts.h"   // SR/decoded_srimask access for IRQ trace
#include "hw/holly/holly_intc.h"     // asic_RaiseInterrupt + HollyInterruptID
#include "stdclass.h"   // set_user_data_dir, get_readonly_data_path
#include "cfg/option.h" // config::CustomTextures / PreloadCustomTextures
#include "oslib/storage.h"
#include "oslib/oslib.h"   // hostfs::findFlash

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
bool retro_load_game(const struct retro_game_info* info);
void retro_unload_game(void);
size_t retro_serialize_size(void);
bool retro_serialize(void* data, size_t size);
bool retro_unserialize(const void* data, size_t size);
}

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
    ++frame_count;
    const bool is_real_frame = (data != nullptr);
    if (is_real_frame) ++real_frame_count;
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
        volatile uint32_t* head_p = (volatile uint32_t*)(g_audio_ring_base + 0);
        volatile uint32_t* tail_p = (volatile uint32_t*)(g_audio_ring_base + 4);
        int16_t* ring_samples = (int16_t*)(g_audio_ring_base + 8);
        const uint32_t cap = g_audio_ring_capacity;  // stereo frames
        const uint32_t mask = cap - 1u;              // power-of-two
        uint32_t head = *head_p;
        uint32_t tail = *tail_p;
        // Drop on overflow rather than block — the SH4 thread cannot stall
        // here. The page-side audio sink is responsible for keeping up.
        for (size_t i = 0; i < frames; i++) {
            const uint32_t free_frames = cap - (head - tail);
            if (free_frames == 0) break;
            const uint32_t slot = (head & mask) * 2u;
            ring_samples[slot + 0] = data[i * 2 + 0];
            ring_samples[slot + 1] = data[i * 2 + 1];
            head++;
        }
        *head_p = head;
        return frames;
    }

    // Fallback: drop samples (no postMessage path — the message-per-batch
    // overhead at 44.1 kHz is unworkable). Caller still gets the "consumed"
    // count so Flycast doesn't back up its mixer.
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
    (void)device; (void)index;
    // Layout (per-port, 64 bytes per port, 4 ports = 256 bytes):
    //   bytes 0..7:  digital button bitmap (8 bytes = 64 bits, indexed by id)
    //   bytes 8..63: analog axes / triggers / extension state (JS-defined)
    if (port >= 4 || id >= 64) return 0;
    const unsigned base = port * 64u;
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
    attrs.explicitSwapControl       = false;
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
    // Note: ThreadedRendering left at its default (true). Flycast's
    // single-thread retro_run path discards emu.render()'s return value
    // (libretro.cpp:1259 - `emu.render();` with no assignment), so is_dupe
    // stays true forever and every video_cb is a dupe-frame sentinel even
    // when the SH4 is producing TA data. The threaded path runs the SH4 on
    // an std::async lambda and rend_single_frame() blocks waiting for the
    // PVR present message — that's the only path that signals real frames
    // to video_cb. The lambda's pthread spawn was tested earlier this
    // session; the mainloop log showed exactly one entry (correct for
    // threaded mode — the SH4 thread runs until CpuRunning goes false).

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

EMSCRIPTEN_KEEPALIVE
void emscripten_run_iter(void) {
    if (!g_loaded) return;
    static unsigned long s_call_count = 0;
    ++s_call_count;
    if (s_call_count < 5 || s_call_count % 1000 == 0) {
        EM_ASM({
            postMessage({cmd: 'print', txt: '[flycast-worker] run_iter enter #' + $0});
        }, (int)s_call_count);
    }
    retro_run();
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

EMSCRIPTEN_KEEPALIVE
int emscripten_load_state(const uint8_t* buf, size_t size) {
    if (!g_loaded || !buf || !size) return 0;
    return retro_unserialize(buf, size) ? 1 : 0;
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

EMSCRIPTEN_KEEPALIVE
void sh4_mem_write8(uint32_t addr, uint32_t val) {
#ifdef DEBUG_DISPATCH
    g_cb_mem_write_calls.fetch_add(1, std::memory_order_relaxed);
#endif
#ifdef FLYCAST_BRIDGE_DIAG
    g_cb_mem_write_by_area[(addr >> 26) & 63].fetch_add(1, std::memory_order_relaxed);
    const uint32_t pend = Sh4cntx.interrupt_pend;
#endif
    WriteMem8(addr, (uint8_t)val);
#ifdef FLYCAST_BRIDGE_DIAG
    gdrom_log_w(addr, val, 8, pend);
#endif
}

EMSCRIPTEN_KEEPALIVE
void sh4_mem_write16(uint32_t addr, uint32_t val) {
#ifdef DEBUG_DISPATCH
    g_cb_mem_write_calls.fetch_add(1, std::memory_order_relaxed);
#endif
#ifdef FLYCAST_BRIDGE_DIAG
    g_cb_mem_write_by_area[(addr >> 26) & 63].fetch_add(1, std::memory_order_relaxed);
    const uint32_t pend = Sh4cntx.interrupt_pend;
#endif
    WriteMem16(addr, (uint16_t)val);
#ifdef FLYCAST_BRIDGE_DIAG
    gdrom_log_w(addr, val, 16, pend);
#endif
}

EMSCRIPTEN_KEEPALIVE
void sh4_mem_write32(uint32_t addr, uint32_t val) {
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
    WriteMem32(addr, val);
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
        UpdateINTC();
        return;
    }
    auto blk = bm_GetBlock(block_vaddr);
    if (blk && op_idx < blk->oplist.size()) {
        shil_opcode& op = blk->oplist[op_idx];
        switch (op.op) {
        case shop_sync_sr:
            UpdateSR();
            return;
        case shop_sync_fpscr:
            Sh4Context::UpdateFPSCR(&Sh4cntx);
            return;
        default:
            // Canonical-only SHIL ops (div32u/s/p2, fsca, illegal, debug_*, pref-SQ)
            // dispatch through the SHIL canonical handler table — mirrors the
            // rec_x64.cpp:467 default path (shil_chf[op.op](&op)). Without this,
            // wasm_emit's generic IFB fallback runs the SH4 interpreter on the
            // raw opcode at op.guest_offs, which is wrong for SHIL ops that
            // have no 1:1 SH4 opcode (e.g. div32u is decoder lowering of div0u
            // + multiple SHIL steps; running div0u alone produces garbage).
            shil_chf[op.op](&op);
            return;
        }
    }
    // Defensive fallback (block lookup failed or unexpected op).
    UpdateSR();
    Sh4Context::UpdateFPSCR(&Sh4cntx);
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

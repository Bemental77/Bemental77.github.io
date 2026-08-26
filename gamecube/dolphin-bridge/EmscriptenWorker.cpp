// Worker-side Dolphin bridge.
// Wraps the existing libretro retro_* API (already linked from dolphin_libretro.a)
// and forwards video/audio out via postMessage to the main thread.

#include <emscripten.h>
#include <emscripten/html5.h>
#include <emscripten/html5_webgl.h>
#include <emscripten/atomic.h>  // [ppc-bridge cutover] emscripten_atomic_notify for the mailbox drain
#include <libretro.h>
#include <cstdint>
#include <cstdio>
#include <cstring>

#include "Common/Config/Config.h"
#include "Core/Config/MainSettings.h"
#include "Core/ConfigManager.h"
#include "Core/HLE/HLE.h"

// Item 7 Phase IV: dolphin_service_iter routes here when CT_PHASE4_ENABLE
// is set. Instead of running the full retro_run() → JitWasm::Run() chain
// (which is the PPC dispatch path now owned by ppc-worker), we drain the
// MMIO mirror + SPSC ring, sync TB/DEC, fire any ppc-worker-pre-fired
// hybrid events (VI/DSP/AudioDMA/GPUSleeper/PatchEngine) into dolphin's
// CoreTiming queue, then call retro_run() once. That outer call's
// JitWasm::Run() will exit immediately because downcount is owned by
// ppc-worker (already <= 0 mid-yield), so the libretro frontend
// callbacks (video_cb, audio_*_cb) still fire normally — at the cost of
// one Advance + outer-while iter overhead per service tick. Minimal-risk
// shape: no rewiring of libretro pipeline, only a service detour.
#include "Core/System.h"
#include "Core/HW/Memmap.h"
#include "Core/HW/MMIO.h"
#include "Core/PowerPC/PowerPC.h"
// MMIOMirror.h was part of the prior dolphin-src fork's diagnostic stack and
// is deliberately not present in the sanitized tree (df03d80 + canonical
// CMake gates). Removed unused include; if any MMIOMirror.h symbol turns out
// to still be referenced below, re-evaluate as canonical-source work.
#include "Core/HW/SystemTimers.h"
#include "Core/CoreTiming.h"
#include "Core/PowerPC/MMU.h"  // [mmio-mirror16] MMU::Read<u16> for the mirror refresher
#include "VideoCommon/Fifo.h"              // [gpu-pump]
#include "VideoCommon/AsyncRequests.h"     // [savestate-fix PM61] drain routed video DoState
#include "VideoCommon/CommandProcessor.h"  // [gpu-pump]
#include "VideoCommon/PixelEngine.h"          // [PE-finish flush]
#include "VideoCommon/OpcodeDecoding.h"       // [recomp-render] RunFifo<false> — reuse Dolphin's GP-FIFO decoder
#include "VideoCommon/DataReader.h"           // [recomp-render] DataReader(begin,end) byte range
#include "VideoCommon/VertexManagerBase.h"    // [recomp-render] g_vertex_manager->Flush()
#include "VideoCommon/FramebufferManager.h"   // [recomp-render] g_framebuffer_manager->RefreshPeekCache()
#include "VideoCommon/VideoBackendBase.h"     // [recomp-bridge] g_video_backend->Video_OutputXFB (explicit present)
#include "Core/HW/ProcessorInterface.h"     // [msr-zero watch cause/mask]
#include "Core/HW/DSP.h"                    // [msr-zero watch dspctl]
#include "Core/HW/CPU.h"                    // [savestate-fix PM61] resume CPU m_state after load
#include "Core/HW/VideoInterface.h"         // [VI-tick] beam advance under worker ownership
#include "Core/HW/Memmap.h"                 // [r1-watch GetRAM]
#include "Core/HW/GPFifo.h"                 // [domino3] GPFifoManager::GetGatherPipeCount/Write8 (residual pad-flush)
#include "Common/Swap.h"                    // [r1-watch swap32]

// CT phase flag accessor + queue mask drain live in JitWasm.cpp.
extern "C" {
unsigned dolphin_ct_get_phase_flags(void);
unsigned dolphin_ct_drain_pending_mask(void);
// Defined in dolphin_jit_wimports.cpp — evicts a single PC from
// JitWasm::m_wasm_cache (the bementalJIT block cache). Used after
// out-of-band HLE::Patch calls so the next dispatch recompiles the
// block with the new HLE hook check live.
void dolphin_evict_block(uint32_t pc);
}

extern "C" {
void retro_init(void);
void retro_deinit(void);
unsigned retro_api_version(void);
void retro_get_system_info(struct retro_system_info* info);
void retro_get_system_av_info(struct retro_system_av_info* info);
void retro_set_environment(retro_environment_t cb);
void retro_set_video_refresh(retro_video_refresh_t cb);
void retro_set_audio_sample(retro_audio_sample_t cb);
void retro_set_audio_sample_batch(retro_audio_sample_batch_t cb);
void retro_set_input_poll(retro_input_poll_t cb);
void retro_set_input_state(retro_input_state_t cb);
void retro_run(void);
bool retro_load_game(const struct retro_game_info* info);
// Libretro frontend contract: the frontend declares attached controllers via
// retro_set_controller_port_device after retro_load_game. This minimal worker
// never did, so input_types[] stayed RETRO_DEVICE_NONE and ALL FOUR SI ports
// were configured SIDEVICE_NONE (Input.cpp:1017) — unlike native Dolphin.
// MP4's HuPadRead then spins forever in PAD origin polling (observed
// 2026-06-11: 1.29M [ax-fill] memsets of the PAD Origin array + a stack
// PADStatus buffer at ~7k/sec, GlobalCounter frozen at 0).
void retro_set_controller_port_device(unsigned port, unsigned device);
#define EMW_RETRO_DEVICE_JOYPAD 1
// Forward-declared (DolphinLibretro/Video.h drags Vulkan headers): the
// video-backend init entry normally fired by a libretro frontend's
// hw_render.context_reset callback — which this minimal worker frontend
// never invokes (environment_cb rejects SET_HW_RENDER). Without it,
// VideoBackendBase::InitializeShared never runs: g_texture_cache et al.
// stay null (OOB crash at the guest's first EFB copy once the CP FIFO
// decodes) and FifoManager::RefreshConfig never loads sync-gpu config.
// The SW renderer needs no host GL context, so calling it right after
// retro_load_game is safe here.
extern "C++" { namespace Libretro { namespace Video { void ContextReset(void); } } }
void retro_unload_game(void);
size_t retro_serialize_size(void);
bool retro_serialize(void* data, size_t size);
bool retro_unserialize(const void* data, size_t size);
}

// All-released is the ONLY sane default. This was 0xFF-filled (every button
// on every port pressed from boot) — 2026-06-11 PSO root cause: the
// AppSwitcher's pad check saw its return-to-menu combo held (Pad::GetStatus
// button=0x1f7f, triggers 255/255 on every poll) and deliberately called
// OSResetSystem(HOTRESET) mid-load of psov3.dol, parking the console in
// __OSDoHotReset's spin (PI_RESET_CODE write, drive -> DiscIdNotRead, no
// further frames). The headless probe never sends pad input, so the init
// value IS the steady-state.
static uint8_t g_pad[32] = {};

static bool g_loaded = false;

// [HW-render 2026-06-17] WebGL2 hardware-render path (adapted from the working
// dreamcast/flycast-bridge). Dolphin's OGL backend is already linked
// (libvideoogl.a); these answer SET_HW_RENDER + provide the WebGL2 context so
// the backend rasterizes on the GPU instead of the CPU-thread Software
// Renderer. The context is created on this pthread in main() (PROXY_TO_PTHREAD)
// on the OffscreenCanvas the page transfers as Module.canvas ("#canvas").
static struct retro_hw_render_callback g_hw_render = {};
static bool g_hw_render_registered = false;
static EMSCRIPTEN_WEBGL_CONTEXT_HANDLE g_gl_ctx = 0;

static uintptr_t hw_get_current_framebuffer_cb(void) {
    return 0;  // default FB = OffscreenCanvas backbuffer
}
static retro_proc_address_t hw_get_proc_address_cb(const char* sym) {
    return (retro_proc_address_t)emscripten_webgl_get_proc_address(sym);
}

static bool environment_cb(unsigned cmd, void* data) {
    switch (cmd) {
        case RETRO_ENVIRONMENT_SET_HW_RENDER: {
            auto* req = (struct retro_hw_render_callback*)data;
            g_hw_render = *req;
            req->get_current_framebuffer        = hw_get_current_framebuffer_cb;
            req->get_proc_address               = hw_get_proc_address_cb;
            g_hw_render.get_current_framebuffer = hw_get_current_framebuffer_cb;
            g_hw_render.get_proc_address        = hw_get_proc_address_cb;
            g_hw_render_registered = true;
            MAIN_THREAD_EM_ASM({
                postMessage({cmd: 'print', txt: '[worker] SET_HW_RENDER captured (ctx_type=' + $0 + ', ver=' + $1 + '.' + $2 + ')'});
            }, (int)g_hw_render.context_type, (int)g_hw_render.version_major, (int)g_hw_render.version_minor);
            return true;
        }
        case RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER:
            // Steer Dolphin to OpenGL ES 3 (WebGL2 is GLES3-compatible).
            *(unsigned*)data = RETRO_HW_CONTEXT_OPENGLES3;
            return true;
        case RETRO_ENVIRONMENT_GET_CAN_DUPE:
            *(bool*)data = true;
            return true;
        case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
            // Boot.cpp:182 does user_dir = save_dir + "/User" → for HLE patches
            // (Patching OSReport / ___blank / OSPanic) to install, the resulting
            // D_MAPS_IDX must match where worker_funcs.js preloads GSNE8P.map.
            // Returning "/dolphin-emu" gives user_dir="/dolphin-emu/User" and
            // D_MAPS_IDX="/dolphin-emu/User/Maps/" — that's one of the paths
            // worker_funcs.js writes the map to. Previously "/" produced the
            // fragile "//User/Maps/" with double slash; switching to a clean
            // single-slash path eliminates MEMFS normalization as a variable.
            *(const char**)data = "/dolphin-emu";
            return true;
        case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
            // Accept XRGB8888. Required so the SW renderer's RGBA output
            // can be pushed via video_cb. Without this, default RETRO_PIXEL_
            // FORMAT_RGB565 mismatches the 4-byte SW frame buffer and the
            // page receives garbage even when video_cb fires.
            return *(const enum retro_pixel_format*)data ==
                   RETRO_PIXEL_FORMAT_XRGB8888;
        default:
            return false;
    }
}

static void video_cb(const void* data, unsigned w, unsigned h, size_t pitch) {
    static int frame_log = 0;
    static bool first_frame_signaled = false;
    // [ax-vcb] the "video_cb (count=N)" probe metric parses these lines. The
    // old `< 3` cap made it look like only 3 frames ever presented — but the
    // render postMessage below fires EVERY call. Log first 3 + every 128th so
    // the true present rate is visible.
    frame_log++;
    if (frame_log <= 3 || (frame_log & 0x7F) == 0) {
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt: '[worker] video_cb data=' + $0 + ' w=' + $1 + ' h=' + $2 + ' pitch=' + $3 + ' n=' + $4});
        }, (uintptr_t)data, w, h, (uint32_t)pitch, frame_log);
    }
    // [HW-render] libretro passes (void*)-1 (RETRO_HW_FRAME_BUFFER_VALID) when
    // the OGL backend rendered the frame into the WebGL2 backbuffer. Present it
    // via the explicit swap on this GL-owning thread; do NOT dereference `data`.
    if (data == (const void*)(intptr_t)-1) {
        // [FIX#1] When the GL descriptor is enabled, this thread holds no
        // canvas-bound GL context — the render worker owns the canvas and the
        // OffscreenCanvas auto-presents its default FB. Emit the present opcode
        // (56) into the ring instead of committing here; commit on this thread
        // would error (no real context). Read the descriptor from the shared heap
        // (same reason as the install gate). Cache after first read (per-frame).
        static int rw = -1;
        if (rw < 0) {
            rw = EM_ASM_INT({
                var h = Module.HEAPU32 || new Uint32Array(Module.HEAPU8.buffer);
                return (h[0x07FF0000 >> 2] === 0x474C5244 && h[(0x07FF0000 >> 2) + 4] === 1) ? 1 : 0;
            });
        }
        if (rw) {
            EM_ASM({ if (Module.__gcGlEmitPresent) Module.__gcGlEmitPresent(); });
        } else {
            // Present the OGL-rendered backbuffer via the explicit swap on this
            // GL-owning thread. (NB: the real per-frame OGL presents currently
            // route through VideoCommon's presenter, not this path — verified
            // 2026-06-17 by the [ax-commit] bracket never firing while
            // [ax-present] ViSwap did.)
            emscripten_webgl_commit_frame();
        }
        if (!first_frame_signaled) {
            first_frame_signaled = true;
            MAIN_THREAD_EM_ASM({ if (typeof markFirstFrame === 'function') markFirstFrame(); });
        }
        return;
    }
    if (!data || !w || !h) return;
    // First real frame — flip the boot-loop pacing flag so worker_funcs.js
    // switches from flat-out boot mode to 60 Hz steady state.
    if (!first_frame_signaled) {
        first_frame_signaled = true;
        MAIN_THREAD_EM_ASM({
            if (typeof markFirstFrame === 'function') markFirstFrame();
        });
    }
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
    size_t bytes = frames * 4;
    MAIN_THREAD_EM_ASM({
        var src = $0;
        var view = HEAPU8.subarray(src, src + $1);
        var copy = new Uint8Array(view);
        postMessage({cmd: 'audio', buf: copy, len: $1}, [copy.buffer]);
    }, data, bytes);
    return frames;
}

static void audio_sample_cb(int16_t l, int16_t r) {
    int16_t buf[2] = {l, r};
    audio_sample_batch_cb(buf, 1);
}

static void input_poll_cb(void) {}

static int16_t input_state_cb(unsigned port, unsigned device, unsigned index, unsigned id) {
    if (port >= 4) return 0;
    // [analog-stick-from-dpad 2026-08-07] The page ships DIGITAL libretro joypad
    // bits only (g_pad). But GC games move the character with the ANALOG Main
    // Stick (bound to RETRO_DEVICE_ANALOG LEFT X0/Y0), NOT the D-Pad — so digital
    // d-pad presses never move anyone. Synthesize FULL-deflection analog for the
    // left stick from the d-pad bits so keyboard WASD (→ UP/DOWN/LEFT/RIGHT)
    // drives the Main Stick. Sign convention matches Input.cpp AddAxis: RIGHT/DOWN
    // = +0x7FFF, LEFT/UP = -0x8000.
    if (device == RETRO_DEVICE_ANALOG && index == RETRO_DEVICE_INDEX_ANALOG_LEFT) {
        const unsigned base = port * 8;
        auto padbit = [&](unsigned rid) -> int { return (g_pad[base + rid / 8] >> (rid % 8)) & 1; };
        if (id == RETRO_DEVICE_ID_ANALOG_X)
            return padbit(RETRO_DEVICE_ID_JOYPAD_RIGHT) ? 0x7FFF
                 : padbit(RETRO_DEVICE_ID_JOYPAD_LEFT)  ? -0x8000 : 0;
        if (id == RETRO_DEVICE_ID_ANALOG_Y)
            return padbit(RETRO_DEVICE_ID_JOYPAD_DOWN)  ? 0x7FFF
                 : padbit(RETRO_DEVICE_ID_JOYPAD_UP)    ? -0x8000 : 0;
        return 0;
    }
    // [c-stick-from-keys 2026-08-07] The GC C-Stick (RETRO_DEVICE_ANALOG RIGHT) is
    // synthesized from 4 virtual digital bits the page writes at joypad ids 16-19
    // (g_pad byte 2 for port 0): 16=C-up, 17=C-down, 18=C-left, 19=C-right. Keyboard
    // P/L/;/' set these. Same full-deflection + sign convention as the Main Stick.
    if (device == RETRO_DEVICE_ANALOG && index == RETRO_DEVICE_INDEX_ANALOG_RIGHT) {
        const unsigned base = port * 8;
        auto padbit = [&](unsigned rid) -> int { return (g_pad[base + rid / 8] >> (rid % 8)) & 1; };
        if (id == RETRO_DEVICE_ID_ANALOG_X)
            return padbit(19) ? 0x7FFF : padbit(18) ? -0x8000 : 0;   // C-right / C-left
        if (id == RETRO_DEVICE_ID_ANALOG_Y)
            return padbit(17) ? 0x7FFF : padbit(16) ? -0x8000 : 0;   // C-down / C-up
        return 0;
    }
    if (id < 64) {
        unsigned byte = port * 8 + (id / 8);
        if (byte < sizeof(g_pad)) {
            return (g_pad[byte] >> (id % 8)) & 1;
        }
    }
    return 0;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
void* get_pad_ptr(void) { return g_pad; }

// PowerPCState placement-new redirect. Forward-declared instead of #include
// to avoid pulling Core/PowerPC/PowerPC.h into the libretro shim TU.
extern "C" void dolphin_set_ppc_state_external_storage(uint32_t addr);

EMSCRIPTEN_KEEPALIVE
int load_iso(const char* path) {
    // Item 2e.x — set PowerPCState placement-new target BEFORE
    // retro_load_game → BootCore → Core::System::GetInstance() triggers
    // PowerPCManager construction. Under PROXY_TO_PTHREAD the worker-main
    // and proxy-pthread wasm instances have SEPARATE copies of file-static
    // globals (same bug class as g_jit_wasm — see JitWasm.cpp:1525-1535).
    // Setting it from worker_funcs.js's onRuntimeInitialized only affects
    // worker-main's copy; the pthread that actually constructs
    // PowerPCManager reads its own nullptr and falls back to internal
    // storage. By calling here in load_iso (which runs on the pthread,
    // same instance that immediately triggers the singleton), the static
    // IS visible at construction time.
    dolphin_set_ppc_state_external_storage(0x02400000u);
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[worker] load_iso: PowerPCState redirect set on pthread (0x02400000) — entry, path=' + UTF8ToString($0)});
    }, path);
    // [WGPU] Skip the entire WebGL bring-up (canvas register + emscripten_webgl_create_context
    // + recorder overlay) — the WGPU backend makes its own device+surface, this WebGL context
    // is unused for WGPU, and its getContext throws on the OffscreenCanvas we routed to this
    // pthread (now detached from worker-main). The flag lives in the SHARED HEAP (page wrote
    // 'WGPU'=0x57475055 at 0x07FF0100) — read it the same way as the GL descriptor below,
    // because this runs on the proxy-pthread where Module flags / getenv don't reliably
    // propagate but the shared heap does.
    int g_wgpu_mode = EM_ASM_INT({
        var h = Module.HEAPU32 || new Uint32Array(Module.HEAPU8.buffer);
        return (h[0x07FF0100 >> 2] === 0x57475055) ? 1 : 0;
    });
    if (!g_wgpu_mode) {
    // [HW-render path-c FIXED] Register the OffscreenCanvas in GL.offscreenCanvases
    // on the worker-main (where proxyContextToMainThread+OFFSCREEN_FRAMEBUFFER
    // resolves the WebGL2 context). The earlier version never compiled — a bare
    // comma in the object literal split the variadic MAIN_THREAD_EM_ASM macro —
    // so path-c was never actually tested. Build the entry field-by-field to
    // avoid any top-level comma.
    MAIN_THREAD_EM_ASM({
        try {
            if (typeof GL !== 'undefined' && Module.hwOffscreenCanvas
                && !GL.offscreenCanvases['canvas']) {
                var o = {};
                o.offscreenCanvas = Module.hwOffscreenCanvas;
                o.id = 'canvas';
                GL.offscreenCanvases['canvas'] = o;
                postMessage({cmd: 'print', txt: '[worker] GL.offscreenCanvases registered on worker-main'});
            } else {
                postMessage({cmd: 'print', txt: '[worker] GL reg skipped: GL=' + (typeof GL) + ' off=' + (!!Module.hwOffscreenCanvas)});
            }
        } catch (e) {
            postMessage({cmd: 'print', txt: '[worker] GL reg error: ' + e});
        }
    });
    // [FIX#1 render-worker] When the GL descriptor in the SHARED WASM HEAP is
    // present+enabled (page wrote it at GL_DESC_OFF=0x07FF0000, magic 'GLRD',
    // enabled=1), this thread does NOT own the on-screen canvas (the render
    // worker does) and must NOT create a real on-canvas WebGL2 context. Instead
    // install a RECORDING GLctx that streams every draw/state/upload into the
    // heap-embedded ring for the render worker to replay. The descriptor is read
    // from the shared heap (NOT Module.__gcRenderWorker) precisely because THIS
    // code runs on the proxy-pthread where Module flags don't propagate but the
    // shared heap is visible. Default path (descriptor absent) is byte-identical.
    int g_render_worker = EM_ASM_INT({
        var h = Module.HEAPU32 || new Uint32Array(Module.HEAPU8.buffer);
        return (h[0x07FF0000 >> 2] === 0x474C5244 && h[(0x07FF0000 >> 2) + 4] === 1) ? 1 : 0;
    });
    // FIX#1: when render-worker offload is enabled the REAL WebGL2 context is
    // still created below (on the throwaway 1x1 hwOffscreenCanvas the shim set),
    // so Dolphin's get_proc_address resolves against a real emscripten context —
    // skipping creation made boot call_indirect a null function. The RECORDER is
    // then installed as an OVERLAY right after make_current (see just below),
    // diverting draw/state/upload calls to the heap-embedded ring.
    if (g_gl_ctx <= 0) {
        EmscriptenWebGLContextAttributes attrs;
        emscripten_webgl_init_context_attributes(&attrs);
        attrs.majorVersion                 = 2;
        attrs.minorVersion                 = 0;
        attrs.alpha                        = false;
        attrs.depth                        = true;
        attrs.stencil                      = true;
        attrs.antialias                    = false;
        attrs.preserveDrawingBuffer        = false;
        attrs.failIfMajorPerformanceCaveat = false;
        attrs.enableExtensionsByDefault    = true;
        attrs.explicitSwapControl          = true;
        attrs.renderViaOffscreenBackBuffer = true;   // OFFSCREEN_FRAMEBUFFER path
        // [HW-render path-a] The proxied main pthread does not own the canvas
        // (OFFSCREENCANVASES_TO_PTHREAD doesn't reach _emscripten_proxy_main), so
        // proxy context creation + GL to the canvas-owning thread (worker-main),
        // backed by OFFSCREEN_FRAMEBUFFER. FALLBACK proxies only when the canvas
        // isn't local to this thread (which it isn't here).
        attrs.proxyContextToMainThread     = EMSCRIPTEN_WEBGL_CONTEXT_PROXY_FALLBACK;
        g_gl_ctx = emscripten_webgl_create_context("#canvas", &attrs);
        EMSCRIPTEN_RESULT mc =
            (g_gl_ctx > 0) ? emscripten_webgl_make_context_current(g_gl_ctx) : (EMSCRIPTEN_RESULT)-1;
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt: '[worker] WebGL2 ctx (load_iso) handle=' + $0 + ' make_current=' + $1});
        }, (int)g_gl_ctx, (int)mc);
        // FIX#1 render-worker: overlay the recorder on the now-current REAL
        // context. get_proc_address already resolved against it; from here every
        // _glXXX records into the ring for the render worker to replay.
        if (g_render_worker && g_gl_ctx > 0) {
            int ok = EM_ASM_INT({
                return (typeof installGLRecorder === 'function') ? installGLRecorder() : 0;
            });
            MAIN_THREAD_EM_ASM({
                postMessage({cmd: 'print', txt: '[worker] FIX#1 recording GLctx overlay installed=' + $0});
            }, ok);
        }
    }
    } else {
        MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt: '[worker] WGPU mode: WebGL bring-up skipped'}); });
    }
    if (g_loaded) retro_unload_game();
    retro_game_info info{};
    info.path = path;
    info.data = nullptr;
    info.size = 0;
    info.meta = nullptr;
    bool ok = retro_load_game(&info);
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[worker] load_iso: retro_load_game returned ' + ($0 ? 'true' : 'false')});
    }, ok ? 1 : 0);
    if (!ok) return -1;
    // [audio rate 2026-07-17] Report the core's audio output sample rate so the page creates the
    // AudioContext at the matching rate (GC is ~48043 Hz, or ~32029 for 32kHz games — NOT the 44100
    // the page defaulted to). The worklet reads the ring 1:1 with no resampling, so a ctx-vs-source
    // mismatch played audio at the wrong pitch (~9% high at 44100 vs 48043) with rate glitches.
    {
        struct retro_system_av_info _av;
        retro_get_system_av_info(&_av);
        MAIN_THREAD_EM_ASM({ postMessage({cmd: 'audioRate', rate: $0}); },
                           (unsigned)_av.timing.sample_rate);
    }
    retro_set_controller_port_device(0, EMW_RETRO_DEVICE_JOYPAD);
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[worker] SI port 0 = GC controller (joypad)'});
    });
    Libretro::Video::ContextReset();
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[worker] video backend ContextReset done'});
    });
    g_loaded = true;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
void run_iter(void) {
    if (g_loaded) retro_run();
}

// Phase IV gate bit (mirrors gamecube/ppc-worker/sab_layout.h:386).
static constexpr unsigned EW_CT_PHASE4_ENABLE = 1u << 1;

// Item 7 Phase IV: service-only iter. Run when ppc-worker owns PPC
// dispatch. Drains MMIO mirror + pending-writes ring, fires any
// ppc-worker-pre-fired hybrid event cadence into dolphin's CoreTiming
// queue, and lets retro_run() drive the libretro frontend (video_cb /
// audio_*_cb fire when the SW renderer produces a frame). JitWasm::Run
// inside that retro_run will exit on the first downcount<=0 because
// ppc-worker owns downcount under Phase IV — so this call is cheap.

// [ppc-bridge cutover 2026-06-28] Proxied MMIO/HLE exports (defined in
// dolphin_jit_wimports.cpp, same module). The ppc-worker's dispatched boot blocks
// issue SYNCHRONOUS env.ppc_* mailbox round-trips and block in Atomics.wait until
// serviced. retro_run's 4096-iter heartbeat was the only thing giving dolphin a
// turn to service them; under Phase IV (service_iter only) that pump is gone, so
// the first slice hangs. dolphin_drain_mailbox_once services the single-slot SAB
// mailbox (0x02000000) IN-PROCESS on the proxy pthread (valid emulator state) —
// the page->onmessage hop ran the exports on worker-main, thread-isolated under
// PROXY_TO_PTHREAD. Mirrors worker_funcs.js:580-601.
extern "C" {
    uint32_t dolphin_read8(uint32_t);
    uint32_t dolphin_read16(uint32_t);
    uint32_t dolphin_read32(uint32_t);
    void     dolphin_write8(uint32_t, uint32_t);
    void     dolphin_write16(uint32_t, uint32_t);
    void     dolphin_write32(uint32_t, uint32_t);
    uint32_t dolphin_hle_check(uint32_t);
    void     dolphin_interp(uint32_t, uint32_t);
    uint32_t dolphin_check_exc(uint32_t);
    void     dolphin_break_block(uint32_t, uint32_t);
    uint32_t dolphin_hle_fire(uint32_t, uint32_t);
    void     dolphin_gather_drain(uint32_t, uint32_t);
    extern int g_bem_gp_dirty;
}

extern "C" void dolphin_gp_seal();    // [dual-core FIFO splice fix] (dolphin_jit_wimports.cpp)
extern "C" void dolphin_gp_unseal();  // [dual-core FIFO splice fix] (dolphin_jit_wimports.cpp)

// [recomp-render 2026-08-21] Render one GP-FIFO frame emitted by the decomp→wasm recomp
// through Dolphin's EXISTING WGPU backend — no new renderer. `ptr`/`len` point at a
// Dolphin-side host buffer holding the recomp's byte-identical GP-FIFO stream (copied in
// from the recomp module's own linear memory by the JS glue). This is the deterministic
// branch of RunGpuLoopSlice (Fifo.cpp:367-379) minus the CP-ring/guest-RAM round-trip:
// RunFifo<false> self-constructs RunCallback<false>, whose OnCP/OnXF/OnBP/OnPrimitiveCommand
// drive g_main_cp_state + VertexLoaderManager → VertexManagerBase::Flush →
// WGPUVertexManager::DrawCurrentBatch (the live WebGPU draw). Must run on the device thread
// (proxied-main pump) — off it, OnPrimitiveCommand size-skips the draws (OpcodeDecoding.cpp:176).
// [recomp-bridge 2026-08-25] Park the emulated CPU (EmuThread) so the decomp->wasm recomp can
// take over guest RAM + the frame stream. JitWasm::Run's outer loop is gated on
// CPU::State::Running (JitWasm.cpp:557,712,951), so CPUManager::Break() (-> Stepping) stops it
// cleanly at the next block boundary while retro_run keeps pumping the GPU slice + present.
extern "C" EMSCRIPTEN_KEEPALIVE void recomp_pause_cpu(void)
{
  Core::System::GetInstance().GetCPU().Break();
}

// [recomp-bridge 2026-08-25] Explicit present: with the CPU parked, VideoInterface emulation
// (the CoreTiming OutputField events that normally call Video_OutputXFB -> ViSwap -> Present)
// never fires, so recomp EFB->XFB copies pile up unseen. Drive the same call VI would
// (VideoInterface.cpp:914) with the XFB the recomp stream just copied to. 640x480 NTSC frame.
extern "C" EMSCRIPTEN_KEEPALIVE void recomp_present(uint32_t xfb_addr, uint32_t width, uint32_t height)
{
  if (!g_video_backend)
    return;
  static u64 s_fake_ticks = 0;
  s_fake_ticks += 100000;   // strictly-increasing tick for the presenter's frame pacing
  const u32 w = width ? width : 640;
  const u32 h = height ? height : 480;
  // fbStride is in XFB pixels-per-line units like VideoInterface passes (STD*16): for the
  // 640x480 double-strided NTSC field layout that is 2*WPL*16 = 1280 — with 640 the virtual-
  // XFB lookup misses and the presenter falls back to decoding raw RAM (uniform garbage).
  g_video_backend->Video_OutputXFB(xfb_addr, w, 2 * w, h, s_fake_ticks);
}

extern "C" EMSCRIPTEN_KEEPALIVE void recomp_render_fifo(uint32_t ptr, uint32_t len)
{
  if (len == 0 || !g_vertex_manager)
    return;
  u8* p = reinterpret_cast<u8*>(static_cast<uintptr_t>(ptr));
  OpcodeDecoder::RunFifo<false>(DataReader(p, p + len), nullptr);
  g_vertex_manager->Flush();
  if (g_framebuffer_manager)
    g_framebuffer_manager->RefreshPeekCache();
}

// [recomp-debug 2026-08-26] Direct EFB pixel read — settles "did the 3D draws leave
// fragments in the EFB" independent of the XFB copy/present path.
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t recomp_efb_peek(uint32_t x, uint32_t y)
{
  if (!g_framebuffer_manager)
    return 0xDEADDEAD;
  return g_framebuffer_manager->PeekEFBColor(x, y);
}
// [gp-ring STEP 3 2026-07-09 — PERMANENT] Consumer of the worker's WPAR-only Atomics ring
// (producer: ppc_worker.js installWriteEnv gpPush; layout @0x026C0000: +0 head/+4 tail
// monotonic, +8 producer-wait flag, +0xC fallbacks, +0x10 applied, +0x40 data 8192x{width,val}).
// Runs on the dolphin thread, so GPFifo/gather-pipe stay single-threaded (audit constraint).
// Call sites: TOP of dolphin_drain_mailbox_once (ordering: ring applies BEFORE any mailbox op,
// so a guest CP/MMIO read never observes state that excludes its own earlier GX words) + the
// always-runs run_iter_batch body (the branch-gated-drain starvation lesson). Notify after
// consuming (the producer's bounded watermark wait).
static u32 g_cp_read_cooldown = 0;  // [torn HI/LO] suppress the per-iter pump right after a CP-range read
static void dolphin_publish_mmio_mirrors(void);  // defined below service_iter

// [worker-fifo sync 2026-07-21 — the NATIVE-architecture gather pipe, dolphin half] The ppc-worker
// now owns the CPU-FIFO state post-arm (SAB pub block @0x026B2840: +0 armed, +4 base, +8 end,
// +C wp, +14 burstN release-published AFTER the 32B burst bytes land in MEM1, +18 dropped-residual
// count) and writes WGP bursts DIRECTLY into guest memory — native's design (GPFifo.cpp: gather
// buffer + m_fifo_cpu_write_pointer are CPU-thread state; only the burst notification crosses).
// This half adopts the worker's pointer state and replays GatherPipeBursted() once per burst —
// the EXACT native per-burst path (linked-vs-unlinked branch, CPWritePointer lockstep advance,
// hi-watermark ForceExceptionCheck, distance credit, RunGpu kick) with zero reimplementation.
// Called from dolphin_drain_gp_ring's head so it inherits every ordering call site (before ANY
// mailbox op + the service-iter pump), replacing the retired ring's guarantee.
static void dolphin_sync_worker_fifo(void) {
    volatile uint32_t* const pub =
        reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x026B2840u));
    if (__atomic_load_n(const_cast<const uint32_t*>(&pub[0]), __ATOMIC_ACQUIRE) != 1u)
        return;
    auto& system = Core::System::GetInstance();
    auto& processor_interface = system.GetProcessorInterface();
    static uint32_t s_last_burst = 0u;
    const uint32_t bn = __atomic_load_n(const_cast<const uint32_t*>(&pub[5]), __ATOMIC_ACQUIRE);
    uint32_t delta = bn - s_last_burst;
    // Always adopt the worker-owned pointer state (FIFO reg writes update pub without bursts).
    processor_interface.m_fifo_cpu_base = pub[1];
    processor_interface.m_fifo_cpu_end = pub[2];
    if (delta == 0u) {
        processor_interface.m_fifo_cpu_write_pointer = pub[3];
        return;
    }
    s_last_burst = bn;
    if (delta > 65536u) delta = 65536u;   // sanity clamp (would mean ~2MB unsynced)
    auto& cp = system.GetCommandProcessor();
    // [wf same_buffer 2026-07-21] Credit the CP ONLY when the CPU fifo IS the CP fifo. MP4's
    // GPLinkEnable is STALE-1 during display-list builds (the exact trap the GPFifo [dl-fifo fix]
    // documents — it gates on same_buffer, not linked), so replaying GatherPipeBursted for DL
    // bursts credited the CP ~193KB ahead of the actual bytes (probe wfCp: CP wp 0x35aca0 vs
    // worker wp 0x32a840) -> decoder consumed ZEROS -> no PE_FINISH -> gc=33 wedge. Deltas are
    // config-epoch-pure (this sync runs BEFORE every mailbox op, so bursts preceding a base
    // switch are always synced under their own epoch), so the gate is exact per delta.
    {
        auto& fifo_s = cp.GetFifo();
        const bool linked = fifo_s.bFF_GPLinkEnable.load(std::memory_order_relaxed) != 0;
        const bool same_buffer = fifo_s.CPBase.load(std::memory_order_relaxed) == pub[1];
        if (linked && same_buffer) {
            // [direct install 2026-07-21] Do NOT replay GatherPipeBursted (its wp advance relies
            // on CPWritePointer starting in lockstep with the worker wp — FALSE at arm: CP was
            // ~21KB behind PI, so credits landed short and the decoder starved at the gap).
            // Install the truth directly: wp = where the worker's bytes ARE; distance += the
            // credited bursts' bytes exactly. Replicate GatherPipeBursted's side effects
            // (watermark exception pressure, CP status, GPU kick) verbatim.
            fifo_s.CPWritePointer.store(pub[3], std::memory_order_relaxed);
            // Derive distance from the POINTERS (invariant distance == (wp - rp) mod size) —
            // incremental credit would preserve the arm-time CP-vs-PI gap as a permanent
            // decoder short-stop. Safe: the GPU runs on THIS thread (RunGpuOnCpu), rp is not
            // concurrently advancing.
            {
                const uint32_t rp = fifo_s.CPReadPointer.load(std::memory_order_relaxed);
                const uint32_t fb = fifo_s.CPBase.load(std::memory_order_relaxed);
                const uint32_t fe = fifo_s.CPEnd.load(std::memory_order_relaxed);
                int64_t dist = static_cast<int64_t>(pub[3]) - static_cast<int64_t>(rp);
                if (dist < 0)
                    dist += static_cast<int64_t>(fe - fb) + 32;
                fifo_s.CPReadWriteDistance.store(static_cast<uint32_t>(dist),
                                                 std::memory_order_seq_cst);
            }
            if (fifo_s.bFF_HiWatermark.load(std::memory_order_relaxed) != 0)
                system.GetCoreTiming().ForceExceptionCheck(0);
            cp.SetCPStatusFromCPU();
            system.GetFifo().RunGpu();
        }
    }
    // Authoritative worker wp AFTER the replay (linked lockstep lands on the same value; the
    // unlinked/DL branch never touches it — the worker's copy is the only true one).
    processor_interface.m_fifo_cpu_write_pointer = pub[3];
    volatile uint32_t* const n =
        reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x026B285Cu));
    *n = *n + delta;   // total bursts credited (probe wfSyncedBursts)
    // [wf-cp-dbg 2026-07-21 TEMP] CP fifo state per sync @0x026B2860 — diagnose the
    // credit-vs-bytes divergence (wedge face: cpDist=0, peFin never, decoder-reads-zeros class).
    {
        auto& fifo = cp.GetFifo();
        volatile uint32_t* const dbg =
            reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x026B2860u));
        dbg[0] = fifo.CPWritePointer.load(std::memory_order_relaxed);
        dbg[1] = fifo.CPReadPointer.load(std::memory_order_relaxed);
        dbg[2] = fifo.CPReadWriteDistance.load(std::memory_order_relaxed);
        dbg[3] = fifo.CPBase.load(std::memory_order_relaxed);
        dbg[4] = fifo.CPEnd.load(std::memory_order_relaxed);
        dbg[5] = fifo.bFF_GPLinkEnable.load(std::memory_order_relaxed);
        dbg[6] = pub[3];   // worker wp at this sync
    }
}

static void dolphin_drain_gp_ring(void) {
    dolphin_sync_worker_fifo();
    // [mmio-write-fastpath 2026-07-17] Drain the async DSP/AR-DMA MMIO write ring FIRST — before the
    // gp ring's empty early-return and before any mailbox op (same ordering guarantee as the gp ring)
    // — so the guest ISR's DSP_CONTROL ack + AR_DMA-issue writes reach dolphin IN ORDER without a
    // blocking mailbox round-trip. Applying AR_DMA_CNT_L triggers Do_ARAM_DMA; DSP_CONTROL clears the
    // ack. Ring @0x02710000: +0 head, +4 tail, 12-byte {addr,val,width} entries @+0x40, cap 4096.
    // THIS is the throughput fix: native runs the ARAM ARQ-chain 400/s, we managed ~2/s because each
    // of the ~6 register writes per DMA was a round-trip; now they're fire-and-forget.
    {
        volatile uint32_t* const mw_head = reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x02710000u));
        volatile uint32_t* const mw_tail = reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x02710004u));
        uint32_t mt = *mw_tail;
        const uint32_t mh = __atomic_load_n(const_cast<const uint32_t*>(mw_head), __ATOMIC_ACQUIRE);
        uint32_t mn = 0;
        while (mt != mh && mn < 65536u) {
            const uintptr_t slot = 0x02710040u + ((mt & 4095u) * 12u);
            const uint32_t a = *reinterpret_cast<volatile uint32_t*>(slot);
            const uint32_t v = *reinterpret_cast<volatile uint32_t*>(slot + 4u);
            const uint32_t w = *reinterpret_cast<volatile uint32_t*>(slot + 8u);
            if (w == 1u) dolphin_write8(a, v);
            else if (w == 2u) dolphin_write16(a, v);
            else dolphin_write32(a, v);
            ++mt; ++mn;
        }
        if (mn != 0u) {
            __atomic_store_n(const_cast<uint32_t*>(mw_tail), mt, __ATOMIC_RELEASE);
            volatile uint32_t* const p_mwapplied =
                reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x02710008u));
            *p_mwapplied = *p_mwapplied + mn;   // [diag] MMIO writes applied via the fast-path ring
        }
    }
    volatile uint32_t* const p_head = reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x026C0000u));
    volatile uint32_t* const p_tail = reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x026C0004u));
    uint32_t t = *p_tail;
    const uint32_t h = __atomic_load_n(const_cast<const uint32_t*>(p_head), __ATOMIC_ACQUIRE);
    // [dc-diag 2026-07-21 TEMP] GP-ring non-empty => the ppc-worker is producing GX via the ring
    // (guest-on-ppc-worker). If this stays 0 while gpfWrite32>0, the guest runs on dolphin's EmuThread.
    if (t != h) { volatile uint32_t* p = reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x026B1B5Cu)); *p = *p + 1u; }
    if (t == h) return;
    // [domino3 FIX 2026-07-16 — the dropped-GX root, take 2] These ring entries ARE the
    // worker's own legitimate GX (it owns the CPU). GPFifo::Write* no-ops them when
    // g_gp_discard==1 (GPFifo.cpp:162) — and the run_iter_batch clear (line ~916) runs
    // AFTER line-900's drain, so this replay can fire while the seal is still set and drop
    // the whole frame (main thread then sleeps forever in GXWaitDrawDone @queue 0x801d45f4,
    // peFinRaised=0). The seal only exists to drop DOLPHIN's ISR-excursion GX; the worker's
    // replayed stream must never be discarded. Force-clear around the apply loop, restore
    // after (so dolphin's own excursion GX at other times still obeys the seal).
    extern int g_gp_discard;  // global-scope C-linkage var resolves to the same symbol
    const int _saved_discard = g_gp_discard;
    g_gp_discard = 0;
    extern int g_in_drain;    // [domino3-src] tag ring-replay writes vs dolphin's own GP writes
    g_in_drain = 1;
    uint32_t n = 0;
    while (t != h && n < 65536u) {
        const uintptr_t slot = 0x026C0040u + ((t & 8191u) * 8u);
        const uint32_t w = *reinterpret_cast<volatile uint32_t*>(slot);
        const uint32_t v = *reinterpret_cast<volatile uint32_t*>(slot + 4u);
        if (w == 1u) dolphin_write8(0xCC008000u, v);
        else if (w == 2u) dolphin_write16(0xCC008000u, v);
        else dolphin_write32(0xCC008000u, v);
        ++t; ++n;
    }
    g_in_drain = 0;
    g_gp_discard = _saved_discard;
    // [mmio-mirror publish 2026-07-20] publish (incl. the just-advanced FIFO wp) BEFORE the tail
    // RELEASE store so a worker that observes ring-empty also observes the fresh wp mirror.
    dolphin_publish_mmio_mirrors();
    __atomic_store_n(const_cast<uint32_t*>(p_tail), t, __ATOMIC_RELEASE);
    emscripten_atomic_notify(const_cast<uint32_t*>(p_tail), 1);
    // [domino3-bisect 2026-07-16] RELIABLE gpApplied counter @0x026B1A40: total ring
    // entries actually drained+applied to the gather pipe on THIS (dolphin) thread. If
    // this stays 0 while worker gpSent(0x026B1A3C)>0, the worker's GX writes never reach
    // the drain (routing break). If it climbs but peFrames(0x026B0930) stays frozen, the
    // break is downstream (gather->CP->RunGpuOnCpu->SetFinish).
    if (n != 0u) {
        volatile uint32_t* const p_applied =
            reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x026B1A40u));
        *p_applied = (*p_applied + n);
    }
}

static bool dolphin_drain_mailbox_once(void) {
    static const uintptr_t MBX = 0x02000000u;  // single-slot mailbox base (sab_layout)
    volatile uint32_t* const p_req = reinterpret_cast<volatile uint32_t*>(MBX + 12u);
    // [gp-ring] ring applies BEFORE any mailbox op (ordering guarantee — see above).
    dolphin_drain_gp_ring();
    if (__atomic_load_n(p_req, __ATOMIC_ACQUIRE) == 0u) return false;
    // [single-consumer claim 2026-07-10 — PERMANENT, the duplicate-service root] TWO consumers
    // watch this slot: this in-process drain AND the page's _mbxConsume (gamecube.html —
    // waitAsync wake + 20ms sweep, forwarding cmds to dolphin worker-main via 'mbx-cmd').
    // The old check-then-clear here plus the page's never-clear let BOTH service the SAME
    // posted request: the worker unparked on this drain's reply and resumed its slice, then
    // the page's forwarded copy executed LATE on worker-main — a duplicate guest MMIO op.
    // For cmd 6/7 to 0xCC005000/2 that is a duplicate DSP mail HI/LO write (the [LO-dup]/
    // [torn-send] frankenstein mails, same-LR duplicates, lagging guestPc — the armframe-
    // freeze rate); for cmd 2-4 reads of 0xCC005004/6 a duplicate DESTRUCTIVE mail pop.
    // Exactly one consumer may win: CAS-claim req 1->0 and read cmd/args only AFTER the
    // claim (the producer is parked until reply, so slot content is stable). The page
    // consumer claims with the same CAS (gamecube.html _mbxConsume).
    {
        uint32_t expected = 1u;
        if (!__atomic_compare_exchange_n(p_req, &expected, 0u, false,
                                         __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE))
            return false;  // the page consumer claimed this request
    }
    const uint32_t c  = *reinterpret_cast<volatile uint32_t*>(MBX + 0u);
    const uint32_t a0 = *reinterpret_cast<volatile uint32_t*>(MBX + 4u);
    const uint32_t a1 = *reinterpret_cast<volatile uint32_t*>(MBX + 8u);
    // [torn HI/LO fix STEP 3 2026-07-09] a guest 32-bit CP read arrives as TWO 16-bit mailbox
    // round-trips; the per-iter pump between them can advance CPReadPointer/RWDistance and tear
    // the pair (upstream single-core has no such window). On any CP-range read, suppress the
    // next 2 pump iterations so the paired half reads the SAME GPU quantum. (The ComplexRead
    // handlers' own SyncGPUForRegisterAccess still runs inside each read — accuracy preserved.)
    if ((c >= 2u && c <= 4u) && (a0 & 0x0FFFFF00u) == 0x0C000000u)
        g_cp_read_cooldown = 2u;
    uint32_t r = 0u;
    switch (c) {
        case 2:   r = dolphin_read8(a0);  break;
        case 3:   r = dolphin_read16(a0); break;
        case 4:   r = dolphin_read32(a0); break;
        case 5:   dolphin_write8(a0, a1);  break;
        case 6:   dolphin_write16(a0, a1); break;
        case 7:   dolphin_write32(a0, a1); break;
        case 8:   r = dolphin_hle_check(a0); break;
        case 9:   dolphin_interp(a0, a1); break;
        case 10:  r = dolphin_check_exc(a0); break;
        case 11:  dolphin_break_block(a0, a1); break;
        case 12:  r = 0u; break;  // dolphin_read_tb unimplemented (page path returns 0)
        case 14:  r = dolphin_hle_fire(a0, a1); break;
        case 100: r = 0xCAFEBABEu; break;  // routing-live probe
        default:  r = 0u; break;
    }
    *reinterpret_cast<volatile uint32_t*>(MBX + 16u) = r;  // reply
    volatile uint32_t* const p_rr = reinterpret_cast<volatile uint32_t*>(MBX + 20u);
    __atomic_store_n(p_rr, 1u, __ATOMIC_RELEASE);
    emscripten_atomic_notify(const_cast<uint32_t*>(p_rr), 1);
    return true;
}

EMSCRIPTEN_KEEPALIVE
// [mmio-mirror publish 2026-07-20] SAB mirror block @0x026B2800 for the hottest ACTIVE-state
// guest MMIO reads (measured post-round-trip-elimination: VI DI0-3 19K/120s, PE_CTRL 19K,
// PE_TOKEN 12K, VI 0x6C 5K, PI FIFO wp/base/end 6K). All are DirectRead registers (VideoInterface
// .cpp:346+, PixelEngine.cpp:131/154, ProcessorInterface FIFO vars) so the publish is ~10 plain
// loads per service iter. The worker serves reads from these cells with WRITE-DIRTY invalidation
// (a guest write marks the cell stale until the next publish seq — preserves ISR ack semantics)
// and a ring-empty guard on the FIFO regs (this fn is also called at drain-end BEFORE the tail
// RELEASE store, so ring-empty => wp fresh => the wgp-order program-order guarantee holds).
// NOTE the 2026-07-03 mirror16 experiment (below, disabled) measured a NET LOSS because the
// mailbox exits were then load-bearing for dolphin's advance cadence; its stated precondition
// "worker-local event advance" EXISTS now (CT_PHASE3, 2026-07-18) and this session's round-trip
// eliminations sped the system up monotonically (gc/s 2.5 -> 41) with no cadence collapse.
// Layout (u32 cells): +0 VI2030 +4 VI2034 +8 VI2038 +C VI203C +10 VI206C +14 PE_CTRL +18 PE_TOKEN
// +1C PI3014(wp) +20 PI300C(base) +24 PI3010(end) +28 publish-seq.
static void dolphin_publish_mmio_mirrors(void) {
    // [boot-flood fix 2026-07-21] Publish ONLY post-takeover (cpu_owner==1). Publishing from
    // page-load onward read these MMIO regs while the guest was still in the IPL (PC 0x900,
    // mappings unresolvable) -> "Suppressed popup: Unable to resolve read address" x ~480/s
    // flooding the browser console/main thread (live page froze at the Nintendo logo, FPS 13.7;
    // probe logs: 4.8K baseline warnings -> 52-58K with the unconditional publish). The serve
    // side is owner-gated anyway, so pre-takeover publishing had zero value.
    if (*reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x026A0000u)) != 1u)
        return;
    // [phys-mmio fix 2026-07-21] Read via the MMIO mapping with PHYSICAL addresses, NOT
    // dolphin_read32 (= MMU().Read<u32>(EA)): the EA path depends on the guest's MOMENTARY
    // translation state — whenever ppc_state is in an exception window (MSR.DR=0, e.g. the
    // 0x900 DEC vector) EA 0xCCxxxxxx fails ("Unable to resolve read address ... PC 900",
    // ~4.8K/reg/120s console flood that froze the live page) and RETURNS 0 — so the published
    // cells were intermittently ZEROS (also the real cause of the wp=0 DLBuf overflow when the
    // FIFO regs were mirror-served). The MMIO mapping read is state-independent.
    auto& system = Core::System::GetInstance();
    MMIO::Mapping* const mmio = system.GetMemory().GetMMIOMapping();
    if (!mmio)
        return;
    volatile uint32_t* const mir = reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x026B2800u));
    const auto rd32 = [&](u32 pa) -> uint32_t {
        return (static_cast<uint32_t>(mmio->Read<u16>(system, pa)) << 16) |
               mmio->Read<u16>(system, pa + 2u);
    };
    mir[0] = rd32(0x0C002030u);
    mir[1] = rd32(0x0C002034u);
    mir[2] = rd32(0x0C002038u);
    mir[3] = rd32(0x0C00203Cu);
    mir[4] = rd32(0x0C00206Cu);
    mir[5] = mmio->Read<u16>(system, 0x0C00100Au);
    mir[6] = mmio->Read<u16>(system, 0x0C00100Eu);
    mir[7] = mmio->Read<u32>(system, 0x0C003014u);
    mir[8] = mmio->Read<u32>(system, 0x0C00300Cu);
    mir[9] = mmio->Read<u32>(system, 0x0C003010u);
    // [wf-arm gate 2026-07-21] publish dolphin's pending gather-pipe byte count @0x026B28B0:
    // arming the worker-fifo while dolphin's gather holds a PARTIAL burst would lose those
    // bytes AND misphase the fifo stream by <32B forever (the garbage-draw 5735x5735 class).
    // The worker's tryArm refuses to arm until this reads 0.
    {
        auto& ppcs = system.GetPPCState();
        *reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x026B28B0u)) =
            (uint32_t)(ppcs.gather_pipe_ptr - ppcs.gather_pipe_base_ptr);
    }
    const uint32_t s = mir[10];
    __atomic_store_n(const_cast<uint32_t*>(&mir[10]), s + 1u, __ATOMIC_RELEASE);
}

void dolphin_service_iter(void) {
    if (!g_loaded) return;
    dolphin_publish_mmio_mirrors();
    // [ppc-bridge cutover] Drain the worker's pending env.ppc_* mailbox round-trips
    // in-process FIRST (the pump retro_run used to provide). Runs every call,
    // including during a worker slice (yield set), because the worker BLOCKS until
    // each call is serviced. Bounded so a runaway burst can't starve Advance.
    for (int _md = 0; _md < 256 && dolphin_drain_mailbox_once(); ++_md) {}
    // 1. Pull ppc-worker DIRECT_W mirror writes back into dolphin's
    //    struct, then drain the pending-writes ring (replays
    //    ComplexWrite handlers, which may schedule CoreTiming events).
    // [mmio-mirror16 2026-07-03 — census-driven] Fresh minimal 16-bit READ mirror for the
    // status registers the guest polls hottest (mbx-census: 1.17M read16 round-trips/run,
    // 100% at 0xCC0050xx/0xCC0020xx — DSP_CONTROL, ARAM-DMA, VI). Poll-push model: each
    // service iter re-reads the real registers via MMU (side-effect-free status regs ONLY —
    // mailbox LO pops mail and is deliberately NOT mirrored) and refreshes the SAB mirror
    // the JIT's emit_mmio_mirror_else_or_import arm reads directly. Class tables enable
    // per-register; everything else still routes to the import. Layout per gekko_emit.cpp
    // :490-496 (mirror @0x02600000, cls16 @0x02640000, rel = EA - 0xCC000000).
    if (false) {  // [mmio-mirror16 DISABLED 2026-07-03: measured NET LOSS — retired 17-31M -> 7M.
                  //  The poll-loop mailbox exits were load-bearing for the dolphin-advance cadence;
                  //  re-enable only with worker-local event advance. Census-verified the mirror
                  //  itself works (read16 1.17M -> 0).]
        static const uint32_t kMirror16[] = {
            0xCC00500Au,                                          // DSP_CONTROL
            0xCC005020u, 0xCC005022u, 0xCC005024u, 0xCC005026u,   // AR_DMA MMADDR/ARADDR
            0xCC005028u, 0xCC00502Au,                             // AR_DMA_CNT
            0xCC002000u, 0xCC002002u,                             // VI vertical timing
            0xCC00202Cu, 0xCC00202Eu,                             // VI half-line (VIGetRetraceCount adj)
            0xCC002030u, 0xCC002032u, 0xCC002034u, 0xCC002036u,   // VI DI0/DI1
            0xCC002038u, 0xCC00203Au, 0xCC00203Cu, 0xCC00203Eu,   // VI DI2/DI3
        };
        static bool cls_init = false;
        auto& mmu = Core::System::GetInstance().GetMMU();
        if (!cls_init) {
            cls_init = true;
            for (uint32_t ea : kMirror16) {
                const uint32_t rel = ea - 0xCC000000u;
                *reinterpret_cast<volatile uint8_t*>(
                    static_cast<uintptr_t>(0x02640000u + (rel >> 1))) = 1u;  // DIRECT_RW
            }
        }
        for (uint32_t ea : kMirror16) {
            const uint32_t rel = ea - 0xCC000000u;
            const uint16_t v = mmu.Read<u16>(ea);
            *reinterpret_cast<volatile uint16_t*>(
                static_cast<uintptr_t>(0x02600000u + rel)) = v;
        }
    }
    // 2. Fire hybrid events whose cadence ppc-worker already advanced.
    //    Dolphin's local m_event_queue still holds these entries — the
    //    pending mask is a latency short-cut, not a replacement, so the
    //    eventual local fire stays idempotent.
    {
        auto& system = Core::System::GetInstance();
        const unsigned mask = dolphin_ct_drain_pending_mask();
        if (mask != 0u) {
            auto& core_timing = system.GetCoreTiming();
            auto& timers = system.GetSystemTimers();
            auto sched_now = [&](CoreTiming::EventType* et) {
                if (et) core_timing.ScheduleEvent(0, et);
            };
            // Pending-mask bit layout matches bemental_ct::CT_PEND_* in JitWasm.cpp.
            // Note: the GetVIEvent / GetDSPEvent / GetAudioDMAEvent /
            // GetGPUSleeperEvent / GetPatchEngineEvent accessors on
            // SystemTimersManager were custom additions in the prior fork's
            // dolphin-src patches; they are not present in the sanitized
            // upstream tree (df03d80). Re-introducing them is canonical work
            // (subclass + override in dolphin-bridge, or a tracked upstream
            // PR) — out of scope for the initial JIT-swap link milestone.
            // For now the cross-module CT publish/drain is a no-op and the
            // events fire from dolphin's own SystemTimers cadence.
            (void)mask; (void)timers; (void)sched_now;
        }
    }
    // 3. Advance CoreTiming DIRECTLY (NOT via retro_run, so dolphin's own
    //    JitWasm::Run does not also dispatch — only the event queue is
    //    processed). While the ppc-worker owns PPC dispatch, dolphin's VI/PI/
    //    DSP scheduled events would otherwise never fire. Advancing them here
    //    raises EXCEPTION_EXTERNAL_INT into the SHARED ppc_state (now that
    //    &ppc_state is wired into the SAB) on VI vblank, which wakes the guest
    //    from EE-enabled wait-spins (e.g. 0x800ba2f0). The ppc-worker observes
    //    Exceptions!=0, exits PPC_SLICE_EXIT_EXCEPTION, and the page clears the
    //    yield flag so dolphin vectors the interrupt (CheckExternalExceptions).
    //    [ppc-bridge IRQ delivery 2026-06-28]
    auto& core_timing = Core::System::GetInstance().GetCoreTiming();
    // [ppc-bridge cutover] Only advance CoreTiming in dolphin's EXCLUSIVE window
    // (yield flag clear). During a worker slice (yield set) Advance refills
    // ppc_state.downcount (CoreTiming.cpp:381), fighting the worker's primed 20000
    // and erasing its downcount-exhausted exit. The mailbox drain above still runs
    // every call, so the worker is serviced mid-slice regardless of the yield flag.
    {
        // [fire-only advance 2026-07-03] Advance now runs UNCONDITIONALLY — during worker
        // slices it is fire-only (CoreTiming.cpp guards cycle credit + downcount refill by
        // cpu_owner), so sim-time events (ARAM-DMA, VI, DSP) fire while the worker executes.
        core_timing.Advance();
    }
    // [gpu-pump 2026-07-03 — THE boot finish line] Post-handover NOTHING pumps the GPU
    // FIFO ([ax-fifo] SyncGPUCallback: ZERO fires across a full stalled run), so
    // BPMEM_SETDRAWDONE is never processed, PixelEngine::SetFinish never raises PE_FINISH,
    // and main() sleeps forever at main->HuSysDoneRender->GXDrawDone->OSSleepThread
    // (thread-walk backtrace, queue 0x801d45f4). Pump whenever the CP FIFO holds data:
    // SyncGPUForRegisterAccess -> RunGpuOnCpu processes commands on THIS pthread (the WGPU
    // backend already renders here for the boot frames).
    {
        auto& system2 = Core::System::GetInstance();
        // [unconditional pump 2026-07-07] dist>0 rarely fires (CP consumes as fast as the
        // gather bursts → cpDist=0), so a frame's SETDRAWDONE could sit unprocessed →
        // finish never pending → flush no-op → wedge at that frame. Pump every iter so the
        // FIFO always drains and every frame's draw completes.
        {
            // [torn HI/LO fix STEP 3] skip the pump during a CP-read-pair cooldown so a guest
            // lhz/lhz 32-bit CP read can't be torn by CP state advancing between its halves.
            if (g_cp_read_cooldown > 0u) {
                --g_cp_read_cooldown;
            } else {
                system2.GetFifo().SyncGPUForRegisterAccess();
            }
        }
        // [workarounds REMOVED 2026-07-08 Step 2] The PE-finish flush [19], DSP force-tick
        // [22], and VI 8x-per-iter beam force [23] were all manual compensations for ONE
        // defect: global_timer was non-monotonic (the one-clock rebase rewound it), so no
        // CoreTiming event ever came due and VI/DSP/PE never fired on their own. That defect
        // is now fixed at the source (CoreTiming.cpp gt-monotonic fix-a: cyclesExecuted clamp
        // + adopt only-advance; gt-DEC dropped 12→1). Device events fire NATIVELY off the
        // (now monotonic) global_timer via the fire-only Advance event loop — the forced
        // ticks delivered events at arbitrary instants (the FP-storm / SI-reentrancy class)
        // and are deleted. Verify: evFired climbs, frames reach ≥100 without them.
    }

    // [ppc-bridge idle fast-forward 2026-06-28] Under Phase IV the ppc-worker
    // owns dispatch, so JitWasm::Run's idle-skip (JitWasm.cpp:264-394) never
    // runs. When the guest parks in an EE-enabled wait-spin (e.g. MP4
    // VIWaitForRetrace 0x800ba2f0), a single Advance() only moves global_timer by
    // one MAX_SLICE (20000 cyc); the awaited VI event is ~8M cycles out, and one
    // Advance per cross-worker round-trip (~60ms) takes ~24s -> the guest never
    // wakes (video_cb=0). Native crosses the gap via a fast in-loop Advance(); we
    // do the same here, in-process, when the page flags the idle streak (same
    // lastPc across slices) at CT_QUEUE+0x30. Force downcount=0 each iter so
    // Advance burns a full slice; stop as soon as an event raises a guest
    // exception (VI/PI -> EXTERNAL_INT; the worker then vectors it), a cap, or the
    // ppc-worker re-engaging (yield flag set). Gated on yield-flag==0 so it only
    // runs in dolphin's exclusive window and never races the ppc-worker on
    // downcount. Fields via the SAB-published real &ppc_state (ctx at 0x0250002C;
    // OFFSET_EXC=0x2EC, OFFSET_DOWNCOUNT=0x2F0 per ppc_worker.js:646-649).
    {
        const uint32_t ctx =
            *reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x0250002Cu));
        const uint32_t idle_hint =
            *reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x02680030u));
        // NOTE (2026-06-30): the old `*yield_flag == 0u` guard here meant this NEVER ran during an idle
        // spin — the worker runs slices back-to-back so yield_flag is always SET, so CoreTiming never
        // advanced to the pending VI event and the guest hung at VIWaitForRetrace forever (ff-diag:
        // yieldFlag=1, ran=0). The guard exists to avoid Advance fighting a PRODUCTIVE worker slice's
        // downcount — but idle_hint is set only when the worker is provably spinning (no progress), so
        // advancing is safe (the worker cooperatively exits on downcount<=0 / exc). Gate on idle_hint
        // alone. [Proper fix is PRIORITY 3: the worker should yield on idle so this window opens naturally.]
        // [ff-pc gate 2026-07-02, supersedes the EE-only attempt] Fast-forward ONLY while the guest
        // is AT the observed spin PC (page publishes it at 0x02680034 with the hint). The EE=1 gate
        // was insufficient: the retrace handler's audio sub-chain re-enables EE mid-chain
        // (hwIRQLeaveCritical -> OSEnableInterrupts, MP4 0x801125b4/0x800b7250), and the idle-hint
        // PC-ring stays saturated during idle phases, so the ff loop teleported the NEXT VI event to
        // those EE=1 blips — vec-ring: alternating [idle-spin 0x800ba2f0 EE=1] / [OSEnableInterrupts
        // +0xc EE=1 r1=0x8019d450] deliveries, n~4676 — nesting a fresh retrace into the live handler
        // chain. PadReadVSync re-entered PADRead; its data[2] write trampled the outer SIGetType's
        // saved callback (0x8019d3e4 -> 0x808080 = the SI crash). Native cadence can never nest a
        // 60Hz retrace inside a us-scale handler. pc==hintPc keeps every protected case working:
        // single-PC spins match directly; the DVD multi-PC poll cycle passes through the sampled PC
        // every iteration (including its EE=0 sections, which this predicate deliberately permits).
        const uint32_t hint_pc =
            *reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x02680034u));
        const uint32_t pc_now = (ctx != 0u)
            ? *reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(ctx + 0x000u))
            : 0u;
        // [ff re-enabled under owner 2026-07-07] the exc=0-at-idle-spin wedge (guest waits
        // for a device completion that never becomes a pending interrupt under worker
        // ownership — measured: piCause has no PE_FINISH, exc=0, frames pinned). The ff
        // excursion advances time and fires due CoreTiming events until one raises a guest
        // exception — exactly what crosses the gap. Runs REGARDLESS of owner now; the
        // one-clock conflict (ff inflates dolphin's timer, gt-adopt pulls it back, undoing
        // the gap-cross) is resolved by syncing the WORKER gt to the ff-advanced time at
        // the end (below), so the cross sticks.
        // [dual-core ff-hint 2026-07-17] When the WORKER owns the CPU (cpu_owner @0x026A0000 == 1) it
        // sets idle_hint ITSELF only when its own multi-PC loop detector (__lwN) proves a device-wait
        // busy-spin (e.g. HuARDMACheck 0x80049488 waiting on the ARAM DMA completion). Trust that: the
        // `pc_now == hint_pc` gate reads the guest PC from the SAB mirror (0x2400000), which doesn't
        // reliably reflect a fast 3-PC worker loop, so the ff never fired post-collapse (ffEnter=0,
        // aramComplete=7 vs native 1992, gc wedged at 33). Drop the strict PC match under worker
        // ownership; keep it pre-collapse (page-driven hint) so the SI-crash teleport guard still holds.
        const uint32_t ff_cpu_owner =
            *reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x026A0000u));
        if (ctx != 0u && idle_hint != 0u && hint_pc != 0u
            && (pc_now == hint_pc || ff_cpu_owner == 1u))
        {
            volatile int32_t* const dc =
                reinterpret_cast<volatile int32_t*>(static_cast<uintptr_t>(ctx + 0x2F0u));
            volatile uint32_t* const exc =
                reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(ctx + 0x2ECu));
            // Advance time so the device event the idle guest is waiting on (DI/ARAM
            // completion, VI retrace) actually fires. Stop ONLY on a DELIVERABLE
            // interrupt (exc set AND MSR.EE) so the worker can vector it. A HELD
            // external int (exc=0x4, EE=0) must NOT stop us — the guest can't take
            // it yet and is polling a device/memory state that only changes if we
            // keep advancing. Cap bounds the per-window fast-forward.
            // [2026-06-30 H2 fix] Deliver ONE event at a time: break the instant ANY NEW exception bit
            // appears (vs the old "keep advancing until a deliverable EXTERNAL_INT", which let the
            // DECREMENTER + other CoreTiming events pile up into a burst — exc=0x5 = EXTERNAL_INT|DEC —
            // that the guest can't handle -> __OSUnhandledException -> PPCHalt). Advancing to the next
            // event, firing it, and stopping lets the guest's ISR run and re-arm before the next event,
            // matching native's natural one-at-a-time cadence.
            // [ff-restore 2026-07-02] The one-event fix's `exc0 == 0` entry gate made the ff
            // PERMANENTLY INERT (browser ff-diag: ran=135M lastAdvances=0 excAfter=0x1 — a DEC is
            // pending nearly always at the idle spin), so sim-time crawled (~32k ticks/s), VI never
            // fired, and the guest froze at VIWaitForRetrace (Hudson logo). The teleport hazard that
            // gate guarded against (events fired into a live handler chain corrupting SI state) is
            // now fixed at its TRUE root — the async write ring (store->load ordering) is off.
            // Restore the original semantics with two guards: advance until the pending-exception
            // SET CHANGES (a newly-raised event, e.g. DEC-pending 0x1 -> VI makes it 0x5) or the
            // guest LEAVES the hinted idle PC (it took an interrupt / made progress).
            volatile uint32_t* const pc_live =
                reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(ctx + 0x000u));
            const uint32_t exc0 = *exc;
            // [ff-credit flag 2026-07-03] The fire-only Advance credits 0 cycles while the
            // worker owns the CPU — correct for the concurrent service-iter Advance, but the
            // ff excursion EXISTS to cross event gaps via dc=0 full-slice credits. Flag the
            // excursion (SAB 0x026A0008) so CoreTiming grants normal credit inside it.
            volatile uint32_t* const ff_flag =
                reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x026A0008u));
            // [ff 2026-07-07 — restored to the known-good 1024 burst after the pace A/B]
            // NOTE (2026-07-10): pacing this loop to native rate (wall-clock budget) CORRECTLY
            // unstarves the prio-16 render thread (wpc moves from audio -> GXCopyDisp), proving
            // this ff burst's sim-time over-drive (3.75-7.5x native) is the render-starvation
            // root. BUT the ff is ALSO the sole pump for dolphin's VI/DEC events while the
            // worker is idle; once paced, when the render thread leaves the idle spin it parks
            // on its GXCopyDisp WPAR store (gather-ring-full -> unbounded mailbox wait) and
            // NOTHING pumps events -> harder freeze, audio dead. The real fix is COUPLED: pace
            // the ff AND make the render thread's WPAR store non-blocking (fire-and-forget ring,
            // never a bounded/unbounded mailbox stall) AND keep dolphin's event pump alive at
            // native rate while the worker executes a real slice. Reverted to 1024-burst until
            // that coupled fix lands (this state at least keeps audio + guest alive).
            // [mmio-write-fastpath ORDERING 2026-07-17] Apply any pending async DSP/AR_DMA writes the
            // guest just posted in its ISR (the DMA-issue for the NEXT ARQ chunk) BEFORE the ff advances
            // time — otherwise Do_ARAM_DMA runs against an already-advanced global_timer and schedules
            // the completion far in the future, so it never fires (aramComplete=0). Draining here means
            // the DMA is issued + its completion scheduled at the current sim-time, then the ff crosses
            // to it and fires it. dolphin_drain_gp_ring drains the MMIO ring first (its own early-return
            // only guards the GX ring), so this is cheap when the GX ring is empty (the audio phase).
            dolphin_drain_gp_ring();
            // [determinism 2026-07-17] Deterministic idle-gap cross. The old body was a
            // for(k<1024){*dc=0; Advance(); if(*exc!=exc0)break; if(*pc_live!=hint_pc)break;}
            // burst whose trip count K was set by two reads of *exc/*pc_live that the CPU worker
            // MUTATES CONCURRENTLY — so two identical runs crossed a DIFFERENT amount of sim-time,
            // and every device event scheduled at global_timer+delta fired at a different absolute
            // time (verified rank-1 root of the GlobalCounter=33 A/B nondeterminism: two runs wedge
            // at different guest PC/MSR). Replace with a SINGLE skip to the exact next scheduled
            // hybrid-event boundary — the crossed sim-time is now a pure function of the event
            // queue, matching native's one-event-at-a-time cadence. The CPU worker still fires its
            // own pure/DEC events; dolphin's regular per-iter fire-only Advance (line ~700) keeps
            // firing hybrids at the adopted gt between excursions.
            (void)dc; (void)exc0; (void)pc_live; (void)ff_flag;
            // [ff-burst-deterministic 2026-07-18] The single skip-to-FirstEventTime advanced ONE
            // event per service_iter — but the FRONT event is the 4kHz audio-buffer tick (~8000 cyc),
            // so sim-time crawled ~0.5% real-time and the 60Hz VI retrace that VIWaitForRetrace needs
            // fired ~1/15s -> GlobalCounter stuck near 12 (measured ffAdvN=40107 events over 120s yet
            // retraceCount frozen at 50). BURST through the non-interrupting audio events to the next
            // EXT-raising boundary in ONE excursion (native crosses idle gaps with a fast in-loop
            // Advance), but STOP on the DETERMINISTIC signal — the EXTERNAL_INT bit (0x4) becoming set
            // by a fired VI/DSP event — NOT the *pc_live race that made the old 1024-burst nondet.
            // During an idle spin the CPU worker does not set EXT, so *exc changes ONLY from the events
            // fired here = a pure function of the event queue = deterministic trip count.
            {
                for (int k = 0; k < 4096; ++k)
                {
                    if ((*exc & 0x4u) != 0u) break;                    // deliverable device IRQ pending -> stop
                    const s64 t = core_timing.FirstEventTime();
                    if (t < 0) break;                                 // event queue empty
                    if (t <= static_cast<s64>(core_timing.GetTicks())) core_timing.Advance();
                    else core_timing.FfAdvanceTo(t);
                }
                // Publish the crossed time to the WORKER gt cells (its idle logic + the next gt-adopt
                // read it). Plain write; the gt-adopt READ is seqlocked so a concurrent worker write
                // can't tear it into the monotonic-max.
                const u64 dgt = static_cast<u64>(core_timing.GetTicks());
                *reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x02680008u)) =
                    static_cast<uint32_t>(dgt & 0xFFFFFFFFu);
                *reinterpret_cast<volatile uint32_t*>(static_cast<uintptr_t>(0x0268000Cu)) =
                    static_cast<uint32_t>((dgt >> 32) & 0xFFFFFFFFu);
            }
        }
    }
    // [present-pump 2026-07-04] The comment at the top of this file's Phase IV section
    // promises retro_run() drives video_cb — the body never called it, so post-takeover
    // the canvas froze on the last boot-era frame while [ax-pe] guest frames completed
    // at speed (user-visible 'frozen at hudson logo' with FPS 47.0 = the page redrawing
    // a stale texture). Call it at a bounded cadence; JitWasm::Run inside exits on the
    // first downcount<=0 because the worker owns downcount — cheap by design.
    {
        // [present-pump 2026-07-12] Present at a wall-clock ~60Hz cadence, NOT every
        // 4096th service-iter. The old (++s_pp & 0xFFF) gate throttled video_cb to a
        // fixed ~1/4096 of the service-iter rate — ~4fps on the display regardless of
        // how fast the guest renders (measured: guest completed ~15-20 peFrames/s but
        // only ~4 presented, a 5:1 drop). retro_run post-takeover is cheap (JitWasm::Run
        // exits on the first downcount<=0 since the worker owns downcount), so gating on
        // real elapsed wall-time gives native's VBlank display cadence instead of a
        // service-iter-rate-dependent throttle.
        static double s_last_present_ms = 0.0;
        const double now_ms = emscripten_get_now();
        if (g_loaded && (now_ms - s_last_present_ms) >= 16.0) {
            s_last_present_ms = now_ms;
            retro_run();
        }
    }
}

// Drain N retro_run slices in one call. Amortizes the JS↔WASM (and
// PROXY_TO_PTHREAD) round-trip cost across the whole batch instead of
// per-slice. Caller picks N to balance throughput against responsiveness
// (large N = better dispatch rate but worse input latency).
//
// Phase IV: when CT_PHASE4_ENABLE is set, route to dolphin_service_iter
// instead of retro_run. Gate is a single u32 atomic-load + AND so the
// non-Phase-IV hot path pays only ~ns overhead. Per-iter check lets the
// page flip Phase IV on/off without restarting the loop.
EMSCRIPTEN_KEEPALIVE
void run_iter_batch(int n) {
    if (!g_loaded) return;
    // ENTIRE SAB HLE patch set per native dolphin.log:
    //   [HLE]: Patching PPCMfhid2 0x800e34a4
    //   [HLE]: Patching PPCMfhid2 0x800e34ac
    //   [HLE]: Patching PPCMfhid2 0x800e34e0
    //   [HLE]: Patching strncpy   0x8010dfb4
    //   [HLE]: Patching OSReport  0x800e5bf0
    //   [HLE]: Patching ___blank  0x800ecfa4
    //   [HLE]: Patching ___blank  0x800fe3c0
    // OSReport and ___blank are already in upstream HLE.cpp's os_patches
    // (lines 42, 56) bound to HLE_OS::HLE_GeneralDebugPrint. PPCMfhid2
    // and strncpy are NOT in libretro/dolphin@0cd3bb8's table — we added
    // them in HLE.cpp + HLE_Misc.cpp (authored canonically, replacement
    // semantics matching upstream Dolphin master).
    //
    // Native installs via PPCSymbolDB name lookup (LoadMapOnBoot +
    // HLE::Reload→PatchFunctions). Our tools/gsne8p.map carries the
    // CodeWarrior names (DBPrintf instead of ___blank, PPCMfhid0/
    // PPCMfl2cr at the first two PPCMfhid2 addresses), so the name-
    // based lookup misses. Install at the empirically-verified addresses.
    //
    // Timing: install AFTER the first retro_run completes. By then
    // libretro Main.cpp's EmuThread→BootUp→OnTitleDirectlyBooted→
    // HLE::Reload has fired (and cleared all non-Fixed hooks). Once
    // installed here, no further Reload fires during normal boot, so
    // the patches persist.
    static bool s_sab_patches_installed = false;
    for (int i = 0; i < n; i++) {
        const unsigned flags = dolphin_ct_get_phase_flags();
        // [single-ordered-GX 2026-07-16] The Phase-IV-edge seal (dolphin_gp_seal/unseal on the
        // ISR-excursion transition) is RETIRED. It was fragile: it toggled g_gp_discard on a
        // coarse phase edge and the owner-clear below then dropped it for whole iterations, leaving
        // a window where dolphin's excursion GX spliced the worker's ring stream (the torn
        // GXLoadPosMtxImm -> SETDRAWDONE never decoded -> peFrames frozen at armframe). The reject
        // is now STRUCTURAL and always-current at the write site (GPFifo::Write* gate on
        // cpu_owner==1 && g_in_drain==0). No edge tracking, no owner-clear race. Boot single-core
        // (cpu_owner==0) is unaffected. See GPFifo.cpp gpfifo_reject_non_ring_gx().
        // [unconditional drain 2026-07-07 — deadlock root fix] The mailbox drain lived
        // ONLY in the service_iter branch; with the Phase-IV flag clear the retro_run
        // branch never drained, so a worker parked in a synchronous MMIO call starved
        // FOREVER (measured: mbx=4/0x80000000 reqReady=1 pinned, worker pc-ring frozen
        // at 0x800b4338, guest at msr=0x1030 exc=0x5). Drain in BOTH branches — a no-op
        // (single atomic load) when the slot is empty.
        for (int _md = 0; _md < 256 && dolphin_drain_mailbox_once(); ++_md) {}
        // [gp-drain post-takeover 2026-07-07 — THE healthy-face frame stall] the gather
        // drain was a BLOCK-EXIT wimport called only by dolphin's parked dispatch loop:
        // worker GP writes set g_bem_gp_dirty (dolphin_jit_wimports.cpp:109) but nothing
        // drained the gather buffer to the FIFO — measured cpDist=0/cpPumps=48-static
        // while the guest slept in GXWaitDrawDone. Drain here, the path that always runs.
        // [single-ordered-GX 2026-07-16] The owner-clear of g_gp_discard is RETIRED along with the
        // Phase-IV-edge seal above: g_gp_discard is no longer toggled post-takeover (it retains
        // only its original boot-era single-core meaning, which stays 0 here). The excursion drop
        // is enforced structurally at GPFifo::Write* (gpfifo_reject_non_ring_gx), so nothing needs
        // to clear a seal per-iteration.
        // [restructure gather-ownership 2026-07-22] The gather pipe is CPU-thread-private in
        // native (buffer + cursor live in ppc_state: GPFifo::FastWrite* / UpdateGatherPipe).
        // This proxy-main drain was the OLD architecture's flush (worker ring -> parked
        // dolphin thread). Under the restructure the EmuThread produces AND flushes at block
        // epilogues, and a concurrent proxy-main UpdateGatherPipe races the shared cursor
        // byte-granularly (caught by the cmd-ring: a BP load's 0x61 opcode byte deleted
        // mid-stream -> decoder walked vertex floats -> SAB SEGA-logo / MP4 board wedges).
        // Drain here ONLY in takeover mode (cpu_owner==1); otherwise leave g_bem_gp_dirty
        // alone — clearing it here steals the EmuThread epilogue's pending flag and
        // suppresses its own drain (a second byte-loss mode).
        if (g_bem_gp_dirty &&
            *reinterpret_cast<volatile unsigned*>(static_cast<uintptr_t>(0x026A0000u)) == 1u) {
            g_bem_gp_dirty = 0;
            dolphin_gather_drain(0u, 0u);
        }
        // [one-clock rebase, owner-edge 2026-07-07] the JitWasm placement was UNREACHABLE
        // (owner-check returned first — zero '[one-clock] rebased' prints in any log), so
        // pre-takeover events (frame ~101's PE_FINISH wake among them) stayed stranded in
        // the old time domain: guest slept in GXWaitDrawDone forever (cpPumps frozen,
        // cpDist=0, frames pinned — measured). Rebase at the owner 0→1 edge HERE, the
        // path that always runs.
        {
            static unsigned s_prev_owner = 0u;
            const unsigned owner_now =
                *reinterpret_cast<volatile unsigned*>(static_cast<uintptr_t>(0x026A0000u));
            if (owner_now == 1u && s_prev_owner != 1u)
            {
                const unsigned long long wgt0 =
                    static_cast<unsigned long long>(*reinterpret_cast<volatile unsigned*>(static_cast<uintptr_t>(0x02680008u))) |
                    (static_cast<unsigned long long>(*reinterpret_cast<volatile unsigned*>(static_cast<uintptr_t>(0x0268000Cu))) << 32);
                auto& ct = Core::System::GetInstance().GetCoreTiming();
                const long long delta =
                    static_cast<long long>(wgt0) - static_cast<long long>(ct.GetTicks());
                ct.RebaseTime(delta);
            }
            s_prev_owner = owner_now;
        }
        if (flags & EW_CT_PHASE4_ENABLE) {
            dolphin_service_iter();
        } else {
            retro_run();
        }
        if (!s_sab_patches_installed) {
            s_sab_patches_installed = true;
            // [PM54b NATIVE PARITY — user directive 2026-08-04] Native
            // dual-core Dolphin installs ZERO HLE patches for retail games:
            // pristine HLE.cpp PatchFunctions (:109-137) applies non-Fixed
            // patches only for names found in the symbol DB, and the oracle
            // invocations load no symbol map — the reference runs these
            // titles on pure PowerPC execution. Every per-game patch below
            // is a compensation the reference does not have. Default OFF;
            // flip ONLY for a controlled A/B. If boot/render breaks with
            // patches off, the breakage names a real seam deviation to fix
            // natively — that fix, not the patch, is the work.
            constexpr bool kInstallLegacyPatches = false;
            if (!kInstallLegacyPatches) {
                MAIN_THREAD_EM_ASM({
                    postMessage({cmd: 'print', txt: '[worker] HLE patches: NONE (native parity)'});
                });
            } else {
            auto& system = Core::System::GetInstance();
            // 2026-06-12: GATED BY GAME ID. These PCs come from SAB's
            // (GSNE8P) native dolphin.log plus one MP4 (GMPE01) skip; they
            // were installed unconditionally, and on PSO (GPOE8P) all nine
            // land MID-FUNCTION in unrelated live code (pso.map: e.g.
            // strncpy-replace inside zz_8010df9c_+0x18, FAKE_TO_SKIP_0
            // inside zz_800ca454_+0x3ec) — silent function corruption on
            // every non-SAB/MP4 title. MP4 keeps the full historical set
            // (its current boot baseline was established with all nine
            // installed); revisiting MP4's true minimal set is queued work.
            const std::string& gid = SConfig::GetInstance().GetGameID();
            const bool is_sab = gid.rfind("GSNE", 0) == 0;
            const bool is_mp4 = gid.rfind("GMPE", 0) == 0;
            if (is_sab || is_mp4) {
                // Full 7-patch set per native dolphin.log.preserved:
                HLE::Patch(system, 0x800e34a4u, "PPCMfhid2");
                HLE::Patch(system, 0x800e34acu, "PPCMfhid2");
                HLE::Patch(system, 0x800e34e0u, "PPCMfhid2");
                HLE::Patch(system, 0x8010dfb4u, "strncpy");
                HLE::Patch(system, 0x800e5bf0u, "OSReport");
                HLE::Patch(system, 0x800ecfa4u, "___blank");
                HLE::Patch(system, 0x800fe3c0u, "___blank");
                // pass-5 instrumentation — Start-hook on interrupt-mask-decoder
                // at 0x800e7e9c. Hook logs r3/r4/LR; spin diagnostic.
                HLE::Patch(system, 0x800e7e9cu, "TraceDispatcher");
                dolphin_evict_block(0x800e34a4u);
                dolphin_evict_block(0x800e34acu);
                dolphin_evict_block(0x800e34e0u);
                dolphin_evict_block(0x8010dfb4u);
                dolphin_evict_block(0x800e5bf0u);
                dolphin_evict_block(0x800ecfa4u);
                dolphin_evict_block(0x800fe3c0u);
                dolphin_evict_block(0x800e7e9cu);
            }
            if (is_mp4) {
                // MP4 (GMPE01_01) GXWaitDrawDone unblock: libretro init never
                // calls VideoBackend::Initialize (Core.cpp:488-489 libretro
                // init_video lambda returns true without it), so CommandProcessor
                // / Fifo / PixelEngine never Init, CPReadWriteDistance stays 0,
                // RunGpuOnCpu's gate never passes, BPWritten never reached, no
                // BPMEM_SETDRAWDONE -> PixelEngine::SetFinish, PE_FINISH never
                // fires, GXWaitDrawDone (GXMisc.c:116-127) sleeps on FinishQueue
                // forever. HLE-skip lets main thread proceed; renders nothing
                // but unblocks boot past Start New OVL 1.
                HLE::Patch(system, 0x800CA840u, "FAKE_TO_SKIP_0");
                dolphin_evict_block(0x800CA840u);
            }
            MAIN_THREAD_EM_ASM({
                postMessage({cmd: 'print', txt: '[worker] HLE patch install: gameid-gated (sab=' + $0 + ' mp4=' + $1 + ')'});
            }, (int)is_sab, (int)is_mp4);
            }  // kInstallLegacyPatches
        }
        if (!g_loaded) break;
    }
}

EMSCRIPTEN_KEEPALIVE
int save_state(uint8_t* out_buf, int max_bytes) {
    size_t need = retro_serialize_size();
    if ((int)need > max_bytes) return -(int)need;
    if (!retro_serialize(out_buf, need)) return -1;
    return (int)need;
}

EMSCRIPTEN_KEEPALIVE
int load_state(const uint8_t* in_buf, int bytes) {
    return retro_unserialize(in_buf, bytes) ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
int state_size(void) {
    return (int)retro_serialize_size();
}

// [savestate-deadlock-fix PM61 2026-08-05] save_state/load_state (via
// retro_serialize/retro_unserialize) call RunOnCPUThread(wait=true). From the
// CPU/EmuThread that runs INLINE (Core.cpp:946 IsCPUThread), but from the worker
// MESSAGE thread it BLOCKS that thread — which is the very thread the dual-core
// EmuThread needs serviced (proxied-main) → deadlock (froze at guest PC
// 800e253c). Fix: the message handler flags a request; the JIT dispatch loop
// bem_chain_loop_c (which runs ON the CPU/EmuThread) services it INLINE at a
// block boundary; the handler polls async so the pump keeps servicing the
// EmuThread. op: 0=none 1=save 2=load.
volatile int    g_bem_state_op      = 0;
volatile int    g_bem_state_done    = 0;
volatile int    g_bem_state_serving = 0;   // 1 while DoState runs: pump quiesces GPU
static int      g_bem_state_len     = 0;
static uint8_t* g_bem_state_buf     = nullptr;
static int      g_bem_state_cap     = 0;

EMSCRIPTEN_KEEPALIVE int bem_is_state_serving(void) { return g_bem_state_serving; }

// [savestate-fix PM61c] Drain AsyncRequests on the MESSAGE thread (device owner).
// Called from worker_funcs.js pumpBatch while a load is serving: retro_unserialize
// runs with passthrough=false, so VideoBackendBase::DoState QUEUES the video restore
// and the EmuThread blocks on its future. This runs PullEvents here (on the device
// thread) to execute that queued VideoCommon_DoState — createTexture etc. hit the
// device that exists on THIS thread — unblocking the EmuThread. Cheap no-op when the
// queue is empty.
EMSCRIPTEN_KEEPALIVE void bem_drain_async(void) {
    AsyncRequests::GetInstance()->PullEvents();
}

EMSCRIPTEN_KEEPALIVE int  bem_state_buf_ptr(void) { return (int)(intptr_t)g_bem_state_buf; }
EMSCRIPTEN_KEEPALIVE int  bem_state_poll(void)    { return g_bem_state_done ? g_bem_state_len : -1; }
EMSCRIPTEN_KEEPALIVE void bem_state_release(void) {
    if (g_bem_state_buf) { free(g_bem_state_buf); g_bem_state_buf = nullptr; }
    g_bem_state_op = 0; g_bem_state_done = 0; g_bem_state_len = 0; g_bem_state_cap = 0;
}
EMSCRIPTEN_KEEPALIVE int  bem_save_request(int cap) {
    if (g_bem_state_buf) { free(g_bem_state_buf); g_bem_state_buf = nullptr; }
    g_bem_state_buf = (uint8_t*)malloc(cap);
    if (!g_bem_state_buf) return -1;
    g_bem_state_cap = cap; g_bem_state_len = 0; g_bem_state_done = 0;
    g_bem_state_op  = 1;   // set LAST — the CPU thread reads op as the go signal
    return 0;
}
// Two-step load: alloc, caller fills buf via HEAPU8 at bem_state_buf_ptr(), then commit.
EMSCRIPTEN_KEEPALIVE int  bem_load_request(int len) {
    if (g_bem_state_buf) { free(g_bem_state_buf); g_bem_state_buf = nullptr; }
    g_bem_state_buf = (uint8_t*)malloc(len ? len : 1);
    if (!g_bem_state_buf) return -1;
    g_bem_state_cap = len; g_bem_state_len = len; g_bem_state_done = 0;
    return 0;
}
EMSCRIPTEN_KEEPALIVE void bem_load_commit(void) { g_bem_state_op = 2; }

// Called from bem_chain_loop_c ON THE CPU/EmuThread — retro_(un)serialize's
// RunOnCPUThread therefore runs inline, no cross-thread block.
void bem_service_pending_state(void) {
    const int op = g_bem_state_op;
    if (op == 0 || g_bem_state_done) return;
    // Quiesce the GPU pump: DoState reads/writes guest RAM + GPU state, and the
    // pump's RunGpuLoopSlice runs concurrently on the message thread — racing the
    // restore corrupts memory (loaded state ran ~165 frames then wedged on
    // bad-r1). The pump gates RunGpuLoopSlice on bem_is_state_serving().
    g_bem_state_serving = 1;
    if (op == 1) {                                   // save
        int sz = state_size();
        int w  = (sz > 0 && sz <= g_bem_state_cap) ? save_state(g_bem_state_buf, g_bem_state_cap) : 0;
        g_bem_state_len = (w > 0) ? w : 0;
    } else {                                          // load
        int r = load_state(g_bem_state_buf, g_bem_state_len);
        if (r != 0) g_bem_state_len = 0;
        // [savestate singles-mask hygiene 2026-08-07] load_state (DoState) restores
        // EVERY FPR with a full double, OUTSIDE any powerpc-next block flush — the
        // largest possible "writer outside the flush path". The singles shadow-mask
        // (0x026B33E0) and PM47 self-chain flag (0x026B38C0) still hold stale-SET bits
        // from the PRE-load run; a block that trusts a stale bit narrows the restored
        // double. The v9b value-verify safety net covers volatile f0-f13, but STABLE
        // f14-f31 are MASK-ONLY trust (ppc_emit.cpp:1691) — and skinning PSMTXConcat
        // uses f14/f15/f31, so restored stable doubles get narrowed with no net = the
        // bent-limb signature (subtly-wrong non-zero values), only ever from Load State.
        // Mirror the trap/compile-fail wholesale clear (JitWasm.cpp:533/624) so every
        // post-load block reloads from ps[] instead of trusting a pre-load single bit.
        *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B33E0u)) = 0u;
        *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B38C0u)) = 0u;
        // [savestate-fix PM61] DoState restores m_interrupt_cause/m_interrupt_mask and
        // ppc_state.Exceptions, but NOTHING re-derives the EXTERNAL_INT bit from the
        // restored cause&mask, and NOTHING republishes the PI-cause SAB mirror
        // (0x026B27D0) the CPU worker reads for fast ISR delivery. Post-load both are
        // stale, so a pending ARAM/DSP completion IRQ is never delivered and the guest
        // spins forever in aramSyncTransferQueue / SelectThread (confirmed load-only via
        // no-load control: boot climbs to gCtr 4092, load pins present at 198).
        // SetInterrupt(0,true) ORs in ZERO cause bits (no state change) but forces
        // UpdateException() to re-sync ppc_state.Exceptions + the mirror. Runs on the
        // CPU/EmuThread, satisfying SetInterrupt's IsCPUThread assert.
        if (r == 0) {
            Core::System::GetInstance().GetProcessorInterface().SetInterrupt(0u, true);
            // [savestate-fix PM61b] THE freeze fix. jitwasmRun (0x026B1B58, the
            // JitWasm::Run outer-loop counter incremented per iteration of
            // `while (*state_ptr == CPU::State::Running)`) freezes after a load →
            // the outer loop stopped → CPUManager::m_state is no longer Running, so
            // the EmuThread returns from JitWasm::Run and parks in CPUManager::Run's
            // cvar wait. Advance() never runs again → CoreTiming/VI freeze → every
            // guest thread blocks in SelectThread. In single-core, RunSingleFrame
            // calls Core::SetState(Running) EVERY frame (CPU.cpp:244); dual-core has
            // no such per-frame reset, and Core::SetState is a no-op here anyway (its
            // `s_state != Running` guard, Core.cpp:801, never passes in our restructured
            // boot — Main.cpp:452). Call the underlying resume directly. SetStepping(false)
            // sets m_state=Running without blocking (the CPU-thread wait is only in the
            // stepping=true branch, CPU.cpp:341) and re-runs Fifo/audio (idempotent), so
            // it is safe from this EmuThread and harmless if already Running.
            Core::System::GetInstance().GetCPU().SetStepping(false);
        }
    }
    g_bem_state_op      = 0;   // clear the CPU-thread gate (loop reads it)
    g_bem_state_serving = 0;   // let the pump resume
    g_bem_state_done    = 1;   // signal the polling message handler
}

}

int main(void) {
    retro_set_environment(environment_cb);
    retro_set_video_refresh(video_cb);
    retro_set_audio_sample(audio_sample_cb);
    retro_set_audio_sample_batch(audio_sample_batch_cb);
    retro_set_input_poll(input_poll_cb);
    retro_set_input_state(input_state_cb);
    retro_init();
    // [HW-render] The WebGL2 context is created at the START of load_iso (which
    // runs on the same proxied pthread that then drives retro_load_game / the
    // OGL backend), NOT here — under PROXY_TO_PTHREAD main() and load_iso may be
    // different threads and the GL context is thread-current. Backend selection
    // to "OGL" happens via SET_HW_RENDER (Video.cpp); no SW force here.
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[worker] dolphin core inited (HW/OGL renderer pending ctx)'});
        postMessage({cmd: 'setStatus', txt: 'Dolphin core ready, waiting for ROM'});
    });
    emscripten_exit_with_live_runtime();
    return 0;
}

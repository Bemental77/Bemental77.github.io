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
// MMIOMirror.h was part of the prior dolphin-src fork's diagnostic stack and
// is deliberately not present in the sanitized tree (df03d80 + canonical
// CMake gates). Removed unused include; if any MMIOMirror.h symbol turns out
// to still be referenced below, re-evaluate as canonical-source work.
#include "Core/HW/SystemTimers.h"
#include "Core/CoreTiming.h"
#include "Core/PowerPC/MMU.h"  // [mmio-mirror16] MMU::Read<u16> for the mirror refresher
#include "VideoCommon/Fifo.h"              // [gpu-pump]
#include "VideoCommon/CommandProcessor.h"  // [gpu-pump]
#include "VideoCommon/PixelEngine.h"          // [PE-finish flush]
#include "Core/HW/ProcessorInterface.h"     // [msr-zero watch cause/mask]
#include "Core/HW/DSP.h"                    // [msr-zero watch dspctl]
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
    (void)device; (void)index;
    if (port < 4 && id < 64) {
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
// [gp-ring STEP 3 2026-07-09 — PERMANENT] Consumer of the worker's WPAR-only Atomics ring
// (producer: ppc_worker.js installWriteEnv gpPush; layout @0x026C0000: +0 head/+4 tail
// monotonic, +8 producer-wait flag, +0xC fallbacks, +0x10 applied, +0x40 data 8192x{width,val}).
// Runs on the dolphin thread, so GPFifo/gather-pipe stay single-threaded (audit constraint).
// Call sites: TOP of dolphin_drain_mailbox_once (ordering: ring applies BEFORE any mailbox op,
// so a guest CP/MMIO read never observes state that excludes its own earlier GX words) + the
// always-runs run_iter_batch body (the branch-gated-drain starvation lesson). Notify after
// consuming (the producer's bounded watermark wait).
static u32 g_cp_read_cooldown = 0;  // [torn HI/LO] suppress the per-iter pump right after a CP-range read
static void dolphin_drain_gp_ring(void) {
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
void dolphin_service_iter(void) {
    if (!g_loaded) return;
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
        if (ctx != 0u && idle_hint != 0u && hint_pc != 0u && pc_now == hint_pc)
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
            *ff_flag = 1u;
            for (int k = 0; k < 1024; ++k)
            {
                *dc = 0;
                core_timing.Advance();
                if (*exc != exc0) break;
                if (*pc_live != hint_pc) break;
            }
            *ff_flag = 0u;
            // [gt-sync 2026-07-07] the ff loop advanced dolphin's global_timer to cross the
            // idle gap; push that time into the WORKER gt cells (0x02680008/0C) so the
            // subsequent gt-adopt (exact assignment) doesn't pull dolphin BACK below it and
            // undo the cross. This is what makes ff + one-clock coexist under owner==1.
            {
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
    // Diag counters in SAB so we can read them from the page without
    // depending on MAIN_THREAD_EM_ASM blocking the pthread.
    // 0x025010C0 = total iters
    // 0x025010C4 = iters with flags=0
    // 0x025010C8 = iters with flags=0x6
    // 0x025010CC = iters that took the Phase IV branch
    // 0x025010D0 = iters that called service_iter
    // 0x025010D4 = iters that called retro_run
    static volatile unsigned* const c_total   = (volatile unsigned*)0x025010C0u;
    static volatile unsigned* const c_flag0   = (volatile unsigned*)0x025010C4u;
    static volatile unsigned* const c_flag6   = (volatile unsigned*)0x025010C8u;
    static volatile unsigned* const c_p4br    = (volatile unsigned*)0x025010CCu;
    static volatile unsigned* const c_svci    = (volatile unsigned*)0x025010D0u;
    static volatile unsigned* const c_retror  = (volatile unsigned*)0x025010D4u;
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
        (*c_total)++;
        const unsigned flags = dolphin_ct_get_phase_flags();
        // [single-ordered-GX 2026-07-16] The Phase-IV-edge seal (dolphin_gp_seal/unseal on the
        // ISR-excursion transition) is RETIRED. It was fragile: it toggled g_gp_discard on a
        // coarse phase edge and the owner-clear below then dropped it for whole iterations, leaving
        // a window where dolphin's excursion GX spliced the worker's ring stream (the torn
        // GXLoadPosMtxImm -> SETDRAWDONE never decoded -> peFrames frozen at armframe). The reject
        // is now STRUCTURAL and always-current at the write site (GPFifo::Write* gate on
        // cpu_owner==1 && g_in_drain==0). No edge tracking, no owner-clear race. Boot single-core
        // (cpu_owner==0) is unaffected. See GPFifo.cpp gpfifo_reject_non_ring_gx().
        if (flags == 0u) (*c_flag0)++;
        else if (flags == 0x6u) (*c_flag6)++;
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
        if (g_bem_gp_dirty) {
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
            (*c_p4br)++;
            (*c_svci)++;
            dolphin_service_iter();
        } else {
            (*c_retror)++;
            retro_run();
        }
        if (!s_sab_patches_installed) {
            s_sab_patches_installed = true;
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

// Worker-side Dolphin bridge.
// Wraps the existing libretro retro_* API (already linked from dolphin_libretro.a)
// and forwards video/audio out via postMessage to the main thread.

#include <emscripten.h>
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

static bool environment_cb(unsigned cmd, void* data) {
    switch (cmd) {
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
EMSCRIPTEN_KEEPALIVE
void dolphin_service_iter(void) {
    if (!g_loaded) return;
    // 1. Pull ppc-worker DIRECT_W mirror writes back into dolphin's
    //    struct, then drain the pending-writes ring (replays
    //    ComplexWrite handlers, which may schedule CoreTiming events).
    // bemental_sab::mmio_mirror_* lived in the prior fork's Core/HW/MMIOMirror.h
    // (sanitized away in df03d80). No replacement on the canonical tree yet;
    // re-introducing the mirror is canonical work, not a .bak port. No-op here.
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
    // 3. NO retro_run() — under Phase IV ppc-worker owns dispatch entirely.
    //    retro_run calls into Core::ExecuteCPULoop → JitWasm::Run, which
    //    will still execute the inner dispatch even though downcount may
    //    have been burned, because Run reads downcount AFTER advancing the
    //    next slice. That defeats the cadence handoff. Frame/audio
    //    presentation needs to be wired separately (libretro video_cb /
    //    audio_sample_batch_cb invoked from here when SW FIFO has output).
    //    For now: 0 frames in Phase IV mode (boot-progress diagnosis first).
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
        if (flags == 0u) (*c_flag0)++;
        else if (flags == 0x6u) (*c_flag6)++;
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
    // Force the software renderer. The default-Hardware path probes for
    // GL/Vulkan/D3D contexts via env_cb (which we don't service), so it
    // falls through to Null which renders nothing. The "Software" option is
    // _DEBUG-gated in Options.cpp, so we must override Config directly.
    Config::SetBase(Config::MAIN_GFX_BACKEND, std::string("Software Renderer"));
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[worker] dolphin core inited (SW renderer)'});
        postMessage({cmd: 'setStatus', txt: 'Dolphin core ready, waiting for ROM'});
    });
    emscripten_exit_with_live_runtime();
    return 0;
}

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
#include <cstdint>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>

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
#include "hw/sh4/sh4_opcode_list.h"

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

// ---------------------------------------------------------------------------
// libretro callbacks
// ---------------------------------------------------------------------------

static bool environment_cb(unsigned cmd, void* data) {
    switch (cmd) {
        case RETRO_ENVIRONMENT_GET_CAN_DUPE:
            *(bool*)data = true;
            return true;
        case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
            // Flycast writes per-content VMU files relative to this. MEMFS
            // is fine with "/" — Flycast appends "/dc/" subpaths.
            *(const char**)data = "/";
            return true;
        case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
            // BIOS lookup root. The link script --embed-file's the BIOS at
            // /bios/dc_bios.bin — Flycast looks for "dc/dc_boot.bin" relative
            // to GET_SYSTEM_DIRECTORY by default; an alias/symlink in MEMFS
            // (set up post-init from JS) bridges the names.
            *(const char**)data = "/bios";
            return true;
        case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
            // Flycast forces XRGB8888. Accept it; reject others.
            return *(const enum retro_pixel_format*)data ==
                   RETRO_PIXEL_FORMAT_XRGB8888;
        case RETRO_ENVIRONMENT_GET_VARIABLE:
            // Let Flycast use its option defaults. Returning false here
            // means "no override" — core options resolve to their declared
            // defaults from libretro_core_options.h.
            return false;
        default:
            return false;
    }
}

static void video_cb(const void* data, unsigned w, unsigned h, size_t pitch) {
    static int frame_log = 0;
    if (frame_log < 3) {
        frame_log++;
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt: '[flycast-worker] video_cb data=' + $0 + ' w=' + $1 + ' h=' + $2 + ' pitch=' + $3});
        }, (uintptr_t)data, w, h, (uint32_t)pitch);
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

EMSCRIPTEN_KEEPALIVE
void emscripten_worker_init(void) {
    // No-op. The libretro callback wiring + retro_init() must run on the
    // pthread that owns Emscripten's per-thread Asyncify / TLS state — i.e.
    // the pthread that runs main(). With -sPROXY_TO_PTHREAD=1 our shim's
    // worker thread is the "browser main" thread; calling retro_init from
    // there hits Asyncify-instrumented paths (malloc that may sbrk-grow,
    // sigaction, locale catalog opens) with no Asyncify frame allocated,
    // which traps "memory access out of bounds". main() below performs
    // those calls and signals 'core-ready' via postMessage when finished.
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[flycast-worker] worker_init no-op (init now happens in main())'});
    });
}

EMSCRIPTEN_KEEPALIVE
int emscripten_load_disc(const char* path) {
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
    bool ok = retro_load_game(&info);
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[flycast-worker] load_disc: retro_load_game returned ' + ($0 ? 'true' : 'false')});
    }, ok ? 1 : 0);
    if (!ok) return 0;
    g_loaded = true;
    return 1;
}

EMSCRIPTEN_KEEPALIVE
void emscripten_run_iter(void) {
    if (g_loaded) retro_run();
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

EMSCRIPTEN_KEEPALIVE
uint32_t sh4_mem_read8(uint32_t addr) {
    return (uint32_t)ReadMem8(addr);
}

EMSCRIPTEN_KEEPALIVE
uint32_t sh4_mem_read16(uint32_t addr) {
    return (uint32_t)ReadMem16(addr);
}

EMSCRIPTEN_KEEPALIVE
uint32_t sh4_mem_read32(uint32_t addr) {
    return ReadMem32(addr);
}

EMSCRIPTEN_KEEPALIVE
void sh4_mem_write8(uint32_t addr, uint32_t val) {
    WriteMem8(addr, (uint8_t)val);
}

EMSCRIPTEN_KEEPALIVE
void sh4_mem_write16(uint32_t addr, uint32_t val) {
    WriteMem16(addr, (uint16_t)val);
}

EMSCRIPTEN_KEEPALIVE
void sh4_mem_write32(uint32_t addr, uint32_t val) {
    WriteMem32(addr, val);
}

// IFB fallback. The compiled block emits:
//   call $sh4_ifb (i32 opcode_imm, i32 pc) -> ()
// We dispatch via the global OpPtr table — the same path rec-x64 takes when
// mmu is off (rec_x64.cpp:178). Sets pc into Sh4cntx first so opcodes that
// read PC (branches, PC-relative loads) see the right value.
EMSCRIPTEN_KEEPALIVE
void sh4_interp_ifb(uint32_t opcode, uint32_t pc) {
    Sh4cntx.pc = pc;
    OpPtr[opcode & 0xFFFF](&Sh4cntx, opcode & 0xFFFF);
}

// SHIL canonical-call fallback. Phase 1 emits NO calls to this — emitShilOp
// only handles shop_ifb natively, and every other op routes to sh4_ifb above.
// Once the SHIL native-emit roadmap lands, the ops that can't be expressed
// in WASM directly (helper calls, FPU side-effects, exceptions) will route
// through here with (block_vaddr, op_idx) and we'll need a shil-op table
// keyed by those args.
//
// TODO(shil_fb): wire to the SHIL canonical-call dispatcher. Today this is
// unreachable from emitted code, but the import slot must exist or
// WebAssembly.Instance throws on missing imports.
EMSCRIPTEN_KEEPALIVE
void sh4_interp_shil_fb(uint32_t block_vaddr, uint32_t op_idx) {
    (void)block_vaddr;
    (void)op_idx;
    // Intentionally empty in Phase 1.
}

}  // extern "C"

// ---------------------------------------------------------------------------
// main: keep runtime alive; init is driven explicitly from JS via
// emscripten_worker_init so the page controls the boot sequence (e.g. the
// page may want to mount FS contents before retro_init runs).
// ---------------------------------------------------------------------------
int main(void) {
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[flycast-worker] main entered, running retro_init on pthread'});
    });
    retro_set_environment(environment_cb);
    retro_set_video_refresh(video_cb);
    retro_set_audio_sample(audio_sample_cb);
    retro_set_audio_sample_batch(audio_sample_batch_cb);
    retro_set_input_poll(input_poll_cb);
    retro_set_input_state(input_state_cb);
    retro_init();
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[flycast-worker] core inited (from main pthread)'});
        postMessage({cmd: 'core-ready'});
    });
    emscripten_exit_with_live_runtime();
    return 0;
}

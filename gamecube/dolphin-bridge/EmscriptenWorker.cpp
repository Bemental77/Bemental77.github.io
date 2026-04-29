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
void retro_unload_game(void);
size_t retro_serialize_size(void);
bool retro_serialize(void* data, size_t size);
bool retro_unserialize(const void* data, size_t size);
}

static uint8_t g_pad[32] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
                            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
                            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
                            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff};

static bool g_loaded = false;

static bool environment_cb(unsigned cmd, void* data) {
    switch (cmd) {
        case RETRO_ENVIRONMENT_GET_CAN_DUPE:
            *(bool*)data = true;
            return true;
        default:
            return false;
    }
}

static void video_cb(const void* data, unsigned w, unsigned h, size_t pitch) {
    static int frame_log = 0;
    if (frame_log < 3) {
        frame_log++;
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt: '[worker] video_cb data=' + $0 + ' w=' + $1 + ' h=' + $2 + ' pitch=' + $3});
        }, (uintptr_t)data, w, h, (uint32_t)pitch);
    }
    if (!data || !w || !h) return;
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

EMSCRIPTEN_KEEPALIVE
int load_iso(const char* path) {
    MAIN_THREAD_EM_ASM({
        postMessage({cmd: 'print', txt: '[worker] load_iso: entry, path=' + UTF8ToString($0)});
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
    g_loaded = true;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
void run_iter(void) {
    if (g_loaded) retro_run();
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

// gamecube/native/src/web_port.cpp — what Party Board's desktop front-end provides, for the web.
// frame_limiter: the game loop (src/game/main.c) calls it once per frame. On the web it must hand
// control back to the browser every frame (that is when the canvas presents and WebGPU callbacks
// run), so it sleeps through Asyncify until the next tick of an ABSOLUTE 1/60 s schedule: frame n is
// due at t0 + n/60, independent of how long any frame took, so the guest runs at exactly 60 frames
// per second of wall time whenever the host keeps up. If it falls more than 0.25 s behind it
// re-anchors (rather than racing to catch up — the game is never sped up).
#include <emscripten.h>
#include <cstdint>
#include <dolphin/pad.h>
#include <xxhash.h>

// ---- determinism: state hash + whole-memory snapshot at the frame boundary --------------------
// Game state = MEM1 (every HuMem heap, the msm heap) + the game's and overlays' .data/.bss (the link
// brackets them with these markers; aurora and this file sit outside). Two instances given the same
// epoch and the same per-frame input must produce the same hash every frame.
extern "C" void mp4web_stack_range(uintptr_t* b, uintptr_t* e);   // det_heap.c
extern "C" char mp4web_game_data_b[], mp4web_game_data_e[], mp4web_game_bss_b[], mp4web_game_bss_e[];
#include <dolphin/os.h>
extern "C" EMSCRIPTEN_KEEPALIVE double mp4web_state_hash() {
  XXH3_state_t* st = XXH3_createState();
  XXH3_64bits_reset(st);
  if (OSBaseAddress) XXH3_64bits_update(st, reinterpret_cast<const void*>(OSBaseAddress), 64u * 1024 * 1024);
  XXH3_64bits_update(st, mp4web_game_data_b, mp4web_game_data_e - mp4web_game_data_b);
  uintptr_t sb, se; mp4web_stack_range(&sb, &se);   // fiber stacks: stale scratch below live frames
  XXH3_64bits_update(st, mp4web_game_bss_b, sb - reinterpret_cast<uintptr_t>(mp4web_game_bss_b));
  XXH3_64bits_update(st, reinterpret_cast<const void*>(se), reinterpret_cast<uintptr_t>(mp4web_game_bss_e) - se);
  const uint64_t h = XXH3_64bits_digest(st);
  XXH3_freeState(st);
  return static_cast<double>(h >> 11);   // 53 bits: exact in a JS number
}
// [mem1 base, mem1 size, data b, data e, bss b, bss e, stacks b, stacks e (skipped)] — for tools that diff state between instances
extern "C" EMSCRIPTEN_KEEPALIVE void mp4web_state_ranges(uint32_t* out) {
  out[0] = static_cast<uint32_t>(OSBaseAddress); out[1] = 64u * 1024 * 1024;
  out[2] = reinterpret_cast<uintptr_t>(mp4web_game_data_b); out[3] = reinterpret_cast<uintptr_t>(mp4web_game_data_e);
  out[4] = reinterpret_cast<uintptr_t>(mp4web_game_bss_b); out[5] = reinterpret_cast<uintptr_t>(mp4web_game_bss_e);
  uintptr_t sb, se; mp4web_stack_range(&sb, &se); out[6] = static_cast<uint32_t>(sb); out[7] = static_cast<uint32_t>(se);
}
// The page's Module.mp4FrameHook(frame) runs here, once per frame, at the one point where a
// whole-memory snapshot is consistent (same call depth every frame, nothing in flight). It returns
// 1 after a restore, so the pacing clock re-anchors.
EM_JS(int, mp4web_state_pending_js, (void), {
  return Module.mp4StatePending ? (Module.mp4StatePending() | 0) : 0;
});
extern "C" void mp4web_gfx_quiesce(void);   // aurora gfx/common.cpp (patched)
EM_JS(int, mp4web_frame_hook_js, (double frame), {
  return Module.mp4FrameHook ? (Module.mp4FrameHook(frame) | 0) : 0;
});

// ---- input: latched once per frame -------------------------------------------------------------
// The page's Module.mp4InputLatch(frame, i32ptr) fills 4 ports x 8 i32:
//   [connected, buttons (GC PAD_* bits), stickX, stickY, substickX, substickY, trigL, trigR]
// for the frame about to run. Nothing else feeds PADRead on the web (aurora patch), so the frame's
// input is exactly this record — the unit a netplay session exchanges and a replay stores.
EM_JS(void, mp4web_input_latch_js, (double frame, int32_t* out), {
  if (Module.mp4InputLatch) Module.mp4InputLatch(frame, out);
});
extern "C" void mp4web_audio_frame(void); // web_audio.cpp
static int32_t g_input[4][8];
static void latch_input(uint64_t frame) {
  for (auto& p : g_input) for (auto& v : p) v = 0;
  mp4web_input_latch_js(static_cast<double>(frame), &g_input[0][0]);
  for (u32 port = 0; port < 4; ++port) {
    const int32_t* r = g_input[port];
    if (!r[0]) { PADClearVirtualStatus(port); continue; }
    PADStatus st{};
    st.button = static_cast<u16>(r[1]);
    st.stickX = static_cast<s8>(r[2]); st.stickY = static_cast<s8>(r[3]);
    st.substickX = static_cast<s8>(r[4]); st.substickY = static_cast<s8>(r[5]);
    st.triggerLeft = static_cast<u8>(r[6]); st.triggerRight = static_cast<u8>(r[7]);
    st.analogA = (st.button & PAD_BUTTON_A) ? 0xFF : 0; st.analogB = (st.button & PAD_BUTTON_B) ? 0xFF : 0;
    PADSetVirtualStatus(port, &st);
  }
}

static double g_t0 = -1.0;
static uint64_t g_frame = 0;
static uint64_t g_reanchors = 0;
static uint64_t g_total = 0;      // frames since start (never reset)
static double g_busy = 0.0;       // host ms spent producing frames (wake -> next frame_limiter call)
static double g_lastWake = -1.0;
static double g_gpuWait = 0.0;    // of g_busy: ms spent yielded inside a frame waiting on a GPU buffer map

extern "C" void frame_limiter() {
  constexpr double period = 1000.0 / 60.0;
  mp4web_audio_frame();   // this frame's 5 ms sound ticks + samples (before the sleep: part of the frame's cost)
  double now = emscripten_get_now();
  if (g_lastWake >= 0) g_busy += now - g_lastWake;
  ++g_total;
  if (g_t0 < 0) { g_t0 = now; g_frame = 0; }
  ++g_frame;
  double due = g_t0 + static_cast<double>(g_frame) * period;
  if (now - due > 250.0) { g_t0 = now; g_frame = 0; ++g_reanchors; due = now; }
  if (mp4web_state_pending_js()) mp4web_gfx_quiesce();
  if (mp4web_frame_hook_js(static_cast<double>(g_total))) { g_t0 = -1; due = now; }
  const double wait = due - now;
  emscripten_sleep(wait > 0 ? static_cast<unsigned>(wait) : 0);
  g_lastWake = emscripten_get_now();
  latch_input(g_total); // input for frame g_total (0-based count of frames already produced)
  // sub-millisecond remainder: spin is pointless in a browser; the next frame absorbs it
}

extern "C" EMSCRIPTEN_KEEPALIVE double mp4web_frames() { return static_cast<double>(g_frame); }
extern "C" EMSCRIPTEN_KEEPALIVE double mp4web_reanchors() { return static_cast<double>(g_reanchors); }
extern "C" EMSCRIPTEN_KEEPALIVE double mp4web_total() { return static_cast<double>(g_total); }
// mean host ms per produced frame, excluding the sleep: capacity, not presented rate
extern "C" EMSCRIPTEN_KEEPALIVE double mp4web_busy_ms() { return g_busy; }
// aurora's gfx/common.cpp calls this where it would spin on ProcessEvents waiting for a mapped buffer
extern "C" void mp4web_yield_for_gpu(void) {
  const double t = emscripten_get_now();
  emscripten_sleep(0);
  g_gpuWait += emscripten_get_now() - t;
}
extern "C" EMSCRIPTEN_KEEPALIVE double mp4web_gpu_wait_ms() { return g_gpuWait; }

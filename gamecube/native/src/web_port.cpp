// gamecube/native/src/web_port.cpp — what Party Board's desktop front-end provides, for the web.
// frame_limiter: the game loop (src/game/main.c) calls it once per frame. On the web it must hand
// control back to the browser every frame (that is when the canvas presents and WebGPU callbacks
// run), so it sleeps through Asyncify until the next tick of an ABSOLUTE 1/60 s schedule: frame n is
// due at t0 + n/60, independent of how long any frame took, so the guest runs at exactly 60 frames
// per second of wall time whenever the host keeps up. If it falls more than 0.25 s behind it
// re-anchors (rather than racing to catch up — the game is never sped up).
#include <emscripten.h>
#include <cstdint>

static double g_t0 = -1.0;
static uint64_t g_frame = 0;
static uint64_t g_reanchors = 0;
static uint64_t g_total = 0;      // frames since start (never reset)
static double g_busy = 0.0;       // host ms spent producing frames (wake -> next frame_limiter call)
static double g_lastWake = -1.0;
static double g_gpuWait = 0.0;    // of g_busy: ms spent yielded inside a frame waiting on a GPU buffer map

extern "C" void frame_limiter() {
  constexpr double period = 1000.0 / 60.0;
  double now = emscripten_get_now();
  if (g_lastWake >= 0) g_busy += now - g_lastWake;
  ++g_total;
  if (g_t0 < 0) { g_t0 = now; g_frame = 0; }
  ++g_frame;
  double due = g_t0 + static_cast<double>(g_frame) * period;
  if (now - due > 250.0) { g_t0 = now; g_frame = 0; ++g_reanchors; due = now; }
  const double wait = due - now;
  emscripten_sleep(wait > 0 ? static_cast<unsigned>(wait) : 0);
  g_lastWake = emscripten_get_now();
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

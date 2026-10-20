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
#include <aurora/gfx.h>
#include <dolphin/os.h>
#include <malloc.h>
#include <unistd.h>

// ---- memory accounting: per-frame peaks of aurora's staging sub-buffers + heap figures ----------
static uint32_t g_peak[5];
static void track_gfx_peaks() {
  const AuroraStats* st = aurora_get_stats();
  if (!st) return;
  const uint32_t v[5] = {st->lastVertSize, st->lastUniformSize, st->lastIndexSize, st->lastStorageSize, st->lastTextureUploadSize};
  for (int i = 0; i < 5; ++i) if (v[i] > g_peak[i]) g_peak[i] = v[i];
}
// internal render resolution: 0 = the canvas's pixel size (Aurora's default), N = N x the GameCube's
// 640x480 (fitted to the canvas aspect). Presentation scales it to the canvas either way.
extern "C" void VISetFrameBufferScale(float scale);
extern "C" EMSCRIPTEN_KEEPALIVE void mp4web_set_fb_scale(double s) { VISetFrameBufferScale(static_cast<float>(s)); }
// last recorded frame: [draws, merged draws, vert B, uniform B, index B, storage B, texture upload B, pipelines created]
extern "C" EMSCRIPTEN_KEEPALIVE void mp4web_gfx_stats(double* out) {
  const AuroraStats* st = aurora_get_stats();
  if (!st) return;
  out[0] = st->drawCallCount; out[1] = st->mergedDrawCallCount; out[2] = st->lastVertSize; out[3] = st->lastUniformSize;
  out[4] = st->lastIndexSize; out[5] = st->lastStorageSize; out[6] = st->lastTextureUploadSize; out[7] = st->createdPipelines;
}
extern "C" double mp4web_det_heap_high_water(void);
extern "C" double mp4web_det_stack_high_water(void);
// [vert, uniform, index, storage, texupload peaks, sbrk top, malloc in-use, malloc footprint, det hw, stack hw, MEM1 used]
extern "C" EMSCRIPTEN_KEEPALIVE void mp4web_mem_stats(double* out) {
  for (int i = 0; i < 5; ++i) out[i] = g_peak[i];
  const struct mallinfo mi = mallinfo();
  out[5] = static_cast<double>(reinterpret_cast<uintptr_t>(sbrk(0)));
  out[6] = mi.uordblks; out[7] = mi.arena;
  out[8] = mp4web_det_heap_high_water(); out[9] = mp4web_det_stack_high_water();
  // highest non-zero byte of MEM1 (how much of it the game ever touched)
  const uint8_t* m1 = reinterpret_cast<const uint8_t*>(OSBaseAddress);
  uint32_t hi = 0;
  if (m1) for (uint32_t i = 24u * 1024 * 1024; i-- > 0;) if (m1[i]) { hi = i + 1; break; }
  out[10] = hi;
}

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
  if (OSBaseAddress) XXH3_64bits_update(st, reinterpret_cast<const void*>(OSBaseAddress), 24u * 1024 * 1024);
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
  out[0] = static_cast<uint32_t>(OSBaseAddress); out[1] = 24u * 1024 * 1024;
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
// The audio split's control -> render log (musyx hw_pc_split.h): the game's MusyX writes one guest
// frame's worth here and web_audio.cpp hands it to the page, which replays it in the audio module.
// Host-side output, outside the game's state on purpose (the control state never reads it back), and
// the serial counts every frame shipped or not, so a frame the page did not replay (a muted
// re-simulation, a hidden catch-up) is a gap the render side resyncs across.
static uint8_t g_audioLog[512 * 1024];
extern "C" {
uint8_t* salPCLogBuf = g_audioLog;
uint32_t salPCLogCap = sizeof(g_audioLog);
uint32_t salPCLogLen = 0;
uint32_t salPCLogOverflow = 0;
uint32_t mp4web_audio_log_serial = 0;
}
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

// Pacing knobs a netplay room sets (mp4n_room.js). Solo: a frame may run up to 250 ms late and the
// schedule catches up; in a room the debt is capped at one frame, so a console that fell behind
// never sprints (the room's hidden catch-up frames, granted and capped by lib/netplay.js, are the
// only frames that run faster than the clock, and they are not presented).
static double g_maxDebt = 250.0;
extern "C" EMSCRIPTEN_KEEPALIVE void mp4web_set_max_debt(double ms) { g_maxDebt = ms; }
// A ROOM MAY CATCH UP, BUT NEVER FAST. Time a room console loses waiting on an input used to be
// dropped outright (debt capped at one frame), so every stall lowered its guest rate for good.
// Now a token bucket lets it keep some of that time: +rate frames of credit per frame run, at most
// cap frames held; a late console keeps min(lateness, credit) and runs it back to back. With
// cap 2.5 and rate 1/120 no 5 s window can run more than 300 + 5 frames: 1.0167x, GameCube's bar.
static double g_catchTokens = 0.0, g_catchCap = 0.0, g_catchRate = 0.0;
// page ?mg=401..463 / ?board=0..6 [&turns=N] / ?ovl=N (crash sweep): what bootDll boots straight into; 0 = normal boot
EM_JS(int, mp4web_debug_mg, (void), { return (typeof Module.mp4DebugMg === 'number') ? Module.mp4DebugMg : 0; });
EM_JS(int, mp4web_debug_board, (void), { return (typeof Module.mp4DebugBoard === 'number') ? Module.mp4DebugBoard + 1 : 0; });
EM_JS(int, mp4web_debug_ovl, (void), { return (typeof Module.mp4DebugOvl === 'number') ? Module.mp4DebugOvl + 1 : 0; });
EM_JS(int, mp4web_debug_turns, (void), { return (typeof Module.mp4DebugTurns === 'number') ? Module.mp4DebugTurns : 0; });

extern "C" EMSCRIPTEN_KEEPALIVE void mp4web_set_catchup(double capFrames, double ratePerFrame) {
  g_catchCap = capFrames; g_catchRate = ratePerFrame; if (g_catchTokens > g_catchCap) g_catchTokens = g_catchCap;
}

// The hook's answer, a bit set:
//   1  re-anchor the pacing clock (after a restore that is not a room rewind)
//   2  HOLD: do not run the next frame yet — sleep 2 ms and ask again (a room waiting on input)
//   4  OFF-SCHEDULE: this frame is a re-simulation or a hidden catch-up — run it at once, no
//      sleep, and do not count it against the 60 Hz schedule
enum { kHookReanchor = 1, kHookHold = 2, kHookOffSchedule = 4 };

// FRAME SKIP — the guest keeps 1.000x, the picture gives. A frame Aurora does not draw costs a few
// ms instead of the whole GPU frame (measured on SwiftShader: ~4 vs ~94 ms), and drawing is the
// only part of a frame that does not change game state. So when the schedule says this console is
// more than half a frame late, the NEXT frame is run undrawn — at most g_skipMax in a row, so at
// least one frame in (g_skipMax+1) is presented (60 / 4 = 15 per second at the default 3).
// The game, its audio and its clock run every frame exactly as before; only presents are dropped.
extern "C" int mp4web_gfx_skip_draws;          // aurora gfx/common.cpp (patched)
static int g_skipMax = 3, g_skipRun = 0;
// set by aurora's GXCopyTex on an undrawn frame (its copy had no EFB to read): the next frame is not auto-skipped
extern "C" { int mp4web_gx_copy_redraw = 0; }
static uint64_t g_drawn = 0, g_autoSkipped = 0;
extern "C" EMSCRIPTEN_KEEPALIVE void mp4web_set_frameskip(int maxRun) { g_skipMax = maxRun < 0 ? 0 : maxRun; }
extern "C" EMSCRIPTEN_KEEPALIVE double mp4web_drawn() { return static_cast<double>(g_drawn); }
extern "C" EMSCRIPTEN_KEEPALIVE double mp4web_auto_skipped() { return static_cast<double>(g_autoSkipped); }

extern "C" void frame_limiter() {
  constexpr double period = 1000.0 / 60.0;
  track_gfx_peaks();
  mp4web_audio_frame();   // this frame's 5 ms sound ticks + samples (before the sleep: part of the frame's cost)
  double now = emscripten_get_now();
  if (g_lastWake >= 0) g_busy += now - g_lastWake;
  if (!mp4web_gfx_skip_draws) { ++g_drawn; mp4web_gx_copy_redraw = 0; }     // the frame that just ended was presented
  mp4web_gfx_skip_draws = 0;                 // the next frame is drawn unless the room's hook or the frame skip says otherwise
  ++g_total;
  if (g_t0 < 0) { g_t0 = now; g_frame = 0; }
  if (mp4web_state_pending_js()) mp4web_gfx_quiesce();
  int fl;
  for (;;) {
    fl = mp4web_frame_hook_js(static_cast<double>(g_total));
    if (!(fl & kHookHold)) break;
    emscripten_sleep(2);
  }
  now = emscripten_get_now();
  if (fl & kHookReanchor) { g_t0 = now; g_frame = 0; }
  if (!(fl & kHookOffSchedule)) {
    ++g_frame;
    double due = g_t0 + static_cast<double>(g_frame) * period;
    // lateness is read BEFORE the debt cap re-anchors the clock: a room caps the debt at one frame,
    // so after re-anchoring it never looks late, and its frames were never skipped (every live room
    // frame was drawn on a device that could not afford it)
    const double late = now - due;
    if (late > g_maxDebt) {
      double keep = 0.0;
      if (g_catchCap > 0.0) { keep = late < g_catchTokens * period ? late : g_catchTokens * period; g_catchTokens -= keep / period; }
      g_t0 = now - keep; g_frame = 0; ++g_reanchors; due = g_t0;
    }
    if (g_catchCap > 0.0) { g_catchTokens += g_catchRate; if (g_catchTokens > g_catchCap) g_catchTokens = g_catchCap; }
    const double wait = due - now;
    // the next frame: drawn, unless the room already said not to, or this console is behind
    if (!mp4web_gfx_skip_draws) {
      if (late > 0.5 * period && g_skipRun < g_skipMax && !mp4web_gx_copy_redraw) { mp4web_gfx_skip_draws = 1; ++g_skipRun; ++g_autoSkipped; }
      else g_skipRun = 0;
    }
    emscripten_sleep(wait > 0 ? static_cast<unsigned>(wait) : 0);
  }
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
// After a rollback restore the frame counter goes back with the game (it lives outside game state).
extern "C" EMSCRIPTEN_KEEPALIVE void mp4web_set_frame(double f) { g_total = static_cast<uint64_t>(f); }

// gamecube/native/src/web_port.cpp — what Party Board's desktop front-end provides, for the web.
// frame_limiter: the game loop (src/game/main.c) calls it once per frame. On the web it must hand
// control back to the browser every frame (that is when the canvas presents and WebGPU callbacks
// run), so it sleeps through Asyncify until the next tick of an ABSOLUTE 1/60 s schedule: frame n is
// due at t0 + n/60, independent of how long any frame took, so the guest runs at exactly 60 frames
// per second of wall time whenever the host keeps up. If it falls more than 0.25 s behind it
// re-anchors (rather than racing to catch up — the game is never sped up).
#include <emscripten.h>
#include <cstdint>
#include <cstring>
#include <cstdlib>
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
// THE SENT-DATA SHADOW (musyx hw_pc.c flushRunVals): what the render module's sample mirror holds, as far as
// the control side knows, in 64-byte chunks. A chunk whose bytes match what was last delivered is not sent
// again (each guest frame re-sent every source byte its voices read: ~22 KB a frame through the log, the
// page's ring and the render module's mirror). Host-side, outside the game's state like the log: it tracks
// the render module, which a rollback does not rewind. A chunk is clean only while its valid bit is set:
// the bits of a frame's sends are dropped when the page did not deliver that frame's log (a muted
// re-simulation, a hidden frame, a full ring, an overflow), and all of them when the log went to a
// different render instance than the last one (the worklet taking over from the main thread, or back).
// (its tables are allocated on first use rather than static: static, they moved every game address after
// them in the link — 0xE0000 B — and with them the link-map constants the test routes read, e.g. omcurovl)
static uint8_t** g_shadowPage = nullptr;     // [65536]: 64 KiB pages of shadow bytes, then 1024 valid bits (128 B)
static uint16_t* g_shadowUsed = nullptr;     // [65536]: the allocated pages, for a reset
static uint32_t g_shadowUsedN = 0;
static uint32_t (*g_shadowSent)[2] = nullptr;   // [4096]: this frame's sends (addr, len)
static uint32_t g_shadowSentN = 0, g_shadowSentLost = 0;
static bool shadow_init() {
  if (g_shadowPage) return true;
  g_shadowPage = static_cast<uint8_t**>(calloc(1u << 16, sizeof(uint8_t*)));
  g_shadowUsed = static_cast<uint16_t*>(calloc(1u << 16, sizeof(uint16_t)));
  g_shadowSent = static_cast<uint32_t(*)[2]>(calloc(4096, sizeof(uint32_t[2])));
  if (!g_shadowPage || !g_shadowUsed || !g_shadowSent) { free(g_shadowPage); free(g_shadowUsed); free(g_shadowSent); g_shadowPage = nullptr; return false; }
  return true;
}
static uint8_t* shadow_page(uint32_t page) {
  uint8_t* p = g_shadowPage[page];
  if (!p) {
    p = static_cast<uint8_t*>(calloc(1, 65536 + 128));
    if (!p) return nullptr;
    g_shadowPage[page] = p; g_shadowUsed[g_shadowUsedN++] = static_cast<uint16_t>(page);
  }
  return p;
}
static void shadow_invalidate(uint32_t addr, uint32_t len) {
  if (!g_shadowPage) return;
  for (uint32_t c = addr & ~63u; c < addr + len; c += 64) {
    uint8_t* p = g_shadowPage[c >> 16];
    if (p) { const uint32_t k = (c & 65535u) >> 6; p[65536 + (k >> 3)] &= static_cast<uint8_t>(~(1u << (k & 7))); }
  }
}
static void shadow_reset() { if (g_shadowPage) for (uint32_t i = 0; i < g_shadowUsedN; ++i) memset(g_shadowPage[g_shadowUsed[i]] + 65536, 0, 128); }
extern "C" {
// a 64-byte-aligned chunk the render module already holds byte for byte
int salPCShadowClean(uint32_t c) {
  if (!g_shadowPage) return 0;
  const uint8_t* p = g_shadowPage[c >> 16];
  if (!p) return 0;
  const uint32_t k = (c & 65535u) >> 6;
  if (!(p[65536 + (k >> 3)] & (1u << (k & 7)))) return 0;
  return memcmp(p + (c & 65535u), reinterpret_cast<const void*>(static_cast<uintptr_t>(c)), 64) == 0;
}
// chunks [c, c + len) were just written into the log
void salPCShadowSent(uint32_t c, uint32_t len) {
  if (!shadow_init()) return;
  for (uint32_t a = c; a < c + len; a += 64) {
    uint8_t* p = shadow_page(a >> 16);
    if (!p) continue;
    memcpy(p + (a & 65535u), reinterpret_cast<const void*>(static_cast<uintptr_t>(a)), 64);
    const uint32_t k = (a & 65535u) >> 6;
    p[65536 + (k >> 3)] |= static_cast<uint8_t>(1u << (k & 7));
  }
  if (g_shadowSentN < 4096) { g_shadowSent[g_shadowSentN][0] = c; g_shadowSent[g_shadowSentN][1] = len; ++g_shadowSentN; }
  else g_shadowSentLost = 1;
}
// the page's answer for one frame's log: 1 delivered, 0 not, 2 delivered to a different render instance
void salPCShadowFrameEnd(int delivered) {
  if (delivered == 2 || (delivered == 0 && g_shadowSentLost)) shadow_reset();
  else if (delivered == 0) for (uint32_t i = 0; i < g_shadowSentN; ++i) shadow_invalidate(g_shadowSent[i][0], g_shadowSent[i][1]);
  g_shadowSentN = 0; g_shadowSentLost = 0;
}
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
// REPAID DEBT (a room, mp4n_room.js: mp4web_set_pacing(1000, 1.0167)). The guest averages exactly 1.000x of wall time:
// lateness of up to carryMs (re-simulation time included, it is lateness like any other) is kept and repaid by running
// frames early, but no frame starts sooner than period/maxRate after the previous live one and no 5 s window holds more
// than 300*maxRate live frames, so catch-up never exceeds maxRate. A frame is never started before its due time (the
// guest never runs ahead of wall time). Debt over carryMs is a real stall (a hidden tab, a long load): forgiven, so
// nothing sprints for long. maxRate 0 = the solo rule (g_maxDebt, unthrottled catch-up).
static double g_carryMs = 0.0, g_maxRate = 0.0;
static double g_win[512];          // start times of the last live frames (a ring), for the 5 s window
static unsigned g_winN = 0, g_winHead = 0;
static double g_lastStart = -1.0;
static uint64_t g_forgiven = 0;    // debts dropped (each a stall over carryMs)
static double g_forgivenMs = 0.0;
static double g_forgivenAt[8][2];   // the last forgiven debts: [guest frame, ms]
extern "C" EMSCRIPTEN_KEEPALIVE void mp4web_set_pacing(double carryMs, double maxRate) { g_carryMs = carryMs; g_maxRate = maxRate; }
extern "C" EMSCRIPTEN_KEEPALIVE void mp4web_pacing_stats(double* out) {
  out[0] = static_cast<double>(g_forgiven); out[1] = g_forgivenMs;
  out[2] = g_t0 >= 0 ? emscripten_get_now() - (g_t0 + static_cast<double>(g_frame) * (1000.0 / 60.0)) : 0.0;   // current debt, ms
  for (int i = 0; i < 8; ++i) { out[3 + 2 * i] = g_forgivenAt[i][0]; out[4 + 2 * i] = g_forgivenAt[i][1]; }   // out[3..18]
}
// the earliest a live frame may start under the rate cap
static double pacing_earliest(double period) {
  double e = g_lastStart >= 0 ? g_lastStart + period / g_maxRate : 0.0;
  const unsigned cap = static_cast<unsigned>(300.0 * g_maxRate);   // live frames per 5 s
  if (g_winN >= cap && cap > 0 && cap <= 512) {
    const double oldest = g_win[(g_winHead + 512 - cap) & 511];      // the cap-th most recent start
    if (oldest + 5000.0 > e) e = oldest + 5000.0;
  }
  return e;
}
static void pacing_started(double t) {
  g_lastStart = t; g_win[g_winHead] = t; g_winHead = (g_winHead + 1) & 511; if (g_winN < 512) ++g_winN;
}

// The hook's answer, a bit set:
//   1  re-anchor the pacing clock (after a restore that is not a room rewind)
//   2  HOLD: do not run the next frame yet — sleep 2 ms and ask again (a room waiting on input)
//   4  OFF-SCHEDULE: this frame is a re-simulation or a hidden catch-up — run it at once, no
//      sleep, and do not count it against the 60 Hz schedule
//   8  (with 4) RE-SIMULATION: not new game time. Under repaid debt (mp4web_set_pacing) only a re-simulation
//      runs off schedule; a hidden catch-up frame (4 alone) is paced like any live frame, just not drawn
enum { kHookReanchor = 1, kHookHold = 2, kHookOffSchedule = 4, kHookResim = 8 };

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
  if (g_maxRate > 0.0 && !(fl & kHookOffSchedule && fl & kHookResim)) {
    // REPAID DEBT: every live frame (drawn or hidden) takes one period of the schedule
    ++g_frame;
    double due = g_t0 + static_cast<double>(g_frame) * period;
    const double late = now - due;
    if (late > g_carryMs) { g_forgivenAt[g_forgiven & 7][0] = static_cast<double>(g_total); g_forgivenAt[g_forgiven & 7][1] = late; ++g_forgiven; g_forgivenMs += late; g_t0 = now - static_cast<double>(g_frame) * period; due = now; ++g_reanchors; }
    double start = due > now ? due : now;
    const double earliest = pacing_earliest(period);
    if (earliest > start) start = earliest;
    if (!mp4web_gfx_skip_draws && !(fl & kHookOffSchedule)) {
      if (late > 0.5 * period && g_skipRun < g_skipMax && !mp4web_gx_copy_redraw) { mp4web_gfx_skip_draws = 1; ++g_skipRun; ++g_autoSkipped; }
      else g_skipRun = 0;
    }
    const double wait = start - now;
    emscripten_sleep(wait > 0 ? static_cast<unsigned>(wait) : 0);
    // the cap is kept on INTENDED start times: a timer that wakes late must not push the next frame's earliest start
    // later too, or a console behind the clock could never repay (every interval = period/maxRate + oversleep)
    pacing_started(start);
  } else if (!(fl & kHookOffSchedule)) {
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

// gamecube/native/src/web_audio.cpp — Party Board's audio backend (include/port/audio.h + the AI
// calls msm makes), for the web, single-threaded and deterministic.
//
// Upstream (partyboard audio branch, src/port/audio.cpp) lets an SDL audio thread pull samples, so
// the game's 5 ms sound tick (msmSysServer, which advances music/SE state) runs on the audio
// device's clock. Here the GAME drives it: web_port.cpp calls mp4web_audio_frame() once per guest
// frame, which renders exactly the samples that frame covers (32000/60 per frame, the fraction
// carried exactly), so every 5 ms tick happens at the same guest-frame position on every machine —
// what netplay needs — and the guest never runs faster or slower than its frames.
// The page (Module.mp4AudioPush) schedules each frame's samples on a WebAudio clock.
#include <emscripten.h>
#include <cstdint>
#include <cstring>
#include <vector>

extern "C" {
#include <dolphin/ai.h>
#include <dolphin/dvd.h>
#include <musyx/musyx.h>
#include <musyx/pc.h>
#include <port/audio.h>
}

namespace {
constexpr uint32_t kRate = 32000;   // MusyX's native mix rate; the page creates its AudioContext at it
constexpr uint32_t kChannels = 2;
AIDCallback sDmaCallback = nullptr;
bool sStarted = false;
uint64_t sFrames = 0;               // guest frames stepped
uint64_t sDue = 0;                  // samples the stepped frames cover (32000/60 each, exactly)
uint64_t sRendered = 0;             // samples actually rendered (>= sDue after a busy-wait pump)
uint64_t sCalls = 0;                // OSGetTime calls (+1 tick each, so a spin on the clock ends)
uint64_t sSamplesOut = 0;
int64_t sEpochTicks = -1;

struct PendingRead { DVDFileInfo* fileInfo; void* addr; s32 length; s32 offset; DVDCallback callback; };
std::vector<PendingRead> sReads;

void output_callback(s16* output, size_t frames, u32 rate, u32 channels) {
  (void)output; (void)frames; (void)rate; (void)channels;
  if (sDmaCallback != nullptr) sDmaCallback();   // one 5 ms MusyX cycle
}
}  // namespace

EM_JS(void, mp4web_audio_push_js, (const int16_t* pcm, int frames, int rate), {
  if (Module.mp4AudioPush) Module.mp4AudioPush(HEAP16.subarray(pcm >> 1, (pcm >> 1) + frames * 2), rate);
});

extern "C" {

void partyboard_audio_lock(void) {}
void partyboard_audio_unlock(void) {}

void partyboard_audio_pre_init(void) {
  const SND_PC_CONFIG cfg{kRate, kChannels};
  sndPCConfigure(&cfg);
}

void partyboard_audio_start(void) {
  sndPCSetOutputCallback(output_callback);
  sStarted = true;
}

void partyboard_audio_shutdown(void) { sStarted = false; }

// Stream reads complete at the next frame's audio step (a fixed point in the frame), not inline.
BOOL partyboard_audio_read_async(DVDFileInfo* fileInfo, void* addr, s32 length, s32 offset, DVDCallback callback) {
  fileInfo->cb.state = DVD_STATE_BUSY;
  sReads.push_back({fileInfo, addr, length, offset, callback});
  return TRUE;
}

void AIInit(u8* stack) { (void)stack; }
AIDCallback AIRegisterDMACallback(AIDCallback callback) {
  const AIDCallback old = sDmaCallback;
  sDmaCallback = callback;
  return old;
}
void AISetStreamPlayState(u32 state) { (void)state; }
void AISetStreamVolLeft(u8 vol) { (void)vol; }
void AISetStreamVolRight(u8 vol) { (void)vol; }

static void process_reads() {
  if (sReads.empty()) return;
  std::vector<PendingRead> reads;
  reads.swap(sReads);
  for (const auto& r : reads) {
    const s32 result = DVDReadPrio(r.fileInfo, r.addr, r.length, r.offset, 2);
    if (r.callback != nullptr) r.callback(result, r.fileInfo);
  }
}

static void render(uint32_t n) {
  static int16_t buf[(kRate / 60 + 2) * kChannels];
  if (n == 0 || !sndPCRender(buf, n)) return;
  sSamplesOut += n;
  mp4web_audio_push_js(buf, static_cast<int>(n), static_cast<int>(kRate));
}

// Called once per guest frame (web_port.cpp frame_limiter).
void mp4web_audio_frame(void) {
  process_reads();
  const uint64_t f = sFrames++;
  sDue += (kRate * (f + 1)) / 60 - (kRate * f) / 60;  // 533 or 534
  if (!sStarted) { sRendered = sDue; return; }
  if (sRendered < sDue) {
    const uint32_t n = static_cast<uint32_t>(sDue - sRendered);
    render(n);
    sRendered = sDue;
  }
}

// One 5 ms engine cycle on demand (game/audio.c SNDGRP_WAIT); later frames render that much less.
void mp4web_audio_pump_cycle(void) {
  process_reads();
  if (!sStarted) return;
  render(kRate / 200);
  sRendered += kRate / 200;
}

// Guest time in OS timer ticks (40.5 MHz) since the GameCube epoch (2000-01-01, local time).
EM_JS(double, mp4web_epoch_seconds_js, (void), {
  if (typeof Module.mp4EpochSeconds === 'number') return Module.mp4EpochSeconds;
  return Math.floor(Date.now() / 1000) - 946684800 - new Date().getTimezoneOffset() * 60;
});
s64 mp4web_guest_time(void) {
  if (sEpochTicks < 0) sEpochTicks = static_cast<int64_t>(mp4web_epoch_seconds_js()) * 40500000LL;
  const uint64_t t = sRendered > sDue ? sRendered : sDue;
  return sEpochTicks + static_cast<int64_t>(t * 10125 / 8) + static_cast<int64_t>(sCalls++);  // 40.5e6/32000 = 1265.625
}

EMSCRIPTEN_KEEPALIVE double mp4web_audio_samples() { return static_cast<double>(sSamplesOut); }

}  // extern "C"

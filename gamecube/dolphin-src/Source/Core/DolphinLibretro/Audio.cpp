#include <libretro.h>
#include "Audio.h"
#include "Common/Logging/Log.h"
#include "Common/Thread.h"
#include "Core/Config/MainSettings.h"
#include "AudioCommon/AudioCommon.h"
#include "VideoCommon/Present.h"
#include "DolphinLibretro/Common/Globals.h"

namespace Libretro
{
namespace Audio
{
retro_audio_sample_batch_t batch_cb = nullptr;

static std::atomic<bool> g_buf_support{false};
static std::atomic<unsigned> g_buf_occupancy{0};
static std::atomic<bool> g_buf_underrun{false};
static int g_use_call_back_audio{0};
static bool g_audio_state_cb{false};
static bool g_is_fast_forwarding{false};

enum CallBackMode
{
  // Dolphin will Push samples into the soundstream
  PUSH_SAMPLES = 0,
  // Samples are pushed per frame in retro_run, but use frame time callback to set pace
  SYNC_PER_FRAME = 1,
  // RetroArch requests audio samples based on its callbacks (target refresh rate/buffer status)
  ASYNC_CALLBACK = 2,
};

unsigned int GetCoreSampleRate()
{
  // when called from retro_run
  SoundStream* sound_stream = Core::System::GetInstance().GetSoundStream();
  double sampleRate = LEGACY_DEFAULT_SAMPLE_RATE;
  if (sound_stream && sound_stream->GetMixer() &&
      sound_stream->GetMixer()->GetSampleRate() != 0)
    return sound_stream->GetMixer()->GetSampleRate();
  // used in Stream constructor
  if (Core::System::GetInstance().IsWii())
    return sampleRate;
  else if (sampleRate == 32000u)
    return 32029;

  return 48043;
}

unsigned int GetRetroSampleRate()
{
  unsigned int sampleRate = DEFAULT_SAMPLE_RATE;

  if(!Libretro::environ_cb(RETRO_ENVIRONMENT_GET_TARGET_SAMPLE_RATE, &sampleRate))
    DEBUG_LOG_FMT(VIDEO, "Get target sample Rate not supported");

  return sampleRate;
}

unsigned int GetActiveSampleRate()
{
  // when called from retro_run
  SoundStream* sound_stream = Core::System::GetInstance().GetSoundStream();

  if (sound_stream && sound_stream->GetMixer() &&
    sound_stream->GetMixer()->GetSampleRate() != 0)
    return sound_stream->GetMixer()->GetSampleRate();

  // this is more or less how the core has used audio for several years
  if(g_use_call_back_audio == CallBackMode::PUSH_SAMPLES)
    return GetCoreSampleRate();

  // alternatively, use the value returned from RetroArch frontend
  return GetRetroSampleRate();
}

void Reset()
{
  g_use_call_back_audio = Libretro::Options::GetCached<int>(Libretro::Options::audio::CALL_BACK_AUDIO,
    CallBackMode::PUSH_SAMPLES);
  g_audio_state_cb = false;
}

void Init()
{
  Reset();

  // don't use any callback, let dolphin push audio samples
  if (g_use_call_back_audio == CallBackMode::PUSH_SAMPLES)
    return;

  retro_audio_callback racb = {};
  racb.callback = &retroarch_audio_cb;
  racb.set_state = &retroarch_audio_state_cb;

  if (!Libretro::environ_cb(RETRO_ENVIRONMENT_SET_AUDIO_CALLBACK, &racb))
  {
    g_use_call_back_audio = CallBackMode::PUSH_SAMPLES;
    DEBUG_LOG_FMT(VIDEO, "Async audio callback not supported; fallback to sync");
    return;
  }

  // check if frame timing call backs were successful
  if(!FrameTiming::IsEnabled())
  {
    g_use_call_back_audio = CallBackMode::PUSH_SAMPLES;
    DEBUG_LOG_FMT(VIDEO, "Async audio callback not enabled as FrameTiming not available");
    return;
  }

  // buffer status callback
  retro_audio_buffer_status_callback bs{};
  bs.callback = &retroarch_audio_buffer_status_cb;

  if (Libretro::environ_cb(RETRO_ENVIRONMENT_SET_AUDIO_BUFFER_STATUS_CALLBACK, &bs))
  {
    g_buf_support.store(true, std::memory_order_relaxed);
    DEBUG_LOG_FMT(VIDEO, "Registered async audio buffer status callback");
  }
  else
  {
    g_buf_support.store(false, std::memory_order_relaxed);
    DEBUG_LOG_FMT(VIDEO, "Audio buffer status callback not supported");
  }
}

inline unsigned GetSamplesForFrame(unsigned sample_rate)
{
  double frame_time_sec =
      FrameTiming::target_frame_duration_usec.load(std::memory_order_relaxed) * 1e-6;
  return std::clamp(static_cast<unsigned>(std::lround(frame_time_sec * sample_rate)),
                    MIN_SAMPLES, MAX_SAMPLES);
}

bool Stream::Init()
{
  // this is called much later than retro_get_system_av_info when not using callbacks
  m_sample_rate = GetActiveSampleRate();

  GetMixer()->SetSampleRate(m_sample_rate);

  return true;
}

bool Stream::IsValid()
{
  if(batch_cb)
    return true;

  return false;
}

void Stream::Update(unsigned int num_samples)
{
  if (g_use_call_back_audio != CallBackMode::PUSH_SAMPLES) {
    return;
  }

  if (!m_mixer || !batch_cb)
    return;

  static unsigned pending = 0;
  pending += num_samples;

  if (pending < MIN_SAMPLES)
    return; // not enough yet

  unsigned avail = pending;
  pending = 0; // consume all

  // First push the minimum threshold block
  m_mixer->Mix(m_buffer, MIN_SAMPLES);
  batch_cb(m_buffer, MIN_SAMPLES);
  avail -= MIN_SAMPLES;

  // Then push any remaining in MAX_SAMPLES chunks
  while (avail > MAX_SAMPLES)
  {
    m_mixer->Mix(m_buffer, MAX_SAMPLES);
    batch_cb(m_buffer, MAX_SAMPLES);
    avail -= MAX_SAMPLES;
  }
  if (avail)
  {
    m_mixer->Mix(m_buffer, avail);
    batch_cb(m_buffer, avail);
  }
}

void Stream::MixAndPush(unsigned int num_samples)
{
  static unsigned pending = 0;
  pending += num_samples;

  if (pending < MIN_SAMPLES)
    return; // not enough yet

  unsigned avail = pending;
  pending = 0; // consume all

  // Then push any remaining in MAX_SAMPLES chunk
  while (avail >= MAX_SAMPLES)
  {
    m_mixer->Mix(m_buffer, MAX_SAMPLES);
    batch_cb(m_buffer, MAX_SAMPLES);
    avail -= MAX_SAMPLES;
  }
  
  if (avail >= MIN_SAMPLES)
  {
    m_mixer->Mix(m_buffer, avail);
    batch_cb(m_buffer, avail);
  }
  else if (avail > 0)
  {
    pending = avail;
  }
}

void Stream::PushAudioForFrame()
{
  if (g_use_call_back_audio != CallBackMode::SYNC_PER_FRAME || !m_mixer || !batch_cb)
    return;

  // Calculate samples needed for this frame at output rate
  unsigned samples_for_frame;
  
  if (FrameTiming::IsEnabled())
  {
    samples_for_frame = GetSamplesForFrame(m_sample_rate);
  }
  else
  {
    if (Libretro::g_core_refresh_rate <= 0.0)
    {
      if (retro_get_region() == RETRO_REGION_NTSC)
        samples_for_frame = m_sample_rate / 60;
      else
        samples_for_frame = m_sample_rate / 50;
    }
    else
    {
      samples_for_frame =
        static_cast<unsigned>(std::lround(m_sample_rate / Libretro::g_core_refresh_rate));
    }
  }
  
  samples_for_frame = std::clamp(samples_for_frame, MIN_SAMPLES, MAX_SAMPLES);

  MixAndPush(samples_for_frame);
}

// Input:
// GameCube DMA: 32029 Hz
// GameCube Streaming: 48043 Hz
// Wii DMA: 32000 Hz
// Wii Streaming: 48000 Hz

// Output is 48000 Hz (Wii) (or 48043 Hz for GameCube)
// Wii: Uses divisor 1125 * 2 = 2250 = exactly 48000 Hz
// GameCube: Uses divisor 1124 * 2 = 2248 = 48043 Hz
void Stream::ProcessCallBack()
{
  if (!m_mixer || !batch_cb || !Libretro::g_emuthread_launched ||
      g_use_call_back_audio != CallBackMode::ASYNC_CALLBACK)
    return;

  // True: Audio driver in frontend is active
  // False: Audio driver in frontend is paused or inactive
  if (!Libretro::Audio::g_audio_state_cb)
    return;

  auto& system = Core::System::GetInstance();
  if (!system.IsSoundStreamRunning())
    return;

  if (Libretro::Audio::g_buf_support.load(std::memory_order_relaxed))
  {
    unsigned occ = Libretro::Audio::g_buf_occupancy.load(std::memory_order_relaxed);

    if (occ >= MAX_SAMPLES)
      return;

    // Use frame time to decide how much to push
    unsigned to_mix = GetSamplesForFrame(m_sample_rate);
    m_mixer->Mix(m_buffer, to_mix);
    batch_cb(m_buffer, to_mix);

    return;
  }

  unsigned to_mix = GetSamplesForFrame(m_sample_rate);
  // Clamp to sane range
  to_mix = std::clamp(to_mix, MIN_SAMPLES, MAX_SAMPLES);
  m_mixer->Mix(m_buffer, to_mix);
  batch_cb(m_buffer, to_mix);
}
} // namespace Audio

namespace FrameTiming
{
  std::atomic<retro_usec_t> target_frame_duration_usec{16667};
  std::atomic<retro_usec_t> measured_frame_duration_usec{16667};
  bool g_have_frame_time_cb {false};

  static retro_frame_time_callback ftcb = {};
  static auto last_frame_time = std::chrono::steady_clock::now();

  void Reset()
  {
    g_have_frame_time_cb = false;
  }

  void Init()
  {
    Reset();

    // Get target refresh rate from frontend
    float refresh_rate = 60.0f;
    if (!Libretro::environ_cb(RETRO_ENVIRONMENT_GET_TARGET_REFRESH_RATE, &refresh_rate))
    {
      DEBUG_LOG_FMT(VIDEO, "frame timing: unable to get target refresh rate");
      return;
    }

    if (refresh_rate < 1.0f)
      refresh_rate = 60.0f;

    // Register frame time callback to track actual frame times
    ftcb.callback = [](retro_usec_t usec) {
      measured_frame_duration_usec.store(usec, std::memory_order_relaxed);
    };
    ftcb.reference = static_cast<retro_usec_t>(1000000.0f / refresh_rate);

    target_frame_duration_usec.store(ftcb.reference, std::memory_order_relaxed);

    if (!Libretro::environ_cb(RETRO_ENVIRONMENT_SET_FRAME_TIME_CALLBACK, &ftcb))
    {
      DEBUG_LOG_FMT(VIDEO, "frame timing: unable to set frame time callback");
      return;
    }

    last_frame_time = std::chrono::steady_clock::now();
    DEBUG_LOG_FMT(VIDEO, "frame timing enabled: target={} usec ({} Hz)",
                  ftcb.reference, refresh_rate);

    // successful callbacks
    g_have_frame_time_cb = true;
  }

  bool IsEnabled()
  {
    return g_have_frame_time_cb;
  }

  bool IsFastForwarding()
  {
    return Libretro::Audio::g_is_fast_forwarding;
  }

  void CheckForFastForwarding()
  {
    if (!Libretro::environ_cb)
      return;

    bool is_fast_forwarding = false;

    // Query the fast-forward state from RetroArch
    if (Libretro::environ_cb(RETRO_ENVIRONMENT_GET_FASTFORWARDING, &is_fast_forwarding))
    {
      Libretro::Audio::g_is_fast_forwarding = is_fast_forwarding;

      if (is_fast_forwarding)
      {
        if (!Config::Get(Config::MAIN_AUDIO_MUTED) &&
            Config::Get(Config::MAIN_AUDIO_MUTE_ON_DISABLED_SPEED_LIMIT))
        {
          Config::SetCurrent(Config::MAIN_AUDIO_MUTED, true);
          AudioCommon::UpdateSoundStream(Core::System::GetInstance());
        }
      }
      else
      {
        if (Config::Get(Config::MAIN_AUDIO_MUTED) &&
                Config::GetActiveLayerForConfig(Config::MAIN_AUDIO_MUTED) ==
                    Config::LayerType::CurrentRun)
        {
          Config::DeleteKey(Config::LayerType::CurrentRun, Config::MAIN_AUDIO_MUTED);
          AudioCommon::UpdateSoundStream(Core::System::GetInstance());
        }
      }

      return;
    }

    // Environment call not supported
    Libretro::Audio::g_is_fast_forwarding = false;
  }

  void ThrottleFrame()
  {
    if (!g_have_frame_time_cb)
      return;

    auto now = std::chrono::steady_clock::now();
    auto elapsed_us = std::chrono::duration_cast<std::chrono::microseconds>(
      now - last_frame_time).count();

    retro_usec_t target_us = target_frame_duration_usec.load(std::memory_order_relaxed);

    if (elapsed_us < target_us)
    {
      auto sleep_us = target_us - elapsed_us;
      if (sleep_us > 1000)
      {
        Common::SleepCurrentThread((sleep_us - 500) / 1000);
      }

      while (std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now() - last_frame_time).count() < target_us)
      {
      }
    }

    last_frame_time = std::chrono::steady_clock::now();
  }
} // namespace FrameTiming
} // namespace Libretro

// Call backs
void retroarch_audio_state_cb(bool enable)
{
  Libretro::Audio::g_audio_state_cb = enable;
}

// Notifies libretro that audio data should be written
void retroarch_audio_cb()
{
  if (auto* s = Core::System::GetInstance().GetSoundStream())
    s->ProcessCallBack();
}

void retroarch_audio_buffer_status_cb(bool active,
                                      unsigned occupancy,
                                      bool underrun_likely)
{
  if (!active)
    DEBUG_LOG_FMT(VIDEO, "retroarch_audio_buffer_status_cb reports that it is not active");

  Libretro::Audio::g_buf_occupancy.store(occupancy, std::memory_order_relaxed);
  Libretro::Audio::g_buf_underrun.store(underrun_likely, std::memory_order_relaxed);
}

// retroarch hooks
extern "C" {

  void retro_set_audio_sample_batch(retro_audio_sample_batch_t cb)
  {
    Libretro::Audio::batch_cb = cb;
  }

  void retro_set_audio_sample(retro_audio_sample_t cb)
  {
  }
} // extern "C"

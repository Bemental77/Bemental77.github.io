#include <libretro.h>
#include <atomic>
#include <condition_variable>
#include "Core/State.h"
#include "Core/System.h"
#include "AudioCommon/SoundStream.h"
#include "Common/Options.h"

namespace Libretro
{
extern double g_core_refresh_rate;
namespace Audio
{
extern retro_audio_sample_batch_t batch_cb;
static constexpr unsigned int MIN_SAMPLES = 96;
static constexpr unsigned int MAX_SAMPLES = 1024;
static constexpr unsigned int DEFAULT_SAMPLE_RATE = 48000;
static constexpr unsigned int LEGACY_DEFAULT_SAMPLE_RATE = 32000;

void Reset();
void Init();
unsigned int GetCoreSampleRate();
unsigned int GetRetroSampleRate();
unsigned int GetActiveSampleRate();

class Stream final : public SoundStream
{
public:
  Stream(unsigned int backendSampleRate = DEFAULT_SAMPLE_RATE)
  : SoundStream(GetActiveSampleRate()) {}

  bool Init() override;
  static bool IsValid();

  bool SetRunning(bool running) override { return true; }

  void PushAudioForFrame();
  void MixAndPush(unsigned int num_samples);
  void Update(unsigned int num_samples) override;

  void ProcessCallBack() override;

private:
  s16 m_buffer[MAX_SAMPLES * 2];
  std::atomic<bool> m_callback_received{false};
  unsigned m_sample_rate{DEFAULT_SAMPLE_RATE};
};

}  // namespace Audio

namespace FrameTiming
{
  extern std::atomic<retro_usec_t> target_frame_duration_usec;
  extern std::atomic<retro_usec_t> measured_frame_duration_usec;
  extern bool g_have_frame_time_cb;

  void Init();
  void Reset();
  bool IsEnabled();
  void CheckForFastForwarding();
  bool IsFastForwarding();
  void ThrottleFrame();
} // namespace FrameTiming

}  // namespace Libretro

void retroarch_audio_cb();
void retroarch_audio_state_cb(bool enable);
void retroarch_audio_buffer_status_cb(bool active, unsigned occupancy, bool underrun);


#include "Common/Logging/Log.h"
#include "Common/Logging/LogManager.h"
#include "DolphinLibretro/Log.h"
#include "DolphinLibretro/Common/Options.h"
#if defined(ANDROID)
#include <android/log.h>
#endif

namespace Libretro
{
extern retro_environment_t environ_cb;
namespace Log
{
class LogListener : public Common::Log::LogListener
{
public:
  LogListener(retro_log_printf_t log);
  ~LogListener() override;
  void Log(Common::Log::LogLevel level, const char* text) override;

private:
  retro_log_printf_t m_log;
};

static std::unique_ptr<LogListener> logListener;

void Init()
{
  struct retro_log_callback log = {};
  if (environ_cb(RETRO_ENVIRONMENT_GET_LOG_INTERFACE, &log) && log.log)
    logListener = std::make_unique<LogListener>(log.log);

  if(logListener)
  {
    Common::Log::LogManager::GetInstance()->RegisterListener(
      Common::Log::LogListener::CUSTOM_LISTENER,
      std::unique_ptr<Common::Log::LogListener>(std::move(logListener))
    );
    Common::Log::LogManager::GetInstance()->EnableListener(Common::Log::LogListener::CUSTOM_LISTENER, true);
    Common::Log::LogManager::GetInstance()->EnableListener(Common::Log::LogListener::LISTENER::CONSOLE_LISTENER, false);
  }
  // Even when no retro_log_callback is registered (the wasm/emscripten case
  // where env_cb doesn't provide GET_LOG_INTERFACE), enable the log types we
  // want CONSOLE_LISTENER to print. Without this, LogManager::IsEnabled
  // returns false for every type (LogManager.cpp:167-171 defaults each
  // m_log[type].m_enable to false) → ALL log messages are dropped before
  // listener dispatch → ConsoleListener::Log is never called → no Patching /
  // OSREPORT / symbols-loaded messages reach the page console.
  auto* mgr = Common::Log::LogManager::GetInstance();
  mgr->SetEnable(Common::Log::LogType::BOOT,               true);
  mgr->SetEnable(Common::Log::LogType::CORE,               true);
  mgr->SetEnable(Common::Log::LogType::OSHLE,              true);  // short name "HLE"
  // OSREPORT is the GAME's own debug output (OSReport: "Rest Memory", "ARAM Trans",
  // "DLL DBG OUT", ...). Games like MP4 spam it every boot step; with DevTools open
  // Chrome rendering that flood throttles the emulator. It is noise for players ->
  // disabled. Re-enable only when debugging guest boot.
  // [crash-narrate 2026-07-07 TEMP] guest reached PPCHalt post-takeover — its
  // OSReport crash message names the unhandled exception. Re-enabled to read it.
  mgr->SetEnable(Common::Log::LogType::OSREPORT,           true);
  mgr->SetEnable(Common::Log::LogType::OSREPORT_HLE,       true);
  mgr->SetEnable(Common::Log::LogType::SYMBOLS,            true);
  mgr->SetEnable(Common::Log::LogType::MEMMAP,             true);
  mgr->SetEnable(Common::Log::LogType::COMMON,             true);
  // Channels needed for native-vs-wasm divergence diagnosis around audio/IRQ
  // boot phase (Logger.ini parity — fresh native log shows DSP_CONTROL halt
  // bit toggles, AX ucode chosen, Audio DMA configured, DBAT updated 542/543,
  // PAD - Get Origin between Arena and game-code entry; none of those
  // surfaced in wasm before because the LogType was disabled at the source).
  mgr->SetEnable(Common::Log::LogType::DSPHLE,             true);
  mgr->SetEnable(Common::Log::LogType::EXPANSIONINTERFACE, true);  // [EXI] (boot, low-freq)
  mgr->SetEnable(Common::Log::LogType::DISCIO,             true);  // disc IO (low-freq)

  // PER-FRAME FLOOD types DISABLED: the native-vs-wasm bring-up diagnosis is done
  // (render fixed 2026-06-25). At NOTICE these [ax-*] traces flooded the page console
  // every VI write / vcount read / FIFO run / PE finish / DMA / SI xfer — with DevTools
  // open that backs up the main thread and stalls the emulator multi-second. POWERPC
  // carries ~27 of these ([ax-vi-timing/beam], [ax-fifo], [ax-di], [ax-present], etc.) so
  // it is disabled too. Re-enable individually only when diagnosing.
  mgr->SetEnable(Common::Log::LogType::POWERPC,            false);
  mgr->SetEnable(Common::Log::LogType::DSP_MAIL,           false);
  mgr->SetEnable(Common::Log::LogType::DSPINTERFACE,       false);
  mgr->SetEnable(Common::Log::LogType::AUDIO,              false);
  mgr->SetEnable(Common::Log::LogType::AUDIO_INTERFACE,    false);  // [AI] [ei-trace]
  mgr->SetEnable(Common::Log::LogType::SERIALINTERFACE,    false);  // [SI]
  mgr->SetEnable(Common::Log::LogType::PROCESSORINTERFACE, false);  // [PI]
  mgr->SetEnable(Common::Log::LogType::VIDEOINTERFACE,     false);  // [VI] [ax-vi-ack]
  mgr->SetEnable(Common::Log::LogType::PIXELENGINE,        false);  // [PE] [ax-pe]
  mgr->SetEnable(Common::Log::LogType::DVDINTERFACE,       false);  // [DVD]
  mgr->SetEnable(Common::Log::LogType::FILEMON,            false);  // file access
}

void Shutdown()
{
  logListener.reset();
}

LogListener::LogListener(retro_log_printf_t log) : m_log(log)
{
  Common::Log::LogManager::GetInstance()->SetConfigLogLevel(
    static_cast<Common::Log::LogLevel>(
        Libretro::Options::GetCached<int>(
            Libretro::Options::main_interface::LOG_LEVEL, static_cast<int>(Common::Log::LogLevel::LINFO))));
  Common::Log::LogManager::GetInstance()->SetEnable(Common::Log::LogType::BOOT, true);
  Common::Log::LogManager::GetInstance()->SetEnable(Common::Log::LogType::CORE, true);
  Common::Log::LogManager::GetInstance()->SetEnable(Common::Log::LogType::VIDEO, true);
  Common::Log::LogManager::GetInstance()->SetEnable(Common::Log::LogType::HOST_GPU, true);
  Common::Log::LogManager::GetInstance()->SetEnable(Common::Log::LogType::COMMON, true);
  Common::Log::LogManager::GetInstance()->SetEnable(Common::Log::LogType::MEMMAP, true);
  Common::Log::LogManager::GetInstance()->SetEnable(Common::Log::LogType::DSPINTERFACE, true);
  Common::Log::LogManager::GetInstance()->SetEnable(Common::Log::LogType::DSPHLE, true);
  Common::Log::LogManager::GetInstance()->SetEnable(Common::Log::LogType::DSPLLE, true);
  Common::Log::LogManager::GetInstance()->SetEnable(Common::Log::LogType::DSP_MAIL, true);
}

LogListener::~LogListener()
{
  auto* mgr = Common::Log::LogManager::GetInstance();
  if (!mgr)
    return;

  mgr->EnableListener(Common::Log::LogListener::CUSTOM_LISTENER, false);
  mgr->EnableListener(Common::Log::LogListener::LISTENER::CONSOLE_LISTENER, true);
  mgr->RegisterListener(Common::Log::LogListener::LISTENER::CONSOLE_LISTENER, nullptr);
}

void LogListener::Log(Common::Log::LogLevel level, const char* text)
{
  switch (level)
  {
  case Common::Log::LogLevel::LDEBUG:
    m_log(RETRO_LOG_DEBUG, text);
    break;
  case Common::Log::LogLevel::LWARNING:
    m_log(RETRO_LOG_WARN, text);
    break;
  case Common::Log::LogLevel::LERROR:
    m_log(RETRO_LOG_ERROR, text);
    break;
  case Common::Log::LogLevel::LNOTICE:
  case Common::Log::LogLevel::LINFO:
  default:
    m_log(RETRO_LOG_INFO, text);
    break;
  }
#if defined(ANDROID) && defined(_DEBUG)
  __android_log_print(ANDROID_LOG_INFO, "DolphinEmuLibretro", "%s", text);
#endif
}
}  // namespace Log
}  // namespace Libretro

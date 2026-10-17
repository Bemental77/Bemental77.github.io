// gamecube/native/src/portmain_web.cpp — Party Board's port_main (src/port/portmain.cpp), for the web:
// the same start-up sequence without its RmlUi front-end (prelaunch / menu bar / overlay), the disc
// image served by the page ("web:", src/web_disc.c), and no pipeline-cache seeding from disk.
#include <SDL3/SDL_filesystem.h>
#include <aurora/aurora.h>
#include <aurora/dvd.h>
#include <aurora/event.h>
#include <aurora/lib/logging.hpp>
#include <aurora/main.h>
#include <dolphin/gx/GXAurora.h>
#include <dolphin/os.h>
#include <dolphin/pad.h>
#include <dolphin/vi.h>
#include <game/disp.h>
#include <port/config.hpp>
#include <port/main.h>
#include <port/dolassets.h>
#include <port/settings.h>
#include <port/port_version.h>
#include <filesystem>
#include <cstdio>

extern "C" int game_main();

AuroraInfo auroraInfo;
std::filesystem::path PartyBoard_ConfigPath;
aurora::Module PartyBoardMainLog("partyboard::main");
static u8 selectedLanguage;
u8 OSGetLanguage() { return selectedLanguage; }

static void aurora_log_callback(AuroraLogLevel level, const char* module, const char* message, unsigned int len) {
  static const char* names[] = {"TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"};
  const int l = static_cast<int>(level);
  std::fprintf(l >= LOG_WARNING ? stderr : stdout, "[%s] [%s] %.*s\n", (l >= 0 && l < 6) ? names[l] : "?", module, static_cast<int>(len), message);
  if (level == LOG_FATAL) { std::fflush(stdout); std::fflush(stderr); std::abort(); }
}

extern "C" int port_main(int argc, char* argv[]) {
  partyboard::registerSettings();
  partyboard::config::FinishRegistration();
  PartyBoard_ConfigPath = "/partyboard";
  std::filesystem::create_directories(PartyBoard_ConfigPath);
  partyboard::config::LoadFromUserPreferences();
  {
    const auto configPathString = PartyBoard_ConfigPath.u8string();
    AuroraConfig config{};
    config.appName = "Party Board";
    config.userPath = reinterpret_cast<const char*>(configPathString.c_str());
    config.vsync = true;
    config.startFullscreen = false;
    config.windowPosX = -1;
    config.windowPosY = -1;
    config.windowWidth = HU_FB_WIDTH * 2;
    config.windowHeight = HU_FB_HEIGHT * 2;
    config.desiredBackend = BACKEND_WEBGPU;
    config.logCallback = &aurora_log_callback;
    config.mem1Size = 64 * 1024 * 1024;
    config.mem2Size = 24 * 1024 * 1024;
    config.allowJoystickBackgroundEvents = false;
    config.pauseOnFocusLost = false;
    config.allowTextureDumps = false;
    config.allowCpuAdapter = true; // the browser chose the adapter; a software one is still WebGPU
    auroraInfo = aurora_initialize(argc, argv, &config);
  }
  if (auroraInfo.backend == BACKEND_NULL) {
    PartyBoardMainLog.error("no WebGPU backend — cannot start");
    return 1;
  }
  AuroraSetViewportPolicy(AURORA_VIEWPORT_FIT);
  if (!aurora_dvd_open("web:")) {
    PartyBoardMainLog.error("Failed to open the disc image the page provided");
    return 1;
  }
  partyboard::version::init();
  InitializeDol();
  const int rc = game_main();
  PartyBoardMainLog.warn("game_main returned {} (running={})", rc, (int)PartyBoard_IsRunning);
  OSResetSystem(OS_RESET_SHUTDOWN, 0, 0);
  aurora_shutdown();
  return 0;
}

int main(int argc, char* argv[]) { return port_main(argc, argv); }

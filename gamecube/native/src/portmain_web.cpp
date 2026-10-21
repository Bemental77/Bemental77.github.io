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
#include <emscripten.h>

// page ?res=N: internal render resolution N x 640x480 (0 = the canvas pixel size). Not game state.
EM_JS(double, mp4web_fb_scale_js, (void), { return (typeof Module.mp4FbScale === 'number') ? Module.mp4FbScale : 0; });

extern "C" int game_main();

AuroraInfo auroraInfo;
std::filesystem::path PartyBoard_ConfigPath;
aurora::Module PartyBoardMainLog("partyboard::main");
static u8 selectedLanguage;
u8 OSGetLanguage() { return selectedLanguage; }

static void aurora_log_callback(AuroraLogLevel level, const char* module, const char* message, unsigned int len) {
  static const char* names[] = {"TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"};
  const int l = static_cast<int>(level);
  if (l < 2) return; // TRACE/DEBUG: aurora logs GX FIFO detail every frame; printing it costs real time
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
    // the callback drops TRACE/DEBUG; with the level at INFO, aurora's Module::report returns before formatting
    // them (~0.9% of a toaster room console's main-thread busy time went to formatting GX FIFO debug lines)
    config.logLevel = LOG_INFO;
    config.mem1Size = 24 * 1024 * 1024;   // hardware MEM1; the game heaps live in the deterministic arena
    config.mem2Size = 16 * 1024 * 1024;   // hardware ARAM
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
  if (const double fbs = mp4web_fb_scale_js(); fbs > 0) VISetFrameBufferScale(static_cast<float>(fbs));
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

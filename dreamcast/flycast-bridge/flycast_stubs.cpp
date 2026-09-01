// flycast_stubs.cpp
//
// Host-ABI stubs for symbols Flycast references that Emscripten doesn't
// natively provide (or that we want to no-op for the embedded WASM build).
//
// PHILOSOPHY
// ----------
// This file is INTENTIONALLY MINIMAL. The patches under
// dreamcast/flycast-bridge/patches/ already disable host backends
// (USE_PULSEAUDIO/USE_ALSA/USE_OSS/USE_LIBAO/USE_VULKAN/USE_DX*/USE_LUA/
// USE_BREAKPAD/USE_HOST_SDL/USE_DISCORD/etc.) and force the GLES3 + libretro
// codepath, so the host-audio / native-window / debugger / achievements code
// paths don't link in the first place.
//
// picotcp and the BBA/modem network code DO compile in (picoppp.cpp and
// friends are unconditionally added to libflycast_libretro.a sources, see
// flycast-src/CMakeLists.txt:814-869). Emscripten provides BSD sockets via
// websockets, so the picotcp glue resolves at link time without stubs.
//
// VMU/save file I/O uses std::filesystem + POSIX file APIs which Emscripten
// supports through MEMFS/IDBFS — no stubs needed here.
//
// Rule for adding stubs: ONLY add them in response to a concrete unresolved-
// symbol error from the actual emcc link. Do not pre-emptively stub things
// "in case". Phantom stubs hide real link breakage.
//
// ---------------------------------------------------------------------------
// Currently shipped stubs: NONE.
// ---------------------------------------------------------------------------
//
// The list below is a PROBABLY-NOT-NEEDED checklist tracking things that
// might surface during the first link. Move an entry into a real stub block
// only after seeing "undefined symbol: <name>" from emcc.
//
// Considered and rejected (with reason):
//
//   pico_*                     — picotcp source files compile into
//                                libflycast_libretro.a directly
//                                (CMakeLists.txt:848-869). All pico_*
//                                symbols are defined in-archive.
//
//   BBA_DISConnect, modem_*    — BBA + modem code lives in core/network/ and
//                                core/hw/maple/ which build into the main
//                                .a unconditionally. No host backend involved.
//
//   audiobackend_pulseaudio_*, — core/audio/CMakeLists.txt gates these on
//   audiobackend_alsa_*, etc.    NOT LIBRETRO (only audiobackend_null builds
//                                in for libretro). Symbols never referenced.
//
//   discord_*, breakpad_*,     — disabled by USE_DISCORD=OFF /
//   lua_*, ggpo_create_*         USE_BREAKPAD=OFF / USE_LUA=OFF gates and
//                                conditional add_subdirectory blocks. Code
//                                is not compiled in.
//
//   pthread_setname_np,        — Emscripten provides these via emscripten_*
//   sysinfo, pipe2, etc.         shims when -pthread is used. The Dolphin
//                                build needed them only because of POSIX
//                                fallback codepaths Flycast does not have.
//
//   __cxa_throw / pthread_*    — Emscripten provides full C++ exception ABI
//                                + libpthread via -pthread (which the link
//                                script enables alongside PROXY_TO_PTHREAD).
//
//   GL/GLES3 entry points      — provided by Emscripten's libGL.js when
//                                -sUSE_WEBGL2=1 -sFULL_ES3=1 is passed
//                                (see flycast_worker_link.sh).
//
//   AICA host thread           — Flycast's AICA mixing runs on the SH4
//                                scheduler under libretro (no separate
//                                std::thread); confirmed by core/hw/aica/
//                                inspection. No HAVE_THREADS gate to flip.
//
// If/when the first link surfaces real unresolveds, add a clearly-commented
// stub here that names the calling Flycast TU and explains why a no-op is
// safe under WASM. Resist the urge to bulk-stub.

// Empty TU. The file is included in the link command line so the build system
// can attach diagnostics / emit ABI shims here without restructuring.
extern "C" int flycast_stubs_marker(void) { return 1; }

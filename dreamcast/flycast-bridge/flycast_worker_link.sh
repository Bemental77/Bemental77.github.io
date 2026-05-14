#!/bin/bash
# flycast_worker_link.sh — link Flycast libretro static archives + bementalJIT
# (SH4 guest enabled) + the bridge TUs into dreamcast/flycast_libretro/
# flycast_worker_emcc.{js,wasm} (loaded by dreamcast/flycast_libretro/flycast_worker.js
# via importScripts). Mirrors gamecube/dolphin-bridge/dolphin_worker_link.sh.
#
# Prerequisite: run the CMake configure + `emmake make flycast_libretro -j4`
# under dreamcast/flycast-src/build-wasm/ first (with the patches under
# dreamcast/flycast-bridge/patches/ applied). This script only does the
# final emcc link of the static archives.

set -euo pipefail

ROOT=/Users/caseybement/Bemental77.github.io
SRC=$ROOT/dreamcast/flycast-src
BUILD=$SRC/build-wasm
BRIDGE=$ROOT/dreamcast/flycast-bridge
OUT=$ROOT/dreamcast/flycast_libretro

# shellcheck disable=SC1091
source $ROOT/emsdk/emsdk_env.sh > /dev/null 2>&1

# ---------------------------------------------------------------------------
# Sanity: the main core archive must already exist.
# ---------------------------------------------------------------------------
MAIN_AR=$BUILD/libflycast_libretro.a
if [ ! -f "$MAIN_AR" ]; then
  echo "ERROR: $MAIN_AR not found." >&2
  echo "Build the libretro static archive first:" >&2
  echo "  cd $BUILD && emmake make flycast_libretro -j4" >&2
  exit 1
fi

mkdir -p "$OUT"

# ---------------------------------------------------------------------------
# Exported functions. Single-underscore prefix on the JS side.
# Matches the public API in EmscriptenWorker.cpp.
# ---------------------------------------------------------------------------
EXPORTED_FUNCS='[
  "_main",
  "_malloc",
  "_free",
  "_emscripten_worker_init",
  "_emscripten_load_disc",
  "_emscripten_run_iter",
  "_emscripten_reset",
  "_emscripten_get_maple_ptr",
  "_emscripten_save_state",
  "_emscripten_load_state",
  "_emscripten_set_video_target",
  "_emscripten_set_audio_ring",
  "_sh4_mem_read8",
  "_sh4_mem_read16",
  "_sh4_mem_read32",
  "_sh4_mem_write8",
  "_sh4_mem_write16",
  "_sh4_mem_write32",
  "_sh4_interp_ifb",
  "_sh4_interp_shil_fb"
]'

EXPORTED_RUNTIME='[
  "ccall",
  "cwrap",
  "getValue",
  "setValue",
  "HEAP8",
  "HEAPU8",
  "HEAP32",
  "HEAPU32",
  "FS",
  "FS_createDataFile",
  "FS_createPath",
  "callMain",
  "stringToNewUTF8"
]'

# ---------------------------------------------------------------------------
# Static archive list.
#
# Per the patches (0003 + 0004) and CMakeLists inspection, almost everything
# (audio backends gated to LIBRETRO, network/picotcp, imgread, hw, oslib,
# input, reios, ui, wsi, etc.) compiles directly into libflycast_libretro.a
# via target_sources(${PROJECT_NAME} PRIVATE ...). The separately-built
# subdirectories that produce their own .a files are:
#
#   - core/deps/xxHash/cmake_unofficial   -> libxxhash.a
#   - core/deps/nowide                    -> libnowide.a
#   - core/deps/libelf                    -> libelf.a
#   - core/deps/libzip                    -> libzip.a
#   - core/deps/libchdr/deps/zlib-1.3.1   -> libzlibstatic.a (target zlibstatic)
#   - core/deps/libchdr/deps/zstd-1.5.6   -> libzstd.a (target libzstd_static)
#   - core/deps/libchdr                   -> libchdr-static.a (target chdr-static)
#   - core/deps/tinygettext               -> libtinygettext.a
#
# Plus our bementalJIT subbuild (added by patch 0003 via add_subdirectory of
# the repo-root bementalJIT into ${CMAKE_BINARY_DIR}/bementalJIT) which emits:
#   - libbementalJIT.a
#   - guests/sh4/libbementalJITSh4.a
#
# Exact subpaths under build-wasm depend on the CMake source-dir layout, hence
# the # TODO markers — confirm with `find $BUILD -name "*.a"` after first
# successful make.
# ---------------------------------------------------------------------------
ARCHIVES=(
  "$BUILD/libflycast_libretro.a"

  # bementalJIT — subbuild placed at ${CMAKE_BINARY_DIR}/bementalJIT
  "$BUILD/bementalJIT/libbementalJIT.a"
  "$BUILD/bementalJIT/guests/sh4/libbementalJITSh4.a"

  # External deps — paths follow add_subdirectory source dirs under build-wasm.
  # TODO: confirm exact path after build (e.g. xxhash CMakeLists is in cmake_unofficial/).
  "$BUILD/core/deps/xxHash/cmake_unofficial/libxxhash.a"
  "$BUILD/core/deps/nowide/libnowide.a"                    # TODO: confirm name (could be libnowide_lib.a)
  "$BUILD/core/deps/libelf/libelf.a"
  "$BUILD/core/deps/libzip/lib/libzip.a"                   # TODO: confirm subpath (libzip CMake puts archive under lib/)
  "$BUILD/core/deps/tinygettext/libtinygettext.a"

  # libchdr + its bundled deps (zlib/zstd) — all under deps/libchdr/...
  "$BUILD/core/deps/libchdr/libchdr-static.a"              # TODO: confirm filename for chdr-static target
  "$BUILD/core/deps/libchdr/deps/zlib-1.3.1/libzlibstatic.a"
  "$BUILD/core/deps/libchdr/deps/zstd-1.5.6/build/cmake/lib/libzstd.a"
)

# ---------------------------------------------------------------------------
# emcc link
# ---------------------------------------------------------------------------
emcc \
  $BRIDGE/EmscriptenWorker.cpp \
  $BRIDGE/flycast_stubs.cpp \
  -I $SRC/core \
  -I $SRC/core/deps \
  -I $SRC/core/deps/libretro-common/include \
  -I $SRC/shell/libretro \
  "${ARCHIVES[@]}" \
  -O3 \
  -std=c++23 \
  -fno-strict-aliasing \
  -fno-exceptions \
  -fomit-frame-pointer \
  -DNDEBUG \
  -D__LIBRETRO__ \
  -pthread \
  -matomics -mbulk-memory \
  -sIMPORTED_MEMORY=1 \
  -sINITIAL_MEMORY=536870912 \
  -sMAXIMUM_MEMORY=4294967296 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sALLOW_TABLE_GROWTH=1 \
  -sPROXY_TO_PTHREAD=1 \
  -sPTHREAD_POOL_SIZE=4 \
  -sASYNCIFY=1 \
  -sUSE_WEBGL2=1 \
  -sFULL_ES3=1 \
  -sENVIRONMENT=worker \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=flycastWorkerModule \
  -sEXIT_RUNTIME=0 \
  -sASSERTIONS=1 \
  -sSTACK_SIZE=8388608 \
  -Wl,--allow-multiple-definition \
  -sEXPORTED_FUNCTIONS="$EXPORTED_FUNCS" \
  -sEXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  --embed-file "$ROOT/dreamcast/bios/Dreamcast/DC - BIOS.bin@/bios/dc_bios.bin" \
  --embed-file "$ROOT/dreamcast/bios/Dreamcast/DC - Flash.bin@/bios/dc_flash.bin" \
  --post-js $BRIDGE/flycast_worker_funcs.js \
  -o $OUT/flycast_worker_emcc.js

echo "linked: $OUT/flycast_worker_emcc.{js,wasm}"

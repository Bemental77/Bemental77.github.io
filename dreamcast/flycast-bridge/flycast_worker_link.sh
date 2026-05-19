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
  "_emscripten_create_gl_context",
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
  "_sh4_interp_shil_fb",
  "_flycast_diag_set",
  "_flycast_diag_ifb"
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
  "stringToNewUTF8",
  "GL",
  "wasmTable"
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
  "$BUILD/libflycast-resources.a"

  # bementalJIT — subbuild placed at ${CMAKE_BINARY_DIR}/bementalJIT
  "$BUILD/bementalJIT/libbementalJIT.a"
  "$BUILD/bementalJIT/guests/sh4/libbementalJITSh4.a"

  # External deps — confirmed against actual build-wasm output (build #8).
  "$BUILD/core/deps/xxHash/cmake_unofficial/libxxhash.a"
  "$BUILD/core/deps/nowide/libnowide.a"
  "$BUILD/core/deps/libelf/libelf.a"
  "$BUILD/core/deps/libzip/lib/libzip.a"
  "$BUILD/core/deps/tinygettext/libtinygettext.a"
  "$BUILD/core/deps/miniupnpc/libminiupnpc.a"

  # libchdr + its bundled deps (zlib/zstd/lzma).
  "$BUILD/core/deps/libchdr/libchdr-static.a"
  "$BUILD/core/deps/libchdr/deps/zlib-1.3.1/libz.a"
  "$BUILD/core/deps/libchdr/deps/zstd-1.5.6/build/cmake/lib/libzstd.a"
  "$BUILD/core/deps/libchdr/deps/lzma-24.05/liblzma.a"
)

# ---------------------------------------------------------------------------
# Diagnostic gate. Two flags share the same env-var toggle:
#   -DFLYCAST_BRIDGE_DIAG compiles in the per-memory-access [gdrom]/[lsb-trip]
#     tracing in EmscriptenWorker.cpp. Drop the flag for release-style builds
#     to collapse sh4_mem_read*/write* into zero-cost ReadMem*/WriteMem*
#     wrappers (kills the runtime g_diag_enabled branch on every guest memory
#     access).
#   -DDEBUG_DISPATCH compiles in the per-dispatch instrumentation in
#     rec_wasm.cpp::mainloop() (per-1000 PC sampler, PC ring buffer, region
#     trap, one-shot instruction dumps, SPG diag counters, 5s [stats] flush,
#     exception ring dump). Strips ~6 [stats]+sampler hot-path branches per
#     dispatch when undefined.
#
#   FLYCAST_RELEASE=1 bash flycast_worker_link.sh   # no DIAG/DEBUG_DISPATCH, faster
#   bash flycast_worker_link.sh                     # both ON (probe-friendly)
# ---------------------------------------------------------------------------
DIAG_FLAGS="-DFLYCAST_BRIDGE_DIAG -DDEBUG_DISPATCH"
if [ -n "${FLYCAST_RELEASE:-}" ]; then
  DIAG_FLAGS=""
  echo "link: FLYCAST_RELEASE=1 — diagnostic trace OFF (no -DFLYCAST_BRIDGE_DIAG / -DDEBUG_DISPATCH)"
else
  echo "link: diagnostic trace ON (-DFLYCAST_BRIDGE_DIAG -DDEBUG_DISPATCH)"
fi

# ---------------------------------------------------------------------------
# emcc link
#
# Real DC BIOS embed (DC - BIOS.bin) is intentionally NOT in the embed list
# below. With it embedded, flycast loads it at boot and runs the real BIOS
# bytes through our SH4 JIT; the JIT misexecutes during BIOS init, leaving
# 0x8c000000-0x8c00DFFF largely zero (no SEGA license data, no syscall
# jumptables). Without the embed, flycast falls back to its Reios HLE BIOS
# which populates the same regions directly via host code and skips the
# misexecuted BIOS path. Confirmed 2026-05-17 by comparing live RAM in
# RedDream (working) vs our build (zeros) at PC wedges 0x8c0000e8,
# 0x8c00cb34, 0x8c00ba8a. To re-enable real BIOS for diagnosis, add:
#   --embed-file "$ROOT/dreamcast/bios/Dreamcast/DC - BIOS.bin@/bios/dc/dc_boot.bin" \
# above the dc_flash.bin embed line.
# ---------------------------------------------------------------------------
emcc \
  $BRIDGE/EmscriptenWorker.cpp \
  $BRIDGE/flycast_stubs.cpp \
  $BRIDGE/rec_wasm.cpp \
  $DIAG_FLAGS \
  -I $SRC/core \
  -I $SRC/core/deps \
  -I $SRC/core/deps/nowide/include \
  -I $SRC/core/deps/xxHash \
  -I $SRC/core/deps/glm \
  -I $SRC/core/deps/stb \
  -I $SRC/core/deps/json \
  -I $SRC/core/deps/asio/asio/include \
  -I $SRC/core/deps/libchdr/include \
  -I $SRC/core/deps/libchdr/deps/zlib-1.3.1 \
  -I $SRC/core/deps/libchdr/deps/zstd-1.5.6/lib \
  -I $SRC/core/deps/libretro-common/include \
  -I $SRC/core/deps/picotcp/include \
  -I $SRC/core/deps/picotcp/modules \
  -I $SRC/core/deps/tinygettext/include \
  -I $SRC/core/deps/miniupnpc/include \
  -I $SRC/core/deps/libzip/lib \
  -I $SRC/core/deps/libelf/include \
  -I $SRC/shell/libretro \
  -I $ROOT/bementalJIT/guests/sh4 \
  -I $ROOT/bementalJIT/include \
  "${ARCHIVES[@]}" \
  -O3 \
  -std=c++23 \
  -fno-strict-aliasing \
  -fomit-frame-pointer \
  -fexceptions \
  -DNDEBUG \
  -D__LIBRETRO__ \
  -pthread \
  -matomics -mbulk-memory -mtail-call \
  -sIMPORTED_MEMORY=1 \
  -sINITIAL_MEMORY=536870912 \
  -sMAXIMUM_MEMORY=4294967296 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sALLOW_TABLE_GROWTH=1 \
  -sPTHREAD_POOL_SIZE=8 \
  -sASYNCIFY=1 \
  -sASYNCIFY_REMOVE='["sh4_mem_read8","sh4_mem_read16","sh4_mem_read32","sh4_mem_write8","sh4_mem_write16","sh4_mem_write32","sh4_interp_ifb","sh4_interp_shil_fb"]' \
  -sUSE_WEBGL2=1 \
  -sFULL_ES3=1 \
  -sMIN_WEBGL_VERSION=2 \
  -sMAX_WEBGL_VERSION=2 \
  -sOFFSCREENCANVAS_SUPPORT=1 \
  -sENVIRONMENT=worker \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=flycastWorkerModule \
  -sEXIT_RUNTIME=0 \
  -sSTACK_SIZE=8388608 \
  -Wl,--allow-multiple-definition \
  -Wl,-u,_emscripten_thread_crashed \
  -Wl,-u,_emscripten_thread_free_data \
  -sEXPORTED_FUNCTIONS="$EXPORTED_FUNCS" \
  -sEXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  --emit-symbol-map \
  -g2 \
  --embed-file "$ROOT/dreamcast/bios/Dreamcast/DC - Flash.bin@/bios/dc/dc_flash.bin" \
  --embed-file "$ROOT/dreamcast/bios/Dreamcast/textures/MK-51193/.placeholder@/bios/dc/textures/MK-51193/.placeholder" \
  --pre-js $BRIDGE/webgl2-compat.js \
  --js-library $BRIDGE/gl_override.js \
  --post-js $BRIDGE/flycast_worker_funcs.js \
  -o $OUT/flycast_worker_emcc.js

echo "linked: $OUT/flycast_worker_emcc.{js,wasm}"

# ---------------------------------------------------------------------------
# Post-build patch: Emscripten 3.1.67 has a bug in pthread_create's
# transferredCanvasNames handling. The comment at the for-of loop site says
# "transferredCanvasNames might be null (so we cannot do a for-of loop)" but
# then immediately does the for-of loop anyway, throwing
# "transferredCanvasNames is not iterable" on first run_iter. Insert the
# missing null guard. If the upstream Emscripten ever fixes this, the sed
# becomes a no-op (won't match) — safe.
# ---------------------------------------------------------------------------
sed -i '' 's|// Note that transferredCanvasNames might be null (so we cannot do a for-of loop)\.$|// Note that transferredCanvasNames might be null (so we cannot do a for-of loop).\
  if (!transferredCanvasNames) transferredCanvasNames = [];  // PATCH: Emscripten 3.1.67 missing null guard|' "$OUT/flycast_worker_emcc.js"
echo "patched: transferredCanvasNames null-guard"

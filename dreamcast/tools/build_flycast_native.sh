#!/bin/bash
#
# build_flycast_native.sh
#
# Configure + build a native (x86_64 / arm64 macOS) flycast standalone
# executable from dreamcast/flycast-src/. Output lands in
#   dreamcast/flycast-src/build-native/
# and on macOS the runnable bundle is build-native/flycast.app.
#
# This native build runs the IDENTICAL SH4 JIT decoder / SHIL pipeline that
# our WASM bridge consumes, just on a host JIT backend instead of WASM emit.
# It is intended as an oracle to A/B against the in-browser build.
#
# Optional flags via env or CLI:
#   ENABLE_LOG=1   -> -DENABLE_LOG=ON  (lifts MAX_LOGLEVEL so
#                                       DEBUG_LOG(DYNAREC, ...) becomes live)
#   JOBS=N         -> override -j parallelism (default: sysctl hw.ncpu)
#
# Defaults turn off heavy-weight optional deps (Vulkan, Lua, Breakpad,
# Discord, libcdio) so the configure step only needs SDL2 + zlib.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../flycast-src" && pwd)"
BUILD_DIR="$SRC_DIR/build-native"

JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 8)}"
BUILD_TYPE="Release"
ENABLE_LOG_FLAG="OFF"
CONFIGURE_ONLY=0
CLEAN=0

usage() {
  cat <<'EOF'
Usage: build_flycast_native.sh [options]

Configure + build standalone native flycast (macOS .app bundle on darwin,
plain executable elsewhere) from dreamcast/flycast-src/.

Options:
  --enable-log         Pass -DENABLE_LOG=ON so DEBUG_LOG(DYNAREC, ...) fires
                       (this is how flycast surfaces per-block JIT activity).
  --debug              Build CMAKE_BUILD_TYPE=Debug (default Release).
  --configure-only     Run cmake configure step but skip make.
  --clean              Delete build-native/ before configuring.
  --jobs N             Parallel make jobs (default: sysctl hw.ncpu).
  -h, --help           Show this help.

Output:
  dreamcast/flycast-src/build-native/flycast        (executable)
  dreamcast/flycast-src/build-native/flycast.app    (macOS bundle)

Notes:
  Requires: cmake >= 3.24 (macOS), SDL2, zlib.
  Optional deps disabled by default for fast configure: Vulkan, Lua,
  Breakpad, Discord, libcdio.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --enable-log)     ENABLE_LOG_FLAG="ON"; shift ;;
    --debug)          BUILD_TYPE="Debug"; shift ;;
    --configure-only) CONFIGURE_ONLY=1; shift ;;
    --clean)          CLEAN=1; shift ;;
    --jobs)           JOBS="$2"; shift 2 ;;
    -h|--help)        usage; exit 0 ;;
    *)                echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

# Allow env override of ENABLE_LOG even without the flag.
if [[ "${ENABLE_LOG:-0}" == "1" ]]; then
  ENABLE_LOG_FLAG="ON"
fi

if [[ "$CLEAN" -eq 1 && -d "$BUILD_DIR" ]]; then
  echo "[build] rm -rf $BUILD_DIR"
  rm -rf "$BUILD_DIR"
fi

mkdir -p "$BUILD_DIR"

echo "[build] source : $SRC_DIR"
echo "[build] build  : $BUILD_DIR"
echo "[build] type   : $BUILD_TYPE   ENABLE_LOG=$ENABLE_LOG_FLAG"
echo "[build] jobs   : $JOBS"

cmake -S "$SRC_DIR" -B "$BUILD_DIR" \
  -DLIBRETRO=OFF \
  -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
  -DENABLE_LOG="$ENABLE_LOG_FLAG" \
  -DUSE_BREAKPAD=OFF \
  -DUSE_VULKAN=OFF \
  -DUSE_LUA=OFF \
  -DUSE_DISCORD=OFF \
  -DUSE_LIBCDIO=OFF \
  -DUSE_HOST_SDL=ON \
  -DUSE_HOST_LIBZIP=ON

if [[ "$CONFIGURE_ONLY" -eq 1 ]]; then
  echo "[build] configure-only: done"
  exit 0
fi

cmake --build "$BUILD_DIR" --config "$BUILD_TYPE" -- -j"$JOBS"

echo
echo "[build] artifacts:"
if [[ -d "$BUILD_DIR/flycast.app" ]]; then
  echo "  bundle    : $BUILD_DIR/flycast.app"
  echo "  exe       : $BUILD_DIR/flycast.app/Contents/MacOS/flycast"
elif [[ -x "$BUILD_DIR/flycast" ]]; then
  echo "  exe       : $BUILD_DIR/flycast"
else
  echo "  (no flycast binary found in $BUILD_DIR — check build log)"
  exit 1
fi

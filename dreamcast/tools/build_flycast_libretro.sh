#!/bin/bash
#
# build_flycast_libretro.sh
#
# Configure + build flycast as a libretro core (.dylib on macOS) from
# dreamcast/flycast-src/. Output lands in
#   dreamcast/flycast-src/build-libretro-native/libflycast_libretro.dylib
#
# This is the same JIT decoder / SHIL pipeline as the standalone build,
# wrapped in libretro's load/run/unload API so it can be hosted under
# RetroArch on the desktop. See tools/setup_retroarch_flycast.md for the
# RetroArch wiring (install location, .cue/.gdi pathing, log inspection).
#
# Optional flags via env or CLI:
#   ENABLE_LOG=1   -> -DENABLE_LOG=ON  (lifts MAX_LOGLEVEL so
#                                       DEBUG_LOG(DYNAREC, ...) becomes live)
#   JOBS=N         -> override -j parallelism (default: sysctl hw.ncpu)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../flycast-src" && pwd)"
BUILD_DIR="$SRC_DIR/build-libretro-native"

JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 8)}"
BUILD_TYPE="Release"
ENABLE_LOG_FLAG="OFF"
CONFIGURE_ONLY=0
CLEAN=0

usage() {
  cat <<'EOF'
Usage: build_flycast_libretro.sh [options]

Configure + build flycast as a native libretro core (.dylib on macOS) from
dreamcast/flycast-src/.

Options:
  --enable-log         Pass -DENABLE_LOG=ON so DEBUG_LOG(DYNAREC, ...) fires.
  --debug              Build CMAKE_BUILD_TYPE=Debug (default Release).
  --configure-only     Run cmake configure step but skip make.
  --clean              Delete build-libretro-native/ before configuring.
  --jobs N             Parallel make jobs (default: sysctl hw.ncpu).
  -h, --help           Show this help.

Output:
  dreamcast/flycast-src/build-libretro-native/libflycast_libretro.dylib

Notes:
  - This build path is what the existing emcc bridge already exercises
    (LIBRETRO=ON), so the native dylib is the closest 1:1 oracle to the
    in-browser path.
  - To wire the resulting dylib into RetroArch on macOS see
    dreamcast/tools/setup_retroarch_flycast.md.
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
  -DLIBRETRO=ON \
  -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
  -DENABLE_LOG="$ENABLE_LOG_FLAG" \
  -DUSE_BREAKPAD=OFF \
  -DUSE_VULKAN=OFF \
  -DUSE_LUA=OFF \
  -DUSE_DISCORD=OFF \
  -DUSE_LIBCDIO=OFF \
  -DUSE_HOST_LIBZIP=ON

if [[ "$CONFIGURE_ONLY" -eq 1 ]]; then
  echo "[build] configure-only: done"
  exit 0
fi

cmake --build "$BUILD_DIR" --config "$BUILD_TYPE" -- -j"$JOBS"

echo
echo "[build] artifact:"
DYLIB="$BUILD_DIR/libflycast_libretro.dylib"
if [[ -f "$DYLIB" ]]; then
  echo "  core      : $DYLIB"
else
  # Some macOS / linker setups emit .so instead of .dylib for libretro.
  SO="$BUILD_DIR/libflycast_libretro.so"
  if [[ -f "$SO" ]]; then
    echo "  core      : $SO"
  else
    echo "  (no libflycast_libretro.{dylib,so} found in $BUILD_DIR — check build log)"
    exit 1
  fi
fi

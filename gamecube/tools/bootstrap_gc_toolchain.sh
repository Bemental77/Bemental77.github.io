#!/bin/bash
# bootstrap_gc_toolchain.sh — make a fresh Linux box (e.g. a cloud session) able to
# run the canonical GameCube loop (CLAUDE.md "GameCube / Dolphin WASM build").
#
# The repo tracks only Source/, CMake/, Tools/ of libretro/dolphin@0cd3bb8
# (.gitignore:27-30); Externals/ and Data/ are not tracked, and build-wasm-4010's
# configure recipe was never committed. This recreates all three:
#   1. ~/emsdk-upstream at 4.0.10 (has the emdawnwebgpu port)
#   2. Externals/ + Data/ from libretro/dolphin@0cd3bb89 (blobless fetch)
#   3. build-wasm-4010 configured
# It does NOT build or link — run the three canonical steps yourself afterwards.
# Idempotent: each step is skipped when its output already exists.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DSRC=$REPO/gamecube/dolphin-src
UP=${DOLPHIN_UPSTREAM:-$HOME/dolphin-upstream}
COMMIT=0cd3bb89c29535db9b7552fc86871867ccf5b471

if [ ! -x "$HOME/emsdk-upstream/emsdk" ]; then
  git clone -q https://github.com/emscripten-core/emsdk.git "$HOME/emsdk-upstream"
  (cd "$HOME/emsdk-upstream" && ./emsdk install 4.0.10 && ./emsdk activate 4.0.10)
fi
source "$HOME/emsdk-upstream/emsdk_env.sh" > /dev/null 2>&1
emcc --version | head -1

if [ ! -d "$DSRC/Externals/fmt" ]; then
  if [ ! -d "$UP/.git" ]; then
    mkdir -p "$UP" && git -C "$UP" init -q
    git -C "$UP" remote add origin https://github.com/libretro/dolphin.git
  fi
  git -C "$UP" fetch -q --filter=blob:none origin '+refs/heads/*:refs/remotes/origin/*'
  git -C "$UP" checkout -q "$COMMIT"
  git -C "$UP" submodule update --init --recursive --depth 1 -q
  cp -r "$UP/Externals" "$DSRC/"
  [ -d "$UP/Data" ] && cp -r "$UP/Data" "$DSRC/"
fi

if [ ! -f "$DSRC/build-wasm-4010/Makefile" ]; then
  # WITH_OPTIM/SSE2/AVX2=OFF: zlib-ng otherwise detects the HOST arch and compiles
  # arch/x86/x86_features.c, which includes <cpuid.h> and fails under wasm32.
  emcmake cmake -S "$DSRC" -B "$DSRC/build-wasm-4010" -G "Unix Makefiles" \
    -DLIBRETRO=ON -DCMAKE_BUILD_TYPE=Release -DENABLE_GENERIC=ON \
    -DENABLE_X11=OFF -DENABLE_EGL=OFF -DENABLE_VULKAN=ON -DUSE_MGBA=OFF -DENABLE_HWDB=OFF \
    -DWITH_OPTIM=OFF -DWITH_SSE2=OFF -DWITH_AVX2=OFF \
    -DCMAKE_C_FLAGS="-pthread -matomics -mbulk-memory" \
    -DCMAKE_CXX_FLAGS="-pthread -matomics -mbulk-memory"
fi
echo "[bootstrap] ready. Link with: DOLPHIN_ROOT=$REPO bash gamecube/dolphin-bridge/dolphin_worker_link_4010.sh"
echo "[bootstrap] probe with:       PROBE_ROOT=$REPO PROBE_CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome ..."

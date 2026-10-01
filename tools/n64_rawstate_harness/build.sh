#!/usr/bin/env bash
# Headless VERIFICATION build of the N64Wasm core: the same C sources and
# compile flags as n64/N64Wasm/code/Makefile, minus mymain.cpp and the
# emscripten ports (SDL2/SDL2_ttf/SDL2_image/zlib port). zlib comes from the
# in-repo n64/N64Wasm/code/zlib; SDL headers are replaced by the two GL
# forwarding stubs in ./stub. It does NOT produce the shipped n64wasm.{js,wasm}
# and it has no page JIT — it exists to test the core's raw savestates in Node
# (run.mjs: rollback exactness; fast.mjs: fast-save ring) when a ports-enabled
# build is not available.
#   EMSDK_ENV=<file that puts emcc 6.0.2 on PATH> bash tools/n64_rawstate_harness/build.sh <outdir>
# then: cd <outdir> && node run.mjs <rom.z64> [warm] [frames]; node fast.mjs <rom.z64> [warm]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="${1:?usage: build.sh <outdir>}"
mkdir -p "$OUT/code" "$OUT/stub"
[ -n "${EMSDK_ENV:-}" ] && source "$EMSDK_ENV"
cp -a "$REPO/n64/N64Wasm/code/." "$OUT/code/"
find "$OUT/code" -name '*.o' -delete
cp -a "$HERE/stub/." "$OUT/stub/"
cp "$HERE/harness.c" "$HERE/run.mjs" "$HERE/fast.mjs" "$OUT/"
cp "$HERE/harness.mk" "$OUT/code/harness.mk"
cd "$OUT/code"
make -f harness.mk HDIR="$OUT" -j"${JOBS:-3}" harness
echo "built $OUT/core.js + core.wasm"

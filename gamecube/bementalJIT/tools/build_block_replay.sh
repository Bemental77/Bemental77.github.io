#!/usr/bin/env bash
# build_block_replay.sh — build the offline replay driver (tools/block_replay.cpp).
#
#   bash gamecube/bementalJIT/tools/build_block_replay.sh <out_dir>
#
# Builds the bementalJIT static libs with emcc into <out_dir>/bjit (the emitter
# is deterministic C++, so the toolchain that compiled it cannot change the wasm
# it EMITS; 4.0.10 is used because it is the canonical dolphin toolchain), then
# links <out_dir>/block_replay.js. Runs under plain `node` — no browser.
#
# -sGLOBAL_BASE=0x02700000 keeps every emcc datum ABOVE the 0x0260_0000..0x026F_FFFF
# SAB-cell window the emitter reads/writes absolutely (same reason as op_census).
set -euo pipefail
OUT="${1:?usage: build_block_replay.sh <out_dir>}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT"
# shellcheck disable=SC1091
source "${EMSDK_ENV:-$HOME/emsdk-upstream/emsdk_env.sh}" >/dev/null 2>&1
emcmake cmake -S "$HERE" -B "$OUT/bjit" -DCMAKE_BUILD_TYPE=Release >/dev/null
emmake make -C "$OUT/bjit" -j"${JOBS:-4}" bementalJIT bementalJITPowerPC bementalJITPowerPCNext >/dev/null
B="$OUT/bjit"
em++ -std=c++2a -O2 -I"$HERE" -I"$HERE/include" "$HERE/tools/block_replay.cpp" \
  "$B/guests/powerpc-next/libbementalJITPowerPCNext.a" "$B/libbementalJIT.a" \
  "$B/guests/powerpc/libbementalJITPowerPC.a" \
  "$B/guests/powerpc-next/libbementalJITPowerPCNext.a" "$B/libbementalJIT.a" \
  -pthread -sPTHREAD_POOL_SIZE=0 \
  -sGLOBAL_BASE=40894464 -sINITIAL_MEMORY=268435456 -sALLOW_MEMORY_GROWTH=1 \
  -sMAXIMUM_MEMORY=1073741824 -sALLOW_TABLE_GROWTH=1 \
  -sNODERAWFS=1 -sEXIT_RUNTIME=1 -sSTACK_SIZE=4194304 \
  -sEXPORTED_RUNTIME_METHODS="['HEAPU8','HEAP8','HEAP16','HEAPU16','HEAP32','HEAPU32','HEAPF32','HEAPF64','UTF8ToString']" \
  --pre-js "$HERE/tools/block_replay_pre.js" \
  -o "$OUT/block_replay.js"
echo "built $OUT/block_replay.js"

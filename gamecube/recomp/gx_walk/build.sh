#!/usr/bin/env bash
# gamecube/recomp/gx_walk/build.sh — builds gx_walk.wasm (no imports, its own fixed memory) from gx_walk.c
# with emsdk-upstream's clang directly (no emscripten runtime: nothing to import).
set -e
cd "$(dirname "$0")"
CLANG="$HOME/emsdk-upstream/upstream/bin/clang"
"$CLANG" --target=wasm32 -O3 -nostdlib -fno-builtin -Wl,--no-entry -Wl,--export-memory \
  -Wl,--initial-memory=33554432 -Wl,--max-memory=33554432 -Wl,-z,stack-size=65536 -o gx_walk.wasm gx_walk.c
echo "gx_walk.wasm $(stat -c %s gx_walk.wasm) bytes, md5 $(md5sum < gx_walk.wasm | cut -c1-8)"

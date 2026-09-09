#!/bin/bash
# Rebuilds snes9x_2005.{js,wasm} in this directory.
#
# Run it with an emsdk on PATH, e.g. from the repo root:
#     source emsdk/emsdk_env.sh && bash snes/snesWasm/build.sh
#
# ── TWO CHANGES FROM THE ORIGINAL ONE-LINER, both forced by the toolchain ────
#
# 1. EXTRA_EXPORTED_RUNTIME_METHODS -> EXPORTED_RUNTIME_METHODS.
#    The old name is a HARD ERROR, not a warning, on every emscripten installed
#    here. Verbatim, from `bash snes/snesWasm/build.sh` under emsdk 6.0.2:
#      emcc: error: invalid command line setting
#      `-sEXTRA_EXPORTED_RUNTIME_METHODS=['cwrap']`: No longer supported, use
#      EXPORTED_RUNTIME_METHODS
#    So this script could not build the core AT ALL until this line changed.
#    Same one-word rename the N64 core took (n64/N64Wasm/code/Makefile:205).
#
# 2. The HEAP views MUST be listed explicitly.
#    Emscripten <= 3.1.x attached every HEAP view to Module unconditionally;
#    6.0.2 attaches one only when it is exported (maybeExportHeap,
#    emsdk/upstream/emscripten/src/runtime_common.js). snes.html reads
#    Module.HEAPU8.buffer (draw/bootRom/saveState) and Module.HEAPF32.buffer
#    (the audio callback), so omitting them makes a WORKING core look dead with
#    "Cannot read properties of undefined (reading 'buffer')". FS is NOT
#    exported here on purpose: this page never touches FS (grep -c 'FS\.'
#    snes.html = 0), unlike the N64 page.
#
# ⚠ Module.calledRun DOES NOT EXIST in the output of this toolchain — it is
# guarded by `#if ASSERTIONS` and never assigned (src/postamble.js). A harness
# that waits on it will report a booting core as dead. Wait on
# Module.onRuntimeInitialized instead.
set -e
cd "$(dirname "$0")"
emcc -O3 -s WASM=1 \
  -s EXPORTED_RUNTIME_METHODS="['cwrap','HEAP8','HEAP16','HEAPU8','HEAPU16','HEAP32','HEAPU32','HEAPF32','HEAPF64']" \
  -s ALLOW_MEMORY_GROWTH=1 \
  source/*.c -o snes9x_2005.js

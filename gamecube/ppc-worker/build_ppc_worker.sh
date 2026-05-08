#!/bin/bash
# Builds the standalone PowerPC JIT worker — bementalJIT + ppc_worker_main
# linked into ppc_worker.{js,wasm}. Phase 2a foundation; the wasm contains
# stub entry points and proves the build path works.
#
# Output: gamecube/ppc-worker/ppc_worker.js  (Emscripten generated)
#         gamecube/ppc-worker/ppc_worker.wasm
set -e

ROOT=/Users/caseybement/Bemental77.github.io
SRC=$ROOT/gamecube/ppc-worker
BJIT_BUILD=$ROOT/bementalJIT/build-emcc
OUT=$ROOT/gamecube/ppc-worker

source $ROOT/emsdk/emsdk_env.sh > /dev/null 2>&1

# Build bementalJIT static libs against emcc if not present.
if [ ! -f "$BJIT_BUILD/libbementalJIT.a" ] || [ ! -f "$BJIT_BUILD/guests/powerpc/libbementalJITPowerPC.a" ]; then
  echo "=== bementalJIT emcc lib build ==="
  mkdir -p "$BJIT_BUILD"
  cd "$BJIT_BUILD"
  emcmake cmake -DCMAKE_BUILD_TYPE=Release "$ROOT/bementalJIT" > /tmp/bjit_cmake.log 2>&1
  emmake make -j4 bementalJIT bementalJITPowerPC > /tmp/bjit_build.log 2>&1
fi

EXPORTED_FUNCS='["_main","_malloc","_free","_ppc_worker_init","_ppc_worker_dispatch","_ppc_worker_shutdown","_ppc_worker_version"]'

EXPORTED_RUNTIME='["ccall","cwrap","getValue","setValue","HEAP8","HEAPU8","HEAP32","HEAPU32"]'

cd "$SRC"
emcc \
  ppc_worker_main.cpp \
  -I "$ROOT/bementalJIT/include" \
  "$BJIT_BUILD/libbementalJIT.a" \
  "$BJIT_BUILD/guests/powerpc/libbementalJITPowerPC.a" \
  -O2 \
  -std=c++17 \
  -pthread \
  -s ENVIRONMENT=worker \
  -s EXIT_RUNTIME=0 \
  -s IMPORTED_MEMORY=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=33554432 \
  -s MAXIMUM_MEMORY=67108864 \
  -s ALLOW_TABLE_GROWTH=1 \
  -s PTHREAD_POOL_SIZE=0 \
  -s "EXPORTED_FUNCTIONS=$EXPORTED_FUNCS" \
  -s "EXPORTED_RUNTIME_METHODS=$EXPORTED_RUNTIME" \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=ppcWorkerModule \
  -s WASM=1 \
  -s ASSERTIONS=1 \
  -o "$OUT/ppc_worker_emcc.js"

echo "linked: $OUT/ppc_worker_emcc.js"
ls -la "$OUT/ppc_worker_emcc.js" "$OUT/ppc_worker_emcc.wasm" 2>/dev/null \
  || ls -la "$OUT/ppc_worker_emcc.js" "$OUT"/*.wasm 2>/dev/null

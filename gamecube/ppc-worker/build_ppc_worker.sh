#!/bin/bash
# Builds the standalone PowerPC JIT worker — bementalJIT + ppc_worker_main
# linked into ppc_worker.{js,wasm}. Phase 2a foundation; the wasm contains
# stub entry points and proves the build path works.
#
# Output: gamecube/ppc-worker/ppc_worker.js  (Emscripten generated)
#         gamecube/ppc-worker/ppc_worker.wasm
set -e

# ---- args ----
MICROBENCH=0
for a in "$@"; do
  case "$a" in
    --microbench) MICROBENCH=1 ;;
    *)            echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

ROOT=/Users/caseybement/Bemental77.github.io
SRC=$ROOT/gamecube/ppc-worker
BJIT_BUILD=$ROOT/gamecube/bementalJIT/build-emcc
OUT=$ROOT/gamecube/ppc-worker

source $ROOT/emsdk/emsdk_env.sh > /dev/null 2>&1

# Build/refresh the bementalJIT static libs against emcc. Configure cmake ONCE (first run),
# but ALWAYS run make so edits to gekko_emit.cpp / block_cache.cpp / any bementalJIT source are
# recompiled into the lib the worker links. make is incremental — a near-no-op when nothing
# changed. Previously the whole block was gated on the .a NOT existing, so any edit after the
# first build silently linked a STALE lib (2026-06-30: cost a full session of JIT instrumentation
# whose markers read as "silent" because they were never compiled into the worker).
if [ ! -f "$BJIT_BUILD/Makefile" ]; then
  echo "=== bementalJIT emcc cmake configure (first run) ==="
  mkdir -p "$BJIT_BUILD"
  cd "$BJIT_BUILD"
  emcmake cmake -DCMAKE_BUILD_TYPE=Release "$ROOT/gamecube/bementalJIT" > /tmp/bjit_cmake.log 2>&1
fi
echo "=== bementalJIT emcc lib build (incremental — recompiles changed sources) ==="
cd "$BJIT_BUILD"
if ! emmake make -j4 bementalJIT bementalJITPowerPC > /tmp/bjit_build.log 2>&1; then
  echo "bementalJIT emcc lib build FAILED — see /tmp/bjit_build.log"; tail -20 /tmp/bjit_build.log; exit 1
fi

EXPORTED_FUNCS='["_main","_malloc","_free","_dolphin_stack_corrupt","_ppc_worker_init","_ppc_worker_dispatch","_ppc_worker_shutdown","_ppc_worker_version","_ppc_worker_peek_u32","_ppc_worker_poke_u32","_ppc_worker_mailbox_post_demo","_ppc_worker_mailbox_call_sync","_ppc_worker_mailbox_call_sync2","_ppc_worker_mmio_read8","_ppc_worker_mmio_read16","_ppc_worker_mmio_read32","_ppc_worker_mmio_write8","_ppc_worker_mmio_write16","_ppc_worker_mmio_write32","_ppc_worker_compile_block","_ppc_worker_compile_buf_addr","_ppc_worker_compile_cycles","_ppc_worker_region_n_funcs","_ppc_worker_compile_and_accumulate","_ppc_worker_relink_region_if_due","_ppc_worker_region_generation","_ppc_worker_region_dispatch_pc","_ppc_worker_force_relink_all","_ppc_worker_ct_queue_init","_ppc_worker_ct_queue_count","_ppc_worker_ct_queue_ready","_ppc_worker_ct_fire_due_pure","_ppc_worker_ct_dolphin_pending_mask","_ppc_worker_ct_publish_event","_ppc_worker_ct_set_phase_flags","_ppc_worker_ct_get_phase_flags","_ppc_worker_ct_global_timer_lo","_ppc_worker_ct_global_timer_hi","_ppc_worker_advance_global_timer","_ppc_worker_set_downcount","_ppc_worker_slice_budget","_ppc_worker_commit_slice","_ppc_worker_set_perf_stub","_ppc_worker_set_hle_check_native","_ppc_worker_get_perf_stub","_ppc_worker_get_hle_check_native","_ppc_worker_run_slice","_ppc_worker_compile_and_register","_ppc_worker_chain_loop_c"'
if [ "$MICROBENCH" = 1 ]; then
  EXPORTED_FUNCS="${EXPORTED_FUNCS},\"_ppc_mb_init_fixture\",\"_ppc_mb_get_handle\",\"_ppc_mb_now_ms\",\"_ppc_mb_run_l0_empty_emasm\",\"_ppc_mb_run_l1_dispatch_raw\",\"_ppc_mb_run_l2_direct\""
fi
EXPORTED_FUNCS="${EXPORTED_FUNCS}]"

EXPORTED_RUNTIME='["ccall","cwrap","getValue","setValue","HEAP8","HEAPU8","HEAP32","HEAPU32"]'

EXTRA_CPPFLAGS=""
OUT_BASENAME="ppc_worker_emcc"
if [ "$MICROBENCH" = 1 ]; then
  EXTRA_CPPFLAGS="-DPPC_WORKER_MICROBENCH=1"
  OUT_BASENAME="ppc_worker_mb"
  echo "=== microbench build (PPC_WORKER_MICROBENCH=1, out=$OUT_BASENAME) ==="
fi

cd "$SRC"
emcc \
  ppc_worker_main.cpp \
  $EXTRA_CPPFLAGS \
  -I "$ROOT/gamecube/bementalJIT/include" \
  "$BJIT_BUILD/libbementalJIT.a" \
  "$BJIT_BUILD/guests/powerpc/libbementalJITPowerPC.a" \
  "$BJIT_BUILD/guests/powerpc-next/libbementalJITPowerPCNext.a" \
  -O2 \
  -std=c++17 \
  -pthread \
  -s ENVIRONMENT=worker \
  -s EXIT_RUNTIME=0 \
  -s IMPORTED_MEMORY=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=536870912 \
  -s MAXIMUM_MEMORY=4294967296 \
  -s GLOBAL_BASE=134217728 \
  `# γ-fix (2026-05-19): push ppc-worker's static-data + dlmalloc heap above` \
  `# 128 MB so the diagnostic SAB region 0x026Bxxxx (~40 MB) isn't clobbered.` \
  `# Without this asymmetry vs dolphin (which already has GLOBAL_BASE=256MB),` \
  `# ppc-worker's heap squats on diagnostic addresses → JIT-emitted sentinel` \
  `# writes to e.g. 0x026B0700 land in a live malloc allocation and get` \
  `# overwritten by BlockCache inserts. SAB layout per sab_layout.h reserves` \
  `# up to 0x026A0000; 128 MB starts well above all documented allocations.` \
  -s ALLOW_TABLE_GROWTH=1 \
  -s PTHREAD_POOL_SIZE=0 \
  -s "EXPORTED_FUNCTIONS=$EXPORTED_FUNCS" \
  -s "EXPORTED_RUNTIME_METHODS=$EXPORTED_RUNTIME" \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=ppcWorkerModule \
  -s WASM=1 \
  -s ASSERTIONS=1 \
  -o "$OUT/${OUT_BASENAME}.js"

echo "linked: $OUT/${OUT_BASENAME}.js"
ls -la "$OUT/${OUT_BASENAME}.js" "$OUT/${OUT_BASENAME}.wasm" 2>/dev/null \
  || ls -la "$OUT/${OUT_BASENAME}.js" "$OUT"/*.wasm 2>/dev/null

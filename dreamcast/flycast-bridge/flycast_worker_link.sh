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

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"  # repo root, derived — no hardcode
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
  "_sh4_jit_lookup_idx",
  "_flycast_set_chain",
  "_flycast_set_ic",
  "_flycast_set_self_loop",
  "_flycast_set_rte_intc",
  "_flycast_ctx_snapshot",
  "_flycast_diag_set",
  "_flycast_diag_ifb",
  "_flycast_set_interp_only",
  "_flycast_set_mem_fastpaths",
  "_flycast_set_regcache",
  "_flycast_set_imm_fastpath",
  "_flycast_set_interp_range",
  "_flycast_run_iter_flag_ptr",
  "_flycast_interp_step_count",
  "_flycast_set_pc_trace_until",
  "_flycast_get_sh4_pc",
  "_sh4_import_fnptrs",
  "_flycast_set_shard",
  "_flycast_set_fog",
  "_flycast_set_modvol",
  "_flycast_guest_cycles"
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
# BUILD FLAVOR GATE.  DEFAULT = RELEASE (clean).  Inverted 2026-08-28.
#
#   bash flycast_worker_link.sh                    # RELEASE (default) — clean;
#                                                  #   the only flavor whose fps,
#                                                  #   boot depth and wedge
#                                                  #   behavior mean anything
#   FLYCAST_DIAG=1       bash flycast_worker_link.sh   # DIAG — tracing, NOT measurable
#   FLYCAST_MICROBENCH=1 bash flycast_worker_link.sh   # one batch timer / 10k dispatches
#   FLYCAST_RELEASE=1    bash flycast_worker_link.sh   # no-op alias for the default
#
# WHY THE DEFAULT IS RELEASE — do not re-flip.  DIAG used to be the default and
# it silently destroyed BOTH the perf numbers and the boot behavior.  Measured
# 2026-08-28 on ONE unmodified tree, two links:
#   DIAG    → /tmp/probe-dcx-load.log : 67,601 of 69,074 lines are the per-access
#             [gdrom] trace (`grep -c '\[gdrom\]'` vs `wc -l`; the probe's own
#             console-line accounting reported 51,867 of 53,319).  The guest never
#             left the disc bootstrap (stuck at pc=0x8c00909a), ZERO frames
#             rendered, 4 milestones — it read exactly like a boot wedge
#             regressed in by unrelated code.
#   RELEASE → /tmp/probe-dcx-dcrel.log: 604 lines, ZERO [gdrom], PSO booted,
#             steady "fps=30 hw=30 video_cb=30/s clk=200MHz", 1940+ video_cb.
# The trace is not merely noisy, it is an OBSERVER EFFECT — EmscriptenWorker.cpp:233-235
# records that the DIAG [gdrom] trace "throttled a poll loop ~1000x and starved
# the clock it was watching".  Nothing about timing, throughput, boot progress
# or "it wedged" can be concluded from a DIAG log, ever.
#
# What each flag compiles in:
#   -DFLYCAST_BRIDGE_DIAG — the per-memory-access [gdrom]/[lsb-trip] trace in
#     EmscriptenWorker.cpp (gdrom_log_r / gdrom_log_w, guarded at :1200-1365 and
#     called from the sh4_mem_read*/write* wrappers at :1369+).  Without it those
#     wrappers collapse to plain ReadMem*/WriteMem* — no per-access branch.
#   -DDEBUG_DISPATCH — per-dispatch instrumentation in rec_wasm.cpp::mainloop()
#     (per-1000 PC sampler, PC ring buffer at :497-501, region trap, one-shot
#     instruction dumps, SPG diag counters, 5s [stats] flush, exception ring).
#
# Both flags reach ONLY the four bridge TUs compiled on the emcc line below;
# the static archives are flavor-independent, so switching flavors needs no
# `emmake make` — a re-link is sufficient.
# ---------------------------------------------------------------------------
DIAG_FLAGS=""
BUILD_FLAVOR="RELEASE"

if [ -n "${FLYCAST_DIAG:-}" ]; then
  DIAG_FLAGS="-DFLYCAST_BRIDGE_DIAG -DDEBUG_DISPATCH"
  BUILD_FLAVOR="DIAG"
fi

# FLYCAST_RELEASE=1 — kept working as a NO-OP alias for the new default so the
# existing docs and muscle memory don't break (CLAUDE.md:65, README.md:54,
# DREAMCAST-60FPS-PROGRAM.md:85-86, dreamcast/docs/lever-3-inline-cache.md:199,
# dreamcast/docs/option2-direct-dispatch/phase7-cleanup.md:289).  If BOTH vars
# are set, RELEASE wins: per the incident above, an accidental DIAG build is the
# expensive direction to be wrong in.
if [ -n "${FLYCAST_RELEASE:-}" ]; then
  if [ "$BUILD_FLAVOR" = "DIAG" ]; then
    echo "link: WARNING — FLYCAST_RELEASE=1 and FLYCAST_DIAG=1 both set; RELEASE wins." >&2
    echo "link:           Unset FLYCAST_RELEASE if you really want the diag trace." >&2
    DIAG_FLAGS=""
  fi
  BUILD_FLAVOR="RELEASE"
fi

# FLYCAST_MICROBENCH=1 — clean per-dispatch cost measurement (phase6 §2).
# Forces the release/clean dispatch path (NO DEBUG_DISPATCH per-dispatch
# timing, NO diag samplers) and compiles in exactly ONE batch timer per 10k
# dispatches. Mutually exclusive with DEBUG_DISPATCH on purpose: the entire
# point is to measure dispatch cost WITHOUT the ~11 emscripten_get_now()/
# dispatch + ring-write samplers the diag path adds (which dominate the diag
# build's own "[cost-breakdown]"). Emits "[mbench] per_dispatch_us=...".
# Deliberately evaluated LAST so it overrides both vars above.
if [ -n "${FLYCAST_MICROBENCH:-}" ]; then
  DIAG_FLAGS="-DDISPATCH_MICROBENCH"
  BUILD_FLAVOR="MICROBENCH"
fi

# ---------------------------------------------------------------------------
# Flavor banner. Printed TWICE on purpose: once here (full link transcript) and
# again as the LAST lines the script emits.
#
# The repeat is load-bearing, not decoration: the canonical loop runs this
# script as `bash "$LINK_SCRIPT" 2>&1 | tail -3` (build_and_probe.sh:98), so
# only the final THREE lines of output ever reach the terminal.  A warning
# printed at the top is invisible exactly where the decision gets made — which
# is why the pre-existing one-line `echo` did not prevent the 2026-08-28
# incident.  The DIAG banner therefore ends with three self-contained warning
# lines and NO closing rule, so `tail -3` shows warning text and nothing else.
# ---------------------------------------------------------------------------
banner_flavor() {
  case "$BUILD_FLAVOR" in
    DIAG)
      echo "################################################################################"
      echo "###                                                                          ###"
      echo "###   D I A G   B U I L D   —   T H I S   B I N A R Y   C A N N O T   B E    ###"
      echo "###                    M E A S U R E D   O R   T R U S T E D                 ###"
      echo "###                                                                          ###"
      echo "###   defines: -DFLYCAST_BRIDGE_DIAG -DDEBUG_DISPATCH   (FLYCAST_DIAG=1)     ###"
      echo "###                                                                          ###"
      echo "###   Measured 2026-08-28, same tree, DIAG vs RELEASE:                       ###"
      echo "###     DIAG    67,601 / 69,074 log lines were the per-access [gdrom] trace, ###"
      echo "###             guest stuck in the disc bootstrap at pc=0x8c00909a,          ###"
      echo "###             ZERO frames, 4 milestones — looked like a boot wedge.        ###"
      echo "###     RELEASE 604 log lines, PSO booted, fps=30 hw=30 video_cb=30/s.       ###"
      echo "###                                                                          ###"
      echo "###   From a DIAG run you may NOT conclude: an fps / MHz / disp-per-second   ###"
      echo "###   number, 'it regressed', 'it wedged', 'no frames', or a boot depth.     ###"
      echo "###   The trace throttles the very poll loop it observes                     ###"
      echo "###   (EmscriptenWorker.cpp:232-235).                                        ###"
      echo "###                                                                          ###"
      echo "################################################################################"
      echo "!!! DIAG BUILD: per-access [gdrom] tracing is ON — it floods the console,     !!!"
      echo "!!! stalls the guest in the disc bootstrap (zero frames), and INVALIDATES     !!!"
      echo "!!! every timing number. Re-link with NO env var before measuring anything.   !!!"
      ;;
    MICROBENCH)
      echo "link: flavor=MICROBENCH (-DDISPATCH_MICROBENCH; DIAG + DEBUG_DISPATCH OFF)"
      echo "link: the ONLY valid output is '[mbench] per_dispatch_us=…'; fps from this"
      echo "link: build is still clean, but the batch timer is the measurement of record."
      ;;
    *)
      echo "link: flavor=RELEASE — clean (no -DFLYCAST_BRIDGE_DIAG / -DDEBUG_DISPATCH)."
      echo "link: perf, boot depth and wedge behavior from this binary are valid."
      echo "link: set FLYCAST_DIAG=1 for the [gdrom]/dispatch trace (not measurable)."
      ;;
  esac
}
banner_flavor

# FLYCAST_NO_ASYNCIFY=1 — lever-8 experimental arm: link WITHOUT asyncify.
# The charter (Phase-3 #3) prescribes measuring the whole-module asyncify
# instrumentation tax on an A/B link; nasomers banked +37% from
# ASYNCIFY_REMOVE alone. Our only remaining async import is __syscall_poll's
# proxied-pthread arm; the shim's suspension guards no-op when nothing
# suspends. If boot/runtime needs a real suspension, the probe will show
# exactly where — restructure that site instead (charter instruction).
ASYNCIFY_FLAGS=(-sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=131072 -sASYNCIFY_REMOVE='["sh4_mem_read8","sh4_mem_read16","sh4_mem_read32","sh4_mem_write8","sh4_mem_write16","sh4_mem_write32","sh4_interp_ifb","sh4_interp_shil_fb","sh4_jit_lookup_idx","flycast_ctx_snapshot"]')
if [ -n "${FLYCAST_NO_ASYNCIFY:-}" ]; then
  ASYNCIFY_FLAGS=(-sASYNCIFY=0)
  echo "link: FLYCAST_NO_ASYNCIFY=1 — lever-8 experimental arm (no asyncify instrumentation)"
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
  $BRIDGE/arm7_rec_wasm.cpp \
  $DIAG_FLAGS \
  `# Flavor string as a preprocessor define, so the bridge can print the` \
  `# flavor from C++ (see the one-line emscripten_worker_init patch in the` \
  `# runtime-marker block at the bottom of this script). Unused TUs ignore it.` \
  -DFLYCAST_BUILD_FLAVOR=\"$BUILD_FLAVOR\" \
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
  `# -mtail-call REMOVED 2026-05-21: clang/LTO converted calls in flycast-src` \
  `# (hw_get_proc_address_cb + GL dispatch) into return_call, which wasm-opt's` \
  `# --asyncify pass fatals on ("tail calls not yet supported in asyncify").` \
  `# Only the diag build (DEBUG_DISPATCH on) happened to dodge it; FLYCAST_RELEASE` \
  `# never linked. The static module does not need tail calls — runtime JIT` \
  `# blocks emit their own return_call bytes via WasmModuleBuilder.` \
  -matomics -mbulk-memory \
  -sIMPORTED_MEMORY=1 \
  `# 128MB not 512MB: the framebuffer + audio ring are heap-allocated by the` \
  `# worker (onRuntimeInitialized) instead of parked at ~496MB, so the` \
  `# up-front commit need not span them. MUST match the WebAssembly.Memory` \
  `# initial= in dreamcast.html.` \
  -sINITIAL_MEMORY=134217728 \
  -sMAXIMUM_MEMORY=4294967296 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sALLOW_TABLE_GROWTH=1 \
  -sPTHREAD_POOL_SIZE=8 \
  "${ASYNCIFY_FLAGS[@]}" \
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

# ---------------------------------------------------------------------------
# Post-build patch: WebGL2 bufferSubData rejects a source view backed by a
# RESIZABLE ArrayBuffer ("The provided ArrayBuffer value must not be
# resizable"). Under -sALLOW_MEMORY_GROWTH the emscripten heap (HEAPU8) is
# exactly that, so flycast's OpenGLRenderer::Render() vertex upload threw a
# TypeError that unwound out of run_iter and PERMANENTLY STOPPED the emulation
# pump — the guest free-ran to the PSO title render, then wedged (frozen
# credit/sched, which read as an SR-mask livelock but was a corpse). Copy the
# range into a fresh non-resizable buffer via .slice() before the upload.
# ROOT FIX BELONGS UPSTREAM (emscripten glue / a memory-growth-aware GL path);
# this sed is the port-local durable fix. No-op if the glue shape changes.
# ---------------------------------------------------------------------------
sed -i '' 's|GLctx.bufferSubData(target, offset, src.subarray(data, data + size));|GLctx.bufferSubData(target, offset, src.slice(data, data + size));  /* PATCH: growable-heap ArrayBuffer is resizable; WebGL2 needs a non-resizable copy */|' "$OUT/flycast_worker_emcc.js"
echo "patched: bufferSubData resizable-ArrayBuffer copy"

# Same resizable-ArrayBuffer trap on TEXTURE uploads: emscriptenWebGLGetTexPixelData
# returns HEAP.subarray(...) (a view on the growable heap) which texImage2D/
# texSubImage2D reject once the heap has grown. Copy to a non-resizable buffer via
# .slice(). Hardening (matches the bufferSubData fix); fixes any post-growth texture
# upload that would otherwise silently fail. No-op if the glue shape changes.
sed -i '' 's|return heap.subarray(toTypedArrayIndex(pixels, heap) >>> 0, toTypedArrayIndex(pixels + bytes, heap) >>> 0);|return heap.slice(toTypedArrayIndex(pixels, heap) >>> 0, toTypedArrayIndex(pixels + bytes, heap) >>> 0);  /* PATCH: growable-heap view is resizable; WebGL2 texImage needs a non-resizable copy */|' "$OUT/flycast_worker_emcc.js"
echo "patched: texImage2D resizable-ArrayBuffer copy"

# ---------------------------------------------------------------------------
# Post-build patch: RUNTIME BUILD-FLAVOR MARKER.
#
# A probe log has to be judgeable on its OWN evidence. /tmp/probe-dcx-*.log
# carries no record of how the binary was linked, so a DIAG log and a RELEASE
# log are indistinguishable artifacts of "the same experiment" — that is how the
# 2026-08-28 DIAG log got read as a boot regression. Every run now prints
# exactly one line before the runtime comes up:
#
#   [build] flavor=RELEASE defines=none linked=… (clean — perf and boot valid)
#   [build] flavor=DIAG defines=-DFLYCAST_BRIDGE_DIAG -DDEBUG_DISPATCH linked=… *** … ***
#
# Route (verified by reading each hop): worker postMessage({cmd:'print'}) →
# dreamcast.html:155 `case 'print': pageLog(d.txt)` → pageLog's console.log
# (dreamcast.html:78) → flycast_probe.js:260 `page.on('console')` → probe log.
# A bare console.log from the worker would NOT do: the probe subscribes to the
# PAGE's console only, so the postMessage hop is the one that matters; the
# console.log is kept for a human with DevTools open on the worker.
#
# Guarded on globalThis.name !== 'em-pthread': pthread children load this same
# file (flycast_worker.js:54-57) and their postMessage goes to the emcc parent
# protocol, which swallows unknown commands.
#
# The text is deliberately free of /RuntimeError|Uncaught|ABORT:/ and of
# "video_cb", so flycast_probe.js:198-207 classify() neither flags it as a
# fatal nor counts it as a frame, and isNoise() (:183-195) does not drop it.
#
# Post-hoc artifact check, no rebuild needed:
#   grep -c -a "flavor=DIAG" dreamcast/flycast_libretro/flycast_worker_emcc.js
# (Independent tell, since EM_ASM bodies are extracted into the glue: a DIAG
#  build's glue also contains the literal "[gdrom] R". On the RELEASE artifact
#  currently on disk both greps return 0 — verified 2026-08-28.)
# ---------------------------------------------------------------------------
MARKER_NOTE=" (clean — perf, boot depth and wedge behavior are valid)"
if [ "$BUILD_FLAVOR" = "DIAG" ]; then
  MARKER_NOTE=" *** DIAG BUILD: per-access [gdrom] trace ON — this log CANNOT support any fps / timing / boot-depth / wedge claim ***"
elif [ "$BUILD_FLAVOR" = "MICROBENCH" ]; then
  MARKER_NOTE=" (microbench — [mbench] per_dispatch_us is the measurement of record)"
fi
cat >> "$OUT/flycast_worker_emcc.js" <<MARKER_EOF

// --- build-flavor marker — INJECTED by flycast_worker_link.sh, do not hand-edit ---
if (typeof globalThis !== 'undefined' && globalThis.name !== 'em-pthread') {
  var __flycastBuildMarker = '[build] flavor=$BUILD_FLAVOR defines=${DIAG_FLAGS:-none} linked=$(date -u '+%Y-%m-%dT%H:%M:%SZ')$MARKER_NOTE';
  try { console.log(__flycastBuildMarker); } catch (e) {}
  try { postMessage({ cmd: 'print', txt: __flycastBuildMarker }); } catch (e) {}
}
MARKER_EOF
echo "patched: runtime [build] flavor marker — every probe log now self-identifies"

# ---------------------------------------------------------------------------
# Final flavor banner. This repeat is the one that survives
# `bash "$LINK_SCRIPT" 2>&1 | tail -3` in build_and_probe.sh:98 — see the
# banner_flavor definition above for why that matters.
# ---------------------------------------------------------------------------
banner_flavor

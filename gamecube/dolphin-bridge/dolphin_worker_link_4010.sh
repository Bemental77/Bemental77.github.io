#!/bin/bash
# dolphin_worker_link_4010.sh — WebGPU (Option B) link variant of dolphin_worker_link.sh.
# Reconstructed 2026-06-29 (the prior copy lived in /tmp and was lost) from the canonical
# script + the recipe in memory gc_webgpu_backend_build_2026_06_26:
#   (1) BUILD  -> build-wasm-4010   (Emscripten 4.0.10 WebGPU build dir)
#   (2) emsdk  -> ~/emsdk-upstream  (4.0.10; the vendored emsdk/ is 3.1.67)
#   (3) +libvideowgpu.a             (after the Vulkan .a)
#   (4) +--use-port=emdawnwebgpu    (after -pthread/-matomics; CANNOT go in the 3.1.67 script)
# [simd 2026-08-28] -msimd128 was tried and DEFERRED, not adopted. Three reasons, recorded so
# it isn't re-litigated: (a) a global compile-flag change invalidates every object in
# build-wasm-4010, forcing a from-scratch rebuild; (b) any v128 opcode makes the WHOLE module
# fail validation on a browser without wasm SIMD — a hard CompileError, not a per-function
# fallback — and wasm SIMD is Safari 16.4+ (iOS 16.4, Mar 2023) vs the 14.5 that -matomics
# already needs, so it raises the Apple mobile floor; (c) the flag alone only permits LLVM
# autovectorization, so the expected win is small next to the measured levers (vertex loader
# ~43%, texture hashing ~16%). Revisit as its own matched-pair A/B, adding it HERE and in
# build-wasm-4010/CMakeCache.txt CMAKE_C_FLAGS + CMAKE_CXX_FLAGS together.
# Output overwrites the live gamecube/dolphin_libretro/dolphin_worker_emcc.{js,wasm}. A backup
# of whatever is live is saved to *.prev.{js,wasm} first so the SW build can be restored.
set -e

ROOT=/Users/caseybement/Bemental77.github.io
BUILD=$ROOT/gamecube/dolphin-src/build-wasm-4010
SRC=$ROOT/gamecube/dolphin-src/Source/Core
BRIDGE=$ROOT/gamecube/dolphin-bridge
OUT=$ROOT/gamecube/dolphin_libretro

source $HOME/emsdk-upstream/emsdk_env.sh > /dev/null 2>&1

# ─────────────────────────────────────────────────────────────────────────────
# MEMORY SIZING — env-overridable, defaults are EXACTLY what shipped before, so a
# plain `bash dolphin_worker_link_4010.sh` still produces the same import limits.
#
# Measured layout of the CURRENT dolphin_worker_emcc.wasm (2026-08-28):
#   import limits          : (memory shared min=8192 max=65536)  = 512 MB / 4096 MB
#   GLOBAL_BASE            : 0x10000000  (268,435,456 = 256 MB)   [flag below]
#   static data (.data+.bss): 0x10000000 .. ~0x11033FB0          (~16.2 MB)
#   stack (STACK_SIZE 8 MB) : ~0x11033FB0 .. 0x11833FB0
#   __stack_pointer init    : 293,960,880 = 0x11833FB0  == __heap_base
# => the linker-legal FLOOR for INITIAL_MEMORY is __heap_base rounded up to a
#    64 KB page: ceil(293960880/65536) = 4486 pages = 294,051,840 B (280.4 MiB).
#    Anything lower is rejected by emcc; there is no way to go under it while
#    GLOBAL_BASE stays at 256 MB.
#
# WHY GLOBAL_BASE is high (this is the analogue of the Dreamcast fixed-address
# problem, and it IS what forces the large initial): the low 256 MB of the shared
# memory is deliberately left free for hard-coded scratch cells that the PAGE and
# ppc-worker write to directly — see dolphin_worker.js:20-25. Highest one in use
# is the GL ctrl block at 0x09100000 + 1 KB (gamecube.html:283,290) = 145.0 MB;
# everything else (PowerPCState 0x02400000, MMIO mirrors 0x0260xxxx, the
# 0x026Bxxxx counters, the WGPU flag 0x07FF0100, the 16 MB GL ring 0x08000000)
# sits below that. So GLOBAL_BASE could in principle drop to 0x0A000000 (160 MB),
# which would put the floor near 192 MB — but that means re-auditing every
# hard-coded offset in gamecube.html, worker_funcs.js, sab_layout.h and the C++
# that reads them. NOT done here.
#
# ⚠ RELINK RULES (WebAssembly import-limit matching):
#   page-provided memory must satisfy  provided.min >= declared.min
#                                 and  provided.max <= declared.max
#   * LOWERING MAXIMUM_MEMORY here REQUIRES a matching lower `maximum:` in
#     gamecube.html:231 or the page dies with a LinkError. Change both together.
#   * LOWERING INITIAL_MEMORY here REQUIRES a relink AND a matching lower
#     `initial:` in gamecube.html:230 to actually save anything — the page's
#     initial is what gets committed.
#   * The page may lower ONLY its `maximum` with NO relink (16384 pages = 1 GB is
#     legal against the declared 65536), and that is the single highest-value
#     mobile change available today: a shared memory reserves its `maximum` as
#     address space up front, and a 4 GB shared reservation is exactly what
#     emscripten#19144 reports failing outright on iOS.
#   Recorded wasm peak is 729 MB (gamecube.html:228) — 1 GB leaves ~40% headroom.
#
# Suggested toaster/mobile pair (apply BOTH, then relink):
#   INITIAL_MEMORY=301989888 MAXIMUM_MEMORY=2147483648 bash <this script>
#   + gamecube.html: initial: 301989888/65536, maximum: 1073741824/65536
INITIAL_MEMORY=${INITIAL_MEMORY:-536870912}
MAXIMUM_MEMORY=${MAXIMUM_MEMORY:-4294967296}
# PTHREAD_POOL_SIZE only controls how many workers are PREWARMED at startup; the
# glue creates more on demand (PThread.getNewWorker allocates + loads when the
# pool is empty and spawnThread uses it immediately), so a smaller pool cannot
# fail pthread_create — it only moves the cost to first spawn. 8 idle Workers,
# each re-parsing 335 KB of glue, is pure waste on a 2-core phone. emscripten
# accepts a JS expression here, e.g.
#   PTHREAD_POOL_SIZE='Math.min(8,navigator.hardwareConcurrency||4)'
# (NOT verified against 4.0.10 in this session — check the emitted glue's
#  `var pthreadPoolSize=` after linking).
PTHREAD_POOL=${PTHREAD_POOL_SIZE:-8}

# ─────────────────────────────────────────────────────────────────────────────
# ASYNCIFY SCOPE — ASYNCIFY=1 with no allowlist and ASYNCIFY_IGNORE_INDIRECT
# unset instruments the whole reachable graph of a ~20 MB module. The ONLY real
# emscripten_sleep in the tree is the WGPU adapter/device request pump at
# VideoBackends/WGPU/WGPUGfx.cpp:100 (every other mention in Source/Core is a
# comment saying explicitly NOT to sleep there), and it runs once inside
# load_iso's rewind — so boot needs Asyncify, steady-state render/JIT should not.
#
#   ASYNCIFY_ADVISE=1 bash dolphin_worker_link_4010.sh
#
# makes emcc print the exact instrumented set. It links to a SCRATCH output so the
# live worker is never clobbered by a diagnostic run.
# PASS/FAIL for that run: if `VertexManagerBase::Flush`, `OpcodeDecoder::RunFifo`,
# `bem_chain_loop_c` and `JitWasm::Run` are NOT in the advised list, this item is
# dead — Asyncify already costs nothing on the hot paths and nothing is owed.
#
# RESULT of that run, 2026-08-29 (log /tmp/asyncify-advise/advise.log, 28707 lines;
# the wasm it emitted is byte-identical to the shipped dolphin_worker_emcc.wasm,
# md5 8ed3e5e38e9ac553f7264b881cf788a1, so it IS a matched baseline): all four are
# present — VertexManagerBase::Flush 44 hits, OpcodeDecoder::RunFifo 20,
# bem_chain_loop_c 8, JitWasm::Run 50. The item is NOT dead. See ASYNCIFY_NARROW
# below for the narrowing that came out of it; the reasons the advise log gives are
# all indirect-call over-approximation ("bem_chain_loop_c ... due to initial", i.e.
# it merely CONTAINS a call_indirect), which is exactly what IGNORE_INDIRECT fixes.
#
# ASYNCIFY_ONLY='@/path/to/list.txt' (or a JSON array) is still wired up below, but
# prefer ASYNCIFY_NARROW: an only-list requires you to enumerate EVERY frame,
# including the direct ones, while IGNORE_INDIRECT + an add-list lets binaryen
# enumerate the direct frames for you and leaves only the indirect entries to name.
ASYNCIFY_FLAGS=( -sASYNCIFY=1 )
OUT_JS=$OUT/dolphin_worker_emcc.js
ADVISE_MODE=0
SCRATCH_MODE=0
if [ "${ASYNCIFY_ADVISE:-0}" = "1" ]; then
  ADVISE_MODE=1
  SCRATCH_MODE=1
  ASYNCIFY_FLAGS+=( -sASYNCIFY_ADVISE=1 )
  OUT_JS=${ASYNCIFY_ADVISE_OUT:-/tmp/asyncify-advise/dolphin_worker_emcc.js}
  mkdir -p "$(dirname "$OUT_JS")"
  echo "[4010] ASYNCIFY_ADVISE=1 — scratch output $OUT_JS, live worker untouched"
fi
# LINK_OUT_JS — link a full (non-advise) worker to a scratch path instead of the
# live one. For A/B measuring a link-flag change (e.g. ASYNCIFY_NARROW below)
# while somebody else is probing the live worker. Nothing in $OUT is read or
# written in this mode: no .prev backup, and the post-build patches below are
# applied to $OUT_JS, not to the live file.
if [ "$ADVISE_MODE" = "0" ] && [ -n "${LINK_OUT_JS:-}" ]; then
  SCRATCH_MODE=1
  OUT_JS=$LINK_OUT_JS
  mkdir -p "$(dirname "$OUT_JS")"
  echo "[4010] LINK_OUT_JS set — scratch output $OUT_JS, live worker untouched"
fi

# ── ASYNCIFY_NARROW — env-gated, DEFAULT OFF, revert by dropping the env var ──
# The advise run above shows the shipped default instruments essentially the whole
# module: `-sASYNCIFY=1` with ASYNCIFY_IGNORE_INDIRECT unset makes binaryen treat
# EVERY call_indirect as able to unwind, so every function that transitively
# reaches one gets the two-global state machine woven through it. It roughly DOUBLES
# the hot slow-path store function — confirmed 2026-08-29 by a matched pair (same
# build-wasm-4010 objects, no rebuild in between; the ONLY delta is the two flags
# this block adds), measured with `wasm-objdump -d` and `wasm-opt --func-metrics`:
#
#   void PowerPC::MMU::WriteToHardware<(XCheckTLBFlag)2 /*Write*/,false>(u32,u32,u32)
#                          OFF (shipped)   ON (ASYNCIFY_NARROW=1)
#     instructions              1690             866     -48.8%
#     `global.get 10`            120               0     (global[10] = asyncify state)
#     binary-bytes              3218            1799     -44.1%
#     IR [total]                1656             845     -49.0%
#
#   866 IS the uninstrumented body: an independent build of this same source with
#   Asyncify off measures 865 instructions. The narrowing removes ~100% of the
#   Asyncify cost here, not merely some of it.
#
#   Other hot functions, `global.get 10` OFF -> ON: JitWasm::Run 1309 -> 0
#   (24867 -> 16002 instrs), bem_chain_loop_c 52 -> 0; and by IR GlobalGet,
#   VertexManagerBase::Flush 687 -> 15, OpcodeDecoder::RunFifo<false> 119 -> 2,
#   CachedInterpreter::Run 46 -> 1.
#   The boot chain STAYS instrumented, which is the whole point: load_iso
#   6696 -> 76, Libretro::Video::ContextReset 185 -> 39,
#   WGPU::VideoBackend::Initialize 133 -> 17 — they keep exactly the checks that
#   follow calls to other still-instrumented callees.
#   Instrumented set 11911 -> 168 functions (1.4%). Module 20,030,106 -> 14,265,162 B.
#
# ASYNCIFY_NARROW=1 flips on ASYNCIFY_IGNORE_INDIRECT and hands binaryen the
# add-list in asyncify_add.txt. That list is NOT "the hot paths"; it is the set of
# frames that are entered through an INDIRECT call while an unwind can be in
# flight. Everything reachable from them by DIRECT calls is added automatically by
# ASYNCIFY_PROPAGATE_ADD (default 1), so a frame can only be missed if it is
# reached indirectly AND is not matched by a pattern in that file.
#
# The module has exactly three imports that can change the asyncify state (from
# the advise output): emscripten_sleep, __wasi_fd_sync, em_libusb_wait_async.
# Their direct-call ancestor sets, from `wasm-opt --print-call-graph` on the
# shipped wasm, are 2 / 16 / 22 functions — and the indirect entries into those
# sets are what asyncify_add.txt names:
#   emscripten_sleep      <- WGPU::VideoBackend::Initialize (WGPUGfx.cpp:100 pump)
#                            <- [virtual] Libretro::Video::ContextReset  <- load_iso
#   __wasi_fd_sync        <- fsync <- Common::IniFile::Save
#                            <- [virtual] ConfigLoaders::*LayerLoader::Save
#                            <- Config::Save  (Config.cpp:132, Layer::Save inlined)
#                            + CPU::CPUManager::StartTimePlayedTimer (thread body)
#   em_libusb_wait_async  <- libusb_handle_events_timeout_completed
#                            <- LibusbUtils::Context::Impl::EventThread (thread body)
#                            + hidapi/Wiimote/IOS-USB/SteamDeck entries, whose
#                              indirect callers are the WiimoteReal / IOS::HLE::USB* /
#                              ControllerInterface / GetDeviceList patterns
#
# ⚠ DO NOT WIDEN THESE PATTERNS "to be safe" — it does the opposite. PROPAGATE_ADD
# walks UPWARD from every match, so a pattern that happens to match a function the
# HOT path calls drags the entire emulator back in. Two measured examples from the
# first draft of this list: `*LibusbUtils::*` matched LibusbUtils::Context::Context(),
# which Core::System::System() calls directly -> bem_chain_loop_c/JitWasm::Run/MMU
# all re-instrumented; `*IOS::HLE::*` matched an ICF-folded
# std::shared_ptr<IOS::HLE::ESDevice>::~shared_ptr() that TextureCacheBase::LoadImpl
# calls -> VertexManagerBase::Flush + OpcodeDecoder::RunFifo re-instrumented. Both
# produced a list that was bigger AND useless. Validate any edit with
#   python3 gamecube/dolphin-bridge/check_asyncify_addlist.py \
#           gamecube/dolphin-bridge/asyncify_add.txt
# BEFORE spending a link — it reproduces binaryen's propagation offline and exits
# nonzero on hot-path leakage. Its two inputs are regenerated by the two wasm-opt
# commands in that script's docstring.
#
# ⚠ FAILURE SIGNATURE if the add-list is incomplete: this does NOT degrade
# gracefully and does NOT show up as a perf regression. An uninstrumented frame
# does not return early when the unwind passes through it — it keeps executing
# with the callee's result undefined — so it fails AT BOOT, hard and immediately:
# the WGPU adapter/device request is the first thing load_iso does, so you get no
# '[wgpu] adapter=OK' line, then either a wasm trap / "RuntimeError: memory access
# out of bounds" / "null function or function signature mismatch" out of load_iso,
# or an `abort("invalid state: N")` from Asyncify.handleSleep in the glue. A page
# that reaches the title screen has already proven the WGPU chain is complete.
# Revert = unset ASYNCIFY_NARROW and re-link. No source file changes are involved.
#
# RESIDUAL RISK, stated honestly. Two of the three unwind sources are closed by
# construction — their whole ancestor set is 2 and 16 functions and every root of
# each is either a wasm export (JS entry, nothing above it) or named in the list:
#   * emscripten_sleep : CLOSED. load_iso -> ContextReset -> Initialize -> sleep.
#     hw_render.context_reset is only ASSIGNED (Video.cpp:213), never invoked
#     in-tree; EmscriptenWorker.cpp:476 calls ContextReset directly.
#   * __wasi_fd_sync    : CLOSED. Note _fd_sync in the glue proxies to the main
#     thread on a pthread and, on MEMFS (no mount.type.syncfs), calls wakeUp()
#     synchronously — handleSleep then returns WITHOUT unwinding. So this one very
#     likely never actually unwinds; it is covered anyway because it is cheap.
#   * em_libusb_wait_async : NOT fully closed, and this is the one to watch. It is
#     a REAL unwind (__asyncjs__em_libusb_wait_async -> Asyncify.handleAsync ->
#     await Atomics.waitAsync). The autonomous path is closed —
#     __thread_proxy -> LibusbUtils::Context::Impl::EventThread ->
#     libusb_handle_events_completed -> ... -> the import. The SYNCHRONOUS paths
#     (WiimoteReal hidapi IO, IOS::HLE USB transfers, ciface::SteamDeck HID) are
#     covered by naming their virtual-dispatch callers, but two of those callers
#     (ControllerInterface::RefreshDevices, WiimoteScanner::ThreadFunc) were
#     inlined away and could not be pinned by name — they are assumed covered by
#     ControllerInterface::PlatformPopulateDevices / *__thread_proxy*. All of these
#     require a real HID/USB device to exist, which a browser worker without
#     WebUSB cannot supply. If a future build gains WebUSB, re-audit this branch.
#
# ⚠ DO NOT SHIP THIS ON UNTIL THE FIFO BACKPRESSURE ITEM IS RESOLVED (78372b6).
# That commit establishes, from the SDK oracle, that this build has NO working GX
# FIFO backpressure: the guest's only brake is the CP overflow interrupt
# (GXOverflowHandler = OSSuspendThread, GXFifo.c:31-51), and this build masks CP
# out of the guest's PI cause read (dolphin_jit_wimports.cpp:338-341), with no
# host-side substitute (MAIN_SYNC_GPU is deliberately OFF). The margin between
# GXInitFifoBase's hiWatermark and real overflow is 16 KB. Under that mechanism ANY
# speedup of the CPU thread is a co-factor for the PSO wedge ("decoder desync ->
# SETDRAWDONE never decoded -> peFrames frozen"), which is how the +34.7%
# import-unwrap fix (e14f728) ended up gated OFF.
#
# ASYNCIFY_NARROW is a CPU-thread speedup, so it is in that class — 78372b6 lists it
# as "untested as a CO-FACTOR". I have NOT measured its effect on the wedge and the
# direction is genuinely unclear from code alone: it speeds up the PRODUCER
# (JitWasm::Run, MMU::WriteToHardware, bem_chain_loop_c) but ALSO the CONSUMER
# (OpcodeDecoder::RunFifo, VertexManagerBase::Flush), and the consumer is the side
# that drains the FIFO. Net effect on the 16 KB margin is unknown. Sequence the work:
# land 78372b6's D3 (host-side watermark drain in GatherPipeBursted) first, then
# re-run this gate's A/B. Until then treat ASYNCIFY_NARROW as a measurement arm.
#
# What 78372b6 does INDEPENDENTLY CONFIRM: it names the same three unwind producers
# this block is built around — _emscripten_sleep, __syscall_fsync's syncfs branch,
# __asyncjs__em_libusb_wait_async — and notes none is reachable at PSO
# character-select. Its refutation of "Asyncify" is about the JS-side export-wrapper
# SEMANTICS (Asyncify.instrumentWasmExports), a different thing from the in-wasm
# instrumentation this flag removes; the two findings do not conflict.
if [ "${ASYNCIFY_NARROW:-0}" = "1" ]; then
  ASYNCIFY_ADD_FILE=${ASYNCIFY_ADD_FILE:-$BRIDGE/asyncify_add.txt}
  ASYNCIFY_FLAGS+=( -sASYNCIFY_IGNORE_INDIRECT=1 -sASYNCIFY_ADD=@"$ASYNCIFY_ADD_FILE" )
  echo "[4010] ASYNCIFY_NARROW=1 — IGNORE_INDIRECT + add-list $ASYNCIFY_ADD_FILE"
  echo "[4010]   VERIFY: emcc must print NO 'Asyncify addlist contained a"
  echo "[4010]   non-existing function name' warning. Any such warning means that"
  echo "[4010]   pattern matched nothing and its frame is UNINSTRUMENTED."
fi
if [ -n "${ASYNCIFY_ONLY:-}" ]; then
  ASYNCIFY_FLAGS+=( -sASYNCIFY_ONLY="$ASYNCIFY_ONLY" )
  echo "[4010] ASYNCIFY_ONLY=$ASYNCIFY_ONLY"
fi
echo "[4010] mem: INITIAL=$INITIAL_MEMORY MAXIMUM=$MAXIMUM_MEMORY pool=$PTHREAD_POOL"

# Preserve the currently-live worker (e.g. the SW build) before overwriting.
if [ "$SCRATCH_MODE" = "0" ] && [ -f "$OUT/dolphin_worker_emcc.wasm" ]; then
  cp -f "$OUT/dolphin_worker_emcc.wasm" "$OUT/dolphin_worker_emcc.prev.wasm"
  cp -f "$OUT/dolphin_worker_emcc.js"   "$OUT/dolphin_worker_emcc.prev.js"
  echo "[4010] backed up live worker -> dolphin_worker_emcc.prev.{js,wasm}"
fi

EXPORTED_FUNCS='["_main","_malloc","_free","_load_iso","_load_state","_save_state","_state_size","_run_iter","_run_iter_batch","_get_pad_ptr","_dolphin_read8","_dolphin_read16","_dolphin_read32","_dolphin_write8","_dolphin_write16","_dolphin_write32","_dolphin_check_exc","_dolphin_break_block","_dolphin_hle_check","_dolphin_hle_fire","_dolphin_interp","_dolphin_msr_updated","_dolphin_gather_drain","_dolphin_get_ram_addr","_dolphin_get_ram_size","_dolphin_get_cp_state","_bem_chain_loop_c","_recomp_render_fifo","_recomp_pause_cpu","_recomp_present","_recomp_efb_peek"]'

EXPORTED_RUNTIME='["ccall","cwrap","getValue","setValue","addFunction","removeFunction","addRunDependency","removeRunDependency","FS","FS_createDataFile","FS_createPath","FS_createDevice","FS_createLazyFile","FS_createPreloadedFile","FS_unlink","callMain","ENV","stringToNewUTF8","HEAP8","HEAPU8","HEAP16","HEAPU16","HEAP32","HEAPU32","HEAPF32","HEAPF64"]'

emcc \
  $BRIDGE/EmscriptenWorker.cpp \
  $BRIDGE/dolphin_stubs.cpp \
  $BRIDGE/dolphin_jit_wimports.cpp \
  -I $BUILD/Source/Core \
  -I $SRC \
  -I $ROOT/gamecube/dolphin-src/Externals/Libretro/Include \
  -I $ROOT/gamecube/dolphin-src/Externals/fmt/fmt/include \
  $BUILD/dolphin_libretro.a \
  $BUILD/libdolphin_libretro_common.a \
  $BUILD/libdolphin_libretro_videocontexts.a \
  $BUILD/Source/Core/UICommon/libuicommon.a \
  $BUILD/Source/Core/InputCommon/libinputcommon.a \
  $BUILD/Source/Core/Core/libcore.a \
  $BUILD/Source/Core/VideoCommon/libvideocommon.a \
  $BUILD/Source/Core/AudioCommon/libaudiocommon.a \
  $BUILD/Source/Core/DiscIO/libdiscio.a \
  $BUILD/Source/Core/VideoBackends/Null/libvideonull.a \
  $BUILD/Source/Core/VideoBackends/OGL/libvideoogl.a \
  $BUILD/Source/Core/VideoBackends/Software/libvideosoftware.a \
  $BUILD/Source/Core/VideoBackends/Vulkan/libvideovulkan.a \
  $BUILD/Source/Core/VideoBackends/WGPU/libvideowgpu.a \
  $BUILD/Source/Core/Common/libcommon.a \
  $BUILD/bementalJIT/libbementalJIT.a \
  $BUILD/bementalJIT/guests/powerpc/libbementalJITPowerPC.a \
  $BUILD/bementalJIT/guests/powerpc-next/libbementalJITPowerPCNext.a \
  $BUILD/Externals/imgui/libimgui.a \
  $BUILD/Externals/implot/libimplot.a \
  $BUILD/Externals/fmt/fmt/libfmt.a \
  $BUILD/Externals/xxhash/libxxhash.a \
  $BUILD/Externals/zstd/zstd/build/cmake/lib/libzstd.a \
  $BUILD/Externals/lz4/lz4/build/cmake/liblz4.a \
  $BUILD/Externals/liblzma/liblzma.a \
  $BUILD/Externals/bzip2/libbzip2.a \
  $BUILD/Externals/zlib-ng/zlib-ng/libz.a \
  $BUILD/Externals/LZO/liblzo2.a \
  $BUILD/Externals/mbedtls/library/libmbedtls.a \
  $BUILD/Externals/mbedtls/library/libmbedcrypto.a \
  $BUILD/Externals/mbedtls/library/libmbedx509.a \
  $BUILD/Externals/minizip-ng/minizip-ng/libminizip-ng.a \
  $BUILD/Externals/pugixml/pugixml/libpugixml.a \
  $BUILD/Externals/tinygltf/libtinygltf.a \
  $BUILD/Externals/FreeSurround/libFreeSurround.a \
  $BUILD/Externals/hidapi/libhidapi.a \
  $BUILD/Externals/libusb/libusb.a \
  $BUILD/Externals/FatFs/libFatFs.a \
  $BUILD/Externals/libspng/libspng/libspng_static.a \
  $BUILD/Externals/cpp-optparse/libcpp-optparse.a \
  $BUILD/Externals/enet/enet/libenet.a \
  $BUILD/Externals/curl/curl/lib/libcurl.a \
  $BUILD/Externals/glslang/glslang/glslang/libglslang.a \
  $BUILD/Externals/glslang/glslang/SPIRV/libSPIRV.a \
  --post-js $BRIDGE/worker_funcs.js \
  -o "$OUT_JS" \
  -O3 \
  -std=c++23 \
  -fno-strict-aliasing \
  -fno-exceptions \
  -fomit-frame-pointer \
  -DNDEBUG \
  -DHAS_OPENGL -DHAS_VULKAN \
  -DUSE_MEMORYWATCHER=1 -DUSE_PIPES=1 \
  -DZSTD_MULTITHREAD -DLZMA_API_STATIC \
  -D_ARCH_32=1 -D_DEFAULT_SOURCE -D_FILE_OFFSET_BITS=64 -D_LARGEFILE_SOURCE \
  -D_M_GENERIC=1 -D__LIBRETRO__ -D__LIBUSB__ \
  -D__STDC_CONSTANT_MACROS -D__STDC_LIMIT_MACROS \
  -pthread \
  -matomics -mbulk-memory \
  --use-port=emdawnwebgpu \
  -sPROXY_TO_PTHREAD=1 \
  -sPTHREAD_POOL_SIZE="$PTHREAD_POOL" \
  -sINITIAL_MEMORY="$INITIAL_MEMORY" \
  -sMAXIMUM_MEMORY="$MAXIMUM_MEMORY" \
  -sALLOW_MEMORY_GROWTH=1 \
  -sIMPORTED_MEMORY=1 \
  -sGLOBAL_BASE=268435456 \
  "${ASYNCIFY_FLAGS[@]}" \
  -sSTACK_SIZE=8388608 \
  -sENVIRONMENT=worker \
  -sNO_EXIT_RUNTIME=1 \
  -sASSERTIONS=0 \
  --profiling-funcs \
  -sALLOW_TABLE_GROWTH=1 \
  -sUSE_WEBGL2=1 \
  -sFULL_ES3=1 \
  -sMIN_WEBGL_VERSION=2 \
  -sMAX_WEBGL_VERSION=2 \
  -sOFFSCREENCANVAS_SUPPORT=1 \
  -sOFFSCREEN_FRAMEBUFFER=1 \
  --pre-js $BRIDGE/webgl2-compat.js \
  --js-library $BRIDGE/gl_override.js \
  -Wl,--allow-multiple-definition \
  -sEXPORTED_FUNCTIONS="$EXPORTED_FUNCS" \
  -sEXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  --embed-file $ROOT/gamecube/IPL.bin@/IPL.bin \
  --embed-file $ROOT/gamecube/dolphin-src/Data/Sys/totaldb.dsy@/totaldb.dsy \
  --embed-file $ROOT/tools/gsne8p.map@/User/Maps/GSNE8P.map \
  --embed-file $ROOT/tools/gpoe8p.map@/User/Maps/GPOE8P.map

if [ "$ADVISE_MODE" = "1" ]; then
  echo "[4010] ASYNCIFY_ADVISE run complete — the advised set is printed above."
  echo "[4010] DEAD-ITEM CHECK: grep the output for VertexManagerBase::Flush,"
  echo "[4010]   OpcodeDecoder::RunFifo, bem_chain_loop_c, JitWasm::Run."
  echo "[4010]   None present => Asyncify is already off the hot paths; nothing owed."
  echo "[4010] Live worker in $OUT was NOT modified."
  exit 0
fi

# Post-build patches (same as canonical; no-op if the target string is absent under WGPU).
# NOTE: these MUST target "$OUT_JS", not the hardcoded live path — under
# LINK_OUT_JS the emitted file is in scratch and the live worker must not be touched.
sed -i '' 's|for(var name of transferredCanvasNames)|if(!transferredCanvasNames)transferredCanvasNames=[];for(var name of transferredCanvasNames)|' "$OUT_JS" || true
node "$BRIDGE/patch_blit_getparameter.mjs" "$OUT_JS" || true
# [2026-07-13] emdawnwebgpu's blend-factor enum table uses Dawn's names 'src1alpha' /
# 'one-minus-src1alpha', but Chrome implements the WebGPU-spec strings 'src1-alpha' /
# 'one-minus-src1-alpha' — createRenderPipeline rejects the Dawn spelling (TypeError, dual-source
# pipelines fail). One global replace fixes both (the long name contains the short one).
sed -i '' 's|src1alpha|src1-alpha|g' "$OUT_JS" || true

echo "linked (WebGPU 4010): $OUT_JS"

#!/bin/bash
# dolphin_worker_link_4010.sh — WebGPU (Option B) link variant of dolphin_worker_link.sh.
# Reconstructed 2026-06-29 (the prior copy lived in /tmp and was lost) from the canonical
# script + the recipe in memory gc_webgpu_backend_build_2026_06_26:
#   (1) BUILD  -> build-wasm-4010   (Emscripten 4.0.10 WebGPU build dir)
#   (2) emsdk  -> ~/emsdk-upstream  (4.0.10; the vendored emsdk/ is 3.1.67)
#   (3) +libvideowgpu.a             (after the Vulkan .a)
#   (4) +--use-port=emdawnwebgpu    (after -pthread/-matomics; CANNOT go in the 3.1.67 script)
# Output overwrites the live gamecube/dolphin_libretro/dolphin_worker_emcc.{js,wasm}. A backup
# of whatever is live is saved to *.prev.{js,wasm} first so the SW build can be restored.
set -e

ROOT=/Users/caseybement/Bemental77.github.io
BUILD=$ROOT/gamecube/dolphin-src/build-wasm-4010
SRC=$ROOT/gamecube/dolphin-src/Source/Core
BRIDGE=$ROOT/gamecube/dolphin-bridge
OUT=$ROOT/gamecube/dolphin_libretro

source $HOME/emsdk-upstream/emsdk_env.sh > /dev/null 2>&1

# Preserve the currently-live worker (e.g. the SW build) before overwriting.
if [ -f "$OUT/dolphin_worker_emcc.wasm" ]; then
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
  -o $OUT/dolphin_worker_emcc.js \
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
  -sPTHREAD_POOL_SIZE=8 \
  -sINITIAL_MEMORY=536870912 \
  -sMAXIMUM_MEMORY=4294967296 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sIMPORTED_MEMORY=1 \
  -sGLOBAL_BASE=268435456 \
  -sASYNCIFY=1 \
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

# Post-build patches (same as canonical; no-op if the target string is absent under WGPU).
sed -i '' 's|for(var name of transferredCanvasNames)|if(!transferredCanvasNames)transferredCanvasNames=[];for(var name of transferredCanvasNames)|' "$OUT/dolphin_worker_emcc.js" || true
node "$BRIDGE/patch_blit_getparameter.mjs" "$OUT/dolphin_worker_emcc.js" || true
# [2026-07-13] emdawnwebgpu's blend-factor enum table uses Dawn's names 'src1alpha' /
# 'one-minus-src1alpha', but Chrome implements the WebGPU-spec strings 'src1-alpha' /
# 'one-minus-src1-alpha' — createRenderPipeline rejects the Dawn spelling (TypeError, dual-source
# pipelines fail). One global replace fixes both (the long name contains the short one).
sed -i '' 's|src1alpha|src1-alpha|g' "$OUT/dolphin_worker_emcc.js" || true

echo "linked (WebGPU 4010): $OUT/dolphin_worker_emcc.js"

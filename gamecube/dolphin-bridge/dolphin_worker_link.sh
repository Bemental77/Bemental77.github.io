#!/bin/bash
# /tmp/dolphin_worker_link.sh — reconstructed 2026-05-03 from dolphin_worker.js fingerprints
# Compiles EmscriptenWorker.cpp + dolphin_stubs.cpp and links with bementalJIT +
# Dolphin static archives → dolphin_worker.{js,wasm}.
set -e

ROOT=/Users/caseybement/Bemental77.github.io
BUILD=$ROOT/gamecube/dolphin-src/build-wasm
SRC=$ROOT/gamecube/dolphin-src/Source/Core
BRIDGE=$ROOT/gamecube/dolphin-bridge
OUT=$ROOT/gamecube/dolphin_libretro

source $ROOT/emsdk/emsdk_env.sh > /dev/null 2>&1

EXPORTED_FUNCS='["_main","_malloc","_free","_dolphin_check_exc","_dolphin_break_block","_dolphin_hle_check","_dolphin_interp","_dolphin_read8","_dolphin_read16","_dolphin_read32","_dolphin_read_tb","_dolphin_write8","_dolphin_write16","_dolphin_write32","_load_iso","_load_state","_save_state","_state_size","_run_iter","_run_iter_batch","_get_pad_ptr"]'

EXPORTED_RUNTIME='["ccall","cwrap","getValue","setValue","addFunction","removeFunction","addRunDependency","removeRunDependency","FS","FS_createDataFile","FS_createPath","FS_createDevice","FS_createLazyFile","FS_createPreloadedFile","FS_unlink","callMain","ENV","stringToNewUTF8","HEAP8","HEAPU8","HEAP16","HEAPU16","HEAP32","HEAPU32","HEAPF32","HEAPF64"]'

emcc \
  $BRIDGE/EmscriptenWorker.cpp \
  $BRIDGE/dolphin_stubs.cpp \
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
  $BUILD/Source/Core/Common/libcommon.a \
  $BUILD/bementalJIT/libbementalJIT.a \
  $BUILD/bementalJIT/guests/powerpc/libbementalJITPowerPC.a \
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
  -o $OUT/dolphin_worker.js \
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
  -sPROXY_TO_PTHREAD=1 \
  -sPTHREAD_POOL_SIZE=4 \
  -sINITIAL_MEMORY=536870912 \
  -sMAXIMUM_MEMORY=4294967296 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sIMPORTED_MEMORY=1 \
  -sASYNCIFY=1 \
  -sSTACK_SIZE=8388608 \
  -sENVIRONMENT=worker \
  -sNO_EXIT_RUNTIME=1 \
  -sASSERTIONS=1 \
  -sALLOW_TABLE_GROWTH=1 \
  -Wl,--allow-multiple-definition \
  -sEXPORTED_FUNCTIONS="$EXPORTED_FUNCS" \
  -sEXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  --embed-file $ROOT/gamecube/IPL.bin@/IPL.bin \
  --embed-file $ROOT/gamecube/dolphin-src/Data/Sys/totaldb.dsy@/totaldb.dsy

echo "linked: $OUT/dolphin_worker.js"

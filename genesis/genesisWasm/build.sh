#!/bin/bash
# Build the Genesis / Mega Drive core for this site.
#
#   bash genesis/genesisWasm/build.sh
#
# Two steps, both run in the foreground so their output is readable:
#   1. emmake the upstream Genesis-Plus-GX libretro core into a wasm object
#      archive (Makefile.libretro platform=emscripten -> STATIC_LINKING=1, so the
#      "TARGET" is an emar archive despite the .bc name).
#   2. emcc that archive together with source/gpgx_shim.c — a libretro frontend
#      written in C — into dist/genesis_plus_gx.{js,wasm}.
#
# The upstream source tree is NOT vendored into this repo (it is ~90 MB and we
# do not patch it). It is cloned to $GPGX_SRC, default ~/gpgx-src, and pinned by
# GPGX_REV so a rebuild reproduces the shipped binary.
#
# Toolchain: the VENDORED emsdk at the repo root (6.0.2 per
# emsdk/upstream/emscripten/emscripten-version.txt). ~/emsdk-upstream (4.0.10)
# is the GameCube WebGPU toolchain and is not needed here — this core has no
# emdawnwebgpu dependency.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
GPGX_SRC="${GPGX_SRC:-$HOME/gpgx-src}"
GPGX_REV="${GPGX_REV:-a7985a9}"          # libretro/Genesis-Plus-GX, fetched 2026-09-06
JOBS="${JOBS:-8}"

echo "== toolchain =="
# shellcheck disable=SC1091
source "$ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1
emcc --version | head -1
cat "$ROOT/emsdk/upstream/emscripten/emscripten-version.txt"

if [ ! -d "$GPGX_SRC/.git" ]; then
  echo "== clone Genesis-Plus-GX -> $GPGX_SRC =="
  git clone --depth 1 https://github.com/libretro/Genesis-Plus-GX.git "$GPGX_SRC"
fi
echo "== core rev =="
git -C "$GPGX_SRC" log --oneline -1

echo "== 1/2 build core archive =="
( cd "$GPGX_SRC" && emmake make -f Makefile.libretro platform=emscripten -j"$JOBS" )
CORE_BC="$GPGX_SRC/genesis_plus_gx_libretro_emscripten.bc"
test -f "$CORE_BC" || { echo "core archive missing: $CORE_BC"; exit 1; }
# The Makefile names the emar archive ".bc", which emcc dispatches on: it tries
# to COMPILE a .bc as bitcode and dies with `!<arch>  error: expected integer`.
# It is an ordinary static archive, so give it the extension it actually is.
CORE_A="$GPGX_SRC/libgenesis_plus_gx.a"
cp -f "$CORE_BC" "$CORE_A"
ls -la "$CORE_A"

echo "== 2/2 link shim + core =="
# libretro-common is DELIBERATELY EXCLUDED from the archive: Makefile.common:62
# guards it with `ifneq ($(STATIC_LINKING), 1)`, because RetroArch supplies those
# symbols itself when a core is linked statically into it. We are the frontend,
# so we must supply them — without this list the link dies with
# `undefined symbol: rfopen / rfseek / rfread / rftell / rfclose` out of
# libchdr_chd.o, yx5200.o and cdd.o (osd.h:169 maps cdStreamOpen -> rfopen).
LRC="$GPGX_SRC/libretro/libretro-common"
COMMON_SRC=(
  "$LRC/streams/file_stream.c"
  "$LRC/streams/file_stream_transforms.c"
  "$LRC/compat/fopen_utf8.c"
  "$LRC/compat/compat_snprintf.c"
  "$LRC/compat/compat_strl.c"
  "$LRC/compat/compat_strcasestr.c"
  "$LRC/compat/compat_posix_string.c"
  "$LRC/encodings/encoding_utf.c"
  "$LRC/file/file_path.c"
  "$LRC/file/retro_dirent.c"
  "$LRC/lists/string_list.c"
  "$LRC/lists/dir_list.c"
  "$LRC/memmap/memalign.c"
  "$LRC/string/stdstring.c"
  "$LRC/vfs/vfs_implementation.c"
)
mkdir -p "$HERE/dist"
emcc -O3 \
  "$HERE/source/gpgx_shim.c" "${COMMON_SRC[@]}" "$CORE_A" \
  -I"$LRC/include" -I"$GPGX_SRC/libretro" -I"$GPGX_SRC/core" \
  -DUSE_LIBRETRO_VFS -D__LIBRETRO__ -DLSB_FIRST -DBYTE_ORDER=LITTLE_ENDIAN \
  -DHAVE_ZLIB -DINLINE="static inline" \
  -o "$HERE/dist/genesis_plus_gx.js" \
  -s WASM=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s GROWABLE_ARRAYBUFFERS=0 \
  -s INITIAL_MEMORY=64MB \
  -s STACK_SIZE=1MB \
  -s ENVIRONMENT=web \
  -s EXIT_RUNTIME=0 \
  -s ASSERTIONS=0 \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAP16","HEAP32","HEAPU32","HEAPF32"]' \
  -s EXPORTED_FUNCTIONS='["_gpx_init","_gpx_load","_gpx_run","_gpx_reset","_gpx_video","_gpx_width","_gpx_height","_gpx_frame_is_new","_gpx_fps","_gpx_sample_rate","_gpx_set_pad","_gpx_audio_avail","_gpx_audio_read","_gpx_audio_buf","_gpx_audio_clear","_gpx_state_size","_gpx_state_save","_gpx_state_load","_gpx_sram_size","_gpx_sram_ptr","_gpx_alloc","_gpx_free","_gpx_set_log","_malloc","_free"]'

# GROWABLE_ARRAYBUFFERS=0 IS A BUG FIX, NOT A TUNING KNOB — MEASURED 2026-09-06.
# emsdk 6.0.2's default (=1) hands the heap out as a RESIZABLE ArrayBuffer
# (emsdk/upstream/emscripten/src/runtime_common.js:117-128 -> wasmMemory
# .toResizableBuffer()), and Chrome 140's TextDecoder REFUSES a view backed by
# one: "TypeError: The provided ArrayBuffer value must not be resizable".
# UTF8ArrayToString only reaches TextDecoder for strings LONGER THAN 16 BYTES
# (the emitted `if (endPtr - idx > 16 ...)`), so it fails selectively and looks
# like a per-ROM emulator bug: X-Men (U) loaded fine while Sonic 3 — which has
# SRAM and so opens a save file — died in ___syscall_openat -> UTF8ToString ->
# UTF8ArrayToString, surfacing to the page as "ROM fetch failed". Setting 0
# keeps ALLOW_MEMORY_GROWTH and returns the plain wasmMemory.buffer instead.
#
# EXPORTED_RUNTIME_METHODS is not optional under emsdk 6.0.2: it attaches ONLY
# what is exported to Module (src/runtime_common.js), where <=3.1.x attached
# every HEAP* view unconditionally. n64/index.html died on Module.HEAP16.buffer
# for exactly this reason (CLAUDE.md, GameCube build-flow block).

ls -la "$HERE/dist/genesis_plus_gx.js" "$HERE/dist/genesis_plus_gx.wasm"
md5 "$HERE/dist/genesis_plus_gx.js" "$HERE/dist/genesis_plus_gx.wasm" 2>/dev/null \
  || md5sum "$HERE/dist/genesis_plus_gx.js" "$HERE/dist/genesis_plus_gx.wasm"
echo "== done =="

#!/usr/bin/env bash
# gamecube/native/build.sh — Mario Party 4 as a SOURCE PORT for the web: Party Board (the MP4
# decomp's PC port, CC0) on Aurora (its GameCube->PC layer, MIT), compiled with Emscripten 4.0.10
# (~/emsdk-upstream) against the emdawnwebgpu + SDL3 ports. Nothing from the disc is in the build:
# the page (mp4-native.html) feeds the disc image at run time, as gamecube.html does.
#
#   SRC=/home/user/mariopartyrd   partyboard/ (mariopartyrd/partyboard, branch audio 3ceaebf), aurora/ (its
#                                 submodule extern/aurora 5143394)
#   MX=/home/user/mp4native/src2/musyx   AxioDL/musyx dc56c92 (the PC renderer the audio branch uses)
#   DEPS=/home/user/mp4native/deps  SDL-release-3.2.4, abseil lts_20240722, fmt 11.1.4, imgui 1.91.9b,
#                                 xxhash 0.8, nlohmann_json, sqlite-amalgamation-3510300
#   BUILD=/home/user/mp4native/build   (objects ~10 MB; out/mp4native.{js,wasm})
#   STAGE=aurora|game|rel|link|all (default all)
# Source patches (apply once to fresh checkouts): patches/aurora.patch (git apply in aurora/),
# patches/partyboard.patch (in partyboard/), patches/musyx.patch (patch -p1 in musyx/),
# patches/imgui.patch (patch -p1 in DEPS/imgui).
# Then: copy BUILD/out/mp4native.{js,wasm} to gamecube/native/dist/ and BUILD/out/rb/* to dist/rb/, and open
# /mp4-native.html (solo loads dist/, a room loads dist/rb/).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${SRC:-/home/user/mariopartyrd}"; DEPS="${DEPS:-/home/user/mp4native/deps}"; BUILD="${BUILD:-/home/user/mp4native/build}"
STAGE="${STAGE:-all}"; JOBS="${JOBS:-4}"
source "$HOME/emsdk-upstream/emsdk_env.sh" > /dev/null 2>&1
# the SDL3 port from a local checkout (this box cannot download GitHub archives): git clone -b release-3.2.4
export EMCC_LOCAL_PORTS="sdl3=${SDL3_DIR:-$DEPS/SDL-release-3.2.4}"
AU="$SRC/aurora"; PB="$SRC/partyboard"; MX="${MX:-/home/user/mp4native/src2/musyx}"
mkdir -p "$BUILD/obj" "$BUILD/gen/extern"
# Party Board's generated version header (its CMake writes it from git describe)
cat > "$BUILD/gen/version.h" <<VEOF
#ifndef VERSION_H
#define VERSION_H
#define PARTY_BOARD_WC_DESCRIBE "web"
#define PARTY_BOARD_VERSION_STRING "0.0.0.0"
#define PARTY_BOARD_WC_BRANCH "web"
#define PARTY_BOARD_WC_REVISION "$(git -C "$SRC/partyboard" rev-parse --short HEAD 2>/dev/null || echo unknown)"
#define PARTY_BOARD_WC_DATE ""
#define PARTY_BOARD_BUILD_TYPE "Release"
#define PARTY_BOARD_ARCH "wasm32"
#define PARTY_BOARD_PLATFORM_NAME "web"
#define PARTY_BOARD_DLPACKAGE "partyboard-web-" PARTY_BOARD_PLATFORM_NAME "-" PARTY_BOARD_ARCH
#define PARTY_BOARD_SENTRY_DSN ""
#define PARTY_BOARD_SENTRY_ENVIRONMENT ""
#endif
VEOF
ln -sfn "$SRC/aurora" "$BUILD/gen/extern/aurora"   # sources include <aurora/...> via extern/
PORTS=(--use-port=emdawnwebgpu -sUSE_SDL=3 -sUSE_ZLIB=1 -sUSE_LIBPNG=1)
COMMON=(-O2 -mbulk-memory "${PORTS[@]}" -DAURORA -DTARGET_PC -DAURORA_ENABLE_GX -DAURORA_WEB=1
        -I"$HERE/shim" -I"$AU/include" -I"$AU/lib"
        -I"$DEPS/fmt/include" -I"$DEPS/xxhash" -I"$DEPS/abseil" -I"$DEPS/imgui" -I"$DEPS/imgui/backends" -I"$DEPS/sqlite-amalgamation-3510300" -I"$DEPS/nlohmann_json/single_include"
        -Wno-unused-command-line-argument -Wno-c++11-narrowing)
CXXF=(-std=c++20 "${COMMON[@]}")
CF=(-std=gnu11 "${COMMON[@]}")
# compile one source to $BUILD/obj/<tag>__<flattened path>.o (skips if up to date); prints FAIL lines
cc1() {
  local tag="$1" src="$2"; shift 2
  local o="$BUILD/obj/${tag}__$(echo "$src" | sed "s#^$SRC/##; s#^$DEPS/##; s#[/.]#_#g").o"
  [ -f "$o" ] && [ "$o" -nt "$src" ] && return 0
  case "$src" in
    *.c) emcc "${CF[@]}" $([ "$tag" = game ] && echo -include "$HERE/shim/det_alloc.h") "$@" -c "$src" -o "$o" 2> "$o.log" || { echo "FAIL $src"; head -c 1500 "$o.log"; return 1; } ;;
    # Party Board's C++ uses try/catch (config load, settings): JS-based EH, which Asyncify supports
    *)   em++ "${CXXF[@]}" $([ "$tag" = game ] && echo -fexceptions) "$@" -c "$src" -o "$o" 2> "$o.log" || { echo "FAIL $src"; head -c 1500 "$o.log"; return 1; } ;;
  esac
  rm -f "$o.log"
}
export -f cc1; export BUILD SRC DEPS
export CF_STR="${CF[*]}" CXXF_STR="${CXXF[*]}"
aurora_srcs() {
  for f in $(grep -ohE "lib/[A-Za-z0-9_/.-]+\.(cpp|c)" "$AU"/cmake/aurora_{core,gx,gd,os,pad,si,vi,mtx,card,main}.cmake | sort -u); do
    # OSAlloc.cpp: Party Board's src/port/OS.c defines the same heap API (natively the archive member is never pulled)
    case "$f" in lib/rmlui*|lib/dawn/*|lib/system_info_mac.mm|lib/dolphin/os/OSAlloc.cpp) continue;; esac
    # plain-data HLE state the game mutates (ARAM allocator, OS arena): linked inside the game-state
    # range instead (gau_srcs), so a rollback restores it with the game
    case "$f" in lib/dolphin/AR.cpp|lib/dolphin/os/OSArena.cpp|lib/dolphin/gx/GXTexture.cpp) continue;; esac
    echo "$AU/$f"
  done
  echo "$DEPS/fmt/src/format.cc"; echo "$DEPS/xxhash/xxhash.c"
  for f in imgui imgui_draw imgui_tables imgui_widgets imgui_demo; do echo "$DEPS/imgui/$f.cpp"; done
  echo "$DEPS/imgui/backends/imgui_impl_sdl3.cpp"; echo "$DEPS/imgui/backends/imgui_impl_sdlrenderer3.cpp"; echo "$DEPS/imgui/backends/imgui_impl_wgpu.cpp"
  echo "$DEPS/sqlite-amalgamation-3510300/sqlite3.c"
  echo "$AU/lib/dolphin/dvd/dvd.cpp"; echo "$AU/lib/dolphin/dvd/fst.cpp"; echo "$HERE/src/web_disc.c"
  echo "$HERE/src/web_port.cpp"   # outside the game's statics on purpose: its timing counters are not game state
  echo "$HERE/src/rollback.c"     # outside them too: the undo logs must not log themselves
  for f in hash/internal/hash.cc hash/internal/city.cc hash/internal/low_level_hash.cc container/internal/raw_hash_set.cc \
           base/internal/raw_logging.cc base/internal/throw_delegate.cc; do echo "$DEPS/abseil/absl/$f"; done
}
gau_srcs() { echo "$AU/lib/dolphin/AR.cpp"; echo "$AU/lib/dolphin/os/OSArena.cpp"; echo "$AU/lib/dolphin/gx/GXTexture.cpp"; }   # + the tex/tlut object id counters the game stores
build_list() {   # tag, file list on stdin, extra flags...
  local tag="$1"; shift; local fails=0
  while read -r f; do cc1 "$tag" "$f" "$@" || fails=$((fails + 1)); done
  echo "[$tag] failures: $fails"
}
if [ "$STAGE" = aurora ] || [ "$STAGE" = all ]; then
  aurora_srcs | grep -v imgui_impl_wgpu | build_list au
  echo "$DEPS/imgui/backends/imgui_impl_wgpu.cpp" | build_list au -DIMGUI_IMPL_WEBGPU_BACKEND_DAWN
  gau_srcs | build_list gau
fi
# ---- the game: Party Board's GAME_FILES + PORT_FILES (its RmlUi front-end, src/port/ui, is not built) ----
GAMEF=(-DTARGET_PC -DNON_MATCHING -DOPTIMIZED_TEXTURE_LOADING -DBYTESWAPPING -DTARGET_DOL -DVERSION=0
       -DMUSY_VERSION_MAJOR=2 -DMUSY_VERSION_MINOR=0 -DMUSY_VERSION_PATCH=0 -DMUSY_TARGET=MUSY_TARGET_PC
       -I"$PB/include" -I"$HERE/shim/game" -I"$AU/include/dolphin" -I"$MX/include" -I"$BUILD/gen" -I"$BUILD/gen/extern"
       -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types -Wno-implicit-int)
game_srcs() {
  sed -n '/set(GAME_FILES/,/)/p; /set(PORT_FILES/,/)/p' "$PB/files.cmake" | grep -v "^ *#" | grep -oE "src/[A-Za-z0-9_/.-]+\.(c|cpp)" | grep -v "^src/port/ui/\|^src/port/portmain.cpp\|^src/port/achievements.cpp\|^src/port/audio.cpp" | sed "s#^#$PB/#"
  echo "$HERE/src/libco_fiber.c"; echo "$HERE/src/rel_dispatch.c"; echo "$HERE/src/web_stubs.cpp"; echo "$HERE/src/web_audio.cpp"; echo "$HERE/src/det_heap.c"; echo "$HERE/src/nod_web.c"   # game heap: aurora keeps its handles inside game-held DVD blocks
  sed -n '/add_library(musyx STATIC/,/)/p' "$MX/CMakeLists.txt" | grep -oE "src/[A-Za-z0-9_/.-]+\.c" | sed "s#^#$MX/#"
  echo "$MX/src/musyx/runtime/hw_pc_null.c"   # no SDL device: the game renders each frame's samples itself
  echo "$MX/src/musyx/debugger/debugger.c"   # the runtime calls its pause/step hooks unconditionally
}
if [ "$STAGE" = game ] || [ "$STAGE" = all ]; then
  game_srcs | build_list game "${GAMEF[@]}"
  # main() and its host-side statics (AuroraInfo holds the window's pixel size and scale, which differ
  # per device) are NOT game state: built with the game's flags, linked outside the game's range
  rm -f "$BUILD"/obj/game__*portmain_web*
  echo "$HERE/src/portmain_web.cpp" | build_list au "${GAMEF[@]}" -fexceptions
fi
# ---- the overlays (src/REL/*): compiled into the module, namespaced, fresh statics per link ----
if [ "$STAGE" = rel ] || [ "$STAGE" = all ]; then
  printf '%s\n' "${CF[@]}" "${GAMEF[@]}" -include "$HERE/shim/det_alloc.h" > "$BUILD/rel_cflags.txt"
  python3 "$HERE/rel_build.py" "$BUILD" "$PB" "$BUILD/rel_cflags.txt"
fi
# ---- link: one module, Asyncify (the game loop and libco fibers block; the browser must run) ----
if [ "$STAGE" = link ] || [ "$STAGE" = all ]; then
  OUT="${OUT:-$BUILD/out}"; mkdir -p "$OUT"
  # markers bracketing the game's (and, after it, the overlays') .data/.bss: the state-hash range
  mkdir -p "$BUILD/mark"
  printf 'char mp4web_game_data_b[1] = {1};\nchar mp4web_game_bss_b[1];\n' > "$BUILD/mark/game_b.c"
  printf 'char mp4web_game_data_e[1] = {1};\nchar mp4web_game_bss_e[1];\n' > "$BUILD/mark/game_e.c"
  for m in game_b game_e; do emcc "${CF[@]}" -c "$BUILD/mark/$m.c" -o "$BUILD/mark/$m.o"; done
  # game objects first, then the overlays in their bracketed order (rel_dispatch.c relies on it)
  em++ -O2 -fexceptions "${PORTS[@]}" -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=131072 -sSTACK_SIZE=1048576 \
    -sINITIAL_MEMORY=268435456 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2147483648 \
    -sENVIRONMENT=web -sEXIT_RUNTIME=0 -sINVOKE_RUN=0 -sMODULARIZE=1 -sEXPORT_NAME=createMp4Native \
    -lidbfs.js -sEXPORTED_RUNTIME_METHODS=callMain,HEAPU8,HEAP16,HEAP32,FS,IDBFS,addRunDependency,removeRunDependency -sEXPORTED_FUNCTIONS=_main,_mp4web_frames,_mp4web_reanchors,_mp4web_total,_mp4web_busy_ms,_mp4web_gpu_wait_ms,_mp4web_audio_samples,_mp4web_state_hash,_mp4web_state_ranges,_mp4web_rb_enable,_mp4web_rb_disable,_mp4web_rb_boundary,_mp4web_rb_restore,_mp4web_rb_oldest,_mp4web_rb_hash,_mp4web_rb_stats,_mp4web_rb_on,_mp4web_rb_audit,_mp4web_rb_hash_full,_mp4web_rb_pages,_mp4web_rb_small_hash,_mp4web_rb_base,_mp4web_rb_page_hashes,_mp4web_set_frame,_mp4web_set_max_debt,_mp4web_set_gfx_skip,_mp4web_set_frameskip,_mp4web_drawn,_mp4web_auto_skipped,_mp4web_gpu_scratch_frames,_mp4web_set_gpu_nowait,_mp4web_cow,_mp4web_mem_stats,_mp4web_det_heap_high_water,_mp4web_det_heap_fallbacks,_malloc,_free \
    -sFORCE_FILESYSTEM=1 --post-js "$HERE/src/post.js" --js-library "$HERE/src/rollback_lib.js" ${LINK_EXTRA:-} -Wl,--Map="$OUT/mp4native.map" \
    "$BUILD"/obj/au__*.o "$BUILD/mark/game_b.o" "$BUILD"/obj/gau__*.o "$BUILD"/obj/game__*.o $(cat "$BUILD/rel/link_order.txt") "$BUILD/mark/game_e.o" -o "$OUT/mp4native.js" 2> "$OUT/link.log" \
    && echo "[link] ok $(stat -c %s "$OUT/mp4native.wasm") B wasm" || { echo "[link] FAIL"; grep -c "undefined symbol" "$OUT/link.log"; head -c 3000 "$OUT/link.log"; exit 1; }
  # TWO BINARIES from one link. OUT/ is the solo build: no write barrier (the barrier costs ~3 ms of
  # CPU a frame here whether or not it is logging — a matched pair, 9.29 vs 12.34-12.54 ms). OUT/rb/
  # is the same module with the rollback write barrier merged in: what a netplay room loads (every
  # console in a room loads it, so they all run the same code). WB=0 skips the rb/ variant.
  if [ "${WB:-1}" = 1 ]; then
    mkdir -p "$OUT/rb"
    bash "$HERE/wb/instrument.sh" "$OUT/mp4native.wasm" "$OUT/rb/mp4native.wasm" && cp "$OUT/mp4native.js" "$OUT/rb/mp4native.js"
  fi
fi

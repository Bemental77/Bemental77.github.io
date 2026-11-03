#!/usr/bin/env bash
# Reproducible single-thread mGBA -> WebAssembly build for this site.
#
#   bash gba/mgba/build.sh                 # incremental build, writes gba/mgba/dist/
#   bash gba/mgba/build.sh --clean         # wipe the build tree first (what the repro measurement uses)
#   MGBA_OUT=/some/dir bash gba/mgba/build.sh --clean   # write the artifacts elsewhere, leave dist/ alone
#
# Output: $MGBA_OUT (default gba/mgba/dist/) gets mgba_core.js (LF line ends, whatever the host) + mgba_core.wasm +
# mgba_core.buildinfo.json (commit, patch digest, toolchain, defines, md5s; no timestamps).
#
# WHAT IT BUILDS. The Spuds0588/mgba-splitscreen fork of mGBA (MPL-2.0), pinned to $MGBA_REV, cloned OUTSIDE this repo
# to $MGBA_SRC. Nothing third-party is shipped prebuilt: the wasm is compiled here from that source plus the patches in
# gba/mgba/patches/. gba/mgba/SOURCE.md is the source offer.
#
# WHY NOT THE FORK'S OWN web/build.sh. Two defects, both measured (see README.md):
#   1. It passes -DUSE_PTHREADS=OFF to cmake, but the fork's CMakeLists.txt does an UNCONDITIONAL `set(USE_PTHREADS ON)`
#      under `elseif(UNIX)` (the Emscripten toolchain evidently takes that branch), so the command line is overridden: an
#      unpatched configure compiled libmgba with -pthread and -DUSE_PTHREADS anyway. patches/0001 makes the option real.
#   2. Its emcc DEFINES line is a hand-copied list that still carried -DUSE_PTHREADS. Here the bridge's defines are
#      EXTRACTED from the compile database cmake just wrote, so the two can never drift (a layout-define mismatch
#      between libmgba and the bridge traps at the first core->init call), and the script refuses to continue if any
#      pthread define or -pthread flag survives.
#
# TOOLCHAIN (Windows host defaults; every path is overridable). Emscripten comes from the emsdk at $EMSDK_ROOT. cmake and
# ninja are NOT installed on this machine, so they live in a venv made from the emsdk's own python at $BUILDTOOLS and
# nowhere else (no global pip, no winget). PATH `python` on this box is a Microsoft Store shim and is never used.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- pins -------------------------------------------------------------------------------------------------------------
MGBA_REPO="${MGBA_REPO:-https://github.com/Spuds0588/mgba-splitscreen.git}"
MGBA_REV="${MGBA_REV:-f1d5975d77285f77affbfe64b7050ebd5c4b6a77}"
CMAKE_VERSION="${CMAKE_VERSION:-4.4.4}"
NINJA_VERSION="${NINJA_VERSION:-1.13.2}"
EMSCRIPTEN_EXPECT="${EMSCRIPTEN_EXPECT:-6.0.2}"

# --- locations (all outside the repo except dist/) ---------------------------------------------------------------------
MGBA_SRC="${MGBA_SRC:-$HOME/mgba-src}"
MGBA_BUILD="${MGBA_BUILD:-$HOME/mgba-build}"
EMSDK_ROOT="${EMSDK_ROOT:-C:/em/sdk}"
BUILDTOOLS="${BUILDTOOLS:-C:/em/buildtools}"
MGBA_OUT="${MGBA_OUT:-$HERE/dist}"
# Fixed wasm heap size in bytes (ALLOW_MEMORY_GROWTH=0). Default and its derivation: see the link step below + README.md.
INITIAL_MEMORY="${MGBA_INITIAL_MEMORY:-201326592}"
JOBS="${JOBS:-$(n=$(nproc 2>/dev/null || echo 4); [ "$n" -gt 8 ] && n=8; echo "$n")}"

CLEAN=0
for a in "$@"; do
  case "$a" in
    --clean) CLEAN=1 ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "build.sh: unknown argument: $a" >&2; exit 2 ;;
  esac
done

die() { echo "build.sh: ERROR: $*" >&2; exit 1; }
step() { echo; echo "== $* =="; }

# Mixed-form (C:/...) paths for native Windows tools, POSIX-form (/c/...) for PATH and for sourcing; identity elsewhere.
mixed() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
posix() { if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf '%s' "$1"; fi; }

# ---------------------------------------------------------------------------------------------------------------------
step "toolchain"
EMSDK_ROOT="$(posix "$EMSDK_ROOT")"; BUILDTOOLS="$(posix "$BUILDTOOLS")"
[ -f "$EMSDK_ROOT/emsdk_env.sh" ] || die "no emsdk at $EMSDK_ROOT (set EMSDK_ROOT)"
EMSDK_PY=""
for c in "$EMSDK_ROOT"/python/*/python.exe "$EMSDK_ROOT"/python/*/bin/python3; do
  [ -x "$c" ] && { EMSDK_PY="$c"; break; }
done
[ -n "$EMSDK_PY" ] || die "no python bundled in the emsdk under $EMSDK_ROOT/python"

# Venv for cmake + ninja (created once, from the emsdk python; the ONLY thing pip ever installs into).
if [ -x "$BUILDTOOLS/Scripts/python.exe" ]; then VENV_PY="$BUILDTOOLS/Scripts/python.exe"; VENV_BIN="$BUILDTOOLS/Scripts"
else VENV_PY="$BUILDTOOLS/bin/python"; VENV_BIN="$BUILDTOOLS/bin"; fi
if [ ! -x "$VENV_PY" ]; then
  echo "creating build-tools venv at $BUILDTOOLS from $EMSDK_PY"
  "$EMSDK_PY" -m venv "$BUILDTOOLS"
  if [ -x "$BUILDTOOLS/Scripts/python.exe" ]; then VENV_PY="$BUILDTOOLS/Scripts/python.exe"; VENV_BIN="$BUILDTOOLS/Scripts"
  else VENV_PY="$BUILDTOOLS/bin/python"; VENV_BIN="$BUILDTOOLS/bin"; fi
fi
HAVE_CMAKE="$("$VENV_PY" -m pip show cmake 2>/dev/null | sed -n 's/^Version: //p' | tr -d '\r')"
HAVE_NINJA="$("$VENV_PY" -m pip show ninja 2>/dev/null | sed -n 's/^Version: //p' | tr -d '\r')"
if [ "$HAVE_CMAKE" != "$CMAKE_VERSION" ] || [ "$HAVE_NINJA" != "$NINJA_VERSION" ]; then
  echo "installing cmake==$CMAKE_VERSION ninja==$NINJA_VERSION into the venv (have cmake='$HAVE_CMAKE' ninja='$HAVE_NINJA')"
  "$VENV_PY" -m pip install --disable-pip-version-check "cmake==$CMAKE_VERSION" "ninja==$NINJA_VERSION"
fi
export PATH="$VENV_BIN:$PATH"

# emsdk_env.sh needs its OWN python (the PATH one is a Store shim), and prints noise unless told not to.
export EMSDK_PYTHON="$EMSDK_PY" EMSDK_QUIET=1
# shellcheck disable=SC1091
source "$EMSDK_ROOT/emsdk_env.sh" >/dev/null 2>&1 || true
command -v emcc >/dev/null 2>&1 || die "emcc not on PATH after sourcing $EMSDK_ROOT/emsdk_env.sh"
# emcmake/emcc below get only mixed-form paths; MSYS must not rewrite `-ffile-prefix-map=C:/a=b` style args. (Not exported:
# git.exe elsewhere in this script still needs MSYS to translate the /c/... paths it is handed.)
NOCONV=(env MSYS2_ARG_CONV_EXCL='*')

EMCC_VERSION="$(emcc --version | head -1 | sed -n 's/.* \([0-9][0-9.]*\) (\([0-9a-f]*\)).*/\1 (\2)/p')"
CMAKE_BIN="$(command -v cmake)"; NINJA_BIN="$(command -v ninja)"
echo "emcc   : $EMCC_VERSION"
echo "cmake  : $("$CMAKE_BIN" --version | head -1)  ($CMAKE_BIN)"
echo "ninja  : $("$NINJA_BIN" --version | tr -d '\r')  ($NINJA_BIN)"
case "$EMCC_VERSION" in "$EMSCRIPTEN_EXPECT "*) ;; *) die "expected Emscripten $EMSCRIPTEN_EXPECT, got $EMCC_VERSION (override EMSCRIPTEN_EXPECT to build on purpose)" ;; esac
command -v git >/dev/null 2>&1 || die "git not found"
command -v node >/dev/null 2>&1 || die "node not found (used to read the compile database and write buildinfo)"

# ---------------------------------------------------------------------------------------------------------------------
step "source: $MGBA_REPO @ $MGBA_REV -> $MGBA_SRC"
if [ ! -d "$MGBA_SRC/.git" ]; then
  [ ! -e "$MGBA_SRC" ] || [ -z "$(ls -A "$MGBA_SRC" 2>/dev/null)" ] || die "$MGBA_SRC exists, is not empty and is not a git clone"
  mkdir -p "$MGBA_SRC"
  git init -q "$MGBA_SRC"
  # LF in the working tree, always: this host's global core.autocrlf=true would otherwise rewrite every source file to
  # CRLF, so the bytes the compiler sees would depend on the machine's git config.
  git -C "$MGBA_SRC" config core.autocrlf false
  git -C "$MGBA_SRC" config core.eol lf
  git -C "$MGBA_SRC" remote add origin "$MGBA_REPO"
fi
[ "$(git -C "$MGBA_SRC" config --get core.autocrlf || true)" = "false" ] || die "$MGBA_SRC was not made with core.autocrlf=false (its sources may be CRLF); delete it and let build.sh re-clone"
if [ "$(git -C "$MGBA_SRC" rev-parse HEAD 2>/dev/null || true)" != "$MGBA_REV" ]; then
  # MGBA_SRC is a build-owned clone. Moving its HEAD over local edits would either fail or carry them along silently.
  [ -z "$(git -C "$MGBA_SRC" status --porcelain --untracked-files=no 2>/dev/null)" ] || die "$MGBA_SRC has local changes and HEAD is not the pin; run: git -C $MGBA_SRC checkout -- ."
  if ! git -C "$MGBA_SRC" cat-file -e "$MGBA_REV^{commit}" 2>/dev/null; then
    # Fetch by SHA (a shallow clone of the default branch need not contain it). GitHub allows reachable-SHA fetches.
    git -C "$MGBA_SRC" fetch --depth 1 origin "$MGBA_REV"
  fi
  git -C "$MGBA_SRC" checkout -q --detach "$MGBA_REV"
fi
HEAD_SHA="$(git -C "$MGBA_SRC" rev-parse HEAD)"
[ "$HEAD_SHA" = "$MGBA_REV" ] || die "HEAD is $HEAD_SHA, pinned is $MGBA_REV"
echo "HEAD == $HEAD_SHA (pinned)"

# Patches: each must either be already applied (reverse-applies cleanly) or apply cleanly now. Anything else is drift.
# They are applied from a CR-stripped copy: this host checks text files out as CRLF (core.autocrlf=true) and the pinned
# source tree is LF, so a CRLF patch would not apply anywhere but here.
PATCH_TMP="$MGBA_BUILD/patches"; rm -rf "$PATCH_TMP"; mkdir -p "$PATCH_TMP"
PATCH_LIST=""
for p in "$HERE"/patches/*.patch; do
  [ -f "$p" ] || continue
  q="$PATCH_TMP/$(basename "$p")"; tr -d '\015' < "$p" > "$q"
  if git -C "$MGBA_SRC" apply --check --reverse "$q" 2>/dev/null; then
    echo "patch already applied: $(basename "$p")"
  elif git -C "$MGBA_SRC" apply --check "$q" 2>/dev/null; then
    git -C "$MGBA_SRC" apply "$q"
    echo "patch applied        : $(basename "$p")"
  else
    die "patch $(basename "$p") neither applies nor reverse-applies on $HEAD_SHA (source tree drifted?)"
  fi
  PATCH_LIST="$PATCH_LIST $(basename "$p")"
done
# The tree may differ from the pin ONLY by the files the patches touch.
PATCHED_FILES="$(for q in "$PATCH_TMP"/*.patch; do [ -f "$q" ] && git -C "$MGBA_SRC" apply --numstat "$q" | cut -f3; done | sort -u)"
DIRTY_FILES="$(git -C "$MGBA_SRC" status --porcelain --untracked-files=no | sed 's/^...//' | sort -u)"
[ "$PATCHED_FILES" = "$DIRTY_FILES" ] || die "source tree differs from the pin beyond the patches. patched: [$PATCHED_FILES] dirty: [$DIRTY_FILES]"
PATCH_DIFF_SHA="$(git -C "$MGBA_SRC" diff --no-color | node -e 'let b=[];process.stdin.on("data",d=>b.push(d)).on("end",()=>console.log(require("crypto").createHash("sha256").update(Buffer.concat(b)).digest("hex")))')"
echo "patched files: ${PATCHED_FILES:-none}  (diff sha256 $PATCH_DIFF_SHA)"

# ---------------------------------------------------------------------------------------------------------------------
SRC_M="$(mixed "$MGBA_SRC")"
BUILD_M="$(mixed "$MGBA_BUILD")"
CM_DIR="$MGBA_BUILD/cmake"
OUT_TMP="$MGBA_BUILD/out"
CM_DIR_M="$(mixed "$CM_DIR")"
if [ "$CLEAN" = 1 ]; then step "clean $MGBA_BUILD"; rm -rf "$CM_DIR" "$OUT_TMP"; fi
mkdir -p "$CM_DIR" "$OUT_TMP"

# Strip the host's absolute paths out of everything the compiler embeds (assert/__FILE__ strings), so the wasm does not
# depend on where the source or build tree happens to live.
PREFIX_MAP="-ffile-prefix-map=$SRC_M=/mgba-src -ffile-prefix-map=$CM_DIR_M=/mgba-build"

step "configure (emcmake + ninja, USE_PTHREADS=OFF)"
# Every optional dependency / frontend is named OFF explicitly: left to autodetection, find_feature() latched onto
# USE_FREETYPE and USE_DISCORD_RPC from whatever happened to be in the emsdk's port cache, which is environment-dependent.
"${NOCONV[@]}" emcmake cmake -G Ninja -S "$SRC_M" -B "$CM_DIR_M" \
  -DCMAKE_MAKE_PROGRAM="$(mixed "$NINJA_BIN")" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DSKIP_GIT=ON \
  -DBUILD_STATIC=ON -DBUILD_SHARED=OFF \
  -DBUILD_QT=OFF -DBUILD_SDL=OFF -DBUILD_GL=OFF -DBUILD_GLES2=OFF -DBUILD_GLES3=OFF \
  -DBUILD_LIBRETRO=OFF -DBUILD_LIBRETRO_SPLITSCREEN=OFF -DBUILD_HEADLESS=OFF -DBUILD_EXAMPLE=OFF \
  -DBUILD_PERF=OFF -DBUILD_TEST=OFF -DBUILD_SUITE=OFF -DBUILD_CINEMA=OFF -DBUILD_PYTHON=OFF \
  -DUSE_PTHREADS=OFF \
  -DENABLE_SCRIPTING=OFF -DENABLE_GDB_STUB=OFF -DENABLE_DEBUGGERS=OFF \
  -DUSE_FFMPEG=OFF -DUSE_ZLIB=OFF -DUSE_PNG=OFF -DUSE_LZMA=OFF -DUSE_SQLITE3=OFF -DUSE_ELF=OFF -DUSE_EPOXY=OFF \
  -DUSE_LIBZIP=OFF -DUSE_MINIZIP=OFF -DUSE_LUA=OFF -DUSE_JSON_C=OFF -DUSE_FREETYPE=OFF -DUSE_DISCORD_RPC=OFF \
  -DUSE_EDITLINE=OFF \
  "-DCMAKE_C_FLAGS=-D_GNU_SOURCE $PREFIX_MAP"

step "build libmgba.a"
"$NINJA_BIN" -C "$CM_DIR_M" -j"$JOBS" mgba

# The libmgba objects and the bridge must see IDENTICAL layout defines (ENABLE_DIRECTORIES moves every mCore vtable slot).
# Read them from the compile database rather than copying a list by hand, and refuse any pthread residue.
step "extract libmgba compile defines + flags"
node - "$CM_DIR/compile_commands.json" "$OUT_TMP/defines.txt" "$OUT_TMP/cflags.txt" <<'JS'
const fs = require('fs');
const [, , cdb, outDefs, outFlags] = process.argv;
const db = JSON.parse(fs.readFileSync(cdb, 'utf8'));
const libmgba = db.filter((e) => /[\\/]src[\\/](core|gba|gb|util)[\\/]/.test(e.file));
if (libmgba.length < 50) throw new Error('compile database has only ' + libmgba.length + ' libmgba entries');
const toks = (e) => (e.command || e.arguments.join(' ')).split(/\s+/);
const defs = (e) => toks(e).filter((t) => t.startsWith('-D'));
const first = defs(libmgba[0]).join(' ');
for (const e of libmgba) if (defs(e).join(' ') !== first) throw new Error('define sets differ inside libmgba: ' + e.file);
const bad = [];
for (const e of db) for (const t of toks(e)) if (/pthread/i.test(t)) bad.push(e.file + ' :: ' + t);
if (bad.length) throw new Error('pthread residue in ' + bad.length + ' compile commands, e.g. ' + bad[0]);
fs.writeFileSync(outDefs, first + '\n');
const flags = toks(libmgba[0]).filter((t) => /^-(O\d|f|W|std=)/.test(t) && !t.startsWith('-ffile-prefix-map'));
fs.writeFileSync(outFlags, flags.join(' ') + '\n');
console.log('libmgba TUs        : ' + libmgba.length + ' (all share one define set)');
console.log('pthread residue    : none in ' + db.length + ' compile commands');
console.log('defines            : ' + first);
JS
DEFINES="$(cat "$OUT_TMP/defines.txt")"
case " $DEFINES " in *USE_PTHREADS*|*HAVE_PTHREAD*) die "pthread define survived in: $DEFINES" ;; esac

# ---------------------------------------------------------------------------------------------------------------------
step "link bridge + libmgba -> mgba_core.{js,wasm}"
# The bridge is OURS (gba/mgba/bridge/), not the fork's web/mgba_splitscreen_web.c: one wasm instance hosts N linked cores,
# the ROM is mapped once and shared, a link stall is an incident instead of a silent heal. bemental_gba.c is the API;
# legacy_mgs.c keeps the fork's mgs_* ABI alive for glue written against it.
BRIDGE_DIR="$HERE/bridge"
BRIDGE_SRCS=("$BRIDGE_DIR/bemental_gba.c" "$BRIDGE_DIR/legacy_mgs.c")
for f in "${BRIDGE_SRCS[@]}" "$BRIDGE_DIR/bemental_gba.h"; do [ -f "$f" ] || die "bridge source missing: $f"; done
BRIDGE_M=(); for f in "${BRIDGE_SRCS[@]}"; do BRIDGE_M+=("$(mixed "$f")"); done
# Every bridge entry point is EMSCRIPTEN_KEEPALIVE; only the allocator, fflush and sbrk (heap high-water probe) are named here.
EXPORTS="_malloc,_free,_fflush,_sbrk"
# INITIAL_MEMORY is FIXED (ALLOW_MEMORY_GROWTH=0): the heap size is a number the test can hold the build to, and there is no
# grow path to fail on a phone. It is MEASURED, not guessed - tools/gba_mgba_core_test.mjs re-measures the sbrk high-water
# for every ROM we ship at 1..4 seats and fails if headroom drops below 16 MiB. The numbers and the derivation are in
# gba/mgba/README.md ("Memory"). With one shared ROM mapping the cost is: one copy of the ROM, plus - ONLY for a cartridge
# with GPIO hardware (RTC: Pokemon) - a private 32 MiB copy per seat, because mGBA writes the GPIO registers into the ROM
# image (_pristineCow in memory.c), plus ~1.2 MiB of core state per seat.
# MEASURED 2026-11-01 (Node, bridge as built here, 120 frames + one savestate per seat; sbrk high-water in MiB, 1/2/3/4 seats):
#   Super Bust-A-Move 4 MiB     7.8 /  8.4 /  9.0 /  9.7      Kirby 8 MiB         11.9 / 12.6 / 13.3 / 13.9
#   Sonic Advance 3 16 MiB     20.0 / 20.8 / 21.6 / 22.4      Pokemon SoulGold 32 MiB (RTC)  68.0 / 100.9 / 133.8 / 166.6
# i.e. a pristine ROM costs one copy + ~0.7 MiB per extra seat (the fork measured ~65 MiB per extra SoulGold core and a 320 MiB
# heap); an RTC cartridge costs ~32.9 MiB per extra seat. 192 MiB = 201326592 B = 3072 wasm pages: 4 x SoulGold peaks at
# 166.6 MiB, 25.4 MiB (13%) of headroom.
# -pthread is deliberately absent, and so is anything that implies SharedArrayBuffer: this module must run on a page that
# is NOT cross-origin isolated.
# shellcheck disable=SC2086
"${NOCONV[@]}" emcc -O3 -D_GNU_SOURCE -DNDEBUG $DEFINES $PREFIX_MAP \
  -I"$SRC_M/include" -I"$CM_DIR_M/include" -I"$CM_DIR_M" \
  -sENVIRONMENT=web,node \
  -sMODULARIZE=1 -sEXPORT_NAME=createMgbaCore \
  "-sEXPORTED_FUNCTIONS=$EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAP8,HEAP16,HEAPU8,HEAP32,HEAPU32,HEAP64 \
  -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=$INITIAL_MEMORY -sSTACK_SIZE=1048576 \
  -sNO_EXIT_RUNTIME=1 -sERROR_ON_UNDEFINED_SYMBOLS=1 -sASSERTIONS=0 \
  -I"$(mixed "$BRIDGE_DIR")" "-ffile-prefix-map=$(mixed "$HERE")=/gba/mgba" \
  "${BRIDGE_M[@]}" "$CM_DIR_M/libmgba.a" -o "$(mixed "$OUT_TMP")/mgba_core.js"

[ -f "$OUT_TMP/mgba_core.wasm" ] || die "link produced no mgba_core.wasm"
head -c4 "$OUT_TMP/mgba_core.wasm" | od -An -tx1 | tr -d ' \n' | grep -q '^0061736d$' || die "mgba_core.wasm does not start with \\0asm"
# Emscripten on a Windows host ends the glue's lines with CRLF (a Linux host writes LF); the only two CRs in the file are those
# line terminators. Normalize to LF so the file, its md5 and git's view of it do not depend on the host. (The wasm is binary.)
tr -d '\015' < "$OUT_TMP/mgba_core.js" > "$OUT_TMP/mgba_core.js.lf" && mv -f "$OUT_TMP/mgba_core.js.lf" "$OUT_TMP/mgba_core.js"

# ---------------------------------------------------------------------------------------------------------------------
step "write $MGBA_OUT"
mkdir -p "$MGBA_OUT"
cp -f "$OUT_TMP/mgba_core.js" "$OUT_TMP/mgba_core.wasm" "$MGBA_OUT/"
WASM_MD5="$(md5sum "$MGBA_OUT/mgba_core.wasm" | cut -d' ' -f1)"
JS_MD5="$(md5sum "$MGBA_OUT/mgba_core.js" | cut -d' ' -f1)"
# No timestamps in here: the file must be byte-stable so a rebuild's only diff is a real diff.
BI_SRC_REPO="$MGBA_REPO" BI_SRC_REV="$HEAD_SHA" BI_PATCHES="${PATCH_LIST# }" BI_PATCH_SHA="$PATCH_DIFF_SHA" \
BI_EMCC="$EMCC_VERSION" BI_CMAKE="$("$CMAKE_BIN" --version | head -1 | sed 's/cmake version //')" BI_NINJA="$("$NINJA_BIN" --version | tr -d '\r')" \
BI_BRIDGE_DIR="$BRIDGE_DIR" BI_DEFINES="$DEFINES" BI_INITIAL_MEMORY="$INITIAL_MEMORY" BI_WASM_MD5="$WASM_MD5" BI_JS_MD5="$JS_MD5" BI_OUT="$MGBA_OUT/mgba_core.buildinfo.json" \
node -e '
const e = process.env, fs = require("fs");
const o = {
  source: { repo: e.BI_SRC_REPO, commit: e.BI_SRC_REV, patches: e.BI_PATCHES ? e.BI_PATCHES.split(" ") : [], patchedTreeDiffSha256: e.BI_PATCH_SHA },
  toolchain: { emscripten: e.BI_EMCC, cmake: e.BI_CMAKE, ninja: e.BI_NINJA },
  bridge: (() => { const d = e.BI_BRIDGE_DIR, o = {}; for (const f of fs.readdirSync(d).sort()) o["bridge/" + f] = require("crypto").createHash("sha256").update(fs.readFileSync(d + "/" + f).toString("latin1").split(String.fromCharCode(13)).join("")).digest("hex"); return { sha256_of_LF_normalised_sources: o }; })(),
  threads: "none (USE_PTHREADS=OFF, no -pthread, no SharedArrayBuffer)",
  libmgbaDefines: e.BI_DEFINES.split(" "),
  link: { initialMemory: Number(e.BI_INITIAL_MEMORY), allowMemoryGrowth: 0, environment: "web,node", exportName: "createMgbaCore" },
  md5: { "mgba_core.wasm": e.BI_WASM_MD5, "mgba_core.js": e.BI_JS_MD5 },
};
fs.writeFileSync(e.BI_OUT, JSON.stringify(o, null, 2) + "\n");
'
ls -l "$MGBA_OUT"/mgba_core.*
echo
echo "mgba_core.wasm md5 $WASM_MD5"
echo "mgba_core.js   md5 $JS_MD5"
echo "build.sh: OK"

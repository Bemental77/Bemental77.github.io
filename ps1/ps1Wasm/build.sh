#!/bin/bash
# Rebuilds ps1/ps1Wasm/dist/wasmpsx_worker.{js,wasm,data} from pcsx-wasm-src.
#
#     # from the repo root, with the vendored emsdk 6.0.2 (see below):
#     printf "LLVM_ROOT='$PWD/emsdk/upstream/bin'\nBINARYEN_ROOT='$PWD/emsdk/upstream'\nNODE_JS='$(which node)'\n" > /tmp/em.cfg
#     EM_CONFIG=/tmp/em.cfg PATH=$PWD/emsdk/upstream/emscripten:$PATH bash ps1/ps1Wasm/build.sh [OUTDIR]
#
# OUTDIR defaults to ps1/ps1Wasm/dist. Only the WORKER is built (the page's
# pcsx_ww.{js,wasm} UI module is not touched).
#
# ── WHAT THE SHIPPED BINARY WAS, AND HOW CLOSE THIS GETS (2026-10-07) ───────────
# The fastcomp 1.37.40 toolchain the README names is not what built dist/: the
# shipped worker's exports are Makefile.modern's, its runtime is a modern
# emscripten's, and its EM_ASM table / rodata say exactly which SOURCE it came
# from — which was NOT the tree checked in here. Reconstructed, and checked in
# by the commit that added this script:
#   * gui/workerMain.c one_iter ends in `_scheduleMainLoop($0)` (shipped
#     ASM_CONSTS[199284]), not setTimeout("pcsx_mainloop()");
#   * js/worker_funcs.js is the shipped post-js, cut out of shipped line 1;
#   * plugins/dfxvideo/fps.c, libpcsxcore/r3000a.c, plugins/dfsound/worker.c are
#     the upstream kxkx5150/PCSX-wasm versions: the shipped rodata holds
#     "SetAutoFrameCap %d %f", "bd set!!!", "lBytes>4800 %ld", which the
#     checked-in edits had removed (and fps.c's edit turned the limiter off at
#     compile time — the shipped block does that at run time instead);
#   * libpcsxcore/psxcounters.c stays as checked in (its extra GPU_vBlank/setIrq
#     IS in the shipped binary: with upstream's file, tools/ps1_core_equiv.mjs
#     diverges from the shipped core at frame 179 of Monster Rancher 2).
# The toolchain cannot be matched exactly: the shipped JS runtime sits between
# emscripten 4.0.10 (~/emsdk-upstream) and the vendored 6.0.2, neither of which
# reproduces it. On 6.0.2 this tree gives a wasm with the SAME data layout as the
# shipped one — every address the appended block writes (CORE table, sbrk,
# STATIC_SPANS, __heap_base 1195424) — except rodata strings sit 14 bytes later
# (zlib 1.3.2's extra message), and different code bytes (newer LLVM). It is
# the same console: tools/ps1_core_equiv.mjs runs it beside the shipped core on
# the same disc and pads and their main RAM, hardware page and VRAM agree at
# every check (Monster Rancher 2, 3600 frames).
#
# ── THE APPENDED BLOCK ──────────────────────────────────────────────────────────
# Everything after line 1 of dist/wasmpsx_worker.js was appended by hand and is
# in no source file. tools/reappend.mjs carries it onto the new line 1, refusing
# unless every hard-coded address in it is still right for the new binary, and
# re-points only its own signature guard (the `sigs:` line). It prints the diff.
set -eo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:-$HERE/dist}
if ! command -v emcc >/dev/null; then echo "build.sh: no emcc on PATH (see the header)" >&2; exit 1; fi
V=$(emcc --version | head -1)
case "$V" in *" 6.0.2"*) ;; *) if [ -z "$PS1_ANY_EMCC" ]; then echo "build.sh: $V is not the vendored 6.0.2 (PS1_ANY_EMCC=1 to build anyway; the layout check in tools/reappend.mjs still guards the result)" >&2; exit 1; fi ;; esac
B=$(mktemp -d "${TMPDIR:-/tmp}/ps1build.XXXXXX")
trap '[ -n "$PS1_KEEP_BUILD" ] && echo "build dir kept: $B" || rm -rf "$B"' EXIT
# Build in a scratch copy: pcsx-wasm-src holds tracked artifacts of an older
# build (wasmpsx_worker.*, pcsx_ww.*) that a make in place would overwrite.
( cd "$HERE/pcsx-wasm-src" && tar cf - --exclude=./docs --exclude=./wasmpsx_worker.js --exclude=./wasmpsx_worker.wasm --exclude=./wasmpsx_worker.data --exclude=./pcsx_ww.js --exclude=./pcsx_ww.wasm --exclude='*.o' . ) | ( cd "$B" && tar xf - )
# __DATE__ ("Running PCSX Version %s (%s)") is in rodata; pin it to the shipped
# build's "Apr 23 2026" so a rebuild is reproducible and rodata keeps its size.
export SOURCE_DATE_EPOCH=$(date -u -d '2026-04-23 12:00:00' +%s 2>/dev/null || echo 1776945600)
( cd "$B" && make -f Makefile.modern -j4 wasmpsx_worker.js EXTRA_LDFLAGS=-Wl,-Map=wasmpsx_worker.map ) > "$B/build.log" 2>&1 \
  || { tail -30 "$B/build.log" >&2; exit 1; }
mkdir -p "$OUT"
node "$HERE/tools/reappend.mjs" --line1 "$B/wasmpsx_worker.js" --wasm "$B/wasmpsx_worker.wasm" --map "$B/wasmpsx_worker.map" \
  --from "$HERE/dist/wasmpsx_worker.js" --out "$B/out.js"
cp "$B/wasmpsx_worker.wasm" "$OUT/wasmpsx_worker.wasm"
cp "$B/wasmpsx_worker.data" "$OUT/wasmpsx_worker.data"
cp "$B/out.js" "$OUT/wasmpsx_worker.js"
( cd "$OUT" && md5sum wasmpsx_worker.js wasmpsx_worker.wasm wasmpsx_worker.data )

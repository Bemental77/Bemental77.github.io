#!/usr/bin/env bash
# build_slice.sh — translate SAB functions from the SHIPPED BINARY and link them to wasm.
# Mirrors the emcc usage already established in gamecube/recomp/build_wasm.sh (same emsdk).
#
#   bash gamecube/recomp/sr/build_slice.sh <sab_main.dol> [fn_hex ...]
#
# Output: $OUT/sr_slice.{js,wasm} + the generated C, and an md5 of the wasm for hash-guarding.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SR="$REPO/gamecube/recomp/sr"
DOL="${1:?usage: build_slice.sh <main.dol> [fn_hex ...]}"; shift || true
FNS=("$@"); [ ${#FNS[@]} -eq 0 ] && FNS=(0x800ed368)
# "ALL" translates every function in the boundary set (whole-image build) instead
# of a named list.  Pair it with SR_EXTRA_ARGS="--indirect --boundaries outer+calls".
ALL_MODE=0; [ "${FNS[0]}" = "ALL" ] && { ALL_MODE=1; FNS=(); }
OUT="${SR_OUT:-/tmp/sr_slice}"
mkdir -p "$OUT"

# Accept either a raw main.dol or the game ISO (the DOL is extracted from it).
case "$DOL" in
  *.iso|*.ISO)
    python3 - "$DOL" "$OUT/main.dol" <<'EOF'
import struct, sys
iso, out = sys.argv[1], sys.argv[2]
f = open(iso, 'rb'); f.seek(0x420)
dol_off = struct.unpack('>I', f.read(4))[0]
f.seek(dol_off); dh = f.read(0x100)
toff = struct.unpack('>7I',  dh[0x00:0x1c]); tsz = struct.unpack('>7I',  dh[0x90:0xac])
doff = struct.unpack('>11I', dh[0x1c:0x48]); dsz = struct.unpack('>11I', dh[0xac:0xd8])
end = max(max(a + b for a, b in zip(toff, tsz)), max(a + b for a, b in zip(doff, dsz)))
f.seek(dol_off); open(out, 'wb').write(f.read(end))
print(f"[sr] extracted main.dol ({end} bytes) from {iso}", file=sys.stderr)
EOF
    DOL="$OUT/main.dol" ;;
esac

source "$HOME/emsdk-upstream/emsdk_env.sh" >/dev/null 2>&1

# SR_EXTRA_ARGS: extra sr.py flags (e.g. "--indirect --boundaries outer+calls").
# Empty by default so the recorded reproduction of this script is unchanged.
read -r -a EXTRA <<< "${SR_EXTRA_ARGS:-}"
# SR_GEN: link a PRE-GENERATED C file instead of running sr.py (see build_fixture.sh).
if [ -n "${SR_GEN:-}" ]; then
  cp "$SR_GEN" "$OUT/sr_gen.c"
  echo "[sr] linking pre-generated $SR_GEN ($(stat -f%z "$SR_GEN") bytes)"
else
  ARGS=(); if [ "$ALL_MODE" = 1 ]; then ARGS=(--all); else for f in "${FNS[@]}"; do ARGS+=(--fn "$f"); done; fi
  python3 "$SR/sr.py" --image "$DOL" --map "$REPO/dolphin_captures/sab.map" \
          "${ARGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"} --out "$OUT/sr_gen.c"
fi

# SR_DISPATCH_C: sr_dispatch compiled as its OWN TU (sr.py --dispatch-out).  Required
# for a whole-image build at -O2: in one file, clang inlines all 4,671 translated bodies
# into the dispatch switch and V8 rejects the result at instantiate ("size ... > maximum
# function size 7654321").  Separate TU = no cross-TU inlining without LTO, so the bodies
# keep -O2.  Measured worth ~5x on identical code.
EXTRA_SRC=(); [ -n "${SR_DISPATCH_C:-}" ] && EXTRA_SRC=("$SR_DISPATCH_C")

# SR_PTHREAD=1: add -pthread, so a whole-image build can be measured against an
# otherwise IDENTICAL non-pthread one.  The guest context switch (build_ctxsw.sh /
# sr_host_os.c) needs one host thread per guest thread, and -pthread is a codegen
# change, so "does threading cost the translated bodies?" has to be a matched pair
# rather than an argument.  Off by default: no existing build changes.
PT=(); [ "${SR_PTHREAD:-0}" = "1" ] && PT=(-pthread -sPTHREAD_POOL_SIZE=8)
# -pthread + ALLOW_MEMORY_GROWTH is the documented slow path (-Wpthreads-mem-growth),
# so the pair is taken with growth OFF on BOTH sides or it is not a matched pair.
MEM=(-sALLOW_MEMORY_GROWTH=1)
[ "${SR_FIXED_MEM:-0}" = "1" ] && MEM=(-sINITIAL_MEMORY=134217728)
[ "${SR_PTHREAD:-0}" = "1" ] && MEM=(-sINITIAL_MEMORY=134217728)

emcc ${SR_OPT:--O2} -I"$SR" "$OUT/sr_gen.c" ${EXTRA_SRC[@]+"${EXTRA_SRC[@]}"} "$SR/sr_driver.c" -o "$OUT/sr_slice.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT="${SR_ENV:-node}" -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  ${PT[@]+"${PT[@]}"} "${MEM[@]}" \
  -sEXPORTED_FUNCTIONS=_sr_init,_sr_ram,_sr_ram_size,_sr_state,_sr_state_size,_sr_call,_malloc \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,wasmMemory \
  -Wl,--no-entry

echo "[sr] wasm: $OUT/sr_slice.wasm  $(stat -f%z "$OUT/sr_slice.wasm") bytes"
echo "[sr] md5 : $(md5 -q "$OUT/sr_slice.wasm")"

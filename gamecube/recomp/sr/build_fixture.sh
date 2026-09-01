#!/usr/bin/env bash
# build_fixture.sh — translate a NON-LEAF function together with its whole callee
# closure and link it with the differential-verify hooks (-DSR_VERIFY).
#
#   bash gamecube/recomp/sr/build_fixture.sh <sab_main.dol|iso> <entry_hex> [more...]
#
# Every entry's transitive callee closure is translated into ONE C file, so calls
# become real C calls (sr.py --closure).  A call that escapes the closure is
# impossible here by construction; if one appeared it would link to sr_extern(),
# which faults.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SR="$REPO/gamecube/recomp/sr"
DOL="${1:?usage: build_fixture.sh <main.dol|iso> <entry_hex> [more...]}"; shift
FNS=("$@"); [ ${#FNS[@]} -eq 0 ] && { echo "no entry addresses given" >&2; exit 1; }
OUT="${SR_OUT:-/tmp/sr_fixture}"
mkdir -p "$OUT"

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
# SR_GEN: link a PRE-GENERATED C file instead of running sr.py.  This is how an
# OVERLAY fixture is built -- rel_emit.py --base emits the overlay function together
# with its DOL callee closure at REAL runtime addresses, which sr.py (DOL-only) cannot.
if [ -n "${SR_GEN:-}" ]; then
  cp "$SR_GEN" "$OUT/sr_gen.c"
  echo "[sr] linking pre-generated $SR_GEN"
else
  ARGS=(); for f in "${FNS[@]}"; do ARGS+=(--fn "$f"); done
  python3 "$SR/sr.py" --image "$DOL" --map "$REPO/dolphin_captures/sab.map" \
          "${ARGS[@]}" "${EXTRA[@]}" --closure --out "$OUT/sr_gen.c"
fi

emcc -O2 -DSR_VERIFY -I"$SR" "$OUT/sr_gen.c" "$SR/sr_driver.c" -o "$OUT/sr_fixture.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 \
  -sEXPORTED_FUNCTIONS=_sr_init,_sr_ram,_sr_ram_size,_sr_state,_sr_state_size,_sr_call,_sr_staged,_sr_wlog,_sr_wlog_n,_sr_unstaged,_sr_verify_reset,_malloc \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,wasmMemory \
  -Wl,--no-entry

echo "[sr] wasm: $OUT/sr_fixture.wasm  $(stat -f%z "$OUT/sr_fixture.wasm") bytes"
echo "[sr] md5 : $(md5 -q "$OUT/sr_fixture.wasm")"

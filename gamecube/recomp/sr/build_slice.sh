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

ARGS=(); for f in "${FNS[@]}"; do ARGS+=(--fn "$f"); done
python3 "$SR/sr.py" --image "$DOL" --map "$REPO/dolphin_captures/sab.map" \
        "${ARGS[@]}" --out "$OUT/sr_gen.c"

emcc -O2 -I"$SR" "$OUT/sr_gen.c" "$SR/sr_driver.c" -o "$OUT/sr_slice.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_sr_init,_sr_ram,_sr_ram_size,_sr_state,_sr_state_size,_sr_call,_malloc \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,wasmMemory \
  -Wl,--no-entry

echo "[sr] wasm: $OUT/sr_slice.wasm  $(stat -f%z "$OUT/sr_slice.wasm") bytes"
echo "[sr] md5 : $(md5 -q "$OUT/sr_slice.wasm")"

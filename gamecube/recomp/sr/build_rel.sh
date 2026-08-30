#!/usr/bin/env bash
# build_rel.sh — translate a whole REL overlay's executable section and compile it.
#
#   bash gamecube/recomp/sr/build_rel.sh <sab.iso> <overlay.rel>
#
# Output in $SR_OUT (default /tmp/sr_rel): the generated C, the wasm, and an md5.
# `sr_dispatch` is exported so the module is NOT dead-stripped — without an exported
# root, emcc drops every translated function and the resulting wasm is a few KB of
# nothing, which reads like success.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SR="$REPO/gamecube/recomp/sr"
ISO="${1:?usage: build_rel.sh <iso> <overlay.rel>}"
REL="${2:?usage: build_rel.sh <iso> <overlay.rel>}"
OUT="${SR_OUT:-/tmp/sr_rel}"
mkdir -p "$OUT"
BASE="${REL%.rel}"

python3 "$SR/rel_emit.py" --iso "$ISO" --rel "$REL" --out "$OUT/$BASE.c"

cat > "$OUT/rel_stub.c" <<'EOF'
// Host shell for a standalone overlay translation unit: guest RAM plus the
// out-of-module call trap.  A real build links the DOL translation here instead,
// and sr_extern() disappears.
#include <stdlib.h>
#include "gekko_rt.h"
#include <emscripten.h>
uint8_t *g_ram = 0; uint32_t g_ram_size = 0; uint32_t g_fault = 0;
void sr_extern(GekkoState *st, uint32_t addr) { (void)st;
    if (!g_fault) g_fault = 0xE0000000u | (addr & 0x00FFFFFFu); }
int sr_dispatch(uint32_t addr, GekkoState *st);
static GekkoState g_st;
EMSCRIPTEN_KEEPALIVE int sr_enter(uint32_t addr) {
    if (!g_ram) { g_ram = (uint8_t*)calloc(1, 0x1800000u); g_ram_size = 0x1800000u; }
    g_fault = 0;
    return sr_dispatch(addr, &g_st) ? (int)g_fault : -1;
}
EOF

source "$HOME/emsdk-upstream/emsdk_env.sh" >/dev/null 2>&1
emcc -O1 -I"$SR" "$OUT/$BASE.c" "$OUT/rel_stub.c" -o "$OUT/$BASE.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=268435456 \
  -sEXPORTED_FUNCTIONS=_sr_enter -Wl,--no-entry

echo "[sr] wasm: $OUT/$BASE.wasm  $(stat -f%z "$OUT/$BASE.wasm") bytes"
echo "[sr] md5 : $(md5 -q "$OUT/$BASE.wasm")"

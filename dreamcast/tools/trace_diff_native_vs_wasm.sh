#!/bin/bash
#
# trace_diff_native_vs_wasm.sh
#
# Run the native flycast standalone build with a ROM for N seconds, capture
# its DYNAREC log (must be a build with -DENABLE_LOG=ON), then compare the
# first K distinct SH4 PCs to the equivalent WASM-side log at
# /tmp/dc-probes/<name>.log (produced by dreamcast/build_and_probe.sh).
#
# A *full* SH4 dispatch-PC trace from upstream flycast is NOT available out of
# the box. Built-in JIT logging in flycast is:
#
#   core/hw/sh4/dyna/driver.cpp     INFO_LOG(DYNAREC, ...)   (cache events)
#   core/hw/sh4/dyna/decoder.cpp    INFO_LOG(DYNAREC, ...)   (illegal opcodes)
#   core/hw/sh4/dyna/ssa.cpp        INFO_LOG(DYNAREC, ...)   (block STATS, opt off by default)
#   core/hw/sh4/dyna/blockmanager.cpp DEBUG_LOG(DYNAREC, ...) (block check fails)
#
# There is no `LOG_JIT` / `JIT_LOG` / `printf_dyna` / per-dispatch PC tracer
# wired into stock flycast. The closest live signal is per-block compile
# events (DEBUG_LOG(DYNAREC, "rdv_BlockCheckFail @ ...")).
#
# Strategy:
#   1. Run native flycast for N seconds with LOG_VERBOSITY=5 (LDEBUG) and
#      capture stdout+stderr to /tmp/dc-native-probes/<name>.log.
#   2. Extract the first $TOP distinct DYNAREC block PCs (rdv_* events).
#   3. Pull the first $TOP distinct sh4-dispatch PCs from the WASM-side
#      probe log at /tmp/dc-probes/<name>.log (our bridge prints these).
#   4. Print a side-by-side diff. The point of the diff is divergence
#      detection — even though the two logs come from different layers
#      (per-block native vs per-dispatch WASM), the leading PCs should still
#      line up to the same boot trajectory if the JIT decoder is consistent.
#
# If the native log contains zero DYNAREC events, the script will emit a
# header-only diff and exit 0 — see the comment in step (1) and the
# `--enable-log` flag of build_flycast_native.sh.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

NATIVE_BUILD_DIR="$REPO_DIR/dreamcast/flycast-src/build-native"
NATIVE_LOG_DIR="/tmp/dc-native-probes"
WASM_LOG_DIR="/tmp/dc-probes"

ROM=""
DURATION=15
TOP=200
NAME="trace_diff"
WASM_NAME=""

usage() {
  cat <<'EOF'
Usage: trace_diff_native_vs_wasm.sh [options]

Run native flycast for N seconds against a ROM, then diff the first K
distinct SH4 PCs against an existing WASM probe log.

Options:
  --rom PATH        Path to .cue / .gdi / .chd ROM (required).
  --duration N      Seconds to run native flycast for (default 15).
  --top K           First K distinct PCs to compare    (default 200).
  --name TAG        Tag for the native log file        (default trace_diff).
                    Native log -> /tmp/dc-native-probes/<TAG>.log
  --wasm-name TAG   Tag of the WASM probe log to diff against.
                    Defaults to --name. Log path
                    /tmp/dc-probes/<TAG>.log must already exist.
  -h, --help        Show this help.

Notes:
  - Native flycast must be built with --enable-log (DEBUG_LOG fires).
    Without that flag the native side emits no DYNAREC events and this
    script will emit a header-only diff.
  - The native standalone is interactive; we run it headless via
    SDL_VIDEODRIVER=dummy + a `timeout` wrapper. On macOS `gtimeout`
    (coreutils) is preferred — install via `brew install coreutils`.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rom)        ROM="$2"; shift 2 ;;
    --duration)   DURATION="$2"; shift 2 ;;
    --top)        TOP="$2"; shift 2 ;;
    --name)       NAME="$2"; shift 2 ;;
    --wasm-name)  WASM_NAME="$2"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *)            echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$ROM" ]]; then
  echo "error: --rom is required" >&2
  usage
  exit 2
fi
if [[ ! -f "$ROM" ]]; then
  echo "error: rom not found: $ROM" >&2
  exit 2
fi
if [[ -z "$WASM_NAME" ]]; then
  WASM_NAME="$NAME"
fi

# Locate the native binary.
NATIVE_BIN=""
if [[ -x "$NATIVE_BUILD_DIR/flycast.app/Contents/MacOS/flycast" ]]; then
  NATIVE_BIN="$NATIVE_BUILD_DIR/flycast.app/Contents/MacOS/flycast"
elif [[ -x "$NATIVE_BUILD_DIR/flycast" ]]; then
  NATIVE_BIN="$NATIVE_BUILD_DIR/flycast"
else
  echo "error: native flycast not found in $NATIVE_BUILD_DIR" >&2
  echo "       run: dreamcast/tools/build_flycast_native.sh --enable-log" >&2
  exit 2
fi

# Pick a timeout wrapper.
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
else
  echo "error: neither 'gtimeout' (brew coreutils) nor 'timeout' available" >&2
  exit 2
fi

mkdir -p "$NATIVE_LOG_DIR"
NATIVE_LOG="$NATIVE_LOG_DIR/$NAME.log"
WASM_LOG="$WASM_LOG_DIR/$WASM_NAME.log"

echo "[trace-diff] native bin : $NATIVE_BIN"
echo "[trace-diff] rom        : $ROM"
echo "[trace-diff] duration   : ${DURATION}s"
echo "[trace-diff] native log : $NATIVE_LOG"
echo "[trace-diff] wasm log   : $WASM_LOG"
echo "[trace-diff] top        : $TOP distinct PCs"
echo

if [[ ! -f "$WASM_LOG" ]]; then
  echo "warning: wasm probe log not found: $WASM_LOG" >&2
  echo "         run: dreamcast/build_and_probe.sh --name $WASM_NAME ..." >&2
fi

echo "[trace-diff] launching native flycast (headless, dummy video)..."
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  "$TIMEOUT_BIN" --preserve-status "${DURATION}s" \
  "$NATIVE_BIN" "$ROM" \
  > "$NATIVE_LOG" 2>&1 || true

echo "[trace-diff] native log captured: $(wc -l < "$NATIVE_LOG") lines"

# Extract leading distinct PCs from native log.
# DYNAREC lines look like:
#   rdv_BlockCheckFail @ 8c0XXXXX
#   recSh4:Dynarec Cache clear at 8c0XXXXX free space ...
#   null RBI: from 8c0XXXXX to 8c0XXXXX ...
NATIVE_PCS=$(grep -Eoi '\b(8c|0c|ac)[0-9a-f]{6}\b' "$NATIVE_LOG" \
              | awk 'BEGIN{IGNORECASE=1} !seen[tolower($0)]++' \
              | head -n "$TOP" || true)

NATIVE_COUNT=$(printf '%s\n' "$NATIVE_PCS" | grep -c . || true)
echo "[trace-diff] native distinct DYNAREC PCs: $NATIVE_COUNT"

if [[ -f "$WASM_LOG" ]]; then
  # sh4 dispatch #N pc=0xXXXXXXXX
  WASM_PCS=$(grep -Eo 'pc=0x[0-9a-fA-F]+' "$WASM_LOG" \
              | awk -F= '{print tolower($2)}' \
              | sed 's/^0x//' \
              | awk '!seen[$0]++' \
              | head -n "$TOP" || true)
else
  WASM_PCS=""
fi

WASM_COUNT=$(printf '%s\n' "$WASM_PCS" | grep -c . || true)
echo "[trace-diff] wasm   distinct dispatch PCs: $WASM_COUNT"
echo

if [[ "$NATIVE_COUNT" -eq 0 ]]; then
  echo "warning: native flycast produced ZERO DYNAREC PC events." >&2
  echo "         Likely cause: built without --enable-log, or run too short" >&2
  echo "         for the JIT cache to register any block-check events." >&2
  echo "         Header diff only:" >&2
  echo
  echo "  native log lines : $(wc -l < "$NATIVE_LOG")"
  echo "  wasm   log lines : $(if [[ -f "$WASM_LOG" ]]; then wc -l < "$WASM_LOG"; else echo "MISSING"; fi)"
  exit 0
fi

NATIVE_PC_FILE="$(mktemp)"
WASM_PC_FILE="$(mktemp)"
trap 'rm -f "$NATIVE_PC_FILE" "$WASM_PC_FILE"' EXIT
printf '%s\n' "$NATIVE_PCS" > "$NATIVE_PC_FILE"
printf '%s\n' "$WASM_PCS"   > "$WASM_PC_FILE"

echo "[trace-diff] side-by-side leading PCs (native | wasm):"
paste "$NATIVE_PC_FILE" "$WASM_PC_FILE" | awk '
  BEGIN{ FS="\t"; n=0; first_div=-1 }
  {
    n++
    same = ($1 == $2 && $1 != "" && $2 != "") ? "==" : "!="
    if (same == "!=" && first_div < 0 && $1 != "" && $2 != "") first_div = n
    printf "  %4d  %-10s  %s  %-10s\n", n, $1, same, $2
  }
  END {
    if (first_div > 0) printf "\n[trace-diff] first divergence at line %d\n", first_div
    else               print "\n[trace-diff] no divergence within compared window"
  }
'

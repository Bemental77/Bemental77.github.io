#!/bin/bash
# dreamcast/build_and_probe.sh — relink Flycast + headless boot probe.
#
# Mirrors the GameCube-side build_and_probe.sh inner loop. The probe
# (dreamcast/tools/flycast_probe.js) headlessly boots dreamcast.html,
# auto-clicks Start, filters emcc DEBUG/ASSERTIONS noise, and prints a
# clean summary of the milestones the boot hit (or the fatal it died on).
#
# Usage:
#   build_and_probe.sh                       # relink + probe → /tmp/probe-dc.log
#   build_and_probe.sh --skip-link           # JS-only iteration
#   build_and_probe.sh --duration 60000      # 60s probe
#   build_and_probe.sh --idle 12000          # tolerate longer quiet periods
#   build_and_probe.sh --keep-noise          # show emcc DEBUG/ASSERTIONS too
#   build_and_probe.sh --name baseline       # archive to /tmp/dc-probes/baseline.log
#   build_and_probe.sh --js-flags "--trace-deopt --print-wasm-code"
#                                            # forwarded to V8 (puppeteer Chrome
#                                            # via FLYCAST_V8_FLAGS env var)

set -e

# ---- args ----
SKIP_LINK=0
DURATION=""
IDLE=""
KEEP_NOISE=""
NAME=""
PROBE_LOG=""
JS_FLAGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-link|--skip-build) SKIP_LINK=1; shift ;;
    --duration)               DURATION="$2"; shift 2 ;;
    --idle)                   IDLE="$2"; shift 2 ;;
    --keep-noise)             KEEP_NOISE="--keep-noise"; shift ;;
    --name)                   NAME="$2"; shift 2 ;;
    --log)                    PROBE_LOG="$2"; shift 2 ;;
    --js-flags)               JS_FLAGS="$2"; shift 2 ;;
    -h|--help)                sed -n '2,/^set -e/p' "$0" | sed 's/^# //;/^set -e/d'; exit 0 ;;
    *)                        echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ---- archive paths ----
if [ -n "$NAME" ]; then
  ARCHIVE_DIR="/tmp/dc-probes"
  mkdir -p "$ARCHIVE_DIR"
  PROBE_LOG="${PROBE_LOG:-$ARCHIVE_DIR/${NAME}.log}"
else
  PROBE_LOG="${PROBE_LOG:-/tmp/probe-dc.log}"
fi

ROOT=/Users/caseybement/Bemental77.github.io
LINK_SCRIPT=$ROOT/dreamcast/flycast-bridge/flycast_worker_link.sh
PROBE_JS=$ROOT/dreamcast/tools/flycast_probe.js

# ---- rebuild bementalJIT (and its SH4 guest) if its sources changed ----
# The link script only re-compiles the bridge TUs (EmscriptenWorker.cpp, etc).
# bementalJIT lives in libbementalJIT*.a built by `emmake make`. Without this
# step, edits to bementalJIT/guests/sh4/wasm_emit.cpp silently never take
# effect — the link script picks up a stale archive from build-wasm/.
if [ "$SKIP_LINK" = 0 ]; then
  echo "=== bementalJIT build ==="
  cd /Users/caseybement/Bemental77.github.io/dreamcast/flycast-src/build-wasm
  # shellcheck disable=SC1091
  source /Users/caseybement/Bemental77.github.io/emsdk/emsdk_env.sh > /dev/null 2>&1
  emmake make bementalJIT bementalJITSh4 -j4 2>&1 | grep -E "error:|Built target" | tail -5

  echo "=== link ==="
  bash "$LINK_SCRIPT" 2>&1 | tail -3
else
  echo "=== link skipped (--skip-link) ==="
fi

# ---- probe ----
echo "=== probe (log → $PROBE_LOG${DURATION:+, duration=$DURATION ms}${IDLE:+, idle=$IDLE ms}) ==="

CMD="node $PROBE_JS --log $PROBE_LOG $KEEP_NOISE"
[ -n "$DURATION" ] && CMD="$CMD --duration $DURATION"
[ -n "$IDLE" ]     && CMD="$CMD --idle $IDLE"

# V8 flags pass through to puppeteer's Chrome via FLYCAST_V8_FLAGS — the probe
# forwards the string to chromium as `--js-flags=...`. Empty string = leave V8
# defaults alone.
if [ -n "$JS_FLAGS" ]; then
  echo "[probe] FLYCAST_V8_FLAGS=$JS_FLAGS"
  export FLYCAST_V8_FLAGS="$JS_FLAGS"
fi

# Tee probe output so the summary lands both on screen and in the log file's
# tail (handy for `grep` later).
SECONDS=0
$CMD
WALL_S=$SECONDS

echo ""
echo "[done] wall=${WALL_S}s log=$PROBE_LOG"
[ -n "$NAME" ] && echo "[archive] $ARCHIVE_DIR/${NAME}.log"

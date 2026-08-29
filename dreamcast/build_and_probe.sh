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
INTERP=""
PCTRACE=""
NAME=""
PROBE_LOG=""
JS_FLAGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-link|--skip-build) SKIP_LINK=1; shift ;;
    --duration)               DURATION="$2"; shift 2 ;;
    --idle)                   IDLE="$2"; shift 2 ;;
    --keep-noise)             KEEP_NOISE="--keep-noise"; shift ;;
    --interp)                 INTERP="--interp"; shift ;;
    --pctrace)                PCTRACE="--pctrace $2"; shift 2 ;;
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

# ---- rebuild the static archives the link consumes ----
# The link script (flycast_worker_link.sh:218-221) only re-compiles the BRIDGE TUs
# — EmscriptenWorker.cpp, flycast_stubs.cpp, rec_wasm.cpp, arm7_rec_wasm.cpp.
# Everything else it takes as prebuilt .a files, so any source that lands in an
# archive is invisible to a link-only iteration:
#   - bementalJIT/**              -> libbementalJIT.a, libbementalJITSh4.a
#   - flycast-src/core/**         -> libflycast_libretro.a   (MAIN_AR, link:26)
#
# [stale-archive trap 2026-08-28] flycast_libretro was NOT in this make line, so
# every edit under flycast-src/core silently never reached the binary while the
# script still printed a successful link. Caught on core/rend/gles/gles.cpp:221
# (the lowp->highp mobile precision fix): the fix was committed, the tree was
# "rebuilt", and the shipped .wasm still contained the OLD string. Tell:
#   grep -o -a -F "<a string you just edited>" \
#     dreamcast/flycast_libretro/flycast_worker_emcc.wasm | wc -l
# returns 0. Same class as the GameCube build-dir/BUILD= mismatch in CLAUDE.md.
if [ "$SKIP_LINK" = 0 ]; then
  echo "=== archive build (bementalJIT + flycast core) ==="
  cd /Users/caseybement/Bemental77.github.io/dreamcast/flycast-src/build-wasm
  # shellcheck disable=SC1091
  source /Users/caseybement/Bemental77.github.io/emsdk/emsdk_env.sh > /dev/null 2>&1
  emmake make bementalJIT bementalJITSh4 flycast_libretro -j4 2>&1 | grep -E "error:|Built target" | tail -8
  # The `| grep | tail` above means `set -e` sees grep/tail's exit, NOT make's.
  # Without this PIPESTATUS guard a FAILED build would silently fall through to
  # the probe, which then runs against a STALE wasm — a false "it still works"
  # result. The basis of testing is a fresh build every run; abort if it broke.
  if [ "${PIPESTATUS[0]}" -ne 0 ]; then echo "FATAL: archive build failed (bementalJIT / flycast core)"; exit 1; fi

  echo "=== link ==="
  bash "$LINK_SCRIPT" 2>&1 | tail -3
  if [ "${PIPESTATUS[0]}" -ne 0 ]; then echo "FATAL: link failed — refusing to probe a stale wasm"; exit 1; fi
else
  echo "=== link skipped (--skip-link) ==="
fi

# ---- probe ----
echo "=== probe (log → $PROBE_LOG${DURATION:+, duration=$DURATION ms}${IDLE:+, idle=$IDLE ms}) ==="

CMD="node $PROBE_JS --log $PROBE_LOG $KEEP_NOISE $INTERP $PCTRACE"
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

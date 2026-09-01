#!/bin/bash
# dreamcast/build_and_probe.sh — relink Flycast + headless boot probe.
#
# Mirrors the GameCube-side build_and_probe.sh inner loop. The probe
# (dreamcast/tools/flycast_probe.js) headlessly boots dreamcast.html,
# auto-clicks Start, filters emcc DEBUG/ASSERTIONS noise, and prints a
# clean summary of the milestones the boot hit (or the fatal it died on).
#
# Usage:
#   build_and_probe.sh                       # relink + probe → /tmp/probe-dcx.log
#   build_and_probe.sh --skip-link           # JS-only iteration
#   build_and_probe.sh --duration 60000      # 60s probe
#   build_and_probe.sh --idle 12000          # tolerate longer quiet periods
#   build_and_probe.sh --keep-noise          # show emcc DEBUG/ASSERTIONS too
#   build_and_probe.sh --name baseline       # archive to /tmp/probe-dcx-baseline.log
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
QUERY=""
PRESSES=""
LOADSTATE=""
CTXMS=""
PROFAT=""
PROFDUR=""
MOBILE=""
DEVICE=""
MOBILEFORCE=""
SWGL=""
SHOTDIR=""
SCREENSHOT=""
ROTATE=""
NOCOI=""
NOSWA=""
PROGMS=""
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
    # [2026-08-28] passthrough to flycast_probe.js so the canonical loop can drive
    # a SCENE, not just a boot. --q appends raw page query params (e.g. autoload=1,
    # which makes dreamcast.html:270 fetch /state.bin and restore past PSO's
    # serial-number gate); --press is repeatable and schedules timed key holds.
    # Without these the only reachable scene was "it booted", which is why a
    # character-select/creation regression went unreproduced for a whole session.
    --q)                      QUERY="$2"; shift 2 ;;
    --press)                  PRESSES="$PRESSES --press $2"; shift 2 ;;
    # [2026-08-29] --loadstate <file>: the probe's HTTP server serves THIS file at
    # GET /state.bin, so --q autoload=1 restores the named scene instead of
    # whatever stale state.bin happens to sit in the repo root. flycast_probe.js
    # already had the flag (:201); the canonical loop could not reach it.
    --loadstate)              LOADSTATE="$2"; shift 2 ;;
    # [2026-08-29] --ctxms <ms>: enable the periodic flycast_ctx_snapshot dump.
    # This is the ONLY way to reach the lever-4 [smc] line (icgen / smcS / smcB /
    # smcR / cpg / smcT / smcA, flycast_worker.js:1036) plus icn/isk/syncfp.
    # Those are COUNTS, so they stay valid on a loaded box where every wall-time
    # number is void — which is exactly when they are worth the most. Same gap as
    # --loadstate above: flycast_probe.js already had the flag, the canonical
    # loop could not reach it. NOTE --ctxms only sets the INTERVAL; the dump is
    # enabled by the separate --ctxsnap flag (flycast_probe.js:209/213 emit
    # &ctxsnap=1 and &ctxms=N as independent query params), so --ctxms alone is
    # inert. This passthrough therefore implies --ctxsnap.
    --ctxms)                  CTXMS="$2"; shift 2 ;;
    # [2026-08-29] --profat <ms> [--profdur <ms>]: CDP CPU profile of the EMU
    # WORKER (flycast_probe.js:654, writes /tmp/dcx-worker.cpuprofile). Same gap
    # as --loadstate/--ctxms: the flag existed in the probe, the canonical loop
    # could not reach it, so every attribution run so far was an improvised
    # `node flycast_probe.js ...` outside the loop. MEASUREMENT ARM ONLY — gate
    # #10 forbids comparing a profiled run's wall time to an unprofiled one;
    # a profile is for SHARES (who owns the time), never for sizing a win.
    --profat)                 PROFAT="$2"; shift 2 ;;
    --profdur)                PROFDUR="$2"; shift 2 ;;
    # [2026-09-01] mobile + isolation arms. Same gap as --loadstate/--ctxms/
    # --profat before them: flycast_probe.js has had --mobile/--device/--swgl/
    # --shotdir since 2026-08-28 and --nocoiheaders/--noswa/--progms since
    # today, but the CANONICAL LOOP could not reach any of them, so every
    # mobile run so far was an improvised `node flycast_probe.js ...` outside
    # gate #1. The device matrix runs through here now.
    #   --mobile / --device N  puppeteer device emulation (viewport/DPR/touch/UA
    #                          ONLY — not a phone GPU, not a phone memory ceiling)
    #   --nocoiheaders         serve with NO COOP/COEP, as GitHub Pages does, so
    #                          /coi-serviceworker.js is what produces isolation
    #   --noswa                also hide navigator.serviceWorker (private window)
    --mobile)                 MOBILE="1"; shift ;;
    --device)                 MOBILE="1"; DEVICE="$2"; shift 2 ;;
    --mobileforce)            MOBILEFORCE="--mobileforce"; shift ;;
    --swgl)                   SWGL="--swgl"; shift ;;
    --shotdir)                SHOTDIR="$2"; shift 2 ;;
    --screenshot)             SCREENSHOT="$2"; shift 2 ;;
    --rotate)                 ROTATE="$2"; shift 2 ;;
    --nocoiheaders)           NOCOI="--nocoiheaders"; shift ;;
    --noswa)                  NOSWA="--noswa"; shift ;;
    --progms)                 PROGMS="$2"; shift 2 ;;
    -h|--help)                sed -n '2,/^set -e/p' "$0" | sed 's/^# //;/^set -e/d'; exit 0 ;;
    *)                        echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ---- archive paths ----
# DC probe logs are /tmp/probe-dcx-* (own logs; the GC campaign owns /tmp/probe-*.log)
if [ -n "$NAME" ]; then
  PROBE_LOG="${PROBE_LOG:-/tmp/probe-dcx-${NAME}.log}"
else
  PROBE_LOG="${PROBE_LOG:-/tmp/probe-dcx.log}"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"  # repo root, derived — no hardcode
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
  cd "$ROOT/dreamcast/flycast-src/build-wasm"
  # shellcheck disable=SC1091
  source "$ROOT/emsdk/emsdk_env.sh" > /dev/null 2>&1
  emmake make bementalJIT bementalJITSh4 flycast_libretro -j4 2>&1 | grep -E "error:|Built target" | tail -8
  # The `| grep | tail` above means `set -e` sees grep/tail's exit, NOT make's.
  # Without this PIPESTATUS guard a FAILED build silently falls through to the
  # probe, which then runs against a STALE wasm — a false "it still works".
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
[ -n "$QUERY" ]    && CMD="$CMD --q $QUERY"
[ -n "$PRESSES" ]  && CMD="$CMD$PRESSES"
[ -n "$CTXMS" ]    && CMD="$CMD --ctxsnap --ctxms $CTXMS"
[ -n "$PROFAT" ]   && CMD="$CMD --profat $PROFAT"
[ -n "$PROFDUR" ]  && CMD="$CMD --profdur $PROFDUR"
if [ -n "$LOADSTATE" ]; then
  [ -f "$LOADSTATE" ] || { echo "FATAL: --loadstate file not found: $LOADSTATE" >&2; exit 2; }
  CMD="$CMD --loadstate $LOADSTATE"
fi

# Args that can legally contain spaces ("iPhone 13 Pro landscape") cannot ride
# in $CMD — it is expanded unquoted, so a device name would word-split into
# three bogus flags. Array, appended quoted.
EXTRA=()
[ -n "$MOBILE" ] && [ -z "$DEVICE" ] && EXTRA+=(--mobile)
[ -n "$DEVICE" ]      && EXTRA+=(--device "$DEVICE")
[ -n "$MOBILEFORCE" ] && EXTRA+=(--mobileforce)
[ -n "$SWGL" ]        && EXTRA+=(--swgl)
[ -n "$SHOTDIR" ]     && EXTRA+=(--shotdir "$SHOTDIR")
[ -n "$SCREENSHOT" ]  && EXTRA+=(--screenshot "$SCREENSHOT")
[ -n "$ROTATE" ]      && EXTRA+=(--rotate "$ROTATE")
[ -n "$NOCOI" ]       && EXTRA+=(--nocoiheaders)
[ -n "$NOSWA" ]       && EXTRA+=(--noswa)
[ -n "$PROGMS" ]      && EXTRA+=(--progms "$PROGMS")

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
$CMD "${EXTRA[@]}"
WALL_S=$SECONDS

echo ""
echo "[done] wall=${WALL_S}s log=$PROBE_LOG"
[ -n "$NAME" ] && echo "[archive] $PROBE_LOG"

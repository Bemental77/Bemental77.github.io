#!/bin/bash
# Build + link + probe pipeline for Dolphin/bementalJIT iteration.
#
# Usage:
#   build_and_probe.sh [--name NAME] [--query Q] [--rom 0|1] [--duration MS]
#                      [--skip-build] [PROBE_LOG]
#
# Examples:
#   build_and_probe.sh                          # default → /tmp/probe.log
#   build_and_probe.sh --name baseline          # → /tmp/probes/baseline.{log,summary.json,...}
#   build_and_probe.sh --skip-build --name x    # iterate JS-side only
#   build_and_probe.sh --query ppcbootdispatch=1
#
# Outputs:
#   PROBE_LOG            full probe console
#   SUMMARY_JSON         extracted key=value summary for diffing
#   PROBE_TRACE_PATH     chrome://tracing artifact
#   PROBE_METRICS_PATH   page.metrics() snapshots

set -e

# ---- args ----
NAME=""; QUERY=""; ROM=""; DURATION=""; SKIP_BUILD=0; PROBE_LOG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name)        NAME="$2"; shift 2 ;;
    --query)       QUERY="$2"; shift 2 ;;
    --rom)         ROM="$2"; shift 2 ;;
    --duration)    DURATION="$2"; shift 2 ;;
    --skip-build)  SKIP_BUILD=1; shift ;;
    -h|--help)     sed -n '2,/^set -e/p' "$0" | sed 's/^# //;/^set -e/d'; exit 0 ;;
    *)             PROBE_LOG="$1"; shift ;;
  esac
done

# ---- archive paths ----
# Every rebuild+probe overwrites — we don't keep prior findings around. The
# only artifact preserved is THIS run's set. Any prior runs (named or
# unnamed) get cleared before we write the new one.
if [ -n "$NAME" ]; then
  ARCHIVE_DIR="/tmp/probes"
  mkdir -p "$ARCHIVE_DIR"
  # Clear all prior probe artifacts — this run is the only valid one.
  rm -f "$ARCHIVE_DIR"/*.log "$ARCHIVE_DIR"/*.summary.json "$ARCHIVE_DIR"/*.trace.json "$ARCHIVE_DIR"/*.metrics.json 2>/dev/null
  rm -f /tmp/probe.log /tmp/probe.summary.json 2>/dev/null
  PROBE_LOG="${PROBE_LOG:-$ARCHIVE_DIR/${NAME}.log}"
  SUMMARY_JSON="$ARCHIVE_DIR/${NAME}.summary.json"
  export PROBE_TRACE_PATH="$ARCHIVE_DIR/${NAME}.trace.json"
  export PROBE_METRICS_PATH="$ARCHIVE_DIR/${NAME}.metrics.json"
else
  # Unnamed run — clear all prior probe artifacts including any named runs.
  rm -f /tmp/probe.log /tmp/probe.summary.json 2>/dev/null
  rm -rf /tmp/probes 2>/dev/null
  PROBE_LOG="${PROBE_LOG:-/tmp/probe.log}"
  SUMMARY_JSON="/tmp/probe.summary.json"
fi

# ---- env passthrough ----
[ -n "$QUERY" ]    && export PROBE_QUERY="$QUERY"
[ -n "$ROM" ]      && export ROM_IDX="$ROM"
[ -n "$DURATION" ] && export PROBE_DURATION_MS="$DURATION"

# ---- build + link ----
if [ "$SKIP_BUILD" = 0 ]; then
  source /Users/caseybement/Bemental77.github.io/emsdk/emsdk_env.sh > /dev/null 2>&1
  cd /Users/caseybement/Bemental77.github.io/gamecube/dolphin-src/build-wasm

  echo "=== build ==="
  emmake make dolphin_libretro -j4 2>&1 | grep -E "error:|Built target dolphin" | tail -3

  echo "=== link ==="
  LINK_SCRIPT=/tmp/dolphin_worker_link.sh
  [ -f "$LINK_SCRIPT" ] || LINK_SCRIPT=/Users/caseybement/Bemental77.github.io/gamecube/dolphin-bridge/dolphin_worker_link.sh
  bash "$LINK_SCRIPT" 2>&1 | tail -1
else
  echo "=== build / link skipped (--skip-build) ==="
fi

# ---- provenance / contamination stamp (CLAUDE.md gate #8) ----
# Makes every probe log self-identifying: which commit, whether the tree is
# dirty, the built-worker hash, and how many TEMPORARY diagnostic markers are
# baked into the binary. A clean perf/boot answer REQUIRES diag_markers=0 —
# this is what catches "probed a stale/instrumented binary as if it were clean."
REPO=/Users/caseybement/Bemental77.github.io
WASM_JS="$REPO/gamecube/dolphin_libretro/dolphin_worker_emcc.js"
WASM_BIN="$REPO/gamecube/dolphin_libretro/dolphin_worker_emcc.wasm"
DIAG_RE='mem1-dump|blk3a44|term-rsv2|region-slot|smap2|chain362c|wasmdump|ret-trace|flag-w|text-corrupt|c4c-poll'
PROV_COMMIT=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo nogit)
PROV_DIRTY=$(git -C "$REPO" status --porcelain 2>/dev/null | grep -c . || true)
PROV_SHA=$(shasum -a 1 "$WASM_BIN" 2>/dev/null | cut -c1-12)
PROV_DIAG_LIST=$(grep -oE "$DIAG_RE" "$WASM_JS" 2>/dev/null | sort -u | paste -sd, - || true)
PROV_DIAG_N=$(grep -oE "$DIAG_RE" "$WASM_JS" 2>/dev/null | sort -u | grep -c . || true)
PROVENANCE="[provenance] commit=$PROV_COMMIT dirty_files=$PROV_DIRTY wasm_sha=$PROV_SHA diag_markers=$PROV_DIAG_N${PROV_DIAG_LIST:+ ($PROV_DIAG_LIST)}"
echo "$PROVENANCE"
[ "$PROV_DIAG_N" -gt 0 ] && echo "[provenance] WARNING: build is NOT clean — $PROV_DIAG_N diagnostic marker(s) baked in; perf/boot numbers are untrustworthy."

# ---- probe ----
echo "=== probe ($PROBE_LOG${PROBE_QUERY:+ q=$PROBE_QUERY}${ROM_IDX:+ rom=$ROM_IDX}${PROBE_DURATION_MS:+ d=${PROBE_DURATION_MS}ms}) ==="
SECONDS=0
node /Users/caseybement/dolphin_render_probe.js > "$PROBE_LOG" 2>&1
WALL_MS=$((SECONDS * 1000))
# Stamp provenance into the probe log itself so it can never be read as clean
# without proof.
printf '%s\n' "$PROVENANCE" >> "$PROBE_LOG"

# ---- structured summary extraction ----
# Disable -e for parsing: grep returns 1 on no match and we'd rather emit
# `null` than fail the whole script on a missing sentinel.
set +e

# Scalar extractor: latest occurrence of `KEY=VALUE` anywhere in the log,
# where VALUE is non-space, non-comma, non-bracket.
extract() {
  grep -oE "\\b$1=[^ ,[]+" "$PROBE_LOG" 2>/dev/null | tail -1 | sed -E "s/^$1=//"
}

# Counters
VIDEO_CB=$(grep -E "^--- video_cb \(count=" "$PROBE_LOG" 2>/dev/null | sed -E 's/.*count=([0-9]+).*/\1/' | tail -1)
WJ_COUNT=$(grep -c '^  \[wild\] #' "$PROBE_LOG" 2>/dev/null)
WJ_COUNT=${WJ_COUNT:-0}

# Slice loop progress (last [slice] line)
SLICE_LAST=$(grep '^  \[slice\] n=' "$PROBE_LOG" 2>/dev/null | tail -1)
SLICE_N=$(echo "$SLICE_LAST" | sed -nE 's/.*n=([0-9]+).*/\1/p')
SLICE_INNER_MS=$(echo "$SLICE_LAST" | sed -nE 's/.*inner=([0-9]+)ms.*/\1/p')

# Sentinel scalars (see SENTINEL_KEYS.md for what each measures)
A=$(extract A);   B=$(extract B);   C=$(extract C);   D=$(extract D)
W=$(extract W);   E=$(extract E);   P=$(extract P);   G=$(extract G)
H=$(extract H);   F=$(extract F);   I=$(extract I);   M=$(extract M)
T=$(extract T);   R=$(extract R)
AC=$(extract AC); UE=$(extract UE)
FEED=$(extract feed); RB=$(extract rb); NB=$(extract nb); RR=$(extract RR)
WJ_CNT=$(extract wj_cnt); OSLC=$(extract oslc)
WEDGE_PC=$(extract Gsrr0)
DSPCR=$(extract lastDSPCR)
PI_MASK=$(extract PImask); PI_CAUSE=$(extract PIcause)
JIT_FIRST=$(grep -oE '^jit_first count: +[0-9]+' "$PROBE_LOG" 2>/dev/null | grep -oE '[0-9]+$' | tail -1)
JIT_HB=$(grep -oE '^jit heartbeat \(1M each\): +[0-9]+' "$PROBE_LOG" 2>/dev/null | grep -oE '[0-9]+$' | tail -1)

# Exit reason
EXIT_REASON=$(grep '^\[probe\] EXIT-STUCK:' "$PROBE_LOG" 2>/dev/null | head -1 | sed 's/^\[probe\] EXIT-STUCK: //')
[ -z "$EXIT_REASON" ] && EXIT_REASON="duration-elapsed"

set -e

# ---- emit summary ----
echo ""
echo "=== summary ==="
printf '[headline] video_cb=%s AC=%s F=%s wj=%s slice_n=%s slice_inner_ms=%s wedge_pc=%s exit=%s wall_ms=%s\n' \
  "${VIDEO_CB:-0}" "${AC:-?}" "${F:-?}" "${WJ_COUNT}" "${SLICE_N:-0}" "${SLICE_INNER_MS:-0}" "${WEDGE_PC:-?}" "$EXIT_REASON" "$WALL_MS"

# JSON for downstream diffing (probe_diff.sh)
qstr() { if [ -z "$1" ]; then echo null; else printf '"%s"' "$1"; fi; }
qnum() { if [ -z "$1" ]; then echo null; else echo "$1"; fi; }
cat > "$SUMMARY_JSON" <<EOF
{
  "name":           $(qstr "$NAME"),
  "wall_ms":        $WALL_MS,
  "exit_reason":    $(qstr "$EXIT_REASON"),
  "video_cb":       $(qnum "$VIDEO_CB"),
  "wedge_pc":       $(qstr "$WEDGE_PC"),
  "slice_n":        $(qnum "$SLICE_N"),
  "slice_inner_ms": $(qnum "$SLICE_INNER_MS"),
  "wj_count":       $WJ_COUNT,
  "jit_first":      $(qnum "$JIT_FIRST"),
  "jit_heartbeat":  $(qnum "$JIT_HB"),
  "sentinel": {
    "A":  $(qnum "$A"),    "B":  $(qnum "$B"),    "C":  $(qnum "$C"),    "D":  $(qnum "$D"),
    "W":  $(qnum "$W"),    "E":  $(qnum "$E"),    "P":  $(qnum "$P"),    "G":  $(qnum "$G"),
    "H":  $(qnum "$H"),    "F":  $(qnum "$F"),    "I":  $(qnum "$I"),    "M":  $(qnum "$M"),
    "T":  $(qnum "$T"),    "R":  $(qnum "$R"),
    "AC": $(qnum "$AC"),   "UE": $(qnum "$UE"),   "feed": $(qnum "$FEED"),
    "rb": $(qnum "$RB"),   "nb": $(qnum "$NB"),   "RR": $(qnum "$RR"),
    "wj_cnt": $(qnum "$WJ_CNT"), "oslc": $(qnum "$OSLC"),
    "lastDSPCR": $(qstr "$DSPCR"),
    "PImask":    $(qstr "$PI_MASK"),
    "PIcause":   $(qstr "$PI_CAUSE")
  }
}
EOF

echo "[summary-json] $SUMMARY_JSON"
[ -n "$NAME" ] && echo "[archive] $ARCHIVE_DIR/${NAME}.{log,summary.json,trace.json,metrics.json}"

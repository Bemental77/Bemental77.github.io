#!/bin/bash
#
# probe_trajectory_diff.sh
#
# Run N successive flycast WASM probes (skip-link, same wasm + same ROM) and
# compare the first 200 distinct SH4 PCs across runs to find the first
# divergence point in the boot trajectory.
#
# Existing infra:
#   dreamcast/build_and_probe.sh --skip-link --duration N --idle M --name <tag>
#   writes the full log to /tmp/dc-probes/<tag>.log
#
# SH4 dispatch lines look like:
#   [flycast-worker] sh4 dispatch #N pc=0xXXXXXXXX r0=0xXXX r6=0xXXX sr=0xXXX
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_AND_PROBE="$REPO_DIR/dreamcast/build_and_probe.sh"
LOG_DIR="/tmp/dc-probes"

RUNS=3
DURATION=15000
IDLE=8000
NAME_PREFIX="variance"

usage() {
  cat <<'EOF'
Usage: probe_trajectory_diff.sh [options]

Run N successive flycast WASM probes (sequentially, same wasm + same ROM)
and diff the first 200 distinct SH4 PCs across consecutive runs to locate
the first boot-trajectory divergence point.

Options:
  --runs N            Number of probe runs (default: 3)
  --duration MS       Duration per run, ms (default: 15000)
  --idle MS           Idle ms per run    (default: 8000)
  --name-prefix STR   Prefix for log tags (default: variance)
                      Logs land at /tmp/dc-probes/<prefix>-<i>.log
  -h, --help          Show this help and exit 0

Reports per-run total dispatches, top-3 stuck-PCs, final stop reason,
and inline diffs of first-200-distinct-PC sequences between runs.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs)
      RUNS="$2"; shift 2 ;;
    --duration)
      DURATION="$2"; shift 2 ;;
    --idle)
      IDLE="$2"; shift 2 ;;
    --name-prefix)
      NAME_PREFIX="$2"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2 ;;
  esac
done

if ! [[ "$RUNS" =~ ^[0-9]+$ ]] || (( RUNS < 1 )); then
  echo "Error: --runs must be a positive integer (got: $RUNS)" >&2
  exit 2
fi
if ! [[ "$DURATION" =~ ^[0-9]+$ ]]; then
  echo "Error: --duration must be a non-negative integer (got: $DURATION)" >&2
  exit 2
fi
if ! [[ "$IDLE" =~ ^[0-9]+$ ]]; then
  echo "Error: --idle must be a non-negative integer (got: $IDLE)" >&2
  exit 2
fi

if [[ ! -x "$BUILD_AND_PROBE" ]]; then
  echo "Error: build_and_probe.sh not found or not executable at:" >&2
  echo "  $BUILD_AND_PROBE" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

echo "==> probe_trajectory_diff: runs=$RUNS duration=${DURATION}ms idle=${IDLE}ms prefix=$NAME_PREFIX"
echo "    log dir: $LOG_DIR"
echo

LOGS=()
TAGS=()

# Run probes sequentially (each owns the wasm worker).
for (( i=1; i<=RUNS; i++ )); do
  TAG="${NAME_PREFIX}-${i}"
  LOG="${LOG_DIR}/${TAG}.log"
  TAGS+=("$TAG")
  LOGS+=("$LOG")
  echo "==> [run $i/$RUNS] tag=$TAG"
  "$BUILD_AND_PROBE" --skip-link --duration "$DURATION" --idle "$IDLE" --name "$TAG"
  echo "==> [run $i/$RUNS] done -> $LOG"
  echo
done

# Helper: extract first 200 distinct PCs in dispatch order from a log.
extract_distinct_pcs() {
  local log="$1"
  grep "sh4 dispatch" "$log" \
    | awk -F'pc=' '{print $2}' \
    | awk '{print $1}' \
    | awk '!seen[$0]++' \
    | head -200
}

# Per-run summary.
echo "============================================================"
echo "Per-run summary"
echo "============================================================"
for (( i=0; i<${#LOGS[@]}; i++ )); do
  TAG="${TAGS[$i]}"
  LOG="${LOGS[$i]}"
  echo
  echo "-- run $((i+1)): $TAG"
  echo "   log: $LOG"

  if [[ ! -f "$LOG" ]]; then
    echo "   (log missing)"
    continue
  fi

  TOTAL=$(grep -c 'sh4 dispatch' "$LOG" || true)
  echo "   total sh4 dispatches: $TOTAL"

  echo "   top-3 PCs (count pc):"
  grep 'sh4 dispatch' "$LOG" \
    | awk -F'pc=' '{print $2}' \
    | awk '{print $1}' \
    | sort | uniq -c | sort -rn | head -3 \
    | sed 's/^/     /'

  STOP=$(grep 'stop:' "$LOG" | tail -1 || true)
  if [[ -n "$STOP" ]]; then
    echo "   final stop: $STOP"
  else
    echo "   final stop: (no 'stop:' line found)"
  fi
done

# Pairwise diffs of first-200-distinct-PC sequences.
echo
echo "============================================================"
echo "First-200-distinct-PC pairwise diffs"
echo "============================================================"

if (( RUNS < 2 )); then
  echo "(only 1 run requested; no diffs to produce)"
  exit 0
fi

TMP_DIR="$(mktemp -d -t probe-trajectory-diff.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Pre-extract once per run.
PC_FILES=()
for (( i=0; i<${#LOGS[@]}; i++ )); do
  PC_FILE="${TMP_DIR}/pcs-${TAGS[$i]}.txt"
  PC_FILES+=("$PC_FILE")
  if [[ -f "${LOGS[$i]}" ]]; then
    extract_distinct_pcs "${LOGS[$i]}" > "$PC_FILE"
  else
    : > "$PC_FILE"
  fi
done

for (( i=0; i<RUNS-1; i++ )); do
  A_TAG="${TAGS[$i]}"
  B_TAG="${TAGS[$((i+1))]}"
  A_PCS="${PC_FILES[$i]}"
  B_PCS="${PC_FILES[$((i+1))]}"

  echo
  echo "-- diff: $A_TAG vs $B_TAG"
  echo "   A: $A_PCS  ($(wc -l < "$A_PCS" | tr -d ' ') distinct PCs)"
  echo "   B: $B_PCS  ($(wc -l < "$B_PCS" | tr -d ' ') distinct PCs)"
  echo

  if diff -u "$A_PCS" "$B_PCS" > "${TMP_DIR}/diff-${i}.txt"; then
    echo "   (identical first-200-distinct-PC sequences)"
  else
    sed 's/^/   /' "${TMP_DIR}/diff-${i}.txt"
    FIRST_DIVERGE=$(diff "$A_PCS" "$B_PCS" | grep -E '^[0-9]' | head -1 || true)
    if [[ -n "$FIRST_DIVERGE" ]]; then
      echo
      echo "   first divergence at line(s): $FIRST_DIVERGE"
    fi
  fi
done

echo
echo "==> probe_trajectory_diff: done"

#!/bin/bash
# Stable build + link + probe pipeline for Dolphin/bementalCompiler iteration.
# Single command path so Claude Code permissions are granted once.
#
# Usage: build_and_probe.sh [probe_log_path]
#   default probe log: /tmp/probe.log

set -e

PROBE_LOG="${1:-/tmp/probe.log}"

source /Users/caseybement/Bemental77.github.io/emsdk/emsdk_env.sh > /dev/null 2>&1
cd /Users/caseybement/Bemental77.github.io/gamecube/dolphin-src/build-wasm

echo "=== build ==="
emmake make dolphin_libretro -j4 2>&1 | grep -E "error:|Built target dolphin" | tail -3

echo "=== link ==="
# Prefer /tmp copy (faster iteration when active); fall back to repo copy
# at gamecube/dolphin-bridge/ which survives /tmp wipes.
LINK_SCRIPT=/tmp/dolphin_worker_link.sh
[ -f "$LINK_SCRIPT" ] || LINK_SCRIPT=/Users/caseybement/Bemental77.github.io/gamecube/dolphin-bridge/dolphin_worker_link.sh
bash "$LINK_SCRIPT" 2>&1 | tail -1

echo "=== probe (log: $PROBE_LOG) ==="
node /Users/caseybement/dolphin_render_probe.js > "$PROBE_LOG" 2>&1

echo "=== summary ==="
echo "--- canvas ---"
grep "nonBlack" "$PROBE_LOG" | head -1
echo "--- latest jit-inner ---"
grep "jit-inner" "$PROBE_LOG" | tail -3
echo "--- perf ---"
grep "perf" "$PROBE_LOG" | head -2
echo "--- HLE replace counts ---"
grep "HLE replace" "$PROBE_LOG" | grep -oE "hook=[0-9]+" | sort | uniq -c
echo "--- frames ---"
grep -c "frame#.*after" "$PROBE_LOG" | head -1
echo "--- VI/Frame ---"
grep -E "VI write|XFB|first frame|OutputField #" "$PROBE_LOG" | head -5
echo "--- patches installed ---"
grep -E "HLE patches|HLEMemset patched" "$PROBE_LOG" | head -3

#!/usr/bin/env bash
# run_tests.sh — canonical build-AND-run wrapper for the GameCube bementalJIT
# test suite. Exists so tests can never be run from a stale artifact or the
# wrong (raw-node) harness again: it ALWAYS reconfigures + rebuilds the emcc
# targets, then runs each in the COI/headless-browser harness they require.
#
# Usage: bash gamecube/bementalJIT/run_tests.sh [test_name ...]
#   (no args = all targets; or pass specific names e.g. test_gekko test_dispatch)
set -u
ROOT=/Users/caseybement/Bemental77.github.io
SRC=$ROOT/gamecube/bementalJIT
BUILD=$SRC/build-emcc-test

echo "=== emsdk env ==="
source "$ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1 || { echo "FATAL: emsdk_env.sh failed"; exit 1; }

echo "=== configure (emcc, tests on) ==="
emcmake cmake -S "$SRC" -B "$BUILD" \
  -DBEMENTAL_BUILD_TESTS=ON -DBEMENTAL_GUEST_POWERPC=ON -DBEMENTAL_GUEST_POWERPC_NEXT=ON \
  > /tmp/bjit_test_cmake.log 2>&1 || { echo "FATAL: cmake configure failed (see /tmp/bjit_test_cmake.log)"; tail -15 /tmp/bjit_test_cmake.log; exit 1; }

echo "=== build (rebuild all test targets) ==="
cmake --build "$BUILD" -j4 > /tmp/bjit_test_build.log 2>&1
if grep -qE "error:|Error " /tmp/bjit_test_build.log; then
  echo "FATAL: build errors:"; grep -E "error:|Error " /tmp/bjit_test_build.log | head -10; exit 1
fi
echo "build OK ($(date '+%H:%M:%S'))"

# Targets in dependency-friendly order. test_analyst is pure C++ (no block
# instantiation); the rest instantiate JIT block modules and need the browser.
ALL_TESTS=(test_analyst test_dispatch test_gekko test_diff test_pi_mask_path test_str_hle_pattern test_perf_t1)
TESTS=("${@:-${ALL_TESTS[@]}}")

echo "=== run (COI headless-browser harness) ==="
declare -a RESULTS
fail=0
for t in "${TESTS[@]}"; do
  html="$BUILD/tests/$t.html"
  if [ ! -f "$html" ]; then RESULTS+=("$t: MISSING (.html not built)"); fail=1; continue; fi
  # confirm artifact is fresh relative to the build log we just wrote
  line=$(node "$SRC/tests/run_browser_test.mjs" "$t" "$BUILD" 2>&1 | grep '\[verdict\]')
  RESULTS+=("${line#\[verdict\] }")
  case "$line" in
    *": PASS"*) ;;
    *) fail=1 ;;
  esac
done

echo
echo "=== SUMMARY ==="
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo
[ "$fail" -eq 0 ] && echo "ALL PASS" || echo "SOME TESTS NOT PASSING (see per-test /tmp/bjit-tests/<name>.log)"
exit "$fail"

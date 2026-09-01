#!/usr/bin/env bash
# run_leaf_inline_test.sh — build + run the pure-leaf `bl` inlining correctness
# gate, HOST-NATIVELY. No Emscripten, no browser, no ROM, ~1 second.
#
#   bash gamecube/bementalJIT/tests/run_leaf_inline_test.sh
#
# Why this is not a CMake target: gamecube/bementalJIT/tests/CMakeLists.txt:5-8
# early-returns ("bementalJIT tests skipped (requires Emscripten)") under a
# native cmake, and every target there builds to .html and must be opened in a
# browser. test_leaf_inline.cpp deliberately depends on only two TUs —
# ppc_analyst.cpp and ppc_tables.cpp — whose entire include closure is
# bementalJIT/types.h, common/bit_set.h, common/op_info.h and ppc_offsets.h. So
# it compiles and runs on the host directly.
#
# Exit status: 0 = every assertion passed. Non-zero = at least one FAIL.
# VACUOUS results are reported but do not fail the run; read them — they mean an
# assertion's precondition was unmet and it discriminated nothing.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
JIT="$ROOT/gamecube/bementalJIT"
NEXT="$JIT/guests/powerpc-next"
OUT="${LEAF_TEST_OUT:-${TMPDIR:-/tmp}/bemental_leaf_inline_test}"
mkdir -p "$OUT"

# Apple clang 12 (the /usr/bin default on this box) rejects -std=c++20 and wants
# -std=c++2a; common/bit_set.h needs C++20 <bit> (std::countr_zero/popcount).
CXX="${CXX:-/usr/bin/clang++}"
STD="${CXXSTD:-}"
if [ -z "$STD" ]; then
  if echo 'int main(){}' | "$CXX" -std=c++20 -x c++ - -o /dev/null 2>/dev/null; then
    STD=c++20; else STD=c++2a; fi
fi

echo "== API presence ========================================================"
# Groups A and C exercise the [LEAF-INLINE] decoder API. Its DECLARATIONS live in
# ppc_analyst.h; if the DEFINITIONS are absent the link fails, so detect first and
# build a mode that still runs (and reports the absence as RED) instead.
API_FLAG=""
if grep -qE '^\s*(std::size_t|size_t)\s+DecodeBlockLeafInlined\s*\(' "$NEXT/ppc_analyst.cpp" 2>/dev/null; then
  echo "  DecodeBlockLeafInlined defined in ppc_analyst.cpp -> full build"
else
  echo "  DecodeBlockLeafInlined NOT defined in ppc_analyst.cpp"
  echo "  -> building with -DLEAF_API_MISSING; Groups A and C report RED-by-absence"
  API_FLAG="-DLEAF_API_MISSING"
fi
echo

echo "== production wiring ==================================================="
# The decoder only matters if the production callers actually use it. Both build
# insts[] by decoding contiguously until a terminator (which `bl` is), and
# build_block_next routes to AnalyzeOps ONLY when instr_pcs != nullptr
# (ppc_emit.cpp:1905-1907). Until these callers change, the whole lever is
# unreachable at runtime no matter how green the unit tests are — the same
# "already implements exactly this fix and is DEAD CODE here" failure recorded
# for LEAF-IDLE in gamecube/docs/sab-frame-governor/TASKS.md.
wired=0
check_caller() { # <label> <file>
  if grep -qF 'DecodeBlockLeafInlined' "$2" 2>/dev/null; then
    printf '  WIRED     %s\n' "$1"; wired=$((wired+1))
  else
    printf '  not wired %s\n' "$1"
  fi
}
check_caller "dolphin_worker / EmuThread  (JitWasm.cpp:976-993)" \
  "$ROOT/gamecube/dolphin-src/Source/Core/Core/PowerPC/JitWasm/JitWasm.cpp"
check_caller "ppc-worker                  (ppc_worker_main.cpp:417-427)" \
  "$ROOT/gamecube/ppc-worker/ppc_worker_main.cpp"
if [ "$wired" -eq 0 ]; then
  echo "  -> NEITHER production caller invokes the new decoder. Even a fully green"
  echo "     unit run does not mean the SAB governor is idle-skipped at runtime."
elif [ "$wired" -lt 2 ]; then
  echo "  -> only $wired of 2 callers wired; the other path still cuts at the bl."
fi
# build_block_next must receive instr_pcs (else it takes the contiguous Analyze
# path at ppc_emit.cpp:1918 and m_noncontiguous is never set).
if grep -qF 'pa.AnalyzeOps(insts, instr_pcs, count, &block, &buffer);' "$NEXT/ppc_emit.cpp"; then
  echo "  ok        build_block_next still routes instr_pcs -> AnalyzeOps (ppc_emit.cpp)"
else
  echo "  CHANGED   build_block_next's instr_pcs -> AnalyzeOps route moved; re-read it"
fi
echo

echo "== build ==============================================================="
echo "  CXX=$CXX  -std=$STD  $API_FLAG"
set -o pipefail
"$CXX" -std="$STD" -O0 -g -Wall -Wextra -Wno-unused-parameter $API_FLAG \
  -I"$JIT/include" -I"$NEXT" -I"$JIT" -I"$ROOT/gamecube" \
  "$JIT/tests/test_leaf_inline.cpp" \
  "$NEXT/ppc_analyst.cpp" \
  "$NEXT/ppc_tables.cpp" \
  -o "$OUT/test_leaf_inline" 2>&1 | sed 's/^/  /'
rc=$?
if [ "$rc" -ne 0 ]; then echo "  BUILD FAILED (rc=$rc)"; exit "$rc"; fi
echo "  built $OUT/test_leaf_inline"
echo

echo "== run ================================================================="
"$OUT/test_leaf_inline"
rc=$?
echo
echo "== exit $rc ============================================================"
exit "$rc"

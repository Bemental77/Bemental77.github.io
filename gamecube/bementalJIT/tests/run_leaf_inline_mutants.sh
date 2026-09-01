#!/usr/bin/env bash
# run_leaf_inline_mutants.sh — RED-TEST DISCIPLINE for test_leaf_inline.cpp.
#
#   bash gamecube/bementalJIT/tests/run_leaf_inline_mutants.sh
#
# A corpus that only ever prints PASS proves nothing. This script deliberately
# BREAKS the analyst — five separate one-line mutations, each removing one real
# safety rule — and checks that the corpus catches each one, with the expected
# assertion. Every mutation is applied to a COPY in a scratch tree; the working
# tree is never touched.
#
# Why this exists: n64/docs/jit/TASKS.md:511-515 records two join-contract
# divergences that shipped for multiple waves and passed every 600-frame
# differential. The lesson banked there is that a unit corpus is only worth what
# its red tests are worth. `tools/n64_emit_unit_test.mjs` states the same bar:
# "22 cases, and every one was RED on some real revision of the emitter".
#
# Mutants, and the rule each deletes:
#   M1  IsBusyWaitLoop's `branchTo == block->m_address` self-check
#   M2  the LEAF-IDLE noncontiguous seam-pairing eligibility check
#   M3  IsBusyWaitLoop's rejection of OpType::Store
#   M4  IsBusyWaitLoop's rejection of CTR-counted back-edges (branchUsesCtr)
#   M5  IsBusyWaitLoop's rejection of OpType::SPR (mflr/mtlr)
#
# Exit 0 = every mutant was caught by at least one assertion, and the unmutated
# control was fully green. Non-zero = a mutant SURVIVED, i.e. the corpus has a
# hole exactly where that rule is.

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
JIT="$ROOT/gamecube/bementalJIT"
NEXT="$JIT/guests/powerpc-next"
S="${LEAF_MUT_OUT:-${TMPDIR:-/tmp}/bemental_leaf_mutants}"
CXX="${CXX:-/usr/bin/clang++}"
STD="${CXXSTD:-}"
if [ -z "$STD" ]; then
  if echo 'int main(){}' | "$CXX" -std=c++20 -x c++ - -o /dev/null 2>/dev/null; then
    STD=c++20; else STD=c++2a; fi
fi

rm -rf "$S"; mkdir -p "$S"
cp -R "$JIT/guests" "$S/guests"; cp -R "$JIT/include" "$S/include"
A="$S/guests/powerpc-next/ppc_analyst.cpp"

API_FLAG=""
grep -qE '^\s*(std::size_t|size_t)\s+DecodeBlockLeafInlined\s*\(' "$NEXT/ppc_analyst.cpp" \
  || API_FLAG="-DLEAF_API_MISSING"

fails=0
run_one () {   # <label> <expect: CLEAN|CAUGHT> <expected-assertion-substring>
  local label="$1" want="$2" needle="${3:-}"
  "$CXX" -std="$STD" -O0 -w $API_FLAG \
    -I"$S/include" -I"$S/guests/powerpc-next" -I"$S" \
    "$JIT/tests/test_leaf_inline.cpp" "$A" \
    "$S/guests/powerpc-next/ppc_tables.cpp" -o "$S/t" 2>"$S/build.err"
  if [ $? -ne 0 ]; then
    printf '  %-4s BUILD FAILED\n' "$label"; sed 's/^/       /' "$S/build.err" | head -5
    fails=$((fails+1)); return
  fi
  local out; out="$("$S/t" 2>&1)"
  local n_fail; n_fail="$(printf '%s\n' "$out" | grep -c '^\[FAIL\]')"
  local total;  total="$(printf '%s\n' "$out" | grep 'TOTAL' | sed 's/.*TOTAL/TOTAL/')"
  if [ "$want" = CLEAN ]; then
    if [ "$n_fail" -eq 0 ]; then printf '  %-4s ok      unmutated control is green   (%s)\n' "$label" "$total"
    else printf '  %-4s BROKEN  control has %s failure(s)\n' "$label" "$n_fail"; fails=$((fails+1)); fi
  else
    if [ "$n_fail" -eq 0 ]; then
      printf '  %-4s SURVIVED  the corpus did NOT catch this mutation\n' "$label"; fails=$((fails+1))
    elif [ -n "$needle" ] && ! printf '%s\n' "$out" | grep -q "$needle"; then
      printf '  %-4s caught, but NOT by the expected assertion (%s)\n' "$label" "$needle"
      printf '%s\n' "$out" | grep '^\[FAIL\]' | sed 's/^/         /'
      fails=$((fails+1))
    else
      printf '  %-4s caught  by %s failure(s)\n' "$label" "$n_fail"
      printf '%s\n' "$out" | grep '^\[FAIL\]' | sed 's/^/         /' | cut -c1-110
    fi
  fi
}

echo "== mutation matrix (scratch tree: $S) =================================="
[ -n "$API_FLAG" ] && echo "  NOTE: building $API_FLAG -- Groups A/C are not exercised"

cp "$NEXT/ppc_analyst.cpp" "$A"
run_one "M0" CLEAN

cp "$NEXT/ppc_analyst.cpp" "$A"
perl -0pi -e 's/if \(code\[i\]\.branchTo == block->m_address && i \+ 1 == instructions\)/if (i + 1 == instructions)/' "$A"
run_one "M1" CAUGHT "G.4a"

cp "$NEXT/ppc_analyst.cpp" "$A"
perl -0pi -e 's/if \(block->m_noncontiguous\) \{/if (false) {/' "$A"
run_one "M2" CAUGHT "G.6a"

cp "$NEXT/ppc_analyst.cpp" "$A"
perl -0pi -e 's/\} else if \(type != OpType::Integer && type != OpType::Load\) \{/} else if (type != OpType::Integer \&\& type != OpType::Load \&\& type != OpType::Store) {/' "$A"
run_one "M3" CAUGHT "G.5a"

cp "$NEXT/ppc_analyst.cpp" "$A"
perl -0pi -e 's/if \(code\[i\]\.branchUsesCtr\) return false;/if (false) return false;/' "$A"
run_one "M4" CAUGHT "G.4c"

cp "$NEXT/ppc_analyst.cpp" "$A"
perl -0pi -e 's/\} else if \(type != OpType::Integer && type != OpType::Load\) \{/} else if (type != OpType::Integer \&\& type != OpType::Load \&\& type != OpType::SPR) {/' "$A"
run_one "M5" CAUGHT "G.3c"

echo
if [ "$fails" -eq 0 ]; then
  echo "== all 5 mutants caught; control green ================================="
else
  echo "== $fails PROBLEM(S): a surviving mutant is a HOLE in the corpus ======="
fi
exit "$fails"

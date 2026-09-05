#!/usr/bin/env bash
# preflight_all.sh — every gate that needs NO browser, NO build, and NO lock.
#
# WHY. Concurrent agents share this working tree and this box. The expensive
# gates (probes, matrices, emulator suites) queue behind tools/probe_lock.sh and
# are load-sensitive; these are neither. Running them costs almost nothing and
# catches the classes that have actually bitten this repo:
#
#   * a commit whose tree collapsed to ONE file (the index guard below)
#   * SAB scratch cells claimed by two subsystems, where arming one silently
#     disabled another's safety brake — and one of them SELF-ARMED on an
#     ordinary block-cache eviction
#   * emitter/analyst regressions (the leaf-inline corpus + its mutation matrix)
#   * a runtime asset stripped by an rsync --exclude, which reads in production
#     as an emulator bug rather than a deploy bug
#   * harnesses that stopped parsing after an edit
#
# Deliberately NOT here: anything whose verdict depends on machine load, and
# anything requiring the probe lock. A gate that can flake is not a gate.
#
#     bash tools/preflight_all.sh            # exit 1 if any gate fails
#
# Exit code is the number of failed gates (0 = clean), so it can gate CI.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 99

PASS=0; FAIL=0; FAILED=()

gate() {
  local name="$1"; shift
  printf '  %-46s ' "$name"
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then
    echo "PASS"; PASS=$((PASS+1))
  else
    echo "FAIL (exit $rc)"; FAIL=$((FAIL+1)); FAILED+=("$name")
    echo "$out" | tail -6 | sed 's/^/        /'
  fi
}

echo "== preflight (no browser, no build, no lock) =========================="

# --- the index-collapse guard -------------------------------------------------
# A commit went out whose tree held ONE file while `git status` showed only one
# modified path. Beyond the lost attribution, a near-empty tip POISONS every
# later push repo-wide: object exclusion walks from the tips the server
# advertises, so excluding a one-file tip excludes almost nothing and the pack
# balloons (measured: 8 objects vs 8,253 / 6.35 GiB, rejected with HTTP 400).
tracked_sane() {
  local n; n=$(git ls-files | wc -l | tr -d ' ')
  echo "tracked files: $n"
  [ "$n" -ge 7000 ]
}
gate "index not collapsed (git ls-files)" tracked_sane

# --- the stale-worktree disk guard --------------------------------------------
# [2026-09-04] Casey found the repo at 188 GB. 145 GB of that was
# .claude/worktrees: 19 abandoned agent worktrees, each a full checkout of a
# ~43 GB tree, left behind by agents that had finished. Nothing ever cleaned
# them, so they only accumulated. macOS reports the repo under "Documents" in
# Storage settings, so it reads as the user's own data.
#
# Removing a worktree destroys NOTHING — `git worktree remove` deletes only the
# checkout; every branch and commit stays in .git (verified: both removed
# branches and their commits were still present afterwards). So this is safe to
# act on, and the fix is one command:
#     git worktree list --porcelain | awk '/^worktree /{print $2}' \
#       | grep '/.claude/worktrees/' \
#       | while read -r w; do git worktree unlock "$w" 2>/dev/null; \
#                             git worktree remove --force "$w"; done
#     git worktree prune
#
# ⚠ Locks can be STALE: the 19 were locked by "claude agent … (pid 26783)",
# a process that no longer existed. Check the pid is dead before unlocking —
# a LIVE agent's worktree must be left alone.
#
# Warn, do not fail: a couple of live agent worktrees is normal operation.
worktrees_bounded() {
  local n sz
  n=$(git worktree list 2>/dev/null | grep -c "/.claude/worktrees/" || true)
  sz=$(du -sm .claude/worktrees 2>/dev/null | awk '{print $1}'); sz=${sz:-0}
  echo "agent worktrees: $n  (.claude/worktrees = ${sz} MB)"
  if [ "$sz" -gt 20000 ]; then
    echo "  ⚠ over 20 GB of agent worktrees — prune the ones whose owner pid is dead (see comment above)"
  fi
  [ "$n" -le 12 ]
}
gate "agent worktrees not accumulating" worktrees_bounded

# --- static correctness -------------------------------------------------------
gate "SAB cell-collision audit"            python3 tools/sab_cell_audit.py
gate "leaf-inline corpus"                  bash gamecube/bementalJIT/tests/run_leaf_inline_test.sh
gate "leaf-inline mutation matrix"         bash gamecube/bementalJIT/tests/run_leaf_inline_mutants.sh
gate "n64 emitter unit corpus"             node tools/n64_emit_unit_test.mjs
gate "seqlock smoke"                       node gamecube/seqlock.test.mjs
gate "ringbuffer smoke"                    node gamecube/ringbuffer.test.mjs

# --- deploy surface -----------------------------------------------------------
# An rsync --exclude without a leading slash matches ANY path component, which
# stripped n64/bementalJIT once and produced a production 404 that read as an
# emulator bug.
gate "deploy assets (working tree)"        node tools/verify_deploy_assets.mjs .

# --- everything still parses --------------------------------------------------
parses() {
  local bad=0 f
  for f in $(git ls-files 'tools/*.mjs' 'tools/*.js' 'tools/*.cjs' \
                          'gamecube/tools/*.mjs' 'gamecube/tools/*.js' \
                          'dreamcast/tools/*.js' 'lib/*.js' 2>/dev/null); do
    node --check "$f" >/dev/null 2>&1 || { echo "PARSE FAIL: $f"; bad=1; }
  done
  return $bad
}
gate "all harnesses/libs parse"            parses

echo "======================================================================="
if [ "$FAIL" -eq 0 ]; then
  echo "  ALL $PASS GATES PASS"
else
  echo "  $PASS passed, $FAIL FAILED: ${FAILED[*]}"
fi
exit "$FAIL"

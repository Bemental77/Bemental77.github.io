#!/bin/bash
# dreamcast/tools/verify_core_tree.sh — the DRIFT GATE for dreamcast/flycast-src.
#
# WHY THIS EXISTS
# ---------------
# 2026-09-07: eight files under dreamcast/flycast-src/ silently REVERTED to
# their pristine upstream-Flycast state. The whole tree is gitignored
# (.gitignore:59), so nothing recorded the loss and no commit bisect could ever
# have found it — the broken tree was not in git. The shipped .wasm predated the
# drift, so the damage stayed invisible until someone relinked; every relink
# after that produced a worker that died at boot with a bare `CppException`.
# Two of the lost edits were load-bearing (`config::ThreadedRendering.override(false)`
# in core/emulator.cpp; the wasm guard on the read-only const-fold in
# core/hw/sh4/dyna/ssa.cpp) and one silently compiled out the ENTIRE ARM7
# dynarec (`FEAT_AREC DYNAREC_JIT` in core/build.h).
# Write-up: dreamcast/docs/core-relink-broken/TASKS.md
#
# THE TWO-PART FIX
# ----------------
#   1. The ported files are now TRACKED IN PLACE by the outer repo, through a
#      `!`-negation block in .gitignore. A reversion is now a visible
#      `git diff` / `git status` entry, and `--restore` puts it back.
#   2. This script is the ACTIVE half: it runs from build_and_probe.sh and from
#      flycast_worker_link.sh, so a drifted tree CANNOT silently produce a binary.
#
# WHY NOT `patch --dry-run` AGAINST dreamcast/flycast-bridge/patches/
# -------------------------------------------------------------------
# It LIED IN BOTH DIRECTIONS on this exact tree. BSD `patch` skips already-applied
# hunks and still exits 0, and fuzzy matching applied a `FEAT_AREC` hunk against
# the wrong one of build.h's four identical `#define FEAT_AREC DYNAREC_NONE`
# lines. Worse, the patch series is INCOMPLETE: 33 files differ from upstream and
# the numbered patches only cover 23 of them, so 10 ported files had no patch at
# all and a patch-based check could never have noticed them reverting.
# This script compares BLOB HASHES against the upstream commit the nested
# flycast checkout is sitting on. No fuzz, no ordering, no line matching.
#
# CHECKS
#   C1 REVERTED  — a tracked ported file is byte-identical to upstream => the
#                  port edit is GONE. This is the incident's exact signature. FAIL.
#   C2 MISSING   — a tracked ported file is not on disk. FAIL.
#   C3 UNRECORDED— a file differs from upstream but the outer repo does NOT track
#                  it => it is the next silent-reversion victim. FAIL.
#   C4 UNCOMMITTED (informational) — a tracked ported file differs from the outer
#                  repo's HEAD. Legitimate in-progress work looks like this, so it
#                  is REPORTED, never failed on.
#
# USAGE
#   verify_core_tree.sh                 audit; exit 1 on C1/C2/C3
#   verify_core_tree.sh --list          print the tracked port set
#   verify_core_tree.sh --restore       git checkout HEAD -- <the tracked set>
#                                       (recovers a reverted file from the outer repo)
#   verify_core_tree.sh --sync-gitignore
#                                       regenerate .gitignore's managed block from
#                                       the live drift set (run after ADDING a new
#                                       ported file, then `git add` + commit it)
#
#   DC_CORE_AUDIT=off  makes the build-time callers print a loud banner and skip.
#                      Use --sync-gitignore instead; `off` is not a fix.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # repo root, derived — no hardcode
SRC=$ROOT/dreamcast/flycast-src
REL=dreamcast/flycast-src
GITIGNORE=$ROOT/.gitignore
BEGIN_MARK='# >>> flycast-src ported files — managed by dreamcast/tools/verify_core_tree.sh (do not hand-edit) >>>'
END_MARK='# <<< flycast-src ported files — managed block ends <<<'

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n'  "$*"; }

if [ ! -d "$SRC" ]; then
  red "verify_core_tree: FATAL — $SRC does not exist."
  exit 1
fi

# ---------------------------------------------------------------------------
# owner_repo <path-relative-to-flycast-src>  ->  prints "<repo abs dir>|<rel path in that repo>"
# Nearest enclosing directory containing a .git (dir OR gitfile). This is what
# lets the check reach INTO submodules — core/deps/DreamPicoPort-API is one, and
# it carries a ported one-line #include that would otherwise be unguarded.
# ---------------------------------------------------------------------------
owner_repo() {
  local rel=$1 dir="$SRC/$(dirname "$rel")" base
  while [ "$dir" != "/" ]; do
    if [ -e "$dir/.git" ]; then
      base=${SRC}/${rel}
      printf '%s|%s\n' "$dir" "${base#"$dir"/}"
      return 0
    fi
    dir=$(dirname "$dir")
  done
  return 1
}

# ---------------------------------------------------------------------------
# drift_set — every path under flycast-src that differs from its upstream commit,
# including inside submodules. This is the AUTHORITATIVE "what this project
# ported" list; it does not depend on the patch series being complete.
# ---------------------------------------------------------------------------
# _drift_in <repo abs dir> <path prefix>  — recurse; a porcelain row whose path
# is a DIRECTORY is a dirty submodule, so descend into it. (`git submodule
# status --recursive` does NOT reliably carry the -dirty suffix here — verified
# 2026-09-07: it printed 0 dirty rows while `git status --porcelain` reported
# ` M core/deps/DreamPicoPort-API`. Porcelain is the signal that works.)
_drift_in() {
  local repo=$1 pre=$2
  [ -e "$repo/.git" ] || return 0
  git -C "$repo" status --porcelain --untracked-files=no 2>/dev/null \
    | awk '{ if ($1 ~ /^(M|A|MM|AM)$/) print $2 }' \
    | while IFS= read -r p; do
        [ -n "$p" ] || continue
        if [ -d "$repo/$p" ]; then
          _drift_in "$repo/$p" "$pre$p/"
        else
          echo "$pre$p"
        fi
      done
}

drift_set() { _drift_in "$SRC" ""; }

# tracked_set — what the OUTER repo currently tracks under flycast-src.
tracked_set() {
  git -C "$ROOT" ls-files "$REL" | sed "s|^$REL/||"
}

# ---------------------------------------------------------------------------
case "${1:-audit}" in
--list)
  tracked_set
  exit 0
  ;;
--restore)
  bold "verify_core_tree: restoring the tracked flycast-src port set from outer HEAD"
  git -C "$ROOT" checkout HEAD -- "$REL" || exit 1
  echo "restored $(tracked_set | wc -l | tr -d ' ') files. Re-run the audit."
  exit 0
  ;;
--sync-gitignore)
  tmp=$(mktemp)
  {
    echo "$BEGIN_MARK"
    echo "# Regenerate with: bash dreamcast/tools/verify_core_tree.sh --sync-gitignore"
    echo "# upstream-base: $(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "# Every path below differs from upstream flycast and MUST stay in git —"
    echo "# see dreamcast/docs/core-relink-broken/TASKS.md for what happens when one doesn't."
    drift_set | sort -u | while read -r p; do echo "!$REL/$p"; done
    echo "$END_MARK"
  } > "$tmp"
  if grep -qF "$BEGIN_MARK" "$GITIGNORE"; then
    awk -v b="$BEGIN_MARK" -v e="$END_MARK" -v f="$tmp" '
      $0==b { while ((getline l < f) > 0) print l; skip=1; next }
      $0==e { skip=0; next }
      !skip { print }
    ' "$GITIGNORE" > "$GITIGNORE.new" && mv "$GITIGNORE.new" "$GITIGNORE"
  else
    red "verify_core_tree: no managed block in $GITIGNORE — add the markers first."
    rm -f "$tmp"; exit 1
  fi
  rm -f "$tmp"
  bold "verify_core_tree: .gitignore managed block regenerated ($(drift_set | sort -u | wc -l | tr -d ' ') paths)."
  echo "Now:  git add $REL   &&   git commit -- .gitignore $REL"
  exit 0
  ;;
audit) ;;
*)
  red "verify_core_tree: unknown option '$1'"; exit 2 ;;
esac

# ---------------------------------------------------------------------------
# AUDIT
# (bash 3.2 — macOS ships 3.2.57, no `mapfile`. Newline-delimited strings only.)
# ---------------------------------------------------------------------------
fail=0
REVERTED=""; MISSING=""; UNRECORDED=""; UNCOMMITTED=""
n_rev=0; n_mis=0; n_unrec=0; n_uncom=0

TRACKED=$(tracked_set)
n_tracked=$(printf '%s' "$TRACKED" | grep -c . || true)

if [ "$n_tracked" -eq 0 ]; then
  red "════════════════════════════════════════════════════════════════════════"
  red " verify_core_tree: FAIL — the outer repo tracks ZERO files under $REL."
  red " The .gitignore negation block is gone. Every ported core edit is again"
  red " invisible to git; this is the exact state that broke the core on"
  red " 2026-09-07 (dreamcast/docs/core-relink-broken/TASKS.md)."
  red "════════════════════════════════════════════════════════════════════════"
  exit 1
fi

while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  f=$SRC/$rel
  if [ ! -f "$f" ]; then MISSING="$MISSING$rel
"; n_mis=$((n_mis+1)); fail=1; continue; fi
  # C1: byte-identical to upstream => the port edit was reverted.
  own=$(owner_repo "$rel") || own=""
  if [ -n "$own" ]; then
    repo=${own%%|*}; rp=${own#*|}
    up=$(git -C "$repo" rev-parse "HEAD:$rp" 2>/dev/null || true)
    if [ -n "$up" ]; then
      live=$(git -C "$repo" hash-object "$f" 2>/dev/null || true)
      if [ -n "$live" ] && [ "$live" = "$up" ]; then
        REVERTED="$REVERTED$rel
"; n_rev=$((n_rev+1)); fail=1
      fi
    fi
  fi
done <<EOF
$TRACKED
EOF

# C4: tracked-but-differs-from-outer-HEAD (informational — in-progress work).
UNCOMMITTED=$(git -C "$ROOT" diff --name-only HEAD -- "$REL" 2>/dev/null | sed "s|^$REL/||")
n_uncom=$(printf '%s' "$UNCOMMITTED" | grep -c . || true)

# C3: differs from upstream but the outer repo does not track it.
if [ -e "$SRC/.git" ]; then
  DRIFT=$(drift_set | sort -u)
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if ! printf '%s\n' "$TRACKED" | grep -qxF "$p"; then
      UNRECORDED="$UNRECORDED$p
"; n_unrec=$((n_unrec+1)); fail=1
    fi
  done <<EOF
$DRIFT
EOF
else
  echo "verify_core_tree: NOTE — $SRC has no .git; C1/C3 (upstream comparison) are DEGRADED."
fi

echo "verify_core_tree: $n_tracked tracked ported files under $REL"

# C5: the upstream BASE must not have moved. C1 asks "is this file identical to
# upstream?" — if someone `git pull`s flycast inside the nested checkout, that
# question silently starts meaning something else, and a file could read as
# still-ported while actually being upstream's newer version of itself.
if [ -e "$SRC/.git" ]; then
  base_live=$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown)
  base_rec=$(sed -n 's/^# upstream-base: //p' "$GITIGNORE" | head -1)
  if [ -n "$base_rec" ] && [ "$base_rec" != "$base_live" ]; then
    red ""
    red " UPSTREAM BASE MOVED — recorded $base_rec, checkout is at $base_live."
    red " Every C1 verdict above compares against the NEW upstream, so 'still"
    red " ported' no longer means what it did. Re-verify the port set against"
    red " the new base, then: bash dreamcast/tools/verify_core_tree.sh --sync-gitignore"
    fail=1
  else
    echo "verify_core_tree: upstream base ${base_live} (recorded: ${base_rec:-none})"
  fi
fi

if [ "$n_uncom" -gt 0 ]; then
  echo "verify_core_tree: $n_uncom tracked file(s) differ from outer HEAD (in-progress work, not an error):"
  printf '%s\n' "$UNCOMMITTED" | sed '/^$/d; s|^|                  |'
fi

if [ "$fail" -eq 0 ]; then
  echo "verify_core_tree: PASS — every tracked port edit is still applied, and every"
  echo "                  upstream difference is recorded in git."
  exit 0
fi

red "════════════════════════════════════════════════════════════════════════════"
red " verify_core_tree: FAIL — dreamcast/flycast-src HAS DRIFTED."
red "════════════════════════════════════════════════════════════════════════════"
if [ "$n_rev" -gt 0 ]; then
  red ""
  red " REVERTED TO UPSTREAM ($n_rev) — the port edit in these files is GONE."
  red " They are byte-identical to pristine Flycast. Building now reproduces the"
  red " 2026-09-07 boot failure (bare CppException at sh4_pc=0x8c379a42)."
  printf '%s\n' "$REVERTED" | sed '/^$/d' | while IFS= read -r r; do red "   $r"; done
  red ""
  red "   RECOVER:  bash dreamcast/tools/verify_core_tree.sh --restore"
  red "   INSPECT:  git diff -- $REL"
fi
if [ "$n_mis" -gt 0 ]; then
  red ""
  red " MISSING FROM DISK ($n_mis):"
  printf '%s\n' "$MISSING" | sed '/^$/d' | while IFS= read -r r; do red "   $r"; done
  red "   RECOVER:  bash dreamcast/tools/verify_core_tree.sh --restore"
fi
if [ "$n_unrec" -gt 0 ]; then
  red ""
  red " UNRECORDED PORT EDITS ($n_unrec) — these differ from upstream flycast but"
  red " the repo does NOT track them, so nothing would notice if they reverted."
  printf '%s\n' "$UNRECORDED" | sed '/^$/d' | while IFS= read -r r; do red "   $r"; done
  red ""
  red "   FIX:  bash dreamcast/tools/verify_core_tree.sh --sync-gitignore"
  red "         git add $REL && git commit -- .gitignore $REL"
fi
red ""
red " Build/link is REFUSING to run against this tree."
red " Background: dreamcast/docs/core-relink-broken/TASKS.md"
red "════════════════════════════════════════════════════════════════════════════"
exit 1

#!/usr/bin/env bash
# gamecube/native/tools/wb_mutant_gate.sh — does the rollback self-test catch a broken write barrier?
# Links mutant rollback builds (wb/inline_hooks.py) from the current objects and runs each under RBTEST along
# the party route; every arm must be CAUGHT (a full-audit mismatch, an inexact restore or a rerun mismatch).
#   WB_MUTANT=2, phases 10 25 40: 1 store site in 50 has no check (which 50th: the phase)
#   WB_MUTANT_FN=HuDecodeData: every store check in one function dropped (a page's only writer)
# A run whose page hangs (a corrupted rerun can) is judged by the self-test's last report before the hang
# (mp4n_probe.mjs prints RBSNAP from the page after every change).
#
# NOT IN THE GATE, and why (measured on the party route with the cover attribution below; a property of this
# route, not a proof that those checks are unneeded):
#   phase 0: its executed dropped sites (170 of 2,114, 33.4M stores: GX setter shadow registers, FaceDraw
#     statics, a __memset tail) write pages other checked stores log in the same frames.
#   fn GXSetBlendMode, fn GXSetTevColorIn: every page they wrote (one a frame, ~8,350 page-frames) was logged in
#     the same frame by GXSetViewportJitter's store into the same __GXData page; 0 pages without another writer.
#   fn FaceDraw: 2,035,558 page-frames logged by other sites (SDL_main's inlined code 1.02M, Hu3DDraw 1.01M);
#     382 page-frames on one HuMem heap page (0x47e5000) had no other logger in their frame.
#   fn EnvelopeProc: 276,138 page-frames logged by others (235,915 by bulk copies: C_MTXROMultVecArray's
#     memcpy of the transformed vertices); 72,203 page-frames on 9 HuMem heap pages (0x4501000 ... 0x4d42000)
#     had no other logger in their frame.
#   For the FaceDraw and EnvelopeProc pages without another logger the self-test reported nothing: either the
#   bytes did not change in those frames, or the page was logged later, before an audit or a rewind looked at it
#   (not verified which). They are the gate's known blind spot.
# COVER ATTRIBUTION (how those numbers were made): link with WB_ATTR=1 WB_CENSUS=1 WB_CENSUS_OUT=map
# WB_MUTANT_FN=<fn>, then in the page set census slot (1<<18)-2 to 1 (and -1 to 0x3FFF0); rollback.c counts,
# per covering site, the target's pages that another site logged in the same frame (slot -6 -> u32[1<<18]),
# the ones nothing logged (slot -7) and the first 16 of those pages (slots -13..-28, +1).
# Usage (from the repo root, `npm run web` serving, nothing else probing):
#   bash gamecube/native/tools/wb_mutant_gate.sh [ROUTEOVL hex, default 95b3b5c: omcurovl in the link map]
# Leaves dist/rb/ as it found it. Exit 0 only if every arm was caught.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"; cd "$ROOT"
OV="${1:-95b3b5c}"
T="$(mktemp -d "${TMPDIR:-/tmp}/wbgate.XXXXXX")"; trap 'cp "$T/keep/"* gamecube/native/dist/rb/ 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/keep"; cp gamecube/native/dist/rb/mp4native.* "$T/keep/"
fail=0
arm() {   # name, env assignment
  ( cd gamecube/native && env $2 JSPI=0 OUT="$T/out" STAGE=link bash build.sh > "$T/build.log" 2>&1 ) || { echo "$1: BUILD FAILED"; fail=1; return; }
  grep -o "MUTANT2: [0-9]* sites unchecked\|WB_MUTANT_FN: [0-9]* sites unchecked" "$T/build.log" | sed "s/^/  $1 /"
  cp "$T/out/rb/mp4native."* gamecube/native/dist/rb/; rm -rf "$T/out"
  node tools/browser_leak_guard.js reap > /dev/null
  RBTEST=600,97,7 ROUTE=gamecube/native/tools/route_party_minigames.json ROUTEOVL="$OV" NSHOT=1 timeout 400 \
    bash tools/probe_lock.sh run -- node gamecube/native/tools/mp4n_probe.mjs 150 "$T/shot.png" "rb=1&nosave=1&epoch=820000000" > "$T/run.log" 2>&1
  local r; r=$(grep '^RBTEST ' "$T/run.log" | grep -o '"fullMismatch":[0-9]*\|"restoreInexact":[0-9]*\|"mismatches":[0-9]*' | tr '\n' ' ')
  if [ -z "$r" ]; then   # the page hung (a corrupted rerun): what the self-test had caught by its last snapshot
    r=$(grep 'RBSNAP {' "$T/run.log" | tail -1 | grep -o '"fullMismatch":[0-9]*\|"restoreInexact":[0-9]*\|"mismatches":[0-9]*' | tr '\n' ' ')
    [ -n "$r" ] && r="$r(last snapshot before the page hung)"
  fi
  if [ -z "$r" ]; then echo "$1: NO REPORT (the run did not finish)"; fail=1
  elif echo "$r" | grep -q '"fullMismatch":0 "restoreInexact":0 "mismatches":0'; then echo "$1: NOT CAUGHT $r"; fail=1
  else echo "$1: caught $r"; fi
}
for ph in 10 25 40; do arm "phase $ph" "WB_MUTANT=2 WB_MUTANT_PHASE=$ph"; done
arm "fn HuDecodeData" 'WB_MUTANT_FN=^\$HuDecodeData$'
[ $fail = 0 ] && echo "MUTANT GATE: PASS" || echo "MUTANT GATE: FAIL"
exit $fail

#!/bin/bash
# usage: msab.sh <tag> '<CFG json>'  — gated mode-select capture with JS-level pipeline overrides
S=/tmp/claude-0/-home-user-Bemental77-github-io/5387713e-08a3-5d8a-ae4f-0ca909b47e71/scratchpad
sed -i "s|  const CFG = .*// @@CFG@@|  const CFG = $2; // @@CFG@@|" /tmp/gc-root/gcgate.js
grep "@@CFG@@" /tmp/gc-root/gcgate.js
TMO=2400 bash $S/snaprun.sh $1 GATE_AT=${GATE_AT:-125} GATE_K=2 NDUMPS=3 PLAN="${PLAN:-55:Enter,57:Enter,77:KeyX,92:KeyX,107:KeyX,126:settle:ms}"
grep "rt dumps\|pageerrors\|stripped\|UNCAPT" /tmp/gcsnap-$1.log | head -5 | cut -c1-200

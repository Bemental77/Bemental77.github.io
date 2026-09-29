#!/bin/bash
# usage: snaprun.sh <tag> [ENV=val ...]  — locked, hash-guarded gcsnap run against /tmp/gc-root
S=/tmp/claude-0/-home-user-Bemental77-github-io/5387713e-08a3-5d8a-ae4f-0ca909b47e71/scratchpad
CH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
T=$1; shift
until mkdir /tmp/bemental-probe.lock 2>/dev/null; do sleep 5; done
trap 'pkill -9 -f "^$CH" 2>/dev/null; rmdir /tmp/bemental-probe.lock' EXIT
W=/tmp/gc-root/gamecube/dolphin_libretro/dolphin_worker_emcc
echo "== $T wasm-before=$(md5sum $W.wasm | cut -c1-32) js=$(md5sum $W.js | cut -c1-32) $(uptime)"
env ROOT=/tmp/gc-root TAG=$T "$@" timeout ${TMO:-400} node $S/gcsnap.mjs > /tmp/gcsnap-$T.log 2>&1
echo "exit $? wasm-after=$(md5sum $W.wasm | cut -c1-32) js=$(md5sum $W.js | cut -c1-32) $(uptime)"

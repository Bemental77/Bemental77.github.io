#!/bin/bash
# Native Dolphin (SAB + GDB stub :9090) → capture PI/SI MMIO access sequence via
# Z2/Z3 watchpoints (gdb_si_watch.py). Output → /tmp/native-si-watch.log.
set -u
DOLPHIN=/Applications/Dolphin.app/Contents/MacOS/Dolphin
ISO="/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso"
PORT=9090
NHITS=${1:-300}

EXISTING=$(lsof -ti :$PORT 2>/dev/null || true)
[ -n "$EXISTING" ] && kill $EXISTING 2>/dev/null && sleep 1

"$DOLPHIN" -d -C Dolphin.General.GDBPort=$PORT -C Dolphin.Core.CPUCore=1 -e "$ISO" \
    > /tmp/dolphin_native_siwatch.log 2>&1 &
DP=$!
echo "[native-si-watch] launched Dolphin pid=$DP, waiting for stub on :$PORT..."
for i in $(seq 1 40); do
    lsof -i :$PORT 2>/dev/null | grep -q LISTEN && { echo "[native-si-watch] stub up"; break; }
    sleep 0.5
done
if ! lsof -i :$PORT 2>/dev/null | grep -q LISTEN; then
    echo "[native-si-watch] ERROR: stub never bound"; tail -20 /tmp/dolphin_native_siwatch.log
    kill $DP 2>/dev/null || true; exit 1
fi

python3 /Users/caseybement/Bemental77.github.io/gamecube/tools/gdb_si_watch.py "$NHITS" 2>&1 | tee /tmp/native-si-watch.log

kill $DP 2>/dev/null || true; wait $DP 2>/dev/null || true
echo "[native-si-watch] done; sequence at /tmp/native-si-watch.log"

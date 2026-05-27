#!/bin/bash
# Launch native Dolphin headless with SAB + GDB stub on :9090, single-step the
# OSInit/OSExceptionInit first pass (fn 0x800e362c) to capture the GROUND-TRUTH
# native control flow, then kill Dolphin. The `-C` overrides don't touch saved
# Dolphin.ini. Output → /tmp/native-osexc-362c.log (diff target vs our wasm).
set -u
DOLPHIN=/Applications/Dolphin.app/Contents/MacOS/Dolphin
ISO="/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso"
PORT=9090
NSTEPS=${1:-140}

EXISTING=$(lsof -ti :$PORT 2>/dev/null || true)
[ -n "$EXISTING" ] && kill $EXISTING 2>/dev/null && sleep 1

"$DOLPHIN" -d \
    -C Dolphin.General.GDBPort=$PORT \
    -C Dolphin.Core.CPUCore=1 \
    -e "$ISO" \
    > /tmp/dolphin_native_sab.log 2>&1 &
DOLPHIN_PID=$!
echo "[native-osexc] launched Dolphin pid=$DOLPHIN_PID, waiting for GDB stub on :$PORT..."

for i in $(seq 1 40); do
    if lsof -i :$PORT 2>/dev/null | grep -q LISTEN; then echo "[native-osexc] stub up after ${i}*0.5s"; break; fi
    sleep 0.5
done
if ! lsof -i :$PORT 2>/dev/null | grep -q LISTEN; then
    echo "[native-osexc] ERROR: stub never bound. dolphin log tail:"; tail -20 /tmp/dolphin_native_sab.log
    kill $DOLPHIN_PID 2>/dev/null || true; exit 1
fi

python3 /Users/caseybement/Bemental77.github.io/gamecube/tools/gdb_osexc_step.py "$NSTEPS" 2>&1 | tee /tmp/native-osexc-362c.log

kill $DOLPHIN_PID 2>/dev/null || true
wait $DOLPHIN_PID 2>/dev/null || true
echo "[native-osexc] done; trajectory at /tmp/native-osexc-362c.log"

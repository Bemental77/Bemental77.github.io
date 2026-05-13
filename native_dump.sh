#!/bin/bash
# Launch native Dolphin headless with PSO + GDB stub on :9090, dump state at
# 0x800e52f4..0x800e5320, then kill Dolphin. Output to stdout (also tee to
# /tmp/native_dump.txt for diffing against our build's probe).
set -e

DOLPHIN=/Applications/Dolphin.app/Contents/MacOS/Dolphin
PSO=/Users/caseybement/Downloads/Phantasy\ Star\ Online\ Episode\ I\ \&\ II\ Plus\ \(USA\).iso
PORT=9090

# Kill any prior Dolphin instance on this port
EXISTING=$(lsof -ti :$PORT 2>/dev/null || true)
[ -n "$EXISTING" ] && kill $EXISTING 2>/dev/null && sleep 1

# Launch Dolphin paused (debugger), GDB-ready. Force JIT64 (= "JIT86x" in
# older Dolphin naming) so we benchmark/compare against production-speed
# native execution. Persistent Dolphin.ini may have CPUCore=0 (Interpreter);
# this CLI override doesn't touch the saved config.
"$DOLPHIN" \
    -d \
    -C Dolphin.General.GDBPort=$PORT \
    -C Dolphin.Core.CPUCore=1 \
    -e "$PSO" \
    > /tmp/dolphin_native.log 2>&1 &
DOLPHIN_PID=$!

echo "[native_dump] launched Dolphin pid=$DOLPHIN_PID, waiting for GDB stub on :$PORT..."

# Wait up to 15s for the stub to bind
for i in $(seq 1 30); do
    if lsof -i :$PORT 2>/dev/null | grep -q LISTEN; then
        echo "[native_dump] GDB stub up after ${i}*0.5s"
        break
    fi
    sleep 0.5
done

if ! lsof -i :$PORT 2>/dev/null | grep -q LISTEN; then
    echo "[native_dump] ERROR: GDB stub never bound. Tail of dolphin log:"
    tail -20 /tmp/dolphin_native.log
    kill $DOLPHIN_PID 2>/dev/null || true
    exit 1
fi

# Run the dump client
python3 /Users/caseybement/Bemental77.github.io/native_dump.py $PORT 2>&1 | tee /tmp/native_dump.txt

# Cleanup
kill $DOLPHIN_PID 2>/dev/null || true
wait $DOLPHIN_PID 2>/dev/null || true
echo "[native_dump] done; output at /tmp/native_dump.txt"

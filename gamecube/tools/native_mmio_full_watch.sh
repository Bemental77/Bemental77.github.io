#!/bin/bash
# Comprehensive native-Dolphin MMIO trajectory capture.
# Launches a SEPARATE Dolphin instance (using port 9091, NOT the user's session)
# and records every Z2/Z3 watchpoint hit across PI/SI/DI/AI/EXI/MI/VI/PE/GP/CP/DSP.
#
# Output  : /tmp/native-mmio-full-watch.log  (sequence)
# Side log: /tmp/dolphin_native_mmio_full_watch.log  (Dolphin stderr)
# PID file: /tmp/dolphin-agent-C-pid.txt          (so caller can kill only this Dolphin)
set -u
DOLPHIN=/Applications/Dolphin.app/Contents/MacOS/Dolphin
ISO="/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso"
PORT=9091
NHITS=${1:-5000}
PIDFILE=/tmp/dolphin-agent-C-pid.txt
SIDE_LOG=/tmp/dolphin_native_mmio_full_watch.log
OUT_LOG=/tmp/native-mmio-full-watch.log

# Refuse to run if our port is already bound by something else.
EXISTING=$(lsof -ti :$PORT 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
    echo "[native-mmio-full-watch] WARN port $PORT in use by pid(s) $EXISTING — killing only those"
    kill $EXISTING 2>/dev/null && sleep 1
fi

# Launch our own Dolphin — record its PID so we don't kill the user's interactive one.
"$DOLPHIN" -d -C Dolphin.General.GDBPort=$PORT -C Dolphin.Core.CPUCore=1 -e "$ISO" \
    > "$SIDE_LOG" 2>&1 &
DP=$!
echo "$DP" > "$PIDFILE"
echo "[native-mmio-full-watch] launched Dolphin pid=$DP on port :$PORT — PID saved to $PIDFILE"

for i in $(seq 1 40); do
    lsof -i :$PORT 2>/dev/null | grep -q LISTEN && { echo "[native-mmio-full-watch] stub up"; break; }
    sleep 0.5
done
if ! lsof -i :$PORT 2>/dev/null | grep -q LISTEN; then
    echo "[native-mmio-full-watch] ERROR: stub never bound on :$PORT"
    tail -30 "$SIDE_LOG"
    kill $DP 2>/dev/null || true
    rm -f "$PIDFILE"
    exit 1
fi

PYTHONUNBUFFERED=1 python3 -u \
    /Users/caseybement/Bemental77.github.io/gamecube/tools/gdb_mmio_full_watch.py "$NHITS" \
    2>&1 | tee "$OUT_LOG"

# Kill ONLY the Dolphin we launched, by saved PID.
if [ -f "$PIDFILE" ]; then
    SAVED_PID=$(cat "$PIDFILE")
    if [ -n "$SAVED_PID" ] && kill -0 "$SAVED_PID" 2>/dev/null; then
        echo "[native-mmio-full-watch] killing our Dolphin pid=$SAVED_PID"
        kill -9 "$SAVED_PID" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
fi
echo "[native-mmio-full-watch] done; sequence at $OUT_LOG"

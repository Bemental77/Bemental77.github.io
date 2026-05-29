#!/bin/bash
# Row 2 checkpoint extension #1: SITransfer entry (PC=0x800eb058), 200 samples.
# Designed to run against an ALREADY-LIVE Dolphin (port 9092). If no Dolphin
# is up, launches one in isolated user-dir /tmp/dolphin-agent-B3 and tears it
# down at script exit. If Dolphin is already on :9092 (e.g. orchestrator
# launched it), reuses it and does NOT kill.
set -u
DOLPHIN=/Applications/Dolphin.app/Contents/MacOS/Dolphin
ISO="/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso"
PORT=${PORT:-9092}
USERDIR=${USERDIR:-/tmp/dolphin-agent-B3}
ENTRY=${1:-800eb058}
NSTEPS=${2:-200}

OWNS_DOLPHIN=0
if ! lsof -i :$PORT 2>/dev/null | grep -q LISTEN; then
    "$DOLPHIN" -d -u "$USERDIR" \
        -C Dolphin.General.GDBPort=$PORT -C Dolphin.Core.CPUCore=1 \
        -e "$ISO" > /tmp/dolphin_native_sitransfer.log 2>&1 &
    DOLPHIN_PID=$!
    OWNS_DOLPHIN=1
    echo "[native-sitransfer] launched Dolphin pid=$DOLPHIN_PID, waiting for stub on :$PORT..."
    for i in $(seq 1 40); do
        lsof -i :$PORT 2>/dev/null | grep -q LISTEN && { echo "[native-sitransfer] stub up"; break; }
        sleep 0.5
    done
    if ! lsof -i :$PORT 2>/dev/null | grep -q LISTEN; then
        echo "[native-sitransfer] ERROR: stub never bound"; tail -20 /tmp/dolphin_native_sitransfer.log
        kill -9 $DOLPHIN_PID 2>/dev/null || true; exit 1
    fi
else
    echo "[native-sitransfer] reusing existing Dolphin on :$PORT"
fi

python3 /Users/caseybement/Bemental77.github.io/gamecube/tools/gdb_sitransfer_step.py \
    "$ENTRY" "$NSTEPS" "$PORT" 2>&1 | tee /tmp/native-sitransfer-step.log
RC=$?

if [ "$OWNS_DOLPHIN" = "1" ]; then
    kill -9 $DOLPHIN_PID 2>/dev/null || true
    wait $DOLPHIN_PID 2>/dev/null || true
    echo "[native-sitransfer] torn down Dolphin pid=$DOLPHIN_PID"
fi
echo "[native-sitransfer] done rc=$RC; trace at /tmp/native-sitransfer-step.log"
exit $RC

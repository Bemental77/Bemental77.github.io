#!/bin/bash
# Row 2 checkpoint extension #2: MSR-EE leaf (PC=0x800e78f0), 200 samples.
# Same launch-or-reuse semantics as native_sitransfer_sab.sh.
set -u
DOLPHIN=/Applications/Dolphin.app/Contents/MacOS/Dolphin
ISO="/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso"
PORT=${PORT:-9092}
USERDIR=${USERDIR:-/tmp/dolphin-agent-B3}
ENTRY=${1:-800e78f0}
NSTEPS=${2:-200}

OWNS_DOLPHIN=0
if ! lsof -i :$PORT 2>/dev/null | grep -q LISTEN; then
    "$DOLPHIN" -d -u "$USERDIR" \
        -C Dolphin.General.GDBPort=$PORT -C Dolphin.Core.CPUCore=1 \
        -e "$ISO" > /tmp/dolphin_native_msr_leaf.log 2>&1 &
    DOLPHIN_PID=$!
    OWNS_DOLPHIN=1
    echo "[native-msr_leaf] launched Dolphin pid=$DOLPHIN_PID, waiting for stub on :$PORT..."
    for i in $(seq 1 40); do
        lsof -i :$PORT 2>/dev/null | grep -q LISTEN && { echo "[native-msr_leaf] stub up"; break; }
        sleep 0.5
    done
    if ! lsof -i :$PORT 2>/dev/null | grep -q LISTEN; then
        echo "[native-msr_leaf] ERROR: stub never bound"; tail -20 /tmp/dolphin_native_msr_leaf.log
        kill -9 $DOLPHIN_PID 2>/dev/null || true; exit 1
    fi
else
    echo "[native-msr_leaf] reusing existing Dolphin on :$PORT"
fi

python3 /Users/caseybement/Bemental77.github.io/gamecube/tools/gdb_msr_leaf_step.py \
    "$ENTRY" "$NSTEPS" "$PORT" 2>&1 | tee /tmp/native-msr_leaf-step.log
RC=$?

if [ "$OWNS_DOLPHIN" = "1" ]; then
    kill -9 $DOLPHIN_PID 2>/dev/null || true
    wait $DOLPHIN_PID 2>/dev/null || true
    echo "[native-msr_leaf] torn down Dolphin pid=$DOLPHIN_PID"
fi
echo "[native-msr_leaf] done rc=$RC; trace at /tmp/native-msr_leaf-step.log"
exit $RC

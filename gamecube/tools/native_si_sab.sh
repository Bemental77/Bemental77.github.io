#!/bin/bash
# Launch native Dolphin headless (SAB + GDB stub :9090) and single-step the
# SI/SRAM path (SITransfer) capturing PI INTSR — to diff against our wasm 0x500
# ext-int storm. Output → /tmp/native-si-path.log.
set -u
DOLPHIN=/Applications/Dolphin.app/Contents/MacOS/Dolphin
ISO="/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso"
PORT=9090
ENTRY=${1:-800eb058}   # SITransfer
NSTEPS=${2:-600}

EXISTING=$(lsof -ti :$PORT 2>/dev/null || true)
[ -n "$EXISTING" ] && kill $EXISTING 2>/dev/null && sleep 1

"$DOLPHIN" -d -C Dolphin.General.GDBPort=$PORT -C Dolphin.Core.CPUCore=1 -e "$ISO" \
    > /tmp/dolphin_native_si.log 2>&1 &
DOLPHIN_PID=$!
echo "[native-si] launched Dolphin pid=$DOLPHIN_PID, waiting for stub on :$PORT..."
for i in $(seq 1 40); do
    lsof -i :$PORT 2>/dev/null | grep -q LISTEN && { echo "[native-si] stub up"; break; }
    sleep 0.5
done
if ! lsof -i :$PORT 2>/dev/null | grep -q LISTEN; then
    echo "[native-si] ERROR: stub never bound"; tail -20 /tmp/dolphin_native_si.log
    kill $DOLPHIN_PID 2>/dev/null || true; exit 1
fi

python3 /Users/caseybement/Bemental77.github.io/gamecube/tools/gdb_si_step.py "$ENTRY" "$NSTEPS" 2>&1 | tee /tmp/native-si-path.log

kill $DOLPHIN_PID 2>/dev/null || true
wait $DOLPHIN_PID 2>/dev/null || true
echo "[native-si] done; trace at /tmp/native-si-path.log"

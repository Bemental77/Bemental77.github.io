#!/usr/bin/env bash
# Launch native Dolphin (prebuilt /Applications/Dolphin.app) on the SAB ISO with
# GDB-RSP at port 9091 and isolated user-dir /tmp/dolphin-agent-B2/, then drive
# a comprehensive Z2/Z3 MMIO watchpoint sweep via gdb_mmio_full_watch.py.
#
# Coordination contract (agent-B2):
#   Binary:    /Applications/Dolphin.app/Contents/MacOS/Dolphin   (prebuilt)
#   GDB port:  9091
#   User-dir:  /tmp/dolphin-agent-B2/
#   Output:    /tmp/native-mmio-full-watch.log
#
# Foreground. Tracks YOUR pid; kills only YOUR pid on exit.
set -u

DOLPHIN=/Applications/Dolphin.app/Contents/MacOS/Dolphin
USERDIR=/tmp/dolphin-agent-B2
PORT=9091
ISO="/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso"
NHITS="${1:-5000}"
OUT=/tmp/native-mmio-full-watch.log
SCRIPT=/Users/caseybement/Bemental77.github.io/gamecube/tools/gdb_mmio_full_watch.py

mkdir -p "$USERDIR/Config" "$USERDIR/Logs"

# Refuse if our port is already taken — do NOT kill anyone else's Dolphin.
if lsof -i :$PORT >/dev/null 2>&1; then
  echo "ABORT: port $PORT already occupied" >&2
  exit 2
fi

# Launch Dolphin natively (background — we drive it from this shell).
"$DOLPHIN" \
  --user "$USERDIR" \
  -d \
  -C Dolphin.General.GDBPort=$PORT \
  -C Dolphin.Core.CPUCore=1 \
  -e "$ISO" \
  -b \
  -v Null \
  -a HLE \
  >/tmp/dolphin-agent-B2.stdout.log 2>/tmp/dolphin-agent-B2.stderr.log &
DOLPHIN_PID=$!
echo "agent-B2 dolphin pid=$DOLPHIN_PID port=$PORT userdir=$USERDIR" >&2

cleanup() {
  echo "cleanup: killing pid $DOLPHIN_PID" >&2
  kill -9 "$DOLPHIN_PID" 2>/dev/null
  pkill -9 -P "$DOLPHIN_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

# Wait for GDB server (Dolphin pauses on boot when -d is set).
for i in $(seq 1 60); do
  if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "gdb-stub up after ${i}s" >&2
    break
  fi
  sleep 1
done
if ! lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ABORT: gdb-stub never came up on port $PORT" >&2
  exit 3
fi

# Drive the watch sweep. Foreground; writes both stdout (log lines + histogram)
# and stderr (set/install diagnostics) into the same file.
PYTHONUNBUFFERED=1 python3 "$SCRIPT" "$NHITS" >"$OUT" 2>&1
RC=$?

echo "watch script rc=$RC" >&2
echo "log: $OUT" >&2
wc -l "$OUT" >&2
exit $RC

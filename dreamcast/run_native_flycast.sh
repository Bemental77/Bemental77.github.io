#!/bin/bash
# Launch native Flycast (libretro) with REAL Dreamcast BIOS, verbose log.
#
# Prerequisites (already established by the parent session):
#   - /tmp/flycast-lr2/flycast_libretro.dylib                              (libretro core)
#   - /tmp/pso/PSO.cue + Track{1,2,3}.bin                                  (PSO Ver.2 USA disc)
#   - ~/Documents/RetroArch/saves/Flycast/dc_boot.bin     (= DC - BIOS.bin)
#   - ~/Documents/RetroArch/saves/Flycast/dc_nvmem.bin    (= DC - Flash.bin)
#   - ~/Documents/RetroArch/system/dc/dc_boot.bin         (also)
#   - ~/Documents/RetroArch/system/dc/dc_flash.bin        (also)
#   - ~/Library/Application Support/RetroArch/config/Flycast/Flycast.opt
#       flycast_hle_bios = "disabled"
#       flycast_threaded_rendering = "disabled"
#
# The Flycast libretro core (Apple build) calls set_user_data_dir(SAVE_DIRECTORY)
# in retro_init, so nvmem::loadFiles() looks for `dc_boot.bin` under
# ~/Documents/RetroArch/saves/Flycast/ (NOT the RetroArch system dir).
#
# Usage:
#   dreamcast/run_native_flycast.sh                # 30s run, logs to /tmp/native_realbios.log
#   dreamcast/run_native_flycast.sh 60             # 60s run

LOG=${LOG:-/tmp/native_realbios.log}
SECS=${1:-30}

rm -f "$LOG"

# Launch in background so we can kill after $SECS.
/Applications/RetroArch.app/Contents/MacOS/RetroArch \
  -L /tmp/flycast-lr2/flycast_libretro.dylib \
  /tmp/pso/PSO.cue \
  --verbose --log-file="$LOG" >/tmp/ra_stdout.log 2>&1 &
RA_PID=$!
echo "RetroArch PID=$RA_PID, logging to $LOG, running ${SECS}s"

sleep "$SECS"

# Try graceful then forceful shutdown.
kill -TERM "$RA_PID" 2>/dev/null
sleep 1
kill -KILL "$RA_PID" 2>/dev/null
pkill -9 -f "/Applications/RetroArch.app/Contents/MacOS/RetroArch" 2>/dev/null

echo "---"
echo "Log size: $(wc -l <"$LOG") lines"
echo "---"
echo "Real-BIOS check:"
if grep -q "Did not load BIOS, using reios" "$LOG"; then
    echo "  FAIL: still using Reios. Check Flycast.opt / dc_boot.bin path."
else
    echo "  OK: 'using reios' line absent (real BIOS path)."
fi
echo "---"
echo "Key boot lines:"
grep -E "(N\[BOOT\]|N\[REIOS\]|N\[VMEM\]|N\[FLASHROM\]|N\[INTC\]|N\[HOLLY\]|N\[GDROM\]|N\[AICA\]|N\[RENDERER\]|Loaded.*bootrom|reios|BIOS)" "$LOG" | head -40

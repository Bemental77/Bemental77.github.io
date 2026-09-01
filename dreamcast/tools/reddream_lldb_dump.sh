#!/bin/bash
#
# reddream_lldb_dump.sh
#
# Dump N bytes from a Dreamcast guest address out of a running redream
# process via lldb. If redream is not running, this script launches it
# in the background with /tmp/pso.chd.
#
# Reads `mem_init ram=%p vram=%p aram=%p` from redream's stdout to find
# the host base of the 16 MB system RAM mapping, then translates the
# guest address using the standard SH4 mirror mask (0x00FFFFFF) and
# uses lldb to perform `memory read --binary` into a binary file. The
# binary is then hexdumped to stdout. The redream process is left
# running (detach, do not kill).
#
# Usage:
#   reddream_lldb_dump.sh <guest_addr> [byte_count]
#
# Defaults:
#   byte_count = 64
#
# Examples:
#   reddream_lldb_dump.sh 0x8c008374
#   reddream_lldb_dump.sh 0x8c008374 128
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

REDREAM_BIN="$REPO_DIR/dreamcast/oracle/redream/redream"
PSO_CHD="${PSO_CHD:-/tmp/pso.chd}"
REDREAM_LOG="${REDREAM_LOG:-/tmp/reddream_stdout.log}"
REDREAM_PIDFILE="${REDREAM_PIDFILE:-/tmp/reddream.pid}"
BOOT_WAIT_SEC="${BOOT_WAIT_SEC:-8}"

usage() {
  cat <<'EOF'
Usage: reddream_lldb_dump.sh <guest_addr> [byte_count]

Dump bytes from redream's emulated Dreamcast RAM via lldb.

Positional arguments:
  guest_addr   SH4 guest virtual address (e.g. 0x8c008374)
  byte_count   Number of bytes to read (default: 64)

Environment overrides:
  PSO_CHD            Path to PSO chd to launch with redream (default: /tmp/pso.chd)
  REDREAM_LOG        Path to redream stdout log (default: /tmp/reddream_stdout.log)
  REDREAM_PIDFILE    Path to redream pid file (default: /tmp/reddream.pid)
  BOOT_WAIT_SEC      Seconds to wait for `mem_init ram=...` line (default: 8)

Output:
  Hex dump of the requested bytes to stdout. Raw binary saved to
  /tmp/reddream_dump_<guest_addr>.bin. redream is left running.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 1
fi

GUEST_ADDR_RAW="$1"
BYTE_COUNT="${2:-64}"

# Normalize guest addr to 0x... form for downstream awk/printf.
case "$GUEST_ADDR_RAW" in
  0x*|0X*) GUEST_ADDR="$GUEST_ADDR_RAW" ;;
  *)       GUEST_ADDR="0x$GUEST_ADDR_RAW" ;;
esac

DUMP_FILE="/tmp/reddream_dump_${GUEST_ADDR}.bin"

if [[ ! -x "$REDREAM_BIN" ]]; then
  echo "error: redream binary not found at $REDREAM_BIN" >&2
  exit 2
fi

if ! command -v lldb >/dev/null 2>&1; then
  echo "error: lldb not found in PATH" >&2
  exit 2
fi

# --- 1. Start redream if not already running.
need_start=1
if [[ -f "$REDREAM_PIDFILE" ]]; then
  existing_pid="$(cat "$REDREAM_PIDFILE" 2>/dev/null || true)"
  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    REDREAM_PID="$existing_pid"
    need_start=0
    echo "[reddream_lldb_dump] reusing existing redream pid=$REDREAM_PID" >&2
  fi
fi

if [[ $need_start -eq 1 ]]; then
  if [[ ! -f "$PSO_CHD" ]]; then
    echo "error: PSO chd not found at $PSO_CHD" >&2
    exit 2
  fi
  : > "$REDREAM_LOG"
  echo "[reddream_lldb_dump] launching redream with $PSO_CHD ..." >&2
  "$REDREAM_BIN" "$PSO_CHD" >"$REDREAM_LOG" 2>&1 &
  REDREAM_PID=$!
  echo "$REDREAM_PID" > "$REDREAM_PIDFILE"
  echo "[reddream_lldb_dump] redream pid=$REDREAM_PID, log=$REDREAM_LOG" >&2
fi

# --- 2. Wait for `mem_init ram=...` line in redream stdout.
HOST_BASE=""
waited=0
while [[ $waited -lt $BOOT_WAIT_SEC ]]; do
  if [[ -f "$REDREAM_LOG" ]]; then
    line="$(grep -m1 -E 'mem_init ram=0x[0-9a-fA-F]+' "$REDREAM_LOG" 2>/dev/null || true)"
    if [[ -n "$line" ]]; then
      HOST_BASE="$(echo "$line" | sed -E 's/.*mem_init ram=(0x[0-9a-fA-F]+).*/\1/')"
      break
    fi
  fi
  sleep 1
  waited=$((waited+1))
done

if [[ -z "$HOST_BASE" ]]; then
  echo "error: did not see 'mem_init ram=0x...' in $REDREAM_LOG within ${BOOT_WAIT_SEC}s" >&2
  echo "       tail of log:" >&2
  tail -20 "$REDREAM_LOG" >&2 || true
  exit 3
fi
echo "[reddream_lldb_dump] host ram base = $HOST_BASE" >&2

# --- 3. Translate guest addr -> host addr (mask 0x00FFFFFF, add host base).
HOST_ADDR=$(printf '0x%x\n' $(( (GUEST_ADDR & 0x00FFFFFF) + HOST_BASE )))
echo "[reddream_lldb_dump] guest=$GUEST_ADDR host=$HOST_ADDR count=$BYTE_COUNT" >&2

# --- 4. Use lldb to attach + memory read --binary, then detach.
LLDB_CMDS=$(mktemp -t reddream_lldb_cmds.XXXXXX)
trap 'rm -f "$LLDB_CMDS"' EXIT
cat > "$LLDB_CMDS" <<EOF
process attach --pid $REDREAM_PID
memory read --binary --outfile $DUMP_FILE --count $BYTE_COUNT $HOST_ADDR
process detach
quit
EOF

echo "[reddream_lldb_dump] running lldb ..." >&2
lldb -b -s "$LLDB_CMDS" >/tmp/reddream_lldb_out.log 2>&1 || {
  echo "error: lldb invocation failed; see /tmp/reddream_lldb_out.log" >&2
  tail -40 /tmp/reddream_lldb_out.log >&2 || true
  exit 4
}

if [[ ! -s "$DUMP_FILE" ]]; then
  echo "error: dump file $DUMP_FILE is missing or empty" >&2
  tail -40 /tmp/reddream_lldb_out.log >&2 || true
  exit 5
fi

# --- 5. Hexdump the result to stdout.
echo "[reddream_lldb_dump] dump file: $DUMP_FILE ($(wc -c <"$DUMP_FILE") bytes)" >&2
xxd "$DUMP_FILE"

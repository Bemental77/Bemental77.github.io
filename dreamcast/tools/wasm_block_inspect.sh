#!/bin/bash
# dreamcast/tools/wasm_block_inspect.sh — disassemble per-block WASM dumps.
#
# Companion to Wave 2's FLYCAST_DUMP_BLOCKS=1 path in
# bementalJIT/guests/sh4/rec_wasm.cpp::compile, which writes one .wasm file
# per SH4 block to /tmp/dc-blocks/0x<vaddr>.wasm. This helper runs the wabt
# disassemblers on a chosen block (and optionally diffs two blocks' .wat).
#
# Usage:
#   wasm_block_inspect.sh <vaddr>
#   wasm_block_inspect.sh <vaddr> --diff <vaddr2>
#   wasm_block_inspect.sh --help
#
# Args:
#   <vaddr>        Hex SH4 virtual address, with or without 0x prefix
#                  (e.g. 0x8c008374 or 8c008374). Resolves to
#                  /tmp/dc-blocks/0x<vaddr>.wasm.
#   --diff <addr>  Disassemble both blocks to .wat and `diff -u` them.
#   --dir <path>   Override block-dump directory (default /tmp/dc-blocks).
#
# Requires wabt (provides wasm2wat + wasm-objdump). See setup_wabt.md.
#
# Exits 0 on success, 1 if wabt is missing or the block file does not exist,
# 2 on argument errors.

set -euo pipefail

DUMP_DIR="/tmp/dc-blocks"
VADDR=""
DIFF_VADDR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --diff)
      DIFF_VADDR="${2:-}"
      [ -z "$DIFF_VADDR" ] && { echo "--diff requires an argument" >&2; exit 2; }
      shift 2
      ;;
    --dir)
      DUMP_DIR="${2:-}"
      [ -z "$DUMP_DIR" ] && { echo "--dir requires an argument" >&2; exit 2; }
      shift 2
      ;;
    -h|--help)
      sed -n '2,/^set -euo pipefail/p' "$0" | sed 's/^# \{0,1\}//;/^set -euo pipefail/d'
      exit 0
      ;;
    -*)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
    *)
      if [ -z "$VADDR" ]; then
        VADDR="$1"
      else
        echo "unexpected positional arg: $1" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

if [ -z "$VADDR" ]; then
  echo "missing required <vaddr> argument" >&2
  echo "see --help" >&2
  exit 2
fi

# ---- wabt presence check ----
if ! command -v wasm2wat >/dev/null 2>&1 || ! command -v wasm-objdump >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: wabt not installed (need wasm2wat + wasm-objdump on PATH).

Install on macOS:
  brew install wabt

Install on Debian/Ubuntu:
  sudo apt-get install wabt

See dreamcast/tools/setup_wabt.md for details.
EOF
  exit 1
fi

# ---- normalize vaddr → /tmp/dc-blocks/0x<lower-hex>.wasm ----
normalize_vaddr() {
  local v="$1"
  v="${v#0x}"
  v="${v#0X}"
  # lowercase
  v=$(printf '%s' "$v" | tr 'A-F' 'a-f')
  printf '0x%s' "$v"
}

block_path() {
  local v
  v=$(normalize_vaddr "$1")
  printf '%s/%s.wasm' "$DUMP_DIR" "$v"
}

PATH_A=$(block_path "$VADDR")
if [ ! -f "$PATH_A" ]; then
  echo "error: block file not found: $PATH_A" >&2
  echo "hint: re-run probe with FLYCAST_DUMP_BLOCKS=1 to populate $DUMP_DIR" >&2
  exit 1
fi

if [ -n "$DIFF_VADDR" ]; then
  PATH_B=$(block_path "$DIFF_VADDR")
  if [ ! -f "$PATH_B" ]; then
    echo "error: block file not found: $PATH_B" >&2
    exit 1
  fi
  TMP_A=$(mktemp -t wasm_block_a.XXXXXX.wat)
  TMP_B=$(mktemp -t wasm_block_b.XXXXXX.wat)
  trap 'rm -f "$TMP_A" "$TMP_B"' EXIT
  wasm2wat "$PATH_A" -o "$TMP_A"
  wasm2wat "$PATH_B" -o "$TMP_B"
  echo "=== diff $(basename "$PATH_A") -> $(basename "$PATH_B") ==="
  # `diff -u` returns 1 when files differ; don't let set -e abort on that.
  diff -u "$TMP_A" "$TMP_B" || true
  exit 0
fi

echo "=== wasm2wat $PATH_A ==="
wasm2wat "$PATH_A"
echo ""
echo "=== wasm-objdump -d $PATH_A ==="
wasm-objdump -d "$PATH_A"

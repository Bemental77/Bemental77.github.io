#!/bin/bash
#
# reddream_savestate.sh
#
# Intended:
#   Launch redream with /tmp/pso.chd, wait for boot to title screen,
#   trigger a save-state, and write a snapshot blob to
#   /tmp/reddream_savestate.bin.
#
# LIMITATION (verified 2026-05-17):
#   The shipped `redream` binary at
#     dreamcast/oracle/redream/redream
#   exposes no CLI option, environment variable, or stdin-driven hotkey
#   to trigger save-state from headless / non-windowed automation.
#
#   `strings redream | grep -iE 'savestate|save_state|snapshot|hotkey|^F[0-9]'`
#   returns NO matches. Save-state in redream's UI is a GUI-only
#   action driven by the in-app menu (after the trial/paid unlock).
#
#   Driving the GUI from this shell would require either
#     (a) AppleScript / cliclick to synthesize mouse + keyboard input
#         to a focused redream window - brittle, requires Accessibility
#         permissions, not robust enough to base oracles on; OR
#     (b) patching redream to add a CLI / signal hook - out of scope
#         since we do not have its source.
#
#   For now: USE THE GDB STUB INSTEAD - see
#     dreamcast/tools/reddream_gdb_attach.md
#   Connecting via `--gdb <port>` gives a deterministic, scriptable
#   snapshot of guest CPU + RAM at any chosen PC, which is what we
#   actually need from a "save-state" for divergence comparison.
#
# This script is intentionally a stub that exits non-zero with a
# pointer to the gdb-stub workflow, rather than inventing a code path
# that does not exist.
#
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: reddream_savestate.sh [--help]

Intent: snapshot redream guest state to /tmp/reddream_savestate.bin.

Status: NOT IMPLEMENTED.
  The shipped redream binary has no CLI/headless save-state trigger.
  See the LIMITATION block at the top of this file and use
  dreamcast/tools/reddream_gdb_attach.md (the GDB stub) for scriptable
  guest state inspection instead.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

echo "reddream_savestate.sh: not implemented - redream has no CLI save-state hook." >&2
echo "  Use the --gdb stub workflow documented in" >&2
echo "  dreamcast/tools/reddream_gdb_attach.md instead." >&2
exit 2

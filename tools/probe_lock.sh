#!/usr/bin/env bash
# probe_lock.sh — serialize measurement across concurrently-running agents.
#
# WHY THIS EXISTS. A bare `mkdir /tmp/bemental-probe.lock` lock was in use and
# it FAILED IN PRACTICE, twice, on 2026-09-01:
#   * one agent took the lock while another still held it (nothing recorded WHO
#     held it, so nothing could detect the double-take), and
#   * the box reached load 53.60 with several measurements in flight.
# At that load every number in flight is uninterpretable, which is the exact
# failure that has voided whole measurement campaigns in this project before
# (a prior parallel run hit load 83.93; every A/B in n64/docs/jit/TASKS.md was
# discarded for machine load, waves 8/9/10a are STILL unpriced because of it).
#
# The bare-mkdir lock has two holes this closes:
#   1. NO OWNER. A crashed holder leaves the directory forever, so the next
#      agent either waits out its whole timeout or — worse — deletes the lock
#      and runs on top of a live holder. Here the owner PID is recorded, and a
#      lock whose owner is gone is reclaimed automatically and reported.
#   2. NO LOAD GATE. Holding the lock does not make the box quiet; sibling
#      BUILDS are not probes and do not take it. Acquiring now also waits for
#      load to fall under a threshold, so the lock means "quiet enough to
#      measure", not merely "my turn".
#
# USAGE — the whole point is that release is automatic, so a crash cannot wedge
# every other agent:
#
#     bash tools/probe_lock.sh run -- <your command ...>
#
# It acquires, runs the command, and releases in ALL paths (including SIGINT,
# SIGTERM and a nonzero exit), then exits with the command's own status.
#
#     bash tools/probe_lock.sh status     # who holds it, for how long, load
#     bash tools/probe_lock.sh steal      # reclaim ONLY if the owner is dead
#
# Env: PROBE_LOCK_MAX_LOAD (default 12) · PROBE_LOCK_WAIT_S (default 1800)
#      PROBE_LOCK_DIR (default /tmp/bemental-probe.lock)

set -uo pipefail

LOCK="${PROBE_LOCK_DIR:-/tmp/bemental-probe.lock}"
OWNER_FILE="$LOCK/owner"
MAX_LOAD="${PROBE_LOCK_MAX_LOAD:-12}"
WAIT_S="${PROBE_LOCK_WAIT_S:-1800}"

load1() { uptime | sed -E 's/.*load averages?: *//' | awk '{print $1}' | tr -d ','; }
alive()  { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

owner_pid() { [ -f "$OWNER_FILE" ] && awk 'NR==1{print $1}' "$OWNER_FILE" || echo ""; }
owner_who() { [ -f "$OWNER_FILE" ] && awk 'NR==1{$1="";print}' "$OWNER_FILE" || echo "(unknown)"; }

reclaim_if_dead() {
  local p; p="$(owner_pid)"
  if [ -d "$LOCK" ] && [ -n "$p" ] && ! alive "$p"; then
    echo "[probe-lock] owner $p is GONE — reclaiming stale lock (held by:$(owner_who))"
    rm -rf "$LOCK"; return 0
  fi
  # A lock with no owner file is from the old bare-mkdir protocol and cannot
  # prove liveness, so it is reclaimed only after going untouched for
  # PROBE_LOCK_ORPHAN_MIN.
  #
  # WHY 10 AND NOT 20: an ownerless lock STARVES EVERY WAITER for the whole
  # window — observed with 18 agents queued behind an empty lock dir. The
  # window only has to exceed the longest single measurement, and nothing here
  # runs anywhere near that long: the GameCube probe's longest configured run
  # in this tree is PROBE_DURATION_MS=118000, and the directory's mtime is set
  # at creation and does not advance during a run, so a legitimate holder's
  # lock reads roughly its own runtime. 10 leaves a wide margin over ~2 while
  # halving the starvation window. Raise it with PROBE_LOCK_ORPHAN_MIN if a
  # genuinely longer measurement is ever added.
  if [ -d "$LOCK" ] && [ -z "$p" ]; then
    local om="${PROBE_LOCK_ORPHAN_MIN:-10}"
    if [ -z "$(find "$LOCK" -maxdepth 0 -newermt "-${om} minutes" 2>/dev/null)" ]; then
      echo "[probe-lock] ownerless lock untouched for >${om} min — reclaiming (bare-mkdir holder is gone)"
      rm -rf "$LOCK"; return 0
    fi
    echo "[probe-lock] waiting on an OWNERLESS lock (old bare-mkdir protocol) — cannot verify liveness; reclaim at ${om} min"
  fi
  return 1
}

acquire() {
  local waited=0
  while :; do
    if mkdir "$LOCK" 2>/dev/null; then
      echo "$$ ${PROBE_LOCK_WHO:-$(basename "${0}")} $(date +%H:%M:%S)" > "$OWNER_FILE"
      # Wait for the box to be quiet ENOUGH. Holding the lock is not the same
      # as the box being idle: sibling builds never take it.
      local l; l="$(load1)"
      local lwait=0
      while awk -v a="$l" -v b="$MAX_LOAD" 'BEGIN{exit !(a>b)}'; do
        if [ "$lwait" -ge 600 ]; then
          echo "[probe-lock] WARNING: load ${l} still above ${MAX_LOAD} after waiting; proceeding — REPORT THIS LOAD WITH YOUR NUMBERS"
          break
        fi
        echo "[probe-lock] holding lock, waiting for load ${l} to fall below ${MAX_LOAD}"
        sleep 20; lwait=$((lwait+20)); l="$(load1)"
      done
      echo "[probe-lock] ACQUIRED pid=$$ load=${l} at $(date +%H:%M:%S)"
      return 0
    fi
    reclaim_if_dead && continue
    if [ "$waited" -ge "$WAIT_S" ]; then
      echo "[probe-lock] TIMEOUT after ${WAIT_S}s — held by pid $(owner_pid) (:$(owner_who)). NOT stealing a live lock." >&2
      return 7
    fi
    sleep 10; waited=$((waited+10))
  done
}

# Native Dolphin oracle runs orphan exactly like browsers do, and
# browser_leak_guard.js deliberately only touches Chromes it registered — so
# nothing reaped these. Observed live: a `dolphin-emu-nogui` reparented to
# launchd with 18:44 elapsed, left behind by an agent whose run was killed.
#
# THE ORPHAN TEST IS PPID == 1, and it is exact: a Dolphin belonging to a LIVE
# run has a live parent (measured alongside the orphan above: pid 78097 with
# ppid 78095). So this can never kill a sibling's running oracle, which is the
# same guarantee browser_leak_guard gives via its owner-PID registry.
reap_orphan_oracles() {
  local killed=0 pid
  for pid in $(ps -eo pid,ppid,comm | awk '$2==1 && $3 ~ /dolphin-emu/ {print $1}'); do
    kill -9 "$pid" 2>/dev/null && killed=$((killed+1))
  done
  [ "$killed" -gt 0 ] && echo "[probe-lock] reaped ${killed} ORPHANED dolphin oracle process(es) (ppid==1)"
  return 0
}

release() {
  # Only the owner may release, so a crashed sibling cannot drop someone
  # else's lock and let two measurements overlap.
  if [ -d "$LOCK" ] && [ "$(owner_pid)" = "$$" ]; then
    rm -rf "$LOCK"
    echo "[probe-lock] released pid=$$ load=$(load1)"
  fi
}

case "${1:-status}" in
  run)
    shift; [ "${1:-}" = "--" ] && shift
    [ $# -gt 0 ] || { echo "usage: probe_lock.sh run -- <command...>" >&2; exit 2; }
    acquire || exit 7
    trap release EXIT INT TERM
    node "$(dirname "$0")/browser_leak_guard.js" reap || true
    reap_orphan_oracles
    "$@"; rc=$?
    echo "[probe-lock] command exit=${rc} load=$(load1)"
    exit "$rc"
    ;;
  status)
    if [ -d "$LOCK" ]; then
      p="$(owner_pid)"
      echo "[probe-lock] HELD by pid ${p:-?} (:$(owner_who)) — owner $(alive "$p" && echo ALIVE || echo GONE)"
    else
      echo "[probe-lock] free"
    fi
    echo "[probe-lock] load=$(load1) (max for measurement: ${MAX_LOAD})"
    ;;
  steal)
    reclaim_if_dead && echo "[probe-lock] reclaimed" || echo "[probe-lock] NOT stolen — owner is alive or lock is free"
    ;;
  *) echo "usage: probe_lock.sh {run -- <cmd>|status|steal}" >&2; exit 2 ;;
esac

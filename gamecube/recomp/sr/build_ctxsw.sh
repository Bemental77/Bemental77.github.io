#!/usr/bin/env bash
# build_ctxsw.sh — the GUEST CONTEXT-SWITCH build: translated SAB thread code on
# top of the host OS boundary in sr_host_os.c.
#
#   bash gamecube/recomp/sr/build_ctxsw.sh <sab_main.dol|sab.iso>
#
# Same shape as build_slice.sh (which stays the wrapper for every non-threaded
# build); the differences are all forced by the context switch and are listed here
# so nobody has to diff the two:
#
#   --host <8 addrs>   sr.py leaves the guest-OS context/interrupt primitives AND
#                      SelectThread out of the emitted set, so calls to them land
#                      on sr_extern() -> sr_host_hook -> sr_host_os.c.
#   -pthread           one host thread per guest thread.  This is the whole
#                      mechanism: the park point and the resume point are the same
#                      host C frame, so NO stack switching is needed and the
#                      translated bodies are not instrumented at all.  Note what is
#                      absent: no -sASYNCIFY, no -sSUPPORT_LONGJMP, no JSPI.
#   PTHREAD_POOL_SIZE  every host thread is created inside sr_os_init(), before
#                      anything can block.  Creating one later, from a thread that
#                      is already parked, would need the main thread to spawn a
#                      Worker while the main thread is itself blocked.
#   no ALLOW_MEMORY_GROWTH  -pthread + growth is the documented slow path
#                      (emcc -Wpthreads-mem-growth); MEM1 is a fixed 24 MB anyway.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SR="$REPO/gamecube/recomp/sr"
DOL="${1:?usage: build_ctxsw.sh <main.dol|game.iso>}"
OUT="${SR_OUT:-/tmp/sr_ctxsw}"
mkdir -p "$OUT"

case "$DOL" in
  *.iso|*.ISO)
    python3 - "$DOL" "$OUT/main.dol" <<'EOF'
import struct, sys
iso, out = sys.argv[1], sys.argv[2]
f = open(iso, 'rb'); f.seek(0x420)
dol_off = struct.unpack('>I', f.read(4))[0]
f.seek(dol_off); dh = f.read(0x100)
toff = struct.unpack('>7I',  dh[0x00:0x1c]); tsz = struct.unpack('>7I',  dh[0x90:0xac])
doff = struct.unpack('>11I', dh[0x1c:0x48]); dsz = struct.unpack('>11I', dh[0xac:0xd8])
end = max(max(a + b for a, b in zip(toff, tsz)), max(a + b for a, b in zip(doff, dsz)))
f.seek(dol_off); open(out, 'wb').write(f.read(end))
print(f"[sr] extracted main.dol ({end} bytes) from {iso}", file=sys.stderr)
EOF
    DOL="$OUT/main.dol" ;;
esac

# THE HOST BOUNDARY.  Identified byte-for-byte against ~/gc_refs/dolsdk2001 — see
# CONTEXT_SWITCH.md §3 for the shipped words next to the SDK source of each.
HOSTS=(
  0x800e78ac   # OSDisableInterrupts    OSInterrupt.c:81
  0x800e78c0   # OSEnableInterrupts     OSInterrupt.c:93
  0x800e78d4   # OSRestoreInterrupts    OSInterrupt.c:105
  0x800e55d4   # OSSetCurrentContext    OSContext.c:200
  0x800e5630   # OSGetCurrentContext    OSContext.c:236
  0x800e579c   # OSClearContext         OSContext.c:390
  0x800e563c   # OSSaveContext          OSContext.c:240   <- the setjmp
  0x800e56bc   # OSLoadContext          OSContext.c:281   <- the longjmp (rfi)
  0x800ebd68   # SelectThread           OSThread.c:325    <- the CUT
)
# SR_TRACE_BUILD=1 keeps SelectThread TRANSLATED and host-implements only the
# context primitives.  That build is the ORACLE for the HLE one: sr_os_mode(2)
# stops it at the rfi and snapshots, and verify_ctxsw.mjs diffs the two snapshots.
if [ "${SR_TRACE_BUILD:-0}" = "1" ]; then
  HOSTS=("${HOSTS[@]:0:8}")
  echo "[sr] TRACE build: SelectThread stays translated (it is the oracle)"
fi
HOSTARGS=(); for h in "${HOSTS[@]}"; do HOSTARGS+=(--host "$h"); done

# Roots: the two real guest entry points a cooperative switch runs through.
#   0x800ec890 OSSleepThread(queue)   — DOLSDK OSThread.c:0x480 block
#   0x800ec97c OSWakeupThread(queue)  — DOLSDK OSThread.c:0x4A0 block
#   0x800ebf68 __OSReschedule         — named in tools/gsne8p.map
ROOTS=("${SR_ROOTS:-0x800ec890 0x800ec97c 0x800ebf68}")
read -r -a ROOTA <<< "${ROOTS[*]}"
FNARGS=(); for f in "${ROOTA[@]}"; do FNARGS+=(--fn "$f"); done

python3 "$SR/sr.py" --image "$DOL" --map "$REPO/dolphin_captures/sab.map" \
        "${FNARGS[@]}" "${HOSTARGS[@]}" --closure --out "$OUT/sr_gen.c"

source "$HOME/emsdk-upstream/emsdk_env.sh" >/dev/null 2>&1

EXPORTS=_sr_init,_sr_ram,_sr_ram_size,_sr_state,_sr_state_size,_sr_call,_malloc
EXPORTS=$EXPORTS,_sr_os_init,_sr_os_mode,_sr_os_get_mode,_sr_os_set_msr,_sr_os_get_msr
EXPORTS=$EXPORTS,_sr_os_set_timeout,_sr_os_trace,_sr_os_trace_n,_sr_os_trace_reset
EXPORTS=$EXPORTS,_sr_os_slot_thread,_sr_os_slot_started,_sr_os_nthreads,_sr_os_bind_self
EXPORTS=$EXPORTS,_sr_os_snapshot,_sr_os_snapshot_hash,_sr_os_snapshot_valid,_sr_os_snapshot_reset
EXPORTS=$EXPORTS,_sr_os_slot_tid

emcc ${SR_OPT:--O2} -I"$SR" \
  "$OUT/sr_gen.c" "$SR/sr_driver.c" "$SR/sr_host_os.c" \
  -o "$OUT/sr_ctxsw.mjs" \
  -pthread -sPTHREAD_POOL_SIZE=8 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT="${SR_ENV:-node,worker}" \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sINITIAL_MEMORY=134217728 \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,wasmMemory \
  -Wl,--no-entry

echo "[sr] wasm: $OUT/sr_ctxsw.wasm  $(stat -f%z "$OUT/sr_ctxsw.wasm") bytes"
echo "[sr] md5 : $(md5 -q "$OUT/sr_ctxsw.wasm")"

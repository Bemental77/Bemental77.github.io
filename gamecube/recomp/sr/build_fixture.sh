#!/usr/bin/env bash
# build_fixture.sh — translate a NON-LEAF function together with its whole callee
# closure and link it with the differential-verify hooks (-DSR_VERIFY).
#
#   bash gamecube/recomp/sr/build_fixture.sh <sab_main.dol|iso> <entry_hex> [more...]
#
# Every entry's transitive callee closure is translated into ONE C file, so calls
# become real C calls (sr.py --closure).  A call that escapes the closure is
# impossible here by construction; if one appeared it would link to sr_extern(),
# which faults.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SR="$REPO/gamecube/recomp/sr"
DOL="${1:?usage: build_fixture.sh <main.dol|iso> <entry_hex> [more...]}"; shift
FNS=("$@"); [ ${#FNS[@]} -eq 0 ] && { echo "no entry addresses given" >&2; exit 1; }
OUT="${SR_OUT:-/tmp/sr_fixture}"
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

source "$HOME/emsdk-upstream/emsdk_env.sh" >/dev/null 2>&1

# SR_EXTRA_ARGS: extra sr.py flags (e.g. "--indirect --boundaries outer+calls").
# Empty by default so the recorded reproduction of this script is unchanged.
read -r -a EXTRA <<< "${SR_EXTRA_ARGS:-}"
# SR_GEN: link a PRE-GENERATED C file instead of running sr.py.  This is how an
# OVERLAY fixture is built -- rel_emit.py --base emits the overlay function together
# with its DOL callee closure at REAL runtime addresses, which sr.py (DOL-only) cannot.
if [ -n "${SR_GEN:-}" ]; then
  cp "$SR_GEN" "$OUT/sr_gen.c"
  echo "[sr] linking pre-generated $SR_GEN"
else
  ARGS=(); for f in "${FNS[@]}"; do ARGS+=(--fn "$f"); done
  python3 "$SR/sr.py" --image "$DOL" --map "$REPO/dolphin_captures/sab.map" \
          "${ARGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"} --closure --out "$OUT/sr_gen.c"
fi

# SR_DISPATCH_C: sr_dispatch compiled as its OWN TU (sr.py --dispatch-out).  Required
# for a WHOLE-IMAGE verify build at -O2, for the same reason build_slice.sh takes it:
# in one file clang inlines all 4,671 translated bodies into the dispatch switch and
# V8 rejects the result at instantiate ("size ... > maximum function size 7654321"),
# which reads like a corrupt wasm rather than a size limit.  Separate TU = no
# cross-TU inlining without LTO, so the bodies keep -O2.  Measured worth ~24x
# (README §5j).  Without it a whole-image verify build must use SR_OPT=-O0.
EXTRA_SRC=(); [ -n "${SR_DISPATCH_C:-}" ] && EXTRA_SRC=("$SR_DISPATCH_C")

# SR_HOST_OS=1: link the host OS boundary (sr_host_os.c) so a `bl` to a --host
# address is SERVICED instead of faulting.  Off by default: without it sr_host_hook
# stays NULL and every existing build's sr_extern behaviour is byte for byte what it
# was.  NO -pthread is added -- SR_OS_IRQ (sr_os_init_irq) creates no host thread;
# the pool belongs to SelectThread, which that mode does not answer for.
# THE CONTROL ARM IS INSIDE THIS BUILD, not a second one: sr_os_mode(0) turns the
# boundary off at run time, so the "does the primitive carry the pass?" pair is taken
# on ONE binary with one md5 and cannot be confounded by a relink.
HOST_SRC=(); HOST_EXP=""
if [ "${SR_HOST_OS:-0}" = "1" ]; then
  HOST_SRC=("$SR/sr_host_os.c")
  HOST_EXP=",_sr_os_init_irq,_sr_os_mode,_sr_os_get_mode,_sr_os_set_msr,_sr_os_get_msr,_sr_os_trace,_sr_os_trace_n,_sr_os_trace_reset"
  # The TIMEBASE boundary rides in the same TU and needs no mode of its own, but it
  # gets its OWN run-time switch: SR_TB=0 turns the clock off while leaving the MSR
  # boundary on, so the clock's control arm isolates the clock instead of also
  # re-breaking every OSDisableInterrupts fixture.
  HOST_EXP="$HOST_EXP,_sr_tb_enable,_sr_tb_is_enabled,_sr_tb_hi,_sr_tb_lo,_sr_tb_seed_parts"
  HOST_EXP="$HOST_EXP,_sr_tb_credit,_sr_tb_field,_sr_dec_get,_sr_dec_set,_sr_tb_calls"
  HOST_EXP="$HOST_EXP,_sr_tb_stalls,_sr_tb_dec_exceptions,_sr_tb_cycles_hi,_sr_tb_cycles_lo,_sr_tb_reset"
fi

# SR_CFLAGS: extra compiler flags.  The reason this exists is the FALSIFICATION
# CONTROL ARM: `SR_CFLAGS=-DSR_NO_LC_MODEL` drops gekko_rt.h's locked-cache arm so an
# 0xE00000xx access aliases into MEM1 the way it did before the model existed.  A
# fixture that passes only because the cache is modelled MUST fail in that build; if
# it passes in both, the pass was not evidence for the model.
read -r -a SR_CF <<< "${SR_CFLAGS:-}"

# SR_OPT: optimisation level.  MUST be lowered for a whole-image build UNLESS
# SR_DISPATCH_C splits the dispatch out (see above).
emcc ${SR_OPT:--O2} -DSR_VERIFY ${SR_CF[@]+"${SR_CF[@]}"} -I"$SR" "$OUT/sr_gen.c" ${EXTRA_SRC[@]+"${EXTRA_SRC[@]}"} ${HOST_SRC[@]+"${HOST_SRC[@]}"} "$SR/sr_driver.c" -o "$OUT/sr_fixture.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 \
  -sEXPORTED_FUNCTIONS=_sr_init,_sr_ram,_sr_ram_size,_sr_tail_size,_sr_state,_sr_state_size,_sr_call,_sr_staged,_sr_wlog,_sr_wlog_n,_sr_unstaged,_sr_verify_reset,_sr_hid0,_sr_set_hid0,_malloc"$HOST_EXP" \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,wasmMemory \
  -Wl,--no-entry

echo "[sr] wasm: $OUT/sr_fixture.wasm  $(stat -f%z "$OUT/sr_fixture.wasm") bytes"
echo "[sr] md5 : $(md5 -q "$OUT/sr_fixture.wasm")"

#!/usr/bin/env bash
# build_image.sh — THE WHOLE-IMAGE BOOT BUILD.
#
#   bash gamecube/recomp/sr/build_image.sh <sab_main.dol|sab.iso>
#
# Every other build script in this directory produces a DIFFERENTIAL: build_slice.sh
# and build_fixture.sh translate a named function (or its closure), stage it from a
# native-Dolphin capture, run it once and diff it; build_ctxsw.sh does the same for the
# guest context switch.  None of them ever runs `__start`, and none of them produces
# anything a browser can load — they all link -sENVIRONMENT=node.
#
# This one links the WHOLE IMAGE plus a boot host layer (sr_image.c) as a BROWSER
# worker, so the question stops being "is this function's translation bit-exact?" and
# becomes "how far into SAB's own boot does the translated image get?".
#
# WHAT IS DIFFERENT FROM build_slice.sh, and why each difference is forced:
#
#   --all --indirect --jumptables   the whole boundary set, with runtime dispatch and
#                       static switch-table recovery.  Without --jumptables 123 DOL
#                       functions translate but fault the moment they execute
#                       (sr.py --help); a boot executes them.
#   --dispatch-out      sr_dispatch in its OWN TU.  Not optional at -O2: in one file
#                       clang inlines all 4,668 bodies into the dispatch switch and V8
#                       rejects the result at instantiate with "size ... > maximum
#                       function size 7654321", which reads like a corrupt wasm rather
#                       than a size limit.  Measured worth ~24x (README §5j).
#   --host <13 addrs>   the guest-OS boundary sr_host_os.c already answers for: the
#                       MSR family, the context primitives and SelectThread.  The MSR
#                       three alone unblock 745 DOL functions BY CLOSURE (README §9.3).
#   -DSR_MMIO           the device-register window in gekko_rt.h.  A fixture never
#                       touches one; a boot touches one almost immediately, and without
#                       a named window gk_phys(0xCC002000) leaves MEM1's bound and
#                       faults.  READ the long note in gekko_rt.h before quoting any
#                       result that depended on this: it is a BACKING BUFFER, not a
#                       device model.
#   -sENVIRONMENT=web,worker  the output is loaded by a real browser worker
#                       (sr_image_worker.js), not by node.  Cross-origin isolation
#                       comes from the site's coi-serviceworker.js.
#   no -DSR_VERIFY      there is no capture to diff against.  The staged/unstaged read
#                       check and the ordered write log are fixture instruments and
#                       would cost on every guest access for nothing here.
#
# Output: $OUT/sab_image.{mjs,wasm} + the generated C, and an md5 for hash-guarding.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SR="$REPO/gamecube/recomp/sr"
DOL="${1:?usage: build_image.sh <main.dol|game.iso>}"
OUT="${SR_OUT:-$REPO/gamecube/recomp/sr_image}"
mkdir -p "$OUT"

case "$DOL" in
  *.iso|*.ISO)
    python3 - "$DOL" "$OUT/sab_main.dol" <<'EOF'
import struct, sys
iso, out = sys.argv[1], sys.argv[2]
f = open(iso, 'rb'); f.seek(0x420)
dol_off = struct.unpack('>I', f.read(4))[0]
f.seek(dol_off); dh = f.read(0x100)
toff = struct.unpack('>7I',  dh[0x00:0x1c]); tsz = struct.unpack('>7I',  dh[0x90:0xac])
doff = struct.unpack('>11I', dh[0x1c:0x48]); dsz = struct.unpack('>11I', dh[0xac:0xd8])
end = max(max(a + b for a, b in zip(toff, tsz)), max(a + b for a, b in zip(doff, dsz)))
f.seek(dol_off); open(out, 'wb').write(f.read(end))
print(f"[sr] extracted main.dol ({end} bytes) from {iso}  entry=0x{struct.unpack('>I', dh[0xe0:0xe4])[0]:08x}", file=sys.stderr)
EOF
    DOL="$OUT/sab_main.dol" ;;
esac

# THE GUEST-OS HOST BOUNDARY.  Identical list to build_ctxsw.sh — see CONTEXT_SWITCH.md
# §3 for the shipped words next to the DOLSDK source of each — plus the four Metrowerks
# TRK MSR accessors, which sr_host_os.h names as the same primitive.
HOSTS=(
  0x800e78ac   # OSDisableInterrupts    OSInterrupt.c:81   <- 745 functions by closure
  0x800e78c0   # OSEnableInterrupts     OSInterrupt.c:93
  0x800e78d4   # OSRestoreInterrupts    OSInterrupt.c:105  <- 91 more
  0x800e3494   # __TRK_get_MSR
  0x800e349c   # __TRK_set_MSR
  0x80108e98   # __TRK_get_MSR   (SAB links two byte-identical copies)
  0x80108ea0   # __TRK_set_MSR
  0x800e55d4   # OSSetCurrentContext    OSContext.c:200
  0x800e5630   # OSGetCurrentContext    OSContext.c:236
  0x800e579c   # OSClearContext         OSContext.c:390
  0x800e563c   # OSSaveContext          OSContext.c:240   <- the setjmp
  0x800e56bc   # OSLoadContext          OSContext.c:281   <- the longjmp (rfi)
  0x800ebd68   # SelectThread           OSThread.c:325    <- the CUT
)
# THE BOOT-LAYER HOST BOUNDARY — every address sr_image.c answers for, in the same order
# its switch does.  These are ALL in sr.py's refusal set already (privileged SPR / cache /
# `sc`), so naming them here does not change WHICH functions get emitted for --all.  What
# it changes is the CLOSURE arm: `sr.py --closure` walks callees and aborts the whole build
# on the first one it cannot translate ("CLOSURE BLOCKED at 0x800e34ac"), so without this
# list SR_FNS cannot build any closure that reaches a cache op — which is nearly all of
# them.  Keeping the list HERE rather than only in sr_image.c also means the two cannot
# drift apart silently: an address implemented there but missing here is a closure that
# refuses to build, not a wrong answer.
HOSTS+=(
  # --- REAL implementations (sr_image.c)
  0x80003330   # __init_hardware      MSR[FP] + __OSPSInit + __OSCacheInit
  0x800e3d38   # __OSPSInit           GQR0..7 = 0 (the only mode gekko_rt.h implements), HID2
  0x800e34a4 0x800e34ac 0x800e34b4 0x800e34bc   # PPCMf*/PPCMt* SPR accessors
  0x800e34e0 0x800e34e8 0x800e34f0              # ...decoded from the shipped instruction word
  0x800ecb48   # OSGetTime            40.5 MHz, driven by RETIRED GUEST WORK (sr_host_os.c)
  0x800ecb60   # OSGetTick            — NOT by the host clock; see sr_host_os.h gate-#9 note
  0x800e54ac   # __OSSaveFPUContext   FPR/PS1/FPSCR <-> OSContext
  0x800e5388   # __OSLoadFPUContext
  # --- VOID: cache control, and there is no cache in this runtime to control
  0x800e34c4   # PPCSync              (sc)
  0x800e4e08   # DCEnable
  0x800e4e1c   # cache/sync op x470
  0x800e4e4c 0x800e4e80                          # DCFlushRange / DCStoreRange class (sc)
  0x800e4f4c   # ICFlashInvalidate
  0x800e4f5c   # ICEnable
  0x800e4f70   # __LCEnable           the locked cache is already modelled memory (README §5k)
  0x800e5074   # LCDisable
  0x8014b504 0x8014b5bc 0x8014b680 0x8014b7ac    # cache/sync op x470
)
# SR_HOSTS_EXTRA: additional --host addresses, for the SR_FNS closure arm.
#
# WHY IT IS NEEDED AND WHY IT IS NOT A CHEAT.  `--all` emits every function it can and
# turns a call to one it refused into sr_extern() -> img_hook, which FAULTS and names the
# address.  `--closure` cannot do that: it walks callees and ABORTS the build on the first
# refusal ("CLOSURE BLOCKED at 0x800e8a4c: mtspr SPR26"), so a closure arm cannot even be
# built for anything whose callee graph touches a privileged instruction — which, for the
# boot path, is most of it.  Host-binding those addresses makes the closure arm behave the
# way --all already does: the call reaches img_hook, which logs it IMG_D_UNIMPL and faults.
# It does not fabricate a return value, and it does not hide anything --all would show.
read -r -a HOSTS_X <<< "${SR_HOSTS_EXTRA:-}"
HOSTS+=(${HOSTS_X[@]+"${HOSTS_X[@]}"})
HOSTARGS=(); for h in "${HOSTS[@]}"; do HOSTARGS+=(--host "$h"); done

# SR_FNS: BRING-UP ARM.  Translate only the closure of these entry addresses instead of
# the whole image.  It exists because the whole-image translation unit is 33 MB and takes
# many minutes to compile, and none of that time answers "does the browser worker, the
# DOL loader, the low-memory staging and the boundary log actually work?".  This arm
# answers exactly that in seconds, against the SAME sr_image.c / sr_driver.c /
# sr_host_os.c and the SAME emcc flags, so a pass here isolates any later failure to the
# translation volume rather than to the harness.  It is NOT a substitute for the real
# build: --all is what the acceptance criteria are about.
DISPATCH_SRC=()
if [ -n "${SR_FNS:-}" ]; then
  read -r -a FNA <<< "$SR_FNS"
  FNARGS=(); for f in "${FNA[@]}"; do FNARGS+=(--fn "$f"); done
  echo "[sr] BRING-UP ARM: closure of ${SR_FNS} only, NOT the whole image"
  python3 "$SR/sr.py" --image "$DOL" --map "$REPO/dolphin_captures/sab.map" \
          "${FNARGS[@]}" --closure --indirect --jumptables --boundaries outer+calls \
          "${HOSTARGS[@]}" --out "$OUT/sr_gen.c"
elif [ -n "${SR_GEN:-}" ]; then
  echo "[sr] reusing pre-generated $SR_GEN"
  cp "$SR_GEN" "$OUT/sr_gen.c"
  DISPATCH_SRC=("$OUT/sr_dispatch.c")
else
  python3 "$SR/sr.py" --image "$DOL" --map "$REPO/dolphin_captures/sab.map" \
          --all --indirect --jumptables --boundaries outer+calls \
          "${HOSTARGS[@]}" \
          --skiplist "$OUT/skiplist.json" \
          --dispatch-out "$OUT/sr_dispatch.c" \
          --out "$OUT/sr_gen.c"
  DISPATCH_SRC=("$OUT/sr_dispatch.c")
fi

source "$HOME/emsdk-upstream/emsdk_env.sh" >/dev/null 2>&1
emcc --version | head -1

EXPORTS=_sr_init,_sr_ram,_sr_ram_size,_sr_tail_size,_sr_state,_sr_state_size,_sr_call,_malloc,_free
EXPORTS=$EXPORTS,_sr_image_init,_sr_image_load_dol,_sr_image_boot,_sr_image_call,_sr_image_entry
EXPORTS=$EXPORTS,_sr_image_fault,_sr_image_log,_sr_image_log_n,_sr_image_log_dropped
EXPORTS=$EXPORTS,_sr_image_log_reset,_sr_image_spr,_sr_image_set_spr,_sr_image_set_global
EXPORTS=$EXPORTS,_sr_image_dev_log,_sr_image_dev_log_n,_sr_image_dev_reads,_sr_image_dev_writes
EXPORTS=$EXPORTS,_sr_image_exi_clears,_sr_image_set_exi_model,_sr_image_set_watchdog,_sr_image_set_strict
EXPORTS=$EXPORTS,_sr_os_mode,_sr_os_get_mode,_sr_os_set_msr,_sr_os_get_msr
EXPORTS=$EXPORTS,_sr_os_trace,_sr_os_trace_n,_sr_os_trace_reset

set -x
emcc ${SR_OPT:--O2} -DSR_MMIO -I"$SR" \
  "$OUT/sr_gen.c" ${DISPATCH_SRC[@]+"${DISPATCH_SRC[@]}"} "$SR/sr_driver.c" "$SR/sr_host_os.c" "$SR/sr_image.c" \
  -o "$OUT/sab_image.mjs" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT="${SR_ENV:-web,worker}" \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 -sSTACK_SIZE=8388608 \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,wasmMemory \
  -Wl,--no-entry
set +x

echo "[sr] wasm: $OUT/sab_image.wasm  $(stat -f%z "$OUT/sab_image.wasm") bytes"
echo "[sr] md5 : $(md5 -q "$OUT/sab_image.wasm")"
echo "[sr] mjs : $OUT/sab_image.mjs  $(stat -f%z "$OUT/sab_image.mjs") bytes"

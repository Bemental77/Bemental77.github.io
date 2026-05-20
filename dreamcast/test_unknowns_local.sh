#!/bin/bash
# dreamcast/test_unknowns_local.sh
#
# Test suite using local emulators (native flycast + redream) to resolve
# specific unknowns about PSO IPL state. Output to /tmp/test_unknowns_local/.
#
# Addressable by local emulator:
#   U5  — native PSO IPL execution depth (how far it gets, how many blocks)
#   U4  — whether PSO progresses linearly past 0x8c02ab4c or cycles back
#   U8  — whether native flycast also wedges (= dispatch overhead is not
#         the only factor; bug is shared upstream)
#   U11 — origin of r15 (stack) at wedge entry (via redream RAM dump)
#   U12 — state divergence at 0x8c02ab4c entry (partial: redream PC coverage
#         vs our wasm reach)
#
# NOT addressable by local emulator (wasm-internal questions):
#   U1  — Fix A prologue body execution (need forced interrupt_pend != 0)
#   U6  — SHIL op shape at 0x8c02c160 (need flycast decoder dump in our wasm)
#   U7  — fastpath guard pass rate (need wasm runtime trace)
#   U9  — SH4 merged-mode benefit for this loop (need implementation)
#   U10 — existing memset detector firing on early-boot loops (need wasm trace)

set -u

OUT=/tmp/test_unknowns_local
rm -rf "$OUT"
mkdir -p "$OUT"

REPO=/Users/caseybement/Bemental77.github.io
REDREAM="$REPO/dreamcast/oracle/redream/redream"
PSO_CHD=/tmp/pso.chd

if [[ ! -f "$PSO_CHD" ]]; then
    echo "FAIL: PSO chd missing at $PSO_CHD" | tee "$OUT/00_setup_error.log"
    exit 1
fi

# ------------------------------------------------------------------
# Test 1 — redream baseline: SH4 block coverage, depth of execution
# ------------------------------------------------------------------
echo "=== test 1: redream native --perf 1 ===" | tee "$OUT/01_redream.log"
rm -f /tmp/perf-*.map
pushd "$(dirname "$REDREAM")" >/dev/null
./redream --perf 1 "$PSO_CHD" > "$OUT/redream_stdout.log" 2>&1 &
RPID=$!
echo "  redream pid=$RPID, running" | tee -a "$OUT/01_redream.log"
sleep 15
kill -TERM $RPID 2>/dev/null
sleep 1
kill -KILL $RPID 2>/dev/null
popd >/dev/null

PERF_MAP=$(ls -t /tmp/perf-*.map 2>/dev/null | head -1)
if [[ -n "$PERF_MAP" && -s "$PERF_MAP" ]]; then
    cp "$PERF_MAP" "$OUT/redream_perf.map"
    {
        echo "  SH4 blocks compiled: $(grep -c 'sh4_0x' "$OUT/redream_perf.map")"
        echo "  ARM7 blocks compiled: $(grep -c 'arm7_0x' "$OUT/redream_perf.map")"
        echo "  Highest SH4 PC: $(grep -oE 'sh4_0x[0-9a-f]+' "$OUT/redream_perf.map" | sed 's/sh4_0x//' | sort -u | tail -1)"
        echo ""
        echo "  Blocks at specific PCs of interest:"
        for pc in 8c02ab4c 8c02ab44 8c02c160 8c02c16a 8c0215ee 8c0083d8; do
            n=$(grep -cE "sh4_0x${pc}([^0-9a-f]|\$)" "$OUT/redream_perf.map")
            echo "    sh4_0x${pc}: $n blocks"
        done
        echo ""
        echo "  Block count by /0x10000 bucket:"
        awk '/sh4_0x/{sub("sh4_0x","",$3);printf "0x%s\n", substr($3,1,4)"0000"}' "$OUT/redream_perf.map" \
            | sort | uniq -c | sort -k2 | awk '{printf "    %s: %d\n",$2,$1}'
    } | tee -a "$OUT/01_redream.log"
else
    echo "  FAIL: no perf map written (window may have lacked focus)" | tee -a "$OUT/01_redream.log"
fi

# ------------------------------------------------------------------
# Test 2 — native flycast: does it reach 0x8c02ab4c with REIOS HLE?
#                          does it wedge in the same region?
# ------------------------------------------------------------------
echo "" | tee -a "$OUT/02_native_flycast.log"
echo "=== test 2: native flycast (RetroArch + flycast libretro) ===" | tee "$OUT/02_native_flycast.log"
bash "$REPO/dreamcast/run_native_flycast.sh" 30 >> "$OUT/02_native_flycast_raw.log" 2>&1 || true

NATIVE_LOG=/tmp/native_realbios.log
if [[ -f "$NATIVE_LOG" ]]; then
    {
        echo "  Log size: $(wc -l < $NATIVE_LOG) lines"
        echo "  REIOS used: $(grep -c 'using reios' $NATIVE_LOG)"
        echo "  Final REIOS PC range mentions:"
        grep -oE 'pc[= ]0x8c[0-9a-f]+' "$NATIVE_LOG" 2>/dev/null | sort -u | tail -10 || echo "    (no pc= lines in log)"
        echo "  [pc-trace] lines: $(grep -c '\[pc-trace\]' $NATIVE_LOG 2>/dev/null || echo 0)"
        echo "  GDROM unimplemented warnings: $(grep -c 'GDROM.*Not implemented\|GDROM.*not implemented' $NATIVE_LOG)"
    } | tee -a "$OUT/02_native_flycast.log"
else
    echo "  FAIL: native_realbios.log missing" | tee -a "$OUT/02_native_flycast.log"
fi

# ------------------------------------------------------------------
# Test 3 — our wasm state at the wedge PC (from latest dc-probes log)
# ------------------------------------------------------------------
echo "" | tee -a "$OUT/03_our_wasm.log"
echo "=== test 3: our wasm state at PC=0x8c02ab4c / 0x8c02c16a ===" | tee "$OUT/03_our_wasm.log"
LATEST=$(ls -t /tmp/dc-probes/*.log 2>/dev/null | head -1)
if [[ -n "$LATEST" ]]; then
    {
        echo "  Source probe: $LATEST"
        echo "  Mtime: $(stat -f '%Sm' "$LATEST" 2>/dev/null || stat -c '%y' "$LATEST")"
        echo ""
        echo "  Final 3 per-1000 dispatch traces:"
        grep -B1 -A3 "pc=0x8c02ab4c\|pc=0x8c02c16a" "$LATEST" | tail -16
        echo ""
        echo "  Distinct PR values observed at the wedge PCs:"
        grep -oE 'pr=0x[0-9a-f]+' "$LATEST" | sort | uniq -c | sort -rn | head -8
    } | tee -a "$OUT/03_our_wasm.log"
else
    echo "  FAIL: no probe log under /tmp/dc-probes/" | tee -a "$OUT/03_our_wasm.log"
fi

# ------------------------------------------------------------------
# Test 4 — redream stack-region RAM dump (origin of r15 content)
# Launch redream fresh, dump the typical PSO IPL stack region.
# REIOS sets the SH4 stack near top of 16MB RAM (0x8d000000) before
# 1ST_READ.BIN runs. Dumping bytes there shows what PSO pushed.
# ------------------------------------------------------------------
echo "" | tee -a "$OUT/04_stack_dump.log"
echo "=== test 4: redream stack-region RAM dump at 0x8cffff00 (top of RAM) ===" | tee "$OUT/04_stack_dump.log"
# Use the existing reddream_lldb_dump.sh tool. It launches redream if not running.
bash "$REPO/dreamcast/tools/reddream_lldb_dump.sh" 0x8cffff00 256 \
    > "$OUT/04_stack_dump_raw.log" 2>&1 || true
{
    echo "  Tool output:"
    tail -40 "$OUT/04_stack_dump_raw.log"
    echo ""
    echo "  Hex dump (if produced):"
    ls -la /tmp/reddream_dump_*.bin 2>/dev/null | tail -3 || echo "    (no dump file)"
} | tee -a "$OUT/04_stack_dump.log"

# Kill any background redream the dump tool left running.
pkill -f "oracle/redream/redream" 2>/dev/null || true

# ------------------------------------------------------------------
# Synthesis — which unknowns resolved and how
# ------------------------------------------------------------------
echo "" | tee "$OUT/99_resolution.log"
echo "=== resolution summary ===" | tee -a "$OUT/99_resolution.log"
{
    if [[ -s "$OUT/redream_perf.map" ]]; then
        N_REDREAM=$(grep -c 'sh4_0x' "$OUT/redream_perf.map")
        N_ABAC=$(grep -cE 'sh4_0x8c02ab4c([^0-9a-f]|$)' "$OUT/redream_perf.map")
        N_C160=$(grep -cE 'sh4_0x8c02c160([^0-9a-f]|$)' "$OUT/redream_perf.map")
        N_215E=$(grep -cE 'sh4_0x8c0215ee([^0-9a-f]|$)' "$OUT/redream_perf.map")
        HI_PC=$(grep -oE 'sh4_0x[0-9a-f]+' "$OUT/redream_perf.map" | sed 's/sh4_0x//' | sort -u | tail -1)
        N_BAND=$(grep -cE 'sh4_0x8c0[12]' "$OUT/redream_perf.map")
        echo "U5  resolved: redream compiled $N_REDREAM SH4 blocks reaching PC=0x$HI_PC"
        echo "U12 partial : redream block counts at our-wedge PCs:"
        echo "                0x8c02ab4c (caller loop):    $N_ABAC"
        echo "                0x8c02c160 (inner memcpy):   $N_C160"
        echo "                0x8c0215ee (alt-caller):     $N_215E"
        echo "                0x8c01-0x8c02 region total:  $N_BAND"
        if [[ "$N_ABAC" -eq 0 && "$N_C160" -eq 0 && "$N_215E" -eq 0 ]]; then
            echo "             → CONCLUSION: redream never compiled any of our wedge PCs."
            echo "                PSO IPL via redream takes a DIFFERENT codepath; the wedge code"
            echo "                is OUR-ONLY. Divergence is upstream of 0x8c02ab4c."
        elif [[ "$N_ABAC" -gt 0 ]]; then
            echo "             → CONCLUSION: shared codepath. State-diff at entry is the open question."
        fi
    else
        echo "U5  unresolved: no redream perf map (window-focus issue)"
        echo "U12 unresolved: redream coverage not measured"
    fi
    echo ""
    if grep -q "GDROM.*ot implemented\|22 unique PCs" "$OUT/02_native_flycast_raw.log" 2>/dev/null \
        || grep -q "Did not load BIOS, using reios" "$NATIVE_LOG" 2>/dev/null; then
        echo "U4  partial : native flycast HLE-only (no real BIOS); not directly comparable"
        echo "U8  partial : native flycast still uses interpreter — if it ALSO wedges, dispatch overhead is shared"
    fi
    echo ""
    echo "Unresolved by this test (need different instrumentation):"
    echo "  U1  Fix A prologue body — need a forced interrupt_pend!=0 case"
    echo "  U6  SHIL op shape at 0x8c02c160 — need flycast decoder dump"
    echo "  U7  fastpath guard pass rate — need wasm runtime trace"
    echo "  U9  merged-mode benefit for this pattern — need implementation"
    echo "  U10 existing memset detector firing — need wasm trace"
    echo "  U11 r15 stack content origin — partial (dump only shows current state, not who wrote)"
} | tee -a "$OUT/99_resolution.log"

echo ""
echo "All outputs: $OUT/"
ls -la "$OUT/"

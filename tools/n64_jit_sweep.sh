#!/usr/bin/env bash
# N64 JIT full-library differential sweep — the gate before ?jit can default.
#
#     bash tools/probe_lock.sh run -- bash tools/n64_jit_sweep.sh [frames]
#
# Runs tools/n64_jit_diff_test.mjs over every ROM in n64/N64Wasm/roms/ and
# writes a one-row-per-ROM TSV to /tmp/n64-jit-sweep/summary.tsv, with the full
# per-ROM log beside it. Needs `npm run web` on :8080.
#
# WHY A SCRIPT AND NOT A ONE-LINER. n64/docs/jit/TASKS.md names this sweep as
# the gate a5efb66 set before the ?jit default can flip, and thewheel.z64
# already proved it is not a formality (it wedged under ?jit from a null
# precomp_instr.ops in the VENDORED CORE — a bug no single-ROM gate found).
# A gate that has to be retyped is a gate that gets run differently each time.
#
# EVERY ROW CARRIES ITS OWN CONDITIONS. 1-minute load and CPU_Speed_Limit are
# sampled before and after each ROM, because this project has voided whole
# measurement campaigns to machine load. The sweep is a CORRECTNESS arm — its
# PASS/FAIL verdicts are checksum comparisons and are immune to load — but the
# harness has 120 s/180 s waitForFunction timeouts, so a loaded box turns a
# healthy ROM into a `NOJSON` row. Read the load column before believing one.
#
# READING A FAILURE. `NOJSON` means the harness threw before printing its JSON,
# which is almost always a timeout, NOT a divergence. Check WHICH ARM threw:
#   n64_jit_diff_test.mjs:59 = interp-A   :60 = interp-B   :61 = jit
# A throw at :59/:60 is a slow ROM or a busy box and says nothing about the
# JIT. A throw at :61 is the thewheel.z64 shape — but note the jit arm is also
# the THIRD run in the same browser, so "jit" and "third" are confounded; run
# the mode ladder (?jit=wrap -> v05 -> nofp -> emit), whose `wrap` rung
# controls for position as well as for emission, before hypothesising.
set -uo pipefail

FRAMES="${1:-600}"
OUT="${SWEEP_OUT:-/tmp/n64-jit-sweep}"
ROMDIR="${ROMDIR:-n64/N64Wasm/roms}"
mkdir -p "$OUT"

printf 'rom\tdet\tjit\tblocks\tnativeFPCmp\tnativeFPBranches\tfcr31\tfallbackOps\temitFails\tnullOpsRejects\texit\tload\tlimit\n' > "$OUT/summary.tsv"

for f in "$ROMDIR"/*.z64; do
  rom=$(basename "$f")
  load=$(uptime | sed 's/.*averages: //' | awk '{print $1}')
  t0=$(pmset -g therm | awk '/CPU_Speed_Limit/{print $NF}')
  node tools/n64_jit_diff_test.mjs "$rom" "$FRAMES" > "$OUT/$rom.log" 2>&1
  ex=$?
  t1=$(pmset -g therm | awk '/CPU_Speed_Limit/{print $NF}')
  python3 - "$OUT/$rom.log" "$rom" "$ex" "$load" "$t0/$t1" >> "$OUT/summary.tsv" <<'PY'
import json, sys
path, rom, ex, load, lim = sys.argv[1:6]
txt = open(path, errors='replace').read()
try:
    d = json.loads(txt[txt.index('{'):txt.rindex('}') + 1])
    s = d.get('jitStats') or {}
    row = [rom, d.get('determinismControl', '?'), d.get('jitVsInterp', '?'),
           s.get('blocks', '-'), s.get('nativeFPCmp', '-'), s.get('nativeFPBranches', '-'),
           s.get('fcr31', '-'), s.get('fallbackOps', '-'), s.get('emitFails', '-'),
           s.get('nullOpsRejects', '-'), ex, load, lim]
except Exception:
    # the harness threw before printing JSON — record WHICH ARM, since that is
    # the whole diagnosis (see "READING A FAILURE" above)
    arm = next((l.split(':')[-2] for l in txt.splitlines()
                if 'n64_jit_diff_test.mjs:' in l and 'async' in l), '?')
    row = [rom, 'NOJSON', f'threw@line{arm}', '-', '-', '-', '-', '-', '-', '-', ex, load, lim]
print('\t'.join(str(x) for x in row))
PY
  tail -1 "$OUT/summary.tsv"
done

echo
echo "=== sweep summary ($OUT/summary.tsv) ==="
column -t -s$'\t' "$OUT/summary.tsv"
pass=$(awk -F'\t' 'NR>1 && $2=="PASS" && $3=="PASS"' "$OUT/summary.tsv" | wc -l | tr -d ' ')
tot=$(($(wc -l < "$OUT/summary.tsv") - 1))
echo
echo "PASS/PASS: $pass of $tot"
[ "$pass" -eq "$tot" ] || { echo "SWEEP NOT CLEAN — do not flip the ?jit default"; exit 1; }

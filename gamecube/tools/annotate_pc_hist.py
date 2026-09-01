#!/usr/bin/env python3
"""annotate_pc_hist.py — render the probe's guest-PC sample histogram by symbol
name (the ledger-by-name readout, STEP 0 sub-step 3).

Reads /tmp/wasm_pc_hist.json (produced by PROBE_PC_SAMPLE=1) and aggregates the
256B buckets BY FUNCTION via gc_symbols, keyed to the game by ROM_IDX.

Usage:  ROM_IDX=1 python3 gamecube/tools/annotate_pc_hist.py [hist.json]
        TOPN=40 ROM_IDX=0 python3 gamecube/tools/annotate_pc_hist.py

SEG_MIN / SEG_MAX (added 2026-09-01) restrict the aggregation to a window of the
sampler's 10-second segments. This is REQUIRED whenever the run injected a
save-state part-way through (PROBE_LOAD_STATE): segments before the restore are
boot/menu samples, and mixing them into a "gameplay census" is exactly the
"ranking measured on the wrong scene" failure. Segment i covers [10i, 10i+10)
seconds from sampler install (~Start click), so a restore at 45000 ms means the
first fully-post-restore segment is 5.
        SEG_MIN=6 ROM_IDX=1 python3 gamecube/tools/annotate_pc_hist.py
"""
import json
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gc_symbols import Symbols

rom = int(os.environ.get("ROM_IDX", sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].isdigit() else 1))
path = next((a for a in sys.argv[1:] if not a.isdigit()), "/tmp/wasm_pc_hist.json")
topn = int(os.environ.get("TOPN", 30))
seg_min = int(os.environ.get("SEG_MIN", 0))
seg_max = int(os.environ.get("SEG_MAX", 1 << 30))

syms = Symbols(rom)
if not os.path.exists(path):
    print("no histogram at %s (run with PROBE_PC_SAMPLE=1 first)" % path)
    sys.exit(1)

data = json.load(open(path))
bybucket = Counter()
total = 0
segs_used = []
for i, sg in enumerate(data):
    if not sg:
        continue
    seg = sg.get("seg", i)
    if seg < seg_min or seg > seg_max:
        continue
    segs_used.append(seg)
    for entry in sg.get("hist", []):
        bucket, cnt = entry[0], entry[1]
        bybucket[bucket] += cnt
        total += cnt

# Aggregate by FUNCTION for a clean ledger; track unresolved separately.
#
# [bucket-attribution fix 2026-09-01] This used to be `syms.find(bucket)` — a
# lookup of the 256B BASE address only. Measured against tools/gsne8p_xref.map:
# 417 of its 425 symbols start mid-bucket, 184 fit entirely inside one bucket
# without covering its base, and for 55 of those NOTHING covers the base — so
# buckets holding PPCHalt, OSExceptionVector, __OSPSInit, OSInitAlarm,
# OSSetErrorHandler (and 50 more) printed as "(unresolved 0x........)" even
# though the map names them. Worse, when SOMETHING did cover the base, the whole
# bucket was credited to it: SAB's "5.2% __check_pad3" is bucket 0x80003100,
# which holds __check_pad3 (0x40 bytes, ONE static caller — __start+0xfc, i.e.
# boot-only) followed by __start itself.
#
# Resolve by OVERLAP with [bucket, bucket+0x100) instead, and name a
# multi-function bucket "A|B|C" so a straddle is visible rather than silently
# collapsed onto one name. 256B is still coarser than a function (a SAB bucket
# routinely spans 5-12 entry points); the exact fix is a finer mask at
# dolphin_render_probe.js:614 (`const b = (pc & ~0xFF) >>> 0;`).
BUCKET = 0x100


def label(bucket):
    """Names of every mapped symbol overlapping [bucket, bucket+BUCKET)."""
    names = []
    pc = bucket
    while pc < bucket + BUCKET:
        r = syms.find(pc)
        if r is None:
            pc += 4
            continue
        if not names or names[-1] != r[0]:
            names.append(r[0])
        pc += max(4, r[2] - r[1])   # jump to the end of this symbol
    return names


byfn = Counter()
unresolved = 0
straddled = 0
for bucket, cnt in bybucket.items():
    names = label(bucket)
    if not names:
        byfn["(unresolved 0x%08x)" % bucket] += cnt
        unresolved += cnt
    else:
        if len(names) > 1:
            straddled += cnt
        byfn["|".join(names)] += cnt

seg_note = ("segs %s" % (",".join(str(s) for s in segs_used) or "none")) if (
    seg_min or seg_max < (1 << 30)) else "all segs"
print("# %s  %d samples  [%s]  (%d symbols loaded, %.1f%% unresolved, "
      "%.1f%% in buckets spanning >1 symbol)  top %d by function:"
      % (syms.game, total, seg_note, len(syms.syms),
         100.0 * unresolved / max(1, total),
         100.0 * straddled / max(1, total), topn))
for name, cnt in byfn.most_common(topn):
    print("  %5.1f%%  %s" % (100.0 * cnt / max(1, total), name))

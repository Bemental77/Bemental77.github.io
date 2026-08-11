#!/usr/bin/env python3
"""annotate_pc_hist.py — render the probe's guest-PC sample histogram by symbol
name (the ledger-by-name readout, STEP 0 sub-step 3).

Reads /tmp/wasm_pc_hist.json (produced by PROBE_PC_SAMPLE=1) and aggregates the
256B buckets BY FUNCTION via gc_symbols, keyed to the game by ROM_IDX.

Usage:  ROM_IDX=1 python3 gamecube/tools/annotate_pc_hist.py [hist.json]
        TOPN=40 ROM_IDX=0 python3 gamecube/tools/annotate_pc_hist.py
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

syms = Symbols(rom)
if not os.path.exists(path):
    print("no histogram at %s (run with PROBE_PC_SAMPLE=1 first)" % path)
    sys.exit(1)

data = json.load(open(path))
bybucket = Counter()
total = 0
for sg in data:
    if not sg:
        continue
    for entry in sg.get("hist", []):
        bucket, cnt = entry[0], entry[1]
        bybucket[bucket] += cnt
        total += cnt

# Aggregate by FUNCTION for a clean ledger; track unresolved separately.
byfn = Counter()
unresolved = 0
for bucket, cnt in bybucket.items():
    r = syms.find(bucket)
    if r:
        byfn[r[0]] += cnt
    else:
        byfn["(unresolved 0x%08x)" % bucket] += cnt
        unresolved += cnt

print("# %s  %d samples  (%d symbols loaded, %.1f%% unresolved)  top %d by function:"
      % (syms.game, total, len(syms.syms), 100.0 * unresolved / max(1, total), topn))
for name, cnt in byfn.most_common(topn):
    print("  %5.1f%%  %s" % (100.0 * cnt / max(1, total), name))

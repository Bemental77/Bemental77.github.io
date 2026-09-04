#!/usr/bin/env python3
"""annotate_pc_hist.py — render the probe's guest-PC sample histogram by symbol
name (the ledger-by-name readout, STEP 0 sub-step 3).

Reads /tmp/wasm_pc_hist.json (produced by PROBE_PC_SAMPLE=1) and aggregates the
sampler's PC buckets BY FUNCTION via gc_symbols, keyed to the game by ROM_IDX.

Bucket width comes from the artifact itself (`{"bucket": N, "segs": [...]}`,
written by dolphin_render_probe.js since 2026-09-04). An older artifact is a
bare array with no width recorded; those are 256B and are read as such. At the
current default of 4B the "bucket" is the exact guest PC and no sample straddles
a function boundary.

Every sample is accounted for in one of three classes, printed in the header:
  named      — a real symbol from tools/<game>_xref.map (or the MP4 decomp map)
  recovered  — a `fn_<addr>` boundary recovered from the DOL by gc_funcmap.py.
               A rankable identity, NOT a claimed name.
  unresolved — outside every text section of the DOL: `.rel` overlay code loaded
               at runtime, or a PC that is not guest code at all.

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
# New artifacts are {"bucket": N, "segs": [...]}; older ones are a bare array of
# segments with an implicit 256B bucket.
if isinstance(data, dict):
    BUCKET = int(data.get("bucket", 0x100))
    data = data.get("segs", [])
else:
    BUCKET = 0x100
seg_split = os.environ.get("SEG_SPLIT") == "1"
bybucket = Counter()
per_seg = {}          # seg -> Counter(bucket)
total = 0
segs_used = []
for i, sg in enumerate(data):
    if not sg:
        continue
    seg = sg.get("seg", i)
    if seg < seg_min or seg > seg_max:
        continue
    segs_used.append(seg)
    ps = per_seg.setdefault(seg, Counter())
    for entry in sg.get("hist", []):
        bucket, cnt = entry[0], entry[1]
        bybucket[bucket] += cnt
        ps[bucket] += cnt
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
# collapsed onto one name.
#
# [2026-09-04] The residual straddle is now a sampler setting, not a resolver
# limitation: dolphin_render_probe.js records PC_BUCKET-wide buckets and defaults
# to 4B (exact PC). A 256B artifact recorded before that change still straddles
# and still prints "A|B|C"; that is the artifact's resolution, not the map's.


def label(bucket):
    """Names of every symbol/function overlapping [bucket, bucket+BUCKET),
    plus the provenance ('named' beats 'recovered' if the bucket mixes both)."""
    names = []
    kinds = set()
    pc = bucket
    while pc < bucket + BUCKET:
        r = syms.find(pc)
        if r is None:
            pc += 4
            continue
        kinds.add(syms.kind(pc))
        if not names or names[-1] != r[0]:
            names.append(r[0])
        pc += max(4, r[2] - r[1])   # jump to the end of this symbol
    for k in ("named", "xmatch", "recovered"):
        if k in kinds:
            return names, k
    return names, "none"


byfn = Counter()
byclass = Counter()
straddled = 0
for bucket, cnt in bybucket.items():
    names, kind = label(bucket)
    if not names:
        byfn["(unresolved 0x%08x)" % bucket] += cnt
        byclass["unresolved"] += cnt
    else:
        if len(names) > 1:
            straddled += cnt
        byclass[kind] += cnt
        byfn["|".join(names)] += cnt

seg_note = ("segs %s" % (",".join(str(s) for s in segs_used) or "none")) if (
    seg_min or seg_max < (1 << 30)) else "all segs"
pct = lambda k: 100.0 * byclass[k] / max(1, total)   # noqa: E731
print("# %s  %d samples  [%s]  bucket=%dB  (%d named symbols + %d recovered "
      "functions)" % (syms.game, total, seg_note, BUCKET,
                      len(syms.named), len(syms.funcs)))
print("#   attribution: %.1f%% named  %.1f%% xmatch(96%% precise)  "
      "%.1f%% recovered-boundary  %.1f%% UNRESOLVED (outside DOL .text)  |  "
      "%.1f%% in buckets spanning >1 function"
      % (pct("named"), pct("xmatch"), pct("recovered"), pct("unresolved"),
         100.0 * straddled / max(1, total)))
print("# top %d by function:" % topn)
for name, cnt in byfn.most_common(topn):
    print("  %5.1f%%  %s" % (100.0 * cnt / max(1, total), name))

# ---------------------------------------------------------------------------
# SEG_SPLIT=1 — the per-segment ledger. THIS IS NOT OPTIONAL POLISH.
#
# A 75s SAB run is not one workload: segment 1 is `__start` relocating the
# image, 2-3 are a DVD load, 4+ are the scene. Pooling them produces a ranking
# of a phase mixture that no scene ever exhibits, and it is NOT reproducible —
# the frame-governor loop fn_80117df8 measured 14.9% pooled on 2026-09-01 and
# 0.1% pooled on 2026-09-04 from the same build, because the two runs spent
# their middle segments in different phases. Read the per-segment column before
# quoting any share, and quote a steady-phase segment range, not the pool.
# ---------------------------------------------------------------------------
if seg_split and per_seg:
    order = sorted(per_seg)
    seg_fn = {}
    seg_tot = {}
    for s in order:
        c = Counter()
        t = 0
        for bucket, cnt in per_seg[s].items():
            names, _k = label(bucket)
            c["|".join(names) if names else "(unresolved)"] += cnt
            t += cnt
        seg_fn[s] = c
        seg_tot[s] = t
    top = [n for n, _ in byfn.most_common(topn)]
    print("\n# per-segment share (10s each). A row that is flat across the "
          "steady segments is a workload item; a row that spikes in one "
          "segment is a phase.")
    print("#   %s   function" % " ".join("s%-5d" % s for s in order))
    print("#   %s   (segment sample counts)"
          % " ".join("%-6d" % seg_tot[s] for s in order))
    for n in top:
        row = " ".join("%-6.1f" % (100.0 * seg_fn[s].get(n, 0) / max(1, seg_tot[s]))
                       for s in order)
        print("    %s   %s" % (row, n))

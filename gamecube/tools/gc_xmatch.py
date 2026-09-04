#!/usr/bin/env python3
"""gc_xmatch.py — name a target game's recovered functions by CONTENT-matching
them against MP4's decomp, which is the only GameCube binary on this box with a
complete symbol table AND the bytes to go with it.

RELATION TO THE EXISTING TOOLS
------------------------------
* `gamecube/tools/cross_ref_expand.py` matches by LAYOUT: from an already-named
  anchor it walks MP4's contiguous address order and places each neighbour at
  the same delta. It stops at the first byte mismatch, so it only ever reaches
  functions the linker happened to place next to an anchor. It found 441 for SAB.
* This matches by CONTENT: every recovered SAB function is fingerprinted and
  looked up against every MP4 function, so a shared SDK function is found no
  matter where either linker put it, and with no anchor needed.

The fingerprint masks the fields that legitimately differ between two links of
the same source — branch displacements, d-form/`addi` immediates (r13/r2-relative
offsets move with the SDA base) — and keeps everything else. To keep that masking
from generating false positives:
  * a candidate must have >= --min-instrs instructions,
  * the masked word sequence must match EXACTLY, and
  * the fingerprint must be UNIQUE on the MP4 side; a fingerprint shared by two
    differently-named MP4 functions names nothing.

PRECISION IS MEASURED, NOT ASSUMED. `--check` scores the matcher against the
functions the target map ALREADY names: every such function is a labelled
example, so agreement/disagreement is a real precision number rather than a
claim. Run it before believing any name this tool adds.

Usage:
  ROM_IDX=1 python3 gamecube/tools/gc_xmatch.py --check
  ROM_IDX=1 python3 gamecube/tools/gc_xmatch.py --out tools/gsne8p_xmatch.map
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gc_funcmap import (ROMS, REPO, load_rom, dol_base, text_sections, Text,   # noqa: E402
                        load_map, recover, collect_seeds, entry_point)

REF = 0   # MP4/GMPE01 — the reference decomp


def mask(w):
    """Zero the fields that differ between two links of the same source.

    Same intent as cross_ref_expand.py:mask(), kept as its own copy so the two
    tools can be changed independently (this one masks whole-function sequences,
    that one masks 10-word prologues).
    """
    op = w >> 26
    if op == 18:                       # b/bl — displacement is link-dependent
        return w & 0xFC000003
    if op == 16:                       # bc — displacement
        return w & 0xFFFF0003
    if op in (14, 15, 24, 25, 26, 27, 28, 29):     # addi/addis/ori/.. immediate
        return w & 0xFFFF0000
    if 32 <= op <= 61:                 # d-form loads/stores + psq_* — offset
        return w & 0xFFFF0000
    return w


def fingerprints(text, funcs, min_instrs):
    """{fingerprint: [(addr, name_or_None, nwords)]}"""
    out = {}
    for (a, sz, kind) in funcs:
        n = sz // 4
        if n < min_instrs:
            continue
        ws = []
        ok = True
        for i in range(n):
            w = text.w(a + 4 * i)
            if w is None:
                ok = False
                break
            ws.append(mask(w))
        if not ok:
            continue
        out.setdefault(tuple(ws), []).append((a, n))
    return out


def build(rom_idx, min_instrs):
    cfg = ROMS[rom_idx]
    rom = load_rom(cfg["bin"])
    base = dol_base(rom, cfg["kind"])
    text = Text(rom, text_sections(rom, base))
    nm = load_map(os.path.join(REPO, cfg["name_map"])) if cfg["name_map"] else []
    seeds, _, _ = collect_seeds(text, entry_point(rom, base), [a for a, _, _ in nm])
    funcs = recover(text, seeds)
    return cfg, text, funcs, {a: n for a, _, n in nm}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rom", type=int,
                    default=int(os.environ.get("ROM_IDX", "1")))
    ap.add_argument("--min-instrs", type=int, default=8,
                    help="skip functions shorter than this (masking makes short "
                         "sequences collide; 8 was chosen by --check)")
    ap.add_argument("--check", action="store_true",
                    help="score against the target map's existing names")
    ap.add_argument("--out", help="write a merged CodeWarrior map here")
    args = ap.parse_args()

    if args.rom == REF:
        print("rom 0 IS the reference — nothing to match against", file=sys.stderr)
        return 1

    rcfg, rtext, rfuncs, rnames = build(REF, args.min_instrs)
    ref_fp = {}
    for fp, lst in fingerprints(rtext, rfuncs, args.min_instrs).items():
        names = set(rnames.get(a) for a, _ in lst) - {None}
        if len(names) == 1:            # unique on the reference side
            ref_fp[fp] = (names.pop(), lst[0][1])
    print("# reference %s: %d functions, %d unambiguous fingerprints "
          "(>=%d instrs)" % (rcfg["game"], len(rfuncs), len(ref_fp),
                             args.min_instrs), file=sys.stderr)

    tcfg, ttext, tfuncs, tnames = build(args.rom, args.min_instrs)
    hits = {}
    for fp, lst in fingerprints(ttext, tfuncs, args.min_instrs).items():
        r = ref_fp.get(fp)
        if not r:
            continue
        for (a, n) in lst:
            hits[a] = (r[0], n * 4)
    print("# target %s: %d recovered functions, %d content-matched to %s"
          % (tcfg["game"], len(tfuncs), len(hits), rcfg["game"]), file=sys.stderr)

    if args.check:
        agree = disagree = 0
        bad = []
        for a, (nm, _sz) in hits.items():
            if a in tnames:
                if tnames[a] == nm:
                    agree += 1
                else:
                    disagree += 1
                    bad.append((a, tnames[a], nm))
        labelled = agree + disagree
        print("CHECK against the %d names already in %s:"
              % (len(tnames), tcfg["name_map"]))
        print("  %d matched functions overlap a known name" % labelled)
        print("  agree    : %d" % agree)
        print("  disagree : %d  (%.2f%% precision on labelled examples)"
              % (disagree, 100.0 * agree / max(1, labelled)))
        for a, was, now in bad[:20]:
            print("    0x%08x  map says %-28s  xmatch says %s" % (a, was, now))
        new = sum(1 for a in hits if a not in tnames)
        print("  NEW names this would add: %d" % new)
        return 0

    if args.out:
        merged = dict(tnames)
        for a, (nm, _sz) in hits.items():
            merged.setdefault(a, nm)
        sizes = {a: sz for a, sz, _ in tfuncs}
        lines = [".text section layout"]
        for a in sorted(merged):
            sz = sizes.get(a)
            if sz is None:
                r = [x for x in tfuncs if x[0] <= a < x[0] + x[1]]
                sz = (r[0][0] + r[0][1] - a) if r else 4
            src = "xref" if a in tnames else "xmatch"
            lines.append("  %08x %08x %08x 00000000  %s\t%s" % (a, sz, a, merged[a], src))
        with open(os.path.join(REPO, args.out) if not os.path.isabs(args.out)
                  else args.out, "w") as f:
            f.write("\n".join(lines) + "\n")
        print("wrote %s (%d names: %d existing + %d new)"
              % (args.out, len(merged), len(tnames), len(merged) - len(tnames)),
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

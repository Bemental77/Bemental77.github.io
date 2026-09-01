#!/usr/bin/env python3
"""coverage_census.py — EVERY-BLOCKER census for the SAB static recompiler.

`sr.py --coverage` reports the FIRST blocker per function, which under-counts: a
function whose first blocker is a `blrl` may also contain an `mtspr`, and one
whose first blocker is privileged may be otherwise clean.  This walks every
instruction of every mapped function with the same Translator, catching
Untranslatable PER INSTRUCTION, and buckets each blocker into one of four
policy classes:

  INDIRECT   blrl / bctr / bctrl        -- a SOLVED dispatch problem upstream
                                          (N64Recomp LOOKUP_FUNC, recomp.h:450;
                                          jump tables, analysis.cpp:229-334).
                                          Needs an address->function table, not
                                          a new translator capability.
  PRIVILEGED mfspr/mtspr/mfmsr/mtmsr/rfi/sc/cache ops
                                       -- the DEVICE/OS boundary.  Bound to host
                                          implementations by ADDRESS, the same
                                          mechanism MP4's decomp route used by
                                          not compiling OSThread.c in.
  TARGET     a linking/tail branch to an address the symbol map does not call a
             function start -- a BOUNDARY-RECOVERY gap, not a semantics gap.
  GAP        anything else -- a genuine translator hole that must be written.

It then reports coverage under cumulative policies, weighted BOTH by function
count and by instruction count, because the two disagree sharply on this image.

Usage:
  python3 coverage_census.py --image main.dol --map dolphin_captures/sab.map \
                             [--json out.json]
"""
import argparse, collections, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sr import (Image, Translator, Untranslatable, load_map,  # noqa: E402
                recover_boundaries)

PRIV_PREFIXES = ('mfspr', 'mtspr', 'mfmsr', 'mtmsr', 'rfi', 'sc',
                 'cache/sync/trap', 'eciwx', 'ecowx', 'tlb')
INDIRECT_WHYS = ('blrl', 'bctr/bctrl')

# sr.py reports an unimplemented opcode-31 extended op as the bare number, so the
# raw reason string cannot be classified without decoding it.  PowerPC 750CL
# (Gekko) User's Manual, opcode 31 X-form secondary opcodes.  Supervisor/cache/
# device ops are the HOST BOUNDARY, not translator holes; ordinary user-mode
# instructions are genuine GAPs and are named so they can be written.
OP31 = {
    # --- supervisor / cache / device: the host boundary ---
    83: ('mfmsr', 'PRIVILEGED'), 146: ('mtmsr', 'PRIVILEGED'),
    210: ('mtsr', 'PRIVILEGED'), 242: ('mtsrin', 'PRIVILEGED'),
    595: ('mfsr', 'PRIVILEGED'), 659: ('mfsrin', 'PRIVILEGED'),
    306: ('tlbie', 'PRIVILEGED'), 566: ('tlbsync', 'PRIVILEGED'),
    370: ('tlbia', 'PRIVILEGED'), 371: ('mftb', 'PRIVILEGED'),
    854: ('eieio', 'PRIVILEGED'), 598: ('sync', 'PRIVILEGED'),
    982: ('icbi', 'PRIVILEGED'), 1014: ('dcbz', 'PRIVILEGED'),
    470: ('dcbi', 'PRIVILEGED'), 54: ('dcbst', 'PRIVILEGED'),
    86: ('dcbf', 'PRIVILEGED'), 246: ('dcbtst', 'PRIVILEGED'),
    278: ('dcbt', 'PRIVILEGED'), 4: ('tw', 'PRIVILEGED'),
    310: ('eciwx', 'PRIVILEGED'), 438: ('ecowx', 'PRIVILEGED'),
    # --- ordinary user-mode instructions sr.py has not implemented: real GAPs ---
    55: ('lwzux', 'GAP'), 119: ('lbzux', 'GAP'), 311: ('lhzux', 'GAP'),
    375: ('lhaux', 'GAP'), 183: ('stwux', 'GAP'), 247: ('stbux', 'GAP'),
    439: ('sthux', 'GAP'),
    567: ('lfsux', 'GAP'), 631: ('lfdux', 'GAP'),
    695: ('stfsux', 'GAP'), 759: ('stfdux', 'GAP'),
    533: ('lswx', 'GAP'), 597: ('lswi', 'GAP'),
    661: ('stswx', 'GAP'), 725: ('stswi', 'GAP'),
    790: ('lhbrx', 'GAP'), 534: ('lwbrx', 'GAP'),
    918: ('sthbrx', 'GAP'), 662: ('stwbrx', 'GAP'),
    20: ('lwarx', 'GAP'), 150: ('stwcx.', 'GAP'),
}


def decode_reason(why):
    """(display name, class).  Resolves sr.py's bare `op31 xo=N` reasons."""
    if why.startswith(INDIRECT_WHYS):
        return why, 'INDIRECT'
    if why.startswith(PRIV_PREFIXES):
        return why, 'PRIVILEGED'
    if why.startswith('branch target') or why.startswith('absolute'):
        return why, 'TARGET'
    if why.startswith('op31 xo='):
        try:
            xo = int(why.split('=')[1].split()[0])
        except (ValueError, IndexError):
            return why, 'GAP'
        if xo in OP31:
            mn, cls = OP31[xo]
            return f"{why} ({mn})", cls
        return f"{why} (unknown op31)", 'GAP'
    # opcode-4 paired-single: xo=1014 xo5=22 is dcbz_l, a cache op = host boundary
    if 'op4 xo=1014' in why:
        return f"{why} (dcbz_l)", 'PRIVILEGED'
    return why, 'GAP'


def classify(why):
    return decode_reason(why)[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', required=True)
    ap.add_argument('--map', required=True)
    ap.add_argument('--json')
    ap.add_argument('--boundaries', default='asis',
                    choices=['asis', 'clip', 'outer', 'outer+calls'],
                    help='function-boundary recovery policy; see sr.recover_boundaries')
    ap.add_argument('--indirect', action='store_true',
                    help='translate blrl/bctr/bctrl through sr_indirect() -- turns the '
                         'P1 row from a modelled policy into what the emitter really does')
    a = ap.parse_args()

    img = Image.from_dol(a.image)
    syms = load_map(a.map)

    # Boundary recovery lives in sr.recover_boundaries() so the census and the
    # EMITTER cannot drift apart -- they must agree on what a function is.
    units = recover_boundaries(img, syms, a.boundaries, log=print)
    starts = {lo for lo, _, _ in units}

    # Pass 2 — walk every instruction, recording EVERY blocker.
    fns = []           # (lo, size, name, {class: count})
    why_counter = collections.Counter()
    class_instr = collections.Counter()
    for lo, size, name in units:
        t = Translator(img, lo, lo + size, starts=starts, indirect=a.indirect)
        cls = collections.Counter()
        for pc in range(lo, lo + size, 4):
            w = img.word(pc)
            if w is None:
                cls['GAP'] += 1
                why_counter['address not in image'] += 1
                class_instr['GAP'] += 1
                continue
            try:
                t.inst(pc, w)
            except Untranslatable as e:
                k = classify(e.why)
                cls[k] += 1
                why_counter[decode_reason(e.why.split('(')[0].strip())[0]] += 1
                class_instr[k] += 1
            except Exception as e:            # a crash is a GAP, recorded honestly
                cls['GAP'] += 1
                why_counter[f'EXCEPTION {type(e).__name__}'] += 1
                class_instr['GAP'] += 1
        fns.append((lo, size, name, dict(cls)))

    ninstr = sum(s // 4 for _, s, _, _ in fns)
    rows = []

    def cover(allowed):
        """functions & instructions with NO blocker outside `allowed`."""
        f = i = 0
        for lo, size, name, cls in fns:
            if all(k in allowed for k in cls):
                f += 1
                i += size // 4
        return f, i

    policies = [
        ('P0 strict (today)', set()),
        ('P1 + indirect dispatch', {'INDIRECT'}),
        ('P2 + host/privileged stubs', {'INDIRECT', 'PRIVILEGED'}),
        ('P3 + boundary recovery', {'INDIRECT', 'PRIVILEGED', 'TARGET'}),
        ('P4 + translator gaps closed', {'INDIRECT', 'PRIVILEGED', 'TARGET', 'GAP'}),
    ]
    print(f"mapped functions in image : {len(fns)}")
    print(f"mapped instructions       : {ninstr}")
    print()
    print(f"{'policy':32s} {'functions':>18s} {'instructions':>20s}")
    for label, allowed in policies:
        f, i = cover(allowed)
        rows.append(dict(policy=label, functions=f, functions_pct=100.0 * f / len(fns),
                         instructions=i, instructions_pct=100.0 * i / ninstr))
        print(f"{label:32s} {f:6d} ({100.0*f/len(fns):6.2f}%) "
              f"{i:9d} ({100.0*i/ninstr:6.2f}%)")

    # per-class function counts (a function can be in several)
    print("\nfunctions containing at least one blocker of each class:")
    per_class = collections.Counter()
    per_class_i = collections.Counter()
    for lo, size, name, cls in fns:
        for k in cls:
            per_class[k] += 1
            per_class_i[k] += size // 4
    for k in ('INDIRECT', 'PRIVILEGED', 'TARGET', 'GAP'):
        print(f"  {k:11s} {per_class[k]:5d} functions  "
              f"{per_class_i[k]:7d} instrs in those functions  "
              f"{class_instr[k]:6d} blocking instructions")

    print("\nblocking INSTRUCTIONS by reason (every occurrence, not first-per-fn):")
    for r, c in why_counter.most_common(45):
        print(f"  {c:7d}  {classify(r):11s} {r}")

    gap_whys = {r: c for r, c in why_counter.items() if classify(r) == 'GAP'}
    print(f"\nGENUINE TRANSLATOR GAPS: {sum(gap_whys.values())} instructions, "
          f"{len(gap_whys)} distinct forms")
    for r, c in sorted(gap_whys.items(), key=lambda x: -x[1]):
        print(f"  {c:7d}  {r}")

    if a.json:
        json.dump(dict(image=os.path.basename(a.image), map=os.path.basename(a.map),
                       functions=len(fns), instructions=ninstr, policies=rows,
                       per_class={k: dict(functions=per_class[k],
                                          instructions_in_those_functions=per_class_i[k],
                                          blocking_instructions=class_instr[k])
                                  for k in ('INDIRECT', 'PRIVILEGED', 'TARGET', 'GAP')},
                       reasons={r: dict(count=c, cls=classify(r))
                                for r, c in why_counter.most_common()}),
                  open(a.json, 'w'), indent=1)
        print(f"\nwrote {a.json}")


if __name__ == '__main__':
    main()

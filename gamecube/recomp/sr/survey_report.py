#!/usr/bin/env python3
"""survey_report.py — what a fixture survey actually PROVES, with denominators.

A survey produces two numbers that are easy to conflate and must not be:
  * how many functions were CAPTURED, and
  * how many were VERIFIED bit-exact.
Only the second is evidence, and it is only evidence for the SHAPES it covers.
This tool reports both against explicit denominators, and -- the part that is not
bookkeeping -- it proves MECHANICALLY that the indirect-dispatch paths were really
taken, rather than assuming that a fixture whose body contains a `blrl` executed one.

THE PROOF FOR `blrl`, restated from README §5b so it can be run instead of written:
  a fixture records `entered` (the function starts its trace actually reached) and
  `n_calls`.  Compute the set of functions reachable from the entry through DIRECT
  `bl` edges only.  Any address in `entered` outside that set can ONLY have been
  reached through an indirect branch, so `sr_indirect()` resolved a real function
  pointer.  That is a statement about the CAPTURED TRACE, not about the emitted code,
  so it holds regardless of how the replay build was configured.

THE PROOF FOR `bctr` is different and cannot be done offline: a recovered jump table
is exercised only if the trace executed the `bctr`, which `bctr_executed` records --
and the pass must then be paired with a CONTROL build emitted `--indirect` WITHOUT
`--jumptables`, in which that same fixture must FAIL with an `0xE1......` fault.
This tool lists the fixtures that qualify so the control arm can be run on exactly
them; it does not credit them on its own.

  python3 gamecube/recomp/sr/survey_report.py <survey.json> [--image ...] [--map ...]
"""
import argparse, collections, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sr        # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    '..', '..', '..'))
LC_LO, LC_HI = 0xE0000000, 0xE0040000


def direct_closure(img, byaddr, entry, indirect=False, jumptables=False):
    """Function starts reachable from `entry` through DIRECT call/tail edges only."""
    seen, work = set(), [entry]
    while work:
        x = work.pop()
        if x in seen or x not in byaddr:
            continue
        seen.add(x)
        t = sr.Translator(img, x, x + byaddr[x][0], starts=set(byaddr),
                          indirect=indirect, jumptables=jumptables)
        try:
            t.translate()
        except sr.Untranslatable:
            continue
        work += list(t.calls)
    return seen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('survey')
    ap.add_argument('--image', default='/tmp/sr_sab/main.dol')
    ap.add_argument('--map', default=os.path.join(REPO, 'dolphin_captures/sab.map'))
    ap.add_argument('--boundaries', default='outer+calls')
    ap.add_argument('--bctr-out', help='write the bctr-executing entries here, one hex '
                                       'address per line, for the control arm')
    ap.add_argument('--bctr-json', help='write the usable bctr-executing fixtures as '
                                        'their own survey JSON, for the control arm')
    ap.add_argument('--hot', default='/tmp/sab_hot.json',
                    help='profile_map.py output, to report whether the captured set '
                         'overlaps the MEASURED hot path or only what was capturable')
    a = ap.parse_args()

    j = json.load(open(a.survey))
    fx = j["fixtures"]
    img = sr.Image.from_dol(a.image)
    byaddr = {lo: (sz, nm) for lo, sz, nm
              in sr.recover_boundaries(img, sr.load_map(a.map), a.boundaries)}

    n_armed = j.get("n_armed") or len(j.get("executed", []))
    print(f"ARMED    {n_armed}")
    print(f"EXECUTED {len(j.get('executed', []))} of {n_armed} armed entries ran in "
          f"this scene")
    print(f"CAPTURED {len(fx)}    REFUSED {len(j.get('refused', []))}")
    rr = collections.Counter()
    for r in j.get("refused", []):
        w = r["why"]
        rr["never executed in this scene" if "never executed" in w
           else ("executed during enumeration but not again in its wave"
                 if "not again within" in w else w.split(":")[0])] += 1
    for k, v in rr.most_common(10):
        print(f"   refused {v:5d}  {k}")

    usable = [f for f in fx if f.get("usable") is not False]
    print(f"\nUSABLE   {len(usable)} of {len(fx)} captured")
    bad = collections.Counter(f.get("unusable_reason") or "?"
                              for f in fx if f.get("usable") is False)
    for k, v in bad.most_common(10):
        print(f"   unusable {v:4d}  {k}")

    print("\nSHAPE COVERAGE of the captured set")
    for k, v in collections.Counter(f.get("shape") for f in fx).most_common():
        nu = sum(1 for f in fx if f.get("shape") == k and f.get("usable") is not False)
        print(f"   {k:34s} captured {v:3d}  usable {nu:3d}")

    lc = [f for f in fx if (f.get("locked_cache") or {}).get("kind")
          or any(LC_LO <= int(k, 16) < LC_HI for k in f.get("initial_mem", {}))]
    print(f"\nLOCKED-CACHE (0xE00000xx) TOUCHED by {len(lc)} of {len(fx)} captures")
    om = [f for f in fx if f.get("outside_mem1")]
    print(f"OUTSIDE MEM1 (WPAR etc.)     touched by {len(om)} of {len(fx)} captures")

    # ------------------------------------------------ indirect-dispatch evidence
    print("\nINDIRECT DISPATCH, PROVEN FROM THE CAPTURED TRACE")
    print("  (a function `entered` that no chain of DIRECT bl edges can reach was")
    print("   reached through blrl/bctr -- so sr_indirect resolved a real pointer)")
    n_blrl = n_proof = 0
    for f in fx:
        if not f.get("blrl_executed"):
            continue
        n_blrl += 1
        entry = f["entry"]
        ent = {int(x, 16) for x in f.get("entered", [])}
        dc = direct_closure(img, byaddr, entry)
        only_ind = sorted(ent - dc)
        if only_ind:
            n_proof += 1
            print(f"   {entry:#010x}  blrl x{len(f['blrl_executed'])}  entered "
                  f"{len(ent)} fns, {len(only_ind)} reachable ONLY indirectly: "
                  + ", ".join(f"{x:#010x}" for x in only_ind[:4])
                  + (" ..." if len(only_ind) > 4 else ""))
    print(f"   {n_proof} of {n_blrl} blrl-executing fixtures carry that proof")

    bctr = [f for f in fx if f.get("bctr_executed")]
    print(f"\nJUMP TABLES EXECUTED by {len(bctr)} fixtures "
          f"({sum(1 for f in bctr if f.get('usable') is not False)} usable). "
          f"These are the ONLY ones a --jumptables claim may rest on, and each needs "
          f"the no-jumptables CONTROL ARM to fault.")
    for f in bctr:
        print(f"   {f['entry']:#010x}  bctr x{len(f['bctr_executed'])}  "
              f"usable={f.get('usable')}  sites="
              + ", ".join(f["bctr_executed"][:3]))
    if a.bctr_out and bctr:
        with open(a.bctr_out, "w") as fh:
            for f in bctr:
                fh.write(f"{f['entry']:#010x}\n")
        print(f"   wrote {a.bctr_out}")
    if a.bctr_json and bctr:
        # The CONTROL ARM must run on EXACTLY the fixtures that executed a jump
        # table, and nothing else: a control build in which unrelated fixtures also
        # pass tells you nothing, and one in which they also fail hides the signal.
        sub = dict(j)
        sub["fixtures"] = [f for f in bctr if f.get("usable") is not False]
        sub["subset"] = "fixtures whose captured trace EXECUTED a bctr"
        json.dump(sub, open(a.bctr_json, "w"))
        print(f"   wrote {a.bctr_json} ({len(sub['fixtures'])} usable bctr fixtures)")

    # ------------------------------------------------ is the captured set HOT?
    # README §8.1a: the four fixtures the throughput headline rested on were "not
    # drawn from the hot profile -- none in the top 120".  A survey should be able to
    # say whether it fixed that, so it is measured rather than hoped for.
    if a.hot and os.path.exists(a.hot):
        hot = json.load(open(a.hot))
        byaddr_hot = {r["addr"]: r for r in hot}
        got = [byaddr_hot[f["entry"]] for f in fx if f["entry"] in byaddr_hot]
        gotu = [byaddr_hot[f["entry"]] for f in fx
                if f["entry"] in byaddr_hot and f.get("usable") is not False]
        print(f"\nHOT-PROFILE OVERLAP ({a.hot}, top {len(hot)} functions)")
        print(f"   captured {len(got)} of the top {len(hot)}, "
              f"covering {sum(r['share'] for r in got) * 100:.2f}% of sampled PCs")
        print(f"   usable   {len(gotu)}, covering "
              f"{sum(r['share'] for r in gotu) * 100:.2f}%")
        for r in sorted(got, key=lambda r: -r["share"])[:10]:
            print(f"     {r['addr']:#010x}  {r['share'] * 100:5.2f}%  {r['name']}")

    print("\nDENOMINATORS")
    tot = len(byaddr)
    print(f"   {tot} recovered DOL function boundaries ({a.boundaries})")
    print(f"   {len(j.get('executed', []))} of {n_armed} ARMED entries executed here; "
          f"the armed set is a shape-spread sample, not the whole image")
    print(f"   {len(usable)} usable fixtures = "
          f"{100.0 * len(usable) / tot:.2f}% of the image's functions, BEFORE replay")


if __name__ == '__main__':
    main()

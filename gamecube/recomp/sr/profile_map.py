#!/usr/bin/env python3
"""profile_map.py — turn a measured wasm PC histogram into a HOT-FUNCTION list.

  python3 gamecube/recomp/sr/profile_map.py [--hist <json>] [--image <main.dol>]
                                            [--map <sab.map>] [--out /tmp/sab_hot.json]

WHY THIS EXISTS. Every throughput figure for the static-recomp path has been measured on
whichever functions happened to be capturable as fixtures, and none of them is hot: the
first four quoted in docs/static-recomp-sab §8 do not appear in the top 120 of the real
profile. A performance number taken off non-hot code is not wrong, it is just not about
the workload. This maps the histogram the JIT probe already produces onto the SAME
recovered function boundaries the emitter uses (`sr.recover_boundaries`, outer+calls),
so "which functions actually matter" is derived from a measurement rather than guessed.

The histogram buckets are 256 BYTES WIDE, which is coarser than a function. A bucket that
straddles two functions has its samples split across them in proportion to the covered
bytes; there is no finer information available at that resolution, and the split is
reported rather than hidden. Buckets landing outside every recovered function (overlay
code in the OSAlloc arena, exception vectors) are counted as `unmapped` and printed --
they are not silently dropped into the nearest function.

Input default is the SAB run recorded at
gamecube/docs/sab-frame-governor/wasm_pc_hist_sab_2026-09-01.json, whose own
provenance and reproducing command are in that directory's TASKS.md.
"""
import argparse, collections, json, os, sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sr  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--hist', default=os.path.join(
        REPO, 'gamecube/docs/sab-frame-governor/wasm_pc_hist_sab_2026-09-01.json'))
    ap.add_argument('--image', default='/tmp/sr_sab/main.dol')
    ap.add_argument('--map', default=os.path.join(REPO, 'dolphin_captures/sab.map'))
    ap.add_argument('--boundaries', default='outer+calls')
    ap.add_argument('--out', default='/tmp/sab_hot.json')
    ap.add_argument('--top', type=int, default=120)
    a = ap.parse_args()

    img = sr.Image.from_dol(a.image)
    fns = sr.recover_boundaries(img, sr.load_map(a.map), policy=a.boundaries)
    fns.sort()

    agg = collections.Counter()
    for e in json.load(open(a.hist)):
        if isinstance(e, dict):
            for addr, cnt in e.get('hist', []):
                agg[addr] += cnt
    total = sum(agg.values())
    if not total:
        print('histogram is empty', file=sys.stderr)
        sys.exit(1)

    byfn, unmapped = collections.Counter(), 0
    for base, cnt in agg.items():
        lo_b, hi_b = base, base + 256
        hits = [(lo, sz, nm, min(hi_b, lo + sz) - max(lo_b, lo))
                for lo, sz, nm in fns if lo < hi_b and lo + sz > lo_b]
        if not hits:
            unmapped += cnt
            continue
        span = sum(h[3] for h in hits)
        for lo, sz, nm, w in hits:
            byfn[(lo, sz, nm)] += cnt * w / span

    print(f'samples {total}   unmapped {unmapped} ({100 * unmapped / total:.2f}%)')
    print(f'functions touched {len(byfn)} of {len(fns)} recovered')
    print()
    rows, cum = [], 0.0
    for (lo, sz, nm), c in byfn.most_common(a.top):
        cum += c
        rows.append(dict(addr=lo, size=sz, name=nm, samples=c,
                         share=c / total, cum=cum / total))
        print(f'0x{lo:08x}  {sz:6d}B  {c:9.1f}  {100 * c / total:6.2f}%  '
              f'cum {100 * cum / total:6.2f}%   {nm}')
    json.dump(rows, open(a.out, 'w'), indent=1)
    print(f'\n-> {a.out}')


if __name__ == '__main__':
    main()

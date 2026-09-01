#!/usr/bin/env python3
"""rel_emit.py — emit C for a whole REL overlay's executable section.

  python3 gamecube/recomp/sr/rel_emit.py --iso <sab.iso> --rel stg13D.rel \\
        --out /tmp/sr_rel/stg13D.c [--dol /tmp/sr_slice/main.dol --map dolphin_captures/sab.map]

THE OVERLAY MODEL
  A REL has no load address until OSLink runs, so it is translated against a SYMBOLIC
  module base.  Three kinds of reference come out of the relocation table
  (~/gc_refs/dolsdk2001/src/os/OSLink.c:130-211), and each gets a different treatment:

  * REL24 to the static DOL (imp->id == 0).  OSLink sets offset = 0, so the addend is
    an ABSOLUTE address.  Fully known at translation time — emitted as a direct call
    to the DOL's translated function.  On stg13D these 6,028 call sites collapse to
    only ~385 distinct DOL entry points: the overlay's entire dependency on the static
    image is a small, enumerable API surface.
  * Self references (imp->id == own id): ADDR32 / ADDR16_HA / ADDR16_LO.  Value is
    `own section base + addend`.  The base is a runtime quantity, so these become
    `SR_MODBASE(sec) + addend` — one indirection through a per-module base table that
    OSLink fills in.  Branch targets never need this: an unrelocated branch inside the
    single exec section is already PC-correct in the shipped bytes (measured across
    all 76 overlays: 497,747 internal branches, 0 escaping, 0 absolute, 0 self-REL24).
  * Cross-overlay references: same as self, against the other module's base.

  Nothing here patches code at run time.  The address-materialisation sites are the
  only runtime-variable part, and they are data, not instructions.
"""
import argparse, collections, os, struct, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rel as R      # noqa: E402
import sr            # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--iso', required=True)
    ap.add_argument('--rel', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--dol', default='/tmp/sr_slice/main.dol')
    ap.add_argument('--map', default='dolphin_captures/sab.map')
    ap.add_argument('--max-fns', type=int, default=0)
    a = ap.parse_args()

    dol_starts = set()
    if os.path.exists(a.dol) and os.path.exists(a.map):
        dimg = sr.Image.from_dol(a.dol)
        dol_starts = set(sr.index_functions(dimg, sr.load_map(a.map)))

    disc = R.Disc(a.iso)
    ent = next(f for f in disc.files if f["name"] == a.rel or f["path"].endswith(a.rel))
    m = R.Rel(disc.read_file(ent), ent["path"])
    res = R.translate_module_reach(m, dol_starts=dol_starts)

    exec_idx = {s["idx"]: s["size"] for s in m.exec_sections()}
    va = lambda sec, off: R.MODULE_VBASE + (sec << 24) + off      # noqa: E731
    mod_vbase = lambda mid, sec: (R.MODULE_VBASE + (sec << 24) if mid == m.id
                                  else 0xA0000000 + (mid << 20) + (sec << 12))
    breloc = R.branch_relocs(m, mod_vbase)

    img = sr.Image()
    for i in exec_idx:
        img.segs.append((va(i, 0), m.section_bytes(i)))
    img.segs.sort()

    fns = []
    for (sec, E), v in sorted(res["bodies"].items()):
        lo, hi = va(sec, v["lo"]), va(sec, v["hi"])
        try:
            sr.Translator(img, lo, hi, starts=set(), branch_reloc=breloc).translate()
        except sr.Untranslatable:
            pass
        fns.append((lo, hi - lo, f"{a.rel}:sec{sec}+{E:#x}"))
    fns.sort()

    starts = {va(sec, off) for sec, off in res["entries"]}
    starts |= {va(i, sz) for i, sz in exec_idx.items()}
    starts |= dol_starts | set(breloc.values())

    keep, blocked = [], []
    for lo, size, name in fns:
        try:
            sr.Translator(img, lo, lo + size, starts=starts,
                          branch_reloc=breloc).translate()
            keep.append((lo, size, name))
        except sr.Untranslatable as e:
            blocked.append((lo, size, name, e.why))
    if a.max_fns:
        keep = keep[:a.max_fns]

    src = sr.emit_c(img, keep, starts=starts, branch_reloc=breloc)
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    open(a.out, 'w').write(src)
    ncall = sum(1 for line in src.splitlines() if 'sr_extern(' in line)
    print(f"{ent['path']}: emitted {len(keep)} functions "
          f"({sum(s for _, s, _ in keep) // 4} instructions) -> {a.out} "
          f"({len(src)} bytes)")
    print(f"  blocked (not emitted): {len(blocked)}  "
          + str(collections.Counter(w.split('(')[0].strip() for *_, w in blocked)
                .most_common(5)))
    print(f"  sr_extern() call sites (targets outside this file, i.e. the DOL): {ncall}")


if __name__ == '__main__':
    main()

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


def emit_at_real_base(a, m, ent, res, dimg, dol_by, base):
    """Emit overlay functions at their REAL runtime addresses, together with every DOL
    function they transitively call, into ONE translation unit.

    This is what a differential needs and the symbolic-base path cannot give:
      * the fixture's guest addresses ARE the emitted function addresses, and
      * a `bl` from the overlay into the static DOL resolves to a translated body
        instead of sr_extern(), so `fault == 0` is reachable at all.
    Intra-section branches need no fixup at any base -- they are PC-relative and
    already correct in the shipped bytes (measured across all 76 overlays: 497,747
    internal branches, 0 escaping, 0 absolute, 0 self-REL24).
    """
    execs = m.exec_sections()
    if len(execs) != 1:
        raise SystemExit(f"--base assumes one executable section, got {len(execs)}")
    sec = execs[0]["idx"]
    # THE SHIPPED BYTES ARE NOT WHAT EXECUTES.  OSLink's Relocate()
    # (~/gc_refs/dolsdk2001/src/os/OSLink.c:146-200) patches the image IN PLACE:
    # ADDR32 writes a word, ADDR16_HA/LO/HI rewrite the low half of a lis/addi pair,
    # REL24 rewrites a branch displacement.  rel.py:147 section_bytes() returns the raw
    # FILE bytes, so translating them bakes PLACEHOLDER constants into every address
    # materialisation -- silently, and only an address-materialising function shows it.
    # fixture_rel.py dumps the LIVE relocated section next to its fixtures; use it.
    blob = m.section_bytes(sec)
    if a.live_section:
        live = open(a.live_section, 'rb').read()
        if len(live) != len(blob):
            raise SystemExit(f"--live-section is {len(live)} bytes, section is {len(blob)}")
        diff = sum(1 for i in range(0, len(blob), 4) if live[i:i+4] != blob[i:i+4])
        print(f"[rel_emit] using LIVE relocated section: {diff} of {len(blob)//4} words "
              f"differ from the shipped file (= the OSLink patches)")
        blob = live
    else:
        print("[rel_emit] WARNING: translating RAW FILE BYTES -- every ADDR32/ADDR16_HA "
              "site still holds its unrelocated placeholder.  Pass --live-section for a "
              "differential.", file=sys.stderr)
    va = lambda off: (base + off) & 0xFFFFFFFF                       # noqa: E731
    # Other modules keep a synthetic base; only THIS module is placed for real.
    mod_vbase = lambda mid, s: (base if (mid == m.id and s == sec)
                                else 0xA0000000 + (mid << 20) + (s << 12))  # noqa: E731
    breloc = R.branch_relocs(m, mod_vbase)

    img = sr.Image()
    img.segs.append((base, blob))
    # DATA SECTIONS, RELOCATED.  Without them every `bctr` switch table reads "not in
    # image" and the site falls back to sr_indirect(), which FAULTS when executed --
    # measured on stg13D: 0 of 23 sites recovered without this, 23 of 23 with it.
    # The tables live in sec5 (a 2,620,456-byte file-backed data section) and their
    # entries are R_PPC_ADDR32 relocations, so the RAW file words are placeholders;
    # Rel.relocate() applies OSLink's own Relocate() offline.  That transcription is
    # verified against ground truth: on sec1 it reproduces the live bytes read back
    # out of the machine exactly (377,296 bytes, 18,818 words changed).
    if a.sections:
        # Same synthetic base for any module that is NOT resident as mod_vbase uses,
        # so a cross-overlay reference stays obviously-not-a-real-address instead of
        # crashing the relocation or, worse, landing on a plausible one.
        bases = collections.defaultdict(
            lambda: 0, {(mid, s): 0xA0000000 + (mid << 20) + (s << 12)
                        for mid, r in m.all_relocs() for s in (r["ref_sec"],)
                        if mid not in (0, m.id)})
        bases[(m.id, sec)] = base
        bases.update({(m.id, i): addr for i, (addr, _sz, _x) in a.sections.items()})
        want = [i for i, (_a, _s, ex) in a.sections.items()
                if not ex and i != sec and m.sections[i]["size"]
                and not m.sections[i]["bss"]]
        if want:
            relocated = m.relocate(bases, sections=want)
            for i in want:
                img.segs.append((a.sections[i][0], relocated[i]))
            print(f"[rel_emit] loaded {len(want)} relocated data section(s): "
                  + ", ".join(f"sec{i}@{a.sections[i][0]:#010x} "
                              f"{len(relocated[i])}B" for i in want))
    else:
        print("[rel_emit] WARNING: no section table given (--sections / --entries-from), "
              "so DATA sections are absent from the image and every `bctr` jump table "
              "will refuse to recover.", file=sys.stderr)
    if dimg is not None:
        img.segs += dimg.segs
    img.segs.sort()

    ov_by = {}
    for (s, E), v in res["bodies"].items():
        if s == sec:
            ov_by[va(E)] = (v["hi"] - v["lo"], f"{a.rel}:+{E:#x}")
    byaddr = dict(dol_by)
    byaddr.update(ov_by)
    starts = set(byaddr) | set(breloc.values())

    roots = [int(x, 16) for x in a.entry] or sorted(ov_by)
    missing = [r for r in roots if r not in byaddr]
    if missing:
        raise SystemExit("not a known function start: "
                         + ", ".join(f"{x:#010x}" for x in missing))

    # closure across BOTH images, relocation-aware (sr.closure_of cannot pass breloc)
    seen, work, probs = set(), list(roots), []
    while work:
        x = work.pop()
        if x in seen:
            continue
        seen.add(x)
        if x not in byaddr:
            probs.append((x, "not a known function"))
            continue
        size = byaddr[x][0]
        t = sr.Translator(img, x, x + size, starts=starts, branch_reloc=breloc,
                          indirect=a.indirect, jumptables=a.jumptables)
        try:
            t.translate()
        except sr.Untranslatable as e:
            probs.append((x, e.why))
            continue
        work += list(t.calls)
    if probs:
        for x, why in sorted(set(probs)):
            print(f"CLOSURE BLOCKED at {x:#010x}: {why}", file=sys.stderr)
        raise SystemExit(2)

    fns = sorted((x, byaddr[x][0], byaddr[x][1]) for x in seen)
    src = sr.emit_c(img, fns, starts=starts, branch_reloc=breloc, indirect=a.indirect,
                    jumptables=a.jumptables)
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    open(a.out, 'w').write(src)
    nov = sum(1 for x, _, _ in fns if x in ov_by)
    print(f"{ent['path']} @ {base:#010x}: emitted {len(fns)} functions "
          f"({nov} overlay, {len(fns) - nov} DOL), "
          f"{sum(s for _, s, _ in fns) // 4} instructions -> {a.out}")
    print("  roots: " + ", ".join(f"{r:#010x}" for r in roots))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--iso', required=True)
    ap.add_argument('--rel')
    ap.add_argument('--out', required=True)
    ap.add_argument('--dol', default='/tmp/sr_slice/main.dol')
    ap.add_argument('--map', default='dolphin_captures/sab.map')
    ap.add_argument('--max-fns', type=int, default=0)
    ap.add_argument('--base', help='REAL runtime load address of the executable '
                    'section (hex), as recovered by fixture_rel.py. Without it the '
                    'module is translated against the SYMBOLIC MODULE_VBASE and the '
                    'addresses do not match a captured fixture.')
    ap.add_argument('--entry', action='append', default=[],
                    help='with --base: emit only these RUNTIME addresses and their '
                         'transitive callee closure (overlay AND DOL)')
    ap.add_argument('--entries-from',
                    help='a fixture JSON written by fixture_rel.py: emit exactly the '
                         'functions it captured, and take --base from its rel_base. '
                         'A SURVEY has one root per captured function and transcribing '
                         'them by hand is how a build and its fixtures drift apart.')
    ap.add_argument('--live-section',
                    help='binary dump of the RELOCATED executable section, as written by '
                         'fixture_rel.py alongside its fixtures. Required for a '
                         'differential: without it every address materialisation is a '
                         'placeholder.')
    ap.add_argument('--indirect', action='store_true',
                    help='route blrl/bctr/bctrl through sr_indirect()')
    ap.add_argument('--jumptables', action='store_true',
                    help='static switch-table recovery for `bctr` (sr.Translator.'
                         'recover_jump_table).  Requires --indirect: without it a bctr '
                         'does not translate at all, and with --indirect ALONE it '
                         'translates to sr_indirect() and then FAULTS at run time, '
                         'because a switch case is an address INSIDE a function and '
                         'therefore not a dispatchable entry.  A survey that wants to '
                         'cover the bctr shape needs both.')
    ap.add_argument('--sections-arg', dest='sections_arg', action='append', default=[],
                    help='idx=hexaddr for a module section, repeatable.  Only needed '
                         'when no --entries-from JSON carries rel_sections (which '
                         'fixture_rel.py records from __OSModuleInfoList).  Sizes come '
                         'from the REL header; only the runtime base is unknown.')
    ap.add_argument('--boundaries', default='outer+calls',
                    help='DOL boundary-recovery policy for the callee side')
    a = ap.parse_args()
    a.sections = {}
    if a.entries_from:
        import json
        j = json.load(open(a.entries_from))
        a.sections = {int(k): v for k, v in (j.get("rel_sections") or {}).items()}
        # Emit every CAPTURED function, including the ones verify_fixture.mjs will
        # refuse.  A refusal must print its named reason ("touches addresses outside
        # MEM1", "usable:false"), and it can only do that if the function is IN the
        # build -- otherwise it prints "not in this build", which is a different and
        # misleading claim.
        a.entry += [f"{fx['entry']:#010x}" for fx in j["fixtures"]]
        a.base = a.base or f"{j['rel_base']:#x}"
        a.rel = a.rel or j["rel"]
        if not a.live_section:
            a.live_section = j.get("live_section")
        print(f"[rel_emit] {a.entries_from}: {len(j['fixtures'])} captured function(s), "
              f"rel={a.rel} base={a.base}, live-section={a.live_section}")
    if not a.rel:
        raise SystemExit("--rel is required (or supply it via --entries-from)")
    for spec in a.sections_arg:
        i, addr = spec.split('=')
        a.sections[int(i)] = [int(addr, 16), 0, False]
    if a.jumptables and not a.indirect:
        raise SystemExit("--jumptables requires --indirect (a bctr does not translate "
                         "at all without it)")
    if a.jumptables and not a.base:
        raise SystemExit("--jumptables is only wired into the --base (real-address) "
                         "path; the symbolic path would silently ignore it")

    dol_starts, dol_by, dimg = set(), {}, None
    if os.path.exists(a.dol) and os.path.exists(a.map):
        dimg = sr.Image.from_dol(a.dol)
        dunits = sr.recover_boundaries(dimg, sr.load_map(a.map), a.boundaries)
        dol_by = {lo: (sz, nm) for lo, sz, nm in dunits}
        dol_starts = set(dol_by)

    disc = R.Disc(a.iso)
    ent = next(f for f in disc.files if f["name"] == a.rel or f["path"].endswith(a.rel))
    m = R.Rel(disc.read_file(ent), ent["path"])
    # An overlay calls DOL entry points its own relocation table names but the DOL's
    # call graph never does -- see rel.split_dol_units_for().
    if dimg is not None:
        dunits = R.split_dol_units_for(
            m, [(lo, sz, nm) for lo, (sz, nm) in dol_by.items()], verbose=True)
        dol_by = {lo: (sz, nm) for lo, sz, nm in dunits}
        dol_starts = set(dol_by)
    res = R.translate_module_reach(m, dol_starts=dol_starts)

    if a.base:
        emit_at_real_base(a, m, ent, res, dimg, dol_by, int(a.base, 16))
        return

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

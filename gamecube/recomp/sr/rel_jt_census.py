#!/usr/bin/env python3
"""rel_jt_census.py — RUNTIME-COMPLETENESS census for the 76 `.rel` overlays.

The overlay translatability figure already on record (`rel.py --translatability ALL`:
5,551,313 instructions decoded, 99.9608% clean) is an INSTRUCTION-FORM figure.  It says
every opcode can be modelled.  It does NOT say the module can execute, because under
`--indirect` a `bctr` *translates* -- into `sr_indirect()` -- and then FAULTS at run
time, since a switch case is an address INSIDE a function and therefore not a
dispatchable entry.  The DOL has the same distinction and it is worth 82.0% vs 99.4%
(gamecube/docs/static-recomp-sab/README.md §5b).

Nobody has ever measured it for the overlays, and the overlays are 93.64% of SAB's
static instructions.  This tool measures it.

WHY IT NEEDS RELOCATION, AND WHY THAT IS THE WHOLE POINT
  A `bctr` jump table is recovered by walking back for `mtctr <- lwzx <- lis/addi`,
  reading the table base out of the `lis`/`addi` pair, and then reading N words of the
  table.  In a REL:
    * the `lis`/`addi` immediates are R_PPC_ADDR16_HA / _LO relocation sites, so the
      SHIPPED bytes hold placeholders -- the recovered base is garbage;
    * the table words are R_PPC_ADDR32 relocation sites in a DATA section, so the
      shipped words are placeholders too;
    * and rel.py's translation image contains only EXECUTABLE sections, so the table
      address is not even in the image.
  All three are fixed by applying OSLink's own Relocate() offline (Rel.relocate(),
  transcribed from ~/gc_refs/dolsdk2001/src/os/OSLink.c:146-201 and VALIDATED against
  377,296 bytes read back out of a running machine) and loading every non-BSS section.

  The census runs BOTH arms -- raw and relocated -- so the difference is measured here
  rather than asserted from the one stg13D data point (0 of 23 -> 23 of 23).

BASE INDEPENDENCE.  A census does not need a real load address.  Relocating with the
SAME symbolic base map that places the sections in the image gives a self-consistent
address space, so "does this table resolve to N in-image, aligned, in-function-or-
function-start targets" is answered identically at any base.  Only an actual
differential needs the real base (rel_emit.py --base).

Usage:
  python3 gamecube/recomp/sr/rel_jt_census.py --iso "<sab.iso>"            # all 76
  python3 gamecube/recomp/sr/rel_jt_census.py --iso ... --rel stg13D.rel   # one
  python3 gamecube/recomp/sr/rel_jt_census.py --iso ... --raw-arm          # + control
"""
import argparse, collections, json, os, struct, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rel as R          # noqa: E402
import sr                # noqa: E402

BCTR_OP, BCTR_XO = 19, 528


def bctr_sites(img, lo, hi):
    """Every `bctr` (not `bctrl`) in [lo, hi)."""
    out = []
    for p in range(lo, hi, 4):
        w = img.word(p)
        if w is None:
            continue
        if (w >> 26) == BCTR_OP and ((w >> 1) & 0x3FF) == BCTR_XO and not (w & 1):
            out.append(p)
    return out


def linear_bctr_count(m):
    """(bctr, bctrl) by a LINEAR scan of every word of every exec section.

    THE DENOMINATOR'S OWN CONTROL.  Reachability bodies overlap, so counting `bctr`
    per body double-counts any site in a shared tail -- the first version of this
    census reported 1,818 sites where a linear scan finds far fewer, and stg13D read
    23 where the truth is 15 (cross-checked independently; `bctrl` = 0).  The
    de-duplicated body-visited count must never EXCEED this, and the shortfall is
    real information: it is `bctr` encodings that no reachability body covers, i.e.
    padding, data-in-code, or genuinely unreached code.
    """
    n = nl = 0
    for s in m.exec_sections():
        b = m.section_bytes(s["idx"])
        for off in range(0, len(b) - 3, 4):
            w = struct.unpack('>I', b[off:off + 4])[0]
            if (w >> 26) == BCTR_OP and ((w >> 1) & 0x3FF) == BCTR_XO:
                if w & 1:
                    nl += 1
                else:
                    n += 1
    return n, nl


def build_image(m, relocated):
    """Symbolic-base image.  `relocated` True = every non-BSS section, OSLink-patched;
    False = executable sections only, raw file bytes (the pre-2026-09-04 behaviour,
    kept as the control arm)."""
    va = lambda i: R.MODULE_VBASE + (i << 24)                      # noqa: E731
    img = sr.Image()
    if not relocated:
        for s in m.exec_sections():
            img.segs.append((va(s["idx"]), m.section_bytes(s["idx"])))
        img.segs.sort()
        return img, None
    # EVERY section index needs a base, including the null section 0 and BSS.
    # Rel.relocate() looks the base up BEFORE it dispatches on relocation type, so a
    # R_DOLPHIN_NOP naming section 0 -- which writes nothing -- still raises.  Four
    # overlays (boss_last1D, CartD, stg18D, stg34D) failed the first census run on
    # exactly that.  BSS and the null section get a base in a DISTINCT high window so
    # that anything actually landing there is obviously not a code address and the
    # jump-table target validation rejects it, rather than accepting a plausible one.
    bases = {}
    for s in m.sections:
        bases[(m.id, s["idx"])] = (va(s["idx"]) if s["size"] and not s["bss"]
                                   else 0xB0000000 + (s["idx"] << 24))
    for mid, r in m.all_relocs():
        if mid not in (0, m.id):
            bases[(mid, r["ref_sec"])] = 0xA0000000 + (mid << 20) + (r["ref_sec"] << 12)
    want = [s["idx"] for s in m.sections if s["size"] and not s["bss"]]
    sec = m.relocate(bases, sections=want)
    for i in want:
        img.segs.append((va(i), sec[i]))
    img.segs.sort()
    return img, sec


def census_one(m, relocated=True, dol_starts=frozenset()):
    """-> dict of counters for one overlay."""
    va = lambda s, o: R.MODULE_VBASE + (s << 24) + o                # noqa: E731
    mod_vbase = lambda mid, s: (R.MODULE_VBASE + (s << 24) if mid == m.id
                                else 0xA0000000 + (mid << 20) + (s << 12))  # noqa: E731
    breloc = R.branch_relocs(m, mod_vbase)
    res = R.translate_module_reach(m, dol_starts=dol_starts)
    img, _ = build_image(m, relocated)

    exec_idx = {s["idx"]: s["size"] for s in m.exec_sections()}
    bodies = {}                        # lo -> (size, sec)
    for (s, E), v in res["bodies"].items():
        bodies[va(s, v["lo"])] = (v["hi"] - v["lo"], s)
    starts = set(bodies)
    starts |= {va(s, o) for s, o in res["entries"]}
    starts |= {va(i, sz) for i, sz in exec_idx.items()}
    starts |= set(breloc.values()) | set(dol_starts)

    out = collections.Counter()
    refused = collections.Counter()
    tgtkind = collections.Counter()
    fn_with, fn_allok = set(), {}
    # ⚠ SITES MUST BE DE-DUPLICATED BY ADDRESS, for the same reason the instruction
    # count must: reachability bodies OVERLAP, so one `bctr` in a shared tail is
    # visited by every body that reaches it.  Counting per body inflated the site
    # total to 1,818 against the 1,195 `bctr/bctrl` that rel.py's LINEAR decode_exec
    # reports over the same sections -- i.e. the per-body figure was 1.52x the truth
    # and both the numerator and the denominator of "99.1% recovered" were wrong.
    # A site's verdict is taken from the FIRST body that contains it; a site whose
    # bodies DISAGREE is counted separately rather than silently resolved.
    site_ok = {}
    for lo, (size, _s) in sorted(bodies.items()):
        sites = bctr_sites(img, lo, lo + size)
        if not sites:
            continue
        out["fn_with_bctr"] += 1
        out["fn_with_bctr_i"] += size // 4
        fn_with.add(lo)
        t = sr.Translator(img, lo, lo + size, starts=starts, branch_reloc=breloc,
                          indirect=True, jumptables=True)
        allok = True
        for p in sites:
            ts = t.recover_jump_table(p)
            first = p not in site_ok
            if first:
                site_ok[p] = ts is not None
                out["sites"] += 1
            elif site_ok[p] != (ts is not None):
                out["site_verdict_disagreed"] += 1
            if ts is None:
                if first:
                    refused[t.jt_refused.get(p, "not attempted")] += 1
                allok = False
                continue
            if first:
                out["recovered"] += 1
                out["targets"] += len(ts)
                for x in ts:
                    tgtkind["inside the same function (label)"
                            if lo <= x < lo + size
                            else ("another function start (tail call)"
                                  if x in starts else "OTHER")] += 1
        fn_allok[lo] = allok
    out["fn_all_resolved"] = sum(1 for v in fn_allok.values() if v)
    out["fn_all_resolved_i"] = sum(bodies[lo][0] // 4
                                   for lo, v in fn_allok.items() if v)
    out["total_fns"] = len(bodies)
    # ⚠ SUMMED BODY SIZES DOUBLE-COUNT.  function_bodies() grows each body by
    # intra-procedural REACHABILITY from a call target, and two entries can share a
    # tail, so the sum over bodies EXCEEDS the executable section itself (measured
    # across the 76 overlays: 6,809,718 summed against 5,551,313 decoded).  The same
    # trap the DOL's own map has (README §3: 9.82% double-counted).  `union_i` is the
    # de-duplicated figure and is the only instruction denominator that may be quoted.
    covered = set()
    blocked_cov = set()
    for lo, (size, s) in bodies.items():
        rng = range(lo, lo + size, 4)
        covered.update(rng)
        if lo in fn_allok and not fn_allok[lo]:
            blocked_cov.update(rng)
    out["union_i"] = len(covered)
    out["union_blocked_i"] = len(blocked_cov)
    out["sum_i"] = sum(sz // 4 for sz, _ in bodies.values())
    lin, linl = linear_bctr_count(m)
    out["linear_bctr"], out["linear_bctrl"] = lin, linl
    if out["sites"] > lin:
        raise AssertionError(
            f"{m.path}: {out['sites']} de-duplicated bctr sites exceeds the "
            f"{lin} a LINEAR scan of the exec sections finds -- the de-duplication "
            f"is broken and the recovery percentage's denominator is wrong")
    out["bctr_not_in_any_body"] = lin - out["sites"]
    return {"c": out, "refused": refused, "tgtkind": tgtkind}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--iso', required=True)
    ap.add_argument('--rel', help='one overlay by file name; default = all')
    ap.add_argument('--raw-arm', action='store_true',
                    help='also run the UNRELOCATED control arm, which is what the '
                         'census would report without OSLink Relocate()')
    ap.add_argument('--dol', default='/tmp/sr_sab/main.dol')
    ap.add_argument('--map', default=None)
    ap.add_argument('--out', default='/tmp/sab_rel_jt_census.json')
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()

    repo = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))))
    dol_starts = frozenset()
    mp = a.map or os.path.join(repo, 'dolphin_captures/sab.map')
    if os.path.exists(a.dol) and os.path.exists(mp):
        dimg = sr.Image.from_dol(a.dol)
        dol_starts = frozenset(lo for lo, _, _ in
                               sr.recover_boundaries(dimg, sr.load_map(mp),
                                                     'outer+calls'))
        print(f"[dol] {len(dol_starts)} DOL function starts (outer+calls)")

    d = R.Disc(a.iso)
    rels = [f for f in d.files if f["name"].lower().endswith('.rel')]
    if a.rel:
        rels = [f for f in rels if f["name"] == a.rel or f["path"].endswith(a.rel)]
        if not rels:
            raise SystemExit(f"no such overlay: {a.rel}")
    if a.limit:
        rels = rels[:a.limit]
    print(f"[census] {len(rels)} overlay(s)")

    arms = [("relocated", True)] + ([("raw", False)] if a.raw_arm else [])
    agg = {k: collections.Counter() for k, _ in arms}
    ref = {k: collections.Counter() for k, _ in arms}
    tk = {k: collections.Counter() for k, _ in arms}
    per = []
    t0 = time.time()
    for n, f in enumerate(rels):
        m = R.Rel(d.read_file(f), f["path"])
        row = {"path": f["path"], "id": m.id}
        for name, rel_on in arms:
            try:
                r = census_one(m, relocated=rel_on, dol_starts=dol_starts)
            except Exception as e:                       # noqa: BLE001
                print(f"  {f['name']:26s} {name:9s} ERROR {type(e).__name__}: {e}")
                row[name] = {"error": f"{type(e).__name__}: {e}"}
                continue
            agg[name].update(r["c"]); ref[name].update(r["refused"])
            tk[name].update(r["tgtkind"])
            row[name] = dict(r["c"])
            row[name + "_refused"] = dict(r["refused"])
        rr = row.get("relocated", {})
        print(f"  [{n+1:2d}/{len(rels)}] {f['name']:26s} "
              f"fns={rr.get('total_fns', 0):5d} bctr_fns={rr.get('fn_with_bctr', 0):4d} "
              f"sites={rr.get('sites', 0):4d} recovered={rr.get('recovered', 0):4d}"
              + (f"  (raw arm: {row['raw'].get('recovered', 0)})" if a.raw_arm
                 and 'raw' in row and 'error' not in row['raw'] else ""),
              flush=True)
        per.append(row)

    print(f"\n[census] {len(rels)} overlays in {time.time() - t0:.1f}s")
    for name, _ in arms:
        c = agg[name]
        print(f"\n=== ARM: {name} ===")
        print(f"  functions (reachability bodies)   : {c['total_fns']}")
        print(f"  instructions, DE-DUPLICATED       : {c['union_i']} "
              f"(summed bodies {c['sum_i']} = "
              f"{100.0 * c['sum_i'] / max(1, c['union_i']) - 100:.1f}% double-counted)")
        print(f"  functions containing a `bctr`     : {c['fn_with_bctr']} "
              f"({c['fn_with_bctr_i']} instructions, summed)")
        print(f"  `bctr` by LINEAR scan (control)   : {c['linear_bctr']} "
              f"(+{c['linear_bctrl']} bctrl); {c['bctr_not_in_any_body']} lie in no "
              f"reachability body")
        print(f"  `bctr` sites, DE-DUPLICATED       : {c['sites']}"
              + (f"   (⚠ {c['site_verdict_disagreed']} site(s) got different verdicts "
                 f"from two overlapping bodies)" if c['site_verdict_disagreed'] else ""))
        pct = (100.0 * c['recovered'] / c['sites']) if c['sites'] else 0.0
        print(f"    jump table RECOVERED            : {c['recovered']} ({pct:.1f}%)")
        print(f"    refused                         : {c['sites'] - c['recovered']}")
        for w, n in ref[name].most_common(20):
            print(f"        {n:7d}  {w}")
        print(f"  case targets recovered            : {c['targets']}")
        for w, n in tk[name].most_common():
            print(f"        {n:7d}  {w}")
        print(f"  functions with EVERY bctr resolved: {c['fn_all_resolved']} "
              f"({c['fn_all_resolved_i']} instructions, summed)")
        if c['union_i']:
            print(f"  RUNTIME-COMPLETE instructions     : "
                  f"{c['union_i'] - c['union_blocked_i']} of {c['union_i']} "
                  f"({100.0 * (c['union_i'] - c['union_blocked_i']) / c['union_i']:.2f}%)"
                  f"   [de-duplicated; a function with ANY unresolved bctr counts as "
                  f"NOT runtime-complete in full]")
    json.dump({"per_overlay": per,
               "aggregate": {k: dict(v) for k, v in agg.items()},
               "refused": {k: dict(v) for k, v in ref.items()},
               "targets": {k: dict(v) for k, v in tk.items()}},
              open(a.out, "w"), indent=1)
    print(f"\n[census] wrote {a.out}")


if __name__ == '__main__':
    main()

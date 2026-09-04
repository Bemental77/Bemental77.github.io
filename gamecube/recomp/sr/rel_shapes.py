#!/usr/bin/env python3
"""rel_shapes.py — classify a REL overlay's function entries by SHAPE, and choose a
survey set that covers the shapes instead of whichever function the frame loop calls
most.

  python3 gamecube/recomp/sr/rel_shapes.py --iso <sab.iso> --rel stg13D.rel \\
        --base 0x811fff48 --live-section <sec.bin> --arm-out /tmp/arm.txt [-n 300]

WHY THIS EXISTS.  The first overlay differential was ONE function.  Turning that into
a survey needs breadth over the shapes that can plausibly break a translator --
leaf vs non-leaf, FP, paired-single, memory-heavy, `blrl`, `bctr` jump tables, x-form
update load/stores -- and NONE of those correlate with the body size the capture rig
used to rank by.  Ranking by hit count is worse: it fills the budget with the handful
of functions the frame loop calls most, which are all the same shape.

TWO THINGS ARE DECIDED HERE, both offline and both cheap:
  * SHAPE, from an opcode census of the body.
  * WHETHER IT CAN BE EMITTED AT ALL -- the entry must translate, and so must its
    whole transitive callee closure across BOTH images (overlay + static DOL).  An
    entry whose closure is blocked cannot be built into a fixture, so arming it wastes
    a capture slot.  Measured on stg13D: 791 of 1,141 entries clear that bar; the
    350 that do not are blocked overwhelmingly by DOL callees using privileged or
    host-boundary instructions (mfmsr, sc, dcbi), not by overlay code.

The selection is round-robin across shape buckets, RAREST BUCKET FIRST, so the two
`bctr` functions and the eight `blrl` ones are never crowded out by the 300-odd
plain non-leaf ones.
"""
import argparse, collections, os, struct, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rel as R      # noqa: E402
import sr            # noqa: E402

# op31 xo -> True if this is the UPDATE form (rA is written back).  The update forms
# are called out separately because they are the ones with a second architectural
# effect to get wrong.
X_LOADS = {23: 0, 55: 1, 87: 0, 119: 1, 279: 0, 311: 1, 343: 0, 375: 1,
           535: 0, 567: 1, 599: 0, 631: 1, 534: 0, 790: 0, 20: 0}
X_STORES = {151: 0, 183: 1, 215: 0, 247: 1, 407: 0, 439: 1, 663: 0, 695: 1,
            727: 0, 759: 1, 662: 0, 918: 0, 150: 0}
D_MEM = {32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47}
D_FP_MEM = {48, 49, 50, 51, 52, 53, 54, 55}


def census(img, lo, size):
    c = collections.Counter()
    for p in range(lo, lo + size, 4):
        w = img.word(p)
        if w is None:
            c["unreadable"] += 1
            continue
        op, xo = w >> 26, (w >> 1) & 0x3FF
        if op == 18 and (w & 1):
            c["bl"] += 1
        elif op == 19 and xo == 16 and (w & 1):
            c["blrl"] += 1
        elif op == 19 and xo == 528:
            c["bctrl" if (w & 1) else "bctr"] += 1
        if op in D_FP_MEM:
            c["fp_mem"] += 1
        elif op in D_MEM:
            c["mem_d"] += 1
        elif op in (56, 57, 60, 61):
            c["psq"] += 1
        elif op in (59, 63):
            c["fp_alu"] += 1
        elif op == 4:
            c["ps"] += 1
        elif op == 31 and (xo in X_LOADS or xo in X_STORES):
            c["xform_mem"] += 1
            if X_LOADS.get(xo) or X_STORES.get(xo):
                c["xform_update"] += 1
    return c


def shape_of(c):
    s = ["nonleaf" if (c.get("bl") or c.get("bctrl") or c.get("blrl")) else "leaf"]
    if c.get("fp_alu") or c.get("fp_mem"):
        s.append("fp")
    if c.get("psq") or c.get("ps"):
        s.append("ps")
    if c.get("xform_update"):
        s.append("xupd")
    elif c.get("xform_mem"):
        s.append("xform")
    if c.get("blrl"):
        s.append("blrl")
    if c.get("bctr") or c.get("bctrl"):
        s.append("bctr")
    return "+".join(s)


def classify(img, byaddr, ov_by, starts, breloc, base, hosts=()):
    """-> [row] for every overlay entry, in address order.

    `emittable` is the real gate: the entry AND its whole callee closure must
    translate under the same settings the emission will use (--indirect
    --jumptables).  A row that fails carries the FIRST blocking reason, which is
    what a refusal should be reported as.

    `hosts` are guest addresses the HOST implements (sr.py --host, serviced at run
    time by sr_host_os.c through sr_driver.c's sr_host_hook).  The walk STOPS there
    and does not translate them, exactly as `sr.closure_of(hosts=...)` does and
    exactly as the emission does -- a `bl` to a host-bound address becomes
    `sr_extern(st, addr)`, which the hook services.  THE GATE AND THE BUILD MUST
    BE GIVEN THE SAME SET, or a candidate is armed that cannot run (or, worse, one
    that can run is refused offline and never armed at all).

    CAUTION when reading the refusal histogram this produces: it attributes each
    blocked entry to its FIRST blocking callee only.  That is a reporting choice,
    not a claim that removing that callee unblocks the entry -- 248 of the 745
    entries whose first blocker is 0x800e78ac are ALSO blocked by something else.
    Use sr.closure_of, which collects every blocker, to size a host boundary."""
    rows = []
    hosts = set(hosts)
    for a in sorted(ov_by):
        size = ov_by[a][0]
        c = census(img, a, size)
        why, nclo = None, 0
        seen, work = set(), [x for x in [a] if x not in hosts]
        while work:
            x = work.pop()
            if x in seen or x in hosts:
                continue
            seen.add(x)
            if x not in byaddr:
                why = f"{x:#010x} is not a known function start"
                break
            t = sr.Translator(img, x, x + byaddr[x][0], starts=starts,
                              branch_reloc=breloc, indirect=True, jumptables=True)
            try:
                t.translate()
            except sr.Untranslatable as e:
                why = (f"{e.why}" if x == a else f"callee {x:#010x}: {e.why}")
                break
            work += list(t.calls)
        else:
            nclo = len(seen)
        rows.append({"addr": a, "off": a - base, "size": size, "census": dict(c),
                     "shape": shape_of(c), "blocked": why, "closure": nclo})
    return rows


def arm_list(rows, n, min_size=0x20):
    """Round-robin across shape buckets, RAREST FIRST. -> [row] of length <= n.

    `min_size` drops trivial bodies.  It is not a nicety: an overlay is full of 4-byte
    `blr` thunks, sorting a bucket cheapest-first puts them at the FRONT, and a capture
    of one records `steps=1 bl=0 writes=0 initial_bytes=0` -- a fixture that asserts
    nothing and still counts as a pass.  Two of the first captures in the first survey
    run were exactly that.  0x20 = 8 instructions, the same bar --min-body sets on the
    size-ranked selection."""
    buckets = collections.defaultdict(list)
    for r in rows:
        if r["blocked"] is None and r["size"] >= min_size:
            buckets[r["shape"]].append(r)
    for k in buckets:
        # cheapest first inside a bucket: a small closure is a fast capture and a
        # small fixture build, and neither is what the shape spread is testing.
        buckets[k].sort(key=lambda r: (r["closure"], r["size"]))
    order = sorted(buckets, key=lambda k: len(buckets[k]))
    out, i = [], 0
    while len(out) < n:
        before = len(out)
        for k in order:
            if i < len(buckets[k]) and len(out) < n:
                out.append(buckets[k][i])
        if len(out) == before:
            break
        i += 1
    return out


def write_arm_file(path, rows, sel, source):
    with open(path, "w") as f:
        f.write(f"# shape-spread arm list — {source}\n")
        f.write(f"# {len(sel)} of {sum(1 for r in rows if r['blocked'] is None)} "
                f"entries that translate clean WITH their full callee closure "
                f"(of {len(rows)} discovered)\n")
        for r in sel:
            c = r["census"]
            f.write(f"{r['off']:#x}   # {r['addr']:#010x} {r['shape']} "
                    f"size={r['size']} closure={r['closure']} bl={c.get('bl', 0)} "
                    f"fp={c.get('fp_alu', 0) + c.get('fp_mem', 0)} ps={c.get('psq', 0) + c.get('ps', 0)} "
                    f"xform={c.get('xform_mem', 0)} xupd={c.get('xform_update', 0)} "
                    f"blrl={c.get('blrl', 0)} bctr={c.get('bctr', 0) + c.get('bctrl', 0)}\n")


def report(rows, sel=None, out=print):
    ok = [r for r in rows if r["blocked"] is None]
    out(f"[shapes] {len(rows)} entries, {len(ok)} translate clean with full closure")
    rc = collections.Counter(r["blocked"].split("(")[0].strip()
                             for r in rows if r["blocked"])
    for k, v in rc.most_common(8):
        out(f"[shapes]   BLOCKED {v:5d}  {k}")
    for k, v in collections.Counter(r["shape"] for r in ok).most_common(40):
        out(f"[shapes]   shape {k:32s} {v}")
    if sel is not None:
        out("[shapes] selected: " +
            ", ".join(f"{k}={v}" for k, v in
                      collections.Counter(r["shape"] for r in sel).most_common()))


def build_image(iso, relname, base, live_section, dol, mapfile, boundaries='outer+calls',
                sections=None):
    """-> (rel, sec, img, byaddr, ov_by, starts, breloc) at the REAL runtime base."""
    disc = R.Disc(iso)
    ent = next(f for f in disc.files
               if f["name"] == relname or f["path"].endswith(relname))
    m = R.Rel(disc.read_file(ent), ent["path"])
    execs = m.exec_sections()
    if len(execs) != 1:
        raise SystemExit(f"{relname} has {len(execs)} executable sections; "
                         f"this tool assumes 1")
    sec = execs[0]["idx"]
    blob = m.section_bytes(sec)
    if live_section:
        live = live_section if isinstance(live_section, (bytes, bytearray)) \
            else open(live_section, 'rb').read()
        if len(live) != len(blob):
            raise SystemExit(f"live section is {len(live)} B, section is {len(blob)} B")
        blob = bytes(live)
    dimg = sr.Image.from_dol(dol)
    dunits = R.split_dol_units_for(
        m, sr.recover_boundaries(dimg, sr.load_map(mapfile), boundaries))
    dol_by = {lo: (sz, nm) for lo, sz, nm in dunits}
    res = R.translate_module_reach(m, dol_starts=set(dol_by))
    mod_vbase = lambda mid, s: (base if (mid == m.id and s == sec)      # noqa: E731
                                else 0xA0000000 + (mid << 20) + (s << 12))
    breloc = R.branch_relocs(m, mod_vbase)
    img = sr.Image()
    img.segs.append((base, blob))
    # The overlay's DATA sections, relocated offline (see Rel.relocate).  A `bctr`
    # switch table lives there, so without them the bctr shape cannot be classified
    # as recoverable -- it merely "translates", into an sr_indirect() that faults.
    if sections:
        # Same synthetic base for a module that is NOT resident as branch_relocs uses,
        # so a cross-overlay reference cannot KeyError here.  SAB never exercises this
        # (every overlay checked imports only from module 0 and itself -- titleD id=1,
        # stg13D id=13, advertiseD id=91 all show exactly {0, self}), but a missing
        # base would crash the classification rather than degrade it.
        bases = collections.defaultdict(
            lambda: 0, {(mid, s): 0xA0000000 + (mid << 20) + (s << 12)
                        for mid, r in m.all_relocs() for s in (r["ref_sec"],)
                        if mid not in (0, m.id)})
        bases.update({(m.id, i): v[0] for i, v in sections.items()})
        bases[(m.id, sec)] = base
        want = [i for i, v in sections.items()
                if not v[2] and i != sec and m.sections[i]["size"]
                and not m.sections[i]["bss"]]
        if want:
            reloc = m.relocate(bases, sections=want)
            for i in want:
                img.segs.append((sections[i][0], reloc[i]))
    img.segs += dimg.segs
    img.segs.sort()
    ov_by = {(base + E) & 0xFFFFFFFF: (v["hi"] - v["lo"], f"{relname}:+{E:#x}")
             for (s, E), v in res["bodies"].items() if s == sec}
    byaddr = dict(dol_by)
    byaddr.update(ov_by)
    starts = set(byaddr) | set(breloc.values())
    return m, sec, img, byaddr, ov_by, starts, breloc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--iso', required=True)
    ap.add_argument('--rel', required=True)
    ap.add_argument('--base', required=True, type=lambda x: int(x, 16))
    ap.add_argument('--live-section', required=True)
    ap.add_argument('--dol', default='/tmp/sr_sab/main.dol')
    ap.add_argument('--map', default='dolphin_captures/sab.map')
    ap.add_argument('--arm-out')
    ap.add_argument('-n', type=int, default=300)
    a = ap.parse_args()
    m, sec, img, byaddr, ov_by, starts, breloc = build_image(
        a.iso, a.rel, a.base, a.live_section, a.dol, a.map)
    print(f"[shapes] {a.rel} id={m.id} sec{sec} @ {a.base:#010x}  "
          f"{len(ov_by)} overlay entries")
    rows = classify(img, byaddr, ov_by, starts, breloc, a.base)
    sel = arm_list(rows, a.n) if a.arm_out else None
    report(rows, sel)
    if a.arm_out:
        write_arm_file(a.arm_out, rows, sel, f"{a.rel} @ {a.base:#010x}")
        print(f"[shapes] wrote {a.arm_out} ({len(sel)} entries)")


if __name__ == '__main__':
    main()

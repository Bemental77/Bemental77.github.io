#!/usr/bin/env python3
"""fixture_rel.py — capture a differential fixture for a function inside a REL OVERLAY.

Every bit-exactness claim this project has made so far is about `main.dol` functions.
The overlays are 5,551,313 of SAB's 5,928,161 PowerPC instructions (93.64%), and not
one overlay function had ever been differentially verified.  This closes that.

  python3 gamecube/recomp/sr/fixture_rel.py --rel stg13D.rel --state <dolphin.sav> \\
          [--locate-only] [--capture-n 3] [--budget 120] [--max-arm 300]

  Env: GDB_PORT (default 9133), OUT (default /tmp/sr_rel_fixtures.json)

THE PROBLEM THIS SOLVES FIRST: an overlay has NO load address until OSLink runs, so
the runtime address of an overlay function is not in the file and not in the symbol
map.  Scanning 24 MB of MEM1 over the GDB stub for a byte signature is slow and the
shipped bytes do not even match memory at relocation sites (OSLink PATCHES them).

BASE RECOVERY, without scanning and without a symbol:
  The overlay calls INTO the static DOL through R_PPC_REL24 relocations with
  `imp->id == 0`, for which OSLink.c:139-142 sets offset = 0 — so the addend is an
  ABSOLUTE DOL address, known from the file alone.  Breakpoint one of those DOL
  targets; when it fires from the overlay, LR points one instruction past the calling
  `bl`, which is a live address INSIDE the overlay.  The relocation table says which
  (section, offset) sites call that target, so

      base = (LR - 4) - site_offset

  and the candidate is CONFIRMED by reading memory back at offsets that carry no
  relocation and byte-comparing against the shipped section.  Nothing is guessed: the
  arithmetic comes from the file and the confirmation comes from the machine.
"""
import argparse, json, os, struct, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'gamecube', 'tools'))
import rel as R                       # noqa: E402
import sr                             # noqa: E402
import native_oracle_gdb as O         # noqa: E402
from fixture_nonleaf import read_gqrs, ps1_dependency, ORACLE_BIN   # noqa: E402

PORT = int(os.environ.get("GDB_PORT", "9133"))
OUT = os.environ.get("OUT", "/tmp/sr_rel_fixtures.json")
MEM1_LO, MEM1_HI = 0x80000000, 0x81800000


def dol_text_ranges(iso_path):
    """[(lo, hi)] of the DOL's TEXT sections, read from the header at ISO 0x420.

    Needed because a breakpointed DOL function is called from the DOL far more often
    than from an overlay: without this filter the first hits are DOL-internal callers
    whose LR is a DOL address, and (LR-4)-site_off is then nonsense."""
    f = open(iso_path, 'rb')
    f.seek(0x420)
    dol_off = struct.unpack('>I', f.read(4))[0]
    f.seek(dol_off)
    dh = f.read(0x100)
    tad = struct.unpack('>7I', dh[0x48:0x64])
    tsz = struct.unpack('>7I', dh[0x90:0xac])
    f.close()
    return [(tad[i], tad[i] + tsz[i]) for i in range(7) if tsz[i]]


def dol_call_sites(rel):
    """absolute DOL target -> [(site_sec, site_off)] for every REL24 with imp->id == 0."""
    out = {}
    for mid, r in rel.all_relocs():
        if mid != 0 or r["type"] not in (R.R_PPC_REL24, R.R_PPC_ADDR24):
            continue
        out.setdefault(r["addend"], []).append((r["site_sec"], r["site_off"]))
    return out


def reloc_site_offsets(rel, sec):
    return {r["site_off"] for _, r in rel.all_relocs() if r["site_sec"] == sec}


def confirm_base(g, rel, sec, base, reloc_offs, blob, samples=24, window=32):
    """Byte-compare live memory against the shipped section at NON-relocated offsets.

    Relocation sites are patched in place by OSLink, so they legitimately differ; any
    mismatch anywhere else means this base is wrong."""
    n = len(blob)
    step = max(4, (n // samples) & ~3)
    checked = 0
    for off in range(0, max(0, n - window), step):
        if any((off + k) in reloc_offs for k in range(0, window, 4)):
            continue
        addr = base + off
        if not (MEM1_LO <= addr and addr + window <= MEM1_HI):
            return False, checked
        try:
            live = g.mem(addr, window)
        except Exception:
            return False, checked
        if live != blob[off:off + window]:
            return False, checked
        checked += 1
        if checked >= samples:
            break
    return checked >= 3, checked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--iso', default=O.SAB_ISO)
    ap.add_argument('--rel', default='stg13D.rel')
    ap.add_argument('--state', default=O.SAB_STATE)
    ap.add_argument('--map', default=os.path.join(REPO, 'dolphin_captures/sab.map'))
    ap.add_argument('--locate-only', action='store_true')
    ap.add_argument('--capture-n', type=int, default=3)
    ap.add_argument('--budget', type=float, default=120.0,
                    help='seconds for BASE RECOVERY.  Size it in EMULATED time: the '
                         'reference interpreter runs SAB at ~0.0328x real time '
                         '(measured: 2,996 AID fires = 14.97 s emulated in ~456 s wall, '
                         'AID rate 200.18/s per CLAUDE.md:44), so 240 s of wall clock '
                         'buys only ~7.9 s of emulated boot -- nowhere near the point '
                         'where the game OSLinks an overlay.  Both earlier overlay '
                         'attempts failed for exactly this reason.')
    ap.add_argument('--discover-budget', type=float, default=None,
                    help='seconds for the entry-discovery phase (default: budget/3). '
                         'The machine is already booted by then, so it needs far less.')
    ap.add_argument('--max-arm', type=int, default=300)
    ap.add_argument('--max-steps', type=int, default=40000)
    ap.add_argument('--probe-targets', type=int, default=24)
    a = ap.parse_args()

    disc = R.Disc(a.iso)
    ent = next(f for f in disc.files
               if f["name"] == a.rel or f["path"].endswith(a.rel))
    rel = R.Rel(disc.read_file(ent), ent["path"])
    execs = rel.exec_sections()
    if len(execs) != 1:
        print(f"[rel] {a.rel} has {len(execs)} executable sections; this tool assumes 1",
              file=sys.stderr)
        sys.exit(2)
    sec = execs[0]["idx"]
    blob = rel.section_bytes(sec)
    reloc_offs = reloc_site_offsets(rel, sec)
    sites = dol_call_sites(rel)
    print(f"[rel] {ent['path']} id={rel.id} v{rel.version} exec sec={sec} "
          f"{len(blob)} bytes ({len(blob)//4} instructions)")
    print(f"[rel] {len(sites)} distinct DOL call targets, "
          f"{sum(len(v) for v in sites.values())} REL24 sites")
    textr = dol_text_ranges(a.iso)
    print("[rel] DOL text (LR in these ranges = a DOL-internal caller, skipped): "
          + ", ".join(f"{lo:#x}..{hi:#x}" for lo, hi in textr))

    # Probe targets: MOST call sites first.  The first version of this ranked by
    # FEWEST -- which minimises the number of base candidates per hit, and is exactly
    # backwards: fewest call sites means the RAREST call, so the breakpoints that fire
    # least often were the ones armed.  A titleD run took 367 breakpoint hits without
    # ever seeing a call FROM the overlay.  Ambiguity is cheap to resolve (every
    # candidate is byte-confirmed against live memory below), rarity is not.
    probes = sorted(sites.items(), key=lambda kv: -len(kv[1]))[:a.probe_targets]
    print(f"[rel] arming {len(probes)} DOL targets for base recovery "
          f"(max {len(probes[0][1])} site(s), min {len(probes[-1][1])})")

    osyms = O.load_map(a.map)
    dol = O.Dolphin(iso=a.iso, state=a.state, port=PORT,
                    log=f"/tmp/sr_rel_oracle_{PORT}.log", dual_core=True,
                    binary=ORACLE_BIN, extra=["-C", "Dolphin.Core.CPUCore=0"])
    print(f"[oracle] {ORACLE_BIN} port={PORT} core=interpreter state={a.state}")
    base = None
    try:
        g = dol.connect()
        pc0 = g.pc()
        print(f"[oracle] connected; pc={pc0:#010x}")
        # A savestate that fails to restore SILENTLY COLD-BOOTS and everything
        # downstream still looks plausible.  The DOL entry point is the tell.
        if pc0 == 0x80003140:
            print("[oracle] WARNING: pc is the DOL ENTRY POINT — this is a COLD BOOT, "
                  "not a restored scene.  Overlays load only once the game reaches "
                  "the point that OSLinks them.")

        # ---------------------------------------------------------- base recovery
        for tgt, _ in probes:
            g.add_bp(tgt)
        t0 = time.time()
        tries = 0
        while base is None and time.time() - t0 < a.budget:
            try:
                rep = g.cont(timeout=max(5.0, a.budget - (time.time() - t0)))
            except Exception as e:
                print(f"[base] cont failed: {type(e).__name__}: {e}")
                break
            pc = O.GDB.stop_pc(rep)
            g.resync()
            tries += 1
            if pc not in sites:
                continue
            lr = g.reg(67)                       # native_oracle_gdb.py:41 -> 67 = LR
            if not (MEM1_LO <= lr < MEM1_HI):
                continue
            if any(lo <= lr < hi for lo, hi in textr):
                continue                          # DOL-internal caller, not the overlay
            call_pc = (lr - 4) & 0xFFFFFFFF
            for (ssec, soff) in sites[pc]:
                if ssec != sec:
                    continue
                cand = (call_pc - soff) & 0xFFFFFFFF
                ok, checked = confirm_base(g, rel, sec, cand, reloc_offs, blob)
                print(f"[base] hit {pc:#010x} lr={lr:#010x} site=+{soff:#x} "
                      f"-> candidate {cand:#010x}  confirm={'OK' if ok else 'no'} "
                      f"({checked} windows byte-identical)")
                if ok:
                    base = cand
                    break
        for tgt, _ in probes:
            g.del_bp(tgt)
        if base is None:
            print(f"[base] NOT RECOVERED after {tries} breakpoint hits — the scene may "
                  f"not have {a.rel} resident.", file=sys.stderr)
            sys.exit(3)
        print(f"\n[base] {a.rel} section {sec} is loaded at {base:#010x}  "
              f"(covers {base:#010x}..{base + len(blob):#010x})\n")
        if a.locate_only:
            json.dump({"rel": a.rel, "sec": sec, "base": base, "size": len(blob)},
                      open(OUT, "w"), indent=1)
            print(f"[base] wrote {OUT}")
            return

        # ------------------------------------------ LIVE, RELOCATED SECTION BYTES
        # The shipped REL bytes are NOT what executes.  OSLink's Relocate()
        # (~/gc_refs/dolsdk2001/src/os/OSLink.c:146-200) PATCHES the image in place:
        # ADDR32 writes a word, ADDR16_HA/LO/HI rewrite the low half of a lis/addi
        # pair, REL24 rewrites a branch displacement.  Translating the file bytes
        # would therefore bake PLACEHOLDER constants into every address
        # materialisation.  Rather than re-implement Relocate() and then have to
        # discover the runtime base of every DATA section it references, read the
        # relocated section back out of the machine: that is ground truth, and the
        # base confirmation above already proved we are looking at the right image.
        print(f"[live] reading {len(blob)} relocated bytes from {base:#010x} ...",
              flush=True)
        live = g.read_range(base, base + len(blob))
        if len(live) != len(blob):
            print(f"[live] short read: {len(live)} of {len(blob)}", file=sys.stderr)
            sys.exit(5)
        live_path = os.path.splitext(OUT)[0] + f".{a.rel}.sec{sec}.bin"
        open(live_path, "wb").write(live)
        diff = sum(1 for i in range(0, len(blob), 4)
                   if live[i:i + 4] != blob[i:i + 4])
        print(f"[live] wrote {live_path}  ({diff} of {len(blob)//4} words differ from "
              f"the shipped file = the OSLink patches)")

        # ------------------------------------------------- which entries execute
        res = R.translate_module_reach(rel)
        entries = sorted({off for (s, off) in res["entries"] if s == sec})
        bodies = {E: v for (s, E), v in res["bodies"].items() if s == sec}
        print(f"[rel] {len(entries)} discovered function entries in section {sec}")
        arm = [e for e in entries if e in bodies]
        arm.sort(key=lambda e: bodies[e]["hi"] - bodies[e]["lo"])
        arm = arm[:a.max_arm]
        dbudget = a.discover_budget if a.discover_budget else a.budget / 3.0
        print(f"[discover] arming {len(arm)} overlay entries for {dbudget:.0f}s")
        for off in arm:
            g.add_bp(base + off)
        hits, t0 = {}, time.time()
        while time.time() - t0 < dbudget:
            try:
                rep = g.cont(timeout=max(5.0, dbudget - (time.time() - t0)))
            except Exception:
                break
            pc = O.GDB.stop_pc(rep)
            if MEM1_LO <= pc < MEM1_HI and (pc - base) in bodies:
                hits[pc - base] = hits.get(pc - base, 0) + 1
            g.resync()
        for off in arm:
            g.del_bp(base + off)
        print(f"[discover] {len(hits)} of {len(arm)} overlay entries fired")
        ranked = sorted(hits.items(), key=lambda kv: -kv[1])
        for off, n in ranked[:20]:
            b = bodies[off]
            print(f"   +{off:#08x} -> {base + off:#010x}  hits={n:5d}  "
                  f"body={b['hi'] - b['lo']} bytes")
        if not ranked:
            print("[discover] nothing fired; cannot capture", file=sys.stderr)
            sys.exit(4)

        # --------------------------------------------------------- capture
        out = {"game": "GSNE8P",
               "oracle": "native Dolphin interpreter (CPUCore=0)",
               "rel": a.rel, "rel_sec": sec, "rel_base": base,
               "live_section": live_path, "live_words_patched": diff,
               "capture": "gamecube/recomp/sr/fixture_rel.py",
               "fixtures": []}
        taken = 0
        for off, n in ranked:
            if taken >= a.capture_n:
                break
            entry = base + off
            print(f"[capture] {entry:#010x} (+{off:#x}, {n} hits) ...", flush=True)
            try:
                fx = O.capture_replayable_fixture(g, entry, syms=osyms,
                                                  max_steps=a.max_steps, progress=2000)
            except Exception as e:
                print(f"    SKIPPED: {type(e).__name__}: {e}", flush=True)
                continue
            fx["gqr"] = read_gqrs(g)
            fx["ps1_dependency"] = [[f"{p:#010x}", f"{w:08x}", why]
                                    for p, w, why in ps1_dependency(fx["stream"])]
            fx["n_calls"] = sum(1 for _, w in fx["stream"]
                                if ((w >> 26) & 0x3F) == 18 and (w & 1))
            fx["rel_off"] = off
            del fx["stream"]
            print(f"    steps={fx['steps']} returned={fx['returned']} "
                  f"bl={fx['n_calls']} writes={len(fx['writes'])} "
                  f"initial_bytes={len(fx['initial_mem'])} "
                  f"unknown={len(fx['unknown_stores'])} "
                  f"outside_mem1={len(fx['outside_mem1'])} "
                  f"ps1_dep={len(fx['ps1_dependency'])}")
            if fx["unknown_stores"]:
                print("    NOTE: unknown store forms -> the write log is INCOMPLETE; "
                      "this fixture cannot be a pass criterion")
            out["fixtures"].append(fx)
            taken += 1
            json.dump(out, open(OUT, "w"))
        json.dump(out, open(OUT, "w"))
        print(f"[capture] wrote {OUT} ({len(out['fixtures'])} fixtures)")
    finally:
        dol.kill()


if __name__ == '__main__':
    main()

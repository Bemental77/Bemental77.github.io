#!/usr/bin/env python3
"""fixture_nonleaf.py — capture REPLAYABLE differential fixtures for NON-LEAF SAB
functions from native Dolphin's reference interpreter.

The leaf work (sab_leaf_goldens.json) used an ABI table: stage pointers, hijack PC,
read the output buffer.  That does not generalise to a non-leaf, whose observable
effect includes its callees' stores, its stack frame, and its register clobbers.
So this tool does the ABI-free thing instead: breakpoint a REAL in-game call, single-
step the whole invocation on the interpreter, and record everything needed to re-run
it somewhere else and diff:

  * entry architectural state (GPR / FPR-PS0 / CR / XER / LR / CTR / FPSCR / MSR)
  * GQR0..7, read with a two-instruction `mfspr` gadget (the GDB stub exposes SPRs
    only up to case 142 in GDBStub.cpp — no GQR case exists, so they must be
    fetched by executing code, not by asking for a register)
  * INITIAL memory: the value of every byte the invocation reads, as of entry
    (a read of a byte this invocation already wrote is NOT staged — it must
    observe the write)
  * the ordered store log with before/after bytes
  * exit architectural state
  * the executed instruction stream, used to REJECT a fixture whose result depends
    on an incoming PS1 lane (the stub cannot read PS1; guessing it would produce a
    fixture that is wrong in a way the diff cannot see)

Usage:
  python3 gamecube/recomp/sr/fixture_nonleaf.py --discover      # which candidates run
  python3 gamecube/recomp/sr/fixture_nonleaf.py --capture 0x800xxxxx [more...]

Env: GDB_PORT (default 9131), OUT (default /tmp/sr_fixtures.json), DISCOVER_BUDGET.
"""
import argparse, json, os, struct, sys, time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO, "gamecube/tools"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import native_oracle_gdb as O    # noqa: E402
import sr                        # noqa: E402

ORACLE_BIN = os.path.expanduser(
    "~/gc_refs/dolphin-upstream/build-oracle/Binaries/dolphin-emu-nogui")
PORT = int(os.environ.get("GDB_PORT", "9131"))
OUT = os.environ.get("OUT", "/tmp/sr_fixtures.json")
A_GADGET = 0x81790000          # scratch: 2-instruction SPR-read gadget


# ---------------------------------------------------------------- GQR readout
def read_gqrs(g: "O.GDB"):
    """GQR0..7 (SPR 912..919) by executing `mfspr r3,SPRn ; b .` in scratch RAM.

    Nothing in Dolphin is patched: this is the same M/P/c hijack the leaf golden
    capture already relies on.  PC and r3 are restored afterwards.
    """
    def mfspr(rd, spr):
        return ((31 << 26) | (rd << 21) | ((spr & 31) << 16) |
                (((spr >> 5) & 31) << 11) | (339 << 1))

    pc0, r3_0 = g.pc(), g.gprs()[3]
    out = []
    g.cmd(f"M{A_GADGET + 4:x},4:" + "48000000")            # b .
    g.add_bp(A_GADGET + 4)
    for i in range(8):
        g.cmd(f"M{A_GADGET:x},4:" + f"{mfspr(3, 912 + i):08x}")
        g.cmd(f"P40={A_GADGET:08x}")
        rep = g.cont(timeout=30.0)
        if O.GDB.stop_pc(rep) != A_GADGET + 4:
            raise O.RSPError(f"GQR gadget halted at {O.GDB.stop_pc(rep)}, not the sentinel")
        g.resync()
        out.append(g.gprs()[3])
    g.del_bp(A_GADGET + 4)
    g.cmd(f"P03={r3_0:08x}")
    g.cmd(f"P40={pc0:08x}")
    # A GQR is 3-bit type + 6-bit scale in each half; every other bit reads 0 on
    # real hardware.  Anything else means the gadget did not do what we think.
    for i, v in enumerate(out):
        if v & ~0x3F073F07:
            raise O.RSPError(f"GQR{i} = {v:#010x} has reserved bits set — gadget suspect")
    return out


# ------------------------------------------------------- PS1 dependency check
# The GDB stub exposes FPR PS0 only (GDBStub.cpp register map 32..63).  A fixture
# whose result depends on an FPR's INCOMING PS1 lane therefore cannot be replayed
# faithfully, and must be rejected rather than replayed with a guessed lane.
def ps1_dependency(stream):
    """-> list of (pc, word, why) for reads of an undefined incoming PS1 lane."""
    defined = set()          # FPRs whose PS1 lane this trace has written
    bad = []
    for pc, w in stream:
        f = sr.F(w)
        op, xo, xo5 = f['op'], f['xo'], f['xo5']
        rd, ra, rb, rc = f['frD'], f['frA'], f['frB'], f['frC']
        reads, writes = [], []
        if op == 4:
            if xo in (0, 32):                    # ps_cmpu0 / ps_cmpo0 — PS0 only
                pass
            elif xo in (64, 96):                 # ps_cmpu1 / ps_cmpo1
                reads = [ra, rb]
            elif xo in (528, 560, 592, 624, 72): # ps_merge* / ps_mr
                if xo in (592, 624):
                    reads.append(ra)
                if xo in (560, 624, 72):
                    reads.append(rb)
                writes = [rd]
            elif xo in (40, 264, 136):            # ps_neg / ps_abs / ps_nabs
                reads, writes = [rb], [rd]
            elif xo5 in (12, 13, 14, 15):         # ps_muls0/1, ps_madds0/1
                reads = [ra, rc] + ([rb] if xo5 in (14, 15) else [])
                writes = [rd]
            elif xo5 in (10, 11):                 # ps_sum0 / ps_sum1
                reads, writes = [rb, rc], [rd]
            elif xo5 in (18, 20, 21, 23, 24, 25, 26, 28, 29, 30, 31):
                reads = [ra, rb, rc]              # the rest of the op4 arithmetic
                writes = [rd]
            else:
                bad.append((pc, w, f"unmodelled op4 xo={xo} xo5={xo5}"))
                continue
        elif op in (56, 57):                      # psq_l / psq_lu define BOTH lanes
            writes = [rd]
        elif op in (60, 61):                      # psq_st / psq_stu
            if not f['psW']:
                reads = [f['frS']]
        elif op in (48, 49, 59):                  # lfs / lfsu / op59 define both lanes
            writes = [rd]
        elif op == 63 and xo == 12:               # frsp defines both lanes
            writes = [rd]
        elif op == 31 and xo == 535:              # lfsx defines both lanes
            writes = [rd]
        for r in reads:
            if r not in defined:
                bad.append((pc, w, f"reads PS1 of f{r} before defining it"))
        defined.update(writes)
    return bad


# ------------------------------------------------------------------ candidates
def clean_nonleaf_candidates(img, syms, lo_ins=8, hi_ins=4000):
    byaddr = sr.index_functions(img, syms)
    rows = []
    for a, (size, name) in byaddr.items():
        t = sr.Translator(img, a, a + size)
        try:
            t.translate()
        except sr.Untranslatable:
            continue
        if not t.calls:
            continue
        cl, probs = sr.closure_of(img, byaddr, [a])
        if probs:
            continue
        ins = sum(byaddr[x][0] // 4 for x in cl)
        if lo_ins <= ins <= hi_ins:
            rows.append((a, name, len(cl), ins))
    rows.sort(key=lambda r: r[3])
    return rows, byaddr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', default='/tmp/sr_slice/main.dol')
    ap.add_argument('--map', default=os.path.join(REPO, 'dolphin_captures/sab.map'))
    ap.add_argument('--discover', action='store_true')
    ap.add_argument('--capture', action='append', default=[])
    ap.add_argument('--n-cand', type=int, default=1200)
    ap.add_argument('--max-steps', type=int, default=40000)
    ap.add_argument('--state', default=O.SAB_STATE)
    a = ap.parse_args()

    img = sr.Image.from_dol(a.image)
    syms = sr.load_map(a.map)
    osyms = O.load_map(a.map)

    dol = O.Dolphin(iso=O.SAB_ISO, state=a.state, port=PORT,
                    log=f"/tmp/sr_oracle_{PORT}.log", dual_core=True,
                    binary=ORACLE_BIN,
                    extra=["-C", "Dolphin.Core.CPUCore=0"])   # REFERENCE INTERPRETER
    print(f"[oracle] {ORACLE_BIN} port={PORT} core=interpreter state={a.state}")
    try:
        g = dol.connect()
        print(f"[oracle] connected; pc={g.pc():#010x}")
        gqr = read_gqrs(g)
        print("[oracle] GQR " + " ".join(f"{i}={v:#010x}" for i, v in enumerate(gqr)))

        if a.discover:
            rows, _ = clean_nonleaf_candidates(img, syms)
            cands = rows[:a.n_cand]
            print(f"[discover] arming {len(cands)} clean-closure non-leaf entries")
            for addr, *_ in cands:
                g.add_bp(addr)
            want = {addr for addr, *_ in cands}
            hits, t0 = {}, time.time()
            budget = float(os.environ.get("DISCOVER_BUDGET", "180"))
            while time.time() - t0 < budget:
                try:
                    rep = g.cont(timeout=max(5.0, budget - (time.time() - t0)))
                except Exception:
                    break
                pc = O.GDB.stop_pc(rep)
                if pc in want:
                    hits[pc] = hits.get(pc, 0) + 1
                g.resync()
            for addr, *_ in cands:
                g.del_bp(addr)
            byname = {addr: (nm, nc, ins) for addr, nm, nc, ins in cands}
            print(f"[discover] {len(hits)} of {len(cands)} entries fired")
            for addr, n in sorted(hits.items(), key=lambda kv: -kv[1]):
                nm, nc, ins = byname[addr]
                print(f"  {addr:#010x} hits={n:5d} closure={nc:2d} insts={ins:5d} {nm}")
            json.dump({"gqr": gqr, "hits": {f"{k:#010x}": v for k, v in hits.items()},
                       "candidates": [[f"{c[0]:#010x}", c[1], c[2], c[3]] for c in cands]},
                      open("/tmp/sr_discover.json", "w"), indent=1)
            return

        fstarts = {lo for lo, _, _ in sr.recover_boundaries(img, syms, 'outer+calls')}
        out = {"game": "GSNE8P", "oracle": "native Dolphin interpreter (CPUCore=0)",
               "gqr": gqr, "fixtures": []}
        for hx in a.capture:
            entry = int(hx, 16)
            print(f"[capture] {entry:#010x} ...", flush=True)
            try:
                fx = O.capture_replayable_fixture(g, entry, syms=osyms,
                                                  max_steps=a.max_steps, progress=2000)
            except Exception as e:
                print(f"    SKIPPED: {type(e).__name__}: {e}", flush=True)
                continue
            # GQRs must be read for THIS invocation window, not at connect time:
            # a savestate can land before the game has programmed them.  The CPU is
            # halted at the return point here, so the gadget is safe to run.
            fx["gqr"] = read_gqrs(g)
            fx["ps1_dependency"] = [[f"{p:#010x}", f"{w:08x}", why]
                                    for p, w, why in ps1_dependency(fx["stream"])]
            fx["n_calls"] = sum(1 for _, w in fx["stream"]
                                if ((w >> 26) & 0x3F) == 18 and (w & 1))
            # WHICH FUNCTIONS THE INVOCATION ACTUALLY ENTERED.  Needed for an INDIRECT
            # call (blrl / bctr): the callee is chosen at run time, so the static callee
            # closure does not contain it and an emit set built from the closure alone
            # would fault in sr_indirect().  The executed PC trace states the answer, so
            # record the function starts it touched before the trace is discarded.
            fx["entered"] = sorted({f"{pc:#010x}" for pc, _ in fx["stream"]
                                    if pc in fstarts})
            del fx["stream"]
            print(f"    steps={fx['steps']} returned={fx['returned']} "
                  f"bl={fx['n_calls']} writes={len(fx['writes'])} "
                  f"initial_bytes={len(fx['initial_mem'])} "
                  f"unknown={len(fx['unknown_stores'])} "
                  f"outside_mem1={len(fx['outside_mem1'])} "
                  f"ps1_dep={len(fx['ps1_dependency'])}")
            out["fixtures"].append(fx)
            json.dump(out, open(OUT, "w"))
        json.dump(out, open(OUT, "w"))
        print(f"[capture] wrote {OUT}")
    finally:
        dol.kill()


if __name__ == '__main__':
    main()

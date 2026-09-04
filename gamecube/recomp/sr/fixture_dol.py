#!/usr/bin/env python3
"""fixture_dol.py — SURVEY main.dol: capture many DOL fixtures from ONE oracle run.

WHY THIS EXISTS.  The verification record for `main.dol` is ~15 functions
(4 leaf goldens + 7 non-leaf + 3 blrl + 1 bctr) out of 4,741 recovered boundaries,
while the overlays already have a wave survey (`fixture_rel.py --survey`) that
captures a whole shape-spread set in one boot.  The DOL side never got one: it has
`fixture_nonleaf.py --discover` (arm breakpoints, count hits) followed by
`--capture` ONE address at a time, and every capture then has to reach its entry a
SECOND time -- so a function that runs once per scene is refused, which is exactly
the class a survey is for.

  THE GAP, MEASURED: the boot/menu scene touches 2,033 distinct DOL functions
  (gamecube/recomp/sr/profile_map.py, README §8.5), and 15 have ever been verified.
  The binding constraint on the DOL side is therefore CAPTURE COST, not the scene --
  the opposite of the overlay side, where a parked savestate executed only 16 of
  stg13D's 734 non-trivial entries.  This tool changes the DOL driving method to the
  overlay one rather than changing the translator.

It reuses `fixture_rel.survey_waves` UNCHANGED (base = 0, offsets = absolute guest
addresses).  That function carries five hard-won correctness properties that must not
be re-derived: capture-at-fire via `at_entry`, never abandoning a `cont` (no async
break exists in this stub), a calibrated rare-but-live control anchor, delete-on-fire
enumeration, and leaving enumeration early when nothing new fires.

CANDIDATE SELECTION IS OFFLINE AND IS A GATE, NOT A RANKING.  An entry is armed only
if it AND its whole transitive callee closure translate under the same flags the
whole-image build uses (`--indirect --jumptables`).  That is the same bar
`rel_shapes.classify` applies, and it is what excludes the 70-function host-binding
skiplist by construction: a skiplisted function does not translate, so any closure
containing one is blocked.  §8.1d of the README is the reason this matters -- a hot
40-instruction function captured cleanly still faulted `0xe00e78ac` on replay because
`OSDisableInterrupts` is one of its callees.

  python3 gamecube/recomp/sr/fixture_dol.py --shapes-only          # offline census
  OUT=/tmp/sr_dol_survey.json python3 gamecube/recomp/sr/fixture_dol.py --survey

Env: GDB_PORT (default 9137), OUT (default /tmp/sr_dol_survey.json).
"""
import argparse, collections, json, os, re, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'gamecube', 'tools'))
import sr                             # noqa: E402
import rel_shapes as SH               # noqa: E402
import native_oracle_gdb as O         # noqa: E402
from fixture_nonleaf import read_gqrs, ps1_dependency    # noqa: E402
from fixture_rel import survey_waves                     # noqa: E402

PORT = int(os.environ.get("GDB_PORT", "9137"))
OUT = os.environ.get("OUT", "/tmp/sr_dol_survey.json")
DOL_ENTRY_PC = 0x80003140      # a connect here means the savestate did NOT restore


# The MSR / interrupt host boundary, sr_host_os.h's SR_OS_IRQ set.  Passing this to
# --host makes the offline gate agree with a build linked SR_HOST_OS=1: neither
# translates these addresses, both let a `bl` to one reach sr_host_hook.
#
# READ FROM sr_host_os.h, NOT COPIED.  The gate and the build disagreeing silently is
# the single most expensive failure shape in this tree (CLAUDE.md: a link that packages
# a stale wasm, a probe gated on a flag that does not exist).  Here the consequence
# would be an arm list of candidates that cannot run, or -- worse -- 506 runnable
# candidates refused offline and never armed at all.  One definition, parsed.
IRQ_HOST_NAMES = ("SAB_OSDisableInterrupts", "SAB_OSEnableInterrupts",
                  "SAB_OSRestoreInterrupts",
                  # `mfmsr r3; blr` / `mtmsr r3; blr`, two byte-identical copies of each
                  "SAB_TRK_get_MSR_A", "SAB_TRK_set_MSR_A",
                  "SAB_TRK_get_MSR_B", "SAB_TRK_set_MSR_B")


# The TIMEBASE host boundary, sr_host_os.h's "THE GUEST TIMEBASE" set.  Three leaves,
# read from the SHIPPED WORDS rather than from sab.map, which names 0x800e34bc
# "PPCMtwpar" and is wrong -- the word is 7c7603a6 = `mtspr 22,r3`, and SPR 22 is the
# DECREMENTER (WPAR is SPR 921).  All three touch no memory and take no stack frame,
# which is what makes them safe to answer for without perturbing a fixture's write log.
CLOCK_HOST_NAMES = ("SAB_OSGetTime", "SAB_OSGetTick", "SAB_PPCMtdec")


# The CONTEXT host boundary, split into the two tiers sr_host_os.c actually has, because
# they are serviceable under DIFFERENT runtime requirements and an offline gate that
# conflated them would arm candidates that cannot run:
#
#   CTX  -- OSSetCurrentContext / OSGetCurrentContext / OSClearContext.  Pure guest-memory
#           + GPR + MSR transcriptions of ~/gc_refs/dolsdk2001/src/os/OSContext.c:200-238
#           and :390-395.  NO host thread, no -pthread: sr_host_os.c services them in
#           SR_OS_CTX, which is SR_OS_IRQ plus exactly these three.
#   HLE  -- OSSaveContext / OSLoadContext / SelectThread.  OSSaveContext is a setjmp that
#           returns TWICE and OSLoadContext is its rfi, so neither can be a host C function
#           on its own (CONTEXT_SWITCH.md §2, measured under BOTH longjmp backends).  The
#           cut is SelectThread, one host thread per guest thread, and it needs -pthread
#           and sr_os_init().  Passing these to --host WITHOUT linking that build produces
#           a candidate whose replay faults, which is the exact failure this file's
#           docstring exists to prevent.
#
# Read from the SHIPPED WORDS, not the map -- sab.map does not name 0x800e56bc or
# 0x800ebd68 at all (they come back `zz_800e56bc_` / `zz_800ebd68_`), and it has been
# WRONG twice elsewhere in this family.  Verified at HEAD:
#   0x800e579c OSClearContext   38a00000 li r5,0    / b0a301a0 sth r5,0x1a0(r3)  <- mode
#                               3c808000 lis r4,0x8000 / b0a301a2 sth r5,0x1a2(r3) <- state
#                               800400d8 lwz r0,0xd8(r4) / 7c030040 cmplw r3,r0
#                               40820008 bne +8 / 90a400d8 stw r5,0xd8(r4) / 4e800020 blr
#   0x800e5630 OSGetCurrentContext 3c608000 / 806300d4 lwz r3,0xd4(r3) / 4e800020
#   0x800e55d4 OSSetCurrentContext 3c808000 / 906400d4 stw r3,0xd4(r4) / 546500be clrlwi
#                               90a400c0 / 80a400d8 / 7c051800 cmpw r5,r3 / 40820020 bne
CTX_HOST_NAMES = ("SAB_OSSetCurrentContext", "SAB_OSGetCurrentContext",
                  "SAB_OSClearContext")
HLE_HOST_NAMES = ("SAB_OSSaveContext", "SAB_OSLoadContext", "SAB_SelectThread")


def _hosts_from_header(names, why):
    """-> tuple of guest addresses, read out of sr_host_os.h by name."""
    hdr = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sr_host_os.h")
    defs = dict(re.findall(r"^#define\s+(SAB_\w+)\s+(0x[0-9a-fA-F]+)u?\s*$",
                           open(hdr).read(), re.M))
    missing = [n for n in names if n not in defs]
    if missing:
        raise SystemExit(f"{hdr} no longer defines {missing} -- the offline closure "
                         f"gate and sr_host_os.c's {why} switch have drifted apart")
    return tuple(int(defs[n], 16) for n in names)


IRQ_HOSTS = _hosts_from_header(IRQ_HOST_NAMES, "SR_OS_IRQ")
CLOCK_HOSTS = _hosts_from_header(CLOCK_HOST_NAMES, "clock")
CTX_HOSTS = _hosts_from_header(CTX_HOST_NAMES, "SR_OS_CTX")
HLE_HOSTS = _hosts_from_header(HLE_HOST_NAMES, "SR_OS_HLE")


def classify_dol(img, byaddr, min_size, hosts=()):
    """Shape + emittability for every recovered DOL boundary.

    Delegates to rel_shapes.classify, which is written against a generic
    (img, byaddr, entries, starts, branch_reloc, base) and needs no overlay:
    for the DOL the entry set IS the boundary set, there are no relocations, and
    base 0 makes `off` the absolute address.
    """
    return SH.classify(img, byaddr, byaddr, set(byaddr), {}, 0, hosts=hosts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', default='/tmp/sr_sab/main.dol')
    ap.add_argument('--map', default=os.path.join(REPO, 'dolphin_captures/sab.map'))
    ap.add_argument('--boundaries', default='outer+calls')
    ap.add_argument('--state', default=O.SAB_STATE)
    ap.add_argument('--iso', default=O.SAB_ISO)
    ap.add_argument('--host', action='append', default=[], metavar='ADDR',
                    help='a guest address the HOST implements (sr.py --host).  The '
                         'closure gate stops there instead of refusing it, so a '
                         'candidate that only reached a host-bound primitive becomes '
                         'armable.  MUST match the --host set the replay build was '
                         'linked with.  Repeatable.')
    ap.add_argument('--irq-hosts', action='store_true',
                    help='shorthand for --host on the whole SR_OS_IRQ set '
                         '(OSDisableInterrupts / OSEnableInterrupts / '
                         'OSRestoreInterrupts / the two __TRK_get_MSR + __TRK_set_MSR '
                         'pairs) -- what a build linked SR_HOST_OS=1 services.')
    ap.add_argument('--clock-hosts', action='store_true',
                    help='shorthand for --host on the TIMEBASE set (OSGetTime / '
                         'OSGetTick / PPCMtdec) -- the guest clock, serviced by '
                         'sr_host_os.c from RETIRED GUEST WORK, never from the host '
                         'clock. Pair with --irq-hosts: the two sets compose, and '
                         'PPCMtdec is worth +0 on its own but -112 when dropped from '
                         'the composed set, because SetTimer uses it with OSGetTime '
                         '(~/gc_refs/dolsdk2001/src/os/OSAlarm.c:37-46).')
    ap.add_argument('--ctx-hosts', action='store_true',
                    help='shorthand for --host on the THREAD-FREE context set '
                         '(OSSetCurrentContext / OSGetCurrentContext / OSClearContext) '
                         '-- what a build running sr_host_os.c in SR_OS_CTX services. '
                         'Needs no -pthread and creates no host thread.')
    ap.add_argument('--hle-hosts', action='store_true',
                    help='shorthand for --host on the set that needs the HOST THREAD '
                         'POOL (OSSaveContext / OSLoadContext / SelectThread). ONLY '
                         'valid against a build linked -pthread and initialised with '
                         'sr_os_init() (SR_OS_HLE); against any other build these arm '
                         'candidates that fault on replay.')
    ap.add_argument('--new-only', action='store_true',
                    help='arm ONLY entries that the --host set newly unblocks, i.e. '
                         'those refused by the same gate without it.  This is what '
                         'makes a capture run evidence FOR the boundary rather than a '
                         'resample of what already worked.')
    ap.add_argument('--shapes-only', action='store_true',
                    help='run the OFFLINE candidate census and exit -- no Dolphin, no '
                         'probe lock.  Always do this before taking the lock.')
    ap.add_argument('--survey', action='store_true')
    ap.add_argument('--max-arm', type=int, default=300)
    ap.add_argument('--min-body', type=lambda x: int(x, 0), default=0x20,
                    help='skip bodies smaller than this (default 8 instructions). A '
                         '1-instruction capture records steps=1 writes=0 and asserts '
                         'nothing while still counting as a pass.')
    ap.add_argument('--max-closure', type=int, default=40,
                    help='skip candidates whose static callee closure exceeds this. A '
                         'huge closure is a long single-step trace, and the trace is '
                         'the entire cost of a capture.')
    ap.add_argument('--max-body', type=lambda x: int(x, 0), default=0x2000)
    ap.add_argument('--arm-offsets', help='file of absolute addresses to arm instead')
    ap.add_argument('--gfx', default='Null')
    ap.add_argument('--oracle-bin', default=None)
    # ---- survey_waves knobs (names must match; see fixture_rel.survey_waves)
    ap.add_argument('--max-steps', type=int, default=20000)
    ap.add_argument('--wave', type=int, default=24)
    ap.add_argument('--wave-budget', type=float, default=180.0)
    ap.add_argument('--cont-timeout', type=float, default=180.0)
    ap.add_argument('--anchor-off', type=lambda x: int(x, 16), default=None)
    ap.add_argument('--anchor-budget', type=float, default=60.0)
    ap.add_argument('--enum-idle', type=float, default=45.0)
    ap.add_argument('--enum-budget', type=float, default=420.0)
    ap.add_argument('--capture-budget', type=float, default=0.0)
    a = ap.parse_args()

    img = sr.Image.from_dol(a.image)
    syms = sr.load_map(a.map)
    units = sr.recover_boundaries(img, syms, a.boundaries)
    byaddr = {lo: (sz, nm) for lo, sz, nm in units}
    print(f"[dol] {len(byaddr)} function boundaries ({a.boundaries}), "
          f"{sum(s // 4 for s, _ in byaddr.values())} instructions")

    hosts = {int(x, 16) for x in a.host}
    if a.irq_hosts:
        hosts |= set(IRQ_HOSTS)
    if a.clock_hosts:
        hosts |= set(CLOCK_HOSTS)
    if a.ctx_hosts:
        hosts |= set(CTX_HOSTS)
    if a.hle_hosts:
        hosts |= set(HLE_HOSTS)
    if hosts:
        print("[shapes] host-bound (closure stops here, sr_host_hook services it): "
              + ", ".join(f"{h:#010x}" for h in sorted(hosts)))

    t0 = time.time()
    rows = classify_dol(img, byaddr, a.min_body, hosts=hosts)
    print(f"[shapes] classified in {time.time() - t0:.1f}s")
    SH.report(rows)

    # THE DELTA, measured with the SAME instrument on the SAME tree.  Without this a
    # "+N unblocked" claim would compare two different runs; here both numbers come
    # from one process, one image and one classify() implementation.
    newly = set()
    if hosts:
        base_rows = classify_dol(img, byaddr, a.min_body)
        base_ok = {r["addr"] for r in base_rows if r["blocked"] is None}
        now_ok = {r["addr"] for r in rows if r["blocked"] is None}
        newly = now_ok - base_ok
        lost = base_ok - now_ok
        ni = sum(byaddr[x][0] // 4 for x in newly)
        nt = sum(s // 4 for s, _ in byaddr.values())
        print(f"[shapes] BASELINE (no --host): {len(base_ok)} closure-clean")
        print(f"[shapes] WITH --host        : {len(now_ok)} closure-clean")
        print(f"[shapes] NEWLY UNBLOCKED    : {len(newly)} functions, {ni} instructions "
              f"({100.0 * ni / nt:.2f}% of .text)"
              + (f"   [WARNING: {len(lost)} regressed]" if lost else ""))
    if a.new_only:
        if not hosts:
            print("--new-only needs --host/--irq-hosts", file=sys.stderr)
            sys.exit(1)
        rows = [r for r in rows if r["addr"] in newly or r["blocked"] is not None]
        print(f"[shapes] --new-only: candidate pool restricted to the "
              f"{len(newly)} newly-unblocked entries")

    # THE ARM SET.  rel_shapes.arm_list already applies "closure-clean AND >= min_size"
    # and round-robins across shape buckets rarest-first; the extra gates here are
    # cost-shaped, not correctness-shaped.
    elig = [r for r in rows if r["blocked"] is None
            and a.min_body <= r["size"] <= a.max_body
            and r["closure"] <= a.max_closure]
    print(f"[shapes] eligible after size {a.min_body:#x}..{a.max_body:#x} and "
          f"closure <= {a.max_closure}: {len(elig)} of {len(rows)}")
    sel = SH.arm_list(elig, a.max_arm, min_size=a.min_body)
    print("[shapes] selected: " + ", ".join(
        f"{k}={v}" for k, v in
        collections.Counter(r["shape"] for r in sel).most_common()))
    shape_by = {r["addr"]: r["shape"] for r in rows}
    census_by = {r["addr"]: r["census"] for r in rows}

    if a.arm_offsets:
        arm = []
        for ln in open(a.arm_offsets):
            ln = ln.split('#')[0].strip()
            if ln:
                arm.append(int(ln, 16))
    else:
        arm = [r["addr"] for r in sel]

    censusfile = os.path.splitext(OUT)[0] + ".candidates.json"
    json.dump({"boundaries": a.boundaries, "n_functions": len(rows),
               "hosts": [f"{h:#010x}" for h in sorted(hosts)],
               "new_only": bool(a.new_only),
               "newly_unblocked": [f"{h:#010x}" for h in sorted(newly)],
               "n_clean_closure": sum(1 for r in rows if r["blocked"] is None),
               "n_eligible": len(elig), "armed": [f"{x:#010x}" for x in arm],
               "shape_counts": dict(collections.Counter(
                   r["shape"] for r in rows if r["blocked"] is None)),
               "blocked_reasons": dict(collections.Counter(
                   r["blocked"].split("(")[0].strip()
                   for r in rows if r["blocked"])),
               "rows": [{k: v for k, v in r.items() if k != "census"} for r in rows]},
              open(censusfile, "w"), indent=1)
    print(f"[shapes] wrote {censusfile}")

    if a.shapes_only or not a.survey:
        return

    obin, sver, srev = O.pick_oracle(a.state)
    if a.oracle_bin:
        obin = a.oracle_bin
    print(f"[state] STATE_VERSION={sver} revision={srev!r}")
    dol = O.Dolphin(iso=a.iso, state=a.state, port=PORT,
                    log=f"/tmp/sr_dol_oracle_{PORT}.log", dual_core=True,
                    binary=obin, gfx=a.gfx,
                    extra=["-C", "Dolphin.Core.CPUCore=0"])   # REFERENCE INTERPRETER
    print(f"[oracle] {obin} port={PORT} core=interpreter state={a.state}")
    out = {"game": "GSNE8P", "oracle": "native Dolphin interpreter (CPUCore=0)",
           "capture": "gamecube/recomp/sr/fixture_dol.py",
           "oracle_binary": obin, "state": a.state, "boundaries": a.boundaries,
           "n_armed": len(arm), "fixtures": [], "refused": []}
    try:
        g = dol.connect()
        pc0 = g.pc()
        print(f"[oracle] connected; pc={pc0:#010x}")
        # A STATE THAT FAILS TO RESTORE SILENTLY COLD-BOOTS and every number
        # downstream still looks plausible (CLAUDE.md gate #10; README §5h).
        if pc0 == DOL_ENTRY_PC:
            raise SystemExit(f"connect pc == {DOL_ENTRY_PC:#010x}, the DOL entry point: "
                             f"the savestate did NOT restore, this is a cold boot")
        osyms = O.load_map(a.map)

        def on_fixture(fx, off):
            fx["gqr"] = read_gqrs(g)
            fx["ps1_dependency"] = [[f"{p:#010x}", f"{w:08x}", why]
                                    for p, w, why in ps1_dependency(fx["stream"])]
            fx["n_calls"] = sum(1 for _, w in fx["stream"]
                                if ((w >> 26) & 0x3F) == 18 and (w & 1))
            fx["entered"] = sorted({f"{pc:#010x}" for pc, _ in fx["stream"]
                                    if pc in byaddr})
            # A --jumptables run over a trace that never reaches a `bctr` proves
            # nothing about jump tables; record it so a vacuous pass is visible.
            fx["bctr_executed"] = [f"{pc:#010x}" for pc, w in fx["stream"]
                                   if ((w >> 26) & 0x3F) == 19
                                   and ((w >> 1) & 0x3FF) == 528 and not (w & 1)]
            fx["blrl_executed"] = [f"{pc:#010x}" for pc, w in fx["stream"]
                                   if ((w >> 26) & 0x3F) == 19
                                   and ((w >> 1) & 0x3FF) == 16 and (w & 1)]
            fx["shape"] = shape_by.get(off)
            fx["census"] = census_by.get(off)
            del fx["stream"]
            # A MISSING VERDICT MUST NOT READ AS A PASSING ONE (README §5b / 1ed82194).
            bad = []
            if not fx["returned"]:   bad.append("did not return (capture truncated)")
            if fx["unknown_stores"]: bad.append(f"{len(fx['unknown_stores'])} unknown store forms")
            if fx["ps1_dependency"]: bad.append(f"{len(fx['ps1_dependency'])} undefined PS1-lane reads")
            fx["usable"] = not bad
            fx["unusable_reason"] = "; ".join(bad) if bad else None
            print(f"    steps={fx['steps']} returned={fx['returned']} "
                  f"bl={fx['n_calls']} writes={len(fx['writes'])} "
                  f"initial_bytes={len(fx['initial_mem'])} "
                  f"unknown={len(fx['unknown_stores'])} "
                  f"outside_mem1={len(fx['outside_mem1'])} "
                  f"ps1_dep={len(fx['ps1_dependency'])} "
                  f"bctr={len(fx['bctr_executed'])} blrl={len(fx['blrl_executed'])} "
                  f"usable={fx['usable']}", flush=True)
            out["fixtures"].append(fx)
            json.dump(out, open(OUT, "w"))

        def on_refusal(off, entry, why, quiet=False):
            if not quiet:
                print(f"    REFUSED: {why}", flush=True)
            out["refused"].append({"entry": entry, "why": why,
                                   "shape": shape_by.get(off)})
            json.dump(out, open(OUT, "w"))

        def on_executed(fired):
            out["executed"] = [f"{x:#010x}" for x in fired]
            json.dump(out, open(OUT, "w"))
            print(f"[survey] {len(fired)} of {len(arm)} armed entries executed here",
                  flush=True)

        try:
            ndone, anchor = survey_waves(a, g, 0, byaddr, arm, osyms, None,
                                         on_fixture, on_refusal, on_executed)
            out["survey_anchor"] = f"{anchor:#010x}" if anchor else None
        except Exception as e:                                   # noqa: BLE001
            print(f"[survey] ABORTED: {type(e).__name__}: {e}", file=sys.stderr)
            out["aborted"] = f"{type(e).__name__}: {e}"
        json.dump(out, open(OUT, "w"))
        nun = sum(1 for f in out["fixtures"] if f.get("usable") is False)
        nout = sum(1 for f in out["fixtures"] if f.get("outside_mem1"))
        print(f"[survey] wrote {OUT}: {len(out['fixtures'])} captured "
              f"({nun} marked unusable, {nout} touch addresses outside MEM1), "
              f"{len(out['refused'])} refused, of {len(arm)} armed")
    finally:
        dol.kill()


if __name__ == '__main__':
    main()

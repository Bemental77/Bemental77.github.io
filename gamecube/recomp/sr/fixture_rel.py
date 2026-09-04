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
import argparse, collections, json, os, struct, sys, time

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

# OSLink.c:81-82 -- the guest OS's OWN registry of linked modules, at fixed
# low-memory addresses.  Reading it is exact base recovery: no scan, no signature,
# no heuristic, and it enumerates EVERY resident overlay rather than confirming a
# guess about one.
OS_MODULE_INFO_LIST = 0x800030C8      # OSModuleQueue {head, tail}
OS_STRING_TABLE = 0x800030D0
DOL_ENTRY_PC = 0x80003140             # a connect here means the state did NOT restore

# Dolphin rejects a savestate whose STATE_VERSION differs (State.cpp:723) and then
# SILENTLY COLD-BOOTS, which is what made seven overlay attempts look like boot-speed
# problems.  Map cookie version -> the binary on this machine that can read it.
# Oracle selection by state-file version lives in native_oracle_gdb.pick_oracle().

def read_module_list(g):
    """Walk __OSModuleInfoList out of the live machine.

    Returns [ {id, name, sections: {idx: (addr, size, exec)}} ] in link order.
    OSLink.c:216-238 makes every one of these fields ABSOLUTE once the module is
    linked, so the executable section's address here IS the overlay's runtime base --
    the quantity seven previous attempts tried to recover by breakpoint-LR arithmetic
    and then by a MEM1 signature scan."""
    def u32(a):
        return struct.unpack('>I', g.mem(a, 4))[0]

    mods, seen = [], set()
    m = u32(OS_MODULE_INFO_LIST)
    while m and MEM1_LO <= m < MEM1_HI and m not in seen and len(mods) < 64:
        seen.add(m)
        mid, nxt, nsec = u32(m + 0x00), u32(m + 0x04), u32(m + 0x0C)
        sinfo, noff = u32(m + 0x10), u32(m + 0x14)
        name = ""
        if MEM1_LO <= noff < MEM1_HI:
            try:
                name = g.mem(noff, 64).split(b"\0")[0].decode("ascii", "replace")
            except Exception:
                pass
        secs = {}
        if MEM1_LO <= sinfo < MEM1_HI and 0 < nsec < 64:
            blob = g.read_range(sinfo, sinfo + 8 * nsec)
            for i in range(nsec):
                off, size = struct.unpack_from('>II', blob, 8 * i)
                if size:
                    secs[i] = (off & ~1, size, bool(off & 1))
        mods.append({"info": m, "id": mid, "name": name, "sections": secs})
        m = nxt
    return mods


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


def patched_byte_offsets(rel, sec):
    """EVERY byte offset OSLink's Relocate() may rewrite -- not just the word-aligned ones.

    THIS IS A REAL BUG THIS FILE SHIPPED.  Measured on stg13D: of 18,818 relocation
    sites in the executable section, 12,790 (68.0%) sit at `site_off % 4 == 2` -- the
    immediate half of a `lis`/`addi` pair, which R_PPC_ADDR16_HA/LO patch via
    `*(u16*)p` (OSLink.c:170-181).  Only the 6,028 R_PPC_REL24 sites are word aligned.
    Both confirm_base() and pick_signature() tested `(off + k) for k in range(0, n, 4)`,
    so they were blind to 68% of the relocations: they would call a window
    "relocation-free" when it contained an ADDR16 patch, then compare it against live
    memory and see a legitimate difference as a MISMATCH.

    Consequence, observed: with the CORRECT base 0x811fff48 handed over by the guest
    OS's own module list, confirm_base() still reported FAILED.  The same blindness
    would have made the signature scan pick an unmatchable window, so this defeats the
    scan route too -- a seventh distinct cause, independent of the six already recorded.

    Patch widths, from Relocate():
      R_PPC_ADDR16* (3,4,5,6)  -> `*(u16*)p`, 2 bytes at the site
      R_PPC_ADDR32 (1)         -> `*p`,       4 bytes
      R_PPC_REL24/ADDR24 (10,2)-> `*p & ~0x03fffffc`, within the 4-byte word
    """
    out = set()
    for _, r in rel.all_relocs():
        if r["site_sec"] != sec:
            continue
        o, t = r["site_off"], r["type"]
        n = 2 if t in (R.R_PPC_ADDR16, R.R_PPC_ADDR16_LO,
                       R.R_PPC_ADDR16_HI, R.R_PPC_ADDR16_HA) else 4
        out.update(range(o, o + n))
    return out


def pick_signature(blob, reloc_offs, want=32, tries=4000):
    """A distinctive, RELOCATION-FREE window of the overlay's exec section.

    It must avoid relocation sites (OSLink patches those in memory, so they will not
    match the file) and must not be a run of one byte, or it matches everywhere."""
    best = None
    n = len(blob)
    for off in range(0, min(n - want, tries * 64), 64):
        # EVERY byte, not every 4th: 68% of stg13D's relocation sites are the
        # ADDR16_HA/LO immediate at off%4==2 -- see patched_byte_offsets().
        if any((off + k) in reloc_offs for k in range(want)):
            continue
        w = blob[off:off + want]
        distinct = len(set(w))
        if distinct < 12:
            continue
        if best is None or distinct > best[0]:
            best = (distinct, off, w)
        if distinct >= 28:
            break
    return (best[1], best[2]) if best else (None, None)


def scan_for_base(g, sig, sig_off, lo, hi, chunk=0x8000):
    """Find the overlay by SEARCHING MEM1 for a relocation-free signature.

    WHY NOT THE LR TRICK.  Recovering the base from a breakpoint's LR assumes the DOL
    helper was reached by a `bl`.  Measured on titleD: every hit reported LR as a
    CONSTANT top-of-MEM1 value (0x811fff80 / 0x811fff84 / 0x811fffa8, byte-identical
    across dozens of hits of the same target), i.e. a stale stack-ish value, because
    those helpers are entered by a TAIL BRANCH which does not write LR.  A stale LR
    yields a plausible-looking base that never confirms.  A direct scan does not care
    how the callee was entered."""
    step = chunk - len(sig)
    addr = lo
    while addr < hi:
        end = min(addr + chunk, hi)
        try:
            buf = g.read_range(addr, end, chunk=0x400)
        except Exception:
            addr += step
            continue
        i = buf.find(sig)
        while i >= 0:
            hit = addr + i
            base = (hit - sig_off) & 0xFFFFFFFF
            yield base, hit
            i = buf.find(sig, i + 1)
        addr += step


def a_scan_windows(a, blob):
    """Where to look, narrowest-first.  A REL is OSAlloc'd from the arena, which
    begins above the DOL's BSS, so the low MEM1 region cannot contain it."""
    bss_end = 0x801de600 + 1900309          # DOL header: BSS addr + size
    hi = MEM1_HI
    if a.scan_lo:
        return [(int(a.scan_lo, 16), hi, 'user-specified')]
    mid = 0x81000000
    return [(mid, hi, 'upper arena — where the earlier LR values pointed'),
            ((bss_end + 0xFFF) & ~0xFFF, mid, 'lower arena, above the DOL BSS')]


def confirm_base(g, rel, sec, base, patched, blob, samples=16, window=0x400):
    """Byte-compare live memory against the shipped section.

    ACCEPTANCE: every byte that differs must lie inside a relocation site's patched
    range (OSLink rewrites exactly those), and nothing else may differ.  That is far
    stronger than the previous "find a window with no relocations and require equality"
    -- which was also unusable here: stg13D has one relocation per ~20 bytes, so a
    32-byte relocation-free window is rare, and the old aligned-only test only *looked*
    like it was finding them because it was blind to the 68% of sites at off%4==2.

    Reads contiguous KB-sized regions rather than sampling every Nth word, so the
    evidence is "N,NNN bytes agree except at known patch sites", not "3 windows matched".
    """
    n = len(blob)
    if samples < 1:
        return False, 0
    step = max(window, n // samples)
    checked = mismatched = 0
    for off in range(0, max(1, n - window), step):
        addr = base + off
        if not (MEM1_LO <= addr and addr + window <= MEM1_HI):
            return False, checked
        try:
            live = g.read_range(addr, addr + window, chunk=0x400)
        except Exception:
            return False, checked
        ref = blob[off:off + window]
        for i in range(len(ref)):
            if live[i] != ref[i] and (off + i) not in patched:
                mismatched += 1
        checked += len(ref)
    if mismatched:
        print(f"[confirm] {mismatched} byte(s) differ OUTSIDE any relocation site "
              f"over {checked} bytes compared", file=sys.stderr)
    return mismatched == 0 and checked >= window, checked


def prep_rel(disc, relname):
    """Parse one overlay off the disc. -> (ent, rel, sec, blob, reloc_offs, sites).

    Split out of main() because WHICH overlay is being surveyed is not always known
    before Dolphin is running: a cold boot links whatever module the game gets to
    first, and paying the boot again to re-run with the right --rel is not affordable
    (measured: 900 s of wall clock bought ~29 s of emulated boot and still had no
    module linked).  So the identity comes from the machine and the parse happens
    after."""
    ent = next(f for f in disc.files
               if f["name"] == relname or f["path"].endswith(relname))
    rel = R.Rel(disc.read_file(ent), ent["path"])
    execs = rel.exec_sections()
    if len(execs) != 1:
        print(f"[rel] {relname} has {len(execs)} executable sections; this tool "
              f"assumes 1", file=sys.stderr)
        sys.exit(2)
    sec = execs[0]["idx"]
    blob = rel.section_bytes(sec)
    # BYTE offsets, not site offsets: 68% of the sites patch a 2-byte immediate at
    # off%4==2 and an aligned-only test is blind to them.  See patched_byte_offsets().
    reloc_offs = patched_byte_offsets(rel, sec)
    sites = dol_call_sites(rel)
    print(f"[rel] {ent['path']} id={rel.id} v{rel.version} exec sec={sec} "
          f"{len(blob)} bytes ({len(blob)//4} instructions)")
    print(f"[rel] {len(reloc_site_offsets(rel, sec))} relocation sites covering "
          f"{len(reloc_offs)} patchable bytes in section {sec}")
    print(f"[rel] {len(sites)} distinct DOL call targets, "
          f"{sum(len(v) for v in sites.values())} REL24 sites")
    return ent, rel, sec, blob, reloc_offs, sites


def rel_by_module_id(disc):
    """module id -> .rel file name, read from each REL's own header.

    OSLink registers a module by ID, not by name, and the name in the module list is
    the ORIGINAL BUILD PATH ('c:\\sonic2gc\\cw\\output\\stg13D.plf') -- a .plf, not the
    .rel that shipped.  The id is authoritative and is the first u32 of the header."""
    out = {}
    for f in disc.files:
        if not f["name"].lower().endswith(".rel"):
            continue
        try:
            mid = struct.unpack('>I', disc.read_file(f)[:4])[0]
        except Exception:
            continue
        out.setdefault(mid, f["name"])
    return out


def wait_for_link(g, oslink_pc, budget, poll=None):
    """Advance a COLD BOOT until the guest OS finishes linking a module.

    ANCHOR: OSLink itself.  It is not in SAB's symbol map, but it is the only DOL
    function that STORES to __OSModuleInfoList (0x800030C8) and also LOADS
    __OSStringTable (0x800030D0) and the queue head -- which is exactly the shape of
    OSLink.c:213-273 (ENQUEUE_INFO, then the `if (__OSStringTable)` name fixup, then
    the `for (moduleInfo = __OSModuleInfoList.head; ...)` relocate-everything loop).
    In SAB's main.dol that is 0x800e839c; OSUnlink (0x800e87f8) writes the queue too
    but never reads the string table.

    WHY AN ANCHOR AND NOT POLLING.  Polling the module list means stopping the guest,
    and the guest is the scarce resource: the reference interpreter runs SAB at
    ~0.0328x real time, so every stop is paid for in emulated seconds that the boot
    needs.  One breakpoint that fires EXACTLY ONCE, at the moment a module becomes
    resident, costs nothing until it matters.

    The stop is at OSLink's ENTRY, where the module is NOT yet enqueued and NOT yet
    relocated -- reading the list there would report the module missing and reading
    the section would return unrelocated bytes.  So this then breakpoints the return
    address in LR and continues, and only reports success once OSLink has returned.
    """
    def wait_for(pc_want, deadline, label):
        """cont ONCE, then read stop packets until `pc_want` or the deadline.

        `g.cont()` is deliberately NOT used in the loop: it SENDS 'c' every call, and
        after a timeout the guest is still running with the stub not listening, so the
        extra 'c' is queued and resumes the guest behind our back.  Send once, then
        await_stop() -- a timeout there means "not yet", not "act"."""
        g.settle()
        g.send_cont()
        while time.time() < deadline:
            try:
                rep = g.await_stop(timeout=min(60.0, max(5.0, deadline - time.time())))
            except (OSError, TimeoutError):
                print(f"[oslink]   t+{time.time() - t0:.0f}s  {label}", flush=True)
                continue
            if O.GDB.stop_pc(rep) == pc_want:
                g.resync()
                return True
            g.resync()
            g.send_cont()
        return False

    t0 = time.time()
    g.add_bp(oslink_pc)
    hit = wait_for(oslink_pc, t0 + budget, "still booting")
    g.del_bp(oslink_pc)
    if not hit:
        return False
    lr = g.reg(67)
    print(f"[oslink] OSLink entered at t+{time.time() - t0:.0f}s; "
          f"returns to {lr:#010x}", flush=True)
    t1 = time.time()
    g.add_bp(lr)
    ok = wait_for(lr, t1 + max(120.0, budget - (t1 - t0)), "waiting for OSLink to return")
    g.del_bp(lr)
    g.resync()
    if not ok:
        print("[oslink] OSLink never returned; the module may be only partly linked",
              file=sys.stderr)
        return False
    print(f"[oslink] OSLink returned after {time.time() - t1:.0f}s — the module is "
          f"enqueued AND relocated", flush=True)
    return True


def survey_waves(a, g, base, bodies, arm, osyms, prefetch, on_fixture, on_refusal,
                 on_executed=lambda fired: None):
    """Capture each candidate AT THE MOMENT ITS BREAKPOINT FIRES.

    THE TWO THINGS THIS FIXES, both measured on this rig 2026-09-04:

    1. DISCOVER-THEN-CAPTURE LOSES EXACTLY THE FUNCTIONS WORTH SURVEYING.  The old
       flow noted which entries fired, then re-armed each one and waited for it to be
       reached AGAIN.  A function that runs once per scene never is.  Capturing at the
       fire needs the entry to be reached ONCE.

    2. A BOUNDED `cont` IS NOT A LEGAL WAY TO GIVE UP.  `cont()` sends 'c' and the
       guest keeps running; this stub has no async break, so abandoning the read and
       sending anything else leaves the client permanently one packet behind.  With a
       15 s deadline that produced ConnectionResetError, then BrokenPipeError on every
       subsequent capture -- 8 refusals that were all one client-side desync.  So this
       NEVER abandons a cont: an ANCHOR breakpoint on a frequently-executed entry
       guarantees a stop arrives, and control is handed back by that instead.

    Waves exist because the candidate breakpoints have to come off before single-
    stepping (a step onto an armed address risks an extra unsolicited Sigtrap, which
    is the desync `resync()` exists for) and go back on afterwards.  That is 2*W
    packets per capture, so W is a cost knob, not a correctness one.

    ARMED-SET SIZE IS ALSO WHY THE OLD DISCOVERY SAW SO LITTLE.  With 300 breakpoints
    armed on per-frame functions the interpreter is stopped almost continuously and
    buys almost no EMULATED time: 300 s of wall clock reached only 10 distinct entries
    of 300.  Deleting each candidate once it has been captured makes the guest get
    progressively faster through a wave.
    """
    # ---------------------------------------------------------------- ENUMERATE
    # WHICH CANDIDATES ACTUALLY EXECUTE IN THIS SCENE.  A shape-spread candidate set
    # is chosen for coverage, not for relevance: most of it does not run in a parked
    # scene at all, and arming 32 of them at a time and waiting produced waves that
    # captured 0 of 32 twice in a row.
    #
    # DELETE ON FIRE is what makes this cheap.  Leaving a breakpoint armed after it
    # has fired means the interpreter keeps stopping on the same per-frame functions
    # and buys almost no EMULATED time -- the reason the first attempt saw only 10 of
    # 300 entries in 300 s of wall clock.  Removing each one as it fires makes the
    # guest monotonically faster, so a full frame's worth of overlay calls is
    # enumerated in roughly one stop per candidate rather than one stop per call.
    #
    # ONE breakpoint must survive: the ANCHOR.  There is no async break, so when the
    # last armed breakpoint is deleted a `cont` never returns and the client cannot
    # legally send anything.  The FIRST candidate to fire is kept armed for that job
    # -- first to fire is the most frequent thing in the scene, which is exactly what
    # a control anchor needs to be.
    # WHICH candidate is the anchor is a first-order cost, not a detail.  Taking the
    # FIRST ONE TO FIRE was tried and is wrong for the same reason OSDisableInterrupts
    # was wrong as a boot anchor: first-to-fire IS the hottest function in the scene,
    # so the interpreter stops on it constantly and buys no emulated time -- 480 s of
    # enumeration under that choice never reached even 25 distinct entries.  So spend
    # a short calibration measuring RATES, and take the RAREST candidate that still
    # guarantees a stop inside a quarter of a wave.  Calibration runs with every
    # candidate armed, i.e. the slowest regime, so a period measured there is an upper
    # bound on the period later; the guarantee only gets stronger.
    anchor_off = a.anchor_off
    for off in arm:
        g.add_bp(base + off)
    if anchor_off is None:
        print(f"[survey] calibrating an anchor over {a.anchor_budget:.0f}s ...",
              flush=True)
        hits, t0 = collections.Counter(), time.time()
        while time.time() - t0 < a.anchor_budget:
            rep = g.cont(timeout=a.cont_timeout)
            pc = O.GDB.stop_pc(rep)
            if pc is not None and (pc - base) in bodies:
                hits[pc - base] += 1
            g.resync(quiet=0.05)
        if not hits:
            for off in arm:
                g.del_bp(base + off)
            raise O.RSPError("no candidate fired during calibration; without one armed "
                             "breakpoint that can hand control back there is no safe "
                             "way to run a capture wave (this stub has no async break)")
        want_period = max(1.0, a.wave_budget / 4.0)
        okc = [(a.anchor_budget / n, off) for off, n in hits.items()
               if a.anchor_budget / n <= want_period]
        period, anchor_off = max(okc) if okc else \
            (a.anchor_budget / hits.most_common(1)[0][1], hits.most_common(1)[0][0])
        if not okc:
            print(f"[survey] WARNING: nothing fires at least every {want_period:.0f}s; "
                  f"using the most frequent candidate anyway", file=sys.stderr)
        print(f"[survey] anchor = +{anchor_off:#x} ({base + anchor_off:#010x}), "
              f"{hits[anchor_off]} hits in {a.anchor_budget:.0f}s = one per "
              f"{period:.1f}s (rarest that still fires within {want_period:.0f}s); "
              f"{len(hits)} candidates fired during calibration", flush=True)

    pending = set(arm)
    pending.discard(anchor_off)
    fired = [anchor_off] if anchor_off in set(arm) else []
    print(f"[survey] enumerating which of {len(arm)} candidates execute here "
          f"(delete-on-fire, up to {a.enum_budget:.0f}s) ...", flush=True)
    # LEAVE WHILE CONTROL IS STILL AVAILABLE.  Enumeration used to run its full
    # budget, and that lost a whole second-overlay run: otherprintD.rel is linked 52 s
    # into a cold boot for a transient boot screen, 10 of its 31 candidates fired
    # within 98 s, and then the screen moved on -- nothing fired again, the `cont`
    # blocked past --cont-timeout, and because abandoning a cont is not recoverable
    # the run aborted with 0 captured. Stopping after --enum-idle seconds without a
    # NEW candidate exits the phase while stops are still arriving, so the capture
    # wave gets the rest of the scene instead of the run getting nothing.
    t0 = last_new = time.time()
    while pending and time.time() - t0 < a.enum_budget:
        if time.time() - last_new > a.enum_idle:
            print(f"[survey] no new candidate for {a.enum_idle:.0f}s — ending "
                  f"enumeration early at t+{time.time() - t0:.0f}s", flush=True)
            break
        rep = g.cont(timeout=a.cont_timeout)
        pc = O.GDB.stop_pc(rep)
        off = (pc - base) if pc is not None else None
        if off in pending:
            fired.append(off)
            last_new = time.time()
            g.del_bp(base + off)
            pending.discard(off)
            if len(fired) % 10 == 0:
                print(f"[survey]   {len(fired)} fired, {len(pending)} still armed, "
                      f"t+{time.time() - t0:.0f}s", flush=True)
        g.resync(quiet=0.05)
    for off in pending:
        g.del_bp(base + off)
    g.del_bp(base + anchor_off)
    g.resync()
    if anchor_off is None:
        raise O.RSPError("no candidate fired at all; without one armed breakpoint "
                         "that can hand control back, a capture wave cannot be run "
                         "safely (there is no async break)")
    print(f"[survey] {len(fired)} of {len(arm)} candidates executed in "
          f"{time.time() - t0:.0f}s; {len(pending)} never did", flush=True)
    # RECORD THE EXECUTED SET.  It is the survey's real denominator -- what this scene
    # exercises at all -- and it is expensive to rediscover (this pass is the single
    # longest phase).  A later targeted run can skip straight to capture with
    # --arm-offsets built from it.
    on_executed(fired)
    for off in sorted(pending):
        on_refusal(off, base + off,
                   f"never executed in {a.enum_budget:.0f}s of this scene", quiet=True)
    anchor = base + anchor_off

    todo = [o for o in arm if o in set(fired)]
    done, t_all = 0, time.time()
    W = max(1, a.wave)
    i = 0
    while i < len(todo):
        if a.capture_budget and time.time() - t_all >= a.capture_budget:
            print(f"[survey] budget {a.capture_budget:.0f}s spent; "
                  f"{len(todo) - i} candidate(s) not attempted", flush=True)
            break
        wave = [o for o in todo[i:i + W] if o != anchor_off]
        i += W
        if not wave:
            continue
        live_set = set(wave)
        for off in live_set:
            g.add_bp(base + off)
        g.add_bp(anchor)
        t_w = time.time()
        while live_set and time.time() - t_w < a.wave_budget:
            if a.capture_budget and time.time() - t_all >= a.capture_budget:
                break
            rep = g.cont(timeout=a.cont_timeout)
            pc = O.GDB.stop_pc(rep)
            off = (pc - base) if pc is not None else None
            if off not in live_set:
                g.resync(quiet=0.05)
                continue
            # Stopped AT the entry.  Take every breakpoint off before stepping.
            for o in live_set:
                g.del_bp(base + o)
            g.del_bp(anchor)
            entry = base + off
            print(f"[capture] {entry:#010x} (+{off:#x}) ...", flush=True)
            try:
                fx = O.capture_replayable_fixture(
                    g, entry, syms=osyms, max_steps=a.max_steps, progress=5000,
                    prefetch=prefetch, at_entry=True)
                on_fixture(fx, off)
                done += 1
            except Exception as e:
                on_refusal(off, entry, f"{type(e).__name__}: {e}")
            live_set.discard(off)
            for o in live_set:
                g.add_bp(base + o)
            g.add_bp(anchor)
        for o in live_set:
            g.del_bp(base + o)
        g.del_bp(anchor)
        g.resync()
        if live_set:
            for o in sorted(live_set):
                on_refusal(o, base + o,
                           f"executed during enumeration but not again within "
                           f"{a.wave_budget:.0f}s of its capture wave", quiet=True)
        print(f"[survey] wave done: {len(wave) - len(live_set)}/{len(wave)} captured; "
              f"{done} total in {time.time() - t_all:.0f}s", flush=True)
    return done, anchor_off


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--iso', default=O.SAB_ISO)
    ap.add_argument('--rel', default='stg13D.rel')
    ap.add_argument('--state', default=O.SAB_STATE)
    ap.add_argument('--map', default=os.path.join(REPO, 'dolphin_captures/sab.map'))
    ap.add_argument('--dol', default='/tmp/sr_sab/main.dol',
                    help='extracted main.dol, for the DOL-internal call graph')
    ap.add_argument('--locate-only', action='store_true')
    ap.add_argument('--selftest', action='store_true',
                    help='exercise every offline step (REL parse, DOL call graph, probe '
                         'scoring, signature choice) WITHOUT launching Dolphin. Run this '
                         'before taking the probe lock: two locked runs have already been '
                         'lost to a bad import path and a missing module import.')
    ap.add_argument('--capture-n', type=int, default=3)
    ap.add_argument('--capture-budget', type=float, default=0.0,
                    help='wall-clock seconds for the whole capture phase (0 = no cap). '
                         'A SURVEY needs this: --capture-n alone cannot bound the run '
                         'because a candidate that fired during discovery and then '
                         'never again costs --capture-cont-timeout before it is refused.')
    ap.add_argument('--capture-cont-timeout', type=float, default=20.0,
                    help='seconds to wait for a candidate to be reached again during '
                         'capture.  Exceeded = REFUSED ("never reached"), never a '
                         'partial capture.')
    ap.add_argument('--capture-order', choices=['hits', 'arm'], default='hits',
                    help='hits: capture the most frequently executed first (the default, '
                         'and what a single-function proof wants).  arm: capture in the '
                         'order given by --arm-offsets, which is how a SHAPE-SPREAD '
                         'survey keeps its coverage instead of filling up with whichever '
                         'function the frame loop calls most.')
    ap.add_argument('--arm-offsets',
                    help='file of section offsets (hex, one per line, # comments ok) to '
                         'arm instead of the built-in smallest-body-first selection. '
                         'This is how a survey arms a set chosen OFFLINE by shape '
                         '(leaf/non-leaf, FP, memory, blrl, bctr, x-form update) and by '
                         'whether the function and its whole callee closure actually '
                         'translate -- neither of which body size predicts.')
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
    ap.add_argument('--boot-advance', type=float, default=600.0,
                    help='seconds to advance the boot BEFORE scanning at all')
    ap.add_argument('--scan-chunk', type=lambda x: int(x, 0), default=0x1000,
                    help='bytes per GDB read during the scan; the stub rejects a single '
                         'read of 0x2000, so this stays below that')
    ap.add_argument('--scan-lo', help='override the scan window start (hex)')
    ap.add_argument('--anchor', type=lambda x: int(x, 0),
                    help='hot DOL PC to advance the boot on (default OSDisableInterrupts)')
    ap.add_argument('--oracle-bin', default=None,
                    help='Dolphin to drive.  Default: chosen from the STATE FILE\'s own '
                         'version cookie.  THIS DEFAULT IS THE FIX FOR SEVEN FAILED '
                         'RUNS: the state is STATE_VERSION 177 and the upstream oracle '
                         'is 189, so State.cpp:723 rejected it and Dolphin SILENTLY '
                         'COLD-BOOTED -- which read as "the boot is too slow to reach '
                         'an overlay" rather than "the state never loaded".')
    ap.add_argument('--min-body', type=lambda x: int(x, 0), default=0x20,
                    help='skip overlay entries whose body is smaller than this (default '
                         '0x20 = 8 instructions).  stg13D has hundreds of 4-byte `blr` '
                         'stubs and a one-instruction trace is not evidence.')
    ap.add_argument('--scan', action='store_true',
                    help='force the old MEM1 signature scan instead of reading the '
                         'guest OS module list (only needed if __OSModuleInfoList is '
                         'unusable)')
    ap.add_argument('--survey', action='store_true',
                    help='capture each candidate AT THE MOMENT its breakpoint fires, in '
                         'waves, instead of discovering first and re-reaching each one '
                         'later.  See survey_waves() -- this is what makes breadth '
                         'affordable, and it is also the only shape that does not '
                         'abandon a `cont`.')
    ap.add_argument('--wave', type=int, default=24,
                    help='candidates armed at once in --survey.  Cost knob only: each '
                         'capture disarms and re-arms the wave (2*W packets) because a '
                         'single-step onto an armed address risks the extra Sigtrap '
                         'that resync() exists for.')
    ap.add_argument('--wave-budget', type=float, default=180.0,
                    help='seconds a --survey wave waits for its candidates to execute '
                         'before giving up on the ones that have not.')
    ap.add_argument('--cont-timeout', type=float, default=180.0,
                    help='deadline on ONE stop-packet read in --survey.  Must be '
                         'comfortably longer than the anchor breakpoint\'s period: '
                         'exceeding it is unrecoverable, not a refusal.')
    ap.add_argument('--anchor-off', type=lambda x: int(x, 16), default=None,
                    help='section offset of the --survey control anchor (hex).  '
                         'Default: the first candidate that fires during enumeration.')
    ap.add_argument('--anchor-budget', type=float, default=60.0,
                    help='seconds spent measuring candidate fire RATES so the --survey '
                         'anchor can be the rarest one that still hands control back '
                         'often enough.  Skipped when --anchor-off is given.')
    ap.add_argument('--enum-idle', type=float, default=45.0,
                    help='end enumeration this many seconds after the last NEW '
                         'candidate fired.  A transient scene stops running the '
                         'overlay entirely, and once nothing fires there is no way '
                         'back: this stops while control is still available.')
    ap.add_argument('--enum-budget', type=float, default=420.0,
                    help='seconds to enumerate which candidates execute in this scene '
                         '(--survey), arming all of them and deleting each on its '
                         'first fire.  This is the phase that decides how much of the '
                         'candidate set is even reachable, so give it room.')
    ap.add_argument('--gfx', default='Null',
                    help='Dolphin video backend.  Null by default: a GDB-stub capture '
                         'renders nothing it reads back, and Metal SEGV\'d on the '
                         'CPU-GPU thread during a capture run (Dolphin 2603a, '
                         'EXC_BAD_ACCESS at 0x0, 2026-09-04).')
    ap.add_argument('--wait-oslink', type=float, default=0.0,
                    help='seconds to advance a COLD BOOT waiting for the guest OS to '
                         'link ANY module, anchored on OSLink itself (see '
                         'wait_for_link).  0 = off.  Needed for a second overlay: the '
                         'only SAB savestate on this machine has exactly one module '
                         'resident, so a second .rel can only come from a boot.')
    ap.add_argument('--oslink', type=lambda x: int(x, 16), default=0x800e839c,
                    help='OSLink entry in main.dol.  SAB default 0x800e839c, identified '
                         'structurally, not guessed: it is the only DOL function that '
                         'stores to __OSModuleInfoList (0x800030C8) AND loads '
                         '__OSStringTable (0x800030D0) AND re-reads the queue head, '
                         'which is the exact shape of OSLink.c:213-273.  OSUnlink '
                         '(0x800e87f8) writes the queue but never reads the string '
                         'table; __OSModuleInit (0x800e888c, named in the map) writes '
                         'all three and is 24 bytes.')
    ap.add_argument('--auto-rel', action='store_true',
                    help='survey whichever module the machine actually has resident, '
                         'matched by MODULE ID against every .rel on the disc, instead '
                         'of insisting on --rel.  The name in the module list is the '
                         'original build path of a .plf and cannot be used for this.')
    ap.add_argument('--arm-select', choices=['size', 'shape'], default='size',
                    help='size: the historical smallest-body-first selection.  shape: '
                         'classify every entry IN PROCESS (rel_shapes.py) against the '
                         'live relocated section and round-robin across shape buckets, '
                         'rarest first.  `shape` is what a survey wants and it is the '
                         'only option available on a cold boot, where the overlay '
                         'identity is not known until Dolphin is already running and '
                         'an offline --arm-offsets file cannot have been prepared.')
    a = ap.parse_args()

    disc = R.Disc(a.iso)
    ent, rel, sec, blob, reloc_offs, sites = prep_rel(disc, a.rel)
    dimg = sr.Image.from_dol(a.dol)
    textr = dol_text_ranges(a.iso)
    print("[rel] DOL text (LR in these ranges = a DOL-internal caller, skipped): "
          + ", ".join(f"{lo:#x}..{hi:#x}" for lo, hi in textr))

    # PROBE SELECTION, third revision -- the first two were each wrong for a different
    # reason and both cost a run.
    #   v1 ranked by FEWEST overlay call sites (to minimise base candidates per hit).
    #      Backwards: fewest sites = the RAREST call. 367 hits, none from the overlay.
    #   v2 ranked by MOST overlay call sites. Better signal, but the most-called DOL
    #      helpers are exactly the ones the DOL ITSELF calls constantly, so every armed
    #      breakpoint fires continuously on DOL-internal traffic. Each stop costs a
    #      resync, and with 40 armed the interpreter slowed to 3.0 s of EMULATED time in
    #      ~300 s of wall clock -- 0.010x, versus 0.0328x unimpeded. The breakpoints
    #      were the bottleneck, not the interpreter.
    #   v3 (this): score = overlay call sites / (1 + DOL internal callers). Wanted:
    #      called OFTEN by the overlay and RARELY by the static image, so a stop is
    #      likely to be the signal rather than noise. Both numbers are known ahead of
    #      time -- the overlay's from its relocation table, the DOL's from its own call
    #      graph -- so no guessing is involved.
    dol_callers = collections.Counter()
    for base_, blob_ in dimg.segs:
        for off_ in range(0, len(blob_) - 3, 4):
            w_ = struct.unpack('>I', blob_[off_:off_ + 4])[0]
            if (w_ >> 26) != 18 or not (w_ & 1) or ((w_ >> 1) & 1):
                continue
            li_ = (w_ & 0x03FFFFFC) - (0x04000000 if w_ & 0x02000000 else 0)
            dol_callers[(base_ + off_ + li_) & 0xFFFFFFFF] += 1
    scored = sorted(sites.items(),
                    key=lambda kv: -len(kv[1]) / (1.0 + dol_callers.get(kv[0], 0)))
    probes = scored[:a.probe_targets]
    print(f"[rel] arming {len(probes)} DOL targets for base recovery, ranked by "
          f"overlay-calls / (1 + DOL-internal-callers):")
    for t_, v_ in probes[:6]:
        print(f"       {t_:#010x}  overlay sites={len(v_):4d}  DOL callers="
              f"{dol_callers.get(t_, 0):4d}  score="
              f"{len(v_) / (1.0 + dol_callers.get(t_, 0)):.1f}")

    if a.selftest:
        print(f"[selftest] probes ranked, top 3:")
        for t_, v_ in probes[:3]:
            print(f"    {t_:#010x} overlay={len(v_)} dol={dol_callers.get(t_, 0)}")
        so_, sg_ = pick_signature(blob, reloc_offs)
        assert sg_ is not None, "no relocation-free signature"
        assert blob.count(sg_) == 1, f"signature not unique ({blob.count(sg_)} hits)"
        print(f"[selftest] signature +{so_:#x} {len(sg_)}B, unique in section")
        print(f"[selftest] DOL text ranges: {[(hex(a_), hex(b_)) for a_, b_ in textr]}")
        res_ = R.translate_module_reach(rel)
        n_ = len({off for (s_, off) in res_['entries'] if s_ == sec})
        print(f"[selftest] {n_} overlay entries discovered")
        print("[selftest] OK — every offline path runs; safe to take the lock")
        return

    osyms = O.load_map(a.map)
    try:
        dflt, sver, srev = O.pick_oracle(a.state)
    except Exception as e:
        print(f"[oracle] {e}", file=sys.stderr)
        sys.exit(7)
    obin = a.oracle_bin or dflt
    if a.state:
        print(f"[state] {os.path.basename(a.state)}  STATE_VERSION={sver}  "
              f"revision={srev!r}")
    else:
        print("[state] NONE — COLD BOOT.  Nothing is OSLink'd at the entry point, so "
              "this run depends on --wait-oslink reaching a link.")
    print(f"[oracle] {obin}")
    dol = O.Dolphin(iso=a.iso, state=a.state, port=PORT,
                    log=f"/tmp/sr_rel_oracle_{PORT}.log", dual_core=True,
                    binary=obin, gfx=a.gfx, extra=["-C", "Dolphin.Core.CPUCore=0"])
    print(f"[oracle] port={PORT} core=interpreter state={a.state}")
    base = None
    rel_sections = {}
    try:
        g = dol.connect()
        pc0 = g.pc()
        print(f"[oracle] connected; pc={pc0:#010x}")
        # A savestate that fails to restore SILENTLY COLD-BOOTS and everything
        # downstream still looks plausible.  The DOL entry point is the tell.
        if pc0 == DOL_ENTRY_PC:
            print("[oracle] WARNING: pc is the DOL ENTRY POINT — this is a COLD BOOT, "
                  "not a restored scene.  Overlays load only once the game reaches "
                  "the point that OSLinks them.")

        # DO NOT BUILD THE LOCKED-CACHE READER HERE.  An earlier version did, on the
        # reasoning that building it lazily mid-trace was riskier.  The opposite is
        # true, and it cost a capture run: HIJACKING PC AND RESUMING AT CONNECT TIME
        # DOES NOT WORK ON THIS STUB.  The control that settles it is `read_gqrs`,
        # which is known-good -- the recorded stg13D survey called it after each of
        # its 15 captures and kept capturing -- and which, called at connect, times
        # out on its very first `cont` to its own sentinel.  So it is the connect-time
        # context that is special, not the reader.  Built lazily, the reader first
        # runs at a BREAKPOINT STOP inside a capture, which is exactly the context
        # read_gqrs is proven in.  It writes nothing to guest memory, so there is no
        # `M`-mid-trace concern to trade against this.

        # ------------------------------------- EXACT base recovery: ask the guest OS
        # OSLink registers every linked module in __OSModuleInfoList with ABSOLUTE
        # section addresses.  One read replaces the whole boot-advance + signature-scan
        # apparatus below (which stays only as --scan, for a state where this is empty).
        if not a.scan:
            mods = read_module_list(g)
            # COLD BOOT: nothing is linked yet.  Advance on the OSLink anchor rather
            # than polling, then survey WHATEVER the game linked -- which is the only
            # way to reach a SECOND overlay on this machine, because the one SAB
            # savestate that exists has exactly one module resident (id=13 stg13D)
            # and no mechanism here can write a new one.
            if not mods and a.wait_oslink:
                print(f"[oslink] no module linked; advancing the boot on OSLink "
                      f"{a.oslink:#010x} for up to {a.wait_oslink:.0f}s ...", flush=True)
                if wait_for_link(g, a.oslink, a.wait_oslink):
                    mods = read_module_list(g)
                else:
                    print(f"[oslink] no module was linked within {a.wait_oslink:.0f}s",
                          file=sys.stderr)
            print(f"[modlist] __OSModuleInfoList: {len(mods)} module(s) linked")
            for md in mods:
                ex = [f"sec{i}@{v[0]:#010x} {v[1]}B{' EXEC' if v[2] else ''}"
                      for i, v in sorted(md["sections"].items()) if v[2]]
                print(f"[modlist]   id={md['id']:<4} {md['name']!r}  " + "; ".join(ex))
            # RE-TARGET.  The requested --rel is a guess about what the machine has;
            # the module list is the fact.  Re-parse against the module that is
            # actually resident instead of reporting "not resident" and exiting.
            if a.auto_rel and mods and not any(md["id"] == rel.id for md in mods):
                byid = rel_by_module_id(disc)
                for md in mods:
                    if md["id"] in byid:
                        print(f"[auto-rel] requested {a.rel} (id={rel.id}) is not "
                              f"resident; retargeting to {byid[md['id']]} "
                              f"(id={md['id']}), which is")
                        a.rel = byid[md["id"]]
                        ent, rel, sec, blob, reloc_offs, sites = prep_rel(disc, a.rel)
                        break
                else:
                    print(f"[auto-rel] none of the {len(mods)} resident module id(s) "
                          f"{[md['id'] for md in mods]} matches a .rel on the disc",
                          file=sys.stderr)
            for md in mods:
                if md["id"] == rel.id and sec in md["sections"]:
                    addr, size, isexec = md["sections"][sec]
                    if not isexec:
                        continue
                    if size != len(blob):
                        print(f"[modlist] section {sec} is {size} B live but {len(blob)} B "
                              f"in the file — refusing", file=sys.stderr)
                        continue
                    ok, checked = confirm_base(g, rel, sec, addr, reloc_offs, blob)
                    print(f"[modlist] {a.rel} id={rel.id} sec{sec} base={addr:#010x} "
                          f"byte-confirm={'OK' if ok else 'FAILED'} ({checked} windows)")
                    if ok:
                        base = addr
                        # RECORD EVERY SECTION, not just the executable one.  The
                        # emit path needs the DATA sections too: every `bctr` switch
                        # table in stg13D lives in sec5, and without a runtime base
                        # for it Rel.relocate() cannot produce the table and static
                        # jump-table recovery gets 0 of 23 sites.
                        rel_sections = {i: list(v)
                                        for i, v in sorted(md["sections"].items())}
                    break
            else:
                print(f"[modlist] {a.rel} (id={rel.id}) is NOT resident in this state")

        # ------------------------------------------------- advance the boot, then SCAN
        # LEGACY COLD-BOOT PATH.  Every expensive step below is skipped outright once
        # the module list has handed over a byte-confirmed base, which is the normal
        # case against a restored scene.  It is kept for a state that genuinely does
        # not have the overlay resident.
        #
        # Advancing needs periodic control, and an armed breakpoint is the only
        # reliable way to get it (an async 0x03 break closes this stub's socket --
        # recorded in gamecube/tools/golden_invoke_sab_psmtx.py).  But every stop
        # costs a resync: with 40 targets armed the interpreter managed 3.0 s of
        # EMULATED time in ~300 s wall (0.010x) against 0.0328x unimpeded.  So arm
        # few, count fires, and do NO work per hit.
        for tgt, _ in (probes if base is None else ()):
            g.add_bp(tgt)
        # SCAN COST IS THE BUDGET.  Scanning 0x80100000..0x81800000 at chunk 0x400 is
        # ~57,000 GDB round trips with the guest HALTED throughout, and re-scanning on
        # an interval spent the whole run doing it: measured 1.4 s of EMULATED time in
        # 15 minutes of wall clock (0.0016x), i.e. the scan, not the interpreter and
        # not the breakpoints, was the bottleneck.  So: advance the boot FIRST with no
        # scanning at all, then scan ONCE, over a narrowed window, with big chunks.
        sig_off, sig = pick_signature(blob, reloc_offs) if base is None else (None, None)
        if base is None and sig is None:
            print("[base] no relocation-free signature available", file=sys.stderr)
            sys.exit(6)
        if sig is not None:
            print(f"[base] signature: {len(sig)} bytes at +{sig_off:#x} = "
                  f"{sig[:16].hex()}...")
        t0 = time.time()
        tries = 0
        boot = 0.0 if base is not None else a.boot_advance
        # ADVANCING THE BOOT IS ALL ABOUT NOT LEAVING THE CPU HALTED.
        # GDB.cont() "blocks until a breakpoint hits (no async break exists)" and
        # GDB.resync() ends by calling pc(), which needs a HALTED cpu.  Pairing a long
        # cont timeout with a resync therefore stalls: a probe fires, Dolphin halts the
        # CPU and waits for the client, and the client is sitting in a 30 s timeout.
        # Measured cost of that shape: 1.5 s of emulated time in 600 s = 0.0025x,
        # against 0.0328x for a loop that answers each stop immediately.
        # So: arm ONE hot anchor, keep the timeout short, and re-continue at once.
        # BOOT ADVANCE, fifth revision -- and the fourth one was a REGRESSION.
        # Copied from the loop that actually measured fast, capture_replayable_fixture
        # (gamecube/tools/native_oracle_gdb.py): it issues cont(timeout=120) in a loop
        # and NEVER resyncs inside it.  When the breakpoint does not fire, the guest
        # runs FREELY for the whole timeout -- that is where 0.0328x came from.
        # Two ways to lose it, both measured here:
        #   * resync() inside the loop (rev 4).  resync ends in pc(), which needs a
        #     HALTED cpu, so it blocks while the guest runs: 0.0025x.
        #   * an anchor that is too hot (rev 5).  OSDisableInterrupts fired 2,170,350
        #     times in 900 s = 2,412/s, and the per-stop round trip consumed the run:
        #     0.0004x, SIX TIMES WORSE than the thing it was meant to fix.
        # So: keep the RARE v3 probes armed (they fired 62-73 times in 981 s, which is
        # enough to hand back control and cheap enough to ignore), a long timeout, and
        # NO per-stop work whatsoever.
        if boot:
            print(f"[base] advancing the boot for {boot:.0f}s on {len(probes)} rare "
                  f"probes, long cont, no resync in the loop ...", flush=True)
        last = t0
        while time.time() - t0 < boot:
            remain = boot - (time.time() - t0)
            try:
                g.cont(timeout=max(5.0, min(120.0, remain)))
                tries += 1
            except Exception:
                pass                      # timeout = the guest simply kept running
            if time.time() - last >= 120.0:
                last = time.time()
                print(f"[base]   t+{time.time() - t0:.0f}s  {tries} stops", flush=True)
        for tgt, _ in (probes if boot else ()):
            g.del_bp(tgt)
        if boot:
            g.resync()
            print(f"[base] boot advanced: {tries} stops in {time.time() - t0:.0f}s")

        # The arena RELs are allocated from starts above the DOL's BSS end, so there is
        # no reason to search from 0x80100000.  Narrow to [bss_end, MEM1_HI) and use a
        # big chunk: fewer, larger reads is the whole game here.
        for lo_, hi_, why in (a_scan_windows(a, blob) if base is None else ()):
            print(f"[base] scanning {lo_:#010x}..{hi_:#010x} ({(hi_-lo_)//1024} KB, {why}) "
                  f"chunk={a.scan_chunk:#x} ...", flush=True)
            t1 = time.time()
            found = False
            for cand, hit in scan_for_base(g, sig, sig_off, lo_, hi_, chunk=a.scan_chunk):
                ok, checked = confirm_base(g, rel, sec, cand, reloc_offs, blob)
                print(f"[base]   signature at {hit:#010x} -> base {cand:#010x}  "
                      f"confirm={'OK' if ok else 'no'} ({checked} windows)")
                if ok:
                    base = cand
                    found = True
                    break
            print(f"[base]   window done in {time.time() - t1:.0f}s")
            if found:
                break
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
        shape_by_off, census_by_off = {}, {}
        entries = sorted({off for (s, off) in res["entries"] if s == sec})
        bodies = {E: v for (s, E), v in res["bodies"].items() if s == sec}
        print(f"[rel] {len(entries)} discovered function entries in section {sec}")
        # Prefer SMALL bodies (cheap to single-step) but not TRIVIAL ones: stg13D has
        # hundreds of 4-byte `blr` stubs, and a fixture whose whole trace is one
        # instruction is not evidence that overlay code translates correctly.
        if a.arm_select == 'shape':
            # IN PROCESS, against the section just read back out of the machine.  A
            # cold boot cannot use a precomputed --arm-offsets file: the overlay's
            # identity and base are not known until Dolphin is already running, and
            # re-running to apply an offline classification would cost the whole boot
            # again.  See rel_shapes.py for what "shape" means and why the closure
            # check is part of the gate.
            import rel_shapes as RS
            t_s = time.time()
            _, _, img_s, byaddr_s, ov_s, starts_s, breloc_s = RS.build_image(
                a.iso, a.rel, base, live, a.dol, a.map, sections=rel_sections)
            rows_s = RS.classify(img_s, byaddr_s, ov_s, starts_s, breloc_s, base)
            sel_s = RS.arm_list(rows_s, a.max_arm)
            RS.report(rows_s, sel_s, out=lambda s: print(s, flush=True))
            arm_path = os.path.splitext(OUT)[0] + f".{a.rel}.arm.txt"
            RS.write_arm_file(arm_path, rows_s, sel_s, f"{a.rel} @ {base:#010x}")
            print(f"[shapes] classified in {time.time() - t_s:.0f}s; wrote {arm_path}")
            arm = [r["off"] for r in sel_s if r["off"] in bodies]
            # Carry the classification onto the fixtures.  A survey's claim is about
            # SHAPES covered, and that cannot be reconstructed from the artifact later
            # without re-running the whole classification against the same live bytes.
            shape_by_off = {r["off"]: r["shape"] for r in rows_s}
            census_by_off = {r["off"]: r["census"] for r in rows_s}
            print(f"[discover] {len(entries)} entries; arming {len(arm)} chosen by "
                  f"SHAPE across {len(set(r['shape'] for r in sel_s))} buckets")
        elif a.arm_offsets:
            want, unknown_off = [], []
            for line in open(a.arm_offsets):
                line = line.split('#')[0].strip()
                if not line:
                    continue
                o = int(line, 16)
                (want if o in bodies else unknown_off).append(o)
            if unknown_off:
                print(f"[discover] {len(unknown_off)} offset(s) in {a.arm_offsets} are "
                      f"not discovered function entries in section {sec} — REFUSED: "
                      + ", ".join(f"+{o:#x}" for o in unknown_off[:8])
                      + (", ..." if len(unknown_off) > 8 else ""), file=sys.stderr)
            arm = want[:a.max_arm]
            print(f"[discover] {len(entries)} entries; arming {len(arm)} of "
                  f"{len(want)} offsets supplied by --arm-offsets {a.arm_offsets}")
        else:
            arm = [e for e in entries
                   if e in bodies and bodies[e]["hi"] - bodies[e]["lo"] >= a.min_body]
            arm.sort(key=lambda e: bodies[e]["hi"] - bodies[e]["lo"])
            arm = arm[:a.max_arm]
            print(f"[discover] {len(entries)} entries, {len(arm)} armed after "
                  f"--min-body {a.min_body} (smallest first)")
        # ------------------------------------------------- capture bookkeeping
        out = {"game": "GSNE8P",
               "oracle": "native Dolphin interpreter (CPUCore=0)",
               "rel": a.rel, "rel_sec": sec, "rel_base": base,
               "rel_sections": rel_sections,
               "live_section": live_path, "live_words_patched": diff,
               "capture": "gamecube/recomp/sr/fixture_rel.py",
               "oracle_binary": obin, "state": a.state,
               "fixtures": [], "refused": []}
        # Serve every OVERLAY instruction fetch from the relocated section already read
        # out of the machine, instead of one `m` packet per step.  A symbol map cannot
        # do this job for an overlay -- an overlay has no symbols.
        prefetch = {base + i: struct.unpack_from('>I', live, i)[0]
                    for i in range(0, len(live), 4)}

        def on_fixture(fx, off):
            fx["gqr"] = read_gqrs(g)
            fx["ps1_dependency"] = [[f"{p:#010x}", f"{w:08x}", why]
                                    for p, w, why in ps1_dependency(fx["stream"])]
            fx["n_calls"] = sum(1 for _, w in fx["stream"]
                                if ((w >> 26) & 0x3F) == 18 and (w & 1))
            fx["rel_off"] = off
            if off in shape_by_off:
                fx["shape"] = shape_by_off[off]
                fx["census"] = census_by_off[off]
            del fx["stream"]
            # MARK AT CAPTURE TIME, not at verify time.  A fixture with an unknown
            # store form has an INCOMPLETE write log and one that hit the step cap is
            # TRUNCATED; either scores as a translation defect when replayed, and
            # neither is one.  verify_fixture.mjs already honours `usable:false` and
            # prints the reason -- the sab_nonleaf suite carries three such records.
            if fx["unknown_stores"] or not fx["returned"]:
                fx["usable"] = False
            print(f"    steps={fx['steps']} returned={fx['returned']} "
                  f"bl={fx['n_calls']} writes={len(fx['writes'])} "
                  f"initial_bytes={len(fx['initial_mem'])} "
                  f"unknown={len(fx['unknown_stores'])} "
                  f"outside_mem1={len(fx['outside_mem1'])} "
                  f"lockedL1={len(fx.get('locked_cache', {}).get('kind', {}))}"
                  f"/{fx.get('locked_cache', {}).get('words_read', 0)}w "
                  f"ps1_dep={len(fx['ps1_dependency'])}", flush=True)
            out["fixtures"].append(fx)
            json.dump(out, open(OUT, "w"))

        def on_refusal(off, entry, why, quiet=False):
            if not quiet:
                print(f"    REFUSED: {why}", flush=True)
            out["refused"].append({"entry": entry, "rel_off": off, "why": why,
                                   "shape": shape_by_off.get(off)})
            json.dump(out, open(OUT, "w"))

        if a.survey:
            try:
                def on_executed(fired):
                    out["executed"] = list(fired)
                    json.dump(out, open(OUT, "w"))
                    path = os.path.splitext(OUT)[0] + f".{a.rel}.executed.txt"
                    with open(path, "w") as f:
                        f.write(f"# {len(fired)} of {len(arm)} armed entries executed "
                                f"in this scene, in fire order\n")
                        for o in fired:
                            f.write(f"{o:#x}   # {base + o:#010x} "
                                    f"{shape_by_off.get(o, '?')}\n")
                    print(f"[survey] wrote {path}", flush=True)

                ndone, anchor_off = survey_waves(a, g, base, bodies, arm, osyms,
                                                 prefetch, on_fixture, on_refusal,
                                                 on_executed)
                out["survey_anchor_off"] = anchor_off
            except Exception as e:
                print(f"[survey] ABORTED: {type(e).__name__}: {e}", file=sys.stderr)
                out["aborted"] = f"{type(e).__name__}: {e}"
            json.dump(out, open(OUT, "w"))
            nun = sum(1 for f in out["fixtures"] if f.get("usable") is False)
            nout = sum(1 for f in out["fixtures"] if f.get("outside_mem1"))
            print(f"[survey] wrote {OUT}: {len(out['fixtures'])} captured "
                  f"({nun} marked unusable, {nout} touch addresses outside MEM1), "
                  f"{len(out['refused'])} refused, of {len(arm)} armed")
            return

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
        if a.capture_order == 'arm':
            # SURVEY ORDER.  Ranking by hit count fills the capture budget with
            # whatever the frame loop calls most, which is a handful of shapes; the
            # arm file is already ordered for shape spread, so honour it.
            ranked = [(off, hits[off]) for off in arm if off in hits]
        else:
            ranked = sorted(hits.items(), key=lambda kv: -kv[1])
        for off, n in ranked[:20]:
            b = bodies[off]
            print(f"   +{off:#08x} -> {base + off:#010x}  hits={n:5d}  "
                  f"body={b['hi'] - b['lo']} bytes")
        if not ranked:
            print("[discover] nothing fired; cannot capture", file=sys.stderr)
            sys.exit(4)

        # --------------------------------------------------------- capture
        taken = 0
        tcap0 = time.time()
        for off, n in ranked:
            if taken >= a.capture_n:
                break
            if a.capture_budget and time.time() - tcap0 >= a.capture_budget:
                print(f"[capture] budget {a.capture_budget:.0f}s spent; "
                      f"{len(ranked) - taken} candidate(s) not attempted", flush=True)
                break
            entry = base + off
            print(f"[capture] {entry:#010x} (+{off:#x}, {n} hits) ...", flush=True)
            try:
                fx = O.capture_replayable_fixture(
                    g, entry, syms=osyms, max_steps=a.max_steps, progress=2000,
                    cont_timeout=a.capture_cont_timeout, prefetch=prefetch)
            except Exception as e:
                on_refusal(off, entry, f"{type(e).__name__}: {e}")
                try:
                    g.resync()
                except Exception:
                    pass
                continue
            on_fixture(fx, off)
            taken += 1
        json.dump(out, open(OUT, "w"))
        nun = sum(1 for f in out["fixtures"] if f.get("usable") is False)
        nout = sum(1 for f in out["fixtures"] if f.get("outside_mem1"))
        print(f"[capture] wrote {OUT}: {len(out['fixtures'])} captured "
              f"({nun} marked unusable, {nout} touch addresses outside MEM1), "
              f"{len(out['refused'])} refused, "
              f"{len(ranked)} candidates fired during discovery")
    finally:
        dol.kill()


if __name__ == '__main__':
    main()

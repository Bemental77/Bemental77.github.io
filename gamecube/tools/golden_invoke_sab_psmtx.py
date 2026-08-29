#!/usr/bin/env python3
"""golden_invoke_sab_psmtx.py — golden vectors for Sonic Adventure 2 Battle leaf functions
(GSNE8P rev00) captured from NATIVE Dolphin's REFERENCE INTERPRETER, the oracle.

Sibling of golden_invoke_psmtx.py (MP4 / PSMTXROMultVecArray); same GDB-stub mechanism,
generalised to an ABI table so any memory-in / memory-out leaf can be harvested.

Why this is a TRUE oracle and not a re-implementation: it executes the SHIPPED function
bytes in the running game image on Dolphin's interpreter (CPUCore=0), so the Gekko
paired-single semantics (ps_muls0 / ps_madds0/1 / ps_msub / ps_sum0 with Force25Bit and
the single-rounding FMA), the `fres` table approximation, and the GQR0 quantized
load/store are the hardware ones.

Three guards, any of which aborts before a golden is written:
  * RESIDENCY  — the bytes at each entry must equal the DOL image (EXPECT_<fn>=hex).
  * SELF-CHECK — PSMTXConcat with A = identity must reproduce B bit-for-bit.
  * SENTINEL   — every invocation must halt at the sentinel, never anywhere else.

PASSIVE phase (optional) additionally breakpoints the real entry+blr and lets the GAME
call the function, capturing the in-game input distribution.

Launch the oracle FIRST (interpreter core; breakpoints then fire on every instruction):
  ~/gc_refs/dolphin-upstream/build-oracle/Binaries/dolphin-emu-nogui \\
    -C Dolphin.Interface.DebugModeEnabled=True -C Dolphin.General.GDBPort=9099 \\
    -C Dolphin.Core.CPUThread=True -C Dolphin.Core.CPUCore=0 \\
    -e "<abs path>/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso"
then run this (FIRST connection; the stub is one-shot — a probe connect consumes it).
Env: GDB_PORT, ANCHOR_PC, GOLDEN_OUT, N_FUZZ, SEED, PASSIVE_FN, PASSIVE_BUDGET, MAX_PASSIVE.
"""
import socket, sys, time, os, json, struct, random

HOST = "127.0.0.1"
PORT = int(os.environ.get("GDB_PORT", "9099"))
OUT = os.environ.get("GOLDEN_OUT", "/tmp/sab_leaf_goldens.json")
N_FUZZ = int(os.environ.get("N_FUZZ", "200"))
SEED = int(os.environ.get("SEED", "20260829"))
MAX_PASSIVE = int(os.environ.get("MAX_PASSIVE", "24"))
# A PC the running game hits on every DSP interrupt (observed live in the oracle log's
# [axei-trace] lines) -> a guaranteed halt ON THE CPU THREAD. m/M/P require
# Core::IsCPUThread (GDBStub.cpp 'm'/'M' cases), so the halt MUST come from a breakpoint:
# an async 0x03 break closed the socket instead (verified 2026-08-29).
ANCHOR = int(os.environ.get("ANCHOR_PC", "0x8013f408"), 16)

# --- ABI table: (entry, blr_for_passive, [(gpr, in_bytes)], (gpr, out_bytes), ret_r3) ---
FNS = {
    "PSMTXConcat":       (0x800ed368, 0x800ed430, [(3, 48), (4, 48)], (5, 48), False),
    "PSMTXInverse":      (0x800ed484, 0x800ed57c, [(3, 48)],          (4, 48), True),
    "PSMTXMultVec":      (0x800edab8, 0x800edb08, [(3, 48), (4, 12)], (5, 12), False),
    "PSVECCrossProduct": (0x800ede34, 0x800ede6c, [(3, 12), (4, 12)], (5, 12), False),
}

A_IN = {3: 0x81700000, 4: 0x81700100, 6: 0x81700200}
A_OUT = {4: 0x81700300, 5: 0x81700400}
A_STK = 0x81760000
A_RET = 0x81780000


def cksum(p): return f"{sum(p) & 0xff:02x}"
def send(s, p): s.sendall(f"${p}#{cksum(p.encode())}".encode())


def recv(s):
    while True:
        c = s.recv(1)
        if not c: return ""
        if c in (b"+", b"-"): continue
        if c == b"$": break
    buf = b""
    while True:
        c = s.recv(1)
        if not c: return ""
        if c == b"#":
            s.recv(2); s.sendall(b"+"); return buf.decode(errors="replace")
        buf += c


def wmem(s, addr, data):
    send(s, f"M{addr:x},{len(data):x}:" + data.hex()); r = recv(s)
    if r != "OK": raise RuntimeError(f"wmem {addr:#x} failed: {r!r}")


def rmem(s, addr, n):
    out = b""
    while n > 0:
        c = min(n, 256)
        send(s, f"m{addr:x},{c:x}"); r = recv(s)
        # An error reply is exactly "Exx" (3 chars). A DATA reply can legitimately start
        # with 'E' -- PSMTXInverse's first shipped byte is 0xE0 (psq_l), which the naive
        # startswith("E") check in the MP4 sibling script misreads as an error.
        if not r or (len(r) == 3 and r[0] == "E") or len(r) != 2 * c:
            raise RuntimeError(f"rmem {addr:#x} failed: {r!r}")
        out += bytes.fromhex(r); addr += c; n -= c
    return out


def wreg(s, rid, val):
    send(s, f"P{rid:x}={val:08x}"); r = recv(s)
    if r != "OK": raise RuntimeError(f"wreg {rid:#x}={val:#x} failed: {r!r}")


def rreg(s, rid):
    send(s, f"p{rid:x}"); r = recv(s)
    return int(r[:8], 16) if r and len(r) >= 8 else None


def stop_pc(stop):
    for kv in stop[3:].split(";"):
        if ":" in kv:
            rr, vv = kv.split(":", 1)
            if rr == "40": return int(vv, 16)
    return None


def invoke(s, entry, ins, out, ret_r3):
    """Stage `ins`, run `entry` to the sentinel, return (out_bytes, r3)."""
    gprs = {}
    for gpr, data in ins:
        wmem(s, A_IN[gpr], data); gprs[gpr] = A_IN[gpr]
    ogpr, olen = out
    wmem(s, A_OUT[ogpr], b"\xCC" * olen); gprs[ogpr] = A_OUT[ogpr]
    for rid, v in gprs.items():
        wreg(s, rid, v)
    wreg(s, 1, A_STK)
    wreg(s, 0x43, A_RET)      # LR = sentinel
    wreg(s, 0x40, entry)      # PC = function entry
    send(s, "c"); stop = recv(s)
    if not stop or stop[0] != "T":
        raise RuntimeError(f"unexpected stop {stop!r}")
    pc = stop_pc(stop)
    if pc != A_RET:
        raise RuntimeError(f"halted at {pc:#010x}, want sentinel {A_RET:#x}")
    return rmem(s, A_OUT[ogpr], olen), (rreg(s, 3) if ret_r3 else None)


IDENT = struct.pack(">12f", 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0)


def f32(x): return struct.pack(">f", x)


def fixed_mtx():
    rotz = struct.pack(">12f", 0.8660254, -0.5, 0.0, 10.0,
                       0.5, 0.8660254, 0.0, -3.5, 0.0, 0.0, 1.0, 2.0)
    scale = struct.pack(">12f", 2.0, 0, 0, 1.5, 0, 0.25, 0, -1.0, 0, 0, -4.0, 0.5)
    # the Mario-Strikers FMA single-rounding tie triple, plus 2^23 +-1 and f32 extremes
    odd = struct.pack(">12f", 50.0, -0.01669894158840179443359375, 1.294105489087172e-22, 3.0,
                      1.0000001, -1.0000001, 8388609.0, -8388609.0,
                      1e-38, -1e-38, 3.4028235e38, -3.4028235e38)
    zeros = struct.pack(">12f", 0.0, -0.0, 0.0, -0.0, 0.0, 0.0, -0.0, 0.0, -0.0, 0.0, 0.0, -0.0)
    tiny = struct.pack(">12f", 1e-45, -1e-45, 5.877472e-39, -5.877472e-39,
                       1.1754944e-38, -1.1754944e-38, 2.3509887e-38, 1e-30,
                       1e-20, 1e-10, 1e-5, 1.0)
    big = struct.pack(">12f", 3.4028235e38, 1.7014118e38, -3.4028235e38, 1e30,
                      1e20, -1e20, 65504.0, -65504.0, 1e10, 1e15, -1e15, 123456.789)
    sing = struct.pack(">12f", 1, 2, 3, 4, 2, 4, 6, 8, 3, 6, 9, 12)     # singular: det == 0
    return {"ident": IDENT, "rotz": rotz, "scale": scale, "odd": odd,
            "zeros": zeros, "tiny": tiny, "big": big, "singular": sing}


def rnd_f32(rng):
    k = rng.random()
    if k < 0.60:                                  # plausible game float
        return struct.unpack(">f", struct.pack(">f",
               rng.uniform(-1, 1) * (2.0 ** rng.randint(-20, 20))))[0]
    if k < 0.78:                                  # denormal / very small
        return struct.unpack(">f", struct.pack(">I", (rng.getrandbits(1) << 31) |
                                                      rng.getrandbits(23)))[0]
    if k < 0.90:                                  # huge
        return struct.unpack(">f", struct.pack(">f",
               rng.uniform(-1, 1) * (2.0 ** rng.randint(100, 127))))[0]
    return struct.unpack(">f", struct.pack(">I", rng.getrandbits(32)))[0]   # arbitrary bits


def rnd_buf(rng, n):
    return b"".join(struct.pack(">f", rnd_f32(rng)) for _ in range(n // 4))


def main():
    s = socket.socket(); s.settimeout(180)
    for _ in range(240):
        try:
            s.connect((HOST, PORT)); break
        except (ConnectionRefusedError, OSError):
            time.sleep(0.25)
    else:
        print("could not connect to oracle GDB stub", file=sys.stderr); sys.exit(1)
    send(s, "?"); recv(s)

    # ---- PASSIVE_SIMPLE: inputs-only harvest, no protocol recovery needed --------
    # Used by the two-run flow: this run only records the GAME's inputs (and is then
    # killed), so it can free-run with just the two function breakpoints -- nothing else
    # armed, so the guest is not slowed by anchor round trips.
    if os.environ.get("PASSIVE_SIMPLE") == "1":
        pf = os.environ["PASSIVE_FN"]
        entry, blr, ins, out, ret = FNS[pf]
        budget = float(os.environ.get("PASSIVE_BUDGET", "300"))
        send(s, f"Z0,{entry:x},4"); print("Z0 entry:", recv(s), file=sys.stderr)
        send(s, f"Z0,{blr:x},4"); print("Z0 blr  :", recv(s), file=sys.stderr)
        recs, pend, t0 = [], None, time.time()
        while len(recs) < MAX_PASSIVE and time.time() - t0 < budget:
            s.settimeout(max(5.0, budget - (time.time() - t0)))
            send(s, "c")
            try:
                stop = recv(s)
            except socket.timeout:
                print("passive: no call inside the budget", file=sys.stderr); break
            if not stop or stop[0] != "T":
                break
            pc = stop_pc(stop)
            if pc == entry:
                regs = {g: rreg(s, g) for g, _ in ins}
                og = rreg(s, out[0])
                def okp(a): return a is not None and 0x80000000 <= a < 0x81800000
                if not all(okp(v) for v in regs.values()) or not okp(og):
                    pend = None; continue
                try:
                    pend = {"in": [(g, rmem(s, regs[g], n).hex()) for g, n in ins],
                            "outaddr": og, "alias": any(regs[g] == og for g, _ in ins)}
                except RuntimeError:
                    pend = None
            elif pc == blr and pend is not None:
                try:
                    pend["dst"] = rmem(s, pend["outaddr"], out[1]).hex(); recs.append(pend)
                except RuntimeError:
                    pass
                pend = None
            else:
                pend = None
        json.dump({pf: recs}, open(os.environ["PASSIVE_DUMP"], "w"))
        print(f"PASSIVE_SIMPLE: {len(recs)} in-game calls -> {os.environ['PASSIVE_DUMP']}",
              file=sys.stderr)
        s.close(); return

    # ---- park on the CPU thread at a PC the game demonstrably executes ----
    send(s, f"Z0,{ANCHOR:x},4"); print("Z0 anchor:", recv(s), file=sys.stderr)
    halted = False
    for _ in range(400):
        send(s, "c"); stop = recv(s)
        if stop and stop[0] == "T" and stop_pc(stop) == ANCHOR:
            halted = True; break
    if not halted:
        print("anchor never reached", file=sys.stderr); sys.exit(2)
    send(s, f"z0,{ANCHOR:x},4"); recv(s)
    print(f"parked at anchor {ANCHOR:#010x}", file=sys.stderr)

    # ---- residency: shipped bytes must match the DOL image ----
    for name, (entry, blr, ins, out, ret) in FNS.items():
        exp = os.environ.get(f"EXPECT_{name}")
        if not exp:
            continue
        live = rmem(s, entry, len(exp) // 2)
        if live.hex() != exp:
            print(f"RESIDENCY FAILED for {name} @ {entry:#x}", file=sys.stderr)
            print(f"  live {live.hex()[:64]}...\n  dol  {exp[:64]}...", file=sys.stderr)
            sys.exit(6)
        print(f"residency OK: {name} {len(live)} bytes @ {entry:#010x} == DOL image",
              file=sys.stderr)

    # ---- PASSIVE: real in-game inputs -------------------------------------
    # PASSIVE_IN lets a FAST capture run (CPUCore=1 JIT, which reaches 3-D quickly) supply
    # the in-game input distribution, while the reference OUTPUTS are still produced here
    # on the interpreter. Inputs are game state, identical under either core.
    passive = {}
    pin = os.environ.get("PASSIVE_IN")
    if pin and os.path.exists(pin):
        passive.update(json.load(open(pin)))
        for k, v in passive.items():
            print(f"passive {k}: {len(v)} in-game inputs loaded from {pin}", file=sys.stderr)
    pf = os.environ.get("PASSIVE_FN")
    if pf:
        entry, blr, ins, out, ret = FNS[pf]
        budget = float(os.environ.get("PASSIVE_BUDGET", "180"))
        # Keep the ANCHOR breakpoint set for the whole passive phase: every `c` is then
        # guaranteed to stop somewhere, so the budget can expire with the CPU HALTED on
        # the CPU thread (an expiry with the CPU running strands the protocol).
        # NOTE: do NOT arm the ANCHOR breakpoint during this loop. It sits in the DSP
        # interrupt path (~200 hits/guest-second); each hit costs a full GDB round trip and
        # slows the guest so much the game never reaches 3-D. Instead run with only the two
        # function breakpoints and, on budget expiry, arm the anchor WHILE THE CPU IS
        # RUNNING (the stub still services commands from CoreTiming's UpdateCallback), so
        # the outstanding `c` lands on it and we end up halted on the CPU thread.
        send(s, f"Z0,{entry:x},4"); recv(s)
        send(s, f"Z0,{blr:x},4"); recv(s)
        recs, pend, t0 = [], None, time.time()
        armed, pending_c = False, False
        while True:
            if not pending_c:
                send(s, "c"); pending_c = True
            s.settimeout(20)
            try:
                stop = recv(s)
            except socket.timeout:
                over = (time.time() - t0) >= budget or len(recs) >= MAX_PASSIVE
                if over and not armed:
                    # Arm the anchor WHILE RUNNING; the outstanding `c` lands on it.
                    send(s, f"Z0,{ANCHOR:x},4"); armed = True
                continue
            if stop == "OK":            # the async Z0 acknowledgement, not a stop
                continue
            if not stop or stop[0] != "T":
                break
            pending_c = False
            pc = stop_pc(stop)
            if pc == ANCHOR:
                print(f"passive: halted at anchor with {len(recs)} records", file=sys.stderr)
                break
            if pc == entry:
                regs = {g: rreg(s, g) for g, _ in ins}
                og = rreg(s, out[0])
                # GUARD: a bogus pointer makes Dolphin panic ("Unknown Pointer 0x20000000
                # PC 0x800ed368") and kills the oracle process. Only read MEM1.
                def ok(a): return a is not None and 0x80000000 <= a < 0x81800000
                if not all(ok(v) for v in regs.values()) or not ok(og):
                    pend = None; continue
                try:
                    pend = {"in": [(g, rmem(s, regs[g], n).hex()) for g, n in ins],
                            "outaddr": og,
                            "alias": any(regs[g] == og for g, _ in ins)}
                except RuntimeError:
                    pend = None
            elif pc == blr and pend is not None:
                try:
                    pend["dst"] = rmem(s, pend["outaddr"], out[1]).hex()
                    recs.append(pend)
                except RuntimeError:
                    pass
                pend = None
            else:
                pend = None
        s.settimeout(180)
        send(s, f"z0,{entry:x},4"); recv(s)
        send(s, f"z0,{blr:x},4"); recv(s)
        if armed:
            send(s, f"z0,{ANCHOR:x},4"); recv(s)
        passive[pf] = recs
        print(f"passive {pf}: {len(recs)} real in-game calls", file=sys.stderr)
        if os.environ.get("PASSIVE_DUMP"):
            json.dump(passive, open(os.environ["PASSIVE_DUMP"], "w"))
            print(f"passive inputs -> {os.environ['PASSIVE_DUMP']}", file=sys.stderr)
            if os.environ.get("PASSIVE_ONLY") == "1":
                s.close(); return

    # ---- prepare for hijacked invocation ----
    msr = rreg(s, 0x41)
    if msr is None:
        print("could not read MSR", file=sys.stderr); sys.exit(4)
    new_msr = (msr | 0x00002000) & ~0x00008000       # FP=1, EE=0
    wreg(s, 0x41, new_msr)
    print(f"MSR {msr:#010x} -> {new_msr:#010x} (FP=1, EE=0)", file=sys.stderr)
    wmem(s, A_RET, struct.pack(">I", 0x48000000))    # b .  (Z0 halts before it executes)
    send(s, f"Z0,{A_RET:x},4"); recv(s)

    # ---- SELF-CHECK: PSMTXConcat, A = identity, must reproduce B exactly ----
    e, _, ins, out, ret = FNS["PSMTXConcat"]
    B = fixed_mtx()["rotz"]
    got, _ = invoke(s, e, [(3, IDENT), (4, B)], out, ret)
    if got != B:
        print("SELF-CHECK FAILED: identity x B did not reproduce B", file=sys.stderr)
        print(f"  want {B.hex()}\n  got  {got.hex()}", file=sys.stderr)
        s.close(); sys.exit(3)
    print("self-check OK: PSMTXConcat(identity, B) == B bit-exact", file=sys.stderr)

    # ---- capture ----
    rng = random.Random(SEED)
    fixed = fixed_mtx()
    out_recs = []
    for name, (entry, blr, ins, out, ret) in FNS.items():
        cases = []
        keys = list(fixed)
        for i, ka in enumerate(keys):                       # fixed x fixed cross product
            for kb in keys:
                bufs = []
                for g, n in ins:
                    src = fixed[ka] if g == ins[0][0] else fixed[kb]
                    bufs.append((g, src[:n]))
                cases.append((f"{ka}_x_{kb}", bufs))
        for i in range(N_FUZZ):                             # seeded fuzz
            cases.append((f"fuzz{i:04d}", [(g, rnd_buf(rng, n)) for g, n in ins]))
        for i, r in enumerate(passive.get(name, [])):       # replayed in-game inputs
            cases.append((f"ingame{i:02d}", [(g, bytes.fromhex(h)) for g, h in r["in"]]))
        for cname, bufs in cases:
            dst, r3 = invoke(s, entry, bufs, out, ret)
            out_recs.append({"fn": name, "entry": f"{entry:#010x}", "case": cname,
                             "in": [[g, b.hex()] for g, b in bufs],
                             "out_gpr": out[0], "dst": dst.hex(),
                             "r3": r3})
        print(f"  {name:18s} {len(cases):5d} vectors captured", file=sys.stderr)

    send(s, f"z0,{A_RET:x},4"); recv(s)
    wreg(s, 0x41, msr)
    wreg(s, 0x40, ANCHOR)
    send(s, "D")
    try: recv(s)
    except Exception: pass
    s.close()
    json.dump({"game": "GSNE8P", "oracle": "native Dolphin interpreter (CPUCore=0)",
               "seed": SEED, "passive": {k: len(v) for k, v in passive.items()},
               "records": out_recs}, open(OUT, "w"))
    print(f"captured {len(out_recs)} golden records -> {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""golden_invoke_psmtx.py — generate PSMTXROMultVecArray golden vectors by DIRECT
INVOCATION of the real function bytes on NATIVE Dolphin's interpreter (the oracle),
driven entirely through the GDB stub. No dolphin-src rebuild, no game scene reached:
we halt the CPU at a post-boot anchor (code + GQR0 resident), stage synthetic inputs
into scratch guest RAM, point r3-r6/LR/PC at the function, and run to a sentinel blr.

Why this is a TRUE oracle (not a re-implementation — the bent-legs trap): it executes
the shipped function bytes at 0x800bc8d0 on Dolphin's reference interpreter under the
real Gekko paired-single (ps_madds0/ps_madds1) + GQR0/FPSCR semantics. The function is
data-independent (grep-verified zero fcmp/fsel/frsp/fabs in psmtx.s), so enumerated
synthetic inputs cover its whole domain; real-scene input distribution is irrelevant to
correctness. See gamecube/tools/golden_capture_psmtx.py for the passive-capture sibling
(needs a board savestate); this tool needs neither a scene nor a savestate.

SELF-VALIDATION: case 0 is a reordered IDENTITY matrix; the driver asserts the output
round-trips to the input bit-exact. That single check proves GQR0=f32 mode, big-endian
byte order, the r3-r6 ABI, memory staging, and pc/npc resume are ALL correct before any
golden is emitted. If it fails, the tool aborts (never ships a bad golden).

Launch the oracle FIRST on the INTERPRETER core (CPUCore=0 → breakpoints fire every
instruction, no JIT stale-block; the interpreter is Dolphin's reference implementation):
  ~/gc_refs/dolphin-upstream/build-oracle/Binaries/dolphin-emu-nogui \
    -C Dolphin.Interface.DebugModeEnabled=True -C Dolphin.General.GDBPort=9091 \
    -C Dolphin.Core.CPUThread=True -C Dolphin.Core.CPUCore=0 \
    -e "/Users/caseybement/Downloads/Mario Party 4 (USA).iso"
then run this (FIRST connection; the stub is one-shot). Env: GDB_PORT, ANCHOR_PC,
REORDER, PSMTX, GOLDEN_OUT.
"""
import socket, sys, time, os, json, struct

HOST = "127.0.0.1"
PORT = int(os.environ.get("GDB_PORT", "9091"))
ANCHOR = int(os.environ.get("ANCHOR_PC", "0x800b9f14"), 16)   # OSEnableScheduler (fires headless)
REORDER = int(os.environ.get("REORDER", "0x800bc884"), 16)    # PSMTXReorder(r3=Mtx,r4=ROMtx)
PSMTX = int(os.environ.get("PSMTX", "0x800bc8d0"), 16)        # PSMTXROMultVecArray(r3=ROMtx,r4=src,r5=dst,r6=cnt)
OUT = os.environ.get("GOLDEN_OUT", "/tmp/psmtx_goldens.json")

# scratch guest RAM (high MEM1, below the OS-reserved tail 0x817F0000; verified free above
# main.elf's 0x801d6be8 top — golden-driver-research wf_d6ae5b87 scratch_ram evidence)
A_MTX = 0x81700000    # source Mtx[3][4]  (48B) -> PSMTXReorder input
A_ROM = 0x81701000    # ROMtx[4][3]       (48B) -> Reorder output / PSMTX r3
A_SRC = 0x81702000    # src Vec3 array    (count*12)
A_DST = 0x81703000    # dst Vec3 array    (count*12)
A_STK = 0x81760000    # stack top (r1); function does stwu r1,-0x40(r1)
A_RET = 0x81780000    # sentinel: LR target + breakpoint (blr lands here, we halt)


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
    """M addr,len:hexbytes — guest is big-endian; caller supplies raw BE bytes."""
    send(s, f"M{addr:x},{len(data):x}:" + data.hex()); r = recv(s)
    if r != "OK": raise RuntimeError(f"wmem {addr:#x} failed: {r!r}")


def rmem(s, addr, n):
    out = b""
    while n > 0:
        c = min(n, 256)
        send(s, f"m{addr:x},{c:x}"); r = recv(s)
        if not r or r.startswith("E"): raise RuntimeError(f"rmem {addr:#x} failed: {r!r}")
        out += bytes.fromhex(r); addr += c; n -= c
    return out


def wreg(s, rid, val):
    """P<rid-hex>=<8-hex BE> — rid<32 gpr, 0x40 pc, 0x41 MSR, 0x43 LR (GDBStub.cpp:619)."""
    send(s, f"P{rid:x}={val:08x}"); r = recv(s)
    if r != "OK": raise RuntimeError(f"wreg {rid:#x}={val:#x} failed: {r!r}")


def rreg(s, rid):
    send(s, f"p{rid:x}"); r = recv(s)
    return int(r[:8], 16) if r and not r.startswith("E") and len(r) >= 8 else None


def stop_pc(stop):
    for kv in stop[3:].split(";"):
        if ":" in kv:
            rr, vv = kv.split(":", 1)
            if rr == "40": return int(vv, 16)
    return None


DIAG = os.environ.get("DIAG")


def run_to_ret(s, entry, gprs):
    """Set gpr[*]=gprs, r1=stack, LR=sentinel, PC=entry; continue until we halt at A_RET."""
    for rid, v in gprs.items():
        wreg(s, rid, v)
    wreg(s, 1, A_STK)          # stack pointer
    wreg(s, 0x43, A_RET)       # LR = sentinel
    wreg(s, 0x40, entry)       # PC = function entry
    if DIAG:
        print(f"  [DIAG] entry={entry:#010x} single-stepping:", file=sys.stderr)
        for i in range(int(DIAG)):
            send(s, "s"); stop = recv(s)
            pc = stop_pc(stop) if stop and stop[0] == "T" else None
            print(f"    step {i:2d}: pc={pc:#010x}" if pc is not None else f"    step {i}: stop={stop!r}",
                  file=sys.stderr)
            if pc == A_RET:
                print("  [DIAG] reached sentinel", file=sys.stderr); return
        raise SystemExit("[DIAG] step budget exhausted")
    for _ in range(200):
        send(s, "c")
        stop = recv(s)
        if not stop or stop[0] != "T":
            raise RuntimeError(f"unexpected stop {stop!r}")
        pc = stop_pc(s and stop)
        if pc == A_RET:
            return
        # Halted somewhere else (our own anchor bp re-hit, or a stray) — keep going only
        # if it's the anchor; anything else inside the function is a real fault.
        if pc == ANCHOR:
            continue
        raise RuntimeError(f"halted at unexpected pc {pc:#010x} (want sentinel {A_RET:#x})")
    raise RuntimeError("run_to_ret exceeded continue budget")


def pack_mtx(m34):
    """Mtx[3][4] row-major -> 48 BE bytes."""
    assert len(m34) == 12
    return b"".join(struct.pack(">f", x) for x in m34)


def pack_vecs(vs):
    return b"".join(struct.pack(">f", c) for v in vs for c in v)


def unpack_vecs(b, n):
    out = []
    for i in range(n):
        x, y, z = struct.unpack(">fff", b[i * 12:i * 12 + 12])
        out.append([x, y, z])
    return out


def reorder_and_mult(s, mtx34, srcvecs):
    """Native: ROMtx = PSMTXReorder(mtx34); dst = PSMTXROMultVecArray(ROMtx, src, count)."""
    count = len(srcvecs)
    # 1) reorder the plain Mtx into the paired-single-packed ROMtx via the real function
    wmem(s, A_MTX, pack_mtx(mtx34))
    run_to_ret(s, REORDER, {3: A_MTX, 4: A_ROM})
    romtx = rmem(s, A_ROM, 48)
    # 2) multiply
    wmem(s, A_SRC, pack_vecs(srcvecs))
    run_to_ret(s, PSMTX, {3: A_ROM, 4: A_SRC, 5: A_DST, 6: count})
    dst = rmem(s, A_DST, count * 12)
    return romtx, unpack_vecs(dst, count)


IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]   # Mtx[3][4] identity, T=0


def build_cases():
    """The fixture input matrix: representative matrices x counts.
    DOMAIN: count>=3. The loop sets CTR=(count-1)>>1 then bdnz (psmtx.s:38,40,0x800bc9b0);
    for count in {0,1,2} CTR=0 and bdnz decrements to 0xFFFFFFFF => ~4-billion-iter hang in
    the SHIPPED function itself. Real callers guard this (skinning posCnt>6; particle path
    passes 4), so count<3 is out-of-domain for both native and the template — no golden exists.
    Counts below mix odd (tail-store skipped, clrlwi. r6 bit0 set) and even (tail-store runs)."""
    rot = [                              # a real (non-orthonormal-free) affine: rot-Z 30deg + T
        0.8660254, -0.5, 0.0, 10.0,
        0.5,  0.8660254, 0.0, -3.5,
        0.0,  0.0,       1.0, 2.0,
    ]
    scale = [2.0, 0, 0, 1.5,  0, 0.25, 0, -1.0,  0, 0, -4.0, 0.5]   # non-uniform scale + T
    def ramp(n):
        return [[float(i) + 0.5, -float(i) * 2.0, float(i) * 0.125 + 1.0] for i in range(n)]
    # 4 edge vecs (>=3 domain): +-0, denorm-ish small, large, mixed
    edge = [[0.0, -0.0, 1e-30], [1.5, 3.4e38, -2.2e-38], [-0.0, 123456.0, 0.001], [1.0, -1.0, 0.0]]
    cases = []
    for n in (3, 4, 5, 6, 7, 16, 17, 33):
        cases.append(("ident", IDENT, ramp(n)))
        cases.append(("rot", rot, ramp(n)))
        cases.append(("scale", scale, ramp(n)))
    cases.append(("ident_edge", IDENT, edge))          # +-0 / denorm / large through identity
    cases.append(("rot_edge", rot, edge))
    return cases


def main():
    s = socket.socket(); s.settimeout(90)
    for _ in range(160):
        try:
            s.connect((HOST, PORT)); break
        except (ConnectionRefusedError, OSError):
            time.sleep(0.25)
    else:
        print("could not connect to oracle GDB stub", file=sys.stderr); sys.exit(1)
    s.settimeout(60); send(s, "?"); recv(s)

    # Halt at the post-boot anchor so code (0x800bxxxx) + GQR0 are resident and the CPU
    # is parked on the CPU thread (M/P/m require IsCPUThread — GDBStub.cpp:1006,1013).
    send(s, f"Z0,{ANCHOR:x},4"); print("Z0 anchor:", recv(s), file=sys.stderr)
    for _ in range(400):
        send(s, "c"); stop = recv(s)
        if stop and stop[0] == "T" and stop_pc(stop) == ANCHOR:
            break
    else:
        print("anchor never reached", file=sys.stderr); sys.exit(2)
    print(f"parked at anchor {ANCHOR:#010x}", file=sys.stderr)

    # The anchor is early boot: MSR[FP] is CLEAR, so the function's psq_l would trap to the
    # FP-Unavailable vector (0x800) and run away. Enable FP; clear EE so a decrementer/external
    # interrupt can't context-switch away from our hijacked context mid-invocation. IR/DR are
    # already set (we are executing translated code here), so preserve the rest.
    msr = rreg(s, 0x41)
    if msr is None:
        print("could not read MSR", file=sys.stderr); sys.exit(4)
    new_msr = (msr | 0x00002000) & ~0x00008000
    wreg(s, 0x41, new_msr)
    print(f"MSR {msr:#010x} -> {new_msr:#010x} (FP=1, EE=0)", file=sys.stderr)

    # sentinel: a benign instruction so a stray fetch can't run away (branch-to-self);
    # the Z0 there halts before it ever executes.
    wmem(s, A_RET, struct.pack(">I", 0x48000000))     # b .
    send(s, f"Z0,{A_RET:x},4"); recv(s)

    cases = build_cases()
    # --- SELF-VALIDATION: identity must round-trip bit-exact before we trust anything ---
    # count=4 (in-domain, even => exercises the tail-store path too; matches the particle caller).
    # No -0.0 in the probe: identity via ps_madds FMA legitimately normalizes -0.0+0.0 -> +0.0
    # (a real native behavior captured in the edge goldens), which would trip a strict byte check.
    probe_src = [[1.5, -2.25, 3.0], [0.5, -8.0, 7.0], [-4.5, 8.0, -0.125], [100.0, 0.001, -2.0]]
    _, dst = reorder_and_mult(s, IDENT, probe_src)
    ok = all(struct.pack(">f", a) == struct.pack(">f", b)
             for sv, dv in zip(probe_src, dst) for a, b in zip(sv, dv))
    if not ok:
        print(f"SELF-CHECK FAILED: identity did not round-trip. src={probe_src} dst={dst}", file=sys.stderr)
        print("  => GQR0 mode / byte order / ABI wrong at this anchor. Aborting (no goldens).", file=sys.stderr)
        s.close(); sys.exit(3)
    print("self-check OK: identity round-trips bit-exact", file=sys.stderr)

    # --- generate goldens ---
    recs = []
    for name, mtx, src in cases:
        romtx, dst = reorder_and_mult(s, mtx, src)
        recs.append({"name": name, "count": len(src),
                     "mtx": pack_mtx(mtx).hex(), "romtx": romtx.hex(),
                     "src": pack_vecs(src).hex(),
                     "dst": pack_vecs(dst).hex()})
        print(f"  {name:12s} count={len(src):3d}  ok", file=sys.stderr)

    for pc in (ANCHOR, A_RET):
        send(s, f"z0,{pc:x},4"); recv(s)
    send(s, "D")
    try: recv(s)
    except Exception: pass
    s.close()
    json.dump(recs, open(OUT, "w"))
    print(f"captured {len(recs)} golden records -> {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()

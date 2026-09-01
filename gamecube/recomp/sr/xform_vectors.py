#!/usr/bin/env python3
"""xform_vectors.py — golden vectors for the INDEXED-WITH-UPDATE load/store forms,
captured by INJECTING the instruction into a running native Dolphin interpreter.

WHY THIS EXISTS.  sr.py gained lwzux/lbzux/lhzux/lhaux, stwux/stbux/sthux and
lfsux/lfdux/stfsux/stfdux because a census found 28 such instructions in SAB's DOL.
The 1,056-vector leaf suite does NOT reach any of them, so that addition was proven
ADDITIVE (the wasm came out byte-identical) but never proven CORRECT.

The obvious next step -- capture a fixture from the four SAB functions that contain
them -- WAS TRIED AND DOES NOT WORK: all four (0x8014c580 / 0x8014c5f8 / 0x8014c748 /
0x8014c878) have ZERO DIRECT CALLERS, they are reached only through an indirect
branch, and a 4,000-continue breakpoint wait on each timed out.  Reachability is not
available, so the instruction is brought to the oracle instead of waiting for the
oracle to reach the instruction.

METHOD.  Write a two-instruction routine -- <insn> ; blr -- into a scratch page of the
running game's MEM1, set the architectural inputs over the GDB stub, set LR to a
sentinel, run, and read the results back.  The oracle is Dolphin's REFERENCE
INTERPRETER (CPUCore=0) executing a real Gekko instruction, so the semantics are the
hardware ones and not a re-implementation.  Scratch bytes are saved and restored.

  # oracle side (needs a running game; a cold boot is fine, only the CPU is used)
  python3 gamecube/recomp/sr/xform_vectors.py --capture --out /tmp/xform_goldens.json
  # offline: emit C for the same synthetic image, to be linked and replayed
  python3 gamecube/recomp/sr/xform_vectors.py --emit-c /tmp/xform_gen.c \\
          --goldens /tmp/xform_goldens.json

Then build with build_slice.sh (SR_GEN=/tmp/xform_gen.c) and diff with
verify_xform.mjs.  A mismatch is a translator bug in a form nothing else covers.
"""
import argparse, json, os, struct, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'gamecube', 'tools'))
import sr                             # noqa: E402

SCRATCH = 0x81700000        # code goes here; 8 bytes per case
DATA = 0x81720000           # the memory the load/store touches
SENTINEL = 0x81740000       # LR target: execution must halt exactly here
PAGE = 0x400                # staged data window; keep GDB packets small
BLR = 0x4E800020

# (mnemonic, xo, kind)  kind: 'ld'=GPR load, 'st'=GPR store, 'fld'=FPR load, 'fst'=FPR store
FORMS = [
    ('lwzux',  55, 'ld',  4), ('lbzux', 119, 'ld',  1),
    ('lhzux', 311, 'ld',  2), ('lhaux', 375, 'ld',  2),
    ('stwux', 183, 'st',  4), ('stbux', 247, 'st',  1),
    ('sthux', 439, 'st',  2),
    ('lfsux', 567, 'fld', 4), ('lfdux', 631, 'fld', 8),
    ('stfsux', 695, 'fst', 4), ('stfdux', 759, 'fst', 8),
]
RA, RB, RD = 3, 5, 4        # rA is the updated base, rB the index, rD/rS the data reg


def encode(xo, d=RD, a=RA, b=RB):
    return (31 << 26) | (d << 21) | (a << 16) | (b << 11) | (xo << 1)


def cases():
    """(name, word, r3, r5, data_bytes, fpr_bits) — the vector set.

    Offsets deliberately include a NEGATIVE index (rB as a large unsigned) because the
    update forms write EA back to rA and a sign error there is invisible in the loaded
    value but corrupts the base."""
    out = []
    offsets = [0, 4, 8, 0x100, (-4) & 0xFFFFFFFF, (-0x100) & 0xFFFFFFFF]
    payloads = [b'\x00\x00\x00\x00', b'\xff\xff\xff\xff', b'\x80\x00\x00\x00',
                b'\x7f\xff\xff\xff', b'\x12\x34\x56\x78', b'\x00\x80\x00\x01']
    fbits = [0x0000000000000000, 0x3FF0000000000000, 0xBFF0000000000000,
             0x7FF8000000000000, 0x7FEFFFFFFFFFFFFF, 0x0000000000000001]
    for name, xo, kind, width in FORMS:
        w = encode(xo)
        for i, off in enumerate(offsets):
            pay = payloads[i % len(payloads)]
            fb = fbits[i % len(fbits)]
            # DATA is the midpoint so a negative index stays inside the staged page
            base = DATA + 0x200
            out.append(dict(name=f"{name}[{i}]", mnemonic=name, word=w, kind=kind,
                            width=width, r3=base, r5=off,
                            data=(pay * 2).hex(), fpr=f"{fb:016x}"))
    return out


# ------------------------------------------------------------------- oracle side
def gdb_capture(a):
    import native_oracle_gdb as O
    from fixture_nonleaf import ORACLE_BIN
    dol = O.Dolphin(iso=O.SAB_ISO, state=a.state, port=a.port,
                    log=f"/tmp/sr_xform_oracle_{a.port}.log", dual_core=True,
                    binary=ORACLE_BIN, extra=["-C", "Dolphin.Core.CPUCore=0"])
    print(f"[oracle] {ORACLE_BIN} port={a.port} core=interpreter")
    recs = []
    try:
        g = dol.connect()
        print(f"[oracle] connected; pc={g.pc():#010x}")

        # The GDB stub has a bounded packet size: a single `m` for 0x2000 bytes came
        # back malformed ("fromhex() arg must contain an even number of hexadecimal
        # digits" -- i.e. an error reply, not data).  Chunk both directions, and use
        # native_oracle_gdb's own read_range for reads, which already does.
        CHUNK = 0x200

        def wmem(addr, data):
            for o in range(0, len(data), CHUNK):
                part = data[o:o + CHUNK]
                r = g.cmd(f"M{addr + o:x},{len(part):x}:" + part.hex())
                if r != "OK":
                    raise RuntimeError(f"M{addr + o:#x},{len(part):#x} -> {r!r}")

        def rmem(addr, n):
            return g.read_range(addr, addr + n, chunk=CHUNK)

        def wreg(rid, val, width=8):
            r = g.cmd(f"P{rid:x}=" + f"{val:0{width*2}x}")
            if r != "OK":
                raise RuntimeError(f"P{rid:#x} -> {r!r}")

        saved = rmem(SCRATCH, 8 * len(cases()) + 8)
        savedd = rmem(DATA, PAGE)
        print(f"[oracle] saved {len(saved)} scratch + {len(savedd)} data bytes")
        g.add_bp(SENTINEL)
        try:
            for i, c in enumerate(cases()):
                entry = SCRATCH + i * 8
                wmem(entry, struct.pack('>II', c['word'], BLR))
                # stage the data page around the effective address
                wmem(DATA, b'\xa5' * PAGE)
                ea = (c['r3'] + c['r5']) & 0xFFFFFFFF
                wmem(ea, bytes.fromhex(c['data']))
                for r in range(32):
                    wreg(r, 0, 4)
                wreg(RA, c['r3'], 4)
                wreg(RB, c['r5'], 4)
                if c['kind'] == 'st':
                    wreg(RD, struct.unpack('>I', bytes.fromhex(c['data'])[:4])[0], 4)
                if c['kind'] == 'fst':
                    wreg(32 + RD, int(c['fpr'], 16), 8)
                wreg(0x43, SENTINEL, 4)          # LR  (native_oracle_gdb.py:41)
                wreg(0x40, entry, 4)             # PC
                rep = g.cont(timeout=20.0)
                pc = O.GDB.stop_pc(rep)
                if pc != SENTINEL:
                    print(f"  {c['name']:12s} HALTED AT {pc:#010x}, not the sentinel — dropped")
                    g.resync()
                    continue
                rec = dict(c)
                rec['out_r3'] = g.reg(RA)
                rec['out_r4'] = g.reg(RD)
                # 64-BIT VALUES ARE SERIALISED AS HEX STRINGS, never as JSON numbers.
                # JS JSON.parse turns 0x7FEFFFFFFFFFFFFF into 0x7FF0000000000000 (a
                # double cannot hold it), so a raw number here silently rewrites
                # DBL_MAX as +Inf and the diff blames the translator.
                rec['out_f4'] = f"{g.reg(32 + RD):016x}"
                rec['out_mem'] = rmem(DATA, PAGE)[
                    (ea - DATA) - 16:(ea - DATA) + 16].hex()
                rec['mem_lo'] = ea - 16
                recs.append(rec)
                g.resync()
                if (i + 1) % 12 == 0:
                    print(f"  ... {i + 1} vectors", flush=True)
        finally:
            g.del_bp(SENTINEL)
            wmem(SCRATCH, saved)
            wmem(DATA, savedd)
            print("[oracle] scratch and data pages restored")
    finally:
        dol.kill()
    json.dump(dict(oracle="native Dolphin interpreter (CPUCore=0)",
                   scratch=SCRATCH, data=DATA, vectors=recs),
              open(a.out, 'w'), indent=1)
    print(f"[oracle] wrote {a.out}: {len(recs)} of {len(cases())} vectors")


# ------------------------------------------------------------------ offline emit
def emit_c(a):
    # Emit from the goldens when they exist (so the emitted set matches exactly what
    # the oracle captured), otherwise from the case table -- which lets the emission
    # half be smoke-tested offline, without a Dolphin.
    if os.path.exists(a.goldens):
        recs = json.load(open(a.goldens))['vectors']
        print(f"emitting from goldens {a.goldens}")
    else:
        recs = cases()
        print(f"no goldens at {a.goldens}; emitting from the case table")
    blob = bytearray(b'\x00' * (8 * len(recs)))
    fns = []
    for i, c in enumerate(recs):
        struct.pack_into('>II', blob, i * 8, c['word'], BLR)
        fns.append((SCRATCH + i * 8, 8, c['name']))
    img = sr.Image()
    img.segs.append((SCRATCH, bytes(blob)))
    src = sr.emit_c(img, fns, starts={lo for lo, _, _ in fns})
    open(a.emit_c, 'w').write(src)
    print(f"wrote {a.emit_c}: {len(fns)} synthetic 1-instruction functions")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--capture', action='store_true')
    ap.add_argument('--emit-c')
    ap.add_argument('--goldens', default='/tmp/xform_goldens.json')
    ap.add_argument('--out', default='/tmp/xform_goldens.json')
    ap.add_argument('--port', type=int, default=int(os.environ.get('GDB_PORT', '9163')))
    ap.add_argument('--state', default=None)
    a = ap.parse_args()
    if a.state is None:
        import native_oracle_gdb as O
        a.state = O.SAB_STATE
    if a.capture:
        gdb_capture(a)
    elif a.emit_c:
        emit_c(a)
    else:
        print(f"{len(cases())} vectors across {len(FORMS)} forms")
        for c in cases()[:6]:
            print(f"  {c['name']:12s} word={c['word']:08x} r3={c['r3']:#x} r5={c['r5']:#x}")


if __name__ == '__main__':
    main()

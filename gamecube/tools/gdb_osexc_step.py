#!/usr/bin/env python3
"""Single-step native Dolphin through OSExceptionInit's FIRST pass to capture
the ground-truth control flow (PC + r0/r1/r3/r13/lr per instruction). Native
completes the function once (sets guard MEM[0x803adc4c]=1); wasm never does.
This trace is the oracle to diff the wasm trajectory against.

Dolphin GDB-RSP register map: 0..31 GPR, 64=PC, 67=LR (read via p<hex>).
"""
import socket, sys, time

PORT = 9090
ENTRY = 0x800e362c
NSTEPS = int(sys.argv[1]) if len(sys.argv) > 1 else 140


def cksum(s): return sum(s.encode()) & 0xff
def send(s, d): s.sendall(f"${d}#{cksum(d):02x}".encode())
def recv(s):
    while True:
        ch = s.recv(1)
        if not ch: return None
        if ch in (b"+", b"-"): continue
        if ch == b"$":
            buf = b""
            while True:
                c = s.recv(1)
                if c == b"#": s.recv(2); s.sendall(b"+"); return buf.decode("latin-1")
                buf += c
def cmd(s, p): send(s, p); return recv(s)
def reg(s, n):
    r = cmd(s, f"p{n:x}")
    try: return int.from_bytes(bytes.fromhex(r), "big")
    except Exception: return None


def main():
    s = socket.socket(); s.settimeout(10); s.connect(("127.0.0.1", PORT))
    print("qSupported:", cmd(s, "qSupported"), file=sys.stderr)
    pc = reg(s, 64)
    print(f"halt PC = 0x{pc:08x}" if pc is not None else "halt PC = ?", file=sys.stderr)

    # Breakpoint at ENTRY, continue, wait for it.
    print("set bp @0x%08x ->" % ENTRY, cmd(s, f"Z0,{ENTRY:x},4"), file=sys.stderr)
    send(s, "c")
    s.settimeout(20)
    stop = recv(s)
    print("stop after continue:", repr(stop)[:80], file=sys.stderr)
    pc = reg(s, 64)
    if pc != ENTRY:
        print(f"!! did not stop at ENTRY (PC=0x{pc:08x}); aborting trace", file=sys.stderr)
        # clear bp + detach
        cmd(s, f"z0,{ENTRY:x},4")
        s.close(); return
    cmd(s, f"z0,{ENTRY:x},4")  # clear so single-step doesn't re-trap

    print("=== native OSExceptionInit first-pass single-step ===")
    s.settimeout(10)
    for i in range(NSTEPS):
        pc = reg(s, 64); r0 = reg(s, 0); r1 = reg(s, 1); r3 = reg(s, 3)
        r13 = reg(s, 13); lr = reg(s, 67)
        def h(v): return "????????" if v is None else f"{v & 0xffffffff:08x}"
        print(f"  [{i:3d}] pc=0x{h(pc)} r0=0x{h(r0)} r1=0x{h(r1)} r3=0x{h(r3)} r13=0x{h(r13)} lr=0x{h(lr)}")
        # step
        send(s, "s")
        r = recv(s)
        if r is None:
            print("  (no stop-reply; stopping)"); break
    flag = cmd(s, f"m803adc4c,4")
    print(f"\nguard MEM[0x803adc4c] now = 0x{flag}")
    s.close()


if __name__ == "__main__":
    main()

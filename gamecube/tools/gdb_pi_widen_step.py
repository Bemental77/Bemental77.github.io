#!/usr/bin/env python3
"""Single-step native Dolphin from PI INTMR mask-widening site (PC=0x800e7c68)
for 200 samples — Row 2 checkpoint extension. Per gamecube_si_interrupt_storm
NATIVE MMIO WATCH (2026-05-27): "Native PROGRESSIVELY WIDENS the PI mask at
PC=0x800e7c68: r5 goes 0xf0→0xf8→0xfc→0x1fc→0x9fc→0xbfc→0xffc across hits
[1][3][28][29][56][57][58]. Our wasm stuck at mask=0xf8."

This captures the native trajectory through the mask-widening site so we can
inventory the EXACT mask-progression sequence + the surrounding writes to PI
INTMR (0xCC003004) that our wasm side fails to produce.

Captures: PC, r0/r3/r4/r5 (mask value lives here), LR, CTR, MSR,
PI INTSR (0xCC003000), PI INTMR (0xCC003004 — the target the widening writes to).
"""
import socket, sys

PORT   = int(sys.argv[3]) if len(sys.argv) > 3 else 9092
ENTRY  = int(sys.argv[1], 16) if len(sys.argv) > 1 else 0x800e7c68
NSTEPS = int(sys.argv[2]) if len(sys.argv) > 2 else 200

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
def mem32(s, addr):
    r = cmd(s, f"m{addr:x},4")
    try: return int.from_bytes(bytes.fromhex(r), "big")
    except Exception: return None
def h(v): return "????????" if v is None else f"{v & 0xffffffff:08x}"

def main():
    s = socket.socket(); s.settimeout(15); s.connect(("127.0.0.1", PORT))
    print("qSupported:", cmd(s, "qSupported")[:80], file=sys.stderr)
    pc0 = reg(s, 64)
    print(f"halt PC = 0x{h(pc0)}", file=sys.stderr)

    print("set bp @0x%08x ->" % ENTRY, cmd(s, f"Z0,{ENTRY:x},4"), file=sys.stderr)
    send(s, "c"); s.settimeout(120)
    stop = recv(s)
    print("stop after continue:", repr(stop)[:80], file=sys.stderr)
    pc = reg(s, 64)
    if pc != ENTRY:
        print(f"!! did not stop at ENTRY (PC=0x{h(pc)}); aborting", file=sys.stderr)
        cmd(s, f"z0,{ENTRY:x},4"); s.close(); return
    cmd(s, f"z0,{ENTRY:x},4")

    print(f"=== native PI INTMR mask-widening single-step from 0x{ENTRY:08x} ({NSTEPS} samples) ===")
    s.settimeout(15)
    prev_intmr = None
    prev_r5 = None
    for i in range(NSTEPS):
        pc  = reg(s, 64)
        r0  = reg(s, 0);  r1 = reg(s, 1); r3 = reg(s, 3); r4 = reg(s, 4); r5 = reg(s, 5)
        lr  = reg(s, 67); ctr = reg(s, 68); msr = reg(s, 65)
        intsr = mem32(s, 0xCC003000); intmr = mem32(s, 0xCC003004)
        marks = ""
        if pc is not None and pc < 0x80003000:
            marks += " <<EXCEPTION-VECTOR"
        if intmr != prev_intmr:
            marks += f" <<INTMR {h(prev_intmr)}->{h(intmr)}"
        if r5 != prev_r5 and r5 is not None:
            marks += f" <<r5 {h(prev_r5)}->{h(r5)}"
        prev_intmr = intmr; prev_r5 = r5
        print(f"  [{i:3d}] pc=0x{h(pc)} r0=0x{h(r0)} r1=0x{h(r1)} r3=0x{h(r3)} r4=0x{h(r4)} "
              f"r5=0x{h(r5)} lr=0x{h(lr)} ctr=0x{h(ctr)} msr=0x{h(msr)} "
              f"INTSR=0x{h(intsr)} INTMR=0x{h(intmr)}{marks}")
        send(s, "s")
        if recv(s) is None: print("  (no stop-reply; stopping)"); break
    s.close()

if __name__ == "__main__":
    main()

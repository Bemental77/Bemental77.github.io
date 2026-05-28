#!/usr/bin/env python3
"""Single-step native Dolphin through the SI/SRAM path (SITransfer @0x800eb058)
to capture ground-truth control flow + PI INTSR around any external interrupt.
Diffs against our wasm storm: 0x500 ext-int (PI cause 0x10108, 0x8 unmasked)
fires ~100x and is never cleared. Question: does native take the SI interrupt
here and CLEAR the PI cause (no storm)?

Dolphin GDB-RSP: 0..31 GPR, 64=PC, 67=LR, 68=CTR (read via p<hex>); m<addr>,<n>.
PI INTSR (interrupt cause) = 0xCC003000; PI INTMR (mask) = 0xCC003004.
"""
import socket, sys

PORT = 9090
ENTRY = int(sys.argv[1], 16) if len(sys.argv) > 1 else 0x800eb058  # SITransfer
NSTEPS = int(sys.argv[2]) if len(sys.argv) > 2 else 600

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
    s = socket.socket(); s.settimeout(10); s.connect(("127.0.0.1", PORT))
    print("qSupported:", cmd(s, "qSupported"), file=sys.stderr)
    print("set bp @0x%08x ->" % ENTRY, cmd(s, f"Z0,{ENTRY:x},4"), file=sys.stderr)
    send(s, "c"); s.settimeout(30)
    stop = recv(s)
    print("stop after continue:", repr(stop)[:80], file=sys.stderr)
    pc = reg(s, 64)
    if pc != ENTRY:
        print(f"!! did not stop at ENTRY (PC=0x{h(pc)}); aborting", file=sys.stderr)
        cmd(s, f"z0,{ENTRY:x},4"); s.close(); return
    cmd(s, f"z0,{ENTRY:x},4")

    print(f"=== native SI-path single-step from 0x{ENTRY:08x} (PI INTSR=0xCC003000) ===")
    s.settimeout(10)
    prev_intsr = None
    in_vector = False
    for i in range(NSTEPS):
        pc  = reg(s, 64); r3 = reg(s, 3); r4 = reg(s, 4); r5 = reg(s, 5)
        lr  = reg(s, 67); ctr = reg(s, 68)
        intsr = mem32(s, 0xCC003000); intmr = mem32(s, 0xCC003004)
        # Flag exception-vector entry (real-mode low PC) and INTSR changes.
        vec = (pc is not None and pc < 0x80003000)
        marks = ""
        if vec and not in_vector: marks += " <<ENTER-VECTOR"
        in_vector = vec
        if intsr != prev_intsr: marks += f" <<INTSR {h(prev_intsr)}->{h(intsr)}"
        prev_intsr = intsr
        print(f"  [{i:3d}] pc=0x{h(pc)} r3=0x{h(r3)} r4=0x{h(r4)} r5=0x{h(r5)} "
              f"lr=0x{h(lr)} ctr=0x{h(ctr)} INTSR=0x{h(intsr)} INTMR=0x{h(intmr)}{marks}")
        send(s, "s")
        if recv(s) is None: print("  (no stop-reply; stopping)"); break
    s.close()

if __name__ == "__main__":
    main()

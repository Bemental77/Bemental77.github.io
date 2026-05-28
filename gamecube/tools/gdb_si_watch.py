#!/usr/bin/env python3
"""Capture native Dolphin's PI/SI MMIO access SEQUENCE via GDB memory
watchpoints (Z2 write / Z3 read) — which DO fire on MMIO addresses (Memcheck
runs on the guest EA in MMU::Read/Write before hardware). The `m` packet can't
read MMIO, but watchpoints catch every access with full register context.

On each hit we log: which watchpoint, PC, LR, r3-r6 (value/context regs), MSR.
This is the native ground-truth sequence to diff against our build's SI/PI flow.

Dolphin GDB-RSP: g=all 32 GPR, p40=PC p41=MSR p43=LR; Z2/Z3 = write/read wp.
"""
import socket, sys

PORT = 9090
NHITS = int(sys.argv[1]) if len(sys.argv) > 1 else 300

# (kind, addr, label). kind: 2=write wp, 3=read wp.
WATCHES = [
    (3, 0xCC003000, "PI_INTSR.r"),    # OS reads interrupt cause (in 0x500 handler)
    (2, 0xCC003004, "PI_INTMR.w"),    # OS writes interrupt mask
    (2, 0xCC003000, "PI_INTSR.w"),    # write-to-clear edge causes
    (2, 0xCC006434, "SI_COMCSR.w"),   # TCINTMSK set / TCINT clear
    (3, 0xCC006434, "SI_COMCSR.r"),   # poll TCINT
    (2, 0xCC006438, "SI_STATUS.w"),   # RDST clear
]

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
def h(v): return "????????" if v is None else f"{v & 0xffffffff:08x}"

def main():
    s = socket.socket(); s.settimeout(15); s.connect(("127.0.0.1", PORT))
    print("qSupported:", cmd(s, "qSupported"), file=sys.stderr)
    for kind, addr, label in WATCHES:
        r = cmd(s, f"Z{kind},{addr:x},4")
        print(f"set Z{kind} @0x{addr:08x} ({label}) -> {r}", file=sys.stderr)

    print("=== native PI/SI MMIO access sequence (watchpoint hits) ===")
    print("  fmt: [n] PC=.. LR=.. r3=.. r4=.. r5=.. r6=.. MSR=..  (which-wp inferred from PC/addr)")
    for i in range(NHITS):
        send(s, "c")
        try:
            stop = recv(s)
        except socket.timeout:
            print(f"  [timeout after {i} hits — native idle/no more SI/PI access]"); break
        if stop is None:
            print("  (connection closed)"); break
        pc = reg(s, 64); lr = reg(s, 67); msr = reg(s, 65)
        r3 = reg(s, 3); r4 = reg(s, 4); r5 = reg(s, 5); r6 = reg(s, 6)
        # stop-reply often carries the watch addr (watch:/rwatch:/awatch:)
        wp = ""
        for tag in ("watch:", "rwatch:", "awatch:"):
            j = stop.find(tag)
            if j >= 0: wp = stop[j:j+24].split(';')[0]
        print(f"  [{i:3d}] PC=0x{h(pc)} LR=0x{h(lr)} r3=0x{h(r3)} r4=0x{h(r4)} "
              f"r5=0x{h(r5)} r6=0x{h(r6)} MSR=0x{h(msr)} {wp}")
    for kind, addr, _ in WATCHES:
        cmd(s, f"z{kind},{addr:x},4")
    s.close()

if __name__ == "__main__":
    main()

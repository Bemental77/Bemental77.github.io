#!/usr/bin/env python3
"""Single-step native Dolphin from SITransfer entry (PC=0x800eb058) for 200
samples — Row 2 checkpoint extension. Per gamecube_si_interrupt_storm_2026_05_27:
"backtrace chain: SITransfer (0x800eb058) → __SITransfer (0x800eaa20) →
__OSSyncSram → 0x800e3798 → CRT 0x8000321c". This script captures the native
register trajectory entering SITransfer so we can diff our wasm side-effect-free
analog against ground truth.

Captures: PC, r0..r6 (SI MMIO base ptr + xfer args typically in r3-r6),
r29-r31 (callee-saved frame regs), LR, CTR, MSR, PI INTSR/INTMR.

Dolphin GDB-RSP register map: 0..31 GPR, 64=PC, 65=MSR, 66=CR, 67=LR, 68=CTR.
"""
import socket, sys

PORT   = int(sys.argv[3]) if len(sys.argv) > 3 else 9092
ENTRY  = int(sys.argv[1], 16) if len(sys.argv) > 1 else 0x800eb058
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

    print(f"=== native SITransfer entry single-step from 0x{ENTRY:08x} ({NSTEPS} samples) ===")
    s.settimeout(15)
    prev_pc = None
    for i in range(NSTEPS):
        pc  = reg(s, 64)
        r0  = reg(s, 0);  r1  = reg(s, 1);  r3  = reg(s, 3);  r4 = reg(s, 4)
        r5  = reg(s, 5);  r6  = reg(s, 6)
        r29 = reg(s, 29); r30 = reg(s, 30); r31 = reg(s, 31)
        lr  = reg(s, 67); ctr = reg(s, 68); msr = reg(s, 65)
        intsr = mem32(s, 0xCC003000); intmr = mem32(s, 0xCC003004)
        marks = ""
        if pc is not None and pc < 0x80003000:
            marks += " <<EXCEPTION-VECTOR"
        if prev_pc is not None and pc is not None and abs(pc - prev_pc) > 0x40:
            marks += f" <<JUMP(d=0x{(pc-prev_pc)&0xffffffff:x})"
        prev_pc = pc
        print(f"  [{i:3d}] pc=0x{h(pc)} r0=0x{h(r0)} r1=0x{h(r1)} r3=0x{h(r3)} r4=0x{h(r4)} "
              f"r5=0x{h(r5)} r6=0x{h(r6)} r29=0x{h(r29)} r30=0x{h(r30)} r31=0x{h(r31)} "
              f"lr=0x{h(lr)} ctr=0x{h(ctr)} msr=0x{h(msr)} "
              f"INTSR=0x{h(intsr)} INTMR=0x{h(intmr)}{marks}")
        send(s, "s")
        if recv(s) is None: print("  (no stop-reply; stopping)"); break
    s.close()

if __name__ == "__main__":
    main()

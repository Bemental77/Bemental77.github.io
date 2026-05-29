#!/usr/bin/env python3
"""Single-step native Dolphin from MSR-EE leaf entry (PC=0x800e78f0) for 200
samples — Row 2 checkpoint extension. Per gamecube_si_interrupt_storm_2026_05_27:
"srr0=0x800e78f0 is inside a leaf mfmsr/mtmsr/rlwinm MSR-EE routine
(OSRestoreInterrupts/OSDisableInterrupts class — disasm: 0x800e78d8 mfmsr,
0x800e78ec mtmsr, 0x800e78f4 bclr)". Wasm srr0=0x800e78f0 during the storm.

We capture the native trajectory through this leaf to see how MSR.EE transitions
in normal-path execution (no exception fired), then diff against the wasm
stuck-on-srr0 state.

Captures: PC, r0/r3/r4, LR, CTR, MSR (the load-bearing reg here), SRR0/SRR1
when readable, PI INTSR/INTMR.

Dolphin GDB-RSP register map: 0..31 GPR, 64=PC, 65=MSR, 67=LR, 68=CTR.
SRR0/SRR1 are SPRs — not exposed via p<hex> on Dolphin's stub; we read MEM
mirrors when possible (Dolphin doesn't expose SPR memory either, so the
SRR0/SRR1 columns may be ???).
"""
import socket, sys

PORT   = int(sys.argv[3]) if len(sys.argv) > 3 else 9092
ENTRY  = int(sys.argv[1], 16) if len(sys.argv) > 1 else 0x800e78f0
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

    print(f"=== native MSR-EE leaf single-step from 0x{ENTRY:08x} ({NSTEPS} samples) ===")
    s.settimeout(15)
    prev_msr = None
    for i in range(NSTEPS):
        pc  = reg(s, 64)
        r0  = reg(s, 0);  r1 = reg(s, 1); r3 = reg(s, 3); r4 = reg(s, 4)
        lr  = reg(s, 67); ctr = reg(s, 68); msr = reg(s, 65)
        intsr = mem32(s, 0xCC003000); intmr = mem32(s, 0xCC003004)
        marks = ""
        if pc is not None and pc < 0x80003000:
            marks += " <<EXCEPTION-VECTOR"
        if msr != prev_msr:
            ee_prev = (prev_msr >> 15) & 1 if prev_msr is not None else None
            ee_new  = (msr      >> 15) & 1 if msr      is not None else None
            marks += f" <<MSR {h(prev_msr)}->{h(msr)} EE:{ee_prev}->{ee_new}"
        prev_msr = msr
        print(f"  [{i:3d}] pc=0x{h(pc)} r0=0x{h(r0)} r1=0x{h(r1)} r3=0x{h(r3)} r4=0x{h(r4)} "
              f"lr=0x{h(lr)} ctr=0x{h(ctr)} msr=0x{h(msr)} "
              f"INTSR=0x{h(intsr)} INTMR=0x{h(intmr)}{marks}")
        send(s, "s")
        if recv(s) is None: print("  (no stop-reply; stopping)"); break
    s.close()

if __name__ == "__main__":
    main()

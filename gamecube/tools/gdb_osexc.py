#!/usr/bin/env python3
"""Trace native Dolphin through the OSExceptionInit region (fn 0x800e362c) to
get ground-truth control flow vs the wasm self-loop. BP key PCs, count hits over
a window, and read the init-guard flag + Exceptions at each stop.

Native should hit 0x800e362c once, reach the store at 0x800e3658 (flag:=1), take
the bne at 0x800e3650 to the epilogue 0x800e3958 on RE-entry, and return. The
wasm never reaches the store and re-enters the prologue (r1 leak).
"""
import socket, time, sys

PORT = 9090
BPS = {
    "entry_362c":     0x800e362c,
    "flagload_3640":  0x800e3640,
    "bne_3650":       0x800e3650,
    "store_3658":     0x800e3658,
    "bl_365c":        0x800e365c,
    "epilogue_3958":  0x800e3958,
    "blr_396c":       0x800e396c,
    "fn_3970":        0x800e3970,
    "hot_3a44":       0x800e3a44,
}
FLAG_ADDR = 0x803adc4c


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

def read_u32(s, addr):
    r = cmd(s, f"m{addr:x},4")
    if r is None or (len(r) == 3 and r[0] == "E"):
        return None
    try:
        b = bytes.fromhex(r)
        return int.from_bytes(b, "big")  # guest big-endian
    except ValueError:
        return None


def main():
    s = socket.socket(); s.settimeout(8); s.connect(("127.0.0.1", PORT))
    cmd(s, "qSupported")
    for name, pc in BPS.items():
        cmd(s, f"Z1,{pc:x},4")
    counts = {n: 0 for n in BPS}
    first_flag = {}
    window = float(sys.argv[1]) if len(sys.argv) > 1 else 20.0
    start = time.time()
    send(s, "c")
    print(f"[osexc] continue, observing {window}s...", file=sys.stderr)
    s.settimeout(1.0)
    while time.time() - start < window:
        try:
            ch = s.recv(1)
        except socket.timeout:
            continue
        if not ch: break
        if ch in (b"+", b"-"): continue
        if ch == b"$":
            buf = b""
            while True:
                c = s.recv(1)
                if c == b"#": s.recv(2); s.sendall(b"+"); break
                buf += c
            stop = buf.decode("latin-1")
            # find which BP: read PC (reg 64)
            pcr = cmd(s, "p40")
            pc = None
            try: pc = int.from_bytes(bytes.fromhex(pcr), "big") if pcr else None
            except Exception: pc = None
            name = next((n for n, a in BPS.items() if a == pc), None)
            if name:
                counts[name] += 1
                if name not in first_flag:
                    fv = read_u32(s, FLAG_ADDR)
                    first_flag[name] = fv
            send(s, "c")
    print("\n=== OSExceptionInit native trace ===")
    for n, pc in BPS.items():
        ff = first_flag.get(n)
        ffs = f" flag@first=0x{ff:08x}" if ff is not None else ""
        print(f"  {n:16s} @0x{pc:08x}: hits={counts[n]}{ffs}")
    print(f"\nfinal flag[0x{FLAG_ADDR:08x}] = " +
          (lambda v: f"0x{v:08x}" if v is not None else "?")(read_u32(s, FLAG_ADDR)))
    try: s.sendall(b"\x03"); time.sleep(0.2)
    except Exception: pass
    s.close()


if __name__ == "__main__":
    main()

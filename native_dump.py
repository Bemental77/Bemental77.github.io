#!/usr/bin/env python3
"""Minimal GDB Remote Serial Protocol client for Dolphin's GDB stub.

Dumps the 12 instruction words at 0x800e52f4..0x800e5320 (the goal — to
identify what's at the supposedly-stuck PC), then runs to BP at 0x800e52fc
and dumps register state.

Memory dumps don't have endianness ambiguity (GDB transmits bytes in target
order; PowerPC is big-endian; we read 4-byte words MSB-first).
"""

import socket
import sys
import time

PORT      = int(sys.argv[1]) if len(sys.argv) > 1 else 9090
DUMP_ADDR = 0x800e52f4
DUMP_LEN  = 12 * 4  # 12 instructions
BREAK_PC  = 0x800e52fc

def cksum(s):
    return sum(s.encode()) & 0xff

def send(sock, data):
    sock.sendall(f"${data}#{cksum(data):02x}".encode())

def recv_packet(sock):
    while True:
        ch = sock.recv(1)
        if not ch:           return None
        if ch in (b"+", b"-"): continue
        if ch == b"$":
            buf = b""
            while True:
                c = sock.recv(1)
                if c == b"#":
                    sock.recv(2)
                    sock.sendall(b"+")
                    return buf.decode("latin-1")
                buf += c

def cmd(sock, packet):
    send(sock, packet)
    return recv_packet(sock)

def fmt_g_layout(g):
    """Print 'g' response as offsets — lets us see what Dolphin sends."""
    print(f"  raw 'g' length = {len(g)} hex chars = {len(g)//2} bytes")
    if len(g) >= 8:
        print(f"  first 8 bytes (r0): {g[:8]}")
    # Try both endian interpretations of r1 (which should be a stack ptr)
    if len(g) >= 16:
        r1_be = int(g[8:16], 16)
        r1_le_swap = int.from_bytes(bytes.fromhex(g[8:16]), "little")
        print(f"  r1 BE-interp = 0x{r1_be:08x}, byte-swapped = 0x{r1_le_swap:08x}")

def main():
    sock = socket.create_connection(("127.0.0.1", PORT), timeout=10)
    sock.sendall(b"+")
    time.sleep(0.1)

    print("[probe] qSupported:", cmd(sock, "qSupported:multiprocess+;swbreak+;hwbreak+"))
    print("[probe] attach stop:", cmd(sock, "?"))

    # Continue running so the IPL boots and PSO loads. PC=0x800e52f4 region
    # only contains valid instructions AFTER PSO is loaded.
    print("\n[continue 15s — let IPL + PSO load]")
    send(sock, "c")
    time.sleep(15)
    print("  sending interrupt")
    sock.sendall(b"\x03")
    sock.settimeout(10)
    stop = recv_packet(sock)
    print(f"  stop reply after interrupt: {stop!r}")
    # Parse PC out of T-packet: T<sig>NN:<val>;...
    pc_at_stop = None
    if stop and stop.startswith("T"):
        for kv in stop[3:].split(";"):
            if not kv: continue
            k, _, v = kv.partition(":")
            if k.lower() == "40":  # PC is reg 0x40 in Dolphin's stub
                pc_at_stop = int(v, 16)
                break
    print(f"  PC at interrupt: 0x{pc_at_stop:08x}" if pc_at_stop else "  PC unknown")

    # Drain any queued packets after the interrupt (stop notifications,
    # async output, etc.) before issuing fresh memory reads.
    sock.settimeout(0.3)
    drained = 0
    while True:
        try:
            extra = recv_packet(sock)
            if extra is None: break
            drained += 1
            print(f"  [drained queued: {extra!r}]")
        except socket.timeout:
            break
    sock.settimeout(10)
    print(f"  drained {drained} queued packets")

    # Read 12 individual 4-byte words at 0x800e52f4
    print(f"\n[memory at 0x{DUMP_ADDR:08x} — 12 individual 4-byte reads]")
    words = []
    for i in range(12):
        addr = DUMP_ADDR + i*4
        m = cmd(sock, f"m{addr:x},4")
        if m and len(m) == 8 and m[0] != "E":
            w = int(m, 16)
            words.append(w)
            print(f"  0x{addr:08x}: 0x{w:08x}")
        else:
            print(f"  0x{addr:08x}: ERROR reply={m!r}")
            words.append(None)

    # Detach
    cmd(sock, "D")
    sock.close()

if __name__ == "__main__":
    main()

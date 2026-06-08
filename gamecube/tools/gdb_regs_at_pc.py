#!/usr/bin/env python3
"""Capture native register state at a given PC via Dolphin's GDB stub.

Usage:
  Launch Dolphin with -C Dolphin.General.GDBPort=24689 -e <ROM>
  Run this script (defaults to PC=0x800e78cc, first 10 hits).
  Output: /tmp/regs_at_pc.log
"""
import socket, sys, time, os, re

HOST = "127.0.0.1"
PORT = int(os.environ.get("GDB_PORT", "24689"))
LOG  = os.environ.get("REGS_LOG", "/tmp/regs_at_pc.log")
PC_LIST = [int(x, 16) for x in os.environ.get(
    "BP_PCS", "0x800e78ac,0x800e78b8,0x800e78c0,0x800e78c4,0x800e78c8,0x800e78cc,0x800e78d0,0x800eb71c"
).split(",")]
MAX_HITS = int(os.environ.get("MAX_HITS", "20"))
DURATION = float(os.environ.get("WATCH_DURATION", "30"))

def checksum(payload: bytes) -> str:
    return f"{sum(payload) & 0xff:02x}"

def send(sock, payload: str):
    pkt = f"${payload}#{checksum(payload.encode())}".encode()
    sock.sendall(pkt)

def recv_packet(sock) -> str:
    buf = b""
    while True:
        ch = sock.recv(1)
        if not ch: return ""
        if ch in (b"+", b"-"): continue
        if ch == b"$": break
    while True:
        ch = sock.recv(1)
        if not ch: return ""
        if ch == b"#":
            sock.recv(2)
            sock.sendall(b"+")
            return buf.decode(errors="replace")
        buf += ch

def parse_gprs(g: str):
    """Read first 32 4-byte registers as GPRs (8 hex chars each)."""
    gprs = []
    for i in range(32):
        h = g[i*8:(i+1)*8]
        if len(h) == 8:
            gprs.append(int(h, 16))
    return gprs

def parse_special(g: str):
    """After 32 GPRs and 32 FPRs (each 16 hex chars), Dolphin GDB stub
    emits PC, MSR, CR, LR, CTR, XER, FPSCR (each 8 hex chars).
    Offset of PC = 32*8 + 32*16 = 256 + 512 = 768 hex chars."""
    base = 32*8 + 32*16
    keys = ["PC", "MSR", "CR", "LR", "CTR", "XER", "FPSCR"]
    out = {}
    for i, k in enumerate(keys):
        off = base + i*8
        h = g[off:off+8]
        if len(h) == 8:
            out[k] = int(h, 16)
    return out

def main():
    s = socket.socket()
    s.settimeout(60)
    for _ in range(60):
        try:
            s.connect((HOST, PORT)); break
        except (ConnectionRefusedError, OSError):
            time.sleep(0.25)
    else:
        print("could not connect", file=sys.stderr); sys.exit(1)

    s.settimeout(15)
    send(s, "?")
    initial = recv_packet(s)
    print(f"initial: {initial[:80]}", file=sys.stderr)

    # Set software execute breakpoints at each target PC (Z0)
    for pc in PC_LIST:
        send(s, f"Z0,{pc:x},4")
        resp = recv_packet(s)
        print(f"Z0 {pc:x},4 -> {resp!r}", file=sys.stderr)

    logf = open(LOG, "w", buffering=1)
    logf.write(f"# captures at PCs={[hex(x) for x in PC_LIST]} max_hits={MAX_HITS} duration={DURATION}s\n")

    s.settimeout(DURATION)
    hits = 0
    deadline = time.time() + DURATION
    while hits < MAX_HITS and time.time() < deadline:
        send(s, "c")
        try:
            stop = recv_packet(s)
        except socket.timeout:
            break
        if not stop: break
        if stop[0] != "T":
            logf.write(f"# non-T stop: {stop}\n"); break

        send(s, "g")
        g = recv_packet(s)
        gprs = parse_gprs(g)
        spec = parse_special(g)
        hits += 1
        logf.write(f"\n[hit #{hits}] stop_pkt={stop}\n")
        logf.write(f"  PC=0x{spec.get('PC',0):08x}  MSR=0x{spec.get('MSR',0):08x}  "
                   f"CR=0x{spec.get('CR',0):08x}  LR=0x{spec.get('LR',0):08x}  "
                   f"CTR=0x{spec.get('CTR',0):08x}  XER=0x{spec.get('XER',0):08x}\n")
        for i in range(0, 32, 4):
            logf.write("  " + "  ".join(
                f"r{i+j}={gprs[i+j]:08x}" for j in range(4) if i+j < len(gprs)) + "\n")
        # Also dump MEM[0x800000C0..0xCF] for context.
        send(s, "m800000c0,10")
        mem = recv_packet(s)
        logf.write(f"  MEM[0xC0..0xCF]={mem}\n")

    # Cleanup
    for pc in PC_LIST:
        send(s, f"z0,{pc:x},4"); recv_packet(s)
    send(s, "D");
    try: recv_packet(s)
    except: pass
    s.close()
    logf.write(f"\n# done hits={hits}\n")
    print(f"done hits={hits} log={LOG}", file=sys.stderr)

if __name__ == "__main__":
    main()

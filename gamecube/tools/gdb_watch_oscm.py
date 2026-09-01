#!/usr/bin/env python3
"""Drive Dolphin's GDB stub to watch writes to the OS interrupt mask region
(0x800000C0..0x800000CB and 0x800000D0..0x800000D7), log writer PC + value,
and continue. Replaces the manual Load-button workflow.

Usage:
  1. Launch Dolphin with GDB stub enabled and the SAB ISO. CPU starts paused
     waiting for gdb to connect.
  2. Run this script. It connects, sets write watchpoints, continues,
     and logs every hit to /tmp/oscm_watch.log.
  3. Quit when satisfied (Ctrl-C this script, then kill Dolphin).
"""
import socket, sys, time, os, re

HOST = "127.0.0.1"
PORT = int(os.environ.get("GDB_PORT", "24689"))
LOG  = os.environ.get("WATCH_LOG", "/tmp/oscm_watch.log")
DURATION = float(os.environ.get("WATCH_DURATION", "12"))

def checksum(payload: bytes) -> str:
    return f"{sum(payload) & 0xff:02x}"

def send(sock, payload: str):
    pkt = f"${payload}#{checksum(payload.encode())}".encode()
    sock.sendall(pkt)

def recv_packet(sock) -> str:
    # Read +/-/$ then payload then #cs
    buf = b""
    while True:
        ch = sock.recv(1)
        if not ch:
            return ""
        if ch == b"+" or ch == b"-":
            continue
        if ch == b"$":
            break
    while True:
        ch = sock.recv(1)
        if not ch:
            return ""
        if ch == b"#":
            sock.recv(2)  # checksum
            sock.sendall(b"+")
            return buf.decode(errors="replace")
        buf += ch

def parse_regs(g_resp: str):
    # GDB g packet for PowerPC: 32 GPRs * 4 bytes + FPRs + PC, NPC, MSR, CR...
    # Dolphin's GDBStub orders: r0..r31 (32*8 hex=256 chars), then FPRs (32*8), then PC at offset...
    # Easiest: just compute PC offset from gdbstub source if needed. For now,
    # read the first 32*8 = 256 hex chars as r0..r31 (each 4 bytes).
    hex_chars_per_gpr = 8
    gprs = []
    for i in range(32):
        h = g_resp[i*hex_chars_per_gpr:(i+1)*hex_chars_per_gpr]
        if len(h) == hex_chars_per_gpr:
            gprs.append(int(h, 16))
    return gprs

def fmt_stop(stop_pkt: str, gprs):
    # T-packet payload: e.g. "T05awatch:800000c4;05:817ff7f0;40:800ea3f0;"
    m = re.search(r"(awatch|watch|rwatch):([0-9a-f]+)", stop_pkt)
    addr = m.group(2) if m else "?"
    r1 = gprs[1] if len(gprs) > 1 else 0
    return f"watch hit addr=0x{addr} sp=0x{r1:08x} packet={stop_pkt[:80]}"

def main():
    print(f"connecting to {HOST}:{PORT}", file=sys.stderr)
    s = socket.socket()
    s.settimeout(30)
    for _ in range(60):
        try:
            s.connect((HOST, PORT))
            break
        except (ConnectionRefusedError, OSError):
            time.sleep(0.25)
    else:
        print("could not connect to gdb stub", file=sys.stderr)
        sys.exit(1)
    print("connected", file=sys.stderr)

    # Initial handshake: query stop reason. Dolphin's stub does not
    # auto-send on connect.
    s.settimeout(5)
    send(s, "?")
    initial = recv_packet(s)
    print(f"initial stop: {initial[:80]}", file=sys.stderr)

    # Set Z2 (write watchpoint) on the two ranges.
    # 0x800000C0..0x800000CB = 12 bytes
    # 0x800000D0..0x800000D7 = 8 bytes
    for addr, length in [(0x800000c0, 12), (0x800000d0, 8)]:
        send(s, f"Z2,{addr:x},{length}")
        resp = recv_packet(s)
        print(f"Z2 {addr:08x},{length}: {resp!r}", file=sys.stderr)
        if resp != "OK":
            print(f"FAIL to set Z2 at {addr:x}: {resp}", file=sys.stderr)

    # Open log.
    logf = open(LOG, "w", buffering=1)
    logf.write(f"# watch run started {time.time()} duration={DURATION}s\n")
    hit_count = 0

    def read_mem(addr, length):
        send(s, f"m{addr:x},{length:x}")
        return recv_packet(s)

    deadline = time.time() + DURATION
    while time.time() < deadline:
        send(s, "c")
        try:
            stop = recv_packet(s)
        except socket.timeout:
            break
        if not stop:
            break
        if stop[0] == "T":
            # Read PC (40:) from T-packet directly; saves a `g` roundtrip.
            m_pc = re.search(r"40:([0-9a-f]+)", stop)
            pc = m_pc.group(1) if m_pc else "?"
            # Read both regions: 0xC0..0xCF (16B) and 0xD0..0xD7 (8B).
            mem_c = read_mem(0x800000c0, 16)
            mem_d = read_mem(0x800000d0, 8)
            logf.write(f"pc=0x{pc}  C0..CF={mem_c}  D0..D7={mem_d}\n")
            hit_count += 1
        elif stop[0] in ("S", "W", "X"):
            logf.write(f"# stop: {stop}\n")
            if stop[0] in ("W", "X"):
                break
        else:
            logf.write(f"# unknown: {stop}\n")
    logf.write(f"# done hits={hit_count}\n")
    print(f"done hits={hit_count} log={LOG}", file=sys.stderr)

    # Remove watchpoints, detach.
    for addr, length in [(0x800000c0, 12), (0x800000d0, 8)]:
        send(s, f"z2,{addr:x},{length}")
        recv_packet(s)
    send(s, "D")  # detach
    try:
        recv_packet(s)
    except Exception:
        pass
    s.close()

if __name__ == "__main__":
    main()

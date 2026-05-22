#!/usr/bin/env python3
"""Dump a guest MEM1 range from native Dolphin over its GDB-RSP stub.

Connects to Dolphin's GDB stub (default :9090), optionally sets a breakpoint
at a halt PC (BS2 hand-off = 0x80003140), continues until it is hit, then reads
the range [START, END) in chunks via `m` packets and writes raw bytes to OUT.

Used to capture the native post-apploader MEM1 image for diffing against the
wasm JIT build's image (see gamecube/tools + dolphin_render_probe.js mem-dump).

Usage:
  python3 gdb_memdump.py [--port 9090] [--bp 0x80003140] \
                         [--start 0x80003000] [--end 0x80140000] \
                         [--out /tmp/native-mem.bin] [--chunk 2048] [--timeout 60]

  --bp 0  : skip breakpoint, dump immediately at current (already-halted) state.
"""
import argparse, socket, sys, time


def cksum(s):
    return sum(s.encode()) & 0xff


def send(sock, data):
    sock.sendall(f"${data}#{cksum(data):02x}".encode())


def recv_packet(sock):
    """Read one RSP packet payload, ACK it, return as latin-1 str (or None)."""
    while True:
        ch = sock.recv(1)
        if not ch:
            return None
        if ch in (b"+", b"-"):
            continue
        if ch == b"$":
            buf = b""
            while True:
                c = sock.recv(1)
                if not c:
                    return None
                if c == b"#":
                    sock.recv(2)          # checksum bytes
                    sock.sendall(b"+")    # ACK
                    return buf.decode("latin-1")
                buf += c


def cmd(sock, packet):
    send(sock, packet)
    return recv_packet(sock)


def wait_for_stop(sock, timeout):
    """After a `c`, block until a stop-reply (S/T) packet or timeout."""
    start = time.time()
    sock.settimeout(1.0)
    while time.time() - start < timeout:
        try:
            ch = sock.recv(1)
        except socket.timeout:
            continue
        if not ch:
            return None
        if ch in (b"+", b"-"):
            continue
        if ch == b"$":
            buf = b""
            while True:
                c = sock.recv(1)
                if c == b"#":
                    sock.recv(2)
                    sock.sendall(b"+")
                    return buf.decode("latin-1")
                buf += c
    return "TIMEOUT"


def read_range(sock, start, end, chunk):
    out = bytearray()
    sock.settimeout(10.0)
    addr = start
    total = end - start
    while addr < end:
        n = min(chunk, end - addr)
        r = cmd(sock, f"m{addr:x},{n:x}")
        if r is None or (len(r) >= 3 and r[0] == "E" and len(r) == 3):
            print(f"[memdump] read error at 0x{addr:08x}: {r!r}", file=sys.stderr)
            # pad the failed chunk with zeros so offsets stay aligned
            out += bytes(n)
            addr += n
            continue
        try:
            out += bytes.fromhex(r)
        except ValueError:
            print(f"[memdump] non-hex reply at 0x{addr:08x}: {r[:40]!r}", file=sys.stderr)
            out += bytes(n)
        addr += n
        done = addr - start
        if (done // chunk) % 64 == 0:
            print(f"\r[memdump] {done}/{total} bytes ({100*done//total}%)", end="", file=sys.stderr)
    print(f"\r[memdump] {total}/{total} bytes (100%)        ", file=sys.stderr)
    return bytes(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9090)
    ap.add_argument("--bp", type=lambda x: int(x, 0), default=0x80003140)
    ap.add_argument("--start", type=lambda x: int(x, 0), default=0x80003000)
    ap.add_argument("--end", type=lambda x: int(x, 0), default=0x80140000)
    ap.add_argument("--out", default="/tmp/native-mem.bin")
    ap.add_argument("--chunk", type=lambda x: int(x, 0), default=2048)
    ap.add_argument("--timeout", type=float, default=60.0)
    args = ap.parse_args()

    s = socket.socket()
    s.settimeout(10.0)
    s.connect((args.host, args.port))
    print(f"[memdump] connected to {args.host}:{args.port}", file=sys.stderr)

    sup = cmd(s, "qSupported")
    print(f"[memdump] qSupported -> {sup[:80]}", file=sys.stderr)

    if args.bp:
        r = cmd(s, f"Z1,{args.bp:x},4")
        print(f"[memdump] set BP @0x{args.bp:08x} -> {r!r}", file=sys.stderr)
        send(s, "c")
        print(f"[memdump] continue, waiting up to {args.timeout}s for 0x{args.bp:08x}...", file=sys.stderr)
        stop = wait_for_stop(s, args.timeout)
        print(f"[memdump] stop-reply: {stop!r}", file=sys.stderr)
        if stop in (None, "TIMEOUT"):
            print("[memdump] BP not hit; aborting (no dump written)", file=sys.stderr)
            s.close()
            sys.exit(2)
        cmd(s, f"z1,{args.bp:x},4")  # clear BP

    data = read_range(s, args.start, args.end, args.chunk)
    with open(args.out, "wb") as f:
        f.write(data)
    print(f"[memdump] wrote {args.out} ({len(data)} bytes, "
          f"0x{args.start:08x}..0x{args.end:08x})", file=sys.stderr)
    s.close()


if __name__ == "__main__":
    main()

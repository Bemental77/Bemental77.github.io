#!/usr/bin/env python3
"""mw_listener.py — capture Dolphin MemoryWatcher UDS messages.

Dolphin writes to AF_UNIX SOCK_DGRAM at User/MemoryWatcher/MemoryWatcher
once per emulated frame, with body `addr_string\\n<hex_value>\\n` for each
changed value. We just bind the socket, log every datagram with a wall
timestamp and seen-ordinal, and exit cleanly on Ctrl-C.

Usage:
  mw_listener.py <socket_path> [--out file]

The socket file is created by Dolphin on Init; we must bind FIRST so the
sendto() actually delivers (otherwise Dolphin's sendto returns EPIPE and
the message is dropped). Order:
  1. Run mw_listener.py first.
  2. Then start Dolphin with -u <user_dir> pointing at the right MemoryWatcher dir.
"""
import argparse
import datetime
import os
import socket
import sys
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("socket_path")
    ap.add_argument("--out", default="-",
                    help="output file (default stdout)")
    args = ap.parse_args()

    # Bind the socket; create the path if needed.
    os.makedirs(os.path.dirname(args.socket_path), exist_ok=True)
    if os.path.exists(args.socket_path):
        os.unlink(args.socket_path)

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    sock.bind(args.socket_path)
    sock.settimeout(0.5)

    out = sys.stdout if args.out == "-" else open(args.out, "w", buffering=1)

    n = 0
    start = time.monotonic()
    print(f"[mw] bound {args.socket_path}, waiting for Dolphin...", file=sys.stderr)
    try:
        while True:
            try:
                data, _ = sock.recvfrom(65536)
            except socket.timeout:
                continue
            wall = time.monotonic() - start
            n += 1
            text = data.decode("utf-8", errors="replace").rstrip("\x00\n")
            # Each datagram is multi-line: addr1\nval1\naddr2\nval2\n...
            lines = text.split("\n")
            for i in range(0, len(lines) - 1, 2):
                addr = lines[i]
                val = lines[i + 1] if i + 1 < len(lines) else ""
                print(f"[mw#{n} t={wall:7.3f}s] {addr} = 0x{val}", file=out)
    except KeyboardInterrupt:
        pass
    finally:
        sock.close()
        try:
            os.unlink(args.socket_path)
        except OSError:
            pass
        print(f"[mw] received {n} datagrams in {time.monotonic()-start:.1f}s",
              file=sys.stderr)


if __name__ == "__main__":
    main()

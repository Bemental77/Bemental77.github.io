#!/usr/bin/env python3
"""Dump memory via Dolphin's GDB stub. One-shot."""
import socket, sys, time, os

HOST, PORT = "127.0.0.1", int(os.environ.get("GDB_PORT", "24689"))
ADDR = int(os.environ.get("ADDR", "0x800e78ac"), 16)
LEN  = int(os.environ.get("LEN",  "48"))

def cs(p): return f"{sum(p) & 0xff:02x}"
def send(s, p): s.sendall(f"${p}#{cs(p.encode())}".encode())
def recv(s):
    buf=b""
    while True:
        c=s.recv(1)
        if c in (b"+",b"-"): continue
        if c==b"$": break
    while True:
        c=s.recv(1)
        if c==b"#": s.recv(2); s.sendall(b"+"); return buf.decode()
        buf+=c

s=socket.socket(); s.settimeout(10); s.connect((HOST,PORT))
send(s,"?"); recv(s)
send(s,f"m{ADDR:x},{LEN:x}"); data=recv(s)
print(f"addr=0x{ADDR:x} len={LEN}")
print(f"raw={data}")
# Decode as PowerPC instruction words (BE)
import struct
b=bytes.fromhex(data)
for i in range(0, len(b), 4):
    w=struct.unpack(">I", b[i:i+4])[0]
    print(f"  0x{ADDR+i:08x}: {w:08x}")
send(s,"D"); s.close()

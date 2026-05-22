#!/usr/bin/env python3
"""Count BP hits inside zz_800e33b4_. Detect if native returns from it."""
import socket, time, re

PORT = 9090
BPS = {
    "entry":           0x800e33b4,
    "bl_80071fa8":     0x800e33c0,
    "after_71fa8":     0x800e33c4,
    "bl_801235b8":     0x800e33d4,
    "bl_801235c0":     0x800e33e0,
    "bl_801235c8":     0x800e33ec,
    "bl_801235d0":     0x800e33f8,
    "bl_801235d8":     0x800e3404,
    "bl_800eeff0":     0x800e342c,
    "after_eeff0":     0x800e3430,
    "blr_exit":        0x800e343c,
    "caller_d3aec":    0x800d3aec,
    "caller_d3af0":    0x800d3af0,
}

def cksum(s): return sum(s.encode()) & 0xff
def send(sock, data): sock.sendall(f"${data}#{cksum(data):02x}".encode())
def recv_packet(sock):
    while True:
        ch = sock.recv(1)
        if not ch: return None
        if ch in (b"+", b"-"): continue
        if ch == b"$":
            buf = b""
            while True:
                c = sock.recv(1)
                if c == b"#":
                    sock.recv(2); sock.sendall(b"+")
                    return buf.decode("latin-1")
                buf += c
def cmd(sock, packet):
    send(sock, packet); return recv_packet(sock)

s = socket.socket(); s.connect(("127.0.0.1", PORT)); s.settimeout(5)
cmd(s, 'qSupported')
for name, pc in BPS.items():
    r = cmd(s, f"Z1,{pc:x},4")
    print(f"[gdb] BP {name} @0x{pc:08x}: {r}")

counts = {name: 0 for name in BPS}

start = time.time()
send(s, "c")
print("[gdb] continue, observing 12s...")
while time.time() - start < 12.0:
    try:
        s.settimeout(1.0)
        ch = s.recv(1)
        if ch in (b"+", b"-"): continue
        if ch == b"$":
            buf = b""
            while True:
                c = s.recv(1)
                if c == b"#": s.recv(2); s.sendall(b"+"); break
                buf += c
            stop = buf.decode("latin-1")
            pc = None
            for m in re.finditer(r"\b(40|64):([0-9a-f]+);", stop):
                pc = int(m.group(2), 16); break
            if pc is None:
                for addr in BPS.values():
                    if f"{addr:08x}" in stop.lower():
                        pc = addr; break
            hit_name = next((n for n, addr in BPS.items() if pc == addr), None)
            if hit_name:
                counts[hit_name] += 1
            send(s, "c")
    except socket.timeout:
        pass

print(f"\n=== BP hits in 12s ===")
for name in BPS:
    print(f"  {name:18s} @0x{BPS[name]:08x}: {counts[name]}")

try:
    s.sendall(b"\x03"); time.sleep(0.3)
    for n, pc in BPS.items(): cmd(s, f"z1,{pc:x},4")
except: pass
s.close()

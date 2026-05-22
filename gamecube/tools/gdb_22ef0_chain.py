#!/usr/bin/env python3
"""Count BP hits at zz_80022ef0_ poll chain in native Dolphin via GDB-RSP.
Goal: confirm whether native enters/exits this chain once (correct) or spins.
"""
import socket, time, re

PORT = 9090
BPS = {
    "fn_d3ad0_entry":   0x800d3ad0,
    "d3af0_bl3":        0x800d3af0,
    "d3af4_bl4":        0x800d3af4,
    "d3af8_li_r0_0":    0x800d3af8,  # AFTER both bls returned
    "fn_22ef0_poll":    0x80022ef0,
    "fn_22f00_initstore":0x80022f00,
    "fn_22f08_entry":   0x80022f08,
    "fn_22f64_entry":   0x80022f64,
    "fn_22f70_dec":     0x80022f70,
    "fn_e362c_entry":   0x800e362c,
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
print("[gdb] continue, observing 10s...")
while time.time() - start < 10.0:
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

print(f"\n=== BP hits in 10s ===")
for name in BPS:
    print(f"  {name:20s} @0x{BPS[name]:08x}: {counts[name]}")

try:
    s.sendall(b"\x03"); time.sleep(0.3)
    for n, pc in BPS.items(): cmd(s, f"z1,{pc:x},4")
except: pass
s.close()

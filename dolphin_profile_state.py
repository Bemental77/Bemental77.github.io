#!/usr/bin/env python3
"""Sample-profile native Dolphin GAMEPLAY by loading an initial savestate.

Variant of dolphin_profile.py: adds `-s <savestate>` so Dolphin boots straight
into a gameplay snapshot instead of the cold boot/decompressor. Used to capture
the native IN-GAME hot-function profile (the speed/work bar that the WASM build
must match), not the boot profile.

Usage: python3 dolphin_profile_state.py <gameid> <iso_path> <savestate_path> [duration_s]
"""

import os, sys, socket, subprocess, time, signal, shutil
from collections import Counter

DOLPHIN = "/Applications/Dolphin.app/Contents/MacOS/Dolphin"
PORT = 9090
SAMPLE_GAP_S = 0.05
DURATION_S = float(sys.argv[4]) if len(sys.argv) > 4 else 20.0

if len(sys.argv) < 4:
    sys.stderr.write(f"Usage: {sys.argv[0]} <gameid> <iso_path> <savestate_path> [duration_s]\n")
    sys.exit(2)

gameid = sys.argv[1]
iso = sys.argv[2]
state = os.path.expanduser(sys.argv[3])

# Map: prefer the canonical Dolphin Maps/ path, fall back to the repo capture.
mapfile = os.path.expanduser(f"~/Library/Application Support/Dolphin/Maps/{gameid}.map")
if not os.path.exists(mapfile):
    repo_map = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dolphin_captures", "pso.map")
    if os.path.exists(repo_map):
        mapfile = repo_map

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
                    sock.recv(2); sock.sendall(b"+"); return buf.decode("latin-1")
                buf += c
def cmd(sock, packet): send(sock, packet); return recv_packet(sock)
def parse_pc_from_t(stop):
    if not stop or not stop.startswith("T"): return None
    for kv in stop[3:].split(";"):
        if not kv: continue
        k, _, v = kv.partition(":")
        if k.lower() == "40": return int(v, 16)
    return None

def load_map(path):
    if not os.path.exists(path):
        sys.stderr.write(f"[warn] no map at {path} — raw PCs\n"); return []
    rows = []
    for line in open(path):
        parts = line.split(maxsplit=5)
        if len(parts) < 5: continue
        try:
            start = int(parts[0], 16); size = int(parts[1], 16); name = parts[4]
            rows.append((start, start + size, name))
        except ValueError: continue
    rows.sort(); return rows
def lookup(symtab, pc):
    if not symtab: return None
    lo, hi = 0, len(symtab) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        s, e, n = symtab[mid]
        if pc < s: hi = mid - 1
        elif pc >= e: lo = mid + 1
        else: return (s, e, n)
    return None

print(f"[profile] game={gameid} iso={iso}", flush=True)
print(f"[profile] savestate={state}", flush=True)
print(f"[profile] duration={DURATION_S}s mapfile={mapfile}", flush=True)

if shutil.which("lsof"):
    try:
        out = subprocess.check_output(["lsof", "-ti", f":{PORT}"], text=True).strip()
        for pid in out.split("\n"):
            if pid: os.kill(int(pid), signal.SIGTERM)
    except subprocess.CalledProcessError: pass

dolphin_log = f"/tmp/dolphin_{gameid}_state.log"
dolphin = subprocess.Popen(
    [DOLPHIN, "-d",
     "-C", f"Dolphin.General.GDBPort={PORT}",
     "-C", "Dolphin.Core.CPUCore=1",
     "-s", state,
     "-e", iso],
    stdout=open(dolphin_log, "w"), stderr=subprocess.STDOUT,
)
print(f"[profile] launched Dolphin pid={dolphin.pid}, waiting for GDB stub...", flush=True)

t0 = time.time(); sock = None
while time.time() - t0 < 15:
    try:
        sock = socket.create_connection(("127.0.0.1", PORT), timeout=2); break
    except (ConnectionRefusedError, socket.timeout): time.sleep(0.3)
if sock is None:
    print("[profile] ERROR: GDB stub never bound — tail:", flush=True)
    os.system(f"tail -20 {dolphin_log}"); dolphin.terminate(); sys.exit(1)

print("[profile] GDB stub up, sampling...", flush=True)
sock.sendall(b"+"); time.sleep(0.2)
cmd(sock, "qSupported:multiprocess+;swbreak+;hwbreak+")
send(sock, "c")

samples = Counter(); n_samples = 0; n_errors = 0
sock.settimeout(2.0); t_start = time.time()
while time.time() - t_start < DURATION_S:
    time.sleep(SAMPLE_GAP_S)
    sock.sendall(b"\x03")
    try: stop = recv_packet(sock)
    except socket.timeout:
        n_errors += 1
        try: send(sock, "c")
        except Exception: break
        continue
    pc = parse_pc_from_t(stop)
    if pc is not None: samples[pc] += 1; n_samples += 1
    send(sock, "c")

elapsed = time.time() - t_start
print(f"\n[profile] done: {n_samples} samples in {elapsed:.1f}s ({n_errors} errors)", flush=True)
try: cmd(sock, "D")
except Exception: pass
sock.close(); dolphin.terminate()
try: dolphin.wait(timeout=3)
except Exception: dolphin.kill()

symtab = load_map(mapfile)
fn_counts = Counter(); unmapped = Counter()
for pc, count in samples.items():
    sym = lookup(symtab, pc)
    if sym is None: unmapped[pc] += count
    else: fn_counts[sym] += count

print("\n=== Top 30 hot functions (native gameplay) ===")
print(f"{'samples':>8} {'pct':>6}  start_pc      end_pc    name")
for (s, e, n), count in fn_counts.most_common(30):
    pct = 100.0 * count / max(1, n_samples)
    print(f"{count:8d} {pct:5.1f}%  0x{s:08x}  0x{e:08x}  {n}")
if unmapped:
    print(f"\n=== Unmapped PCs (top 12, n={len(unmapped)} unique) ===")
    for pc, count in unmapped.most_common(12):
        pct = 100.0 * count / max(1, n_samples)
        print(f"{count:8d} {pct:5.1f}%  0x{pc:08x}")

SDK_PFX = ("OS","DC","DVD","GX","VI","AI","SI","AR","EXI","PAD","CARD","DSP",
           "GD","DB","AX","MIX","SP","TRK","_save","_rest","__","memcpy","memset",
           "memmove","memcmp","strlen","strcpy","strncpy","strcmp")
def classify(name):
    if name.startswith("zz_"): return "synthetic"
    if any(name.startswith(p) for p in SDK_PFX): return "sdk"
    return "game"
print("\n=== Region totals ===")
region_hits = Counter()
for (s, e, n), count in fn_counts.items(): region_hits[classify(n)] += count
region_hits["unmapped"] = sum(unmapped.values())
total = sum(region_hits.values())
for r, c in region_hits.most_common():
    print(f"  {r:12s}  {c:8d}  {100.0*c/max(1,total):5.1f}%")

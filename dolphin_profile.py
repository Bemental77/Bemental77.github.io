#!/usr/bin/env python3
"""Sample-profile a game running in native Dolphin via the GDB stub.

Launches Dolphin headlessly, waits for the GDB stub to bind, then loops
SAMPLE_COUNT times: send interrupt → read PC → continue. Each cycle is
~1 ms of Dolphin pause; sleeping SAMPLE_GAP_S between cycles keeps Dolphin
running enough to make forward progress.

After sampling, builds a PC histogram, cross-references against the symbol
map (Dolphin's saved .map file at the canonical path), and prints the
top-N hot symbols.

Usage: python3 dolphin_profile.py <gameid> <iso_path> [duration_s]
   gameid:    GPOE8P (PSO) | GSNE8P (SAB)
   duration:  total wall-clock seconds to sample (default 30)
"""

import os, sys, socket, subprocess, time, signal
from collections import Counter

DOLPHIN = "/Applications/Dolphin.app/Contents/MacOS/Dolphin"
PORT = 9090
SAMPLE_GAP_S = 0.05   # 50ms between samples
DURATION_S = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0

if len(sys.argv) < 3:
    sys.stderr.write(f"Usage: {sys.argv[0]} <gameid> <iso_path> [duration_s]\n")
    sys.exit(2)

gameid = sys.argv[1]
iso = sys.argv[2]
mapfile = os.path.expanduser(f"~/Library/Application Support/Dolphin/Maps/{gameid}.map")
if gameid == "GPOE8P":
    pso_alt = os.path.expanduser("~/Library/Application Support/Dolphin/Maps/GPOE8P_PSO.map")
    if os.path.exists(pso_alt):
        mapfile = pso_alt

# ─── GDB-RSP helpers (subset of native_dump.py) ───────────────────────────────
def cksum(s): return sum(s.encode()) & 0xff
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
    send(sock, packet); return recv_packet(sock)

def parse_pc_from_t(stop):
    """T-packet has reg-name:value pairs. Reg 0x40 = PC in Dolphin's stub."""
    if not stop or not stop.startswith("T"): return None
    for kv in stop[3:].split(";"):
        if not kv: continue
        k, _, v = kv.partition(":")
        if k.lower() == "40":
            return int(v, 16)
    return None

# ─── Map-file loader ─────────────────────────────────────────────────────────
def load_map(path):
    """Returns sorted [(start, end, name)]. Skips synthetic zz_* but also keeps
    all entries for fall-through lookup."""
    if not os.path.exists(path):
        sys.stderr.write(f"[warn] no map at {path} — output will be raw PCs\n")
        return []
    rows = []
    for line in open(path):
        parts = line.split(maxsplit=5)
        if len(parts) < 5: continue
        try:
            start = int(parts[0], 16)
            size  = int(parts[1], 16)
            name  = parts[4]
            rows.append((start, start + size, name))
        except ValueError:
            continue
    rows.sort()
    return rows

def lookup(symtab, pc):
    if not symtab: return None
    lo, hi = 0, len(symtab) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        s, e, n = symtab[mid]
        if pc < s:    hi = mid - 1
        elif pc >= e: lo = mid + 1
        else:         return (s, e, n)
    return None

# ─── Main flow ───────────────────────────────────────────────────────────────
print(f"[profile] game={gameid}  iso={iso}", flush=True)
print(f"[profile] duration={DURATION_S}s  sample_gap={SAMPLE_GAP_S}s", flush=True)
print(f"[profile] mapfile={mapfile}", flush=True)
print(f"[profile] expected samples: ~{int(DURATION_S/SAMPLE_GAP_S)}", flush=True)

# Kill any prior Dolphin on our port
import shutil
if shutil.which("lsof"):
    try:
        out = subprocess.check_output(["lsof", "-ti", f":{PORT}"], text=True).strip()
        for pid in out.split("\n"):
            if pid: os.kill(int(pid), signal.SIGTERM)
    except subprocess.CalledProcessError:
        pass

# Launch Dolphin paused, GDB-ready, JIT64
dolphin_log = f"/tmp/dolphin_{gameid}.log"
dolphin = subprocess.Popen(
    [DOLPHIN, "-d",
     "-C", f"Dolphin.General.GDBPort={PORT}",
     "-C", "Dolphin.Core.CPUCore=1",
     "-e", iso],
    stdout=open(dolphin_log, "w"), stderr=subprocess.STDOUT,
)
print(f"[profile] launched Dolphin pid={dolphin.pid}, waiting for GDB stub...", flush=True)

# Wait up to 15s for stub
t0 = time.time()
sock = None
while time.time() - t0 < 15:
    try:
        sock = socket.create_connection(("127.0.0.1", PORT), timeout=2)
        break
    except (ConnectionRefusedError, socket.timeout):
        time.sleep(0.3)

if sock is None:
    print("[profile] ERROR: GDB stub never bound — tail of dolphin log:", flush=True)
    os.system(f"tail -20 {dolphin_log}")
    dolphin.terminate(); sys.exit(1)

print("[profile] GDB stub up, ack-ing + sampling...", flush=True)
sock.sendall(b"+")
time.sleep(0.2)
cmd(sock, "qSupported:multiprocess+;swbreak+;hwbreak+")

# Continue execution (game starts running)
send(sock, "c")

# Sample loop
samples = Counter()
n_samples = 0
n_errors = 0
sock.settimeout(2.0)
t_start = time.time()
while time.time() - t_start < DURATION_S:
    time.sleep(SAMPLE_GAP_S)
    # Send interrupt
    sock.sendall(b"\x03")
    try:
        stop = recv_packet(sock)
    except socket.timeout:
        n_errors += 1
        # Try to recover by sending continue
        try: send(sock, "c")
        except Exception: break
        continue
    pc = parse_pc_from_t(stop)
    if pc is not None:
        samples[pc] += 1
        n_samples += 1
    # Resume
    send(sock, "c")

elapsed = time.time() - t_start
print(f"\n[profile] sampling done: {n_samples} samples in {elapsed:.1f}s ({n_errors} errors)", flush=True)

# Detach + close + kill Dolphin
try: cmd(sock, "D")
except Exception: pass
sock.close()
dolphin.terminate()
try: dolphin.wait(timeout=3)
except Exception:
    dolphin.kill()

# ─── Histogram + symbol resolution ───────────────────────────────────────────
symtab = load_map(mapfile)
fn_counts = Counter()
fn_meta = {}
unmapped = Counter()
for pc, count in samples.items():
    sym = lookup(symtab, pc)
    if sym is None:
        unmapped[pc] += count
    else:
        s, e, n = sym
        fn_counts[(s, e, n)] += count
        fn_meta[(s, e, n)] = (pc, count)

print("\n=== Top 30 hot functions (by sample count) ===")
print(f"{'samples':>8} {'pct':>6}  start_pc      end_pc    name")
for (s, e, n), count in fn_counts.most_common(30):
    pct = 100.0 * count / max(1, n_samples)
    print(f"{count:8d} {pct:5.1f}%  0x{s:08x}  0x{e:08x}  {n}")

if unmapped:
    print(f"\n=== Unmapped PCs (top 10, n={len(unmapped)} unique) ===")
    for pc, count in unmapped.most_common(10):
        pct = 100.0 * count / max(1, n_samples)
        print(f"{count:8d} {pct:5.1f}%  0x{pc:08x}")

# Region classification (sym-prefix heuristic)
SDK_PFX = ("OS","DC","DVD","GX","VI","AI","SI","AR","EXI","PAD","CARD","DSP",
           "GD","DB","AX","MIX","SP","TRK","_save","_rest","__","memcpy","memset",
           "memmove","memcmp","strlen","strcpy","strncpy","strcmp","strchr",
           "strstr","strtok","strtod","strtol","atoi","atof","sprintf","snprintf",
           "vprintf","vsprintf","fprintf","printf","fclose","fopen","fread",
           "fwrite","fseek","ftell")
def classify(name):
    if name.startswith("zz_"): return "synthetic"
    if any(name.startswith(p) for p in SDK_PFX): return "sdk"
    return "game"

print("\n=== Region totals (samples) ===")
region_hits = Counter()
for (s, e, n), count in fn_counts.items():
    region_hits[classify(n)] += count
region_hits["unmapped"] = sum(unmapped.values())
total = sum(region_hits.values())
for r, c in region_hits.most_common():
    pct = 100.0 * c / max(1, total)
    print(f"  {r:12s}  {c:8d}  {pct:5.1f}%")

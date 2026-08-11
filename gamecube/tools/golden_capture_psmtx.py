#!/usr/bin/env python3
"""golden_capture_psmtx.py — harvest golden PSMTXROMultVecArray call records from
NATIVE Dolphin (the oracle) via its GDB stub: real input distribution + hardware-
accurate outputs, for the B1 template fixture. Break at the fn entry + its blr;
at entry capture inputs (ROMtx 48B @r3, src vecs count*12 @r4, count @r6, dstBase
@r5); at blr capture outputs (dst vecs @dstBase) + architected end-state. -> JSON.

Launch the oracle first (MP4 = 0x800bc8d0):
  ~/gc_refs/dolphin-upstream/build-oracle/Binaries/dolphin-emu-nogui \
    -d -C Dolphin.General.GDBPort=9091 -C Dolphin.Core.CPUThread=True \
    -C Dolphin.Core.CPUCore=1 -e "/Users/caseybement/Downloads/Mario Party 4 (USA).iso"
then run this. Env: PSMTX_ENTRY, PSMTX_BLR, GDB_PORT, GOLDEN_OUT, MAX_REC, MAX_CNT, DURATION.
"""
import socket, sys, time, os, json

HOST = "127.0.0.1"
PORT = int(os.environ.get("GDB_PORT", "9091"))
ENTRY = int(os.environ.get("PSMTX_ENTRY", "0x800bc8d0"), 16)
BLR = int(os.environ.get("PSMTX_BLR", "0x800bc9e4"), 16)      # the blr of PSMTXROMultVecArray
OUT = os.environ.get("GOLDEN_OUT", "/tmp/psmtx_goldens.json")
MAX_REC = int(os.environ.get("MAX_REC", "1000"))
MAX_CNT = int(os.environ.get("MAX_CNT", "64"))               # skip huge calls (bounded reads)
DURATION = float(os.environ.get("DURATION", "300"))


def cksum(p): return f"{sum(p) & 0xff:02x}"
def send(s, p): s.sendall(f"${p}#{cksum(p.encode())}".encode())


def recv(s):
    while True:
        c = s.recv(1)
        if not c: return ""
        if c in (b"+", b"-"): continue
        if c == b"$": break
    buf = b""
    while True:
        c = s.recv(1)
        if not c: return ""
        if c == b"#":
            s.recv(2); s.sendall(b"+"); return buf.decode(errors="replace")
        buf += c


def rdregs(s):
    send(s, "g"); g = recv(s)
    gprs = [int(g[i * 8:(i + 1) * 8], 16) for i in range(32)]
    fbase = 32 * 8
    fprs = [g[fbase + i * 16:fbase + (i + 1) * 16] for i in range(32)]   # 8-byte doubles, hex
    sbase = 32 * 8 + 32 * 16
    keys = ["PC", "MSR", "CR", "LR", "CTR", "XER", "FPSCR"]
    spec = {k: int(g[sbase + i * 8:sbase + i * 8 + 8], 16) for i, k in enumerate(keys)}
    return gprs, fprs, spec


def rdmem(s, addr, n):
    out = b""
    while n > 0:
        c = min(n, 256)
        send(s, f"m{addr:x},{c:x}"); r = recv(s)
        if not r or r.startswith("E"): break
        out += bytes.fromhex(r); addr += c; n -= c
    return out


def main():
    s = socket.socket(); s.settimeout(60)
    for _ in range(120):
        try:
            s.connect((HOST, PORT)); break
        except (ConnectionRefusedError, OSError):
            time.sleep(0.25)
    else:
        print("could not connect to oracle GDB stub", file=sys.stderr); sys.exit(1)
    s.settimeout(30); send(s, "?"); recv(s)
    send(s, f"Z0,{ENTRY:x},4"); print("Z0 entry:", recv(s), file=sys.stderr)
    send(s, f"Z0,{BLR:x},4");   print("Z0 blr:", recv(s), file=sys.stderr)

    recs = []; pending = None; skipped = 0
    s.settimeout(DURATION); deadline = time.time() + DURATION
    while len(recs) < MAX_REC and time.time() < deadline:
        send(s, "c")
        try:
            stop = recv(s)
        except socket.timeout:
            break
        if not stop or stop[0] != "T":
            break
        gprs, fprs, spec = rdregs(s); pc = spec["PC"]
        if pc == ENTRY:
            cnt = gprs[6]
            if cnt == 0 or cnt > MAX_CNT:
                skipped += 1; pending = None; continue
            pending = {"m": rdmem(s, gprs[3], 48).hex(),
                       "src": rdmem(s, gprs[4], cnt * 12).hex(),
                       "count": cnt, "dstBase": gprs[5], "r3": gprs[3], "r4": gprs[4]}
        elif pc == BLR and pending:
            recs.append({**pending,
                         "dst": rdmem(s, pending["dstBase"], pending["count"] * 12).hex(),
                         "end": {"r1": gprs[1], "r4": gprs[4], "r5": gprs[5], "CTR": spec["CTR"]},
                         "fprs_end": fprs[14:19]})     # f14-f18 (callee-saved, restored at blr)
            pending = None

    for pc in (ENTRY, BLR):
        send(s, f"z0,{pc:x},4"); recv(s)
    send(s, "D")
    try: recv(s)
    except Exception: pass
    s.close()
    json.dump(recs, open(OUT, "w"))
    print(f"captured {len(recs)} golden records (skipped {skipped} count>{MAX_CNT}/=0) -> {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()

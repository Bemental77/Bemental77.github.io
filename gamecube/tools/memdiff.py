#!/usr/bin/env python3
"""Diff two raw MEM1 dumps and bucket differing regions by symbol.

native = /tmp/native-mem.bin (captured at BS2 hand-off PC 0x80003140 over GDB)
wasm   = /tmp/wasm-mem.bin   (captured end-of-run from the JIT build's probe)

Both cover guest [BASE, BASE+len). Coalesces differing byte-runs (gaps < GAP
merged), labels each run via the CodeWarrior symbol map, and classifies each as:
  ZERO  - wasm bytes all 0 there (apploader load gap / region never populated)
  DIFF  - wasm bytes nonzero but != native (loaded-but-wrong / runtime mutation)
"""
import argparse, re, sys

MAP_LINE = re.compile(r"^([0-9a-fA-F]{8})\s+([0-9a-fA-F]+)\s+[0-9a-fA-F]{8}\s+\d+\s+(.+?)\s*$")


def load_map(path):
    syms = []  # (start, end, name)
    try:
        with open(path) as f:
            for line in f:
                m = MAP_LINE.match(line)
                if not m:
                    continue
                start = int(m.group(1), 16)
                size = int(m.group(2), 16)
                if size == 0:
                    continue
                syms.append((start, start + size, m.group(3)))
    except FileNotFoundError:
        print(f"[memdiff] WARN: map {path} not found; runs unlabeled", file=sys.stderr)
    syms.sort()
    return syms


def sym_for(syms, addr):
    # binary-search the last sym whose start <= addr
    lo, hi, best = 0, len(syms) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if syms[mid][0] <= addr:
            best = syms[mid]
            lo = mid + 1
        else:
            hi = mid - 1
    if best and best[0] <= addr < best[1]:
        return f"{best[2]}+0x{addr - best[0]:x}"
    if best:
        return f"(after {best[2]} @0x{best[0]:08x})"
    return "(no sym)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--native", default="/tmp/native-mem.bin")
    ap.add_argument("--wasm", default="/tmp/wasm-mem.bin")
    ap.add_argument("--base", type=lambda x: int(x, 0), default=0x80003000)
    ap.add_argument("--map", default="dolphin_captures/sab.map")
    ap.add_argument("--gap", type=int, default=64, help="merge diff-runs separated by < gap bytes")
    ap.add_argument("--top", type=int, default=40)
    args = ap.parse_args()

    nat = open(args.native, "rb").read()
    wsm = open(args.wasm, "rb").read()
    if len(nat) != len(wsm):
        print(f"[memdiff] length mismatch: native={len(nat)} wasm={len(wsm)} "
              f"(diffing min)", file=sys.stderr)
    n = min(len(nat), len(wsm))
    syms = load_map(args.map)

    # collect differing offsets, coalesce into runs
    runs = []  # [start_off, end_off]
    i = 0
    cur = None
    diff_bytes = 0
    while i < n:
        if nat[i] != wsm[i]:
            diff_bytes += 1
            if cur is None:
                cur = [i, i + 1]
            elif i - cur[1] < args.gap:
                cur[1] = i + 1
            else:
                runs.append(cur)
                cur = [i, i + 1]
        i += 1
    if cur:
        runs.append(cur)

    print(f"=== MEM1 diff: native vs wasm ===")
    print(f"range      0x{args.base:08x}..0x{args.base + n:08x}  ({n} bytes)")
    print(f"diff bytes {diff_bytes}  ({100.0 * diff_bytes / n:.2f}%)")
    print(f"diff runs  {len(runs)} (gap-merge < {args.gap})")
    print()

    # annotate runs
    ann = []
    for s, e in runs:
        addr = args.base + s
        length = e - s
        wseg = wsm[s:e]
        nseg = nat[s:e]
        wzero = all(b == 0 for b in wseg)
        nzero = all(b == 0 for b in nseg)
        if wzero and not nzero:
            kind = "ZERO"   # native has data, wasm has nothing -> load gap
        elif nzero and not wzero:
            kind = "WSET"   # wasm wrote where native is zero
        else:
            kind = "DIFF"
        ann.append((length, addr, kind, sym_for(syms, addr)))

    # totals by kind
    by_kind = {}
    for length, addr, kind, name in ann:
        by_kind.setdefault(kind, [0, 0])
        by_kind[kind][0] += 1
        by_kind[kind][1] += length
    print("by kind (runs / bytes):")
    for k in ("ZERO", "DIFF", "WSET"):
        if k in by_kind:
            print(f"  {k:5s}  {by_kind[k][0]:5d} runs  {by_kind[k][1]:8d} bytes")
    print()

    ann.sort(reverse=True)  # largest runs first
    print(f"top {args.top} runs by size:")
    print(f"  {'addr':>10}  {'len':>7}  kind  symbol")
    for length, addr, kind, name in ann[:args.top]:
        print(f"  0x{addr:08x}  {length:7d}  {kind:4s}  {name}")


if __name__ == "__main__":
    main()

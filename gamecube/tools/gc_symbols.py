#!/usr/bin/env python3
"""gc_symbols.py — shared per-game symbol resolver (address -> name) for the
GameCube tooling. Keyed by ROM_IDX (matches the live gamecube.html ROMS[] and
the probe): 0=MP4/GMPE01, 1=SAB/GSNE8P, 2=PSO/GPOE8P, 3=240pSuite (no map).

Parses BOTH map formats in tools/: the decomp->Dolphin map
(symbols_to_dolphin_map.py, 6-hex size) and the CodeWarrior section-layout
(gcsdk_scan.py, 8-hex fields). Per the cross-ref method, SAB/PSO inherit MP4's
decomp SDK names where the sig-scan misses (e.g. SelectThread @0x800ebd68).

Usage (module): from gc_symbols import Symbols; s = Symbols(rom_idx); s.name(pc)
Usage (CLI):    python3 gc_symbols.py <rom_idx> <pc-hex> [<pc-hex> ...]
"""
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MAPS = {
    0: "tools/gmpe01_full.map",  # MP4  GMPE01 (full decomp)
    1: "tools/gsne8p_xref.map",   # SAB  GSNE8P (+165 cross-ref SDK inherited from MP4)
    2: "tools/gpoe8p_xref.map",   # PSO  GPOE8P (+cross-ref SDK inherited from MP4)
}
GAME = {0: "MP4/GMPE01", 1: "SAB/GSNE8P", 2: "PSO/GPOE8P", 3: "240pSuite"}

# addr(8hex) size(4-8hex) addr(8hex) <0 or 00000000> name ...  (both formats)
_ROW = re.compile(r'^\s*([0-9a-fA-F]{8})\s+([0-9a-fA-F]{4,8})\s+[0-9a-fA-F]{8}\s+[0-9a-fA-F]+\s+(\S+)')


class Symbols:
    def __init__(self, rom_idx):
        self.rom_idx = int(rom_idx)
        self.game = GAME.get(self.rom_idx, "?")
        self.syms = []  # sorted list of (addr, size, name)
        path = MAPS.get(self.rom_idx)
        if path:
            full = os.path.join(REPO, path)
            if os.path.exists(full):
                with open(full) as f:
                    for line in f:
                        m = _ROW.match(line)
                        if not m:
                            continue
                        sz = int(m.group(2), 16)
                        if sz == 0:
                            continue
                        self.syms.append((int(m.group(1), 16), sz, m.group(3)))
                self.syms.sort()

    def find(self, pc):
        """Return (name, offset, size) covering pc, or None."""
        lo, hi = 0, len(self.syms)
        while lo < hi:
            mid = (lo + hi) // 2
            a, sz, n = self.syms[mid]
            if pc < a:
                hi = mid
            elif pc >= a + sz:
                lo = mid + 1
            else:
                return (n, pc - a, sz)
        return None

    def name(self, pc):
        r = self.find(pc)
        return ("%s+0x%x" % (r[0], r[1])) if r else "0x%08x?" % pc


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: gc_symbols.py <rom_idx> <pc-hex> [<pc-hex> ...]")
        sys.exit(1)
    s = Symbols(sys.argv[1])
    print("# %s  (%d symbols loaded)" % (s.game, len(s.syms)))
    for a in sys.argv[2:]:
        pc = int(a, 16)
        print("  0x%08x -> %s" % (pc, s.name(pc)))

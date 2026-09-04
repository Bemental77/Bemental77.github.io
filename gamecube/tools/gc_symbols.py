#!/usr/bin/env python3
"""gc_symbols.py — shared per-game symbol resolver (address -> name) for the
GameCube tooling. Keyed by ROM_IDX (matches the live gamecube.html ROMS[] and
the probe): 0=MP4/GMPE01, 1=SAB/GSNE8P, 2=PSO/GPOE8P, 3=240pSuite (no map).

Parses BOTH map formats in tools/: the decomp->Dolphin map
(symbols_to_dolphin_map.py, 6-hex size) and the CodeWarrior section-layout
(gcsdk_scan.py, 8-hex fields). Per the cross-ref method, SAB/PSO inherit MP4's
decomp SDK names where the sig-scan misses (e.g. SelectThread @0x800ebd68).

TWO SOURCES, TWO DIFFERENT QUESTIONS
------------------------------------
`MAPS[]` answers "what is this function CALLED". For SAB that is 441 functions
covering 6.8% of the DOL's `.text`; for PSO it is fewer still. There is no
offline source for the rest (no SAB/PSO decomp exists — verified in
`gc_recomp_host_layer_is_73pct_platform`), so the named fraction has a hard
ceiling that no resolver change can lift.

`FNMAPS[]` answers "which FUNCTION is this address in", which is what a PC
census actually needs. It is produced by `gamecube/tools/gc_funcmap.py` from the
DOL itself and covers ~99.6% of `.text`; unnamed entries are `fn_<addr>`, which
is deliberately not a claimed identity. Its recovery is scored against MP4's
decomp ground truth by `gc_funcmap.py --rom 0 --validate --no-map-seeds`.

The fn-map is loaded when present and the name-map is layered UNDER it, so a
named symbol always wins over the recovered boundary that contains it. Set
`GC_SYMS_NO_FNMAP=1` to get the pre-2026-09-04 name-map-only behaviour (needed
to reproduce a BEFORE number against an old census artifact).

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
# Recovered function boundaries (gc_funcmap.py). Named where a MAPS[] symbol
# starts there, `fn_<addr>` otherwise.
FNMAPS = {
    0: "tools/gmpe01_fn.map",
    1: "tools/gsne8p_fn.map",
    2: "tools/gpoe8p_fn.map",
    3: "tools/suite240p_fn.map",
}
# Content-matched SDK names (gc_xmatch.py). OPT-IN via GC_SYMS_XMATCH=1, and
# reported by kind() as 'xmatch' rather than 'named', because these are a
# MEASURED 96.0% precise (216 agree / 9 disagree over the 225 functions the xref
# map already names) — good enough to read a census by, not good enough to be
# quoted as a symbol without saying where it came from.
XMATCH = {1: "tools/gsne8p_xmatch.map"}
GAME = {0: "MP4/GMPE01", 1: "SAB/GSNE8P", 2: "PSO/GPOE8P", 3: "240pSuite"}

# addr(8hex) size(4-8hex) addr(8hex) <0 or 00000000> name ...  (both formats)
_ROW = re.compile(r'^\s*([0-9a-fA-F]{8})\s+([0-9a-fA-F]{4,8})\s+[0-9a-fA-F]{8}\s+[0-9a-fA-F]+\s+(\S+)')


def _read_map(full):
    out = []
    if not os.path.exists(full):
        return out
    with open(full) as f:
        for line in f:
            m = _ROW.match(line)
            if not m:
                continue
            sz = int(m.group(2), 16)
            if sz == 0:
                continue
            out.append((int(m.group(1), 16), sz, m.group(3)))
    out.sort()
    return out


class Symbols:
    def __init__(self, rom_idx, use_fnmap=None):
        self.rom_idx = int(rom_idx)
        self.game = GAME.get(self.rom_idx, "?")
        if use_fnmap is None:
            use_fnmap = os.environ.get("GC_SYMS_NO_FNMAP") != "1"
        name_path = MAPS.get(self.rom_idx)
        self.named = _read_map(os.path.join(REPO, name_path)) if name_path else []
        xm_path = (XMATCH.get(self.rom_idx)
                   if os.environ.get("GC_SYMS_XMATCH") == "1" else None)
        known = set(a for a, _, _ in self.named)
        self.xmatched = [r for r in _read_map(os.path.join(REPO, xm_path))
                         if r[0] not in known] if xm_path else []
        fn_path = FNMAPS.get(self.rom_idx) if use_fnmap else None
        self.funcs = _read_map(os.path.join(REPO, fn_path)) if fn_path else []
        # `syms` stays the name-map list so every existing consumer keeps its
        # meaning; `funcs` is the boundary layer queried underneath it.
        self.syms = self.named

    @staticmethod
    def _lookup(table, pc):
        lo, hi = 0, len(table)
        while lo < hi:
            mid = (lo + hi) // 2
            a, sz, n = table[mid]
            if pc < a:
                hi = mid
            elif pc >= a + sz:
                lo = mid + 1
            else:
                return (n, pc - a, sz)
        return None

    def find(self, pc):
        """Return (name, offset, size) covering pc, or None.

        A real name wins; a recovered boundary answers otherwise. `kind(pc)`
        reports which one answered, so a census can keep the two apart instead
        of printing a recovered boundary as though it were a symbol.
        """
        r = self._lookup(self.named, pc)
        if r:
            return r
        r = self._lookup(self.xmatched, pc)
        if r:
            return r
        return self._lookup(self.funcs, pc)

    def kind(self, pc):
        """'named' | 'xmatch' | 'recovered' | 'none' — provenance of find(pc)."""
        if self._lookup(self.named, pc):
            return "named"
        if self._lookup(self.xmatched, pc):
            return "xmatch"
        return "recovered" if self._lookup(self.funcs, pc) else "none"

    def name(self, pc):
        r = self.find(pc)
        return ("%s+0x%x" % (r[0], r[1])) if r else "0x%08x?" % pc


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: gc_symbols.py <rom_idx> <pc-hex> [<pc-hex> ...]")
        sys.exit(1)
    s = Symbols(sys.argv[1])
    print("# %s  (%d named symbols, %d recovered functions)"
          % (s.game, len(s.named), len(s.funcs)))
    for a in sys.argv[2:]:
        pc = int(a, 16)
        print("  0x%08x -> %-40s [%s]" % (pc, s.name(pc), s.kind(pc)))

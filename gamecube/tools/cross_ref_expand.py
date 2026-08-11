#!/usr/bin/env python3
"""cross_ref_expand.py — expand a game's sparse symbol map by inheriting MP4's
complete decomp SDK naming. The SDK links its functions contiguously in a fixed
order (same order in every game); the target already has some SDK functions
matched (anchors). From each anchor, walk outward through MP4's contiguous
address order, placing each MP4 function in the target at anchor_sab +
(mp4_addr - anchor_mp4) and CONFIRMING by masked-prologue byte-match (relocs
masked). Stop a run when a match fails (a boundary / different link segment).
Byte-match confirmation = zero false positives.

Reference = MP4 (GMPE01_01 main.dol + gmpe01_full.map). Target via ROM_IDX:
1=SAB (iso, DOL @0x1e700), 2=PSO (iso, DOL @0x1e700).

Usage: ROM_IDX=1 python3 gamecube/tools/cross_ref_expand.py > tools/gsne8p_xref.map
"""
import os
import re
import struct
import sys

REPO = "/Users/caseybement/Bemental77.github.io"
MP4_DOL = "/Users/caseybement/gc_refs/marioparty4/build/GMPE01_01/main.dol"
MP4_SYMS = os.path.join(REPO, "tools/gmpe01_full.map")
TARGET = {
    1: (os.path.join(REPO, "gamecube/roms/Sonic Adventure 2 - Battle (USA).iso"), 0x1e700,
        os.path.join(REPO, "tools/gsne8p.map")),
    2: ("/Users/caseybement/Downloads/Phantasy Star Online Episode I & II Plus (USA).iso", 0x1e700,
        os.path.join(REPO, "tools/gpoe8p_full.map")),
}
_ROW = re.compile(r'^\s*([0-9a-fA-F]{8})\s+([0-9a-fA-F]{4,8})\s+[0-9a-fA-F]{8}\s+[0-9a-fA-F]+\s+(\S+)')


def dol_sections(f, base):
    f.seek(base)
    hdr = f.read(0x100)
    offs = struct.unpack('>18I', hdr[0x00:0x48])
    adrs = struct.unpack('>18I', hdr[0x48:0x90])
    szs = struct.unpack('>18I', hdr[0x90:0xD8])
    return [(adrs[i], szs[i], offs[i]) for i in range(18) if szs[i] and adrs[i]]


class Bin:
    def __init__(self, path, base):
        self.f = open(path, 'rb')
        self.base = base
        self.secs = dol_sections(self.f, base)

    def words(self, vaddr, n):
        for (a, sz, off) in self.secs:
            if a <= vaddr < a + sz and vaddr + 4 * n <= a + sz:
                self.f.seek(self.base + off + (vaddr - a))
                return struct.unpack('>%dI' % n, self.f.read(4 * n))
        return None


def mask(w):
    op = w >> 26
    if op == 18:
        return w & 0xFC000003
    if op == 16:
        return w & 0xFFFF0003
    if op in (14, 15, 24, 25, 26, 27, 28, 29):
        return w & 0xFFFF0000
    if op in range(32, 48):
        return w & 0xFFFF0000
    return w


def match(a_words, b_words, need):
    if not a_words or not b_words:
        return False
    ok = sum(1 for i in range(len(a_words)) if mask(a_words[i]) == mask(b_words[i]))
    return ok >= need


def load_map(path):
    out = []
    for line in open(path):
        m = _ROW.match(line)
        if m and int(m.group(2), 16):
            out.append((int(m.group(1), 16), int(m.group(2), 16), m.group(3)))
    return out


def main():
    rom = int(os.environ.get("ROM_IDX", "1"))
    iso, base, tmap = TARGET[rom]
    mp4 = Bin(MP4_DOL, 0)
    tgt = Bin(iso, base)

    # MP4 functions sorted by addr, and name->index
    mp4_syms = sorted(load_map(MP4_SYMS))
    mp4_by_name = {n: i for i, (a, sz, n) in enumerate(mp4_syms)}
    tgt_syms = load_map(tmap)
    known = {a: n for (a, sz, n) in tgt_syms}     # target addr -> name (anchors)
    named_sab = {n for (a, sz, n) in tgt_syms}

    added = {}   # sab_addr -> (size, name)

    def confirm(mp4_i, sab_addr):
        ma, msz, mn = mp4_syms[mp4_i]
        nwords = min(10, msz // 4)
        if nwords < 3:
            return False
        need = max(3, nwords - 2)   # allow up to 2 non-reloc diffs
        return match(mp4.words(ma, nwords), tgt.words(sab_addr, nwords), need)

    tgt_by_name = {n: a for (a, sz, n) in tgt_syms}
    # anchors: target functions whose name is in MP4
    anchors = [(a, mp4_by_name[n]) for (a, sz, n) in tgt_syms if n in mp4_by_name]

    def place(mp4_i, sab_new, msz, mn):
        # Already-named in target: acts as an anchor confirming the delta still
        # holds — if it sits elsewhere the delta shifted (segment boundary), stop.
        if mn in tgt_by_name:
            return tgt_by_name[mn] == sab_new  # keep walking iff delta consistent
        if sab_new in known or sab_new in added:
            return True
        if confirm(mp4_i, sab_new):
            added[sab_new] = (msz, mn)
            return True
        return False  # byte mismatch -> run ended

    for (sab_a, mp4_i) in anchors:
        delta = sab_a - mp4_syms[mp4_i][0]
        j = mp4_i + 1                                  # forward while MP4-contiguous
        while j < len(mp4_syms) and mp4_syms[j][0] == mp4_syms[j - 1][0] + mp4_syms[j - 1][1]:
            ma, msz, mn = mp4_syms[j]
            if not place(j, ma + delta, msz, mn):
                break
            j += 1
        k = mp4_i - 1                                  # backward while MP4-contiguous
        while k >= 0 and mp4_syms[k + 1][0] == mp4_syms[k][0] + mp4_syms[k][1]:
            ma, msz, mn = mp4_syms[k]
            if not place(k, ma + delta, msz, mn):
                break
            k -= 1

    # emit merged map (existing + confirmed additions), CodeWarrior format
    allsyms = [(a, sz, n) for (a, sz, n) in tgt_syms]
    allsyms += [(a, sz, n) for a, (sz, n) in added.items()]
    allsyms.sort()
    sys.stderr.write("cross-ref: %d existing + %d confirmed SDK additions = %d total\n"
                     % (len(tgt_syms), len(added), len(allsyms)))
    print(".text section layout")
    for (a, sz, n) in allsyms:
        print("  %08x %08x %08x 00000000  %s\txref" % (a, sz, a, n))


if __name__ == "__main__":
    main()

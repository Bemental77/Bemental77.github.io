#!/usr/bin/env python3
"""Disassemble hot guest PCs. Per-game via ROM_IDX (0=MP4 1=SAB 2=PSO)."""
import sys, struct, re, os

# per-game (ROM_IDX env): binary + its DOL offset + symbol map. MP4 = decomp main.dol (offset 0).
_ROM = int(os.environ.get("ROM_IDX", "1"))
_CFG = {
    0: ("/Users/caseybement/gc_refs/marioparty4/build/GMPE01_01/main.dol", 0x0,
        "/Users/caseybement/Bemental77.github.io/tools/gmpe01_full.map"),
    1: ("/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso", None,
        "/Users/caseybement/Bemental77.github.io/tools/gsne8p.map"),
    2: ("/Users/caseybement/Downloads/Phantasy Star Online Episode I & II Plus (USA).iso", None,
        "/Users/caseybement/Bemental77.github.io/tools/gpoe8p_full.map"),
}
ISO, DOL_OFF, MAP = _CFG.get(_ROM, _CFG[1])


# [DOL-OFFSET BUG FIX 2026-08-29] PSO was hardcoded to 0x1e700 — SAB's offset,
# copy-pasted. VERIFIED EMPIRICALLY: PSO's own disc header at 0x420 says 0x1e000,
# and reading its DOL at 0x1e700 yields text0_addr=0x0 size=0x0 entry=0x0, i.e.
# all zeros, so every PSO disassembly through this tool was of nothing.
#   PSO @0x1e000: text0_addr=0x8000c000 size=0x2520 entry=0x8000c040   <- correct
#   PSO @0x1e700: text0_addr=0x00000000 size=0x0    entry=0x00000000   <- the bug
#   SAB @0x1e700: text0_addr=0x80003100 size=0x2400 entry=0x80003140   <- was right
# Every GameCube disc stores the DOL offset in its header at 0x420 (big-endian),
# so read it rather than hardcoding per game. A raw .dol (MP4's decomp build) has
# no disc header and keeps offset 0.
def _dol_offset(path, declared):
    if declared is not None:
        return declared
    if not path.lower().endswith(".iso"):
        return 0x0
    with open(path, "rb") as f:
        f.seek(0x420)
        off = struct.unpack(">I", f.read(4))[0]
        # Sanity-check the header we are about to trust: text section 0 must load
        # into MEM1 with a non-absurd size. A bad offset reads as zeros and would
        # otherwise disassemble an empty buffer without complaining.
        f.seek(off)
        hdr = f.read(0x100)
        addr = struct.unpack(">I", hdr[0x48:0x4c])[0]
        size = struct.unpack(">I", hdr[0x90:0x94])[0]
        if not (0x80000000 <= addr < 0x81800000 and 0 < size < 0x400000):
            raise SystemExit(
                f"{path}: disc header 0x420 gives DOL offset 0x{off:x}, but the DOL "
                f"there is implausible (text0 addr=0x{addr:08x} size=0x{size:x}). "
                f"Refusing to disassemble an empty buffer."
            )
        return off


DOL_OFF = _dol_offset(ISO, DOL_OFF)

HOT_PCS = [
    0x800e4e3c, 0x800e4e6c,
    0x800e78b8, 0x800e78d4, 0x800e78e8, 0x800e78f0,
    0x800e7e60, 0x800e7e74, 0x800e7e80,
    0x800e7fe4,
    0x800e8024, 0x800e8040, 0x800e806c,
    0x800f5798, 0x800f75e8, 0x800f8430, 0x800f9548, 0x800f9660,
    0x800e55d4, 0x800e55f0, 0x800e560c, 0x800e5628,
    0x800e56bc, 0x800e56d0, 0x800e56e4, 0x800e56fc, 0x800e5710,
    0x800e5778, 0x800e579c, 0x800e57bc,
]

SYMS = []
# size may be 4-8 hex (decomp map) or 8 (CodeWarrior); 4th field 0 or 00000000
sym_re = re.compile(r'^\s*([0-9a-f]{8})\s+([0-9a-f]{4,8})\s+[0-9a-f]{8}\s+[0-9a-f]+\s+(\S+)\s*(\S*)')
with open(MAP) as f:
    for line in f:
        m = sym_re.match(line)
        if m:
            a = int(m.group(1), 16)
            sz = int(m.group(2), 16)
            if sz == 0: continue
            SYMS.append((a, sz, m.group(3), m.group(4)))
SYMS.sort()

def find_sym(pc):
    prev = None
    for (a, sz, name, lib) in SYMS:
        if a <= pc < a + sz:
            return ('in', name, pc - a, sz, lib)
        if a > pc:
            return ('gap', prev[2] if prev else "?", name)
        prev = (a, sz, name, lib)
    return ('gap', prev[2] if prev else "?", "END")

with open(ISO, "rb") as f:
    f.seek(DOL_OFF)
    hdr = f.read(0x100)
sec_offsets = struct.unpack(">18I", hdr[0:0x48])
sec_loads = struct.unpack(">18I", hdr[0x48:0x90])
sec_sizes = struct.unpack(">18I", hdr[0x90:0xd8])

def vaddr_to_iso(vaddr):
    for i in range(18):
        if sec_loads[i] == 0: continue
        if sec_loads[i] <= vaddr < sec_loads[i] + sec_sizes[i]:
            return DOL_OFF + sec_offsets[i] + (vaddr - sec_loads[i])
    return None

def read_word(vaddr):
    off = vaddr_to_iso(vaddr)
    if off is None: return None
    with open(ISO, "rb") as f:
        f.seek(off)
        return struct.unpack(">I", f.read(4))[0], off

def disasm(addr, word):
    op = (word >> 26) & 0x3F
    rs = (word >> 21) & 0x1F
    ra = (word >> 16) & 0x1F
    rb = (word >> 11) & 0x1F
    simm = word & 0xFFFF
    if simm & 0x8000: simm -= 0x10000
    uimm = word & 0xFFFF

    if word == 0x4e800020: return "blr"
    if word == 0x4e800420: return "bctr"
    if word == 0x4c000064: return "rfi"
    if word == 0x4c00012c: return "isync"
    if word == 0x60000000: return "nop"

    if op == 31:
        xo = (word >> 1) & 0x3FF
        rc = "." if (word & 1) else ""
        if xo == 339:
            spr = ((word >> 16) & 0x1F) | (((word >> 11) & 0x1F) << 5)
            sprname = {1:"XER",8:"LR",9:"CTR",18:"DSISR",19:"DAR",22:"DEC",
                       26:"SRR0",27:"SRR1",272:"SPRG0",273:"SPRG1",
                       274:"SPRG2",275:"SPRG3",284:"TBL",285:"TBU",
                       268:"TBL_r",269:"TBU_r",1008:"HID0",1009:"HID1",
                       528:"IBAT0U",529:"IBAT0L",1011:"HID2"}.get(spr, str(spr))
            return f"mfspr r{rs}, {sprname}"
        if xo == 467:
            spr = ((word >> 16) & 0x1F) | (((word >> 11) & 0x1F) << 5)
            sprname = {8:"LR",9:"CTR",26:"SRR0",27:"SRR1",1008:"HID0",1011:"HID2"}.get(spr, str(spr))
            return f"mtspr {sprname}, r{rs}"
        if xo == 19: return f"mfcr  r{rs}"
        if xo == 144: return f"mtcrf 0x{(word>>12)&0xFF:02x},r{rs}"
        if xo == 83: return f"mfmsr r{rs}"
        if xo == 146: return f"mtmsr r{rs}"
        if xo == 200: return f"subfc{rc} r{rs},r{ra},r{rb}"
        if xo == 24: return f"slw{rc}   r{ra},r{rs},r{rb}"
        if xo == 28: return f"and{rc}   r{ra},r{rs},r{rb}"
        if xo == 60: return f"andc{rc}  r{ra},r{rs},r{rb}"
        if xo == 444: return f"or{rc}    r{ra},r{rs},r{rb}"
        if xo == 124: return f"nor{rc}   r{ra},r{rs},r{rb}"
        if xo == 266: return f"add{rc}   r{rs},r{ra},r{rb}"
        if xo == 40: return f"subf{rc}  r{rs},r{ra},r{rb}"
        if xo == 23: return f"lwzx  r{rs},r{ra},r{rb}"
        if xo == 151: return f"stwx  r{rs},r{ra},r{rb}"
        if xo == 0:  return f"cmp   cr{rs>>2},r{ra},r{rb}"
        if xo == 32: return f"cmpl  cr{rs>>2},r{ra},r{rb}"
        if xo == 470: return f"dcbi  r{ra},r{rb}"
        if xo == 1014: return f"dcbz  r{ra},r{rb}"
        if xo == 982: return f"icbi  r{ra},r{rb}"
        if xo == 86: return f"dcbf  r{ra},r{rb}"
        if xo == 54: return f"dcbst r{ra},r{rb}"
        if xo == 598: return f"sync"
        if xo == 854: return f"eieio"
        if xo == 246: return f"dcbtst r{ra},r{rb}"
        return f"op31  xo={xo} rs={rs} ra={ra} rb={rb}"

    if op == 14: return f"addi  r{rs},r{ra},{simm}"
    if op == 15: return f"addis r{rs},r{ra},{simm:#x}"
    if op == 24: return f"ori   r{ra},r{rs},{uimm:#x}"
    if op == 25: return f"oris  r{ra},r{rs},{uimm:#x}"
    if op == 28: return f"andi. r{ra},r{rs},{uimm:#x}"
    if op == 29: return f"andis. r{ra},r{rs},{uimm:#x}"
    if op == 32: return f"lwz   r{rs},{simm}(r{ra})"
    if op == 33: return f"lwzu  r{rs},{simm}(r{ra})"
    if op == 36: return f"stw   r{rs},{simm}(r{ra})"
    if op == 37: return f"stwu  r{rs},{simm}(r{ra})"
    if op == 40: return f"lhz   r{rs},{simm}(r{ra})"
    if op == 41: return f"lhzu  r{rs},{simm}(r{ra})"
    if op == 44: return f"sth   r{rs},{simm}(r{ra})"
    if op == 34: return f"lbz   r{rs},{simm}(r{ra})"
    if op == 38: return f"stb   r{rs},{simm}(r{ra})"
    if op == 11:
        bf = rs >> 2
        return f"cmpwi cr{bf},r{ra},{simm}"
    if op == 10:
        bf = rs >> 2
        return f"cmplwi cr{bf},r{ra},{uimm:#x}"
    if op == 18:
        li = word & 0x03FFFFFC
        if li & 0x02000000: li -= 0x04000000
        target = (addr + li) & 0xFFFFFFFF if (word & 2) == 0 else (li & 0xFFFFFFFF)
        lk = "l" if (word & 1) else ""
        aa = "a" if (word & 2) else ""
        return f"b{lk}{aa}    {target:#010x}"
    if op == 16:
        bo = (word >> 21) & 0x1F
        bi = (word >> 16) & 0x1F
        bd = word & 0xFFFC
        if bd & 0x8000: bd -= 0x10000
        target = (addr + bd) & 0xFFFFFFFF if (word & 2) == 0 else (bd & 0xFFFFFFFF)
        lk = "l" if (word & 1) else ""
        crbit = bi & 3
        crfield = bi >> 2
        cond_names = {0:"lt", 1:"gt", 2:"eq", 3:"so"}
        cn = cond_names.get(crbit, "?")
        if bo & 0x10:
            m = "bdnz" if (bo & 2) == 0 else "bdz"
        elif (bo & 0x4) == 0:
            m = f"bc({bo},{bi})"
        else:
            taken_true = (bo & 0x8) != 0
            m = f"b{cn}" if taken_true else f"bn{cn}"
            if crfield != 0: m += f" cr{crfield},"
        return f"{m}{lk}  {target:#010x}  ; BO={bo} BI={bi}"
    if op == 19:
        xo = (word >> 1) & 0x3FF
        if xo == 16:
            bo = (word >> 21) & 0x1F
            bi = (word >> 16) & 0x1F
            lk = "l" if (word & 1) else ""
            if bo == 20 and bi == 0: return f"blr{lk}"
            return f"bc{lk}lr bo={bo},bi={bi}"
        if xo == 528:
            bo = (word >> 21) & 0x1F
            bi = (word >> 16) & 0x1F
            lk = "l" if (word & 1) else ""
            if bo == 20: return f"bctr{lk}"
            return f"bc{lk}ctr bo={bo},bi={bi}"
        if xo == 150: return "isync"
        if xo == 50: return "rfi"
        return f"op19  xo={xo}"
    if op == 21:
        sh = (word >> 11) & 0x1F
        mb = (word >> 6) & 0x1F
        me = (word >> 1) & 0x1F
        rc = "." if (word & 1) else ""
        return f"rlwinm{rc} r{ra},r{rs},{sh},{mb},{me}"
    if op == 20:
        sh = (word >> 11) & 0x1F
        mb = (word >> 6) & 0x1F
        me = (word >> 1) & 0x1F
        rc = "." if (word & 1) else ""
        return f"rlwimi{rc} r{ra},r{rs},{sh},{mb},{me}"
    return f"???   op={op} word={word:08x}"

def disasm_around(pc, before=4, after=4):
    print(f"\n--- {pc:#010x} ---")
    sym = find_sym(pc)
    if sym[0] == 'in':
        _, name, off, sz, lib = sym
        print(f"  Symbol: {name}+0x{off:x} (size 0x{sz:x}, {lib})")
    else:
        _, prev, nxt = sym
        print(f"  In gap between {prev} and {nxt}")
    for i in range(-before, after+1):
        a = pc + i*4
        r = read_word(a)
        if r is None:
            print(f"  {a:08x}: <unmapped>")
            continue
        word, foff = r
        mark = " <==" if i == 0 else "    "
        print(f"  {a:08x}: {word:08x}  {disasm(a, word):42s}{mark} [ISO 0x{foff:x}]")

clusters = []
sorted_pcs = sorted(set(HOT_PCS))
cur = [sorted_pcs[0]]
for p in sorted_pcs[1:]:
    if p - cur[-1] <= 0x80:
        cur.append(p)
    else:
        clusters.append(cur)
        cur = [p]
clusters.append(cur)

print("=" * 70)
print("Hot PCs grouped by cluster")
print("=" * 70)
for i, c in enumerate(clusters):
    rng = f"{c[0]:#x}..{c[-1]:#x}"
    print(f"  cluster {i}: {len(c)} PCs in {rng}")

for cluster in clusters:
    print()
    print("#" * 70)
    print(f"# CLUSTER {cluster[0]:#x}..{cluster[-1]:#x}")
    print("#" * 70)
    for pc in cluster:
        disasm_around(pc, 2, 4)

#!/usr/bin/env python3
"""Extract and disassemble fn 0x800f7580 + panic format string region from SAB ISO."""
import sys, struct

ISO = "/Users/caseybement/Bemental77.github.io/gamecube/roms/Sonic Adventure 2 - Battle (USA).iso"
DOL_OFF = 0x1e700  # known from prior session
TEXT_LOAD = 0x80005500
TEXT_FILE = 0x2500

def vaddr_to_iso(vaddr):
    """Translate a virtual addr in main .text to ISO file offset."""
    return DOL_OFF + TEXT_FILE + (vaddr - TEXT_LOAD)

def read_at(vaddr, nbytes):
    with open(ISO, "rb") as f:
        f.seek(vaddr_to_iso(vaddr))
        return f.read(nbytes)

# Minimal PowerPC disassembler — focused on what we expect to see
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
    if word == 0x4e800021: return "blrl"
    if word == 0x4c000064: return "rfi"
    if word == 0x60000000: return "nop"
    if word == 0x7c0802a6: return "mflr  r0"
    if word == 0x7c0803a6: return "mtlr  r0"

    # mflr/mtlr/mfctr/mtctr/mfspr/mtspr (XFX)
    if op == 31:
        xo = (word >> 1) & 0x3FF
        if xo == 339:  # mfspr
            spr = ((word >> 16) & 0x1F) | (((word >> 11) & 0x1F) << 5)
            return f"mfspr r{rs}, {spr}"
        if xo == 467:  # mtspr
            spr = ((word >> 16) & 0x1F) | (((word >> 11) & 0x1F) << 5)
            return f"mtspr {spr}, r{rs}"
        if xo == 24: return f"slw   r{ra},r{rs},r{rb}"
        if xo == 28: return f"and   r{ra},r{rs},r{rb}"
        if xo == 60: return f"andc  r{ra},r{rs},r{rb}"
        if xo == 444: return f"or    r{ra},r{rs},r{rb}"
        if xo == 124: return f"nor   r{ra},r{rs},r{rb}"
        if xo == 266: return f"add   r{rs},r{ra},r{rb}"
        if xo == 40: return f"subf  r{rs},r{ra},r{rb}"
        if xo == 23: return f"lwzx  r{rs},r{ra},r{rb}"
        if xo == 151: return f"stwx  r{rs},r{ra},r{rb}"
        if xo == 0:  return f"cmp   cr{rs>>2},r{ra},r{rb}"
        if xo == 32: return f"cmpl  cr{rs>>2},r{ra},r{rb}"
        if xo == 467 + 0: pass
        return f"op31  xo={xo} rs={rs} ra={ra} rb={rb}"

    if op == 14: return f"addi  r{rs},r{ra},{simm}  ; ={'(no ra)' if ra==0 else ''}"
    if op == 15: return f"addis r{rs},r{ra},{simm:#x}"
    if op == 24: return f"ori   r{ra},r{rs},{uimm:#x}"
    if op == 25: return f"oris  r{ra},r{rs},{uimm:#x}"
    if op == 28: return f"andi. r{ra},r{rs},{uimm:#x}"
    if op == 32: return f"lwz   r{rs},{simm}(r{ra})"
    if op == 33: return f"lwzu  r{rs},{simm}(r{ra})"
    if op == 36: return f"stw   r{rs},{simm}(r{ra})"
    if op == 37: return f"stwu  r{rs},{simm}(r{ra})"
    if op == 40: return f"lhz   r{rs},{simm}(r{ra})"
    if op == 44: return f"sth   r{rs},{simm}(r{ra})"
    if op == 34: return f"lbz   r{rs},{simm}(r{ra})"
    if op == 38: return f"stb   r{rs},{simm}(r{ra})"
    if op == 11:
        bf = rs >> 2
        return f"cmpi  cr{bf},r{ra},{simm}"
    if op == 10:
        bf = rs >> 2
        return f"cmpli cr{bf},r{ra},{uimm:#x}"
    if op == 18:
        # b/bl
        li = word & 0x03FFFFFC
        if li & 0x02000000: li -= 0x04000000
        target = (addr + li) & 0xFFFFFFFF if (word & 2) == 0 else (li & 0xFFFFFFFF)
        lk = "l" if (word & 1) else ""
        aa = "a" if (word & 2) else ""
        return f"b{lk}{aa}    {target:#010x}"
    if op == 16:
        # bcx
        bo = (word >> 21) & 0x1F
        bi = (word >> 16) & 0x1F
        bd = word & 0xFFFC
        if bd & 0x8000: bd -= 0x10000
        target = (addr + bd) & 0xFFFFFFFF if (word & 2) == 0 else (bd & 0xFFFFFFFF)
        lk = "l" if (word & 1) else ""
        # short BO/BI mnemonic
        if bo == 12: m = "bt"
        elif bo == 4: m = "bne+"
        elif bo == 5: m = "bne-"
        elif bo == 12: m = "beq"
        elif bo == 16: m = "bdnz"
        else: m = f"bc({bo},{bi})"
        return f"{m}{lk}  {target:#010x}"
    if op == 19:
        xo = (word >> 1) & 0x3FF
        if xo == 16:  # bclr (blr if BO=20,BI=0)
            bo = (word >> 21) & 0x1F
            bi = (word >> 16) & 0x1F
            lk = "l" if (word & 1) else ""
            if bo == 20 and bi == 0: return f"blr{lk}"
            return f"bc{lk}lr bo={bo},bi={bi}"
        if xo == 528:  # bcctr
            bo = (word >> 21) & 0x1F
            bi = (word >> 16) & 0x1F
            lk = "l" if (word & 1) else ""
            if bo == 20: return f"bctr{lk}"
            return f"bc{lk}ctr bo={bo},bi={bi}"
        return f"op19  xo={xo}"
    if op == 21:  # rlwinm
        sh = (word >> 11) & 0x1F
        mb = (word >> 6) & 0x1F
        me = (word >> 1) & 0x1F
        rc = "."  if (word & 1) else ""
        return f"rlwinm{rc} r{ra},r{rs},{sh},{mb},{me}"
    return f"???   op={op} word={word:08x}"

print("=" * 70)
print("Function 0x800f7580 — disassembling 256 bytes (64 instrs)")
print("=" * 70)
data = read_at(0x800f7580, 0x100)
blr_pc = None
for i in range(64):
    pc = 0x800f7580 + i*4
    word = struct.unpack(">I", data[i*4:i*4+4])[0]
    mnem = disasm(pc, word)
    marker = ""
    if word == 0x7c0802a6 and i == 0: marker = "  <-- function start"
    if word == 0x4e800020:
        marker = "  <-- BLR"
        if blr_pc is None: blr_pc = pc
    print(f"  {pc:08x}: {word:08x}  {mnem}{marker}")
    if word == 0x4e800020 and i > 5:
        # show next 4 to see if there's a fall-through after first BLR
        for j in range(1, 5):
            pc2 = pc + j*4
            w2 = struct.unpack(">I", data[(i+j)*4:(i+j)*4+4])[0]
            m2 = disasm(pc2, w2)
            print(f"  {pc2:08x}: {w2:08x}  {m2}")
        break

print()
print("=" * 70)
print("Panic format string region 0x801ce178..0x801cf200 (3.5KB)")
print("=" * 70)

# Need to locate .data/.rodata section for 0x801ce178
# Read DOL header to find sections
with open(ISO, "rb") as f:
    f.seek(DOL_OFF)
    hdr = f.read(0x100)
sec_offsets = struct.unpack(">18I", hdr[0:0x48])
sec_loads   = struct.unpack(">18I", hdr[0x48:0x90])
sec_sizes   = struct.unpack(">18I", hdr[0x90:0xd8])

print("DOL sections:")
for i in range(18):
    if sec_loads[i] == 0: continue
    kind = "text" if i < 7 else "data"
    print(f"  [{i:2d}] {kind} load={sec_loads[i]:08x} file=0x{sec_offsets[i]:06x} size=0x{sec_sizes[i]:06x}")

def vaddr_to_iso_any(vaddr):
    for i in range(18):
        if sec_loads[i] == 0: continue
        if sec_loads[i] <= vaddr < sec_loads[i] + sec_sizes[i]:
            off_in = vaddr - sec_loads[i]
            return DOL_OFF + sec_offsets[i] + off_in, i
    return None, None

start = 0x801ce178
end = 0x801cf200
iso_off, sec_idx = vaddr_to_iso_any(start)
print(f"\n0x{start:08x} maps to DOL section {sec_idx}, ISO offset {iso_off:#x}")
if iso_off is None:
    print("Region is in BSS (allocated at runtime, not in DOL).")
else:
    with open(ISO, "rb") as f:
        f.seek(iso_off)
        blob = f.read(end - start)
    # print as printable strings
    print("\nPrintable strings in region (>=4 chars):")
    cur = bytearray()
    cur_addr = start
    pos = start
    for b in blob:
        if 0x20 <= b < 0x7f or b in (0x09, 0x0a):
            if not cur: cur_addr = pos
            cur.append(b)
        else:
            if len(cur) >= 4:
                rep = cur.decode("latin-1").replace("\n", "\\n").replace("\t", "\\t")
                print(f"  {cur_addr:08x}: {rep!r}")
            cur = bytearray()
        pos += 1
    if len(cur) >= 4:
        rep = cur.decode("latin-1").replace("\n", "\\n")
        print(f"  {cur_addr:08x}: {rep!r}")

    # Specifically pick out the format around 0x801cebdc (Exception %d)
    print()
    print("Bytes around 0x801cebdc (Exception %d format):")
    rel = 0x801cebdc - start
    chunk = blob[max(0, rel-32):rel+96]
    addr = start + max(0, rel-32)
    print(f"  {addr:08x}:", " ".join(f"{b:02x}" for b in chunk))
    print("  ASCII:    ", "".join(chr(b) if 0x20 <= b < 0x7f else "." for b in chunk))

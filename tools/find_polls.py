#!/usr/bin/env python3
"""find_polls.py — scan a GameCube DOL for polling-loop shapes.

Pattern detected:
  +0: load (lwz/lhz/lbz)  rT, d(rA)
  +4: optional rlwinm/clrlwi (single-bit isolate) or skipped
  +4 or +8: cmpwi or cmpw or cmpli
  +8 or +12: beq/bne -8 or -12 (backward branch to the load)

Outputs each match with:
  pc, function name (from .map), instruction trinity, polled register source.

Usage:
  python3 tools/find_polls.py \\
    --iso 'gamecube/roms/Sonic Adventure 2 - Battle (USA).iso' \\
    --map dolphin_captures/sab.map \\
    [--range 0x800e0000-0x800fa000]
"""
import argparse
import struct
import sys
from pathlib import Path

def load_dol_from_iso(iso_path: Path):
    # GameCube ISO: 0x420 header has main DOL offset. Read DOL, return
    # (text_segments [(start_addr, bytes)], None).
    with iso_path.open('rb') as f:
        f.seek(0x420)
        dol_offset = struct.unpack('>I', f.read(4))[0]
        f.seek(dol_offset)
        # DOL header: 7 text offsets, 11 data offsets, 7 text loadAddrs,
        # 11 data loadAddrs, 7 text sizes, 11 data sizes.
        text_off = struct.unpack('>7I', f.read(28))
        data_off = struct.unpack('>11I', f.read(44))
        text_addr = struct.unpack('>7I', f.read(28))
        data_addr = struct.unpack('>11I', f.read(44))
        text_size = struct.unpack('>7I', f.read(28))
        data_size = struct.unpack('>11I', f.read(44))

        segments = []
        for i in range(7):
            if text_size[i] and text_off[i]:
                f.seek(dol_offset + text_off[i])
                segments.append((text_addr[i], f.read(text_size[i])))
        for i in range(11):
            if data_size[i] and data_off[i]:
                f.seek(dol_offset + data_off[i])
                segments.append((data_addr[i], f.read(data_size[i])))
        return segments

def load_map(map_path: Path):
    # CodeWarrior .map: "  ADDR SIZE LOADADDR ALIGN NAME"
    # Returns sorted list of (addr, size, name).
    syms = []
    for line in map_path.read_text(errors='replace').splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5: continue
        try:
            a = int(parts[0], 16)
            s = int(parts[1], 16)
        except ValueError:
            continue
        syms.append((a, s, parts[4].strip()))
    syms.sort()
    return syms

def find_sym(syms, pc):
    for (a, s, n) in syms:
        if a <= pc < a + s:
            return n
    return '<unknown>'

def is_load(inst):
    # lwz (32), lhz (40), lbz (34), lha (42), lhau (43), lhzu (41), lwzu (33), lbzu (35)
    op = (inst >> 26) & 0x3F
    return op in (32, 40, 34, 42, 41, 33, 43, 35)

def load_disp(inst):
    op = (inst >> 26) & 0x3F
    rT = (inst >> 21) & 0x1F
    rA = (inst >> 16) & 0x1F
    d = inst & 0xFFFF
    if d & 0x8000: d -= 0x10000  # signed
    name = {32:'lwz', 33:'lwzu', 34:'lbz', 35:'lbzu',
            40:'lhz', 41:'lhzu', 42:'lha', 43:'lhau'}.get(op, f'op{op}')
    return f'{name} r{rT}, {d}(r{rA})', rT, rA, d

def is_cmp(inst):
    # cmpi (11), cmpli (10), cmp (31, sub=0), cmpl (31, sub=32)
    op = (inst >> 26) & 0x3F
    if op == 11 or op == 10: return True
    if op == 31:
        sub = (inst >> 1) & 0x3FF
        return sub == 0 or sub == 32
    return False

def is_rlwinm(inst):
    return (inst >> 26) & 0x3F == 21

def is_back_branch(inst, offset):
    # bc (16), b (18). For polling we want bc with disp=-8 or -12.
    op = (inst >> 26) & 0x3F
    if op != 16: return None
    bo = (inst >> 21) & 0x1F
    bi = (inst >> 16) & 0x1F
    bd = (inst >> 2) & 0x3FFF
    if bd & 0x2000: bd = bd - 0x4000  # signed 14-bit
    bd = bd * 4
    # Polling branches back -8 (load+cmp+branch) or -12 (load+rlwinm+cmp+branch)
    if bd in (-8, -12):
        cond_name = 'beq' if (bo & 0x10) == 0 and (bi & 3) == 2 and (bo == 12 or bo == 0x0C) else \
                    'bne' if bo == 4 and (bi & 3) == 2 else 'bc'
        return (cond_name, bd)
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--iso', required=True)
    ap.add_argument('--map', required=True)
    ap.add_argument('--range', default='0x80003000-0x80200000',
        help='inclusive VA range to scan, e.g. 0x800e0000-0x800fa000')
    args = ap.parse_args()

    lo_s, hi_s = args.range.split('-')
    lo = int(lo_s, 16); hi = int(hi_s, 16)

    segments = load_dol_from_iso(Path(args.iso))
    syms = load_map(Path(args.map))

    def read_u32(va):
        for (saddr, sbytes) in segments:
            if saddr <= va < saddr + len(sbytes):
                off = va - saddr
                return struct.unpack('>I', sbytes[off:off+4])[0]
        return None

    found = []
    pc = lo & ~3
    while pc < hi:
        i0 = read_u32(pc)
        if i0 is None:
            pc += 4
            continue
        if is_load(i0):
            # Try +4 load, +8 cmp, +12 bc shape OR +4 cmp, +8 bc
            i1 = read_u32(pc + 4)
            i2 = read_u32(pc + 8)
            i3 = read_u32(pc + 12) if pc + 12 < hi else None
            # shape A: load + cmpi + beq/bne -8
            if i1 is not None and is_cmp(i1) and i2 is not None:
                br = is_back_branch(i2, pc + 8)
                if br and br[1] == -8:
                    desc, rT, rA, d = load_disp(i0)
                    fn = find_sym(syms, pc)
                    found.append((pc, fn, desc, 'A', rA, d))
            # shape B: load + rlwinm + cmpi + beq/bne -12
            if i1 is not None and is_rlwinm(i1) and i2 is not None and is_cmp(i2) and i3 is not None:
                br = is_back_branch(i3, pc + 12)
                if br and br[1] == -12:
                    desc, rT, rA, d = load_disp(i0)
                    fn = find_sym(syms, pc)
                    found.append((pc, fn, desc, 'B', rA, d))
        pc += 4

    print(f'Found {len(found)} polling-loop sites in {hi-lo:#x}-byte range')
    print(f'{"PC":<10} {"shape":<5} {"instr":<28} {"function"}')
    for (pc, fn, desc, shape, rA, d) in found:
        print(f'0x{pc:08x} {shape:<5} {desc:<28} {fn}')

if __name__ == '__main__':
    main()

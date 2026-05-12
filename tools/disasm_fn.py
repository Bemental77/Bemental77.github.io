#!/usr/bin/env python3
"""Dump PowerPC disassembly for a function range from a DOL inside an ISO.

Usage: python3 disasm_fn.py --iso <iso> --pc <hex> --size <bytes>
"""
import argparse, struct, sys
from pathlib import Path

def load_segments(iso_path):
    with iso_path.open('rb') as f:
        f.seek(0x420)
        dol = struct.unpack('>I', f.read(4))[0]
        f.seek(dol)
        text_off = struct.unpack('>7I', f.read(28))
        data_off = struct.unpack('>11I', f.read(44))
        text_addr = struct.unpack('>7I', f.read(28))
        data_addr = struct.unpack('>11I', f.read(44))
        text_size = struct.unpack('>7I', f.read(28))
        data_size = struct.unpack('>11I', f.read(44))
        segs = []
        for i in range(7):
            if text_size[i]:
                f.seek(dol + text_off[i])
                segs.append((text_addr[i], f.read(text_size[i])))
        for i in range(11):
            if data_size[i]:
                f.seek(dol + data_off[i])
                segs.append((data_addr[i], f.read(data_size[i])))
        return segs

def read_u32(segs, va):
    for a, b in segs:
        if a <= va < a + len(b):
            return struct.unpack('>I', b[va-a:va-a+4])[0]
    return None

def decode(inst, pc):
    op = (inst >> 26) & 0x3F
    rT = (inst >> 21) & 0x1F
    rA = (inst >> 16) & 0x1F
    rB = (inst >> 11) & 0x1F
    d  = inst & 0xFFFF
    if d & 0x8000: d -= 0x10000
    if op == 14: return f'addi    r{rT}, r{rA}, {d}'
    if op == 15: return f'addis   r{rT}, r{rA}, 0x{d & 0xFFFF:x}'
    if op == 32: return f'lwz     r{rT}, {d}(r{rA})'
    if op == 33: return f'lwzu    r{rT}, {d}(r{rA})'
    if op == 34: return f'lbz     r{rT}, {d}(r{rA})'
    if op == 36: return f'stw     r{rT}, {d}(r{rA})'
    if op == 37: return f'stwu    r{rT}, {d}(r{rA})'
    if op == 38: return f'stb     r{rT}, {d}(r{rA})'
    if op == 40: return f'lhz     r{rT}, {d}(r{rA})'
    if op == 42: return f'lha     r{rT}, {d}(r{rA})'
    if op == 44: return f'sth     r{rT}, {d}(r{rA})'
    if op == 10: return f'cmpli   cr{(inst>>23)&7}, r{rA}, {inst & 0xFFFF}'
    if op == 11: return f'cmpi    cr{(inst>>23)&7}, r{rA}, {(inst & 0xFFFF) - (0x10000 if (inst & 0xFFFF) & 0x8000 else 0)}'
    if op == 16:
        bo = rT; bi = rA
        bd = (inst >> 2) & 0x3FFF
        if bd & 0x2000: bd -= 0x4000
        tgt = pc + bd * 4
        if (inst & 1): return f'bcl     bo={bo}, bi={bi}, 0x{tgt:x}'
        if (inst & 2): return f'bca     bo={bo}, bi={bi}, 0x{tgt:x}'
        # decode common bc forms
        if bo == 12 and (bi & 3) == 2: return f'beq     cr{bi>>2}, 0x{tgt:x}'
        if bo == 4  and (bi & 3) == 2: return f'bne     cr{bi>>2}, 0x{tgt:x}'
        return f'bc      bo={bo}, bi={bi}, 0x{tgt:x}'
    if op == 18:
        li = inst & 0x3FFFFFC
        if li & 0x2000000: li -= 0x4000000
        tgt = pc + li if (inst & 2) == 0 else li
        kind = 'bl' if (inst & 1) else 'b'
        return f'{kind:6}  0x{tgt:x}'
    if op == 19:
        sub = (inst >> 1) & 0x3FF
        if sub == 16: return 'bclr'
        if sub == 528: return 'bcctr'
        if sub == 50: return 'rfi'
        return f'op19 sub={sub}'
    if op == 20: return f'rlwimi  r{rA}, r{rT}, {(inst>>11)&31}, {(inst>>6)&31}, {(inst>>1)&31}'
    if op == 21: return f'rlwinm  r{rA}, r{rT}, sh={(inst>>11)&31}, mb={(inst>>6)&31}, me={(inst>>1)&31}'
    if op == 24: return f'ori     r{rA}, r{rT}, 0x{inst & 0xFFFF:x}'
    if op == 25: return f'oris    r{rA}, r{rT}, 0x{inst & 0xFFFF:x}'
    if op == 26: return f'xori    r{rA}, r{rT}, 0x{inst & 0xFFFF:x}'
    if op == 28: return f'andi.   r{rA}, r{rT}, 0x{inst & 0xFFFF:x}'
    if op == 31:
        sub = (inst >> 1) & 0x3FF
        if sub == 0:   return f'cmp     cr{(inst>>23)&7}, r{rA}, r{rB}'
        if sub == 32:  return f'cmpl    cr{(inst>>23)&7}, r{rA}, r{rB}'
        if sub == 444: return f'or      r{rA}, r{rT}, r{rB}  ; (mr if rT=rB)'
        if sub == 339: return f'mfspr   r{rT}, {(rB<<5)|rA}'
        if sub == 467: return f'mtspr   {(rB<<5)|rA}, r{rT}'
        if sub == 23:  return f'lwzx    r{rT}, r{rA}, r{rB}'
        if sub == 151: return f'stwx    r{rT}, r{rA}, r{rB}'
        return f'op31 sub={sub} rT={rT} rA={rA} rB={rB}'
    return f'op{op}'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--iso', required=True)
    ap.add_argument('--pc', required=True)
    ap.add_argument('--size', type=lambda x: int(x, 0), default=128)
    args = ap.parse_args()
    segs = load_segments(Path(args.iso))
    pc = int(args.pc, 16)
    end = pc + args.size
    while pc < end:
        inst = read_u32(segs, pc)
        if inst is None:
            print(f'{pc:08x}: <unmapped>')
            pc += 4; continue
        print(f'{pc:08x}: {inst:08x}  {decode(inst, pc)}')
        pc += 4

if __name__ == '__main__':
    main()

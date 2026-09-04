#!/usr/bin/env python3
"""gc_disasm.py — static PowerPC disassembly of a GameCube DOL, by address or by
recovered function, with symbols and control-flow annotation.

Why not `dump_sab_pc.mjs`: that reads LIVE guest memory and therefore needs a
running probe (a browser, a lock, and load on the box) to answer a question that
is entirely static. Why not `disasm_hot_pcs.py`: its PC list is hardcoded in the
source and its decoder is a hand-rolled subset that prints `op31.266` for `add`.
This uses capstone's PPC decoder plus a Gekko paired-single pre-pass.

Symbols come from `gc_symbols.Symbols`, so a function recovered by
`gc_funcmap.py` prints as `fn_800f3710+0x4` rather than a bare address.

Usage:
  ROM_IDX=1 python3 gamecube/tools/gc_disasm.py 0x80117df8          # whole fn
  ROM_IDX=1 python3 gamecube/tools/gc_disasm.py 0x80117e00 0x40     # addr+len
  ROM_IDX=1 python3 gamecube/tools/gc_disasm.py --classify 0x80117df8 ...
"""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gc_funcmap import ROMS, load_rom, dol_base, text_sections, Text, branch_target, is_terminator  # noqa: E402
from gc_symbols import Symbols  # noqa: E402

try:
    from capstone import Cs, CS_ARCH_PPC, CS_MODE_32, CS_MODE_BIG_ENDIAN
except ImportError:
    print("capstone is required: python3 -m pip install capstone", file=sys.stderr)
    raise

ROM = int(os.environ.get("ROM_IDX", "1"))


# ---- Gekko paired-single: capstone's PPC has no PS ops, decode them here ----
_PS_XO = {0: "ps_cmpu0", 8: "ps_neg", 10: "ps_add", 11: "ps_sub", 12: "ps_mul",
          14: "ps_msub", 15: "ps_madd", 18: "ps_div", 20: "ps_sub", 21: "ps_add",
          23: "ps_sel", 24: "ps_res", 25: "ps_mul", 26: "ps_rsqrte",
          28: "ps_msub", 29: "ps_madd", 30: "ps_nmsub", 31: "ps_nmadd",
          32: "ps_cmpo0", 40: "ps_neg", 64: "ps_cmpu1", 72: "ps_mr",
          96: "ps_cmpo1", 136: "ps_nabs", 264: "ps_abs",
          528: "ps_merge00", 560: "ps_merge01", 592: "ps_merge10",
          624: "ps_merge11", 1014: "dcbz_l"}


def gekko_ps(addr, w):
    """Return a mnemonic string for a Gekko-only encoding, else None."""
    op = w >> 26
    d, a, b = (w >> 21) & 31, (w >> 16) & 31, (w >> 11) & 31
    if op in (56, 57, 60, 61):                       # psq_l/psq_lu/psq_st/psq_stu
        nm = {56: "psq_l", 57: "psq_lu", 60: "psq_st", 61: "psq_stu"}[op]
        ds = w & 0xFFF
        if ds & 0x800:
            ds -= 0x1000
        wbit, i = (w >> 15) & 1, (w >> 12) & 7
        return "%-8s f%d, %d(r%d), %d, qr%d" % (nm, d, ds, a, wbit, i)
    if op == 4:
        xo = (w >> 1) & 0x3FF
        nm = _PS_XO.get(xo) or _PS_XO.get(xo & 0x1F)
        if nm:
            return "%-8s f%d, f%d, f%d" % (nm, d, a, b)
        return "ps.%d    f%d, f%d, f%d" % (xo, d, a, b)
    return None


class Dis:
    def __init__(self, rom_idx):
        cfg = ROMS[rom_idx]
        rom = load_rom(cfg["bin"])
        base = dol_base(rom, cfg["kind"])
        self.secs = text_sections(rom, base)
        self.text = Text(rom, self.secs)
        self.syms = Symbols(rom_idx)
        self.game = cfg["game"]
        self.cs = Cs(CS_ARCH_PPC, CS_MODE_32 | CS_MODE_BIG_ENDIAN)

    def fn_range(self, addr):
        """(start, size) of the function containing addr, from the symbol map."""
        r = self.syms.find(addr)
        if r:
            return addr - r[1], r[2]
        return addr, 0x80

    def one(self, pc):
        w = self.text.w(pc)
        if w is None:
            return None, None
        m = gekko_ps(pc, w)
        if m is None:
            code = struct.pack(">I", w)
            ins = list(self.cs.disasm(code, pc))
            if ins:
                i = ins[0]
                m = ("%-8s %s" % (i.mnemonic, i.op_str)).rstrip()
            else:
                m = ".word    0x%08x" % w
        return w, m

    def show(self, start, size, out=sys.stdout):
        for pc in range(start, start + size, 4):
            w, m = self.one(pc)
            if w is None:
                continue
            tgt, is_call, _ = branch_target(pc, w)
            ann = ""
            if tgt is not None:
                if start <= tgt < start + size:
                    ann = "   ; -> +0x%x%s" % (tgt - start,
                                               " (BACK-EDGE)" if tgt <= pc else "")
                else:
                    ann = "   ; -> %s" % self.syms.name(tgt)
            out.write("  %08x: %08x  %-34s%s\n" % (pc, w, m, ann))


def classify(d, start, size):
    """Mechanical shape summary used to argue busy-wait vs real compute.

    Counts the things the sab-frame-governor doc's busy-wait criterion is stated
    in terms of: stores, calls, side-effecting ops, and self-back-edges.
    """
    stores = calls = loads = fp = sideeff = backedge = n = 0
    store_ops = set(range(36, 48)) | {54, 55, 60, 61}        # stw..stfdu, psq_st*
    load_ops = set(range(32, 36)) | set(range(40, 44)) | {46, 48, 49, 50, 51, 56, 57}
    for pc in range(start, start + size, 4):
        w = d.text.w(pc)
        if w is None:
            continue
        n += 1
        op = w >> 26
        tgt, is_call, _ = branch_target(pc, w)
        if is_call:
            calls += 1
        if tgt is not None and start <= tgt <= pc:
            backedge += 1
        if op in store_ops:
            stores += 1
        elif op in load_ops:
            loads += 1
        if op in (4, 59, 63) or 48 <= op <= 61:
            fp += 1
        if op == 31:
            xo = (w >> 1) & 0x3FF
            if xo in (150, 151, 183, 215, 247, 407, 439, 662, 725, 727,
                      758, 854, 918, 982, 1014, 470, 54, 86, 246, 1010):
                stores += 1                                   # stX indexed / cache ops
            if xo in (467, 146, 210, 242, 306, 370, 371, 598, 4):
                sideeff += 1                                  # mtspr/mtmsr/mtsr/tlb/sync
    return dict(n=n, stores=stores, loads=loads, calls=calls, fp=fp,
                sideeff=sideeff, backedge=backedge)


def main():
    args = [a for a in sys.argv[1:]]
    do_class = "--classify" in args
    if do_class:
        args.remove("--classify")
    if not args:
        print(__doc__)
        return 1
    d = Dis(ROM)
    print("# %s  (%d symbols in resolver)" % (d.game, len(d.syms.syms)))
    i = 0
    while i < len(args):
        addr = int(args[i], 0)
        size = None
        if i + 1 < len(args) and args[i + 1].startswith(("0x", "0X")) and \
                int(args[i + 1], 0) < 0x1000:
            size = int(args[i + 1], 0)
            i += 1
        i += 1
        start, fsz = d.fn_range(addr)
        if size is None:
            start, size = start, (fsz or 0x80)
        else:
            start = addr
        print("\n== %s  [0x%08x .. 0x%08x)  %d bytes"
              % (d.syms.name(start), start, start + size, size))
        d.show(start, size)
        if do_class:
            c = classify(d, start, size)
            print("   shape: %(n)d instrs  loads=%(loads)d stores=%(stores)d "
                  "calls=%(calls)d fp=%(fp)d sideeff=%(sideeff)d "
                  "backedges=%(backedge)d" % c)
    return 0


if __name__ == "__main__":
    sys.exit(main())

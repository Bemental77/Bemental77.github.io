#!/usr/bin/env python3
"""Minimal SH4 disassembler. Covers the instructions needed for IP.BIN analysis."""
import sys, struct

def disasm(op, pc):
    """Disassemble a single 16-bit SH4 opcode at pc. Returns string."""
    n = (op >> 8) & 0xF
    m = (op >> 4) & 0xF
    d4 = op & 0xF
    d8 = op & 0xFF
    d12 = op & 0xFFF
    sd8 = d8 if d8 < 0x80 else d8 - 0x100
    sd12 = d12 if d12 < 0x800 else d12 - 0x1000

    hi4 = (op >> 12) & 0xF

    if op == 0x0009: return "nop"
    if op == 0x000B: return "rts"
    if op == 0x002B: return "rte"
    if op == 0x0008: return "clrt"
    if op == 0x0018: return "sett"
    if op == 0x0019: return "div0u"
    if op == 0x001B: return "sleep"
    if op == 0x0028: return "clrmac"
    if op == 0x0048: return "clrs"
    if op == 0x0058: return "sets"
    if op == 0x0038: return "ldtlb"
    if op == 0x0068: return "nott"
    if op == 0x00FF: return "fschg"
    if op == 0x00BF: return "frchg"

    if hi4 == 0:
        if (op & 0xF00F) == 0x0004: return f"mov.b R{m},@(R0,R{n})"
        if (op & 0xF00F) == 0x0005: return f"mov.w R{m},@(R0,R{n})"
        if (op & 0xF00F) == 0x0006: return f"mov.l R{m},@(R0,R{n})"
        if (op & 0xF00F) == 0x0007: return f"mul.l R{m},R{n}"
        if (op & 0xF00F) == 0x000C: return f"mov.b @(R0,R{m}),R{n}"
        if (op & 0xF00F) == 0x000D: return f"mov.w @(R0,R{m}),R{n}"
        if (op & 0xF00F) == 0x000E: return f"mov.l @(R0,R{m}),R{n}"
        if (op & 0xF00F) == 0x000F: return f"mac.l @R{m}+,@R{n}+"
        if (op & 0xF0FF) == 0x0023: return f"braf R{n}"
        if (op & 0xF0FF) == 0x0003: return f"bsrf R{n}"
        if (op & 0xF0FF) == 0x0029: return f"movt R{n}"
        if (op & 0xF0FF) == 0x0002: return f"stc SR,R{n}"
        if (op & 0xF0FF) == 0x0012: return f"stc GBR,R{n}"
        if (op & 0xF0FF) == 0x0022: return f"stc VBR,R{n}"
        if (op & 0xF0FF) == 0x0032: return f"stc SSR,R{n}"
        if (op & 0xF0FF) == 0x0042: return f"stc SPC,R{n}"
        if (op & 0xF0FF) == 0x000A: return f"sts MACH,R{n}"
        if (op & 0xF0FF) == 0x001A: return f"sts MACL,R{n}"
        if (op & 0xF0FF) == 0x002A: return f"sts PR,R{n}"
        if (op & 0xF0FF) == 0x005A: return f"sts FPUL,R{n}"
        if (op & 0xF0FF) == 0x006A: return f"sts FPSCR,R{n}"
        if (op & 0xF0FF) == 0x0093: return f"ocbi @R{n}"
        if (op & 0xF0FF) == 0x00A3: return f"ocbp @R{n}"
        if (op & 0xF0FF) == 0x00B3: return f"ocbwb @R{n}"
        if (op & 0xF0FF) == 0x0083: return f"pref @R{n}"
        if (op & 0xF0FF) == 0x0073: return f"movco.l R0,@R{n}"
        if (op & 0xF0FF) == 0x0063: return f"movli.l @R{m},R0"

    if hi4 == 1:
        return f"mov.l R{m},@({d4*4:#x},R{n})"

    if hi4 == 2:
        sub = d4
        if sub == 0: return f"mov.b R{m},@R{n}"
        if sub == 1: return f"mov.w R{m},@R{n}"
        if sub == 2: return f"mov.l R{m},@R{n}"
        if sub == 4: return f"mov.b R{m},@-R{n}"
        if sub == 5: return f"mov.w R{m},@-R{n}"
        if sub == 6: return f"mov.l R{m},@-R{n}"
        if sub == 7: return f"div0s R{m},R{n}"
        if sub == 8: return f"tst R{m},R{n}"
        if sub == 9: return f"and R{m},R{n}"
        if sub == 10: return f"xor R{m},R{n}"
        if sub == 11: return f"or R{m},R{n}"
        if sub == 12: return f"cmp/str R{m},R{n}"
        if sub == 13: return f"xtrct R{m},R{n}"
        if sub == 14: return f"mulu.w R{m},R{n}"
        if sub == 15: return f"muls.w R{m},R{n}"

    if hi4 == 3:
        sub = d4
        names = {0:"cmp/eq",2:"cmp/hs",3:"cmp/ge",4:"div1",5:"dmulu.l",6:"cmp/hi",7:"cmp/gt",
                 8:"sub",10:"subc",11:"subv",12:"add",13:"dmuls.l",14:"addc",15:"addv"}
        if sub in names: return f"{names[sub]} R{m},R{n}"

    if hi4 == 4:
        sub = op & 0xFF
        single = {
            0x00:"shll", 0x01:"shlr", 0x04:"rotl", 0x05:"rotr", 0x08:"shll2", 0x09:"shlr2",
            0x10:"dt", 0x11:"cmp/pz", 0x15:"cmp/pl", 0x18:"shll8", 0x19:"shlr8",
            0x20:"shal", 0x21:"shar", 0x24:"rotcl", 0x25:"rotcr", 0x28:"shll16", 0x29:"shlr16",
        }
        if sub in single: return f"{single[sub]} R{n}"
        if sub == 0x02: return f"sts.l MACH,@-R{n}"
        if sub == 0x12: return f"sts.l MACL,@-R{n}"
        if sub == 0x22: return f"sts.l PR,@-R{n}"
        if sub == 0x52: return f"sts.l FPUL,@-R{n}"
        if sub == 0x62: return f"sts.l FPSCR,@-R{n}"
        if sub == 0x06: return f"lds.l @R{n}+,MACH"
        if sub == 0x16: return f"lds.l @R{n}+,MACL"
        if sub == 0x26: return f"lds.l @R{n}+,PR"
        if sub == 0x56: return f"lds.l @R{n}+,FPUL"
        if sub == 0x66: return f"lds.l @R{n}+,FPSCR"
        if sub == 0x03: return f"stc.l SR,@-R{n}"
        if sub == 0x13: return f"stc.l GBR,@-R{n}"
        if sub == 0x23: return f"stc.l VBR,@-R{n}"
        if sub == 0x33: return f"stc.l SSR,@-R{n}"
        if sub == 0x43: return f"stc.l SPC,@-R{n}"
        if sub == 0x07: return f"ldc.l @R{n}+,SR"
        if sub == 0x17: return f"ldc.l @R{n}+,GBR"
        if sub == 0x27: return f"ldc.l @R{n}+,VBR"
        if sub == 0x37: return f"ldc.l @R{n}+,SSR"
        if sub == 0x47: return f"ldc.l @R{n}+,SPC"
        if sub == 0x0A: return f"lds R{n},MACH"
        if sub == 0x1A: return f"lds R{n},MACL"
        if sub == 0x2A: return f"lds R{n},PR"
        if sub == 0x5A: return f"lds R{n},FPUL"
        if sub == 0x6A: return f"lds R{n},FPSCR"
        if sub == 0x0E: return f"ldc R{n},SR"
        if sub == 0x1E: return f"ldc R{n},GBR"
        if sub == 0x2E: return f"ldc R{n},VBR"
        if sub == 0x3E: return f"ldc R{n},SSR"
        if sub == 0x4E: return f"ldc R{n},SPC"
        if sub == 0x0B: return f"jsr @R{n}"
        if sub == 0x2B: return f"jmp @R{n}"
        if sub == 0x1B: return f"tas.b @R{n}"
        if (op & 0xF00F) == 0x400C: return f"shad R{m},R{n}"
        if (op & 0xF00F) == 0x400D: return f"shld R{m},R{n}"
        if (op & 0xF00F) == 0x400F: return f"mac.w @R{m}+,@R{n}+"

    if hi4 == 5:
        return f"mov.l @({d4*4:#x},R{m}),R{n}"

    if hi4 == 6:
        sub = d4
        if sub == 0: return f"mov.b @R{m},R{n}"
        if sub == 1: return f"mov.w @R{m},R{n}"
        if sub == 2: return f"mov.l @R{m},R{n}"
        if sub == 3: return f"mov R{m},R{n}"
        if sub == 4: return f"mov.b @R{m}+,R{n}"
        if sub == 5: return f"mov.w @R{m}+,R{n}"
        if sub == 6: return f"mov.l @R{m}+,R{n}"
        if sub == 7: return f"not R{m},R{n}"
        if sub == 8: return f"swap.b R{m},R{n}"
        if sub == 9: return f"swap.w R{m},R{n}"
        if sub == 10: return f"negc R{m},R{n}"
        if sub == 11: return f"neg R{m},R{n}"
        if sub == 12: return f"extu.b R{m},R{n}"
        if sub == 13: return f"extu.w R{m},R{n}"
        if sub == 14: return f"exts.b R{m},R{n}"
        if sub == 15: return f"exts.w R{m},R{n}"

    if hi4 == 7:
        return f"add #{sd8:d},R{n}    ; #{d8:#x}"

    if hi4 == 8:
        sub = (op >> 8) & 0xF
        if sub == 0x0: return f"mov.b R0,@({d4:#x},R{m})"
        if sub == 0x1: return f"mov.w R0,@({d4*2:#x},R{m})"
        if sub == 0x4: return f"mov.b @({d4:#x},R{m}),R0"
        if sub == 0x5: return f"mov.w @({d4*2:#x},R{m}),R0"
        if sub == 0x8: return f"cmp/eq #{sd8:d},R0    ; #{d8:#x}"
        if sub == 0x9:
            target = pc + 4 + sd8*2
            return f"bt {target:#010x}"
        if sub == 0xB:
            target = pc + 4 + sd8*2
            return f"bf {target:#010x}"
        if sub == 0xD:
            target = pc + 4 + sd8*2
            return f"bt/s {target:#010x}"
        if sub == 0xF:
            target = pc + 4 + sd8*2
            return f"bf/s {target:#010x}"

    if hi4 == 9:
        addr = (pc + 4) + d8*2
        return f"mov.w @({d8*2:#x},PC),R{n}    ; [{addr:#010x}]"

    if hi4 == 0xA:
        target = pc + 4 + sd12*2
        return f"bra {target:#010x}"

    if hi4 == 0xB:
        target = pc + 4 + sd12*2
        return f"bsr {target:#010x}"

    if hi4 == 0xC:
        sub = (op >> 8) & 0xF
        if sub == 0x0: return f"mov.b R0,@({d4:#x},GBR)"
        if sub == 0x1: return f"mov.w R0,@({d4*2:#x},GBR)"
        if sub == 0x2: return f"mov.l R0,@({d4*4:#x},GBR)"
        if sub == 0x3: return f"trapa #{d8:#x}"
        if sub == 0x4: return f"mov.b @({d4:#x},GBR),R0"
        if sub == 0x5: return f"mov.w @({d4*2:#x},GBR),R0"
        if sub == 0x6: return f"mov.l @({d4*4:#x},GBR),R0"
        if sub == 0x7:
            addr = ((pc + 4) & ~3) + d8*4
            return f"mova @({d8*4:#x},PC),R0    ; {addr:#010x}"
        if sub == 0x8: return f"tst #{d8:#x},R0"
        if sub == 0x9: return f"and #{d8:#x},R0"
        if sub == 0xA: return f"xor #{d8:#x},R0"
        if sub == 0xB: return f"or #{d8:#x},R0"
        if sub == 0xC: return f"tst.b #{d8:#x},@(R0,GBR)"
        if sub == 0xD: return f"and.b #{d8:#x},@(R0,GBR)"
        if sub == 0xE: return f"xor.b #{d8:#x},@(R0,GBR)"
        if sub == 0xF: return f"or.b #{d8:#x},@(R0,GBR)"

    if hi4 == 0xD:
        addr = ((pc + 4) & ~3) + d8*4
        return f"mov.l @({d8*4:#x},PC),R{n}    ; [{addr:#010x}]"

    if hi4 == 0xE:
        return f"mov #{sd8:d},R{n}    ; #{d8:#x}"

    if hi4 == 0xF:
        sub = d4
        if sub == 0x0: return f"fadd FR{m},FR{n}"
        if sub == 0x1: return f"fsub FR{m},FR{n}"
        if sub == 0x2: return f"fmul FR{m},FR{n}"
        if sub == 0x3: return f"fdiv FR{m},FR{n}"
        if sub == 0x4: return f"fcmp/eq FR{m},FR{n}"
        if sub == 0x5: return f"fcmp/gt FR{m},FR{n}"
        if sub == 0x6: return f"fmov.s @(R0,R{m}),FR{n}"
        if sub == 0x7: return f"fmov.s FR{m},@(R0,R{n})"
        if sub == 0x8: return f"fmov.s @R{m},FR{n}"
        if sub == 0x9: return f"fmov.s @R{m}+,FR{n}"
        if sub == 0xA: return f"fmov.s FR{m},@R{n}"
        if sub == 0xB: return f"fmov.s FR{m},@-R{n}"
        if sub == 0xC: return f"fmov FR{m},FR{n}"
        if sub == 0xE: return f"fmac FR0,FR{m},FR{n}"

    return f".word {op:#06x}"


def main():
    path = sys.argv[1]
    base = int(sys.argv[2], 0)
    data = open(path, "rb").read()
    pc = base
    out = []
    for i in range(0, len(data) - 1, 2):
        op = struct.unpack_from("<H", data, i)[0]
        s = disasm(op, pc)
        out.append(f"{pc:08x}: {op:04x}    {s}")
        pc += 2
    print("\n".join(out))

if __name__ == "__main__":
    main()

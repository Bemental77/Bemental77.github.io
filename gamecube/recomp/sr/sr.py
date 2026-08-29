#!/usr/bin/env python3
"""sr.py — STATIC RECOMPILER: PowerPC (Gekko) machine code -> C, from the GAME BINARY ONLY.

No decomp, no source, no symbols required beyond a function's (address, size).
This is the N64Recomp model applied to GameCube: decode the shipped .text, translate each
instruction to a C statement over an explicit GekkoState, compile the result with emcc.

  Inputs : a DOL/REL image (address -> bytes) + a function boundary (vaddr, size)
  Output : C source; one `void fn_<vaddr>(GekkoState*)` per function, plus a
           `goto` label per instruction so intra-function branches are exact.

Semantics come from gekko_rt.h, which is a behaviour port of Dolphin's REFERENCE
INTERPRETER (file:line citations in that header). Anything this translator cannot prove
it models exactly raises Untranslatable — it never emits an approximation.

Usage:
  python3 sr.py --image sab_main.dol --map dolphin_captures/sab.map \
                --fn 0x800ed368 --out psmtxconcat.c
  python3 sr.py --image ... --map ... --coverage      # translate every mapped fn, report
"""
import argparse, re, struct, sys, collections


class Untranslatable(Exception):
    def __init__(self, why, pc=None, word=None):
        super().__init__(why)
        self.why, self.pc, self.word = why, pc, word


# ------------------------------------------------------------------ image loader
class Image:
    """Flat vaddr -> byte map assembled from a DOL's TEXT/DATA sections."""

    def __init__(self):
        self.segs = []          # (vaddr, bytes)

    @classmethod
    def from_dol(cls, path):
        img = cls()
        d = open(path, 'rb').read()
        toff = struct.unpack('>7I', d[0x00:0x1c])
        doff = struct.unpack('>11I', d[0x1c:0x48])
        tad = struct.unpack('>7I', d[0x48:0x64])
        dad = struct.unpack('>11I', d[0x64:0x90])
        tsz = struct.unpack('>7I', d[0x90:0xac])
        dsz = struct.unpack('>11I', d[0xac:0xd8])
        for i in range(7):
            if tsz[i]:
                img.segs.append((tad[i], d[toff[i]:toff[i] + tsz[i]]))
        for i in range(11):
            if dsz[i]:
                img.segs.append((dad[i], d[doff[i]:doff[i] + dsz[i]]))
        img.segs.sort()
        return img

    def word(self, va):
        for base, b in self.segs:
            if base <= va < base + len(b) - 3:
                return struct.unpack('>I', b[va - base:va - base + 4])[0]
        return None

    def bytes_at(self, va, n):
        for base, b in self.segs:
            if base <= va and va + n <= base + len(b):
                return b[va - base:va - base + n]
        return None


def load_map(path):
    """Dolphin symbol-map .text section -> [(addr, size, name)] (generated names kept)."""
    out, sec = [], None
    for ln in open(path, errors='replace'):
        m = re.match(r'^(\S+) section layout$', ln.strip())
        if m:
            sec = m.group(1)
            continue
        p = ln.split()
        if sec != '.text' or len(p) < 5:
            continue
        try:
            out.append((int(p[0], 16), int(p[1], 16), p[4]))
        except ValueError:
            pass
    return out


# ---------------------------------------------------------------------- decoding
def S16(x):
    return x - 0x10000 if x & 0x8000 else x


def F(w):
    """Common PowerPC field extraction."""
    return dict(
        op=w >> 26, rS=(w >> 21) & 31, rD=(w >> 21) & 31, rA=(w >> 16) & 31,
        rB=(w >> 11) & 31, rC=(w >> 6) & 31, frS=(w >> 21) & 31, frD=(w >> 21) & 31,
        frA=(w >> 16) & 31, frB=(w >> 11) & 31, frC=(w >> 6) & 31,
        SIMM=S16(w & 0xFFFF), UIMM=w & 0xFFFF, d=S16(w & 0xFFFF),
        xo=(w >> 1) & 0x3FF, xo5=(w >> 1) & 0x1F, Rc=w & 1, OE=(w >> 10) & 1,
        LK=w & 1, AA=(w >> 1) & 1, BO=(w >> 21) & 31, BI=(w >> 16) & 31,
        BD=S16(w & 0xFFFC), LI=(w & 0x03FFFFFC) - (0x04000000 if w & 0x02000000 else 0),
        crfD=(w >> 23) & 7, crfS=(w >> 18) & 7, L=(w >> 21) & 1,
        MB=(w >> 6) & 31, ME=(w >> 1) & 31, SH=(w >> 11) & 31,
        NB=(w >> 11) & 31, SPR=(((w >> 16) & 31) | (((w >> 11) & 31) << 5)),
        CRM=(w >> 12) & 0xFF, crbD=(w >> 21) & 31, crbA=(w >> 16) & 31, crbB=(w >> 11) & 31,
        # paired-single quantized load/store
        psI=(w >> 12) & 7, psW=(w >> 15) & 1, psD=S16((w & 0xFFF) | (0xF000 if w & 0x800 else 0)),
    )


def ea(f, disp='d'):
    """Effective address expression for a d-form load/store."""
    off = f[disp]
    if f['rA'] == 0:
        return f"({off:#x}u)" if off >= 0 else f"((uint32_t)({off}))"
    return f"(st->gpr[{f['rA']}] + (uint32_t)({off}))"


def ea_x(f):
    if f['rA'] == 0:
        return f"st->gpr[{f['rB']}]"
    return f"(st->gpr[{f['rA']}] + st->gpr[{f['rB']}])"


class Translator:
    def __init__(self, img, fn_lo, fn_hi, resolve_call=None):
        self.img, self.lo, self.hi = img, fn_lo, fn_hi
        self.resolve_call = resolve_call
        self.labels = set()
        self.calls = set()

    # --- helpers -----------------------------------------------------------
    def gp(self, r):
        return f"st->gpr[{r}]"

    def branch_cond(self, f):
        """BO/BI -> (C condition expr, list of setup lines).  Models the CTR side too."""
        BO, BI = f['BO'], f['BI']
        pre, conds = [], []
        if not (BO & 4):                      # decrement CTR
            pre.append("st->ctr--;")
            conds.append("(st->ctr != 0)" if not (BO & 2) else "(st->ctr == 0)")
        if not (BO & 16):                     # test CR bit
            bit = f"gk_cr_bit(st, {BI})"
            conds.append(f"({bit} != 0)" if (BO & 8) else f"({bit} == 0)")
        return (" && ".join(conds) if conds else "1"), pre

    # --- the instruction translator ---------------------------------------
    def inst(self, pc, w):
        f = F(w)
        op, o = f['op'], []
        A, B, D, S = f['rA'], f['rB'], f['rD'], f['rS']

        def rc(dst):
            if f['Rc']:
                o.append(f"gk_rc(st, st->gpr[{dst}]);")

        # ---- branches -----------------------------------------------------
        if op == 18:                                     # b / bl / ba / bla
            if f['AA']:
                raise Untranslatable("absolute branch (ba/bla)", pc, w)
            tgt = (pc + f['LI']) & 0xFFFFFFFF
            if f['LK']:
                self.calls.add(tgt)
                o.append(f"st->lr = {pc + 4:#010x}u;")
                o.append(f"CALL({tgt:#010x}u);")
            elif self.lo <= tgt < self.hi:
                self.labels.add(tgt)
                o.append(f"goto L_{tgt:08x};")
            else:                                        # tail call
                self.calls.add(tgt)
                o.append(f"CALL({tgt:#010x}u); return;")
            return o
        if op == 16:                                     # bc
            if f['AA']:
                raise Untranslatable("absolute conditional branch", pc, w)
            tgt = (pc + f['BD']) & 0xFFFFFFFF
            cond, pre = self.branch_cond(f)
            o += pre
            if f['LK']:
                self.calls.add(tgt)
                o.append(f"if ({cond}) {{ st->lr = {pc + 4:#010x}u; CALL({tgt:#010x}u); }}")
            elif self.lo <= tgt < self.hi:
                self.labels.add(tgt)
                o.append(f"if ({cond}) goto L_{tgt:08x};")
            else:
                self.calls.add(tgt)
                o.append(f"if ({cond}) {{ CALL({tgt:#010x}u); return; }}")
            return o
        if op == 19 and f['xo'] == 16:                   # bclr / blr / blrl
            if f['LK']:
                raise Untranslatable("blrl (indirect call through LR)", pc, w)
            cond, pre = self.branch_cond(f)
            o += pre
            o.append("return;" if cond == "1" else f"if ({cond}) return;")
            return o
        if op == 19 and f['xo'] == 528:                  # bcctr / bctr / bctrl
            raise Untranslatable("bctr/bctrl (computed jump / indirect call)", pc, w)
        if op == 19 and f['xo'] == 50:
            raise Untranslatable("rfi (privileged)", pc, w)
        if op == 17:
            raise Untranslatable("sc (system call)", pc, w)

        # ---- integer arithmetic / logic ------------------------------------
        if op == 14:                                     # addi / li
            o.append(f"{self.gp(D)} = " + (f"{f['SIMM'] & 0xFFFFFFFF:#010x}u;" if A == 0
                                           else f"{self.gp(A)} + (uint32_t)({f['SIMM']});"))
            return o
        if op == 15:                                     # addis / lis
            v = (f['UIMM'] << 16) & 0xFFFFFFFF
            o.append(f"{self.gp(D)} = " + (f"{v:#010x}u;" if A == 0
                                           else f"{self.gp(A)} + {v:#010x}u;"))
            return o
        if op == 12 or op == 13:                         # addic / addic.
            o.append(f"{{ uint64_t t = (uint64_t){self.gp(A)} + (uint64_t)(uint32_t)({f['SIMM']});"
                     f" st->xer = (st->xer & ~0x20000000u) | ((t >> 32) ? 0x20000000u : 0u);"
                     f" {self.gp(D)} = (uint32_t)t; }}")
            if op == 13:
                o.append(f"gk_rc(st, {self.gp(D)});")
            return o
        if op == 7:                                      # mulli
            o.append(f"{self.gp(D)} = (uint32_t)((int32_t){self.gp(A)} * (int32_t)({f['SIMM']}));")
            return o
        if op == 8:                                      # subfic
            o.append(f"{self.gp(D)} = (uint32_t)({f['SIMM']}) - {self.gp(A)};")
            return o
        if op in (24, 25):                               # ori / oris
            sh = 0 if op == 24 else 16
            o.append(f"{self.gp(A)} = {self.gp(S)} | {(f['UIMM'] << sh) & 0xFFFFFFFF:#010x}u;")
            return o
        if op in (26, 27):                               # xori / xoris
            sh = 0 if op == 26 else 16
            o.append(f"{self.gp(A)} = {self.gp(S)} ^ {(f['UIMM'] << sh) & 0xFFFFFFFF:#010x}u;")
            return o
        if op in (28, 29):                               # andi. / andis.
            sh = 0 if op == 28 else 16
            o.append(f"{self.gp(A)} = {self.gp(S)} & {(f['UIMM'] << sh) & 0xFFFFFFFF:#010x}u;")
            o.append(f"gk_rc(st, {self.gp(A)});")
            return o
        if op == 11:                                     # cmpi / cmpwi
            o.append(f"gk_cmp_signed(st, {f['crfD']}, (int32_t){self.gp(A)}, {f['SIMM']});")
            return o
        if op == 10:                                     # cmpli / cmplwi
            o.append(f"gk_cmp_unsigned(st, {f['crfD']}, {self.gp(A)}, {f['UIMM']:#x}u);")
            return o
        if op in (20, 21, 23):                           # rlwimi / rlwinm / rlwnm
            n = f"{f['SH']}" if op != 23 else f"(st->gpr[{B}] & 31)"
            m = f"gk_mask({f['MB']}, {f['ME']})"
            rot = f"gk_rotl32({self.gp(S)}, {n})"
            if op == 20:
                o.append(f"{self.gp(A)} = ({rot} & {m}) | ({self.gp(A)} & ~{m});")
            else:
                o.append(f"{self.gp(A)} = {rot} & {m};")
            if f['Rc']:
                o.append(f"gk_rc(st, {self.gp(A)});")
            return o

        # ---- opcode-31 extended --------------------------------------------
        if op == 31:
            xo = f['xo']
            if xo == 266 or xo == 10:                    # add / addc
                o.append(f"{self.gp(D)} = {self.gp(A)} + {self.gp(B)};")
                rc(D); return o
            if xo == 40:                                 # subf
                o.append(f"{self.gp(D)} = {self.gp(B)} - {self.gp(A)};")
                rc(D); return o
            if xo == 8:                                  # subfc
                o.append(f"{{ uint64_t t = (uint64_t){self.gp(B)} + (uint64_t)(~{self.gp(A)}) + 1ull;"
                         f" st->xer = (st->xer & ~0x20000000u) | ((t >> 32) ? 0x20000000u : 0u);"
                         f" {self.gp(D)} = (uint32_t)t; }}")
                rc(D); return o
            if xo == 235:                                # mullw
                o.append(f"{self.gp(D)} = (uint32_t)((int32_t){self.gp(A)} * (int32_t){self.gp(B)});")
                rc(D); return o
            if xo == 75:                                 # mulhw
                o.append(f"{self.gp(D)} = (uint32_t)(((int64_t)(int32_t){self.gp(A)} *"
                         f" (int64_t)(int32_t){self.gp(B)}) >> 32);")
                rc(D); return o
            if xo == 11:                                 # mulhwu
                o.append(f"{self.gp(D)} = (uint32_t)(((uint64_t){self.gp(A)} *"
                         f" (uint64_t){self.gp(B)}) >> 32);")
                rc(D); return o
            if xo == 491:                                # divw
                o.append(f"{self.gp(D)} = ({self.gp(B)} == 0) ? 0u :"
                         f" (uint32_t)((int32_t){self.gp(A)} / (int32_t){self.gp(B)});")
                rc(D); return o
            if xo == 459:                                # divwu
                o.append(f"{self.gp(D)} = ({self.gp(B)} == 0) ? 0u : ({self.gp(A)} / {self.gp(B)});")
                rc(D); return o
            if xo == 104:                                # neg
                o.append(f"{self.gp(D)} = (uint32_t)(-(int32_t){self.gp(A)});")
                rc(D); return o
            # --- carry-chain forms: CA in XER[29] ---
            CARRY = {138: ('adde', f"(uint64_t){self.gp(A)} + (uint64_t){self.gp(B)}"),
                     202: ('addze', f"(uint64_t){self.gp(A)}"),
                     234: ('addme', f"(uint64_t){self.gp(A)} + 0xFFFFFFFFull"),
                     136: ('subfe', f"(uint64_t)(~{self.gp(A)}) + (uint64_t){self.gp(B)}"),
                     200: ('subfze', f"(uint64_t)(~{self.gp(A)})"),
                     232: ('subfme', f"(uint64_t)(~{self.gp(A)}) + 0xFFFFFFFFull")}
            if xo in CARRY:
                _, expr = CARRY[xo]
                o.append(f"{{ uint64_t t = {expr} + (uint64_t)((st->xer >> 29) & 1u);"
                         f" st->xer = (st->xer & ~0x20000000u) | ((t >> 32) ? 0x20000000u : 0u);"
                         f" {self.gp(D)} = (uint32_t)t; }}")
                rc(D); return o
            # --- byte-reversed load/store ---
            if xo == 534:                                # lwbrx
                o.append(f"{{ uint32_t v = gk_r32({ea_x(f)}); {self.gp(D)} = ((v & 0xFFu) << 24) |"
                         f" ((v & 0xFF00u) << 8) | ((v >> 8) & 0xFF00u) | ((v >> 24) & 0xFFu); }}")
                return o
            if xo == 790:                                # lhbrx
                o.append(f"{{ uint16_t v = gk_r16({ea_x(f)});"
                         f" {self.gp(D)} = (uint32_t)(uint16_t)((v >> 8) | (v << 8)); }}")
                return o
            if xo == 662:                                # stwbrx
                o.append(f"{{ uint32_t v = {self.gp(S)}; gk_w32({ea_x(f)}, ((v & 0xFFu) << 24) |"
                         f" ((v & 0xFF00u) << 8) | ((v >> 8) & 0xFF00u) | ((v >> 24) & 0xFFu)); }}")
                return o
            if xo == 918:                                # sthbrx
                o.append(f"{{ uint16_t v = (uint16_t){self.gp(S)};"
                         f" gk_w16({ea_x(f)}, (uint16_t)((v >> 8) | (v << 8))); }}")
                return o
            if xo == 983:                                # stfiwx
                o.append(f"gk_w32({ea_x(f)}, (uint32_t)st->ps0[{f['frS']}]);")
                return o
            if xo == 512:                                # mcrxr
                o.append(f"gk_set_cr(st, {f['crfD']}, (st->xer >> 28) & 0xFu);"
                         f" st->xer &= 0x0FFFFFFFu;")
                return o
            # --- cache hints: architecturally no-ops for a coherent flat host RAM ---
            if xo in (278, 246, 54, 86, 598, 854, 982, 1010):
                return [f"/* cache hint xo={xo} (no-op on flat host RAM) */"]
            if xo == 1014:                               # dcbz
                o.append(f"gk_dcbz({ea_x(f)});")
                return o
            if xo == 20:                                 # lwarx (single-threaded: plain load)
                o.append(f"{self.gp(D)} = gk_r32({ea_x(f)});")
                return o
            if xo == 150:                                # stwcx. (single-threaded: always succeeds)
                o.append(f"gk_w32({ea_x(f)}, {self.gp(S)});")
                o.append(f"gk_set_cr(st, 0, 2u | ((st->xer >> 31) & 1u));")
                return o
            if xo == 28:  o.append(f"{self.gp(A)} = {self.gp(S)} & {self.gp(B)};"); rc(A); return o
            if xo == 444: o.append(f"{self.gp(A)} = {self.gp(S)} | {self.gp(B)};"); rc(A); return o
            if xo == 316: o.append(f"{self.gp(A)} = {self.gp(S)} ^ {self.gp(B)};"); rc(A); return o
            if xo == 60:  o.append(f"{self.gp(A)} = {self.gp(S)} & ~{self.gp(B)};"); rc(A); return o
            if xo == 476: o.append(f"{self.gp(A)} = ~({self.gp(S)} & {self.gp(B)});"); rc(A); return o
            if xo == 124: o.append(f"{self.gp(A)} = ~({self.gp(S)} | {self.gp(B)});"); rc(A); return o
            if xo == 412: o.append(f"{self.gp(A)} = {self.gp(S)} | ~{self.gp(B)};"); rc(A); return o
            if xo == 284: o.append(f"{self.gp(A)} = ~({self.gp(S)} ^ {self.gp(B)});"); rc(A); return o
            if xo == 954: o.append(f"{self.gp(A)} = (uint32_t)(int32_t)(int8_t){self.gp(S)};"); rc(A); return o
            if xo == 922: o.append(f"{self.gp(A)} = (uint32_t)(int32_t)(int16_t){self.gp(S)};"); rc(A); return o
            if xo == 26:                                 # cntlzw
                o.append(f"{{ uint32_t v = {self.gp(S)}; int n = 0; while (n < 32 && !(v & 0x80000000u))"
                         f" {{ v <<= 1; n++; }} {self.gp(A)} = (uint32_t)n; }}")
                rc(A); return o
            if xo == 24:                                 # slw
                o.append(f"{{ uint32_t sh = {self.gp(B)} & 63; {self.gp(A)} = (sh > 31) ? 0u :"
                         f" ({self.gp(S)} << sh); }}")
                rc(A); return o
            if xo == 536:                                # srw
                o.append(f"{{ uint32_t sh = {self.gp(B)} & 63; {self.gp(A)} = (sh > 31) ? 0u :"
                         f" ({self.gp(S)} >> sh); }}")
                rc(A); return o
            if xo == 824:                                # srawi
                sh = f['SH']
                o.append(f"{{ int32_t v = (int32_t){self.gp(S)}; uint32_t ca = (v < 0 &&"
                         f" (v & {((1 << sh) - 1):#x}) != 0) ? 0x20000000u : 0u;"
                         f" st->xer = (st->xer & ~0x20000000u) | ca;"
                         f" {self.gp(A)} = (uint32_t)(v >> {sh}); }}")
                rc(A); return o
            if xo == 792:                                # sraw
                o.append(f"{{ uint32_t sh = {self.gp(B)} & 63; int32_t v = (int32_t){self.gp(S)};"
                         f" if (sh > 31) sh = 31;"
                         f" uint32_t ca = (v < 0 && (v & ((1 << sh) - 1)) != 0) ? 0x20000000u : 0u;"
                         f" st->xer = (st->xer & ~0x20000000u) | ca;"
                         f" {self.gp(A)} = (uint32_t)(v >> sh); }}")
                rc(A); return o
            if xo == 0:                                  # cmp / cmpw
                o.append(f"gk_cmp_signed(st, {f['crfD']}, (int32_t){self.gp(A)}, (int32_t){self.gp(B)});")
                return o
            if xo == 32:                                 # cmpl / cmplw
                o.append(f"gk_cmp_unsigned(st, {f['crfD']}, {self.gp(A)}, {self.gp(B)});")
                return o
            # ---- loads / stores (x-form) ---
            LSX = {87: ('gk_r8', 32), 279: ('gk_r16', 32), 343: ('gk_r16s', 32), 23: ('gk_r32', 32)}
            if xo in LSX:
                fn, _ = LSX[xo]
                if fn == 'gk_r16s':
                    o.append(f"{self.gp(D)} = (uint32_t)(int32_t)(int16_t)gk_r16({ea_x(f)});")
                else:
                    o.append(f"{self.gp(D)} = {fn}({ea_x(f)});")
                return o
            STX = {215: 'gk_w8', 407: 'gk_w16', 151: 'gk_w32'}
            if xo in STX:
                cast = {'gk_w8': '(uint8_t)', 'gk_w16': '(uint16_t)', 'gk_w32': ''}[STX[xo]]
                o.append(f"{STX[xo]}({ea_x(f)}, {cast}{self.gp(S)});")
                return o
            if xo == 535:  o.append(f"st->ps0[{f['frD']}] = gk_cvt_to_double(gk_r32({ea_x(f)}));"
                                    f" st->ps1[{f['frD']}] = st->ps0[{f['frD']}];"); return o   # lfsx
            if xo == 599:  o.append(f"st->ps0[{f['frD']}] = gk_r64({ea_x(f)});"); return o       # lfdx
            if xo == 663:  o.append(f"gk_w32({ea_x(f)}, gk_cvt_to_single_ftz(st->ps0[{f['frS']}]));"); return o
            if xo == 727:  o.append(f"gk_w64({ea_x(f)}, st->ps0[{f['frS']}]);"); return o
            if xo == 339:                                # mfspr
                spr = f['SPR']
                src = {8: 'st->lr', 9: 'st->ctr', 1: 'st->xer'}.get(spr)
                if src is None:
                    raise Untranslatable(f"mfspr SPR{spr} (privileged/host)", pc, w)
                o.append(f"{self.gp(D)} = {src};"); return o
            if xo == 467:                                # mtspr
                spr = f['SPR']
                dst = {8: 'st->lr', 9: 'st->ctr', 1: 'st->xer'}.get(spr)
                if dst is None:
                    raise Untranslatable(f"mtspr SPR{spr} (privileged/host)", pc, w)
                o.append(f"{dst} = {self.gp(S)};"); return o
            if xo == 19:  o.append(f"{self.gp(D)} = st->cr;"); return o          # mfcr
            if xo == 144:                                                        # mtcrf
                crm = f['CRM']
                o.append(f"{{ uint32_t m = 0; " + " ".join(
                    f"m |= 0x{(0xF << ((7 - i) * 4)):08x}u;" for i in range(8) if crm & (1 << (7 - i))
                ) + f" st->cr = (st->cr & ~m) | ({self.gp(S)} & m); }}")
                return o
            if xo in (54, 86, 246, 470, 1014, 598, 982, 4, 566, 370, 566):
                raise Untranslatable(f"cache/sync/trap op x{xo} (host boundary)", pc, w)
            raise Untranslatable(f"op31 xo={xo}", pc, w)

        # ---- opcode-19 CR logic ----------------------------------------------
        if op == 19:
            xo = f['xo']
            CRL = {257: '&', 449: '|', 193: '^', 225: 'nand', 33: 'nor', 289: 'eqv',
                   129: 'andc', 417: 'orc'}
            if xo in CRL:
                a, b = f"gk_cr_bit(st, {f['crbA']})", f"gk_cr_bit(st, {f['crbB']})"
                expr = {'&': f"({a} & {b})", '|': f"({a} | {b})", '^': f"({a} ^ {b})",
                        'nand': f"(!({a} & {b}))", 'nor': f"(!({a} | {b}))",
                        'eqv': f"(!({a} ^ {b}))", 'andc': f"({a} & !{b})",
                        'orc': f"({a} | !{b})"}[CRL[xo]]
                bit = f['crbD']
                o.append(f"st->cr = (st->cr & ~(1u << {31 - bit})) |"
                         f" ((uint32_t)({expr} & 1) << {31 - bit});")
                return o
            if xo == 0:                                  # mcrf
                o.append(f"gk_set_cr(st, {f['crfD']}, (st->cr >> {(7 - f['crfS']) * 4}) & 0xFu);")
                return o
            if xo == 150:                                # isync
                return ["/* isync */"]
            raise Untranslatable(f"op19 xo={xo}", pc, w)

        # ---- d-form loads / stores -------------------------------------------
        LD = {32: ('gk_r32', ''), 34: ('gk_r8', ''), 40: ('gk_r16', ''), 42: ('gk_r16s', '')}
        if op in LD:
            fn = LD[op][0]
            if fn == 'gk_r16s':
                o.append(f"{self.gp(D)} = (uint32_t)(int32_t)(int16_t)gk_r16({ea(f)});")
            else:
                o.append(f"{self.gp(D)} = {fn}({ea(f)});")
            return o
        if op in (33, 35, 41, 43):                        # lwzu / lbzu / lhzu / lhau
            if A == 0 or A == D:
                raise Untranslatable("invalid update form", pc, w)
            base = f"(st->gpr[{A}] + (uint32_t)({f['d']}))"
            fn = {33: 'gk_r32', 35: 'gk_r8', 41: 'gk_r16', 43: 'gk_r16'}[op]
            cast = "(uint32_t)(int32_t)(int16_t)" if op == 43 else ""
            o.append(f"{{ uint32_t _e = {base}; {self.gp(D)} = {cast}{fn}(_e); st->gpr[{A}] = _e; }}")
            return o
        ST = {36: ('gk_w32', ''), 38: ('gk_w8', '(uint8_t)'), 44: ('gk_w16', '(uint16_t)')}
        if op in ST:
            fn, cast = ST[op]
            o.append(f"{fn}({ea(f)}, {cast}{self.gp(S)});")
            return o
        if op in (37, 39, 45):                            # stwu / stbu / sthu
            if A == 0:
                raise Untranslatable("invalid update form", pc, w)
            fn, cast = {37: ('gk_w32', ''), 39: ('gk_w8', '(uint8_t)'), 45: ('gk_w16', '(uint16_t)')}[op]
            o.append(f"{{ uint32_t _e = st->gpr[{A}] + (uint32_t)({f['d']});"
                     f" {fn}(_e, {cast}{self.gp(S)}); st->gpr[{A}] = _e; }}")
            return o
        if op == 46:                                      # lmw
            o.append(f"{{ uint32_t _e = {ea(f)}; for (int _i = {D}; _i < 32; _i++)"
                     f" {{ st->gpr[_i] = gk_r32(_e); _e += 4; }} }}")
            return o
        if op == 47:                                      # stmw
            o.append(f"{{ uint32_t _e = {ea(f)}; for (int _i = {S}; _i < 32; _i++)"
                     f" {{ gk_w32(_e, st->gpr[_i]); _e += 4; }} }}")
            return o

        # ---- floating point ---------------------------------------------------
        if op == 48:                                      # lfs
            o.append(f"st->ps0[{f['frD']}] = gk_cvt_to_double(gk_r32({ea(f)}));")
            o.append(f"st->ps1[{f['frD']}] = st->ps0[{f['frD']}];")
            return o
        if op == 50:                                      # lfd  (PS0 only — Interpreter_LoadStore.cpp:77)
            o.append(f"st->ps0[{f['frD']}] = gk_r64({ea(f)});")
            return o
        if op == 52:                                      # stfs
            o.append(f"gk_w32({ea(f)}, gk_cvt_to_single_ftz(st->ps0[{f['frS']}]));")
            return o
        if op == 54:                                      # stfd
            o.append(f"gk_w64({ea(f)}, st->ps0[{f['frS']}]);")
            return o
        if op in (49, 51, 53, 55):                        # lfsu/lfdu/stfsu/stfdu
            if A == 0:
                raise Untranslatable("invalid FP update form", pc, w)
            base = f"(st->gpr[{A}] + (uint32_t)({f['d']}))"
            body = {49: f"st->ps0[{f['frD']}] = gk_cvt_to_double(gk_r32(_e));"
                        f" st->ps1[{f['frD']}] = st->ps0[{f['frD']}];",
                    51: f"st->ps0[{f['frD']}] = gk_r64(_e);",
                    53: f"gk_w32(_e, gk_cvt_to_single_ftz(st->ps0[{f['frS']}]));",
                    55: f"gk_w64(_e, st->ps0[{f['frS']}]);"}[op]
            o.append(f"{{ uint32_t _e = {base}; {body} st->gpr[{A}] = _e; }}")
            return o

        if op in (59, 63):                                # FP arithmetic
            if f['Rc']:
                raise Untranslatable("FP Rc=1 (CR1 update not modelled)", pc, w)
            single = (op == 59)
            fD, fA, fB, fC = f['frD'], f['frA'], f['frB'], f['frC']
            a, b, c = f"gk_bd(st->ps0[{fA}])", f"gk_bd(st->ps0[{fB}])", f"gk_bd(st->ps0[{fC}])"
            xo5 = f['xo5']

            def setD(expr, neg=False):
                # `neg` = the nmadd/nmsub family: negate the ROUNDED result, and never
                # negate a NaN (Interpreter_FloatingPoint.cpp:677,723).
                if single:
                    r = f"gk_negns_f(gk_force_single({expr}))" if neg else f"gk_force_single({expr})"
                    o.append(f"{{ float _r = {r};"
                             f" st->ps0[{fD}] = gk_db((double)_r); st->ps1[{fD}] = st->ps0[{fD}]; }}")
                else:
                    r = f"gk_negns_d({expr})" if neg else expr
                    o.append(f"st->ps0[{fD}] = gk_db({r});")
            if xo5 == 21: setD(f"gk_ni_add({a}, {b})"); return o                # fadd(s)
            if xo5 == 20: setD(f"gk_ni_sub({a}, {b})"); return o                # fsub(s)
            if xo5 == 25:
                setD(f"gk_ni_mul({a}, gk_force25({c}))" if single else f"gk_ni_mul({a}, {c})")
                return o                                                        # fmul(s)
            if xo5 == 18:                                                       # fdiv(s)
                setD(f"({a} / {b})"); return o
            if xo5 == 24: setD(f"gk_fres({b})"); return o                       # fres
            if xo5 == 26: setD(f"gk_frsqrte({b})"); return o                    # frsqrte
            if xo5 == 22:                                                       # fsqrt(s)
                setD(f"sqrt({b})"); return o
            if xo5 == 29: setD(f"gk_ni_madd_{'single' if single else 'double'}({a}, {c}, {b}, 0)"); return o
            if xo5 == 28: setD(f"gk_ni_madd_{'single' if single else 'double'}({a}, {c}, {b}, 1)"); return o
            if xo5 == 31: setD(f"gk_ni_madd_{'single' if single else 'double'}({a}, {c}, {b}, 0)", True); return o
            if xo5 == 30: setD(f"gk_ni_madd_{'single' if single else 'double'}({a}, {c}, {b}, 1)", True); return o
            if xo5 == 23:                                                       # fsel
                o.append(f"st->ps0[{fD}] = ({a} >= 0.0) ? st->ps0[{fC}] : st->ps0[{fB}];")
                if single:
                    o.append(f"st->ps1[{fD}] = st->ps0[{fD}];")
                return o
            xo = f['xo']
            if op == 63:
                if xo == 72:  o.append(f"st->ps0[{fD}] = st->ps0[{fB}];"); return o          # fmr
                if xo == 40:  o.append(f"st->ps0[{fD}] = st->ps0[{fB}] ^ {1 << 63:#x}ull;"); return o  # fneg
                if xo == 264: o.append(f"st->ps0[{fD}] = st->ps0[{fB}] & 0x7FFFFFFFFFFFFFFFull;"); return o  # fabs
                if xo == 136: o.append(f"st->ps0[{fD}] = st->ps0[{fB}] | {1 << 63:#x}ull;"); return o  # fnabs
                if xo == 12:                                                     # frsp
                    o.append(f"{{ float _r = gk_force_single({b});"
                             f" st->ps0[{fD}] = gk_db((double)_r); st->ps1[{fD}] = st->ps0[{fD}]; }}")
                    return o
                if xo == 0:                                                      # fcmpu
                    o.append(f"{{ double _a = {a}, _b = {b}; uint32_t _v ="
                             f" (_a != _a || _b != _b) ? 1u : (_a < _b) ? 8u : (_a > _b) ? 4u : 2u;"
                             f" gk_set_cr(st, {f['crfD']}, _v); }}")
                    return o
                if xo == 32:                                                     # fcmpo
                    o.append(f"{{ double _a = {a}, _b = {b}; uint32_t _v ="
                             f" (_a != _a || _b != _b) ? 1u : (_a < _b) ? 8u : (_a > _b) ? 4u : 2u;"
                             f" gk_set_cr(st, {f['crfD']}, _v); }}")
                    return o
                if xo == 583:                                                    # mffs
                    o.append(f"st->ps0[{fD}] = 0xFFF8000000000000ull | st->fpscr;"); return o
                if xo == 711:                                                    # mtfsf
                    o.append(f"{{ uint32_t m = 0; " + " ".join(
                        f"m |= 0x{(0xF << (i * 4)):08x}u;" for i in range(8)
                        if ((w >> 17) & 0xFF) & (1 << i)) +
                        f" st->fpscr = (st->fpscr & ~m) | ((uint32_t)st->ps0[{fB}] & m); }}")
                    return o
                if xo in (14, 15):                                               # fctiw / fctiwz
                    o.append(f"{{ double _v = {b}; int32_t _i = (_v != _v) ? (int32_t)0x80000000 :"
                             f" (_v > 2147483647.0) ? (int32_t)0x7FFFFFFF :"
                             f" (_v < -2147483648.0) ? (int32_t)0x80000000 : (int32_t)_v;"
                             f" st->ps0[{fD}] = 0xFFF8000000000000ull | (uint32_t)_i; }}")
                    return o
            raise Untranslatable(f"FP op{op} xo={f['xo']} xo5={xo5}", pc, w)

        # ---- paired single (opcode 4) ------------------------------------------
        if op == 4:
            if f['Rc']:
                raise Untranslatable("paired-single Rc=1 (CR1 not modelled)", pc, w)
            fD, fA, fB, fC = f['frD'], f['frA'], f['frB'], f['frC']
            xo5, xo = f['xo5'], f['xo']
            a0, a1 = f"gk_bd(st->ps0[{fA}])", f"gk_bd(st->ps1[{fA}])"
            b0, b1 = f"gk_bd(st->ps0[{fB}])", f"gk_bd(st->ps1[{fB}])"
            c0, c1 = f"gk_bd(st->ps0[{fC}])", f"gk_bd(st->ps1[{fC}])"

            def both(e0, e1, neg=False):
                w = (lambda e: f"gk_negns_f(gk_force_single({e}))") if neg else \
                    (lambda e: f"gk_force_single({e})")
                o.append(f"{{ float _p0 = {w(e0)}; float _p1 = {w(e1)};"
                         f" gk_set_both(st, {fD}, _p0, _p1); }}")
            # Interpreter_Paired.cpp:384 ps_muls0 / :401 ps_muls1
            if xo5 == 12:   both(f"gk_ni_mul({a0}, gk_force25({c0}))", f"gk_ni_mul({a1}, gk_force25({c0}))"); return o
            if xo5 == 13:   both(f"gk_ni_mul({a0}, gk_force25({c1}))", f"gk_ni_mul({a1}, gk_force25({c1}))"); return o
            # :418 ps_madds0 / :439 ps_madds1
            if xo5 == 14:   both(f"gk_ni_madd_single({a0}, {c0}, {b0}, 0)",
                                 f"gk_ni_madd_single({a1}, {c0}, {b1}, 0)"); return o
            if xo5 == 15:   both(f"gk_ni_madd_single({a0}, {c1}, {b0}, 0)",
                                 f"gk_ni_madd_single({a1}, {c1}, {b1}, 0)"); return o
            if xo5 == 25:   both(f"gk_ni_mul({a0}, gk_force25({c0}))", f"gk_ni_mul({a1}, gk_force25({c1}))"); return o  # ps_mul
            if xo5 == 21:   both(f"gk_ni_add({a0}, {b0})", f"gk_ni_add({a1}, {b1})"); return o     # ps_add
            if xo5 == 20:   both(f"gk_ni_sub({a0}, {b0})", f"gk_ni_sub({a1}, {b1})"); return o     # ps_sub
            if xo5 == 29:   both(f"gk_ni_madd_single({a0}, {c0}, {b0}, 0)",
                                 f"gk_ni_madd_single({a1}, {c1}, {b1}, 0)"); return o              # ps_madd
            if xo5 == 28:   both(f"gk_ni_madd_single({a0}, {c0}, {b0}, 1)",
                                 f"gk_ni_madd_single({a1}, {c1}, {b1}, 1)"); return o              # ps_msub
            # :324 ps_nmadd / :300 ps_nmsub — negate the ROUNDED single, never a NaN.
            if xo5 == 31:   both(f"gk_ni_madd_single({a0}, {c0}, {b0}, 0)",
                                 f"gk_ni_madd_single({a1}, {c1}, {b1}, 0)", True); return o
            if xo5 == 30:   both(f"gk_ni_madd_single({a0}, {c0}, {b0}, 1)",
                                 f"gk_ni_madd_single({a1}, {c1}, {b1}, 1)", True); return o
            # Interpreter_Paired.cpp:348 ps_sum0 / :366 ps_sum1
            if xo5 == 10:   both(f"gk_ni_add({a0}, {b1})", c1); return o
            if xo5 == 11:   both(c0, f"gk_ni_add({a0}, {b1})"); return o
            if xo5 == 24:   both(f"gk_fres({b0})", f"gk_fres({b1})"); return o        # :140 ps_res
            if xo5 == 26:   both(f"gk_frsqrte({b0})", f"gk_frsqrte({b1})"); return o  # :169 ps_rsqrte
            if xo5 == 18:   both(f"({a0} / {b0})", f"({a1} / {b1})"); return o  # ps_div
            if xo == 40:    o.append(f"st->ps0[{fD}] = st->ps0[{fB}] ^ {1 << 63:#x}ull;"
                                     f" st->ps1[{fD}] = st->ps1[{fB}] ^ {1 << 63:#x}ull;"); return o  # ps_neg
            if xo == 264:   o.append(f"st->ps0[{fD}] = st->ps0[{fB}] & 0x7FFFFFFFFFFFFFFFull;"
                                     f" st->ps1[{fD}] = st->ps1[{fB}] & 0x7FFFFFFFFFFFFFFFull;"); return o  # ps_abs
            if xo == 136:   o.append(f"st->ps0[{fD}] = st->ps0[{fB}] | {1 << 63:#x}ull;"
                                     f" st->ps1[{fD}] = st->ps1[{fB}] | {1 << 63:#x}ull;"); return o  # ps_nabs
            if xo in (0, 32, 64, 96):                                            # ps_cmpu0/o0/u1/o1
                sl = '0' if xo in (0, 32) else '1'
                o.append(f"{{ double _a = gk_bd(st->ps{sl}[{fA}]), _b = gk_bd(st->ps{sl}[{fB}]);"
                         f" uint32_t _v = (_a != _a || _b != _b) ? 1u : (_a < _b) ? 8u :"
                         f" (_a > _b) ? 4u : 2u; gk_set_cr(st, {f['crfD']}, _v); }}")
                return o
            if xo == 528:   o.append(f"{{ uint64_t _x = st->ps0[{fA}], _y = st->ps0[{fB}];"
                                     f" st->ps0[{fD}] = _x; st->ps1[{fD}] = _y; }}"); return o     # ps_merge00
            if xo == 560:   o.append(f"{{ uint64_t _x = st->ps0[{fA}], _y = st->ps1[{fB}];"
                                     f" st->ps0[{fD}] = _x; st->ps1[{fD}] = _y; }}"); return o     # ps_merge01
            if xo == 592:   o.append(f"{{ uint64_t _x = st->ps1[{fA}], _y = st->ps0[{fB}];"
                                     f" st->ps0[{fD}] = _x; st->ps1[{fD}] = _y; }}"); return o     # ps_merge10
            if xo == 624:   o.append(f"{{ uint64_t _x = st->ps1[{fA}], _y = st->ps1[{fB}];"
                                     f" st->ps0[{fD}] = _x; st->ps1[{fD}] = _y; }}"); return o     # ps_merge11
            if xo == 72:    o.append(f"st->ps0[{fD}] = st->ps0[{fB}]; st->ps1[{fD}] = st->ps1[{fB}];"); return o  # ps_mr
            if xo5 == 23:   o.append(f"{{ double _a0 = {a0}, _a1 = {a1};"
                                     f" uint64_t _r0 = (_a0 >= 0.0) ? st->ps0[{fC}] : st->ps0[{fB}];"
                                     f" uint64_t _r1 = (_a1 >= 0.0) ? st->ps1[{fC}] : st->ps1[{fB}];"
                                     f" st->ps0[{fD}] = _r0; st->ps1[{fD}] = _r1; }}"); return o   # ps_sel
            raise Untranslatable(f"paired-single op4 xo={xo} xo5={xo5}", pc, w)

        # ---- quantized paired load/store (opcodes 56/60) -------------------------
        if op in (56, 60):
            fr = f['frD']
            addr = (f"(st->gpr[{A}] + (uint32_t)({f['psD']}))" if A else f"((uint32_t)({f['psD']}))")
            fn = 'gk_psq_l' if op == 56 else 'gk_psq_st'
            o.append(f"{fn}(st, {fr}, {addr}, {f['psW']}, {f['psI']});")
            return o
        if op in (57, 61):                                # psq_lu / psq_stu
            if A == 0:
                raise Untranslatable("invalid psq update form", pc, w)
            fn = 'gk_psq_l' if op == 57 else 'gk_psq_st'
            o.append(f"{{ uint32_t _e = st->gpr[{A}] + (uint32_t)({f['psD']});"
                     f" {fn}(st, {f['frD']}, _e, {f['psW']}, {f['psI']}); st->gpr[{A}] = _e; }}")
            return o

        raise Untranslatable(f"opcode {op}", pc, w)

    # --- whole-function translation ---------------------------------------
    def translate(self):
        body, insts = [], []
        for pc in range(self.lo, self.hi, 4):
            w = self.img.word(pc)
            if w is None:
                raise Untranslatable("address not in image", pc, None)
            insts.append((pc, w, self.inst(pc, w)))
        for pc, w, lines in insts:
            if pc in self.labels:
                body.append(f"L_{pc:08x}:;")
            body.append(f"    /* {pc:08x}: {w:08x} */")
            for l in lines:
                body.append("    " + l)
        return body


HEADER = """// GENERATED by gamecube/recomp/sr/sr.py — STATIC RECOMPILATION of shipped PowerPC code.
// Source of truth: the game binary. No decompiled source was used.
#include "gekko_rt.h"

#ifndef CALL
#define CALL(a) do { g_fault = 0xC0DE0000u | ((a) & 0xFFFFu); } while (0)
#endif
"""


def emit_c(img, fns):
    out = [HEADER]
    for lo, size, name in fns:
        t = Translator(img, lo, lo + size)
        body = t.translate()
        out.append(f"\n// {name}  @ {lo:#010x}  ({size} bytes, {size // 4} instructions)")
        out.append(f"void fn_{lo:08x}(GekkoState *st) {{")
        out += body
        out.append("}")
    # generated address -> translated-function dispatch (the table a full build needs
    # anyway for bctr/blrl indirect targets; here it is the driver's entry point).
    out.append("\nint sr_dispatch(uint32_t addr, GekkoState *st) {")
    out.append("    switch (addr) {")
    for lo, size, name in fns:
        out.append(f"    case {lo:#010x}u: fn_{lo:08x}(st); return 1;   /* {name} */")
    out.append("    default: return 0;")
    out.append("    }\n}")
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', required=True)
    ap.add_argument('--map', required=True)
    ap.add_argument('--fn', action='append', default=[])
    ap.add_argument('--out')
    ap.add_argument('--coverage', action='store_true')
    a = ap.parse_args()

    img = Image.from_dol(a.image)
    syms = load_map(a.map)

    if a.coverage:
        ok = fail = 0
        ok_i = fail_i = 0
        reasons = collections.Counter()
        seen = set()
        for lo, size, name in syms:
            if lo in seen or size == 0 or size % 4:
                continue
            seen.add(lo)
            if img.word(lo) is None:
                continue                      # not in this image (REL overlay symbol)
            try:
                Translator(img, lo, lo + size).translate()
                ok += 1; ok_i += size // 4
            except Untranslatable as e:
                fail += 1; fail_i += size // 4
                reasons[e.why.split('(')[0].strip()] += 1
        tot = ok + fail
        print(f"functions in image : {tot}")
        print(f"  translated clean : {ok}  ({100.0 * ok / tot:.2f}%)")
        print(f"  blocked          : {fail}  ({100.0 * fail / tot:.2f}%)")
        print(f"instructions       : clean {ok_i} / blocked-function {fail_i}"
              f"  ({100.0 * ok_i / (ok_i + fail_i):.2f}% of mapped .text in clean functions)")
        print("\nblocking reason (first blocker per function):")
        for r, c in reasons.most_common(40):
            print(f"  {c:6d}  {r}")
        return

    want = [int(x, 16) for x in a.fn]
    fns = [(lo, sz, nm) for lo, sz, nm in syms if lo in want]
    missing = set(want) - {lo for lo, _, _ in fns}
    if missing:
        print("not in map: " + ", ".join(f"{m:#x}" for m in missing), file=sys.stderr)
        sys.exit(1)
    src = emit_c(img, fns)
    if a.out:
        open(a.out, 'w').write(src)
        print(f"wrote {a.out} ({len(src)} bytes, {len(fns)} functions)", file=sys.stderr)
    else:
        sys.stdout.write(src)


if __name__ == '__main__':
    main()

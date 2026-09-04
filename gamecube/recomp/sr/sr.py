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
  python3 sr.py --image ... --map ... --fn 0x... --closure --out f.c   # + every callee

NON-LEAF MODEL (--closure), and how it deviates from N64Recomp on purpose
  N64Recomp's CGenerator::emit_function_call (cgenerator.cpp:423) emits only
  `name(rdram, ctx);` and NEVER materialises $ra, so a callee's own `sw $ra,N($sp)`
  prologue stores a stale value.  That is safe there because nothing compares guest
  memory against hardware.  It is NOT safe here: this project's acceptance test is a
  byte-for-byte diff of the ORDERED MEMORY-WRITE LOG against native Dolphin
  (gamecube/tools/native_oracle_gdb.py capture_fixture), and a PowerPC callee's
  standard Metrowerks prologue is `mflr r0 ; stw r0, 0x??(r1)` -- i.e. the link
  register is WRITTEN TO GUEST MEMORY on essentially every non-leaf call.  A stale LR
  therefore shows up as a mismatched store, not as a harmless unused value.
  DECISION: this translator materialises `st->lr = <return address>` before every
  linking branch (bl / bcl), which it already did for the leaf work, and keeps doing.
  The cost is one store per call; the benefit is that the stack frame is bit-exact.

  Control flow: `blr` is a C `return`, so LR is never used as a jump target; it is
  modelled purely as architectural state.  A tail branch out of the function is a
  plain call followed by `return`, with LR left alone -- which is what the hardware
  does, since a non-linking `b` does not touch LR.

  Call targets are VALIDATED: with --closure, a linking or tail branch to an address
  that is not a known function start is Untranslatable rather than silently dispatched
  into the middle of another function.  A call to a function outside the translated
  set becomes `sr_extern()`, which FAULTS -- an untranslated callee can never be
  silently skipped.
"""
import argparse, collections, json, re, struct, sys


class Untranslatable(Exception):
    def __init__(self, why, pc=None, word=None):
        super().__init__(why)
        self.why, self.pc, self.word = why, pc, word


# ==========================================================================
#                      THE CACHE-MAINTENANCE BOUNDARY
# ==========================================================================
# Gekko cache maintenance on a runtime that HAS NO CACHE.  gekko_rt.h maps every
# guest access straight into one flat host buffer (gk_phys masks 26 bits and
# indexes g_ram), there is one bus master, and no address translation.  So a
# CACHE-STATE instruction has no state to change here and a no-op is the FULL
# semantics, not an approximation of them -- with the two exceptions below, which
# are NOT in this table because they are real observable operations:
#
#   dcbz  (op31 xo=1014)  ZEROES a 32-byte line -> gk_dcbz(), a real store.
#   dcbz_l(op4  xo=1014)  the same, into the locked cache, which gekko_rt.h:61-71
#                         establishes is ORDINARY MEMORY here with a real backing
#                         buffer.  Also a real store.
#
# ⚠ WHAT A NO-OP DOES NOT REPRODUCE, stated rather than implied.  `dcbi` DISCARDS
# a cache line WITHOUT writing it back.  On real hardware a dirty line dropped by
# dcbi loses the CPU's writes and memory keeps the older value; here there is no
# dirty line and the writes survive.  Every dcbi site in SAB's main.dol is either
#   (a) DCInvalidateRange 0x800e4e1c, whose callers use it to re-read a buffer a
#       DMA engine wrote -- and this runtime models NO DMA engine, so those callers
#       already read stale data for a reason that has nothing to do with the cache
#       op (the same hole sr_image.c:438-442 names), or
#   (b) LCDisable 0x800e5074 and the locked-cache allocators 0x8014b504 /
#       0x8014b5bc / 0x8014b680 / 0x8014b7ac, which invalidate the normal-cache
#       alias of a line they are about to own in the LOCKED cache -- and the
#       locked cache is modelled as plain memory, so there is no alias to drop.
# Neither is a case where a guest DEPENDS on the discard, and neither is silent:
# the divergence is wrong data from an unmodelled DMA, not a wrong cache model.
#
# The dict is keyed by extended opcode so `--cache-audit` can enumerate exactly
# what this boundary claims, and so a leave-one-out measurement is one deletion
# (see README §9.8): `sr.CACHE_NOP_XO.pop(470)` re-refuses dcbi and nothing else.
CACHE_NOP_XO = {
    54:  'dcbst',    # write back, keep valid          -- data already IS memory
    86:  'dcbf',     # write back + invalidate         -- data already IS memory
    246: 'dcbtst',   # touch-for-store hint            -- pure hint
    278: 'dcbt',     # touch hint                      -- pure hint
    470: 'dcbi',     # invalidate WITHOUT writeback    -- see the ⚠ above
    598: 'sync',     # storage barrier, one bus master, one thread
    854: 'eieio',    # storage-ordering barrier, same
    982: 'icbi',     # instruction-cache invalidate    -- see the note below
    # 1010 is inherited from the hint list this table replaced and is NOT named
    # here because I could not ground it: it is unassigned in the 750 user manual
    # and it OCCURS ZERO TIMES in SAB's main.dol (measured over all 4,741 recovered
    # boundaries, alongside 0 sites for tlbsync/566, tlbia/370 and tw/4).  Kept so
    # this change moves no REL-side behaviour, labelled by number rather than by a
    # mnemonic I would be inventing.
    1010:'op31 xo=1010 (unassigned; 0 sites in main.dol)',
}
# icbi deserves its own sentence: it is what a guest calls after WRITING code.  A
# static recompiler cannot execute newly-written guest code whether or not the
# icache is flushed, so the no-op is not what makes SMC unsupported -- the
# translation model is.  Overlay (REL) code is translated ahead of time by rel.py,
# not discovered at run time through this instruction.

# Leave-one-out seams for the other two halves of the same boundary.  Each False
# restores exactly the pre-boundary refusal for that ONE instruction class and
# nothing else, which is how the +N attributable to each is measured separately --
# and the measurement showed the three are NOT independent (README §9.8).
SC_EMIT     = True    # `sc`   (op 17)              -> gk_sc(),   gekko_rt.h
DCBZ_L_EMIT = True    # dcbz_l (op4 xo=1014 xo5=22) -> gk_dcbz(), gekko_rt.h


# ==========================================================================
#                   THE DRIVE — RETIRED GUEST CYCLES
# ==========================================================================
# Under --retire, every emitted BASIC BLOCK opens with `gk_retire(N)` where N is the
# summed Gekko cycle cost of the instructions in it.  That counter (g_gk_cycles) is
# the ONLY input to guest time; see the long note beside gk_retire() in gekko_rt.h
# for why a host clock in its place is a gate #9 bug rather than a shortcut.
#
# THE COSTS BELOW ARE NOT INVENTED.  They are Dolphin's `num_cycles` field,
# transcribed from Source/Core/Core/PowerPC/PPCTables.cpp -- the same field its
# interpreter returns per instruction (Interpreter.cpp:193) and its JIT accumulates
# per instruction into the block downcount (Jit64/Jit.cpp:1003), which is in turn
# what feeds CoreTiming::GetTicks() and therefore GetFakeTimeBase.  Using anything
# else would make our guest clock disagree with the differential oracle's.
#
# 203 of the 243 table entries cost 1, so only the exceptions are listed.  To
# re-derive: parse the `{opcode, "name", OpType::T, num_cycles, flags}` rows out of
# the five tables in PPCTables.cpp and keep num_cycles != 1.  The table layout is
# PPCTables.cpp:526-600: s_table4_2 and s_table63_2 replicate over the low 5 bits of
# the extended opcode (hence the _XO5 dicts), s_table4_3 over the low 6, and the
# rest index the full 10-bit xo.  s_table59 is a 32-entry xo5 table.
GK_CYCLES_PRIMARY = {7: 3,      # mulli
                     17: 2,     # sc
                     46: 11,    # lmw
                     47: 11}    # stmw
GK_CYCLES_T4_XO5  = {18: 17,    # ps_div
                     26: 2}     # ps_rsqrte
GK_CYCLES_T19_XO  = {50: 2}     # rfi
GK_CYCLES_T31_XO  = {4: 2,      # tw
                     11: 5, 75: 5, 235: 5, 747: 5,          # mulhwux/mulhwx/mullwx/o
                     54: 5, 86: 5, 470: 5, 758: 5, 1014: 5, # dcbst/dcbf/dcbi/dcba/dcbz
                     246: 2, 278: 2,                        # dcbtst / dcbt
                     459: 40, 491: 40, 971: 40, 1003: 40,   # divwux/divwx + OE forms
                     467: 2,                                # mtspr
                     982: 4,                                # icbi
                     595: 3, 659: 3, 598: 3}                # mfsr / mfsrin / sync
GK_CYCLES_T59_XO5 = {18: 17}    # fdivsx
GK_CYCLES_T63_XO  = {38: 3, 70: 3, 134: 3, 711: 3}   # mtfsb1x/mtfsb0x/mtfsfix/mtfsfx
GK_CYCLES_T63_XO5 = {18: 31}    # fdivx
# ⚠ dcbz_l (op4 xo=1014) is ONE cycle in Dolphin's table (s_table4), while dcbz
# (op31 xo=1014) is FIVE.  Transcribed as found rather than "corrected": the point of
# using the oracle's table is that our guest clock and its guest clock agree.


def gk_cycles(w):
    """Gekko cycle cost of one instruction word — Dolphin's num_cycles."""
    op = w >> 26
    xo, xo5 = (w >> 1) & 0x3FF, (w >> 1) & 0x1F
    if op == 4:
        # No exact-xo entry in s_table4 costs anything but 1, and none of them is
        # congruent to 18 or 26 mod 32 (Dolphin ASSERTs the sub-tables are disjoint
        # while building table4), so the xo5 test alone is unambiguous here.
        return GK_CYCLES_T4_XO5.get(xo5, 1)
    if op == 19:
        return GK_CYCLES_T19_XO.get(xo, 1)
    if op == 31:
        return GK_CYCLES_T31_XO.get(xo, 1)
    if op == 59:
        return GK_CYCLES_T59_XO5.get(xo5, 1)
    if op == 63:
        return GK_CYCLES_T63_XO.get(xo, GK_CYCLES_T63_XO5.get(xo5, 1))
    return GK_CYCLES_PRIMARY.get(op, 1)


def ends_block(w):
    """True if control MAY leave the straight line after this instruction.

    LK=1 forms (bl / bcl / bctrl / blrl) are CALLS: control comes back to pc+4, so
    they do NOT end the block.  `sc` does not end one either -- gk_sc() returns.
    Getting this wrong in the permissive direction OVER-CREDITS: a `blelr` in the
    middle of DCFlushRange (OSCache.c:90) can return before the loop runs, and a
    block credited at its head would have charged the guest for a loop it skipped.
    """
    op, xo, lk = w >> 26, (w >> 1) & 0x3FF, w & 1
    if lk:
        return False
    return op in (16, 18) or (op == 19 and xo in (16, 528))


RETIRE = False   # --retire; off by default so no existing artifact changes


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
    def __init__(self, img, fn_lo, fn_hi, resolve_call=None, starts=None, emitted=None,
                 branch_reloc=None, indirect=False, jumptables=False):
        self.img, self.lo, self.hi = img, fn_lo, fn_hi
        self.resolve_call = resolve_call
        # INDIRECT DISPATCH (blrl / bctr / bctrl).  Off by default so the historical
        # coverage numbers stay comparable.  When on, an indirect branch becomes a
        # runtime address->function lookup through sr_indirect(), which FAULTS on an
        # address that is not a translated function start rather than falling through.
        # That is deliberately conservative: a `bctr` into a SWITCH TABLE targets a
        # point INSIDE a function, which is not a dispatchable entry, so those fault
        # loudly until static jump-table recovery exists (N64Recomp analysis.cpp:229-334).
        self.indirect = indirect
        # REL OVERLAYS: a branch at a REL24 relocation site is a PLACEHOLDER in the
        # shipped bytes (typically `48000001`, i.e. `bl .`).  Decoding it as written
        # produces a self-call.  `branch_reloc` maps such a pc to the target the
        # relocation names, which for a reference into the static DOL is an absolute
        # address and therefore fully known ahead of time (OSLink.c:139-142 sets
        # offset = 0 for imp->id == 0, so x = addend).
        self.branch_reloc = branch_reloc or {}
        # `starts`  : every known function entry (None = permissive; used by --coverage
        #             so its historical numbers stay comparable).
        # `emitted` : the subset actually being translated into this C file.  A call to
        #             a start outside `emitted` becomes sr_extern() = a hard fault.
        self.starts = starts
        self.emitted = emitted
        # STATIC JUMP-TABLE RECOVERY for `bctr`.  Off by default so the historical
        # --indirect numbers stay comparable; --jumptables turns it on.  Every one of
        # SAB's 147 bctr sites is a switch table (lwzx -> mtctr -> bctr), so without
        # this they ALL fault at run time and the 123 functions containing them --
        # 65,401 instructions -- are translated but not runtime-complete.
        self.jumptables = jumptables
        self.jt_recovered = {}       # bctr pc -> [target, ...]
        self.jt_refused = {}         # bctr pc -> why
        self.labels = set()
        self.calls = set()

    # --- helpers -----------------------------------------------------------
    def gp(self, r):
        return f"st->gpr[{r}]"

    def callexpr(self, tgt, pc, w):
        """C text for transferring control to another function.

        With `starts` supplied this REFUSES a target that is not a function entry:
        dispatching into the middle of a function would produce plausible-looking
        output with the callee's prologue skipped."""
        self.calls.add(tgt)
        if self.starts is not None and tgt not in self.starts:
            raise Untranslatable(f"branch target {tgt:#010x} is not a function start", pc, w)
        if self.emitted is not None and tgt not in self.emitted:
            return f"sr_extern(st, {tgt:#010x}u);"
        if self.emitted is None:
            return f"CALL({tgt:#010x}u);"
        return f"fn_{tgt:08x}(st);"

    def recover_jump_table(self, pc):
        """Static switch-table recovery for a `bctr`.  -> [targets] or None.

        SHAPE, uniform across SAB's DOL (147 of 147 bctr sites match it):
            cmplwi crX, rIdx, N            bound check
            bc BO=12, BI=4X+1, default     leave when rIdx > N, so cases are 0..N
            lis    rB, HI                  \\ the base is often materialised into a
            addi   rT, rB, LO              /  DIFFERENT register than lis wrote
            rlwinm rJ, rIdx, 2, 0, 29      index * 4
            lwzx   rS, rT, rJ
            mtctr  rS
            bctr
        This is the same recovery N64Recomp does (analysis.cpp:229-334).

        REFUSES rather than guesses.  Every recovered target must be 4-byte aligned
        and must land either INSIDE this function (emitted as a label) or exactly on
        a known function start (emitted as a tail call).  Measured over the whole
        DOL: 145 of 147 sites recover with all 3,983 targets resolvable -- 3,969
        in-function, 14 on another function start, and ZERO mid-other-function,
        misaligned, or outside any mapped function.  The 2 refusals both load the
        table base from memory (`lwz`) rather than materialising it.
        """
        def back(frm, want_def, limit=48):
            return range(frm, max(self.lo - 4, frm - 4 * limit), -4)

        def word(p):
            return self.img.word(p)

        # mtctr rS
        rs = mt = None
        for p in back(pc - 4, None):
            x = word(p)
            if x is None:
                return None
            if (x >> 26) == 31 and ((x >> 1) & 0x3FF) == 467 and \
                    ((((x >> 16) & 0x1F) | (((x >> 11) & 0x1F) << 5)) == 9):
                rs, mt = (x >> 21) & 0x1F, p
                break
        if rs is None:
            self.jt_refused[pc] = "no mtctr"
            return None
        # lwzx rS, rT, rJ
        rt = lw = None
        for p in back(mt - 4, None):
            x = word(p)
            if x is None:
                return None
            if (x >> 26) == 31 and ((x >> 1) & 0x3FF) == 23 and ((x >> 21) & 0x1F) == rs:
                rt, lw = (x >> 16) & 0x1F, p
                break
        if rt is None:
            self.jt_refused[pc] = "no lwzx feeding mtctr"
            return None
        # table base: follow the def chain of rT back through addi/addis to lis/li
        base, acc, want, p = None, 0, rt, lw - 4
        limit = max(self.lo - 4, lw - 4 * 48)
        while p > limit:
            x = word(p)
            if x is None:
                break
            op, D, A = (x >> 26) & 0x3F, (x >> 21) & 0x1F, (x >> 16) & 0x1F
            if D == want:
                simm = x & 0xFFFF
                simm = simm - 0x10000 if simm & 0x8000 else simm
                if op == 14 and A == 0:
                    base = acc + simm
                    break
                if op == 15 and A == 0:
                    base = acc + ((x & 0xFFFF) << 16)
                    break
                if op == 14:
                    acc += simm
                    want = A
                elif op == 15:
                    acc += (x & 0xFFFF) << 16
                    want = A
                else:
                    self.jt_refused[pc] = f"table base r{want} defined by op{op}"
                    return None
            p -= 4
        if base is None:
            self.jt_refused[pc] = "no lis/addi forming the table base"
            return None
        base &= 0xFFFFFFFF
        # bound: the nearest cmplwi before the load
        n = None
        for p in back(lw - 4, None):
            x = word(p)
            if x is None:
                break
            if (x >> 26) == 10:                     # cmplwi rA, N -> cases 0..N
                n = x & 0xFFFF
                break
            if (x >> 26) == 31 and ((x >> 1) & 0x3FF) == 32:
                self.jt_refused[pc] = "register-form bound (cmplw)"
                return None
        if n is None:
            self.jt_refused[pc] = "no cmplwi bound"
            return None
        if n > 4095:                                # a table that large is not a switch
            self.jt_refused[pc] = f"implausible bound {n}"
            return None
        tgts = []
        for i in range(n + 1):
            v = word(base + 4 * i)
            if v is None:
                self.jt_refused[pc] = f"table word {i} at {base + 4*i:#010x} not in image"
                return None
            tgts.append(v)
        for t in tgts:
            if t & 3:
                self.jt_refused[pc] = f"target {t:#010x} misaligned"
                return None
            if self.lo <= t < self.hi:
                continue
            if self.starts is not None and t in self.starts:
                continue
            self.jt_refused[pc] = (f"target {t:#010x} is neither inside "
                                   f"[{self.lo:#x},{self.hi:#x}) nor a function start")
            return None
        self.jt_recovered[pc] = tgts
        return tgts

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
            if pc in self.branch_reloc:                  # relocated cross-module branch
                tgt = self.branch_reloc[pc]
                if f['LK']:
                    o.append(f"st->lr = {pc + 4:#010x}u;")
                    o.append(self.callexpr(tgt, pc, w))
                else:
                    o.append(self.callexpr(tgt, pc, w) + " return;")
                return o
            tgt = (pc + f['LI']) & 0xFFFFFFFF
            if f['LK']:
                # LR is materialised BEFORE the call: the callee's `mflr r0; stw r0,N(r1)`
                # prologue writes it to guest memory, and that store is diffed.
                o.append(f"st->lr = {pc + 4:#010x}u;")
                o.append(self.callexpr(tgt, pc, w))
            elif self.lo <= tgt < self.hi:
                self.labels.add(tgt)
                o.append(f"goto L_{tgt:08x};")
            else:                                        # tail call: LR untouched by `b`
                o.append(self.callexpr(tgt, pc, w) + " return;")
            return o
        if op == 16:                                     # bc
            if f['AA']:
                raise Untranslatable("absolute conditional branch", pc, w)
            tgt = self.branch_reloc.get(pc, (pc + f['BD']) & 0xFFFFFFFF)
            cond, pre = self.branch_cond(f)
            o += pre
            if f['LK']:
                o.append(f"if ({cond}) {{ st->lr = {pc + 4:#010x}u; "
                         f"{self.callexpr(tgt, pc, w)} }}")
            elif self.lo <= tgt < self.hi:
                self.labels.add(tgt)
                o.append(f"if ({cond}) goto L_{tgt:08x};")
            else:
                o.append(f"if ({cond}) {{ {self.callexpr(tgt, pc, w)} return; }}")
            return o
        if op == 19 and f['xo'] == 16:                   # bclr / blr / blrl
            if f['LK']:
                # blrl: the target is the OLD LR; LR then becomes CIA+4.  Capture the
                # target BEFORE overwriting LR.  PowerPC masks the low two bits of the
                # branch address (PEM 4.2.4.2), so `& ~3`.
                if not self.indirect:
                    raise Untranslatable("blrl (indirect call through LR)", pc, w)
                cond, pre = self.branch_cond(f)
                o += pre
                body = (f"{{ uint32_t _t = st->lr & ~3u; st->lr = {pc + 4:#010x}u;"
                        f" sr_indirect(st, _t); }}")
                o.append(body if cond == "1" else f"if ({cond}) {body}")
                return o
            cond, pre = self.branch_cond(f)
            o += pre
            o.append("return;" if cond == "1" else f"if ({cond}) return;")
            return o
        if op == 19 and f['xo'] == 528:                  # bcctr / bctr / bctrl
            if not self.indirect:
                raise Untranslatable("bctr/bctrl (computed jump / indirect call)", pc, w)
            # CTR is not modified by either form, so the target may be read after the
            # LR write.  BO bit 2 (decrement CTR) is INVALID for this form (PEM
            # 4.2.4.2 "BO[2] must be 1"), so branch_cond's CTR arm must not fire.
            if not (f['BO'] & 4):
                raise Untranslatable("bcctr with CTR-decrement BO (invalid form)", pc, w)
            cond, pre = self.branch_cond(f)
            o += pre
            if f['LK']:                                  # bctrl: a call, execution resumes
                body = (f"{{ st->lr = {pc + 4:#010x}u;"
                        f" sr_indirect(st, st->ctr & ~3u); }}")
                o.append(body if cond == "1" else f"if ({cond}) {body}")
            else:                                        # bctr: a tail jump, LR untouched
                tgts = self.recover_jump_table(pc) if self.jumptables else None
                if tgts:
                    # A RECOVERED SWITCH TABLE.  Dispatch on CTR to the case labels
                    # directly; anything not in the table still falls through to
                    # sr_indirect(), which FAULTS -- a value outside the table means
                    # the bound check was not what we read, and must not be guessed.
                    body = ["{ switch (st->ctr & ~3u) {"]
                    for t in sorted(set(tgts)):
                        if self.lo <= t < self.hi:
                            self.labels.add(t)
                            body.append(f"    case {t:#010x}u: goto L_{t:08x};")
                        else:
                            body.append(f"    case {t:#010x}u: "
                                        f"{self.callexpr(t, pc, w)} return;")
                    body.append("    default: sr_indirect(st, st->ctr & ~3u); return;")
                    body.append("} }")
                    txt = " ".join(body)
                    o.append(txt if cond == "1" else f"if ({cond}) {txt}")
                    return o
                body = "{ sr_indirect(st, st->ctr & ~3u); return; }"
                o.append(body if cond == "1" else f"if ({cond}) {body}")
            return o
        if op == 19 and f['xo'] == 50:
            raise Untranslatable("rfi (privileged)", pc, w)
        if op == 17:
            # `sc` is NOT a call into anything this translator owns: it takes a Gekko
            # SYSTEM CALL exception to 0x80000C00, and what runs there is whatever the
            # guest OS installed.  DOLSDK installs exactly one thing and gk_sc()
            # reproduces its observable effect -- see the long note there.  All three
            # `sc` sites in SAB's main.dol are the SDK's own store barrier: PPCSync
            # 0x800e34c4, DCFlushRange 0x800e4e4c, DCStoreRange 0x800e4e80.
            if not SC_EMIT:
                raise Untranslatable("sc (system call)", pc, w)
            o.append("gk_sc(st);")
            return o

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
            if xo == 266:                                # add
                o.append(f"{self.gp(D)} = {self.gp(A)} + {self.gp(B)};")
                rc(D); return o
            if xo == 10:                                 # addc — SETS XER[CA]
                # FOUND BY EXECUTION, not by inspection (verify_clock.mjs arm C).
                # `addc` used to share the `add` arm above and emit a plain `+`, so it
                # never produced the carry -- while `adde` one line down has always
                # CONSUMED XER[CA] correctly.  A 64-bit add compiled as the canonical
                # `addc rLO; adde rHI` pair therefore lost the carry silently and was
                # wrong by exactly 1 in the high word, only when the low halves
                # actually carried.  `subfc` (xo=8) and `addic`/`addic.` (op 12/13)
                # were already right, which is what makes this an omission rather than
                # a modelling decision.  The instruction that exposed it is
                # 0x800ecb98 in __OSGetSystemTime -- reachable only once the timebase
                # boundary existed, because its closure runs through OSGetTime.
                o.append(f"{{ uint64_t t = (uint64_t){self.gp(A)} + (uint64_t){self.gp(B)};"
                         f" st->xer = (st->xer & ~0x20000000u) | ((t >> 32) ? 0x20000000u : 0u);"
                         f" {self.gp(D)} = (uint32_t)t; }}")
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
            # --- cache maintenance: no state to change on ONE flat coherent buffer.
            # The table and the reasoning (including what dcbi does NOT reproduce)
            # live at CACHE_NOP_XO, top of file.
            if xo in CACHE_NOP_XO:
                return [f"/* {CACHE_NOP_XO[xo]} (no cache on flat host RAM) */"]
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
                # STRUCTURED EXACTLY LIKE THE REFERENCE INTERPRETER
                # (Interpreter_Integer.cpp:326-351).  The previous form clamped the
                # shift to 31 and tested the low `sh` bits, which is right for
                # amount 0..31 but WRONG for a shift of 32 or more: the hardware
                # shifts every bit out, so CA is just the sign bit, whereas the
                # clamped test asks whether bits 0..30 are set and answers NO for
                # rS = 0x80000000 -- the one negative value with no other bit set.
                # Caught by the stg13D-scene fixture 0x8010334c, which matched on
                # every GPR/FPR/CR/LR/CTR, all 66 write events and all 84 final
                # memory bytes, and differed ONLY in XER[CA].
                o.append(f"{{ uint32_t rb = {self.gp(B)}; int32_t rrs = (int32_t){self.gp(S)};"
                         f" uint32_t ca;"
                         f" if (rb & 0x20u) {{ ca = (rrs < 0) ? 0x20000000u : 0u;"
                         f" {self.gp(A)} = (rrs < 0) ? 0xFFFFFFFFu : 0u; }}"
                         f" else {{ uint32_t amt = rb & 0x1fu;"
                         f" ca = (rrs < 0 && amt > 0 &&"
                         f" ((uint32_t)rrs << (32 - amt)) != 0) ? 0x20000000u : 0u;"
                         f" {self.gp(A)} = (uint32_t)(rrs >> amt); }}"
                         f" st->xer = (st->xer & ~0x20000000u) | ca; }}")
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
            # ---- indexed-with-update load/store (x-form) ---
            # Same shape as the validated d-form update handling below (ops 33/35/41/43
            # and 37/39/45): compute EA once, do the access, then write EA back to rA.
            # PowerPC leaves the update forms INVALID when rA==0, and for loads also
            # when rA==rD, so those stay Untranslatable rather than guessing.
            LSUX = {55: 'gk_r32', 119: 'gk_r8', 311: 'gk_r16', 375: 'gk_r16s'}
            if xo in LSUX:                               # lwzux/lbzux/lhzux/lhaux
                if A == 0 or A == D:
                    raise Untranslatable("invalid update form", pc, w)
                fn = LSUX[xo]
                rhs = (f"(uint32_t)(int32_t)(int16_t)gk_r16(_e)" if fn == 'gk_r16s'
                       else f"{fn}(_e)")
                o.append(f"{{ uint32_t _e = {ea_x(f)}; {self.gp(D)} = {rhs};"
                         f" st->gpr[{A}] = _e; }}")
                return o
            STUX = {183: ('gk_w32', ''), 247: ('gk_w8', '(uint8_t)'),
                    439: ('gk_w16', '(uint16_t)')}
            if xo in STUX:                               # stwux/stbux/sthux
                if A == 0:
                    raise Untranslatable("invalid update form", pc, w)
                fn, cast = STUX[xo]
                o.append(f"{{ uint32_t _e = {ea_x(f)}; {fn}(_e, {cast}{self.gp(S)});"
                         f" st->gpr[{A}] = _e; }}")
                return o
            FPUX = {567: f"st->ps0[{f['frD']}] = gk_cvt_to_double(gk_r32(_e));"
                        f" st->ps1[{f['frD']}] = st->ps0[{f['frD']}];",   # lfsux
                    631: f"st->ps0[{f['frD']}] = gk_r64(_e);",            # lfdux (PS0 only)
                    695: f"gk_w32(_e, gk_cvt_to_single_ftz(st->ps0[{f['frS']}]));",  # stfsux
                    759: f"gk_w64(_e, st->ps0[{f['frS']}]);"}             # stfdux
            if xo in FPUX:
                if A == 0:
                    raise Untranslatable("invalid FP update form", pc, w)
                o.append(f"{{ uint32_t _e = {ea_x(f)}; {FPUX[xo]} st->gpr[{A}] = _e; }}")
                return o
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
            # What is LEFT after CACHE_NOP_XO and dcbz: the MMU ops and the trap.  No
            # MMU is modelled (gk_phys is a mask, not a translation), so tlbie/tlbia/
            # tlbsync cannot be no-ops -- a guest that remaps something and continues
            # would be silently wrong.  `tw`/`twi` is a trap: it BRANCHES to 0x700 on
            # its condition, which no part of this runtime can deliver.  All four
            # occur ZERO times in SAB's main.dol; they are refused, not emitted.
            if xo in (4, 306, 370, 566):
                raise Untranslatable(f"MMU/trap op x{xo} (no MMU, no exceptions)", pc, w)
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
                    # THE NEGATIVE-ZERO BIT.  Interpreter_FloatingPoint.cpp:135-137:
                    #     u64 result = 0xfff8000000000000ull | value;
                    #     if (value == 0 && std::signbit(b)) result |= 0x100000000ull;
                    #     // "Based on HW tests"
                    # i.e. a small NEGATIVE operand that truncates to integer 0 is
                    # distinguishable from +0 in the undefined high word.  Omitting
                    # this arm was a real divergence found BY EXECUTION, not by
                    # inspection: SAB 0x80023ba0 stores the fctiwz result with `stfd`
                    # (0x801115e8 fctiwz f0,f0 ; 0x801115ec stfd f0,0x10(r1)), so the
                    # high word reaches GUEST MEMORY and the ordered write log caught
                    # it -- oracle 0xFFF8000100000000 against our 0xFFF8000000000000,
                    # one byte in 495 write events.  620 fctiwz sites in 264 DOL
                    # functions are exposed to it.
                    o.append(f"{{ double _v = {b}; int32_t _i = (_v != _v) ? (int32_t)0x80000000 :"
                             f" (_v > 2147483647.0) ? (int32_t)0x7FFFFFFF :"
                             f" (_v < -2147483648.0) ? (int32_t)0x80000000 : (int32_t)_v;"
                             f" uint64_t _r = 0xFFF8000000000000ull | (uint32_t)_i;"
                             f" if ((uint32_t)_i == 0u && signbit(_v)) _r |= 0x100000000ull;"
                             f" st->ps0[{fD}] = _r; }}")
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
            # dcbz_l -- NOT a paired-single arithmetic op; it shares opcode 4 only by
            # encoding.  It is the LOCKED-CACHE half of dcbz and it is a REAL STORE,
            # not a hint: ~/gc_refs/dolsdk2001/src/os/OSCache.c:349-352 `_lockloop`
            # is how __LCEnable ESTABLISHES the lock, 512 lines x 32 B at 0xE0000000,
            # after which the program reads and writes that memory with plain
            # lwz/stw/psq_l/psq_st.  gekko_rt.h:61-71 already models that window as a
            # real backing buffer (Dolphin does the same, MMU.cpp:246-253 / :437-442
            # into m_l1_cache), and gk_dcbz already routes through GK_MAP, so this is
            # the SAME statement op31 dcbz emits -- it was simply never wired up on
            # this opcode, which made every function containing one unbuildable.
            if xo == 1014 and xo5 == 22 and DCBZ_L_EMIT:
                o.append(f"gk_dcbz({ea_x(f)});")
                return o
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

    @staticmethod
    def terminates(w):
        """True if this instruction cannot fall through to the next address."""
        op = w >> 26
        if op == 18 and not (w & 1):                 # b / ba (not bl)
            return True
        if op == 19 and ((w >> 1) & 0x3FF) == 16 and not (w & 1):
            bo = (w >> 21) & 31                      # blr, unconditional form only
            return (bo & 20) == 20
        return False

    # --- whole-function translation ---------------------------------------
    def translate(self):
        body, insts = [], []
        for pc in range(self.lo, self.hi, 4):
            w = self.img.word(pc)
            if w is None:
                raise Untranslatable("address not in image", pc, None)
            insts.append((pc, w, self.inst(pc, w)))
        # FALL-THROUGH.  A function whose last instruction can fall through continues
        # into the next one; in C that would instead `return`.  Emitting an explicit
        # tail call to the next entry fixes it AND makes function boundaries robust:
        # splitting one guest function into two is then semantically neutral, which
        # matters enormously for REL overlays, where there is no symbol map and the
        # boundaries are inferred.
        if insts and not self.terminates(insts[-1][1]):
            last_pc, last_w, _ = insts[-1]
            insts.append((self.hi, None,
                          [self.callexpr(self.hi, last_pc, last_w) + " return;"]))
        # --- THE DRIVE.  One gk_retire() per BASIC BLOCK, carrying the summed Gekko
        # cycle cost of the instructions in it (see "THE DRIVE" at the top of this
        # file).  Blocks are cut at self.lo, at every label (so a `goto` INTO the
        # middle of a body still credits what it is about to run), and after every
        # instruction that may transfer control -- which is what keeps a conditional
        # early-out from being charged for the loop it skipped.  Instructions in a
        # block that is never entered are never credited, which is the whole reason
        # this is per-block and not per-function.
        credit = {}
        if RETIRE:
            heads, prev_exit = {self.lo}, False
            for pc, w, _ in insts:
                if prev_exit or pc in self.labels:
                    heads.add(pc)
                prev_exit = w is not None and ends_block(w)
            head = None
            for pc, w, _ in insts:
                if head is None or pc in heads:
                    head = pc
                    credit[head] = 0
                if w is not None:
                    credit[head] += gk_cycles(w)
        for pc, w, lines in insts:
            if pc in self.labels:
                body.append(f"L_{pc:08x}:;")
            if credit.get(pc):
                body.append(f"    gk_retire({credit[pc]});")
            body.append(f"    /* {pc:08x}: {w:08x} */" if w is not None
                        else f"    /* {pc:08x}: fall-through to the next entry */")
            for l in lines:
                body.append("    " + l)
        return body


HEADER = """// GENERATED by gamecube/recomp/sr/sr.py — STATIC RECOMPILATION of shipped PowerPC code.
// Source of truth: the game binary. No decompiled source was used.
#include "gekko_rt.h"

#ifndef CALL
#define CALL(a) do { g_fault = 0xC0DE0000u | ((a) & 0xFFFFu); } while (0)
#endif

// A call to a function that was NOT translated into this file. It faults — an
// untranslated callee must never be silently skipped (that would leave the caller's
// output "nearly right" and hide the hole).
void sr_extern(GekkoState *st, uint32_t addr);

// INDIRECT DISPATCH (blrl / bctr / bctrl): a runtime guest-address -> translated-function
// lookup, the shape N64Recomp calls LOOKUP_FUNC (~/gc_refs/N64Recomp/include/recomp.h:450).
// It FAULTS on an address that is not a translated function start — notably a `bctr`
// into a switch table, whose target is INSIDE a function and therefore not an entry.
void sr_indirect(GekkoState *st, uint32_t addr);
"""


def index_functions(img, syms):
    """map entries present in THIS image, deduped by address -> (size, name)."""
    out = {}
    for lo, size, name in syms:
        if lo in out or size == 0 or size % 4:
            continue
        if img.word(lo) is None:
            continue                          # REL-overlay symbol, not in the DOL
        out[lo] = (size, name)
    return out


def recover_boundaries(img, syms, policy='asis', log=None):
    """Function-boundary recovery.  -> sorted [(lo, size, name)].

    Dolphin's symbol map is produced by a BLR SCAN: every entry ends at the next `blr`.
    A function containing an early-exit `blr` therefore emits SEVERAL NESTED entries
    that all share one end.  Measured on dolphin_captures/sab.map: 100 overlapping
    adjacent pairs, 163,236 bytes = 9.82% of the summed entry sizes counted twice, so
    any instruction-weighted figure taken off the raw map is inflated by that much.

      asis         the raw map.
      clip         end := next start.  THE INTUITIVE FIX AND THE WRONG ONE: it truncates
                   the real (outer) function, whose own backward branches then escape
                   its extent.  Measured 960 mid-function branch targets vs 338 for
                   `asis` — it makes the problem worse.  Kept so that stays reproducible.
      outer        drop any entry starting strictly inside a kept entry.  106.
      outer+calls  `outer`, then split at every interior direct-`bl` target so no call
                   lands mid-function.  4.  This is the policy the emitter should use.
    """
    say = log if log is not None else (lambda *a: None)
    units, seen = [], set()
    for lo, size, name in syms:
        if lo in seen or size == 0 or size % 4:
            continue
        seen.add(lo)
        if img.word(lo) is None:
            continue                          # REL-overlay symbol, not in this image
        units.append((lo, size, name))
    units.sort()

    if policy == 'asis':
        return units
    if policy == 'clip':
        fixed, clipped = [], 0
        for i, (lo, size, name) in enumerate(units):
            end = lo + size
            if i + 1 < len(units) and end > units[i + 1][0]:
                clipped += end - units[i + 1][0]
                end = units[i + 1][0]
            if end > lo:
                fixed.append((lo, end - lo, name))
        say(f"[boundaries=clip] clipped {clipped} overlapping bytes")
        return fixed
    if policy not in ('outer', 'outer+calls'):
        raise ValueError(f"unknown boundary policy {policy!r}")

    kept, dropped = [], 0
    for lo, size, name in units:
        if kept and lo < kept[-1][0] + kept[-1][1]:
            dropped += 1                      # starts inside a kept entry -> spurious
            continue
        kept.append((lo, size, name))
    say(f"[boundaries={policy}] dropped {dropped} nested entries "
        f"({len(units)} -> {len(kept)})")
    if policy == 'outer':
        return kept

    tg = set()
    for lo, size, _ in kept:
        for pc in range(lo, lo + size, 4):
            w = img.word(pc)
            if w is None or (w >> 26) != 18 or not (w & 1) or ((w >> 1) & 1):
                continue                      # not a relative `bl`
            li = (w & 0x03FFFFFC) - (0x04000000 if w & 0x02000000 else 0)
            tg.add((pc + li) & 0xFFFFFFFF)
    starts0 = {lo for lo, _, _ in kept}
    cuts = collections.defaultdict(list)
    for lo, size, _ in kept:
        for t in tg:
            if lo < t < lo + size and t not in starts0:
                cuts[lo].append(t)
    split = []
    for lo, size, name in kept:
        if lo not in cuts:
            split.append((lo, size, name))
            continue
        pts = sorted(set(cuts[lo])) + [lo + size]
        prev = lo
        for p in pts:
            split.append((prev, p - prev, name if prev == lo else f"split_{prev:08x}"))
            prev = p
    say(f"[boundaries=outer+calls] split {len(cuts)} entries at "
        f"{sum(len(v) for v in cuts.values())} interior call targets "
        f"({len(kept)} -> {len(split)})")
    return sorted(split)


def closure_of(img, byaddr, roots, indirect=False, jumptables=False, hosts=()):
    """Transitive callee closure. -> (set of function starts, [(addr, why), ...]).

    A non-empty problem list means the closure CANNOT be translated end-to-end; the
    caller must not emit a partial closure and call it done.

    `hosts` are addresses the HOST implements (sr.py --host). The walk stops there
    and they are not returned in the closure, so an untranslatable primitive like
    OSSaveContext does not block a root that merely calls it."""
    starts = set(byaddr)
    hosts = set(hosts)
    seen, work, probs = set(), [r for r in roots if r not in hosts], []
    while work:
        a = work.pop()
        if a in seen or a in hosts:
            continue
        seen.add(a)
        if a not in byaddr:
            probs.append((a, "not a mapped function in this image"))
            continue
        size, _ = byaddr[a]
        # THE CLOSURE MUST TRANSLATE UNDER THE SAME SETTINGS AS THE EMISSION.
        # Without this it refuses blrl/bctr even when the caller passed --indirect,
        # so a root reached through an indirect branch reports CLOSURE BLOCKED and
        # cannot be built at all -- which is why the blrl fixtures had to be run
        # against a whole-image build instead of a closure build.
        t = Translator(img, a, a + size, starts=starts, indirect=indirect,
                       jumptables=jumptables)
        try:
            t.translate()
        except Untranslatable as e:
            probs.append((a, e.why))
            continue
        work += list(t.calls)
    return seen, probs


def emit_dispatch_tu(fns):
    """`sr_dispatch` as its OWN translation unit.

    WHY THIS EXISTS — it is the difference between a whole-image build that runs at
    -O0 and one that runs at -O2, and -O2 is worth ~5x on identical code (measured
    2026-09-04, matched closure builds one flag apart: 71.7-79.6 M guest instr/s at
    -O0 vs 342.3-432.5 M at -O2).

    Emitted in the SAME file as the bodies, `sr_dispatch` is a switch whose every arm
    calls exactly one `fn_*` once, so at -O2 clang inlines all 4,671 bodies INTO it and
    the result blows V8's hard per-function ceiling — `WebAssembly.instantiate(): size
    8549242 > maximum function size 7654321`, which presents as a corrupt wasm rather
    than a size limit.  The previous answer was to drop the whole image to -O0.

    A separate TU fixes it exactly and with no collateral: emcc does not do cross-TU
    inlining without LTO, so nothing can be inlined into `sr_dispatch`, while the
    bodies keep full -O2 including leaf inlining at their own call sites.  Inlining
    into `sr_dispatch` was never worth anything anyway — each arm is a single call.
    """
    out = ['// GENERATED by gamecube/recomp/sr/sr.py — sr_dispatch, split into its own',
           '// translation unit so -O2 cannot inline the translated bodies into it.',
           '#include "gekko_rt.h"',
           '']
    for lo, _, name in fns:
        out.append(f"void fn_{lo:08x}(GekkoState *st);   /* {name} */")
    out.append("\nint sr_dispatch(uint32_t addr, GekkoState *st) {")
    out.append("    switch (addr) {")
    for lo, size, name in fns:
        out.append(f"    case {lo:#010x}u: fn_{lo:08x}(st); return 1;   /* {name} */")
    out.append("    default: return 0;")
    out.append("    }\n}")
    return "\n".join(out) + "\n"


def emit_c(img, fns, starts=None, branch_reloc=None, indirect=False,
           jumptables=False, split_dispatch=False):
    emitted = {lo for lo, _, _ in fns}
    out = [HEADER]
    if len(fns) > 1:
        out.append("\n// forward declarations (calls may be forward or mutually recursive)")
        for lo, _, name in fns:
            out.append(f"void fn_{lo:08x}(GekkoState *st);   /* {name} */")
    for lo, size, name in fns:
        t = Translator(img, lo, lo + size, starts=starts, emitted=emitted,
                       branch_reloc=branch_reloc, indirect=indirect,
                       jumptables=jumptables)
        body = t.translate()
        out.append(f"\n// {name}  @ {lo:#010x}  ({size} bytes, {size // 4} instructions)")
        out.append(f"void fn_{lo:08x}(GekkoState *st) {{")
        out += body
        out.append("}")
    # generated address -> translated-function dispatch (the table a full build needs
    # anyway for bctr/blrl indirect targets; here it is the driver's entry point).
    if split_dispatch:
        return "\n".join(out) + "\n"     # caller writes it via emit_dispatch_tu()
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
    ap.add_argument('--closure', action='store_true',
                    help='also translate the transitive callee closure of each --fn')
    ap.add_argument('--closure-report', action='store_true',
                    help='list every mapped non-leaf whose whole closure translates clean')
    ap.add_argument('--boundaries', default='asis',
                    choices=['asis', 'clip', 'outer', 'outer+calls'],
                    help='function-boundary recovery policy (see recover_boundaries). '
                         'Default asis keeps the historical --coverage numbers comparable; '
                         'outer+calls is what an emitting build should use.')
    ap.add_argument('--indirect', action='store_true',
                    help='translate blrl/bctr/bctrl as a runtime address->function '
                         'dispatch through sr_indirect() instead of refusing them')
    ap.add_argument('--msr-audit', action='store_true',
                    help='AUDIT THE MSR BOUNDARY: list every function in the image '
                         'containing an instruction that can observe or alter MSR '
                         '(mfmsr, mtmsr, rfi, mfspr/mtspr SRR0|SRR1) and prove each is '
                         'either --host-bound or REFUSED by the translator. Exit 2 if '
                         'any such function would be EMITTED as a translated body. '
                         'That is the standing evidence that sr_host_os.c\'s one-word '
                         'g_msr is not an approximation the guest can catch out: no '
                         'emitted body can reach MSR except by calling the host layer. '
                         'Pair it with the same --host set the build uses.')
    ap.add_argument('--tb-audit', action='store_true',
                    help='AUDIT THE TIMEBASE BOUNDARY: list every function in the '
                         'image containing an instruction that can observe or alter '
                         'the Gekko time base or decrementer (mftb, and mfspr/mtspr '
                         'naming TBL=268 / TBU=269 / TBL_w=284 / TBU_w=285 / DEC=22) '
                         'and prove each is either --host-bound or REFUSED by the '
                         'translator. Exit 2 if any such function would be EMITTED as '
                         'a translated body. That is the standing evidence that '
                         'sr_host_os.c\'s g_tb/g_dec is the ONLY representation of '
                         'guest time inside the emitted image, so a guest cannot read '
                         'the clock behind the host layer\'s back. Same shape as '
                         '--msr-audit; pair it with the same --host set the build uses.')
    ap.add_argument('--cache-audit', action='store_true',
                    help='AUDIT THE CACHE-MAINTENANCE BOUNDARY: list every cache '
                         'instruction in the image (CACHE_NOP_XO, dcbz, dcbz_l, sc) '
                         'with the claim it is emitted under, and prove that no REAL '
                         'operation (dcbz/dcbz_l, which are 32-byte stores) was '
                         'reduced to a no-op and that no cache site sits inside a '
                         '--host-bound function -- a host stub does not run the loop, '
                         'so it would freeze r3/r4/r5/CTR/CR0 that verify_fixture.mjs '
                         'scores. Exit 2 on either. NOTE the shape is the INVERSE of '
                         '--msr-audit/--tb-audit: those fail when a body is emitted, '
                         'because MSR and time are STATE with one host owner; cache '
                         'maintenance has no state here, so emitting is the correct '
                         'outcome and host-binding is the bug.')
    ap.add_argument('--retire', action='store_true',
                    help='THE DRIVE: emit gk_retire(N) at the head of every basic '
                         'block, N = the summed Gekko cycle cost of its instructions '
                         '(Dolphin PPCTables.cpp num_cycles). This is what makes guest '
                         'TIME a function of guest WORK, so OSGetTime/OSGetTick/DEC '
                         'advance at exactly 40.5 MHz per 486 MHz of retired guest '
                         'cycles no matter how fast the host runs — CLAUDE.md gate #9. '
                         'Without it g_gk_cycles stays 0, the clock is FROZEN, and a '
                         'guest that polls it raises SR_F_TB_STALL by name instead of '
                         'returning a plausible wrong number. Off by default so every '
                         'existing fixture artifact stays byte-identical; the '
                         'whole-image build passes it.')
    ap.add_argument('--cache-ack', action='append', default=[], metavar='ADDR',
                    help='for --cache-audit: acknowledge that this HOST-BOUND address\'s '
                         'host implementation really does perform the dcbz/dcbz_l stores '
                         'in its body. Only 0x800e4f70 __LCEnable qualifies today '
                         '(sr_image.c runs its 512-line OSCache.c:349-352 _lockloop). '
                         'Without it the audit exits 2, which is the point: a stub that '
                         'silently skips guest stores must be a deliberate, written-down '
                         'decision.')
    ap.add_argument('--jumptable-census', action='store_true',
                    help='report how many bctr jump tables statically RESOLVE. This is '
                         'the runtime-completeness number; --coverage cannot show it '
                         'because a bctr already "translates" under --indirect and '
                         'only faults when executed.')
    ap.add_argument('--jumptables', action='store_true',
                    help='STATIC SWITCH-TABLE RECOVERY for bctr: read the jump table '
                         'the compiler emitted and dispatch to the case labels '
                         'directly, instead of faulting in sr_indirect(). Requires '
                         '--indirect. Every SAB bctr is a jump table, so without this '
                         '123 DOL functions (65,401 instructions) translate but fault '
                         'at run time; that is the whole gap between 82.0%% and ~99.4%% '
                         'runtime-complete.')
    ap.add_argument('--skiplist', help='write the --all host-binding worklist as JSON')
    ap.add_argument('--dispatch-out',
                    help='write sr_dispatch to its OWN .c file (--all only). Without '
                         'this the whole-image build must be -O0, because -O2 inlines '
                         'every translated body into the switch and blows V8\'s '
                         'per-function ceiling. Worth ~5x — see emit_dispatch_tu().')
    ap.add_argument('--all', action='store_true',
                    help='emit every function in the boundary set (whole-image build)')
    ap.add_argument('--host', action='append', default=[], metavar='ADDR',
                    help='HOST-BOUND function: never translate this address, and stop '
                         'the closure walk there. Calls to it become sr_extern(), which '
                         'sr_driver.c routes to sr_host_hook (sr_host_os.c) instead of '
                         'faulting. This is the function-granular exclusion N64Recomp '
                         'provides in its toml (~/gc_refs/N64Recomp/README.md:32), and '
                         'it is how the guest-OS context switch is cut out of the image '
                         '— see sr_host_os.h and CONTEXT_SWITCH.md. Repeatable.')
    a = ap.parse_args()
    hosts = {int(x, 16) for x in a.host}
    global RETIRE
    RETIRE = bool(a.retire)

    img = Image.from_dol(a.image)
    syms = load_map(a.map)
    units = recover_boundaries(img, syms, a.boundaries,
                               log=lambda m: print(m, file=sys.stderr))

    if a.coverage:
        ok = fail = 0
        ok_i = fail_i = 0
        reasons = collections.Counter()
        for lo, size, name in units:
            try:
                Translator(img, lo, lo + size, indirect=a.indirect,
                           jumptables=a.jumptables).translate()
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

    byaddr = {lo: (sz, nm) for lo, sz, nm in units}
    starts = set(byaddr)

    if a.msr_audit:
        # WHAT THE GUEST CAN SEE OF MSR, enumerated rather than argued.  Six encodings
        # reach it: mfmsr (op31 xo=83), mtmsr (xo=146), rfi (op19 xo=50), and
        # mfspr/mtspr (xo=339/467) naming SRR0=26 or SRR1=27 -- rfi's MSR<-SRR1 makes
        # SRR1 an MSR alias, so reading or writing it is observing MSR.
        SPR_SRR = (26, 27)
        owners = {}
        for lo, size, name in units:
            for p in range(lo, lo + size, 4):
                w = img.word(p)
                if w is None:
                    continue
                op, xo = w >> 26, (w >> 1) & 0x3FF
                spr = ((w >> 16) & 31) | (((w >> 11) & 31) << 5)
                if ((op == 31 and xo in (83, 146)) or (op == 19 and xo == 50)
                        or (op == 31 and xo in (339, 467) and spr in SPR_SRR)):
                    owners.setdefault(lo, [name, []])[1].append((p, w))
        emitted = []
        for lo in sorted(owners):
            name, sites = owners[lo]
            if lo in hosts:
                verdict = 'HOST-BOUND (serviced by sr_host_os.c)'
            else:
                try:
                    Translator(img, lo, lo + byaddr[lo][0], starts=starts,
                               indirect=a.indirect, jumptables=a.jumptables).translate()
                    verdict = '*** EMITTED — THE GUEST CAN OBSERVE MSR DIRECTLY ***'
                    emitted.append(lo)
                except Untranslatable as e:
                    verdict = f'refused ({e.why})'
            print(f"{lo:#010x} {name[:34]:34s} {len(sites):2d} site(s)  {verdict}")
        nh = sum(1 for lo in owners if lo in hosts)
        print(f"\n{len(owners)} functions can observe MSR: "
              f"{nh} host-bound, {len(owners) - nh - len(emitted)} refused, "
              f"{len(emitted)} EMITTED")
        if emitted:
            print("FAIL: an emitted body can read or write MSR without the host layer, "
                  "so g_msr is no longer the only representation of MSR in this "
                  "runtime and the two can disagree.", file=sys.stderr)
            sys.exit(2)
        print("PASS: no emitted body can reach MSR except through the host boundary.")
        return

    if a.tb_audit:
        # WHAT THE GUEST CAN SEE OF TIME, enumerated rather than argued.  Three
        # encodings reach it: mftb (op31 xo=371) and mfspr/mtspr (xo=339/467) naming
        # one of the five time SPRs.  Gekko splits the SPR field into halves that are
        # SWAPPED in the encoding, which is why the number is reassembled rather than
        # masked out directly -- 0x7c6d42e6 is `mftbu r3`, spr field 0b1011000000,
        # low half 13 | high half 8 << 5 = 269.
        SPR_TIME = {268: 'TBL', 269: 'TBU', 284: 'TBL(w)', 285: 'TBU(w)', 22: 'DEC'}
        owners = {}
        for lo, size, name in units:
            for p in range(lo, lo + size, 4):
                w = img.word(p)
                if w is None:
                    continue
                op, xo = w >> 26, (w >> 1) & 0x3FF
                spr = ((w >> 16) & 31) | (((w >> 11) & 31) << 5)
                if op == 31 and xo in (339, 371, 467) and spr in SPR_TIME:
                    mn = {339: 'mfspr', 371: 'mftb', 467: 'mtspr'}[xo]
                    owners.setdefault(lo, [name, []])[1].append(
                        (p, f"{mn} {SPR_TIME[spr]}"))
        emitted = []
        for lo in sorted(owners):
            name, sites = owners[lo]
            if lo in hosts:
                verdict = 'HOST-BOUND (serviced by sr_host_os.c)'
            else:
                try:
                    Translator(img, lo, lo + byaddr[lo][0], starts=starts,
                               indirect=a.indirect, jumptables=a.jumptables).translate()
                    verdict = '*** EMITTED — THE GUEST CAN READ THE CLOCK DIRECTLY ***'
                    emitted.append(lo)
                except Untranslatable as e:
                    verdict = f'refused ({e.why})'
            ops = ', '.join(sorted({o for _, o in sites}))
            print(f"{lo:#010x} {name[:30]:30s} {len(sites):2d} site(s) [{ops}]  {verdict}")
        nh = sum(1 for lo in owners if lo in hosts)
        print(f"\n{len(owners)} functions can observe the timebase/decrementer: "
              f"{nh} host-bound, {len(owners) - nh - len(emitted)} refused, "
              f"{len(emitted)} EMITTED")
        if emitted:
            print("FAIL: an emitted body can read or write the time base without the "
                  "host layer, so sr_host_os.c's clock is no longer the only "
                  "representation of guest time in this runtime and the two can "
                  "disagree — which is precisely how a guest catches a modelled clock "
                  "out.", file=sys.stderr)
            sys.exit(2)
        print("PASS: no emitted body can reach the timebase except through the host "
              "boundary.")
        return

    if a.cache_audit:
        # WHAT THE GUEST CAN DO TO THE CACHE, enumerated rather than argued.  This audit
        # is the OPPOSITE SHAPE to --msr-audit / --tb-audit and the difference is the
        # whole design: MSR and the timebase are STATE with one host owner, so those
        # audits fail if any body is EMITTED.  Cache maintenance has no state at all
        # here, so the correct outcome is that every site IS emitted -- and what has to
        # be proved instead is that each one lands on the claim it is supposed to land
        # on.  A no-op emitted for `dcbz` (a real store) would be silent data loss, and
        # a no-op FUNCTION standing in for DCFlushRange would silently freeze r3/r4/r5/
        # CTR/CR0.  So this fails on:
        #   * a REAL operation (dcbz, dcbz_l) reduced to a no-op, and
        #   * a cache-maintenance site inside a function that is HOST-BOUND, i.e. one
        #     whose registers a host stub would have to reproduce by hand.
        REAL = {(31, 1014): 'dcbz', (4, 1014): 'dcbz_l'}
        rows, bad_real, bad_host = [], [], []
        for lo, size, name in units:
            for p in range(lo, lo + size, 4):
                w = img.word(p)
                if w is None:
                    continue
                op, xo, xo5 = w >> 26, (w >> 1) & 0x3FF, (w >> 1) & 0x1F
                if op == 17:
                    kind, cls = 'sc', 'gk_sc() — DOLSDK 0xC00 vector, OSSync.c:9-21'
                elif op == 31 and xo == 1014:
                    kind, cls = 'dcbz', 'gk_dcbz() — REAL 32-byte store'
                elif op == 4 and xo == 1014 and xo5 == 22:
                    kind, cls = 'dcbz_l', 'gk_dcbz() — REAL 32-byte store (locked cache)'
                elif op == 31 and xo in CACHE_NOP_XO:
                    kind, cls = CACHE_NOP_XO[xo], 'no-op — no cache exists in this runtime'
                else:
                    continue
                rows.append((lo, name, p, kind, cls))
                if (op, xo) in REAL and 'REAL' not in cls:
                    bad_real.append((p, kind))
                if lo in hosts:
                    bad_host.append((lo, name, p, kind))
        byfn = {}
        for lo, name, p, kind, cls in rows:
            byfn.setdefault(lo, [name, collections.Counter()])[1][kind] += 1
        for lo in sorted(byfn):
            name, kinds = byfn[lo]
            try:
                Translator(img, lo, lo + byaddr[lo][0], starts=starts,
                           indirect=a.indirect, jumptables=a.jumptables).translate()
                verdict = 'emitted'
            except Untranslatable as e:
                verdict = f'refused ({e.why})'
            if lo in hosts:
                verdict = '*** HOST-BOUND — a stub must reproduce this loop by hand ***'
            ops = ', '.join(f"{k}x{v}" for k, v in kinds.most_common())
            print(f"{lo:#010x} {name[:30]:30s} [{ops}]  {verdict}")
        print(f"\n{len(rows)} cache-maintenance sites in {len(byfn)} functions.")
        print("emitted as REAL stores : dcbz / dcbz_l -> gk_dcbz()")
        print("emitted as no-ops      : " + ", ".join(sorted(set(CACHE_NOP_XO.values()))))
        print("emitted as the vector  : sc -> gk_sc()  (r9/r10 clobber, HID0 net zero)")
        if bad_real:
            print(f"FAIL: {len(bad_real)} REAL cache operation(s) reduced to a no-op.",
                  file=sys.stderr)
            sys.exit(2)
        # A HOST-BOUND function containing cache sites is TWO different problems and
        # they are not equally bad, so they are reported apart:
        #   REAL sites (dcbz/dcbz_l) -- the stub must actually perform those stores or
        #       memory the guest can read comes out wrong.  This is a HARD FAIL unless
        #       the caller ACKNOWLEDGES the address with --cache-ack, which is how it
        #       says "I read that host implementation and it does the stores".
        #   no-op sites -- the stub skips a loop that changed only r3/r4/r5/CTR/CR0.
        #       No guest MEMORY differs; a fixture differential would still score it.
        #       Reported every time, never fatal, because it is a build-configuration
        #       choice and the choice is visible in build_image.sh's HOSTS list.
        ack = {int(x, 16) for x in a.cache_ack}
        real_fns = {lo for lo, _, _, k in bad_host if k in ('dcbz', 'dcbz_l')}
        hard = [(lo, n, p, k) for lo, n, p, k in bad_host
                if k in ('dcbz', 'dcbz_l') and lo not in ack]
        soft = sorted({(lo, n) for lo, n, _, _ in bad_host if lo not in real_fns})
        for lo, n in soft:
            print(f"NOTE: {lo:#010x} {n} is HOST-BOUND and every cache site in it is a "
                  f"no-op -- no guest MEMORY differs, but the stub does not run the "
                  f"loop, so r3/r4/r5/CTR/CR0 keep their entry values and "
                  f"verify_fixture.mjs scores all of them.")
        for lo, n, p, k in sorted({(lo, n, p, k) for lo, n, p, k in bad_host
                                   if k in ('dcbz', 'dcbz_l')}):
            state = 'ACKNOWLEDGED (--cache-ack)' if lo in ack else '*** UNACKNOWLEDGED ***'
            print(f"REAL-in-host: {lo:#010x} {n} {k} at {p:#010x}  {state}")
        if hard:
            fns = sorted({f"{lo:#010x}" for lo, _, _, _ in hard})
            print(f"FAIL: {len(hard)} REAL cache store(s) (dcbz/dcbz_l) sit inside "
                  f"HOST-BOUND function(s) {', '.join(fns)} with no --cache-ack.  A "
                  f"host stub that returns without performing them drops guest stores "
                  f"silently.  Either translate the function, make the stub do the "
                  f"stores, or --cache-ack it once you have read that it does.",
                  file=sys.stderr)
            sys.exit(2)
        print("PASS: every cache-maintenance site is emitted or accounted for, and "
              "every REAL one (dcbz/dcbz_l) is a real store.")
        return

    if a.jumptable_census:
        # RUNTIME completeness, which --coverage does NOT measure: under --indirect a
        # `bctr` TRANSLATES (it becomes sr_indirect) but FAULTS when executed, because
        # its target is a mid-function switch label and not a dispatchable entry.  So
        # the census that matters is how many bctr sites resolve to a real table.
        n_sites = n_ok = 0
        refused = collections.Counter()
        tgt = collections.Counter()
        fn_all, fn_ok = set(), {}
        for lo, size, name in units:
            t = Translator(img, lo, lo + size, starts=starts, indirect=True,
                           jumptables=True)
            try:
                t.translate()
            except Untranslatable:
                continue
            sites = [p for p in range(lo, lo + size, 4)
                     if (w := img.word(p)) is not None and (w >> 26) == 19
                     and ((w >> 1) & 0x3FF) == 528 and not (w & 1)]
            if not sites:
                continue
            fn_all.add(lo)
            allok = True
            for p in sites:
                n_sites += 1
                ts = t.jt_recovered.get(p)
                if ts is None:
                    refused[t.jt_refused.get(p, "not attempted")] += 1
                    allok = False
                    continue
                n_ok += 1
                for x in ts:
                    tgt["inside the same function (emitted as a label)"
                        if lo <= x < lo + size else
                        "another function start (emitted as a tail call)"] += 1
            fn_ok[lo] = allok and fn_ok.get(lo, True)
        full = [f for f, v in fn_ok.items() if v]
        i_full = sum(byaddr[f][0] for f in full) // 4
        i_all = sum(byaddr[f][0] for f in fn_all) // 4
        print(f"bctr sites in translatable functions : {n_sites}")
        print(f"  jump table RECOVERED               : {n_ok} "
              f"({100.0 * n_ok / max(n_sites, 1):.1f}%)")
        print(f"  refused                            : {n_sites - n_ok}")
        for r, c in refused.most_common():
            print(f"      {c:4d}  {r}")
        print(f"\ncase targets recovered: {sum(tgt.values())}")
        for k, v in tgt.most_common():
            print(f"      {v:5d}  {k}")
        print(f"\nfunctions containing a bctr          : {len(fn_all)}  "
              f"({i_all} instructions)")
        print(f"  every bctr in them resolved        : {len(full)}  "
              f"({i_full} instructions)")
        print(f"\nThese instructions were TRANSLATED but not RUNTIME-COMPLETE before: "
              f"under --indirect alone every bctr faults.")
        return

    if a.closure_report:
        rows = []
        for lo, (size, name) in byaddr.items():
            t = Translator(img, lo, lo + size, indirect=a.indirect,
                           jumptables=a.jumptables)
            try:
                t.translate()
            except Untranslatable:
                continue
            if not t.calls:
                continue                                     # leaf
            cl, probs = closure_of(img, byaddr, [lo], indirect=a.indirect,
                                   jumptables=a.jumptables)
            if probs:
                continue
            rows.append((len(cl), sum(byaddr[x][0] // 4 for x in cl), lo, name, cl))
        rows.sort()
        print(f"mapped functions in image                : {len(byaddr)}")
        print(f"non-leaf with a FULLY CLEAN callee closure: {len(rows)}")
        for n, ins, lo, name, cl in rows:
            kids = ",".join(byaddr[x][1] for x in sorted(cl) if x != lo)
            print(f"{lo:#010x} {n:3d} fns {ins:6d} insts  {name[:40]:40s} {kids[:70]}")
        return

    if a.all:
        # Whole-image build.  A function this translator refuses is SKIPPED, not
        # approximated: it is left out of sr_dispatch, so every call to it lands on
        # sr_extern()/sr_indirect()'s fault instead of running wrong code.  That
        # omission list IS the host-binding worklist -- the same function-granular
        # exclusion N64Recomp's toml provides (~/gc_refs/N64Recomp/README.md:32),
        # and the mechanism by which a BINARY recomp gets MP4's "never compiled
        # OSThread.c in" escape without having the source to omit.
        if not a.out:
            print('--all needs --out', file=sys.stderr); sys.exit(1)
        ok, skipped, reasons = [], [], collections.Counter()
        for lo, size, name in units:
            if lo in hosts:
                skipped.append((lo, size, name, 'host-bound (--host)'))
                reasons['host-bound (--host)'] += 1
                continue
            try:
                Translator(img, lo, lo + size, starts=starts,
                           indirect=a.indirect,
                           jumptables=a.jumptables).translate()
                ok.append((lo, size, name))
            except Untranslatable as e:
                skipped.append((lo, size, name, e.why))
                reasons[e.why.split('(')[0].strip()] += 1
        src = emit_c(img, ok, starts=starts, indirect=a.indirect,
                     jumptables=a.jumptables,
                     split_dispatch=bool(a.dispatch_out))
        open(a.out, 'w').write(src)
        if a.dispatch_out:
            open(a.dispatch_out, 'w').write(emit_dispatch_tu(ok))
            print(f"wrote {a.dispatch_out} (sr_dispatch in its own TU — "
                  f"lets the bodies build at -O2)", file=sys.stderr)
        ni = sum(sz // 4 for _, sz, _ in ok)
        nt = sum(sz // 4 for _, sz, _ in units)
        print(f"wrote {a.out} ({len(src)} bytes)", file=sys.stderr)
        print(f"  translated : {len(ok)}/{len(units)} functions "
              f"({100.0 * len(ok) / len(units):.2f}%), {ni}/{nt} instructions "
              f"({100.0 * ni / nt:.2f}%)", file=sys.stderr)
        print(f"  SKIPPED (host-binding worklist): {len(skipped)} functions, "
              f"{nt - ni} instructions", file=sys.stderr)
        for r, c in reasons.most_common(30):
            print(f"      {c:4d}  {r}", file=sys.stderr)
        if a.skiplist:
            with open(a.skiplist, 'w') as fh:
                json.dump([dict(addr=f"{lo:#010x}", size=sz, name=nm, why=why)
                           for lo, sz, nm, why in skipped], fh, indent=1)
            print(f"  skip list -> {a.skiplist}", file=sys.stderr)
        return

    want = [int(x, 16) for x in a.fn]
    missing = set(want) - starts
    if missing:
        print("not in map: " + ", ".join(f"{m:#x}" for m in missing), file=sys.stderr)
        sys.exit(1)

    if a.closure:
        sel, probs = closure_of(img, byaddr, want, indirect=a.indirect,
                                jumptables=a.jumptables, hosts=hosts)
        if probs:
            for addr, why in sorted(set(probs)):
                print(f"CLOSURE BLOCKED at {addr:#010x}: {why}", file=sys.stderr)
            sys.exit(2)
        print(f"closure: {len(sel)} functions, "
              f"{sum(byaddr[x][0] // 4 for x in sel)} instructions", file=sys.stderr)
    else:
        sel = set(want)
    sel -= hosts                    # host-bound: emit a call, never a body
    fns = sorted((lo, byaddr[lo][0], byaddr[lo][1]) for lo in sel)
    src = emit_c(img, fns, starts=starts, indirect=a.indirect,
                 jumptables=a.jumptables)
    if a.out:
        open(a.out, 'w').write(src)
        print(f"wrote {a.out} ({len(src)} bytes, {len(fns)} functions)", file=sys.stderr)
    else:
        sys.stdout.write(src)


if __name__ == '__main__':
    main()

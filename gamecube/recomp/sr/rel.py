#!/usr/bin/env python3
"""rel.py — GameCube REL (relocatable overlay) reader + static-recompilation front end.

WHY THIS EXISTS
  SAB's `main.dol` is only a fraction of the game's PowerPC code; the rest ships as
  `.rel` overlays in the disc filesystem, and the City Escape stage is one of them.
  A static recompiler that only covers the DOL covers almost none of the game.

WHAT A REL GIVES US THAT THE DOL DOES NOT
  A REL is not a flat blob: it carries its own section table AND a relocation table
  that names every branch target and data reference as (module id, section, addend).
  So for REL code the callee of a `bl` is stated in the file — no heuristics, no
  symbol map.  The DOL has no such table, which is why 472 of its 543 blocked
  functions are indirect-branch guesses.

FORMAT SOURCE OF TRUTH (not reverse-engineered):
  ~/gc_refs/dolsdk2001/include/dolphin/os/OSModule.h   OSModuleHeader / OSSectionInfo
                                                       / OSImportInfo / OSRel
  ~/gc_refs/dolsdk2001/src/os/OSLink.c:130-211         Relocate(), the exact arithmetic
  ~/gc_refs/dolsdk2001/src/os/OSLink.c:213-270         OSLink(), the offset->address fixups

  Relocate() is driven by `imp` entries: `imp->id == 0` is the batch of references
  into the STATIC DOL, and for those `offset = 0`, so the addend is an ABSOLUTE
  address — DOL references are therefore fully known ahead of time.  For any other
  id, `offset` is the referenced module's section base, so the value is
  `section_base + addend`: a symbolic base plus a constant.  That is precisely the
  shape a static recompiler wants.

Usage:
  python3 rel.py --iso <sab.iso> --inventory
  python3 rel.py --iso <sab.iso> --report stg13D.rel
  python3 rel.py --iso <sab.iso> --translatability stg13D.rel
"""
import argparse, collections, struct, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sr  # noqa: E402

# OSLink.c:20-46 — only the types Relocate() actually implements are legal in a REL.
R_PPC_NONE, R_PPC_ADDR32, R_PPC_ADDR24 = 0, 1, 2
R_PPC_ADDR16, R_PPC_ADDR16_LO, R_PPC_ADDR16_HI, R_PPC_ADDR16_HA = 3, 4, 5, 6
R_PPC_REL24 = 10
R_DOLPHIN_NOP, R_DOLPHIN_SECTION, R_DOLPHIN_END, R_DOLPHIN_MRKREF = 201, 202, 203, 204
RTYPE = {0: "R_PPC_NONE", 1: "R_PPC_ADDR32", 2: "R_PPC_ADDR24", 3: "R_PPC_ADDR16",
         4: "R_PPC_ADDR16_LO", 5: "R_PPC_ADDR16_HI", 6: "R_PPC_ADDR16_HA",
         7: "R_PPC_ADDR14", 10: "R_PPC_REL24", 11: "R_PPC_REL14",
         201: "R_DOLPHIN_NOP", 202: "R_DOLPHIN_SECTION", 203: "R_DOLPHIN_END",
         204: "R_DOLPHIN_MRKREF"}
OS_SECTIONINFO_EXEC = 0x1


# ------------------------------------------------------------------ disc / FST
class Disc:
    """GameCube disc image: header pointers at 0x420 (DOL) / 0x424 (FST) / 0x428."""

    def __init__(self, path):
        self.f = open(path, 'rb')
        self.f.seek(0x420)
        self.dol_off, self.fst_off, self.fst_size = struct.unpack('>3I', self.f.read(12))
        self.files = self._read_fst()

    def _rd(self, off, n):
        self.f.seek(off)
        return self.f.read(n)

    def _read_fst(self):
        fst = self._rd(self.fst_off, self.fst_size)
        n = struct.unpack('>I', fst[8:12])[0]          # root entry's "size" = # entries
        strtab = 12 * n
        out, stack = [], [(n, "")]                     # (end index, path prefix)
        for i in range(1, n):
            e = fst[12 * i:12 * i + 12]
            flag_nameoff = struct.unpack('>I', e[0:4])[0]
            a, b = struct.unpack('>2I', e[4:12])
            is_dir = flag_nameoff >> 24
            noff = flag_nameoff & 0xFFFFFF
            end = strtab + noff
            name = fst[end:fst.index(b'\0', end)].decode('ascii', 'replace')
            while stack and i >= stack[-1][0]:
                stack.pop()
            prefix = stack[-1][1] if stack else ""
            if is_dir:
                stack.append((b, prefix + name + "/"))
            else:
                out.append({"path": prefix + name, "name": name, "offset": a, "size": b})
        return out

    def read_file(self, ent):
        return self._rd(ent["offset"], ent["size"])


# ------------------------------------------------------------------ REL module
class Rel:
    """One relocatable module, parsed exactly as OSModuleHeader describes it."""

    def __init__(self, blob, path="<rel>"):
        self.blob, self.path = blob, path
        (self.id, self.link_next, self.link_prev, self.num_sections,
         self.section_info_off, self.name_off, self.name_size,
         self.version) = struct.unpack('>8I', blob[0:32])
        (self.bss_size, self.rel_off, self.imp_off, self.imp_size) = \
            struct.unpack('>4I', blob[32:48])
        (self.prolog_sec, self.epilog_sec, self.unresolved_sec,
         self.bss_sec) = struct.unpack('>4B', blob[48:52])
        (self.prolog, self.epilog, self.unresolved) = struct.unpack('>3I', blob[52:64])
        self.align = self.bss_align = self.fix_size = None
        if self.version >= 2 and len(blob) >= 72:
            self.align, self.bss_align = struct.unpack('>2I', blob[64:72])
        if self.version >= 3 and len(blob) >= 76:
            self.fix_size = struct.unpack('>I', blob[72:76])[0]

        self.sections = []
        for i in range(self.num_sections):
            o, sz = struct.unpack('>2I', blob[self.section_info_off + 8 * i:
                                              self.section_info_off + 8 * i + 8])
            self.sections.append({"idx": i, "raw_offset": o, "offset": o & ~1,
                                  "exec": bool(o & OS_SECTIONINFO_EXEC), "size": sz,
                                  "bss": o == 0 and sz != 0})

        self.imports = []
        for off in range(self.imp_off, self.imp_off + self.imp_size, 8):
            mid, roff = struct.unpack('>2I', blob[off:off + 8])
            self.imports.append({"id": mid, "offset": roff,
                                 "relocs": self._read_relocs(roff)})

    def _read_relocs(self, off):
        """OSLink.c:145-201. `offset` is a delta from the previous patch site;
        R_DOLPHIN_SECTION resets the site to the start of a section OF THIS MODULE,
        while `section` on a value relocation names the section OF THE REFERENCED
        MODULE.  Both are carried through here."""
        out, site_sec, site_off = [], None, 0
        p = off
        while p + 8 <= len(self.blob):
            delta, typ, sec, addend = struct.unpack('>HBBI', self.blob[p:p + 8])
            p += 8
            if typ == R_DOLPHIN_END:
                break
            site_off += delta
            if typ == R_DOLPHIN_SECTION:
                site_sec, site_off = sec, 0
                continue
            out.append({"site_sec": site_sec, "site_off": site_off,
                        "type": typ, "ref_sec": sec, "addend": addend})
        return out

    # -- convenience --------------------------------------------------------
    def section_bytes(self, i):
        s = self.sections[i]
        if s["bss"] or s["offset"] == 0:
            return b""
        return self.blob[s["offset"]:s["offset"] + s["size"]]

    def exec_sections(self):
        return [s for s in self.sections if s["exec"] and s["size"]]

    def exec_bytes(self):
        return sum(s["size"] for s in self.exec_sections())

    def all_relocs(self):
        for imp in self.imports:
            for r in imp["relocs"]:
                yield imp["id"], r

    def section_bases(self, exec_base):
        """Runtime address of every FILE-BACKED section, from one known one.

        OSLink.c:236-240 relocates a section by `si->offset += (u32)moduleHeader` when
        it has file bytes, so the whole REL blob is loaded contiguously at
        moduleHeader and each such section sits at its FILE OFFSET within it.  Given
        the executable section's runtime address (which __OSModuleInfoList reports, or
        which base recovery confirms) the rest follow with no further reads.

        VERIFIED against the machine on stg13D, 4 of 4 file-backed data sections:
        moduleHeader = 0x811fff48 - 0xe8 = 0x811ffe60 -- which is also the module-info
        pointer the guest OS itself holds -- and sec2/3/4/5 then predict
        0x8125c118 / 0x8125c11c / 0x8125c120 / 0x8125dba0, exactly what the live
        module list reports.

        A BSS section is NOT covered: OSLink assigns it from the separate `bss`
        pointer, so its address is not a function of the file.  It is omitted here
        rather than guessed."""
        e = next(s for s in self.sections if s["exec"] and s["size"])
        hdr = (exec_base - e["offset"]) & 0xFFFFFFFF
        return {s["idx"]: (hdr + s["offset"]) & 0xFFFFFFFF
                for s in self.sections if s["size"] and not s["bss"]}

    def relocate(self, bases, sections=None):
        """Apply OSLink's Relocate() offline. -> {sec_idx: relocated bytes}.

        `bases` is {(module_id, section_idx): runtime address}, exactly what
        __OSModuleInfoList reports once the module is linked.  Module id 0 is the
        static DOL, for which OSLink.c:139-142 sets offset = 0 and the addend is
        therefore already absolute.

        WHY THIS EXISTS: THE JUMP TABLES ARE IN A DATA SECTION.  Static `bctr`
        recovery reads the switch table out of the image, and on the DOL that works
        (145 of 147 sites).  On stg13D it recovers 0 of 23 -- every table base lands
        in sec5, a 2,620,456-byte FILE-BACKED data section that the emit path never
        loads, so every table word reads "not in image" and the site silently falls
        back to sr_indirect(), which faults at run time.  Loading the RAW sec5 does
        not fix it either: a table of code addresses is a run of R_PPC_ADDR32
        relocations, so the shipped words are placeholders.  This produces the
        section as the machine has it.

        Transcribed from ~/gc_refs/dolsdk2001/src/os/OSLink.c:146-201.  `p` there is
        an ABSOLUTE pointer, which is why R_PPC_REL24 needs the site's runtime
        address and not just its offset.

        VALIDATED, not assumed: run against a section whose live bytes were read back
        out of the machine, this must reproduce them exactly.  See the self-test in
        __main__.
        """
        want = set(sections) if sections is not None else {
            s["idx"] for s in self.sections if s["size"] and not s["bss"]}
        out = {i: bytearray(self.section_bytes(i)) for i in want}
        for mid, r in self.all_relocs():
            sec, off, typ = r["site_sec"], r["site_off"], r["type"]
            if sec not in out or off + 4 > len(out[sec]):
                continue
            if mid != 0 and (mid, r["ref_sec"]) not in bases:
                raise KeyError(
                    f"no runtime base for module {mid} section {r['ref_sec']} "
                    f"(needed by a {RTYPE.get(typ, typ)} at sec{sec}+{off:#x}). "
                    f"A BSS section's address is assigned from OSLink's `bss` pointer "
                    f"(OSLink.c:236-240) and is NOT derivable from the file -- take it "
                    f"from __OSModuleInfoList.")
            base = 0 if mid == 0 else bases[(mid, r["ref_sec"])]
            x = (base + r["addend"]) & 0xFFFFFFFF
            buf = out[sec]
            if typ == R_PPC_ADDR32:
                struct.pack_into('>I', buf, off, x)
            elif typ == R_PPC_ADDR24:
                w = struct.unpack_from('>I', buf, off)[0]
                struct.pack_into('>I', buf, off,
                                 (w & ~0x03FFFFFC) | (x & 0x03FFFFFC))
            elif typ in (R_PPC_ADDR16, R_PPC_ADDR16_LO):
                struct.pack_into('>H', buf, off, x & 0xFFFF)
            elif typ == R_PPC_ADDR16_HI:
                struct.pack_into('>H', buf, off, (x >> 16) & 0xFFFF)
            elif typ == R_PPC_ADDR16_HA:
                struct.pack_into('>H', buf, off,
                                 ((x >> 16) + (1 if (x & 0x8000) else 0)) & 0xFFFF)
            elif typ == R_PPC_REL24:
                p = (bases[(self.id, sec)] + off) & 0xFFFFFFFF
                d = (x - p) & 0xFFFFFFFF
                w = struct.unpack_from('>I', buf, off)[0]
                struct.pack_into('>I', buf, off,
                                 (w & ~0x03FFFFFC) | (d & 0x03FFFFFC))
        return {i: bytes(b) for i, b in out.items()}


# ------------------------------------------------------- translatability probe
def decode_exec(rel):
    """Decode every word of every executable section. Returns counters.

    A REL's branch fields are placeholders until OSLink patches them, so this
    measures INSTRUCTION-FORM legality (can this opcode be modelled at all), not
    branch resolution — branch resolution comes from the relocation table, which is
    handled separately in reloc_targets()."""
    img = sr.Image()
    for s in rel.exec_sections():
        img.segs.append((s["idx"] << 24, rel.section_bytes(s["idx"])))
    img.segs.sort()
    ok = bad = 0
    reasons = collections.Counter()
    priv = 0
    for s in rel.exec_sections():
        base = s["idx"] << 24
        blob = rel.section_bytes(s["idx"])
        t = sr.Translator(img, base, base + len(blob))
        for off in range(0, len(blob) - 3, 4):
            w = struct.unpack('>I', blob[off:off + 4])[0]
            try:
                t.inst(base + off, w)
                ok += 1
            except sr.Untranslatable as e:
                bad += 1
                why = e.why.split('(')[0].strip()
                reasons[why] += 1
                if ('privileged' in e.why or why == 'sc' or why == 'rfi'
                        or 'host boundary' in e.why):
                    priv += 1
    return {"ok": ok, "bad": bad, "reasons": reasons, "privileged": priv}


def reloc_targets(rel):
    """Every branch relocation, resolved to (module id, section, offset).

    This is the cross-reference the DOL does not have: a REL24 site is a `bl`/`b`
    whose callee is NAMED by the relocation, so a static recompiler never has to
    guess a call target inside a REL."""
    out = []
    for mid, r in rel.all_relocs():
        if r["type"] in (R_PPC_REL24, R_PPC_ADDR24):
            out.append({"mod": mid, "sec": r["ref_sec"], "off": r["addend"],
                        "site_sec": r["site_sec"], "site_off": r["site_off"],
                        "type": r["type"]})
    return out


def branch_analysis(rel):
    """Classify every branch in every exec section.

    THE LOAD-BEARING QUESTION for AOT overlay translation: a branch that is NOT at a
    relocation site must already be correct in the shipped bytes, because nothing will
    ever patch it.  For a PC-relative branch inside a section that moves as one unit
    that is exactly right — but it has to be MEASURED, not assumed, so this checks
    that every unrelocated branch target actually lands inside its own exec section.
    """
    sites = {}
    for mid, r in rel.all_relocs():
        if r["type"] in (R_PPC_REL24, R_PPC_ADDR24):
            sites[(r["site_sec"], r["site_off"])] = mid
    st = {"total": 0, "relocated": 0, "internal": 0, "escaping": [],
          "bl_internal": 0, "bl_relocated": 0, "absolute": 0,
          "reloc_by_mod": collections.Counter(), "targets": set()}
    for s in rel.exec_sections():
        blob = rel.section_bytes(s["idx"])
        n = len(blob)
        for off in range(0, n - 3, 4):
            w = struct.unpack('>I', blob[off:off + 4])[0]
            op = w >> 26
            if op not in (16, 18):
                continue
            aa = (w >> 1) & 1
            lk = w & 1
            st["total"] += 1
            key = (s["idx"], off)
            if key in sites:
                st["relocated"] += 1
                st["reloc_by_mod"][sites[key]] += 1
                st["bl_relocated"] += lk
                continue
            if aa:
                st["absolute"] += 1
                continue
            if op == 18:
                li = (w & 0x03FFFFFC)
                if li & 0x02000000:
                    li -= 0x04000000
                tgt = off + li
            else:
                bd = w & 0xFFFC
                if bd & 0x8000:
                    bd -= 0x10000
                tgt = off + bd
            if 0 <= tgt < n:
                st["internal"] += 1
                st["bl_internal"] += lk
                if lk:
                    st["targets"].add((s["idx"], tgt))
            else:
                st["escaping"].append((s["idx"], off, w, tgt))
    return st


# A REL has no load address until OSLink runs, so translation happens against a
# SYMBOLIC base.  This value is only a placeholder inside the translator's address
# space; nothing about it reaches the generated code as a constant.
MODULE_VBASE = 0x90000000


def discover_functions(rel):
    """Function entries inside an overlay, WITHOUT a symbol map.

    Three independent sources, all of them stated by the file rather than guessed:
      1. `bl` targets in the shipped bytes  — direct calls, already PC-correct
      2. ADDR32 self-relocations that point INTO the executable section — these are
         the vtables and switch/jump tables, i.e. exactly the targets a `bctr`/`blrl`
         reaches.  The DOL has no equivalent table, which is why its indirect
         branches are unresolvable and an overlay's are not.
      3. ADDR16_HA self-relocations that point INTO the executable section.  This is
         the one that is easy to miss and it matters: a function pointer handed to a
         callback registrar is materialised by `lis rX,f@ha ; addi rX,rX,f@l`, not by
         a stored ADDR32.  On stg13D these are 401 distinct targets of which only 13
         are named any other way — i.e. skipping them loses ~390 entry points and the
         whole subtree hanging off each.  The HA addend is the full target address
         (OSLink.c:170-176 computes x = offset + addend and then takes its halves).
      4. prolog / epilog / unresolved from the module header
    """
    st = branch_analysis(rel)
    exec_idx = {s["idx"] for s in rel.exec_sections()}
    entries, src = {}, collections.Counter()

    for sec, off in st["targets"]:
        entries.setdefault((sec, off), "bl"); src["bl target"] += 1
    for mid, r in rel.all_relocs():
        if mid != rel.id or r["ref_sec"] not in exec_idx:
            continue
        key = (r["ref_sec"], r["addend"])
        if r["type"] == R_PPC_ADDR32 and key not in entries:
            entries[key] = "addr32"
            src["ADDR32 into code (vtable / jump table)"] += 1
        elif r["type"] == R_PPC_ADDR16_HA and key not in entries:
            entries[key] = "ha"
            src["ADDR16_HA into code (lis/addi function pointer)"] += 1
    for sec, off, what in ((rel.prolog_sec, rel.prolog, "prolog"),
                           (rel.epilog_sec, rel.epilog, "epilog"),
                           (rel.unresolved_sec, rel.unresolved, "unresolved")):
        if sec in exec_idx and (sec, off) not in entries:
            entries[(sec, off)] = what; src[what] += 1
    return entries, src


import re as _re
_NOTSTART = _re.compile(r'^branch target 0x([0-9a-f]+) is not a function start$')


def function_bodies(rel, entries):
    """Intra-procedural reachability from each CALL target — the real body, not
    [entry, next entry).

    WHY NOT "next entry".  Splitting at every branch target looks fine per-instruction
    and is a trap: a loop that straddles a split turns into C tail-call recursion, one
    host frame per guest iteration, and the host stack dies.  Register and memory
    effects would still be right, which is exactly what makes it dangerous — it passes
    a differential and fails on a long-running scene.

    So boundaries come ONLY from call targets (bl targets, code addresses in vtables /
    jump tables, prolog/epilog), and each body is grown by following intra-procedural
    edges: fall-through, conditional-branch both ways, unconditional branch.  Traversal
    stops at another call target — that is a tail call, not a continuation.
    """
    exec_idx = {s["idx"]: s["size"] for s in rel.exec_sections()}
    bysec = collections.defaultdict(set)
    for sec, off in entries:
        if sec in exec_idx:
            bysec[sec].add(off)
    out = {}
    for sec, size in exec_idx.items():
        blob = rel.section_bytes(sec)
        entset = bysec[sec]
        for E in sorted(entset):
            seen, work = set(), [E]
            while work:
                o = work.pop()
                if o in seen or not (0 <= o < size - 3):
                    continue
                if o != E and o in entset:
                    continue                       # tail call into another function
                seen.add(o)
                w = struct.unpack('>I', blob[o:o + 4])[0]
                op, lk, aa = w >> 26, w & 1, (w >> 1) & 1
                if op == 18 and not aa:
                    li = w & 0x03FFFFFC
                    if li & 0x02000000:
                        li -= 0x04000000
                    if not lk:
                        work.append(o + li)        # b: terminator, one successor
                        continue
                elif op == 16 and not aa:
                    bd = w & 0xFFFC
                    if bd & 0x8000:
                        bd -= 0x10000
                    work.append(o + bd)
                    if lk:                          # bcl still returns here
                        work.append(o + 4)
                    else:
                        bo = (w >> 21) & 31
                        if (bo & 20) != 20:         # conditional: also falls through
                            work.append(o + 4)
                        continue
                elif op == 19 and ((w >> 1) & 0x3FF) == 16 and not lk:
                    bo = (w >> 21) & 31
                    if (bo & 20) == 20:
                        continue                    # blr: terminator
                elif op == 19 and ((w >> 1) & 0x3FF) == 528:
                    if not lk:
                        continue                    # bctr: terminator, target unknown
                work.append(o + 4)
            lo, hi = min(seen), max(seen) + 4
            out[(sec, E)] = {"lo": lo, "hi": hi, "n": len(seen),
                             "contiguous": len(seen) * 4 == hi - lo,
                             "starts_at_entry": lo == E}
    return out


def branch_relocs(rel, mod_vbase):
    """site virtual address -> resolved branch target virtual address.

    OSLink.c:139-142: for imp->id == 0 the section offset is 0, so the addend IS an
    absolute address in the static DOL.  For any other module the value is that
    module's section base plus the addend, which `mod_vbase(id, sec)` supplies."""
    out = {}
    for mid, r in rel.all_relocs():
        if r["type"] not in (R_PPC_REL24, R_PPC_ADDR24):
            continue
        site = mod_vbase(rel.id, r["site_sec"]) + r["site_off"]
        out[site] = (r["addend"] if mid == 0
                     else mod_vbase(mid, r["ref_sec"]) + r["addend"])
    return out


def split_dol_units_for(rel, units, verbose=False):
    """Split DOL boundary units at every entry point the OVERLAY's relocations name.

    THE GAP THIS CLOSES.  sr.recover_boundaries derives DOL function starts from the
    symbol map plus the DOL's OWN call graph.  An overlay calls into the DOL through
    R_PPC_REL24 relocations, which that call graph never sees -- so a DOL entry point
    used ONLY by overlays is not a "function start", and sr.Translator.callexpr
    refuses to dispatch to it rather than silently entering mid-function.

    Measured on stg13D: 10 of the 400 distinct DOL targets its relocation table names
    are not starts under boundaries=outer+calls, all of them inside Metrowerks'
    multi-entry `__save_gpr` / `__restore_gpr` (0x8010af98 / 0x8010afe4) -- where
    entering at offset N is the entire point of the idiom.  Those 10 blocked 35 of
    1,141 overlay entries from translating at all.

    Splitting is semantically neutral: sr.Translator emits a fall-through as an
    explicit tail call to the next start, so cutting one guest function into two
    changes granularity, not behaviour (the same argument translate_module() relies
    on for its entry fixpoint).
    """
    extra = {r["addend"] for mid, r in rel.all_relocs()
             if mid == 0 and r["type"] in (R_PPC_REL24, R_PPC_ADDR24)}
    starts = {lo for lo, _, _ in units}
    cut = sorted(extra - starts)
    if not cut:
        return units
    out = []
    for lo, size, name in sorted(units):
        inside = [c for c in cut if lo < c < lo + size]
        if not inside:
            out.append((lo, size, name))
            continue
        bounds = [lo] + inside + [lo + size]
        for i in range(len(bounds) - 1):
            out.append((bounds[i], bounds[i + 1] - bounds[i],
                        name if i == 0 else f"{name}+{bounds[i] - lo:#x}"))
    if verbose:
        print(f"[rel] split {len(units)} DOL units -> {len(out)} at "
              f"{len(cut)} overlay-only entry point(s): "
              + ", ".join(f"{c:#010x}" for c in cut))
    return sorted(out)


def translate_module_reach(rel, dol_starts=frozenset(), max_rounds=16, verbose=False):
    """The overlay translation pass: reachability bodies + tail-call fixpoint +
    relocation-aware branches.  Returns per-function translatability."""
    exec_idx = {s["idx"]: s["size"] for s in rel.exec_sections()}
    va = lambda sec, off: MODULE_VBASE + (sec << 24) + off        # noqa: E731
    mod_vbase = lambda mid, sec: (MODULE_VBASE + (sec << 24) if mid == rel.id
                                  else 0xA0000000 + (mid << 20) + (sec << 12))
    breloc = branch_relocs(rel, mod_vbase)
    reloc_sites = {(r["site_sec"], r["site_off"]) for _, r in rel.all_relocs()
                   if r["type"] in (R_PPC_REL24, R_PPC_ADDR24)}

    img = sr.Image()
    for i in exec_idx:
        img.segs.append((va(i, 0), rel.section_bytes(i)))
    img.segs.sort()

    entries, src = discover_functions(rel)
    rounds = []
    for rnd in range(max_rounds):
        bodies = function_bodies(rel, entries)
        new = set()
        for (sec, E), v in bodies.items():
            blob = rel.section_bytes(sec)
            reached = set(range(v["lo"], v["hi"], 4)) if v["contiguous"] else None
            for k in range(v["lo"], v["hi"], 4):
                w = struct.unpack('>I', blob[k:k + 4])[0]
                op = w >> 26
                if op not in (16, 18) or ((w >> 1) & 1):
                    continue
                if (sec, k) in reloc_sites:
                    continue                       # cross-module, target is named
                if op == 18:
                    li = w & 0x03FFFFFC
                    if li & 0x02000000:
                        li -= 0x04000000
                    tgt = k + li
                else:
                    bd = w & 0xFFFC
                    if bd & 0x8000:
                        bd -= 0x10000
                    tgt = k + bd
                linking = bool(w & 1)
                inside = v["lo"] <= tgt < v["hi"]
                if not linking and (inside or tgt == v["hi"]):
                    continue
                if 0 <= tgt < exec_idx[sec] and (sec, tgt) not in entries:
                    new.add((sec, tgt))
        rounds.append({"round": rnd, "entries": len(entries), "bodies": len(bodies),
                       "new": len(new)})
        if verbose:
            print(f"    round {rnd}: entries={len(entries)} bodies={len(bodies)} "
                  f"newly discovered tail-call/`bl` targets={len(new)}")
        if not new:
            break
        for k in new:
            entries.setdefault(k, "tail-call / bl target (fixpoint)")
            src["tail-call / bl target (fixpoint)"] += 1

    starts = {va(sec, off) for sec, off in entries}
    starts |= {va(i, sz) for i, sz in exec_idx.items()}
    starts |= set(dol_starts)
    starts |= set(breloc.values())
    ok = bad = ok_i = bad_i = 0
    reasons = collections.Counter()
    ext = collections.Counter()
    for (sec, E), v in bodies.items():
        lo, hi = va(sec, v["lo"]), va(sec, v["hi"])
        t = sr.Translator(img, lo, hi, starts=starts, branch_reloc=breloc)
        try:
            t.translate()
            ok += 1; ok_i += (hi - lo) // 4
            for c in t.calls:
                if not (va(sec, 0) <= c < va(sec, exec_idx[sec])):
                    ext[c] += 1
        except sr.Untranslatable as e:
            bad += 1; bad_i += (hi - lo) // 4
            reasons[e.why.split('(')[0].strip()] += 1
    reached = sum(v["n"] for v in bodies.values())
    return {"entries": entries, "src": src, "rounds": rounds, "bodies": bodies,
            "ok": ok, "bad": bad, "ok_i": ok_i, "bad_i": bad_i, "reasons": reasons,
            "external_calls": ext, "reached": reached,
            "contiguous": sum(1 for v in bodies.values() if v["contiguous"])}


def translate_module(rel, max_rounds=24, verbose=False):
    """Per-function translatability of an overlay, with real branch validation.

    Function bodies are [entry, next entry) inside the same section, and every branch
    is checked against the entry set — a branch into the middle of another function is
    an error, not a silent mid-function dispatch.

    ENTRY DISCOVERY IS A FIXPOINT.  An overlay has no symbol map, so the initial entry
    set (bl targets + vtable/jump-table ADDR32s + prolog/epilog) is incomplete.  Any
    branch that leaves its own function must, in well-formed code, land on a function
    entry — so each such complaint IS a newly discovered entry.  Feed them back and
    repeat until nothing new appears.

    This is only sound because sr.Translator emits a fall-through as an explicit tail
    call to the next entry: splitting one guest function in two is then semantically
    neutral, so an over-eager entry never changes behaviour, only granularity.
    """
    entries, src = discover_functions(rel)
    img = sr.Image()
    for s in rel.exec_sections():
        img.segs.append((MODULE_VBASE + (s["idx"] << 24), rel.section_bytes(s["idx"])))
    img.segs.sort()
    va = lambda sec, off: MODULE_VBASE + (sec << 24) + off        # noqa: E731
    secsize = {s["idx"]: s["size"] for s in rel.exec_sections()}

    rounds = []
    for rnd in range(max_rounds):
        starts = {va(sec, off) for sec, off in entries}
        # the address one past each section is a legal tail-call target for code that
        # falls off the end (trailing padding); it resolves to sr_extern and faults.
        starts |= {va(i, sz) for i, sz in secsize.items()}
        bysec = collections.defaultdict(list)
        for sec, off in entries:
            bysec[sec].append(off)
        fns = []
        for i, sz in secsize.items():
            offs = sorted(bysec.get(i, []))
            for k, off in enumerate(offs):
                fns.append((i, off, (offs[k + 1] if k + 1 < len(offs) else sz) - off))

        ok = bad = ok_i = bad_i = 0
        reasons = collections.Counter()
        new = set()
        for sec, off, size in fns:
            lo = va(sec, off)
            # Collect EVERY out-of-function branch target in one pass.  Relying on
            # translate()'s first exception discovers one entry per function per
            # round, which converges but takes hundreds of rounds on a 94k-instruction
            # overlay; this converges in a handful.
            blob = rel.section_bytes(sec)
            for k in range(off, off + size, 4):
                w = struct.unpack('>I', blob[k:k + 4])[0]
                op = w >> 26
                if op not in (16, 18) or ((w >> 1) & 1):
                    continue
                if op == 18:
                    li = w & 0x03FFFFFC
                    if li & 0x02000000:
                        li -= 0x04000000
                    tgt = k + li
                else:
                    bd = w & 0xFFFC
                    if bd & 0x8000:
                        bd -= 0x10000
                    tgt = k + bd
                # A LINKING branch is a call: its target must be a function entry even
                # when it lands inside the caller's own range.  A non-linking branch
                # inside the range is ordinary intra-function control flow.
                linking = bool(w & 1)
                if not linking and ((off <= tgt < off + size) or tgt == off + size):
                    continue
                if 0 <= tgt < secsize[sec] and (sec, tgt) not in entries:
                    new.add((sec, tgt))
            try:
                sr.Translator(img, lo, lo + size, starts=starts).translate()
                ok += 1; ok_i += size // 4
            except sr.Untranslatable as e:
                bad += 1; bad_i += size // 4
                reasons[e.why.split('(')[0].strip()] += 1
        rounds.append({"round": rnd, "entries": len(entries), "fns": len(fns),
                       "ok": ok, "bad": bad, "ok_i": ok_i, "bad_i": bad_i,
                       "new": len(new), "reasons": reasons})
        if verbose:
            print(f"    round {rnd}: entries={len(entries)} clean={ok} blocked={bad} "
                  f"newly discovered entries={len(new)}")
        if not new:
            break
        for k in new:
            entries.setdefault(k, "discovered by branch-target fixpoint")
            src["discovered by branch-target fixpoint"] += 1
    last = rounds[-1]
    return {"entries": entries, "src": src, "rounds": rounds, "fns": fns,
            "ok": last["ok"], "bad": last["bad"], "ok_i": last["ok_i"],
            "bad_i": last["bad_i"], "reasons": last["reasons"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--iso', required=True)
    ap.add_argument('--inventory', action='store_true')
    ap.add_argument('--report')
    ap.add_argument('--translatability')
    ap.add_argument('--branches')
    ap.add_argument('--survey', action='store_true')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--check-relocate', nargs=2, metavar=('REL', 'LIVE_SECTION'),
                    help='SELF-TEST for Rel.relocate(): apply OSLink Relocate() offline '
                         'to REL and require the result to equal LIVE_SECTION, a dump of '
                         'that section read back out of a running machine.  Needs '
                         '--sections idx=hexaddr for every section (from '
                         '__OSModuleInfoList).  Also asserts the RAW file bytes differ, '
                         'so a broken relocation cannot pass by doing nothing.')
    ap.add_argument('--sections', action='append', default=[], metavar='IDX=HEXADDR')
    a = ap.parse_args()

    d = Disc(a.iso)
    rels = [f for f in d.files if f["path"].lower().endswith('.rel')]

    if a.check_relocate:
        name, livepath = a.check_relocate
        ent = next(f for f in d.files
                   if f["name"] == name or f["path"].endswith(name))
        r = Rel(d.read_file(ent), ent["path"])
        bases = {}
        for spec in a.sections:
            i, addr = spec.split('=')
            bases[(r.id, int(i))] = int(addr, 16)
        if not bases:
            raise SystemExit("--check-relocate needs --sections IDX=HEXADDR "
                             "(from __OSModuleInfoList)")
        sec = r.exec_sections()[0]["idx"]
        live = open(livepath, 'rb').read()
        raw = r.section_bytes(sec)
        if len(live) != len(raw):
            raise SystemExit(f"{livepath} is {len(live)} B, section {sec} is {len(raw)} B")
        mine = r.relocate(bases, sections=[sec])[sec]
        nd = sum(1 for i in range(0, len(raw), 4) if raw[i:i + 4] != live[i:i + 4])
        bad = [i for i in range(len(live)) if mine[i] != live[i]]
        print(f"{ent['path']} sec{sec} @ {bases[(r.id, sec)]:#010x}: {len(raw)} bytes")
        print(f"  words the relocation must change: {nd}")
        print(f"  RAW file bytes == live            : {raw == live}  "
              f"(must be False, or the test is vacuous)")
        print(f"  offline-relocated == live          : {not bad}"
              + (f"  ({len(bad)} bytes differ, first at +{bad[0]:#x})" if bad else ""))
        if bad or raw == live or nd == 0:
            print("FAIL")
            sys.exit(1)
        print("PASS — Rel.relocate() reproduces what OSLink actually wrote")
        return

    if a.inventory:
        print(f"disc FST: {len(d.files)} files, dol@{d.dol_off:#x} fst@{d.fst_off:#x}")
        print(f".rel overlays: {len(rels)}, {sum(f['size'] for f in rels)} bytes")
        tot_exec = tot_reloc = tot_bss = 0
        typec = collections.Counter()
        extmods = collections.Counter()
        rows = []
        for f in rels:
            r = Rel(d.read_file(f), f["path"])
            ex = r.exec_bytes()
            nrel = sum(len(i["relocs"]) for i in r.imports)
            tot_exec += ex
            tot_reloc += nrel
            tot_bss += r.bss_size
            for _, rr in r.all_relocs():
                typec[rr["type"]] += 1
            for i in r.imports:
                extmods[i["id"]] += 1
            rows.append((ex, f["path"], r, nrel))
        rows.sort(reverse=True)
        print(f"executable bytes across all overlays: {tot_exec} "
              f"({tot_exec // 4} instructions)")
        print(f"bss bytes: {tot_bss}   relocation entries: {tot_reloc}")
        print("\nrelocation types across all overlays:")
        for t, c in typec.most_common():
            print(f"  {c:9d}  {RTYPE.get(t, t)}")
        print("\nimport-table module ids (0 = the static DOL):")
        for m, c in extmods.most_common(12):
            print(f"  id {m:<5d} appears in {c} overlays")
        print(f"\nlargest overlays by executable bytes:")
        for ex, path, r, nrel in rows[:a.limit or 15]:
            print(f"  {path:28s} id={r.id:<4d} v{r.version} sections={r.num_sections:2d} "
                  f"exec={ex:8d} ({ex // 4:7d} insts) bss={r.bss_size:8d} relocs={nrel:7d}")
        return

    if a.translatability == 'ALL':
        agg = collections.Counter()
        reasons = collections.Counter()
        worst = []
        for f in rels:
            r = Rel(d.read_file(f), f["path"])
            st = decode_exec(r)
            agg["ok"] += st["ok"]; agg["bad"] += st["bad"]; agg["priv"] += st["privileged"]
            reasons.update(st["reasons"])
            worst.append((st["bad"], f["path"], st["ok"] + st["bad"]))
        tot = agg["ok"] + agg["bad"]
        print(f"ALL {len(rels)} overlays: {tot} instructions decoded")
        print(f"  clean      : {agg['ok']}  ({100.0 * agg['ok'] / tot:.4f}%)")
        print(f"  blocked    : {agg['bad']}  ({100.0 * agg['bad'] / tot:.4f}%)")
        print(f"  PRIVILEGED : {agg['priv']}")
        for w, c in reasons.most_common(20):
            print(f"    {c:8d}  {w}")
        worst.sort(reverse=True)
        print("  overlays with the most blocked instructions:")
        for bad, path, tot1 in worst[:8]:
            print(f"    {path:24s} {bad:6d} blocked of {tot1}")
        return

    if a.survey:
        # Does the whole overlay set share stg13D's shape?  Three properties decide
        # whether one AOT design covers all 76: how many exec sections a module has,
        # whether any module relocates a branch to ITSELF, and whether any branch that
        # is not relocated escapes its own section.
        print(f"{'overlay':22s} {'id':>4s} {'exec':>3s} {'insts':>8s} {'branches':>9s} "
              f"{'reloc':>7s} {'internal':>9s} {'escape':>7s} {'abs':>4s} {'selfREL24':>10s}")
        agg = collections.Counter()
        multi = []
        for f in rels:
            r = Rel(d.read_file(f), f["path"])
            st = branch_analysis(r)
            self_rel24 = st["reloc_by_mod"].get(r.id, 0)
            nx = len(r.exec_sections())
            if nx != 1:
                multi.append((f["path"], nx))
            agg["branches"] += st["total"]; agg["reloc"] += st["relocated"]
            agg["internal"] += st["internal"]; agg["escape"] += len(st["escaping"])
            agg["abs"] += st["absolute"]; agg["selfrel24"] += self_rel24
            agg["insts"] += r.exec_bytes() // 4; agg["targets"] += len(st["targets"])
            print(f"{f['path']:22s} {r.id:4d} {nx:3d} {r.exec_bytes()//4:8d} {st['total']:9d} "
                  f"{st['relocated']:7d} {st['internal']:9d} {len(st['escaping']):7d} "
                  f"{st['absolute']:4d} {self_rel24:10d}")
        print(f"\nTOTAL  instructions={agg['insts']}  branches={agg['branches']}  "
              f"relocated={agg['reloc']}  internal={agg['internal']}  "
              f"escaping={agg['escape']}  absolute={agg['abs']}  "
              f"self-REL24={agg['selfrel24']}")
        print(f"distinct internal `bl` targets (function entries named by the code "
              f"itself): {agg['targets']}")
        print(f"overlays with != 1 executable section: {len(multi)}"
              + ("" if not multi else "  " + str(multi[:10])))
        return

    name = a.report or a.translatability or a.branches
    ent = next((f for f in rels if f["path"].endswith(name) or f["name"] == name), None)
    if not ent:
        print(f"no such overlay: {name}", file=sys.stderr)
        sys.exit(1)
    r = Rel(d.read_file(ent), ent["path"])

    if a.report:
        print(f"{ent['path']}  {ent['size']} bytes  id={r.id} version={r.version}")
        print(f"  bss={r.bss_size} align={r.align} bssAlign={r.bss_align} fixSize={r.fix_size}")
        print(f"  prolog=sec{r.prolog_sec}+{r.prolog:#x} epilog=sec{r.epilog_sec}+{r.epilog:#x} "
              f"unresolved=sec{r.unresolved_sec}+{r.unresolved:#x}")
        print(f"  sections ({r.num_sections}):")
        for s in r.sections:
            kind = "EXEC" if s["exec"] else ("BSS " if s["bss"] else "data")
            print(f"    [{s['idx']:2d}] {kind} offset={s['offset']:#010x} size={s['size']:#010x}"
                  f" ({s['size']} bytes)")
        print(f"  imports ({len(r.imports)}):")
        for i in r.imports:
            tc = collections.Counter(x["type"] for x in i["relocs"])
            what = "the static DOL" if i["id"] == 0 else \
                   ("SELF" if i["id"] == r.id else f"module {i['id']}")
            print(f"    id={i['id']:<5d} {what:16s} {len(i['relocs']):7d} relocs  " +
                  " ".join(f"{RTYPE.get(t,t).replace('R_PPC_','')}={c}"
                           for t, c in tc.most_common()))
        return

    if a.translatability:
        st = decode_exec(r)
        tot = st["ok"] + st["bad"]
        print(f"{ent['path']}: {tot} instructions in {len(r.exec_sections())} exec section(s)")
        print(f"  decode clean : {st['ok']}  ({100.0 * st['ok'] / tot:.2f}%)")
        print(f"  blocked      : {st['bad']}  ({100.0 * st['bad'] / tot:.2f}%)")
        print(f"  privileged   : {st['privileged']}")
        for w, c in st["reasons"].most_common(20):
            print(f"    {c:7d}  {w}")
        tg = reloc_targets(r)
        bysec = collections.Counter(t["mod"] for t in tg)
        print(f"  branch relocations (REL24/ADDR24): {len(tg)}")
        for m, c in bysec.most_common():
            what = "static DOL" if m == 0 else ("SELF" if m == r.id else f"module {m}")
            print(f"    {c:7d} -> {what}")
        entries = sorted({(t["mod"], t["sec"], t["off"]) for t in tg if t["mod"] == r.id})
        print(f"  distinct in-module call targets named by relocations: {len(entries)}")
        return

    if a.branches:
        st = branch_analysis(r)
        print(f"{ent['path']}: {st['total']} branch instructions in "
              f"{len(r.exec_sections())} exec section(s)")
        print(f"  relocated (cross-module, target NAMED by the reloc table): "
              f"{st['relocated']}  ({st['bl_relocated']} of them linking)")
        for m, c in st["reloc_by_mod"].most_common():
            print(f"      {c:7d} -> " + ("static DOL" if m == 0 else
                                         ("SELF" if m == r.id else f"module {m}")))
        print(f"  NOT relocated, target lands INSIDE its own exec section: "
              f"{st['internal']}  ({st['bl_internal']} of them linking)")
        print(f"  NOT relocated, target ESCAPES the section: {len(st['escaping'])}")
        for sec, off, w, tgt in st["escaping"][:10]:
            print(f"      sec{sec}+{off:#x}: {w:08x} -> {tgt:#x}")
        print(f"  absolute (ba/bla): {st['absolute']}")
        print(f"  distinct internal `bl` targets = function entries the CODE names: "
              f"{len(st['targets'])}")
        return


if __name__ == '__main__':
    main()

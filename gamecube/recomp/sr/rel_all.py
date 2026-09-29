#!/usr/bin/env python3
"""rel_all.py — translate SAB's REL overlays AHEAD OF TIME, position-independently, from the disc.

  python3 gamecube/recomp/sr/rel_all.py --iso sab.iso --dispatch <img>/sr_dispatch.c \
      --dol <img>/sab_main.dol --out <img>/ov_all.c [--rel mcwarnD.rel --rel stg13D.rel ...] \
      [--idle-skip]            (no --rel: every REL on the disc)

WHY POSITION-INDEPENDENT.  SAB's loader (LoadRel, 0x80019e70) has two arms: mode 0 reads the
file to the FIXED address 0x811FFE60 (lis 0x8120 / addi -416 at 0x80019ed8-0x80019ee0), any other
mode reads it into a HEAP block (0x801197d0, 0x80019f78) whose address depends on the heap's
history.  A translation baked at one address (rel_image.py) therefore cannot serve the second
arm.  Here every module is translated against a SYMBOLIC layout and every address it
materialises is an expression over a runtime table sr_image.c fills from the LINKED module
header (OSLink turns each OSSectionInfo.offset into an absolute address, OSLink.c:236-247).

THE LAYOUT.  Module slot k (file order): file-backed sections at VB(k) + section.offset
(OSLink.c:236-240 loads the blob contiguously at the header and sections sit at their file
offsets), the BSS section at VBSS(k) (OSLink assigns it from its own `bss` argument).  All
relocations are applied with those bases (rel.Rel.relocate, a transcription of OSLink.c
Relocate), so control flow, switch tables and busy-wait detection see a consistent module.

WHAT BECOMES AN EXPRESSION (and nothing else does):
  * an ADDR16_LO/HI/HA site whose target is a MODULE (self or other; DOL targets are absolute
    and stay literal): addis/addi/ori and every D-form load/store take
    SR_HA/SR_HI/SR_LO(g_ov_sec[id][sec] + addend);
  * every return address the translation writes (st->lr = CIA+4 at bl/bcl/blrl/bctrl);
  * a call to a module function this build does not contain -> sr_indirect(real address);
  * a recovered switch table's key: (ctr - runtime exec base + symbolic exec base), so the case
    labels stay the symbolic constants the table was recovered with.
g_ov_sec[id][sec] is filled by sr_image.c from __OSModuleInfoList before any entry runs.

THE GUARD.  Per module: its id, exec section, sizes, and FNV-1a of the exec section's FILE bytes
with every word a relocation touches zeroed (a bitmap is emitted) — exactly the bytes OSLink
leaves alone, so the hash is the same before and after linking, at any address.  sr_image.c
compares it against RAM before trusting an entry and reports the module (name, id) on a
mismatch.
"""
import argparse, collections, os, re, struct, sys


def write_if_changed(path, text):
    """Keep the mtime (and the build's compiled-object cache) when the content is the same."""
    if os.path.exists(path) and open(path).read() == text:
        return
    open(path, 'w').write(text)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rel as R      # noqa: E402
import sr            # noqa: E402

VB0, VSTRIDE = 0x90000000, 0x00400000     # file-backed: 76 slots x 4 MB = 0x90000000..0xA3000000
VBSS0, VBSTRIDE = 0xA4000000, 0x00100000  # BSS: max 409,476 B on this disc, 1 MB slots


def fnv1a(b):
    h = 2166136261
    for x in b:
        h = ((h ^ x) * 16777619) & 0xFFFFFFFF
    return h


class ModT(sr.Translator):
    """sr.Translator with the position-independence hooks (sr.py 'HOOKS')."""

    def __init__(self, *a, mod=None, **k):
        super().__init__(*a, **k)
        self.mod = mod

    def _sym(self, v):
        return self.mod['sym_to_expr'](v)

    def addr_expr(self, v):
        e = self._sym(v)
        return e if e else super().addr_expr(v)

    def extern_expr(self, tgt):
        e = self._sym(tgt)
        return f"sr_indirect(st, {e});" if e else super().extern_expr(tgt)

    def jt_key(self):
        m = self.mod
        return (f"(st->ctr & ~3u) - g_ov_sec[{m['id']}][{m['esec']}] + {m['vexec']:#010x}u")

    def fix_fields(self, pc, f):
        r = self.mod['imm'].get(pc)
        if r is None:
            return None
        kind, expr = r
        op, A, D = f['op'], f['rA'], f['rD']
        mac = {'HA': 'SR_HA16', 'HI': 'SR_HI16', 'LO': 'SR_LO16'}[kind]
        v = f"{mac}({expr})"
        gp = lambda n: f"st->gpr[{n}]"                                    # noqa: E731
        if op == 15 and kind in ('HA', 'HI'):                            # addis
            return [f"{gp(D)} = " + (f"{gp(A)} + " if A else "") + f"((uint32_t){v} << 16);"]
        if op == 14 and kind == 'LO':                                    # addi
            return [f"{gp(D)} = " + (f"{gp(A)} + " if A else "") + f"(uint32_t)(int32_t)(int16_t){v};"]
        if op == 24 and kind == 'LO':                                    # ori
            return [f"{gp(A)} = {gp(D)} | (uint32_t){v};"]
        if kind == 'LO' and op in (32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45,
                                   46, 47, 48, 49, 50, 51, 52, 53, 54, 55):
            f['d'] = f"(int32_t)(int16_t){v}"                            # D-form load/store
            return None
        raise sr.Untranslatable(f"relocated immediate in op{op} ({kind})", pc, None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--iso', required=True)
    ap.add_argument('--dispatch', required=True)
    ap.add_argument('--dol', required=True)
    ap.add_argument('--map', default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                  '../../../dolphin_captures/sab.map'))
    ap.add_argument('--rel', action='append', default=[])
    ap.add_argument('--outdir', required=True, help='writes ov_<module>.c per module + ov_index.c')
    ap.add_argument('--idle-skip', action='store_true')
    ap.add_argument('--skiplist', help="the image's skiplist.json: emit its multi-entry DOL functions (ov_dolfix.c)")
    a = ap.parse_args()
    sr.RETIRE = True
    sr.IDLE_SKIP = a.idle_skip

    dol_emitted = {int(x, 16) for x in re.findall(r'case (0x[0-9a-f]{8})u: fn_', open(a.dispatch).read())}
    dimg = sr.Image.from_dol(a.dol)
    dunits = sr.recover_boundaries(dimg, sr.load_map(a.map), 'outer+calls', log=lambda m: None)
    dol_starts = {lo for lo, _, _ in dunits}

    disc = R.Disc(a.iso)
    files = sorted((f for f in disc.files if f['path'].lower().endswith('.rel')), key=lambda f: f['path'])
    mods = []
    for k, f in enumerate(files):
        m = R.Rel(disc.read_file(f), f['path'])
        mods.append({'k': k, 'rel': m, 'name': os.path.basename(f['path']), 'id': m.id})
    by_id = collections.defaultdict(list)
    for x in mods:
        by_id[x['id']].append(x)

    def vb(x):
        return VB0 + x['k'] * VSTRIDE

    def vbss(x):
        return VBSS0 + x['k'] * VBSTRIDE

    def sec_base(x, s):
        si = x['rel'].sections[s]
        return vbss(x) if si['bss'] else vb(x) + si['offset']

    want = set(a.rel) if a.rel else {x['name'] for x in mods}
    sel = [x for x in mods if x['name'] in want]
    if len(sel) != len(want):
        raise SystemExit('unknown REL(s): ' + ', '.join(sorted(want - {x['name'] for x in sel})))

    # symbolic address -> C expression over the runtime section table, for ANY module
    ranges = []
    for x in mods:
        for s in x['rel'].sections:
            if s['size']:
                ranges.append((sec_base(x, s['idx']), s['size'], x['id'], s['idx']))
    ranges.sort()

    def sym_to_expr(v):
        for lo, sz, mid, s in ranges:
            if lo <= v < lo + sz:
                return f"(g_ov_sec[{mid}][{s}] + {v - lo:#x}u)"
            if lo > v:
                break
        return None

    tables, dispatch, stats, idx_decl = [], [], [], []
    header = [sr.HEADER + (sr.IDLE_DECL if sr.IDLE_SKIP else ''),
              '\n// rel_all.py: position-independent overlays.  g_ov_sec is filled by sr_image.c.',
              'extern uint32_t g_ov_sec[128][20];',
              '#define SR_LO16(x) ((uint32_t)(x) & 0xFFFFu)',
              '#define SR_HI16(x) (((uint32_t)(x) >> 16) & 0xFFFFu)',
              '#define SR_HA16(x) ((((uint32_t)(x) >> 16) + (((uint32_t)(x) >> 15) & 1u)) & 0xFFFFu)']
    os.makedirs(a.outdir, exist_ok=True)
    dol_interior = set()   # overlay REL24 targets INSIDE a DOL unit (Metrowerks __save_gpr etc.)
    written = []
    for x in sel:
        m = x['rel']
        ex = m.exec_sections()
        if len(ex) != 1:
            raise SystemExit(f"{x['name']}: {len(ex)} exec sections")
        esec = ex[0]['idx']
        bases = {}
        for y in mods:
            for s in y['rel'].sections:
                if s['size']:
                    bases[(y['id'], s['idx'])] = sec_base(y, s['idx'])
        for y in by_id[x['id']]:                  # a duplicate id resolves to THIS module
            for s in y['rel'].sections:
                if s['size']:
                    bases[(x['id'], s['idx'])] = sec_base(x, s['idx'])
        relocated = m.relocate(bases)
        img = sr.Image()
        for s, blob in relocated.items():
            if blob:
                img.segs.append((sec_base(x, s), blob))
        img.segs += dimg.segs
        img.segs.sort()
        vexec = sec_base(x, esec)
        # relocation sites in the exec section: the guard's mask, and the relocated immediates
        imm, mask = {}, set()
        for mid, r in m.all_relocs():
            if r['site_sec'] != esec:
                continue
            t = r['type']
            if t in (R.R_PPC_ADDR16, R.R_PPC_ADDR16_LO, R.R_PPC_ADDR16_HI, R.R_PPC_ADDR16_HA):
                mask.add((r['site_off'] - 2) & ~3)
                if mid != 0:
                    k = {R.R_PPC_ADDR16: 'LO', R.R_PPC_ADDR16_LO: 'LO', R.R_PPC_ADDR16_HI: 'HI',
                         R.R_PPC_ADDR16_HA: 'HA'}[t]
                    imm[vexec + ((r['site_off'] - 2) & ~3)] = (k, f"(g_ov_sec[{mid}][{r['ref_sec']}] + {r['addend']:#x}u)")
            elif t != R.R_PPC_NONE:
                mask.add(r['site_off'] & ~3)
        fileb = bytearray(m.section_bytes(esec))
        for o in mask:
            fileb[o:o + 4] = b'\0\0\0\0'
        h = fnv1a(fileb)
        words = (len(fileb) + 3) // 4
        bits = [0] * ((words + 31) // 32)
        for o in mask:
            bits[(o // 4) // 32] |= 1 << ((o // 4) % 32)

        # function bodies (rel.translate_module_reach works in its own symbolic space: map offsets)
        res = R.translate_module_reach(m, dol_starts=frozenset(dol_starts))
        # two entries can share one body start (rel.translate_module_reach keys bodies by entry):
        # one function per start, the longest extent
        _b = {}
        for (s, E), v in res['bodies'].items():
            if s == esec:
                lo = vexec + v['lo']
                _b[lo] = max(_b.get(lo, 0), v['hi'] - v['lo'])
        bodies = sorted(_b.items())
        def mvb(mid, s):
            ys = [y for y in by_id[mid] if y is x] or by_id[mid]
            return sec_base(ys[0], s)
        breloc = R.branch_relocs(m, mvb)
        dol_interior.update(t for t in breloc.values() if 0x80000000 <= t < 0x81800000 and t not in dol_starts)
        starts = ({lo for lo, _ in bodies} | {vexec + off for (s, off) in res["entries"] if s == esec}
                  | dol_starts | set(breloc.values()))
        emitted = {lo for lo, _ in bodies} | dol_emitted
        mctx = {'id': x['id'], 'esec': esec, 'vexec': vexec, 'imm': imm, 'sym_to_expr': sym_to_expr}
        ok, bad, idle = [], [], 0
        out_fns, all_decl, used_dol = [], [], set()
        for lo, sz in sorted(bodies):
            t = ModT(img, lo, lo + sz, starts=starts, emitted=emitted, branch_reloc=breloc,
                     indirect=True, jumptables=True, mod=mctx)
            try:
                body = t.translate()
            except sr.Untranslatable as e:
                bad.append((lo, e.why))
                continue
            idle += len(t.idle_loops)
            name = f"{x['name']}+{lo - vexec:#x}"
            ok.append((lo, sz, name))
            all_decl.append(f'void fn_{lo:08x}(GekkoState *st);   /* {name} */')
            out_fns.append(f'\n// {name}  ({sz} bytes)\nvoid fn_{lo:08x}(GekkoState *st) {{')
            out_fns += body
            out_fns.append('}')
            used_dol |= {c for c in t.calls if c in dol_emitted}
        # an entry that did not translate is left out of the dispatch: a call to it faults
        for lo, sz, name in ok:
            dispatch.append(f'    case {lo:#010x}u: fn_{lo:08x}(st); return 1;   /* {name} */')
        idx_decl += all_decl
        mname = x['name'].replace('.', '_')
        # emitted calls to translated functions of OTHER modules in this build would need their
        # declarations: every cross-module call goes through sr_indirect, so there are none.
        path = os.path.join(a.outdir, f"ov_{mname}.c")
        write_if_changed(path, '\n'.join(header + ['\n// image DOL functions called directly'] +
                                         [f'void fn_{c:08x}(GekkoState *st);' for c in sorted(used_dol)] +
                                         ['\n// this module'] + all_decl + out_fns) + '\n')
        written.append(path)
        tables.append(f'static const uint32_t mask_{mname}[{len(bits)}] = {{' +
                      ','.join(f'{b:#x}u' for b in bits) + '};')
        tables.append(f'/* {x["name"]} */')
        stats.append((x, esec, len(fileb), h, mname, vexec, len(ok), len(bad), idle, m.sections[esec]['offset']))
        print(f"[rel_all] {x['name']:24s} id {x['id']:3d} exec sec{esec} {len(fileb):8d} B  "
              f"{len(ok)} fns, {len(bad)} refused, {len(imm)} relocated immediates, {idle} busy-wait loops,"
              f" guard hash {h:#010x}", file=sys.stderr)
        for lo, why in bad[:5]:
            print(f"    refused {lo - vexec:#x}: {why}", file=sys.stderr)

    # ---- DOL MULTI-ENTRY FUNCTIONS.  sr.py --all skips a DOL function whose tail branch lands
    # INSIDE another function (skiplist 'branch target ... is not a function start'; 3 in SAB:
    # 0x80057a08, 0x80057ea0, 0x8011c18c).  Overlays call them (measured: advertiseD reaches
    # 0x80057ea0).  Splitting a function at an interior entry is semantically neutral here (sr.py
    # emits fall-through as a tail call to the next entry), so each interior target becomes an entry
    # [target, end of its unit), to a fixpoint, emitted in ov_dolfix.c with its own dispatch.
    if a.skiplist:
        import json
        skipped = [x for x in json.load(open(a.skiplist)) if x['why'].startswith('branch target')]
        dunit = sorted(dunits)
        def unit_of(t):
            for lo, sz, nm in dunit:
                if lo <= t < lo + sz:
                    return lo, sz
            return None
        extra = {int(x['addr'], 16): x['size'] for x in skipped}
        for t in dol_interior:                   # rel.split_dol_units_for's case, as entries
            u = unit_of(t)
            if u:
                extra[t] = u[0] + u[1] - t
        fix_decl, fix_body, fix_disp = [], [], []
        for _ in range(16):
            new = {}
            starts2 = dol_starts | set(extra)
            emitted2 = dol_emitted | set(extra)
            for lo, sz in sorted(extra.items()):
                try:
                    sr.Translator(dimg, lo, lo + sz, starts=starts2, emitted=emitted2,
                                  indirect=True, jumptables=True).translate()
                except sr.Untranslatable as e:
                    m2 = re.search(r'branch target (0x[0-9a-f]+) is not a function start', e.why)
                    u = m2 and unit_of(int(m2.group(1), 16))
                    if not u:
                        raise SystemExit(f'dolfix: {lo:#x}: {e.why}')
                    t = int(m2.group(1), 16)
                    new[t] = u[0] + u[1] - t
            if not new:
                break
            extra.update(new)
        for lo, sz in sorted(extra.items()):
            t = sr.Translator(dimg, lo, lo + sz, starts=dol_starts | set(extra), emitted=dol_emitted | set(extra),
                              indirect=True, jumptables=True)
            body = t.translate()
            fix_decl.append(f'void fn_{lo:08x}(GekkoState *st);   /* dolfix entry */')
            fix_body += [f'\n// DOL entry {lo:#010x} ({sz} bytes)', f'void fn_{lo:08x}(GekkoState *st) {{'] + body + ['}']
            fix_disp.append(f'    case {lo:#010x}u: fn_{lo:08x}(st); return 1;')
            for c in t.calls:
                if c in dol_emitted:
                    fix_decl.append(f'void fn_{c:08x}(GekkoState *st);')
        open(os.path.join(a.outdir, 'ov_dolfix.c'), 'w').write('\n'.join(
            [sr.HEADER + (sr.IDLE_DECL if sr.IDLE_SKIP else '')] + sorted(set(fix_decl)) + fix_body +
            ['int sr_dol_extra_dispatch(uint32_t v, GekkoState *st) {', '    switch (v) {'] + fix_disp +
            ['    default: return 0;', '    }', '}']) + '\n')
        print(f"[rel_all] dolfix: {len(extra)} DOL entries: " + ', '.join(f'{x:#010x}' for x in sorted(extra)), file=sys.stderr)
    else:
        open(os.path.join(a.outdir, 'ov_dolfix.c'), 'w').write(
            '#include "gekko_rt.h"\nint sr_dol_extra_dispatch(uint32_t v, GekkoState *st) { (void)v; (void)st; return 0; }\n')

    src = header + ['\n// the overlay functions (one TU per module: ov_<module>.c)'] + idx_decl + \
        ['\n// ---- the guard tables'] + tables
    src.append('const struct { uint32_t id, esec, esize, hash, vexec, eoff; const uint32_t *mask; const char *name; } sr_ovm[] = {')
    for x, esec, esize, h, mname, vexec, nok, nbad, idle, eoff in stats:
        src.append(f'    {{{x["id"]}u, {esec}u, {esize:#x}u, {h:#010x}u, {vexec:#010x}u, {eoff:#x}u, mask_{mname}, "{x["name"]}"}},')
    src.append('};')
    src.append(f'const uint32_t sr_ovm_n = {len(stats)}u;')
    src.append('int sr_ov_dispatch_sym(uint32_t v, GekkoState *st) {\n    switch (v) {')
    src += dispatch
    src.append('    default: return 0;\n    }\n}')
    write_if_changed(os.path.join(a.outdir, 'ov_index.c'), '\n'.join(src) + '\n')
    print(' '.join(written + [os.path.join(a.outdir, 'ov_index.c')]))
    print(f"[rel_all] wrote {a.outdir}: {sum(s[6] for s in stats)} functions from {len(stats)} modules, "
          f"{sum(s[7] for s in stats)} refused", file=sys.stderr)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""rel_image.py — translate a REL overlay FOR THE WHOLE-IMAGE BUILD, from the bytes OSLink produced.

  python3 gamecube/recomp/sr/rel_image.py --iso sab.iso --rel mcwarnD.rel \
      --ram mem1.bin --module 0x811ffe60 --dispatch <img>/sr_dispatch.c \
      --dol <img>/sab_main.dol --out <img>/ov_mcwarnD.c [--rel ... --module ... repeatable]

WHY A SEPARATE FRONT END (rel_emit.py is the fixture/differential path)
  The whole image already contains every translatable DOL function (sr_gen.c, dispatched by
  sr_dispatch.c).  An overlay TU for it must therefore emit ONLY the overlay's functions and
  call into the image's DOL bodies directly — re-emitting DOL functions, as rel_emit.py's
  --base path does for a standalone differential, would duplicate every fn_ symbol at link.

WHAT IS TRANSLATED
  The executable section as it stands in guest MEM1 AFTER OSLink (`--ram`, a 24 MB dump the
  Node runner writes with SRN_DUMP=).  OSLink's Relocate() rewrites ADDR16_HA/LO/ADDR32 and
  REL24 sites IN PLACE (dolsdk2001 src/os/OSLink.c:146-200); the file's bytes hold
  placeholders there.  The dump holds exactly what the Gekko would fetch.
  Section addresses are read from the LINKED header in RAM (OSLink turns each
  OSSectionInfo.offset into an absolute address, OSLink.c:239-247), never assumed.
  Function boundaries come from rel.translate_module_reach on the FILE (control flow does
  not change under relocation: REL24 sites are named by the relocation table).

THE GUARD
  A translation is valid only while the same bytes sit at the same address.  Each module is
  emitted with the FNV-1a hash of its linked executable section; sr_image.c re-hashes the RAM
  range before trusting an entry (after any DI/ARAM DMA — the only ways new code arrives) and
  refuses (faults as untranslated) on a mismatch.  A different REL loaded at that address, or
  the same REL at another address, is therefore never run through a stale translation.
"""
import argparse, os, re, struct, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rel as R      # noqa: E402
import sr            # noqa: E402


def fnv1a(b):
    h = 2166136261
    for x in b:
        h = ((h ^ x) * 16777619) & 0xFFFFFFFF
    return h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--iso', required=True)
    ap.add_argument('--ram', required=True, help='MEM1 dump (0x80000000..0x81800000) after OSLink')
    ap.add_argument('--rel', action='append', required=True)
    ap.add_argument('--module', action='append', required=True,
                    help='runtime address of the module header (the OSModuleHeader OSLink got)')
    ap.add_argument('--dispatch', required=True, help="the image's sr_dispatch.c (its translated DOL set)")
    ap.add_argument('--dol', required=True)
    ap.add_argument('--map', default=os.path.join(os.path.dirname(__file__), '../../../dolphin_captures/sab.map'))
    ap.add_argument('--out', required=True)
    ap.add_argument('--idle-skip', action='store_true', help='as sr.py --idle-skip (match the image)')
    a = ap.parse_args()
    if len(a.rel) != len(a.module):
        raise SystemExit('--rel and --module pair up')
    sr.RETIRE = True                               # the image is built with --retire
    sr.IDLE_SKIP = a.idle_skip                     # and, when it was, with --idle-skip

    ram = open(a.ram, 'rb').read()
    if len(ram) != 0x01800000:
        raise SystemExit(f'--ram is {len(ram)} bytes, want 24 MB')
    img = sr.Image()
    img.segs.append((0x80000000, ram))

    # The image's translated DOL functions: exactly the sr_dispatch cases.
    dol_emitted = {int(x, 16) for x in re.findall(r'case (0x[0-9a-f]{8})u: fn_', open(a.dispatch).read())}
    dimg = sr.Image.from_dol(a.dol)
    dol_units = sr.recover_boundaries(dimg, sr.load_map(a.map), 'outer+calls', log=lambda m: None)
    dol_starts = {lo for lo, _, _ in dol_units}
    print(f'[rel_image] image: {len(dol_emitted)} translated DOL functions, {len(dol_starts)} DOL units')

    disc = R.Disc(a.iso)
    fns, mods, starts = [], [], set(dol_starts)
    for relname, modhex in zip(a.rel, a.module):
        mod = int(modhex, 16)
        ent = next(f for f in disc.files if f['name'] == relname or f['path'].endswith(relname))
        m = R.Rel(disc.read_file(ent), ent['path'])
        b = mod - 0x80000000
        hid, = struct.unpack('>I', ram[b:b + 4])
        if hid != m.id:
            raise SystemExit(f'{relname}: RAM header id {hid} != file id {m.id} at {mod:#x}')
        si, = struct.unpack('>I', ram[b + 16:b + 20])
        sec_addr = {}
        for s in m.exec_sections():
            o, sz = struct.unpack('>2I', ram[si - 0x80000000 + 8 * s['idx']:si - 0x80000000 + 8 * s['idx'] + 8])
            if sz != s['size'] or not (o & 1):
                raise SystemExit(f'{relname}: sec{s["idx"]} linked info {o:#x}/{sz:#x} disagrees with the file')
            sec_addr[s['idx']] = o & ~1
        res = R.translate_module_reach(m, dol_starts=frozenset(dol_starts))
        mine = []
        for (sec, E), v in res['bodies'].items():
            if sec in sec_addr:
                mine.append((sec_addr[sec] + v['lo'], v['hi'] - v['lo'], f'{relname}:sec{sec}+{v["lo"]:#x}'))
        for sec, base in sec_addr.items():
            size = m.sections[sec]['size']
            live = ram[base - 0x80000000:base - 0x80000000 + size]
            mods.append((relname, base, size, fnv1a(live)))
            print(f'[rel_image] {relname} sec{sec} @ {base:#010x} size {size:#x} hash {fnv1a(live):#010x}')
        fns += mine
        starts |= {lo for lo, _, _ in mine}

    ov = {lo for lo, _, _ in fns}
    emitted = ov | dol_emitted
    ok, bad = [], []
    for lo, size, name in sorted(fns):
        try:
            sr.Translator(img, lo, lo + size, starts=starts, emitted=emitted,
                          indirect=True, jumptables=True).translate()
            ok.append((lo, size, name))
        except sr.Untranslatable as e:
            bad.append((lo, name, e.why))
    for lo, name, why in bad:
        print(f'[rel_image] NOT TRANSLATED {lo:#010x} {name}: {why}', file=sys.stderr)

    # sr.emit_c derives `emitted` from its own list, so a call into the image's DOL would come
    # out as sr_extern(); emit the bodies here with the full emitted set instead.
    out = [sr.HEADER + (sr.IDLE_DECL if sr.IDLE_SKIP else ''), '\n// overlay functions']
    for lo, _, name in ok:
        out.append(f'void fn_{lo:08x}(GekkoState *st);   /* {name} */')
    bodies = []
    for lo, size, name in ok:
        t = sr.Translator(img, lo, lo + size, starts=starts, emitted=emitted,
                          indirect=True, jumptables=True)
        body = t.translate()
        bodies.append(f'\n// {name}  @ {lo:#010x}  ({size} bytes, {size // 4} instructions)')
        bodies.append(f'void fn_{lo:08x}(GekkoState *st) {{')
        bodies += body
        bodies.append('}')
    text = '\n'.join(bodies)
    used_dol = sorted({int(x, 16) for x in re.findall(r'\bfn_([0-9a-f]{8})\(st\)', text)} - ov)
    missing = [x for x in used_dol if x not in dol_emitted]
    if missing:
        raise SystemExit('calls into DOL functions the image does not translate: '
                         + ', '.join(f'{x:#010x}' for x in missing))
    out.append('\n// image DOL functions this overlay calls directly')
    out += [f'void fn_{x:08x}(GekkoState *st);' for x in used_dol]
    out.append(text)
    out.append('\n// the modules, for sr_image.c\'s byte guard (FNV-1a of the linked exec section)')
    out.append('const uint32_t sr_ov_table[][3] = {')
    out += [f'    {{{base:#010x}u, {size:#x}u, {h:#010x}u}},   /* {n} */' for n, base, size, h in mods]
    out.append('};')
    out.append(f'const uint32_t sr_ov_count = {len(mods)}u;')
    out.append('int sr_dispatch_ov(uint32_t addr, GekkoState *st) {\n    switch (addr) {')
    out += [f'    case {lo:#010x}u: fn_{lo:08x}(st); return 1;   /* {name} */' for lo, _, name in ok]
    out.append('    default: return 0;\n    }\n}')
    open(a.out, 'w').write('\n'.join(out) + '\n')
    print(f'[rel_image] wrote {a.out}: {len(ok)} overlay functions translated, {len(bad)} not, '
          f'{len(used_dol)} direct calls into the image; sr_extern sites: {text.count("sr_extern(")}')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""ovl_build.py — compile Mario Party 4's REL overlays INTO the recomp module, generically.

Called by build_wasm.sh after the DOL objects are built. Replaces the four hand-written
per-overlay blocks (bootDll, modeseldll, mentDll, w01Dll) with ONE procedure that applies to
every overlay the decomp has source for, because a hand-written block per overlay is exactly
why the shipped binary could only ever carry four of them (2026-10-01: the first minigame or
event scene a board asked for stopped the game).

WHAT A REL IS, AND WHAT THIS REPRODUCES. On the GameCube each overlay is a separate module
(dll/<name>.rel) that omDLLLink (src/game/objdll.c) reads off the disc, links with OSLink, and
enters through its _prolog — which is executor.c's (ctors, then ObjectSetup), board_executor.c's
(ctors, then BoardObjectSetup(BoardCreate, BoardDestroy)) or the REL's own (mentDll,
mstory4Dll). Two properties of that matter here and are reproduced exactly:
  1. NAMESPACE. Every REL has its own symbol space; dozens define ObjectSetup, _prolog,
     fn_1_XXXX, lbl_1_YYYY. Here every global an overlay DEFINES is renamed with a per-overlay
     prefix (`-include` of a generated header of `#define sym prefix_sym`), found by compiling
     the overlay once and reading its defined globals with llvm-nm. References to the DOL are
     untouched (an overlay never defines a DOL symbol), so the overlay binds to the real game
     by plain name exactly as the REL's module-0 relocations do.
  2. FRESH STATICS ON EVERY LINK. OSLink re-reads the REL from disc (fresh .data) and zeroes
     its .bss on every link, and omDLLStart's "Already Loaded" path memsets .bss again
     (objdll.c). A statically-linked overlay keeps its statics across entries unless they are
     reset — MEASURED on the shipped binary (tools/gc_netplay_det.html script=mash3, seeds 4
     and 5): the second entry into mentDll trapped `memory access out of bounds` in LoadHSF <-
     Hu3DModelCreate <- fn_mt1_12E40, whose first two lines are `var_r30 = lbl_1_bss_D0;
     lbl_1_bss_D0 = var_r30 + 1;` — a BSS counter that is 0 on every real link and here kept
     counting from the previous visit, indexing past lbl_1_bss_33AC. Each overlay's objects
     are bracketed by marker objects in link order, so its .data and .bss are each one
     contiguous range ([__ovl_<p>_data_b, __ovl_<p>_data_e) etc.); gc_ovl_dispatch.c snapshots
     the .data range on first link and restores it (and zeroes .bss) on every later one.
     wasm-ld lays input segments out in input order — tested before relying on it, and
     verify_layout() (`ovl_build.py --verify-map BUILD/mp4_game.map`, run by build_wasm.sh after
     every link) re-checks it on the real link with the map file.

usage (from build_wasm.sh):  python3 ovl_build.py BUILD RECOMP OVERLAYS
  OVERLAYS: 'all' or a space-separated list of src/REL directory names.
  Writes BUILD/ovl/link_order.txt (objects to link, in order), BUILD/ovl/report.txt,
  BUILD/ovl/table.json (overlay number -> prefix), and objects under BUILD/ovl/obj/.
  Compile flags come from BUILD/ovl/cflags.txt (one per line), written by build_wasm.sh.
"""
import json, os, re, subprocess, sys



def verify_layout(map_path):
    """Re-check, on the REAL link's map, that each overlay's .data and .bss sit wholly between its
    two markers and that nothing else does — the property gc_ovl_dispatch.c's snapshot/restore and
    bss zeroing depend on. A foreign object inside a range would be clobbered on every link; an own
    object outside it would keep the previous visit's statics. Returns the problem count."""
    rx = re.compile(r'^\s*([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(\S+\.o):\((\.(?:data|bss)[^)]*)\)$')
    secs, marks = [], {}
    for line in open(map_path):
        r = rx.match(line.rstrip('\n'))
        if not r:
            continue
        a, sz, f, sec = int(r.group(1), 16), int(r.group(3), 16), r.group(4), r.group(5)
        secs.append((a, sz, f, sec))
        mm = re.search(r'__(ovl_\w+?)_(data|bss)_([be])$', sec)
        if mm:
            marks[(mm.group(1), mm.group(2), mm.group(3))] = a
    bad = 0
    prefixes = sorted({k[0] for k in marks})
    for p in prefixes:
        for kind in ('data', 'bss'):
            b, e = marks.get((p, kind, 'b')), marks.get((p, kind, 'e'))
            if b is None or e is None or e < b:
                print('[ovl] LAYOUT: %s %s markers missing or inverted' % (p, kind)); bad += 1; continue
            for a, sz, f, sec in secs:
                if not sz or not sec.startswith('.' + kind) or ('/ovl/%s_mark' % p) in f:
                    continue
                own = ('/ovl/obj/%s__' % p) in f
                inside = b <= a < e
                if own and not (inside and a + sz <= e):
                    print('[ovl] LAYOUT: %s %s %s outside its range' % (p, kind, sec)); bad += 1
                elif not own and inside:
                    print('[ovl] LAYOUT: %s %s range holds foreign %s (%s)' % (p, kind, sec, os.path.basename(f))); bad += 1
    print('[ovl] layout verified on the link map: %d overlays, %d problems' % (len(prefixes), bad))
    return bad


if len(sys.argv) == 3 and sys.argv[1] == '--verify-map':
    sys.exit(1 if verify_layout(sys.argv[2]) else 0)

BUILD, RECOMP, SEL = sys.argv[1], sys.argv[2], sys.argv[3]
O = os.path.join(BUILD, 'ovl')
OBJ = os.path.join(O, 'obj')
os.makedirs(OBJ, exist_ok=True)
CFLAGS = [l.rstrip('\n') for l in open(os.path.join(O, 'cflags.txt')) if l.strip()]
EMCC = os.environ.get('EMCC', 'emcc')
NM = os.environ.get('LLVM_NM', 'llvm-nm')
REL = os.path.join(BUILD, 'src', 'REL')


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


# ---- 1. the overlay numbering, from the decomp's own table (VERSION=0 = USA) ---------------
def overlay_numbers():
    src = '#define DLL(name) X(name)\n#include "ovl_table.h"\n'
    r = run([EMCC, '-E', '-P', '-DVERSION=0', '-I', os.path.join(BUILD, 'include'), '-x', 'c', '-'],
            input=src)
    names = re.findall(r'X\((\w+)\)', r.stdout)
    if len(names) < 90:
        sys.exit('[ovl] could not read ovl_table.h (%d entries): %s' % (len(names), r.stderr[:400]))
    return {n.lower(): i for i, n in enumerate(names)}


NUM = overlay_numbers()
DIRS = {d.lower(): d for d in os.listdir(REL) if os.path.isdir(os.path.join(REL, d))}
if SEL.strip() == 'all':
    chosen = sorted(DIRS.values(), key=lambda d: NUM.get(d.lower(), 999))
else:
    chosen = [DIRS[s.lower()] for s in SEL.split()]


def units_of(d):
    us = sorted(os.path.join(REL, d, f) for f in os.listdir(os.path.join(REL, d)) if f.endswith('.c'))
    text = '\n'.join(open(u, errors='replace').read() for u in us)
    if re.search(r'(?m)^s32 _prolog\s*\(', text):
        kind = 'own'                              # mentDll, mstory4Dll
    elif re.search(r'(?m)^void BoardCreate\s*\(', text):
        kind = 'board'; us = us + [os.path.join(REL, 'board_executor.c')]
    else:
        kind = 'executor'; us = us + [os.path.join(REL, 'executor.c')]
    return kind, us


def objname(prefix, u):
    return os.path.join(OBJ, prefix + '__' + os.path.basename(u)[:-2] + '.o')


RETURNS = []   # -Wreturn-type / -Wreturn-mismatch hits: mwcc-r3 accidents (see build_wasm.sh)


def compile_units(prefix, units, extra, collect=False):
    errs = []
    for u in units:
        r = run([EMCC] + CFLAGS + extra + [u, '-o', objname(prefix, u)])
        if r.returncode:
            m = re.search(r'error: (.*)', r.stderr)
            errs.append('%s: %s' % (os.path.relpath(u, BUILD), m.group(1) if m else r.stderr[-300:]))
        elif collect:
            for line in r.stderr.splitlines():
                if re.search(r'\[-Wreturn-(type|mismatch)\]', line):
                    RETURNS.append(line.replace(BUILD + '/', ''))
    return errs


def defined_globals(objs):
    syms = set()
    for o in objs:
        r = run([NM, '--defined-only', '--extern-only', o])
        for line in r.stdout.splitlines():
            p = line.split()
            if len(p) >= 2 and p[-2] in 'TDBRV' and not p[-1].startswith('__'):
                syms.add(p[-1])
            # _prolog/_epilog/_ctors start with ONE underscore and are exactly the symbols that
            # collide between RELs, so they are renamed too; '__' names are compiler/runtime.
    return syms


report, table, link_order, problems = [], [], [], 0
for d in chosen:
    n = NUM.get(d.lower())
    if n is None:
        report.append('SKIP %-14s not in ovl_table.h' % d); continue
    prefix = 'ovl_' + d.lower()
    kind, units = units_of(d)
    # pass 1: compile as-is to learn what the overlay defines
    errs = compile_units(prefix, units, [])
    if errs:
        problems += 1
        report.append('FAIL %-14s #%-3d compile: %s' % (d, n, ' | '.join(errs[:3])))
        continue
    objs = [objname(prefix, u) for u in units]
    syms = sorted(defined_globals(objs))
    hdr = os.path.join(O, prefix + '_rename.h')
    with open(hdr, 'w') as f:
        f.write('/* generated by ovl_build.py: every global %s defines, namespaced */\n' % d)
        for s in syms:
            f.write('#define %s %s_%s\n' % (s, prefix, s))
    # pass 2: the real objects
    errs = compile_units(prefix, units, ['-include', hdr], collect=True)
    if errs:
        problems += 1
        report.append('FAIL %-14s #%-3d renamed compile: %s' % (d, n, ' | '.join(errs[:3])))
        continue
    # static-range markers: their objects bracket this overlay's in the link order
    # Two marker objects, so begin and end can sit on either side of the overlay's objects.
    for side in ('b', 'e'):
        src = os.path.join(O, '%s_mark_%s.c' % (prefix, side))
        with open(src, 'w') as f:
            f.write('char __%s_data_%s[1] = {1};\nchar __%s_bss_%s[1];\n' % (prefix, side, prefix, side))
        r = run([EMCC] + CFLAGS + [src, '-o', src[:-2] + '.o'])
        if r.returncode:
            sys.exit('[ovl] marker compile failed: ' + r.stderr[-400:])
    link_order += [os.path.join(O, prefix + '_mark_b.o')] + objs + [os.path.join(O, prefix + '_mark_e.o')]
    prolog = '_prolog'
    table.append({'num': n, 'dir': d, 'prefix': prefix, 'kind': kind,
                  'prolog': prefix + '_' + prolog, 'epilog': prefix + '__epilog'
                  if '_epilog' in syms else None, 'nsyms': len(syms)})
    if '_prolog' not in syms:
        problems += 1
        report.append('FAIL %-14s #%-3d defines no _prolog (kind %s)' % (d, n, kind))
        table.pop(); continue
    report.append('OK   %-14s #%-3d %-8s %d units, %d globals namespaced' % (d, n, kind, len(units), len(syms)))

# ---- the dispatch table the objdll.c hooks consult ---------------------------------------
tab = os.path.join(O, 'ovl_table.c')
with open(tab, 'w') as f:
    f.write('/* generated by ovl_build.py — the AOT overlays in this module */\n')
    f.write('typedef int (*RecompProlog)(void);\ntypedef void (*RecompEpilog)(void);\n')
    for t in table:
        p = t['prefix']
        f.write('extern int %s(void);\n' % t['prolog'])
        if t['epilog']:
            f.write('extern void %s(void);\n' % t['epilog'])
        f.write('extern char __%s_data_b[], __%s_data_e[], __%s_bss_b[], __%s_bss_e[];\n' % (p, p, p, p))
    f.write('typedef struct { short num; RecompProlog prolog; RecompEpilog epilog; char *db, *de, *bb, *be;'
            ' const char *name; } RecompOvl;\n')
    f.write('const RecompOvl __recomp_ovl_tab[] = {\n')
    for t in table:
        p = t['prefix']
        f.write('  { %d, %s, %s, __%s_data_b, __%s_data_e, __%s_bss_b, __%s_bss_e, "%s" },\n'
                % (t['num'], t['prolog'], t['epilog'] or '0', p, p, p, p, t['dir']))
    f.write('  { -1, 0, 0, 0, 0, 0, 0, 0 }\n};\nconst int __recomp_ovl_count = %d;\n' % len(table))
r = run([EMCC] + CFLAGS + [tab, '-o', tab[:-2] + '.o'])
if r.returncode:
    sys.exit('[ovl] table compile failed: ' + r.stderr[-600:])
link_order.append(tab[:-2] + '.o')

with open(os.path.join(O, 'link_order.txt'), 'w') as f:
    f.write('\n'.join(link_order) + '\n')
with open(os.path.join(O, 'table.json'), 'w') as f:
    json.dump(table, f, indent=1)
with open(os.path.join(O, 'report.txt'), 'w') as f:
    f.write('\n'.join(report) + '\n')
    f.write('\n[missing-return in overlays: %d]\n' % len(sorted(set(RETURNS))))
    f.write('\n'.join(sorted(set(RETURNS))) + '\n')
print('[ovl] %d overlays AOT-compiled, %d failed, %d missing-return sites (BUILD/ovl/report.txt)' % (len(table), problems, len(set(RETURNS))))
for line in report:
    if not line.startswith('OK'):
        print('  ' + line)
# A failed overlay is a missing overlay: the game stops at OSLink the first time it asks for it.
# build_wasm.sh treats a non-zero exit as FATAL, so a build can no longer link with a hole in it
# (2026-10-03: two overlays failed to compile and the link still printed LINKED).
sys.exit(1 if problems else 0)

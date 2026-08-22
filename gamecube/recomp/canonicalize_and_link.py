#!/usr/bin/env python3
# [wasm-recomp 2026-08-21] Auto-canonicalize the decomp's mwcc-tolerated signature
# inconsistencies for strict wasm-ld and link the object set. Loop:
#   link -> read "signature mismatch: NAME" -> declare NAME from its DEFINITION
#   (GeoTypes-only protos; no implicit-decl shift) -> truncate outlier CALLS to the
#   def arity -> recompile affected units -> repeat. When a symbol persists after
#   being declared (its conflict is a DECLARATION, e.g. an overlay/kerjmp `void`
#   prototype), also canonicalize those prototypes to the definition's signature
#   and full-recompile. Behavior-preserving (canonical = the definition; mwcc
#   dropped the extra register args). Transforms the user's own staged files;
#   declares interfaces only. Prereq: run build_wasm.sh first (stages + shims).
import os, re, sys, glob, subprocess

BUILD = os.environ.get("BUILD", "/tmp/gc_recomp_build")
SRC = os.path.join(BUILD, "src")
PROTOS = os.path.join(BUILD, "gc_recomp_gen_protos.h")
CFLAGS = ["-c","-std=gnu89","-O2","-w","-Wno-error","-Wno-implicit-function-declaration",
          "-Wno-return-mismatch","-Wno-int-conversion","-Wno-incompatible-function-pointer-types",
          "-Wno-incompatible-pointer-types","-Wno-builtin-requires-header","-fno-builtin",
          "-DVERSION=0","-fdeclspec",
          "-include", PROTOS, "-I", os.path.join(BUILD,"include"),
          "-I", os.path.join(BUILD,"gen"), "-I", os.path.join(BUILD,"extern/musyx/include"),
          "-I", SRC]
TYPE = r'(?:void|int|char|float|double|BOOL|u8|u16|u32|s8|s16|s32|f32|f64|unsigned|signed|long|short)'

cfiles = [f for f in glob.glob(os.path.join(SRC, "**", "*.c"), recursive=True)
          if "/dolphin/mtx/" not in f and "/src/REL/" not in f
          and not f.endswith("/game/kerent.c")]  # host-layer/asm/overlays; see build_wasm.sh
allfiles = cfiles + glob.glob(os.path.join(BUILD,"include","**","*.h"), recursive=True) \
                  + glob.glob(os.path.join(SRC,"**","*.h"), recursive=True)
text = {f: open(f, errors="ignore").read() for f in allfiles}
decls = {}   # name -> (decl_string, arity)

def obj_path(f):
    rel = f[len(BUILD)+1:]
    return os.path.join(BUILD, "obj", re.sub(r'[^A-Za-z0-9_.-]', '_', rel.replace('/','_')) + ".o")

def strip_names(args):
    # keep parameter TYPES, drop the parameter NAMES, so the prototype references only
    # types (decl_is_safe can then judge it on types alone; a prototype needs no names).
    if args in ('', 'void'): return 'void'
    out = []
    for a in split_args(args):
        a = a.strip()
        m = re.match(r'(.*?)([A-Za-z_]\w*)\s*$', a)   # trailing identifier = the param name
        out.append(m.group(1).strip() if (m and m.group(1).strip()) else a)
    return ', '.join(out)

def def_sig(name):
    pat = re.compile(r'(?m)^([A-Za-z_][\w \t\*]*?\b' + re.escape(name) + r')\s*\(([^;{}]*?)\)\s*\{')
    for t in text.values():
        m = pat.search(t)
        if m:
            head = ' '.join(m.group(1).split())
            if head.split()[0] == 'static':   # file-local def: never declare it extern in the
                return None                    # protos (would clash with its static def / decl)
            raw = ' '.join(m.group(2).split()) or 'void'
            if raw.rstrip().endswith('...'):  # variadic (e.g. OSReport): a fixed wasm signature,
                return f"{head}({strip_names(raw)});", 10**9   # never truncate its call sites
            ar = 0 if raw in ('', 'void') else len([a for a in raw.split(',') if a.strip()])
            return f"{head}({strip_names(raw)});", ar
    return None

def match_paren(t, i):
    d = 0
    for k in range(i, len(t)):
        if t[k] == '(': d += 1
        elif t[k] == ')':
            d -= 1
            if d == 0: return k
    return -1

def split_args(s):
    out, d, cur = [], 0, ''
    for c in s:
        if c in '([{': d += 1; cur += c
        elif c in ')]}': d -= 1; cur += c
        elif c == ',' and d == 0: out.append(cur); cur = ''
        else: cur += c
    if cur.strip() or out: out.append(cur)
    return out

def truncate_calls(t, name, n):
    pat = re.compile(r'(?<![A-Za-z0-9_])' + re.escape(name) + r'\s*\('); out = ''; i = 0; changed = False
    while True:
        m = pat.search(t, i)
        if not m: out += t[i:]; break
        op = m.end() - 1; cl = match_paren(t, op)
        if cl < 0: out += t[i:]; break
        after = t[cl+1:cl+40].lstrip(); args = split_args(t[op+1:cl]); ne = [a for a in args if a.strip()]
        if after[:1] != '{' and after[:1] != ';' and len(ne) > n:      # a CALL with too many args (not def/decl)
            inner = ', '.join(a.strip() for a in ne[:n]); changed = True
        elif after[:1] == ';' and len(ne) > n:                          # a call statement `name(...);`
            # only truncate if there is no return-type prefix (i.e. it's a call, not a prototype)
            pre = t[max(0,m.start()-12):m.start()]
            if not re.search(TYPE + r'[ \t\*]+$', pre): inner = ', '.join(a.strip() for a in ne[:n]); changed = True
            else: inner = t[op+1:cl]
        else: inner = t[op+1:cl]
        out += t[i:op+1] + inner + ')'; i = cl + 1
    return out, changed

def patch_decls(t, name, canon):
    # replace type-prefixed prototype declarations of `name` with the canonical decl
    pat = re.compile(r'(?m)^[ \t]*' + TYPE + r'[ \t\*]+' + re.escape(name) + r'[ \t]*\([^;{}]*\)[ \t]*;')
    nt, cnt = pat.subn(canon, t)
    return nt, cnt

# Types resolvable from GeoTypes.h + base C — a decl using ONLY these is safe to emit
# into the force-included protos without pulling any header. Emitting a decl that
# references a game/REL type (or #including its header) poisons the whole protos:
# the REL overlay headers have their own conflicts (e.g. two decls of fn_1_800), so
# a single such include makes EVERY caller recompile fail silently -> the caller keeps
# its stale implicit ()->i32 object -> the mismatch never clears. Proven 2026-08-21.
BASE = set("void int char float double BOOL bool u8 u16 u32 s8 s16 s32 f32 f64 "
           "unsigned signed long short const volatile "
           "Vec Mtx ROMtx Mtx44 Mtx43 S16Vec Quaternion Point VecPtr MtxPtr GXColor".split())
def decl_is_safe(d):
    m = re.search(r'(\w+)\s*\(', d)
    fn = m.group(1) if m else ''
    return all(i in BASE for i in re.findall(r'[A-Za-z_]\w*', d) if i != fn)

def ret_type(d):
    m = re.match(r'(.*?)(\w+)\s*\(', d)             # everything before the fn name = return type
    return m.group(1).strip() if m else ''

# Known variadic SDK functions whose definitions live in host-boundary units (dropped
# from the link), so def_sig can't recover them. Without a variadic prototype each
# caller imports them at whatever arity it uses, and wasm-ld sees conflicting import
# signatures. Declaring the canonical variadic form makes every call site agree (the
# varargs go through the shadow stack -> one fixed wasm signature). Host imports.
KNOWN_VARIADIC = [
    "void OSReport(const char*, ...);",
    "void OSPanic(const char*, int, const char*, ...);",
]
def gen_protos():
    with open(PROTOS, "w") as f:
        f.write("#ifndef GC_RECOMP_GEN_PROTOS_H\n#define GC_RECOMP_GEN_PROTOS_H\n")
        f.write("#include <dolphin/mtx/GeoTypes.h>\n")
        for k in KNOWN_VARIADIC: f.write(k + "\n")
        for name, (d, _) in decls.items():
            if d.startswith("/*"): continue         # host-import placeholder
            if decl_is_safe(d):
                f.write(d + "\n")                   # fully base-typed: emit as-is
            else:
                rt = ret_type(d)
                # Args use a game type (pointer/enum/struct = i32 in wasm32) but the
                # RETURN type is base: emit a K&R declaration (unspecified args). That
                # corrects the real mismatch driver (implicit `int` return vs the def's
                # type); truncate_calls already normalized caller arity to the def, and
                # every pointer arg is i32, so the call signatures match the definition.
                if rt and all(i in BASE for i in re.findall(r'[A-Za-z_]\w*', rt)):
                    f.write(f"{rt} {name}();\n")
                # else: non-base RETURN type -> leave implicit (host boundary)
        f.write("#endif\n")

def compile_units(files):
    # DO NOT delete objects on failure. A game unit that fails only because the global
    # force-include protos clashes with its OWN header (a decomp decl!=def) would be
    # dropped, and its game logic would silently vanish from the link — producing a
    # green but HOLLOW module (SDK/libc glue, no game). Measured 2026-08-21: masking
    # this way left 1 game object of ~89. The correct fix is signature reconciliation
    # that keeps the game unit compilable, not deletion. Genuine host-boundary units
    # (inline asm / .inc assets / MusyX) simply keep their no-protos object from
    # build_wasm.sh (or none) and their symbols resolve as imports at link.
    for f in files:
        subprocess.run(["emcc"] + CFLAGS + [f, "-o", obj_path(f)],
                       stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)

def link():
    objs = glob.glob(os.path.join(BUILD, "obj", "*.o"))
    r = subprocess.run(["emcc"] + objs + ["-o", os.path.join(BUILD,"mp4_game.wasm"),
        "-sERROR_ON_UNDEFINED_SYMBOLS=0","-sALLOW_MEMORY_GROWTH=1","-sSTANDALONE_WASM=1",
        "-Wl,--allow-undefined","-Wl,--allow-multiple-definition","-O2"],
        stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True)
    return r.returncode == 0, sorted(set(re.findall(r'signature mismatch: (\w+)', r.stderr)))

gen_protos(); compile_units(cfiles)
did_declpatch = False
for it in range(1, 20):
    ok, mm = link()
    if ok:
        sz = os.path.getsize(os.path.join(BUILD, "mp4_game.wasm"))
        print(f"[canon] iter {it}: LINKED  mp4_game.wasm = {sz} bytes ({len(decls)} canonical decls)"); sys.exit(0)
    new = [s for s in mm if s not in decls]
    print(f"[canon] iter {it}: {len(mm)} mismatches ({len(new)} new); declared {len(decls)}")
    if new:
        affected = set()
        for s in new:
            sig = def_sig(s)
            if not sig: decls[s] = (f"/* {s}: host import */", 0); continue
            decls[s] = sig
            for f in cfiles:
                if re.search(r'(?<![A-Za-z0-9_])' + re.escape(s) + r'\s*\(', text[f]):
                    nt, ch = truncate_calls(text[f], s, sig[1])
                    if ch: text[f] = nt; open(f, "w").write(nt)
                    affected.add(f)
        gen_protos(); compile_units(sorted(affected))
    elif not did_declpatch:
        # symbols persist after declaration: canonicalize conflicting PROTOTYPES (overlay/kerjmp void decls)
        print(f"[canon]   decl-patching {len(mm)} persistent symbols (overlay/kerjmp prototypes) + full recompile")
        for s in mm:
            canon = decls.get(s, (None,))[0]
            if not canon: continue
            for f in allfiles:
                nt, c = patch_decls(text[f], s, canon)
                if c: text[f] = nt; open(f, "w").write(nt)
        gen_protos(); compile_units(cfiles); did_declpatch = True
    else:
        print(f"[canon]   persistent after decl-patch: {mm[:10]} — needs subsystem (overlay/REL) handling"); sys.exit(1)
print("[canon] iteration cap without linking"); sys.exit(1)

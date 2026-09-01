#!/usr/bin/env python3
# [wasm-recomp 2026-08-21] Reconcile the decomp's mwcc-tolerated decl!=def signature
# inconsistencies for wasm-ld, using the pattern the wf_0410e5b9 workflow validated:
# inject each function's CANONICAL prototype (taken from its DEFINITION, which is
# byte-identical to native Dolphin's build/main.elf) into the outlier caller units
# that lack it. A caller that never saw a prototype implicit-declares `int NAME()`
# with float args promoted to double, so it emits a wasm import signature that
# disagrees with the void/f32 definition; the injected prototype fixes exactly that,
# behavior-preserving (the call itself is unchanged). Only outliers are touched:
# files that already include the declaring header, and the definition file, are
# skipped. Discovers the full set by iterating link -> mismatch -> inject.
#
# Emits gamecube/recomp/sig_fixes.json = the [{symbol, proto, header}] list that
# build_wasm.sh replays as a deterministic post-rsync step. Prereq: build_wasm.sh
# staged the tree at $BUILD first (authoritative includes).
import os, re, glob, subprocess, sys, json

B = os.environ.get("BUILD", "/tmp/gc_recomp_build2")
INC, SRC = os.path.join(B, "include"), os.path.join(B, "src")
GEN, MUS = os.path.join(B, "gen"), os.path.join(B, "extern/musyx/include")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sig_fixes.json")
CF = ["-c", "-std=gnu89", "-O2", "-w", "-Wno-error", "-Wno-implicit-function-declaration",
      "-Wno-return-mismatch", "-Wno-int-conversion", "-Wno-incompatible-function-pointer-types",
      "-Wno-incompatible-pointer-types", "-Wno-builtin-requires-header", "-fno-builtin",
      "-DVERSION=0", "-fdeclspec", "-I", INC, "-I", GEN, "-I", MUS, "-I", SRC]

cfiles = [f for d in ("game", "dolphin", "libhu")
          for f in glob.glob(os.path.join(SRC, d, "**", "*.c"), recursive=True)
          if "/dolphin/mtx/" not in f and "/REL/" not in f and "/dolphin/card/" not in f
          and not f.endswith("/game/kerent.c")]

BASE = set("void int char float double BOOL bool u8 u16 u32 s8 s16 s32 f32 f64 unsigned "
           "signed long short const volatile struct enum union".split())

def obj_path(f):
    rel = f[len(B) + 1:]
    return os.path.join(B, "obj", re.sub(r'[^A-Za-z0-9_.-]', '_', rel.replace('/', '_')) + ".o")

def read(f):
    return open(f, errors="surrogateescape").read()

def def_proto(name):
    # The EXACT prototype from the DEFINITION (real types + param names). Because it is
    # identical to the decomp's own header declaration, injecting it into an outlier is
    # a legal redundant redeclaration even if that outlier transitively includes the
    # real header — it never produces "conflicting types" (which wasm-class void* did,
    # dropping 13 board files). Genuine callers have the argument types in scope via
    # their own includes, so the injected prototype compiles.
    pat = re.compile(r'(?m)^([A-Za-z_][\w \t\*]*?\b' + re.escape(name) + r')\s*\(([^;{}]*?)\)\s*\{')
    for f in cfiles:
        m = pat.search(read(f))
        if m:
            toks = ' '.join(m.group(1).split()).split()
            while toks and toks[0] in ('asm', 'inline', '__inline', 'volatile', 'register', 'extern', 'static'):
                if toks[0] == 'static':
                    return None                        # file-local: don't declare it extern
                toks.pop(0)                            # strip qualifiers (asm PPCSync -> void PPCSync)
            head = ' '.join(toks)                      # "ret NAME"
            args = ' '.join(m.group(2).split()) or 'void'
            return "%s(%s);" % (head, args), f
    return None

TYPE = r'(?:void|int|char|float|double|BOOL|u8|u16|u32|s8|s16|s32|f32|f64|unsigned|signed|long|short|Vec|Mtx)'
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

def proto_arity(proto):
    inner = proto[proto.find('(') + 1:proto.rfind(')')].strip()
    if inner in ('', 'void'): return 0
    return len([a for a in split_args(inner) if a.strip()])

def truncate_calls(t, name, n):
    # Truncate CALL sites of `name` that pass more than n args down to n (mwcc's PPC ABI
    # silently dropped the extras; the real-type prototype rejects them). Leaves the
    # definition body and any prototypes untouched.
    pat = re.compile(r'(?<![A-Za-z0-9_])' + re.escape(name) + r'\s*\('); out = ''; i = 0; changed = False
    while True:
        m = pat.search(t, i)
        if not m: out += t[i:]; break
        op = m.end() - 1; cl = match_paren(t, op)
        if cl < 0: out += t[i:]; break
        after = t[cl + 1:cl + 40].lstrip(); ne = [a for a in split_args(t[op + 1:cl]) if a.strip()]
        pre = t[max(0, m.start() - 16):m.start()]
        is_proto = after[:1] == ';' and re.search(TYPE + r'[ \t\*]+$', pre)
        if after[:1] != '{' and not is_proto and len(ne) > n:
            inner = ', '.join(a.strip() for a in ne[:n]); changed = True
        else:
            inner = t[op + 1:cl]
        out += t[i:op + 1] + inner + ')'; i = cl + 1
    return out, changed

def decl_header(name):
    pat = re.compile(r'(?m)^[ \t]*[A-Za-z_][\w \t\*]*\b' + re.escape(name) + r'[ \t]*\([^;{}]*\)[ \t]*;')
    for h in glob.glob(os.path.join(INC, "**", "*.h"), recursive=True):
        if pat.search(read(h)):
            return os.path.relpath(h, INC)
    return None

def inject(name, proto, hdr, deffile):
    aff = []
    # An existing PROTOTYPE has a return-type token before the name (`void NAME(...);`);
    # a call statement (`NAME(...);`) does not. Require the type prefix so call sites are
    # not mistaken for declarations (that bug skipped every caller).
    declpat = re.compile(r'(?m)^[ \t]*(?:extern[ \t]+)?[A-Za-z_][\w \t\*]+?\b' + re.escape(name) + r'\s*\([^{}]*?\)\s*;')
    for f in cfiles:
        if f == deffile:
            continue
        s = read(f)
        if not re.search(r'(?<![A-Za-z0-9_])' + re.escape(name) + r'\s*\(', s):
            continue                                   # doesn't call it
        if declpat.search(s):
            continue                                   # already has SOME prototype (right or wrong -> workflow's job)
        if hdr and ('"%s"' % hdr in s or '<%s>' % hdr in s):
            continue                                   # includes the declaring header
        incs = list(re.finditer(r'(?m)^#include[^\n]*\n', s))
        ins = incs[-1].end() if incs else 0
        open(f, "w", errors="surrogateescape").write(s[:ins] + proto + "\n" + s[ins:])
        aff.append(f)
    return aff

def compile_all():
    os.makedirs(os.path.join(B, "obj"), exist_ok=True)
    for f in cfiles:
        subprocess.run(["emcc"] + CF + [f, "-o", obj_path(f)],
                       stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)

def link():
    # NOTE: emcc appends ".wasm" to -o, so "/dev/null" becomes "/dev/null.wasm" which
    # can't be created -> the link aborts at output creation BEFORE mismatch checking,
    # falsely yielding 0 mismatches. Use a real output path.
    objs = glob.glob(os.path.join(B, "obj", "*.o"))
    r = subprocess.run(["emcc"] + objs + ["-o", os.path.join(B, "_sigprobe.wasm"),
        "-sERROR_ON_UNDEFINED_SYMBOLS=0", "-sALLOW_MEMORY_GROWTH=1", "-sSTANDALONE_WASM=1",
        "-Wl,--no-entry", "-Wl,--no-gc-sections", "-Wl,--allow-undefined", "-Wl,--allow-multiple-definition"],
        stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True)
    return sorted(set(re.findall(r'signature mismatch: (\w+)', r.stderr)))

applied, skipped = [], {}
print("initial full compile..."); compile_all()
for it in range(1, 25):
    mm = link()
    if not mm:
        print("iter %d: LINKED — 0 signature mismatches" % it); break
    new = [s for s in mm if s not in {a['symbol'] for a in applied} and s not in skipped]
    print("iter %d: %d mismatches (%d new); %d applied, %d skipped" % (it, len(mm), len(new), len(applied), len(skipped)))
    if not new:
        print("STUCK (host/overlay/struct-return, not caller-prototype fixable):", mm); break
    for s in new:
        dp = def_proto(s)
        if not dp:
            skipped[s] = "no def / static"; continue
        proto, deffile = dp
        hdr = decl_header(s)
        aff = inject(s, proto, hdr, deffile)
        # Truncate any over-arg call sites of s to the definition arity (mwcc dropped
        # the extras). Do this whether or not a prototype was injected — an outlier
        # that already declares s can still carry a too-many-args call.
        ar = proto_arity(proto)
        for f in cfiles:
            if f == deffile: continue
            s2 = read(f)
            nt, ch = truncate_calls(s2, s, ar)
            if ch: open(f, "w", errors="surrogateescape").write(nt)
        if aff:
            applied.append({"symbol": s, "proto": proto, "header": hdr, "arity": ar})
        else:
            skipped[s] = "declared everywhere; truncated over-arg calls if any (else replace-case)"
    # Full recompile each iteration: injecting into one file can reveal a wave in an
    # UNAFFECTED file (e.g. HuPrcVSleep in hsfex.c); an affected-only recompile misses it.
    compile_all()

json.dump(applied, open(OUT, "w"), indent=1)
print("wrote %d prototype injections to %s" % (len(applied), OUT))
if skipped:
    print("SKIPPED (need separate handling):", json.dumps(skipped, indent=1))

#!/usr/bin/env bash
# gamecube/recomp/build_wasm.sh — compile the Mario Party 4 decompilation to
# WebAssembly objects (the CPU-compile half of the native-port route; see PLAN.md).
# Stages a writable copy of the decomp, overlays portable shims for the low-level
# asm headers, applies the known non-Metrowerks-path source fixes programmatically
# (no source is reproduced here — it transforms the user's own decomp files), then
# emits wasm objects and tallies the surface. Idempotent.
#
# Env: DECOMP (decomp root), BUILD (staging dir). Not the emulator build — this is
# the recomp toolchain, so the canonical dolphin build-flow gate does not apply.
set -u
DECOMP="${DECOMP:-$HOME/gc_refs/marioparty4}"
RECOMP="$(cd "$(dirname "$0")" && pwd)"
BUILD="${BUILD:-/tmp/gc_recomp_build}"
source "$HOME/emsdk-upstream/emsdk_env.sh" >/dev/null 2>&1

echo "[recomp] decomp=$DECOMP  build=$BUILD"
mkdir -p "$BUILD"
# 1. stage a writable copy of decomp source + headers
rsync -a --delete "$DECOMP/src" "$DECOMP/include" "$BUILD/" 2>/dev/null || {
  cp -R "$DECOMP/src" "$BUILD/src"; cp -R "$DECOMP/include" "$BUILD/include"; }
# Authoritative include dirs from the decomp's OWN build (build.ninja): the REAL MusyX
# headers (SND_GROUPID/SND_SONGID/... — not absent, vendored here) and the GENERATED
# header dir carrying every .inc binary asset (coveropen_en.inc, refMapData0.inc, …)
# plus macros.inc. Mirroring the decomp's real build config is the authoritative fix
# (vs my ad-hoc -I flags + wrong musyx stub). extern/musyx/include has a musyx/ subdir.
mkdir -p "$BUILD/extern/musyx"
rsync -a "$DECOMP/extern/musyx/include" "$BUILD/extern/musyx/" 2>/dev/null || cp -R "$DECOMP/extern/musyx/include" "$BUILD/extern/musyx/include"
rsync -a --delete "$DECOMP/build/GMPE01_01/include/" "$BUILD/gen/" 2>/dev/null || { mkdir -p "$BUILD/gen"; cp -R "$DECOMP/build/GMPE01_01/include/." "$BUILD/gen/"; }
# 2. overlay portable shims (portable OSFastCast replaces the inline-asm header, etc.)
cp -R "$RECOMP/shims/." "$BUILD/include/" 2>/dev/null || true
# 3. programmatic fixes for non-mwcc-path decomp bugs (transform staged copy only).
#    ext_math.h: forward decl missing ';' inside the #ifndef __MWERKS__ branch.
perl -0pi -e 's/(\bvoid\s+HuSetVecF\s*\([^;{]*\))\s*\n(\s*#endif)/$1;\n$2/g' \
  "$BUILD/include/ext_math.h" 2>/dev/null || true

# 3a. Compile-fix transforms — clang-vs-mwcc incompatibilities in game/SDK units.
#     Verified (compile-tested + adversarially reviewed) by workflow wf_0410e5b9.
#     static-decl reconciliations (definition is file-local; align the header prototype):
perl -0pi -e 's/^(DataReadStat \*HuDataDirReadNum\(s32 data_num, s32 num\);)/static $1/m' "$BUILD/include/game/data.h" 2>/dev/null || true
perl -0pi -e 's{^(?=(?:BOOL CheckBallCoinDone|void TakeBallStar|void ExecTakeBallStar|BOOL CheckTakeBallStarDone)\b)}{static }mg' "$BUILD/include/game/board/boo.h" 2>/dev/null || true
perl -0pi -e 's/^static (s32 __CARDStart\(s32 chan, CARDCallback txCallback, CARDCallback exiCallback\)\n\{)/$1/m' "$BUILD/src/dolphin/card/CARDBios.c" 2>/dev/null || true
#     omAddObjEx: canonicalize the header prototype's 6th param to the definition's fn-ptr type:
perl -0pi -e 's/(omObjData \*omAddObjEx\(Process \*objman_process, s16 prio, u16 mdlcnt, u16 mtncnt, s16 group, )omObjFunc func(\);)/${1}void (*func)(omObjData *)${2}/' "$BUILD/include/game/object.h" 2>/dev/null || true
#     HuSetVecF: mapspace.c carries a WRONG local prototype (double args); the definition
#     (setvf.c, byte-matching main.elf) is f32. Correct it to match (workflow-verified):
perl -0pi -e 's/\bextern\s+void\s+HuSetVecF\s*\(\s*Vec\s*\*\s*,\s*double\s*,\s*double\s*,\s*double\s*\)\s*;/extern void HuSetVecF(Vec*, f32, f32, f32);/g' "$BUILD/src/game/mapspace.c" 2>/dev/null || true
#     PPCSync: host-boundary asm primitive (void, per PPCArch.c + main.elf size 0x8 = sync;blr);
#     several callers wrongly declare `int PPCSync(void)` and never use the return. Normalize
#     to void so the wasm import type is consistent across all callers.
for f in $(grep -rl 'int PPCSync' "$BUILD/src" "$BUILD/include" 2>/dev/null); do
  perl -0pi -e 's/\bint\s+PPCSync\s*\(\s*void\s*\)/void PPCSync(void)/g' "$f" 2>/dev/null || true
done
#     __GXAbortWaitPECopyDone: sreset.c's only prototype sits inside a Japanese-version
#     #if branch, which VERSION=0 (English) excludes -> the call implicit-declares int.
#     Prepend a file-scope prototype (idempotent) so it matches the GXMisc.c void def.
perl -0pi -e 'BEGIN{undef $/;} s/\A(?!void __GXAbortWaitPECopyDone)/void __GXAbortWaitPECopyDone(void);\n/' "$BUILD/src/game/sreset.c" 2>/dev/null || true

# 3c. GX RENDER PATH. Redirect the SDK's GP-FIFO write macros (GXPriv.h) to the software
#     write-gather-pipe ring, and port the paired-single / WPAR asm blocks in GXTransform.c
#     + GXInit.c to portable C — semantics taken byte-for-byte from the decomp (= native
#     Dolphin): each WriteMTXPS/WriteProjPS emits its matrix floats row-major, and the
#     hardware write-gather-buffer is always "empty" for a synchronous software pipe. This
#     compiles the real GX SDK IN so GXLoadPosMtxImm/GXSetProjection/GXSetViewport/... emit
#     the complete GP-FIFO stream (XF/BP/CP register loads) instead of being host imports.
GXP="$BUILD/include/dolphin/gx/GXPriv.h"
# GXPriv.h already includes GXVert.h (via dolphin/gx.h) before these macros, so the
# gx_wgpipe_* prototypes are visible — do NOT re-declare them (a mismatched forward decl
# clashes, e.g. `unsigned int` vs the decomp's u32 = unsigned long). Just redirect.
perl -0pi -e 's{#define GX_WRITE_U8\(v\).*}{#define GX_WRITE_U8(v) gx_wgpipe_u8((u8)(v))}; s{#define GX_WRITE_U16\(us\).*}{#define GX_WRITE_U16(us) gx_wgpipe_u16((u16)(us))}; s{#define GX_WRITE_U32\(v\).*}{#define GX_WRITE_U32(v) gx_wgpipe_u32((u32)(v))}; s{#define GX_WRITE_F32\(f\).*}{#define GX_WRITE_F32(f) gx_wgpipe_f32((f32)(f))}' "$GXP" 2>/dev/null || true
GXT="$BUILD/src/dolphin/gx/GXTransform.c"
perl -0pi -e 's/static void WriteProjPS\([^{]*\)\s*\{.*?\n\}/static void WriteProjPS(const f32 proj[6], volatile void *dest){int i;(void)dest;for(i=0;i<6;i++)gx_wgpipe_f32(proj[i]);}/s' "$GXT" 2>/dev/null || true
perl -0pi -e 's/static void WriteMTXPS4x3\([^{]*\)\s*\{.*?\n\}/static void WriteMTXPS4x3(const f32 mtx[3][4], volatile f32 *dest){int i,j;(void)dest;for(i=0;i<3;i++)for(j=0;j<4;j++)gx_wgpipe_f32(mtx[i][j]);}/s' "$GXT" 2>/dev/null || true
perl -0pi -e 's/static void WriteMTXPS3x3from3x4\([^{]*\)\s*\{.*?\n\}/static void WriteMTXPS3x3from3x4(f32 mtx[3][4], volatile f32 *dest){int i,j;(void)dest;for(i=0;i<3;i++)for(j=0;j<3;j++)gx_wgpipe_f32(mtx[i][j]);}/s' "$GXT" 2>/dev/null || true
perl -0pi -e 's/static void WriteMTXPS4x2\([^{]*\)\s*\{.*?\n\}/static void WriteMTXPS4x2(const f32 mtx[2][4], volatile f32 *dest){int i,j;(void)dest;for(i=0;i<2;i++)for(j=0;j<4;j++)gx_wgpipe_f32(mtx[i][j]);}/s' "$GXT" 2>/dev/null || true
perl -0pi -e 's/asm BOOL IsWriteGatherBufferEmpty\(void\)\s*\{.*?\n\}/BOOL IsWriteGatherBufferEmpty(void){return 1;}/s' "$BUILD/src/dolphin/gx/GXInit.c" 2>/dev/null || true
#     mwcc lvalue-cast / incompatible-pointer rewrites (source-compatible, behavior-preserving):
perl -0pi -e 's/\(u8 \*\)(card->buffer)\s*\+=/*(u8 **)&$1 +=/g' "$BUILD/src/dolphin/card/CARDRdwr.c" 2>/dev/null || true
perl -0pi -e 's/\Qfor (ptr = (char *)buf; ptr - buf < len; ptr++) {\E/for (ptr = (char *)buf; ptr - (char *)buf < len; ptr++) {/' "$BUILD/src/dolphin/exi/EXIUart.c" 2>/dev/null || true
perl -0pi -e 's/\Q(u8 *)buf += xLen;\E/buf = (u8 *)buf + xLen;/' "$BUILD/src/dolphin/exi/EXIUart.c" 2>/dev/null || true

# 3b. Signature reconciliation: inject each decl!=def function's CANONICAL prototype
#     (from its definition = byte-identical to native Dolphin's main.elf) into the
#     outlier caller units that implicit-declare it. List discovered by gen_sig_fixes.py
#     (gamecube/recomp/sig_fixes.json); replay is deterministic + idempotent. See
#     memory: the mwcc decl!=def reconciliation.
if [ -f "$RECOMP/sig_fixes.json" ]; then
python3 - "$BUILD" "$RECOMP/sig_fixes.json" <<'PYEOF'
import os,re,sys,json,glob
B,jf=sys.argv[1],sys.argv[2]
fixes=json.load(open(jf))
SRC=os.path.join(B,"src")
TYPE=r'(?:void|int|char|float|double|BOOL|u8|u16|u32|s8|s16|s32|f32|f64|unsigned|signed|long|short|Vec|Mtx)'
cfiles=[f for d in ("game","dolphin","libhu") for f in glob.glob(os.path.join(SRC,d,"**","*.c"),recursive=True)
        if "/dolphin/mtx/" not in f and "/REL/" not in f and "/dolphin/card/" not in f and not f.endswith("/game/kerent.c")]
def read(f): return open(f,errors="surrogateescape").read()
def match_paren(t,i):
    d=0
    for k in range(i,len(t)):
        if t[k]=='(': d+=1
        elif t[k]==')':
            d-=1
            if d==0: return k
    return -1
def split_args(s):
    out,d,cur=[],0,''
    for c in s:
        if c in '([{': d+=1; cur+=c
        elif c in ')]}': d-=1; cur+=c
        elif c==',' and d==0: out.append(cur); cur=''
        else: cur+=c
    if cur.strip() or out: out.append(cur)
    return out
def truncate_calls(t,name,n):
    pat=re.compile(r'(?<![A-Za-z0-9_])'+re.escape(name)+r'\s*\('); out=''; i=0; ch=False
    while True:
        m=pat.search(t,i)
        if not m: out+=t[i:]; break
        op=m.end()-1; cl=match_paren(t,op)
        if cl<0: out+=t[i:]; break
        after=t[cl+1:cl+40].lstrip(); ne=[a for a in split_args(t[op+1:cl]) if a.strip()]
        pre=t[max(0,m.start()-16):m.start()]
        is_proto=after[:1]==';' and re.search(TYPE+r'[ \t\*]+$',pre)
        if after[:1]!='{' and not is_proto and len(ne)>n:
            inner=', '.join(a.strip() for a in ne[:n]); ch=True
        else: inner=t[op+1:cl]
        out+=t[i:op+1]+inner+')'; i=cl+1
    return out,ch
for fx in fixes:
    name,proto,hdr=fx["symbol"],fx["proto"],fx.get("header"); ar=fx.get("arity")
    declpat=re.compile(r'(?m)^[ \t]*(?:extern[ \t]+)?[A-Za-z_][\w \t\*]+?\b'+re.escape(name)+r'\s*\([^{}]*?\)\s*;')
    defpat=re.compile(r'(?m)^[A-Za-z_][\w \t\*]*\b'+re.escape(name)+r'\s*\([^;{}]*\)\s*\{')
    for f in cfiles:
        s=read(f)
        if not re.search(r'(?<![A-Za-z0-9_])'+re.escape(name)+r'\s*\(',s): continue   # doesn't call it
        isdef=bool(defpat.search(s))
        # truncate over-arg call sites (mwcc dropped extras) unless this is the def file
        if ar is not None and not isdef:
            nt,ch=truncate_calls(s,name,ar)
            if ch: s=nt; open(f,"w",errors="surrogateescape").write(s)
        if proto in s: continue                                                        # already injected
        if declpat.search(s): continue                                                 # already has a prototype
        if hdr and ('"%s"'%hdr in s or '<%s>'%hdr in s): continue                       # includes declaring header
        if isdef: continue                                                             # def file
        incs=list(re.finditer(r'(?m)^#include[^\n]*\n',s)); ins=incs[-1].end() if incs else 0
        open(f,"w",errors="surrogateescape").write(s[:ins]+proto+"\n"+s[ins:])
PYEOF
fi

# 4. compile game + high-level SDK translation units to wasm objects. Force-include
#    the canonical prototypes (types-only base, so no implicit-decl shift).
CFLAGS=( -c -std=gnu89 -O2 -w -Wno-error -Wno-implicit-function-declaration
        -Wno-return-mismatch -Wno-int-conversion
        -Wno-incompatible-function-pointer-types -Wno-incompatible-pointer-types
        -Wno-builtin-requires-header -fno-builtin
        -DVERSION=0 -fdeclspec
        -I "$BUILD/include" -I "$BUILD/gen" -I "$BUILD/extern/musyx/include" -I "$BUILD/src" )
# NOTE: implicit-declaration signature mismatches (a bounded finite set surfaced at
# link) are resolved in port-completion by adding the missing per-unit includes; the
# force-include-everything shortcuts (hand prototypes / all-headers) proved fragile
# (wrong-arg protos; missing-header propagation) and were dropped. See PLAN.md.
rm -rf "$BUILD/obj"; mkdir -p "$BUILD/obj"
ok=0; fail=0; : > "$BUILD/fails.txt"
# Units whose bodies are PPC inline asm and are replaced by portable shims
# (gamecube/recomp/shims/src): the whole dolphin/mtx math library.
# Skip: (a) the mtx asm math lib (replaced by portable shims); (b) kerent.c — the
# REL/overlay kernel-jump dispatcher (the _kerjmp trampolines + void jump-table
# entries). That dynamic-overlay dispatch is a HOST-LAYER subsystem, not game logic;
# its stale object is the sole shared caller keeping the residual signatures mismatched.
# Also skip src/REL/* — the dynamically-loaded overlay modules (m459dll, m427Dll, …).
# They are SEPARATE link units in the real game (each loaded on demand via the kerjmp
# overlay dispatcher); several share auto-generated symbol names (fn_1_XXXX) that
# collide when flat-linked. They belong to the overlay-loader host subsystem, compiled
# per-overlay, not into the main DOL module.
# Also skip dolphin/card/* — the memory-card SDK driver is a HOST subsystem (talks to
# card hardware -> browser storage), like GX/VI/DVD. It also carries a bounded 3-arg
# strcat(dst,src,max) that name-collides with libc's 2-arg strcat at link.
skip_unit() { case "$1" in */dolphin/mtx/*|*/game/kerent.c|*/src/REL/*|*/dolphin/card/*) return 0;; esac; return 1; }
compile_one() {
  local f="$1" o
  # printf (NOT echo): echo's trailing newline is mapped to '_' by `tr -c`, yielding
  # a name (...c_.o) that differs from canonicalize_and_link.py's obj_path (...c.o) —
  # the loop then never overwrites this object, so the STALE no-protos copy and the
  # fresh with-protos copy BOTH link, and wasm-ld sees two signatures for one symbol.
  o="$BUILD/obj/$(printf '%s' "${f#$BUILD/}" | tr '/' '_' | tr -c 'A-Za-z0-9_.-' '_').o"
  if emcc "${CFLAGS[@]}" "$f" -o "$o" 2>/tmp/ce.txt; then ok=$((ok+1)); else
    fail=$((fail+1)); echo "$(basename "$f"): $(grep -m1 'error:' /tmp/ce.txt | sed 's|.*error: ||')" >> "$BUILD/fails.txt"; fi
}
compile_dir() {
  for f in $(find "$1" -name '*.c' 2>/dev/null); do skip_unit "$f" && continue; compile_one "$f"; done
}
# portable replacements first
for f in "$RECOMP"/shims/src/*.c; do compile_one "$f"; done
compile_dir "$BUILD/src/game"
compile_dir "$BUILD/src/dolphin"
compile_dir "$BUILD/src/libhu"
echo "[recomp] wasm objects: $ok built, $fail failed"
echo "[recomp] object bytes: $(cat "$BUILD"/obj/*.o 2>/dev/null | wc -c)"
echo "[recomp] top remaining blockers:"
sed -E 's/[0-9]+/N/g' "$BUILD/fails.txt" | sed -E "s/'[^']*'/X/g" | sort | uniq -c | sort -rn | head -10

# 5. link the game object set into a wasm module (host/OS symbols left as imports).
#    --no-entry --no-gc-sections retains ALL compiled game code (this is a game-logic
#    module the host layer calls into, not an executable with a main); without it, -O2
#    dead-strips everything unreachable from an export down to a near-empty stub.
echo "[recomp] linking $(ls "$BUILD"/obj/*.o 2>/dev/null | wc -l) objects -> wasm module (undefined = host imports)..."
#    Export the GP-FIFO ring accessors so the buffer ESCAPES the module — otherwise
#    Binaryen -O2 proves gx_fifo_buf is write-only-never-read and dead-strips the entire
#    write-gather-pipe chain (the game's whole render output). The host reads the FIFO
#    via [gx_fifo_base(), gx_fifo_base()+gx_fifo_pos()) and calls gx_fifo_reset() per frame.
if emcc "$BUILD"/obj/*.o -o "$BUILD/mp4_game.wasm" \
     -sERROR_ON_UNDEFINED_SYMBOLS=0 -sALLOW_MEMORY_GROWTH=1 -sSTANDALONE_WASM=1 \
     -Wl,--export=gx_fifo_base -Wl,--export=gx_fifo_pos -Wl,--export=gx_fifo_reset \
     -Wl,--no-entry -Wl,--no-gc-sections -Wl,--allow-undefined -Wl,--allow-multiple-definition -O2 2>"$BUILD/link.txt"; then
  echo "[recomp] LINKED: $BUILD/mp4_game.wasm ($(stat -f%z "$BUILD/mp4_game.wasm" 2>/dev/null) bytes)"
  echo "[recomp] file: $(file "$BUILD/mp4_game.wasm" 2>/dev/null | sed 's|.*: ||')"
  echo "[recomp] wasm signature mismatches: $(grep -c 'signature mismatch' "$BUILD/link.txt")"
else
  echo "[recomp] link errors (top):"; grep -m8 -iE "error|duplicate|undefined" "$BUILD/link.txt" | sed -E "s/'[^']*'/X/g" | sort -u | head -8
fi

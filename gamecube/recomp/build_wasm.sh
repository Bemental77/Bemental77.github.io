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
#
# CANONICAL FULL-BOOT BUILD (what gamecube/recomp/mp4_game.{js,wasm} is built from —
# a bare invocation omits the AOT overlays and the live path WEDGES at the first
# overlay switch, ~f1033 after Start; cost a debug detour 2026-08-26):
#   RECOMP_MODESEL=1 RECOMP_MENT=1 RECOMP_W01=1 bash gamecube/recomp/build_wasm.sh
# (bootDll is on by default; RECOMP_*DIAG vars are temporary diagnostics, keep OFF.)
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
if [ -n "${RECOMP_HSFDIAG:-}" ]; then CFLAGS_EXTRA_HSF="-DRECOMP_HSFDIAG"; else CFLAGS_EXTRA_HSF=""; fi
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
#     DISPLAY-LIST CAPTURE: the SDK builds DLs by swapping the CPU-fifo object and counting
#     via PI regs — both invisible/zero under the software wgpipe, so every runtime-built
#     model DL (hsfdraw MakeDL) measured 0 bytes and GXCallDisplayList emitted size=0: NO 3D
#     geometry ever reached the stream. Rewrite both bodies to drive the shim redirect
#     (gx_wgpipe.c gx_wgpipe_dl_begin/_end); dirty state flushes to the MAIN fifo before the
#     redirect and into the DL before restore, matching real hardware ordering.
perl -0pi -e 's/void GXBeginDisplayList\(void \*list, u32 size\)\n\{.*?\n\}/void GXBeginDisplayList(void *list, u32 size)\n{\n    extern void gx_wgpipe_dl_begin(void *, u32);\n    if (gx->dirtyState != 0) { __GXSetDirtyState(); }\n    if (gx->dlSaveContext != 0) { memcpy(\&__savedGXdata, gx, sizeof(__savedGXdata)); }\n    gx->inDispList = 1;\n    gx_wgpipe_dl_begin(list, size);\n}/s' "$BUILD/src/dolphin/gx/GXDisplayList.c" 2>/dev/null || true
perl -0pi -e 's/unsigned long GXEndDisplayList\(void\)\n\{.*?\n\}/unsigned long GXEndDisplayList(void)\n{\n    extern u32 gx_wgpipe_dl_end(void);\n    u32 n;\n    if (gx->dirtyState != 0) { __GXSetDirtyState(); }\n    n = gx_wgpipe_dl_end();\n    if (gx->dlSaveContext != 0) { u32 cpenable = gx->cpEnable; memcpy(gx, \&__savedGXdata, sizeof(*gx)); gx->cpEnable = cpenable; }\n    gx->inDispList = 0;\n    return n;\n}/s' "$BUILD/src/dolphin/gx/GXDisplayList.c" 2>/dev/null || true
#     mwcc lvalue-cast / incompatible-pointer rewrites (source-compatible, behavior-preserving):
perl -0pi -e 's/\(u8 \*\)(card->buffer)\s*\+=/*(u8 **)&$1 +=/g' "$BUILD/src/dolphin/card/CARDRdwr.c" 2>/dev/null || true
perl -0pi -e 's/\Qfor (ptr = (char *)buf; ptr - buf < len; ptr++) {\E/for (ptr = (char *)buf; ptr - (char *)buf < len; ptr++) {/' "$BUILD/src/dolphin/exi/EXIUart.c" 2>/dev/null || true
perl -0pi -e 's/\Q(u8 *)buf += xLen;\E/buf = (u8 *)buf + xLen;/' "$BUILD/src/dolphin/exi/EXIUart.c" 2>/dev/null || true
#     malloc.c: the game allocator (HuMemDirectMalloc/HuMemInitAll/…) is portable C but fails
#     ONLY on `asm { mflr <var> }` blocks that capture a debug return-address. Replace each
#     with `<var> = 0;` so the whole allocator compiles IN (removes ~8 HuMem* host imports).
#     Behavior-preserving: retaddr is only a heap-debug tag passed to HuMemMemoryAlloc.
perl -0pi -e 's/asm\s*\{\s*mflr\s+(\w+)\s*\}/$1 = 0;/gs' "$BUILD/src/game/malloc.c" 2>/dev/null || true
#     dvdfs.c: enable long filenames. OSInit (OS.c:249) normally sets __DVDLongFileNameFlag=1
#     ("made it through debug"); OSInit is a no-op host import here, so the flag stays 0 and
#     DVDConvertPathToEntrynum OSPanics on any datadir name >8 chars (e.g. bkoopasuit.bin) via
#     the legacy 8.3-format check. Set it in __DVDFSInit (host DVD-layer init) instead.
perl -0pi -e 's/(void __DVDFSInit\(\) \{)/$1\n\t__DVDLongFileNameFlag = 1;/' "$BUILD/src/dolphin/dvd/dvdfs.c" 2>/dev/null || true
#     GXMisc.c GXWaitDrawDone: on real HW this blocks on FinishQueue until the PE draw-done
#     interrupt sets DrawDone. There's no PE interrupt in the recomp (the GP-FIFO is emitted
#     synchronously to the software ring, consumed later by Dolphin), so the draw is "done" as
#     soon as it is emitted -> skip the wait (else it spins forever on OSSleepThread).
perl -0pi -e 's/while \(!DrawDone\) \{\s*OSSleepThread\(&FinishQueue\);\s*\}/DrawDone = 1;/s' "$BUILD/src/dolphin/gx/GXMisc.c" 2>/dev/null || true
#     [AOT-overlay, REL_ENDIANNESS_PLAN.md step 3] objdll.c omDLLLink: dispatch OVL_BOOT to the
#     statically-compiled bootDll _prolog (executor.c) instead of HuDvdDataReadDirect(.rel from
#     disc) + OSLink (no-op import) + calling the big-endian garbage module->prolog pointer (the
#     current spin). bootDll is compiled into the wasm by step 1. Gated with the step-1 compile.
if [ -z "${RECOMP_NO_BOOTDLL:-}" ]; then
perl -0pi -e 's{(dll->name = dllFile->name;\n)}{$1\tif(overlay == OVL_BOOT){extern s32 _prolog(void); dll->module = 0; dll->bss = 0; if(flag==1){OSReport("objdll> AOT bootDll _prolog\\n"); dll->ret = _prolog();} return dll;}\n}' "$BUILD/src/game/objdll.c" 2>/dev/null || true
#     AOT overlays have dll->module==0, so omDLLUnlink's epilog call + OSUnlink + module free would
#     null-deref when the overlay is killed (title -> OVL_MODESEL switch). Guard the module accesses.
perl -0pi -e 's/(\(\(DLLEpilog\)dll_ptr->module->epilog\)\(\);)/if(dll_ptr->module) $1/' "$BUILD/src/game/objdll.c" 2>/dev/null || true
perl -0pi -e 's/(if\(OSUnlink\(&dll_ptr->module->info\) != TRUE\))/if(dll_ptr->module \&\& OSUnlink(&dll_ptr->module->info) != TRUE)/' "$BUILD/src/game/objdll.c" 2>/dev/null || true
perl -0pi -e 's/(HuMemDirectFree\(dll_ptr->module\);)/if(dll_ptr->module) $1/' "$BUILD/src/game/objdll.c" 2>/dev/null || true
#     [step 4] bootDll NintendoDataDecode: the compiled-in nintendoData.inc is BIG-ENDIAN; the
#     size + decode_type header u32s are read natively (LE-wrong). Byte-swap them (HuDecodeData
#     reads the compressed body byte-by-byte per data.c:587, so only the 2 header reads need it).
perl -0pi -e 's/(u32 size = )\*src\+\+;/${1}__builtin_bswap32(*src++);/; s/(int decode_type = )\*src\+\+;/${1}(int)__builtin_bswap32(*src++);/' "$BUILD/src/REL/bootDll/main.c" 2>/dev/null || true
#     [step 5] byte-swap the decoded BE AnimData sprite tree to LE once at decode time, so
#     HuSprAnimRead + the sprite render path read correct offsets/counts (shims/src/gc_anim_bswap.c).
perl -0pi -e 's/(HuDecodeData\(src, dst, size, decode_type\);)/$1\n\t\t{ extern void __recomp_bswap_animtree(void*); __recomp_bswap_animtree(dst); }/' "$BUILD/src/REL/bootDll/main.c" 2>/dev/null || true
fi
#     [AOT-overlay, generalized] dispatch OVL_MODESEL to the statically-compiled, symbol-namespaced
#     modesel_prolog (shims/src/gc_ovl_dispatch.c -> modesel_ObjectSetup), same trick as OVL_BOOT.
#     Inserted after the OVL_BOOT case. Gated with the modesel compile below.
if [ -n "${RECOMP_MODESEL:-}" ]; then
perl -0pi -e 's{(if\(overlay == OVL_BOOT\)\{.*?return dll;\}\n)}{$1\tif(overlay == OVL_MODESEL){extern s32 modesel_prolog(void); dll->module = 0; dll->bss = 0; if(flag==1){OSReport("objdll> AOT modesel_prolog\\n"); dll->ret = modesel_prolog();} return dll;}\n}s' "$BUILD/src/game/objdll.c" 2>/dev/null || true
fi
#     [AOT-overlay] OVL_MENT (Party-Mode entry/setup, the overlay the mode carousel calls into)
#     — same static dispatch; ment_prolog (gc_ovl_dispatch.c) runs fn_mt1_144, mentDll's real
#     init (its own _prolog minus the empty ctor walk). Gated with the ment compile below.
if [ -n "${RECOMP_MENT:-}" ]; then
perl -0pi -e 's{(if\(overlay == OVL_MODESEL\)\{.*?return dll;\}\n)}{$1\tif(overlay == OVL_MENT){extern s32 ment_prolog(void); dll->module = 0; dll->bss = 0; if(flag==1){OSReport("objdll> AOT ment_prolog\\n"); dll->ret = ment_prolog();} return dll;}\n}s' "$BUILD/src/game/objdll.c" 2>/dev/null || true
fi
#     [AOT-overlay] OVL_W01 — the first BOARD (Toad's Midway Madness), the 120fps target scene.
if [ -n "${RECOMP_W01:-}" ]; then
perl -0pi -e 's{(if\(overlay == OVL_MENT\)\{.*?return dll;\}\n)}{$1\tif(overlay == OVL_W01){extern s32 w01_prolog(void); dll->module = 0; dll->bss = 0; if(flag==1){OSReport("objdll> AOT w01_prolog\\n"); dll->ret = w01_prolog();} return dll;}\n}s' "$BUILD/src/game/objdll.c" 2>/dev/null || true
fi
if [ -n "${RECOMP_MSDIAG:-}" ]; then
perl -0pi -e 's/(void BootExec\(void\)\s*\n\{)/$1\n    OSReport("MK-OMOVL evt=%d init=%d\\n", omovlevtno, SystemInitF);/' "$BUILD/src/REL/bootDll/main.c" 2>/dev/null || true
fi
#     [general asset endianness] GetFileInfo (data.c) walks a DATADIR archive's BIG-ENDIAN header:
#     it reads offsets[file_num], then the sub-file's raw_len + comp_type — all as native (LE-wrong)
#     u32s. Unswapped, offsets[0]=0x24 reads as 0x24000000 -> dir+0x24000000 -> OOB (the frame-41
#     trap on effect.bin). Byte-swap all three reads. This is the GENERAL seam: fixes every DATADIR
#     archive (effect, sprites, models, ...), not just effect.bin. Sub-file DATA still needs its own
#     format swap (AnimData/HSF), handled per-consumer.
perl -0pi -e 's/(read_stat->file = PTR_OFFSET\(read_stat->dir, )\*temp_ptr(\);)/${1}__builtin_bswap32(*temp_ptr)${2}/;
              s/(read_stat->raw_len = )\*temp_ptr\+\+;/${1}__builtin_bswap32(*temp_ptr); temp_ptr++;/;
              s/(read_stat->comp_type = )\*temp_ptr\+\+;/${1}__builtin_bswap32(*temp_ptr); temp_ptr++;/;' "$BUILD/src/game/data.c" 2>/dev/null || true
#     [ARAM-archive endianness] HuAR_ARAMtoMRAMFileRead (armem.c) is the ARAM twin of GetFileInfo:
#     it walks the ARAM-staged archive's BIG-ENDIAN offset table (preLoadBuf entry pair) and the
#     sub-file's raw_len/comp_type header with native reads -> size 0x2c030020 alloc error at
#     HuWinCreate (window graphics live in an ARAM-staged dir) -> NULL win -> HuMemMemoryAlloc
#     free-list spin on the dead window. Swap all five reads (verified the only such walk in armem.c).
perl -0pi -e 's/count = dir_data\[0\];/count = (s32)__builtin_bswap32((u32)dir_data[0]);/;
              s/if \(dir_data\[1\] - count < 0\) \{/if ((s32)__builtin_bswap32((u32)dir_data[1]) - count < 0) {/;
              s/size = \(dir_data\[1\] - count \+ 0x3F\)/size = ((s32)__builtin_bswap32((u32)dir_data[1]) - count + 0x3F)/;
              s/dst = HuMemDirectMallocNum\(heap, \(dir_data\[0\] \+ 1\) & ~1, num\);/dst = HuMemDirectMallocNum(heap, ((s32)__builtin_bswap32((u32)dir_data[0]) + 1) & ~1, num);/;
              s/HuDecodeData\(&dir_data\[2\], dst, dir_data\[0\], dir_data\[1\]\);/HuDecodeData(\&dir_data[2], dst, (s32)__builtin_bswap32((u32)dir_data[0]), (s32)__builtin_bswap32((u32)dir_data[1]));/;' "$BUILD/src/game/armem.c" 2>/dev/null || true
#     [DIAG, gated] FONTDIAG: print every 320-wide HuSprTexLoad (anim/bmp/data ptrs) — the
#     board-font barcode forensics (FIFO SETIMAGE base diverges from the only header in RAM).
if [ -n "${RECOMP_FONTDIAG:-}" ]; then
perl -0pi -e 's/(short sizeY = bmp_ptr->sizeY;)/$1\n    { extern void OSReport(const char*, ...); if (bmp_ptr->sizeX == 320) OSReport("FONTTEX anim=%08x bmpp=%08x data=%08x palp=%08x fmt=%d szY=%d\\n", (u32)anim, (u32)bmp_ptr, (u32)bmp_ptr->data, (u32)bmp_ptr->palData, bmp_ptr->dataFmt, sizeY); }/' "$BUILD/src/game/sprput.c" 2>/dev/null || true
fi
#     [HSF model endianness] LoadHSF (hsfload.c) interprets a big-endian .hsf 3D-model file (title
#     screen, board, characters) with native LE loads -> garbage counts/offsets -> OOB. Swap the
#     whole file BE->LE once at LoadHSF entry, before FileLoad reads the header. Covers all 21 HSF
#     sections + nested cenv/motion/strip data (shims/src/gc_hsf_bswap.c, built by wf_a2d55c6d).
perl -0pi -e 's/(HsfData \*LoadHSF\(void \*data\)\s*\{)/$1\n    { extern void __recomp_bswap_hsf(void*); __recomp_bswap_hsf(data); }/' "$BUILD/src/game/hsfload.c" 2>/dev/null || true
if [ -n "${RECOMP_MSGDIAG:-}" ]; then
perl -0pi -e 's{(data = HuDvdDataReadWait\(&file, HEAP_DVD, 0, 0, HuDVDReadAsyncCallBack, FALSE\);)}{OSReport("HDDR start=%d len=%d dir=%d\\n", (int)file.startAddr, (int)file.length, (int)DirDataSize); $1}' "$BUILD/src/game/dvd.c" 2>/dev/null || true
fi
#     [message-data endianness] HuWinMesRead loads a BE message .bin; messdata.c walks it native-LE
#     -> garbage offsets -> MessData_MesPtrGet wild pointer -> GetMesMaxSizeSub OOB (the demo/movie
#     subtitle window; LATENT in the default build too, ~frame 610).
#     v2 (2026-08-24): swap AT THE ACCESSORS (messdata.c reads), NOT the whole blob at load —
#     the load-time tree swap (gc_messdata_bswap.c) mis-walked the modesel messfile and 32-bit-
#     scrambled its TEXT bytes ("Sel"/"ect" reversed in 4-byte groups) -> GetMesMaxSizeSub summed
#     a garbage 31328px width -> winBGMake overflow -> HEAP_SYSTEM MCB clobber. Read-site swaps
#     never touch text and are format-agnostic (the GetFileInfo pattern). The blob stays BE.
perl -0pi -e 's/(\s+)max_bank = \*data;/$1max_bank = (s32)__builtin_bswap32((u32)*data);/;
              s/banks = \(u16 \*\)\(\(\(u8 \*\)messdata\)\+\(\*data\)\);/banks = (u16 *)(((u8 *)messdata)+__builtin_bswap32((u32)*data));/;
              s/if\(\*banks == bank\) \{/if((u16)__builtin_bswap16(*banks) == bank) {/;
              s/data \+= banks\[1\];/data += (u16)__builtin_bswap16(banks[1]);/;
              s/return \(\(\(u8 \*\)messdata\)\+\(\*data\)\);/return (((u8 *)messdata)+__builtin_bswap32((u32)*data));/;
              s/(\s+)max_index = \*data;/$1max_index = (s32)__builtin_bswap32((u32)*data);/;
              s/return \(\(\(u8 \*\)messbank\)\+\(\*data\)\);/return (((u8 *)messbank)+__builtin_bswap32((u32)*data));/;' "$BUILD/src/game/messdata.c" 2>/dev/null || true
#     [THP movie skip] The Truemotion (.thp) movie subsystem isn't implemented in the recomp (audio/
#     DSP neutralized, no THP decode/present) -> THPSimpleOpen always fails and THPTestProc spins its
#     open/preload retry `while(...==0)` loops forever ("THPSimpleOpen fail" repeats), and HuTHPEndCheck
#     returns FALSE (no movie) so the demo's `while(!HuTHPEndCheck())` never exits. Skip the movie: bail
#     out of THPTestProc before its spin loops, and report the movie as ended so the demo advances to
#     the title -> OVL_MODESEL. (Skippable intro; general fix until THP playback is implemented.)
perl -0pi -e 's/(\n\s*while \(THPSimpleOpen\(THPFileName\) == 0\) \{)/\n    for(;;) HuPrcVSleep();  \/* movie unsupported: idle this process (do NOT return -> trampoline trap) *\/$1/' "$BUILD/src/game/thpmain.c" 2>/dev/null || true
perl -0pi -e 's/(BOOL HuTHPEndCheck\(void\)\s*\n\{)/$1\n    return 1;/' "$BUILD/src/game/thpmain.c" 2>/dev/null || true
#     THPViewSprFunc is the per-frame sprite draw fn for the video (HuSprFuncCreate) — with the movie
#     skipped it reads a non-existent decoded frame -> the `unreachable` fiber trap. No-op it (the THP
#     sprite stays valid but draws nothing) so the demo can advance.
perl -0pi -e 's/(static void THPViewSprFunc\(HuSprite \*arg0\)\s*\n\{)/$1\n    return;/' "$BUILD/src/game/thpmain.c" 2>/dev/null || true
#     [input inject] the recomp has no VI-retrace interrupt firing PadReadVSync, so HuPadBtnDown
#     never gets real input. Deliver host buttons: OR __recomp_inject_btn (set by the harness via
#     ___recomp_set_inject_btn) into HuPadBtnDown[0] at HuPadRead's end (shims/src/gc_input.c).
#     FRAME-SCOPED (not one-shot): HuPadRead runs MORE THAN ONCE per retrace in some overlays
#     (mentDll char-select), and a consume-on-first-delivery let the second call recompute
#     HuPadBtnDown from _Pad state and WIPE the injected bit before the game logic saw it (the
#     eaten-A stall). The pacing side sets the cells for exactly one frame and clears them at
#     the next retrace, and the HuPrcKill zombie fix removed the double-processing that the
#     one-shot was protecting against.
perl -0pi -e 's/(_PadBtnDown\[i\] = 0;\s*\n\s*\})\n\}/$1\n    { extern int __recomp_inject_btn; extern int __recomp_inject_dstk; extern int __recomp_inject_stkx; extern int __recomp_inject_stky; HuPadBtnDown[0] |= (unsigned short)__recomp_inject_btn; HuPadDStkRep[0] |= (unsigned char)__recomp_inject_dstk; if (__recomp_inject_stkx) HuPadStkX[0] = (s8)__recomp_inject_stkx; if (__recomp_inject_stky) HuPadStkY[0] = (s8)__recomp_inject_stky; }\n}/' "$BUILD/src/game/pad.c" 2>/dev/null || true
#     [system clocks] __OSBusClock/__OSCoreClock (os.h, AT_ADDRESS 0x800000F8/FC) are written by the
#     bootrom + OSInit on real HW; here AT_ADDRESS is stripped -> plain BSS globals, and OSInit is a
#     no-op import, so they stay 0 -> the OSTicksToMilliseconds macro (ticks/(__OSBusClock/4000))
#     divides by zero in the first timer loop (BootTitleExec). A strong initialized def is ignored
#     under -Wl,--allow-multiple-definition (first/tentative def wins), so ASSIGN them at runtime at
#     the very start of main() instead (before any timer loop runs).
perl -0pi -e 's/(void main\(void\)\s*\n\{)/$1\n    __OSBusClock = 162000000u; __OSCoreClock = 486000000u;/' "$BUILD/src/game/main.c" 2>/dev/null || true
#     [general sprite endianness] HuSprAnimReadFile(id) = HuSprAnimRead(HuDataSelHeapReadNum(...)).
#     The BE disc AnimData is read natively by HuSprAnimRead, whose sentinel (anim->bank&0xFFFF0000)
#     mis-fires on a BE offset -> the sprite is silently dropped (garbage/no texture). Wrap the inner
#     read so the fresh blob is byte-swapped ONCE (shims/src/gc_anim_bswap.c) before HuSprAnimRead.
#     Fixes ALL disc sprites (title bg/copyright/press-start, game sprites); the bootDll logo doesn't
#     use this macro so it is unaffected (no double-swap).
perl -0pi -e 's/#define HuSprAnimReadFile\(data_id\) \(HuSprAnimRead\((HuDataSelHeapReadNum\(\(data_id\), MEMORY_DEFAULT_NUM, HEAP_DATA\))\)\)/extern void *__recomp_bswap_animtree_ret(void *);\n#define HuSprAnimReadFile(data_id) (HuSprAnimRead(__recomp_bswap_animtree_ret($1)))/' "$BUILD/include/game/sprite.h" 2>/dev/null || true
#     esprite.c espEntry reads the SAME fresh disc AnimData but calls HuSprAnimRead directly
#     (not via the macro) -> BE blob parsed natively -> garbage-size mallocs (0x2c030020) +
#     HuMemMemoryAlloc free-list spin when the modesel menu creates its sprites. Wrap it too.
perl -0pi -e 's/(var_r30->unk08 = HuSprAnimRead\()(temp_r26)(\);)/{ extern void *__recomp_bswap_animtree_ret(void *); $1__recomp_bswap_animtree_ret($2)$3 }/' "$BUILD/src/game/esprite.c" 2>/dev/null || true
#     board/space.c manually relocates AnimData blobs (data->bmp = base + ofs) WITHOUT going
#     through HuSprAnimRead — the auto-swap hook never runs, the BE offsets produce wild
#     pointers, and bmp->dataSize feeds an OOB memcpy (the first w01 BoardCreate trap).
#     Wrap those fresh reads with the auto-detecting swapper.
perl -0pi -e 's/\A/extern void *__recomp_bswap_animtree_auto(void *);\n/; s/(data = data_base = )(HuDataSelHeapReadNum\([^;]*\));/$1__recomp_bswap_animtree_auto($2);/g' "$BUILD/src/game/board/space.c" 2>/dev/null || true
#     [DIAG, gated] board 3D-view forensics: camera LookAt inputs at matrix-build time +
#     first parsed board-space record — localizes whether the garbage XF matrices come from
#     the space file parse or the camera state feeding C_MTXLookAt.
if [ -n "${RECOMP_CAMDIAG:-}" ]; then
  perl -0pi -e 's/(    C_MTXLookAt\(arg1, &temp_r31->pos, &temp_r31->up, &temp_r31->target\);)/{ static int __cd; if ((++__cd % 120) == 1) OSReport("CAM: pos=%f %f %f up=%f %f %f tgt=%f %f %f\\n", temp_r31->pos.x, temp_r31->pos.y, temp_r31->pos.z, temp_r31->up.x, temp_r31->up.y, temp_r31->up.z, temp_r31->target.x, temp_r31->target.y, temp_r31->target.z); }\n$1/' "$BUILD/src/game/hsfman.c" 2>/dev/null || true
  perl -0pi -e 's/(    HuDataClose\(data_base\);\n    return 0;\n\})/    OSReport("SPACE: cnt=%d s1 pos=%f %f %f rot=%f %f %f scale=%f %f %f type=%d links=%d\\n", spaceCnt[layer], spaceData[layer][1].pos.x, spaceData[layer][1].pos.y, spaceData[layer][1].pos.z, spaceData[layer][1].rot.x, spaceData[layer][1].rot.y, spaceData[layer][1].rot.z, spaceData[layer][1].scale.x, spaceData[layer][1].scale.y, spaceData[layer][1].scale.z, spaceData[layer][1].type, spaceData[layer][1].link_cnt);\n$1/' "$BUILD/src/game/board/space.c" 2>/dev/null || true
  # DrawSpaces state: boardCamera fields + the lookat matrix it just built
  perl -0pi -e 's/(    GXSetViewport\(camera->viewport_x, camera->viewport_y, camera->viewport_w, camera->viewport_h, camera->viewport_near, camera->viewport_far\);)/{ static int __ds; if ((++__ds % 60) == 1) { OSReport("DSPC: cam pos=%f %f %f tgt=%f %f %f up=%f %f %f fov=%f asp=%f near=%f far=%f vp=%f %f %f %f\\n", pos.x, pos.y, pos.z, target.x, target.y, target.z, camera->up.x, camera->up.y, camera->up.z, camera->fov, camera->aspect, camera->near, camera->far, camera->viewport_x, camera->viewport_y, camera->viewport_w, camera->viewport_h); OSReport("DSPC: lk0=%f %f %f %f lk1=%f %f %f %f lk2=%f %f %f %f\\n", lookat[0][0], lookat[0][1], lookat[0][2], lookat[0][3], lookat[1][0], lookat[1][1], lookat[1][2], lookat[1][3], lookat[2][0], lookat[2][1], lookat[2][2], lookat[2][3]); } }\n$1/' "$BUILD/src/game/board/space.c" 2>/dev/null || true
fi
#     GXLight.c defines a file-local Newton-iteration sqrtf built on the __frsqrte PPC
#     intrinsic. Under emcc that definition is emitted as a GLOBAL symbol and SHADOWS libc
#     sqrtf binary-wide via -Wl,--allow-multiple-definition — and with __frsqrte stubbed it
#     returned 0 for every input, silently no-op'ing every VECNormalize/VECMag in the game
#     (the board's garbage lookat matrices / culled world, found 2026-08-25). Rename it so
#     every caller (GXLight included) gets libc's native f32.sqrt.
perl -0pi -e 's/\A/#include <math.h>\n/; s/inline float sqrtf\(float x\)/static inline float __gx_msl_sqrtf_unused(float x) __attribute__((unused));\nstatic inline float __gx_msl_sqrtf_unused(float x)/' "$BUILD/src/dolphin/gx/GXLight.c" 2>/dev/null || true
#     Gekko integer divide-by-zero is silent (divw returns undefined, no exception); wasm
#     i32.rem_u TRAPS. The game genuinely does x%0 (e.g. ParManFunc's dice-roll effect:
#     diceEffParam.unk08=0.0f -> frandmod(0) at board turn start). Guard the two modulo
#     helpers once — covers every caller, matches hardware's "garbage but no crash".
perl -0pi -e 's/(u32 frandmod\(u32 arg0\) \{)/$1\n    if (arg0 == 0) return 0;/' "$BUILD/src/game/frand.c" 2>/dev/null || true
perl -0pi -e 's/(u32 BoardRandMod\(u32 value\)\n\{)/$1\n    if (value == 0) return 0;/' "$BUILD/src/game/board/main.c" 2>/dev/null || true
#     BoardSpaceRead (board/space.c:939) parses the BE board-layout file natively: u32 count
#     (truncated into an s16 -> 0 -> BoardRandMod %0 trap), 9 f32 per space (pos/rot/scale),
#     u32 flag, u16 type/link_cnt/links. Swap at read (the GetFileInfo pattern).
perl -0pi -e 's/spaceCnt\[layer\] = \*\(u32 \*\)data;/spaceCnt[layer] = __builtin_bswap32(*(u32 *)data);/;
              s/(memcpy\(&space->scale, data, sizeof\(Vec\)\);\n        data \+= sizeof\(Vec\);)/$1\n        { u32 *__v = (u32 *)&space->pos; int __k; for (__k = 0; __k < 9; __k++) __v[__k] = __builtin_bswap32(__v[__k]); }/;
              s/space->flag = \*\(u32 \*\)data;/space->flag = __builtin_bswap32(*(u32 *)data);/;
              s/space->type = \*\(u16 \*\)data;/space->type = __builtin_bswap16(*(u16 *)data);/;
              s/space->link_cnt = \*\(u16 \*\)data;/space->link_cnt = __builtin_bswap16(*(u16 *)data);/;
              s/space->link\[j\] = \(\*\(u16 \*\)data\) \+ 1;/space->link[j] = __builtin_bswap16(*(u16 *)data) + 1;/;' "$BUILD/src/game/board/space.c" 2>/dev/null || true
#     [general, replaces per-site whack-a-mole] The game has 300+ DIRECT HuSprAnimRead call
#     sites (window.c frame tree, chrman, hsfman .inc statics, every overlay/minigame), each
#     handing a fresh BE blob. The missed window.c site corrupted the HEAP_SYSTEM MCB ring
#     under the modesel menu (winBGMake palette scan walked a BE offset as a pointer ->
#     HuMemMemoryAlloc ring spin). Hook HuSprAnimRead's ENTRY with the auto-detecting swap
#     (BE/LE plausibility vote, gc_anim_bswap.c) — pre-swapped/relocated trees vote LE and
#     pass through, so the older per-site swaps stay harmless.
perl -0pi -e 's/(AnimData \*HuSprAnimRead\(void \*data\)\n\{)/$1\n    { extern void *__recomp_bswap_animtree_auto(void *); data = __recomp_bswap_animtree_auto(data); }/' "$BUILD/src/game/sprman.c" 2>/dev/null || true
#     [static-anim double-relocation] The already-relocated sentinel (anim->bank & 0xFFFF0000)
#     never trips for a STATIC .inc tree at a low wasm address (base+bankOfs < 0x10000), so a
#     shared asset's second HuSprAnimRead relocated it TWICE (bank = ofs + 2*base — the
#     title/board noise-texture bind at masked 0x173cbd20). Statics relocate once per address
#     via the shim registry; heap trees keep the retail sentinel (sound at 0x80xxxxxx).
perl -0pi -e 's/(    AnimData \*anim = \(AnimData \*\)data;\n)(    if\(\(u32\)anim->bank & 0xFFFF0000\) \{)/$1    if ((u32)data < 0x80000000u) { extern int __recomp_animreloc_once(void*); if (!__recomp_animreloc_once(data)) { anim->useNum++; return anim; } }\n$2/' "$BUILD/src/game/sprman.c" 2>/dev/null || true
#     [DIAG, gated] on the allocator's error path, call a host import so the probe's JS stub can
#     print the wasm caller chain (retaddr tags are all zeroed by the malloc.c mflr bake, so the
#     in-game "Call" tag is useless). Error-path only — no hot-path cost; gated to keep the
#     canonical build clean.
if [ -n "${RECOMP_ALLOCDIAG:-}" ]; then
  perl -0pi -e 's/(OSReport\("HuMem>memory alloc error %08x\(%08X\): Call %08x\\n", size, num, retaddr\);)/{ extern void __recomp_alloc_trap(unsigned); __recomp_alloc_trap(size); }\n    $1/' "$BUILD/src/game/memory.c" 2>/dev/null || true
fi
#     [DIAG, gated] trap texture binds whose image pointer masks outside MEM1 (the board's
#     garbled cliff/waterfall = a 14x1024-RGBA8 bind at masked 0x173cbd20) — the probe stub
#     prints the wasm caller chain, naming the code path that built the junk GXTexObj.
if [ -n "${RECOMP_TEXDIAG:-}" ]; then
  perl -0pi -e 's/(    __GXTexObjInt \*t = \(__GXTexObjInt \*\)obj;\n\n    ASSERTMSGLINE\(0x235, obj, "Texture Object Pointer is null"\);)/$1\n    { extern void __recomp_texobj_trap(unsigned, unsigned, unsigned); unsigned __ip = (unsigned)image_ptr \& 0x3FFFFFFFu; if (__ip >= 0x01800000u || (RECOMP_TEXDIAG_WATCH \&\& __ip == RECOMP_TEXDIAG_WATCH)) __recomp_texobj_trap((unsigned)image_ptr, ((unsigned)width << 16) | height, (unsigned)format); }/' "$BUILD/src/dolphin/gx/GXTexture.c" 2>/dev/null || true
  perl -0pi -e 's/\A/#define RECOMP_TEXDIAG_WATCH '"${RECOMP_TEXDIAG_WATCH:-0}"'u\n/' "$BUILD/src/dolphin/gx/GXTexture.c" 2>/dev/null || true
  perl -0pi -e 's/(    AnimBmpData \*bmp_ptr = &anim->bmp\[bmp\];)/$1\n    { extern void __recomp_sprtex_trap(unsigned, unsigned, unsigned); unsigned __d = (unsigned)bmp_ptr->data \& 0x3FFFFFFFu; if (__d >= 0x01800000u) __recomp_sprtex_trap((unsigned)anim, (unsigned)bmp, (unsigned)bmp_ptr); }/' "$BUILD/src/game/sprput.c" 2>/dev/null || true
fi
#     [DIAG, gated] winBGMake writes its 0x70/0x80 border fill past the block_w*block_h alloc
#     under the modesel styled window (MCB 0x8027c8e0 clobber) — print its actual geometry.
if [ -n "${RECOMP_WINDIAG:-}" ]; then
  perl -0pi -e 's/(bmp_data = bg->bmp->data = HuMemDirectMallocNum\(HEAP_SYSTEM, block_w \* block_h, MEMORY_DEFAULT_NUM\);)/$1\n    OSReport("winBGMake w=%d h=%d bw=%d bh=%d buf=%x\\n", w, h, block_w, block_h, (u32)bmp_data);/' "$BUILD/src/game/window.c" 2>/dev/null || true
  perl -0pi -e 's/(mess_data = mess_start = MessData_MesPtrGet\(messDataPtr, mess\);)/$1\n        OSReport("MesMax id=%x mdp=%x ptr=%x b=[%x %x %x %x %x %x %x %x %x %x %x %x]\\n", (u32)mess, (u32)messDataPtr, (u32)mess_data, mess_data[0],mess_data[1],mess_data[2],mess_data[3],mess_data[4],mess_data[5],mess_data[6],mess_data[7],mess_data[8],mess_data[9],mess_data[10],mess_data[11]);/' "$BUILD/src/game/window.c" 2>/dev/null || true
fi
#     [DIAG, gated] modesel navigation waypoints: carousel A-break, filesel entry/result, mode
#     dispatch — localizes where an injected A press is consumed on the way to OVL_MENT.
if [ -n "${RECOMP_NAVDIAG:-}" ]; then
  perl -0pi -e 's/(if \(HuPadBtnDown\[0\] & PAD_BUTTON_A\) \{\n(\s+)HuAudFXPlay\(2\);)/$1 OSReport("NAV: A-break\\n");/g' "$BUILD/src/REL/modeseldll/modesel.c" 2>/dev/null || true
  perl -0pi -e 's/(s16 result = fn_(?:ms)?1_2490\(\);)/OSReport("NAV: enter filesel\\n"); $1 OSReport("NAV: filesel result=%d\\n", result);/' "$BUILD/src/REL/modeseldll/main.c" 2>/dev/null || true
  # char-select WAIT-LOOP heartbeat: the loop's own view of every player's (unk_60, unk_70[0]).
  # Anchors INSIDE the always-on autoboard statement-expression (baked below, AFTER this
  # block) — matched here on the pre-bake source? No: this NAVDIAG bake must run AFTER the
  # autoboard bake to find its anchor, so it is deferred via NAVDIAG_WAITHB below.
  NAVDIAG_WAITHB=1
  # player-proc body-entry counter: a fiber resume landing at the TOP re-runs the preamble
  perl -0pi -e 's/(var_r26 = lbl_1_bss_D4;)/{ static int __pe; if ((++__pe % 500) == 1) OSReport("NAV: 13970 entry n=%d cnt=%d\\n", __pe, lbl_1_bss_D4); } $1/' "$BUILD/src/REL/mentDll/main.c" 2>/dev/null || true
  # char-select pick-handler heartbeat: proves the handler runs, which pad it reads, what it sees
  perl -0pi -e 's/(    if \(arg1->unk_70\[0\] == 0\) \{\n        if \(\(HuPadBtnDown\[arg1->unk_6C\] & PAD_BUTTON_A\) != 0\) \{)/    { static int __hb; if ((++__hb % 600) == 1) OSReport("NAV: 15CB4 hb pad=%d unk70=%d btn=%x arg1=%x base=%x\\n", arg1->unk_6C, arg1->unk_70[0], HuPadBtnDown[arg1->unk_6C], (unsigned)arg1, (unsigned)&lbl_1_bss_3114[0]); }\n$1/' "$BUILD/src/REL/mentDll/main.c" 2>/dev/null || true
  # every window message set: id + resolved text (control bytes print as-is; words readable)
  perl -0pi -e 's/(window_ptr->mess = MessData_MesPtrGet\(messDataPtr, mess\);)/$1\n        OSReport("NAV: MesSet win=%d id=%x txt=%s\\n", window, mess, window_ptr->mess ? (char*)window_ptr->mess : "(null)");/' "$BUILD/src/game/window.c" 2>/dev/null || true
  # choice-state key trace: which key bits reach the cursor + the cursor move it causes
  perl -0pi -e 's/(key = HuWinActivePadGet\(window\);)/$1\n    if (key) OSReport("NAV: choice win=%x key=%x curr=%d nch=%d\\n", (u32)window, key, choice_curr, window->num_choices);/' "$BUILD/src/game/window.c" 2>/dev/null || true
fi
#     AUTOBOARD firing point (ALWAYS ON — inert unless the host arms it at runtime via
#     __recomp_autoboard_arm): the char-select wait loop evaluates once per player per frame;
#     after 480 evals armed, gc_autoboard.c commits the default party config and enters the
#     board (OVL_W01). Anchored on the loop's UNIQUE A-latch scan line (verified 1 occurrence;
#     pre-rename lbl_1_ names — the later _mt1_ rename converts inserted code too).
#     HISTORY 2026-08-25: this bake originally sat inside the RECOMP_NAVDIAG gate, so the
#     final clean build shipped an armable-but-never-firing autoboard (?board=1 dead on
#     prod). It must stay ungated; only the heartbeat below is diag.
perl -0pi -e 's/\(lbl_1_bss_3114\[var_r31\]\.unk_60 == 0\) && \(HuPadBtnDown/(({ { extern int __recomp_autoboard_armed; extern void __recomp_autoboard(void); static int __ab; if (__recomp_autoboard_armed && ++__ab == 480) { OSReport("NAV: AUTOBOARD firing\\n"); __recomp_autoboard(); } } lbl_1_bss_3114[var_r31].unk_60 == 0; })) && (HuPadBtnDown/' "$BUILD/src/REL/mentDll/main.c" 2>/dev/null || true
if [ -n "${NAVDIAG_WAITHB:-}" ]; then
  # deferred from the RECOMP_NAVDIAG block above: anchors inside the autoboard bake's text
  perl -0pi -e 's/(\{ extern int __recomp_autoboard_armed;)/{ static int __wb; if ((++__wb % 2400) == 1) OSReport("NAV: 8FB8wait 60s=%d%d%d%d 70s=%d%d%d%d base=%x\\n", lbl_1_bss_3114[0].unk_60, lbl_1_bss_3114[1].unk_60, lbl_1_bss_3114[2].unk_60, lbl_1_bss_3114[3].unk_60, lbl_1_bss_3114[0].unk_70[0], lbl_1_bss_3114[1].unk_70[0], lbl_1_bss_3114[2].unk_70[0], lbl_1_bss_3114[3].unk_70[0], (unsigned)&lbl_1_bss_3114[0]); } $1/' "$BUILD/src/REL/mentDll/main.c" 2>/dev/null || true
fi
#     [DIAG, gated] insert OSReport markers before each main() boot call so a pure-wasm spin
#     (which can't be node-profiled) can be localized by the last marker printed.
if [ -n "${RECOMP_MARKERS:-}" ]; then
  perl -0pi -e 'for my $fn (qw(GWInit pfInit HuSprInit Hu3DInit HuDataInit HuPerfInit WipeInit omMasterInit)) { s/^(\s*)(\Q$fn\E\s*\()/${1}OSReport("MK:$fn\\n");\n${1}${2}/m; }' "$BUILD/src/game/main.c" 2>/dev/null || true
  # per-call marker on the FST path resolver + a spin marker inside its inner walk loop
  perl -0pi -e 's/(s32 DVDConvertPathToEntrynum\(char\* pathPtr\) \{)/$1\n\tstatic int __dcpe=0; OSReport("MK:DCPE\\n");/;
                s/(for \(i = dirLookAt \+ 1; i < nextDir\(dirLookAt\); i = entryIsDir\(i\) \? nextDir\(i\) : \(i \+ 1\)\) \{)/$1\n\t\t\tif(++__dcpe<24)OSReport("SPIN dla=%d i=%d ndla=%d ndi=%d edi=%d\\n", dirLookAt, i, nextDir(dirLookAt), nextDir(i), entryIsDir(i));/;' "$BUILD/src/dolphin/dvd/dvdfs.c" 2>/dev/null || true
fi
#     GXInit.c: redirect the GX register-block bases from the uncached MMIO window
#     (OSPhysicalToUncached(0xC00xxxx) = 0xCC00xxxx, past the wasm memory ceiling -> the
#     GXSetCPUFifo out-of-bounds trap) to an in-range host scratch buffer. The FIFO seam
#     (gx_wgpipe -> recomp_render_fifo -> Dolphin OpcodeDecoder) does the real rendering, so
#     these register writes only need a valid target. Prototype prepended; see
#     gamecube/recomp/shims/src/gc_mmio_scratch.c. Behavior-preserving for frame emission.
perl -0pi -e 's/\A/extern void *__recomp_reg_base(unsigned);\n/; s/(__\w+Reg\s*=\s*)OSPhysicalToUncached(\(0xC00[0-9A-Fa-f]+\))/${1}__recomp_reg_base$2/g' "$BUILD/src/dolphin/gx/GXInit.c" 2>/dev/null || true

# 3d. AUDIO / ARAM-DSP NEUTRALIZATION. The compiled-in SDK ARAM driver (ar.c) dereferences
#     __DSPRegs, a hardcoded pointer macro `((vu16*)0xCC005000)` (hw_regs.h:226, the
#     non-__MWERKS__ branch active under emcc — the AT_ADDRESS array form is __MWERKS__-only).
#     0xCC005000 (3.42GB) is above every reachable wasm memory bound, so the FIRST deref
#     (ar.c:124 `refresh = __DSPRegs[13]`) faults out-of-bounds 4 retraces into the render
#     loop — the current PUMP-mode blocker. Mapping the memory would instead convert the
#     fault into an infinite spin (ar.c:244 `while(!(__DSPRegs[11]&1))`, ar.c:188
#     `while(__DSPRegs[5]&0x0200)`) that can never exit without a real DSP. So NEUTRALIZE the
#     blocking/faulting constructs at the SOURCE while PRESERVING the data outputs (ARInfo
#     size statics), so HuARInit still completes with a sane ARAM table. No __DSPRegs address
#     is ever dereferenced. Behavior-preserving for the Nintendo-logo frame (audio = 0 pixels;
#     the MusyX engine src/msm/ is already a host-import no-op, not compiled in).
ARC="$BUILD/src/dolphin/ar/ar.c"
#   (1) Replace the whole __ARChecksize body: kills the ar.c:244 __DSPRegs[11] spin, the
#       246-338 ARAM-size DMA probe, __DSPRegs[9] writes, and the OSPhysicalToUncached store.
#       Set the size statics to the 16MB base ar.c:248 already assumes so ARGetSize()>0x808000.
perl -0777 -pi -e 's/void __ARChecksize\(void\)\s*\{.*?__AR_Size = ARAM_size;\s*\n\}/void __ARChecksize(void){__AR_InternalSize=0x1000000;__AR_ExpansionSize=0;__AR_Size=0x1000000;}/s' "$ARC" 2>/dev/null || true
#   (2) Delete the ar.c:124-126 __DSPRegs[13] refresh RMW — the ACTUAL current fault site
#       (0xCC00501A), reached before __ARChecksize.
perl -0777 -pi -e 's/\s*refresh = \(u16\)\(__DSPRegs\[13\] & 0x000000ff\);\s*\n\s*__DSPRegs\[13\] = \(u16\)\(\(__DSPRegs\[13\] & ~0x000000ff\) \| \(refresh & 0x000000ff\)\);/\n    (void)refresh;/s' "$ARC" 2>/dev/null || true
#   (3) Empty the __ARWaitForDMA body (ar.c:188 __DSPRegs[5] DMA-done spin) — defense-in-depth
#       so any residual ARStartDMA/__ARWriteDMA/__ARReadDMA can't spin (unreachable after (1)).
perl -0777 -pi -e 's/static void __ARWaitForDMA\(void\)\s*\{\s*\n\s*\n\s*while \(__DSPRegs\[5\] & 0x0200\) \{ \}\s*\n\}/static void __ARWaitForDMA(void){}/s' "$ARC" 2>/dev/null || true
#   (4) EMULATED ARAM DMA (supersedes the old "HuARDMACheck -> return 0" neutralization). ARStartDMA
#       programs the out-of-bounds __DSPRegs MMIO (0xCC005000) -> the frame-41 OOB now that BootExec's
#       HuAR_DVDtoARAM (DVD->ARAM staging) path is reached. ARAM is a real data store (staged, then
#       ARAM->MRAM'd back), so the transfer must MOVE bytes. Route ARStartDMA to a memcpy over a 16MB
#       emulated-ARAM buffer (shims/src/gc_aram.c). Args arrive already ordered (arg1=main-mem,
#       arg2=ARAM) by __ARQPopTaskQueueHi/__ARQServiceQueueLo.
perl -0777 -pi -e 's/void ARStartDMA\(u32 type, u32 mainmem_addr, u32 aram_addr, u32 length\)\s*\{.*?\n\}/void ARStartDMA(u32 type, u32 mainmem_addr, u32 aram_addr, u32 length){extern void __recomp_ar_dma(unsigned,unsigned,unsigned,unsigned); __recomp_ar_dma(type, mainmem_addr, aram_addr, length);}/s' "$ARC" 2>/dev/null || true
#       Make every ARQ request a SINGLE chunk (default 4096-byte chunking needs a per-chunk interrupt
#       to advance; we have none) so one memcpy completes the whole transfer and __ARQCallbackLo is set.
perl -0777 -pi -e 's/__ARQChunkSize = ARQ_CHUNK_SIZE_DEFAULT;/__ARQChunkSize = 0x2000000;/' "$BUILD/src/dolphin/ar/arq.c" 2>/dev/null || true
#       Drive the ARQ completion synchronously: real HW fires __ARQInterruptServiceRoutine (callback +
#       clear-pending + service-next) on the DMA-done interrupt, which never fires under wasm. So pump
#       it from HuARDMACheck (called in the game's `while(HuARDMACheck())` drain loops). Bounded guard +
#       always-return-0 so the drain loop terminates even if arqCnt were ever left unbalanced.
perl -0777 -pi -e 's/s32 HuARDMACheck\(void\) \{\s*\n\s*return arqCnt;\s*\n\}/s32 HuARDMACheck(void) {\n    extern void __ARQInterruptServiceRoutine(void);\n    int guard = 256;\n    while (arqCnt > 0 \&\& guard-- > 0) __ARQInterruptServiceRoutine();\n    return 0;\n}/s' "$BUILD/src/game/armem.c" 2>/dev/null || true

# 3e. VI / SI register-MMIO redirect. hw_regs.h defines the register-block pointer macros
#     `__VIRegs = (vu16*)0xCC002000`, `__SIRegs = (vu32*)0xCC006400` (the non-__MWERKS__ #else
#     branch, active under emcc). Those physical addresses are past the wasm memory ceiling,
#     so any deref faults out-of-bounds — the CURRENT blocker is SISamplingRate.c:51 reading
#     `__VIRegs[54]` (= 0xCC00206C) on the HuPadInit->SISetSamplingRate path, verified via the
#     faulting-const disassembly (wasm-function[879] <main> @0x646b2 loads 0xCC00206C). Redirect
#     __VIRegs and __SIRegs to the same in-range host scratch the GX register bases already use
#     (gc_mmio_scratch __recomp_reg_base, keyed by paddr&0xFFFF -> distinct pages 0x2000/0x6400).
#     Reads return last-written (0 at boot); the two `while(__SIRegs[13]&1)` spins (SIBios.c:311,
#     374) are wait-for-CLEAR, so 0-scratch exits them immediately. We deliberately do NOT
#     redirect __DSPRegs/__AIRegs: OSAudioSystem.c has wait-for-SET spins (`while(!(r3&0x20))`,
#     etc.) that 0-scratch would HANG — and that audio path is off the logo-frame boot (only
#     reached from __OSInitAudioSystem in the host-no-op OSInit). The ar.c __DSPRegs faults are
#     already neutralized at the source in 3d above.
perl -0777 -pi -e 's/\#define __VIRegs \(\(vu16\*\)0xCC002000\)/#define __VIRegs ((vu16*)__recomp_reg_base(0xCC002000))/; s/\#define __SIRegs \(\(vu32\*\)0xCC006400\)/#define __SIRegs ((vu32*)__recomp_reg_base(0xCC006400))/; s/\A/extern void *__recomp_reg_base(unsigned);\n/' "$BUILD/include/dolphin/hw_regs.h" 2>/dev/null || true

# 3f. FIBER (stackful-coroutine) scheduler hooks. src/game/jmp.c's gcsetjmp/gclongjmp are
#     mwcc PPC `asm{}` bodies that DO NOT compile under clang -> they were left as no-op
#     host imports, so gclongjmp never transferred control and the Hu cooperative scheduler
#     (process.c) spun forever emitting 0 draws. The portable replacement lives in
#     gamecube/recomp/shims/src/gc_fiber_coro.c (real gcsetjmp/gclongjmp over
#     emscripten_fiber_*). Two source transforms make process.c drive it:
PROC="$BUILD/src/game/process.c"
#   (A) Fabricate hook — HuPrcCreate writes jump.lr=func / jump.sp=base_sp as RAW fields
#       (process.c:81-83), which a gcsetjmp/gclongjmp shim cannot observe. Replace the
#       gcsetjmp + two raw stores with a single fiber-init that carries func + stack_size
#       (both in scope in HuPrcCreate). base_sp is a guest-PPC sp, meaningless for the wasm
#       shadow stack, so it is dropped (the fiber owns its own c-stack).
perl -0777 -pi -e 's/\bgcsetjmp\(&process->jump\);\s*\n\s*process->jump\.lr\s*=\s*\(u32\)func;\s*\n\s*process->jump\.sp\s*=\s*process->base_sp;/__gc_fiber_fabricate(&process->jump, func, stack_size);/s' "$PROC" 2>/dev/null || true
#   (B) Scheduler status routing — the PPC dispatch is `ret = gcsetjmp(&processjmpbuf)`;
#       its nonzero "resume" arrives via the process's gclongjmp(&processjmpbuf,status).
#       Under fibers, THAT status is the return value of the scheduler's own
#       gclongjmp(&process->jump,1) swap. Capture it into `ret` so switch(ret) frees/advances
#       exactly as native (process.c:280). Without this, switch(ret) reads a stale ret.
perl -0777 -pi -e 's/\bgclongjmp\(&process->jump,\s*1\);/ret = gclongjmp(&process->jump, 1);/s' "$PROC" 2>/dev/null || true
#   (C) File-scope prototype for the fabricate hook (idempotent).
perl -0777 -pi -e 's/\A(?!extern void __gc_fiber_fabricate)/extern void __gc_fiber_fabricate(void*, void(*)(void), unsigned);\n/' "$PROC" 2>/dev/null || true
#   (D) HuPrcKill retargeting — the scheduler kills a process by RAW-rewriting its saved
#       resume PC to HuPrcEnd (process.c:277 `process->jump.lr = (u32)HuPrcEnd;`), invisible
#       to the address-bound fiber model: the killed process resumed its BODY instead and
#       ticked once per HuPrcCall forever (the zombie HuWinProc that double-processed every
#       window/choice after the modesel overlay switch). Rebind the buffer to a fresh fiber
#       entering HuPrcEnd (gc_fiber_coro.c __gc_fiber_retarget; frees the dead body fiber).
perl -0777 -pi -e 's/process->jump\.lr = \(u32\)HuPrcEnd;/{ extern void __gc_fiber_retarget(void*, void(*)(void)); __gc_fiber_retarget(&process->jump, HuPrcEnd); }/s' "$PROC" 2>/dev/null || true

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
        -DVERSION=0 -fdeclspec ${RECOMP_HSFDIAG:+-DRECOMP_HSFDIAG}
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
# [AOT-overlay, REL_ENDIANNESS_PLAN.md step 1] Compile the bootDll boot-logo overlay INTO the
# DOL module (only its 3 units: executor.c shared prolog + bootDll/main.c + language.c). All 78
# of bootDll's DOL calls bind by plain symbol name to functions already in the wasm, so this
# sidesteps runtime OSLink + the disc read + the big-endian relocation/prolog-ptr spin. The
# other ~92 RELs stay skipped (they share auto-named fn_* symbols that collide when flat-linked).
if [ -z "${RECOMP_NO_BOOTDLL:-}" ]; then
  compile_one "$BUILD/src/REL/executor.c"
  compile_one "$BUILD/src/REL/bootDll/main.c"
  compile_one "$BUILD/src/REL/bootDll/language.c"
fi
# [AOT-overlay, generalized] Compile the mode-select overlay INTO the module with its entry symbols
# NAMESPACED (only ObjectSetup + lbl_1_bss_4 collide with the DOL/bootDll — measured via llvm-nm).
# modesel_prolog (gc_ovl_dispatch.c) calls modesel_ObjectSetup. Toward gameplay: title->OVL_MODESEL.
if [ -n "${RECOMP_MODESEL:-}" ]; then
  MSNS="-DObjectSetup=modesel_ObjectSetup -D__OSBusClock=__ms_busclk -D__OSCoreClock=__ms_coreclk"
  for u in modesel main datalist filesel; do
    # (a) modesel implicit-declares esp*/HuTHP*/msm*/BoardStatusKill/Hu3D*2Dto3D (missing #includes)
    #     -> wrong signatures -> 14 sig-mismatches that regress the title. Add the declaring headers.
    perl -0pi -e 's{\A}{#include "game/esprite.h"\n#include "game/thpmain.h"\n#include "msm/msmsys.h"\n#include "game/board/ui.h"\n#include "game/hsfex.h"\n}' "$BUILD/src/REL/modeseldll/$u.c" 2>/dev/null || true
    # (b) the decomp's auto-named module-1 symbols (fn_1_*/lbl_1_*) collide with bootDll (also a
    #     "module 1" REL). Namespace ALL of modesel's to fn_ms1_*/lbl_ms1_* (these are REL-internal;
    #     DOL calls use real names like Hu*/om*/esp*, so this only renames modesel's own symbols).
    perl -0pi -e 's/\bfn_1_/fn_ms1_/g; s/\blbl_1_/lbl_ms1_/g' "$BUILD/src/REL/modeseldll/$u.c" 2>/dev/null || true
  done
  # (b2) the shared extern decls live in include/REL/modeseldll.h (included ONLY by these 4
  #      units — verified) and must be namespaced with them, or the renamed uses go undeclared.
  perl -0pi -e 's/\bfn_1_/fn_ms1_/g; s/\blbl_1_/lbl_ms1_/g' "$BUILD/include/REL/modeseldll.h" 2>/dev/null || true
  # (b3) fn_1_1EC0's prototype is commented out in the header, so modesel.c/filesel.c
  #      implicit-declare it int(int) vs the real void(s16) def (main.c) -> sig mismatch.
  #      Un-comment it (real-type prototype from the definition, the sig_fixes pattern).
  perl -0pi -e 's{^// (void fn_ms1_1EC0\(s16 view\);)}{$1}m' "$BUILD/include/REL/modeseldll.h" 2>/dev/null || true
  for u in modesel main datalist filesel; do
    o="$BUILD/obj/$(printf '%s' "src/REL/modeseldll/$u.c" | tr '/' '_' | tr -c 'A-Za-z0-9_.-' '_').o"
    if emcc "${CFLAGS[@]}" $MSNS "$BUILD/src/REL/modeseldll/$u.c" -o "$o" 2>/tmp/ce_ms.txt; then ok=$((ok+1));
    else fail=$((fail+1)); echo "  modeseldll/$u.c: $(grep -m1 'error:' /tmp/ce_ms.txt | sed 's|.*error: ||')"; fi
  done
  echo "[recomp] modesel overlay AOT-compiled (namespaced)"
fi
# [AOT-overlay] Compile OVL_MENT (mentDll: common.c + main.c) INTO the module, namespaced
# fn_1_->fn_mt1_ / lbl_1_->lbl_mt1_ (module-1 auto names collide with bootDll AND modesel's
# pre-rename names; the shared extern decls live in include/REL/mentDll.h — namespaced with
# them, the modeseldll.h lesson). mentDll ships its OWN _prolog/_epilog (common.c) walking
# _ctors/_dtors link-time arrays that do not exist under emcc — neutralize them; entry is
# gc_ovl_dispatch.c ment_prolog -> fn_mt1_144 (the real init behind the empty ctor walk).
if [ -n "${RECOMP_MENT:-}" ]; then
  MTNS="-D__OSBusClock=__mt_busclk -D__OSCoreClock=__mt_coreclk"
  # main.c implicit-declares the HuAud* family + Hu3D3Dto2D (missing #includes) -> 11
  # int-return sig mismatches against the real void definitions. Add the declaring headers.
  perl -0pi -e 's{\A}{#include "game/audio.h"\n#include "game/hsfex.h"\n}' "$BUILD/src/REL/mentDll/main.c" 2>/dev/null || true
  for u in common main; do
    perl -0pi -e 's/\bfn_1_/fn_mt1_/g; s/\blbl_1_/lbl_mt1_/g' "$BUILD/src/REL/mentDll/$u.c" 2>/dev/null || true
  done
  perl -0pi -e 's/\bfn_1_/fn_mt1_/g; s/\blbl_1_/lbl_mt1_/g' "$BUILD/include/REL/mentDll.h" 2>/dev/null || true
  perl -0pi -e 's/\bs32 _prolog\(void\)\s*\{.*?\n\}/static s32 ment_prolog_unused(void){return 0;}/s; s/\bvoid _epilog\(void\)\s*\{.*?\n\}/static void ment_epilog_unused(void){}/s' "$BUILD/src/REL/mentDll/common.c" 2>/dev/null || true
  for u in common main; do
    o="$BUILD/obj/$(printf '%s' "src/REL/mentDll/$u.c" | tr '/' '_' | tr -c 'A-Za-z0-9_.-' '_').o"
    if emcc "${CFLAGS[@]}" $MTNS "$BUILD/src/REL/mentDll/$u.c" -o "$o" 2>/tmp/ce_mt.txt; then ok=$((ok+1));
    else fail=$((fail+1)); echo "  mentDll/$u.c: $(grep -m1 'error:' /tmp/ce_mt.txt | sed 's|.*error: ||')"; fi
  done
  echo "[recomp] ment overlay AOT-compiled (namespaced)"
fi
# [AOT-overlay] Compile OVL_W01 (w01Dll: main.c + mg_coin.c + mg_item.c) INTO the module,
# namespaced fn_1_->fn_w1_ / lbl_1_->lbl_w1_ (units + include/REL/w01Dll.h). Entry is
# gc_ovl_dispatch.c w01_prolog -> BoardObjectSetup(BoardCreate, BoardDestroy) — the whole
# board engine (src/game/board/*) is already compiled into the DOL; the overlay only carries
# the board-specific create/destroy + its two minigames.
if [ -n "${RECOMP_W01:-}" ]; then
  W1NS="-D__OSBusClock=__w1_busclk -D__OSCoreClock=__w1_coreclk"
  # main.c declares CoasterHostComKeySet extern at :160 but defines it static at :2645 (mwcc
  # tolerated; clang errors) — align the early declaration with the file-local definition.
  perl -0pi -e 's/^extern (void CoasterHostComKeySet\(s32 playerNo\);)/static $1/m' "$BUILD/src/REL/w01Dll/main.c" 2>/dev/null || true
  # main.c implicit-declares Hu3DMtxRotGet/Hu3DMtxTransGet (hsfex.h) + BoardPlayerMoveBetween /
  # BoardCameraPosCalcFuncSet (no header declares them) -> 4 int-return sig mismatches. Prepend
  # the header + real-type prototypes (from the definitions; func-ptr param as void(*)(void*),
  # ABI-identical on wasm32 and typedef-independent since this lands before the includes).
  perl -0pi -e 's{\A}{#include "game/hsfex.h"\nextern void BoardPlayerMoveBetween(s32, s32, s32);\nextern void BoardCameraPosCalcFuncSet(void (*)(void *));\n}' "$BUILD/src/REL/w01Dll/main.c" 2>/dev/null || true
  for u in main mg_coin mg_item; do
    perl -0pi -e 's/\bfn_1_/fn_w1_/g; s/\blbl_1_/lbl_w1_/g' "$BUILD/src/REL/w01Dll/$u.c" 2>/dev/null || true
  done
  perl -0pi -e 's/\bfn_1_/fn_w1_/g; s/\blbl_1_/lbl_w1_/g' "$BUILD/include/REL/w01Dll.h" 2>/dev/null || true
  for u in main mg_coin mg_item; do
    o="$BUILD/obj/$(printf '%s' "src/REL/w01Dll/$u.c" | tr '/' '_' | tr -c 'A-Za-z0-9_.-' '_').o"
    if emcc "${CFLAGS[@]}" $W1NS "$BUILD/src/REL/w01Dll/$u.c" -o "$o" 2>/tmp/ce_w1.txt; then ok=$((ok+1));
    else fail=$((fail+1)); echo "  w01Dll/$u.c: $(grep -m1 'error:' /tmp/ce_w1.txt | sed 's|.*error: ||')"; fi
  done
  echo "[recomp] w01 overlay AOT-compiled (namespaced)"
fi
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
#    FIBER SWITCH: drop -sSTANDALONE_WASM (emscripten_fiber_swap is JS-runtime Asyncify code,
#    incompatible with a raw-instantiate standalone module — see gc_fiber_coro.c). Emit an ES6
#    module factory (.js glue) + the wasm alongside; recomp_run.mjs loads via the factory and
#    supplies the 126 host-import stubs through instantiateWasm. -sASYNCIFY=1 enables the
#    Binaryen asyncify pass + the fiber runtime. main is in DEFAULT_ASYNCIFY_EXPORTS so it is
#    Promise-wrapped. EXPORTED_FUNCTIONS drives the glue export table (leading underscore).
if emcc "$BUILD"/obj/*.o -o "$BUILD/mp4_game.js" \
     -sERROR_ON_UNDEFINED_SYMBOLS=0 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2176mb -sINITIAL_MEMORY=33554432 \
     -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=32768 ${RECOMP_PROFILING_FUNCS:+--profiling-funcs} \
     -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node,web,worker -sINVOKE_RUN=0 \
     -sEXPORTED_FUNCTIONS=_main,_gx_fifo_base,_gx_fifo_pos,_gx_fifo_reset,_OSSetArenaLo,_OSSetArenaHi,_emscripten_resize_heap,___gc_fiber_stat_fabricate,___gc_fiber_stat_enter,___gc_fiber_stat_swap,___DVDFSInit,___recomp_get_animtree,___recomp_get_bg_animtree,___recomp_get_anim_at,___recomp_get_anim_count,___recomp_set_inject_btn,___recomp_set_inject_dstk,___recomp_set_inject_stkx,___recomp_set_inject_stky,_HuMemHeapPtrGet,___recomp_dirty_base,___recomp_dirty_count,___recomp_dirty_overflow,___recomp_dirty_reset,___recomp_autoboard_arm,___recomp_aram_base,___recomp_static_top \
     -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8,HEAP32,HEAPU32,wasmMemory,wasmExports \
     -Wl,--no-entry -Wl,--no-gc-sections -Wl,--allow-undefined -Wl,--allow-multiple-definition -O2 2>"$BUILD/link.txt"; then
  echo "[recomp] LINKED: $BUILD/mp4_game.js + $BUILD/mp4_game.wasm ($(stat -f%z "$BUILD/mp4_game.wasm" 2>/dev/null) bytes)"
  echo "[recomp] file: $(file "$BUILD/mp4_game.wasm" 2>/dev/null | sed 's|.*: ||')"
  echo "[recomp] asyncify present: $(grep -c -a 'asyncify' "$BUILD/mp4_game.wasm" 2>/dev/null) | fiber_swap import: $(wasm-objdump -j Import -x "$BUILD/mp4_game.wasm" 2>/dev/null | grep -c emscripten_fiber_swap)"
  echo "[recomp] wasm signature mismatches: $(grep -c 'signature mismatch' "$BUILD/link.txt")"
else
  echo "[recomp] link errors (top):"; grep -m8 -iE "error|duplicate|undefined" "$BUILD/link.txt" | sed -E "s/'[^']*'/X/g" | sort -u | head -8
fi

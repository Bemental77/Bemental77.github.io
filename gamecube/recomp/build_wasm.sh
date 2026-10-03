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
# CANONICAL FULL-BOOT BUILD (what gamecube/recomp/mp4_game.{js,wasm} is built from):
#
#   RECOMP_MUSYX=1 RECOMP_PROFILING_FUNCS=1 bash gamecube/recomp/build_wasm.sh
#
# Every overlay the decomp has source for (93 of the 99 USA entries in ovl_table.h; the other six,
# m300/m302/m303/m330/m333 and msetupdll, have no source and no omOvlCall in src/ names them —
# msetupdll appears only in audio.c's sound-group table) is AOT-compiled in by ovl_build.py — RECOMP_OVERLAYS=all is the
# default. The old RECOMP_MODESEL/RECOMP_MENT/RECOMP_W01 switches are gone (the four-overlay
# build is why a party stopped at its first minigame). Use a FRESH BUILD dir or this box's
# rsync-less staging (see step 1). DECOMP falls back to ~/mp4decomp (src/ include/ +
# extern/musyx submodule); the generated .inc assets come from the disc (gen_inc_assets.py).
# Coverage rig: gamecube/recomp/ovl_test.mjs (every board and minigame, DET=1 for lockstep).
# (RECOMP_*DIAG vars are temporary diagnostics, keep OFF.)
#
# RECOMP_MUSYX=1 IS NOW PART OF THAT LINE — THE AUDIO BUILD SHIPS (2026-09-02).
#   gamecube/recomp/mp4_game.{js,wasm} md5 00f457ce…/fd341d95… replaced the silent
#   8ec823be…/bed9aeac… pair. MP4 already routes to the recomp by default (gamecube.html:1038),
#   so this IS what a visitor gets. Gate results, every run hash-guarded before AND after, box
#   load 2.5-5.4 throughout, all runs serialized through tools/probe_lock.sh:
#     * NO TRAP on the scripted journey (Start x2 then A x8 into file-select and past it):
#       3 of 3 candidate runs and 2 of 2 shipped-binary control runs logged 0 traps. The
#       screenshot at t=105s is MP4's PARTY MODE character-select screen — two screens beyond
#       where the old build died.
#     * AUDIBLE, driven past the title: audible YES, 2,265,587 audible frames, 70.7 s audible,
#       peak 0.9008, on AudioContext id 1 (NOT contexts[0] — the page builds a vestigial one).
#       The matched shipped-binary arm on the SAME journey read audible NO, "rendered frames
#       were all exactly zero", 0 of 3,076,096 frames. tools/audio_tap_selftest.mjs 12/12.
#     * GUEST RATE 0.999x, 60 shown / 60 published, drawn 180/s, held to t=111s.
#     * ?ratetest=1 132 pass / 0 fail; ?captest=1 201 pass / 0 fail.
#   ⚠ THE COST IS HEADROOM, NOT SPEED. Guest rate is unchanged (0.999x audio vs 0.999-1.000x
#     silent), but producible capacity drops from ~433-495 fps (7.2-8.2x hw) on the silent
#     control to ~104-111 fps (1.7-1.8x hw) with the software mixer in — the page stops
#     reporting "120 REACHED". That is a real regression in headroom and the next thing to
#     attack; it is not a speed regression (CLAUDE.md gate #9: the two are separate knobs).
#   ⚠ STILL OPEN, not a ship blocker: 69 discontinuities / maxStep 0.854 over the 70 s audible
#     window (a title-only pass had read 0) — audible clicks, cause unknown. And the TITLE is
#     quiet (peak 0.0758) while the menu flow is not (0.9008); OSGetSoundMode() returns 0
#     because EXILock is a `return 0` host import so OSRtc.c:107 ReadSram never fills SRAM,
#     which selects MONO at msmsys.c:909 where audio.c:60 would pick SURROUND. Do NOT paper
#     over either with a gain node.
#
# WHAT THE TRAP ACTUALLY WAS (three defects in shims/src/gc_musyx_song_bswap.c, all the same
# class: the ARR sequence format was modelled by assumption instead of derived from the data):
#   1. the ARR header was assumed to be a fixed 0x58 bytes; MP4's mode-select song puts its
#      track table at 0x18, so the header swap covered 16 track entries and step 2 swapped
#      them BACK to big-endian;
#   2. swap_track treated a 0xFFFE loop entry as "keep scanning", but seq.c:975-982 JUMPS on
#      it — so the walk ran out of every track into its neighbour and returned maxPattern
#      0xfeff instead of 0x1b, which made step 4 size the pattern table at 65,536 entries and
#      write all over the song (including the track table);
#   3. `seen[]` keyed song identity on the ARR base pointer, but msmmus.c:438 gives each music
#      player ONE reused buffer.
#   Read that file's comments for the measured evidence. The stack that named it came from
#   RECOMP_PROFILING_FUNCS=1 plus recomp_worker.js logging e.stack — before that the only line
#   available was `main stopped: memory access out of bounds`, which names nothing.
#
# A TITLE-ONLY AUDIO PASS CANNOT CLEAR AN AUDIO BUILD. It read entirely green while the build
# trapped one screen later. Re-gate with BOTH tools/audio_probe.mjs (now supports AUDIO_PRESS,
# use it) AND dolphin_render_probe.js with PROBE_PRESS + PROBE_SCENE_RATE=5000 — the latter is
# opt-in and is the only guest-rate witness on the recomp path.
set -u
DECOMP="${DECOMP:-$HOME/gc_refs/marioparty4}"
# A box without the full decomp build uses the src/+include/ checkout at ~/mp4decomp (with the
# extern/musyx submodule initialised for RECOMP_MUSYX). Its generated asset headers are made from
# the disc by gen_inc_assets.py below.
if [ ! -d "$DECOMP/src" ] && [ -d "$HOME/mp4decomp/src" ]; then DECOMP="$HOME/mp4decomp"; fi
RECOMP="$(cd "$(dirname "$0")" && pwd)"
BUILD="${BUILD:-/tmp/gc_recomp_build}"
source "$HOME/emsdk-upstream/emsdk_env.sh" >/dev/null 2>&1

echo "[recomp] decomp=$DECOMP  build=$BUILD"
mkdir -p "$BUILD"
# 1. stage a writable copy of decomp source + headers
# Without rsync the fallback must REPLACE the staged trees: `cp -R src $BUILD/src` into an existing
# $BUILD/src nests a pristine copy at $BUILD/src/src and leaves the previous run's EDITED files in
# place, so every perl edit below is applied a second time (MEASURED 2026-10-03 on a box with no
# rsync: objdll.c carried the overlay hook twice, board/player.c two __recomp_roll_r3 bodies).
rsync -a --delete "$DECOMP/src" "$DECOMP/include" "$BUILD/" 2>/dev/null || {
  rm -rf "$BUILD/src" "$BUILD/include"; cp -R "$DECOMP/src" "$BUILD/src"; cp -R "$DECOMP/include" "$BUILD/include"; }
# Authoritative include dirs from the decomp's OWN build (build.ninja): the REAL MusyX
# headers (SND_GROUPID/SND_SONGID/... — not absent, vendored here) and the GENERATED
# header dir carrying every .inc binary asset (coveropen_en.inc, refMapData0.inc, …)
# plus macros.inc. Mirroring the decomp's real build config is the authoritative fix
# (vs my ad-hoc -I flags + wrong musyx stub). extern/musyx/include has a musyx/ subdir.
mkdir -p "$BUILD/extern/musyx"
rsync -a --delete "$DECOMP/extern/musyx/include" "$BUILD/extern/musyx/" 2>/dev/null || { rm -rf "$BUILD/extern/musyx/include"; cp -R "$DECOMP/extern/musyx/include" "$BUILD/extern/musyx/include"; }
if [ -d "$DECOMP/build/GMPE01_01/include" ]; then
  rsync -a --delete "$DECOMP/build/GMPE01_01/include/" "$BUILD/gen/" 2>/dev/null || { mkdir -p "$BUILD/gen"; cp -R "$DECOMP/build/GMPE01_01/include/." "$BUILD/gen/"; }
else
  # No decomp build products: slice the 20 asset .inc headers out of the disc (gen_inc_assets.py).
  mkdir -p "$BUILD/gen"
  python3 "$RECOMP/gen_inc_assets.py" "$BUILD/gen" || { echo "[recomp] FATAL: gen_inc_assets.py failed" >&2; exit 1; }
fi
# [audio, RECOMP_MUSYX=1 — OPT-IN, OFF by default] Stage the MusyX SOURCE too, not just its
# headers. MP4's whole audio engine is `extern/musyx` (33 library .c files per its own
# CMakeLists) + the 6 `src/msm/*.c` wrappers; with neither compiled, all 36 msm* entry points
# are host imports answered by recomp_worker.js's `default: return 0` and the game ships SILENT.
#
# THIS FLAG ONLY ANSWERS "DOES IT COMPILE" — it is NOT a working audio path. Compiling MusyX
# in gets you the sequencer + voice manager + DSP-COMMAND-LIST BUILDER, and nothing that
# produces a PCM sample: on real hardware every sample is mixed by the DSP running the
# `dspSlave` microcode (extern/musyx/src/musyx/runtime/dsp_import.c:4, 0x19E0 bytes of GC-DSP
# machine code, gated `#if MUSY_TARGET == MUSY_TARGET_DOLPHIN`). The MUSY_TARGET_PC backend is
# NOT a software renderer — hw_pc.c:89 `salAiGetDest()` returns NULL, :82 `salStartAi()` has no
# body and :99 `salStartDsp()` is empty (byte-identical to ~/gc_refs/ttyd/libs/musyx's copy, so
# this is the library's stub target, not an MP4 quirk). A software AX-style mixer over the _PB
# voice blocks + a big-endian->little-endian swapper for /sound/mpgcsnd.msm (its first 16 bytes
# read 00 00 00 38 00 10 7a c0 00 00 04 10 = big-endian u32s, and MusyX parses them with native
# loads) are BOTH still missing. Do not enable this on a shipped build.
if [ -n "${RECOMP_MUSYX:-}" ]; then
  rsync -a --delete "$DECOMP/extern/musyx/src" "$BUILD/extern/musyx/" 2>/dev/null || { rm -rf "$BUILD/extern/musyx/src"; cp -R "$DECOMP/extern/musyx/src" "$BUILD/extern/musyx/src"; }
fi
# 2. overlay portable shims (portable OSFastCast replaces the inline-asm header, etc.)
cp -R "$RECOMP/shims/." "$BUILD/include/" 2>/dev/null || true
# DECOMP GENERATIONS. This script was written against the decomp as it stood in Aug 2026 (gen 1:
# OVL_<NAME> overlay enum, AnimData/HsfHeader/HsfObjectData types, snake_case locals such as
# read_stat/dir_data). The decomp since renamed most of that (gen 2, e.g. mariopartyrd/marioparty4
# 147b165 of 2026-06-04: DLL_<name>, ANIMDATA/HSFHEADER/HSFMESH, readStat/dirBuf). The game it
# compiles is the same byte-matching game; only spellings moved. Every source edit below that
# depends on a spelling now carries both, and the shims select theirs with RECOMP_DECOMP_GEN.
# MEASURED before this: on a gen-2 tree 12 of 60 edits silently matched nothing (the data.c,
# armem.c, LoadHSF, sprite and esprite endianness hooks among them) and three shims failed to
# compile — a build that "succeeds" and cannot load a single model.
if grep -q 'ANIMDATA' "$BUILD/include/game/animdata.h" 2>/dev/null; then DECOMP_GEN=2; else DECOMP_GEN=1; fi
echo "[recomp] decomp generation $DECOMP_GEN"
# [audio, RECOMP_MUSYX=1] The source fixes MusyX + the msm layer need under emcc -std=gnu89.
# Verified 2026-09-01: with these + the existing shims/dolphin/os/OSFastCast.h overlay, ALL 33
# library TUs from extern/musyx/CMakeLists.txt AND all 6 src/msm/*.c wrappers compile
# clean (39 built / 0 failed, and the link's `signature mismatch` count stays at the
# default build's 0). profile.c is skipped by name and txwin.c by directory: neither is in
# MusyX's own CMakeLists, and both fail (missing musyx_priv.h / dolphin/types.h).
if [ -n "${RECOMP_MUSYX:-}" ]; then
  #  (a) assert.h:24 uses C23's one-argument va_start(list); gnu89 requires the 2-arg form.
  perl -0pi -e 's/va_start\(list\);/va_start(list, msg);/' "$BUILD/extern/musyx/include/musyx/assert.h" 2>/dev/null || true
  #  (b) musyx.h's MUSY_TARGET_PC branch typedefs s32/u32 as int/unsigned int, which collides
  #      with the decomp's dolphin/types.h (signed long / unsigned long) in every TU that
  #      includes both — hw_dspctrl.c does, via dolphin/os/OSCache.h. `long` is 32-bit on
  #      wasm32 so aligning the PC branch to the decomp's spelling is ABI-identical.
  perl -0pi -e 's/typedef signed int s32;\ntypedef unsigned int u32;/typedef signed long s32;\ntypedef unsigned long u32;/' "$BUILD/extern/musyx/include/musyx/musyx.h" 2>/dev/null || true
  #      [musyx adc8df9, 2026-05] the newer submodule spells that branch `#include <stdint.h>` +
  #      int8_t..uint64_t typedefs, and <stdint.h> resolves to the decomp's own include/stdint.h,
  #      which defines only uintptr_t -> every MusyX TU fails (`unknown type name 'int8_t'`,
  #      MEASURED 2026-10-03: 6 of 39 audio objects built). Same fix, spelled for that layout:
  #      the decomp's dolphin/types.h types (s32/u32 = long, s64 = long long).
  perl -0pi -e 's/#include <stdint.h>\ntypedef int8_t s8;\ntypedef int16_t s16;\ntypedef int32_t s32;\ntypedef int64_t s64;\ntypedef uint8_t u8;\ntypedef uint16_t u16;\ntypedef uint32_t u32;\ntypedef uint64_t u64;/typedef signed char s8;\ntypedef signed short s16;\ntypedef signed long s32;\ntypedef signed long long s64;\ntypedef unsigned char u8;\ntypedef unsigned short u16;\ntypedef unsigned long u32;\ntypedef unsigned long long u64;/' "$BUILD/extern/musyx/include/musyx/musyx.h" 2>/dev/null || true
fi
# [2026-10-01] (c) RUNS IN EVERY BUILD, not only RECOMP_MUSYX: these are correct prototypes either
# way, and with every overlay compiled in, a SILENT build has callers of the same msm* host
# import with different implicit signatures (sreset.c vs selmenuDll: msmMusSetMasterVolume
# (i32)->i32 vs (i32)->void), which wasm-ld refuses for an undefined import.
  #  (c) signature reconciliation. Compiling the msm layer IN turns nine previously-harmless
  #      implicit declarations into wasm-ld `function signature mismatch` warnings (measured:
  #      0 -> 9 on the first RECOMP_MUSYX link). Same mwcc decl!=def class as sig_fixes.json:
  #      the caller implicit-declares `int f()` against a `void` definition. Add the declaring
  #      header to each outlier caller.
  perl -0pi -e 's{\A(?!\#include "msm/msmmus.h")}{#include "msm/msmmus.h"\n}' "$BUILD/src/game/main.c" 2>/dev/null || true
  perl -0pi -e 's{\A(?!\#include "msm/msmsys.h")}{#include "msm/msmsys.h"\n}' "$BUILD/src/game/pad.c" 2>/dev/null || true
  perl -0pi -e 's{\A(?!\#include "msm/msmmus.h")}{#include "msm/msmmus.h"\n#include "msm/msmsys.h"\n#include "msm/msmse.h"\n#include "msm/msmstream.h"\n}' "$BUILD/src/game/sreset.c" 2>/dev/null || true
  #      msmSysLoadGroup is DEFINED with two parameters (src/msm/msmsys.c:728) and no header
  #      declares it, so all three callers implicit-declare it and pass a third argument that
  #      PPC silently ignored. Drop the extra arg and give them the real prototype.
  for f in "$BUILD/src/game/audio.c" "$BUILD/src/REL/bootDll/main.c" "$BUILD/src/REL/bootDll/language.c"; do
    perl -0pi -e 's/msmSysLoadGroup\(([^(),]*),([^(),]*),[^(),]*\)/msmSysLoadGroup($1,$2)/g;
                  s{\A(?!extern long msmSysLoadGroup)}{extern long msmSysLoadGroup(long, void *);\n}' "$f" 2>/dev/null || true
  done
  #      msmSysCheckInit is DEFINED `void` (src/msm/msmsys.c:773) with a bare `sndIsInstalled();`
  #      as its last statement — on PPC that value stays in r3 and sreset.c reads it as the
  #      condition of three `if`s. Make the C say what the PPC did (return it) so the callers
  #      compile AND behave identically; a plain void prototype makes sreset.c fail to compile.
  perl -0pi -e 's/void msmSysCheckInit\(void\)\s*\{\s*\n\s*sndIsInstalled\(\);\s*\n\}/s32 msmSysCheckInit(void)\n{\n    return sndIsInstalled();\n}/s' "$BUILD/src/msm/msmsys.c" 2>/dev/null || true
  perl -0pi -e 's/void msmSysCheckInit\(void\);/s32 msmSysCheckInit(void);/' "$BUILD/include/msm/msmsys.h" 2>/dev/null || true
if [ -n "${RECOMP_MUSYX:-}" ]; then
  #      SAME mwcc-r3 CLASS, AND IT WAS THE WHOLE REASON NOTHING EVER SOUNDED. synth_adsr.c:106
  #      declares `u32 adsrSetup(ADSR_VARS*)` and its body is `adsr->state = 0;
  #      salChangeADSRState(adsr);` with NO return. On PPC that is not a bug: salChangeADSRState
  #      leaves its result in r3, which is also the return register, so adsrSetup returns it.
  #      clang has no such accident. MEASURED in the emitted object before this fix
  #      (wasm-objdump -d obj/extern_musyx_..._synth_adsr.c.o):
  #          local.get 0 / i32.const 0 / i32.store8      ; adsr->state = 0
  #          local.get 0 / call <salChangeADSRState> / drop
  #          local.get 0 / end                           ; returns the ADSR_VARS* ARGUMENT
  #      i.e. it returns a heap pointer, which is never 0 — and hw_dspctrl.c:545 reads it as
  #          if (adsrSetup(&dsp_vptr->adsr) != 0) { salSynthSendMessage(v,0);
  #                                                 salDeactivateVoice(v); continue; }
  #      so EVERY voice was retired on the frame it started, before its _PB was ever filled.
  #      Symptom it produced: msmSePlay returns entry ids, 17 macros run, cFlags 0x20->0x10 and
  #      hwStart/salActivateVoice all fire (17 voices linked into active studio 0 immediately
  #      before salBuildCommandList) — and 0 voices, 0 playing PBs and 0 non-zero samples
  #      immediately after it. salChangeADSRState's real return is `VoiceDone`, i.e. "the
  #      envelope is degenerate, do not start this voice", which is TRUE only for a zero
  #      attack/decay/sustain envelope. Returning it is what the PPC binary did.
  perl -0pi -e 's/(u32 adsrSetup\(ADSR_VARS\* adsr\) \{\s*\n\s*adsr->state = 0;\s*\n\s*)(salChangeADSRState\(adsr\);)/${1}return ${2}/s' "$BUILD/extern/musyx/src/musyx/runtime/synth_adsr.c" 2>/dev/null || true
  #      hwSaveSample (hardware.c:478) is the ONE line that turns sdir->addr from a main-RAM
  #      pointer into an ARAM offset, and its entire body is `#if MUSY_TARGET == MUSY_TARGET_DOLPHIN`.
  #      With gc_musyx_aram.c supplying a real aramStoreData, that body is exactly what this port
  #      needs, so un-gate it. Without this the store exists and nothing ever calls it, and every
  #      _PB keeps the overflowing 0x80xxxxxx address described at the hw_aramdma.c exclusion.
  perl -0pi -e 's/(void hwSaveSample\(void\* header, void\* data\) \{\n)\#if MUSY_TARGET == MUSY_TARGET_DOLPHIN\n(.*?)\#endif\n(\})/${1}${2}${3}/s' "$BUILD/extern/musyx/src/musyx/runtime/hardware.c" 2>/dev/null || true
  #      MusyX's own two: synthdata.c:672 calls free() with no prototype in scope (the decomp's
  #      own include/stdlib.h shadows the sysroot's and declares no free -> implicit int), and
  #      reverb_fx.c:20 declares ReverbHIModify void against reverb.c:82's bool definition.
  perl -0pi -e 's{\A(?!extern void free)}{extern void free(void *);\n}' "$BUILD/extern/musyx/src/musyx/runtime/synthdata.c" 2>/dev/null || true
  perl -0pi -e 's/extern void ReverbHIModify\(/extern bool ReverbHIModify(/' "$BUILD/extern/musyx/src/musyx/runtime/StdReverb/reverb_fx.c" 2>/dev/null || true
  #  (d) [ENDIANNESS] The sound bank is a big-endian PowerPC asset and every reader — the msm
  #      wrapper layer AND MusyX itself — uses native struct loads, with no byte-order handling
  #      anywhere (grep bswap/endian over src/msm + extern/musyx: zero hits). MEASURED symptom
  #      before this hook: `MSM(Sound Manager) Error:Error Code -121` = MSM_ERR_INVALIDFILE from
  #      msmsys.c:807 reading `version` as 0x02000000 instead of 2, after which audio.c:57
  #      `while (1);` parks the boot permanently.
  #      msmFioRead (msmfio.c:11) is the single function all 15 bank reads funnel through, so
  #      the swap hooks there and classifies each read by (file, offset) against the container's
  #      own header. See shims/src/gc_musyx_bswap.c.
  perl -0pi -e 's/(\n\s*)return fio\.read\(fileInfo, addr, length, offset, 2\);/${1}{ extern void __recomp_bswap_msm_read(u32, void *, s32, s32);\n      BOOL r_ = fio.read(fileInfo, addr, length, offset, 2);\n      if (r_ >= 0) __recomp_bswap_msm_read((u32)fileInfo->startAddr, addr, length, offset);\n      return r_; }/' "$BUILD/src/msm/msmfio.c" 2>/dev/null || true
  #      Songs are reached by TWO routes — a DVD read into songBuf (msmmus.c:352) and a direct
  #      pointer into an already-loaded group blob (msmmus.c:364) that never passes through
  #      msmFioRead — so the sequence swap hooks where both converge: the `arrfile` handed to
  #      sndSeqPlay (msmmus.c:392). The swapper is idempotent per ARR base for that reason.
  perl -0pi -e 's{(sndSeqPlay\(\s*[^;]*?->sgid\s*,\s*[^;]*?->sid\s*,\s*)([A-Za-z_][\w\->\.]*)(\s*,)}
                 {${1}__recomp_bswap_msm_song_ret($2)$3}sx;
                 s{\A}{extern void *__recomp_bswap_msm_song_ret(void *);\n}' "$BUILD/src/msm/msmmus.c" 2>/dev/null || true
fi
# 3. programmatic fixes for non-mwcc-path decomp bugs (transform staged copy only).
#    ext_math.h: forward decl missing ';' inside the #ifndef __MWERKS__ branch.
perl -0pi -e 's/(\bvoid\s+HuSetVecF\s*\([^;{]*\))\s*\n(\s*#endif)/$1;\n$2/g' \
  "$BUILD/include/ext_math.h" 2>/dev/null || true

# 3a. Compile-fix transforms — clang-vs-mwcc incompatibilities in game/SDK units.
#     Verified (compile-tested + adversarially reviewed) by workflow wf_0410e5b9.
#     static-decl reconciliations (definition is file-local; align the header prototype):
perl -0pi -e 's/^(DataReadStat \*HuDataDirReadNum\(s32 data_num, s32 num\);)/static $1/m' "$BUILD/include/game/data.h" 2>/dev/null || true
perl -0pi -e 's{^(?=(?:BOOL CheckBallCoinDone|void TakeBallStar|void ExecTakeBallStar|BOOL CheckTakeBallStarDone)\b)}{static }mg' "$BUILD/include/game/board/boo.h" 2>/dev/null || true
#     (a __CARDStart un-static transform used to live here; deleted 2026-08-28 as DEAD — skip_unit
#      below excludes the whole src/dolphin/card/ tree, so CARDBios.c is never compiled. The card
#      SDK is replaced wholesale by shims/src/gc_card.c.)
#     [decomp gen2] include/ctype.h declares isalpha/isdigit/... `__attribute__((weak))` (its
#     DECL_WEAK, for MSL's matching build). A WEAK reference does not pull a definition out of an
#     archive, MSL is not compiled here, so wasm-ld leaves isalpha undefined-weak and turns every
#     call into a trap: MEASURED, `unreachable` in MakeObjectName (hsfload.c `isalpha(name[1])`)
#     <- Hu3DModelObjMtxGet <- instDll's InstPlayerMain, the first minigame instruction screen.
#     Strong declarations bind them to libc's (identical for the ASCII names the game passes).
perl -0pi -e 's/DECL_WEAK (int (?:is|to)\w+\(int __c\);)/$1/g' "$BUILD/include/ctype.h" 2>/dev/null || true
#     [decomp gen2] bowser.h declares `void BoardBowserExec`, bowser.c defines `s32` (its body returns
#     nothing; board/main.c ignores the value). Declare it as defined.
perl -0pi -e 's/^void BoardBowserExec\(s32 player, s32 space\);/s32 BoardBowserExec(s32 player, s32 space);/m' "$BUILD/include/game/board/bowser.h" 2>/dev/null || true
#     [2026-10-03] CALLBACK SIGNATURES. wasm's call_indirect checks the callee's exact type and traps
#     (`null function or function signature mismatch`) on any difference; PowerPC does not care, and
#     the matching decomp keeps every mwcc-era mismatch (a `void f(void)` stored where the caller passes
#     arguments or reads a result). Found with -Wcast-function-type-strict + a scan for `(void*)fn`
#     launders across src/game and all 93 overlays; each fix gives the callee the type its CALLER
#     uses, with the value PowerPC would have produced (see the overlay block for the rest).
#     board/boo.c: BallRenderHook is `void(void)` but runs as an HU3DMODELHOOK (model, mtx) — the Boo
#     ball's render hook, so the first Boo event on a board would trap. It reads neither argument.
perl -0pi -e 's/static void BallRenderHook\(void\)/static void BallRenderHook(HU3DMODEL *__m, Mtx __mtx)/g' "$BUILD/src/game/board/boo.c" 2>/dev/null || true
[ "$(grep -c 'BallRenderHook(HU3DMODEL \*__m, Mtx __mtx)' "$BUILD/src/game/board/boo.c")" = 2 ] || { echo "[recomp] FATAL: boo.c BallRenderHook signature edit did not apply" >&2; exit 1; }
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
#     [AOT overlays, 2026-10-01 — TABLE-DRIVEN] objdll.c is where the game links an overlay. Every
#     overlay compiled into this module (ovl_build.py; RECOMP_OVERLAYS, default all) is dispatched
#     through ONE generated table (BUILD/ovl/ovl_table.c, consulted via shims/src/gc_ovl_dispatch.c)
#     instead of HuDvdDataReadDirect(.rel) + OSLink + calling the big-endian PowerPC prolog address
#     read out of the REL header. It replaces four hand-written `if(overlay == OVL_X)` cases (the
#     reason the shipped binary carried only four overlays) and adds the two things they lacked:
#       * FRESH STATICS on every link (data restored, bss zeroed) and bss zeroed again on the
#         "Already Loaded" restart — what OSLink and objdll.c's memset do on hardware. Without it
#         the second entry into an overlay ran on the previous visit's statics: MEASURED, the
#         LoadHSF out-of-bounds trap on re-entering mentDll (ovl_build.py has the trace).
#       * The "Already Loaded" path (omDLLStart, dllno>=0 && !flag) and omDLLEnd's stay-resident
#         epilog both dereferenced dll->module, which is 0 for an AOT overlay — in wasm a read of
#         address 0 does not trap, it returns the C statics at the bottom of linear memory, and
#         memset(dll->bss=0, 0, <that>) would then zero them. Both are routed to the table now.
#     An overlay that is NOT in the table still takes the original path and stops, named, at the
#     OSLink host import (recomp_worker.js AN OVERLAY THIS BUILD DOES NOT CARRY).
#     Anchors are lines both decomp generations share (verified on the 2026 tree; the gen1 tree is
#     the one these hooks replaced, whose own anchors were the same lines).
perl -0pi -e 's{\A}{extern long __recomp_ovl_find(short);\nextern void __recomp_ovl_fresh(long);\nextern void __recomp_ovl_bss(long);\nextern long __recomp_ovl_prolog(long);\nextern void __recomp_ovl_epilog(long);\nextern const char *__recomp_ovl_name(long);\nextern void __recomp_ovl_bind(void *, long);\nextern long __recomp_ovl_of(void *);\nextern void __recomp_ovl_unbind(void *);\n}' "$BUILD/src/game/objdll.c" 2>/dev/null || true
perl -0pi -e 's{(dll->name = dllFile->name;\n)}{$1\t{ long __ri = __recomp_ovl_find(overlay); if(__ri >= 0){ dll->module = 0; dll->bss = 0; __recomp_ovl_bind(dll, __ri); __recomp_ovl_fresh(__ri); if(flag==1){OSReport("objdll> AOT %s prolog\\n", __recomp_ovl_name(__ri)); dll->ret = __recomp_ovl_prolog(__ri);} return dll; } }\n}' "$BUILD/src/game/objdll.c" 2>/dev/null || true
perl -0pi -e 's{(omDllData \*dll = omDLLinfoTbl\[dllno\];\n)}{$1\t\t{ long __ri = __recomp_ovl_of(dll); if(__ri >= 0){ OSReport("objdll>Already Loaded AOT %s\\n", __recomp_ovl_name(__ri)); __recomp_ovl_bss(__ri); dll->ret = __recomp_ovl_prolog(__ri); return dllno; } }\n}' "$BUILD/src/game/objdll.c" 2>/dev/null || true
perl -0pi -e 's/(\(\(DLLEpilog\)dll->module->epilog\)\(\);)/if(dll->module) $1 else __recomp_ovl_epilog(__recomp_ovl_of(dll));/' "$BUILD/src/game/objdll.c" 2>/dev/null || true
perl -0pi -e 's/(\(\(DLLEpilog\)dll_ptr->module->epilog\)\(\);)/if(dll_ptr->module) $1 else __recomp_ovl_epilog(__recomp_ovl_of(dll_ptr));/' "$BUILD/src/game/objdll.c" 2>/dev/null || true
perl -0pi -e 's/(if\(OSUnlink\(&dll_ptr->module->info\) != TRUE\))/if(dll_ptr->module \&\& OSUnlink(&dll_ptr->module->info) != TRUE)/' "$BUILD/src/game/objdll.c" 2>/dev/null || true
perl -0pi -e 's/(HuMemDirectFree\(dll_ptr->module\);)/if(dll_ptr->module) $1/' "$BUILD/src/game/objdll.c" 2>/dev/null || true
perl -0pi -e 's/(\n(\s*)HuMemDirectFree\(dll_ptr\);)/\n$2__recomp_ovl_unbind(dll_ptr);$1/' "$BUILD/src/game/objdll.c" 2>/dev/null || true
for mark in '__recomp_ovl_find(overlay)' '__recomp_ovl_of(dll); if' 'else __recomp_ovl_epilog(__recomp_ovl_of(dll));' \
            'else __recomp_ovl_epilog(__recomp_ovl_of(dll_ptr));' 'if(dll_ptr->module) HuMemDirectFree' '__recomp_ovl_unbind(dll_ptr);'; do
  if ! grep -qF "$mark" "$BUILD/src/game/objdll.c"; then
    echo "[recomp] FATAL: objdll.c overlay hook did not apply: $mark" >&2; exit 1
  fi
done
#     [step 4] bootDll NintendoDataDecode: the compiled-in nintendoData.inc is BIG-ENDIAN; the
#     size + decode_type header u32s are read natively (LE-wrong). Byte-swap them (HuDecodeData
#     reads the compressed body byte-by-byte per data.c:587, so only the 2 header reads need it).
perl -0pi -e 's/(u32 size = )\*src\+\+;/${1}__builtin_bswap32(*src++);/; s/(int decode_type = )\*src\+\+;/${1}(int)__builtin_bswap32(*src++);/' "$BUILD/src/REL/bootDll/main.c" 2>/dev/null || true
#     [step 5] byte-swap the decoded BE AnimData sprite tree to LE once at decode time, so
#     HuSprAnimRead + the sprite render path read correct offsets/counts (shims/src/gc_anim_bswap.c).
perl -0pi -e 's/(HuDecodeData\(src, dst, size, decode_type\);)/$1\n\t\t{ extern void __recomp_bswap_animtree(void*); __recomp_bswap_animtree(dst); }/' "$BUILD/src/REL/bootDll/main.c" 2>/dev/null || true
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
#     [decomp gen2] the same three reads in the 2026 decomp's spelling (read_stat->readStat,
#     file->fileDataP, raw_len->rawLen, comp_type->decodeType, temp_ptr->ptr). See DECOMP GENERATIONS.
perl -0pi -e 's/(readStat->fileDataP = PTR_OFFSET\(readStat->dirP, )\*ptr(\);)/${1}__builtin_bswap32(*ptr)${2}/;
              s/(readStat->rawLen = )\*ptr\+\+;/${1}__builtin_bswap32(*ptr); ptr++;/;
              s/(readStat->decodeType = )\*ptr\+\+;/${1}__builtin_bswap32(*ptr); ptr++;/;' "$BUILD/src/game/data.c" 2>/dev/null || true
#     [general asset endianness, 2026-10-01] The SHORT read path: HuDataReadNumHeapShortForce
#     (data.c) reads only the directory header + the one sub-file it needs straight off the disc,
#     and parses that big-endian header natively — file count, the file's offset, the next file's
#     offset — then HuDataDecodeIt reads the sub-file's rawLen/decodeType natively when the header
#     is 4-aligned (its unaligned branch assembles bytes big-endian, which is right either way).
#     Reached only from overlays: instDll's instruction picture (instDll main.c:218) and mgmodedll
#     free play — so the four-overlay build never hit it. MEASURED on the all-overlay build: w02's
#     first minigame instruction screen asked DVDReadAsyncPrio for 0xE8B90000 bytes. Swap all five.
perl -0pi -e 's/(fileNumMax = )\*fileData;/${1}(s32)__builtin_bswap32((u32)*fileData);/;
              s/(\n\s*fileOfs = )\*dataHdr;/${1}(s32)__builtin_bswap32((u32)*dataHdr);/;
              s/(dataOfs = )\(\*dataHdr\)-readOfs;/${1}(s32)__builtin_bswap32((u32)*dataHdr)-readOfs;/;
              s/(\n(\s*)s32 \*data = buf;\n\s*)rawLen = \*data\+\+;\n\s*decodeType = \*data\+\+;/${1}rawLen = (s32)__builtin_bswap32((u32)*data); data++;\n$2decodeType = (s32)__builtin_bswap32((u32)*data); data++;/;' "$BUILD/src/game/data.c" 2>/dev/null || true
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
#     [decomp gen2] same five reads, dir_data -> dirBuf.
perl -0pi -e 's/count = dirBuf\[0\];/count = (s32)__builtin_bswap32((u32)dirBuf[0]);/;
              s/if \(dirBuf\[1\] - count < 0\) \{/if ((s32)__builtin_bswap32((u32)dirBuf[1]) - count < 0) {/;
              s/size = \(dirBuf\[1\] - count \+ 0x3F\)/size = ((s32)__builtin_bswap32((u32)dirBuf[1]) - count + 0x3F)/;
              s/dst = HuMemDirectMallocNum\(heap, \(dirBuf\[0\] \+ 1\) & ~1, num\);/dst = HuMemDirectMallocNum(heap, ((s32)__builtin_bswap32((u32)dirBuf[0]) + 1) & ~1, num);/;
              s/HuDecodeData\(&dirBuf\[2\], dst, dirBuf\[0\], dirBuf\[1\]\);/HuDecodeData(\&dirBuf[2], dst, (s32)__builtin_bswap32((u32)dirBuf[0]), (s32)__builtin_bswap32((u32)dirBuf[1]));/;' "$BUILD/src/game/armem.c" 2>/dev/null || true
#     [DIAG, gated] FONTDIAG: print every 320-wide HuSprTexLoad (anim/bmp/data ptrs) — the
#     board-font barcode forensics (FIFO SETIMAGE base diverges from the only header in RAM).
if [ -n "${RECOMP_FONTDIAG:-}" ]; then
perl -0pi -e 's/(short sizeY = bmp_ptr->sizeY;)/$1\n    { extern void OSReport(const char*, ...); if (bmp_ptr->sizeX == 320) OSReport("FONTTEX anim=%08x bmpp=%08x data=%08x palp=%08x fmt=%d szY=%d\\n", (u32)anim, (u32)bmp_ptr, (u32)bmp_ptr->data, (u32)bmp_ptr->palData, bmp_ptr->dataFmt, sizeY); }/' "$BUILD/src/game/sprput.c" 2>/dev/null || true
fi
#     [HSF model endianness] LoadHSF (hsfload.c) interprets a big-endian .hsf 3D-model file (title
#     screen, board, characters) with native LE loads -> garbage counts/offsets -> OOB. Swap the
#     whole file BE->LE once at LoadHSF entry, before FileLoad reads the header. Covers all 21 HSF
#     sections + nested cenv/motion/strip data (shims/src/gc_hsf_bswap.c, built by wf_a2d55c6d).
perl -0pi -e 's/((?:HsfData|HSFDATA) \*LoadHSF\(void \*data\)\s*\{)/$1\n    { extern void __recomp_bswap_hsf(void*); __recomp_bswap_hsf(data); }/' "$BUILD/src/game/hsfload.c" 2>/dev/null || true
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
perl -0pi -e 's/(static void THPViewSprFunc\((?:HuSprite|HUSPRITE) \*arg0\)\s*\n\{)/$1\n    return;/' "$BUILD/src/game/thpmain.c" 2>/dev/null || true
#     [input inject] the recomp has no VI-retrace interrupt firing PadReadVSync, so HuPadBtnDown
#     never gets real input. Deliver host buttons: OR __recomp_inject_btn[p] (set by the host via
#     ___recomp_set_pad) into HuPadBtnDown[p] at HuPadRead's end (shims/src/gc_input.c).
#     FRAME-SCOPED (not one-shot): HuPadRead runs MORE THAN ONCE per retrace in some overlays
#     (mentDll char-select), and a consume-on-first-delivery let the second call recompute
#     HuPadBtnDown from _Pad state and WIPE the injected bit before the game logic saw it (the
#     eaten-A stall). The pacing side sets the cells for exactly one frame and clears them at
#     the next retrace, and the HuPrcKill zombie fix removed the double-processing that the
#     one-shot was protecting against.
#     [four ports 2026-09-10] THE INDEX WAS THE HARDCODED LITERAL 0 AND THAT WAS THE WHOLE
#     TWO-PLAYER BLOCKER. game/pad.c's HuPadRead already loops i=0..3 over four-element arrays,
#     and mentDll's character select reads HuPadBtnDown[player->pad_idx] per player
#     (~/gc_refs/marioparty4/src/REL/mentDll/main.c:3987-4025), so this bake is the only place
#     that collapsed four ports into one. It is now a four-iteration loop over the arrays in
#     gc_input.c and nothing else changed about it.
#     RECOMP_SINGLEPORT=1 bakes the OLD one-port line instead — port 0 and nothing else, exactly
#     as this shipped before 2026-09-10. It exists so the four-port claim has a MATCHED NEGATIVE
#     CONTROL: same tree, same shims, same witness export, one loop bound. Without it the only
#     available control was the previously-shipped wasm, which also predates
#     ___recomp_pad_witness — so it reads four zeros for the trivial reason that it has no
#     witness at all, and a vacuous control proves nothing.
#     gamecube/tools/recomp_fourport_test.mjs is what consumes it.
if [ -n "${RECOMP_SINGLEPORT:-}" ]; then
  echo "[recomp] ⚠ RECOMP_SINGLEPORT=1 — baking the OLD port-0-only input path (A/B control arm)"
  perl -0pi -e 's/(_PadBtnDown\[i\] = 0;\s*\n\s*\})\n\}/$1\n    { extern int __recomp_inject_btn[4]; extern int __recomp_inject_dstk[4]; extern int __recomp_inject_stkx[4]; extern int __recomp_inject_stky[4]; HuPadBtnDown[0] |= (unsigned short)__recomp_inject_btn[0]; HuPadDStkRep[0] |= (unsigned char)__recomp_inject_dstk[0]; if (__recomp_inject_stkx[0]) HuPadStkX[0] = (s8)__recomp_inject_stkx[0]; if (__recomp_inject_stky[0]) HuPadStkY[0] = (s8)__recomp_inject_stky[0]; }\n}/' "$BUILD/src/game/pad.c" 2>/dev/null || true
  BAKE_MARK='__recomp_inject_btn\[0\]'
else
  perl -0pi -e 's/(_PadBtnDown\[i\] = 0;\s*\n\s*\})\n\}/$1\n    { extern int __recomp_inject_btn[4]; extern int __recomp_inject_dstk[4]; extern int __recomp_inject_stkx[4]; extern int __recomp_inject_stky[4]; int __rp; for (__rp = 0; __rp < 4; __rp++) { HuPadBtnDown[__rp] |= (unsigned short)__recomp_inject_btn[__rp]; HuPadDStkRep[__rp] |= (unsigned char)__recomp_inject_dstk[__rp]; if (__recomp_inject_stkx[__rp]) HuPadStkX[__rp] = (s8)__recomp_inject_stkx[__rp]; if (__recomp_inject_stky[__rp]) HuPadStkY[__rp] = (s8)__recomp_inject_stky[__rp]; } }\n}/' "$BUILD/src/game/pad.c" 2>/dev/null || true
  BAKE_MARK='__recomp_inject_btn\[__rp\]'
fi
#     ⚠ THE BAKE ABOVE ENDS IN `|| true`, SO A PATTERN THAT STOPS MATCHING IS SILENT — and a
#     recomp with no bake boots perfectly and simply never accepts a button. Assert it landed.
if ! grep -q "$BAKE_MARK" "$BUILD/src/game/pad.c" 2>/dev/null; then
  echo "[recomp] FATAL: the input bake did not apply to $BUILD/src/game/pad.c" >&2
  echo "[recomp]        (HuPadRead's tail no longer matches the perl pattern) — input would be DEAD" >&2
  exit 1
fi
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
perl -0pi -e 's/#define HuSprAnimReadFile\(data_id\) \(HuSprAnimRead\((HuDataSelHeapReadNum\(\(data_id\), (?:MEMORY_DEFAULT_NUM, HEAP_DATA|HU_MEMNUM_OVL, HEAP_MODEL)\))\)\)/extern void *__recomp_bswap_animtree_ret(void *);\n#define HuSprAnimReadFile(data_id) (HuSprAnimRead(__recomp_bswap_animtree_ret($1)))/' "$BUILD/include/game/sprite.h" 2>/dev/null || true
#     esprite.c espEntry reads the SAME fresh disc AnimData but calls HuSprAnimRead directly
#     (not via the macro) -> BE blob parsed natively -> garbage-size mallocs (0x2c030020) +
#     HuMemMemoryAlloc free-list spin when the modesel menu creates its sprites. Wrap it too.
perl -0pi -e 's/(var_r30->unk08 = HuSprAnimRead\()(temp_r26)(\);)/{ extern void *__recomp_bswap_animtree_ret(void *); $1__recomp_bswap_animtree_ret($2)$3 }/' "$BUILD/src/game/esprite.c" 2>/dev/null || true
#     [decomp gen2] espEntry's read is spelled `animFree->anim = HuSprAnimRead(data);` there.
perl -0pi -e 's/(animFree->anim = HuSprAnimRead\()(data)(\);)/{ extern void *__recomp_bswap_animtree_ret(void *); $1__recomp_bswap_animtree_ret($2)$3 }/' "$BUILD/src/game/esprite.c" 2>/dev/null || true
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
perl -0pi -e 's/((?:AnimData|ANIMDATA) \*HuSprAnimRead\(void \*data\)\n\{)/$1\n    { extern void *__recomp_bswap_animtree_auto(void *); data = __recomp_bswap_animtree_auto(data); }/' "$BUILD/src/game/sprman.c" 2>/dev/null || true
#     [static-anim double-relocation] The already-relocated sentinel (anim->bank & 0xFFFF0000)
#     never trips for a STATIC .inc tree at a low wasm address (base+bankOfs < 0x10000), so a
#     shared asset's second HuSprAnimRead relocated it TWICE (bank = ofs + 2*base — the
#     title/board noise-texture bind at masked 0x173cbd20). Statics relocate once per address
#     via the shim registry; heap trees keep the retail sentinel (sound at 0x80xxxxxx).
perl -0pi -e 's/(    (?:AnimData|ANIMDATA) \*anim = \((?:AnimData|ANIMDATA) \*\)data;\n)(    if\(\(u32\)anim->bank & 0xFFFF0000\) \{)/$1    if ((u32)data < 0x80000000u) { extern int __recomp_animreloc_once(void*); if (!__recomp_animreloc_once(data)) { anim->useNum++; return anim; } }\n$2/' "$BUILD/src/game/sprman.c" 2>/dev/null || true
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
#     [2026-10-03] RAM through the UNCACHED mirror. On hardware 0xC0000000+x is main RAM at
#     0x80000000+x with the cache bypassed; here guest RAM exists once, at its cached address, and
#     nothing models the cache, so the mirror is the same bytes. OSCachedToUncached /
#     OSUncachedToCached become the identity. MEASURED before: m415Dll main.c fn_1_1960
#     `memcpy(bmp->data, OSCachedToUncached(Hu3DShadowData.buf), size*size)` read 0xC0xxxxxx, past
#     the wasm memory ceiling -> `memory access out of bounds` on that minigame's first frame. (The
#     MMIO window, OSPhysicalToUncached(0xC00xxxx), is a different thing and is handled above.)
perl -0pi -e 's/(#define OSCachedToUncached\(caddr\) )\(\(void \*\)\(\(u8 \*\)\(caddr\) \+ \(OS_BASE_UNCACHED - OS_BASE_CACHED\)\)\)/${1}((void *)(caddr))/; s/(#define OSUncachedToCached\(ucaddr\) )\(\(void \*\)\(\(u8 \*\)\(ucaddr\) - \(OS_BASE_UNCACHED - OS_BASE_CACHED\)\)\)/${1}((void *)(ucaddr))/' "$BUILD/include/dolphin/os.h" 2>/dev/null || true
grep -q 'define OSCachedToUncached(caddr) ((void \*)(caddr))' "$BUILD/include/dolphin/os.h" || { echo "[recomp] FATAL: OSCachedToUncached identity edit did not apply" >&2; exit 1; }

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
        dm=declpat.search(s)
        if dm:
            # [decomp gen2] a LOCAL prototype that disagrees with the definition (board/space.c
            # carries `extern void BoardMushroomExec(s32 player, s32 space); // wrong` against a
            # one-argument definition) is replaced by the canonical one, or the arity truncation
            # above leaves calls that no longer match their own file's declaration.
            d=' '.join(dm.group(0).split())
            first=d.split()[0] if d.split() else ''
            if not isdef and (first=='extern' or re.match(TYPE+'$',first)) and ' '.join(proto.split())!=d.replace('extern ','',1):
                s=s[:dm.start()]+proto+s[dm.end():]; open(f,"w",errors="surrogateescape").write(s)
            continue                                                                   # has a prototype
        if hdr and ('"%s"'%hdr in s or '<%s>'%hdr in s): continue                       # includes declaring header
        if isdef: continue                                                             # def file
        incs=list(re.finditer(r'(?m)^#include[^\n]*\n',s)); ins=incs[-1].end() if incs else 0
        open(f,"w",errors="surrogateescape").write(s[:ins]+proto+"\n"+s[ins:])
PYEOF
fi

# 4. compile game + high-level SDK translation units to wasm objects. Force-include
#    the canonical prototypes (types-only base, so no implicit-decl shift).
# [-Wreturn-type 2026-09-02] `-w` USED TO BE HERE and it hid the two defects that made the
# game silent. A missing `return` is not cosmetic in this port: mwcc on PowerPC leaves the
# value in r3, which IS the return register, so a function whose last statement is a call
# "returns" that call's result by accident and the retail disc works. clang->wasm has no such
# coincidence — it returns whatever is on the value stack, and the caller reads garbage.
# `adsrSetup` (synth_adsr.c:106) was exactly this and its symptom was "17 macros run, 0 audible
# samples", which reads as a mixer bug rather than a one-line codegen difference.
#   ORDER MATTERS AND `-w` CANNOT BE USED: clang's `-w` disables every warning REGARDLESS of
#   flag position, so appending -Wreturn-type after it is a placebo (measured: a sweep with
#   `-w -Wreturn-type` reported 0 hits over the whole tree; the same sweep with
#   `-Wno-everything -Wreturn-type` reported 17). -Wno-everything IS order-dependent, so it
#   silences the noise while leaving this one class armed. -Wreturn-mismatch is the sibling
#   clang split out of -Wreturn-type (a bare `return;` in a non-void function) and is the exact
#   shape of PlayCharVoice/PlayStepFX below, so both are on.
# Cost of arming it: 17 warnings tree-wide, all pre-existing, none in MusyX/msm. They are
# REPORTED, not fixed, by this script — see the [return-type] summary after the compile loop.
CFLAGS=( -c -std=gnu89 -O2 -Wno-everything -Wno-error -Wno-implicit-function-declaration
        -Wno-int-conversion
        -Wno-incompatible-function-pointer-types -Wno-incompatible-pointer-types
        -Wno-builtin-requires-header -fno-builtin
        -Wreturn-type -Wreturn-mismatch
        -DVERSION=0 -DRECOMP_DECOMP_GEN=$DECOMP_GEN -fdeclspec ${RECOMP_HSFDIAG:+-DRECOMP_HSFDIAG}
        -I "$BUILD/include" -I "$BUILD/gen" -I "$BUILD/extern/musyx/include" -I "$BUILD/src" )
# NOTE: implicit-declaration signature mismatches (a bounded finite set surfaced at
# link) are resolved in port-completion by adding the missing per-unit includes; the
# force-include-everything shortcuts (hand prototypes / all-headers) proved fragile
# (wrong-arg protos; missing-header propagation) and were dropped. See PLAN.md.
rm -rf "$BUILD/obj"; mkdir -p "$BUILD/obj"
ok=0; fail=0; : > "$BUILD/fails.txt"; : > "$BUILD/returns.txt"
# Per-file stderr is overwritten by the next file, so the -Wreturn-type hits have to be
# harvested at each call site or they are gone. Kept out of fails.txt: these units COMPILE.
collect_returns() { grep -E '\[-W(return-type|return-mismatch)\]' "$1" 2>/dev/null |
                    sed "s|$BUILD/||" >> "$BUILD/returns.txt" || true; }
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
# Its 17 entry points are REPLACED by shims/src/gc_card.c (compiled first, below): a RAM-backed
# 2 MiB .raw card. Skipping the dir without that shim left all 17 as wasm imports answered by
# recomp_worker.js's generic `default: return 0` stub — CARD_RESULT_READY with no out-param
# written — which is why the file-select screen reported "No valid Memory Card is inserted".
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
  collect_returns /tmp/ce.txt
}
compile_dir() {
  for f in $(find "$1" -name '*.c' 2>/dev/null); do skip_unit "$f" && continue; compile_one "$f"; done
}
# portable replacements first. gc_musyx_*.c are held back for the RECOMP_MUSYX block below:
# they need -DMUSY_TARGET=0 for the MusyX headers, and compiling them here would also put the
# real AI driver + the audio pump into the DEFAULT build, which must stay unaffected.
for f in "$RECOMP"/shims/src/*.c; do
  case "$f" in */gc_musyx_*.c) continue;; esac
  compile_one "$f"
done
compile_dir "$BUILD/src/game"
compile_dir "$BUILD/src/dolphin"
compile_dir "$BUILD/src/libhu"
# [audio, RECOMP_MUSYX=1 — OPT-IN] the MusyX library + the game's msm wrappers. MUSY_TARGET=0
# (=MUSY_TARGET_PC) is passed ONLY to these units, so the default build is bit-unaffected: it
# selects hw_pc.c over hw_dolphin.c (which would otherwise drag in DSPInit/DSPAddTask and a
# `while (!salDspInitIsDone)` spin that no interrupt can ever clear here) and drops the
# dspSlave microcode blob. The unit list is extern/musyx/CMakeLists.txt's verbatim.
if [ -n "${RECOMP_MUSYX:-}" ]; then
  MUSYCF=(-DMUSY_TARGET=0)
  musyx_ok=0
  for f in $(find "$BUILD/extern/musyx/src/musyx/runtime" -name '*.c' 2>/dev/null); do
    case "$f" in */profile.c) continue;; esac      # not in MusyX's CMakeLists (needs musyx_priv.h)
    # hw_pc.c is the library's DO-NOTHING target, not a software backend (salAiGetDest returns
    # NULL at :89, salStartAi has no body at :82, salStartDsp is empty at :99). It is replaced
    # wholesale by shims/src/gc_musyx_hw.c, which keeps hw_dolphin.c's AI rotation and callback
    # chain and substitutes the software mixer for the dspSlave microcode. Excluded by name
    # rather than left to -Wl,--allow-multiple-definition, because that resolves by link order
    # and has silently shadowed the wrong definition here before (the __frsqrte/sqrtf incident).
    case "$f" in */hw_pc.c) continue;; esac
    # hw_aramdma.c's MUSY_TARGET_PC branch (:344-422) is stubs for the SAME reason and with a
    # worse consequence: aramStoreData is `{}` on a void* return (:401) and aramUploadData has no
    # body (:387), so no sample body is ever stored AND hwSaveSample (hardware.c:478, whose whole
    # body is #if MUSY_TARGET_DOLPHIN) never rewrites sdir->addr from a main-RAM pointer to an
    # ARAM offset. hw_dspctrl.c:594 then does `base = smp_info.addr * 2` on a 0x80xxxxxx pointer,
    # which overflows 32 bits and loses bit 31. Replaced wholesale by shims/src/gc_musyx_aram.c.
    case "$f" in */hw_aramdma.c) continue;; esac

    o="$BUILD/obj/$(printf '%s' "${f#$BUILD/}" | tr '/' '_' | tr -c 'A-Za-z0-9_.-' '_').o"
    if emcc "${CFLAGS[@]}" "${MUSYCF[@]}" "$f" -o "$o" 2>/tmp/ce_mx.txt; then ok=$((ok+1)); musyx_ok=$((musyx_ok+1));
    else fail=$((fail+1)); echo "  musyx/$(basename "$f"): $(grep -m1 'error:' /tmp/ce_mx.txt | sed 's|.*error: ||')" >> "$BUILD/fails.txt"; fi
    collect_returns /tmp/ce_mx.txt
  done
  for f in "$BUILD"/src/msm/*.c; do
    o="$BUILD/obj/$(printf '%s' "${f#$BUILD/}" | tr '/' '_' | tr -c 'A-Za-z0-9_.-' '_').o"
    if emcc "${CFLAGS[@]}" "${MUSYCF[@]}" "$f" -o "$o" 2>/tmp/ce_mx.txt; then ok=$((ok+1)); musyx_ok=$((musyx_ok+1));
    else fail=$((fail+1)); echo "  msm/$(basename "$f"): $(grep -m1 'error:' /tmp/ce_mx.txt | sed 's|.*error: ||')" >> "$BUILD/fails.txt"; fi
    collect_returns /tmp/ce_mx.txt
  done
  # The audio host layer: software AX mixer (gc_musyx_mix.c), MusyX SAL backend replacing
  # hw_pc.c (gc_musyx_hw.c), the AI DMA model that drives the whole chain off emulated time
  # (gc_musyx_ai.c), and the BE->LE swappers for the sound bank and the sequences
  # (gc_musyx_bswap.c, gc_musyx_song_bswap.c). Built with MUSYCF so the two that include MusyX
  # headers see the same MUSY_TARGET as the library.
  for f in "$RECOMP"/shims/src/gc_musyx_*.c; do
    o="$BUILD/obj/$(printf '%s' "${f#$BUILD/}" | tr '/' '_' | tr -c 'A-Za-z0-9_.-' '_').o"
    if emcc "${CFLAGS[@]}" "${MUSYCF[@]}" "$f" -o "$o" 2>/tmp/ce_mx.txt; then ok=$((ok+1)); musyx_ok=$((musyx_ok+1));
    else fail=$((fail+1)); echo "  audio/$(basename "$f"): $(grep -m1 'error:' /tmp/ce_mx.txt | sed 's|.*error: ||')" >> "$BUILD/fails.txt"; fi
    collect_returns /tmp/ce_mx.txt
  done
  echo "[recomp] RECOMP_MUSYX: $musyx_ok MusyX/msm/audio-host objects built"
fi
# [AOT overlays, 2026-10-01] EVERY OVERLAY, ONE PROCEDURE (gamecube/recomp/ovl_build.py).
# RECOMP_OVERLAYS = 'all' (default) or a space-separated list of src/REL directory names, e.g.
#   RECOMP_OVERLAYS="bootDll modeseldll mentDll w01Dll"   (the set the 7040471c binary carried)
# The legacy RECOMP_MODESEL/RECOMP_MENT/RECOMP_W01 switches are no longer needed and are ignored;
# RECOMP_NO_BOOTDLL=1 still drops bootDll from the list.
# The per-overlay SOURCE fixes below are kept verbatim from the hand-written blocks they came
# from (missing #includes that turned into int-return signature mismatches); their symbol
# namespacing (fn_1_ -> fn_ms1_ etc.) is gone because ovl_build.py namespaces every global an
# overlay defines, mechanically, with no source edits.
RECOMP_OVERLAYS="${RECOMP_OVERLAYS:-all}"
if [ -n "${RECOMP_NO_BOOTDLL:-}" ]; then
  if [ "$RECOMP_OVERLAYS" = all ]; then
    RECOMP_OVERLAYS="$(cd "$BUILD/src/REL" && for d in */; do d=${d%/}; [ "$d" != bootDll ] && printf '%s ' "$d"; done)"
  else RECOMP_OVERLAYS="$(printf '%s\n' $RECOMP_OVERLAYS | grep -vx bootDll | tr '\n' ' ')"; fi
fi
#   modeseldll: implicit-declares esp*/HuTHP*/msm*/BoardStatusKill/Hu3D*2Dto3D -> 14 sig-mismatches
#   that regressed the title; and fn_1_1EC0's prototype is commented out in modeseldll.h, so
#   modesel.c/filesel.c implicit-declare it int(int) vs the real void(s16).
for u in modesel main datalist filesel; do
  perl -0pi -e 's{\A}{#include "game/esprite.h"\n#include "game/thpmain.h"\n#include "msm/msmsys.h"\n#include "game/board/ui.h"\n#include "game/hsfex.h"\n}' "$BUILD/src/REL/modeseldll/$u.c" 2>/dev/null || true
done
perl -0pi -e 's{^// (void fn_1_1EC0\(s16 view\);)}{$1}m' "$BUILD/include/REL/modeseldll.h" 2>/dev/null || true
#   mentDll: implicit-declares the HuAud* family + Hu3D3Dto2D -> 11 int-return sig mismatches.
perl -0pi -e 's{\A}{#include "game/audio.h"\n#include "game/hsfex.h"\n}' "$BUILD/src/REL/mentDll/main.c" 2>/dev/null || true
#   w01Dll: CoasterHostComKeySet declared extern at :160, defined static at :2645 (clang errors);
#   Hu3DMtxRotGet/Hu3DMtxTransGet + BoardPlayerMoveBetween/BoardCameraPosCalcFuncSet undeclared.
perl -0pi -e 's/^extern (void CoasterHostComKeySet\(s32 playerNo\);)/static $1/m' "$BUILD/src/REL/w01Dll/main.c" 2>/dev/null || true
perl -0pi -e 's{\A}{#include "game/hsfex.h"\n}' "$BUILD/src/REL/w01Dll/main.c" 2>/dev/null || true
#   (gen1 declared neither board function in a header; gen2 declares both, and a second, differently
#   spelled prototype is a hard `conflicting types` error — so add each only where none exists.)
grep -q 'BoardPlayerMoveBetween' "$BUILD"/include/game/board/*.h 2>/dev/null ||
  perl -0pi -e 's{\A}{extern void BoardPlayerMoveBetween(s32, s32, s32);\n}' "$BUILD/src/REL/w01Dll/main.c" 2>/dev/null || true
grep -q 'BoardCameraPosCalcFuncSet' "$BUILD"/include/game/board/*.h 2>/dev/null ||
  perl -0pi -e 's{\A}{extern void BoardCameraPosCalcFuncSet(void (*)(void *));\n}' "$BUILD/src/REL/w01Dll/main.c" 2>/dev/null || true
#   Overlays the four hand-written blocks never reached. Each fix below is what the PowerPC binary
#   on the disc does, read off the REL's own call site (tools: a REL relocation walk + the eight
#   instructions before the `bl`), not a guess at what the C "meant":
#   * mwcc accepts a call with FEWER arguments than the prototype; the callee then reads whatever
#     the caller left in r4/r5. clang refuses. m404Dll main.c `espEntry(x)` (the decomp keeps the
#     3-argument form under NON_MATCHING): the REL computes r4 = idx<<2 (`rlwinm r4,r0,2,0,29`
#     from the same lha that indexes lbl_1_data_86C) and leaves r5 from the previous call; prio is
#     overwritten by espPriSet(255) on the next line, bank r5 is unknowable -> 0 (NON_MATCHING's).
perl -0pi -e 's/espEntry\(lbl_1_data_86C\[var_r27->unk_02\[5\]\]\);/espEntry(lbl_1_data_86C[var_r27->unk_02[5]], var_r27->unk_02[5] << 2, 0);/' "$BUILD/src/REL/m404Dll/main.c" 2>/dev/null || true
#     m447dll main.c `HuAudSeqFadeOut(arg0->unk70)` ("Bug: takes two arguments" — the decomp's own
#     note): r4 is the previous callee's leftover. The same file's other fade of the same music
#     handle passes `li r4,1000` (REL sec1+0x728); use that.
perl -0pi -e 's/HuAudSeqFadeOut\(arg0->unk70\);/HuAudSeqFadeOut(arg0->unk70, 1000);/' "$BUILD/src/REL/m447dll/main.c" 2>/dev/null || true
#   * a STRUCT passed where `void *` is expected: mwcc passes the struct's ADDRESS (m413Dll's
#     memset(lbl_1_bss_B8, 0, sizeof lbl_1_bss_B8) is `lis/addi r3,<lbl_1_bss_B8>` + `li r5,48` in
#     the REL — the global itself, no copy). clang refuses; pass the address explicitly.
perl -0pi -e 's/memset\(lbl_1_bss_48, 0, sizeof\(UnkM406Struct5\)\);/memset(\&lbl_1_bss_48, 0, sizeof(UnkM406Struct5));/' "$BUILD/src/REL/m406Dll/map.c" 2>/dev/null || true
perl -0pi -e 's/memset\(lbl_1_bss_B8, 0, sizeof\(lbl_1_bss_B8\)\);/memset(\&lbl_1_bss_B8, 0, sizeof(lbl_1_bss_B8));/' "$BUILD/src/REL/m413Dll/main.c" 2>/dev/null || true
#   * mwcc LVALUE CASTS, `(T)lv = v` = store v into lv viewed as T. Same bytes as *(T*)&(lv) = v
#     (pointer-to-pointer casts only, here), which clang accepts.
perl -0pi -e 's/\((Vec|GXColor|HuVec2f)\*\)\*arg0 = /*($1**)&(*arg0) = /g' "$BUILD/src/REL/m438Dll/fire.c" 2>/dev/null || true
perl -0pi -e 's/= \(void\*\) (board\w+)(\s*)(?==)/= *(void**)&($1)$2/g' "$BUILD/src/REL/w06Dll/main.c" 2>/dev/null || true
#   * selmenuDll declares two msm functions `static` with types that disagree with game/msm.h
#     (a matching-decomp device); here they are host imports in a silent build or real functions
#     with the msm.h types in an audio build, and either way the static declarations are wrong.
perl -0pi -e 's/^static s8 \*msmSeGetIndexPtr\(s16 datano\);\n//m; s/^static void msmMusSetMasterVolume\(s32 value\);\n//m' "$BUILD/src/REL/selmenuDll/main.c" 2>/dev/null || true
#   * DECLARATION != DEFINITION. wasm-ld turns each such call into an `unreachable` stub (the link
#     prints `function signature mismatch`), so the game traps the first time it reaches one. What
#     mwcc's code actually passed/returned, read off the disc:
#     - m420dll main.c `frand(); fn_1_8934();` against `void fn_1_8934(u32 seed)`: the REL is
#       `bl frand; bl fn_1_8934` (sec1+0x1fc/0x200) — the seed IS frand()'s r3.
perl -0pi -e 's/frand\(\);(\s*)fn_1_8934\(\);/fn_1_8934(frand());/' "$BUILD/src/REL/m420dll/main.c" 2>/dev/null || true
perl -0pi -e 's/void fn_1_8934\(void\);/void fn_1_8934(u32 seed);/' "$BUILD/include/REL/m420dll.h" 2>/dev/null || true
#     - w03Dll main.c tests `fn_1_12C8() != 0` against statue.c's `void fn_1_12C8(void)`, whose
#       last call is BoardRollDispSet(1). PPC returns whatever r3 holds: BoardRollDispSet leaves
#       r3 = its argument (1) when there is no roll object (beq straight to its epilogue,
#       0x80068908), else UpdateRollSprite's r3, which is the roll sprite group id — its last
#       callee is HuSprPosSet/HuSprAttrSet, neither of which writes r3 (0x8000e960, 0x8000e808).
#       player.c gains a reader for exactly that value and fn_1_12C8 returns it.
perl -0pi -e 's/(void BoardRollDispSet\(s32 arg0\)\n\{)/s32 __recomp_roll_r3(void);\n$1/; s/\z/\ns32 __recomp_roll_r3(void) { return rollObj ? (s32)omObjGetWork(rollObj, bitcopy3)->unk_04 : 1; }\n/' "$BUILD/src/game/board/player.c" 2>/dev/null || true
perl -0pi -e 's/void fn_1_12C8\(void\)\n\{(.*?)\n    BoardRollDispSet\(1\);\n\}/s32 fn_1_12C8(void)\n{$1\n    BoardRollDispSet(1);\n    { extern s32 __recomp_roll_r3(void); return __recomp_roll_r3(); }\n}/s' "$BUILD/src/REL/w03Dll/statue.c" 2>/dev/null || true
#   * CALLBACK SIGNATURES (see the boo.c note above). Every edit is verified below.
#     - mentDll / mpexDll / ztardll declare their per-object callback slot VARIADIC,
#       `void (*)(OMOBJ *, ...)`, and every call site passes exactly (object, &its-own-struct). In
#       wasm a variadic call passes (object, pointer-to-a-varargs-buffer), so a callee declared
#       (OMOBJ *, Struct *) received the BUFFER's address, not the struct's, and a callee of any other
#       arity trapped. The slot becomes what the callers pass: (OMOBJ *, void *).
perl -0pi -e 's/typedef void \(\*MentDllUnkFunc\)\(OMOBJ \*, \.\.\.\);/typedef void (*MentDllUnkFunc)(OMOBJ *, void *);/' "$BUILD/src/REL/mentDll/main.c" 2>/dev/null || true
perl -0pi -e 's/typedef void \(\*MpexDllUnkFunc2\)\(OMOBJ \*, \.\.\.\);/typedef void (*MpexDllUnkFunc2)(OMOBJ *, void *);/' "$BUILD/src/REL/mpexDll/charsel.c" "$BUILD/src/REL/mpexDll/mpex.c" 2>/dev/null || true
perl -0pi -e 's/typedef void \(\*ZtarUnkFunc\)\(OMOBJ \*, \.\.\.\);/typedef void (*ZtarUnkFunc)(OMOBJ *, void *);/' "$BUILD/src/REL/ztardll/select.c" 2>/dev/null || true
#       mentDll fn_1_81A8 is defined with a third parameter nobody passes and it never reads.
perl -0pi -e 's/void fn_1_81A8\(OMOBJ \*arg0, void \*arg1, void \*arg2\)/void fn_1_81A8(OMOBJ *arg0, void *arg1)/g' "$BUILD/src/REL/mentDll/main.c" 2>/dev/null || true
#       mpexDll charsel fn_1_157C4 and fn_1_15D48 are `void(void)` in that slot: give it the slot's parameters (unused).
perl -0pi -e 's/void (fn_1_157C4|fn_1_15D48)\(void\)/void $1(OMOBJ *__o, void *__p)/g' "$BUILD/src/REL/mpexDll/charsel.c" 2>/dev/null || true
#     - m435 / m436: `arg0->objFunc = (void *)fn` where fn returns s32 (the decomp: "must return s32
#       to match"). omMain calls objFunc as void(OMOBJ *) and ignores any result, so a void(OMOBJ *)
#       thunk that calls fn is exactly the call omMain makes on hardware.
for spec in m435Dll:fn_1_B1F4 m436Dll:fn_1_62C4; do
  d=${spec%%:*}; f=${spec##*:}
  # the thunk goes directly after fn's definition (fn is defined before every use, in both files)
  perl -0pi -e "s/objFunc = \(void ?\*\) ?${f};/objFunc = __recomp_obj_${f};/g; s/(\ns32 ${f}\(OMOBJ ?\* ?arg0\)\s*\{.*?\n\}\n)/\$1static void __recomp_obj_${f}(OMOBJ *o) { ${f}(o); }\n/s" "$BUILD/src/REL/$d/main.c" 2>/dev/null || true
done
#     - w02: HuPrcDestructorSet2(proc, (void *)fn) with fn returning s32; the destructor is called as
#       void(void). Same thunk shape.
for f in fn_1_94AC fn_1_BE74; do
  for u in $(grep -l "(void \*)${f})" "$BUILD"/src/REL/w02Dll/*.c 2>/dev/null); do
    perl -0pi -e "s/HuPrcDestructorSet2\(([^,;]+), \(void \*\)${f}\)/HuPrcDestructorSet2(\$1, __recomp_dtor_${f})/g; s/\\z/\nstatic void __recomp_dtor_${f}(void) { ${f}(); }\n/; s/(\n#include [^\n]*\n)(?!.*\n#include )/\$1static void __recomp_dtor_${f}(void);\n/s" "$u"
  done
  grep -qF "__recomp_dtor_${f})" "$BUILD"/src/REL/w02Dll/*.c || { echo "[recomp] FATAL: w02 destructor ${f} not rewritten" >&2; exit 1; }
done
#     - w05 mg_coin: fn_1_9B74 (void) is the board's post-turn hook, which BoardPlayerPostTurnHookExec
#       calls as s32() and CLEARS when it returns non-zero (board/player.c:1002). PowerPC returns r3,
#       which is the value of the hook's last call, BoardModelAttrReset; return exactly that.
perl -0pi -e 's/void fn_1_9B74\(void\)\n\{(.*?)\n    BoardModelAttrReset\(([^;]*)\);\n\}/s32 fn_1_9B74(void)\n{$1\n    return BoardModelAttrReset($2);\n}/s; s/^void fn_1_9B74\(void\);/s32 fn_1_9B74(void);/m' "$BUILD/src/REL/w05Dll/mg_coin.c" 2>/dev/null || true
perl -0pi -e 's/^void fn_1_9B74\(void\);/s32 fn_1_9B74(void);/m' "$BUILD/include/REL/w05Dll.h" 2>/dev/null || true
#     - w20: two EMPTY void functions registered as BoardSpaceEventFunc, s32(void). The empty body leaves
#       r3 as the caller left it; 0 ("no event") is what an empty event handler means.
perl -0pi -e 's/void fn_1_494\(void\);/s32 fn_1_494(void);/; s/void fn_1_4A8\(void\);/s32 fn_1_4A8(void);/; s/void fn_1_494\(void\) \{ \}/s32 fn_1_494(void) { return 0; }/; s/void fn_1_4A8\(void\) \{ \}/s32 fn_1_4A8(void) { return 0; }/' "$BUILD/src/REL/w20Dll/main.c" 2>/dev/null || true
#     - w03: fn_1_2930(s32) is a PRE-turn hook, called as s32() with no argument (board/player.c:834);
#       it never reads the argument.
perl -0pi -e 's/s32 fn_1_2930\(s32 arg0\)/s32 fn_1_2930(void)/g' "$BUILD/src/REL/w03Dll/main.c" "$BUILD/src/REL/w03Dll/statue.c" 2>/dev/null || true
#     - m418: the sequencer copies void(s32)/s32(s32) step functions into void(void)/s32(void) slots and
#       calls them with no argument (sequence.c fn_1_AE8C). None of the 16+ step functions reads its
#       argument; the slots take the step functions' own types and the calls pass 0.
perl -0pi -e 's/M418DllFunc unk10;\n(\s*)M418DllRetFunc unk14;/M418DllInFunc unk10;\n$1M418DllInRetFunc unk14;/' "$BUILD/include/REL/m418Dll.h" 2>/dev/null || true
perl -0pi -e 's/\(M418DllFunc\)(arg0->unk4\[arg0->unk0\]\.unk0)/$1/; s/\(M418DllRetFunc\)(arg0->unk4\[arg0->unk0\]\.unk4)/$1/' "$BUILD/src/REL/m418Dll/sequence.c" 2>/dev/null || true
perl -0pi -e 's/(lbl_1_bss_(?:50|38|20)\.unk10)\(\);/$1(0);/g; s/(lbl_1_bss_(?:50|38|20)\.unk14)\(\);/$1(0);/g' "$BUILD/src/REL/m418Dll/main.c" 2>/dev/null || true
for chk in "mentDll/main.c:typedef void (*MentDllUnkFunc)(OMOBJ *, void *);" "mpexDll/charsel.c:typedef void (*MpexDllUnkFunc2)(OMOBJ *, void *);" \
           "mpexDll/mpex.c:typedef void (*MpexDllUnkFunc2)(OMOBJ *, void *);" "ztardll/select.c:typedef void (*ZtarUnkFunc)(OMOBJ *, void *);" \
           "mentDll/main.c:void fn_1_81A8(OMOBJ *arg0, void *arg1)" "mpexDll/charsel.c:void fn_1_157C4(OMOBJ *__o, void *__p)" "mpexDll/charsel.c:void fn_1_15D48(OMOBJ *__o, void *__p)" \
           "m435Dll/main.c:objFunc = __recomp_obj_fn_1_B1F4;" "m436Dll/main.c:objFunc = __recomp_obj_fn_1_62C4;" \
           "m435Dll/main.c:static void __recomp_obj_fn_1_B1F4(OMOBJ *o) { fn_1_B1F4(o); }" "m436Dll/main.c:static void __recomp_obj_fn_1_62C4(OMOBJ *o) { fn_1_62C4(o); }" "w05Dll/mg_coin.c:return BoardModelAttrReset(" \
           "w20Dll/main.c:s32 fn_1_4A8(void) { return 0; }" "w03Dll/statue.c:s32 fn_1_2930(void)" "w03Dll/main.c:s32 fn_1_2930(void);" "w20Dll/main.c:s32 fn_1_494(void) { return 0; }" \
           "m418Dll/sequence.c:arg0->unk10 = arg0->unk4[arg0->unk0].unk0;" "m418Dll/main.c:lbl_1_bss_50.unk14(0);"; do
  f="$BUILD/src/REL/${chk%%:*}"; pat="${chk#*:}"
  grep -qF -- "$pat" "$f" 2>/dev/null || { echo "[recomp] FATAL: callback-signature edit did not apply: $chk" >&2; exit 1; }
done
grep -q 'M418DllInFunc unk10;' "$BUILD/include/REL/m418Dll.h" || { echo "[recomp] FATAL: m418Dll.h slot edit did not apply" >&2; exit 1; }
if grep -q '(void \*)fn_1_62C4' "$BUILD/src/REL/m436Dll/main.c"; then echo "[recomp] FATAL: m436 second objFunc site not rewritten" >&2; exit 1; fi
#   * ADJACENCY INDEXING. m449/m458 address a player pair as `(&lbl_1_bss_54)[i]` / `(&lbl_1_bss_BC)[i]`,
#     relying on mwcc placing each bss symbol at the offset in its name, so [1] is lbl_1_bss_58 /
#     lbl_1_bss_C0. clang and wasm-ld do not lay variables out by name: MEASURED, m458 trapped
#     `memory access out of bounds` in fn_1_5014 (`spC[i] = (&lbl_1_bss_BC)[i]->data`) on its first
#     frames, [1] being whatever the linker put after BC. Each pair becomes a real two-element array
#     with the two names as its elements, which is exactly the layout the code assumes.
perl -0pi -e 's/OMOBJ \*lbl_1_bss_C0;\nOMOBJ \*lbl_1_bss_BC;\n/OMOBJ *__recomp_m458_pair_BC[2];\n#define lbl_1_bss_BC (__recomp_m458_pair_BC[0])\n#define lbl_1_bss_C0 (__recomp_m458_pair_BC[1])\n/' "$BUILD/src/REL/m458Dll/main.c" 2>/dev/null || true
perl -0pi -e 's/OMOBJ \*lbl_1_bss_58;\nOMOBJ \*lbl_1_bss_54;\n/OMOBJ *__recomp_m449_pair_54[2];\n#define lbl_1_bss_54 (__recomp_m449_pair_54[0])\n#define lbl_1_bss_58 (__recomp_m449_pair_54[1])\n/' "$BUILD/src/REL/m449Dll/main.c" 2>/dev/null || true
grep -qF '#define lbl_1_bss_C0 (__recomp_m458_pair_BC[1])' "$BUILD/src/REL/m458Dll/main.c" && grep -qF '#define lbl_1_bss_58 (__recomp_m449_pair_54[1])' "$BUILD/src/REL/m449Dll/main.c" ||
  { echo "[recomp] FATAL: m449/m458 player-pair edit did not apply" >&2; exit 1; }
if grep -rqE '\(&lbl_1_(bss|data)_[0-9A-F]+\)\[' "$BUILD"/src/REL/*/*.c "$BUILD"/src/game; then
  for f in $(grep -rlE '\(&lbl_1_(bss|data)_[0-9A-F]+\)\[' "$BUILD"/src/REL/*/*.c "$BUILD"/src/game); do
    for v in $(grep -oE '\(&lbl_1_(bss|data)_[0-9A-F]+\)\[' "$f" | sort -u | sed -E 's/\(&(lbl_1_\w+)\)\[/\1/'); do
      grep -qE "#define $v \(__recomp_" "$f" || { echo "[recomp] FATAL: unhandled adjacency index (&$v)[] in $f" >&2; exit 1; }
    done
  done
fi
#   the compile flags ovl_build.py uses: exactly this script's CFLAGS
mkdir -p "$BUILD/ovl"; printf '%s\n' "${CFLAGS[@]}" > "$BUILD/ovl/cflags.txt"
if EMCC="$(command -v emcc)" LLVM_NM="$(dirname "$(command -v emcc)")/../bin/llvm-nm" \
     python3 "$RECOMP/ovl_build.py" "$BUILD" "$RECOMP" "$RECOMP_OVERLAYS" > "$BUILD/ovl/build.log" 2>&1; then
  cat "$BUILD/ovl/build.log"
else
  cat "$BUILD/ovl/build.log"; echo "[recomp] FATAL: ovl_build.py failed" >&2; exit 1
fi
echo "[recomp] wasm objects: $ok built, $fail failed"
echo "[recomp] object bytes: $(cat "$BUILD"/obj/*.o 2>/dev/null | wc -c)"
# [return-type] The class that made the game silent. Each line is a function whose value the
# caller reads but which never sets one under clang — harmless on mwcc/PPC, garbage here. This
# is a REPORT, not a gate: the build does not fail on it, because every hit below is
# pre-existing game code, not audio, and fixing them is a separate correctness exercise.
if [ -s "$BUILD/returns.txt" ]; then
  echo "[recomp] missing-return defects (-Wreturn-type/-Wreturn-mismatch): $(sort -u "$BUILD/returns.txt" | wc -l | tr -d ' ')"
  sort -u "$BUILD/returns.txt" | sed 's/^/  /'
fi
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
#    SAME TRAP, MEMORY CARD: ___recomp_card_base/_size/_seq/_adopt/_slots/_time must be exported
#    or Binaryen proves gc_card.c's 2 MiB gcc_img image buffer is module-private and strips it,
#    taking every save with it. The host seeds a persisted image into [base, base+size) BEFORE
#    _main() (CARDInit adopts it from inside main) and snapshots it back when _seq() goes quiet.
#    FIBER SWITCH: drop -sSTANDALONE_WASM (emscripten_fiber_swap is JS-runtime Asyncify code,
#    incompatible with a raw-instantiate standalone module — see gc_fiber_coro.c). Emit an ES6
#    module factory (.js glue) + the wasm alongside; recomp_run.mjs loads via the factory and
#    supplies the 126 host-import stubs through instantiateWasm. -sASYNCIFY=1 enables the
#    Binaryen asyncify pass + the fiber runtime. main is in DEFAULT_ASYNCIFY_EXPORTS so it is
#    Promise-wrapped. EXPORTED_FUNCTIONS drives the glue export table (leading underscore).
#    SAME TRAP, AUDIO: ___recomp_audio_pump/_base are only reachable from the HOST (recomp_worker.js
#    pumpAudio calls them from VIWaitForRetrace), so without an export Binaryen proves the whole
#    mixer -> AI ring chain unreachable and strips it, taking the sound with it. Added only under
#    RECOMP_MUSYX, because in the default build those symbols do not exist.
AUDIO_EXPORTS=""
# MusyX's ARAM (shims/src/gc_musyx_aram.c) is a 16 MB static, which pushes the module's own
# static footprint past the default 32 MB INITIAL_MEMORY and fails the link outright with
# `wasm-ld: error: initial memory too small, 40835536 bytes needed`. Raised ONLY under
# RECOMP_MUSYX so the default build's link flags — and therefore its wasm — are untouched.
AUDIO_INITMEM=33554432
if [ -n "${RECOMP_MUSYX:-}" ]; then
  AUDIO_EXPORTS=",___recomp_audio_pump,___recomp_audio_base,___recomp_audio_stat,___recomp_musyx_active_voices,___recomp_musyx_stat,___recomp_audio_selftest,___recomp_msm_bswap_unknowns,___recomp_musyx_aram_stat"
  AUDIO_INITMEM=67108864
fi
# UNDEFINED WEAK FUNCTIONS TRAP. wasm-ld does not warn about a weak reference with no definition
# anywhere; it compiles every call to it into `unreachable`. MEASURED once already (isalpha, see
# the ctype.h fix above), so it is a gate now: name them and stop.
NMBIN="$(dirname "$(command -v emcc)")/../bin/llvm-nm"
if [ -x "$NMBIN" ]; then
  WEAKU="$("$NMBIN" "$BUILD"/obj/*.o $(cat "$BUILD/ovl/link_order.txt" 2>/dev/null) 2>/dev/null | awk '$1=="w"{print $2}' | sort -u)"
  DEFS="$("$NMBIN" --defined-only "$BUILD"/obj/*.o $(cat "$BUILD/ovl/link_order.txt" 2>/dev/null) 2>/dev/null | awk 'NF==3{print $3}' | sort -u)"
  MISSING="$(comm -23 <(printf '%s\n' "$WEAKU") <(printf '%s\n' "$DEFS") | grep -v '^$' | tr '\n' ' ')"
  if [ -n "$MISSING" ]; then
    echo "[recomp] FATAL: weak references with no definition (every call would trap): $MISSING" >&2; exit 1
  fi
fi
# The overlay objects are linked AFTER the DOL objects and IN ovl_build.py's order: each overlay's
# objects sit between its two marker objects, which is what makes its statics one range.
OVL_OBJS=(); if [ -s "$BUILD/ovl/link_order.txt" ]; then while IFS= read -r l; do [ -n "$l" ] && OVL_OBJS+=("$l"); done < "$BUILD/ovl/link_order.txt"; fi
if emcc "$BUILD"/obj/*.o "${OVL_OBJS[@]}" -o "$BUILD/mp4_game.js" -Wl,--Map="$BUILD/mp4_game.map" \
     -sERROR_ON_UNDEFINED_SYMBOLS=0 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2176mb -sINITIAL_MEMORY=$AUDIO_INITMEM \
     -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=32768 ${RECOMP_PROFILING_FUNCS:+--profiling-funcs} \
     -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node,web,worker -sINVOKE_RUN=0 \
     -sEXPORTED_FUNCTIONS=_main,_gx_fifo_base,_gx_fifo_pos,_gx_fifo_reset,_OSSetArenaLo,_OSSetArenaHi,_emscripten_resize_heap,___gc_fiber_stat_fabricate,___gc_fiber_stat_enter,___gc_fiber_stat_swap,___DVDFSInit,___recomp_get_animtree,___recomp_get_bg_animtree,___recomp_get_anim_at,___recomp_get_anim_count,___recomp_set_pad,___recomp_pad_witness,___recomp_set_inject_btn,___recomp_set_inject_dstk,___recomp_set_inject_stkx,___recomp_set_inject_stky,_HuMemHeapPtrGet,___recomp_dirty_base,___recomp_dirty_count,___recomp_dirty_overflow,___recomp_dirty_reset,___recomp_autoboard_arm,___recomp_autotest_set,___recomp_aram_base,___recomp_static_top,___recomp_card_base,___recomp_card_size,___recomp_card_seq,___recomp_card_adopt,___recomp_card_slots,___recomp_card_time"$AUDIO_EXPORTS" \
     -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8,HEAP32,HEAPU32,wasmMemory,wasmExports \
     -Wl,--no-entry -Wl,--no-gc-sections -Wl,--allow-undefined -Wl,--allow-multiple-definition -O2 2>"$BUILD/link.txt"; then
  echo "[recomp] LINKED: $BUILD/mp4_game.js + $BUILD/mp4_game.wasm ($(wc -c < "$BUILD/mp4_game.wasm" | tr -d " ") bytes)"
  echo "[recomp] file: $(file "$BUILD/mp4_game.wasm" 2>/dev/null | sed 's|.*: ||')"
  echo "[recomp] asyncify present: $(grep -c -a 'asyncify' "$BUILD/mp4_game.wasm" 2>/dev/null) | fiber_swap import: $(wasm-objdump -j Import -x "$BUILD/mp4_game.wasm" 2>/dev/null | grep -c emscripten_fiber_swap)"
  echo "[recomp] wasm signature mismatches: $(grep -c 'signature mismatch' "$BUILD/link.txt")"
  if [ -s "$BUILD/ovl/link_order.txt" ]; then
    python3 "$RECOMP/ovl_build.py" --verify-map "$BUILD/mp4_game.map" || { echo "[recomp] FATAL: overlay static ranges are not contiguous in the link" >&2; exit 1; }
  fi
else
  echo "[recomp] link errors (top):"; grep -m8 -iE "error|duplicate|undefined" "$BUILD/link.txt" | sed -E "s/'[^']*'/X/g" | sort -u | head -8
  exit 1
fi

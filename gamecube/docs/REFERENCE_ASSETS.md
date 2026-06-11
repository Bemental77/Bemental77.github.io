# GameCube reference-asset inventory

> Produced 2026-06-10 by a 6-agent verified sweep (every claim below was checked on disk that day — paths, sizes, line counts, git SHAs; the Dolphin oracle was live-verified with a ~9s MP4 boot). STATUS.md "Reference assets" stays the lean per-wedge view; this file is the full shelf. Re-verify counts before citing — they drift (the 7607-vs-7721 symbols.txt lesson).

## The one fragile thing (read first)

**`~/gc_refs/dolphin-upstream` (eb44b64) carries the native-oracle `[axei-trace]` instrumentation as an UNCOMMITTED working-tree diff** (+80/−1 across `Source/Core/Core/HW/DSP.cpp`, `ProcessorInterface.cpp`, `SystemTimers.cpp`, `PowerPC/Interpreter/Interpreter.cpp`, `PowerPC/PowerPC.cpp`). It produced `dolphin.log.pre_native_mp4_boot`. A checkout/clean there silently destroys it. **Preserved copy: `gamecube/docs/native-oracle-complete-dump/axei-trace-instrumentation.patch` (156 lines).**
Naming inversion: `~/gc_refs/dolphin` is the PRISTINE newer clone (e22551e, clean); `dolphin-upstream` is the PATCHED oracle.
**Instrumented binary REBUILT 2026-06-10**: `~/gc_refs/dolphin-upstream/build-oracle/Binaries/dolphin-emu-nogui` (18.3MB). Smoke-verified: 10s headless MP4 boot wrote 7,985 `[axei-trace]` lines (`PI::SetInterrupt n=... mask=... set=... new_cause=... mask_reg=...`). The stock `/Applications/Dolphin.app` (Mar-17 binary) emits ZERO axei-trace lines — use build-oracle for instrumented captures, the app for stock-behavior runs. Build recipe (AppleClang 12 is too old): `CC=/usr/local/opt/llvm/bin/clang CXX=.../clang++ cmake -B build-oracle -DCMAKE_BUILD_TYPE=Release -DENABLE_NOGUI=ON -DENABLE_QT=OFF` **plus ar/ranlib pinned to `/usr/bin/{ar,ranlib}` for ALL of C/CXX/OBJC/OBJCXX as :FILEPATH at first configure** — brew's `llvm-ranlib` rejects `-no_warning_for_no_symbols`, and the OBJCXX entries silently keep llvm paths if overridden after the initial configure. Target name is `dolphin-nogui`; binary lands as `dolphin-emu-nogui`.

## MP4 decomp — ~/gc_refs/marioparty4 (932M, clean @ 814c28a)

- 6 region configs: GMPE01_00/01 (USA), GMPJ01_00 (JP), GMPP01_00/01/02 (PAL). **Only GMPE01_01 is fully actionable** (orig ROM + build dir + split asm); GMPE01_00 has config/symbols but no ROM, no splits.
- `config/GMPE01_01/symbols.txt`: **7721 lines** (7644 unique names, 3469 functions), format `Name = .section:0xADDR;`. (STATUS.md previously said 7607 — wrong for this checkout.)
- **Retail-binary oracle already extracted**: `orig/GMPE01_01/sys/main.dol` (1,319,008 B, md5 8bf9b315…) + **99 retail .rel DLLs** under `orig/GMPE01_01/files/dll/`. Combined with `build/binutils/powerpc-eabi-objdump` (vendored, with dtk + objdiff-cli + MetroWerks compilers under `build/`) this is a complete offline disassembler for any symbols.txt PC — no emulator needed.
- **Build COMPLETE (2026-06-10)**: `ninja` finished after installing wine — `Modules: 100.00% matched, 100.00% linked (327/327 files); Code: 4780604/4780604 bytes (7515/7515 functions)`. `build/GMPE01_01/main.dol` is **byte-identical to retail** (cmp-verified vs `orig/GMPE01_01/sys/main.dol`) and `build/GMPE01_01/main.elf` (2.18MB) is an unstripped PowerPC ELF — full-symbol oracle for any MP4 PC via objdump/addr2line. No separate linker .map was emitted (the ELF serves that role). Wine for the MWCC toolchain: `~/Applications/Wine Devel.app/Contents/Resources/wine/bin` (Gcenx wine-devel 11.10 osx64 tarball, user-extracted — brew casks need sudo/were removed upstream; dequarantined via user xattr).
- `extern/musyx/` — **INITIALIZED 2026-06-10** (`git submodule update --init` → AxioDL/musyx @ a170f2ef; CMakeLists/include/src/test present). MP4's revision-matched MusyX source is now local — the hottest wedge path (musy≈25M dispatches/60s) has real source. Also: 31 revision-exact split `.s` under `build/GMPE01_01/asm/musyx/` and the ttyd proxy.
- `src/dolphin/` is MP4's **own vendored SDK source** (os, dsp, exi, si, thp, …) — matches the guest binary's actual SDK build; outranks generic dolsdk2001 for byte-level questions.
- orig ISO: `orig/GMPE01_01/MarioParty4.iso`, 598,382,592 B, header GMPE01 rev 01, first-1MB md5 19543615… (same image class as the repo split parts).

## SDK sources (ranked for guest-OS questions)

1. `~/gc_refs/marioparty4/src/dolphin/` — MP4's in-tree SDK copy (revision-matched to the wedge target).
2. `~/gc_refs/dolsdk2001` (2.8M, eb1234c) — broad OS/DSP/AI/AX/GX/VI/DVD/card/pad source. **CAVEAT: NO `src/exi` and NO `src/si`** (headers only) — SI/EXI questions (e.g. `SIInterruptHandler` 0x800D9040) come up empty here.
3. `~/gc_refs/ttyd/libs/dolsdk2004` — the only local SDK src for **EXI/SI/THP/axart**.
4. `~/gc_refs/libogc` (6.7M, c70bdf2 2026-05-02) — independent reimplementation; its latest commit fixes `__GXCPInterruptHandler` spurious CP IRQs — directly relevant to the SelectThread/PE_FINISH hedge.
5. `~/Downloads/GameCubeSDK/` — **1.2G, 5 rars ALL already extracted in place**, plus two byte-identical 681MB zip copies. The official Nintendo headers WERE unshield-extracted to `/tmp/gcsdk/` (volatile — currently gone after a /tmp clear); re-extraction commands live in memory `gamecube_sdk.md` (`unshield -d /tmp/gcsdk/uber x .../GCN_UberInstaller_v14/data1.hdr`, then the nested GCN_SDK_20-Apr-2004 hdr). **Proprietary — never commit SDK contents to the repo.** Unextracted second-level archives: PC_GCN_Emu_e28, GCN_CP_v10, NetworkSDK, SocketLibrary, JPEG_Patch1.
   - **Bootable minimal demos** inside: `[DNDD01] Nintendo Developer Demo.gcm` (NDDEMO) and Dodger Demo `.gcm/.dol/.elf` — far smaller boot targets than MP4 for minimal-boot differentials.

## ROMs + IPL

| Asset | Identity | Notes |
|---|---|---|
| `gamecube/roms/MarioParty4.bin.parta{a..f}` | GMPE01 rev 01 | **NKit-TRIMMED image** (598,382,592 B; `NKIT v01` stamp at offset 0x200) vs full 1,459,978,240 B disc. Stays the web-deployable form. |
| `~/Downloads/Mario Party 4 (USA).iso` | GMPE01 rev 01 | **FULL CLEAN DUMP, acquired 2026-06-10** (1,459,978,240 B, zeros at 0x200, junk data past trim boundary). DOL region md5 `8bf9b315…` identical to trimmed image AND retail main.dol; 100MB spot-check differs from trimmed (consistent with NKit junk regeneration — per-file comparison not done). **Use THIS for native-oracle runs needing faithful DVD reads**; closes the untrimmed-dump conditional. |
| `gamecube/roms/SonicAdventure2Battle.bin.parta{a..q}` | GSNE8P | 17 parts, full-size |
| `gamecube/roms/PhantasyStarOnline1And2Plus.bin.parta{a..q}` | GPOE8P **rev 02** | 17 parts; confirm gpoe8p.map matches Rev 2 before trusting it |
| `gamecube/roms/240pSuite-1.10b.dol` | homebrew | |
| `gamecube/roms/Sonic Adventure 2 - Battle (USA).iso` | GSNE8P | raw 1.36GB working-tree copy (real file here, LFS pointer on plain checkouts); unused by the page |
| **`gamecube/IPL.bin`** | 2,097,152 B, LFS | Load-bearing twice: embedded into wasm FS at link (`dolphin_worker_link.sh:108`) AND runtime-fetched by `worker_funcs.js:125-152`. The embed re-bakes ONLY on relink — a stale embedded copy can mask edits. |

- **ROM_IDX mapping** (gamecube.html:162-165): `0`=MP4, `1`=SA2B, `2`=PSO, `3`=240pSuite. Reassembly: MP4 = parts a..f; SA2B/PSO = a..q (don't reuse the {a..f} command).
- **Native oracle has NO IPL.bin** (Dolphin user dir region folders empty) → native HLE-boots while WASM has a real 2MB IPL — native-vs-wasm boot diffs can legitimately diverge at IPL/BS2 stage. (`Dolphin.ini` SkipIPL not checked.)
- `~/gc_refs/gc-ipl` cannot build an ipl.bin on this machine (Windows CodeWarrior flow); only prebuilt piece is `Bootstrap/bs.bin` (2,048 B = first 0x800 of bootrom). IPL-range PCs (0x8130xxxx) have no single greppable map — gc-ipl stores per-address note files.

## Symbol maps + signatures

| Map | Game | Size | Notes |
|---|---|---|---|
| `~/gc_refs/marioparty4/config/GMPE01_01/symbols.txt` | MP4 USA r1 | 7721 lines | THE MP4 resolver; sibling files for GMPE01_00/GMPJ01_00/GMPP01_00 (7551–7781 lines) enable cross-region diffing |
| `dolphin_captures/sab.map` | SAB | 5102 lines | byte-identical to Dolphin `Maps/GSNE8P.map` (provenance confirmed) |
| `dolphin_captures/pso.map` | PSO | 27719 lines | Dolphin `Maps/GPOE8P.map` is a LATER re-save (27795 lines) — vendored copy slightly stale |
| `tools/gsne8p.map`, `tools/gpoe8p.map` | SAB / PSO | 258 / 72 syms | tiny partials, not the full maps |
| `tools/master_sigs.json` | SDK sigs | 1475 entries | top-level `{"signatures": [...]}` wrapper — not a bare array |
| `~/gc_refs/decomp-toolkit/assets/signatures` | SDK sigs | 140 .yml | |

- **GMPE01.map GENERATED 2026-06-10** at `~/Library/Application Support/Dolphin/Maps/GMPE01.map` (3558 text + 4136 data symbols) via `gamecube/tools/symbols_to_dolphin_map.py` from the decomp symbols.txt — native Dolphin logs/GDB now symbolize MP4, and `dolphin_profile.py` works with gameid GMPE01 unmodified (it reads `Maps/{gameid}.map`; verified spot-check: `__OSDispatchInterrupt=800b7714`, `SelectThread=800ba1b8`, `__DSPHandler=800c7558` match STATUS.md's IRQ chain).
- ttyd has 32 per-area symbols.txt under `config/G8MJ01/<area>/` — may resolve MusyX PCs the main map doesn't.

## Native Dolphin oracle

- App: Dolphin **2603a** (build 2603.1). **Live-verified 2026-06-10**: `-b -e /tmp/MarioParty4.iso` boots MP4 in ~9s, writes dolphin.log (OSREPORT_HLE apploader line 67, "Dolphin OS $Revision: 54" line 101); `pkill -9 -f Dolphin` exits clean. Note: 9s @ Verbosity=5/31 channels = only ~24KB of log — the 18MB `dolphin.log.preserved` came from a much longer/instrumented run; its line numbers (e.g. 62784) are NOT reproducible from a short fresh run.
- `Logger.ini`: **31 channels enabled** (STATUS.md previously listed 11) incl. OSHLE, DVDInterface, Memmap, BOOT, FILEMON, CP, DSPINTERFACE, DSPMails, PE, SI, VI, MI, EXI.
- Logs dir holds **26 snapshots** (not 2): beyond `preserved` (18MB) and `pre_native_mp4_boot` (6.5MB), notably `pre-exc` (3.4MB Jun 1), `bak_pre_native_mp4_vi` (2.9MB Jun 7), `bak_pre_jit64_capture`, `bak_mp4probe`. No plain `dolphin.log` existed before the verification run — everything had been renamed to snapshots.
- GDB toolchain (previously undocumented in STATUS): drivers `gamecube/tools/gdb_{memdump,regs_at_pc,watch_oscm,mmio_full_watch,dump_mem}.py`; launchers repo-root `native_dump.sh` + `dolphin_profile.py`, `gamecube/tools/native_mmio_full_watch.sh`. **Port defaults are inconsistent**: 24689 (gdb_dump_mem, gdb_regs_at_pc, gdb_watch_oscm) vs 9090 (gdb_memdump, native_dump.sh, dolphin_profile.py) vs 9091 (gdb_mmio_full_watch) — wrong pairing hangs on connect. GDB stub is launch-flag-only (no Dolphin.ini persistence).
- **MISSING capability**: `gamecube/dolphin-src/build-native-dbg/` (cited by `docs/native-oracle-complete-dump/TASKS.md:9` for dense [traj] captures) does not exist — only build-wasm/ is present. Dense PC-trajectory capture requires rebuilding it.

## Other shelves in ~/gc_refs (4.4G total; ~half is non-GC)

- Game decomps: melee (32M), pikmin (48M), pikmin2 (202M), sadx (210M), tp (286M), tww (75M), kar (79M), ttyd (16M) — SDK call-pattern corpus.
- Decomp/RE tooling: decomp-toolkit v1.8.3, dtk-template(+build), objdiff v3.7.1, nod (GCM/ISO lib), GCFT, ppcd + powerpc-rs (PPC disassemblers), Ghidra GameCube loader + gekko-broadway language (paired-singles encodings).
- Test/conformance: **hwtests** (f28077b — rlw/srawix/fctiw/pairedmove C reference models; Task-2 seed) and **DolphinPPCTests** (d5b7691 — oracle at `binary/instruction_tests_console.txt`; known `"r"`-constraint immediate artifact, see STATUS.md Task 2).
- WASM/JIT prior art: binaryen, wasm-tools, spec, wasm-jit, waforth, winliner, v8-helpers/v8-refs, N64Recomp + N64ModernRuntime + Zelda64Recomp + Dk64-Recompiled.
- Graphics/audio: aurora, noclip.website, J3D-Model-Viewer, audiogc.

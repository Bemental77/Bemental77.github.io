# Native oracle: complete-dump checklist

**Goal.** Enumerate every observable dimension of native Dolphin's execution that a comprehensive native-vs-wasm differential needs, name the capture mechanism for each, distinguish artifacts we already have on disk from artifacts that don't exist yet, and record the exact command/tool that produces each. Replaces the prior pattern of treating a narrow watchpoint capture as "the entire dump" — see [[feedback_partial_called_entire_2026_05_27]].

**Working hypothesis.** A complete native dump covers six dimensions: (1) CPU per-block PC trajectory, (2) CPU register state at chosen checkpoints, (3) MMIO/IRQ access stream with PC context, (4) main memory state at checkpoints, (5) device subsystem events (DSP, VI, DI, AI, EXI, GP/CP/PE), (6) OS-level events (HLE, OSReport, symbols). Kill criterion: when every row below is `HAVE`, we can diff native vs wasm on any of these dimensions at any checkpoint without launching a new capture.

**Caveats.**
- "Verbosity = 5" is `LDEBUG` per `gamecube/dolphin-src/Source/Core/Common/Logging/Log.h:85`, the maximum effective level (`MAX_EFFECTIVE_LOGLEVEL = LDEBUG`, Log.h:89). Flipping `[Logs]` flags does not synthesize log calls that aren't in the source — many channels are sparse because Dolphin's code doesn't emit per-access logs.
- The user's running `Dolphin 2603a` (per screenshot title bar) is `/Applications/Dolphin.app`, a prebuilt without the project's `[traj]` hook. The dense PC-trajectory artifact `/tmp/dolphin-traj-raw.log` was produced by the custom build at `gamecube/dolphin-src/build-native-dbg/Binaries/dolphin-emu-nogui`. Any new dense capture must use the custom build, not the prebuilt.
- `feedback_no_dolphin_patching` forbids patching `dolphin-src` to fix wasm bugs; observation-only hooks have precedent (`Jit.cpp:460` `[traj]`). Rows below that propose new observation hooks are flagged `PATCH:` and need explicit go-ahead before landing.

---

## Checklist

| # | Dimension | Capture mechanism | Existing artifact | Status | Command / how to produce |
|---|---|---|---|---|---|
| 1 | **Per-block PC trajectory** (dense) | `[traj]` `NOTICE_LOG_FMT(POWERPC, ...)` at `gamecube/dolphin-src/Source/Core/Core/PowerPC/Jit64/Jit.cpp:460` | `/tmp/native-traj-mmio.log` 5,992,124 [traj] lines (also has [mmio]); per-region histogram in `/tmp/native-traj-histogram.txt` (BS2-stub 736k / apploader-loaded 5.26M / OS sub-band 1.06M / vectors 536 / hottest single PC = 0x800053c0 at 732,355) | **HAVE** | already captured this session |
| 2 | **CPU register state at boundaries** | GDB-RSP `p<n>` over Dolphin stub | `/tmp/native-si-path.log` (600-step SITransfer); `/tmp/native-osexc-362c.log` (140-step OSExc); + new `/tmp/native-sitransfer-step.log`, `/tmp/native-msr_leaf-step.log`, `/tmp/native-pi_widen-step.log` (200 samples each, via new `gdb_{sitransfer,msr_leaf,pi_widen}_step.py`) | **HAVE** (SI + OSExc + SITransfer + MSR-EE leaf + PI-widen) | scripts under `gamecube/tools/native_{sitransfer,msr_leaf,pi_widen}_sab.sh` |
| 3a | **MMIO access stream — watchpoint sweep** | GDB-RSP `Z2`/`Z3` watchpoints map to MemChecks (unlimited count, perf-bound only, `MMU.cpp:729` + `GDBStub.cpp:872-901`) | `/tmp/native-mmio-full-watch.log` from 205-cell × r/w = 410-watchpoint sweep (`gamecube/tools/gdb_mmio_full_watch.py`, `native-mmio-full-watch.sh`); 20 hits captured in idle boot window with natural-exit message verified | **HAVE** (tooling); 20 hits this window — re-run with controller-arming for richer trace | `PYTHONUNBUFFERED=1 bash gamecube/tools/native-mmio-full-watch.sh <NHITS>` |
| 3b | **MMIO access stream — full dispatch coverage** | `NOTICE_LOG_FMT(MEMMAP, "[mmio-r/w] addr=… val=… pc=…")` hook installed at `gamecube/dolphin-src/Source/Core/Core/HW/MMIO.h:143-167` (mirrors `[traj]` precedent) | `/tmp/native-traj-mmio.log` 4,210 `[mmio-r]` + 3,322 `[mmio-w]` lines; per-subsystem histogram `/tmp/native-mmio-histogram.txt` (EXI 58.8% / DSP 19.8% / DI 12.2% / PI 3.6% / SI 2.4% / VI 2.1% / others <1%) | **HAVE** | already done; rerun = `build_and_probe.sh` equivalent on custom build |
| 3c | **PI interrupt-cause history + native-vs-wasm diff** | Subset extraction from 3b | `/tmp/pi-cause-native-vs-wasm.txt` — native widens mask `0xf0→0xf8→0xfc→0x1fc→0x9fc→0xbfc→0xffc` at PC=0x800e7c68 (`SetInterruptMask`); native cause clears via device callback in `SerialInterfaceManager::UpdateInterrupts` (SI.cpp:101-127) triggered by guest writing SI_COMCSR; wasm stuck at mask=0xf8, never reaches the SI_COMCSR write site → cause never deasserts | **HAVE** | — |
| 4a | **Post-boot gameplay reference (full machine state)** | Dolphin savestate `.s01`. Contains complete machine state at one instant: full MEM1, L1 cache, all MMIO, DSP, VI, PE, JIT cache, audio | `~/Library/Application Support/Dolphin/StateSaves/GSNE8P.s01` (14.7 MB, captured 2026-05-27 21:56, in-game @ City Escape stage 1, slot 1) | **HAVE** | (captured by user via Emulation → Save State → Save to Slot 1) |
| 4b | **RAM range dumps (text section, OS context, stack)** | GDB `m<addr>,<size>` (RAM-OK; rejects MMIO per `GDBStub.cpp:828-829`) | `/tmp/native-mem1-vectors.bin` (12,800 B), `/tmp/native-mem1-bs2.bin` (8,960 B), `/tmp/native-mem1-os.bin` (65,536 B), `/tmp/native-mem1-stack.bin` (131,072 B); halt PC = 0x8012340c (past OSInit, in SAB main runtime); 0x80000500 cross-references `external_interrupt_exception_handler` in merged map; decoded as canonical SAB OS-context-save prologue | **HAVE** | — |
| 4c | **Main memory write stream (every store, dense)** | NEW observation hook in `MMU.cpp WriteToHardware` RAM path | none | **MISSING — PATCH** | proposed: same pattern as 3b but on the RAM write side; volume risk (every guest store) — gate behind a build flag like `DOLPHIN_TRACE_MEMWRITES` |
| 5a | **DSP HLE events** (ucode load, mailbox traffic) | `DSPHLE` + `DSPMails` + `DSP` channels | `/tmp/native-dsp-events.log` 218 lines (22 I[DSPHLE] + 175 D[DSPMails] + 21 D[DSP]). Mail histogram: 40× AX `0xdcd10002`/`0xcdd10003`/`0xbabe0180` round-trips + boot mails `0x8071feed`/`0x80544348`. **GAP NAMED**: HLE_DSPMailUnblock, HLE_DSPResetUnblock, HLE_DSPARModeUnblock, HLE_AIBufferUnblock are implemented in `HLE_OS.cpp` but their installer at `JitWasm.cpp:3227-3232` is **COMMENTED OUT** ("SAB-specific patches DISABLED — unsafe for other games"); symbol-DB path doesn't match because SAB `.map` has no `HLEDSPMailUnblock` symbol name | **HAVE + ROOT CAUSE NAMED** | — |
| 5b | **VI events** | `VI` channel | `/tmp/native-fullch.log` 50 D[VI] entries (after full enable in `/tmp/dolphin-agent-B1/`) | **HAVE** | — |
| 5c | **DI/DVD reads** | `BOOT` `DVDRead:` + `DVDINTERFACE` channel + DI MMIO range | `/tmp/native-dvd-events.log` 936 lines (13 BS2 DVDRead + 3 post-BS2 `I[DVD] Read:` + 882× DI cover-status poll + 38 other DI MMIO). Post-apploader reads: offset `0x3d976928` len 1984, `0x3d9770e8` len 3328, `0x4701db10` len 524288 | **HAVE** | — |
| 5d | **AI/Audio events** (cubeb-filtered) | `AI`+`Audio` channels, drop cubeb | `/tmp/native-ai-events.log` 27 lines (9 real AI/Audio events + 13 AI-MMIO hits at `0xCC006C00..0c`). AICR transitions: `0x42 → 0x62 (SCRESET) → 0x46 (AIINTMSK=1)`. **GAP**: bridge's `EmscriptenWorker.cpp:230` explicitly skips AI event-type re-arming (`CT_PEND_AI` deferred — "AudioInterface holds its own event type pointer; cross-module access deferred") | **HAVE + GAP NAMED** | — |
| 5e | **EXI events** | `EXI` channel | `/tmp/native-fullch.log` 945 D[EXI] + 5 I[EXI]; per-cell hottest = `0x0c006800`/`0x0c00680c` (882+881 reads from `OSSetErrorHandler`) | **HAVE** | — |
| 5f | **GP/CP/PE events** | `GP`/`CP`/`PE` channels | `/tmp/native-fullch.log` 6 D[CP] + 1 D[PE]; sparse because `-v Null` headless skipped graphics. MMIO histogram from 3b: CP 23 writes, PE 14 ops, VI 157 ops via `__GXFifoInit`/`__GXPEInit` | **HAVE (sparse — Null video)** | for richer GP/CP/PE traffic re-run with real video backend |
| 5g | **Exception/vector entries** | `[traj]` PC bucketing at vectors | `/tmp/native-exception-vectors.txt`: **0x500=129 (over 43s, paired with 0x588=129 handler-body — handler PROGRESSES)**; 0xC00=228 (syscalls), 0x800=25 (FP-unavail), all wedge-class vectors (0x100/0x200/0x300/0x400/0x000) = **0**. Wasm shows 100× at 0x500 frozen at `srr0=0x800e78f0 srr1=0x30 cause=0x10108` — native NEVER has this frozen state. **JIT exonerated again; 0x400 wedge hypothesis refuted** | **HAVE** | — |
| 6a | **OS reports** | `OSREPORT` + `OSREPORT_HLE` | `/tmp/native-osreport.log` 175 unique events merged across 3 sources. Native consistently reaches: kernel banner `Dolphin OS Rev 47` → arena `0x803c1460-0x817ede20` → `app booted from bootrom` → DSP IRAM/DRAM upload → AX SDLIB alloc → game-side OSReports → `play movie [op360jp.m1v]` (FMV opens, well past any wasm blocker) | **HAVE** | — |
| 6b | **HLE patch invocations** | `HLE` channel + repo source diff | `/tmp/native-hle-patches.log` 356 lines. Native installs: PPCMfhid2 (×3 sites), strncpy, OSReport, ___blank (×2) — all symbol-DB driven. Full 56-entry HLE registry enumerated. **DIVERGENCE**: native has 86 OSREPORT_HLE fires (debug mode); wasm `JitWasm.cpp` 15 address-based `HLE::Patch` calls, several KEY DSP/AI ones **commented out**. `DVDConvertPathToEntrynum` reverted 2026-05-19 | **HAVE + GAP NAMED** | — |
| 6c | **Symbol → PC mapping** | `.map` files merged | `/tmp/sab_merged.map` 5,101 unique symbols (254 both, 4 gsne8p-only, 4,843 sab-only); `/tmp/sab_lookup.txt` resolves 8 critical PCs. Confirmed: 0x800e7c68 lives inside **`SetInterruptMask`** (not a separate fn); 0x800e7970 inside **`__OSInterruptInit`**; 0x800eb058=`SITransfer`, 0x800eaa20=`__SITransfer`, 0x800e362c=`OSInit` | **HAVE** | — |
| 6d | **Symbol size mismatches** | `SYMBOLS` channel | `/tmp/native-symbol-mismatches.txt` 277 warnings, all Y=4 (single-instruction branch trampolines). 16× (152,4) = exception-vector stubs (expected pattern, benign). Per `PPCSymbolDB.cpp:97-101` the warning is informational; symbol resolution unaffected. **NOT a real OS-image problem** | **HAVE — BENIGN** | — |
| 7a | **JIT block catalog** | `JitInterface::JitBlockLogDump(guard, FILE*)` at `JitInterface.cpp:134-199` exists in libcore, writes TSV. Currently only invoked from `MenuBar.cpp:215-228` (GUI). Headless CLI sketched | none captured yet | **TOOLING AVAILABLE — needs CLI wrapper** | sketch in `/tmp/gated-rows-investigation.md`; would link libcore, call `JitBlockLogDump` after `Core::CPUThreadGuard{system}` |
| 7b | **PPC Instruction Coverage** | **GUI-only**. `JITWidget.cpp:610` label; `DisassembleCodeBuffer` is file-static, no non-GUI callers. No CLI export | none | **BLOCKED (Qt-only)** | (cited in `/tmp/gated-rows-investigation.md`) |
| 8a | **Frame dumps** | `FRAMEDUMP` channel + video backend | `/tmp/dolphin-agent-B1/Dump/Frames/` empty after full-channel run; needs real video backend (not `-v Null`) | **REQUIRES non-Null video** | re-run with metal/gl backend |
| 8b | **Screenshot** | GUI toolbar `ScrShot` | none captured | **GUI-only** | user-driven |
| 9 | **CodeTrace per-instruction** | **GUI-only, no headless path**. `CodeTrace::AutoStepping` (`CodeTrace.cpp:142-223`) only called from `CodeViewWidget.cpp:697,708` / `RegisterWidget.cpp:290,303` (Qt slots). GDB stub `HandleQuery` (`GDBStub.cpp:325-345`) does NOT implement `qRcmd`/`monitor`, so `monitor codetrace` returns empty | none | **BLOCKED (Qt-only + no GDB qRcmd)** | (cited in `/tmp/gated-rows-investigation.md`) |

---

## Quick-wins — ALL DONE (2026-05-27)

1. ~~Capture SAB savestate~~ — user did it; dissector extracted PowerPCState (PC=0x801012B4, MSR=0x0000B032, full GPRs/SPRs), MEM1 32 MB, L1 cache 256 KB, fake_vmem 32 MB. Partial: HW subsystems (16 MB) captured as one opaque blob — per-subsystem decode needs porting each subsystem's `DoState` walker.
2. ~~Toggle Logger.ini channels~~ — done in `/tmp/dolphin-agent-B1/`, 447 MB log produced with 56 channels enabled.
3. ~~Re-run `native_si_watch.sh` foreground~~ — superseded by the broader `gdb_mmio_full_watch.py` (410 watchpoints) and the `[mmio]` hook (full dispatch coverage), both done.

## Division of labor (resolved 2026-05-27)

- **User:** row 4a — make a SAB savestate at first level of gameplay; lands in `~/Library/Application Support/Dolphin/StateSaves/GSNE8P.s01`.
- **Logging side (me):** boot trajectory + every per-PC capture point covered by rows 1 (`[traj]` already present) + 3b (`[mmio]` hook, approved). Boot-time savestates not needed — `[traj]+[mmio]` log gives a denser, time-ordered trace than a series of state snapshots would.

## Still gated (need explicit user go-ahead)

- Row 4c (RAM write stream hook) — same dolphin-src patch pattern as 3b; gate behind a build flag; per-store volume risk significant.

## What this plan deliberately does NOT do

- Does not propose adding new Dolphin Log channels (e.g. a custom "MMIO" channel). Reuses existing channels (`MEMMAP`, `POWERPC`, etc.).
- Does not propose patching `dolphin-src` for wasm-side bug fixes (per `feedback_no_dolphin_patching`); only proposes observation hooks where the `[traj]` precedent applies.
- Does not run new captures speculatively. Quick-wins #1 and #2 are user actions in the running Dolphin (GUI) or one config edit; #3 is a script the user can launch.
- Does not redefine "the entire dump" as the next narrow capture I'm about to run.

## References

- `gamecube/docs/README.md` — topic-doc convention + oracle inventory table
- `gamecube/dolphin-src/Source/Core/Common/Logging/Log.h:85` — LDEBUG=5 (MAX_EFFECTIVE_LOGLEVEL)
- `gamecube/dolphin-src/Source/Core/Common/Logging/LogManager.cpp:101-157` — channel name registration
- `gamecube/dolphin-src/Source/Core/Core/PowerPC/Jit64/Jit.cpp:454-460` — `[traj]` observation hook (precedent for new hooks)
- `gamecube/dolphin-src/Source/Core/Core/PowerPC/GDBStub.cpp:828-829` — `m` packet rejects non-RAM (so MMIO must use watchpoints, not `m`)
- `gamecube/dolphin-src/Source/Core/Core/PowerPC/MMU.cpp:727-730` — Memcheck-before-WriteToHardware (proves `Z2`/`Z3` fire on MMIO accesses)
- `gamecube/tools/native_si_watch.sh` + `gamecube/tools/gdb_si_watch.py` — existing watchpoint capture
- `/tmp/dolphin-traj-raw.log` 294 MB — the existing native PC-trajectory dump
- `~/Library/Application Support/Dolphin/StateSaves/` — savestate location (no `GSNE8P.s01` yet)
- `[[gamecube_si_interrupt_storm_2026_05_27]]` — the blocker this dump is meant to ground-truth
- `[[gamecube_goal_and_ground_truth_oracles]]` — overall oracle inventory
- `[[feedback_partial_called_entire_2026_05_27]]` — pattern that produced this checklist

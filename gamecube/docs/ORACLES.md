# GameCube oracle inventory — DEFAULT FIRST ACTION

> Every path below was verified present on disk 2026-07-11. Re-verify counts/SHAs before citing — they drift.
>
> **The rule (per `feedback_native_dolphin_dualcore_first_resource_2026_07_11`): for ANY GameCube / dual-core unknown, run local native Dolphin in DUAL-CORE and read the answer off the oracle BEFORE any hypothesis, instrumentation, or fix.** The WASM build is the patient, never the reference. Skipping this has burned whole sessions ≥8 times.

## For ANY unknown, do THIS first

1. **Boot native Dolphin dual-core on the same ISO** and observe (≤10s; init completes in 1–2s):

   ```bash
   /Applications/Dolphin.app/Contents/MacOS/Dolphin \
     -C Dolphin.Core.CPUThread=True \
     -C Dolphin.Core.CPUCore=1 \
     -e "/Users/caseybement/Downloads/Mario Party 4 (USA).iso"
   ```

   - `CPUThread=True` = dual-core (this is THE product; single-core is only the reference bar).
   - `CPUCore=1` = the JIT core.
   - Do NOT pass `-d` unless you are attaching a GDB stub (`-d` runs the GDB stub server and blocks on connect).
   - Quit with `pkill -9 -f Dolphin` — a plain `kill` hangs on Dolphin's quit dialog (`feedback_dolphin_quit_workflow`).
   - The stock `/Applications/Dolphin.app` binary (Mar-17) emits stock behavior with **zero** `[axei-trace]` lines.

2. **Need a GDB bridge / MMIO watchpoints?** Copy the pattern already scripted in
   `gamecube/tools/native_mmio_full_watch.sh` (launches its own Dolphin on port 9091 with
   `-d -C Dolphin.General.GDBPort=9091 -C Dolphin.Core.CPUCore=1 -e <ISO>`, then drives
   `gamecube/tools/gdb_mmio_full_watch.py`). NOTE: that script omits `CPUThread=True` — add it for a
   true dual-core capture. Ports seen in-tree: 9091 (mmio watch), 9090, 24689 — pick a free one and
   pass it as `Dolphin.General.GDBPort`.

3. **Need instrumented native output (`[axei-trace]` PI/DSP/timer lines)?** Use the pre-built
   instrumented binary, NOT the .app:

   ```bash
   ~/gc_refs/dolphin-upstream/build-oracle/Binaries/dolphin-emu-nogui \
     -C Dolphin.Core.CPUThread=True -C Dolphin.Core.CPUCore=1 -e <ISO>
   ```

   The instrumentation is an UNCOMMITTED working-tree diff in `~/gc_refs/dolphin-upstream`
   (patched clone; `~/gc_refs/dolphin` is the pristine one). A `git checkout/clean` there destroys it —
   preserved copy: `gamecube/docs/native-oracle-complete-dump/axei-trace-instrumentation.patch`.

4. **Only if native can't answer** (rare — exhaust GDB/MMIO/watchpoints/logs/instrumented build first,
   per `feedback_dont_assert_oracle_cant_without_exhausting_dolphin`), consult the decomp/SDK shelf below.

## Test ISOs and ROM identity

`ROM_IDX` indexes the live `gamecube.html` ROMS[] (verified 2026-06-14):
**0 = Mario Party 4, 1 = Sonic Adventure 2 Battle, 2 = PSO, 3 = 240pSuite.** (`ROM_IDX=1` loads SAB, not PSO.)

| Game | Full raw ISO | Split parts (GitHub-Pages form) | Trimmed decomp ISO |
|---|---|---|---|
| Mario Party 4 (GMPE01 rev 01) | `~/Downloads/Mario Party 4 (USA).iso` (1.46 GB) | `gamecube/roms/MarioParty4.bin.parta{a..f}` | `~/gc_refs/marioparty4/orig/GMPE01_01/MarioParty4.iso` (598 MB) |
| Sonic Adv. 2 Battle (GSNE8P rev 00) | `gamecube/roms/Sonic Adventure 2 - Battle (USA).iso` | `gamecube/roms/SonicAdventure2Battle.bin.parta{a..e}` | — |
| PSO 1&2 Plus (GPOE8P) | — | `gamecube/roms/PhantasyStarOnline1And2Plus.bin.parta{a..q}` | — |
| 240pSuite | `gamecube/roms/240pSuite-1.10b.dol` | — | — |

The split `.bin.part*` are the deployable form (LFS `.iso` is a pointer placeholder); `gamecube.html` chunkRange() consumes them — do not treat them as duplicates of the raw ISO.

## Symbol maps

| Map | Game | Notes |
|---|---|---|
| `tools/gsne8p.map` (262 lines) | SAB (GSNE8P rev 00) | Partial. PC → function name. |
| `tools/gpoe8p.map` (76 lines) | PSO (GPOE8P) | Partial. |
| `dolphin_captures/sab.map` | SAB | Captured, parallel to gsne8p.map. |
| `~/gc_refs/marioparty4/config/GMPE01_01/symbols.txt` (7721 lines) | MP4 | **Full** — 3469 functions, format `Name = .section:0xADDR;`. Outranks the tiny partials for MP4. |

For MP4 PCs with no emulator: `~/gc_refs/marioparty4/build/GMPE01_01/main.elf` (2.18 MB, unstripped PowerPC ELF, byte-identical build) + `~/gc_refs/marioparty4/build/binutils/powerpc-eabi-objdump` = a complete offline disassembler/addr2line for any symbols.txt address.

## Decomp + SDK shelf (`~/gc_refs/`, ~4.4 GB, mostly clean git clones)

Ranked for "first-try-this" on a guest-OS / boot / SDK question:

| Priority | Path | What it answers |
|---|---|---|
| 1 (MP4-specific) | `~/gc_refs/marioparty4/src/dolphin/` | MP4's OWN vendored SDK source (os, dsp, exi, si, thp). Matches the guest binary's actual SDK build — outranks generic dolsdk2001 for byte-level MP4 questions. |
| 1 (MP4 audio) | `~/gc_refs/marioparty4/extern/musyx/` | Revision-matched MusyX source (the hottest wedge, ~25M dispatches/60s). |
| 2 (generic OS) | `~/gc_refs/dolsdk2001/src/` | Canonical GameCube OS/SDK source. `grep -rn <SYMBOL> ~/gc_refs/dolsdk2001/src/` FIRST for any guest-OS API question (`feedback_gc_refs_dolsdk_is_canonical_os_source`). |
| 2 (boot/IPL) | `~/gc_refs/gc-ipl/` | BS2Main, Bootstrap, DVDLoader — boot/IPL/handoff questions. |
| 3 (homebrew OS) | `~/gc_refs/libogc/` | Alternate OS impl for cross-checking. |
| 3 (game decomps) | `~/gc_refs/pikmin`, `~/gc_refs/ttyd`, `~/gc_refs/sadx`, `~/gc_refs/melee`, `~/gc_refs/tww`, `~/gc_refs/tp`, `~/gc_refs/kar` | Full game decomps for pattern/idiom cross-reference. |
| ref | `~/gc_refs/dolphin` (pristine e22551e) / `~/gc_refs/dolphin-upstream` (patched oracle) | Dolphin source — patched clone carries the axei-trace instrumentation + `build-oracle/` binary. |
| tooling | `~/gc_refs/decomp-toolkit`, `~/gc_refs/objdiff`, `~/gc_refs/ppcd`, `~/gc_refs/DolphinPPCTests` | dtk signatures, objdiff, disassembler, PPC conformance oracle vectors. |

**Rule (`feedback_use_gc_refs_decomp_first`): for boot/OS/IPL/handoff/SDK questions, READ the decomp FIRST, then probe.**

## SDK (unpack before use)

`~/Downloads/GameCubeSDK/` — `.rar` archives (`Extra SDKs + Tools + Libraries + Docs.rar`,
`GCN_UberInstaller_v14.rar`, Metrowerks CodeWarrior GameCube R2.7). HLE OS API signatures + OS source
for matching observed PC ranges. Some already extracted into sibling folders; extract from `.rar`
before use. Scan against game binaries with `tools/gcsdk_scan.py` / `tools/gcsdk_siggen.py`.

## Conformance / differential tools

| Tool | Purpose |
|---|---|
| `gamecube/tools/conformance/run.mjs` | Per-instruction differential runner. Default target `test_diff_next` (live powerpc-next emitter vs DolphinPPCTests oracle). `node gamecube/tools/conformance/run.mjs [test_name] [timeout_ms]`; log → `/tmp/conformance/<test>.log`. Build the target first (emcmake into `gamecube/bementalJIT/build-emcc-test`). |
| `gamecube/bementalJIT/tests/` | Emscripten-only test targets (`test_gekko_next`, `test_diff_next`, `test_dispatch`, …) — all produce `.html`, serve over HTTP to run. |
| `tools/gcsdk_scan.py`, `tools/gcsdk_siggen.py` | SDK symbol signature scan against a game binary. |
| `tools/find_polls.py`, `tools/disasm_fn.py`, `tools/dtk_extract_map.py` | Binary investigation (poll-loop finder, single-fn disasm, map extraction). |

## Runtime-state diagnostic tools (the live WASM probe — the patient, not the oracle)

`gamecube/tools/` — `dump_sab_pc.mjs`, `diagnose_gc.mjs`, `sab_disasm.py`, `gdb_memdump.py`,
`memdiff.py`, and the `find_*.mjs` / `perf_*.mjs` family. Full table in `gamecube/docs/README.md`.

## Canonical build + probe loop (three discrete foreground steps — no wrapper)

**Canonical = dual-core WebGPU: `build-wasm-4010` + `~/emsdk-upstream` (4.0.10) + `dolphin_worker_link_4010.sh`.**
The build dir and the link's `BUILD=` MUST match or the link silently packages a STALE wasm (this trap
burned the 2026-07-11 session). Verify with
`grep -c -a "<a-string-you-just-edited>" gamecube/dolphin_libretro/dolphin_worker_emcc.wasm`.
The vendored `emsdk/` is 3.1.67 with NO emdawnwebgpu port — do NOT use it for the WebGPU build.
`build-wasm` + `dolphin_worker_link.sh` is the deprecated OGL/3.1.67 path.

```bash
# 1. build
source $HOME/emsdk-upstream/emsdk_env.sh && cd gamecube/dolphin-src/build-wasm-4010 && emmake make dolphin_libretro -j4
# 2. link — writes gamecube/dolphin_libretro/dolphin_worker_emcc.{js,wasm}
bash gamecube/dolphin-bridge/dolphin_worker_link_4010.sh
# 3. probe — headless Chrome; configure via PROBE_* env (ROM_IDX, PROBE_DURATION_MS, PROBE_QUERY, PROBE_TRACE_PATH, PROBE_METRICS_PATH)
node gamecube/tools/dolphin_render_probe.js > /tmp/probe.log 2>&1
```

Local page serve: `npm run web` (= `python3 -m http.server 8080`) → `http://localhost:8080/gamecube.html`.

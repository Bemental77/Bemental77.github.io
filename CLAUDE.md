# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Pre-action gates (mandatory)

These are forced rules — not guidance. Violations have happened repeatedly across sessions; the user has explicitly called out the pattern as "abhorrent." If you catch yourself about to skip a gate, STOP and run the gate.

1. **Before any test / probe / measurement action** for an emulator: read `dreamcast/docs/*/TASKS.md` (or `gamecube/docs/*/TASKS.md`) — the documented command lives there. Dreamcast iterations use `dreamcast/build_and_probe.sh`. GameCube iterations use three discrete foreground steps (no wrapper — the root `build_and_probe.sh` was deleted by user directive 2026-05-30 and is forbidden to re-introduce; see GameCube section below). Do not improvise (no manual `emcc`, no browser-only test when a Node probe exists). Probe output: Dreamcast = `/tmp/probe-dc.log` (or `/tmp/dc-probes/<name>.log` with `--name`); GameCube = `/tmp/probe.log` (stdout redirect) + `/tmp/probe-trace.json` / `/tmp/probe-metrics.json` — the GC probe takes no flags; configure via `PROBE_*` env vars (`PROBE_DURATION_MS`, `PROBE_QUERY`, `ROM_IDX`, `PROBE_TRACE_PATH`, `PROBE_METRICS_PATH`; see `gamecube/tools/dolphin_render_probe.js`). **`ROM_IDX` indexes the live `gamecube.html` ROMS[] (verified 2026-06-14): 0=Mario Party 4, 1=Sonic Adventure 2 Battle, 2=Phantasy Star Online (PSO), 3=240pSuite. The earlier "0=SAB/1=PSO" note was stale — it predated the MP4 + 240pSuite additions; using `ROM_IDX=1` for PSO silently loads SAB.** **For ANY GameCube / dual-core unknown, `gamecube/docs/ORACLES.md` is the DEFAULT FIRST ACTION** — it inventories the native Dolphin dual-core command (`-C Dolphin.Core.CPUThread=True -C Dolphin.Core.CPUCore=1`, NO `-d`), the game ISOs, the `~/gc_refs/` decomps (incl. MP4's byte-identical `symbols.txt` + `main.elf`), the SDK, and the symbol maps. Run the oracle and read the answer BEFORE any hypothesis/instrumentation/fix. Each emulator's `docs/README.md` lists the full oracle/tool/test inventory — consult it before declaring "throughput" or "cache cold-start" as the next blocker; both have been wrong on the first try repeatedly. See `gamecube/docs/README.md` "failure mode this folder exists to prevent" and `dreamcast/docs/option2-direct-dispatch/README.md` for the rigor target.

2. **Before serving any HTML page locally**: use `npm run web` (= `python3 -m http.server 8080`) → `http://localhost:8080/<page>.html`. Do not improvise the port, do not invent a script, do not `npx serve` unless the existing one is dead. Check `package.json` "scripts" first.

3. **Before asserting "X does/doesn't exist in the repo"**: run one Read or one targeted grep against the live working tree. CLAUDE.md/memory/training are snapshots — they describe committed state at write-time and can be stale or wrong about local changes. "I haven't checked" is a correct answer; a confident wrong assertion is not.

4. **Before running a build, link, or rebuild manually**: a script may wrap it. Check `dreamcast/flycast-bridge/flycast_worker_link.sh`, `dreamcast/build_and_probe.sh`, `gamecube/ppc-worker/build_ppc_worker.sh`, `gamecube/dolphin-bridge/dolphin_worker_link.sh`. Use the script when one exists. **Exception**: GameCube dolphin builds have no wrapper by user directive — run the 3-step foreground flow in the GameCube section, do not bundle build+link+probe into a new script.

5. **When the user asks a direct factual question** ("what's the port?", "where's X defined?", "what does Y do?"): the answer is in one specific file. Read that file before answering — do not answer from context memory.

6. **Claim discipline — every factual assertion about repo or runtime state must be either cited or hedged.** Two acceptable forms:
   - **Cited**: `Per <file>:<line>, X = Y.` or `In the probe log /tmp/...:<grep>, observed X.` The citation must be from THIS conversation, not from memory or training.
   - **Hedged**: `I haven't verified, but I think X.` or `I don't know — would need to check Z.`
   Bare assertions ("the wedge is a slow memset", "the issue is throughput", "X doesn't exist in the repo") without one of these forms are FORBIDDEN. If you catch yourself typing one, stop and rewrite. This includes diagnostic conclusions: declaring "this is/isn't a bug" requires multiple verification data points, not just one consistent observation. The user has called out this pattern as "abhorrent behavior" multiple times. Defaulting to fluent-confident over hedged-accurate produces wrong answers that erode trust.

7. **Challenge word: `VERIFY?`** — when the user sends this single word as a reply, treat it as an audit demand on your last claim. You MUST respond with EITHER (a) the exact tool call output / file:line that grounds the claim, copied verbatim from this conversation; OR (b) the literal sentence "I don't know — I asserted without verifying." There is no third option. Do not defend the prior, do not explain why you thought it, do not equivocate. Cite or retract.

8. **Measurement hygiene — the iteration loop IS the canonical loop (GameCube: the 3-step foreground flow; Dreamcast: `dreamcast/build_and_probe.sh`), on a CLEAN build.** This gate exists because a whole session was burned probing a build that grew more diagnostic instrumentation every iteration, on top of an unestablished baseline, producing contradictory "nondeterministic" results that were partly the instrumentation perturbing a timing-sensitive wedge. The user had to point out that I never rebuilt clean. Forced rules:
   - **One canonical loop.** GameCube: the three discrete foreground steps in the GameCube section (build → link → probe, in order). Dreamcast: `dreamcast/build_and_probe.sh`. Do NOT hand-launch Dolphin or spin up one-off `gdb_*.py` scripts as a substitute. JS-only iteration may skip the build+link steps (GameCube) / use `--skip-build` (Dreamcast); never the reverse (never probe a binary you changed C++ in without building).
   - **Establish a clean baseline FIRST.** Before adding any diagnostic `EM_ASM`/sentinel/log, run the canonical loop on the unmodified tree and record `video_cb`/frames/headline. Every later result is read as a delta from that baseline.
   - **Diagnostics are temporary and must not accumulate.** Add at most the instrumentation needed for the current question; remove it and rebuild before measuring anything perf/correctness-shaped. Per-dispatch / per-store `EM_ASM` and gated logs change timing — they are not free on a nondeterministic wedge.
   - **Contradiction means the rig is dirty, not that a new mystery exists.** If two "identical" runs disagree, or a result contradicts a code-read, STOP adding probes. Suspect: stale build, accumulated instrumentation, or an unreliable signal (e.g. a field that isn't what you think — confirm what each logged value actually means before building a theory on it). Reset to a clean baseline and change ONE thing.
   - **"Is it at native speed / does it render?" is answered ONLY on a clean build.** A cruft-laden diagnostic build cannot answer a perf or boot-success question; say so and rebuild clean before answering.

9. **THE PRODUCT DEFINITION — guest rate and presented rate are TWO INDEPENDENT KNOBS.** Stated by the user three times, most forcefully as: "WE DO NOT WANT THE GAMES SPED UP, WE WANT THEM RAN PRECISELY AS THE HARDWARE INTENDED, WE WANT THE FPS 120! THAT IS WE ARE AHEAD OF THE HARDWARE."
   - **Guest simulation must run at exactly 1.000x hardware. Speeding it up is FORBIDDEN.**
   - **120 means producible CAPACITY** — evidence of headroom — not presents-to-screen.
   - Conflating the two is how a "120fps" claim got manufactured out of a 2x fast-forward. Both knobs move the guest, so BOTH are measurement arms only, never a way to reach 120: Dreamcast `?uncap=1` (sets governor `delay = 0`) and GameCube `?fps=N` (credits ARE emulated time — `recomp_worker.js:768` bumps `viRetrace` per VIWaitForRetrace and `:608-609` derive the guest clock from it, 675,000 ticks at the 40.5 MHz timebase = exactly 1/60).
   - At 1.000x there are only 30 (PSO) or 60 distinct frames per unit time IN EXISTENCE. No browser API presents more distinct images than exist, and re-presenting the same frame to make a counter read 120 is a fabricated number. Say "N presented, Mx headroom" instead.

10. **Measurement discipline — these were each paid for with a wrong claim.**
   - **NEVER compare a profiled run to an unprofiled one.** Doing so turned a real +9.1% into a reported "2.09x". Worse: a profile share for anything that WAITS on another thread is inflated by the profiler loading that thread — a synchronous main-thread proxy profiled at 38.62% measured +9.1% in a matched pair. Size waits with matched pairs only, never from a cpuprofile.
   - **Hash-guard every run.** `md5` the `.wasm` before AND after; report both. Concurrent relinks have produced torn `.js`/`.wasm` pairs that fail as `WebAssembly.instantiate(): Import #0 "env": module is not an object or function`, which reads like an emulator bug.
   - **Report the machine load.** Matched-pair noise has been as bad as ±25% at load 11-23. Absolute MHz is only meaningful with a load caveat; ratios are the durable part.
   - **A savestate that fails to restore SILENTLY COLD-BOOTS** and still produces a plausible-looking number. Always grep for the restore-OK line before believing any scene claim. Screenshots are mandatory evidence for "I measured scene X".
   - **The GameCube `[mips]` meter is NOT validated** — it has produced 98.2/94.5/75.2/97.8% across runs and once disagreed with MP4's own `GlobalCounter` (guest `0x801D3A54`, `~/gc_refs/marioparty4/src/game/main.c:115`) by ~1.7x. Do not quote a GC guest multiple from it. **It also SHIPS OFF as of 2026-09-02** and must be armed with **`?bjit_mips=1`**: its 6-op read-modify-write of `0x026B3420` in every block prologue measured 2.2pp of all executed emitted ops — 30% of the entire prologue — so it is now emit-time gated on SAB cell `0x026B39B8` (`ppc_emit.cpp` `bem_mips_census_on`). An unarmed run prints `[mips] METER OFF` and `exec=off`, which is **not** a zero-throughput reading; blocks must be compiled AFTER the cell is set, so arm it from the query string. Dreamcast has a real witness (AICA emits one frame per `AICA_TICK`=4535 SH4 cycles at 200 MHz, so production rate ÷ 44101.43 IS the guest clock → measured 0.999x); the GC analogue is the AI DMA callback at exactly 200 fires per unit time (`SystemTimers.cpp:80-84`).
   - ~~`gamecube/tools/dolphin_render_probe.js` hardcodes `PORT = 8788`~~ — **STALE, corrected 2026-08-29.** The probe now uses an OS-assigned ephemeral port (`dolphin_render_probe.js:19-22`; `PROBE_PORT=<n>` pins it). There is no `EADDRINUSE` collision. **Serialize GC probes anyway, for a different and worse reason: CPU contention.** Matched-pair noise has been ±25% at load 11-23, rig resolution is ~6-7% at load 9-11, and a parallel-agent campaign drove this box to **load 83.93**, at which point every perf number in flight is uninterpretable. Report `uptime` with every measured number, and treat any pair taken above ~load 25 as void.
   - **A concurrent relink silently poisons a running probe.** Torn `.js`/`.wasm` pairs have fired repeatedly as `WebAssembly.instantiate(): Import #0 "env": module is not an object or function`, which reads like an emulator bug. When any other build may run, measure from a hermetic snapshot: `git archive HEAD` into a scratch tree, point `PROBE_ROOT` at it, and `md5` the `.wasm`+`.js` before AND after. `LINK_OUT_JS` links to a scratch path without touching the live worker.
   - **Size emitted code in OPS, not BYTES.** The emitters bake host addresses as LEB `i32.const` (`cr_encode.cpp:30-31`, `ppc_emit.cpp:199-200`), so byte totals shift with link layout: two separately-linked *baseline* binaries emitted 101,369,315 vs 101,534,986 B for identical input — a **~0.16% phantom delta** that is pure artifact. Op counts are immune. (Two independent instruments counting ops agreed on the CR share to within 0.08pp; the byte-based first attempt was self-inconsistent.)
   - **Read a disc's DOL offset from its header at `0x420`, never hardcode it.** `disasm_hot_pcs.py` had PSO hardcoded to SAB's `0x1e700`; PSO's real offset is `0x1e000`, and `0x1e700` reads `text0_addr=0x0 size=0x0 entry=0x0` — so every PSO disassembly through that tool was of an empty buffer, silently. Fixed 2026-08-29 to read the header and sanity-check that text0 lands in MEM1 with a plausible size.
   - **Poisoned artifact — do NOT use `/tmp/native_pc_hist.txt` as a workload profile.** 86.8% of its 118,001 samples sit in the single 256B bucket `0x80375300`, which contains `0x80375364` — the PARKED-WEDGE PC. It is a recording of a wedge, not of a workload.

## Repository shape

This is Casey Bement's personal site deployed to GitHub Pages (CNAME, `.nojekyll`). It is not a single app — it is a collection of static HTML pages plus several self-contained sub-projects, each with its own build system (or none). There is no top-level build for the site itself; HTML/JS files are served as-is.

- **Deploy branch is `prod`** (not `main`/`master`). Feature branches merge into `prod` via PR. `master` exists but is not the deploy target — ignore git's default-main heuristic if it reports `master`.
- Top-level `package.json` / `tsconfig.json` are used by `handler.js` + `serverless.yml` (an AWS Lambda `sendEmail` endpoint via Serverless Framework). Most of the repo is plain static HTML.
- **Local dev server**: `npm run web` (= `python3 -m http.server 8080`) → http://localhost:8080/<page>.html. The site's `coi-serviceworker.js` installs COOP/COEP on first reload for SharedArrayBuffer.
- The top-level `README.md` is an unmodified `create-next-app` boilerplate left over from an old experiment — ignore it; this is not a Next.js project.

## Sub-projects

Each has its own toolchain — run commands inside the subdirectory.

| Path | What it is | Build/run |
|---|---|---|
| `ps1/ps1Wasm/` | PS1 WebAssembly emulator (derived from `kxkx5150/PCSX-wasm`) | Static — served from `ps1.html`. Source in `pcsx-wasm-src/` (Emscripten Makefile, fastcomp v1.37.40) |
| `n64/` | N64 emulator: vendored N64Wasm core (`N64Wasm/dist/`; buildable source in `N64Wasm/code/`, single-threaded, no SAB) + site-shell page | Static — served at `/n64/` (`n64/index.html`; root `n64.html` is a redirect; vendor libs in `n64/vendor/`). Headless tests, run from repo root: `tools/n64_boot_test.mjs` (dist page, per-ROM boot/speed via audio-rate), `tools/n64_page_test.mjs` (shell page, desktop + mobile touch) |
| `snes/snesWasm`, `gba/gbaWasm` | WebAssembly emulators (no bundled emsdk) | Static — `gba.html`; snesWasm has no root page |
| `gamecube/` | Dolphin libretro WASM build + custom JIT (in active development) | See **GameCube / Dolphin** below |
| `dreamcast/` | Flycast libretro WASM build + SH4 JIT (in active development) | See **Dreamcast / Flycast** below |
| `gamecube/bementalJIT/` | GameCube-only JIT library (PowerPC + powerpc-next emitters; no SH4) | CMake — consumed by `gamecube/dolphin-src/` via `add_subdirectory` (`CMakeLists.txt:921`); `gamecube/ppc-worker/` builds it directly via `build_ppc_worker.sh` |
| `bementalJIT/` | Dreamcast-only JIT library (PowerPC + powerpc-next + SH4 emitters) | CMake — consumed by `dreamcast/flycast-src/` via `add_subdirectory` |
| root `*.html` | Portfolio pages (`index`, `about`, `resume`, `contact`, `playground`, `gamecube`, etc.) | Static |

## WASM emulator architecture (ps1/n64/snes/gba/gamecube)

All emulators follow the same pattern and share a critical constraint:

1. **Cross-origin isolation is required** for `SharedArrayBuffer`. This is set up by `coi-serviceworker.js` at the site root — `ps1.html`, `gamecube.html`, and `dreamcast.html` load it early (line 8 of each); `n64/index.html` / `gba.html` deliberately do not (N64Wasm is single-threaded, no SAB — and its UI deps are self-hosted in `n64/vendor/` so the page survives if a sibling page's coi worker isolates the origin). If `crossOriginIsolated === false`, the SAB-based emulators will silently fail to start the worker thread. Do not remove the `<script src="/coi-serviceworker.js">` tag.
2. **Main thread ↔ worker split.** Each emulator has a `*_worker.js` + `*.wasm` running the CPU loop off-thread, and a main-thread `*.min.js` (or equivalent) that owns the canvas/audio. They communicate via `postMessage` (with transferables for framebuffers and audio buffers). For GameCube/Dreamcast the `*_worker.js` file is a thin shim; the real emcc output lives alongside it as `*_worker_emcc.{js,wasm}`.
3. **Binaries are vendored.** The `dist/` directories contain minified/compiled artifacts produced by Emscripten elsewhere — do not hand-edit them without understanding they are generated. For PS1, source lives at `ps1/ps1Wasm/pcsx-wasm-src/` and uses the old `emsdk fastcomp` toolchain (v1.37.40) per its Makefile; the top-level `emsdk/` is the modern Emscripten SDK used by the GameCube/Dolphin WASM build.
4. **ROMs over 100 MB are split.** See `ps1/ps1Wasm/roms/MonsterRancher2.bin.partaa…partaf` and the `ROMS` array in `ps1.html` (chunk names + sizes embedded in the page; there is no `romlist.js`) — the loader fetches chunks and concatenates them client-side to stay under GitHub's file-size limit.

When editing the PS1 emulator specifically, the current JS-side patches (performance.now shims, diag logs) live in `ps1/ps1Wasm/dist/wasmpsx_worker.js`, and `ps1/ps1Wasm/dist/pcsx_ww.js` is the main-thread controller (loaded at `ps1.html:516`). `wasmpsx.min.js` exists only under `wasmpsx-repo/`, not `dist/`.

### Device portability: the shared capability layer + the device matrix

`lib/capability.js` is loaded by all three emulator pages (`gamecube.html`, `dreamcast.html`, `n64/index.html`) and publishes **`window.__cap`** — one report shape, so one rig can ask every page the same questions. **Every field is the result of DOING the thing, never of reading a property.** Measured 2026-09-01, Chrome 140: under `--disable-gpu` and under `--disable-features=WebGPUService,Dawn`, `navigator.gpu` is still **truthy** while `requestAdapter()` resolves **null** — and `--disable-features=WebGPU` / `--disable-blink-features=WebGPU` are **no-ops** that disable nothing. A presence check is not a capability check.

- **`npm run matrix`** (= `node tools/device_matrix.mjs`) — the standing portability gate. Arms: `desktop`, `no-webgpu`, `no-gpu`, `no-coi`, `mobile-ios`, `low-memory`, `slow-net` × 3 pages. Needs `npm run web` first. Full JSON at `/tmp/device-matrix.json`.
  - **Every arm carries an arm-difference proof.** If the flag/condition did not demonstrably change a measured value versus the baseline arm, the cell is **VOID and prints no verdict** — a placebo arm reports nothing rather than a false pass. This caught the `slow-net` arm silently not working: page-scoped CDP throttling does **not** reach a `coi-serviceworker`-controlled `fetch()` (the SW is a separate CDP target), so the two SW pages measured 1.1–1.2x while n64 measured 214x. The rig now throttles every target.
  - **Fresh `userDataDir` per cell**, deleted after. Cross-origin isolation is **origin-scoped and persists**: the rig's own self-test reproduces the leak (visit `gamecube.html`, then `/n64/` in the same profile reports `crossOriginIsolated=true`). A shared-profile matrix returns identical rows and no signal.
  - Device emulation gets viewport/touch/UA right but **runs Chrome's engine, not WebKit**. Rows tagged `enginesDiffer` cannot clear the pages on real iOS Safari; that needs hardware.
- **`?captest=1`** on any of the three pages runs `lib/capability.test.js` — 186 assertions incl. an 8-guard mutation matrix, published at `window.__capTest` (gate on `.done`, not existence).
- `Capability.SPECS` holds each page's requirement spec in **one** place; the pages, the suite and the matrix all read it, and the matrix fails on spec drift. `Capability.autoGate(spec)` is what keeps a page from **presenting an enabled Start behind a broken path** — it disables both `#btnStart` and `#mobileSplashStart` and raises a banner saying what is missing and what the visitor can do. `?nogate=1` overrides (and is recorded on the report).
- **Ownership protocol for the Start button:** `aria-disabled="true"` means the capability layer is holding it down; `gamecube.html:1674` defers to that and never re-enables such a button. `lib/capability.js` is therefore the sole writer of `aria-disabled`/`data-cap-blocked` on those controls and must **release** them when it stops blocking.
- **`coi` is not a presence check.** Cross-origin isolation is a *means* to `SharedArrayBuffer`; `crossOriginIsolated=false` with a functional SAB (e.g. Chrome under `--disable-web-security`) must **not** block. This regressed once and gated Start on a browser where the emulator rendered perfectly; the named test `coi/functional-sab-overrides-false-flag` catches the revert.

## GameCube / Dolphin WASM build

This is an active R&D effort — not yet shipping. Four pieces interact:

- `gamecube/dolphin-src/` — Dolphin source tree. **The canonical dual-core WebGPU build is configured under `build-wasm-4010/`** (Emscripten 4.0.10 from `~/emsdk-upstream`, has the `emdawnwebgpu` port); `build-wasm/` (vendored `emsdk/`, now **6.0.2** not the 3.1.67 this file used to claim — see the build-flow block) is the legacy OGL static-lib build. Build dir + link `BUILD=` must match — see the build-flow block + `gamecube/docs/ORACLES.md`.
- `gamecube/bementalJIT/` — GameCube-local C++17 static library that Dolphin links against in place of its native JIT. Per-guest emitters live under `guests/<arch>/` (currently `powerpc` for Gekko and `powerpc-next` for the Phase 1 IR rebuild; no SH4). Block cache lives in `src/block_cache.cpp`.
- `gamecube/dolphin_libretro/` — final Emscripten link output: `dolphin_worker.js` (thin shim) + `dolphin_worker_emcc.{js,wasm}` (the real emcc output). Loaded by `gamecube.html`.
- `gamecube/ppc-worker/` — standalone PowerPC JIT worker (Phase 2 architecture: separate worker thread from `dolphin_worker`). Built via `gamecube/ppc-worker/build_ppc_worker.sh`, which also drives `gamecube/bementalJIT/build-emcc/` on first run. Outputs `ppc_worker.js` (shim) + `ppc_worker_emcc.{js,wasm}`. SAB layout shared with dolphin defined in `sab_layout.h`.
- `gamecube/dolphin-bridge/worker_funcs.js` — mailbox routing between `dolphin_worker` and `ppc-worker` (CompileBlock cmds, MMIO routing, PowerPCState mirror). Baked into `dolphin_worker_emcc.js` at link time via `--post-js` (`dolphin_worker_link.sh:76`) — not loaded by a `gamecube.html` script tag, so editing it requires a re-link.

There is **no wrapper script** — the root `build_and_probe.sh` was deleted by user directive 2026-05-30 (commit `270e38c`: "run the build right in front of me every single time") and must not be re-introduced. The canonical inner-loop is three discrete foreground steps, each run to completion (no `run_in_background`) with its output read before the next:

**CANONICAL BUILD = dual-core WebGPU: build dir `build-wasm-4010`, emsdk `~/emsdk-upstream` (4.0.10), link `dolphin_worker_link_4010.sh`.** The build dir and the link's `BUILD=` MUST match, or the link silently packages a STALE wasm and NOTHING you changed is tested (this trap burned an entire session 2026-07-11 — every "rebuild" linked stale `build-wasm-4010` libs while make ran in the wrong `build-wasm`; tell = every test returns identical values; verify with `grep -c -a "<a-string-you-just-edited>" gamecube/dolphin_libretro/dolphin_worker_emcc.wasm`). ~~The vendored `emsdk/` is 3.1.67~~ — **STALE AND THE DIRECTIVE WAS ALREADY VIOLATED, corrected 2026-08-29.** `cat emsdk/upstream/emscripten/emscripten-version.txt` returns **`"6.0.2"`**. Somebody updated it despite the "do NOT update it" note directly below. ~~`libretronew.c` no longer compiles under it, so the N64 binary is un-reproducible; treat any "rebuild the N64 core" instruction as BLOCKED~~ — **RESOLVED 2026-09-01, the N64 core builds and SHIPS from emsdk 6.0.2.** Three fixes, none of them a workaround: (a) 7 `-Wincompatible-pointer-types` in `libretronew.c` (4aaff9f2 — `gzFile` is already a pointer; `savestate_buffer` is an array that decays on its own; one `struct rgba*`→`uint32_t*` return); (b) `EXTRA_EXPORTED_RUNTIME_METHODS` → `EXPORTED_RUNTIME_METHODS`; (c) the one that made a WORKING core look dead — emscripten ≤3.1.x attached `FS` and every `HEAP*` view to `Module` unconditionally, 6.0.2 attaches only what is EXPORTED (`src/runtime_common.js:164-171`), so `n64/index.html:2102` died on `Module.HEAP16.buffer` until the Makefile listed them (39a8477f). **The trap worth remembering: `Module.calledRun` DOES NOT EXIST under 6.0.2** — it is guarded by `#if ASSERTIONS` and never assigned to `Module` (`src/postamble.js:117-120`); the shipped 3.1.67 `n64wasm.js` contains the string 6 times, a 6.0.2 rebuild 0 times. Two harnesses gated a boot on it and reported `launched:false` + TimeoutError + EMPTY pageErrors/coreLog for a core that was booting and rendering fine (fixed 8110341a). A silent harness failure is not a core failure — sample the canvas before believing a flag. It still has NO `emdawnwebgpu` port — do NOT use it for the WebGPU build, and do NOT update it further. `build-wasm` + `dolphin_worker_link.sh` is the OLD OGL path — not the WebGPU build.

```bash
# 1. build — build-wasm-4010 with the 4.0.10 emsdk (has emdawnwebgpu)
source $HOME/emsdk-upstream/emsdk_env.sh && cd gamecube/dolphin-src/build-wasm-4010 && emmake make dolphin_libretro -j4
# 2. link — produces gamecube/dolphin_libretro/dolphin_worker_emcc.{js,wasm} from build-wasm-4010
bash gamecube/dolphin-bridge/dolphin_worker_link_4010.sh
# 3. probe — Chrome via puppeteer (PROBE_HEADLESS=0 = visible window + console); configure with PROBE_* env vars
PROBE_HEADLESS=0 PROBE_VANILLA_WEBGPU=1 ROM_IDX=0 node gamecube/tools/dolphin_render_probe.js > /tmp/probe.log 2>&1
```

A `PostToolUse` hook (`.claude/hooks/verify_fresh_probe.sh`) mechanically gates probe results on build success and `.wasm`-newer-than-source freshness — do not report probe results unless it prints PASS (see "Claude harness enforcement" below).

### bementalJIT tests

**GameCube tests** live in `gamecube/bementalJIT/tests/` (`test_dispatch.cpp`, `test_gekko.cpp`, `test_gekko_next.cpp`, `test_perf_t1.cpp`, `test_pi_mask_path.cpp`, `test_str_hle_pattern.cpp`, `test_analyst.cpp`, `test_diff.cpp`, `test_diff_next.cpp`). These are **Emscripten-only** targets — `tests/CMakeLists.txt` early-returns with "bementalJIT tests skipped (requires Emscripten)" under a native cmake. All test targets produce `.html` output (e.g. `test_gekko.html`), not native binaries. To build: `emcmake cmake -S gamecube/bementalJIT -B gamecube/bementalJIT/build-emcc-test -DBEMENTAL_BUILD_TESTS=ON -DBEMENTAL_GUEST_POWERPC=ON && emmake make -C gamecube/bementalJIT/build-emcc-test`. Run by serving the build directory over HTTP and opening the `.html` in a browser. Build artifacts land in `gamecube/bementalJIT/build-emcc-test/` (or `gamecube/bementalJIT/build-host-test/` if that directory was bootstrapped with an emcc toolchain).

**Dreamcast tests** live in `bementalJIT/tests/` (repo root), which additionally includes `test_sh4_dispatch.cpp`. Same Emscripten-only constraint applies.

Separate from the CMake targets, `gamecube/tools/conformance/run.mjs` is the per-instruction conformance-harness runner (usage documented in its header).

## Dreamcast / Flycast WASM build

Active R&D, parallel structure to GameCube. Pieces:

- `dreamcast/flycast-src/` — Flycast source tree, the SH4 dynarec is replaced by a `bementalJIT`-backed emitter (`bementalJIT/guests/sh4/`).
- `dreamcast/flycast-bridge/` — Emscripten link script (`flycast_worker_link.sh`), worker glue (`EmscriptenWorker.cpp`, `flycast_worker_funcs.js`), WebGL2/GL override shims (`gl_override.js`, `webgl2-compat.js`), and `rec_wasm.cpp` (the SH4 dynarec hook into Flycast).
- `dreamcast/flycast_libretro/` — final link output: `flycast_worker.js` (shim) + `flycast_worker_emcc.{js,wasm}` + `flycast_worker_emcc.js.symbols`. Loaded by `dreamcast.html`.
- `dreamcast/oracle/` — RedDream native reference for trajectory diffing; see `dreamcast/tools/trace_diff_native_vs_wasm.sh`.
- `dreamcast/build_and_probe.sh` — canonical Dreamcast inner-loop (build → link → Node probe). Probe output: `/tmp/dc-probes/<name>.log`. **[STALE-ARCHIVE TRAP, fixed 2026-08-28]** It used to build ONLY `bementalJIT bementalJITSh4`, never `flycast_libretro` — and the link script compiles only the four bridge TUs (`EmscriptenWorker.cpp`, `flycast_stubs.cpp`, `rec_wasm.cpp`, `arm7_rec_wasm.cpp`), taking everything else as prebuilt `.a` files. So EVERY edit under `flycast-src/core/**` was silently dropped while the script still printed a clean link. Caught when a committed `gles.cpp` shader fix was "rebuilt" and the shipped `.wasm` still contained the old string. It now builds `flycast_libretro` too and aborts on `${PIPESTATUS[0]}`. **Verify any edit landed with `grep -o -a -F "<string you just edited>" flycast_worker_emcc.wasm | wc -l`** — use `grep -o | wc -l`, NOT `grep -c`, because a wasm has almost no newlines so `-c` counts lines rather than matches.
- **The Dreamcast link now defaults to RELEASE, not DIAG** (inverted 2026-08-28; `FLYCAST_DIAG=1` opts in, `FLYCAST_RELEASE=1` kept as a no-op alias). The old DIAG default compiled in a per-memory-access `[gdrom]` trace that emitted 51,867 of 53,319 log lines in a 60s boot — the guest never left the disc bootstrap and it looked exactly like a wedge caused by unrelated code changes. The same tree relinked RELEASE booted normally at `fps=30 hw=30 video_cb=30/s` in 584 lines. Any doc still saying "default = DIAG" (e.g. `docs/ORACLES.md`) is stale.
- `dreamcast/run_native_flycast.sh` — runs native Flycast as an oracle.
- `dreamcast/docs/<topic>/TASKS.md` — per-topic task lists (currently only `nasomers-table-dispatch/TASKS.md`); pre-action gate #1 requires reading these before improvising any probe/test command.

`dreamcast/STATUS.md`, `dreamcast/STATUS_*.md`, and `dreamcast/CLAUDE_VIOLATIONS.md` are session-state scratch files — read for context, don't treat as authoritative spec.

### SAB primitives

`gamecube/seqlock.js` and `gamecube/ringbuffer.js` are SharedArrayBuffer primitives used across the worker boundary. Each ships a Node smoke test:

```bash
node gamecube/seqlock.test.mjs
node gamecube/ringbuffer.test.mjs
```

### GameCube-specific tools

Two separate tool locations — do not confuse them:

**`tools/` (repo root)** — symbol/disassembly utilities for game-binary investigation:
- `tools/gcsdk_scan.py` / `tools/gcsdk_siggen.py` — SDK symbol signature scan against game binaries.
- `tools/gsne8p.map`, `tools/gpoe8p.map` — SAB (Sonic Adventure 2 Battle) and PSO symbol maps.
- `tools/find_polls.py`, `tools/disasm_fn.py`, `tools/dtk_extract_map.py`, `tools/mw_listener.py`.

**`gamecube/tools/`** — runtime diagnostic `.mjs` and `.py` scripts for the live probe (e.g. `dump_sab_pc.mjs`, `diagnose_gc.mjs`, `sab_disasm.py`, `gdb_memdump.py`, `memdiff.py`, and the `find_*.mjs` / `perf_*.mjs` family). See `gamecube/docs/README.md` "Runtime-state tools" table for the full inventory.

## Searching minified JS

The emulator JS files in `ps1/ps1Wasm/dist/` (and other vendored `dist/` outputs) are minified. Use the included helper rather than grepping raw:

```bash
node tools/jsearch.js <file> "<pattern>" --context 300 --max 5
node tools/jsearch.js <file> --pretty          # writes /tmp/<name>.pretty.js
node tools/jsearch.js <file> --pretty --lines  # …with line numbers
node tools/jsearch.js <file> --extract <name>  # extract a named function/var block
```

## Lambda email handler

`handler.js` + `serverless.yml` define a single AWS Lambda (`nodejs18.x`) that accepts POST `/hello` and sends mail via AWS SES (`handler.js:4`; nodemailer is in `package.json` deps but unused by the handler). `send.email.ts` / `send.email.js` are the business logic. Deployed via `sls deploy` (Serverless Framework v3). `send.email.ts` and `config.js` are gitignored — secrets live there.

## Git conventions

- PR target is `prod`, not `main`/`master`.
- GameCube changes commit to the `dev` branch (current active branch). The standalone `gamecube` branch is stale (pre-emulator era) — do not use it.
- Do not commit `node_modules`, `.env`, `config.js`, `send.email.ts`, `*.jsdos`, `*.zip`, ROM `.iso` files, or `emsdk` artifacts beyond what is already tracked. (`.gitignore` covers `.iso` per-directory, e.g. `dreamcast/roms/` — there is no root `*.iso` pattern, so check before staging.)
- Large generated files (vendored emulator binaries, split ROM parts) are tracked intentionally — don't "clean them up."
- **CHECK THE TRACKED-FILE COUNT BEFORE EVERY COMMIT.** It only ever GROWS, so the test is "did it collapse by orders of magnitude", not equality with a number written here — a hardcoded figure goes stale the moment anyone adds a file, and an agent had to point out this line already said 7852 while `git ls-files | wc -l` returned 7895. Read the current count, compare against the previous commit's (`git ls-tree -r --name-only HEAD | wc -l`), and treat a large DROP as the alarm. `tools/preflight_all.sh` gates on this. Paid for 2026-09-01: a commit went out whose tree contained ONE file — the index had silently collapsed to a single entry — recording 7,851 tracked files as deleted, and it was pushed. `git status` showed only `M gamecube.html`, so nothing warned. No data was lost (all 219,579 files stayed on disk; the damage was index-only), but the recovery is expensive for a reason worth knowing:
  - **A near-empty commit at a branch tip POISONS every subsequent push to the WHOLE REPO.** git's object exclusion walks from the tips the server advertises; when a tip's tree holds one file, excluding it excludes almost nothing. Measured: `rev-list --objects <new> --not <prod>` = 8 objects, but adding the one-file tip to the exclusion set = 8,253 objects / **6.35 GiB**, which GitHub rejects with `HTTP 400`. Reproduced on git 2.24 AND 2.55, so it is not a version bug. Pushes to `prod` are blocked too, not just `dev` — i.e. **deployment stops until that ref is moved**, and moving it requires a force-push.
  - Repair forward if you can (`git reset --soft <bad>` then commit the good tree) — but note the forward commit is exactly the 6.35 GiB push described above, so in practice the branch ref has to move.
  - Concurrent agents share this working tree and have committed each other's uncommitted work before. Treat the index as shared state.

### Concurrent agents share ONE index — commit with a pathspec, never bare
**`git add <paths>` + `git commit` commits the ENTIRE INDEX, including every file a sibling agent staged while you were working.** This happened TWICE on 2026-09-01 and mis-attributed two agents' work:
- a commit intended as 5 test files landed 21, sweeping in another agent's whole PS1/GBA/SNES/snes.html body of work;
- a commit intended as a capability-gate fix also took another agent's in-progress Dreamcast audio edits (`srcRate`/`dstRate`/`underrun` hunks) under a message that never mentions them.

Nothing is lost when this happens — the code is committed — but the history lies about who changed what and why, and the commit message documents only part of its own diff. Use a pathspec, which commits ONLY those paths regardless of what else is staged:

```bash
git commit -- <path> [<path>...]        # pathspec-limited; ignores the rest of the index
git diff --cached --name-only           # ALWAYS read this before committing
git show --stat --format="" HEAD | tail -25   # and verify AFTER: did it take only what you meant?
```
Checking `git status` is NOT sufficient — it shows the sibling's staged files as ordinary staged entries, indistinguishable from your own. When a file you need is being edited by a sibling (e.g. `gamecube.html` carrying both a present-ring change and a capability fix), either leave it entirely to that agent or stage only your own hunks; do not commit the file wholesale.

### Before any measured run (not optional)
```bash
node tools/browser_leak_guard.js reap && uptime
```
Orphaned Chromes from SIGKILLed harnesses — two with 832 and 815 CPU-MINUTES accumulated, together **230.3% of CPU** — were resident for days and were the largest single source of the "machine load" that voided whole campaigns of matched pairs. A SIGKILLed parent ORPHANS its browser and no in-process handler can prevent it, which is why this accumulated silently. Every `puppeteer.launch` site in every harness is now registered; `reap` kills only browsers whose OWNER process is gone, so it never touches a live sibling run or the user's own browser. **When several agents share the box, serialize probes with a lock** (`mkdir /tmp/bemental-probe.lock`, release in all paths) — a parallel campaign previously drove this machine to load 83.93, at which point every number in flight is uninterpretable.

## Claude harness enforcement (`.claude/`)

The pre-action gates are not just prose — hooks configured in `.claude/settings.json` enforce them mechanically (`.claude/settings.local.json` holds the per-user permissions allowlist):

- `.claude/hooks/preflight.sh` (PreToolUse on Bash) — warns on foot-guns: improvised HTTP ports (gate #2), manual `emcc`/`em++`/`emmake` outside the canonical flow, browser-open instead of the Node probe, `lsof`/`netstat` instead of reading `package.json`.
- `.claude/hooks/verify_fresh_probe.sh` (PostToolUse on Bash) — the MECHANICAL BUILD/FRESHNESS GATE: FAIL if the build log has errors, the worker `.wasm` is older than the newest source file, or the probe log is near-empty. Do not report probe results on anything but PASS (gate #8).
- `.claude/hooks/no_time_no_defer.sh` (Stop) — blocks turns containing time estimates or deferral phrasing ("Want me to…", "Should I…").
- `.claude/hooks/claim_discipline.sh` (Stop) — blocks turns making confident factual claims with no citation or hedge marker (gate #6).

Treat hook output as binding user feedback, not noise.

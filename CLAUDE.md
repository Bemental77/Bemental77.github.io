# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Pre-action gates (mandatory)

These are forced rules — not guidance. Violations have happened repeatedly across sessions; the user has explicitly called out the pattern as "abhorrent." If you catch yourself about to skip a gate, STOP and run the gate.

1. **Before any test / probe / measurement action** for an emulator: read `dreamcast/docs/*/TASKS.md` (or `gamecube/docs/*/TASKS.md`) — the documented command lives there. Use `dreamcast/build_and_probe.sh` for Dreamcast iterations and the root `build_and_probe.sh` for GameCube. Do not improvise (no manual `emcc`, no browser-only test when a Node probe exists). Probe output: Dreamcast = `/tmp/probe-dc.log` (or `/tmp/dc-probes/<name>.log` with `--name`); GameCube = `/tmp/probe.log` (or `/tmp/probes/<name>.{log,summary.json,trace.json,metrics.json}` with `--name`). Each emulator's `docs/README.md` lists the full oracle/tool/test inventory — consult it before declaring "throughput" or "cache cold-start" as the next blocker; both have been wrong on the first try repeatedly. See `gamecube/docs/README.md` "failure mode this folder exists to prevent" and `dreamcast/docs/option2-direct-dispatch/README.md` for the rigor target.

2. **Before serving any HTML page locally**: use `npm run web` (= `python3 -m http.server 8080`) → `http://localhost:8080/<page>.html`. Do not improvise the port, do not invent a script, do not `npx serve` unless the existing one is dead. Check `package.json` "scripts" first.

3. **Before asserting "X does/doesn't exist in the repo"**: run one Read or one targeted grep against the live working tree. CLAUDE.md/memory/training are snapshots — they describe committed state at write-time and can be stale or wrong about local changes. "I haven't checked" is a correct answer; a confident wrong assertion is not.

4. **Before running a build, link, or rebuild manually**: check if a script wraps it (`dreamcast/flycast-bridge/flycast_worker_link.sh`, `dreamcast/build_and_probe.sh`, `gamecube/ppc-worker/build_ppc_worker.sh`). Use the script.

5. **When the user asks a direct factual question** ("what's the port?", "where's X defined?", "what does Y do?"): the answer is in one specific file. Read that file before answering — do not answer from context memory.

6. **Claim discipline — every factual assertion about repo or runtime state must be either cited or hedged.** Two acceptable forms:
   - **Cited**: `Per <file>:<line>, X = Y.` or `In the probe log /tmp/...:<grep>, observed X.` The citation must be from THIS conversation, not from memory or training.
   - **Hedged**: `I haven't verified, but I think X.` or `I don't know — would need to check Z.`
   Bare assertions ("the wedge is a slow memset", "the issue is throughput", "X doesn't exist in the repo") without one of these forms are FORBIDDEN. If you catch yourself typing one, stop and rewrite. This includes diagnostic conclusions: declaring "this is/isn't a bug" requires multiple verification data points, not just one consistent observation. The user has called out this pattern as "abhorrent behavior" multiple times. Defaulting to fluent-confident over hedged-accurate produces wrong answers that erode trust.

7. **Challenge word: `VERIFY?`** — when the user sends this single word as a reply, treat it as an audit demand on your last claim. You MUST respond with EITHER (a) the exact tool call output / file:line that grounds the claim, copied verbatim from this conversation; OR (b) the literal sentence "I don't know — I asserted without verifying." There is no third option. Do not defend the prior, do not explain why you thought it, do not equivocate. Cite or retract.

8. **Measurement hygiene — the iteration loop IS `build_and_probe.sh`, on a CLEAN build.** This gate exists because a whole session was burned probing a build that grew more diagnostic instrumentation every iteration, on top of an unestablished baseline, producing contradictory "nondeterministic" results that were partly the instrumentation perturbing a timing-sensitive wedge. The user had to point out that I never rebuilt clean. Forced rules:
   - **One canonical loop.** Iterate with `build_and_probe.sh` (GameCube) / `dreamcast/build_and_probe.sh` (Dreamcast). Do NOT run `node dolphin_render_probe.js` standalone, hand-launch Dolphin, or spin up one-off `gdb_*.py` scripts as a substitute. Use `--skip-build` for JS-only iteration; never the reverse (never probe a binary you changed C++ in without building).
   - **Establish a clean baseline FIRST.** Before adding any diagnostic `EM_ASM`/sentinel/log, run `build_and_probe.sh --name baseline` on the unmodified tree and record `video_cb`/frames/headline. Every later result is read as a delta from that baseline.
   - **Diagnostics are temporary and must not accumulate.** Add at most the instrumentation needed for the current question; remove it and rebuild before measuring anything perf/correctness-shaped. Per-dispatch / per-store `EM_ASM` and gated logs change timing — they are not free on a nondeterministic wedge.
   - **Contradiction means the rig is dirty, not that a new mystery exists.** If two "identical" runs disagree, or a result contradicts a code-read, STOP adding probes. Suspect: stale build, accumulated instrumentation, or an unreliable signal (e.g. a field that isn't what you think — confirm what each logged value actually means before building a theory on it). Reset to a clean baseline and change ONE thing.
   - **"Is it at native speed / does it render?" is answered ONLY on a clean build.** A cruft-laden diagnostic build cannot answer a perf or boot-success question; say so and rebuild clean before answering.

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
| `n64/N64Wasm`, `snes/snesWasm`, `gba/gbaWasm` | WebAssembly emulators with bundled `emsdk` | Static — served from corresponding `*.html` |
| `gamecube/` | Dolphin libretro WASM build + custom JIT (in active development) | See **GameCube / Dolphin** below |
| `dreamcast/` | Flycast libretro WASM build + SH4 JIT (in active development) | See **Dreamcast / Flycast** below |
| `gamecube/bementalJIT/` | GameCube-only JIT library (PowerPC + powerpc-next emitters; no SH4) | CMake — consumed by `gamecube/dolphin-src/` and `gamecube/ppc-worker/` via `add_subdirectory` |
| `bementalJIT/` | Dreamcast-only JIT library (PowerPC + powerpc-next + SH4 emitters) | CMake — consumed by `dreamcast/flycast-src/` via `add_subdirectory` |
| root `*.html` | Portfolio pages (`index`, `about`, `resume`, `contact`, `playground`, `gamecube`, etc.) | Static |

## WASM emulator architecture (ps1/n64/snes/gba/gamecube)

All emulators follow the same pattern and share a critical constraint:

1. **Cross-origin isolation is required** for `SharedArrayBuffer`. This is set up by `coi-serviceworker.js` at the site root — every emulator HTML page loads it early. If `crossOriginIsolated === false`, emulators will silently fail to start the worker thread. Do not remove the `<script src="/coi-serviceworker.js">` tag.
2. **Main thread ↔ worker split.** Each emulator has a `*_worker.js` + `*.wasm` running the CPU loop off-thread, and a main-thread `*.min.js` (or equivalent) that owns the canvas/audio. They communicate via `postMessage` (with transferables for framebuffers and audio buffers).
3. **Binaries are vendored.** The `dist/` directories contain minified/compiled artifacts produced by Emscripten elsewhere — do not hand-edit them without understanding they are generated. For PS1, source lives at `ps1/ps1Wasm/pcsx-wasm-src/` and uses the old `emsdk fastcomp` toolchain (v1.37.40) per its Makefile; the top-level `emsdk/` is the modern Emscripten SDK used by the GameCube/Dolphin WASM build.
4. **ROMs over 100 MB are split.** See `ps1/ps1Wasm/roms/MonsterRancher2.bin.partaa…partaf` and `ps1/ps1Wasm/dist/romlist.js` — the loader fetches chunks and concatenates them client-side to stay under GitHub's file-size limit.

When editing the PS1 emulator specifically, the current JS-side patches (performance.now shims, `_gettimeofday` counter, diag logs) live in `ps1/ps1Wasm/dist/wasmpsx_worker.js`, and `ps1/ps1Wasm/dist/wasmpsx.min.js` is the main-thread controller.

## GameCube / Dolphin WASM build

This is an active R&D effort — not yet shipping. Four pieces interact:

- `gamecube/dolphin-src/` — Dolphin source tree, configured under `build-wasm/` for an Emscripten static-lib build (`dolphin_libretro` libretro target).
- `gamecube/bementalJIT/` — GameCube-local C++17 static library that Dolphin links against in place of its native JIT. Per-guest emitters live under `guests/<arch>/` (currently `powerpc` for Gekko and `powerpc-next` for the Phase 1 IR rebuild; no SH4). Block cache lives in `src/block_cache.cpp`.
- `gamecube/dolphin_libretro/` — final Emscripten link output (`dolphin_worker.js`, `dolphin_worker.wasm`, etc.) loaded by `gamecube.html`.
- `gamecube/ppc-worker/` — standalone PowerPC JIT worker (Phase 2 architecture: separate worker thread from `dolphin_worker`). Built via `gamecube/ppc-worker/build_ppc_worker.sh`, which also drives `gamecube/bementalJIT/build-emcc/` on first run. Outputs `ppc_worker.{js,wasm}`. SAB layout shared with dolphin defined in `sab_layout.h`.
- `gamecube/dolphin-bridge/worker_funcs.js` — page-mediated mailbox routing between `dolphin_worker` and `ppc-worker` (CompileBlock cmds, MMIO routing, PowerPCState mirror). Loaded by `gamecube.html`.

The canonical inner-loop is `build_and_probe.sh` at the repo root — it sources `emsdk_env.sh`, runs `emmake make dolphin_libretro` in `build-wasm/`, runs the link script at `/tmp/dolphin_worker_link.sh` (falls back to `gamecube/dolphin-bridge/dolphin_worker_link.sh`), then runs a Node-based render probe and prints a fixed summary (canvas non-black check, jit-inner traces, HLE replace counts, frame counts, VI/XFB events, installed patches). Use this single script for build/link/probe iterations rather than running emcc/make ad hoc — permissions are configured for it.

### bementalJIT tests

**GameCube tests** live in `gamecube/bementalJIT/tests/` (`test_dispatch.cpp`, `test_gekko.cpp`, `test_perf_t1.cpp`, `test_pi_mask_path.cpp`, `test_str_hle_pattern.cpp`, `test_analyst.cpp`, `test_diff.cpp`). These are **Emscripten-only** targets — `tests/CMakeLists.txt` early-returns with "bementalJIT tests skipped (requires Emscripten)" under a native cmake. All test targets produce `.html` output (e.g. `test_gekko.html`), not native binaries. To build: `emcmake cmake -S gamecube/bementalJIT -B gamecube/bementalJIT/build-emcc-test -DBEMENTAL_BUILD_TESTS=ON -DBEMENTAL_GUEST_POWERPC=ON && emmake make -C gamecube/bementalJIT/build-emcc-test`. Run by serving the build directory over HTTP and opening the `.html` in a browser. Build artifacts land in `gamecube/bementalJIT/build-emcc-test/` (or `gamecube/bementalJIT/build-host-test/` if that directory was bootstrapped with an emcc toolchain).

**Dreamcast tests** live in `bementalJIT/tests/` (repo root), which additionally includes `test_sh4_dispatch.cpp`. Same Emscripten-only constraint applies.

## Dreamcast / Flycast WASM build

Active R&D, parallel structure to GameCube. Pieces:

- `dreamcast/flycast-src/` — Flycast source tree, the SH4 dynarec is replaced by a `bementalJIT`-backed emitter (`bementalJIT/guests/sh4/`).
- `dreamcast/flycast-bridge/` — Emscripten link script (`flycast_worker_link.sh`), worker glue (`EmscriptenWorker.cpp`, `flycast_worker_funcs.js`), WebGL2/GL override shims (`gl_override.js`, `webgl2-compat.js`), and `rec_wasm.cpp` (the SH4 dynarec hook into Flycast).
- `dreamcast/flycast_libretro/` — final link output (`flycast_worker.{js,wasm,symbols}`) loaded by `dreamcast.html`.
- `dreamcast/sh4-worker/` — standalone SH4 JIT worker (parallel to GameCube's `ppc-worker`).
- `dreamcast/oracle/` — RedDream native reference for trajectory diffing; see `dreamcast/tools/trace_diff_native_vs_wasm.sh`.
- `dreamcast/build_and_probe.sh` — canonical Dreamcast inner-loop (build → link → Node probe). Probe output: `/tmp/dc-probes/<name>.log`.
- `dreamcast/run_native_flycast.sh` — runs native Flycast as an oracle.
- `dreamcast/docs/<topic>/TASKS.md` — per-topic task lists; pre-action gate #1 requires reading these before improvising any probe/test command.

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
node tools/jsearch.js <file> --extract <name>  # extract a named function/var block
```

## Lambda email handler

`handler.js` + `serverless.yml` define a single AWS Lambda (`nodejs18.x`) that accepts POST `/hello` and sends mail via nodemailer. `send.email.ts` / `send.email.js` are the business logic. Deployed via `sls deploy` (Serverless Framework v3). `send.email.ts` and `config.js` are gitignored — secrets live there.

## Git conventions

- PR target is `prod`, not `main`/`master`.
- GameCube changes commit to the `dev` branch (current active branch). The standalone `gamecube` branch is stale (pre-emulator era) — do not use it.
- Do not commit `node_modules`, `.env`, `config.js`, `send.email.ts`, `*.jsdos`, `*.zip`, ROM `.iso` files, or `emsdk` artifacts beyond what is already tracked (see `.gitignore`).
- Large generated files (vendored emulator binaries, split ROM parts) are tracked intentionally — don't "clean them up."

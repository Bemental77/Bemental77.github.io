# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Pre-action gates (mandatory)

These are forced rules — not guidance. Violations have happened repeatedly across sessions; the user has explicitly called out the pattern as "abhorrent." If you catch yourself about to skip a gate, STOP and run the gate.

1. **Before any test / probe / measurement action** for an emulator: read `dreamcast/docs/*/TASKS.md` (or `gamecube/docs/*/TASKS.md`) — the documented command lives there. Dreamcast iterations use `dreamcast/build_and_probe.sh`. GameCube iterations use three discrete foreground steps (no wrapper — the root `build_and_probe.sh` was deleted by user directive 2026-05-30 and is forbidden to re-introduce; see GameCube section below). Do not improvise (no manual `emcc`, no browser-only test when a Node probe exists). Probe output: Dreamcast = `/tmp/probe-dc.log` (or `/tmp/dc-probes/<name>.log` with `--name`); GameCube = `/tmp/probe.log` (stdout redirect) + `/tmp/probe-trace.json` / `/tmp/probe-metrics.json` — the GC probe takes no flags; configure via `PROBE_*` env vars (`PROBE_DURATION_MS`, `PROBE_QUERY`, `ROM_IDX` 0=SAB/1=PSO, `PROBE_TRACE_PATH`, `PROBE_METRICS_PATH`; see `gamecube/tools/dolphin_render_probe.js`). Each emulator's `docs/README.md` lists the full oracle/tool/test inventory — consult it before declaring "throughput" or "cache cold-start" as the next blocker; both have been wrong on the first try repeatedly. See `gamecube/docs/README.md` "failure mode this folder exists to prevent" and `dreamcast/docs/option2-direct-dispatch/README.md` for the rigor target.

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

## GameCube / Dolphin WASM build

This is an active R&D effort — not yet shipping. Four pieces interact:

- `gamecube/dolphin-src/` — Dolphin source tree, configured under `build-wasm/` for an Emscripten static-lib build (`dolphin_libretro` libretro target).
- `gamecube/bementalJIT/` — GameCube-local C++17 static library that Dolphin links against in place of its native JIT. Per-guest emitters live under `guests/<arch>/` (currently `powerpc` for Gekko and `powerpc-next` for the Phase 1 IR rebuild; no SH4). Block cache lives in `src/block_cache.cpp`.
- `gamecube/dolphin_libretro/` — final Emscripten link output: `dolphin_worker.js` (thin shim) + `dolphin_worker_emcc.{js,wasm}` (the real emcc output). Loaded by `gamecube.html`.
- `gamecube/ppc-worker/` — standalone PowerPC JIT worker (Phase 2 architecture: separate worker thread from `dolphin_worker`). Built via `gamecube/ppc-worker/build_ppc_worker.sh`, which also drives `gamecube/bementalJIT/build-emcc/` on first run. Outputs `ppc_worker.js` (shim) + `ppc_worker_emcc.{js,wasm}`. SAB layout shared with dolphin defined in `sab_layout.h`.
- `gamecube/dolphin-bridge/worker_funcs.js` — mailbox routing between `dolphin_worker` and `ppc-worker` (CompileBlock cmds, MMIO routing, PowerPCState mirror). Baked into `dolphin_worker_emcc.js` at link time via `--post-js` (`dolphin_worker_link.sh:76`) — not loaded by a `gamecube.html` script tag, so editing it requires a re-link.

There is **no wrapper script** — the root `build_and_probe.sh` was deleted by user directive 2026-05-30 (commit `270e38c`: "run the build right in front of me every single time") and must not be re-introduced. The canonical inner-loop is three discrete foreground steps, each run to completion (no `run_in_background`) with its output read before the next:

```bash
# 1. build
source emsdk/emsdk_env.sh && cd gamecube/dolphin-src/build-wasm && emmake make dolphin_libretro -j4
# 2. link — produces gamecube/dolphin_libretro/dolphin_worker_emcc.{js,wasm}
bash gamecube/dolphin-bridge/dolphin_worker_link.sh
# 3. probe — headless Chrome via puppeteer; configure with PROBE_* env vars (no flags)
node gamecube/tools/dolphin_render_probe.js > /tmp/probe.log 2>&1
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
- `dreamcast/build_and_probe.sh` — canonical Dreamcast inner-loop (build → link → Node probe). Probe output: `/tmp/dc-probes/<name>.log`.
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

## Claude harness enforcement (`.claude/`)

The pre-action gates are not just prose — hooks configured in `.claude/settings.json` enforce them mechanically (`.claude/settings.local.json` holds the per-user permissions allowlist):

- `.claude/hooks/preflight.sh` (PreToolUse on Bash) — warns on foot-guns: improvised HTTP ports (gate #2), manual `emcc`/`em++`/`emmake` outside the canonical flow, browser-open instead of the Node probe, `lsof`/`netstat` instead of reading `package.json`.
- `.claude/hooks/verify_fresh_probe.sh` (PostToolUse on Bash) — the MECHANICAL BUILD/FRESHNESS GATE: FAIL if the build log has errors, the worker `.wasm` is older than the newest source file, or the probe log is near-empty. Do not report probe results on anything but PASS (gate #8).
- `.claude/hooks/no_time_no_defer.sh` (Stop) — blocks turns containing time estimates or deferral phrasing ("Want me to…", "Should I…").
- `.claude/hooks/claim_discipline.sh` (Stop) — blocks turns making confident factual claims with no citation or hedge marker (gate #6).

Treat hook output as binding user feedback, not noise.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

This is Casey Bement's personal site deployed to GitHub Pages (CNAME, `.nojekyll`). It is not a single app — it is a collection of static HTML pages plus several self-contained sub-projects, each with its own build system (or none). There is no top-level build for the site itself; HTML/JS files are served as-is.

- **Deploy branch is `prod`** (not `main`/`master`). Feature branches merge into `prod` via PR. `master` exists but is not the deploy target.
- Top-level `package.json` / `tsconfig.json` exist but are only used by `handler.js` + `serverless.yml` (an AWS Lambda `sendEmail` endpoint via Serverless Framework). Most of the repo is plain static HTML.
- The top-level `README.md` is an unmodified `create-next-app` boilerplate left over from an old experiment — ignore it; this is not a Next.js project.

## Sub-projects

Each has its own toolchain — run commands inside the subdirectory.

| Path | What it is | Build/run |
|---|---|---|
| `ps1/ps1Wasm/` | PS1 WebAssembly emulator (derived from `kxkx5150/PCSX-wasm`) | Static — served from `ps1.html`. Source in `pcsx-wasm-src/` (Emscripten Makefile, fastcomp v1.37.40) |
| `n64/N64Wasm`, `snes/snesWasm`, `gba/gbaWasm` | WebAssembly emulators with bundled `emsdk` | Static — served from corresponding `*.html` |
| `gamecube/` | Dolphin libretro WASM build + custom JIT (in active development) | See **GameCube / Dolphin** below |
| `bementalJIT/` | Guest-agnostic WASM JIT-builder library (PowerPC/SH4 emitters) | CMake — consumed by `gamecube/` via `add_subdirectory` |
| root `*.html` | Portfolio pages (`index`, `about`, `resume`, `contact`, `playground`, `gamecube`, etc.) | Static |

## WASM emulator architecture (ps1/n64/snes/gba/gamecube)

All emulators follow the same pattern and share a critical constraint:

1. **Cross-origin isolation is required** for `SharedArrayBuffer`. This is set up by `coi-serviceworker.js` at the site root — every emulator HTML page loads it early. If `crossOriginIsolated === false`, emulators will silently fail to start the worker thread. Do not remove the `<script src="/coi-serviceworker.js">` tag.
2. **Main thread ↔ worker split.** Each emulator has a `*_worker.js` + `*.wasm` running the CPU loop off-thread, and a main-thread `*.min.js` (or equivalent) that owns the canvas/audio. They communicate via `postMessage` (with transferables for framebuffers and audio buffers).
3. **Binaries are vendored.** The `dist/` directories contain minified/compiled artifacts produced by Emscripten elsewhere — do not hand-edit them without understanding they are generated. For PS1, source lives at `ps1/ps1Wasm/pcsx-wasm-src/` and uses the old `emsdk fastcomp` toolchain (v1.37.40) per its Makefile; the top-level `emsdk/` is the modern Emscripten SDK used by the GameCube/Dolphin WASM build.
4. **ROMs over 100 MB are split.** See `ps1/ps1Wasm/roms/MonsterRancher2.bin.partaa…partaf` and `ps1/ps1Wasm/dist/romlist.js` — the loader fetches chunks and concatenates them client-side to stay under GitHub's file-size limit.

When editing the PS1 emulator specifically, the current JS-side patches (performance.now shims, `_gettimeofday` counter, diag logs) live in `ps1/ps1Wasm/dist/wasmpsx_worker.js`, and `ps1/ps1Wasm/dist/wasmpsx.min.js` is the main-thread controller.

## GameCube / Dolphin WASM build

This is an active R&D effort — not yet shipping. Three pieces interact:

- `gamecube/dolphin-src/` — Dolphin source tree, configured under `build-wasm/` for an Emscripten static-lib build (`dolphin_libretro` libretro target).
- `bementalJIT/` — repo-root C++17 static library that Dolphin links against in place of its native JIT. Per-guest emitters live under `guests/<arch>/` (currently `powerpc` for Gekko, plus an SH4 stub) and are gated by CMake options. Block cache lives in `src/block_cache.cpp`.
- `gamecube/dolphin_libretro/` — final Emscripten link output (`dolphin_worker.js`, `dolphin_worker.wasm`, etc.) loaded by `gamecube.html`.

The canonical inner-loop is `build_and_probe.sh` at the repo root — it sources `emsdk_env.sh`, runs `emmake make dolphin_libretro` in `build-wasm/`, runs the link script at `/tmp/dolphin_worker_link.sh`, then runs a Node-based render probe and prints a fixed summary (canvas non-black check, jit-inner traces, HLE replace counts, frame counts, VI/XFB events, installed patches). Use this single script for build/link/probe iterations rather than running emcc/make ad hoc — permissions are configured for it.

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
- GameCube changes commit to the `gamecube` branch first, then merge to `prod`.
- Do not commit `node_modules`, `.env`, `config.js`, `send.email.ts`, `*.jsdos`, `*.zip`, ROM `.iso` files, or `emsdk` artifacts beyond what is already tracked (see `.gitignore`).
- Large generated files (vendored emulator binaries, split ROM parts) are tracked intentionally — don't "clean them up."

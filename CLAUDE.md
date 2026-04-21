# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

This is Casey Bement's personal site deployed to GitHub Pages (CNAME, `.nojekyll`). It is not a single app — it is a collection of static HTML pages plus several self-contained sub-projects, each with its own build system (or none). There is no top-level build for the site itself; HTML/JS files are served as-is.

- **Main branch is `prod`** (not `main`). Feature branches merge into `prod` via PR.
- Top-level `package.json` / `tsconfig.json` / `next.config.*` exist but are only used by `handler.js` + `serverless.yml` (an AWS Lambda `sendEmail` endpoint via Serverless Framework). Most of the repo is plain static HTML.

## Sub-projects

Each has its own toolchain — run commands inside the subdirectory.

| Path | What it is | Build/run |
|---|---|---|
| `mkScoreboad/` | Create React App (TypeScript) — Diablo-themed scoreboard | `npm start` (port 8000), `npm run build`, `npm test` |
| `ps1/ps1Wasm/` | PS1 WebAssembly emulator (derived from `kxkx5150/PCSX-wasm`) | Static — served from `ps1.html`. Source in `pcsx-wasm-src/` (Emscripten Makefile) |
| `n64/N64Wasm`, `snes/snesWasm`, `gba/gbaWasm` | WebAssembly emulators with bundled `emsdk` | Static — served from corresponding `*.html` |
| `map/` | Canvas-based game (desktop + mobile variants) | Static — served from `map.html` |
| root `*.html` | Portfolio pages (`index`, `about`, `resume`, `contact`, `playground`, etc.) | Static |

## WASM emulator architecture (ps1/n64/snes/gba)

All emulators follow the same pattern and share a critical constraint:

1. **Cross-origin isolation is required** for `SharedArrayBuffer`. This is set up by `coi-serviceworker.js` at the site root — every emulator HTML page loads it early. If `crossOriginIsolated === false`, emulators will silently fail to start the worker thread. Do not remove the `<script src="/coi-serviceworker.js">` tag.
2. **Main thread ↔ worker split.** Each emulator has a `*_worker.js` + `*.wasm` running the CPU loop off-thread, and a main-thread `*.min.js` that owns the canvas/audio. They communicate via `postMessage` (with transferables for framebuffers and audio buffers).
3. **Binaries are vendored.** The `dist/` directories contain minified/compiled artifacts produced by Emscripten elsewhere — do not hand-edit them without understanding they are generated. For PS1, source lives at `ps1/ps1Wasm/pcsx-wasm-src/` and uses the old `emsdk fastcomp` toolchain (v1.37.40) per its Makefile; `n64/emsdk` and `snes/emsdk` are full bundled Emscripten SDKs.
4. **ROMs over 100 MB are split.** See `ps1/ps1Wasm/roms/MonsterRancher2.bin.partaa…partaf` and `ps1/ps1Wasm/dist/romlist.js` — the loader fetches chunks and concatenates them client-side to stay under GitHub's file-size limit.

When editing the PS1 emulator specifically, the current JS-side patches (performance.now shims, `_gettimeofday` counter, diag logs) live in `ps1/ps1Wasm/dist/wasmpsx_worker.js`, and `ps1/ps1Wasm/dist/wasmpsx.min.js` is the main-thread controller.

## Searching minified JS

The emulator JS files in `ps1/ps1Wasm/dist/` are minified. Use the included helper rather than grepping raw:

```bash
node tools/jsearch.js <file> "<pattern>" --context 300 --max 5
node tools/jsearch.js <file> --pretty          # writes /tmp/<name>.pretty.js
node tools/jsearch.js <file> --extract <name>  # extract a named function/var block
```

## Lambda email handler

`handler.js` + `serverless.yml` define a single AWS Lambda (`nodejs18.x`) that accepts POST `/hello` and sends mail via nodemailer. `send.email.ts` / `send.email.js` are the business logic. Deployed via `sls deploy` (Serverless Framework v3). `send.email.ts` and `config.js` are gitignored — secrets live there.

## Git conventions

- PR target is `prod`, not `main`/`master`.
- Do not commit `node_modules`, `.env`, `config.js`, `send.email.ts`, `*.jsdos`, `*.zip`, or the `emsdk` artifacts beyond what is already tracked (see `.gitignore`).
- Large generated files (vendored emulator binaries, split ROM parts) are tracked intentionally — don't "clean them up."

# Dreamcast SH4 Boot — Currently Blocked

**Date:** 2026-05-16
**State:** Boot reaches `hw_render.context_reset returned` then hangs. SH4 dispatcher's `mainloop()` never enters. `compile()` never runs.

## What we know

1. **All earlier-today "boot working" probes were running CACHED wasm** from a previous (yesterday or earlier) build state. The emsdk `clang-20` binary was missing (broken symlink at `emsdk/upstream/bin/clang -> clang-20`), so every `bash dreamcast/build_and_probe.sh` silently failed at the emcc compile step and reused the cached `dreamcast/flycast_libretro/flycast_worker_emcc.wasm` from yesterday. Reinstalled emsdk via `./emsdk install 3.1.67` (700MB redownload). Builds now genuinely produce fresh wasm.

2. **Fresh builds from the current source can't reach SH4 dispatch.** The probe log stops at:
   ```
   [flycast-worker] hw_render.context_reset returned
   [flycast-worker] run_iter enter #1
   [flycast-shim] run_iter threw: transferredCanvasNames is not iterable
   [flycast-worker] run_iter enter #2
   (no exit, no further log)
   ```
   `run_iter #2` enters `retro_run()` and never returns. No `[debug] mainloop ENTER` log fires. No `compile()` call fires.

3. **Three deep researchers ran in parallel** with the following conclusions:
   - **Researcher A** (retro_run hang): pointed at `-sPROXY_TO_PTHREAD=1` removal in `flycast_worker_link.sh`. **WRONG** — restoring it broke WebGL context creation entirely (FATAL: emscripten_webgl_create_context failed). Reverted.
   - **Researcher B** (wasm_emit byte audit): `build_block()` is byte-equivalent pre/post-refactor. **CLEAN.**
   - **Researcher C** (JS audit): `flycast_worker_funcs.js` is structurally sound, no deadlock paths, init order is correct. **CLEAN.**

4. **What I've ruled out:**
   - Agent #1 epoch refactor (disabled epoch in `compile()` — boot still hangs).
   - Agent #2 cycle-drain emit (commented out — boot still hangs).
   - wasm_emit byte regression (researcher B).
   - JS-side init-order or signature breakage (researcher C).
   - `PROXY_TO_PTHREAD` removal (restoring breaks WebGL).
   - `PTHREAD_POOL_SIZE=8` (no change).
   - `config::ThreadedRendering.override(false)` to bypass std::async (no change).
   - Stale `rec_wasm.cpp.o` in `libflycast_libretro.a` (force-rebuilt archive — no change).

5. **What's still suspect:**
   - The `transferredCanvasNames is not iterable` throw on `run_iter #1` — this is Emscripten's `glsm_ctl(GLSM_CTL_STATE_BIND)` failing. It also appeared in the cached-wasm "working" probes, but somehow boot continued past it there.
   - The combination of `OFFSCREENCANVAS_SUPPORT=1`, the `MIN_WEBGL_VERSION=2`/`MAX_WEBGL_VERSION=2`, `--pre-js webgl2-compat.js`, `--js-library gl_override.js` link flags + the C++ canvas-transfer logic — there's some misalignment between the canvas-on-pthread setup and what `glsm_ctl` expects.
   - The accumulated diff in `EmscriptenWorker.cpp` (today, untracked) — many additions including `g_hw_render`, custom log_cb, `hw_get_current_framebuffer_cb`, ThreadedRendering force, etc. None obviously the cause but the surface area is large.

## Backups

- `/tmp/dc-session-backup/` — copies of `rec_wasm.cpp`, `flycast_worker_funcs.js`, `wasm_emit.cpp`, `wasm_emit.h` from this morning's state (with agent changes).
- `/tmp/rec_wasm.cpp.with_agents_1_and_2` — earlier rec_wasm before my disable-epoch edits.

## Next steps (not done)

1. **Bisect**: revert dreamcast/flycast-bridge/* to HEAD baseline + selectively re-apply session changes. Find which specific change broke the canvas-transfer chain. Time estimate: M-L.

2. **Examine `OFFSCREENCANVAS_SUPPORT` + `glsm_ctl` interaction**: the canvas-throw is Emscripten internal. Either the link flag changed semantics or our C++ canvas setup needs updating to match. Reference: Emscripten 3.1.67 source for `transferredCanvasNames` usage.

3. **Compare cached wasm vs fresh wasm symbol-by-symbol**: `wasm-objdump` both. Find what's structurally different. Could reveal whether the cached wasm used a different link config.

4. **Run native flycast on PSO** for ground truth: `/tmp/flycast-lr2/flycast_libretro.dylib` exists. We can mount BIOS + run PSO natively to confirm what should happen. Already done earlier this session — REIOS HLE only, but confirms PSO disc layout is correct.

## What user should do

Provide any of the following if known:

- **What date the cached wasm was built**, if you remember (helps bisect).
- **Whether dreamcast.html boot worked recently** in a real browser (not just probe), and what changed since.
- **Authorization to git-revert** `dreamcast/flycast-bridge/EmscriptenWorker.cpp` + `flycast_worker_link.sh` to HEAD baseline (loses all session work in those files) — then I can re-apply the morning's SPG fixes on top.

## Today's work that REMAINS uncommitted

- `bementalJIT/guests/sh4/wasm_emit.cpp` + `.h` — agent #1 single-module epoch refactor + agent #2 cycle drain (commented). Researcher B says byte-equivalent — keepable.
- `dreamcast/flycast-bridge/rec_wasm.cpp` — agent #1 epoch state + flush_epoch + my disable comments. Larger than HEAD by ~700 lines.
- `dreamcast/flycast-bridge/flycast_worker_funcs.js` — agent #1 epoch JS. Researcher C clean.
- `dreamcast/flycast-bridge/EmscriptenWorker.cpp` — morning's SPG instrumentation + MMIO trace.
- `dreamcast/flycast-bridge/flycast_worker_link.sh` — accumulated link flag changes.
- `dreamcast/Flycast.opt`, `dreamcast/build_and_probe.sh`, `dreamcast/run_native_flycast.sh`, `dreamcast/tools/sh4dis.py`, etc. — new tooling.

Total LOC delta: ~3K added across the session, much of it useful diagnostic + the morning's SPG forced-raise fix that proved the VBLANK_IN scheduler-bucket bug. Don't lose it without backup.

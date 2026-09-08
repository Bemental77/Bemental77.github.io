# flycast-bridge

Bridge layer between upstream Flycast (`dreamcast/flycast-src/`) and our
Emscripten/WASM build with the `bementalJIT` SH4 dynarec.

## ⚠ THE SOURCE OF TRUTH IS THE TRACKED TREE, NOT `patches/`

Read this before trusting anything below it.

`dreamcast/flycast-src/` **is** edited in place, and always has been. The
"never edited in place" convention this README used to claim was not the
reality on disk: 33 files differ from upstream flycast `4be8a48` and the
numbered patch series covers only 23 of them. Ten ported files
(`gdromv3.cpp`, `holly_intc.cpp`, `maple_if.cpp`, `blockmanager.cpp`,
`driver.cpp`, `sh4_interpreter.cpp`, `sh4_interrupts.cpp`, `sh4_sched.cpp`,
`reios.cpp`, and one `#include` inside the `DreamPicoPort-API` submodule)
have no patch at all.

That gap had a cost. On 2026-09-07 eight ported files silently reverted to
pristine upstream; the tree was gitignored wholesale, so nothing recorded the
loss and no commit bisect could find it. Two of the lost edits killed the boot
and one compiled out the entire ARM7 dynarec.
Write-up: `dreamcast/docs/core-relink-broken/TASKS.md`.

**Since then:**

* The 34 ported files are **tracked in git in place**, via a `!`-negation
  block in the repo-root `.gitignore`. A reversion is now an ordinary
  `git diff`.
* `dreamcast/tools/verify_core_tree.sh` audits the tree by comparing **blob
  hashes** against the upstream commit the nested checkout sits on, and runs
  automatically from `dreamcast/build_and_probe.sh` and
  `flycast_worker_link.sh` — a drifted tree cannot produce a binary.
  * `--restore` recovers a reverted file from the outer repo.
  * `--sync-gitignore` re-records the port set after you add a new ported file.
* **Do not verify this tree with `patch --dry-run`.** It lied in both
  directions here: BSD `patch` silently skips already-applied hunks and still
  exits 0, and fuzzy matching applied a `FEAT_AREC` hunk against the wrong one
  of `build.h`'s four identical `#define FEAT_AREC DYNAREC_NONE` lines.

`patches/` is kept as the **historical record** of how each change came about,
and `0022` in particular documents the recovery. It is not a complete
description of the tree and must not be used as one.

## Patch convention (historical)

The original intent: all modifications live as numbered `.patch` files under
`patches/`, applied by `apply_patches.sh` before each `emcmake` configure, so
flycast could be `git pull`ed cleanly and the deltas re-applied.

The same shape as `gamecube/dolphin-bridge/` for the GameCube/Dolphin port.

## Apply

```bash
./apply_patches.sh
```

Idempotent — safe to run repeatedly. Refuses to run if `flycast-src/` is
missing or carries unrelated uncommitted edits to the touched files. Prints
one line per patch: `applied`, `skipped (already applied)`, or `failed`.

## Patches

- `0001-emscripten-host-cpu.patch` — adds `CPU_WASM` to `core/build.h`,
  wires `HOST_CPU = CPU_WASM` and SH4-only dynarec defaults under
  `__EMSCRIPTEN__` (FEAT_AREC and FEAT_DSPREC fall back to interpreter).
- `0002-detect-architecture-wasm.patch` — teaches
  `shell/cmake/DetectArchitecture.cmake` to emit `wasm32` under
  `__EMSCRIPTEN__`.
- `0003-cmake-libretro-static-and-rec-wasm.patch` — under `EMSCRIPTEN`
  flips libretro from SHARED to STATIC, adds the wasm32 recompiler branch
  that pulls in `flycast-bridge/rec_wasm.cpp` and `add_subdirectory`s
  `bementalJIT/` with `BEMENTAL_GUEST_SH4=ON`.
- `0004-disable-host-backends.patch` — under `EMSCRIPTEN` disables
  Vulkan/DX/OpenMP/Lua/Breakpad/host SDL/host libchdr/host libzip/GDB and
  the host audio backends, forces the libretro GLES3 path, and adds
  `-sUSE_WEBGL2=1 -sFULL_ES3=1` to the libretro target.

## Companion files

- `rec_wasm.cpp` (authored separately) — implements `Sh4Dynarec` from
  `core/hw/sh4/dyna/ngen.h` against the `bementalJIT` SH4 emitter.

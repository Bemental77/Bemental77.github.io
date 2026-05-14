# flycast-bridge

Bridge layer between upstream Flycast (`dreamcast/flycast-src/`) and our
Emscripten/WASM build with the `bementalJIT` SH4 dynarec.

## Patch convention

`dreamcast/flycast-src/` is treated as upstream — **never edited in place**.
All modifications live as numbered `.patch` files under `patches/` and are
applied by `apply_patches.sh` before each `emcmake` configure. This way we
can `git pull` flycast cleanly and re-apply our deltas.

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

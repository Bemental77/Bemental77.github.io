# GameCube native-port via decompilation (wasm recomp)

**The route:** run Mario Party 4's own code as compiled WebAssembly instead of
dynamically translating the Gekko CPU at runtime. There is no dynamic binary
translator in this path, so the ~20%-of-native DBT ceiling that caps the JIT
emulator does not apply — the CPU-bound game logic becomes ordinary compiled wasm
at native-wasm throughput. This is the static/native-port lineage (decomp → wasm),
not emulation.

## Validated foundation (2026-08-21, measured with emcc from ~/emsdk-upstream)

- MP4 decomp at `~/gc_refs/marioparty4`: **510 game C files, only 2 asm-only**,
  byte-matching `build/GMPE01_01/main.elf`. Full SDK implementation source is
  carried too: `src/dolphin` = **88 C files** (card/exi/thp/dvd/pad/si/ar/…),
  plus `src/msm` (MusyX), `src/libhu`, `MSL_C` (Metrowerks stdlib), Runtime, TRK.
- Game logic is portable C: **0 inline-asm files in `src`**. The only inline asm in
  the include tree is **8 `asm{}` blocks in one header** (`dolphin/os/OSFastCast.h`,
  float→int casts) — replaced portably in `shims/dolphin/os/OSFastCast.h`.
- **Proof it reaches wasm:** `src/game/armem.c` compiled to a real WebAssembly
  binary module (12,897 bytes; `file` reports "WebAssembly binary module") with
  only the OSFastCast shim + decomp-era compiler flags.
- **Compile surface (emcc `-fsyntax-only`, shim + `-std=gnu89`
  `-Wno-implicit-function-declaration`):**
  - `src/game/*.c`: **28 / 50** clean; remaining are the same shimmable class
    (`ext_math.h` Metrowerks construct → 9 files, one root cause; missing
    `musyx/*.h` middleware headers; a few type mismatches).
  - `src/dolphin/*.c` (SDK): **50 / 88** clean; the 38 failures are the low-level
    hardware primitives (OS context/interrupt/cache, GX FIFO, VI, DSP) — these are
    the host boundary, not port blockers.

## The boundary (what compiles vs what becomes a host layer)

- **Compiles to wasm (the CPU work):** game logic + high-level SDK, with a small
  set of portable header shims (OSFastCast done; `ext_math`, `musyx` stubs next)
  and decomp-era compiler flags, and `MSL_C` replaced by Emscripten's libc.
- **Host layer (reuse the existing emulator's device side, ~12% util per
  `/tmp/worker_2.cpuprofile`):** GX display-list consumer → the existing WebGPU
  renderer; VI/vsync → the present path; DSP/AI → the audio path; DVD → file IO
  from the ROM; PAD/SI → the input path; OS threads/interrupts → a wasm scheduling
  model (cooperative fibers or a run loop).

## Link status (2026-08-21) — the authoritative-includes breakthrough

The signature-mismatch saga was **self-inflicted by ad-hoc `-I` flags.** The
decomp's own build (`build.ninja`, `wine mwcceppc.exe`) compiles each unit with
`-I include -I build/GMPE01_01/include -I extern/musyx/include`. Mirroring that:

- The **MusyX headers are not absent** — they are vendored at
  `extern/musyx/include/musyx/{musyx,seq}.h` and define `SND_GROUPID`/`SND_SONGID`.
  (The earlier `shims/musyx/musyx.h` stub was a wrong premise; removed.)
- **Every missing `.inc` binary asset** is in `build/GMPE01_01/include/`.

`build_wasm.sh` now stages those two dirs (`$BUILD/gen`, `$BUILD/extern/musyx/include`)
and adds them to CFLAGS with `-DVERSION=0 -fdeclspec`. Result:

- **127 objects build (74 `game`, 29 `board`); 1646 defined functions** including
  **450 `Board*`, 473 `Hu*`, 19 `om*`** — the real Mario Party 4 game logic.
- The object set **links with zero signature mismatches** under default
  gc-sections. The `canonicalize_and_link.py` global-prototype loop is no longer
  needed (and was harmful: its force-include clashed with the now-visible real
  headers, and a failed `emcc -c` clobbers the good object).

**Done (2026-08-21): the object set links with zero signature mismatches into a
real module.** `bash gamecube/recomp/build_wasm.sh` compiles the game logic and
links it (`--no-entry --no-gc-sections`, undefined = host imports) to a **real
~568 KB WebAssembly module — 2321 functions, 228 host imports, 0 signature
mismatches** — with the game logic **fully preserved** (456 `Board*`, 495 `Hu*`,
1665 total defined functions = the no-injection baseline; nothing dropped).

The last mwcc decl≠def inconsistencies were reconciled with behavior-preserving,
in-place transforms baked into `build_wasm.sh`, in two parts:

- **8 compile-fix perl transforms** (ext_math `;`, three static-decl
  reconciliations, `omAddObjEx` fn-pointer param, `CARDRdwr`/`EXIUart` lvalue
  casts, `HuSetVecF` double→f32, `PPCSync` int→void, `__GXAbortWaitPECopyDone`
  version-`#if` decl).
- **`gen_sig_fixes.py`** — the signature reconciler: iterates link → mismatch →
  inject each function's **real-type prototype** (from its definition, byte-identical
  to `main.elf`) into the outlier callers that implicit-declare it, and **truncate**
  over-arg call sites to the definition arity (mwcc dropped the extras). It emits
  `sig_fixes.json` (61 injections), which `build_wasm.sh` replays deterministically.
  Real-type prototypes (identical to the headers) are a legal redundant
  redeclaration and never conflict — an earlier wasm-class `void*` attempt dropped
  13 board files and was reverted. `canonicalize_and_link.py` is superseded/dead.

The **30 non-compiling units are the genuine host boundary** — inline-asm/hardware
OS kernel, GX setup, VI/AI/DVD/DSP, plus the excluded overlay (`REL/`, `kerent.c`)
and memory-card (`card/`) subsystems. Their symbols are the 228 imports = the host
layer below. The CPU-compile-and-link half is **complete**; the host layer is next.

## Next steps (in order)

0. Canonicalize the 11 (and any that surface) signature inconsistencies via staged-
   copy patches (definition signature = canonical), then the object set links clean.
1. Portable shims for the remaining low-level headers (`ext_math`, a `musyx` stub)
   so `src/game` + high-level `src/dolphin` compile to objects cleanly.
2. Emscripten libc for `MSL_C`; a compile driver that emits the object set.
3. Host layer: bind the compiled OS/GX/VI/DSP/DVD/PAD symbols to the existing
   emulator device implementations (renderer, audio, input, file IO).
4. OS scheduling model (the game uses cooperative threads + interrupt-driven VI/AI).
5. Link to a wasm module + boot; A/B the board against the JIT emulator.

## Honest scope / caveats

- **Per-game:** this needs a decomp. MP4 has a near-complete one (verified).
  Whether SAB / PSO have complete decomps is **not verified** — decomps are
  per-game and only MP4's is present here.
- The host layer (step 3–4) is the substantial work; the CPU-compile half is
  validated. The OS thread/interrupt model is the highest-uncertainty piece.
- This is additive: it does not touch the existing JIT emulator, which stays as
  the general path for games without a decomp.

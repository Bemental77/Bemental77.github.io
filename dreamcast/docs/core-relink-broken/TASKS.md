# The Dreamcast core could not be relinked — FIXED 2026-09-07

## Status: RESOLVED. A fresh relink boots both shipped games.

| game | guest rate | fps | non-black | evidence |
|---|---|---|---|---|
| `pso2` | **1.001x** | 30 | 99.6% | `/tmp/probe-dcx-pso2-final.log`, `/tmp/dc-shots/pso2.png` (Character Select) |
| `gauntlet` | **0.997x** | 30 | 83.0% | `/tmp/probe-dcx-gauntlet.log`, `/tmp/dc-shots/gauntlet.png` (3D attract) |

Both at `fields=30`, `=> RUNNING — frames are flowing`, hash-guard STABLE
(`flycast_worker_emcc.wasm` sha256=`90b543892bb3fe38`, size 8,704,796), audio
`HEALTHY — zero underrun after the boot ramp`, load 1.56–2.53. The 60 s PSO run
before them held `presented=30/s duty=28% headroom=3.6x capacity≈107fps`.

`retro_set_controller_port_device(1, RETRO_DEVICE_JOYPAD)` is IN and works:
`[maple] bus (type per slot, -1=empty): p0[1,-1,-1,-1,-1,0] p1[-1,-1,-1,-1,-1,0]`
— controllers (`MDT_SegaController=0`) on ports 0 **and** 1, VMU
(`MDT_SegaVMU=1`) in port 0's expansion slot A1. Player 2 has a Maple device, so
`input_state_cb` is polled for port 1.

## Root cause: `dreamcast/flycast-src/` is GITIGNORED and had silently drifted

`.gitignore:60` ignored the whole tree — `git ls-files dreamcast/flycast-src`
returned **0** of its 1,834 `.cpp` files. Nothing recorded its contents and
nothing warned when it changed. **[FIXED 2026-09-07 — the 34 ported files are
now tracked in place and a gate blocks the build; see "How to check for this
drift" below. The past tense in this section is the state at the time.]** Eight files had reverted to a pre-wasm-port state. Because
the shipped `.wasm` predated the drift, the damage was invisible until a relink.

Confirmed by diffing against the sibling checkout that commit `9441581f` says
this tree was synced from:

```
/Users/caseybement/Dev/dreamcastHtml/dreamcast/flycast-src     <-- SOURCE OF TRUTH
```

Exactly 8 files differed; `core/version.h` (a generated build stamp) is the only
legitimate one.

### The two edits that killed the boot

1. **`core/emulator.cpp` — `Emulator::start()` lost its `__EMSCRIPTEN__` guard**
   ```cpp
   config::ThreadedRendering.override(false);
   ```
   Without it flycast takes the `ThreadedRendering` branch and spawns its own
   `std::async` SH4 thread that races the worker's dispatch pump. The reference
   comment records the same trap being found before, via the trap stack
   `runInternal <- std::__async_assoc_state<...start()::$_0>`.

2. **`core/hw/sh4/dyna/ssa.cpp` — the read-only const-fold was re-enabled on wasm**
   The fold's safety depends on page-fault SMC (`bm_RamWriteAccess` from the
   SIGSEGV handler). WASM has no mprotect faults, so RAM code blocks stay
   `read_only=true` forever and the fold bakes in a STALE value. PSO's interrupt
   dispatcher (guest `0x8c379a88`) reads its latched INTEVT word `0x8c379b7c`,
   which lives in the dispatcher's own code page — so the fold froze it at
   `0x320` (VBlank) and routed **every** interrupt, Maple `0x360` included, to
   the VBlank handler. Maple bit12 never got acked ⇒ re-vector storm.

The observed failure was the downstream symptom: the guest stopped submitting
frames, so `PvrMessageQueue::dequeue`'s 20 ms `enqueueEvent.Wait(timeout)`
blocked on the worker's main runtime thread, which under `-sASYNCIFY` becomes
`_do_futex_wait -> _emscripten_yield -> emscripten_exit_with_live_runtime ->
throw "unwind"`. That unwound out of `retro_run` and the shim stopped the pump.

### The other six (correctness/perf, not boot)

| file | what was lost |
|---|---|
| `core/build.h` | `FEAT_AREC DYNAREC_JIT` (patch 0020's hunk). The **entire ARM7/AICA wasm dynarec compiled out** — `arm7_rec_wasm.cpp` is wrapped in `#if FEAT_AREC != DYNAREC_NONE`. |
| `core/hw/sh4/sh4_mem.cpp` | `smc_mark_range()` at the three `WriteMemBlock_nommu_{dma,ptr,sq}` chokepoints. Lever-4's invariant is that every write into a compiled code word bumps `g_ic_generation`; lever-5E1 **skips the per-lookup verify** when it hasn't moved. Without these a DMA burst overwrites compiled code and the JIT keeps running the stale block. |
| `core/hw/maple/maple_cfg.cpp` | VMU on bus 0 expansion slot A1 (the `g_vmu_flash_ptr` bridge was dead code without it). |
| `core/hw/aica/sgc_if.cpp` | patch 0021 disabled-channel hoist. |
| `core/rend/TexCache.{cpp,h}` | patch 0018 wasm VRAM source hash + RTT exclusion. |
| `core/rend/gles/{gles.cpp,gles.h,gltex.cpp}` | patch 0017 mobile precision / FBO diagnostics. |
| `shell/libretro/libretro.cpp` | `flycast_set_fog` / `flycast_set_modvol`, defined in a **core** TU. |

## How to check for this drift — THERE IS NOW A GATE, AND IT IS AUTOMATIC

```bash
bash dreamcast/tools/verify_core_tree.sh          # audit; exit 1 on drift
bash dreamcast/tools/verify_core_tree.sh --restore        # put a reverted file back
bash dreamcast/tools/verify_core_tree.sh --sync-gitignore # record a NEW ported file
```

It runs on its own from `dreamcast/build_and_probe.sh` (before the archive
build) and from `dreamcast/flycast-bridge/flycast_worker_link.sh` (before it
writes anything), so **a drifted tree can no longer produce a binary**.
`DC_CORE_AUDIT=off` skips it behind a loud banner; that is not a fix.

The structural half of the fix is that the tree is **no longer ignored
wholesale**. `.gitignore` now carries a `!`-negation block naming the 34 files
that differ from upstream, so a reversion shows up as a plain
`git status` / `git diff` entry and `git checkout` gets it back.
`git ls-files dreamcast/flycast-src | wc -l` returns **34**, not 0.

What the audit checks — blob hashes against the upstream commit the nested
checkout sits on, no patch tooling anywhere in the path:

| check | meaning | verdict |
|---|---|---|
| C1 REVERTED | a tracked ported file is byte-identical to upstream — the edit is GONE | FAIL |
| C2 MISSING | a tracked ported file is not on disk | FAIL |
| C3 UNRECORDED | a file differs from upstream but the repo does not track it — the next silent-reversion victim | FAIL |
| C4 | a tracked file differs from outer HEAD — ordinary in-progress work | reported, never fails |
| C5 UPSTREAM BASE MOVED | the nested checkout is no longer on the commit the port set was recorded against, so every C1 verdict silently changed meaning | FAIL |

Demonstrated firing 2026-09-07: `git -C dreamcast/flycast-src checkout HEAD --
core/emulator.cpp` (the exact shape of the incident) dropped
`config::ThreadedRendering.override(false)`, and

* `git status` showed ` M dreamcast/flycast-src/core/emulator.cpp`;
* the audit printed **REVERTED TO UPSTREAM (1)** and exited 1;
* `flycast_worker_link.sh` exited **1** without touching
  `flycast_worker_emcc.wasm` (sha256 `14bddf42b8255a0c…`, mtime unchanged);
* `build_and_probe.sh` exited **1** and never reached the archive build or the probe;
* `--restore` returned the file byte-exactly (sha256
  `ac0f6d8773b6530a56079eb7c8adf113cf972e3354a6de73251e696198d86c37`) and the
  audit went back to PASS.

C3 was demonstrated separately by appending a line to the untracked
`core/hw/aica/aica.cpp`: **UNRECORDED PORT EDITS (1)**, exit 1. C5 was
demonstrated by falsifying the recorded base: **UPSTREAM BASE MOVED**, exit 1.
The base is pinned in `.gitignore`'s managed block as
`# upstream-base: 4be8a484665fb5684ccb780ed2165018a679c622`.

⚠ **`patch --dry-run` is still forbidden as a check**, for the reasons below,
and the patch series is INCOMPLETE besides — it covers 24 of the 33 flycast
files that differ from upstream (verified: `grep -h '^+++ b/' patches/*.patch |
sort -u` = 24 paths, `comm` against the drift set leaves 9 uncovered, plus the
DreamPicoPort-API one = 10 with no patch at all). BSD `patch` silently skips already-applied
hunks and still exits 0, and fuzzy matching applied a `FEAT_AREC` hunk against
the wrong one of `build.h`'s four identical `#define FEAT_AREC DYNAREC_NONE`
lines.

The sibling checkout is no longer the authority — the repo is:

```
/Users/caseybement/Dev/dreamcastHtml/dreamcast/flycast-src   <-- second opinion only
```

## The technique that found it, worth reusing

Symbol names first, then body sizes — both from the `--emit-symbol-map` output
and the wasm code section, no rebuild needed:

* **name-set diff** (good vs broken) surfaced `smc_mark_range` present in the
  shipped binary and absent from the relink, plus the whole
  `aica::arm::Arm7WasmEmitter` family — that is what exposed `FEAT_AREC`.
* **per-function body-size diff** then reduced the search to **6 differing
  bodies out of 4,898 common ones**, four of which were my own edits. The two
  left were `Emulator::start()` (−21 bytes) and `compilePC`. `Emulator::start()`
  was the boot bug.

A working binary is a complete record of the source that built it. Diff against
it before bisecting commits — commits could never have found this, because the
drifted tree is not in git.

## What was ELIMINATED on the way (do not re-investigate)

Each of these was a full build+probe A/B on the canonical loop, and each still
reproduced the identical crash (`sh4_pc=0x8c379a42 spc=0x8c378d72`):

* **The emsdk.** Both the shipped and the relinked glue are emscripten **6.0.2**
  (`emcc -v`). The "3.1.67" string in both files is the link script's own patch
  comment (`flycast_worker_link.sh:400-405`), **not** a toolchain stamp — do not
  read it as one.
* **`retro_set_controller_port_device(1, ...)`** — re-A/B'd on the fully
  restored tree; boots with it in.
* **`config::Option::override()` called from `EmscriptenWorker.cpp`** (the
  restored `flycast_set_fog`/`flycast_set_modvol`) — neutralising both bodies
  changed nothing. They have since been moved to `libretro.cpp` anyway, which is
  where the reference puts them and where the `Option` layout is correct.
* **`LEVER14_PREF_NARROW_SYNC`** in `bementalJIT/guests/sh4/wasm_emit.cpp` —
  built with the author's own `=0` byte-for-byte revert switch; no change.
* **`c5b70e2e` + `63e654f9`** (the delete-7851-files incident and its repair) —
  `git diff c5b70e2e^ 63e654f9 -- bementalJIT dreamcast` is **empty**; the
  restore was byte-identical. Not a suspect.
* **The VMU** — restoring it made `[maple]` match the shipped binary exactly and
  the crash was unchanged. It was lost work worth restoring, not the cause.

## ⚠ Two landmines of the same class — BOTH CLOSED

1. ~~`dreamcast/flycast-bridge/arm7_rec_wasm.cpp` is UNTRACKED~~ — **committed
   in `b974360e`.** `flycast_worker_link.sh:314` compiles it by name; verified
   tracked 2026-09-07.
2. ~~HEAD does not compile on its own — `wasm_module_builder.h` was missing
   `ifDepth()`~~ — **committed.** `git show HEAD:bementalJIT/include/bementalJIT/wasm_module_builder.h`
   contains `u32 ifDepth() const { return _ifDepth; }` at :690.

Audited 2026-09-07 against the link script's own file list
(`flycast_worker_link.sh:311-314, 387-389`): every input it names by name —
`EmscriptenWorker.cpp`, `flycast_stubs.cpp`, `rec_wasm.cpp`,
`arm7_rec_wasm.cpp`, `webgl2-compat.js`, `gl_override.js`,
`flycast_worker_funcs.js` — is tracked, and no source file under
`bementalJIT/` is untracked or ignored.

## Tooling added

* `flycast_probe.js --game <key>` + `build_and_probe.sh --game <key>` — sets
  `dreamcast.html`'s `#romSelect` through the DOM before Start. Until now the
  canonical loop could only ever boot `pso2`, so "the core boots" was a one-game
  claim and **gauntlet — the 4-player co-op title the online mode exists for —
  was unreachable**. Same gap class as `--loadstate` / `--ctxms` / `--profat`.
* `EmscriptenWorker.cpp` now logs the **whole** Maple bus, not just slot A1:
  `[maple] bus (type per slot, -1=empty): p0[...] p1[...] p2[...] p3[...]`.
  The old single-slot probe could not tell "no VMU" from "no devices at all",
  which are very different faults. One line, once, at load.

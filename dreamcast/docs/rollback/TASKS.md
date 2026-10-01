# Dreamcast rollback at input delay 0: blocked on the shipped core (measured 2026-10-01)

> **UPDATE 2026-10-01 (second pass).** Three sources of non-determinism are now
> identified by measurement, and C++ patches for all three are written as files
> under `patches/` (unbuilt). A JS-only lever on the SHIPPED binary turns REF1 vs
> REF2 from VOID into 61/61. Rollback (REF==RB) is still NOT exact on the shipped
> binary; the last residue needs the rebuild. See "Second pass" at the bottom.

## Status: NOT FEASIBLE on the shipped binary. dreamcast.html stays on delay-based lockstep, and the room panel now says why.

The user requirement is zero local input lag, i.e. rollback at delay 0. That is
how genesis.html already runs. This card records why Dreamcast cannot do the
same yet, with the numbers, the exact blockers, and the command that re-measures them.

## The command (gate #1)

```bash
npm run web                                   # tools/devserver.mjs, port 8080
node tools/browser_leak_guard.js reap && uptime
PUPPETEER_FROM=$HOME/probe-deps/ bash tools/probe_lock.sh run -- \
  node dreamcast/tools/rollback_measure.mjs --game pso2 \
       --state dreamcast/states/pso2_pioneer2_lobby.state --name pso-lobby \
       --frames 180 --every 3 --lag 4 --warm 120 --reps 8
# -> /tmp/dc-rb/<name>.log / .json / -scene.png / -end.png
```

The rig modifies no shipped file. It injects a stepwise driver into the live
worker and stops the wall-paced pump. Each frame is one `_emscripten_run_iter()`,
and saves and loads go through the SHIPPED exports (`_emscripten_save_state` /
`_emscripten_load_state`).
⚠ It evaluates in the worker over raw CDP (`Runtime.evaluate`). puppeteer
25.12's `WebWorker.evaluate()` waits for an execution-context event that never
arrives for this worker, and three runs hung there forever. The pthread pool
also shares the URL `flycast_worker.js`, so the rig picks the worker that owns
`Module._emscripten_run_iter`.

## Measured (run 5)

- **wasm:** md5 `eec9ff8ccc0f2036d1d9435f7e2f84a6`, STABLE before and after.
- **load:** 2.42 before, 7.69 after (sibling agents running).
- **Chrome:** headless, software GL.
- **Scene:** Pioneer 2 3D, shown in `-end.png`. The `-scene.png` shot was taken
  while the driver had not yet yielded, so it shows a stale character-select canvas.

| quantity | value |
|---|---|
| state size | **27,652,485 B** |
| save (`retro_serialize`) | 4.98 ms p50 / 5.46 p90 |
| load (`retro_unserialize` + IC invalidate + JIT flush) | **47.9 ms p50** / 50.0 p90 |
| steady frame, no load (PSO renders at 30 fps; budget 33.3 ms) | 10.4 ms p50 |
| frame #1 after a load | **325 ms p50** (247–400) |
| frame #2 / #3 / #4 after a load | 145 / 52 / 34 ms p50 |
| first 8 frames after a load, summed | **691 ms p50** |
| inside the RB arm: whole rollback step (load + resim + present), lag 4, 26 rollbacks, max depth 4 | **1,487 ms p50** / 1,847 p90 |

**Blocker 1: cost.** `Emulator::loadstate` (`flycast-src/core/emulator.cpp:902-920`)
calls `getSh4Executor()->ResetCache()`. That runs `bm_ResetCache()`, then
`WasmDynarec::reset()`, then `jit_clear()` (`rec_wasm.cpp:2356-2423`). So EVERY
load throws away every compiled SH4 block, and the frames after it recompile.
One restore costs more than 20 frames of budget. Rollback needs a restore on
every misprediction, potentially every frame.

**Blocker 2: exactness.** REF1 and REF2 are the same anchor, the same scripted
pads and the same process, and they already diverge at the 3rd frame
(`selfREF1vsREF2 {"compared":61,"matched":1,"firstDiverge":3}`). The rig
therefore prints VOID for the rollback comparison. A run started from a restored
state does not reproduce itself, so a rollback could not re-simulate onto a peer's
trajectory even if it were free. This agrees with `determinism_probe.mjs`'s own
record that `--equalize` (identical bytes pushed into both instances) still left
2/552 chunks differing. I have not identified the cause. Candidates named in the
tree:
- the shard seal phase (`s_dispatch_count`, history-dependent; compiled routes
  and span-interpreted routes charge different cycles, `rec_wasm.cpp:805-822`);
- `s_isk_streak` (the idle-skip streak, a function-static that no savestate
  carries, `rec_wasm.cpp:~1611`);
- host time reaching the guest (the VMU clock, `maple_devs.cpp`).

**Blocker 3: this box cannot rebuild the core.** `dreamcast/flycast-src/` holds
only the 35 tracked ported files. There is no nested upstream checkout, no
`build-wasm/`, and no prebuilt `.a` archives anywhere on disk. The link script
compiles only the four bridge TUs, against archives that do not exist, and
`verify_core_tree.sh` FAILS (degraded, no `.git`). Any fix to blockers 1–2 is
C++, so it needs that tree reconstructed first: upstream flycast `4be8a48` plus
submodules, then the port overlay, then emcmake.

## What would unblock it (in order)

1. Reconstruct the build: nested checkout at
   `4be8a484665fb5684ccb780ed2165018a679c622`, then `verify_core_tree.sh` PASS,
   then `build-wasm`.
2. Add a rollback load path that does NOT flush the JIT: skip `ResetCache` /
   `jit_clear`, keep `flycast_ic_invalidate`, and rely on the per-lookup
   `ram_code_sum` SMC check. Add a save into a preallocated ring slot (no malloc).
   Add an audio-drop flag for re-simulated frames. Video needs no change, because
   frames run in one task present only the last (OffscreenCanvas swap is implicit).
3. Make the trajectory independent of host history, then prove it with this
   rig's REF1==REF2 arm, then REF==RB, then cross-instance:
   - routing must not depend on seal phase or block-table history;
   - `s_isk_streak` must be reset per frame or serialized.
4. Only then put the worker-side ring + resim pump and the page integration in
   place, modelled on `genesis.html` `rbRunFrame`, with lockstep kept as the fallback.


---

## Second pass (2026-10-01): what breaks determinism, measured

All runs: PSO `pso2_pioneer2_lobby.state`, wasm md5 `eec9ff8ccc0f2036d1d9435f7e2f84a6`,
stable before and after every run. Each batch held `tools/probe_lock.sh`.
Load 9.7–22 (sibling agents), so **every ms figure below is noise-dominated**.
The exactness results are byte comparisons and do not depend on load.

### New rig modes (`dreamcast/tools/rollback_measure.mjs`)

- `--diag N` keeps a byte copy of every start-of-frame state of three straight
  runs from one anchor, D1, D2 and D3. It diffs them and attributes each range:
  main RAM is located by content through the shipped `sh4_mem_read32`, and
  everything else is reported as `small@offset` with hex. It also logs guest
  cycles per frame.
- `--replay F,T` adds RP: it loads the frame-F state MID-RUN and re-runs to T with
  the same pads. **D2 vs RP is the pure REF==RB question, with no prediction
  logic involved.**
- `--pre JS` runs once before the anchor; this is how the no-rebuild levers are
  applied. `--onload JS` runs after every load.
- `--rbload` (needs patch 0002) switches every load to the keep-code path.
- `--reload-each` makes every frame start from a load of its own state.
- The RB comparison now lists every diverged frame, not only the first.

### Results

| arm (`--pre`) | test | result |
|---|---|---|
| none (shipped default) | D1/D2/D3 diag | D2 vs D3 **diverge at frame 1**; guest RAM counters are off by one (`0x8c40bf44 fe01..`/`fd01..`) |
| `M._flycast_set_idleskip(0)` | D1/D2/D3 diag | D2 vs D3 **byte-identical, all 7 states** |
| none | full rig, 180 f | REF1 vs REF2 **VOID @3** (reproduces run 5) |
| idle-skip off | full rig, 180 f, same batch | **REF1 == REF2, 61/61**; REF vs NOINPUT differs (control OK); RB vs REF diverges @3 |
| idle-skip off | `--replay 2,8` | RP vs D2: **11,796 B differ at f3** (ARM7 regs, AICA channels, 582 RAM ranges); still 147 B at f8 |
| idle-skip off + `M._flycast_set_shard(0)` | `--replay 2,8` (×3) | RP vs D2: **41 B at f3 only** (SH4 regs + 2 RAM bytes); **f4–f8 byte-identical** |
| idle-skip off + shard off | full rig, 90 f | REF1 == REF2 31/31; **RB vs REF diverges at EVERY hashed frame from 3** |
| idle-skip off + shard off + `--reload-each` | full rig | renderer died at the RB arm (`Target closed`): every full-flush load leaks wasm instances, and REF2 frames had grown to 10 s |

Guest cycles per frame (`--replay`, identical in all three repeats):

```
D1/D2/D3 (from anchor load): 6672064, 6673408, 6672512, 6672960, 6672512, 6672960 ...
RP (load at frame 2):        -,       -,       6672064, 6673408, 6672512, 6672960 ...
```

**The first frame after ANY load is exactly one SH4_TIMESLICE (448 cycles)
shorter, and the second is 448 longer.** The pattern follows the load, not the
guest position. The state saved immediately after a load is byte-identical to the
one loaded (f2 = 0 B). So the cause is state that the savestate does NOT carry.

### Sources of non-determinism, by status

1. **Idle-skip streak: PROVEN.** `s_isk_streak` is a function-static
   (`rec_wasm.cpp:1625`) that no savestate carries and nothing resets. The matched
   pair above is the proof. *No-rebuild lever:* `_flycast_set_idleskip(0)`. Patch
   0001 zeroes it at every `run_iter` start and on every load, so the state at the
   start of a frame fully determines that frame. Zeroing it on load alone is not
   enough for rollback.
2. **Shard pending-span route: PROVEN.** After a load the block table is empty.
   Blocks compiled while pending span-interpret until their shard seals, and the
   two routes charge different cycles. Where that happens depends on where the
   load happened (11,796 B vs 41 B above). *No-rebuild lever:*
   `_flycast_set_shard(0)`. Patch 0002's rollback mode runs per-block install.
3. **Post-load frame-boundary shift (one slice): MEASURED, MECHANISM OPEN.**
   With true pads the trajectory reconverges by the next frame. Under rollback the
   resimulated pads are applied around the shifted boundary, and RB never rejoins
   REF. The scheduler fields that ARE serialized round-trip exactly, so this is
   unserialized state:
   - The `tmu_sched` entries are not in `sh4_sched_serialize` for V58+ states
     (`sh4_sched.cpp:273`).
   - `sh4_sched_next_id` is recomputed.
   - Possibly an `Event::LoadState` listener in upstream files this box does not
     have.

   Patch 0001 adds `sh4_sched_debug_dump` (every `sch_list` entry, `ffb`, `next`,
   `next_id`), and the rig prints `DIAG SCHED` differences automatically when the
   export exists. **The first rebuilt run of `--diag 8 --replay 2,8` names the
   field.**
4. **Host wall time reaching state:**
   - `SH4FastEnough` = host speed, from `spg.cpp:195-206`, `getTimeMs()`. Its
     consumers are in upstream files that are not on this box, so impact is
     unverified. Patch 0001 pins it when `g_deterministic` is set.
   - The 2 s frame watchdog (`rec_wasm.cpp:2460`) is suspended under
     `g_deterministic`. It never fired in any run here (`watchdog=0`).
5. **Ruled out by source read:**
   - RTC: pinned at `aica_if.cpp:74`.
   - VMU clock: pinned at `maple_devs.cpp:722`.
   - Console ID: reads the pinned RTC.
   - Audio thread: `audio_sample_batch_cb` drops on overflow and never blocks
     (`EmscriptenWorker.cpp:1010`), so no backpressure reaches the guest.
   - JIT install timing: `new WebAssembly.Module` is synchronous
     (`flycast_worker_funcs.js:159,216`), so seals are dispatch-count driven.
   - Worker pacing with `performance.now`: it decides WHEN a frame runs, not what
     it computes. The rig bypasses it entirely.
6. **Serialization-only artifact, not trajectory:** 7–8 bytes at state offset
   `0xa55fd9`, about 30 KB before main RAM in the SH4 icache/ocache block, differ
   between the FIRST run after the anchor save and every later one. Guest
   trajectory and every other byte stayed identical. Peer state hashes must
   exclude this range, or both peers must hash after the same load count.

### Patches (`patches/`, apply with `git apply` from the repo root, in order)

- `0001-deterministic-restore.patch`:
  - `rec_wasm.cpp`: `s_isk_streak` at file scope, zeroed in `reset()`; adds
    `flycast_rb_reset_host_history`, `g_deterministic` and
    `flycast_set_deterministic`, and gates the watchdog on it.
  - `EmscriptenWorker.cpp`: resets the streak at every `run_iter` start and after
    `emscripten_load_state`.
  - `sh4_sched.cpp`: `sh4_sched_debug_dump`.
  - `spg.cpp`: pins `SH4FastEnough`.
- `0002-rollback-keep-code-load.patch`:
  - `emulator.cpp` `emu_loadstate_keepcode` and `libretro.cpp`
    `retro_unserialize_keepcode`: `loadstate` without `ResetCache`.
  - `rec_wasm.cpp`:
    - snapshots the code pages before the load and memcmps them after;
    - drops whole install UNITS whose code changed (a shard's members tail-link
      each other unverified, `wasm_emit.cpp:2648`);
    - rollback mode = shard off + stale-hit → discard + recompile + `g_rb_parks`
      counter;
    - falls back to the full flush when MMU is on, or when a park or pending span
      sits on a changed page.
  - `EmscriptenWorker.cpp`:
    - `emscripten_load_state_rollback` (1 = kept, 2 = fell back, 0 = failed);
    - `emscripten_set_rollback_mode`;
    - `emscripten_state_size` and `emscripten_save_state_into` (ring slot, one
      serializer pass instead of the two `emscripten_save_state` does);
    - `emscripten_rb_mute_audio`.

  Every new function is `EMSCRIPTEN_KEEPALIVE`; no link-list edit is needed.

**Neither patch has been compiled.** This box cannot build the core, and the
upstream clone needed to build it was refused by the permission system in this
session.

### Exact rebuild steps (once the upstream tree is available)

```bash
# 1. tree: nested upstream checkout at 4be8a484665fb5684ccb780ed2165018a679c622
#    (+ submodules, --depth 1) INSIDE dreamcast/flycast-src, then restore the port:
bash dreamcast/tools/verify_core_tree.sh --restore && bash dreamcast/tools/verify_core_tree.sh   # must PASS
# 2. patches
git apply dreamcast/docs/rollback/patches/0001-deterministic-restore.patch
git apply dreamcast/docs/rollback/patches/0002-rollback-keep-code-load.patch
# 3. build + link (builds flycast_libretro too, aborts on failure)
bash dreamcast/build_and_probe.sh
grep -o -a -F "sh4_sched_debug_dump" dreamcast/flycast_libretro/flycast_worker_emcc.wasm | wc -l   # >0
# 4. prove, in this order (npm run web first; reap + uptime; probe lock)
R="node dreamcast/tools/rollback_measure.mjs --game pso2 --state dreamcast/states/pso2_pioneer2_lobby.state --warm 120"
$R --diag 8 --replay 2,8 --name p1-diag            # idle-skip ON now: D2==D3 expected; DIAG SCHED names source 3
$R --frames 180 --every 3 --lag 4 --reps 8 --name p1-ref          # REF1==REF2 with idle-skip ON
$R --frames 180 --every 3 --lag 4 --reps 8 --rbload --name p2-rb  # REF==RB, rbLoadCounts.fullFlushFallbacks==0, cost
```

REF==RB is expected to need the source-3 fix first. Once `DIAG SCHED` has named
the field, serialize it (or restore it after `dc_deserialize`), then re-run the
last two lines. Integrate into `dreamcast.html` only when REF==RB holds, with
`--rbload` and a whole-step cost under one frame.

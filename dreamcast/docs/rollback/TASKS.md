# Dreamcast rollback at input delay 0: blocked on the shipped core (measured 2026-10-01)

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

# Dreamcast governor pacing: why PSO ran below 1.000x with "28% duty" (measured 2026-10-03/04)

## Answer

- **The guest was not short of 1.000x because the governor threw time away.
  It was short because the worker thread was not free.** After every task
  that renders a frame, Chrome holds the worker thread for about 27 ms while
  the GPU process takes the frame. That hold is not inside `run_iter`, so the
  page never counted it.
  - Pioneer 2 lobby on this box: 624-772 ms of every second was held,
    measured between `pumpTick` returning and the next task starting. Every
    other message handler in the worker took about 1 ms per second.
  - Per-thread CPU over 10 s (`/proc/<pid>/task/*/stat`): the GPU process's
    four SwiftShader raster threads ran at 69-70% each, and the
    `DedicatedWorker` thread ran at 30%.
  - So `duty` read 23-37% and `headroom` read 2.2-3.6x on a worker that could
    not fit one more frame. With the hold counted, the same scene reads
    **duty 96-100% (emu 26-34% + render-hold 64-77%), headroom 0.8-1.0x**.
- **The governor's drops were a symptom.** In the original worker, the
  governor asked for 132-255 ms of sleep per second and got 424-782 ms. A
  timer cannot fire inside the hold. Each late wake left the guest 25-76 ms
  behind, and the 17 ms behind-rebase then dropped that time: 3-8 drops and
  59-313 ms of guest time per second.
  - Replacing the timer and keeping the debt did not change the rate
    (0.74-0.96x per heartbeat, never one sleep).
  - The cause is render throughput, not the governor.
- **0.885x vs 1.0002x is the scene.** `bench_page_test.mjs --room 0` lands on
  CHARACTER SELECT (screenshot `/tmp/bench-dreamcast.png`). A menu leaves
  render headroom, and the original worker reads 1.0001x there too. The
  documented probe (`build_and_probe.sh --skip-link`) runs in the Pioneer 2
  lobby (3D), and this box cannot render that at 30/s.
  - Same pattern as `room-determinism/TASKS.md` §5 (0.67-0.69x).
  - Same pattern as the `build_and_probe.sh` header, which reads 0.9998x at
    37% duty. That figure came from a quieter box, under the old duty that
    omitted the hold.

## What changed (`flycast_worker.js`, `dreamcast.html`)

1. **The render hold is measured.** The worker reports `heldMs`: wall time
   between one pump task ending and the next one starting, minus any timer wait
   it asked for. The page counts it as occupied time:
   - `duty = (busy + held) / wall`;
   - the heartbeat prints `duty=N% (emu A% + render-hold B%)`;
   - headroom, cost and capacity follow from that duty.
2. **The pace sleep is a deadline.**
   - The frame task ends first, so the frame presents immediately and is never
     held behind a sleep.
   - The next task waits out only what is LEFT of the deadline with
     `Atomics.wait`, which wakes in under 1 ms. The render hold has already
     used up part of the wait.
   - The worker then hops through the message queue, so a pad message that
     arrived during the wait runs before the frame, as it did with the timer.
   - The timer path remains as a fallback when there is no
     `SharedArrayBuffer`.
3. **Debt is repaid, not dropped, up to 100 ms (`CATCHUP_MAX_MS`).**
   - A frame that ends behind is followed by the next frame with no sleep,
     until the guest is level with the wall clock. A frame that ends ahead
     sleeps, so the guest never passes the wall clock.
   - Beyond 100 ms (background tab, load, a device without capacity), only the
     EXCESS is dropped.
   - A one-second window after a late one can read above 1.000x by at most the
     repaid debt, so at most 1.10x. The cumulative guest clock never passes the
     wall clock.
   - edf596e had cut the window from 250 ms to 17 ms because 250 ms allowed
     1.18x windows.
4. The heartbeat gains `gov=drop<ms>/<n> lag<ms> sleep<asked>/<got>ms`. A
   worker with headroom reads `drop0`.

## Evidence

All runs held `tools/probe_lock.sh`. wasm `eec9ff8ccc0f2036d1d9435f7e2f84a6`
and emcc js `cca4105d…` were STABLE before and after every probe run. The page
on 8080 was `node tools/devserver.mjs` and served the working-tree files
(md5 checked). Load was 2.8-5.4 on a 4-core box throughout.

### Before (original worker `580c139d`, diagnostic counters only)

`/tmp/probe-dcx-gov-diag1.log`, Pioneer 2, load 5.36. Values are per
1 s window, over the 54 steady windows after the seed restore:

| field | value |
|---|---|
| guest advanced | 701-968 ms |
| busy | 212-381 ms |
| sleep asked | 132-255 ms |
| sleep got | 424-782 ms |
| behind-rebases | 3-8 |
| guest ms dropped | 59-313 |
| lead range | −76 … +26 ms |
| AICA lines | 0.852-0.932x |
| heartbeat guest | 0.659-0.932x |

### Diagnosis runs

- `gov-diag2`: timer replaced, debt kept. The worker never slept, and the
  heartbeat read 0.69-0.92x. Between pump tasks, 624-772 ms per second was
  idle; the longest single gap was 73-118 ms. Other handlers took 1-6 ms over
  57-64 calls.
- `gov-diag3`: the per-thread CPU split quoted in the Answer. Load 2.8-3.8.

### After (final worker), documented probe ×3

Command: `build_and_probe.sh --skip-link --duration 60000`, Pioneer 2.

| run | load | AICA mean | heartbeat guest (last 15) | duty (emu + render-hold) |
|---|---|---|---|---|
| fix2-p1 | 3.76-4.29 | 0.8795 | 0.862 | 99% (30 + 69) |
| fix2-p2 | 4.29-4.00 | 0.8767 | 0.886 | 99% (30 + 69) |
| fix2-p3 | 4.00-4.28 | 0.9097 | 0.885 | 99% (31 + 68) |

Same rate as before. Duty and headroom are now honest: 0.8-0.9x, below
hardware, flagged in the arm colour.

### Bench ×3, interleaved

Command: `bench_page_test.mjs --pages dreamcast --room 0 --sec 40`, character
select. The original worker and the final worker were swapped in place,
alternating, all under one lock.

| pair | load | original `580c139d` | final |
|---|---|---|---|
| 1 | 3.9-4.4 | 1.0001 (2399 f, over 0) | 1.0002 (2401 f, over 0) |
| 2 | 4.6-4.9 | 1.0001 (2399 f, over 0) | 0.9999 (2397 f, over 0) |
| 3 | 5.3-5.4 | 1.0001 (2397 f, over 0) | 1.0002 (2402 f, over 0) |

Three more runs of the final worker, earlier in a separate batch: 1.0000,
1.0002, 1.0004 (over 0).

The bench speed is the AICA ratio (`aicaX`, `/44101.43`). Where there is
headroom, both workers deliver 1.000x. ±0.0004 is one 30 fps frame in a 40 s
window (2401 vs 2400).

### Model (`dreamcast/tools/governor_sim.mjs`)

The decision logic under a late timer, with 3x headroom:

| governor | rate | dropped |
|---|---|---|
| old | 0.749x | 251 ms/s |
| new | 1.000x | 0 |

Under this box's Pioneer 2 costs, both give 0.877x. The new governor's worst
lead at the start of a frame is 0.88 ms (sub-ms sleeps are skipped).

## Open

- The render hold is a property of this headless SwiftShader box. The release
  build has no GPU, and a WebGL frame from a worker appears to be handed off
  synchronously in Chrome's software path. The mechanism is NOT verified in
  Chromium source; the measured fact is the hold and the GPU-process CPU. A
  real GPU should hold far less. The page now shows the hold, so a field
  report says which one a device is short on.
- The 100 ms repay cap was chosen as six 60 Hz fields. It is not tuned against
  a throttled phone. Re-run `tools/netplay_device_matrix.mjs` dc:mobile to see
  the window maxima under the new cap.

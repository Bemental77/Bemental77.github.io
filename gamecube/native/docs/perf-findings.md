# MP4 native port: performance findings

This is a record of what was measured, so dead ends aren't run twice. Numbers come from the commit messages
named and from the matched-pair runs reported when each idea was tried. Each one was measured on the box of
its day, so compare within a row, not across rows.

Terms used below:

- **x** is the guest clock. 1.000 is full speed, and the guest never runs faster than that.
- **"Toaster"** is `mp4n_toaster_room2.mjs` with a CPU quota on the renderer (rate 6.2 before the container
  change, 3.9 after it) and SwiftShader as the GPU.
- **"Unthrottled"** is the same rig with no quota.

## Levers that landed

| Commit | Change | Measured |
|---|---|---|
| 5599ab9 | The game never waits for the GPU (undrawn scratch frames) | GPU wait 46.8 -> 0.0 ms/frame; guest 0.26x -> 1.00x on this VM's software GPU |
| a7ab81a | JSPI solo build (no Asyncify) | wasm 9.98 -> 6.50 MB; CPU 7.22 vs 7.56-8.06 ms/frame |
| 15d2bfb | Copy-on-write rollback savestates | memory 652 -> 256 MB flat; ~0.1 ms save, ~1 ms restore |
| b05284f | Desktop room on rollback, toaster room on delay lockstep | desktop room 0.895x -> 0.994-0.996x; toaster room 0.34x -> 0.957x |
| 885cba7 | Inline store check; staging uploads of used bytes only | toaster rollback 0.745x -> 0.89-0.96x |
| 3d7bd43 | Barrier coalescing (one check per straight-line store run) | desktop rollback room renderer 3.9 -> 3.27 ms/frame |
| 5430c6f | No ImGui frame on the web; audio through an AudioWorklet | toaster rollback renderer -16% |
| 8996a02 | No `navigator.getGamepads()` per frame without a pad | toaster rollback renderer -12% |
| 6b136f4 | No empty encoder/submit on undrawn frames | toaster board renderer -6.6% |
| 49776c9 | SIMD polyphase taps in the board audio DSP | renderer -7% |
| 6857b1f | MusyX voice resampling on the AX structure | toaster solo board x 0.710 -> 0.761; renderer 4.68 -> 4.42 ms |
| de8516c | MusyX sample-level work moves to the AudioWorklet | PCM identical (12.8M frames) |
| 862f053, ca8487a | Fewer executed barrier checks; Aurora's hot locals kept in registers | checked-store executions 1.65e9 -> 1.17e9 on the board census |
| d8953ad | Aurora log level INFO (per-frame debug lines no longer formatted) | ~0.9% of toaster room main-thread busy; room x 0.920/0.914/0.968 -> 0.939/0.948/0.968 |
| 264e3d3 | Audio log resends a sample chunk only when the render module lacks it | toaster room x 0.907/0.921/0.842 -> 0.928/0.936/0.907; sample bytes 194 -> 4.3 MB per 400 s |
| 988f1c9 | No texture-replacement TLUT copies on the web | `GXLoadTlut` was 2.8% of toaster room busy; rb unthrottled 3.42/3.19/3.22 -> 3.27/3.21/3.07 ms |
| b8a5fd0 | A frame known undrawn at `begin_frame` uses the scratch area | forced-undrawn renderer 3.02-3.46 vs 3.42-3.74 ms; GPU 0.03 vs ~2.5 ms/frame |
| aea0759 | `sleep(0)` yields through a MessageChannel, not a 4 ms-clamped timer | all 2,081 measured `sleep(0)` calls took >= 4 ms (mean 6.35); room x on the throttled rig unchanged |
| b27402e | `C_MTXConcat` / `C_MTXROMultVecArray` on wasm SIMD, in scalar order | unthrottled renderer: rb -8%, Asyncify -5%, JSPI -3.5% |
| adc93e0 | GX matrices go through a per-frame table, not into every draw's uniform | uniform upload 441 -> 157 KB per drawn frame; drawn-frame busy 6.356 -> 6.072 ms (no-submit, 9 pairs) |

## Rejected or parked, and the measurement that killed each

- **Lazy register file (defer BP/XF handling).** Not built; the ceiling was measured first.
  - Ceiling test: skip every BP and XF handler on undrawn frames. This is incorrect, so it is a pure upper bound.
  - Result: renderer ~3.42 -> ~3.31 ms/frame. Skipping BP alone or XF alone measured nothing.
  - About 90% of BP writes already return at the decoder's unchanged-value check (7.5k of 8.3k per frame).
  - Audit traps for any future attempt: 0xE0-0xE7 carry two targets, 0x65 is an action, and several derived
    fields are written by more than one register.
- **BP redundant-write dedup.** No measurable difference. The decoder's unchanged-value early return already
  catches about 90% of BP writes.
- **Display lists processed in place** (`GXCallDisplayList` decoding where the list sits instead of copying it
  into the FIFO). Reverted.
  - Unthrottled renderer: rb about +0.17 ms (slower), Asyncify about -0.15 ms, JSPI about -0.13 ms.
  - One toaster room pair: 0.925 vs 0.956.
- **Display-list vertex cache** (16 MB persistent GPU arena, XXH3-128 keys). Exact and gated (0 of 55 pixel
  frames differ), hit rate 99.3-99.9%, but no gain. Parked.
  - Drawn-frame CPU: 10.29/11.96 ms with the cache vs 9.76/10.63 ms without.
  - Toaster solo: 1.23 vs 1.29 presents/s.
- **Per-draw encode dedup** (index buffer bound once per pass; `SetBindGroup(2)` and `SetBlendConstant`
  skipped when unchanged). Encode measured directly: 0.687 -> 0.593 ms per drawn frame (-0.09 ms); main-thread
  pairs within noise. Not shipped.
  - Draw merging was not attempted: consecutive draws that share pipeline and textures never share a uniform
    (0 of 227).
- **Pipeline fast path** (return an existing pipeline without building its `std::function` callback). 8 pairs
  in no-submit mode: +0.19 ms (slower), 3 of 8 lower.
  - The ablation that reused one pipeline for every draw read -0.32 ms, probably because it also removed
    pipeline switches in encode. Not verified separately.
  - SIMD xxhash (bit-identical, 2x faster on 1.5 KB) together with a direct-write uniform build: +0.09 ms,
    within noise.
- **Speculative pre-logging of the rollback undo log** (log last frame's pages at the boundary).
  - Unthrottled: frames 0.4 ms cheaper, but the boundary went 0.11 -> 1.20 ms.
  - Toaster solo x: 0.779 with it vs 0.885 without.
  - One bulk copy costs more than scattered copy-on-write copies. My guess is cache: a page copied on its first
    write is about to be used and stays in cache.
- **Finer copy-on-write blocks.** The game writes 516 pages (2,065 KB) per frame. At 1 KB blocks it is
  1,267 KB, and at 512 B it is 1,071 KB.
  - That is a 1.6-1.9x cut for 2.5-4x more slow-path calls, against a ~0.6 MB bar. Not built.
  - Changed bytes alone are 432-534 KB. The rest is written but unchanged, and copy-on-write has to copy it too.
- **Asyncify trim** (instrument only the recorded suspend paths).
  - The trimmed solo build gained +4.4 / +7.5%, and the trimmed room pairs +6-9%.
  - But the trimmed rollback build froze in long rooms: one late freeze with a fiber's Asyncify data parked and
    never resumed. A second hang turned out to be the frame-4 bug in `rollback.c`, which the full build also
    had (fixed in bdd8abf).
  - The static add-list variant (`ASYNCIFY_IGNORE_INDIRECT` plus a 1,294-pattern list) trapped in `SDL_main`
    at boot in 3 of 3 runs. Dropped.
- **Precise pacer waking** (arm the timer early, then MessageChannel hops to the exact start).
  - Toaster room x 0.812-0.850 vs 0.831-0.940 on the base build.
  - The p90 timer lateness is >= 10 ms, so it needed about 480 hops per frame. Even a 2 ms lead raised renderer
    time 4.7 -> 5.2 ms. Reverted.
- **Binary input messages.** Loopback pair, renderer CPU per frame: JSON 6.70/6.69 ms, binary 6.44/6.74 ms, no
  send 5.47/5.99 ms.
  - Messaging costs about 0.95 ms, and binary saves about 0.1 ms of it. The cost is the DataChannel transport,
    not JSON. Not built.
- **Input-message elision in rooms** (send only on change, plus a periodic "unchanged through frame N").
  Dropped before building.
  - The census looked favourable: on the party route the local pad image changed on 1.14% of frames
    (scripted) and 0.63% (keyboard). Analog sticks were not measurable on the rig.
  - But in `lib/netplay.js` each input message's arrival is also the room's timing signal, and eliding
    messages biases three things:
    - **Advantage.** `_rbAdvBy` (about line 4009) is the local frame minus the newest frame received, sampled
      every frame. It is the clock `rbCatchUp` runs from and is sent to peers as `av`. A confirm every 4 frames
      lags the newest frame by about 1.5 frames, so peers would see the console as behind and catch up to a lag
      that isn't there.
    - **The rollback-window frontier.** `_rbNewestBy` feeds the "solid" frontier (about lines 4296, 4406 and
      5346). Elision eats up to cadence - 1 frames of the window.
    - **Host acks and the redundancy window.** `ak` rides every second message, and the limp and NAK logic
      reads arrivals. K = 4 frames would no longer cover the gap.
  - Doing it right means changing the clock and window maths of the engine every emulator shares, for a gain
    of about 0.7 ms per frame (toaster) on steady input and about 0 during stick play.
- **FIFO memo** (skip display lists that repeat the previous frame verbatim). The FIFO is 444 KB per frame.
  - Display lists are 308 KB of it and repeat 100% verbatim; command runs between them repeat 61.5%.
  - The repeated bytes are mostly vertex data, which undrawn frames already skip in O(1). The cost that remains
    is state handling, which is exact only if entry state matches.
  - Ceiling: a fraction of ~0.4 ms, at high correctness risk. Not built.
- **Uniform and storage-array dedup** (drawn-frame census). Only 3.8% of uniform blocks and 2.5% of storage
  bytes repeat within a frame. Not built.

## Rig notes

- **No-submit mode is the clean drawn-frame rig.** A diagnostic build records and encodes each frame but skips
  `Queue.Submit` (`Module.mp4NoSubmit = 1`). It is run unthrottled, every frame drawn, on the solo board,
  frames 2000-4000.
  - Without it, SwiftShader's CPU use contaminates main-thread time on drawn frames. "~10 vs ~4.7 ms"
    drawn/undrawn read 5.47 vs 2.08 ms with no submit, so drawing costs about 3.4 ms of host CPU.
- **SwiftShader limits.** On the toaster, presentation is GPU-bound at about 1.2-1.3 presents/s. Host-side draw
  savings do not raise it there. Don't chase the rig's GPU side as if it were real hardware.
- **Calibration.** The toaster's CPU quota is calibrated per run: 7 benchmark samples, interquartile spread,
  and a device-model check that voids the run when it misses.
  - The auto factor once moved 0.85-1.19 between runs, and that read as a "regression" (7dd461c added FWIN
    fixed guest-frame windows and the CALFIX pin).
  - After the container changed, the box was ~1.8x slower. Never pool numbers across boxes.
- **Ablate, don't trust the profile.** Profiles misattribute cost in two ways:
  - JS-side buffer copies: `_emwgpuBufferWriteMappedRange` profiled at 0.52 ms/frame, but skipping it measured
    -0.05 ms.
  - Calls that wait on another thread. Size every lever with matched ablations on one binary, interleaved, and
    build only above the bar.
- **The LFS stat artifact.** After dist is restored, `git status` can still show the wasm files as `M`. If
  `git hash-object` equals the HEAD blob, nothing changed; it is the LFS filter attribute's stat data.
- **Objects rebuild only on a source timestamp.** `build.sh` recompiles an object only when its source is newer.
  A compile-flag change (for example `-msimd128` on one file) is silently ignored until that `.o` is deleted
  from `/home/user/mp4native/build/obj/`.
- **Layout.** Any static added before `game_e` moves game addresses. The routes read omcurovl at 0x95b3b5c, so
  check the link map after every change. Allocate host tables at run time, or link new statics after `game_e`.

## Where the remaining time goes

- **Drawn frame, no-submit, unthrottled, solo board** (5.47 ms busy vs 2.08 undrawn). The pooled ablation
  ceilings are:
  - storage-array push about -0.39 ms;
  - uniform build and push about -0.32 ms (adc93e0 took -0.28 of it);
  - pipeline lookup about -0.32 ms;
  - encode about -0.44 ms;
  - draw calls about -0.60 ms;
  - index generation about -0.37 ms;
  - vertex push about -0.45 ms.

  Each is spread over data movement: 794 KB of vertex arrays and 307 KB of vertices per frame. No single cheap
  exact cut remains above 0.3 ms.
- **Rollback room on the toaster, per frame:**
  - barrier checks about 0.9 ms;
  - undo-log copies about 1.0-1.4 ms (memory-bound);
  - re-simulated frames about 1 ms on the console that re-simulates;
  - rollback hook extras about 0.3-0.4 ms;
  - input messaging about 0.95 ms (DataChannel transport).
- **Delay room on the toaster:** x 0.986 vs solo 1.000. The cost is debt from presented frames: each takes 28-29
  ms of work, about 26 ms over a period, and the 1.0167x repayment cap can't clear it. Waiting on the peer adds
  about 0.9 ms/frame on one console.

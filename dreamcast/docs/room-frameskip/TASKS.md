# Dreamcast rooms: render-level frame skip (measured 2026-10-05)

## Follow-up (2026-10-06): on Chrome's default renderer the present is slow, not the raster

Live caseybement.com (prod 125abf0) read solo 1.0034x and room 0.9238x (1109 frames,
18 ms mean) with headless Chrome **without** `--use-angle=swiftshader`. With that flag
both read 1.000x. The fence rule above did not help on that arm, and this section says why.

### Where each console's second went (shipped code, before the fix)

Rig: a prodmirror snapshot of the tree (`git archive`), `?bench=1&benchauto=1&benchsec=20`,
headless, a fresh profile, no `--use-angle`. Each run held the probe lock. wasm
`eec9ff8c` was STABLE, and load was 3.7-5.2 on 4 cores. The values are the mean of
22 one-second worker windows, in ms per second. `gate` is new: it is the time parked
on the lockstep gate, which used to be counted inside render-hold.

| run | console | emu | render-hold | gate wait | sleep | gov drop | pictures/s |
|---|---|---|---|---|---|---|---|
| inst-df-1 | solo | 425 | 559 | 0 | 32 | 14 | 23.2 |
| inst-df-1 | room host | 399 | 503 | 80 | 1 | 190 | 12.4 |
| inst-df-1 | room joiner | 404 | 391 | 188 | 0 | 195 | 12.4 |
| inst-df-2 | solo | 440 | 538 | 0 | 38 | 9 | 23.6 |
| inst-df-2 | room host | 402 | 533 | 51 | 0 | 231 | 11.9 |
| inst-df-2 | room joiner | 409 | 410 | 165 | 0 | 222 | 12.2 |
| inst-sw-1 (with `--use-angle`) | room host | 561 | 21 | 108 | 217 | 0 | 7.6 |

- **Render-hold sets the limit.** Every picture that is drawn holds the worker thread
  while it is handed off: about 24 ms solo and about 44 ms per console in the room.
  The fences signal at once on this renderer, so the fence rule skipped only 3-16
  frames a second.
- **On the swiftshader arm it is the other way round.** The raster is slow, so the
  fences skip 22 of 30 frames. The hold is only 21-34 ms per second.
- **Waits on the peer are the consoles taking turns.** One console is held rendering
  while the other parks for its input. In each window, gate + render-hold + emu is
  close to the whole second for both consoles.
- **The main thread that the host and the iframe share was not measured on its own.**
  Its cost is inside the gate wait (the page's hop, at queue depth 1 or 2), and the
  gate wait is an upper bound for it: 51-188 ms/s before the fix, 7-26 ms/s after it.
- **Results:** room 0.7575-0.8073x with 38-133 seconds over budget; solo 0.9839-0.9948x.
- **The room never earned queue depth 1** on this arm, because every window dropped.
  It stayed at depth 2, delay 1.

### The fix (`flycast_worker.js`)

1. **A frame that starts behind skips its picture.** `fsBegin` gets the governor's lag
   at the start of the frame. If the frame starts more than `FSK.lagMs` (17 ms, one
   field) behind the wall clock, its draws into the window are swallowed, just as with
   a fence skip.
   - Render-to-texture is never skipped, and read-backs are still watched (see
     "What is skipped" above).
   - A device with headroom sleeps, so it is never behind and this rule never fires.
   - Arm: `?fskiplag=MS`, or `window.__DC_FSKIPLAG` for the bench iframe. `0` turns
     the rule off. The `ips` field `fs.lagSkips` counts these skips, and the
     heartbeat shows `(behindN)`.
2. **The governor's drop rule is unchanged** (excess past `CATCHUP_MAX_MS` dropped,
   100 ms kept owed). The alternative was shipped and then reverted; see below.
3. **New witnesses:**
   - `ips.gateMs` (shown on the page as `gate-wait=N%`);
   - `ips.aheadMs`: the furthest past the wall clock that any frame started in the
     window;
   - `ips.overMs`: debt beyond the cap, which `lsLookTune` now reads (today it
     equals `dropMs`);
   - `fps.wt`: the worker clock at the end of each heartbeat window;
   - `__dcProbe().pace` and `__dcProbe().hbMs`.

**Tried and rejected: writing a past-cap debt off whole** (`8ba46fd`; rooms reverted
in `c2f209e`, solo in `ea0be09`).
- The goal was to remove the 100 ms repayment second that follows a past-cap debt.
  That second reads aicaX 1.062 and 1.113 in the window right after the boot seed's
  114-315 ms drops, and it can fall inside the bench's solo window.
- **Solo cost:** on a device with headroom, every 100-250 ms hitch became time lost
  for good. One 132 ms frame (swiftshader arm, load 6.2) read solo 0.9939, and one
  210 ms frame (default arm) read 0.9893, over 20 s windows. The cap repays all but
  the excess.
- **Room cost:** the inputs set a room's frame clock. A console whose debt passes the
  cap is almost always being held by a peer that is on schedule, so moving its whole
  base puts it behind that peer.
  - Measured: a 212 ms write-off at the start of a room left the two anchors 40-100 ms
    apart for the rest of the room.
  - The console that fell behind then skipped nearly every picture on the lag rule
    (3-9 drawn/s, against its peer's 11-14).
  - Later write-offs of 102-105 ms cost room readings of 0.9962 and 0.9949.

**Tried and rejected: not applying the lag rule to a frame that had to wait for its
input.**
- The reasoning was that such a frame is late because of the room, not because of its
  own pictures.
- But at queue depth 1 almost every frame waits on its own page's hop. So nothing was
  skipped, and in the second after the step to depth 1 both consoles dropped
  65-264 ms.
- Room readings: 0.9953, 0.9877 and 0.9882 (snapshot f4).

### Solo 1.0034x: repayment, not a fast governor

- **The governor never runs the guest ahead of the wall clock.**
  - Across every run here, `aheadMs` (how far ahead of the wall clock any frame
    started) was at most 0.87 ms.
  - Sub-ms leads are not slept off, which accounts for that figure.
  - A write-off only moves the base forward.
  - So over any window, the guest clock gains on the wall clock by at most the debt
    it carried into that window. That is at most 100 ms, so at most 1.005 over 20 s.
- **The bench's Dreamcast speed is a mean of per-heartbeat AICA ratios.**
  - Each window ends at a video_cb. At 30 frames/s the guest advances in steps of
    33 ms, run in 13-18 ms.
  - So one window reads 0.95-1.05 even while the governor sleeps 250-500 ms a second.
  - The error cancels between neighbouring windows, but not at the first and last
    windows. That leaves about ±0.0017-0.0033 on a 20-window mean.
  - Weighting each window by its true length (`hbMs`) changed nothing (0.9792 vs
    0.9793), so unequal window lengths are not the cause.
- **The live 1.0034 fits a 100 ms repayment that fell inside the window, plus that
  edge.**
  - It was not reproduced here: on this box solo was render-bound at 0.98-0.99x
    before the fix.
  - After the fix, solo read 0.9991-1.0008 in the final 10 runs below.

### After

Final tree `ea0be09`, prodmirror snapshot, probe lock, wasm `eec9ff8c` STABLE, load 4.0-6.4
on 4 cores. Bench speed, with 0 seconds over budget in every cell. Delay was 1 and desync
false (12-13 hashes) in every room.

| arm | run 1 | run 2 | run 3 | run 4 | run 5 |
|---|---|---|---|---|---|
| default, solo | 0.9997 | 0.9998 | 1.0006 | 0.9996 | 0.9991 |
| default, room | 0.9986 | 0.9976 | 1.0021 | 0.9980 | 0.9981 |
| `--use-angle=swiftshader`, solo | 1.0008 | 0.9999 | 1.0000 | 1.0000 | 0.9998 |
| `--use-angle=swiftshader`, room | 1.0000 | 1.0009 | 0.9996 | 1.0002 | 0.9996 |

Before the fix, on the same rig (HEAD `077d063`; 2 of the 4 default-arm runs also had
the gate split):

| arm | solo | room |
|---|---|---|
| default | 0.9948, 0.9839, 0.9886, 0.9912 | 0.7973 (38 over), 0.7575 (133), 0.8073 (39), 0.7748 (78) |
| `--use-angle=swiftshader` | 1.0007, 1.0005 | 1.0001, 0.9995 |

- **Accounting after the fix, default arm** (f7 runs 1, 3, 5, ms/s per console):
  - solo: emu 382-409, render-hold 399-407, sleep 313-372, drop 0-5, 21-22 pictures/s.
  - room: emu 441-465, render-hold 322-380, gate 2-71, sleep 210-253, drop 0, 9.8-10.6
    pictures/s per console.
  - Both consoles stepped down to queue depth 1 about 17 s after the gate engaged. The
    bench's room window therefore ran about 12 s at depth 2 and then about 8 s at
    depth 1.
- **Witness:** across all 20 f7 runs, `aheadMs` (how far ahead of the wall clock any
  frame started) was at most 0.87 ms.
- **`tools/bench_page_test.mjs --pages dreamcast --sec 20`:** 21/21 pass (solo 0.9994,
  room 0.9989).
- **`room_desync_soak.mjs`** (two Chrome processes, swiftshader, PSO seed, both players
  pressing):
  - RAM detector, 60 guest s: **IN SYNC** over 32 RAM checkpoints and 32 fingerprints.
  - Speed 0.982 on both consoles, with load rising from 5.9 to 11. That run includes
    a 0.7-0.9 s drop per console at soak second 52-57. Every 60 s run in
    `room-input-lag/TASKS.md` showed a drop like it, on both arms, at second 51-56.
  - Matched `--noram` pair, 40 guest s, load 11.3-11.9: fix 0.9979 / 0.9960, HEAD
    0.9977 / 0.9957. IN SYNC on both, 22 fingerprints each.
- **Input lag** (page sample to `run_iter` start, p50, host / joiner), same pair:
  - fix: 74.1 / 82.9 ms overall; 72.2 / 80.6 ms at delay 1.
  - HEAD: 80.8 / 81.5 ms overall; 80.6 / 79.0 ms at delay 1.
  - The lag is unchanged. At this load it sits above the 54-58 ms measured at load 2-10.
  - The input lag of the bench room on the default arm was not measured. By the
    arithmetic above, it is 1 PSO frame (33 ms) more while the room is at depth 2.
- **Documented solo probe** (`DC_CORE_AUDIT=off build_and_probe.sh --skip-link
  --duration 60000`, `PROBE_ROOT` = the snapshot): settled guest ratio 0.99945x,
  29.96 presents/s, 0 dupes, hash-guard STABLE.

### Open

- The fix trades pictures for guest rate: about 10 pictures/s per console in the room
  and 21-22 solo, on this box's default renderer. A real GPU should not be behind,
  so this rule should not fire there. The heartbeat's `(behindN)` shows whether it
  did.
- The live default-arm room needs re-benching once this deploys.

## Answer

- **A GPU-bound room lost its time inside `run_iter`, not between tasks.** In a
  two-console loopback room in PSO's Pioneer 2 lobby (both consoles in one tab,
  one SwiftShader GPU process, 4 cores), each console's worker read
  `emu 60-100% + render-hold 0-2%` at **0.37-0.44x** (bench speed). Solo, the hold had shown
  up BETWEEN tasks (`governor-pacing/TASKS.md`); with two consoles feeding one
  GPU process, the draw/clear calls themselves blocked or competed for the
  cores. The governor then dropped the debt past its 100 ms repay window:
  366-4506 ms of guest time per 2 s heartbeat. Waits on the peer's input
  were smaller (host 152-4287 ms, guest 0-1866 ms per ~20 s window). The
  main thread the two consoles share had 2-4 long tasks per page, mostly at
  boot, so it was not where the time went.
- **The fix is the N64 rule (cee706f / a222501), in `flycast_worker.js`.**
  After a frame that drew into the window, the worker sets a fence. A frame
  that starts while that picture is still on the GPU runs with its draw,
  clear and blit calls into the window and into persistent FBOs swallowed.
  Its CPU work, audio, input and every other GL call still run. The default
  depth is 2 pictures solo and 1 in a room (measured below).
- **After:** the same room reads **0.998-1.001x with 0 over budget** on
  both consoles, at `emu 35-57% + render-hold 1-3%`, and every governor
  window reads `drop0`. Each console draws 6-9 pictures/s there. That is
  what this box's GPU can raster for two 3D consoles, so the other 21-24 of
  the 30 guest frames per second are skipped. Solo, the lobby reads 1.000x
  with 0 over at 10-17 pictures/s, depending on the depth.
- **The guest cannot tell.** In a real two-process room (`room_desync_soak.mjs`)
  with the HOST forced to skip 2 of every 3 frames (`?fskip=force:3`) and the
  JOINER not skipping (`?fskip=0`), the room stayed **IN SYNC over 32 full
  16 MB guest-RAM checkpoints and 32 engine fingerprints** (60.4 guest s, 3D
  lobby, both players pressing).
- **The room's telemetry was blind, and that is fixed too.** A seeded room
  loads its seed before the page sends `freerun`. The `loadState` handler set
  `freerun = true` directly, so the later `setFreerun(true)` was a no-op and
  the 1 s stats tick never started: every room heartbeat read
  `iters=0/s duty=0%`. With no tick, no `vmuPoll`/`lazyPoll` ran either.
  It now goes through `setFreerun(true)`.

## What is skipped, and why it is exact

- **Skipped:** draws into framebuffer `null` (the window) and into any FBO
  that was NOT attached during this frame. The libretro GL path draws the
  scene into the post-processor FBO and then one quad into the window
  (`gles.cpp` `renderFrame`). Both are persistent targets, so both are
  skipped.
- **Never skipped:** render-to-texture. `BindRTT` (`gltex.cpp`) creates a new
  `GlFramebuffer` and attaches it in the same frame it draws into, so the RTT
  textures that later pictures sample are always the ones a run without
  skipping makes.
- **Read-backs are watched.** A draw reaches the guest only through a
  read-back (`ReadRTTBuffer` with `RenderToTextureBuffer`,
  `writeFramebufferToVRAM` with `EmulateFramebuffer`; both are at their
  defaults here because the bridge answers no core variable).
  - Any `readPixels` / `copyTex*` / blit source that reads a persistent
    target turns skipping OFF for the session. It is reported as
    `[fskip] OFF ...`.
  - If the target held a skipped frame, it also counts a taint (`TAINT` in
    the heartbeat).
  - There is no re-run as on N64: a Dreamcast load flushes the JIT and is not
    exact (`rollback/TASKS.md`).
  - PSO issued 0 such reads in every run here (`reads:0, taints:0`).
- **A 250 ms backstop** draws a frame anyway if a fence has not signalled by
  then, so the picture never looks frozen. It fired 2-4 times per second in
  the GPU-bound room.

## Arms and telemetry

- **Arms:**
  - `?fskip=0`: off.
  - `?fskip=N`: N pictures on the GPU.
  - `?fskip=force:K`: skip all but 1 of every K frames, whatever the GPU
    does. This is the exactness arm.
  - `window.__DC_FSKIP`: the same seam for a rig that cannot put a query on
    a page it does not open, such as the bench room's iframe.
- **Telemetry:**
  - The worker's `ips` message carries `fs {on, frames, drawn, skipped,
    forced, taints, reads, why}`.
  - The heartbeat appends `fskip=on drawnN/skippedM`.
  - `__dcProbe().fskip` exposes the same object.
  - `presented=` / `fps=` still count video_cb presents, which is one per
    guest frame, so read `drawn` for pictures that actually reached the
    canvas.

## Evidence

All runs held `tools/probe_lock.sh`. The wasm was `eec9ff8c…` throughout.
The pages were served from hermetic snapshots by `tools/devserver.mjs`
(HEAD = shipped `1fb55a42` worker; fix = this change), with
`pso2_boot.state` swapped for `pso2_pioneer2_lobby.state` so that both
phases start in the 3D lobby. The bench was run as `?bench=1&benchsec=20&benchauto=1`
through a scratch driver that also sampled both frames. Load was 4.7-5.7 on a
4-core box.

Bench, Pioneer 2 lobby, interleaved:

| run | arm | solo speed / over | room speed / over | room desync (hashes) |
|---|---|---|---|---|
| L-head | shipped | 0.8365 / 131 | 0.4393 / 278 | false (5) |
| L-off2 | fix, `fskip=0` | 0.7387 / 202 | 0.40 / 274 | false (6) |
| L-on2 | fix | 1.0002 / 0 | 0.9979 / 0 | false (13) |
| L-head2 | shipped | 0.8102 / 198 | 0.3798 / 253 | false (5) |
| L-off3 | fix, `fskip=0` | 0.8009 / 168 | 0.3726 / 225 | false (5) |
| L-on3 | fix | 1.0002 / 0 | 1.0000 / 0 | false (13) |

Depth, same scene (the default is 2 solo / 1 room):

| depth | solo pictures/s | room pictures/s per console | room speed |
|---|---|---|---|
| 1 | 9-12 | 6-7 | 0.9979, 1.0000, 0.9989 |
| 2 | 13-16 | 6-9 | 0.9963, 0.9955 |
| 3 | 15-18 | 7-9 | 0.9927 |

Exactness (`dreamcast/tools/room_desync_soak.mjs`, two Chrome processes, ws
signalling, lobby seed, `--soak 60`):
- `fsk-exact1`, host `fskip=force:3`, joiner `fskip=0`: **IN SYNC**, 32 RAM
  checkpoints + 32 fingerprints, 60.4 guest s.
- `fsk-canon1`, both on the default: **IN SYNC**, 32 + 32, 60.8 guest s.
- Bench room with host `force:3` and guest `0`: the host heartbeat read
  `drawn6/skipped12` while the guest read `drawn5/skipped0`, and the room
  reported `desync:false`. This shows that the force arm really skipped in
  that code path.

The default scene (`tools/bench_page_test.mjs --pages dreamcast --sec 20`,
character select) was already 1.000x both before and after: solo 1.0002 / 0
over, room 1.0000 / 0 over, desync false over 12 hashes, 21/21 pass.

## Input delay: 2 stays

> **Superseded 2026-10-05 (`room-input-lag/TASKS.md`).** The worker now keeps
> a stall as a bounded debt instead of rebasing its governor. The page queues
> one frame, and the Dreamcast floor is 1. At ~2 ms RTT the room runs at delay
> 1, and input lag (sample to run_iter start) went from p50 122 ms to 55 ms
> at 1.000x.

- The engine floors the delay at 2 (`lib/netplay.js` `_delayFloor`,
  `_capDelay`, `recommendDelay`). At PSO's 30 frames/s that is 67 ms of input
  latency, and delay 1 would give back 33 ms.
- **Slack at delay 2:** after the fix the engine's own slack (`meanLead`, the
  frames already covered past the one running) read 0.94-1.97, with 0-8
  stalls and 0-161 ms of stall per ~20 s window. At delay 1 the most slack
  possible is one frame lower, so the page→worker→peer hop has to land
  inside one frame every time.
- **Why that matters:** a worker stall REBASES the governor
  (`flycast_worker.js` lockstep gate: a stall is never repaid), so every
  late hop would be guest time lost for good, which works directly against
  the 1.000x goal. In this room the GPU fences alone ran past 250 ms 2-4
  times per second.
- **The engine was not changed.** Lowering the floor needs either a measured
  room where minLead stays at least 1 at delay 1, or a governor that keeps a
  bounded debt across a stall instead of zeroing its base. The page's
  lookahead comment (`dreamcast.html`, `lsFeed`) names that as the unfixed
  worker defect.

## Open

- The live failure (prod 3e4e160, character select, room 0.784x) was **not
  reproduced locally**:
  - The same scene read 1.0001x on the shipped files here, both from the
    working tree and through an 80 ms disc-latency proxy.
  - The lobby room is the GPU-bound stand-in used above.
  - The live room needs re-benching once this deploys.
- One box, SwiftShader on both consoles. On a real GPU the fences signal
  quickly and nothing should be skipped. The heartbeat's `drawn/skipped`
  shows which case a device is in.

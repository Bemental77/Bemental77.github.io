# Dreamcast rooms: render-level frame skip (measured 2026-10-05)

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

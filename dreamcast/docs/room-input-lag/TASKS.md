# Dreamcast rooms: input lag 122 ms -> 55 ms, stall carried as a debt (measured 2026-10-05)

## Answer

- **The lag was three frames plus a sleep, not "delay 2".** Measured as the
  wall time from the moment a page samples its own pad for frame F (the
  engine's `beginFrame` that schedules F) to the moment that console's worker
  starts `run_iter` for F:
  - shipped `970f334`, ~2 ms RTT: **p50 121-123 ms** on both consoles (5 runs).
  - That is `(delay + lookahead - 1)` frames, 3 x 34.5 ms at PSO's render rate.
  - Add the governor's sleep between the ack of the last frame and the start
    of the next, about 18 ms.
  - The page queued 2 frames in the worker (`lsFeed` lookahead) on top of
    delay 2.
- **The lookahead was 2 only because of the defect named in `lsFeed`.**
  - A stall rebased the worker's governor (`paceBaseWall = 0`), so a stall was
    never repaid.
  - With a one-frame queue the worker stalls at the top of every frame. It
    rebased every frame, never saw a lead to sleep off, and ran as fast as
    the inputs arrived.
  - Control arm `?lsrepay=0` (the old rule) at depth 1 / delay 1:
    **1.0146 / 1.0162x** at ~2 ms RTT and **1.030 / 1.032x** at ~45 ms RTT.
    Both are faster than the hardware, which gate 9 forbids.
- **Fix 1, the worker (`flycast_worker.js`): a stall is a bounded debt.**
  - The governor keeps its base while gated.
  - When the input lands, the ordinary governor repays up to
    `CATCHUP_MAX_MS` (100 ms) by running frames without sleeping. It never
    runs one cycle past the wall clock.
  - Anything beyond the cap is dropped and counted (`gov=drop`).
  - This is the rule N64 shipped in `2f3da51`.
  - Same arms with the debt kept: **1.0000-1.0009x**.
- **Fix 2, the page (`dreamcast.html`): one frame queued, delay floor 1.**
  - The lookahead is `LSQ.lookahead = 1`.
  - The host sizes the delay as `ceil(one-way / frame)` with no spare frame
    (`LSQ.spare = 0`). The engine's own answer adds 1.
  - The engine's floor is per console: `lib/netplay.js` Lockstep
    `opts.minDelay`, passed through `new Netplay.Session({ lockstep: {...} })`.
    It is 1 on Dreamcast and stays 2 everywhere else.
  - If the link cannot carry the choice, the engine's existing pace check
    raises it. That check fires when every console spends at least 1% of each
    second waiting for 3 windows.
- **After:** at ~2 ms RTT the room runs at delay 1 with **p50 54-58 ms**, half
  the shipped figure.
  - At 20-28 ms RTT the chooser picks 2: p50 88 ms (shipped: 3 then 2, 123 ms).
  - At ~45 ms: 2, 88 ms (shipped: 3, 156 ms).
  - At ~85 ms: 4, 156 ms (shipped: 5 then 4, 189 ms).
  - All of these runs held 1.000x and 0 desyncs.

## The input-lag arithmetic

A pad sampled when the page feeds frame G is scheduled for G + delay. The page
feeds G when the worker finishes G - lookahead. So the press lands
`delay + lookahead - 1` frames after it is sampled.

That same span is all the time a peer's input has to cross the wire. The two
knobs are interchangeable for the network, and both are input lag. Lockstep
cannot make the lag shorter than the one-way path without a rollback.

## Evidence

Rig: `dreamcast/tools/room_desync_soak.mjs`, two Chrome processes, real WebRTC,
ws signalling, the PSO seed, and both players pressing.

- **New flags:**
  - `--owd MS[:J]` delays every `RTCDataChannel.send` on both pages, so RTT =
    2 x MS + jitter. The host's RTT pings cross the same delayed channel.
  - `--noram` skips the 16 MB RAM hash. That hash costs 34-44 ms of worker
    time every 60 frames, which the other console sees as a stall.
- **New outputs:**
  - `INPUTLAG`: sample to run_iter start, on the timeOrigin epoch clock.
  - `SPEED`: guest cycles over wall time at the hash checkpoints, after 5 guest s.
  - `GOV`: heartbeat `gov=drop` totals, and when each drop happened.
  - The engine's slack (`minLead`/`meanLead`), stalls and delay.
- **Serving:** hermetic symlink snapshots served by `tools/devserver.mjs`:
  - `HEAD` = 970f334;
  - `fix` = this change, with the three files under test frozen.
- **Controls:** wasm `eec9ff8c…` and emcc js `cca4105d…`, md5 STABLE in every
  run. Every browser run held `tools/probe_lock.sh`. Load was 2.1-10 on a
  4-core box, shared with sibling agents.

40 guest s each, `--noram` unless marked RAM:

| arm | RTT | delay | input lag p50 (host / joiner) | speed (host / joiner) | verdict |
|---|---|---|---|---|---|
| HEAD | ~2 ms (RAM) | 2 | 121.9 / 123.2 | 0.9999 / 1.0012 | IN SYNC, 22 RAM + 22 fp |
| HEAD | ~2 ms | 2 | 122.3 / 123.0 | 1.0003 / 1.0000 | IN SYNC |
| fix, `?lsdelay=1` | ~2 ms (RAM) | 1 | 56.7 / 56.5 | 1.0000 / 1.0000 | IN SYNC, 22 RAM + 22 fp |
| fix, `?lsdelay=1` | ~2 ms | 1 | 55.6 / 56.2 | 1.0000 / 1.0000 | IN SYNC |
| fix (default) | ~2 ms | 1 | 54.4 / 55.0 | 0.9971 / 0.9971 (one 105-113 ms drop on BOTH at 21.6 s) | IN SYNC |
| HEAD | 20-28 ms (RAM) | 3 -> 2 | 122.6 (at 2) | 1.0004 / 1.0000 | IN SYNC, 21 + 21 |
| fix (default) | 20-28 ms | 2 | 88.2 / 88.7 | 1.0001 / 1.0000 | IN SYNC |
| fix, `?lsdelay=1` | 20-28 ms (RAM) | 1 -> 2 at f654 | 54.9 at 1, 89.3 at 2 | 1.0000 / 1.0000 | IN SYNC, 22 + 22 |
| HEAD | 40-48 ms | 3 | 155.8 / 155.9 | 1.0000 / 0.9999 | IN SYNC |
| fix (default) | 40-48 ms | 2 | 87.7 / 88.7 | 1.0000 / 1.0000 | IN SYNC |
| HEAD | 80-92 ms | 5 -> 4 | 188.5 (at 4) | 0.9998 / 1.0000 | IN SYNC |
| fix (default) | 80-92 ms | 4 | 155.9 / 156.0 | 0.9999 / 1.0000 | IN SYNC |
| control `?lsrepay=0&lsdelay=1` | ~2 ms | 1 | 54.7 / 55.4 | **1.0146 / 1.0162** | IN SYNC |
| control `?lsrepay=0&lsdelay=1` | 40-48 ms | 1 -> 3 -> 2 | 114.6 | **1.0300 / 1.0320** | IN SYNC |
| same, debt kept | 40-48 ms | 1 -> 2 | 86.7 / 88.2 | 1.0009 / 1.0001 | IN SYNC |

40 guest s matched pairs at ~2 ms RTT, interleaved, default configuration
(`--noram`, load 6.7-8.5):

| run | arm | lag p50 (host / joiner) | speed (host / joiner) | dropped after the first 2 s |
|---|---|---|---|---|
| a | fix | 57.3 / 57.7 | 0.9999 / 0.9999 | 0 / 0 |
| a | HEAD | 124.2 / 124.3 | 1.0005 / 0.9999 | 0 / 0 |
| b | fix | 57.3 / 58.2 | 1.0000 / 0.9999 | 0 / 0 |
| b | HEAD | 124.9 / 124.3 | 1.0001 / 1.0000 | 0 / 0 |
| c | fix | 58.1 / 57.6 | 1.0000 / 1.0000 | 0 / 0 |

Exactness with the RAM detector, default configuration, 60 guest s:
- `fin-ram-owd0`, ~2 ms RTT, delay 1: **IN SYNC** over 32 full 16 MB RAM
  checkpoints and 32 engine fingerprints, 60.7 guest s.
- `fin-ram-owd20`, 40-48 ms RTT, delay 2: **IN SYNC**, 32 + 32, 61.3 guest s.
- Speeds there were 0.985 and 0.994: these runs include the soak-second-52
  event below, and the detector's 34-44 ms hash every 60 frames.

60 guest s pairs at ~2 ms RTT, interleaved (load 6.8-10):

| run | arm | lag p50 | speed (host / joiner) |
|---|---|---|---|
| a | fix | 55.9 / 56.1 | 0.9867 / 0.9858 |
| a | HEAD | 121.8 / 122.1 | 0.9854 / 0.9851 |
| b | fix | 56.3 / 56.5 | 0.9841 / 0.9848 |
| b | HEAD | 121.4 / 121.2 | 0.9928 / 0.9938 |

Every 60 s run, on both arms and both consoles, dropped 0.2-0.8 s of guest
time at soak second 51-56. So that dip belongs to the scene or the box, not to
this change.

The 40 s runs end before it. Both arms drop 0.1-1 s in the room's first 2 s;
the steady state is what counts after that:
- **fix:** 1 of 7 timestamped runs dropped any time after 2 s. That was
  `m-fix-owd0`: 105 / 113 ms, on both consoles at the same moment, 21.6 s in.
- **HEAD:** 0 of 4.

`tools/bench_page_test.mjs --pages dreamcast --sec 20` (loopback room, character
select, load 3.3-4.5):

| arm | solo speed / over | room speed / over | room delay | desync |
|---|---|---|---|---|
| fix | 1.0001 / 0 | 1.0004 / 0 | 1 | false (12 hashes), 21/21 pass |
| HEAD | 1.0001 / 0 | 1.0000 / 0 | 2 | (same shape, 21 checks) |

Documented solo probe:
- Command: `DC_CORE_AUDIT=off build_and_probe.sh --skip-link --duration 60000 --name il-solo`.
- Settled guest ratio 0.99982x, 29.97 presents/s, 0 dupes.
- wasm STABLE.

Other consoles, run because `lib/netplay.js` changed. With no `minDelay` the
engine behaves exactly as before.
- **Node-only engine tests, all pass:**
  - `delay_stepdown_test`: 26/26, including two new cells for the per-console
    floor.
  - `netplay_lockstep_test`: 152/152.
  - `netplay_rollback_test`: 28/28.
  - `netplay_rb_capacity_test`: 26/26.
- **Browser tests, each under the probe lock:**
  - `snes_rollback_probe`: 17/17.
  - `ps1_netplay_test`: 25/25.
  - `gc_rollback_det_test`: 7/7.
  - N64 `lockstep_probe`: GATE PASS (solo, bridge and pair each 2/2).
  - N64 `n64_rollback_probe --players 2 --latmin 40 --latmax 100 --secs 30`:
    2 FAIL ("the room ran ROLLBACK mode=lockstep"). It fails identically
    against HEAD's `lib/netplay.js` (served from the HEAD snapshot), so the
    failure is not from this change. Those default flags are not the
    documented `L`/`G` arms.

## Slack at delay 1

- At delay 1 the engine's slack (`meanLead`: frames already covered past the
  one running) can be at most 1. It read 0.08-0.80, `minLead` 0.
- **One frame of slack in that sense is therefore structurally impossible at
  delay 1.**
- Waiting on the peer cost no guest time at ~2 ms RTT: 1.000x, with no
  steady-state drop in the forced-delay-1 runs.
- The page-level stall count overstates the real wait, because with a one-frame
  queue the page "stalls" while the worker is still in its governor sleep.
- At 20 ms RTT and above, the engine's own 1% pace check raised the delay to 2
  within 3-20 s, as designed. The chooser now picks 2 there from the start.

## Tried and rejected: sampling the pad just before the frame (`?lsfeed=due`)

- **How it works:** the worker's `lsFrame` ack now carries `due`, the epoch
  time the next frame starts. With `?lsfeed=due` the page holds the feed until
  `?lsmargin` (4 ms) before `due`.
- **Gain:** lag p50 **36.7 / 37.0 ms** at ~2 ms RTT, delay 1, 18 ms less.
- **Cost:** **0.9975 / 0.9972x**, with 91-97 ms dropped per console in 36 s.
  A main-thread timer that fires late costs the worker guest time.
- It stays an arm, off by default.

## Rollback without a rebuild: not achievable

- **What the shipped worker exports:** only the full serializer
  (`_emscripten_save_state`, `_emscripten_load_state`), plus knobs
  (`_flycast_set_idleskip`, `_flycast_set_shard`, `_flycast_lockstep_reset`,
  ...). There is no keep-code load, no save into a ring slot, and no audio
  mute for re-simulated frames. The list was read with a grep over
  `flycast_worker_emcc.js`.
- **Cost:** measured in `rollback/TASKS.md`. A save is 27.6 MB and 5 ms. A load
  is 47.9 ms p50, and it calls `ResetCache`, which flushes every JIT block. The
  first frame after a load takes 325 ms p50. One misprediction costs more than
  20 frames of budget.
- **Exactness:** also measured in `rollback/TASKS.md`. A frame run from a
  restored state is one SH4 timeslice (448 cycles) shorter, from state that no
  savestate carries. Rollback then never rejoins the reference, even with
  idle-skip and shard batching off.
- **A lighter save from JS (copying wasm memory) — NOT measured here.** I expect
  it to be unsafe rather than merely slow, but this is unverified. Compiled
  blocks live in `WebAssembly.Module`s and the function table, outside linear
  memory. Restoring the heap alone would point the block cache at code from a
  different timeline. The GL objects and the audio thread are outside it too.
- Patches 0001/0002 in `rollback/` are the route. They need the core rebuilt.

## Arms

| arm | effect |
|---|---|
| `?lslook=N` | pins the worker queue depth (default: starts at 2, earns 1 — see below) |
| `?lsmindelay=N` | engine floor, 1 or 2 (default 1) |
| `?lsdelay=N` | host forces the room's delay |
| `?lsspare=N` | frames added to `ceil(one-way / frame)` (default 0) |
| `?lsrepay=0` | the old rebase-on-stall |
| `?lsfeed=due`, `?lsmargin=MS` | sample just before the frame |

## Open

- Every number here comes from one 4-core box running SwiftShader, with both
  consoles on it. The "RTT" is simulated at the DataChannel. ICE and a real
  WAN path were not exercised.
- The chooser sizes the delay at Ready from the 60 Hz fallback frame length,
  because no frame has run yet. That is conservative by 2x for a 30 fps title
  like PSO; at ~85 ms RTT it picked 4 where 2 frames of PSO would cover the
  path.

## Follow-up: depth 1 is earned, not assumed (2026-10-05, after prod 89746cb)

The live bench room on prod 20dd57b / ae86b6e / 89746cb read 0.678-0.695x with
295-328 slow seconds, where a94321d had read 0.9996x. The cause was depth 1.

- **The bench room puts both consoles on one main thread.** The joiner is a
  same-origin iframe (`lib/bench.js` roomMain), so both pages share it.
- **Depth 1 puts a page round trip on every frame.** Where that thread is
  busy, the worker parks, repays up to 100 ms, and drops the rest
  (`gov=drop`).
- **This condition is reached with headless Chrome WITHOUT
  `--use-angle=swiftshader`.** The live harness runs that way. The room is
  render-bound there (render-hold 50-65%, drops 220-560 ms in each 1 s
  window).
- **With that flag, every arm passes.** `bench_page_test` and the soak rig
  pass it, which is why the original measurements above did not see this.
  With the flag, depth 1 holds 1.000x and drops 0 ms.

Matched A/B, prod-mirror snapshots, probe lock held, load 1.5-6 on 4 cores.
Room speed / slow seconds:

| arm (no `--use-angle`) | room |
|---|---|
| a94321d (depth 2) | 0.908/0, 0.924/0, 0.896/0, 0.940/0, 0.982/0 |
| 20dd57b, ae86b6e, 89746cb (depth 1) | 0.69-0.80, 38-391 over (13 runs, live included) |
| 89746cb with `lslook` default 2 | 0.902/0, 0.933/40 |
| 89746cb with `lsmindelay` default 2 | 0.745/136, 0.800/0 |
| 89746cb with `lsrepay=0` | 0.697/222, 0.713/191 |
| fix: start at 1, raise on a drop | 0.994/0, 0.990/0, 0.980/0 |
| **fix as shipped: start at 2, earn 1** | **0.986/0, 0.994/0, 0.961/0** |

With `--use-angle=swiftshader`, the fix as shipped read 1.0002/0, 1.0002/0
and 1.0001/0. Both consoles stepped down to depth 1 at about 17 s.

**THE RULE (`dreamcast.html` lsLookTune):**

- A room starts at depth 2.
- After 15 windows in a row without a dropped frame, it steps down to depth 1.
  Each window is the worker's 1 s governor report.
- A window that drops 100 ms or more at depth 1 raises the depth back to 2.
- A raise within 30 s of a step-down keeps depth 2 for the rest of the room.
- The first 2.5 s after the gate engages are not judged. Every room start
  drops 150-340 ms there, on both arms.
- The depth only changes input lag. `beginFrame` alone decides which frame a
  pad lands on, so it cannot desync a room.
- The witness is `__dcNet().lockstep.look` (also `lookUps`, `lookDowns` and
  `lookLatched`), and the page logs each change.

> **Superseded 2026-10-06** (`room-frameskip/TASKS.md`, the follow-up section). The
> render-bound arm now holds 1.000x: a frame that starts more than 17 ms behind the wall
> clock skips its picture. Default-arm bench room 0.9976-1.0021 over 5 runs, 0 over,
> delay 1, depth 1 earned at about 17 s.

**What is NOT fixed.** On the render-bound arm, even depth 2 does not hold
1.000 +/- 0.005. That includes a94321d itself, 0.90-0.98x today. It is the
box's rasterizer capacity for two consoles, not the queue.

**Neither the floor nor the governor was the cause.** The `md2` arm (delay
floor 2) and the `repay0` arm (the old rebase) both stayed at 0.70-0.80x.

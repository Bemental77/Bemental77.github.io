# N64 rollback as the default: measured 2026-10-01

## Verdict: `RB_DEFAULT` stays `false`

The switch is `n64/N64Wasm/dist/room_core.js:627`. Since `ec9f66b` it lives in
that file and `n64/index.html` only reads it (`:3832`). It feeds exactly one
thing: `RB_WANT = ?rb=1 || (RB_DEFAULT && ?rb!=0)` (`room_core.js:628`). So
`?rb=1` behaves exactly like a flipped default, and the G arm below is the
flipped product.

| Criterion from the brief | Result |
|---|---|
| G ≥ L in rate in every cell, within noise | **Holds.** Median G/L pair ratio per cell: 1.215, 1.183, 0.976, 0.990, 1.213. Two-tab rooms: 0.996 and 0.977. |
| 0 desyncs | **Holds.** 81/81 confirmed states bit-exact against a straight run fed the room's own inputs. Two-tab rooms: 0 desyncs, with 10-25 fingerprints compared per console. |
| Lower lag where affordable | **Fails.** Rollback was affordable nowhere on this box: all 21 gated rooms dropped to delay lockstep, at frames 51-356 (the first 1-7 s). In every cell, **G then had more input lag than L**. Over the window: 6.9-10.7 frames against 4.8-5.9 (cell medians); 7.1-7.6 against 5.2-6.0 in the two-tab rooms. |
| Two-tab default room with 0 desyncs | **Holds.** |

Flipping now would leave rate as it is and make input lag worse. The worse
lag would hit every console that cannot afford rollback, for the first minute
of every room. And no console on this box could afford it. The user's first
rule is zero input lag, so this is a regression, not a neutral change.

The causes are three specific behaviours, each with a fix, in
[Why it cannot flip yet](#why-it-cannot-flip-yet-the-causes-and-the-fixes).
Re-run this measurement once they land:

- fixes 1 and 3: an unaffordable room runs exactly what lockstep runs today,
  the same delay with no start-up transient;
- fix 2: an affordable room keeps or regains zero lag.

## origin/dev moved during the measurement

Everything above and below was measured on `ec9f66b`. By the end, origin/dev
was `173ad52`, and three commits touch what was measured:

- `5fdaffd` reworks the gate's burst term. It now charges a correction's
  burst at the rate corrections happen, and keeps the old bar for a step over
  half a frame. That bears on cause 2.
- `80cc6dd` changes the N64 core's frame path.
- `fbasync.js` changed.

Causes 1 and 3 are untouched in code at `173ad52`:

- `_capDelay`, `_rbPutLocal` and the `rbResume` contract do not appear in the
  `lib/netplay.js` diff;
- `room_core.js` and `core_worker.js` are byte-identical (`c40feef9`,
  `f65bf5ad`);
- `n64/index.html` differs only in its cache-buster lines.

A re-check of the key cells on `173ad52` is recorded in
[Re-check on 173ad52](#re-check-on-173ad52).

## What was measured

**Snapshot.** A hermetic snapshot of origin/dev `ec9f66b`. It is a
`git archive` of:

- `n64/` (code and dist) and the MK64 ROM;
- `lib/` and `coi-serviceworker.js`;
- `tools/devserver.mjs`, `browser_leak_guard.js` and `probe_lock.sh`.

`tools/devserver.mjs` served it on its own port (HTTP Range supported). The
files below were hashed before and after every run; every log shows the same
values.

| file | md5 |
|---|---|
| `n64/index.html` | `ce476b79` |
| `room_core.js` | `c40feef9` |
| `core_worker.js` | `f65bf5ad` |
| `n64wasm.wasm` | `2a0720e5` |
| `n64wasm.js` | `624d1a09` |
| `lib/netplay.js` | `7c74eeaa` |

**Machine.** Chromium 1194 with SwiftShader GL, on a 4-core box shared with
other agents.

**Room.** Mario Kart 64, 2 players. It is a PAL cartridge: the room logs
"pacing to 50 Hz from the ROM header", so 1 frame = 20 ms.

**Rig for the rate cells.** `n64/tools/n64_rollback_probe.mjs`:

- One real core on the real page.
- The second player is a **ghost**: a real `lib/netplay.js` engine in a Web
  Worker, with no core.
- Every message on every link takes 40-100 ms one way, uniform, delivered in
  order.
- Both pads are scripted. The buttons change every 8 or 23 frames and the
  stick every 6. That is about what analog steering does to a repeat-last
  prediction.

It ran from a scratch copy. The additions report more; they do not change
what is measured:

- **More reporting:**
  - the engine's `modeReport()`: switches, the delay per second, the need;
  - presented frames per display tick, on both realms. The definition is the
    worker's own counter (`core_worker.js:250-261`).
  - once a second, from the host engine's own methods: what `_capDelay` would
    pick now, `_capWireFloor()`, its own lateness p99, and the peers' `li`.
- **`--ldelay 6 --lfloor 4`, arm L only.** Before Ready, the host engine's
  `delay` and `netFloorDelay` are set as the product's `chooseDelayThenReady`
  sets them from RTT pings (`n64/index.html:4686-4713`). The rig's
  `__n64LsAttach` path skips that. The values are the modes of
  `recommendDelayForRoom` and `floorDelayForRoom` over 2000 simulated 6-ping
  draws of this link:
  - delay 6 in 69% of draws, 7 in 24%, 5 in 5%;
  - floor 4 in 73%, 5 in 27%.
- **`--cin`**: the straight reference is fed the room's own inputs (see
  [Exactness](#exactness)).
- **`--wslow 4`**: the slow-worker cell (see [Rig limits](#rig-limits)).

**Rig for the two-tab room.** `n64/tools/party_pace_probe.mjs --arm net
--netms 70 --jitter 30 --secs 60`. That is two real consoles in two windows,
over the real `local` transport (RTCDataChannel), with 40-100 ms one way. Both
rooms ran in the worker. It also ran from a scratch copy, which only adds the
engine's mode report and the count of fingerprints compared.

**Arms.**

- **L**: delay lockstep. `--rbw 0` with `?rb=0`. In the two-tab room, `?rb=0`
  alone, so the product sizes the delay itself.
- **G**: rollback with the product's capacity gate live. `--rbw 8` with
  `?rb=1` and no `rbgate=0`. Every console declares `ms`, so `_capGate` is on
  (`lib/netplay.js:2812`).

**Procedure.**

- Each cell is 3 interleaved L/G pairs, with the order alternated per round.
  Each run is a 30 s window after a 3 s settle; two-tab runs use a 60 s window.
- Every unit ran under the shared probe lock (`/tmp/bemental-probe.lock`),
  one cell at a time.
- The rate units started only below load 16. Any whose logged load crossed
  25 would have been voided; none was.
- The exactness and two-tab units ran under the lock without a load wait,
  because bit-exactness does not depend on load. Their loads are in the
  tables.
- The box sat at load 23-60 for long stretches from other agents' unlocked
  runs. The first attempt at the cpu4 cells hit load 37 and was discarded.

**Columns.**

- **rate**: room frames per wall second ÷ 50.
- **lag**: the frames of input delay the room adds, averaged over the window.
  It is 0 in rollback and the engine's `delay` in delay lockstep. That is the
  definition of the page's own witness (`room_core.js:1135-1141`). The witness
  itself reads 0 in this rig, because the scripted pad repeats and a pending
  change matches an image that was already queued.
- **presented share**: display ticks that showed a new frame. A 50 Hz room at
  1.000x tops out at 0.83 on a 60 Hz display.
- **exact**: the plain reference. Its mismatches are a rig artifact (see
  [Exactness](#exactness)).
- **step**: the page's `stepMs`, the per-frame cost of a window-deep rollback
  (`room_core.js:946-950`). `run` in brackets is the run-frame EMA.

## Results

### cpu1, worker room (the default realm)

| run | load start/end | rate | lag (frames) | lag at end | secs in rollback | switch | presented share (shown/s) | stalls | exact (plain ref) | step ms (run) |
|---|---|---|---|---|---|---|---|---|---|---|
| L r1 | 6.48 / 13.32 | 0.4835 | 5.4 | 6 | 0/30 | – | 0.713 (16.7) | 28 | – | – |
| G r1 | 13.32 / 12.78 | 0.6037 | 9.9 | 7 | 0/30 | f93 → d13 | 0.750 (20.9) | 4 | 10/10 | 7.04 (4.58) |
| L r2 | 8.78 / 6.05 | 0.7843 | 5.8 | 5 | 0/30 | – | 0.773 (23.3) | 7 | – | – |
| G r2 | 12.78 / 8.78 | 0.9531 | 10.7 | 10 | 5/30 | f356 → d17 | 0.771 (27.1) | 0 | 36/36 | 5.41 (3.90) |
| L r3 | 6.05 / 6.15 | 0.6418 | 5.9 | 4 | 0/30 | – | 0.756 (21.9) | 16 | – | – |
| G r3 | 6.15 / 9.49 | 0.5703 | 9.7 | 9 | 5/30 | f291 → d15 | 0.695 (16.6) | 5 | 26/30 (f260) | 22.86 (20.11) |

G/L pairs: 1.249, 1.215, 0.889.

### cpu1, main thread (`?worker=0`)

| run | load start/end | rate | lag (frames) | lag at end | secs in rollback | switch | presented share (shown/s) | stalls | exact (plain ref) | step ms (run) |
|---|---|---|---|---|---|---|---|---|---|---|
| L r1 | 10.46 / 10.26 | 0.6134 | 5.1 | 4 | 0/30 | – | 0.659 (21.5) | 30 | – | – |
| G r1 | 10.26 / 9.62 | 0.7255 | 10.5 | 11 | 4/30 | f295 → d15 | 0.596 (17.1) | 9 | 27/30 (f270) | 22.87 (20.22) |
| L r2 | 10.87 / 9.27 | 0.7550 | 5.9 | 6 | 0/30 | – | 0.660 (23.2) | 55 | – | – |
| G r2 | 9.62 / 10.87 | 0.5644 | 10.3 | 9 | 4/30 | f293 → d15 | 0.564 (16.1) | 0 | 26/30 (f260) | 25.94 (23.44) |
| L r3 | 9.27 / 6.85 | 0.7611 | 5.7 | 5 | 0/30 | – | 0.672 (25.0) | 66 | – | – |
| G r3 | 6.85 / 5.31 | 0.9759 | 9.2 | 7 | 4/30 | f352 → d15 | 0.777 (43.1) | 1 | 36/36 | 4.94 (3.49) |

G/L pairs: 1.183, 0.748, 1.282.

### cpu4 + mobile, main thread (`?worker=0`): the phone stand-in the CDP throttle reaches

| run | load start/end | rate | lag (frames) | lag at end | secs in rollback | switch | presented share (shown/s) | stalls | exact (plain ref) | step ms (run) |
|---|---|---|---|---|---|---|---|---|---|---|
| L r1 | 8.18 / 5.58 | 0.5149 | 5.0 | 5 | 0/30 | – | 0.724 (18.6) | 53 | – | – |
| G r1 | 5.58 / 3.83 | 0.5225 | 8.4 | 6 | 0/30 | f57 → d12 | 0.726 (17.3) | 19 | 4/6 (f40) | 60.41 (47.68) |
| L r2 | 3.31 / 2.89 | 0.5238 | 5.0 | 4 | 0/30 | – | 0.729 (18.7) | 65 | – | – |
| G r2 | 3.83 / 3.31 | 0.5112 | 8.3 | 6 | 0/30 | f57 → d12 | 0.728 (16.8) | 33 | 4/6 (f40) | 66.01 (53.35) |
| L r3 | 2.89 / 2.90 | 0.5484 | 5.8 | 5 | 0/30 | – | 0.736 (18.8) | 48 | – | – |
| G r3 | 2.90 / 3.04 | 0.5346 | 7.2 | 6 | 0/30 | f57 → d9 | 0.725 (17.9) | 25 | 4/6 (f40) | 65.18 (52.94) |

G/L pairs: 1.015, 0.976, 0.975.

### cpu4 + mobile, worker room, with the worker's core slowed 4x (`--wslow 4`)

| run | load start/end | rate | lag (frames) | lag at end | secs in rollback | switch | presented share (shown/s) | stalls | exact (plain ref) | step ms (run) |
|---|---|---|---|---|---|---|---|---|---|---|
| L r1 | 3.04 / 3.57 | 0.5261 | 5.0 | 5 | 0/30 | – | 0.783 (19.7) | 32 | – | – |
| G r1 | 3.57 / 4.07 | 0.5113 | 8.4 | 6 | 0/30 | f62 → d11 | 0.796 (18.8) | 0 | 7/7 | 78.69 (61.77) |
| L r2 | 3.63 / 3.47 | 0.5304 | 5.0 | 5 | 0/30 | – | 0.781 (19.3) | 34 | – | – |
| G r2 | 4.07 / 3.63 | 0.5253 | 6.9 | 6 | 0/30 | f51 → d9 | 0.796 (19.4) | 0 | 4/6 (f40) | 44.84 (27.36) |
| L r3 | 3.47 / 3.08 | 0.5464 | 5.0 | 5 | 0/30 | – | 0.782 (20.0) | 24 | – | – |
| G r3 | 3.08 / 3.95 | 0.5422 | 6.9 | 6 | 0/30 | f60 → d9 | 0.794 (20.0) | 0 | 6/6 | 76.06 (59.01) |

G/L pairs: 0.972, 0.990, 0.992.

### cpu4 + mobile, worker room, as specified (CDP only: the worker's core is *not* throttled)

| run | load start/end | rate | lag (frames) | lag at end | secs in rollback | switch | presented share (shown/s) | stalls | exact (plain ref) | step ms (run) |
|---|---|---|---|---|---|---|---|---|---|---|
| L r1 | 3.95 / 4.49 | 0.7342 | 4.8 | 4 | 0/30 | – | 0.755 (22.2) | 34 | – | – |
| G r1 | 4.49 / 5.29 | 0.8903 | 10.6 | 9 | 5/30 | f356 → d17 | 0.759 (20.7) | 1 | 36/36 | 4.63 (3.33) |
| L r2 | 5.51 / 3.98 | 0.7448 | 5.7 | 5 | 0/30 | – | 0.760 (22.4) | 7 | – | – |
| G r2 | 5.29 / 5.51 | 0.7482 | 8.9 | 5 | 0/30 | f114 → d13 | 0.766 (23.0) | 0 | 12/12 | 6.26 (1.65) |
| L r3 | 3.98 / 4.39 | 0.7118 | 5.8 | 4 | 0/30 | – | 0.755 (22.1) | 8 | – | – |
| G r3 | 4.39 / 4.36 | 0.9281 | 8.9 | 7 | 3/30 | f297 → d13 | 0.770 (24.9) | 1 | 28/30 (f280) | 12.70 (10.51) |

G/L pairs: 1.213, 1.005, 1.304. With the core unthrottled, this cell
behaves like cpu1: steps 4.6-12.7 ms against 45-79 ms in the slowed-worker
cell.

### Two-tab room, real transport, both consoles in the worker (the default room)

| run | load start/end | rate host / joiner | lag (frames, 60 s) | zero-lag secs | switch | delay over the window | stalls host / joiner | fingerprints compared (each side) | desync |
|---|---|---|---|---|---|---|---|---|---|
| L r1 | 14.50 / 16.94 | 0.1863 / 0.1852 | 5.2 | 0/57 | – | 6 → 5 | 21 / 4 | 10 | none |
| G r1 | 16.94 / 19.04 | 0.1855 / 0.1878 | 7.6 | 2/57 | f62 → d11 ("player 1, player 2 need 277%") | 11, 10, 9, 8, 7, 6 over 45 s | 14 / 25 | 10 | none |
| L r2 | 3.32 / 3.84 | 0.4956 / 0.4942 | 6.0 | 0/60 | – | 6 throughout | 188 / 175 | 24 | none |
| G r2 | 3.84 / 5.93 | 0.4842 / 0.4842 | 7.1 | 8/60 | f329 → d12 ("player 1, player 2 need 142%") | 12, 10, 9, 8, 7, 6, 5, 6 over 50 s | 63 / 54 | 25 | none |

**Load caveat.** Round 1 ran at load 14-19, which is what puts it at 0.19x.
Its exactness and desync results stand; its rate is only comparable within
the pair.

### What the cells say

**Rate: G ≥ L within this box's noise, in every cell.**
- Where the room is CPU-bound (the cpu4 main-thread cell and the
  slowed-worker cell), the pairs agree within 3%: 0.972-1.015.
- At cpu1 the spread within one arm (0.48-0.98x) is as large as any difference
  between arms.
- G stalls less than L (0-33 against 7-66 per 30 s). That comes from its
  larger post-switch delay, the same delay that costs it lag.

**Lag: G is worse than L in every run of every cell.**
- G switched to delay in 21 of 21 gated rooms, at frames 51-356.
- The switch picked 9-17 frames (180-340 ms) where L opens at the product's
  RTT-chosen 6 frames (120 ms).
- G's delay then walks down a third of the excess per 5 s of calm. It was
  still 5-11 at the end of the 30 s windows, and reached 5-6 after 45-50 s in
  the two-tab rooms.
- G's floor afterwards is the wire it measured at the switch
  (`lib/netplay.js:4352-4353`). It ended at 5-6 in the cpu4 cells, where L
  ended at 4-5.

**The gate is right that rollback is unaffordable here, in rate terms.**
- Steps measured 4.6-26 ms at cpu1 and 45-79 ms at cpu4, against a 20 ms
  field. SwiftShader is most of it; these rates are this box's GL ceiling, not
  a device's.
- The ungated controls (`?rbgate=0`, cpu1, one run per realm, load 4.4-4.6)
  show what the gate prevents:
  - zero lag for the whole 30 s;
  - a mean of 0.93x over the first 16 s, in both realms;
  - once the adaptive window had grown to 20, seconds 17-30 averaged 0.63x
    (worker) and 0.51x (main thread).
  - So without the gate, rollback here gets slower as the window grows.

**Presented share is the same in both arms of every cell.** It tracks the
rate. In the worker, the display ticks themselves run at 23-35/s headless.

## Exactness

### The plain reference is wrong after a switch decision

The plain reference in `n64_rollback_probe.mjs` (part B) re-runs every frame
with the scripted pad: `__pad(f)` at frame f. That is the room's confirmed
input only at input delay 0.

Once a gated room has decided to drop to delay, a console puts the local pad
it samples at frame f on frame f+d, and fills the gap with its last pad
(`lib/netplay.js:3624` → `_rbPutLocal`, `:3499-3522`). The decision is taken
`window + d + 4` frames before the switch frame S (`:4213`). From then on,
the plain reference compares states against inputs the room never ran.

Every plain-reference mismatch in the tables starts at the first tap after
that estimated decision:

| cell | S | d | window | decision ≈ | first differing tap |
|---|---|---|---|---|---|
| cpu4 main thread | 57 | 12 | 8 | 33 | 40 |
| cpu4 slowed worker | 51 | 9 | 8 | 30 | 40 |
| cpu1 worker | 291 | 15 | 16 | 256 | 260 |
| cpu1 main thread | 293 / 295 | 15 | 16 | 258 / 260 | 260 / 270 |

### With the room's own inputs, every state matches

`--cin` records every input the room's engine held. `engine.inputs` holds real
inputs only, final once present, kept 240 frames (`lib/netplay.js:1255`). The
recorder polls it every 50 ms; on the main thread the engine is
`window.__n64LsEngine`, in the worker it is `self.RM.eng`. The straight
reference then runs with those inputs.

| run | realm | rollbacks before the switch | switch | recorded inputs ≠ scripted pad (port-frames) | confirmed states compared | bit-exact (full 16.8 MB hash) |
|---|---|---|---|---|---|---|
| X r1 | worker | few | f70 → d13 | 24 | 7 | 7 |
| X r1 | main | few | f77 → d11 | 28 | 8 | 8 |
| X r2 | worker | 72 | f343 → d16 | 59 | 35 | 35 |
| X r2 | main | 73 | f307 → d13 | 38 | 31 | 31 |

**81 of 81 confirmed states match**, including every tap after the switch
decision. So the gated rollback re-simulates exactly, and the mismatches above
are the rig's, not the room's.

**Fix for the shipped rig.** `n64_rollback_probe.mjs` needs the same
recording before its exactness check is used on a gated room.

## Why it cannot flip yet: the causes, and the fixes

All lines are at origin/dev `ec9f66b`.

### 1. The switch to delay picks about twice the delay the link needs

When the gate drops a room to delay lockstep, the delay comes from
`Lockstep._capDelay` (`lib/netplay.js:4254-4276`). It is the maximum of:

- this console's own input-lateness budget (`:4257-4259`);
- each other console's input-lateness p99, plus one (`:4261`). That value is
  `li`, published in `lsrb` at `:4013`;
- the wire floor plus jitter (`:4265-4273`);
- `netFloorDelay` (`:4274`).

**In a rollback room, input lateness is not the link.** It includes how far
the slowest console trails the room, up to the window. The console that
cannot afford rollback is exactly the one that trails.

**Measured, once a second, from the host engine's own methods.** At the
moment of every gated switch, in all 13 sampled runs:

- `_capWireFloor()` read **5-6 frames**;
- the own-lateness p99 read 6-10;
- in the cpu1 runs, the ghost's input-lateness p99 read 14-16 against a
  window peak of 16-18;
- `_capDelay` would have picked **9-14**, and the switches went to 9-17.

For the same link, the product's lockstep start
(`n64/index.html:4697-4713`: `Session.rttReport` → `recommendDelayForRoom`)
picks **6**.

**This is deliberate, and it costs lag.** `:4262-4264` and `:4346-4349` say
"the switch errs high and the give-back walks it down". The give-back
(`_maybeGiveDelayBack`, `:1808-1850`) returns a third of the excess per 5 s of
calm (`:1828`). Measured: 17→14→12→11→10 over 25 s, and 12→6 over 50 s in the
two-tab room. For that whole stretch, a gated room has up to twice the lag of
a lockstep room on the same link.

**Fix.** For a capacity switch (kind `time`), size the delay the way lockstep
sizes it at the start:

- from the RTT the Session measured before Ready (`recommendDelayForRoom`,
  which needs fix 3 for rollback hosts);
- falling back to the wire at the decision, `max(2, wire + spread)`;
- never from the lateness terms `:4257-4259` and `:4261`.

The pace machinery still raises the delay on a link-shaped stall, as it does
for L.

⚠ **The wire alone is not trailing-free under load.** In the ungated
controls `_capWireFloor()` read 6-10 for the first 17 s, while the room kept
up. It read 10-17 after that, once the window reached 20 and the room fell to
about 0.5-0.6x. It is a sound fallback
only at the moment of an early switch, which is when every measured switch
happened.

### 2. The switch is decided on the room's start-up transient, and N64 can never undo it

**The trigger is the first seconds of the room.**
- The adaptive window grows from 8 to 16-20.
- Seconds 1-2 show 13-18 rollbacks/s and 70-123 re-simulated frames/s. By
  seconds 4-5 that is 1-6 and 3-17.
- The need's burst term (`_capNeedOf`, `:4157-4160`) uses the p90 of the last
  `CAP_DEPTHS` = 64 rollback depths (`:1340`, filled at `:3650-3651`). At about
  15 rollbacks/s, those 64 are still the start's deep corrections when the
  host decides.
- cpu1 main-thread G r3 switched at "needs 125%". By the end of the run its
  step was 4.94 ms and its need 0.453.

**N64 never declares `rbResume`.** It is absent from the page's
`startLockstep` options (`n64/index.html:4371-4372`). Once a console has run a
rollback frame, the host's return check fails for good:
`if (r.rr && !r.rz) resumable = false` (`lib/netplay.js:4225`). The room
stays in delay for the rest of the session.

**Fix (both halves are needed before "zero lag where affordable" can happen):**

- Do not count depths recorded while the window was still growing in
  `_capDepths`, or start the p90 only after `CAP_SETTLE_MS`.
- Make the N64 page `rbResume`-capable, then declare it in `startLockstep`.
  Its ring has to keep the start of the first rollback frame after a stretch
  of delay frames, which is the contract at `lib/netplay.js:1512-1518`.

### 3. N64 cannot start a room in delay, so every gated room pays the transient

The engine already has a path that starts a room in delay lockstep
(`lib/netplay.js:2812-2832`). It needs, at Ready, both a console's step cost
(`st`) and a path hint (`rbHintMs` or `netFloorDelay`, `:2829`). N64 provides
neither:

- `ls.selfStepMs` is written only after rollback frames have run
  (`room_core.js:992`). `lsRbProve` (`:1337-1368`) times one save before Ready
  but publishes no step.
- The page measures RTT only for a lockstep host (`n64/index.html:4697`,
  `!ls.rollback`), so a rollback host has no `netFloorDelay`.

**Fix.**

- Measure RTT for rollback rooms too: drop the `!ls.rollback` condition, which
  sets `netFloorDelay`.
- Publish a pre-Ready step estimate from `lsRbProve`: one run, one save and
  one load, all timed there.

A console that cannot afford rollback then starts in delay, at the RTT-sized
delay. There is no transient, no inflated switch, and no difference from L.

## Re-check on 173ad52

Not yet run when this file was first committed: the shared probe lock was
contended for over an hour. A follow-up commit fills this in.

## Rig limits

- **The CDP CPU throttle does not reach workers** (`n64/docs/worker/README.md`).
  - `--cpu 4 --mobile` in the worker room throttles only the page's thread;
    the core, the room driver and the engine run at desktop speed. Hence the
    "as specified" cell.
  - `--wslow 4` makes the worker core's `_neil_ls_run_frame`,
    `_neil_state_save_raw_fast` and `_neil_state_load_raw` busy-wait 3x their
    own wall time (installed through `?workerrig=1`). On SwiftShader that wall
    time includes GPU waits, so it over-slows rather than under-slows.
  - A cgroup CPU quota on the worker thread was tried and rejected. A 25%
    quota slowed a duty-cycled test thread 5.7x with a 20 ms period and 16x
    with a 4 ms period, not 4x.
- **A ghost is infinitely fast.** It runs ahead of the real core by up to the
  window. That is the "slow console trails" case in its purest form, the case
  where cause 1 is largest. The two-tab rooms (two real cores) show the same
  switch, at 11-12 frames rather than 13-17.
- **Load.** Other agents' unlocked runs held this box at load 23-60 for long
  stretches. One attempt at the cpu4 cells ran at load 37 and was discarded.
  Every run kept here started below load 17 and stayed below 20.

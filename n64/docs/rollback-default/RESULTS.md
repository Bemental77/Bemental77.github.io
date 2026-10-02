# N64 rollback as the default: measured 2026-10-01, fixed and re-measured 2026-10-02

## Verdict (2026-10-02): `RB_DEFAULT = true`

The four causes found on 2026-10-01 (the [earlier measurement](#measured-2026-10-01-rb_default-stayed-false),
kept below) are fixed. Re-measured in interleaved matched pairs, gated
rollback (G) against delay lockstep (L), both arms with the product's pre-Ready
RTT setup:

| Criterion | Result |
|---|---|
| G ≥ L in rate | **Holds by the cell mean and median; single pairs move ±2%.** Mean G/L: 1.003 (cpu1), 1.003 (cpu4 + mobile), 0.997 (worker core slowed 4x, an extra cell). Pair ratios: 0.984-1.020, 0.997-1.014, 0.981-1.022. L's own run-to-run spread in those cells is 0.8986-0.9105, 0.8329-0.8636 and 0.5603-0.5819. |
| Local lag ≤ L in every cell | **Holds.** Mean lag over the 30 s window, G vs L: 3.57 vs 5.17 (cpu1), 4.10 vs 5.12 (cpu4 + mobile), 4.89 vs 4.93 (slowed core). In the two required cells G had less lag than L in all 10 pairs. In the slowed-core cell, two of five pairs read +0.06 and +0.03 frames. |
| 0 desyncs | **Holds.** 550 of 550 confirmed states were bit-exact (full 16.8 MB hash) against a straight run fed the room's own inputs. Every engine ended `running`/`stalled`, never `desync`. |
| Two-tab default room, 0 desyncs | **Holds.** Two 60 s rooms: no desync, 30-32 fingerprints compared per console. |

What a player gets now:

- On a device that can afford rollback, the room runs with zero input lag.
- On one that cannot, the room switches to delay lockstep. It uses the same
  delay a lockstep room picks from the RTT, and it gives that delay back the
  same way. Measured: the switch went to the RTT-chosen 5-6 frames in every
  gated room. The 2026-10-01 rooms went to 9-17.
- When the device can afford rollback again, the room returns to it.

Every desktop on this box could hold rollback only for the first 6-17 s of a
room. The rooms that switched still had less lag over the window than
lockstep did.

## The fixes (all four causes)

| Cause (2026-10-01) | Fix | Where |
|---|---|---|
| 1. `_capDelay` sized the switch from trailing-inflated input lateness | The switch uses `Lockstep.rttDelay`, the delay a lockstep room on this link starts at. `Session.rttReport` sets it, and so does the page. Without an RTT the old sizing remains as a fallback; a wire-only fallback failed two `netplay_rb_capacity_test` cells. A room that starts in delay also uses `rttDelay` exactly. After a switch, the give-back calm runs from the room's start or its last stall, not from the switch. | `lib/netplay.js` `_capDelay`, `_checkBarrier`, `_applyMode`, `rttReport` |
| 2. The decision rode the start-up transient | `CAP_WARM_MS` = 5 s from the start, and from every return to rollback. During it a console records no depths, steps per frame or corrections. The host judges only the step itself, at `CAP_RS_START`: a step that is unaffordable on its own is not a transient, so it still switches. Holding that too failed `switch-both-ways-4p` and `window-cap` (the room trailed to delay 30). The memory switch is not held. | `lib/netplay.js` `_capDecide`, `_capSelfMeasure`, the depth ring, `_rbResumeAt` |
| (c) N64 never declared `rbResume` | The page declares `rbResume: true`. `room_core.js` `rbRearm` saves the start of the first rollback frame after a delay stretch: the live machine is that state, and the engine names no correction across it. On the first delay frame the ring is released (`rbRelease`): 16.8 MB per state plus their framebuffer pins. | `n64/index.html` `startLockstep`; `room_core.js` `rbRunFrame`, `lsFeed` |
| 3. No step or RTT before Ready | A rollback host pings like a lockstep host: the `!ls.rollback` condition is gone, and `rttDelay` reaches the worker engine (`WK_ENG_SETTINGS`). `lsRbProve` times a second save and publishes `selfStepMs` from it before Ready. No frame can run before Ready (the pre-roll is at room start), so the frame's own run is not in it: the published value is a floor, never more than the console will measure. In a delay stretch the page keeps publishing the step it would cost now (`rbStepEstimate`, from the live frame cost), so the host can decide a return. | `n64/index.html` `chooseDelayThenReady`; `room_core.js` `lsRbProve`, `rbStepEstimate` |

**Why the ring release matters for rate.** Before it, the cpu4 + mobile cell
read G/L 0.976, 1.009, 0.986, 0.981, 0.965, and G's governor wrote off more
time in every pair (lostMs 4551-5733 against L's 3041-4327). After it, the
same cell read 0.997-1.014.

## Tests

- **Every node suite: green, on HEAD and on this change.**
  - rb_capacity 26/26, rb_outage 17/17, rb_pace_sim 12, rb_drop 24/24, rollback 27/27.
  - rb_advantage 5/5, rb_msgcost 4/4, lockstep 152, delay_stepdown 24, pace_sim 18.
  - pace_sim_n 6, redundancy 7, lsu 7, invariants 15, pace_verdict 11, rejoin_session 13/13.
- **New: `n64/tools/rb_gate_rtt_test.mjs`, 7/7.**
  - A gated room switches mid-room to exactly the RTT delay (2p and 4p, 50 and 100 ms), never slower than lockstep.
  - A room that starts in delay starts at exactly that delay.
  - Unit checks of `_capDelay` and the warm-up.
- **`n64/tools/rb_sparse_unit_test.mjs`, 14/14.** It was stale since `ec9f66b` moved the rollback block out of the page.
  - It now cuts the block out of `room_core.js`.
  - Two new arms put a delay stretch mid-room, then roll back to its first frame.
  - A mutant with no re-arm fails on "rollback to frame 1300 found no savestate".
- **Genesis browser tests.** genesis_rollback 15/15 and genesis_netplay 26/26.
  - genesis_page_test: 7 failures (ROM requests `ERR_ABORTED`, the portrait rotate prompt).
  - Those same 7 failures occur with HEAD's `lib/netplay.js`, so this change did not cause them.
- **rbResume in the real page:** `n64_rollback_probe.mjs --force-return 6`, worker core, cpu1.
  - The seam makes the host's need read 0.1 once the room is in delay; the real gate is restored after each return.
  - 3 returns, each re-arming the ring (frames 606, 1183, 1404).
  - 100 of 100 confirmed states bit-exact against the straight run.

## Rig

- **Rate rig:** `n64/tools/n64_rollback_probe.mjs`. These additions now ship in it:
  - `--rtt` (default on): before Ready, both arms get the product's RTT setup. Six pings per ghost are drawn from the rig's link model and fed to `recommendDelayForRoom`/`floorDelayForRoom`. `--rttseed` gives both arms of a pair the same draw.
  - The rig attaches its engine with the product's own options, `rbResume` included.
  - `--cin` (exactness against the room's own inputs), `--wslow`, `--expect`, `--force-return`.
  - The per-second mode, delay, presented and capacity readings, plus the ghosts' hold counters and wire volume.
- **Room:** MK64 (PAL, 50 Hz), 2 players, a ghost second player, 40-100 ms one way.
  - 30 s window after a 3 s settle.
  - 5 interleaved L/G rounds per cell; the order alternates by round, and each round shares one RTT seed.
- **Isolation:** each cell ran under `tools/probe_lock.sh`, one cell at a time, on a hermetic snapshot served on :19100 (md5 of the served page checked).
- **Load:** 1.80-4.28 across every run below.
- **Hashes:** before and after every run, `n64/index.html` 93715a3f, `room_core.js` 181a6e96, `core_worker.js` 55597455, `n64wasm.wasm` 63f49e56, `lib/netplay.js` 9d05e8a3.
  - The committed `room_core.js` differs from 181a6e96 only in the `RB_DEFAULT` line and its comments. These runs pass `?rb` explicitly, so that line does not reach them.
  - The committed `index.html` differs only in comments and cache-buster stamps.
- **Arms:**
  - L: `--rbw 0 --query rb=0 --noref`.
  - G: `--rbw 8 --query rb=1 --cin`.
  - Columns as in the earlier tables. `rttDelay/floor` is what the pre-Ready RTT setup chose.

### cpu1, worker room (the default realm)

| run | load start/end | rate | lag avg (frames) | lag at end | secs in rollback | switches | presented share (shown/s) | stalls | exact (cin) | rttDelay/floor | engine |
|---|---|---|---|---|---|---|---|---|---|---|---|
| L r1 | 2.82 / 1.95 | 0.9065 | 5.07 | 5 | 0/30 | – | 0.796 (34.27) | 60 | – | 6/4 | running |
| G r1 | 1.95 / 1.80 | 0.9007 | 4 | 5 | 6/30 | f445 → d6 | 0.786 (31.88) | 43 | 45/45 | 6/4 | running |
| L r2 | 2.27 / 2.70 | 0.9042 | 5 | 5 | 0/30 | – | 0.791 (32.88) | 63 | – | 5/4 | running |
| G r2 | 1.80 / 2.27 | 0.9221 | 2.1 | 5 | 17/30 | f989 → d5 | 0.775 (29.66) | 46 | 99/99 | 5/4 | running |
| L r3 | 2.70 / 2.76 | 0.9105 | 5 | 5 | 0/30 | – | 0.792 (33.63) | 56 | – | 5/4 | running |
| G r3 | 2.76 / 2.50 | 0.8956 | 3.83 | 5 | 6/30 | f462 → d5 | 0.783 (30.63) | 80 | 47/47 | 5/4 | running |
| L r4 | 2.75 / 2.29 | 0.9009 | 5.73 | 6 | 0/30 | – | 0.798 (31.07) | 32 | – | 6/4 | running |
| G r4 | 2.50 / 2.75 | 0.9023 | 3.33 | 5 | 10/30 | f631 → d6 | 0.793 (29.39) | 40 | 64/64 | 6/4 | running |
| L r5 | 2.29 / 3.13 | 0.8986 | 5.07 | 5 | 0/30 | – | 0.775 (33.06) | 65 | – | 6/4 | running |
| G r5 | 3.13 / 2.80 | 0.9151 | 4.6 | 6 | 6/30 | f451 → d6 | 0.789 (29.21) | 17 | 46/46 | 6/4 | running |

G/L rate pairs: 0.994, 1.020, 0.984, 1.002, 1.018; G−L lag: -1.07, -2.90, -1.17, -2.40, -0.47

### cpu4 + mobile, worker room (CDP throttles the page's thread; the core in the worker is not throttled)

| run | load start/end | rate | lag avg (frames) | lag at end | secs in rollback | switches | presented share (shown/s) | stalls | exact (cin) | rttDelay/floor | engine |
|---|---|---|---|---|---|---|---|---|---|---|---|
| L r1 | 2.50 / 3.92 | 0.8636 | 5.8 | 6 | 0/30 | – | 0.795 (27.34) | 33 | – | 6/4 | running |
| G r1 | 3.92 / 3.75 | 0.8611 | 4 | 5 | 6/30 | f432 → d6 | 0.779 (24.85) | 53 | 44/44 | 6/4 | running |
| L r2 | 3.12 / 3.79 | 0.8329 | 5 | 5 | 0/30 | – | 0.776 (25.75) | 56 | – | 5/4 | running |
| G r2 | 3.75 / 3.12 | 0.8445 | 3.83 | 5 | 6/30 | f466 → d5 | 0.777 (24.04) | 77 | 47/47 | 5/4 | running |
| L r3 | 3.79 / 3.92 | 0.8566 | 5 | 5 | 0/30 | – | 0.782 (26.57) | 70 | – | 5/4 | running |
| G r3 | 3.92 / 4.07 | 0.8597 | 3.93 | 5 | 6/30 | f427 → d5 | 0.783 (25.13) | 94 | 43/43 | 5/4 | running |
| L r4 | 3.85 / 3.76 | 0.8556 | 4.73 | 4 | 0/30 | – | 0.769 (27.53) | 97 | – | 6/4 | running |
| G r4 | 4.07 / 3.85 | 0.8532 | 4 | 5 | 6/30 | f430 → d6 | 0.773 (25.17) | 55 | 43/43 | 6/4 | running |
| L r5 | 3.76 / 3.73 | 0.8546 | 5.07 | 5 | 0/30 | – | 0.786 (26.09) | 69 | – | 6/4 | stalled |
| G r5 | 3.73 / 3.62 | 0.8555 | 4.73 | 6 | 6/30 | f415 → d6 | 0.797 (23.81) | 28 | 42/42 | 6/4 | running |

G/L rate pairs: 0.997, 1.014, 1.004, 0.997, 1.001; G−L lag: -1.80, -1.17, -1.07, -0.73, -0.34

### cpu4 + mobile, worker core slowed 4x (`--wslow 4`): the console that cannot afford rollback

| run | load start/end | rate | lag avg (frames) | lag at end | secs in rollback | switches | presented share (shown/s) | stalls | exact (cin) | rttDelay/floor | engine |
|---|---|---|---|---|---|---|---|---|---|---|---|
| L r1 | 2.80 / 3.80 | 0.5819 | 4.93 | 4 | 0/30 | – | 0.788 (21.71) | 12 | – | 6/4 | running |
| G r1 | 3.80 / 4.20 | 0.5708 | 4.8 | 5 | 0/30 | f57 → d6 | 0.781 (22.49) | 19 | 6/6 | 6/4 | running |
| L r2 | 3.64 / 3.38 | 0.5603 | 4.97 | 5 | 0/30 | – | 0.765 (21.36) | 28 | – | 5/4 | running |
| G r2 | 4.20 / 3.64 | 0.5724 | 4.77 | 5 | 0/30 | f56 → d5 | 0.772 (22.28) | 35 | 6/6 | 5/4 | running |
| L r3 | 3.38 / 3.41 | 0.5723 | 4.87 | 5 | 0/30 | – | 0.765 (22.11) | 39 | – | 5/4 | running |
| G r3 | 3.41 / 3.12 | 0.5613 | 4.93 | 5 | 0/30 | f56 → d5 | 0.778 (21.73) | 27 | 6/6 | 5/4 | running |
| L r4 | 2.53 / 2.59 | 0.5746 | 5 | 4 | 0/30 | – | 0.783 (22.03) | 17 | – | 6/4 | running |
| G r4 | 3.12 / 2.53 | 0.5703 | 5 | 5 | 0/30 | f57 → d6 | 0.786 (22.12) | 30 | 6/6 | 6/4 | running |
| L r5 | 2.59 / 2.65 | 0.5622 | 4.9 | 5 | 0/30 | – | 0.777 (20.97) | 32 | – | 6/4 | running |
| G r5 | 2.65 / 2.50 | 0.5672 | 4.93 | 5 | 0/30 | f57 → d6 | 0.777 (21.63) | 35 | 6/6 | 6/4 | running |

G/L rate pairs: 0.981, 1.022, 0.981, 0.993, 1.009; G−L lag: -0.13, -0.20, 0.06, 0.00, 0.03

### Two-tab default room (`party_pace_probe.mjs --arm net --netms 70 --jitter 30 --secs 60`, `RB_DEFAULT = true`, no `?rb`)

Two real consoles over the real transport, both in the worker. Snapshot:
`room_core.js` 66a0c630, `lib/netplay.js` 9d05e8a3. These are single runs,
not pairs: the rate column can only be compared within this box's two-core
SwiftShader ceiling.

| run | load start/end | rate host / joiner | switch | delay each second | lag (frames, 60 s) | zero-lag secs | fingerprints compared (each side) | desync |
|---|---|---|---|---|---|---|---|---|
| default 1 | 1.64 / 3.69 | 0.6253 / 0.6253 | f331 → d6 ("player 1, player 2 need 122%") | 0 ×7, 5 ×7, then 4 | 3.65 | 7/60 | 32 / 32 | none |
| lockstep control (`?rb=0`) | 3.69 / 3.99 | 0.6475 / 0.6478 | – | 7 ×11, then 6 | 6.18 | 0/60 | 34 / 34 | none |
| default 2 | 3.99 / 3.43 | 0.5883 / 0.5916 | f74 → d6 ("player 2 needs 113%") | 0 ×3, 6, 5, 6 | 5.58 | 3/60 | 30 / 28 (of 30 sent) | none |

## Measured 2026-10-01: RB_DEFAULT stayed false

### Verdict then: `RB_DEFAULT` stays `false`

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

Never run as such: superseded by the 2026-10-02 re-measurement at the top of
this file, which measured the fixed code on top of `3664ce4` (itself on
`173ad52`).

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
